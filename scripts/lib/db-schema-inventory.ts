import { createHash } from 'node:crypto';
import pg, { type QueryResultRow } from 'pg';
import { normalizeSqlDefinition } from './sql-definition-normalization';

export const DB_INVENTORY_FORMAT_VERSION = 1 as const;

export interface DatabaseTarget {
  hostFingerprint: string;
  database: string;
  role: string;
  serverVersion: string;
  serverVersionNumber: string;
  transactionIsolation: 'repeatable read';
  transactionReadOnly: true;
}

export interface SchemaInfo {
  name: string;
}

export interface TableInfo {
  schema: string;
  name: string;
  kind: 'table' | 'partitioned table';
  persistence: 'permanent' | 'unlogged' | 'temporary';
  rowSecurity: boolean;
  forceRowSecurity: boolean;
}

export interface ColumnInfo {
  schema: string;
  table: string;
  name: string;
  ordinal: number;
  dataType: string;
  typeSchema: string;
  typeName: string;
  nullable: boolean;
  default: string | null;
  identity: 'always' | 'by default' | null;
  generated: 'stored' | 'virtual' | null;
  collation: string | null;
}

export interface ConstraintInfo {
  schema: string;
  table: string;
  name: string;
  kind: 'primary key' | 'foreign key' | 'unique' | 'check' | 'exclusion';
  columns: string[];
  referencedSchema: string | null;
  referencedTable: string | null;
  referencedColumns: string[];
  definition: string;
  deferrable: boolean;
  initiallyDeferred: boolean;
  validated: boolean;
  noInherit: boolean;
}

export interface IndexInfo {
  schema: string;
  table: string;
  name: string;
  accessMethod: string;
  definition: string;
  predicate: string | null;
  unique: boolean;
  primary: boolean;
  exclusion: boolean;
  valid: boolean;
  ready: boolean;
  clustered: boolean;
  replicaIdentity: boolean;
}

export interface TypeInfo {
  schema: string;
  name: string;
  kind: 'enum' | 'domain' | 'range' | 'multirange' | 'composite' | 'base';
  enumLabels: string[];
  baseType: string | null;
  rangeSubtype: string | null;
  default: string | null;
  notNull: boolean;
  constraints: string[];
  attributes: string[];
}

export interface FunctionInfo {
  schema: string;
  name: string;
  identityArguments: string;
  resultType: string;
  language: string;
  kind: 'function' | 'procedure';
  volatility: 'immutable' | 'stable' | 'volatile';
  parallel: 'safe' | 'restricted' | 'unsafe';
  securityDefiner: boolean;
  strict: boolean;
  leakproof: boolean;
  definition: string;
}

export interface TriggerInfo {
  schema: string;
  table: string;
  name: string;
  enabled: 'origin' | 'replica' | 'always' | 'disabled';
  definition: string;
  functionSchema: string;
  functionName: string;
  functionIdentityArguments: string;
}

export interface ExtensionInfo {
  name: string;
  schema: string;
  version: string;
  relocatable: boolean;
}

export interface MigrationJournalEntry {
  id: string;
  hash: string;
  createdAt: string;
}

export interface MigrationJournalInfo {
  schema: string;
  table: string;
  columns: string[];
  entries: MigrationJournalEntry[];
}

export interface MigrationJournalRelation {
  schema: string;
  table: string;
}

export interface MigrationJournalInspection {
  approvedRelation: MigrationJournalRelation;
  selection: 'default' | 'explicit';
  relationDiscovered: boolean;
  columnsInspected: boolean;
  rowsCollected: boolean;
}

export interface DatabaseInventoryOptions {
  migrationJournalRelation?: MigrationJournalRelation;
}

export interface ApprovedMigrationJournalSelection {
  approvedRelation: MigrationJournalRelation;
  selection: 'default' | 'explicit';
  relationDiscovered: boolean;
}

export interface DatabaseInventory {
  formatVersion: typeof DB_INVENTORY_FORMAT_VERSION;
  target: DatabaseTarget;
  schemas: SchemaInfo[];
  tables: TableInfo[];
  columns: ColumnInfo[];
  constraints: ConstraintInfo[];
  indexes: IndexInfo[];
  types: TypeInfo[];
  functions: FunctionInfo[];
  triggers: TriggerInfo[];
  extensions: ExtensionInfo[];
  migrationJournalDiscovery: MigrationJournalRelation[];
  migrationJournalInspection: MigrationJournalInspection;
  migrationJournalExists: boolean;
  migrationJournals: MigrationJournalInfo[];
}

interface TargetRow extends QueryResultRow {
  database_name: string;
  role_name: string;
  server_version: string;
  server_version_number: string;
  transaction_read_only: string;
  transaction_isolation: string;
}

interface NamedRow extends QueryResultRow {
  name: string;
}

interface TableRow extends QueryResultRow {
  schema_name: string;
  table_name: string;
  kind: TableInfo['kind'];
  persistence: TableInfo['persistence'];
  row_security: boolean;
  force_row_security: boolean;
}

interface ColumnRow extends QueryResultRow {
  schema_name: string;
  table_name: string;
  column_name: string;
  ordinal: number;
  data_type: string;
  type_schema: string;
  type_name: string;
  not_null: boolean;
  default_expression: string | null;
  identity_kind: string;
  generated_kind: string;
  collation_name: string | null;
}

interface ConstraintRow extends QueryResultRow {
  schema_name: string;
  table_name: string;
  constraint_name: string;
  kind: ConstraintInfo['kind'];
  columns: string[];
  referenced_schema: string | null;
  referenced_table: string | null;
  referenced_columns: string[];
  definition: string;
  deferrable: boolean;
  initially_deferred: boolean;
  validated: boolean;
  no_inherit: boolean;
}

interface IndexRow extends QueryResultRow {
  schema_name: string;
  table_name: string;
  index_name: string;
  access_method: string;
  definition: string;
  predicate: string | null;
  is_unique: boolean;
  is_primary: boolean;
  is_exclusion: boolean;
  is_valid: boolean;
  is_ready: boolean;
  is_clustered: boolean;
  is_replica_identity: boolean;
}

interface TypeRow extends QueryResultRow {
  schema_name: string;
  type_name: string;
  kind: TypeInfo['kind'];
  enum_labels: string[];
  base_type: string | null;
  range_subtype: string | null;
  default_expression: string | null;
  not_null: boolean;
  constraints: string[];
  attributes: string[];
}

interface FunctionRow extends QueryResultRow {
  schema_name: string;
  function_name: string;
  identity_arguments: string;
  result_type: string;
  language_name: string;
  kind: FunctionInfo['kind'];
  volatility: FunctionInfo['volatility'];
  parallel_safety: FunctionInfo['parallel'];
  security_definer: boolean;
  strict: boolean;
  leakproof: boolean;
  definition: string;
}

interface TriggerRow extends QueryResultRow {
  schema_name: string;
  table_name: string;
  trigger_name: string;
  enabled: TriggerInfo['enabled'];
  definition: string;
  function_schema: string;
  function_name: string;
  function_identity_arguments: string;
}

interface ExtensionRow extends QueryResultRow {
  extension_name: string;
  schema_name: string;
  version: string;
  relocatable: boolean;
}

interface JournalRelationRow extends QueryResultRow {
  schema_name: string;
  table_name: string;
}

interface JournalColumnRow extends QueryResultRow {
  column_name: string;
}

interface JournalEntryRow extends QueryResultRow {
  id: string;
  hash: string;
  created_at: string;
}

export const DEFAULT_MIGRATION_JOURNAL_RELATION: MigrationJournalRelation = {
  schema: 'drizzle',
  table: '__drizzle_migrations',
};

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

const USER_SCHEMA_PREDICATE = `
  n.nspname <> 'information_schema'
  AND n.nspname !~ '^pg_'
`;

function compareText(a: string, b: string): number {
  return a.localeCompare(b, 'en');
}

function quoteIdentifier(identifier: string): string {
  if (!SAFE_IDENTIFIER.test(identifier)) {
    throw new Error(`Unsafe PostgreSQL identifier: ${identifier}`);
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function parseMigrationJournalRelation(value: string): MigrationJournalRelation {
  const parts = value.split('.');
  if (
    parts.length !== 2 ||
    !parts[0] ||
    !parts[1] ||
    !SAFE_IDENTIFIER.test(parts[0]) ||
    !SAFE_IDENTIFIER.test(parts[1])
  ) {
    throw new Error(
      '--journal-relation must be a validated schema.relation pair using letters, numbers, underscores, or dollar signs.',
    );
  }
  return { schema: parts[0], table: parts[1] };
}

function validateMigrationJournalRelation(relation: MigrationJournalRelation): void {
  if (!SAFE_IDENTIFIER.test(relation.schema) || !SAFE_IDENTIFIER.test(relation.table)) {
    throw new Error('The approved migration journal relation contains an unsafe PostgreSQL identifier.');
  }
}

export function resolveApprovedMigrationJournal(
  discovery: MigrationJournalRelation[],
  requestedRelation?: MigrationJournalRelation,
): ApprovedMigrationJournalSelection {
  if (requestedRelation) validateMigrationJournalRelation(requestedRelation);
  if (discovery.length > 1 && !requestedRelation) {
    throw new Error(
      'Multiple Drizzle migration journals were discovered; rerun with --journal-relation schema.relation.',
    );
  }
  const approvedRelation = requestedRelation ?? DEFAULT_MIGRATION_JOURNAL_RELATION;
  return {
    approvedRelation,
    selection: requestedRelation ? 'explicit' : 'default',
    relationDiscovered: discovery.some(
      (relation) => relation.schema === approvedRelation.schema && relation.table === approvedRelation.table,
    ),
  };
}

export function assertInventoryTransactionMode(
  readOnly: string | undefined,
  isolation: string | undefined,
): void {
  if (readOnly !== 'on') {
    throw new Error('PostgreSQL did not confirm a read-only inventory transaction.');
  }
  if (isolation !== 'repeatable read') {
    throw new Error('PostgreSQL did not confirm repeatable-read inventory isolation.');
  }
}

export function fingerprintDatabaseHost(connectionString: string): string {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL.');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must use the postgres or postgresql scheme.');
  }
  if (!parsed.hostname) throw new Error('DATABASE_URL does not contain a hostname.');
  const port = parsed.port || '5432';
  const material = `${parsed.hostname.toLowerCase()}:${port}`;
  return `sha256:${createHash('sha256').update(material).digest('hex')}`;
}

export function redactConnectionDetails(message: string, connectionString?: string): string {
  let redacted = message;
  if (connectionString) {
    redacted = redacted.replaceAll(connectionString, '[DATABASE_URL redacted]');
    try {
      const parsed = new URL(connectionString);
      if (parsed.hostname) {
        redacted = redacted.replaceAll(parsed.hostname, '[host redacted]');
      }
      if (parsed.password) {
        redacted = redacted.replaceAll(parsed.password, '[password redacted]');
        redacted = redacted.replaceAll(decodeURIComponent(parsed.password), '[password redacted]');
      }
    } catch {
      // The caller will report the URL parse error without echoing the value.
    }
  }
  return redacted.replace(
    /postgres(?:ql)?:\/\/[^\s/@:]+(?::[^\s/@]*)?@/gi,
    'postgresql://[credentials-redacted]@',
  );
}

async function discoverMigrationJournalRelations(client: pg.Client): Promise<MigrationJournalRelation[]> {
  const relations = await client.query<JournalRelationRow>(`
    SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND c.relname = '__drizzle_migrations'
      AND ${USER_SCHEMA_PREDICATE}
    ORDER BY n.nspname, c.relname
  `);
  return relations.rows.map((relation) => ({
    schema: relation.schema_name,
    table: relation.table_name,
  }));
}

async function inspectMigrationJournal(
  client: pg.Client,
  relation: MigrationJournalRelation,
): Promise<MigrationJournalInfo> {
  validateMigrationJournalRelation(relation);
  const columns = await client.query<JournalColumnRow>(`
    SELECT a.attname AS column_name
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1
      AND c.relname = $2
      AND a.attnum > 0
      AND NOT a.attisdropped
    ORDER BY a.attnum
  `, [relation.schema, relation.table]);
  const columnNames = columns.rows.map((row) => row.column_name);
  const required = ['id', 'hash', 'created_at'];
  const missing = required.filter((column) => !columnNames.includes(column));
  if (missing.length > 0) {
    throw new Error(
      `Migration journal ${relation.schema}.${relation.table} is missing expected column(s): ${missing.join(', ')}`,
    );
  }

  const qualifiedName = `${quoteIdentifier(relation.schema)}.${quoteIdentifier(relation.table)}`;
  const entries = await client.query<JournalEntryRow>(`
    SELECT id::text AS id, hash::text AS hash, created_at::text AS created_at
    FROM ${qualifiedName}
    ORDER BY created_at, id
  `);
  return {
    schema: relation.schema,
    table: relation.table,
    columns: [...columnNames].sort(compareText),
    entries: entries.rows.map((row) => ({
      id: row.id,
      hash: row.hash,
      createdAt: row.created_at,
    })),
  };
}

export async function collectDatabaseInventory(
  connectionString: string,
  options: DatabaseInventoryOptions = {},
): Promise<DatabaseInventory> {
  const hostFingerprint = fingerprintDatabaseHost(connectionString);
  const client = new pg.Client({
    connectionString,
    application_name: 'leaguevault-db-inventory',
  });

  let transactionStarted = false;
  try {
    await client.connect();
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    transactionStarted = true;
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL lock_timeout = '5s'");

    const targetResult = await client.query<TargetRow>(`
      SELECT
        current_database() AS database_name,
        current_user AS role_name,
        current_setting('server_version') AS server_version,
        current_setting('server_version_num') AS server_version_number,
        current_setting('transaction_read_only') AS transaction_read_only,
        current_setting('transaction_isolation') AS transaction_isolation
    `);
    const target = targetResult.rows[0];
    assertInventoryTransactionMode(target?.transaction_read_only, target?.transaction_isolation);
    if (!target) throw new Error('PostgreSQL did not return inventory target metadata.');

    const schemasResult = await client.query<NamedRow>(`
      SELECT n.nspname AS name
      FROM pg_catalog.pg_namespace n
      WHERE ${USER_SCHEMA_PREDICATE}
      ORDER BY n.nspname
    `);

    const tablesResult = await client.query<TableRow>(`
      SELECT
        n.nspname AS schema_name,
        c.relname AS table_name,
        CASE c.relkind WHEN 'p' THEN 'partitioned table' ELSE 'table' END AS kind,
        CASE c.relpersistence
          WHEN 'u' THEN 'unlogged'
          WHEN 't' THEN 'temporary'
          ELSE 'permanent'
        END AS persistence,
        c.relrowsecurity AS row_security,
        c.relforcerowsecurity AS force_row_security
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p')
        AND ${USER_SCHEMA_PREDICATE}
      ORDER BY n.nspname, c.relname
    `);

    const columnsResult = await client.query<ColumnRow>(`
      SELECT
        n.nspname AS schema_name,
        c.relname AS table_name,
        a.attname AS column_name,
        a.attnum AS ordinal,
        pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
        tn.nspname AS type_schema,
        t.typname AS type_name,
        a.attnotnull AS not_null,
        pg_catalog.pg_get_expr(ad.adbin, ad.adrelid, true) AS default_expression,
        a.attidentity AS identity_kind,
        a.attgenerated AS generated_kind,
        CASE WHEN coll.oid IS NULL THEN NULL ELSE cn.nspname || '.' || coll.collname END AS collation_name
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
      JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace
      LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
      LEFT JOIN pg_catalog.pg_collation coll ON coll.oid = a.attcollation AND a.attcollation <> 0
      LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid = coll.collnamespace
      WHERE c.relkind IN ('r', 'p')
        AND a.attnum > 0
        AND NOT a.attisdropped
        AND ${USER_SCHEMA_PREDICATE}
      ORDER BY n.nspname, c.relname, a.attnum
    `);

    const constraintsResult = await client.query<ConstraintRow>(`
      SELECT
        n.nspname AS schema_name,
        c.relname AS table_name,
        con.conname AS constraint_name,
        CASE con.contype
          WHEN 'p' THEN 'primary key'
          WHEN 'f' THEN 'foreign key'
          WHEN 'u' THEN 'unique'
          WHEN 'c' THEN 'check'
          WHEN 'x' THEN 'exclusion'
        END AS kind,
        ARRAY(
          SELECT a.attname
          FROM unnest(con.conkey) WITH ORDINALITY AS key(attnum, ordinal)
          JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = key.attnum
          ORDER BY key.ordinal
        ) AS columns,
        rn.nspname AS referenced_schema,
        rc.relname AS referenced_table,
        ARRAY(
          SELECT a.attname
          FROM unnest(con.confkey) WITH ORDINALITY AS key(attnum, ordinal)
          JOIN pg_catalog.pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = key.attnum
          ORDER BY key.ordinal
        ) AS referenced_columns,
        pg_catalog.pg_get_constraintdef(con.oid, true) AS definition,
        con.condeferrable AS deferrable,
        con.condeferred AS initially_deferred,
        con.convalidated AS validated,
        con.connoinherit AS no_inherit
      FROM pg_catalog.pg_constraint con
      JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_catalog.pg_class rc ON rc.oid = con.confrelid
      LEFT JOIN pg_catalog.pg_namespace rn ON rn.oid = rc.relnamespace
      WHERE con.contype IN ('p', 'f', 'u', 'c', 'x')
        AND c.relkind IN ('r', 'p')
        AND ${USER_SCHEMA_PREDICATE}
      ORDER BY n.nspname, c.relname, con.conname
    `);

    const indexesResult = await client.query<IndexRow>(`
      SELECT
        n.nspname AS schema_name,
        c.relname AS table_name,
        ic.relname AS index_name,
        am.amname AS access_method,
        pg_catalog.pg_get_indexdef(i.indexrelid) AS definition,
        pg_catalog.pg_get_expr(i.indpred, i.indrelid, true) AS predicate,
        i.indisunique AS is_unique,
        i.indisprimary AS is_primary,
        i.indisexclusion AS is_exclusion,
        i.indisvalid AS is_valid,
        i.indisready AS is_ready,
        i.indisclustered AS is_clustered,
        i.indisreplident AS is_replica_identity
      FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
      JOIN pg_catalog.pg_am am ON am.oid = ic.relam
      WHERE c.relkind IN ('r', 'p')
        AND ${USER_SCHEMA_PREDICATE}
      ORDER BY n.nspname, c.relname, ic.relname
    `);

    const typesResult = await client.query<TypeRow>(`
      SELECT
        n.nspname AS schema_name,
        t.typname AS type_name,
        CASE t.typtype
          WHEN 'e' THEN 'enum'
          WHEN 'd' THEN 'domain'
          WHEN 'r' THEN 'range'
          WHEN 'm' THEN 'multirange'
          WHEN 'c' THEN 'composite'
          ELSE 'base'
        END AS kind,
        ARRAY(
          SELECT e.enumlabel
          FROM pg_catalog.pg_enum e
          WHERE e.enumtypid = t.oid
          ORDER BY e.enumsortorder
        ) AS enum_labels,
        CASE WHEN t.typtype = 'd' THEN pg_catalog.format_type(t.typbasetype, t.typtypmod) ELSE NULL END AS base_type,
        CASE WHEN t.typtype IN ('r', 'm') THEN (
          SELECT pg_catalog.format_type(r.rngsubtype, NULL)
          FROM pg_catalog.pg_range r
          WHERE r.rngtypid = t.oid OR r.rngmultitypid = t.oid
        ) ELSE NULL END AS range_subtype,
        pg_catalog.pg_get_expr(t.typdefaultbin, 0, true) AS default_expression,
        t.typnotnull AS not_null,
        ARRAY(
          SELECT pg_catalog.pg_get_constraintdef(con.oid, true)
          FROM pg_catalog.pg_constraint con
          WHERE con.contypid = t.oid
          ORDER BY con.conname
        ) AS constraints,
        ARRAY(
          SELECT a.attname || ' ' || pg_catalog.format_type(a.atttypid, a.atttypmod)
          FROM pg_catalog.pg_attribute a
          WHERE a.attrelid = t.typrelid
            AND a.attnum > 0
            AND NOT a.attisdropped
          ORDER BY a.attnum
        ) AS attributes
      FROM pg_catalog.pg_type t
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      LEFT JOIN pg_catalog.pg_class type_class ON type_class.oid = t.typrelid
      WHERE ${USER_SCHEMA_PREDICATE}
        AND t.typcategory <> 'A'
        AND (
          t.typtype IN ('e', 'd', 'r', 'm')
          OR (t.typtype = 'c' AND type_class.relkind = 'c')
          OR (t.typtype = 'b' AND t.typelem = 0)
        )
      ORDER BY n.nspname, t.typname
    `);

    const functionsResult = await client.query<FunctionRow>(`
      SELECT
        n.nspname AS schema_name,
        p.proname AS function_name,
        pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_arguments,
        pg_catalog.pg_get_function_result(p.oid) AS result_type,
        l.lanname AS language_name,
        CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END AS kind,
        CASE p.provolatile WHEN 'i' THEN 'immutable' WHEN 's' THEN 'stable' ELSE 'volatile' END AS volatility,
        CASE p.proparallel WHEN 's' THEN 'safe' WHEN 'r' THEN 'restricted' ELSE 'unsafe' END AS parallel_safety,
        p.prosecdef AS security_definer,
        p.proisstrict AS strict,
        p.proleakproof AS leakproof,
        pg_catalog.pg_get_functiondef(p.oid) AS definition
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_catalog.pg_language l ON l.oid = p.prolang
      WHERE ${USER_SCHEMA_PREDICATE}
        AND p.prokind IN ('f', 'p')
        AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_depend d
          JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid
          WHERE d.classid = 'pg_proc'::regclass
            AND d.objid = p.oid
            AND d.deptype = 'e'
        )
      ORDER BY n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)
    `);

    const triggersResult = await client.query<TriggerRow>(`
      SELECT
        n.nspname AS schema_name,
        c.relname AS table_name,
        tg.tgname AS trigger_name,
        CASE tg.tgenabled
          WHEN 'D' THEN 'disabled'
          WHEN 'R' THEN 'replica'
          WHEN 'A' THEN 'always'
          ELSE 'origin'
        END AS enabled,
        pg_catalog.pg_get_triggerdef(tg.oid, true) AS definition,
        pn.nspname AS function_schema,
        p.proname AS function_name,
        pg_catalog.pg_get_function_identity_arguments(p.oid) AS function_identity_arguments
      FROM pg_catalog.pg_trigger tg
      JOIN pg_catalog.pg_class c ON c.oid = tg.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_proc p ON p.oid = tg.tgfoid
      JOIN pg_catalog.pg_namespace pn ON pn.oid = p.pronamespace
      WHERE NOT tg.tgisinternal
        AND c.relkind IN ('r', 'p')
        AND ${USER_SCHEMA_PREDICATE}
      ORDER BY n.nspname, c.relname, tg.tgname
    `);

    const extensionsResult = await client.query<ExtensionRow>(`
      SELECT
        e.extname AS extension_name,
        n.nspname AS schema_name,
        e.extversion AS version,
        e.extrelocatable AS relocatable
      FROM pg_catalog.pg_extension e
      JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
      ORDER BY e.extname
    `);

    const migrationJournalDiscovery = await discoverMigrationJournalRelations(client);
    const journalSelection = resolveApprovedMigrationJournal(
      migrationJournalDiscovery,
      options.migrationJournalRelation,
    );
    const { approvedRelation, relationDiscovered } = journalSelection;
    const inspectedJournal = relationDiscovered
      ? await inspectMigrationJournal(client, approvedRelation)
      : null;
    const migrationJournals = inspectedJournal ? [inspectedJournal] : [];

    await client.query('COMMIT');
    transactionStarted = false;

    return {
      formatVersion: DB_INVENTORY_FORMAT_VERSION,
      target: {
        hostFingerprint,
        database: target.database_name,
        role: target.role_name,
        serverVersion: target.server_version,
        serverVersionNumber: target.server_version_number,
        transactionIsolation: 'repeatable read',
        transactionReadOnly: true,
      },
      schemas: schemasResult.rows.map((row) => ({ name: row.name })),
      tables: tablesResult.rows.map((row) => ({
        schema: row.schema_name,
        name: row.table_name,
        kind: row.kind,
        persistence: row.persistence,
        rowSecurity: row.row_security,
        forceRowSecurity: row.force_row_security,
      })),
      columns: columnsResult.rows.map((row) => ({
        schema: row.schema_name,
        table: row.table_name,
        name: row.column_name,
        ordinal: row.ordinal,
        dataType: row.data_type,
        typeSchema: row.type_schema,
        typeName: row.type_name,
        nullable: !row.not_null,
        default: normalizeSqlDefinition(row.default_expression),
        identity: row.identity_kind === 'a' ? 'always' : row.identity_kind === 'd' ? 'by default' : null,
        generated: row.generated_kind === 's' ? 'stored' : row.generated_kind === 'v' ? 'virtual' : null,
        collation: row.collation_name,
      })),
      constraints: constraintsResult.rows.map((row) => ({
        schema: row.schema_name,
        table: row.table_name,
        name: row.constraint_name,
        kind: row.kind,
        columns: row.columns,
        referencedSchema: row.referenced_schema,
        referencedTable: row.referenced_table,
        referencedColumns: row.referenced_columns,
        definition: normalizeSqlDefinition(row.definition) ?? '',
        deferrable: row.deferrable,
        initiallyDeferred: row.initially_deferred,
        validated: row.validated,
        noInherit: row.no_inherit,
      })),
      indexes: indexesResult.rows.map((row) => ({
        schema: row.schema_name,
        table: row.table_name,
        name: row.index_name,
        accessMethod: row.access_method,
        definition: normalizeSqlDefinition(row.definition) ?? '',
        predicate: normalizeSqlDefinition(row.predicate),
        unique: row.is_unique,
        primary: row.is_primary,
        exclusion: row.is_exclusion,
        valid: row.is_valid,
        ready: row.is_ready,
        clustered: row.is_clustered,
        replicaIdentity: row.is_replica_identity,
      })),
      types: typesResult.rows.map((row) => ({
        schema: row.schema_name,
        name: row.type_name,
        kind: row.kind,
        enumLabels: row.enum_labels,
        baseType: row.base_type,
        rangeSubtype: row.range_subtype,
        default: normalizeSqlDefinition(row.default_expression),
        notNull: row.not_null,
        constraints: row.constraints.map((definition) => normalizeSqlDefinition(definition) ?? ''),
        attributes: row.attributes,
      })),
      functions: functionsResult.rows.map((row) => ({
        schema: row.schema_name,
        name: row.function_name,
        identityArguments: row.identity_arguments,
        resultType: row.result_type,
        language: row.language_name,
        kind: row.kind,
        volatility: row.volatility,
        parallel: row.parallel_safety,
        securityDefiner: row.security_definer,
        strict: row.strict,
        leakproof: row.leakproof,
        definition: normalizeSqlDefinition(row.definition) ?? '',
      })),
      triggers: triggersResult.rows.map((row) => ({
        schema: row.schema_name,
        table: row.table_name,
        name: row.trigger_name,
        enabled: row.enabled,
        definition: normalizeSqlDefinition(row.definition) ?? '',
        functionSchema: row.function_schema,
        functionName: row.function_name,
        functionIdentityArguments: row.function_identity_arguments,
      })),
      extensions: extensionsResult.rows.map((row) => ({
        name: row.extension_name,
        schema: row.schema_name,
        version: row.version,
        relocatable: row.relocatable,
      })),
      migrationJournalDiscovery,
      migrationJournalInspection: {
        approvedRelation,
        selection: journalSelection.selection,
        relationDiscovered,
        columnsInspected: inspectedJournal !== null,
        rowsCollected: inspectedJournal !== null,
      },
      migrationJournalExists: migrationJournals.length > 0,
      migrationJournals,
    };
  } catch (error) {
    if (transactionStarted) {
      await client.query('ROLLBACK').catch(() => undefined);
    }
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function serializeDatabaseInventory(inventory: DatabaseInventory): string {
  return `${JSON.stringify(inventory, null, 2)}\n`;
}
