import { createLogger } from '../logger';
import { isDev } from '../config';
import {
  ProviderNotConfiguredError,
  PaymentProviderError,
  CardOwnershipMismatchError,
} from './payment-errors';
import {
  getSquareErrorCtor,
  buildSquareIdempotencyKey,
  type SquareProviderContext,
} from './square-client';
import type {
  SavedCard,
  PaymentCustomer,
} from './payment-provider';

const log = createLogger("SquareService");

export async function saveCardOnFile(
  ctx: SquareProviderContext,
  sourceId: string,
  customerId: string,
): Promise<SavedCard | null> {
  const client = await ctx.getClient();
  if (!client) {
    // Throw the structured "not configured" error so the
    // POST /cards/:bowlerId route surfaces 422
    // PROVIDER_NOT_CONFIGURED. The opportunistic save-card
    // call inside POST /payments wraps this in a try/catch
    // that just logs, so it stays non-fatal there. Task #332.
    throw new ProviderNotConfiguredError(
      'Square client not configured for this location',
      ctx.locationId,
    );
  }

  try {
    if (isDev) log.info('Saving card on file for customer:', customerId.substring(0, 10) + '...');
    const response = await client.cards.create({
      // Use the centralised builder so we can never silently
      // re-introduce the >45-char idempotency_key bug that broke
      // every save-card call after the v40 SDK migration (task
      // #671). The format is deterministic per (sourceId, customerId)
      // so post-deploy retries still dedupe inside Square's window.
      idempotencyKey: buildSquareIdempotencyKey('lv-card', sourceId, customerId),
      sourceId,
      card: {
        customerId,
      },
    });

    const card = response.card;
    if (card?.id) {
      return { id: card.id, last4: card.last4 ?? '', brand: card.cardBrand ?? '' };
    }
    return null;
  } catch (error) {
    log.error('Failed to save card on file:', error instanceof Error ? error.message : error);
    // Re-throw as a typed PaymentProviderError so the standalone
    // POST /api/cards/:bowlerId route surfaces a real `userMessage`
    // / `code` via buildPaymentErrorResponse instead of the generic
    // "Failed to save card on file" 500 (task #671). The opportunistic
    // save-card call inside POST /payments wraps the throw in its own
    // try/catch (charges.ts ~309) so it stays non-fatal there — the
    // payment still completes; we just don't get a saved card.
    if (
      error instanceof PaymentProviderError ||
      error instanceof ProviderNotConfiguredError
    ) {
      throw error;
    }
    const apiErr = error instanceof getSquareErrorCtor() ? error : null;
    const detail = apiErr?.errors?.[0]?.detail;
    if (apiErr?.statusCode === 400) {
      throw new PaymentProviderError(
        'Invalid payment information. Please check your card details and try again.',
        'INVALID_REQUEST',
        detail,
      );
    }
    if (apiErr?.statusCode === 401) {
      throw new PaymentProviderError(
        'Payment system is temporarily unavailable. Please try again later.',
        'SYSTEM_ERROR',
        detail,
      );
    }
    throw new PaymentProviderError(
      'Could not save card on file. Please try again.',
      'SAVE_CARD_FAILED',
      detail,
    );
  }
}

export async function listCardsOnFile(
  ctx: SquareProviderContext,
  customerId: string,
): Promise<SavedCard[]> {
  const client = await ctx.getClient();
  if (!client) {
    // Intentionally degraded: GET /cards/:bowlerId is a read
    // path that already treats "no provider configured" as
    // "no saved cards" and returns []. Throwing here would
    // turn a benign empty list into a 500 in the route's
    // outer catch. Task #332 — kept silent on purpose.
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
    log.error('Failed to list cards on file:', error instanceof Error ? error.message : error);
    return [];
  }
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
    log.error('Customer operation error:', {
      error: error instanceof Error ? {
        name: error.name,
        message: error.message,
        stack: error.stack
      } : error,
      input: { name, email }
    });
    throw new Error('Failed to create/update Square customer: ' + (error instanceof Error ? error.message : String(error)));
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
