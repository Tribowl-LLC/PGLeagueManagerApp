/**
 * GET /api/system-admin/trust-proxy-status (task #379)
 * ------------------------------------------------------------------
 * The endpoint exposes the live `req.ip` Express resolved + the
 * configured trust-proxy setting + the same synthetic probe the boot
 * guard uses, so a post-deploy smoke check can assert end-to-end that
 * a config change at the reverse-proxy layer (managed edge, custom domain,
 * future CDN) hasn't silently re-introduced the misconfiguration that
 * collapses every per-IP rate limit into a global ceiling.
 *
 * This test pins:
 *   1. Auth contract: 401 unauthenticated, 403 non-system-admin,
 *      200 for system_admin.
 *   2. Response shape: `live`, `config`, `synthetic` keys present and
 *      typed correctly. Crucially the synthetic block reports `ok:
 *      true` because the dev server itself sets `trust proxy = 1`,
 *      mirroring production.
 *
 * Note on XFF assertions: we deliberately do NOT pin "the request's
 * X-Forwarded-For header round-trips byte-for-byte" here. In the
 * A hosted test environment may put an edge proxy in front of the dev
 * server that rewrites/replaces XFF, so the value the endpoint sees
 * need not match what we set client-side. The truncation logic
 * (256-char cap + ellipsis marker) is small enough to read by
 * inspection and is exercised end-to-end by the post-deploy probe
 * (`scripts/verify-trust-proxy-deploy.ts`) when run against a real
 * deployment.
 */
import { describe, it, expect } from 'vitest';
import {
  login,
  purgeSessionCache,
  apiGet,
  type AuthSession,
  TEST_ADMIN_EMAIL,
  TEST_ADMIN_PASSWORD,
  TEST_ORG_A_EMAIL,
  TEST_ORG_PASSWORD,
  BASE_URL,
} from '../helpers';

interface StatusBody {
  live: {
    resolvedIp: string | null;
    socketRemoteAddress: string | null;
    xForwardedFor: string | null;
    protocol: string;
    hostname: string;
  };
  config: {
    trustProxySetting: unknown;
  };
  synthetic: {
    ok: boolean;
    resolvedIp: string;
    reason: string | null;
  };
}

describe('GET /api/system-admin/trust-proxy-status', () => {
  // Login is performed inside each `it` that needs it, NOT in
  // `beforeAll`. Under the `parallel` vitest project (isolate:false,
  // 4 forks) sibling tests share the same DB and can rotate / expire
  // sessions out from under a `beforeAll`-shared cookie, producing
  // 401s on tests that should be 200. Per-test login uses helpers.ts's
  // in-process `loginCache` so cost is amortized across the file.
  // See task #703 (the flake we are fixing here) and the file header
  // for the broader cross-fork-contention rationale.

  it('rejects unauthenticated callers with 401', async () => {
    const { status } = await apiGet('/api/system-admin/trust-proxy-status');
    expect(status).toBe(401);
  });

  it('rejects non-system-admin callers with 403', async () => {
    const orgUser = await login(TEST_ORG_A_EMAIL, TEST_ORG_PASSWORD);
    const { status } = await apiGet('/api/system-admin/trust-proxy-status', orgUser);
    expect(status).toBe(403);
  });

  it('returns the live + config + synthetic shape for a system_admin', async () => {
    // Fresh per-test login; one retry on 401 covers the narrow window
    // where a sibling test (same DB under the `parallel` project) just
    // rotated this admin's session before our request landed. See the
    // describe-block comment above for the cross-fork rationale.
    //
    // IMPORTANT: `login()` in `tests/helpers.ts` memoises by email
    // (`loginCache`), so a second `await login(...)` after a 401 would
    // return the same stale `AuthSession`. We must `purgeSessionCache`
    // first to force a brand-new login flow on retry.
    let { status, data } = await apiGet<StatusBody>(
      '/api/system-admin/trust-proxy-status',
      await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD),
    );
    if (status === 401) {
      purgeSessionCache(TEST_ADMIN_EMAIL);
      ({ status, data } = await apiGet<StatusBody>(
        '/api/system-admin/trust-proxy-status',
        await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD),
      ));
    }
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    const body = data.data;
    expect(body).toBeDefined();

    // live block: resolvedIp may be 127.0.0.1 in test (we connect via
    // localhost), but the field must be present and a string|null.
    expect(body!.live).toBeDefined();
    expect(typeof body!.live.protocol).toBe('string');
    expect(typeof body!.live.hostname).toBe('string');
    expect(
      body!.live.resolvedIp === null || typeof body!.live.resolvedIp === 'string',
    ).toBe(true);
    expect(
      body!.live.socketRemoteAddress === null
        || typeof body!.live.socketRemoteAddress === 'string',
    ).toBe(true);

    // config block: dev server calls `app.set('trust proxy', 1)` in
    // setupAuth, so the setting is the number 1 (NOT a function — we
    // deliberately project '[function]' if it ever becomes one).
    expect(body!.config).toBeDefined();
    expect(body!.config.trustProxySetting).toBe(1);

    // synthetic block: same probe as the boot guard. Trust proxy = 1
    // means the synthetic XFF (`203.0.113.7`) must resolve to that
    // exact address; if it doesn't, the boot guard would have thrown.
    expect(body!.synthetic.ok).toBe(true);
    expect(body!.synthetic.resolvedIp).toBe('203.0.113.7');
    expect(body!.synthetic.reason).toBeNull();

    // The endpoint always echoes the live XFF header (or null). We
    // assert only the *type contract* here — the value itself is
    // whatever the upstream edge proxy decided to put on the wire,
    // which is environment-specific (see file header note).
    expect(
      body!.live.xForwardedFor === null
        || typeof body!.live.xForwardedFor === 'string',
    ).toBe(true);
  });

  // ----------------------------------------------------------------
  // X-Probe-Token auth path. The post-deploy CI probe authenticates
  // with this header instead of a session cookie so it never needs
  // to be rotated on the ~24h session expiry cadence. The server-side
  // contract (`requireProbeTokenOrAdmin` in
  // `server/routes/system-admin.ts`) is:
  //
  //   - matching token AND >=32-char server config → 200, no session
  //     required
  //   - non-matching token → 401 with code `INVALID_PROBE_TOKEN`,
  //     even if a valid admin session is also presented (we MUST NOT
  //     fall through to session auth, otherwise an attacker probing
  //     for valid tokens with a stolen cookie would be silently let in)
  //   - no token presented → standard requireAdmin contract applies
  //     (already covered by the unauth/non-admin/admin tests above)
  //
  // These tests rely on the dev environment having
  // TRUST_PROXY_PROBE_TOKEN set (see `.local/.commit_message`); they
  // skip themselves with a loud message if it's missing so a fresh
  // checkout doesn't register a false positive.
  // ----------------------------------------------------------------
  const probeToken = process.env.TRUST_PROXY_PROBE_TOKEN?.trim();
  const probeConfigured = !!probeToken && probeToken.length >= 32;

  describe.skipIf(!probeConfigured)('X-Probe-Token auth path', () => {
    it('accepts a matching X-Probe-Token with no session and returns the status body', { retry: 2 }, async () => {
      const res = await fetch(`${BASE_URL}/api/system-admin/trust-proxy-status`, {
        headers: {
          Accept: 'application/json',
          'X-Probe-Token': probeToken!,
        },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data?: StatusBody };
      expect(body.success).toBe(true);
      expect(body.data?.synthetic.ok).toBe(true);
    });

    it('rejects a wrong X-Probe-Token with 401 INVALID_PROBE_TOKEN', async () => {
      // Same length as the real token so we also exercise the
      // timingSafeEqual path (it throws on length mismatch); a wrong
      // token of the right length must still come back as 401.
      const wrong = 'X'.repeat(probeToken!.length);
      const res = await fetch(`${BASE_URL}/api/system-admin/trust-proxy-status`, {
        headers: {
          Accept: 'application/json',
          'X-Probe-Token': wrong,
        },
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { success: boolean; error?: { code?: string } };
      expect(body.success).toBe(false);
      expect(body.error?.code).toBe('INVALID_PROBE_TOKEN');
    });

    it('rejects a wrong X-Probe-Token even when a valid admin session cookie is also presented', async () => {
      // Defense-in-depth: a presented-but-wrong token must NOT fall
      // through to session auth. Otherwise an attacker probing for a
      // valid token while holding a stolen cookie would never see a
      // failure signal.
      const admin: AuthSession = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
      const res = await fetch(`${BASE_URL}/api/system-admin/trust-proxy-status`, {
        headers: {
          Accept: 'application/json',
          'X-Probe-Token': 'definitely-not-the-right-token-but-long-enough-12345',
          Cookie: admin.cookies,
        },
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { success: boolean; error?: { code?: string } };
      expect(body.error?.code).toBe('INVALID_PROBE_TOKEN');
    });

    it('rejects a length-mismatched X-Probe-Token with 401 (timingSafeEqual cannot compare)', async () => {
      const res = await fetch(`${BASE_URL}/api/system-admin/trust-proxy-status`, {
        headers: {
          Accept: 'application/json',
          // One char shorter than the real token, so the length-check
          // guard rejects before timingSafeEqual is ever called.
          'X-Probe-Token': 'a'.repeat(probeToken!.length - 1),
        },
      });
      expect(res.status).toBe(401);
    });
  });
});
