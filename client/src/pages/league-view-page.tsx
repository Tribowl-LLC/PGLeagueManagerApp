import { useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { ErrorBoundary } from "@/components/error-boundary";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Loader2, Mail, RefreshCw } from "lucide-react";
import { PageLoadingState, PageErrorState } from "@/components/page-states";

import type { ApiResponse, League, User } from "@shared/schema";
import { useParams, Link, useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { getSeasonLabel } from "@shared/season-utils";
import { InviteResultCard } from "./league-view-page/invite-result-card";
import { LeagueActionCards } from "./league-view-page/league-action-cards";
import { SeasonHistoryCard } from "./league-view-page/season-history-card";
import { NewSeasonDialog, type NewSeasonFormValues } from "./league-view-page/new-season-dialog";
import { LeagueOccurrenceScheduleCard } from "./league-view-page/league-occurrence-schedule-card";
import {
  LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION_3,
  type AnyLeagueSetupIntegrationResult,
} from "@shared/league-setup-integration";
import { createSetupIdempotencyKeyRetainer } from "./league-view-page/fall-draft-secure-id";

export default function LeagueViewPage() {
  const params = useParams();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const leagueId = parseInt(params.leagueId!);
  const [inviteResult, setInviteResult] = useState<{ sent: number; alreadyRegistered: number; noEmail: number } | null>(null);
  const [showNewSeason, setShowNewSeason] = useState(false);
  const newSeasonSetupIdempotency = useRef(createSetupIdempotencyKeyRetainer());

  const { data: leagueResponse, isLoading, error, refetch } = useQuery<{ success: true; data: League }>({
    queryKey: [`/api/leagues/${leagueId}`],
    queryFn: async () => {
      const response = await fetch(`/api/leagues/${leagueId}`);
      if (!response.ok) {
        throw new Error('Failed to fetch league');
      }
      return response.json();
    },
    retry: false
  });

  const league = leagueResponse?.data;

  const { data: currentUserResponse } = useQuery<ApiResponse<User>>({
    queryKey: ['/api/user'],
    staleTime: 5 * 60 * 1000,
  });
  const currentUser = currentUserResponse?.data;
  const canManageLeague = currentUser?.role === "system_admin" || currentUser?.role === "org_admin";
  const isReadOnlyArchive = league !== undefined && (!league.active || league.scheduleAuthority === "retired_legacy");

  const { data: seasonHistoryResponse } = useQuery<{ success: true; data: League[] }>({
    queryKey: ['/api/leagues', leagueId, 'season-history'],
    queryFn: async () => {
      const response = await fetch(`/api/leagues/${leagueId}/season-history`);
      if (!response.ok) throw new Error('Failed to fetch season history');
      return response.json();
    },
    enabled: !!league,
  });
  const seasonHistory = seasonHistoryResponse?.data || [];

  const newSeasonMutation = useMutation({
    mutationFn: async (values: NewSeasonFormValues) => {
      const organizationScope = league?.organizationId ?? null;
      const querySuffix = currentUser?.role === "system_admin" && organizationScope !== null
        ? `?organizationId=${organizationScope}`
        : "";
      return await apiRequest<AnyLeagueSetupIntegrationResult>(`/api/leagues/${leagueId}/new-season${querySuffix}`, "POST", {
        ...values,
        setupIntegration: {
          contractVersion: LEAGUE_SETUP_INTEGRATION_REQUEST_VERSION_3,
          idempotencyKey: newSeasonSetupIdempotency.current.keyFor({
            sourceLeagueId: leagueId,
            organizationId: organizationScope,
            ...values,
          }),
        },
      });
    },
    onSuccess: (data) => {
      const newLeague = data.data;
      newSeasonSetupIdempotency.current.reset();
      queryClient.invalidateQueries({ queryKey: ["/api/leagues"] });
      toast({
        title: "New Season Created",
        description: "canonicalSchedule" in newLeague
          ? `${league?.name} new season and its canonical schedule were published. The previous season has been archived.`
          : `${league?.name} new season has been created. The previous season has been archived.`,
      });
      setShowNewSeason(false);
      setLocation(`/leagues/${newLeague.id}`);
    },
    onError: (error: Error) => {
      toast({
        title: "New season setup failed",
        description: error.message || "No new season or canonical schedule was created.",
        variant: "destructive",
      });
    },
  });

  const sendInvitesMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest<{ sent: number; alreadyRegistered: number; noEmail: number }>(
        `/api/leagues/${leagueId}/send-invites`,
        "POST"
      );
    },
    onSuccess: (data) => {
      const result = data.data;
      setInviteResult(result);
      toast({
        title: "Invites Sent",
        description: `Sent ${result.sent} invite(s). ${result.alreadyRegistered} already registered. ${result.noEmail} have no email.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to send invites",
        variant: "destructive",
      });
    },
  });

  if (isLoading) {
    return (
      <Layout>
        <PageLoadingState />
      </Layout>
    );
  }

  if (error) {
    return (
      <Layout>
        <PageErrorState message={`Error loading league: ${error instanceof Error ? error.message : 'Unknown error occurred'}`} onRetry={() => refetch()} />
      </Layout>
    );
  }

  if (!league) {
    return (
      <Layout>
        <div className="text-center">
          <h2 className="text-xl font-semibold text-destructive">League not found</h2>
          <p className="text-muted-foreground">The requested league could not be found</p>
          <Link href="/leagues" className="text-primary hover:underline mt-4 inline-block">
            Return to Leagues
          </Link>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <ErrorBoundary level="section">
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">{league.name}</h1>
            {league.seasonStart && league.seasonEnd && (
              <p className="text-sm text-muted-foreground mt-1">
                {getSeasonLabel(league.seasonStart, league.seasonEnd)}
                {!league.active && <Badge variant="secondary" className="ml-2">Archived</Badge>}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
          {canManageLeague && !isReadOnlyArchive && <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" disabled={sendInvitesMutation.isPending}>
                {sendInvitesMutation.isPending ? (
                  <Loader2 className="size-4 mr-2 animate-spin" />
                ) : (
                  <Mail className="size-4 mr-2" />
                )}
                Send Registration Invites
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Send Registration Invites</AlertDialogTitle>
                <AlertDialogDescription>
                  This will send registration emails to all bowlers in this league who have an email address but don't have an account yet. Bowlers who already have accounts will be skipped.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => sendInvitesMutation.mutate()}>
                  Send Invites
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>}
          </div>
        </div>

        {isReadOnlyArchive && (
          <div role="status" className="rounded-md border border-muted bg-muted/30 px-4 py-3 text-sm">
            <div className="font-medium">Read-only archive</div>
            <div className="text-muted-foreground">This league is retained for history. Editing, invites, roster changes, and restoration are unavailable.</div>
          </div>
        )}

        {inviteResult && <InviteResultCard inviteResult={inviteResult} />}

        <ErrorBoundary level="section">
          <LeagueActionCards leagueId={leagueId} canManageRoster={canManageLeague && !isReadOnlyArchive} />
        </ErrorBoundary>

        {league.organizationId && (
          <ErrorBoundary level="section">
            <LeagueOccurrenceScheduleCard
              leagueId={leagueId}
              organizationId={league.organizationId}
              viewerRole={currentUser?.role}
              readOnlyArchive={isReadOnlyArchive}
            />
          </ErrorBoundary>
        )}

        <ErrorBoundary level="section">
        {league.active && canManageLeague && (
          <div className="flex justify-end">
            <Button variant="outline" onClick={() => setShowNewSeason(true)}>
              <RefreshCw className="size-4 mr-2" />
              Start New Season
            </Button>
          </div>
        )}

        {seasonHistory.length > 1 && (
          <SeasonHistoryCard seasonHistory={seasonHistory} leagueId={leagueId} />
        )}

        {canManageLeague && !isReadOnlyArchive && <NewSeasonDialog
            league={league}
            showNewSeason={showNewSeason}
            setShowNewSeason={setShowNewSeason}
            onCreate={(values) => newSeasonMutation.mutate(values)}
            isPending={newSeasonMutation.isPending}
            isSystemAdmin={currentUser?.role === "system_admin"}
          />}
        </ErrorBoundary>
      </div>
      </ErrorBoundary>
    </Layout>
  );
}
