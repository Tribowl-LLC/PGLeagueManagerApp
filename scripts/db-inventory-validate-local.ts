import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import {
  cleanupOwnedContainer,
  createInventoryRunId,
  inspectOwnedContainer,
  INVENTORY_CONTAINER_LABEL,
  inventoryArtifactDirectory,
  inventoryContainerName,
  parseCreatedContainerId,
  type DockerCommandResult,
  type OwnedInventoryContainer,
} from './lib/db-inventory-container';
import {
  loadTrackedJournalReplayPlan,
  type TrackedMigrationReplay,
} from './lib/db-journal-preflight';
import {
  redactConnectionDetails,
  type DatabaseInventory,
} from './lib/db-schema-inventory';
import {
  assertDatabaseInventory,
  compareDatabaseInventories,
} from './lib/db-schema-compare';

const POSTGRES_USER = 'postgres';
const POSTGRES_PASSWORD = 'leaguevault-inventory-local-only';
const PUSH_DATABASE = 'inventory_push';
const JOURNAL_DATABASE = 'inventory_journal';
const activeConnectionStrings = new Set<string>();

interface RunOptions {
  env?: NodeJS.ProcessEnv;
  sensitiveValues?: string[];
}

function redactKnownConnections(message: string, values: Iterable<string> = []): string {
  let redacted = message;
  for (const value of [...activeConnectionStrings, ...values]) {
    redacted = redactConnectionDetails(redacted, value);
  }
  return redactConnectionDetails(redacted);
}

function run(command: string, args: string[], options: RunOptions = {}): string {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
    throw new Error(
      `${command} ${args[0] ?? ''} failed with exit code ${result.status ?? 'unknown'}` +
        (detail ? `: ${redactKnownConnections(detail, options.sensitiveValues)}` : ''),
    );
  }
  return (result.stdout ?? '').trim();
}

function runDocker(args: string[]): DockerCommandResult {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}

function assertDockerAvailable(): void {
  const result = runDocker(['info']);
  if (result.error || result.status !== 0) {
    throw new Error(
      'Docker is unavailable. Start Docker Desktop, then rerun `npm run db:inventory:validate-local`.',
    );
  }
}

function createOwnedContainer(runId: string): OwnedInventoryContainer {
  const name = inventoryContainerName(runId);
  const output = run('docker', [
    'run',
    '--detach',
    '--rm',
    '--name',
    name,
    '--label',
    `${INVENTORY_CONTAINER_LABEL}=${runId}`,
    '--env',
    `POSTGRES_USER=${POSTGRES_USER}`,
    '--env',
    `POSTGRES_PASSWORD=${POSTGRES_PASSWORD}`,
    '--publish',
    '127.0.0.1::5432',
    'postgres:16',
  ]);
  return { id: parseCreatedContainerId(output), name, runId };
}

async function waitForPostgres(container: OwnedInventoryContainer): Promise<void> {
  inspectOwnedContainer(container, runDocker);
  for (let attempt = 1; attempt <= 45; attempt += 1) {
    const result = runDocker([
      'exec',
      container.id,
      'pg_isready',
      '-U',
      POSTGRES_USER,
      '-d',
      'postgres',
    ]);
    if (!result.error && result.status === 0) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
  throw new Error(`Ephemeral PostgreSQL container ${container.id} was not ready within 45 seconds.`);
}

function publishedPort(container: OwnedInventoryContainer): number {
  inspectOwnedContainer(container, runDocker);
  const result = runDocker(['port', container.id, '5432/tcp']);
  if (result.error || result.status !== 0) {
    throw new Error(`Could not read the loopback port for inventory container ${container.id}.`);
  }
  const match = result.stdout.match(/:(\d+)\s*$/m);
  if (!match) throw new Error('Could not determine the ephemeral PostgreSQL loopback port.');
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('Docker returned an invalid PostgreSQL port.');
  }
  return port;
}

function databaseUrl(port: number, database: string): string {
  const url = new URL('postgresql://127.0.0.1');
  url.username = POSTGRES_USER;
  url.password = POSTGRES_PASSWORD;
  url.port = String(port);
  url.pathname = `/${database}`;
  const value = url.toString();
  activeConnectionStrings.add(value);
  return value;
}

async function createDisposableDatabases(adminUrl: string): Promise<void> {
  const client = new pg.Client({
    connectionString: adminUrl,
    application_name: 'leaguevault-db-inventory-setup',
  });
  try {
    await client.connect();
    await client.query(`CREATE DATABASE ${PUSH_DATABASE}`);
    await client.query(`CREATE DATABASE ${JOURNAL_DATABASE}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

function npmInvocation(args: string[]): { command: string; args: string[] } {
  const npmCli = process.env.npm_execpath;
  if (npmCli) return { command: process.execPath, args: [npmCli, ...args] };
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args };
}

function applyCurrentSchema(pushUrl: string): void {
  const invocation = npmInvocation(['run', 'db:push', '--', '--force']);
  run(invocation.command, invocation.args, {
    env: {
      ...process.env,
      DATABASE_URL: pushUrl,
      NODE_ENV: 'test',
    },
    sensitiveValues: [pushUrl],
  });
}

function runInventoryCommand(databaseUrlValue: string, outputPath: string): void {
  const invocation = npmInvocation(['run', 'db:inventory', '--', '--output', outputPath]);
  run(invocation.command, invocation.args, {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrlValue,
      NODE_ENV: 'test',
    },
    sensitiveValues: [databaseUrlValue],
  });
}

function runComparisonCommand(leftPath: string, rightPath: string, outputPath: string): void {
  const invocation = npmInvocation([
    'run',
    'db:inventory:compare',
    '--',
    leftPath,
    rightPath,
    '--json',
    '--output',
    outputPath,
    '--report-only',
  ]);
  const env = { ...process.env };
  delete env.DATABASE_URL;
  run(invocation.command, invocation.args, { env });
}

function readInventoryArtifact(path: string): DatabaseInventory {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  assertDatabaseInventory(parsed, path);
  return parsed;
}

async function replayTrackedJournal(
  journalUrl: string,
  replayPlan: TrackedMigrationReplay[],
): Promise<string[]> {
  const client = new pg.Client({
    connectionString: journalUrl,
    application_name: 'leaguevault-db-inventory-journal-replay',
  });
  const applied: string[] = [];
  try {
    await client.connect();
    for (const entry of replayPlan) {
      await client.query('BEGIN');
      try {
        for (const statement of entry.statements) await client.query(statement.sql);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
      applied.push(entry.tag);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
  return applied;
}

function assertKnownMismatch(
  pushTableCount: number,
  journalTableCount: number,
  missingFromJournal: string[],
): void {
  const expectedMissing = [
    'public.admin_email_change_audits',
    'public.admin_password_reset_audits',
    'public.admin_profile_edit_audits',
    'public.admin_role_change_audits',
    'public.alerter_state',
    'public.bowler_payment_links',
    'public.league_registration_questions',
    'public.league_registrations',
    'public.league_secretaries',
    'public.league_secretary_audits',
    'public.orphan_cleanup_audits',
    'public.rate_limit_buckets',
  ];
  if (pushTableCount !== 29 || journalTableCount !== 17) {
    throw new Error(
      `Unexpected table counts: db:push=${pushTableCount}, tracked-journal=${journalTableCount}; expected 29 and 17.`,
    );
  }
  if (JSON.stringify(missingFromJournal) !== JSON.stringify(expectedMissing)) {
    throw new Error(
      `The table mismatch changed. Expected ${expectedMissing.join(', ')}; received ${missingFromJournal.join(', ')}.`,
    );
  }
}

export async function validateDatabaseInventoryLocally(): Promise<void> {
  // This reads and validates every journal-selected file before Docker, before
  // either disposable database exists, and before any replay connection opens.
  const replayPlan = loadTrackedJournalReplayPlan();
  assertDockerAvailable();
  const runId = createInventoryRunId();
  const artifactDirectory = inventoryArtifactDirectory(runId);
  let container: OwnedInventoryContainer | null = null;
  let validationError: unknown;
  let cleanupError: unknown;
  let usedFallbackRemoval = false;

  try {
    container = createOwnedContainer(runId);
    inspectOwnedContainer(container, runDocker);
    await waitForPostgres(container);
    const port = publishedPort(container);
    const adminUrl = databaseUrl(port, 'postgres');
    const pushUrl = databaseUrl(port, PUSH_DATABASE);
    const journalUrl = databaseUrl(port, JOURNAL_DATABASE);

    await createDisposableDatabases(adminUrl);
    applyCurrentSchema(pushUrl);
    const appliedJournalTags = await replayTrackedJournal(journalUrl, replayPlan);

    const pushPath = join(artifactDirectory, 'db-push.json');
    const pushRepeatPath = join(artifactDirectory, 'db-push-repeat.json');
    const journalPath = join(artifactDirectory, 'journal-replay.json');
    const comparisonPath = join(artifactDirectory, 'comparison.json');
    runInventoryCommand(pushUrl, pushPath);
    runInventoryCommand(pushUrl, pushRepeatPath);
    runInventoryCommand(journalUrl, journalPath);
    runComparisonCommand(pushPath, journalPath, comparisonPath);

    const pushInventory = readInventoryArtifact(pushPath);
    const pushRepeatInventory = readInventoryArtifact(pushRepeatPath);
    const journalInventory = readInventoryArtifact(journalPath);
    const repeatComparison = compareDatabaseInventories(pushInventory, pushRepeatInventory);
    if (
      repeatComparison.hasDifferences ||
      readFileSync(pushPath, 'utf8') !== readFileSync(pushRepeatPath, 'utf8')
    ) {
      throw new Error('Repeated inventory of an unchanged database was not byte-for-byte deterministic.');
    }
    const comparison = compareDatabaseInventories(pushInventory, journalInventory);
    assertKnownMismatch(
      pushInventory.tables.length,
      journalInventory.tables.length,
      comparison.categories.tables.missingFromRight,
    );
    if (!comparison.hasDifferences) {
      throw new Error('The comparison unexpectedly reported matching schemas.');
    }

    process.stdout.write(
      `[db-inventory-validate-local] run-id=${runId}\n` +
        `[db-inventory-validate-local] replayed ${appliedJournalTags.length} preflighted journal entries without migration-table writes\n` +
        '[db-inventory-validate-local] repeated db:push inventory was byte-for-byte deterministic\n' +
        `[db-inventory-validate-local] db:push tables=${pushInventory.tables.length}; tracked-journal tables=${journalInventory.tables.length}\n` +
        `[db-inventory-validate-local] categorized differences=${comparison.differenceCount}; expected mismatch detected\n` +
        `[db-inventory-validate-local] artifacts=${artifactDirectory}\n`,
    );
  } catch (error) {
    validationError = error;
  } finally {
    if (container) {
      try {
        const cleanup = cleanupOwnedContainer(container, runDocker);
        usedFallbackRemoval = cleanup.usedFallbackRemoval;
      } catch (error) {
        cleanupError = error;
      }
    }
  }

  if (usedFallbackRemoval) {
    process.stderr.write('[db-inventory-validate-local] graceful stop failed; verified fallback removal succeeded.\n');
  }
  if (cleanupError) {
    const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    if (validationError) {
      const validationMessage = validationError instanceof Error ? validationError.message : String(validationError);
      throw new Error(
        `Validation failed: ${redactKnownConnections(validationMessage)} Cleanup also failed: ${cleanupMessage}`,
      );
    }
    throw cleanupError;
  }
  if (validationError) throw validationError;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  validateDatabaseInventoryLocally().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[db-inventory-validate-local] failed: ${redactKnownConnections(message)}\n`,
    );
    process.exitCode = 1;
  });
}
