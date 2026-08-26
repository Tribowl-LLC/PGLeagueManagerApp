/**
 * One-shot cleanup for rows leaked by `tests/api/orphaned-data-audits.test.ts`
 * before #608 hardened that suite's `afterAll` cleanup (Task #616).
 *
 * For weeks every run of that suite silently inserted:
 *   - `vitest-audit-orphan-reassign-*` / `vitest-audit-orphan-delete-*` /
 *     `vitest-audit-nonorphan-*` users
 *   - `Vitest Audit %` named leagues (some org-less, some org-attached)
 *   - `Vitest Audit %` named teams + bowlers
 *   - `bowler_leagues` and `payments` rows hung off those leagues
 *   - `orphan_cleanup_audits` rows written by every reassign/delete the
 *     suite exercised
 * into the shared dev database. #608 stopped the bleed but was scoped
 * out of any backfill — this script is that backfill.
 *
 * Selection criteria are intentionally narrow and intersection-style so
 * a real customer row cannot be hit by accident:
 *   - leagues: name LIKE 'Vitest Audit %'  (and NOT in PROTECTED_LEAGUE_NAMES)
 *   - teams:   name LIKE 'Vitest Audit %'
 *   - bowlers: name LIKE 'Vitest Audit %'
 *   - users:   email LIKE 'vitest-audit-%'
 *   - orphan_cleanup_audits: admin_user_id IS the seeded test admin
 *     (resolved by email = 'admin@example.com' AND name LIKE 'Vitest %'
 *      AND role = 'system_admin'); defense-in-depth additional sweep by
 *     resource_type+resource_id of any doomed Vitest Audit resource.
 *   - dependent payments / bowler_leagues / scores
 *     of doomed leagues / bowlers cascade automatically (FK ON DELETE
 *     CASCADE on `bowler_leagues.league_id`, `payments.league_id`,
 *     `payments.bowler_id`, `teams.league_id`, etc — see
 *     `shared/schema/{teams,bowlers,payments,games}.ts`).
 *
 * Preserved (hard-list, never touched):
 *   - `vitest-org-a` / `vitest-org-b` orgs and ALL of their users.
 *   - `Vitest Org A Baseline League` / `Vitest Org B Baseline League`,
 *     the deterministic per-baseline-org leagues that the refactored
 *     suite re-uses across runs (mirrors PROTECTED_SLUGS in
 *     `scripts/cleanup-test-organizations.ts`).
 *
 * Out of scope (intentionally not touched by this script):
 *   - Other `Vitest %` named leagues / teams / bowlers from unrelated
 *     suites (`Vitest League <ts>-<rand>`, `vitest-pnce-*`,
 *     `Vitest DoubleLink *`, etc). Those are a different leak class
 *     and Task #615 tracks the systemic fix; the next cleanup pass
 *     can run a sibling script if that becomes load-bearing.
 *
 * Safety (mirrors `scripts/cleanup-test-organizations.ts` Task #607/#609):
 *   - Refuses to run in a production-shaped runtime unless
 *     ALLOW_TEST_CLEANUP=1 is also passed.
 *   - Independently calls `assertSafeDatabaseHost` so a wrong NODE_ENV
 *     pointing at the live Neon endpoint still refuses to delete.
 *   - Wraps all deletes in a single transaction; failure rolls back.
 *   - `--dry-run` previews and exits without touching the DB.
 *   - Default (non-dry-run) mode also requires ALLOW_TEST_CLEANUP=1.
 *
 * Usage:
 *   npx tsx scripts/cleanup-orphan-audit-test-leaks.ts --dry-run
 *   ALLOW_TEST_CLEANUP=1 npx tsx scripts/cleanup-orphan-audit-test-leaks.ts
 */
import { and, eq, inArray, like, notInArray, or, sql } from 'drizzle-orm';
import { db, pool } from '../server/db';
import {
  bowlers,
  leagues,
  orphanCleanupAudits,
  teams,
  users,
} from '@shared/schema';
import {
  assertSafeDatabaseHost,
  hasProductionDeploymentEvidence,
} from '../server/utils/db-safety';

/**
 * Leagues that LOOK like a `Vitest Audit %` leak by pattern but are
 * actually deterministic baseline fixtures owned by the seeded
 * `vitest-org-a` / `vitest-org-b` orgs (created in
 * `tests/setup/seed-test-users.ts`). They are re-used across runs —
 * deleting them would force the seeder to re-create them on the next
 * boot and would break any sibling test that captured their ids.
 *
 * Mirrors the `PROTECTED_SLUGS` allow-list pattern used in
 * `scripts/cleanup-test-organizations.ts`.
 */
const PROTECTED_LEAGUE_NAMES = [
  'Vitest Org A Baseline League',
  'Vitest Org B Baseline League',
];

/**
 * Email of the seeded vitest system admin. Resolved at runtime so that
 * a deployment that overrides `TEST_ADMIN_EMAIL` is still recognised.
 * The lookup additionally requires `role = 'system_admin'` and
 * `name LIKE 'Vitest %'` so we can never accidentally match a
 * real customer admin who happens to be using the same email.
 */
const SEEDED_TEST_ADMIN_EMAIL =
  process.env.TEST_ADMIN_EMAIL || 'admin@example.com';

function assertSafeEnvironment(): void {
  const nodeEnv = process.env.NODE_ENV;
  const allowOverride = process.env.ALLOW_TEST_CLEANUP === '1';
  if (allowOverride) return;
  if (hasProductionDeploymentEvidence(process.env)) {
    throw new Error(
      'Refusing to run cleanup-orphan-audit-test-leaks: production/deployment evidence is present ' +
        `(APP_ENV=${process.env.APP_ENV ?? '<unset>'}, NODE_ENV=${nodeEnv ?? '<unset>'}, ` +
        `APP_DOMAIN=${process.env.APP_DOMAIN ?? '<unset>'}). ` +
        'Set ALLOW_TEST_CLEANUP=1 only if you really intend to delete test-shaped audit rows from this database.',
    );
  }
}

interface CleanupCounts {
  orphanCleanupAuditsByAdmin: number;
  orphanCleanupAuditsByResource: number;
  usersBowlerIdNulled: number;
  bowlers: number;
  leagues: number;
  users: number;
}

async function main(): Promise<void> {
  assertSafeEnvironment();
  // Independent layer of defense: refuse to run against a non-allowlisted
  // DATABASE_URL host even if NODE_ENV is wrong. See server/utils/db-safety.ts.
  assertSafeDatabaseHost('cleanup-orphan-audit-test-leaks');

  const dryRun = process.argv.includes('--dry-run');
  const confirmed = process.env.ALLOW_TEST_CLEANUP === '1';
  if (!dryRun && !confirmed) {
    throw new Error(
      'Refusing to run without ALLOW_TEST_CLEANUP=1 (or --dry-run). This script deletes ' +
        'orphan_cleanup_audits rows and Vitest-Audit-named leagues/teams/bowlers/users from ' +
        'the connected database.',
    );
  }

  // --- Resolve doomed resource ids ----------------------------------------
  const doomedLeagues = await db
    .select({ id: leagues.id, name: leagues.name, organizationId: leagues.organizationId })
    .from(leagues)
    .where(
      and(
        like(leagues.name, 'Vitest Audit %'),
        notInArray(leagues.name, PROTECTED_LEAGUE_NAMES),
      ),
    );
  const doomedLeagueIds = doomedLeagues.map((l) => l.id);

  const doomedTeams = await db
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(like(teams.name, 'Vitest Audit %'));
  const doomedTeamIds = doomedTeams.map((t) => t.id);

  const doomedBowlers = await db
    .select({ id: bowlers.id, name: bowlers.name })
    .from(bowlers)
    .where(like(bowlers.name, 'Vitest Audit %'));
  const doomedBowlerIds = doomedBowlers.map((b) => b.id);

  const doomedUsers = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(like(users.email, 'vitest-audit-%'));
  const doomedUserIds = doomedUsers.map((u) => u.id);

  // --- Resolve seeded test admin (positively, never by id alone) ----------
  const adminCandidates = await db
    .select({ id: users.id, email: users.email, name: users.name, role: users.role })
    .from(users)
    .where(
      and(
        eq(users.email, SEEDED_TEST_ADMIN_EMAIL),
        eq(users.role, 'system_admin'),
        like(users.name, 'Vitest %'),
      ),
    );
  const seededAdminId = adminCandidates[0]?.id ?? null;

  // --- Print plan ---------------------------------------------------------
  console.log('--- cleanup-orphan-audit-test-leaks plan ---');
  console.log(`  doomed leagues (Vitest Audit %, excluding baselines): ${doomedLeagueIds.length}`);
  for (const l of doomedLeagues.slice(0, 12)) {
    console.log(`    league id=${l.id} org=${l.organizationId ?? 'null'} name=${JSON.stringify(l.name)}`);
  }
  console.log(`  doomed teams   (Vitest Audit %): ${doomedTeamIds.length}`);
  for (const t of doomedTeams.slice(0, 6)) {
    console.log(`    team id=${t.id} name=${JSON.stringify(t.name)}`);
  }
  console.log(`  doomed bowlers (Vitest Audit %): ${doomedBowlerIds.length}`);
  for (const b of doomedBowlers.slice(0, 6)) {
    console.log(`    bowler id=${b.id} name=${JSON.stringify(b.name)}`);
  }
  console.log(`  doomed users   (vitest-audit-%): ${doomedUserIds.length}`);
  for (const u of doomedUsers.slice(0, 6)) {
    console.log(`    user id=${u.id} email=${JSON.stringify(u.email)}`);
  }
  if (seededAdminId === null) {
    console.log(`  seeded vitest test admin (${SEEDED_TEST_ADMIN_EMAIL}): NOT FOUND — orphan_cleanup_audits sweep will be skipped.`);
  } else {
    console.log(`  seeded vitest test admin: id=${seededAdminId} (${SEEDED_TEST_ADMIN_EMAIL})`);
  }
  console.log(`  protected league names: ${PROTECTED_LEAGUE_NAMES.join(', ')}`);

  if (
    doomedLeagueIds.length === 0 &&
    doomedTeamIds.length === 0 &&
    doomedBowlerIds.length === 0 &&
    doomedUserIds.length === 0 &&
    seededAdminId === null
  ) {
    console.log('Nothing to clean up.');
    await pool.end();
    return;
  }

  if (dryRun) {
    // Estimate the audit-row sweep size up-front so the operator knows what they're about to delete.
    let estByAdmin = 0;
    if (seededAdminId !== null) {
      const [row] = await db
        .select({ value: sql<number>`count(*)::int` })
        .from(orphanCleanupAudits)
        .where(eq(orphanCleanupAudits.adminUserId, seededAdminId));
      estByAdmin = Number(row?.value ?? 0);
    }
    console.log(`\n[dry-run] orphan_cleanup_audits by seeded admin: ${estByAdmin} row(s) would be deleted.`);
    console.log('[dry-run] Not deleting. Re-run with ALLOW_TEST_CLEANUP=1 to actually clean up.');
    await pool.end();
    return;
  }

  // --- Apply deletes inside one transaction --------------------------------
  const counts: CleanupCounts = {
    orphanCleanupAuditsByAdmin: 0,
    orphanCleanupAuditsByResource: 0,
    usersBowlerIdNulled: 0,
    bowlers: 0,
    leagues: 0,
    users: 0,
  };

  await db.transaction(async (tx) => {
    // 1. Delete orphan_cleanup_audits authored by the seeded test admin.
    //    This is the bulk of the leak (~3k rows historically). The
    //    admin row itself stays because it is positively a seeded
    //    test fixture (re-created on next boot).
    if (seededAdminId !== null) {
      const oa = await tx
        .delete(orphanCleanupAudits)
        .where(eq(orphanCleanupAudits.adminUserId, seededAdminId))
        .returning({ id: orphanCleanupAudits.id });
      counts.orphanCleanupAuditsByAdmin = oa.length;
    }

    // 2. Defense-in-depth: any audit row that points at a doomed
    //    Vitest-Audit-named resource. Should be empty after step 1
    //    (every doomed resource was created and audited by the
    //    seeded admin), but if the dev DB ever ends up with audit
    //    rows authored by a non-seeded admin against test fixtures,
    //    this clears them so the resource deletes below don't get
    //    blocked by a RESTRICT FK.
    //
    //    NOTE: orphan_cleanup_audits.resource_id is a plain integer
    //    column with no FK, but we still scope the delete to the
    //    exact (resource_type, resource_id) pairs we own.
    const auditPredicates: Array<ReturnType<typeof and>> = [];
    if (doomedLeagueIds.length > 0) {
      auditPredicates.push(
        and(
          eq(orphanCleanupAudits.resourceType, 'leagues'),
          inArray(orphanCleanupAudits.resourceId, doomedLeagueIds),
        ),
      );
    }
    if (doomedTeamIds.length > 0) {
      auditPredicates.push(
        and(
          eq(orphanCleanupAudits.resourceType, 'teams'),
          inArray(orphanCleanupAudits.resourceId, doomedTeamIds),
        ),
      );
    }
    // NOTE: We deliberately do NOT add a 'bowlerLeagues' or 'payments'
    // arm here. `orphan_cleanup_audits.resource_id` for those rows
    // stores the bowler_leagues.id / payments.id respectively — NOT
    // the bowler.id or league.id. We don't have those ids handy
    // (the rows are cascade-deleted by the league delete in step 5)
    // and using doomedBowlerIds / doomedLeagueIds against them would
    // be a category error: it could miss real leaked rows AND, on an
    // id collision, delete an unrelated audit row authored by a
    // non-seeded admin. Step 1's admin-author sweep already covers
    // every audit row authored by the seeded test admin, which is
    // the only realistic source of these rows.
    if (doomedUserIds.length > 0) {
      auditPredicates.push(
        and(
          eq(orphanCleanupAudits.resourceType, 'users'),
          inArray(orphanCleanupAudits.resourceId, doomedUserIds),
        ),
      );
    }
    if (auditPredicates.length > 0) {
      const ob = await tx
        .delete(orphanCleanupAudits)
        .where(or(...auditPredicates))
        .returning({ id: orphanCleanupAudits.id });
      counts.orphanCleanupAuditsByResource = ob.length;
    }

    // 3. NULL users.bowler_id where the bowler is doomed (NO ACTION FK).
    if (doomedBowlerIds.length > 0) {
      const ub = await tx
        .update(users)
        .set({ bowlerId: null })
        .where(inArray(users.bowlerId, doomedBowlerIds))
        .returning({ id: users.id });
      counts.usersBowlerIdNulled = ub.length;
    }

    // 4. Delete bowlers — cascades to payments, scores, and bowler_leagues.
    if (doomedBowlerIds.length > 0) {
      const bw = await tx
        .delete(bowlers)
        .where(inArray(bowlers.id, doomedBowlerIds))
        .returning({ id: bowlers.id });
      counts.bowlers = bw.length;
    }

    // 5. Delete leagues — cascades to teams, bowler_leagues, payments,
    //    games, and scores tied to that league.
    if (doomedLeagueIds.length > 0) {
      const lg = await tx
        .delete(leagues)
        .where(inArray(leagues.id, doomedLeagueIds))
        .returning({ id: leagues.id });
      counts.leagues = lg.length;
    }

    // 6. Delete users — cascades to email_change_requests, sessions,
    //    deletion_requests etc. Their bowler_id was NULLed in step 3.
    if (doomedUserIds.length > 0) {
      const us = await tx
        .delete(users)
        .where(inArray(users.id, doomedUserIds))
        .returning({ id: users.id });
      counts.users = us.length;
    }
  });

  console.log('\nCleanup complete:');
  console.log(`  orphan_cleanup_audits by seeded admin:   ${counts.orphanCleanupAuditsByAdmin}`);
  console.log(`  orphan_cleanup_audits by doomed resource: ${counts.orphanCleanupAuditsByResource}`);
  console.log(`  bowlers deleted:                          ${counts.bowlers}`);
  console.log(`  leagues deleted (cascades teams/bls/...): ${counts.leagues}`);
  console.log(`  users deleted:                            ${counts.users}`);
  console.log(`  users.bowler_id NULLed:                   ${counts.usersBowlerIdNulled}`);

  // Sanity-check the post-state. Should report 0 of each marker after
  // a successful clean run.
  const [auditRemaining] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(orphanCleanupAudits);
  const [leaguesRemaining] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(leagues)
    .where(
      and(
        like(leagues.name, 'Vitest Audit %'),
        notInArray(leagues.name, PROTECTED_LEAGUE_NAMES),
      ),
    );
  const [teamsRemaining] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(teams)
    .where(like(teams.name, 'Vitest Audit %'));
  const [bowlersRemaining] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(bowlers)
    .where(like(bowlers.name, 'Vitest Audit %'));
  const [usersRemaining] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(users)
    .where(like(users.email, 'vitest-audit-%'));
  console.log(
    `\nPost-state: orphan_cleanup_audits=${auditRemaining?.value ?? 0}, ` +
      `'Vitest Audit %' leagues=${leaguesRemaining?.value ?? 0}, ` +
      `'Vitest Audit %' teams=${teamsRemaining?.value ?? 0}, ` +
      `'Vitest Audit %' bowlers=${bowlersRemaining?.value ?? 0}, ` +
      `'vitest-audit-%' users=${usersRemaining?.value ?? 0}`,
  );

  await pool.end();
}

main().catch((err) => {
  console.error('cleanup-orphan-audit-test-leaks failed:', err);
  process.exit(1);
});
