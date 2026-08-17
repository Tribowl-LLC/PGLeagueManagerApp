import { useQuery } from "@tanstack/react-query";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CheckCircle2 } from "lucide-react";
import { Link } from "wouter";
import type { League, Team, BowlerLeague, BowlerWithAccount } from "@shared/schema";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

export function PastDueBowlersSection({ enabled = true, organizationId }: { enabled?: boolean; organizationId?: number | null }) {
  const scopeSuffix = organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : "";
  const isMobile = useIsMobile();
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
      if (!response.ok) throw new Error('Failed to fetch bowler leagues');
      return response.json();
    }
  });
  const bowlerLeagues = bowlerLeaguesResponse?.data || [];

  // scopeSuffix is encoded in the URL key above; keep the legacy base key for existing ordinary-member cache/tests.
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  const { data: financialReportResponse, isLoading: financialLoading, error: financialError } = useQuery<{ data: { leagues: Array<{ leagueId: number; report: { rows: Array<{ bowlerId: number; teamId: number | null; classification: string; outstandingMinor: number; reviewRequired: boolean }> } }> } }>({
    queryKey: [organizationId ? `/api/financials/due-past-due?organizationId=${organizationId}` : "/api/financials/due-past-due"],
    queryFn: async () => {
      const response = await fetch(`/api/financials/due-past-due${scopeSuffix}`);
      if (!response.ok) throw new Error("Financial evidence requires review");
      return response.json();
    },
    enabled,
  });
  if (!enabled) return null;
  if (financialLoading) return <div className="text-sm text-muted-foreground">Loading server financial evidence…</div>;
  if (financialError) return <div className="text-sm text-amber-700">Financial evidence requires review; balances are unavailable.</div>;
  const financialRows = financialReportResponse?.data?.leagues?.flatMap((entry) => entry.report.rows.map((row) => ({ ...row, leagueId: entry.leagueId, mode: (entry.report as { mode?: string }).mode ?? "legacy_fallback" }))) ?? [];

  const groupedFinancialRows = [...financialRows.reduce((map, row) => {
    const key = `${row.leagueId}:${row.bowlerId}:${row.teamId ?? "none"}`;
    const prior = map.get(key);
    const collectible = row.classification === "past_due" ? row.outstandingMinor : 0;
    map.set(key, prior ? { ...prior, outstandingMinor: prior.outstandingMinor + row.outstandingMinor, collectiblePastDueMinor: prior.collectiblePastDueMinor + collectible, reviewRequired: prior.reviewRequired || row.reviewRequired, reviewMinor: prior.reviewMinor + (row.reviewRequired ? row.outstandingMinor : 0), classification: prior.reviewRequired || row.reviewRequired ? "review_required" : prior.collectiblePastDueMinor + collectible > 0 ? "past_due" : row.classification } : { ...row, collectiblePastDueMinor: collectible, reviewMinor: row.reviewRequired ? row.outstandingMinor : 0 });
    return map;
  }, new Map<string, (typeof financialRows)[number] & { collectiblePastDueMinor: number; reviewMinor: number }>()).values()]
  const pastDueBowlers = groupedFinancialRows
    .filter((row) => row.collectiblePastDueMinor > 0 || row.reviewRequired)
    .flatMap((row) => {
      const bowler = bowlers.find((candidate) => candidate.id === row.bowlerId);
      const league = leagues.find((candidate) => candidate.id === row.leagueId);
      const association = bowlerLeagues.find((candidate) => candidate.bowlerId === row.bowlerId && candidate.leagueId === row.leagueId && candidate.active);
      const team = teams.find((candidate) => candidate.id === (row.teamId ?? association?.teamId));
      if (!bowler || !league || !league.active || !team || (row.mode !== "canonical" && (!bowler.active || !association))) return [];
      return [{ bowler, team, league, weeksPastDueDisplay: row.reviewRequired ? "Review required" : league.paymentMode === "upfront" ? "Full season" : "—", pastDueAmount: row.collectiblePastDueMinor, reviewRequired: row.reviewRequired }];
    })
    .sort((a, b) => b.pastDueAmount - a.pastDueAmount);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold mb-2">Past Due Balances</h2>
        <p className="text-sm text-muted-foreground">
          Bowlers with outstanding payments · source: versioned server financial contract
        </p>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Bowler Name</TableHead>
              <TableHead>League</TableHead>
              <TableHead className={cn("hidden md:table-cell")}>Team</TableHead>
              <TableHead className={cn("hidden md:table-cell")}>Weeks Past Due</TableHead>
              <TableHead>Past Due Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pastDueBowlers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={isMobile ? 3 : 5} className="text-center py-4">
                  No past due balances found
                </TableCell>
              </TableRow>
            ) : (
              pastDueBowlers.slice(0, 5).map(item => (
                <TableRow key={`${item.bowler.id}-${item.league.id}`}>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <CheckCircle2 className={`size-4 ${item.bowler.hasAccount ? "text-green-500" : "text-muted-foreground/40"}`} />
                      <Link href={`/bowlers/${item.bowler.id}?from=home`} className="hover:underline">
                        {item.bowler.name}
                      </Link>
                    </div>
                  </TableCell>
                  <TableCell>{item.league.name}</TableCell>
                  <TableCell className={cn("hidden md:table-cell")}>{item.team.name}</TableCell>
                  <TableCell className={cn("hidden md:table-cell")}>{item.weeksPastDueDisplay}</TableCell>
                  <TableCell className="text-destructive">
                    {`$${(item.pastDueAmount / 100).toFixed(2)}`}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      {pastDueBowlers.length > 5 && (
        <div className="text-right">
          <Link href="/reports/past-due" className="text-sm text-primary hover:underline">
            View all past due balances →
          </Link>
        </div>
      )}
    </div>
  );
}
