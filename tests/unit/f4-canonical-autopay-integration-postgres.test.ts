import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { getTestDb } from "../setup/test-db";
import { makeF3WorkflowFixture } from "../helpers/f3-workflow-fixture";
import { deleteOrganization } from "../../server/storage/organizations";
import {
  canonicalAutopayExecutionSnapshots,
  f3PayerAuthorizations,
  bowlerLeagues,
  bowlerPaymentLinks,
  leagueOccurrences,
  locations,
  occurrenceCollectionPlanRevisions,
  occurrenceCollectionPlans,
  paymentOperationOccurrenceSnapshotAllocations,
  paymentOperations,
  paymentOccurrenceAllocations,
  payments,
  bowlerOccurrenceObligations,
  bowlers,
} from "@shared/schema";
import {
  acquireCanonicalAutopayDispatchCutoff,
  acquirePaymentOperationLease,
  finalizeChargeFromWebhookEvidenceInTransaction,
  finalizePaymentOperationSuccess,
  recordPaymentOperationReconciliationRequired,
} from "../../server/storage/payment-operations";

vi.hoisted(() => {
  process.env.LEAGUEVAULT_F3_CANONICAL_AUTOPAY_ENABLED = "1";
  process.env.LEAGUEVAULT_F4_CANONICAL_AUTOPAY_EXECUTION_ENABLED = "1";
  return null;
});

const provider = vi.hoisted(() => {
  class ProviderNotConfiguredError extends Error {
    readonly disposition = "configuration" as const;
    readonly providerCode = "PROVIDER_NOT_CONFIGURED";
    constructor() { super("provider unavailable"); this.name = "ProviderNotConfiguredError"; }
  }
  return {
  providerName: "square",
  requests: [] as string[],
  providerLocations: [] as string[],
  status: String("COMPLETED"),
  resultId: "f4-test-payment-1",
  cardValid: true,
  factoryAvailable: true,
  ProviderNotConfiguredError,
  async processPayment(_source: string, _amount: number, _storeCard?: boolean, _customer?: string, _email?: string, identity?: { paymentKey?: string; providerLocationId?: string } | string) {
    this.requests.push(typeof identity === "string" ? identity : identity?.paymentKey ?? "missing-key");
    this.providerLocations.push(typeof identity === "string" ? "" : identity?.providerLocationId ?? "missing-location");
    return { id: this.resultId, status: this.status, orderId: "f4-test-order-1", receiptUrl: "https://square.test/receipt" };
  },
  validateCardId(cardId: string | null) { return this.cardValid && cardId?.startsWith("ccof:") === true; },
  async hasCardOnFile(_customer: string, _card: string) { return true; },
  };
});

vi.mock("../../server/services/payment-provider-factory.js", () => ({
  getPaymentProvider: vi.fn(async () => {
    if (!provider.factoryAvailable) throw new provider.ProviderNotConfiguredError();
    return provider;
  }),
  ProviderNotConfiguredError: provider.ProviderNotConfiguredError,
}));

const db = getTestDb();
const createdOrganizations: number[] = [];

async function makeCanonicalFixture() {
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
    collectionPoints: [{ occurrenceId: fixture.occurrenceIds[1] }],
    occurrences: [
      { occurrenceId: fixture.occurrenceIds[0], groupKey: "f4-double", groupRole: "paired" as const, pairedOccurrenceId: fixture.occurrenceIds[1], collectionPoint: { occurrenceId: fixture.occurrenceIds[1] } },
      { occurrenceId: fixture.occurrenceIds[1], groupKey: "f4-double", groupRole: "trigger" as const, pairedOccurrenceId: fixture.occurrenceIds[0], collectionPoint: { occurrenceId: fixture.occurrenceIds[1] } },
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
  return { fixture, planId: plan.id, providerLocationId, now: new Date("2038-02-02T19:00:00.000Z") };
}

afterEach(async () => {
  for (const organizationId of createdOrganizations.splice(0)) await deleteOrganization(organizationId).catch(() => undefined);
  provider.requests.length = 0;
  provider.providerLocations.length = 0;
  provider.status = "COMPLETED";
  provider.resultId = "f4-test-payment-1";
  provider.cardValid = true;
  provider.factoryAvailable = true;
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
  ] as const)("fails closed for %s drift with zero provider calls", async (_label, mutate) => {
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

    const raced = await makeCanonicalFixture();
    const preparedRaced = await prepareCanonicalAutopayPlan({ organizationId: raced.fixture.organizationId, leagueId: raced.fixture.leagueId, d2PlanId: raced.planId, now: raced.now });
    if (!preparedRaced.operation) throw new Error("F4 operation was not prepared");
    const [authRaced] = await db.select().from(f3PayerAuthorizations).where(and(eq(f3PayerAuthorizations.organizationId, raced.fixture.organizationId), eq(f3PayerAuthorizations.leagueId, raced.fixture.leagueId)));
    if (!authRaced) throw new Error("F4 authorization missing");
    provider.requests.length = 0;
    vi.setSystemTime(raced.now);
    await Promise.all([
      workflow.revokeF3Authorization({ organizationId: raced.fixture.organizationId, leagueId: raced.fixture.leagueId, authorizationId: authRaced.id, actorUserId: raced.fixture.actorUserId, actorBowlerId: raced.fixture.roster[0].id }),
      executeCanonicalAutopayOperation({ organizationId: raced.fixture.organizationId, operationId: preparedRaced.operation.id, now: raced.now }),
    ]);
    vi.useRealTimers();
    const [racedOperation] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, preparedRaced.operation.id));
    expect(provider.requests.length).toBeLessThanOrEqual(1);
    expect(["succeeded", "canceled", "failed_terminal"].includes(racedOperation?.status ?? "")).toBe(true);
  });

  it("turns a provider hard decline into action_required and stops the exact plan", async () => {
    const { fixture, planId, now } = await makeCanonicalFixture();
    const { prepareCanonicalAutopayPlan } = await import("../../server/services/canonical-autopay-preparation");
    const { executeCanonicalAutopayOperation } = await import("../../server/services/canonical-autopay-operation-executor");
    const prepared = await prepareCanonicalAutopayPlan({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, d2PlanId: planId, now });
    if (!prepared.operation) throw new Error("F4 operation was not prepared");
    provider.status = "FAILED";
    await executeCanonicalAutopayOperation({ organizationId: fixture.organizationId, operationId: prepared.operation.id, now });
    const [operation] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, prepared.operation.id));
    const [plan] = await db.select().from(occurrenceCollectionPlans).where(eq(occurrenceCollectionPlans.id, planId));
    expect(provider.requests).toHaveLength(1);
    expect(operation?.status).toBe("action_required");
    expect(plan?.state).toBe("superseded");
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
    const [readyPlan] = await db.select().from(occurrenceCollectionPlans).where(eq(occurrenceCollectionPlans.id, planId));
    expect(readyPlan?.state).toBe("ready");
    provider.factoryAvailable = true;
    await executeCanonicalAutopayOperation({ organizationId: fixture.organizationId, operationId: prepared.operation.id, now: new Date(now.getTime() + 60_000) });
    const [completed] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, prepared.operation.id));
    expect(provider.requests).toHaveLength(1);
    expect(completed?.status).toBe("succeeded");
  });

  it("converges reconciliation and webhook completion without a second provider call", async () => {
    const { fixture, planId, now, providerLocationId } = await makeCanonicalFixture();
    const { prepareCanonicalAutopayPlan } = await import("../../server/services/canonical-autopay-preparation");
    const prepared = await prepareCanonicalAutopayPlan({ organizationId: fixture.organizationId, leagueId: fixture.leagueId, d2PlanId: planId, now });
    if (!prepared.operation) throw new Error("F4 operation was not prepared");
    const leased = await acquirePaymentOperationLease({ organizationId: fixture.organizationId, operationId: prepared.operation.id, leaseOwner: "f4-reconciliation", leaseDurationMs: 900_000, now });
    if (!leased?.leaseToken || leased.leagueId === null) throw new Error("F4 operation was not leased");
    expect(await acquireCanonicalAutopayDispatchCutoff({ organizationId: fixture.organizationId, leagueId: leased.leagueId, operationId: leased.id, leaseToken: leased.leaseToken, now })).toBe(true);
    await provider.processPayment("ccof:f4-test-card", leased.amountMinor, false, "f4-customer", undefined, { paymentKey: leased.providerIdempotencyKey });
    await recordPaymentOperationReconciliationRequired({ organizationId: fixture.organizationId, operationId: leased.id, leaseToken: leased.leaseToken, providerObjectId: "f4-reconciled-payment", providerOrderId: "f4-reconciled-order", errorCode: "PROVIDER_OUTCOME_UNCERTAIN", now });
    const evidence = { organizationId: fixture.organizationId, operationId: leased.id, locationId: fixture.locationId, providerLocationId, providerObjectId: "f4-reconciled-payment", providerPaymentId: "f4-reconciled-payment", providerOrderId: "f4-reconciled-order", amountMinor: leased.amountMinor, currency: leased.currency, receiptUrl: null, receiptNumber: null, now };
    await db.transaction((tx) => finalizeChargeFromWebhookEvidenceInTransaction(tx, evidence));
    await db.transaction((tx) => finalizeChargeFromWebhookEvidenceInTransaction(tx, evidence));
    const [operation] = await db.select().from(paymentOperations).where(eq(paymentOperations.id, leased.id));
    const [plan] = await db.select().from(occurrenceCollectionPlans).where(eq(occurrenceCollectionPlans.id, planId));
    const linkedPayments = await db.select().from(payments).where(eq(payments.paymentOperationId, leased.id));
    expect(provider.requests).toHaveLength(1);
    expect(operation?.status).toBe("succeeded");
    expect(operation?.providerObjectId).toBe("f4-reconciled-payment");
    expect(plan?.state).toBe("fulfilled");
    expect(linkedPayments).toHaveLength(2);
  });

  it("keeps the canonical wake future-due and tenant scoped, with the composite index in the plan", async () => {
    const { buildNextPaymentOperationWakeQuery } = await import("../../server/storage/payment-operations");
    const first = await makeCanonicalFixture();
    const second = await makeCanonicalFixture();
    const wake = await db.execute(buildNextPaymentOperationWakeQuery());
    const canonicalWake = wake.rows.find((row) => row.kind === "canonical_plan");
    expect(canonicalWake).toBeDefined();
    expect([first.fixture.organizationId, second.fixture.organizationId]).toContain(Number(canonicalWake?.organization_id));
    expect([first.planId, second.planId]).toContain(canonicalWake?.work_id);
    expect(new Date(String(canonicalWake?.due_at)).getTime()).toBeGreaterThan(Date.now());
    const explain = await db.execute(sql`EXPLAIN (COSTS OFF) ${buildNextPaymentOperationWakeQuery()}`);
    expect(explain.rows.length).toBeGreaterThan(0);
    expect(explain.rows.some((row) => Object.values(row).some((value) => String(value).includes("payment_operations_canonical_plan")))).toBe(true);
    const indexes = await db.execute(sql`SELECT indexname FROM pg_indexes WHERE indexname IN ('payment_operations_canonical_plan_idx', 'payment_operations_canonical_plan_unique')`);
    expect(indexes.rows.map((row) => row.indexname)).toEqual(expect.arrayContaining(["payment_operations_canonical_plan_idx", "payment_operations_canonical_plan_unique"]));
  });
});
