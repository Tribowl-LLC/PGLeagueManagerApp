/**
 * Pins the production-safe LOG_LEVEL defaults introduced in task #306:
 *   - When LOG_LEVEL is unset and `NODE_ENV=production`, the minimum level
 *     is `info` — so the developer-only debug lines in
 *     `server/utils/access-control.ts` (userId × resourceId
 *     correlations from the org-less drift signal, task #296) are
 *     dropped at the sink.
 *   - When LOG_LEVEL is unset and the runtime is dev/test, the minimum level
 *     is `debug` — so devs still see those signals locally.
 *   - An explicit LOG_LEVEL always wins over the default.
 *   - The env-schema rejects unknown LOG_LEVEL values with an
 *     operator-friendly message.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _getMinLevelForTests as getMinLevel,
  _isProductionLikeRuntimeForTests as isProductionLikeRuntime,
} from '../../server/logger';
import { envSchema } from '../../server/config';

const SAVED = {
  LOG_LEVEL: process.env.LOG_LEVEL,
  NODE_ENV: process.env.NODE_ENV,
};

beforeEach(() => {
  delete process.env.LOG_LEVEL;
  delete process.env.NODE_ENV;
});

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('logger.getMinLevel default', () => {
  it('defaults to info when NODE_ENV=production and LOG_LEVEL is unset', () => {
    process.env.NODE_ENV = 'production';
    expect(isProductionLikeRuntime()).toBe(true);
    expect(getMinLevel()).toBe('info');
  });

  it.each(['development', 'test'])('defaults to debug in %s when LOG_LEVEL is unset', (nodeEnv) => {
    process.env.NODE_ENV = nodeEnv;
    expect(isProductionLikeRuntime()).toBe(false);
    expect(getMinLevel()).toBe('debug');
  });

  it('honors an explicit LOG_LEVEL=debug even in production (operator opt-in)', () => {
    process.env.NODE_ENV = 'production';
    process.env.LOG_LEVEL = 'debug';
    expect(getMinLevel()).toBe('debug');
  });

  it.each(['info', 'warn', 'error'])(
    'honors an explicit LOG_LEVEL=%s in dev',
    (level) => {
      process.env.NODE_ENV = 'development';
      process.env.LOG_LEVEL = level;
      expect(getMinLevel()).toBe(level);
    },
  );

  it('falls back to the env-default when LOG_LEVEL is set to a junk value', () => {
    process.env.NODE_ENV = 'production';
    process.env.LOG_LEVEL = 'verbose';
    expect(getMinLevel()).toBe('info');
  });

  it('is case-insensitive on a valid LOG_LEVEL', () => {
    process.env.LOG_LEVEL = 'INFO';
    expect(getMinLevel()).toBe('info');
  });
});

describe('LOG_LEVEL env-schema entry', () => {
  const logLevel = envSchema.shape.LOG_LEVEL;

  it.each(['debug', 'info', 'warn', 'error'])('accepts %s', (v) => {
    expect(logLevel.safeParse(v).success).toBe(true);
  });

  it('treats undefined as valid (defers to logger default)', () => {
    expect(logLevel.safeParse(undefined).success).toBe(true);
  });

  it('rejects an unknown level with an operator-friendly message', () => {
    const r = logLevel.safeParse('verbose');
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.message).toMatch(/debug, info, warn, error/);
    }
  });
});
