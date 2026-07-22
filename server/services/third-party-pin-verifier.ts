/**
 * Third-party SDK / wire-shape pin verifier framework (task #651).
 *
 * Generalizes the runtime drift guard pattern that
 * `verifySquareSdkVersion` (task #627) introduced for the Square SDK
 * to every other third-party client we depend on (Clover,
 * SendGrid, …). The risk is the same in every case: a silent SDK
 * upgrade — a hotfix `npm i provider@latest`, a `package-lock.json`
 * regen, an unintentional major-version float — could change the
 * wire shape we audited against without any test catching it,
 * because the merge-gating tests run on the lockfile that's about
 * to merge, not the lockfile that's actually running.
 *
 * Each provider registers a {@link PinVerifier} describing:
 *   - what wire literal we pinned (header value, base URL, signature
 *     algorithm, etc.)
 *   - a probe that captures the *current* literal off the SDK / our
 *     constants without making a real network call
 *   - what to do when the probe disagrees with the pin (`onResult`)
 *
 * `verifyAllThirdPartyPins()` runs every registered verifier once at
 * boot, surfaces all mismatches with the same `[PAGE]`-prefixed
 * paging severity used by Square, and is memoized per process so
 * subsequent calls are free. Per-provider lazy callers (see
 * `verifySquareSdkVersion`) can also call `verifyThirdPartyPin` to
 * await the same memoized result.
 */

import { createLogger } from '../logger';

const log = createLogger('ThirdPartyPin');

/**
 * Probe outcome:
 *   - `ok: true` with a captured `actual` value → pin matches.
 *   - `ok: true` with `reason: 'no-captured-request'` → probe could
 *     not capture (e.g. SDK is mocked in a unit test). NOT treated
 *     as drift; the merge-gating CI test for that provider remains
 *     the canonical guard.
 *   - `ok: false` with `reason: 'drift'` → pin mismatch, paging
 *     event. `actual` may be the captured-but-wrong value or
 *     `undefined` if the probe ran but no value showed up where it
 *     should have.
 */
export type PinProbeResult =
  | { ok: true; actual: string; reason?: undefined }
  | { ok: true; actual: undefined; reason: 'no-captured-request' }
  | { ok: false; actual: string | undefined; reason: 'drift' };

export type PinProbeFn = () => Promise<PinProbeResult>;

export interface PinVerificationOutcome {
  provider: string;
  pinName: string;
  expected: string;
  actual: string | undefined;
  ok: boolean;
}

export interface PinVerifier {
  /** Stable provider key, e.g. `'square'`, `'clover'`. Used to
   *  dedupe registrations and to address the verifier from tests. */
  provider: string;
  /** Human-friendly name of the wire literal being pinned, e.g.
   *  `'Square-Version header'`, `'Version header'`,
   *  `'webhook signature scheme'`, `'API base URL'`. Surfaced in
   *  log lines and the alert payload so on-call can grep. */
  pinName: string;
  /** The wire literal we expect to see, captured at audit time. */
  expected: string;
  /** Capture the current wire literal without making a real network
   *  call. See per-provider implementations for the exact technique
   *  (fake fetcher, constant read, header-builder probe, …). */
  probe: PinProbeFn;
  /** Pointer to the audit doc + recovery runbook. Surfaced in the
   *  paging payload so the responder is one click from the
   *  documented recovery path. */
  runbook: string;
  /** Per-provider side effect on probe result. Receives the
   *  outcome; emits structured logs; may flip a fail-shut switch
   *  (e.g. Square refuses to hand back a client on drift). The
   *  helper does not log on its own — providers own their log
   *  format so on-call greps stay stable. */
  onResult: (outcome: PinVerificationOutcome) => void;
}

interface RegisteredVerifier extends PinVerifier {
  defaultProbe: PinProbeFn;
  currentProbe: PinProbeFn;
}

const registry = new Map<string, RegisteredVerifier>();
const memo = new Map<string, Promise<PinVerificationOutcome>>();

/**
 * Register a pin verifier. Subsequent registrations under the same
 * `provider` key replace the previous one (so test setup that
 * re-imports a module doesn't accumulate duplicates).
 */
export function registerThirdPartyPin(v: PinVerifier): void {
  registry.set(v.provider, {
    ...v,
    defaultProbe: v.probe,
    currentProbe: v.probe,
  });
  // Drop any memoized result so the next verify call re-runs against
  // the freshly-registered probe. Without this, a re-registration
  // (e.g. a hot-reload in dev) would keep returning the stale
  // outcome from the previous probe forever.
  memo.delete(v.provider);
}

/**
 * Resolve (or memoize) the outcome of one provider's verifier.
 * Concurrent and repeat callers all see the same result — the
 * probe runs at most once per process lifetime per provider.
 */
export async function verifyThirdPartyPin(
  provider: string,
): Promise<PinVerificationOutcome> {
  const existing = memo.get(provider);
  if (existing) return existing;
  const v = registry.get(provider);
  if (!v) {
    throw new Error(
      `No third-party pin verifier registered for provider '${provider}'. ` +
        `Known providers: ${Array.from(registry.keys()).join(', ') || '(none)'}.`,
    );
  }
  const promise = (async () => {
    let result: PinProbeResult;
    try {
      result = await v.currentProbe();
    } catch (err) {
      // A throwing probe is treated as non-conclusive (same as
      // 'no-captured-request') rather than drift, mirroring the
      // Square probe's "do not fail-shut on probe bugs" stance.
      // The throw itself is logged so it's not invisible.
      log.warn(
        `${v.provider} ${v.pinName} probe threw — treating as non-conclusive`,
        { error: err instanceof Error ? err.message : String(err) },
      );
      result = { ok: true, actual: undefined, reason: 'no-captured-request' };
    }
    const outcome: PinVerificationOutcome = {
      provider: v.provider,
      pinName: v.pinName,
      expected: v.expected,
      actual: result.actual,
      ok: result.ok,
    };
    try {
      v.onResult(outcome);
    } catch (err) {
      log.error(
        `${v.provider} ${v.pinName} onResult handler threw`,
        { error: err instanceof Error ? err.message : String(err) },
      );
    }
    return outcome;
  })();
  memo.set(provider, promise);
  return promise;
}

/**
 * Run every registered verifier in parallel and return all outcomes.
 * Boot-time entry point; safe to call multiple times — each
 * underlying provider is memoized.
 */
export async function verifyAllThirdPartyPins(): Promise<PinVerificationOutcome[]> {
  const providers = Array.from(registry.keys());
  return Promise.all(providers.map((p) => verifyThirdPartyPin(p)));
}

/**
 * Default `onResult` that emits a uniform structured log line:
 *   - `info` on match
 *   - `info` on non-conclusive ("probe could not capture")
 *   - `error` with `[PAGE]` prefix on drift
 *
 * Square overrides this with its own legacy-formatted lines (so
 * existing on-call grep patterns + tests stay stable). New
 * providers should use this helper unless they have a strong
 * reason to format differently.
 */
export function makeDefaultPinOnResult(opts: {
  /** Logger name used for the structured lines. Usually the
   *  provider's normal logger so log filters group consistently. */
  loggerName: string;
  /** Pointer to the recovery runbook. Surfaced in the paging
   *  payload. */
  runbook: string;
  /** One-line description of how to recover when this verifier
   *  paged. Surfaced in the paging payload so the responder
   *  doesn't have to re-derive it from the runbook. */
  remediation: string;
}): PinVerifier['onResult'] {
  const providerLog = createLogger(opts.loggerName);
  return (outcome) => {
    if (outcome.ok && outcome.actual === undefined) {
      // Non-conclusive — a mocked SDK in tests, or a probe that
      // legitimately couldn't capture. Logged at info so it doesn't
      // drown out real prod drift.
      providerLog.info(
        `${outcome.provider} ${outcome.pinName} probe could not capture — runtime pin check skipped (merge-gating CI test remains the canonical guard).`,
      );
      return;
    }
    if (outcome.ok) {
      providerLog.info(`${outcome.provider} ${outcome.pinName} verified at runtime`, {
        actual: outcome.actual,
        expected: outcome.expected,
      });
      return;
    }
    // `[PAGE]` prefix matches the convention on-call uses to triage
    // `error` lines at-a-glance (same as Square's task #627 line).
    providerLog.error(
      `[PAGE] ${outcome.provider} ${outcome.pinName} drift detected at runtime`,
      {
        provider: outcome.provider,
        pinName: outcome.pinName,
        expected: outcome.expected,
        actual: outcome.actual ?? null,
        runbook: opts.runbook,
        remediation: opts.remediation,
      },
    );
  };
}

// ---------------------------------------------------------------------------
// Test seams. Production code never calls these.
// ---------------------------------------------------------------------------

/** Replace one provider's probe with a synthetic one. Pass `null`
 *  to restore the registered default. Drops the memoized outcome. */
export function _setThirdPartyPinProbeForTests(
  provider: string,
  probe: PinProbeFn | null,
): void {
  const v = registry.get(provider);
  if (!v) {
    throw new Error(
      `No third-party pin verifier registered for provider '${provider}'.`,
    );
  }
  v.currentProbe = probe ?? v.defaultProbe;
  memo.delete(provider);
}

/** Drop memoized outcomes (everything, or one provider) and reset
 *  every probe to its registered default. */
export function _resetThirdPartyPinsForTests(provider?: string): void {
  if (provider) {
    memo.delete(provider);
    const v = registry.get(provider);
    if (v) v.currentProbe = v.defaultProbe;
    return;
  }
  memo.clear();
  for (const v of registry.values()) v.currentProbe = v.defaultProbe;
}

/** Read-only registry inspection for tests. */
export function _getRegisteredPinProvidersForTests(): string[] {
  return Array.from(registry.keys());
}
