import { Request, Response, NextFunction } from 'express';
import { storage } from '../storage';
import { createLogger } from '../logger';
import { Organization } from '@shared/schema';
import { isSystemAdmin } from '../utils/access-control';
import { env } from '../config';
import { getPgErrorCode } from '../utils/db-errors.js';

const log = createLogger("Subdomain");

// safe: APP_DOMAIN is normalised to lowercase at parse-time (task #335).
// `extractSubdomain` lowercases the incoming `host` (line below) and
// then string-compares it against `MAIN_DOMAIN`. Both sides must be
// lowercase or the equality / `endsWith` checks would silently fail.
const MAIN_DOMAIN = env.APP_DOMAIN;
const IGNORED_SUBDOMAINS = new Set(['www', 'api', 'admin', 'mail', 'smtp', 'ftp']);
const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;
const isDev = process.env.NODE_ENV !== 'production';
export const TENANT_LOOKUP_UNAVAILABLE_CODE = 'TENANT_LOOKUP_UNAVAILABLE';

declare global {
  namespace Express {
    interface Request {
      subdomainOrg?: Organization | null;
      orgSlug?: string | null;
    }
  }
}

function extractSubdomain(hostname: string): string | null {
  const host = hostname.split(':')[0].toLowerCase();

  if (host === 'localhost' || host === '127.0.0.1' || host.match(/^\d+\.\d+\.\d+\.\d+$/)) {
    return null;
  }

  if (host === MAIN_DOMAIN || host === `www.${MAIN_DOMAIN}`) {
    return null;
  }

  if (host.endsWith(`.${MAIN_DOMAIN}`)) {
    const sub = host.slice(0, -(MAIN_DOMAIN.length + 1));
    if (!sub || IGNORED_SUBDOMAINS.has(sub) || sub.includes('.')) {
      return null;
    }
    return sub;
  }

  return null;
}

export async function lookupOrganizationByHostname(
  subdomain: string,
): Promise<Organization | null> {
  try {
    let org = await storage.getOrganizationBySubdomain(subdomain);

    if (!org) {
      org = await storage.getOrganizationBySlug(subdomain);
    }

    return org ?? null;
  } catch (err) {
    // A database failure is not a cache miss. Returning null here would let
    // downstream routes continue as if this were the platform host, which is
    // an unsafe tenant-isolation failure mode. Keep telemetry structured and
    // avoid logging the tenant hostname or a raw Drizzle/SQL error.
    log.captureException(err);
    log.error('Tenant hostname lookup failed', {
      operation: 'organization_hostname_lookup',
      errorType: err instanceof Error ? err.name : 'unknown',
      errorCode: getPgErrorCode(err) ?? 'unknown',
    });
    throw new OrganizationHostnameLookupError(err);
  }
}

export class OrganizationHostnameLookupError extends Error {
  constructor(cause?: unknown) {
    super('Organization hostname lookup is temporarily unavailable', { cause });
    this.name = 'OrganizationHostnameLookupError';
  }
}

type TenantDetectionRequest = Pick<Request, 'hostname' | 'headers' | 'query'> & {
  subdomainOrg?: Organization | null;
  orgSlug?: string | null;
};

type TenantDetectionResponse = {
  headersSent: boolean;
  status: (statusCode: number) => TenantDetectionResponse;
  json: (body: unknown) => unknown;
};

function respondTenantLookupUnavailable(res: TenantDetectionResponse): void {
  if (res.headersSent) return;
  res.status(503).json({
    success: false,
    error: {
      code: TENANT_LOOKUP_UNAVAILABLE_CODE,
      message: 'Tenant context is temporarily unavailable. Please retry shortly.',
    },
  });
}

export function subdomainDetection(req: TenantDetectionRequest, _res: TenantDetectionResponse, next: NextFunction): void;
export function subdomainDetection(req: Request, _res: Response, next: NextFunction): void;
export function subdomainDetection(req: TenantDetectionRequest, _res: TenantDetectionResponse, next: NextFunction) {
  if (isDev) {
    const devOverride = req.query.__org_slug as string | undefined;
    if (devOverride && SLUG_REGEX.test(devOverride)) {
      req.orgSlug = devOverride;
      lookupOrganizationByHostname(devOverride).then((org) => {
        req.subdomainOrg = org;
        next();
      }).catch((error) => {
        if (error instanceof OrganizationHostnameLookupError) {
          respondTenantLookupUnavailable(_res);
          return;
        }
        next(error);
      });
      return;
    }
  }

  const hostname = req.hostname || req.headers.host || '';
  const slug = extractSubdomain(hostname);

  if (!slug) {
    req.orgSlug = null;
    req.subdomainOrg = null;
    next();
    return;
  }

  req.orgSlug = slug;
  lookupOrganizationByHostname(slug).then((org) => {
    req.subdomainOrg = org;
    next();
  }).catch((error) => {
    if (error instanceof OrganizationHostnameLookupError) {
      respondTenantLookupUnavailable(_res);
      return;
    }
    next(error);
  });
}

export async function checkUserBelongsToOrg(
  user: Express.User,
  orgId: number
): Promise<boolean> {
  if (isSystemAdmin(user)) return true;
  if (user.organizationId === orgId) return true;

  if (user.organizationId) {
    return false;
  }

  if (user.bowlerId) {
    try {
      const entries = await storage.getBowlerLeagues({ bowlerId: user.bowlerId });
      if (entries.length > 0) {
        const leagues = await storage.getLeaguesByIds(entries.map(e => e.leagueId));
        if (leagues.some(l => l.organizationId === orgId)) {
          const updated = await storage.setUserOrganization(user.id, orgId);
          Object.assign(user, { organizationId: updated.organizationId });
          return true;
        }
      }
    } catch (err) {
      log.error('Error checking bowler org linkage:', err);
    }
  }

  return false;
}

export function orgSessionGuard(req: Request, res: Response, next: NextFunction) {
  const subdomainOrg = req.subdomainOrg;
  if (!subdomainOrg || !req.isAuthenticated() || !req.user) {
    return next();
  }

  checkUserBelongsToOrg(req.user, subdomainOrg.id).then((belongs) => {
    if (belongs) return next();
    req.logout((err) => {
      if (err) {
        log.error('Failed to logout user during org session guard:', err);
        return res.status(401).json({ success: false, error: { message: 'Not authenticated', code: 'AUTH_REQUIRED' } });
      }
      next();
    });
  }).catch(() => {
    res.status(401).json({ success: false, error: { message: 'Not authenticated', code: 'AUTH_REQUIRED' } });
  });
}

export { extractSubdomain };
