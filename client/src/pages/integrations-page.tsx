import { useMemo } from "react";
import { useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { ErrorBoundary } from "@/components/error-boundary";
import { Label } from "@/components/ui/label";
import type { ApiResponse, Location, User } from "@shared/schema";
import { SquareSection } from "@/components/square-integration-section";

interface IntegrationsContentProps {
  orgId: number;
  highlightLocationId: number | null;
}

function IntegrationsContent({ orgId, highlightLocationId }: IntegrationsContentProps) {
  return (
    <div className="space-y-6 max-w-2xl">
      <SquareSection orgId={orgId} highlightLocationId={highlightLocationId} />
    </div>
  );
}

export default function IntegrationsPage() {
  const { data: currentUserResponse } = useQuery<ApiResponse<User>>({
    queryKey: ["/api/user"],
    staleTime: 1000 * 60 * 5,
  });

  const currentUser = currentUserResponse?.data;
  // Read the optional `?location=<id>` deep-link query param emitted by
  // the checkout's "not configured" alert / toast (tasks #582, #583).
  // Only accept positive integers — anything else is ignored so the page
  // still loads cleanly when the link is malformed (task #584).
  const search = useSearch();
  const highlightLocationId = useMemo(() => {
    const raw = new URLSearchParams(search).get("location");
    if (!raw) return null;
    if (!/^\d+$/.test(raw)) return null;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }, [search]);

  // When a deep link is present, look up the location so the location-specific
  // panel can open. The business context itself is never selected by the
  // browser.
  const { data: highlightLocationResponse } = useQuery<ApiResponse<Location>>({
    queryKey: ["/api/locations", highlightLocationId],
    queryFn: async () => {
      const res = await fetch(`/api/locations/${highlightLocationId}`, { credentials: "include" });
      if (!res.ok) throw new Error(`Failed to fetch location: ${res.status}`);
      return res.json();
    },
    enabled: highlightLocationId != null,
    staleTime: 1000 * 60 * 5,
    retry: false,
  });

  const highlightLocationOrgId = highlightLocationResponse?.data?.organizationId ?? null;

  const effectiveOrgId = currentUser?.organizationId ?? highlightLocationOrgId ?? null;

  return (
    <Layout>
      <ErrorBoundary level="section">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Integrations</h1>
        <p className="text-muted-foreground mt-1">
          Configure payment-provider connections for your organization.
        </p>
      </div>

      {!effectiveOrgId ? (
        <div className="text-muted-foreground text-sm">
          No business context found.
        </div>
      ) : (
        <IntegrationsContent
          key={effectiveOrgId}
          orgId={effectiveOrgId}
          highlightLocationId={highlightLocationId}
        />
      )}
      </ErrorBoundary>
    </Layout>
  );
}
