/**
 * Task #415 — route-level audit of every bowler-insert call site.
 *
 * Production inserts into `bowlers` through POST /api/bowlers
 * (`server/routes/bowlers.ts`).
 *
 * The route stamps `organizationId` from the caller's session before
 * delegating to `storage.createBowler`. It refuses with a clean
 * 403 FORBIDDEN when the org cannot be derived, so the user never
 * sees the raw `bowlers.organization_id` NOT NULL DB error from
 * task #407.
 *
 * These tests pin the 403 guard as a regression net. Pairs with:
 *   - tests/unit/bowler-org-not-null.test.ts  (DB-level safety net)
 *   - tests/api/auth-org-required.test.ts     (sister route guard)
 *
 * The seed `admin@example.com` user is `system_admin` with
 * `organization_id = NULL` (see scripts/seed and the `users` table),
 * which is the only realistic in-product caller without an org —
 * org_admin / user roles are blocked by the `users_role_org_required`
 * invariant from ever reaching this code path with a null org.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../server/db';
import { bowlers } from '@shared/schema';
import {
  BASE_URL,
  TEST_ADMIN_EMAIL,
  TEST_ADMIN_PASSWORD,
  TEST_ORG_A_EMAIL,
  TEST_ORG_PASSWORD,
  apiPost,
  login,
} from '../helpers';

const createdBowlerIds: number[] = [];

afterEach(async () => {
  if (createdBowlerIds.length > 0) {
    await db.delete(bowlers).where(inArray(bowlers.id, createdBowlerIds));
    createdBowlerIds.length = 0;
  }
});

describe('Bowler creation routes — organization context guards (task #415)', () => {
  describe('POST /api/bowlers', () => {
    it('returns 403 FORBIDDEN when a system_admin posts without ?organizationId and has no session org', async () => {
      const session = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
      // Sanity: this whole test is about the no-org-context path. If
      // the seed admin ever gets attached to an org, the assertion
      // below would mis-fire as a "stamp succeeded" success rather
      // than the 403 we want to pin — so fail loudly here instead.
      expect(session.user.role).toBe('system_admin');
      expect(session.user.organizationId).toBeNull();

      const { status, data } = await apiPost(
        '/api/bowlers',
        {
          name: 'Vitest Org-less Bowler #415',
          email: null,
          phone: null,
          active: true,
          order: 0,
        },
        session,
      );

      expect(status).toBe(403);
      expect(data.success).toBe(false);
      expect(data.error?.code).toBe('FORBIDDEN');
      expect(data.error?.message).toMatch(/organization context required/i);
    });

    it('returns 404 when a system_admin supplies a numeric ?organizationId for a non-existent org (task #422)', async () => {
      // Pins the existence check at server/routes/bowlers.ts so a
      // typoed or stale org id returns a clean 404 instead of letting
      // the `bowlers.organization_id -> organizations.id` foreign key
      // constraint surface as a generic 500. Sister guard to the 403
      // above (no org id at all) and the 400 below (malformed id).
      const session = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);

      // 2_000_000_000 is well above any seeded org id and well within
      // int range, so it parses cleanly but cannot exist in the table.
      const missingOrgId = 2_000_000_000;
      const res = await fetch(`${BASE_URL}/api/bowlers?organizationId=${missingOrgId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.cookies,
          'x-csrf-token': session.csrfToken,
        },
        body: JSON.stringify({
          name: 'Vitest Missing Org #422',
          email: null,
          phone: null,
          active: true,
          order: 0,
        }),
      });
      const data = await res.json();

      expect(res.status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.error?.code).toBe('NOT_FOUND');
      expect(data.error?.message).toMatch(/organization not found/i);

      // Belt-and-suspenders: prove no row was inserted for the
      // missing org id. If the guard ever regresses to a 500-after-
      // insert, this would catch it.
      const orphan = await db
        .select()
        .from(bowlers)
        .where(eq(bowlers.organizationId, missingOrgId));
      expect(orphan).toHaveLength(0);
    });

    it('returns 400 when a system_admin supplies a non-numeric ?organizationId query param', async () => {
      // Pins the strict-parser guard in the system-admin override
      // block of server/routes/bowlers.ts (task #453 swapped the
      // older `parseInt + isNaN` pattern for `parseOptionalIntParam`)
      // so a malformed override returns a clean 400 instead of
      // silently falling through to `callerOrgId` (which would be
      // a no-op cross-org stamp surprise) or to the DB constraint.
      const session = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);

      const res = await fetch(`${BASE_URL}/api/bowlers?organizationId=not-a-number`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.cookies,
          'x-csrf-token': session.csrfToken,
        },
        body: JSON.stringify({
          name: 'Vitest NaN Org #415',
          email: null,
          phone: null,
          active: true,
          order: 0,
        }),
      });
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error?.message).toMatch(/invalid organization id format/i);
    });

    it('returns 400 when a system_admin supplies a partially-numeric ?organizationId like "1abc" (task #453)', async () => {
      // Sister pin to the `not-a-number` test above. The OLD parser
      // — `parseInt(req.query.organizationId as string)` — silently
      // accepted partially-numeric input like `?organizationId=1abc`
      // as `1`, because `parseInt` reads as many leading digits as
      // it can find and discards the rest. Combined with the #422
      // existence check, an admin who fat-fingered an org id that
      // *coincidentally* started with a real org id (e.g. typing
      // `1abc` while meaning org `42`) would have stamped the new
      // bowler onto org `1` instead of failing — a silent cross-org
      // surprise. After #453 the route uses `parseOptionalIntParam`,
      // which only accepts strings matching `/^-?\d+$/` and returns
      // `null` (-> 400) for anything else.
      const session = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);

      const res = await fetch(`${BASE_URL}/api/bowlers?organizationId=1abc`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.cookies,
          'x-csrf-token': session.csrfToken,
        },
        body: JSON.stringify({
          name: 'Vitest Partial-Num Org #453',
          email: null,
          phone: null,
          active: true,
          order: 0,
        }),
      });
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error?.message).toMatch(/invalid organization id format/i);

      // Belt-and-suspenders: confirm no row was inserted under the
      // silently-coerced id `1`. If the parser ever regresses to the
      // loose `parseInt` pattern, this would catch any accidental
      // stamp by the test name.
      // eslint-disable-next-line leaguevault/no-unscoped-table-query-in-test-assertion -- scoped by a unique-by-construction synthetic bowler name; no .id available because the assertion is "row was NOT inserted".
      const accidentalRows = await db
        .select()
        .from(bowlers)
        .where(eq(bowlers.name, 'Vitest Partial-Num Org #453'));
      expect(accidentalRows).toHaveLength(0);
    });

    it('happy path: stamps the bowler with the caller\'s session org', async () => {
      // Closes the matrix opposite the two negative tests above: a
      // valid creation actually persists `organizationId` on the row,
      // proving the stamping path itself works (not just that the
      // guards fail). Uses an org_admin so the stamp source is the
      // session, not the sysadmin override branch.
      const session = await login(TEST_ORG_A_EMAIL, TEST_ORG_PASSWORD);
      expect(session.user.role).toBe('org_admin');
      expect(typeof session.user.organizationId).toBe('number');

      const { status, data } = await apiPost<{ id: number; organizationId: number }>(
        '/api/bowlers',
        {
          name: 'Vitest Happy Path #415',
          email: null,
          phone: null,
          active: true,
          order: 0,
        },
        session,
      );

      expect(status).toBe(201);
      expect(data.success).toBe(true);
      const created = data.data!;
      createdBowlerIds.push(created.id);

      // The new row in the database carries the caller's session org
      // (not null, not some other org) — the whole point of #415.
      const [row] = await db.select().from(bowlers).where(eq(bowlers.id, created.id));
      expect(row).toBeDefined();
      expect(row.organizationId).toBe(session.user.organizationId);
    });
  });
});
