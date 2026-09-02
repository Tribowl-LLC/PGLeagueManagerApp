import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  ACTIVE_MIGRATIONS_DIRECTORY,
  loadActiveMigrations,
} from './db-migration-assets';
import {
  assertJournalPrefix,
  inspectApprovedJournal,
} from './db-migration-journal';
import { redactConnectionDetails } from './db-schema-inventory';

const MIGRATION_LOCK_KEY = 843_103_001;

export interface CheckedMigrationOptions {
  expectedPending?: readonly string[];
}

export interface CheckedMigrationResult {
  pending: string[];
  applied: string[];
  noOp: boolean;
}

export function parseExpectedPendingMigrations(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (normalized === 'none') return [];
  if (normalized.length === 0) {
    throw new Error('DB_MIGRATION_EXPECTED_PENDING must be "none" or a comma-separated migration tag list.');
  }
  const tags = normalized.split(',').map((tag) => tag.trim());
  if (tags.some((tag) => !/^\d{4}_[a-z0-9_]+$/.test(tag))) {
    throw new Error('DB_MIGRATION_EXPECTED_PENDING contains an invalid migration tag.');
  }
  if (new Set(tags).size !== tags.length) {
    throw new Error('DB_MIGRATION_EXPECTED_PENDING must not contain duplicate migration tags.');
  }
  return tags;
}

export function assertExpectedPendingMigrations(
  pending: readonly string[],
  expected: readonly string[] | undefined,
): void {
  if (expected === undefined) return;
  if (pending.length === expected.length && pending.every((tag, index) => tag === expected[index])) return;
  const display = (tags: readonly string[]) => tags.length === 0 ? 'none' : tags.join(',');
  throw new Error(
    `Refusing migration because pending migrations (${display(pending)}) do not exactly match expected (${display(expected)}).`,
  );
}

async function inspectJournalUnderLock(client: pg.Client) {
  let transaction = false;
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    transaction = true;
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query('SELECT pg_catalog.pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
    const inspection = await inspectApprovedJournal(client, { lock: true });
    await client.query('COMMIT');
    transaction = false;
    return inspection;
  } finally {
    if (transaction) await client.query('ROLLBACK').catch(() => undefined);
  }
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
  options: CheckedMigrationOptions = {},
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
    const inspection = await inspectJournalUnderLock(client);
    const entries = inspection.entries;
    assertJournalPrefix(entries, migrations);
    if (entries.length === 0 && await hasApplicationOwnedPublicObjects(client)) {
      throw new Error(
        'Refusing to execute the baseline on a database that already contains application-owned public objects; use the guarded baseline-adoption workflow.',
      );
    }
    const pending = migrations.slice(entries.length).map((migration) => migration.tag);
    assertExpectedPendingMigrations(pending, options.expectedPending);
    process.stdout.write(`[db:migrate] pending=${pending.length === 0 ? 'none' : pending.join(',')}\n`);
    if (pending.length === 0) return { pending, applied: [], noOp: true };

    await migrate(drizzle(client), { migrationsFolder: migrationsDirectory });
    const postEntries = (await inspectJournalUnderLock(client)).entries;
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

export async function assertCheckedMigrationsCurrent(
  connectionString: string,
  migrationsDirectory = ACTIVE_MIGRATIONS_DIRECTORY,
): Promise<void> {
  const migrations = loadActiveMigrations(migrationsDirectory);
  const client = new pg.Client({
    connectionString,
    application_name: 'leaguevault-db-migration-state-check',
  });
  try {
    await client.connect();
    const inspection = await inspectJournalUnderLock(client);
    if (!inspection.exists) throw new Error('The approved Drizzle migration journal is absent.');
    assertJournalPrefix(inspection.entries, migrations);
    if (inspection.entries.length !== migrations.length) {
      throw new Error('The database does not contain the complete checked-in active migration history.');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(redactConnectionDetails(message, connectionString));
  } finally {
    await client.end().catch(() => undefined);
  }
}
