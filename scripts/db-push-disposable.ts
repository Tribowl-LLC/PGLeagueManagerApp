import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertSafeDatabaseHost } from '../server/utils/db-safety';
import { redactConnectionDetails } from './lib/db-schema-inventory';

export function pushDisposableDatabase(
  args = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (!environment.DATABASE_URL) throw new Error('DATABASE_URL is required for db:push:disposable.');
  if (
    environment.APP_ENV?.trim().toLowerCase() === 'prod' ||
    environment.NODE_ENV?.trim().toLowerCase() === 'production' ||
    Boolean(environment.REPLIT_DEPLOYMENT?.trim())
  ) {
    throw new Error('db:push:disposable is disabled in production-shaped environments.');
  }
  assertSafeDatabaseHost('db:push:disposable');
  const command = process.execPath;
  const result = spawnSync(command, [resolve('node_modules', 'drizzle-kit', 'bin.cjs'), 'push', ...args], {
    encoding: 'utf8',
    env: environment,
    stdio: ['inherit', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  });
  if (result.stdout) process.stdout.write(redactConnectionDetails(result.stdout, environment.DATABASE_URL));
  if (result.stderr) process.stderr.write(redactConnectionDetails(result.stderr, environment.DATABASE_URL));
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`drizzle-kit push failed with exit code ${result.status ?? 'unknown'}.`);
  }
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  try {
    pushDisposableDatabase();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[db:push:disposable] failed: ${redactConnectionDetails(message, process.env.DATABASE_URL)}\n`,
    );
    process.exitCode = 1;
  }
}
