import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  APPROVED_INVARIANT_FUNCTION_NAMES,
  APPROVED_INVARIANT_TRIGGER_NAMES,
} from '../../shared/database-invariants';
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
  TableInfo,
  TriggerInfo,
  TypeInfo,
} from './db-schema-inventory';

export const BASELINE_FINGERPRINT_FORMAT_VERSION = 1 as const;
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

type StructuralTable = Pick<
  TableInfo,
  'schema' | 'name' | 'kind' | 'persistence' | 'rowSecurity' | 'forceRowSecurity'
>;
type StructuralColumn = Omit<ColumnInfo, 'ordinal'>;

export interface ApplicationSchemaStructure {
  scope: {
    schema: 'public';
    physicalColumnOrderExcluded: true;
    providerManagedObjectsExcluded: true;
    rlsExpected: 'disabled-with-no-policies';
  };
  tables: StructuralTable[];
  columns: StructuralColumn[];
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
    constraints: number;
    indexes: number;
    types: number;
    functions: number;
    triggers: number;
    policies: number;
  };
  structure: ApplicationSchemaStructure;
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
    APPROVED_INVARIANT_FUNCTION_NAMES,
    'public invariant functions',
  );
  exactNames(
    structure.triggers.map((trigger) => trigger.name),
    APPROVED_INVARIANT_TRIGGER_NAMES,
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
    counts: {
      tables: structure.tables.length,
      columns: structure.columns.length,
      constraints: structure.constraints.length,
      indexes: structure.indexes.length,
      types: structure.types.length,
      functions: structure.functions.length,
      triggers: structure.triggers.length,
      policies: structure.policies.length,
    },
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
    actual.baseline.tag !== approved.baseline.tag ||
    actual.baseline.hash !== approved.baseline.hash ||
    actual.baseline.createdAt !== approved.baseline.createdAt ||
    actual.digest !== approved.digest ||
    JSON.stringify(actual.structure) !== JSON.stringify(approved.structure)
  ) {
    throw new Error(
      `Application schema fingerprint mismatch (expected sha256:${approved.digest}; received sha256:${actual.digest}).`,
    );
  }
}

export function serializeBaselineFingerprint(fingerprint: BaselineFingerprint): string {
  return `${JSON.stringify(fingerprint, null, 2)}\n`;
}
