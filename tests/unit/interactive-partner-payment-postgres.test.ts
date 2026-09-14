import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  bowlers,
  bowlerLeagues,
  bowlerPaymentLinks,
  leagueOccurrenceBillingTerms,
  leagueOccurrences,
  leagueScheduleCommands,
  leagues,
  locations,
  organizations,
  paymentAllocations,
  paymentObligations,
  paymentOperations,
  paymentOperationRosterSnapshotItems,
  paymentOperationRosterSnapshots,
  payments,
  refundAllocationAdjustments,
  teamPaymentSlots,
  teams,
  users,
} from "@shared/schema";
import { getTestDb } from "../setup/test-db";
import { deleteOrganization } from "../../server/storage/organizations";
import { materializeRosterPaymentOccurrenceInTransaction } from "../../server/services/roster-payment-materializer";
import type { PaymentProvider, PaymentResult } from "../../server/services/payment-provider";
import { canonicalizePaymentOperationInput } from "../../server/services/payment-operation-idempotency";
import { prepareInteractivePartnerPaymentOperation } from "../../server/services/interactive-payment-operation-preparation";
import { readCanonicalPaymentReport } from "../../server/services/roster-payment-archive-report";
import { readCanonicalDuePastDue } from "../../server/services/roster-payment-core";
import { prepareRefundPaymentOperation } from "../../server/services/refund-payment-operation-preparation";
import { RefundPaymentOperationExecutor } from "../../server/services/refund-payment-operation-executor";
import { redactCanonicalPaymentRow } from "../../server/routes/financials-f5";

const getProviderMock = vi.hoisted(() => vi.fn());
vi.mock("../../server/services/payment-provider-factory.js", () => ({ getPaymentProvider: getProviderMock }));

import {
  chargeInteractivePartnerPayments,
  quoteInteractivePartnerPayments,
  readInteractivePaymentParticipants,
} from "../../server/services/interactive-partner-payment";

const db = getTestDb();
const suffix = process.env.VITEST_POOL_ID ?? "0";
const organizationSlug = `interactive-partner-payment-${suffix}`;

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} fixture row was not created`);
  return value;
}

class FakeInteractiveProvider implements PaymentProvider {
  readonly providerName = "square" as const;
  readonly processCalls: Array<{ sourceId: string; amount: number; idempotencyKey?: unknown }> = [];
  readonly refundCalls: Array<{ paymentId: string; amount: number; reason?: string; idempotencyKey?: string }> = [];
  private processStartedResolve: (() => void) | undefined;
  private processRelease: (() => void) | undefined;
  private blocked = false;
  private paymentSequence = 0;

  constructor(readonly locationId: number) {}

  waitForProcessStart(timeoutMs = 5_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timed out waiting for fake provider process")), timeoutMs);
      this.processStartedResolve = () => {
        clearTimeout(timeout);
        resolve();
      };
    });
  }

  blockNextProcess(): () => void {
    this.blocked = true;
    return () => {
      this.blocked = false;
      const release = this.processRelease;
      this.processRelease = undefined;
      release?.();
    };
  }

  async processPayment(
    sourceId: string,
    amount: number,
    _storeCard?: boolean,
    _customerId?: string,
    _buyerEmail?: string,
    idempotencyKey?: unknown,
  ): Promise<PaymentResult> {
    this.processCalls.push({ sourceId, amount, idempotencyKey });
    this.processStartedResolve?.();
    this.processStartedResolve = undefined;
    if (this.blocked) await new Promise<void>((resolve) => { this.processRelease = resolve; });
    this.paymentSequence += 1;
    return {
      id: `square-partner-payment-${this.paymentSequence}`,
      status: "COMPLETED",
      orderId: `square-partner-order-${this.paymentSequence}`,
      receiptUrl: "https://square.example.test/partner-receipt",
      receiptNumber: `PARTNER-${this.paymentSequence}`,
    };
  }

  async createOrderWithPayment(): Promise<PaymentResult> {
    throw new Error("the partner v3 preparation is direct-only");
  }

  async refundPayment(paymentId: string, amount: number, reason?: string, idempotencyKey?: string): Promise<{ refundId: string; status: string }> {
    this.refundCalls.push({ paymentId, amount, reason, idempotencyKey });
    return { refundId: `square-partner-refund-${this.refundCalls.length}`, status: "COMPLETED" };
  }

  async saveCardOnFile(): Promise<null> { return null; }
  async listCardsOnFile(): Promise<[]> { return []; }
  async hasCardOnFile(): Promise<boolean> { return true; }
  async disableCard(): Promise<void> {}
  async createOrUpdateCustomer(): Promise<null> { return null; }
  async getPayment(): Promise<null> { return null; }
  validateCardId(cardId: string | null): boolean { return cardId?.startsWith("ccof:") ?? false; }
}

interface Scenario {
  leagueId: number;
  locationId: number;
  actorUserId: number;
  payerBowlerId: number;
  partnerBowlerId: number;
  pendingBowlerId: number;
  acceptedLinkId: number;
  acceptedLinkFingerprint: string;
  obligations: { payer: string; partner: string; pending: string };
}

let organizationId: number;
let actorUserId: number;
let occurrenceOrdinal = 0;
const foreignOrganizationIds: number[] = [];

function linkFingerprint(link: { id: number; bowlerAId: number; bowlerBId: number; organizationId: number; status: string; respondedAt: string | null }): string {
  // This is intentionally the same canonical input used by the service. The
  // assertion is useful because evidence must be tied to this exact link row.
  const canonical = canonicalizePaymentOperationInput({
    id: link.id,
    bowlerAId: link.bowlerAId,
    bowlerBId: link.bowlerBId,
    organizationId: link.organizationId,
    status: link.status,
    respondedAt: link.respondedAt,
  });
  return `lvpartnerlink:v1:${createHash("sha256").update(canonical).digest("hex")}`;
}

async function createScenario(label: string, occurrenceCount = 1): Promise<Scenario> {
  const location = required((await db.insert(locations).values({
    organizationId,
    name: `Partner payment location ${label}`,
  }).returning({ id: locations.id }))[0], "location");
  const league = required((await db.insert(leagues).values({
    name: `Partner payment league ${label}`,
    organizationId,
    locationId: location.id,
    paymentMode: "weekly",
    payingLineupSize: 3,
    substituteAccess: "team_only",
    substitutePaymentRegime: "team_choice",
    weeklyFee: 1_000,
    lineageFee: null,
    prizeFundFee: null,
    seasonStart: "2039-01-01T00:00:00.000Z",
    seasonEnd: "2039-12-31T23:59:59.000Z",
    weekDay: "Monday",
    timezone: "UTC",
  }).returning({ id: leagues.id }))[0], "league");
  const team = required((await db.insert(teams).values({ name: `Partner payment team ${label}`, number: 1, leagueId: league.id }).returning({ id: teams.id }))[0], "team");
  const payer = required((await db.insert(bowlers).values({ name: `Payer ${label}`, email: `payer-${label}@example.test`, organizationId }).returning({ id: bowlers.id }))[0], "payer");
  const partner = required((await db.insert(bowlers).values({ name: `Partner ${label}`, organizationId }).returning({ id: bowlers.id }))[0], "partner");
  const pending = required((await db.insert(bowlers).values({ name: `Pending ${label}`, organizationId }).returning({ id: bowlers.id }))[0], "pending");
  await db.insert(bowlerLeagues).values([
    { bowlerId: payer.id, leagueId: league.id, teamId: team.id, active: true },
    { bowlerId: partner.id, leagueId: league.id, teamId: team.id, active: true },
    { bowlerId: pending.id, leagueId: league.id, teamId: team.id, active: true },
  ]);
  await db.insert(teamPaymentSlots).values([
    { organizationId, leagueId: league.id, teamId: team.id, slotIndex: 0, lineupSize: 3, occupant: "main", mainBowlerId: payer.id, recordedByUserId: actorUserId },
    { organizationId, leagueId: league.id, teamId: team.id, slotIndex: 1, lineupSize: 3, occupant: "main", mainBowlerId: partner.id, recordedByUserId: actorUserId },
    { organizationId, leagueId: league.id, teamId: team.id, slotIndex: 2, lineupSize: 3, occupant: "main", mainBowlerId: pending.id, recordedByUserId: actorUserId },
  ]);
  const acceptedLink = required((await db.insert(bowlerPaymentLinks).values({
    bowlerAId: Math.min(payer.id, partner.id),
    bowlerBId: Math.max(payer.id, partner.id),
    organizationId,
    status: "accepted",
    createdByUserId: actorUserId,
    respondedAt: "2039-01-01T00:00:00.000Z",
  }).returning())[0], "accepted link");
  await db.insert(bowlerPaymentLinks).values({
    bowlerAId: Math.min(payer.id, pending.id),
    bowlerBId: Math.max(payer.id, pending.id),
    organizationId,
    status: "pending",
    createdByUserId: actorUserId,
  }).returning();

  const obligations = { payer: "", partner: "", pending: "" };
  for (let index = 0; index < occurrenceCount; index += 1) {
    occurrenceOrdinal += 1;
    const commandId = randomUUID();
    const startAt = new Date(Date.UTC(2039, 0, occurrenceOrdinal + 1, 19, 0, 0)).toISOString();
    await db.insert(leagueScheduleCommands).values({
      id: commandId,
      organizationId,
      leagueId: league.id,
      actorUserId,
      commandType: "publish",
      idempotencyKey: `partner-payment-publish-${suffix}-${occurrenceOrdinal}`,
      requestFingerprint: `partner-payment-fingerprint-${occurrenceOrdinal}`,
    });
    const occurrence = required((await db.insert(leagueOccurrences).values({
      organizationId,
      leagueId: league.id,
      locationId: location.id,
      generationKey: `partner-payment-occurrence-${suffix}-${label}-${index}`,
      kind: "regular",
      status: "scheduled",
      lifecycle: "published",
      authoritativeLocalDate: startAt.slice(0, 10),
      authoritativeLocalStartTime: "19:00:00",
      timezone: "UTC",
      startAt,
      selectedUtcOffsetMinutes: 0,
      foldResolution: "unambiguous",
      resolverVersion: "interactive-partner-payment-test",
      plannedOrdinal: occurrenceOrdinal,
      competitionNumber: occurrenceOrdinal,
      competitive: true,
      countsInStandings: true,
      publishedAt: startAt,
      publishedByUserId: actorUserId,
      publicationCommandId: commandId,
    }).returning({ id: leagueOccurrences.id }))[0], "occurrence");
    await db.insert(leagueOccurrenceBillingTerms).values({
      organizationId,
      leagueId: league.id,
      occurrenceId: occurrence.id,
      purpose: "league_weekly_fee",
      obligationPolicy: "eligible_bowlers",
      defaultAmountMinor: 1_000,
      currency: "USD",
      billingOrdinal: occurrenceOrdinal,
      version: 1,
      state: "published",
      publishedAt: startAt,
      publishedByUserId: actorUserId,
      publicationCommandId: commandId,
    });
    await db.transaction((tx) => materializeRosterPaymentOccurrenceInTransaction(tx, {
      organizationId,
      leagueId: league.id,
      occurrenceId: occurrence.id,
      actorUserId,
    }));
  }
  const rows = await db.select({ payerBowlerId: paymentObligations.payerBowlerId, id: paymentObligations.id })
    .from(paymentObligations)
    .where(and(eq(paymentObligations.organizationId, organizationId), eq(paymentObligations.leagueId, league.id)))
    .orderBy(paymentObligations.createdAt);
  obligations.payer = rows.find((row) => row.payerBowlerId === payer.id)?.id ?? "";
  obligations.partner = rows.find((row) => row.payerBowlerId === partner.id)?.id ?? "";
  obligations.pending = rows.find((row) => row.payerBowlerId === pending.id)?.id ?? "";
  return {
    leagueId: league.id,
    locationId: location.id,
    actorUserId,
    payerBowlerId: payer.id,
    partnerBowlerId: partner.id,
    pendingBowlerId: pending.id,
    acceptedLinkId: acceptedLink.id,
    acceptedLinkFingerprint: linkFingerprint(acceptedLink),
    obligations,
  };
}

function selection(bowlerId: number, weeks = 1, fullBalance = false) {
  return { bowlerId, weeks, fullBalance };
}

async function expectRosterError(action: Promise<unknown>, code: string): Promise<void> {
  await expect(action).rejects.toMatchObject({ code });
}

async function prepareUnresolvedPartnerOperation(
  scenario: Scenario,
  recipients: ReturnType<typeof selection>[],
) {
  const quote = await quoteInteractivePartnerPayments({
    organizationId,
    leagueId: scenario.leagueId,
    payerBowlerId: scenario.payerBowlerId,
    recipients,
  });
  const operation = await db.transaction(async (tx) => {
    const operation = await prepareInteractivePartnerPaymentOperation({
      organizationId,
      authorizingUserId: actorUserId,
      requestKey: `unresolved-partner-${suffix}-${randomUUID()}`,
      amountMinor: quote.amountMinor,
      currency: quote.currency,
      providerName: "square",
      leagueId: scenario.leagueId,
      locationId: scenario.locationId,
      providerLocationId: null,
      payerBowlerId: scenario.payerBowlerId,
      sourceId: "cnon:unresolved-partner",
      customerId: null,
      buyerEmail: `payer-${scenario.leagueId}@example.test`,
      storeCard: false,
      sourceKind: "new_card",
      allocations: quote.allocations.map((allocation) => ({ ...allocation, paidByUserId: actorUserId })),
      partnerEvidence: quote.partnerEvidence,
      quoteFingerprint: quote.fingerprint,
      transaction: tx,
    });
    await tx.insert(paymentOperationRosterSnapshotItems).values(quote.allocations.map((allocation) => ({
      operationId: operation.id,
      organizationId,
      leagueId: scenario.leagueId,
      obligationId: allocation.obligationId,
      allocationIndex: allocation.allocationIndex,
      amountMinor: allocation.amountMinor,
      state: "reserved" as const,
    })));
    return operation;
  });
  return { quote, operation };
}

let provider: FakeInteractiveProvider;
const providersByLocation = new Map<number, FakeInteractiveProvider>();

beforeAll(async () => {
  const [leftover] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, organizationSlug));
  if (leftover) await deleteOrganization(leftover.id);
  const [organization] = await db.insert(organizations).values({ name: "Interactive partner payment test", slug: organizationSlug }).returning({ id: organizations.id });
  organizationId = required(organization, "organization").id;
  const actor = required((await db.insert(users).values({
    email: `interactive-partner-payment-${suffix}@example.test`,
    password: "deterministic-test-password-hash",
    name: "Interactive partner payment actor",
    role: "org_admin",
    organizationId,
  }).returning({ id: users.id }))[0], "actor");
  actorUserId = actor.id;
  provider = new FakeInteractiveProvider(0);
  providersByLocation.set(0, provider);
  getProviderMock.mockImplementation(async (locationId: number | null) => {
    const resolvedLocationId = locationId ?? 0;
    provider = providersByLocation.get(resolvedLocationId) ?? new FakeInteractiveProvider(resolvedLocationId);
    providersByLocation.set(resolvedLocationId, provider);
    return provider;
  });
});

afterAll(async () => {
  if (organizationId) await deleteOrganization(organizationId);
  for (const id of foreignOrganizationIds) await deleteOrganization(id);
});

describe("interactive partner payment PostgreSQL boundary", () => {
  it("charges self and accepted direct partner as one parent payment with recipient allocations", async () => {
    const scenario = await createScenario("one-parent");
    const recipients = [selection(scenario.payerBowlerId), selection(scenario.partnerBowlerId)];
    const quote = await quoteInteractivePartnerPayments({ organizationId, leagueId: scenario.leagueId, payerBowlerId: scenario.payerBowlerId, recipients });
    const result = await chargeInteractivePartnerPayments({
      organizationId,
      leagueId: scenario.leagueId,
      actorUserId,
      payerBowlerId: scenario.payerBowlerId,
      request: {
        recipients,
        sourceId: "cnon:partner-one-parent",
        sourceKind: "new_card",
        storeCard: false,
        idempotencyKey: `partner-one-parent-${suffix}`,
        requestFingerprint: quote.fingerprint,
      },
    });
    expect(result.status).toBe("succeeded");
    expect(provider.processCalls).toHaveLength(1);
    expect(provider.processCalls[0]).toMatchObject({ amount: 2_000, sourceId: "cnon:partner-one-parent" });
    const rows = await db.select().from(payments).where(and(eq(payments.organizationId, organizationId), eq(payments.leagueId, scenario.leagueId)));
    expect(rows).toHaveLength(1);
    const payment = required(rows[0], "payment");
    expect(payment).toMatchObject({ bowlerId: scenario.payerBowlerId, amount: 2_000, providerPaymentId: "square-partner-payment-1" });
    const allocations = await db.select().from(paymentAllocations).where(and(eq(paymentAllocations.organizationId, organizationId), eq(paymentAllocations.leagueId, scenario.leagueId), eq(paymentAllocations.paymentId, payment.id), eq(paymentAllocations.state, "active")));
    expect(allocations).toHaveLength(2);
    expect(new Set(allocations.map((row) => row.obligationId)).size).toBe(2);
    expect(allocations.reduce((sum, row) => sum + row.amountMinor, 0)).toBe(2_000);
  });

  it("exposes only self and accepted direct partners, rejecting pending links, cross-league, and cross-tenant recipients", async () => {
    const scenario = await createScenario("authz");
    const participants = await readInteractivePaymentParticipants({ organizationId, leagueId: scenario.leagueId, payerBowlerId: scenario.payerBowlerId });
    expect(participants.participants.map((row) => row.bowlerId)).toEqual([scenario.payerBowlerId, scenario.partnerBowlerId]);
    expect(participants.participants.map((row) => row.role)).toEqual(["self", "partner"]);

    await expectRosterError(quoteInteractivePartnerPayments({ organizationId, leagueId: scenario.leagueId, payerBowlerId: scenario.payerBowlerId, recipients: [selection(scenario.pendingBowlerId)] }), "PARTNER_AUTHORIZATION_REQUIRED");

    const crossLeague = required((await db.insert(bowlers).values({ name: "Cross league target", organizationId }).returning({ id: bowlers.id }))[0], "cross-league bowler");
    const otherLeague = required((await db.insert(leagues).values({
      name: "Cross league only target",
      organizationId,
      locationId: scenario.locationId,
      paymentMode: "weekly",
      payingLineupSize: 3,
      substituteAccess: "team_only",
      substitutePaymentRegime: "team_choice",
      weeklyFee: 1_000,
      seasonStart: "2039-01-01T00:00:00.000Z",
      seasonEnd: "2039-12-31T23:59:59.000Z",
      weekDay: "Monday",
      timezone: "UTC",
    }).returning({ id: leagues.id }))[0], "cross-league");
    const otherTeam = required((await db.insert(teams).values({ name: "Cross league target team", number: 1, leagueId: otherLeague.id }).returning({ id: teams.id }))[0], "cross-league team");
    await db.insert(bowlerLeagues).values({ bowlerId: crossLeague.id, leagueId: otherLeague.id, teamId: otherTeam.id, active: true });
    await db.insert(bowlerPaymentLinks).values({ bowlerAId: Math.min(scenario.payerBowlerId, crossLeague.id), bowlerBId: Math.max(scenario.payerBowlerId, crossLeague.id), organizationId, status: "accepted", createdByUserId: actorUserId, respondedAt: "2039-01-01T00:00:00.000Z" });
    await expectRosterError(quoteInteractivePartnerPayments({ organizationId, leagueId: scenario.leagueId, payerBowlerId: scenario.payerBowlerId, recipients: [selection(crossLeague.id)] }), "PARTNER_AUTHORIZATION_REQUIRED");

    const foreignOrganization = required((await db.insert(organizations).values({ name: "Foreign partner target", slug: `interactive-partner-foreign-${suffix}` }).returning({ id: organizations.id }))[0], "foreign organization");
    foreignOrganizationIds.push(foreignOrganization.id);
    const foreignBowler = required((await db.insert(bowlers).values({ name: "Foreign target", organizationId: foreignOrganization.id }).returning({ id: bowlers.id }))[0], "foreign bowler");
    await db.insert(bowlerPaymentLinks).values({ bowlerAId: Math.min(scenario.payerBowlerId, foreignBowler.id), bowlerBId: Math.max(scenario.payerBowlerId, foreignBowler.id), organizationId, status: "accepted", createdByUserId: actorUserId, respondedAt: "2039-01-01T00:00:00.000Z" });
    await expectRosterError(quoteInteractivePartnerPayments({ organizationId, leagueId: scenario.leagueId, payerBowlerId: scenario.payerBowlerId, recipients: [selection(foreignBowler.id)] }), "PARTNER_AUTHORIZATION_REQUIRED");
  });

  it("permits partner-only payment when the payer has no debt and stores no synthetic self evidence", async () => {
    const scenario = await createScenario("partner-only");
    await db.update(paymentObligations).set({ state: "voided", voidedAt: "2039-12-31T23:59:59.000Z" }).where(and(eq(paymentObligations.organizationId, organizationId), eq(paymentObligations.leagueId, scenario.leagueId), eq(paymentObligations.payerBowlerId, scenario.payerBowlerId)));
    const recipients = [selection(scenario.partnerBowlerId, 1, true)];
    const quote = await quoteInteractivePartnerPayments({ organizationId, leagueId: scenario.leagueId, payerBowlerId: scenario.payerBowlerId, recipients });
    expect(quote.partnerEvidence).toEqual([expect.objectContaining({ recipientBowlerId: scenario.partnerBowlerId, role: "partner", paymentLinkId: scenario.acceptedLinkId })]);
    expect(quote.partnerEvidence[0]?.linkFingerprint).toBe(scenario.acceptedLinkFingerprint);
    expect(quote.partnerEvidence.some((row) => row.role === "self")).toBe(false);
    const result = await chargeInteractivePartnerPayments({ organizationId, leagueId: scenario.leagueId, actorUserId, payerBowlerId: scenario.payerBowlerId, request: { recipients, sourceId: "cnon:partner-only", sourceKind: "new_card", idempotencyKey: `interactive-partner-only-${suffix}`, requestFingerprint: quote.fingerprint } });
    expect(result.status).toBe("succeeded");
    const snapshot = required((await db.select({ partnerEvidence: paymentOperationRosterSnapshots.partnerEvidence }).from(paymentOperationRosterSnapshots).where(eq(paymentOperationRosterSnapshots.leagueId, scenario.leagueId)))[0], "partner snapshot");
    expect(snapshot.partnerEvidence).toEqual([expect.objectContaining({ recipientBowlerId: scenario.partnerBowlerId, role: "partner" })]);
  });

  it("replays the frozen authorized operation after unlink without a second provider charge", async () => {
    const scenario = await createScenario("unlink-replay");
    const recipients = [selection(scenario.partnerBowlerId)];
    const quote = await quoteInteractivePartnerPayments({ organizationId, leagueId: scenario.leagueId, payerBowlerId: scenario.payerBowlerId, recipients });
    const request = { recipients, sourceId: "cnon:unlink-replay", sourceKind: "new_card" as const, idempotencyKey: `interactive-unlink-replay-${suffix}`, requestFingerprint: quote.fingerprint };
    const first = await chargeInteractivePartnerPayments({ organizationId, leagueId: scenario.leagueId, actorUserId, payerBowlerId: scenario.payerBowlerId, request });
    expect(first.status).toBe("succeeded");
    const callsAfterFirstCharge = provider.processCalls.length;
    await db.update(bowlerPaymentLinks).set({ status: "retired" }).where(eq(bowlerPaymentLinks.id, scenario.acceptedLinkId));
    const replay = await chargeInteractivePartnerPayments({ organizationId, leagueId: scenario.leagueId, actorUserId, payerBowlerId: scenario.payerBowlerId, request });
    expect(replay).toMatchObject({ operationId: first.operationId, status: "succeeded", providerPaymentId: first.providerPaymentId });
    expect(provider.processCalls).toHaveLength(callsAfterFirstCharge);
  });

  it("scopes combined tender reports to the payer versus the recipient and retains history after unlink", async () => {
    const scenario = await createScenario("report-scope", 5);
    const recipients = [selection(scenario.payerBowlerId, 3), selection(scenario.partnerBowlerId, 2)];
    const quote = await quoteInteractivePartnerPayments({ organizationId, leagueId: scenario.leagueId, payerBowlerId: scenario.payerBowlerId, recipients });
    const result = await chargeInteractivePartnerPayments({
      organizationId,
      leagueId: scenario.leagueId,
      actorUserId,
      payerBowlerId: scenario.payerBowlerId,
      request: {
        recipients,
        sourceId: "cnon:report-scope",
        sourceKind: "new_card",
        idempotencyKey: `interactive-report-scope-${suffix}`,
        requestFingerprint: quote.fingerprint,
      },
    });
    expect(result.status).toBe("succeeded");

    const payerReport = await readCanonicalPaymentReport({ organizationId, leagueId: scenario.leagueId, bowlerId: scenario.payerBowlerId });
    const partnerReport = await readCanonicalPaymentReport({ organizationId, leagueId: scenario.leagueId, bowlerId: scenario.partnerBowlerId });
    expect(payerReport.rows).toHaveLength(1);
    expect(partnerReport.rows).toHaveLength(1);
    expect(payerReport.rows[0]).toMatchObject({ amountMinor: 5_000, allocatedMinor: 5_000, effectiveAllocatedMinor: 5_000 });
    expect(payerReport.totals).toMatchObject({ grossConfirmedPaidMinor: 5_000, activeAllocatedMinor: 5_000, effectiveAllocatedMinor: 5_000 });
    // The raw canonical row is the same tender for both authorized readers;
    // the scoped aggregate and ordinary-reader projection carry recipient
    // privacy and own-amount semantics.
    expect(partnerReport.rows[0]).toMatchObject({ amountMinor: 5_000, allocatedMinor: 5_000 });
    expect(partnerReport.totals).toMatchObject({ grossConfirmedPaidMinor: 2_000, activeAllocatedMinor: 2_000, effectiveAllocatedMinor: 2_000 });
    const payerView = redactCanonicalPaymentRow(required(payerReport.rows[0], "payer report row"), scenario.payerBowlerId);
    const partnerView = redactCanonicalPaymentRow(required(partnerReport.rows[0], "partner report row"), scenario.partnerBowlerId);
    expect(payerView.amountMinor).toBe(5_000);
    expect(payerView.appliedTo).toHaveLength(5);
    expect(payerView.appliedTo?.some((row) => row.bowlerName === `Partner report-scope`)).toBe(true);
    expect(partnerView.amountMinor).toBe(2_000);
    expect(partnerView.appliedTo).toHaveLength(2);
    expect(partnerView.appliedTo?.every((row) => row.bowlerName === undefined)).toBe(true);
    expect(partnerView.allocations).toEqual([]);
    expect(partnerView.providerPaymentId).toBeNull();
    expect(partnerView.receipt.receiptUrl).toBeNull();
    expect(partnerView.receipt.receiptNumber).toBeNull();

    await db.update(bowlerPaymentLinks).set({ status: "retired" }).where(eq(bowlerPaymentLinks.id, scenario.acceptedLinkId));
    const partnerHistoryAfterUnlink = await readCanonicalPaymentReport({ organizationId, leagueId: scenario.leagueId, bowlerId: scenario.partnerBowlerId });
    expect(partnerHistoryAfterUnlink.rows).toHaveLength(1);
    expect(partnerHistoryAfterUnlink.totals).toMatchObject({ grossConfirmedPaidMinor: 2_000, activeAllocatedMinor: 2_000, effectiveAllocatedMinor: 2_000 });
  });

  it("shows an unresolved partner-only snapshot to the payer while exposing only own amount to the recipient", async () => {
    const scenario = await createScenario("report-unresolved", 2);
    const recipients = [selection(scenario.partnerBowlerId, 2, true)];
    const { operation } = await prepareUnresolvedPartnerOperation(scenario, recipients);
    const payerReport = await readCanonicalPaymentReport({ organizationId, leagueId: scenario.leagueId, bowlerId: scenario.payerBowlerId });
    const partnerReport = await readCanonicalPaymentReport({ organizationId, leagueId: scenario.leagueId, bowlerId: scenario.partnerBowlerId });
    expect(payerReport.rows).toHaveLength(1);
    expect(payerReport.rows[0]).toMatchObject({ paymentId: null, paymentOperationId: operation.id, amountMinor: 2_000, allocatedMinor: 0, effectiveAllocatedMinor: 0, unresolved: true });
    expect(payerReport.totals).toMatchObject({ unresolvedOperationMinor: 2_000, activeAllocatedMinor: 0, effectiveAllocatedMinor: 0 });
    expect(partnerReport.rows).toHaveLength(1);
    expect(partnerReport.rows[0]).toMatchObject({ paymentId: null, paymentOperationId: operation.id, amountMinor: 2_000, allocatedMinor: 0, effectiveAllocatedMinor: 0, unresolved: true });
    expect(partnerReport.totals).toMatchObject({ unresolvedOperationMinor: 2_000, activeAllocatedMinor: 0, effectiveAllocatedMinor: 0 });
    const payerView = redactCanonicalPaymentRow(required(payerReport.rows[0], "payer unresolved report row"), scenario.payerBowlerId);
    const partnerView = redactCanonicalPaymentRow(required(partnerReport.rows[0], "partner unresolved report row"), scenario.partnerBowlerId);
    expect(payerView.amountMinor).toBe(2_000);
    expect(payerView.appliedTo).toHaveLength(2);
    expect(partnerView.amountMinor).toBe(2_000);
    expect(partnerView.appliedTo).toHaveLength(2);
    expect(partnerView.allocatedMinor).toBe(0);
    expect(partnerView.effectiveAllocatedMinor).toBe(0);
    expect(partnerView.allocations).toEqual([]);
    expect(partnerView.providerPaymentId).toBeNull();
    expect(partnerView.receipt.receiptUrl).toBeNull();
    expect(partnerView.receipt.receiptNumber).toBeNull();
  });

  it.each(["still_owed", "waived"] as const)("refunds the whole combined tender with %s conservation", async (disposition) => {
    const scenario = await createScenario(`refund-combined-${disposition}`, 5);
    const recipients = [selection(scenario.payerBowlerId, 3), selection(scenario.partnerBowlerId, 2)];
    const quote = await quoteInteractivePartnerPayments({ organizationId, leagueId: scenario.leagueId, payerBowlerId: scenario.payerBowlerId, recipients });
    const charged = await chargeInteractivePartnerPayments({
      organizationId,
      leagueId: scenario.leagueId,
      actorUserId,
      payerBowlerId: scenario.payerBowlerId,
      request: {
        recipients,
        sourceId: `cnon:refund-combined-${disposition}`,
        sourceKind: "new_card",
        idempotencyKey: `refund-combined-${disposition}-${suffix}`,
        requestFingerprint: quote.fingerprint,
      },
    });
    expect(charged.status).toBe("succeeded");
    const payment = required((await db.select().from(payments).where(and(
      eq(payments.organizationId, organizationId),
      eq(payments.leagueId, scenario.leagueId),
    )))[0], "combined refund payment");
    expect(payment).toMatchObject({ amount: 5_000, status: "paid", type: "square" });
    const processCallCount = provider.processCalls.length;

    const prepared = await prepareRefundPaymentOperation({
      paymentId: payment.id,
      disposition,
      requestedByUserId: actorUserId,
      requestedByRole: "org_admin",
      requestedByOrganizationId: organizationId,
    });
    if (prepared.snapshot.snapshotVersion !== 2) throw new Error("combined refund fixture did not persist a v2 snapshot");
    expect(prepared.snapshot.allocations).toHaveLength(5);
    const refundExecutor = new RefundPaymentOperationExecutor({
      leaseOwner: `partner-refund-${disposition}-${suffix}`,
      getProvider: getProviderMock,
    });
    const refunded = await refundExecutor.execute({ organizationId, operationId: prepared.operation.id });
    expect(refunded).toMatchObject({ status: "succeeded", providerObjectId: expect.stringMatching(/^square-partner-refund-/) });
    expect(provider.refundCalls).toHaveLength(1);
    expect(provider.refundCalls[0]).toMatchObject({
      paymentId: payment.providerPaymentId,
      amount: 5_000,
      reason: "Refund processed via LeagueVault",
      idempotencyKey: prepared.operation.providerIdempotencyKey,
    });
    expect(provider.processCalls).toHaveLength(processCallCount);

    const allocationRows = await db.select({
      id: paymentAllocations.id,
      obligationId: paymentAllocations.obligationId,
      amountMinor: paymentAllocations.amountMinor,
      payerBowlerId: paymentObligations.payerBowlerId,
    }).from(paymentAllocations).innerJoin(paymentObligations, eq(paymentObligations.id, paymentAllocations.obligationId)).where(and(
      eq(paymentAllocations.organizationId, organizationId),
      eq(paymentAllocations.leagueId, scenario.leagueId),
      eq(paymentAllocations.paymentId, payment.id),
      eq(paymentAllocations.state, "active"),
    ));
    expect(allocationRows).toHaveLength(5);
    expect(allocationRows.filter((row) => row.payerBowlerId === scenario.payerBowlerId)).toHaveLength(3);
    expect(allocationRows.filter((row) => row.payerBowlerId === scenario.partnerBowlerId)).toHaveLength(2);
    expect(allocationRows.reduce((sum, row) => sum + row.amountMinor, 0)).toBe(5_000);
    const adjustments = await db.select().from(refundAllocationAdjustments).where(and(
      eq(refundAllocationAdjustments.organizationId, organizationId),
      eq(refundAllocationAdjustments.leagueId, scenario.leagueId),
      eq(refundAllocationAdjustments.refundOperationId, prepared.operation.id),
      inArray(refundAllocationAdjustments.sourceAllocationId, allocationRows.map((row) => row.id)),
    ));
    expect(adjustments).toHaveLength(5);
    expect([...new Set(adjustments.map((row) => row.sourceAllocationId))].sort()).toEqual(allocationRows.map((row) => row.id).sort());
    expect(adjustments.every((row) => row.disposition === disposition && row.amountMinor === 1_000)).toBe(true);
    expect(adjustments.reduce((sum, row) => sum + row.amountMinor, 0)).toBe(5_000);

    const expectedDue = disposition === "still_owed"
      ? { state: "open", allocatedMinor: 0, grossAllocatedMinor: 1_000, refundedMinor: 1_000, waivedMinor: 0, outstandingMinor: 1_000, stillOwed: true }
      : { state: "settled", allocatedMinor: 0, grossAllocatedMinor: 1_000, refundedMinor: 1_000, waivedMinor: 1_000, outstandingMinor: 0, stillOwed: false };
    const payerDue = await readCanonicalDuePastDue({ organizationId, leagueId: scenario.leagueId, payerBowlerId: scenario.payerBowlerId });
    const partnerDue = await readCanonicalDuePastDue({ organizationId, leagueId: scenario.leagueId, payerBowlerId: scenario.partnerBowlerId });
    for (const row of allocationRows) {
      const due = required((row.payerBowlerId === scenario.payerBowlerId ? payerDue : partnerDue).rows.find((candidate) => candidate.id === row.obligationId), "refunded obligation");
      expect(due).toMatchObject(expectedDue);
    }
    const payerHeld = payerDue.rows.filter((row) => row.stillOwed).map((row) => row.id);
    const partnerHeld = partnerDue.rows.filter((row) => row.stillOwed).map((row) => row.id);
    expect(payerHeld).toHaveLength(disposition === "still_owed" ? 3 : 0);
    expect(partnerHeld).toHaveLength(disposition === "still_owed" ? 2 : 0);

    const payerReport = await readCanonicalPaymentReport({ organizationId, leagueId: scenario.leagueId, bowlerId: scenario.payerBowlerId });
    const partnerReport = await readCanonicalPaymentReport({ organizationId, leagueId: scenario.leagueId, bowlerId: scenario.partnerBowlerId });
    const expectedWaived = disposition === "waived" ? 5_000 : 0;
    expect(payerReport.totals).toMatchObject({ grossConfirmedPaidMinor: 5_000, activeAllocatedMinor: 5_000, refundedMinor: 5_000, refundedAllocationMinor: 5_000, waivedMinor: expectedWaived, effectiveAllocatedMinor: 0 });
    expect(partnerReport.totals).toMatchObject({ grossConfirmedPaidMinor: 2_000, activeAllocatedMinor: 2_000, refundedMinor: 2_000, refundedAllocationMinor: 2_000, waivedMinor: disposition === "waived" ? 2_000 : 0, effectiveAllocatedMinor: 0 });

    const retried = await new RefundPaymentOperationExecutor({
      leaseOwner: `partner-refund-retry-${disposition}-${suffix}`,
      getProvider: getProviderMock,
    }).execute({ organizationId, operationId: prepared.operation.id });
    expect(retried?.status).toBe("succeeded");
    expect(provider.refundCalls).toHaveLength(1);
    const operations = await db.select({ operationType: paymentOperations.operationType }).from(paymentOperations).where(and(
      eq(paymentOperations.organizationId, organizationId),
      eq(paymentOperations.leagueId, scenario.leagueId),
    ));
    expect(operations.filter((row) => row.operationType === "interactive_charge")).toHaveLength(1);
    expect(operations.filter((row) => row.operationType === "refund")).toHaveLength(1);
    expect(operations.filter((row) => row.operationType === "standing_autopay_charge")).toHaveLength(0);
  });

  it("reserves every recipient atomically when a competing charge races the same oldest obligation", async () => {
    const scenario = await createScenario("reservation-race");
    provider = await getProviderMock(scenario.locationId);
    const competingPayer = required((await db.insert(bowlers).values({ name: "Competing payer", email: "competing-payer@example.test", organizationId }).returning({ id: bowlers.id }))[0], "competing payer");
    const competingTeam = required((await db.insert(teams).values({ name: "Competing payer team", number: 2, leagueId: scenario.leagueId }).returning({ id: teams.id }))[0], "competing team");
    await db.insert(bowlerLeagues).values({ bowlerId: competingPayer.id, leagueId: scenario.leagueId, teamId: competingTeam.id, active: true });
    await db.insert(teamPaymentSlots).values([0, 1, 2].map((slotIndex) => ({ organizationId, leagueId: scenario.leagueId, teamId: competingTeam.id, slotIndex, lineupSize: 3, occupant: "vacant" as const, mainBowlerId: null, recordedByUserId: actorUserId })));
    await db.insert(bowlerPaymentLinks).values({ bowlerAId: Math.min(competingPayer.id, scenario.partnerBowlerId), bowlerBId: Math.max(competingPayer.id, scenario.partnerBowlerId), organizationId, status: "accepted", createdByUserId: actorUserId, respondedAt: "2039-01-01T00:00:00.000Z" });
    const firstRecipients = [selection(scenario.payerBowlerId), selection(scenario.partnerBowlerId)];
    const firstQuote = await quoteInteractivePartnerPayments({ organizationId, leagueId: scenario.leagueId, payerBowlerId: scenario.payerBowlerId, recipients: firstRecipients });
    const competingRecipients = [selection(scenario.partnerBowlerId)];
    const competingQuote = await quoteInteractivePartnerPayments({ organizationId, leagueId: scenario.leagueId, payerBowlerId: competingPayer.id, recipients: competingRecipients });
    const release = provider.blockNextProcess();
    let firstCharge: ReturnType<typeof chargeInteractivePartnerPayments> | undefined;
    let competing: ReturnType<typeof chargeInteractivePartnerPayments> | undefined;
    try {
      const processStarted = provider.waitForProcessStart();
      firstCharge = chargeInteractivePartnerPayments({ organizationId, leagueId: scenario.leagueId, actorUserId, payerBowlerId: scenario.payerBowlerId, request: { recipients: firstRecipients, sourceId: "cnon:reservation-first", sourceKind: "new_card", idempotencyKey: `reservation-first-${suffix}`, requestFingerprint: firstQuote.fingerprint } });
      await processStarted;
      competing = chargeInteractivePartnerPayments({ organizationId, leagueId: scenario.leagueId, actorUserId, payerBowlerId: competingPayer.id, request: { recipients: competingRecipients, sourceId: "cnon:reservation-competing", sourceKind: "new_card", idempotencyKey: `reservation-competing-${suffix}`, requestFingerprint: competingQuote.fingerprint } });
      await expectRosterError(competing, "OBLIGATION_RESERVED");
      const reserved = await db.select({ bowlerId: paymentObligations.payerBowlerId }).from(paymentOperationRosterSnapshotItems).innerJoin(paymentObligations, eq(paymentObligations.id, paymentOperationRosterSnapshotItems.obligationId)).where(and(eq(paymentOperationRosterSnapshotItems.organizationId, organizationId), eq(paymentOperationRosterSnapshotItems.leagueId, scenario.leagueId), eq(paymentOperationRosterSnapshotItems.state, "reserved")));
      expect(reserved.map((row) => row.bowlerId).sort()).toEqual([scenario.payerBowlerId, scenario.partnerBowlerId].sort());
      release();
      await expect(firstCharge).resolves.toMatchObject({ status: "succeeded" });
      const operations = await db.select({ operationId: paymentOperationRosterSnapshotItems.operationId }).from(paymentOperationRosterSnapshotItems).where(and(eq(paymentOperationRosterSnapshotItems.organizationId, organizationId), eq(paymentOperationRosterSnapshotItems.leagueId, scenario.leagueId)));
      expect(new Set(operations.map((row) => row.operationId)).size).toBe(1);
    } finally {
      release();
      if (firstCharge) await firstCharge.catch(() => undefined);
      if (competing) await competing.catch(() => undefined);
    }
  });

  it("keeps a 26-obligation partner quote and reservation above the legacy v2 limit", async () => {
    const scenario = await createScenario("over-twenty-five", 26);
    const recipients = [selection(scenario.partnerBowlerId, 26, true)];
    const quote = await quoteInteractivePartnerPayments({ organizationId, leagueId: scenario.leagueId, payerBowlerId: scenario.payerBowlerId, recipients });
    expect(quote.allocations).toHaveLength(26);
    expect(quote.amountMinor).toBe(26_000);
    const result = await chargeInteractivePartnerPayments({ organizationId, leagueId: scenario.leagueId, actorUserId, payerBowlerId: scenario.payerBowlerId, request: { recipients, sourceId: "cnon:over-twenty-five", sourceKind: "new_card", idempotencyKey: `over-twenty-five-${suffix}`, requestFingerprint: quote.fingerprint } });
    expect(result.status).toBe("succeeded");
    const payment = required((await db.select({ id: payments.id, amount: payments.amount }).from(payments).where(and(eq(payments.organizationId, organizationId), eq(payments.leagueId, scenario.leagueId))))[0], "over-25 payment");
    expect(payment).toMatchObject({ amount: 26_000 });
    const allocations = await db.select({ id: paymentAllocations.id }).from(paymentAllocations).where(and(eq(paymentAllocations.organizationId, organizationId), eq(paymentAllocations.leagueId, scenario.leagueId), eq(paymentAllocations.paymentId, payment.id), eq(paymentAllocations.state, "active")));
    expect(allocations).toHaveLength(26);
  });
});
