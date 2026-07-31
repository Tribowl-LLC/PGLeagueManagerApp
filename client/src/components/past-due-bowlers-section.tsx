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
import type { League, Team, Bowler, Payment, BowlerLeague, BowlerWithAccount } from "@shared/schema";
import { calculateBowlerPastDue } from "@/lib/financial-utils";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

export function PastDueBowlersSection() {
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

  const { data: paymentsResponse } = useQuery<{ data: Payment[] }>({
    queryKey: ["/api/payments"],
  });
  const payments = paymentsResponse?.data || [];

  // Calculate past due details for each bowler in each league
  const pastDueBowlers = bowlers
    .flatMap(bowler => {
      if (!bowler.active) return [];
      const bowlerAssociations = bowlerLeagues.filter(
        bl => bl.bowlerId === bowler.id && bl.active,
      );

      return bowlerAssociations.flatMap(association => {
        const league = leagues.find(l => l.id === association.leagueId);
        const team = teams.find(t => t.id === association.teamId);

        if (!league || !league.active || !team || !league.seasonStart) {
          return [];
        }

        const leaguePayments = payments.filter(p =>
          p.bowlerId === bowler.id &&
          p.leagueId === league.id &&
          p.status === 'paid'
        );

        const totalPaid = leaguePayments.reduce((sum, p) => sum + p.amount, 0);
        // Use the shared upfront-aware past-due helper so this table matches
        // the per-bowler view, the dashboard stat, and the past-due reports.
        const pastDueAmount = calculateBowlerPastDue(league, totalPaid);
        const isUpfront = league.paymentMode === "upfront";
        const weeksPastDueDisplay: string = isUpfront
          ? "Full season"
          : league.weeklyFee > 0
            ? String(Math.floor(pastDueAmount / league.weeklyFee))
            : "0";

        return pastDueAmount > 0 ? [{
          bowler,
          team,
          league,
          weeksPastDueDisplay,
          pastDueAmount,
        }] : [];
      });
    })
    .sort((a, b) => b.pastDueAmount - a.pastDueAmount);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold mb-2">Past Due Balances</h2>
        <p className="text-sm text-muted-foreground">
          Bowlers with outstanding payments
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
                    ${(item.pastDueAmount / 100).toFixed(2)}
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
