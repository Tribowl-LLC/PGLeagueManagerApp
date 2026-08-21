import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { getTestDb, getTestPool } from "../setup/test-db";
import { makeF3WorkflowFixture } from "../helpers/f3-workflow-fixture";
import { deleteOrganization } from "../../server/storage/organizations";
import {
  canonicalAutopayExecutionSnapshots,
  f3PayerAuthorizations,
  bowlerLeagues,
  bowlerPaymentLinks,
  leagueOccurrences,
  locations,
  leagues,
  occurrenceCollectionPlanRevisions,
  occurrenceCollectionPlans,
  occurrenceCollectionPlanItems,
  paymentOperationOccurrenceSnapshotAllocations,
  paymentOperations,
  paymentOccurrenceAllocations,
  paymentDisputes,
  payments,
  bowlerOccurrenceObligations,
  bowlers,
  webhookEvents,
} from "@shared/schema";
import {
  acquireCanonicalAutopayDispatchCutoff,
  acquirePaymentOperationLease,
  finalizeChargeFromWebhookEvidenceInTransaction,
  finalizePaymentOperationSuccess,
  reconcilePaymentOperationSuccess,
  recordPaymentOperationReconciliationRequired,
} from "../../server/storage/payment-operations";
import { PaymentProviderError } from "../../server/services/payment-errors";
import { readCanonicalPaymentReport, readPaymentReceiptProjection } from "../../server/services/canonical-payment-report";

vi.hoisted(() => {
  process.env.LEAGUEVAULT_F3_CANONICAL_AUTOPAY_ENABLED = "1";
  process.env.LEAGUEVAULT_F4_CANONICAL_AUTOPAY_EXECUTION_ENABLED = "1";
  return null;
});

const provider = vi.hoisted(() => {
  return {
  providerName: "square",
  requests: [] as string[],
  providerLocations: [] as string[],
  status: String("COMPLETED"),
  resultId: "f4-test-payment-1",
  cardValid: true,
  factoryAvailable: true,
  transientFailures: 0,
  beforeResolve: null as (() => Promise<void>) | null,
  async processPayment(_source: string, _amount: number, _storeCard?: boolean, _customer?: string, _email?: string, identity?: { paymentKey?: string; providerLocationId?: string } | string) {
    this.requests.push(typeof identity === "string" ? identity : identity?.paymentKey ?? "missing-key");
    this.providerLocations.push(typeof identity === "string" ? "" : identity?.providerLocationId ?? "missing-location");
    if (this.transientFailures > 0) {
      this.transientFailures -= 1;
      throw new PaymentProviderError("temporary provider outage", "TEMPORARY_FAILURE", undefined, { disposition: "transient", providerCode: "TEMPORARY_FAILURE" });
    }
    if (this.beforeResolve) await this.beforeResolve();
    return { id: this.resultId, status: this.status, orderId: "f4-test-order-1", receiptUrl: "https://square.test/receipt" };
  },
  validateCardId(cardId: string | null) { return this.cardValid && cardId?.startsWith("ccof:") === true; },
  async hasCardOnFile(_customer: string, _card: string) { return true; },
  };
});

vi.mock("../../server/services/payment-provider-factory.js", () => ({
  getPaymentProvider: vi.fn(async () => {
    if (!provider.factoryAvailable) {
      const { ProviderNotConfiguredError } = await import("../../server/services/payment-errors.js");
      throw new ProviderNotConfiguredError("provider unavailable", null);
    }
    return provider;
  }),
}));

const db = getTestDb();
const createdOrganizations: number[] = [];

async function waitForAdvisoryWaiter(organizationId: number, leagueId: number, minimum = 1): Promise<void> {
  const client = await getTestPool().connect();
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await client.query<{ waiting: string }>(
        "SELECT count(*)::text AS waiting FROM pg_locks WHERE locktype = 'advisory' AND classid = $1::oid AND objid = $2::oid AND granted = false",
        [organizationId, leagueId],
      );
      if (Number(result.rows[0]?.waiting ?? 0) >= minimum) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    client.release();
  }
  throw new Error("timed out waiting for canonical advisory-lock waiter");
}

async function makeCanonicalFixture(options: { twoCollectionPoints?: boolean } = {}) {
  const fixture = await makeF3WorkflowFixture();
  createdOrganizations.push(fixture.organizationId);
  await db.update(bowlers).set({ paymentCustomerId: "f4-customer", paymentProviderLocationId: fixture.locationId }).where(and(eq(bowlers.id, fixture.roster[0].id), eq(bowlers.organizationId, fixture.organizationId)));
  const providerLocationId = `f4-test-location-${fixture.locationId}`;
  await db.update(locations).set({ squareCredentials: { appId: "f4-test-app", accessToken: "f4-test-token", locationId: providerLocationId } }).where(and(eq(locations.id, fixture.locationId), eq(locations.organizationId, fixture.organizationId)));
  const workflow = await import("../../server/services/f3-workflow");
  const policyInput = {
    organizationId: fixture.organizationId,
    leagueId: fixture.leagueId,
    activationId: fixture.activationId,
    activationRevision: 1,
    activationSourceFingerprint: fixture.activationSourceFingerprint,
    policyVersion: 1,
    collectionPoints: options.twoCollectionPoints
      ? fixture.occurrenceIds.map((occurrenceId) => ({ occurrenceId }))
      : [{ occurrenceId: fixture.occurrenceIds[1] }],
    occurrences: [
      options.twoCollectionPoints
        ? { occurrenceId: fixture.occurrenceIds[0], groupKey: "f4-first", groupRole: "normal" as const, pairedOccurrenceId: null, collectionPoint: { occurrenceId: fixture.occurrenceIds[0] } }
        : { occurrenceId: fixture.occurrenceIds[0], groupKey: "f4-double", groupRole: "paired" as const, pairedOccurrenceId: fixture.occurrenceIds[1], collectionPoint: { occurrenceId: fixture.occurrenceIds[1] } },
      options.twoCollectionPoints
        ? { occurrenceId: fixture.occurrenceIds[1], groupKey: "f4-second", groupRole: "normal" as const, pairedOccurrenceId: null, collectionPoint: { occurrenceId: fixture.occurrenceIds[1] } }
        : { occurrenceId: fixture.occurrenceIds[1], groupKey: "f4-double", groupRole: "trigger" as const, pairedOccurrenceId: fixture.occurrenceIds[0], collectionPoint: { occurrenceId: fixture.occurrenceIds[1] } },
    ],
  };
  const draft = await workflow.createF3Policy({ ...policyInput, actorUserId: fixture.actorUserId, commandKey: `f4-policy-${fixture.organizationId}` });
  const approved = await workflow.approveF3Policy({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, policyId: draft.id, actorUserId: fixture.actorUserId });
  const quote = await workflow.readF3PreauthorizationQuote({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, payerBowlerId: fixture.roster[0].id, coveredBowlerIds: fixture.roster.slice(0, 2).map((row) => row.id) });
  const authorization = await workflow.authorizeF3Payer({
    organizationId: fixture.organizationId,
    leagueId: fixture.leagueId,
    payerBowlerId: fixture.roster[0].id,
    policyId: approved.id,
    policyVersion: approved.policyVersion,
    coveredBowlerIds: quote.authorization.coveredBowlerIds,
    acceptedPartnerIds: quote.authorization.acceptedPartnerIds,
    paymentMethodFingerprint: "a".repeat(64),
    locationId: fixture.locationId,
    collectionPointOccurrenceIds: quote.authorization.collectionPointOccurrenceIds,
    timing: "at_collection_point",
    preauthorizationFingerprint: quote.fingerprint,
    authorizedItems: quote.items,
    sourceId: "ccof:f4-test-card",
    customerId: "f4-customer",
    actorUserId: fixture.actorUserId,
    providerValidated: true,
    payerOwnedPaymentMethod: true,
    leagueLocationId: fixture.locationId,
    commandKey: `f4-auth-${fixture.organizationId}`,
  });
  const plan = authorization.plans?.[0] as { id: string } | undefined;
  if (!plan) throw new Error("F4 fixture did not persist a D2 plan");
  const siblingPlan = authorization.plans?.[1] as { id: string } | undefined;
  return { fixture, planId: plan.id, ...(siblingPlan ? { siblingPlanId: siblingPlan.id } : {}), providerLocationId, now: new Date("2038-02-02T19:00:00.000Z") };
}

afterEach(async () => {
  for (const organizationId of createdOrganizations.splice(0)) await deleteOrganization(organizationId).catch(() => undefined);
  provider.requests.length = 0;
  provider.providerLocations.length = 0;
  provider.status = "COMPLETED";
  provider.resultId = "f4-test-payment-1";
  provider.cardValid = true;
  provider.factoryAvailable = true;
  provider.transientFailures = 0;
  provider.beforeResolve = null;
});

describe("F4 canonical autopay PostgreSQL/provider integration", () => {
  it("prepares and atomically settles a combined charge with exact conservation evidence", async () => {
    const { fixture, planId, providerLocationId, now } = await makeCanonicalFixture();
    const { prepareCanonicalAutopayPlan } = await import("../../server/services/canonical-autopay-preparation");
    const { executeCanonicalAutopayOperation } = await import("../../server/services/canonical-autopay-operation-executor");
    const prepared = await prepareCanonicalAutopayPlan({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, d2PlanId: planId, now });
    expect(prepared.kind).toBe("prepared");
    if (!prepared.operation) throw new Error("F4 operation was not prepared");
    await executeCanonicalAutopayOperation({ organizationId: fixture.organizationId, operationId: prepared.operation.id, now });
    const [operation] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, prepared.operation.id));
    const plan = (await db.select().from(occurrenceCollectionPlans).where(eq(occurrenceCollectionPlans.id, planId)))[0];
    const linkedPayments = await db.select().from(payments).where(eq(payments.paymentOperationId, prepared.operation.id));
    const allocations = await db.select().from(paymentOccurrenceAllocations).where(eq(paymentOccurrenceAllocations.organizationId, fixture.organizationId));
    const obligations = await db.select().from(bowlerOccurrenceObligations).where(eq(bowlerOccurrenceObligations.organizationId, fixture.organizationId));
    expect(operation?.status).toBe("succeeded");
    expect(provider.requests).toHaveLength(1);
    expect(provider.providerLocations).toEqual([providerLocationId]);
    expect(linkedPayments).toHaveLength(2);
    expect(linkedPayments.reduce((sum, row) => sum + row.amount, 0)).toBe(operation?.amountMinor);
    expect(allocations).toHaveLength(4);
    expect(obligations.filter((row) => row.state === "settled")).toHaveLength(4);
    expect(plan?.state).toBe("fulfilled");
    expect(await db.select().from(occurrenceCollectionPlanRevisions).where(eq(occurrenceCollectionPlanRevisions.planId, planId))).toHaveLength(2);

    const [disputeEvent] = await db.insert(webhookEvents).values({
      provider: "square",
      providerEventId: `f4-dispute-${fixture.organizationId}`,
      eventType: "payment.dispute.created",
      providerCreatedAt: now.toISOString(),
      organizationId: fixture.organizationId,
      locationId: fixture.locationId,
      providerApplicationId: "f4-test-app",
      providerMerchantId: "f4-test-merchant",
      providerLocationId,
      providerObjectType: "dispute",
      providerObjectId: `f4-dispute-object-${fixture.organizationId}`,
      providerPaymentId: "f4-test-payment-1",
      providerApiVersion: "2024-01",
      payloadHash: "a".repeat(64),
      encryptedPayload: "f4-test-payload",
    }).returning({ id: webhookEvents.id });
    if (!disputeEvent) throw new Error("F4 dispute webhook fixture missing");
    await db.insert(paymentDisputes).values({
      organizationId: fixture.organizationId,
      locationId: fixture.locationId,
      paymentOperationId: prepared.operation.id,
      provider: "square",
      providerApplicationId: "f4-test-app",
      providerMerchantId: "f4-test-merchant",
      providerLocationId,
      providerDisputeId: `f4-dispute-${fixture.organizationId}`,
      providerPaymentId: "f4-test-payment-1",
      amountMinor: prepared.operation.amountMinor,
      currency: prepared.operation.currency,
      reason: "CUSTOMER_REQUESTS_CREDIT",
      state: "EVIDENCE_REQUIRED",
      providerCreatedAt: now.toISOString(),
      providerUpdatedAt: now.toISOString(),
      providerVersion: 1,
      firstWebhookEventId: disputeEvent.id,
      lastWebhookEventId: disputeEvent.id,
    });
    const payerBowler = fixture.roster[0];
    const partnerBowler = fixture.roster[1];
    if (!payerBowler || !partnerBowler) throw new Error("F4 dispute fixture participants missing");
    const payerReport = await readCanonicalPaymentReport({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, bowlerId: payerBowler.id, limit: 10 });
    const partnerReport = await readCanonicalPaymentReport({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, bowlerId: partnerBowler.id, limit: 10 });
    expect(payerReport.totals.disputedReviewRequiredMinor).toBe(prepared.operation.amountMinor);
    expect(partnerReport.totals.disputedReviewRequiredMinor).toBe(0);

    const linkedPayment = linkedPayments[0];
    if (!linkedPayment) throw new Error("F4 linked payment was not persisted");
    const receiptProjection = await readPaymentReceiptProjection({
      organizationId: fixture.organizationId,
      paymentId: linkedPayment.id,
    });
    expect(receiptProjection.payment.id).toBe(linkedPayment.id);
    expect(receiptProjection.row.paymentId).toBe(linkedPayment.id);
    expect(receiptProjection.row.paymentTiming).toMatchObject({ source: "canonical_activation", paymentMode: "weekly" });
    expect(receiptProjection.row.collectionEvidence).toMatchObject({
      d2PlanId: planId,
      grouping: "double_pay",
      timing: "at_collection_point",
      coveredOccurrenceIds: expect.arrayContaining(fixture.occurrenceIds.slice(0, 2)),
    });
    expect(receiptProjection.report.fingerprint).toMatch(/^lvpaymentreport:v1:/);
  });

  it("returns exact normal collection evidence for a separate collection-point plan", async () => {
    const { fixture, planId, now } = await makeCanonicalFixture({ twoCollectionPoints: true });
    const { prepareCanonicalAutopayPlan } = await import("../../server/services/canonical-autopay-preparation");
    const { executeCanonicalAutopayOperation } = await import("../../server/services/canonical-autopay-operation-executor");
    const prepared = await prepareCanonicalAutopayPlan({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, d2PlanId: planId, now });
    if (!prepared.operation) throw new Error("F4 operation was not prepared");
    await executeCanonicalAutopayOperation({ organizationId: fixture.organizationId, operationId: prepared.operation.id, now });
    const [payment] = await db.select().from(payments).where(eq(payments.paymentOperationId, prepared.operation.id));
    if (!payment) throw new Error("F4 payment was not persisted");
    const projection = await readPaymentReceiptProjection({ organizationId: fixture.organizationId, paymentId: payment.id });
    const collectionEvidence = projection.row.collectionEvidence;
    expect(collectionEvidence).toMatchObject({ d2PlanId: planId, grouping: "normal", timing: "at_collection_point" });
    if (!collectionEvidence) throw new Error("normal collection evidence missing");
    expect(collectionEvidence.coveredOccurrenceIds).toEqual([collectionEvidence.collectionPointOccurrenceId]);
  });

  it("fails closed for ownership, membership, partner, and location drift before provider dispatch", async () => {
    const { fixture, planId, now } = await makeCanonicalFixture();
    const { prepareCanonicalAutopayPlan } = await import("../../server/services/canonical-autopay-preparation");
    const { executeCanonicalAutopayOperation } = await import("../../server/services/canonical-autopay-operation-executor");
    const [payer] = await db.select().from(f3PayerAuthorizations).where(and(eq(f3PayerAuthorizations.organizationId, fixture.organizationId), eq(f3PayerAuthorizations.leagueId, fixture.leagueId)));
    if (!payer) throw new Error("F4 authorization missing");
    const prepared = await prepareCanonicalAutopayPlan({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, d2PlanId: planId, now });
    if (!prepared.operation) throw new Error("F4 operation was not prepared");
    await db.update(locations).set({ squareCredentials: { appId: "f4-test-app", accessToken: "f4-test-token", locationId: "drifted-location" } }).where(eq(locations.id, fixture.locationId));
    await executeCanonicalAutopayOperation({ organizationId: fixture.organizationId, operationId: prepared.operation.id, now });
    const [operation] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, prepared.operation.id));
    const [plan] = await db.select().from(occurrenceCollectionPlans).where(eq(occurrenceCollectionPlans.id, planId));
    expect(provider.requests).toHaveLength(0);
    expect(operation?.status).toBe("failed_terminal");
    expect(plan?.state).toBe("cancelled");
    expect(payer.id).toBeDefined();
  });

  it.each([
    ["payer customer ownership", async (fixture: Awaited<ReturnType<typeof makeCanonicalFixture>>) => db.update(bowlers).set({ paymentCustomerId: "different-customer" }).where(and(eq(bowlers.id, fixture.fixture.roster[0].id), eq(bowlers.organizationId, fixture.fixture.organizationId)))],
    ["active membership", async (fixture: Awaited<ReturnType<typeof makeCanonicalFixture>>) => db.update(bowlerLeagues).set({ active: false }).where(and(eq(bowlerLeagues.bowlerId, fixture.fixture.roster[1].id), eq(bowlerLeagues.leagueId, fixture.fixture.leagueId)))],
    ["partner acceptance", async (fixture: Awaited<ReturnType<typeof makeCanonicalFixture>>) => db.update(bowlerPaymentLinks).set({ status: "pending" }).where(and(eq(bowlerPaymentLinks.organizationId, fixture.fixture.organizationId), eq(bowlerPaymentLinks.bowlerAId, Math.min(fixture.fixture.roster[0].id, fixture.fixture.roster[1].id)), eq(bowlerPaymentLinks.bowlerBId, Math.max(fixture.fixture.roster[0].id, fixture.fixture.roster[1].id))))],
    ["trigger occurrence", async (fixture: Awaited<ReturnType<typeof makeCanonicalFixture>>) => db.update(leagueOccurrences).set({ startAt: "2038-02-02T20:00:00.000Z" }).where(and(eq(leagueOccurrences.id, fixture.fixture.occurrenceIds[1]), eq(leagueOccurrences.organizationId, fixture.fixture.organizationId), eq(leagueOccurrences.leagueId, fixture.fixture.leagueId)))],
  ] as const)("fails closed for %s drift with zero provider calls", async (_label, mutate: (fixture: Omit<Awaited<ReturnType<typeof makeCanonicalFixture>>, "siblingPlanId">) => Promise<unknown>) => {
    const { fixture, planId, now } = await makeCanonicalFixture();
    const { prepareCanonicalAutopayPlan } = await import("../../server/services/canonical-autopay-preparation");
    const { executeCanonicalAutopayOperation } = await import("../../server/services/canonical-autopay-operation-executor");
    const prepared = await prepareCanonicalAutopayPlan({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, d2PlanId: planId, now });
    if (!prepared.operation) throw new Error("F4 operation was not prepared");
    await mutate({ fixture, planId, providerLocationId: "unused", now });
    await executeCanonicalAutopayOperation({ organizationId: fixture.organizationId, operationId: prepared.operation.id, now });
    const [operation] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, prepared.operation.id));
    const [plan] = await db.select().from(occurrenceCollectionPlans).where(eq(occurrenceCollectionPlans.id, planId));
    expect(provider.requests).toHaveLength(0);
    expect(operation?.status).toBe("failed_terminal");
    expect(plan?.state).toBe("cancelled");
    provider.requests.length = 0;
  });

  it("serializes revoke-first with zero provider calls and permits only the claimed in-flight charge", async () => {
    const first = await makeCanonicalFixture();
    const workflow = await import("../../server/services/f3-workflow");
    const { prepareCanonicalAutopayPlan } = await import("../../server/services/canonical-autopay-preparation");
    const { executeCanonicalAutopayOperation } = await import("../../server/services/canonical-autopay-operation-executor");
    const preparedFirst = await prepareCanonicalAutopayPlan({ organizationId: first.fixture.organizationId, leagueId: first.fixture.leagueId, d2PlanId: first.planId, now: first.now });
    if (!preparedFirst.operation) throw new Error("F4 operation was not prepared");
    const [authFirst] = await db.select().from(f3PayerAuthorizations).where(and(eq(f3PayerAuthorizations.organizationId, first.fixture.organizationId), eq(f3PayerAuthorizations.leagueId, first.fixture.leagueId)));
    if (!authFirst) throw new Error("F4 authorization missing");
    vi.setSystemTime(first.now);
    await workflow.revokeF3Authorization({ organizationId: first.fixture.organizationId, leagueId: first.fixture.leagueId, authorizationId: authFirst.id, actorUserId: first.fixture.actorUserId, actorBowlerId: first.fixture.roster[0].id });
    vi.useRealTimers();
    await executeCanonicalAutopayOperation({ organizationId: first.fixture.organizationId, operationId: preparedFirst.operation.id, now: first.now });
    expect(provider.requests).toHaveLength(0);
    const [revokedPlan] = await db.select().from(occurrenceCollectionPlans).where(eq(occurrenceCollectionPlans.id, first.planId));
    expect(revokedPlan?.state).toBe("superseded");

    const second = await makeCanonicalFixture();
    const preparedSecond = await prepareCanonicalAutopayPlan({ organizationId: second.fixture.organizationId, leagueId: second.fixture.leagueId, d2PlanId: second.planId, now: second.now });
    if (!preparedSecond.operation) throw new Error("F4 operation was not prepared");
    const leased = await acquirePaymentOperationLease({ organizationId: second.fixture.organizationId, operationId: preparedSecond.operation.id, leaseOwner: "f4-claim-first", leaseDurationMs: 900_000, now: second.now });
    if (!leased?.leaseToken || leased.leagueId === null) throw new Error("F4 operation was not leased");
    expect(await acquireCanonicalAutopayDispatchCutoff({ organizationId: second.fixture.organizationId, leagueId: leased.leagueId, operationId: leased.id, leaseToken: leased.leaseToken, now: second.now })).toBe(true);
    const [authSecond] = await db.select().from(f3PayerAuthorizations).where(and(eq(f3PayerAuthorizations.organizationId, second.fixture.organizationId), eq(f3PayerAuthorizations.leagueId, second.fixture.leagueId)));
    if (!authSecond) throw new Error("F4 authorization missing");
    vi.setSystemTime(second.now);
    await workflow.revokeF3Authorization({ organizationId: second.fixture.organizationId, leagueId: second.fixture.leagueId, authorizationId: authSecond.id, actorUserId: second.fixture.actorUserId, actorBowlerId: second.fixture.roster[0].id });
    vi.useRealTimers();
    const [snapshot] = await db.select().from(canonicalAutopayExecutionSnapshots).where(eq(canonicalAutopayExecutionSnapshots.operationId, leased.id));
    if (!snapshot) throw new Error("F4 snapshot missing");
    const byBowler = new Map<number, number>();
    for (const item of snapshot.items as Array<{ bowlerId: number; amountMinor: number }>) byBowler.set(item.bowlerId, (byBowler.get(item.bowlerId) ?? 0) + item.amountMinor);
    const paymentRows = [...byBowler.entries()].map(([bowlerId, amount], allocationIndex) => ({ allocationIndex, values: { bowlerId, leagueId: second.fixture.leagueId, amount, lineageAmount: null, prizeFundAmount: null, weekOf: snapshot.triggerStartAt, status: "paid" as const, type: "square" as const, providerPaymentId: "f4-claim-payment", receiptUrl: null, receiptNumber: null, receiptEmailMissing: true, notes: null, paidByUserId: leased.authorizingUserId, combinedChargeGroupId: leased.id } }));
    await provider.processPayment("ccof:f4-test-card", leased.amountMinor, false, "f4-customer", undefined, { paymentKey: leased.providerIdempotencyKey });
    await finalizePaymentOperationSuccess({ organizationId: second.fixture.organizationId, operationId: leased.id, leaseToken: leased.leaseToken, providerObjectId: "f4-claim-payment", providerOrderId: "f4-claim-order", paymentRows, now: second.now });
    const [completedPlan] = await db.select().from(occurrenceCollectionPlans).where(eq(occurrenceCollectionPlans.id, second.planId));
    const [completedOperation] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, leased.id));
    expect(completedPlan?.state).toBe("fulfilled");
    expect(completedOperation?.status).toBe("succeeded");
    expect(provider.requests).toHaveLength(1);

    provider.requests.length = 0;
    const lockFixture = await makeCanonicalFixture();
    const lockedPrepared = await prepareCanonicalAutopayPlan({ organizationId: lockFixture.fixture.organizationId, leagueId: lockFixture.fixture.leagueId, d2PlanId: lockFixture.planId, now: lockFixture.now });
    if (!lockedPrepared.operation) throw new Error("F4 operation was not prepared");
    const [lockedAuth] = await db.select().from(f3PayerAuthorizations).where(and(eq(f3PayerAuthorizations.organizationId, lockFixture.fixture.organizationId), eq(f3PayerAuthorizations.leagueId, lockFixture.fixture.leagueId)));
    if (!lockedAuth) throw new Error("F4 authorization missing");
    const holder = await getTestPool().connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock($1::integer, $2::integer)", [lockFixture.fixture.organizationId, lockFixture.fixture.leagueId]);
      vi.setSystemTime(lockFixture.now);
      const revokePromise = workflow.revokeF3Authorization({ organizationId: lockFixture.fixture.organizationId, leagueId: lockFixture.fixture.leagueId, authorizationId: lockedAuth.id, actorUserId: lockFixture.fixture.actorUserId, actorBowlerId: lockFixture.fixture.roster[0].id });
      await waitForAdvisoryWaiter(lockFixture.fixture.organizationId, lockFixture.fixture.leagueId);
      const executorPromise = executeCanonicalAutopayOperation({ organizationId: lockFixture.fixture.organizationId, operationId: lockedPrepared.operation.id, now: lockFixture.now });
      await waitForAdvisoryWaiter(lockFixture.fixture.organizationId, lockFixture.fixture.leagueId, 2);
      await holder.query("COMMIT");
      await Promise.all([revokePromise, executorPromise]);
      vi.useRealTimers();
    } finally {
      holder.release();
    }
    expect(provider.requests).toHaveLength(0);
    const [lockedOperation] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, lockedPrepared.operation.id));
    expect(lockedOperation?.status).toBe("canceled");

    provider.requests.length = 0;
    const claimFixture = await makeCanonicalFixture();
    const claimPrepared = await prepareCanonicalAutopayPlan({ organizationId: claimFixture.fixture.organizationId, leagueId: claimFixture.fixture.leagueId, d2PlanId: claimFixture.planId, now: claimFixture.now });
    if (!claimPrepared.operation) throw new Error("F4 operation was not prepared");
    const [claimAuth] = await db.select().from(f3PayerAuthorizations).where(and(eq(f3PayerAuthorizations.organizationId, claimFixture.fixture.organizationId), eq(f3PayerAuthorizations.leagueId, claimFixture.fixture.leagueId)));
    if (!claimAuth) throw new Error("F4 authorization missing");
    let releaseProvider!: () => void;
    const providerPaused = new Promise<void>((resolve) => { releaseProvider = resolve; });
    provider.beforeResolve = () => providerPaused;
    const executeClaim = executeCanonicalAutopayOperation({ organizationId: claimFixture.fixture.organizationId, operationId: claimPrepared.operation.id, now: claimFixture.now });
    for (let attempt = 0; attempt < 20 && provider.requests.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(provider.requests).toHaveLength(1);
    vi.setSystemTime(claimFixture.now);
    const revokeAfterClaim = workflow.revokeF3Authorization({ organizationId: claimFixture.fixture.organizationId, leagueId: claimFixture.fixture.leagueId, authorizationId: claimAuth.id, actorUserId: claimFixture.fixture.actorUserId, actorBowlerId: claimFixture.fixture.roster[0].id });
    releaseProvider();
    await Promise.all([executeClaim, revokeAfterClaim]);
    vi.useRealTimers();
    provider.beforeResolve = null;
    const [claimedOperation] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, claimPrepared.operation.id));
    const [claimedPlan] = await db.select().from(occurrenceCollectionPlans).where(eq(occurrenceCollectionPlans.id, claimFixture.planId));
    const [supersededAuth] = await db.select().from(f3PayerAuthorizations).where(eq(f3PayerAuthorizations.id, claimAuth.id));
    expect(claimedOperation?.status).toBe("succeeded");
    expect(claimedPlan?.state).toBe("fulfilled");
    expect(supersededAuth?.state).toBe("superseded");
    expect(provider.requests).toHaveLength(1);
  });

  it("turns a provider hard decline into action_required and stops the exact plan", async () => {
    const { fixture, planId, siblingPlanId, now } = await makeCanonicalFixture({ twoCollectionPoints: true });
    if (!siblingPlanId) throw new Error("F4 fixture did not persist a sibling D2 plan");
    const { prepareCanonicalAutopayPlan } = await import("../../server/services/canonical-autopay-preparation");
    const { executeCanonicalAutopayOperation } = await import("../../server/services/canonical-autopay-operation-executor");
    const prepared = await prepareCanonicalAutopayPlan({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, d2PlanId: planId, now });
    if (!prepared.operation) throw new Error("F4 operation was not prepared");
    const sibling = await prepareCanonicalAutopayPlan({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, d2PlanId: siblingPlanId, now: new Date(now.getTime() + 24 * 60 * 60_000) });
    if (!sibling.operation) {
      const siblingState = await db.select({ id: occurrenceCollectionPlans.id, state: occurrenceCollectionPlans.state, trigger: occurrenceCollectionPlans.triggerOccurrenceId }).from(occurrenceCollectionPlans).where(eq(occurrenceCollectionPlans.id, siblingPlanId));
      const siblingRevisions = await db.select({ afterSnapshot: occurrenceCollectionPlanRevisions.afterSnapshot }).from(occurrenceCollectionPlanRevisions).where(eq(occurrenceCollectionPlanRevisions.planId, siblingPlanId));
      throw new Error(`F4 sibling operation was not prepared: ${JSON.stringify({ sibling, siblingState, siblingRevisions })}`);
    }
    provider.status = "FAILED";
    await executeCanonicalAutopayOperation({ organizationId: fixture.organizationId, operationId: prepared.operation.id, now: new Date(now.getTime() + 24 * 60 * 60_000) });
    const operations = await db.select().from(paymentOperations).where(and(eq(paymentOperations.organizationId, fixture.organizationId), eq(paymentOperations.operationType, "canonical_autopay_charge")));
    const plans = await db.select().from(occurrenceCollectionPlans).where(and(eq(occurrenceCollectionPlans.organizationId, fixture.organizationId), eq(occurrenceCollectionPlans.leagueId, fixture.leagueId)));
    expect(provider.requests).toHaveLength(1);
    expect(operations.find((row) => row.id === prepared.operation?.id)?.status).toBe("action_required");
    expect(operations.find((row) => row.id === sibling.operation?.id)?.status).toBe("canceled");
    expect(plans.filter((row) => row.id === planId || row.id === siblingPlanId).every((row) => row.state === "superseded")).toBe(true);
    expect(await db.select().from(occurrenceCollectionPlanRevisions).where(and(eq(occurrenceCollectionPlanRevisions.organizationId, fixture.organizationId), eq(occurrenceCollectionPlanRevisions.planId, siblingPlanId)))).toHaveLength(2);
    const { buildNextPaymentOperationWakeQuery } = await import("../../server/storage/payment-operations");
    const wake = await db.execute(buildNextPaymentOperationWakeQuery());
    expect(wake.rows.some((row) => row.kind === "canonical_plan" && (row.work_id === planId || row.work_id === siblingPlanId))).toBe(false);
  });

  it("releases the exact reservation on a claimed invalid-card terminal outcome", async () => {
    const { fixture, planId, now } = await makeCanonicalFixture();
    const { prepareCanonicalAutopayPlan } = await import("../../server/services/canonical-autopay-preparation");
    const { executeCanonicalAutopayOperation } = await import("../../server/services/canonical-autopay-operation-executor");
    const prepared = await prepareCanonicalAutopayPlan({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, d2PlanId: planId, now });
    if (!prepared.operation) throw new Error("F4 operation was not prepared");
    provider.cardValid = false;
    await executeCanonicalAutopayOperation({ organizationId: fixture.organizationId, operationId: prepared.operation.id, now });
    const [operation] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, prepared.operation.id));
    const [plan] = await db.select().from(occurrenceCollectionPlans).where(eq(occurrenceCollectionPlans.id, planId));
    const revisions = await db.select().from(occurrenceCollectionPlanRevisions).where(eq(occurrenceCollectionPlanRevisions.planId, planId));
    expect(provider.requests).toHaveLength(0);
    expect(operation?.status).toBe("failed_terminal");
    expect(plan?.state).toBe("cancelled");
    expect(revisions).toHaveLength(2);
  });

  it("fails closed when an obligation becomes settled after preparation", async () => {
    const { fixture, planId, now } = await makeCanonicalFixture();
    const { prepareCanonicalAutopayPlan } = await import("../../server/services/canonical-autopay-preparation");
    const { executeCanonicalAutopayOperation } = await import("../../server/services/canonical-autopay-operation-executor");
    const prepared = await prepareCanonicalAutopayPlan({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, d2PlanId: planId, now });
    if (!prepared.operation) throw new Error("F4 operation was not prepared");
    const [item] = await db.select().from(occurrenceCollectionPlanItems).where(and(eq(occurrenceCollectionPlanItems.planId, planId), eq(occurrenceCollectionPlanItems.organizationId, fixture.organizationId))).limit(1);
    if (!item) throw new Error("F4 plan item missing");
    await db.update(bowlerOccurrenceObligations).set({ state: "settled" }).where(and(eq(bowlerOccurrenceObligations.id, item.obligationId), eq(bowlerOccurrenceObligations.organizationId, fixture.organizationId), eq(bowlerOccurrenceObligations.leagueId, fixture.leagueId)));
    await executeCanonicalAutopayOperation({ organizationId: fixture.organizationId, operationId: prepared.operation.id, now });
    const [operation] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, prepared.operation.id));
    const [plan] = await db.select().from(occurrenceCollectionPlans).where(eq(occurrenceCollectionPlans.id, planId));
    expect(provider.requests).toHaveLength(0);
    expect(operation?.status).toBe("failed_terminal");
    expect(plan?.state).toBe("cancelled");
  });

  it("fails closed on an intervening refunded active allocation", async () => {
    const { fixture, planId, now } = await makeCanonicalFixture();
    const { prepareCanonicalAutopayPlan } = await import("../../server/services/canonical-autopay-preparation");
    const { executeCanonicalAutopayOperation } = await import("../../server/services/canonical-autopay-operation-executor");
    const prepared = await prepareCanonicalAutopayPlan({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, d2PlanId: planId, now });
    if (!prepared.operation) throw new Error("F4 operation was not prepared");
    const [item] = await db.select().from(occurrenceCollectionPlanItems).where(and(eq(occurrenceCollectionPlanItems.planId, planId), eq(occurrenceCollectionPlanItems.organizationId, fixture.organizationId))).limit(1);
    if (!item) throw new Error("F4 plan item missing");
    const [payment] = await db.insert(payments).values({ bowlerId: item.bowlerId, leagueId: fixture.leagueId, amount: item.amountMinor, lineageAmount: null, prizeFundAmount: null, weekOf: now.toISOString(), status: "paid", type: "square", providerPaymentId: "f4-refund-drift", receiptEmailMissing: true, refundedAt: now.toISOString(), paidByUserId: fixture.actorUserId }).returning();
    await db.insert(paymentOccurrenceAllocations).values({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, paymentId: payment.id, obligationId: item.obligationId, occurrenceId: item.occurrenceId, bowlerId: item.bowlerId, amountMinor: item.amountMinor, currency: item.currency, state: "active", allocationKey: `f4-refund-drift:${fixture.organizationId}`, recordedByUserId: fixture.actorUserId });
    await executeCanonicalAutopayOperation({ organizationId: fixture.organizationId, operationId: prepared.operation.id, now });
    const [operation] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, prepared.operation.id));
    const [plan] = await db.select().from(occurrenceCollectionPlans).where(eq(occurrenceCollectionPlans.id, planId));
    expect(provider.requests).toHaveLength(0);
    expect(operation?.status).toBe("failed_terminal");
    expect(plan?.state).toBe("cancelled");
  });

  it("enforces the canonical dispatch-claim state matrix at the database boundary", async () => {
    const { fixture, planId, now } = await makeCanonicalFixture();
    const { prepareCanonicalAutopayPlan } = await import("../../server/services/canonical-autopay-preparation");
    const prepared = await prepareCanonicalAutopayPlan({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, d2PlanId: planId, now });
    if (!prepared.operation) throw new Error("F4 operation was not prepared");
    await expect(db.update(paymentOperations).set({ dispatchClaimedAt: now.toISOString(), status: "retry_scheduled", nextAttemptAt: now.toISOString() }).where(and(eq(paymentOperations.id, prepared.operation.id), eq(paymentOperations.organizationId, fixture.organizationId)))).rejects.toThrow();
    const [pending] = await db.select({ dispatchClaimedAt: paymentOperations.dispatchClaimedAt, status: paymentOperations.status }).from(paymentOperations).where(eq(paymentOperations.id, prepared.operation.id));
    expect(pending?.dispatchClaimedAt).toBeNull();
    expect(pending?.status).toBe("pending");
  });

  it("rejects a canonical trigger occurrence from another league in the same tenant", async () => {
    const { fixture, planId, now } = await makeCanonicalFixture();
    const { prepareCanonicalAutopayPlan } = await import("../../server/services/canonical-autopay-preparation");
    const prepared = await prepareCanonicalAutopayPlan({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, d2PlanId: planId, now });
    if (!prepared.operation) throw new Error("F4 operation was not prepared");
    const [otherLeague] = await db.insert(leagues).values({ name: "F4 cross-league", organizationId: fixture.organizationId, locationId: fixture.locationId, seasonStart: "2038-01-01", seasonEnd: "2038-12-31", weekDay: "Sunday", competitionStartTime: "19:00", timezone: "UTC", totalBowlingWeeks: 2, weeklyFee: 500, paymentMode: "weekly" }).returning({ id: leagues.id });
    const [otherOccurrence] = await db.insert(leagueOccurrences).values({ organizationId: fixture.organizationId, leagueId: otherLeague.id, locationId: fixture.locationId, generationKey: `f4-cross-league-${otherLeague.id}`, kind: "regular", status: "scheduled", lifecycle: "draft", authoritativeLocalDate: "2038-03-01", authoritativeLocalStartTime: "19:00:00", timezone: "UTC", startAt: "2038-03-01T19:00:00.000Z", selectedUtcOffsetMinutes: 0, foldResolution: "unambiguous", resolverVersion: "f4-test/1", plannedOrdinal: 1, competitionNumber: 1, competitive: true, countsInStandings: true }).returning({ id: leagueOccurrences.id });
    await expect(db.update(paymentOperations).set({ triggerOccurrenceId: otherOccurrence.id }).where(and(eq(paymentOperations.id, prepared.operation.id), eq(paymentOperations.organizationId, fixture.organizationId)))).rejects.toThrow();
    const [unchanged] = await db.select({ triggerOccurrenceId: paymentOperations.triggerOccurrenceId, leagueId: paymentOperations.leagueId }).from(paymentOperations).where(eq(paymentOperations.id, prepared.operation.id));
    expect(unchanged?.leagueId).toBe(fixture.leagueId);
    expect(unchanged?.triggerOccurrenceId).toBe(fixture.occurrenceIds[1]);
  });

  it("keeps configuration outages recoverable and clears the dispatch claim for a same-key retry", async () => {
    const { fixture, planId, now } = await makeCanonicalFixture();
    const { prepareCanonicalAutopayPlan } = await import("../../server/services/canonical-autopay-preparation");
    const { executeCanonicalAutopayOperation } = await import("../../server/services/canonical-autopay-operation-executor");
    const prepared = await prepareCanonicalAutopayPlan({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, d2PlanId: planId, now });
    if (!prepared.operation) throw new Error("F4 operation was not prepared");
    provider.factoryAvailable = false;
    await executeCanonicalAutopayOperation({ organizationId: fixture.organizationId, operationId: prepared.operation.id, now });
    const [retry] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, prepared.operation.id));
    expect(provider.requests).toHaveLength(0);
    expect(retry?.status).toBe("retry_scheduled");
    expect(retry?.dispatchClaimedAt).toBeNull();
    expect(retry?.providerIdempotencyKey).toBe(prepared.operation.providerIdempotencyKey);
    const [readyPlan] = await db.select().from(occurrenceCollectionPlans).where(eq(occurrenceCollectionPlans.id, planId));
    expect(readyPlan?.state).toBe("ready");
    provider.factoryAvailable = true;
    await executeCanonicalAutopayOperation({ organizationId: fixture.organizationId, operationId: prepared.operation.id, now: new Date(now.getTime() + 60_000) });
    const [completed] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, prepared.operation.id));
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toBe(prepared.operation.providerIdempotencyKey);
    expect(completed?.status).toBe("succeeded");
  });

  it("uses the established same-key retry schedule for transient provider errors", async () => {
    const { fixture, planId, now } = await makeCanonicalFixture();
    const { prepareCanonicalAutopayPlan } = await import("../../server/services/canonical-autopay-preparation");
    const { executeCanonicalAutopayOperation } = await import("../../server/services/canonical-autopay-operation-executor");
    const prepared = await prepareCanonicalAutopayPlan({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, d2PlanId: planId, now });
    if (!prepared.operation) throw new Error("F4 operation was not prepared");
    provider.transientFailures = 1;
    await executeCanonicalAutopayOperation({ organizationId: fixture.organizationId, operationId: prepared.operation.id, now });
    const [retry] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, prepared.operation.id));
    expect(retry?.status).toBe("retry_scheduled");
    expect(retry?.dispatchClaimedAt).toBeNull();
    expect(retry?.providerIdempotencyKey).toBe(prepared.operation.providerIdempotencyKey);
    expect(provider.requests).toEqual([prepared.operation.providerIdempotencyKey]);
    await executeCanonicalAutopayOperation({ organizationId: fixture.organizationId, operationId: prepared.operation.id, now: new Date(now.getTime() + 60_000) });
    expect(provider.requests).toEqual([prepared.operation.providerIdempotencyKey, prepared.operation.providerIdempotencyKey]);
    const [completed] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, prepared.operation.id));
    expect(completed?.status).toBe("succeeded");
  });

  it("releases the plan after definitive transient exhaustion", async () => {
    const { fixture, planId, now } = await makeCanonicalFixture();
    const { prepareCanonicalAutopayPlan } = await import("../../server/services/canonical-autopay-preparation");
    const { executeCanonicalAutopayOperation } = await import("../../server/services/canonical-autopay-operation-executor");
    const prepared = await prepareCanonicalAutopayPlan({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, d2PlanId: planId, now });
    if (!prepared.operation) throw new Error("F4 operation was not prepared");
    provider.transientFailures = 20;
    for (let attempt = 0; attempt < 9; attempt += 1) {
      const [current] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, prepared.operation.id));
      if (current?.status === "failed_terminal") break;
      await executeCanonicalAutopayOperation({ organizationId: fixture.organizationId, operationId: prepared.operation.id, now: new Date(now.getTime() + (attempt + 1) * 24 * 60 * 60_000) });
    }
    const [operation] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, prepared.operation.id));
    const [plan] = await db.select().from(occurrenceCollectionPlans).where(eq(occurrenceCollectionPlans.id, planId));
    expect(operation?.status).toBe("failed_terminal");
    expect(plan?.state).toBe("cancelled");
    expect(provider.requests).toHaveLength(8);
  });

  it("wins revocation before a scheduled transient retry without a second provider call", async () => {
    const { fixture, planId, now } = await makeCanonicalFixture();
    const workflow = await import("../../server/services/f3-workflow");
    const { prepareCanonicalAutopayPlan } = await import("../../server/services/canonical-autopay-preparation");
    const { executeCanonicalAutopayOperation } = await import("../../server/services/canonical-autopay-operation-executor");
    const prepared = await prepareCanonicalAutopayPlan({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, d2PlanId: planId, now });
    if (!prepared.operation) throw new Error("F4 operation was not prepared");
    provider.transientFailures = 1;
    await executeCanonicalAutopayOperation({ organizationId: fixture.organizationId, operationId: prepared.operation.id, now });
    const [auth] = await db.select().from(f3PayerAuthorizations).where(and(eq(f3PayerAuthorizations.organizationId, fixture.organizationId), eq(f3PayerAuthorizations.leagueId, fixture.leagueId)));
    if (!auth) throw new Error("F4 authorization missing");
    vi.setSystemTime(new Date(now.getTime() + 120_000));
    await workflow.revokeF3Authorization({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, authorizationId: auth.id, actorUserId: fixture.actorUserId, actorBowlerId: fixture.roster[0].id });
    vi.useRealTimers();
    await executeCanonicalAutopayOperation({ organizationId: fixture.organizationId, operationId: prepared.operation.id, now: new Date(now.getTime() + 120_000) });
    const [operation] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, prepared.operation.id));
    expect(provider.requests).toEqual([prepared.operation.providerIdempotencyKey]);
    expect(operation?.status).toBe("canceled");
    expect(operation?.providerIdempotencyKey).toBe(prepared.operation.providerIdempotencyKey);
  });

  it("converges reconciliation and webhook completion without a second provider call", async () => {
    const { fixture, planId, now, providerLocationId } = await makeCanonicalFixture();
    const { prepareCanonicalAutopayPlan } = await import("../../server/services/canonical-autopay-preparation");
    const paymentOperationsStorage = await import("../../server/storage/payment-operations");
    const { executeCanonicalAutopayOperation } = await import("../../server/services/canonical-autopay-operation-executor");
    const prepared = await prepareCanonicalAutopayPlan({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, d2PlanId: planId, now });
    if (!prepared.operation) throw new Error("F4 operation was not prepared");
    const finalizer = vi.spyOn(paymentOperationsStorage, "finalizePaymentOperationSuccess").mockRejectedValueOnce(new Error("simulated local finalizer crash"));
    await executeCanonicalAutopayOperation({ organizationId: fixture.organizationId, operationId: prepared.operation.id, now });
    finalizer.mockRestore();
    const [recon] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, prepared.operation.id));
    expect(provider.requests).toHaveLength(1);
    expect(recon?.status).toBe("reconciliation_required");
    expect(recon?.providerObjectId).toBe("f4-test-payment-1");
    expect(recon?.providerOrderId).toBe("f4-test-order-1");
    expect(recon?.providerIdempotencyKey).toBe(prepared.operation.providerIdempotencyKey);
    const evidence = { organizationId: fixture.organizationId, operationId: prepared.operation.id, locationId: fixture.locationId, providerLocationId, providerObjectId: "f4-test-payment-1", providerPaymentId: "f4-test-payment-1", providerOrderId: "f4-test-order-1", amountMinor: prepared.operation.amountMinor, currency: prepared.operation.currency, receiptUrl: null, receiptNumber: null, now };
    await db.transaction((tx) => finalizeChargeFromWebhookEvidenceInTransaction(tx, evidence));
    await db.transaction((tx) => finalizeChargeFromWebhookEvidenceInTransaction(tx, evidence));
    const [operation] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, prepared.operation?.id));
    const [plan] = await db.select().from(occurrenceCollectionPlans).where(eq(occurrenceCollectionPlans.id, planId));
    const linkedPayments = await db.select().from(payments).where(eq(payments.paymentOperationId, prepared.operation.id));
    expect(provider.requests).toHaveLength(1);
    expect(operation?.status).toBe("succeeded");
    expect(operation?.providerObjectId).toBe("f4-test-payment-1");
    expect(plan?.state).toBe("fulfilled");
    expect(linkedPayments).toHaveLength(2);
  });

  it("rejects retained provider identity replacement during canonical reconciliation", async () => {
    const { fixture, planId, now } = await makeCanonicalFixture();
    const { prepareCanonicalAutopayPlan } = await import("../../server/services/canonical-autopay-preparation");
    const prepared = await prepareCanonicalAutopayPlan({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, d2PlanId: planId, now });
    if (!prepared.operation) throw new Error("F4 operation was not prepared");
    const leased = await acquirePaymentOperationLease({ organizationId: fixture.organizationId, operationId: prepared.operation.id, leaseOwner: "identity-regression", leaseDurationMs: 300_000, now });
    if (!leased?.leaseToken) throw new Error("F4 operation was not leased");
    expect(await acquireCanonicalAutopayDispatchCutoff({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, operationId: leased.id, leaseToken: leased.leaseToken, now })).toBe(true);
    await recordPaymentOperationReconciliationRequired({ organizationId: fixture.organizationId, operationId: leased.id, leaseToken: leased.leaseToken, providerObjectId: "f4-provider-a", providerOrderId: "f4-order-a", errorCode: "OUTCOME_UNKNOWN", now });
    await expect(reconcilePaymentOperationSuccess({ organizationId: fixture.organizationId, operationId: leased.id, leaseToken: leased.leaseToken, providerObjectId: "f4-provider-b", providerOrderId: "f4-order-b", now })).rejects.toThrow();
    const [retained] = await db.select({ providerObjectId: paymentOperations.providerObjectId, providerOrderId: paymentOperations.providerOrderId, status: paymentOperations.status }).from(paymentOperations).where(eq(paymentOperations.id, leased.id));
    expect(retained).toEqual({ providerObjectId: "f4-provider-a", providerOrderId: "f4-order-a", status: "reconciliation_required" });
  });

  it("serializes explicit reconciliation and revocation through the canonical scope", async () => {
    const { fixture, planId, now } = await makeCanonicalFixture();
    const workflow = await import("../../server/services/f3-workflow");
    const { prepareCanonicalAutopayPlan } = await import("../../server/services/canonical-autopay-preparation");
    const prepared = await prepareCanonicalAutopayPlan({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, d2PlanId: planId, now });
    if (!prepared.operation) throw new Error("F4 operation was not prepared");
    const leased = await acquirePaymentOperationLease({ organizationId: fixture.organizationId, operationId: prepared.operation.id, leaseOwner: "reconciliation-race", leaseDurationMs: 300_000, now });
    if (!leased?.leaseToken) throw new Error("F4 operation was not leased");
    expect(await acquireCanonicalAutopayDispatchCutoff({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, operationId: leased.id, leaseToken: leased.leaseToken, now })).toBe(true);
    await recordPaymentOperationReconciliationRequired({ organizationId: fixture.organizationId, operationId: leased.id, leaseToken: leased.leaseToken, providerObjectId: "race-provider-a", providerOrderId: "race-order-a", errorCode: "OUTCOME_UNKNOWN", now });
    const [snapshot] = await db.select().from(canonicalAutopayExecutionSnapshots).where(and(eq(canonicalAutopayExecutionSnapshots.operationId, leased.id), eq(canonicalAutopayExecutionSnapshots.organizationId, fixture.organizationId)));
    if (!snapshot) throw new Error("F4 execution snapshot was not persisted");
    const items = snapshot.items as Array<{ bowlerId: number; amountMinor: number }>;
    const amounts = new Map<number, number>();
    for (const item of items) amounts.set(item.bowlerId, (amounts.get(item.bowlerId) ?? 0) + item.amountMinor);
    const paymentRows = [...amounts.entries()].sort(([left], [right]) => left - right).map(([bowlerId, amount], allocationIndex) => ({
      allocationIndex,
      values: {
        bowlerId, leagueId: fixture.leagueId, amount, lineageAmount: null, prizeFundAmount: null,
        weekOf: snapshot.triggerStartAt, status: "paid" as const, type: "square" as const,
        providerPaymentId: "race-provider-a", receiptEmailMissing: true, notes: null,
        paidByUserId: prepared.operation?.authorizingUserId ?? fixture.actorUserId,
        combinedChargeGroupId: items.length > 1 ? leased.id : null,
      },
    }));
    const [authorization] = await db.select().from(f3PayerAuthorizations).where(and(eq(f3PayerAuthorizations.organizationId, fixture.organizationId), eq(f3PayerAuthorizations.leagueId, fixture.leagueId)));
    if (!authorization) throw new Error("F4 authorization was not persisted");
    const holder = await getTestPool().connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock($1::integer, $2::integer)", [fixture.organizationId, fixture.leagueId]);
      const reconciliation = reconcilePaymentOperationSuccess({ organizationId: fixture.organizationId, operationId: leased.id, leaseToken: leased.leaseToken, providerObjectId: "race-provider-a", providerOrderId: "race-order-a", paymentRows, now });
      await waitForAdvisoryWaiter(fixture.organizationId, fixture.leagueId);
      const revocation = workflow.revokeF3Authorization({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, authorizationId: authorization.id, actorUserId: fixture.actorUserId, actorBowlerId: fixture.roster[0].id });
      await waitForAdvisoryWaiter(fixture.organizationId, fixture.leagueId, 2);
      await holder.query("COMMIT");
      const [reconciled] = await Promise.all([reconciliation, revocation]);
      expect(reconciled.status).toBe("succeeded");
      const [operation] = await db.select({ status: paymentOperations.status }).from(paymentOperations).where(eq(paymentOperations.id, leased.id));
      const [plan] = await db.select({ state: occurrenceCollectionPlans.state }).from(occurrenceCollectionPlans).where(eq(occurrenceCollectionPlans.id, planId));
      expect(operation?.status).toBe("succeeded");
      expect(plan?.state).toBe("fulfilled");
      expect(provider.requests).toHaveLength(0);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
  });

  it("keeps the canonical wake future-due and tenant scoped, with supporting composite indexes", async () => {
    const { buildNextPaymentOperationWakeQuery } = await import("../../server/storage/payment-operations");
    const first = await makeCanonicalFixture();
    const second = await makeCanonicalFixture();
    await db.update(leagueOccurrences).set({ startAt: "2027-02-10T19:00:00.000Z" }).where(and(eq(leagueOccurrences.id, first.fixture.occurrenceIds[1]), eq(leagueOccurrences.organizationId, first.fixture.organizationId), eq(leagueOccurrences.leagueId, first.fixture.leagueId)));
    await db.update(leagueOccurrences).set({ startAt: "2027-02-05T19:00:00.000Z" }).where(and(eq(leagueOccurrences.id, second.fixture.occurrenceIds[1]), eq(leagueOccurrences.organizationId, second.fixture.organizationId), eq(leagueOccurrences.leagueId, second.fixture.leagueId)));
    const wake = await db.execute(buildNextPaymentOperationWakeQuery());
    const canonicalWake = wake.rows.find((row) => row.kind === "canonical_plan");
    expect(canonicalWake).toBeDefined();
    expect(Number(canonicalWake?.organization_id)).toBe(second.fixture.organizationId);
    expect(canonicalWake?.work_id).toBe(second.planId);
    expect(new Date(String(canonicalWake?.due_at)).getTime()).toBeGreaterThan(Date.now());
    // Keep an unconstrained planner assertion for broad production-query
    // validity. PostgreSQL may choose any equivalent tenant-scoped index here
    // as costs change; the functional wake tuple above is the behavior under
    // test, not a cost-plan choice.
    const wakeExplain = await db.execute(sql`EXPLAIN (COSTS OFF) ${buildNextPaymentOperationWakeQuery()}`);
    expect(wakeExplain.rows.length).toBeGreaterThan(0);

    // Prove both supporting indexes are eligible for the fully tenant/league
    // keyed canonical wake shape. The planner override is transaction-local
    // to this proof query; production SQL and planner settings remain
    // untouched.
    const keyedWakeExplain = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      return tx.execute(sql`
        EXPLAIN (COSTS OFF)
        SELECT plans.id
        FROM occurrence_collection_plans plans
        INNER JOIN league_occurrences occurrences
          ON occurrences.id = plans.trigger_occurrence_id
          AND occurrences.organization_id = plans.organization_id
          AND occurrences.league_id = plans.league_id
        LEFT JOIN payment_operations canonical_operations
          ON canonical_operations.organization_id = plans.organization_id
          AND canonical_operations.league_id = plans.league_id
          AND canonical_operations.canonical_plan_id = plans.id
          AND canonical_operations.operation_type = 'canonical_autopay_charge'
        WHERE plans.organization_id = ${second.fixture.organizationId}
          AND plans.league_id = ${second.fixture.leagueId}
          AND plans.state = 'ready'
          AND plans.trigger_occurrence_id IS NOT NULL
          AND canonical_operations.id IS NULL
        ORDER BY occurrences.start_at ASC, plans.id ASC
        LIMIT 1
      `);
    });
    expect(keyedWakeExplain.rows.length).toBeGreaterThan(0);
    const keyedWakeExplainText = keyedWakeExplain.rows.map((row) => Object.values(row).join(" ")).join("\n");
    expect(keyedWakeExplainText).toContain("payment_operations_canonical_plan_unique");
    expect(keyedWakeExplainText).toMatch(/Index Scan|Bitmap Index Scan/);
    const indexes = await db.execute(sql`SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN ('collection_plans_canonical_wake_idx', 'payment_operations_canonical_plan_idx', 'payment_operations_canonical_plan_unique')`);
    const indexDefinitions = new Map(indexes.rows.map((row) => [String(row.indexname), String(row.indexdef)]));
    expect([...indexDefinitions.keys()]).toEqual(expect.arrayContaining(["collection_plans_canonical_wake_idx", "payment_operations_canonical_plan_idx", "payment_operations_canonical_plan_unique"]));
    expect(indexDefinitions.get("collection_plans_canonical_wake_idx")).toContain("organization_id, league_id, state, trigger_occurrence_id");
    // The exact partial predicate proves the canonical wake index is eligible
    // for the keyed ready/trigger-occurrence branch even when PostgreSQL's
    // cost model selects an equivalent existing tenant index for this tiny
    // fixture.
    expect(indexDefinitions.get("collection_plans_canonical_wake_idx")).toContain("state = 'ready'");
    expect(indexDefinitions.get("collection_plans_canonical_wake_idx")).toContain("trigger_occurrence_id IS NOT NULL");
    expect(indexDefinitions.get("payment_operations_canonical_plan_idx")).toContain("organization_id, league_id, canonical_plan_id");
    expect(indexDefinitions.get("payment_operations_canonical_plan_unique")).toContain("CREATE UNIQUE INDEX");
    expect(indexDefinitions.get("payment_operations_canonical_plan_unique")).toContain("organization_id, league_id, canonical_plan_id");
    expect(indexDefinitions.get("payment_operations_canonical_plan_unique")).toContain("operation_type = 'canonical_autopay_charge'");
  });
});
