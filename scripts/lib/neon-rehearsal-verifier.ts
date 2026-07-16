const NEON_API_BASE_URL = 'https://console.neon.tech/api/v2';
const NEON_REQUEST_TIMEOUT_MS = 5_000;
const NEON_REQUEST_ATTEMPTS = 2;
const MAX_RESPONSE_BYTES = 256 * 1024;
const PROVIDER_ID = /^[a-z0-9-]{1,60}$/;

export interface NeonRehearsalExpectation {
  apiKey: string;
  projectId: string;
  targetBranchId: string;
  productionBranchId: string;
  endpointId: string;
}

export type NeonRehearsalIdentityExpectation = Omit<NeonRehearsalExpectation, 'apiKey'>;

export interface VerifiedNeonRehearsal {
  projectId: string;
  targetBranchId: string;
  productionBranchId: string;
  endpointId: string;
  endpointHostname: string;
}

export interface NeonVerifierRuntime {
  fetch?: typeof fetch;
  timeoutMs?: number;
  attempts?: number;
}

type JsonObject = Record<string, unknown>;

function plainObject(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Neon control-plane response schema is invalid or incomplete.');
  }
  return value as JsonObject;
}

function exactEnvelope(value: unknown, key: 'project' | 'branch' | 'endpoint'): JsonObject {
  const envelope = plainObject(value);
  if (Object.keys(envelope).length !== 1 || !(key in envelope)) {
    throw new Error('Neon control-plane response schema is invalid or unexpected.');
  }
  return plainObject(envelope[key]);
}

function requiredString(object: JsonObject, key: string): string {
  const value = object[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Neon control-plane response schema is invalid or incomplete.');
  }
  return value;
}

function requiredBoolean(object: JsonObject, key: string): boolean {
  const value = object[key];
  if (typeof value !== 'boolean') {
    throw new Error('Neon control-plane response schema is invalid or incomplete.');
  }
  return value;
}

function validateExpectation(expectation: NeonRehearsalExpectation): void {
  if (!expectation.apiKey.trim()) throw new Error('NEON_API_KEY is required for Neon rehearsal verification.');
  const identifiers = [
    expectation.projectId,
    expectation.targetBranchId,
    expectation.productionBranchId,
    expectation.endpointId,
  ];
  if (identifiers.some((identifier) => !PROVIDER_ID.test(identifier))) {
    throw new Error('Neon rehearsal provider identifiers are missing or invalid.');
  }
  if (
    !expectation.targetBranchId.startsWith('br-') ||
    !expectation.productionBranchId.startsWith('br-') ||
    !expectation.endpointId.startsWith('ep-')
  ) {
    throw new Error('Neon rehearsal branch or endpoint identifiers have invalid provider prefixes.');
  }
  if (expectation.targetBranchId === expectation.productionBranchId) {
    throw new Error('Neon rehearsal target must differ from the production source branch.');
  }
}

function shouldRetry(status: number): boolean {
  return status === 408 || status === 423 || status === 429 || status >= 500;
}

async function providerGet(
  path: string,
  apiKey: string,
  runtime: NeonVerifierRuntime,
): Promise<unknown> {
  const fetchImplementation = runtime.fetch ?? fetch;
  const attempts = runtime.attempts ?? NEON_REQUEST_ATTEMPTS;
  const timeoutMs = runtime.timeoutMs ?? NEON_REQUEST_TIMEOUT_MS;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 2 || timeoutMs < 100 || timeoutMs > 15_000) {
    throw new Error('Neon control-plane verifier runtime bounds are invalid.');
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImplementation(`${NEON_API_BASE_URL}${path}`, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        if (attempt < attempts && shouldRetry(response.status)) continue;
        throw new Error(
          response.status === 401 || response.status === 403
            ? 'Neon control-plane authentication or authorization failed.'
            : 'Neon control-plane request failed; rehearsal adoption is refused.',
        );
      }
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (!contentType.startsWith('application/json')) {
        throw new Error('Neon control-plane response schema is invalid or unexpected.');
      }
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        throw new Error('Neon control-plane response schema is invalid or unexpected.');
      }
      const body = await response.text();
      if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
        throw new Error('Neon control-plane response schema is invalid or unexpected.');
      }
      try {
        return JSON.parse(body) as unknown;
      } catch {
        throw new Error('Neon control-plane response is not valid JSON.');
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Neon control-plane')) throw error;
      if (attempt < attempts) continue;
      throw new Error('Neon control-plane request timed out or failed; rehearsal adoption is refused.');
    }
  }
  throw new Error('Neon control-plane verification failed; rehearsal adoption is refused.');
}

function normalizeExactHostname(hostname: string): string {
  const lowered = hostname.toLowerCase();
  const normalized = lowered.endsWith('.') ? lowered.slice(0, -1) : lowered;
  if (
    normalized.length === 0 ||
    normalized.endsWith('.') ||
    normalized.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(normalized)
  ) {
    throw new Error('Neon control-plane hostname metadata is invalid or unexpected.');
  }
  return normalized;
}

function validateBranchIdentity(
  branch: JsonObject,
  expectedProjectId: string,
  expectedBranchId: string,
): void {
  if (
    requiredString(branch, 'id') !== expectedBranchId ||
    requiredString(branch, 'project_id') !== expectedProjectId
  ) {
    throw new Error('Neon control-plane branch identity does not match the independent expectation.');
  }
}

export async function verifyNeonRehearsalTarget(
  expectation: NeonRehearsalExpectation,
  connectionHostname: string,
  runtime: NeonVerifierRuntime = {},
): Promise<VerifiedNeonRehearsal> {
  validateExpectation(expectation);
  if (!connectionHostname || connectionHostname.includes('%')) {
    throw new Error('PostgreSQL connection hostname is invalid for Neon rehearsal verification.');
  }
  const normalizedConnectionHostname = normalizeExactHostname(connectionHostname);
  const projectPath = `/projects/${encodeURIComponent(expectation.projectId)}`;
  const project = exactEnvelope(
    await providerGet(projectPath, expectation.apiKey, runtime),
    'project',
  );
  if (requiredString(project, 'id') !== expectation.projectId) {
    throw new Error('Neon control-plane project identity does not match the independent expectation.');
  }

  const production = exactEnvelope(await providerGet(
    `${projectPath}/branches/${encodeURIComponent(expectation.productionBranchId)}`,
    expectation.apiKey,
    runtime,
  ), 'branch');
  validateBranchIdentity(production, expectation.projectId, expectation.productionBranchId);

  const target = exactEnvelope(await providerGet(
    `${projectPath}/branches/${encodeURIComponent(expectation.targetBranchId)}`,
    expectation.apiKey,
    runtime,
  ), 'branch');
  validateBranchIdentity(target, expectation.projectId, expectation.targetBranchId);
  const parentId = requiredString(target, 'parent_id');
  const isDefault = requiredBoolean(target, 'default');
  const isProtected = requiredBoolean(target, 'protected');
  const primary = target.primary;
  if (primary !== undefined && typeof primary !== 'boolean') {
    throw new Error('Neon control-plane response schema is invalid or incomplete.');
  }
  if (parentId !== expectation.productionBranchId) {
    throw new Error('Neon rehearsal target does not have the expected production source parent.');
  }
  if (
    isDefault || isProtected || primary === true ||
    requiredString(target, 'current_state') !== 'ready' ||
    requiredString(target, 'init_source') !== 'parent-data' ||
    target.recovery !== undefined || target.restored_from !== undefined || target.restored_as !== undefined ||
    (Array.isArray(target.restricted_actions) && target.restricted_actions.length > 0)
  ) {
    throw new Error('Neon target is not an unprotected, non-primary disposable rehearsal branch.');
  }
  if (target.restricted_actions !== undefined && !Array.isArray(target.restricted_actions)) {
    throw new Error('Neon control-plane response schema is invalid or incomplete.');
  }

  const endpoint = exactEnvelope(await providerGet(
    `${projectPath}/endpoints/${encodeURIComponent(expectation.endpointId)}`,
    expectation.apiKey,
    runtime,
  ), 'endpoint');
  const endpointHostname = normalizeExactHostname(requiredString(endpoint, 'host'));
  const endpointState = requiredString(endpoint, 'current_state');
  if (
    requiredString(endpoint, 'id') !== expectation.endpointId ||
    requiredString(endpoint, 'project_id') !== expectation.projectId ||
    requiredString(endpoint, 'branch_id') !== expectation.targetBranchId ||
    requiredString(endpoint, 'type') !== 'read_write' ||
    requiredBoolean(endpoint, 'disabled') ||
    (endpointState !== 'active' && endpointState !== 'idle') ||
    endpointHostname !== normalizedConnectionHostname
  ) {
    throw new Error('Neon compute endpoint does not match the verified rehearsal target and PostgreSQL host.');
  }
  if (requiredString(endpoint, 'branch_id') === expectation.productionBranchId) {
    throw new Error('Neon production compute endpoint cannot be used for rehearsal adoption.');
  }

  return {
    projectId: expectation.projectId,
    targetBranchId: expectation.targetBranchId,
    productionBranchId: expectation.productionBranchId,
    endpointId: expectation.endpointId,
    endpointHostname,
  };
}

export function redactNeonControlPlaneDetails(
  message: string,
  expectation?: Partial<NeonRehearsalExpectation>,
): string {
  let redacted = message;
  for (const value of [
    expectation?.apiKey,
    expectation?.projectId,
    expectation?.targetBranchId,
    expectation?.productionBranchId,
    expectation?.endpointId,
  ]) {
    if (value) redacted = redacted.replaceAll(value, '[Neon value redacted]');
  }
  return redacted;
}
