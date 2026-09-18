import { useQuery } from '@tanstack/react-query';
import type { ApiResponse, Organization } from '@shared/schema';

export const BUSINESS_SETTINGS_QUERY_KEY = ['/api/business-settings'] as const;

/** Private Owner-only organization fields used by Business Settings. */
export function useBusinessSettings() {
  const { data, isLoading, error, refetch } = useQuery<ApiResponse<Organization>>({
    queryKey: BUSINESS_SETTINGS_QUERY_KEY,
    staleTime: 1000 * 60 * 5,
  });

  return {
    business: data?.data ?? null,
    isLoading,
    error,
    refetch,
  };
}
