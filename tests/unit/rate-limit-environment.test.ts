import { describe, expect, it } from 'vitest';
import {
  assertProductionRateLimitStore,
  usesSharedRateLimitStore,
} from '../../server/utils/rate-limit-environment';

describe('production rate-limit store activation', () => {
  it('accepts production only when NODE_ENV selects the shared store', () => {
    const environment = { APP_ENV: 'prod', NODE_ENV: 'production' };

    expect(() => assertProductionRateLimitStore(environment)).not.toThrow();
    expect(usesSharedRateLimitStore(environment)).toBe(true);
  });

  it('refuses an explicit production APP_ENV with an in-memory store', () => {
    expect(() => assertProductionRateLimitStore({
      APP_ENV: 'prod',
      NODE_ENV: 'development',
    })).toThrow(/production APP_ENV requires NODE_ENV=production.*shared PostgreSQL store/i);
  });

  it('refuses production APP_ENV with NODE_ENV=test', () => {
    expect(() => assertProductionRateLimitStore({
      APP_ENV: 'prod',
      NODE_ENV: 'test',
    })).toThrow(/production APP_ENV requires NODE_ENV=production.*shared PostgreSQL store/i);
  });

  it('preserves the in-memory store in dev', () => {
    const appEnv = 'dev';
    const environment = { APP_ENV: appEnv, NODE_ENV: 'development' };

    expect(() => assertProductionRateLimitStore(environment)).not.toThrow();
    expect(usesSharedRateLimitStore(environment)).toBe(false);
  });
});
