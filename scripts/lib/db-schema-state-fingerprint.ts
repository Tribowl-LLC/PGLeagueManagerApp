import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ActiveMigration } from './db-migration-assets';
import {
  APPLICATION_TABLE_NAMES,
  loadApprovedBaselineFingerprint,
} from './db-baseline-fingerprint';
import {
  collectDatabaseInventoryOnClient,
  type DatabaseInventory,
  type ExpectedDatabaseTarget,
} from './db-schema-inventory';
import type pg from 'pg';
import { functionDefinitionsDifferOnlyByInsignificantWhitespace } from './sql-definition-normalization';

export const SCHEMA_STATE_FINGERPRINT_FORMAT_VERSION = 2 as const;
export const SCHEMA_STATE_FINGERPRINT_DIRECTORY = resolve('migrations', 'schema-fingerprints');
const LEGACY_RETIRED_FUNCTION_NAMES = new Set([
  'league_secretary_org_match_fn',
  'users_org_change_revoke_secretaries_fn',
]);

interface SchemaStateStructure {
  scope: {
    schema: 'public';
    physicalColumnOrderExcluded: true;
    ownershipAndPrivilegesExcluded: true;
    providerManagedObjectsExcluded: true;
    legacyInertRlsCompatibility: 'normalized-when-approved';
  };
  tables: Array<Omit<DatabaseInventory['tables'][number],
    'owner' | 'connectedRoleOwnsTable' | 'connectedRolePrivileges' | 'connectedRoleRlsMode'>>;
  columns: Array<Omit<DatabaseInventory['columns'][number], 'ordinal'>>;
  nonTableRelations: DatabaseInventory['nonTableRelations'];
  rewriteRules: DatabaseInventory['rewriteRules'];
  unsupportedPublicObjects: DatabaseInventory['unsupportedPublicObjects'];
  extensions: DatabaseInventory['extensions'];
  sequences: Array<Omit<DatabaseInventory['sequences'][number], 'owner' | 'connectedRoleCanAlter'>>;
  constraints: DatabaseInventory['constraints'];
  indexes: DatabaseInventory['indexes'];
  types: DatabaseInventory['types'];
  functions: DatabaseInventory['functions'];
  triggers: DatabaseInventory['triggers'];
  policies: Array<Omit<DatabaseInventory['policies'][number], 'appliesToConnectedRole'>>;
}

export interface SchemaStateFingerprint {
  formatVersion: typeof SCHEMA_STATE_FINGERPRINT_FORMAT_VERSION;
  algorithm: 'sha256';
  migration: {
    tag: string;
    hash: string;
    createdAt: number;
  };
  digest: string;
  counts: Record<keyof Omit<SchemaStateStructure, 'scope'>, number>;
}

function sortObjects<T extends object>(values: T[]): T[] {
  return values.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), 'en'));
}

function normalizeLegacyInertRls(inventory: DatabaseInventory): {
  tables: DatabaseInventory['tables'];
  normalized: boolean;
} {
  const baselineNames = new Set<string>(APPLICATION_TABLE_NAMES);
  const baselineTables = inventory.tables.filter((table) =>
    table.schema === 'public' && baselineNames.has(table.name),
  );
  const enabled = baselineTables.filter((table) => table.rowSecurity);
  if (enabled.length === 0) return { tables: inventory.tables, normalized: false };
  if (
    enabled.length !== baselineTables.length ||
    baselineTables.some((table) => table?.forceRowSecurity) ||
    inventory.target.roleSuperuser ||
    !inventory.target.roleBypassRls ||
    baselineTables.some((table) =>
      !table.connectedRoleOwnsTable || table.connectedRoleRlsMode !== 'bypass-bypassrls'
    ) ||
    inventory.policies.some((policy) =>
      policy.schema === 'public' && APPLICATION_TABLE_NAMES.includes(
        policy.table as (typeof APPLICATION_TABLE_NAMES)[number],
      )
    )
  ) {
    throw new Error('Schema-state verification refuses an unapproved legacy RLS configuration.');
  }
  return {
    normalized: true,
    tables: inventory.tables.map((table) =>
      table.schema === 'public' && baselineNames.has(table.name)
        ? { ...table, rowSecurity: false }
        : table,
    ),
  };
}

function schemaStateStructure(inventory: DatabaseInventory): SchemaStateStructure {
  if (inventory.unsupportedPublicObjects.length > 0) {
    throw new Error(
      `Schema-state verification refuses unsupported public catalog objects: ${inventory.unsupportedPublicObjects
        .map((object) => `${object.kind}:${object.identity}`).join(', ')}.`,
    );
  }
  const normalized = normalizeLegacyInertRls(inventory);
  const approvedBaselineFunctions = new Map(
    loadApprovedBaselineFingerprint().structure.functions.map((fn) => [
      `${fn.schema}.${fn.name}(${fn.identityArguments})`,
      fn,
    ]),
  );
  const triggerFunctions = new Set(inventory.triggers.map((trigger) =>
    `${trigger.functionSchema}.${trigger.functionName}(${trigger.functionIdentityArguments})`,
  ));
  return {
    scope: {
      schema: 'public',
      physicalColumnOrderExcluded: true,
      ownershipAndPrivilegesExcluded: true,
      providerManagedObjectsExcluded: true,
      legacyInertRlsCompatibility: 'normalized-when-approved',
    },
    tables: sortObjects(normalized.tables
      .filter((table) => table.schema === 'public')
      .map(({ owner: _owner, connectedRoleOwnsTable: _owns, connectedRolePrivileges: _privileges,
        connectedRoleRlsMode: _rlsMode, ...table }) => table)),
    columns: sortObjects(inventory.columns
      .filter((column) => column.schema === 'public')
      .map(({ ordinal: _ordinal, ...column }) => column)),
    nonTableRelations: sortObjects(inventory.nonTableRelations
      .filter((relation) => relation.schema === 'public')),
    rewriteRules: sortObjects(inventory.rewriteRules
      .filter((rule) => rule.schema === 'public')),
    unsupportedPublicObjects: [],
    // Extension installation/version is provider-managed metadata. Extension-owned
    // catalog objects are excluded independently by the inventory collectors.
    extensions: [],
    sequences: sortObjects(inventory.sequences
      .filter((sequence) => sequence.schema === 'public')
      .map(({ owner: _owner, connectedRoleCanAlter: _canAlter, ...sequence }) => sequence)),
    constraints: sortObjects(inventory.constraints.filter((constraint) => constraint.schema === 'public')),
    indexes: sortObjects(inventory.indexes.filter((index) => index.schema === 'public')),
    types: sortObjects(inventory.types.filter((type) => type.schema === 'public')),
    functions: sortObjects(inventory.functions
      .filter((fn) => fn.schema === 'public')
      .flatMap((fn) => {
        if (!normalized.normalized) return fn;
        const identity = `${fn.schema}.${fn.name}(${fn.identityArguments})`;
        const expected = approvedBaselineFunctions.get(identity);
        const approvedDefinition = expected && functionDefinitionsDifferOnlyByInsignificantWhitespace(
          fn.definition,
          expected.definition,
        );
        if (
          LEGACY_RETIRED_FUNCTION_NAMES.has(fn.name) &&
          approvedDefinition &&
          !triggerFunctions.has(identity)
        ) {
          return [];
        }
        return [approvedDefinition ? { ...fn, definition: expected.definition } : fn];
      })),
    triggers: sortObjects(inventory.triggers.filter((trigger) => trigger.schema === 'public')),
    policies: sortObjects(inventory.policies
      .filter((policy) => policy.schema === 'public')
      .map(({ appliesToConnectedRole: _applies, ...policy }) => policy)),
  };
}

function structureCounts(structure: SchemaStateStructure): SchemaStateFingerprint['counts'] {
  return {
    tables: structure.tables.length,
    columns: structure.columns.length,
    nonTableRelations: structure.nonTableRelations.length,
    rewriteRules: structure.rewriteRules.length,
    unsupportedPublicObjects: structure.unsupportedPublicObjects.length,
    extensions: structure.extensions.length,
    sequences: structure.sequences.length,
    constraints: structure.constraints.length,
    indexes: structure.indexes.length,
    types: structure.types.length,
    functions: structure.functions.length,
    triggers: structure.triggers.length,
    policies: structure.policies.length,
  };
}

export function createSchemaStateFingerprint(
  inventory: DatabaseInventory,
  migration: ActiveMigration,
): SchemaStateFingerprint {
  const structure = schemaStateStructure(inventory);
  return {
    formatVersion: SCHEMA_STATE_FINGERPRINT_FORMAT_VERSION,
    algorithm: 'sha256',
    migration: { tag: migration.tag, hash: migration.hash, createdAt: migration.createdAt },
    digest: createHash('sha256').update(JSON.stringify(structure)).digest('hex'),
    counts: structureCounts(structure),
  };
}

function isSchemaStateFingerprint(value: unknown): value is SchemaStateFingerprint {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SchemaStateFingerprint>;
  return candidate.formatVersion === SCHEMA_STATE_FINGERPRINT_FORMAT_VERSION &&
    candidate.algorithm === 'sha256' &&
    typeof candidate.digest === 'string' && /^[0-9a-f]{64}$/.test(candidate.digest) &&
    typeof candidate.migration === 'object' && candidate.migration !== null &&
    typeof candidate.counts === 'object' && candidate.counts !== null;
}

export function schemaStateFingerprintPath(
  migration: ActiveMigration,
  directory = SCHEMA_STATE_FINGERPRINT_DIRECTORY,
): string {
  return join(directory, `${migration.tag}.json`);
}

export function loadApprovedSchemaStateFingerprint(
  migration: ActiveMigration,
  directory = SCHEMA_STATE_FINGERPRINT_DIRECTORY,
): SchemaStateFingerprint {
  const path = schemaStateFingerprintPath(migration, directory);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not load approved schema-state fingerprint for ${migration.tag}: ${reason}`);
  }
  if (!isSchemaStateFingerprint(parsed)) {
    throw new Error(`Approved schema-state fingerprint for ${migration.tag} is invalid.`);
  }
  if (
    parsed.migration.tag !== migration.tag ||
    parsed.migration.hash !== migration.hash ||
    parsed.migration.createdAt !== migration.createdAt
  ) {
    throw new Error(`Approved schema-state fingerprint identity does not match ${migration.tag}.`);
  }
  return parsed;
}

export function assertApprovedSchemaStateFingerprint(
  actual: SchemaStateFingerprint,
  approved: SchemaStateFingerprint,
): void {
  if (
    actual.digest !== approved.digest ||
    JSON.stringify(actual.counts) !== JSON.stringify(approved.counts)
  ) {
    throw new Error(
      `Application schema-state fingerprint mismatch at ${approved.migration.tag} ` +
      `(expected sha256:${approved.digest}; received sha256:${actual.digest}).`,
    );
  }
}

export async function verifyApprovedSchemaStateOnClient(
  client: pg.Client,
  connectionString: string,
  migration: ActiveMigration,
  directory = SCHEMA_STATE_FINGERPRINT_DIRECTORY,
  expectedTarget?: ExpectedDatabaseTarget,
): Promise<SchemaStateFingerprint> {
  const approved = loadApprovedSchemaStateFingerprint(migration, directory);
  const inventory = await collectDatabaseInventoryOnClient(client, connectionString, { expectedTarget });
  const actual = createSchemaStateFingerprint(inventory, migration);
  assertApprovedSchemaStateFingerprint(actual, approved);
  return actual;
}
