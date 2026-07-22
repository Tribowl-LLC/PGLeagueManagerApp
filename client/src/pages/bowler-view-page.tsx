import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, Link, useSearch } from "wouter";
import { Layout } from "@/components/layout";
import { ErrorBoundary } from "@/components/error-boundary";
import { ArrowLeft, Pencil } from "lucide-react";
import { PageLoadingState } from "@/components/page-states";
import { Button } from "@/components/ui/button";
import { BowlerForm } from "@/components/bowler-form";
import type { User } from "@shared/schema";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import type { Payment, BowlerDetailsResponse, ApiResponse } from "@shared/schema";
import { calculateBowlerViewFinancials } from "@/lib/financial-utils";
import { filterActiveBowlerLeagues } from "@/lib/bowler-league-utils";
import { BowlerFinancialSummary } from "@/components/bowler-financial-summary";
import { BowlerPaymentHistoryTable } from "@/components/bowler-payment-history-table";
import { PaymentSyncRetryStatus } from "@/components/payment-sync-retry-status";
import { AdminBowlerLinkPanel } from "@/components/admin-bowler-link-panel";

export default function BowlerViewPage() {
  const params = useParams();
  const bowlerId = parseInt(params.bowlerId!);
  const [selectedLeagueId, setSelectedLeagueId] = useState<number | null>(null);
  const [showEditDialog, setShowEditDialog] = useState(false);

  const { data: currentUserResponse } = useQuery<ApiResponse<User>>({
    queryKey: ["/api/user"],
    staleTime: 1000 * 60 * 5,
  });
  const currentUserRole = currentUserResponse?.data?.role;
  const canEditBowler = currentUserRole === "system_admin" || currentUserRole === "org_admin";

  const search = useSearch();
  const explicitBackLink = useMemo(() => {
    const params = new URLSearchParams(search);
    const from = params.get("from");
    const fromLeagueId = params.get("fromLeagueId");
    const fromTeamId = params.get("fromTeamId");
    switch (from) {
      case "bowlers":
        return { href: "/bowlers", label: "Back to Bowlers", testid: "link-back-to-bowlers" };
      case "past-due":
        return { href: "/reports/past-due", label: "Back to Past Due", testid: "link-back-to-past-due" };
      case "league-past-due":
        return fromLeagueId && /^\d+$/.test(fromLeagueId)
          ? { href: `/reports/leagues/${fromLeagueId}/past-due`, label: "Back to Past Due", testid: "link-back-to-league-past-due" }
          : null;
      case "weekly-payments":
        return fromLeagueId && /^\d+$/.test(fromLeagueId)
          ? { href: `/leagues/${fromLeagueId}/weekly-payments`, label: "Back to Weekly Payments", testid: "link-back-to-weekly-payments" }
          : null;
      case "team":
        return fromTeamId && /^\d+$/.test(fromTeamId)
          ? { href: `/teams/${fromTeamId}`, label: "Back to Team", testid: "link-back-to-team" }
          : null;
      case "home":
        return { href: "/home", label: "Back to Dashboard", testid: "link-back-to-home" };
      default:
        return null;
    }
  }, [search]);

  const { data: detailsResponse, isLoading: loadingDetails } = useQuery<ApiResponse<BowlerDetailsResponse>>({
    queryKey: [`/api/bowlers/${bowlerId}/details`],
    staleTime: 1000 * 60 * 5,
    retry: false,
    enabled: !isNaN(bowlerId),
  });

  const bowler = detailsResponse?.data?.bowler;
  const detailsLeagues = useMemo(() => detailsResponse?.data?.leagues || [], [detailsResponse?.data?.leagues]);
  const detailsTeams = useMemo(() => detailsResponse?.data?.teams || [], [detailsResponse?.data?.teams]);

  const bowlerLeagues = useMemo(() => {
    const allLeagues = detailsResponse?.data?.bowlerLeagues || [];
    return filterActiveBowlerLeagues(allLeagues, bowlerId);
  }, [detailsResponse?.data?.bowlerLeagues, bowlerId]);

  // Default to the bowler's first active league until the user picks one
  // from the dropdown. Derived during render rather than seeded by an
  // effect: `selectedLeagueId` holds only an explicit user choice, and
  // `effectiveLeagueId` falls back to the first league in the meantime.
  const effectiveLeagueId = selectedLeagueId ?? bowlerLeagues[0]?.leagueId ?? null;

  const selectedAssociation = useMemo(() => {
    return bowlerLeagues.find(bl =>
      bl.leagueId === effectiveLeagueId &&
      bl.active &&
      bl.bowlerId === bowlerId
    );
  }, [bowlerLeagues, effectiveLeagueId, bowlerId]);

  const team = useMemo(() => {
    if (!selectedAssociation?.teamId) return undefined;
    return detailsTeams.find(t => t.id === selectedAssociation.teamId);
  }, [detailsTeams, selectedAssociation?.teamId]);

  const league = useMemo(() => {
    if (!effectiveLeagueId) return undefined;
    return detailsLeagues.find(l => l.id === effectiveLeagueId);
  }, [detailsLeagues, effectiveLeagueId]);

  const { data: paymentsResponse } = useQuery<ApiResponse<Payment[]>>({
    queryKey: ["/api/payments", { bowlerId, leagueId: effectiveLeagueId }],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams();
      params.set("bowlerId", String(bowlerId));
      params.set("leagueId", String(effectiveLeagueId));
      const response = await fetch(`/api/payments?${params.toString()}`, {
        credentials: "include",
        headers: { "Accept": "application/json" },
        signal,
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData?.error?.message || "Failed to fetch payments");
      }
      return response.json();
    },
    enabled: !!effectiveLeagueId && !!bowlerId,
    staleTime: 1000 * 60,
    retry: false,
  });

  const payments = paymentsResponse?.data || [];

  if (loadingDetails) {
    return <Layout><PageLoadingState /></Layout>;
  }

  if (!bowler) {
    return <Layout><div className="text-center">Bowler not found</div></Layout>;
  }

  const financials = calculateBowlerViewFinancials(league, payments);

  return (
    <Layout>
      <div className="mb-6">
        {explicitBackLink ? (
          <Link
            href={explicitBackLink.href}
            className="text-muted-foreground hover:text-foreground flex items-center mb-4"
            data-testid={explicitBackLink.testid}
          >
            <ArrowLeft className="size-4 mr-2" />
            {explicitBackLink.label}
          </Link>
        ) : selectedAssociation ? (
          <Link
            href={`/teams/${selectedAssociation.teamId}`}
            className="text-muted-foreground hover:text-foreground flex items-center mb-4"
            data-testid="link-back-to-team"
          >
            <ArrowLeft className="size-4 mr-2" />
            Back to Team
          </Link>
        ) : null}
        <div className="flex flex-col gap-2 mb-6">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl font-bold">{bowler?.name}</h1>
            <Badge variant={bowler?.active ? "default" : "secondary"}>
              {bowler?.active ? "Active" : "Inactive"}
            </Badge>
            {canEditBowler && bowler && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowEditDialog(true)}
                data-testid="button-edit-bowler"
              >
                <Pencil className="size-4 mr-2" />
                Edit Bowler
              </Button>
            )}
            {bowler && (
              <PaymentSyncRetryStatus
                bowler={bowler}
                invalidateOnSuccess={[
                  [`/api/bowlers/${bowlerId}/details`],
                  ["/api/bowlers"],
                ]}
              />
            )}
          </div>
          <div className="flex flex-col gap-1">
            <Select
              value={effectiveLeagueId?.toString() || ""}
              onValueChange={(value) => setSelectedLeagueId(parseInt(value))}
            >
              <SelectTrigger className="w-[300px]">
                <SelectValue placeholder="Select a league" />
              </SelectTrigger>
              <SelectContent>
                {bowlerLeagues.map((bl) => {
                  const leagueInfo = detailsLeagues?.find(l => l.id === bl.leagueId);
                  return leagueInfo ? (
                    <SelectItem key={bl.leagueId} value={bl.leagueId.toString()}>
                      {leagueInfo.name}
                    </SelectItem>
                  ) : null;
                })}
              </SelectContent>
            </Select>
            {team && (
              <div className="font-medium text-muted-foreground">{team.name}</div>
            )}
          </div>
        </div>

        <ErrorBoundary level="section">
          <BowlerFinancialSummary league={league} financials={financials} />
        </ErrorBoundary>
      </div>

      <ErrorBoundary level="section">
        <BowlerPaymentHistoryTable
          payments={payments}
          locationId={league?.locationId ?? null}
        />
      </ErrorBoundary>

      {canEditBowler && bowler && (
        <ErrorBoundary level="section">
          <AdminBowlerLinkPanel bowlerId={bowler.id} organizationId={bowler.organizationId ?? null} />
        </ErrorBoundary>
      )}

      {bowler && (
        <BowlerForm
          key={`edit-${bowler.id}`}
          open={showEditDialog}
          bowler={bowler}
          onClose={() => setShowEditDialog(false)}
        />
      )}
    </Layout>
  );
}
