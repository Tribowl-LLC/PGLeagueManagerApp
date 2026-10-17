import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  autopayConsents,
  accountPaymentOperationSnapshots,
  bowlers,
  leagueOccurrences,
  leagueScheduleCommands,
  leagues,
  locations,
  occurrencePaymentResponsibilities,
  organizations,
  paymentAllocationFundingApplications,
  paymentAllocations,
  paymentObligations,
  paymentOperations,
  paymentOperationRosterSnapshotItems,
  paymentOperationRosterSnapshots,
  paymentOperationStandingAutopayBindings,
  paymentOperationStandingAutopayParticipants,
  paymentObligationOwnerRevisions,
  paymentDisputes,
  paymentVoids,
  payments,
  rotatingOccurrenceAssignments,
  rotatingCreditFundings,
  rotatingCreditRefundOperationSnapshots,
  rotatingCreditRefunds,
  teams,
  teamPaymentSlots,
  users,
  weeklyPaymentAllocationReleases,
  weeklyPaymentFundings,
  weeklyPaymentLedgerAdoptions,
  weeklyPaymentWeekConfirmations,
  webhookEvents,
} from "@shared/schema";
import type { PaymentOperationTransaction } from "../../server/storage/payment-operations";
import {
  applyOwnedFundingFifoInTransaction,
  assertOwnedPaymentTenderInTransaction,
  isOwnedPaymentLedgerInvariantError,
  recordOwnedFundingInTransaction,
  releaseOwnedFundingApplicationInTransaction,
  readLegacyFundingAuthorizationInTransaction,
  readGenericFundingAvailabilityInTransaction,
  readOwnedGenericFundingSourcesByPaymentInTransaction,
} from "../../server/services/owned-payment-ledger";
import { prepareRotatingCreditPaymentOperation } from "../../server/services/rotating-credit-operation-preparation";
import { quoteRotatingCreditRefund, recordRotatingCreditRefund } from "../../server/services/rotating-credit-refund";
import { RefundPaymentOperationExecutor } from "../../server/services/refund-payment-operation-executor";
import { prepareRefundPaymentOperation } from "../../server/services/refund-payment-operation-preparation";
import { acquirePaymentOperationLease, finalizeRefundPaymentOperationSuccess } from "../../server/storage/payment-operations";
import { PaymentProviderError } from "../../server/services/payment-errors";
import {
  appendManualReceiptRevisionInTransaction,
  createManualReceiptHeadInTransaction,
  createManualReceiptPaymentInTransaction,
} from "../../server/services/manual-payment-receipts";
import type { PaymentProvider } from "../../server/services/payment-provider";
import { readRotatingCreditFundingBalancesInTransaction } from "../../server/services/rotating-credit-applications";
import { readCanonicalPaymentReport } from "../../server/services/canonical-payment-report";
import { finalizeRosterSnapshotInTransaction } from "../../server/services/roster-payment-finalizer";
import { prepareAccountPaymentOperation } from "../../server/services/account-payment-operation-preparation";
import { getTestDb } from "../setup/test-db";

const db = getTestDb();
const suffix = `${process.env.VITEST_POOL_ID ?? "local"}-${randomUUID().slice(0, 8)}`;
const slug = `owned-ledger-guards-${suffix}`;
let organizationId: number;
let leagueId: number;
let locationId: number;
let teamId: number;
let payerBowlerId: number;
let creditedBowlerId: number;
let actorUserId: number;
let occurrenceId: string;
let responsibilityId: string;
let obligationId: string;
let adoptionId: string;
let legacyStandingConsentVersion = 0;
let isolatedWorksheetOccurrenceOrdinal = 1;

beforeAll(async () => {
  const [organization] = await db.insert(organizations).values({
    name: "Owned Ledger SQL Guard Fixture",
    slug,
  }).returning({ id: organizations.id });
  organizationId = organization.id;

  const [location] = await db.insert(locations).values({
    organizationId,
    name: "Owned Ledger Fixture Location",
  }).returning({ id: locations.id });
  locationId = location.id;

  const [league] = await db.insert(leagues).values({
    name: "Owned Ledger SQL Guard League",
    organizationId,
    locationId,
    payingLineupSize: 3,
    weeklyFee: 500,
    seasonStart: "2038-01-01T00:00:00.000Z",
    seasonEnd: "2038-12-31T23:59:59.000Z",
    weekDay: "Monday",
    timezone: "UTC",
  }).returning({ id: leagues.id });
  leagueId = league.id;

  const [actor] = await db.insert(users).values({
    email: `owned-ledger-guards-${suffix}@example.test`,
    password: "deterministic-test-password-hash",
    name: "Owned Ledger Test Admin",
    role: "org_admin",
    organizationId,
  }).returning({ id: users.id });
  actorUserId = actor.id;

  const [payer] = await db.insert(bowlers).values({
    name: "Owned Ledger Tender Payer",
    organizationId,
  }).returning({ id: bowlers.id });
  payerBowlerId = payer.id;
  const [credited] = await db.insert(bowlers).values({
    name: "Owned Ledger Credited Bowler",
    organizationId,
  }).returning({ id: bowlers.id });
  creditedBowlerId = credited.id;

  const [team] = await db.insert(teams).values({
    name: "Owned Ledger Fixture Team",
    number: 1,
    leagueId,
  }).returning({ id: teams.id });
  teamId = team.id;

  const commandId = randomUUID();
  const instant = "2038-02-01T19:00:00.000Z";
  await db.insert(leagueScheduleCommands).values({
    id: commandId,
    organizationId,
    leagueId,
    actorUserId,
    commandType: "publish",
    idempotencyKey: `owned-ledger-publish-${suffix}`,
    requestFingerprint: `owned-ledger-publish-fingerprint-${suffix}`,
  });
  const [occurrence] = await db.insert(leagueOccurrences).values({
    organizationId,
    leagueId,
    locationId,
    generationKey: `owned-ledger-occurrence-${suffix}`,
    kind: "regular",
    status: "scheduled",
    lifecycle: "published",
    authoritativeLocalDate: "2038-02-01",
    authoritativeLocalStartTime: "19:00:00",
    timezone: "UTC",
    startAt: instant,
    selectedUtcOffsetMinutes: 0,
    foldResolution: "unambiguous",
    resolverVersion: "owned-ledger-guard-test",
    plannedOrdinal: 1,
    competitionNumber: 1,
    competitive: true,
    countsInStandings: true,
    publishedAt: instant,
    publishedByUserId: actorUserId,
    publicationCommandId: commandId,
  }).returning({ id: leagueOccurrences.id });
  occurrenceId = occurrence.id;

  const [responsibility] = await db.insert(occurrencePaymentResponsibilities).values({
    organizationId,
    leagueId,
    occurrenceId,
    teamId,
    slotId: null,
    slotIndex: null,
    positionIndex: null,
    responsibilityKind: "worksheet",
    payerBowlerId: creditedBowlerId,
    mainBowlerId: null,
    substituteBowlerId: null,
    policy: null,
    worksheetFeeComponent: "full",
    amountMinor: 500,
    currency: "USD",
    dueAt: instant,
    pastDueAt: "2038-02-08T19:00:00.000Z",
    recordedByUserId: actorUserId,
  }).returning({ id: occurrencePaymentResponsibilities.id });
  responsibilityId = responsibility.id;

  const [obligation] = await db.insert(paymentObligations).values({
    organizationId,
    leagueId,
    occurrenceId,
    responsibilityId,
    component: "full",
    payerBowlerId: creditedBowlerId,
    amountMinor: 500,
    currency: "USD",
    dueAt: instant,
    pastDueAt: "2038-02-08T19:00:00.000Z",
    state: "open",
    createdByUserId: actorUserId,
  }).returning({ id: paymentObligations.id });
  obligationId = obligation.id;

  const [adoption] = await db.insert(weeklyPaymentLedgerAdoptions).values({
    organizationId,
    leagueId,
    adoptedThroughLocalDate: "2038-01-31",
    preflightFingerprint: `lvweeklyadoptpre:v1:${"a".repeat(64)}`,
    resultFingerprint: `lvweeklyadopt:v1:${"b".repeat(64)}`,
    recordedByUserId: actorUserId,
  }).returning({ id: weeklyPaymentLedgerAdoptions.id });
  adoptionId = adoption.id;

  await db.insert(weeklyPaymentWeekConfirmations).values({
    organizationId,
    leagueId,
    occurrenceId,
    revision: 1,
    stateFingerprint: `lvmanagepayments:v1:${"c".repeat(64)}`,
    requestFingerprint: `lvmanagepaymentsrequest:v1:${"d".repeat(64)}`,
    responsibilitySetFingerprint: `lvmanagepaymentsrows:v1:${"e".repeat(64)}`,
    idempotencyKey: `owned-ledger-confirm-${suffix}`,
    requestSnapshot: {},
    recordedByUserId: actorUserId,
  });
});

async function createV4Tender(amountMinor: number) {
  const now = new Date().toISOString();
  return db.transaction(async (tx) => {
    const operation = await prepareAccountPaymentOperation({
      requestKey: `owned-ledger-v4-${randomUUID()}`,
      organizationId,
      leagueId,
      payerBowlerId,
      amountMinor,
      fundingPortions: [{ portionIndex: 0, creditedBowlerId, amountMinor }],
      // The payer's selected debt target can resolve to no charge while the
      // linked partner owns the only positive tender portion.
      recipientEvidence: [
        {
          recipientBowlerId: payerBowlerId,
          role: "self",
          paymentLinkId: null,
          linkFingerprint: null,
          selection: { kind: "confirmed_debt_balance" },
        },
        {
          recipientBowlerId: creditedBowlerId,
          role: "partner",
          paymentLinkId: 77,
          linkFingerprint: `lvpartnerlink:v1:${"1".repeat(64)}`,
          selection: { kind: "explicit_amount", amountMinor },
        },
      ],
      currency: "USD",
      providerName: "square",
      locationId,
      providerLocationId: null,
      authorizingUserId: actorUserId,
      sourceKind: "new_card",
      sourceId: `cnon:owned-ledger-${randomUUID()}`,
      customerId: null,
      buyerEmail: null,
      storeCard: false,
      quoteFingerprint: `lvaccountfundquote:v4:${randomUUID().replaceAll("-", "").repeat(2)}`,
      now: new Date(now),
    }, tx);
    const providerPaymentId = `owned-ledger-provider-${operation.id}`;
    await tx.update(paymentOperations).set({
      status: "succeeded",
      providerObjectId: providerPaymentId,
      attemptCount: 1,
      nextAttemptAt: null,
      dispatchClaimedAt: now,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    }).where(and(
      eq(paymentOperations.id, operation.id),
      eq(paymentOperations.organizationId, organizationId),
      eq(paymentOperations.leagueId, leagueId),
    ));
    const [snapshot] = await tx.select({ fingerprint: accountPaymentOperationSnapshots.snapshotFingerprint }).from(accountPaymentOperationSnapshots).where(and(
      eq(accountPaymentOperationSnapshots.operationId, operation.id),
      eq(accountPaymentOperationSnapshots.organizationId, organizationId),
      eq(accountPaymentOperationSnapshots.leagueId, leagueId),
    ));
    if (!snapshot) throw new Error("V4 tender fixture snapshot was not created");
    const [payment] = await tx.insert(payments).values({
      organizationId,
      leagueId,
      bowlerId: payerBowlerId,
      amount: amountMinor,
      currency: "USD",
      status: "paid",
      type: "square",
      providerPaymentId,
      paymentOperationId: operation.id,
      idempotencyKey: operation.id,
      paidByUserId: actorUserId,
      createdAt: now,
    }).returning({ id: payments.id });
    const funding = await recordOwnedFundingInTransaction(tx, {
      organizationId,
      leagueId,
      creditedBowlerId,
      paymentId: payment.id,
      portionIndex: 0,
      amountMinor,
      currency: "USD",
      source: "provider",
      authorizationKind: "provider_snapshot",
      authorizationOperationId: operation.id,
      authorizationItemCount: 0,
      authorizationFingerprint: snapshot.fingerprint,
      adoptionId: null,
      recordedByUserId: actorUserId,
      now,
    });
    return { paymentId: payment.id, fundingId: funding.id, operationId: operation.id, providerPaymentId };
  });
}

async function createManualReceiptTender(input: {
  amountMinor: number;
  bowlerId: number;
  occurrenceId: string;
  businessDate: string;
}) {
  const now = new Date().toISOString();
  const idempotencyKey = `owned-ledger-manual-tender-${randomUUID()}`;
  return db.transaction(async (tx) => {
    const scope = { organizationId, leagueId, actorUserId, occurrenceId: input.occurrenceId, idempotencyKey };
    const receiptId = await createManualReceiptHeadInTransaction(tx, {
      organizationId,
      leagueId,
      occurrenceId: input.occurrenceId,
      bowlerId: input.bowlerId,
      now,
    });
    const paymentId = await createManualReceiptPaymentInTransaction(tx, scope, {
      receiptId,
      bowlerId: input.bowlerId,
      amountMinor: input.amountMinor,
      businessDate: input.businessDate,
      paymentIdempotencyKey: idempotencyKey,
    }, now);
    await appendManualReceiptRevisionInTransaction(tx, {
      organizationId,
      leagueId,
      actorUserId,
      receiptId,
      revision: 1,
      paymentId,
      amountMinor: input.amountMinor,
      businessCollectionLocalDate: input.businessDate,
      revisionKind: "manual_record",
      now,
    });
    const [funding] = await tx.select({ id: weeklyPaymentFundings.id }).from(weeklyPaymentFundings).where(and(
      eq(weeklyPaymentFundings.organizationId, organizationId),
      eq(weeklyPaymentFundings.leagueId, leagueId),
      eq(weeklyPaymentFundings.paymentId, paymentId),
    ));
    if (!funding) throw new Error("manual receipt tender funding was not created");
    return { paymentId, fundingId: funding.id };
  });
}

async function createIsolatedWorksheetOccurrence(name: string) {
  const ordinal = ++isolatedWorksheetOccurrenceOrdinal;
  const commandId = randomUUID();
  const localDate = new Date(Date.UTC(2038, 1, ordinal)).toISOString().slice(0, 10);
  const instant = `${localDate}T19:00:00.000Z`;
  const nextWeek = new Date(Date.parse(instant) + 7 * 24 * 60 * 60 * 1_000).toISOString();
  await db.insert(leagueScheduleCommands).values({
    id: commandId,
    organizationId,
    leagueId,
    actorUserId,
    commandType: "publish",
    idempotencyKey: `owned-ledger-publish-debt-${suffix}-${ordinal}`,
    requestFingerprint: `owned-ledger-publish-debt-fingerprint-${suffix}-${ordinal}`,
  });
  const [occurrence] = await db.insert(leagueOccurrences).values({
    organizationId,
    leagueId,
    locationId,
    generationKey: `owned-ledger-debt-occurrence-${suffix}-${ordinal}-${name}`,
    kind: "regular",
    status: "scheduled",
    lifecycle: "published",
    authoritativeLocalDate: localDate,
    authoritativeLocalStartTime: "19:00:00",
    timezone: "UTC",
    startAt: instant,
    selectedUtcOffsetMinutes: 0,
    foldResolution: "unambiguous",
    resolverVersion: "owned-ledger-guard-test",
    plannedOrdinal: ordinal,
    competitionNumber: ordinal,
    competitive: true,
    countsInStandings: true,
    publishedAt: instant,
    publishedByUserId: actorUserId,
    publicationCommandId: commandId,
  }).returning({ id: leagueOccurrences.id });
  const evidenceHex = ordinal.toString(16).padStart(64, "0");
  await db.insert(weeklyPaymentWeekConfirmations).values({
    organizationId,
    leagueId,
    occurrenceId: occurrence.id,
    revision: 1,
    stateFingerprint: `lvmanagepayments:v1:${evidenceHex}`,
    requestFingerprint: `lvmanagepaymentsrequest:v1:${evidenceHex}`,
    responsibilitySetFingerprint: `lvmanagepaymentsrows:v1:${evidenceHex}`,
    idempotencyKey: `owned-ledger-confirm-debt-${suffix}-${ordinal}`,
    requestSnapshot: {},
    recordedByUserId: actorUserId,
  });
  return { occurrenceId: occurrence.id, instant, pastDueAt: nextWeek, businessDate: localDate };
}

async function createWorksheetDebt(input: {
  amountMinor: number;
  name: string;
  bowlerId?: number;
  isolatedOccurrence?: boolean;
}) {
  const bowlerId = input.bowlerId ?? (await db.insert(bowlers).values({
    name: `${input.name} ${suffix}`,
    organizationId,
  }).returning({ id: bowlers.id }))[0]?.id;
  if (!bowlerId) throw new Error("worksheet debt payer was not created");
  const occurrence = input.isolatedOccurrence
    ? await createIsolatedWorksheetOccurrence(input.name)
    : { occurrenceId, instant: "2038-02-01T19:00:00.000Z", pastDueAt: "2038-02-08T19:00:00.000Z", businessDate: "2038-02-01" };
  const [responsibility] = await db.insert(occurrencePaymentResponsibilities).values({
    organizationId,
    leagueId,
    occurrenceId: occurrence.occurrenceId,
    teamId,
    slotId: null,
    slotIndex: null,
    positionIndex: null,
    responsibilityKind: "worksheet",
    payerBowlerId: bowlerId,
    mainBowlerId: null,
    substituteBowlerId: null,
    policy: null,
    worksheetFeeComponent: "full",
    amountMinor: input.amountMinor,
    currency: "USD",
    dueAt: occurrence.instant,
    pastDueAt: occurrence.pastDueAt,
    recordedByUserId: actorUserId,
  }).returning({ id: occurrencePaymentResponsibilities.id, responsibilityKey: occurrencePaymentResponsibilities.responsibilityKey });
  const [obligation] = await db.insert(paymentObligations).values({
    organizationId,
    leagueId,
    occurrenceId: occurrence.occurrenceId,
    responsibilityId: responsibility.id,
    component: "full",
    payerBowlerId: bowlerId,
    amountMinor: input.amountMinor,
    currency: "USD",
    dueAt: occurrence.instant,
    pastDueAt: occurrence.pastDueAt,
    state: "open",
    createdByUserId: actorUserId,
  }).returning({ id: paymentObligations.id });
  return { bowlerId, responsibilityId: responsibility.id, responsibilityKey: responsibility.responsibilityKey, obligationId: obligation.id, occurrenceId: occurrence.occurrenceId, businessDate: occurrence.businessDate };
}

async function createRotatingProviderFunding(input: { bowlerId: number; amountMinor: number }) {
  const now = new Date(Date.now() + 5_000).toISOString();
  const providerPaymentId = `owned-ledger-rotating-payment-${randomUUID()}`;
  const quoteFingerprint = `lvrotcrquote:v1:${"8".repeat(64)}`;
  const idempotencyKey = `owned-ledger-rot-${randomUUID()}`;
  return db.transaction(async (tx) => {
    const operation = await prepareRotatingCreditPaymentOperation({
      organizationId,
      leagueId,
      bowlerId: input.bowlerId,
      amountMinor: input.amountMinor,
      currency: "USD",
      shareCount: 1,
      providerName: "square",
      locationId,
      providerLocationId: null,
      sourceKind: "new_card",
      sourceId: `test-source-${randomUUID()}`,
      customerId: null,
      buyerEmail: null,
      quoteFingerprint,
      idempotencyKey,
      authorizingUserId: actorUserId,
      transaction: tx,
    });
    await tx.update(paymentOperations).set({
      status: "succeeded",
      providerObjectId: providerPaymentId,
      attemptCount: 1,
      nextAttemptAt: null,
      dispatchClaimedAt: now,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    }).where(eq(paymentOperations.id, operation.id));
    const [payment] = await tx.insert(payments).values({
      organizationId,
      leagueId,
      bowlerId: input.bowlerId,
      amount: input.amountMinor,
      currency: "USD",
      status: "paid",
      type: "square",
      providerPaymentId,
      paymentOperationId: operation.id,
      paidByUserId: actorUserId,
      createdAt: now,
    }).returning({ id: payments.id });
    const [funding] = await tx.insert(rotatingCreditFundings).values({
      organizationId,
      leagueId,
      bowlerId: input.bowlerId,
      paymentId: payment.id,
      amountMinor: input.amountMinor,
      currency: "USD",
      fundingKind: "provider",
      idempotencyKey,
      requestFingerprint: `lvrotcrreq:v1:${"9".repeat(64)}`,
      quoteFingerprint,
      actorUserId,
      createdAt: now,
    }).returning({ id: rotatingCreditFundings.id });
    return { fundingId: funding.id, paymentId: payment.id, operationId: operation.id, providerPaymentId };
  });
}

async function recordProviderCreditRefund(input: { fundingId: string; outcome: "COMPLETED" | "PENDING" | "UNKNOWN" }) {
  const quote = await quoteRotatingCreditRefund({ organizationId, leagueId, fundingId: input.fundingId });
  const refundId = `owned-ledger-refund-${randomUUID()}`;
  const unusedProviderMethod = async () => {
    throw new Error("Unexpected provider method in owned-ledger refund fixture");
  };
  const provider: PaymentProvider = {
    providerName: "square",
    locationId,
    processPayment: unusedProviderMethod,
    createOrderWithPayment: unusedProviderMethod,
    saveCardOnFile: unusedProviderMethod,
    listCardsOnFile: async () => [],
    disableCard: async () => undefined,
    createOrUpdateCustomer: async () => null,
    getPayment: async () => null,
    validateCardId: () => false,
    refundPayment: async () => {
      if (input.outcome === "UNKNOWN") {
        throw new PaymentProviderError("Provider outcome unavailable", "REFUND_UNKNOWN", undefined, {
          disposition: "provider_unknown",
          providerCode: "REFUND_UNKNOWN",
        });
      }
      return { refundId, status: input.outcome };
    },
  };
  const executor = new RefundPaymentOperationExecutor({
    getProvider: async () => provider,
    leaseOwner: `owned-ledger-refund-test-${randomUUID()}`,
  });
  return recordRotatingCreditRefund({
    organizationId,
    leagueId,
    actorUserId,
    request: {
      fundingId: input.fundingId,
      refundKind: "provider",
      quoteFingerprint: quote.fingerprint,
      idempotencyKey: `owned-ledger-refund-${randomUUID()}`,
      reason: "Owned ledger guard fixture unused credit",
    },
    executor,
  });
}

async function createLegacyStandingFunding(): Promise<{ paymentId: number; fundingId: string; operationId: string; creditedBowlerId: number }> {
  const now = new Date().toISOString();
  const cutoffAt = "2038-02-01T19:00:00.000Z";
  const operationId = randomUUID();
  const consentVersion = ++legacyStandingConsentVersion;
  const debt = await createWorksheetDebt({ amountMinor: 500, name: `Legacy Standing ${consentVersion}` });
  const sourceBowlerId = debt.bowlerId;
  const providerPaymentId = `owned-ledger-standing-payment-${operationId}`;
  const evidenceHex = consentVersion.toString(16).padStart(64, "0");
  const snapshotFingerprint = `lvstandingcutoff:v1:${evidenceHex}`;
  return db.transaction(async (tx) => {
  const [consent] = await tx.insert(autopayConsents).values({
    organizationId,
    leagueId,
    payerBowlerId: sourceBowlerId,
    consentVersion,
    state: "active",
    paymentMode: "weekly",
    consentFingerprint: `lvstandingconsent:v1:${evidenceHex}`,
    providerName: "square",
    providerLocationId: "square-fixture-location",
    encryptedSourceId: "fixture-encrypted-standing-source",
    encryptedCustomerId: "fixture-encrypted-standing-customer",
    createdByUserId: actorUserId,
    activatedAt: now,
    createdAt: now,
    revokedAt: null,
  }).returning({ id: autopayConsents.id });

  await tx.insert(paymentOperations).values({
    id: operationId,
    organizationId,
    leagueId,
    authorizingUserId: actorUserId,
    operationType: "standing_autopay_charge",
    triggerOccurrenceId: occurrenceId,
    targetKey: `owned-ledger-standing-${operationId}`,
    amountMinor: 500,
    currency: "USD",
    requestFingerprint: `lvpayreq:v1:${"7".repeat(64)}`,
    providerIdempotencyKey: `owned-ledger-standing-${operationId}`.slice(0, 45),
    providerName: "square",
    providerObjectId: providerPaymentId,
    status: "succeeded",
    attemptCount: 1,
    nextAttemptAt: null,
    dispatchClaimedAt: now,
    startedAt: now,
    completedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await tx.insert(paymentOperationRosterSnapshots).values({
    operationId,
    organizationId,
    leagueId,
    snapshotVersion: 2,
    snapshotKind: "standing_autopay",
    collectionMode: "weekly",
    cutoffAt,
    amountMinor: 500,
    currency: "USD",
    obligations: [{ allocationIndex: 0, obligationId: debt.obligationId, payerBowlerId: sourceBowlerId, amountMinor: 500 }],
    locationId: null,
    providerLocationId: null,
    payerBowlerId: null,
    requestKind: null,
    encryptedSourceId: null,
    encryptedCustomerId: null,
    encryptedBuyerEmail: null,
    storeCard: false,
    sourceKind: null,
    quoteFingerprint: null,
    lineItems: [],
    partnerEvidence: null,
    snapshotFingerprint,
    createdAt: now,
  });
  await tx.insert(paymentOperationStandingAutopayBindings).values({
    operationId,
    organizationId,
    leagueId,
    consentId: consent.id,
    consentVersion,
    providerName: "square",
    providerLocationId: "square-fixture-location",
    triggerOccurrenceId: occurrenceId,
    pairedOccurrenceId: null,
    collectionGroupId: null,
    collectionGroupRevision: null,
    collectionGroupFingerprint: null,
    triggerMemberId: null,
    pairedMemberId: null,
    cutoffAt,
    collectionMode: "weekly",
    evidenceFingerprint: snapshotFingerprint,
    createdAt: now,
  });
  await tx.insert(paymentOperationStandingAutopayParticipants).values({
    operationId,
    organizationId,
    leagueId,
    allocationIndex: 0,
    obligationId: debt.obligationId,
    bowlerId: sourceBowlerId,
    role: "payer",
    paymentLinkId: null,
    linkFingerprint: null,
    consentVersion,
    createdAt: now,
  });
  await tx.insert(paymentOperationRosterSnapshotItems).values({
    operationId,
    organizationId,
    leagueId,
    obligationId: debt.obligationId,
    allocationIndex: 0,
    amountMinor: 500,
    state: "finalized",
    createdAt: now,
  });
  const [payment] = await tx.insert(payments).values({
    organizationId,
    leagueId,
    bowlerId: sourceBowlerId,
    amount: 500,
    currency: "USD",
    status: "paid",
    type: "square",
    providerPaymentId,
    paymentOperationId: operationId,
    paidByUserId: actorUserId,
    createdAt: now,
  }).returning({ id: payments.id });
  const funding = await recordOwnedFundingInTransaction(tx, {
    organizationId,
    leagueId,
    paymentId: payment.id,
    creditedBowlerId: sourceBowlerId,
    portionIndex: 0,
    amountMinor: 500,
    currency: "USD",
    source: "legacy_adoption",
    authorizationKind: "legacy_provider_snapshot",
    authorizationOperationId: operationId,
    authorizationItemCount: 1,
    authorizationFingerprint: snapshotFingerprint,
    adoptionId,
    authorizationItems: [{ allocationIndex: 0, amountMinor: 500, snapshotFingerprint }],
    recordedByUserId: actorUserId,
    now,
  });
  await insertApplication(tx, {
    paymentId: payment.id,
    fundingId: funding.id,
    amountMinor: 500,
    creditedBowlerId: sourceBowlerId,
    obligationId: debt.obligationId,
    responsibilityId: debt.responsibilityId,
  });
  return { paymentId: payment.id, fundingId: funding.id, operationId, creditedBowlerId: sourceBowlerId };
  });
}

async function insertApplication(
  tx: PaymentOperationTransaction,
  input: { paymentId: number; fundingId: string; amountMinor: number; sourceAmountMinor?: number; creditedBowlerId?: number; obligationId?: string; responsibilityId?: string; occurrenceId?: string },
) {
  const payerBowlerId = input.creditedBowlerId ?? creditedBowlerId;
  const targetObligationId = input.obligationId ?? obligationId;
  const targetResponsibilityId = input.responsibilityId ?? responsibilityId;
  const targetOccurrenceId = input.occurrenceId ?? occurrenceId;
  const [allocation] = await tx.insert(paymentAllocations).values({
    organizationId,
    leagueId,
    paymentId: input.paymentId,
    obligationId: targetObligationId,
    amountMinor: input.amountMinor,
    currency: "USD",
    recordedByUserId: actorUserId,
  }).returning({ id: paymentAllocations.id });
  const [application] = await tx.insert(paymentAllocationFundingApplications).values({
    organizationId,
    leagueId,
    allocationId: allocation.id,
    paymentId: input.paymentId,
    creditedBowlerId: payerBowlerId,
    genericFundingId: input.fundingId,
    rotatingFundingId: null,
    sourceAmountMinor: input.sourceAmountMinor ?? input.amountMinor,
    amountMinor: input.amountMinor,
    currency: "USD",
    obligationId: targetObligationId,
    responsibilityId: targetResponsibilityId,
    occurrenceId: targetOccurrenceId,
    teamId,
    targetKind: "bowler_responsibility",
    targetPayerBowlerId: payerBowlerId,
    assignmentId: null,
    appliedByUserId: actorUserId,
  }).returning({ id: paymentAllocationFundingApplications.id });
  return { applicationId: application.id, allocationId: allocation.id };
}

describe("owned payment SQL guards on PostgreSQL", () => {
  it("allows a non-adopted legacy cash payment to be deleted without an owned-funding row", async () => {
    const [legacyLeague] = await db.insert(leagues).values({
      name: `Legacy Cash Delete League ${suffix}`,
      organizationId,
      locationId,
      payingLineupSize: 3,
      weeklyFee: 500,
      seasonStart: "2039-01-01T00:00:00.000Z",
      seasonEnd: "2039-12-31T23:59:59.000Z",
      weekDay: "Monday",
      timezone: "UTC",
    }).returning({ id: leagues.id });
    const [legacyTeam] = await db.insert(teams).values({
      name: `Legacy Cash Delete Team ${suffix}`,
      number: 1,
      leagueId: legacyLeague.id,
    }).returning({ id: teams.id });
    const commandId = randomUUID();
    const instant = "2039-02-01T19:00:00.000Z";
    await db.insert(leagueScheduleCommands).values({
      id: commandId,
      organizationId,
      leagueId: legacyLeague.id,
      actorUserId,
      commandType: "publish",
      idempotencyKey: `legacy-cash-publish-${suffix}`,
      requestFingerprint: `legacy-cash-publish-fingerprint-${suffix}`,
    });
    const [legacyOccurrence] = await db.insert(leagueOccurrences).values({
      organizationId,
      leagueId: legacyLeague.id,
      locationId,
      generationKey: `legacy-cash-occurrence-${suffix}`,
      kind: "regular",
      status: "scheduled",
      lifecycle: "published",
      authoritativeLocalDate: "2039-02-01",
      authoritativeLocalStartTime: "19:00:00",
      timezone: "UTC",
      startAt: instant,
      selectedUtcOffsetMinutes: 0,
      foldResolution: "unambiguous",
      resolverVersion: "owned-ledger-cash-delete-test",
      plannedOrdinal: 1,
      competitionNumber: 1,
      competitive: true,
      countsInStandings: true,
      publishedAt: instant,
      publishedByUserId: actorUserId,
      publicationCommandId: commandId,
    }).returning({ id: leagueOccurrences.id });
    const [legacyResponsibility] = await db.insert(occurrencePaymentResponsibilities).values({
      organizationId,
      leagueId: legacyLeague.id,
      occurrenceId: legacyOccurrence.id,
      teamId: legacyTeam.id,
      slotId: null,
      slotIndex: null,
      positionIndex: null,
      responsibilityKind: "worksheet",
      payerBowlerId: payerBowlerId,
      mainBowlerId: null,
      substituteBowlerId: null,
      policy: null,
      worksheetFeeComponent: "full",
      amountMinor: 500,
      currency: "USD",
      dueAt: instant,
      pastDueAt: "2039-02-08T19:00:00.000Z",
      recordedByUserId: actorUserId,
    }).returning({ id: occurrencePaymentResponsibilities.id });
    const [legacyObligation] = await db.insert(paymentObligations).values({
      organizationId,
      leagueId: legacyLeague.id,
      occurrenceId: legacyOccurrence.id,
      responsibilityId: legacyResponsibility.id,
      component: "full",
      payerBowlerId,
      amountMinor: 500,
      currency: "USD",
      dueAt: instant,
      pastDueAt: "2039-02-08T19:00:00.000Z",
      state: "settled",
      createdByUserId: actorUserId,
    }).returning({ id: paymentObligations.id });
    const [cashPayment] = await db.transaction(async (tx) => {
      const [payment] = await tx.insert(payments).values({
        organizationId,
        leagueId: legacyLeague.id,
        bowlerId: payerBowlerId,
        amount: 500,
        currency: "USD",
        status: "paid",
        type: "cash",
        paidByUserId: actorUserId,
        createdAt: new Date().toISOString(),
      }).returning({ id: payments.id });
      await tx.insert(paymentAllocations).values({
        organizationId,
        leagueId: legacyLeague.id,
        paymentId: payment.id,
        obligationId: legacyObligation.id,
        amountMinor: 500,
        currency: "USD",
        allocationKind: "ordinary",
        recordedByUserId: actorUserId,
      });
      return [payment];
    });

    await db.transaction(async (tx) => {
      await tx.insert(paymentVoids).values({
        organizationId,
        leagueId: legacyLeague.id,
        paymentId: cashPayment.id,
        reason: "duplicate cash entry",
        recordedByUserId: actorUserId,
      });
      await tx.update(payments).set({ status: "voided" }).where(eq(payments.id, cashPayment.id));
      await tx.update(paymentAllocations).set({ state: "voided" }).where(eq(paymentAllocations.paymentId, cashPayment.id));
      await tx.update(paymentObligations).set({ state: "open" }).where(eq(paymentObligations.id, legacyObligation.id));
      await tx.execute(sql`SET CONSTRAINTS payment_allocations_conservation, payments_allocation_conservation, payment_voids_allocation_conservation IMMEDIATE`);
      await tx.execute(sql`SELECT set_config('leaguevault.organization_teardown', 'on', true)`);
      await tx.delete(paymentVoids).where(eq(paymentVoids.paymentId, cashPayment.id));
      await tx.delete(paymentAllocations).where(eq(paymentAllocations.paymentId, cashPayment.id));
      await tx.delete(payments).where(and(
        eq(payments.id, cashPayment.id),
        eq(payments.organizationId, organizationId),
        eq(payments.leagueId, legacyLeague.id),
      ));
      await tx.execute(sql`SELECT set_config('leaguevault.organization_teardown', 'off', true)`);
    });

    const remaining = await db.select({ id: payments.id }).from(payments).where(eq(payments.id, cashPayment.id));
    expect(remaining).toHaveLength(0);
  });

  it("continues to reject an invalid owned-funding source after the no-funding early return", async () => {
    const tender = await createV4Tender(250);
    let failure: unknown;
    try {
      await db.transaction(async (tx) => {
        await tx.update(payments).set({ amount: 251 }).where(and(
          eq(payments.id, tender.paymentId),
          eq(payments.organizationId, organizationId),
          eq(payments.leagueId, leagueId),
        ));
        await tx.execute(sql`SELECT assert_owned_payment_source_applications(${organizationId}, ${leagueId}, ${tender.paymentId})`);
      });
    } catch (error) {
      failure = error;
    }
    const postgresCause = typeof failure === "object" && failure !== null && "cause" in failure
      ? (failure as { cause?: unknown }).cause
      : failure;
    expect(postgresCause).toMatchObject({
      code: "PWL01",
      constraint: "owned_payment_funding_ledger_guard",
    });
    expect(postgresCause instanceof Error ? postgresCause.message : String(postgresCause))
      .toContain("funding_conservation");
  });

  it("accepts a charged partner portion with a self debt-target selection", async () => {
    const tender = await createV4Tender(250);
    await db.transaction(async (tx) => {
      await assertOwnedPaymentTenderInTransaction(tx, {
        organizationId,
        leagueId,
        paymentId: tender.paymentId,
      });
    });
  });

  it("rejects cross-tender obligation over-allocation through the callable guard", async () => {
    const first = await createV4Tender(300);
    const second = await createV4Tender(300);
    let failure: unknown;
    try {
      await db.transaction(async (tx) => {
        await insertApplication(tx, { ...first, amountMinor: 300 });
        await insertApplication(tx, { ...second, amountMinor: 300 });
        await assertOwnedPaymentTenderInTransaction(tx, {
          organizationId,
          leagueId,
          paymentId: second.paymentId,
        });
      });
    } catch (error) {
      failure = error;
    }
    expect(isOwnedPaymentLedgerInvariantError(failure)).toBe(true);
    const postgresCause = typeof failure === "object" && failure !== null && "cause" in failure
      ? (failure as { cause?: unknown }).cause
      : failure;
    expect(postgresCause).toMatchObject({
      code: "PWL01",
      constraint: "owned_payment_tender_ledger_guard",
    });
    expect(postgresCause instanceof Error ? postgresCause.message : String(postgresCause))
      .toContain("obligation_overallocation");
    const allocations = await db.select({ id: paymentAllocations.id }).from(paymentAllocations).where(and(
      eq(paymentAllocations.organizationId, organizationId),
      eq(paymentAllocations.obligationId, obligationId),
    ));
    expect(allocations).toHaveLength(0);
  });

  it("rejects direct over-allocation when deferred database guards run at commit", async () => {
    const first = await createV4Tender(300);
    const second = await createV4Tender(300);
    let failure: unknown;
    try {
      await db.transaction(async (tx) => {
        await insertApplication(tx, { ...first, amountMinor: 300 });
        await insertApplication(tx, { ...second, amountMinor: 300 });
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    const postgresCause = typeof failure === "object" && failure !== null && "cause" in failure
      ? (failure as { cause?: unknown }).cause
      : failure;
    expect(postgresCause).toMatchObject({ code: "PWL01" });
    expect(postgresCause instanceof Error ? postgresCause.message : String(postgresCause))
      .toContain("obligation_overallocation");
    const allocations = await db.select({ id: paymentAllocations.id }).from(paymentAllocations).where(and(
      eq(paymentAllocations.organizationId, organizationId),
      eq(paymentAllocations.obligationId, obligationId),
    ));
    expect(allocations).toHaveLength(0);
  });

  it("accepts legacy standing V2 funding with matching payer participant evidence", async () => {
    const funding = await createLegacyStandingFunding();
    const stored = await db.select({ id: weeklyPaymentFundings.id }).from(weeklyPaymentFundings).where(and(
      eq(weeklyPaymentFundings.paymentId, funding.paymentId),
      eq(weeklyPaymentFundings.creditedBowlerId, funding.creditedBowlerId),
    ));
    expect(stored).toHaveLength(1);
  });

  it("reads legacy standing V2 recipient proof without writes and rejects supplied payments outside scope", async () => {
    const source = await createLegacyStandingFunding();
    const [payment] = await db.select().from(payments).where(and(
      eq(payments.id, source.paymentId),
      eq(payments.organizationId, organizationId),
      eq(payments.leagueId, leagueId),
    )).limit(1);
    if (!payment) throw new Error("legacy standing payment fixture was not found");
    const before = await db.select({ count: sql<number>`count(*)::int` }).from(weeklyPaymentFundings).where(and(
      eq(weeklyPaymentFundings.organizationId, organizationId),
      eq(weeklyPaymentFundings.leagueId, leagueId),
      eq(weeklyPaymentFundings.paymentId, source.paymentId),
    ));
    const proof = await db.transaction((tx) => readLegacyFundingAuthorizationInTransaction(tx, {
      organizationId,
      leagueId,
      paymentId: source.paymentId,
      payment,
    }), { isolationLevel: "repeatable read", accessMode: "read only" });
    expect(proof.portions).toMatchObject([{
      creditedBowlerId: source.creditedBowlerId,
      portionIndex: 0,
      amountMinor: 500,
      authorizationKind: "legacy_provider_snapshot",
      authorizationOperationId: source.operationId,
      authorizationItemCount: 1,
    }]);
    expect(proof.portions[0]?.authorizationItems).toHaveLength(1);
    for (const outOfScopePayment of [
      { ...payment, organizationId: organizationId + 1 },
      { ...payment, leagueId: leagueId + 1 },
      { ...payment, id: source.paymentId + 1 },
    ]) {
      await expect(db.transaction((tx) => readLegacyFundingAuthorizationInTransaction(tx, {
        organizationId,
        leagueId,
        paymentId: source.paymentId,
        payment: outOfScopePayment,
      }), { isolationLevel: "repeatable read", accessMode: "read only" }))
        .rejects.toMatchObject({ code: "LEGACY_PAYMENT_SCOPE_INVALID" });
    }
    const after = await db.select({ count: sql<number>`count(*)::int` }).from(weeklyPaymentFundings).where(and(
      eq(weeklyPaymentFundings.organizationId, organizationId),
      eq(weeklyPaymentFundings.leagueId, leagueId),
      eq(weeklyPaymentFundings.paymentId, source.paymentId),
    ));
    expect(after[0]?.count).toBe(before[0]?.count);
  });

  it.each(["ledger_adoption", "worksheet_correction"] as const)(
    "reopens a fully released owned obligation for %s evidence in the release transaction",
    async (reason) => {
      const debt = await createWorksheetDebt({
        amountMinor: 2_500,
        name: `Owned Release Reopen ${reason}`,
        bowlerId: creditedBowlerId,
        isolatedOccurrence: true,
      });
      const source = await createManualReceiptTender({
        amountMinor: 1_000,
        bowlerId: debt.bowlerId,
        occurrenceId: debt.occurrenceId,
        businessDate: debt.businessDate,
      });
      const application = await db.transaction((tx) => insertApplication(tx, {
        paymentId: source.paymentId,
        fundingId: source.fundingId,
        amountMinor: 1_000,
        creditedBowlerId: debt.bowlerId,
        obligationId: debt.obligationId,
        responsibilityId: debt.responsibilityId,
        occurrenceId: debt.occurrenceId,
      }));
      await db.update(paymentObligations).set({ state: "partially_settled" }).where(and(
        eq(paymentObligations.organizationId, organizationId),
        eq(paymentObligations.leagueId, leagueId),
        eq(paymentObligations.id, debt.obligationId),
      ));

      await db.transaction((tx) => releaseOwnedFundingApplicationInTransaction(tx, {
        organizationId,
        leagueId,
        applicationId: application.applicationId,
        actorUserId,
        reason,
        idempotencyKey: `owned-ledger-reopen-${reason}-${randomUUID()}`,
      }));

      const [obligation] = await db.select({ state: paymentObligations.state }).from(paymentObligations).where(eq(
        paymentObligations.id,
        debt.obligationId,
      ));
      expect(obligation?.state).toBe("open");
      const [release] = await db.select().from(weeklyPaymentAllocationReleases).where(eq(
        weeklyPaymentAllocationReleases.fundingApplicationId,
        application.applicationId,
      ));
      expect(release).toMatchObject({
        paymentId: source.paymentId,
        creditedBowlerId: debt.bowlerId,
        sourceAllocationId: application.allocationId,
        sourceObligationId: debt.obligationId,
        sourceApplicationAmountMinor: 1_000,
        releasedAmountMinor: 1_000,
        retainedAmountMinor: 0,
        replacementAllocationId: null,
        reason,
      });
      expect(release?.transactionId).toMatch(/^[0-9]+$/);
    },
  );

  it("rejects no-proof, stale, and other-obligation release evidence for partial-to-open updates", async () => {
    const createDebt = async (name: string) => createWorksheetDebt({
      amountMinor: 2_500,
      name,
      bowlerId: creditedBowlerId,
      isolatedOccurrence: true,
    });
    const createPartiallyCoveredDebt = async (name: string) => {
      const debt = await createDebt(name);
      const source = await createManualReceiptTender({
        amountMinor: 1_000,
        bowlerId: debt.bowlerId,
        occurrenceId: debt.occurrenceId,
        businessDate: debt.businessDate,
      });
      const application = await db.transaction((tx) => insertApplication(tx, {
        paymentId: source.paymentId,
        fundingId: source.fundingId,
        amountMinor: 1_000,
        creditedBowlerId: debt.bowlerId,
        obligationId: debt.obligationId,
        responsibilityId: debt.responsibilityId,
        occurrenceId: debt.occurrenceId,
      }));
      await db.update(paymentObligations).set({ state: "partially_settled" }).where(eq(
        paymentObligations.id,
        debt.obligationId,
      ));
      return { debt, application };
    };
    const setOpen = (tx: PaymentOperationTransaction, targetObligationId: string) => tx.update(paymentObligations)
      .set({ state: "open" })
      .where(and(
        eq(paymentObligations.organizationId, organizationId),
        eq(paymentObligations.leagueId, leagueId),
        eq(paymentObligations.id, targetObligationId),
      ));

    const setPartiallySettled = async (obligationId: string) => db.update(paymentObligations)
      .set({ state: "partially_settled" })
      .where(and(
        eq(paymentObligations.organizationId, organizationId),
        eq(paymentObligations.leagueId, leagueId),
        eq(paymentObligations.id, obligationId),
      ));

    const noProofTarget = await createDebt("No Proof Target");
    await setPartiallySettled(noProofTarget.obligationId);
    await expect(db.transaction((tx) => setOpen(tx, noProofTarget.obligationId))).rejects.toThrow();

    const staleSource = await createPartiallyCoveredDebt("Stale Release Source");
    await db.transaction((tx) => releaseOwnedFundingApplicationInTransaction(tx, {
      organizationId,
      leagueId,
      applicationId: staleSource.application.applicationId,
      actorUserId,
      reason: "ledger_adoption",
      idempotencyKey: `owned-ledger-stale-release-${randomUUID()}`,
    }));
    await setPartiallySettled(staleSource.debt.obligationId);
    await expect(db.transaction((tx) => setOpen(tx, staleSource.debt.obligationId))).rejects.toThrow();

    const wrongScopeSource = await createPartiallyCoveredDebt("Wrong Scope Release Source");
    const wrongScopeTarget = await createDebt("Wrong Scope Target");
    await setPartiallySettled(wrongScopeTarget.obligationId);
    await expect(db.transaction(async (tx) => {
      await releaseOwnedFundingApplicationInTransaction(tx, {
        organizationId,
        leagueId,
        applicationId: wrongScopeSource.application.applicationId,
        actorUserId,
        reason: "worksheet_correction",
        idempotencyKey: `owned-ledger-wrong-scope-release-${randomUUID()}`,
      });
      await setOpen(tx, wrongScopeTarget.obligationId);
    })).rejects.toThrow();

    const [staleObligation] = await db.select({ state: paymentObligations.state }).from(paymentObligations).where(eq(
      paymentObligations.id,
      staleSource.debt.obligationId,
    ));
    const [wrongScopeObligation] = await db.select({ state: paymentObligations.state }).from(paymentObligations).where(eq(
      paymentObligations.id,
      wrongScopeTarget.obligationId,
    ));
    const staleReleaseRows = await db.select({ id: weeklyPaymentAllocationReleases.id }).from(weeklyPaymentAllocationReleases).where(eq(
      weeklyPaymentAllocationReleases.fundingApplicationId,
      staleSource.application.applicationId,
    ));
    const wrongScopeReleaseRows = await db.select({ id: weeklyPaymentAllocationReleases.id }).from(weeklyPaymentAllocationReleases).where(eq(
      weeklyPaymentAllocationReleases.fundingApplicationId,
      wrongScopeSource.application.applicationId,
    ));
    expect(staleObligation?.state).toBe("partially_settled");
    expect(wrongScopeObligation?.state).toBe("partially_settled");
    expect(staleReleaseRows).toHaveLength(1);
    expect(wrongScopeReleaseRows).toHaveLength(0);
  });

  it("releases completed partially refunded rotating credit and reapplies only remaining value", async () => {
    const debt = await createWorksheetDebt({ amountMinor: 500, name: "Rotating Credit Correction Bowler" });
    const source = await createRotatingProviderFunding({ bowlerId: debt.bowlerId, amountMinor: 1_500 });
    const initialApplications = await db.transaction((tx) => applyOwnedFundingFifoInTransaction(tx, {
      organizationId,
      leagueId,
      bowlerId: debt.bowlerId,
      actorUserId,
    }));
    expect(initialApplications).toHaveLength(1);
    const [initialApplication] = await db.select({ id: paymentAllocationFundingApplications.id }).from(paymentAllocationFundingApplications).where(and(
      eq(paymentAllocationFundingApplications.organizationId, organizationId),
      eq(paymentAllocationFundingApplications.leagueId, leagueId),
      eq(paymentAllocationFundingApplications.rotatingFundingId, source.fundingId),
    ));
    expect(initialApplication).toBeDefined();

    const refund = await recordProviderCreditRefund({ fundingId: source.fundingId, outcome: "COMPLETED" });
    expect(refund).toMatchObject({ status: "succeeded", amountMinor: 1_000 });

    const correction = await db.transaction(async (tx) => {
      const retiredAt = new Date().toISOString();
      await releaseOwnedFundingApplicationInTransaction(tx, {
        organizationId,
        leagueId,
        applicationId: initialApplication.id,
        actorUserId,
        reason: "worksheet_correction",
        idempotencyKey: `owned-ledger-release-${randomUUID()}`,
      });
      await tx.update(occurrencePaymentResponsibilities).set({ state: "voided" }).where(eq(occurrencePaymentResponsibilities.id, debt.responsibilityId));
      await tx.update(paymentObligations).set({ state: "voided", voidedAt: retiredAt }).where(eq(paymentObligations.id, debt.obligationId));
      const [responsibility] = await tx.insert(occurrencePaymentResponsibilities).values({
        organizationId,
        leagueId,
        occurrenceId,
        teamId,
        slotId: null,
        slotIndex: null,
        positionIndex: null,
        responsibilityKey: debt.responsibilityKey,
        version: 2,
        state: "active",
        responsibilityKind: "worksheet",
        payerBowlerId: debt.bowlerId,
        mainBowlerId: null,
        substituteBowlerId: null,
        policy: null,
        worksheetFeeComponent: "full",
        amountMinor: 300,
        currency: "USD",
        dueAt: "2038-02-01T19:00:00.000Z",
        pastDueAt: "2038-02-08T19:00:00.000Z",
        recordedByUserId: actorUserId,
      }).returning({ id: occurrencePaymentResponsibilities.id });
      const [obligation] = await tx.insert(paymentObligations).values({
        organizationId,
        leagueId,
        occurrenceId,
        responsibilityId: responsibility.id,
        component: "full",
        payerBowlerId: debt.bowlerId,
        amountMinor: 300,
        currency: "USD",
        dueAt: "2038-02-01T19:00:00.000Z",
        pastDueAt: "2038-02-08T19:00:00.000Z",
        state: "open",
        createdByUserId: actorUserId,
      }).returning({ id: paymentObligations.id });
      const reapplied = await applyOwnedFundingFifoInTransaction(tx, {
        organizationId,
        leagueId,
        bowlerId: debt.bowlerId,
        actorUserId,
      });
      const applications = await tx.select({
        amountMinor: paymentAllocationFundingApplications.amountMinor,
        obligationId: paymentAllocationFundingApplications.obligationId,
      }).from(paymentAllocationFundingApplications).where(and(
        eq(paymentAllocationFundingApplications.organizationId, organizationId),
        eq(paymentAllocationFundingApplications.leagueId, leagueId),
        eq(paymentAllocationFundingApplications.rotatingFundingId, source.fundingId),
      ));
      const [balance] = await readRotatingCreditFundingBalancesInTransaction(tx, {
        organizationId,
        leagueId,
        bowlerId: debt.bowlerId,
      });
      return {
        replacementObligationId: obligation.id,
        reapplied,
        applications,
        balance,
      };
    });

    expect(correction.replacementObligationId).toBeDefined();
    expect(correction.reapplied).toHaveLength(1);
    expect(correction.applications).toHaveLength(2);
    expect(correction.applications.find((application) => application.obligationId === correction.replacementObligationId)?.amountMinor).toBe(300);
    expect(correction.balance).toMatchObject({
      amountMinor: 1_500,
      appliedMinor: 300,
      refundedMinor: 1_000,
      availableMinor: 200,
      reviewRequired: false,
    });

    const report = await readCanonicalPaymentReport({ organizationId, leagueId, paymentId: source.paymentId });
    const archivedRow = report.rows.find((row) => row.paymentId === source.paymentId);
    expect(archivedRow).toMatchObject({
      amountMinor: 1_500,
      allocatedMinor: 300,
      unallocatedMinor: 200,
      reviewRequired: false,
      unresolved: false,
      creditRefunds: { completedAmountMinor: 1_000, heldAmountMinor: 0, reviewRequired: false },
    });
    expect(archivedRow?.allocations.map((allocation) => ({
      bowlerId: allocation.bowlerId,
      amountMinor: allocation.amountMinor,
      state: allocation.state,
    })).sort((left, right) => right.amountMinor - left.amountMinor)).toEqual([
      { bowlerId: debt.bowlerId, amountMinor: 500, state: "voided" },
      { bowlerId: debt.bowlerId, amountMinor: 300, state: "active" },
    ]);
    expect(report.totals).toMatchObject({ grossConfirmedPaidMinor: 1_500, activeAllocatedMinor: 300, refundedMinor: 1_000 });
  });

  it("projects a typed rotating team-assignment beneficiary without a payer-bowler fallback", async () => {
    const [beneficiary] = await db.insert(bowlers).values({
      name: `Typed Assignment Beneficiary ${suffix}`,
      organizationId,
    }).returning({ id: bowlers.id });
    const [slot] = await db.insert(teamPaymentSlots).values({
      organizationId,
      leagueId,
      teamId,
      slotIndex: 0,
      lineupSize: 3,
      occupant: "unassigned",
      mainBowlerId: null,
      recordedByUserId: actorUserId,
    }).returning({ id: teamPaymentSlots.id });
    const { responsibilityId, obligationId } = await db.transaction(async (tx) => {
      const [responsibility] = await tx.insert(occurrencePaymentResponsibilities).values({
        organizationId,
        leagueId,
        occurrenceId,
        teamId,
        slotId: slot.id,
        slotIndex: 0,
        positionIndex: 0,
        responsibilityKind: "rotating",
        mainBowlerId: null,
        substituteBowlerId: null,
        payerBowlerId: null,
        policy: "main_pays_full",
        worksheetFeeComponent: null,
        amountMinor: 500,
        currency: "USD",
        dueAt: "2038-02-01T19:00:00.000Z",
        pastDueAt: "2038-02-08T19:00:00.000Z",
        recordedByUserId: actorUserId,
      }).returning({ id: occurrencePaymentResponsibilities.id });
      const [obligation] = await tx.insert(paymentObligations).values({
        organizationId,
        leagueId,
        occurrenceId,
        responsibilityId: responsibility.id,
        component: "full",
        payerBowlerId: null,
        amountMinor: 500,
        currency: "USD",
        dueAt: "2038-02-01T19:00:00.000Z",
        pastDueAt: "2038-02-08T19:00:00.000Z",
        state: "settled",
        createdByUserId: actorUserId,
      }).returning({ id: paymentObligations.id });
      await tx.insert(paymentObligationOwnerRevisions).values({
        organizationId,
        leagueId,
        obligationId: obligation.id,
        revisionNumber: 1,
        ownerKind: "team",
        ownerBowlerId: null,
        ownerTeamId: teamId,
        reason: "rotating_materialization",
        recordedByUserId: actorUserId,
      });
      return { responsibilityId: responsibility.id, obligationId: obligation.id };
    });
    const [assignment] = await db.insert(rotatingOccurrenceAssignments).values({
      organizationId,
      leagueId,
      occurrenceId,
      teamId,
      slotId: slot.id,
      slotIndex: 0,
      responsibilityId,
      version: 1,
      actualBowlerId: beneficiary.id,
      correctionReason: null,
      recordedByUserId: actorUserId,
    }).returning({ id: rotatingOccurrenceAssignments.id });
    const source = await createRotatingProviderFunding({ bowlerId: beneficiary.id, amountMinor: 500 });
    await db.transaction(async (tx) => {
      const [allocation] = await tx.insert(paymentAllocations).values({
        organizationId,
        leagueId,
        paymentId: source.paymentId,
        obligationId,
        amountMinor: 500,
        currency: "USD",
        state: "active",
        allocationKind: "rotating_credit",
        recordedByUserId: actorUserId,
      }).returning({ id: paymentAllocations.id });
      await tx.insert(paymentAllocationFundingApplications).values({
        organizationId,
        leagueId,
        allocationId: allocation.id,
        paymentId: source.paymentId,
        creditedBowlerId: beneficiary.id,
        genericFundingId: null,
        rotatingFundingId: source.fundingId,
        sourceAmountMinor: 500,
        amountMinor: 500,
        currency: "USD",
        obligationId,
        responsibilityId,
        occurrenceId,
        teamId,
        targetKind: "legacy_team_assignment",
        targetPayerBowlerId: null,
        assignmentId: assignment.id,
        appliedByUserId: actorUserId,
      });
    });

    const recipientReport = await readCanonicalPaymentReport({
      organizationId,
      leagueId,
      bowlerId: beneficiary.id,
      paymentId: source.paymentId,
    });
    expect(recipientReport.rows.find((row) => row.paymentId === source.paymentId)).toMatchObject({
      source: "canonical_allocation",
      allocatedMinor: 500,
      reviewRequired: false,
      unresolved: false,
      allocations: [{ bowlerId: beneficiary.id, amountMinor: 500, state: "active" }],
    });
  });

  it("accepts a V3 refund of an adopted legacy standing tender without a V4 account snapshot", async () => {
    const source = await createLegacyStandingFunding();
    const prepared = await prepareRefundPaymentOperation({
      paymentId: source.paymentId,
      disposition: "still_owed",
      reason: "refund adopted legacy standing tender",
      requestedByUserId: actorUserId,
      requestedByRole: "org_admin",
      requestedByOrganizationId: organizationId,
    });
    expect(prepared.snapshot.snapshotVersion).toBe(3);

    const lease = await acquirePaymentOperationLease({
      organizationId,
      operationId: prepared.operation.id,
      leaseOwner: `legacy-v3-refund-${suffix}`,
      leaseDurationMs: 60_000,
    });
    const leaseToken = lease?.leaseToken;
    if (!leaseToken) throw new Error("legacy V3 refund did not acquire an operation lease");
    const finalized = await finalizeRefundPaymentOperationSuccess({
      organizationId,
      operationId: prepared.operation.id,
      leaseToken,
      providerObjectId: `square-legacy-v3-refund-${randomUUID()}`,
    });
    expect(finalized.operation.status).toBe("succeeded");
    expect(finalized.payment).toMatchObject({ status: "refunded", squareRefundId: finalized.operation.providerObjectId });

    await db.transaction(async (tx) => {
      await assertOwnedPaymentTenderInTransaction(tx, {
        organizationId,
        leagueId,
        paymentId: source.paymentId,
      });
      const sources = await readOwnedGenericFundingSourcesByPaymentInTransaction(tx, {
        organizationId,
        leagueId,
        paymentId: source.paymentId,
      });
      expect(sources).toHaveLength(1);
      expect(sources[0]).toMatchObject({
        fundingId: source.fundingId,
        creditedBowlerId: source.creditedBowlerId,
        amountMinor: 500,
        availableMinor: 0,
        reviewRequired: false,
      });
    });
  });

  it("refunds a pure unallocated owned tender as credit without inventing allocations", async () => {
    const source = await createV4Tender(250);
    const prepared = await prepareRefundPaymentOperation({
      paymentId: source.paymentId,
      disposition: "waived",
      reason: "refund unused owned credit",
      requestedByUserId: actorUserId,
      requestedByRole: "org_admin",
      requestedByOrganizationId: organizationId,
    });
    if (prepared.snapshot.snapshotVersion !== 3) throw new Error("credit-only refund did not use V3");
    expect(prepared.snapshot.disposition).toBe("still_owed");
    expect(prepared.snapshot.allocations).toHaveLength(0);
    expect(prepared.snapshot.fundingSnapshot).toMatchObject([{ fundingId: source.fundingId, unusedCreditMinor: 250 }]);
    const replay = await prepareRefundPaymentOperation({
      paymentId: source.paymentId,
      disposition: "waived",
      reason: "refund unused owned credit",
      requestedByUserId: actorUserId,
      requestedByRole: "org_admin",
      requestedByOrganizationId: organizationId,
    });
    expect(replay.operation.id).toBe(prepared.operation.id);
    if (replay.snapshot.snapshotVersion !== 3) throw new Error("credit-only replay did not retain V3");
    expect(replay.snapshot.disposition).toBe("still_owed");

    const lease = await acquirePaymentOperationLease({
      organizationId,
      operationId: prepared.operation.id,
      leaseOwner: `unused-credit-refund-${suffix}`,
      leaseDurationMs: 60_000,
    });
    const leaseToken = lease?.leaseToken;
    if (!leaseToken) throw new Error("unused-credit refund did not acquire an operation lease");
    const finalized = await finalizeRefundPaymentOperationSuccess({
      organizationId,
      operationId: prepared.operation.id,
      leaseToken,
      providerObjectId: `square-unused-credit-refund-${randomUUID()}`,
    });
    expect(finalized.operation.status).toBe("succeeded");
    const sources = await db.transaction((tx) => readOwnedGenericFundingSourcesByPaymentInTransaction(tx, {
      organizationId,
      leagueId,
      paymentId: source.paymentId,
    }));
    expect(sources).toMatchObject([{ fundingId: source.fundingId, availableMinor: 0, reviewRequired: false }]);
  });

  it("keeps V4 source assertions valid while a V3 refund is pending or definitively no-effect", async () => {
    const source = await createV4Tender(500);
    const prepared = await prepareRefundPaymentOperation({
      paymentId: source.paymentId,
      disposition: "still_owed",
      reason: "refund retry boundary",
      requestedByUserId: actorUserId,
      requestedByRole: "org_admin",
      requestedByOrganizationId: organizationId,
    });
    await db.transaction((tx) => assertOwnedPaymentTenderInTransaction(tx, {
      organizationId,
      leagueId,
      paymentId: source.paymentId,
    }));

    const completedAt = new Date().toISOString();
    await db.update(paymentOperations).set({
      status: "failed_terminal",
      providerObjectId: null,
      errorClassification: "invalid_request",
      errorCode: "REFUND_FAILED",
      nextAttemptAt: null,
      completedAt,
      updatedAt: completedAt,
    }).where(and(
      eq(paymentOperations.id, prepared.operation.id),
      eq(paymentOperations.organizationId, organizationId),
      eq(paymentOperations.leagueId, leagueId),
    ));
    await db.transaction((tx) => assertOwnedPaymentTenderInTransaction(tx, {
      organizationId,
      leagueId,
      paymentId: source.paymentId,
    }));
    const [funding] = await db.transaction((tx) => readOwnedGenericFundingSourcesByPaymentInTransaction(tx, {
      organizationId,
      leagueId,
      paymentId: source.paymentId,
    }));
    expect(funding).toMatchObject({ availableMinor: 500, reviewRequired: false });
  });

  it("refunds a mixed spent and unused funding portion without returning refunded value to credit", async () => {
    const source = await createV4Tender(500);
    await db.transaction((tx) => insertApplication(tx, {
      paymentId: source.paymentId,
      fundingId: source.fundingId,
      amountMinor: 300,
      sourceAmountMinor: 500,
    }));
    const [application] = await db.select({ id: paymentAllocationFundingApplications.id })
      .from(paymentAllocationFundingApplications).where(and(
        eq(paymentAllocationFundingApplications.organizationId, organizationId),
        eq(paymentAllocationFundingApplications.leagueId, leagueId),
        eq(paymentAllocationFundingApplications.paymentId, source.paymentId),
        eq(paymentAllocationFundingApplications.genericFundingId, source.fundingId),
      ));
    expect(application).toBeDefined();
    const prepared = await prepareRefundPaymentOperation({
      paymentId: source.paymentId,
      disposition: "still_owed",
      reason: "refund mixed owned tender",
      requestedByUserId: actorUserId,
      requestedByRole: "org_admin",
      requestedByOrganizationId: organizationId,
    });
    if (prepared.snapshot.snapshotVersion !== 3) throw new Error("mixed account refund did not use V3");
    expect(prepared.snapshot.allocations).toHaveLength(1);
    expect(prepared.snapshot.fundingSnapshot).toMatchObject([{ fundingId: source.fundingId, unusedCreditMinor: 200 }]);

    const lease = await acquirePaymentOperationLease({
      organizationId,
      operationId: prepared.operation.id,
      leaseOwner: `mixed-owned-refund-${suffix}`,
      leaseDurationMs: 60_000,
    });
    const leaseToken = lease?.leaseToken;
    if (!leaseToken) throw new Error("mixed refund did not acquire an operation lease");
    const finalized = await finalizeRefundPaymentOperationSuccess({
      organizationId,
      operationId: prepared.operation.id,
      leaseToken,
      providerObjectId: `square-mixed-owned-refund-${randomUUID()}`,
    });
    expect(finalized.operation.status).toBe("succeeded");
    await db.transaction((tx) => releaseOwnedFundingApplicationInTransaction(tx, {
      organizationId,
      leagueId,
      applicationId: application.id,
      actorUserId,
      reason: "worksheet_correction",
      idempotencyKey: `owned-ledger-refunded-release-${randomUUID()}`,
    }));
    const beforeReplay = {
      tenders: await db.select({ id: payments.id }).from(payments).where(eq(payments.paymentOperationId, source.operationId)),
      fundings: await db.select({ id: weeklyPaymentFundings.id }).from(weeklyPaymentFundings).where(eq(weeklyPaymentFundings.paymentId, source.paymentId)),
      applications: await db.select({ id: paymentAllocationFundingApplications.id }).from(paymentAllocationFundingApplications).where(eq(paymentAllocationFundingApplications.paymentId, source.paymentId)),
    };
    const replay = await db.transaction((tx) => finalizeRosterSnapshotInTransaction(tx, {
      organizationId,
      leagueId,
      operationId: source.operationId,
      now: new Date().toISOString(),
      actorUserId,
    }));
    expect(replay).toEqual({ finalized: true, allocationIds: [] });
    expect(await db.select({ id: payments.id }).from(payments).where(eq(payments.paymentOperationId, source.operationId))).toEqual(beforeReplay.tenders);
    expect(await db.select({ id: weeklyPaymentFundings.id }).from(weeklyPaymentFundings).where(eq(weeklyPaymentFundings.paymentId, source.paymentId))).toEqual(beforeReplay.fundings);
    expect(await db.select({ id: paymentAllocationFundingApplications.id }).from(paymentAllocationFundingApplications).where(eq(paymentAllocationFundingApplications.paymentId, source.paymentId))).toEqual(beforeReplay.applications);
    const sources = await db.transaction(async (tx) => {
      await assertOwnedPaymentTenderInTransaction(tx, {
        organizationId,
        leagueId,
        paymentId: source.paymentId,
      });
      return readOwnedGenericFundingSourcesByPaymentInTransaction(tx, {
        organizationId,
        leagueId,
        paymentId: source.paymentId,
      });
    });
    expect(sources).toMatchObject([{ fundingId: source.fundingId, availableMinor: 0, reviewRequired: false }]);

    const adminReport = await readCanonicalPaymentReport({ organizationId, leagueId, paymentId: source.paymentId });
    const archivedRow = adminReport.rows.find((row) => row.paymentId === source.paymentId);
    expect(archivedRow).toMatchObject({
      amountMinor: 500,
      allocatedMinor: 0,
      refund: { present: true, amountMinor: 500 },
      fundingPortions: [{
        fundingId: source.fundingId,
        creditedBowlerId,
        amountMinor: 500,
        availableMinor: 0,
        appliedMinor: 300,
        refundedCreditMinor: 200,
        totalRefundedMinor: 500,
      }],
    });
    expect(adminReport.totals).toMatchObject({ grossConfirmedPaidMinor: 500, refundedMinor: 500, activeAllocatedMinor: 0 });

    const creditedRecipientReport = await readCanonicalPaymentReport({
      organizationId,
      leagueId,
      bowlerId: creditedBowlerId,
      paymentId: source.paymentId,
    });
    expect(creditedRecipientReport.rows.find((row) => row.paymentId === source.paymentId)).toMatchObject({
      amountMinor: 500,
      refund: { present: true, amountMinor: 500 },
      fundingPortions: [{ totalRefundedMinor: 500, refundedCreditMinor: 200, appliedMinor: 300 }],
    });
    expect(creditedRecipientReport.totals).toMatchObject({ grossConfirmedPaidMinor: 500, refundedMinor: 500, activeAllocatedMinor: 0 });
  });

  it("keeps a disputed V4 tender in gross history while its credit stays held", async () => {
    const source = await createV4Tender(500);
    const now = new Date().toISOString();
    const providerDisputeId = `owned-ledger-dispute-${randomUUID()}`;
    const [event] = await db.insert(webhookEvents).values({
      provider: "square",
      providerEventId: `owned-ledger-dispute-event-${randomUUID()}`,
      eventType: "payment.dispute.created",
      providerCreatedAt: now,
      organizationId,
      locationId,
      providerApplicationId: "owned-ledger-test-app",
      providerMerchantId: "owned-ledger-test-merchant",
      providerLocationId: "owned-ledger-test-provider-location",
      providerObjectType: "dispute",
      providerObjectId: providerDisputeId,
      providerPaymentId: source.providerPaymentId,
      providerObjectVersion: 1,
      providerObjectUpdatedAt: now,
      providerApiVersion: "2026-05-20",
      payloadHash: "a".repeat(64),
      encryptedPayload: "owned-ledger-test-encrypted-webhook",
      status: "processed",
      processedAt: now,
      completedAt: now,
    }).returning({ id: webhookEvents.id });
    await db.insert(paymentDisputes).values({
      organizationId,
      locationId,
      paymentOperationId: source.operationId,
      provider: "square",
      providerApplicationId: "owned-ledger-test-app",
      providerMerchantId: "owned-ledger-test-merchant",
      providerLocationId: "owned-ledger-test-provider-location",
      providerDisputeId,
      providerPaymentId: source.providerPaymentId,
      amountMinor: 500,
      currency: "USD",
      reason: "NO_KNOWLEDGE",
      state: "PROCESSING",
      responseDueAt: null,
      cardBrand: null,
      brandDisputeId: null,
      providerCreatedAt: now,
      providerReportedAt: null,
      providerUpdatedAt: now,
      providerVersion: 1,
      firstWebhookEventId: event.id,
      lastWebhookEventId: event.id,
      createdAt: now,
      updatedAt: now,
    });

    const [lot] = await db.transaction((tx) => readGenericFundingAvailabilityInTransaction(tx, {
      organizationId,
      leagueId,
      paymentIds: [source.paymentId],
    }));
    expect(lot).toMatchObject({
      fundingId: source.fundingId,
      paymentId: source.paymentId,
      amountMinor: 500,
      receivedMinor: 500,
      availableMinor: 0,
      receiptEvidenceInvalid: false,
      reviewRequired: true,
    });

    const report = await readCanonicalPaymentReport({ organizationId, leagueId, paymentId: source.paymentId });
    const archivedRow = report.rows.find((row) => row.paymentId === source.paymentId);
    expect(archivedRow).toMatchObject({
      amountMinor: 500,
      status: "review_required",
      source: "held_credit",
      allocatedMinor: 0,
      unallocatedMinor: 0,
      reviewRequired: true,
      dispute: { present: true, amountMinor: 500, state: "PROCESSING", reviewRequired: true },
      fundingPortions: [{ amountMinor: 500, availableMinor: 0, heldCreditMinor: 500, reviewRequired: true }],
    });
    expect(report.transactions.find((transaction) => transaction.paymentIds.includes(source.paymentId))?.amountMinor).toBe(500);
    expect(report.totals).toMatchObject({ reviewRequiredMinor: 500, disputedReviewRequiredMinor: 500, activeAllocatedMinor: 0 });
  });

  it("holds an owned tender when a terminal refund still has an ambiguous provider ID", async () => {
    const source = await createV4Tender(500);
    const application = await db.transaction((tx) => insertApplication(tx, {
      paymentId: source.paymentId,
      fundingId: source.fundingId,
      amountMinor: 300,
      sourceAmountMinor: 500,
    }));
    const prepared = await prepareRefundPaymentOperation({
      paymentId: source.paymentId,
      disposition: "still_owed",
      reason: "refund outcome remains ambiguous",
      requestedByUserId: actorUserId,
      requestedByRole: "org_admin",
      requestedByOrganizationId: organizationId,
    });
    const completedAt = new Date().toISOString();
    await db.update(paymentOperations).set({
      status: "failed_terminal",
      providerObjectId: `square-ambiguous-refund-${randomUUID()}`,
      errorClassification: "invalid_request",
      errorCode: null,
      nextAttemptAt: null,
      completedAt,
      updatedAt: completedAt,
    }).where(and(
      eq(paymentOperations.id, prepared.operation.id),
      eq(paymentOperations.organizationId, organizationId),
      eq(paymentOperations.leagueId, leagueId),
    ));

    const [funding] = await db.transaction((tx) => readOwnedGenericFundingSourcesByPaymentInTransaction(tx, {
      organizationId,
      leagueId,
      paymentId: source.paymentId,
    }));
    expect(funding).toMatchObject({ availableMinor: 0, reviewRequired: true });
    await expect(db.transaction((tx) => releaseOwnedFundingApplicationInTransaction(tx, {
      organizationId,
      leagueId,
      applicationId: application.applicationId,
      actorUserId,
      reason: "worksheet_correction",
      idempotencyKey: `owned-ledger-ambiguous-release-${randomUUID()}`,
    }))).rejects.toMatchObject({ code: "FUNDING_SOURCE_REQUIRES_REVIEW" });
  });

  it.each(["PENDING", "UNKNOWN"] as const)("holds rotating source credit while a provider refund is %s", async (outcome) => {
    const debt = await createWorksheetDebt({ amountMinor: 500, name: `Rotating Credit Held Refund ${outcome}` });
    const source = await createRotatingProviderFunding({ bowlerId: debt.bowlerId, amountMinor: 1_500 });
    await db.transaction((tx) => applyOwnedFundingFifoInTransaction(tx, {
      organizationId,
      leagueId,
      bowlerId: debt.bowlerId,
      actorUserId,
    }));
    const refund = await recordProviderCreditRefund({ fundingId: source.fundingId, outcome });
    expect(refund.status).toBe(outcome === "PENDING" ? "retry_scheduled" : "provider_unknown");
    const [application] = await db.select({ id: paymentAllocationFundingApplications.id }).from(paymentAllocationFundingApplications).where(and(
      eq(paymentAllocationFundingApplications.organizationId, organizationId),
      eq(paymentAllocationFundingApplications.leagueId, leagueId),
      eq(paymentAllocationFundingApplications.rotatingFundingId, source.fundingId),
    ));
    await expect(db.transaction((tx) => releaseOwnedFundingApplicationInTransaction(tx, {
      organizationId,
      leagueId,
      applicationId: application.id,
      actorUserId,
      reason: "worksheet_correction",
      idempotencyKey: `owned-ledger-held-release-${randomUUID()}`,
    }))).rejects.toMatchObject({ code: "FUNDING_SOURCE_REQUIRES_REVIEW" });
    const [balance] = await db.transaction((tx) => readRotatingCreditFundingBalancesInTransaction(tx, {
      organizationId,
      leagueId,
      bowlerId: debt.bowlerId,
    }));
    expect(balance).toMatchObject({ refundHeldMinor: 1_000, availableMinor: 0, reviewRequired: false });
  });
});
