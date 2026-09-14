import { useState, useEffect, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, GripVertical } from "lucide-react";
import type { Team } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface ReorderTeamsDialogProps {
  open: boolean;
  onClose: () => void;
  teams: Team[];
  leagueId: number;
}

export function ReorderTeamsDialog({
  open,
  onClose,
  teams,
  leagueId,
}: ReorderTeamsDialogProps) {
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [orderedTeams, setOrderedTeams] = useState<Team[]>([]);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const dragItem = useRef<number | null>(null);

  useEffect(() => {
    if (open) {
      const sorted = teams.toSorted((a, b) => {
        if (a.displayOrder !== b.displayOrder) return a.displayOrder - b.displayOrder;
        return (a.number ?? 0) - (b.number ?? 0);
      });
      setOrderedTeams(sorted);
      setDragIndex(null);
      setDragOverIndex(null);
    }
  }, [open, teams]);

  const handlePositionChange = (currentIndex: number, newPositionStr: string) => {
    const newPosition = parseInt(newPositionStr);
    if (isNaN(newPosition) || newPosition < 1 || newPosition > orderedTeams.length) return;

    const targetIndex = newPosition - 1;
    if (targetIndex === currentIndex) return;

    setOrderedTeams(prev => {
      const newOrder = [...prev];
      const [removed] = newOrder.splice(currentIndex, 1);
      newOrder.splice(targetIndex, 0, removed);
      return newOrder;
    });
  };

  const handleDragStart = (index: number) => {
    dragItem.current = index;
    setDragIndex(index);
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    setDragOverIndex(index);
  };

  const handleDrop = (index: number) => {
    if (dragItem.current === null || dragItem.current === index) {
      setDragIndex(null);
      setDragOverIndex(null);
      return;
    }

    setOrderedTeams(prev => {
      const newOrder = [...prev];
      const [removed] = newOrder.splice(dragItem.current!, 1);
      newOrder.splice(index, 0, removed);
      return newOrder;
    });

    dragItem.current = null;
    setDragIndex(null);
    setDragOverIndex(null);
  };

  const handleDragEnd = () => {
    setDragIndex(null);
    setDragOverIndex(null);
  };

  const handleSave = async () => {
    try {
      setIsSubmitting(true);

      const updates = orderedTeams.map((team, index) => ({
        id: team.id,
        displayOrder: index,
        number: index + 1,
      }));

      await apiRequest("/api/teams/reorder", "PATCH", { teams: updates });

      queryClient.invalidateQueries({ queryKey: ["/api/teams", leagueId] });
      queryClient.invalidateQueries({ queryKey: ["/api/bowler-leagues"] });

      toast({
        title: "Success",
        description: "Team order updated successfully",
      });

      onClose();
    } catch (error) {
      toast({
        title: "Error updating order",
        description: error instanceof Error ? error.message : "Failed to update order",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent viewport="tall" className="flex flex-col">
        <DialogHeader>
          <DialogTitle>Reorder Teams</DialogTitle>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">
          Drag teams or type a new position number to reorder.
        </p>

        <div className="space-y-4">
          <div className="border rounded-md divide-y max-h-reorder-viewport overflow-y-auto">
            {orderedTeams.map((team, index) => (
              <div
                key={team.id}
                draggable
                onDragStart={() => handleDragStart(index)}
                onDragOver={(e) => handleDragOver(e, index)}
                onDrop={() => handleDrop(index)}
                onDragEnd={handleDragEnd}
                className={`flex items-center gap-3 p-3 cursor-grab active:cursor-grabbing transition-colors ${
                  dragIndex === index ? "opacity-50 bg-muted" : ""
                } ${dragOverIndex === index && dragIndex !== index ? "bg-accent" : ""}`}
              >
                <GripVertical className="size-4 text-muted-foreground shrink-0" />
                <Input
                  type="number"
                  min={1}
                  max={orderedTeams.length}
                  defaultValue={index + 1}
                  key={`${team.id}-${index}`}
                  padding="compact"
                  className="w-14 h-8 text-center"
                  onBlur={(e) => handlePositionChange(index, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                  onDragStart={(e) => e.stopPropagation()}
                  draggable={false}
                />
                <span className="font-medium flex-1">
                  {team.number ? `#${team.number} - ` : ""}{team.name}
                </span>
              </div>
            ))}
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={isSubmitting}
              className="min-w-20"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Saving…
                </>
              ) : (
                'Save Order'
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
