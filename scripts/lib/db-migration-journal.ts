import pg, { type QueryResultRow } from 'pg';
import type { ActiveMigration } from './db-migration-assets';
import { normalizeSqlDefinition } from './sql-definition-normalization';

export const DRIZZLE_JOURNAL_SCHEMA = 'drizzle';
export const DRIZZLE_JOURNAL_TABLE = '__drizzle_migrations';
export const DRIZZLE_JOURNAL_SEQUENCE = '__drizzle_migrations_id_seq';

export interface JournalEntryRow extends QueryResultRow {
  id: string;
  hash: string;
  created_at: string | null;
}

export interface JournalInspection {
  exists: boolean;
  entries: JournalEntryRow[];
  sequenceState: JournalSequenceState | null;
}

export interface JournalSequenceState {
  lastValue: string;
  isCalled: boolean;
}

export async function restoreApprovedJournalSequenceState(
  client: pg.Client,
  state: JournalSequenceState,
): Promise<void> {
  let transaction = false;
  try {
    await client.query('BEGIN');
    transaction = true;
    await client.query(
      `LOCK TABLE ${DRIZZLE_JOURNAL_SCHEMA}.${DRIZZLE_JOURNAL_TABLE} IN SHARE MODE`,
    );
    await client.query(
      `SELECT pg_catalog.setval(
        '${DRIZZLE_JOURNAL_SCHEMA}.${DRIZZLE_JOURNAL_SEQUENCE}'::pg_catalog.regclass,
        $1::bigint,
        $2::boolean
      )`,
      [state.lastValue, state.isCalled],
    );
    await client.query('COMMIT');
    transaction = false;
  } finally {
    if (transaction) await client.query('ROLLBACK').catch(() => undefined);
  }
}

export interface JournalInspectionOptions {
  lock?: boolean;
}

interface JournalRelationRow extends QueryResultRow {
  schema_name: string;
  table_name: string;
  relation_kind: string;
  persistence: string;
  partition: boolean;
  row_security: boolean;
  force_row_security: boolean;
  replica_identity: string;
  relation_options: string[] | null;
  access_method: string | null;
  inheritance_parent_count: string;
  inheritance_child_count: string;
}

interface JournalColumnRow extends QueryResultRow {
  attribute_number: number;
  column_name: string;
  dropped: boolean;
  data_type: string;
  not_null: boolean;
  identity_kind: string;
  generated_kind: string;
  default_expression: string | null;
}

interface JournalConstraintRow extends QueryResultRow {
  constraint_name: string;
  constraint_type: string;
  deferrable: boolean;
  initially_deferred: boolean;
  validated: boolean;
  columns: string[];
}

interface JournalIndexRow extends QueryResultRow {
  index_name: string;
  access_method: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
  exclusion: boolean;
  valid: boolean;
  ready: boolean;
  clustered: boolean;
  replica_identity: boolean;
  predicate: string | null;
  key_attribute_count: number;
  total_attribute_count: number;
  has_expressions: boolean;
  operator_classes: string[];
  collations: string[];
  options: string[];
}

interface JournalSequenceRow extends QueryResultRow {
  relation_kind: string;
  persistence: string;
  sequence_owner: string;
  table_owner: string;
  data_type: string;
  start_value: string;
  increment_by: string;
  minimum_value: string;
  maximum_value: string;
  cache_size: string;
  cycle: boolean;
  ownership_dependency_count: string;
  ownership_dependency_type: string | null;
  default_dependency_count: string;
  all_default_dependency_count: string;
}

function sameArray(actual: readonly string[], expected: readonly string[]): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

export async function discoverApprovedJournal(client: pg.Client): Promise<boolean> {
  const result = await client.query<JournalRelationRow>(`
    SELECT
      n.nspname AS schema_name,
      c.relname AS table_name,
      c.relkind AS relation_kind,
      c.relpersistence AS persistence,
      c.relispartition AS partition,
      c.relrowsecurity AS row_security,
      c.relforcerowsecurity AS force_row_security,
      c.relreplident AS replica_identity,
      c.reloptions AS relation_options,
      access_method.amname AS access_method,
      (SELECT count(*)::text FROM pg_catalog.pg_inherits inheritance
       WHERE inheritance.inhrelid = c.oid) AS inheritance_parent_count,
      (SELECT count(*)::text FROM pg_catalog.pg_inherits inheritance
       WHERE inheritance.inhparent = c.oid) AS inheritance_child_count
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_am access_method ON access_method.oid = c.relam
    WHERE c.relname = '${DRIZZLE_JOURNAL_TABLE}'
      AND n.nspname <> 'information_schema'
      AND n.nspname !~ '^pg_'
    ORDER BY n.nspname, c.relname
  `);
  if (result.rows.length > 1) {
    throw new Error('Multiple Drizzle migration journals were discovered; migration is ambiguous.');
  }
  const relation = result.rows[0];
  if (!relation) return false;
  if (relation.schema_name !== DRIZZLE_JOURNAL_SCHEMA || relation.table_name !== DRIZZLE_JOURNAL_TABLE) {
    throw new Error('A non-approved Drizzle migration journal was discovered.');
  }
  if (
    relation.relation_kind !== 'r' ||
    relation.persistence !== 'p' ||
    relation.partition ||
    relation.row_security ||
    relation.force_row_security ||
    relation.replica_identity !== 'd' ||
    relation.relation_options !== null ||
    relation.access_method !== 'heap' ||
    relation.inheritance_parent_count !== '0' ||
    relation.inheritance_child_count !== '0'
  ) {
    throw new Error(
      'The approved migration journal is not an ordinary permanent standalone heap table with default physical options and no RLS.',
    );
  }
  return true;
}

export async function assertExactJournalShape(client: pg.Client): Promise<void> {
  const columns = await client.query<JournalColumnRow>(`
    SELECT
      a.attnum AS attribute_number,
      a.attname AS column_name,
      a.attisdropped AS dropped,
      pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
      a.attnotnull AS not_null,
      a.attidentity AS identity_kind,
      a.attgenerated AS generated_kind,
      pg_catalog.pg_get_expr(ad.adbin, ad.adrelid, true) AS default_expression
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
    WHERE n.nspname = '${DRIZZLE_JOURNAL_SCHEMA}'
      AND c.relname = '${DRIZZLE_JOURNAL_TABLE}'
      AND a.attnum > 0
    ORDER BY a.attnum
  `);
  const expectedColumns = [
    { number: 1, name: 'id', type: 'integer', notNull: true },
    { number: 2, name: 'hash', type: 'text', notNull: true },
    { number: 3, name: 'created_at', type: 'bigint', notNull: false },
  ] as const;
  if (
    columns.rows.length !== expectedColumns.length ||
    columns.rows.some((column, index) => {
      const expected = expectedColumns[index];
      return !expected || column.attribute_number !== expected.number || column.column_name !== expected.name ||
        column.dropped || column.data_type !== expected.type || column.not_null !== expected.notNull ||
        column.identity_kind !== '' || column.generated_kind !== '';
    })
  ) {
    throw new Error('The approved migration journal has an unexpected physical column definition.');
  }
  const expectedDefault = `nextval('${DRIZZLE_JOURNAL_SCHEMA}.${DRIZZLE_JOURNAL_SEQUENCE}'::regclass)`;
  if (normalizeSqlDefinition(columns.rows[0]?.default_expression) !== expectedDefault) {
    throw new Error('The approved migration journal id column has an unexpected serial default.');
  }
  if (columns.rows[1]?.default_expression !== null || columns.rows[2]?.default_expression !== null) {
    throw new Error('The approved migration journal contains an unexpected column default.');
  }

  const constraints = await client.query<JournalConstraintRow>(`
    SELECT
      con.conname AS constraint_name,
      con.contype AS constraint_type,
      con.condeferrable AS deferrable,
      con.condeferred AS initially_deferred,
      con.convalidated AS validated,
      ARRAY(
        SELECT a.attname
        FROM unnest(con.conkey) WITH ORDINALITY AS key(attnum, ordinal)
        JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = key.attnum
        ORDER BY key.ordinal
      )::text[] AS columns
    FROM pg_catalog.pg_constraint con
    WHERE con.conrelid = '${DRIZZLE_JOURNAL_SCHEMA}.${DRIZZLE_JOURNAL_TABLE}'::pg_catalog.regclass
    ORDER BY con.conname
  `);
  const primaryKey = constraints.rows[0];
  if (
    constraints.rows.length !== 1 || !primaryKey ||
    primaryKey.constraint_name !== '__drizzle_migrations_pkey' ||
    primaryKey.constraint_type !== 'p' || primaryKey.deferrable || primaryKey.initially_deferred ||
    !primaryKey.validated || !sameArray(primaryKey.columns, ['id'])
  ) {
    throw new Error('The approved migration journal must have exactly the installed Drizzle primary key.');
  }

  const indexes = await client.query<JournalIndexRow>(`
    SELECT
      index_class.relname AS index_name,
      access_method.amname AS access_method,
      ARRAY(
        SELECT attribute.attname
        FROM unnest(index_info.indkey::smallint[]) WITH ORDINALITY AS key(attnum, ordinal)
        JOIN pg_catalog.pg_attribute attribute
          ON attribute.attrelid = index_info.indrelid AND attribute.attnum = key.attnum
        ORDER BY key.ordinal
      )::text[] AS columns,
      index_info.indisunique AS unique,
      index_info.indisprimary AS primary,
      index_info.indisexclusion AS exclusion,
      index_info.indisvalid AS valid,
      index_info.indisready AS ready,
      index_info.indisclustered AS clustered,
      index_info.indisreplident AS replica_identity,
      pg_catalog.pg_get_expr(index_info.indpred, index_info.indrelid, true) AS predicate,
      index_info.indnkeyatts AS key_attribute_count,
      index_info.indnatts AS total_attribute_count,
      index_info.indexprs IS NOT NULL AS has_expressions,
      ARRAY(
        SELECT operator_class.opcname
        FROM unnest(index_info.indclass::oid[]) WITH ORDINALITY AS item(operator_class_oid, ordinal)
        JOIN pg_catalog.pg_opclass operator_class ON operator_class.oid = item.operator_class_oid
        ORDER BY item.ordinal
      )::text[] AS operator_classes,
      ARRAY(
        SELECT item.collation_oid::text
        FROM unnest(index_info.indcollation::oid[]) WITH ORDINALITY AS item(collation_oid, ordinal)
        ORDER BY item.ordinal
      )::text[] AS collations,
      ARRAY(
        SELECT item.option_value::text
        FROM unnest(index_info.indoption::smallint[]) WITH ORDINALITY AS item(option_value, ordinal)
        ORDER BY item.ordinal
      )::text[] AS options
    FROM pg_catalog.pg_index index_info
    JOIN pg_catalog.pg_class index_class ON index_class.oid = index_info.indexrelid
    JOIN pg_catalog.pg_am access_method ON access_method.oid = index_class.relam
    WHERE index_info.indrelid = '${DRIZZLE_JOURNAL_SCHEMA}.${DRIZZLE_JOURNAL_TABLE}'::pg_catalog.regclass
    ORDER BY index_class.relname
  `);
  const index = indexes.rows[0];
  if (
    indexes.rows.length !== 1 || !index || index.index_name !== '__drizzle_migrations_pkey' ||
    index.access_method !== 'btree' || !sameArray(index.columns, ['id']) || !index.unique || !index.primary ||
    index.exclusion || !index.valid || !index.ready || index.clustered || index.replica_identity ||
    index.predicate !== null || index.key_attribute_count !== 1 || index.total_attribute_count !== 1 ||
    index.has_expressions || !sameArray(index.operator_classes, ['int4_ops']) ||
    !sameArray(index.collations, ['0']) || !sameArray(index.options, ['0'])
  ) {
    throw new Error('The approved migration journal has unexpected indexes.');
  }

  const unexpectedObjects = await client.query<{ triggers: string; policies: string; rules: string }>(`
    SELECT
      (SELECT count(*)::text FROM pg_catalog.pg_trigger trigger
       WHERE trigger.tgrelid = '${DRIZZLE_JOURNAL_SCHEMA}.${DRIZZLE_JOURNAL_TABLE}'::pg_catalog.regclass)
        AS triggers,
      (SELECT count(*)::text FROM pg_catalog.pg_policy policy
       WHERE policy.polrelid = '${DRIZZLE_JOURNAL_SCHEMA}.${DRIZZLE_JOURNAL_TABLE}'::pg_catalog.regclass)
        AS policies,
      (SELECT count(*)::text FROM pg_catalog.pg_rewrite rule
       WHERE rule.ev_class = '${DRIZZLE_JOURNAL_SCHEMA}.${DRIZZLE_JOURNAL_TABLE}'::pg_catalog.regclass)
        AS rules
  `);
  if (
    unexpectedObjects.rows[0]?.triggers !== '0' ||
    unexpectedObjects.rows[0]?.policies !== '0' ||
    unexpectedObjects.rows[0]?.rules !== '0'
  ) {
    throw new Error('The approved migration journal has unexpected triggers, policies, or rewrite rules.');
  }

  const sequence = await client.query<JournalSequenceRow>(`
    SELECT
      sequence_class.relkind AS relation_kind,
      sequence_class.relpersistence AS persistence,
      pg_catalog.pg_get_userbyid(sequence_class.relowner) AS sequence_owner,
      pg_catalog.pg_get_userbyid(journal_class.relowner) AS table_owner,
      pg_catalog.format_type(sequence_info.seqtypid, NULL) AS data_type,
      sequence_info.seqstart::text AS start_value,
      sequence_info.seqincrement::text AS increment_by,
      sequence_info.seqmin::text AS minimum_value,
      sequence_info.seqmax::text AS maximum_value,
      sequence_info.seqcache::text AS cache_size,
      sequence_info.seqcycle AS cycle,
      (SELECT count(*)::text
       FROM pg_catalog.pg_depend dependency
       WHERE dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
         AND dependency.objid = sequence_class.oid
         AND dependency.objsubid = 0
         AND dependency.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
         AND dependency.refobjid = journal_class.oid
         AND dependency.refobjsubid = id_attribute.attnum
         AND dependency.deptype IN ('a', 'i')) AS ownership_dependency_count,
      (SELECT dependency.deptype::text
       FROM pg_catalog.pg_depend dependency
       WHERE dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
         AND dependency.objid = sequence_class.oid
         AND dependency.objsubid = 0
         AND dependency.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
         AND dependency.refobjid = journal_class.oid
         AND dependency.refobjsubid = id_attribute.attnum
         AND dependency.deptype IN ('a', 'i')
       LIMIT 1) AS ownership_dependency_type,
      (SELECT count(*)::text
       FROM pg_catalog.pg_depend dependency
       WHERE dependency.classid = 'pg_catalog.pg_attrdef'::pg_catalog.regclass
         AND dependency.objid = id_default.oid
         AND dependency.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
         AND dependency.refobjid = sequence_class.oid
         AND dependency.deptype = 'n') AS default_dependency_count,
      (SELECT count(*)::text
       FROM pg_catalog.pg_depend dependency
       WHERE dependency.classid = 'pg_catalog.pg_attrdef'::pg_catalog.regclass
         AND dependency.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
         AND dependency.refobjid = sequence_class.oid
         AND dependency.deptype = 'n') AS all_default_dependency_count
    FROM pg_catalog.pg_class sequence_class
    JOIN pg_catalog.pg_namespace sequence_namespace ON sequence_namespace.oid = sequence_class.relnamespace
    JOIN pg_catalog.pg_sequence sequence_info ON sequence_info.seqrelid = sequence_class.oid
    JOIN pg_catalog.pg_class journal_class
      ON journal_class.oid = '${DRIZZLE_JOURNAL_SCHEMA}.${DRIZZLE_JOURNAL_TABLE}'::pg_catalog.regclass
    JOIN pg_catalog.pg_attribute id_attribute
      ON id_attribute.attrelid = journal_class.oid AND id_attribute.attname = 'id' AND NOT id_attribute.attisdropped
    JOIN pg_catalog.pg_attrdef id_default
      ON id_default.adrelid = journal_class.oid AND id_default.adnum = id_attribute.attnum
    WHERE sequence_namespace.nspname = '${DRIZZLE_JOURNAL_SCHEMA}'
      AND sequence_class.relname = '${DRIZZLE_JOURNAL_SEQUENCE}'
  `);
  const serial = sequence.rows[0];
  if (
    sequence.rows.length !== 1 || !serial || serial.relation_kind !== 'S' || serial.persistence !== 'p' ||
    serial.sequence_owner !== serial.table_owner || serial.data_type !== 'integer' ||
    serial.start_value !== '1' || serial.increment_by !== '1' || serial.minimum_value !== '1' ||
    serial.maximum_value !== '2147483647' || serial.cache_size !== '1' || serial.cycle ||
    serial.ownership_dependency_count !== '1' || serial.ownership_dependency_type !== 'a' ||
    serial.default_dependency_count !== '1' || serial.all_default_dependency_count !== '1'
  ) {
    throw new Error('The approved migration journal has an unexpected backing sequence.');
  }
}

export async function inspectApprovedJournal(
  client: pg.Client,
  options: JournalInspectionOptions = {},
): Promise<JournalInspection> {
  const exists = await discoverApprovedJournal(client);
  if (!exists) return { exists: false, entries: [], sequenceState: null };
  if (options.lock) {
    await client.query(
      `LOCK TABLE ${DRIZZLE_JOURNAL_SCHEMA}.${DRIZZLE_JOURNAL_TABLE} IN SHARE MODE`,
    );
    if (!await discoverApprovedJournal(client)) {
      throw new Error('The approved migration journal disappeared while acquiring its inspection lock.');
    }
  }
  await assertExactJournalShape(client);
  const entries = await client.query<JournalEntryRow>(`
    SELECT journal.id::text, journal.hash::text, journal.created_at::text
    FROM ${DRIZZLE_JOURNAL_SCHEMA}.${DRIZZLE_JOURNAL_TABLE} AS journal
    ORDER BY journal.id
  `);
  const sequenceState = await client.query<{ last_value: string; is_called: boolean }>(`
    SELECT last_value::text, is_called
    FROM ${DRIZZLE_JOURNAL_SCHEMA}.${DRIZZLE_JOURNAL_SEQUENCE}
  `);
  const state = sequenceState.rows[0];
  if (sequenceState.rows.length !== 1 || !state) {
    throw new Error('The approved migration journal sequence runtime state could not be read exactly.');
  }
  const expectedLastValue = entries.rows.length === 0 ? '1' : String(entries.rows.length);
  const expectedIsCalled = entries.rows.length > 0;
  if (state.last_value !== expectedLastValue || state.is_called !== expectedIsCalled) {
    throw new Error('The approved migration journal sequence runtime state is inconsistent with its exact rows.');
  }
  return {
    exists: true,
    entries: entries.rows,
    sequenceState: { lastValue: state.last_value, isCalled: state.is_called },
  };
}

export async function ensureApprovedJournal(client: pg.Client): Promise<void> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${DRIZZLE_JOURNAL_SCHEMA}`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${DRIZZLE_JOURNAL_SCHEMA}.${DRIZZLE_JOURNAL_TABLE} (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);
  await client.query(
    `LOCK TABLE ${DRIZZLE_JOURNAL_SCHEMA}.${DRIZZLE_JOURNAL_TABLE} IN ACCESS EXCLUSIVE MODE`,
  );
  await assertExactJournalShape(client);
}

export function assertJournalPrefix(entries: JournalEntryRow[], migrations: ActiveMigration[]): void {
  if (entries.length > migrations.length) {
    throw new Error('Migration journal contains more rows than the checked-in active history.');
  }
  entries.forEach((entry, index) => {
    const expected = migrations[index];
    if (
      !expected || entry.id !== String(index + 1) || entry.hash !== expected.hash ||
      entry.created_at !== String(expected.createdAt)
    ) {
      throw new Error(`Migration journal row ${index + 1} does not match the checked-in migration prefix.`);
    }
  });
}

export function classifyBaselineJournal(
  entries: JournalEntryRow[],
  baseline: ActiveMigration,
): 'absent-or-empty' | 'baseline' {
  if (entries.length === 0) return 'absent-or-empty';
  if (entries.length === 1 && entries[0]?.id === '1' && entries[0]?.hash === baseline.hash &&
      entries[0]?.created_at === String(baseline.createdAt)) {
    return 'baseline';
  }
  throw new Error('Migration journal state is non-empty, conflicting, or does not contain the exact baseline record.');
}
