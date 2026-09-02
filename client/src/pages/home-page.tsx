import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Trophy, Users, Activity, ArrowUpRight } from "lucide-react";
import { Link } from "wouter";
import type { League, Payment, Bowler, BowlerLeague, ApiResponse, Organization, User } from "@shared/schema";
import type { CanonicalDuePastDueResponseV2 } from "@shared/roster-payment-contract";
import { PastDueBowlersSection } from "@/components/past-due-bowlers-section";
import { formatCurrency } from "@/lib/utils";
import { ErrorBoundary } from "@/components/error-boundary";
import { DashboardSkeleton, PageErrorState } from "@/components/page-states";
import { ApplePayRecoveryBanner } from "@/components/apple-pay-recovery-banner";
import { SquareCatalogCapBanner } from "@/components/square-catalog-cap-banner";


function LeagueHealthCard({ leagueId, name, bowlerCount, pastDueBowlerCount, reviewRequiredBowlerCount }: {
  leagueId: number;
  name: string;
  bowlerCount: number;
  pastDueBowlerCount: number;
  reviewRequiredBowlerCount: number;
}) {
  const status = pastDueBowlerCount === 0 ? "green" : pastDueBowlerCount <= 2 ? "amber" : "red";
  const pastDueRate = bowlerCount > 0 ? Math.round((pastDueBowlerCount / bowlerCount) * 100) : 0;

  return (
    <Link href={`/reports/leagues/${leagueId}/past-due`}>
      <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow group cursor-pointer">
        <div className="flex justify-between items-start mb-3">
          <div className="font-semibold text-slate-800 text-sm leading-tight">
            {name}
          </div>
          <div
            className={`size-2.5 rounded-full shrink-0 mt-0.5 ${
              status === "green"
                ? "bg-emerald-500"
                : status === "amber"
                ? "bg-amber-400"
                : "bg-red-500"
            }`}
          />
        </div>
        <div className="flex items-center gap-2 mb-3">
          <Users className="size-3.5 text-slate-400" />
          <span className="text-sm text-slate-600">
            <span className="font-semibold text-slate-800">{bowlerCount}</span> bowlers
          </span>
        </div>
        <div className="flex items-center justify-between">
          <div className="text-xs text-slate-500">Past Due</div>
          <div className="text-sm font-bold text-slate-900">{pastDueBowlerCount} ({pastDueRate}%)</div>
        </div>
        {reviewRequiredBowlerCount > 0 && (
          <div className="text-xs text-amber-700 mt-1">{reviewRequiredBowlerCount} review required (excluded)</div>
        )}
        <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden mt-1.5">
          <div
            className={`h-full rounded-full transition-all ${
              status === "green"
                ? "bg-emerald-500"
                : status === "amber"
                ? "bg-amber-400"
                : "bg-red-500"
            }`}
            style={{ width: `${Math.max(pastDueRate > 0 ? 5 : 0, pastDueRate)}%` }}
          />
        </div>
      </div>
    </Link>
  );
}

export default function HomePage() {
  const { data: leaguesResponse, isLoading: loadingLeagues, error: leaguesError, refetch: refetchLeagues } = useQuery<ApiResponse<League[]>>({
    queryKey: ["/api/leagues"],
    staleTime: 1000 * 30,
    retry: false,
  });

  const { data: paymentsResponse, isLoading: loadingPayments, error: paymentsError, refetch: refetchPayments } = useQuery<ApiResponse<Payment[]>>({
    queryKey: ["/api/payments"],
    staleTime: 1000 * 30,
    retry: false,
  });

  const { data: bowlerLeaguesResponse, isLoading: loadingBowlerLeagues, error: bowlerLeaguesError, refetch: refetchBowlerLeagues } = useQuery<ApiResponse<BowlerLeague[]>>({
    queryKey: ["/api/bowler-leagues"],
    staleTime: 1000 * 30,
    retry: false,
  });

  const { data: bowlersResponse, isLoading: loadingBowlers, error: bowlersError, refetch: refetchBowlers } = useQuery<ApiResponse<Bowler[]>>({
    queryKey: ["/api/bowlers"],
    staleTime: 1000 * 30,
    retry: false,
  });

  const { data: userResponse } = useQuery<ApiResponse<User>>({
    queryKey: ["/api/user"],
    staleTime: 1000 * 60 * 5,
    retry: false,
  });

  const { data: financialReportResponse, isLoading: loadingFinancialReport, error: financialReportError, refetch: refetchFinancialReport } = useQuery<ApiResponse<{
    leagues: Array<{ leagueId: number; report: CanonicalDuePastDueResponseV2 }>;
  }>>({
    queryKey: [userResponse?.data?.role === "system_admin" && userResponse.data.organizationId ? `/api/financials/due-past-due?organizationId=${userResponse.data.organizationId}` : "/api/financials/due-past-due"],
    queryFn: async () => {
      const scope = userResponse?.data?.role === "system_admin" && userResponse.data.organizationId ? `?organizationId=${encodeURIComponent(userResponse.data.organizationId)}` : "";
      const response = await fetch(`/api/financials/due-past-due${scope}`);
      if (!response.ok) throw new Error("Financial evidence requires review");
      return response.json();
    },
    enabled: userResponse?.data?.role === "org_admin" || userResponse?.data?.role === "system_admin" || String(userResponse?.data?.role) === "payment_manager",
    staleTime: 1000 * 30,
    retry: false,
  });

  const adminFinancialLoading = (userResponse?.data?.role === "org_admin" || userResponse?.data?.role === "system_admin" || String(userResponse?.data?.role) === "payment_manager") && loadingFinancialReport;
  if (loadingLeagues || loadingPayments || loadingBowlerLeagues || loadingBowlers || adminFinancialLoading) {
    return <Layout><DashboardSkeleton /></Layout>;
  }

  const error = leaguesError || paymentsError || bowlerLeaguesError || bowlersError || (userResponse?.data?.role === "org_admin" || userResponse?.data?.role === "system_admin" || String(userResponse?.data?.role) === "payment_manager" ? financialReportError : null);
  if (error) {
    return <Layout><PageErrorState message={`Error loading data: ${(error as Error).message}`} onRetry={() => { refetchLeagues(); refetchPayments(); refetchBowlerLeagues(); refetchBowlers(); refetchFinancialReport(); }} /></Layout>;
  }

  const leagues = leaguesResponse?.data || [];
  const payments = paymentsResponse?.data || [];
  const bowlerLeaguesData = bowlerLeaguesResponse?.data || [];
  const activeBowlerProfileIds = new Set((bowlersResponse?.data || []).filter((bowler) => bowler.active).map((bowler) => bowler.id));

  const activeLeagues = leagues.filter((l: League) => l.active);
  const activeLeagueIds = new Set(activeLeagues.map((l: League) => l.id));
  const activeBowlerIds = new Set<number>();
  const activeLeagueBowlerKeys = new Set<string>();
  for (const bl of bowlerLeaguesData) {
    if (bl.active && activeLeagueIds.has(bl.leagueId) && activeBowlerProfileIds.has(bl.bowlerId)) {
      activeBowlerIds.add(bl.bowlerId);
      activeLeagueBowlerKeys.add(`${bl.leagueId}:${bl.bowlerId}`);
    }
  }
  const serverFinancialLeagues = financialReportResponse?.data?.leagues ?? [];
  const serverRows = serverFinancialLeagues
    .filter((entry) => activeLeagueIds.has(entry.leagueId))
    .flatMap((entry) => entry.report.rows.map((row) => ({ ...row, leagueId: entry.leagueId })));
  const activeServerRows = serverRows.filter((row) => activeLeagueBowlerKeys.has(`${row.leagueId}:${row.payerBowlerId}`));
  // The dashboard denominator is always the unique set of active
  // bowler-league memberships in active leagues. Financial payer rows are
  // intentionally reserved for past-due numerators below.
  const activeBowlers = activeBowlerIds.size;
  const totalLeagues = activeLeagueIds.size;


  const pastDueBowlerIds = new Set<number>();
  const reviewRequiredBowlerIds = new Set<string>();
  activeServerRows.forEach((row) => {
    if (row.classification === "past_due") pastDueBowlerIds.add(row.payerBowlerId);
    if (row.reviewRequired) reviewRequiredBowlerIds.add(`${row.leagueId}:${row.payerBowlerId}`);
  });

  const pastDueRate = activeBowlers > 0 ? Math.round((pastDueBowlerIds.size / activeBowlers) * 100) : 0;

  const leagueHealthData = activeLeagues.flatMap(league => {
    const leagueBowlerIds = new Set<number>();
    for (const bl of bowlerLeaguesData) {
      if (bl.leagueId === league.id && bl.active && activeBowlerProfileIds.has(bl.bowlerId)) leagueBowlerIds.add(bl.bowlerId);
    }
    const leagueBowlerCount = leagueBowlerIds.size;
    if (leagueBowlerCount === 0) return [];

    const pastDueCount = new Set(activeServerRows
      .filter((row) => row.leagueId === league.id && row.classification === "past_due")
      .map((row) => row.payerBowlerId)).size;
    const reviewRequiredCount = new Set(activeServerRows
      .filter((row) => row.leagueId === league.id && row.reviewRequired)
      .map((row) => row.payerBowlerId)).size;

    return [{
      id: league.id,
      name: league.name,
      bowlerCount: leagueBowlerCount,
      pastDueBowlerCount: pastDueCount,
      reviewRequiredBowlerCount: reviewRequiredCount,
    }];
  });

  const userName = userResponse?.data?.name?.split(' ')[0] || "Admin";

  return (
    <Layout>
      <ErrorBoundary level="section">
        <div className="flex flex-col gap-6">
          <ErrorBoundary level="section">
            <ApplePayRecoveryBanner />
          </ErrorBoundary>

          <ErrorBoundary level="section">
            <SquareCatalogCapBanner />
          </ErrorBoundary>

          <div className="flex flex-col sm:flex-row sm:justify-between sm:items-end gap-2">
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-slate-900">
                Welcome back, {userName}
              </h1>
              <p className="text-slate-500 mt-1">
                Here's what's happening with your leagues today.
              </p>
            </div>
            <Link
              href="/reports"
              className="hidden md:inline-flex items-center px-4 py-2 bg-[#0f172a] text-white text-sm font-medium rounded-md hover:bg-slate-800 transition-colors shadow-sm no-underline focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2"
            >
              Generate Report
            </Link>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <Link href="/leagues">
              <div className="bg-white p-3.5 border border-slate-200 rounded-lg shadow-sm hover:shadow-md transition-shadow cursor-pointer">
                <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1.5">
                  Active Leagues
                </div>
                <div className="flex items-end justify-between">
                  <div className="text-2xl font-bold text-slate-900">{totalLeagues}</div>
                  <Activity className="size-3.5 text-emerald-500 mb-1" />
                </div>
              </div>
            </Link>
            <Link href="/bowlers">
              <div className="bg-white p-3.5 border border-slate-200 rounded-lg shadow-sm hover:shadow-md transition-shadow cursor-pointer">
                <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1.5">
                  Active Bowlers
                </div>
                <div className="flex items-end justify-between">
                  <div className="text-2xl font-bold text-slate-900">{activeBowlers}</div>
                  <div className="text-xs font-medium text-emerald-600 flex items-center">
                    <ArrowUpRight className="size-3 mr-0.5" />
                  </div>
                </div>
              </div>
            </Link>
            <Link href="/reports/past-due">
              <div className="bg-white p-3.5 border border-slate-200 rounded-lg shadow-sm hover:shadow-md transition-shadow cursor-pointer">
                <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1.5">
                  Bowlers Past Due (server contract)
                </div>
                <div className="flex items-end justify-between">
                  <div className="text-2xl font-bold text-slate-900">{pastDueBowlerIds.size} of {activeBowlers}</div>
                  <div className="text-xs font-medium text-slate-500 mb-0.5">{pastDueRate}%</div>
                </div>
              </div>
            </Link>
          </div>

          <ErrorBoundary level="section">
            <PastDueBowlersSection enabled={userResponse?.data?.role === "org_admin" || userResponse?.data?.role === "system_admin" || String(userResponse?.data?.role) === "payment_manager"} organizationId={userResponse?.data?.role === "system_admin" ? userResponse.data.organizationId : null} />
          </ErrorBoundary>

          {leagueHealthData.length > 0 && (
            <div>
              <h2 className="text-lg font-bold text-slate-900 mb-3">League Health</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {leagueHealthData.map((league) => (
                  <LeagueHealthCard
                    key={league.id}
                    leagueId={league.id}
                    name={league.name}
                    bowlerCount={league.bowlerCount}
                    pastDueBowlerCount={league.pastDueBowlerCount}
                    reviewRequiredBowlerCount={league.reviewRequiredBowlerCount}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </ErrorBoundary>
    </Layout>
  );
}
