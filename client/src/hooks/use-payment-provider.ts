import { useEffect, useRef, useState } from "react";
import type { RequiredSquareField } from "@shared/schema";

export type RequiredProviderField = RequiredSquareField;

export interface PaymentProviderConfig {
  appId?: string;
  locationId?: string;
  providerConfigured?: boolean;
  missingFields?: RequiredProviderField[];
}

interface UsePaymentProviderReturn {
  config: PaymentProviderConfig | null;
  isLoading: boolean;
  error: string | null;
  isSquare: true;
  supportsWallets: true;
  isProviderConfigured: boolean;
  missingFields: RequiredProviderField[];
}

interface CacheEntry {
  config: PaymentProviderConfig;
  timestamp: number;
}

const CONFIG_CACHE_TTL_MS = 5 * 60 * 1000;
const configCache = new Map<string, CacheEntry>();

export function usePaymentProvider(locationId?: number | null): UsePaymentProviderReturn {
  const [config, setConfig] = useState<PaymentProviderConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const cacheKey = String(locationId ?? 'default');
    const cached = configCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CONFIG_CACHE_TTL_MS) {
      setConfig(cached.config);
      setIsLoading(false);
      setError(null);
      return;
    }

    setIsLoading(true);
    setError(null);
    const url = locationId
      ? `/api/payments-provider/config?locationId=${locationId}`
      : '/api/payments-provider/config';

    fetch(url, { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) throw new Error('Failed to fetch Square configuration');
        const data = await res.json();
        const nextConfig: PaymentProviderConfig = {
          appId: data.appId,
          locationId: data.locationId,
          providerConfigured: data.providerConfigured,
          missingFields: Array.isArray(data.missingFields) ? data.missingFields : undefined,
        };
        configCache.set(cacheKey, { config: nextConfig, timestamp: Date.now() });
        if (mountedRef.current) {
          setConfig(nextConfig);
          setIsLoading(false);
        }
      })
      .catch((err) => {
        if (mountedRef.current) {
          setError(err instanceof Error ? err.message : 'Failed to load Square configuration');
          setIsLoading(false);
        }
      });
  }, [locationId]);

  return {
    config,
    isLoading,
    error,
    isSquare: true,
    supportsWallets: true,
    isProviderConfigured: config?.providerConfigured !== false,
    missingFields: config?.missingFields ?? [],
  };
}

export function clearProviderConfigCache(): void {
  configCache.clear();
}
