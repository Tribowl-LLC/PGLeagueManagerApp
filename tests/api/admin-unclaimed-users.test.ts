import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../server/db';
import {
  users,
  bowlers as bowlersTable,
  bowlerLeagues,
  teams as teamsTable,
  leagues as leaguesTable,
  locations as locationsTable,
  teamPaymentSlots,
} from '@shared/schema';
import { hashPassword } from '../../server/lib/password';
import {
  login,
  apiGet,
  apiPost,
  apiDelete,
  TEST_ORG_A_EMAIL,
  TEST_ORG_B_EMAIL,
  TEST_ORG_PASSWORD,
  type AuthSession,
} from '../helpers';

interface UnclaimedUserRow {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  organizationId: number | null;
}

interface CreateBowlerOk {
  userId: number;
  bowlerId: number;
  leagueId: number;
  teamId: number;
}

/**
 * Task #667 — admin claim of self-registered users.
 *
 * The routes under test live at:
 *   GET  /api/admin/unclaimed-users
 *   POST /api/admin/unclaimed-users/:userId/create-bowler
 *   POST /api/admin/unclaimed-users/:userId/link-existing
 *
 * Coverage goals:
 *   - List endpoint is org-scoped (org A admin never sees org B users).
 *   - Create-bowler creates a bowler row + bowler_leagues + sets
 *     users.bowlerId atomically; refuses already-linked users.
 *   - Link-existing links to an unlinked bowler in the same org and
 *     refuses cross-org bowlers and bowlers already taken by another user.
 *   - Cross-org user targets are denied (no enumeration via the route).
 */
describe('Admin claim of self-registered users (Task #667)', () => {
  let sessionA: AuthSession;
  let sessionB: AuthSession;
  let orgAId: number;
  let orgBId: number;
  let leagueId: number;
  let teamId: number;
  const stamp = Date.now();
  const uniqueTeamNumber = (stamp % 90000) + 10000;

  const createdUserIds: number[] = [];
  const createdBowlerIds: number[] = [];
  const createdBowlerLeagueIds: number[] = [];
  let createdTeamId: number | null = null;

  /** Insert a self-registered user directly: bowlerId=null, role='user'. */
  async function insertUnclaimedUser(opts: {
    organizationId: number;
    label: string;
  }): Promise<UnclaimedUserRow> {
    const password = await hashPassword('test-password-123!');
    const [row] = await db
      .insert(users)
      .values({
        name: `Vitest Unclaimed ${opts.label}`,
        email: `vitest-unclaimed-${stamp}-${opts.label}@example.com`,
        password,
        role: 'user',
        organizationId: opts.organizationId,
        bowlerId: null,
      })
      .returning();
    createdUserIds.push(row.id);
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      phone: row.phone ?? null,
      organizationId: row.organizationId,
    };
  }

  beforeAll(async () => {
    sessionA = await login(TEST_ORG_A_EMAIL, TEST_ORG_PASSWORD);
    sessionB = await login(TEST_ORG_B_EMAIL, TEST_ORG_PASSWORD);
    if (sessionA.user.organizationId == null || sessionB.user.organizationId == null) {
      throw new Error('Test fixture admins are missing organizationId');
    }
    orgAId = sessionA.user.organizationId;
    orgBId = sessionB.user.organizationId;

    // Need an org A league + a fresh team so we can route create-bowler to it.
    const leaguesRes = await apiGet<Array<{ id: number; name: string }>>('/api/leagues', sessionA);
    expect(leaguesRes.status).toBe(200);
    const leagues = Array.isArray(leaguesRes.data.data) ? leaguesRes.data.data : [];
    if (leagues.length > 0) {
      leagueId = leagues[0].id;
    } else {
      // Retained test fixtures are canonical-only. Seed a small canonical
      // league when the shared org has only discarded legacy schedules.
      const [location] = await db.select({ id: locationsTable.id })
        .from(locationsTable)
        .where(eq(locationsTable.organizationId, orgAId))
        .limit(1);
      let setupLocation = location;
      if (!setupLocation) {
        const [createdLocation] = await db.insert(locationsTable).values({
          name: `Vitest Unclaimed Canonical Lanes ${stamp}`,
          organizationId: orgAId,
        }).returning({ id: locationsTable.id });
        setupLocation = createdLocation;
      }
      if (!setupLocation) throw new Error('canonical league setup location was not created');
      const created = await apiPost<{ id: number }>('/api/leagues', {
        name: `Vitest Unclaimed Canonical League ${stamp}`,
        description: null,
        payingLineupSize: 4,
        active: true,
        allowPublicSignup: false,
        seasonStart: '2035-09-03',
        totalBowlingWeeks: 4,
        weekDay: 'Monday',
        skipDates: [],
        cancelledDates: [],
        doublePayDates: [],
        competitionStartTime: '19:00',
        timezone: 'America/New_York',
        weeklyFee: 2000,
        paymentMode: 'weekly',
        locationId: setupLocation.id,
        setupIntegration: {
          contractVersion: 'league-setup-integration-request/3',
          idempotencyKey: `10000000-0000-4000-8000-${String(stamp).slice(-12).padStart(12, '0')}`,
        },
      }, sessionA);
      expect(created.status).toBe(201);
      const createdLeague = created.data.data;
      if (!createdLeague || typeof createdLeague.id !== 'number') {
        throw new Error('canonical league setup did not return a league id');
      }
      leagueId = createdLeague.id;
    }

    const teamRes = await apiPost<{ id: number }>(
      '/api/teams',
      {
        name: `Vitest Unclaimed Team ${stamp}`,
        number: uniqueTeamNumber,
        leagueId,
        active: true,
      },
      sessionA,
    );
    expect(teamRes.status).toBe(201);
    teamId = (teamRes.data.data as { id: number }).id;
    createdTeamId = teamId;
  });

  afterAll(async () => {
    // Tear down everything this suite created. Order matters because of FKs.
    const failures: Array<{ label: string; err: unknown }> = [];
    const tryRun = async (label: string, fn: () => Promise<unknown>) => {
      try { await fn(); } catch (err) { failures.push({ label, err }); }
    };

    if (createdUserIds.length > 0) {
      await tryRun('users.bowlerId=null', () =>
        db.update(users).set({ bowlerId: null }).where(inArray(users.id, createdUserIds)));
    }
    if (createdBowlerLeagueIds.length > 0) {
      await tryRun('bowler_leagues', () =>
        db.delete(bowlerLeagues).where(inArray(bowlerLeagues.id, createdBowlerLeagueIds)));
    }
    if (createdBowlerIds.length > 0) {
      // Also drop any bowler_leagues attached to bowlers we created (the
      // create-bowler route inserts one inside the txn — capture them here
      // by bowler id rather than expecting the test to track it).
      await tryRun('bowler_leagues by bowlerId', () =>
        db.delete(bowlerLeagues).where(inArray(bowlerLeagues.bowlerId, createdBowlerIds)));
      await tryRun('bowlers', () =>
        db.delete(bowlersTable).where(inArray(bowlersTable.id, createdBowlerIds)));
    }
    if (createdUserIds.length > 0) {
      await tryRun('users', () => db.delete(users).where(inArray(users.id, createdUserIds)));
    }
    if (createdTeamId != null) {
      const id = createdTeamId;
      await tryRun('team_payment_slots', () =>
        db.delete(teamPaymentSlots).where(eq(teamPaymentSlots.teamId, id)),
      );
      await tryRun('teams', () => db.delete(teamsTable).where(eq(teamsTable.id, id)));
    }

    if (failures.length > 0) {
      const summary = failures
        .map((f) => `  - ${f.label}: ${(f.err as Error)?.message ?? String(f.err)}`)
        .join('\n');
      throw new Error(`admin-unclaimed-users cleanup failures:\n${summary}`);
    }
  });

  it('GET /unclaimed-users lists org A users only — never org B users', async () => {
    const userA = await insertUnclaimedUser({ organizationId: orgAId, label: 'list-A' });
    const userB = await insertUnclaimedUser({ organizationId: orgBId, label: 'list-B' });

    const res = await apiGet<UnclaimedUserRow[]>('/api/admin/unclaimed-users', sessionA);
    expect(res.status).toBe(200);
    const ids = (res.data.data ?? []).map((u) => u.id);
    expect(ids).toContain(userA.id);
    expect(ids).not.toContain(userB.id);
  });

  it('POST /create-bowler atomically creates a bowler, links it to the team, and sets users.bowlerId', async () => {
    const user = await insertUnclaimedUser({ organizationId: orgAId, label: 'create' });

    const res = await apiPost<CreateBowlerOk>(
      `/api/admin/unclaimed-users/${user.id}/create-bowler`,
      { leagueId, teamId },
      sessionA,
    );
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect(res.data.success).toBe(true);
    const out = res.data.data;
    if (!out) throw new Error('expected create-bowler to return data');
    expect(out.userId).toBe(user.id);
    expect(out.leagueId).toBe(leagueId);
    expect(out.teamId).toBe(teamId);
    createdBowlerIds.push(out.bowlerId);

    // user.bowlerId now points at the new bowler.
    const [reread] = await db.select({ bowlerId: users.bowlerId }).from(users).where(eq(users.id, user.id));
    expect(reread.bowlerId).toBe(out.bowlerId);

    // Bowler exists, org-stamped, with a bowler_leagues row on the team.
    const [bowler] = await db.select().from(bowlersTable).where(eq(bowlersTable.id, out.bowlerId));
    expect(bowler.organizationId).toBe(orgAId);
    expect(bowler.email).toBe(user.email);
    const links = await db.select().from(bowlerLeagues).where(eq(bowlerLeagues.bowlerId, out.bowlerId));
    expect(links).toHaveLength(1);
    expect(links[0].teamId).toBe(teamId);
    expect(links[0].leagueId).toBe(leagueId);
  });

  it('POST /create-bowler returns 409 ALREADY_LINKED when the user already has a bowlerId', async () => {
    const user = await insertUnclaimedUser({ organizationId: orgAId, label: 'already-linked' });

    // First call links; capture the bowler so cleanup can drop it.
    const first = await apiPost<CreateBowlerOk>(
      `/api/admin/unclaimed-users/${user.id}/create-bowler`,
      { leagueId, teamId },
      sessionA,
    );
    expect(first.status).toBe(200);
    const firstData = first.data.data;
    if (!firstData) throw new Error('expected first create-bowler to return data');
    createdBowlerIds.push(firstData.bowlerId);

    // Second call must refuse.
    const second = await apiPost(
      `/api/admin/unclaimed-users/${user.id}/create-bowler`,
      { leagueId, teamId },
      sessionA,
    );
    expect(second.status).toBe(409);
    expect(second.data.error?.code).toBe('ALREADY_LINKED');
  });

  it('POST /create-bowler refuses cross-org user targets (org A admin → org B user → 403)', async () => {
    const userB = await insertUnclaimedUser({ organizationId: orgBId, label: 'xorg-create' });

    const res = await apiPost(
      `/api/admin/unclaimed-users/${userB.id}/create-bowler`,
      { leagueId, teamId },
      sessionA,
    );
    expect(res.status).toBe(403);
    expect(res.data.error?.code).toBe('CROSS_ORG_DENIED');

    // Defense in depth — user is still unlinked.
    const [reread] = await db.select({ bowlerId: users.bowlerId }).from(users).where(eq(users.id, userB.id));
    expect(reread.bowlerId).toBeNull();
  });

  it('POST /link-existing links to an unlinked bowler in the same org', async () => {
    const user = await insertUnclaimedUser({ organizationId: orgAId, label: 'link-existing' });

    // Insert an unlinked bowler in org A directly (no email so it'd appear
    // on /api/bowlers/unlinked too, but the admin route doesn't require that
    // — any unlinked bowler in the org is eligible).
    const [bowler] = await db
      .insert(bowlersTable)
      .values({
        name: `Vitest Existing Bowler ${stamp}-link`,
        email: '',
        active: true,
        organizationId: orgAId,
      })
      .returning();
    createdBowlerIds.push(bowler.id);

    const res = await apiPost<CreateBowlerOk>(
      `/api/admin/unclaimed-users/${user.id}/link-existing`,
      { bowlerId: bowler.id, leagueId, teamId },
      sessionA,
    );
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    const linkData = res.data.data;
    if (!linkData) throw new Error('expected link-existing to return data');
    expect(linkData.bowlerId).toBe(bowler.id);

    const [reread] = await db.select({ bowlerId: users.bowlerId }).from(users).where(eq(users.id, user.id));
    expect(reread.bowlerId).toBe(bowler.id);

    const links = await db.select().from(bowlerLeagues).where(eq(bowlerLeagues.bowlerId, bowler.id));
    expect(links.length).toBe(1);
  });

  it('POST /link-existing returns 409 BOWLER_TAKEN when the bowler already belongs to another user', async () => {
    const userOne = await insertUnclaimedUser({ organizationId: orgAId, label: 'taken-1' });
    const userTwo = await insertUnclaimedUser({ organizationId: orgAId, label: 'taken-2' });

    const [bowler] = await db
      .insert(bowlersTable)
      .values({
        name: `Vitest Existing Bowler ${stamp}-taken`,
        email: '',
        active: true,
        organizationId: orgAId,
      })
      .returning();
    createdBowlerIds.push(bowler.id);

    const linkOne = await apiPost(
      `/api/admin/unclaimed-users/${userOne.id}/link-existing`,
      { bowlerId: bowler.id },
      sessionA,
    );
    expect(linkOne.status).toBe(200);

    const linkTwo = await apiPost(
      `/api/admin/unclaimed-users/${userTwo.id}/link-existing`,
      { bowlerId: bowler.id },
      sessionA,
    );
    expect(linkTwo.status).toBe(409);
    expect(linkTwo.data.error?.code).toBe('BOWLER_TAKEN');

    // userTwo still unlinked.
    const [rr] = await db.select({ bowlerId: users.bowlerId }).from(users).where(eq(users.id, userTwo.id));
    expect(rr.bowlerId).toBeNull();
  });

  it('POST /link-existing refuses a cross-org bowler target — 403 CROSS_ORG_DENIED, no link landed', async () => {
    const user = await insertUnclaimedUser({ organizationId: orgAId, label: 'xorg-bowler' });
    const [bowlerB] = await db
      .insert(bowlersTable)
      .values({
        name: `Vitest Cross-Org Bowler ${stamp}`,
        email: '',
        active: true,
        organizationId: orgBId,
      })
      .returning();
    createdBowlerIds.push(bowlerB.id);

    const res = await apiPost(
      `/api/admin/unclaimed-users/${user.id}/link-existing`,
      { bowlerId: bowlerB.id },
      sessionA,
    );
    expect(res.status).toBe(403);
    expect(res.data.error?.code).toBe('CROSS_ORG_DENIED');

    const [rr] = await db.select({ bowlerId: users.bowlerId }).from(users).where(eq(users.id, user.id));
    expect(rr.bowlerId).toBeNull();
  });

  it('DELETE /unclaimed-users/:id permanently deletes an unclaimed user; row is gone afterwards', async () => {
    const user = await insertUnclaimedUser({ organizationId: orgAId, label: 'delete-happy' });

    const res = await apiDelete<{ id: number; email: string }>(
      `/api/admin/unclaimed-users/${user.id}`,
      sessionA,
    );
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.data?.id).toBe(user.id);

    const reread = await db.select({ id: users.id }).from(users).where(eq(users.id, user.id));
    expect(reread).toHaveLength(0);
  });

  it('DELETE /unclaimed-users/:id refuses cross-org targets (org A admin → org B user → 403)', async () => {
    const userB = await insertUnclaimedUser({ organizationId: orgBId, label: 'delete-xorg' });

    const res = await apiDelete(`/api/admin/unclaimed-users/${userB.id}`, sessionA);
    expect(res.status).toBe(403);
    expect(res.data.error?.code).toBe('CROSS_ORG_DENIED');

    const [rr] = await db.select({ id: users.id }).from(users).where(eq(users.id, userB.id));
    expect(rr?.id).toBe(userB.id);
  });

  it('DELETE /unclaimed-users/:id refuses a user that has been linked to a bowler (409 ALREADY_LINKED)', async () => {
    const user = await insertUnclaimedUser({ organizationId: orgAId, label: 'delete-linked' });

    const create = await apiPost<CreateBowlerOk>(
      `/api/admin/unclaimed-users/${user.id}/create-bowler`,
      { leagueId, teamId },
      sessionA,
    );
    expect(create.status).toBe(200);
    const out = create.data.data;
    if (!out) throw new Error('expected create-bowler to return data');
    createdBowlerIds.push(out.bowlerId);

    const del = await apiDelete(`/api/admin/unclaimed-users/${user.id}`, sessionA);
    expect(del.status).toBe(409);
    expect(del.data.error?.code).toBe('ALREADY_LINKED');

    const [rr] = await db.select({ id: users.id }).from(users).where(eq(users.id, user.id));
    expect(rr?.id).toBe(user.id);
  });

  it('DELETE /unclaimed-users/:id returns 404 for an unknown user id', async () => {
    const res = await apiDelete(`/api/admin/unclaimed-users/2147000111`, sessionA);
    expect(res.status).toBe(404);
    expect(res.data.error?.code).toBe('NOT_FOUND');
  });

  it('POST /create-bowler rolls the whole thing back when the team belongs to a different league (no orphaned bowler row)', async () => {
    const user = await insertUnclaimedUser({ organizationId: orgAId, label: 'rollback' });

    // Find a different league in org A (or just an arbitrary other league
    // id we can detect as invalid for our team). The simplest way: pass
    // a leagueId that isn't this team's league. Pick the team's *real*
    // league + a different league row from the same org. If the org only
    // has one league we synthesize INVALID_TEAM by using a phantom team id.
    const otherLeagues = await db
      .select({ id: leaguesTable.id })
      .from(leaguesTable)
      .where(eq(leaguesTable.organizationId, orgAId));
    const otherLeagueId = otherLeagues.find((l) => l.id !== leagueId)?.id;

    if (otherLeagueId === undefined) {
      // Fall back to the phantom-team variant.
      const res = await apiPost(
        `/api/admin/unclaimed-users/${user.id}/create-bowler`,
        { leagueId, teamId: 2_147_000_000 },
        sessionA,
      );
      expect(res.status).toBe(400);
      expect(res.data.error?.code).toBe('INVALID_TEAM');
    } else {
      // Team belongs to leagueId; pass otherLeagueId — the team check fails.
      const res = await apiPost(
        `/api/admin/unclaimed-users/${user.id}/create-bowler`,
        { leagueId: otherLeagueId, teamId },
        sessionA,
      );
      expect(res.status).toBe(400);
      expect(res.data.error?.code).toBe('INVALID_TEAM');
    }

    // No bowler should have been created and the user is still unlinked.
    const [reread] = await db.select({ bowlerId: users.bowlerId }).from(users).where(eq(users.id, user.id));
    expect(reread.bowlerId).toBeNull();
    const ghostBowlers = await db
      .select({ id: bowlersTable.id })
      .from(bowlersTable)
      .where(eq(bowlersTable.email, user.email));
    expect(ghostBowlers).toHaveLength(0);
  });
});
