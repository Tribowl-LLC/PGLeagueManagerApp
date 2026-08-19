import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Layout } from "@/components/layout";
import { BowlerForm } from "@/components/bowler-form";
import { ErrorBoundary } from "@/components/error-boundary";
import { AssignBowlerForm } from "@/components/assign-bowler-form";
import { ReorderBowlersDialog } from "@/components/reorder-bowlers-dialog";
import { PageLoadingState, PageErrorState } from "@/components/page-states";
import type { Bowler, BowlerLeague, ApiResponse, TeamDetailsResponse, User } from "@shared/schema";
import { useParams } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { getTeamBowlers } from "@/lib/bowler-league-utils";
import { TeamViewHeader } from "./team-view-page/header";
import { TeamViewBowlersTable } from "./team-view-page/bowlers-table";
import { TeamViewEditDialog } from "./team-view-page/edit-dialog";
import { TeamViewRemoveBowlerDialog } from "./team-view-page/remove-bowler-dialog";

const editTeamSchema = z.object({
  name: z.string().min(1, "Team name is required"),
});

export default function TeamViewPage() {
  const [showForm, setShowForm] = useState(false);
  const [showAssignForm, setShowAssignForm] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showReorderDialog, setShowReorderDialog] = useState(false);
  const [selectedBowler, setSelectedBowler] = useState<Bowler | undefined>();
  const [showRemoveDialog, setShowRemoveDialog] = useState<{ bowlerId: number; name: string } | null>(null);
  const { toast } = useToast();
  const params = useParams();
  const teamId = params.teamId ? parseInt(params.teamId) : undefined;
  const { data: currentUserResponse } = useQuery<ApiResponse<User>>({
    queryKey: ["/api/user"],
    staleTime: 5 * 60 * 1000,
  });
  const canManageRoster = currentUserResponse?.data?.role === "org_admin"
    || currentUserResponse?.data?.role === "system_admin";

  // Form for editing team name
  const editForm = useForm({
    resolver: zodResolver(editTeamSchema),
    defaultValues: {
      name: "",
    },
  });

  const { data: detailsResponse, isLoading: loadingDetails, error: detailsError, refetch: refetchDetails } = useQuery<ApiResponse<TeamDetailsResponse>>({
    queryKey: [`/api/teams/${teamId}/details`],
    enabled: !!teamId,
    retry: false,
  });

  const team = detailsResponse?.data?.team;
  const league = detailsResponse?.data?.league;
  const bowlerLeagues = useMemo(() => detailsResponse?.data?.bowlerLeagues || [], [detailsResponse?.data?.bowlerLeagues]);
  const bowlers = useMemo(() => detailsResponse?.data?.bowlers || [], [detailsResponse?.data?.bowlers]);

  const teamBowlers = useMemo(
    () => getTeamBowlers(bowlerLeagues, bowlers, teamId),
    [bowlerLeagues, bowlers, teamId]
  );

  const updateTeamMutation = useMutation({
    mutationFn: async (values: z.infer<typeof editTeamSchema>) => {
      if (!teamId) throw new Error("No team ID provided");
      const response = await apiRequest(`/api/teams/${teamId}`, "PATCH", values);
      if (!response.success) {
        throw new Error(response.error?.message || "Failed to update team");
      }
      return response.data;
    },
    onSuccess: (updatedTeam) => {
      queryClient.invalidateQueries({ queryKey: [`/api/teams/${teamId}/details`] });
      queryClient.invalidateQueries({ queryKey: ["/api/teams"] });
      setShowEditDialog(false);
      toast({
        title: "Team updated",
        description: "Team name has been updated successfully.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error updating team",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const removeBowlerMutation = useMutation({
    mutationFn: async ({ bowlerId }: { bowlerId: number }) => {
      const bowlerLeague = bowlerLeagues.find((bl: BowlerLeague) =>
        bl.bowlerId === bowlerId &&
        bl.teamId === teamId &&
        bl.leagueId === team?.leagueId &&
        bl.active
      );

      if (!bowlerLeague) {
        throw new Error("Bowler league association not found");
      }

      return await apiRequest(
        `/api/bowler-leagues/${bowlerLeague.id}`,
        "DELETE"
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/teams/${teamId}/details`] });
      setShowRemoveDialog(null);
      toast({
        title: "Bowler removed",
        description: "Bowler has been removed from the team.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error removing bowler",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleEditClick = () => {
    if (team) {
      editForm.reset({ name: team.name });
      setShowEditDialog(true);
    }
  };

  const onEditTeam = (values: z.infer<typeof editTeamSchema>) => {
    updateTeamMutation.mutate(values);
  };

  const handleRemoveBowler = async () => {
    if (!showRemoveDialog) return;
    await removeBowlerMutation.mutate({ bowlerId: showRemoveDialog.bowlerId });
  };

  if (!teamId) {
    return (
      <Layout>
        <div className="text-center text-destructive">Invalid team ID</div>
      </Layout>
    );
  }

  // Handle loading states with proper error display
  if (detailsError) {
    return (
      <Layout>
        <PageErrorState message={`Error loading team: ${detailsError.message}`} onRetry={() => refetchDetails()} />
      </Layout>
    );
  }

  if (loadingDetails) {
    return (
      <Layout>
        <PageLoadingState />
      </Layout>
    );
  }

  if (!team) {
    return (
      <Layout>
        <div className="text-center text-destructive">Team not found</div>
      </Layout>
    );
  }

  return (
    <Layout>
      <ErrorBoundary level="section">
      <TeamViewHeader
        teamName={team.name}
        leagueId={team.leagueId}
        onEditClick={canManageRoster ? handleEditClick : undefined}
        onCreateBowler={canManageRoster ? () => setShowForm(true) : undefined}
        onAddExistingBowler={canManageRoster ? () => setShowAssignForm(true) : undefined}
      />


      <TeamViewBowlersTable
        teamBowlers={teamBowlers}
        league={league}
        teamId={teamId}
        onEditBowler={canManageRoster ? (bowler) => {
          setSelectedBowler(bowler);
          setShowForm(true);
        } : undefined}
        onRemoveBowler={canManageRoster ? (target) => setShowRemoveDialog(target) : undefined}
      />

      {canManageRoster && teamBowlers.length > 1 && (
        <div className="mt-4">
          <Button variant="outline" onClick={() => setShowReorderDialog(true)}>
            Reorder Bowlers
          </Button>
        </div>
      )}

      {/* Edit Team Dialog */}
      {canManageRoster && <TeamViewEditDialog
        open={showEditDialog}
        onOpenChange={setShowEditDialog}
        form={editForm}
        onSubmit={onEditTeam}
        isPending={updateTeamMutation.isPending}
      />}

      {/* Bowler Forms */}
      {canManageRoster && <BowlerForm
          open={showForm}
          onClose={() => {
            setShowForm(false);
            setSelectedBowler(undefined);
          }}
          defaultTeamId={teamId}
          bowler={selectedBowler}
        />}

      {canManageRoster && <AssignBowlerForm
        open={showAssignForm}
        onClose={() => setShowAssignForm(false)}
        teamId={teamId}
        leagueId={team?.leagueId}
      />}

      {canManageRoster && <ReorderBowlersDialog
        open={showReorderDialog}
        onClose={() => setShowReorderDialog(false)}
        bowlers={bowlers}
        bowlerLeagues={bowlerLeagues}
        teamId={teamId}
        leagueId={team?.leagueId}
      />}

      {/* Remove Bowler Confirmation Dialog */}
      {canManageRoster && <TeamViewRemoveBowlerDialog
        target={showRemoveDialog}
        onOpenChange={(open) => !open && setShowRemoveDialog(null)}
        onCancel={() => setShowRemoveDialog(null)}
        onConfirm={handleRemoveBowler}
        isPending={removeBowlerMutation.isPending}
      />}
      </ErrorBoundary>
    </Layout>
  );
}
