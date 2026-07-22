/**
 * Live-credential safety check for non-prod environments (Task #652).
 *
 * The beta Repl runs the same codebase as prod against a separate DB
 * with sandbox payment credentials. If a beta operator accidentally
 * pastes a *production* Square access token into Replit Secrets, the
 * beta app would happily charge real cards while the BETA banner
 * tells testers it's safe to enter test card numbers. This module
 * scans `process.env` at boot and refuses to start the server when
 * APP_ENV=beta and any live-looking credential is present.
 *
 * Heuristics:
 *   - Square (named-var heuristic): any of the env-level `SQUARE_PROD*`
 *     / `SQUARE_PRODUCTION_*` vars are set. The un-prefixed sandbox
 *     family (`SQUARE_ACCESS_TOKEN` / `SQUARE_APP_ID` /
 *     `SQUARE_LOCATION_ID` / `VITE_SQUARE_*`) is the *intended* slot
 *     on beta — but that means an operator can also paste *live*
 *     credentials into those slots, so we additionally apply…
 *   - Square (value-shape heuristic): on the un-prefixed sandbox
 *     family, refuse to start when the value matches Square's
 *     production patterns. App IDs: production is `sq0idp-…`,
 *     sandbox is `sandbox-sq0idp-…`. Access tokens: production
 *     starts with `EAAAEv` or `EAAAl7` per the same heuristic
 *     `server/services/square-provider.ts` and
 *     `server/scripts/create-square-customers.ts` already use to
 *     gate version warnings. Without this, `APP_ENV=beta` could
 *     happily boot with a live Square token in `SQUARE_ACCESS_TOKEN`
 *     and charge real cards while the BETA banner promises sandbox.
 *   - Stripe-style live keys: any env var whose value starts with
 *     `sk_live_`, `pk_live_`, or `rk_live_`. We don't ship Stripe
 *     today, but the pattern is industry-standard so this catches
 *     future drift / a developer who pastes a Stripe key into the
 *     wrong slot.
 *
 * This check runs ONLY when `APP_ENV=beta`. `dev` and `prod` are
 * unaffected (dev intentionally uses whichever creds are set; prod
 * SHOULD have live creds).
 */

const SQUARE_LIVE_ENV_VARS = [
  'SQUARE_PROD_TOKEN',
  'SQUARE_PRODUCTION_ACCESS_TOKEN',
  'SQUARE_PRODUCTION_APP_ID',
  'SQUARE_PRODUCTION_LOCATION_ID',
] as const;

/**
 * Un-prefixed Square slots that the sandbox config is *supposed* to
 * occupy on beta. We additionally scan them by value to catch a live
 * cred pasted into the wrong slot (the architect-flagged bypass).
 */
const SQUARE_AMBIGUOUS_TOKEN_VARS = [
  'SQUARE_ACCESS_TOKEN',
] as const;

const SQUARE_AMBIGUOUS_APP_ID_VARS = [
  'SQUARE_APP_ID',
  'VITE_SQUARE_APP_ID',
] as const;

const LIVE_KEY_PREFIXES = ['sk_live_', 'pk_live_', 'rk_live_'] as const;

const SQUARE_PROD_TOKEN_PREFIXES = ['EAAAEv', 'EAAAl7'] as const;

export interface LiveCredentialFinding {
  envVar: string;
  reason: string;
}

/**
 * Mirror the exact normalization `server/services/square-provider.ts`
 * applies to access tokens before deciding sandbox-vs-production
 * (`replace(/[^\x20-\x7E]/g, '').trim()`). Without this, an operator
 * who pasted a Square production token with a leading newline /
 * non-breaking space / stray whitespace into Replit Secrets could
 * sneak past `startsWith('EAAAEv')` here while Square's runtime
 * still strips the wrapper and treats the value as production.
 * The same normalization is fine for app IDs.
 */
function normalizeSquareValue(value: string): string {
  return value.replace(/[^\x20-\x7E]/g, '').trim();
}

function isSquareProdAppId(value: string): boolean {
  return normalizeSquareValue(value).startsWith('sq0idp-');
}

function isSquareProdAccessToken(value: string): boolean {
  const normalized = normalizeSquareValue(value);
  return SQUARE_PROD_TOKEN_PREFIXES.some(p => normalized.startsWith(p));
}

/**
 * Pure function — easy to unit-test. Returns the list of findings
 * (empty when the environment is clean). Callers decide what to do
 * with them; the boot guard logs and exits.
 */
export function findLiveCredentials(
  env: NodeJS.ProcessEnv = process.env,
): LiveCredentialFinding[] {
  const findings: LiveCredentialFinding[] = [];

  for (const key of SQUARE_LIVE_ENV_VARS) {
    const value = env[key];
    if (typeof value === 'string' && value.length > 0) {
      findings.push({
        envVar: key,
        reason: 'Square production credential is set. Use the un-prefixed sandbox vars (SQUARE_ACCESS_TOKEN / SQUARE_APP_ID / SQUARE_LOCATION_ID) on beta instead.',
      });
    }
  }

  for (const key of SQUARE_AMBIGUOUS_APP_ID_VARS) {
    const value = env[key];
    if (typeof value === 'string' && isSquareProdAppId(value)) {
      findings.push({
        envVar: key,
        reason: 'Value is a Square *production* application ID (prefix "sq0idp-"). Sandbox app IDs are prefixed with "sandbox-sq0idp-". Replace with a sandbox app ID from the Square Developer Dashboard.',
      });
    }
  }

  for (const key of SQUARE_AMBIGUOUS_TOKEN_VARS) {
    const value = env[key];
    if (typeof value === 'string' && isSquareProdAccessToken(value)) {
      findings.push({
        envVar: key,
        reason: 'Value is a Square *production* access token (prefix "EAAAEv" or "EAAAl7"). Replace with a sandbox access token from the Square Developer Dashboard.',
      });
    }
  }

  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string' || value.length === 0) continue;
    for (const prefix of LIVE_KEY_PREFIXES) {
      if (value.startsWith(prefix)) {
        findings.push({
          envVar: key,
          reason: `Value starts with "${prefix}" (live processor key pattern). Use a sandbox/test key on beta.`,
        });
        break;
      }
    }
  }

  return findings;
}
