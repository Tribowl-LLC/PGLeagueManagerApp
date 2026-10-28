import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ArrowRight, CheckCircle2, ChevronDown } from "lucide-react";
import { Link } from "wouter";
import type { League, Team, BowlerLeague, BowlerWithAccount } from "@shared/schema";
import type { CanonicalDuePastDueResponseV2 } from "@shared/roster-payment-contract";
import { cn } from "@/lib/utils";
import { throwIfResNotOk } from "@/lib/queryClient";
import { confirmedCollectiblePastDueMinor, effectiveFinancialDebtorBowlerId, financialReadErrorMessage } from "@/lib/financial-utils";

type BalanceSort = "amount" | "name";

export function PastDueBowlersSection({ enabled = true, organizationId, leagueIds }: { enabled?: boolean; organizationId?: number | null; leagueIds?: ReadonlySet<number> }) {
  const [sort, setSort] = useState<BalanceSort>("amount");
  const { data: leaguesResponse } = useQuery<{ success: true, data: League[] }>({
    queryKey: ["/api/leagues"],
  });
  const leagues = leaguesResponse?.data || [];

  const { data: teamsResponse } = useQuery<{ success: true, data: Team[] }>({
    queryKey: ["/api/teams"],
  });
  const teams = teamsResponse?.data || [];

  const { data: bowlersResponse } = useQuery<{ success: true, data: BowlerWithAccount[] }>({
    queryKey: ["/api/bowlers"],
  });
  const bowlers = bowlersResponse?.data || [];

  const { data: bowlerLeaguesResponse } = useQuery<{ success: true, data: BowlerLeague[] }>({
    queryKey: ["/api/bowler-leagues", { enriched: true }],
    queryFn: async () => {
      const response = await fetch('/api/bowler-leagues?enriched=true');
      await throwIfResNotOk(response);
      return response.json();
    }
  });
  const bowlerLeagues = bowlerLeaguesResponse?.data || [];

  const { data: financialReportResponse, isLoading: financialLoading, error: financialError } = useQuery<{ data: { leagues: Array<{ leagueId: number; report: CanonicalDuePastDueResponseV2 }> } }>({
    queryKey: ["/api/financials/due-past-due", organizationId ?? null],
    queryFn: async () => {
      const response = await fetch('/api/financials/due-past-due');
      await throwIfResNotOk(response);
      return response.json();
    },
    enabled,
  });
  if (!enabled) return null;
  const header = (
    <div className="dashboard-card-head">
      <div>
        <h2 id="dashboard-past-due-balances">Confirmed past-due balances</h2>
        <p>Review-required balances are listed separately.</p>
      </div>
      <label className="dashboard-select">
        <span className="sr-only">Sort balances</span>
        <select value={sort} onChange={(event) => setSort(event.target.value === "name" ? "name" : "amount")}>
          <option value="amount">Largest balance</option>
          <option value="name">Bowler name</option>
        </select>
        <ChevronDown className="size-4" aria-hidden="true" />
      </label>
    </div>
  );
  if (financialLoading || financialError) {
    return (
      <section className="dashboard-card" aria-labelledby="dashboard-past-due-balances">
        {header}
        <p className={cn("dashboard-card-message", financialError && "text-warning-700")}>
          {financialError ? financialReadErrorMessage(financialError) : "Loading server financial evidence…"}
        </p>
      </section>
    );
  }
  const financialRows = financialReportResponse?.data?.leagues?.flatMap((entry) => entry.report.rows.map((row) => ({ ...row, leagueId: entry.leagueId }))) ?? [];

  const groupedFinancialRows = [...financialRows.reduce((map, row) => {
    const bowlerId = effectiveFinancialDebtorBowlerId(row);
    if (bowlerId === null) return map;
    const normalized = { ...row, payerBowlerId: bowlerId };
    const key = `${row.leagueId}:${bowlerId}:none`;
    const prior = map.get(key);
    const collectible = confirmedCollectiblePastDueMinor(normalized);
    map.set(key, prior ? { ...prior, outstandingMinor: prior.outstandingMinor + row.outstandingMinor, collectiblePastDueMinor: prior.collectiblePastDueMinor + collectible, reviewRequired: prior.reviewRequired || row.reviewRequired, reviewMinor: prior.reviewMinor + (row.reviewRequired ? row.outstandingMinor : 0), classification: prior.reviewRequired || row.reviewRequired ? "review_required" : prior.collectiblePastDueMinor + collectible > 0 ? "past_due" : row.classification } : { ...normalized, collectiblePastDueMinor: collectible, reviewMinor: row.reviewRequired ? row.outstandingMinor : 0 });
    return map;
  }, new Map<string, (typeof financialRows)[number] & { collectiblePastDueMinor: number; reviewMinor: number }>()).values()]
  // Review-required balances are excluded here and counted in League health.
  const pastDueBowlers = groupedFinancialRows
    .filter((row) => row.collectiblePastDueMinor > 0 && (!leagueIds || leagueIds.has(row.leagueId)))
    .flatMap((row) => {
      const bowler = bowlers.find((candidate) => candidate.id === row.payerBowlerId);
      const league = leagues.find((candidate) => candidate.id === row.leagueId);
      // Canonical evidence remains displayable after a roster move/deactivation. The
      // row's team is the historical responsibility identity; membership is only a
      // fallback for older server rows and must not rewrite paid history.
      const association = bowlerLeagues.find((candidate) => candidate.bowlerId === row.payerBowlerId && candidate.leagueId === row.leagueId);
      const team = teams.find((candidate) => candidate.id === row.teamId) ?? teams.find((candidate) => candidate.id === association?.teamId);
      if (!bowler || !league || !league.active || !team || !association) return [];
      return [{ bowler, team, league, pastDueAmount: row.collectiblePastDueMinor }];
    })
    .sort(sort === "name"
      ? (a, b) => a.bowler.name.localeCompare(b.bowler.name)
      : (a, b) => b.pastDueAmount - a.pastDueAmount);

  return (
    <section className="dashboard-card" aria-labelledby="dashboard-past-due-balances">
      {header}
      <div className="dashboard-table-wrap">
        <table className="dashboard-table">
          <thead>
            <tr>
              <th>Bowler Name</th>
              <th>League</th>
              <th className="dashboard-hide-sm">Team</th>
              <th className="dashboard-num">Past Due Amount</th>
            </tr>
          </thead>
          <tbody>
            {pastDueBowlers.length === 0 ? (
              <tr>
                <td colSpan={4} className="dashboard-empty">No past due balances found</td>
              </tr>
            ) : (
              pastDueBowlers.slice(0, 5).map(item => (
                <tr key={`${item.bowler.id}-${item.league.id}`}>
                  <td>
                    <span className="dashboard-name">
                      <CheckCircle2
                        className={cn("size-4", item.bowler.hasAccount ? "dashboard-positive" : "dashboard-faint")}
                        aria-label={item.bowler.hasAccount ? "Has account" : "No account"}
                      />
                      <Link href={`/bowlers/${item.bowler.id}?from=home`}>{item.bowler.name}</Link>
                    </span>
                  </td>
                  <td>{item.league.name}</td>
                  <td className="dashboard-hide-sm">{item.team.name}</td>
                  <td className="dashboard-num dashboard-danger">
                    {`$${(item.pastDueAmount / 100).toFixed(2)}`}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {pastDueBowlers.length > 5 && (
        <div className="dashboard-card-foot">
          <Link href="/reports/past-due" className="dashboard-link">
            View all balances<ArrowRight className="size-3.5" aria-hidden="true" />
          </Link>
        </div>
      )}
    </section>
  );
}
