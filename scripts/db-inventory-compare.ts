import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertDatabaseInventory,
  compareDatabaseInventories,
  formatInventoryComparison,
  serializeInventoryComparison,
} from './lib/db-schema-compare';

interface CompareArguments {
  left: string;
  right: string;
  json: boolean;
  output: string | null;
  reportOnly: boolean;
}

function usage(): string {
  return [
    'Usage: npm run db:inventory:compare -- <left.json> <right.json> [options]',
    '',
    'Options:',
    '  --json                 Emit a machine-readable JSON comparison.',
    '  --output <path>        Write the report to a file instead of stdout.',
    '  --report-only          Exit zero even when differences are found.',
  ].join('\n');
}

function parseArguments(args: string[]): CompareArguments | null {
  const positional: string[] = [];
  let json = false;
  let output: string | null = null;
  let reportOnly = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${usage()}\n`);
      return null;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--report-only') {
      reportOnly = true;
      continue;
    }
    if (arg === '--output') {
      const value = args[index + 1];
      if (!value) throw new Error('--output requires a path.');
      output = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`Unknown argument: ${arg}`);
    positional.push(arg);
  }

  if (positional.length !== 2) throw new Error('Exactly two inventory files are required.');
  return { left: positional[0], right: positional[1], json, output, reportOnly };
}

function readInventory(path: string): unknown {
  const resolved = resolve(path);
  try {
    return JSON.parse(readFileSync(resolved, 'utf8')) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read inventory ${resolved}: ${message}`);
  }
}

export function runDatabaseInventoryComparison(args = process.argv.slice(2)): number {
  const parsed = parseArguments(args);
  if (parsed === null) return 0;

  const left = readInventory(parsed.left);
  const right = readInventory(parsed.right);
  assertDatabaseInventory(left, resolve(parsed.left));
  assertDatabaseInventory(right, resolve(parsed.right));

  const comparison = compareDatabaseInventories(left, right);
  const report = parsed.json
    ? serializeInventoryComparison(comparison)
    : formatInventoryComparison(comparison);
  if (parsed.output === null) {
    process.stdout.write(report);
  } else {
    const outputPath = resolve(parsed.output);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, report, { encoding: 'utf8', flag: 'w' });
    process.stderr.write(`[db-inventory-compare] wrote report to ${outputPath}\n`);
  }

  return comparison.hasDifferences && !parsed.reportOnly ? 2 : 0;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  try {
    process.exitCode = runDatabaseInventoryComparison();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[db-inventory-compare] failed: ${message}\n`);
    process.exitCode = 1;
  }
}
