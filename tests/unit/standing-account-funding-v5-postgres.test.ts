import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { accountPaymentParticipantsResponseV4Schema } from "@shared/account-payment-v4-contract";
import {
  accountPaymentOperationSnapshots,
  autopayConsents,
  bowlerLeagues,
  bowlers,
  leagueOccurrenceBillingTerms,
  leagueOccurrences,
  leagueScheduleCommands,
  leagues,
  locations,
  organizations,
  paymentAllocations,
  paymentOperationRosterSnapshotItems,
  paymentOperationRosterSnapshots,
  paymentOperationStandingAutopayParticipants,
  paymentOperations,
  payments,
  teamPaymentSlots,
  teams,
  users,
  weeklyPaymentFundings,
  weeklyPaymentLedgerAdoptions,
} from "@shared/schema";
import { getTestDb } from "../setup/test-db";
import { deleteOrganization } from "../../server/storage/organizations";
import { materializeRosterPaymentOccurrenceInTransaction } from "../../server/services/roster-payment-materializer";
import { RosterStandingAutopayOperationExecutor } from "../../server/services/roster-standing-autopay-executor";
import { prepareStandingAutopayCutoff } from "../../server/services/roster-standing-autopay";
import { readInteractivePaymentParticipantsV4 } from "../../server/services/account-payment-funding";
import { encrypt } from "../../server/utils/crypto";

process.env.SCHEDULED_PAYMENT_EXECUTION_MODE = "ledger_execute";
process.env.ROSTER_STANDING_AUTOPAY_ENABLED = "true";

vi.mock("../../server/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/config")>();
  return { ...actual, scheduledPaymentExecutionMode: "ledger_execute", rosterStandingAutopayEnabled: true };
});

const db = getTestDb();
const poolId = process.env.VITEST_POOL_ID ?? "0";
const organizationSlug = `v5-standing-funding-${poolId}`;
let organizationId: number;
let leagueId: number;
let locationId: number;
let actorUserId: number;
let payerBowlerId: number;
let occurrenceId: string;

beforeAll(async () => {
  for (const row of await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, organizationSlug))) {
    await deleteOrganization(row.id);
  }

  const [organization] = await db.insert(organizations).values({ name: "V5 Standing Funding Fixture", slug: organizationSlug }).returning({ id: organizations.id });
  organizationId = organization.id;
  const [location] = await db.insert(locations).values({ organizationId, name: "V5 Standing Funding Location" }).returning({ id: locations.id });
  locationId = location.id;
  const [league] = await db.insert(leagues).values({
    name: "V5 Standing Funding League",
    organizationId,
    locationId,
    payingLineupSize: 3,
    substituteAccess: "team_only",
    substitutePaymentRegime: "team_choice",
    weeklyFee: 2_000,
    lineageFee: null,
    prizeFundFee: null,
    paymentMode: "weekly",
    seasonStart: "2039-01-01T00:00:00.000Z",
    seasonEnd: "2039-12-31T23:59:59.000Z",
    weekDay: "Monday",
    timezone: "UTC",
  }).returning({ id: leagues.id });
  leagueId = league.id;

  const [actor] = await db.insert(users).values({
    email: `v5-standing-admin-${poolId}@example.test`,
    password: "deterministic-test-password-hash",
    name: "V5 Standing Admin",
    role: "org_admin",
    organizationId,
  }).returning({ id: users.id });
  actorUserId = actor.id;
  const [team] = await db.insert(teams).values({ name: "V5 Standing Team", number: 1, leagueId }).returning({ id: teams.id });
  const [payer] = await db.insert(bowlers).values({ name: "V5 Standing Payer", organizationId, paymentCustomerId: "customer-v5-fixture" }).returning({ id: bowlers.id });
  payerBowlerId = payer.id;
  const [payerUser] = await db.insert(users).values({
    email: `v5-standing-payer-${poolId}@example.test`,
    password: "deterministic-test-password-hash",
    name: "V5 Standing Payer Account",
    role: "user",
    organizationId,
  }).returning({ id: users.id });
  await db.update(users).set({ bowlerId: payerBowlerId }).where(eq(users.id, payerUser.id));
  await db.insert(bowlerLeagues).values({ bowlerId: payerBowlerId, leagueId, teamId: team.id, active: true });
  await db.insert(teamPaymentSlots).values([
    { organizationId, leagueId, teamId: team.id, slotIndex: 0, lineupSize: 3, occupant: "main", mainBowlerId: payerBowlerId, recordedByUserId: actorUserId },
    { organizationId, leagueId, teamId: team.id, slotIndex: 1, lineupSize: 3, occupant: "vacant", mainBowlerId: null, recordedByUserId: actorUserId },
    { organizationId, leagueId, teamId: team.id, slotIndex: 2, lineupSize: 3, occupant: "vacant", mainBowlerId: null, recordedByUserId: actorUserId },
  ]);

  await db.insert(weeklyPaymentLedgerAdoptions).values({
    organizationId,
    leagueId,
    adoptedThroughLocalDate: "2038-12-31",
    preflightFingerprint: `lvweeklyadoptpre:v1:${"a".repeat(64)}`,
    resultFingerprint: `lvweeklyadopt:v1:${"b".repeat(64)}`,
    recordedByUserId: actorUserId,
  });

  const [consent] = await db.insert(autopayConsents).values({
    organizationId,
    leagueId,
    payerBowlerId,
    consentVersion: 1,
    state: "active",
    paymentMode: "weekly",
    consentFingerprint: `lvstandingconsent:v1:${"c".repeat(64)}`,
    providerName: "square",
    providerLocationId: "square-location-v5-fixture",
    encryptedSourceId: encrypt("source-v5-fixture"),
    encryptedCustomerId: encrypt("customer-v5-fixture"),
    createdByUserId: actorUserId,
    activatedAt: "2039-01-01T00:00:00.000Z",
  }).returning({ id: autopayConsents.id });

  const commandId = randomUUID();
  await db.insert(leagueScheduleCommands).values({
    id: commandId,
    organizationId,
    leagueId,
    actorUserId,
    commandType: "publish",
    idempotencyKey: `v5-standing-publish-${randomUUID()}`,
    requestFingerprint: `v5-standing-publish-fingerprint-${randomUUID()}`,
  });
  const startsAt = "2039-05-02T19:00:00.000Z";
  const [occurrence] = await db.insert(leagueOccurrences).values({
    id: randomUUID(),
    organizationId,
    leagueId,
    locationId,
    generationKey: `v5-standing-occurrence-${randomUUID()}`,
    kind: "regular",
    status: "scheduled",
    lifecycle: "published",
    authoritativeLocalDate: "2039-05-02",
    authoritativeLocalStartTime: "19:00:00",
    timezone: "UTC",
    startAt: startsAt,
    selectedUtcOffsetMinutes: 0,
    foldResolution: "unambiguous",
    resolverVersion: "standing-account-v5-test",
    plannedOrdinal: 1,
    competitionNumber: 1,
    competitive: true,
    countsInStandings: true,
    publishedAt: "2039-01-01T00:00:00.000Z",
    publishedByUserId: actorUserId,
    publicationCommandId: commandId,
  }).returning({ id: leagueOccurrences.id });
  occurrenceId = occurrence.id;
  await db.insert(leagueOccurrenceBillingTerms).values({
    organizationId,
    leagueId,
    occurrenceId,
    purpose: "league_weekly_fee",
    obligationPolicy: "eligible_bowlers",
    defaultAmountMinor: 2_000,
    currency: "USD",
    billingOrdinal: 1,
    version: 1,
    state: "published",
    publishedAt: "2039-01-01T00:00:00.000Z",
    publishedByUserId: actorUserId,
    publicationCommandId: commandId,
  });
  await db.transaction(async (tx) => {
    await materializeRosterPaymentOccurrenceInTransaction(tx, { organizationId, leagueId, occurrenceId, actorUserId });
  });

  // `consent` is intentionally created before the occurrence. Keep this guard
  // here so fixture setup fails clearly if an unexpected refactor changes it.
  expect(consent.id).toBeTruthy();
});

afterAll(async () => {
  if (organizationId) await deleteOrganization(organizationId);
});

describe("V5 standing account funding finalization", () => {
  it("captures one tender, creates recipient-owned credit, and replays without another provider call", async () => {
    const [consent] = await db.select().from(autopayConsents).where(and(
      eq(autopayConsents.organizationId, organizationId),
      eq(autopayConsents.leagueId, leagueId),
      eq(autopayConsents.payerBowlerId, payerBowlerId),
      eq(autopayConsents.state, "active"),
    ));
    if (!consent) throw new Error("V5 standing consent fixture is missing");
    const participants = await readInteractivePaymentParticipantsV4({ organizationId, leagueId, payerBowlerId });
    expect(accountPaymentParticipantsResponseV4Schema.safeParse(participants).success).toBe(true);
    expect(participants).toMatchObject({
      accountingMode: "confirmed_account_v4",
      recipients: [{ bowlerId: payerBowlerId, confirmedDebtMinor: 0, confirmedPastDueMinor: 0 }],
    });
    if (participants.accountingMode !== "confirmed_account_v4") throw new Error("V5 standing fixture did not use adopted account funding");
    const payerRecipient = participants.recipients.find((recipient) => recipient.bowlerId === payerBowlerId);
    expect(typeof payerRecipient?.holdsLineupSpot).toBe("boolean");
    // The payer still owes forecast weeks, so the season cannot be paid in full.
    expect(payerRecipient?.forecastTargets.fullSeasonMinor).toBeGreaterThan(payerRecipient?.availableCreditMinor ?? 0);
    expect(payerRecipient?.seasonPaidInFull).toBe(false);
    const now = new Date();
    const operation = await prepareStandingAutopayCutoff({
      organizationId,
      leagueId,
      consentId: consent.id,
      cutoffAt: "2039-05-02T19:00:00.000Z",
      now,
    });
    if (!operation) throw new Error("V5 standing cutoff did not prepare an operation");
    expect(operation.amountMinor).toBe(2_000);

    const providerPaymentId = `v5-standing-provider-payment-${randomUUID()}`;
    const processPayment = vi.fn().mockResolvedValue({
      status: "COMPLETED",
      id: providerPaymentId,
      orderId: `v5-standing-provider-order-${randomUUID()}`,
      receiptUrl: null,
      receiptNumber: null,
    });
    const provider = {
      providerName: "square",
      locationId,
      getProviderLocationId: vi.fn().mockResolvedValue("square-location-v5-fixture"),
      validateCardId: vi.fn().mockReturnValue(true),
      hasCardOnFile: vi.fn().mockResolvedValue(true),
      processPayment,
    };
    const executor = new RosterStandingAutopayOperationExecutor({
      getProvider: vi.fn().mockResolvedValue(provider) as never,
    });
    const first = await executor.execute({ organizationId, operationId: operation.id, now });
    expect(first?.status).toBe("succeeded");
    expect(processPayment).toHaveBeenCalledTimes(1);

    const [payment] = await db.select().from(payments).where(and(
      eq(payments.organizationId, organizationId),
      eq(payments.leagueId, leagueId),
      eq(payments.paymentOperationId, operation.id),
    ));
    if (!payment) throw new Error("V5 standing provider receipt is missing");
    expect(payment).toMatchObject({ bowlerId: payerBowlerId, amount: 2_000, providerPaymentId, status: "paid" });
    const fundings = await db.select().from(weeklyPaymentFundings).where(and(
      eq(weeklyPaymentFundings.organizationId, organizationId),
      eq(weeklyPaymentFundings.leagueId, leagueId),
      eq(weeklyPaymentFundings.paymentId, payment.id),
    ));
    expect(fundings).toMatchObject([{
      creditedBowlerId: payerBowlerId,
      portionIndex: 0,
      amountMinor: 2_000,
      source: "provider",
      authorizationKind: "provider_snapshot",
      authorizationOperationId: operation.id,
    }]);
    expect(await db.select().from(paymentAllocations).where(eq(paymentAllocations.paymentId, payment.id))).toHaveLength(0);
    expect(await db.select().from(paymentOperationRosterSnapshots).where(eq(paymentOperationRosterSnapshots.operationId, operation.id))).toHaveLength(0);
    expect(await db.select().from(paymentOperationRosterSnapshotItems).where(eq(paymentOperationRosterSnapshotItems.operationId, operation.id))).toHaveLength(0);
    expect(await db.select().from(paymentOperationStandingAutopayParticipants).where(eq(paymentOperationStandingAutopayParticipants.operationId, operation.id))).toHaveLength(0);
    expect(await db.select().from(accountPaymentOperationSnapshots).where(eq(accountPaymentOperationSnapshots.operationId, operation.id))).toMatchObject([{
      snapshotVersion: 5,
      snapshotKind: "standing_funding",
      amountMinor: 2_000,
    }]);

    const replay = await executor.execute({ organizationId, operationId: operation.id, now: new Date(now.getTime() + 1_000) });
    expect(replay?.status).toBe("succeeded");
    expect(replay?.providerObjectId).toBe(providerPaymentId);
    expect(processPayment).toHaveBeenCalledTimes(1);
    expect(await db.select().from(payments).where(eq(payments.paymentOperationId, operation.id))).toHaveLength(1);
    expect(await db.select().from(weeklyPaymentFundings).where(eq(weeklyPaymentFundings.paymentId, payment.id))).toHaveLength(1);
  });
});
