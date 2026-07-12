/**
 * Shared App-environment definitions.
 *
 * `APP_ENV` is the canonical signal for "which environment is this
 * code running in?" — independent of `NODE_ENV` (build mode) and
 * `REPLIT_DEPLOYMENT` (Replit deploy flag). It exists because we run
 * three logically distinct environments off the same codebase:
 *
 *   - `dev`   the local Replit workspace (one Repl, one dev DB)
 *   - `beta`  the forked Repl deployed to beta.leaguevault.app
 *   - `prod`  the live Repl deployed to leaguevault.app
 *
 * The historical Replit runbook is in `docs/replit-handoff.md`. The current
 * production workflow is documented in `AGENTS.md` and
 * `docs/production-runbook.md`.
 *
 * Resolution rules (single source of truth — used both in
 * `server/config.ts` to validate the env var and in
 * `server/utils/app-env.ts` to expose the boolean accessors):
 *
 *   1. If `APP_ENV` is set explicitly (and is a valid value), use it.
 *   2. Otherwise default by inferred runtime:
 *      - On a Replit deploy (`REPLIT_DEPLOYMENT` non-empty) → `prod`
 *      - In a local/dev workspace                          → `dev`
 *
 *   `beta` is NEVER a default. A beta Repl MUST set `APP_ENV=beta`
 *   in Secrets, otherwise it would boot as `prod` and the BETA
 *   banner / sandbox-creds guard would silently disable themselves.
 */

export const APP_ENV_VALUES = ['dev', 'beta', 'prod'] as const;
export type AppEnv = (typeof APP_ENV_VALUES)[number];

export function isAppEnv(value: unknown): value is AppEnv {
  return typeof value === 'string' && (APP_ENV_VALUES as readonly string[]).includes(value);
}

export interface ResolveAppEnvInput {
  appEnv: string | undefined;
  replitDeployment: string | undefined;
}

/**
 * Resolves the effective `AppEnv` from raw environment values.
 *
 * Pure function — no `process.env` access — so it can be unit-tested
 * and reused on both client and server without coupling to either
 * runtime's env shape.
 */
export function resolveAppEnv(input: ResolveAppEnvInput): AppEnv {
  if (isAppEnv(input.appEnv)) {
    return input.appEnv;
  }
  const isDeployed = typeof input.replitDeployment === 'string' && input.replitDeployment.length > 0;
  return isDeployed ? 'prod' : 'dev';
}
