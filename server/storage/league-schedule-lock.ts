import { sql } from "drizzle-orm";
import { db } from "../db.js";

export type LeagueScheduleLockExecutor =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

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
  if (!Number.isSafeInteger(leagueId) || leagueId <= 0) {
    throw new Error("leagueId must be a positive safe integer");
  }
  if (organizationId !== null && (!Number.isSafeInteger(organizationId) || organizationId <= 0)) {
    throw new Error("organizationId must be null or a positive safe integer");
  }

  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(${organizationId ?? 0}::integer, ${leagueId}::integer)
  `);
}
