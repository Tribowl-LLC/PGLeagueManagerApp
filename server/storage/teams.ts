import { eq, and, inArray, sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  teams,
  leagues,
  teamPaymentSlots,
  teamPaymentSlotRevisions,
  teamPaymentPolicies,
  teamPaymentPolicyRevisions,
  occurrencePaymentResponsibilities,
  payments,
  users,
  type Team,
  type InsertTeam,
  type UpdateTeam,
} from "@shared/schema";
import { createLogger } from '../logger';
import { lockLeagueSchedule } from './league-schedule-lock.js';

const log = createLogger("StorageTeams");

/**
 * A team is still a live scheduling row, but its financial roster and audit
 * rows are immutable evidence.  Keep those rows in place and require the
 * operator to archive the team rather than allowing PostgreSQL to surface a
 * low-level restrictive-FK error (or, worse, deleting only part of the
 * team's non-financial rows).
 */
export class TeamDeletionRequiresArchiveError extends Error {
  constructor() {
    super('Team has retained financial roster or payment history and must be archived instead');
    this.name = 'TeamDeletionRequiresArchiveError';
  }
}

/** The tenant checked by the route changed before the locked delete began. */
export class TeamOrganizationChangedError extends Error {
  constructor() {
    super('Team organization changed while acquiring its schedule lock');
    this.name = 'TeamOrganizationChangedError';
  }
}

type TeamTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Renumber one league using the transaction and schedule lock already held by
 * the caller.  The temporary negative values avoid collisions with the
 * league-number unique index while the active/inactive order is rebuilt.
 */
async function renumberActiveTeamsInTransaction(tx: TeamTransaction, leagueId: number): Promise<void> {
  const allTeams = await tx
    .select()
    .from(teams)
    .where(eq(teams.leagueId, leagueId))
    .orderBy(teams.displayOrder, teams.number)
    .for('update');

  const activeTeams = allTeams.filter((team) => team.active);
  const inactiveTeams = allTeams.filter((team) => !team.active);

  for (let i = 0; i < allTeams.length; i++) {
    await tx.update(teams).set({ number: -(i + 1) }).where(eq(teams.id, allTeams[i].id));
  }
  for (let i = 0; i < activeTeams.length; i++) {
    await tx.update(teams).set({ number: i + 1, displayOrder: i }).where(eq(teams.id, activeTeams[i].id));
  }
  for (let i = 0; i < inactiveTeams.length; i++) {
    await tx.update(teams).set({ number: activeTeams.length + i + 1, displayOrder: activeTeams.length + i }).where(eq(teams.id, inactiveTeams[i].id));
  }
}

/**
 * Return whether any retained financial roster/history row still points at
 * this team.  Initial unassigned slots are scaffolding created with a team;
 * they can be removed with the team.  An explicit vacancy, a roster change,
 * a policy, a revision, or a materialized responsibility is evidence and
 * therefore requires archive semantics.
 */
async function hasRetainedFinancialEvidence(
  tx: TeamTransaction,
  input: { organizationId: number | null; leagueId: number; teamId: number },
): Promise<boolean> {
  if (input.organizationId === null) return false;

  const result = await tx.execute(sql`
    SELECT EXISTS (
      SELECT 1
        FROM ${teamPaymentSlots}
       WHERE organization_id = ${input.organizationId}
         AND league_id = ${input.leagueId}
         AND team_id = ${input.teamId}
         AND (occupant <> 'unassigned' OR current_revision > 1)
      UNION ALL
      SELECT 1
        FROM ${teamPaymentSlotRevisions}
       WHERE organization_id = ${input.organizationId}
         AND league_id = ${input.leagueId}
         AND slot_id IN (
           SELECT id FROM ${teamPaymentSlots}
            WHERE organization_id = ${input.organizationId}
              AND league_id = ${input.leagueId}
              AND team_id = ${input.teamId}
         )
      UNION ALL
      SELECT 1
        FROM ${teamPaymentPolicies}
       WHERE organization_id = ${input.organizationId}
         AND league_id = ${input.leagueId}
         AND team_id = ${input.teamId}
      UNION ALL
      SELECT 1
        FROM ${teamPaymentPolicyRevisions}
       WHERE organization_id = ${input.organizationId}
         AND league_id = ${input.leagueId}
         AND policy_id IN (
           SELECT id FROM ${teamPaymentPolicies}
            WHERE organization_id = ${input.organizationId}
              AND league_id = ${input.leagueId}
              AND team_id = ${input.teamId}
         )
      UNION ALL
      SELECT 1
        FROM ${occurrencePaymentResponsibilities}
       WHERE organization_id = ${input.organizationId}
         AND league_id = ${input.leagueId}
         AND team_id = ${input.teamId}
      UNION ALL
      SELECT 1
        FROM ${payments} p
       WHERE p.organization_id = ${input.organizationId}
         AND p.league_id = ${input.leagueId}
         AND EXISTS (
           SELECT 1 FROM bowler_leagues bl
            WHERE bl.bowler_id = p.bowler_id
              AND bl.league_id = p.league_id
              AND bl.team_id = ${input.teamId}
         )
    ) AS has_evidence
  `);

  return result.rows[0]?.has_evidence === true;
}

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

export async function createTeam(team: InsertTeam, recordedByUserId?: number): Promise<Team> {
  return db.transaction(async (tx) => {
    const [league] = await tx.select({ organizationId: leagues.organizationId, payingLineupSize: leagues.payingLineupSize }).from(leagues).where(eq(leagues.id, team.leagueId)).limit(1);
    if (!league) throw new Error('League not found');
    if (league.organizationId !== null) await lockLeagueSchedule(tx, league.organizationId, team.leagueId);
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
    const [league] = await tx.select({ organizationId: leagues.organizationId }).from(leagues).where(eq(leagues.id, current.leagueId)).limit(1);
    if (league?.organizationId !== null && league) await lockLeagueSchedule(tx, league.organizationId, current.leagueId);
    const [result] = await tx.update(teams).set(team).where(eq(teams.id, id)).returning();
    return result;
  });
}

export async function deleteTeam(id: number, expectedOrganizationId?: number | null): Promise<void> {
  await db.transaction(async (tx) => {
    // The league schedule lock is acquired before the row lock and before
    // reading financial evidence.  Every roster/payment mutation uses this
    // same key, so deletion cannot race a roster save or materialization.
    const [scope] = await tx
      .select({ leagueId: teams.leagueId, organizationId: leagues.organizationId })
      .from(teams)
      .innerJoin(leagues, eq(leagues.id, teams.leagueId))
      .where(eq(teams.id, id))
      .limit(1);
    if (!scope) return;

    if (expectedOrganizationId !== undefined && scope.organizationId !== expectedOrganizationId) {
      throw new TeamOrganizationChangedError();
    }

    await lockLeagueSchedule(tx, scope.organizationId, scope.leagueId);

    const [current] = await tx
      .select({ id: teams.id, leagueId: teams.leagueId, organizationId: leagues.organizationId })
      .from(teams)
      .innerJoin(leagues, eq(leagues.id, teams.leagueId))
      .where(eq(teams.id, id))
      .limit(1)
      .for('update');
    if (!current) return;

    // A team move is itself guarded by the source league's schedule lock.
    // Re-check the joined row after waiting for that lock so the delete is
    // never applied using a stale tenant/league scope.
    if (current.leagueId !== scope.leagueId || current.organizationId !== scope.organizationId) {
      throw new TeamOrganizationChangedError();
    }
    if (expectedOrganizationId !== undefined && current.organizationId !== expectedOrganizationId) {
      throw new TeamOrganizationChangedError();
    }

    if (await hasRetainedFinancialEvidence(tx, {
      organizationId: current.organizationId,
      leagueId: current.leagueId,
      teamId: current.id,
    })) {
      throw new TeamDeletionRequiresArchiveError();
    }

    // Only unassigned initial slot scaffolding is removable.  All retained
    // roster/history rows were rejected above and remain untouched.
    if (current.organizationId !== null) {
      await tx.delete(teamPaymentSlots).where(and(
        eq(teamPaymentSlots.organizationId, current.organizationId),
        eq(teamPaymentSlots.leagueId, current.leagueId),
        eq(teamPaymentSlots.teamId, current.id),
      ));
    }
    await tx.delete(teams).where(eq(teams.id, id));

    // Delete and renumber are deliberately one atomic, league-locked
    // transaction.  A failure in either operation rolls the other back.
    await renumberActiveTeamsInTransaction(tx, current.leagueId);
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
  await db.transaction(async (tx) => {
    const [league] = await tx.select({ organizationId: leagues.organizationId }).from(leagues).where(eq(leagues.id, leagueId)).limit(1);
    if (!league) throw new Error('League not found');
    await lockLeagueSchedule(tx, league.organizationId, leagueId);
    await renumberActiveTeamsInTransaction(tx, leagueId);
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
