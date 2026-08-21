/**
 * Shared App-environment definitions.
 *
 * `APP_ENV` is the provider-neutral selector for the logical application
 * environment. It deliberately has no deployment-provider inference:
 * deployment configuration must set `APP_ENV` explicitly.
 *
 * Local and test processes may leave `APP_ENV` unset; those processes resolve
 * to `dev`. Production processes must set `APP_ENV=prod` and are validated
 * against `NODE_ENV=production` by the server and operational scripts.
 */

export const APP_ENV_VALUES = ['dev', 'prod'] as const;
export type AppEnv = (typeof APP_ENV_VALUES)[number];

export function isAppEnv(value: unknown): value is AppEnv {
  return typeof value === 'string' && (APP_ENV_VALUES as readonly string[]).includes(value);
}

export interface ResolveAppEnvInput {
  appEnv: string | undefined;
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
  return 'dev';
}

export interface AppEnvAgreementInput {
  appEnv: string | undefined;
  nodeEnv: string | undefined;
}

export type AppEnvAgreement =
  | { ok: true; appEnv: AppEnv }
  | { ok: false; reason: string };

/**
 * Production selection is fail-closed: `NODE_ENV=production` and
 * `APP_ENV=prod` must either both select production or neither may do so.
 * An omitted selector is intentionally the safe local/test default (`dev`).
 */
export function validateAppEnvAgreement(input: AppEnvAgreementInput): AppEnvAgreement {
  if (input.appEnv !== undefined && !isAppEnv(input.appEnv)) {
    return {
      ok: false,
      reason: `APP_ENV=${input.appEnv || '<empty>'} is invalid; it must be one of: ${APP_ENV_VALUES.join(', ')}.`,
    };
  }
  const appEnv = resolveAppEnv({ appEnv: input.appEnv });
  const nodeProduction = input.nodeEnv === 'production';
  const appProduction = appEnv === 'prod';
  if (nodeProduction !== appProduction) {
    return {
      ok: false,
      reason: `NODE_ENV=${input.nodeEnv ?? '<unset>'} and APP_ENV=${input.appEnv ?? '<unset>'} must agree (production requires NODE_ENV=production and APP_ENV=prod).`,
    };
  }
  return { ok: true, appEnv };
}
