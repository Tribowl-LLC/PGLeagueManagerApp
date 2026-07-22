import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  baselineMigration,
  EXPECTED_BASELINE_COLUMN_COUNT,
  EXPECTED_BASELINE_TABLE_COUNT,
  type ActiveMigration,
} from './db-migration-assets';
import type {
  ColumnInfo,
  ConstraintInfo,
  DatabaseInventory,
  FunctionInfo,
  IndexInfo,
  PolicyInfo,
  SequenceInfo,
  TableInfo,
  TriggerInfo,
  TypeInfo,
} from './db-schema-inventory';

// The adoption fingerprint describes immutable migration 0000, not the
// current post-migration schema. Later migrations may retire baseline objects.
const BASELINE_INVARIANT_FUNCTION_NAMES = [
  'league_secretary_org_match_fn',
  'users_org_change_revoke_secretaries_fn',
  'users_role_org_required_fn',
] as const;

const BASELINE_INVARIANT_TRIGGER_NAMES = [
  'league_secretaries_org_match',
  'users_org_change_revoke_secretaries',
  'users_role_org_required',
] as const;
import { functionDefinitionsDifferOnlyByInsignificantWhitespace } from './sql-definition-normalization';

export const BASELINE_FINGERPRINT_FORMAT_VERSION = 2 as const;
export const BASELINE_FINGERPRINT_PATH = resolve('migrations', 'baseline-fingerprint.json');

export const APPLICATION_TABLE_NAMES = [
  'admin_email_change_audits',
  'admin_password_reset_audits',
  'admin_profile_edit_audits',
  'admin_role_change_audits',
  'alerter_state',
  'apple_pay_job_items',
  'apple_pay_jobs',
  'bowler_leagues',
  'bowler_payment_links',
  'bowlers',
  'deletion_requests',
  'email_change_requests',
  'email_templates',
  'games',
  'league_registration_questions',
  'league_registrations',
  'league_secretaries',
  'league_secretary_audits',
  'leagues',
  'locations',
  'organizations',
  'orphan_cleanup_audits',
  'payment_schedules',
  'payments',
  'rate_limit_buckets',
  'scores',
  'session',
  'teams',
  'users',
] as const;

export const APPLICATION_SEQUENCE_NAMES = APPLICATION_TABLE_NAMES
  .filter((name) => !['alerter_state', 'rate_limit_buckets', 'session'].includes(name))
  .map((name) => `${name}_id_seq`);

type StructuralTable = Pick<
  TableInfo,
  'schema' | 'name' | 'kind' | 'persistence' | 'rowSecurity' | 'forceRowSecurity'
>;
type StructuralColumn = Omit<ColumnInfo, 'ordinal'>;
type StructuralSequence = Omit<SequenceInfo, 'owner' | 'connectedRoleCanAlter'>;

export interface ApplicationSchemaStructure {
  scope: {
    schema: 'public';
    physicalColumnOrderExcluded: true;
    providerManagedObjectsExcluded: true;
    rlsExpected: 'disabled-with-no-policies';
  };
  tables: StructuralTable[];
  columns: StructuralColumn[];
  sequences: StructuralSequence[];
  constraints: ConstraintInfo[];
  indexes: IndexInfo[];
  types: TypeInfo[];
  functions: FunctionInfo[];
  triggers: TriggerInfo[];
  policies: PolicyInfo[];
}

export interface BaselineFingerprint {
  formatVersion: typeof BASELINE_FINGERPRINT_FORMAT_VERSION;
  algorithm: 'sha256';
  baseline: {
    tag: string;
    hash: string;
    createdAt: number;
  };
  digest: string;
  counts: {
    tables: number;
    columns: number;
    sequences: number;
    constraints: number;
    indexes: number;
    types: number;
    functions: number;
    triggers: number;
    policies: number;
  };
  structure: ApplicationSchemaStructure;
}

export type BaselineVerificationState = 'canonical' | 'legacy-inert-rls';

export interface BaselineVerificationResult {
  state: BaselineVerificationState;
  fingerprint: BaselineFingerprint;
}

function compareKey(left: Record<string, unknown>, right: Record<string, unknown>): number {
  const leftKey = [left.schema, left.table, left.name, left.identityArguments]
    .filter((value) => typeof value === 'string')
    .join('\u0000');
  const rightKey = [right.schema, right.table, right.name, right.identityArguments]
    .filter((value) => typeof value === 'string')
    .join('\u0000');
  return leftKey.localeCompare(rightKey, 'en');
}

function sortObjects<T extends object>(values: T[]): T[] {
  return values.sort((left, right) =>
    compareKey(left as Record<string, unknown>, right as Record<string, unknown>),
  );
}

function exactNames(actual: readonly string[], expected: readonly string[], label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Application fingerprint inventory has missing or unexpected ${label}.`);
  }
}

function assertCompleteStructure(structure: ApplicationSchemaStructure): void {
  exactNames(
    structure.tables.map((table) => table.name),
    APPLICATION_TABLE_NAMES,
    'public application tables',
  );
  if (structure.tables.length !== EXPECTED_BASELINE_TABLE_COUNT) {
    throw new Error(`Application fingerprint must contain ${EXPECTED_BASELINE_TABLE_COUNT} tables.`);
  }
  if (structure.columns.length !== EXPECTED_BASELINE_COLUMN_COUNT) {
    throw new Error(`Application fingerprint must contain ${EXPECTED_BASELINE_COLUMN_COUNT} columns.`);
  }
  if (structure.columns.some((column) => /cardpointe/i.test(column.name))) {
    throw new Error('Application fingerprint contains retired CardPointe columns.');
  }
  exactNames(
    structure.sequences.map((sequence) => sequence.name),
    APPLICATION_SEQUENCE_NAMES,
    'public application sequences',
  );
  if (structure.sequences.length !== 26) {
    throw new Error('Application fingerprint must contain 26 application-owned serial sequences.');
  }
  for (const sequence of structure.sequences) {
    const expectedTable = sequence.name.replace(/_id_seq$/, '');
    const column = structure.columns.find((candidate) =>
      candidate.schema === 'public' && candidate.table === expectedTable && candidate.name === 'id',
    );
    if (
      sequence.schema !== 'public' || sequence.persistence !== 'permanent' ||
      sequence.dataType !== 'integer' || sequence.start !== '1' ||
      sequence.increment !== '1' || sequence.minimum !== '1' || sequence.maximum !== '2147483647' ||
      sequence.cache !== '1' || sequence.cycle || sequence.ownedBySchema !== 'public' ||
      sequence.ownedByTable !== expectedTable || sequence.ownedByColumn !== 'id' ||
      sequence.ownershipDependency !== 'auto' || !sequence.defaultReferencesOwnedSequence ||
      !column || sequence.columnDefault !== column.default
    ) {
      throw new Error(`Application fingerprint contains an unexpected sequence definition: ${sequence.name}.`);
    }
  }
  if (structure.tables.some((table) => table.rowSecurity || table.forceRowSecurity)) {
    throw new Error('Application fingerprint requires RLS disabled on every application table.');
  }
  if (structure.policies.length > 0) {
    throw new Error('Application fingerprint requires no RLS policies on application tables.');
  }
  exactNames(
    structure.types.map((type) => type.name),
    ['user_role'],
    'public application types',
  );
  const roleType = structure.types[0];
  if (
    roleType?.kind !== 'enum' ||
    JSON.stringify(roleType.enumLabels) !== JSON.stringify(['system_admin', 'org_admin', 'user'])
  ) {
    throw new Error('Application fingerprint contains an unexpected public.user_role definition.');
  }
  exactNames(
    structure.functions.map((fn) => fn.name),
    BASELINE_INVARIANT_FUNCTION_NAMES,
    'public invariant functions',
  );
  exactNames(
    structure.triggers.map((trigger) => trigger.name),
    BASELINE_INVARIANT_TRIGGER_NAMES,
    'public invariant triggers',
  );
  const partialIndex = structure.indexes.find((index) =>
    index.table === 'organizations' && index.name === 'organization_subdomain_idx',
  );
  if (
    !partialIndex ||
    !partialIndex.unique ||
    partialIndex.primary ||
    partialIndex.predicate?.replaceAll(/[()\s]/g, '').toLowerCase() !== 'subdomainisnotnull'
  ) {
    throw new Error('Application fingerprint is missing the approved organization_subdomain_idx predicate.');
  }
}

export function applicationStructureFromInventory(
  inventory: DatabaseInventory,
): ApplicationSchemaStructure {
  const tables = sortObjects(
    inventory.tables
      .filter((table) => table.schema === 'public')
      .map((table): StructuralTable => ({
        schema: table.schema,
        name: table.name,
        kind: table.kind,
        persistence: table.persistence,
        rowSecurity: table.rowSecurity,
        forceRowSecurity: table.forceRowSecurity,
      })),
  );
  const structure: ApplicationSchemaStructure = {
    scope: {
      schema: 'public',
      physicalColumnOrderExcluded: true,
      providerManagedObjectsExcluded: true,
      rlsExpected: 'disabled-with-no-policies',
    },
    tables,
    columns: sortObjects(
      inventory.columns
        .filter((column) => column.schema === 'public')
        .map(({ ordinal: _ordinal, ...column }) => column),
    ),
    sequences: sortObjects(
      inventory.sequences
        .filter((sequence) =>
          sequence.ownedBySchema === 'public' &&
          sequence.ownedByTable !== null &&
          APPLICATION_TABLE_NAMES.includes(sequence.ownedByTable as (typeof APPLICATION_TABLE_NAMES)[number]),
        )
        .map(({ owner: _owner, connectedRoleCanAlter: _canAlter, ...sequence }) => sequence),
    ),
    constraints: sortObjects(inventory.constraints.filter((constraint) => constraint.schema === 'public')),
    indexes: sortObjects(inventory.indexes.filter((index) => index.schema === 'public')),
    types: sortObjects(inventory.types.filter((type) => type.schema === 'public')),
    functions: sortObjects(inventory.functions.filter((fn) => fn.schema === 'public')),
    triggers: sortObjects(inventory.triggers.filter((trigger) => trigger.schema === 'public')),
    policies: sortObjects(inventory.policies.filter((policy) => policy.schema === 'public')),
  };
  assertCompleteStructure(structure);
  return structure;
}

function digestStructure(structure: ApplicationSchemaStructure): string {
  return createHash('sha256').update(JSON.stringify(structure)).digest('hex');
}

function structureCounts(structure: ApplicationSchemaStructure): BaselineFingerprint['counts'] {
  return {
    tables: structure.tables.length,
    columns: structure.columns.length,
    sequences: structure.sequences.length,
    constraints: structure.constraints.length,
    indexes: structure.indexes.length,
    types: structure.types.length,
    functions: structure.functions.length,
    triggers: structure.triggers.length,
    policies: structure.policies.length,
  };
}

export function createBaselineFingerprint(
  inventory: DatabaseInventory,
  baseline: ActiveMigration = baselineMigration(),
): BaselineFingerprint {
  const structure = applicationStructureFromInventory(inventory);
  return {
    formatVersion: BASELINE_FINGERPRINT_FORMAT_VERSION,
    algorithm: 'sha256',
    baseline: {
      tag: baseline.tag,
      hash: baseline.hash,
      createdAt: baseline.createdAt,
    },
    digest: digestStructure(structure),
    counts: structureCounts(structure),
    structure,
  };
}

function isBaselineFingerprint(value: unknown): value is BaselineFingerprint {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<BaselineFingerprint>;
  return candidate.formatVersion === BASELINE_FINGERPRINT_FORMAT_VERSION &&
    candidate.algorithm === 'sha256' &&
    typeof candidate.digest === 'string' &&
    typeof candidate.baseline === 'object' && candidate.baseline !== null &&
    typeof candidate.structure === 'object' && candidate.structure !== null;
}

export function loadApprovedBaselineFingerprint(
  path = BASELINE_FINGERPRINT_PATH,
  baseline: ActiveMigration = baselineMigration(),
): BaselineFingerprint {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!isBaselineFingerprint(parsed)) throw new Error('Approved baseline fingerprint file is invalid.');
  if (
    parsed.baseline.tag !== baseline.tag ||
    parsed.baseline.hash !== baseline.hash ||
    parsed.baseline.createdAt !== baseline.createdAt
  ) {
    throw new Error('Approved baseline fingerprint identity does not match the active baseline migration.');
  }
  assertCompleteStructure(parsed.structure);
  if (JSON.stringify(parsed.counts) !== JSON.stringify(structureCounts(parsed.structure))) {
    throw new Error('Approved baseline fingerprint counts do not match its structural inventory.');
  }
  if (parsed.digest !== digestStructure(parsed.structure)) {
    throw new Error('Approved baseline fingerprint digest does not match its structural inventory.');
  }
  return parsed;
}

export function assertApprovedBaselineFingerprint(
  actual: BaselineFingerprint,
  approved: BaselineFingerprint = loadApprovedBaselineFingerprint(),
): void {
  if (
    actual.formatVersion !== approved.formatVersion ||
    actual.algorithm !== approved.algorithm ||
    actual.baseline.tag !== approved.baseline.tag ||
    actual.baseline.hash !== approved.baseline.hash ||
    actual.baseline.createdAt !== approved.baseline.createdAt ||
    actual.digest !== approved.digest ||
    JSON.stringify(actual.counts) !== JSON.stringify(approved.counts) ||
    JSON.stringify(actual.structure) !== JSON.stringify(approved.structure)
  ) {
    throw new Error(
      `Application schema fingerprint mismatch (expected sha256:${approved.digest}; received sha256:${actual.digest}).`,
    );
  }
}

function classifyBaselineVerificationState(inventory: DatabaseInventory): BaselineVerificationState {
  const tables = sortObjects(inventory.tables.filter((table) => table.schema === 'public'));
  exactNames(
    tables.map((table) => table.name),
    APPLICATION_TABLE_NAMES,
    'public application tables',
  );
  if (tables.some((table) => table.forceRowSecurity)) {
    throw new Error('Application baseline verification refuses FORCE RLS on application tables.');
  }

  const enabledCount = tables.filter((table) => table.rowSecurity).length;
  if (enabledCount === 0) return 'canonical';
  if (enabledCount !== APPLICATION_TABLE_NAMES.length) {
    throw new Error('Application baseline verification refuses mixed RLS state across application tables.');
  }

  const applicationPolicies = inventory.policies.filter((policy) => policy.schema === 'public');
  if (applicationPolicies.length > 0) {
    throw new Error('Legacy inert-RLS compatibility requires zero policies and policy dependencies.');
  }
  if (inventory.target.roleSuperuser) {
    throw new Error('Legacy inert-RLS compatibility requires a non-superuser application role.');
  }
  if (!inventory.target.roleBypassRls) {
    throw new Error('Legacy inert-RLS compatibility requires the application role to have BYPASSRLS.');
  }
  if (tables.some((table) => !table.connectedRoleOwnsTable)) {
    throw new Error('Legacy inert-RLS compatibility requires the application role to own every application table.');
  }
  if (tables.some((table) => table.connectedRoleRlsMode !== 'bypass-bypassrls')) {
    throw new Error('Legacy inert-RLS compatibility requires the exact BYPASSRLS table mode.');
  }
  return 'legacy-inert-rls';
}

/**
 * Verifies either the canonical baseline or the one approved legacy Neon
 * state. The compatibility normalization is deliberately confined to this
 * verification path: raw inventories and ordinary fingerprint generation
 * continue to preserve and reject enabled RLS flags.
 */
export function verifyBaselineInventory(
  inventory: DatabaseInventory,
  baseline: ActiveMigration = baselineMigration(),
  approved: BaselineFingerprint = loadApprovedBaselineFingerprint(undefined, baseline),
): BaselineVerificationResult {
  const state = classifyBaselineVerificationState(inventory);
  const approvedFunctions = new Map(
    approved.structure.functions.map((fn) => [
      `${fn.schema}.${fn.name}(${fn.identityArguments})`,
      fn,
    ]),
  );
  const verificationInventory = state === 'canonical'
    ? inventory
    : {
        ...inventory,
        tables: inventory.tables.map((table) =>
          table.schema === 'public' &&
          APPLICATION_TABLE_NAMES.includes(table.name as (typeof APPLICATION_TABLE_NAMES)[number])
            ? { ...table, rowSecurity: false }
            : table,
        ),
        functions: inventory.functions.map((fn) => {
          const expected = approvedFunctions.get(
            `${fn.schema}.${fn.name}(${fn.identityArguments})`,
          );
          return expected && functionDefinitionsDifferOnlyByInsignificantWhitespace(
            fn.definition,
            expected.definition,
          )
            ? { ...fn, definition: expected.definition }
            : fn;
        }),
      };
  const fingerprint = createBaselineFingerprint(verificationInventory, baseline);
  assertApprovedBaselineFingerprint(fingerprint, approved);
  return { state, fingerprint };
}

export function serializeBaselineFingerprint(fingerprint: BaselineFingerprint): string {
  return `${JSON.stringify(fingerprint, null, 2)}\n`;
}
