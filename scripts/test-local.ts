/**
 * Run the complete local Vitest suite against an isolated PostgreSQL 16
 * container. This mirrors the CI Tests job and is intentionally cross-platform
 * so Windows contributors do not need Bash or a manually-exported env file.
 *
 * The container and its template database are kept between runs. Vitest owns
 * cleanup of per-worker databases; keeping the container warm makes reruns
 * much faster while retaining a fixed local-only connection target.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { delimiter, dirname, join } from 'node:path';

const CONTAINER_NAME = process.env.LV_TEST_DB_CONTAINER ?? 'leaguevault-test-postgres';
const DB_NAME = 'leaguevault_test';
const DB_URL = `postgres://postgres:postgres@127.0.0.1:5432/${DB_NAME}`;
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
const npmCli = process.env.npm_execpath ??
  (process.platform === 'win32'
    ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : undefined);
const npmCommand = npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmArgs = (args: string[]): string[] => (npmCli ? [npmCli, ...args] : args);

const testEnv: NodeJS.ProcessEnv = {
  ...process.env,
  DATABASE_URL: DB_URL,
  APP_ENV: 'dev',
  NODE_ENV: 'development',
  TZ: 'UTC',
  PORT: '5000',
  SESSION_SECRET: process.env.SESSION_SECRET ?? 'local-test-session-secret-not-production',
  FIELD_ENCRYPTION_KEY:
    process.env.FIELD_ENCRYPTION_KEY ??
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  SETUP_SECRET:
    process.env.SETUP_SECRET ?? 'local-test-setup-secret-deterministic-not-production',
  npm_node_execpath: process.execPath,
  PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
};

function run(command: string, args: string[], env = testEnv): void {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env,
    windowsHide: true,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with code ${result.status ?? 'unknown'}`);
  }
}

function capture(command: string, args: string[]): string | null {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

function assertDockerAvailable(): void {
  if (spawnSync('docker', ['info'], { stdio: 'ignore', windowsHide: true }).status !== 0) {
    throw new Error(
      'Docker is unavailable. Start Docker Desktop, then rerun `npm run test:local`.',
    );
  }
}

async function ensurePostgresContainer(): Promise<void> {
  const state = capture('docker', ['inspect', '--format', '{{.State.Running}}', CONTAINER_NAME]);
  if (state === null) {
    run('docker', [
      'run', '--detach', '--name', CONTAINER_NAME,
      '--env', 'POSTGRES_USER=postgres',
      '--env', 'POSTGRES_PASSWORD=postgres',
      '--env', `POSTGRES_DB=${DB_NAME}`,
      '--publish', '5432:5432',
      'postgres:16',
    ]);
  } else if (state !== 'true') {
    run('docker', ['start', CONTAINER_NAME]);
  }

  for (let attempt = 1; attempt <= 30; attempt += 1) {
    if (spawnSync(
      'docker',
      ['exec', CONTAINER_NAME, 'pg_isready', '-U', 'postgres', '-d', DB_NAME],
      { stdio: 'ignore', windowsHide: true },
    ).status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`PostgreSQL container ${CONTAINER_NAME} did not become ready within 30 seconds.`);
}

async function waitForDevServer(): Promise<void> {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    try {
      const response = await fetch('http://127.0.0.1:5000/api/health');
      if (response.ok) return;
    } catch {
      // The dev server may still be booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('The local dev server did not become healthy within 120 seconds.');
}

function stopProcess(child: ChildProcess): void {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    child.kill('SIGTERM');
  }
}

async function main(): Promise<void> {
  if (nodeMajor !== 22 || nodeMinor < 22) {
    throw new Error(
      `This repository requires Node 22.22+ and <23 (current: ${process.version}). Install/switch to the version in .node-version before running local tests.`,
    );
  }

  assertDockerAvailable();
  await ensurePostgresContainer();

  console.log('[test-local] applying checked-in migrations...');
  run(npmCommand, npmArgs(['run', 'db:migrate']));

  let devServer: ChildProcess | null = null;
  try {
    // The Vitest projects provision their own isolated Express workers, so
    // the ordinary dev server is not required for the complete suite. It is
    // available when a developer wants an API server alongside the run.
    if (process.env.TEST_LOCAL_START_DEV_SERVER === '1') {
      console.log('[test-local] starting dev server');
      devServer = spawn(npmCommand, npmArgs(['run', 'dev']), {
        env: testEnv,
        stdio: 'inherit',
        windowsHide: true,
        shell: false,
      });
      await waitForDevServer();
    }
    console.log('[test-local] running full Vitest suite...');
    run(npmCommand, npmArgs(['test']));
  } finally {
    if (devServer !== null) stopProcess(devServer);
  }
}

main().catch((error: unknown) => {
  console.error('[test-local] failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
