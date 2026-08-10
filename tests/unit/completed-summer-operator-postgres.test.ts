import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  bowlers,
  games,
  interactivePaymentOperationAllocations,
  interactivePaymentOperationSnapshots,
  leagueOccurrenceBillingTerms,
  leagueOccurrenceGenerationDiscrepancies,
  leagueOccurrenceGenerationRuns,
  leagueOccurrenceRelationships,
  leagueOccurrences,
  leagueScheduleCommands,
  leagueScheduleExceptions,
  leagues,
  locations,
  organizations,
  paymentOperations,
  payments,
  scores,
  teams,
} from "@shared/schema";
import { deleteOrganization } from "../../server/storage/organizations";
import { getTestDb } from "../setup/test-db";

const db = getTestDb();
const suffix = `${process.env.VITEST_POOL_ID ?? "0"}-${Date.now()}`;
let organizationId: number;
let foreignOrganizationId: number;
let activeLeagueId: number;
let archivedLeagueId: number;
let foreignLeagueId: number;
let excludedLeagueId: number;
let orgLessLeagueId: number;
let operationId: string;
let ownLocationId: number;
let paymentBowlerId: number;
let linkedPaymentId: number;

async function createLeague(input: {
  organizationId: number | null;
  locationId: number | null;
  name: string;
  active?: boolean;
  seasonStart: string;
  seasonEnd: string;
  totalBowlingWeeks: number;
}): Promise<number> {
  const [league] = await db.insert(leagues).values({
    name: input.name,
    organizationId: input.organizationId,
    locationId: input.locationId,
    active: input.active ?? true,
    seasonStart: input.seasonStart,
    seasonEnd: input.seasonEnd,
    weekDay: "Sunday",
    competitionStartTime: "19:00",
    timezone: "America/New_York",
    totalBowlingWeeks: input.totalBowlingWeeks,
    weeklyFee: 2_000,
    paymentMode: "weekly",
  }).returning({ id: leagues.id });
  if (!league) throw new Error("B1 league fixture was not created");
  return league.id;
}

beforeAll(async () => {
  const [ownOrg, foreignOrg] = await db.insert(organizations).values([
    { name: "B1 Operator Tenant", slug: `b1-operator-${suffix}` },
    { name: "B1 Foreign Tenant", slug: `b1-foreign-${suffix}` },
  ]).returning({ id: organizations.id, slug: organizations.slug });
  if (!ownOrg || !foreignOrg) throw new Error("B1 organizations were not created");
  organizationId = ownOrg.slug.startsWith("b1-operator") ? ownOrg.id : foreignOrg.id;
  foreignOrganizationId = ownOrg.slug.startsWith("b1-foreign") ? ownOrg.id : foreignOrg.id;
  const [ownLocation] = await db.insert(locations).values({ name: "B1 own location", organizationId }).returning({ id: locations.id });
  const [foreignLocation] = await db.insert(locations).values({ name: "B1 foreign location", organizationId: foreignOrganizationId }).returning({ id: locations.id });
  if (!ownLocation || !foreignLocation) throw new Error("B1 locations were not created");
  ownLocationId = ownLocation.id;

  activeLeagueId = await createLeague({
    organizationId,
    locationId: ownLocation.id,
    name: "B1 Active Summer",
    seasonStart: "2025-06-01T23:30:00.000Z",
    seasonEnd: "2025-06-08T23:30:00.000Z",
    totalBowlingWeeks: 2,
  });
  archivedLeagueId = await createLeague({
    organizationId,
    locationId: ownLocation.id,
    name: "B1 Archived Summer",
    active: false,
    seasonStart: "2025-08-03T00:00:00.000Z",
    seasonEnd: "2025-08-03T00:00:00.000Z",
    totalBowlingWeeks: 1,
  });
  foreignLeagueId = await createLeague({
    organizationId: foreignOrganizationId,
    locationId: foreignLocation.id,
    name: "B1 Foreign Secret League",
    seasonStart: "2025-06-01T00:00:00.000Z",
    seasonEnd: "2025-06-01T00:00:00.000Z",
    totalBowlingWeeks: 1,
  });
  excludedLeagueId = await createLeague({
    organizationId,
    locationId: ownLocation.id,
    name: "B1 May exclusion",
    seasonStart: "2025-05-04T00:00:00.000Z",
    seasonEnd: "2025-05-04T00:00:00.000Z",
    totalBowlingWeeks: 1,
  });
  await createLeague({
    organizationId,
    locationId: ownLocation.id,
    name: "B1 Cross-year exclusion",
    seasonStart: "2025-08-03T00:00:00.000Z",
    seasonEnd: "2026-01-04T00:00:00.000Z",
    totalBowlingWeeks: 1,
  });
  orgLessLeagueId = await createLeague({
    organizationId: null,
    locationId: null,
    name: "B1 Org-less League",
    seasonStart: "2025-06-01T00:00:00.000Z",
    seasonEnd: "2025-06-01T00:00:00.000Z",
    totalBowlingWeeks: 1,
  });

  await db.insert(games).values([
    { leagueId: activeLeagueId, weekNumber: 1, gameNumber: 1, date: "2025-06-01T19:00:00.000Z" },
    { leagueId: activeLeagueId, weekNumber: 1, gameNumber: 2, date: "2025-06-01T19:00:00.000Z" },
    { leagueId: activeLeagueId, weekNumber: 1, gameNumber: 3, date: "2025-06-01T19:00:00.000Z" },
    { leagueId: activeLeagueId, weekNumber: 2, gameNumber: 1, date: "2025-06-08T19:00:00.000Z" },
    { leagueId: activeLeagueId, weekNumber: 2, gameNumber: 2, date: "2025-06-08T19:00:00.000Z" },
    { leagueId: activeLeagueId, weekNumber: 2, gameNumber: 3, date: "2025-06-08T19:00:00.000Z" },
  ]);
  const [bowler] = await db.insert(bowlers).values({ name: "B1 Payment Bowler", organizationId }).returning({ id: bowlers.id });
  if (!bowler) throw new Error("B1 bowler was not created");
  paymentBowlerId = bowler.id;
  const [operation] = await db.insert(paymentOperations).values({
    organizationId,
    operationType: "interactive_charge",
    targetKey: `b1-target-${suffix}`,
    amountMinor: 2_000,
    currency: "USD",
    requestFingerprint: `lvpayreq:v1:${"a".repeat(64)}`,
    providerIdempotencyKey: `b1-${suffix}`.slice(0, 45),
    providerName: "square",
  }).returning({ id: paymentOperations.id });
  if (!operation) throw new Error("B1 operation was not created");
  operationId = operation.id;
  await db.transaction(async (tx) => {
    await tx.insert(interactivePaymentOperationSnapshots).values({
      operationId,
      snapshotVersion: 2,
      snapshotFingerprint: `lvpayexecic:v2:${"b".repeat(64)}`,
      leagueId: activeLeagueId,
      locationId: ownLocation.id,
      providerLocationId: "PROVIDER_LOCATION_MUST_NOT_LEAK",
      payerBowlerId: bowler.id,
      requestKind: "direct",
      encryptedSourceId: "ENCRYPTED_SOURCE_MUST_NOT_LEAK",
      encryptedCustomerId: "ENCRYPTED_CUSTOMER_MUST_NOT_LEAK",
      encryptedBuyerEmail: "ENCRYPTED_EMAIL_MUST_NOT_LEAK",
      storeCard: false,
      sourceKind: "new_card",
      weekOf: "2025-06-01T19:00:00.000Z",
    });
    await tx.insert(interactivePaymentOperationAllocations).values({
      operationId,
      allocationIndex: 0,
      bowlerId: bowler.id,
      amountMinor: 2_000,
      lineageAmountMinor: 500,
      prizeFundAmountMinor: 1_500,
      weekOf: "2025-06-01T19:00:00.000Z",
    });
  });
  const [linkedPayment] = await db.insert(payments).values({
    bowlerId: bowler.id,
    leagueId: activeLeagueId,
    amount: 2_000,
    lineageAmount: 500,
    prizeFundAmount: 1_500,
    weekOf: "2025-06-01T19:00:00.000Z",
    status: "paid",
    type: "square",
    paymentOperationId: operationId,
    paymentOperationAllocationIndex: 0,
  }).returning({ id: payments.id });
  if (!linkedPayment) throw new Error("B1 linked payment was not created");
  linkedPaymentId = linkedPayment.id;
});

afterAll(async () => {
  if (organizationId) await deleteOrganization(organizationId).catch(() => undefined);
  if (foreignOrganizationId) await deleteOrganization(foreignOrganizationId).catch(() => undefined);
  if (orgLessLeagueId) await db.delete(leagues).where(eq(leagues.id, orgLessLeagueId)).catch(() => undefined);
});

async function selectedDatabaseEvidence() {
  const leagueIds = [activeLeagueId, archivedLeagueId];
  const selectedGames = await db.select().from(games).where(inArray(games.leagueId, leagueIds)).orderBy(asc(games.id));
  return {
    leagues: await db.select().from(leagues).where(inArray(leagues.id, leagueIds)).orderBy(asc(leagues.id)),
    games: selectedGames,
    scores: selectedGames.length === 0 ? [] : await db.select().from(scores).where(inArray(scores.gameId, selectedGames.map((game) => game.id))).orderBy(asc(scores.id)),
    payments: await db.select().from(payments).where(inArray(payments.leagueId, leagueIds)).orderBy(asc(payments.id)),
    operations: await db.select().from(paymentOperations).where(eq(paymentOperations.organizationId, organizationId)).orderBy(asc(paymentOperations.id)),
    interactiveSnapshots: await db.select().from(interactivePaymentOperationSnapshots).where(eq(interactivePaymentOperationSnapshots.operationId, operationId)),
    interactiveAllocations: await db.select().from(interactivePaymentOperationAllocations).where(eq(interactivePaymentOperationAllocations.operationId, operationId)).orderBy(asc(interactivePaymentOperationAllocations.allocationIndex)),
    a1Counts: await Promise.all([
      db.select({ count: sql<number>`count(*)::integer` }).from(leagueScheduleCommands).where(eq(leagueScheduleCommands.organizationId, organizationId)),
      db.select({ count: sql<number>`count(*)::integer` }).from(leagueOccurrenceGenerationRuns).where(eq(leagueOccurrenceGenerationRuns.organizationId, organizationId)),
      db.select({ count: sql<number>`count(*)::integer` }).from(leagueScheduleExceptions).where(eq(leagueScheduleExceptions.organizationId, organizationId)),
      db.select({ count: sql<number>`count(*)::integer` }).from(leagueOccurrences).where(eq(leagueOccurrences.organizationId, organizationId)),
      db.select({ count: sql<number>`count(*)::integer` }).from(leagueOccurrenceBillingTerms).where(eq(leagueOccurrenceBillingTerms.organizationId, organizationId)),
      db.select({ count: sql<number>`count(*)::integer` }).from(leagueOccurrenceRelationships).where(eq(leagueOccurrenceRelationships.organizationId, organizationId)),
      db.select({ count: sql<number>`count(*)::integer` }).from(leagueOccurrenceGenerationDiscrepancies).where(eq(leagueOccurrenceGenerationDiscrepancies.organizationId, organizationId)),
    ]),
  };
}

function runOperator(extraArgs: string[] = []) {
  const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("test database URL is missing");
  const tsx = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  return spawnSync(process.execPath, [tsx, "scripts/compare-completed-summer-occurrences.ts",
    `--organizationId=${organizationId}`,
    "--seasonYear=2025",
    "--asOfDate=2026-01-01",
    "--sourceScheduleRevision=1",
    "--ambiguousFold=reject",
    "--currency=USD",
    "--regularSessionBillingPolicy=eligible_bowlers",
    "--billingOrdinalPolicy=planned_slot",
    ...extraArgs,
  ], { encoding: "utf8", env: { ...process.env, DATABASE_URL: databaseUrl } });
}

describe("B1 Completed-Summer PostgreSQL operator", () => {
  it("selects active and archived Summers, emits identical reports, sanitizes snapshots, and changes no rows", async () => {
    const before = await selectedDatabaseEvidence();
    const first = runOperator();
    const second = runOperator();
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(second.stdout).toBe(first.stdout);
    const output = JSON.parse(first.stdout) as {
      selectionSummary: { selectedLeagueIds: number[]; activeSelectedLeagueCount: number; archivedSelectedLeagueCount: number };
      reportFingerprint: string;
      leagues: Array<{
        identity: { leagueId: number };
        paymentEvidence: {
          confidence: string;
          legacyPayments: Array<{ operationLinkProof: string | null }>;
          operations: Array<{
            snapshotLocationProof: string;
            snapshotWeekOfRaw: string | null;
          }>;
        };
        summary: { matchCount: number };
      }>;
    };
    expect(output.selectionSummary).toMatchObject({
      selectedLeagueIds: [activeLeagueId, archivedLeagueId],
      activeSelectedLeagueCount: 1,
      archivedSelectedLeagueCount: 1,
    });
    expect(output.reportFingerprint).toMatch(/^[0-9a-f]{64}$/);
    const activeLeague = output.leagues.find((league) => league.identity.leagueId === activeLeagueId);
    expect(activeLeague?.paymentEvidence.confidence).toBe("mixed");
    expect(activeLeague?.paymentEvidence.legacyPayments[0]?.operationLinkProof).toBe("tenant_and_immutable_tuple");
    expect(activeLeague?.paymentEvidence.operations[0]).toMatchObject({
      snapshotLocationProof: "tenant_location",
      snapshotWeekOfRaw: "2025-06-01T19:00:00.000000",
    });
    expect(activeLeague?.summary.matchCount).toBe(0);
    expect(first.stdout).not.toContain("ENCRYPTED_SOURCE_MUST_NOT_LEAK");
    expect(first.stdout).not.toContain("ENCRYPTED_CUSTOMER_MUST_NOT_LEAK");
    expect(first.stdout).not.toContain("ENCRYPTED_EMAIL_MUST_NOT_LEAK");
    expect(first.stdout).not.toContain("PROVIDER_LOCATION_MUST_NOT_LEAK");
    expect(await selectedDatabaseEvidence()).toEqual(before);
    const activeClients = await db.execute(sql`
      SELECT count(*)::integer AS count
      FROM pg_stat_activity
      WHERE application_name = 'leaguevault-completed-summer-b1-readonly'
    `);
    expect(activeClients.rows).toEqual([{ count: 0 }]);
  });

  it("accepts score activity only after proving bowler ownership and the score team league", async () => {
    const [selectedGame] = await db.select({ id: games.id }).from(games)
      .where(eq(games.leagueId, activeLeagueId)).orderBy(asc(games.id)).limit(1);
    const [ownTeam] = await db.insert(teams).values({
      name: "B1 own score team",
      number: 901,
      leagueId: activeLeagueId,
    }).returning({ id: teams.id });
    const [foreignTeam] = await db.insert(teams).values({
      name: "B1 foreign score team",
      number: 901,
      leagueId: foreignLeagueId,
    }).returning({ id: teams.id });
    const [foreignBowler] = await db.insert(bowlers).values({
      name: "B1 foreign score bowler",
      organizationId: foreignOrganizationId,
    }).returning({ id: bowlers.id });
    if (!selectedGame || !ownTeam || !foreignTeam || !foreignBowler) throw new Error("score ownership fixture is incomplete");
    const insertedScores = await db.insert(scores).values([{
      gameId: selectedGame.id,
      bowlerId: foreignBowler.id,
      teamId: ownTeam.id,
      score: 100,
      handicap: 0,
      average: 100,
      position: 1,
      laneNumber: 1,
    }, {
      gameId: selectedGame.id,
      bowlerId: paymentBowlerId,
      teamId: foreignTeam.id,
      score: 101,
      handicap: 0,
      average: 101,
      position: 2,
      laneNumber: 2,
    }]).returning({ id: scores.id });
    try {
      const run = runOperator([`--leagueId=${activeLeagueId}`]);
      expect(run.status).toBe(1);
      const output = JSON.parse(run.stdout) as {
        fatalErrors: Array<{ code: string }>;
        leagues: Array<{ scoreActivityEvidence: { scoreCount: number; scoreIds: number[] } }>;
      };
      expect(output.fatalErrors.map((error) => error.code)).toContain("invalid_or_cross_tenant_evidence");
      expect(output.leagues[0]?.scoreActivityEvidence).toEqual({ scoreCount: 0, scoredGameCount: 0, scoreIds: [] });
    } finally {
      await db.delete(scores).where(inArray(scores.id, insertedScores.map((score) => score.id)));
      await db.delete(teams).where(inArray(teams.id, [ownTeam.id, foreignTeam.id]));
      await db.delete(bowlers).where(eq(bowlers.id, foreignBowler.id));
    }
  });

  it("counts a snapshot attached to the wrong operation type as invalid evidence", async () => {
    const [wrongTypeOperation] = await db.insert(paymentOperations).values({
      organizationId,
      operationType: "refund",
      targetKey: `b1-wrong-type-${suffix}`,
      amountMinor: 2_100,
      currency: "USD",
      requestFingerprint: `lvpayreq:v1:${"e".repeat(64)}`,
      providerIdempotencyKey: `b1-wrong-type-${suffix}`.slice(0, 45),
      providerName: "square",
    }).returning({ id: paymentOperations.id });
    if (!wrongTypeOperation) throw new Error("wrong-type operation fixture was not created");
    try {
      await db.transaction(async (tx) => {
        await tx.insert(interactivePaymentOperationSnapshots).values({
          operationId: wrongTypeOperation.id,
          snapshotVersion: 2,
          snapshotFingerprint: `lvpayexecic:v2:${"f".repeat(64)}`,
          leagueId: activeLeagueId,
          locationId: ownLocationId,
          payerBowlerId: paymentBowlerId,
          requestKind: "direct",
          encryptedSourceId: "WRONG_TYPE_ENCRYPTED_SOURCE_MUST_NOT_LEAK",
          storeCard: false,
          sourceKind: "new_card",
          weekOf: "2025-06-01T19:00:00.000Z",
        });
        await tx.insert(interactivePaymentOperationAllocations).values({
          operationId: wrongTypeOperation.id,
          allocationIndex: 0,
          bowlerId: paymentBowlerId,
          amountMinor: 2_100,
          weekOf: "2025-06-01T19:00:00.000Z",
        });
      });
      const run = runOperator([`--leagueId=${activeLeagueId}`]);
      expect(run.status).toBe(1);
      const output = JSON.parse(run.stdout) as { fatalErrors: Array<{ code: string }> };
      expect(output.fatalErrors.map((error) => error.code)).toContain("invalid_or_cross_tenant_evidence");
      expect(run.stdout).not.toContain(wrongTypeOperation.id);
      expect(run.stdout).not.toContain("WRONG_TYPE_ENCRYPTED_SOURCE_MUST_NOT_LEAK");
    } finally {
      await db.delete(paymentOperations).where(eq(paymentOperations.id, wrongTypeOperation.id));
    }
  });

  it("counts an interactive snapshot/allocation week contradiction as invalid evidence", async () => {
    await db.update(interactivePaymentOperationSnapshots)
      .set({ weekOf: "2025-06-02T19:00:00.000Z" })
      .where(eq(interactivePaymentOperationSnapshots.operationId, operationId));
    try {
      const run = runOperator([`--leagueId=${activeLeagueId}`]);
      expect(run.status).toBe(1);
      const output = JSON.parse(run.stdout) as { fatalErrors: Array<{ code: string }> };
      expect(output.fatalErrors.map((error) => error.code)).toContain("invalid_or_cross_tenant_evidence");
      expect(run.stdout).not.toContain(operationId);
    } finally {
      await db.update(interactivePaymentOperationSnapshots)
        .set({ weekOf: "2025-06-01T19:00:00.000Z" })
        .where(eq(interactivePaymentOperationSnapshots.operationId, operationId));
    }
  });

  it("reports an explicit organization/league-only proof when a snapshot location is null", async () => {
    await db.update(interactivePaymentOperationSnapshots)
      .set({ locationId: null })
      .where(eq(interactivePaymentOperationSnapshots.operationId, operationId));
    try {
      const run = runOperator([`--leagueId=${activeLeagueId}`]);
      expect(run.status).toBe(0);
      const output = JSON.parse(run.stdout) as {
        leagues: Array<{
          paymentEvidence: {
            operations: Array<{
              snapshotLocationProof: string;
              snapshotWeekOfRaw: string | null;
            }>;
          };
        }>;
      };
      expect(output.leagues[0]?.paymentEvidence.operations[0]).toMatchObject({
        snapshotLocationProof: "organization_league_only",
        snapshotWeekOfRaw: "2025-06-01T19:00:00.000000",
      });
    } finally {
      await db.update(interactivePaymentOperationSnapshots)
        .set({ locationId: ownLocationId })
        .where(eq(interactivePaymentOperationSnapshots.operationId, operationId));
    }
  });

  it("proves payment allocation links by tenant ownership and exact immutable tuple agreement", async () => {
    await db.update(payments).set({ amount: 2_001 }).where(eq(payments.id, linkedPaymentId));
    try {
      const mismatch = runOperator([`--leagueId=${activeLeagueId}`]);
      expect(mismatch.status).toBe(1);
      const output = JSON.parse(mismatch.stdout) as {
        fatalErrors: Array<{ code: string }>;
        leagues: Array<{ paymentEvidence: { legacyPayments: Array<{ operationId: string | null; operationLinkProof: string | null }> } }>;
      };
      expect(output.fatalErrors.map((error) => error.code)).toContain("invalid_or_cross_tenant_evidence");
      expect(output.leagues[0]?.paymentEvidence.legacyPayments[0]).toMatchObject({
        operationId: null,
        operationLinkProof: null,
      });
    } finally {
      await db.update(payments).set({ amount: 2_000 }).where(eq(payments.id, linkedPaymentId));
    }

    const [foreignBowler] = await db.insert(bowlers).values({
      name: "B1 foreign linked-payment bowler",
      organizationId: foreignOrganizationId,
    }).returning({ id: bowlers.id });
    if (!foreignBowler) throw new Error("foreign linked-payment bowler was not created");
    await db.update(interactivePaymentOperationAllocations).set({ bowlerId: foreignBowler.id })
      .where(eq(interactivePaymentOperationAllocations.operationId, operationId));
    try {
      const crossTenantAllocation = runOperator([`--leagueId=${activeLeagueId}`]);
      expect(crossTenantAllocation.status).toBe(1);
      expect((JSON.parse(crossTenantAllocation.stdout) as { fatalErrors: Array<{ code: string }> })
        .fatalErrors.map((error) => error.code)).toContain("invalid_or_cross_tenant_evidence");
      expect(crossTenantAllocation.stdout).not.toContain(operationId);
    } finally {
      await db.update(interactivePaymentOperationAllocations).set({ bowlerId: paymentBowlerId })
        .where(eq(interactivePaymentOperationAllocations.operationId, operationId));
    }
    await db.update(payments).set({ bowlerId: foreignBowler.id }).where(eq(payments.id, linkedPaymentId));
    try {
      const crossTenant = runOperator([`--leagueId=${activeLeagueId}`]);
      expect(crossTenant.status).toBe(1);
      const output = JSON.parse(crossTenant.stdout) as {
        fatalErrors: Array<{ code: string }>;
        leagues: Array<{ paymentEvidence: { legacyPayments: unknown[] } }>;
      };
      expect(output.fatalErrors.map((error) => error.code)).toContain("invalid_or_cross_tenant_evidence");
      expect(output.leagues[0]?.paymentEvidence.legacyPayments).toEqual([]);
    } finally {
      await db.update(payments).set({ bowlerId: paymentBowlerId }).where(eq(payments.id, linkedPaymentId));
      await db.delete(bowlers).where(eq(bowlers.id, foreignBowler.id));
    }
  });

  it("fails an explicit foreign league closed without exposing foreign row details", () => {
    const run = runOperator([`--leagueId=${foreignLeagueId}`]);
    expect(run.status).toBe(1);
    const output = JSON.parse(run.stdout) as { fatalErrors: Array<{ code: string }>; leagues: unknown[] };
    expect(output.fatalErrors.map((error) => error.code)).toContain("tenant_resource_not_found");
    expect(output.leagues).toEqual([]);
    expect(run.stdout).not.toContain("B1 Foreign Secret League");
  });

  it("fails explicit ineligible and org-less leagues without selecting substitutes", () => {
    const ineligible = runOperator([`--leagueId=${excludedLeagueId}`]);
    expect(ineligible.status).toBe(1);
    expect(JSON.parse(ineligible.stdout)).toMatchObject({
      selectionSummary: { selectedLeagueIds: [] },
      fatalErrors: [expect.objectContaining({ code: "explicit_league_ineligible" })],
    });
    const orgLess = runOperator([`--leagueId=${orgLessLeagueId}`]);
    expect(orgLess.status).toBe(1);
    expect(JSON.parse(orgLess.stdout)).toMatchObject({
      selectionSummary: { selectedLeagueIds: [] },
      fatalErrors: [expect.objectContaining({ code: "tenant_resource_not_found" })],
    });
  });

  it("fails a cross-tenant location closed without exposing the foreign location", async () => {
    const [foreignLocation] = await db.select({ id: locations.id }).from(locations)
      .where(eq(locations.organizationId, foreignOrganizationId)).orderBy(asc(locations.id)).limit(1);
    if (!foreignLocation) throw new Error("foreign location fixture is missing");
    const leagueId = await createLeague({
      organizationId,
      locationId: foreignLocation.id,
      name: "B1 contradictory location",
      seasonStart: "2025-06-01T00:00:00.000Z",
      seasonEnd: "2025-06-01T00:00:00.000Z",
      totalBowlingWeeks: 1,
    });
    try {
      const run = runOperator([`--leagueId=${leagueId}`]);
      expect(run.status).toBe(1);
      const output = JSON.parse(run.stdout) as { fatalErrors: Array<{ code: string }> };
      expect(output.fatalErrors.map((error) => error.code)).toEqual(expect.arrayContaining([
        "explicit_league_ineligible",
        "invalid_or_cross_tenant_location",
      ]));
      expect(run.stdout).not.toContain("B1 foreign location");
    } finally {
      await db.delete(leagues).where(eq(leagues.id, leagueId));
    }
  });

  it("suppresses and fails closed on cross-tenant payment-operation evidence", async () => {
    const [foreignLocation] = await db.select({ id: locations.id }).from(locations)
      .where(eq(locations.organizationId, foreignOrganizationId)).orderBy(asc(locations.id)).limit(1);
    const [foreignBowler] = await db.insert(bowlers).values({
      name: "B1 foreign evidence bowler",
      organizationId: foreignOrganizationId,
    }).returning({ id: bowlers.id });
    if (!foreignLocation || !foreignBowler) throw new Error("foreign evidence fixture is incomplete");
    const [foreignOperation] = await db.insert(paymentOperations).values({
      organizationId: foreignOrganizationId,
      operationType: "interactive_charge",
      targetKey: `b1-cross-evidence-${suffix}`,
      amountMinor: 3_000,
      currency: "USD",
      requestFingerprint: `lvpayreq:v1:${"c".repeat(64)}`,
      providerIdempotencyKey: `b1-cross-${suffix}`.slice(0, 45),
      providerName: "square",
    }).returning({ id: paymentOperations.id });
    if (!foreignOperation) throw new Error("foreign operation fixture was not created");
    try {
      await db.transaction(async (tx) => {
        await tx.insert(interactivePaymentOperationSnapshots).values({
          operationId: foreignOperation.id,
          snapshotVersion: 2,
          snapshotFingerprint: `lvpayexecic:v2:${"d".repeat(64)}`,
          leagueId: activeLeagueId,
          locationId: foreignLocation.id,
          providerLocationId: "FOREIGN_PROVIDER_LOCATION_MUST_NOT_LEAK",
          payerBowlerId: foreignBowler.id,
          requestKind: "direct",
          encryptedSourceId: "FOREIGN_ENCRYPTED_SOURCE_MUST_NOT_LEAK",
          storeCard: false,
          sourceKind: "new_card",
          weekOf: "2025-06-01T19:00:00.000Z",
        });
        await tx.insert(interactivePaymentOperationAllocations).values({
          operationId: foreignOperation.id,
          allocationIndex: 0,
          bowlerId: foreignBowler.id,
          amountMinor: 3_000,
          weekOf: "2025-06-01T19:00:00.000Z",
        });
      });
      const run = runOperator([`--leagueId=${activeLeagueId}`]);
      expect(run.status).toBe(1);
      const output = JSON.parse(run.stdout) as { fatalErrors: Array<{ code: string }> };
      expect(output.fatalErrors.map((error) => error.code)).toContain("invalid_or_cross_tenant_evidence");
      expect(run.stdout).not.toContain(foreignOperation.id);
      expect(run.stdout).not.toContain("FOREIGN_PROVIDER_LOCATION_MUST_NOT_LEAK");
      expect(run.stdout).not.toContain("FOREIGN_ENCRYPTED_SOURCE_MUST_NOT_LEAK");
    } finally {
      await db.delete(interactivePaymentOperationAllocations).where(eq(interactivePaymentOperationAllocations.operationId, foreignOperation.id));
      await db.delete(interactivePaymentOperationSnapshots).where(eq(interactivePaymentOperationSnapshots.operationId, foreignOperation.id));
      await db.delete(paymentOperations).where(eq(paymentOperations.id, foreignOperation.id));
      await db.delete(bowlers).where(eq(bowlers.id, foreignBowler.id));
    }
  });

  it("proves PostgreSQL rejects writes under the exact operator transaction mode", async () => {
    let caught: unknown;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
        await tx.insert(leagues).values({
          name: "must not write",
          organizationId,
          seasonStart: "2025-06-01",
          seasonEnd: "2025-06-08",
          weekDay: "Sunday",
        });
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    if (caught === null || typeof caught !== "object" || !("cause" in caught)) {
      throw new Error("read-only rejection did not retain its PostgreSQL cause");
    }
    const cause = caught.cause;
    expect(cause).toBeTypeOf("object");
    if (cause === null || typeof cause !== "object" || !("code" in cause)) {
      throw new Error("read-only rejection did not retain its PostgreSQL code");
    }
    expect(cause.code).toBe("25006");
  });
});
