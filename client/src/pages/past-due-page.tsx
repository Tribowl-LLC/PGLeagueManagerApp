import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { ErrorBoundary } from "@/components/error-boundary";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ArrowLeft, CheckCircle2 } from "lucide-react";
import { PageLoadingState } from "@/components/page-states";
import type { League, Team, BowlerLeague, BowlerWithAccount, User } from "@shared/schema";
import type { CanonicalDuePastDueResponseV2 } from "@shared/roster-payment-contract";
import { Link } from "wouter";

export default function PastDuePage() {
  const { data: userResponse } = useQuery<{ data: User }>({ queryKey: ["/api/user"], staleTime: 1000 * 60 * 5 });
  const systemScope = userResponse?.data?.role === "system_admin" && userResponse.data.organizationId ? `?organizationId=${encodeURIComponent(userResponse.data.organizationId)}` : "";
  const { data: leaguesResponse, isLoading: loadingLeagues } = useQuery<{ success: true, data: League[] }>({
    queryKey: ["/api/leagues"],
    queryFn: async () => {
      const response = await fetch('/api/leagues');
      if (!response.ok) {
        throw new Error('Failed to fetch leagues');
      }
      return response.json();
    }
  });
  const leagues = leaguesResponse?.data || [];

  const { data: teamsResponse, isLoading: loadingTeams } = useQuery<{ success: true, data: Team[] }>({
    queryKey: ["/api/teams"],
    queryFn: async () => {
      const response = await fetch('/api/teams');
      if (!response.ok) {
        throw new Error('Failed to fetch teams');
      }
      return response.json();
    }
  });
  const teams = teamsResponse?.data || [];

  const { data: bowlersResponse, isLoading: loadingBowlers } = useQuery<{ success: true, data: BowlerWithAccount[] }>({
    queryKey: ["/api/bowlers"],
    queryFn: async () => {
      const response = await fetch('/api/bowlers');
      if (!response.ok) {
        throw new Error('Failed to fetch bowlers');
      }
      return response.json();
    }
  });
  const bowlers = bowlersResponse?.data || [];

  const { data: bowlerLeaguesResponse, isLoading: loadingBowlerLeagues } = useQuery<{ success: true, data: BowlerLeague[] }>({
    queryKey: ["/api/bowler-leagues", { enriched: true }],
    queryFn: async () => {
      const response = await fetch('/api/bowler-leagues?enriched=true');
      if (!response.ok) {
        throw new Error('Failed to fetch bowler leagues');
      }
      return response.json();
    }
  });
  const bowlerLeagues = bowlerLeaguesResponse?.data || [];

  const { data: financialResponse, isLoading: loadingFinancials, error: financialError } = useQuery<{ data: { leagues: Array<{ leagueId: number; report: CanonicalDuePastDueResponseV2 }> } }>({
    queryKey: [systemScope ? `/api/financials/due-past-due${systemScope}` : "/api/financials/due-past-due"],
    queryFn: async () => {
      const response = await fetch(`/api/financials/due-past-due${systemScope}`);
      if (!response.ok) {
        throw new Error('Canonical financial evidence requires review');
      }
      return response.json();
    },
    enabled: userResponse?.data?.role === "org_admin" || userResponse?.data?.role === "system_admin" || String(userResponse?.data?.role) === "payment_manager",
  });
  const financialLeagues = financialResponse?.data.leagues || [];

  if (loadingLeagues || loadingTeams || loadingBowlers || loadingFinancials || loadingBowlerLeagues) {
    return (
      <Layout>
        <PageLoadingState />
      </Layout>
    );
  }
  if (financialError || !financialResponse?.data?.leagues) return <Layout><p className="p-6 text-destructive">Financial evidence requires review; no balance is shown.</p></Layout>;

  const groupedRows = [...financialLeagues.flatMap((entry) => entry.report.rows.map((row) => ({ ...row, leagueId: entry.leagueId }))).reduce((map, row) => {
    const key = `${row.leagueId}:${row.payerBowlerId}:none`;
    const prior = map.get(key);
    const collectible = row.classification === "past_due" ? row.outstandingMinor : 0;
    const next = prior ? { ...prior, outstandingMinor: prior.outstandingMinor + row.outstandingMinor, collectiblePastDueMinor: prior.collectiblePastDueMinor + collectible, reviewRequired: prior.reviewRequired || row.reviewRequired, reviewMinor: prior.reviewMinor + (row.reviewRequired ? row.outstandingMinor : 0), classification: prior.reviewRequired || row.reviewRequired ? "review_required" : prior.collectiblePastDueMinor + collectible > 0 ? "past_due" : row.classification } : { ...row, collectiblePastDueMinor: collectible, reviewMinor: row.reviewRequired ? row.outstandingMinor : 0 };
    map.set(key, next);
    return map;
  }, new Map<string, (typeof financialLeagues[number]["report"]["rows"][number] & { leagueId: number; collectiblePastDueMinor: number; reviewMinor: number })>()).values()];
  const pastDueBowlers = groupedRows.flatMap((financialLeague) => {
    const league = leagues.find((candidate) => candidate.id === financialLeague.leagueId);
    if (!league) return [];
    return [financialLeague].filter((row) => row.collectiblePastDueMinor > 0 || row.reviewRequired).flatMap((row) => {
      const bowler = bowlers.find((candidate) => candidate.id === row.payerBowlerId);
      const association = bowlerLeagues.find((candidate) => candidate.bowlerId === row.payerBowlerId && candidate.leagueId === league.id);
      const team = teams.find((candidate) => candidate.id === row.teamId) ?? teams.find((candidate) => candidate.id === association?.teamId);
      if (!bowler || !team || !association) return [];
      return [{ bowler, team, league, pastDueObligations: row.reviewRequired ? "Review required" : "Aggregated", pastDueAmount: row.collectiblePastDueMinor, reviewRequired: row.reviewRequired }];
    });
  })
    .sort((a, b) => b.pastDueAmount - a.pastDueAmount);

  return (
    <Layout>
      <ErrorBoundary level="section">
      <div className="space-y-6">
        <Link href="/reports" className="text-muted-foreground hover:text-foreground flex items-center">
          <ArrowLeft className="size-4 mr-2" />
          Back to Reports
        </Link>

        <div>
          <h1 className="text-2xl font-bold mb-2">Past Due Balances</h1>
          <p className="text-muted-foreground mb-6">
            List of bowlers with past due balances. Source: roster-driven canonical obligations.
          </p>
        </div>

        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Bowler Name</TableHead>
                <TableHead>League</TableHead>
                <TableHead>Team</TableHead>
                <TableHead>Past-due obligations</TableHead>
                <TableHead>Past Due Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pastDueBowlers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-4">
                    No past due balances found
                  </TableCell>
                </TableRow>
              ) : (
                pastDueBowlers.map(item => (
                  <TableRow key={`${item.bowler.id}-${item.league.id}`}>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <CheckCircle2 className={`size-4 ${item.bowler.hasAccount ? "text-green-500" : "text-muted-foreground/40"}`} />
                        <Link href={`/bowlers/${item.bowler.id}?from=past-due`} className="hover:underline">
                          {item.bowler.name}
                        </Link>
                      </div>
                    </TableCell>
                    <TableCell>{item.league.name}</TableCell>
                    <TableCell>{item.team.name}</TableCell>
                    <TableCell>{item.reviewRequired ? "Review required" : item.pastDueObligations}</TableCell>
                    <TableCell className="text-destructive">
                    {`$${(item.pastDueAmount / 100).toFixed(2)}`}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
      </ErrorBoundary>
    </Layout>
  );
}
