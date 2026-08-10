import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { spawnSync } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  games,
  bowlers,
  leagueOccurrenceBillingTermRevisions,
  leagueOccurrenceBillingTerms,
  leagueOccurrenceGenerationDiscrepancies,
  leagueOccurrenceGenerationRuns,
  leagueOccurrenceRelationships,
  leagueOccurrenceRevisions,
  leagueOccurrences,
  leagueScheduleCommands,
  leagueScheduleExceptionRevisions,
  leagueScheduleExceptions,
  leagues,
  locations,
  organizations,
  payments,
  scores,
  users,
} from "@shared/schema";
import {
  COMPLETED_SUMMER_MATERIALIZATION_CONTRACT_VERSION,
  CompletedSummerMaterializationError,
  validateCompletedSummerMaterializationArtifact,
  type CompletedSummerMaterializationApprovalInput,
  type CompletedSummerMaterializationPlan,
} from "@shared/completed-summer-materialization";
import { canonicalJsonStringify, type CompletedSummerComparisonReport } from "@shared/completed-summer-comparator";
import { loadCompletedSummerComparisonReport } from "../../scripts/compare-completed-summer-occurrences";
import {
  executeCompletedSummerMaterialization,
  type CompletedSummerMaterializationFailureStage,
} from "../../server/services/completed-summer-materialization";
import { deleteOrganization } from "../../server/storage/organizations";
import { getTestDb } from "../setup/test-db";

const db = getTestDb();
const organizationsToDelete: number[] = [];
const systemAdminsToDelete: number[] = [];
let sequence = 0;

interface Fixture {
  organizationId: number;
  actorUserId: number;
  regularUserId: number;
  systemAdminUserId: number;
  locationId: number;
  leagueId: number;
  gameIds: number[];
}

function databaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!value) throw new Error("B2 test database URL is missing");
  return value;
}

async function fixture(label: string): Promise<Fixture> {
  const unique = `${label}-${++sequence}-${Date.now()}`.toLowerCase();
  const [organization] = await db.insert(organizations).values({
    name: `B2 ${unique}`,
    slug: `b2-${unique}`,
  }).returning({ id: organizations.id });
  if (!organization) throw new Error("B2 organization was not created");
  organizationsToDelete.push(organization.id);
  const [actor] = await db.insert(users).values({
    email: `b2-${unique}@example.test`,
    password: "b2-test-password-hash",
    name: `B2 ${unique} actor`,
    role: "org_admin",
    organizationId: organization.id,
  }).returning({ id: users.id });
  const [regular] = await db.insert(users).values({
    email: `b2-${unique}-regular@example.test`,
    password: "b2-test-password-hash",
    name: `B2 ${unique} regular`,
    role: "user",
    organizationId: organization.id,
  }).returning({ id: users.id });
  const [systemAdmin] = await db.insert(users).values({
    email: `b2-${unique}-system@example.test`,
    password: "b2-test-password-hash",
    name: `B2 ${unique} system admin`,
    role: "system_admin",
    organizationId: null,
  }).returning({ id: users.id });
  if (!actor || !regular || !systemAdmin) throw new Error("B2 users were not created");
  systemAdminsToDelete.push(systemAdmin.id);
  const [location] = await db.insert(locations).values({
    name: `B2 ${unique} location`,
    organizationId: organization.id,
  }).returning({ id: locations.id });
  if (!location) throw new Error("B2 location was not created");
  const [league] = await db.insert(leagues).values({
    name: `B2 ${unique} league`,
    organizationId: organization.id,
    locationId: location.id,
    active: false,
    seasonStart: "2025-06-01T00:00:00.000Z",
    seasonEnd: "2025-06-22T00:00:00.000Z",
    weekDay: "Sunday",
    competitionStartTime: "19:00",
    timezone: "America/New_York",
    totalBowlingWeeks: 3,
    weeklyFee: 2_000,
    paymentMode: "weekly",
    skipDates: ["2025-06-08"],
    cancelledDates: ["2025-06-15"],
    doublePayDates: ["2025-06-22"],
  }).returning({ id: leagues.id });
  if (!league) throw new Error("B2 league was not created");
  const insertedGames = await db.insert(games).values([
    ...[1, 2, 3].map((gameNumber) => ({
      leagueId: league.id,
      weekNumber: 1,
      gameNumber,
      date: "2025-06-01T19:00:00.000Z",
    })),
    ...[1, 2, 3].map((gameNumber) => ({
      leagueId: league.id,
      weekNumber: 2,
      gameNumber,
      date: "2025-06-22T19:00:00.000Z",
    })),
  ]).returning({ id: games.id });
  return {
    organizationId: organization.id,
    actorUserId: actor.id,
    regularUserId: regular.id,
    systemAdminUserId: systemAdmin.id,
    locationId: location.id,
    leagueId: league.id,
    gameIds: insertedGames.map((game) => game.id),
  };
}

function reportInputs(f: Fixture, overrides: Partial<{
  ambiguousFold: "reject" | "earlier" | "later";
  regularSessionBillingPolicy: "none" | "eligible_bowlers";
  billingOrdinalPolicy: "planned_slot" | "dense_billable";
}> = {}) {
  return {
    organizationId: f.organizationId,
    seasonYear: 2025,
    asOfDate: "2026-01-01",
    leagueId: f.leagueId,
    sourceScheduleRevision: 1,
    ambiguousFold: "reject" as const,
    currency: "USD",
    regularSessionBillingPolicy: "eligible_bowlers" as const,
    billingOrdinalPolicy: "planned_slot" as const,
    ...overrides,
  };
}

async function loadReport(
  f: Fixture,
  overrides: Parameters<typeof reportInputs>[1] = {},
): Promise<CompletedSummerComparisonReport> {
  const client = new pg.Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    return await loadCompletedSummerComparisonReport(client, reportInputs(f, overrides));
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
}

function approval(
  f: Fixture,
  report: CompletedSummerComparisonReport,
  overrides: Partial<CompletedSummerMaterializationApprovalInput> = {},
): CompletedSummerMaterializationApprovalInput {
  const league = report.leagues[0];
  const acknowledgedFindingReferences = [...league.matchResults, ...league.discrepancies]
    .filter((finding) => finding.severity !== "info" && finding.severity !== "fatal")
    .map((finding) => finding.stableReference)
    .sort();
  return {
    organizationId: f.organizationId,
    leagueId: f.leagueId,
    actorUserId: f.actorUserId,
    reason: "B2 approved historical canonical materialization",
    idempotencyKey: `b2-${f.leagueId}-approved-materialization`,
    reportFingerprint: report.reportFingerprint,
    inputFingerprint: league.canonicalGeneration.inputFingerprint,
    physicalScheduleFingerprint: league.canonicalGeneration.physicalScheduleFingerprint,
    expectedSourceScheduleRevision: 1,
    materializationContractVersion: COMPLETED_SUMMER_MATERIALIZATION_CONTRACT_VERSION,
    acknowledgedFindingReferences,
    requestedScope: reportInputs(f),
    ...overrides,
  };
}

function plan(f: Fixture, report: CompletedSummerComparisonReport, overrides: Partial<CompletedSummerMaterializationApprovalInput> = {}) {
  return validateCompletedSummerMaterializationArtifact({
    reportArtifact: canonicalJsonStringify(report),
    approval: approval(f, report, overrides),
  });
}

async function execute(
  materializationPlan: CompletedSummerMaterializationPlan,
  apply: boolean,
  failureInjection?: CompletedSummerMaterializationFailureStage,
) {
  const client = new pg.Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    return await executeCompletedSummerMaterialization({ client, plan: materializationPlan, apply, failureInjection });
  } finally {
    await client.end();
  }
}

async function a1Counts(f: Fixture) {
  return {
    commands: (await db.select().from(leagueScheduleCommands).where(and(eq(leagueScheduleCommands.organizationId, f.organizationId), eq(leagueScheduleCommands.leagueId, f.leagueId)))).length,
    runs: (await db.select().from(leagueOccurrenceGenerationRuns).where(and(eq(leagueOccurrenceGenerationRuns.organizationId, f.organizationId), eq(leagueOccurrenceGenerationRuns.leagueId, f.leagueId)))).length,
    occurrences: (await db.select().from(leagueOccurrences).where(and(eq(leagueOccurrences.organizationId, f.organizationId), eq(leagueOccurrences.leagueId, f.leagueId)))).length,
    terms: (await db.select().from(leagueOccurrenceBillingTerms).where(and(eq(leagueOccurrenceBillingTerms.organizationId, f.organizationId), eq(leagueOccurrenceBillingTerms.leagueId, f.leagueId)))).length,
    exceptions: (await db.select().from(leagueScheduleExceptions).where(and(eq(leagueScheduleExceptions.organizationId, f.organizationId), eq(leagueScheduleExceptions.leagueId, f.leagueId)))).length,
    occurrenceRevisions: (await db.select().from(leagueOccurrenceRevisions).where(and(eq(leagueOccurrenceRevisions.organizationId, f.organizationId), eq(leagueOccurrenceRevisions.leagueId, f.leagueId)))).length,
    termRevisions: (await db.select().from(leagueOccurrenceBillingTermRevisions).where(and(eq(leagueOccurrenceBillingTermRevisions.organizationId, f.organizationId), eq(leagueOccurrenceBillingTermRevisions.leagueId, f.leagueId)))).length,
    exceptionRevisions: (await db.select().from(leagueScheduleExceptionRevisions).where(and(eq(leagueScheduleExceptionRevisions.organizationId, f.organizationId), eq(leagueScheduleExceptionRevisions.leagueId, f.leagueId)))).length,
    discrepancies: (await db.select().from(leagueOccurrenceGenerationDiscrepancies).where(and(eq(leagueOccurrenceGenerationDiscrepancies.organizationId, f.organizationId), eq(leagueOccurrenceGenerationDiscrepancies.leagueId, f.leagueId)))).length,
    relationships: (await db.select().from(leagueOccurrenceRelationships).where(and(eq(leagueOccurrenceRelationships.organizationId, f.organizationId), eq(leagueOccurrenceRelationships.leagueId, f.leagueId)))).length,
  };
}

async function legacyEvidence(f: Fixture) {
  return {
    league: await db.select().from(leagues).where(eq(leagues.id, f.leagueId)),
    games: await db.select().from(games).where(eq(games.leagueId, f.leagueId)).orderBy(asc(games.id)),
    scores: await db.select().from(scores).where(inArray(scores.gameId, f.gameIds)).orderBy(asc(scores.id)),
    payments: await db.select().from(payments).where(eq(payments.leagueId, f.leagueId)).orderBy(asc(payments.id)),
  };
}

async function caughtCode(callback: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await callback();
    return undefined;
  } catch (error) {
    return error !== null && typeof error === "object" && "code" in error ? String(error.code) : undefined;
  }
}

afterAll(async () => {
  for (const organizationId of organizationsToDelete.splice(0)) await deleteOrganization(organizationId).catch(() => undefined);
  for (const userId of systemAdminsToDelete.splice(0)) await db.delete(users).where(eq(users.id, userId)).catch(() => undefined);
});

describe("B2 atomic Completed-Summer materialization", () => {
  it("persists exact published mappings, truthful commands and revisions, changes no legacy evidence, and returns identical IDs on retry", async () => {
    const f = await fixture("mapping-retry");
    const report = await loadReport(f);
    const materializationPlan = plan(f, report);
    const beforeLegacy = await legacyEvidence(f);
    const first = await execute(materializationPlan, true);
    expect(first.mode).toBe("applied");
    expect(first.writesPerformed).toBe(true);
    expect(first.legacyWritesPerformed).toBe(false);
    expect(first.paymentOrObligationLinksCreated).toBe(false);
    expect(first.durableIds).not.toBeNull();
    const retry = await execute(materializationPlan, true);
    expect(retry.mode).toBe("idempotent_retry");
    expect(retry.writesPerformed).toBe(false);
    expect(retry.durableIds).toEqual(first.durableIds);
    expect(await legacyEvidence(f)).toEqual(beforeLegacy);

    const commands = await db.select().from(leagueScheduleCommands).where(and(
      eq(leagueScheduleCommands.organizationId, f.organizationId),
      eq(leagueScheduleCommands.leagueId, f.leagueId),
    )).orderBy(asc(leagueScheduleCommands.commandType));
    expect(commands.map((command) => command.commandType).sort()).toEqual([
      "approve_generation", "cancel", "create_exception", "generate", "publish",
    ]);
    const run = (await db.select().from(leagueOccurrenceGenerationRuns).where(eq(leagueOccurrenceGenerationRuns.leagueId, f.leagueId)))[0];
    expect(run).toMatchObject({
      state: "applied",
      sourceScheduleRevision: 1,
      inputFingerprint: report.leagues[0].canonicalGeneration.inputFingerprint,
      approvedByUserId: f.actorUserId,
    });
    expect(run.normalizedInputSnapshot).toEqual(report.leagues[0].canonicalGeneration.normalizedInput);
    const occurrences = await db.select().from(leagueOccurrences).where(eq(leagueOccurrences.leagueId, f.leagueId))
      .orderBy(asc(leagueOccurrences.plannedOrdinal));
    expect(occurrences.map((row) => ({
      status: row.status,
      lifecycle: row.lifecycle,
      plannedOrdinal: row.plannedOrdinal,
      competitionNumber: row.competitionNumber,
      competitive: row.competitive,
      countsInStandings: row.countsInStandings,
      lockedAt: row.lockedAt,
    }))).toEqual([
      { status: "scheduled", lifecycle: "published", plannedOrdinal: 1, competitionNumber: 1, competitive: true, countsInStandings: true, lockedAt: null },
      { status: "cancelled", lifecycle: "published", plannedOrdinal: 2, competitionNumber: null, competitive: false, countsInStandings: false, lockedAt: null },
      { status: "scheduled", lifecycle: "published", plannedOrdinal: 3, competitionNumber: 3, competitive: true, countsInStandings: true, lockedAt: null },
    ]);
    const cancelled = occurrences[1];
    expect(cancelled.cancelledAt).not.toBeNull();
    expect(cancelled.cancellationCommandId).toBe(commands.find((command) => command.commandType === "cancel")?.id);
    const terms = await db.select().from(leagueOccurrenceBillingTerms).where(eq(leagueOccurrenceBillingTerms.leagueId, f.leagueId))
      .orderBy(asc(leagueOccurrenceBillingTerms.billingOrdinal));
    expect(terms).toHaveLength(3);
    expect(terms.find((term) => term.occurrenceId === cancelled.id)).toMatchObject({
      state: "published",
      obligationPolicy: "none",
      defaultAmountMinor: 0,
      billingOrdinal: null,
    });
    expect(terms.filter((term) => term.obligationPolicy === "eligible_bowlers").map((term) => term.defaultAmountMinor)).toEqual([2_000, 2_000]);
    const exceptions = await db.select().from(leagueScheduleExceptions).where(eq(leagueScheduleExceptions.leagueId, f.leagueId));
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]).toMatchObject({
      localDate: "2025-06-08",
      lifecycle: "draft",
      source: "legacy_import",
      generationRunId: run.id,
      publicationCommandId: null,
    });
    expect(await a1Counts(f)).toEqual({
      commands: 5,
      runs: 1,
      occurrences: 3,
      terms: 3,
      exceptions: 1,
      occurrenceRevisions: 3,
      termRevisions: 3,
      exceptionRevisions: 1,
      discrepancies: 0,
      relationships: 0,
    });
  });

  it("keeps plan mode at zero writes and enforces org-admin, platform-admin, ordinary-user, and cross-tenant authorization", async () => {
    const f = await fixture("authorization");
    const other = await fixture("authorization-other");
    const report = await loadReport(f);
    const before = await a1Counts(f);
    expect((await execute(plan(f, report), false)).mode).toBe("plan");
    expect(await a1Counts(f)).toEqual(before);
    expect((await execute(plan(f, report, { actorUserId: f.systemAdminUserId }), false)).mode).toBe("plan");
    expect(await caughtCode(() => execute(plan(f, report, { actorUserId: f.regularUserId }), false))).toBe("unauthorized_actor");
    expect(await caughtCode(() => execute(plan(f, report, { actorUserId: other.actorUserId }), false))).toBe("unauthorized_actor");
    expect(await a1Counts(f)).toEqual(before);
  });

  it("rejects stale evidence, changed same-key payloads, different-key adoption, and partial A1 state", async () => {
    const stale = await fixture("stale");
    const staleReport = await loadReport(stale);
    await db.update(leagues).set({ weeklyFee: 2_100 }).where(eq(leagues.id, stale.leagueId));
    expect(await caughtCode(() => execute(plan(stale, staleReport), true))).toBe("stale_report");
    expect((await a1Counts(stale)).commands).toBe(0);

    const retry = await fixture("idempotency-conflict");
    const retryReport = await loadReport(retry);
    const original = plan(retry, retryReport);
    await execute(original, true);
    expect(await caughtCode(() => execute(plan(retry, retryReport, {
      reason: "A materially changed approval reason",
    }), true))).toBe("idempotency_conflict");
    expect(await caughtCode(() => execute(plan(retry, retryReport, {
      idempotencyKey: `different-${retry.leagueId}`,
    }), true))).toBe("stale_report");

    const partial = await fixture("partial-a1");
    const partialReport = await loadReport(partial);
    await db.insert(leagueScheduleCommands).values({
      organizationId: partial.organizationId,
      leagueId: partial.leagueId,
      actorUserId: partial.actorUserId,
      commandType: "compare",
      idempotencyKey: `manual-partial-${partial.leagueId}`,
      requestFingerprint: `manual-partial:${partial.leagueId}`,
    });
    expect(await caughtCode(() => execute(plan(partial, partialReport), true))).toBe("stale_report");
    expect((await a1Counts(partial)).commands).toBe(1);
  });

  it.each([
    "after_commands",
    "after_generation_run",
    "after_occurrences",
    "after_billing_terms",
    "after_exceptions",
    "after_revisions",
    "after_discrepancies",
  ] as const)("rolls back every B2 row on injected failure %s", async (stage) => {
    const f = await fixture(`rollback-${stage}`);
    const report = await loadReport(f);
    const beforeLegacy = await legacyEvidence(f);
    await expect(execute(plan(f, report), true, stage)).rejects.toBeInstanceOf(CompletedSummerMaterializationError);
    expect(await a1Counts(f)).toEqual({
      commands: 0,
      runs: 0,
      occurrences: 0,
      terms: 0,
      exceptions: 0,
      occurrenceRevisions: 0,
      termRevisions: 0,
      exceptionRevisions: 0,
      discrepancies: 0,
      relationships: 0,
    });
    expect(await legacyEvidence(f)).toEqual(beforeLegacy);
  });

  it("serializes identical and conflicting concurrent approvals", async () => {
    const identical = await fixture("concurrent-identical");
    const identicalPlan = plan(identical, await loadReport(identical));
    const identicalResults = await Promise.all([
      execute(identicalPlan, true),
      execute(identicalPlan, true),
    ]);
    expect(new Set(identicalResults.map((result) => result.mode))).toEqual(new Set(["applied", "idempotent_retry"]));
    expect(identicalResults[0].durableIds).toEqual(identicalResults[1].durableIds);

    const conflicting = await fixture("concurrent-conflicting");
    const conflictingReport = await loadReport(conflicting);
    const outcomes = await Promise.allSettled([
      execute(plan(conflicting, conflictingReport), true),
      execute(plan(conflicting, conflictingReport, { idempotencyKey: `competing-${conflicting.leagueId}` }), true),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect((await a1Counts(conflicting)).runs).toBe(1);
  });

  it("keeps organization teardown atomic for every B2-created row", async () => {
    const f = await fixture("organization-delete");
    await execute(plan(f, await loadReport(f)), true);
    await deleteOrganization(f.organizationId);
    const index = organizationsToDelete.indexOf(f.organizationId);
    if (index >= 0) organizationsToDelete.splice(index, 1);
    expect(await db.select().from(organizations).where(eq(organizations.id, f.organizationId))).toHaveLength(0);
    expect((await db.execute(sql`SELECT count(*)::integer AS count FROM league_schedule_commands WHERE organization_id = ${f.organizationId}`)).rows).toEqual([{ count: 0 }]);
    expect((await db.execute(sql`SELECT count(*)::integer AS count FROM league_occurrences WHERE organization_id = ${f.organizationId}`)).rows).toEqual([{ count: 0 }]);
    expect((await db.execute(sql`SELECT count(*)::integer AS count FROM league_occurrence_billing_terms WHERE organization_id = ${f.organizationId}`)).rows).toEqual([{ count: 0 }]);
  });

  it.each([
    ["earlier", -240],
    ["later", -300],
  ] as const)("persists the authoritative DST fold tuple for %s approval", async (ambiguousFold, expectedOffset) => {
    const f = await fixture(`fold-${ambiguousFold}`);
    await db.delete(games).where(eq(games.leagueId, f.leagueId));
    const dates = [
      "2025-07-27", "2025-08-03", "2025-08-10", "2025-08-17",
      "2025-08-24", "2025-08-31", "2025-09-07", "2025-09-14", "2025-09-21", "2025-09-28",
      "2025-10-05", "2025-10-12", "2025-10-19", "2025-10-26", "2025-11-02",
    ];
    await db.update(leagues).set({
      seasonStart: "2025-07-27T00:00:00.000Z",
      seasonEnd: "2025-11-02T00:00:00.000Z",
      competitionStartTime: "01:30",
      totalBowlingWeeks: dates.length,
      skipDates: [],
      cancelledDates: [],
    }).where(eq(leagues.id, f.leagueId));
    await db.insert(games).values(dates.flatMap((date, index) => [1, 2, 3].map((gameNumber) => ({
      leagueId: f.leagueId,
      weekNumber: index + 1,
      gameNumber,
      date: `${date}T01:30:00.000Z`,
    }))));
    const report = await loadReport(f, { ambiguousFold });
    const materializationPlan = plan(f, report, { requestedScope: reportInputs(f, { ambiguousFold }) });
    await execute(materializationPlan, true);
    const [foldOccurrence] = await db.select().from(leagueOccurrences).where(and(
      eq(leagueOccurrences.leagueId, f.leagueId),
      eq(leagueOccurrences.authoritativeLocalDate, "2025-11-02"),
    ));
    expect(foldOccurrence).toMatchObject({
      timezone: "America/New_York",
      foldResolution: ambiguousFold,
      selectedUtcOffsetMinutes: expectedOffset,
      resolverVersion: report.leagues[0].canonicalGeneration.resolverVersion,
    });
    expect(new Date(foldOccurrence.startAt).toISOString()).toBe(
      ambiguousFold === "earlier" ? "2025-11-02T05:30:00.000Z" : "2025-11-02T06:30:00.000Z",
    );
  });

  it("preserves explicit nonbillable none/zero/null terms", async () => {
    const f = await fixture("nonbillable");
    await db.update(leagues).set({ weeklyFee: 0 }).where(eq(leagues.id, f.leagueId));
    const report = await loadReport(f, { regularSessionBillingPolicy: "none" });
    await execute(plan(f, report, {
      requestedScope: reportInputs(f, { regularSessionBillingPolicy: "none" }),
    }), true);
    const terms = await db.select().from(leagueOccurrenceBillingTerms).where(eq(leagueOccurrenceBillingTerms.leagueId, f.leagueId));
    expect(terms).toHaveLength(3);
    expect(terms.every((term) => term.obligationPolicy === "none"
      && term.defaultAmountMinor === 0 && term.billingOrdinal === null)).toBe(true);
  });

  it("retains acknowledged duplicate-game and ambiguous-payment review evidence without creating links", async () => {
    const f = await fixture("ambiguous-evidence");
    await db.insert(games).values({
      leagueId: f.leagueId,
      weekNumber: 1,
      gameNumber: 1,
      date: "2025-06-01T19:00:00.000Z",
    });
    const [bowler] = await db.insert(bowlers).values({
      name: "B2 ambiguous payment bowler",
      organizationId: f.organizationId,
    }).returning({ id: bowlers.id });
    if (!bowler) throw new Error("B2 ambiguous bowler was not created");
    const [payment] = await db.insert(payments).values({
      bowlerId: bowler.id,
      leagueId: f.leagueId,
      amount: 2_000,
      status: "paid",
      type: "cash",
      weekOf: "2025-06-01T19:00:00.000Z",
    }).returning({ id: payments.id });
    if (!payment) throw new Error("B2 ambiguous payment was not created");
    const report = await loadReport(f);
    expect(report.leagues[0].discrepancies.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      "duplicate_historical_game_key",
      "ambiguous_historical_payment",
    ]));
    const materializationPlan = plan(f, report);
    await execute(materializationPlan, true);
    const retry = await execute(materializationPlan, true);
    expect(retry.mode).toBe("idempotent_retry");
    const discrepancies = await db.select().from(leagueOccurrenceGenerationDiscrepancies)
      .where(eq(leagueOccurrenceGenerationDiscrepancies.leagueId, f.leagueId))
      .orderBy(asc(leagueOccurrenceGenerationDiscrepancies.code));
    expect(discrepancies.map((row) => row.code)).toEqual([
      "ambiguous_historical_payment",
      "duplicate_historical_game_key",
    ]);
    expect(discrepancies.every((row) => row.resolutionState === "open")).toBe(true);
    const [run] = await db.select().from(leagueOccurrenceGenerationRuns)
      .where(eq(leagueOccurrenceGenerationRuns.leagueId, f.leagueId));
    expect(run?.discrepancyCount).toBe(discrepancies.length);
    const [paymentAfter] = await db.select().from(payments).where(eq(payments.id, payment.id));
    expect(paymentAfter).toMatchObject({
      id: payment.id,
      paymentOperationId: null,
      paymentOperationAllocationIndex: null,
    });
    expect((await a1Counts(f)).relationships).toBe(0);
  });

  it("enforces the operator's plan/apply fingerprint gate, sanitizes output, and closes its dedicated client", async () => {
    const f = await fixture("operator");
    const report = await loadReport(f);
    const materializationPlan = plan(f, report);
    const reportPath = join(tmpdir(), `leaguevault-b2-report-${f.organizationId}-${f.leagueId}.json`);
    await writeFile(reportPath, `${canonicalJsonStringify(report)}\n`, "utf8");
    const baseArgs = [
      `--reportFile=${reportPath}`,
      `--organizationId=${f.organizationId}`,
      `--leagueId=${f.leagueId}`,
      "--seasonYear=2025",
      "--asOfDate=2026-01-01",
      "--sourceScheduleRevision=1",
      "--ambiguousFold=reject",
      "--currency=USD",
      "--regularSessionBillingPolicy=eligible_bowlers",
      "--billingOrdinalPolicy=planned_slot",
      `--actorUserId=${f.actorUserId}`,
      "--reason=B2 approved historical canonical materialization",
      `--idempotencyKey=b2-${f.leagueId}-approved-materialization`,
      `--reportFingerprint=${materializationPlan.approval.reportFingerprint}`,
      `--inputFingerprint=${materializationPlan.approval.inputFingerprint}`,
      `--physicalScheduleFingerprint=${materializationPlan.approval.physicalScheduleFingerprint}`,
      `--materializationContract=${COMPLETED_SUMMER_MATERIALIZATION_CONTRACT_VERSION}`,
      ...materializationPlan.requiredAcknowledgementReferences.map((reference) => `--acknowledge=${reference}`),
    ];
    const tsx = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    const run = (args: string[]) => spawnSync(process.execPath, [tsx, "scripts/materialize-completed-summer-occurrences.ts", ...args], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: databaseUrl() },
    });
    try {
      const before = await a1Counts(f);
      const planned = run(baseArgs);
      expect(planned.status).toBe(0);
      const planOutput = JSON.parse(planned.stdout) as { mode: string; requestFingerprint: string; writesPerformed: boolean };
      expect(planOutput).toMatchObject({ mode: "plan", writesPerformed: false });
      expect(await a1Counts(f)).toEqual(before);
      const rejected = run([
        ...baseArgs,
        "--apply",
        `--confirmReportFingerprint=${report.reportFingerprint}`,
        `--confirmRequestFingerprint=${"lvcanoncmd:v1:"}${"0".repeat(64)}`,
      ]);
      expect(rejected.status).toBe(1);
      expect(await a1Counts(f)).toEqual(before);
      const applied = run([
        ...baseArgs,
        "--apply",
        `--confirmReportFingerprint=${report.reportFingerprint}`,
        `--confirmRequestFingerprint=${planOutput.requestFingerprint}`,
      ]);
      expect(applied.status).toBe(0);
      expect(JSON.parse(applied.stdout)).toMatchObject({ mode: "applied", legacyWritesPerformed: false });
      expect(applied.stdout).not.toContain(databaseUrl());
      expect(applied.stdout).not.toContain("example.test");
      const activeClients = await db.execute(sql`
        SELECT count(*)::integer AS count
        FROM pg_stat_activity
        WHERE application_name = 'leaguevault-completed-summer-b2-materialization'
      `);
      expect(activeClients.rows).toEqual([{ count: 0 }]);
    } finally {
      await unlink(reportPath).catch(() => undefined);
    }
  });
});
