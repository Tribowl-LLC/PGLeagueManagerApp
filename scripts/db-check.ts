import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import {
  APPROVED_INVARIANT_FUNCTION_NAMES,
} from '../shared/database-invariants';
import {
  ADOPTION_CONFIRMATION,
  adoptExistingDatabaseBaseline,
  BACKUP_ATTESTATION,
  preflightProductionDatabaseBaseline,
  PRODUCTION_ENVIRONMENT_CLASS,
  PRODUCTION_JOURNAL_RELATION,
  type AdoptionRequest,
} from './lib/db-baseline-adoption';
import {
  APPLICATION_SEQUENCE_NAMES,
  APPLICATION_TABLE_NAMES,
  assertApprovedBaselineFingerprint,
  createBaselineFingerprint,
  loadApprovedBaselineFingerprint,
  verifyBaselineInventory,
} from './lib/db-baseline-fingerprint';
import {
  ACTIVE_MIGRATIONS_DIRECTORY,
  baselineMigration,
  loadActiveMigrations,
  writeMigrationChecksumManifest,
} from './lib/db-migration-assets';
import { runCheckedMigrations } from './lib/db-migration-runner';
import {
  assertApprovedSchemaStateFingerprint,
  createSchemaStateFingerprint,
  loadApprovedSchemaStateFingerprint,
} from './lib/db-schema-state-fingerprint';
import {
  DISPOSABLE_DATABASE_LABELS,
  DISPOSABLE_DATABASE_OWNER,
  disposableDatabaseMarker,
  encodeDisposableDatabaseLabel,
  type DisposableTargetProof,
} from './lib/db-disposable-target';
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
const SUPPORTED_POSTGRES_VERSIONS = ['17'] as const;
type SupportedPostgresVersion = typeof SUPPORTED_POSTGRES_VERSIONS[number];

interface CheckOptions {
  postgresVersions: SupportedPostgresVersion[];
}

interface ProofMetadata {
  tag: string;
  createdAt: number;
}

interface DbCheckContainer extends OwnedInventoryContainer {
  purpose: string;
}

function parseOptions(args: string[]): CheckOptions {
  const versions: SupportedPostgresVersion[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--postgres-version') {
      const version = args[index + 1];
      const supportedVersion = SUPPORTED_POSTGRES_VERSIONS.find((candidate) => candidate === version);
      if (!supportedVersion) {
        throw new Error(
          `--postgres-version must be one of: ${SUPPORTED_POSTGRES_VERSIONS.join(', ')}.`,
        );
      }
      versions.push(supportedVersion);
      index += 1;
      continue;
    }
    throw new Error(`Unknown db:check option: ${argument ?? ''}`);
  }
  return {
    postgresVersions: versions.length > 0 ? versions : [...SUPPORTED_POSTGRES_VERSIONS],
  };
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

function createContainer(
  runId: string,
  version: SupportedPostgresVersion,
  approvedDatabases: readonly string[],
): DbCheckContainer {
  const ownedRunId = `${runId}-${version}`;
  const purpose = `db-check-${version}`;
  const name = inventoryContainerName(ownedRunId);
  const output = run('docker', [
    'run',
    '--detach',
    '--rm',
    '--name',
    name,
    '--label',
    `${INVENTORY_CONTAINER_LABEL}=${ownedRunId}`,
    '--label',
    `${DISPOSABLE_DATABASE_LABELS.owner}=${DISPOSABLE_DATABASE_OWNER}`,
    '--label',
    `${DISPOSABLE_DATABASE_LABELS.runId}=${ownedRunId}`,
    '--label',
    `${DISPOSABLE_DATABASE_LABELS.purpose}=${purpose}`,
    '--label',
    `${DISPOSABLE_DATABASE_LABELS.databases}=${encodeDisposableDatabaseLabel(approvedDatabases)}`,
    '--env',
    `POSTGRES_USER=${POSTGRES_USER}`,
    '--env',
    `POSTGRES_PASSWORD=${POSTGRES_PASSWORD}`,
    '--publish',
    '127.0.0.1::5432',
    `postgres:${version}`,
  ]);
  return { id: parseCreatedContainerId(output), name, runId: ownedRunId, purpose };
}

async function waitForPostgres(container: OwnedInventoryContainer): Promise<void> {
  inspectOwnedContainer(container, runDocker);
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const result = runDocker(['exec', container.id, 'pg_isready', '-U', POSTGRES_USER, '-d', 'postgres']);
    if (!result.error && result.status === 0) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
  throw new Error('Ephemeral PostgreSQL was not ready within 60 seconds.');
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

function databaseUrlForRole(
  port: number,
  database: string,
  role: string,
  password: string,
): string {
  const url = new URL(databaseUrl(port, database));
  url.username = role;
  url.password = password;
  const value = url.toString();
  activeConnectionStrings.add(value);
  return value;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(identifier)) throw new Error('Unsafe disposable database identifier.');
  return `"${identifier}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function disposableProof(container: DbCheckContainer, database: string): DisposableTargetProof {
  return {
    containerId: container.id,
    runId: container.runId,
    purpose: container.purpose,
    database,
  };
}

async function createDatabase(
  adminUrl: string,
  database: string,
  container: DbCheckContainer,
  template?: string,
): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl, application_name: 'leaguevault-db-check-setup' });
  try {
    await client.connect();
    const templateClause = template ? ` TEMPLATE ${quoteIdentifier(template)}` : '';
    await client.query(`CREATE DATABASE ${quoteIdentifier(database)}${templateClause}`);
    await client.query(
      `COMMENT ON DATABASE ${quoteIdentifier(database)} IS ${quoteLiteral(
        disposableDatabaseMarker(disposableProof(container, database)),
      )}`,
    );
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

async function installBaselineSchema(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  try {
    await client.connect();
    for (const statement of baselineMigration().sql.split('--> statement-breakpoint')) {
      if (statement.trim()) await client.query(statement);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
  await executeSql(connectionString, [
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
  const fixtureMetadata = JSON.parse(
    readFileSync(resolve('tests', 'fixtures', 'migrations', 'ordering-proof.json'), 'utf8'),
  ) as ProofMetadata;
  const activeMigrations = loadActiveMigrations(directory);
  const previousMigration = activeMigrations.at(-1);
  if (!previousMigration) throw new Error('Active migration history is empty.');
  const proofIndex = activeMigrations.length;
  const metadata: ProofMetadata = {
    tag: `${String(proofIndex).padStart(4, '0')}_ordering_proof`,
    createdAt: Math.max(fixtureMetadata.createdAt, previousMigration.createdAt + 1),
  };
  if (
    !/^\d{4}_[a-z0-9_]+$/.test(metadata.tag) ||
    !Number.isSafeInteger(metadata.createdAt) ||
    metadata.createdAt <= previousMigration.createdAt
  ) {
    throw new Error('Ordering-proof fixture metadata is invalid or not ordered after active history.');
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
    idx: proofIndex,
    version: '7',
    when: metadata.createdAt,
    tag: metadata.tag,
    breakpoints: true,
  });
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, 'utf8');
  const previousSnapshot = JSON.parse(readFileSync(
    join(directory, 'meta', `${String(proofIndex - 1).padStart(4, '0')}_snapshot.json`),
    'utf8',
  )) as {
    id: string;
  };
  writeFileSync(join(directory, 'meta', `${String(proofIndex).padStart(4, '0')}_snapshot.json`), `${JSON.stringify({
    id: `11111111-1111-4111-8111-${String(proofIndex).padStart(12, '0')}`,
    prevId: previousSnapshot.id,
    version: '7',
    dialect: 'postgresql',
    tables: {},
    enums: {},
  }, null, 2)}\n`, 'utf8');
  writeMigrationChecksumManifest(directory);
  loadActiveMigrations(directory);
  return { directory, metadata };
}

function buildPreviousMigrationDirectory(artifactDirectory: string): string {
  const directory = join(artifactDirectory, 'previous-state-migrations');
  cpSync(ACTIVE_MIGRATIONS_DIRECTORY, directory, { recursive: true });
  const migrations = loadActiveMigrations(directory);
  if (migrations.length < 2) throw new Error('Schema-state verification requires at least two migrations.');
  const removed = migrations.at(-1);
  if (!removed) throw new Error('Active migration history is empty.');
  unlinkSync(join(directory, `${removed.tag}.sql`));

  const journalPath = join(directory, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: unknown[] };
  journal.entries.pop();
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, 'utf8');
  writeMigrationChecksumManifest(directory);
  return directory;
}

async function assertApprovedSchemaState(
  connectionString: string,
  migrationsDirectory = ACTIVE_MIGRATIONS_DIRECTORY,
): Promise<void> {
  const migration = loadActiveMigrations(migrationsDirectory).at(-1);
  if (!migration) throw new Error('Schema-state verification requires a migration.');
  const actual = createSchemaStateFingerprint(
    await collectDatabaseInventory(connectionString),
    migration,
  );
  assertApprovedSchemaStateFingerprint(actual, loadApprovedSchemaStateFingerprint(migration));
}

async function assertOrganizationHostnameNamespaceGuard(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString, application_name: 'leaguevault-db-check-hostname-guard' });
  try {
    await client.connect();
    const objects = await client.query<{ function_exists: boolean; trigger_exists: boolean }>(`
      SELECT
        to_regprocedure('public.organization_hostname_namespace_guard_fn()') IS NOT NULL
          AS function_exists,
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_trigger t
          JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relname = 'organizations'
            AND t.tgname = 'organization_hostname_namespace_guard'
            AND NOT t.tgisinternal
        ) AS trigger_exists
    `);
    if (!objects.rows[0]?.function_exists || !objects.rows[0]?.trigger_exists) {
      throw new Error('Organization hostname namespace function or trigger is absent.');
    }

    await client.query('BEGIN');
    await client.query(`
      INSERT INTO organizations (name, slug, subdomain)
      VALUES ('db-check-hostname-a', 'dbcheckhostnamea', 'dbcheckshared')
    `);
    await client.query('SAVEPOINT before_collision');
    let collision: { code?: string; constraint?: string } | undefined;
    try {
      await client.query(`
        INSERT INTO organizations (name, slug, subdomain)
        VALUES ('db-check-hostname-b', 'dbcheckshared', 'dbcheckhostnameb')
      `);
    } catch (error) {
      collision = error as { code?: string; constraint?: string };
      await client.query('ROLLBACK TO SAVEPOINT before_collision');
    }
    if (collision?.code !== '23505' || collision.constraint !== 'organization_hostname_namespace_guard') {
      throw new Error('Organization hostname namespace trigger did not reject a cross-field collision.');
    }
    await client.query('ROLLBACK');
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

function adoptionRequest(
  connectionString: string,
  database: string,
  proof: DisposableTargetProof,
  role = POSTGRES_USER,
): AdoptionRequest {
  const baseline = baselineMigration();
  return {
    expectedTarget: {
      hostFingerprint: fingerprintDatabaseHost(connectionString),
      database,
      role,
    },
    environmentClass: 'local-disposable',
    environmentId: `db-check-${database}`,
    expectedEnvironmentId: `db-check-${database}`,
    disposableTargetProof: proof,
    backupAttestation: BACKUP_ATTESTATION,
    confirmation: ADOPTION_CONFIRMATION,
    expectedCommit: SOURCE_COMMIT,
    expectedBaselineTag: baseline.tag,
    expectedBaselineHash: baseline.hash,
    expectedBaselineCreatedAt: baseline.createdAt,
  };
}

function neonAdoptionRequest(connectionString: string, database: string): AdoptionRequest {
  const baseline = baselineMigration();
  return {
    expectedTarget: {
      hostFingerprint: fingerprintDatabaseHost(connectionString),
      database,
      role: POSTGRES_USER,
    },
    environmentClass: 'neon-rehearsal',
    environmentId: `neon-rehearsal-${database}`,
    expectedEnvironmentId: `neon-rehearsal-${database}`,
    neonExpectation: {
      projectId: 'project-rehearsal',
      targetBranchId: 'br-disposable-rehearsal',
      productionBranchId: 'br-production-source',
      endpointId: 'ep-disposable-rehearsal',
    },
    backupAttestation: BACKUP_ATTESTATION,
    confirmation: ADOPTION_CONFIRMATION,
    expectedCommit: SOURCE_COMMIT,
    expectedBaselineTag: baseline.tag,
    expectedBaselineHash: baseline.hash,
    expectedBaselineCreatedAt: baseline.createdAt,
  };
}

function productionAdoptionRequest(connectionString: string, database: string): AdoptionRequest {
  const baseline = baselineMigration();
  const projectId = 'project-production';
  const branchId = 'br-production-primary';
  const endpointId = 'ep-production-primary';
  const environmentId = [PRODUCTION_ENVIRONMENT_CLASS, projectId, branchId, endpointId].join(':');
  return {
    expectedTarget: {
      hostFingerprint: fingerprintDatabaseHost(connectionString),
      database,
      role: POSTGRES_USER,
    },
    environmentClass: PRODUCTION_ENVIRONMENT_CLASS,
    environmentId,
    expectedEnvironmentId: environmentId,
    neonExpectation: {
      projectId,
      targetBranchId: branchId,
      productionBranchId: branchId,
      endpointId,
    },
    backupAttestation: BACKUP_ATTESTATION,
    confirmation: ADOPTION_CONFIRMATION,
    expectedCommit: SOURCE_COMMIT,
    expectedBaselineTag: baseline.tag,
    expectedBaselineHash: baseline.hash,
    expectedBaselineCreatedAt: baseline.createdAt,
    expectedSchemaFingerprint: loadApprovedBaselineFingerprint().digest,
    expectedJournalRelation: PRODUCTION_JOURNAL_RELATION,
    approvalToken: 'a'.repeat(43),
  };
}

async function withNeonProviderFixture<T>(
  connectionString: string,
  action: () => Promise<T>,
  invalidateOnRefresh = false,
): Promise<T> {
  const hostname = new URL(connectionString).hostname.toLowerCase();
  const originalFetch = globalThis.fetch;
  let endpointReads = 0;
  const fixtureFetch: typeof fetch = async (input, init) => {
    const authorization = new Headers(init?.headers).get('authorization');
    if (
      init?.method !== 'GET' ||
      authorization !== 'Bearer db-check-provider-fixture-only'
    ) {
      return new Response('{}', { status: 405, headers: { 'content-type': 'application/json' } });
    }
    const url = String(input);
    let body: unknown;
    if (url.endsWith('/projects/project-rehearsal')) {
      body = { project: { id: 'project-rehearsal' } };
    } else if (url.endsWith('/branches/br-production-source')) {
      body = {
        branch: { id: 'br-production-source', project_id: 'project-rehearsal' },
        annotation: { object: { type: '', id: '' }, value: {} },
      };
    } else if (url.endsWith('/branches/br-disposable-rehearsal')) {
      body = {
        branch: {
          id: 'br-disposable-rehearsal',
          project_id: 'project-rehearsal',
          parent_id: 'br-production-source',
          current_state: 'ready',
          init_source: 'parent-data',
          default: false,
          protected: false,
        },
        annotation: { object: { type: '', id: '' }, value: {} },
      };
    } else if (url.endsWith('/endpoints/ep-disposable-rehearsal')) {
      endpointReads += 1;
      body = {
        endpoint: {
          id: 'ep-disposable-rehearsal',
          project_id: 'project-rehearsal',
          branch_id: invalidateOnRefresh && endpointReads > 1
            ? 'br-production-source'
            : 'br-disposable-rehearsal',
          host: hostname,
          type: 'read_write',
          current_state: 'idle',
          disabled: false,
        },
      };
    } else {
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };
  globalThis.fetch = fixtureFetch;
  try {
    return await action();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function withProductionProviderFixture<T>(
  connectionString: string,
  action: () => Promise<T>,
): Promise<T> {
  const hostname = new URL(connectionString).hostname.toLowerCase();
  const originalFetch = globalThis.fetch;
  const fixtureFetch: typeof fetch = async (input, init) => {
    const authorization = new Headers(init?.headers).get('authorization');
    if (init?.method !== 'GET' || authorization !== 'Bearer db-check-provider-fixture-only') {
      return new Response('{}', { status: 405, headers: { 'content-type': 'application/json' } });
    }
    const url = String(input);
    let body: unknown;
    if (url.endsWith('/projects/project-production')) {
      body = { project: { id: 'project-production' } };
    } else if (url.endsWith('/branches/br-production-primary')) {
      body = {
        branch: {
          id: 'br-production-primary',
          project_id: 'project-production',
          current_state: 'ready',
          default: true,
          protected: true,
          primary: true,
        },
        annotation: { object: { type: '', id: '' }, value: {} },
      };
    } else if (url.endsWith('/endpoints/ep-production-primary')) {
      body = {
        endpoint: {
          id: 'ep-production-primary',
          project_id: 'project-production',
          branch_id: 'br-production-primary',
          host: hostname,
          type: 'read_write',
          current_state: 'active',
          disabled: false,
        },
      };
    } else {
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };
  globalThis.fetch = fixtureFetch;
  try {
    return await action();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const adoptionRuntime = {
  sourceControlState: () => ({ commit: SOURCE_COMMIT, clean: true }),
};

interface AdoptionRefusalCase {
  label: string;
  sql?: string[];
  request?: (request: AdoptionRequest) => AdoptionRequest;
}

function adoptionRefusalCases(): AdoptionRefusalCase[] {
  const baseline = baselineMigration();
  return [
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
    { label: 'application sequence persistence', sql: ['ALTER SEQUENCE users_id_seq SET UNLOGGED'] },
    { label: 'application sequence increment', sql: ['ALTER SEQUENCE users_id_seq INCREMENT BY 2'] },
    { label: 'application sequence cache', sql: ['ALTER SEQUENCE users_id_seq CACHE 2'] },
    { label: 'application sequence cycle', sql: ['ALTER SEQUENCE users_id_seq CYCLE'] },
    { label: 'application sequence ownership', sql: ['ALTER SEQUENCE users_id_seq OWNED BY NONE'] },
    { label: 'application sequence default link', sql: ['ALTER TABLE users ALTER COLUMN id DROP DEFAULT'] },
    { label: 'missing application sequence', sql: ['DROP SEQUENCE users_id_seq CASCADE'] },
    { label: 'journal extra column', sql: ['ALTER TABLE drizzle.__drizzle_migrations ADD COLUMN unexpected text'] },
    { label: 'journal dropped column', sql: [
      'ALTER TABLE drizzle.__drizzle_migrations ADD COLUMN discarded text',
      'ALTER TABLE drizzle.__drizzle_migrations DROP COLUMN discarded',
    ] },
    { label: 'journal extra check', sql: [
      'ALTER TABLE drizzle.__drizzle_migrations ADD CONSTRAINT unexpected_check CHECK (id > 0)',
    ] },
    { label: 'journal extra index', sql: [
      'CREATE INDEX unexpected_journal_hash_idx ON drizzle.__drizzle_migrations (hash)',
    ] },
    { label: 'journal trigger', sql: [
      `CREATE FUNCTION drizzle.unexpected_journal_trigger_fn() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN RETURN NEW; END; $$`,
      `CREATE TRIGGER unexpected_journal_trigger BEFORE INSERT ON drizzle.__drizzle_migrations
       FOR EACH ROW EXECUTE FUNCTION drizzle.unexpected_journal_trigger_fn()`,
    ] },
    { label: 'journal rewrite rule', sql: [
      `CREATE RULE unexpected_journal_insert_rule AS
       ON INSERT TO drizzle.__drizzle_migrations DO INSTEAD NOTHING`,
    ] },
    { label: 'journal RLS', sql: ['ALTER TABLE drizzle.__drizzle_migrations ENABLE ROW LEVEL SECURITY'] },
    { label: 'journal persistence', sql: ['ALTER TABLE drizzle.__drizzle_migrations SET UNLOGGED'] },
    { label: 'journal relation options', sql: [
      'ALTER TABLE drizzle.__drizzle_migrations SET (fillfactor = 80)',
    ] },
    { label: 'journal inheritance', sql: [
      'CREATE TABLE drizzle.unexpected_journal_child () INHERITS (drizzle.__drizzle_migrations)',
    ] },
    { label: 'journal primary key', sql: [
      'ALTER TABLE drizzle.__drizzle_migrations DROP CONSTRAINT __drizzle_migrations_pkey',
      'ALTER TABLE drizzle.__drizzle_migrations ADD CONSTRAINT unexpected_journal_pk PRIMARY KEY (id)',
    ] },
    { label: 'journal id default', sql: [
      'ALTER TABLE drizzle.__drizzle_migrations ALTER COLUMN id SET DEFAULT 7',
    ] },
    { label: 'journal column type', sql: [
      'ALTER TABLE drizzle.__drizzle_migrations ALTER COLUMN hash TYPE varchar(64)',
    ] },
    { label: 'journal column nullability', sql: [
      'ALTER TABLE drizzle.__drizzle_migrations ALTER COLUMN hash DROP NOT NULL',
    ] },
    { label: 'journal primary index include column', sql: [
      'ALTER TABLE drizzle.__drizzle_migrations DROP CONSTRAINT __drizzle_migrations_pkey',
      `CREATE UNIQUE INDEX __drizzle_migrations_pkey
       ON drizzle.__drizzle_migrations USING btree (id) INCLUDE (hash)`,
      `ALTER TABLE drizzle.__drizzle_migrations
       ADD CONSTRAINT __drizzle_migrations_pkey PRIMARY KEY USING INDEX __drizzle_migrations_pkey`,
    ] },
    { label: 'journal sequence increment', sql: [
      'ALTER SEQUENCE drizzle.__drizzle_migrations_id_seq INCREMENT BY 2',
    ] },
    { label: 'journal sequence cache', sql: ['ALTER SEQUENCE drizzle.__drizzle_migrations_id_seq CACHE 2'] },
    { label: 'journal sequence cycle', sql: ['ALTER SEQUENCE drizzle.__drizzle_migrations_id_seq CYCLE'] },
    { label: 'journal sequence ownership', sql: [
      'ALTER SEQUENCE drizzle.__drizzle_migrations_id_seq OWNED BY NONE',
    ] },
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
    { label: 'journal row id mismatch', sql: [
      `INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at)
       VALUES (99, '${baseline.hash}', ${baseline.createdAt})`,
    ] },
    { label: 'journal sequence runtime state', sql: [
      `INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
       VALUES ('${baseline.hash}', ${baseline.createdAt})`,
      "SELECT pg_catalog.setval('drizzle.__drizzle_migrations_id_seq'::pg_catalog.regclass, 1, false)",
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
}

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

async function journalEntryCount(connectionString: string): Promise<number> {
  const client = new pg.Client({ connectionString, application_name: 'leaguevault-db-check-journal-count' });
  try {
    await client.connect();
    const result = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations',
    );
    const count = Number(result.rows[0]?.count);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid migration journal count.');
    return count;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function waitForApplicationLock(
  client: pg.Client,
  applicationName: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await client.query<{ waiting: boolean }>(`
      SELECT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_locks lock
        JOIN pg_catalog.pg_stat_activity activity ON activity.pid = lock.pid
        WHERE activity.application_name = $1 AND NOT lock.granted
      ) AS waiting
    `, [applicationName]);
    if (result.rows[0]?.waiting === true) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error('Concurrent DDL did not wait on the adoption object locks.');
}

async function expectAdoptionRefusal(
  adminUrl: string,
  port: number,
  container: DbCheckContainer,
  template: string,
  caseIndex: number,
  label: string,
  options: {
    sql?: string[];
    request?: (request: AdoptionRequest) => AdoptionRequest;
  } = {},
): Promise<void> {
  const database = `refusal_${caseIndex}`;
  await createDatabase(adminUrl, database, container, template);
  const connectionString = databaseUrl(port, database);
  if (options.sql) await executeSql(connectionString, options.sql);
  const baseRequest = adoptionRequest(connectionString, database, disposableProof(container, database));
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
  version: SupportedPostgresVersion,
  runId: string,
  artifactDirectory: string,
): Promise<void> {
  let container: DbCheckContainer | null = null;
  let validationError: unknown;
  let cleanupError: unknown;
  try {
    const refusalDatabases = adoptionRefusalCases().map((_refusal, index) => `refusal_${index + 1}`);
    const approvedDatabases = [
      'fresh_active',
      'schema_state_previous',
      'fresh_proof',
      'adoption_template',
      'legacy_inert_rls',
      'adoption_success',
      'adoption_rollback',
      'adoption_drift',
      'adoption_concurrent',
      'adoption_concurrent_sequence',
      'adoption_capability',
      'neon_rehearsal_fingerprint_refusal',
      'neon_rehearsal_approval_boundary',
      'production_preflight_empty',
      'baseline_preflight_nonempty',
      'production_adoption_success',
      ...refusalDatabases,
    ];
    container = createContainer(runId, version, approvedDatabases);
    inspectOwnedContainer(container, runDocker);
    await waitForPostgres(container);
    const port = publishedPort(container);
    const adminUrl = databaseUrl(port, 'postgres');
    mkdirSync(join(artifactDirectory, `postgres-${version}`), { recursive: true });
    const proof = buildProofMigrationDirectory(join(artifactDirectory, `postgres-${version}`));
    const previousMigrations = buildPreviousMigrationDirectory(
      join(artifactDirectory, `postgres-${version}`),
    );
    const activeMigrationTags = loadActiveMigrations().map((migration) => migration.tag);

    const freshActive = 'fresh_active';
    await createDatabase(adminUrl, freshActive, container);
    const freshActiveUrl = databaseUrl(port, freshActive);
    const firstRun = await runCheckedMigrations(freshActiveUrl);
    if (JSON.stringify(firstRun.applied) !== JSON.stringify(activeMigrationTags)) {
      throw new Error('Fresh active migration replay did not apply the complete active history.');
    }
    await assertOrganizationHostnameNamespaceGuard(freshActiveUrl);
    if (!(await runCheckedMigrations(freshActiveUrl)).noOp) {
      throw new Error('Rerunning db:migrate on a fresh replay was not a no-op.');
    }
    await assertApprovedSchemaState(freshActiveUrl);

    const previousState = 'schema_state_previous';
    await createDatabase(adminUrl, previousState, container);
    const previousStateUrl = databaseUrl(port, previousState);
    await runCheckedMigrations(previousStateUrl, previousMigrations);
    await assertApprovedSchemaState(previousStateUrl, previousMigrations);
    await executeSql(previousStateUrl, ['ALTER TABLE alerter_state ADD COLUMN schema_state_drift_probe integer']);
    let schemaDriftRefusal = '';
    try {
      await runCheckedMigrations(previousStateUrl, ACTIVE_MIGRATIONS_DIRECTORY, {
        expectedPending: [activeMigrationTags.at(-1) ?? ''],
      });
    } catch (error) {
      schemaDriftRefusal = error instanceof Error ? error.message : String(error);
    }
    if (
      !schemaDriftRefusal.includes('schema-state fingerprint mismatch') ||
      await journalEntryCount(previousStateUrl) !== activeMigrationTags.length - 1
    ) {
      throw new Error(
        `Expected-pending migration mode did not refuse pre-migration schema drift without mutation: ${schemaDriftRefusal}`,
      );
    }
    await executeSql(previousStateUrl, ['ALTER TABLE alerter_state DROP COLUMN schema_state_drift_probe']);
    const guardedRun = await runCheckedMigrations(previousStateUrl, ACTIVE_MIGRATIONS_DIRECTORY, {
      expectedPending: [activeMigrationTags.at(-1) ?? ''],
    });
    if (JSON.stringify(guardedRun.applied) !== JSON.stringify([activeMigrationTags.at(-1)])) {
      throw new Error('Expected-pending migration mode did not apply only the final migration.');
    }
    if (!(await runCheckedMigrations(previousStateUrl, ACTIVE_MIGRATIONS_DIRECTORY, {
      expectedPending: [],
    })).noOp) {
      throw new Error('Expected-pending migration mode did not verify the final schema as a no-op.');
    }

    const freshProof = 'fresh_proof';
    await createDatabase(adminUrl, freshProof, container);
    const freshProofUrl = databaseUrl(port, freshProof);
    const freshProofRun = await runCheckedMigrations(freshProofUrl, proof.directory);
    if (JSON.stringify(freshProofRun.applied) !== JSON.stringify([...activeMigrationTags, proof.metadata.tag])) {
      throw new Error('Fresh proof replay did not apply active history then proof in order.');
    }
    await assertProofMarker(freshProofUrl);
    await assertOrganizationHostnameNamespaceGuard(freshProofUrl);
    if (!(await runCheckedMigrations(freshProofUrl, proof.directory)).noOp) {
      throw new Error('Rerunning the proof migration chain was not a no-op.');
    }

    const template = 'adoption_template';
    await createDatabase(adminUrl, template, container);
    await installBaselineSchema(databaseUrl(port, template));
    const templateFingerprint = await verifiedFingerprint(databaseUrl(port, template));

    const legacyDatabase = 'legacy_inert_rls';
    const legacyRole = `legacy_inert_role_${version}`;
    const legacyPassword = `leaguevault-legacy-inert-${version}-local-only`;
    await createDatabase(adminUrl, legacyDatabase, container, template);
    const legacyOwnerUrl = databaseUrl(port, legacyDatabase);
    await executeSql(adminUrl, [
      `CREATE ROLE ${legacyRole} LOGIN BYPASSRLS PASSWORD ${quoteLiteral(legacyPassword)}`,
    ]);
    await executeSql(legacyOwnerUrl, [
      `GRANT CONNECT ON DATABASE ${legacyDatabase} TO ${legacyRole}`,
      `GRANT USAGE ON SCHEMA public, drizzle TO ${legacyRole}`,
      `GRANT SELECT ON drizzle.__drizzle_migrations TO ${legacyRole}`,
      ...APPLICATION_TABLE_NAMES.map((name) =>
        `ALTER TABLE public."${name}" OWNER TO ${legacyRole}`,
      ),
      ...APPLICATION_TABLE_NAMES.map((name) =>
        `ALTER TABLE public."${name}" ENABLE ROW LEVEL SECURITY`,
      ),
    ]);
    const legacyUrl = databaseUrlForRole(
      port,
      legacyDatabase,
      legacyRole,
      legacyPassword,
    );
    const legacyInventory = await collectDatabaseInventory(legacyUrl);
    let strictFingerprintRefused = false;
    try {
      createBaselineFingerprint(legacyInventory);
    } catch {
      strictFingerprintRefused = true;
    }
    if (!strictFingerprintRefused) {
      throw new Error('Ordinary fingerprint generation unexpectedly normalized legacy inert RLS.');
    }
    const legacyVerification = verifyBaselineInventory(legacyInventory);
    if (
      legacyVerification.state !== 'legacy-inert-rls' ||
      legacyVerification.fingerprint.digest !== templateFingerprint.digest
    ) {
      throw new Error('Legacy inert-RLS inventory did not verify as the canonical baseline digest.');
    }

    // Exercise adoption as a realistic non-superuser owner without elevated
    // write privileges on provider-managed system catalogs.
    await executeSql(adminUrl, [
      `ALTER DATABASE ${legacyDatabase} OWNER TO ${legacyRole}`,
    ]);
    await executeSql(legacyOwnerUrl, [
      `ALTER SCHEMA public OWNER TO ${legacyRole}`,
      `ALTER SCHEMA drizzle OWNER TO ${legacyRole}`,
      ...APPLICATION_SEQUENCE_NAMES.map((name) =>
        `ALTER SEQUENCE public."${name}" OWNER TO ${legacyRole}`,
      ),
      ...APPROVED_INVARIANT_FUNCTION_NAMES.map((name) =>
        `ALTER FUNCTION public."${name}"() OWNER TO ${legacyRole}`,
      ),
      `ALTER TYPE public.user_role OWNER TO ${legacyRole}`,
      `ALTER TABLE drizzle.__drizzle_migrations OWNER TO ${legacyRole}`,
      `ALTER SEQUENCE drizzle.__drizzle_migrations_id_seq OWNER TO ${legacyRole}`,
    ]);
    const catalogProbe = new pg.Client({ connectionString: legacyUrl });
    let catalogRowLockRefused = false;
    try {
      await catalogProbe.connect();
      await catalogProbe.query('BEGIN');
      try {
        await catalogProbe.query(`
          SELECT seqrelid
          FROM pg_catalog.pg_sequence
          WHERE seqrelid = 'public.users_id_seq'::pg_catalog.regclass
          FOR SHARE
        `);
      } catch {
        catalogRowLockRefused = true;
      }
    } finally {
      await catalogProbe.query('ROLLBACK').catch(() => undefined);
      await catalogProbe.end().catch(() => undefined);
    }
    if (!catalogRowLockRefused) {
      throw new Error('Non-superuser catalog-lock regression fixture has elevated catalog privileges.');
    }
    const legacyAdopted = await adoptExistingDatabaseBaseline(
      legacyUrl,
      adoptionRequest(legacyUrl, legacyDatabase, disposableProof(container, legacyDatabase), legacyRole),
      adoptionRuntime,
    );
    if (legacyAdopted.status !== 'adopted') {
      throw new Error('Non-superuser application owner could not register the approved legacy baseline.');
    }

    const adoptionDatabase = 'adoption_success';
    await createDatabase(adminUrl, adoptionDatabase, container, template);
    const adoptionUrl = databaseUrl(port, adoptionDatabase);
    const beforeAdoption = await verifiedFingerprint(adoptionUrl);
    const adopted = await adoptExistingDatabaseBaseline(
      adoptionUrl,
      adoptionRequest(adoptionUrl, adoptionDatabase, disposableProof(container, adoptionDatabase)),
      adoptionRuntime,
    );
    if (adopted.status !== 'adopted') throw new Error('Matching existing database was not adopted.');
    const afterAdoption = await verifiedFingerprint(adoptionUrl);
    if (JSON.stringify(beforeAdoption.structure) !== JSON.stringify(afterAdoption.structure)) {
      throw new Error('Baseline adoption changed application DDL.');
    }
    const adoptionNoOp = await adoptExistingDatabaseBaseline(
      adoptionUrl,
      adoptionRequest(adoptionUrl, adoptionDatabase, disposableProof(container, adoptionDatabase)),
      adoptionRuntime,
    );
    if (adoptionNoOp.status !== 'no-op') throw new Error('Exact adoption rerun was not a safe no-op.');

    const neonFingerprintDatabase = 'neon_rehearsal_fingerprint_refusal';
    await createDatabase(adminUrl, neonFingerprintDatabase, container, template);
    const neonFingerprintUrl = databaseUrl(port, neonFingerprintDatabase);
    await executeSql(neonFingerprintUrl, ['ALTER TABLE alerter_state ADD COLUMN provider_verified_drift integer']);
    let providerVerifiedFingerprintRefused = false;
    try {
      await withNeonProviderFixture(neonFingerprintUrl, () => adoptExistingDatabaseBaseline(
        neonFingerprintUrl,
        neonAdoptionRequest(neonFingerprintUrl, neonFingerprintDatabase),
        adoptionRuntime,
        'db-check-provider-fixture-only',
      ));
    } catch {
      providerVerifiedFingerprintRefused = true;
    }
    if (!providerVerifiedFingerprintRefused || await journalEntryCount(neonFingerprintUrl) !== 0) {
      throw new Error('Provider-verified Neon rehearsal did not refuse a database fingerprint mismatch.');
    }

    const neonBoundaryDatabase = 'neon_rehearsal_approval_boundary';
    await createDatabase(adminUrl, neonBoundaryDatabase, container, template);
    const neonBoundaryUrl = databaseUrl(port, neonBoundaryDatabase);
    let reachedApprovalBoundary = false;
    try {
      await withNeonProviderFixture(neonBoundaryUrl, () => adoptExistingDatabaseBaseline(
        neonBoundaryUrl,
        neonAdoptionRequest(neonBoundaryUrl, neonBoundaryDatabase),
        {
          ...adoptionRuntime,
          afterPreliminaryVerification: () => {
            reachedApprovalBoundary = true;
            throw new Error('db-check stop at explicit operator approval boundary');
          },
        },
        'db-check-provider-fixture-only',
      ));
    } catch {
      // Expected test-only stop before the registration transaction.
    }
    if (!reachedApprovalBoundary || await journalEntryCount(neonBoundaryUrl) !== 0) {
      throw new Error('Provider-verified Neon rehearsal did not reach the write-free approval boundary.');
    }

    const productionPreflightDatabase = 'production_preflight_empty';
    await createDatabase(adminUrl, productionPreflightDatabase, container, template);
    const productionPreflightUrl = databaseUrl(port, productionPreflightDatabase);
    const productionPreflightBefore = await verifiedFingerprint(productionPreflightUrl);
    const productionPreflightRequest = productionAdoptionRequest(
      productionPreflightUrl,
      productionPreflightDatabase,
    );
    if (productionPreflightRequest.environmentClass !== PRODUCTION_ENVIRONMENT_CLASS) {
      throw new Error('Production preflight fixture has the wrong environment class.');
    }
    productionPreflightRequest.confirmation = '';
    productionPreflightRequest.approvalToken = '';
    const productionPreflight = await withProductionProviderFixture(
      productionPreflightUrl,
      () => preflightProductionDatabaseBaseline(
        productionPreflightUrl,
        productionPreflightRequest,
        adoptionRuntime,
        'db-check-provider-fixture-only',
      ),
    );
    const productionPreflightAfter = await verifiedFingerprint(productionPreflightUrl);
    if (
      productionPreflight.status !== 'ready' ||
      productionPreflight.journalRowCount !== 0 ||
      await journalEntryCount(productionPreflightUrl) !== 0 ||
      JSON.stringify(productionPreflightBefore.structure) !==
        JSON.stringify(productionPreflightAfter.structure)
    ) {
      throw new Error('Production preflight was not exactly read-only and ready.');
    }

    const productionNonemptyDatabase = 'baseline_preflight_nonempty';
    await createDatabase(adminUrl, productionNonemptyDatabase, container, template);
    const productionNonemptyUrl = databaseUrl(port, productionNonemptyDatabase);
    await adoptExistingDatabaseBaseline(
      productionNonemptyUrl,
      adoptionRequest(
        productionNonemptyUrl,
        productionNonemptyDatabase,
        disposableProof(container, productionNonemptyDatabase),
      ),
      adoptionRuntime,
    );
    const productionNonemptyRequest = productionAdoptionRequest(
      productionNonemptyUrl,
      productionNonemptyDatabase,
    );
    if (productionNonemptyRequest.environmentClass !== PRODUCTION_ENVIRONMENT_CLASS) {
      throw new Error('Production nonempty fixture has the wrong environment class.');
    }
    productionNonemptyRequest.confirmation = '';
    productionNonemptyRequest.approvalToken = '';
    let productionNonemptyRefused = false;
    try {
      await withProductionProviderFixture(
        productionNonemptyUrl,
        () => preflightProductionDatabaseBaseline(
          productionNonemptyUrl,
          productionNonemptyRequest,
          adoptionRuntime,
          'db-check-provider-fixture-only',
        ),
      );
    } catch {
      productionNonemptyRefused = true;
    }
    if (!productionNonemptyRefused || await journalEntryCount(productionNonemptyUrl) !== 1) {
      throw new Error('Production preflight did not refuse an already registered journal without mutation.');
    }

    const productionAdoptionDatabase = 'production_adoption_success';
    await createDatabase(adminUrl, productionAdoptionDatabase, container, template);
    const productionAdoptionUrl = databaseUrl(port, productionAdoptionDatabase);
    const productionAdoption = await withProductionProviderFixture(
      productionAdoptionUrl,
      () => adoptExistingDatabaseBaseline(
        productionAdoptionUrl,
        productionAdoptionRequest(productionAdoptionUrl, productionAdoptionDatabase),
        adoptionRuntime,
        'db-check-provider-fixture-only',
      ),
    );
    if (productionAdoption.status !== 'adopted' || await journalEntryCount(productionAdoptionUrl) !== 1) {
      throw new Error('Production execution did not register exactly one baseline journal row.');
    }

    const neonFreshnessDatabase = 'neon_rehearsal_freshness_refusal';
    await createDatabase(adminUrl, neonFreshnessDatabase, container, template);
    const neonFreshnessUrl = databaseUrl(port, neonFreshnessDatabase);
    let staleProviderProofRefused = false;
    try {
      await withNeonProviderFixture(neonFreshnessUrl, () => adoptExistingDatabaseBaseline(
        neonFreshnessUrl,
        neonAdoptionRequest(neonFreshnessUrl, neonFreshnessDatabase),
        adoptionRuntime,
        'db-check-provider-fixture-only',
      ), true);
    } catch {
      staleProviderProofRefused = true;
    }
    if (!staleProviderProofRefused || await journalEntryCount(neonFreshnessUrl) !== 0) {
      throw new Error('Neon rehearsal reused stale provider proof at the write boundary.');
    }

    const rollbackDatabase = 'adoption_rollback';
    await createDatabase(adminUrl, rollbackDatabase, container, template);
    const rollbackUrl = databaseUrl(port, rollbackDatabase);
    let postInsertFailed = false;
    try {
      await adoptExistingDatabaseBaseline(
        rollbackUrl,
        adoptionRequest(rollbackUrl, rollbackDatabase, disposableProof(container, rollbackDatabase)),
        {
          ...adoptionRuntime,
          afterJournalInsert: () => {
            throw new Error('injected failure immediately after journal insert');
          },
        },
      );
    } catch {
      postInsertFailed = true;
    }
    if (!postInsertFailed || await journalEntryCount(rollbackUrl) !== 0) {
      throw new Error('Post-insert adoption failure did not roll back the baseline journal record.');
    }

    const driftDatabase = 'adoption_drift';
    await createDatabase(adminUrl, driftDatabase, container, template);
    const driftUrl = databaseUrl(port, driftDatabase);
    let driftRefused = false;
    try {
      await adoptExistingDatabaseBaseline(
        driftUrl,
        adoptionRequest(driftUrl, driftDatabase, disposableProof(container, driftDatabase)),
        {
          ...adoptionRuntime,
          afterPreliminaryVerification: async () => {
            await executeSql(driftUrl, ['ALTER TABLE alerter_state ADD COLUMN drift_probe integer']);
          },
        },
      );
    } catch {
      driftRefused = true;
    }
    if (!driftRefused || await journalEntryCount(driftUrl) !== 0) {
      throw new Error('Drift after preliminary verification was not refused without journal registration.');
    }

    const concurrentDatabase = 'adoption_concurrent';
    await createDatabase(adminUrl, concurrentDatabase, container, template);
    const concurrentUrl = databaseUrl(port, concurrentDatabase);
    const concurrentApplication = `leaguevault-db-check-concurrent-ddl-${version}`;
    const concurrentClient = new pg.Client({
      connectionString: concurrentUrl,
      application_name: concurrentApplication,
    });
    const concurrentDdl: { promise: Promise<void> | null } = { promise: null };
    try {
      await concurrentClient.connect();
      await concurrentClient.query('BEGIN');
      await concurrentClient.query("SET LOCAL statement_timeout = '15s'");
      const concurrentResult = await adoptExistingDatabaseBaseline(
        concurrentUrl,
        adoptionRequest(concurrentUrl, concurrentDatabase, disposableProof(container, concurrentDatabase)),
        {
          ...adoptionRuntime,
          afterApplicationLocks: async (adoptionClient) => {
            concurrentDdl.promise = concurrentClient
              .query('ALTER TABLE users ADD COLUMN concurrent_adoption_probe integer')
              .then(() => undefined);
            await waitForApplicationLock(adoptionClient, concurrentApplication);
          },
        },
      );
      if (!concurrentDdl.promise) throw new Error('Concurrent DDL probe was not started.');
      await concurrentDdl.promise;
      if (concurrentResult.status !== 'adopted') {
        throw new Error('Concurrent-DDL adoption probe did not register the baseline.');
      }
      await concurrentClient.query('ROLLBACK');
    } finally {
      await concurrentClient.query('ROLLBACK').catch(() => undefined);
      await concurrentClient.end().catch(() => undefined);
    }

    const concurrentSequenceDatabase = 'adoption_concurrent_sequence';
    await createDatabase(adminUrl, concurrentSequenceDatabase, container, template);
    const concurrentSequenceUrl = databaseUrl(port, concurrentSequenceDatabase);
    const sequenceDdlApplication = `leaguevault-db-check-concurrent-sequence-${version}`;
    const sequenceDdlClient = new pg.Client({
      connectionString: concurrentSequenceUrl,
      application_name: sequenceDdlApplication,
    });
    const sequenceDdl: { promise: Promise<void> | null } = { promise: null };
    try {
      await sequenceDdlClient.connect();
      await sequenceDdlClient.query('BEGIN');
      await sequenceDdlClient.query("SET LOCAL statement_timeout = '15s'");
      const result = await adoptExistingDatabaseBaseline(
        concurrentSequenceUrl,
        adoptionRequest(
          concurrentSequenceUrl,
          concurrentSequenceDatabase,
          disposableProof(container, concurrentSequenceDatabase),
        ),
        {
          ...adoptionRuntime,
          afterApplicationLocks: async (adoptionClient) => {
            sequenceDdl.promise = sequenceDdlClient
              .query('ALTER SEQUENCE users_id_seq CACHE 2')
              .then(() => undefined);
            await waitForApplicationLock(adoptionClient, sequenceDdlApplication);
          },
        },
      );
      if (!sequenceDdl.promise) throw new Error('Concurrent sequence DDL probe was not started.');
      await sequenceDdl.promise;
      if (result.status !== 'adopted') {
        throw new Error('Concurrent-sequence-DDL adoption probe did not register the baseline.');
      }
      await sequenceDdlClient.query('ROLLBACK');
    } finally {
      await sequenceDdlClient.query('ROLLBACK').catch(() => undefined);
      await sequenceDdlClient.end().catch(() => undefined);
    }

    const capabilityDatabase = 'adoption_capability';
    const limitedRole = 'adoption_limited';
    const limitedPassword = 'leaguevault-adoption-limited-local-only';
    await createDatabase(adminUrl, capabilityDatabase, container, template);
    const capabilityOwnerUrl = databaseUrl(port, capabilityDatabase);
    await executeSql(adminUrl, [
      `CREATE ROLE ${limitedRole} LOGIN PASSWORD ${quoteLiteral(limitedPassword)}`,
    ]);
    await executeSql(capabilityOwnerUrl, [
      `GRANT CONNECT, CREATE ON DATABASE ${capabilityDatabase} TO ${limitedRole}`,
      `GRANT USAGE, CREATE ON SCHEMA public TO ${limitedRole}`,
      `GRANT USAGE ON SCHEMA drizzle TO ${limitedRole}`,
      `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public, drizzle TO ${limitedRole}`,
      `GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public, drizzle TO ${limitedRole}`,
    ]);
    const capabilityUrl = databaseUrlForRole(
      port,
      capabilityDatabase,
      limitedRole,
      limitedPassword,
    );
    let capabilityRefusal = '';
    try {
      await adoptExistingDatabaseBaseline(
        capabilityUrl,
        adoptionRequest(
          capabilityUrl,
          capabilityDatabase,
          disposableProof(container, capabilityDatabase),
          limitedRole,
        ),
        adoptionRuntime,
      );
    } catch (error) {
      capabilityRefusal = error instanceof Error ? error.message : String(error);
    }
    if (!capabilityRefusal.includes('cannot act as owner')) {
      throw new Error('Inadequate migration-role capability was not refused by the explicit preflight.');
    }

    const adoptedProofRun = await runCheckedMigrations(adoptionUrl, proof.directory);
    if (JSON.stringify(adoptedProofRun.applied) !== JSON.stringify([
      ...activeMigrationTags.slice(1),
      proof.metadata.tag,
    ])) {
      throw new Error('Adopted database did not skip baseline and apply later migrations in order.');
    }
    await assertProofMarker(adoptionUrl);
    if (!(await runCheckedMigrations(adoptionUrl, proof.directory)).noOp) {
      throw new Error('Adopted proof rerun was not a no-op.');
    }
    await assertOrganizationHostnameNamespaceGuard(adoptionUrl);

    const refusalCases = adoptionRefusalCases();
    for (let index = 0; index < refusalCases.length; index += 1) {
      const refusal = refusalCases[index];
      if (!refusal) throw new Error('Refusal case inventory is incomplete.');
      await expectAdoptionRefusal(adminUrl, port, container, template, index + 1, refusal.label, refusal);
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
