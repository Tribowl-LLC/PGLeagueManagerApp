import type { NextFunction, Request, Response } from 'express';
import { env, isProdLike, isSingletonOrganizationMode } from '../config';
import { resolveConfiguredOrganization, SingleTenantContextError } from '../services/single-tenant-context';
import { subdomainDetection } from './subdomain';

declare global {
  namespace Express {
    interface Request {
      organizationContext?: import('@shared/schema').Organization | null;
      organizationContextId?: number;
    }
  }
}

function hostFromRequest(req: Request): string {
  return (req.hostname || req.headers.host || '').split(':')[0].trim().toLowerCase();
}

function isLocalHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || /^\d+\.\d+\.\d+\.\d+$/.test(host);
}

function isCanonicalHost(host: string): boolean {
  return host === env.APP_DOMAIN;
}

function isLegacyHost(host: string): boolean {
  return env.LEGACY_ORG_HOSTS.includes(host) || host === `www.${env.APP_DOMAIN}`;
}

function rejectUnknownHost(req: Request, res: Response): boolean {
  const host = hostFromRequest(req);
  if (isLocalHost(host) || isCanonicalHost(host) || isLegacyHost(host)) return false;
  // Local development often runs behind a Vite/Render-style forwarded host.
  // Production-like deployments must be explicit so an arbitrary subdomain
  // cannot become an accidental organization selector.
  if (!isProdLike) return false;
  res.status(421).json({
    success: false,
    error: { code: 'UNKNOWN_HOST', message: 'This hostname is not configured for LeagueVault.' },
  });
  return true;
}

/**
 * Fixed business context and canonical-host compatibility middleware.
 * Webhooks and liveness are registered before this middleware in app.ts, so
 * their raw-body and DB-free contracts remain unchanged.
 */
export async function singletonOrganizationContext(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!isSingletonOrganizationMode) {
    if (isProdLike) {
      res.status(503).json({
        success: false,
        error: {
          code: 'configuration_missing',
          message: 'Business context is not configured.',
        },
      });
      return;
    }
    return subdomainDetection(req, res, next);
  }

  if (rejectUnknownHost(req, res)) return;

  const host = hostFromRequest(req);
  if (isLegacyHost(host)) {
    if (req.method === 'GET' || req.method === 'HEAD') {
      res.redirect(308, `https://${env.APP_DOMAIN}${req.originalUrl}`);
      return;
    }
    res.status(421).json({
      success: false,
      error: {
        code: 'CANONICAL_HOST_REQUIRED',
        message: 'Use the canonical LeagueVault address for this request.',
      },
    });
    return;
  }

  try {
    const organization = await resolveConfiguredOrganization();
    req.organizationContext = organization;
    req.organizationContextId = organization.id;
    // Existing route code and public asset URLs consume this compatibility
    // property. It is now assigned from deployment configuration, never from
    // the request hostname or browser input.
    req.subdomainOrg = organization;
    req.orgSlug = null;
    next();
  } catch (error) {
    if (error instanceof SingleTenantContextError) {
      res.status(503).json({
        success: false,
        error: { code: error.code, message: 'Business context is temporarily unavailable.' },
      });
      return;
    }
    next(error);
  }
}
