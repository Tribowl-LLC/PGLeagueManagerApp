import { spawnSync } from 'node:child_process';
import pg, { type QueryResultRow } from 'pg';

export const DISPOSABLE_DATABASE_LABELS = {
  owner: 'com.leaguevault.disposable-postgres.owner',
  runId: 'com.leaguevault.disposable-postgres.run-id',
  purpose: 'com.leaguevault.disposable-postgres.purpose',
  databases: 'com.leaguevault.disposable-postgres.databases',
} as const;
export const DISPOSABLE_DATABASE_OWNER = 'LeagueVault';

const PROOF_ENVIRONMENT_KEYS = {
  containerId: 'LV_DISPOSABLE_DB_CONTAINER_ID',
  runId: 'LV_DISPOSABLE_DB_RUN_ID',
  purpose: 'LV_DISPOSABLE_DB_PURPOSE',
  database: 'LV_DISPOSABLE_DB_DATABASE',
} as const;

export interface DisposableTargetProof {
  containerId: string;
  runId: string;
  purpose: string;
  database: string;
}

export interface DockerPortBinding {
  HostIp: string;
  HostPort: string;
}

export interface DisposableContainerInspection {
  Id: string;
  State?: { Running?: boolean };
  Config?: {
    Labels?: Record<string, string> | null;
    Volumes?: Record<string, Record<string, never>> | null;
  };
  HostConfig?: {
    AutoRemove?: boolean;
    Binds?: string[] | null;
    Mounts?: unknown[] | null;
    Tmpfs?: Record<string, string> | null;
    VolumesFrom?: string[] | null;
  };
  NetworkSettings?: { Ports?: Record<string, DockerPortBinding[] | null> };
  Mounts?: Array<{
    Type?: string;
    Name?: string;
    Destination?: string;
    Driver?: string;
    Mode?: string;
    RW?: boolean;
    Propagation?: string;
  }>;
}

export interface DisposableDatabaseProbe {
  database: string;
  role: string;
  marker: string | null;
}

export interface DisposableTargetRuntime {
  inspectContainer(containerId: string): DisposableContainerInspection | Promise<DisposableContainerInspection>;
  probeDatabase(targetUrl: string): Promise<DisposableDatabaseProbe>;
}

export interface VerifiedDisposableTarget {
  targetUrl: string;
  database: string;
  role: string;
  containerId: string;
  runId: string;
  purpose: string;
}

interface ProbeRow extends QueryResultRow {
  database: string;
  role: string;
  marker: string | null;
}

function requiredProofValue(environment: NodeJS.ProcessEnv, key: string): string {
  const value = environment[key]?.trim();
  if (!value) throw new Error(`Disposable database proof is missing ${key}.`);
  return value;
}

function assertProofToken(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`Disposable database proof contains an invalid ${label}.`);
  }
}

function assertDatabaseName(database: string): void {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(database)) {
    throw new Error('Disposable database proof contains an invalid database name.');
  }
}

export function encodeDisposableDatabaseLabel(databases: readonly string[]): string {
  if (databases.length === 0) throw new Error('Disposable database label must approve at least one database.');
  for (const database of databases) assertDatabaseName(database);
  const normalized = [...new Set(databases)].sort();
  if (normalized.length !== databases.length) {
    throw new Error('Disposable database label must not contain duplicate database names.');
  }
  return JSON.stringify(normalized);
}

export function readDisposableTargetProof(environment: NodeJS.ProcessEnv): DisposableTargetProof {
  const proof = {
    containerId: requiredProofValue(environment, PROOF_ENVIRONMENT_KEYS.containerId),
    runId: requiredProofValue(environment, PROOF_ENVIRONMENT_KEYS.runId),
    purpose: requiredProofValue(environment, PROOF_ENVIRONMENT_KEYS.purpose),
    database: requiredProofValue(environment, PROOF_ENVIRONMENT_KEYS.database),
  };
  if (!/^[a-f0-9]{64}$/.test(proof.containerId)) {
    throw new Error('Disposable database proof must contain the full lowercase Docker container ID.');
  }
  assertProofToken(proof.runId, 'run identifier');
  assertProofToken(proof.purpose, 'purpose');
  assertDatabaseName(proof.database);
  return proof;
}

export function disposableTargetProofEnvironment(proof: DisposableTargetProof): NodeJS.ProcessEnv {
  if (!/^[a-f0-9]{64}$/.test(proof.containerId)) {
    throw new Error('Disposable database proof must contain the full lowercase Docker container ID.');
  }
  assertProofToken(proof.runId, 'run identifier');
  assertProofToken(proof.purpose, 'purpose');
  assertDatabaseName(proof.database);
  return {
    [PROOF_ENVIRONMENT_KEYS.containerId]: proof.containerId,
    [PROOF_ENVIRONMENT_KEYS.runId]: proof.runId,
    [PROOF_ENVIRONMENT_KEYS.purpose]: proof.purpose,
    [PROOF_ENVIRONMENT_KEYS.database]: proof.database,
  };
}

export function disposableDatabaseMarker(proof: DisposableTargetProof): string {
  return `leaguevault-disposable:v1:${proof.runId}:${proof.purpose}:${proof.database}`;
}

function parseTargetUrl(targetUrl: string): { database: string; role: string; port: string } {
  if (!targetUrl || targetUrl !== targetUrl.trim()) {
    throw new Error('Disposable database target URL must be one explicit, unpadded URL.');
  }
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new Error('Disposable database target URL is invalid.');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('Disposable database target URL must use postgres or postgresql.');
  }
  if (parsed.hostname !== '127.0.0.1') {
    throw new Error('Remote db:push is disabled; the target must be the exact 127.0.0.1 Docker binding.');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('Disposable database target URL must not contain query overrides or a fragment.');
  }
  if (!parsed.port || !/^\d+$/.test(parsed.port)) {
    throw new Error('Disposable database target URL must contain an explicit published Docker port.');
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('Disposable database target URL contains an invalid port.');
  }

  let database: string;
  let role: string;
  try {
    database = decodeURIComponent(parsed.pathname.slice(1));
    role = decodeURIComponent(parsed.username);
  } catch {
    throw new Error('Disposable database target URL contains invalid percent encoding.');
  }
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(database) || parsed.pathname.slice(1).includes('/')) {
    throw new Error('Disposable database target URL must identify one exact approved database.');
  }
  if (!role || role.length > 63 || /[\u0000-\u001f\u007f]/.test(role)) {
    throw new Error('Disposable database target URL must identify one exact database role.');
  }
  return { database, role, port: String(port) };
}

function defaultInspectContainer(containerId: string): DisposableContainerInspection {
  const result = spawnSync(
    'docker',
    ['inspect', '--type', 'container', '--format', '{{json .}}', containerId],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false },
  );
  if (result.error || result.status !== 0) {
    throw new Error('Could not inspect the disposable Docker container from the supplied proof.');
  }
  try {
    return JSON.parse(result.stdout) as DisposableContainerInspection;
  } catch {
    throw new Error('Docker returned invalid disposable-container inspection metadata.');
  }
}

async function defaultProbeDatabase(targetUrl: string): Promise<DisposableDatabaseProbe> {
  const client = new pg.Client({
    connectionString: targetUrl,
    application_name: 'leaguevault-disposable-target-proof',
  });
  try {
    await client.connect();
    const result = await client.query<ProbeRow>(`
      SELECT
        current_database() AS database,
        current_user AS role,
        shobj_description(database_row.oid, 'pg_database') AS marker
      FROM pg_database AS database_row
      WHERE database_row.datname = current_database()
    `);
    const row = result.rows[0];
    if (!row || result.rows.length !== 1) {
      throw new Error('Disposable database identity query returned an unexpected result.');
    }
    return row;
  } finally {
    await client.end().catch(() => undefined);
  }
}

export const defaultDisposableTargetRuntime: DisposableTargetRuntime = {
  inspectContainer: defaultInspectContainer,
  probeDatabase: defaultProbeDatabase,
};

export async function verifyOwnedLocalDisposableTarget(
  targetUrl: string,
  proof: DisposableTargetProof,
  runtime: DisposableTargetRuntime = defaultDisposableTargetRuntime,
): Promise<VerifiedDisposableTarget> {
  if (!/^[a-f0-9]{64}$/.test(proof.containerId)) {
    throw new Error('Disposable database proof must contain the full lowercase Docker container ID.');
  }
  assertProofToken(proof.runId, 'run identifier');
  assertProofToken(proof.purpose, 'purpose');
  assertDatabaseName(proof.database);
  const target = parseTargetUrl(targetUrl);
  if (target.database !== proof.database) {
    throw new Error('Disposable database target does not match the exact database in its ownership proof.');
  }

  const inspection = await runtime.inspectContainer(proof.containerId);
  if (inspection.Id !== proof.containerId) {
    throw new Error('Disposable database target did not verify the exact full Docker container ID.');
  }
  if (inspection.State?.Running !== true) {
    throw new Error('Disposable database Docker container is not running.');
  }
  const hostConfig = inspection.HostConfig;
  const configuredVolumes = Object.keys(inspection.Config?.Volumes ?? {});
  const mounts = inspection.Mounts ?? [];
  if (
    hostConfig?.AutoRemove !== true ||
    (hostConfig.Binds?.length ?? 0) !== 0 ||
    (hostConfig.Mounts?.length ?? 0) !== 0 ||
    Object.keys(hostConfig.Tmpfs ?? {}).length !== 0 ||
    (hostConfig.VolumesFrom?.length ?? 0) !== 0 ||
    configuredVolumes.length !== 1 ||
    configuredVolumes[0] !== '/var/lib/postgresql/data' ||
    mounts.length !== 1 ||
    mounts[0]?.Type !== 'volume' ||
    !/^[a-f0-9]{64}$/.test(mounts[0]?.Name ?? '') ||
    mounts[0]?.Destination !== '/var/lib/postgresql/data' ||
    mounts[0]?.Driver !== 'local' ||
    mounts[0]?.Mode !== '' ||
    mounts[0]?.RW !== true ||
    mounts[0]?.Propagation !== ''
  ) {
    throw new Error(
      'Disposable database container must use auto-removal and only its Docker-created anonymous PostgreSQL data volume.',
    );
  }
  const labels = inspection.Config?.Labels ?? {};
  const expectedLabels: Array<[string, string]> = [
    [DISPOSABLE_DATABASE_LABELS.owner, DISPOSABLE_DATABASE_OWNER],
    [DISPOSABLE_DATABASE_LABELS.runId, proof.runId],
    [DISPOSABLE_DATABASE_LABELS.purpose, proof.purpose],
  ];
  for (const [key, value] of expectedLabels) {
    if (labels[key] !== value) {
      throw new Error(`Disposable database Docker ownership label mismatch: ${key}.`);
    }
  }
  const approvedDatabasesLabel = labels[DISPOSABLE_DATABASE_LABELS.databases];
  let approvedDatabases: string[];
  try {
    const parsed = JSON.parse(approvedDatabasesLabel ?? '') as unknown;
    if (!Array.isArray(parsed) || !parsed.every((database) => typeof database === 'string')) throw new Error();
    approvedDatabases = parsed;
  } catch {
    throw new Error('Disposable database Docker approved-databases label is invalid.');
  }
  if (
    encodeDisposableDatabaseLabel(approvedDatabases) !== approvedDatabasesLabel ||
    !approvedDatabases.includes(proof.database)
  ) {
    throw new Error('Disposable database is not present in the exact Docker approved-databases label.');
  }

  const bindings = inspection.NetworkSettings?.Ports?.['5432/tcp'];
  if (
    !Array.isArray(bindings) ||
    bindings.length !== 1 ||
    bindings[0]?.HostIp !== '127.0.0.1' ||
    bindings[0]?.HostPort !== target.port
  ) {
    throw new Error('Disposable database URL does not match the container exact 127.0.0.1 port binding.');
  }

  const database = await runtime.probeDatabase(targetUrl);
  if (database.database !== target.database || database.role !== target.role) {
    throw new Error('Connected database or role does not match the exact disposable target URL.');
  }
  if (database.marker !== disposableDatabaseMarker(proof)) {
    throw new Error('Connected database is missing the exact LeagueVault disposable ownership marker.');
  }

  return {
    targetUrl,
    database: target.database,
    role: target.role,
    containerId: proof.containerId,
    runId: proof.runId,
    purpose: proof.purpose,
  };
}

export const __testing = {
  PROOF_ENVIRONMENT_KEYS,
  parseTargetUrl,
};
