/**
 * Database invariants installed at startup.
 *
 * These mirror schema-level guarantees that cannot be expressed in the
 * Drizzle schema (currently: a BEFORE INSERT/UPDATE trigger). Running
 * them on every server boot keeps production, development and the test
 * environment in sync — the same function is invoked from
 * `server/index.ts` (production / dev) and `tests/setup/global-setup.ts`
 * (vitest).
 *
 * All statements are idempotent so repeated boots are safe.
 *
 * Why a trigger and not a CHECK constraint
 * ----------------------------------------
 * The orphan-data system-admin tooling has to fabricate legacy
 * org-less user rows in its fixtures. CHECK constraints cannot be
 * bypassed inside a single transaction, but a trigger can be
 * temporarily disabled with `ALTER TABLE ... DISABLE TRIGGER` (which
 * only takes SHARE ROW EXCLUSIVE) — keeping the test fixture from
 * blocking every other suite while it stages the orphan rows.
 */
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  LEAGUE_SECRETARY_ORG_MATCH_FUNCTION_SQL,
  LEAGUE_SECRETARY_ORG_MATCH_STARTUP_SQL,
  USERS_ORG_CHANGE_REVOKE_SECRETARIES_STARTUP_SQL,
  USERS_ORG_CHANGE_REVOKE_SECRETARIES_FUNCTION_SQL,
  USERS_ROLE_ORG_REQUIRED_TRIGGER_SQL,
  USERS_ROLE_ORG_REQUIRED_FUNCTION_SQL,
} from '@shared/database-invariants';
import * as schema from '@shared/schema';
import { db as defaultDb } from './db';

export type AnyDb = NodePgDatabase<typeof schema>;

export async function installDbInvariants(db: AnyDb = defaultDb): Promise<void> {
  // Serialise concurrent boots against the SAME DB. Task #722's
  // deterministic per-pool test-DB naming means a recycled fork (or a
  // sibling test-app spawn under `parallel-isolated`) can boot a fresh
  // app process against a DB another boot is mid-install on. The DROP
  // TRIGGER IF EXISTS / CREATE TRIGGER pair below isn't atomic by
  // itself, so two concurrent installers can race past the DROP and
  // both attempt CREATE — yielding `trigger ... already exists`.
  //
  // We wrap the install in `db.transaction()` (Drizzle pins the
  // transaction to a single pg client) and acquire
  // `pg_advisory_xact_lock(7220001)` inside it. Transaction-scoped
  // advisory locks are bound to that pinned connection by definition,
  // and Postgres releases them automatically at COMMIT/ROLLBACK — no
  // chance of leaking a lock onto a pooled connection that goes back to
  // the pool while still holding it. CREATE FUNCTION / DROP TRIGGER /
  // CREATE TRIGGER / CREATE TABLE IF NOT EXISTS are all transactional
  // in Postgres, so the entire install is atomic per-DB.
  // Lock key derived from the function name; arbitrary but stable.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(7220001)`);

    // Retire the legacy CHECK constraint of the same name if it still
    // exists from older schema versions.
    await tx.execute(
      sql`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_org_required`,
    );

    await tx.execute(sql.raw(USERS_ROLE_ORG_REQUIRED_FUNCTION_SQL));

    await tx.execute(
      sql`DROP TRIGGER IF EXISTS users_role_org_required ON users`,
    );
    await tx.execute(sql.raw(USERS_ROLE_ORG_REQUIRED_TRIGGER_SQL));

    // Temporary rollout compatibility: rate_limit_buckets is now a normal
    // declared table in shared/schema and the active baseline. Keep this
    // idempotent fallback until every environment has adopted the baseline;
    // a follow-up can then convert startup installation to verification only.
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS rate_limit_buckets (
        key       text PRIMARY KEY,
        count     integer NOT NULL DEFAULT 0,
        reset_at  timestamptz NOT NULL
      );
    `);
    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS rate_limit_buckets_reset_at_idx
        ON rate_limit_buckets (reset_at);
    `);

    // Task #735 (League Secretary): the route layer is responsible for
    // setting `league_secretaries.organization_id` to the parent
    // league's `organization_id`, but a buggy future caller, a stale
    // copy/paste, or a direct SQL operation could quietly stamp it
    // with a different org and grant cross-tenant powers (org A's
    // secretary suddenly has admin powers on a league in org B). A
    // BEFORE INSERT/UPDATE trigger keeps the matching-org invariant
    // enforced at the DB layer regardless of which path inserted the
    // row. Idempotent install per the file-level convention.
    await tx.execute(sql.raw(LEAGUE_SECRETARY_ORG_MATCH_FUNCTION_SQL));
    // The table may not yet exist on the very first boot after a fresh
    // schema where checked-in migrations have not run. Both the DROP and the
    // CREATE reference `league_secretaries` and would error on a missing
    // relation, so guard the entire drop/create pair with an existence
    // check (DROP TRIGGER IF EXISTS still requires the table to exist).
    await tx.execute(sql.raw(LEAGUE_SECRETARY_ORG_MATCH_STARTUP_SQL));

    // Task #735 drift protection: when a user is moved to a different
    // organization (or has their org cleared), any existing
    // `league_secretaries` grants would otherwise still let the user
    // act as a secretary on their OLD org's leagues — both via the
    // matching grant.organization_id and via stale UI state. Auto-revoke
    // those grants in-transaction so the user's new org is the only
    // org they can act in. The runtime layer ALSO checks
    // `req.user.organizationId === league.organizationId` in
    // `isLeagueSecretaryFor` / `hasAdminAccessToLeague`, so this trigger
    // is defence in depth — but it is the only thing that prevents the
    // grant rows from being visible to admins of the new org via
    // `listSecretariesForLeague` (which keys on user_id).
    await tx.execute(sql.raw(USERS_ORG_CHANGE_REVOKE_SECRETARIES_FUNCTION_SQL));
    await tx.execute(sql.raw(USERS_ORG_CHANGE_REVOKE_SECRETARIES_STARTUP_SQL));
  });
}
