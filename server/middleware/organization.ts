import { Request, Response, NextFunction } from 'express';
import { sendError } from '../utils/api.js';
import { isSingletonOrganizationMode } from '../config';

declare module 'express-serve-static-core' {
  interface Request {
    organizationFilter?: number | null;
  }
}

type OrgScopedRequest = Request & {
  organizationFilter?: number | null;
  isAuthenticated?: () => boolean;
};

/**
 * Middleware to filter resources by the user's organization
 * This automatically adds the organization filter to the request
 */
export function filterByOrganization(req: OrgScopedRequest, res: Response, next: NextFunction) {
  // If the user is not authenticated, don't apply any filter
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    req.organizationFilter = null;
    return next();
  }

  if (isSingletonOrganizationMode && req.organizationContextId !== undefined) {
    req.organizationFilter = req.organizationContextId;
    return next();
  }

  // System admins without an organization see all data
  // System admins with an organization default to their org's data
  if (req.user.role === 'system_admin' && !req.query.organizationId) {
    req.organizationFilter = req.user.organizationId || null;
    return next();
  }

  // If a specific organization is requested in the query string
  if (req.query.organizationId) {
    const orgId = parseInt(String(req.query.organizationId));

    // System admins can access any organization
    if (req.user.role === 'system_admin') {
      req.organizationFilter = orgId;
      return next();
    }

    // Organization admins can only access their own organization
    if (req.user.organizationId === orgId) {
      req.organizationFilter = orgId;
      return next();
    }

    // User requested an organization they don't have access to
    return sendError(
      res,
      'You do not have access to this organization',
      403,
      'ORG_ACCESS_DENIED'
    );
  }

  // Default to the user's organization
  req.organizationFilter = req.user.organizationId;
  next();
}

/**
 * Extract organization ID from request
 * This utility function gets the organization ID from the request
 * accounting for user permissions and query parameters
 */
export function getOrganizationFilter(req: OrgScopedRequest): number | null {
  // If organization filter was already determined, use it
  if (req.organizationFilter !== undefined) {
    return req.organizationFilter;
  }

  if (isSingletonOrganizationMode && req.organizationContextId !== undefined) {
    return req.organizationContextId;
  }

  // System admins default to their org, or all if unassigned
  if (req.user && req.user.role === 'system_admin' && !req.query.organizationId) {
    return req.user.organizationId || null;
  }

  // If query has organization ID, validate access
  if (req.query.organizationId) {
    const orgId = parseInt(String(req.query.organizationId));
    
    // System admins can access any organization
    if (req.user && req.user.role === 'system_admin') {
      return orgId;
    }
    
    // Organization admins can only access their own organization
    if (req.user && req.user.organizationId === orgId) {
      return orgId;
    }
    
    // User doesn't have access to requested organization
    // Default to their own
    return req.user ? req.user.organizationId : null;
  }

  // Default to user's organization if authenticated
  return req.user ? req.user.organizationId : null;
}
