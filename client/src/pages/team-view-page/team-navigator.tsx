import { useMemo } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Team } from "@shared/schema";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface TeamNavigatorProps {
  teams: Team[];
  currentTeamId: number;
  onTeamChange: (teamId: number) => void;
}

export function orderLeagueTeams(teams: Team[]): Team[] {
  return teams.toSorted((a, b) => {
    if (a.displayOrder !== b.displayOrder) return a.displayOrder - b.displayOrder;
    if ((a.number ?? Number.MAX_SAFE_INTEGER) !== (b.number ?? Number.MAX_SAFE_INTEGER)) {
      return (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER);
    }
    const nameComparison = a.name.localeCompare(b.name);
    return nameComparison !== 0 ? nameComparison : a.id - b.id;
  });
}

function teamLabel(team: Team): string {
  const number = team.number ? `#${team.number} - ` : "";
  const archived = team.active ? "" : " (Archived)";
  return `${number}${team.name}${archived}`;
}

export function TeamNavigator({ teams, currentTeamId, onTeamChange }: TeamNavigatorProps) {
  const orderedTeams = useMemo(() => orderLeagueTeams(teams), [teams]);
  const currentIndex = orderedTeams.findIndex((team) => team.id === currentTeamId);
  const previousTeam = currentIndex > 0 ? orderedTeams[currentIndex - 1] : undefined;
  const nextTeam = currentIndex >= 0 && currentIndex < orderedTeams.length - 1
    ? orderedTeams[currentIndex + 1]
    : undefined;

  return (
    <nav aria-label="Team navigation" className="mb-4 flex w-full items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="shrink-0"
        aria-label={previousTeam ? `Previous team: ${previousTeam.name}` : "No previous team"}
        title={previousTeam ? `Previous team: ${previousTeam.name}` : "No previous team"}
        disabled={!previousTeam}
        onClick={() => previousTeam && onTeamChange(previousTeam.id)}
      >
        <ChevronLeft className="size-4" />
      </Button>

      <Select
        value={orderedTeams.some((team) => team.id === currentTeamId) ? String(currentTeamId) : undefined}
        onValueChange={(value) => onTeamChange(Number(value))}
        disabled={orderedTeams.length <= 1}
      >
        <SelectTrigger className="min-w-0 flex-1 sm:max-w-sm" aria-label="Select team">
          <SelectValue placeholder="Select a team" />
        </SelectTrigger>
        <SelectContent>
          {orderedTeams.map((team) => (
            <SelectItem key={team.id} value={String(team.id)}>
              {teamLabel(team)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Button
        type="button"
        variant="outline"
        size="icon"
        className="shrink-0"
        aria-label={nextTeam ? `Next team: ${nextTeam.name}` : "No next team"}
        title={nextTeam ? `Next team: ${nextTeam.name}` : "No next team"}
        disabled={!nextTeam}
        onClick={() => nextTeam && onTeamChange(nextTeam.id)}
      >
        <ChevronRight className="size-4" />
      </Button>
    </nav>
  );
}
