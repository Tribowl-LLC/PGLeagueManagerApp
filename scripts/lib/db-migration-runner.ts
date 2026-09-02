import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  ACTIVE_MIGRATIONS_DIRECTORY,
  loadActiveMigrations,
  type ActiveMigration,
} from './db-migration-assets';
import {
  assertJournalPrefix,
  inspectApprovedJournal,
} from './db-migration-journal';
import { redactConnectionDetails } from './db-schema-inventory';
import { verifyApprovedSchemaStateOnClient } from './db-schema-state-fingerprint';

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

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function lockPublicRelationsForMigration(client: pg.Client): Promise<void> {
  const relations = await client.query<{ schema_name: string; relation_name: string }>(`
    SELECT namespace.nspname AS schema_name, relation.relname AS relation_name
    FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
    ORDER BY namespace.nspname, relation.relname
  `);
  for (const relation of relations.rows) {
    await client.query(
      `LOCK TABLE ${quoteIdentifier(relation.schema_name)}.${quoteIdentifier(relation.relation_name)} ` +
      'IN ACCESS SHARE MODE',
    );
  }
}

async function runExpectedMigrationsAtomically(
  client: pg.Client,
  connectionString: string,
  migrations: ActiveMigration[],
  expectedPending: readonly string[],
): Promise<CheckedMigrationResult> {
  let transaction = false;
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    transaction = true;
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await lockPublicRelationsForMigration(client);
    const inspection = await inspectApprovedJournal(client, { lock: true });
    const entries = inspection.entries;
    assertJournalPrefix(entries, migrations);
    if (entries.length === 0 && await hasApplicationOwnedPublicObjects(client)) {
      throw new Error(
        'Refusing to execute the baseline on a database that already contains application-owned public objects; use the guarded baseline-adoption workflow.',
      );
    }
    const pendingMigrations = migrations.slice(entries.length);
    const pending = pendingMigrations.map((migration) => migration.tag);
    assertExpectedPendingMigrations(pending, expectedPending);
    const currentMigration = migrations[entries.length - 1];
    if (!currentMigration) {
      throw new Error('Expected-pending migration mode requires a registered baseline before schema-state verification.');
    }
    const fingerprint = await verifyApprovedSchemaStateOnClient(
      client,
      connectionString,
      currentMigration,
    );
    process.stdout.write(
      `[db:migrate] schema-state=${currentMigration.tag} sha256:${fingerprint.digest}\n`,
    );
    process.stdout.write(`[db:migrate] pending=${pending.length === 0 ? 'none' : pending.join(',')}\n`);

    for (const migration of pendingMigrations) {
      for (const statement of migration.sql.split('--> statement-breakpoint')) {
        if (statement.trim()) await client.query(statement);
      }
      await client.query(
        'INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)',
        [migration.hash, migration.createdAt],
      );
    }

    const postEntries = (await inspectApprovedJournal(client, { lock: true })).entries;
    assertJournalPrefix(postEntries, migrations);
    if (postEntries.length !== migrations.length) {
      throw new Error('Migration runner returned without recording the complete active migration history.');
    }
    await client.query('COMMIT');
    transaction = false;
    if (pending.length > 0) process.stdout.write(`[db:migrate] applied=${pending.join(',')}\n`);
    return { pending, applied: pending, noOp: pending.length === 0 };
  } finally {
    if (transaction) await client.query('ROLLBACK').catch(() => undefined);
  }
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
    if (options.expectedPending !== undefined) {
      return await runExpectedMigrationsAtomically(
        client,
        connectionString,
        migrations,
        options.expectedPending,
      );
    }
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
