import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { ArrowLeft, Pencil, Plus } from "lucide-react";

interface TeamViewHeaderProps {
  teamName: string;
  leagueId: number;
  onEditClick?: () => void;
  onCreateBowler?: () => void;
  onAddExistingBowler?: () => void;
}

export function TeamViewHeader({
  teamName,
  leagueId,
  onEditClick,
  onCreateBowler,
  onAddExistingBowler,
}: TeamViewHeaderProps) {
  return (
    <div className="mb-6">
      <Link
        href={`/leagues/${leagueId}/teams`}
        className="text-muted-foreground hover:text-foreground flex items-center mb-4"
      >
        <ArrowLeft className="size-4 mr-2" />
        Back to Teams
      </Link>
      <div className="flex flex-col gap-4 mb-6">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold flex-1">{teamName}</h1>
          {onEditClick && <Button variant="ghost" size="sm" onClick={onEditClick}>
            <Pencil className="size-4" />
            <span className="sr-only">Edit team name</span>
          </Button>}
        </div>
        {(onCreateBowler || onAddExistingBowler) && <div className="flex gap-2">
          {onCreateBowler && <Button onClick={onCreateBowler}>
            <Plus className="size-4 mr-2" />
            Create New Bowler
          </Button>}
          {onAddExistingBowler && <Button onClick={onAddExistingBowler}>
            <Plus className="size-4 mr-2" />
            Add Existing Bowler
          </Button>}
        </div>}
      </div>
    </div>
  );
}
