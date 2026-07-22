import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeMigrationChecksumManifest } from './lib/db-migration-assets';
import {
  isolatedDrizzleEnvironment,
  REVIEWED_DRIZZLE_CONFIG_PATH,
} from './lib/drizzle-cli-environment';

export function parseReviewedMigrationArgs(args: readonly string[]): {
  name: string;
  custom: boolean;
} {
  const custom = args.includes('--custom');
  const nameArgs = args.filter((argument) => argument !== '--custom');
  let name: string | undefined;
  if (nameArgs.length === 1 && nameArgs[0]?.startsWith('--name=')) {
    name = nameArgs[0].slice('--name='.length);
  } else if (nameArgs.length === 2 && nameArgs[0] === '--name') {
    name = nameArgs[1];
  }
  if (!name || !/^[a-z0-9][a-z0-9_]*$/.test(name)) {
    throw new Error(
      'db:generate accepts exactly --name <reviewed_description> using lowercase letters, digits, or underscores; config, schema, dialect, and output overrides are refused.',
    );
  }
  if (args.filter((argument) => argument === '--custom').length > 1) {
    throw new Error('db:generate accepts --custom at most once.');
  }
  return { name, custom };
}

export function parseReviewedMigrationName(args: readonly string[]): string {
  return parseReviewedMigrationArgs(args).name;
}

export function createGenerateInvocation(
  args: readonly string[],
  sourceEnvironment: NodeJS.ProcessEnv,
): { args: string[]; environment: NodeJS.ProcessEnv } {
  const { name, custom } = parseReviewedMigrationArgs(args);
  return {
    args: [
      resolve('node_modules', 'drizzle-kit', 'bin.cjs'),
      'generate',
      '--config',
      REVIEWED_DRIZZLE_CONFIG_PATH,
      '--name',
      name,
      ...(custom ? ['--custom'] : []),
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
