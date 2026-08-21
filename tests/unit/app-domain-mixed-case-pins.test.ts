/**
 * End-to-end pin sweep for task #395.
 *
 * Task #335 normalises `env.APP_DOMAIN` to lowercase at parse-time. Every
 * downstream consumer (cookie domain, CSP frame-ancestors, CORS allow-list,
 * subdomain extractor, From: address, getBaseUrl, Apple Pay accepted-domain
 * set) silently relies on that invariant — they string-compare against
 * already-lowercased request hostnames, or interpolate the value into a URL
 * / cookie / header where casing should be canonical.
 *
 * If a future refactor drops the `.transform((v) => v.toLowerCase())` from
 * `envSchema.APP_DOMAIN`, every consumer would silently regress in a
 * different way. This sweep parses a deliberately mixed-case value through
 * the real `envSchema`, mocks `server/config` with the parse result, and
 * asserts that EACH consumer produces the expected lowercase output.
 *
 * Together with `app-domain-config.test.ts` (which pins the schema) and
 * `app-domain-runtime.test.ts` / `security-app-domain.test.ts` (which pin
 * each consumer with a literal lowercase value), this closes the loop:
 * the schema -> consumer chain stays case-safe end-to-end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { envSchema } from '../../server/config';

const MIXED_CASE_INPUT = 'Staging.LeagueVault.App';
const EXPECTED_LOWER = 'staging.leaguevault.app';

/**
 * Run the deliberately mixed-case operator value through the REAL
 * `envSchema` to get the value that would actually reach consumers in
 * production. If task #335 ever regresses, this returns mixed case and
 * every assertion below would surface the bug.
 */
function parseMixedCaseAppDomain(): string {
  const parsed = envSchema.parse({
    DATABASE_URL: 'postgres://test',
    SESSION_SECRET: 'test-session-secret-xxxxxxxxxxxx',
    FIELD_ENCRYPTION_KEY: 'a'.repeat(64),
    APP_DOMAIN: MIXED_CASE_INPUT,
  });
  return parsed.APP_DOMAIN;
}

interface ConfigOverrides {
  isDev?: boolean;
}

function mockConfigWithParsedAppDomain(overrides: ConfigOverrides = {}): string {
  const appDomain = parseMixedCaseAppDomain();
  vi.doMock('../../server/config', () => ({
    env: {
      APP_DOMAIN: appDomain,
      SENDGRID_API_KEY: undefined,
    },
    isDev: overrides.isDev ?? false,
  }));
  return appDomain;
}

vi.mock('../../server/storage', () => ({
  storage: {},
}));
vi.mock('../../server/utils/access-control', () => ({
  isSystemAdmin: () => false,
}));
vi.mock('@sendgrid/mail', () => ({
  default: { setApiKey: () => {}, send: async () => {} },
}));

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('../../server/config');
});

describe('parse-time normalisation feeds all consumers a lowercase value', () => {
  it('envSchema.parse lowercases a mixed-case operator value', () => {
    expect(parseMixedCaseAppDomain()).toBe(EXPECTED_LOWER);
  });
});

describe('subdomain.extractSubdomain matches a mixed-case operator value', () => {
  it('extracts a subdomain from a request host (request hosts are lowercase)', async () => {
    mockConfigWithParsedAppDomain();
    const { extractSubdomain } = await import('../../server/middleware/subdomain');
    expect(extractSubdomain(`acme.${EXPECTED_LOWER}`)).toBe('acme');
  });

  it('returns null on the bare APP_DOMAIN host', async () => {
    mockConfigWithParsedAppDomain();
    const { extractSubdomain } = await import('../../server/middleware/subdomain');
    expect(extractSubdomain(EXPECTED_LOWER)).toBeNull();
    expect(extractSubdomain(`www.${EXPECTED_LOWER}`)).toBeNull();
  });
});

describe('security.isAllowedOrigin matches a mixed-case operator value', () => {
  it('allow-lists the bare APP_DOMAIN over https', async () => {
    mockConfigWithParsedAppDomain();
    const { isAllowedOrigin } = await import('../../server/middleware/security');
    // Browsers lowercase the Origin host via the URL parser, so the
    // allow-listed entry MUST be lowercase too. This pins the chain.
    expect(isAllowedOrigin(`https://${EXPECTED_LOWER}`)).toBe(true);
  });

  it('allow-lists subdomains via the suffix endsWith check', async () => {
    mockConfigWithParsedAppDomain();
    const { isAllowedOrigin } = await import('../../server/middleware/security');
    expect(isAllowedOrigin(`https://acme.${EXPECTED_LOWER}`)).toBe(true);
  });
});

/**
 * Helmet writes the CSP header synchronously via res.setHeader; capture
 * it via a fake response.
 */
async function runSecurityHeadersAndGetCsp(): Promise<string> {
  const { securityHeaders } = await import('../../server/middleware/security');
  const headers: Record<string, string> = {};
  const req = { method: 'GET', headers: {} } as unknown as Request;
  const res = {
    setHeader(name: string, value: string | number | readonly string[]) {
      headers[name.toLowerCase()] = String(value);
      return this;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    removeHeader(name: string) {
      delete headers[name.toLowerCase()];
    },
    end() {},
  } as unknown as Response;
  await new Promise<void>((resolve, reject) => {
    securityHeaders(req, res, (err?: unknown) => (err ? reject(err) : resolve()));
  });
  const csp = headers['content-security-policy'];
  if (!csp) throw new Error('Helmet did not set Content-Security-Policy');
  return csp;
}

describe('CSP frame-ancestors emits the lowercase form for a mixed-case operator value', () => {
  it('contains the lowercase host and wildcard, never the mixed-case input', async () => {
    mockConfigWithParsedAppDomain();
    const csp = await runSecurityHeadersAndGetCsp();
    const directive = csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith('frame-ancestors'));
    expect(directive).toBeDefined();
    expect(directive).toContain(`https://${EXPECTED_LOWER}`);
    expect(directive).toContain(`https://*.${EXPECTED_LOWER}`);
    // Belt-and-braces: the mixed-case input must not appear anywhere.
    expect(directive).not.toContain(MIXED_CASE_INPUT);
  });
});

describe('email getBaseUrl emits the lowercase form for a mixed-case operator value', () => {
  it('builds the root URL in canonical lowercase', async () => {
    mockConfigWithParsedAppDomain();
    const { getBaseUrl } = await import('../../server/services/email');
    expect(getBaseUrl()).toBe(`https://${EXPECTED_LOWER}`);
  });

  it('builds the per-org URL in canonical lowercase', async () => {
    mockConfigWithParsedAppDomain();
    const { getBaseUrl } = await import('../../server/services/email');
    expect(getBaseUrl('acme')).toBe(`https://acme.${EXPECTED_LOWER}`);
  });
});

describe('apple-pay accepted-domain set lowercases for a mixed-case operator value', () => {
  it('mints and accepts the canonical lowercase domain', async () => {
    mockConfigWithParsedAppDomain();
    const { canonicalApplePayDomain, acceptedApplePayDomainsForOrg, isAcceptedApplePayDomain } =
      await import('../../server/services/apple-pay-domains');
    const org = { subdomain: 'acme', slug: 'acme' };
    expect(canonicalApplePayDomain(org)).toBe(`acme.${EXPECTED_LOWER}`);
    expect(acceptedApplePayDomainsForOrg(org)).toContain(`acme.${EXPECTED_LOWER}`);
    // The compare side also lowercases candidate input, so a request
    // for a mixed-case domain still resolves to the lowercase entry.
    expect(isAcceptedApplePayDomain(org, `Acme.${MIXED_CASE_INPUT}`)).toBe(true);
  });
});
