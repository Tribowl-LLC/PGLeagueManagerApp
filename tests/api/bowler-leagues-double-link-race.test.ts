import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../server/db';
import { bowlerLeagues, bowlers as bowlersTable, teams as teamsTable, locations, teamPaymentSlots } from '@shared/schema';
import {
  login,
  apiGet,
  apiPost,
  type AuthSession,
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
 * Regression coverage for the public-API bowler-leagues non-bootstrap
 * path (task #473).
 *
 * Background: the everyday admin path in `POST /api/bowler-leagues`
 * (the branch that runs once `hasAccessToBowler` returns true via the
 * org-stamp shortcut, i.e. anything that isn't the cross-org fresh-
 * bowler bootstrap) used to do
 *
 *   const existing = await storage.getBowlerLeagues({bowlerId, leagueId});
 *   if (existing.length > 0) return 400;
 *   await storage.createBowlerLeague(data);
 *
 * as two separate, non-atomic ops. A double-clicked submit in the admin
 * UI (or a React Query retry) could fire both POSTs inside the few-
 * millisecond window before either insert committed, both would
 * observe an empty existing[], and both would land an active row for
 * the same (bowler, league) pair. The schema only has a non-unique
 * index on (bowler_id, league_id, team_id, active), so nothing at the
 * DB layer prevents the duplicate.
 *
 * Task #343 already wrapped the *bootstrap* branch's check + insert in
 * a `SELECT ... FOR UPDATE` transaction via
 * `createBowlerLeagueIfBowlerFree`. Task #473 adds the sibling
 * `createBowlerLeagueIfNotInLeague` for the non-bootstrap branch and
 * routes the POST handler through it.
 *
 * This test fires N concurrent POSTs to /api/bowler-leagues for the
 * same (bowlerId, leagueId, teamId) and asserts exactly one 201 and
 * exactly one DB row. Pre-fix this would land 2-5 duplicate rows
 * depending on timing (the bootstrap test demonstrated 3 duplicates
 * out of 5 incidentally).
 */
describe('POST /api/bowler-leagues — non-bootstrap path is race-safe (task #473)', () => {
  let leagueId: number | null = null;
  let teamId: number | null = null;
  const stamp = Date.now();
  const uniqueTeamNumber = (stamp % 90000) + 10000;

  // Track every row we create so afterAll can clean up regardless of
  // which case ran (or failed mid-run).
  const createdBowlerLeagueIds: number[] = [];
  const createdBowlerIds: number[] = [];

  beforeAll(async () => {
    // Fresh login scoped to setup. We deliberately do NOT cache this
    // session for the `it` block: `TEST_ORG_B_EMAIL` is a shared
    // fixture user reused across many concurrent suites, and any
    // sibling test that logs the user out, rotates its password,
    // re-creates it, rotates the CSRF secret, or mutates org B's
    // subdomain (tripping `orgSessionGuard`) between this `beforeAll`
    // and the `it` will silently invalidate a cached session and
    // collapse all 5 concurrent POSTs to 403 before they reach the
    // race-handling code under test.
    const setupSession = await login(TEST_ORG_B_EMAIL, TEST_ORG_PASSWORD);

    // Need an org B league for the link target.
    const leagues = await apiGet<League[]>('/api/leagues', setupSession);
    expect(leagues.status).toBe(200);
    const list = Array.isArray(leagues.data.data) ? leagues.data.data : [];
    if (list.length > 0) {
      leagueId = list[0].id;
    } else {
      const organizationId = setupSession.user.organizationId;
      if (organizationId == null) throw new Error('org B admin is missing organization scope');
      const [location] = await db.select({ id: locations.id })
        .from(locations)
        .where(eq(locations.organizationId, organizationId))
        .limit(1);
      let setupLocation = location;
      if (!setupLocation) {
        const [createdLocation] = await db.insert(locations).values({
          name: `Vitest DoubleLink Canonical Lanes ${stamp}`,
          organizationId,
        }).returning({ id: locations.id });
        setupLocation = createdLocation;
      }
      if (!setupLocation) throw new Error('canonical league setup location was not created');
      const created = await apiPost<League>('/api/leagues', {
        name: `Vitest DoubleLink Canonical League ${stamp}`,
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
          idempotencyKey: `12000000-0000-4000-8000-${String(stamp).slice(-12).padStart(12, '0')}`,
        },
      }, setupSession);
      expect(created.status).toBe(201);
      const createdLeague = created.data.data;
      if (!createdLeague || typeof createdLeague.id !== 'number') {
        throw new Error('canonical league setup did not return a league id');
      }
      leagueId = createdLeague.id;
    }

    // Create a fresh team to use as the link target. Using a unique
    // number keeps this independent from the bootstrap suite's team.
    const team = await apiPost<Team>(
      '/api/teams',
      { name: `Vitest DoubleLink Team ${stamp}`, number: uniqueTeamNumber, leagueId, active: true },
      setupSession,
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
        console.error(`[double-link-race cleanup] ${label} failed:`, error);
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
        `double-link-race afterAll cleanup had ${failures.length} failure(s):\n${summary}`,
      );
    }
  });

  it('5 concurrent same-(bowler, league) POSTs land exactly one 201 and exactly one DB row', async () => {
    expect(leagueId).not.toBeNull();
    expect(teamId).not.toBeNull();

    // Log in fresh INSIDE the it (not in beforeAll) so the auth
    // window between login and the 5-POST burst is narrow enough
    // that no sibling test running against the shared
    // `TEST_ORG_B_EMAIL` user can invalidate the session in between.
    // See the suite-level comment for the full failure mode.
    const sessionB: AuthSession = await login(TEST_ORG_B_EMAIL, TEST_ORG_PASSWORD);

    // Create a fresh bowler in org B. The org B admin's session has a
    // matching org stamp, so `hasAccessToBowler` will positively
    // short-circuit and the POST handler will take the NON-bootstrap
    // branch on every attempt below — exactly the path we are
    // hardening here.
    const bowlerRes = await apiPost<Bowler>(
      '/api/bowlers',
      {
        name: `Vitest DoubleLink Bowler ${stamp}`,
        email: `vitest-doublelink-${stamp}@example.com`,
        active: true,
      },
      sessionB,
    );
    expect(bowlerRes.status).toBe(201);
    expect(hasNumericId(bowlerRes.data.data)).toBe(true);
    const bowlerId = (bowlerRes.data.data as Bowler).id;
    createdBowlerIds.push(bowlerId);

    const concurrency = 5;
    const results = await Promise.all(
      Array.from({ length: concurrency }, () =>
        apiPost<BowlerLeague>(
          '/api/bowler-leagues',
          { bowlerId, leagueId, teamId, active: true, order: 0 },
          sessionB,
        ),
      ),
    );

    const created = results.filter((r) => r.status === 201);
    const duplicates = results.filter((r) => r.status === 400);

    // The single winner must be exactly one 201; every other request
    // must collapse to the same "already in this league" 400 the
    // pre-race code returned.
    expect(created, JSON.stringify(results.map((r) => ({ s: r.status, d: r.data })))).toHaveLength(1);
    expect(duplicates).toHaveLength(concurrency - 1);

    // Defense in depth: ensure exactly one active row landed. Pre-fix
    // this would commonly be 2-5 depending on timing.
    const linksInDb = await db
      .select({ id: bowlerLeagues.id })
      .from(bowlerLeagues)
      .where(eq(bowlerLeagues.bowlerId, bowlerId));
    expect(linksInDb).toHaveLength(1);

    for (const r of created) {
      const body = r.data.data;
      if (hasNumericId(body)) createdBowlerLeagueIds.push(body.id);
    }
  });
});
