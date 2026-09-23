import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DATABASE_SCHEMA_WRITER_LOCK_KEY } from '../../shared/database-advisory-locks';
import { parseExpectedMigrationTarget } from '../../scripts/db-migrate';
import {
  assertExpectedPendingMigrations,
  parseExpectedPendingMigrations,
} from '../../scripts/lib/db-migration-runner';
import type { ActiveMigration } from '../../scripts/lib/db-migration-assets';
import type { JournalEntryRow } from '../../scripts/lib/db-migration-journal';
import type { SchemaStateFingerprint } from '../../scripts/lib/db-schema-state-fingerprint';
import {
  assertShowDbTreeCatalogSecurityState,
  assertShowDbTreeRepairConfirmation,
  assertShowDbTreeRepairJournalBoundary,
  assertShowDbTreeRepairPreFingerprint,
  SHOW_DB_TREE_REPAIR_0049_TAG,
  SHOW_DB_TREE_REPAIR_0050_TAG,
  SHOW_DB_TREE_REPAIR_CONFIRMATION,
  SHOW_DB_TREE_REPAIR_FUNCTION_DEFINITION_SHA256,
  SHOW_DB_TREE_REPAIR_PRE_COUNTS,
  SHOW_DB_TREE_REPAIR_PRE_DIGEST,
  SHOW_DB_TREE_REPAIR_RAW_DEFINITION_SHA256,
} from '../../scripts/lib/production-show-db-tree-repair';

function repairMigrations(): ActiveMigration[] {
  return Array.from({ length: 51 }, (_value, index) => {
    const tag = index === 49
      ? SHOW_DB_TREE_REPAIR_0049_TAG
      : index === 50
        ? SHOW_DB_TREE_REPAIR_0050_TAG
        : `${String(index).padStart(4, '0')}_fixture`;
    return {
      idx: index,
      version: '7',
      createdAt: index,
      tag,
      breakpoints: true,
      sql: '',
      hash: `hash-${index}`,
      path: `/fixture/${tag}.sql`,
      snapshotPath: `/fixture/${tag}.json`,
    };
  });
}

function repairJournalEntries(): JournalEntryRow[] {
  return Array.from({ length: 50 }, (_value, index) => ({
    id: String(index + 1),
    hash: `hash-${index}`,
    created_at: String(index),
  }));
}

function observedRepairFingerprint(): SchemaStateFingerprint {
  return {
    formatVersion: 2,
    algorithm: 'sha256',
    migration: {
      tag: SHOW_DB_TREE_REPAIR_0049_TAG,
      hash: 'hash-49',
      createdAt: 49,
    },
    digest: SHOW_DB_TREE_REPAIR_PRE_DIGEST,
    counts: { ...SHOW_DB_TREE_REPAIR_PRE_COUNTS },
  };
}

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

  it('pins the one-time show_db_tree repair to incident confirmation, journal, and 0049-to-0050 history', () => {
    expect(() => assertShowDbTreeRepairConfirmation(SHOW_DB_TREE_REPAIR_CONFIRMATION)).not.toThrow();
    expect(() => assertShowDbTreeRepairConfirmation(undefined)).toThrow('exact incident repair confirmation');
    expect(() => assertShowDbTreeRepairConfirmation('REPAIR_LEAGUEVAULT_0049_SHOW_DB_TREE')).toThrow(
      'exact incident repair confirmation',
    );

    const active = repairMigrations();
    expect(assertShowDbTreeRepairJournalBoundary(repairJournalEntries(), active).tag)
      .toBe(SHOW_DB_TREE_REPAIR_0049_TAG);
    expect(() => assertShowDbTreeRepairJournalBoundary(repairJournalEntries().slice(1), active))
      .toThrow('exact 50-entry journal prefix');
    expect(() => assertShowDbTreeRepairJournalBoundary(repairJournalEntries(), active.slice(0, 50)))
      .toThrow('active history through migration 0050');
  });

  it('refuses any show_db_tree repair prestate except the observed 0049 fingerprint and counts', () => {
    const active = repairMigrations();
    const migration = active[49];
    if (!migration) throw new Error('fixture is missing migration 0049');
    expect(() => assertShowDbTreeRepairPreFingerprint(observedRepairFingerprint(), migration)).not.toThrow();
    expect(() => assertShowDbTreeRepairPreFingerprint(
      { ...observedRepairFingerprint(), digest: 'a'.repeat(64) },
      migration,
    )).toThrow('exact observed 0049 fingerprint and counts');
    expect(() => assertShowDbTreeRepairPreFingerprint(
      {
        ...observedRepairFingerprint(),
        counts: { ...SHOW_DB_TREE_REPAIR_PRE_COUNTS, functions: 21 },
      },
      migration,
    )).toThrow('exact observed 0049 fingerprint and counts');
    expect(() => assertShowDbTreeRepairPreFingerprint(
      observedRepairFingerprint(),
      { ...migration, hash: 'other-hash' },
    )).toThrow('exact observed 0049 fingerprint and counts');
  });

  it('pins the reviewed show_db_tree raw definition, owner, default ACL, and dependencies', () => {
    expect(SHOW_DB_TREE_REPAIR_RAW_DEFINITION_SHA256)
      .toBe('3cfbbce2aee1851aec351d1e99b7c071fa8bbf4b7c5f165f1fbb7f7e6506389a');
    expect(SHOW_DB_TREE_REPAIR_FUNCTION_DEFINITION_SHA256)
      .toBe('5be7a62f70799a7e52d515b40b9a9cfa4104a5aeed4a9e507206298c22ed2dd4');
    const reviewedState = {
      owner: 'neondb_owner',
      explicitAclPresent: false,
      rawDefinitionSha256: SHOW_DB_TREE_REPAIR_RAW_DEFINITION_SHA256,
      acl: [
        {
          grantor: 'neondb_owner',
          grantee: 'PUBLIC',
          privilegeType: 'EXECUTE',
          isGrantable: false,
        },
        {
          grantor: 'neondb_owner',
          grantee: 'neondb_owner',
          privilegeType: 'EXECUTE',
          isGrantable: false,
        },
      ],
      dependents: [],
    };
    expect(() => assertShowDbTreeCatalogSecurityState(reviewedState)).not.toThrow();
    expect(() => assertShowDbTreeCatalogSecurityState({
      ...reviewedState,
      owner: 'other_role',
    })).toThrow('does not match the reviewed clone evidence');
    expect(() => assertShowDbTreeCatalogSecurityState({
      ...reviewedState,
      explicitAclPresent: true,
    })).toThrow('does not match the reviewed clone evidence');
    expect(() => assertShowDbTreeCatalogSecurityState({
      ...reviewedState,
      acl: reviewedState.acl.slice(1),
    })).toThrow('does not match the reviewed clone evidence');
    expect(() => assertShowDbTreeCatalogSecurityState({
      ...reviewedState,
      dependents: [{
        classId: 'pg_class',
        objectId: '1',
        objectSubId: '0',
        dependencyType: 'n',
        description: 'unexpected dependent',
      }],
    })).toThrow('does not match the reviewed clone evidence');
    expect(() => assertShowDbTreeCatalogSecurityState({
      ...reviewedState,
      rawDefinitionSha256: '0'.repeat(64),
    })).toThrow('does not match the reviewed clone evidence');
  });
});
