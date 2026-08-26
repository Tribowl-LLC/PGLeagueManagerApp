import { sql, isNull, ne, and, eq, desc } from "drizzle-orm";
import { db } from "../db.js";
import {
  leagues,
  teams,
  bowlerLeagues,
  payments,
  users,
  bowlers,
  organizations,
  orphanCleanupAudits,
  type InsertOrphanCleanupAudit,
  type OrphanCleanupAudit,
} from "@shared/schema";

// A query executor — either the top-level `db` client or a transaction handle
// passed by `db.transaction(...)`. Each repair helper accepts one so the route
// layer can wrap repair + audit insert in a single transaction (so a cleanup
// can never succeed without a corresponding audit row, and vice versa).
export type DbExecutor =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface OrphanedDataCounts {
  leagues: number;
  teams: number;
  bowlerLeagues: number;
  payments: number;
  users: number;
}

export type OrphanedResourceType =
  | "leagues"
  | "teams"
  | "bowlerLeagues"
  | "payments"
  | "users";

export interface OrphanedLeagueRow {
  id: number;
  name: string;
  active: boolean;
  seasonStart: string;
  seasonEnd: string;
}

export interface OrphanedTeamRow {
  id: number;
  name: string;
  number: number;
  leagueId: number;
  leagueName: string | null;
  leagueOrganizationId: number | null;
  parentLeagueExists: boolean;
}

export interface OrphanedBowlerLeagueRow {
  id: number;
  bowlerId: number;
  bowlerName: string | null;
  leagueId: number;
  leagueName: string | null;
  parentLeagueExists: boolean;
}

export interface OrphanedPaymentRow {
  id: number;
  amount: number;
  createdAt: string;
  bowlerId: number;
  bowlerName: string | null;
  leagueId: number;
  leagueName: string | null;
  parentLeagueExists: boolean;
}

export interface OrphanedUserRow {
  id: number;
  name: string;
  email: string;
  role: string;
  createdAt: string;
}

/**
 * Count rows whose effective `organizationId` is NULL. Resources without a
 * direct `organizationId` column (teams, bowler_leagues, payments) inherit
 * the org of their parent league, so they are counted by joining to leagues
 * where `leagues.organization_id IS NULL` OR the parent league is missing.
 *
 * Users are counted as orphaned when they are NOT a `system_admin` (system
 * admins legitimately have no organization) and `organization_id IS NULL`.
 */
export async function countOrphanedRows(): Promise<OrphanedDataCounts> {
  const orphanLeaguesQ = db
    .select({ value: sql<number>`count(*)::int` })
    .from(leagues)
    .where(isNull(leagues.organizationId));

  const orphanTeamsQ = db
    .select({ value: sql<number>`count(*)::int` })
    .from(teams)
    .leftJoin(leagues, sql`${teams.leagueId} = ${leagues.id}`)
    .where(sql`${leagues.id} IS NULL OR ${leagues.organizationId} IS NULL`);

  const orphanBowlerLeaguesQ = db
    .select({ value: sql<number>`count(*)::int` })
    .from(bowlerLeagues)
    .leftJoin(leagues, sql`${bowlerLeagues.leagueId} = ${leagues.id}`)
    .where(sql`${leagues.id} IS NULL OR ${leagues.organizationId} IS NULL`);

  const orphanPaymentsQ = db
    .select({ value: sql<number>`count(*)::int` })
    .from(payments)
    .leftJoin(leagues, sql`${payments.leagueId} = ${leagues.id}`)
    .where(sql`${leagues.id} IS NULL OR ${leagues.organizationId} IS NULL`);

  const orphanUsersQ = db
    .select({ value: sql<number>`count(*)::int` })
    .from(users)
    .where(and(isNull(users.organizationId), ne(users.role, 'system_admin')));

  const [
    [leagueRow],
    [teamRow],
    [blRow],
    [payRow],
    [userRow],
  ] = await Promise.all([
    orphanLeaguesQ,
    orphanTeamsQ,
    orphanBowlerLeaguesQ,
    orphanPaymentsQ,
    orphanUsersQ,
  ]);

  return {
    leagues: Number(leagueRow?.value ?? 0),
    teams: Number(teamRow?.value ?? 0),
    bowlerLeagues: Number(blRow?.value ?? 0),
    payments: Number(payRow?.value ?? 0),
    users: Number(userRow?.value ?? 0),
  };
}

// ---------------------------------------------------------------------------
// List helpers — return the actual rows that are org-less so admins can see
// which records are affected and act on them. Mirrors the same "orphaned" rule
// used by countOrphanedRows so what the UI lists is exactly what gets counted.
// ---------------------------------------------------------------------------

export async function listOrphanedLeagues(): Promise<OrphanedLeagueRow[]> {
  const rows = await db
    .select({
      id: leagues.id,
      name: leagues.name,
      active: leagues.active,
      seasonStart: leagues.seasonStart,
      seasonEnd: leagues.seasonEnd,
    })
    .from(leagues)
    .where(isNull(leagues.organizationId))
    .orderBy(leagues.id);
  return rows;
}

export async function listOrphanedTeams(): Promise<OrphanedTeamRow[]> {
  const rows = await db
    .select({
      id: teams.id,
      name: teams.name,
      number: teams.number,
      leagueId: teams.leagueId,
      leagueName: leagues.name,
      leagueOrganizationId: leagues.organizationId,
      parentLeagueId: leagues.id,
    })
    .from(teams)
    .leftJoin(leagues, sql`${teams.leagueId} = ${leagues.id}`)
    .where(sql`${leagues.id} IS NULL OR ${leagues.organizationId} IS NULL`)
    .orderBy(teams.id);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    number: r.number,
    leagueId: r.leagueId,
    leagueName: r.leagueName,
    leagueOrganizationId: r.leagueOrganizationId,
    parentLeagueExists: r.parentLeagueId !== null,
  }));
}

export async function listOrphanedBowlerLeagues(): Promise<OrphanedBowlerLeagueRow[]> {
  const rows = await db
    .select({
      id: bowlerLeagues.id,
      bowlerId: bowlerLeagues.bowlerId,
      bowlerName: bowlers.name,
      leagueId: bowlerLeagues.leagueId,
      leagueName: leagues.name,
      parentLeagueId: leagues.id,
    })
    .from(bowlerLeagues)
    .leftJoin(leagues, sql`${bowlerLeagues.leagueId} = ${leagues.id}`)
    .leftJoin(bowlers, sql`${bowlerLeagues.bowlerId} = ${bowlers.id}`)
    .where(sql`${leagues.id} IS NULL OR ${leagues.organizationId} IS NULL`)
    .orderBy(bowlerLeagues.id);
  return rows.map((r) => ({
    id: r.id,
    bowlerId: r.bowlerId,
    bowlerName: r.bowlerName,
    leagueId: r.leagueId,
    leagueName: r.leagueName,
    parentLeagueExists: r.parentLeagueId !== null,
  }));
}

export async function listOrphanedPayments(): Promise<OrphanedPaymentRow[]> {
  const rows = await db
    .select({
      id: payments.id,
      amount: payments.amount,
      createdAt: payments.createdAt,
      bowlerId: payments.bowlerId,
      bowlerName: bowlers.name,
      leagueId: payments.leagueId,
      leagueName: leagues.name,
      parentLeagueId: leagues.id,
    })
    .from(payments)
    .leftJoin(leagues, sql`${payments.leagueId} = ${leagues.id}`)
    .leftJoin(bowlers, sql`${payments.bowlerId} = ${bowlers.id}`)
    .where(sql`${leagues.id} IS NULL OR ${leagues.organizationId} IS NULL`)
    .orderBy(payments.id);
  return rows.map((r) => ({
    id: r.id,
    amount: r.amount,
    createdAt: r.createdAt,
    bowlerId: r.bowlerId,
    bowlerName: r.bowlerName,
    leagueId: r.leagueId,
    leagueName: r.leagueName,
    parentLeagueExists: r.parentLeagueId !== null,
  }));
}

export async function listOrphanedUsers(): Promise<OrphanedUserRow[]> {
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(and(isNull(users.organizationId), ne(users.role, 'system_admin')))
    .orderBy(users.id);
  return rows;
}

// ---------------------------------------------------------------------------
// Repair helpers — explicit "orphaned data" handlers. Each one re-verifies the
// row is actually org-less before acting, so the regular access-control rule
// ("deny on null, even for system admins") is never bypassed for non-orphans.
//
// Every helper accepts an optional `DbExecutor` so the route layer can run the
// repair and the audit-log insert inside a single `db.transaction(...)`. If
// the audit insert fails the whole repair is rolled back, so the audit table
// is the authoritative record of what was changed.
// ---------------------------------------------------------------------------

export class NotOrphanedError extends Error {
  constructor(message = "Row is not orphaned") {
    super(message);
    this.name = "NotOrphanedError";
  }
}

export class OrphanRowNotFoundError extends Error {
  constructor(message = "Orphaned row not found") {
    super(message);
    this.name = "OrphanRowNotFoundError";
  }
}

async function assertOrgExists(executor: DbExecutor, organizationId: number): Promise<void> {
  const [row] = await executor
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  if (!row) {
    throw new OrphanRowNotFoundError(`Organization ${organizationId} not found`);
  }
}

// Reassign helpers return the previous organizationId so the route layer can
// record it in the audit row. For an orphan that's always null today, but
// recording it explicitly means the undo path restores the prior state
// instead of guessing.
export interface ReassignResult {
  previousOrganizationId: number | null;
}

export async function reassignOrphanedLeague(
  leagueId: number,
  organizationId: number,
  executor: DbExecutor = db,
): Promise<ReassignResult> {
  await assertOrgExists(executor, organizationId);
  const result = await executor
    .update(leagues)
    .set({ organizationId })
    .where(and(eq(leagues.id, leagueId), isNull(leagues.organizationId)))
    .returning({ id: leagues.id });
  if (result.length === 0) {
    const [existing] = await executor
      .select({ id: leagues.id })
      .from(leagues)
      .where(eq(leagues.id, leagueId));
    if (!existing) throw new OrphanRowNotFoundError();
    throw new NotOrphanedError();
  }
  return { previousOrganizationId: null };
}

export async function reassignOrphanedUser(
  userId: number,
  organizationId: number,
  executor: DbExecutor = db,
): Promise<ReassignResult> {
  await assertOrgExists(executor, organizationId);
  const result = await executor
    .update(users)
    .set({ organizationId })
    .where(and(
      eq(users.id, userId),
      isNull(users.organizationId),
      ne(users.role, 'system_admin'),
    ))
    .returning({ id: users.id });
  if (result.length === 0) {
    const [existing] = await executor
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId));
    if (!existing) throw new OrphanRowNotFoundError();
    throw new NotOrphanedError();
  }
  return { previousOrganizationId: null };
}

// ---------------------------------------------------------------------------
// Undo helpers — invert a previous reassign by setting the row back to the
// org it came from (which is `null` for orphans). Each helper takes the
// `expectedOrganizationId` recorded in the audit row so we only undo when
// the row is still in that org. If something else moved it in the meantime
// we throw `RowChangedSinceAuditError` and the route layer reports a 409.
// ---------------------------------------------------------------------------

export class RowChangedSinceAuditError extends Error {
  constructor(message = "Row has changed since the audit was recorded") {
    super(message);
    this.name = "RowChangedSinceAuditError";
  }
}

export async function undoReassignLeague(
  leagueId: number,
  expectedOrganizationId: number,
  previousOrganizationId: number | null,
  executor: DbExecutor = db,
): Promise<void> {
  const result = await executor
    .update(leagues)
    .set({ organizationId: previousOrganizationId as unknown as number })
    .where(and(eq(leagues.id, leagueId), eq(leagues.organizationId, expectedOrganizationId)))
    .returning({ id: leagues.id });
  if (result.length === 0) {
    const [existing] = await executor
      .select({ id: leagues.id })
      .from(leagues)
      .where(eq(leagues.id, leagueId));
    if (!existing) throw new OrphanRowNotFoundError();
    throw new RowChangedSinceAuditError();
  }
}

export async function undoReassignUser(
  userId: number,
  expectedOrganizationId: number,
  previousOrganizationId: number | null,
  executor: DbExecutor = db,
): Promise<void> {
  const result = await executor
    .update(users)
    .set({ organizationId: previousOrganizationId })
    .where(and(eq(users.id, userId), eq(users.organizationId, expectedOrganizationId)))
    .returning({ id: users.id });
  if (result.length === 0) {
    const [existing] = await executor
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId));
    if (!existing) throw new OrphanRowNotFoundError();
    throw new RowChangedSinceAuditError();
  }
}

// Delete helpers return a JSON-friendly snapshot of the row that was deleted
// so the audit log can store it. Admins can use the snapshot to reconstruct
// the row by hand if a delete turns out to be wrong (auto-restore is unsafe
// because foreign-key targets may already be gone).
export type OrphanSnapshot = Record<string, unknown>;

function toSnapshot(row: Record<string, unknown>): OrphanSnapshot {
  // Drizzle returns Date / Decimal-like values; serialise via JSON to keep the
  // audit row independent of those types (timestamps as ISO strings, etc.).
  return JSON.parse(JSON.stringify(row));
}

export async function deleteOrphanedLeague(
  leagueId: number,
  executor: DbExecutor = db,
): Promise<OrphanSnapshot> {
  const result = await executor
    .delete(leagues)
    .where(and(eq(leagues.id, leagueId), isNull(leagues.organizationId)))
    .returning();
  if (result.length === 0) {
    const [existing] = await executor
      .select({ id: leagues.id })
      .from(leagues)
      .where(eq(leagues.id, leagueId));
    if (!existing) throw new OrphanRowNotFoundError();
    throw new NotOrphanedError();
  }
  return toSnapshot(result[0] as Record<string, unknown>);
}

export async function deleteOrphanedTeam(
  teamId: number,
  executor: DbExecutor = db,
): Promise<OrphanSnapshot> {
  const [row] = await executor
    .select({
      team: teams,
      parentLeagueId: leagues.id,
      parentOrgId: leagues.organizationId,
    })
    .from(teams)
    .leftJoin(leagues, sql`${teams.leagueId} = ${leagues.id}`)
    .where(eq(teams.id, teamId));
  if (!row) throw new OrphanRowNotFoundError();
  const isOrphan = row.parentLeagueId === null || row.parentOrgId === null;
  if (!isOrphan) throw new NotOrphanedError();
  await executor.delete(teams).where(eq(teams.id, teamId));
  return toSnapshot(row.team as Record<string, unknown>);
}

export async function deleteOrphanedBowlerLeague(
  id: number,
  executor: DbExecutor = db,
): Promise<OrphanSnapshot> {
  const [row] = await executor
    .select({
      bl: bowlerLeagues,
      parentLeagueId: leagues.id,
      parentOrgId: leagues.organizationId,
    })
    .from(bowlerLeagues)
    .leftJoin(leagues, sql`${bowlerLeagues.leagueId} = ${leagues.id}`)
    .where(eq(bowlerLeagues.id, id));
  if (!row) throw new OrphanRowNotFoundError();
  const isOrphan = row.parentLeagueId === null || row.parentOrgId === null;
  if (!isOrphan) throw new NotOrphanedError();
  await executor.delete(bowlerLeagues).where(eq(bowlerLeagues.id, id));
  return toSnapshot(row.bl as Record<string, unknown>);
}

export async function deleteOrphanedPayment(
  id: number,
  executor: DbExecutor = db,
): Promise<OrphanSnapshot> {
  const [row] = await executor
    .select({
      payment: payments,
      parentLeagueId: leagues.id,
      parentOrgId: leagues.organizationId,
    })
    .from(payments)
    .leftJoin(leagues, sql`${payments.leagueId} = ${leagues.id}`)
    .where(eq(payments.id, id));
  if (!row) throw new OrphanRowNotFoundError();
  const isOrphan = row.parentLeagueId === null || row.parentOrgId === null;
  if (!isOrphan) throw new NotOrphanedError();
  await executor.delete(payments).where(eq(payments.id, id));
  return toSnapshot(row.payment as Record<string, unknown>);
}

export async function deleteOrphanedUser(
  userId: number,
  executor: DbExecutor = db,
): Promise<OrphanSnapshot> {
  const result = await executor
    .delete(users)
    .where(and(
      eq(users.id, userId),
      isNull(users.organizationId),
      ne(users.role, 'system_admin'),
    ))
    .returning();
  if (result.length === 0) {
    const [existing] = await executor
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId));
    if (!existing) throw new OrphanRowNotFoundError();
    throw new NotOrphanedError();
  }
  // Strip the password hash from the audit snapshot — it has no business
  // sitting in the audit log even though the user row is gone.
  const snap = toSnapshot(result[0] as Record<string, unknown>);
  if ('password' in snap) delete snap.password;
  return snap;
}

// ---------------------------------------------------------------------------
// Audit log — every reassign/delete the admin performs is recorded here so the
// action can be reviewed later. The route layer wraps the repair helper above
// and `recordOrphanCleanupAudit` in a single transaction, so a failed audit
// insert rolls the cleanup back. We only want successful operations recorded.
// ---------------------------------------------------------------------------

export interface CleanupAuditRow extends OrphanCleanupAudit {
  adminUserName: string | null;
  adminUserEmail: string | null;
  organizationName: string | null;
}

export async function recordOrphanCleanupAudit(
  entry: InsertOrphanCleanupAudit,
  executor: DbExecutor = db,
): Promise<OrphanCleanupAudit> {
  const [row] = await executor.insert(orphanCleanupAudits).values(entry).returning();
  return row;
}

export async function getOrphanCleanupAuditById(
  id: number,
  executor: DbExecutor = db,
): Promise<OrphanCleanupAudit | null> {
  const [row] = await executor
    .select()
    .from(orphanCleanupAudits)
    .where(eq(orphanCleanupAudits.id, id));
  return row ?? null;
}

export async function markOrphanCleanupAuditUndone(
  id: number,
  undoneByAuditId: number,
  executor: DbExecutor = db,
): Promise<void> {
  await executor
    .update(orphanCleanupAudits)
    .set({ undoneAt: new Date().toISOString(), undoneByAuditId })
    .where(eq(orphanCleanupAudits.id, id));
}

export async function listOrphanCleanupAudits(limit = 50): Promise<CleanupAuditRow[]> {
  const rows = await db
    .select({
      id: orphanCleanupAudits.id,
      adminUserId: orphanCleanupAudits.adminUserId,
      resourceType: orphanCleanupAudits.resourceType,
      resourceId: orphanCleanupAudits.resourceId,
      action: orphanCleanupAudits.action,
      organizationId: orphanCleanupAudits.organizationId,
      previousOrganizationId: orphanCleanupAudits.previousOrganizationId,
      snapshot: orphanCleanupAudits.snapshot,
      undoneAt: orphanCleanupAudits.undoneAt,
      undoneByAuditId: orphanCleanupAudits.undoneByAuditId,
      createdAt: orphanCleanupAudits.createdAt,
      adminUserName: users.name,
      adminUserEmail: users.email,
      organizationName: organizations.name,
    })
    .from(orphanCleanupAudits)
    .leftJoin(users, eq(orphanCleanupAudits.adminUserId, users.id))
    .leftJoin(organizations, eq(orphanCleanupAudits.organizationId, organizations.id))
    .orderBy(desc(orphanCleanupAudits.createdAt), desc(orphanCleanupAudits.id))
    .limit(Math.max(1, Math.min(limit, 200)));
  return rows;
}
