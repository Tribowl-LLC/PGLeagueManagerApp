import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { Link, useParams } from "wouter";
import { ErrorBoundary } from "@/components/error-boundary";
import { Layout } from "@/components/layout";
import { PageErrorState, PageLoadingState } from "@/components/page-states";
import { LeagueOccurrenceScheduleCard } from "@/pages/league-view-page/league-occurrence-schedule-card";
import { getSeasonLabel } from "@shared/season-utils";
import type { ApiResponse, League, User } from "@shared/schema";

export default function LeagueSchedulePage() {
  const params = useParams();
  const leagueId = Number(params.leagueId);
  const validLeagueId = Number.isSafeInteger(leagueId) && leagueId > 0;

  const leagueQuery = useQuery<ApiResponse<League>>({
    queryKey: [`/api/leagues/${leagueId}`],
    enabled: validLeagueId,
    retry: false,
  });
  const userQuery = useQuery<ApiResponse<User>>({
    queryKey: ["/api/user"],
    staleTime: 5 * 60 * 1000,
  });

  if (!validLeagueId) {
    return <Layout><PageErrorState message="League not found" /></Layout>;
  }
  if (leagueQuery.isLoading || userQuery.isLoading) {
    return <Layout><PageLoadingState /></Layout>;
  }
  if (leagueQuery.isError || !leagueQuery.data?.data) {
    return (
      <Layout>
        <PageErrorState message="The league schedule could not be loaded." onRetry={() => leagueQuery.refetch()} />
      </Layout>
    );
  }

  const league = leagueQuery.data.data;

  return (
    <Layout>
      <ErrorBoundary level="section">
        <div className="space-y-6">
          <Link
            href={`/leagues/${leagueId}`}
            className="flex items-center text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="mr-2 size-4" />
            Back to {league.name}
          </Link>

          <div>
            <h1 className="text-2xl font-bold">League Schedule</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {league.name} · {getSeasonLabel(league.seasonStart, league.seasonEnd)}
            </p>
          </div>

          {league.organizationId && (
            <LeagueOccurrenceScheduleCard
              leagueId={leagueId}
              organizationId={league.organizationId}
              viewerRole={userQuery.data?.data?.role}
            />
          )}
        </div>
      </ErrorBoundary>
    </Layout>
  );
}
