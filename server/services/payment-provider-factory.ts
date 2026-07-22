import type { PaymentProvider } from './payment-provider';
import { SquarePaymentProvider } from './square-provider';
import { storage } from '../storage';
import { createLogger } from '../logger';
import { isDev } from '../config';
import {
  ProviderNotConfiguredError,
  PaymentProviderError,
  CardOwnershipMismatchError,
  GENERIC_PAYMENT_USER_MESSAGE,
  sanitizePaymentUserMessage,
} from './payment-errors';

// Re-exported here for backwards compatibility — these used to be
// declared in this file before the circular-import extraction.
export {
  ProviderNotConfiguredError,
  PaymentProviderError,
  CardOwnershipMismatchError,
  GENERIC_PAYMENT_USER_MESSAGE,
  sanitizePaymentUserMessage,
};

const log = createLogger('PaymentProviderFactory');

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  provider: PaymentProvider;
  expiresAt: number;
}

const providerCache = new Map<number, CacheEntry>();

export async function getPaymentProvider(locationId: number | null): Promise<PaymentProvider> {
  if (locationId == null) {
    throw new ProviderNotConfiguredError(
      'No location ID provided — payment provider cannot be resolved',
      locationId,
    );
  }

  const now = Date.now();
  const cached = providerCache.get(locationId);
  if (cached && cached.expiresAt > now) {
    return cached.provider;
  }

  const location = await storage.getLocation(locationId);
  if (!location) {
    throw new ProviderNotConfiguredError(
      `Location ${locationId} not found`,
      locationId,
    );
  }

  const provider: PaymentProvider = new SquarePaymentProvider(locationId);

  providerCache.set(locationId, { provider, expiresAt: now + CACHE_TTL_MS });
  return provider;
}

export function clearProviderCache(locationId?: number): void {
  if (locationId !== undefined) {
    providerCache.delete(locationId);
    if (isDev) log.info(`Cleared payment provider cache for location ${locationId}`);
  } else {
    providerCache.clear();
    if (isDev) log.info('Cleared entire payment provider cache');
  }
}
