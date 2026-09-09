import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  bowlerLeagues,
  bowlers,
  leagueOccurrences,
  leagues,
  locations,
  organizations,
  occurrencePaymentResponsibilities,
  paymentObligations,
  paymentOperationRosterSnapshotItems,
  paymentOperationRosterSnapshots,
  paymentOperations,
  teamPaymentSlots,
  teams,
  users,
} from "@shared/schema";
import { LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION } from "@shared/league-setup-integration";
import { createLeagueWithCanonicalSetup } from "../../server/services/league-setup-integration";
import { editCanonicalLeagueSchedule } from "../../server/services/canonical-league-schedule-edit";
import { materializeRosterPaymentOccurrenceInTransaction } from "../../server/services/roster-payment-materializer";
import { canonicalRosterFingerprint, saveTeamRoster } from "../../server/services/roster-payment-core";
import { deleteOrganization } from "../../server/storage/organizations";
import { pool as appPool } from "../../server/db";
import { getTestDb } from "../setup/test-db";

const db = getTestDb();
const suffix = `${process.env.VITEST_POOL_ID ?? "0"}-${randomUUID()}`;
let organizationId: number;
let actorUserId: number;
let leagueId: number;
let performancePayerBowlerId: number;
let performanceTeamId: number;
let performanceSlotBowlerIds: number[];

function trackPoolQueries(pool: Pool): () => number {
  let queryCount = 0;
  const originals = new Map<PoolClient, PoolClient["query"]>();
  const onAcquire = (client: PoolClient): void => {
    if (originals.has(client)) return;
    const originalQuery = client.query.bind(client);
    originals.set(client, client.query);
    client.query = ((...args: Parameters<PoolClient["query"]>) => {
      queryCount += 1;
      return originalQuery(...args);
    }) as PoolClient["query"];
  };
  pool.on("acquire", onAcquire);
  return () => {
    pool.off("acquire", onAcquire);
    for (const [client, originalQuery] of originals) client.query = originalQuery;
    originals.clear();
    return queryCount;
  };
}

beforeAll(async () => {
  const [organization] = await db.insert(organizations).values({
    name: `Schedule performance ${suffix}`,
    slug: `schedule-performance-${suffix}`,
  }).returning({ id: organizations.id });
  if (!organization) throw new Error("performance organization fixture was not created");
  organizationId = organization.id;
  const [actor] = await db.insert(users).values({
    email: `schedule-performance-${suffix}@example.test`,
    password: "schedule-performance-test-password-hash",
    name: "Schedule performance actor",
    role: "org_admin",
    organizationId,
  }).returning({ id: users.id });
  if (!actor) throw new Error("performance actor fixture was not created");
  actorUserId = actor.id;
  const [location] = await db.insert(locations).values({
    name: `Schedule performance location ${suffix}`,
    organizationId,
  }).returning({ id: locations.id });
  if (!location) throw new Error("performance location fixture was not created");

  const created = await createLeagueWithCanonicalSetup({
    scope: { organizationId, actorUserId },
    league: {
      name: "Canonical schedule performance fixture",
      description: "30 occurrence 32 position database fixture",
      organizationId,
      locationId: location.id,
      active: true,
      allowPublicSignup: false,
      seasonStart: "2036-01-06",
      seasonEnd: "2036-07-27",
      weekDay: "Sunday",
      totalBowlingWeeks: 30,
      skipDates: [],
      cancelledDates: [],
      doublePayDates: [],
      competitionStartTime: "19:00",
      timezone: "America/New_York",
      weeklyFee: 2_000,
      paymentMode: "weekly",
      payingLineupSize: 4,
      seasonNumber: 1,
    },
    setup: {
      contractVersion: LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION,
      idempotencyKey: randomUUID(),
    },
  });
  leagueId = created.id;

  const createdTeams = await db.insert(teams).values(Array.from({ length: 8 }, (_, index) => ({
    name: `Performance team ${index + 1}`,
    number: index + 1,
    leagueId,
  }))).returning({ id: teams.id, number: teams.number });
  const createdBowlers = await db.insert(bowlers).values(Array.from({ length: 32 }, (_, index) => ({
    name: `Performance bowler ${index + 1}`,
    organizationId,
  }))).returning({ id: bowlers.id });
  if (createdTeams.length !== 8 || createdBowlers.length !== 32) throw new Error("performance roster fixture was not created");
  const firstBowler = createdBowlers[0];
  if (!firstBowler) throw new Error("performance payer fixture was not created");
  performancePayerBowlerId = firstBowler.id;
  const firstTeam = createdTeams[0];
  if (!firstTeam) throw new Error("performance team fixture was not created");
  performanceTeamId = firstTeam.id;
  performanceSlotBowlerIds = createdBowlers.slice(0, 4).map((bowler) => bowler.id);
  const memberships = createdBowlers.map((bowler, index) => ({
    bowlerId: bowler.id,
    leagueId,
    teamId: (() => {
      const team = createdTeams[Math.floor(index / 4)];
      if (!team) throw new Error("performance membership team fixture is missing");
      return team.id;
    })(),
    active: true,
    order: index % 4,
  }));
  await db.insert(bowlerLeagues).values(memberships);
  await db.insert(teamPaymentSlots).values(createdTeams.flatMap((team, teamIndex) =>
    Array.from({ length: 4 }, (_, slotIndex) => {
      const bowler = createdBowlers[teamIndex * 4 + slotIndex];
      if (!bowler) throw new Error("performance slot bowler fixture is missing");
      return {
        organizationId,
        leagueId,
        teamId: team.id,
        slotIndex,
        lineupSize: 4,
        occupant: "main" as const,
        mainBowlerId: bowler.id,
        recordedByUserId: actorUserId,
      };
    }),
  ));
  const occurrences = await db.select({ id: leagueOccurrences.id }).from(leagueOccurrences)
    .where(and(eq(leagueOccurrences.organizationId, organizationId), eq(leagueOccurrences.leagueId, leagueId)))
    .orderBy(asc(leagueOccurrences.plannedOrdinal));
  if (occurrences.length !== 30) throw new Error(`expected 30 performance occurrences, got ${occurrences.length}`);
  await db.transaction(async (tx) => {
    for (const occurrence of occurrences) {
      await materializeRosterPaymentOccurrenceInTransaction(tx, { organizationId, leagueId, occurrenceId: occurrence.id, actorUserId });
    }
  });
});

afterAll(async () => {
  if (organizationId) await deleteOrganization(organizationId);
});

describe("canonical schedule edit batching (PostgreSQL)", () => {
  it("batches the full 30-occurrence/32-position save while conserving roster evidence", async () => {
    const [league] = await db.select({ canonicalScheduleRevision: leagues.canonicalScheduleRevision }).from(leagues).where(eq(leagues.id, leagueId));
    if (!league) throw new Error("performance league fixture is missing");
    const beforeResponsibilities = await db.select({
      key: occurrencePaymentResponsibilities.responsibilityKey,
      payer: occurrencePaymentResponsibilities.payerBowlerId,
      amount: occurrencePaymentResponsibilities.amountMinor,
      kind: occurrencePaymentResponsibilities.responsibilityKind,
      policy: occurrencePaymentResponsibilities.policy,
      version: occurrencePaymentResponsibilities.version,
    }).from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, leagueId),
      eq(occurrencePaymentResponsibilities.state, "active"),
    )).orderBy(asc(occurrencePaymentResponsibilities.responsibilityKey));
    const beforeObligations = await db.select({
      key: occurrencePaymentResponsibilities.responsibilityKey,
      payer: paymentObligations.payerBowlerId,
      amount: paymentObligations.amountMinor,
      component: paymentObligations.component,
      state: paymentObligations.state,
      dueAt: paymentObligations.dueAt,
      pastDueAt: paymentObligations.pastDueAt,
    }).from(paymentObligations).innerJoin(occurrencePaymentResponsibilities, eq(
      occurrencePaymentResponsibilities.id,
      paymentObligations.responsibilityId,
    )).where(and(
      eq(paymentObligations.organizationId, organizationId),
      eq(paymentObligations.leagueId, leagueId),
      eq(paymentObligations.state, "open"),
    )).orderBy(asc(paymentObligations.id));
    expect(beforeResponsibilities).toHaveLength(960);
    expect(beforeObligations).toHaveLength(960);

    const stopTracking = trackPoolQueries(appPool);
    let applied: Awaited<ReturnType<typeof editCanonicalLeagueSchedule>>;
    let queryCount = 0;
    try {
      applied = await editCanonicalLeagueSchedule({
        organizationId,
        leagueId,
        actorUserId,
        expectedScheduleRevision: league.canonicalScheduleRevision,
        idempotencyKey: `performance-edit-${suffix}`,
        reason: "Measure batched canonical roster materialization",
        doublePayDates: [],
        competitionStartTime: "20:00",
      });
    } finally {
      queryCount = stopTracking();
    }
    console.info(`[schedule-perf] canonical 30x32 save queries=${queryCount}`);
    expect(queryCount).toBeGreaterThan(0);
    expect(applied.mode).toBe("applied");
    expect(queryCount).toBeLessThan(500);

    const afterResponsibilities = await db.select({
      key: occurrencePaymentResponsibilities.responsibilityKey,
      payer: occurrencePaymentResponsibilities.payerBowlerId,
      amount: occurrencePaymentResponsibilities.amountMinor,
      kind: occurrencePaymentResponsibilities.responsibilityKind,
      policy: occurrencePaymentResponsibilities.policy,
      version: occurrencePaymentResponsibilities.version,
      state: occurrencePaymentResponsibilities.state,
    }).from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, leagueId),
    )).orderBy(asc(occurrencePaymentResponsibilities.responsibilityKey), asc(occurrencePaymentResponsibilities.version));
    const afterActiveResponsibilities = afterResponsibilities.filter((row) => row.state === "active");
    expect(afterActiveResponsibilities).toHaveLength(960);
    expect(afterResponsibilities.filter((row) => row.state === "voided")).toHaveLength(960);
    expect(afterActiveResponsibilities.every((row) => row.version === 2)).toBe(true);
    expect(afterActiveResponsibilities.map(({ state: _state, version: _version, ...row }) => row)).toEqual(beforeResponsibilities.map(({ version: _version, ...row }) => row));

    const afterObligations = await db.select({ key: occurrencePaymentResponsibilities.responsibilityKey, payer: paymentObligations.payerBowlerId, amount: paymentObligations.amountMinor, component: paymentObligations.component, dueAt: paymentObligations.dueAt, pastDueAt: paymentObligations.pastDueAt, occurrenceId: paymentObligations.occurrenceId, state: paymentObligations.state })
      .from(paymentObligations).innerJoin(occurrencePaymentResponsibilities, eq(occurrencePaymentResponsibilities.id, paymentObligations.responsibilityId)).where(and(eq(paymentObligations.organizationId, organizationId), eq(paymentObligations.leagueId, leagueId)));
    expect(afterObligations.filter((row) => row.state === "open")).toHaveLength(960);
    expect(afterObligations.filter((row) => row.state === "voided")).toHaveLength(960);
    const openAfterObligations = afterObligations.filter((row) => row.state === "open");
    expect(openAfterObligations.map(({ state: _state, occurrenceId: _occurrenceId, dueAt: _dueAt, pastDueAt: _pastDueAt, ...row }) => row).sort((a, b) => a.payer - b.payer || a.amount - b.amount || a.key.localeCompare(b.key))).toEqual(beforeObligations.map(({ state: _state, dueAt: _dueAt, pastDueAt: _pastDueAt, ...row }) => row).sort((a, b) => a.payer - b.payer || a.amount - b.amount || a.key.localeCompare(b.key)));
    const beforeTiming = new Map(beforeObligations.map((row) => [`${row.key}:${row.component}`, row.dueAt]));
    expect(openAfterObligations.every((row) => beforeTiming.get(`${row.key}:${row.component}`) !== row.dueAt)).toBe(true);
    expect(openAfterObligations.every((row) => new Date(row.pastDueAt).getTime() - new Date(row.dueAt).getTime() === 3 * 60 * 60 * 1000)).toBe(true);
    const occurrenceStarts = new Map((await db.select({ id: leagueOccurrences.id, startAt: leagueOccurrences.startAt }).from(leagueOccurrences).where(and(eq(leagueOccurrences.organizationId, organizationId), eq(leagueOccurrences.leagueId, leagueId)))).map((row) => [row.id, row.startAt]));
    expect(openAfterObligations.every((row) => Date.parse(row.dueAt) === Date.parse(occurrenceStarts.get(row.occurrenceId) ?? ""))).toBe(true);

    const retry = await editCanonicalLeagueSchedule({
      organizationId,
      leagueId,
      actorUserId,
      expectedScheduleRevision: league.canonicalScheduleRevision,
      idempotencyKey: `performance-edit-${suffix}`,
      reason: "Measure batched canonical roster materialization",
      doublePayDates: [],
      competitionStartTime: "20:00",
    });
    expect(retry).toMatchObject({ mode: "idempotent_retry", writesPerformed: false, scheduleRevision: applied.scheduleRevision });
  });

  it("measures a synthetic full-season no-op roster save", async () => {
    const request = {
      commandKey: `performance-roster-no-op-${suffix}`,
      requestFingerprint: "",
      lineupSize: 4 as const,
      slots: performanceSlotBowlerIds.map((mainBowlerId, slotIndex) => ({ slotIndex, occupant: "main" as const, mainBowlerId })),
    };
    request.requestFingerprint = canonicalRosterFingerprint(request);
    const beforeResponsibilities = await db.select({ id: occurrencePaymentResponsibilities.id, version: occurrencePaymentResponsibilities.version, state: occurrencePaymentResponsibilities.state }).from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, leagueId),
      eq(occurrencePaymentResponsibilities.teamId, performanceTeamId),
      eq(occurrencePaymentResponsibilities.state, "active"),
    )).orderBy(asc(occurrencePaymentResponsibilities.id));
    const beforeObligations = await db.select({ id: paymentObligations.id, responsibilityId: paymentObligations.responsibilityId, state: paymentObligations.state }).from(paymentObligations).innerJoin(occurrencePaymentResponsibilities, eq(
      occurrencePaymentResponsibilities.id,
      paymentObligations.responsibilityId,
    )).where(and(
      eq(paymentObligations.organizationId, organizationId),
      eq(paymentObligations.leagueId, leagueId),
      eq(occurrencePaymentResponsibilities.teamId, performanceTeamId),
      eq(paymentObligations.state, "open"),
    )).orderBy(asc(paymentObligations.id));
    const stopTracking = trackPoolQueries(appPool);
    const startedAt = performance.now();
    let queryCount = 0;
    try {
      await saveTeamRoster({ organizationId, leagueId, teamId: performanceTeamId, actorUserId, request });
      const repeatedRequest = { ...request, commandKey: `${request.commandKey}-repeat`, requestFingerprint: "" };
      repeatedRequest.requestFingerprint = canonicalRosterFingerprint(repeatedRequest);
      await saveTeamRoster({ organizationId, leagueId, teamId: performanceTeamId, actorUserId, request: repeatedRequest });
    } finally {
      queryCount = stopTracking();
    }
    const elapsedMs = performance.now() - startedAt;
    console.info(`[roster-perf] synthetic no-op 30-occurrence/4-slot saves=2 queries=${queryCount} elapsed_ms=${elapsedMs.toFixed(1)}`);
    expect(queryCount).toBeLessThan(100);
    const afterResponsibilities = await db.select({ id: occurrencePaymentResponsibilities.id, version: occurrencePaymentResponsibilities.version, state: occurrencePaymentResponsibilities.state }).from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, leagueId),
      eq(occurrencePaymentResponsibilities.teamId, performanceTeamId),
      eq(occurrencePaymentResponsibilities.state, "active"),
    )).orderBy(asc(occurrencePaymentResponsibilities.id));
    const afterObligations = await db.select({ id: paymentObligations.id, responsibilityId: paymentObligations.responsibilityId, state: paymentObligations.state }).from(paymentObligations).innerJoin(occurrencePaymentResponsibilities, eq(
      occurrencePaymentResponsibilities.id,
      paymentObligations.responsibilityId,
    )).where(and(
      eq(paymentObligations.organizationId, organizationId),
      eq(paymentObligations.leagueId, leagueId),
      eq(occurrencePaymentResponsibilities.teamId, performanceTeamId),
      eq(paymentObligations.state, "open"),
    )).orderBy(asc(paymentObligations.id));
    expect(afterResponsibilities).toEqual(beforeResponsibilities);
    expect(afterObligations).toEqual(beforeObligations);
  });

  it("rolls back every occurrence when one reserved roster item blocks the batch", async () => {
    const [league] = await db.select({ canonicalScheduleRevision: leagues.canonicalScheduleRevision }).from(leagues).where(eq(leagues.id, leagueId));
    if (!league) throw new Error("performance league fixture is missing");
    const [target] = await db.select({ id: leagueOccurrences.id, revision: leagueOccurrences.currentRevision, startAt: leagueOccurrences.startAt })
      .from(leagueOccurrences).where(and(eq(leagueOccurrences.organizationId, organizationId), eq(leagueOccurrences.leagueId, leagueId))).orderBy(asc(leagueOccurrences.plannedOrdinal)).limit(1);
    if (!target) throw new Error("performance target occurrence is missing");
    const [obligation] = await db.select({ id: paymentObligations.id }).from(paymentObligations)
      .where(and(eq(paymentObligations.organizationId, organizationId), eq(paymentObligations.leagueId, leagueId), eq(paymentObligations.occurrenceId, target.id), eq(paymentObligations.state, "open"))).limit(1);
    if (!obligation) throw new Error("performance target obligation is missing");
    const operationId = randomUUID();
    await db.insert(paymentOperations).values({
      id: operationId,
      organizationId,
      leagueId,
      authorizingUserId: actorUserId,
      operationType: "interactive_charge",
      targetKey: `performance-reserved-${suffix}`,
      amountMinor: 2_000,
      currency: "USD",
      requestFingerprint: `lvpayreq:v1:${"a".repeat(64)}`,
      providerIdempotencyKey: `performance-reserved-${suffix}`.slice(0, 45),
      providerName: "square",
      status: "failed_terminal",
      nextAttemptAt: null,
      completedAt: "2036-01-01T00:00:00.000Z",
      errorClassification: "internal",
      errorCode: "FIXTURE_FAILURE",
    });
    await db.transaction(async (tx) => {
      await tx.insert(paymentOperationRosterSnapshots).values({
        operationId,
        organizationId,
        leagueId,
        snapshotKind: "interactive",
        requestKind: "direct",
        payerBowlerId: performancePayerBowlerId,
        encryptedSourceId: "fixture-encrypted-source",
        encryptedCustomerId: "fixture-encrypted-customer",
        sourceKind: "saved_card",
        quoteFingerprint: `lvrosterquote:v1:${"c".repeat(64)}`,
        amountMinor: 2_000,
        currency: "USD",
        obligations: [{ obligationId: obligation.id, amountMinor: 2_000 }],
        snapshotFingerprint: `lvrosterexec:v1:${"b".repeat(64)}`,
      });
      await tx.insert(paymentOperationRosterSnapshotItems).values({
        operationId,
        organizationId,
        leagueId,
        obligationId: obligation.id,
        allocationIndex: 0,
        amountMinor: 2_000,
        state: "reserved",
      });
    });
    const beforeOccurrences = await db.select({ id: leagueOccurrences.id, revision: leagueOccurrences.currentRevision, startAt: leagueOccurrences.startAt })
      .from(leagueOccurrences).where(and(eq(leagueOccurrences.organizationId, organizationId), eq(leagueOccurrences.leagueId, leagueId))).orderBy(asc(leagueOccurrences.plannedOrdinal));
    const beforeActive = await db.select({ id: occurrencePaymentResponsibilities.id, version: occurrencePaymentResponsibilities.version, state: occurrencePaymentResponsibilities.state })
      .from(occurrencePaymentResponsibilities).where(and(eq(occurrencePaymentResponsibilities.organizationId, organizationId), eq(occurrencePaymentResponsibilities.leagueId, leagueId), eq(occurrencePaymentResponsibilities.state, "active")));
    await expect(editCanonicalLeagueSchedule({
      organizationId,
      leagueId,
      actorUserId,
      expectedScheduleRevision: league.canonicalScheduleRevision,
      idempotencyKey: `performance-reserved-edit-${suffix}`,
      reason: "Verify batch financial rollback",
      doublePayDates: [],
      competitionStartTime: "21:00",
    })).rejects.toMatchObject({ code: "financial_conflict" });
    expect(await db.select({ id: leagueOccurrences.id, revision: leagueOccurrences.currentRevision, startAt: leagueOccurrences.startAt }).from(leagueOccurrences).where(and(eq(leagueOccurrences.organizationId, organizationId), eq(leagueOccurrences.leagueId, leagueId))).orderBy(asc(leagueOccurrences.plannedOrdinal))).toEqual(beforeOccurrences);
    expect(await db.select({ id: occurrencePaymentResponsibilities.id, version: occurrencePaymentResponsibilities.version, state: occurrencePaymentResponsibilities.state }).from(occurrencePaymentResponsibilities).where(and(eq(occurrencePaymentResponsibilities.organizationId, organizationId), eq(occurrencePaymentResponsibilities.leagueId, leagueId), eq(occurrencePaymentResponsibilities.state, "active")))).toEqual(beforeActive);
  });

  it("leaves financial rows untouched for a metadata-only edit", async () => {
    const [league] = await db.select({ canonicalScheduleRevision: leagues.canonicalScheduleRevision }).from(leagues).where(eq(leagues.id, leagueId));
    if (!league) throw new Error("performance league fixture is missing");
    const before = await db.select({ id: occurrencePaymentResponsibilities.id, version: occurrencePaymentResponsibilities.version, dueAt: occurrencePaymentResponsibilities.dueAt, state: occurrencePaymentResponsibilities.state })
      .from(occurrencePaymentResponsibilities).where(and(eq(occurrencePaymentResponsibilities.organizationId, organizationId), eq(occurrencePaymentResponsibilities.leagueId, leagueId))).orderBy(asc(occurrencePaymentResponsibilities.id));
    const result = await editCanonicalLeagueSchedule({
      organizationId,
      leagueId,
      actorUserId,
      expectedScheduleRevision: league.canonicalScheduleRevision,
      idempotencyKey: `performance-metadata-${suffix}`,
      reason: "Verify metadata does not rematerialize roster evidence",
      doublePayDates: [],
      metadata: { description: "metadata-only performance edit" },
    });
    expect(result.mode).toBe("applied");
    expect(result.scheduleRevision).toBe(league.canonicalScheduleRevision);
    expect(await db.select({ id: occurrencePaymentResponsibilities.id, version: occurrencePaymentResponsibilities.version, dueAt: occurrencePaymentResponsibilities.dueAt, state: occurrencePaymentResponsibilities.state })
      .from(occurrencePaymentResponsibilities).where(and(eq(occurrencePaymentResponsibilities.organizationId, organizationId), eq(occurrencePaymentResponsibilities.leagueId, leagueId))).orderBy(asc(occurrencePaymentResponsibilities.id))).toEqual(before);
  });

});

describe("upfront materialization no-op (PostgreSQL)", () => {
  it("does not version an upfront responsibility when the due instant is unchanged", async () => {
    const [location] = await db.insert(locations).values({ name: `Upfront performance location ${suffix}`, organizationId }).returning({ id: locations.id });
    if (!location) throw new Error("upfront location fixture was not created");
    const created = await createLeagueWithCanonicalSetup({
      scope: { organizationId, actorUserId },
      league: {
        name: "Upfront performance fixture",
        description: "upfront no-op fixture",
        organizationId,
        locationId: location.id,
        active: true,
        allowPublicSignup: false,
        seasonStart: "2037-01-04",
        seasonEnd: "2037-01-04",
        weekDay: "Sunday",
        totalBowlingWeeks: 1,
        skipDates: [],
        cancelledDates: [],
        doublePayDates: [],
        competitionStartTime: "19:00",
        timezone: "America/New_York",
        weeklyFee: 2_000,
        paymentMode: "upfront",
        payingLineupSize: 3,
        seasonNumber: 2,
      },
      setup: { contractVersion: LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION, idempotencyKey: randomUUID() },
    });
    const [team] = await db.insert(teams).values({ name: `Upfront performance team ${suffix}`, number: 100, leagueId: created.id }).returning({ id: teams.id });
    const [bowler] = await db.insert(bowlers).values({ name: `Upfront performance bowler ${suffix}`, organizationId }).returning({ id: bowlers.id });
    if (!team || !bowler) throw new Error("upfront roster fixture was not created");
    await db.insert(bowlerLeagues).values({ bowlerId: bowler.id, leagueId: created.id, teamId: team.id, active: true, order: 0 });
    await db.insert(teamPaymentSlots).values({ organizationId, leagueId: created.id, teamId: team.id, slotIndex: 0, lineupSize: 3, occupant: "main", mainBowlerId: bowler.id, recordedByUserId: actorUserId });
    const [occurrence] = await db.select({ id: leagueOccurrences.id }).from(leagueOccurrences).where(eq(leagueOccurrences.leagueId, created.id));
    if (!occurrence) throw new Error("upfront occurrence fixture was not created");
    await db.transaction((tx) => materializeRosterPaymentOccurrenceInTransaction(tx, { organizationId, leagueId: created.id, occurrenceId: occurrence.id, actorUserId }));
    const before = await db.select({ id: occurrencePaymentResponsibilities.id, version: occurrencePaymentResponsibilities.version, dueAt: occurrencePaymentResponsibilities.dueAt })
      .from(occurrencePaymentResponsibilities).where(and(eq(occurrencePaymentResponsibilities.organizationId, organizationId), eq(occurrencePaymentResponsibilities.leagueId, created.id), eq(occurrencePaymentResponsibilities.state, "active")));
    const beforeObligation = await db.select({ id: paymentObligations.id, dueAt: paymentObligations.dueAt, state: paymentObligations.state })
      .from(paymentObligations).where(and(eq(paymentObligations.organizationId, organizationId), eq(paymentObligations.leagueId, created.id), eq(paymentObligations.state, "open")));
    await db.transaction((tx) => materializeRosterPaymentOccurrenceInTransaction(tx, { organizationId, leagueId: created.id, occurrenceId: occurrence.id, actorUserId, reschedule: true }));
    expect(await db.select({ id: occurrencePaymentResponsibilities.id, version: occurrencePaymentResponsibilities.version, dueAt: occurrencePaymentResponsibilities.dueAt })
      .from(occurrencePaymentResponsibilities).where(and(eq(occurrencePaymentResponsibilities.organizationId, organizationId), eq(occurrencePaymentResponsibilities.leagueId, created.id), eq(occurrencePaymentResponsibilities.state, "active")))).toEqual(before);
    expect(await db.select({ id: paymentObligations.id, dueAt: paymentObligations.dueAt, state: paymentObligations.state })
      .from(paymentObligations).where(and(eq(paymentObligations.organizationId, organizationId), eq(paymentObligations.leagueId, created.id), eq(paymentObligations.state, "open")))).toEqual(beforeObligation);
  });
});
