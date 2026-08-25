import { useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { ErrorBoundary } from "@/components/error-boundary";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { PageLoadingState } from "@/components/page-states";
import type { League, Team, Bowler, BowlerLeague, User } from "@shared/schema"; // Added BowlerLeague type
import type { CanonicalPaymentReport } from "@shared/canonical-payment-report";
import type { CanonicalDuePastDueResponseV2 } from "@shared/roster-payment-contract";
import { Link } from "wouter";

export default function ReportsPage() {
  const [showArchived, setShowArchived] = useState(false);
  const { data: userResponse } = useQuery<{ data: User }>({ queryKey: ["/api/user"], staleTime: 1000 * 60 * 5 });
  const systemScope = userResponse?.data?.role === "system_admin" && userResponse.data.organizationId ? `?organizationId=${encodeURIComponent(userResponse.data.organizationId)}` : "";

  const { data: leaguesResponse, isLoading: loadingLeagues } = useQuery<{ data: League[] }>({
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
  const teams = teamsResponse?.data || [];

  const { data: bowlersResponse, isLoading: loadingBowlers } = useQuery<{ data: Bowler[] }>({
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

  const paymentReportQueries = useQueries({
    queries: leagues.map((league) => ({
      queryKey: ["/api/financials/f5/payments", league.id, systemScope],
      queryFn: async (): Promise<{ data: CanonicalPaymentReport }> => {
        const params = new URLSearchParams(systemScope.replace(/^\?/, ""));
        params.set("leagueId", String(league.id));
        params.set("page", "1");
        params.set("limit", "200");
        const response = await fetch(`/api/financials/f5/payments?${params.toString()}`);
        if (!response.ok) throw new Error("Payment evidence requires review");
        return response.json();
      },
      enabled: leagues.length > 0,
      staleTime: 30_000,
    })),
  });
  const loadingPayments = paymentReportQueries.some((query) => query.isLoading);
  const paymentReportError = paymentReportQueries.find((query) => query.error)?.error;
  const paymentReports = new Map<number, CanonicalPaymentReport>();
  leagues.forEach((league, index) => {
    const report = paymentReportQueries[index]?.data?.data;
    if (report) paymentReports.set(league.id, report);
  });

  const { data: financialResponse, isLoading: loadingFinancials, error: financialError } = useQuery<{ data: { leagues: Array<{ leagueId: number; report: CanonicalDuePastDueResponseV2 }> } }>({
    queryKey: ["/api/financials/due-past-due", systemScope],
    queryFn: async () => {
      const response = await fetch(`/api/financials/due-past-due${systemScope}`);
      if (!response.ok) throw new Error('Canonical financial evidence requires review');
      return response.json();
    },
    enabled: userResponse?.data?.role === "org_admin" || userResponse?.data?.role === "system_admin" || String(userResponse?.data?.role) === "payment_manager",
  });

  const { data: bowlerLeaguesResponse, isLoading: loadingBowlerLeagues } = useQuery<{ data: BowlerLeague[] }>({
    queryKey: ["/api/bowler-leagues"],
    queryFn: async () => {
      const response = await fetch('/api/bowler-leagues');
      if (!response.ok) {
        throw new Error('Failed to fetch bowler leagues');
      }
      return response.json();
    }
  });
  const bowlerLeagues = bowlerLeaguesResponse?.data || [];

  if (userResponse?.data?.role === "system_admin" && !userResponse.data.organizationId) {
    return <Layout><p className="p-6 text-destructive">Select an organization before viewing financial reports.</p></Layout>;
  }


  if (loadingLeagues || loadingTeams || loadingBowlers || loadingPayments || loadingBowlerLeagues || loadingFinancials) {
    return (
      <Layout>
        <PageLoadingState />
      </Layout>
    );
  }
  if (financialError || paymentReportError || !financialResponse?.data?.leagues) return <Layout><p className="p-6 text-destructive">Financial evidence requires review; no balance is shown.</p></Layout>;

  // Fix the bowler-team relationship logic
  const financialLeagues = financialResponse?.data.leagues || [];
  const leagueFinancials = leagues.map(league => {
    const leagueTeams = teams.filter(team => team.leagueId === league.id);

    // Use bowlerLeagues to get the correct bowler-team associations
    const leagueBowlers = bowlers.filter(bowler =>
      bowlerLeagues.some(bl =>
        bl.bowlerId === bowler.id &&
        bl.leagueId === league.id &&
        leagueTeams.some(team => team.id === bl.teamId)
      )
    );

    const paymentReport = paymentReports.get(league.id);
    const collected = paymentReport?.totals.grossConfirmedPaidMinor ?? 0;
    const unallocatedLegacy = paymentReport?.totals.unallocatedLegacyMinor ?? 0;

    const canonicalReport = financialLeagues.find((entry) => entry.leagueId === league.id)?.report;
    const pastDueBalance = canonicalReport?.rows.filter((row) => row.classification === "past_due").reduce((sum, row) => sum + row.outstandingMinor, 0) ?? 0;
    const reviewCount = canonicalReport?.rows.filter((row) => row.reviewRequired).length ?? 0;

    return {
      ...league,
      collected,
      unallocatedLegacy,
      pastDueBalance,
      reviewCount,
      activeBowlerCount: leagueBowlers.filter(b => b.active).length,
      teamCount: leagueTeams.length,
    };
  });

  const filteredLeagueFinancials = showArchived
    ? leagueFinancials
    : leagueFinancials.filter(league => league.active);

  const totalCollected = filteredLeagueFinancials.reduce((sum, league) => sum + league.collected, 0) || 0;
  const totalPastDue = filteredLeagueFinancials.reduce((sum, league) => sum + league.pastDueBalance, 0) || 0;

  return (
    <Layout>
      <ErrorBoundary level="section">
      <div className="space-y-8">
        <h1 className="text-2xl font-bold">Reports</h1>

        <ErrorBoundary level="section">
        <div>
          <h2 className="text-xl font-semibold mb-1">Overall Financial Summary</h2>
          <p className="text-sm text-muted-foreground mb-4">Due and past-due source: versioned server financial contract. Collections remain payment history.</p>
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                  <CardTitle>Confirmed Collections</CardTitle>
                  <CardDescription>Provider/local paid evidence, counted once per payment row</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">${(totalCollected / 100).toFixed(2)}</p>
                <p className="text-xs text-muted-foreground mt-2">Unallocated legacy history is shown separately below.</p>
              </CardContent>
            </Card>

            <Link href="/reports/past-due">
              <Card className="transition-colors hover:bg-accent/50 cursor-pointer">
                <CardHeader>
                  <CardTitle>Total Past Due</CardTitle>
                  <CardDescription>Total amount past due to date</CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-bold text-destructive">
                    ${(totalPastDue / 100).toFixed(2)}
                  </p>
                </CardContent>
              </Card>
            </Link>
          </div>
        </div>
        </ErrorBoundary>

        <ErrorBoundary level="section">
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold">League Financial Reports</h2>
            <div className="flex items-center gap-x-2">
              <Switch
                id="show-archived"
                checked={showArchived}
                onCheckedChange={setShowArchived}
              />
              <Label htmlFor="show-archived">Show archived</Label>
            </div>
          </div>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>League Name</TableHead>
                  <TableHead>Active Bowlers</TableHead>
                  <TableHead>Teams</TableHead>
                  <TableHead>Collections</TableHead>
                  <TableHead>Unlinked history</TableHead>
                  <TableHead>Past Due</TableHead>
                  <TableHead>Review</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredLeagueFinancials.map((league) => (
                  <TableRow key={league.id}>
                    <TableCell>
                      <Link
                        href={`/reports/leagues/${league.id}/past-due`}
                        className="hover:underline text-foreground"
                      >
                        {league.name}
                      </Link>
                    </TableCell>
                    <TableCell>{league.activeBowlerCount}</TableCell>
                    <TableCell>{league.teamCount}</TableCell>
                    <TableCell>${(league.collected / 100).toFixed(2)}</TableCell>
                    <TableCell>${(league.unallocatedLegacy / 100).toFixed(2)}</TableCell>
                    <TableCell className="text-destructive">
                      ${(league.pastDueBalance / 100).toFixed(2)}
                    </TableCell>
                    <TableCell>{league.reviewCount > 0 ? `${league.reviewCount} required` : "—"}</TableCell>
                    <TableCell>
                      <Badge variant={league.active ? "default" : "secondary"}>
                        {league.active ? "Active" : "Inactive"}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
        </ErrorBoundary>
      </div>
      </ErrorBoundary>
    </Layout>
  );
}
