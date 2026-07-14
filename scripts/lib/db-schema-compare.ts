import {
  DB_INVENTORY_FORMAT_VERSION,
  type DatabaseInventory,
  type DatabaseTarget,
  type MigrationJournalInfo,
} from './db-schema-inventory';
import { normalizeSqlDefinition } from './sql-definition-normalization';

export type ComparisonCategory =
  | 'environment'
  | 'schemas'
  | 'tables'
  | 'columns'
  | 'constraints'
  | 'indexes'
  | 'types'
  | 'functions'
  | 'triggers'
  | 'extensions'
  | 'migrationJournals';

export interface ChangedObject {
  key: string;
  fields: string[];
}

export interface CategoryDifference {
  missingFromRight: string[];
  extraInRight: string[];
  changed: ChangedObject[];
}

export interface InventoryComparison {
  formatVersion: 1;
  leftTarget: DatabaseTarget;
  rightTarget: DatabaseTarget;
  hasDifferences: boolean;
  differenceCount: number;
  categories: Record<ComparisonCategory, CategoryDifference>;
}

type InventoryObject = Record<string, unknown>;

interface CategorySpec {
  name: ComparisonCategory;
  values: (inventory: DatabaseInventory) => InventoryObject[];
  key: (value: InventoryObject) => string;
  normalize?: (value: InventoryObject) => InventoryObject;
}

function asInventoryObjects(values: readonly object[]): InventoryObject[] {
  return values.map((value) => ({ ...value }));
}

function objectKey(...fields: string[]): (value: InventoryObject) => string {
  return (value) => fields.map((field) => String(value[field] ?? '')).join('.');
}

function normalizeJournal(value: InventoryObject): InventoryObject {
  if (typeof value.key === 'string') return value;
  const schema = value.schema;
  const table = value.table;
  const columns = value.columns;
  const entries = value.entries;
  if (
    typeof schema !== 'string' ||
    typeof table !== 'string' ||
    !Array.isArray(columns) ||
    !columns.every((column) => typeof column === 'string') ||
    !Array.isArray(entries)
  ) {
    throw new Error('Migration journal inventory has an invalid shape.');
  }
  const normalizedEntries = entries.map((entry): MigrationJournalInfo['entries'][number] => {
    if (entry === null || typeof entry !== 'object') {
      throw new Error('Migration journal entry is not an object.');
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.id !== 'string' ||
      typeof record.hash !== 'string' ||
      typeof record.createdAt !== 'string'
    ) {
      throw new Error('Migration journal entry has an invalid shape.');
    }
    return { id: record.id, hash: record.hash, createdAt: record.createdAt };
  });
  return {
    schema,
    table,
    columns: [...columns].sort((a, b) => a.localeCompare(b, 'en')),
    entries: normalizedEntries.sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt, 'en') ||
      a.id.localeCompare(b.id, 'en') ||
      a.hash.localeCompare(b.hash, 'en'),
    ),
  };
}

function normalizeDefinitionFields(value: InventoryObject): InventoryObject {
  const normalized = { ...value };
  for (const field of ['definition', 'predicate', 'default']) {
    if (typeof normalized[field] === 'string') {
      normalized[field] = normalizeSqlDefinition(normalized[field]);
    }
  }
  if (
    Array.isArray(normalized.constraints) &&
    normalized.constraints.every((constraint) => typeof constraint === 'string')
  ) {
    normalized.constraints = normalized.constraints.map((constraint) => normalizeSqlDefinition(constraint));
  }
  return normalized;
}

const CATEGORY_SPECS: CategorySpec[] = [
  {
    name: 'environment',
    values: (inventory) => [{
      key: 'postgresql',
      serverVersion: inventory.target.serverVersion,
      serverVersionNumber: inventory.target.serverVersionNumber,
    }],
    key: objectKey('key'),
  },
  { name: 'schemas', values: (inventory) => asInventoryObjects(inventory.schemas), key: objectKey('name') },
  { name: 'tables', values: (inventory) => asInventoryObjects(inventory.tables), key: objectKey('schema', 'name') },
  { name: 'columns', values: (inventory) => asInventoryObjects(inventory.columns), key: objectKey('schema', 'table', 'name'), normalize: normalizeDefinitionFields },
  { name: 'constraints', values: (inventory) => asInventoryObjects(inventory.constraints), key: objectKey('schema', 'table', 'name'), normalize: normalizeDefinitionFields },
  { name: 'indexes', values: (inventory) => asInventoryObjects(inventory.indexes), key: objectKey('schema', 'table', 'name'), normalize: normalizeDefinitionFields },
  { name: 'types', values: (inventory) => asInventoryObjects(inventory.types), key: objectKey('schema', 'name'), normalize: normalizeDefinitionFields },
  {
    name: 'functions',
    values: (inventory) => asInventoryObjects(inventory.functions),
    key: (value) => `${String(value.schema)}.${String(value.name)}(${String(value.identityArguments)})`,
    normalize: normalizeDefinitionFields,
  },
  { name: 'triggers', values: (inventory) => asInventoryObjects(inventory.triggers), key: objectKey('schema', 'table', 'name'), normalize: normalizeDefinitionFields },
  { name: 'extensions', values: (inventory) => asInventoryObjects(inventory.extensions), key: objectKey('name') },
  {
    name: 'migrationJournals',
    values: (inventory) => [
      { key: 'state', exists: inventory.migrationJournalExists },
      {
        key: 'inspection',
        approvedRelation: inventory.migrationJournalInspection.approvedRelation,
        relationDiscovered: inventory.migrationJournalInspection.relationDiscovered,
        columnsInspected: inventory.migrationJournalInspection.columnsInspected,
        rowsCollected: inventory.migrationJournalInspection.rowsCollected,
      },
      ...inventory.migrationJournalDiscovery.map((relation) => ({
        key: `discovery:${relation.schema}.${relation.table}`,
        ...relation,
      })),
      ...asInventoryObjects(inventory.migrationJournals),
    ],
    key: (value) => typeof value.key === 'string' ? value.key : objectKey('schema', 'table')(value),
    normalize: normalizeJournal,
  },
];

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort((a, b) => a.localeCompare(b, 'en'))) {
      sorted[key] = canonicalize(record[key]);
    }
    return sorted;
  }
  return value;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function changedFields(left: InventoryObject, right: InventoryObject): string[] {
  const fields = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...fields]
    .filter((field) => !valuesEqual(left[field], right[field]))
    .sort((a, b) => a.localeCompare(b, 'en'));
}

function compareCategory(
  spec: CategorySpec,
  left: DatabaseInventory,
  right: DatabaseInventory,
): CategoryDifference {
  const normalize = spec.normalize ?? ((value: InventoryObject) => value);
  const leftMap = new Map<string, InventoryObject>();
  const rightMap = new Map<string, InventoryObject>();

  for (const raw of spec.values(left)) {
    const value = normalize(raw);
    const key = spec.key(value);
    if (leftMap.has(key)) throw new Error(`Duplicate ${spec.name} key in left inventory: ${key}`);
    leftMap.set(key, value);
  }
  for (const raw of spec.values(right)) {
    const value = normalize(raw);
    const key = spec.key(value);
    if (rightMap.has(key)) throw new Error(`Duplicate ${spec.name} key in right inventory: ${key}`);
    rightMap.set(key, value);
  }

  const missingFromRight = [...leftMap.keys()]
    .filter((key) => !rightMap.has(key))
    .sort((a, b) => a.localeCompare(b, 'en'));
  const extraInRight = [...rightMap.keys()]
    .filter((key) => !leftMap.has(key))
    .sort((a, b) => a.localeCompare(b, 'en'));
  const changed = [...leftMap.keys()]
    .filter((key) => rightMap.has(key))
    .map((key) => {
      const leftValue = leftMap.get(key);
      const rightValue = rightMap.get(key);
      if (!leftValue || !rightValue || valuesEqual(leftValue, rightValue)) return null;
      return { key, fields: changedFields(leftValue, rightValue) };
    })
    .filter((value): value is ChangedObject => value !== null)
    .sort((a, b) => a.key.localeCompare(b.key, 'en'));

  return { missingFromRight, extraInRight, changed };
}

export function assertDatabaseInventory(value: unknown, source: string): asserts value is DatabaseInventory {
  if (value === null || typeof value !== 'object') {
    throw new Error(`${source} is not a JSON object.`);
  }
  const record = value as Record<string, unknown>;
  if (record.formatVersion !== DB_INVENTORY_FORMAT_VERSION) {
    throw new Error(
      `${source} uses unsupported inventory format ${String(record.formatVersion)}; expected ${DB_INVENTORY_FORMAT_VERSION}.`,
    );
  }
  if (record.target === null || typeof record.target !== 'object') {
    throw new Error(`${source} is missing target metadata.`);
  }
  if (typeof record.migrationJournalExists !== 'boolean') {
    throw new Error(`${source} is missing the migrationJournalExists flag.`);
  }
  if (!Array.isArray(record.migrationJournalDiscovery)) {
    throw new Error(`${source} is missing migration journal discovery metadata.`);
  }
  if (record.migrationJournalInspection === null || typeof record.migrationJournalInspection !== 'object') {
    throw new Error(`${source} is missing migration journal inspection metadata.`);
  }
  for (const field of [
    'schemas',
    'tables',
    'columns',
    'constraints',
    'indexes',
    'types',
    'functions',
    'triggers',
    'extensions',
    'migrationJournals',
  ]) {
    if (!Array.isArray(record[field])) throw new Error(`${source} is missing the ${field} inventory array.`);
  }
}

export function compareDatabaseInventories(
  left: DatabaseInventory,
  right: DatabaseInventory,
): InventoryComparison {
  const emptyDifference = (): CategoryDifference => ({
    missingFromRight: [],
    extraInRight: [],
    changed: [],
  });
  const categories: Record<ComparisonCategory, CategoryDifference> = {
    environment: emptyDifference(),
    schemas: emptyDifference(),
    tables: emptyDifference(),
    columns: emptyDifference(),
    constraints: emptyDifference(),
    indexes: emptyDifference(),
    types: emptyDifference(),
    functions: emptyDifference(),
    triggers: emptyDifference(),
    extensions: emptyDifference(),
    migrationJournals: emptyDifference(),
  };
  let differenceCount = 0;
  for (const spec of CATEGORY_SPECS) {
    const difference = compareCategory(spec, left, right);
    categories[spec.name] = difference;
    differenceCount +=
      difference.missingFromRight.length + difference.extraInRight.length + difference.changed.length;
  }
  return {
    formatVersion: 1,
    leftTarget: left.target,
    rightTarget: right.target,
    hasDifferences: differenceCount > 0,
    differenceCount,
    categories,
  };
}

export function serializeInventoryComparison(comparison: InventoryComparison): string {
  return `${JSON.stringify(comparison, null, 2)}\n`;
}

export function formatInventoryComparison(comparison: InventoryComparison): string {
  const lines = [
    comparison.hasDifferences
      ? `Database inventories differ (${comparison.differenceCount} object-level difference(s)).`
      : 'Database inventories match.',
    `Left: database=${comparison.leftTarget.database} role=${comparison.leftTarget.role} PostgreSQL=${comparison.leftTarget.serverVersion}`,
    `Right: database=${comparison.rightTarget.database} role=${comparison.rightTarget.role} PostgreSQL=${comparison.rightTarget.serverVersion}`,
  ];

  for (const spec of CATEGORY_SPECS) {
    const difference = comparison.categories[spec.name];
    const count = difference.missingFromRight.length + difference.extraInRight.length + difference.changed.length;
    if (count === 0) continue;
    lines.push(
      `${spec.name}: ${difference.missingFromRight.length} missing from right, ` +
        `${difference.extraInRight.length} extra in right, ${difference.changed.length} changed`,
    );
    if (difference.missingFromRight.length > 0) {
      lines.push(`  missing from right: ${difference.missingFromRight.join(', ')}`);
    }
    if (difference.extraInRight.length > 0) {
      lines.push(`  extra in right: ${difference.extraInRight.join(', ')}`);
    }
    for (const changed of difference.changed) {
      lines.push(`  changed: ${changed.key} (${changed.fields.join(', ')})`);
    }
  }

  return `${lines.join('\n')}\n`;
}
