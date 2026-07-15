import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertApprovedBaselineFingerprint,
  createBaselineFingerprint,
  serializeBaselineFingerprint,
} from './lib/db-baseline-fingerprint';
import {
  assertExpectedConnectionUrlTarget,
  collectDatabaseInventory,
  parseRequiredExpectedTargetEnvironment,
  redactConnectionDetails,
  type ExpectedDatabaseTarget,
} from './lib/db-schema-inventory';

interface FingerprintOptions {
  output: string | null;
  verify: boolean;
  requireExpectedTarget: boolean;
  help: boolean;
}

function usage(): string {
  return [
    'Usage: npm run db:fingerprint -- [--output <path>] [--verify] [--require-expected-target]',
    'Collects only PostgreSQL catalog state and the approved Drizzle journal in a repeatable-read, read-only transaction.',
  ].join('\n');
}

export function parseFingerprintOptions(args: string[]): FingerprintOptions {
  let output: string | null = null;
  let verify = false;
  let requireExpectedTarget = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') {
      process.stdout.write(`${usage()}\n`);
      return { output: null, verify: false, requireExpectedTarget: false, help: true };
    }
    if (argument === '--output') {
      const value = args[index + 1];
      if (!value) throw new Error('--output requires a path.');
      output = resolve(value);
      index += 1;
      continue;
    }
    if (argument === '--verify') {
      verify = true;
      continue;
    }
    if (argument === '--require-expected-target') {
      requireExpectedTarget = true;
      continue;
    }
    throw new Error(`Unknown db:fingerprint option: ${argument ?? ''}`);
  }
  return { output, verify, requireExpectedTarget, help: false };
}

export async function fingerprintConfiguredDatabase(
  args = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const options = parseFingerprintOptions(args);
  if (options.help) return;
  const connectionString = environment.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required for db:fingerprint.');
  let expectedTarget: ExpectedDatabaseTarget | undefined;
  if (options.requireExpectedTarget) {
    expectedTarget = parseRequiredExpectedTargetEnvironment(environment).expectedTarget;
    assertExpectedConnectionUrlTarget(connectionString, expectedTarget);
  }
  const inventory = await collectDatabaseInventory(connectionString, { expectedTarget });
  const fingerprint = createBaselineFingerprint(inventory);
  if (options.verify) assertApprovedBaselineFingerprint(fingerprint);
  const serialized = serializeBaselineFingerprint(fingerprint);
  if (options.output) {
    mkdirSync(dirname(options.output), { recursive: true });
    writeFileSync(options.output, serialized, { encoding: 'utf8', flag: 'wx' });
    process.stdout.write(`[db:fingerprint] wrote sha256:${fingerprint.digest} to ${options.output}\n`);
  } else {
    process.stdout.write(serialized);
  }
  if (options.verify) process.stdout.write('[db:fingerprint] approved baseline fingerprint verified\n');
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  fingerprintConfiguredDatabase().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[db:fingerprint] failed: ${redactConnectionDetails(message, process.env.DATABASE_URL)}\n`);
    process.exitCode = 1;
  });
}
