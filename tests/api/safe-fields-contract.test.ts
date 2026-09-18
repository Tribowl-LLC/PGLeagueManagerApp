/**
 * End-to-end deny-by-default contract test (task #383).
 *
 * The unit tests in `tests/unit/sanitize-user.test.ts` and
 * `tests/unit/sanitize-org.test.ts` prove that `sanitizeUser` /
 * `sanitizeOrg` themselves drop unknown fields. The CI guard in
 * `scripts/check-wire-sanitization.ts` (task #382) proves no route
 * passes a raw `User` / `Organization` row to `sendSuccess`.
 *
 * What was missing: a test that hits a real, running route and
 * proves the keys that actually appear on the wire are a strict
 * subset of `SAFE_USER_FIELDS` / `SAFE_ORG_FIELDS`. If a future
 * change registers a new endpoint that bypasses the helpers in some
 * way the static guard doesn't catch, this test fails — locking the
 * contract end-to-end.
 *
 * Endpoint choices:
 *   - `POST /api/auth/login` returns exactly `sanitizeUser(user)`
 *     (server/routes/auth.ts). It's the cleanest user-shaped
 *     response on a real route and reaches the wire over the same
 *     pipeline as every other endpoint.
 *   - The retired tenant-lifecycle `GET /api/organizations/:id` route is
 *     not mounted in singleton mode, so it is intentionally not exercised
 *     here; organization-shaped response contracts remain covered by their
 *     route-specific tests.
 */
import { describe, it, expect } from 'vitest';
import {
  BASE_URL,
  TEST_ADMIN_EMAIL,
  TEST_ADMIN_PASSWORD,
} from '../helpers';
import { SAFE_USER_FIELDS } from '../../server/utils/api';

function assertSubset(
  actualKeys: string[],
  allowed: ReadonlyArray<string>,
  label: string,
): void {
  const allowedSet = new Set<string>(allowed);
  const leaked = actualKeys.filter((k) => !allowedSet.has(k));
  expect(
    leaked,
    `${label}: response contained keys outside the safe-field allowlist. ` +
      `Leaked keys: ${JSON.stringify(leaked)}. ` +
      `Allowed: ${JSON.stringify([...allowedSet])}.`,
  ).toEqual([]);
}

describe('Deny-by-default wire contract (integration)', () => {
  it('POST /api/auth/login returns only SAFE_USER_FIELDS keys', async () => {
    // Hit the route directly so we inspect the raw JSON body —
    // `login()` itself parses into a typed shape and would mask any
    // extra fields the server actually sent.
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: TEST_ADMIN_EMAIL,
        password: TEST_ADMIN_PASSWORD,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: Record<string, unknown> };
    expect(body.success).toBe(true);
    expect(body.data).toBeTruthy();
    expect(typeof body.data).toBe('object');

    assertSubset(Object.keys(body.data), SAFE_USER_FIELDS, 'POST /api/auth/login');
  });
});
