import { eq, and, inArray, sql } from "drizzle-orm";
import { db } from "../db.js";
import { teams, leagues, teamPaymentSlots, users, type Team, type InsertTeam, type UpdateTeam } from "@shared/schema";
import { createLogger } from '../logger';
import { lockLeagueSchedule } from './league-schedule-lock.js';

const log = createLogger("StorageTeams");

export async function getTeams(leagueId?: number): Promise<Team[]> {
  const query = db.select().from(teams);
  const canonicalLeague = sql`EXISTS (SELECT 1 FROM leagues authority_league WHERE authority_league.id = ${teams.leagueId} AND authority_league.schedule_authority = 'canonical')`;
  if (leagueId !== undefined) {
    return query.where(and(eq(teams.leagueId, leagueId), canonicalLeague)).orderBy(teams.displayOrder, teams.number);
  }
  return query.where(canonicalLeague).orderBy(teams.displayOrder, teams.number);
}

export async function getTeam(id: number): Promise<Team | undefined> {
  const [result] = await db.select().from(teams).where(and(eq(teams.id, id), sql`EXISTS (SELECT 1 FROM leagues authority_league WHERE authority_league.id = ${teams.leagueId} AND authority_league.schedule_authority = 'canonical')`));
  return result;
}

export async function createTeam(team: InsertTeam, recordedByUserId?: number): Promise<Team> {
  return db.transaction(async (tx) => {
    const [scope] = await tx.select({ organizationId: leagues.organizationId }).from(leagues).where(eq(leagues.id, team.leagueId)).limit(1);
    if (!scope) throw new Error('League not found');
    await lockLeagueSchedule(tx, scope.organizationId, team.leagueId);
    const [league] = await tx.select({ organizationId: leagues.organizationId, payingLineupSize: leagues.payingLineupSize, active: leagues.active, scheduleAuthority: leagues.scheduleAuthority }).from(leagues).where(eq(leagues.id, team.leagueId)).limit(1).for('share');
    if (!league || league.organizationId !== scope.organizationId) throw new Error('League scope changed while waiting for schedule lock');
    if (!league.active || league.scheduleAuthority !== "canonical") throw new Error('League is a read-only archive');
    const [result] = await tx.insert(teams).values(team).returning();
    if (result && league.organizationId !== null && league.payingLineupSize !== null) {
      const actor = recordedByUserId ?? (await tx.select({ id: users.id }).from(users).where(and(
        eq(users.organizationId, league.organizationId),
        eq(users.role, "org_admin"),
      )).orderBy(users.id).limit(1))[0]?.id;
      if (actor !== undefined) {
        await tx.insert(teamPaymentSlots).values(Array.from({ length: league.payingLineupSize }, (_, slotIndex) => ({
          organizationId: league.organizationId as number,
          leagueId: team.leagueId,
          teamId: result.id,
          slotIndex,
          lineupSize: league.payingLineupSize as number,
          occupant: "unassigned" as const,
          mainBowlerId: null,
          recordedByUserId: actor,
        })));
      }
    }
    return result;
  });
}

export async function updateTeam(id: number, team: UpdateTeam): Promise<Team> {
  return db.transaction(async (tx) => {
    const [current] = await tx.select({ leagueId: teams.leagueId }).from(teams).where(eq(teams.id, id)).limit(1);
    if (!current) throw new Error('Team not found');
    const [scope] = await tx.select({ organizationId: leagues.organizationId }).from(leagues).where(eq(leagues.id, current.leagueId)).limit(1);
    if (!scope) throw new Error('League not found');
    await lockLeagueSchedule(tx, scope.organizationId, current.leagueId);
    const [league] = await tx.select({ organizationId: leagues.organizationId, active: leagues.active, scheduleAuthority: leagues.scheduleAuthority }).from(leagues).where(eq(leagues.id, current.leagueId)).limit(1).for('share');
    if (!league || !league.active || league.scheduleAuthority !== "canonical") throw new Error('League is a read-only archive');
    const [result] = await tx.update(teams).set(team).where(eq(teams.id, id)).returning();
    return result;
  });
}

export async function deleteTeam(id: number): Promise<void> {
  await db.transaction(async (tx) => {
    const [current] = await tx.select({ leagueId: teams.leagueId }).from(teams).where(eq(teams.id, id)).limit(1);
    if (!current) return;
    const [scope] = await tx.select({ organizationId: leagues.organizationId }).from(leagues).where(eq(leagues.id, current.leagueId)).limit(1);
    if (!scope) throw new Error('League not found');
    await lockLeagueSchedule(tx, scope.organizationId, current.leagueId);
    const [league] = await tx.select({ organizationId: leagues.organizationId, active: leagues.active, scheduleAuthority: leagues.scheduleAuthority }).from(leagues).where(eq(leagues.id, current.leagueId)).limit(1).for('share');
    if (!league || !league.active || league.scheduleAuthority !== "canonical") throw new Error('League is a read-only archive');
    await tx.delete(teams).where(eq(teams.id, id));
  });
}

export async function getTeamByNumber(leagueId: number, teamNumber: number): Promise<Team | undefined> {
  const [result] = await db
    .select()
    .from(teams)
    .where(and(
      eq(teams.leagueId, leagueId),
      eq(teams.number, teamNumber),
      sql`EXISTS (SELECT 1 FROM leagues authority_league WHERE authority_league.id = ${teams.leagueId} AND authority_league.schedule_authority = 'canonical')`,
    ));
  return result;
}

export async function getTeamsByIds(ids: number[]): Promise<Team[]> {
  if (ids.length === 0) return [];
  return db.select().from(teams).where(and(inArray(teams.id, ids), sql`EXISTS (SELECT 1 FROM leagues authority_league WHERE authority_league.id = ${teams.leagueId} AND authority_league.schedule_authority = 'canonical')`));
}

export async function renumberActiveTeams(leagueId: number): Promise<void> {
  await db.transaction(async (tx) => {
    const [scope] = await tx.select({ organizationId: leagues.organizationId, active: leagues.active, scheduleAuthority: leagues.scheduleAuthority }).from(leagues).where(eq(leagues.id, leagueId)).limit(1).for('share');
    if (!scope) throw new Error('League not found');
    await lockLeagueSchedule(tx, scope.organizationId, leagueId);
    const [league] = await tx.select({ active: leagues.active, scheduleAuthority: leagues.scheduleAuthority }).from(leagues).where(eq(leagues.id, leagueId)).limit(1).for('share');
    if (!league || !league.active || league.scheduleAuthority !== 'canonical') throw new Error('League is a read-only archive');
    const allTeams = await tx.select().from(teams).where(eq(teams.leagueId, leagueId)).orderBy(teams.displayOrder, teams.number);
    const activeTeams = allTeams.filter(t => t.active);
    const inactiveTeams = allTeams.filter(t => !t.active);
    for (let i = 0; i < allTeams.length; i++) {
      await tx.update(teams).set({ number: -(i + 1) }).where(eq(teams.id, allTeams[i].id));
    }
    for (let i = 0; i < activeTeams.length; i++) {
      await tx.update(teams).set({ number: i + 1, displayOrder: i }).where(eq(teams.id, activeTeams[i].id));
    }
    for (let i = 0; i < inactiveTeams.length; i++) {
      await tx.update(teams).set({ number: activeTeams.length + i + 1, displayOrder: activeTeams.length + i }).where(eq(teams.id, inactiveTeams[i].id));
    }
  });
}

export async function reorderTeams(updates: { id: number; displayOrder: number; number: number }[]): Promise<void> {
  await db.transaction(async (tx) => {
    if (updates.length === 0) return;
    const rows = await tx.select({ id: teams.id, leagueId: teams.leagueId }).from(teams).where(inArray(teams.id, updates.map((update) => update.id)));
    const leagueId = rows[0]?.leagueId;
    if (!leagueId || rows.length !== updates.length || rows.some((row) => row.leagueId !== leagueId)) throw new Error('Teams must belong to one league');
    const [scope] = await tx.select({ organizationId: leagues.organizationId }).from(leagues).where(eq(leagues.id, leagueId)).limit(1);
    if (!scope) throw new Error('League not found');
    await lockLeagueSchedule(tx, scope.organizationId, leagueId);
    const [league] = await tx.select({ active: leagues.active, scheduleAuthority: leagues.scheduleAuthority }).from(leagues).where(eq(leagues.id, leagueId)).limit(1).for('share');
    if (!league || !league.active || league.scheduleAuthority !== 'canonical') throw new Error('League is a read-only archive');
    const lockedRows = await tx.select({ id: teams.id }).from(teams).where(inArray(teams.id, updates.map((update) => update.id))).for('update');
    if (lockedRows.length !== updates.length) throw new Error('Teams changed while waiting for schedule lock');
    for (let i = 0; i < updates.length; i++) {
      await tx.update(teams).set({ number: -(i + 1) }).where(eq(teams.id, updates[i].id));
    }
    for (const { id, displayOrder, number: teamNumber } of updates) {
      await tx.update(teams).set({ displayOrder, number: teamNumber }).where(eq(teams.id, id));
    }
  });
}
