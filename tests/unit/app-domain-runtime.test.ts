/**
 * Pins that the runtime call sites converted in task #303 actually honor
 * `config.APP_DOMAIN` instead of the literal `leaguevault.app`. Setting
 * `APP_DOMAIN=staging.example` on a staging deployment must make the
 * email base-URL builder and the subdomain extractor both use that
 * suffix.
 *
 * Each test resets the module cache and mocks `server/config` with a
 * custom `env.APP_DOMAIN` so we don't depend on the real env at boot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../server/storage', () => ({
  storage: {},
}));
vi.mock('../../server/utils/access-control', () => ({
  isSystemAdmin: () => false,
}));
vi.mock('@sendgrid/mail', () => ({
  default: { setApiKey: () => {}, send: async () => {} },
}));

function mockConfig(appDomain: string): void {
  vi.doMock('../../server/config', () => ({
    env: {
      APP_DOMAIN: appDomain,
      SENDGRID_API_KEY: undefined,
    },
    isDev: false,
  }));
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('../../server/config');
});

describe('email getBaseUrl honors APP_DOMAIN', () => {
  it('builds the root URL from APP_DOMAIN when no org slug is given', async () => {
    mockConfig('staging.example');
    const { getBaseUrl } = await import('../../server/services/email');
    expect(getBaseUrl()).toBe('https://staging.example');
  });

  it('builds the per-org URL from APP_DOMAIN when an org slug is given', async () => {
    mockConfig('staging.example');
    const { getBaseUrl } = await import('../../server/services/email');
    expect(getBaseUrl('acme')).toBe('https://acme.staging.example');
  });

  it('falls back to leaguevault.app by default (production)', async () => {
    mockConfig('leaguevault.app');
    const { getBaseUrl } = await import('../../server/services/email');
    expect(getBaseUrl()).toBe('https://leaguevault.app');
    expect(getBaseUrl('acme')).toBe('https://acme.leaguevault.app');
  });
});

describe('subdomain extractSubdomain honors APP_DOMAIN', () => {
  it('extracts a subdomain on a custom APP_DOMAIN suffix', async () => {
    mockConfig('staging.example');
    const { extractSubdomain } = await import('../../server/middleware/subdomain');
    expect(extractSubdomain('acme.staging.example')).toBe('acme');
  });

  it('returns null for the bare APP_DOMAIN host', async () => {
    mockConfig('staging.example');
    const { extractSubdomain } = await import('../../server/middleware/subdomain');
    expect(extractSubdomain('staging.example')).toBeNull();
    expect(extractSubdomain('www.staging.example')).toBeNull();
  });

  it('does not match a host on a different suffix', async () => {
    mockConfig('staging.example');
    const { extractSubdomain } = await import('../../server/middleware/subdomain');
    expect(extractSubdomain('acme.leaguevault.app')).toBeNull();
  });

  it('still extracts on the default leaguevault.app suffix', async () => {
    mockConfig('leaguevault.app');
    const { extractSubdomain } = await import('../../server/middleware/subdomain');
    expect(extractSubdomain('acme.leaguevault.app')).toBe('acme');
  });
});
