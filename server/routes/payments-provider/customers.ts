/**
 * Provider customer create/update.
 *
 * Routes:
 *  - POST /customers
 */
import { Router } from 'express';
import { storage } from '../../storage';
import { sendError } from '../../utils/api.js';
import { paymentLimiter } from '../../middleware/rate-limit.js';
import { createLogger } from '../../logger';
import { getPaymentProvider, ProviderNotConfiguredError } from '../../services/payment-provider-factory';
import { getProviderForLeague } from './shared.js';
import { isOrgOrHigher } from '../../utils/access-control';

const log = createLogger('Payments');

const router = Router();

router.post('/customers', paymentLimiter, async (req, res) => {
  try {
    let team: Awaited<ReturnType<typeof storage.getTeam>> | null = null;
    if (req.body.teamId) {
      team = await storage.getTeam(req.body.teamId);

      if (!team) {
        return sendError(res, 'Team not found', 404, 'NOT_FOUND');
      }

      const league = await storage.getLeague(team.leagueId);

      if (!league) {
        return sendError(res, 'League not found', 404, 'NOT_FOUND');
      }

      if (league.organizationId === null) {
        return sendError(res, "You don't have access to this team", 403, 'FORBIDDEN');
      }

      // Payment-provider customer surfaces are explicitly
      // off-limits to plain users (could expose provider
      // customer IDs / vault metadata). Restrict to org_admin /
      // system_admin in the league's owning org.
      const userHasAccess =
        req.user?.role === 'system_admin' ||
        (isOrgOrHigher(req.user) && req.user?.organizationId === league.organizationId);
      if (!userHasAccess) {
        return sendError(res, "You don't have access to this team", 403, 'FORBIDDEN');
      }
    }

    const provider = team
      ? await getProviderForLeague(team.leagueId)
      : await getPaymentProvider(null);

    const customer = await provider.createOrUpdateCustomer(
      req.body.name,
      req.body.email,
    );

    if (!customer) {
      throw new Error('Failed to create/update customer');
    }

    res.json(customer);
  } catch (error) {
    if (error instanceof ProviderNotConfiguredError) {
      return sendError(res, 'Payment provider not configured for this location', 422, 'PROVIDER_NOT_CONFIGURED');
    }
    log.error('Customer operation error:', {
      error: error instanceof Error ? {
        name: error.name,
        message: error.message,
        stack: error.stack
      } : error
    });
    sendError(res, 'Customer operation failed', 500);
  }
});

export default router;
