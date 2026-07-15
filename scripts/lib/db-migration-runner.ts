import pg, { type QueryResultRow } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  ACTIVE_MIGRATIONS_DIRECTORY,
  loadActiveMigrations,
  type ActiveMigration,
} from './db-migration-assets';
import { redactConnectionDetails } from './db-schema-inventory';

const MIGRATION_LOCK_KEY = 843_103_001;
const JOURNAL_SCHEMA = 'drizzle';
const JOURNAL_TABLE = '__drizzle_migrations';

interface JournalRelationRow extends QueryResultRow {
  schema_name: string;
  table_name: string;
}

interface JournalColumnRow extends QueryResultRow {
  column_name: string;
  data_type: string;
  not_null: boolean;
  default_expression: string | null;
}

interface JournalEntryRow extends QueryResultRow {
  id: string;
  hash: string;
  created_at: string | null;
}

export interface CheckedMigrationResult {
  pending: string[];
  applied: string[];
  noOp: boolean;
}

async function discoverJournals(client: pg.Client): Promise<JournalRelationRow[]> {
  const result = await client.query<JournalRelationRow>(`
    SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND c.relname = '__drizzle_migrations'
      AND n.nspname <> 'information_schema'
      AND n.nspname !~ '^pg_'
    ORDER BY n.nspname, c.relname
  `);
  if (result.rows.length > 1) {
    throw new Error('Multiple Drizzle migration journals were discovered; migration is ambiguous.');
  }
  const relation = result.rows[0];
  if (relation && (relation.schema_name !== JOURNAL_SCHEMA || relation.table_name !== JOURNAL_TABLE)) {
    throw new Error('A non-approved Drizzle migration journal was discovered.');
  }
  return result.rows;
}

async function assertJournalFormat(client: pg.Client): Promise<void> {
  const columns = await client.query<JournalColumnRow>(`
    SELECT
      a.attname AS column_name,
      pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
      a.attnotnull AS not_null,
      pg_catalog.pg_get_expr(ad.adbin, ad.adrelid, true) AS default_expression
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
    WHERE n.nspname = $1 AND c.relname = $2
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum
  `, [JOURNAL_SCHEMA, JOURNAL_TABLE]);
  const expected = [
    { column_name: 'id', data_type: 'integer', not_null: true },
    { column_name: 'hash', data_type: 'text', not_null: true },
    { column_name: 'created_at', data_type: 'bigint', not_null: false },
  ];
  if (columns.rows.length !== expected.length) {
    throw new Error('The approved migration journal has an unexpected column layout.');
  }
  columns.rows.forEach((column, index) => {
    const wanted = expected[index];
    if (
      !wanted ||
      column.column_name !== wanted.column_name ||
      column.data_type !== wanted.data_type ||
      column.not_null !== wanted.not_null
    ) {
      throw new Error('The approved migration journal has an unexpected column definition.');
    }
  });
  if (!columns.rows[0]?.default_expression?.startsWith("nextval('drizzle.__drizzle_migrations_id_seq'")) {
    throw new Error('The approved migration journal id column is not backed by the expected serial sequence.');
  }
  if (columns.rows[1]?.default_expression !== null || columns.rows[2]?.default_expression !== null) {
    throw new Error('The approved migration journal contains an unexpected column default.');
  }
  const primaryKey = await client.query<{ columns: string[] }>(`
    SELECT ARRAY(
      SELECT a.attname
      FROM unnest(con.conkey) WITH ORDINALITY AS key(attnum, ordinal)
      JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = key.attnum
      ORDER BY key.ordinal
    )::text[] AS columns
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = $2 AND con.contype = 'p'
  `, [JOURNAL_SCHEMA, JOURNAL_TABLE]);
  if (primaryKey.rows.length !== 1 || JSON.stringify(primaryKey.rows[0]?.columns) !== JSON.stringify(['id'])) {
    throw new Error('The approved migration journal must have exactly one primary key on id.');
  }
}

async function readJournalEntries(client: pg.Client, exists: boolean): Promise<JournalEntryRow[]> {
  if (!exists) return [];
  await assertJournalFormat(client);
  const result = await client.query<JournalEntryRow>(`
    SELECT id::text, hash::text, created_at::text
    FROM drizzle.__drizzle_migrations
    ORDER BY created_at, id
  `);
  return result.rows;
}

function assertJournalPrefix(entries: JournalEntryRow[], migrations: ActiveMigration[]): void {
  if (entries.length > migrations.length) {
    throw new Error('Migration journal contains more rows than the checked-in active history.');
  }
  entries.forEach((entry, index) => {
    const expected = migrations[index];
    if (
      !expected ||
      entry.hash !== expected.hash ||
      entry.created_at !== String(expected.createdAt)
    ) {
      throw new Error(`Migration journal row ${index + 1} does not match the checked-in migration prefix.`);
    }
  });
}

async function hasApplicationOwnedPublicObjects(client: pg.Client): Promise<boolean> {
  const result = await client.query<{ found: boolean }>(`
    SELECT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_depend d
          WHERE d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
            AND d.objid = c.oid AND d.deptype = 'e'
        )
      UNION ALL
      SELECT 1
      FROM pg_catalog.pg_type t
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd', 'r', 'm')
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_depend d
          WHERE d.classid = 'pg_catalog.pg_type'::pg_catalog.regclass
            AND d.objid = t.oid AND d.deptype = 'e'
        )
      UNION ALL
      SELECT 1
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_depend d
          WHERE d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
            AND d.objid = p.oid AND d.deptype = 'e'
        )
    ) AS found
  `);
  return result.rows[0]?.found === true;
}

export async function runCheckedMigrations(
  connectionString: string,
  migrationsDirectory = ACTIVE_MIGRATIONS_DIRECTORY,
): Promise<CheckedMigrationResult> {
  const migrations = loadActiveMigrations(migrationsDirectory);
  const client = new pg.Client({
    connectionString,
    application_name: 'leaguevault-db-migrate',
  });
  let lockHeld = false;
  try {
    await client.connect();
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    lockHeld = true;
    const discovery = await discoverJournals(client);
    const entries = await readJournalEntries(client, discovery.length === 1);
    assertJournalPrefix(entries, migrations);
    if (entries.length === 0 && await hasApplicationOwnedPublicObjects(client)) {
      throw new Error(
        'Refusing to execute the baseline on a database that already contains application-owned public objects; use the guarded baseline-adoption workflow.',
      );
    }
    const pending = migrations.slice(entries.length).map((migration) => migration.tag);
    process.stdout.write(`[db:migrate] pending=${pending.length === 0 ? 'none' : pending.join(',')}\n`);
    if (pending.length === 0) return { pending, applied: [], noOp: true };

    await migrate(drizzle(client), { migrationsFolder: migrationsDirectory });
    const postDiscovery = await discoverJournals(client);
    const postEntries = await readJournalEntries(client, postDiscovery.length === 1);
    assertJournalPrefix(postEntries, migrations);
    if (postEntries.length !== migrations.length) {
      throw new Error('Migration runner returned without recording the complete active migration history.');
    }
    process.stdout.write(`[db:migrate] applied=${pending.join(',')}\n`);
    return { pending, applied: pending, noOp: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(redactConnectionDetails(message, connectionString));
  } finally {
    if (lockHeld) await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}
