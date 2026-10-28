import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Activity, ChevronDown } from "lucide-react";
import { Link } from "wouter";
import type { League, Payment, Bowler, BowlerLeague, ApiResponse, Location, User } from "@shared/schema";
import type { CanonicalDuePastDueResponseV2 } from "@shared/roster-payment-contract";
import { PastDueBowlersSection } from "@/components/past-due-bowlers-section";
import { cn } from "@/lib/utils";
import { ErrorBoundary } from "@/components/error-boundary";
import { DashboardSkeleton, PageErrorState } from "@/components/page-states";
import { ApplePayRecoveryBanner } from "@/components/apple-pay-recovery-banner";
import { SquareCatalogCapBanner } from "@/components/square-catalog-cap-banner";
import { shouldRetryApiQuery, throwIfResNotOk } from "@/lib/queryClient";
import { financialReadErrorMessage } from "@/lib/financial-utils";
import "./home-page.css";


type LeagueHealthRow = {
  id: number;
  name: string;
  bowlerCount: number;
  pastDueBowlerCount: number;
  reviewRequiredBowlerCount: number;
};

const ALL_LOCATIONS = "all";

function healthStatusClass(pastDueBowlerCount: number) {
  return pastDueBowlerCount === 0
    ? "dashboard-status-green"
    : pastDueBowlerCount <= 2
    ? "dashboard-status-amber"
    : "dashboard-status-red";
}

function LeagueHealthTable({ leagues }: { leagues: LeagueHealthRow[] }) {
  return (
    <section className="dashboard-card" aria-labelledby="dashboard-league-health">
      <div className="dashboard-card-head">
        <h2 id="dashboard-league-health">League health</h2>
      </div>
      <div className="dashboard-table-wrap">
        <table className="dashboard-table">
          <thead>
            <tr>
              <th>League</th>
              <th>Bowlers</th>
              <th>Past due</th>
              <th className="dashboard-hide-sm">Rate</th>
            </tr>
          </thead>
          <tbody>
            {leagues.length === 0 ? (
              <tr><td colSpan={4} className="dashboard-empty">No active leagues</td></tr>
            ) : leagues.map((league) => {
              const statusClass = healthStatusClass(league.pastDueBowlerCount);
              const pastDueRate = league.bowlerCount > 0 ? Math.round((league.pastDueBowlerCount / league.bowlerCount) * 100) : 0;
              return (
                <tr key={league.id}>
                  <td>
                    <span className="dashboard-name">
                      <span className={cn("dashboard-dot", statusClass)} aria-hidden="true" />
                      <Link href={`/reports/leagues/${league.id}/past-due`}>{league.name}</Link>
                    </span>
                    {league.reviewRequiredBowlerCount > 0 && (
                      <span className="dashboard-review-note">{league.reviewRequiredBowlerCount} in review</span>
                    )}
                  </td>
                  <td className="dashboard-center">{league.bowlerCount}</td>
                  <td className="dashboard-center">{league.pastDueBowlerCount}</td>
                  <td className="dashboard-hide-sm">
                    <span className="dashboard-rate">
                      <span className="dashboard-bar" aria-hidden="true">
                        <span
                          className={cn("dashboard-bar-fill block", statusClass)}
                          style={{ "--progress-width": `${Math.max(pastDueRate > 0 ? 5 : 0, pastDueRate)}%` }}
                        />
                      </span>
                      <span>{pastDueRate}%</span>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
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
  const financialOrganizationId = userResponse?.data?.role === "system_admin" ? userResponse.data.organizationId : null;
  const canListLocations = userResponse?.data?.role === "org_admin" || userResponse?.data?.role === "system_admin";
  const [selectedLocation, setSelectedLocation] = useState(ALL_LOCATIONS);

  const { data: locationsResponse } = useQuery<ApiResponse<Location[]>>({
    queryKey: ["/api/locations"],
    enabled: canListLocations,
    staleTime: 1000 * 60 * 5,
    retry: false,
  });

  const { data: financialReportResponse, isLoading: loadingFinancialReport, error: financialReportError, refetch: refetchFinancialReport } = useQuery<ApiResponse<{
    leagues: Array<{ leagueId: number; report: CanonicalDuePastDueResponseV2 }>;
  }>>({
    queryKey: ["/api/financials/due-past-due", financialOrganizationId ?? null],
    queryFn: async ({ signal }) => {
      const response = await fetch('/api/financials/due-past-due', { credentials: "include", signal });
      const validatedResponse = await throwIfResNotOk(response);
      return validatedResponse.json();
    },
    enabled: userResponse?.data?.role === "org_admin" || userResponse?.data?.role === "system_admin" || String(userResponse?.data?.role) === "payment_manager",
    staleTime: 1000 * 30,
    retry: shouldRetryApiQuery,
  });

  const adminFinancialLoading = (userResponse?.data?.role === "org_admin" || userResponse?.data?.role === "system_admin" || String(userResponse?.data?.role) === "payment_manager") && loadingFinancialReport;
  if (loadingLeagues || loadingPayments || loadingBowlerLeagues || loadingBowlers || adminFinancialLoading) {
    return <Layout><DashboardSkeleton /></Layout>;
  }

  const error = leaguesError || paymentsError || bowlerLeaguesError || bowlersError || (userResponse?.data?.role === "org_admin" || userResponse?.data?.role === "system_admin" || String(userResponse?.data?.role) === "payment_manager" ? financialReportError : null);
  if (error) {
    const message = error === financialReportError ? financialReadErrorMessage(error) : `Error loading data: ${(error as Error).message}`;
    return <Layout><PageErrorState message={message} onRetry={() => { refetchLeagues(); refetchPayments(); refetchBowlerLeagues(); refetchBowlers(); refetchFinancialReport(); }} /></Layout>;
  }

  const leagues = leaguesResponse?.data || [];
  const payments = paymentsResponse?.data || [];
  const bowlerLeaguesData = bowlerLeaguesResponse?.data || [];
  const activeBowlerProfileIds = new Set((bowlersResponse?.data || []).filter((bowler) => bowler.active).map((bowler) => bowler.id));

  const allActiveLeagues = leagues.filter((l: League) => l.active);
  // The location filter narrows the permitted leagues already returned for
  // this user; it never widens access or changes the organization.
  const locationOptions = (canListLocations ? locationsResponse?.data ?? [] : [])
    .filter((location) => location.active && allActiveLeagues.some((league) => league.locationId === location.id));
  const locationFilter = locationOptions.some((location) => String(location.id) === selectedLocation) ? selectedLocation : ALL_LOCATIONS;
  const activeLeagues = locationFilter === ALL_LOCATIONS
    ? allActiveLeagues
    : allActiveLeagues.filter((league) => String(league.locationId) === locationFilter);
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
  });
  serverRows.forEach((row) => {
    if (row.reviewRequired) reviewRequiredBowlerIds.add(`${row.leagueId}:${row.payerBowlerId}`);
  });

  const pastDueRate = activeBowlers > 0 ? Math.round((pastDueBowlerIds.size / activeBowlers) * 100) : 0;

  const leagueHealthData = activeLeagues.flatMap(league => {
    const leagueBowlerIds = new Set<number>();
    for (const bl of bowlerLeaguesData) {
      if (bl.leagueId === league.id && bl.active && activeBowlerProfileIds.has(bl.bowlerId)) leagueBowlerIds.add(bl.bowlerId);
    }
    const leagueBowlerCount = leagueBowlerIds.size;
    const reviewRequiredCount = new Set(serverRows
      .filter((row) => row.leagueId === league.id && row.reviewRequired)
      .map((row) => row.payerBowlerId)).size;
    if (leagueBowlerCount === 0 && reviewRequiredCount === 0) return [];

    const pastDueCount = new Set(activeServerRows
      .filter((row) => row.leagueId === league.id && row.classification === "past_due")
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
    <Layout appearance="dashboard">
      <ErrorBoundary level="section">
        <div className="dashboard-page">
          <ErrorBoundary level="section">
            <ApplePayRecoveryBanner />
          </ErrorBoundary>

          <ErrorBoundary level="section">
            <SquareCatalogCapBanner />
          </ErrorBoundary>

          <header className="dashboard-heading">
            <div>
              <h1>Dashboard</h1>
              <p>Welcome back, {userName}.</p>
            </div>
            <div className="dashboard-heading-actions">
              {locationOptions.length > 1 && (
                <label className="dashboard-select">
                  <span className="sr-only">Location</span>
                  <select value={locationFilter} onChange={(event) => setSelectedLocation(event.target.value)}>
                    <option value={ALL_LOCATIONS}>All locations</option>
                    {locationOptions.map((location) => (
                      <option key={location.id} value={String(location.id)}>{location.name}</option>
                    ))}
                  </select>
                  <ChevronDown className="size-4" aria-hidden="true" />
                </label>
              )}
              <Link href="/reports" className="dashboard-button">View reports</Link>
            </div>
          </header>

          <div className="dashboard-metrics">
            <Link href="/leagues" className="dashboard-metric">
              <div className="dashboard-metric-label">Active Leagues</div>
              <div className="dashboard-metric-row">
                <div className="dashboard-metric-value">{totalLeagues}</div>
                <Activity className="size-3.5 dashboard-positive" aria-hidden="true" />
              </div>
            </Link>
            <Link href="/bowlers" className="dashboard-metric">
              <div className="dashboard-metric-label">Active Bowlers</div>
              <div className="dashboard-metric-row">
                <div className="dashboard-metric-value">{activeBowlers}</div>
              </div>
            </Link>
            <Link href="/reports/past-due" className="dashboard-metric">
              <div className="dashboard-metric-label">Confirmed past due</div>
              <div className="dashboard-metric-row">
                <div className="dashboard-metric-value">{pastDueBowlerIds.size}</div>
                <div className="dashboard-metric-aside">{pastDueRate}%</div>
              </div>
            </Link>
          </div>

          <div className="dashboard-split">
            <ErrorBoundary level="section">
              <PastDueBowlersSection
                enabled={userResponse?.data?.role === "org_admin" || userResponse?.data?.role === "system_admin" || String(userResponse?.data?.role) === "payment_manager"}
                organizationId={financialOrganizationId}
                leagueIds={activeLeagueIds}
              />
            </ErrorBoundary>
            <LeagueHealthTable leagues={leagueHealthData} />
          </div>
        </div>
      </ErrorBoundary>
    </Layout>
  );
}
