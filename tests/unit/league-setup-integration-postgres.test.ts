import { afterAll, describe, expect, it } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  bowlerLeagues,
  bowlers,
  leagueOccurrenceBillingTerms,
  leagueOccurrenceGenerationRuns,
  leagueOccurrences,
  leagueScheduleCommands,
  leagueScheduleExceptions,
  leagues,
  locations,
  organizations,
  teams,
  users,
  type InsertLeague,
  type PaymentMode,
} from "@shared/schema";
import { LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION } from "@shared/league-setup-integration";
import {
  createLeagueWithCanonicalSetup,
  createNewSeasonWithCanonicalSetup,
  LeagueSetupIntegrationError,
  type LeagueSetupFailureStage,
} from "../../server/services/league-setup-integration";
import type { FallDraftFailureStage } from "../../server/services/fall-draft-generation";
import { LeagueCanonicalScheduleLockedError, updateLeague } from "../../server/storage/leagues";
import { deleteOrganization } from "../../server/storage/organizations";
import { getTestDb } from "../setup/test-db";

const db = getTestDb();
const organizationsToDelete: number[] = [];
const systemAdminsToDelete: number[] = [];
let sequence = 0;

interface Fixture {
  organizationId: number;
  locationId: number;
  actorUserId: number;
  regularUserId: number;
  systemAdminUserId: number;
}

async function fixture(label: string): Promise<Fixture> {
  const suffix = `${label}-${++sequence}`.toLowerCase();
  const [organization] = await db.insert(organizations).values({ name: `Setup ${suffix}`, slug: `setup-${suffix}` }).returning();
  if (!organization) throw new Error("organization fixture failed");
  organizationsToDelete.push(organization.id);
  const [actor, regular, systemAdmin] = await db.insert(users).values([
    { email: `setup-${suffix}@example.test`, password: "hash", name: "Setup admin", role: "org_admin", organizationId: organization.id },
    { email: `setup-${suffix}-user@example.test`, password: "hash", name: "Setup user", role: "user", organizationId: organization.id },
    { email: `setup-${suffix}-system@example.test`, password: "hash", name: "Setup system", role: "system_admin", organizationId: null },
  ]).returning();
  const [location] = await db.insert(locations).values({ name: `Setup ${suffix} location`, organizationId: organization.id }).returning();
  if (!actor || !regular || !systemAdmin || !location) throw new Error("setup fixture failed");
  systemAdminsToDelete.push(systemAdmin.id);
  return {
    organizationId: organization.id,
    locationId: location.id,
    actorUserId: actor.id,
    regularUserId: regular.id,
    systemAdminUserId: systemAdmin.id,
  };
}

function setup(key: number) {
  return {
    contractVersion: LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION,
    idempotencyKey: `10000000-0000-4000-8000-${String(key).padStart(12, "0")}`,
  } as const;
}

function fallLeague(f: Fixture, paymentMode: PaymentMode = "weekly", overrides: Partial<InsertLeague> = {}): InsertLeague {
  return {
    name: `Future Fall ${sequence}`,
    description: "atomic setup",
    active: true,
    allowPublicSignup: false,
    seasonStart: "2032-10-03T00:00:00.000Z",
    seasonEnd: "2032-11-21T00:00:00.000Z",
    weekDay: "Sunday",
    weeklyFee: 2_000,
    lineageFee: 1_200,
    prizeFundFee: 800,
    practiceStartTime: "18:30",
    competitionStartTime: "19:00",
    timezone: "America/New_York",
    paymentMode,
    organizationId: f.organizationId,
    locationId: f.locationId,
    seasonNumber: 1,
    previousSeasonId: null,
    totalBowlingWeeks: 6,
    skipDates: ["2032-10-10"],
    cancelledDates: ["2032-10-24"],
    doublePayDates: ["2032-11-07"],
    ...overrides,
  };
}

async function organizationCounts(organizationId: number) {
  const names = [
    "leagues",
    "league_schedule_commands",
    "league_occurrence_generation_runs",
    "league_occurrences",
    "league_occurrence_billing_terms",
    "league_schedule_exceptions",
    "league_occurrence_revisions",
    "league_occurrence_billing_term_revisions",
    "league_schedule_exception_revisions",
    "league_occurrence_generation_discrepancies",
  ] as const;
  const result: Record<string, number> = {};
  for (const name of names) {
    const counted = await db.execute(sql.raw(`SELECT count(*)::integer AS count FROM ${name} WHERE organization_id = ${organizationId}`));
    result[name] = Number(counted.rows[0]?.count ?? 0);
  }
  return result;
}

afterAll(async () => {
  for (const organizationId of organizationsToDelete.splice(0)) {
    await deleteOrganization(organizationId).catch(() => undefined);
  }
  for (const userId of systemAdminsToDelete.splice(0)) {
    await db.delete(users).where(eq(users.id, userId)).catch(() => undefined);
  }
});

describe("authoritative league setup integration", () => {
  it.each(["weekly", "upfront"] as const)("atomically creates complete %s Fall drafts with fixed policies", async (paymentMode) => {
    const f = await fixture(`complete-${paymentMode}`);
    const result = await createLeagueWithCanonicalSetup({
      scope: { organizationId: f.organizationId, actorUserId: f.actorUserId },
      league: fallLeague(f, paymentMode),
      setup: setup(++sequence),
    });
    expect(result).toMatchObject({
      paymentMode,
      setupIntegration: { mode: "created", writesPerformed: true },
      canonicalDraftGeneration: {
        mode: "applied",
        writesPerformed: true,
        relationshipsCreated: false,
        paymentObligationOrCollectionRowsCreated: false,
      },
    });
    const [run] = await db.select().from(leagueOccurrenceGenerationRuns).where(eq(leagueOccurrenceGenerationRuns.leagueId, result.id));
    expect(run).toMatchObject({ state: "generated", approvedAt: null, rejectedAt: null, sourceScheduleRevision: 1 });
    const occurrences = await db.select().from(leagueOccurrences).where(eq(leagueOccurrences.leagueId, result.id)).orderBy(asc(leagueOccurrences.plannedOrdinal));
    const terms = await db.select().from(leagueOccurrenceBillingTerms).where(eq(leagueOccurrenceBillingTerms.leagueId, result.id));
    const exceptions = await db.select().from(leagueScheduleExceptions).where(eq(leagueScheduleExceptions.leagueId, result.id));
    expect(occurrences).toHaveLength(6);
    expect(occurrences.every((row) => row.lifecycle === "draft")).toBe(true);
    expect(new Set(occurrences.map((row) => row.selectedUtcOffsetMinutes))).toEqual(new Set([-240, -300]));
    expect(terms.every((row) => row.state === "draft" && row.currency === "USD")).toBe(true);
    expect(terms.map((row) => row.billingOrdinal).filter((value) => value !== null).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(terms.every((row) => row.obligationPolicy === "eligible_bowlers" || row.obligationPolicy === "none")).toBe(true);
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]).toMatchObject({ lifecycle: "draft", localDate: "2032-10-10" });
  });

  it("keeps non-Fall creation on the legacy row path without canonical writes", async () => {
    const f = await fixture("non-fall");
    const result = await createLeagueWithCanonicalSetup({
      scope: { organizationId: f.organizationId, actorUserId: f.regularUserId },
      league: fallLeague(f, "weekly", { seasonStart: "2032-11-07T00:00:00.000Z", seasonEnd: "2032-12-19T00:00:00.000Z", skipDates: [] }),
      setup: setup(++sequence),
    });
    expect(result.setupIntegration).toMatchObject({ mode: "not_applicable", writesPerformed: true });
    expect(result.canonicalDraftGeneration).toBeNull();
    expect(await db.select().from(leagueScheduleCommands).where(eq(leagueScheduleCommands.leagueId, result.id))).toHaveLength(0);
  });

  it("rolls back the league for past slots, unauthorized actors, and cross-tenant locations", async () => {
    const f = await fixture("closed-boundaries");
    const before = await organizationCounts(f.organizationId);
    await expect(createLeagueWithCanonicalSetup({
      scope: { organizationId: f.organizationId, actorUserId: f.actorUserId },
      league: fallLeague(f, "weekly", {
        seasonStart: "2025-08-03T00:00:00.000Z",
        seasonEnd: "2025-08-17T00:00:00.000Z",
        totalBowlingWeeks: 3,
        skipDates: [],
        cancelledDates: [],
        doublePayDates: [],
      }),
      setup: setup(++sequence),
    })).rejects.toMatchObject({ code: "not_wholly_future" });
    await expect(createLeagueWithCanonicalSetup({
      scope: { organizationId: f.organizationId, actorUserId: f.regularUserId },
      league: fallLeague(f),
      setup: setup(++sequence),
    })).rejects.toMatchObject({ code: "unauthorized_actor" });
    const other = await fixture("foreign-location");
    await expect(createLeagueWithCanonicalSetup({
      scope: { organizationId: f.organizationId, actorUserId: f.actorUserId },
      league: fallLeague(f, "weekly", { locationId: other.locationId }),
      setup: setup(++sequence),
    })).rejects.toBeInstanceOf(LeagueSetupIntegrationError);
    expect(await organizationCounts(f.organizationId)).toEqual(before);
  });

  it.each([
    "after_commands",
    "after_generation_run",
    "after_occurrences",
    "after_billing_terms",
    "after_exceptions",
    "after_revisions",
    "after_discrepancies",
  ] as FallDraftFailureStage[])("rolls the league back with an injected C1 %s failure", async (canonicalFailureInjection) => {
    const f = await fixture(`c1-rollback-${canonicalFailureInjection}`);
    const before = await organizationCounts(f.organizationId);
    await expect(createLeagueWithCanonicalSetup({
      scope: { organizationId: f.organizationId, actorUserId: f.actorUserId },
      league: fallLeague(f),
      setup: setup(++sequence),
      canonicalFailureInjection,
    })).rejects.toMatchObject({ code: "transaction_failure" });
    expect(await organizationCounts(f.organizationId)).toEqual(before);
  });

  it("converges exact and concurrent retries and conflicts on changed setup semantics", async () => {
    const f = await fixture("idempotency");
    const intent = setup(++sequence);
    const request = {
      scope: { organizationId: f.organizationId, actorUserId: f.actorUserId },
      league: fallLeague(f),
      setup: intent,
    };
    const [left, right] = await Promise.all([
      createLeagueWithCanonicalSetup(request),
      createLeagueWithCanonicalSetup(request),
    ]);
    expect(left.id).toBe(right.id);
    expect(left.canonicalDraftGeneration?.durableIds).toEqual(right.canonicalDraftGeneration?.durableIds);
    expect([left.setupIntegration.mode, right.setupIntegration.mode].sort()).toEqual(["created", "idempotent_retry"]);
    const retry = await createLeagueWithCanonicalSetup(request);
    expect(retry.setupIntegration).toMatchObject({ mode: "idempotent_retry", writesPerformed: false });
    await expect(createLeagueWithCanonicalSetup({ ...request, league: { ...request.league, weeklyFee: 2_100 } }))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(await db.select().from(leagues).where(eq(leagues.organizationId, f.organizationId))).toHaveLength(1);
  });

  it("conflicts when a system administrator reuses one setup key in another organization", async () => {
    const first = await fixture("key-organization-one");
    const second = await fixture("key-organization-two");
    const sharedIntent = setup(++sequence);
    await createLeagueWithCanonicalSetup({
      scope: { organizationId: first.organizationId, actorUserId: first.systemAdminUserId },
      league: fallLeague(first),
      setup: sharedIntent,
    });
    await expect(createLeagueWithCanonicalSetup({
      scope: { organizationId: second.organizationId, actorUserId: first.systemAdminUserId },
      league: fallLeague(second),
      setup: sharedIntent,
    })).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(await db.select().from(leagues).where(eq(leagues.organizationId, second.organizationId))).toHaveLength(0);
  });

  it("copies the complete roster in order, creates drafts, and archives the source only at commit", async () => {
    const f = await fixture("new-season");
    const [source] = await db.insert(leagues).values(fallLeague(f, "weekly", {
      name: "Source season",
      seasonStart: "2031-01-05T00:00:00.000Z",
      seasonEnd: "2031-03-30T00:00:00.000Z",
      totalBowlingWeeks: 12,
      skipDates: [],
      cancelledDates: [],
      doublePayDates: [],
    })).returning();
    const sourceTeams = await db.insert(teams).values([
      { name: "Second", number: 2, leagueId: source.id, active: false, displayOrder: 1 },
      { name: "First", number: 1, leagueId: source.id, active: true, displayOrder: 0 },
    ]).returning();
    const [firstBowler, secondBowler] = await db.insert(bowlers).values([
      { name: "First Bowler", organizationId: f.organizationId },
      { name: "Second Bowler", organizationId: f.organizationId },
    ]).returning();
    await db.insert(bowlerLeagues).values([
      { bowlerId: firstBowler.id, leagueId: source.id, teamId: sourceTeams[1].id, active: true, order: 3 },
      { bowlerId: secondBowler.id, leagueId: source.id, teamId: sourceTeams[0].id, active: false, order: 7 },
    ]);
    const values = {
      seasonStart: "2032-10-03",
      totalBowlingWeeks: 6,
      weekDay: "Sunday" as const,
      skipDates: ["2032-10-10"],
      cancelledDates: ["2032-10-24"],
      doublePayDates: ["2032-11-07"],
      allowPublicSignup: true,
      paymentMode: "upfront" as const,
    };
    const created = await createNewSeasonWithCanonicalSetup({
      scope: { organizationId: f.organizationId, actorUserId: f.actorUserId },
      sourceLeagueId: source.id,
      values,
      setup: setup(++sequence),
    });
    expect(created.result).toMatchObject({ previousSeasonId: source.id, active: true, canonicalDraftGeneration: { mode: "applied" } });
    const [archived] = await db.select().from(leagues).where(eq(leagues.id, source.id));
    expect(archived.active).toBe(false);
    const copiedTeams = await db.select().from(teams).where(eq(teams.leagueId, created.result.id)).orderBy(asc(teams.displayOrder));
    expect(copiedTeams.map((row) => [row.name, row.number, row.active, row.displayOrder])).toEqual([
      ["First", 1, true, 0],
      ["Second", 2, false, 1],
    ]);
    const copiedRoster = await db.select().from(bowlerLeagues).where(eq(bowlerLeagues.leagueId, created.result.id)).orderBy(asc(bowlerLeagues.order));
    expect(copiedRoster.map((row) => [row.bowlerId, row.active, row.order])).toEqual([
      [firstBowler.id, true, 3],
      [secondBowler.id, false, 7],
    ]);
    expect(copiedRoster.map((row) => copiedTeams.find((team) => team.id === row.teamId)?.name)).toEqual(["First", "Second"]);
    const retry = await createNewSeasonWithCanonicalSetup({
      scope: { organizationId: f.organizationId, actorUserId: f.actorUserId },
      sourceLeagueId: source.id,
      values,
      setup: setup(sequence),
    });
    expect(retry.result).toMatchObject({ id: created.result.id, setupIntegration: { mode: "idempotent_retry", writesPerformed: false } });
  });

  it.each([
    "after_team_copy",
    "after_roster_copy",
    "after_canonical_generation",
    "after_source_archive",
  ] as LeagueSetupFailureStage[])("rolls back a new season failure at %s", async (failureInjection) => {
    const f = await fixture(`season-rollback-${failureInjection}`);
    const [source] = await db.insert(leagues).values(fallLeague(f, "weekly", {
      seasonStart: "2031-01-05T00:00:00.000Z", seasonEnd: "2031-02-23T00:00:00.000Z", skipDates: [], cancelledDates: [], doublePayDates: [],
    })).returning();
    await db.insert(teams).values({ name: "Rollback team", number: 1, leagueId: source.id });
    await expect(createNewSeasonWithCanonicalSetup({
      scope: { organizationId: f.organizationId, actorUserId: f.actorUserId },
      sourceLeagueId: source.id,
      values: { seasonStart: "2032-08-01", totalBowlingWeeks: 3, weekDay: "Sunday", skipDates: [], cancelledDates: [], doublePayDates: [], paymentMode: "weekly" },
      setup: setup(++sequence),
      failureInjection,
    })).rejects.toMatchObject({ code: "transaction_failure" });
    const rows = await db.select().from(leagues).where(eq(leagues.organizationId, f.organizationId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: source.id, active: true });
    expect(await db.select().from(leagueScheduleCommands).where(eq(leagueScheduleCommands.organizationId, f.organizationId))).toHaveLength(0);
  });

  it("blocks material canonical edits after setup while permitting no-ops, metadata, and double-pay evidence", async () => {
    const f = await fixture("edit-boundary");
    const created = await createLeagueWithCanonicalSetup({
      scope: { organizationId: f.organizationId, actorUserId: f.actorUserId }, league: fallLeague(f), setup: setup(++sequence),
    });
    await expect(updateLeague(created.id, { weeklyFee: created.weeklyFee + 1 }))
      .rejects.toBeInstanceOf(LeagueCanonicalScheduleLockedError);
    await expect(updateLeague(created.id, { skipDates: [...created.skipDates, "2032-12-01"] }))
      .rejects.toBeInstanceOf(LeagueCanonicalScheduleLockedError);
    await expect(updateLeague(created.id, {
      organizationId: created.organizationId as number,
      seasonStart: `${created.seasonStart.slice(0, 10)}T12:00:00.000Z`,
      seasonEnd: `${created.seasonEnd.slice(0, 10)}T12:00:00.000Z`,
      weekDay: created.weekDay,
      competitionStartTime: created.competitionStartTime ?? undefined,
      timezone: created.timezone ?? undefined,
      totalBowlingWeeks: created.totalBowlingWeeks,
      skipDates: [...created.skipDates],
      cancelledDates: [...created.cancelledDates],
      weeklyFee: created.weeklyFee,
      paymentMode: created.paymentMode,
    })).resolves.toMatchObject({ id: created.id });
    await expect(updateLeague(created.id, { name: "Metadata remains editable", doublePayDates: ["2032-10-17"] }))
      .resolves.toMatchObject({ name: "Metadata remains editable", doublePayDates: ["2032-10-17"] });
    const counts = await db.select({ count: sql<number>`count(*)::integer` }).from(leagueOccurrences).where(eq(leagueOccurrences.leagueId, created.id));
    expect(counts[0]?.count).toBe(created.canonicalDraftGeneration?.counts.occurrences);
  });
});
