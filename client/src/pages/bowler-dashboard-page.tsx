import { useState, useEffect, FC, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { PageLoadingState } from "@/components/page-states";
import { LeagueBottomSheet } from "@/components/league-bottom-sheet";
import { BowlerLayout } from "@/components/bowler-layout";
import { getSeasonLengthWeeks, getWeeksPassedInSeason } from "@/lib/financial-utils";
import { DEFAULT_WEEKLY_FEE_CENTS } from "@shared/schema";
import type { League, Payment, User, Bowler, BowlerLeague, Team, ApiResponse } from "@shared/schema";
import { PaymentStatusSection } from "@/components/payment-status-section";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { ErrorBoundary } from "@/components/error-boundary";
import { useSelectedLeague } from "@/hooks/use-selected-league";
import { ErrorCard } from "./bowler-dashboard-page/error-card";
import { AuthRequiredCard } from "./bowler-dashboard-page/auth-required-card";
import { LeagueUnavailableCard } from "./bowler-dashboard-page/league-unavailable-card";
import { DashboardHero } from "./bowler-dashboard-page/dashboard-hero";
import { BackToDashboardButton } from "./bowler-dashboard-page/back-to-dashboard-button";
import { filterBowlerLeaguesForActiveLeagues } from "@/lib/bowler-league-utils";

const STALE_TIME = 1000 * 60 * 5;

const BowlerDashboardPage: FC = () => {
  const [selectedLeagueId, setSelectedLeagueId] = useSelectedLeague();
  const [sheetOpen, setSheetOpen] = useState(false);

  const { data: userResponse, isLoading: isLoadingUser, error: userError } = useQuery<{ success: boolean; data: User }>({
    queryKey: ['/api/user'],
    staleTime: STALE_TIME,
  });
  const currentUser = userResponse?.data;

  const { data: bowlersResponse, isLoading: isLoadingBowlers, error: bowlersError } = useQuery<ApiResponse<Bowler[]>>({
    queryKey: ['/api/bowlers'],
    enabled: !!currentUser?.bowlerId,
    staleTime: 0,
  });

  const bowler = useMemo(() => {
    if (!currentUser?.bowlerId || !bowlersResponse?.data) return null;
    const found = bowlersResponse.data.find(b => b.id === currentUser.bowlerId);
    return found ?? null;
  }, [bowlersResponse?.data, currentUser?.bowlerId]);

  const { data: bowlerLeaguesResponse, isLoading: isLoadingBL, error: blError } = useQuery<ApiResponse<BowlerLeague[]>>({
    queryKey: ['/api/bowler-leagues'],
    enabled: !!bowler,
    staleTime: STALE_TIME,
    retry: 3,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
  });

  const rosteredBowlerLeagues = useMemo((): BowlerLeague[] => {
    if (!bowler || !bowlerLeaguesResponse?.data) return [];
    return bowlerLeaguesResponse.data.filter(bl => bl.bowlerId === bowler.id && bl.active);
  }, [bowlerLeaguesResponse?.data, bowler]);

  const { data: leaguesResponse, isLoading: isLoadingLeagues, isFetching: isFetchingLeagues, error: leaguesError } = useQuery<ApiResponse<League[]>>({
    queryKey: ['/api/leagues'],
    enabled: rosteredBowlerLeagues.length > 0,
    staleTime: 0,
    retry: 3,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
  });

  const leagueMap = useMemo(() => {
    const map = new Map<number, League>();
    if (leaguesResponse?.data) {
      for (const l of leaguesResponse.data) {
        map.set(l.id, l);
      }
    }
    return map;
  }, [leaguesResponse?.data]);

  const activeBowlerLeagues = useMemo(
    () => filterBowlerLeaguesForActiveLeagues(rosteredBowlerLeagues, leagueMap),
    [rosteredBowlerLeagues, leagueMap]
  );

  const activeBowlerLeague = useMemo((): BowlerLeague | null => {
    if (activeBowlerLeagues.length === 0) return null;
    if (selectedLeagueId) {
      return activeBowlerLeagues.find(bl => bl.leagueId === selectedLeagueId) ?? activeBowlerLeagues[0];
    }
    return activeBowlerLeagues[0];
  }, [activeBowlerLeagues, selectedLeagueId]);

  const league = activeBowlerLeague ? leagueMap.get(activeBowlerLeague.leagueId) : undefined;

  const { data: teamsResponse, isLoading: isLoadingTeams, error: teamsError } = useQuery<ApiResponse<Team[]>>({
    queryKey: ['/api/teams'],
    enabled: rosteredBowlerLeagues.length > 0,
    staleTime: 0,
    retry: 3,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
  });

  const teamMap = useMemo(() => {
    const map = new Map<number, Team>();
    if (teamsResponse?.data) {
      for (const t of teamsResponse.data) {
        map.set(t.id, t);
      }
    }
    return map;
  }, [teamsResponse?.data]);

  const team = activeBowlerLeague?.teamId ? teamMap.get(activeBowlerLeague.teamId) : undefined;

  const leagueName = league?.name ?? "No League";
  const teamName = team?.name ?? "No Team";

  const totalWeeks = useMemo(() => {
    return getSeasonLengthWeeks(league) || 30;
  }, [league]);

  const currentWeek = useMemo(() => {
    if (!league?.seasonStart) return null;
    const weeksPassed = getWeeksPassedInSeason(league);
    return Math.max(1, Math.min(weeksPassed, totalWeeks));
  }, [league, totalWeeks]);

  const totalWeeksMap = useMemo(() => {
    const map = new Map<number, number>();
    for (const bl of activeBowlerLeagues) {
      const l = leagueMap.get(bl.leagueId);
      if (l) map.set(bl.leagueId, getSeasonLengthWeeks(l) || 30);
    }
    return map;
  }, [activeBowlerLeagues, leagueMap]);

  const currentWeekMap = useMemo(() => {
    const map = new Map<number, number | null>();
    for (const bl of activeBowlerLeagues) {
      const l = leagueMap.get(bl.leagueId);
      if (!l?.seasonStart) {
        map.set(bl.leagueId, null);
      } else {
        const tw = totalWeeksMap.get(bl.leagueId) || 30;
        const wp = getWeeksPassedInSeason(l);
        map.set(bl.leagueId, Math.max(1, Math.min(wp, tw)));
      }
    }
    return map;
  }, [activeBowlerLeagues, leagueMap, totalWeeksMap]);

  const weeklyFee = useMemo(() => {
    return league?.weeklyFee || DEFAULT_WEEKLY_FEE_CENTS;
  }, [league]);

  const { data: paymentsResponse, isLoading: isLoadingPayments } = useQuery<ApiResponse<Payment[]>>({
    queryKey: ['/api/payments', bowler?.id],
    enabled: !!bowler?.id,
    staleTime: STALE_TIME,
  });

  const leagueNotYetResolved = rosteredBowlerLeagues.length > 0 && !leaguesResponse;

  const isStillLoadingChain =
    isLoadingUser ||
    isLoadingBowlers ||
    isLoadingBL ||
    isLoadingLeagues ||
    isLoadingTeams ||
    isLoadingPayments ||
    (!!currentUser?.bowlerId && !bowlersResponse) ||
    (!!bowler && !bowlerLeaguesResponse) ||
    (rosteredBowlerLeagues.length > 0 && !leaguesResponse) ||
    (rosteredBowlerLeagues.length > 0 && !teamsResponse) ||
    (leagueNotYetResolved && isFetchingLeagues);

  const handleRetry = () => {
    queryClient.invalidateQueries({ queryKey: ['/api/user'] });
    queryClient.invalidateQueries({ queryKey: ['/api/bowlers'] });
    queryClient.invalidateQueries({ queryKey: ['/api/bowler-leagues'] });
    queryClient.invalidateQueries({ queryKey: ['/api/leagues'] });
    queryClient.invalidateQueries({ queryKey: ['/api/teams'] });
    queryClient.invalidateQueries({ queryKey: ['/api/payments'] });
  };

  const noBowlerProfile = !bowler && !isLoadingUser && !isLoadingBowlers && !userError && !bowlersError && !!currentUser;
  useEffect(() => {
    if (noBowlerProfile) {
      apiRequest('/api/auth/logout', 'POST', {})
        .catch(() => {})
        .finally(() => {
          queryClient.clear();
          window.location.href = '/login';
        });
    }
  }, [noBowlerProfile]);

  if (isStillLoadingChain && !league) {
    return <PageLoadingState message="Loading dashboard data..." />;
  }

  if (userError) {
    return (
      <ErrorCard
        title="Authentication Error"
        description="We couldn't verify your login session. Please try again or log in again."
        onRetry={handleRetry}
      />
    );
  }

  if (!currentUser) {
    return <AuthRequiredCard />;
  }

  if (bowlersError) {
    return (
      <ErrorCard
        title="Failed to Load Bowler Profile"
        description="We couldn't load your bowler information. This may be a temporary issue."
        onRetry={handleRetry}
      />
    );
  }

  if (!bowler) {
    return <PageLoadingState />;
  }

  if (blError || leaguesError || teamsError) {
    return (
      <ErrorCard
        title="Failed to Load League Data"
        description="We found your profile but couldn't load your league information. Please try again."
        onRetry={handleRetry}
      />
    );
  }

  if (!league) {
    return <LeagueUnavailableCard onRetry={handleRetry} />;
  }

  const isSystemAdmin = currentUser?.role === 'system_admin';
  const hasMultipleLeagues = activeBowlerLeagues.length > 1;

  return (
    <BowlerLayout
      bowlerName={bowler.name}
      leagueName={leagueName}
      currentLeagueId={activeBowlerLeague?.leagueId}
    >
      {isSystemAdmin && <BackToDashboardButton />}
      
      <ErrorBoundary level="section">
      <div className="space-y-6">
        <DashboardHero
          bowlerName={bowler.name}
          isSystemAdmin={isSystemAdmin}
          hasMultipleLeagues={hasMultipleLeagues}
          leagueName={leagueName}
          teamName={teamName}
          currentWeek={currentWeek}
          totalWeeks={totalWeeks}
          onOpenLeagueSheet={() => setSheetOpen(true)}
        />

        <PaymentStatusSection
          key={league.id}
          league={league}
          bowler={bowler}
          weeklyFee={weeklyFee}
          totalWeeks={totalWeeks}
          payments={paymentsResponse?.data || []}
        />


      </div>
      </ErrorBoundary>

      <LeagueBottomSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        activeBowlerLeagues={activeBowlerLeagues}
        leagueMap={leagueMap}
        teamMap={teamMap}
        selectedLeagueId={activeBowlerLeague?.leagueId ?? null}
        onSelectLeague={(id) => setSelectedLeagueId(id)}
        totalWeeksMap={totalWeeksMap}
        currentWeekMap={currentWeekMap}
      />
    </BowlerLayout>
  );
};

export default BowlerDashboardPage;
