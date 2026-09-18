import { useQuery } from '@tanstack/react-query';
import type { ApiResponse, Organization } from '@shared/schema';

export const BUSINESS_CONTEXT_QUERY_KEY = ['/api/business-settings'] as const;

export function useBusinessContext() {
  const { data, isLoading, error, refetch } = useQuery<ApiResponse<Organization>>({
    queryKey: BUSINESS_CONTEXT_QUERY_KEY,
    staleTime: 1000 * 60 * 5,
  });

  return {
    business: data?.data ?? null,
    isLoading,
    error,
    refetch,
  };
}
