import { useQuery } from "@tanstack/react-query";

interface BusinessBranding {
  id: number;
  name: string;
  slug: string;
  logo: string | null;
  darkLogo: string | null;
}

export const BUSINESS_CONTEXT_QUERY_KEY = ["/api/org-context"] as const;

/** Public branding/environment context. It never derives a business from the URL. */
export function useBusinessContext() {
  const { data, isLoading } = useQuery<{ success: boolean; data: BusinessBranding | null }>({
    queryKey: BUSINESS_CONTEXT_QUERY_KEY,
    staleTime: 1000 * 60 * 60,
  });

  return {
    business: data?.data ?? null,
    isLoading,
  };
}
