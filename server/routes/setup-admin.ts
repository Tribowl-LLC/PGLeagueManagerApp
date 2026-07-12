import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { sendSuccess, sendError, sanitizeUser, handleZodError } from '../utils/api.js';
import { singleRouteParam } from '../utils/route-params';
import { storage } from '../storage';
import { hashPassword, safeTokenCompare } from '../auth.js';
import { passwordSchema } from '@shared/password-validation.js';
import { env } from '../config';
import { createLogger } from '../logger';
import { setupAdminLimiter } from '../middleware/rate-limit.js';
import {
  AdminAlreadyExistsError,
  FirstAdminEmailExistsError,
  FirstAdminUserNotFoundError,
} from '../storage/users';

const log = createLogger("SetupAdmin");

const router = Router();

// Exported for regression tests in tests/api/setup-admin-header.test.ts.
//
// Strength requirement: SETUP_SECRET must be at least
// MIN_SETUP_SECRET_LENGTH chars. That floor is enforced at boot in
// `server/config.ts` (`validateSetupSecret`), so by the time this
// function runs we already know the configured secret is non-trivial.
export function checkSetupSecret(req: Request, res: Response): boolean {
  const setupSecret = env.SETUP_SECRET;
  if (!setupSecret) {
    sendError(res, 'This endpoint is disabled. Set SETUP_SECRET to enable it.', 403, 'ENDPOINT_DISABLED');
    return false;
  }
  // Load-bearing: collapses a string[] header value to its first entry so
  // `safeTokenCompare` always sees a string. See tests/api/setup-admin-header.test.ts.
  const rawSecret = req.headers['x-setup-secret'];
  const providedSecret = Array.isArray(rawSecret) ? rawSecret[0] : rawSecret;
  if (!providedSecret || !safeTokenCompare(providedSecret, setupSecret)) {
    sendError(res, 'Invalid or missing setup secret.', 401, 'UNAUTHORIZED');
    return false;
  }
  return true;
}

// Endpoint to create the first admin user.
// Atomic: serialized via a Postgres transaction-scoped advisory lock so two
// concurrent requests with the same SETUP_SECRET cannot both succeed.
router.post('/create-first-admin', setupAdminLimiter, async (req: Request, res: Response) => {
  try {
    if (!checkSetupSecret(req, res)) return;

    const adminSchema = z.object({
      email: z.string().email('Invalid email address'),
      password: passwordSchema,
      name: z.string().min(2, 'Name must be at least 2 characters'),
      phone: z.string().optional(),
    });

    const validationResult = adminSchema.safeParse(req.body);
    if (!validationResult.success) {
      return handleZodError(res, validationResult.error);
    }

    const userData = validationResult.data;
    const hashedPassword = await hashPassword(userData.password);

    const newAdminUser = await storage.bootstrapFirstAdmin({
      email: userData.email,
      hashedPassword,
      name: userData.name,
      phone: userData.phone,
    });

    sendSuccess(res, sanitizeUser(newAdminUser), 201);
  } catch (error) {
    if (error instanceof AdminAlreadyExistsError) {
      return sendError(
        res,
        'Admin users already exist. Use the regular admin invitation process.',
        403,
        'ADMIN_EXISTS',
      );
    }
    if (error instanceof FirstAdminEmailExistsError) {
      return sendError(res, 'A user with this email already exists', 409, 'EMAIL_EXISTS');
    }
    log.error('Error creating first admin user:', error);
    sendError(res, 'Failed to create admin user', 500, 'SERVER_ERROR');
  }
});

// Promote an existing user to system_admin — only works when ZERO admin users exist.
// Atomic: shares the same advisory lock as create-first-admin so the two
// endpoints cannot race against each other.
router.post('/first-system-admin/:id', setupAdminLimiter, async (req: Request, res: Response) => {
  try {
    if (!checkSetupSecret(req, res)) return;

    const userId = parseInt(singleRouteParam(req.params.id), 10);
    if (isNaN(userId)) {
      return sendError(res, 'Invalid user ID', 400, 'INVALID_ID');
    }

    const updatedUser = await storage.promoteFirstAdmin(userId);
    sendSuccess(res, sanitizeUser(updatedUser));
  } catch (error) {
    if (error instanceof AdminAlreadyExistsError) {
      return sendError(
        res,
        'Admin users already exist. Use the regular admin invitation process.',
        403,
        'ADMIN_EXISTS',
      );
    }
    if (error instanceof FirstAdminUserNotFoundError) {
      return sendError(res, 'User not found', 404, 'USER_NOT_FOUND');
    }
    log.error('Error creating first system admin:', error);
    sendError(res, 'Failed to create first system admin', 500, 'SERVER_ERROR');
  }
});

export default router;
