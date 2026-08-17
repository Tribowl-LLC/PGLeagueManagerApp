/**
 * Pins the rest of the env-schema contracts (task #333).
 *
 * Task #304 introduced `tests/unit/app-domain-config.test.ts` to pin the
 * APP_DOMAIN regex so a future tweak couldn't silently weaken it. The
 * other validated entries in `server/config.ts`'s envSchema have the
 * same regression risk: a bad value that slips past the schema only
 * surfaces later as a confusing runtime error (e.g. crypto failures
 * for a too-short FIELD_ENCRYPTION_KEY, an unknown LOG_LEVEL silently
 * routing every line to `info`, or a stringy "false" for the
 * APPLE_PAY_RECOVERY_ALERTS_ENABLED feature flag being treated as
 * truthy).
 *
 * For each non-trivial field we pin:
 *   - representative accepted values
 *   - representative rejected values
 *   - the default (when the schema declares one)
 *   - the operator-friendly error message (where one is set), so a
 *     future refactor that strips the custom message is caught.
 */
import { describe, expect, it } from 'vitest';
import {
  envSchema,
  validateScheduledPaymentExecutionMode,
} from '../../server/config';
import { isReplitDeploymentValue } from '../../server/utils/replit-env';

describe('FIELD_ENCRYPTION_KEY env-schema entry', () => {
  const field = envSchema.shape.FIELD_ENCRYPTION_KEY;
  const validHex64 = 'a'.repeat(64);
  const validMixedCase = 'AbCdEf0123456789'.repeat(4);

  it('accepts a 64-char lowercase hex string', () => {
    expect(field.safeParse(validHex64).success).toBe(true);
  });

  it('accepts a 64-char mixed-case hex string', () => {
    expect(field.safeParse(validMixedCase).success).toBe(true);
  });

  it.each([
    ['too short (63 chars)', 'a'.repeat(63)],
    ['too long (65 chars)', 'a'.repeat(65)],
    ['empty string', ''],
    ['contains a non-hex character (z)', 'z'.repeat(64)],
    ['contains a space', 'a'.repeat(63) + ' '],
    ['base64 string', 'A'.repeat(44)],
  ])('rejects %s', (_, value) => {
    expect(field.safeParse(value).success).toBe(false);
  });

  it('surfaces the operator-friendly error message on a bad value', () => {
    const result = field.safeParse('nope');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(
        /64-character hex string.*32 bytes.*Payment credentials/i,
      );
    }
  });
});

describe('PORT env-schema entry', () => {
  const field = envSchema.shape.PORT;

  it.each([
    ['numeric string "5000"', '5000', 5000],
    ['numeric string "1"', '1', 1],
    ['actual number 8080', 8080, 8080],
  ])('accepts %s and coerces to a number', (_, input, expected) => {
    const result = field.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(expected);
  });

  it('defaults to 5000 when unset', () => {
    const result = field.safeParse(undefined);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(5000);
  });

  it.each([
    ['zero', '0'],
    ['negative', '-1'],
    ['decimal', '3.14'],
    ['non-numeric', 'abc'],
    ['empty string', ''],
  ])('rejects %s', (_, value) => {
    expect(field.safeParse(value).success).toBe(false);
  });
});

describe('NODE_ENV env-schema entry', () => {
  const field = envSchema.shape.NODE_ENV;

  it.each(['development', 'production', 'test'])('accepts %s', (value) => {
    const result = field.safeParse(value);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(value);
  });

  it('defaults to development when unset', () => {
    const result = field.safeParse(undefined);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe('development');
  });

  it.each([
    ['staging'],
    ['Production'],
    ['PROD'],
    ['dev'],
    [''],
  ])('rejects %s', (value) => {
    expect(field.safeParse(value).success).toBe(false);
  });
});

describe('SCHEDULED_PAYMENT_EXECUTION_MODE startup gate', () => {
  const field = envSchema.shape.SCHEDULED_PAYMENT_EXECUTION_MODE;

  it.each(['legacy', 'ledger_paused', 'ledger_execute'])('accepts %s', (value) => {
    expect(field.safeParse(value).success).toBe(true);
  });

  it.each(['', 'paused', 'execute', 'LEGACY'])('rejects %s', (value) => {
    expect(field.safeParse(value).success).toBe(false);
  });

  it('fails closed when either production selector is active and mode is missing', () => {
    expect(validateScheduledPaymentExecutionMode({
      mode: undefined,
      nodeEnv: 'production',
      appEnv: 'prod',
    })).toMatchObject({ ok: false });
    expect(validateScheduledPaymentExecutionMode({
      mode: undefined,
      nodeEnv: 'development',
      appEnv: 'prod',
    })).toMatchObject({ ok: false });
  });

  it('keeps local and test runtimes on legacy when mode is omitted', () => {
    expect(validateScheduledPaymentExecutionMode({
      mode: undefined,
      nodeEnv: 'test',
      appEnv: 'dev',
    })).toEqual({ ok: true, mode: 'legacy' });
  });

  it('honors every explicit production mode', () => {
    for (const mode of ['legacy', 'ledger_paused', 'ledger_execute'] as const) {
      expect(validateScheduledPaymentExecutionMode({
        mode,
        nodeEnv: 'production',
        appEnv: 'prod',
      })).toEqual({ ok: true, mode });
    }
  });
});

describe('LOG_LEVEL env-schema entry', () => {
  const field = envSchema.shape.LOG_LEVEL;

  it.each(['debug', 'info', 'warn', 'error'])('accepts %s', (value) => {
    const result = field.safeParse(value);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(value);
  });

  it('accepts undefined (per-environment default applies downstream)', () => {
    const result = field.safeParse(undefined);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBeUndefined();
  });

  it.each([
    ['trace'],
    ['INFO'],
    ['warning'],
    ['fatal'],
    [''],
  ])('rejects %s', (value) => {
    expect(field.safeParse(value).success).toBe(false);
  });

  it('surfaces the operator-friendly error message on a bad value', () => {
    const result = field.safeParse('trace');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(
        /debug, info, warn, error.*safe per-environment default.*info in production/i,
      );
    }
  });
});

describe('APPLE_PAY_RECOVERY_ALERTS_ENABLED env-schema entry', () => {
  const field = envSchema.shape.APPLE_PAY_RECOVERY_ALERTS_ENABLED;

  it.each([
    ['"true"', 'true', true],
    ['"1"', '1', true],
    ['"false"', 'false', false],
    ['"0"', '0', false],
  ])('accepts %s and transforms to %s', (_, input, expected) => {
    const result = field.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(expected);
  });

  it('returns undefined when unset (feature stays at downstream default)', () => {
    const result = field.safeParse(undefined);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBeUndefined();
  });

  it.each([
    // These would silently be coerced to `true` by a naive `Boolean(v)` —
    // pin that the schema rejects them so a future refactor can't sneak
    // truthy strings past the gate and accidentally enable the feature.
    ['yes'],
    ['no'],
    ['TRUE'],
    ['False'],
    ['on'],
    ['off'],
    [''],
    ['2'],
  ])('rejects ambiguous truthy/falsy string %s', (value) => {
    expect(field.safeParse(value).success).toBe(false);
  });
});

describe('APPLE_PAY_RECOVERY_ALERT_MIN_INTERVAL_MS env-schema entry', () => {
  const field = envSchema.shape.APPLE_PAY_RECOVERY_ALERT_MIN_INTERVAL_MS;

  it('defaults to 30 minutes (1_800_000 ms) when unset', () => {
    const result = field.safeParse(undefined);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(30 * 60 * 1000);
  });

  it.each([
    ['"1"', '1', 1],
    ['"60000"', '60000', 60000],
    ['actual number 90000', 90000, 90000],
  ])('accepts %s and coerces to a positive integer', (_, input, expected) => {
    const result = field.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(expected);
  });

  it.each([
    ['zero', '0'],
    ['negative', '-1000'],
    ['decimal', '1.5'],
    ['non-numeric', 'soon'],
  ])('rejects %s', (_, value) => {
    expect(field.safeParse(value).success).toBe(false);
  });
});

describe('DATABASE_URL env-schema entry', () => {
  const field = envSchema.shape.DATABASE_URL;

  it('accepts any non-empty string', () => {
    expect(field.safeParse('postgres://u:p@h/db').success).toBe(true);
  });

  it('rejects an empty string with the operator-friendly message', () => {
    const result = field.safeParse('');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(
        /DATABASE_URL must be set.*provision a database/i,
      );
    }
  });

  it('rejects undefined (no default)', () => {
    expect(field.safeParse(undefined).success).toBe(false);
  });
});

describe('SESSION_SECRET env-schema entry', () => {
  const field = envSchema.shape.SESSION_SECRET;

  it('accepts any non-empty string', () => {
    expect(field.safeParse('any-non-empty-secret').success).toBe(true);
  });

  it('rejects an empty string with the operator-friendly message', () => {
    const result = field.safeParse('');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(
        /SESSION_SECRET must be set.*Sessions cannot be secured/i,
      );
    }
  });

  it('rejects undefined (no default)', () => {
    expect(field.safeParse(undefined).success).toBe(false);
  });
});

// Optional credential fields share the same shape: `string().min(1).optional()`.
// Pinning the contract on a representative subset (one per provider family)
// is enough to catch a regression like accidentally dropping `.min(1)` and
// allowing an empty string to mask a missing secret.
describe('Optional credential env-schema entries', () => {
  const optionalCredFields = [
    ['SENDGRID_API_KEY', envSchema.shape.SENDGRID_API_KEY],
    ['SENTRY_DSN', envSchema.shape.SENTRY_DSN],
    ['SETUP_SECRET', envSchema.shape.SETUP_SECRET],
    ['SQUARE_PROD_TOKEN', envSchema.shape.SQUARE_PROD_TOKEN],
    ['SQUARE_PRODUCTION_ACCESS_TOKEN', envSchema.shape.SQUARE_PRODUCTION_ACCESS_TOKEN],
    ['SQUARE_ACCESS_TOKEN', envSchema.shape.SQUARE_ACCESS_TOKEN],
    ['SQUARE_PRODUCTION_APP_ID', envSchema.shape.SQUARE_PRODUCTION_APP_ID],
    ['SQUARE_PRODUCTION_LOCATION_ID', envSchema.shape.SQUARE_PRODUCTION_LOCATION_ID],
    ['SQUARE_APP_ID', envSchema.shape.SQUARE_APP_ID],
    ['SQUARE_LOCATION_ID', envSchema.shape.SQUARE_LOCATION_ID],
  ] as const;

  it.each(optionalCredFields)('%s accepts undefined (optional)', (_, field) => {
    const result = field.safeParse(undefined);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBeUndefined();
  });

  it.each(optionalCredFields)('%s accepts a non-empty value', (_, field) => {
    expect(field.safeParse('any-non-empty').success).toBe(true);
  });

  it.each(optionalCredFields)(
    '%s rejects an empty string (would otherwise mask a missing secret)',
    (_, field) => {
      expect(field.safeParse('').success).toBe(false);
    },
  );
});

// Replit platform-injected env vars: free-form optional strings. The pin
// below ensures they stay optional (i.e. local/dev runs that aren't on
// Replit don't fail boot) and that they don't accidentally get tightened
// to required.
describe('Replit platform env-schema entries (optional, free-form)', () => {
  const replitFields = [
    ['REPLIT_DOMAINS', envSchema.shape.REPLIT_DOMAINS],
    ['REPL_SLUG', envSchema.shape.REPL_SLUG],
    ['REPL_OWNER', envSchema.shape.REPL_OWNER],
    ['REPLIT_DEPLOYMENT', envSchema.shape.REPLIT_DEPLOYMENT],
  ] as const;

  it.each(replitFields)('%s accepts undefined', (_, field) => {
    expect(field.safeParse(undefined).success).toBe(true);
  });

  it.each(replitFields)('%s accepts an empty string (free-form)', (_, field) => {
    // These are platform-injected — we don't second-guess Replit's values.
    expect(field.safeParse('').success).toBe(true);
  });

  it.each(replitFields)('%s accepts a normal value', (_, field) => {
    expect(field.safeParse('something').success).toBe(true);
  });
});

// `REPLIT_DEPLOYMENT` is intentionally accepted as a free-form string at
// the schema level (the platform owns the value), so the "are we in a
// deploy?" decision is made by `isReplitDeploymentValue` instead. Pin
// the contract here so a future caller can't reintroduce the
// `!!env.REPLIT_DEPLOYMENT` shortcut and silently disagree about what
// an empty string means.
describe('isReplitDeploymentValue derived boolean', () => {
  it('treats undefined as not deployed', () => {
    expect(isReplitDeploymentValue(undefined)).toBe(false);
  });

  it('treats an empty string as not deployed', () => {
    expect(isReplitDeploymentValue('')).toBe(false);
  });

  it.each(['1', 'true', 'autoscale', 'reserved-vm'])(
    'treats %s as deployed',
    (value) => {
      expect(isReplitDeploymentValue(value)).toBe(true);
    },
  );
});

describe('F1 activation gate', () => {
  const base = { DATABASE_URL: 'postgres://localhost/db', SESSION_SECRET: 'secret', FIELD_ENCRYPTION_KEY: '0'.repeat(64), NODE_ENV: 'development' as const };
  it('defaults false when unset and accepts explicit true', () => {
    expect(envSchema.parse(base).LEAGUEVAULT_F1_ACTIVATION_ENABLED).toBe(false);
    expect(envSchema.parse({ ...base, LEAGUEVAULT_F1_ACTIVATION_ENABLED: 'true' }).LEAGUEVAULT_F1_ACTIVATION_ENABLED).toBe(true);
  });
  it('rejects invalid activation gate values', () => {
    expect(envSchema.safeParse({ ...base, LEAGUEVAULT_F1_ACTIVATION_ENABLED: 'yes' }).success).toBe(false);
  });
});
