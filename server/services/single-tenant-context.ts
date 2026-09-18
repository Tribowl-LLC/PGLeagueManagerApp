import { storage } from '../storage';
import type { Organization } from '@shared/schema';
import { env, isSingletonOrganizationMode } from '../config';

export const SINGLE_TENANT_CONTEXT_UNAVAILABLE_CODE = 'SINGLE_TENANT_CONTEXT_UNAVAILABLE';

export class SingleTenantContextError extends Error {
  readonly code = SINGLE_TENANT_CONTEXT_UNAVAILABLE_CODE;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SingleTenantContextError';
  }
}

/**
 * Resolve the configured organization without accepting a browser- or
 * hostname-selected identifier. The active-organization check deliberately
 * limits the query to two rows so a bad deployment cannot enumerate the
 * entire organizations table on every request.
 */
export async function resolveConfiguredOrganization(): Promise<Organization> {
  if (!isSingletonOrganizationMode || env.APP_ORGANIZATION_ID === undefined) {
    throw new SingleTenantContextError('APP_ORGANIZATION_ID is not configured');
  }

  try {
    const organization = await storage.getOrganization(env.APP_ORGANIZATION_ID);
    if (!organization || !organization.active) {
      throw new SingleTenantContextError('Configured organization does not exist or is inactive');
    }

    const activeOrganizations = await storage.getActiveOrganizations();
    if (activeOrganizations.length !== 1 || activeOrganizations[0]?.id !== organization.id) {
      throw new SingleTenantContextError('Configured organization is not the only active organization');
    }

    return organization;
  } catch (error) {
    if (error instanceof SingleTenantContextError) throw error;
    throw new SingleTenantContextError('Configured organization context is unavailable', { cause: error });
  }
}

export function configuredOrganizationId(): number | undefined {
  return env.APP_ORGANIZATION_ID;
}
