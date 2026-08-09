import { afterAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  bowlerLeagues,
  bowlers,
  leagueOccurrenceGenerationRuns,
  leagueOccurrences,
  leagueScheduleCommands,
  leagues,
  locations,
  organizations,
  teams,
  users,
} from "@shared/schema";
import { deleteOrganization } from "../../server/storage/organizations";
import {
  deleteLeague,
  LeagueOccurrenceEvidenceExistsError,
} from "../../server/storage/leagues";
import {
  deleteLocation,
  LocationOccurrenceEvidenceExistsError,
} from "../../server/storage/locations";
import { lockLeagueSchedule } from "../../server/storage/league-schedule-lock";
import { getTestDb } from "../setup/test-db";

const db = getTestDb();
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const organizationIds: number[] = [];

interface Fixture {
  organizationId: number;
  actorUserId: number;
  locationId: number;
  leagueId: number;
  teamId: number;
  bowlerId: number;
  rosterId: number;
}

async function fixture(label: string): Promise<Fixture> {
  const [organization] = await db.insert(organizations).values({
    name: `Deletion safety ${label}`,
    slug: `deletion-safety-${label.toLowerCase()}-${suffix}`,
  }).returning({ id: organizations.id });
  if (!organization) throw new Error("organization fixture was not created");
  organizationIds.push(organization.id);

  const [actor] = await db.insert(users).values({
    email: `deletion-safety-${label.toLowerCase()}-${suffix}@example.test`,
    password: "test-password-hash",
    name: `Deletion safety ${label} actor`,
    role: "org_admin",
    organizationId: organization.id,
  }).returning({ id: users.id });
  if (!actor) throw new Error("actor fixture was not created");

  const [location] = await db.insert(locations).values({
    name: `Deletion safety ${label} location`,
    organizationId: organization.id,
  }).returning({ id: locations.id });
  if (!location) throw new Error("location fixture was not created");

  const [league] = await db.insert(leagues).values({
    name: `Deletion safety ${label} league`,
    organizationId: organization.id,
    locationId: location.id,
    seasonStart: "2034-01-01",
    seasonEnd: "2034-12-31",
    weekDay: "Sunday",
    timezone: "America/New_York",
  }).returning({ id: leagues.id });
  if (!league) throw new Error("league fixture was not created");

  const [team] = await db.insert(teams).values({
    name: `Deletion safety ${label} team`,
    leagueId: league.id,
    number: 1,
  }).returning({ id: teams.id });
  if (!team) throw new Error("team fixture was not created");

  const [bowler] = await db.insert(bowlers).values({
    name: `Deletion safety ${label} bowler`,
    organizationId: organization.id,
    active: true,
    order: 7,
  }).returning({ id: bowlers.id });
  if (!bowler) throw new Error("bowler fixture was not created");

  const [roster] = await db.insert(bowlerLeagues).values({
    bowlerId: bowler.id,
    leagueId: league.id,
    teamId: team.id,
    active: true,
    order: 3,
  }).returning({ id: bowlerLeagues.id });
  if (!roster) throw new Error("roster fixture was not created");

  return {
    organizationId: organization.id,
    actorUserId: actor.id,
    locationId: location.id,
    leagueId: league.id,
    teamId: team.id,
    bowlerId: bowler.id,
    rosterId: roster.id,
  };
}

async function command(
  f: Pick<Fixture, "organizationId" | "actorUserId" | "leagueId">,
  key: string,
  executor: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0] = db,
) {
  const [row] = await executor.insert(leagueScheduleCommands).values({
    organizationId: f.organizationId,
    leagueId: f.leagueId,
    actorUserId: f.actorUserId,
    commandType: "generate",
    idempotencyKey: `${key}-${suffix}`,
    requestFingerprint: `deletion-safety:${key}:${suffix}`,
  }).returning();
  if (!row) throw new Error(`command ${key} was not created`);
  return row;
}

async function occurrenceEvidence(f: Fixture, key: string) {
  const generateCommand = await command(f, key);
  const [run] = await db.insert(leagueOccurrenceGenerationRuns).values({
    organizationId: f.organizationId,
    leagueId: f.leagueId,
    originatingCommandId: generateCommand.id,
    generatorVersion: "deletion-safety-test",
    inputFingerprint: `input:${key}:${suffix}`,
    sourceScheduleRevision: 1,
    normalizedInputSnapshot: { test: "deletion-safety" },
    rangeStartDate: "2034-01-01",
    rangeEndDate: "2034-12-31",
    candidateOccurrenceCount: 1,
    generatedOccurrenceCount: 1,
  }).returning({ id: leagueOccurrenceGenerationRuns.id });
  if (!run) throw new Error("generation run was not created");

  const [occurrence] = await db.insert(leagueOccurrences).values({
    organizationId: f.organizationId,
    leagueId: f.leagueId,
    locationId: f.locationId,
    generationKey: `${key}-${suffix}`,
    generationRunId: run.id,
    kind: "regular",
    status: "scheduled",
    lifecycle: "draft",
    authoritativeLocalDate: "2034-03-12",
    authoritativeLocalStartTime: "19:00:00",
    timezone: "America/New_York",
    startAt: "2034-03-13T00:00:00.000Z",
    selectedUtcOffsetMinutes: -300,
    foldResolution: "unambiguous",
    resolverVersion: "deletion-safety-structural-test",
    currentRevision: 1,
    lastCommandId: generateCommand.id,
  }).returning({ id: leagueOccurrences.id });
  if (!occurrence) throw new Error("occurrence was not created");
  return { commandId: generateCommand.id, occurrenceId: occurrence.id };
}

async function expectFixtureIntact(f: Fixture): Promise<void> {
  expect((await db.select({ id: leagues.id }).from(leagues).where(eq(leagues.id, f.leagueId)))[0]?.id)
    .toBe(f.leagueId);
  expect((await db.select({ id: teams.id }).from(teams).where(eq(teams.id, f.teamId)))[0]?.id)
    .toBe(f.teamId);
  expect((await db.select({ id: bowlerLeagues.id }).from(bowlerLeagues).where(eq(bowlerLeagues.id, f.rosterId)))[0]?.id)
    .toBe(f.rosterId);
  const [bowler] = await db.select({ active: bowlers.active, order: bowlers.order })
    .from(bowlers).where(eq(bowlers.id, f.bowlerId));
  expect(bowler).toMatchObject({ active: true, order: 7 });
}

async function deferred(): Promise<{ promise: Promise<void>; resolve: () => void }> {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}

afterAll(async () => {
  for (const organizationId of organizationIds.splice(0)) {
    await deleteOrganization(organizationId).catch(() => undefined);
  }
});

describe("A1 deletion safety storage boundaries", () => {
  it("rejects retained league evidence before any roster or bowler mutation", async () => {
    const f = await fixture("Evidence");
    await occurrenceEvidence(f, "retained");

    await expect(deleteLeague(f.leagueId, f.organizationId))
      .rejects.toBeInstanceOf(LeagueOccurrenceEvidenceExistsError);
    await expectFixtureIntact(f);
  });

  it("preserves ordinary deletion behavior and returns committed affected bowler ids", async () => {
    const f = await fixture("Ordinary");

    await expect(deleteLeague(f.leagueId, f.organizationId)).resolves.toEqual([f.bowlerId]);
    expect((await db.select({ id: leagues.id }).from(leagues).where(eq(leagues.id, f.leagueId)))[0]).toBeUndefined();
    expect((await db.select({ id: teams.id }).from(teams).where(eq(teams.id, f.teamId)))[0]).toBeUndefined();
    expect((await db.select({ id: bowlerLeagues.id }).from(bowlerLeagues).where(eq(bowlerLeagues.id, f.rosterId)))[0]).toBeUndefined();
    const [bowler] = await db.select({ active: bowlers.active, order: bowlers.order })
      .from(bowlers).where(eq(bowlers.id, f.bowlerId));
    expect(bowler).toMatchObject({ active: false, order: 0 });
  });

  it("rolls back bowler, team, and roster work when the final league delete fails", async () => {
    const f = await fixture("Rollback");
    await db.execute(sql`CREATE OR REPLACE FUNCTION a1_delete_safety_failure()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'intentional deletion safety failure'; END; $$`);
    await db.execute(sql`CREATE TRIGGER a1_delete_safety_failure_trigger
      BEFORE DELETE ON leagues FOR EACH ROW
      EXECUTE FUNCTION a1_delete_safety_failure()`);
    try {
      await expect(deleteLeague(f.leagueId, f.organizationId)).rejects.toThrow();
    } finally {
      await db.execute(sql`DROP TRIGGER IF EXISTS a1_delete_safety_failure_trigger ON leagues`);
      await db.execute(sql`DROP FUNCTION IF EXISTS a1_delete_safety_failure()`);
    }
    await expectFixtureIntact(f);
  });

  it("serializes evidence retention ahead of deletion with the shared transaction lock", async () => {
    const f = await fixture("Concurrency");
    const held = await deferred();
    const acquired = await deferred();
    const evidenceTransaction = db.transaction(async (tx) => {
      await lockLeagueSchedule(tx, f.organizationId, f.leagueId);
      acquired.resolve();
      await held.promise;
      await command(f, "concurrent-evidence", tx);
    });

    await acquired.promise;
    const deletion = deleteLeague(f.leagueId, f.organizationId);
    held.resolve();
    await evidenceTransaction;
    await expect(deletion).rejects.toBeInstanceOf(LeagueOccurrenceEvidenceExistsError);
    await expectFixtureIntact(f);
  });

  it("does not let evidence from another tenant block or expose the requested league", async () => {
    const first = await fixture("TenantA");
    const second = await fixture("TenantB");
    await occurrenceEvidence(second, "other-tenant");

    await expect(deleteLeague(first.leagueId, first.organizationId)).resolves.toEqual([first.bowlerId]);
    expect((await db.select({ id: leagueOccurrences.id }).from(leagueOccurrences)
      .where(and(
        eq(leagueOccurrences.organizationId, second.organizationId),
        eq(leagueOccurrences.leagueId, second.leagueId),
      ))).length).toBe(1);
    await expect(deleteLeague(second.leagueId, first.organizationId)).rejects.toThrow(/organization/i);
    await expectFixtureIntact(second);
  });

  it("rejects location deletion when an occurrence retains the location and rolls back unlinking", async () => {
    const f = await fixture("Location");
    await occurrenceEvidence(f, "location-evidence");

    await expect(deleteLocation(f.locationId))
      .rejects.toBeInstanceOf(LocationOccurrenceEvidenceExistsError);
    const [league] = await db.select({ locationId: leagues.locationId })
      .from(leagues).where(eq(leagues.id, f.leagueId));
    expect(league?.locationId).toBe(f.locationId);
    expect((await db.select({ id: locations.id }).from(locations).where(eq(locations.id, f.locationId)))[0]?.id)
      .toBe(f.locationId);
  });
});
