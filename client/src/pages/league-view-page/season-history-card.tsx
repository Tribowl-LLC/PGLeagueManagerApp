import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { History } from "lucide-react";
import { Link } from "wouter";
import type { League } from "@shared/schema";
import { getSeasonLabel } from "@shared/season-utils";

export function SeasonHistoryCard({
  seasonHistory,
  leagueId,
}: {
  seasonHistory: League[];
  leagueId: number;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <History className="size-5" />
          <CardTitle size="lg">Season History</CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-2">
          {seasonHistory.map((season) => (
            <Link key={season.id} href={`/leagues/${season.id}`}>
              <Badge
                variant={season.id === leagueId ? "default" : "outline"}
                interactive="accent" className="cursor-pointer"
              >
                {getSeasonLabel(season.seasonStart, season.seasonEnd)}
                {!season.active && season.id !== leagueId && " (Archived)"}
              </Badge>
            </Link>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
