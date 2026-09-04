import { afterAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  leagues,
  locations,
  organizations,
  teamPaymentSlots,
  teams,
  users,
} from "@shared/schema";
import { deleteOrganization } from "../../server/storage/organizations";
import {
  deleteTeam,
  TeamDeletionRequiresArchiveError,
  TeamOrganizationChangedError,
} from "../../server/storage/teams";
import { lockLeagueSchedule } from "../../server/storage/league-schedule-lock";
import { getTestDb } from "../setup/test-db";

const db = getTestDb();
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const organizationIds: number[] = [];

interface Fixture {
  organizationId: number;
  actorUserId: number;
  leagueId: number;
  teamIds: number[];
}

async function fixture(label: string, teamCount = 3): Promise<Fixture> {
  const [organization] = await db.insert(organizations).values({
    name: `Team deletion ${label}`,
    slug: `team-deletion-${label.toLowerCase()}-${suffix}`,
  }).returning({ id: organizations.id });
  if (!organization) throw new Error("organization fixture was not created");
  organizationIds.push(organization.id);

  const [actor] = await db.insert(users).values({
    email: `team-deletion-${label.toLowerCase()}-${suffix}@example.test`,
    password: "test-password-hash",
    name: `Team deletion ${label} actor`,
    role: "org_admin",
    organizationId: organization.id,
  }).returning({ id: users.id });
  if (!actor) throw new Error("actor fixture was not created");

  const [location] = await db.insert(locations).values({
    name: `Team deletion ${label} location`,
    organizationId: organization.id,
  }).returning({ id: locations.id });
  if (!location) throw new Error("location fixture was not created");

  const [league] = await db.insert(leagues).values({
    name: `Team deletion ${label} league`,
    organizationId: organization.id,
    locationId: location.id,
    payingLineupSize: 3,
    seasonStart: "2034-01-01",
    seasonEnd: "2034-12-31",
    weekDay: "Sunday",
    timezone: "America/New_York",
  }).returning({ id: leagues.id });
  if (!league) throw new Error("league fixture was not created");

  const insertedTeams = await db.insert(teams).values(Array.from({ length: teamCount }, (_, index) => ({
    name: `Team deletion ${label} team ${index + 1}`,
    leagueId: league.id,
    number: index + 1,
    displayOrder: index,
  }))).returning({ id: teams.id });
  if (insertedTeams.length !== teamCount) throw new Error("team fixtures were not created");

  for (const team of insertedTeams) {
    await db.insert(teamPaymentSlots).values(Array.from({ length: 3 }, (_, slotIndex) => ({
      organizationId: organization.id,
      leagueId: league.id,
      teamId: team.id,
      slotIndex,
      lineupSize: 3,
      occupant: "unassigned" as const,
      recordedByUserId: actor.id,
    })));
  }

  return {
    organizationId: organization.id,
    actorUserId: actor.id,
    leagueId: league.id,
    teamIds: insertedTeams.map(({ id }) => id),
  };
}

afterAll(async () => {
  for (const organizationId of organizationIds.splice(0)) {
    await deleteOrganization(organizationId).catch(() => undefined);
  }
});

describe("team deletion safety boundaries", () => {
  it("requires archive semantics for retained financial roster evidence", async () => {
    const f = await fixture("retained", 1);
    const [slot] = await db.select({ id: teamPaymentSlots.id })
      .from(teamPaymentSlots)
      .where(and(
        eq(teamPaymentSlots.organizationId, f.organizationId),
        eq(teamPaymentSlots.leagueId, f.leagueId),
        eq(teamPaymentSlots.teamId, f.teamIds[0]),
        eq(teamPaymentSlots.slotIndex, 0),
      ));
    if (!slot) throw new Error("slot fixture was not created");

    await db.update(teamPaymentSlots).set({ occupant: "vacant", currentRevision: 2 })
      .where(eq(teamPaymentSlots.id, slot.id));

    await expect(deleteTeam(f.teamIds[0], f.organizationId))
      .rejects.toBeInstanceOf(TeamDeletionRequiresArchiveError);
    expect((await db.select({ id: teams.id }).from(teams).where(eq(teams.id, f.teamIds[0])))[0]?.id)
      .toBe(f.teamIds[0]);
    expect((await db.select({ id: teamPaymentSlots.id }).from(teamPaymentSlots).where(eq(teamPaymentSlots.id, slot.id)))[0]?.id)
      .toBe(slot.id);
  });

  it("rejects a mismatched tenant scope without deleting the team", async () => {
    const first = await fixture("tenant-a", 1);
    const second = await fixture("tenant-b", 1);

    await expect(deleteTeam(first.teamIds[0], second.organizationId))
      .rejects.toBeInstanceOf(TeamOrganizationChangedError);
    expect((await db.select({ id: teams.id }).from(teams).where(eq(teams.id, first.teamIds[0])))[0]?.id)
      .toBe(first.teamIds[0]);
  });

  it("serializes a retained roster update ahead of deletion", async () => {
    const f = await fixture("concurrent", 1);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const acquired = new Promise<void>((resolve) => { locked = resolve; });

    const rosterUpdate = db.transaction(async (tx) => {
      await lockLeagueSchedule(tx, f.organizationId, f.leagueId);
      locked();
      await held;
      await tx.update(teamPaymentSlots).set({ occupant: "vacant", currentRevision: 2 })
        .where(and(
          eq(teamPaymentSlots.organizationId, f.organizationId),
          eq(teamPaymentSlots.leagueId, f.leagueId),
          eq(teamPaymentSlots.teamId, f.teamIds[0]),
          eq(teamPaymentSlots.slotIndex, 0),
        ));
    });

    await acquired;
    const deletion = deleteTeam(f.teamIds[0], f.organizationId);
    release();
    await rosterUpdate;
    await expect(deletion).rejects.toBeInstanceOf(TeamDeletionRequiresArchiveError);
    expect((await db.select({ id: teams.id }).from(teams).where(eq(teams.id, f.teamIds[0])))[0]?.id)
      .toBe(f.teamIds[0]);
  });

  it("rolls back the team and slot cleanup if renumbering fails", async () => {
    const f = await fixture("rollback");
    await db.execute(sql`CREATE OR REPLACE FUNCTION team_delete_test_failure()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.number < 0 THEN RAISE EXCEPTION 'intentional team renumber failure'; END IF;
        RETURN NEW;
      END; $$`);
    await db.execute(sql`CREATE TRIGGER team_delete_test_failure_trigger
      BEFORE UPDATE OF number ON teams FOR EACH ROW
      EXECUTE FUNCTION team_delete_test_failure()`);
    try {
      // Drizzle wraps the PostgreSQL trigger message in its failed-query
      // error, so the rollback assertion below is the stable contract.
      await expect(deleteTeam(f.teamIds[1], f.organizationId)).rejects.toThrow();
    } finally {
      await db.execute(sql`DROP TRIGGER IF EXISTS team_delete_test_failure_trigger ON teams`);
      await db.execute(sql`DROP FUNCTION IF EXISTS team_delete_test_failure()`);
    }

    expect((await db.select({ id: teams.id }).from(teams).where(eq(teams.id, f.teamIds[1])))[0]?.id)
      .toBe(f.teamIds[1]);
    const rows = await db.select({ id: teams.id, number: teams.number, displayOrder: teams.displayOrder })
      .from(teams).where(eq(teams.leagueId, f.leagueId)).orderBy(teams.number);
    expect(rows.map(({ id, number, displayOrder }) => ({ id, number, displayOrder })))
      .toEqual(f.teamIds.map((id, index) => ({ id, number: index + 1, displayOrder: index })));
    expect((await db.select({ id: teamPaymentSlots.id }).from(teamPaymentSlots)
      .where(and(
        eq(teamPaymentSlots.organizationId, f.organizationId),
        eq(teamPaymentSlots.leagueId, f.leagueId),
        eq(teamPaymentSlots.teamId, f.teamIds[1]),
      ))).length).toBe(3);
  });

  it("deletes and renumbers active teams atomically under one league lock", async () => {
    const f = await fixture("success");
    await expect(deleteTeam(f.teamIds[1], f.organizationId)).resolves.toBeUndefined();

    expect((await db.select({ id: teams.id }).from(teams).where(eq(teams.id, f.teamIds[1])))[0]).toBeUndefined();
    const rows = await db.select({ id: teams.id, number: teams.number, displayOrder: teams.displayOrder })
      .from(teams).where(eq(teams.leagueId, f.leagueId)).orderBy(teams.number);
    expect(rows.map(({ id, number, displayOrder }) => ({ id, number, displayOrder })))
      .toEqual([
        { id: f.teamIds[0], number: 1, displayOrder: 0 },
        { id: f.teamIds[2], number: 2, displayOrder: 1 },
      ]);
    expect((await db.select({ id: teamPaymentSlots.id }).from(teamPaymentSlots)
      .where(eq(teamPaymentSlots.teamId, f.teamIds[1]))).length).toBe(0);
  });
});
