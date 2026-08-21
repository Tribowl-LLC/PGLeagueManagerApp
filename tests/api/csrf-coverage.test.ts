/**
 * Regression tests for CSRF coverage on session-mutating routes (task #297).
 *
 * Pins three contracts:
 *  1. `PATCH /api/account/profile/:id` requires a valid CSRF token (was
 *     audit-flagged).
 *  2. `POST /api/account/change-password` requires a valid CSRF token (was
 *     audit-flagged).
 *  3. `POST /api/setup/first-system-admin/:id` is EXEMPT from CSRF — it is
 *     the disaster-recovery promote-to-admin endpoint and is authenticated
 *     by the `x-setup-secret` header from `curl`, before any browser
 *     session exists. Added to `EXEMPT_PATHS` in this audit; this test
 *     prevents a regression that would re-break the recovery flow.
 *
 * For (3) we only assert the absence of `CSRF_ERROR` — the endpoint still
 * rejects the call for other reasons (missing setup secret, an admin
 * already exists), and we don't want a CSRF regression to be hidden by
 * those downstream rejections.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  login,
  type AuthSession,
  TEST_ORG_A_EMAIL,
  TEST_ORG_PASSWORD,
  BASE_URL,
} from '../helpers';

interface ApiResponse {
  success: boolean;
  data?: unknown;
  error?: { message: string; code?: string };
}

async function rawRequest(
  path: string,
  init: RequestInit,
): Promise<{ status: number; body: ApiResponse }> {
  // Add the test-only rate-limit bypass header on every raw request.
  // The setup-admin endpoint is protected by `setupAdminLimiter`
  // (5 requests / 15 min, backed by a shared Postgres store), so
  // re-running this test file across vitest invocations would
  // exhaust the bucket and turn legitimate 401/403 assertions into
  // flaky 429s. The bypass is gated on `NODE_ENV !== 'production'`
  // server-side (see `testBypassSkip` in `server/middleware/rate-limit.ts`).
  const headers: Record<string, string> = {
    ...((init.headers as Record<string, string> | undefined) ?? {}),
    'x-test-rate-limit-bypass': '1',
  };
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers });
  const body = await res.json().catch(() => ({ success: false } as ApiResponse));
  return { status: res.status, body };
}

describe('CSRF coverage on session-mutating routes', () => {
  let orgAdmin: AuthSession;

  beforeAll(async () => {
    orgAdmin = await login(TEST_ORG_A_EMAIL, TEST_ORG_PASSWORD);
  });

  describe('PATCH /api/account/profile/:id', () => {
    it('returns 403 CSRF_ERROR without an x-csrf-token header', async () => {
      const { status, body } = await rawRequest(
        `/api/account/profile/${orgAdmin.user.id}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Cookie: orgAdmin.cookies,
          },
          body: JSON.stringify({ name: 'CSRF Test' }),
        },
      );
      expect(status).toBe(403);
      expect(body.error?.code).toBe('CSRF_ERROR');
    });

    it('succeeds (200) when the valid token is included', async () => {
      const { status, body } = await rawRequest(
        `/api/account/profile/${orgAdmin.user.id}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Cookie: orgAdmin.cookies,
            'x-csrf-token': orgAdmin.csrfToken,
          },
          // Set name to its existing value so the test is idempotent and
          // does not mutate fixture state across runs. We still go through
          // the full update pipeline, which is what the CSRF gate test
          // needs to cover.
          body: JSON.stringify({ name: orgAdmin.user.name }),
        },
      );
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.error?.code).not.toBe('CSRF_ERROR');
    });
  });

  describe('POST /api/account/change-password', () => {
    it('returns 403 CSRF_ERROR without an x-csrf-token header', async () => {
      const { status, body } = await rawRequest('/api/account/change-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: orgAdmin.cookies,
        },
        body: JSON.stringify({
          currentPassword: 'wrong-on-purpose',
          newPassword: 'NewPassw0rd!Strong',
        }),
      });
      expect(status).toBe(403);
      expect(body.error?.code).toBe('CSRF_ERROR');
    });

    it('does NOT 403 CSRF_ERROR when the valid token is included', async () => {
      // Intentionally send an invalid current password so the request
      // passes the CSRF gate but the handler safely rejects it with
      // INVALID_PASSWORD — proving CSRF was honored without actually
      // mutating the test user's password.
      const { status, body } = await rawRequest('/api/account/change-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: orgAdmin.cookies,
          'x-csrf-token': orgAdmin.csrfToken,
        },
        body: JSON.stringify({
          currentPassword: 'definitely-not-the-real-password',
          newPassword: 'NewPassw0rd!Strong',
        }),
      });
      expect(body.error?.code).not.toBe('CSRF_ERROR');
      expect(status).not.toBe(403);
      // Sanity-check: the handler's own rejection path was reached.
      expect(body.error?.code).toBe('INVALID_PASSWORD');
    });
  });

  describe('POST /api/setup/first-system-admin/:id (CSRF-exempt)', () => {
    it('does NOT return CSRF_ERROR when called without an x-csrf-token header', async () => {
      // No session, no CSRF token, no setup secret. The endpoint will
      // reject for some other reason (forbidden / admin-exists / unset
      // secret), but the CSRF gate must let it through — that's the
      // point of the exempt entry.
      const { status, body } = await rawRequest(
        '/api/setup/first-system-admin/999999999',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      );
      expect(body.error?.code).not.toBe('CSRF_ERROR');
      // Defensive: make sure we got a response from the route handler
      // (or its auth gate) rather than the CSRF middleware short-circuit.
      expect([400, 401, 403, 404, 409, 500]).toContain(status);
    });

    it('still rejects with non-CSRF auth error when x-setup-secret is missing', async () => {
      // Defense-in-depth: prove the endpoint's own auth gate (the
      // x-setup-secret header) still fires after the CSRF exemption.
      // This guards against a future refactor that accidentally drops
      // the secret check now that CSRF no longer covers the path.
      const { status, body } = await rawRequest(
        '/api/setup/first-system-admin/999999999',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      );
      expect(body.success).toBe(false);
      expect(body.error?.code).not.toBe('CSRF_ERROR');
      // The setup-admin handler returns 401/403 on missing/invalid
      // secret. We accept either to stay tolerant of internal
      // refactoring of error codes.
      expect([401, 403]).toContain(status);
    });
  });
});
