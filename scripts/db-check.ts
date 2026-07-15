import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import {
  APPROVED_INVARIANT_FUNCTION_SQL,
  APPROVED_INVARIANT_TRIGGER_SQL,
} from '../shared/database-invariants';
import {
  ADOPTION_CONFIRMATION,
  adoptExistingDatabaseBaseline,
  BACKUP_ATTESTATION,
  type AdoptionRequest,
} from './lib/db-baseline-adoption';
import {
  assertApprovedBaselineFingerprint,
  createBaselineFingerprint,
} from './lib/db-baseline-fingerprint';
import {
  ACTIVE_MIGRATIONS_DIRECTORY,
  baselineMigration,
  loadActiveMigrations,
  writeMigrationChecksumManifest,
} from './lib/db-migration-assets';
import { runCheckedMigrations } from './lib/db-migration-runner';
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
  collectDatabaseInventory,
  fingerprintDatabaseHost,
  redactConnectionDetails,
} from './lib/db-schema-inventory';

const POSTGRES_USER = 'postgres';
const POSTGRES_PASSWORD = 'leaguevault-db-check-local-only';
const SOURCE_COMMIT = '0000000000000000000000000000000000000000';
const activeConnectionStrings = new Set<string>();

interface CheckOptions {
  postgresVersions: Array<'16' | '17'>;
}

interface ProofMetadata {
  tag: string;
  createdAt: number;
}

function parseOptions(args: string[]): CheckOptions {
  const versions: Array<'16' | '17'> = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--postgres-version') {
      const version = args[index + 1];
      if (version !== '16' && version !== '17') {
        throw new Error('--postgres-version must be 16 or 17.');
      }
      versions.push(version);
      index += 1;
      continue;
    }
    throw new Error(`Unknown db:check option: ${argument ?? ''}`);
  }
  return { postgresVersions: versions.length > 0 ? versions : ['16', '17'] };
}

function redact(message: string): string {
  let redacted = message;
  for (const connectionString of activeConnectionStrings) {
    redacted = redactConnectionDetails(redacted, connectionString);
  }
  return redactConnectionDetails(redacted);
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
    throw new Error('Docker is unavailable. Start Docker Desktop, then rerun `npm run db:check`.');
  }
}

function run(command: string, args: string[], environment = process.env): string {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
    throw new Error(
      `${command} ${args[0] ?? ''} failed with exit code ${result.status ?? 'unknown'}` +
      (detail ? `: ${redact(detail)}` : ''),
    );
  }
  return (result.stdout ?? '').trim();
}

function createContainer(runId: string, version: '16' | '17'): OwnedInventoryContainer {
  const name = inventoryContainerName(`${runId}-${version}`);
  const output = run('docker', [
    'run',
    '--detach',
    '--rm',
    '--name',
    name,
    '--label',
    `${INVENTORY_CONTAINER_LABEL}=${runId}-${version}`,
    '--env',
    `POSTGRES_USER=${POSTGRES_USER}`,
    '--env',
    `POSTGRES_PASSWORD=${POSTGRES_PASSWORD}`,
    '--publish',
    '127.0.0.1::5432',
    `postgres:${version}`,
  ]);
  return { id: parseCreatedContainerId(output), name, runId: `${runId}-${version}` };
}

async function waitForPostgres(container: OwnedInventoryContainer): Promise<void> {
  inspectOwnedContainer(container, runDocker);
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const result = runDocker(['exec', container.id, 'pg_isready', '-U', POSTGRES_USER, '-d', 'postgres']);
    if (!result.error && result.status === 0) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
  throw new Error(`Ephemeral PostgreSQL ${container.id} was not ready within 60 seconds.`);
}

function publishedPort(container: OwnedInventoryContainer): number {
  inspectOwnedContainer(container, runDocker);
  const result = runDocker(['port', container.id, '5432/tcp']);
  const match = result.stdout.match(/:(\d+)\s*$/m);
  if (result.error || result.status !== 0 || !match) {
    throw new Error('Could not determine the db:check PostgreSQL loopback port.');
  }
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('Docker returned an invalid db:check PostgreSQL port.');
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

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(identifier)) throw new Error('Unsafe disposable database identifier.');
  return `"${identifier}"`;
}

async function createDatabase(adminUrl: string, database: string, template?: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl, application_name: 'leaguevault-db-check-setup' });
  try {
    await client.connect();
    const templateClause = template ? ` TEMPLATE ${quoteIdentifier(template)}` : '';
    await client.query(`CREATE DATABASE ${quoteIdentifier(database)}${templateClause}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function executeSql(connectionString: string, statements: readonly string[]): Promise<void> {
  const client = new pg.Client({ connectionString, application_name: 'leaguevault-db-check-fixture' });
  try {
    await client.connect();
    await client.query('BEGIN');
    try {
      for (const statement of statements) await client.query(statement);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

function npmInvocation(args: string[]): { command: string; args: string[] } {
  const npmCli = process.env.npm_execpath;
  if (npmCli) return { command: process.execPath, args: [npmCli, ...args] };
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args };
}

async function installDeclaredSchema(connectionString: string): Promise<void> {
  const invocation = npmInvocation(['run', 'db:push:disposable', '--', '--force']);
  run(invocation.command, invocation.args, {
    ...process.env,
    DATABASE_URL: connectionString,
    APP_ENV: 'dev',
    NODE_ENV: 'test',
  });
  await executeSql(connectionString, [
    ...APPROVED_INVARIANT_FUNCTION_SQL,
    ...APPROVED_INVARIANT_TRIGGER_SQL,
    'CREATE SCHEMA drizzle',
    `CREATE TABLE drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )`,
  ]);
}

function buildProofMigrationDirectory(artifactDirectory: string): { directory: string; metadata: ProofMetadata } {
  const directory = join(artifactDirectory, 'ordering-proof-migrations');
  cpSync(ACTIVE_MIGRATIONS_DIRECTORY, directory, { recursive: true });
  const metadata = JSON.parse(
    readFileSync(resolve('tests', 'fixtures', 'migrations', 'ordering-proof.json'), 'utf8'),
  ) as ProofMetadata;
  const baseline = baselineMigration();
  if (
    !/^0001_[a-z0-9_]+$/.test(metadata.tag) ||
    !Number.isSafeInteger(metadata.createdAt) ||
    metadata.createdAt <= baseline.createdAt
  ) {
    throw new Error('Ordering-proof fixture metadata is invalid or not ordered after the baseline.');
  }
  const proofSql = readFileSync(resolve('tests', 'fixtures', 'migrations', 'ordering-proof.sql'), 'utf8');
  writeFileSync(join(directory, `${metadata.tag}.sql`), proofSql, 'utf8');
  const journalPath = join(directory, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    version: string;
    dialect: string;
    entries: Array<Record<string, unknown>>;
  };
  journal.entries.push({
    idx: 1,
    version: '7',
    when: metadata.createdAt,
    tag: metadata.tag,
    breakpoints: true,
  });
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, 'utf8');
  const baselineSnapshot = JSON.parse(readFileSync(join(directory, 'meta', '0000_snapshot.json'), 'utf8')) as {
    id: string;
  };
  writeFileSync(join(directory, 'meta', '0001_snapshot.json'), `${JSON.stringify({
    id: '11111111-1111-4111-8111-111111111111',
    prevId: baselineSnapshot.id,
    version: '7',
    dialect: 'postgresql',
    tables: {},
    enums: {},
  }, null, 2)}\n`, 'utf8');
  writeMigrationChecksumManifest(directory);
  loadActiveMigrations(directory);
  return { directory, metadata };
}

function adoptionRequest(connectionString: string, database: string): AdoptionRequest {
  const baseline = baselineMigration();
  return {
    expectedTarget: {
      hostFingerprint: fingerprintDatabaseHost(connectionString),
      database,
      role: POSTGRES_USER,
    },
    environmentClass: 'ci',
    environmentId: `db-check-${database}`,
    expectedEnvironmentId: `db-check-${database}`,
    sourceEnvironmentId: null,
    backupAttestation: BACKUP_ATTESTATION,
    confirmation: ADOPTION_CONFIRMATION,
    expectedCommit: SOURCE_COMMIT,
    expectedBaselineTag: baseline.tag,
    expectedBaselineHash: baseline.hash,
    expectedBaselineCreatedAt: baseline.createdAt,
  };
}

const adoptionRuntime = {
  sourceControlState: () => ({ commit: SOURCE_COMMIT, clean: true }),
};

async function verifiedFingerprint(connectionString: string): Promise<ReturnType<typeof createBaselineFingerprint>> {
  const fingerprint = createBaselineFingerprint(await collectDatabaseInventory(connectionString));
  assertApprovedBaselineFingerprint(fingerprint);
  return fingerprint;
}

async function assertProofMarker(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString, application_name: 'leaguevault-db-check-proof' });
  try {
    await client.connect();
    const result = await client.query<{ exists: boolean }>(`
      SELECT to_regclass('migration_ordering_proof.applied_after_baseline') IS NOT NULL AS exists
    `);
    if (result.rows[0]?.exists !== true) throw new Error('Post-baseline ordering proof marker is absent.');
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function expectAdoptionRefusal(
  adminUrl: string,
  port: number,
  template: string,
  caseIndex: number,
  label: string,
  options: {
    sql?: string[];
    request?: (request: AdoptionRequest) => AdoptionRequest;
  } = {},
): Promise<void> {
  const database = `refusal_${caseIndex}`;
  await createDatabase(adminUrl, database, template);
  const connectionString = databaseUrl(port, database);
  if (options.sql) await executeSql(connectionString, options.sql);
  const baseRequest = adoptionRequest(connectionString, database);
  const request = options.request ? options.request(baseRequest) : baseRequest;
  let refused = false;
  try {
    await adoptExistingDatabaseBaseline(connectionString, request, adoptionRuntime);
  } catch {
    refused = true;
  }
  if (!refused) throw new Error(`Adoption refusal case unexpectedly succeeded: ${label}.`);
}

async function validateVersion(
  version: '16' | '17',
  runId: string,
  artifactDirectory: string,
): Promise<void> {
  let container: OwnedInventoryContainer | null = null;
  let validationError: unknown;
  let cleanupError: unknown;
  try {
    container = createContainer(runId, version);
    inspectOwnedContainer(container, runDocker);
    await waitForPostgres(container);
    const port = publishedPort(container);
    const adminUrl = databaseUrl(port, 'postgres');
    mkdirSync(join(artifactDirectory, `postgres-${version}`), { recursive: true });
    const proof = buildProofMigrationDirectory(join(artifactDirectory, `postgres-${version}`));

    const freshActive = 'fresh_active';
    await createDatabase(adminUrl, freshActive);
    const freshActiveUrl = databaseUrl(port, freshActive);
    const firstRun = await runCheckedMigrations(freshActiveUrl);
    if (firstRun.applied.length !== 1 || firstRun.applied[0] !== baselineMigration().tag) {
      throw new Error('Fresh active migration replay did not apply exactly the baseline.');
    }
    await verifiedFingerprint(freshActiveUrl);
    if (!(await runCheckedMigrations(freshActiveUrl)).noOp) {
      throw new Error('Rerunning db:migrate on a fresh replay was not a no-op.');
    }

    const freshProof = 'fresh_proof';
    await createDatabase(adminUrl, freshProof);
    const freshProofUrl = databaseUrl(port, freshProof);
    const freshProofRun = await runCheckedMigrations(freshProofUrl, proof.directory);
    if (JSON.stringify(freshProofRun.applied) !== JSON.stringify([baselineMigration().tag, proof.metadata.tag])) {
      throw new Error('Fresh proof replay did not apply baseline then proof in order.');
    }
    await assertProofMarker(freshProofUrl);
    const freshProofFingerprint = await verifiedFingerprint(freshProofUrl);
    if (!(await runCheckedMigrations(freshProofUrl, proof.directory)).noOp) {
      throw new Error('Rerunning the proof migration chain was not a no-op.');
    }

    const template = 'adoption_template';
    await createDatabase(adminUrl, template);
    await installDeclaredSchema(databaseUrl(port, template));
    await verifiedFingerprint(databaseUrl(port, template));

    const adoptionDatabase = 'adoption_success';
    await createDatabase(adminUrl, adoptionDatabase, template);
    const adoptionUrl = databaseUrl(port, adoptionDatabase);
    const beforeAdoption = await verifiedFingerprint(adoptionUrl);
    const adopted = await adoptExistingDatabaseBaseline(
      adoptionUrl,
      adoptionRequest(adoptionUrl, adoptionDatabase),
      adoptionRuntime,
    );
    if (adopted.status !== 'adopted') throw new Error('Matching existing database was not adopted.');
    const afterAdoption = await verifiedFingerprint(adoptionUrl);
    if (JSON.stringify(beforeAdoption.structure) !== JSON.stringify(afterAdoption.structure)) {
      throw new Error('Baseline adoption changed application DDL.');
    }
    const adoptionNoOp = await adoptExistingDatabaseBaseline(
      adoptionUrl,
      adoptionRequest(adoptionUrl, adoptionDatabase),
      adoptionRuntime,
    );
    if (adoptionNoOp.status !== 'no-op') throw new Error('Exact adoption rerun was not a safe no-op.');
    const adoptedProofRun = await runCheckedMigrations(adoptionUrl, proof.directory);
    if (JSON.stringify(adoptedProofRun.applied) !== JSON.stringify([proof.metadata.tag])) {
      throw new Error('Adopted database did not skip baseline and apply only the proof migration.');
    }
    await assertProofMarker(adoptionUrl);
    if (!(await runCheckedMigrations(adoptionUrl, proof.directory)).noOp) {
      throw new Error('Adopted proof rerun was not a no-op.');
    }
    const adoptedFinalFingerprint = await verifiedFingerprint(adoptionUrl);
    if (JSON.stringify(freshProofFingerprint.structure) !== JSON.stringify(adoptedFinalFingerprint.structure)) {
      throw new Error('Fresh and adopted final application schemas differ.');
    }

    const baseline = baselineMigration();
    const refusalCases: Array<{
      label: string;
      sql?: string[];
      request?: (request: AdoptionRequest) => AdoptionRequest;
    }> = [
      { label: 'missing table', sql: ['DROP TABLE alerter_state'] },
      { label: 'extra application-owned table', sql: ['CREATE TABLE unexpected_application_table (id integer)'] },
      { label: 'changed column type', sql: ['ALTER TABLE alerter_state ALTER COLUMN last_summary_sent_at TYPE text USING last_summary_sent_at::text'] },
      { label: 'changed nullability', sql: ['ALTER TABLE organizations ALTER COLUMN address SET NOT NULL'] },
      { label: 'changed default', sql: ['ALTER TABLE rate_limit_buckets ALTER COLUMN count SET DEFAULT 1'] },
      { label: 'missing constraint', sql: ['ALTER TABLE alerter_state DROP CONSTRAINT alerter_state_pkey'] },
      { label: 'changed index predicate', sql: [
        'DROP INDEX organization_subdomain_idx',
        'CREATE UNIQUE INDEX organization_subdomain_idx ON organizations (subdomain)',
      ] },
      { label: 'missing trigger', sql: ['DROP TRIGGER users_role_org_required ON users'] },
      { label: 'changed function definition', sql: [
        `CREATE OR REPLACE FUNCTION users_role_org_required_fn() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN RETURN NEW; END; $$`,
      ] },
      { label: 'RLS unexpectedly enabled', sql: ['ALTER TABLE organizations ENABLE ROW LEVEL SECURITY'] },
      { label: 'retired CardPointe column', sql: ['ALTER TABLE locations ADD COLUMN cardpointe_site text'] },
      { label: 'wrong database', request: (request) => ({
        ...request,
        expectedTarget: { ...request.expectedTarget, database: 'wrong_database' },
      }) },
      { label: 'wrong role', request: (request) => ({
        ...request,
        expectedTarget: { ...request.expectedTarget, role: 'wrong_role' },
      }) },
      { label: 'wrong host fingerprint', request: (request) => ({
        ...request,
        expectedTarget: { ...request.expectedTarget, hostFingerprint: `sha256:${'f'.repeat(64)}` },
      }) },
      { label: 'ambiguous journal', sql: [
        'CREATE SCHEMA legacy',
        'CREATE TABLE legacy.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)',
      ] },
      { label: 'unexpected journal row', sql: [
        "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('unexpected', 1)",
      ] },
      { label: 'baseline hash mismatch', sql: [
        `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('${'0'.repeat(64)}', ${baseline.createdAt})`,
      ] },
      { label: 'baseline timestamp mismatch', sql: [
        `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('${baseline.hash}', ${baseline.createdAt + 1})`,
      ] },
      { label: 'missing backup attestation', request: (request) => ({ ...request, backupAttestation: '' }) },
      { label: 'missing operator confirmation', request: (request) => ({ ...request, confirmation: '' }) },
      { label: 'mismatched environment identity', request: (request) => ({
        ...request,
        expectedEnvironmentId: `${request.expectedEnvironmentId}-other`,
      }) },
      { label: 'production-shaped environment identity', request: (request) => ({
        ...request,
        environmentId: 'leaguevault-production-live',
        expectedEnvironmentId: 'leaguevault-production-live',
      }) },
    ];
    for (let index = 0; index < refusalCases.length; index += 1) {
      const refusal = refusalCases[index];
      if (!refusal) throw new Error('Refusal case inventory is incomplete.');
      await expectAdoptionRefusal(adminUrl, port, template, index + 1, refusal.label, refusal);
    }

    process.stdout.write(
      `[db:check] PostgreSQL ${version}: baseline replay, exact fingerprint, adoption, ordering proof, rerun no-op, and ${refusalCases.length} refusal cases passed\n`,
    );
  } catch (error) {
    validationError = error;
  } finally {
    if (container) {
      try {
        cleanupOwnedContainer(container, runDocker);
      } catch (error) {
        cleanupError = error;
      }
    }
  }
  if (cleanupError) {
    const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    if (validationError) {
      const validationMessage = validationError instanceof Error ? validationError.message : String(validationError);
      throw new Error(`Validation failed: ${redact(validationMessage)} Cleanup also failed: ${cleanupMessage}`);
    }
    throw cleanupError;
  }
  if (validationError) throw validationError;
}

function assertDeclaredSchemaHasNoUntrackedChanges(artifactDirectory: string): void {
  const probeDirectory = join(artifactDirectory, 'schema-drift-probe');
  cpSync(ACTIVE_MIGRATIONS_DIRECTORY, probeDirectory, { recursive: true });
  const before = loadActiveMigrations(probeDirectory).length;
  run(process.execPath, [
    resolve('node_modules', 'drizzle-kit', 'bin.cjs'),
    'generate',
    '--name=db_check_drift_probe',
    `--out=${probeDirectory}`,
    '--schema=./shared/schema.ts',
    '--dialect=postgresql',
  ]);
  const after = loadActiveMigrations(probeDirectory).length;
  if (after !== before) {
    throw new Error('shared/schema contains changes without a checked-in active migration.');
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  loadActiveMigrations();
  // Loading the approved file validates its baseline hash, timestamp, object
  // counts, and structural digest before Docker or any database connection.
  const { loadApprovedBaselineFingerprint } = await import('./lib/db-baseline-fingerprint');
  loadApprovedBaselineFingerprint();
  assertDockerAvailable();
  const runId = createInventoryRunId();
  const artifactDirectory = inventoryArtifactDirectory(`db-check-${runId}`);
  mkdirSync(artifactDirectory, { recursive: true });
  assertDeclaredSchemaHasNoUntrackedChanges(artifactDirectory);
  for (const version of options.postgresVersions) {
    await validateVersion(version, runId, artifactDirectory);
  }
  process.stdout.write(
    `[db:check] active migration metadata, declared-schema drift, PostgreSQL ${options.postgresVersions.join('/')}, and approved fingerprint checks passed\n`,
  );
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[db:check] failed: ${redact(message)}\n`);
    process.exitCode = 1;
  });
}
