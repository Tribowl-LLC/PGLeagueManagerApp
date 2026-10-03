import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, lt, ne, or, sql } from "drizzle-orm";
import {
  autopayConsentPartners,
  autopayConsents,
  accountPaymentOperationSnapshots,
  bowlerLeagues,
  bowlerPaymentLinks,
  bowlers,
  canonicalCollectionGroupMembers,
  canonicalCollectionGroups,
  financialCommands,
  leagueOccurrences,
  leagues,
  occurrencePaymentResponsibilities,
  paymentAllocations,
  payments,
  refundAllocationAdjustments,
  paymentObligations,
  paymentOperationRosterSnapshotItems,
  paymentOperationRosterSnapshots,
  paymentOperationStandingAutopayBindings,
  paymentOperationStandingAutopayParticipants,
  rotatingCreditPaymentOperationSnapshots,
  paymentOperations,
  weeklyPaymentWeekConfirmations,
  weeklyPaymentFundings,
  refundPaymentOperationSnapshots,
  teamPaymentRotationMembers,
  teamPaymentSlots,
  teams,
  users,
  type PaymentOperation,
} from "@shared/schema";
import type {
  StandingAutopayConsentRequest,
  StandingAutopayQuoteWire,
  StandingAutopayRevokeRequest,
} from "@shared/standing-autopay-contract";
import { buildPaymentOperationIdentity, canonicalizePaymentOperationInput } from "./payment-operation-idempotency.js";
import { db } from "../db.js";
import { encrypt, decrypt } from "../utils/crypto.js";
import { getPaymentProvider } from "./payment-provider-factory.js";
import { rosterStandingAutopayEnabled, scheduledPaymentExecutionMode } from "../config.js";
import { lockLeagueSchedule } from "../storage/league-schedule-lock.js";
import type { PaymentOperationTransaction } from "../storage/payment-operations.js";
import { validateRosterSnapshotForDispatchInTransaction } from "./roster-payment-finalizer.js";
import { canonicalObligationBalance } from "./refund-allocation-adjustments.js";
import { isCurrentBowlerOwnedObligationSql } from "./roster-obligation-owners.js";
import { resolvePaymentObligationOwnersInTransaction } from "./roster-obligation-owners.js";
import { reconstructInteractivePartnerSnapshot, type InteractivePartnerPaymentSnapshot } from "./interactive-partner-payment-snapshot.js";
import { reconstructAccountPaymentOperationSnapshot } from "./account-payment-operation-snapshot.js";
import { readOwnedLedgerAdoptionInTransaction, applyOwnedFundingFifoInTransaction, isOccurrenceConfirmedInOwnedLedger } from "./owned-payment-ledger.js";
import { readOwnedAccountFundingTargetEvidenceInTransaction } from "./account-payment-funding.js";
import {
  buildAccountStandingFundingSnapshot,
  reconstructAccountStandingFundingSnapshot,
  storeAccountStandingFundingSnapshot,
} from "./account-standing-funding-snapshot.js";
import { providerNameToPaymentType } from "@shared/schema/constants";
import { fifoCandidatesInTransaction } from "./roster-payment-core.js";
import { hasUnresolvedAccountFundingOverlapInTransaction } from "./account-payment-operation-guards.js";

const CONSENT_FP_PREFIX = "lvstandingconsent:v1:";
const PARTNER_FP_PREFIX = "lvpartnerlink:v1:";
const CUTOFF_FP_PREFIX = "lvstandingcutoff:v1:";
const COMMAND_CONSENT = "standing_autopay_consent";
const COMMAND_REVOKE = "standing_autopay_revoke";
const COMMAND_CUTOFF = "standing_autopay_cutoff";
let rearmStandingAutopayWake: () => Promise<void> = async () => undefined;

export function configureStandingAutopayRuntime(input: { rearm: () => Promise<void> }): void {
  rearmStandingAutopayWake = input.rearm;
}

export async function notifyStandingAutopayMutation(): Promise<void> {
  await rearmStandingAutopayWake();
}

export class StandingAutopayError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 409) {
    super(message);
    this.name = "StandingAutopayError";
  }
}

export class StandingAutopayReplay extends StandingAutopayError {
  constructor(public readonly result: unknown) {
    super("IDEMPOTENCY_REPLAY", "The standing automatic-payment command was already applied", 200);
  }
}

type StandingTx = PaymentOperationTransaction;

function currentBowlerOwnerPredicate(input: { organizationId: number; leagueId: number; payerBowlerIds: number[] }) {
  if (input.payerBowlerIds.length === 0) return sql`false`;
  return or(...input.payerBowlerIds.map((bowlerId) => and(
    eq(paymentObligations.payerBowlerId, bowlerId),
    isCurrentBowlerOwnedObligationSql({
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      obligationId: paymentObligations.id,
      payerBowlerId: paymentObligations.payerBowlerId,
      bowlerId,
    }),
  ))) ?? sql`false`;
}

async function assertNotActiveRotatingPoolMemberForStandingAutopay(
  tx: StandingTx,
  input: { organizationId: number; leagueId: number; bowlerId: number },
): Promise<void> {
  const [rotatingMembership] = await tx.select({ id: teamPaymentRotationMembers.id }).from(teamPaymentRotationMembers)
    .innerJoin(teamPaymentSlots, and(
      eq(teamPaymentSlots.organizationId, teamPaymentRotationMembers.organizationId),
      eq(teamPaymentSlots.leagueId, teamPaymentRotationMembers.leagueId),
      eq(teamPaymentSlots.teamId, teamPaymentRotationMembers.teamId),
      eq(teamPaymentSlots.occupant, "rotating"),
    ))
    .innerJoin(teams, and(eq(teams.id, teamPaymentRotationMembers.teamId), eq(teams.leagueId, input.leagueId), eq(teams.active, true)))
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
  if (rotatingMembership) throw new StandingAutopayError("ROTATING_MEMBER_MANUAL_ONLY", "A bowler in an active rotating team pool must pay manually", 409);
}

function digest(prefix: string, value: unknown): string {
  return `${prefix}${createHash("sha256").update(canonicalizePaymentOperationInput(value)).digest("hex")}`;
}

function consentCommandFingerprint(input: {
  leagueId: number;
  payerBowlerId: number;
  sourceId: string;
  customerId: string;
  providerName: string;
  providerLocationId: string;
  partnerIds: number[];
  paymentOperationId?: string;
}): string {
  return digest("lvstandingcommand:v1:", {
    leagueId: input.leagueId,
    payerBowlerId: input.payerBowlerId,
    sourceId: input.sourceId,
    customerId: input.customerId,
    providerName: input.providerName,
    providerLocationId: input.providerLocationId,
    partnerIds: input.partnerIds,
    ...(input.paymentOperationId ? { paymentOperationId: input.paymentOperationId } : {}),
  });
}

function validateOrReplayConsentCommand(
  existing: typeof financialCommands.$inferSelect | undefined,
  input: { actorUserId: number; fingerprint: string },
): void {
  if (!existing) return;
  if (existing.actorUserId !== input.actorUserId || existing.requestFingerprint !== input.fingerprint) {
    throw new StandingAutopayError("IDEMPOTENCY_CONFLICT", "The standing command identity does not match the original request");
  }
  if (existing.state === "applied" && existing.result !== null) throw new StandingAutopayReplay(existing.result);
  if (existing.state === "failed") throw new StandingAutopayError(existing.errorCode ?? "COMMAND_FAILED", "The standing command previously failed");
}

function iso(value: string | Date): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new StandingAutopayError("INVALID_TIMESTAMP", "The standing cutoff timestamp is invalid", 422);
  return parsed.toISOString();
}

function sameInstant(left: string, right: string): boolean {
  const leftTime = new Date(left).getTime();
  const rightTime = new Date(right).getTime();
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime === rightTime;
}

async function providerLocationIdentity(provider: Awaited<ReturnType<typeof getPaymentProvider>>): Promise<string> {
  const resolve = provider.getProviderLocationId;
  if (typeof resolve !== "function") throw new StandingAutopayError("PAYMENT_PROVIDER_IDENTITY_UNAVAILABLE", "The payment provider location identity is unavailable", 422);
  const value = (await resolve.call(provider)).trim();
  if (!value) throw new StandingAutopayError("PAYMENT_PROVIDER_IDENTITY_UNAVAILABLE", "The payment provider location identity is unavailable", 422);
  return value;
}

async function beginCommand(
  tx: StandingTx,
  input: { organizationId: number; leagueId: number; actorUserId: number; commandType: string; key: string; fingerprint: string },
): Promise<void> {
  const [existing] = await tx.select().from(financialCommands).where(and(
    eq(financialCommands.organizationId, input.organizationId),
    eq(financialCommands.leagueId, input.leagueId),
    eq(financialCommands.commandType, input.commandType),
    eq(financialCommands.idempotencyKey, input.key),
  )).limit(1).for("update");
  if (existing) {
    if (existing.actorUserId !== input.actorUserId || existing.requestFingerprint !== input.fingerprint) {
      throw new StandingAutopayError("IDEMPOTENCY_CONFLICT", "The standing command identity does not match the original request");
    }
    if (existing.state === "applied" && existing.result !== null) throw new StandingAutopayReplay(existing.result);
    if (existing.state === "failed") throw new StandingAutopayError(existing.errorCode ?? "COMMAND_FAILED", "The standing command previously failed");
    return;
  }
  await tx.insert(financialCommands).values({
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    actorUserId: input.actorUserId,
    commandType: input.commandType,
    idempotencyKey: input.key,
    requestFingerprint: input.fingerprint,
    state: "accepted",
  });
}

async function applyCommand(
  tx: StandingTx,
  input: { organizationId: number; leagueId: number; commandType: string; key: string; result: unknown },
): Promise<void> {
  await tx.update(financialCommands).set({ state: "applied", result: input.result }).where(and(
    eq(financialCommands.organizationId, input.organizationId),
    eq(financialCommands.leagueId, input.leagueId),
    eq(financialCommands.commandType, input.commandType),
    eq(financialCommands.idempotencyKey, input.key),
  ));
}

function commandResultRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Applied cutoff decisions are checked before rebuilding any mutable quote.
 * This is particularly important for a durable credit-covered no-op: later
 * consumption of that credit must not turn the same cutoff into a new card
 * charge. */
async function readAppliedStandingCutoffReplayInTransaction(
  tx: StandingTx,
  input: { organizationId: number; leagueId: number; actorUserId: number; commandKey: string },
): Promise<{ found: boolean; operation?: PaymentOperation }> {
  const [existing] = await tx.select().from(financialCommands).where(and(
    eq(financialCommands.organizationId, input.organizationId),
    eq(financialCommands.leagueId, input.leagueId),
    eq(financialCommands.commandType, COMMAND_CUTOFF),
    eq(financialCommands.idempotencyKey, input.commandKey),
  )).limit(1).for("update");
  if (!existing) return { found: false };
  if (existing.actorUserId !== input.actorUserId) throw new StandingAutopayError("IDEMPOTENCY_CONFLICT", "The standing cutoff belongs to another payer account");
  if (existing.state === "failed") throw new StandingAutopayError(existing.errorCode ?? "COMMAND_FAILED", "The standing cutoff previously failed");
  if (existing.state !== "applied" || existing.result === null) return { found: false };
  const result = commandResultRecord(existing.result);
  if (!result) throw new StandingAutopayError("CUTOFF_RESULT_INVALID", "The standing cutoff result is unavailable", 503);
  if (typeof result.operationId === "string") {
    const [operation] = await tx.select().from(paymentOperations).where(and(
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.leagueId, input.leagueId),
      eq(paymentOperations.id, result.operationId),
      eq(paymentOperations.operationType, "standing_autopay_charge"),
    )).limit(1).for("share");
    if (!operation) throw new StandingAutopayError("CUTOFF_OPERATION_MISSING", "The standing cutoff operation is unavailable", 503);
    return { found: true, operation };
  }
  if (["credit_covered", "no_current_collection", "arrears_require_one_time_fifo", "blocked", "no_op"].includes(String(result.kind))) {
    return { found: true };
  }
  throw new StandingAutopayError("CUTOFF_RESULT_INVALID", "The standing cutoff result is unavailable", 503);
}

async function retainedStandingRequirementOccurrenceIdsInTransaction(
  tx: StandingTx,
  input: { organizationId: number; leagueId: number; consentId: string; consentVersion: number; cutoffAt: string },
  adoption: Awaited<ReturnType<typeof readOwnedLedgerAdoptionInTransaction>>,
  currentOccurrenceIds: readonly string[],
): Promise<string[]> {
  const commands = await tx.select({ result: financialCommands.result }).from(financialCommands).where(and(
    eq(financialCommands.organizationId, input.organizationId),
    eq(financialCommands.leagueId, input.leagueId),
    eq(financialCommands.commandType, COMMAND_CUTOFF),
    eq(financialCommands.state, "applied"),
  ));
  const priorIds = new Set<string>();
  for (const row of commands) {
    const result = commandResultRecord(row.result);
    if (!result || result.consentId !== input.consentId || result.consentVersion !== input.consentVersion
      || typeof result.cutoffAt !== "string" || new Date(result.cutoffAt).getTime() >= new Date(input.cutoffAt).getTime()) continue;
    const group = commandResultRecord(result.groupIdentity);
    // Only the unpaid paired-final requirement rolls into a later trigger.
    // A past ordinary weekly occurrence is never treated as a catch-up target.
    if (typeof group?.pairedOccurrenceId === "string") priorIds.add(group.pairedOccurrenceId);
  }
  const currentIds = new Set(currentOccurrenceIds);
  const allIds = [...new Set([...currentIds, ...priorIds])];
  if (allIds.length === 0) return [];
  const [occurrences, confirmations] = await Promise.all([
    tx.select({ id: leagueOccurrences.id, localDate: leagueOccurrences.authoritativeLocalDate }).from(leagueOccurrences).where(and(
      eq(leagueOccurrences.organizationId, input.organizationId),
      eq(leagueOccurrences.leagueId, input.leagueId),
      inArray(leagueOccurrences.id, allIds),
    )),
    tx.select({ occurrenceId: weeklyPaymentWeekConfirmations.occurrenceId }).from(weeklyPaymentWeekConfirmations).where(and(
      eq(weeklyPaymentWeekConfirmations.organizationId, input.organizationId),
      eq(weeklyPaymentWeekConfirmations.leagueId, input.leagueId),
      inArray(weeklyPaymentWeekConfirmations.occurrenceId, allIds),
    )),
  ]);
  const occurrenceById = new Map(occurrences.map((row) => [row.id, row.localDate]));
  const explicit = new Set(confirmations.map((row) => row.occurrenceId));
  return allIds.filter((occurrenceId) => currentIds.has(occurrenceId)
    || !isOccurrenceConfirmedInOwnedLedger(adoption, occurrenceById.get(occurrenceId) ?? "", explicit.has(occurrenceId)));
}

async function prepareAccountStandingAutopayCutoffInTransaction(
  tx: StandingTx,
  input: {
    organizationId: number;
    leagueId: number;
    consent: typeof autopayConsents.$inferSelect;
    cutoffAt: string;
    now: string;
    adoption: NonNullable<Awaited<ReturnType<typeof readOwnedLedgerAdoptionInTransaction>>>;
    payerUserId: number;
  },
): Promise<PaymentOperation | undefined> {
  const { organizationId, leagueId, consent, cutoffAt, now, adoption, payerUserId } = input;
  const commandKey = `account:${consent.id}:${consent.consentVersion}:${cutoffAt}`;
  const replay = await readAppliedStandingCutoffReplayInTransaction(tx, {
    organizationId,
    leagueId,
    actorUserId: payerUserId,
    commandKey,
  });
  if (replay.found) return replay.operation;

  const partners = await consentPartners(tx, {
    organizationId,
    leagueId,
    consentId: consent.id,
    consentVersion: consent.consentVersion,
    payerBowlerId: consent.payerBowlerId,
  });
  const recipientIds = [consent.payerBowlerId, ...partners.map((row) => row.partnerBowlerId)];
  if (new Set(recipientIds).size !== recipientIds.length) throw new StandingAutopayError("PARTICIPANT_EVIDENCE_INVALID", "Standing recipient accounts must be unique");
  if (!(await activeMembership(tx, organizationId, leagueId, recipientIds))) {
    throw new StandingAutopayError("BOWLER_NOT_IN_LEAGUE", "A standing payer is no longer active in the league", 409);
  }

  const group = await groupForCutoff(tx, { organizationId, leagueId, cutoffAt });
  const currentOccurrenceIds = group.occurrenceIds;
  const collectionRequirementOccurrenceIds = await retainedStandingRequirementOccurrenceIdsInTransaction(
    tx,
    { organizationId, leagueId, consentId: consent.id, consentVersion: consent.consentVersion, cutoffAt },
    adoption,
    currentOccurrenceIds,
  );
  const groupIdentity = {
    groupId: group.groupId,
    groupRevision: group.groupRevision,
    groupFingerprint: group.groupFingerprint,
    triggerOccurrenceId: group.triggerOccurrenceId,
    triggerOccurrenceRevision: group.triggerOccurrenceRevision,
    pairedOccurrenceId: group.pairedOccurrenceId,
    triggerMemberId: group.triggerMemberId,
    pairedMemberId: group.pairedMemberId,
    occurrenceIds: group.occurrenceIds,
  };
  const fingerprintBase = {
    consentId: consent.id,
    consentVersion: consent.consentVersion,
    consentFingerprint: consent.consentFingerprint,
    cutoffAt,
    collectionMode: group.mode,
    groupIdentity,
    collectionRequirementOccurrenceIds,
    recipientLinks: partners.map((row) => ({
      partnerBowlerId: row.partnerBowlerId,
      paymentLinkId: row.paymentLinkId,
      linkFingerprint: row.linkFingerprint,
    })),
  };

  if (group.suppressed) {
    const fp = digest(CUTOFF_FP_PREFIX, { ...fingerprintBase, blocked: "paired_occurrence_requires_trigger" });
    await beginCommand(tx, { organizationId, leagueId, actorUserId: payerUserId, commandType: COMMAND_CUTOFF, key: commandKey, fingerprint: fp });
    await applyCommand(tx, {
      organizationId,
      leagueId,
      commandType: COMMAND_CUTOFF,
      key: commandKey,
      result: {
        kind: "blocked",
        reason: "paired_occurrence_requires_trigger",
        cutoffAt,
        consentId: consent.id,
        consentVersion: consent.consentVersion,
        collectionRequirementOccurrenceIds,
        pairedOccurrenceId: group.triggerOccurrenceId,
      },
    });
    return undefined;
  }

  const holds = await pendingRefundPayerWeekKeys(tx, {
    organizationId,
    leagueId,
    payerBowlerIds: recipientIds,
    occurrenceIds: collectionRequirementOccurrenceIds,
  });
  if (holds.size > 0) return undefined;

  for (const bowlerId of recipientIds) {
    await applyOwnedFundingFifoInTransaction(tx, {
      organizationId,
      leagueId,
      bowlerId,
      actorUserId: payerUserId,
      now,
    });
  }

  const targetEvidenceByRecipient = await readOwnedAccountFundingTargetEvidenceInTransaction(tx, {
    organizationId,
    leagueId,
    recipientIds,
    asOf: cutoffAt,
    collectionRequirementOccurrenceIdsByRecipient: new Map(recipientIds.map((bowlerId) => [bowlerId, collectionRequirementOccurrenceIds])),
  });
  const recipientEvidence = recipientIds.map((recipientBowlerId) => {
    const evidence = targetEvidenceByRecipient.get(recipientBowlerId);
    if (!evidence) throw new StandingAutopayError("ACCOUNT_TARGET_MISSING", "A standing account target is unavailable", 503);
    const partner = partners.find((row) => row.partnerBowlerId === recipientBowlerId);
    return {
      recipientBowlerId,
      role: partner ? "partner" as const : "self" as const,
      paymentLinkId: partner?.paymentLinkId ?? null,
      linkFingerprint: partner?.linkFingerprint ?? null,
      target: evidence.scopedTarget,
    };
  });
  if (recipientEvidence.some(({ target }) => target.olderDebtReviewRequired || target.currentDebtReviewRequired)) {
    throw new StandingAutopayError("ACCOUNT_REVIEW_HOLD", "A standing account target is held for staff review", 409);
  }
  if (recipientEvidence.some(({ target }) => target.olderConfirmedDebtRemainingMinor > 0)) {
    // FIFO applications above are safe owned-credit consumption of confirmed
    // debt and must commit even when remaining arrears are too old for this
    // standing cutoff to collect. Decide the cutoff so a later manual payment
    // cannot turn it into a late catch-up charge.
    const fingerprint = digest(CUTOFF_FP_PREFIX, {
      ...fingerprintBase,
      kind: "arrears_require_one_time_fifo",
      recipientEvidence,
    });
    await beginCommand(tx, {
      organizationId,
      leagueId,
      actorUserId: payerUserId,
      commandType: COMMAND_CUTOFF,
      key: commandKey,
      fingerprint,
    });
    await applyCommand(tx, {
      organizationId,
      leagueId,
      commandType: COMMAND_CUTOFF,
      key: commandKey,
      result: {
        kind: "arrears_require_one_time_fifo",
        cutoffAt,
        consentId: consent.id,
        consentVersion: consent.consentVersion,
        collectionRequirementOccurrenceIds,
        groupIdentity,
      },
    });
    return undefined;
  }
  const fundingPortions = recipientEvidence
    .filter(({ target }) => target.newChargeMinor > 0)
    .map(({ recipientBowlerId, target }, portionIndex) => ({
      portionIndex,
      creditedBowlerId: recipientBowlerId,
      amountMinor: target.newChargeMinor,
    }));

  if (fundingPortions.length === 0) {
    const hasTarget = recipientEvidence.some(({ target }) => target.currentCollectionTargetMinor > 0
      || target.olderConfirmedDebtMinor > 0);
    const kind = hasTarget ? "credit_covered" : "no_current_collection";
    const fingerprint = digest(CUTOFF_FP_PREFIX, { ...fingerprintBase, kind, recipientEvidence });
    await beginCommand(tx, { organizationId, leagueId, actorUserId: payerUserId, commandType: COMMAND_CUTOFF, key: commandKey, fingerprint });
    await applyCommand(tx, {
      organizationId,
      leagueId,
      commandType: COMMAND_CUTOFF,
      key: commandKey,
      result: {
        kind,
        cutoffAt,
        consentId: consent.id,
        consentVersion: consent.consentVersion,
        collectionRequirementOccurrenceIds,
        groupIdentity,
      },
    });
    return undefined;
  }

  if (await hasUnresolvedAccountFundingOverlapInTransaction(tx, {
    organizationId,
    leagueId,
    creditedBowlerIds: fundingPortions.map((portion) => portion.creditedBowlerId),
  })) return undefined;

  const amountMinor = fundingPortions.reduce((sum, portion) => sum + portion.amountMinor, 0);
  const targetKeyIdentity = digest("lvstandingtarget:v1:", {
    organizationId,
    leagueId,
    consentId: consent.id,
    consentVersion: consent.consentVersion,
    cutoffAt,
    groupIdentity,
  });
  const targetKey = `standing-autopay:${targetKeyIdentity}:${group.triggerOccurrenceRevision}`;
  const providerName = consent.providerName ?? "square";
  const operationIdentity = buildPaymentOperationIdentity({
    organizationId,
    operationType: "standing_autopay_charge",
    targetKey,
    amountMinor,
    currency: "USD",
    providerName,
  });
  const recipientEvidenceFingerprint = digest(CUTOFF_FP_PREFIX, {
    ...fingerprintBase,
    recipientEvidence,
    fundingPortions,
  });
  await beginCommand(tx, {
    organizationId,
    leagueId,
    actorUserId: payerUserId,
    commandType: COMMAND_CUTOFF,
    key: commandKey,
    fingerprint: recipientEvidenceFingerprint,
  });

  const [existing] = await tx.select().from(paymentOperations).where(and(
    eq(paymentOperations.organizationId, organizationId),
    eq(paymentOperations.leagueId, leagueId),
    eq(paymentOperations.targetKey, targetKey),
    eq(paymentOperations.operationType, "standing_autopay_charge"),
  )).limit(1).for("update");
  if (existing) {
    await applyCommand(tx, {
      organizationId,
      leagueId,
      commandType: COMMAND_CUTOFF,
      key: commandKey,
      result: { kind: "operation", operationId: existing.id, status: existing.status, cutoffAt, consentId: consent.id, consentVersion: consent.consentVersion, collectionRequirementOccurrenceIds, groupIdentity },
    });
    return existing;
  }

  const [operation] = await tx.insert(paymentOperations).values({
    organizationId,
    authorizingUserId: payerUserId,
    operationType: "standing_autopay_charge",
    targetKey,
    triggerOccurrenceId: group.triggerOccurrenceId,
    leagueId,
    amountMinor,
    currency: "USD",
    requestFingerprint: operationIdentity.requestFingerprint,
    providerIdempotencyKey: operationIdentity.providerIdempotencyKey,
    providerName,
    status: "pending",
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
    attemptCount: 0,
  }).returning();
  if (!operation) throw new StandingAutopayError("OPERATION_WRITE_FAILED", "The standing payment operation could not be created", 500);

  const bindingEvidenceFingerprint = recipientEvidenceFingerprint;
  const standingEvidence = {
    consentId: consent.id,
    consentVersion: consent.consentVersion,
    consentFingerprint: consent.consentFingerprint,
    bindingEvidenceFingerprint,
    cutoffAt,
    collectionMode: group.mode,
    triggerOccurrenceId: group.triggerOccurrenceId,
    triggerOccurrenceRevision: group.triggerOccurrenceRevision,
    pairedOccurrenceId: group.pairedOccurrenceId,
    collectionGroupId: group.groupId,
    collectionGroupRevision: group.groupRevision,
    collectionGroupFingerprint: group.groupFingerprint,
    triggerMemberId: group.triggerMemberId,
    pairedMemberId: group.pairedMemberId,
    collectionRequirementOccurrenceIds,
  };
  const stored = storeAccountStandingFundingSnapshot(buildAccountStandingFundingSnapshot(operation, {
    organizationId,
    leagueId,
    payerBowlerId: consent.payerBowlerId,
    amountMinor,
    fundingPortions,
    recipientEvidence,
    standingEvidence,
    currency: "USD",
    providerName,
    locationId: (await leagueFor(tx, organizationId, leagueId)).locationId,
    providerLocationId: consent.providerLocationId,
    authorizingUserId: payerUserId,
  }));
  await tx.insert(accountPaymentOperationSnapshots).values(stored);
  await tx.insert(paymentOperationStandingAutopayBindings).values({
    operationId: operation.id,
    organizationId,
    leagueId,
    consentId: consent.id,
    consentVersion: consent.consentVersion,
    providerName,
    providerLocationId: consent.providerLocationId ?? "",
    triggerOccurrenceId: group.triggerOccurrenceId,
    pairedOccurrenceId: group.pairedOccurrenceId,
    collectionGroupId: group.groupId,
    collectionGroupRevision: group.groupRevision,
    collectionGroupFingerprint: group.groupFingerprint,
    triggerMemberId: group.triggerMemberId,
    pairedMemberId: group.pairedMemberId,
    cutoffAt,
    collectionMode: group.mode,
    evidenceFingerprint: bindingEvidenceFingerprint,
  });
  await applyCommand(tx, {
    organizationId,
    leagueId,
    commandType: COMMAND_CUTOFF,
    key: commandKey,
    result: {
      kind: "operation",
      operationId: operation.id,
      status: operation.status,
      cutoffAt,
      consentId: consent.id,
      consentVersion: consent.consentVersion,
      amountMinor,
      collectionRequirementOccurrenceIds,
      groupIdentity,
    },
  });
  return operation;
}

async function leagueFor(tx: StandingTx, organizationId: number, leagueId: number) {
  const [league] = await tx.select().from(leagues).where(and(eq(leagues.organizationId, organizationId), eq(leagues.id, leagueId))).limit(1);
  if (!league) throw new StandingAutopayError("NOT_FOUND", "League not found", 404);
  if (league.payingLineupSize === null) throw new StandingAutopayError("ROSTER_PAYMENTS_REQUIRED", "Standing automatic payments require a roster-configured league");
  if (league.paymentMode === "upfront") throw new StandingAutopayError("STANDING_AUTOPAY_UNAVAILABLE_FOR_UPFRONT", "Standing automatic payments are weekly only for upfront leagues", 422);
  return league;
}

async function activeMembership(tx: StandingTx, organizationId: number, leagueId: number, bowlerIds: number[]): Promise<boolean> {
  if (bowlerIds.length === 0) return false;
  const rows = await tx.select({ bowlerId: bowlerLeagues.bowlerId }).from(bowlerLeagues).innerJoin(bowlers, and(
    eq(bowlers.id, bowlerLeagues.bowlerId), eq(bowlers.organizationId, organizationId), eq(bowlers.active, true),
  )).where(and(eq(bowlerLeagues.leagueId, leagueId), eq(bowlerLeagues.active, true), inArray(bowlerLeagues.bowlerId, bowlerIds)));
  return new Set(rows.map((row) => row.bowlerId)).size === new Set(bowlerIds).size;
}

function linkFingerprint(link: Pick<typeof bowlerPaymentLinks.$inferSelect, "id" | "bowlerAId" | "bowlerBId" | "organizationId" | "status" | "respondedAt">): string {
  return digest(PARTNER_FP_PREFIX, {
    id: link.id,
    bowlerAId: link.bowlerAId,
    bowlerBId: link.bowlerBId,
    organizationId: link.organizationId,
    status: link.status,
    respondedAt: link.respondedAt,
  });
}

async function consentPartners(tx: StandingTx, input: { organizationId: number; leagueId: number; consentId: string; consentVersion: number; payerBowlerId: number }): Promise<Array<typeof autopayConsentPartners.$inferSelect>> {
  const rows = await tx.select({ evidence: autopayConsentPartners, link: bowlerPaymentLinks }).from(autopayConsentPartners).innerJoin(bowlerPaymentLinks, and(
    eq(bowlerPaymentLinks.id, autopayConsentPartners.paymentLinkId), eq(bowlerPaymentLinks.organizationId, input.organizationId),
  )).where(and(
    eq(autopayConsentPartners.organizationId, input.organizationId), eq(autopayConsentPartners.leagueId, input.leagueId),
    eq(autopayConsentPartners.consentId, input.consentId), eq(autopayConsentPartners.consentVersion, input.consentVersion),
  )).orderBy(asc(autopayConsentPartners.partnerBowlerId)).for("update");
  for (const row of rows) {
    if (row.link.status !== "accepted" || row.evidence.linkFingerprint !== linkFingerprint(row.link)) throw new StandingAutopayError("PARTNER_AUTHORIZATION_CHANGED", "An accepted payment partner authorization changed");
    if (![row.link.bowlerAId, row.link.bowlerBId].includes(input.payerBowlerId) || ![row.link.bowlerAId, row.link.bowlerBId].includes(row.evidence.partnerBowlerId) || row.link.bowlerAId === row.link.bowlerBId) throw new StandingAutopayError("PARTNER_AUTHORIZATION_INVALID", "The standing partner authorization is invalid");
  }
  return rows.map((row) => row.evidence);
}

async function activeConsent(tx: StandingTx, input: { organizationId: number; leagueId: number; consentId?: string; payerBowlerId?: number }) {
  const conditions = [eq(autopayConsents.organizationId, input.organizationId), eq(autopayConsents.leagueId, input.leagueId), eq(autopayConsents.state, "active" as const)];
  if (input.consentId) conditions.push(eq(autopayConsents.id, input.consentId));
  if (input.payerBowlerId) conditions.push(eq(autopayConsents.payerBowlerId, input.payerBowlerId));
  const [consent] = await tx.select().from(autopayConsents).where(and(...conditions)).limit(1).for("update");
  if (!consent) return undefined;
  if (consent.paymentMode !== "weekly" || !consent.providerName || !consent.providerLocationId || !consent.encryptedSourceId || !consent.encryptedCustomerId || consent.revokedAt !== null) throw new StandingAutopayError("CONSENT_INVALID", "The standing consent is not dispatchable");
  return consent;
}

type ConsentPaymentMethodEvidence = {
  sourceId: string;
  customerId: string;
  operationId: string | null;
};

function invalidConsentPaymentOperation(message = "The payment operation cannot authorize standing automatic payments"): never {
  throw new StandingAutopayError("PAYMENT_OPERATION_INVALID", message, 422);
}

/**
 * A combined checkout may authorize consent only after a fully finalized,
 * self-only v3 interactive charge. All evidence is read while the canonical
 * league lock is held so a foreign or unfinished operation cannot be swapped
 * into a consent request between validation and the consent write.
 */
async function resolveOperationConsentPaymentMethodInTransaction(
  tx: StandingTx,
  input: { organizationId: number; leagueId: number; payerBowlerId: number; actorUserId: number; paymentOperationId: string },
  provider: Awaited<ReturnType<typeof getPaymentProvider>>,
  options: { identityOnly?: boolean } = {},
): Promise<ConsentPaymentMethodEvidence> {
  const [actor] = await tx.select({ id: users.id }).from(users).where(and(
    eq(users.id, input.actorUserId),
    eq(users.organizationId, input.organizationId),
  )).limit(1).for("share");
  if (!actor) invalidConsentPaymentOperation();
  const [operation] = await tx.select().from(paymentOperations).where(and(
    eq(paymentOperations.id, input.paymentOperationId),
    eq(paymentOperations.organizationId, input.organizationId),
    eq(paymentOperations.leagueId, input.leagueId),
    eq(paymentOperations.operationType, "interactive_charge"),
  )).limit(1).for("share");
  if (!operation || operation.status !== "succeeded" || operation.authorizingUserId !== input.actorUserId || !operation.providerObjectId) invalidConsentPaymentOperation();
  if (operation.providerName !== provider.providerName) invalidConsentPaymentOperation();

  const [accountStored] = await tx.select().from(accountPaymentOperationSnapshots).where(and(
    eq(accountPaymentOperationSnapshots.operationId, operation.id),
    eq(accountPaymentOperationSnapshots.organizationId, input.organizationId),
    eq(accountPaymentOperationSnapshots.leagueId, input.leagueId),
  )).limit(1).for("share");
  if (accountStored) {
    const [rosterSnapshot] = await tx.select({ operationId: paymentOperationRosterSnapshots.operationId }).from(paymentOperationRosterSnapshots).where(and(
      eq(paymentOperationRosterSnapshots.operationId, operation.id),
      eq(paymentOperationRosterSnapshots.organizationId, input.organizationId),
      eq(paymentOperationRosterSnapshots.leagueId, input.leagueId),
    )).limit(1).for("share");
    if (rosterSnapshot || accountStored.snapshotKind !== "interactive_funding" || accountStored.snapshotVersion !== 4
      || accountStored.payerBowlerId !== input.payerBowlerId || accountStored.locationId !== provider.locationId
      || accountStored.providerLocationId !== null) invalidConsentPaymentOperation("Only a finalized self-only account card payment can authorize standing automatic payments");
    let accountSnapshot;
    try {
      accountSnapshot = reconstructAccountPaymentOperationSnapshot({ operation, stored: accountStored });
    } catch {
      invalidConsentPaymentOperation();
    }
    const selfEvidence = accountSnapshot.recipientEvidence[0];
    const onlyPortion = accountSnapshot.fundingPortions[0];
    if (accountSnapshot.requestKind !== "direct" || accountSnapshot.recipientEvidence.length !== 1
      || accountSnapshot.fundingPortions.length !== 1 || selfEvidence?.role !== "self"
      || selfEvidence.recipientBowlerId !== input.payerBowlerId || onlyPortion?.creditedBowlerId !== input.payerBowlerId
      || onlyPortion.amountMinor !== operation.amountMinor || accountSnapshot.sourceKind === "wallet") {
      invalidConsentPaymentOperation("Only a finalized self-only account card payment can authorize standing automatic payments");
    }
    const customerId = accountSnapshot.customerId;
    if (!customerId) invalidConsentPaymentOperation("The payment operation customer does not belong to this payer");
    let sourceId: string;
    if (accountSnapshot.sourceKind === "new_card") {
      if (!accountSnapshot.storeCard || operation.cardSaveStatus !== "saved") invalidConsentPaymentOperation();
      const savedCardId = operation.encryptedSavedCardId ? decrypt(operation.encryptedSavedCardId) : null;
      if (!savedCardId) invalidConsentPaymentOperation();
      sourceId = savedCardId;
    } else {
      if (accountSnapshot.storeCard || operation.cardSaveStatus !== null) invalidConsentPaymentOperation();
      sourceId = accountSnapshot.sourceId;
    }
    if (!provider.validateCardId(sourceId) || !provider.hasCardOnFile) invalidConsentPaymentOperation();
    if (options.identityOnly) return { sourceId, customerId, operationId: operation.id };

    const [payer] = await tx.select({ paymentCustomerId: bowlers.paymentCustomerId }).from(bowlers).where(and(
      eq(bowlers.id, input.payerBowlerId), eq(bowlers.organizationId, input.organizationId), eq(bowlers.active, true),
    )).limit(1).for("share");
    if (!payer || payer.paymentCustomerId !== customerId || !(await provider.hasCardOnFile(customerId, sourceId))) {
      invalidConsentPaymentOperation("The payment operation card is not owned by this payer");
    }
    const receipts = await tx.select().from(payments).where(and(
      eq(payments.organizationId, input.organizationId), eq(payments.leagueId, input.leagueId), eq(payments.paymentOperationId, operation.id),
    )).limit(2).for("share");
    const fundings = await tx.select().from(weeklyPaymentFundings).where(and(
      eq(weeklyPaymentFundings.organizationId, input.organizationId), eq(weeklyPaymentFundings.leagueId, input.leagueId),
      eq(weeklyPaymentFundings.paymentId, receipts[0]?.id ?? 0),
    )).limit(2).for("share");
    const funding = fundings[0];
    if (receipts.length !== 1 || receipts[0]?.status !== "paid" || receipts[0]?.bowlerId !== input.payerBowlerId
      || receipts[0]?.amount !== operation.amountMinor || receipts[0]?.providerPaymentId !== operation.providerObjectId
      || receipts[0]?.type !== providerNameToPaymentType(operation.providerName)
      || fundings.length !== 1 || !funding || funding.creditedBowlerId !== input.payerBowlerId || funding.portionIndex !== 0
      || funding.amountMinor !== operation.amountMinor || funding.source !== "provider"
      || funding.authorizationKind !== "provider_snapshot" || funding.authorizationOperationId !== operation.id
      || funding.authorizationFingerprint !== accountSnapshot.snapshotFingerprint) {
      invalidConsentPaymentOperation("The self-only account funding receipt is not fully finalized");
    }
    return { sourceId, customerId, operationId: operation.id };
  }

  const [stored] = await tx.select().from(paymentOperationRosterSnapshots).where(and(
    eq(paymentOperationRosterSnapshots.operationId, operation.id),
    eq(paymentOperationRosterSnapshots.organizationId, input.organizationId),
    eq(paymentOperationRosterSnapshots.leagueId, input.leagueId),
    eq(paymentOperationRosterSnapshots.snapshotKind, "interactive"),
  )).limit(1).for("share");
  if (!stored || stored.snapshotVersion !== 3 || stored.payerBowlerId !== input.payerBowlerId || stored.sourceKind === null || stored.encryptedSourceId === null || stored.partnerEvidence === null || stored.requestKind === null || stored.quoteFingerprint === null) invalidConsentPaymentOperation();
  if (stored.locationId !== provider.locationId || stored.providerLocationId !== null) invalidConsentPaymentOperation("The payment operation provider location does not match this league");

  let snapshot: InteractivePartnerPaymentSnapshot;
  try {
    snapshot = reconstructInteractivePartnerSnapshot({
      organizationId: operation.organizationId,
      amountMinor: operation.amountMinor,
      currency: operation.currency,
      providerName: operation.providerName,
      providerIdempotencyKey: operation.providerIdempotencyKey,
      stored: {
        snapshotVersion: 3,
        snapshotFingerprint: stored.snapshotFingerprint,
        leagueId: stored.leagueId,
        locationId: stored.locationId,
        providerLocationId: stored.providerLocationId,
        payerBowlerId: stored.payerBowlerId,
        requestKind: stored.requestKind,
        encryptedSourceId: stored.encryptedSourceId,
        encryptedCustomerId: stored.encryptedCustomerId,
        encryptedBuyerEmail: stored.encryptedBuyerEmail,
        storeCard: stored.storeCard,
        sourceKind: stored.sourceKind,
        quoteFingerprint: stored.quoteFingerprint,
        partnerEvidence: stored.partnerEvidence,
      },
      allocations: (Array.isArray(stored.obligations) ? stored.obligations : []) as InteractivePartnerPaymentSnapshot["allocations"],
      lineItems: stored.lineItems,
    });
  } catch {
    invalidConsentPaymentOperation();
  }

  if (snapshot.requestKind !== "direct" || snapshot.partnerEvidence.length !== 1) invalidConsentPaymentOperation();
  const selfEvidence = snapshot.partnerEvidence[0];
  if (selfEvidence?.role !== "self" || selfEvidence.dueNow !== true || selfEvidence.recipientBowlerId !== input.payerBowlerId || snapshot.allocations.some((row) => row.bowlerId !== input.payerBowlerId)) invalidConsentPaymentOperation();
  if (snapshot.sourceKind === "wallet") invalidConsentPaymentOperation();

  const customerId = snapshot.customerId;
  if (!customerId) invalidConsentPaymentOperation("The payment operation customer does not belong to this payer");

  let sourceId: string;
  try {
    if (snapshot.sourceKind === "new_card") {
      if (!snapshot.storeCard || operation.cardSaveStatus !== "saved") invalidConsentPaymentOperation();
      const savedCardId = operation.encryptedSavedCardId ? decrypt(operation.encryptedSavedCardId) : null;
      if (!savedCardId) invalidConsentPaymentOperation();
      sourceId = savedCardId;
    } else {
      if (snapshot.storeCard || operation.cardSaveStatus !== null) invalidConsentPaymentOperation();
      const decryptedSourceId = decrypt(stored.encryptedSourceId);
      if (!decryptedSourceId) invalidConsentPaymentOperation();
      sourceId = decryptedSourceId;
    }
  } catch {
    invalidConsentPaymentOperation();
  }
  if (!sourceId || !provider.validateCardId(sourceId) || !provider.hasCardOnFile) invalidConsentPaymentOperation();
  // Applied-command replay only needs immutable operation/snapshot identity.
  // Fresh consent continues through payer, provider ownership, and finalized
  // payment checks below.
  if (options.identityOnly) return { sourceId, customerId, operationId: operation.id };

  const [payer] = await tx.select({ paymentCustomerId: bowlers.paymentCustomerId }).from(bowlers).where(and(
    eq(bowlers.id, input.payerBowlerId),
    eq(bowlers.organizationId, input.organizationId),
    eq(bowlers.active, true),
  )).limit(1).for("share");
  if (!payer || payer.paymentCustomerId !== customerId) invalidConsentPaymentOperation("The payment operation customer does not belong to this payer");
  if (!(await provider.hasCardOnFile(customerId, sourceId))) {
    invalidConsentPaymentOperation("The payment operation card is not owned by this payer");
  }

  const [payment] = await tx.select().from(payments).where(and(
    eq(payments.organizationId, input.organizationId),
    eq(payments.leagueId, input.leagueId),
    eq(payments.paymentOperationId, operation.id),
  )).limit(1).for("share");
  if (!payment || payment.status !== "paid" || payment.bowlerId !== input.payerBowlerId || payment.amount !== operation.amountMinor || payment.providerPaymentId !== operation.providerObjectId) invalidConsentPaymentOperation("The payment operation charge is not finalized");
  const allocations = await tx.select({ obligationId: paymentAllocations.obligationId, amountMinor: paymentAllocations.amountMinor }).from(paymentAllocations).where(and(
    eq(paymentAllocations.organizationId, input.organizationId),
    eq(paymentAllocations.leagueId, input.leagueId),
    eq(paymentAllocations.paymentId, payment.id),
    eq(paymentAllocations.state, "active"),
  )).for("share");
  const expectedAllocations = snapshot.allocations.map((row) => `${row.obligationId}:${row.amountMinor}`).sort().join("|");
  const actualAllocations = allocations.map((row) => `${row.obligationId}:${row.amountMinor}`).sort().join("|");
  if (allocations.length === 0 || actualAllocations !== expectedAllocations || allocations.reduce((sum, row) => sum + row.amountMinor, 0) !== operation.amountMinor) invalidConsentPaymentOperation("The payment operation allocations are incomplete");
  return { sourceId, customerId, operationId: operation.id };
}

async function assertNoInitialDueNowInTransaction(
  tx: StandingTx,
  input: { organizationId: number; leagueId: number; payerBowlerId: number; asOf: string },
): Promise<void> {
  const candidates = await fifoCandidatesInTransaction(tx, {
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    payerBowlerId: input.payerBowlerId,
  });
  const asOf = new Date(input.asOf).getTime();
  if (candidates.some((row) => new Date(row.dueAt).getTime() <= asOf && (row.outstandingMinor > 0 || row.reservedMinor > 0))) {
    throw new StandingAutopayError("ARREARS_REQUIRE_ONE_TIME_FIFO", "Standing automatic payment is blocked until due-now obligations are settled by a one-time FIFO payment", 409);
  }
}

const unresolvedRefundOperationStatuses = [
  "pending",
  "leased",
  "provider_unknown",
  "retry_scheduled",
  "action_required",
  "reconciliation_required",
] as const;

/** Return exact payer/occurrence keys whose retained allocation is covered by
 * a refund operation that has not reached a terminal provider outcome. The
 * check is deliberately allocation-derived: it follows the immutable refund
 * snapshot to the original payment, then the original active allocation and
 * obligation, without creating a second balance or obligation ledger. */
async function pendingRefundPayerWeekKeys(
  tx: StandingTx,
  input: { organizationId: number; leagueId: number; payerBowlerIds: number[]; occurrenceIds: string[] },
): Promise<Set<string>> {
  if (input.payerBowlerIds.length === 0 || input.occurrenceIds.length === 0) return new Set();
  const rows = await tx.select({
    payerBowlerId: paymentObligations.payerBowlerId,
    occurrenceId: paymentObligations.occurrenceId,
  }).from(refundPaymentOperationSnapshots)
    .innerJoin(paymentOperations, and(
      eq(paymentOperations.id, refundPaymentOperationSnapshots.operationId),
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.leagueId, input.leagueId),
      eq(paymentOperations.operationType, "refund"),
    ))
    .innerJoin(paymentAllocations, and(
      eq(paymentAllocations.paymentId, refundPaymentOperationSnapshots.paymentId),
      eq(paymentAllocations.organizationId, input.organizationId),
      eq(paymentAllocations.leagueId, input.leagueId),
      eq(paymentAllocations.state, "active"),
    ))
    .innerJoin(paymentObligations, and(
      eq(paymentObligations.id, paymentAllocations.obligationId),
      eq(paymentObligations.organizationId, input.organizationId),
      eq(paymentObligations.leagueId, input.leagueId),
    ))
    .where(and(
      eq(refundPaymentOperationSnapshots.leagueId, input.leagueId),
      inArray(paymentOperations.status, unresolvedRefundOperationStatuses),
      inArray(paymentObligations.payerBowlerId, input.payerBowlerIds),
      currentBowlerOwnerPredicate(input),
      inArray(paymentObligations.occurrenceId, input.occurrenceIds),
    ));
  return new Set(rows.flatMap((row) => row.payerBowlerId === null ? [] : [`${row.payerBowlerId}:${row.occurrenceId}`]));
}

async function eligibleRows(
  tx: StandingTx,
  input: { organizationId: number; leagueId: number; payerBowlerIds: number[]; activationAt: string; cutoffAt: string; dueMode: "exact" | "paired"; occurrenceIds?: string[] },
): Promise<Array<{ obligation: typeof paymentObligations.$inferSelect; outstandingMinor: number; responsibilityVersion: number }>> {
  const obligations = await tx.select({ obligation: paymentObligations, responsibilityVersion: occurrencePaymentResponsibilities.version })
    .from(paymentObligations)
    .innerJoin(occurrencePaymentResponsibilities, and(
      eq(paymentObligations.responsibilityId, occurrencePaymentResponsibilities.id),
      eq(occurrencePaymentResponsibilities.organizationId, input.organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
      eq(occurrencePaymentResponsibilities.state, "active"),
    ))
    .where(and(
      eq(paymentObligations.organizationId, input.organizationId), eq(paymentObligations.leagueId, input.leagueId),
      inArray(paymentObligations.payerBowlerId, input.payerBowlerIds),
      currentBowlerOwnerPredicate(input),
      inArray(paymentObligations.state, ["open", "partially_settled"] as const),
      gte(paymentObligations.dueAt, input.activationAt),
      ...(input.dueMode === "exact" ? [eq(paymentObligations.dueAt, input.cutoffAt)] : []),
      ...(input.occurrenceIds?.length ? [inArray(paymentObligations.occurrenceId, input.occurrenceIds)] : []),
    )).orderBy(asc(paymentObligations.dueAt), asc(paymentObligations.payerBowlerId), asc(paymentObligations.occurrenceId), asc(paymentObligations.id)).for("update");
  const obligationIds = obligations.map((row) => row.obligation.id);
  const payerOccurrenceKeys = [...new Set(obligations.map((row) => `${row.obligation.payerBowlerId}:${row.obligation.occurrenceId}`))];
  const allOccurrenceIds = [...new Set(obligations.map((row) => row.obligation.occurrenceId))];
  const allPayerWeekObligations = payerOccurrenceKeys.length === 0 ? [] : await tx.select({ obligation: paymentObligations }).from(paymentObligations).where(and(
    eq(paymentObligations.organizationId, input.organizationId),
    eq(paymentObligations.leagueId, input.leagueId),
    inArray(paymentObligations.payerBowlerId, input.payerBowlerIds),
    currentBowlerOwnerPredicate(input),
    inArray(paymentObligations.occurrenceId, allOccurrenceIds),
  ));
  const allObligationIds = [...new Set(allPayerWeekObligations.map((row) => row.obligation.id))];
  const allocations = allObligationIds.length === 0 ? [] : await tx.select({ id: paymentAllocations.id, obligationId: paymentAllocations.obligationId, amountMinor: paymentAllocations.amountMinor }).from(paymentAllocations).where(and(
    eq(paymentAllocations.organizationId, input.organizationId), eq(paymentAllocations.leagueId, input.leagueId), eq(paymentAllocations.state, "active"),
    inArray(paymentAllocations.obligationId, allObligationIds),
  ));
  const adjustments = allocations.length === 0 ? [] : await tx.select({ sourceAllocationId: refundAllocationAdjustments.sourceAllocationId, amountMinor: refundAllocationAdjustments.amountMinor, disposition: refundAllocationAdjustments.disposition }).from(refundAllocationAdjustments).where(and(
    eq(refundAllocationAdjustments.organizationId, input.organizationId), eq(refundAllocationAdjustments.leagueId, input.leagueId),
    inArray(refundAllocationAdjustments.sourceAllocationId, allocations.map((row) => row.id)),
  ));
  const adjustmentByAllocationId = new Map(adjustments.map((row) => [row.sourceAllocationId, row]));
  const reservedRows = obligationIds.length === 0 ? [] : await tx.select({ obligationId: paymentOperationRosterSnapshotItems.obligationId, amountMinor: paymentOperationRosterSnapshotItems.amountMinor }).from(paymentOperationRosterSnapshotItems).where(and(
    eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId), eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId),
    eq(paymentOperationRosterSnapshotItems.state, "reserved"), inArray(paymentOperationRosterSnapshotItems.obligationId, obligationIds),
  ));
  const allocatedByObligationId = new Map<string, number>();
  const adjustmentsByObligationId = new Map<string, Array<{ amountMinor: number; disposition: "still_owed" | "waived" }>>();
  const reservedByObligationId = new Map<string, number>();
  for (const allocation of allocations) {
    allocatedByObligationId.set(allocation.obligationId, (allocatedByObligationId.get(allocation.obligationId) ?? 0) + allocation.amountMinor);
    const adjustment = adjustmentByAllocationId.get(allocation.id);
    if (adjustment) adjustmentsByObligationId.set(allocation.obligationId, [
      ...(adjustmentsByObligationId.get(allocation.obligationId) ?? []),
      { amountMinor: adjustment.amountMinor, disposition: adjustment.disposition },
    ]);
  }
  for (const reservation of reservedRows) reservedByObligationId.set(reservation.obligationId, (reservedByObligationId.get(reservation.obligationId) ?? 0) + reservation.amountMinor);
  const result: Array<{ obligation: typeof paymentObligations.$inferSelect; outstandingMinor: number; responsibilityVersion: number }> = [];
  // A still-owed refund is a manual-only hold for the payer's whole
  // occurrence/week. The source component may already be settled by a later
  // cash/check/card repayment, so derive the marker from all obligations in
  // the same payer/week rather than only the currently eligible rows.
  const outstandingByPayerWeek = new Map<string, number>();
  const stillOwedByPayerWeek = new Set<string>();
  for (const row of allPayerWeekObligations) {
    if (row.obligation.payerBowlerId === null) throw new StandingAutopayError("OWNER_EVIDENCE_INVALID", "A standing payment candidate has no historical payer", 503);
    const key = `${row.obligation.payerBowlerId}:${row.obligation.occurrenceId}`;
    const balance = canonicalObligationBalance({
      amountMinor: row.obligation.amountMinor,
      state: row.obligation.state,
      grossAllocatedMinor: allocatedByObligationId.get(row.obligation.id) ?? 0,
      adjustments: adjustmentsByObligationId.get(row.obligation.id) ?? [],
    });
    outstandingByPayerWeek.set(key, (outstandingByPayerWeek.get(key) ?? 0) + balance.outstandingMinor);
    if ((adjustmentsByObligationId.get(row.obligation.id) ?? []).some((adjustment) => adjustment.disposition === "still_owed")) {
      stillOwedByPayerWeek.add(key);
    }
  }
  const heldPayerWeeks = new Set<string>([...stillOwedByPayerWeek].filter((key) => (outstandingByPayerWeek.get(key) ?? 0) > 0));
  for (const key of await pendingRefundPayerWeekKeys(tx, {
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    payerBowlerIds: input.payerBowlerIds,
    occurrenceIds: allOccurrenceIds,
  })) heldPayerWeeks.add(key);
  for (const row of obligations) {
    if (row.obligation.payerBowlerId === null) throw new StandingAutopayError("OWNER_EVIDENCE_INVALID", "A standing payment candidate has no historical payer", 503);
    const balance = canonicalObligationBalance({
      amountMinor: row.obligation.amountMinor,
      state: row.obligation.state,
      grossAllocatedMinor: allocatedByObligationId.get(row.obligation.id) ?? 0,
      adjustments: adjustmentsByObligationId.get(row.obligation.id) ?? [],
    });
    const reservedMinor = reservedByObligationId.get(row.obligation.id) ?? 0;
    const outstandingMinor = balance.outstandingMinor - reservedMinor;
    if (outstandingMinor > 0) result.push({ obligation: row.obligation, outstandingMinor, responsibilityVersion: row.responsibilityVersion });
  }
  return result.filter((row) => !heldPayerWeeks.has(`${row.obligation.payerBowlerId}:${row.obligation.occurrenceId}`));
}

/** Standing collection is deliberately current-only. Any older unpaid or
 * reserved capacity must be settled by a one-time FIFO tender first. */
async function assertNoStandingArrears(
  tx: StandingTx,
  input: { organizationId: number; leagueId: number; payerBowlerIds: number[]; activationAt: string; cutoffAt: string },
): Promise<void> {
  const rows = await tx.select({ obligation: paymentObligations }).from(paymentObligations).innerJoin(occurrencePaymentResponsibilities, and(
    eq(paymentObligations.responsibilityId, occurrencePaymentResponsibilities.id),
    eq(occurrencePaymentResponsibilities.organizationId, input.organizationId),
    eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
    eq(occurrencePaymentResponsibilities.state, "active"),
  )).where(and(
    eq(paymentObligations.organizationId, input.organizationId),
    eq(paymentObligations.leagueId, input.leagueId),
    inArray(paymentObligations.payerBowlerId, input.payerBowlerIds),
    currentBowlerOwnerPredicate(input),
    inArray(paymentObligations.state, ["open", "partially_settled"] as const),
    lt(paymentObligations.dueAt, input.cutoffAt),
  )).for("update");
  const obligationIds = rows.map((row) => row.obligation.id);
  const allocations = obligationIds.length === 0 ? [] : await tx.select({ id: paymentAllocations.id, obligationId: paymentAllocations.obligationId, amountMinor: paymentAllocations.amountMinor }).from(paymentAllocations).where(and(
    eq(paymentAllocations.organizationId, input.organizationId), eq(paymentAllocations.leagueId, input.leagueId), eq(paymentAllocations.state, "active"),
    inArray(paymentAllocations.obligationId, obligationIds),
  ));
  const adjustments = allocations.length === 0 ? [] : await tx.select({ sourceAllocationId: refundAllocationAdjustments.sourceAllocationId, amountMinor: refundAllocationAdjustments.amountMinor, disposition: refundAllocationAdjustments.disposition }).from(refundAllocationAdjustments).where(and(
    eq(refundAllocationAdjustments.organizationId, input.organizationId), eq(refundAllocationAdjustments.leagueId, input.leagueId),
    inArray(refundAllocationAdjustments.sourceAllocationId, allocations.map((row) => row.id)),
  ));
  const adjustmentByAllocationId = new Map(adjustments.map((row) => [row.sourceAllocationId, row]));
  const allocatedByObligationId = new Map<string, number>();
  const adjustmentsByObligationId = new Map<string, Array<{ amountMinor: number; disposition: "still_owed" | "waived" }>>();
  for (const allocation of allocations) {
    allocatedByObligationId.set(allocation.obligationId, (allocatedByObligationId.get(allocation.obligationId) ?? 0) + allocation.amountMinor);
    const adjustment = adjustmentByAllocationId.get(allocation.id);
    if (adjustment) adjustmentsByObligationId.set(allocation.obligationId, [
      ...(adjustmentsByObligationId.get(allocation.obligationId) ?? []),
      { amountMinor: adjustment.amountMinor, disposition: adjustment.disposition },
    ]);
  }
  const reservations = obligationIds.length === 0 ? [] : await tx.select({ obligationId: paymentOperationRosterSnapshotItems.obligationId, amountMinor: paymentOperationRosterSnapshotItems.amountMinor }).from(paymentOperationRosterSnapshotItems).where(and(
    eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId), eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId),
    eq(paymentOperationRosterSnapshotItems.state, "reserved"), inArray(paymentOperationRosterSnapshotItems.obligationId, obligationIds),
  ));
  const reservedByObligationId = new Map<string, number>();
  for (const reservation of reservations) reservedByObligationId.set(reservation.obligationId, (reservedByObligationId.get(reservation.obligationId) ?? 0) + reservation.amountMinor);
  for (const row of rows) {
    const balance = canonicalObligationBalance({
      amountMinor: row.obligation.amountMinor,
      state: row.obligation.state,
      grossAllocatedMinor: allocatedByObligationId.get(row.obligation.id) ?? 0,
      adjustments: adjustmentsByObligationId.get(row.obligation.id) ?? [],
    });
    if (balance.outstandingMinor > 0 || (reservedByObligationId.get(row.obligation.id) ?? 0) > 0) {
      throw new StandingAutopayError("ARREARS_REQUIRE_ONE_TIME_FIFO", "Standing automatic payment is blocked until older unpaid obligations are settled by a one-time FIFO payment", 409);
    }
  }
}

/** A competing cutoff may temporarily own every remaining cent. It is not a
 * durable empty decision: once that operation is canceled/reconciled, the
 * same cutoff must be discoverable again. */
async function hasOpenReservedObligations(
  tx: StandingTx,
  input: { organizationId: number; leagueId: number; payerBowlerIds: number[]; activationAt: string; cutoffAt: string; dueMode: "exact" | "paired"; occurrenceIds: string[] },
): Promise<boolean> {
  const [row] = await tx.select({ id: paymentObligations.id }).from(paymentObligations).innerJoin(occurrencePaymentResponsibilities, and(
    eq(paymentObligations.responsibilityId, occurrencePaymentResponsibilities.id),
    eq(occurrencePaymentResponsibilities.organizationId, input.organizationId),
    eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
    eq(occurrencePaymentResponsibilities.state, "active"),
  )).innerJoin(paymentOperationRosterSnapshotItems, and(
    eq(paymentOperationRosterSnapshotItems.obligationId, paymentObligations.id),
    eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId),
    eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId),
    eq(paymentOperationRosterSnapshotItems.state, "reserved"),
  )).where(and(
    eq(paymentObligations.organizationId, input.organizationId),
    eq(paymentObligations.leagueId, input.leagueId),
    inArray(paymentObligations.payerBowlerId, input.payerBowlerIds),
    currentBowlerOwnerPredicate(input),
    inArray(paymentObligations.state, ["open", "partially_settled"] as const),
    gte(paymentObligations.dueAt, input.activationAt),
    ...(input.dueMode === "exact" ? [eq(paymentObligations.dueAt, input.cutoffAt)] : []),
    inArray(paymentObligations.occurrenceId, input.occurrenceIds),
  )).limit(1).for("share");
  return Boolean(row);
}

type StandingCutoffGroup = {
  mode: "weekly" | "double_pay";
  /** A published paired member is never independently chargeable.  Its
   * trigger owns the cutoff; when the trigger was durably blocked, the pair
   * must remain manual rather than silently becoming a weekly charge. */
  suppressed?: boolean;
  groupId: string | null;
  groupRevision: number | null;
  groupFingerprint: string | null;
  triggerOccurrenceId: string;
  pairedOccurrenceId: string | null;
  triggerMemberId: string | null;
  pairedMemberId: string | null;
  occurrenceIds: string[];
  triggerOccurrenceRevision: number;
};

/** Resolve one exact published trigger. A double-pay is all-or-nothing: the
 * group identity and both member identities are captured before obligations
 * are selected. */
async function groupForCutoff(tx: StandingTx, input: { organizationId: number; leagueId: number; cutoffAt: string }): Promise<StandingCutoffGroup> {
  const occurrence = (await tx.select({ id: leagueOccurrences.id, currentRevision: leagueOccurrences.currentRevision }).from(leagueOccurrences).where(and(eq(leagueOccurrences.organizationId, input.organizationId), eq(leagueOccurrences.leagueId, input.leagueId), eq(leagueOccurrences.startAt, input.cutoffAt))).limit(1))[0];
  if (!occurrence) throw new StandingAutopayError("TRIGGER_OCCURRENCE_MISSING", "The standing cutoff occurrence is unavailable", 409);
  const members = await tx.select({ group: canonicalCollectionGroups, member: canonicalCollectionGroupMembers }).from(canonicalCollectionGroups).innerJoin(canonicalCollectionGroupMembers, and(
    eq(canonicalCollectionGroupMembers.groupId, canonicalCollectionGroups.id), eq(canonicalCollectionGroupMembers.organizationId, input.organizationId), eq(canonicalCollectionGroupMembers.leagueId, input.leagueId), eq(canonicalCollectionGroupMembers.active, true),
  )).where(and(eq(canonicalCollectionGroups.organizationId, input.organizationId), eq(canonicalCollectionGroups.leagueId, input.leagueId), eq(canonicalCollectionGroups.state, "published"), eq(canonicalCollectionGroupMembers.occurrenceId, occurrence.id))).orderBy(asc(canonicalCollectionGroupMembers.memberOrdinal)).for("share");
  const trigger = members.find((row) => row.member.role === "trigger");
  if (!trigger) {
    const paired = members.find((row) => row.member.role === "paired");
    return {
      mode: "weekly",
      suppressed: Boolean(paired),
      groupId: null,
      groupRevision: null,
      groupFingerprint: null,
      triggerOccurrenceId: occurrence.id,
      triggerOccurrenceRevision: occurrence.currentRevision,
      pairedOccurrenceId: null,
      triggerMemberId: null,
      pairedMemberId: paired?.member.id ?? null,
      occurrenceIds: [occurrence.id],
    };
  }
  const allMembers = await tx.select({ group: canonicalCollectionGroups, member: canonicalCollectionGroupMembers }).from(canonicalCollectionGroups).innerJoin(canonicalCollectionGroupMembers, and(
    eq(canonicalCollectionGroupMembers.groupId, trigger.group.id), eq(canonicalCollectionGroupMembers.organizationId, input.organizationId), eq(canonicalCollectionGroupMembers.leagueId, input.leagueId), eq(canonicalCollectionGroupMembers.active, true),
  )).where(and(eq(canonicalCollectionGroups.id, trigger.group.id), eq(canonicalCollectionGroups.state, "published"))).orderBy(asc(canonicalCollectionGroupMembers.memberOrdinal)).for("share");
  const paired = allMembers.find((row) => row.member.role === "paired");
  if (allMembers.length !== 2 || !paired) throw new StandingAutopayError("DOUBLE_PAY_GROUP_INVALID", "The published double-pay group is incomplete", 409);
  return { mode: "double_pay", groupId: trigger.group.id, groupRevision: trigger.group.currentRevision, groupFingerprint: trigger.group.fingerprint, triggerOccurrenceId: trigger.member.occurrenceId, triggerOccurrenceRevision: occurrence.currentRevision, pairedOccurrenceId: paired.member.occurrenceId, triggerMemberId: trigger.member.id, pairedMemberId: paired.member.id, occurrenceIds: [trigger.member.occurrenceId, paired.member.occurrenceId] };
}

/** Revoke a consent while the league lock is held.  Replacement and explicit
 * revoke share this fence so a pre-dispatch reservation can never strand the
 * cutoff for the next consent version. */
async function revokeConsentAndStopOperationsInTransaction(
  tx: StandingTx,
  input: { organizationId: number; leagueId: number; consent: typeof autopayConsents.$inferSelect; revokedAt: string },
) {
  const operations = await tx.select({ operation: paymentOperations }).from(paymentOperations).innerJoin(paymentOperationStandingAutopayBindings, eq(paymentOperationStandingAutopayBindings.operationId, paymentOperations.id)).where(and(
    eq(paymentOperations.organizationId, input.organizationId), eq(paymentOperations.leagueId, input.leagueId), eq(paymentOperations.operationType, "standing_autopay_charge"), eq(paymentOperationStandingAutopayBindings.consentId, input.consent.id), eq(paymentOperationStandingAutopayBindings.consentVersion, input.consent.consentVersion),
  )).orderBy(asc(paymentOperations.id)).for("update");
  await tx.update(autopayConsents).set({ state: "revoked", revokedAt: input.revokedAt }).where(and(eq(autopayConsents.id, input.consent.id), eq(autopayConsents.state, "active")));
  for (const { operation } of operations) {
    if (["pending", "leased", "retry_scheduled"].includes(operation.status) && operation.dispatchClaimedAt === null && operation.providerObjectId === null) {
      await tx.update(paymentOperationRosterSnapshotItems).set({ state: "released" }).where(and(eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId), eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId), eq(paymentOperationRosterSnapshotItems.operationId, operation.id), eq(paymentOperationRosterSnapshotItems.state, "reserved")));
      await tx.update(paymentOperations).set({ status: "canceled", nextAttemptAt: null, leaseOwner: null, leaseToken: null, leaseExpiresAt: null, dispatchClaimedAt: null, errorClassification: null, errorCode: null, completedAt: input.revokedAt, updatedAt: input.revokedAt }).where(and(eq(paymentOperations.organizationId, input.organizationId), eq(paymentOperations.id, operation.id)));
    } else if (["leased", "provider_unknown", "retry_scheduled", "pending"].includes(operation.status) && (operation.dispatchClaimedAt !== null || operation.providerObjectId !== null)) {
      await tx.update(paymentOperations).set({ status: "reconciliation_required", nextAttemptAt: null, errorClassification: "provider_unknown", errorCode: "CONSENT_REVOKED_AFTER_DISPATCH", updatedAt: input.revokedAt }).where(and(eq(paymentOperations.organizationId, input.organizationId), eq(paymentOperations.id, operation.id)));
    }
  }
  return { ...input.consent, state: "revoked" as const, revokedAt: input.revokedAt };
}

async function latestActionableStandingOperation(
  tx: StandingTx,
  input: { organizationId: number; leagueId: number },
  consent: typeof autopayConsents.$inferSelect | undefined,
  payerBowlerId: number,
): Promise<"scheduled_payment_declined" | null> {
  if (!consent) return null;
  const [row] = await tx.select({ id: paymentOperations.id }).from(paymentOperations).innerJoin(
    paymentOperationStandingAutopayBindings,
    and(
      eq(paymentOperationStandingAutopayBindings.operationId, paymentOperations.id),
      eq(paymentOperationStandingAutopayBindings.organizationId, input.organizationId),
      eq(paymentOperationStandingAutopayBindings.leagueId, input.leagueId),
    ),
  ).innerJoin(
    autopayConsents,
    and(
      eq(autopayConsents.id, paymentOperationStandingAutopayBindings.consentId),
      eq(autopayConsents.consentVersion, paymentOperationStandingAutopayBindings.consentVersion),
      eq(autopayConsents.organizationId, input.organizationId),
      eq(autopayConsents.leagueId, input.leagueId),
      eq(autopayConsents.payerBowlerId, payerBowlerId),
    ),
  ).where(and(
    eq(paymentOperations.organizationId, input.organizationId),
    eq(paymentOperations.leagueId, input.leagueId),
    eq(paymentOperations.operationType, "standing_autopay_charge"),
    eq(paymentOperations.status, "action_required"),
    sql`(
      EXISTS (
        SELECT 1
        FROM payment_operation_roster_snapshot_items snapshot_item
        INNER JOIN payment_obligations obligation
          ON obligation.id = snapshot_item.obligation_id
         AND obligation.organization_id = snapshot_item.organization_id
         AND obligation.league_id = snapshot_item.league_id
        WHERE snapshot_item.organization_id = ${input.organizationId}
          AND snapshot_item.league_id = ${input.leagueId}
          AND snapshot_item.operation_id = ${paymentOperations.id}
          AND obligation.state IN ('open', 'partially_settled')
          AND obligation.amount_minor > (
            SELECT COALESCE(SUM(allocation.amount_minor), 0)
            FROM payment_allocations allocation
            WHERE allocation.organization_id = ${input.organizationId}
              AND allocation.league_id = ${input.leagueId}
              AND allocation.obligation_id = obligation.id
              AND allocation.state = 'active'
          )
      )
      OR EXISTS (
        SELECT 1 FROM account_payment_operation_snapshots account_snapshot
        WHERE account_snapshot.organization_id = ${input.organizationId}
          AND account_snapshot.league_id = ${input.leagueId}
          AND account_snapshot.operation_id = ${paymentOperations.id}
          AND account_snapshot.snapshot_kind = 'standing_funding'
      )
    )`,
  )).orderBy(
    desc(paymentOperations.completedAt),
    desc(paymentOperations.updatedAt),
    desc(paymentOperations.id),
  ).limit(1);
  if (!row) return null;
  return "scheduled_payment_declined";
}

function consentWire(
  consent: typeof autopayConsents.$inferSelect | undefined,
  partners: number[],
  organizationId: number,
  leagueId: number,
  payerBowlerId: number,
  paymentAttention: "scheduled_payment_declined" | null = null,
  paymentMethod: { brand: string; last4: string } | null = null,
) {
  return {
    contractVersion: "standing-autopay-consent/1" as const,
    organizationId, leagueId, payerBowlerId,
    consentId: consent?.id ?? null,
    consentVersion: consent?.consentVersion ?? null,
    state: consent?.state ?? "none",
    paymentMode: "weekly" as const,
    partnerBowlerIds: partners,
    paymentMethod,
    paymentAttention,
  };
}

type StandingAutopayPaymentMethodLookup = {
  locationId: number;
  providerName: string;
  providerLocationId: string;
  encryptedSourceId: string;
  encryptedCustomerId: string;
};

/**
 * Resolve card metadata after the status transaction has released the
 * schedule lock. The provider source/customer identifiers never leave this
 * server-side lookup; only the card brand and last four digits are returned.
 */
async function resolveStandingAutopayPaymentMethod(
  lookup: StandingAutopayPaymentMethodLookup | null,
): Promise<{ brand: string; last4: string } | null> {
  if (!lookup) return null;
  try {
    const provider = await getPaymentProvider(lookup.locationId);
    if (provider.locationId !== lookup.locationId || provider.providerName !== lookup.providerName) return null;
    if (typeof provider.getProviderLocationId !== "function" || (await provider.getProviderLocationId()) !== lookup.providerLocationId) return null;
    const sourceId = decrypt(lookup.encryptedSourceId);
    const customerId = decrypt(lookup.encryptedCustomerId);
    if (!sourceId || !customerId) return null;
    const card = (await provider.listCardsOnFile(customerId)).find((candidate) => candidate.id === sourceId);
    if (!card || typeof card.brand !== "string" || typeof card.last4 !== "string" || !card.brand || !card.last4) return null;
    return { brand: card.brand, last4: card.last4 };
  } catch {
    // Provider outages and missing/deleted cards must not hide a valid active
    // consent or make the status endpoint fail closed.
    return null;
  }
}

export async function readStandingAutopayConsent(input: { organizationId: number; leagueId: number; payerBowlerId: number }) {
  if (!rosterStandingAutopayEnabled || scheduledPaymentExecutionMode !== "ledger_execute") {
    return consentWire(undefined, [], input.organizationId, input.leagueId, input.payerBowlerId);
  }
  const snapshot = await db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    const league = await leagueFor(tx, input.organizationId, input.leagueId);
    const consent = await activeConsent(tx, input);
    const partners = consent ? await consentPartners(tx, { organizationId: input.organizationId, leagueId: input.leagueId, consentId: consent.id, consentVersion: consent.consentVersion, payerBowlerId: input.payerBowlerId }) : [];
    const paymentAttention = await latestActionableStandingOperation(tx, input, consent, input.payerBowlerId);
    const paymentMethodLookup = consent && league.locationId !== null
      && consent.providerName !== null
      && consent.providerLocationId !== null
      && consent.encryptedSourceId !== null
      && consent.encryptedCustomerId !== null
      ? {
        locationId: league.locationId,
        providerName: consent.providerName,
        providerLocationId: consent.providerLocationId,
        encryptedSourceId: consent.encryptedSourceId,
        encryptedCustomerId: consent.encryptedCustomerId,
      }
      : null;
    return {
      wire: consentWire(consent, partners.map((row) => row.partnerBowlerId), input.organizationId, input.leagueId, input.payerBowlerId, paymentAttention),
      paymentMethodLookup,
    };
  });
  const paymentMethod = await resolveStandingAutopayPaymentMethod(snapshot.paymentMethodLookup);
  return { ...snapshot.wire, paymentMethod };
}

export async function activateStandingAutopayConsent(input: { organizationId: number; leagueId: number; payerBowlerId: number; actorUserId: number; request: StandingAutopayConsentRequest }) {
  if (!rosterStandingAutopayEnabled || scheduledPaymentExecutionMode !== "ledger_execute") throw new StandingAutopayError("STANDING_AUTOPAY_DISABLED", "Standing automatic payments are not enabled", 409);
  const league = await db.select({ locationId: leagues.locationId, paymentMode: leagues.paymentMode }).from(leagues).where(and(eq(leagues.id, input.leagueId), eq(leagues.organizationId, input.organizationId))).limit(1).then((rows) => rows[0]);
  if (!league || league.locationId === null) throw new StandingAutopayError("NOT_FOUND", "League not found", 404);
  if (league.paymentMode === "upfront") throw new StandingAutopayError("STANDING_AUTOPAY_UNAVAILABLE_FOR_UPFRONT", "Standing automatic payments are disabled for upfront leagues", 422);
  const [payer] = await db.select().from(bowlers).where(and(eq(bowlers.id, input.payerBowlerId), eq(bowlers.organizationId, input.organizationId), eq(bowlers.active, true))).limit(1);
  if (!payer) throw new StandingAutopayError("PAYMENT_CUSTOMER_MISMATCH", "The payment method belongs to another payer", 403);
  const provider = await getPaymentProvider(league.locationId);
  const providerName = provider.providerName;
  const providerLocationId = await providerLocationIdentity(provider);
  if (input.request.partnerBowlerIds.length > 0) throw new StandingAutopayError("PARTNERS_NOT_SUPPORTED", "Automatic payment applies to one bowler; enter shared payments separately", 422);
  const partnerIds: number[] = [];
  const directSourceId = input.request.sourceId;
  const directCustomerId = payer.paymentCustomerId ?? null;
  const requestedPaymentOperationId = input.request.paymentOperationId;
  if (directSourceId !== undefined) {
    if (!directCustomerId) throw new StandingAutopayError("PAYMENT_CUSTOMER_MISMATCH", "The payment method belongs to another payer", 403);
    if (!provider.validateCardId(directSourceId) || !provider.hasCardOnFile) throw new StandingAutopayError("PAYMENT_METHOD_INVALID", "The saved payment method is unavailable", 422);
    if (!(await provider.hasCardOnFile(directCustomerId, directSourceId))) throw new StandingAutopayError("PAYMENT_METHOD_NOT_OWNED", "The saved payment method is unavailable", 403);
  }
  // Resolve the operation and snapshot without calling the provider first so
  // an already-applied command can replay even when card lookup is temporarily
  // unavailable. This read still validates the operation, tenant/league,
  // snapshot, payer, and finalized payment evidence.
  const operationEvidenceForCommand = requestedPaymentOperationId
    ? await db.transaction((tx) => resolveOperationConsentPaymentMethodInTransaction(tx, {
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      payerBowlerId: input.payerBowlerId,
      actorUserId: input.actorUserId,
      paymentOperationId: requestedPaymentOperationId,
    }, provider, { identityOnly: true }))
    : undefined;
  if (operationEvidenceForCommand) {
    const commandFingerprint = consentCommandFingerprint({
      leagueId: input.leagueId,
      payerBowlerId: input.payerBowlerId,
      sourceId: operationEvidenceForCommand.sourceId,
      customerId: operationEvidenceForCommand.customerId,
      providerName,
      providerLocationId,
      partnerIds,
      paymentOperationId: operationEvidenceForCommand.operationId ?? undefined,
    });
    const [existingCommand] = await db.select().from(financialCommands).where(and(
      eq(financialCommands.organizationId, input.organizationId),
      eq(financialCommands.leagueId, input.leagueId),
      eq(financialCommands.commandType, COMMAND_CONSENT),
      eq(financialCommands.idempotencyKey, input.request.commandKey),
    )).limit(1);
    validateOrReplayConsentCommand(existingCommand, { actorUserId: input.actorUserId, fingerprint: commandFingerprint });
  }
  const result = await db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    const lockedLeague = await leagueFor(tx, input.organizationId, input.leagueId);
    if (lockedLeague.locationId === null || lockedLeague.locationId !== league.locationId) throw new StandingAutopayError("LEAGUE_PROVIDER_LOCATION_CHANGED", "The league payment location changed; retry consent setup", 409);
    const lockedProvider = await getPaymentProvider(lockedLeague.locationId);
    const lockedProviderLocationId = await providerLocationIdentity(lockedProvider);
    if (lockedProvider.providerName !== providerName || lockedProviderLocationId !== providerLocationId) throw new StandingAutopayError("LEAGUE_PROVIDER_LOCATION_CHANGED", "The payment provider location changed; retry consent setup", 409);
    if (operationEvidenceForCommand) {
      const commandFingerprint = consentCommandFingerprint({
        leagueId: input.leagueId,
        payerBowlerId: input.payerBowlerId,
        sourceId: operationEvidenceForCommand.sourceId,
        customerId: operationEvidenceForCommand.customerId,
        providerName,
        providerLocationId,
        partnerIds,
        paymentOperationId: operationEvidenceForCommand.operationId ?? undefined,
      });
      const [lockedCommand] = await tx.select().from(financialCommands).where(and(
        eq(financialCommands.organizationId, input.organizationId),
        eq(financialCommands.leagueId, input.leagueId),
        eq(financialCommands.commandType, COMMAND_CONSENT),
        eq(financialCommands.idempotencyKey, input.request.commandKey),
      )).limit(1).for("update");
      validateOrReplayConsentCommand(lockedCommand, { actorUserId: input.actorUserId, fingerprint: commandFingerprint });
    }
    const operationEvidence = input.request.paymentOperationId
      ? await resolveOperationConsentPaymentMethodInTransaction(tx, {
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        payerBowlerId: input.payerBowlerId,
        actorUserId: input.actorUserId,
        paymentOperationId: input.request.paymentOperationId,
      }, lockedProvider)
      : null;
    const sourceId = operationEvidence?.sourceId ?? directSourceId;
    const customerId = operationEvidence?.customerId ?? directCustomerId;
    if (!sourceId || !customerId) throw new StandingAutopayError("PAYMENT_METHOD_INVALID", "The saved payment method is unavailable", 422);
    const commandFingerprint = consentCommandFingerprint({
      leagueId: input.leagueId,
      payerBowlerId: input.payerBowlerId,
      sourceId,
      customerId,
      providerName,
      providerLocationId,
      partnerIds,
      paymentOperationId: operationEvidence?.operationId ?? undefined,
    });
    await beginCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, actorUserId: input.actorUserId, commandType: COMMAND_CONSENT, key: input.request.commandKey, fingerprint: commandFingerprint });
    if (!(await activeMembership(tx, input.organizationId, input.leagueId, [input.payerBowlerId, ...partnerIds]))) throw new StandingAutopayError("BOWLER_NOT_IN_LEAGUE", "Every standing payer must be an active league member", 403);
    await assertNotActiveRotatingPoolMemberForStandingAutopay(tx, { organizationId: input.organizationId, leagueId: input.leagueId, bowlerId: input.payerBowlerId });
    const links = partnerIds.length === 0 ? [] : await tx.select().from(bowlerPaymentLinks).where(and(eq(bowlerPaymentLinks.organizationId, input.organizationId), eq(bowlerPaymentLinks.status, "accepted"), or(...partnerIds.map((id) => or(and(eq(bowlerPaymentLinks.bowlerAId, input.payerBowlerId), eq(bowlerPaymentLinks.bowlerBId, id)), and(eq(bowlerPaymentLinks.bowlerAId, id), eq(bowlerPaymentLinks.bowlerBId, input.payerBowlerId))))))).for("update");
    if (links.length !== partnerIds.length) throw new StandingAutopayError("PARTNER_AUTHORIZATION_REQUIRED", "Every selected partner must have an accepted same-tenant payment link", 403);
    const timestampResult = await tx.execute(sql`SELECT transaction_timestamp()::text AS activated_at`);
    const activatedAt = (timestampResult.rows[0] as { activated_at?: string } | undefined)?.activated_at;
    if (!activatedAt) throw new StandingAutopayError("CONSENT_TIME_UNAVAILABLE", "The standing consent could not establish its activation boundary", 503);
    const [existing] = await tx.select().from(autopayConsents).where(and(eq(autopayConsents.organizationId, input.organizationId), eq(autopayConsents.leagueId, input.leagueId), eq(autopayConsents.payerBowlerId, input.payerBowlerId), eq(autopayConsents.state, "active"))).limit(1).for("update");
    if (!existing) await assertNoInitialDueNowInTransaction(tx, { organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerId: input.payerBowlerId, asOf: new Date(activatedAt).toISOString() });
    const consentFingerprint = digest(CONSENT_FP_PREFIX, { organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerId: input.payerBowlerId, paymentMode: "weekly", providerName, providerLocationId, sourceId, customerId, activatedAt, partners: links.map((link) => ({ bowlerAId: link.bowlerAId, bowlerBId: link.bowlerBId, id: link.id, fingerprint: linkFingerprint(link) })) });
    const nextVersion = (await tx.select({ max: sql<number>`COALESCE(MAX(${autopayConsents.consentVersion}), 0)` }).from(autopayConsents).where(and(eq(autopayConsents.organizationId, input.organizationId), eq(autopayConsents.leagueId, input.leagueId), eq(autopayConsents.payerBowlerId, input.payerBowlerId))))[0]?.max ?? 0;
    const replacementRevokedAt = new Date(activatedAt).toISOString();
    if (existing) await revokeConsentAndStopOperationsInTransaction(tx, { organizationId: input.organizationId, leagueId: input.leagueId, consent: existing, revokedAt: replacementRevokedAt });
    const [consent] = await tx.insert(autopayConsents).values({
      organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerId: input.payerBowlerId, consentVersion: Number(nextVersion) + 1, state: "active", paymentMode: "weekly", consentFingerprint,
      providerName, providerLocationId, encryptedSourceId: encrypt(sourceId), encryptedCustomerId: encrypt(customerId), createdByUserId: input.actorUserId, activatedAt,
    }).returning();
    if (!consent) throw new StandingAutopayError("CONSENT_WRITE_FAILED", "The standing consent could not be saved", 500);
    if (links.length > 0) await tx.insert(autopayConsentPartners).values(links.map((link) => ({ organizationId: input.organizationId, leagueId: input.leagueId, consentId: consent.id, consentVersion: consent.consentVersion, partnerBowlerId: link.bowlerAId === input.payerBowlerId ? link.bowlerBId : link.bowlerAId, paymentLinkId: link.id, linkFingerprint: linkFingerprint(link) })));
    const result = consentWire(consent, partnerIds, input.organizationId, input.leagueId, input.payerBowlerId);
    await applyCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, commandType: COMMAND_CONSENT, key: input.request.commandKey, result });
    return result;
  });
  await notifyStandingAutopayMutation();
  return result;
}

export async function revokeStandingAutopayConsent(input: { organizationId: number; leagueId: number; payerBowlerId: number; actorUserId: number; request: StandingAutopayRevokeRequest }) {
  if (!rosterStandingAutopayEnabled || scheduledPaymentExecutionMode !== "ledger_execute") throw new StandingAutopayError("STANDING_AUTOPAY_DISABLED", "Standing automatic payments are not enabled", 409);
  const fingerprint = digest("lvstandingrevoke:v1:", { leagueId: input.leagueId, payerBowlerId: input.payerBowlerId });
  const result = await db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    await leagueFor(tx, input.organizationId, input.leagueId);
    await beginCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, actorUserId: input.actorUserId, commandType: COMMAND_REVOKE, key: input.request.commandKey, fingerprint });
    const consent = await activeConsent(tx, { organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerId: input.payerBowlerId });
    const revokedAt = new Date().toISOString();
    const revokedConsent = consent ? await revokeConsentAndStopOperationsInTransaction(tx, { organizationId: input.organizationId, leagueId: input.leagueId, consent, revokedAt }) : undefined;
    const result = consentWire(revokedConsent, [], input.organizationId, input.leagueId, input.payerBowlerId);
    await applyCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, commandType: COMMAND_REVOKE, key: input.request.commandKey, result });
    return result;
  });
  await notifyStandingAutopayMutation();
  return result;
}

export async function quoteStandingAutopay(input: { organizationId: number; leagueId: number; payerBowlerId: number }): Promise<StandingAutopayQuoteWire> {
  if (!rosterStandingAutopayEnabled || scheduledPaymentExecutionMode !== "ledger_execute") throw new StandingAutopayError("STANDING_AUTOPAY_DISABLED", "Standing automatic payments are not enabled", 409);
  return db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    const league = await leagueFor(tx, input.organizationId, input.leagueId);
    const consent = await activeConsent(tx, { organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerId: input.payerBowlerId });
    if (!consent) throw new StandingAutopayError("CONSENT_NOT_ACTIVE", "Standing automatic payments are not active", 404);
    const adoption = await readOwnedLedgerAdoptionInTransaction(tx, { organizationId: input.organizationId, leagueId: input.leagueId });
    if (adoption) {
      const partners = await consentPartners(tx, { organizationId: input.organizationId, leagueId: input.leagueId, consentId: consent.id, consentVersion: consent.consentVersion, payerBowlerId: input.payerBowlerId });
      const recipientIds = [input.payerBowlerId, ...partners.map((row) => row.partnerBowlerId)];
      if (new Set(recipientIds).size !== recipientIds.length) throw new StandingAutopayError("PARTICIPANT_EVIDENCE_INVALID", "Standing recipient accounts must be unique");
      if (!(await activeMembership(tx, input.organizationId, input.leagueId, recipientIds))) throw new StandingAutopayError("BOWLER_NOT_IN_LEAGUE", "The standing payer is not an active league member", 403);
      const timestampResult = await tx.execute(sql`SELECT transaction_timestamp()::text AS as_of`);
      const asOfValue = (timestampResult as { rows?: Array<{ as_of?: unknown }> }).rows?.[0]?.as_of;
      if (typeof asOfValue !== "string" || !asOfValue) throw new StandingAutopayError("QUOTE_TIME_UNAVAILABLE", "The standing quote could not establish a database timestamp", 503);
      const asOf = iso(asOfValue);
      const activationAt = iso(consent.activatedAt);
      const [nextTrigger] = await tx.select({ id: leagueOccurrences.id, startAt: leagueOccurrences.startAt, currentRevision: leagueOccurrences.currentRevision })
        .from(leagueOccurrences).where(and(
          eq(leagueOccurrences.organizationId, input.organizationId),
          eq(leagueOccurrences.leagueId, input.leagueId),
          gte(leagueOccurrences.startAt, activationAt),
          gte(leagueOccurrences.startAt, asOf),
          sql`NOT EXISTS (
            SELECT 1
            FROM canonical_collection_group_members paired_member
            INNER JOIN canonical_collection_groups paired_group
              ON paired_group.id = paired_member.group_id
             AND paired_group.organization_id = paired_member.organization_id
             AND paired_group.league_id = paired_member.league_id
            WHERE paired_member.organization_id = ${input.organizationId}
              AND paired_member.league_id = ${input.leagueId}
              AND paired_member.occurrence_id = ${leagueOccurrences.id}
              AND paired_member.role = 'paired'
              AND paired_member.active = true
              AND paired_group.state = 'published'
          )`,
        )).orderBy(asc(leagueOccurrences.startAt), asc(leagueOccurrences.id)).limit(1);
      if (!nextTrigger) {
        return {
          contractVersion: "standing-autopay-quote/1" as const,
          organizationId: input.organizationId,
          leagueId: input.leagueId,
          consentId: consent.id,
          consentVersion: consent.consentVersion,
          cutoffAt: null,
          collectionMode: null,
          amountMinor: 0,
          obligations: [],
          fingerprint: digest("lvstandingquote:v1:", { consentId: consent.id, consentVersion: consent.consentVersion, noUpcomingTrigger: true }),
        };
      }
      const cutoffAt = iso(nextTrigger.startAt);
      const group = await groupForCutoff(tx, { organizationId: input.organizationId, leagueId: input.leagueId, cutoffAt });
      if (group.suppressed) {
        return {
          contractVersion: "standing-autopay-quote/1" as const,
          organizationId: input.organizationId,
          leagueId: input.leagueId,
          consentId: consent.id,
          consentVersion: consent.consentVersion,
          cutoffAt: null,
          collectionMode: null,
          amountMinor: 0,
          obligations: [],
          fingerprint: digest("lvstandingquote:v1:", { consentId: consent.id, consentVersion: consent.consentVersion, suppressedOccurrenceId: group.triggerOccurrenceId }),
        };
      }
      const collectionRequirementOccurrenceIds = await retainedStandingRequirementOccurrenceIdsInTransaction(
        tx,
        { organizationId: input.organizationId, leagueId: input.leagueId, consentId: consent.id, consentVersion: consent.consentVersion, cutoffAt },
        adoption,
        group.occurrenceIds,
      );
      const holds = await pendingRefundPayerWeekKeys(tx, {
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        payerBowlerIds: recipientIds,
        occurrenceIds: collectionRequirementOccurrenceIds,
      });
      const targetEvidenceByRecipient = await readOwnedAccountFundingTargetEvidenceInTransaction(tx, {
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        recipientIds,
        asOf: cutoffAt,
        collectionRequirementOccurrenceIdsByRecipient: new Map(recipientIds.map((bowlerId) => [bowlerId, collectionRequirementOccurrenceIds])),
      });
      const amountMinor = holds.size > 0 ? 0 : recipientIds.reduce((sum, bowlerId) => {
        const target = targetEvidenceByRecipient.get(bowlerId)?.scopedTarget;
        if (!target) throw new StandingAutopayError("ACCOUNT_TARGET_MISSING", "A standing account target is unavailable", 503);
        return sum + target.newChargeMinor;
      }, 0);
      return {
        contractVersion: "standing-autopay-quote/1" as const,
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        consentId: consent.id,
        consentVersion: consent.consentVersion,
        cutoffAt,
        collectionMode: group.mode,
        amountMinor,
        obligations: [],
        fingerprint: digest("lvstandingquote:v1:", {
          consentId: consent.id,
          consentVersion: consent.consentVersion,
          cutoffAt,
          group: { id: group.groupId, revision: group.groupRevision, fingerprint: group.groupFingerprint, occurrenceIds: group.occurrenceIds },
          collectionRequirementOccurrenceIds,
          targets: recipientIds.map((bowlerId) => [bowlerId, targetEvidenceByRecipient.get(bowlerId)?.scopedTarget]),
          blockedByRefundHold: holds.size > 0,
        }),
      };
    }
    await assertNotActiveRotatingPoolMemberForStandingAutopay(tx, { organizationId: input.organizationId, leagueId: input.leagueId, bowlerId: input.payerBowlerId });
    const partners = await consentPartners(tx, { organizationId: input.organizationId, leagueId: input.leagueId, consentId: consent.id, consentVersion: consent.consentVersion, payerBowlerId: input.payerBowlerId });
    const payerIds = [input.payerBowlerId, ...partners.map((row) => row.partnerBowlerId)];
    if (!(await activeMembership(tx, input.organizationId, input.leagueId, payerIds))) throw new StandingAutopayError("BOWLER_NOT_IN_LEAGUE", "The standing payer is not an active league member", 403);
    const timestampResult = await tx.execute(sql`SELECT transaction_timestamp()::text AS as_of`);
    const asOf = (timestampResult.rows[0] as { as_of?: string } | undefined)?.as_of;
    if (!asOf) throw new StandingAutopayError("QUOTE_TIME_UNAVAILABLE", "The standing quote could not establish a database timestamp", 503);
    const activationAt = new Date(consent.activatedAt).toISOString();
    const [next] = await tx.select({ dueAt: paymentObligations.dueAt }).from(paymentObligations).innerJoin(occurrencePaymentResponsibilities, and(
      eq(paymentObligations.responsibilityId, occurrencePaymentResponsibilities.id), eq(occurrencePaymentResponsibilities.organizationId, input.organizationId), eq(occurrencePaymentResponsibilities.leagueId, input.leagueId), eq(occurrencePaymentResponsibilities.state, "active"),
    )).where(and(eq(paymentObligations.organizationId, input.organizationId), eq(paymentObligations.leagueId, input.leagueId), inArray(paymentObligations.payerBowlerId, payerIds), currentBowlerOwnerPredicate({ organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerIds: payerIds }), inArray(paymentObligations.state, ["open", "partially_settled"] as const), gte(paymentObligations.dueAt, activationAt), gte(paymentObligations.dueAt, new Date(asOf).toISOString()), sql`NOT EXISTS (
      SELECT 1
        FROM canonical_collection_group_members paired_member
        INNER JOIN canonical_collection_groups paired_group
          ON paired_group.id = paired_member.group_id
         AND paired_group.organization_id = paired_member.organization_id
         AND paired_group.league_id = paired_member.league_id
       WHERE paired_member.organization_id = ${input.organizationId}
         AND paired_member.league_id = ${input.leagueId}
         AND paired_member.occurrence_id = ${paymentObligations.occurrenceId}
         AND paired_member.role = 'paired'
         AND paired_member.active = true
         AND paired_group.state = 'published'
    )`)).orderBy(asc(paymentObligations.dueAt)).limit(1);
    const cutoffAt = next?.dueAt ?? null;
    if (cutoffAt) await assertNoStandingArrears(tx, { organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerIds: payerIds, activationAt, cutoffAt: new Date(cutoffAt).toISOString() });
    const group = cutoffAt ? await groupForCutoff(tx, { organizationId: input.organizationId, leagueId: input.leagueId, cutoffAt }) : { mode: "weekly" as const, groupId: null, groupRevision: null, groupFingerprint: null, triggerOccurrenceId: "", triggerOccurrenceRevision: 0, pairedOccurrenceId: null, triggerMemberId: null, pairedMemberId: null, occurrenceIds: [] };
    if (group.suppressed) {
      return { contractVersion: "standing-autopay-quote/1" as const, organizationId: input.organizationId, leagueId: input.leagueId, consentId: consent.id, consentVersion: consent.consentVersion, cutoffAt: null, collectionMode: null, amountMinor: 0, obligations: [], fingerprint: digest("lvstandingquote:v1:", { consentId: consent.id, consentVersion: consent.consentVersion, suppressedOccurrenceId: group.triggerOccurrenceId }) };
    }
    const triggerRows = cutoffAt ? await eligibleRows(tx, { organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerIds: payerIds, activationAt, cutoffAt, dueMode: "exact", occurrenceIds: [group.triggerOccurrenceId] }) : [];
    const pairedRows = cutoffAt && group.mode === "double_pay" && group.pairedOccurrenceId ? await eligibleRows(tx, { organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerIds: payerIds, activationAt, cutoffAt, dueMode: "paired", occurrenceIds: [group.pairedOccurrenceId] }) : [];
    const rows = [...triggerRows, ...pairedRows];
    if (group.mode === "double_pay" && group.occurrenceIds.some((occurrenceId) => payerIds.some((payerBowlerId) => !rows.some((row) => row.obligation.occurrenceId === occurrenceId && row.obligation.payerBowlerId === payerBowlerId)))) throw new StandingAutopayError("DOUBLE_PAY_INCOMPLETE", "The complete double-pay group is not eligible at its trigger cutoff", 409);
    const amountMinor = rows.reduce((sum, row) => sum + row.outstandingMinor, 0);
    const result = { contractVersion: "standing-autopay-quote/1" as const, organizationId: input.organizationId, leagueId: input.leagueId, consentId: consent.id, consentVersion: consent.consentVersion, cutoffAt, collectionMode: rows.length ? group.mode : null, amountMinor, obligations: rows.map((row) => {
      if (row.obligation.payerBowlerId === null) throw new StandingAutopayError("OWNER_EVIDENCE_INVALID", "A standing payment candidate has no historical payer", 503);
      return { obligationId: row.obligation.id, occurrenceId: row.obligation.occurrenceId, payerBowlerId: row.obligation.payerBowlerId, amountMinor: row.obligation.amountMinor, outstandingMinor: row.outstandingMinor, dueAt: row.obligation.dueAt, collectionGroupId: group.groupId };
    }), fingerprint: digest("lvstandingquote:v1:", { consentId: consent.id, consentVersion: consent.consentVersion, cutoffAt, groupId: group.groupId, rows: rows.map((row) => [row.obligation.id, row.outstandingMinor]) }) };
    void league;
    return result;
  });
}

export async function prepareStandingAutopayCutoff(input: { organizationId: number; leagueId: number; consentId: string; cutoffAt: string | Date; now?: Date }): Promise<PaymentOperation | undefined> {
  if (!rosterStandingAutopayEnabled || scheduledPaymentExecutionMode !== "ledger_execute") return undefined;
  const cutoffAt = iso(input.cutoffAt);
  const result = await db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    await leagueFor(tx, input.organizationId, input.leagueId);
    const consent = await activeConsent(tx, { organizationId: input.organizationId, leagueId: input.leagueId, consentId: input.consentId });
    if (!consent) return undefined;
    const adoption = await readOwnedLedgerAdoptionInTransaction(tx, { organizationId: input.organizationId, leagueId: input.leagueId });
    if (adoption) {
      const [payerUser] = await tx.select({ id: users.id }).from(users).where(and(
        eq(users.organizationId, input.organizationId),
        eq(users.bowlerId, consent.payerBowlerId),
      )).limit(1);
      if (!payerUser) throw new StandingAutopayError("PAYER_ACCOUNT_REQUIRED", "The standing payer account is unavailable", 403);
      const timestampResult = await tx.execute(sql`SELECT transaction_timestamp()::text AS now`);
      const databaseNow = (timestampResult as { rows?: Array<{ now?: unknown }> }).rows?.[0]?.now;
      if (typeof databaseNow !== "string" || !databaseNow) throw new StandingAutopayError("CUTOFF_TIME_UNAVAILABLE", "The standing cutoff could not establish transaction time", 503);
      return prepareAccountStandingAutopayCutoffInTransaction(tx, {
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        consent,
        cutoffAt,
        now: input.now ? iso(input.now) : iso(databaseNow),
        adoption,
        payerUserId: payerUser.id,
      });
    }
    await assertNotActiveRotatingPoolMemberForStandingAutopay(tx, { organizationId: input.organizationId, leagueId: input.leagueId, bowlerId: consent.payerBowlerId });
    const partners = await consentPartners(tx, { organizationId: input.organizationId, leagueId: input.leagueId, consentId: consent.id, consentVersion: consent.consentVersion, payerBowlerId: consent.payerBowlerId });
    const payerIds = [consent.payerBowlerId, ...partners.map((row) => row.partnerBowlerId)];
    if (!(await activeMembership(tx, input.organizationId, input.leagueId, payerIds))) throw new StandingAutopayError("BOWLER_NOT_IN_LEAGUE", "A standing payer is no longer active in the league", 409);
    const activationAt = new Date(consent.activatedAt).toISOString();
    const group = await groupForCutoff(tx, { organizationId: input.organizationId, leagueId: input.leagueId, cutoffAt });
    await assertNoStandingArrears(tx, { organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerIds: payerIds, activationAt, cutoffAt });
    if (group.suppressed) {
      const key = `${consent.id}:${consent.consentVersion}:${cutoffAt}:${group.triggerOccurrenceRevision}`;
      const fp = digest(CUTOFF_FP_PREFIX, { consentId: consent.id, consentVersion: consent.consentVersion, cutoffAt, blocked: "paired_occurrence_requires_trigger", pairedOccurrenceId: group.triggerOccurrenceId, pairedMemberId: group.pairedMemberId });
      const [payerUser] = await tx.select({ id: users.id }).from(users).where(and(eq(users.organizationId, input.organizationId), eq(users.bowlerId, consent.payerBowlerId))).limit(1);
      if (!payerUser) throw new StandingAutopayError("PAYER_ACCOUNT_REQUIRED", "The standing payer account is unavailable", 403);
      try { await beginCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, actorUserId: payerUser.id, commandType: COMMAND_CUTOFF, key, fingerprint: fp }); } catch (error) { if (!(error instanceof StandingAutopayReplay)) throw error; return undefined; }
      await applyCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, commandType: COMMAND_CUTOFF, key, result: { kind: "blocked", reason: "paired_occurrence_requires_trigger", cutoffAt, consentId: consent.id, pairedOccurrenceId: group.triggerOccurrenceId } });
      return undefined;
    }
    // A refund provider outcome is not a balance decision. While it is still
    // unresolved, keep only this exact payer/week out of standing dispatch;
    // a failed/canceled refund becomes discoverable again automatically.
    if ((await pendingRefundPayerWeekKeys(tx, {
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      payerBowlerIds: payerIds,
      occurrenceIds: group.occurrenceIds,
    })).size > 0) return undefined;
    const triggerRows = await eligibleRows(tx, { organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerIds: payerIds, activationAt, cutoffAt, dueMode: "exact", occurrenceIds: [group.triggerOccurrenceId] });
    const pairedRows = group.mode === "double_pay" && group.pairedOccurrenceId ? await eligibleRows(tx, { organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerIds: payerIds, activationAt, cutoffAt, dueMode: "paired", occurrenceIds: [group.pairedOccurrenceId] }) : [];
    const rows = [...triggerRows, ...pairedRows];
    const commandKey = `${consent.id}:${consent.consentVersion}:${cutoffAt}:${group.triggerOccurrenceRevision}`;
    if (await hasOpenReservedObligations(tx, { organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerIds: payerIds, activationAt, cutoffAt, dueMode: group.mode === "double_pay" ? "paired" : "exact", occurrenceIds: group.occurrenceIds })) {
      const [decided] = await tx.select().from(financialCommands).where(and(
        eq(financialCommands.organizationId, input.organizationId),
        eq(financialCommands.leagueId, input.leagueId),
        eq(financialCommands.commandType, COMMAND_CUTOFF),
        eq(financialCommands.idempotencyKey, commandKey),
      )).limit(1).for("share");
      if (decided?.state === "applied" && decided.result && typeof decided.result === "object" && "operationId" in decided.result && typeof decided.result.operationId === "string") {
        const [replayed] = await tx.select().from(paymentOperations).where(and(eq(paymentOperations.organizationId, input.organizationId), eq(paymentOperations.leagueId, input.leagueId), eq(paymentOperations.id, decided.result.operationId), eq(paymentOperations.operationType, "standing_autopay_charge"))).limit(1).for("share");
        return replayed;
      }
      return undefined;
    }
    const doublePayIncomplete = group.mode === "double_pay" && group.occurrenceIds.some((occurrenceId) => payerIds.some((payerBowlerId) => !rows.some((row) => row.obligation.occurrenceId === occurrenceId && row.obligation.payerBowlerId === payerBowlerId)));
    if (doublePayIncomplete) {
      const key = commandKey;
      const fp = digest(CUTOFF_FP_PREFIX, { consentId: consent.id, consentVersion: consent.consentVersion, cutoffAt, blocked: "double_pay_incomplete", groupId: group.groupId });
      const [payerUser] = await tx.select({ id: users.id }).from(users).where(and(eq(users.organizationId, input.organizationId), eq(users.bowlerId, consent.payerBowlerId))).limit(1);
      if (!payerUser) throw new StandingAutopayError("PAYER_ACCOUNT_REQUIRED", "The standing payer account is unavailable", 403);
      try { await beginCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, actorUserId: payerUser.id, commandType: COMMAND_CUTOFF, key, fingerprint: fp }); } catch (error) { if (!(error instanceof StandingAutopayReplay)) throw error; return undefined; }
      await applyCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, commandType: COMMAND_CUTOFF, key, result: { kind: "blocked", reason: "double_pay_incomplete", cutoffAt, consentId: consent.id } });
      return undefined;
    }
    if (rows.length === 0) {
      const key = commandKey;
      const fp = digest(CUTOFF_FP_PREFIX, { consentId: consent.id, consentVersion: consent.consentVersion, cutoffAt, empty: true });
      const [user] = await tx.select({ id: users.id }).from(users).where(and(eq(users.organizationId, input.organizationId), eq(users.bowlerId, consent.payerBowlerId))).limit(1);
      if (!user) throw new StandingAutopayError("PAYER_ACCOUNT_REQUIRED", "The standing payer account is unavailable", 403);
      // A replay of a successful cutoff sees its rows reserved and therefore
      // has no eligible rows on the second pass. Return the exact durable
      // operation instead of comparing the replay against the empty/no-op
      // fingerprint.
      const [existingCutoff] = await tx.select().from(financialCommands).where(and(
        eq(financialCommands.organizationId, input.organizationId),
        eq(financialCommands.leagueId, input.leagueId),
        eq(financialCommands.commandType, COMMAND_CUTOFF),
        eq(financialCommands.idempotencyKey, key),
      )).limit(1).for("share");
      if (existingCutoff?.state === "applied" && existingCutoff.result && typeof existingCutoff.result === "object") {
        const replay = existingCutoff.result as { operationId?: unknown };
        if (existingCutoff.actorUserId !== user.id) throw new StandingAutopayError("IDEMPOTENCY_CONFLICT", "The standing command identity does not match the original request");
        if (typeof replay.operationId === "string") {
          const [replayedOperation] = await tx.select().from(paymentOperations).where(and(
            eq(paymentOperations.organizationId, input.organizationId),
            eq(paymentOperations.leagueId, input.leagueId),
            eq(paymentOperations.id, replay.operationId),
            eq(paymentOperations.operationType, "standing_autopay_charge"),
          )).limit(1).for("share");
          return replayedOperation;
        }
        return undefined;
      }
      try { await beginCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, actorUserId: user.id, commandType: COMMAND_CUTOFF, key, fingerprint: fp }); } catch (error) { if (!(error instanceof StandingAutopayReplay)) throw error; return undefined; }
      await applyCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, commandType: COMMAND_CUTOFF, key, result: { kind: "no_op", cutoffAt, consentId: consent.id } });
      return undefined;
    }
    const now = input.now ?? new Date();
    const [payerUser] = await tx.select({ id: users.id }).from(users).where(and(eq(users.organizationId, input.organizationId), eq(users.bowlerId, consent.payerBowlerId))).limit(1);
    if (!payerUser) throw new StandingAutopayError("PAYER_ACCOUNT_REQUIRED", "The standing payer account is unavailable", 403);
    const amountMinor = rows.reduce((sum, row) => sum + row.outstandingMinor, 0);
    // Keep the durable target within the ledger's 128-byte identity limit
    // while retaining every group identity component in the fingerprint. A
    // raw UUID + collection fingerprint tuple would exceed that limit.
    const groupIdentity = digest("lvstandinggroup:v1:", {
      groupId: group.groupId,
      triggerOccurrenceId: group.triggerOccurrenceId,
      pairedOccurrenceId: group.pairedOccurrenceId,
      groupRevision: group.groupRevision,
      groupFingerprint: group.groupFingerprint,
    });
    const targetIdentity = digest("lvstandingtarget:v1:", {
      consentId: consent.id,
      consentVersion: consent.consentVersion,
      cutoffAt,
      triggerOccurrenceId: group.triggerOccurrenceId,
      groupIdentity,
    });
    // Keep the durable ledger key below its 128-byte limit even for maximum
    // tenant/league/bowler identifiers. The digest commits the tenant, league,
    // payer, cutoff, consent version, and exact collection-group identity.
    // Keep the occurrence revision as a readable final component so wake
    // discovery can distinguish an old canceled decision from a restored
    // occurrence without reimplementing the application digest in SQL.
    const targetKey = `standing-autopay:${targetIdentity}:${group.triggerOccurrenceRevision}`;
    const identity = buildPaymentOperationIdentity({ organizationId: input.organizationId, operationType: "standing_autopay_charge", targetKey, amountMinor, currency: "USD", providerName: consent.providerName ?? "square" });
    const evidenceFingerprint = digest(CUTOFF_FP_PREFIX, { consentId: consent.id, consentVersion: consent.consentVersion, cutoffAt, mode: group.mode, groupId: group.groupId, groupOccurrenceIds: group.occurrenceIds, obligations: rows.map((row) => ({ id: row.obligation.id, responsibilityId: row.obligation.responsibilityId, responsibilityVersion: row.responsibilityVersion, occurrenceId: row.obligation.occurrenceId, amountMinor: row.outstandingMinor, dueAt: row.obligation.dueAt, payerBowlerId: row.obligation.payerBowlerId })), partners: partners.map((row) => ({ partnerBowlerId: row.partnerBowlerId, paymentLinkId: row.paymentLinkId, linkFingerprint: row.linkFingerprint })) });
    try {
      await beginCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, actorUserId: payerUser.id, commandType: COMMAND_CUTOFF, key: commandKey, fingerprint: evidenceFingerprint });
    } catch (error) {
      if (!(error instanceof StandingAutopayReplay)) throw error;
      const replay = error.result as { operationId?: unknown };
      if (typeof replay.operationId !== "string") return undefined;
      const [replayed] = await tx.select().from(paymentOperations).where(and(eq(paymentOperations.organizationId, input.organizationId), eq(paymentOperations.leagueId, input.leagueId), eq(paymentOperations.id, replay.operationId), eq(paymentOperations.operationType, "standing_autopay_charge"))).limit(1).for("share");
      return replayed;
    }
    const [existing] = await tx.select().from(paymentOperations).where(and(eq(paymentOperations.organizationId, input.organizationId), eq(paymentOperations.targetKey, targetKey), eq(paymentOperations.operationType, "standing_autopay_charge"))).limit(1).for("update");
    if (existing) { await applyCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, commandType: COMMAND_CUTOFF, key: commandKey, result: { operationId: existing.id, status: existing.status, cutoffAt } }); return existing; }
    const [operation] = await tx.insert(paymentOperations).values({
      organizationId: input.organizationId, authorizingUserId: payerUser.id, operationType: "standing_autopay_charge", targetKey, triggerOccurrenceId: group.triggerOccurrenceId, leagueId: input.leagueId, amountMinor, currency: "USD", requestFingerprint: identity.requestFingerprint, providerIdempotencyKey: identity.providerIdempotencyKey, providerName: consent.providerName ?? "square", status: "pending", nextAttemptAt: now.toISOString(), createdAt: now.toISOString(), updatedAt: now.toISOString(), attemptCount: 0,
    }).returning();
    if (!operation) throw new StandingAutopayError("OPERATION_WRITE_FAILED", "The standing payment operation could not be created", 500);
    const snapshotRows = rows.map((row, index) => {
      if (row.obligation.payerBowlerId === null) throw new StandingAutopayError("OWNER_EVIDENCE_INVALID", "A standing payment candidate has no historical payer", 503);
      return { allocationIndex: index, obligationId: row.obligation.id, amountMinor: row.outstandingMinor, occurrenceId: row.obligation.occurrenceId, responsibilityId: row.obligation.responsibilityId, responsibilityVersion: row.responsibilityVersion, payerBowlerId: row.obligation.payerBowlerId, dueAt: row.obligation.dueAt };
    });
    await tx.insert(paymentOperationRosterSnapshots).values({ operationId: operation.id, organizationId: input.organizationId, leagueId: input.leagueId, snapshotVersion: 2, snapshotKind: "standing_autopay", collectionMode: group.mode, cutoffAt, amountMinor, currency: "USD", obligations: snapshotRows, snapshotFingerprint: evidenceFingerprint });
    await tx.insert(paymentOperationStandingAutopayBindings).values({ operationId: operation.id, organizationId: input.organizationId, leagueId: input.leagueId, consentId: consent.id, consentVersion: consent.consentVersion, providerName: consent.providerName ?? "square", providerLocationId: consent.providerLocationId ?? "", triggerOccurrenceId: group.triggerOccurrenceId, pairedOccurrenceId: group.pairedOccurrenceId, collectionGroupId: group.groupId, collectionGroupRevision: group.groupRevision, collectionGroupFingerprint: group.groupFingerprint, triggerMemberId: group.triggerMemberId, pairedMemberId: group.pairedMemberId, cutoffAt, collectionMode: group.mode, evidenceFingerprint });
    await tx.insert(paymentOperationRosterSnapshotItems).values(snapshotRows.map((row) => ({ operationId: operation.id, organizationId: input.organizationId, leagueId: input.leagueId, obligationId: row.obligationId, allocationIndex: row.allocationIndex, amountMinor: row.amountMinor, state: "reserved" as const })));
    await tx.insert(paymentOperationStandingAutopayParticipants).values(snapshotRows.map((row) => {
      const partner = partners.find((candidate) => candidate.partnerBowlerId === row.payerBowlerId);
      return { operationId: operation.id, organizationId: input.organizationId, leagueId: input.leagueId, allocationIndex: row.allocationIndex, obligationId: row.obligationId, bowlerId: row.payerBowlerId, role: partner ? "partner" as const : "payer" as const, paymentLinkId: partner?.paymentLinkId ?? null, linkFingerprint: partner?.linkFingerprint ?? null, consentVersion: consent.consentVersion };
    }));
    await applyCommand(tx, { organizationId: input.organizationId, leagueId: input.leagueId, commandType: COMMAND_CUTOFF, key: commandKey, result: { operationId: operation.id, status: operation.status, cutoffAt, amountMinor } });
    return operation;
  });
  await notifyStandingAutopayMutation();
  return result;
}

export async function getStandingAutopayExecutionSnapshot(input: { organizationId: number; operationId: string }) {
  const [row] = await db.select({
    operation: paymentOperations,
    binding: paymentOperationStandingAutopayBindings,
    rosterSnapshot: paymentOperationRosterSnapshots,
    accountSnapshot: accountPaymentOperationSnapshots,
    consent: autopayConsents,
    locationId: leagues.locationId,
  }).from(paymentOperations)
    .innerJoin(paymentOperationStandingAutopayBindings, and(
      eq(paymentOperationStandingAutopayBindings.operationId, paymentOperations.id),
      eq(paymentOperationStandingAutopayBindings.organizationId, input.organizationId),
      eq(paymentOperationStandingAutopayBindings.leagueId, paymentOperations.leagueId),
    ))
    .leftJoin(paymentOperationRosterSnapshots, and(
      eq(paymentOperationRosterSnapshots.operationId, paymentOperations.id),
      eq(paymentOperationRosterSnapshots.organizationId, input.organizationId),
      eq(paymentOperationRosterSnapshots.leagueId, paymentOperations.leagueId),
    ))
    .leftJoin(accountPaymentOperationSnapshots, and(
      eq(accountPaymentOperationSnapshots.operationId, paymentOperations.id),
      eq(accountPaymentOperationSnapshots.organizationId, input.organizationId),
      eq(accountPaymentOperationSnapshots.leagueId, paymentOperations.leagueId),
    ))
    .innerJoin(autopayConsents, and(
      eq(autopayConsents.id, paymentOperationStandingAutopayBindings.consentId),
      eq(autopayConsents.organizationId, input.organizationId),
      eq(autopayConsents.leagueId, paymentOperations.leagueId),
    ))
    .innerJoin(leagues, and(eq(leagues.id, paymentOperations.leagueId), eq(leagues.organizationId, input.organizationId)))
    .where(and(eq(paymentOperations.organizationId, input.organizationId), eq(paymentOperations.id, input.operationId), eq(paymentOperations.operationType, "standing_autopay_charge")))
    .limit(1);
  if (!row) return undefined;
  if (row.rosterSnapshot && row.accountSnapshot) throw new StandingAutopayError("SNAPSHOT_CONFLICT", "The standing operation has conflicting immutable snapshots", 409);
  if (!row.rosterSnapshot && !row.accountSnapshot) return undefined;
  if (row.accountSnapshot) {
    if (row.accountSnapshot.snapshotKind !== "standing_funding") throw new StandingAutopayError("SNAPSHOT_INVALID", "The account standing snapshot is unsupported", 409);
    const [rotatingSnapshot] = await db.select({ operationId: rotatingCreditPaymentOperationSnapshots.operationId })
      .from(rotatingCreditPaymentOperationSnapshots).where(and(
        eq(rotatingCreditPaymentOperationSnapshots.operationId, input.operationId),
        eq(rotatingCreditPaymentOperationSnapshots.organizationId, input.organizationId),
        eq(rotatingCreditPaymentOperationSnapshots.leagueId, row.operation.leagueId ?? -1),
      )).limit(1);
    const [rosterItems] = await db.select({ id: paymentOperationRosterSnapshotItems.id }).from(paymentOperationRosterSnapshotItems).where(and(
      eq(paymentOperationRosterSnapshotItems.operationId, input.operationId),
      eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId),
      eq(paymentOperationRosterSnapshotItems.leagueId, row.operation.leagueId ?? -1),
    )).limit(1);
    const [participants] = await db.select({ operationId: paymentOperationStandingAutopayParticipants.operationId }).from(paymentOperationStandingAutopayParticipants).where(and(
      eq(paymentOperationStandingAutopayParticipants.operationId, input.operationId),
      eq(paymentOperationStandingAutopayParticipants.organizationId, input.organizationId),
      eq(paymentOperationStandingAutopayParticipants.leagueId, row.operation.leagueId ?? -1),
    )).limit(1);
    if (rotatingSnapshot || rosterItems || participants) throw new StandingAutopayError("SNAPSHOT_CONFLICT", "The standing account operation has legacy allocation evidence", 409);
    let snapshot;
    try { snapshot = reconstructAccountStandingFundingSnapshot({ operation: row.operation, stored: row.accountSnapshot }); }
    catch { throw new StandingAutopayError("SNAPSHOT_INVALID", "The account standing snapshot failed immutable validation", 409); }
    if (snapshot.standingEvidence.bindingEvidenceFingerprint !== row.binding.evidenceFingerprint
      || snapshot.standingEvidence.consentId !== row.binding.consentId
      || snapshot.standingEvidence.consentVersion !== row.binding.consentVersion
      || row.consent.id !== snapshot.standingEvidence.consentId
      || row.consent.consentVersion !== snapshot.standingEvidence.consentVersion
      || row.consent.payerBowlerId !== snapshot.payerBowlerId
      || row.consent.consentFingerprint !== snapshot.standingEvidence.consentFingerprint
      || row.consent.providerName !== snapshot.providerName
      || row.consent.providerLocationId !== snapshot.providerLocationId
      || !sameInstant(snapshot.standingEvidence.cutoffAt, row.binding.cutoffAt)) {
      throw new StandingAutopayError("SNAPSHOT_INVALID", "The account standing snapshot does not match its binding", 409);
    }
    return {
      operation: row.operation,
      binding: row.binding,
      snapshot,
      consent: row.consent,
      locationId: row.locationId,
      items: [] as Array<{ item: typeof paymentOperationRosterSnapshotItems.$inferSelect; obligation: typeof paymentObligations.$inferSelect }>,
      sourceId: decrypt(row.consent.encryptedSourceId ?? ""),
      customerId: decrypt(row.consent.encryptedCustomerId ?? ""),
      accountFunding: true as const,
    };
  }
  const rosterSnapshot = row.rosterSnapshot;
  if (!rosterSnapshot || rosterSnapshot.snapshotKind !== "standing_autopay") throw new StandingAutopayError("SNAPSHOT_INVALID", "The roster standing snapshot kind is unsupported", 409);
  const items = await db.select({ item: paymentOperationRosterSnapshotItems, obligation: paymentObligations }).from(paymentOperationRosterSnapshotItems).innerJoin(paymentObligations, and(eq(paymentObligations.id, paymentOperationRosterSnapshotItems.obligationId), eq(paymentObligations.organizationId, input.organizationId))).where(and(eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId), eq(paymentOperationRosterSnapshotItems.operationId, input.operationId))).orderBy(asc(paymentOperationRosterSnapshotItems.allocationIndex));
  return { operation: row.operation, binding: row.binding, snapshot: rosterSnapshot, consent: row.consent, locationId: row.locationId, items, sourceId: decrypt(row.consent.encryptedSourceId ?? ""), customerId: decrypt(row.consent.encryptedCustomerId ?? ""), accountFunding: false as const };
}

export async function standingPaymentRows(input: { organizationId: number; operationId: string; providerPaymentId: string; providerName: string; actorUserId: number | null; receiptUrl?: string | null; receiptNumber?: string | null }) {
  const snapshot = await getStandingAutopayExecutionSnapshot(input);
  if (!snapshot) throw new StandingAutopayError("SNAPSHOT_NOT_FOUND", "The standing operation snapshot is unavailable", 409);
  if (snapshot.accountFunding) {
    return [{ allocationIndex: 0, values: { organizationId: input.organizationId, bowlerId: snapshot.consent.payerBowlerId, leagueId: snapshot.operation.leagueId ?? snapshot.binding.leagueId, amount: snapshot.operation.amountMinor, status: "paid" as const, type: providerNameToPaymentType(snapshot.operation.providerName), providerPaymentId: input.providerPaymentId, receiptUrl: input.receiptUrl ?? undefined, receiptNumber: input.receiptNumber ?? undefined, receiptEmailMissing: false, paidByUserId: input.actorUserId, notes: "Standing account funding" } }];
  }
  const first = snapshot.items[0];
  if (!first) return [];
  return [{ allocationIndex: 0, values: { organizationId: input.organizationId, bowlerId: snapshot.consent.payerBowlerId, leagueId: snapshot.operation.leagueId ?? snapshot.binding.leagueId, amount: snapshot.operation.amountMinor, status: "paid" as const, type: snapshot.operation.providerName === "square" ? "square" as const : "credit_card" as const, providerPaymentId: input.providerPaymentId, receiptUrl: input.receiptUrl ?? undefined, receiptNumber: input.receiptNumber ?? undefined, receiptEmailMissing: false, paidByUserId: input.actorUserId, notes: "Roster standing automatic payment" } }];
}

/**
 * Recheck the whole payer/week hold immediately before standing provider I/O.
 * A still-owed refund can have its source component settled by a later manual
 * repayment while a sibling component remains unpaid; therefore the marker
 * must be resolved across every obligation for that exact payer and
 * occurrence, not from the reserved snapshot rows alone.
 */
async function validateStandingRefundHoldsForDispatchInTransaction(
  tx: StandingTx,
  input: { organizationId: number; leagueId: number; operationId: string },
): Promise<void> {
  const snapshotRows = await tx.select({ obligationId: paymentOperationRosterSnapshotItems.obligationId })
    .from(paymentOperationRosterSnapshotItems)
    .where(and(
      eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId),
      eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId),
      eq(paymentOperationRosterSnapshotItems.operationId, input.operationId),
    ));
  if (snapshotRows.length === 0) throw new StandingAutopayError("SNAPSHOT_INVALID", "The standing operation snapshot is unavailable");
  const reservedObligations = await tx.select().from(paymentObligations)
    .where(and(
      eq(paymentObligations.organizationId, input.organizationId),
      eq(paymentObligations.leagueId, input.leagueId),
      inArray(paymentObligations.id, snapshotRows.map((row) => row.obligationId)),
    ));
  if (reservedObligations.some((row) => row.payerBowlerId === null)) throw new StandingAutopayError("SNAPSHOT_INVALID", "The standing operation references team-owned liability", 409);
  const owners = await resolvePaymentObligationOwnersInTransaction(tx, {
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    obligations: reservedObligations,
  });
  if (reservedObligations.some((row) => {
    const owner = owners.get(row.id);
    return owner?.kind !== "bowler" || owner.bowlerId !== row.payerBowlerId;
  })) throw new StandingAutopayError("SNAPSHOT_INVALID", "The standing operation no longer references fixed bowler-owned liability", 409);
  const payerIds = [...new Set(reservedObligations.flatMap((row) => row.payerBowlerId === null ? [] : [row.payerBowlerId]))];
  const occurrenceIds = [...new Set(reservedObligations.map((row) => row.occurrenceId))];
  if (payerIds.length === 0 || occurrenceIds.length === 0) throw new StandingAutopayError("SNAPSHOT_INVALID", "The standing operation snapshot references no obligations");
  if ((await pendingRefundPayerWeekKeys(tx, {
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    payerBowlerIds: payerIds,
    occurrenceIds,
  })).size > 0) {
    throw new StandingAutopayError("REFUND_OUTCOME_UNRESOLVED", "Standing automatic payment is blocked until the affected refund provider outcome is resolved", 409);
  }
  const allObligations = await tx.select({ obligation: paymentObligations }).from(paymentObligations).where(and(
    eq(paymentObligations.organizationId, input.organizationId),
    eq(paymentObligations.leagueId, input.leagueId),
    inArray(paymentObligations.payerBowlerId, payerIds),
    currentBowlerOwnerPredicate({ organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerIds: payerIds }),
    inArray(paymentObligations.occurrenceId, occurrenceIds),
  ));
  const allObligationIds = allObligations.map((row) => row.obligation.id);
  const allocations = allObligationIds.length === 0 ? [] : await tx.select({ id: paymentAllocations.id, obligationId: paymentAllocations.obligationId, amountMinor: paymentAllocations.amountMinor })
    .from(paymentAllocations)
    .where(and(
      eq(paymentAllocations.organizationId, input.organizationId),
      eq(paymentAllocations.leagueId, input.leagueId),
      eq(paymentAllocations.state, "active"),
      inArray(paymentAllocations.obligationId, allObligationIds),
    ));
  const adjustments = allocations.length === 0 ? [] : await tx.select({ sourceAllocationId: refundAllocationAdjustments.sourceAllocationId, amountMinor: refundAllocationAdjustments.amountMinor, disposition: refundAllocationAdjustments.disposition })
    .from(refundAllocationAdjustments)
    .where(and(
      eq(refundAllocationAdjustments.organizationId, input.organizationId),
      eq(refundAllocationAdjustments.leagueId, input.leagueId),
      inArray(refundAllocationAdjustments.sourceAllocationId, allocations.map((row) => row.id)),
    ));
  const adjustmentsByAllocationId = new Map(adjustments.map((row) => [row.sourceAllocationId, row]));
  const allocatedByObligationId = new Map<string, number>();
  const adjustmentsByObligationId = new Map<string, Array<{ amountMinor: number; disposition: "still_owed" | "waived" }>>();
  for (const allocation of allocations) {
    allocatedByObligationId.set(allocation.obligationId, (allocatedByObligationId.get(allocation.obligationId) ?? 0) + allocation.amountMinor);
    const adjustment = adjustmentsByAllocationId.get(allocation.id);
    if (adjustment) adjustmentsByObligationId.set(allocation.obligationId, [
      ...(adjustmentsByObligationId.get(allocation.obligationId) ?? []),
      { amountMinor: adjustment.amountMinor, disposition: adjustment.disposition },
    ]);
  }
  const totalOutstandingByKey = new Map<string, number>();
  const heldKeys = new Set<string>();
  for (const row of allObligations) {
    if (row.obligation.payerBowlerId === null) throw new StandingAutopayError("OWNER_EVIDENCE_INVALID", "A standing payment candidate has no historical payer", 503);
    const key = `${row.obligation.payerBowlerId}:${row.obligation.occurrenceId}`;
    const rowAdjustments = adjustmentsByObligationId.get(row.obligation.id) ?? [];
    const balance = canonicalObligationBalance({
      amountMinor: row.obligation.amountMinor,
      state: row.obligation.state,
      grossAllocatedMinor: allocatedByObligationId.get(row.obligation.id) ?? 0,
      adjustments: rowAdjustments,
    });
    totalOutstandingByKey.set(key, (totalOutstandingByKey.get(key) ?? 0) + balance.outstandingMinor);
    if (rowAdjustments.some((adjustment) => adjustment.disposition === "still_owed")) heldKeys.add(key);
  }
  for (const key of heldKeys) {
    if ((totalOutstandingByKey.get(key) ?? 0) > 0) {
      throw new StandingAutopayError("REFUND_STILL_OWED_MANUAL", "Standing automatic payment is blocked until the still-owed refund week is settled by a one-time payment", 409);
    }
  }
}

export async function validateStandingConsentForDispatchInTransaction(tx: StandingTx, input: { organizationId: number; leagueId: number; operationId: string; leagueIdAlreadyLocked?: boolean }) {
    if (!input.leagueIdAlreadyLocked) await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    const [binding] = await tx.select().from(paymentOperationStandingAutopayBindings).where(and(eq(paymentOperationStandingAutopayBindings.organizationId, input.organizationId), eq(paymentOperationStandingAutopayBindings.leagueId, input.leagueId), eq(paymentOperationStandingAutopayBindings.operationId, input.operationId))).limit(1).for("update");
    if (!binding) throw new StandingAutopayError("STANDING_BINDING_MISSING", "The standing operation binding is unavailable");
    const consent = await activeConsent(tx, { organizationId: input.organizationId, leagueId: input.leagueId, consentId: binding.consentId });
    if (!consent || consent.consentVersion !== binding.consentVersion) throw new StandingAutopayError("CONSENT_REVOKED", "Standing consent changed before dispatch");
    const partners = await consentPartners(tx, { organizationId: input.organizationId, leagueId: input.leagueId, consentId: consent.id, consentVersion: consent.consentVersion, payerBowlerId: consent.payerBowlerId });
    const recipientIds = [consent.payerBowlerId, ...partners.map((row) => row.partnerBowlerId)];
    if (!(await activeMembership(tx, input.organizationId, input.leagueId, recipientIds))) throw new StandingAutopayError("PARTICIPANT_INACTIVE", "A standing payer is no longer active");
    const adoption = await readOwnedLedgerAdoptionInTransaction(tx, { organizationId: input.organizationId, leagueId: input.leagueId });
    if (adoption) {
      const [operation] = await tx.select().from(paymentOperations).where(and(
        eq(paymentOperations.organizationId, input.organizationId),
        eq(paymentOperations.leagueId, input.leagueId),
        eq(paymentOperations.id, input.operationId),
        eq(paymentOperations.operationType, "standing_autopay_charge"),
      )).limit(1).for("share");
      const [league] = await tx.select({ locationId: leagues.locationId }).from(leagues).where(and(
        eq(leagues.organizationId, input.organizationId),
        eq(leagues.id, input.leagueId),
      )).limit(1).for("share");
      const [stored] = await tx.select().from(accountPaymentOperationSnapshots).where(and(
        eq(accountPaymentOperationSnapshots.organizationId, input.organizationId),
        eq(accountPaymentOperationSnapshots.leagueId, input.leagueId),
        eq(accountPaymentOperationSnapshots.operationId, input.operationId),
      )).limit(1).for("share");
      if (!operation || !stored || stored.snapshotKind !== "standing_funding" || !league) throw new StandingAutopayError("SNAPSHOT_INVALID", "The standing account funding snapshot is unavailable");
      let snapshot;
      try { snapshot = reconstructAccountStandingFundingSnapshot({ operation, stored }); }
      catch { throw new StandingAutopayError("SNAPSHOT_INVALID", "The standing account funding snapshot is invalid"); }
      const evidence = snapshot.standingEvidence;
      if (operation.authorizingUserId === null || evidence.consentId !== consent.id
        || evidence.consentVersion !== consent.consentVersion || evidence.consentFingerprint !== consent.consentFingerprint
        || evidence.bindingEvidenceFingerprint !== binding.evidenceFingerprint
        || snapshot.payerBowlerId !== consent.payerBowlerId
        || snapshot.providerName !== consent.providerName || snapshot.providerLocationId !== consent.providerLocationId
        || snapshot.locationId !== league.locationId
        || binding.providerName !== snapshot.providerName || binding.providerLocationId !== snapshot.providerLocationId
        || !sameInstant(binding.cutoffAt, evidence.cutoffAt)
        || binding.collectionMode !== evidence.collectionMode
        || binding.triggerOccurrenceId !== evidence.triggerOccurrenceId
        || binding.pairedOccurrenceId !== evidence.pairedOccurrenceId
        || binding.collectionGroupId !== evidence.collectionGroupId
        || binding.collectionGroupRevision !== evidence.collectionGroupRevision
        || binding.collectionGroupFingerprint !== evidence.collectionGroupFingerprint
        || binding.triggerMemberId !== evidence.triggerMemberId
        || binding.pairedMemberId !== evidence.pairedMemberId) {
        throw new StandingAutopayError("SNAPSHOT_INVALID", "The standing account funding snapshot does not match its consent binding");
      }
      const [payer] = await tx.select({ paymentCustomerId: bowlers.paymentCustomerId }).from(bowlers).where(and(
        eq(bowlers.id, consent.payerBowlerId),
        eq(bowlers.organizationId, input.organizationId),
        eq(bowlers.active, true),
      )).limit(1).for("share");
      const consentCustomerId = decrypt(consent.encryptedCustomerId ?? "");
      if (!payer?.paymentCustomerId || !consentCustomerId || payer.paymentCustomerId !== consentCustomerId) {
        throw new StandingAutopayError("PAYMENT_CUSTOMER_CHANGED", "The standing card no longer belongs to the active payer account");
      }
      const expectedPartnerById = new Map(partners.map((partner) => [partner.partnerBowlerId, partner]));
      const evidenceById = new Map(snapshot.recipientEvidence.map((recipient) => [recipient.recipientBowlerId, recipient]));
      if (evidenceById.size !== snapshot.recipientEvidence.length || evidenceById.size !== recipientIds.length
        || snapshot.recipientEvidence.some((recipient) => {
          if (recipient.recipientBowlerId === consent.payerBowlerId) {
            return recipient.role !== "self" || recipient.paymentLinkId !== null || recipient.linkFingerprint !== null;
          }
          const partner = expectedPartnerById.get(recipient.recipientBowlerId);
          return recipient.role !== "partner" || !partner
            || recipient.paymentLinkId !== partner.paymentLinkId
            || recipient.linkFingerprint !== partner.linkFingerprint;
        })) throw new StandingAutopayError("PARTICIPANT_EVIDENCE_INVALID", "The standing account recipient evidence changed before dispatch");
      const currentGroup = await groupForCutoff(tx, { organizationId: input.organizationId, leagueId: input.leagueId, cutoffAt: evidence.cutoffAt });
      if (currentGroup.suppressed || currentGroup.mode !== evidence.collectionMode
        || currentGroup.triggerOccurrenceId !== evidence.triggerOccurrenceId
        || currentGroup.triggerOccurrenceRevision !== evidence.triggerOccurrenceRevision
        || currentGroup.pairedOccurrenceId !== evidence.pairedOccurrenceId
        || currentGroup.groupId !== evidence.collectionGroupId
        || currentGroup.groupRevision !== evidence.collectionGroupRevision
        || currentGroup.groupFingerprint !== evidence.collectionGroupFingerprint
        || currentGroup.triggerMemberId !== evidence.triggerMemberId
        || currentGroup.pairedMemberId !== evidence.pairedMemberId) {
        throw new StandingAutopayError("COLLECTION_GROUP_CHANGED", "The standing collection group changed before dispatch");
      }
      const holds = await pendingRefundPayerWeekKeys(tx, {
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        payerBowlerIds: recipientIds,
        occurrenceIds: evidence.collectionRequirementOccurrenceIds,
      });
      if (holds.size > 0) throw new StandingAutopayError("REFUND_HOLD", "A refund is still being resolved for this standing collection group");
      if (!await validateRosterSnapshotForDispatchInTransaction(tx, input)) throw new StandingAutopayError("SNAPSHOT_INVALID", "The standing account funding snapshot is unavailable");
      return true;
    }
    await assertNotActiveRotatingPoolMemberForStandingAutopay(tx, { organizationId: input.organizationId, leagueId: input.leagueId, bowlerId: consent.payerBowlerId });
    const [snapshot] = await tx.select().from(paymentOperationRosterSnapshots).where(and(eq(paymentOperationRosterSnapshots.organizationId, input.organizationId), eq(paymentOperationRosterSnapshots.leagueId, input.leagueId), eq(paymentOperationRosterSnapshots.operationId, input.operationId), eq(paymentOperationRosterSnapshots.snapshotKind, "standing_autopay"))).limit(1).for("share");
    if (!snapshot || snapshot.snapshotFingerprint !== binding.evidenceFingerprint) throw new StandingAutopayError("SNAPSHOT_INVALID", "The standing operation snapshot is invalid");
    if (!await validateRosterSnapshotForDispatchInTransaction(tx, input)) throw new StandingAutopayError("SNAPSHOT_INVALID", "The standing operation snapshot is unavailable");
    await validateStandingRefundHoldsForDispatchInTransaction(tx, input);
    return true;
}

export async function validateStandingConsentForDispatch(input: { organizationId: number; leagueId: number; operationId: string }) {
  return db.transaction((tx) => validateStandingConsentForDispatchInTransaction(tx, input));
}
