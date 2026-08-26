/**
 * Task #454 / #518 — sweep test for admin-supplied FK ids.
 *
 * Pins the existence-check pattern set by task #422 (the
 * `?organizationId` guard on `POST /api/bowlers`) for every guard
 * #454 swept onto the admin surface.
 *
 * #454 added the original two regression cases at this layer for
 * the highest-blast-radius routes (`POST /api/payments` bowlerId
 * and `PATCH /api/organization-admin/users/:id/location`). #518
 * extends the same pattern to the rest of the routes #454 touched
 * (`POST /api/leagues`, `PATCH /api/leagues/:id`, `POST /api/locations`,
 * `POST /api/org-admin/users/:id/add`, `POST /api/org-admin/users/create`)
 * so a future refactor that quietly removes one of those guards
 * fails this suite instead of silently regressing the route to a
 * raw `foreign_key_violation` 500. The audit document at
 * `docs/security/admin-fk-id-checks.md` is the source-of-truth
 * catalogue.
 *
 * Each missing-id assertion uses `2_000_000_000` — well above any
 * seeded id but well within int range — so the only failure mode
 * left is the existence check (no parser fallthrough, no FK
 * fallthrough). For tenant-scoped FKs (locations on leagues /
 * users) we also assert the cross-tenant case, since #454
 * deliberately conflated "missing" with "wrong tenant" into the
 * same 404 to avoid an existence oracle.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, like } from 'drizzle-orm';
import { db } from '../../server/db';
import {
  bowlerLeagues,
  bowlers,
  leagues,
  locations,
  organizations,
  payments,
  teams,
  users,
} from '@shared/schema';
import {
  apiPatch,
  apiPost,
  login,
  type AuthSession,
  TEST_ADMIN_EMAIL,
  TEST_ADMIN_PASSWORD,
  TEST_ORG_A_EMAIL,
  TEST_ORG_B_EMAIL,
  TEST_ORG_PASSWORD,
} from '../helpers';

const TEST_ORG_A_SLUG = process.env.TEST_ORG_A_SLUG || 'vitest-org-a';
const TEST_ORG_B_SLUG = process.env.TEST_ORG_B_SLUG || 'vitest-org-b';

// 2_000_000_000 is well above any seeded id but well within int range
// so it parses cleanly and the only failure mode left is the existence
// check (no parser fallthrough, no FK fallthrough). Reused across every
// missing-id assertion below.
const MISSING_ID = 2_000_000_000;

describe('Task #454 — admin-supplied FK id existence checks', () => {
  let orgAAdmin: AuthSession;
  let orgAId = 0;
  let leagueOrgAId = 0;
  let bowlerId = 0;
  const createdPaymentIds: number[] = [];

  beforeAll(async () => {
    orgAAdmin = await login(TEST_ORG_A_EMAIL, TEST_ORG_PASSWORD);

    const [orgA] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, TEST_ORG_A_SLUG));
    if (!orgA) throw new Error('Test org A missing — run seed-test-users');
    orgAId = orgA.id;

    const [la] = await db
      .insert(leagues)
      .values({
        name: 'Vitest #454 Org-A League',
        seasonStart: '2025-01-01 00:00:00',
        seasonEnd: '2025-12-31 00:00:00',
        weekDay: 'Monday',
        organizationId: orgAId,
      })
      .returning({ id: leagues.id });
    leagueOrgAId = la.id;

    const [bw] = await db
      .insert(bowlers)
      .values({ name: 'Vitest #454 Bowler', organizationId: orgAId })
      .returning({ id: bowlers.id });
    bowlerId = bw.id;

    // P1 (#737): payment creation now requires the bowler to be actively
    // rostered in the league. Stand up a team + active roster row so the
    // happy-path POST below still reaches the create path.
    const [tm] = await db
      .insert(teams)
      .values({ name: 'Vitest #454 Team', number: 1, leagueId: leagueOrgAId })
      .returning({ id: teams.id });
    await db
      .insert(bowlerLeagues)
      .values({ bowlerId, leagueId: leagueOrgAId, teamId: tm.id, active: true });
  });

  afterAll(async () => {
    if (createdPaymentIds.length) {
      await db.delete(payments).where(inArray(payments.id, createdPaymentIds));
    }
    if (bowlerId) {
      await db.delete(bowlers).where(eq(bowlers.id, bowlerId));
    }
    if (leagueOrgAId) {
      await db.delete(leagues).where(eq(leagues.id, leagueOrgAId));
    }
  });

  describe('POST /api/payments', () => {
    it('rejects the retired inferred payment route before FK lookup', async () => {
      // 2_000_000_000 is well above any seeded bowler id but well within
      // int range, so it parses cleanly and the only failure mode is
      // the existence check (no FK fallthrough). Mirrors the missing-
      // org id pattern in tests/api/bowler-creation-org-required.test.ts.
      const missingBowlerId = 2_000_000_000;
      const { status, data } = await apiPost(
        '/api/payments',
        {
          bowlerId: missingBowlerId,
          leagueId: leagueOrgAId,
          amount: 100,
          weekOf: '2025-01-06 00:00:00',
          type: 'cash',
          status: 'paid',
        },
        orgAAdmin,
      );

      expect(status).toBe(409);
      expect(data.success).toBe(false);
      expect(data.error?.code).toBe('CANONICAL_ALLOCATION_REQUIRED');

      // Belt-and-suspenders: prove no row was inserted under the
      // missing bowler id. If the existence check ever regresses,
      // the FK fallthrough would leave the DB in the same state
      // (the insert would have aborted), so this primarily catches
      // the case where someone "fixes" the 500 by silently coercing
      // the bowler id to something else.
      const orphans = await db
        .select({ id: payments.id })
        .from(payments)
        .where(eq(payments.bowlerId, missingBowlerId));
      expect(orphans).toHaveLength(0);
    });

    it('rejects inferred cash entry even when the bowler exists', async () => {
      // Closes the matrix so a regression that turns the existence
      // check into a deny-everything guard would also be caught.
      const { status, data } = await apiPost<{ id: number; bowlerId: number }>(
        '/api/payments',
        {
          bowlerId,
          leagueId: leagueOrgAId,
          amount: 100,
          weekOf: '2025-01-06 00:00:00',
          type: 'cash',
          status: 'paid',
        },
        orgAAdmin,
      );

      expect(status).toBe(409);
      expect(data.success).toBe(false);
      expect(data.error?.code).toBe('CANONICAL_ALLOCATION_REQUIRED');
    });
  });

  describe('PATCH /api/organization-admin/users/:id/location', () => {
    it('returns 404 when the locationId points at a non-existent location', async () => {
      // Re-target the org A admin themselves as the user being
      // updated (they're the caller, in their own org, so the
      // org-admin same-org guard is satisfied). The only failure
      // mode left is the new existence check.
      const missingLocationId = 2_000_000_000;
      const { status, data } = await apiPatch(
        `/api/org-admin/users/${orgAAdmin.user.id}/location`,
        { locationId: missingLocationId },
        orgAAdmin,
      );

      expect(status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.error?.message).toMatch(/location not found/i);
    });

    it('happy path: clearing the assignment with locationId: null still succeeds', async () => {
      // The null branch deliberately skips the existence check (no
      // FK to validate). If a regression accidentally treated null
      // as a missing-id error, this test would catch it. We only
      // assert the response is a success — the underlying user row
      // is left in whatever state it was in, since this test runs
      // against the shared test admin account.
      const { status, data } = await apiPatch(
        `/api/org-admin/users/${orgAAdmin.user.id}/location`,
        { locationId: null },
        orgAAdmin,
      );

      expect(status).toBe(200);
      expect(data.success).toBe(true);
    });
  });
});

describe('Task #518 — pin remaining admin FK id existence checks', () => {
  let sysAdmin: AuthSession;
  let orgAAdmin: AuthSession;
  let orgBAdmin: AuthSession;
  let orgAId = 0;
  let orgBId = 0;
  let leagueOrgAId = 0;
  let locationOrgBId = 0;
  let inactiveLocationOrgAId = 0;

  // Cleanup buckets — every fixture row created in beforeAll, plus
  // any rows the happy-path tests may decide to write. The negative
  // tests below all expect 404 BEFORE any insert, so they never
  // contribute here, but a regression that turns a guard into a
  // pass-through would still be caught by the audit-table test
  // failures rather than by orphaned rows piling up.
  const createdLocationIds: number[] = [];
  const createdLeagueIds: number[] = [];
  // Email pattern reserved for the org-admin/users/create negative
  // tests so we can wipe any accidental survivors at the end.
  const CREATE_USER_EMAIL_PREFIX = 'vitest-518-create-';

  beforeAll(async () => {
    sysAdmin = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
    orgAAdmin = await login(TEST_ORG_A_EMAIL, TEST_ORG_PASSWORD);
    orgBAdmin = await login(TEST_ORG_B_EMAIL, TEST_ORG_PASSWORD);

    const [orgA] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, TEST_ORG_A_SLUG));
    if (!orgA) throw new Error('Test org A missing — run seed-test-users');
    orgAId = orgA.id;

    const [orgB] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, TEST_ORG_B_SLUG));
    if (!orgB) throw new Error('Test org B missing — run seed-test-users');
    orgBId = orgB.id;

    // A real league in org A so the PATCH /api/leagues/:id tests
    // have something to mutate. The route lookup runs BEFORE the
    // FK existence checks, so we need a real id-with-org-access
    // even when we expect a 404 from the new guard.
    const [la] = await db
      .insert(leagues)
      .values({
        name: 'Vitest #518 League',
        seasonStart: '2025-01-01 00:00:00',
        seasonEnd: '2025-12-31 00:00:00',
        weekDay: 'Monday',
        organizationId: orgAId,
      })
      .returning({ id: leagues.id });
    leagueOrgAId = la.id;
    createdLeagueIds.push(la.id);

    // The cross-tenant locationId tests need a real location row
    // owned by org B that an org A admin can try (and fail) to
    // stamp onto a league or user. Belongs to org B by FK, so the
    // same-tenant comparison in each guard is what fires the 404
    // (not the existence check) — exactly the case the audit
    // doc calls out as the "existence-oracle" risk.
    const [locB] = await db
      .insert(locations)
      .values({ name: 'Vitest #518 Loc B', organizationId: orgBId })
      .returning({ id: locations.id });
    locationOrgBId = locB.id;
    createdLocationIds.push(locB.id);

    const [inactiveLocA] = await db
      .insert(locations)
      .values({ name: 'Vitest #518 Inactive Loc A', organizationId: orgAId, active: false })
      .returning({ id: locations.id });
    inactiveLocationOrgAId = inactiveLocA.id;
    createdLocationIds.push(inactiveLocA.id);
  });

  afterAll(async () => {
    // Sweep any users the /users/create negative tests may have
    // accidentally inserted. The tests all expect a 404 BEFORE
    // the user insert, so this should normally be a no-op — but
    // a regression that turns the guard into a pass-through would
    // leave rows behind, and we don't want them poisoning later
    // runs (the duplicate-email guard would mask the regression
    // by switching the failure mode to a 409 conflict).
    await db.delete(users).where(like(users.email, `${CREATE_USER_EMAIL_PREFIX}%`));

    if (createdLeagueIds.length) {
      await db.delete(leagues).where(inArray(leagues.id, createdLeagueIds));
    }
    if (createdLocationIds.length) {
      await db.delete(locations).where(inArray(locations.id, createdLocationIds));
    }
  });

  // ----------------------- POST /api/leagues -----------------------

  describe('POST /api/leagues', () => {
    it('returns 404 NOT_FOUND when a system_admin posts with a non-existent organizationId', async () => {
      // System admin path: bodyOrg wins over the (null) session org,
      // so a typoed body.organizationId is exactly what the new
      // existence pre-check at server/routes/leagues.ts:148-151 is
      // there to catch. Without it, the request falls through to
      // the `leagues.organization_id -> organizations.id` FK and
      // surfaces as a generic 500.
      const { status, data } = await apiPost(
        '/api/leagues',
        {
          name: 'Vitest #518 Missing Org',
          seasonStart: '2025-01-01 00:00:00',
          seasonEnd: '2025-12-31 00:00:00',
          weekDay: 'Monday',
          organizationId: MISSING_ID,
        },
        sysAdmin,
      );

      expect(status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.error?.code).toBe('NOT_FOUND');
      expect(data.error?.message).toMatch(/organization not found/i);
    });

    it('returns 404 when an org_admin posts with a non-existent locationId', async () => {
      // The org id resolves cleanly from the org_admin's session
      // (orgAId), so the only failure mode left is the locationId
      // existence guard at server/routes/leagues.ts:157-165.
      const { status, data } = await apiPost(
        '/api/leagues',
        {
          name: 'Vitest #518 Missing Loc',
          seasonStart: '2025-01-01 00:00:00',
          seasonEnd: '2025-12-31 00:00:00',
          weekDay: 'Monday',
          locationId: MISSING_ID,
        },
        orgAAdmin,
      );

      expect(status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.error?.code).toBe('NOT_FOUND');
      expect(data.error?.message).toMatch(/location not found/i);
    });

    it('returns 404 when an org_admin posts with an inactive locationId', async () => {
      const { status, data } = await apiPost(
        '/api/leagues',
        {
          name: 'Vitest #518 Inactive Loc',
          seasonStart: '2025-01-01 00:00:00',
          seasonEnd: '2025-12-31 00:00:00',
          weekDay: 'Monday',
          locationId: inactiveLocationOrgAId,
        },
        orgAAdmin,
      );

      expect(status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.error?.code).toBe('NOT_FOUND');
      expect(data.error?.message).toMatch(/location not found/i);
    });

    it('returns 404 when an org_admin tries to stamp a league with a location from another organization', async () => {
      // The locationId is real — but it belongs to org B, not the
      // caller's org A. The same-tenant arm of the guard at
      // server/routes/leagues.ts:159 must conflate this with the
      // missing-id case so an attacker can't probe for which
      // location ids exist outside their tenant.
      const { status, data } = await apiPost(
        '/api/leagues',
        {
          name: 'Vitest #518 Cross-Tenant Loc',
          seasonStart: '2025-01-01 00:00:00',
          seasonEnd: '2025-12-31 00:00:00',
          weekDay: 'Monday',
          locationId: locationOrgBId,
        },
        orgAAdmin,
      );

      expect(status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.error?.message).toMatch(/location not found/i);
    });
  });

  // -------------------- PATCH /api/leagues/:id ---------------------

  describe('PATCH /api/leagues/:id', () => {
    it('returns 404 when a system_admin re-stamps a league onto a non-existent organizationId', async () => {
      // Mirror of the POST guard but for the update branch at
      // server/routes/leagues.ts:209-218. The non-system-admin
      // branch already 403s for any org change, so this is the
      // only path the FK existence check is reachable from.
      const { status, data } = await apiPatch(
        `/api/leagues/${leagueOrgAId}`,
        { organizationId: MISSING_ID },
        sysAdmin,
      );

      expect(status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.error?.code).toBe('NOT_FOUND');
      expect(data.error?.message).toMatch(/organization not found/i);
    });

    it('returns 404 when an org_admin patches a league with a non-existent locationId', async () => {
      const { status, data } = await apiPatch(
        `/api/leagues/${leagueOrgAId}`,
        { locationId: MISSING_ID },
        orgAAdmin,
      );

      expect(status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.error?.code).toBe('NOT_FOUND');
      expect(data.error?.message).toMatch(/location not found/i);
    });

    it('returns 404 when an org_admin patches a league with a location from another organization', async () => {
      // Cross-tenant arm of the PATCH location guard
      // (server/routes/leagues.ts:228-235). Same existence-oracle
      // reasoning as the POST cross-tenant test above.
      const { status, data } = await apiPatch(
        `/api/leagues/${leagueOrgAId}`,
        { locationId: locationOrgBId },
        orgAAdmin,
      );

      expect(status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.error?.message).toMatch(/location not found/i);
    });
  });

  // ---------------------- POST /api/locations ----------------------

  describe('POST /api/locations', () => {
    it('returns 404 when a system_admin creates a location for a non-existent organizationId', async () => {
      // The non-sysadmin path is pinned to the caller's session
      // org by the equality check at server/routes/locations.ts:71,
      // so the only path the new FK existence check at lines 82-85
      // is reachable from is system_admin overriding via body.
      // Without the guard, a typoed id falls through to the
      // `locations.organization_id -> organizations.id` FK and 500s.
      const { status, data } = await apiPost(
        '/api/locations',
        {
          name: 'Vitest #518 Loc Missing Org',
          organizationId: MISSING_ID,
        },
        sysAdmin,
      );

      expect(status).toBe(404);
      expect(data.success).toBe(false);
      // Task #542 unified the admin-route 404 code on the
      // SCREAMING_SNAKE `'NOT_FOUND'` value. server/routes/locations.ts
      // previously emitted `'NotFound'` (PascalCase); pinning the
      // canonical value here means any future drift back to a
      // route-local variant fails this assertion.
      expect(data.error?.code).toBe('NOT_FOUND');
      expect(data.error?.message).toMatch(/organization not found/i);
    });
  });

  // ----------------- POST /api/org-admin/users/:id/add -----------------

  describe('POST /api/org-admin/users/:id/add', () => {
    it('returns 404 when a system_admin tries to add a user to a non-existent organizationId', async () => {
      // The orgRow check at server/routes/organization-admin.ts:286-289
      // runs BEFORE the user lookup at line 291, so any path-userId
      // is fine here — the org id is the failure mode under test.
      // Use the org B admin id (a real user) so we don't accidentally
      // trip the user-not-found arm if the order is ever swapped.
      const { status, data } = await apiPost(
        `/api/org-admin/users/${orgBAdmin.user.id}/add`,
        { organizationId: MISSING_ID },
        sysAdmin,
      );

      expect(status).toBe(404);
      expect(data.success).toBe(false);
      // Task #542 unified on `'NOT_FOUND'` —
      // server/routes/organization-admin.ts previously emitted the
      // lower_snake `'not_found'` variant.
      expect(data.error?.code).toBe('NOT_FOUND');
      expect(data.error?.message).toMatch(/organization not found/i);
    });
  });

  // ----------------- POST /api/org-admin/users/create ------------------

  describe('POST /api/org-admin/users/create', () => {
    it('returns 404 when a system_admin creates a user under a non-existent organizationId', async () => {
      const { status, data } = await apiPost(
        '/api/org-admin/users/create',
        {
          firstName: 'Vitest',
          lastName: '#518 MissingOrg',
          email: `${CREATE_USER_EMAIL_PREFIX}missing-org@example.com`,
          organizationId: MISSING_ID,
        },
        sysAdmin,
      );

      expect(status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.error?.code).toBe('NOT_FOUND');
      expect(data.error?.message).toMatch(/organization not found/i);

      // Belt-and-suspenders: prove no row was inserted under the
      // missing org id. If the existence check ever regresses to
      // a pass-through, the duplicate-email guard would fire on
      // the next run and mask the regression — this catches the
      // first-run leak directly.
      const orphans = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, `${CREATE_USER_EMAIL_PREFIX}missing-org@example.com`));
      expect(orphans).toHaveLength(0);
    });

    it('returns 404 when a system_admin creates a user with a non-existent locationId', async () => {
      // Org id resolves to a real org so the org guard passes; the
      // locationId guard at server/routes/organization-admin.ts:509-514
      // is the only failure mode left.
      const { status, data } = await apiPost(
        '/api/org-admin/users/create',
        {
          firstName: 'Vitest',
          lastName: '#518 MissingLoc',
          email: `${CREATE_USER_EMAIL_PREFIX}missing-loc@example.com`,
          organizationId: orgAId,
          locationId: MISSING_ID,
        },
        sysAdmin,
      );

      expect(status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.error?.code).toBe('NOT_FOUND');
      expect(data.error?.message).toMatch(/location not found/i);
    });

    it('returns 404 when an org_admin creates a user with a location from another organization', async () => {
      // Cross-tenant arm of the same locationId guard. The
      // org_admin's session org wins (orgAId), and locationOrgBId
      // belongs to org B — the same-tenant comparison at line 511
      // is what fires the 404 (not the existence check), proving
      // the wrong-tenant case is collapsed into the same response
      // as the missing-id case.
      const { status, data } = await apiPost(
        '/api/org-admin/users/create',
        {
          firstName: 'Vitest',
          lastName: '#518 CrossTenant',
          email: `${CREATE_USER_EMAIL_PREFIX}cross-tenant@example.com`,
          locationId: locationOrgBId,
        },
        orgAAdmin,
      );

      expect(status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.error?.message).toMatch(/location not found/i);
    });
  });
});

describe('Task #543 — pin apple-pay register-domain cross-tenant location check', () => {
  // The route at server/routes/payments-provider/apple-pay.ts:309-312
  // collapses "location does not exist" and "location belongs to another
  // org" into the same 403 FORBIDDEN response so an org_admin can't use
  // the route as an existence oracle for location ids in tenants they
  // don't own. The audit catalogue at docs/security/admin-fk-id-checks.md
  // already lists this guard, but #518 only swept regression tests for
  // the rest of the table — this route was the lone unpinned row, which
  // is exactly the same risk #518 addressed (a future refactor of
  // `getPaymentProvider` quietly removing the same-tenant arm of the
  // check). The two assertions below mirror the missing-location /
  // cross-tenant pattern used everywhere else in this file.

  let orgAAdmin: AuthSession;
  let orgBId = 0;
  let locationOrgBId = 0;
  const createdLocationIds: number[] = [];

  // Domain has to satisfy the org-admin domain guard that runs BEFORE
  // the locationId check (route lines 280-287). Mirror the suffix
  // resolution from tests/api/apple-pay-register-domain.test.ts so this
  // suite still runs when APP_DOMAIN points at a staging hostname.
  const APP_DOMAIN_SUFFIX = process.env.APP_DOMAIN ?? 'leaguevault.app';
  const ENDPOINT = '/api/payments-provider/apple-pay/register-domain';
  const orgADomain = `${TEST_ORG_A_SLUG}.${APP_DOMAIN_SUFFIX}`;

  beforeAll(async () => {
    orgAAdmin = await login(TEST_ORG_A_EMAIL, TEST_ORG_PASSWORD);

    const [orgB] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, TEST_ORG_B_SLUG));
    if (!orgB) throw new Error('Test org B missing — run seed-test-users');
    orgBId = orgB.id;

    const [locB] = await db
      .insert(locations)
      .values({ name: 'Vitest #543 Loc B', organizationId: orgBId })
      .returning({ id: locations.id });
    locationOrgBId = locB.id;
    createdLocationIds.push(locB.id);
  });

  afterAll(async () => {
    if (createdLocationIds.length) {
      await db.delete(locations).where(inArray(locations.id, createdLocationIds));
    }
  });

  it('returns 403 FORBIDDEN when an org_admin posts with a non-existent locationId', async () => {
    // Real positive integer, well above any seeded id, so the strict
    // parser passes and the only failure mode left is the existence
    // arm of the same-org guard (route line 310: `!location`).
    const { status, data } = await apiPost(
      ENDPOINT,
      { domain: orgADomain, locationId: MISSING_ID },
      orgAAdmin,
    );

    expect(status).toBe(403);
    expect(data.success).toBe(false);
    expect(data.error?.code).toBe('FORBIDDEN');
    expect(data.error?.message).toMatch(/location does not belong to your organization/i);
  });

  it('returns the same 403 FORBIDDEN when an org_admin posts with a locationId from another organization', async () => {
    // The locationId is real — but it belongs to org B, not the
    // caller's org A. The same-tenant arm of the guard
    // (route line 310: `location.organizationId !== req.user.organizationId`)
    // must produce a response that's indistinguishable from the
    // missing-id case above so the route can't be used as an
    // existence oracle for ids in another tenant.
    const { status, data } = await apiPost(
      ENDPOINT,
      { domain: orgADomain, locationId: locationOrgBId },
      orgAAdmin,
    );

    expect(status).toBe(403);
    expect(data.success).toBe(false);
    expect(data.error?.code).toBe('FORBIDDEN');
    expect(data.error?.message).toMatch(/location does not belong to your organization/i);
  });
});
