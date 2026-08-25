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
import { Link, useParams } from "wouter";

export default function LeaguePastDuePage() {
  const params = useParams();
  const leagueId = parseInt(params.leagueId!);
  const { data: userResponse } = useQuery<{ data: User }>({ queryKey: ["/api/user"], staleTime: 1000 * 60 * 5 });
  const systemScope = userResponse?.data?.role === "system_admin" && userResponse.data.organizationId ? `?organizationId=${encodeURIComponent(userResponse.data.organizationId)}` : "";

  const { data: league, isLoading: loadingLeague } = useQuery<{ data: League }>({
    queryKey: [`/api/leagues/${leagueId}`],
    queryFn: async () => {
      const response = await fetch(`/api/leagues/${leagueId}`);
      if (!response.ok) {
        throw new Error('Failed to fetch league');
      }
      return response.json();
    }
  });

  const { data: teamsResponse, isLoading: loadingTeams } = useQuery<{ data: Team[] }>({
    queryKey: ["/api/teams"],
    queryFn: async () => {
      const response = await fetch('/api/teams');
      if (!response.ok) {
        throw new Error('Failed to fetch teams');
      }
      return response.json();
    }
  });

  const { data: bowlerLeaguesResponse, isLoading: loadingBowlerLeagues } = useQuery<{ data: BowlerLeague[] }>({
    queryKey: ["/api/bowler-leagues", leagueId],
    queryFn: async () => {
      const response = await fetch(`/api/bowler-leagues?leagueId=${leagueId}`);
      if (!response.ok) {
        throw new Error('Failed to fetch bowler leagues');
      }
      return response.json();
    },
    enabled: !!leagueId,
  });

  const { data: bowlersResponse, isLoading: loadingBowlers } = useQuery<{ data: BowlerWithAccount[] }>({
    queryKey: ["/api/bowlers"],
    queryFn: async () => {
      const response = await fetch('/api/bowlers');
      if (!response.ok) {
        throw new Error('Failed to fetch bowlers');
      }
      return response.json();
    }
  });

  const { data: financialResponse, isLoading: loadingFinancials, error: financialError } = useQuery<{ data: CanonicalDuePastDueResponseV2 }>({
    queryKey: [`/api/financials/leagues/${leagueId}/canonical-due-past-due/2${systemScope}`],
    queryFn: async () => {
      const response = await fetch(`/api/financials/leagues/${leagueId}/canonical-due-past-due/2${systemScope}`);
      if (!response.ok) {
        throw new Error('Canonical financial evidence requires review');
      }
      return response.json();
    },
    enabled: !!leagueId && (userResponse?.data?.role === "org_admin" || userResponse?.data?.role === "system_admin" || userResponse?.data?.role === "user" || String(userResponse?.data?.role) === "payment_manager"),
  });

  if (loadingLeague || loadingTeams || loadingBowlers || loadingFinancials || loadingBowlerLeagues) {
    return (
      <Layout>
        <PageLoadingState />
      </Layout>
    );
  }

  if (!league?.data) {
    return (
      <Layout>
        <div>League not found</div>
      </Layout>
    );
  }
  if (financialError || !financialResponse?.data) return <Layout><p className="p-6 text-destructive">Financial evidence requires review; no balance is shown.</p></Layout>;

  // Get teams for this league
  const teams = teamsResponse?.data || [];
  const leagueTeams = teams.filter(team => team.leagueId === leagueId) || [];

  // Resolve display identities only; due truth comes from the financial read contract.
  const bowlers = bowlersResponse?.data || [];
  const bowlerLeagues = bowlerLeaguesResponse?.data || [];
  const financialRows = financialResponse?.data.rows || [];

  // Get bowlers for these teams using bowler leagues
  const leagueBowlers = bowlers;

  const groupedRows = [...financialRows.reduce((map, row) => {
    const key = `${row.payerBowlerId}:none`;
    const prior = map.get(key);
    const collectible = row.classification === "past_due" ? row.outstandingMinor : 0;
    map.set(key, prior ? { ...prior, outstandingMinor: prior.outstandingMinor + row.outstandingMinor, collectiblePastDueMinor: prior.collectiblePastDueMinor + collectible, reviewRequired: prior.reviewRequired || row.reviewRequired, reviewMinor: prior.reviewMinor + (row.reviewRequired ? row.outstandingMinor : 0), classification: prior.reviewRequired || row.reviewRequired ? "review_required" : prior.collectiblePastDueMinor + collectible > 0 ? "past_due" : row.classification } : { ...row, collectiblePastDueMinor: collectible, reviewMinor: row.reviewRequired ? row.outstandingMinor : 0 });
    return map;
  }, new Map<string, (typeof financialRows)[number] & { collectiblePastDueMinor: number; reviewMinor: number }>()).values()];
  const pastDueBowlers = groupedRows
    .filter((row) => row.collectiblePastDueMinor > 0 || row.reviewRequired)
    .flatMap((row) => {
      const bowler = leagueBowlers.find((candidate) => candidate.id === row.payerBowlerId);
      if (!bowler) return [];
      const bowlerLeague = bowlerLeagues.find(bl => 
        bl.bowlerId === bowler.id &&
        bl.leagueId === leagueId
      );
      if (!bowlerLeague) return [];

      // Canonical responsibility is authoritative for team identity. Membership
      // supplies only the safe league population/display fallback used by legacy.
      const team = teams?.find(t => t.id === row.teamId) ?? teams?.find(t => t.id === bowlerLeague?.teamId);
      if (!team) return [];

      const pastDueAmount = row.collectiblePastDueMinor;
      const pastDueObligations = row.reviewRequired ? "Review required" : "Aggregated";

      return [{
        bowler,
        team,
        pastDueObligations,
        pastDueAmount,
        reviewRequired: row.reviewRequired,
      }];
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
          <h1 className="text-2xl font-bold mb-2">{league.data.name} - Past Due Balances</h1>
          <p className="text-muted-foreground mb-6">
            List of bowlers with past due balances in {league.data.name}. Source: roster-driven canonical obligations.
          </p>
        </div>

        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Bowler Name</TableHead>
                <TableHead>Team</TableHead>
                <TableHead>Past-due obligations</TableHead>
                <TableHead>Past Due Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pastDueBowlers?.map(item => item && (
                <TableRow key={item.bowler.id}>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <CheckCircle2 className={`size-4 ${item.bowler.hasAccount ? "text-green-500" : "text-muted-foreground/40"}`} />
                      <Link href={`/bowlers/${item.bowler.id}?from=league-past-due&fromLeagueId=${leagueId}`} className="hover:underline">
                        {item.bowler.name}
                      </Link>
                    </div>
                  </TableCell>
                  <TableCell>{item.team.name}</TableCell>
                  <TableCell>{item.reviewRequired ? "Review required" : item.pastDueObligations}</TableCell>
                  <TableCell className="text-destructive">
                    {`$${(item.pastDueAmount / 100).toFixed(2)}`}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
      </ErrorBoundary>
    </Layout>
  );
}
