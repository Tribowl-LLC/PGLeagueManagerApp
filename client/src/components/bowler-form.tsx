import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
} from "@/components/ui/form";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { insertBowlerSchema, type InsertBowler, type Team, type League, type Bowler } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Loader2 } from "lucide-react";
import { useState, useCallback } from "react";
import { BowlerFormFields } from "./bowler-form-fields";
import { BowlerFormLeagueTeamSelect } from "./bowler-form-league-team-select";
import { BowlerFormDuplicateDialog } from "./bowler-form-duplicate-dialog";

interface CreateBowlerResponse {
  id: number;
  duplicate?: boolean;
  existingBowler?: { id: number; name: string; email: string };
}

interface BowlerFormProps {
  open: boolean;
  onClose: () => void;
  defaultTeamId?: number;
  bowler?: Bowler;
  bowlerLeagues?: { bowlerId: number; leagueId: number; teamId: number }[];
}

export function BowlerForm({ open, onClose, defaultTeamId, bowler, bowlerLeagues }: BowlerFormProps) {
  const firstLeagueId = bowlerLeagues && bowlerLeagues.length > 0 ? bowlerLeagues[0].leagueId : null;
  const firstTeamId = bowlerLeagues && bowlerLeagues.length > 0 ? bowlerLeagues[0].teamId : null;

  // Re-key the inner form so its state (RHF values + league/team
  // selection) re-initializes from props on each fresh open and when
  // the edited bowler / its first league assignment changes — replacing
  // the old open/bowler-driven reset effect. The inner stays mounted
  // while closed so the leagues query still prefetches as before.
  const formKey = `${open ? "open" : "closed"}-${bowler?.id ?? "new"}-${firstLeagueId ?? "x"}-${firstTeamId ?? "x"}`;

  return (
    <BowlerFormInner
      key={formKey}
      open={open}
      onClose={onClose}
      defaultTeamId={defaultTeamId}
      bowler={bowler}
      firstLeagueId={firstLeagueId}
      firstTeamId={firstTeamId}
    />
  );
}

interface BowlerFormInnerProps {
  open: boolean;
  onClose: () => void;
  defaultTeamId?: number;
  bowler?: Bowler;
  firstLeagueId: number | null;
  firstTeamId: number | null;
}

function BowlerFormInner({ open, onClose, defaultTeamId, bowler, firstLeagueId, firstTeamId }: BowlerFormInnerProps) {
  const { toast } = useToast();
  const [selectedLeagueId, setSelectedLeagueId] = useState<number | null>(bowler ? firstLeagueId : null);
  const [selectedTeamId, setSelectedTeamId] = useState<number | null>(bowler ? firstTeamId : null);
  const [duplicateBowler, setDuplicateBowler] = useState<{ id: number; name: string; email: string } | null>(null);

  // Move form initialization before any conditional logic
  const form = useForm<InsertBowler>({
    resolver: zodResolver(insertBowlerSchema),
    defaultValues: {
      name: bowler?.name ?? "",
      email: bowler?.email ?? "",
      phone: bowler?.phone ?? "",
      active: bowler?.active ?? true,
    },
  });

  // Query for leagues with proper caching
  const { data: leaguesResponse, isLoading: loadingLeagues } = useQuery<{ success: true, data: League[] }>({
    queryKey: ["/api/leagues"],
    staleTime: 1000 * 60 * 30, // Cache for 30 minutes as league data changes very infrequently
  });

  const leagues = leaguesResponse?.data || [];

  // Query for teams filtered by selected league with proper caching
  const { data: teamsResponse, isLoading: loadingTeams } = useQuery<{ success: true, data: Team[] }>({
    queryKey: ["/api/teams", selectedLeagueId],
    queryFn: () =>
      selectedLeagueId
        ? fetch(`/api/teams?leagueId=${selectedLeagueId}`).then((res) => res.json())
        : Promise.resolve({ success: true, data: [] }),
    enabled: !!selectedLeagueId,
    staleTime: 1000 * 60 * 15, // Cache for 15 minutes as team data changes less frequently
  });

  const teams = teamsResponse?.data || [];

  // Memoize mutation callbacks with proper dependencies
  const onSuccess = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["/api/bowlers"] });
    toast({
      title: bowler ? "Bowler updated" : "Bowler created",
      description: bowler
        ? "Bowler has been updated successfully."
        : "Bowler has been added to the system.",
    });
    onClose();
  }, [bowler, onClose, toast]);

  const onError = useCallback((error: Error) => {
    toast({
      title: bowler ? "Error updating bowler" : "Error creating bowler",
      description: error.message,
      variant: "destructive",
    });
  }, [bowler, toast]);

  const addExistingBowlerMutation = useMutation({
    mutationFn: async (existingBowlerId: number) => {
      if (!selectedLeagueId || !selectedTeamId) {
        throw new Error("Please select a league and team first");
      }
      const result = await apiRequest("/api/bowler-leagues", "POST", {
        bowlerId: existingBowlerId,
        leagueId: selectedLeagueId,
        teamId: selectedTeamId,
        active: true,
      });
      if (!result.success) {
        throw new Error(result.error?.message || "Failed to add bowler to team");
      }
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bowlers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bowler-leagues"] });
      if (defaultTeamId) {
        queryClient.invalidateQueries({ queryKey: [`/api/teams/${defaultTeamId}/details`] });
      }
      toast({
        title: "Bowler added to team",
        description: "The existing bowler has been added to this team.",
      });
      setDuplicateBowler(null);
      setSelectedLeagueId(null);
      setSelectedTeamId(null);
      onClose();
    },
    onError,
  });

  const mutation = useMutation({
    mutationFn: async (data: InsertBowler) => {
      if (bowler) {
        const result = await apiRequest(`/api/bowlers/${bowler.id}`, "PATCH", data);
        if (!result.success) {
          throw new Error(result.error?.message || "Failed to update bowler");
        }
        return result;
      } else {
        const result = await apiRequest<CreateBowlerResponse>("/api/bowlers", "POST", data);
        if (!result.success) {
          throw new Error(result.error?.message || "Failed to create bowler");
        }
        if (result.data?.duplicate && result.data?.existingBowler) {
          setDuplicateBowler(result.data.existingBowler);
          return null;
        }
        const newBowlerId = result.data?.id;
        if (newBowlerId && selectedLeagueId && selectedTeamId) {
          await apiRequest("/api/bowler-leagues", "POST", {
            bowlerId: newBowlerId,
            leagueId: selectedLeagueId,
            teamId: selectedTeamId,
            active: true,
          });
        }
        return result;
      }
    },
    onSuccess: (result) => {
      if (result === null) return;
      queryClient.invalidateQueries({ queryKey: ["/api/bowlers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bowler-leagues"] });
      if (bowler) {
        queryClient.invalidateQueries({ queryKey: [`/api/bowlers/${bowler.id}/details`] });
        queryClient.invalidateQueries({ queryKey: [`/api/bowlers/${bowler.id}`] });
      }
      if (defaultTeamId) {
        queryClient.invalidateQueries({ queryKey: [`/api/teams/${defaultTeamId}/details`] });
      }
      toast({
        title: bowler ? "Bowler updated" : "Bowler created",
        description: bowler
          ? "Bowler has been updated successfully."
          : "Bowler has been added to the system.",
      });
      setSelectedLeagueId(null);
      setSelectedTeamId(null);
      onClose();
    },
    onError,
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (!bowler) return;
      const result = await apiRequest(`/api/bowlers/${bowler.id}`, "DELETE");
      if (!result.success) {
        throw new Error(result.error?.message || "Failed to delete bowler");
      }
    },
    onSuccess,
    onError,
  });

  const isLoading = loadingLeagues || loadingTeams;

  return (
    <>
      <Dialog open={open} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{bowler ? "Edit Bowler" : "Add New Bowler"}</DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-8 animate-spin" />
          </div>
        ) : (
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit((data) => mutation.mutate(data))}
              className="space-y-4"
            >
              <BowlerFormFields control={form.control} />

              {!bowler && (
                <BowlerFormLeagueTeamSelect
                  leagues={leagues}
                  teams={teams}
                  loadingTeams={loadingTeams}
                  selectedLeagueId={selectedLeagueId}
                  selectedTeamId={selectedTeamId}
                  onLeagueChange={setSelectedLeagueId}
                  onTeamChange={setSelectedTeamId}
                />
              )}

              <FormField
                control={form.control}
                name="active"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-lg border p-3">
                    <div className="space-y-0.5">
                      <FormLabel>Active</FormLabel>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              <div className="flex justify-end gap-x-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={onClose}
                  disabled={mutation.isPending}
                >
                  Cancel
                </Button>
                <Button 
                  type="submit" 
                  disabled={mutation.isPending || isLoading}
                  className="min-w-[120px]"
                >
                  {mutation.isPending ? (
                    <>
                      <Loader2 className="mr-2 size-4 animate-spin" />
                      {bowler ? "Updating..." : "Creating..."}
                    </>
                  ) : (
                    bowler ? "Update" : "Add Bowler"
                  )}
                </Button>
              </div>

              {bowler && (
                <>
                  <Separator className="my-4" />
                  <div className="flex justify-center">
                    <Button
                      type="button"
                      variant="destructive"
                      onClick={() => deleteMutation.mutate()}
                      disabled={deleteMutation.isPending}
                      className="min-w-[120px]"
                    >
                      {deleteMutation.isPending ? (
                        <>
                          <Loader2 className="mr-2 size-4 animate-spin" />
                          Deleting…
                        </>
                      ) : (
                        "Delete Bowler"
                      )}
                    </Button>
                  </div>
                </>
              )}
            </form>
          </Form>
        )}
      </DialogContent>
    </Dialog>

      <BowlerFormDuplicateDialog
        duplicateBowler={duplicateBowler}
        onOpenChange={(open) => { if (!open) setDuplicateBowler(null); }}
        onCancel={() => setDuplicateBowler(null)}
        onConfirm={() => {
          if (duplicateBowler) {
            addExistingBowlerMutation.mutate(duplicateBowler.id);
          }
        }}
        isPending={addExistingBowlerMutation.isPending}
        selectedLeagueId={selectedLeagueId}
        selectedTeamId={selectedTeamId}
      />
    </>
  );
}
