import { sql } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { NodePgTransaction } from "drizzle-orm/node-postgres/session";
import type pg from "pg";
import type * as schema from "@shared/schema";

type LeagueVaultSchema = typeof schema;
type LeagueVaultRelationalSchema = ExtractTablesWithRelations<LeagueVaultSchema>;

export type LeagueScheduleTransaction = NodePgTransaction<LeagueVaultSchema, LeagueVaultRelationalSchema>;
export type LeagueScheduleLockExecutor = NodePgDatabase<LeagueVaultSchema> | LeagueScheduleTransaction;

function assertLeagueScheduleLockScope(organizationId: number | null, leagueId: number): void {
  if (!Number.isSafeInteger(leagueId) || leagueId <= 0) {
    throw new Error("leagueId must be a positive safe integer");
  }
  if (organizationId !== null && (!Number.isSafeInteger(organizationId) || organizationId <= 0)) {
    throw new Error("organizationId must be null or a positive safe integer");
  }
}

/**
 * Acquire the same exclusive advisory-lock key at session scope before a
 * repeatable-read transaction begins. This prevents a waiter from fixing its
 * MVCC snapshot while blocked on the transaction-scoped lock. The caller must
 * release it on the same dedicated client after commit/rollback.
 */
export async function lockLeagueScheduleSession(
  client: pg.Client,
  organizationId: number | null,
  leagueId: number,
): Promise<void> {
  assertLeagueScheduleLockScope(organizationId, leagueId);
  await client.query("SELECT pg_advisory_lock($1::integer, $2::integer)", [organizationId ?? 0, leagueId]);
}

export async function unlockLeagueScheduleSession(
  client: pg.Client,
  organizationId: number | null,
  leagueId: number,
): Promise<void> {
  assertLeagueScheduleLockScope(organizationId, leagueId);
  const result = await client.query<{ unlocked: boolean }>(
    "SELECT pg_advisory_unlock($1::integer, $2::integer) AS unlocked",
    [organizationId ?? 0, leagueId],
  );
  if (result.rows[0]?.unlocked !== true) throw new Error("league schedule session lock was not held");
}

/**
 * Serialize every mutation of one tenant's canonical league schedule.
 *
 * The two-int PostgreSQL advisory-lock form keeps organizations isolated and
 * is transaction-scoped, so the lock is released automatically on commit or
 * rollback. Organization-less legacy leagues use namespace 0; tenant-owned
 * A1/A2 rows always use a positive organization id.
 */
export async function lockLeagueSchedule(
  tx: LeagueScheduleLockExecutor,
  organizationId: number | null,
  leagueId: number,
): Promise<void> {
  assertLeagueScheduleLockScope(organizationId, leagueId);

  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(${organizationId ?? 0}::integer, ${leagueId}::integer)
  `);
}
