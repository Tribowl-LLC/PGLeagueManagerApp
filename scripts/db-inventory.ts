import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  collectDatabaseInventory,
  parseMigrationJournalRelation,
  redactConnectionDetails,
  serializeDatabaseInventory,
  type MigrationJournalRelation,
} from './lib/db-schema-inventory';

interface InventoryArguments {
  output: string | null;
  migrationJournalRelation: MigrationJournalRelation | null;
}

function usage(): string {
  return [
    'Usage: npm run db:inventory -- [--output <path>] [--journal-relation <schema.table>]',
    '',
    'Reads DATABASE_URL from the environment and collects PostgreSQL catalog state',
    'inside a repeatable-read, read-only transaction. The connection URL is never',
    'written to the inventory or printed.',
    '',
    'The approved migration journal defaults to drizzle.__drizzle_migrations.',
    'Use --journal-relation only for a separately verified alternate relation.',
  ].join('\n');
}

function parseArguments(args: string[]): InventoryArguments {
  let output: string | null = null;
  let migrationJournalRelation: MigrationJournalRelation | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${usage()}\n`);
      process.exitCode = 0;
      return { output: null, migrationJournalRelation: null };
    }
    if (arg === '--output') {
      const value = args[index + 1];
      if (!value) throw new Error('--output requires a path.');
      output = value;
      index += 1;
      continue;
    }
    if (arg === '--journal-relation') {
      const value = args[index + 1];
      if (!value) throw new Error('--journal-relation requires a schema.relation value.');
      migrationJournalRelation = parseMigrationJournalRelation(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { output, migrationJournalRelation };
}

export async function runDatabaseInventory(args = process.argv.slice(2)): Promise<void> {
  const parsed = parseArguments(args);
  if (args.includes('--help') || args.includes('-h')) return;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL must be set.');

  const inventory = await collectDatabaseInventory(connectionString, {
    migrationJournalRelation: parsed.migrationJournalRelation ?? undefined,
  });
  const serialized = serializeDatabaseInventory(inventory);
  if (parsed.output === null) {
    process.stdout.write(serialized);
    return;
  }

  const outputPath = resolve(parsed.output);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serialized, { encoding: 'utf8', flag: 'w' });
  process.stderr.write(
    `[db-inventory] wrote normalized inventory for database=${inventory.target.database} ` +
      `role=${inventory.target.role} host=${inventory.target.hostFingerprint} to ${outputPath}\n`,
  );
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  runDatabaseInventory().catch((error: unknown) => {
    const connectionString = process.env.DATABASE_URL;
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[db-inventory] failed: ${redactConnectionDetails(message, connectionString)}\n`);
    process.exitCode = 1;
  });
}
