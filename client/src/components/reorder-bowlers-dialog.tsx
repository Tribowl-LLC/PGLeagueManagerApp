import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2, ArrowUp, ArrowDown } from "lucide-react";
import type { Bowler, BowlerLeague } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { logger } from "@/lib/logger";
import { useToast } from "@/hooks/use-toast";

interface ReorderBowlersDialogProps {
  open: boolean;
  onClose: () => void;
  bowlers: Bowler[];
  bowlerLeagues: BowlerLeague[];
  teamId: number;
  leagueId: number;
}

export function ReorderBowlersDialog({
  open,
  onClose,
  bowlers,
  bowlerLeagues,
  teamId,
  leagueId,
}: ReorderBowlersDialogProps) {
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [orderedLeagues, setOrderedLeagues] = useState<BowlerLeague[]>([]);

  // Initialize order when dialog opens
  useEffect(() => {
    if (open) {
      const initialLeagues = [...bowlerLeagues]
        .filter(bl => bl.teamId === teamId && bl.leagueId === leagueId && bl.active)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((bl, index) => ({
          ...bl,
          order: index
        }));
      setOrderedLeagues(initialLeagues);
    }
  }, [open, bowlerLeagues, teamId, leagueId]);

  const moveItem = (index: number, direction: "up" | "down") => {
    setOrderedLeagues(prevLeagues => {
      const newIndex = direction === "up" ? index - 1 : index + 1;

      if (newIndex < 0 || newIndex >= prevLeagues.length) {
        return prevLeagues;
      }

      // Create deep copies with new order values
      const newLeagues = prevLeagues.map(bl => ({ ...bl }));

      // Update orders
      const movingLeague = { ...newLeagues[index], order: newIndex };
      const swappingLeague = { ...newLeagues[newIndex], order: index };

      // Update array
      newLeagues[newIndex] = movingLeague;
      newLeagues[index] = swappingLeague;

      return newLeagues;
    });
  };

  const handleSave = async () => {
    try {
      setIsSubmitting(true);

      const updates = orderedLeagues.map((bl, index) => 
        apiRequest(`/api/bowler-leagues/${bl.id}`, "PATCH", {
          bowlerId: bl.bowlerId,
          leagueId: bl.leagueId,
          teamId: bl.teamId,
          active: bl.active,
          order: index
        })
      );

      await Promise.all(updates);

      queryClient.invalidateQueries({ queryKey: ["/api/bowler-leagues"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bowlers"] });
      queryClient.invalidateQueries({ queryKey: [`/api/teams/${teamId}`] });
      queryClient.invalidateQueries({ queryKey: [`/api/teams/${teamId}/details`] });

      toast({
        title: "Success",
        description: "Bowler order updated successfully",
      });

      onClose();
    } catch (error) {
      logger.error('ReorderBowlers', 'Error updating order', error);
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reorder Bowlers</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="border rounded-md divide-y">
            {orderedLeagues.map((bl, index) => {
              const bowler = bowlers.find(b => b.id === bl.bowlerId);
              if (!bowler) return null;

              return (
                <div
                  key={`${bl.id}-${index}`}
                  className="flex items-center justify-between p-3"
                >
                  <span className="font-medium">{bowler.name}</span>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => moveItem(index, "up")}
                      disabled={index === 0 || isSubmitting}
                    >
                      <ArrowUp className="size-4" />
                      <span className="sr-only">Move up</span>
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => moveItem(index, "down")}
                      disabled={index === orderedLeagues.length - 1 || isSubmitting}
                    >
                      <ArrowDown className="size-4" />
                      <span className="sr-only">Move down</span>
                    </Button>
                  </div>
                </div>
              );
            })}
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