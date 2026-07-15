import { pathToFileURL } from 'node:url';
import { runCheckedMigrations } from './lib/db-migration-runner';
import { redactConnectionDetails } from './lib/db-schema-inventory';

export async function migrateConfiguredDatabase(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const connectionString = environment.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required for db:migrate.');
  await runCheckedMigrations(connectionString);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  migrateConfiguredDatabase().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[db:migrate] failed: ${redactConnectionDetails(message, process.env.DATABASE_URL)}\n`);
    process.exitCode = 1;
  });
}
