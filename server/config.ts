import { z } from "zod";
import { createLogger } from './logger';
import { isReplitDeploymentValue } from './utils/replit-env';
import { APP_ENV_VALUES, resolveAppEnv, type AppEnv } from '../shared/app-env';

const log = createLogger("Config");

export const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL must be set. Did you forget to provision a database?"),
  SESSION_SECRET: z.string().min(1, "SESSION_SECRET must be set. Sessions cannot be secured without a signing key."),

  PORT: z.coerce.number().int().positive().default(5000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  FIELD_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, "FIELD_ENCRYPTION_KEY must be a 64-character hex string (32 bytes). Payment credentials cannot be stored without encryption."),

  SENDGRID_API_KEY: z.string().min(1).optional(),
  SENTRY_DSN: z.string().min(1).optional(),
  BN_API_KEY: z.string().min(1).optional(),
  SETUP_SECRET: z.string().min(1).optional(),

  SQUARE_PROD_TOKEN: z.string().min(1).optional(),
  SQUARE_PRODUCTION_ACCESS_TOKEN: z.string().min(1).optional(),
  SQUARE_ACCESS_TOKEN: z.string().min(1).optional(),
  SQUARE_PRODUCTION_APP_ID: z.string().min(1).optional(),
  SQUARE_PRODUCTION_LOCATION_ID: z.string().min(1).optional(),
  SQUARE_APP_ID: z.string().min(1).optional(),
  SQUARE_LOCATION_ID: z.string().min(1).optional(),

  // Hostnames are case-insensitive but JS string comparisons aren't.
  // `isAllowedOrigin` and `extractSubdomain` already lowercase the
  // *incoming* request hostname before comparing, but env.APP_DOMAIN
  // was previously used as-is. An operator who set
  // APP_DOMAIN=Staging.Example.com would silently break CORS and
  // subdomain matching even though the value passes the regex.
  // Normalising once at parse-time means every downstream consumer
  // sees a lowercase hostname (task #335).
  APP_DOMAIN: z
    .string()
    .min(1)
    .regex(
      /^(?!-)[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/,
      "APP_DOMAIN must be a bare hostname like 'leaguevault.app' (no scheme, no path, no leading dot)",
    )
    .default("leaguevault.app")
    .transform((v) => v.toLowerCase()),

  LOG_LEVEL: z
    .enum(["debug", "info", "warn", "error"], {
      error: () =>
        "LOG_LEVEL must be one of: debug, info, warn, error. Leave it unset to use the safe per-environment default (info in production, debug in dev).",
    })
    .optional(),

  REPLIT_DOMAINS: z.string().optional(),
  REPL_SLUG: z.string().optional(),
  REPL_OWNER: z.string().optional(),
  REPLIT_DEPLOYMENT: z.string().optional(),

  // Canonical environment selector (dev | beta | prod). When unset
  // the server defaults via `resolveAppEnv` (REPLIT_DEPLOYMENT → prod,
  // otherwise dev). The beta Repl MUST set APP_ENV=beta in Secrets;
  // see `shared/app-env.ts` for the resolution rules and
  // `docs/BETA_ENVIRONMENT_SETUP.md` for the runbook.
  APP_ENV: z
    .enum(APP_ENV_VALUES, {
      error: () =>
        `APP_ENV must be one of: ${APP_ENV_VALUES.join(', ')}. Leave it unset to use the safe per-runtime default (prod on a Replit deploy, dev locally). The beta Repl MUST set APP_ENV=beta in Secrets — see docs/BETA_ENVIRONMENT_SETUP.md.`,
    })
    .optional(),

  APPLE_PAY_RECOVERY_ALERTS_ENABLED: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true" || v === "1")),
  APPLE_PAY_RECOVERY_ALERT_MIN_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(30 * 60 * 1000),

  // Square catalog cap alerter (#644). Same shape as the Apple Pay
  // recovery knobs above: a tri-state on/off override + a per-tenant
  // rate-limit window. The default-off-in-dev / on-in-prod resolution
  // lives in the alerter service so a dev environment isn't paging
  // anyone when a developer wires up a fixture catalog.
  SQUARE_CATALOG_CAP_ALERTS_ENABLED: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true" || v === "1")),
  // 6 hours: long enough that a single org repeatedly hitting the cap
  // doesn't flood support, short enough that a fresh recurrence after
  // a "we'll fix it tomorrow" reply still pages.
  SQUARE_CATALOG_CAP_ALERT_MIN_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(6 * 60 * 60 * 1000),

  // Comma-separated list of recipient email domains that the SendGrid
  // dispatcher MUST refuse to deliver to. Used to prevent vitest runs
  // (which create real users at `@vitest.local`) from generating bounce
  // events that count against our quota and hurt sender reputation —
  // see task #593 and the comment block at the top of
  // `server/services/email.ts`. Unset → defaults to `['vitest.local']`
  // so the guard works on a fresh checkout with no extra config.
  // Set to an empty string to disable the guard entirely.
  BLOCK_EMAIL_DOMAINS: z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined) return ['vitest.local'];
      return v
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0);
    }),
});

type Env = z.infer<typeof envSchema>;

// Minimum SETUP_SECRET length in characters. 32 chars of base64 is ~24 bytes
// of entropy; we want at least 32 bytes, which is 44 base64 chars, but we
// keep the floor at 32 chars so operators can also use 32-byte hex-ish
// values. The bar is "long enough that brute force over the
// 5-attempts-per-15-minutes setupAdminLimiter is infeasible".
export const MIN_SETUP_SECRET_LENGTH = 32;

export type SetupSecretValidation =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Validates a SETUP_SECRET candidate value. Exported for unit testing
 * (see tests/unit/setup-secret-validation.test.ts) and called from
 * `validateEnv` at boot. Bootstrap endpoints in
 * `server/routes/setup-admin.ts` rely on this gate to refuse weak secrets.
 */
export function validateSetupSecret(value: string | undefined): SetupSecretValidation {
  if (value === undefined || value === '') {
    // Absent is fine — the setup-admin endpoints disable themselves when
    // SETUP_SECRET is unset. Strength only matters when it IS set.
    return { ok: true };
  }
  if (value.length < MIN_SETUP_SECRET_LENGTH) {
    return {
      ok: false,
      reason: `SETUP_SECRET must be at least ${MIN_SETUP_SECRET_LENGTH} characters long (got ${value.length}). Generate one with: openssl rand -base64 48`,
    };
  }
  // Reject obviously-weak values: all the same character (e.g. "aaaa...").
  if (/^(.)\1+$/.test(value)) {
    return {
      ok: false,
      reason: `SETUP_SECRET is a single repeated character and provides no entropy. Generate one with: openssl rand -base64 48`,
    };
  }
  return { ok: true };
}

const optionalWarnings: { key: keyof Env; feature: string }[] = [
  { key: "SENDGRID_API_KEY", feature: "transactional emails (SendGrid)" },
  { key: "SENTRY_DSN", feature: "error tracking (Sentry)" },
  { key: "BN_API_KEY", feature: "CRM contact sync (BowlNow)" },
  { key: "SETUP_SECRET", feature: "admin bootstrap / disaster recovery endpoints" },
];

function validateEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.issues
      .filter((issue) => {
        const path = issue.path[0] as string;
        return !optionalWarnings.some((w) => w.key === path);
      });

    if (errors.length > 0) {
      log.error("Environment validation failed:");
      for (const err of errors) {
        log.error(`  - ${err.path.join(".")}: ${err.message}`);
      }
      process.exit(1);
    }

    return envSchema.parse({
      ...process.env,
      ...Object.fromEntries(
        result.error.issues
          .filter((issue) => optionalWarnings.some((w) => w.key === issue.path[0]))
          .map((issue) => [issue.path[0], undefined])
      ),
    });
  }

  return result.data;
}

export const env = validateEnv();

// Enforce SETUP_SECRET strength at boot. Refuses to start the server when
// a secret is set but weak — see task 282 / the docs section in replit.md.
{
  const check = validateSetupSecret(env.SETUP_SECRET);
  if (!check.ok) {
    log.error(`Environment validation failed: ${check.reason}`);
    process.exit(1);
  }
}

export const isDev = env.NODE_ENV !== "production";

// Canonical "are we running on a Replit deploy?" boolean. Use this
// instead of `!!env.REPLIT_DEPLOYMENT` so the empty-string edge case
// is handled in exactly one place — see `utils/replit-env.ts`.
export const isDeployment = isReplitDeploymentValue(env.REPLIT_DEPLOYMENT);

// Canonical environment selector (dev | beta | prod). Resolved once
// at boot from APP_ENV (if set) with a runtime-aware default — see
// `shared/app-env.ts` for the rules. Downstream code should import
// this rather than re-resolving from `env.APP_ENV` so the default
// only lives in one place.
export const appEnv: AppEnv = resolveAppEnv({
  appEnv: env.APP_ENV,
  replitDeployment: env.REPLIT_DEPLOYMENT,
});
export const isBetaEnv = appEnv === 'beta';
export const isProdEnv = appEnv === 'prod';

// Canonical "are we in a production-like runtime?" boolean. NODE_ENV
// is the explicit signal; REPLIT_DEPLOYMENT is the implicit one for
// Replit Reserved-VM / Autoscale deploys that may not set NODE_ENV.
export const isProdLike = env.NODE_ENV === "production" || isDeployment;

// Production-like deploys MUST NOT silently run at `debug` — that would
// dump `userId × resourceId` correlations from the org-less drift signal
// in `server/utils/access-control.ts` (task #296) into the prod log sink.
// Operators who explicitly opt back into debug get a loud warning so the
// choice is auditable. The logger itself defaults to `info` in production
// when `LOG_LEVEL` is unset, so this branch only fires on an explicit opt-in.
if (isProdLike && env.LOG_LEVEL === "debug") {
  log.warn(
    "LOG_LEVEL=debug is set on a production-like deploy. " +
      "Debug-level logs include developer-only diagnostics (e.g. userId×resourceId " +
      "correlations from the org-less drift signal in access-control.ts). " +
      "Unset LOG_LEVEL or set LOG_LEVEL=info on production deploys.",
  );
}

const missing = optionalWarnings.filter((w) => !env[w.key]);
if (missing.length > 0) {
  log.warn("Optional environment variables not set:");
  for (const m of missing) {
    log.warn(`  - ${m.key}: ${m.feature} will be disabled`);
  }
}
