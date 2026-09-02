import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DATABASE_SCHEMA_WRITER_LOCK_KEY } from '../../shared/database-advisory-locks';
import { parseExpectedMigrationTarget } from '../../scripts/db-migrate';
import {
  assertExpectedPendingMigrations,
  parseExpectedPendingMigrations,
} from '../../scripts/lib/db-migration-runner';

describe('production migration expected-pending guard', () => {
  it('leaves normal migration callers unchanged when the guard is absent', () => {
    expect(parseExpectedPendingMigrations(undefined)).toBeUndefined();
  });

  it('accepts an explicit no-op expectation', () => {
    expect(parseExpectedPendingMigrations('none')).toEqual([]);
  });

  it('accepts an ordered comma-separated migration list', () => {
    expect(parseExpectedPendingMigrations('0035_first, 0036_second')).toEqual([
      '0035_first',
      '0036_second',
    ]);
  });

  it.each(['', '   ', '0036-BAD', '0036_valid,0036_valid'])('rejects unsafe input %j', (value) => {
    expect(() => parseExpectedPendingMigrations(value)).toThrow();
  });

  it('accepts only the exact ordered pending list', () => {
    expect(() => assertExpectedPendingMigrations(['0035_first', '0036_second'], [
      '0035_first',
      '0036_second',
    ])).not.toThrow();
    expect(() => assertExpectedPendingMigrations(['0036_second'], ['0035_first', '0036_second']))
      .toThrow('do not exactly match expected');
    expect(() => assertExpectedPendingMigrations(['0036_second', '0035_first'], [
      '0035_first',
      '0036_second',
    ])).toThrow('do not exactly match expected');
  });

  it('requires a complete independently supplied target in guarded mode', () => {
    expect(() => parseExpectedMigrationTarget({}, true)).toThrow(
      'Required migration target variable(s) are absent',
    );
    expect(() => parseExpectedMigrationTarget({
      DB_MIGRATION_EXPECTED_HOST_FINGERPRINT: `sha256:${'a'.repeat(64)}`,
      DB_MIGRATION_EXPECTED_DATABASE: 'neondb',
    }, true)).toThrow('DB_MIGRATION_EXPECTED_ROLE');
  });

  it('accepts only a complete target with a valid endpoint fingerprint', () => {
    const environment = {
      DB_MIGRATION_EXPECTED_HOST_FINGERPRINT: `sha256:${'a'.repeat(64)}`,
      DB_MIGRATION_EXPECTED_DATABASE: 'neondb',
      DB_MIGRATION_EXPECTED_ROLE: 'neondb_owner',
    };
    expect(parseExpectedMigrationTarget(environment, true)).toEqual({
      hostFingerprint: environment.DB_MIGRATION_EXPECTED_HOST_FINGERPRINT,
      database: 'neondb',
      role: 'neondb_owner',
    });
    expect(() => parseExpectedMigrationTarget({
      ...environment,
      DB_MIGRATION_EXPECTED_HOST_FINGERPRINT: 'sha256:not-a-digest',
    }, true)).toThrow('lowercase SHA-256 fingerprint');
  });

  it('keeps every production schema writer on the shared migration lock', () => {
    expect(DATABASE_SCHEMA_WRITER_LOCK_KEY).toBe(843_103_001);
    for (const path of [
      'scripts/lib/db-migration-runner.ts',
      'scripts/lib/db-baseline-adoption.ts',
      'server/db-invariants.ts',
      'server/migrations/migrate-avatars.ts',
    ]) {
      expect(readFileSync(resolve(path), 'utf8'), path)
        .toContain('DATABASE_SCHEMA_WRITER_LOCK_KEY');
    }
  });
});
