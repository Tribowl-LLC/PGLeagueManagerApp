import type {
  SquareClient,
  SquareEnvironment as SquareEnvironmentT,
  SquareError as SquareErrorT,
  BaseClientOptions,
} from 'square';
import { createRequire } from 'node:module';
import crypto from 'crypto';
import { createLogger } from '../logger';

const log = createLogger("SquareService");

// Lazy-load the `square` SDK (task #692). The package is multi-MB
// and pulls a large dependency tree; deferring it until the first
// real Square code path executes keeps cold-start (and unit-test
// import-time) lean.
//
// Two access paths share one cache:
//   - `getSquareSdkAsync()` uses dynamic `await import('square')` so
//     vitest's `vi.mock('square', ...)` ESM module-mock is honored.
//     This is the path async production code (and the SDK probe)
//     takes on first use.
//   - `getSquareSdk()` (sync) returns the cached module if a prior
//     async call already loaded it; otherwise it falls back to
//     `createRequire('square')` for synchronous `instanceof`
//     discrimination in catch blocks. In production the cache is
//     always primed by `buildSquareClient` before any catch runs.
const _squareRequire = createRequire(import.meta.url);
let _squareSdk: typeof import('square') | null = null;
async function getSquareSdkAsync(): Promise<typeof import('square')> {
  if (_squareSdk === null) {
    _squareSdk = await import('square');
  }
  return _squareSdk;
}
function getSquareSdk(): typeof import('square') {
  if (_squareSdk === null) {
    _squareSdk = _squareRequire('square') as typeof import('square');
  }
  return _squareSdk;
}
// Local re-exposed value handles. Each is lazily resolved on first
// access so test files that never construct or catch a Square error
// don't pay the SDK import cost transitively.
export function getSquareErrorCtor(): typeof SquareErrorT {
  return getSquareSdk().SquareError;
}

/**
 * Shared composition context handed to each Square capability module
 * (payments, vault, attributes, catalog). The `SquarePaymentProvider`
 * class builds one of these in its constructor and delegates every
 * capability call to the matching module function. Splitting the file
 * this way keeps each capability focused while preserving the public
 * provider contract (move-only, no behavior change — task #765).
 */
export interface SquareProviderContext {
  readonly locationId: number;
  /**
   * Resolves the version-guarded, credential-loaded Square SDK client
   * for this provider's location, or `null` when Square isn't
   * configured / the runtime version guard refuses to hand one back.
   */
  getClient(): Promise<SquareClient | null>;
  /** Resolves the seller-side Square location id string ("" when unset). */
  getLocationId(): Promise<string>;
}

/**
 * Square's CreateCard / CreateCustomer endpoints cap `idempotency_key`
 * at 45 characters. Anything longer is rejected with
 * `INVALID_REQUEST_ERROR / VALUE_TOO_LONG` and the call fails — which
 * is what bit task #671 in production after the v40 SDK migration
 * (the pre-fix code sent the full 64-char SHA-256 hex digest, and a
 * post-fix `.slice(0, 40)` was easy to silently drop in a refactor).
 *
 * `buildSquareIdempotencyKey` centralises the format so:
 *   - The output is deterministic for the same inputs (so retries
 *     dedupe inside Square's idempotency window).
 *   - The output is unique enough to avoid cross-bowler / cross-card
 *     collisions (32 hex chars = 128 bits of entropy).
 *   - The output has a short, human-readable prefix so a stuck request
 *     in Square's dashboard is grep-able back to the call site.
 *   - The output length is asserted at runtime to be ≤45, so any
 *     future change to the prefix or hash slice that would push it
 *     over the limit fails loud during tests / dev rather than only
 *     in production. Pinned by `square.test.ts`.
 */
export const SQUARE_IDEMPOTENCY_MAX_LENGTH = 45;
export function buildSquareIdempotencyKey(prefix: string, ...parts: string[]): string {
  const hash = crypto
    .createHash('sha256')
    .update(parts.join(':'))
    .digest('hex')
    .slice(0, 32);
  const key = `${prefix}-${hash}`;
  if (key.length > SQUARE_IDEMPOTENCY_MAX_LENGTH) {
    throw new Error(
      `Square idempotency key exceeded ${SQUARE_IDEMPOTENCY_MAX_LENGTH} chars: ${key.length} (prefix='${prefix}')`,
    );
  }
  return key;
}

/**
 * The `Square-Version` header that `square@44.2.0`'s baked-in default
 * sends on every outbound request. Audited and pinned in
 * `docs/square-api-version-audit.md` §1, with the operator pre-flight
 * checklist for bumping it in §6.
 *
 * This constant exists so a CI test (Task #614) can assert that the
 * SDK's default header still matches what the audit reviewed. If a
 * future `square` upgrade ships a different default (e.g. `square@45`
 * with a new pinned version), the test will fail loudly and force the
 * operator to re-run the audit before merging the SDK bump — which
 * matters because changing the wire version changes response shapes
 * across every call site at once.
 *
 * Update path when this needs to change:
 *   1. Re-run the per-release diff in `docs/square-api-version-audit.md` §5
 *      for the new window.
 *   2. Update both this constant and the version table in §1 of the
 *      audit doc in the same commit.
 *   3. Walk the operator pre-flight checklist in §6 before the bump
 *      lands in production.
 */
export const SQUARE_EXPECTED_VERSION = '2026-05-20' as const;

/**
 * Build a `SquareClient` from raw credentials, picking
 * Production vs Sandbox using the existing token/appId heuristic.
 *
 * Exported so the version-header CI test (Task #614) can construct
 * a client through the *same* code path the production
 * `getSquareClient` does — otherwise the test would silently miss
 * drift in how the client is constructed (e.g. someone adding a
 * `version: '2025-01-23'` override here).
 *
 * `extraOptions` is intentionally narrow: the production-derived
 * `token` and `environment` are written *after* the spread, so they
 * always win over anything in `extraOptions` (a test cannot
 * accidentally change which token or environment we exercise).
 * Production callers always pass none.
 */
export async function buildSquareClient(
  accessToken: string,
  appId?: string,
  extraOptions?: Partial<BaseClientOptions>,
): Promise<SquareClient> {
  const cleanToken = accessToken.replace(/[^\x20-\x7E]/g, '').trim();
  const isProductionAppId = appId ? (appId.length > 0 && !appId.includes('sandbox-')) : true;
  const isProductionToken = cleanToken.startsWith('EAAAEv') || cleanToken.startsWith('EAAAl7');
  const sdk = await getSquareSdkAsync();
  const SquareEnvironment: typeof SquareEnvironmentT = sdk.SquareEnvironment;
  const environment = (isProductionAppId || isProductionToken) ? SquareEnvironment.Production : SquareEnvironment.Sandbox;
  // v40+ flat-client SDK shape (task #603 / Phase 2 of #600). Note the
  // option key is `token` now, not `accessToken`, and the environment
  // values are URLs from the SquareEnvironment record (Production /
  // Sandbox), not the legacy `Environment` enum.
  return new sdk.SquareClient({ ...extraOptions, token: cleanToken, environment });
}

/**
 * Runtime Square-Version header guard (task #627).
 *
 * Background: the CI test in `__tests__/square-version-header.test.ts`
 * (task #614) catches `Square-Version` drift on the lockfile that's
 * about to merge. But a deploy-time SDK upgrade — a hotfix `npm i
 * square@latest` rolled directly into the deploy artifact, a
 * `package-lock.json` regen during CI, or any other bump that ships
 * to production without re-running the merge-gating test on the
 * bumped lockfile — could still float a different wire version into
 * production unnoticed. Drift matters because changing
 * `Square-Version` changes response shapes across every Square call
 * site at once (see `docs/square-api-version-audit.md` §1).
 *
 * This runtime guard re-uses the same fake-fetcher capture trick the
 * CI test relies on: build a `SquareClient` whose `fetcher` records
 * the headers and short-circuits the network call, fire one
 * `payments.get` against it, and compare the captured
 * `Square-Version` value against `SQUARE_EXPECTED_VERSION`. The
 * probe is memoized per process: it runs once at server boot (from
 * `server/index.ts`) and is also kicked off lazily on the first
 * `getSquareClient()` call — whichever happens first.
 *
 * Failure modes:
 *   - **Drift detected.** Logs a `[PAGE] Square SDK Square-Version
 *     header drift` line at `error` priority with `expected`,
 *     `actual`, and a runbook pointer to
 *     `docs/square-api-version-audit.md` §6. Subsequent
 *     `getSquareClient()` calls return `null` so the provider refuses
 *     to initialize — admin-facing routes surface that as the same
 *     `PROVIDER_NOT_CONFIGURED` 422 they'd see if Square credentials
 *     were missing. That's a strong, unambiguous signal — better than
 *     letting a drifted SDK silently parse responses against an
 *     unaudited wire version.
 *   - **Probe could not capture (e.g. SDK mocked in tests).** Logs an
 *     `info` line and treats the check as non-conclusive — does NOT
 *     refuse to initialize. The CI test (#614) is still the canonical
 *     guard against drift; this runtime probe is defense-in-depth and
 *     must not break unit tests that mock the `square` module.
 */
import {
  registerThirdPartyPin,
  verifyThirdPartyPin,
  _setThirdPartyPinProbeForTests,
  _resetThirdPartyPinsForTests,
  type PinProbeResult,
  type PinProbeFn,
} from './third-party-pin-verifier';

async function defaultProbeSquareSdkVersion(): Promise<PinProbeResult> {
  const captured: Array<Record<string, unknown>> = [];
  // Mirrors the fake fetcher pattern in
  // `__tests__/square-version-header.test.ts`: capture the headers
  // the SDK assembles and short-circuit before any real network call.
  // Typed via `BaseClientOptions['fetcher']` (which the SDK declares
  // as `core.FetchFunction`). The returned `FailedResponse` shape is
  // assignable to `APIResponse<R, Fetcher.Error>` for any `R`, so no
  // cast is needed.
  const fetcher: BaseClientOptions['fetcher'] = async (args) => {
    captured.push(args.headers ?? {});
    const rawResponse = new Response(null, { status: 599, statusText: 'short-circuited' });
    return {
      ok: false,
      error: { reason: 'unknown', errorMessage: 'short-circuited by sdk-version probe' },
      rawResponse,
    };
  };

  let probe: SquareClient;
  try {
    // Production-shaped token prefix so `buildSquareClient`'s heuristic
    // routes to the Production environment URL — same path
    // production traffic exercises. No real call leaves the process
    // because `fetcher` short-circuits.
    probe = await buildSquareClient(
      'EAAAEvSDK_VERSION_PROBE_NOT_A_REAL_SECRET',
      undefined,
      { fetcher },
    );
  } catch {
    // SDK couldn't be constructed at all (e.g. constructor signature
    // changed). Don't fail-shut — the CI test will catch real drift.
    return { ok: true, actual: undefined, reason: 'no-captured-request' };
  }

  try {
    await probe.payments.get({ paymentId: 'sdk-version-probe' });
  } catch {
    // Expected: the fake fetcher returns `ok: false` so the SDK
    // throws downstream. Also catches the case where the SDK is
    // mocked in tests and `payments.get` is undefined — handled by
    // the `no-captured-request` branch below.
  }

  const headers = captured[0];
  if (!headers) {
    return { ok: true, actual: undefined, reason: 'no-captured-request' };
  }
  // Per the test (and Square's fetcher impl), header keys are
  // lowercased before dispatch. Wire literal is `Square-Version`;
  // case-insensitive match is what counts.
  const raw = headers['square-version'];
  const version = typeof raw === 'string' ? raw : undefined;
  if (version !== SQUARE_EXPECTED_VERSION) {
    return { ok: false, actual: version, reason: 'drift' };
  }
  return { ok: true, actual: version };
}

/**
 * Register Square against the generic third-party pin verifier
 * framework (task #651). Square keeps its own legacy log lines
 * (so the on-call grep convention `[PAGE] Square SDK Square-Version
 * header drift` from task #627 stays stable) instead of using
 * `makeDefaultPinOnResult`. New providers should prefer the default
 * formatter unless they have a similar back-compat constraint.
 */
const SQUARE_REMEDIATION =
  'Pin the `square` package back to a version whose Square-Version equals SQUARE_EXPECTED_VERSION, or re-run the audit in §1/§5 and update SQUARE_EXPECTED_VERSION + §1 in the same commit.';

registerThirdPartyPin({
  provider: 'square',
  pinName: 'Square-Version header',
  expected: SQUARE_EXPECTED_VERSION,
  probe: defaultProbeSquareSdkVersion,
  runbook: 'docs/square-api-version-audit.md §6',
  onResult: (outcome) => {
    if (outcome.ok && outcome.actual === undefined) {
      log.info(
        'Square SDK Square-Version probe could not capture an outgoing request — runtime version check skipped (CI test #614 remains the canonical guard).',
      );
    } else if (outcome.ok) {
      log.info('Square SDK Square-Version verified at runtime', {
        version: outcome.actual,
        expected: SQUARE_EXPECTED_VERSION,
      });
    } else {
      log.error(
        '[PAGE] Square SDK Square-Version header drift detected at runtime — refusing to initialize Square provider',
        {
          expected: SQUARE_EXPECTED_VERSION,
          actual: outcome.actual ?? null,
          runbook: 'docs/square-api-version-audit.md §6',
          remediation: SQUARE_REMEDIATION,
        },
      );
    }
  },
});

/**
 * Reset the memoized verification result and the probe implementation.
 * Test-only — never call from production code. Used by
 * `__tests__/square-version-runtime-guard.test.ts` so each test case
 * starts from a clean cache.
 */
export function _resetSquareSdkVersionVerificationForTests(): void {
  _resetThirdPartyPinsForTests('square');
}

/**
 * Replace the probe implementation. Test-only — used to inject a
 * synthetic captured Square-Version header without standing up a
 * real `SquareClient`. Pass `null` to restore the default probe.
 *
 * The legacy probe-result shape (`{ok, version, reason?}`) is
 * adapted into the generic `PinProbeResult` shape (`{ok, actual,
 * reason?}`) so existing test cases keep compiling.
 */
type LegacyProbeResult =
  | { ok: true; version: string; reason?: undefined }
  | { ok: true; version: undefined; reason: 'no-captured-request' }
  | { ok: false; version: string | undefined; reason: 'drift' };

export function _setSquareSdkVersionProbeForTests(
  probe: (() => Promise<LegacyProbeResult>) | null,
): void {
  if (!probe) {
    _setThirdPartyPinProbeForTests('square', null);
    return;
  }
  const adapted: PinProbeFn = async () => {
    const r = await probe();
    if (r.ok && r.reason === 'no-captured-request') {
      return { ok: true, actual: undefined, reason: 'no-captured-request' };
    }
    if (r.ok) {
      return { ok: true, actual: r.version };
    }
    return { ok: false, actual: r.version, reason: 'drift' };
  };
  _setThirdPartyPinProbeForTests('square', adapted);
}

/**
 * Run (or return the memoized result of) the runtime Square-Version
 * header check. Safe to call eagerly at server boot AND lazily from
 * `getSquareClient()` — the first caller wins, every subsequent
 * caller awaits the same promise.
 *
 * Returns `{ ok, version }` for back-compat with existing call
 * sites; the underlying outcome flows through the generic
 * `verifyThirdPartyPin('square')`.
 */
export async function verifySquareSdkVersion(): Promise<{
  ok: boolean;
  version: string | undefined;
}> {
  const outcome = await verifyThirdPartyPin('square');
  return { ok: outcome.ok, version: outcome.actual };
}
