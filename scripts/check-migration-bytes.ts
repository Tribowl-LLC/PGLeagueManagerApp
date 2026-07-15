import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadActiveMigrations } from './lib/db-migration-assets';

const REQUIRED_ATTRIBUTES = [
  'migrations/*.sql text eol=lf',
  'tests/fixtures/migrations/*.sql text eol=lf',
] as const;

function assertLfUtf8(path: string, label: string): void {
  const bytes = readFileSync(path);
  if (bytes.includes(0x0d)) {
    throw new Error(`${label} contains a carriage-return byte; migration SQL must use exact LF bytes.`);
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} contains invalid UTF-8 bytes.`);
  }
}

function sqlFilesRecursively(directory: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) files.push(...sqlFilesRecursively(path));
    else if (name.endsWith('.sql')) files.push(path);
  }
  return files.sort();
}

export function checkMigrationBytes(rootDirectory = resolve('.')): void {
  const root = resolve(rootDirectory);
  const attributes = readFileSync(join(root, '.gitattributes'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  for (const rule of REQUIRED_ATTRIBUTES) {
    if (!attributes.includes(rule)) throw new Error(`.gitattributes is missing required rule: ${rule}`);
  }

  const activeMigrations = loadActiveMigrations(join(root, 'migrations'));
  for (const migration of activeMigrations) {
    assertLfUtf8(migration.path, `Active migration ${migration.tag}`);
  }

  const fixtureDirectory = join(root, 'tests', 'fixtures', 'migrations');
  for (const path of sqlFilesRecursively(fixtureDirectory)) {
    assertLfUtf8(path, `Migration fixture ${path.slice(root.length + 1)}`);
  }
}

function parseRoot(args: string[]): string {
  if (args.length === 0) return resolve('.');
  if (args.length === 2 && args[0] === '--root' && args[1]) return resolve(args[1]);
  throw new Error('Usage: tsx scripts/check-migration-bytes.ts [--root <checkout-root>]');
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  try {
    checkMigrationBytes(parseRoot(process.argv.slice(2)));
    process.stdout.write('[check-migration-bytes] active and fixture migration SQL uses exact LF UTF-8 bytes\n');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[check-migration-bytes] failed: ${message}\n`);
    process.exitCode = 1;
  }
}
