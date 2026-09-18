import type { NextFunction, Request, Response } from 'express';
import { isSingletonOrganizationMode } from '../config';
import { sendError } from '../utils/api';

function readOrganizationId(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : NaN;
}

/**
 * In singleton mode an organizationId may remain in old internal contracts,
 * but it can never select a different organization. Reject mismatches at the
 * request boundary so each route does not need its own system-admin branch.
 */
export function rejectForeignOrganizationInput(req: Request, res: Response, next: NextFunction): void {
  if (!isSingletonOrganizationMode || req.organizationContextId === undefined) {
    next();
    return;
  }

  const values = [req.query.organizationId, req.body?.organizationId];
  for (const value of values) {
    const parsed = readOrganizationId(value);
    if (parsed === undefined || parsed === null) continue;
    if (!Number.isSafeInteger(parsed)) {
      sendError(res, 'Invalid organization context', 400, 'INVALID_ORGANIZATION_CONTEXT');
      return;
    }
    if (parsed !== req.organizationContextId) {
      sendError(res, 'The requested organization is not available', 403, 'ORG_CONTEXT_MISMATCH');
      return;
    }
  }
  next();
}
