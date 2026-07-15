import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  collectDatabaseInventory,
  parseMigrationJournalRelation,
  parseRequiredExpectedTargetEnvironment,
  redactConnectionDetails,
  serializeDatabaseInventory,
  type MigrationJournalRelation,
} from './lib/db-schema-inventory';

interface InventoryArguments {
  output: string | null;
  migrationJournalRelation: MigrationJournalRelation | null;
  requireExpectedTarget: boolean;
}

function usage(): string {
  return [
    'Usage: npm run db:inventory -- [--output <path>] [--journal-relation <schema.table>] [--require-expected-target]',
    '',
    'Reads DATABASE_URL from the environment and collects PostgreSQL catalog state',
    'inside a repeatable-read, read-only transaction. The connection URL is never',
    'written to the inventory or printed.',
    '',
    'The approved migration journal defaults to drizzle.__drizzle_migrations.',
    'Use --journal-relation only for a separately verified alternate relation.',
    '',
    '--require-expected-target is mandatory for a disposable Neon branch. It',
    'requires the documented expected database, role, endpoint fingerprint,',
    'disposable branch, and production source branch environment variables.',
  ].join('\n');
}

function parseArguments(args: string[]): InventoryArguments {
  let output: string | null = null;
  let migrationJournalRelation: MigrationJournalRelation | null = null;
  let requireExpectedTarget = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${usage()}\n`);
      process.exitCode = 0;
      return { output: null, migrationJournalRelation: null, requireExpectedTarget: false };
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
    if (arg === '--require-expected-target') {
      requireExpectedTarget = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { output, migrationJournalRelation, requireExpectedTarget };
}

export async function runDatabaseInventory(args = process.argv.slice(2)): Promise<void> {
  const parsed = parseArguments(args);
  if (args.includes('--help') || args.includes('-h')) return;
  if (parsed.requireExpectedTarget && parsed.output === null) {
    throw new Error('--require-expected-target also requires --output so target metadata is not printed.');
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL must be set.');
  const requiredExpectedTarget = parsed.requireExpectedTarget
    ? parseRequiredExpectedTargetEnvironment(process.env)
    : null;

  const inventory = await collectDatabaseInventory(connectionString, {
    migrationJournalRelation: parsed.migrationJournalRelation ?? undefined,
    expectedTarget: requiredExpectedTarget?.expectedTarget,
  });
  const serialized = serializeDatabaseInventory(inventory);
  if (parsed.output === null) {
    process.stdout.write(serialized);
    return;
  }

  const outputPath = resolve(parsed.output);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serialized, { encoding: 'utf8', flag: 'w' });
  process.stderr.write(`[db-inventory] wrote normalized inventory to ${outputPath}\n`);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  runDatabaseInventory().catch((error: unknown) => {
    const connectionString = process.env.DATABASE_URL;
    const message = error instanceof Error ? error.message : String(error);
    let redacted = redactConnectionDetails(message, connectionString);
    for (const key of [
      'DB_INVENTORY_EXPECTED_DATABASE',
      'DB_INVENTORY_EXPECTED_ROLE',
      'DB_INVENTORY_EXPECTED_HOST_FINGERPRINT',
      'DB_INVENTORY_EXPECTED_NEON_BRANCH_ID',
      'DB_INVENTORY_EXPECTED_NEON_SOURCE_BRANCH_ID',
    ]) {
      const value = process.env[key]?.trim();
      if (value) redacted = redacted.replaceAll(value, '[target metadata redacted]');
    }
    process.stderr.write(`[db-inventory] failed: ${redacted}\n`);
    process.exitCode = 1;
  });
}
