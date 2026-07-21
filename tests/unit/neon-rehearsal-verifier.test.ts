import { describe, expect, it, vi } from 'vitest';
import {
  redactNeonControlPlaneDetails,
  verifyNeonProductionTarget,
  verifyNeonRehearsalTarget,
  type NeonProductionExpectation,
  type NeonRehearsalExpectation,
} from '../../scripts/lib/neon-rehearsal-verifier';

const productionExpectation: NeonProductionExpectation = {
  apiKey: 'neon-production-secret-api-key',
  projectId: 'project-production',
  targetBranchId: 'br-production',
  productionBranchId: 'br-production',
  endpointId: 'ep-production',
};
const productionHostname = 'ep-production.us-east-2.aws.neon.tech';

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
    annotation: {
      object: { type: '', id: '' },
      value: {},
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
    fetch: fetchImplementation,
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

  it('normalizes casing and one terminal DNS dot while retaining exact hostname equality', async () => {
    await expect(verify(provider({
      endpoint: endpoint({ host: `${hostname.toUpperCase()}.` }),
    }), expectation, `${hostname}.`)).resolves.toMatchObject({ endpointHostname: hostname });

    await expect(verify(provider({
      endpoint: endpoint({ host: `other.${hostname}` }),
    }))).rejects.toThrow('compute endpoint');
    await expect(verify(provider({
      endpoint: endpoint({ host: `*.${hostname}` }),
    }))).rejects.toThrow('hostname metadata');
    await expect(verify(provider({
      endpoint: endpoint({ host: `${hostname}:5432` }),
    }))).rejects.toThrow('hostname metadata');
    await expect(verify(provider({
      endpoint: endpoint({ host: `${hostname}..` }),
    }))).rejects.toThrow('hostname metadata');
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

  it('requires the documented branch annotation envelope without accepting unknown top-level fields', async () => {
    const exact = branch(expectation.productionBranchId);
    const { annotation: _annotation, ...branchOnly } = exact;
    await expect(verify(provider({ production: branchOnly }))).rejects.toThrow('invalid or unexpected');
    await expect(verify(provider({ production: { ...exact, extra: {} } })))
      .rejects.toThrow('invalid or unexpected');
  });

  it('accepts populated annotation metadata without using it as branch identity', async () => {
    const exact = branch(expectation.productionBranchId);
    await expect(verify(provider({
      production: {
        ...exact,
        annotation: {
          object: { type: 'branch', id: expectation.productionBranchId },
          value: { source: 'operator' },
          created_at: '2026-07-21T00:00:00Z',
          updated_at: '2026-07-21T00:00:00Z',
        },
      },
    }))).resolves.toMatchObject({ productionBranchId: expectation.productionBranchId });
  });

  it('refuses malformed branch annotation metadata', async () => {
    const exact = branch(expectation.productionBranchId);
    await expect(verify(provider({
      production: { ...exact, annotation: { object: { type: 1 }, value: {} } },
    }))).rejects.toThrow('invalid or incomplete');
    await expect(verify(provider({
      production: { ...exact, annotation: { object: { type: 'branch', id: 'branch' }, value: { invalid: 1 } } },
    }))).rejects.toThrow('invalid or incomplete');
  });

  it('does not retry authentication, malformed-response, or identity failures', async () => {
    const authenticationFailure = vi.fn(async () => response({}, 401));
    await expect(verifyNeonRehearsalTarget(expectation, hostname, {
      fetch: authenticationFailure,
      timeoutMs: 100,
      attempts: 2,
    })).rejects.toThrow('authentication');
    expect(authenticationFailure).toHaveBeenCalledTimes(1);

    const malformedResponse = vi.fn(async () => response('{bad json'));
    await expect(verifyNeonRehearsalTarget(expectation, hostname, {
      fetch: malformedResponse,
      timeoutMs: 100,
      attempts: 2,
    })).rejects.toThrow('not valid JSON');
    expect(malformedResponse).toHaveBeenCalledTimes(1);

    const identityFailure = provider({ project: { project: { id: 'project-other' } } });
    await expect(verifyNeonRehearsalTarget(expectation, hostname, {
      fetch: identityFailure,
      timeoutMs: 100,
      attempts: 2,
    })).rejects.toThrow('project identity');
    expect(identityFailure).toHaveBeenCalledTimes(1);
  });

  it('refuses a bounded timeout and retries only the safe GET request', async () => {
    const timedOut = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('request URL with secrets')));
    }));
    await expect(verifyNeonRehearsalTarget(expectation, hostname, {
      fetch: timedOut,
      timeoutMs: 100,
      attempts: 2,
    })).rejects.toThrow('timed out or failed');
    expect(timedOut).toHaveBeenCalledTimes(2);
    expect(timedOut.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });

  it('hard-caps provider GET attempts at two', async () => {
    await expect(verifyNeonRehearsalTarget(expectation, hostname, {
      fetch: provider(),
      timeoutMs: 100,
      attempts: 3,
    })).rejects.toThrow('runtime bounds');
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

function productionProvider(overrides: {
  project?: unknown;
  production?: unknown;
  endpoint?: unknown;
} = {}) {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith(`/projects/${productionExpectation.projectId}`)) {
      return response(overrides.project ?? { project: { id: productionExpectation.projectId } });
    }
    if (url.endsWith(`/branches/${productionExpectation.productionBranchId}`)) {
      return response(overrides.production ?? {
        branch: {
          id: productionExpectation.productionBranchId,
          project_id: productionExpectation.projectId,
          current_state: 'ready',
          default: true,
          protected: true,
          primary: true,
          parent_id: null,
          restricted_actions: null,
          recovery: null,
          restored_from: null,
          restored_as: null,
        },
        annotation: { object: { type: '', id: '' }, value: {} },
      });
    }
    if (url.endsWith(`/endpoints/${productionExpectation.endpointId}`)) {
      return response(overrides.endpoint ?? {
        endpoint: {
          id: productionExpectation.endpointId,
          project_id: productionExpectation.projectId,
          branch_id: productionExpectation.productionBranchId,
          host: productionHostname,
          type: 'read_write',
          current_state: 'active',
          disabled: false,
        },
      });
    }
    return response({}, 404);
  });
}

async function verifyProduction(
  fetchImplementation = productionProvider(),
  expected = productionExpectation,
  host = productionHostname,
) {
  return verifyNeonProductionTarget(expected, host, {
    fetch: fetchImplementation,
    timeoutMs: 100,
    attempts: 1,
  });
}

describe('Neon production control-plane verifier', () => {
  it('accepts only the exact protected default production root and its endpoint using GET only', async () => {
    const fetchImplementation = productionProvider();
    await expect(verifyProduction(fetchImplementation)).resolves.toEqual({
      projectId: productionExpectation.projectId,
      productionBranchId: productionExpectation.productionBranchId,
      endpointId: productionExpectation.endpointId,
      endpointHostname: productionHostname,
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchImplementation.mock.calls) {
      expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
    }
  });

  it.each([
    ['different target branch', { targetBranchId: 'br-child' }, {}, 'must exactly equal'],
    ['unprotected branch', {}, { production: {
      branch: {
        id: productionExpectation.productionBranchId,
        project_id: productionExpectation.projectId,
        current_state: 'ready',
        default: true,
        protected: false,
      },
      annotation: { object: { type: '', id: '' }, value: {} },
    } }, 'protected default root'],
    ['non-default branch', {}, { production: {
      branch: {
        id: productionExpectation.productionBranchId,
        project_id: productionExpectation.projectId,
        current_state: 'ready',
        default: false,
        protected: true,
      },
      annotation: { object: { type: '', id: '' }, value: {} },
    } }, 'protected default root'],
    ['child branch', {}, { production: {
      branch: {
        id: productionExpectation.productionBranchId,
        project_id: productionExpectation.projectId,
        parent_id: 'br-parent',
        current_state: 'ready',
        default: true,
        protected: true,
      },
      annotation: { object: { type: '', id: '' }, value: {} },
    } }, 'protected default root'],
  ])('refuses %s', async (_label, expectationOverrides, providerOverrides, message) => {
    await expect(verifyProduction(
      productionProvider(providerOverrides),
      { ...productionExpectation, ...expectationOverrides },
    )).rejects.toThrow(message);
  });

  it('refuses an endpoint on any other branch or hostname', async () => {
    await expect(verifyProduction(productionProvider({
      endpoint: {
        endpoint: {
          id: productionExpectation.endpointId,
          project_id: productionExpectation.projectId,
          branch_id: 'br-child',
          host: productionHostname,
          type: 'read_write',
          current_state: 'active',
          disabled: false,
        },
      },
    }))).rejects.toThrow('production target');
    await expect(verifyProduction(productionProvider(), productionExpectation, 'ep-other.neon.tech'))
      .rejects.toThrow('production target');
  });
});
