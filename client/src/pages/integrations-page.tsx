import { useMemo, useState } from "react";
import { useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { ErrorBoundary } from "@/components/error-boundary";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ApiResponse, Location, Organization, User } from "@shared/schema";
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
  const isSystemAdmin = currentUser?.role === "system_admin";

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

  const [selectedOrgId, setSelectedOrgId] = useState<number | null>(null);

  // When a deep link is present, look up the location so we can route a
  // system admin to the correct organization automatically (regular admins
  // only ever see their own org). The query is non-blocking: a 404 / 403 /
  // network error just leaves the page on the user's default org so the
  // page "still loads cleanly with no error" per the task spec.
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

  // For system admins following a `?location=<id>` deep link, default the
  // org selection to the location's owning org so they don't have to hunt
  // for it in the dropdown. Derived during render rather than stored via an
  // effect: `selectedOrgId` stays null until the admin makes a manual
  // choice, and `effectiveOrgId` falls back to the deep-linked org until
  // then — so a manual choice always wins and navigating back never snaps.
  const effectiveOrgId = isSystemAdmin
    ? (selectedOrgId ?? highlightLocationOrgId ?? currentUser?.organizationId ?? null)
    : (currentUser?.organizationId ?? null);

  const { data: orgsResponse } = useQuery<ApiResponse<Organization[]>>({
    queryKey: ["/api/organizations"],
    enabled: isSystemAdmin,
    staleTime: 1000 * 60 * 5,
  });

  const orgList = orgsResponse?.data ?? [];

  return (
    <Layout>
      <ErrorBoundary level="section">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Integrations</h1>
        <p className="text-muted-foreground mt-1">
          Configure payment-provider connections for your organization.
        </p>
      </div>

      {isSystemAdmin && orgList.length > 0 && (
        <div className="mb-6 max-w-2xl">
          <Label htmlFor="org-select" className="text-sm font-medium mb-2 block">
            Organization
          </Label>
          <Select
            value={effectiveOrgId ? String(effectiveOrgId) : ""}
            onValueChange={(val) => {
              setSelectedOrgId(Number(val));
            }}
          >
            <SelectTrigger id="org-select" className="w-64">
              <SelectValue placeholder="Select an organization..." />
            </SelectTrigger>
            <SelectContent>
              {orgList.map((org) => (
                <SelectItem key={org.id} value={String(org.id)}>
                  {org.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {!effectiveOrgId ? (
        <div className="text-muted-foreground text-sm">
          {isSystemAdmin ? "Select an organization above to manage its integrations." : "No organization context found."}
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
