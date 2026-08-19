import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Users, CircleDollarSign } from "lucide-react";
import { Link } from "wouter";

export function LeagueActionCards({ leagueId, canManageRoster }: { leagueId: number; canManageRoster: boolean }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
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

      <Link href={`/leagues/${leagueId}/weekly-payments`} className="block">
        <Card className="hover:bg-accent transition-colors">
          <CardHeader>
            <div className="flex justify-center mb-2">
              <CircleDollarSign className="size-6" />
            </div>
            <CardTitle>Weekly Payments</CardTitle>
            <CardDescription>
              Log and track weekly cash/check payments
            </CardDescription>
          </CardHeader>
          <CardContent>
          </CardContent>
        </Card>
      </Link>
    </div>
  );
}
