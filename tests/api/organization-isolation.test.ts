import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../server/db';
import {
  bowlerLeagues,
  bowlers as bowlersTable,
  teams as teamsTable,
  locations as locationsTable,
  teamPaymentSlots,
} from '@shared/schema';
import {
  login,
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
  type AuthSession,
  TEST_ORG_A_EMAIL,
  TEST_ORG_B_EMAIL,
  TEST_ORG_PASSWORD,
} from '../helpers';

interface OrgUser {
  id: number;
  email: string;
  organizationId: number | null;
}

interface League {
  id: number;
  name: string;
  organizationId: number | null;
  payingLineupSize?: number | null;
}

function hasStringEmail(value: unknown): value is { email: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { email?: unknown }).email === 'string'
  );
}

function hasNumericId(value: unknown): value is { id: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'number'
  );
}

function collectEmails(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  return data.filter(hasStringEmail).map((u) => u.email.toLowerCase());
}

function collectIds(data: unknown): number[] {
  if (!Array.isArray(data)) return [];
  return data.filter(hasNumericId).map((u) => u.id);
}

describe('Organization Isolation', () => {
  let sessionA: AuthSession;
  let sessionB: AuthSession;
  let orgALeagueId: number | null = null;
  let orgBLeagueId: number | null = null;

  beforeAll(async () => {
    sessionA = await login(TEST_ORG_A_EMAIL, TEST_ORG_PASSWORD);
    sessionB = await login(TEST_ORG_B_EMAIL, TEST_ORG_PASSWORD);

    const orgALeagues = await apiGet<League[]>('/api/leagues', sessionA);
    orgALeagueId = orgALeagues.data.data?.[0]?.id ?? null;
    if (orgALeagueId === null) {
      const organizationId = sessionA.user.organizationId;
      if (organizationId == null) throw new Error('org A admin is missing organization scope');
      const [location] = await db.select({ id: locationsTable.id })
        .from(locationsTable)
        .where(eq(locationsTable.organizationId, organizationId))
        .limit(1);
      let setupLocation = location;
      if (!setupLocation) {
        const [createdLocation] = await db.insert(locationsTable).values({
          name: `Vitest Org A Canonical Lanes ${Date.now()}`,
          organizationId,
        }).returning({ id: locationsTable.id });
        setupLocation = createdLocation;
      }
      if (!setupLocation) throw new Error('canonical org A league setup location was not created');
      const created = await apiPost<League>('/api/leagues', {
        name: `Vitest Org A Canonical League ${Date.now()}`,
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
          idempotencyKey: `13000000-0000-4000-8000-${String(Date.now()).slice(-12).padStart(12, '0')}`,
        },
      }, sessionA);
      expect(created.status).toBe(201);
      const createdLeague = created.data.data;
      if (!createdLeague || typeof createdLeague.id !== 'number') {
        throw new Error('canonical org A league setup did not return a league id');
      }
      orgALeagueId = createdLeague.id;
    }

    // Make sure org B owns at least one league so we can test cross-org
    // fetch-by-id as org A. Reuse the first existing league when present.
    const existing = await apiGet<League[]>('/api/leagues', sessionB);
    const canonicalExisting = existing.status === 200 && Array.isArray(existing.data.data)
      ? existing.data.data.find((league) => league.payingLineupSize != null)
      : undefined;
    if (canonicalExisting) {
      orgBLeagueId = canonicalExisting.id;
    } else {
      const locationResponse = await apiGet<Array<{ id: number }>>('/api/locations', sessionB);
      let locationId = locationResponse.data.data?.[0]?.id;
      if (locationId == null && sessionB.user.organizationId != null) {
        const [location] = await db.insert(locationsTable).values({
          name: 'Vitest Org B Isolation Lanes',
          organizationId: sessionB.user.organizationId,
        }).returning({ id: locationsTable.id });
        locationId = location?.id;
      }
      const created = await apiPost<League>(
        '/api/leagues',
        {
          name: 'Vitest Org B Isolation League',
          description: null,
          payingLineupSize: 4,
          active: true,
          allowPublicSignup: false,
          seasonStart: '2032-09-06',
          totalBowlingWeeks: 4,
          weekDay: 'Monday',
          weeklyFee: 2000,
          skipDates: [],
          cancelledDates: [],
          doublePayDates: [],
          competitionStartTime: '19:00',
          timezone: 'America/New_York',
          paymentMode: 'weekly',
          locationId,
          setupIntegration: {
            contractVersion: 'league-setup-integration-request/3',
            idempotencyKey: '30000000-0000-4000-8000-000000000001',
          },
        },
        sessionB,
      );
      const createdLeague = created.data.data;
      if (created.status === 201 && hasNumericId(createdLeague)) {
        orgBLeagueId = createdLeague.id;
      }
    }
  });

  describe('organization visibility', () => {
    it('org A admin should NOT be able to list all organizations (admin-only)', async () => {
      const { status } = await apiGet<OrgUser[]>('/api/organizations', sessionA);
      expect(status).toBe(403);
    });

    it('org B admin should NOT be able to list all organizations (admin-only)', async () => {
      const { status } = await apiGet<OrgUser[]>('/api/organizations', sessionB);
      expect(status).toBe(403);
    });
  });

  describe('user isolation', () => {
    it('org A admin should see own organization users', async () => {
      expect(sessionA.user.organizationId).toBeTruthy();
      const { status, data } = await apiGet<OrgUser[]>(
        `/api/org-admin/users?organizationId=${sessionA.user.organizationId}`,
        sessionA,
      );
      expect(status).toBe(200);
      expect(data.success).toBe(true);
    });

    it('org A admin should NOT see org B users (server scopes to caller org)', async () => {
      expect(sessionB.user.organizationId).toBeTruthy();
      const { status, data } = await apiGet<OrgUser[]>(
        `/api/org-admin/users?organizationId=${sessionB.user.organizationId}`,
        sessionA,
      );
      // The endpoint either denies the cross-org request outright, or
      // (more commonly) silently ignores the org id and returns the
      // caller's own users. Either way, no org B user must be returned.
      expect([200, 403]).toContain(status);
      if (status === 200 && Array.isArray(data.data)) {
        const emails = collectEmails(data.data);
        const ids = collectIds(data.data);
        // Strong leak check: org B's known admin must never appear in a
        // list returned to org A, by either email or user id.
        expect(emails).not.toContain(TEST_ORG_B_EMAIL.toLowerCase());
        expect(ids).not.toContain(sessionB.user.id);
        // And every returned user must be scoped to org A.
        for (const u of data.data) {
          expect(u.organizationId).toBe(sessionA.user.organizationId);
        }
      }
    });

    it('org B admin should NOT see org A users (server scopes to caller org)', async () => {
      expect(sessionA.user.organizationId).toBeTruthy();
      const { status, data } = await apiGet<OrgUser[]>(
        `/api/org-admin/users?organizationId=${sessionA.user.organizationId}`,
        sessionB,
      );
      expect([200, 403]).toContain(status);
      if (status === 200 && Array.isArray(data.data)) {
        const emails = collectEmails(data.data);
        const ids = collectIds(data.data);
        expect(emails).not.toContain(TEST_ORG_A_EMAIL.toLowerCase());
        expect(ids).not.toContain(sessionA.user.id);
        for (const u of data.data) {
          expect(u.organizationId).toBe(sessionB.user.organizationId);
        }
      }
    });
  });

  describe('league isolation', () => {
    it('org A admin should see their leagues', async () => {
      const { status, data } = await apiGet<League[]>('/api/leagues', sessionA);
      expect(status).toBe(200);
      expect(data.success).toBe(true);
      // No league belonging to org B may show up in org A's list.
      if (Array.isArray(data.data)) {
        for (const l of data.data) {
          expect(l.organizationId).toBe(sessionA.user.organizationId);
        }
        if (orgBLeagueId != null) {
          const ids = collectIds(data.data);
          expect(ids).not.toContain(orgBLeagueId);
        }
      }
    });

    it('org B admin should see their leagues', async () => {
      const { status, data } = await apiGet<League[]>('/api/leagues', sessionB);
      expect(status).toBe(200);
      expect(data.success).toBe(true);
      if (Array.isArray(data.data)) {
        for (const l of data.data) {
          expect(l.organizationId).toBe(sessionB.user.organizationId);
        }
      }
    });

    it('org B admin should NOT access org A leagues via org endpoint', async () => {
      expect(sessionA.user.organizationId).toBeTruthy();
      const { status } = await apiGet<League[]>(
        `/api/organizations/${sessionA.user.organizationId}/leagues`,
        sessionB,
      );
      expect(status).toBe(403);
    });

    it('org A admin fetching a known org B league by id must get a definitive 403/404', async () => {
      // Skip if we couldn't get/create an org B league (shouldn't happen in
      // normal CI, but bail out clearly rather than silently passing).
      expect(orgBLeagueId, 'expected an org B league id to test against').not.toBeNull();
      const { status, data } = await apiGet<League>(
        `/api/leagues/${orgBLeagueId}`,
        sessionA,
      );
      expect([403, 404]).toContain(status);
      expect(data.success).toBe(false);
      // Even error payloads must not leak the league's org id back to the caller.
      const payload = JSON.stringify(data);
      expect(payload).not.toContain(`"organizationId":${sessionB.user.organizationId}`);
    });

    it('org A admin fetching org B generic canonical review must get a definitive 403/404', async () => {
      expect(orgBLeagueId, 'expected an org B league id to test against').not.toBeNull();
      const { status, data } = await apiGet(
        `/api/leagues/${orgBLeagueId}/canonical-drafts/review`,
        sessionA,
      );
      expect([403, 404]).toContain(status);
      expect(data.success).toBe(false);
      expect(JSON.stringify(data)).not.toContain(`"organizationId":${sessionB.user.organizationId}`);
    });

    it('org A GET /api/leagues/:id/new-season/source-confirmation?organizationId=<orgB> must fail closed for implicit and spoofed scope', async () => {
      expect(orgBLeagueId, 'expected an org B league id to test against').not.toBeNull();
      expect(sessionB.user.organizationId, 'expected an org B organization id').not.toBeNull();
      const implicitScope = await apiGet(
        `/api/leagues/${orgBLeagueId}/new-season/source-confirmation`,
        sessionA,
      );
      const spoofedScope = await apiGet(
        `/api/leagues/${orgBLeagueId}/new-season/source-confirmation?organizationId=${sessionB.user.organizationId}`,
        sessionA,
      );
      for (const response of [implicitScope, spoofedScope]) {
        expect([403, 404]).toContain(response.status);
        expect(response.data.success).toBe(false);
        expect(JSON.stringify(response.data)).not.toContain(`"organizationId":${sessionB.user.organizationId}`);
      }
    });

    it('org A GET /api/leagues/:id/occurrence-schedule?organizationId=<orgB> must fail closed for both implicit and spoofed scope', async () => {
      expect(orgBLeagueId, 'expected an org B league id to test against').not.toBeNull();
      expect(sessionB.user.organizationId, 'expected an org B organization id').not.toBeNull();

      const implicitScope = await apiGet(
        `/api/leagues/${orgBLeagueId}/occurrence-schedule`,
        sessionA,
      );
      expect([403, 404]).toContain(implicitScope.status);
      expect(implicitScope.data.success).toBe(false);
      expect(JSON.stringify(implicitScope.data)).not.toContain(`"organizationId":${sessionB.user.organizationId}`);

      const spoofedScope = await apiGet(
        `/api/leagues/${orgBLeagueId}/occurrence-schedule?organizationId=${sessionB.user.organizationId}`,
        sessionA,
      );
      expect([403, 404]).toContain(spoofedScope.status);
      expect(spoofedScope.data.success).toBe(false);
      expect(JSON.stringify(spoofedScope.data)).not.toContain(`"organizationId":${sessionB.user.organizationId}`);
    });

    it('org A GET /api/leagues/:leagueId/standings?organizationId=<orgB> must fail closed for both implicit and spoofed scope', async () => {
      expect(orgBLeagueId, 'expected an org B league id to test against').not.toBeNull();
      expect(sessionB.user.organizationId, 'expected an org B organization id').not.toBeNull();

      const implicitScope = await apiGet(
        `/api/leagues/${orgBLeagueId}/standings`,
        sessionA,
      );
      expect([403, 404]).toContain(implicitScope.status);
      expect(implicitScope.data.success).toBe(false);
      expect(JSON.stringify(implicitScope.data)).not.toContain(`"organizationId":${sessionB.user.organizationId}`);

      const spoofedScope = await apiGet(
        `/api/leagues/${orgBLeagueId}/standings?organizationId=${sessionB.user.organizationId}`,
        sessionA,
      );
      expect([403, 404]).toContain(spoofedScope.status);
      expect(spoofedScope.data.success).toBe(false);
      expect(JSON.stringify(spoofedScope.data)).not.toContain(`"organizationId":${sessionB.user.organizationId}`);
    });

    it('org A cannot read org B roster-payment due or responsibility surfaces', async () => {
      expect(orgBLeagueId, 'expected an org B league id to test against').not.toBeNull();
      expect(sessionB.user.organizationId, 'expected an org B organization id').not.toBeNull();

      const due = await apiGet(
        `/api/financials/leagues/${orgBLeagueId}/canonical-due-past-due/2`,
        sessionA,
      );
      expect([403, 404]).toContain(due.status);
      expect(due.data.success).toBe(false);
      expect(JSON.stringify(due.data)).not.toContain(`"organizationId":${sessionB.user.organizationId}`);

      const dueForOtherPayer = await apiGet(
        `/api/financials/leagues/${orgBLeagueId}/canonical-due-past-due/2?bowlerId=999999`,
        sessionA,
      );
      // Coverage marker for the guard's fetch-and-filter inventory:
      // /api/financials/leagues/:leagueId/canonical-due-past-due/2?bowlerId=...
      expect([403, 404]).toContain(dueForOtherPayer.status);
      expect(dueForOtherPayer.data.success).toBe(false);
      expect(JSON.stringify(dueForOtherPayer.data)).not.toContain(`"organizationId":${sessionB.user.organizationId}`);

      const roster = await apiGet(
        `/api/financials/leagues/${orgBLeagueId}/roster-payment-responsibility/1`,
        sessionA,
      );
      expect([403, 404]).toContain(roster.status);
      expect(roster.data.success).toBe(false);
      expect(JSON.stringify(roster.data)).not.toContain(`"organizationId":${sessionB.user.organizationId}`);

      const standing = await apiGet(
        `/api/financials/leagues/${orgBLeagueId}/standing-autopay/1`,
        sessionA,
      );
      expect([403, 404]).toContain(standing.status);
      expect(standing.data.success).toBe(false);
      expect(JSON.stringify(standing.data)).not.toContain(`"organizationId":${sessionB.user.organizationId}`);
    });
  });

  // -------------------------------------------------------------------------
  // Team and bowler cross-org isolation (task #310).
  //
  // PATCH/DELETE on /api/teams/:id and /api/bowlers/:id, plus GET on the same
  // ids and on the listing endpoints, must never leak or mutate org B data
  // when called from session A. These mirror the league-isolation cases above.
  // -------------------------------------------------------------------------
  describe('team and bowler isolation (task #310)', () => {
    interface Team {
      id: number;
      leagueId: number;
      name: string;
    }
    interface Bowler {
      id: number;
      name: string;
      email?: string | null;
    }
    interface BowlerLeague {
      id: number;
      bowlerId: number;
      leagueId: number;
      teamId: number;
    }

    let orgBTeamId: number | null = null;
    let orgBBowlerId: number | null = null;
    let bowlerLeagueId: number | null = null;
    const stamp = Date.now();
    // Unique team number per run to avoid colliding with the league's
    // teams_league_number_idx unique index across re-runs of the suite.
    const uniqueTeamNumber = (stamp % 90000) + 10000;

    beforeAll(async () => {
      // Need an org B league we already have; bail loudly if not.
      expect(orgBLeagueId, 'org B league fixture is required').not.toBeNull();

      // Create the org B team via API (exercises the real /api/teams POST
      // org-access check as session B).
      const teamRes = await apiPost<Team>(
        '/api/teams',
        { name: `Vitest Iso Team ${stamp}`, number: uniqueTeamNumber, leagueId: orgBLeagueId, active: true },
        sessionB,
      );
      const teamPayload = teamRes.data.data;
      if (teamRes.status === 201 && hasNumericId(teamPayload)) {
        orgBTeamId = teamPayload.id;
      }

      // Create the org B bowler via API.
      const bowlerRes = await apiPost<Bowler>(
        '/api/bowlers',
        { name: `Vitest Iso Bowler ${stamp}`, email: `vitest-iso-${stamp}@example.com`, active: true },
        sessionB,
      );
      const bowlerPayload = bowlerRes.data.data;
      if (bowlerRes.status === 201 && hasNumericId(bowlerPayload)) {
        orgBBowlerId = bowlerPayload.id;
      }

      // Link bowler → team → league directly via the DB. The /api/bowler-leagues
      // POST refuses to operate on a bowler with no existing league entries
      // (bootstrap chicken-egg), so the production season-clone path calls
      // `storage.createBowlerLeague` directly and we mirror that here. This
      // is what makes hasAccessToBowler resolve to the org B league for
      // session B and lets cross-org tests prove session A is denied.
      if (orgBBowlerId != null && orgBTeamId != null && orgBLeagueId != null) {
        const [row] = await db
          .insert(bowlerLeagues)
          .values({
            bowlerId: orgBBowlerId,
            leagueId: orgBLeagueId,
            teamId: orgBTeamId,
            active: true,
            order: 0,
          })
          .returning({ id: bowlerLeagues.id });
        bowlerLeagueId = row?.id ?? null;
      }
    });

    it('cannot move an owned team into a league outside the administrator scope', async () => {
      expect(orgBTeamId).not.toBeNull();
      expect(orgALeagueId).not.toBeNull();
      if (orgBTeamId === null || orgALeagueId === null) {
        throw new Error('cross-organization team and league fixtures are required');
      }
      const response = await apiPatch(
        `/api/teams/${orgBTeamId}`,
        { leagueId: orgALeagueId },
        sessionB,
      );
      expect(response.status).toBe(403);
      const [unchanged] = await db.select({ leagueId: teamsTable.leagueId })
        .from(teamsTable)
        .where(eq(teamsTable.id, orgBTeamId));
      expect(unchanged?.leagueId).toBe(orgBLeagueId);
    });

    afterAll(async () => {
      // Cleanup contract (#615): every row inserted in `beforeAll`
      // above MUST be deleted here, with per-call-site labels and a
      // collected failure throw at the end. The previous catch-all
      // claimed leftover fixtures would be "reaped by the test DB",
      // but no such reaping exists — silently swallowed FK errors
      // here leak rows into the shared dev database on every run.
      const failures: Array<{ label: string; error: unknown }> = [];
      const tryRun = async (label: string, fn: () => Promise<unknown>) => {
        try {
          await fn();
        } catch (error) {
          failures.push({ label, error });
          console.error(`[org-isolation cross-org cleanup] ${label} failed:`, error);
        }
      };

      if (bowlerLeagueId != null) {
        const id = bowlerLeagueId;
        await tryRun(`bowler_leagues:${id}`, () =>
          db.delete(bowlerLeagues).where(eq(bowlerLeagues.id, id)),
        );
      }
      if (orgBBowlerId != null) {
        const id = orgBBowlerId;
        await tryRun(`bowlers:${id}`, () =>
          db.delete(bowlersTable).where(eq(bowlersTable.id, id)),
        );
      }
      if (orgBTeamId != null) {
        const id = orgBTeamId;
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
          `org-isolation cross-org afterAll cleanup had ${failures.length} failure(s):\n${summary}`,
        );
      }
    });

    it('org B fixtures are usable (sanity)', () => {
      expect(orgBTeamId, 'expected an org B team id').not.toBeNull();
      expect(orgBBowlerId, 'expected an org B bowler id').not.toBeNull();
    });

    it('F1 financial reads reject cross-tenant and unscoped member access', async () => {
      // Coverage markers for the central org-isolation inventory:
      // apiGet('/api/financials/leagues/${orgBLeagueId}/source?organizationId=${sessionB.user.organizationId}', sessionA)
      // apiGet('/api/financials/leagues/${orgBLeagueId}/roster?organizationId=${sessionB.user.organizationId}', sessionA)
      // apiGet('/api/financials/leagues/${orgBLeagueId}/due-past-due?organizationId=${sessionB.user.organizationId}', sessionA)
      // apiGet('/api/financials/leagues/${orgBLeagueId}/due-past-due?bowlerId=${orgBBowlerId}', sessionA)
      // Inventory path markers: /api/financials/leagues/:leagueId/source?organizationId=...
      // /api/financials/leagues/:leagueId/roster?organizationId=...
      // /api/financials/leagues/:leagueId/due-past-due?organizationId=...
      // /api/financials/leagues/:leagueId/due-past-due?bowlerId=...
      expect(orgBLeagueId).not.toBeNull();
      const all = await apiGet(`/api/financials/due-past-due?organizationId=${sessionB.user.organizationId}`, sessionA);
      expect([403, 404]).toContain(all.status);
      const source = await apiGet(`/api/financials/leagues/${orgBLeagueId}/source`, sessionA);
      expect([403, 404, 410]).toContain(source.status);
      const sourceScoped = await apiGet(`/api/financials/leagues/${orgBLeagueId}/source?organizationId=${sessionB.user.organizationId}`, sessionA);
      expect([403, 404, 410]).toContain(sourceScoped.status);
      const roster = await apiGet(`/api/financials/leagues/${orgBLeagueId}/roster?organizationId=${sessionB.user.organizationId}`, sessionA);
      expect([403, 404, 410]).toContain(roster.status);
      const rosterUnscoped = await apiGet(`/api/financials/leagues/${orgBLeagueId}/roster`, sessionA);
      expect([403, 404, 410]).toContain(rosterUnscoped.status);
      const report = await apiGet(`/api/financials/leagues/${orgBLeagueId}/due-past-due?organizationId=${sessionB.user.organizationId}&bowlerId=${orgBBowlerId}`, sessionA);
      expect([403, 404, 410]).toContain(report.status);
      const reportUnscoped = await apiGet(`/api/financials/leagues/${orgBLeagueId}/due-past-due`, sessionA);
      expect([403, 404, 410]).toContain(reportUnscoped.status);
      const reportBowler = await apiGet(`/api/financials/leagues/${orgBLeagueId}/due-past-due?bowlerId=${orgBBowlerId}`, sessionA);
      expect([403, 404, 410]).toContain(reportBowler.status);
      const sourceGuard = await apiGet(`/api/financials/leagues/${orgBLeagueId}/source?organizationId=${sessionB.user.organizationId}`, sessionA);
      expect([403, 404, 410]).toContain(sourceGuard.status);
      const rosterGuard = await apiGet(`/api/financials/leagues/${orgBLeagueId}/roster?organizationId=${sessionB.user.organizationId}`, sessionA);
      expect([403, 404, 410]).toContain(rosterGuard.status);
      const reportGuard = await apiGet(`/api/financials/leagues/${orgBLeagueId}/due-past-due?organizationId=${sessionB.user.organizationId}`, sessionA);
      expect([403, 404, 410]).toContain(reportGuard.status);

      // F5 canonical payment reports are explicitly organization/league
      // scoped; cross-tenant callers receive a nondisclosing denial.
      const f5OrgScope = await apiGet(`/api/financials/f5/payments?organizationId=${sessionB.user.organizationId}&leagueId=${orgBLeagueId}`, sessionA);
      expect([403, 404, 410]).toContain(f5OrgScope.status);
      const f5LeagueScope = await apiGet(`/api/financials/f5/payments?leagueId=${orgBLeagueId}`, sessionA);
      expect([403, 404, 410]).toContain(f5LeagueScope.status);
      const f5BowlerScope = await apiGet(`/api/financials/f5/payments?leagueId=${orgBLeagueId}&bowlerId=${orgBBowlerId}`, sessionA);
      expect([403, 404, 410]).toContain(f5BowlerScope.status);
    });

    it('org A GET /api/financials/f3/leagues/:leagueId/policy/candidates?organizationId=<orgB> must fail closed', async () => {
      expect(orgBLeagueId).not.toBeNull();
      const response = await apiGet(
        `/api/financials/f3/leagues/${orgBLeagueId}/policy/candidates?organizationId=${sessionB.user.organizationId}`,
        sessionA,
      );
      expect([403, 404, 410]).toContain(response.status);
      expect(JSON.stringify(response.data)).not.toContain(String(orgBLeagueId));
      expect(JSON.stringify(response.data)).not.toContain(`"organizationId":${sessionB.user.organizationId}`);
    });

    it('org A GET /api/financials/f3/leagues/:leagueId/prequote?organizationId=<orgB>&bowlerId=<orgB> must fail closed', async () => {
      expect(orgBLeagueId).not.toBeNull();
      expect(orgBBowlerId).not.toBeNull();
      const response = await apiGet(
        `/api/financials/f3/leagues/${orgBLeagueId}/prequote?organizationId=${sessionB.user.organizationId}&bowlerId=${orgBBowlerId}`,
        sessionA,
      );
      expect([403, 404, 410]).toContain(response.status);
      expect(JSON.stringify(response.data)).not.toContain(String(orgBLeagueId));
      expect(JSON.stringify(response.data)).not.toContain(`"organizationId":${sessionB.user.organizationId}`);
    });

    it('org A GET /api/financials/f3/leagues/:leagueId/quote?organizationId=<orgB>&bowlerId=<orgB> must fail closed', async () => {
      expect(orgBLeagueId).not.toBeNull();
      expect(orgBBowlerId).not.toBeNull();
      const response = await apiGet(
        `/api/financials/f3/leagues/${orgBLeagueId}/quote?organizationId=${sessionB.user.organizationId}&bowlerId=${orgBBowlerId}`,
        sessionA,
      );
      expect([403, 404, 410]).toContain(response.status);
      expect(JSON.stringify(response.data)).not.toContain(String(orgBLeagueId));
      expect(JSON.stringify(response.data)).not.toContain(`"organizationId":${sessionB.user.organizationId}`);
    });

    it('org A GET /api/teams listing must not include the org B team id', async () => {
      const { status, data } = await apiGet<Team[]>('/api/teams', sessionA);
      expect(status).toBe(200);
      if (Array.isArray(data.data) && orgBTeamId != null) {
        const ids = collectIds(data.data);
        expect(ids).not.toContain(orgBTeamId);
      }
    });

    // Parameterize the four homogeneous "GET org-B :id → 403/404 with no
    // leak" cases. Each entry uses `${orgBTeamId}` / `${orgBBowlerId}`
    // template-literal segments verbatim because
    // `scripts/check-org-isolation-coverage.ts` matches each `:param`
    // segment against the literal regex `\$\{[^}]+\}` in the test file
    // source — replacing the segment with anything else (a string literal,
    // a `String(id)` call, etc.) would break coverage detection.
    it.each([
      {
        label: 'org A GET /api/teams/:id (org B team) → 403/404 and does not leak the row',
        getResource: () => orgBTeamId,
        path: () => `/api/teams/${orgBTeamId}`,
        leak: () => `Vitest Iso Team ${stamp}`,
        positiveControl: false,
      },
      {
        label: 'org A GET /api/teams/:id/details (org B team) → 403/404 while session B gets 200 (positive control)',
        getResource: () => orgBTeamId,
        path: () => `/api/teams/${orgBTeamId}/details`,
        leak: null,
        positiveControl: true,
      },
      {
        label: 'org A GET /api/bowlers/:id (org B bowler) → 403/404 and does not leak the row',
        getResource: () => orgBBowlerId,
        path: () => `/api/bowlers/${orgBBowlerId}`,
        leak: () => `Vitest Iso Bowler ${stamp}`,
        leak2: () => `vitest-iso-${stamp}@example.com`,
        positiveControl: false,
      },
      {
        label: 'org A GET /api/bowlers/:id/details (org B bowler) → 403/404 while session B gets 200 (positive control)',
        getResource: () => orgBBowlerId,
        path: () => `/api/bowlers/${orgBBowlerId}/details`,
        leak: null,
        positiveControl: true,
      },
    ])('$label', async ({ getResource, path, leak, leak2, positiveControl }) => {
      expect(getResource()).not.toBeNull();
      const { status, data } = await apiGet(path(), sessionA);
      expect([403, 404]).toContain(status);
      expect(data.success).toBe(false);
      if (leak) {
        const payload = JSON.stringify(data);
        expect(payload).not.toContain(leak());
        if (leak2) expect(payload).not.toContain(leak2());
      }
      if (positiveControl) {
        // Positive control: session B (the owning org) must succeed on
        // the same id, otherwise the 403 above would be a trivial pass.
        const owner = await apiGet(path(), sessionB);
        expect(owner.status).toBe(200);
        expect(owner.data.success).toBe(true);
      }
    });

    it('org A GET /api/teams?leagueId=<orgBLeague> must not include the org B team', async () => {
      expect(orgBTeamId).not.toBeNull();
      expect(orgBLeagueId).not.toBeNull();
      const { status, data } = await apiGet<Team[]>(`/api/teams?leagueId=${orgBLeagueId}`, sessionA);
      // Either 200 with no rows, or denied — either is acceptable; what
      // matters is the org B team id never appears.
      expect([200, 403, 404]).toContain(status);
      if (status === 200 && Array.isArray(data.data) && orgBTeamId != null) {
        const ids = collectIds(data.data);
        expect(ids).not.toContain(orgBTeamId);
      }
    });

    it('org A PATCH /api/teams/:id (org B team) → 403/404 and does not mutate the team', async () => {
      expect(orgBTeamId).not.toBeNull();
      const before = await apiGet<Team>(`/api/teams/${orgBTeamId}`, sessionB);
      expect(before.status).toBe(200);
      const beforeName = (before.data.data as Team | undefined)?.name;

      const { status, data } = await apiPatch<Team>(
        `/api/teams/${orgBTeamId}`,
        { name: 'PWNED-by-org-A' },
        sessionA,
      );
      expect([403, 404]).toContain(status);
      expect(data.success).toBe(false);

      // Confirm via session B that no mutation actually landed.
      const after = await apiGet<Team>(`/api/teams/${orgBTeamId}`, sessionB);
      expect(after.status).toBe(200);
      expect((after.data.data as Team | undefined)?.name).toBe(beforeName);
      expect((after.data.data as Team | undefined)?.name).not.toBe('PWNED-by-org-A');
    });

    it('org A DELETE /api/teams/:id (org B team) → 403/404 and the team still exists', async () => {
      expect(orgBTeamId).not.toBeNull();
      const { status, data } = await apiDelete(`/api/teams/${orgBTeamId}`, sessionA);
      expect([403, 404]).toContain(status);
      expect(data.success).toBe(false);

      // Verify via session B that the team is still there.
      const after = await apiGet<Team>(`/api/teams/${orgBTeamId}`, sessionB);
      expect(after.status).toBe(200);
      expect(after.data.success).toBe(true);
    });

    it('org A GET /api/bowlers listing must not include the org B bowler id', async () => {
      const { status, data } = await apiGet<Bowler[]>('/api/bowlers', sessionA);
      // The endpoint may legitimately return [] when the caller has no team
      // context; what matters is that the org B id never appears.
      expect([200, 403]).toContain(status);
      if (status === 200 && Array.isArray(data.data) && orgBBowlerId != null) {
        const ids = collectIds(data.data);
        expect(ids).not.toContain(orgBBowlerId);
      }
    });

    it('org A GET /api/bowlers/search?organizationId=<orgB> must not leak the org B bowler (task #702)', async () => {
      // Non-system-admin callers cannot cross-scope the search; the
      // route ignores the spoofed organizationId and falls back to the
      // caller's own org. The org B bowler id must therefore never
      // appear in the results.
      expect(orgBBowlerId).not.toBeNull();
      const orgBOrganizationId = sessionB.user.organizationId;
      const { status, data } = await apiGet<Array<{ id: number }>>(
        `/api/bowlers/search?q=Vitest+Iso&organizationId=${orgBOrganizationId}`,
        sessionA,
      );
      expect([200, 403]).toContain(status);
      if (status === 200 && Array.isArray(data.data) && orgBBowlerId != null) {
        expect(data.data.map((r) => r.id)).not.toContain(orgBBowlerId);
      }
    });

    it('org A GET /api/bowlers?teamId=<orgBTeam> → 403/404 (no leak by team filter)', async () => {
      expect(orgBTeamId).not.toBeNull();
      const { status } = await apiGet<Bowler[]>(`/api/bowlers?teamId=${orgBTeamId}`, sessionA);
      expect([403, 404]).toContain(status);
    });

    it('org A PATCH /api/bowlers/:id (org B bowler) → 403/404 and does not mutate the bowler', async () => {
      expect(orgBBowlerId).not.toBeNull();
      const before = await apiGet<Bowler>(`/api/bowlers/${orgBBowlerId}`, sessionB);
      expect(before.status).toBe(200);
      const beforeName = (before.data.data as Bowler | undefined)?.name;

      const { status, data } = await apiPatch<Bowler>(
        `/api/bowlers/${orgBBowlerId}`,
        { name: 'PWNED-bowler-by-org-A' },
        sessionA,
      );
      expect([403, 404]).toContain(status);
      expect(data.success).toBe(false);

      const after = await apiGet<Bowler>(`/api/bowlers/${orgBBowlerId}`, sessionB);
      expect(after.status).toBe(200);
      expect((after.data.data as Bowler | undefined)?.name).toBe(beforeName);
      expect((after.data.data as Bowler | undefined)?.name).not.toBe('PWNED-bowler-by-org-A');
    });

    it('org A DELETE /api/bowlers/:id (org B bowler) → 403/404 and the bowler still exists', async () => {
      expect(orgBBowlerId).not.toBeNull();
      const { status, data } = await apiDelete(`/api/bowlers/${orgBBowlerId}`, sessionA);
      expect([403, 404]).toContain(status);
      expect(data.success).toBe(false);

      const after = await apiGet<Bowler>(`/api/bowlers/${orgBBowlerId}`, sessionB);
      expect(after.status).toBe(200);
      expect(after.data.success).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // Task #341 — filtered list endpoints must not leak cross-org data.
  //
  // Single-record handlers (`GET /:id`, mutations) are covered above.
  // The shape we exercise here is the *list* shape with an entity-id
  // filter — `?ids=`, `?bowlerId=`, `?leagueId=`, `?locationId=`. A
  // common bug class is: the list handler honors the filter param
  // verbatim and forgets to also constrain by the caller's org, so
  // pointing the filter at another org's entity id leaks rows.
  //
  // Each test below points session A at an org B id and asserts the
  // response either denies (403/404) or returns an empty/non-leaking
  // result. The org B fixture rows (location, team, bowler, payment)
  // are created via direct DB insert so the test is hermetic and does
  // not depend on existing data.
  // ------------------------------------------------------------------
  describe('filtered list endpoints — cross-org leak prevention (task #341)', () => {
    interface Location { id: number; organizationId: number | null; name: string }
    interface League { id: number; locationId: number | null }
    interface Bowler { id: number; name: string; email?: string | null }
    interface Team { id: number; leagueId: number; name: string }
    interface Payment { id: number; bowlerId: number; leagueId: number; amount: number }

    const stamp = Date.now();
    const uniqueTeamNumber = ((stamp + 1) % 90000) + 10000;
    let orgBId: number | null = null;
    let orgBLocationId: number | null = null;
    let orgBTeamId: number | null = null;
    let orgBBowlerId: number | null = null;
    let orgBBowlerLeagueId: number | null = null;
    let orgBPaymentId: number | null = null;

    beforeAll(async () => {
      // Need the org B league — this is set in the outermost beforeAll.
      expect(orgBLeagueId, 'org B league fixture is required').not.toBeNull();
      const leagueIdForOrgB = orgBLeagueId;
      if (leagueIdForOrgB == null) {
        throw new Error('org B league fixture is required');
      }

      // Resolve org B's organization id by looking at the org B league row.
      const leagueRow = await db.query.leagues.findFirst({
        where: (l, { eq }) => eq(l.id, leagueIdForOrgB),
      });
      orgBId = leagueRow?.organizationId ?? null;
      expect(orgBId, 'expected org B league to have an organizationId').not.toBeNull();
      const orgBOrgId = orgBId;
      if (orgBOrgId == null) {
        throw new Error('expected org B league to have an organizationId');
      }

      const { locations: locationsTable, leagues: leaguesTable, payments: paymentsTable } =
        await import('@shared/schema');

      // Create an org B location and stamp it on the org B league so
      // /api/leagues?locationId=<orgB-location> can be exercised against
      // a real, owned target row.
      const [createdLocation] = await db
        .insert(locationsTable)
        .values({
          organizationId: orgBOrgId,
          name: `Vitest Iso Location ${stamp}`,
        })
        .returning({ id: locationsTable.id });
      orgBLocationId = createdLocation?.id ?? null;
      if (orgBLocationId != null) {
        await db
          .update(leaguesTable)
          .set({ locationId: orgBLocationId })
          .where(eq(leaguesTable.id, leagueIdForOrgB));
      }

      // Create an org B team + bowler + bowler-league link so /api/bowlers
      // and /api/payments can be filtered by their ids cross-org.
      const teamRes = await apiPost<Team>(
        '/api/teams',
        { name: `Vitest #341 Team ${stamp}`, number: uniqueTeamNumber, leagueId: orgBLeagueId, active: true },
        sessionB,
      );
      const teamPayload = teamRes.data.data;
      if (teamRes.status === 201 && hasNumericId(teamPayload)) {
        orgBTeamId = teamPayload.id;
      }

      const bowlerRes = await apiPost<Bowler>(
        '/api/bowlers',
        { name: `Vitest #341 Bowler ${stamp}`, email: `vitest-341-${stamp}@example.com`, active: true },
        sessionB,
      );
      const bowlerPayload = bowlerRes.data.data;
      if (bowlerRes.status === 201 && hasNumericId(bowlerPayload)) {
        orgBBowlerId = bowlerPayload.id;
      }

      // Direct-DB link to bypass the bootstrap chicken-egg (same pattern
      // used by the task-#310 setup above).
      if (orgBBowlerId != null && orgBTeamId != null && orgBLeagueId != null) {
        const [row] = await db
          .insert(bowlerLeagues)
          .values({
            bowlerId: orgBBowlerId,
            leagueId: orgBLeagueId,
            teamId: orgBTeamId,
            active: true,
            order: 0,
          })
          .returning({ id: bowlerLeagues.id });
        orgBBowlerLeagueId = row?.id ?? null;
      }

      // Insert an org B payment so /api/payments?bowlerId|leagueId
      // filters against a real org B row that an attacker could try to
      // fish out cross-org.
      if (orgBBowlerId != null && orgBLeagueId != null) {
        const [row] = await db
          .insert(paymentsTable)
          .values({
            bowlerId: orgBBowlerId,
            leagueId: orgBLeagueId,
            amount: 1234,
            weekOf: new Date().toISOString(),
            type: 'cash',
            notes: `Vitest #341 Payment ${stamp}`,
          })
          .returning({ id: paymentsTable.id });
        orgBPaymentId = row?.id ?? null;
      }
    });

    afterAll(async () => {
      // Cleanup contract (#615): every row inserted in `beforeAll`
      // above MUST be deleted here, with per-call-site labels and a
      // collected failure throw at the end. The previous best-effort
      // catch-all silently leaked locations/teams/bowlers/payments
      // into the shared dev DB whenever a single FK delete blew up.
      const { locations: locationsTable, leagues: leaguesTable, payments: paymentsTable } =
        await import('@shared/schema');

      const failures: Array<{ label: string; error: unknown }> = [];
      const tryRun = async (label: string, fn: () => Promise<unknown>) => {
        try {
          await fn();
        } catch (error) {
          failures.push({ label, error });
          console.error(`[org-isolation list-leak cleanup] ${label} failed:`, error);
        }
      };

      if (orgBPaymentId != null) {
        const id = orgBPaymentId;
        await tryRun(`payments:${id}`, () =>
          db.delete(paymentsTable).where(eq(paymentsTable.id, id)),
        );
      }
      if (orgBBowlerLeagueId != null) {
        const id = orgBBowlerLeagueId;
        await tryRun(`bowler_leagues:${id}`, () =>
          db.delete(bowlerLeagues).where(eq(bowlerLeagues.id, id)),
        );
      }
      if (orgBBowlerId != null) {
        const id = orgBBowlerId;
        await tryRun(`bowlers:${id}`, () =>
          db.delete(bowlersTable).where(eq(bowlersTable.id, id)),
        );
      }
      if (orgBTeamId != null) {
        const id = orgBTeamId;
        await tryRun(`team_payment_slots:${id}`, () =>
          db.delete(teamPaymentSlots).where(eq(teamPaymentSlots.teamId, id)),
        );
        await tryRun(`teams:${id}`, () =>
          db.delete(teamsTable).where(eq(teamsTable.id, id)),
        );
      }
      if (orgBLocationId != null) {
        const id = orgBLocationId;
        // Detach from the org B league first so the location FK can drop.
        await tryRun(`leagues.locationId=null where locationId=${id}`, () =>
          db
            .update(leaguesTable)
            .set({ locationId: null })
            .where(eq(leaguesTable.locationId, id)),
        );
        await tryRun(`locations:${id}`, () =>
          db.delete(locationsTable).where(eq(locationsTable.id, id)),
        );
      }

      if (failures.length > 0) {
        const summary = failures
          .map((f) => `  - ${f.label}: ${(f.error as Error)?.message ?? String(f.error)}`)
          .join('\n');
        throw new Error(
          `org-isolation list-leak afterAll cleanup had ${failures.length} failure(s):\n${summary}`,
        );
      }
    });

    it('fixtures are usable (sanity)', () => {
      expect(orgBLocationId, 'expected an org B location id').not.toBeNull();
      expect(orgBTeamId, 'expected an org B team id').not.toBeNull();
      expect(orgBBowlerId, 'expected an org B bowler id').not.toBeNull();
      expect(orgBPaymentId, 'expected an org B payment id').not.toBeNull();
    });

    it('org A GET /api/bowlers?ids=<orgB bowler> → 403 (batched id-list filter must not leak)', async () => {
      expect(orgBBowlerId).not.toBeNull();
      const { status, data } = await apiGet<Bowler[]>(
        `/api/bowlers?ids=${orgBBowlerId}`,
        sessionA,
      );
      // The route uses `hasAccessToBowlers` to gate the entire list and
      // returns 403 when any requested id resolves outside the caller's
      // org. Empty 200 would also be acceptable (filter applied AND
      // org-scoped), but the org B id and identifying fields must NEVER
      // appear in the response body either way.
      expect([200, 403]).toContain(status);
      const payload = JSON.stringify(data);
      expect(payload).not.toContain(`Vitest #341 Bowler ${stamp}`);
      expect(payload).not.toContain(`vitest-341-${stamp}@example.com`);
      if (status === 200 && Array.isArray(data.data) && orgBBowlerId != null) {
        expect(collectIds(data.data)).not.toContain(orgBBowlerId);
      }
    });

    it('org A GET /api/bowlers?ids=<mixed>: even one cross-org id must deny the whole batch', async () => {
      expect(orgBBowlerId).not.toBeNull();
      // Mix in an obviously-not-orgA placeholder id alongside the real
      // org B id. Whether or not the placeholder exists, the org B id
      // alone should be enough to deny the batch.
      const { status, data } = await apiGet<Bowler[]>(
        `/api/bowlers?ids=${orgBBowlerId},999999999`,
        sessionA,
      );
      expect([200, 403]).toContain(status);
      const payload = JSON.stringify(data);
      expect(payload).not.toContain(`Vitest #341 Bowler ${stamp}`);
      expect(payload).not.toContain(`vitest-341-${stamp}@example.com`);
      if (status === 200 && Array.isArray(data.data) && orgBBowlerId != null) {
        expect(collectIds(data.data)).not.toContain(orgBBowlerId);
      }
    });

    it('org A GET /api/leagues?locationId=<orgB location> must not include the org B league', async () => {
      expect(orgBLocationId).not.toBeNull();
      expect(orgBLeagueId).not.toBeNull();
      const { status, data } = await apiGet<League[]>(
        `/api/leagues?locationId=${orgBLocationId}`,
        sessionA,
      );
      // The route applies org scoping FIRST (via getOrganizationFilter)
      // and then filters in-memory by locationId. Pointing the filter at
      // an org B location id from session A should yield zero rows even
      // though the org B league really does live at that location.
      expect(status).toBe(200);
      if (Array.isArray(data.data) && orgBLeagueId != null) {
        expect(collectIds(data.data)).not.toContain(orgBLeagueId);
      }
    });

    it('org A GET /api/payments?bowlerId=<orgB bowler> must not leak the org B payment row', async () => {
      expect(orgBBowlerId).not.toBeNull();
      const { status, data } = await apiGet<Payment[]>(
        `/api/payments?bowlerId=${orgBBowlerId}`,
        sessionA,
      );
      // The payments list applies the caller's organizationId in the
      // storage filter. The bowlerId param here belongs to org B, so
      // even though it's a real bowler id, the org-scoped query must
      // resolve to zero rows.
      expect(status).toBe(200);
      if (Array.isArray(data.data) && orgBPaymentId != null) {
        expect(collectIds(data.data)).not.toContain(orgBPaymentId);
      }
      const payload = JSON.stringify(data);
      expect(payload).not.toContain(`Vitest #341 Payment ${stamp}`);
    });

    it('org A GET /api/payments?leagueId=<orgB league> → 403 (league-id filter is org-gated upstream)', async () => {
      expect(orgBLeagueId).not.toBeNull();
      const { status, data } = await apiGet<Payment[]>(
        `/api/payments?leagueId=${orgBLeagueId}`,
        sessionA,
      );
      // /api/payments calls requireOrganizationAccess(req, league.org)
      // before running the storage query when leagueId is provided, so
      // a cross-org leagueId should hit a strict 403.
      expect(status).toBe(403);
      expect(data.success).toBe(false);
      const payload = JSON.stringify(data);
      expect(payload).not.toContain(`Vitest #341 Payment ${stamp}`);
    });

    it('org A GET /api/payments?teamId=<orgB team> must not leak the org B payment row', async () => {
      expect(orgBTeamId).not.toBeNull();
      const { status, data } = await apiGet<Payment[]>(
        `/api/payments?teamId=${orgBTeamId}`,
        sessionA,
      );
      // teamId is NOT explicitly access-checked at the route layer (only
      // leagueId is) — the safety net is the org-scoped storage filter.
      // Confirm that net actually catches it: org A must not see org B's
      // payment even when filtering by org B's team.
      expect(status).toBe(200);
      if (Array.isArray(data.data) && orgBPaymentId != null) {
        expect(collectIds(data.data)).not.toContain(orgBPaymentId);
      }
      const payload = JSON.stringify(data);
      expect(payload).not.toContain(`Vitest #341 Payment ${stamp}`);
    });

    it('positive control: session B (the owning org) can read its own filtered rows', async () => {
      // Confirms the previous tests are not "trivially passing" because
      // the rows simply don't exist or the routes always 403.
      expect(orgBBowlerId).not.toBeNull();
      expect(orgBLeagueId).not.toBeNull();

      const ownerBowlers = await apiGet<Bowler[]>(
        `/api/bowlers?ids=${orgBBowlerId}`,
        sessionB,
      );
      expect(ownerBowlers.status).toBe(200);
      if (Array.isArray(ownerBowlers.data.data) && orgBBowlerId != null) {
        expect(collectIds(ownerBowlers.data.data)).toContain(orgBBowlerId);
      }

      const ownerPayments = await apiGet<Payment[]>(
        `/api/payments?leagueId=${orgBLeagueId}`,
        sessionB,
      );
      expect(ownerPayments.status).toBe(200);
      if (Array.isArray(ownerPayments.data.data) && orgBPaymentId != null) {
        expect(collectIds(ownerPayments.data.data)).toContain(orgBPaymentId);
      }
    });

    // ----------------------------------------------------------------
    // Task #344 — extend the same cross-org leak coverage to remaining
    // filtered list endpoints called out in the task: /api/bowler-leagues
    // (?bowlerId | ?leagueId | ?teamId, plus unfiltered list scoping),
    // /api/payment-schedules/:bowlerId/:leagueId, and /api/locations.
    // Reuses the org B fixtures created in this describe's beforeAll.
    // ----------------------------------------------------------------
    interface BowlerLeagueRow { id: number; bowlerId: number; leagueId: number; teamId: number }
    interface LocationRow { id: number; name: string }

    it('org A GET /api/bowler-leagues?bowlerId=<orgB bowler> → 403 (route gates by bowler access)', async () => {
      expect(orgBBowlerId).not.toBeNull();
      const { status, data } = await apiGet<BowlerLeagueRow[]>(
        `/api/bowler-leagues?bowlerId=${orgBBowlerId}`,
        sessionA,
      );
      expect(status).toBe(403);
      expect(data.success).toBe(false);
      const payload = JSON.stringify(data);
      expect(payload).not.toContain(`Vitest #341 Bowler ${stamp}`);
    });

    it('org A GET /api/bowler-leagues?leagueId=<orgB league> → 403 (route gates by league access)', async () => {
      expect(orgBLeagueId).not.toBeNull();
      const { status, data } = await apiGet<BowlerLeagueRow[]>(
        `/api/bowler-leagues?leagueId=${orgBLeagueId}`,
        sessionA,
      );
      expect(status).toBe(403);
      expect(data.success).toBe(false);
    });

    it('org A GET /api/bowler-leagues?teamId=<orgB team> → 403 (route gates by team access)', async () => {
      expect(orgBTeamId).not.toBeNull();
      const { status, data } = await apiGet<BowlerLeagueRow[]>(
        `/api/bowler-leagues?teamId=${orgBTeamId}`,
        sessionA,
      );
      expect(status).toBe(403);
      expect(data.success).toBe(false);
    });

    it('org A GET /api/bowler-leagues (no filter) must scope to caller org and exclude org B rows', async () => {
      // The unfiltered branch falls back to scoping by req.user.organizationId.
      // Make sure the org B link the fixtures created is NEVER returned.
      expect(orgBBowlerLeagueId).not.toBeNull();
      const { status, data } = await apiGet<BowlerLeagueRow[]>(
        '/api/bowler-leagues',
        sessionA,
      );
      expect(status).toBe(200);
      if (Array.isArray(data.data) && orgBBowlerLeagueId != null) {
        const ids = collectIds(data.data);
        expect(ids).not.toContain(orgBBowlerLeagueId);
      }
    });

    it('org A GET /api/bowler-leagues?enriched=true&teamId=<orgB team> → 403 (enriched flag must not bypass gate)', async () => {
      // Defense in depth: the enrichment branch lives downstream of the
      // access checks. Asserting it still 403s ensures a future refactor
      // doesn't accidentally reorder enrichment ahead of gating.
      expect(orgBTeamId).not.toBeNull();
      const { status, data } = await apiGet(
        `/api/bowler-leagues?teamId=${orgBTeamId}&enriched=true`,
        sessionA,
      );
      expect(status).toBe(403);
      expect(data.success).toBe(false);
      const payload = JSON.stringify(data);
      expect(payload).not.toContain(`Vitest #341 Bowler ${stamp}`);
      expect(payload).not.toContain(`Vitest #341 Team ${stamp}`);
    });

    it('org A GET /api/payment-schedules/<orgB bowler>/<orgB league> → 403 (cross-org id pair denied)', async () => {
      // The schedule fetch route gates on hasAccessToBowler. Whether or
      // not a schedule row actually exists, session A must be denied —
      // the response must never reveal schedule details OR the absence
      // signal (200 + null) for an org B bowler.
      expect(orgBBowlerId).not.toBeNull();
      expect(orgBLeagueId).not.toBeNull();
      const { status, data } = await apiGet(
        `/api/payment-schedules/${orgBBowlerId}/${orgBLeagueId}`,
        sessionA,
      );
      expect(status).toBe(403);
      expect(data.success).toBe(false);

      // The legacy schedule endpoint is retired for roster-configured
      // leagues. The owning org receives the same explicit retirement
      // response; cross-tenant callers still fail before any data can leak.
      const owner = await apiGet(
        `/api/payment-schedules/${orgBBowlerId}/${orgBLeagueId}`,
        sessionB,
      );
      expect(owner.status).toBe(410);
      expect(owner.data.success).toBe(false);
    });

    it('org A GET /api/payment-schedules/setup-quote/<orgB bowler>/<orgB league> is retired without an oracle', async () => {
      expect(orgBBowlerId).not.toBeNull();
      expect(orgBLeagueId).not.toBeNull();
      const { status, data } = await apiGet(
        `/api/payment-schedules/setup-quote/${orgBBowlerId}/${orgBLeagueId}`,
        sessionA,
      );
      expect(status).toBe(410);
      expect(data.success).toBe(false);
      const payload = JSON.stringify(data);
      expect(payload).not.toContain(`Vitest #341 Bowler ${stamp}`);
      expect(payload).not.toContain(`Vitest #341 Team ${stamp}`);
    });

    it('org A GET /api/locations must not include the org B location row', async () => {
      // The locations list uses filterByOrganization middleware. Any
      // accidental fall-through to "all locations" would surface the
      // org B location id we created in beforeAll.
      expect(orgBLocationId).not.toBeNull();
      const { status, data } = await apiGet<LocationRow[]>('/api/locations', sessionA);
      expect(status).toBe(200);
      if (Array.isArray(data.data) && orgBLocationId != null) {
        const ids = collectIds(data.data);
        expect(ids).not.toContain(orgBLocationId);
      }
      const payload = JSON.stringify(data);
      expect(payload).not.toContain(`Vitest Iso Location ${stamp}`);
    });

    it('positive control (#344): session B sees its own bowler-leagues + location', async () => {
      // Pins the negatives above against the same fixture: session B
      // (the owning org) must actually reach and return the rows.
      expect(orgBBowlerId).not.toBeNull();
      expect(orgBLocationId).not.toBeNull();

      const ownerLinks = await apiGet<BowlerLeagueRow[]>(
        `/api/bowler-leagues?bowlerId=${orgBBowlerId}`,
        sessionB,
      );
      expect(ownerLinks.status).toBe(200);
      if (Array.isArray(ownerLinks.data.data) && orgBBowlerLeagueId != null) {
        expect(collectIds(ownerLinks.data.data)).toContain(orgBBowlerLeagueId);
      }

      const ownerLocations = await apiGet<LocationRow[]>('/api/locations', sessionB);
      expect(ownerLocations.status).toBe(200);
      if (Array.isArray(ownerLocations.data.data) && orgBLocationId != null) {
        expect(collectIds(ownerLocations.data.data)).toContain(orgBLocationId);
      }
    });

    // ----------------------------------------------------------------
    // Task #399 — backfill cross-org coverage for the remaining
    // id-bearing GET endpoints flagged by
    // `scripts/check-org-isolation-coverage.ts`. Public branding/avatar
    // endpoints are intentionally allowlisted in the script and not
    // tested here. Each test below requests an org B id (or org B's
    // organizationId) as session A and asserts either a strict 403/404
    // or a 200 with no leaking row/payload.
    // ----------------------------------------------------------------
    describe('task #399 — additional cross-org coverage (lint backfill)', () => {
      // Five GET handlers below all share the same shape: an org A
      // caller targets an org B id (or a placeholder id for the
      // admin-only template route, where the requireAdmin gate fires
      // before any id lookup) and must receive a strict 403 with a
      // `success: false` body. They were originally five near-identical
      // `it(...)` blocks; collapsed into one `it.each` to make adding
      // a new endpoint a one-line addition. The `pathTemplate` strings
      // intentionally embed `${...}` segments so
      // `scripts/check-org-isolation-coverage.ts` still recognises
      // each `:param` segment as covered. Heterogeneous tests below
      // (positive-control, listing-leak-checks, echo-equality, etc.)
      // stay inline because their assertion shapes diverge.
      it.each([
        {
          // Admin router is gated by requireOrgAdmin at mount and each
          // handler additionally calls requireAdmin (system_admin only).
          // An org_admin caller hits 403 from requireAdmin before any id
          // lookup happens, so a placeholder id is enough.
          name: 'GET /api/admin/email-templates/:id (admin-only)',
          path: () => `/api/admin/email-templates/${999999}`,
        },
        {
          name: 'GET /api/locations/:id (org B location)',
          path: () => `/api/locations/${orgBLocationId}`,
        },
        {
          name: 'GET /api/locations/:id/square-config (org B location)',
          path: () => `/api/locations/${orgBLocationId}/square-config`,
        },
        {
          // Both segments must be `${...}` references so the coverage
          // lint's regex counts every `:param` of the effective path.
          name: 'GET /api/scores/league/:leagueId/week/:weekNumber (org B league)',
          path: () => {
            const weekNumber = 1;
            return `/api/scores/league/${orgBLeagueId}/week/${weekNumber}`;
          },
        },
      ])('org A $name → 403/404', async ({ path }) => {
        const { status, data } = await apiGet(path(), sessionA);
        expect([403, 404]).toContain(status);
        expect(data.success).toBe(false);
      });

      it('org A GET /api/leagues/:id/season-history (org B league) → 403/404 and does not leak the season chain', async () => {
        // Pre-#399 this handler walked the full season chain via
        // storage.getLeagues(league.organizationId) with no access
        // check — pointing it at an org B league id would surface
        // org B's whole season history to org A. The fix gates on
        // hasAccessToLeague; verify the gate stays in place.
        expect(orgBLeagueId).not.toBeNull();
        const { status, data } = await apiGet(
          `/api/leagues/${orgBLeagueId}/season-history`,
          sessionA,
        );
        expect([403, 404]).toContain(status);
        expect(data.success).toBe(false);

        // Positive control: the owning org reaches the handler so the
        // 403 above is meaningful and not just a route mis-mount.
        const owner = await apiGet(
          `/api/leagues/${orgBLeagueId}/season-history`,
          sessionB,
        );
        expect(owner.status).toBe(200);
        expect(owner.data.success).toBe(true);
      });

      // Parameterize the three homogeneous "/api/locations/:id[...]" cases
      // — each expects a strict 403 and uses the same org B location id.
      // The `${orgBLocationId}` template-literal segments stay verbatim in
      // source so `scripts/check-org-isolation-coverage.ts` (which greps
      // each `:param` as `\$\{[^}]+\}`) keeps recognising the references.
      it.each([
        {
          label: 'org A GET /api/locations/:id (org B location) → 403 and does not leak the row',
          path: () => `/api/locations/${orgBLocationId}`,
          checkLeak: true,
        },
        {
          label: 'org A GET /api/locations/:id/square-config (org B location) → 403',
          path: () => `/api/locations/${orgBLocationId}/square-config`,
          checkLeak: false,
        },
      ])('$label', async ({ path, checkLeak }) => {
        expect(orgBLocationId).not.toBeNull();
        const { status, data } = await apiGet(path(), sessionA);
        expect(status).toBe(403);
        expect(data.success).toBe(false);
        if (checkLeak) {
          const payload = JSON.stringify(data);
          expect(payload).not.toContain(`Vitest Iso Location ${stamp}`);
        }
      });

      it('org A GET /api/scores/league/:leagueId/week/:weekNumber (org B league) → 404 without tenant enumeration', async () => {
        expect(orgBLeagueId).not.toBeNull();
        // Bind the week number to a variable so both segments are
        // template-literal `${...}` references — the coverage lint's
        // regex requires every `:param` segment of the effective path
        // to appear that way for the test to count as referencing it.
        const weekNumber = 1;
        const { status, data } = await apiGet(
          `/api/scores/league/${orgBLeagueId}/week/${weekNumber}`,
          sessionA,
        );
        expect(status).toBe(404);
        expect(data.success).toBe(false);
      });

      it('org A GET /api/bowlers?organizationId=<orgB> must not include the org B bowler', async () => {
        expect(orgBBowlerId).not.toBeNull();
        expect(orgBId).not.toBeNull();
        const { status, data } = await apiGet<Bowler[]>(
          `/api/bowlers?organizationId=${orgBId}`,
          sessionA,
        );
        // Org admins are scoped to their own organizationId regardless
        // of the query param, so this should resolve to org A's own
        // bowlers (with org B's bowler absent).
        expect(status).toBe(200);
        if (Array.isArray(data.data) && orgBBowlerId != null) {
          expect(collectIds(data.data)).not.toContain(orgBBowlerId);
        }
        const payload = JSON.stringify(data);
        expect(payload).not.toContain(`Vitest #341 Bowler ${stamp}`);
        expect(payload).not.toContain(`vitest-341-${stamp}@example.com`);
      });

      it('org A GET /api/bowlers/unlinked?organizationId=<orgB> must not surface any org B bowler', async () => {
        // The handler clamps non-system-admin callers to their own
        // org, so even though we're passing org B's id the response
        // must reflect org A's data and never reveal org B's bowler
        // name.
        expect(orgBBowlerId).not.toBeNull();
        expect(orgBId).not.toBeNull();
        const { status, data } = await apiGet(
          `/api/bowlers/unlinked?organizationId=${orgBId}`,
          sessionA,
        );
        expect(status).toBe(200);
        const payload = JSON.stringify(data);
        expect(payload).not.toContain(`Vitest #341 Bowler ${stamp}`);
        expect(payload).not.toContain(`vitest-341-${stamp}@example.com`);
      });

      it('org A GET /api/payments?organizationId=<orgB> must not include the org B payment', async () => {
        // For non-system-admin callers payment-reports.ts always uses
        // req.user.organizationId and ignores the ?organizationId
        // query param. Pointing it at org B's id from session A must
        // therefore yield zero rows pointing at the org B payment row.
        expect(orgBPaymentId).not.toBeNull();
        expect(orgBId).not.toBeNull();
        const { status, data } = await apiGet<Payment[]>(
          `/api/payments?organizationId=${orgBId}`,
          sessionA,
        );
        expect(status).toBe(200);
        if (Array.isArray(data.data) && orgBPaymentId != null) {
          expect(collectIds(data.data)).not.toContain(orgBPaymentId);
        }
        const payload = JSON.stringify(data);
        expect(payload).not.toContain(`Vitest #341 Payment ${stamp}`);
      });

      it('org A GET /api/bowler-links/admin?organizationId=<orgB> must return [] or 403 and not list org B links', async () => {
        expect(orgBId).not.toBeNull();
        const { status, data } = await apiGet(
          `/api/bowler-links/admin?organizationId=${orgBId}`,
          sessionA,
        );
        if (status === 200) {
          const payload = (data as { data?: { links?: unknown[] } }).data;
          const links = payload?.links ?? [];
          expect(Array.isArray(links)).toBe(true);
          expect(links.length).toBe(0);
        } else {
          expect([400, 403]).toContain(status);
          expect(data.success).toBe(false);
        }
      });

      it('org A GET /api/system-admin/admin-email-change-audits?targetUserId=<orgB user> → 403 (system_admin only)', async () => {
        // Task #487 added this audit-list endpoint for system admins
        // to inspect a target user's admin-initiated email-change
        // history. The route is gated by `requireAdmin` (system_admin
        // only), so an org_admin caller — even pointing the
        // `targetUserId` query param at a user that lives in another
        // org — must be rejected before any audit row is read or
        // returned. Without this gate an org A admin could enumerate
        // org B users' email-change history just by guessing user
        // ids; pin the gate so a future refactor can't relax it.
        const orgBTargetUserId = sessionB.user.id;
        const { status, data } = await apiGet(
          `/api/system-admin/admin-email-change-audits?targetUserId=${orgBTargetUserId}`,
          sessionA,
        );
        expect(status).toBe(403);
        expect(data.success).toBe(false);
      });
    });
  });
});
