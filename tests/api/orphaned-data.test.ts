/**
 * Orphan-data fixture
 * ------------------------------------------------------------------
 * Stages "legacy" rows that the org-less repair endpoints exist to
 * clean up. The two row shapes the live schema would otherwise reject
 * — child rows pointing at a non-existent league, and a non-admin user
 * with no org — are inserted via `tests/helpers/orphan-staging.ts`,
 * which lifts the relevant constraint (FK or trigger) only for the
 * single inserting transaction. That keeps locks tight enough for the
 * suite to run alongside other test files in parallel.
 *
 * `leagues.organization_id` is nullable in the schema, so org-less
 * leagues are inserted directly without any DDL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql, inArray, like, or, and, gt, gte, asc } from 'drizzle-orm';
import { db } from '../../server/db';
import {
  leagues,
  teams,
  bowlers,
  bowlerLeagues,
  payments,
  users,
  organizations,
  orphanCleanupAudits,
  type OrphanCleanupAudit,
} from '@shared/schema';
import { hashPassword } from '../../server/lib/password';
import {
  login,
  apiGet,
  apiPost,
  type AuthSession,
  TEST_ADMIN_EMAIL,
  TEST_ADMIN_PASSWORD,
  TEST_ORG_A_EMAIL,
  TEST_ORG_PASSWORD,
} from '../helpers';
import {
  insertChildBypassingLeagueFk,
  insertOrphanUser,
  validateLeagueFk,
} from '../helpers/orphan-staging';

interface OrphanedLeagueRow { id: number; name: string }
interface OrphanedTeamRow {
  id: number;
  leagueId: number;
  parentLeagueExists: boolean;
  leagueOrganizationId: number | null;
}
interface OrphanedChildRow {
  id: number;
  leagueId: number;
  parentLeagueExists: boolean;
}
interface OrphanedUserRow { id: number; email: string; role: string }

const BOGUS_LEAGUE_ID = 2_000_000_000;

describe('Orphaned Data API (system-admin)', () => {
  let admin: AuthSession;
  let orgAdmin: AuthSession;
  let targetOrgId: number;

  let orphanLeagueA = 0; // children attach here; deleted in delete-success test
  let orphanLeagueB = 0; // reassigned in reassign-success test
  let nonOrphanLeagueId = 0;

  let bowlerId = 0;
  let orphanTeamId = 0;
  let parentMissingTeamId = 0;
  let nonOrphanTeamId = 0;
  let orphanBowlerLeagueId = 0;
  let parentMissingBowlerLeagueId = 0;
  let orphanPaymentId = 0;
  let parentMissingPaymentId = 0;

  let orphanUserId = 0;
  let orphanSysAdminId = 0;
  let nonOrphanUserId = 0;

  // Append-only registry of every row this suite inserts. The success-
  // path tests zero out the per-test variables (e.g. `orphanPaymentId
  // = 0`) once the route under test has deleted the resource, which
  // would otherwise hide the matching `orphan_cleanup_audits` row from
  // afterAll cleanup. The registry survives those resets so audit
  // cleanup always sees the original ids.
  const inserted: {
    leagues: number[];
    teams: number[];
    bowlers: number[];
    bowlerLeagues: number[];
    payments: number[];
    users: number[];
  } = {
    leagues: [],
    teams: [],
    bowlers: [],
    bowlerLeagues: [],
    payments: [],
    users: [],
  };

  beforeAll(async () => {
    admin = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
    // Non-system-admin session for the GET /orphaned-data-audits gate
    // tests at the bottom of the file (merged from the deleted
    // orphaned-data-audits.test.ts companion suite).
    orgAdmin = await login(TEST_ORG_A_EMAIL, TEST_ORG_PASSWORD);

    // Idempotent pre-purge: a previous run may have been interrupted
    // (SIGTERM, OOM, vitest crash) before its `afterAll` finished. The
    // bypass-FK rows below pin `(leagueId, number)` to constants
    // (BOGUS_LEAGUE_ID + 9992 / etc.), so any leftover would collide on
    // `teams_league_number_idx` when this run re-inserts them. Wipe the
    // known-shape leftovers up-front so the suite is self-healing.
    await db.delete(payments).where(eq(payments.leagueId, BOGUS_LEAGUE_ID));
    await db.delete(bowlerLeagues).where(eq(bowlerLeagues.leagueId, BOGUS_LEAGUE_ID));
    await db.delete(teams).where(eq(teams.leagueId, BOGUS_LEAGUE_ID));

    const staleLeagues = await db
      .select({ id: leagues.id })
      .from(leagues)
      .where(
        inArray(leagues.name, [
          'Vitest Orphan League A',
          'Vitest Orphan League B',
          'Vitest Non-Orphan League',
        ]),
      );
    if (staleLeagues.length > 0) {
      const ids = staleLeagues.map((l) => l.id);
      // Children first (FK is ON DELETE CASCADE for teams, but
      // bowler_leagues / payments may not be — delete defensively).
      await db.delete(payments).where(inArray(payments.leagueId, ids));
      await db.delete(bowlerLeagues).where(inArray(bowlerLeagues.leagueId, ids));
      await db.delete(teams).where(inArray(teams.leagueId, ids));
      await db.delete(leagues).where(inArray(leagues.id, ids));
    }

    // Note: we deliberately do NOT pre-purge `bowlers` by name here.
    // There is no unique constraint on `bowlers.name`, so leftover rows
    // from interrupted runs don't block the new INSERT below, and a
    // name-only delete is too broad to be safe against unrelated
    // fixtures that might happen to reuse the string.

    await db
      .delete(users)
      .where(
        or(
          like(users.email, 'vitest-orphan-%@example.com'),
          like(users.email, 'vitest-orphan-sysadmin-%@example.com'),
          like(users.email, 'vitest-nonorphan-%@example.com'),
        ),
      );

    // eslint-disable-next-line leaguevault/no-unscoped-table-query-in-test-assertion -- bootstrap pick of any seeded org; not a result asserted on for cardinality and the row is read-only.
    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .limit(1);
    if (!org) throw new Error('No organization available for orphaned-data tests');
    targetOrgId = org.id;

    const leagueDefaults = {
      seasonStart: '2025-01-01 00:00:00',
      seasonEnd: '2025-12-31 00:00:00',
      weekDay: 'Monday' as const,
    };

    const [la] = await db
      .insert(leagues)
      .values({
        name: 'Vitest Orphan League A',
        ...leagueDefaults,
        organizationId: null as unknown as number,
      })
      .returning({ id: leagues.id });
    orphanLeagueA = la.id;
    inserted.leagues.push(orphanLeagueA);

    const [lb] = await db
      .insert(leagues)
      .values({
        name: 'Vitest Orphan League B',
        ...leagueDefaults,
        organizationId: null as unknown as number,
      })
      .returning({ id: leagues.id });
    orphanLeagueB = lb.id;
    inserted.leagues.push(orphanLeagueB);

    const [ln] = await db
      .insert(leagues)
      .values({
        name: 'Vitest Non-Orphan League',
        ...leagueDefaults,
        organizationId: targetOrgId,
      })
      .returning({ id: leagues.id });
    nonOrphanLeagueId = ln.id;
    inserted.leagues.push(nonOrphanLeagueId);

    const [bw] = await db
      .insert(bowlers)
      .values({ name: 'Vitest Orphan Bowler', organizationId: targetOrgId })
      .returning({ id: bowlers.id });
    bowlerId = bw.id;
    inserted.bowlers.push(bowlerId);

    // Teams: parent-org-null variant + parent-missing variant + non-orphan
    const [t1] = await db
      .insert(teams)
      .values({ name: 'Vitest Orphan Team', number: 9991, leagueId: orphanLeagueA })
      .returning({ id: teams.id });
    orphanTeamId = t1.id;
    inserted.teams.push(orphanTeamId);

    parentMissingTeamId = await insertChildBypassingLeagueFk(teams, 'teams', {
      name: 'Vitest Parent-Missing Team',
      number: 9992,
      leagueId: BOGUS_LEAGUE_ID,
    });
    inserted.teams.push(parentMissingTeamId);

    const [t3] = await db
      .insert(teams)
      .values({ name: 'Vitest Non-Orphan Team', number: 9993, leagueId: nonOrphanLeagueId })
      .returning({ id: teams.id });
    nonOrphanTeamId = t3.id;
    inserted.teams.push(nonOrphanTeamId);

    const [bl1] = await db
      .insert(bowlerLeagues)
      .values({ bowlerId, leagueId: orphanLeagueA, teamId: orphanTeamId })
      .returning({ id: bowlerLeagues.id });
    orphanBowlerLeagueId = bl1.id;
    inserted.bowlerLeagues.push(orphanBowlerLeagueId);

    parentMissingBowlerLeagueId = await insertChildBypassingLeagueFk(
      bowlerLeagues,
      'bowler_leagues',
      { bowlerId, leagueId: BOGUS_LEAGUE_ID, teamId: orphanTeamId },
    );
    inserted.bowlerLeagues.push(parentMissingBowlerLeagueId);

    // Payments are tenant-owned canonical evidence now. Their required
    // organization/league/bowler composite FKs make both historical orphan
    // shapes impossible, so this legacy fixture no longer stages payment
    // rows for repair.

    const pwd = await hashPassword('Throwaway-Password-123!');
    const stamp = Date.now();

    // The DB enforces a `users_role_org_required` BEFORE-INSERT trigger
    // that forbids creating a non-admin user with `organizationId =
    // NULL`. Production rows that pre-date the trigger can still exist
    // as orphans, which is exactly what the orphan-data admin endpoints
    // exist to clean up. `insertOrphanUser` briefly disables the
    // trigger inside a single transaction so we can stage that legacy
    // state without dropping the trigger globally.
    const orphanUser = await insertOrphanUser({
      email: `vitest-orphan-${stamp}@example.com`,
      password: pwd,
      name: 'Vitest Orphan User',
      role: 'user',
    });
    orphanUserId = orphanUser.id;
    inserted.users.push(orphanUserId);

    const [u2] = await db
      .insert(users)
      .values({
        email: `vitest-orphan-sysadmin-${stamp}@example.com`,
        password: pwd,
        name: 'Vitest Orphan SysAdmin',
        role: 'system_admin',
        organizationId: null,
      })
      .returning({ id: users.id });
    orphanSysAdminId = u2.id;
    inserted.users.push(orphanSysAdminId);

    const [u3] = await db
      .insert(users)
      .values({
        email: `vitest-nonorphan-${stamp}@example.com`,
        password: pwd,
        name: 'Vitest Non-Orphan User',
        role: 'user',
        organizationId: targetOrgId,
      })
      .returning({ id: users.id });
    nonOrphanUserId = u3.id;
    inserted.users.push(nonOrphanUserId);
  });

  afterAll(async () => {
    // Cleanup contract (#615):
    //  - Every row this suite inserted in `beforeAll` (or via the
    //    bypass-FK helpers) must be deleted here OR have already been
    //    deleted by the route under test (in which case the matching
    //    DELETE is a no-op).
    //  - Every `orphan_cleanup_audits` row written by the success-path
    //    tests (delete / reassign / undo endpoints) must be deleted
    //    too. We iterate the append-only `inserted` registry rather
    //    than the per-test variables — the success-path tests zero
    //    those out, which would otherwise hide the matching audit row.
    //  - Any failure to delete a row is loud — labeled with table+id,
    //    logged, AND collected so the suite fails at the end. The
    //    previous swallow-all cleanup pattern (#615) silently leaked
    //    rows (and FK errors) into the dev database on every run,
    //    which bloated the dev DB and produced phantom data other
    //    tests had to step around.
    //  - All deletes are still attempted even when one fails, so a
    //    single bad row doesn't block the rest of cleanup.
    const failures: Array<{ label: string; error: unknown }> = [];
    const tryRun = async (label: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (error) {
        failures.push({ label, error });
        console.error(`[orphaned-data cleanup] ${label} failed:`, error);
      }
    };

    // Audit rows first. `orphan_cleanup_audits.resource_id` is a
    // plain integer (no FK), so order doesn't matter for FK safety —
    // but deleting them up-front keeps the audit table from growing
    // forever across repeated runs against the same dev DB.
    const auditTargets: Array<{ type: string; id: number }> = [
      ...inserted.leagues.map((id) => ({ type: 'leagues', id })),
      ...inserted.teams.map((id) => ({ type: 'teams', id })),
      ...inserted.bowlerLeagues.map((id) => ({ type: 'bowlerLeagues', id })),
      ...inserted.payments.map((id) => ({ type: 'payments', id })),
      ...inserted.users.map((id) => ({ type: 'users', id })),
    ];
    for (const { type, id } of auditTargets) {
      await tryRun(`orphan_cleanup_audits ${type}:${id}`, () =>
        db.delete(orphanCleanupAudits).where(and(
          eq(orphanCleanupAudits.resourceType, type),
          eq(orphanCleanupAudits.resourceId, id),
        )),
      );
    }

    for (const id of [orphanUserId, orphanSysAdminId, nonOrphanUserId]) {
      if (id) await tryRun(`users:${id}`, () => db.delete(users).where(eq(users.id, id)));
    }
    for (const id of [orphanPaymentId, parentMissingPaymentId]) {
      if (id) await tryRun(`payments:${id}`, () => db.delete(payments).where(eq(payments.id, id)));
    }
    for (const id of [orphanBowlerLeagueId, parentMissingBowlerLeagueId]) {
      if (id) await tryRun(`bowler_leagues:${id}`, () => db.delete(bowlerLeagues).where(eq(bowlerLeagues.id, id)));
    }
    for (const id of [orphanTeamId, parentMissingTeamId, nonOrphanTeamId]) {
      if (id) await tryRun(`teams:${id}`, () => db.delete(teams).where(eq(teams.id, id)));
    }
    if (bowlerId) await tryRun(`bowlers:${bowlerId}`, () => db.delete(bowlers).where(eq(bowlers.id, bowlerId)));
    for (const id of [orphanLeagueA, orphanLeagueB, nonOrphanLeagueId]) {
      if (id) await tryRun(`leagues:${id}`, () => db.delete(leagues).where(eq(leagues.id, id)));
    }

    // The per-insert FK helpers re-added each constraint as NOT VALID
    // so the orphan row wouldn't trip back-validation. Now that the
    // orphan rows are gone, mark them VALID again. VALIDATE CONSTRAINT
    // takes only SHARE UPDATE EXCLUSIVE (does not block reads/writes).
    await tryRun('validate teams_league_id_fkey', () => validateLeagueFk('teams'));
    await tryRun('validate bowler_leagues_league_id_fkey', () => validateLeagueFk('bowler_leagues'));
    await tryRun('validate payments_league_id_fkey', () => validateLeagueFk('payments'));

    if (failures.length > 0) {
      const summary = failures
        .map((f) => `  - ${f.label}: ${(f.error as Error)?.message ?? String(f.error)}`)
        .join('\n');
      throw new Error(
        `orphaned-data afterAll cleanup had ${failures.length} failure(s):\n${summary}`,
      );
    }
  });

  // ---- list endpoints --------------------------------------------------

  describe('GET /orphaned-data/:type', () => {
    it('lists orphan leagues and excludes non-orphan leagues', async () => {
      const { status, data } = await apiGet<OrphanedLeagueRow[]>(
        '/api/system-admin/orphaned-data/leagues',
        admin,
      );
      expect(status).toBe(200);
      expect(data.success).toBe(true);
      const ids = (data.data ?? []).map((r) => r.id);
      expect(ids).toContain(orphanLeagueA);
      expect(ids).toContain(orphanLeagueB);
      expect(ids).not.toContain(nonOrphanLeagueId);
    });

    it('lists orphan teams including both parent-org-null and parent-missing variants', async () => {
      const { status, data } = await apiGet<OrphanedTeamRow[]>(
        '/api/system-admin/orphaned-data/teams',
        admin,
      );
      expect(status).toBe(200);
      const rows = data.data ?? [];
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(orphanTeamId);
      expect(ids).toContain(parentMissingTeamId);
      expect(ids).not.toContain(nonOrphanTeamId);

      const orphanRow = rows.find((r) => r.id === orphanTeamId);
      if (!orphanRow) throw new Error('expected orphan team row');
      expect(orphanRow.parentLeagueExists).toBe(true);
      expect(orphanRow.leagueOrganizationId).toBeNull();

      const missingRow = rows.find((r) => r.id === parentMissingTeamId);
      if (!missingRow) throw new Error('expected parent-missing team row');
      expect(missingRow.parentLeagueExists).toBe(false);
    });

    it('lists orphan bowler-leagues including both variants', async () => {
      const { data } = await apiGet<OrphanedChildRow[]>(
        '/api/system-admin/orphaned-data/bowlerLeagues',
        admin,
      );
      const rows = data.data ?? [];
      const orphan = rows.find((r) => r.id === orphanBowlerLeagueId);
      const missing = rows.find((r) => r.id === parentMissingBowlerLeagueId);
      if (!orphan) throw new Error('expected orphan bowler-league row');
      if (!missing) throw new Error('expected parent-missing bowler-league row');
      expect(orphan.parentLeagueExists).toBe(true);
      expect(missing.parentLeagueExists).toBe(false);
    });

    it('does not expose orphan payments under canonical tenant FKs', async () => {
      const { data } = await apiGet<OrphanedChildRow[]>(
        '/api/system-admin/orphaned-data/payments',
        admin,
      );
      const rows = data.data ?? [];
      expect(rows).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: orphanPaymentId }),
        expect.objectContaining({ id: parentMissingPaymentId }),
      ]));
    });

    it('lists orphan users but excludes system_admin and non-orphan users', async () => {
      const { data } = await apiGet<OrphanedUserRow[]>(
        '/api/system-admin/orphaned-data/users',
        admin,
      );
      const ids = (data.data ?? []).map((r) => r.id);
      expect(ids).toContain(orphanUserId);
      expect(ids).not.toContain(orphanSysAdminId);
      expect(ids).not.toContain(nonOrphanUserId);
    });

    it('rejects unknown resource types with 400', async () => {
      const { status } = await apiGet(
        '/api/system-admin/orphaned-data/widgets',
        admin,
      );
      expect(status).toBe(400);
    });
  });

  // ---- repair: 400 / 404 / 409 paths -----------------------------------

  describe('POST /orphaned-data/:type/:id/reassign', () => {
    it('refuses to reassign child resource types (teams) with 400', async () => {
      const { status, data } = await apiPost(
        `/api/system-admin/orphaned-data/teams/${orphanTeamId}/reassign`,
        { organizationId: targetOrgId },
        admin,
      );
      expect(status).toBe(400);
      expect(data.error?.code).toBe('REASSIGN_UNSUPPORTED');
    });

    it('refuses to reassign bowlerLeagues with 400', async () => {
      const { status } = await apiPost(
        `/api/system-admin/orphaned-data/bowlerLeagues/${orphanBowlerLeagueId}/reassign`,
        { organizationId: targetOrgId },
        admin,
      );
      expect(status).toBe(400);
    });

    it('returns 404 when the league row does not exist', async () => {
      const { status } = await apiPost(
        `/api/system-admin/orphaned-data/leagues/999999999/reassign`,
        { organizationId: targetOrgId },
        admin,
      );
      expect(status).toBe(404);
    });

    it('returns 404 when the user row does not exist', async () => {
      const { status } = await apiPost(
        `/api/system-admin/orphaned-data/users/999999999/reassign`,
        { organizationId: targetOrgId },
        admin,
      );
      expect(status).toBe(404);
    });

    it('returns 409 when the league exists but is not orphaned', async () => {
      const { status, data } = await apiPost(
        `/api/system-admin/orphaned-data/leagues/${nonOrphanLeagueId}/reassign`,
        { organizationId: targetOrgId },
        admin,
      );
      expect(status).toBe(409);
      expect(data.error?.code).toBe('NOT_ORPHANED');
    });

    it('returns 409 when the user exists but is not orphaned', async () => {
      const { status, data } = await apiPost(
        `/api/system-admin/orphaned-data/users/${nonOrphanUserId}/reassign`,
        { organizationId: targetOrgId },
        admin,
      );
      expect(status).toBe(409);
      expect(data.error?.code).toBe('NOT_ORPHANED');
    });

    it('refuses to reassign system_admin users (returns 409, not_orphaned)', async () => {
      const { status, data } = await apiPost(
        `/api/system-admin/orphaned-data/users/${orphanSysAdminId}/reassign`,
        { organizationId: targetOrgId },
        admin,
      );
      expect(status).toBe(409);
      expect(data.error?.code).toBe('NOT_ORPHANED');

      const [row] = await db
        .select({ organizationId: users.organizationId, role: users.role })
        .from(users)
        .where(eq(users.id, orphanSysAdminId));
      expect(row.organizationId).toBeNull();
      expect(row.role).toBe('system_admin');
    });
  });

  describe('POST /orphaned-data/:type/:id/delete', () => {
    it('returns 404 when the league row does not exist', async () => {
      const { status } = await apiPost(
        `/api/system-admin/orphaned-data/leagues/999999999/delete`,
        {},
        admin,
      );
      expect(status).toBe(404);
    });

    it('returns 404 when the team row does not exist', async () => {
      const { status } = await apiPost(
        `/api/system-admin/orphaned-data/teams/999999999/delete`,
        {},
        admin,
      );
      expect(status).toBe(404);
    });

    it('returns 409 when the league exists but is not orphaned', async () => {
      const { status, data } = await apiPost(
        `/api/system-admin/orphaned-data/leagues/${nonOrphanLeagueId}/delete`,
        {},
        admin,
      );
      expect(status).toBe(409);
      expect(data.error?.code).toBe('NOT_ORPHANED');
    });

    it('returns 409 when the team exists but is not orphaned', async () => {
      const { status, data } = await apiPost(
        `/api/system-admin/orphaned-data/teams/${nonOrphanTeamId}/delete`,
        {},
        admin,
      );
      expect(status).toBe(409);
      expect(data.error?.code).toBe('NOT_ORPHANED');
    });

    it('returns 409 when the user exists but is not orphaned', async () => {
      const { status } = await apiPost(
        `/api/system-admin/orphaned-data/users/${nonOrphanUserId}/delete`,
        {},
        admin,
      );
      expect(status).toBe(409);
    });

    it('refuses to delete system_admin users (returns 409, not_orphaned)', async () => {
      const { status } = await apiPost(
        `/api/system-admin/orphaned-data/users/${orphanSysAdminId}/delete`,
        {},
        admin,
      );
      expect(status).toBe(409);

      const [row] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, orphanSysAdminId));
      expect(row).toBeTruthy();
    });
  });

  // ---- success paths ---------------------------------------------------

  describe('repair success paths', () => {
    it('deletes orphan child rows (team / bowler-league / parent-missing variants)', async () => {
      for (const [type, id] of [
        ['bowlerLeagues', orphanBowlerLeagueId],
        ['bowlerLeagues', parentMissingBowlerLeagueId],
        ['teams', orphanTeamId],
        ['teams', parentMissingTeamId],
      ] as const) {
        const { status } = await apiPost(
          `/api/system-admin/orphaned-data/${type}/${id}/delete`,
          {},
          admin,
        );
        expect(status, `delete ${type}/${id}`).toBe(200);
      }

      // Mark cleaned up so afterAll doesn't try again
      orphanBowlerLeagueId = 0;
      parentMissingBowlerLeagueId = 0;
      orphanTeamId = 0;
      parentMissingTeamId = 0;
    });

    it('deletes the now-empty orphan league A', async () => {
      const { status } = await apiPost(
        `/api/system-admin/orphaned-data/leagues/${orphanLeagueA}/delete`,
        {},
        admin,
      );
      expect(status).toBe(200);

      const remaining = await db
        .select({ id: leagues.id })
        .from(leagues)
        .where(eq(leagues.id, orphanLeagueA));
      expect(remaining.length).toBe(0);
      orphanLeagueA = 0;
    });

    it('reassigns orphan league B to a real organization', async () => {
      const { status } = await apiPost(
        `/api/system-admin/orphaned-data/leagues/${orphanLeagueB}/reassign`,
        { organizationId: targetOrgId },
        admin,
      );
      expect(status).toBe(200);

      const [row] = await db
        .select({ organizationId: leagues.organizationId })
        .from(leagues)
        .where(eq(leagues.id, orphanLeagueB));
      expect(row.organizationId).toBe(targetOrgId);
    });

    it('undoes the league reassign and writes a follow-up audit row', async () => {
      // Pull the most recent audit row for this league reassign so we can hit
      // the undo endpoint by audit id.
      interface AuditRow {
        id: number;
        action: string;
        resourceType: string;
        resourceId: number;
        organizationId: number | null;
        previousOrganizationId: number | null;
        undoneAt: string | null;
        undoneByAuditId: number | null;
      }
      const { data: listed } = await apiGet<AuditRow[]>(
        '/api/system-admin/orphaned-data-audits?limit=200',
        admin,
      );
      const reassignAudit = (listed.data ?? []).find(
        (r) => r.action === 'reassign' && r.resourceType === 'leagues' && r.resourceId === orphanLeagueB,
      );
      if (!reassignAudit) throw new Error('reassign audit row should exist');
      expect(reassignAudit.previousOrganizationId).toBeNull();
      expect(reassignAudit.organizationId).toBe(targetOrgId);
      expect(reassignAudit.undoneAt).toBeNull();

      const { status } = await apiPost(
        `/api/system-admin/orphaned-data-audits/${reassignAudit.id}/undo`,
        {},
        admin,
      );
      expect(status).toBe(200);

      // The league should be back to org-less.
      const [restored] = await db
        .select({ organizationId: leagues.organizationId })
        .from(leagues)
        .where(eq(leagues.id, orphanLeagueB));
      expect(restored.organizationId).toBeNull();

      // Activity log: original audit is now marked undone, and a new
      // undo_reassign row was written for traceability.
      const { data: after } = await apiGet<AuditRow[]>(
        '/api/system-admin/orphaned-data-audits?limit=200',
        admin,
      );
      const original = (after.data ?? []).find((r) => r.id === reassignAudit.id);
      if (!original) throw new Error('expected original audit row');
      expect(original.undoneAt).not.toBeNull();
      expect(original.undoneByAuditId).not.toBeNull();
      const undoRow = (after.data ?? []).find(
        (r) => r.action === 'undo_reassign' && r.resourceType === 'leagues' && r.resourceId === orphanLeagueB,
      );
      if (!undoRow) throw new Error('undo audit row should exist');
      expect(undoRow.previousOrganizationId).toBe(targetOrgId);
      expect(undoRow.organizationId).toBeNull();

      // Re-trying the same undo should fail with 409 ALREADY_UNDONE.
      const { status: again, data: againData } = await apiPost(
        `/api/system-admin/orphaned-data-audits/${reassignAudit.id}/undo`,
        {},
        admin,
      );
      expect(again).toBe(409);
      expect(againData.error?.code).toBe('ALREADY_UNDONE');
    });

    it('reassigns the orphan user to a real organization', async () => {
      const { status } = await apiPost(
        `/api/system-admin/orphaned-data/users/${orphanUserId}/reassign`,
        { organizationId: targetOrgId },
        admin,
      );
      expect(status).toBe(200);

      const [row] = await db
        .select({ organizationId: users.organizationId })
        .from(users)
        .where(eq(users.id, orphanUserId));
      expect(row.organizationId).toBe(targetOrgId);
    });

    it('refuses to undo a delete audit row (snapshot path is the recovery option)', async () => {
      // The earlier delete-success test deleted orphanLeagueA. Find that
      // audit row and confirm undo is rejected with UNDO_UNSUPPORTED, while
      // the snapshot was captured.
      interface AuditRow {
        id: number;
        action: string;
        resourceType: string;
        resourceId: number;
        snapshot: unknown;
      }
      const { data } = await apiGet<AuditRow[]>(
        '/api/system-admin/orphaned-data-audits?limit=200',
        admin,
      );
      const deleteAudit = (data.data ?? []).find(
        (r) => r.action === 'delete' && r.resourceType === 'leagues',
      );
      if (!deleteAudit) throw new Error('delete audit row should exist');
      expect(deleteAudit.snapshot).toBeTruthy();
      expect((deleteAudit.snapshot as { id: number }).id).toBeGreaterThan(0);

      const { status, data: errData } = await apiPost(
        `/api/system-admin/orphaned-data-audits/${deleteAudit.id}/undo`,
        {},
        admin,
      );
      expect(status).toBe(400);
      expect(errData.error?.code).toBe('UNDO_UNSUPPORTED');
    });

    it('returns 404 when undoing a non-existent audit row', async () => {
      const { status } = await apiPost(
        '/api/system-admin/orphaned-data-audits/999999999/undo',
        {},
        admin,
      );
      expect(status).toBe(404);
    });

    it('GET /orphaned-data-audits rejects non-system-admin sessions with 403', async () => {
      // Merged from the deleted orphaned-data-audits.test.ts: the
      // listing endpoint is system_admin-only.
      const { status } = await apiGet('/api/system-admin/orphaned-data-audits', orgAdmin);
      expect(status).toBe(403);
    });

    it('GET /orphaned-data-audits rejects unauthenticated callers with 401 or 403', async () => {
      const { status } = await apiGet('/api/system-admin/orphaned-data-audits');
      expect([401, 403]).toContain(status);
    });

    it('GET /orphaned-data-audits returns recent audit rows hydrated with admin and org info', async () => {
      // Reuses audit rows already written by the success-path tests
      // above (the league-B reassign in particular). The hydrated
      // shape includes admin email + organization name joins that the
      // raw DB row doesn't carry.
      interface AuditRowDTO {
        id: number;
        action: string;
        resourceType: string;
        resourceId: number;
        organizationId: number | null;
        organizationName: string | null;
        adminUserId: number | null;
        adminUserEmail: string | null;
        createdAt: string;
      }
      const { status, data } = await apiGet<AuditRowDTO[]>(
        '/api/system-admin/orphaned-data-audits?limit=200',
        admin,
      );
      expect(status).toBe(200);
      const rows = data.data ?? [];
      expect(rows.length).toBeGreaterThan(0);

      const reassignRow = rows.find(
        (r) => r.resourceType === 'leagues' && r.resourceId === orphanLeagueB && r.action === 'reassign',
      );
      if (!reassignRow) throw new Error('expected the league-B reassign audit row');
      expect(reassignRow.adminUserId).toBe(admin.user.id);
      expect(reassignRow.adminUserEmail?.toLowerCase()).toBe(
        admin.user.email.toLowerCase(),
      );
      expect(reassignRow.organizationId).toBe(targetOrgId);
      expect(reassignRow.organizationName).not.toBeNull();
    });

    it('GET /orphaned-data-audits honors the limit query parameter and clamps above 200', async () => {
      // Two assertions in one test to keep the suite tight: the
      // explicit-limit path and the upper-bound clamp share the same
      // setup and the same fetch shape.
      interface AuditRowDTO { id: number }

      const small = await apiGet<AuditRowDTO[]>(
        '/api/system-admin/orphaned-data-audits?limit=1',
        admin,
      );
      expect(small.status).toBe(200);
      expect((small.data.data ?? []).length).toBeLessThanOrEqual(1);

      const huge = await apiGet<AuditRowDTO[]>(
        '/api/system-admin/orphaned-data-audits?limit=99999',
        admin,
      );
      expect(huge.status).toBe(200);
      expect((huge.data.data ?? []).length).toBeLessThanOrEqual(200);
    });

    it('deletes the orphan system_admin user (after we strip the role) to confirm delete success path', async () => {
      // Strip the system_admin role so the delete repair endpoint will
      // accept it. The user has `organization_id = NULL` (it's an
      // orphan sysadmin), so a normal UPDATE would trip the
      // `users_role_org_required` trigger. Briefly disable it inside a
      // single transaction.
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`ALTER TABLE users DISABLE TRIGGER users_role_org_required`,
        );
        try {
          await tx.execute(
            sql`UPDATE users SET role = 'user' WHERE id = ${orphanSysAdminId}`,
          );
        } finally {
          await tx.execute(
            sql`ALTER TABLE users ENABLE TRIGGER users_role_org_required`,
          );
        }
      });

      const { status } = await apiPost(
        `/api/system-admin/orphaned-data/users/${orphanSysAdminId}/delete`,
        {},
        admin,
      );
      expect(status).toBe(200);

      const remaining = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, orphanSysAdminId));
      expect(remaining.length).toBe(0);
      orphanSysAdminId = 0;
    });
  });
});

// =====================================================================
// Audit-logging suite (formerly tests/api/orphaned-data-audits.test.ts).
//
// Asserts the audit table is the source of truth for org-less cleanup
// actions: every successful reassign/delete on every supported resource
// type writes a matching row to `orphan_cleanup_audits`; every failure
// path (validation, not-orphaned, not-found, unauthorized) does NOT.
// Also covers the GET listing endpoint (admin gating + limit clamp).
//
// Lives in the same file as the route-behavior suite above because they
// share the same FK-bypass DDL surface (orphan-staging.insertOrphanUser
// disables `users_role_org_required`). The vitest config keeps this
// file in the single-fork `serial-fk-bypass` project so concurrent
// suites can't race the `users` trigger window.
// =====================================================================

interface CleanupAuditRowDTO extends OrphanCleanupAudit {
  adminUserName: string | null;
  adminUserEmail: string | null;
  organizationName: string | null;
}

describe('Orphaned cleanup audit logging (system-admin)', () => {
  // Distinct from the route-suite's BOGUS_LEAGUE_ID above (2_000_000_000)
  // so the two suites never collide on `(leagueId, number)` unique keys.
  const BOGUS_LEAGUE_ID = 2_000_000_001;

  let admin: AuthSession;
  let orgAdmin: AuthSession;
  let targetOrgId: number;

  // Resources used by the success-path block. Each gets exactly one
  // repair action that we then assert produced an audit row.
  let leagueForReassign = 0;
  let leagueForDelete = 0;
  let teamForDelete = 0;
  let bowlerLeagueForDelete = 0;
  let paymentForDelete = 0;
  let userForReassign = 0;
  let userForDelete = 0;

  // Held-back orphan league + bowler used as the FK parent for child
  // resources that get deleted in the success block. We delete it last.
  let parentOrphanLeagueId = 0;
  let bowlerId = 0;

  // Resources used for failure-path assertions (must remain untouched).
  let nonOrphanLeagueId = 0;
  let nonOrphanUserId = 0;

  // Append-only registry of every row id we insert in `beforeAll`,
  // captured so `afterAll` cleanup is not blinded by test bodies that
  // zero out their per-test variables (e.g. `userForDelete = 0`)
  // after the route under test has already deleted the row. Without
  // this, the matching audit row was leaked on every run because the
  // cleanup loops below all guarded on `if (id)` and saw 0.
  const inserted = {
    leagues: [] as number[],
    teams: [] as number[],
    bowlerLeagues: [] as number[],
    payments: [] as number[],
    bowlers: [] as number[],
    users: [] as number[],
  };

  // High-water mark of the audit table at the start of every test, so we
  // can assert which audit rows (if any) were produced by the action
  // under test without depending on prior history.
  let auditWatermark = 0;

  // Captured at the start of `beforeAll`, used by the afterAll safety-net
  // delete. Even when the per-id registry loop misses a row (e.g. a flaky
  // worker termination interrupted the loop, or a future test variant
  // forgot to push into `inserted`), the time-windowed sweep below
  // catches every audit row this suite's admin authored during the run
  // and prevents leaks from reaching the global teardown tripwire (#629).
  // String form because `orphan_cleanup_audits.created_at` is declared
  // with `mode: "string"` in shared/schema/orphan-cleanup-audits.ts; the
  // drizzle column expects a string for comparisons.
  let suiteStartedAt = '1970-01-01 00:00:00';

  async function refreshWatermark() {
    // eslint-disable-next-line leaguevault/no-unscoped-table-query-in-test-assertion -- watermark sample of MAX(id) used to scope downstream queries; the watermark itself is not order-sensitive.
    const [row] = await db
      .select({ value: sql<number>`coalesce(max(${orphanCleanupAudits.id}), 0)::int` })
      .from(orphanCleanupAudits);
    auditWatermark = Number(row?.value ?? 0);
  }

  // Audit-row reads must be scoped to the resource we just operated on.
  // Sibling test files run concurrently and write their own audit rows
  // for unrelated resources; without scoping, those would leak into our
  // assertions. The watermark by itself is not enough because audit IDs
  // grow globally.
  async function newAuditRows(scope?: { resourceType: string; resourceId: number }) {
    const rows = await db
      .select()
      .from(orphanCleanupAudits)
      .where(gt(orphanCleanupAudits.id, auditWatermark))
      .orderBy(asc(orphanCleanupAudits.id));
    if (!scope) return rows;
    return rows.filter(
      (r) => r.resourceType === scope.resourceType && r.resourceId === scope.resourceId,
    );
  }

  beforeAll(async () => {
    // Captured BEFORE any login/insert so the safety-net sweep in
    // afterAll covers every audit row this suite could possibly create.
    suiteStartedAt = new Date().toISOString().replace('T', ' ').replace('Z', '');
    admin = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
    orgAdmin = await login(TEST_ORG_A_EMAIL, TEST_ORG_PASSWORD);

    // eslint-disable-next-line leaguevault/no-unscoped-table-query-in-test-assertion -- bootstrap pick of any seeded org; not a result asserted on for cardinality and the row is read-only.
    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .limit(1);
    if (!org) throw new Error('No organization available for audit tests');
    targetOrgId = org.id;

    // `leagues.organization_id` is nullable in the schema, so org-less
    // leagues are inserted directly. This suite never references a
    // non-existent parent league, so no FK bypass is needed. The two
    // org-less user rows are inserted via `insertOrphanUser`, which
    // briefly disables the `users_role_org_required` trigger inside a
    // single transaction.

    const leagueDefaults = {
      seasonStart: '2025-01-01 00:00:00',
      seasonEnd: '2025-12-31 00:00:00',
      weekDay: 'Monday' as const,
    };

    const insertOrphanLeague = async (name: string) => {
      const [row] = await db
        .insert(leagues)
        .values({ name, ...leagueDefaults, organizationId: null as unknown as number })
        .returning({ id: leagues.id });
      inserted.leagues.push(row.id);
      return row.id;
    };

    leagueForReassign = await insertOrphanLeague('Vitest Audit Orphan League (reassign)');
    leagueForDelete = await insertOrphanLeague('Vitest Audit Orphan League (delete)');
    parentOrphanLeagueId = await insertOrphanLeague('Vitest Audit Parent Orphan League');

    const [ln] = await db
      .insert(leagues)
      .values({
        name: 'Vitest Audit Non-Orphan League',
        ...leagueDefaults,
        organizationId: targetOrgId,
      })
      .returning({ id: leagues.id });
    nonOrphanLeagueId = ln.id;
    inserted.leagues.push(nonOrphanLeagueId);

    const [bw] = await db
      .insert(bowlers)
      .values({ name: 'Vitest Audit Bowler', organizationId: targetOrgId })
      .returning({ id: bowlers.id });
    bowlerId = bw.id;
    inserted.bowlers.push(bowlerId);

    const [t1] = await db
      .insert(teams)
      .values({ name: 'Vitest Audit Orphan Team', number: 9981, leagueId: parentOrphanLeagueId })
      .returning({ id: teams.id });
    teamForDelete = t1.id;
    inserted.teams.push(teamForDelete);

    const [bl1] = await db
      .insert(bowlerLeagues)
      .values({ bowlerId, leagueId: parentOrphanLeagueId, teamId: teamForDelete })
      .returning({ id: bowlerLeagues.id });
    bowlerLeagueForDelete = bl1.id;
    inserted.bowlerLeagues.push(bowlerLeagueForDelete);

    // Canonical payments require a valid tenant-owned league and bowler, so
    // an orphan payment cannot be staged for the retired repair endpoint.

    const pwd = await hashPassword('Throwaway-Password-123!');
    const stamp = Date.now();

    const u1 = await insertOrphanUser({
      email: `vitest-audit-orphan-reassign-${stamp}@example.com`,
      password: pwd,
      name: 'Vitest Audit Orphan User (reassign)',
      role: 'user',
    });
    userForReassign = u1.id;
    inserted.users.push(userForReassign);

    const u2 = await insertOrphanUser({
      email: `vitest-audit-orphan-delete-${stamp}@example.com`,
      password: pwd,
      name: 'Vitest Audit Orphan User (delete)',
      role: 'user',
    });
    userForDelete = u2.id;
    inserted.users.push(userForDelete);

    const [u3] = await db
      .insert(users)
      .values({
        email: `vitest-audit-nonorphan-${stamp}@example.com`,
        password: pwd,
        name: 'Vitest Audit Non-Orphan User',
        role: 'user',
        organizationId: targetOrgId,
      })
      .returning({ id: users.id });
    nonOrphanUserId = u3.id;
    inserted.users.push(nonOrphanUserId);
  });

  afterAll(async () => {
    // Cleanup contract:
    //  - Every row this suite inserted in `beforeAll` must be deleted
    //    here, OR have already been deleted by the route under test
    //    (in which case the matching DELETE here is a no-op).
    //  - Any failure to delete a row is loud — logged with table+id
    //    context AND collected so the suite fails at the end. The
    //    previous `catch { /* best effort */ }` silently leaked rows
    //    (and FK errors) into the dev database on every run.
    //  - All deletes are still attempted even when one fails, so a
    //    single bad row doesn't block the rest of cleanup.
    const failures: Array<{ label: string; error: unknown }> = [];
    const tryRun = async (label: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (error) {
        failures.push({ label, error });
        console.error(`[orphan-audits cleanup] ${label} failed:`, error);
      }
    };

    // Audit rows must go before the rows they reference, even though
    // `orphan_cleanup_audits.resource_id` is a plain integer column
    // (no FK), so that the audit table doesn't grow forever across
    // repeated runs against the same dev database. We iterate the
    // append-only `inserted` registry rather than the per-test
    // variables — those get zeroed by the success-path tests
    // (e.g. `userForDelete = 0`) and would otherwise hide their own
    // audit rows from cleanup.
    const auditTargets: Array<{ type: string; id: number }> = [
      ...inserted.leagues.map((id) => ({ type: 'leagues', id })),
      ...inserted.teams.map((id) => ({ type: 'teams', id })),
      ...inserted.bowlerLeagues.map((id) => ({ type: 'bowlerLeagues', id })),
      ...inserted.payments.map((id) => ({ type: 'payments', id })),
      ...inserted.users.map((id) => ({ type: 'users', id })),
    ];
    for (const { type, id } of auditTargets) {
      await tryRun(`orphan_cleanup_audits ${type}:${id}`, () =>
        db.delete(orphanCleanupAudits).where(and(
          eq(orphanCleanupAudits.resourceType, type),
          eq(orphanCleanupAudits.resourceId, id),
        )),
      );
    }

    // Safety net: the per-id loop above is the documented contract, but
    // it has historically leaked rows under full-suite runs (#636) when
    // a transient failure mid-loop or a registry-vs-route mismatch let
    // a single audit row escape. The global teardown tripwire (#629)
    // then fails the whole `npm test` invocation. To keep the contract
    // self-healing without weakening it, we follow up with an
    // unconditional sweep of any `orphan_cleanup_audits` row written by
    // *this suite's admin* between `suiteStartedAt` and now. The window
    // is tight enough to never touch rows from sibling suites and the
    // admin scope is the same admin that authored every audit row this
    // suite produced. (Note: the route-behavior describe block above
    // also runs with the same admin, but it executes in a different
    // beforeAll/afterAll lifecycle within the same file — its rows are
    // fully cleaned up by its own afterAll before this one runs.)
    if (admin?.user?.id) {
      await tryRun('orphan_cleanup_audits safety-net by admin+window', () =>
        db.delete(orphanCleanupAudits).where(and(
          eq(orphanCleanupAudits.adminUserId, admin.user.id),
          gte(orphanCleanupAudits.createdAt, suiteStartedAt),
        )),
      );
    }

    // Resource rows themselves. Children before parents.
    for (const id of inserted.users) {
      await tryRun(`users:${id}`, () => db.delete(users).where(eq(users.id, id)));
    }
    for (const id of inserted.payments) {
      await tryRun(`payments:${id}`, () => db.delete(payments).where(eq(payments.id, id)));
    }
    for (const id of inserted.bowlerLeagues) {
      await tryRun(`bowler_leagues:${id}`, () => db.delete(bowlerLeagues).where(eq(bowlerLeagues.id, id)));
    }
    for (const id of inserted.teams) {
      await tryRun(`teams:${id}`, () => db.delete(teams).where(eq(teams.id, id)));
    }
    for (const id of inserted.bowlers) {
      await tryRun(`bowlers:${id}`, () => db.delete(bowlers).where(eq(bowlers.id, id)));
    }
    for (const id of inserted.leagues) {
      await tryRun(`leagues:${id}`, () => db.delete(leagues).where(eq(leagues.id, id)));
    }

    if (failures.length > 0) {
      const summary = failures
        .map((f) => `  - ${f.label}: ${(f.error as Error)?.message ?? String(f.error)}`)
        .join('\n');
      throw new Error(
        `orphan-audits afterAll cleanup had ${failures.length} failure(s):\n${summary}`,
      );
    }
  });

  // -------------------------------------------------------------------
  // Failure paths: NO audit row may be written when the repair fails
  // -------------------------------------------------------------------

  describe('failure paths never write audit rows', () => {
    it('rejected reassign of a child resource type (teams) writes nothing', async () => {
      await refreshWatermark();
      const { status } = await apiPost(
        `/api/system-admin/orphaned-data/teams/${teamForDelete}/reassign`,
        { organizationId: targetOrgId },
        admin,
      );
      expect(status).toBe(400);
      expect(await newAuditRows({ resourceType: 'teams', resourceId: teamForDelete })).toEqual([]);
    });

    it('reassign of non-existent league (404) writes nothing', async () => {
      await refreshWatermark();
      const { status } = await apiPost(
        `/api/system-admin/orphaned-data/leagues/${BOGUS_LEAGUE_ID}/reassign`,
        { organizationId: targetOrgId },
        admin,
      );
      expect(status).toBe(404);
      expect(await newAuditRows({ resourceType: 'leagues', resourceId: BOGUS_LEAGUE_ID })).toEqual([]);
    });

    it('reassign of a non-orphan league (409) writes nothing', async () => {
      await refreshWatermark();
      const { status, data } = await apiPost(
        `/api/system-admin/orphaned-data/leagues/${nonOrphanLeagueId}/reassign`,
        { organizationId: targetOrgId },
        admin,
      );
      expect(status).toBe(409);
      expect(data.error?.code).toBe('NOT_ORPHANED');
      expect(await newAuditRows({ resourceType: 'leagues', resourceId: nonOrphanLeagueId })).toEqual([]);
    });

    it('reassign of a non-orphan user (409) writes nothing', async () => {
      await refreshWatermark();
      const { status } = await apiPost(
        `/api/system-admin/orphaned-data/users/${nonOrphanUserId}/reassign`,
        { organizationId: targetOrgId },
        admin,
      );
      expect(status).toBe(409);
      expect(await newAuditRows({ resourceType: 'users', resourceId: nonOrphanUserId })).toEqual([]);
    });

    it('delete of non-existent league (404) writes nothing', async () => {
      await refreshWatermark();
      const { status } = await apiPost(
        `/api/system-admin/orphaned-data/leagues/${BOGUS_LEAGUE_ID}/delete`,
        {},
        admin,
      );
      expect(status).toBe(404);
      expect(await newAuditRows({ resourceType: 'leagues', resourceId: BOGUS_LEAGUE_ID })).toEqual([]);
    });

    it('delete of non-existent team (404) writes nothing', async () => {
      await refreshWatermark();
      const { status } = await apiPost(
        `/api/system-admin/orphaned-data/teams/${BOGUS_LEAGUE_ID}/delete`,
        {},
        admin,
      );
      expect(status).toBe(404);
      expect(await newAuditRows({ resourceType: 'teams', resourceId: BOGUS_LEAGUE_ID })).toEqual([]);
    });

    it('delete of a non-orphan league (409) writes nothing', async () => {
      await refreshWatermark();
      const { status } = await apiPost(
        `/api/system-admin/orphaned-data/leagues/${nonOrphanLeagueId}/delete`,
        {},
        admin,
      );
      expect(status).toBe(409);
      expect(await newAuditRows({ resourceType: 'leagues', resourceId: nonOrphanLeagueId })).toEqual([]);
    });

    it('delete of a non-orphan user (409) writes nothing', async () => {
      await refreshWatermark();
      const { status } = await apiPost(
        `/api/system-admin/orphaned-data/users/${nonOrphanUserId}/delete`,
        {},
        admin,
      );
      expect(status).toBe(409);
      expect(await newAuditRows({ resourceType: 'users', resourceId: nonOrphanUserId })).toEqual([]);
    });

    it('unauthorized reassign (org admin, not system admin) writes nothing', async () => {
      await refreshWatermark();
      const { status } = await apiPost(
        `/api/system-admin/orphaned-data/leagues/${leagueForReassign}/reassign`,
        { organizationId: targetOrgId },
        orgAdmin,
      );
      expect(status).toBe(403);
      expect(await newAuditRows({ resourceType: 'leagues', resourceId: leagueForReassign })).toEqual([]);
    });

    it('unauthorized delete (org admin, not system admin) writes nothing', async () => {
      await refreshWatermark();
      const { status } = await apiPost(
        `/api/system-admin/orphaned-data/leagues/${leagueForDelete}/delete`,
        {},
        orgAdmin,
      );
      expect(status).toBe(403);
      expect(await newAuditRows({ resourceType: 'leagues', resourceId: leagueForDelete })).toEqual([]);
    });

    it('unauthenticated reassign writes nothing', async () => {
      await refreshWatermark();
      const { status } = await apiPost(
        `/api/system-admin/orphaned-data/leagues/${leagueForReassign}/reassign`,
        { organizationId: targetOrgId },
      );
      expect([401, 403]).toContain(status);
      expect(await newAuditRows({ resourceType: 'leagues', resourceId: leagueForReassign })).toEqual([]);
    });
  });

  // -------------------------------------------------------------------
  // Success paths: every repair on every resource type writes an audit
  // -------------------------------------------------------------------

  describe('success paths write a matching audit row', () => {
    it('reassigning an orphan league writes a reassign audit row', async () => {
      await refreshWatermark();
      const { status } = await apiPost(
        `/api/system-admin/orphaned-data/leagues/${leagueForReassign}/reassign`,
        { organizationId: targetOrgId },
        admin,
      );
      expect(status).toBe(200);

      const rows = await newAuditRows({ resourceType: 'leagues', resourceId: leagueForReassign });
      expect(rows.length).toBe(1);
      expect(rows[0]).toMatchObject({
        adminUserId: admin.user.id,
        resourceType: 'leagues',
        resourceId: leagueForReassign,
        action: 'reassign',
        organizationId: targetOrgId,
      });
    });

    it('reassigning an orphan user writes a reassign audit row', async () => {
      await refreshWatermark();
      const { status } = await apiPost(
        `/api/system-admin/orphaned-data/users/${userForReassign}/reassign`,
        { organizationId: targetOrgId },
        admin,
      );
      expect(status).toBe(200);

      const rows = await newAuditRows({ resourceType: 'users', resourceId: userForReassign });
      expect(rows.length).toBe(1);
      expect(rows[0]).toMatchObject({
        adminUserId: admin.user.id,
        resourceType: 'users',
        resourceId: userForReassign,
        action: 'reassign',
        organizationId: targetOrgId,
      });
    });

    it('deleting an orphan bowler-league writes a delete audit row', async () => {
      await refreshWatermark();
      const { status } = await apiPost(
        `/api/system-admin/orphaned-data/bowlerLeagues/${bowlerLeagueForDelete}/delete`,
        {},
        admin,
      );
      expect(status).toBe(200);

      const rows = await newAuditRows({ resourceType: 'bowlerLeagues', resourceId: bowlerLeagueForDelete });
      expect(rows.length).toBe(1);
      expect(rows[0]).toMatchObject({
        resourceType: 'bowlerLeagues',
        resourceId: bowlerLeagueForDelete,
        action: 'delete',
        organizationId: null,
      });
      bowlerLeagueForDelete = 0;
    });

    it('deleting an orphan team writes a delete audit row', async () => {
      await refreshWatermark();
      const { status } = await apiPost(
        `/api/system-admin/orphaned-data/teams/${teamForDelete}/delete`,
        {},
        admin,
      );
      expect(status).toBe(200);

      const rows = await newAuditRows({ resourceType: 'teams', resourceId: teamForDelete });
      expect(rows.length).toBe(1);
      expect(rows[0]).toMatchObject({
        resourceType: 'teams',
        resourceId: teamForDelete,
        action: 'delete',
        organizationId: null,
      });
      teamForDelete = 0;
    });

    it('deleting an orphan league writes a delete audit row', async () => {
      await refreshWatermark();
      const { status } = await apiPost(
        `/api/system-admin/orphaned-data/leagues/${leagueForDelete}/delete`,
        {},
        admin,
      );
      expect(status).toBe(200);

      const rows = await newAuditRows({ resourceType: 'leagues', resourceId: leagueForDelete });
      expect(rows.length).toBe(1);
      expect(rows[0]).toMatchObject({
        resourceType: 'leagues',
        resourceId: leagueForDelete,
        action: 'delete',
        organizationId: null,
      });
      leagueForDelete = 0;
    });

    it('deleting an orphan user writes a delete audit row', async () => {
      await refreshWatermark();
      const { status } = await apiPost(
        `/api/system-admin/orphaned-data/users/${userForDelete}/delete`,
        {},
        admin,
      );
      expect(status).toBe(200);

      const rows = await newAuditRows({ resourceType: 'users', resourceId: userForDelete });
      expect(rows.length).toBe(1);
      expect(rows[0]).toMatchObject({
        resourceType: 'users',
        resourceId: userForDelete,
        action: 'delete',
        organizationId: null,
      });
      userForDelete = 0;
    });
  });

  // -------------------------------------------------------------------
  // GET /orphaned-data-audits — listing, admin gating, limit clamp
  // -------------------------------------------------------------------

  describe('GET /api/system-admin/orphaned-data-audits', () => {
    it('rejects non-system-admin sessions with 403', async () => {
      const { status } = await apiGet('/api/system-admin/orphaned-data-audits', orgAdmin);
      expect(status).toBe(403);
    });

    it('rejects unauthenticated callers with 401 or 403', async () => {
      const { status } = await apiGet('/api/system-admin/orphaned-data-audits');
      expect([401, 403]).toContain(status);
    });

    it('returns recent audit rows hydrated with admin and org info', async () => {
      const { status, data } = await apiGet<CleanupAuditRowDTO[]>(
        '/api/system-admin/orphaned-data-audits',
        admin,
      );
      expect(status).toBe(200);
      const rows = data.data ?? [];
      expect(rows.length).toBeGreaterThan(0);

      const reassignRow = rows.find(
        (r) => r.resourceType === 'leagues' && r.resourceId === leagueForReassign && r.action === 'reassign',
      );
      if (!reassignRow) throw new Error('reassign audit row not found');
      expect(reassignRow.adminUserId).toBe(admin.user.id);
      expect(reassignRow.adminUserEmail?.toLowerCase()).toBe(admin.user.email.toLowerCase());
      expect(reassignRow.organizationId).toBe(targetOrgId);
      expect(reassignRow.organizationName).not.toBeNull();
    });

    it('orders results newest-first', async () => {
      const { data } = await apiGet<CleanupAuditRowDTO[]>(
        '/api/system-admin/orphaned-data-audits',
        admin,
      );
      const rows = data.data ?? [];
      // The endpoint orders by `createdAt DESC, id DESC`. With sibling
      // suites running in parallel, two inserts can land in the same
      // millisecond and the secondary id-tiebreaker takes over — so we
      // compare timestamps (primary) and fall back to id only when the
      // timestamps tie.
      for (let i = 1; i < rows.length; i++) {
        const prev = rows[i - 1];
        const curr = rows[i];
        const prevTs = new Date(prev.createdAt as unknown as string).getTime();
        const currTs = new Date(curr.createdAt as unknown as string).getTime();
        expect(prevTs).toBeGreaterThanOrEqual(currTs);
        if (prevTs === currTs) {
          expect(prev.id).toBeGreaterThanOrEqual(curr.id);
        }
      }
    });

    it('honors the limit query parameter', async () => {
      const { status, data } = await apiGet<CleanupAuditRowDTO[]>(
        '/api/system-admin/orphaned-data-audits?limit=1',
        admin,
      );
      expect(status).toBe(200);
      expect((data.data ?? []).length).toBeLessThanOrEqual(1);
    });

    it('clamps limits above the upper bound (200)', async () => {
      const { status, data } = await apiGet<CleanupAuditRowDTO[]>(
        '/api/system-admin/orphaned-data-audits?limit=99999',
        admin,
      );
      expect(status).toBe(200);
      expect((data.data ?? []).length).toBeLessThanOrEqual(200);
    });

    it('falls back to the default limit when the parameter is non-numeric', async () => {
      const { status, data } = await apiGet<CleanupAuditRowDTO[]>(
        '/api/system-admin/orphaned-data-audits?limit=not-a-number',
        admin,
      );
      expect(status).toBe(200);
      expect((data.data ?? []).length).toBeLessThanOrEqual(50);
    });
  });
});
