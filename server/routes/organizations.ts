import { Router } from 'express';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { eq } from 'drizzle-orm';
import { sendSuccess, sendError, sanitizeUser, sanitizeOrg, sanitizeOrgs, handleZodError, handleUserOrgError } from '../utils/api.js';
import { singleRouteParam } from '../utils/route-params';
import { validateDataUri } from '../utils/image-magic-bytes.js';
import { storage } from '../storage';
import { 
  insertOrganizationSchema, 
  updateOrganizationSchema, 
  users,
  type Organization
} from '@shared/schema';
import { requireAdmin } from '../middleware/admin.js';
import { hashPassword } from '../auth.js';
import { requireOrganizationAccess } from '../utils/access-control.js';
import { sendTemplatedEmail, getBaseUrl, getOrgLogoUrl } from '../services/email.js';
import { adminWriteLimiter, inviteLimiter } from '../middleware/rate-limit.js';
import { createLogger } from '../logger';
import { getPaymentProvider, ProviderNotConfiguredError } from '../services/payment-provider-factory';
import { hasWalletSupport } from '../services/payment-provider';
import { canonicalApplePayDomain } from '../services/apple-pay-domains';

const log = createLogger("Organizations");

async function autoRegisterApplePayDomain(org: Organization) {
  const domain = org.subdomain || org.slug;
  if (!domain) return;

  const fullDomain = canonicalApplePayDomain(org);
  try {
    const leagues = await storage.getLeagues(org.id);
    const locationIds = new Set<number>();
    for (const league of leagues) {
      if (league.locationId) locationIds.add(league.locationId);
    }

    if (locationIds.size === 0) {
      log.info(`No locations with Square credentials for org ${org.id}, skipping Apple Pay domain registration`);
      return;
    }

    for (const locationId of locationIds) {
      try {
        const provider = await getPaymentProvider(locationId);
        if (hasWalletSupport(provider)) {
          const result = await provider.registerApplePayDomain(fullDomain);
          if (result.success) {
            log.info(`Apple Pay domain registered for ${fullDomain} (location ${locationId})`);
          } else {
            log.warn(`Apple Pay domain registration failed for ${fullDomain} (location ${locationId}): ${result.message}`);
          }
        }
      } catch (e) {
        if (e instanceof ProviderNotConfiguredError) {
          log.warn(`Apple Pay domain registration skipped: provider not configured for location ${locationId}`);
        } else {
          throw e;
        }
      }
    }
  } catch (error) {
    log.error(`Apple Pay auto-registration error for ${fullDomain}:`, error);
  }
}

const router = Router();

// Get all organizations (admin only)
router.get('/', requireAdmin, async (req, res) => {
  try {
    const organizations = await storage.getOrganizations();
    sendSuccess(res, sanitizeOrgs(organizations));
  } catch (error) {
    log.error('Error fetching organizations:', error);
    sendError(res, 'Failed to fetch organizations', 500, 'ServerError');
  }
});

// Get an organization by ID (admin only)
router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(singleRouteParam(req.params.id), 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid organization ID', 400, 'InvalidRequest');
    }

    if (!requireOrganizationAccess(req, id, 'organization', id)) {
      return sendError(res, 'You do not have access to this organization', 403, 'Forbidden');
    }

    const organization = await storage.getOrganization(id);
    if (!organization) {
      return sendError(res, 'Organization not found', 404, 'NOT_FOUND');
    }

    sendSuccess(res, sanitizeOrg(organization));
  } catch (error) {
    log.error(`Error fetching organization with ID ${req.params.id}:`, error);
    sendError(res, 'Failed to fetch organization', 500, 'ServerError');
  }
});

// Check if a slug is available
router.get('/check-slug/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    
    // Validate slug format
    const slugRegex = /^[a-z0-9-]+$/;
    if (!slugRegex.test(slug)) {
      return sendError(res, 'Invalid slug format. Use only lowercase letters, numbers, and hyphens.', 400, 'INVALID_FORMAT');
    }
    
    const organization = await storage.getOrganizationBySlug(slug);
    
    // Return the availability status
    sendSuccess(res, { 
      slug,
      available: !organization,
      message: organization ? 'Slug is already in use' : 'Slug is available'
    });
  } catch (error) {
    log.error(`Error checking slug availability for ${req.params.slug}:`, error);
    sendError(res, 'Failed to check slug availability', 500, 'SERVER_ERROR');
  }
});


// Create a new organization (admin only)
router.post('/', requireAdmin, adminWriteLimiter, inviteLimiter, async (req, res) => {
  try {
    const { adminData, ...orgData } = req.body;
    log.debug('Create request body keys:', Object.keys(orgData));
    const validatedData = insertOrganizationSchema.parse(orgData);
    
    // Check if organization with slug already exists
    const existingOrg = await storage.getOrganizationBySlug(validatedData.slug);
    if (existingOrg) {
      return sendError(res, 'An organization with this slug already exists', 409, 'Conflict');
    }

    const organization = await storage.createOrganization(validatedData);

    if (organization.subdomain || organization.slug) {
      autoRegisterApplePayDomain(organization).catch(() => {});
    }

    if (adminData && adminData.email && adminData.name) {
      try {
        const existingUser = await storage.getUserByEmail(adminData.email);
        if (existingUser) {
          if (existingUser.role !== 'org_admin' && existingUser.role !== 'system_admin') {
            await storage.updateUserRole(existingUser.id, 'org_admin');
          }
          await storage.setUserOrganization(existingUser.id, organization.id);
          return sendSuccess(res, { organization: sanitizeOrg(organization), adminUser: sanitizeUser(existingUser) }, 201);
        }
        
        const placeholderPassword = await hashPassword(randomBytes(32).toString('hex'));
        const newAdminUser = await storage.createUser({
          email: adminData.email,
          name: adminData.name,
          password: placeholderPassword,
          phone: adminData.phone || null,
          role: 'org_admin',
          organizationId: organization.id
        });

        const inviteToken = randomBytes(32).toString('hex');
        const inviteTokenExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        await storage.setUserInviteToken(newAdminUser.id, inviteToken, inviteTokenExpiry);

        const firstName = adminData.name.split(' ')[0];
        const baseUrl = getBaseUrl(organization);
        const setupUrl = `${baseUrl}/set-password?token=${inviteToken}`;
        const variables: Record<string, string> = {
          admin_name: firstName,
          invite_link: setupUrl,
          organization_name: organization.name,
          organization_logo_url: getOrgLogoUrl(organization),
        };
        await sendTemplatedEmail('org_admin_invite', adminData.email, variables);
        
        return sendSuccess(res, { organization: sanitizeOrg(organization), adminUser: sanitizeUser(newAdminUser) }, 201);
      } catch (adminError) {
        log.error('Error creating admin user:', adminError);
        return sendSuccess(res, { 
          organization: sanitizeOrg(organization), 
          warning: 'Organization created but there was an error creating the admin user'
        }, 201);
      }
    }

    sendSuccess(res, sanitizeOrg(organization), 201);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return handleZodError(res, error);
    }
    if (handleUserOrgError(res, error)) return;
    log.error('Error creating organization:', error);
    sendError(res, 'Failed to create organization', 500, 'ServerError');
  }
});

// Update an organization (admin only)
router.patch('/:id', requireAdmin, adminWriteLimiter, async (req, res) => {
  try {
    const id = parseInt(singleRouteParam(req.params.id), 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid organization ID', 400, 'InvalidRequest');
    }

    const organization = await storage.getOrganization(id);
    if (!organization) {
      return sendError(res, 'Organization not found', 404, 'NOT_FOUND');
    }

    const validatedData = updateOrganizationSchema.parse(req.body);

    const imageFields = ['logo', 'darkLogo', 'appIcon'] as const;
    for (const field of imageFields) {
      const value = validatedData[field];
      if (value && value.startsWith('data:')) {
        const result = validateDataUri(value);
        if (!result.valid) {
          return sendError(res, `${field}: ${result.error}`, 400, 'INVALID_FORMAT');
        }
      }
    }
    
    // If slug is being updated, check if it's already in use
    if (validatedData.slug && validatedData.slug !== organization.slug) {
      const existingOrg = await storage.getOrganizationBySlug(validatedData.slug);
      if (existingOrg && existingOrg.id !== id) {
        return sendError(res, 'An organization with this slug already exists', 409, 'Conflict');
      }
    }

    const updatedOrganization = await storage.updateOrganization(id, validatedData);

    const subdomainChanged = validatedData.subdomain !== undefined && validatedData.subdomain !== organization.subdomain;
    const slugChanged = validatedData.slug !== undefined && validatedData.slug !== organization.slug;
    if (subdomainChanged || slugChanged) {
      autoRegisterApplePayDomain(updatedOrganization).catch(() => {});
    }

    sendSuccess(res, sanitizeOrg(updatedOrganization));
  } catch (error) {
    if (error instanceof z.ZodError) {
      return handleZodError(res, error);
    }
    log.error(`Error updating organization with ID ${req.params.id}:`, error);
    sendError(res, 'Failed to update organization', 500, 'ServerError');
  }
});

// Archive an organization (admin only)
router.patch('/:id/archive', requireAdmin, adminWriteLimiter, async (req, res) => {
  try {
    const id = parseInt(singleRouteParam(req.params.id), 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid organization ID', 400, 'InvalidRequest');
    }

    const organization = await storage.getOrganization(id);
    if (!organization) {
      return sendError(res, 'Organization not found', 404, 'NOT_FOUND');
    }

    const archived = await storage.archiveOrganization(id);
    sendSuccess(res, sanitizeOrg(archived));
  } catch (error) {
    log.error(`Error archiving organization with ID ${req.params.id}:`, error);
    sendError(res, 'Failed to archive organization', 500, 'ServerError');
  }
});

// Restore an archived organization (admin only)
router.patch('/:id/restore', requireAdmin, adminWriteLimiter, async (req, res) => {
  try {
    const id = parseInt(singleRouteParam(req.params.id), 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid organization ID', 400, 'InvalidRequest');
    }

    const organization = await storage.getOrganization(id);
    if (!organization) {
      return sendError(res, 'Organization not found', 404, 'NOT_FOUND');
    }

    const restored = await storage.restoreOrganization(id);
    sendSuccess(res, sanitizeOrg(restored));
  } catch (error) {
    log.error(`Error restoring organization with ID ${req.params.id}:`, error);
    sendError(res, 'Failed to restore organization', 500, 'ServerError');
  }
});

// Delete an organization permanently (admin only)
router.delete('/:id', requireAdmin, adminWriteLimiter, async (req, res) => {
  try {
    const id = parseInt(singleRouteParam(req.params.id), 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid organization ID', 400, 'InvalidRequest');
    }

    const organization = await storage.getOrganization(id);
    if (!organization) {
      return sendError(res, 'Organization not found', 404, 'NOT_FOUND');
    }

    await storage.deleteOrganization(id);
    sendSuccess(res, { message: 'Organization deleted successfully' });
  } catch (error) {
    if (handleUserOrgError(res, error)) return;
    log.error(`Error deleting organization with ID ${req.params.id}:`, error);
    sendError(res, 'Failed to delete organization', 500, 'ServerError');
  }
});

// Get current user's organizations
router.get('/user/me', async (req, res) => {
  try {
    if (!req.user || !req.user.id) {
      return sendError(res, 'Authentication required', 401, 'Unauthorized');
    }

    const organizations = await storage.getUserOrganizations(req.user.id);
    sendSuccess(res, sanitizeOrgs(organizations));
  } catch (error) {
    log.error('Error fetching user organizations:', error);
    sendError(res, 'Failed to fetch user organizations', 500, 'ServerError');
  }
});

// Set user's organization (admin only)
router.post('/user/:userId/set', requireAdmin, adminWriteLimiter, async (req, res) => {
  try {
    const userId = parseInt(singleRouteParam(req.params.userId), 10);
    if (isNaN(userId)) {
      return sendError(res, 'Invalid user ID', 400, 'InvalidRequest');
    }

    const schema = z.object({
      organizationId: z.number().nullable(),
    });

    const { organizationId } = schema.parse(req.body);

    // If organizationId is provided, verify it exists
    if (organizationId !== null) {
      const organization = await storage.getOrganization(organizationId);
      if (!organization) {
        return sendError(res, 'Organization not found', 404, 'NOT_FOUND');
      }
      
      // Get the current user to update organization admin status
      const currentUser = await storage.getUser(userId);
      if (!currentUser) {
        return sendError(res, 'User not found', 404, 'NOT_FOUND');
      }
    }
    
    
    const updatedUser = await storage.setUserOrganization(userId, organizationId);
    sendSuccess(res, sanitizeUser(updatedUser));
  } catch (error) {
    if (error instanceof z.ZodError) {
      return handleZodError(res, error);
    }
    if (handleUserOrgError(res, error)) return;
    log.error(`Error setting organization for user ${req.params.userId}:`, error);
    sendError(res, 'Failed to set user organization', 500, 'ServerError');
  }
});

// Get organization leagues
router.get('/:id/leagues', async (req, res) => {
  try {
    const id = parseInt(singleRouteParam(req.params.id), 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid organization ID', 400, 'InvalidRequest');
    }

    const organization = await storage.getOrganization(id);
    if (!organization) {
      return sendError(res, 'Organization not found', 404, 'NOT_FOUND');
    }

    if (!requireOrganizationAccess(req, id, 'organization', id)) {
      return sendError(res, 'You do not have access to this organization', 403, 'Forbidden');
    }

    const leagues = await storage.getLeagues(id);
    sendSuccess(res, leagues);
  } catch (error) {
    log.error(`Error fetching leagues for organization ${req.params.id}:`, error);
    sendError(res, 'Failed to fetch organization leagues', 500, 'ServerError');
  }
});

export default router;
