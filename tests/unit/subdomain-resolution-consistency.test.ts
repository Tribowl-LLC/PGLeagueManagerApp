import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const { storageMocks, loggerMock } = vi.hoisted(() => ({
  storageMocks: {
    getOrganizationBySubdomain: vi.fn(),
    getOrganizationBySlug: vi.fn(),
  },
  loggerMock: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    captureException: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../server/storage', () => ({
  storage: storageMocks,
}));

vi.mock('../../server/config', () => ({
  env: { APP_DOMAIN: 'leaguevault.app' },
}));

vi.mock('../../server/logger', () => ({
  logger: loggerMock,
  createLogger: () => loggerMock,
}));

import {
  lookupOrganizationByHostname,
  subdomainDetection,
  TENANT_LOOKUP_UNAVAILABLE_CODE,
} from '../../server/middleware/subdomain';

const firstOrganization = { id: 101, slug: 'first' };
const reassignedOrganization = { id: 202, slug: 'reassigned' };

describe('tenant hostname resolution consistency', () => {
  beforeEach(() => {
    storageMocks.getOrganizationBySubdomain.mockReset();
    storageMocks.getOrganizationBySlug.mockReset();
    for (const fn of Object.values(loggerMock)) fn.mockReset();
  });

  it('does not retain a positive result after the hostname is reassigned', async () => {
    storageMocks.getOrganizationBySubdomain
      .mockResolvedValueOnce(firstOrganization)
      .mockResolvedValueOnce(reassignedOrganization);

    await expect(lookupOrganizationByHostname('shared-host')).resolves.toBe(firstOrganization);
    await expect(lookupOrganizationByHostname('shared-host')).resolves.toBe(reassignedOrganization);
    expect(storageMocks.getOrganizationBySubdomain).toHaveBeenCalledTimes(2);
  });

  it('does not retain a miss after a hostname becomes available', async () => {
    storageMocks.getOrganizationBySubdomain.mockResolvedValue(null);
    storageMocks.getOrganizationBySlug
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(reassignedOrganization);

    await expect(lookupOrganizationByHostname('new-host')).resolves.toBeNull();
    await expect(lookupOrganizationByHostname('new-host')).resolves.toBe(reassignedOrganization);
    expect(storageMocks.getOrganizationBySlug).toHaveBeenCalledTimes(2);
  });

  it('returns a temporary 503 when hostname resolution cannot acquire the database', async () => {
    const databaseError = Object.assign(
      new Error('Failed query: SELECT secret FROM organizations /* acme.leaguevault.app */'),
      { code: 'ECONNRESET' },
    );
    storageMocks.getOrganizationBySubdomain.mockRejectedValue(databaseError);

    const response = {
      headersSent: false,
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    const next = vi.fn();
    const request = {
      hostname: 'acme.leaguevault.app',
      headers: {},
      query: {},
      subdomainOrg: undefined,
      orgSlug: undefined,
    };

    subdomainDetection(request, response, next);
    await vi.waitFor(() => expect(response.json).toHaveBeenCalledTimes(1));

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: TENANT_LOOKUP_UNAVAILABLE_CODE,
        message: 'Tenant context is temporarily unavailable. Please retry shortly.',
      },
    });
    expect(next).not.toHaveBeenCalled();
    expect(request.subdomainOrg).toBeUndefined();
    expect(loggerMock.captureException).toHaveBeenCalledOnce();
    expect(loggerMock.captureException).toHaveBeenCalledWith(databaseError);
    expect(loggerMock.error).toHaveBeenCalledOnce();
    expect(loggerMock.error).toHaveBeenCalledWith('Tenant hostname lookup failed', {
      operation: 'organization_hostname_lookup',
      errorType: 'Error',
      errorCode: 'ECONNRESET',
    });
    expect(JSON.stringify(loggerMock.error.mock.calls[0])).not.toContain('acme.leaguevault.app');
    expect(JSON.stringify(loggerMock.error.mock.calls[0])).not.toContain('SELECT secret');
  });
});
