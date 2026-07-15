import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __testing, assertSafeDatabaseHost } from '../db-safety';

describe('assertSafeDatabaseHost', () => {
  const ENV_KEYS = [
    'DEV_DB_OK',
    'DATABASE_URL',
    'DEV_DB_HOST_ALLOWLIST',
    ...__testing.AMBIENT_TARGET_OVERRIDE_ENVIRONMENT_KEYS,
  ] as const;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    saved.clear();
    for (const k of ENV_KEYS) {
      saved.set(k, process.env[k]);
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe('refuse paths', () => {
    it('refuses when DATABASE_URL is missing', () => {
      expect(() => assertSafeDatabaseHost('test-script')).toThrowError(
        /DATABASE_URL is not set/,
      );
    });

    it('refuses when DATABASE_URL is unparseable', () => {
      process.env.DATABASE_URL = 'not a url at all';
      expect(() => assertSafeDatabaseHost('test-script')).toThrowError(
        /could not be parsed as a URL/,
      );
    });

    it('refuses when DATABASE_URL host is empty', () => {
      // postgresql:/// has no host
      process.env.DATABASE_URL = 'postgresql:///mydb';
      expect(() => assertSafeDatabaseHost('test-script')).toThrowError(
        /(no hostname|could not be parsed)/,
      );
    });

    it('refuses an unrecognized prod-shaped Neon host with no allow-list', () => {
      process.env.DATABASE_URL =
        'postgresql://u:p@ep-cool-bird-99999999.us-west-2.aws.neon.tech/db';
      let message = '';
      try {
        assertSafeDatabaseHost('cleanup-test-organizations');
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(/not on the dev-database allow-list/);
      expect(message).not.toContain('ep-cool-bird-99999999');
    });

    it('refuses an arbitrary remote host even when DEV_DB_HOST_ALLOWLIST is set to something else', () => {
      process.env.DATABASE_URL = 'postgresql://u:p@db.acme.com/db';
      process.env.DEV_DB_HOST_ALLOWLIST = 'ep-dawn-unit-a66zn28k';
      expect(() => assertSafeDatabaseHost('cleanup')).toThrowError(
        /not on the dev-database allow-list/,
      );
    });

    it('refuses connection query parameters that can override a loopback target', () => {
      process.env.DEV_DB_OK = '1';
      process.env.DATABASE_URL =
        'postgresql://u:p@127.0.0.1:5432/db?host=durable.example&port=6543&user=other';
      expect(() => assertSafeDatabaseHost('build-test-template')).toThrowError(
        /one exact target without target-changing query parameters/,
      );
    });

    it('refuses ambient PostgreSQL target and role overrides', () => {
      process.env.DEV_DB_OK = '1';
      process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:5432/db';
      process.env.PGOPTIONS = '-c role=other';
      process.env.PGHOST = 'durable.example';
      expect(() => assertSafeDatabaseHost('cleanup-test-dbs')).toThrowError(
        /PGHOST, PGOPTIONS/,
      );
    });

    it('refuses URLs without an explicit database role and database name', () => {
      process.env.DEV_DB_OK = '1';
      process.env.DATABASE_URL = 'postgresql://127.0.0.1:5432/';
      expect(() => assertSafeDatabaseHost('cleanup-test-dbs')).toThrowError(
        /database role and database name/,
      );
    });

    it('does NOT treat a substring-blocklist value (e.g. "prod") as a blocker by itself', () => {
      // Sanity: the new design is allow-list-based, not blocklist-based.
      // A host whose name happens to contain "prod" is still refused — but
      // for the right reason (not on the allow-list), not because of a
      // generic substring match. This protects against the mistake the
      // architect flagged: prod hosts whose names DON'T contain "prod"
      // would have slipped through the old design.
      process.env.DATABASE_URL = 'postgresql://u:p@db-prod.example.com/db';
      expect(() => assertSafeDatabaseHost('cleanup')).toThrowError(
        /not on the dev-database allow-list/,
      );
    });
  });

  describe('allow paths', () => {
    it('allows when DEV_DB_OK=1 even with no DATABASE_URL', () => {
      process.env.DEV_DB_OK = '1';
      expect(() => assertSafeDatabaseHost('test-script')).not.toThrow();
    });

    it('allows when DEV_DB_OK=1 even against an obviously-prod host', () => {
      process.env.DEV_DB_OK = '1';
      process.env.DATABASE_URL = 'postgresql://u:p@db-production.acme.com/db';
      expect(() => assertSafeDatabaseHost('test-script')).not.toThrow();
    });

    it('allows localhost', () => {
      process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';
      expect(() => assertSafeDatabaseHost('test-script')).not.toThrow();
    });

    it('allows 127.0.0.1', () => {
      process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:5432/db';
      expect(() => assertSafeDatabaseHost('test-script')).not.toThrow();
    });

    it('allows non-target connection options such as sslmode', () => {
      process.env.DATABASE_URL =
        'postgresql://u:p@127.0.0.1:5432/db?sslmode=require&application_name=test';
      expect(() => assertSafeDatabaseHost('test-script')).not.toThrow();
    });

    it('allows an explicitly-allow-listed host substring', () => {
      process.env.DATABASE_URL =
        'postgresql://u:p@ep-dawn-unit-a66zn28k.us-west-2.aws.neon.tech/db';
      process.env.DEV_DB_HOST_ALLOWLIST = 'ep-dawn-unit-a66zn28k';
      expect(() => assertSafeDatabaseHost('cleanup')).not.toThrow();
    });

    it('honours a comma-separated allow-list', () => {
      process.env.DATABASE_URL =
        'postgresql://u:p@ep-second-host.us-west-2.aws.neon.tech/db';
      process.env.DEV_DB_HOST_ALLOWLIST =
        'ep-dawn-unit-a66zn28k, ep-second-host , ep-third-one';
      expect(() => assertSafeDatabaseHost('cleanup')).not.toThrow();
    });

    it('matches host case-insensitively against the allow-list', () => {
      process.env.DATABASE_URL =
        'postgresql://u:p@EP-DAWN-UNIT-A66ZN28K.us-west-2.aws.neon.tech/db';
      process.env.DEV_DB_HOST_ALLOWLIST = 'ep-dawn-unit-a66zn28k';
      expect(() => assertSafeDatabaseHost('cleanup')).not.toThrow();
    });
  });

  describe('parseAllowlist (internal)', () => {
    const { parseAllowlist } = __testing;

    it('returns [] for undefined / empty', () => {
      expect(parseAllowlist(undefined)).toEqual([]);
      expect(parseAllowlist('')).toEqual([]);
      expect(parseAllowlist('   ')).toEqual([]);
    });

    it('splits, trims, lowercases, and drops empties', () => {
      expect(parseAllowlist(' Foo ,, BAR,baz ,')).toEqual(['foo', 'bar', 'baz']);
    });
  });
});
