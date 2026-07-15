import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeMigrationChecksumManifest } from './lib/db-migration-assets';

export function generateMigration(args = process.argv.slice(2)): void {
  const hasName = args.some((argument, index) =>
    argument.startsWith('--name=') || (argument === '--name' && Boolean(args[index + 1])),
  );
  if (!hasName) throw new Error('db:generate requires --name <reviewed_description>.');
  const environment = { ...process.env };
  delete environment.DATABASE_URL;
  const result = spawnSync(
    process.execPath,
    [resolve('node_modules', 'drizzle-kit', 'bin.cjs'), 'generate', ...args],
    {
      encoding: 'utf8',
      env: environment,
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
