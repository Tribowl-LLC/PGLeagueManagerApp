import type { Application, Express } from "express";
import proxyAddr from "proxy-addr";
import ipaddr from "ipaddr.js";

// Why this exists (task #326):
//
// `app.set('trust proxy', N)` does double duty: it gates how many proxy
// hops Express will believe in `req.ip`/`req.protocol`, and per-IP rate
// limiters (most importantly `setupAdminLimiter` at 5 req / 15 min)
// key off `req.ip`. If a future deploy moves us behind a different
// proxy topology and trust-proxy is misconfigured, every real request
// will resolve to the proxy's loopback/private address and the brute
// force ceiling silently collapses into a 5 req / 15 min cap for the
// *entire internet*. The header-shape defenses still hold (#289), but
// the rate ceiling is what we lose.
//
// This module synthesizes a request with a realistic X-Forwarded-For
// chain and asks Express's *exact* proxy-addr resolver what `req.ip`
// would resolve to. If the answer is the loopback or otherwise
// non-routable, trust-proxy is misconfigured for the deployed topology.

// IPv4 ranges that, if `req.ip` ever resolves to one in production,
// mean the proxy is eating the X-Forwarded-For: loopback (127/8),
// RFC1918 private (10/8, 172.16/12, 192.168/16), and link-local
// (169.254/16). `unspecified` (0.0.0.0) is also worth blocking — it
// is never a real client.
const IPV4_BAD_RANGES = new Set<string>([
  "loopback",
  "private",
  "linkLocal",
  "unspecified",
]);

// IPv6 equivalents: loopback (::1), unique-local (fc00::/7, the IPv6
// "private" equivalent), link-local (fe80::/10), and unspecified (::).
// `ipv4Mapped` is intentionally NOT in this set — we unwrap those
// addresses below and re-check the embedded IPv4 instead, so a
// `::ffff:127.0.0.1` is correctly rejected as IPv4 loopback rather
// than allowed through as a "non-private" IPv6 address.
const IPV6_BAD_RANGES = new Set<string>([
  "loopback",
  "uniqueLocal",
  "linkLocal",
  "unspecified",
]);

// Exported for direct unit testing — see tests/api/trust-proxy-check.test.ts.
//
// CIDR-precise replacement for the string-prefix list this used to
// carry (task #380). With prefix matching, a non-IP string like
// "fcat" or "fdoozle" — produced by a misbehaving upstream or a
// future change to proxy-addr's normalization — would have falsely
// matched the IPv6 unique-local check (`startsWith("fc")` /
// `startsWith("fd")`) and silently flipped a real client through to
// the "ok" branch as a private address. Worse, an unparseable
// string would have flowed through the .startsWith chain and could
// have ended up in either branch depending on its first chars. The
// CIDR-aware path uses ipaddr.js to parse the address and dispatch
// on the canonical range — and treats anything unparseable as
// private (fail-closed: better to surface a misconfigured proxy
// loudly than to silently classify garbage as a real client IP).
export function isPrivateOrLoopback(ip: string): boolean {
  if (!ip) return true;
  const lower = ip.toLowerCase();
  // Some proxy-addr code paths emit the literal "unknown" instead
  // of a parseable address; treat it as private (fail-closed).
  if (lower === "unknown") return true;
  if (!ipaddr.isValid(ip)) return true;
  let addr = ipaddr.parse(ip);
  // Unwrap IPv4-mapped IPv6 (::ffff:1.2.3.4) so a tunneled loopback
  // or RFC1918 address still gets caught by the IPv4 ruleset rather
  // than being waved through as "just an IPv6 address".
  if (addr.kind() === "ipv6") {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      addr = v6.toIPv4Address();
    }
  }
  const range = addr.range();
  if (addr.kind() === "ipv4") {
    return IPV4_BAD_RANGES.has(range);
  }
  return IPV6_BAD_RANGES.has(range);
}

export interface TrustProxyCheckResult {
  ok: boolean;
  resolvedIp: string;
  trustSetting: unknown;
  reason?: string;
}

// Synthesize a minimal request shape that proxy-addr accepts. The
// real Express `req` object carries far more than this; proxy-addr
// only reads `connection.remoteAddress` and the headers, and
// Express's compiled trust function takes `(addr, hopIndex)`.
function makeFakeReq(forwardedFor: string, socketAddr = "127.0.0.1") {
  return {
    connection: { remoteAddress: socketAddr },
    socket: { remoteAddress: socketAddr },
    headers: { "x-forwarded-for": forwardedFor },
  } as unknown as Parameters<typeof proxyAddr>[0];
}

// Pull the compiled trust function Express stores under the magic
// `trust proxy fn` key (set when you call `app.set('trust proxy', …)`).
// Falling back to a "trust nothing" function is the safest default
// for a probe — if Express never compiled one, the limiter would key
// on the socket address anyway.
// Accept the broader `Application` type — `Express` extends it, but
// `req.app` is typed as the bare `Application`, and we only ever read
// `app.get(...)` here, which is shared by both. Avoids a `as unknown
// as Express` cast at the call site (`server/routes/system-admin.ts`).
type TrustProxyApp = Pick<Application, "get">;

function getTrustFn(app: TrustProxyApp): Parameters<typeof proxyAddr>[1] {
  const fn = app.get("trust proxy fn") as
    | Parameters<typeof proxyAddr>[1]
    | undefined;
  return fn ?? (() => false);
}

export function verifyTrustProxy(app: TrustProxyApp): TrustProxyCheckResult {
  const trust = getTrustFn(app);
  // Synthesize the simplest realistic shape: a single reverse-proxy hop
  // puts the client's IP in XFF, and the socket address is loopback because
  // the proxy is local from our point of view. Even a 1-hop trust setting
  // must turn this into the
  // client IP — anything less means per-IP limiters key on the
  // proxy's loopback address. Real deployments with deeper chains
  // would still work (they trust >=1 hop), so this is the lower
  // bound the boot guard insists on.
  const fakeReq = makeFakeReq("203.0.113.7");
  const resolvedIp = proxyAddr(fakeReq, trust);
  const trustSetting = app.get("trust proxy");

  if (resolvedIp === "203.0.113.7") {
    return { ok: true, resolvedIp, trustSetting };
  }
  if (isPrivateOrLoopback(resolvedIp)) {
    return {
      ok: false,
      resolvedIp,
      trustSetting,
      reason:
        "trust-proxy is not honoring X-Forwarded-For; req.ip resolved to a loopback/private address. " +
        "Per-IP rate limiters will key on the proxy's address and brute-force protection collapses.",
    };
  }
  // Resolved to a non-loopback but ALSO not the synthetic client —
  // shouldn't happen with the 1-hop synthetic, but surface it loudly
  // rather than silently returning ok.
  return {
    ok: false,
    resolvedIp,
    trustSetting,
    reason: `trust-proxy resolved req.ip to ${resolvedIp} instead of the synthetic client 203.0.113.7.`,
  };
}

// Boot-time guard. In production we hard-fail (the security cost of
// running with a broken rate-limit ceiling outweighs the boot risk).
// In dev we log a high-severity warning so the dev loop isn't broken.
//
// Entrypoint registry (task #378):
//   - server/index.ts ........ main HTTP server
//
// Every entrypoint that constructs an `express()` instance MUST
// call this assertion after `app.set('trust proxy', N)` and before
// the app starts handling requests. The CI guard at
// `scripts/check-trust-proxy-coverage.ts` (exercised by
// `tests/unit/check-trust-proxy-coverage.test.ts` on every CI run)
// walks `server/**/*.ts` and fails if it finds a new `express()`
// instance in a file that doesn't also call this function — when
// adding a new entrypoint, register it in the list above and call
// the assertion in that file.
//
// The same lint also enforces ordering (task #497): the first
// `assertTrustProxyAtBoot(` call site in the file must appear at a
// source position EARLIER than the first `<id>.listen(` in the same
// file. Place the call right after `app.set('trust proxy', N)` and
// well above the `app.listen` / `server.listen` invocation; a
// `startServer()` factory that contains both calls in textual order
// (assertion above `listen`) is also accepted.
export function assertTrustProxyAtBoot(
  app: Express,
  opts: {
    isProduction: boolean;
    log: { error: (msg: string, meta?: unknown) => void; warn: (msg: string, meta?: unknown) => void };
  },
): TrustProxyCheckResult {
  const result = verifyTrustProxy(app);
  if (result.ok) return result;
  const meta = {
    resolvedIp: result.resolvedIp,
    trustSetting: result.trustSetting,
    reason: result.reason,
  };
  if (opts.isProduction) {
    opts.log.error("Trust-proxy misconfiguration detected at boot", meta);
    throw new Error(
      `Trust-proxy misconfigured: ${result.reason ?? "req.ip did not resolve to the synthetic client address"}`,
    );
  }
  opts.log.warn("Trust-proxy misconfiguration detected at boot (dev — not fatal)", meta);
  return result;
}
