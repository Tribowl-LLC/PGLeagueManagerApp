import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  defaultDisposableTargetRuntime,
  readDisposableTargetProof,
  verifyOwnedLocalDisposableTarget,
  type DisposableTargetProof,
  type DisposableTargetRuntime,
} from './lib/db-disposable-target';
import {
  isolatedDrizzleEnvironment,
  REVIEWED_DRIZZLE_CONFIG_PATH,
} from './lib/drizzle-cli-environment';
import { redactConnectionDetails } from './lib/db-schema-inventory';
import { hasProductionDeploymentEvidence } from '../server/utils/db-safety';

export interface PushCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface PushDisposableRuntime extends DisposableTargetRuntime {
  spawnPush(command: string, args: string[], environment: NodeJS.ProcessEnv): PushCommandResult;
}

export interface PushDisposableRequest {
  targetUrl: string;
  proof: DisposableTargetProof;
  args?: string[];
  environment?: NodeJS.ProcessEnv;
}

const defaultPushDisposableRuntime: PushDisposableRuntime = {
  ...defaultDisposableTargetRuntime,
  spawnPush(command, args, environment) {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      env: environment,
      stdio: ['inherit', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      error: result.error,
    };
  },
};

function assertNonProductionEnvironment(environment: NodeJS.ProcessEnv): void {
  if (hasProductionDeploymentEvidence(environment)) {
    throw new Error('db:push:disposable is disabled in production-shaped environments.');
  }
}

function assertSafePushArguments(args: readonly string[]): void {
  if (args.some((argument) => argument !== '--force') || new Set(args).size !== args.length) {
    throw new Error(
      'db:push:disposable accepts only one optional --force flag; target or config overrides are refused.',
    );
  }
}

export async function pushDisposableDatabase(
  request: PushDisposableRequest,
  runtime: PushDisposableRuntime = defaultPushDisposableRuntime,
): Promise<void> {
  const targetUrl = request.targetUrl;
  const baseEnvironment = request.environment ?? process.env;
  if (baseEnvironment.DATABASE_URL !== undefined && baseEnvironment.DATABASE_URL !== targetUrl) {
    throw new Error('Refusing db:push because the validated and executed DATABASE_URL values differ.');
  }
  assertNonProductionEnvironment(baseEnvironment);
  const executionEnvironment = isolatedDrizzleEnvironment(baseEnvironment, targetUrl);
  const args = request.args ?? [];
  assertSafePushArguments(args);

  // The exact same immutable string is used for the Docker/database proof and
  // for the child process. Broad host allowlists and DEV_DB_OK are deliberately
  // irrelevant to this command.
  await verifyOwnedLocalDisposableTarget(targetUrl, request.proof, runtime);

  const command = process.execPath;
  const result = runtime.spawnPush(
    command,
    [
      resolve('node_modules', 'drizzle-kit', 'bin.cjs'),
      'push',
      '--config',
      REVIEWED_DRIZZLE_CONFIG_PATH,
      ...args,
    ],
    executionEnvironment,
  );
  if (result.stdout) process.stdout.write(redactConnectionDetails(result.stdout, targetUrl));
  if (result.stderr) process.stderr.write(redactConnectionDetails(result.stderr, targetUrl));
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`drizzle-kit push failed with exit code ${result.status ?? 'unknown'}.`);
  }
}

async function main(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const targetUrl = environment.DATABASE_URL;
  if (!targetUrl) throw new Error('DATABASE_URL is required for db:push:disposable.');
  const proof = readDisposableTargetProof(environment);
  await pushDisposableDatabase({
    targetUrl,
    proof,
    args: process.argv.slice(2),
    environment,
  });
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[db:push:disposable] failed: ${redactConnectionDetails(message, process.env.DATABASE_URL)}\n`,
    );
    process.exitCode = 1;
  });
}
