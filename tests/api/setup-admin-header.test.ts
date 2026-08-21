/**
 * Regression tests for setup-admin secret-gate header normalization (#283).
 * See `checkSetupSecret` in server/routes/setup-admin.ts.
 *
 * Hits the dev server directly on localhost so `X-Forwarded-For` spoofing
 * actually isolates per-test rate-limit buckets under `setupAdminLimiter`
 * (5 req / 15 min / IP). `X-Forwarded-Proto: https` is set so the request
 * also exercises the trusted reverse-proxy metadata path used in deployment.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import { checkSetupSecret } from '../../server/routes/setup-admin';
import { BASE_URL as SHARED_BASE_URL } from '../helpers';

// Intentionally allows a dedicated override because `setupAdminLimiter` is
// 5 req / 15 min / IP and we need `X-Forwarded-For` to actually reach
// express-rate-limit's keyGenerator — only possible when we hit the
// trusted local hop directly.
//
// Resolution order (all local hops):
//   1. `SETUP_ADMIN_TEST_BASE_URL` — explicit override.
//   2. `TEST_BASE_URL` — set by `tests/setup/per-worker-setup.ts` to
//      `http://127.0.0.1:<port>` for the per-fork test app vitest spawns.
//      Without this, the HTTP requests below default to `localhost:5000`
//      and hit whatever (if anything) is listening there instead of the
//      per-worker app, which is the same misrouting bug that broke
//      setup-admin-bootstrap-race.test.ts under `bash scripts/test-race.sh`.
//   3. `http://localhost:5000` — last-resort local fallback (dev server
//      explicitly started by the developer).
const BASE_URL =
  process.env.SETUP_ADMIN_TEST_BASE_URL ||
  SHARED_BASE_URL;
const SETUP_SECRET = process.env.SETUP_SECRET;

let ipCounter = 0;
function freshIp(): string {
  ipCounter += 1;
  return `203.0.113.${(ipCounter % 250) + 1}`;
}

// --- unit harness: direct `checkSetupSecret` calls ---
// The string[] branch of the header normalization is only reachable via
// a direct call: Node's HTTP/1 parser collapses repeated headers into a
// single comma-joined string before the route handler ever sees them.
// (Verified: Node's fetch Headers.append serializes two values for the
// same name as `"v1, v2"` on the wire; iterating the Headers object
// shows the same single-string view.) The HTTP harness below pins that
// collapsed comma-joined shape end-to-end against both endpoints, in
// both "bogus first" and "real first" orderings.

function makeReq(headerValue: string | string[] | undefined): Request {
  const headers: Record<string, string | string[] | undefined> = {};
  if (headerValue !== undefined) headers['x-setup-secret'] = headerValue;
  return { headers } as unknown as Request;
}

function makeRes(): { res: Response; status: () => number | null; code: () => string | undefined } {
  let statusCode: number | null = null;
  let body: unknown = null;
  const res = {
    status(code: number) { statusCode = code; return this as unknown as Response; },
    json(payload: unknown) { body = payload; return this as unknown as Response; },
  } as unknown as Response;
  return {
    res,
    status: () => statusCode,
    code: () => (body as { error?: { code?: string } } | null)?.error?.code,
  };
}

describe('checkSetupSecret unit — header normalization', () => {
  // Task #431: this suite runs as part of the default `npm test` job
  // (no opt-in flag), so a CI environment that forgets to wire
  // SETUP_SECRET would historically silently `it.skip` the entire
  // header-normalisation matrix and report a green build — exactly
  // the regression net this file is supposed to be. Hard-fail with a
  // remediation pointer instead, matching the pattern landed for the
  // bootstrap-race suite in task #360.
  if (!SETUP_SECRET) {
    it('FAILS LOUDLY: SETUP_SECRET must be set for the setup-admin header suite', () => {
      throw new Error(
        'SETUP_SECRET is required for tests/api/setup-admin-header.test.ts. ' +
          'It is wired into the default `npm test` run, so a CI job that ' +
          'forgets to export it will silently lose all setup-admin header ' +
          'coverage. Set it in your CI secrets (and locally export it) ' +
          'before running `npm test`. ' +
          'See tests/README.md → "CI wiring" for the full list of required CI secrets.',
      );
    });
    return;
  }

  it('rejects a string[] header with bogus first element (no crash)', () => {
    const r = makeRes();
    expect(checkSetupSecret(makeReq(['bogus', SETUP_SECRET!]), r.res)).toBe(false);
    expect(r.status()).toBe(401);
    expect(r.code()).toBe('UNAUTHORIZED');
  });

  it('accepts a string[] header whose first element matches', () => {
    const r = makeRes();
    expect(checkSetupSecret(makeReq([SETUP_SECRET!, 'trailing']), r.res)).toBe(true);
    expect(r.status()).toBeNull();
  });

  it('rejects the comma-joined duplicate shape "bogus, <real>"', () => {
    const r = makeRes();
    expect(checkSetupSecret(makeReq(`bogus, ${SETUP_SECRET}`), r.res)).toBe(false);
    expect(r.status()).toBe(401);
  });

  it('rejects a non-string header body', () => {
    const r = makeRes();
    expect(checkSetupSecret(makeReq(123 as unknown as string), r.res)).toBe(false);
    expect(r.status()).toBe(401);
  });

  it('accepts the correct secret as a single string', () => {
    const r = makeRes();
    expect(checkSetupSecret(makeReq(SETUP_SECRET!), r.res)).toBe(true);
    expect(r.status()).toBeNull();
  });
});

// --- HTTP harness: per-endpoint coverage of the four required cases ---

interface EndpointSpec {
  label: string;
  path: string;
  body: () => unknown;
  needsCsrf: boolean;
}

const ENDPOINTS: EndpointSpec[] = [
  {
    label: 'POST /api/setup/create-first-admin',
    path: '/api/setup/create-first-admin',
    body: () => ({
      email: `setup-hdr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@vitest.local`,
      password: 'NotTheRealAdmin!2026',
      name: 'Setup Header Test',
    }),
    needsCsrf: false,
  },
  {
    label: 'POST /api/setup/first-system-admin/:id',
    path: '/api/setup/first-system-admin/0',
    body: () => ({}),
    needsCsrf: true,
  },
];

async function primeCsrf(): Promise<{ cookies: string; csrf: string }> {
  const res = await fetch(`${BASE_URL}/api/csrf-token`, {
    headers: { 'X-Forwarded-For': freshIp(), 'X-Forwarded-Proto': 'https' },
  });
  if (!res.ok) throw new Error(`csrf prime failed: ${res.status}`);
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length === 0) throw new Error('csrf prime returned no Set-Cookie');
  const cookies = setCookie.map((c) => c.split(';')[0]).join('; ');
  const body = (await res.json()) as { data?: { token?: string } };
  const csrf = body.data?.token ?? '';
  if (!csrf) throw new Error('csrf prime returned no token');
  return { cookies, csrf };
}

describe('setup-admin endpoints — per-endpoint secret-gate coverage', () => {
  // Task #431: see the matching block above — same reason, same
  // hard-fail pattern (task #360). This suite runs in the default
  // `npm test` job, so a missing SETUP_SECRET must surface as a CI
  // failure rather than a silent skip.
  if (!SETUP_SECRET) {
    it('FAILS LOUDLY: SETUP_SECRET must be set for the setup-admin endpoint suite', () => {
      throw new Error(
        'SETUP_SECRET is required for tests/api/setup-admin-header.test.ts. ' +
          'It is wired into the default `npm test` run, so a CI job that ' +
          'forgets to export it will silently lose all per-endpoint ' +
          'secret-gate coverage. Set it in your CI secrets (and locally ' +
          'export it) before running `npm test`. ' +
          'See tests/README.md → "CI wiring" for the full list of required CI secrets.',
      );
    });
    return;
  }

  let cookies = '';
  let csrf = '';

  beforeAll(async () => {
    const primed = await primeCsrf();
    cookies = primed.cookies;
    csrf = primed.csrf;
  });

  async function post(
    ep: EndpointSpec,
    secret: string | string[] | undefined,
  ): Promise<{ status: number; code?: string }> {
    const headers = new Headers();
    headers.set('Content-Type', 'application/json');
    headers.set('X-Forwarded-For', freshIp());
    headers.set('X-Forwarded-Proto', 'https');
    if (ep.needsCsrf) {
      headers.set('Cookie', cookies);
      headers.set('x-csrf-token', csrf);
    }
    if (Array.isArray(secret)) {
      for (const v of secret) headers.append('X-Setup-Secret', v);
    } else if (secret !== undefined) {
      headers.set('X-Setup-Secret', secret);
    }
    const res = await fetch(`${BASE_URL}${ep.path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(ep.body()),
    });
    let parsed: unknown = null;
    try { parsed = await res.json(); } catch { /* empty */ }
    return {
      status: res.status,
      code: (parsed as { error?: { code?: string } } | null)?.error?.code,
    };
  }

  for (const ep of ENDPOINTS) {
    describe(ep.label, () => {
      it('returns 401 when X-Setup-Secret is sent as a duplicated header', async () => {
        const out = await post(ep, ['bogus', SETUP_SECRET!]);
        expect(out.status).toBe(401);
        expect(out.code).toBe('UNAUTHORIZED');
      });

      it('returns 401 when no X-Setup-Secret header is present', async () => {
        const out = await post(ep, undefined);
        expect(out.status).toBe(401);
        expect(out.code).toBe('UNAUTHORIZED');
      });

      it('returns 401 when X-Setup-Secret is a wrong single value', async () => {
        const out = await post(ep, 'definitely-wrong');
        expect(out.status).toBe(401);
        expect(out.code).toBe('UNAUTHORIZED');
      });

      it('returns 401 for the literal comma-joined "<real>, trailing" wire shape', async () => {
        // Defense-in-depth: even when the real secret appears FIRST in the
        // collapsed string, the route must not treat the joined string as
        // a match. Guards against any future "split on comma + take first"
        // normalization regression. Complements the duplicated-header test
        // above, which only covers "bogus, <real>" ordering on the wire.
        const out = await post(ep, `${SETUP_SECRET}, trailing`);
        expect(out.status).toBe(401);
        expect(out.code).toBe('UNAUTHORIZED');
      });

      it('passes the secret gate when X-Setup-Secret is correct', async () => {
        const out = await post(ep, SETUP_SECRET!);
        expect(out.status).not.toBe(401);
        expect(out.status).not.toBe(500);
        if (out.code) {
          expect(out.code).not.toBe('UNAUTHORIZED');
          expect(out.code).not.toBe('CSRF_ERROR');
        }
      });
    });
  }
});
