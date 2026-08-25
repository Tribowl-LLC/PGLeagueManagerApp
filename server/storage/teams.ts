import { eq, and, inArray } from "drizzle-orm";
import { db } from "../db.js";
import { teams, leagues, type Team, type InsertTeam, type UpdateTeam } from "@shared/schema";
import { createLogger } from '../logger';
import { lockLeagueSchedule } from './league-schedule-lock.js';

const log = createLogger("StorageTeams");

export async function getTeams(leagueId?: number): Promise<Team[]> {
  const query = db.select().from(teams);
  if (leagueId !== undefined) {
    return query.where(eq(teams.leagueId, leagueId)).orderBy(teams.displayOrder, teams.number);
  }
  return query.orderBy(teams.displayOrder, teams.number);
}

export async function getTeam(id: number): Promise<Team | undefined> {
  const [result] = await db.select().from(teams).where(eq(teams.id, id));
  return result;
}

export async function createTeam(team: InsertTeam): Promise<Team> {
  return db.transaction(async (tx) => {
    const [league] = await tx.select({ organizationId: leagues.organizationId }).from(leagues).where(eq(leagues.id, team.leagueId)).limit(1);
    if (!league) throw new Error('League not found');
    if (league.organizationId !== null) await lockLeagueSchedule(tx, league.organizationId, team.leagueId);
    const [result] = await tx.insert(teams).values(team).returning();
    return result;
  });
}

export async function updateTeam(id: number, team: UpdateTeam): Promise<Team> {
  return db.transaction(async (tx) => {
    const [current] = await tx.select({ leagueId: teams.leagueId }).from(teams).where(eq(teams.id, id)).limit(1);
    if (!current) throw new Error('Team not found');
    const [league] = await tx.select({ organizationId: leagues.organizationId }).from(leagues).where(eq(leagues.id, current.leagueId)).limit(1);
    if (league?.organizationId !== null && league) await lockLeagueSchedule(tx, league.organizationId, current.leagueId);
    const [result] = await tx.update(teams).set(team).where(eq(teams.id, id)).returning();
    return result;
  });
}

export async function deleteTeam(id: number): Promise<void> {
  await db.transaction(async (tx) => {
    const [current] = await tx.select({ leagueId: teams.leagueId }).from(teams).where(eq(teams.id, id)).limit(1);
    if (!current) return;
    const [league] = await tx.select({ organizationId: leagues.organizationId }).from(leagues).where(eq(leagues.id, current.leagueId)).limit(1);
    if (league?.organizationId !== null && league) await lockLeagueSchedule(tx, league.organizationId, current.leagueId);
    await tx.delete(teams).where(eq(teams.id, id));
  });
}

export async function getTeamByNumber(leagueId: number, teamNumber: number): Promise<Team | undefined> {
  const [result] = await db
    .select()
    .from(teams)
    .where(and(
      eq(teams.leagueId, leagueId),
      eq(teams.number, teamNumber)
    ));
  return result;
}

export async function getTeamsByIds(ids: number[]): Promise<Team[]> {
  if (ids.length === 0) return [];
  return db.select().from(teams).where(inArray(teams.id, ids));
}

export async function renumberActiveTeams(leagueId: number): Promise<void> {
  const allTeams = await db.select().from(teams)
    .where(eq(teams.leagueId, leagueId))
    .orderBy(teams.displayOrder, teams.number);

  const activeTeams = allTeams.filter(t => t.active);
  const inactiveTeams = allTeams.filter(t => !t.active);

  await db.transaction(async (tx) => {
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
    for (let i = 0; i < updates.length; i++) {
      await tx.update(teams).set({ number: -(i + 1) }).where(eq(teams.id, updates[i].id));
    }
    for (const { id, displayOrder, number: teamNumber } of updates) {
      await tx.update(teams).set({ displayOrder, number: teamNumber }).where(eq(teams.id, id));
    }
  });
}
