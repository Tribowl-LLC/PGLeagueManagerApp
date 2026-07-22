import { beforeEach, describe, expect, it, vi } from 'vitest';

const storageMocks = vi.hoisted(() => ({
  getOrganizationBySubdomain: vi.fn(),
  getOrganizationBySlug: vi.fn(),
}));

vi.mock('../../server/storage', () => ({
  storage: storageMocks,
}));

vi.mock('../../server/config', () => ({
  env: { APP_DOMAIN: 'leaguevault.app' },
}));

import { lookupOrganizationByHostname } from '../../server/middleware/subdomain';

const firstOrganization = { id: 101, slug: 'first' };
const reassignedOrganization = { id: 202, slug: 'reassigned' };

describe('tenant hostname resolution consistency', () => {
  beforeEach(() => {
    storageMocks.getOrganizationBySubdomain.mockReset();
    storageMocks.getOrganizationBySlug.mockReset();
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
});
