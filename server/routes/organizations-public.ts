import { Router, Request, Response } from 'express';
import { eq, and, isNotNull } from 'drizzle-orm';
import type { Organization } from '@shared/schema';
import { leagues, organizations } from '@shared/schema';
import { db } from '../db.js';
import { sendSuccess, sendError } from '../utils/api.js';
import { isAllowedRedirectUrl } from '../utils/url-validation.js';
import { validateDataUri } from '../utils/image-magic-bytes.js';
import { storage } from '../storage';
import { createLogger } from '../logger';

const log = createLogger("OrganizationsPublic");

const router = Router();

async function serveOrgImage(
  res: Response,
  org: Organization | null | undefined,
  pickField: (o: Organization) => string | null | undefined,
  notFoundLabel: string,
): Promise<void> {
  const data = org ? pickField(org) : null;
  if (!org || !data) {
    sendError(res, `${notFoundLabel} not found`, 404, 'NOT_FOUND');
    return;
  }

  if (data.startsWith('data:')) {
    const result = validateDataUri(data);
    if (!result.valid) {
      sendError(res, result.error, 400, 'INVALID_FORMAT');
      return;
    }
    res.set('Content-Type', result.mimeType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(result.buffer);
    return;
  }

  if (!isAllowedRedirectUrl(data)) {
    sendError(res, `${notFoundLabel} URL points to an untrusted domain`, 400, 'UNTRUSTED_URL');
    return;
  }
  res.redirect(data);
}

router.get('/public-leagues', async (_req, res) => {
  try {
    const rows = await db
      .select({
        id: leagues.id,
        name: leagues.name,
        organizationId: leagues.organizationId,
        organizationName: organizations.name,
        organizationSlug: organizations.slug,
      })
      .from(leagues)
      .innerJoin(organizations, eq(organizations.id, leagues.organizationId))
      .where(and(
        eq(leagues.allowPublicSignup, true),
        eq(leagues.active, true),
        eq(leagues.scheduleAuthority, 'canonical'),
        isNotNull(leagues.organizationId),
      ))
      .orderBy(organizations.name, leagues.name);
    sendSuccess(res, rows);
  } catch (error) {
    log.error('Error fetching public leagues:', error);
    sendError(res, 'Failed to fetch public leagues', 500, 'ServerError');
  }
});

router.get('/slug/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const organization =
      (await storage.getOrganizationBySubdomain(slug)) ??
      (await storage.getOrganizationBySlug(slug));

    if (!organization) {
      return sendError(res, 'Organization not found', 404, 'NOT_FOUND');
    }

    sendSuccess(res, {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      logo: organization.logo,
      darkLogo: organization.darkLogo,
      appIcon: organization.appIcon,
    });
  } catch (error) {
    log.error(`Error fetching organization with slug ${req.params.slug}:`, error);
    sendError(res, 'Failed to fetch organization', 500, 'ServerError');
  }
});

router.get('/slug/:slug/leagues', async (req, res) => {
  try {
    const { slug } = req.params;
    const organization =
      (await storage.getOrganizationBySubdomain(slug)) ??
      (await storage.getOrganizationBySlug(slug));

    if (!organization) {
      return sendError(res, 'Organization not found', 404, 'NOT_FOUND');
    }

    const leagues = await storage.getLeagues(organization.id);
    const publicLeagues = leagues
      .filter(l => l.active !== false && l.allowPublicSignup === true)
      .map(l => ({ id: l.id, name: l.name }));
    sendSuccess(res, publicLeagues);
  } catch (error) {
    log.error(`Error fetching leagues for org slug ${req.params.slug}:`, error);
    sendError(res, 'Failed to fetch organization leagues', 500, 'ServerError');
  }
});

router.get('/slug/:slug/logo', async (req, res) => {
  try {
    const { slug } = req.params;
    const organization =
      (await storage.getOrganizationBySubdomain(slug)) ??
      (await storage.getOrganizationBySlug(slug));
    await serveOrgImage(res, organization, (o) => o.logo, 'Logo');
  } catch (error) {
    log.error('Error serving organization logo:', error);
    sendError(res, 'Failed to serve logo', 500);
  }
});

router.get('/slug/:slug/app-icon', async (req, res) => {
  try {
    const { slug } = req.params;
    const organization =
      (await storage.getOrganizationBySubdomain(slug)) ??
      (await storage.getOrganizationBySlug(slug));
    await serveOrgImage(res, organization, (o) => o.appIcon || o.logo, 'App icon');
  } catch (error) {
    log.error('Error serving organization app icon:', error);
    sendError(res, 'Failed to serve app icon', 500);
  }
});

// By-id variants are kept for backward-compat with already-sent
// emails / cached PWA manifests that embedded the integer-id URL
// before we switched to the slug-based form. They are gated to
// stop a scraper from sweeping ints 1..N to enumerate every tenant
// on the platform: the caller must either (a) be on the org's
// subdomain (so `req.subdomainOrg.id` matches the requested id),
// or (b) be an authenticated user whose `organizationId` matches.
// Anything else gets a 404 NOT_FOUND — same shape as a missing
// org, so a probe can't distinguish "doesn't exist" from "exists
// but you can't see it". Internal callers should use the
// `/slug/:slug/logo` and `/slug/:slug/app-icon` routes above.
function isAuthorizedForOrgId(req: Request, id: number): boolean {
  if (req.subdomainOrg && req.subdomainOrg.id === id) return true;
  if (req.isAuthenticated?.() && req.user?.organizationId === id) return true;
  return false;
}

router.get('/:id/logo', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid organization ID', 400, 'INVALID_ID');
    }
    if (!isAuthorizedForOrgId(req, id)) {
      return sendError(res, 'Logo not found', 404, 'NOT_FOUND');
    }
    const organization = await storage.getOrganization(id);
    await serveOrgImage(res, organization, (o) => o.logo, 'Logo');
  } catch (error) {
    log.error('Error serving organization logo:', error);
    sendError(res, 'Failed to serve logo', 500);
  }
});

router.get('/:id/app-icon', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid organization ID', 400, 'INVALID_ID');
    }
    if (!isAuthorizedForOrgId(req, id)) {
      return sendError(res, 'App icon not found', 404, 'NOT_FOUND');
    }
    const organization = await storage.getOrganization(id);
    await serveOrgImage(res, organization, (o) => o.appIcon || o.logo, 'App icon');
  } catch (error) {
    log.error('Error serving organization app icon:', error);
    sendError(res, 'Failed to serve app icon', 500);
  }
});

export default router;
