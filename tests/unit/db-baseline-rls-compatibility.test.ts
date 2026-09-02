import { describe, expect, it } from 'vitest';
import {
  APPLICATION_TABLE_NAMES,
  createBaselineFingerprint,
  loadApprovedBaselineFingerprint,
  verifyBaselineInventory,
} from '../../scripts/lib/db-baseline-fingerprint';
import type {
  DatabaseInventory,
  PolicyInfo,
} from '../../scripts/lib/db-schema-inventory';
import { baselineMigration } from '../../scripts/lib/db-migration-assets';
import { createSchemaStateFingerprint } from '../../scripts/lib/db-schema-state-fingerprint';

function requiredAt<T>(values: readonly T[], index: number, label: string): T {
  const value = values[index];
  if (!value) throw new Error(`Compatibility fixture is missing ${label} at index ${index}.`);
  return value;
}

function canonicalInventory(): DatabaseInventory {
  const approved = loadApprovedBaselineFingerprint();
  return {
    formatVersion: 7,
    target: {
      hostFingerprint: `sha256:${'a'.repeat(64)}`,
      database: 'leaguevault_compatibility_fixture',
      role: 'leaguevault_app',
      serverVersion: '17.0',
      serverVersionNumber: '170000',
      transactionIsolation: 'repeatable read',
      transactionReadOnly: true,
      roleSuperuser: false,
      roleBypassRls: true,
    },
    schemas: [{ name: 'public' }],
    tables: approved.structure.tables.map((table) => ({
      ...table,
      owner: 'leaguevault_app',
      connectedRoleOwnsTable: true,
      connectedRolePrivileges: [],
      connectedRoleRlsMode: 'not-enabled',
    })),
    nonTableRelations: [],
    rewriteRules: structuredClone(approved.structure.rewriteRules),
    unsupportedPublicObjects: [],
    tablePrivileges: [],
    policies: [],
    columns: approved.structure.columns.map((column, ordinal) => ({ ...column, ordinal: ordinal + 1 })),
    sequences: approved.structure.sequences.map((sequence) => ({
      ...sequence,
      owner: 'leaguevault_app',
      connectedRoleCanAlter: true,
    })),
    constraints: structuredClone(approved.structure.constraints),
    indexes: structuredClone(approved.structure.indexes),
    types: structuredClone(approved.structure.types),
    functions: structuredClone(approved.structure.functions),
    triggers: structuredClone(approved.structure.triggers),
    extensions: [],
    migrationJournalDiscovery: [{ schema: 'drizzle', table: '__drizzle_migrations' }],
    migrationJournalInspection: {
      approvedRelation: { schema: 'drizzle', table: '__drizzle_migrations' },
      selection: 'default',
      relationDiscovered: true,
      columnsInspected: true,
      rowsCollected: true,
    },
    migrationJournalExists: true,
    migrationJournals: [{
      schema: 'drizzle',
      table: '__drizzle_migrations',
      columns: ['created_at', 'hash', 'id'],
      entries: [],
    }],
  };
}

function legacyInertRlsInventory(): DatabaseInventory {
  const inventory = canonicalInventory();
  inventory.tables = inventory.tables.map((table) => ({
    ...table,
    rowSecurity: true,
    forceRowSecurity: false,
    connectedRoleRlsMode: 'bypass-bypassrls',
  }));
  return inventory;
}

function policy(overrides: Partial<PolicyInfo> = {}): PolicyInfo {
  return {
    schema: 'public',
    table: 'organizations',
    name: 'unexpected_policy',
    command: 'all',
    mode: 'permissive',
    roles: ['PUBLIC'],
    appliesToConnectedRole: true,
    using: 'true',
    withCheck: null,
    dependencies: [],
    referenceSignals: {
      neonManagedFunctions: [],
      neonManagedRoles: [],
      neonManagedSchemas: [],
      referencesJwtClaims: false,
      authObjects: [],
    },
    ...overrides,
  };
}

describe('legacy inert-RLS baseline compatibility', () => {
  it('verifies the canonical state without compatibility normalization', () => {
    const result = verifyBaselineInventory(canonicalInventory());
    expect(result.state).toBe('canonical');
    expect(result.fingerprint.digest).toBe(loadApprovedBaselineFingerprint().digest);
  });

  it('normalizes only the exact all-table legacy inert-RLS state during baseline verification', () => {
    const inventory = legacyInertRlsInventory();
    expect(APPLICATION_TABLE_NAMES).toHaveLength(29);
    expect(inventory.tables).toHaveLength(29);
    expect(() => createBaselineFingerprint(inventory)).toThrow('requires RLS disabled');

    const result = verifyBaselineInventory(inventory);
    expect(result.state).toBe('legacy-inert-rls');
    expect(result.fingerprint.digest).toBe(loadApprovedBaselineFingerprint().digest);
    expect(inventory.tables.every((table) => table.rowSecurity)).toBe(true);
  });

  it('accepts insignificant function-body whitespace only in the legacy compatibility path', () => {
    const inventory = legacyInertRlsInventory();
    const original = requiredAt(inventory.functions, 0, 'function');
    const reformatted = original.definition.replace(/\n {2,}/g, (whitespace) =>
      whitespace.replace(/ +$/, '        '));
    expect(reformatted).not.toBe(original.definition);
    inventory.functions[0] = { ...original, definition: reformatted };

    expect(verifyBaselineInventory(inventory).state).toBe('legacy-inert-rls');

    const canonical = canonicalInventory();
    canonical.functions[0] = {
      ...requiredAt(canonical.functions, 0, 'function'),
      definition: reformatted,
    };
    expect(() => verifyBaselineInventory(canonical)).toThrow('fingerprint mismatch');
  });

  it('preserves the same narrow function normalization in release-boundary fingerprints', () => {
    const canonical = canonicalInventory();
    const legacy = legacyInertRlsInventory();
    const original = requiredAt(legacy.functions, 0, 'function');
    legacy.functions[0] = {
      ...original,
      definition: original.definition.replace(/\n {2,}/g, (whitespace) =>
        whitespace.replace(/ +$/, '        ')),
    };

    expect(createSchemaStateFingerprint(legacy, baselineMigration()).digest).toBe(
      createSchemaStateFingerprint(canonical, baselineMigration()).digest,
    );
  });

  it('normalizes the approved legacy state after later migrations retire baseline tables and functions', () => {
    const canonical = canonicalInventory();
    canonical.tables = canonical.tables.slice(0, -4);
    canonical.functions = canonical.functions.filter((fn) =>
      !['league_secretary_org_match_fn', 'users_org_change_revoke_secretaries_fn'].includes(fn.name)
    );
    canonical.triggers = canonical.triggers.filter((trigger) =>
      !['league_secretary_org_match_fn', 'users_org_change_revoke_secretaries_fn']
        .includes(trigger.functionName)
    );

    const legacy = structuredClone(canonical);
    legacy.tables = legacy.tables.map((table) => ({
      ...table,
      rowSecurity: true,
      connectedRoleRlsMode: 'bypass-bypassrls',
    }));
    legacy.functions.push(...loadApprovedBaselineFingerprint().structure.functions.filter((fn) =>
      ['league_secretary_org_match_fn', 'users_org_change_revoke_secretaries_fn'].includes(fn.name)
    ));
    legacy.extensions = [
      { name: 'pg_session_jwt', schema: 'public', version: '0.5.0', relocatable: false },
      { name: 'pgcrypto', schema: 'public', version: '1.3', relocatable: true },
    ];

    expect(createSchemaStateFingerprint(legacy, baselineMigration()).digest).toBe(
      createSchemaStateFingerprint(canonical, baselineMigration()).digest,
    );

    legacy.functions.push({
      ...requiredAt(loadApprovedBaselineFingerprint().structure.functions, 0, 'function'),
      name: 'show_db_tree',
    });
    expect(createSchemaStateFingerprint(legacy, baselineMigration()).digest).not.toBe(
      createSchemaStateFingerprint(canonical, baselineMigration()).digest,
    );
  });

  it('refuses mixed RLS among the surviving baseline tables at a release boundary', () => {
    const inventory = legacyInertRlsInventory();
    inventory.tables.pop();
    inventory.tables[0] = { ...requiredAt(inventory.tables, 0, 'table'), rowSecurity: false };
    expect(() => createSchemaStateFingerprint(inventory, baselineMigration())).toThrow(
      'unapproved legacy RLS configuration',
    );
  });

  it('excludes only approved provider-managed extension metadata from fingerprints', () => {
    const canonical = canonicalInventory();
    const withProviderExtensions = structuredClone(canonical);
    withProviderExtensions.extensions = [
      { name: 'pg_session_jwt', schema: 'public', version: '0.5.0', relocatable: false },
      { name: 'pgcrypto', schema: 'public', version: '1.3', relocatable: true },
    ];
    expect(createBaselineFingerprint(withProviderExtensions).digest).toBe(
      createBaselineFingerprint(canonical).digest,
    );

    const withUnknownExtension = structuredClone(withProviderExtensions);
    withUnknownExtension.extensions.push({
      name: 'function_only_extension',
      schema: 'public',
      version: '1.0',
      relocatable: true,
    });
    expect(createBaselineFingerprint(withUnknownExtension).digest).not.toBe(
      createBaselineFingerprint(canonical).digest,
    );
    expect(createSchemaStateFingerprint(withUnknownExtension, baselineMigration()).digest).not.toBe(
      createSchemaStateFingerprint(canonical, baselineMigration()).digest,
    );

    const withUnexpectedProviderVersion = structuredClone(withProviderExtensions);
    withUnexpectedProviderVersion.extensions[0] = {
      ...requiredAt(withUnexpectedProviderVersion.extensions, 0, 'extension'),
      version: '0.6.0',
    };
    expect(createSchemaStateFingerprint(withUnexpectedProviderVersion, baselineMigration()).digest)
      .not.toBe(createSchemaStateFingerprint(canonical, baselineMigration()).digest);
  });

  it('refuses function-body changes inside quoted content', () => {
    const inventory = legacyInertRlsInventory();
    const original = requiredAt(inventory.functions, 0, 'function');
    const changed = original.definition.replace(
      'league % has no organization_id',
      'league  % has no organization_id',
    );
    expect(changed).not.toBe(original.definition);
    inventory.functions[0] = { ...original, definition: changed };

    expect(() => verifyBaselineInventory(inventory)).toThrow('fingerprint mismatch');
  });

  it('refuses a single enabled table in an otherwise canonical inventory', () => {
    const inventory = canonicalInventory();
    inventory.tables[0] = { ...requiredAt(inventory.tables, 0, 'table'), rowSecurity: true };
    expect(() => verifyBaselineInventory(inventory)).toThrow('mixed RLS state');
  });

  it('refuses a single disabled table in the legacy state', () => {
    const inventory = legacyInertRlsInventory();
    inventory.tables[0] = { ...requiredAt(inventory.tables, 0, 'table'), rowSecurity: false };
    expect(() => verifyBaselineInventory(inventory)).toThrow('mixed RLS state');
  });

  it('refuses FORCE RLS', () => {
    const inventory = legacyInertRlsInventory();
    inventory.tables[0] = { ...requiredAt(inventory.tables, 0, 'table'), forceRowSecurity: true };
    expect(() => verifyBaselineInventory(inventory)).toThrow('FORCE RLS');
  });

  it.each(['permissive', 'restrictive'] as const)('refuses a %s policy', (mode) => {
    const inventory = legacyInertRlsInventory();
    inventory.policies = [policy({ mode })];
    expect(() => verifyBaselineInventory(inventory)).toThrow('requires zero policies');
  });

  it('refuses a provider-managed policy reference', () => {
    const inventory = legacyInertRlsInventory();
    inventory.policies = [policy({
      dependencies: [{
        kind: 'function',
        schema: 'neon_auth',
        name: 'auth_uid',
        identityArguments: '',
      }],
      referenceSignals: {
        neonManagedFunctions: ['neon_auth.auth_uid()'],
        neonManagedRoles: ['authenticated'],
        neonManagedSchemas: ['neon_auth'],
        referencesJwtClaims: true,
        authObjects: ['neon_auth.auth_uid'],
      },
    })];
    expect(() => verifyBaselineInventory(inventory)).toThrow('requires zero policies');
  });

  it('refuses any unexpected policy dependency', () => {
    const inventory = legacyInertRlsInventory();
    inventory.policies = [policy({
      dependencies: [{
        kind: 'relation',
        schema: 'public',
        name: 'users',
        identityArguments: null,
      }],
    })];
    expect(() => verifyBaselineInventory(inventory)).toThrow('policy dependencies');
  });

  it('refuses a role without BYPASSRLS', () => {
    const inventory = legacyInertRlsInventory();
    inventory.target.roleBypassRls = false;
    expect(() => verifyBaselineInventory(inventory)).toThrow('have BYPASSRLS');
  });

  it('refuses a role that does not own every application table', () => {
    const inventory = legacyInertRlsInventory();
    inventory.tables[0] = {
      ...requiredAt(inventory.tables, 0, 'table'),
      connectedRoleOwnsTable: false,
    };
    expect(() => verifyBaselineInventory(inventory)).toThrow('own every application table');
  });

  it('refuses superuser compatibility and inconsistent table bypass metadata', () => {
    const superuser = legacyInertRlsInventory();
    superuser.target.roleSuperuser = true;
    expect(() => verifyBaselineInventory(superuser)).toThrow('non-superuser');

    const inconsistentMode = legacyInertRlsInventory();
    inconsistentMode.tables[0] = {
      ...requiredAt(inconsistentMode.tables, 0, 'table'),
      connectedRoleRlsMode: 'bypass-owner',
    };
    expect(() => verifyBaselineInventory(inconsistentMode)).toThrow('exact BYPASSRLS table mode');
  });

  it('refuses missing or additional tables and every non-RLS structural difference', () => {
    const missingTable = legacyInertRlsInventory();
    missingTable.tables.pop();
    expect(() => verifyBaselineInventory(missingTable)).toThrow('missing or unexpected');

    const extraTable = legacyInertRlsInventory();
    extraTable.tables.push({
      ...requiredAt(extraTable.tables, 0, 'table'),
      name: 'unexpected_application_table',
    });
    expect(() => verifyBaselineInventory(extraTable)).toThrow('missing or unexpected');

    const changedIndex = legacyInertRlsInventory();
    const originalIndex = requiredAt(changedIndex.indexes, 0, 'index');
    changedIndex.indexes[0] = {
      ...originalIndex,
      definition: `${originalIndex.definition} NULLS NOT DISTINCT`,
    };
    expect(() => verifyBaselineInventory(changedIndex)).toThrow('fingerprint mismatch');
  });
});
