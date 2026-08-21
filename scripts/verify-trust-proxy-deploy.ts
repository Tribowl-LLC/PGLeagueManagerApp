/**
 * Post-deploy verification probe for the trust-proxy contract (task #379).
 *
 * Pairs with the boot-time guard at `server/lib/trust-proxy-check.ts`
 * and the system-admin debug endpoint
 * `GET /api/system-admin/trust-proxy-status`. The boot guard catches
 * code-side misconfiguration on startup; this probe catches the case
 * where a config change at the proxy layer (managed edge, custom
 * domain, future CDN) silently re-introduces the bug without any code
 * change. If `req.ip` collapses to the proxy's loopback / private
 * address, every per-IP rate limiter (notably the 5 req / 15 min
 * setupAdminLimiter) becomes a global ceiling for the entire internet.
 *
 * What this script does
 * ---------------------
 *   1. Calls the debug endpoint on the deployed app, authenticating
 *      either via an `X-Probe-Token` header (preferred — long-lived
 *      shared secret, no rotation) or a `Cookie` header carrying a
 *      system_admin session (legacy — sessions expire after ~24h).
 *   2. Asserts HTTP 200 and the response shape is valid JSON.
 *   3. Asserts `synthetic.ok === true` — the boot probe still passes
 *      (i.e. nothing about the deployed Express config has drifted
 *      since last boot).
 *   4. Asserts `live.resolvedIp` is NOT a loopback / private address.
 *      That's the post-deploy reality check: a real external request
 *      from this script's caller IP must come back as a routable
 *      public address.
 *   5. If `EXPECTED_RESOLVED_IP` is set, asserts an exact match. Use
 *      this from a CI job that knows its egress IP (e.g. a self-hosted
 *      runner with a static IP).
 *
 * Required env vars
 * -----------------
 *   BASE_URL         e.g. https://app.example.com
 *
 *   AND exactly ONE of:
 *     PROBE_TOKEN    long-lived shared secret matching the server's
 *                    `TRUST_PROXY_PROBE_TOKEN` env var. Sent as the
 *                    `X-Probe-Token` header. Must be at least 32
 *                    chars (the server enforces the same minimum).
 *                    PREFERRED — never expires, no rotation needed.
 *     ADMIN_COOKIE   full Cookie header value for a system_admin
 *                    session, e.g. "connect.sid=s%3A...". LEGACY —
 *                    expires with the session (~24h by default).
 *                    Only used when PROBE_TOKEN is unset.
 *
 * Optional env vars
 * -----------------
 *   EXPECTED_RESOLVED_IP   the public egress IP of this caller; if
 *                          set, the script asserts an exact match
 *                          against `live.resolvedIp`.
 *   PROBE_TIMEOUT_MS       default 10000 (per attempt).
 *   PROBE_MAX_ATTEMPTS     default 4. Bounded retry cap for transient
 *                          transport failures (5xx and network errors
 *                          only; assertion failures still fail on the
 *                          first observation). Set to 1 to disable
 *                          retries entirely.
 *   PROBE_RETRY_BASE_MS    default 500. Base delay for exponential
 *                          backoff with jitter between retries. The
 *                          worst-case wall time stays well under the
 *                          5-min `timeout-minutes` of the workflow.
 *
 * Retry policy
 * ------------
 *   A managed deploy edge / frontend will occasionally
 *   return a plain "Internal server error. Correlation ID: <uuid>"
 *   page when the container is briefly unavailable (cold start, brief
 *   restart, transient edge hiccup). Those are not real regressions
 *   but historically paged on-call. To avoid that, the probe retries
 *   bounded with exponential backoff + jitter on:
 *     - any HTTP 5xx response, AND
 *     - any `fetch` rejection (network/DNS/abort that wasn't the
 *       deliberate per-attempt timeout).
 *   A deliberate per-attempt timeout exhaustion is treated as
 *   terminal (not retried) — extend `PROBE_TIMEOUT_MS` instead if
 *   the live deploy is genuinely slow.
 *   It does NOT retry on any other status (4xx or 200) — every
 *   assertion failure (401, synthetic.ok=false, private resolvedIp,
 *   EXPECTED_RESOLVED_IP mismatch, malformed JSON) still fails on
 *   the first observation. The final failure message distinguishes
 *   "edge returned 5xx after N attempts (likely transient infra)"
 *   from "handler returned a JSON error" so the next on-call doesn't
 *   have to repeat this investigation.
 *
 * Exit codes
 * ----------
 *   0  all assertions passed
 *   1  any assertion failed (loud message printed to stderr)
 *   2  configuration error (missing required env var, bad URL, etc.)
 *
 * Wire it into your deploy pipeline as the last step after the new
 * version is healthy, so a misconfigured proxy fails the deploy
 * loudly instead of silently degrading the rate-limit ceiling.
 *
 * Today this script is invoked by:
 *   - `.github/workflows/post-deploy-trust-proxy.yml` — runs every
 *     30 minutes against the live deploy and on-demand via
 *     `workflow_dispatch` after a release. Reads its env from the
 *     `DEPLOY_BASE_URL`, `DEPLOY_PROBE_TOKEN` (preferred) or
 *     `DEPLOY_ADMIN_COOKIE` (legacy), and (optional)
 *     `DEPLOY_EXPECTED_RESOLVED_IP` repo secrets.
 *
 * When adding a new post-deploy caller, add it to the list above so future
 * maintainers can find every
 * place this contract is enforced.
 */

interface ProbeResponse {
  success: boolean;
  data?: {
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
  };
  error?: { message?: string; code?: string };
}

// Mirrors `isPrivateOrLoopback` in `server/lib/trust-proxy-check.ts`.
// Kept inline so the script has zero compile-time deps on the server
// bundle — it can run from a minimal CI image with just `tsx` (or
// even be transpiled and run as plain node) without pulling Express.
//
// We DO depend on `ipaddr.js` (already a runtime dep of the server,
// so `npm ci` in the CI workflow installs it for free; ~30KB, no
// transitive deps). That gives us the same CIDR-aware classifier as
// the server-side helper without re-implementing range arithmetic
// here. See the rationale in `server/lib/trust-proxy-check.ts` —
// the previous string-prefix list (`['fc', 'fd', ...]`) would have
// falsely matched non-IP strings like "fcat" / "fdoozle" emitted by
// a misbehaving upstream and either paged the on-call about a
// non-existent regression OR (worse) classified a real client IP as
// private and obscured a real misconfiguration.
import ipaddr from 'ipaddr.js';

// IPv4 ranges that, if `live.resolvedIp` ever resolves to one in
// production, mean the proxy is eating the X-Forwarded-For: loopback
// (127/8), RFC1918 private (10/8, 172.16/12, 192.168/16), link-local
// (169.254/16), and `unspecified` (0.0.0.0). Kept identical to the
// server's `IPV4_BAD_RANGES` so the boot guard and the post-deploy
// probe agree on what counts as a "real" client address.
const IPV4_BAD_RANGES = new Set<string>([
  'loopback',
  'private',
  'linkLocal',
  'unspecified',
]);

// IPv6 equivalents: loopback (::1), unique-local (fc00::/7), link-local
// (fe80::/10), and unspecified (::). `ipv4Mapped` is intentionally NOT
// in this set — we unwrap those addresses below and re-check the
// embedded IPv4 instead, so a `::ffff:127.0.0.1` is correctly rejected
// as IPv4 loopback rather than allowed through as a "non-private" IPv6
// address.
const IPV6_BAD_RANGES = new Set<string>([
  'loopback',
  'uniqueLocal',
  'linkLocal',
  'unspecified',
]);

// Exported for the regression test at
// `tests/unit/verify-trust-proxy-deploy.test.ts`, which pins this
// inline copy against `server/lib/trust-proxy-check.ts`'s CIDR-aware
// classifier on a fixed table of IPs. If the server tightens (see
// task #380) and the inline copy here drifts, that test fails
// loudly instead of letting the post-deploy probe silently disagree
// with the boot guard about what counts as a real client address.
//
// Fail-closed contract: empty / `unknown` / unparseable inputs all
// return `true`. Better to surface a misconfigured proxy loudly than
// to silently classify garbage as a real client IP.
export function isPrivateOrLoopback(ip: string): boolean {
  if (!ip) return true;
  const lower = ip.toLowerCase();
  // Some proxy-addr code paths emit the literal "unknown" instead of
  // a parseable address; treat it as private (fail-closed). Mirrors
  // the server-side helper exactly.
  if (lower === 'unknown') return true;
  if (!ipaddr.isValid(ip)) return true;
  let addr = ipaddr.parse(ip);
  // Unwrap IPv4-mapped IPv6 (::ffff:1.2.3.4) so a tunneled loopback
  // or RFC1918 address still gets caught by the IPv4 ruleset rather
  // than being waved through as "just an IPv6 address".
  if (addr.kind() === 'ipv6') {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      addr = v6.toIPv4Address();
    }
  }
  const range = addr.range();
  if (addr.kind() === 'ipv4') {
    return IPV4_BAD_RANGES.has(range);
  }
  return IPV6_BAD_RANGES.has(range);
}

function fail(msg: string, exitCode = 1): never {
  console.error(`[verify-trust-proxy-deploy] FAIL — ${msg}`);
  process.exit(exitCode);
}

function info(msg: string): void {
  console.log(`[verify-trust-proxy-deploy] ${msg}`);
}

export async function runVerifier(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const baseUrl = env.BASE_URL?.trim();
  const probeToken = env.PROBE_TOKEN?.trim();
  const adminCookie = env.ADMIN_COOKIE?.trim();
  const expectedResolvedIp = env.EXPECTED_RESOLVED_IP?.trim() || null;
  const timeoutMs = (() => {
    const raw = env.PROBE_TIMEOUT_MS?.trim();
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 10_000;
  })();
  // Bounded retry cap for transient transport failures only. Default
  // of 4 keeps the worst-case wall time (10s timeout × 4 attempts +
  // ~7s of backoff) comfortably under the workflow's 5-min ceiling.
  const maxAttempts = (() => {
    const raw = env.PROBE_MAX_ATTEMPTS?.trim();
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 4;
  })();
  // Base delay for exponential backoff: attempt k waits
  // base * 2^(k-1) ± jitter. With base=500ms and 4 attempts that's
  // ~500 + ~1000 + ~2000 = 3.5s of sleep total in the worst case.
  const retryBaseMs = (() => {
    const raw = env.PROBE_RETRY_BASE_MS?.trim();
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : 500;
  })();

  if (!baseUrl) fail('BASE_URL is required (e.g. https://app.example.com)', 2);
  if (!probeToken && !adminCookie) {
    fail(
      'either PROBE_TOKEN (preferred, no rotation) or ADMIN_COOKIE (legacy, ~24h) is required',
      2,
    );
  }
  // The server requires >=32 chars for the probe token. Catch a short
  // value here so the operator gets a clear configuration error
  // instead of an "Invalid probe token" 401 from the server.
  if (probeToken && probeToken.length < 32) {
    fail('PROBE_TOKEN must be at least 32 characters (matches server-side minimum)', 2);
  }

  let url: URL;
  try {
    url = new URL('/api/system-admin/trust-proxy-status', baseUrl);
  } catch {
    fail(`BASE_URL is not a valid URL: ${baseUrl}`, 2);
  }

  // Auth header selection — token wins when both are present so an
  // operator who set up the token can leave a stale cookie around
  // without it being silently used. Logged so a failing run makes
  // the auth mode obvious in CI output.
  //
  // The earlier branch already exits via `fail()` (which is `never`) if
  // neither credential is set, so by here at least one is present;
  // pick the one we actually have without leaning on `!`.
  const authHeaders: Record<string, string> = {};
  let authMode: 'token' | 'cookie';
  if (probeToken) {
    authHeaders['X-Probe-Token'] = probeToken;
    authMode = 'token';
  } else if (adminCookie) {
    authHeaders.Cookie = adminCookie;
    authMode = 'cookie';
  } else {
    // Defensive — the earlier check should have already fail()ed.
    fail('no credentials available (unreachable)', 2);
  }

  info(`Probing ${url.toString()} (auth=${authMode}, maxAttempts=${maxAttempts})`);

  // Single-attempt fetch with its own AbortController/timeout. We
  // recreate both per attempt so a timeout abort on attempt N doesn't
  // leak into attempt N+1.
  type AttemptOk = { kind: 'ok'; res: Response; bodyText: string };
  type AttemptRetryable =
    | { kind: 'network'; message: string }
    | { kind: 'http5xx'; status: number; bodyText: string; isEdgePage: boolean };
  type AttemptTerminal = { kind: 'terminal'; res: Response; bodyText: string };
  type AttemptResult = AttemptOk | AttemptRetryable | AttemptTerminal;

  // The managed deploy edge / frontend returns a plain-text
  // or HTML "Internal server error. Correlation ID: <uuid>" page when
  // it can't get a clean response from the container. Our app's
  // `sendError` always returns JSON (`{success:false, error:{...}}`).
  // Sniff the response so the final failure message can tell on-call
  // whether they're chasing an infra blip or a real handler bug.
  const looksLikeEdgeErrorPage = (contentType: string | null, bodyText: string): boolean => {
    const ct = (contentType ?? '').toLowerCase();
    if (ct.includes('application/json')) return false;
    // The hallmark phrasing the deploy edge uses; case-insensitive
    // because exact casing has changed across Cloud Run revisions.
    if (/internal server error/i.test(bodyText)) return true;
    if (/correlation id/i.test(bodyText)) return true;
    // Anything non-JSON in a 5xx is more likely edge than handler —
    // the handler always serializes JSON, even on its 500 path.
    return !ct.includes('application/json');
  };

  const attemptOnce = async (): Promise<AttemptResult> => {
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, timeoutMs);
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...authHeaders,
        },
        signal: ac.signal,
        redirect: 'manual',
      });
    } catch (err) {
      // The task spec calls out that a deliberate per-attempt
      // timeout exhaustion should NOT be retried — only
      // network/DNS/connection-level errors should. Detect the
      // timeout-driven abort via the local flag and surface it as
      // terminal so the loop stops immediately.
      if (timedOut) {
        fail(
          `request timed out after ${timeoutMs}ms (per-attempt timeout, not retried; ` +
            `set PROBE_TIMEOUT_MS to extend if the live deploy is genuinely slow)`,
        );
      }
      return {
        kind: 'network',
        message: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 500 && res.status <= 599) {
      const bodyText = await res.text().catch(() => '<unreadable body>');
      const isEdgePage = looksLikeEdgeErrorPage(res.headers.get('content-type'), bodyText);
      return { kind: 'http5xx', status: res.status, bodyText, isEdgePage };
    }
    if (res.status !== 200) {
      const bodyText = await res.text().catch(() => '<unreadable body>');
      return { kind: 'terminal', res, bodyText };
    }
    const bodyText = await res.text().catch(() => '');
    return { kind: 'ok', res, bodyText };
  };

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  let lastRetryable: AttemptRetryable | null = null;
  let okAttempt: AttemptOk | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await attemptOnce();
    if (result.kind === 'ok') {
      okAttempt = result;
      break;
    }
    if (result.kind === 'terminal') {
      // 4xx or other non-200 non-5xx — fail-fast, no retry. This
      // catches 401 INVALID_PROBE_TOKEN, expired admin cookies, 403,
      // 404 (route missing), etc.
      fail(
        `HTTP ${result.res.status} from probe endpoint. ` +
          `Body: ${result.bodyText.slice(0, 500)}`,
      );
    }
    lastRetryable = result;
    const detail =
      result.kind === 'network'
        ? `network error: ${result.message}`
        : `HTTP ${result.status} (${result.isEdgePage ? 'edge page' : 'JSON'})`;
    if (attempt < maxAttempts) {
      // Exponential backoff with up to ±25% jitter so concurrent
      // probes (shouldn't happen — workflow has concurrency:1 — but
      // belt+braces) don't synchronize their retries.
      const base = retryBaseMs * 2 ** (attempt - 1);
      const jitter = base * 0.25 * (Math.random() * 2 - 1);
      const delay = Math.max(0, Math.round(base + jitter));
      info(
        `attempt ${attempt}/${maxAttempts} failed (${detail}); ` +
          `retrying in ${delay}ms`,
      );
      await sleep(delay);
    } else {
      info(`attempt ${attempt}/${maxAttempts} failed (${detail}); no retries left`);
    }
  }

  if (!okAttempt) {
    // All attempts exhausted on transient transport failures. Label
    // the final message so on-call can immediately tell edge blip
    // from a real handler regression.
    if (lastRetryable && lastRetryable.kind === 'http5xx') {
      const where = lastRetryable.isEdgePage
        ? 'edge returned'
        : 'handler returned';
      const hint = lastRetryable.isEdgePage
        ? ' (likely transient infra — non-JSON edge error page)'
        : '';
      fail(
        `${where} HTTP ${lastRetryable.status} after ${maxAttempts} attempts${hint}. ` +
          `Body: ${lastRetryable.bodyText.slice(0, 500)}`,
      );
    }
    if (lastRetryable && lastRetryable.kind === 'network') {
      fail(
        `request failed after ${maxAttempts} attempts (network/transport): ${lastRetryable.message}`,
      );
    }
    // Defensive — loop must have produced one of the above.
    fail(`request failed after ${maxAttempts} attempts (no result captured)`);
  }

  const okBody = okAttempt.bodyText;
  const parseJsonOrFail = (): ProbeResponse => {
    try {
      return JSON.parse(okBody) as ProbeResponse;
    } catch (err) {
      fail(`response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const body = parseJsonOrFail();

  if (!body.success || !body.data) {
    fail(`response not successful: ${JSON.stringify(body).slice(0, 500)}`);
  }
  const data = body.data;

  // Assertion 1: the synthetic probe (same one the boot guard uses)
  // still reports green. If this regresses, the deployed Express
  // config has drifted in a way the boot guard would have caught — a
  // strong signal something replaced the running process without
  // rebooting through our entrypoint.
  if (!data.synthetic.ok) {
    fail(
      `synthetic probe failed: resolvedIp=${data.synthetic.resolvedIp} ` +
        `reason=${data.synthetic.reason ?? '<none>'} ` +
        `trustProxySetting=${JSON.stringify(data.config.trustProxySetting)}`,
    );
  }

  // Assertion 2: the live request resolved to a routable address. This
  // is the post-deploy reality check the boot guard cannot make on
  // its own (it only synthesizes a request).
  const liveIp = data.live.resolvedIp ?? '';
  if (isPrivateOrLoopback(liveIp)) {
    fail(
      `live req.ip resolved to a loopback/private address (${liveIp}). ` +
        `The proxy is not honoring X-Forwarded-For for real external requests; ` +
        `per-IP rate limiters will key on the proxy's address and brute-force ` +
        `protection collapses into a global cap. ` +
        `socketRemoteAddress=${data.live.socketRemoteAddress ?? '<null>'} ` +
        `xForwardedFor=${data.live.xForwardedFor ?? '<null>'} ` +
        `trustProxySetting=${JSON.stringify(data.config.trustProxySetting)}`,
    );
  }

  // Assertion 3 (optional): exact-match against a known caller IP.
  if (expectedResolvedIp && liveIp !== expectedResolvedIp) {
    fail(
      `live req.ip (${liveIp}) does not match EXPECTED_RESOLVED_IP (${expectedResolvedIp}). ` +
        `Either the proxy is rewriting XFF, the trust-proxy hop count is off, ` +
        `or the egress IP changed. xForwardedFor=${data.live.xForwardedFor ?? '<null>'}`,
    );
  }

  info(
    `OK — live.resolvedIp=${liveIp} synthetic.ok=true ` +
      `trustProxySetting=${JSON.stringify(data.config.trustProxySetting)}`,
  );
}

// Only run when invoked directly (so the test can import `runVerifier`
// without triggering the side effect).
const isMain = (() => {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    // import.meta.url is the file URL of this module under tsx/ESM.
    const here = new URL(import.meta.url).pathname;
    return argv1 === here || argv1.endsWith('/verify-trust-proxy-deploy.ts');
  } catch {
    return false;
  }
})();

if (isMain) {
  runVerifier().catch((err) => {
    console.error(`[verify-trust-proxy-deploy] unexpected error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exit(1);
  });
}
