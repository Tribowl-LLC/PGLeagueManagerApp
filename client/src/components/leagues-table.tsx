import { format } from "date-fns";
import { Pencil, Archive, RotateCcw, Trash } from "lucide-react";
import { Link } from "wouter";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getSeasonLabel } from "@shared/season-utils";
import type { League } from "@shared/schema";

interface Props {
  leagues: League[];
  teamCounts: Record<number, number>;
  locationMap: Record<number, string>;
  onEdit: (league: League) => void;
  onArchive: (id: number) => void;
  onRestore: (id: number) => void;
  onDelete: (id: number) => void;
  isRestorePending: boolean;
  canManage?: boolean;
}

export function LeaguesTable({
  leagues,
  teamCounts,
  locationMap,
  onEdit,
  onArchive,
  onRestore,
  onDelete,
  isRestorePending,
  canManage = true,
}: Props) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[12%]">Weekday</TableHead>
          <TableHead className="w-[20%]">Name</TableHead>
          <TableHead className="hidden md:table-cell">Location</TableHead>
          <TableHead className="hidden md:table-cell">Teams</TableHead>
          <TableHead className="hidden md:table-cell w-[15%]">Start Date</TableHead>
          <TableHead className="hidden md:table-cell w-[15%]">End Date</TableHead>
          <TableHead className="hidden md:table-cell">Duration</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {leagues.map((league) => {
          const startDate = new Date(league.seasonStart);
          const endDate = new Date(league.seasonEnd);
          const bowlingDay = league.weekDay
            ? league.weekDay.charAt(0).toUpperCase() + league.weekDay.slice(1)
            : "Not set";
          return (
            <TableRow key={league.id} className={!league.active ? "opacity-60" : ""}>
              <TableCell>{bowlingDay}</TableCell>
              <TableCell>
                <Link href={`/leagues/${league.id}`} className="text-foreground hover:underline font-medium">
                  {league.name}
                </Link>
                <p className="text-xs text-muted-foreground">
                  {getSeasonLabel(league.seasonStart, league.seasonEnd)}
                </p>
              </TableCell>
              <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                {league.locationId ? locationMap[league.locationId] || "—" : "—"}
              </TableCell>
              <TableCell className="hidden md:table-cell">{teamCounts[league.id] || 0}</TableCell>
              <TableCell className="hidden md:table-cell whitespace-nowrap">
                {format(startDate, "MMM d, yyyy")}
              </TableCell>
              <TableCell className="hidden md:table-cell whitespace-nowrap">
                {format(endDate, "MMM d, yyyy")}
              </TableCell>
              <TableCell className="hidden md:table-cell">{league.totalBowlingWeeks} weeks</TableCell>
              <TableCell>
                <Badge variant={league.active ? "default" : "secondary"}>
                  {league.active ? "Active" : "Archived"}
                </Badge>
              </TableCell>
              <TableCell>
                <div className="flex gap-x-2">
                  {canManage && <>
                    <Button variant="outline" size="sm" onClick={() => onEdit(league)}>
                      <Pencil className="size-4" />
                    </Button>
                    {league.active ? (
                      <Button variant="outline" size="sm" onClick={() => onArchive(league.id)}>
                        <Archive className="size-4" />
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onRestore(league.id)}
                        disabled={isRestorePending}
                      >
                        <RotateCcw className="size-4" />
                      </Button>
                    )}
                    <Button variant="destructive" size="sm" onClick={() => onDelete(league.id)}>
                      <Trash className="size-4" />
                    </Button>
                  </>}
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
