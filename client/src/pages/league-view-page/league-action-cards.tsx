import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { CalendarDays, Users, CircleDollarSign, ClipboardPenLine } from "lucide-react";
import { Link } from "wouter";

export function LeagueActionCards({
  leagueId,
  canManageRoster,
  canManagePayments,
}: {
  leagueId: number;
  canManageRoster: boolean;
  canManagePayments: boolean;
}) {
  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-4">
      <Link href={`/leagues/${leagueId}/teams`} className="block">
        <Card className="hover:bg-accent transition-colors">
          <CardHeader>
            <div className="flex justify-center mb-2">
              <Users className="size-6" />
            </div>
            <CardTitle>{canManageRoster ? "Roster Management" : "Team Rosters"}</CardTitle>
            <CardDescription>
              {canManageRoster ? "Manage bowlers and teams in your league" : "View bowlers and teams in your league"}
            </CardDescription>
          </CardHeader>
          <CardContent>
          </CardContent>
        </Card>
      </Link>

      {canManagePayments && (
        <Link href={`/leagues/${leagueId}/payments/manage`} className="block">
          <Card className="hover:bg-accent transition-colors">
            <CardHeader>
              <div className="mb-2 flex justify-center">
                <ClipboardPenLine className="size-6" />
              </div>
              <CardTitle>Manage Payments</CardTitle>
              <CardDescription>
                Record cash and check payments for this league
              </CardDescription>
            </CardHeader>
            <CardContent />
          </Card>
        </Link>
      )}

      {canManagePayments && (
        <Link href={`/payments?leagueId=${leagueId}`} className="block">
          <Card className="hover:bg-accent transition-colors">
            <CardHeader>
              <div className="flex justify-center mb-2">
                <CircleDollarSign className="size-6" />
              </div>
              <CardTitle>Payment Records</CardTitle>
              <CardDescription>
                Review recorded league payments
              </CardDescription>
            </CardHeader>
            <CardContent>
            </CardContent>
          </Card>
        </Link>
      )}

      <Link href={`/leagues/${leagueId}/schedule`} className="block">
        <Card className="hover:bg-accent transition-colors">
          <CardHeader>
            <div className="flex justify-center mb-2">
              <CalendarDays className="size-6" />
            </div>
            <CardTitle>League Schedule</CardTitle>
            <CardDescription>
              {canManageRoster ? "View and manage league dates" : "View league dates"}
            </CardDescription>
          </CardHeader>
          <CardContent>
          </CardContent>
        </Card>
      </Link>
    </div>
  );
}
