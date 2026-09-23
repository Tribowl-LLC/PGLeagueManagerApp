import { createHash } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  bowlerLeagues,
  bowlers,
  leagues,
  paymentAllocations,
  paymentOperations,
  payments,
  paymentOperationRosterSnapshots,
  rotatingCreditPaymentOperationSnapshots,
  users,
  rotatingCreditApplicationReversals,
  rotatingCreditApplications,
  rotatingCreditFundings,
  teamPaymentRotationMembers,
  teamPaymentSlots,
  teams,
} from "@shared/schema";
import {
  isConfirmedNoChargeDecline as classifyNoChargeDecline,
} from "@shared/rotating-credit-contract";
import type {
  RotatingCreditBalanceWire,
  RotatingCreditManualQuoteWire,
  RotatingCreditQuoteWire,
} from "@shared/rotating-credit-contract";
import { db } from "../db.js";
import type { PaymentOperationTransaction } from "../storage/payment-operations.js";
import { readConfirmedRotatingObligationsForCredit } from "./rotating-team-payments.js";
import { readRotatingCreditFundingBalancesInTransaction } from "./rotating-credit-applications.js";
import { buildPaymentOperationIdentity, canonicalizePaymentOperationInput } from "./payment-operation-idempotency.js";
import { lockLeagueSchedule } from "../storage/league-schedule-lock.js";
import { prepareRotatingCreditPaymentOperation, getRotatingCreditOperationTargetKey } from "./rotating-credit-operation-preparation.js";
import { reconstructRotatingCreditOperationSnapshot } from "./rotating-credit-operation-snapshot.js";
import { interactivePaymentOperationExecutor } from "./interactive-payment-operation-executor.js";
import { finalizeRosterSnapshotInTransaction, isRosterSnapshotFinalizationError } from "./roster-payment-finalizer.js";
import { isRotatingCreditFinalizationRecoveryEligible } from "./rotating-credit-recovery-contract.js";
import { getPaymentProvider } from "./payment-provider-factory.js";
import { getProviderCustomerId } from "./payment-utils.js";
import { providerNameToPaymentType, emailSchema } from "@shared/schema/constants";
import {
  RotatingCreditLedgerError,
  applyRotatingCreditToConfirmedObligationsInTransaction,
  previewRotatingCreditApplications,
} from "./rotating-credit-applications.js";
import type { RotatingCreditChargeRequest, RotatingCreditManualFundingRequest, RotatingCreditOperationWire } from "@shared/rotating-credit-contract";

export class RotatingCreditError extends Error {
  constructor(public readonly code: string, public readonly status = 409) {
    super("Unable to process rotating credit request");
    this.name = "RotatingCreditError";
  }
}

export interface RotatingCreditTerms {
  eligible: boolean;
  shareAmountMinor: number | null;
  locationId: number | null;
  paymentMode: "weekly" | "upfront";
}

export async function readRotatingCreditTermsInTransaction(
  tx: PaymentOperationTransaction,
  input: { organizationId: number; leagueId: number; bowlerId: number },
): Promise<RotatingCreditTerms> {
  const [league] = await tx.select({ weeklyFee: leagues.weeklyFee, locationId: leagues.locationId, paymentMode: leagues.paymentMode })
    .from(leagues).where(and(
      eq(leagues.id, input.leagueId),
      eq(leagues.organizationId, input.organizationId),
    )).limit(1);
  if (!league) throw new RotatingCreditError("LEAGUE_NOT_FOUND", 404);
  const [eligible] = await tx.select({ id: teamPaymentRotationMembers.id })
    .from(teamPaymentRotationMembers)
    .innerJoin(teamPaymentSlots, and(
      eq(teamPaymentSlots.organizationId, teamPaymentRotationMembers.organizationId),
      eq(teamPaymentSlots.leagueId, teamPaymentRotationMembers.leagueId),
      eq(teamPaymentSlots.teamId, teamPaymentRotationMembers.teamId),
      eq(teamPaymentSlots.occupant, "rotating"),
    ))
    .innerJoin(teams, and(
      eq(teams.id, teamPaymentSlots.teamId),
      eq(teams.leagueId, teamPaymentSlots.leagueId),
      eq(teams.active, true),
    ))
    .innerJoin(bowlers, and(
      eq(bowlers.id, teamPaymentRotationMembers.bowlerId),
      eq(bowlers.organizationId, teamPaymentRotationMembers.organizationId),
      eq(bowlers.active, true),
    ))
    .innerJoin(bowlerLeagues, and(
      eq(bowlerLeagues.bowlerId, teamPaymentRotationMembers.bowlerId),
      eq(bowlerLeagues.leagueId, teamPaymentRotationMembers.leagueId),
      eq(bowlerLeagues.teamId, teamPaymentRotationMembers.teamId),
      eq(bowlerLeagues.active, true),
    ))
    .where(and(
      eq(teamPaymentRotationMembers.organizationId, input.organizationId),
      eq(teamPaymentRotationMembers.leagueId, input.leagueId),
      eq(teamPaymentRotationMembers.bowlerId, input.bowlerId),
      eq(teamPaymentRotationMembers.active, true),
    )).limit(1);
  let hasConfirmedOutstandingAssignment = false;
  if (!eligible) {
    const [activeBowler] = await tx.select({ id: bowlers.id }).from(bowlers).where(and(
      eq(bowlers.id, input.bowlerId),
      eq(bowlers.organizationId, input.organizationId),
      eq(bowlers.active, true),
    )).limit(1);
    hasConfirmedOutstandingAssignment = Boolean(activeBowler)
      && (await readConfirmedRotatingObligationsForCredit(tx, input)).length > 0;
  }
  const isEligible = (Boolean(eligible) || hasConfirmedOutstandingAssignment)
    && league.paymentMode === "weekly" && league.weeklyFee > 0;
  return {
    eligible: isEligible,
    shareAmountMinor: isEligible ? league.weeklyFee : null,
    locationId: league.locationId,
    paymentMode: league.paymentMode,
  };
}

function quoteFingerprint(input: {
  organizationId: number;
  leagueId: number;
  bowlerId: number;
  shareAmountMinor: number;
  shareCount: number;
  amountMinor: number;
}): string {
  const normalized = { contract: "rotating-credit-quote/1", ...input };
  const digest = createHash("sha256").update(canonicalizePaymentOperationInput(normalized)).digest("hex");
  return `lvrotcrquote:v1:${digest}`;
}

function manualQuoteFingerprint(input: { organizationId: number; leagueId: number; bowlerId: number; amountMinor: number; shareAmountMinor: number }): string {
  const normalized = { contract: "rotating-credit-manual-quote/1", ...input };
  const digest = createHash("sha256").update(canonicalizePaymentOperationInput(normalized)).digest("hex");
  return `lvrotcrquote:v1:${digest}`;
}

function manualFundingRequestFingerprint(input: {
  organizationId: number;
  leagueId: number;
  bowlerId: number;
  amountMinor: number;
  tenderType: "cash" | "check";
  checkNumber?: string;
  quoteFingerprint: string;
  actorUserId: number;
  notes?: string;
}): string {
  return `lvrotcrreq:v1:${createHash("sha256").update(canonicalizePaymentOperationInput({
    contract: "rotating-credit-manual-funding/1",
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    bowlerId: input.bowlerId,
    amountMinor: input.amountMinor,
    tenderType: input.tenderType,
    checkNumber: input.checkNumber ?? null,
    quoteFingerprint: input.quoteFingerprint,
    actorUserId: input.actorUserId,
    notes: input.notes ?? null,
  })).digest("hex")}`;
}

async function findExistingRotatingCreditChargeInTransaction(
  tx: PaymentOperationTransaction,
  input: {
    organizationId: number;
    leagueId: number;
    bowlerId: number;
    actorUserId: number;
    request: RotatingCreditChargeRequest;
  },
): Promise<typeof paymentOperations.$inferSelect | null> {
  const targetKey = getRotatingCreditOperationTargetKey({
    leagueId: input.leagueId,
    bowlerId: input.bowlerId,
    idempotencyKey: input.request.idempotencyKey,
  });
  const [operation] = await tx.select().from(paymentOperations).where(and(
    eq(paymentOperations.organizationId, input.organizationId),
    eq(paymentOperations.leagueId, input.leagueId),
    eq(paymentOperations.operationType, "interactive_charge"),
    eq(paymentOperations.targetKey, targetKey),
  )).limit(1).for("update");
  if (!operation) return null;

  const [stored] = await tx.select().from(rotatingCreditPaymentOperationSnapshots).where(and(
    eq(rotatingCreditPaymentOperationSnapshots.operationId, operation.id),
    eq(rotatingCreditPaymentOperationSnapshots.organizationId, input.organizationId),
    eq(rotatingCreditPaymentOperationSnapshots.leagueId, input.leagueId),
  )).limit(1);
  const [legacyRosterSnapshot] = await tx.select({ operationId: paymentOperationRosterSnapshots.operationId })
    .from(paymentOperationRosterSnapshots).where(and(
      eq(paymentOperationRosterSnapshots.operationId, operation.id),
      eq(paymentOperationRosterSnapshots.organizationId, input.organizationId),
      eq(paymentOperationRosterSnapshots.leagueId, input.leagueId),
      eq(paymentOperationRosterSnapshots.snapshotKind, "interactive"),
    )).limit(1);
  if (!stored || legacyRosterSnapshot) throw new RotatingCreditError("IDEMPOTENCY_CONFLICT", 409);

  let snapshot: ReturnType<typeof reconstructRotatingCreditOperationSnapshot>;
  try {
    snapshot = reconstructRotatingCreditOperationSnapshot({
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      providerName: operation.providerName,
      providerIdempotencyKey: operation.providerIdempotencyKey,
      stored,
    });
  } catch {
    throw new RotatingCreditError("IDEMPOTENCY_CONFLICT", 409);
  }
  const expectedIdentity = buildPaymentOperationIdentity({
    organizationId: input.organizationId,
    operationType: "interactive_charge",
    targetKey,
    amountMinor: snapshot.amountMinor,
    currency: "USD",
    providerName: operation.providerName,
  });
  const immutableMatch = operation.authorizingUserId === input.actorUserId
    && operation.amountMinor === snapshot.amountMinor
    && operation.currency === "USD"
    && operation.requestFingerprint === expectedIdentity.requestFingerprint
    && operation.providerIdempotencyKey === expectedIdentity.providerIdempotencyKey
    && snapshot.bowlerId === input.bowlerId
    && snapshot.shareCount === input.request.shareCount
    && snapshot.sourceKind === input.request.sourceKind
    && snapshot.sourceId === input.request.sourceId
    && snapshot.quoteFingerprint === input.request.quoteFingerprint
    && snapshot.idempotencyKey === input.request.idempotencyKey;
  if (!immutableMatch) throw new RotatingCreditError("IDEMPOTENCY_CONFLICT", 409);
  return operation;
}

async function buildPurchasePreviewInTransaction(
  tx: PaymentOperationTransaction,
  input: { organizationId: number; leagueId: number; bowlerId: number; amountMinor: number },
) {
  const terms = await readRotatingCreditTermsInTransaction(tx, input);
  if (!terms.eligible || terms.shareAmountMinor === null) throw new RotatingCreditError("ROTATING_CREDIT_NOT_ELIGIBLE", 403);
  const lots = await readRotatingCreditFundingBalancesInTransaction(tx, input);
  const currentAvailableMinor = lots.reduce((sum, lot) => sum + lot.availableMinor, 0);
  const candidates = await readConfirmedRotatingObligationsForCredit(tx, input);
  const advisoryApplications = previewRotatingCreditApplications(candidates, currentAvailableMinor + input.amountMinor);
  const expectedAvailableAfterPurchaseMinor = Math.max(0,
    currentAvailableMinor + input.amountMinor - advisoryApplications.reduce((sum, row) => sum + row.amountMinor, 0));
  return { terms, currentAvailableMinor, advisoryApplications, expectedAvailableAfterPurchaseMinor };
}

export async function quoteRotatingCreditPurchase(input: {
  organizationId: number;
  leagueId: number;
  bowlerId: number;
  shareCount: number;
}): Promise<RotatingCreditQuoteWire> {
  return db.transaction(async (tx) => {
    const terms = await readRotatingCreditTermsInTransaction(tx, input);
    if (!terms.eligible || terms.shareAmountMinor === null) throw new RotatingCreditError("ROTATING_CREDIT_NOT_ELIGIBLE", 403);
    const amountMinor = terms.shareAmountMinor * input.shareCount;
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor > 2_147_483_647) throw new RotatingCreditError("ROTATING_CREDIT_AMOUNT_INVALID", 400);
    const preview = await buildPurchasePreviewInTransaction(tx, { ...input, amountMinor });
    return {
      contractVersion: "rotating-credit-quote/1",
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      bowlerId: input.bowlerId,
      currency: "USD",
      shareCount: input.shareCount,
      shareAmountMinor: preview.terms.shareAmountMinor ?? 0,
      amountMinor,
      currentAvailableMinor: preview.currentAvailableMinor,
      expectedAvailableAfterPurchaseMinor: preview.expectedAvailableAfterPurchaseMinor,
      advisoryApplications: preview.advisoryApplications,
      fingerprint: quoteFingerprint({
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        bowlerId: input.bowlerId,
        shareAmountMinor: preview.terms.shareAmountMinor ?? 0,
        shareCount: input.shareCount,
        amountMinor,
      }),
    };
  });
}

export async function quoteRotatingCreditManualFunding(input: {
  organizationId: number;
  leagueId: number;
  bowlerId: number;
  amountMinor: number;
}): Promise<RotatingCreditManualQuoteWire> {
  return db.transaction(async (tx) => {
    const preview = await buildPurchasePreviewInTransaction(tx, input);
    const terms = preview.terms;
    const fingerprint = manualQuoteFingerprint({
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      bowlerId: input.bowlerId,
      amountMinor: input.amountMinor,
      shareAmountMinor: terms.shareAmountMinor ?? 0,
    });
    return {
      contractVersion: "rotating-credit-manual-quote/1",
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      bowlerId: input.bowlerId,
      currency: "USD",
      amountMinor: input.amountMinor,
      currentAvailableMinor: preview.currentAvailableMinor,
      expectedAvailableAfterPurchaseMinor: preview.expectedAvailableAfterPurchaseMinor,
      advisoryApplications: preview.advisoryApplications,
      fingerprint,
    };
  });
}

export async function readRotatingCreditBalance(input: {
  organizationId: number;
  leagueId: number;
  bowlerId: number;
}): Promise<RotatingCreditBalanceWire> {
  return db.transaction(async (tx) => {
    const terms = await readRotatingCreditTermsInTransaction(tx, input);
    const lotBalances = await readRotatingCreditFundingBalancesInTransaction(tx, input);
    const fundingIds = lotBalances.map((lot) => lot.fundingId);
    const fundingRows = fundingIds.length === 0 ? [] : await tx.select({
      funding: rotatingCreditFundings,
      payment: payments,
    }).from(rotatingCreditFundings).innerJoin(payments, and(
      eq(payments.id, rotatingCreditFundings.paymentId),
      eq(payments.organizationId, input.organizationId),
      eq(payments.leagueId, input.leagueId),
    )).where(and(
      eq(rotatingCreditFundings.organizationId, input.organizationId),
      eq(rotatingCreditFundings.leagueId, input.leagueId),
      inArray(rotatingCreditFundings.id, fundingIds),
    )).orderBy(asc(rotatingCreditFundings.createdAt), asc(rotatingCreditFundings.id));
    const applications = fundingIds.length === 0 ? [] : await tx.select({
      application: rotatingCreditApplications,
      allocation: paymentAllocations,
      reversal: rotatingCreditApplicationReversals,
    }).from(rotatingCreditApplications)
      .innerJoin(paymentAllocations, and(
        eq(paymentAllocations.id, rotatingCreditApplications.allocationId),
        eq(paymentAllocations.organizationId, input.organizationId),
        eq(paymentAllocations.leagueId, input.leagueId),
      ))
      .leftJoin(rotatingCreditApplicationReversals, and(
        eq(rotatingCreditApplicationReversals.applicationId, rotatingCreditApplications.id),
        eq(rotatingCreditApplicationReversals.organizationId, input.organizationId),
        eq(rotatingCreditApplicationReversals.leagueId, input.leagueId),
      )).where(and(
        eq(rotatingCreditApplications.organizationId, input.organizationId),
        eq(rotatingCreditApplications.leagueId, input.leagueId),
        eq(rotatingCreditApplications.actualBowlerId, input.bowlerId),
      )).orderBy(asc(rotatingCreditApplications.appliedAt), asc(rotatingCreditApplications.id));
    const balanceByFunding = new Map(lotBalances.map((lot) => [lot.fundingId, lot]));
    const lotWires = fundingRows.map(({ funding, payment }) => {
      const balance = balanceByFunding.get(funding.id);
      if (!balance) throw new RotatingCreditError("CREDIT_BALANCE_EVIDENCE_MISSING");
      return {
        fundingId: funding.id,
        paymentId: funding.paymentId,
        amountMinor: funding.amountMinor,
        availableMinor: balance.availableMinor,
        appliedMinor: balance.appliedMinor,
        refundedMinor: balance.refundedMinor,
        refundHeldMinor: balance.refundHeldMinor,
        reviewHeldMinor: balance.reviewHeldMinor,
        paymentType: payment.type,
        createdAt: funding.createdAt,
        receiptAvailable: Boolean(payment.receiptUrl),
        receiptUrl: payment.receiptUrl,
        receiptNumber: payment.receiptNumber,
        receiptEmailMissing: payment.receiptEmailMissing,
      };
    });
    const applicationWires = applications.map(({ application, allocation, reversal }) => ({
      applicationId: application.id,
      fundingId: application.fundingId,
      paymentId: application.paymentId,
      allocationId: application.allocationId,
      obligationId: application.obligationId,
      assignmentId: application.assignmentId,
      occurrenceId: application.occurrenceId,
      occurrenceLocalDate: application.occurrenceLocalDate,
      teamId: application.teamId,
      slotIndex: application.slotIndex,
      amountMinor: application.amountMinor,
      appliedAt: application.appliedAt,
      status: allocation.state === "active" && reversal === null ? "active" as const : "reversed" as const,
      reversedAt: reversal?.createdAt ?? null,
      reversalReason: reversal?.reason ?? null,
    }));
    const fundedMinor = lotWires.reduce((sum, lot) => sum + lot.amountMinor, 0);
    const availableMinor = lotWires.reduce((sum, lot) => sum + lot.availableMinor, 0);
    const appliedMinor = lotWires.reduce((sum, lot) => sum + lot.appliedMinor, 0);
    const refundedMinor = lotWires.reduce((sum, lot) => sum + lot.refundedMinor, 0);
    const refundHeldMinor = lotWires.reduce((sum, lot) => sum + lot.refundHeldMinor, 0);
    const reviewHeldMinor = lotWires.reduce((sum, lot) => sum + lot.reviewHeldMinor, 0);
    return {
      contractVersion: "rotating-credit-balance/1",
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      bowlerId: input.bowlerId,
      eligibleForCredit: terms.eligible,
      shareAmountMinor: terms.shareAmountMinor,
      currency: "USD",
      fundedMinor,
      availableMinor,
      appliedMinor,
      refundedMinor,
      refundHeldMinor,
      reviewHeldMinor,
      lots: lotWires,
      applications: applicationWires,
    };
  });
}

export async function listRotatingCreditFundedMembersForTeam(input: {
  organizationId: number;
  leagueId: number;
  teamId: number;
}): Promise<Array<{ bowlerId: number; name: string; activeRotationMember: boolean }>> {
  return db.selectDistinct({
    bowlerId: bowlers.id,
    name: bowlers.name,
    activeRotationMember: teamPaymentRotationMembers.active,
  }).from(teamPaymentRotationMembers)
    .innerJoin(bowlers, and(
      eq(bowlers.id, teamPaymentRotationMembers.bowlerId),
      eq(bowlers.organizationId, input.organizationId),
    ))
    .innerJoin(rotatingCreditFundings, and(
      eq(rotatingCreditFundings.organizationId, teamPaymentRotationMembers.organizationId),
      eq(rotatingCreditFundings.leagueId, teamPaymentRotationMembers.leagueId),
      eq(rotatingCreditFundings.bowlerId, teamPaymentRotationMembers.bowlerId),
    ))
    .where(and(
      eq(teamPaymentRotationMembers.organizationId, input.organizationId),
      eq(teamPaymentRotationMembers.leagueId, input.leagueId),
      eq(teamPaymentRotationMembers.teamId, input.teamId),
    ))
    .orderBy(asc(bowlers.name), asc(bowlers.id));
}

async function getCreditApplicationsByIds(input: {
  organizationId: number;
  leagueId: number;
  bowlerId: number;
  applicationIds: string[];
}): Promise<RotatingCreditBalanceWire["applications"]> {
  if (input.applicationIds.length === 0) return [];
  const balance = await readRotatingCreditBalance(input);
  const ids = new Set(input.applicationIds);
  return balance.applications.filter((application) => ids.has(application.applicationId));
}

export async function recordRotatingCreditManualFunding(input: {
  organizationId: number;
  leagueId: number;
  actorUserId: number;
  request: RotatingCreditManualFundingRequest;
}): Promise<RotatingCreditOperationWire> {
  const result = await db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    const [existingFunding] = await tx.select({ funding: rotatingCreditFundings, payment: payments })
      .from(rotatingCreditFundings).innerJoin(payments, and(
        eq(payments.id, rotatingCreditFundings.paymentId),
        eq(payments.organizationId, input.organizationId),
        eq(payments.leagueId, input.leagueId),
      )).where(and(
        eq(rotatingCreditFundings.organizationId, input.organizationId),
        eq(rotatingCreditFundings.leagueId, input.leagueId),
        eq(rotatingCreditFundings.idempotencyKey, input.request.idempotencyKey),
      )).limit(1).for("update");
    const requestFingerprint = manualFundingRequestFingerprint({
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      bowlerId: input.request.bowlerId,
      amountMinor: input.request.amountMinor,
      tenderType: input.request.tenderType,
      checkNumber: input.request.checkNumber,
      quoteFingerprint: input.request.quoteFingerprint,
      actorUserId: input.actorUserId,
      notes: input.request.notes,
    });
    if (existingFunding) {
      if (existingFunding.funding.requestFingerprint !== requestFingerprint
        || existingFunding.funding.idempotencyKey !== input.request.idempotencyKey
        || existingFunding.funding.quoteFingerprint !== input.request.quoteFingerprint
        || existingFunding.funding.actorUserId !== input.actorUserId
        || existingFunding.funding.bowlerId !== input.request.bowlerId
        || existingFunding.funding.amountMinor !== input.request.amountMinor
        || existingFunding.funding.currency !== "USD"
        || existingFunding.funding.fundingKind !== input.request.tenderType
        || existingFunding.funding.paymentId !== existingFunding.payment.id
        || existingFunding.payment.bowlerId !== input.request.bowlerId
        || existingFunding.payment.amount !== input.request.amountMinor
        || existingFunding.payment.currency !== "USD"
        || existingFunding.payment.status !== "paid"
        || existingFunding.payment.type !== input.request.tenderType
        || existingFunding.payment.checkNumber !== (input.request.checkNumber ?? null)
        || existingFunding.payment.providerPaymentId !== null
        || existingFunding.payment.paidByUserId !== input.actorUserId
        || existingFunding.payment.notes !== (input.request.notes?.trim() || "Rotating credit top-up")) {
        throw new RotatingCreditError("IDEMPOTENCY_CONFLICT", 409);
      }
      const applications = await tx.select({ id: rotatingCreditApplications.id }).from(rotatingCreditApplications).where(and(
        eq(rotatingCreditApplications.organizationId, input.organizationId),
        eq(rotatingCreditApplications.leagueId, input.leagueId),
        eq(rotatingCreditApplications.fundingId, existingFunding.funding.id),
      ));
      return { fundingId: existingFunding.funding.id, paymentId: existingFunding.payment.id, applicationIds: applications.map((row) => row.id), replay: true };
    }
    const terms = await readRotatingCreditTermsInTransaction(tx, {
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      bowlerId: input.request.bowlerId,
    });
    if (!terms.eligible || terms.shareAmountMinor === null) throw new RotatingCreditError("ROTATING_CREDIT_NOT_ELIGIBLE", 403);
    const expectedQuote = manualQuoteFingerprint({
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      bowlerId: input.request.bowlerId,
      amountMinor: input.request.amountMinor,
      shareAmountMinor: terms.shareAmountMinor,
    });
    if (expectedQuote !== input.request.quoteFingerprint) throw new RotatingCreditError("STALE_QUOTE", 409);
    const [actor] = await tx.select({ id: users.id }).from(users).where(and(
      eq(users.organizationId, input.organizationId),
      eq(users.id, input.actorUserId),
    )).limit(1);
    const [bowler] = await tx.select({ id: bowlers.id }).from(bowlers).where(and(
      eq(bowlers.organizationId, input.organizationId),
      eq(bowlers.id, input.request.bowlerId),
      eq(bowlers.active, true),
    )).limit(1);
    if (!actor || !bowler) throw new RotatingCreditError("RESOURCE_NOT_FOUND", 404);
    const paymentKey = `rotating-credit-manual:${createHash("sha256").update(`${input.organizationId}:${input.leagueId}:${input.request.idempotencyKey}`).digest("hex")}`;
    const [payment] = await tx.insert(payments).values({
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      bowlerId: input.request.bowlerId,
      amount: input.request.amountMinor,
      currency: "USD",
      status: "paid",
      type: input.request.tenderType,
      checkNumber: input.request.checkNumber ?? null,
      providerPaymentId: null,
      idempotencyKey: paymentKey,
      notes: input.request.notes?.trim() || "Rotating credit top-up",
      paidByUserId: input.actorUserId,
      createdAt: new Date().toISOString(),
    }).returning({ id: payments.id });
    if (!payment) throw new RotatingCreditError("PAYMENT_RECORD_FAILED", 500);
    const [funding] = await tx.insert(rotatingCreditFundings).values({
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      bowlerId: input.request.bowlerId,
      paymentId: payment.id,
      amountMinor: input.request.amountMinor,
      currency: "USD",
      fundingKind: input.request.tenderType,
      idempotencyKey: input.request.idempotencyKey,
      requestFingerprint,
      quoteFingerprint: input.request.quoteFingerprint,
      actorUserId: input.actorUserId,
      createdAt: new Date().toISOString(),
    }).returning({ id: rotatingCreditFundings.id });
    if (!funding) throw new RotatingCreditError("FUNDING_RECORD_FAILED", 500);
    let applicationIds: string[];
    try {
      applicationIds = await applyRotatingCreditToConfirmedObligationsInTransaction(tx, {
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        bowlerId: input.request.bowlerId,
        actorUserId: input.actorUserId,
      });
    } catch (error) {
      if (error instanceof RotatingCreditLedgerError) throw new RotatingCreditError(error.code, 409);
      throw error;
    }
    return { fundingId: funding.id, paymentId: payment.id, applicationIds, replay: false };
  });
  const balance = await readRotatingCreditBalance({ organizationId: input.organizationId, leagueId: input.leagueId, bowlerId: input.request.bowlerId });
  const applications = result.replay
    ? balance.applications.filter((application) => application.fundingId === result.fundingId)
    : await getCreditApplicationsByIds({ organizationId: input.organizationId, leagueId: input.leagueId, bowlerId: input.request.bowlerId, applicationIds: result.applicationIds });
  return {
    contractVersion: "rotating-credit-operation/1",
    operationId: null,
    fundingId: result.fundingId,
    status: "succeeded",
    paymentId: result.paymentId,
    providerPaymentId: null,
    confirmedNoChargeDecline: false,
    fundedMinor: input.request.amountMinor,
    applications,
    balance,
  };
}

export async function chargeRotatingCreditPurchase(input: {
  organizationId: number;
  leagueId: number;
  bowlerId: number;
  actorUserId: number;
  request: RotatingCreditChargeRequest;
}) {
  const prepared = await db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    const existing = await findExistingRotatingCreditChargeInTransaction(tx, input);
    if (existing) return { operation: existing, replay: true };

    const terms = await readRotatingCreditTermsInTransaction(tx, input);
    if (!terms.eligible || terms.shareAmountMinor === null) throw new RotatingCreditError("ROTATING_CREDIT_NOT_ELIGIBLE", 403);
    const amountMinor = terms.shareAmountMinor * input.request.shareCount;
    if (amountMinor > 2_147_483_647 || amountMinor <= 0 || !Number.isSafeInteger(amountMinor)) throw new RotatingCreditError("ROTATING_CREDIT_AMOUNT_INVALID", 400);
    const expectedQuote = quoteFingerprint({
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      bowlerId: input.bowlerId,
      shareAmountMinor: terms.shareAmountMinor,
      shareCount: input.request.shareCount,
      amountMinor,
    });
    if (expectedQuote !== input.request.quoteFingerprint) throw new RotatingCreditError("STALE_QUOTE", 409);
    const [bowler] = await tx.select().from(bowlers).where(and(
      eq(bowlers.organizationId, input.organizationId),
      eq(bowlers.id, input.bowlerId),
      eq(bowlers.active, true),
    )).limit(1);
    if (!bowler) throw new RotatingCreditError("BOWLER_NOT_FOUND", 404);
    const provider = await getPaymentProvider(terms.locationId);
    const customerId = getProviderCustomerId(bowler, provider) ?? null;
    const buyerEmailCandidate = bowler.email?.trim() || input.request.buyerEmail?.trim() || null;
    let buyerEmail: string | null = buyerEmailCandidate;
    if (provider.providerName === "square") {
      const parsedEmail = emailSchema.max(255).safeParse(buyerEmailCandidate);
      if (!parsedEmail.success) throw new RotatingCreditError("BUYER_EMAIL_REQUIRED", 422);
      buyerEmail = parsedEmail.data;
    } else if (buyerEmailCandidate !== null) {
      const parsedEmail = emailSchema.max(255).safeParse(buyerEmailCandidate);
      buyerEmail = parsedEmail.success ? parsedEmail.data : null;
    }
    const operation = await prepareRotatingCreditPaymentOperation({
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      bowlerId: input.bowlerId,
      amountMinor,
      currency: "USD",
      shareCount: input.request.shareCount,
      providerName: provider.providerName,
      locationId: terms.locationId,
      providerLocationId: null,
      sourceKind: input.request.sourceKind,
      sourceId: input.request.sourceId,
      customerId,
      buyerEmail,
      quoteFingerprint: input.request.quoteFingerprint,
      idempotencyKey: input.request.idempotencyKey,
      authorizingUserId: input.actorUserId,
      transaction: tx,
    });
    return { operation, replay: false };
  });
  if (prepared.replay) {
    return recoverRotatingCreditChargeOperation({
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      bowlerId: input.bowlerId,
      operationId: prepared.operation.id,
    });
  }
  const completed = await interactivePaymentOperationExecutor.execute({ organizationId: input.organizationId, operationId: prepared.operation.id });
  if (!completed) throw new RotatingCreditError("OPERATION_NOT_FOUND", 404);
  return buildRotatingCreditOperationWire({ organizationId: input.organizationId, leagueId: input.leagueId, bowlerId: input.bowlerId, operation: completed });
}

export async function buildRotatingCreditOperationWire(input: {
  organizationId: number;
  leagueId: number;
  bowlerId: number;
  operation: {
    id: string;
    status: RotatingCreditOperationWire["status"];
    providerObjectId: string | null;
    errorClassification: string | null;
  };
}): Promise<RotatingCreditOperationWire> {
  const [payment] = await db.select().from(payments).where(and(
    eq(payments.organizationId, input.organizationId),
    eq(payments.leagueId, input.leagueId),
    eq(payments.paymentOperationId, input.operation.id),
  )).limit(1);
  const [funding] = payment ? await db.select().from(rotatingCreditFundings).where(and(
    eq(rotatingCreditFundings.organizationId, input.organizationId),
    eq(rotatingCreditFundings.leagueId, input.leagueId),
    eq(rotatingCreditFundings.paymentId, payment.id),
    eq(rotatingCreditFundings.bowlerId, input.bowlerId),
  )).limit(1) : [];
  const balance = input.operation.status === "succeeded" || input.operation.status === "reconciliation_required"
    ? await readRotatingCreditBalance({ organizationId: input.organizationId, leagueId: input.leagueId, bowlerId: input.bowlerId })
    : null;
  const applications = funding && balance
    ? balance.applications.filter((application) => application.fundingId === funding.id)
    : [];
  return {
    contractVersion: "rotating-credit-operation/1",
    operationId: input.operation.id,
    fundingId: funding?.id ?? null,
    status: input.operation.status,
    paymentId: payment?.id ?? null,
    providerPaymentId: input.operation.providerObjectId,
    confirmedNoChargeDecline: classifyNoChargeDecline({
      status: input.operation.status,
      errorClassification: input.operation.errorClassification,
      providerObjectId: input.operation.providerObjectId,
      paymentId: payment?.id ?? null,
    }),
    fundedMinor: funding?.amountMinor ?? 0,
    applications,
    balance,
  };
}

/** Recover only immutable credit purchase operations owned by this bowler.
 * Provider-unknown states reuse the same encrypted source and provider key;
 * successful provider evidence reruns the ledger finalizer idempotently. */
export async function recoverRotatingCreditChargeOperation(input: {
  organizationId: number;
  leagueId: number;
  bowlerId: number;
  operationId: string;
}) {
  const [operation] = await db.select().from(paymentOperations).where(and(
    eq(paymentOperations.organizationId, input.organizationId),
    eq(paymentOperations.leagueId, input.leagueId),
    eq(paymentOperations.id, input.operationId),
    eq(paymentOperations.operationType, "interactive_charge"),
  )).limit(1);
  const [snapshot] = await db.select({ bowlerId: paymentOperationRosterSnapshots.payerBowlerId })
    .from(paymentOperationRosterSnapshots).where(and(
      eq(paymentOperationRosterSnapshots.operationId, input.operationId),
      eq(paymentOperationRosterSnapshots.organizationId, input.organizationId),
      eq(paymentOperationRosterSnapshots.leagueId, input.leagueId),
    )).limit(1);
  const [creditSnapshot] = await db.select({ bowlerId: rotatingCreditPaymentOperationSnapshots.bowlerId })
    .from(rotatingCreditPaymentOperationSnapshots).where(and(
      eq(rotatingCreditPaymentOperationSnapshots.operationId, input.operationId),
      eq(rotatingCreditPaymentOperationSnapshots.organizationId, input.organizationId),
      eq(rotatingCreditPaymentOperationSnapshots.leagueId, input.leagueId),
    )).limit(1);
  if (!operation || !creditSnapshot || snapshot || creditSnapshot.bowlerId !== input.bowlerId) {
    throw new RotatingCreditError("CREDIT_OPERATION_NOT_FOUND", 404);
  }

  let recovered = operation;
  const recoverableErrorCode = operation.errorCode;
  if (isRotatingCreditFinalizationRecoveryEligible(operation) && recoverableErrorCode !== null) {
    recovered = await db.transaction(async (tx) => {
      await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
      try {
        const finalization = await tx.transaction(async (finalizerTx) => finalizeRosterSnapshotInTransaction(finalizerTx, {
          organizationId: input.organizationId,
          leagueId: input.leagueId,
          operationId: operation.id,
          now: new Date().toISOString(),
          actorUserId: operation.authorizingUserId,
        }));
        if (!finalization.finalized) throw new RotatingCreditError("CREDIT_FINALIZATION_NOT_CONFIRMED");
      } catch (error) {
        if (isRosterSnapshotFinalizationError(error)) return operation;
        throw error;
      }
      const now = new Date().toISOString();
      const [settled] = await tx.update(paymentOperations).set({
        status: "succeeded",
        nextAttemptAt: null,
        errorClassification: null,
        errorCode: null,
        completedAt: now,
        updatedAt: now,
      }).where(and(
        eq(paymentOperations.organizationId, input.organizationId),
        eq(paymentOperations.id, input.operationId),
        eq(paymentOperations.status, "reconciliation_required"),
        eq(paymentOperations.errorClassification, "internal"),
        eq(paymentOperations.errorCode, recoverableErrorCode),
      )).returning();
      return settled ?? operation;
    });
  } else if (["pending", "provider_unknown", "retry_scheduled", "leased"].includes(operation.status)) {
    recovered = await interactivePaymentOperationExecutor.execute({
      organizationId: input.organizationId,
      operationId: operation.id,
    }) ?? operation;
  }
  return buildRotatingCreditOperationWire({
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    bowlerId: input.bowlerId,
    operation: recovered,
  });
}

export async function recoverRotatingCreditChargeByRequestKey(input: {
  organizationId: number;
  leagueId: number;
  bowlerId: number;
  actorUserId: number;
  idempotencyKey: string;
}) {
  const targetKey = getRotatingCreditOperationTargetKey({
    leagueId: input.leagueId,
    bowlerId: input.bowlerId,
    idempotencyKey: input.idempotencyKey,
  });
  const [operation] = await db.select({ id: paymentOperations.id }).from(paymentOperations).where(and(
    eq(paymentOperations.organizationId, input.organizationId),
    eq(paymentOperations.leagueId, input.leagueId),
    eq(paymentOperations.operationType, "interactive_charge"),
    eq(paymentOperations.targetKey, targetKey),
    eq(paymentOperations.authorizingUserId, input.actorUserId),
  )).limit(1);
  if (!operation) throw new RotatingCreditError("CREDIT_OPERATION_NOT_FOUND", 404);
  return recoverRotatingCreditChargeOperation({ ...input, operationId: operation.id });
}
