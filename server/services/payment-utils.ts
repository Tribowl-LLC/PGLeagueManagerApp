import type { Bowler } from "@shared/schema";
import type { PaymentProvider } from "./payment-provider";
import { storage } from "../storage";
import { createLogger } from "../logger";

const log = createLogger('PaymentUtils');

export function getProviderCustomerId(bowler: Bowler, _provider: PaymentProvider): string | undefined {
  return bowler.paymentCustomerId || undefined;
}

/**
 * Guarantee that the bowler has a Square customer id before a
 * save-card, list-cards, or remove-card round trip.
 */
export async function ensureProviderCustomer(
  provider: PaymentProvider,
  bowler: Bowler,
): Promise<string | undefined> {
  const existing = getProviderCustomerId(bowler, provider);
  if (existing) return existing;
  if (!bowler.email) return undefined;

  try {
    const customer = await provider.createOrUpdateCustomer(
      bowler.name,
      bowler.email,
      bowler.phone ?? null,
      `bowler:${bowler.id}`,
    );
    if (!customer?.id) return undefined;

    try {
      await storage.updateBowler(bowler.id, {
        paymentCustomerId: customer.id,
        paymentProviderLocationId: provider.locationId,
      });
    } catch (writeErr) {
      log.error('Failed to persist provider customer ID on bowler:', writeErr);
    }
    return customer.id;
  } catch (err) {
    log.warn('ensureProviderCustomer: createOrUpdateCustomer failed', {
      bowlerId: bowler.id,
      providerName: provider.providerName,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
