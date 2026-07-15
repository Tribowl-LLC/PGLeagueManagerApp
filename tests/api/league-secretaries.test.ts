/**
 * Task #735 — League Secretary grant/revoke + access-control isolation.
 *
 * Pins the security contract for the new per-league admin role:
 *   - org_admin of the league's org may grant + revoke
 *   - system_admin is REJECTED with 403 SYSTEM_ADMIN_DENIED
 *   - cross-org grant target is rejected with 422 USER_NOT_IN_ORG
 *   - already-admin target is rejected with 422 USER_ALREADY_ADMIN
 *   - duplicate grant is idempotent (no audit double-write)
 *   - revoke is idempotent-ish (404 when not present)
 *   - org A's org_admin cannot grant/revoke against org B's league
 *   - listing is visible to same-org admins and to current secretaries
 *   - a granted secretary user can read /api/me/league-secretary-leagues
 *     and only sees the leagues they were granted on
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../server/db';
import {
  users,
  leagues as leaguesTable,
  leagueSecretaries,
  leagueSecretaryAudits,
} from '@shared/schema';
import { hashPassword } from '../../server/lib/password';
import {
  login,
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
  TEST_ADMIN_EMAIL,
  TEST_ADMIN_PASSWORD,
  TEST_ORG_A_EMAIL,
  TEST_ORG_B_EMAIL,
  TEST_ORG_PASSWORD,
  type AuthSession,
} from '../helpers';

interface LeagueLite {
  id: number;
  organizationId: number | null;
}

interface SecretaryRow {
  id: number;
  userId: number;
  leagueId: number;
  organizationId: number;
}

const stamp = Date.now();

describe('League Secretary grants (Task #735)', () => {
  let sysAdmin: AuthSession;
  let orgAAdmin: AuthSession;
  let orgBAdmin: AuthSession;
  let orgAId: number;
  let orgBId: number;
  let orgALeagueId = 0;

  // Test users we provision directly via storage.
  let orgAUserPlainId = 0;
  let orgAUserOtherId = 0;
  let orgBUserPlainId = 0;
  let orgAOtherAdminId = 0;
  const createdUserIds: number[] = [];

  beforeAll(async () => {
    sysAdmin = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
    orgAAdmin = await login(TEST_ORG_A_EMAIL, TEST_ORG_PASSWORD);
    orgBAdmin = await login(TEST_ORG_B_EMAIL, TEST_ORG_PASSWORD);
    if (
      orgAAdmin.user.organizationId == null ||
      orgBAdmin.user.organizationId == null
    ) {
      throw new Error('Test fixture admins are missing organizationId');
    }
    orgAId = orgAAdmin.user.organizationId;
    orgBId = orgBAdmin.user.organizationId;

    // This suite renames and otherwise mutates its subject league. Own the
    // fixture so those mutations cannot leak into tests that depend on the
    // seeded baseline league's stable name.
    const [ownedLeague] = await db
      .insert(leaguesTable)
      .values({
        name: `Vitest Secretary League ${stamp}`,
        organizationId: orgAId,
        seasonStart: '2025-01-01',
        seasonEnd: '2099-12-31',
        weekDay: 'Monday',
      })
      .returning({ id: leaguesTable.id });
    orgALeagueId = ownedLeague.id;

    const password = await hashPassword('test-password-123!');
    const [u1] = await db
      .insert(users)
      .values({
        name: `Vitest Sec A1 ${stamp}`,
        email: `vitest-sec-a1-${stamp}@example.com`,
        password,
        role: 'user',
        organizationId: orgAId,
        bowlerId: null,
      })
      .returning();
    orgAUserPlainId = u1.id;
    createdUserIds.push(u1.id);

    const [u2] = await db
      .insert(users)
      .values({
        name: `Vitest Sec A2 ${stamp}`,
        email: `vitest-sec-a2-${stamp}@example.com`,
        password,
        role: 'user',
        organizationId: orgAId,
        bowlerId: null,
      })
      .returning();
    orgAUserOtherId = u2.id;
    createdUserIds.push(u2.id);

    const [u3] = await db
      .insert(users)
      .values({
        name: `Vitest Sec B1 ${stamp}`,
        email: `vitest-sec-b1-${stamp}@example.com`,
        password,
        role: 'user',
        organizationId: orgBId,
        bowlerId: null,
      })
      .returning();
    orgBUserPlainId = u3.id;
    createdUserIds.push(u3.id);

    const [u4] = await db
      .insert(users)
      .values({
        name: `Vitest Sec OrgAdmin ${stamp}`,
        email: `vitest-sec-orgadmin-${stamp}@example.com`,
        password,
        role: 'org_admin',
        organizationId: orgAId,
        bowlerId: null,
      })
      .returning();
    orgAOtherAdminId = u4.id;
    createdUserIds.push(u4.id);
  });

  afterAll(async () => {
    if (orgALeagueId > 0) {
      await db
        .delete(leagueSecretaryAudits)
        .where(eq(leagueSecretaryAudits.leagueId, orgALeagueId));
      await db
        .delete(leagueSecretaries)
        .where(eq(leagueSecretaries.leagueId, orgALeagueId));
    }
    if (createdUserIds.length > 0) {
      await db.delete(users).where(inArray(users.id, createdUserIds));
    }
    if (orgALeagueId > 0) {
      await db.delete(leaguesTable).where(eq(leaguesTable.id, orgALeagueId));
    }
  });

  describe('POST grant', () => {
    it('org_admin in same org may grant a plain user', async () => {
      const res = await apiPost<SecretaryRow>(
        `/api/leagues/${orgALeagueId}/secretaries`,
        { userId: orgAUserPlainId },
        orgAAdmin,
      );
      expect(res.status).toBe(201);
      expect(res.data.data?.userId).toBe(orgAUserPlainId);
      expect(res.data.data?.leagueId).toBe(orgALeagueId);
      expect(res.data.data?.organizationId).toBe(orgAId);

      const audit = await db
        .select()
        .from(leagueSecretaryAudits)
        .where(eq(leagueSecretaryAudits.targetUserId, orgAUserPlainId));
      expect(audit.length).toBe(1);
      expect(audit[0].action).toBe('grant');
    });

    it('duplicate grant is idempotent: returns 200, does not double-audit', async () => {
      const res = await apiPost<SecretaryRow>(
        `/api/leagues/${orgALeagueId}/secretaries`,
        { userId: orgAUserPlainId },
        orgAAdmin,
      );
      expect(res.status).toBe(200);
      const audit = await db
        .select()
        .from(leagueSecretaryAudits)
        .where(eq(leagueSecretaryAudits.targetUserId, orgAUserPlainId));
      expect(audit.length).toBe(1);
    });

    it('system_admin is REJECTED with 403 SYSTEM_ADMIN_DENIED', async () => {
      const res = await apiPost(
        `/api/leagues/${orgALeagueId}/secretaries`,
        { userId: orgAUserOtherId },
        sysAdmin,
      );
      expect(res.status).toBe(403);
      expect(res.data.error?.code).toBe('SYSTEM_ADMIN_DENIED');
    });

    it('cross-org org_admin (org B trying to grant on org A league) is forbidden', async () => {
      const res = await apiPost(
        `/api/leagues/${orgALeagueId}/secretaries`,
        { userId: orgBUserPlainId },
        orgBAdmin,
      );
      expect(res.status).toBe(403);
    });

    it('rejects target user from a different org with USER_NOT_IN_ORG', async () => {
      const res = await apiPost(
        `/api/leagues/${orgALeagueId}/secretaries`,
        { userId: orgBUserPlainId },
        orgAAdmin,
      );
      expect(res.status).toBe(422);
      expect(res.data.error?.code).toBe('USER_NOT_IN_ORG');
    });

    it('rejects already-admin target with USER_ALREADY_ADMIN', async () => {
      const res = await apiPost(
        `/api/leagues/${orgALeagueId}/secretaries`,
        { userId: orgAOtherAdminId },
        orgAAdmin,
      );
      expect(res.status).toBe(422);
      expect(res.data.error?.code).toBe('USER_ALREADY_ADMIN');
    });
  });

  describe('GET list', () => {
    it('same-org org_admin sees the granted user', async () => {
      const res = await apiGet<SecretaryRow[]>(
        `/api/leagues/${orgALeagueId}/secretaries`,
        orgAAdmin,
      );
      expect(res.status).toBe(200);
      const rows = Array.isArray(res.data.data) ? res.data.data : [];
      expect(rows.some((r) => r.userId === orgAUserPlainId)).toBe(true);
    });

    it('cross-org admin gets 403 listing the other org\'s league secretaries', async () => {
      const res = await apiGet(
        `/api/leagues/${orgALeagueId}/secretaries`,
        orgBAdmin,
      );
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/me/league-secretary-leagues', () => {
    it('newly granted secretary sees their league in My Leagues', async () => {
      const session = await login(
        `vitest-sec-a1-${stamp}@example.com`,
        'test-password-123!',
      );
      const res = await apiGet<LeagueLite[]>(
        '/api/me/league-secretary-leagues',
        session,
      );
      expect(res.status).toBe(200);
      const ids = Array.isArray(res.data.data) ? res.data.data.map((l) => l.id) : [];
      expect(ids).toContain(orgALeagueId);
    });
  });

  describe('DELETE revoke', () => {
    it('system_admin is REJECTED with 403 SYSTEM_ADMIN_DENIED', async () => {
      const res = await apiDelete(
        `/api/leagues/${orgALeagueId}/secretaries/${orgAUserPlainId}`,
        sysAdmin,
      );
      expect(res.status).toBe(403);
      expect(res.data.error?.code).toBe('SYSTEM_ADMIN_DENIED');
    });

    it('cross-org org_admin cannot revoke', async () => {
      const res = await apiDelete(
        `/api/leagues/${orgALeagueId}/secretaries/${orgAUserPlainId}`,
        orgBAdmin,
      );
      expect(res.status).toBe(403);
    });

    it('same-org org_admin can revoke and writes a revoke audit', async () => {
      const res = await apiDelete(
        `/api/leagues/${orgALeagueId}/secretaries/${orgAUserPlainId}`,
        orgAAdmin,
      );
      expect(res.status).toBe(200);
      const audit = await db
        .select()
        .from(leagueSecretaryAudits)
        .where(eq(leagueSecretaryAudits.targetUserId, orgAUserPlainId));
      expect(audit.some((a) => a.action === 'revoke')).toBe(true);
    });

    it('revoke of non-existent grant returns 404', async () => {
      const res = await apiDelete(
        `/api/leagues/${orgALeagueId}/secretaries/${orgAUserPlainId}`,
        orgAAdmin,
      );
      expect(res.status).toBe(404);
    });
  });

  describe('Secretary-aware route migration (Task #735 follow-up)', () => {
    let secretarySession: AuthSession;

    beforeAll(async () => {
      // Re-grant orgAUserPlainId on orgALeagueId (the earlier revoke
      // test removed the grant).
      await apiPost(
        `/api/leagues/${orgALeagueId}/secretaries`,
        { userId: orgAUserPlainId },
        orgAAdmin,
      );
      secretarySession = await login(
        `vitest-sec-a1-${stamp}@example.com`,
        'test-password-123!',
      );
    });

    it('secretary may list teams for their granted league', async () => {
      const res = await apiGet(
        `/api/teams?leagueId=${orgALeagueId}`,
        secretarySession,
      );
      expect(res.status).toBe(200);
    });

    it('secretary cannot list teams for a different league in the same org', async () => {
      // find a different league in org A; if only one exists, skip
      const all = await apiGet<LeagueLite[]>('/api/leagues', orgAAdmin);
      const others = (Array.isArray(all.data.data) ? all.data.data : [])
        .filter((l) => l.id !== orgALeagueId);
      if (others.length === 0) return;
      const otherLeagueId = others[0].id;
      const res = await apiGet(
        `/api/teams?leagueId=${otherLeagueId}`,
        secretarySession,
      );
      expect(res.status).toBe(403);
    });

    it('secretary cannot list teams across the org without a leagueId filter', async () => {
      const res = await apiGet<unknown[]>('/api/teams', secretarySession);
      expect(res.status).toBe(200);
      const teams = Array.isArray(res.data.data) ? res.data.data : [];
      // Whatever they see must be inside their granted leagueIds only.
      const granted = await apiGet<LeagueLite[]>(
        '/api/me/league-secretary-leagues',
        secretarySession,
      );
      const grantedIds = new Set(
        (Array.isArray(granted.data.data) ? granted.data.data : []).map((l) => l.id),
      );
      for (const t of teams as Array<{ leagueId: number }>) {
        expect(grantedIds.has(t.leagueId)).toBe(true);
      }
    });

    it('secretary cannot list payments for a league they were not granted on', async () => {
      const all = await apiGet<LeagueLite[]>('/api/leagues', orgAAdmin);
      const others = (Array.isArray(all.data.data) ? all.data.data : [])
        .filter((l) => l.id !== orgALeagueId);
      if (others.length === 0) return;
      const otherLeagueId = others[0].id;
      const res = await apiGet(
        `/api/payments?leagueId=${otherLeagueId}`,
        secretarySession,
      );
      expect(res.status).toBe(403);
    });

    it('secretary may list payments for their granted league', async () => {
      const res = await apiGet(
        `/api/payments?leagueId=${orgALeagueId}`,
        secretarySession,
      );
      expect(res.status).toBe(200);
    });

    it('secretary GET /api/leagues is scoped to granted leagues only (not org-wide)', async () => {
      const all = await apiGet<LeagueLite[]>('/api/leagues', orgAAdmin);
      const orgLeagueIds = (Array.isArray(all.data.data) ? all.data.data : []).map((l) => l.id);
      // Sanity: org A admin should see at least the granted league.
      expect(orgLeagueIds).toContain(orgALeagueId);

      const visible = await apiGet<LeagueLite[]>('/api/leagues', secretarySession);
      expect(visible.status).toBe(200);
      const visibleIds = (Array.isArray(visible.data.data) ? visible.data.data : []).map((l) => l.id);
      // Every visible id must be in the granted set; the secretary
      // must NOT see other org leagues purely by virtue of org
      // membership.
      const granted = await apiGet<LeagueLite[]>(
        '/api/me/league-secretary-leagues',
        secretarySession,
      );
      const grantedIds = new Set(
        (Array.isArray(granted.data.data) ? granted.data.data : []).map((l) => l.id),
      );
      for (const id of visibleIds) {
        expect(grantedIds.has(id)).toBe(true);
      }
    });

    it('moving a granted user to another org auto-revokes secretary access (drift protection)', async () => {
      // Create a fresh granted user so we can move them without
      // disturbing the other tests in this describe block.
      const driftEmail = `vitest-sec-drift-${stamp}@example.com`;
      const driftPassword = 'test-password-123!';
      const [driftUser] = await db
        .insert(users)
        .values({
          email: driftEmail,
          name: `Vitest Sec Drift ${stamp}`,
          password: await hashPassword(driftPassword),
          role: 'user',
          organizationId: orgAId,
        })
        .returning();
      createdUserIds.push(driftUser.id);
      const grantRes = await apiPost(
        `/api/leagues/${orgALeagueId}/secretaries`,
        { userId: driftUser.id },
        orgAAdmin,
      );
      expect(grantRes.status).toBe(201);
      const driftSession = await login(driftEmail, driftPassword);

      // Sanity: BEFORE the org move, the secretary can read the granted league.
      const before = await apiGet(`/api/leagues/${orgALeagueId}`, driftSession);
      expect(before.status).toBe(200);

      // Move the user to org B (direct DB write — no API surface allows
      // a non-system_admin to relocate themselves).
      await db
        .update(users)
        .set({ organizationId: orgBId })
        .where(eq(users.id, driftUser.id));

      // 1. The grant row was auto-revoked by the AFTER UPDATE trigger.
      const remaining = await db
        .select()
        .from(leagueSecretaries)
        .where(eq(leagueSecretaries.userId, driftUser.id));
      expect(remaining.length).toBe(0);

      // 2. The user's existing session still carries the old
      //    organizationId, but the access-control layer must not
      //    honour any (now-deleted) grant against an org they no
      //    longer belong to. Re-login to refresh the session and try
      //    again — both must be 403.
      const afterStaleSession = await apiGet(
        `/api/leagues/${orgALeagueId}`,
        driftSession,
      );
      expect(afterStaleSession.status).toBe(403);
      const refreshed = await login(driftEmail, driftPassword);
      const afterFresh = await apiGet(`/api/leagues/${orgALeagueId}`, refreshed);
      expect(afterFresh.status).toBe(403);
    });

    it('secretary PATCH allowlist: name allowed, locationId/active/payment-provider/organizationId forbidden', async () => {
      // Allowed field — name should succeed (200).
      const newName = `Secretary Rename ${stamp}`;
      const okRes = await apiPatch(
        `/api/leagues/${orgALeagueId}`,
        { name: newName },
        secretarySession,
      );
      expect(okRes.status).toBe(200);
      const nameCheck = await apiGet<{ name: string }>(
        `/api/leagues/${orgALeagueId}`,
        orgAAdmin,
      );
      expect(nameCheck.data.data?.name).toBe(newName);

      // Forbidden fields — each must come back 403 with the
      // SECRETARY_FORBIDDEN_FIELD code so the client knows it was an
      // authorization decision, not a validation failure.
      const forbiddenPayloads: Array<Record<string, unknown>> = [
        { locationId: 1 },
        { locationId: null },
        { active: false },
        { active: true },
        { organizationId: 999999 },
        { squareLineageItemId: 'item_x' },
        { lineageItemVariationId: 'var_x' },
        { squarePrizeFundItemId: 'item_y' },
        { prizeFundItemVariationId: 'var_y' },
        { squareCategoryId: 'cat_x' },
        // Mixed: even if one allowed field rides along, the request is rejected.
        { name: 'should-not-apply', locationId: null },
      ];
      for (const body of forbiddenPayloads) {
        const res = await apiPatch(`/api/leagues/${orgALeagueId}`, body, secretarySession);
        expect(res.status).toBe(403);
        expect((res.data as { error?: { code?: string } }).error?.code).toBe('SECRETARY_FORBIDDEN_FIELD');
      }

      // The mixed-payload allowed field must NOT have been applied.
      const reCheck = await apiGet<{ name: string }>(
        `/api/leagues/${orgALeagueId}`,
        orgAAdmin,
      );
      expect(reCheck.data.data?.name).toBe(newName);
    });

    it('secretary CANNOT delete/archive/restore the league (admin-only)', async () => {
      const archiveRes = await apiPatch(
        `/api/leagues/${orgALeagueId}/archive`,
        {},
        secretarySession,
      );
      expect(archiveRes.status).toBe(403);

      const restoreRes = await apiPatch(
        `/api/leagues/${orgALeagueId}/restore`,
        {},
        secretarySession,
      );
      expect(restoreRes.status).toBe(403);

      const deleteRes = await apiDelete(
        `/api/leagues/${orgALeagueId}`,
        secretarySession,
      );
      expect(deleteRes.status).toBe(403);

      // And the league still exists (archive/restore/delete were all rejected).
      const after = await apiGet<{ name: string; active: boolean }>(
        `/api/leagues/${orgALeagueId}`,
        orgAAdmin,
      );
      expect(after.status).toBe(200);
      expect(after.data.data?.active).toBe(true);
    });

    it('secretary GET /api/leagues/:id on a non-granted league returns 403', async () => {
      const all = await apiGet<LeagueLite[]>('/api/leagues', orgAAdmin);
      const others = (Array.isArray(all.data.data) ? all.data.data : [])
        .filter((l) => l.id !== orgALeagueId);
      if (others.length === 0) return;
      const res = await apiGet(`/api/leagues/${others[0].id}`, secretarySession);
      expect(res.status).toBe(403);
    });

    it('secretary GET /api/bowlers is SQL-scoped to granted leagues only (no cross-league leak)', async () => {
      const res = await apiGet<Array<{ id: number }>>('/api/bowlers', secretarySession);
      expect(res.status).toBe(200);
      const visibleBowlers = Array.isArray(res.data.data) ? res.data.data : [];

      // Resolve the union of bowler-ids actually rostered into the
      // secretary's granted leagues (via admin's view of bowler_leagues).
      const granted = await apiGet<LeagueLite[]>(
        '/api/me/league-secretary-leagues',
        secretarySession,
      );
      const grantedIds = new Set(
        (Array.isArray(granted.data.data) ? granted.data.data : []).map((l) => l.id),
      );

      // Admin's full org-A bowler list — anything in here that is NOT
      // in a granted league must NOT appear in `visibleBowlers`.
      const adminBowlers = await apiGet<Array<{ id: number }>>(
        '/api/bowlers',
        orgAAdmin,
      );
      const adminBowlerIds = new Set(
        (Array.isArray(adminBowlers.data.data) ? adminBowlers.data.data : []).map(
          (b) => b.id,
        ),
      );

      // Pull bowler→league mapping from the DB directly so the
      // assertion doesn't depend on any other route's scoping.
      const { bowlerLeagues: blTable } = await import('@shared/schema');
      const allBl = await db
        .select()
        .from(blTable)
        .where(inArray(blTable.bowlerId, [...adminBowlerIds]));
      const leaguesByBowler = new Map<number, Set<number>>();
      for (const bl of allBl) {
        const s = leaguesByBowler.get(bl.bowlerId) ?? new Set<number>();
        s.add(bl.leagueId);
        leaguesByBowler.set(bl.bowlerId, s);
      }

      for (const b of visibleBowlers) {
        const ls = leaguesByBowler.get(b.id) ?? new Set<number>();
        const overlap = [...ls].some((lid) => grantedIds.has(lid));
        expect(overlap).toBe(true);
      }

      const orgABowlersOutsideGrant = [...adminBowlerIds].filter((bid) => {
        const ls = leaguesByBowler.get(bid) ?? new Set<number>();
        if (ls.size === 0) return false;
        return ![...ls].some((lid) => grantedIds.has(lid));
      });
      const visibleIds = new Set(visibleBowlers.map((b) => b.id));
      for (const bid of orgABowlersOutsideGrant) {
        expect(visibleIds.has(bid)).toBe(false);
      }
    });

    it('secretary GET /api/bowlers/:id on a non-granted league bowler returns 403', async () => {
      // Find a bowler in org A who is not rostered into the secretary's
      // granted league. If the fixture has no such bowler the test
      // is a soft no-op (expected on minimal fixtures).
      const adminBowlers = await apiGet<Array<{ id: number }>>(
        '/api/bowlers',
        orgAAdmin,
      );
      const adminBowlerIds = (
        Array.isArray(adminBowlers.data.data) ? adminBowlers.data.data : []
      ).map((b) => b.id);
      if (adminBowlerIds.length === 0) return;
      const { bowlerLeagues: blTable2 } = await import('@shared/schema');
      const allBl = await db
        .select()
        .from(blTable2)
        .where(inArray(blTable2.bowlerId, adminBowlerIds));
      const blByBowler = new Map<number, Set<number>>();
      for (const bl of allBl) {
        const s = blByBowler.get(bl.bowlerId) ?? new Set<number>();
        s.add(bl.leagueId);
        blByBowler.set(bl.bowlerId, s);
      }
      const target = adminBowlerIds.find((bid) => {
        const ls = blByBowler.get(bid) ?? new Set<number>();
        return ls.size > 0 && !ls.has(orgALeagueId);
      });
      if (target == null) return;
      const res = await apiGet(`/api/bowlers/${target}`, secretarySession);
      expect(res.status).toBe(403);
    });

    it('secretary GET /api/locations returns 403 (org-level admin surface)', async () => {
      const res = await apiGet('/api/locations', secretarySession);
      expect(res.status).toBe(403);
    });

    it('secretary POST /api/payments-provider/customers on a granted-league team returns 403', async () => {
      // Find a team in the granted league. If none exist (minimal
      // fixture) the test is a soft no-op.
      const { teams: teamsTable } = await import('@shared/schema');
      const teamRows = await db
        .select()
        .from(teamsTable)
        .where(eq(teamsTable.leagueId, orgALeagueId))
        .limit(1);
      if (teamRows.length === 0) return;
      const res = await apiPost(
        '/api/payments-provider/customers',
        { teamId: teamRows[0].id, name: 'x', email: 'x@example.com' },
        secretarySession,
      );
      expect(res.status).toBe(403);
    });

    it('secretary listing /api/payments (no leagueId) is SQL-scoped to granted leagues only', async () => {
      const res = await apiGet<Array<{ leagueId: number }>>(
        '/api/payments',
        secretarySession,
      );
      expect(res.status).toBe(200);
      const granted = await apiGet<LeagueLite[]>(
        '/api/me/league-secretary-leagues',
        secretarySession,
      );
      const grantedIds = new Set(
        (Array.isArray(granted.data.data) ? granted.data.data : []).map((l) => l.id),
      );
      const rows = Array.isArray(res.data.data) ? res.data.data : [];
      for (const p of rows) {
        expect(grantedIds.has(p.leagueId)).toBe(true);
      }
    });
  });

  describe('DB invariant', () => {
    it('rejects an insert whose organization_id does not match the league', async () => {
      // Direct DB insert bypassing the route layer — should be blocked by
      // the BEFORE INSERT trigger in server/db-invariants.ts.
      let threw = false;
      try {
        await db.insert(leagueSecretaries).values({
          userId: orgAUserOtherId,
          leagueId: orgALeagueId,
          // Wrong org id (org B's id, while the league is in org A)
          organizationId: orgBId,
          grantedByUserId: orgAAdmin.user.id,
        });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    });
  });
});
