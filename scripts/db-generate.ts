import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeMigrationChecksumManifest } from './lib/db-migration-assets';
import {
  isolatedDrizzleEnvironment,
  REVIEWED_DRIZZLE_CONFIG_PATH,
} from './lib/drizzle-cli-environment';

export function parseReviewedMigrationName(args: readonly string[]): string {
  let name: string | undefined;
  if (args.length === 1 && args[0]?.startsWith('--name=')) {
    name = args[0].slice('--name='.length);
  } else if (args.length === 2 && args[0] === '--name') {
    name = args[1];
  }
  if (!name || !/^[a-z0-9][a-z0-9_]*$/.test(name)) {
    throw new Error(
      'db:generate accepts exactly --name <reviewed_description> using lowercase letters, digits, or underscores; config, schema, dialect, and output overrides are refused.',
    );
  }
  return name;
}

export function createGenerateInvocation(
  args: readonly string[],
  sourceEnvironment: NodeJS.ProcessEnv,
): { args: string[]; environment: NodeJS.ProcessEnv } {
  const name = parseReviewedMigrationName(args);
  return {
    args: [
      resolve('node_modules', 'drizzle-kit', 'bin.cjs'),
      'generate',
      '--config',
      REVIEWED_DRIZZLE_CONFIG_PATH,
      '--name',
      name,
    ],
    environment: isolatedDrizzleEnvironment(sourceEnvironment),
  };
}

export function generateMigration(args = process.argv.slice(2)): void {
  const invocation = createGenerateInvocation(args, process.env);
  const result = spawnSync(
    process.execPath,
    invocation.args,
    {
      encoding: 'utf8',
      env: invocation.environment,
      stdio: ['inherit', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    },
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`drizzle-kit generate failed with exit code ${result.status ?? 'unknown'}.`);
  }
  writeMigrationChecksumManifest();
  process.stdout.write('[db:generate] refreshed reviewed active migration checksums\n');
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  try {
    generateMigration();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[db:generate] failed: ${message}\n`);
    process.exitCode = 1;
  }
}
