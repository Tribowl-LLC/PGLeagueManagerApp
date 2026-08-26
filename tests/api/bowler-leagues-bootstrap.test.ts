import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../server/db';
import { bowlerLeagues, bowlers as bowlersTable, teams as teamsTable, users, locations, teamPaymentSlots } from '@shared/schema';
import { createBowlerLeagueIfBowlerFree } from '../../server/storage/bowlers';
import { cacheInvalidate } from '../../server/utils/cache';
import {
  login,
  apiGet,
  apiPost,
  type AuthSession,
  TEST_ORG_A_EMAIL,
  TEST_ORG_B_EMAIL,
  TEST_ORG_PASSWORD,
} from '../helpers';

interface League {
  id: number;
}
interface Team {
  id: number;
  leagueId: number;
}
interface Bowler {
  id: number;
}
interface BowlerLeague {
  id: number;
  bowlerId: number;
  leagueId: number;
  teamId: number;
}

function hasNumericId(v: unknown): v is { id: number } {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { id?: unknown }).id === 'number'
  );
}

/**
 * Regression coverage for the public-API bowler bootstrap path.
 *
 * Background: `POST /api/bowler-leagues` historically called
 * `hasAccessToBowler` unconditionally, which returns false for any bowler
 * with zero existing league entries. That made the "create a fresh bowler,
 * then attach them to a team" public-API flow impossible — every caller
 * got 403, and the production season-clone path had to call
 * `storage.createBowlerLeague` directly to dodge the check.
 *
 * Task #340 originally added a bootstrap exception gated by an
 * in-memory creation-time claim token. Tasks #342 / #407 made every
 * bowler row carry a NOT NULL `organizationId` stamp at creation time.
 * That stamp now drives access decisions:
 *   - same-org admins get a positive short-circuit in
 *     `hasAccessToBowler` and never enter the bootstrap branch
 *   - cross-org admins enter the bootstrap branch and are denied by
 *     the strict `bowler.organizationId === league.organizationId`
 *     gate inside the branch
 * Task #474 therefore deleted the claim-token module — it was
 * unreachable in every legitimate or attack scenario, and its
 * in-memory map could not survive a multi-process deploy. The tests
 * below pin the same end-to-end behavior the claim used to backstop
 * (cross-org hijack denied, fresh-bowler same-org link succeeds,
 * duplicate link denied) using only the org-stamp + storage gates.
 * See docs/security/fresh-bowler-claim-removal.md for the full
 * reachability trace.
 */
describe('POST /api/bowler-leagues — bootstrap path for fresh bowlers', () => {
  let sessionA: AuthSession;
  let sessionB: AuthSession;
  let leagueId: number | null = null;
  let teamId: number | null = null;
  const stamp = Date.now();
  const uniqueTeamNumber = (stamp % 90000) + 10000;

  // Track every row we create across all `it` blocks so afterAll can clean
  // up regardless of which case ran.
  const createdBowlerLeagueIds: number[] = [];
  const createdBowlerIds: number[] = [];

  beforeAll(async () => {
    sessionA = await login(TEST_ORG_A_EMAIL, TEST_ORG_PASSWORD);
    sessionB = await login(TEST_ORG_B_EMAIL, TEST_ORG_PASSWORD);

    // Need an org B league for the link target.
    const leagues = await apiGet<League[]>('/api/leagues', sessionB);
    expect(leagues.status).toBe(200);
    const list = Array.isArray(leagues.data.data) ? leagues.data.data : [];
    if (list.length > 0) {
      leagueId = list[0].id;
    } else {
      const organizationId = sessionB.user.organizationId;
      if (organizationId == null) throw new Error('org B admin is missing organization scope');
      const [location] = await db.select({ id: locations.id })
        .from(locations)
        .where(eq(locations.organizationId, organizationId))
        .limit(1);
      let setupLocation = location;
      if (!setupLocation) {
        const [createdLocation] = await db.insert(locations).values({
          name: `Vitest Bootstrap Canonical Lanes ${stamp}`,
          organizationId,
        }).returning({ id: locations.id });
        setupLocation = createdLocation;
      }
      if (!setupLocation) throw new Error('canonical league setup location was not created');
      const created = await apiPost<League>('/api/leagues', {
        name: `Vitest Bootstrap Canonical League ${stamp}`,
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
          idempotencyKey: `11000000-0000-4000-8000-${String(stamp).slice(-12).padStart(12, '0')}`,
        },
      }, sessionB);
      expect(created.status).toBe(201);
      const createdLeague = created.data.data;
      if (!createdLeague || typeof createdLeague.id !== 'number') {
        throw new Error('canonical league setup did not return a league id');
      }
      leagueId = createdLeague.id;
    }

    // Create a fresh team to use as the link target.
    const team = await apiPost<Team>(
      '/api/teams',
      { name: `Vitest Bootstrap Team ${stamp}`, number: uniqueTeamNumber, leagueId, active: true },
      sessionB,
    );
    expect(team.status).toBe(201);
    if (team.status === 201 && hasNumericId(team.data.data)) {
      teamId = team.data.data.id;
    }
  });

  afterAll(async () => {
    // Cleanup contract (#615): every row this suite created MUST be
    // deleted here, with per-call-site labels and a collected failure
    // throw at the end. The previous catch-all silently leaked
    // bowler_leagues / bowlers / teams into the shared dev DB on every
    // run when one FK delete blew up.
    const failures: Array<{ label: string; error: unknown }> = [];
    const tryRun = async (label: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (error) {
        failures.push({ label, error });
        console.error(`[bowler-leagues-bootstrap cleanup] ${label} failed:`, error);
      }
    };

    for (const id of createdBowlerLeagueIds) {
      await tryRun(`bowler_leagues:${id}`, () =>
        db.delete(bowlerLeagues).where(eq(bowlerLeagues.id, id)),
      );
    }
    for (const id of createdBowlerIds) {
      await tryRun(`bowlers:${id}`, () => db.delete(bowlersTable).where(eq(bowlersTable.id, id)));
    }
    if (teamId != null) {
      const id = teamId;
      await tryRun(`team_payment_slots:${id}`, () =>
        db.delete(teamPaymentSlots).where(eq(teamPaymentSlots.teamId, id)),
      );
      await tryRun(`teams:${id}`, () =>
        db.delete(teamsTable).where(eq(teamsTable.id, id)),
      );
    }

    if (failures.length > 0) {
      const summary = failures
        .map((f) => `  - ${f.label}: ${(f.error as Error)?.message ?? String(f.error)}`)
        .join('\n');
      throw new Error(
        `bowler-leagues-bootstrap afterAll cleanup had ${failures.length} failure(s):\n${summary}`,
      );
    }
  });

  it('org admin can attach a freshly created bowler (with creation-time claim) to a team in their org', async () => {
    expect(leagueId).not.toBeNull();
    expect(teamId).not.toBeNull();

    const bowlerRes = await apiPost<Bowler>(
      '/api/bowlers',
      {
        name: `Vitest Bootstrap Bowler ${stamp}-1`,
        email: `vitest-bootstrap-${stamp}-1@example.com`,
        active: true,
      },
      sessionB,
    );
    expect(bowlerRes.status).toBe(201);
    expect(hasNumericId(bowlerRes.data.data)).toBe(true);
    const bowlerId = (bowlerRes.data.data as Bowler).id;
    createdBowlerIds.push(bowlerId);

    // Bootstrap link via the same session that created the bowler.
    const linkRes = await apiPost<BowlerLeague>(
      '/api/bowler-leagues',
      { bowlerId, leagueId, teamId, active: true, order: 0 },
      sessionB,
    );

    expect(linkRes.status, JSON.stringify(linkRes.data)).toBe(201);
    expect(linkRes.data.success).toBe(true);
    expect(hasNumericId(linkRes.data.data)).toBe(true);
    const created = linkRes.data.data as BowlerLeague;
    expect(created.bowlerId).toBe(bowlerId);
    expect(created.leagueId).toBe(leagueId);
    expect(created.teamId).toBe(teamId);
    createdBowlerLeagueIds.push(created.id);
  });

  it('returns 403 (not 404) when the bootstrap caller targets a non-existent bowler — no existence oracle', async () => {
    expect(leagueId).not.toBeNull();
    expect(teamId).not.toBeNull();

    // Pick a bowler id that almost certainly does not exist. Any positive
    // integer that's never been used by the test DB will do; 2_147_000_000
    // is well below int4 max but safely above any seeded id.
    const phantomBowlerId = 2_147_000_000;

    const linkRes = await apiPost(
      '/api/bowler-leagues',
      { bowlerId: phantomBowlerId, leagueId, teamId, active: true, order: 0 },
      sessionB,
    );

    // Must be 403, not 404: returning 404 here would leak whether the
    // bowler id exists at all to any org admin who can hit this endpoint.
    expect(linkRes.status).toBe(403);
    expect(linkRes.data.success).toBe(false);
  });

  it('blocks a duplicate (bowlerId, leagueId) link after the first link has landed', async () => {
    expect(leagueId).not.toBeNull();
    expect(teamId).not.toBeNull();

    // Create a bowler and link it once (first link goes through the
    // non-bootstrap path because hasAccessToBowler short-circuits true
    // on the org stamp for the same-org caller).
    const bowlerRes = await apiPost<Bowler>(
      '/api/bowlers',
      {
        name: `Vitest Bootstrap Bowler ${stamp}-2`,
        email: `vitest-bootstrap-${stamp}-2@example.com`,
        active: true,
      },
      sessionB,
    );
    expect(bowlerRes.status).toBe(201);
    const bowlerId = (bowlerRes.data.data as Bowler).id;
    createdBowlerIds.push(bowlerId);

    const firstLink = await apiPost<BowlerLeague>(
      '/api/bowler-leagues',
      { bowlerId, leagueId, teamId, active: true, order: 0 },
      sessionB,
    );
    expect(firstLink.status).toBe(201);
    createdBowlerLeagueIds.push((firstLink.data.data as BowlerLeague).id);

    // Re-posting the exact same link must hit the "already in this league"
    // 400 branch (the regular hasAccessToBowler check now succeeds because
    // the bowler has a league entry).
    const secondLink = await apiPost(
      '/api/bowler-leagues',
      { bowlerId, leagueId, teamId, active: true, order: 0 },
      sessionB,
    );
    expect(secondLink.status).toBe(400);
    expect(secondLink.data.success).toBe(false);
  });

  it('does NOT let an org A admin claim an org B bowler via bootstrap (cross-org adversarial — strict 403)', async () => {
    expect(leagueId).not.toBeNull();

    // Org B creates a fresh bowler. The bowler row is stamped with
    // org B's organizationId at creation time (#342/#407).
    const bowlerRes = await apiPost<Bowler>(
      '/api/bowlers',
      {
        name: `Vitest Bootstrap Bowler ${stamp}-4`,
        email: `vitest-bootstrap-${stamp}-4@example.com`,
        active: true,
      },
      sessionB,
    );
    expect(bowlerRes.status).toBe(201);
    const bowlerId = (bowlerRes.data.data as Bowler).id;
    createdBowlerIds.push(bowlerId);

    // Resolve org A's own league + team to use as the hijack target.
    const orgALeagues = await apiGet<League[]>('/api/leagues', sessionA);
    expect(orgALeagues.status).toBe(200);
    const aLeagues = Array.isArray(orgALeagues.data.data) ? orgALeagues.data.data : [];
    if (aLeagues.length === 0) {
      // Skip without failing if org A has no fixtures.
      return;
    }
    const orgALeagueId = aLeagues[0].id;
    const orgATeams = await apiGet<Team[]>(`/api/teams?leagueId=${orgALeagueId}`, sessionA);
    if (
      orgATeams.status !== 200 ||
      !Array.isArray(orgATeams.data.data) ||
      orgATeams.data.data.length === 0
    ) {
      return;
    }
    const orgATeamId = orgATeams.data.data[0].id;

    // Org A admin attempts to bootstrap-link org B's fresh bowler to org
    // A's own league/team. The bootstrap branch's strict
    // `bowler.organizationId === targetLeague.organizationId` gate
    // (org B vs org A) denies → strict 403. Pre-#474 there was an
    // additional claim-token check after this gate; it was removed
    // because it was unreachable — this gate fires first.
    const hijack = await apiPost(
      '/api/bowler-leagues',
      { bowlerId, leagueId: orgALeagueId, teamId: orgATeamId, active: true, order: 0 },
      sessionA,
    );

    expect(hijack.status).toBe(403);
    expect(hijack.data.success).toBe(false);

    // Defense in depth: confirm no link to org A's resources actually
    // landed for the org B bowler.
    const remainingLinks = await db
      .select({ id: bowlerLeagues.id })
      .from(bowlerLeagues)
      .where(eq(bowlerLeagues.bowlerId, bowlerId));
    expect(remainingLinks.length).toBe(0);
  });

  it('createBowlerLeagueIfBowlerFree: 5 concurrent storage calls for the same fresh bowler land exactly one row (task #343 storage atomicity)', async () => {
    // Regression for the check-then-insert race in the bootstrap
    // branch. Task #474 removed the in-memory claim token that used
    // to (in single-process deploys only) serialize bootstrap inserts
    // for the same bowler at the route layer. The DB-level atomic
    // gate from task #343 — `SELECT ... FOR UPDATE` on the bowler row
    // inside `createBowlerLeagueIfBowlerFree` — is now the sole
    // serialization point, and it works across processes. Without it,
    // racing bootstrap callers would all observe an empty
    // active-bowler-leagues set and all would insert.
    //
    // We exercise the storage helper directly because the bootstrap
    // branch is post-#342/#407 only reachable in cross-org-admin
    // scenarios that the org-stamp gate denies before reaching the
    // insert; the storage helper is what guarantees correctness if a
    // future code path (or out-of-tree caller) hits the insert
    // without going through the route gates.
    expect(leagueId).not.toBeNull();
    expect(teamId).not.toBeNull();
    const raceLeagueId = leagueId;
    const raceTeamId = teamId;
    if (raceLeagueId == null) throw new Error('leagueId fixture is required');
    if (raceTeamId == null) throw new Error('teamId fixture is required');

    const bowlerRes = await apiPost<Bowler>(
      '/api/bowlers',
      {
        name: `Vitest Bootstrap Bowler ${stamp}-storage-race`,
        email: `vitest-bootstrap-${stamp}-storage-race@example.com`,
        active: true,
      },
      sessionB,
    );
    expect(bowlerRes.status).toBe(201);
    const bowlerId = (bowlerRes.data.data as Bowler).id;
    createdBowlerIds.push(bowlerId);

    const concurrency = 5;
    const results = await Promise.all(
      Array.from({ length: concurrency }, () =>
        createBowlerLeagueIfBowlerFree({
          bowlerId,
          leagueId: raceLeagueId,
          teamId: raceTeamId,
          active: true,
          order: 0,
        }),
      ),
    );

    const created = results.filter((r) => r !== null);
    const skipped = results.filter((r) => r === null);
    expect(created).toHaveLength(1);
    expect(skipped).toHaveLength(concurrency - 1);

    const linksInDb = await db
      .select({ id: bowlerLeagues.id })
      .from(bowlerLeagues)
      .where(eq(bowlerLeagues.bowlerId, bowlerId));
    expect(linksInDb).toHaveLength(1);

    if (created[0]) createdBowlerLeagueIds.push(created[0].id);
  });

  it('same-org admin can re-link a soft-deactivated fresh bowler — the org stamp grants access without needing the bootstrap branch', async () => {
    // Pre-#342 this case was rejected by the single-use claim-token gate
    // because the bowler had zero `organizationId` of its own and the
    // fallback `hasAccessToBowler` denied any caller with no shared
    // league. Post-#342 the bowler carries an explicit `organizationId`
    // stamped at creation time, so a same-org admin gets a positive
    // short-circuit in `hasAccessToBowler` and never enters the
    // bootstrap branch — they're a legitimately authorized caller for
    // their own org's bowler. Re-linking after a soft-delete is a
    // normal admin operation and must succeed (201).
    expect(leagueId).not.toBeNull();
    expect(teamId).not.toBeNull();

    const bowlerRes = await apiPost<Bowler>(
      '/api/bowlers',
      {
        name: `Vitest Bootstrap Bowler ${stamp}-5`,
        email: `vitest-bootstrap-${stamp}-5@example.com`,
        active: true,
      },
      sessionB,
    );
    expect(bowlerRes.status).toBe(201);
    const bowlerId = (bowlerRes.data.data as Bowler).id;
    createdBowlerIds.push(bowlerId);

    const first = await apiPost<BowlerLeague>(
      '/api/bowler-leagues',
      { bowlerId, leagueId, teamId, active: true, order: 0 },
      sessionB,
    );
    expect(first.status).toBe(201);
    const firstLinkId = (first.data.data as BowlerLeague).id;
    createdBowlerLeagueIds.push(firstLinkId);

    await db
      .update(bowlerLeagues)
      .set({ active: false })
      .where(eq(bowlerLeagues.id, firstLinkId));

    const second = await apiPost<BowlerLeague>(
      '/api/bowler-leagues',
      { bowlerId, leagueId, teamId, active: true, order: 0 },
      sessionB,
    );
    expect(second.status, JSON.stringify(second.data)).toBe(201);
    expect(second.data.success).toBe(true);
    if (hasNumericId(second.data.data)) {
      createdBowlerLeagueIds.push((second.data.data as BowlerLeague).id);
    }
  });

  it('rejects the stale staff-to-bowler state that previously enabled cross-org bootstrap hijacking', async () => {
    // This used to stage an org-A administrator with an org-B bowler
    // identity, then prove the route's caller-org gate rejected a bootstrap
    // hijack. Identity hardening now rejects that prerequisite at the data
    // boundary, before a session can carry it into access control.
    expect(leagueId).not.toBeNull();
    expect(teamId).not.toBeNull();

    // Create the org-B bowler identity used by the historical attack setup.
    const shadowRes = await apiPost<Bowler>(
      '/api/bowlers',
      {
        name: `Vitest Bootstrap Shadow ${stamp}-6`,
        email: `vitest-bootstrap-${stamp}-6-shadow@example.com`,
        active: true,
      },
      sessionB,
    );
    expect(shadowRes.status).toBe(201);
    const shadowBowlerId = (shadowRes.data.data as Bowler).id;
    createdBowlerIds.push(shadowBowlerId);

    const shadowLink = await apiPost<BowlerLeague>(
      '/api/bowler-leagues',
      { bowlerId: shadowBowlerId, leagueId, teamId, active: true, order: 0 },
      sessionB,
    );
    expect(shadowLink.status, JSON.stringify(shadowLink.data)).toBe(201);
    createdBowlerLeagueIds.push((shadowLink.data.data as BowlerLeague).id);

    // Attempt to stamp the org-A administrator with that bowler identity.
    const aliceUserId = sessionA.user.id;
    const originalBowlerIdRow = await db
      .select({ bowlerId: users.bowlerId })
      .from(users)
      .where(eq(users.id, aliceUserId));
    const originalBowlerId = originalBowlerIdRow[0]?.bowlerId ?? null;

    let rejected: unknown;
    try {
      await db.update(users).set({ bowlerId: shadowBowlerId }).where(eq(users.id, aliceUserId));
    } catch (error) {
      rejected = error;
    }

    // Identity hardening makes the historical attack prerequisite
    // unrepresentable: administrators cannot carry bowler identity, and the
    // cross-organization composite key independently rejects this link.
    expect((rejected as { cause?: { code?: string; constraint?: string } })?.cause)
      .toMatchObject({ code: '23514', constraint: 'users_elevated_role_bowler_check' });

    const currentBowlerIdRow = await db
      .select({ bowlerId: users.bowlerId })
      .from(users)
      .where(eq(users.id, aliceUserId));
    expect(currentBowlerIdRow[0]?.bowlerId ?? null).toBe(originalBowlerId);
    cacheInvalidate('user:');
  });
});
