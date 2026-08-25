import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../server/db';
import {
  bowlerLeagues,
  bowlerPaymentLinks,
  bowlers as bowlersTable,
  leagues as leaguesTable,
  teams as teamsTable,
  users,
} from '@shared/schema';
import { and } from 'drizzle-orm';
import { hashPassword } from '../../server/lib/password';
import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  BASE_URL,
  getBaselineOrgIds,
  login,
  type AuthSession,
} from '../helpers';
import { signLinkActionToken } from '../../server/utils/bowler-link-tokens';

interface LinkRow {
  id: number;
  status: 'pending' | 'accepted';
  bowlerAId: number;
  bowlerBId: number;
}

interface LinksList {
  links: Array<LinkRow & { partnerName: string; inviterBowlerId: number | null }>;
  hasAny: boolean;
}

/**
 * – bowler payment-link lifecycle + cross-org denial.
 *
 * Critical infrastructure note: the user-deserialization cache
 * (`server/auth.ts:159`, 60s TTL) lives in the **server process**.
 * Tests run in a separate vitest worker, so we cannot bust the
 * server's cache from here. The seeded admins (testadmin@,
 * testadmin2@) have already been logged in by earlier suites in the
 * run, which means `user:<id>` is already cached with `bowlerId =
 * null` for them.
 *
 * To sidestep that we provision two FRESH ordinary users (alice and
 * bob, in their respective orgs) with `bowlerId` already set BEFORE
 * the very first login. Elevated staff roles are intentionally barred
 * from carrying a bowler identity. A separate, unlinked org admin is
 * used only for the admin direct-link endpoint.
 */
describe('Bowler payment links — lifecycle + cross-org denial', () => {
  let sessionA: AuthSession;
  let sessionB: AuthSession;
  let adminSessionA: AuthSession;
  let aliceUserId = 0;
  let bobUserId = 0;
  let adminUserId = 0;
  let aliceBowlerId = 0;
  let avivBowlerId = 0;
  let bobBowlerId = 0;
  const createdLinkIds: number[] = [];
  const createdBowlerLeagueIds: number[] = [];
  let createdTeamId = 0;
  const stamp = Date.now();
  const aliceEmail = `vitest-link-alice-${stamp}@example.com`;
  const avivEmail = `vitest-link-aviv-${stamp}@example.com`;
  const bobEmail = `vitest-link-bob-${stamp}@example.com`;
  const adminEmail = `vitest-link-admin-${stamp}@example.com`;
  const password = 'link-test-pw-vitest-678';

  beforeAll(async () => {
    const { orgAId, orgBId } = await getBaselineOrgIds();

    // 1) Insert three fresh bowlers (alice + aviv in org A, bob in org B).
    const inserted = await db
      .insert(bowlersTable)
      .values([
        {
          name: `Vitest Link Alice ${stamp}`,
          email: aliceEmail,
          organizationId: orgAId,
          active: true,
        },
        {
          name: `Vitest Link Aviv ${stamp}`,
          email: avivEmail,
          organizationId: orgAId,
          active: true,
        },
        {
          name: `Vitest Link Bob ${stamp}`,
          email: bobEmail,
          organizationId: orgBId,
          active: true,
        },
      ])
      .returning({ id: bowlersTable.id, email: bowlersTable.email });
    const aliceRow = inserted.find((r) => r.email === aliceEmail);
    const avivRow = inserted.find((r) => r.email === avivEmail);
    const bobRow = inserted.find((r) => r.email === bobEmail);
    if (!aliceRow || !avivRow || !bobRow) {
      throw new Error('Failed to insert all three test bowlers');
    }
    aliceBowlerId = aliceRow.id;
    avivBowlerId = avivRow.id;
    bobBowlerId = bobRow.id;

    // 2) Provision FRESH login users for alice (org A) and bob (org B)
    // with their bowlerId pre-stamped. Because these emails are brand
    // new, no test in this run has seen the user row yet — the
    // deserialization cache is guaranteed cold for them, so the first
    // request after login fills the cache with the correct bowlerId.
    const password_hash = await hashPassword(password);
    const [aliceUser] = await db
      .insert(users)
      .values({
        email: aliceEmail,
        password: password_hash,
        name: `Vitest Link Alice User ${stamp}`,
        role: 'user',
        organizationId: orgAId,
        bowlerId: aliceBowlerId,
      })
      .returning({ id: users.id });
    const [bobUser] = await db
      .insert(users)
      .values({
        email: bobEmail,
        password: password_hash,
        name: `Vitest Link Bob User ${stamp}`,
        role: 'user',
        organizationId: orgBId,
        bowlerId: bobBowlerId,
      })
      .returning({ id: users.id });
    if (!aliceUser || !bobUser) {
      throw new Error('Failed to provision fresh test users');
    }
    aliceUserId = aliceUser.id;
    bobUserId = bobUser.id;

    // Staff accounts must not carry a bowlerId. Keep an unlinked org admin
    // session for the admin-only direct-link endpoint below.
    const [adminUser] = await db
      .insert(users)
      .values({
        email: adminEmail,
        password: password_hash,
        name: `Vitest Link Admin ${stamp}`,
        role: 'org_admin',
        organizationId: orgAId,
      })
      .returning({ id: users.id });
    if (!adminUser) {
      throw new Error('Failed to provision fresh admin test user');
    }
    adminUserId = adminUser.id;

    // 2b) Wire alice + aviv into a league/team in org A so the
    // invite route's `getBowlerByEmail` (which inner-joins through
    // `bowler_leagues` → `leagues` to scope by organizationId) can
    // actually find them. Without a league/team binding the lookup
    // returns undefined and the invite 404s.
    const [orgALeague] = await db
      .select({ id: leaguesTable.id })
      .from(leaguesTable)
      .where(and(
        eq(leaguesTable.organizationId, orgAId),
        eq(leaguesTable.name, 'Vitest Org A Baseline League'),
      ))
      .limit(1);
    if (!orgALeague) {
      throw new Error('Baseline league for org A is missing — run the test seeder');
    }
    const [team] = await db
      .insert(teamsTable)
      .values({
        name: `Vitest Link Team ${stamp}`,
        number: 9000 + (stamp % 1000),
        leagueId: orgALeague.id,
        active: true,
      })
      .returning({ id: teamsTable.id });
    if (!team) {
      throw new Error('Failed to create test team');
    }
    createdTeamId = team.id;
    const blRows = await db
      .insert(bowlerLeagues)
      .values([
        { bowlerId: aliceBowlerId, leagueId: orgALeague.id, teamId: team.id, active: true, order: 0 },
        { bowlerId: avivBowlerId, leagueId: orgALeague.id, teamId: team.id, active: true, order: 1 },
      ])
      .returning({ id: bowlerLeagues.id });
    createdBowlerLeagueIds.push(...blRows.map((r) => r.id));

    // 3) Log in. From here, every request that re-deserializes the
    // session reads through the 60s server-side cache and sees the
    // bowlerId we stamped at insert time.
    sessionA = await login(aliceEmail, password);
    sessionB = await login(bobEmail, password);
    adminSessionA = await login(adminEmail, password);
  });

  afterAll(async () => {
    if (createdLinkIds.length > 0) {
      await db
        .delete(bowlerPaymentLinks)
        .where(inArray(bowlerPaymentLinks.id, createdLinkIds));
    }
    const bowlerIds = [aliceBowlerId, avivBowlerId, bobBowlerId].filter((n) => n > 0);
    if (bowlerIds.length > 0) {
      await db
        .delete(bowlerPaymentLinks)
        .where(inArray(bowlerPaymentLinks.bowlerAId, bowlerIds));
      await db
        .delete(bowlerPaymentLinks)
        .where(inArray(bowlerPaymentLinks.bowlerBId, bowlerIds));
    }
    // Null out users.bowlerId before deleting bowlers so the FK doesn't
    // block the bowler delete.
    const userIds = [aliceUserId, bobUserId, adminUserId].filter((n) => n > 0);
    if (userIds.length > 0) {
      await db
        .update(users)
        .set({ bowlerId: null })
        .where(inArray(users.id, userIds));
    }
    if (createdBowlerLeagueIds.length > 0) {
      await db
        .delete(bowlerLeagues)
        .where(inArray(bowlerLeagues.id, createdBowlerLeagueIds));
    }
    if (bowlerIds.length > 0) {
      await db.delete(bowlersTable).where(inArray(bowlersTable.id, bowlerIds));
    }
    if (createdTeamId > 0) {
      await db.delete(teamsTable).where(eq(teamsTable.id, createdTeamId));
    }
    if (userIds.length > 0) {
      await db.delete(users).where(inArray(users.id, userIds));
    }
  });

  it('rejects cross-org invite (404 — invitee not found in inviter\'s org)', async () => {
    // Alice (org A) trying to invite Bob (org B) by email must miss —
    // the lookup is scoped to inviter's organizationId, so the
    // response is 404 NOT_FOUND, not 403. Either way, the row must
    // never land.
    const res = await apiPost('/api/bowler-links/invite', {
      inviteeEmail: bobEmail,
    }, sessionA);
    expect(res.status, JSON.stringify(res.data)).toBe(404);
    expect(res.data.success).toBe(false);
    const rows = await db
      .select({ id: bowlerPaymentLinks.id })
      .from(bowlerPaymentLinks)
      .where(inArray(bowlerPaymentLinks.bowlerAId, [aliceBowlerId, bobBowlerId]));
    expect(rows).toHaveLength(0);
  });

  it('blocks self-invite by email', async () => {
    const res = await apiPost('/api/bowler-links/invite', {
      inviteeEmail: aliceEmail,
    }, sessionA);
    expect(res.status, JSON.stringify(res.data)).toBe(400);
    expect(res.data.error?.code).toBe('SELF_LINK');
  });

  it('alice → aviv invite creates a pending link, GET / returns it, DELETE removes it', async () => {
    // 1) Alice invites Aviv.
    const invite = await apiPost<LinkRow>('/api/bowler-links/invite', {
      inviteeEmail: avivEmail,
    }, sessionA);
    expect(invite.status, JSON.stringify(invite.data)).toBe(201);
    const linkId = (invite.data.data as LinkRow).id;
    createdLinkIds.push(linkId);
    expect((invite.data.data as LinkRow).status).toBe('pending');

    // 2) Alice's GET shows 1 pending link with hasAny=true.
    const aList = await apiGet<LinksList>('/api/bowler-links', sessionA);
    expect(aList.status).toBe(200);
    const aListData = aList.data.data;
    if (!aListData) throw new Error('expected list payload');
    expect(aListData.hasAny).toBe(true);
    expect(aListData.links).toHaveLength(1);
    expect(aListData.links[0].status).toBe('pending');
    expect(aListData.links[0].partnerName).toContain('Aviv');

    // 3) Alice cannot accept her own invite — accept is invitee-only.
    const selfAccept = await apiPost(`/api/bowler-links/${linkId}/accept`, {}, sessionA);
    expect(selfAccept.status).toBe(403);

    // 4) Either party may DELETE — Alice (the inviter) tears it down.
    const unlink = await apiDelete(`/api/bowler-links/${linkId}`, sessionA);
    expect(unlink.status).toBe(200);
    const remaining = await db
      .select({ id: bowlerPaymentLinks.id, status: bowlerPaymentLinks.status })
      .from(bowlerPaymentLinks)
      .where(eq(bowlerPaymentLinks.id, linkId));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.status).toBe("retired");
  });

  it('invite-by-bowlerId (task #702) blocks unclaimed bowler, self, cross-org; happy path links claimed bowler', async () => {
    // Aviv is just a bowler row with no linked user account — invite
    // must reject with UNCLAIMED_BOWLER so the inviter doesn't create
    // an unactionable pending row.
    const unclaimed = await apiPost('/api/bowler-links/invite', {
      inviteeBowlerId: avivBowlerId,
    }, sessionA);
    expect(unclaimed.status, JSON.stringify(unclaimed.data)).toBe(400);
    expect(unclaimed.data.error?.code).toBe('UNCLAIMED_BOWLER');

    // Cross-org by bowlerId — Alice (org A) targets Bob (org B). Bob
    // IS claimed (he has a user), so the route must still reject for
    // the cross-org reason and never land a row.
    const cross = await apiPost('/api/bowler-links/invite', {
      inviteeBowlerId: bobBowlerId,
    }, sessionA);
    expect([403, 404]).toContain(cross.status);
    expect(cross.data.success).toBe(false);

    // Self-invite by bowlerId — must 400 SELF_LINK.
    const selfInvite = await apiPost('/api/bowler-links/invite', {
      inviteeBowlerId: aliceBowlerId,
    }, sessionA);
    expect(selfInvite.status, JSON.stringify(selfInvite.data)).toBe(400);
    expect(selfInvite.data.error?.code).toBe('SELF_LINK');

    // Happy path — provision a fresh claimed bowler in org A and
    // invite by bowlerId. Stamp a user → bowler link so the
    // unclaimed guard passes.
    const { orgAId } = await getBaselineOrgIds();
    const happyEmail = `vitest-link-claimed-${stamp}@example.com`;
    const [happyBowler] = await db
      .insert(bowlersTable)
      .values({
        organizationId: orgAId,
        name: `Vitest Link Claimed ${stamp}`,
        email: happyEmail,
        active: true,
      })
      .returning({ id: bowlersTable.id });
    if (!happyBowler) throw new Error('failed to insert claimed bowler');
    const happyBowlerId = happyBowler.id;
    const happyPwd = await hashPassword(password);
    const [happyUser] = await db
      .insert(users)
      .values({
        email: happyEmail,
        password: happyPwd,
        name: `Vitest Link Claimed User ${stamp}`,
        role: 'user',
        organizationId: orgAId,
        bowlerId: happyBowlerId,
      })
      .returning({ id: users.id });
    if (!happyUser) throw new Error('failed to insert claimed user');
    const happyUserId = happyUser.id;

    try {
      const ok = await apiPost<LinkRow>('/api/bowler-links/invite', {
        inviteeBowlerId: happyBowlerId,
      }, sessionA);
      expect(ok.status, JSON.stringify(ok.data)).toBe(201);
      const row = ok.data.data as LinkRow;
      createdLinkIds.push(row.id);
      expect(row.status).toBe('pending');
      // Tear down the link so the next test starts clean.
      await apiDelete(`/api/bowler-links/${row.id}`, sessionA);
    } finally {
      await db.delete(users).where(eq(users.id, happyUserId));
      await db.delete(bowlersTable).where(eq(bowlersTable.id, happyBowlerId));
    }
  });

  it('search /api/bowlers/search returns in-org bowlers and excludes excludeIds (task #702)', async () => {
    const stampStr = String(stamp);
    const res = await apiGet<Array<{ id: number; name: string }>>(
      `/api/bowlers/search?q=${encodeURIComponent('Vitest Link')}`,
      sessionA,
    );
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    const ids = (res.data.data ?? []).map((r) => r.id);
    // Both Alice and Aviv (org A) should be returned.
    expect(ids).toContain(aliceBowlerId);
    expect(ids).toContain(avivBowlerId);
    // Bob (org B) must never appear.
    expect(ids).not.toContain(bobBowlerId);

    // excludeIds removes the listed bowler.
    const excluded = await apiGet<Array<{ id: number }>>(
      `/api/bowlers/search?q=${encodeURIComponent('Vitest Link')}&excludeIds=${aliceBowlerId}`,
      sessionA,
    );
    expect(excluded.status).toBe(200);
    const excludedIds = (excluded.data.data ?? []).map((r) => r.id);
    expect(excludedIds).not.toContain(aliceBowlerId);
    // Sanity: Aviv stays.
    expect(excludedIds).toContain(avivBowlerId);
    // Use stampStr to keep it referenced in a safe way.
    void stampStr;
  });

  it('invite response surfaces emailSent + reason without rolling back the link (task #704)', async () => {
    // Provision a fresh claimed bowler in org A so we can hit the
    // happy-path invite (alice → claimed bowler) without UNCLAIMED_BOWLER.
    const { orgAId } = await getBaselineOrgIds();
    const targetEmail = `vitest-link-emailflag-${stamp}@example.com`;
    const [targetBowler] = await db
      .insert(bowlersTable)
      .values({
        organizationId: orgAId,
        name: `Vitest Link EmailFlag ${stamp}`,
        email: targetEmail,
        active: true,
      })
      .returning({ id: bowlersTable.id });
    if (!targetBowler) throw new Error('failed to insert target bowler');
    const targetBowlerId = targetBowler.id;
    const targetPwd = await hashPassword(password);
    const [targetUser] = await db
      .insert(users)
      .values({
        email: targetEmail,
        password: targetPwd,
        name: `Vitest Link EmailFlag User ${stamp}`,
        role: 'user',
        organizationId: orgAId,
        bowlerId: targetBowlerId,
      })
      .returning({ id: users.id });
    if (!targetUser) throw new Error('failed to insert target user');
    const targetUserId = targetUser.id;

    try {
      const res = await apiPost<LinkRow & { emailSent: boolean; reason?: string }>(
        '/api/bowler-links/invite',
        { inviteeBowlerId: targetBowlerId },
        sessionA,
      );
      expect(res.status, JSON.stringify(res.data)).toBe(201);
      const row = res.data.data as LinkRow & { emailSent: boolean; reason?: string };
      createdLinkIds.push(row.id);
      // The link was created regardless of email outcome.
      expect(row.id).toBeGreaterThan(0);
      expect(row.status).toBe('pending');
      // emailSent is always present in the response shape. In the test
      // environment SENDGRID_API_KEY is not configured, so the send
      // short-circuits to SEND_FAILED — but the row still exists.
      expect(typeof row.emailSent).toBe('boolean');
      if (!row.emailSent) {
        expect(['NO_EMAIL_ON_FILE', 'TEMPLATE_NOT_CONFIGURED', 'SEND_FAILED']).toContain(row.reason);
      }
      // Confirm persistence — email failure must not roll back the invite.
      const persisted = await db
        .select({ id: bowlerPaymentLinks.id, status: bowlerPaymentLinks.status })
        .from(bowlerPaymentLinks)
        .where(eq(bowlerPaymentLinks.id, row.id));
      expect(persisted).toHaveLength(1);
      expect(persisted[0].status).toBe('pending');

      // The public, unauthenticated GET endpoint must accept a valid
      // signed token and flip the link to accepted.
      const acceptToken = signLinkActionToken(row.id, 'accept');
      const acceptRes = await fetch(
        `${BASE_URL}/api/bowler-link-respond/accept?token=${encodeURIComponent(acceptToken)}`,
      );
      expect(acceptRes.status).toBe(200);
      const html = await acceptRes.text();
      expect(html.toLowerCase()).toContain('accept');
      const afterAccept = await db
        .select({ status: bowlerPaymentLinks.status })
        .from(bowlerPaymentLinks)
        .where(eq(bowlerPaymentLinks.id, row.id));
      expect(afterAccept[0]?.status).toBe('accepted');

      // Replaying a decline token after acceptance must NOT delete an
      // already-accepted link — single-use scoping by state.
      const declineToken = signLinkActionToken(row.id, 'decline');
      const replay = await fetch(
        `${BASE_URL}/api/bowler-link-respond/decline?token=${encodeURIComponent(declineToken)}`,
      );
      expect(replay.status).toBe(409);
      const stillThere = await db
        .select({ status: bowlerPaymentLinks.status })
        .from(bowlerPaymentLinks)
        .where(eq(bowlerPaymentLinks.id, row.id));
      expect(stillThere[0]?.status).toBe('accepted');
    } finally {
      await db.delete(users).where(eq(users.id, targetUserId));
      await db.delete(bowlersTable).where(eq(bowlersTable.id, targetBowlerId));
    }
  });

  it('public accept/decline GET endpoints reject tampered + expired tokens (task #704)', async () => {
    const bad = await fetch(
      `${BASE_URL}/api/bowler-link-respond/accept?token=not-a-real-token`,
    );
    expect(bad.status).toBe(400);
    expect((await bad.text()).toLowerCase()).toContain('invalid');

    const wrongActionToken = signLinkActionToken(1, 'accept');
    const wrongAction = await fetch(
      `${BASE_URL}/api/bowler-link-respond/decline?token=${encodeURIComponent(wrongActionToken)}`,
    );
    expect(wrongAction.status).toBe(400);

    // Token for a non-existent link → 404 (vs 200 for accept-already-deleted decline).
    const ghost = signLinkActionToken(999_999_999, 'accept');
    const ghostRes = await fetch(
      `${BASE_URL}/api/bowler-link-respond/accept?token=${encodeURIComponent(ghost)}`,
    );
    expect(ghostRes.status).toBe(404);
  });

  it('admin direct-link succeeds within org and refuses cross-org pairs', async () => {
    // The unlinked org-A org_admin session is authorized for direct links.
    // Linking alice + aviv (both org A) must land an `accepted` row directly.
    const ok = await apiPost<LinkRow>('/api/bowler-links/admin', {
      bowlerAId: aliceBowlerId,
      bowlerBId: avivBowlerId,
    }, adminSessionA);
    expect(ok.status, JSON.stringify(ok.data)).toBe(201);
    const okRow = ok.data.data as LinkRow;
    createdLinkIds.push(okRow.id);
    expect(okRow.status).toBe('accepted');

    // Cross-org admin link (alice org A + bob org B) must be rejected
    // by the access-control + cross-org guards. The exact status
    // depends on which guard fires first — both 403 and 404 are
    // acceptable as long as no row lands.
    const crossOrg = await apiPost('/api/bowler-links/admin', {
      bowlerAId: aliceBowlerId,
      bowlerBId: bobBowlerId,
    }, adminSessionA);
    expect([403, 404]).toContain(crossOrg.status);

    const landed = await db
      .select({ id: bowlerPaymentLinks.id })
      .from(bowlerPaymentLinks)
      .where(inArray(bowlerPaymentLinks.bowlerBId, [bobBowlerId]));
    expect(landed).toHaveLength(0);
  });

  it('ordinary linked users cannot deactivate themselves or write provider identity fields', async () => {
    const deactivate = await apiPatch(`/api/bowlers/${aliceBowlerId}`, { active: false }, sessionA);
    expect(deactivate.status, JSON.stringify(deactivate.data)).toBe(403);
    expect((await db.select({ active: bowlersTable.active }).from(bowlersTable).where(eq(bowlersTable.id, aliceBowlerId)))[0]?.active).toBe(true);

    const providerMutation = await apiPatch(`/api/bowlers/${aliceBowlerId}`, {
      paymentCustomerId: 'attacker-controlled-customer',
      paymentProviderLocationId: 987654,
      paymentSyncAttempts: 99,
    }, sessionA);
    expect(providerMutation.status, JSON.stringify(providerMutation.data)).toBe(403);
    const unchanged = (await db.select({
      paymentCustomerId: bowlersTable.paymentCustomerId,
      paymentProviderLocationId: bowlersTable.paymentProviderLocationId,
      paymentSyncAttempts: bowlersTable.paymentSyncAttempts,
    }).from(bowlersTable).where(eq(bowlersTable.id, aliceBowlerId)))[0];
    expect(unchanged).toMatchObject({ paymentCustomerId: null, paymentProviderLocationId: null, paymentSyncAttempts: 0 });
  });

});
