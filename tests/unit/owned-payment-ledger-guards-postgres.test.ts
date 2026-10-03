import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
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
  payments,
  rotatingCreditFundings,
  rotatingCreditRefundOperationSnapshots,
  rotatingCreditRefunds,
  teams,
  users,
  weeklyPaymentFundings,
  weeklyPaymentLedgerAdoptions,
  weeklyPaymentWeekConfirmations,
} from "@shared/schema";
import type { PaymentOperationTransaction } from "../../server/storage/payment-operations";
import {
  applyOwnedFundingFifoInTransaction,
  assertOwnedPaymentTenderInTransaction,
  isOwnedPaymentLedgerInvariantError,
  recordOwnedFundingInTransaction,
  releaseOwnedFundingApplicationInTransaction,
} from "../../server/services/owned-payment-ledger";
import { prepareRotatingCreditPaymentOperation } from "../../server/services/rotating-credit-operation-preparation";
import { quoteRotatingCreditRefund, recordRotatingCreditRefund } from "../../server/services/rotating-credit-refund";
import { RefundPaymentOperationExecutor } from "../../server/services/refund-payment-operation-executor";
import { PaymentProviderError } from "../../server/services/payment-errors";
import type { PaymentProvider } from "../../server/services/payment-provider";
import { readRotatingCreditFundingBalancesInTransaction } from "../../server/services/rotating-credit-applications";
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
  const operationId = randomUUID();
  const fingerprint = `lvaccountfunding:v4:${randomUUID().replaceAll("-", "").repeat(2)}`;
  const providerPaymentId = `owned-ledger-provider-${operationId}`;
  const now = new Date().toISOString();
  return db.transaction(async (tx) => {
    await tx.insert(paymentOperations).values({
      id: operationId,
      organizationId,
      leagueId,
      authorizingUserId: actorUserId,
      operationType: "interactive_charge",
      targetKey: `interactive-charge:owned-ledger-${operationId}`,
      amountMinor,
      currency: "USD",
      requestFingerprint: `lvpayreq:v1:${"f".repeat(64)}`,
      providerIdempotencyKey: `owned-ledger-${randomUUID()}`.slice(0, 45),
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
    await tx.insert(accountPaymentOperationSnapshots).values({
      operationId,
      organizationId,
      leagueId,
      snapshotVersion: 4,
      snapshotKind: "interactive_funding",
      payerBowlerId,
      amountMinor,
      fundingPortions: [{ portionIndex: 0, creditedBowlerId, amountMinor }],
      // The payer is explicitly selected for zero dollars while the linked
      // partner owns the only positive tender portion.
      recipientEvidence: [
        {
          recipientBowlerId: payerBowlerId,
          role: "self",
          paymentLinkId: null,
          linkFingerprint: null,
          selection: { kind: "explicit_amount", amountMinor: 0 },
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
      requestKind: "direct",
      sourceKind: "new_card",
      encryptedSourceId: "fixture-encrypted-source",
      encryptedCustomerId: null,
      encryptedBuyerEmail: null,
      storeCard: false,
      quoteFingerprint: `lvaccountfundquote:v4:${"2".repeat(64)}`,
      snapshotFingerprint: fingerprint,
      createdAt: now,
    });
    const [payment] = await tx.insert(payments).values({
      organizationId,
      leagueId,
      bowlerId: payerBowlerId,
      amount: amountMinor,
      currency: "USD",
      status: "paid",
      type: "square",
      providerPaymentId,
      paymentOperationId: operationId,
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
      authorizationOperationId: operationId,
      authorizationItemCount: 0,
      authorizationFingerprint: fingerprint,
      adoptionId: null,
      recordedByUserId: actorUserId,
      now,
    });
    return { paymentId: payment.id, fundingId: funding.id };
  });
}

async function createWorksheetDebt(input: { amountMinor: number; name: string }) {
  const [bowler] = await db.insert(bowlers).values({
    name: `${input.name} ${suffix}`,
    organizationId,
  }).returning({ id: bowlers.id });
  const [responsibility] = await db.insert(occurrencePaymentResponsibilities).values({
    organizationId,
    leagueId,
    occurrenceId,
    teamId,
    slotId: null,
    slotIndex: null,
    positionIndex: null,
    responsibilityKind: "worksheet",
    payerBowlerId: bowler.id,
    mainBowlerId: null,
    substituteBowlerId: null,
    policy: null,
    worksheetFeeComponent: "full",
    amountMinor: input.amountMinor,
    currency: "USD",
    dueAt: "2038-02-01T19:00:00.000Z",
    pastDueAt: "2038-02-08T19:00:00.000Z",
    recordedByUserId: actorUserId,
  }).returning({ id: occurrencePaymentResponsibilities.id, responsibilityKey: occurrencePaymentResponsibilities.responsibilityKey });
  const [obligation] = await db.insert(paymentObligations).values({
    organizationId,
    leagueId,
    occurrenceId,
    responsibilityId: responsibility.id,
    component: "full",
    payerBowlerId: bowler.id,
    amountMinor: input.amountMinor,
    currency: "USD",
    dueAt: "2038-02-01T19:00:00.000Z",
    pastDueAt: "2038-02-08T19:00:00.000Z",
    state: "open",
    createdByUserId: actorUserId,
  }).returning({ id: paymentObligations.id });
  return { bowlerId: bowler.id, responsibilityId: responsibility.id, responsibilityKey: responsibility.responsibilityKey, obligationId: obligation.id };
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

async function createLegacyStandingFunding(): Promise<{ paymentId: number; fundingId: string; operationId: string }> {
  const now = new Date().toISOString();
  const cutoffAt = "2038-02-01T19:00:00.000Z";
  const operationId = randomUUID();
  const providerPaymentId = `owned-ledger-standing-payment-${operationId}`;
  const snapshotFingerprint = `lvstandingcutoff:v1:${"5".repeat(64)}`;
  return db.transaction(async (tx) => {
  const [consent] = await tx.insert(autopayConsents).values({
    organizationId,
    leagueId,
    payerBowlerId: creditedBowlerId,
    consentVersion: 1,
    state: "active",
    paymentMode: "weekly",
    consentFingerprint: `lvstandingconsent:v1:${"6".repeat(64)}`,
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
    obligations: [{ allocationIndex: 0, obligationId, payerBowlerId: creditedBowlerId, amountMinor: 500 }],
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
    consentVersion: 1,
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
    obligationId,
    bowlerId: creditedBowlerId,
    role: "payer",
    paymentLinkId: null,
    linkFingerprint: null,
    consentVersion: 1,
    createdAt: now,
  });
  await tx.insert(paymentOperationRosterSnapshotItems).values({
    operationId,
    organizationId,
    leagueId,
    obligationId,
    allocationIndex: 0,
    amountMinor: 500,
    state: "finalized",
    createdAt: now,
  });
  const [payment] = await tx.insert(payments).values({
    organizationId,
    leagueId,
    bowlerId: creditedBowlerId,
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
    creditedBowlerId,
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
  await insertApplication(tx, { paymentId: payment.id, fundingId: funding.id, amountMinor: 500 });
  return { paymentId: payment.id, fundingId: funding.id, operationId };
  });
}

async function insertApplication(
  tx: PaymentOperationTransaction,
  input: { paymentId: number; fundingId: string; amountMinor: number; creditedBowlerId?: number; obligationId?: string; responsibilityId?: string },
) {
  const payerBowlerId = input.creditedBowlerId ?? creditedBowlerId;
  const targetObligationId = input.obligationId ?? obligationId;
  const targetResponsibilityId = input.responsibilityId ?? responsibilityId;
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
    sourceAmountMinor: input.amountMinor,
    amountMinor: input.amountMinor,
    currency: "USD",
    obligationId: targetObligationId,
    responsibilityId: targetResponsibilityId,
    occurrenceId,
    teamId,
    targetKind: "bowler_responsibility",
    targetPayerBowlerId: payerBowlerId,
    assignmentId: null,
    appliedByUserId: actorUserId,
  }).returning({ id: paymentAllocationFundingApplications.id });
  return { applicationId: application.id, allocationId: allocation.id };
}

describe("owned payment SQL guards on PostgreSQL", () => {
  it("accepts a charged partner portion with additional zero-charge self evidence", async () => {
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
      eq(weeklyPaymentFundings.creditedBowlerId, creditedBowlerId),
    ));
    expect(stored).toHaveLength(1);
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
