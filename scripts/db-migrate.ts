import { pathToFileURL } from 'node:url';
import { parseExpectedPendingMigrations, runCheckedMigrations } from './lib/db-migration-runner';
import { redactConnectionDetails, type ExpectedDatabaseTarget } from './lib/db-schema-inventory';

const EXPECTED_TARGET_KEYS = [
  'DB_MIGRATION_EXPECTED_HOST_FINGERPRINT',
  'DB_MIGRATION_EXPECTED_DATABASE',
  'DB_MIGRATION_EXPECTED_ROLE',
] as const;

export function parseExpectedMigrationTarget(
  environment: NodeJS.ProcessEnv,
  required: boolean,
): ExpectedDatabaseTarget | undefined {
  const values = EXPECTED_TARGET_KEYS.map((key) => environment[key]?.trim() ?? '');
  if (!required && values.every((value) => value.length === 0)) return undefined;
  const missing = EXPECTED_TARGET_KEYS.filter((_key, index) => !values[index]);
  if (missing.length > 0) {
    throw new Error(`Required migration target variable(s) are absent: ${missing.join(', ')}.`);
  }
  const [hostFingerprint, database, role] = values as [string, string, string];
  if (!/^sha256:[0-9a-f]{64}$/.test(hostFingerprint)) {
    throw new Error('DB_MIGRATION_EXPECTED_HOST_FINGERPRINT must be a lowercase SHA-256 fingerprint.');
  }
  return { hostFingerprint, database, role };
}

export async function migrateConfiguredDatabase(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const connectionString = environment.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required for db:migrate.');
  const expectedPending = parseExpectedPendingMigrations(environment.DB_MIGRATION_EXPECTED_PENDING);
  const expectedTarget = parseExpectedMigrationTarget(environment, expectedPending !== undefined);
  await runCheckedMigrations(connectionString, undefined, { expectedPending, expectedTarget });
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  migrateConfiguredDatabase().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[db:migrate] failed: ${redactConnectionDetails(message, process.env.DATABASE_URL)}\n`);
    process.exitCode = 1;
  });
}
