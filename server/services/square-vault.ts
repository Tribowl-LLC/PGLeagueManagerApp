import { createLogger } from '../logger';
import { isDev } from '../config';
import {
  ProviderNotConfiguredError,
  PaymentProviderError,
  CardOwnershipMismatchError,
  isHandledPaymentProviderError,
} from './payment-errors';
import {
  buildSquareIdempotencyKey,
  type SquareProviderContext,
} from './square-client';
import { classifySquareFailure } from './square-payments';
import type {
  SavedCard,
  PaymentCustomer,
} from './payment-provider';

const log = createLogger("SquareService");

export async function saveCardOnFile(
  ctx: SquareProviderContext,
  sourceId: string,
  customerId: string,
  idempotencyKey?: string,
): Promise<SavedCard | null> {
  const client = await ctx.getClient();
  if (!client) {
    // Throw the structured "not configured" error so the
    // POST /cards/:bowlerId route surfaces 422
    // PROVIDER_NOT_CONFIGURED and the durable interactive executor can
    // classify the pre-charge vault attempt without dispatching payment.
    throw new ProviderNotConfiguredError(
      'Square client not configured for this location',
      ctx.locationId,
    );
  }

  try {
    if (isDev) log.info('Saving card on file for customer:', customerId.substring(0, 10) + '...');
    // Square's CreateCard idempotency key can only deduplicate retries that
    // reuse the same one-time source token. A customer who enters the same
    // physical card again receives a new token, so compare Square's stable
    // card fingerprint after creation.
    const response = await client.cards.create({
      // Use the centralised builder so we can never silently
      // re-introduce the >45-char idempotency_key bug that broke
      // every save-card call after the v40 SDK migration (task
      // #671). The format is deterministic per (sourceId, customerId)
      // so post-deploy retries still dedupe inside Square's window.
      idempotencyKey: idempotencyKey ?? buildSquareIdempotencyKey('lv-card', sourceId, customerId),
      sourceId,
      card: {
        customerId,
      },
    });

    const card = response.card;
    if (card?.id) {
      // List after creation so concurrent workers observe the same candidates.
      // Square returns enabled cards by default and ASC orders them by creation
      // time, making the first fingerprint match the deterministic survivor.
      const activePage = await client.cards.list({ customerId, sortOrder: 'ASC' });
      const fingerprintMatches = card.fingerprint
        ? (activePage.data ?? []).filter(candidate => (
            candidate.enabled
            && candidate.id
            && candidate.fingerprint === card.fingerprint
          ))
        : [];
      const survivor = fingerprintMatches[0];

      if (survivor?.id && survivor.id !== card.id) {
        // Each worker may disable only the card it created. Keeping the oldest
        // ID preserves schedules that already reference it, while disabled
        // cards remain eligible to be saved again later.
        await client.cards.disable({ cardId: card.id });
        log.info('Prevented duplicate saved card:', { success: true });
        return {
          id: survivor.id,
          last4: survivor.last4 ?? '',
          brand: survivor.cardBrand ?? '',
        };
      }

      return { id: card.id, last4: card.last4 ?? '', brand: card.cardBrand ?? '' };
    }
    return null;
  } catch (error) {
    // Re-throw as a typed PaymentProviderError so the standalone card route
    // and durable interactive executor retain the same sanitized message,
    // provider code, and retry/unknown/terminal disposition.
    if (
      error instanceof PaymentProviderError ||
      error instanceof ProviderNotConfiguredError
    ) {
      if (isHandledPaymentProviderError(error)) {
        log.debug('Saving card requires customer action', {
          code: error.code,
          disposition: error.disposition,
          providerCode: error.providerCode,
        });
      } else if (error instanceof PaymentProviderError) {
        log.error('Failed to save card on file', {
          code: error.code,
          disposition: error.disposition,
          providerCode: error.providerCode,
        });
      } else {
        log.error('Saving card provider is not configured');
      }
      throw error;
    }
    const failure = classifySquareFailure(error);
    if (failure.disposition === 'action_required' || failure.disposition === 'invalid_request') {
      log.debug('Saving card requires customer action', {
        httpStatus: failure.statusCode,
        squareErrorCode: failure.providerCode,
      });
    } else {
      log.error('Failed to save card on file', {
        httpStatus: failure.statusCode,
        squareErrorCode: failure.providerCode,
      });
    }
    if (failure.statusCode === 400) {
      throw new PaymentProviderError(
        'Invalid payment information. Please check your card details and try again.',
        'INVALID_REQUEST',
        failure.detail,
        failure,
      );
    }
    if (failure.disposition === 'configuration') {
      throw new PaymentProviderError(
        'Payment system is temporarily unavailable. Please try again later.',
        'SYSTEM_ERROR',
        failure.detail,
        failure,
      );
    }
    if (failure.disposition === 'action_required') {
      throw new PaymentProviderError(
        'The card could not be saved. Please check the card details or use a different card.',
        'CARD_SAVE_REQUIRES_ACTION',
        failure.detail,
        failure,
      );
    }
    throw new PaymentProviderError(
      'Could not save card on file. Please try again.',
      'SAVE_CARD_FAILED',
      failure.detail,
      failure,
    );
  }
}

async function fetchCardsOnFile(
  ctx: SquareProviderContext,
  customerId: string,
  strict: boolean,
): Promise<SavedCard[]> {
  const client = await ctx.getClient();
  if (!client) {
    if (strict) {
      throw new ProviderNotConfiguredError(
        'Square client not configured for this location',
        ctx.locationId,
      );
    }
    return [];
  }

  try {
    // v40+ flat-client `cards.list` returns a Page<Card>. We're only
    // interested in the first page (Square caps the response at 25
    // cards per the API docs, which is well below any single bowler's
    // realistic saved-card count).
    // square@44.2.0 serializes an omitted sortOrder as `sort_order=`.
    // Square rejects that empty enum, so send the API's documented default
    // explicitly until the SDK omits absent optional query parameters.
    const page = await client.cards.list({ customerId, sortOrder: 'ASC' });
    const cards = page.data ?? [];
    return cards
      .filter(c => c.enabled)
      .map(c => ({
        id: c.id!,
        last4: c.last4 || '****',
        brand: c.cardBrand || 'UNKNOWN',
        expMonth: Number(c.expMonth) || 0,
        expYear: Number(c.expYear) || 0,
      }));
  } catch (error) {
    if (error instanceof PaymentProviderError && isHandledPaymentProviderError(error)) {
      log.debug('Listing cards requires customer action', {
        code: error.code,
        disposition: error.disposition,
        providerCode: error.providerCode,
      });
    } else if (error instanceof PaymentProviderError) {
      log.error('Failed to list cards on file', {
        code: error.code,
        disposition: error.disposition,
        providerCode: error.providerCode,
      });
    }
    if (!strict) return [];
    if (
      error instanceof PaymentProviderError
      || error instanceof ProviderNotConfiguredError
    ) {
      throw error;
    }
    const failure = classifySquareFailure(error);
    if (failure.disposition === 'action_required' || failure.disposition === 'invalid_request') {
      log.debug('Listing cards requires customer action', {
        httpStatus: failure.statusCode,
        squareErrorCode: failure.providerCode,
      });
    } else {
      log.error('Failed to list cards on file', {
        httpStatus: failure.statusCode,
        squareErrorCode: failure.providerCode,
      });
    }
    throw new PaymentProviderError(
      'Could not verify the saved payment method. Please try again.',
      'CARD_OWNERSHIP_CHECK_FAILED',
      failure.detail,
      failure,
    );
  }
}

export async function listCardsOnFile(
  ctx: SquareProviderContext,
  customerId: string,
): Promise<SavedCard[]> {
  // Intentionally degraded for card-management UI reads: a missing provider
  // or provider outage remains an empty list. Payment authorization must use
  // hasCardOnFile(), whose strict path propagates those failures.
  return fetchCardsOnFile(ctx, customerId, false);
}

export async function hasCardOnFile(
  ctx: SquareProviderContext,
  customerId: string,
  cardId: string,
): Promise<boolean> {
  const cards = await fetchCardsOnFile(ctx, customerId, true);
  return cards.some(card => card.id === cardId);
}

export async function disableCard(
  ctx: SquareProviderContext,
  cardId: string,
  customerId: string,
): Promise<void> {
  const client = await ctx.getClient();
  if (!client) {
    // DELETE /cards/:bowlerId/:cardId maps PNCE → 422
    // PROVIDER_NOT_CONFIGURED. Task #332.
    throw new ProviderNotConfiguredError(
      'Square client not configured for this location',
      ctx.locationId,
    );
  }

  const listPage = await client.cards.list({ customerId, sortOrder: 'ASC' });
  const cards = listPage.data ?? [];
  const cardBelongsToCustomer = cards.some(c => c.id === cardId);
  if (!cardBelongsToCustomer) {
    // Typed tenancy-violation error (task #620). The DELETE card
    // route matches this on `instanceof` to map to 403 — see
    // server/routes/payments-provider/cards.ts. Pre-#620 this was a
    // plain `new Error(...)` and the route picked it out via
    // `error.constructor === Error` + a substring check on the
    // message, which would have mapped any other plain Error
    // bubbling out of the provider chain into the same 403.
    throw new CardOwnershipMismatchError();
  }

  await client.cards.disable({ cardId });
}

export async function createOrUpdateCustomer(
  ctx: SquareProviderContext,
  name: string,
  email: string,
  phone?: string | null,
  // Optional `bowler:<id>` reference (task #429). When provided we
  // pass it through as Square's `referenceId` so the seller can see
  // the LeagueVault bowler id directly in the Square dashboard.
  referenceId?: string | null,
): Promise<PaymentCustomer | null> {
  const client = await ctx.getClient();
  if (!client) {
    // POST /customers, the bowler-update sync, the bowler-create
    // sync, and the user-update sync all already catch
    // ProviderNotConfiguredError — the route maps it to 422 and
    // the background syncs log it and continue. Returning null
    // here used to leak as a generic 500 from the customers
    // route. Task #332.
    throw new ProviderNotConfiguredError(
      'Square client not configured for this location',
      ctx.locationId,
    );
  }

  try {
    if (isDev) log.info('Searching for customer with email:', email);
    const searchResponse = await client.customers.search({
      query: {
        filter: {
          emailAddress: {
            exact: email.toLowerCase()
          }
        }
      }
    });

    // v40+ flat-client returns the response body directly (no
    // `.result` wrapper). An undefined response means a transport-
    // level oddity rather than a Square-rejected request — surface
    // it so the catch below maps it to our generic error.
    if (!searchResponse) {
      throw new Error('API Error: Invalid search response');
    }

    let customerId: string;
    const [firstName, ...lastNameParts] = name.split(' ');
    const lastName = lastNameParts.join(' ');
    const phoneNumber = phone || undefined;
    // Only include referenceId in the payload when a non-empty value
    // was supplied. Sending `referenceId: undefined` is a no-op, but
    // sending `null` would CLEAR an existing reference on the Square
    // side — which we never want from this code path.
    const referenceIdField =
      referenceId && referenceId.trim().length > 0
        ? { referenceId: referenceId.trim() }
        : {};

    if (searchResponse.customers?.[0]?.id) {
      if (isDev) log.info('Found existing customer, updating...');
      customerId = searchResponse.customers[0].id;
      // v40+ folds the customerId into the request body itself.
      const updateResponse = await client.customers.update({
        customerId,
        givenName: firstName,
        familyName: lastName || '',
        emailAddress: email.toLowerCase(),
        ...(phoneNumber && { phoneNumber }),
        ...referenceIdField,
      });

      if (!updateResponse?.customer) {
        throw new Error('API Error: Invalid update response');
      }

      if (isDev) log.info('Customer updated successfully:', updateResponse.customer.id);
    } else {
      if (isDev) log.info('No existing customer found, creating new...');
      const customerResponse = await client.customers.create({
        // Same centralised builder as saveCardOnFile (task #671):
        // Square's customers.create endpoint shares the 45-char cap,
        // and the original 40-char SHA-256 slice was equally fragile
        // to a refactor silently dropping the truncation.
        idempotencyKey: buildSquareIdempotencyKey('lv-cust', email.toLowerCase(), name),
        givenName: firstName,
        familyName: lastName || '',
        emailAddress: email.toLowerCase(),
        ...(phoneNumber && { phoneNumber }),
        ...referenceIdField,
      });

      if (!customerResponse?.customer?.id) {
        throw new Error('API Error: Invalid create response');
      }

      customerId = customerResponse.customer.id;
      if (isDev) log.info('New customer created successfully:', customerId);
    }

    return {
      id: customerId,
      name,
      email
    };
  } catch (error) {
    if (error instanceof PaymentProviderError && isHandledPaymentProviderError(error)) {
      log.debug('Customer operation requires customer action', {
        code: error.code,
        disposition: error.disposition,
        providerCode: error.providerCode,
      });
    } else {
      const failure = classifySquareFailure(error);
      if (failure.disposition === 'action_required' || failure.disposition === 'invalid_request') {
        log.debug('Customer operation requires customer action', {
          httpStatus: failure.statusCode,
          squareErrorCode: failure.providerCode,
        });
      } else {
        // Do not include customer name/email or the raw provider payload in
        // this diagnostic; the logger's Sentry path only needs a stable
        // provider classification.
        log.error('Customer operation failed', {
          httpStatus: failure.statusCode,
          squareErrorCode: failure.providerCode,
        });
      }
    }
    throw new Error(
      'Failed to create/update Square customer: ' + (error instanceof Error ? error.message : String(error)),
      { cause: error },
    );
  }
}

/**
 * Delete a Square customer record. Used by the automated account-data
 * deletion flow. Square responds with NOT_FOUND for unknown customers;
 * we swallow that to keep this idempotent.
 */
export async function deleteCustomer(
  ctx: SquareProviderContext,
  customerId: string,
): Promise<void> {
  const client = await ctx.getClient();
  if (!client) {
    // Account-deletion explicitly catches PNCE and records
    // `error: '<message>'` on the per-target audit summary so
    // operators can see "Square wasn't connected for that
    // location" rather than a vague provider failure.
    // Task #332.
    throw new ProviderNotConfiguredError(
      'Square client not configured for this location',
      ctx.locationId,
    );
  }
  try {
    await client.customers.delete({ customerId });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/NOT_FOUND|not found/i.test(msg)) {
      if (isDev) log.info('Square customer already absent, treating as deleted', { customerId });
      return;
    }
    throw error;
  }
}

export function validateCardId(cardId: string | null): boolean {
  if (!cardId) return false;
  return cardId.startsWith('ccof:');
}
