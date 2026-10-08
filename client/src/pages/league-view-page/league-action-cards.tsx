import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { CalendarDays, Users } from "lucide-react";
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
      {(canManageRoster || canManagePayments) && <Link href={`/leagues/${leagueId}/teams`} className="block">
        <Card interaction="accent">
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
      </Link>}

      <Link href={`/leagues/${leagueId}/schedule`} className="block">
        <Card interaction="accent">
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
