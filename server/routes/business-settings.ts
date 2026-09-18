import { Router } from 'express';
import { z } from 'zod';
import { updateOrganizationSchema } from '@shared/schema';
import { requireSystemAdmin } from '../middleware/auth';
import { adminWriteLimiter } from '../middleware/rate-limit';
import { storage } from '../storage';
import { sendError, sendSuccess, handleZodError, sanitizeOrg } from '../utils/api';
import { validateDataUri } from '../utils/image-magic-bytes';
import { configuredOrganizationId } from '../services/single-tenant-context';

const router = Router();

// Business Settings deliberately omits slug, subdomain, active, and other
// tenant-lifecycle fields. The organization row remains the durable business
// identity, but Owners cannot turn the singleton into a tenant selector.
const businessSettingsSchema = updateOrganizationSchema.pick({
  name: true,
  address: true,
  city: true,
  state: true,
  zipCode: true,
  phone: true,
  email: true,
  logo: true,
  darkLogo: true,
  appIcon: true,
});

router.get('/', requireSystemAdmin, async (req, res) => {
  const organizationId = req.organizationContextId ?? configuredOrganizationId();
  if (organizationId === undefined) {
    return sendError(res, 'Business context is not configured', 503, 'SINGLE_TENANT_CONTEXT_UNAVAILABLE');
  }
  const organization = await storage.getOrganization(organizationId);
  if (!organization || !organization.active) {
    return sendError(res, 'Business context is unavailable', 503, 'SINGLE_TENANT_CONTEXT_UNAVAILABLE');
  }
  return sendSuccess(res, sanitizeOrg(organization));
});

router.patch('/', requireSystemAdmin, adminWriteLimiter, async (req, res) => {
  const organizationId = req.organizationContextId ?? configuredOrganizationId();
  if (organizationId === undefined) {
    return sendError(res, 'Business context is not configured', 503, 'SINGLE_TENANT_CONTEXT_UNAVAILABLE');
  }

  try {
    const organization = await storage.getOrganization(organizationId);
    if (!organization || !organization.active) {
      return sendError(res, 'Business context is unavailable', 503, 'SINGLE_TENANT_CONTEXT_UNAVAILABLE');
    }

    const validatedData = businessSettingsSchema.parse(req.body);
    for (const field of ['logo', 'darkLogo', 'appIcon'] as const) {
      const value = validatedData[field];
      if (value?.startsWith('data:')) {
        const result = validateDataUri(value);
        if (!result.valid) return sendError(res, `${field}: ${result.error}`, 400, 'INVALID_FORMAT');
      }
    }

    const updated = await storage.updateOrganization(organizationId, validatedData);
    return sendSuccess(res, sanitizeOrg(updated));
  } catch (error) {
    if (error instanceof z.ZodError) return handleZodError(res, error);
    return sendError(res, 'Failed to update business settings', 500, 'SERVER_ERROR');
  }
});

export default router;
