import { execFileSync } from 'node:child_process';
import pg, { type QueryResultRow } from 'pg';
import {
  APPROVED_INVARIANT_FUNCTION_NAMES,
} from '../../shared/database-invariants';
import {
  APPLICATION_TABLE_NAMES,
  loadApprovedBaselineFingerprint,
  verifyBaselineInventory,
  type BaselineVerificationState,
} from './db-baseline-fingerprint';
import {
  type DisposableTargetProof,
  disposableDatabaseMarker,
  readDisposableTargetProof,
  verifyOwnedLocalDisposableTarget,
} from './db-disposable-target';
import {
  classifyBaselineJournal,
  ensureApprovedJournal,
  inspectApprovedJournal,
} from './db-migration-journal';
import { baselineMigration, type ActiveMigration } from './db-migration-assets';
import {
  assertExpectedConnectionUrlTarget,
  assertExpectedDatabaseTarget,
  collectDatabaseInventory,
  collectDatabaseInventoryOnClient,
  fingerprintDatabaseHost,
  type ExpectedDatabaseTarget,
} from './db-schema-inventory';
import {
  verifyNeonProductionTarget,
  verifyNeonRehearsalTarget,
  type NeonProductionIdentityExpectation,
  type NeonRehearsalIdentityExpectation,
  type VerifiedNeonProduction,
  type VerifiedNeonRehearsal,
} from './neon-rehearsal-verifier';

export const ADOPTION_CONFIRMATION = 'ADOPT_LEAGUEVAULT_BASELINE_WITHOUT_DDL';
export const BACKUP_ATTESTATION = 'BACKUP_AND_RESTORE_VERIFIED';
export const PRODUCTION_ENVIRONMENT_CLASS = 'neon-production';
export const PRODUCTION_JOURNAL_RELATION = 'drizzle.__drizzle_migrations';
const ADOPTION_LOCK_KEY = 843_103_001;

const REQUIRED_ADOPTION_KEYS = [
  'DB_ADOPTION_EXPECTED_DATABASE',
  'DB_ADOPTION_EXPECTED_ROLE',
  'DB_ADOPTION_EXPECTED_HOST_FINGERPRINT',
  'DB_ADOPTION_ENVIRONMENT_CLASS',
  'DB_ADOPTION_ENVIRONMENT_ID',
  'DB_ADOPTION_EXPECTED_ENVIRONMENT_ID',
  'DB_ADOPTION_BACKUP_ATTESTATION',
  'DB_ADOPTION_EXPECTED_COMMIT',
  'DB_ADOPTION_EXPECTED_BASELINE_TAG',
  'DB_ADOPTION_EXPECTED_BASELINE_HASH',
  'DB_ADOPTION_EXPECTED_BASELINE_CREATED_AT',
] as const;

export type AdoptionMode = 'preflight' | 'execute';
export type AdoptionEnvironmentClass = 'local-disposable' | 'neon-rehearsal' | 'neon-production';

interface AdoptionRequestBase {
  expectedTarget: ExpectedDatabaseTarget;
  environmentClass: AdoptionEnvironmentClass;
  environmentId: string;
  expectedEnvironmentId: string;
  backupAttestation: string;
  confirmation: string;
  expectedCommit: string;
  expectedBaselineTag: string;
  expectedBaselineHash: string;
  expectedBaselineCreatedAt: number;
}

export interface LocalAdoptionRequest extends AdoptionRequestBase {
  environmentClass: 'local-disposable';
  disposableTargetProof: DisposableTargetProof;
}

export interface NeonRehearsalAdoptionRequest extends AdoptionRequestBase {
  environmentClass: 'neon-rehearsal';
  neonExpectation: NeonRehearsalIdentityExpectation;
}

export interface NeonProductionAdoptionRequest extends AdoptionRequestBase {
  environmentClass: 'neon-production';
  neonExpectation: NeonProductionIdentityExpectation;
  expectedSchemaFingerprint: string;
  expectedJournalRelation: typeof PRODUCTION_JOURNAL_RELATION;
  approvalToken: string;
}

export type AdoptionRequest =
  | LocalAdoptionRequest
  | NeonRehearsalAdoptionRequest
  | NeonProductionAdoptionRequest;

export interface SourceControlState {
  commit: string;
  clean: boolean;
}

export interface AdoptionRuntime {
  sourceControlState?: () => SourceControlState;
  afterPreliminaryVerification?: () => void | Promise<void>;
  afterApplicationLocks?: (client: pg.Client) => void | Promise<void>;
  afterJournalInsert?: (client: pg.Client) => void | Promise<void>;
}

export interface AdoptionResult {
  status: 'adopted' | 'no-op';
  baselineTag: string;
  verificationState: BaselineVerificationState;
}

export interface ProductionPreflightResult {
  status: 'ready';
  baselineTag: string;
  baselineHash: string;
  baselineCreatedAt: number;
  schemaFingerprint: string;
  verificationState: BaselineVerificationState;
  journalRelation: typeof PRODUCTION_JOURNAL_RELATION;
  journalRowCount: 0;
  projectId: string;
  productionBranchId: string;
  endpointId: string;
  endpointHostname: string;
  database: string;
  role: string;
  serverVersion: string;
  transactionIsolation: string;
  transactionReadOnly: true;
}

interface CapabilitySummaryRow extends QueryResultRow {
  can_create_schema: boolean;
  public_usage: boolean;
  public_create: boolean;
}

interface CapabilityObjectRow extends QueryResultRow {
  object_kind: string;
  schema_name: string;
  object_name: string;
  connected_role_can_alter: boolean;
}

interface JournalCapabilityRow extends QueryResultRow {
  drizzle_usage: boolean;
  journal_select: boolean;
  journal_insert: boolean;
  journal_owner_capability: boolean;
  journal_sequence_usage: boolean;
  journal_sequence_owner_capability: boolean;
}

function required(environment: NodeJS.ProcessEnv, key: string): string {
  const value = environment[key]?.trim();
  if (!value) throw new Error(`Required baseline-adoption environment variable is absent: ${key}.`);
  return value;
}

function assertNonProductionEnvironment(environment: NodeJS.ProcessEnv): void {
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
}

function assertProductionOperatorEnvironment(environment: NodeJS.ProcessEnv): void {
  if (
    environment.APP_ENV?.trim().toLowerCase() !== 'prod' ||
    environment.NODE_ENV?.trim().toLowerCase() !== 'production' ||
    environment.APP_DOMAIN?.trim().toLowerCase() !== 'leaguevault.app'
  ) {
    throw new Error('Production adoption requires the exact production application identity.');
  }
  if (
    Boolean(environment.REPLIT_DEPLOYMENT?.trim()) ||
    Boolean(environment.RENDER?.trim()) ||
    Boolean(environment.RENDER_SERVICE_ID?.trim()) ||
    Boolean(environment.RENDER_EXTERNAL_HOSTNAME?.trim())
  ) {
    throw new Error('Production adoption is operator-only and cannot run inside a deployed application process.');
  }
}

export function parseAdoptionEnvironment(
  environment: NodeJS.ProcessEnv,
  mode: AdoptionMode = 'execute',
): AdoptionRequest {
  const missing = REQUIRED_ADOPTION_KEYS.filter((key) => !environment[key]?.trim());
  if (missing.length > 0) {
    throw new Error(`Required baseline-adoption environment variable(s) are absent: ${missing.join(', ')}.`);
  }
  const environmentClass = required(environment, 'DB_ADOPTION_ENVIRONMENT_CLASS');
  if (
    environmentClass !== 'local-disposable' &&
    environmentClass !== 'neon-rehearsal' &&
    environmentClass !== PRODUCTION_ENVIRONMENT_CLASS
  ) {
    throw new Error('Only tool-owned local disposable or provider-verified Neon adoption is supported.');
  }
  if (environmentClass === PRODUCTION_ENVIRONMENT_CLASS) {
    assertProductionOperatorEnvironment(environment);
  } else {
    assertNonProductionEnvironment(environment);
    if (mode === 'preflight') {
      throw new Error('The standalone read-only preflight accepts only the Neon production environment class.');
    }
  }
  const environmentId = required(environment, 'DB_ADOPTION_ENVIRONMENT_ID');
  const expectedEnvironmentId = required(environment, 'DB_ADOPTION_EXPECTED_ENVIRONMENT_ID');
  if (
    environmentId !== expectedEnvironmentId ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(expectedEnvironmentId)
  ) {
    throw new Error('The independently expected environment identity is mismatched or invalid.');
  }
  if (
    environmentClass !== PRODUCTION_ENVIRONMENT_CLASS &&
    /(?:^|[-_.:])(prod|production|live)(?:$|[-_.:])/i.test(expectedEnvironmentId)
  ) {
    throw new Error('The independently expected environment identity is production-shaped.');
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
  const common = {
    expectedTarget: {
      database: required(environment, 'DB_ADOPTION_EXPECTED_DATABASE'),
      role: required(environment, 'DB_ADOPTION_EXPECTED_ROLE'),
      hostFingerprint,
    },
    environmentId,
    expectedEnvironmentId,
    backupAttestation: required(environment, 'DB_ADOPTION_BACKUP_ATTESTATION'),
    confirmation: mode === 'execute' ? required(environment, 'DB_ADOPTION_CONFIRM') : '',
    expectedCommit: required(environment, 'DB_ADOPTION_EXPECTED_COMMIT'),
    expectedBaselineTag: required(environment, 'DB_ADOPTION_EXPECTED_BASELINE_TAG'),
    expectedBaselineHash: required(environment, 'DB_ADOPTION_EXPECTED_BASELINE_HASH'),
    expectedBaselineCreatedAt: createdAt,
  };
  if (environmentClass === 'local-disposable') {
    return {
      ...common,
      environmentClass,
      disposableTargetProof: readDisposableTargetProof(environment),
    };
  }
  if (!environment.NEON_API_KEY?.trim()) {
    throw new Error('Required baseline-adoption environment variable is absent: NEON_API_KEY.');
  }
  const readNeonId = (key: string): string => {
    const value = environment[key]?.trim();
    if (!value) throw new Error(`Required baseline-adoption environment variable is absent: ${key}.`);
    return value;
  };
  const neonExpectation = {
    projectId: readNeonId('DB_ADOPTION_NEON_EXPECTED_PROJECT_ID'),
    targetBranchId: readNeonId('DB_ADOPTION_NEON_EXPECTED_TARGET_BRANCH_ID'),
    productionBranchId: readNeonId('DB_ADOPTION_NEON_EXPECTED_PRODUCTION_BRANCH_ID'),
    endpointId: readNeonId('DB_ADOPTION_NEON_EXPECTED_ENDPOINT_ID'),
  };
  if (environmentClass === PRODUCTION_ENVIRONMENT_CLASS) {
    if (neonExpectation.targetBranchId !== neonExpectation.productionBranchId) {
      throw new Error('The production environment identity requires the target branch to equal production.');
    }
    const exactEnvironmentId = [
      PRODUCTION_ENVIRONMENT_CLASS,
      neonExpectation.projectId,
      neonExpectation.productionBranchId,
      neonExpectation.endpointId,
    ].join(':');
    if (environmentId !== exactEnvironmentId) {
      throw new Error('The production environment identity does not exactly bind the expected project, branch, and endpoint.');
    }
    const expectedSchemaFingerprint = environment.DB_ADOPTION_EXPECTED_SCHEMA_FINGERPRINT?.trim();
    if (!expectedSchemaFingerprint || !/^[0-9a-f]{64}$/.test(expectedSchemaFingerprint)) {
      throw new Error('DB_ADOPTION_EXPECTED_SCHEMA_FINGERPRINT must be an exact lowercase SHA-256 digest.');
    }
    if (expectedSchemaFingerprint !== loadApprovedBaselineFingerprint().digest) {
      throw new Error('The independently supplied schema fingerprint does not match the checked-in baseline.');
    }
    const expectedJournalRelation = environment.DB_ADOPTION_EXPECTED_JOURNAL_RELATION?.trim();
    if (expectedJournalRelation !== PRODUCTION_JOURNAL_RELATION) {
      throw new Error(`DB_ADOPTION_EXPECTED_JOURNAL_RELATION must be ${PRODUCTION_JOURNAL_RELATION}.`);
    }
    const suppliedToken = environment.DB_ADOPTION_APPROVAL_TOKEN?.trim() ?? '';
    if (mode === 'preflight') {
      if (environment.DB_ADOPTION_CONFIRM?.trim() || suppliedToken) {
        throw new Error('Production preflight requires confirmation and the ephemeral approval token to be absent.');
      }
    } else if (!/^[A-Za-z0-9_-]{43,128}$/.test(suppliedToken)) {
      throw new Error('Production execution requires an ephemeral base64url approval token of at least 256 bits.');
    }
    return {
      ...common,
      environmentClass,
      neonExpectation,
      expectedSchemaFingerprint,
      expectedJournalRelation,
      approvalToken: suppliedToken,
    };
  }
  return {
    ...common,
    environmentClass,
    neonExpectation,
  };
}

function sourceControlChildEnvironment(): NodeJS.ProcessEnv {
  const childEnvironment = { ...process.env };
  for (const key of Object.keys(childEnvironment)) {
    if (['NEON_API_KEY', 'DB_ADOPTION_APPROVAL_TOKEN'].includes(key.toUpperCase())) {
      delete childEnvironment[key];
    }
  }
  return childEnvironment;
}

function readSourceControlState(): SourceControlState {
  const environment = sourceControlChildEnvironment();
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
    env: environment,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  }).trim();
  const status = execFileSync('git', ['status', '--porcelain'], {
    encoding: 'utf8',
    env: environment,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  return { commit, clean: status.trim().length === 0 };
}

export function validateAdoptionRequest(
  request: AdoptionRequest,
  sourceControl: SourceControlState,
  baseline: ActiveMigration = baselineMigration(),
  mode: AdoptionMode = 'execute',
): void {
  if (
    !['local-disposable', 'neon-rehearsal', PRODUCTION_ENVIRONMENT_CLASS].includes(request.environmentClass) ||
    request.environmentId !== request.expectedEnvironmentId ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(request.environmentId)
  ) {
    throw new Error('Only an exactly identified approved environment may be adopted.');
  }
  if (
    request.environmentClass !== PRODUCTION_ENVIRONMENT_CLASS &&
    /(?:^|[-_.:])(prod|production|live)(?:$|[-_.:])/i.test(request.environmentId)
  ) {
    throw new Error('A nonproduction adoption request cannot use a production-shaped environment identity.');
  }
  if (mode === 'preflight' && request.environmentClass !== PRODUCTION_ENVIRONMENT_CLASS) {
    throw new Error('The standalone read-only preflight accepts only the Neon production environment class.');
  }
  if (request.environmentClass === PRODUCTION_ENVIRONMENT_CLASS) {
    const exactEnvironmentId = [
      PRODUCTION_ENVIRONMENT_CLASS,
      request.neonExpectation.projectId,
      request.neonExpectation.productionBranchId,
      request.neonExpectation.endpointId,
    ].join(':');
    if (
      request.environmentId !== exactEnvironmentId ||
      request.neonExpectation.targetBranchId !== request.neonExpectation.productionBranchId ||
      request.expectedJournalRelation !== PRODUCTION_JOURNAL_RELATION
    ) {
      throw new Error('The production request does not exactly bind the approved project, branch, endpoint, and journal.');
    }
  }
  if (
    request.environmentClass === 'local-disposable' &&
    request.disposableTargetProof.database !== request.expectedTarget.database
  ) {
    throw new Error('The disposable database proof does not identify the expected adoption database.');
  }
  if (mode === 'execute' && request.confirmation !== ADOPTION_CONFIRMATION) {
    throw new Error('Explicit baseline-adoption confirmation is missing or incorrect.');
  }
  if (
    request.environmentClass === PRODUCTION_ENVIRONMENT_CLASS &&
    mode === 'execute' &&
    !/^[A-Za-z0-9_-]{43,128}$/.test(request.approvalToken)
  ) {
    throw new Error('Production execution requires a valid ephemeral approval token.');
  }
  if (
    request.environmentClass === PRODUCTION_ENVIRONMENT_CLASS &&
    mode === 'preflight' &&
    (request.confirmation || request.approvalToken)
  ) {
    throw new Error('Production preflight cannot carry execution authorization.');
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
  if (
    request.environmentClass === PRODUCTION_ENVIRONMENT_CLASS &&
    request.expectedSchemaFingerprint !== loadApprovedBaselineFingerprint(undefined, baseline).digest
  ) {
    throw new Error('The independently supplied schema fingerprint does not match the checked-in baseline.');
  }
}

export async function assertMigrationRoleCapabilityOnClient(
  client: pg.Client,
  includeJournal: boolean,
): Promise<void> {
  const summary = await client.query<CapabilitySummaryRow>(`
    SELECT
      pg_catalog.has_database_privilege(current_database(), 'CREATE') AS can_create_schema,
      pg_catalog.has_schema_privilege('public', 'USAGE') AS public_usage,
      pg_catalog.has_schema_privilege('public', 'CREATE') AS public_create
  `);
  const capability = summary.rows[0];
  if (!capability?.can_create_schema || !capability.public_usage || !capability.public_create) {
    throw new Error('The adoption role lacks database or public-schema capability required by future migrations.');
  }

  const objects = await client.query<CapabilityObjectRow>(`
    WITH required_objects AS (
      SELECT 'table'::text AS object_kind, namespace.nspname AS schema_name,
        relation.relname AS object_name, relation.relowner AS owner_oid
      FROM pg_catalog.pg_class relation
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relkind IN ('r', 'p')
        AND relation.relname = ANY($1::text[])

      UNION ALL

      SELECT 'sequence', sequence_namespace.nspname, sequence_relation.relname, sequence_relation.relowner
      FROM pg_catalog.pg_class sequence_relation
      JOIN pg_catalog.pg_namespace sequence_namespace ON sequence_namespace.oid = sequence_relation.relnamespace
      JOIN pg_catalog.pg_depend ownership
        ON ownership.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
        AND ownership.objid = sequence_relation.oid
        AND ownership.objsubid = 0
        AND ownership.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
        AND ownership.deptype IN ('a', 'i')
      JOIN pg_catalog.pg_class owned_table ON owned_table.oid = ownership.refobjid
      JOIN pg_catalog.pg_namespace owned_namespace ON owned_namespace.oid = owned_table.relnamespace
      WHERE sequence_relation.relkind = 'S'
        AND owned_namespace.nspname = 'public'
        AND owned_table.relname = ANY($1::text[])

      UNION ALL

      SELECT 'function', namespace.nspname,
        procedure.proname || '(' || pg_catalog.pg_get_function_identity_arguments(procedure.oid) || ')',
        procedure.proowner
      FROM pg_catalog.pg_proc procedure
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'public' AND procedure.proname = ANY($2::text[])

      UNION ALL

      SELECT 'type', namespace.nspname, type.typname, type.typowner
      FROM pg_catalog.pg_type type
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = type.typnamespace
      WHERE namespace.nspname = 'public' AND type.typname = 'user_role'
    )
    SELECT object_kind, schema_name, object_name,
      pg_catalog.pg_has_role(owner_oid, 'USAGE') AS connected_role_can_alter
    FROM required_objects
    ORDER BY object_kind, schema_name, object_name
  `, [APPLICATION_TABLE_NAMES, APPROVED_INVARIANT_FUNCTION_NAMES]);
  const expectedObjectCount = APPLICATION_TABLE_NAMES.length + 26 + APPROVED_INVARIANT_FUNCTION_NAMES.length + 1;
  const incapable = objects.rows.filter((object) => !object.connected_role_can_alter);
  if (objects.rows.length !== expectedObjectCount || incapable.length > 0) {
    throw new Error('The adoption role cannot act as owner for every application object required by future migrations.');
  }

  if (!includeJournal) return;
  const journal = await client.query<JournalCapabilityRow>(`
    SELECT
      pg_catalog.has_schema_privilege('drizzle', 'USAGE') AS drizzle_usage,
      pg_catalog.has_table_privilege(
        'drizzle.__drizzle_migrations'::pg_catalog.regclass, 'SELECT'
      ) AS journal_select,
      pg_catalog.has_table_privilege(
        'drizzle.__drizzle_migrations'::pg_catalog.regclass, 'INSERT'
      ) AS journal_insert,
      pg_catalog.pg_has_role(journal_table.relowner, 'USAGE') AS journal_owner_capability,
      pg_catalog.has_sequence_privilege(
        'drizzle.__drizzle_migrations_id_seq'::pg_catalog.regclass, 'USAGE'
      ) AS journal_sequence_usage,
      pg_catalog.pg_has_role(journal_sequence.relowner, 'USAGE') AS journal_sequence_owner_capability
    FROM pg_catalog.pg_class journal_table
    JOIN pg_catalog.pg_class journal_sequence
      ON journal_sequence.oid = 'drizzle.__drizzle_migrations_id_seq'::pg_catalog.regclass
    WHERE journal_table.oid = 'drizzle.__drizzle_migrations'::pg_catalog.regclass
  `);
  const journalCapability = journal.rows[0];
  if (
    !journalCapability?.drizzle_usage || !journalCapability.journal_select ||
    !journalCapability.journal_insert || !journalCapability.journal_owner_capability ||
    !journalCapability.journal_sequence_usage || !journalCapability.journal_sequence_owner_capability
  ) {
    throw new Error('The adoption role lacks exact Drizzle journal capability required by future migrations.');
  }
}

async function assertMigrationRoleCapabilityReadOnly(
  connectionString: string,
  expectedTarget: ExpectedDatabaseTarget,
  includeJournal = false,
): Promise<void> {
  const client = new pg.Client({
    connectionString,
    application_name: 'leaguevault-db-adopt-capability-preflight',
  });
  let transaction = false;
  try {
    await client.connect();
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    transaction = true;
    const target = await client.query<{ database_name: string; role_name: string }>(
      'SELECT current_database() AS database_name, current_user AS role_name',
    );
    const row = target.rows[0];
    if (!row) throw new Error('PostgreSQL did not return adoption capability target metadata.');
    assertExpectedDatabaseTarget({
      hostFingerprint: fingerprintDatabaseHost(connectionString),
      database: row.database_name,
      role: row.role_name,
    }, expectedTarget);
    await assertMigrationRoleCapabilityOnClient(client, includeJournal);
    await client.query('COMMIT');
    transaction = false;
  } finally {
    if (transaction) await client.query('ROLLBACK').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

function applicationTableLockSql(): string {
  const names = APPLICATION_TABLE_NAMES.map((name) => `public."${name}"`).join(', ');
  return `LOCK TABLE ${names} IN ACCESS EXCLUSIVE MODE`;
}

async function lockSequenceDefinitions(
  client: pg.Client,
  sequences: ReadonlyArray<{ schema: string; name: string }>,
): Promise<void> {
  const relations = sequences
    .map((sequence) => `"${sequence.schema}"."${sequence.name}"`)
    .join(', ');
  const relationOids = sequences
    .map((sequence) => `'${sequence.schema}.${sequence.name}'::pg_catalog.regclass`);

  // Sequence relations do not support LOCK TABLE. PostgreSQL's
  // pg_sequence_last_value() opens each sequence with RowExclusiveLock without
  // advancing it. That conflicts with the ShareRowExclusiveLock used by ALTER
  // SEQUENCE, covering configuration and OWNED BY changes without requiring
  // row-lock privileges on provider-managed system catalogs.
  const relationLocks = await client.query<{ seqrelid: string; last_value: string | null }>(`
    SELECT approved.seqrelid::text,
      pg_catalog.pg_sequence_last_value(approved.seqrelid)::text AS last_value
    FROM (VALUES ${relationOids.map((oid) => `(${oid})`).join(', ')}) approved(seqrelid)
    ORDER BY approved.seqrelid
  `);
  if (relationLocks.rows.length !== sequences.length) {
    throw new Error(`Could not lock every approved sequence relation: ${relations}.`);
  }

  const heldLocks = await client.query<{ relation_oid: string }>(`
    SELECT relation::text AS relation_oid
    FROM pg_catalog.pg_locks
    WHERE pid = pg_catalog.pg_backend_pid()
      AND locktype = 'relation'
      AND relation = ANY(ARRAY[${relationOids.join(', ')}])
      AND mode = 'RowExclusiveLock'
      AND granted
    ORDER BY relation
  `);
  if (heldLocks.rows.length !== sequences.length) {
    throw new Error('Could not confirm the protective lock on every approved sequence relation.');
  }
}

async function atomicallyRegisterBaseline(
  connectionString: string,
  request: AdoptionRequest,
  baseline: ActiveMigration,
  approved: ReturnType<typeof loadApprovedBaselineFingerprint>,
  runtime: AdoptionRuntime,
): Promise<{ status: 'adopted' | 'no-op'; verificationState: BaselineVerificationState }> {
  const client = new pg.Client({
    connectionString,
    application_name: 'leaguevault-db-adopt-baseline',
  });
  let sessionLock = false;
  let transaction = false;
  try {
    await client.connect();
    await client.query('SELECT pg_catalog.pg_advisory_lock($1)', [ADOPTION_LOCK_KEY]);
    sessionLock = true;
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    transaction = true;
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL lock_timeout = '5s'");

    // PostgreSQL freezes a serializable snapshot at the first SELECT or data
    // modification. Lock the complete approved table set first so final
    // inventory cannot observe a snapshot from before a lock wait.
    await client.query(applicationTableLockSql());
    await lockSequenceDefinitions(client, approved.structure.sequences);
    await client.query('SELECT pg_catalog.pg_advisory_xact_lock($1)', [ADOPTION_LOCK_KEY]);
    await runtime.afterApplicationLocks?.(client);

    if (request.environmentClass === PRODUCTION_ENVIRONMENT_CLASS) {
      const existingJournal = await inspectApprovedJournal(client, { lock: true });
      if (!existingJournal.exists) {
        throw new Error('Production adoption requires the approved migration journal to exist before execution.');
      }
    } else {
      await ensureApprovedJournal(client);
    }
    await lockSequenceDefinitions(client, [{
      schema: 'drizzle',
      name: '__drizzle_migrations_id_seq',
    }]);
    const target = await client.query<{ database_name: string; role_name: string; marker: string | null }>(`
      SELECT current_database() AS database_name, current_user AS role_name,
        pg_catalog.shobj_description(database_row.oid, 'pg_database') AS marker
      FROM pg_catalog.pg_database database_row
      WHERE database_row.datname = current_database()
    `);
    const row = target.rows[0];
    if (!row) throw new Error('PostgreSQL did not return adoption target metadata.');
    assertExpectedDatabaseTarget({
      hostFingerprint: fingerprintDatabaseHost(connectionString),
      database: row.database_name,
      role: row.role_name,
    }, request.expectedTarget);
    if (
      request.environmentClass === 'local-disposable' &&
      row.marker !== disposableDatabaseMarker(request.disposableTargetProof)
    ) {
      throw new Error('The atomic adoption connection lost its exact disposable database ownership marker.');
    }

    await assertMigrationRoleCapabilityOnClient(client, true);
    const inventory = await collectDatabaseInventoryOnClient(client, connectionString, {
      expectedTarget: request.expectedTarget,
    });
    const verification = verifyBaselineInventory(inventory, baseline, approved);

    const journal = await inspectApprovedJournal(client, { lock: true });
    const state = classifyBaselineJournal(journal.entries, baseline);
    if (state === 'baseline') {
      await client.query('COMMIT');
      transaction = false;
      return { status: 'no-op', verificationState: verification.state };
    }

    await client.query(
      'INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)',
      [baseline.hash, baseline.createdAt],
    );
    await runtime.afterJournalInsert?.(client);
    const confirmedInventory = await collectDatabaseInventoryOnClient(client, connectionString, {
      expectedTarget: request.expectedTarget,
    });
    const confirmedVerification = verifyBaselineInventory(confirmedInventory, baseline, approved);
    const confirmed = await inspectApprovedJournal(client, { lock: true });
    if (classifyBaselineJournal(confirmed.entries, baseline) !== 'baseline') {
      throw new Error('The exact baseline journal record was not confirmed before adoption commit.');
    }
    await client.query('COMMIT');
    transaction = false;
    return { status: 'adopted', verificationState: confirmedVerification.state };
  } finally {
    if (transaction) await client.query('ROLLBACK').catch(() => undefined);
    if (sessionLock) {
      await client.query('SELECT pg_catalog.pg_advisory_unlock($1)', [ADOPTION_LOCK_KEY]).catch(() => undefined);
    }
    await client.end().catch(() => undefined);
  }
}

export async function adoptExistingDatabaseBaseline(
  connectionString: string,
  request: AdoptionRequest,
  runtime: AdoptionRuntime = {},
  neonApiKey?: string,
): Promise<AdoptionResult> {
  const baseline = baselineMigration();
  const approved = loadApprovedBaselineFingerprint(undefined, baseline);
  const sourceControl = (runtime.sourceControlState ?? readSourceControlState)();
  validateAdoptionRequest(request, sourceControl, baseline);
  assertExpectedConnectionUrlTarget(connectionString, request.expectedTarget);
  let verifyProviderIdentityImmediately = async (): Promise<void> => undefined;
  if (request.environmentClass === 'local-disposable') {
    const verified = await verifyOwnedLocalDisposableTarget(
      connectionString,
      request.disposableTargetProof,
    );
    if (
      verified.targetUrl !== connectionString || verified.database !== request.expectedTarget.database ||
      verified.role !== request.expectedTarget.role
    ) {
      throw new Error('Verified disposable target does not match the exact requested adoption target.');
    }
  } else if (request.environmentClass === 'neon-rehearsal') {
    const hostname = new URL(connectionString).hostname;
    const assertVerifiedIdentity = (verified: VerifiedNeonRehearsal): void => {
      const normalizedHostname = hostname.toLowerCase().replace(/\.$/, '');
      if (
        verified.projectId !== request.neonExpectation.projectId ||
        verified.targetBranchId !== request.neonExpectation.targetBranchId ||
        verified.productionBranchId !== request.neonExpectation.productionBranchId ||
        verified.endpointId !== request.neonExpectation.endpointId ||
        verified.endpointHostname !== normalizedHostname
      ) {
        throw new Error('Verified Neon provider identity does not match the exact rehearsal request.');
      }
    };
    verifyProviderIdentityImmediately = async (): Promise<void> => {
      const verified = await verifyNeonRehearsalTarget({
        ...request.neonExpectation,
        apiKey: neonApiKey ?? '',
      }, hostname);
      assertVerifiedIdentity(verified);
    };
    await verifyProviderIdentityImmediately();
  } else {
    const hostname = new URL(connectionString).hostname;
    const assertVerifiedIdentity = (verified: VerifiedNeonProduction): void => {
      const normalizedHostname = hostname.toLowerCase().replace(/\.$/, '');
      if (
        verified.projectId !== request.neonExpectation.projectId ||
        verified.productionBranchId !== request.neonExpectation.productionBranchId ||
        verified.endpointId !== request.neonExpectation.endpointId ||
        verified.endpointHostname !== normalizedHostname
      ) {
        throw new Error('Verified Neon provider identity does not match the exact production request.');
      }
    };
    verifyProviderIdentityImmediately = async (): Promise<void> => {
      const verified = await verifyNeonProductionTarget({
        ...request.neonExpectation,
        apiKey: neonApiKey ?? '',
      }, hostname);
      assertVerifiedIdentity(verified);
    };
    await verifyProviderIdentityImmediately();
  }

  await assertMigrationRoleCapabilityReadOnly(
    connectionString,
    request.expectedTarget,
    request.environmentClass === PRODUCTION_ENVIRONMENT_CLASS,
  );
  const preliminaryInventory = await collectDatabaseInventory(connectionString, {
    expectedTarget: request.expectedTarget,
  });
  verifyBaselineInventory(preliminaryInventory, baseline, approved);
  await runtime.afterPreliminaryVerification?.();
  await verifyProviderIdentityImmediately();

  const result = await atomicallyRegisterBaseline(
    connectionString,
    request,
    baseline,
    approved,
    runtime,
  );
  return { ...result, baselineTag: baseline.tag };
}

export async function preflightProductionDatabaseBaseline(
  connectionString: string,
  request: NeonProductionAdoptionRequest,
  runtime: Pick<AdoptionRuntime, 'sourceControlState'> = {},
  neonApiKey?: string,
): Promise<ProductionPreflightResult> {
  const baseline = baselineMigration();
  const approved = loadApprovedBaselineFingerprint(undefined, baseline);
  const sourceControl = (runtime.sourceControlState ?? readSourceControlState)();
  validateAdoptionRequest(request, sourceControl, baseline, 'preflight');
  assertExpectedConnectionUrlTarget(connectionString, request.expectedTarget);
  const hostname = new URL(connectionString).hostname;
  const verifyProviderIdentity = async (): Promise<VerifiedNeonProduction> => {
    const verified = await verifyNeonProductionTarget({
      ...request.neonExpectation,
      apiKey: neonApiKey ?? '',
    }, hostname);
    const normalizedHostname = hostname.toLowerCase().replace(/\.$/, '');
    if (
      verified.projectId !== request.neonExpectation.projectId ||
      verified.productionBranchId !== request.neonExpectation.productionBranchId ||
      verified.endpointId !== request.neonExpectation.endpointId ||
      verified.endpointHostname !== normalizedHostname
    ) {
      throw new Error('Verified Neon provider identity does not match the exact production preflight request.');
    }
    return verified;
  };

  await verifyProviderIdentity();
  const client = new pg.Client({
    connectionString,
    application_name: 'leaguevault-db-adopt-production-journal-preflight',
  });
  let transaction = false;
  try {
    await client.connect();
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    transaction = true;
    const journal = await inspectApprovedJournal(client);
    if (!journal.exists) {
      throw new Error('Production preflight requires the approved migration journal to exist.');
    }
    if (classifyBaselineJournal(journal.entries, baseline) !== 'absent-or-empty') {
      throw new Error('Production preflight requires an exact empty migration journal.');
    }
    await client.query('COMMIT');
    transaction = false;
  } finally {
    if (transaction) await client.query('ROLLBACK').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
  await assertMigrationRoleCapabilityReadOnly(connectionString, request.expectedTarget, true);
  const inventory = await collectDatabaseInventory(connectionString, {
    expectedTarget: request.expectedTarget,
  });
  const verification = verifyBaselineInventory(inventory, baseline, approved);
  const finalProvider = await verifyProviderIdentity();
  return {
    status: 'ready',
    baselineTag: baseline.tag,
    baselineHash: baseline.hash,
    baselineCreatedAt: baseline.createdAt,
    schemaFingerprint: verification.fingerprint.digest,
    verificationState: verification.state,
    journalRelation: PRODUCTION_JOURNAL_RELATION,
    journalRowCount: 0,
    projectId: finalProvider.projectId,
    productionBranchId: finalProvider.productionBranchId,
    endpointId: finalProvider.endpointId,
    endpointHostname: finalProvider.endpointHostname,
    database: inventory.target.database,
    role: inventory.target.role,
    serverVersion: inventory.target.serverVersion,
    transactionIsolation: inventory.target.transactionIsolation,
    transactionReadOnly: true,
  };
}
