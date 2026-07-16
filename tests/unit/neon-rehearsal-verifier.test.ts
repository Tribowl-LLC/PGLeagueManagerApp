import { describe, expect, it, vi } from 'vitest';
import {
  redactNeonControlPlaneDetails,
  verifyNeonRehearsalTarget,
  type NeonRehearsalExpectation,
} from '../../scripts/lib/neon-rehearsal-verifier';

const expectation: NeonRehearsalExpectation = {
  apiKey: 'neon-secret-api-key',
  projectId: 'project-rehearsal',
  targetBranchId: 'br-disposable-rehearsal',
  productionBranchId: 'br-production-source',
  endpointId: 'ep-disposable-rehearsal',
};
const hostname = 'ep-disposable-rehearsal.us-east-2.aws.neon.tech';

function branch(id: string, overrides: Record<string, unknown> = {}) {
  return {
    branch: {
      id,
      project_id: expectation.projectId,
      parent_id: expectation.productionBranchId,
      current_state: 'ready',
      init_source: 'parent-data',
      default: false,
      protected: false,
      ...overrides,
    },
  };
}

function endpoint(overrides: Record<string, unknown> = {}) {
  return {
    endpoint: {
      id: expectation.endpointId,
      project_id: expectation.projectId,
      branch_id: expectation.targetBranchId,
      host: hostname,
      type: 'read_write',
      current_state: 'idle',
      disabled: false,
      ...overrides,
    },
  };
}

function response(body: unknown, status = 200, contentType = 'application/json'): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': contentType },
  });
}

function provider(overrides: {
  project?: unknown;
  production?: unknown;
  target?: unknown;
  endpoint?: unknown;
} = {}) {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith(`/projects/${expectation.projectId}`)) {
      return response(overrides.project ?? { project: { id: expectation.projectId } });
    }
    if (url.endsWith(`/branches/${expectation.productionBranchId}`)) {
      return response(overrides.production ?? branch(expectation.productionBranchId));
    }
    if (url.endsWith(`/branches/${expectation.targetBranchId}`)) {
      return response(overrides.target ?? branch(expectation.targetBranchId));
    }
    if (url.endsWith(`/endpoints/${expectation.endpointId}`)) {
      return response(overrides.endpoint ?? endpoint());
    }
    return response({}, 404);
  });
}

async function verify(fetchImplementation = provider(), expected = expectation, host = hostname) {
  return verifyNeonRehearsalTarget(expected, host, {
    fetch: fetchImplementation as typeof fetch,
    timeoutMs: 100,
    attempts: 1,
  });
}

describe('Neon rehearsal control-plane verifier', () => {
  it('accepts the exact project, parent/source branch, and endpoint hierarchy using GET only', async () => {
    const fetchImplementation = provider();
    await expect(verify(fetchImplementation)).resolves.toEqual({
      projectId: expectation.projectId,
      targetBranchId: expectation.targetBranchId,
      productionBranchId: expectation.productionBranchId,
      endpointId: expectation.endpointId,
      endpointHostname: hostname,
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(4);
    for (const [, init] of fetchImplementation.mock.calls) {
      expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
      expect(JSON.stringify(init)).not.toContain('postgresql://');
    }
  });

  it.each([
    ['wrong project', { project: { project: { id: 'project-other' } } }, 'project identity'],
    ['wrong production branch', { production: branch('br-other') }, 'branch identity'],
    ['wrong target branch', { target: branch('br-other') }, 'branch identity'],
    ['wrong parent/source branch', { target: branch(expectation.targetBranchId, { parent_id: 'br-other' }) }, 'source parent'],
    ['missing parent metadata', { target: branch(expectation.targetBranchId, { parent_id: undefined }) }, 'invalid or incomplete'],
    ['wrong endpoint', { endpoint: endpoint({ id: 'ep-other' }) }, 'compute endpoint'],
    ['endpoint belongs to production', { endpoint: endpoint({ branch_id: expectation.productionBranchId }) }, 'compute endpoint'],
    ['target is default', { target: branch(expectation.targetBranchId, { default: true }) }, 'disposable rehearsal'],
    ['target is primary', { target: branch(expectation.targetBranchId, { primary: true }) }, 'disposable rehearsal'],
    ['target is protected', { target: branch(expectation.targetBranchId, { protected: true }) }, 'disposable rehearsal'],
    ['target is schema-only', { target: branch(expectation.targetBranchId, { init_source: 'schema-only' }) }, 'disposable rehearsal'],
    ['target is not ready', { target: branch(expectation.targetBranchId, { current_state: 'resetting' }) }, 'disposable rehearsal'],
    ['endpoint is disabled', { endpoint: endpoint({ disabled: true }) }, 'compute endpoint'],
  ])('refuses %s', async (_name, overrides, message) => {
    await expect(verify(provider(overrides))).rejects.toThrow(message);
  });

  it('refuses a missing project without exposing provider response data', async () => {
    const missing = vi.fn(async () => response({ message: 'raw provider response', code: 'NOT_FOUND' }, 404));
    await expect(verify(missing)).rejects.toThrow('request failed');
    await expect(verify(missing)).rejects.not.toThrow('raw provider response');
  });

  it('refuses hostname mismatch', async () => {
    await expect(verify(provider(), expectation, 'production.example.neon.tech')).rejects.toThrow('compute endpoint');
  });

  it('refuses missing API proof and target-equals-production masquerading', async () => {
    await expect(verify(provider(), { ...expectation, apiKey: '' })).rejects.toThrow('NEON_API_KEY');
    await expect(verify(provider(), {
      ...expectation,
      targetBranchId: expectation.productionBranchId,
    })).rejects.toThrow('must differ');
  });

  it('refuses authentication failures, malformed JSON, incomplete and unexpected schemas', async () => {
    await expect(verify(vi.fn(async () => response({}, 401)))).rejects.toThrow('authentication');
    await expect(verify(vi.fn(async () => response('{bad json')))).rejects.toThrow('not valid JSON');
    await expect(verify(provider({ project: { project: {} } }))).rejects.toThrow('invalid or incomplete');
    await expect(verify(provider({ project: { project: { id: expectation.projectId }, extra: {} } })))
      .rejects.toThrow('invalid or unexpected');
  });

  it('refuses a bounded timeout and retries only the safe GET request', async () => {
    const timedOut = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('request URL with secrets')));
    }));
    await expect(verifyNeonRehearsalTarget(expectation, hostname, {
      fetch: timedOut as typeof fetch,
      timeoutMs: 100,
      attempts: 2,
    })).rejects.toThrow('timed out or failed');
    expect(timedOut).toHaveBeenCalledTimes(2);
    expect(timedOut.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });

  it('redacts every secret provider identifier without logging raw hostnames or responses', () => {
    const raw = `${expectation.apiKey} ${expectation.projectId} ${expectation.targetBranchId} ` +
      `${expectation.productionBranchId} ${expectation.endpointId}`;
    const redacted = redactNeonControlPlaneDetails(raw, expectation);
    expect(redacted).not.toContain(expectation.apiKey);
    expect(redacted).not.toContain(expectation.projectId);
    expect(redacted).not.toContain(expectation.targetBranchId);
    expect(redacted).not.toContain(expectation.productionBranchId);
    expect(redacted).not.toContain(expectation.endpointId);
  });
});
