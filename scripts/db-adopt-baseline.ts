import { pathToFileURL } from 'node:url';
import {
  adoptExistingDatabaseBaseline,
  parseAdoptionEnvironment,
} from './lib/db-baseline-adoption';
import { redactConnectionDetails } from './lib/db-schema-inventory';

export async function adoptConfiguredDatabaseBaseline(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const connectionString = environment.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required for db:adopt-baseline.');
  const request = parseAdoptionEnvironment(environment);
  const result = await adoptExistingDatabaseBaseline(connectionString, request);
  process.stdout.write(
    result.status === 'adopted'
      ? `[db:adopt-baseline] registered ${result.baselineTag}; baseline DDL was not executed\n`
      : `[db:adopt-baseline] ${result.baselineTag} already registered exactly; no-op\n`,
  );
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  adoptConfiguredDatabaseBaseline().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[db:adopt-baseline] failed: ${redactConnectionDetails(message, process.env.DATABASE_URL)}\n`,
    );
    process.exitCode = 1;
  });
}
