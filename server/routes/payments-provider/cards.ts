/**
 * Saved-card vault operations.
 *
 * Routes:
 *  - POST   /cards/:bowlerId
 *  - GET    /cards/:bowlerId
 *  - DELETE /cards/:bowlerId/:cardId
 */
import { Router } from 'express';
import { storage } from '../../storage';
import { sendSuccess, sendError, parseOptionalIntParam } from '../../utils/api.js';
import { hasSelfOrAdminAccessToBowler } from '../../utils/access-control.js';
import { createLogger } from '../../logger';
import {
  getPaymentProvider,
  ProviderNotConfiguredError,
  CardOwnershipMismatchError,
} from '../../services/payment-provider-factory';
import { buildPaymentErrorResponse } from '../../utils/payment-error-response.js';
import { getProviderCustomerId, ensureProviderCustomer } from '../../services/payment-utils';
import { getProviderForLeague } from './shared.js';

const log = createLogger('Payments');

const router = Router();

router.post('/cards/:bowlerId', async (req, res) => {
  try {
    const bowlerId = parseInt(req.params.bowlerId);
    if (isNaN(bowlerId)) return sendError(res, 'Invalid bowler ID', 400);

    if (!req.isAuthenticated()) {
      return sendError(res, 'Authentication required', 401, 'AUTH_REQUIRED');
    }

    // Sensitive write: requires self-access or admin role (task #732).
    if (!await hasSelfOrAdminAccessToBowler(req, bowlerId)) {
      return sendError(res, "You don't have access to this bowler", 403, 'FORBIDDEN');
    }

    const { sourceId } = req.body;
    if (!sourceId || typeof sourceId !== 'string') {
      return sendError(res, 'sourceId is required', 400);
    }

    const bowler = await storage.getBowler(bowlerId);
    if (!bowler) {
      return sendError(res, 'Bowler not found', 404, 'NOT_FOUND');
    }

    const rawLeagueId = req.body.leagueId;
    let resolvedLeagueId: number | null = null;
    if (rawLeagueId !== undefined && rawLeagueId !== null && rawLeagueId !== '') {
      const parsed = parseInt(rawLeagueId);
      if (isNaN(parsed)) {
        return sendError(res, 'Invalid league ID format', 400);
      }
      resolvedLeagueId = parsed;
    } else {
      const bowlerLeagues = await storage.getBowlerLeagues({ bowlerId });
      if (bowlerLeagues.length > 0) {
        resolvedLeagueId = bowlerLeagues[0].leagueId;
      }
    }

    const provider = resolvedLeagueId
      ? await getProviderForLeague(resolvedLeagueId)
      : await getPaymentProvider(null);
    // Bootstrap a Square customer on first save so a new bowler does not
    // receive a "no payment customer account" error.
    const providerCustId = await ensureProviderCustomer(provider, bowler);
    if (!providerCustId) {
      return sendError(res, 'Bowler does not have a payment customer account', 400);
    }

    const savedCard = await provider.saveCardOnFile(sourceId, providerCustId);
    if (!savedCard?.id) {
      return sendError(res, 'Failed to save card on file', 500);
    }

    log.info('Card saved on file (no-charge):', { success: true });
    return sendSuccess(res, { savedCardId: savedCard.id, last4: savedCard.last4, brand: savedCard.brand });
  } catch (error) {
    log.error('Save card error:', error);
    // Surface the provider's typed `userMessage` + `code` (e.g.
    // "Invalid payment information.", "CARD_TOKEN_EXPIRED") instead
    // of the generic "Failed to save card" wall — matches the
    // charge / refund routes via the shared helper. Task #605.
    const { status, userMessage, code } = buildPaymentErrorResponse(
      error,
      'Failed to save card',
      'SAVE_CARD_ERROR',
    );
    return sendError(res, userMessage, status, code);
  }
});

router.get('/cards/:bowlerId', async (req, res) => {
  try {
    const bowlerId = parseInt(req.params.bowlerId);
    if (isNaN(bowlerId)) {
      return sendError(res, 'Invalid bowler ID', 400);
    }

    // Sensitive read (card vault): requires self-access or admin role (task #732).
    if (!await hasSelfOrAdminAccessToBowler(req, bowlerId)) {
      return sendError(res, "You don't have access to this bowler", 403, 'FORBIDDEN');
    }

    const bowler = await storage.getBowler(bowlerId);
    if (!bowler) {
      return sendSuccess(res, []);
    }

    // task #421: reject malformed `?leagueId` instead of forwarding
    // NaN into `getProviderForLeague` (which would surface as a
    // confusing provider-not-configured / 500). Empty string is
    // still treated as "no filter" → fall through to the bowler's
    // own league below.
    const listLeagueIdParsed = parseOptionalIntParam(req.query.leagueId);
    if (listLeagueIdParsed === null) {
      return sendError(res, "Invalid league ID format", 400);
    }
    let resolvedLeagueId: number | null = listLeagueIdParsed ?? null;
    if (!resolvedLeagueId) {
      const bowlerLeagues = await storage.getBowlerLeagues({ bowlerId: bowlerId });
      if (bowlerLeagues.length > 0) {
        resolvedLeagueId = bowlerLeagues[0].leagueId;
      }
    }

    let provider;
    try {
      provider = resolvedLeagueId
        ? await getProviderForLeague(resolvedLeagueId)
        : await getPaymentProvider(null);
    } catch (e) {
      if (e instanceof ProviderNotConfiguredError) {
        log.warn('List cards: provider not configured, returning empty', { leagueId: resolvedLeagueId });
        return sendSuccess(res, []);
      }
      throw e;
    }

    const providerCustId = getProviderCustomerId(bowler, provider);
    if (!providerCustId) {
      return sendSuccess(res, []);
    }

    const cards = await provider.listCardsOnFile(providerCustId);
    sendSuccess(res, cards);
  } catch (error) {
    log.error('List cards error:', error);
    sendError(res, 'Failed to list cards');
  }
});

router.delete('/cards/:bowlerId/:cardId', async (req, res) => {
  try {
    const bowlerId = parseInt(req.params.bowlerId);
    if (isNaN(bowlerId)) {
      return sendError(res, 'Invalid bowler ID', 400);
    }

    const { cardId } = req.params;
    if (!cardId || typeof cardId !== 'string') {
      return sendError(res, 'Invalid card ID', 400);
    }

    // Sensitive write: requires self-access or admin role (task #732).
    if (!await hasSelfOrAdminAccessToBowler(req, bowlerId)) {
      return sendError(res, "You don't have access to this bowler", 403, 'FORBIDDEN');
    }

    const bowler = await storage.getBowler(bowlerId);
    if (!bowler) {
      return sendError(res, 'Bowler not found', 404, 'NOT_FOUND');
    }

    const delLeagueIdParsed = parseOptionalIntParam(req.query.leagueId);
    if (delLeagueIdParsed === null) {
      return sendError(res, "Invalid league ID format", 400);
    }
    let resolvedLeagueId: number | null = delLeagueIdParsed ?? null;
    if (!resolvedLeagueId) {
      const bowlerLeagues = await storage.getBowlerLeagues({ bowlerId: bowlerId });
      if (bowlerLeagues.length > 0) {
        resolvedLeagueId = bowlerLeagues[0].leagueId;
      }
    }

    const provider = resolvedLeagueId
      ? await getProviderForLeague(resolvedLeagueId)
      : await getPaymentProvider(null);

    const providerCustId = getProviderCustomerId(bowler, provider);
    if (!providerCustId) {
      return sendError(res, 'Bowler does not have a payment customer account', 400);
    }

    await provider.disableCard(cardId, providerCustId);
    log.info('Card disabled:', cardId.substring(0, 15) + '...');
    sendSuccess(res, { disabled: true });
  } catch (error) {
    log.error('Disable card error:', error instanceof Error ? error.message : error);

    // The Square provider throws a typed
    // `CardOwnershipMismatchError` when the requested card id isn't
    // one of this customer's saved cards (see
    // server/services/square-provider.ts::disableCard). That's a
    // tenancy violation rather than a provider failure, so it keeps
    // its dedicated 403 mapping. Everything else routes through the
    // shared helper so admins see the typed
    // PaymentProviderError.userMessage / code instead of an ad-hoc
    // string. Task #605 introduced the helper; task #620 replaced
    // the previous `error.constructor === Error` + substring guard
    // with this `instanceof` check so an unrelated plain `Error`
    // bubbling out of the provider chain no longer accidentally
    // triggers the 403 branch.
    if (error instanceof CardOwnershipMismatchError) {
      return sendError(res, error.message, 403);
    }
    const { status, userMessage, code } = buildPaymentErrorResponse(
      error,
      'Failed to remove card',
      'REMOVE_CARD_ERROR',
    );
    sendError(res, userMessage, status, code);
  }
});

export default router;
