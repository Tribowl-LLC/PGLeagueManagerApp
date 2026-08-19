import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Link } from "wouter";
import { CheckCircle2, Pencil, Trash2 } from "lucide-react";
import type { Bowler, League, BowlerWithAccount } from "@shared/schema";
import type { TeamBowlerEntry } from "@/lib/bowler-league-utils";

interface TeamViewBowlersTableProps {
  teamBowlers: TeamBowlerEntry<BowlerWithAccount>[];
  league: League | undefined;
  teamId: number;
  onEditBowler?: (bowler: Bowler) => void;
  onRemoveBowler?: (target: { bowlerId: number; name: string }) => void;
}

export function TeamViewBowlersTable({
  teamBowlers,
  league,
  teamId,
  onEditBowler,
  onRemoveBowler,
}: TeamViewBowlersTableProps) {
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Weekly Fee</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {teamBowlers.length > 0 ? (
            teamBowlers.map(({ bowler, bowlerLeague }) => (
              <TableRow key={bowlerLeague.id}>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <CheckCircle2 className={`size-4 ${bowler.hasAccount ? "text-green-500" : "text-muted-foreground/40"}`} />
                    <Link href={`/bowlers/${bowler.id}?from=team&fromTeamId=${teamId}`} className="hover:underline">
                      {bowler.name}
                    </Link>
                  </div>
                </TableCell>
                <TableCell>${((league?.weeklyFee || 0) / 100).toFixed(2)}</TableCell>
                <TableCell>
                  <Badge variant={bowlerLeague.active ? "default" : "secondary"}>
                    {bowlerLeague.active ? "Active" : "Inactive"}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    {onEditBowler && <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onEditBowler(bowler)}
                      >
                        <Pencil className="size-4 mr-2" />
                        Edit
                      </Button>}
                    {onRemoveBowler && <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onRemoveBowler({ bowlerId: bowler.id, name: bowler.name })}
                    >
                      <Trash2 className="size-4 mr-2" />
                      Remove
                    </Button>}
                  </div>
                </TableCell>
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={4} className="text-center">
                No bowlers assigned to this team
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
