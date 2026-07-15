import { execFileSync } from 'node:child_process';
import pg, { type QueryResultRow } from 'pg';
import {
  assertApprovedBaselineFingerprint,
  createBaselineFingerprint,
  loadApprovedBaselineFingerprint,
} from './db-baseline-fingerprint';
import { baselineMigration, type ActiveMigration } from './db-migration-assets';
import {
  assertExpectedConnectionUrlTarget,
  assertExpectedDatabaseTarget,
  collectDatabaseInventory,
  fingerprintDatabaseHost,
  type ExpectedDatabaseTarget,
} from './db-schema-inventory';

export const ADOPTION_CONFIRMATION = 'ADOPT_LEAGUEVAULT_BASELINE_WITHOUT_DDL';
export const BACKUP_ATTESTATION = 'BACKUP_AND_RESTORE_VERIFIED';
const ADOPTION_LOCK_KEY = 843_103_001;

const REQUIRED_ADOPTION_KEYS = [
  'DB_ADOPTION_EXPECTED_DATABASE',
  'DB_ADOPTION_EXPECTED_ROLE',
  'DB_ADOPTION_EXPECTED_HOST_FINGERPRINT',
  'DB_ADOPTION_ENVIRONMENT_CLASS',
  'DB_ADOPTION_ENVIRONMENT_ID',
  'DB_ADOPTION_EXPECTED_ENVIRONMENT_ID',
  'DB_ADOPTION_BACKUP_ATTESTATION',
  'DB_ADOPTION_CONFIRM',
  'DB_ADOPTION_EXPECTED_COMMIT',
  'DB_ADOPTION_EXPECTED_BASELINE_TAG',
  'DB_ADOPTION_EXPECTED_BASELINE_HASH',
  'DB_ADOPTION_EXPECTED_BASELINE_CREATED_AT',
] as const;

export type AdoptionEnvironmentClass = 'local-disposable' | 'ci' | 'neon-rehearsal';

export interface AdoptionRequest {
  expectedTarget: ExpectedDatabaseTarget;
  environmentClass: AdoptionEnvironmentClass;
  environmentId: string;
  expectedEnvironmentId: string;
  sourceEnvironmentId: string | null;
  backupAttestation: string;
  confirmation: string;
  expectedCommit: string;
  expectedBaselineTag: string;
  expectedBaselineHash: string;
  expectedBaselineCreatedAt: number;
}

export interface SourceControlState {
  commit: string;
  clean: boolean;
}

export interface AdoptionRuntime {
  sourceControlState?: () => SourceControlState;
}

export interface AdoptionResult {
  status: 'adopted' | 'no-op';
  baselineTag: string;
}

interface JournalRelationRow extends QueryResultRow {
  schema_name: string;
  table_name: string;
}

interface JournalColumnRow extends QueryResultRow {
  column_name: string;
  data_type: string;
  not_null: boolean;
  default_expression: string | null;
}

interface JournalEntryRow extends QueryResultRow {
  id: string;
  hash: string;
  created_at: string | null;
}

type JournalState = 'absent-or-empty' | 'baseline';

function required(environment: NodeJS.ProcessEnv, key: (typeof REQUIRED_ADOPTION_KEYS)[number]): string {
  const value = environment[key]?.trim();
  if (!value) throw new Error(`Required baseline-adoption environment variable is absent: ${key}.`);
  return value;
}

export function parseAdoptionEnvironment(environment: NodeJS.ProcessEnv): AdoptionRequest {
  const missing = REQUIRED_ADOPTION_KEYS.filter((key) => !environment[key]?.trim());
  if (missing.length > 0) {
    throw new Error(`Required baseline-adoption environment variable(s) are absent: ${missing.join(', ')}.`);
  }
  if (
    environment.APP_ENV?.trim().toLowerCase() === 'prod' ||
    environment.NODE_ENV?.trim().toLowerCase() === 'production' ||
    environment.APP_DOMAIN?.trim().toLowerCase() === 'leaguevault.app' ||
    Boolean(environment.REPLIT_DEPLOYMENT?.trim()) ||
    Boolean(environment.RENDER?.trim()) ||
    Boolean(environment.RENDER_SERVICE_ID?.trim()) ||
    Boolean(environment.RENDER_EXTERNAL_HOSTNAME?.trim())
  ) {
    throw new Error('Production baseline adoption is disabled in this change.');
  }
  const environmentClass = required(environment, 'DB_ADOPTION_ENVIRONMENT_CLASS');
  if (!['local-disposable', 'ci', 'neon-rehearsal'].includes(environmentClass)) {
    throw new Error('DB_ADOPTION_ENVIRONMENT_CLASS must identify an approved disposable or rehearsal environment.');
  }
  const environmentId = required(environment, 'DB_ADOPTION_ENVIRONMENT_ID');
  const expectedEnvironmentId = required(environment, 'DB_ADOPTION_EXPECTED_ENVIRONMENT_ID');
  if (
    environmentId !== expectedEnvironmentId ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(expectedEnvironmentId) ||
    /(?:^|[-_.:])(prod|production|live)(?:$|[-_.:])/i.test(expectedEnvironmentId)
  ) {
    throw new Error('The independently expected environment identity is mismatched, invalid, or production-shaped.');
  }
  const sourceEnvironmentId = environment.DB_ADOPTION_SOURCE_ENVIRONMENT_ID?.trim() || null;
  if (environmentClass === 'neon-rehearsal') {
    if (!sourceEnvironmentId) {
      throw new Error('DB_ADOPTION_SOURCE_ENVIRONMENT_ID is required for a Neon rehearsal.');
    }
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(sourceEnvironmentId) ||
      sourceEnvironmentId === environmentId
    ) {
      throw new Error('The Neon rehearsal target must be distinct from its independently identified source.');
    }
  } else if (sourceEnvironmentId) {
    throw new Error('DB_ADOPTION_SOURCE_ENVIRONMENT_ID is only valid for a Neon rehearsal.');
  }
  const hostFingerprint = required(environment, 'DB_ADOPTION_EXPECTED_HOST_FINGERPRINT');
  if (!/^sha256:[0-9a-f]{64}$/.test(hostFingerprint)) {
    throw new Error('DB_ADOPTION_EXPECTED_HOST_FINGERPRINT must be a lowercase SHA-256 fingerprint.');
  }
  const createdAtText = required(environment, 'DB_ADOPTION_EXPECTED_BASELINE_CREATED_AT');
  const createdAt = Number(createdAtText);
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0 || String(createdAt) !== createdAtText) {
    throw new Error('DB_ADOPTION_EXPECTED_BASELINE_CREATED_AT must be an exact positive integer timestamp.');
  }
  return {
    expectedTarget: {
      database: required(environment, 'DB_ADOPTION_EXPECTED_DATABASE'),
      role: required(environment, 'DB_ADOPTION_EXPECTED_ROLE'),
      hostFingerprint,
    },
    environmentClass: environmentClass as AdoptionEnvironmentClass,
    environmentId,
    expectedEnvironmentId,
    sourceEnvironmentId,
    backupAttestation: required(environment, 'DB_ADOPTION_BACKUP_ATTESTATION'),
    confirmation: required(environment, 'DB_ADOPTION_CONFIRM'),
    expectedCommit: required(environment, 'DB_ADOPTION_EXPECTED_COMMIT'),
    expectedBaselineTag: required(environment, 'DB_ADOPTION_EXPECTED_BASELINE_TAG'),
    expectedBaselineHash: required(environment, 'DB_ADOPTION_EXPECTED_BASELINE_HASH'),
    expectedBaselineCreatedAt: createdAt,
  };
}

function readSourceControlState(): SourceControlState {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  }).trim();
  const status = execFileSync('git', ['status', '--porcelain'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  return { commit, clean: status.trim().length === 0 };
}

export function validateAdoptionRequest(
  request: AdoptionRequest,
  sourceControl: SourceControlState,
  baseline: ActiveMigration = baselineMigration(),
): void {
  if (
    request.environmentId !== request.expectedEnvironmentId ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(request.environmentId) ||
    /(?:^|[-_.:])(prod|production|live)(?:$|[-_.:])/i.test(request.environmentId)
  ) {
    throw new Error('The independently expected environment identity is mismatched, invalid, or production-shaped.');
  }
  if (
    request.environmentClass === 'neon-rehearsal' &&
    (!request.sourceEnvironmentId || request.sourceEnvironmentId === request.environmentId)
  ) {
    throw new Error('The Neon rehearsal target must have a distinct source environment identity.');
  }
  if (request.environmentClass !== 'neon-rehearsal' && request.sourceEnvironmentId !== null) {
    throw new Error('A source environment identity is only valid for a Neon rehearsal.');
  }
  if (request.confirmation !== ADOPTION_CONFIRMATION) {
    throw new Error('Explicit baseline-adoption confirmation is missing or incorrect.');
  }
  if (request.backupAttestation !== BACKUP_ATTESTATION) {
    throw new Error('Backup and restore attestation is missing or incorrect.');
  }
  if (!/^[0-9a-f]{40}$/.test(request.expectedCommit)) {
    throw new Error('The expected commit must be an exact 40-character Git commit identifier.');
  }
  if (!sourceControl.clean) throw new Error('Baseline adoption requires a clean source worktree.');
  if (sourceControl.commit !== request.expectedCommit) {
    throw new Error('The checked-out commit does not match the independently supplied expected commit.');
  }
  if (
    request.expectedBaselineTag !== baseline.tag ||
    request.expectedBaselineHash !== baseline.hash ||
    request.expectedBaselineCreatedAt !== baseline.createdAt
  ) {
    throw new Error('The independently supplied baseline identity does not match the checked-in baseline.');
  }
}

async function discoverJournalRelations(client: pg.Client): Promise<JournalRelationRow[]> {
  const result = await client.query<JournalRelationRow>(`
    SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND c.relname = '__drizzle_migrations'
      AND n.nspname <> 'information_schema'
      AND n.nspname !~ '^pg_'
    ORDER BY n.nspname, c.relname
  `);
  if (result.rows.length > 1) throw new Error('Multiple migration journal relations make adoption ambiguous.');
  const relation = result.rows[0];
  if (relation && (relation.schema_name !== 'drizzle' || relation.table_name !== '__drizzle_migrations')) {
    throw new Error('The discovered migration journal is not the approved drizzle.__drizzle_migrations relation.');
  }
  return result.rows;
}

async function assertExactJournalFormat(client: pg.Client): Promise<void> {
  const columns = await client.query<JournalColumnRow>(`
    SELECT
      a.attname AS column_name,
      pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
      a.attnotnull AS not_null,
      pg_catalog.pg_get_expr(ad.adbin, ad.adrelid, true) AS default_expression
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
    WHERE n.nspname = 'drizzle' AND c.relname = '__drizzle_migrations'
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum
  `);
  const expected = [
    ['id', 'integer', true],
    ['hash', 'text', true],
    ['created_at', 'bigint', false],
  ] as const;
  if (
    columns.rows.length !== expected.length ||
    columns.rows.some((column, index) => {
      const wanted = expected[index];
      return !wanted || column.column_name !== wanted[0] || column.data_type !== wanted[1] || column.not_null !== wanted[2];
    })
  ) {
    throw new Error('The approved migration journal has an unexpected column definition.');
  }
  if (!columns.rows[0]?.default_expression?.startsWith("nextval('drizzle.__drizzle_migrations_id_seq'")) {
    throw new Error('The approved migration journal id column is not the installed Drizzle serial definition.');
  }
  if (columns.rows[1]?.default_expression !== null || columns.rows[2]?.default_expression !== null) {
    throw new Error('The approved migration journal has an unexpected default expression.');
  }
  const primaryKey = await client.query<{ columns: string[] }>(`
    SELECT ARRAY(
      SELECT a.attname
      FROM unnest(con.conkey) WITH ORDINALITY AS key(attnum, ordinal)
      JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = key.attnum
      ORDER BY key.ordinal
    )::text[] AS columns
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'drizzle' AND c.relname = '__drizzle_migrations' AND con.contype = 'p'
  `);
  if (primaryKey.rows.length !== 1 || JSON.stringify(primaryKey.rows[0]?.columns) !== JSON.stringify(['id'])) {
    throw new Error('The approved migration journal must have exactly one primary key on id.');
  }
}

function classifyJournalRows(rows: JournalEntryRow[], baseline: ActiveMigration): JournalState {
  if (rows.length === 0) return 'absent-or-empty';
  if (
    rows.length === 1 &&
    rows[0]?.hash === baseline.hash &&
    rows[0]?.created_at === String(baseline.createdAt)
  ) {
    return 'baseline';
  }
  throw new Error('Migration journal state is non-empty, conflicting, or does not contain the exact baseline record.');
}

async function inspectJournalOnClient(
  client: pg.Client,
  baseline: ActiveMigration,
): Promise<JournalState> {
  const discovery = await discoverJournalRelations(client);
  if (discovery.length === 0) return 'absent-or-empty';
  await assertExactJournalFormat(client);
  const entries = await client.query<JournalEntryRow>(`
    SELECT id::text, hash::text, created_at::text
    FROM drizzle.__drizzle_migrations
    ORDER BY created_at, id
  `);
  return classifyJournalRows(entries.rows, baseline);
}

async function inspectJournalReadOnly(
  connectionString: string,
  expectedTarget: ExpectedDatabaseTarget,
  baseline: ActiveMigration,
): Promise<JournalState> {
  const client = new pg.Client({
    connectionString,
    application_name: 'leaguevault-db-adopt-journal-inspection',
  });
  let transaction = false;
  try {
    await client.connect();
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    transaction = true;
    const target = await client.query<{ database_name: string; role_name: string; read_only: string; isolation: string }>(`
      SELECT current_database() AS database_name, current_user AS role_name,
        current_setting('transaction_read_only') AS read_only,
        current_setting('transaction_isolation') AS isolation
    `);
    const row = target.rows[0];
    if (!row || row.read_only !== 'on' || row.isolation !== 'repeatable read') {
      throw new Error('PostgreSQL did not confirm repeatable-read, read-only adoption inspection.');
    }
    assertExpectedDatabaseTarget({
      hostFingerprint: fingerprintDatabaseHost(connectionString),
      database: row.database_name,
      role: row.role_name,
    }, expectedTarget);
    const state = await inspectJournalOnClient(client, baseline);
    await client.query('COMMIT');
    transaction = false;
    return state;
  } finally {
    if (transaction) await client.query('ROLLBACK').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

async function writeBaselineJournalRecord(
  connectionString: string,
  expectedTarget: ExpectedDatabaseTarget,
  baseline: ActiveMigration,
): Promise<'adopted' | 'no-op'> {
  const client = new pg.Client({
    connectionString,
    application_name: 'leaguevault-db-adopt-baseline',
  });
  let transaction = false;
  try {
    await client.connect();
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    transaction = true;
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const target = await client.query<{ database_name: string; role_name: string }>(
      'SELECT current_database() AS database_name, current_user AS role_name',
    );
    const row = target.rows[0];
    if (!row) throw new Error('PostgreSQL did not return adoption target metadata.');
    assertExpectedDatabaseTarget({
      hostFingerprint: fingerprintDatabaseHost(connectionString),
      database: row.database_name,
      role: row.role_name,
    }, expectedTarget);

    const discovery = await discoverJournalRelations(client);
    if (discovery.length === 0) {
      await client.query('CREATE SCHEMA IF NOT EXISTS drizzle');
      await client.query(`
        CREATE TABLE drizzle.__drizzle_migrations (
          id SERIAL PRIMARY KEY,
          hash text NOT NULL,
          created_at bigint
        )
      `);
    }
    const state = await inspectJournalOnClient(client, baseline);
    if (state === 'baseline') {
      await client.query('COMMIT');
      transaction = false;
      return 'no-op';
    }
    await client.query(
      'INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)',
      [baseline.hash, baseline.createdAt],
    );
    await client.query('COMMIT');
    transaction = false;
    return 'adopted';
  } finally {
    if (transaction) await client.query('ROLLBACK').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

async function withAdoptionLock<T>(
  connectionString: string,
  expectedTarget: ExpectedDatabaseTarget,
  operation: () => Promise<T>,
): Promise<T> {
  const client = new pg.Client({
    connectionString,
    application_name: 'leaguevault-db-adopt-guard-lock',
  });
  let lockHeld = false;
  try {
    await client.connect();
    const target = await client.query<{ database_name: string; role_name: string }>(
      'SELECT current_database() AS database_name, current_user AS role_name',
    );
    const row = target.rows[0];
    if (!row) throw new Error('PostgreSQL did not return adoption lock target metadata.');
    assertExpectedDatabaseTarget({
      hostFingerprint: fingerprintDatabaseHost(connectionString),
      database: row.database_name,
      role: row.role_name,
    }, expectedTarget);
    await client.query('SELECT pg_advisory_lock($1)', [ADOPTION_LOCK_KEY]);
    lockHeld = true;
    return await operation();
  } finally {
    if (lockHeld) {
      await client.query('SELECT pg_advisory_unlock($1)', [ADOPTION_LOCK_KEY]).catch(() => undefined);
    }
    await client.end().catch(() => undefined);
  }
}

export async function adoptExistingDatabaseBaseline(
  connectionString: string,
  request: AdoptionRequest,
  runtime: AdoptionRuntime = {},
): Promise<AdoptionResult> {
  const baseline = baselineMigration();
  const approved = loadApprovedBaselineFingerprint(undefined, baseline);
  const sourceControl = (runtime.sourceControlState ?? readSourceControlState)();
  validateAdoptionRequest(request, sourceControl, baseline);
  assertExpectedConnectionUrlTarget(connectionString, request.expectedTarget);
  return withAdoptionLock(connectionString, request.expectedTarget, async () => {
    const inventory = await collectDatabaseInventory(connectionString, {
      expectedTarget: request.expectedTarget,
    });
    const fingerprint = createBaselineFingerprint(inventory, baseline);
    assertApprovedBaselineFingerprint(fingerprint, approved);
    const inspectedState = await inspectJournalReadOnly(
      connectionString,
      request.expectedTarget,
      baseline,
    );
    if (inspectedState === 'baseline') {
      return { status: 'no-op', baselineTag: baseline.tag };
    }

    const writeStatus = await writeBaselineJournalRecord(
      connectionString,
      request.expectedTarget,
      baseline,
    );
    const confirmedInventory = await collectDatabaseInventory(connectionString, {
      expectedTarget: request.expectedTarget,
    });
    assertApprovedBaselineFingerprint(createBaselineFingerprint(confirmedInventory, baseline), approved);
    const confirmedJournal = await inspectJournalReadOnly(
      connectionString,
      request.expectedTarget,
      baseline,
    );
    if (confirmedJournal !== 'baseline') {
      throw new Error('The exact baseline journal record was not confirmed after adoption commit.');
    }
    return { status: writeStatus, baselineTag: baseline.tag };
  });
}
