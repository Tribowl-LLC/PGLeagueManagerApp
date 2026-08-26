import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Layout } from "@/components/layout";
import { ErrorBoundary } from "@/components/error-boundary";
import { TeamForm } from "@/components/team-form";
import { ReorderTeamsDialog } from "@/components/reorder-teams-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Plus, ArrowLeft, ArrowUpDown, MoreHorizontal, Archive, ArchiveRestore, Trash2, Loader2 } from "lucide-react";
import { PageLoadingState } from "@/components/page-states";
import type { ApiResponse, Team, League, User } from "@shared/schema";
import { useParams, Link } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

export default function TeamsPage() {
  const [showForm, setShowForm] = useState(false);
  const [showReorder, setShowReorder] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [archiveTeam, setArchiveTeam] = useState<Team | null>(null);
  const [deleteTeam, setDeleteTeam] = useState<Team | null>(null);
  const { toast } = useToast();
  const params = useParams();
  const leagueId = parseInt(params.leagueId!);
  const { data: currentUserResponse } = useQuery<ApiResponse<User>>({
    queryKey: ["/api/user"],
    staleTime: 5 * 60 * 1000,
  });
  const canManageRoster = currentUserResponse?.data?.role === "org_admin"
    || currentUserResponse?.data?.role === "system_admin";

  const { data: leagueResponse, isLoading: loadingLeague } = useQuery<{ data: League }>({
    queryKey: [`/api/leagues/${leagueId}`],
    enabled: !!leagueId,
    retry: false,
    staleTime: 1000 * 60 * 5,
  });

  const league = leagueResponse?.data;
  const isReadOnlyArchive = league !== undefined
    && (!league.active || league.scheduleAuthority === "retired_legacy");
  const canWriteRoster = canManageRoster && !isReadOnlyArchive;

  const { data: teamsResponse, isLoading: loadingTeams } = useQuery<{ data: Team[] }>({
    queryKey: ["/api/teams", leagueId],
    queryFn: async () => {
      const response = await fetch(`/api/teams?leagueId=${leagueId}`);
      if (!response.ok) {
        throw new Error('Failed to fetch teams');
      }
      return response.json();
    },
    enabled: !!leagueId,
    retry: false,
    staleTime: 1000 * 60 * 5,
  });

  const allTeams = teamsResponse?.data || [];
  const archivedCount = allTeams.filter(t => !t.active).length;
  const visibleTeams = showArchived ? allTeams : allTeams.filter(t => t.active);
  const sortedTeams = visibleTeams
    .slice()
    .sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      if (a.displayOrder !== b.displayOrder) return a.displayOrder - b.displayOrder;
      const numA = a.number ?? Number.MAX_SAFE_INTEGER;
      const numB = b.number ?? Number.MAX_SAFE_INTEGER;
      return numA - numB;
    });
  const activeTeams = allTeams.filter(t => t.active);

  const archiveMutation = useMutation({
    mutationFn: async ({ id, active }: { id: number; active: boolean }) => {
      await apiRequest(`/api/teams/${id}`, "PATCH", { active });
    },
    onSuccess: (_, { active }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/teams", leagueId] });
      queryClient.invalidateQueries({ queryKey: ["/api/bowler-leagues"] });
      toast({
        title: active ? "Team restored" : "Team archived",
        description: active ? "The team has been restored." : "The team has been archived.",
      });
      setArchiveTeam(null);
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest(`/api/teams/${id}`, "DELETE");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/teams", leagueId] });
      queryClient.invalidateQueries({ queryKey: ["/api/bowler-leagues"] });
      toast({
        title: "Team deleted",
        description: "The team and all its data have been permanently deleted.",
      });
      setDeleteTeam(null);
    },
    onError: (error: Error) => {
      toast({
        title: "Error deleting team",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  if (loadingLeague || loadingTeams) {
    return (
      <Layout>
        <PageLoadingState />
      </Layout>
    );
  }

  if (!league) {
    return (
      <Layout>
        <div className="text-center">League not found</div>
      </Layout>
    );
  }

  return (
    <Layout>
      <ErrorBoundary level="section">
      <div className="space-y-4">
        <Link
          href={`/leagues/${leagueId}`}
          className="text-muted-foreground hover:text-foreground flex items-center mb-4"
        >
          <ArrowLeft className="size-4 mr-2" />
          Back to {league.name}
        </Link>

        <div className="space-y-4 mb-6">
          <h1 className="text-2xl font-bold">{league.name}</h1>
          {isReadOnlyArchive && (
            <div role="status" className="rounded-md border border-muted bg-muted/30 px-4 py-3 text-sm">
              <div className="font-medium">Read-only archive</div>
              <div className="text-muted-foreground">This league is retained for history. Team and roster changes are unavailable.</div>
            </div>
          )}
          {canWriteRoster && <div className="flex items-center gap-2">
            <Button onClick={() => setShowForm(true)}>
              <Plus className="size-4 mr-2" />
              Add Team
            </Button>
            {activeTeams.length > 1 && (
              <Button variant="outline" onClick={() => setShowReorder(true)}>
                <ArrowUpDown className="size-4 mr-2" />
                Reorder Teams
              </Button>
            )}
          </div>}
          {archivedCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowArchived(!showArchived)}
            >
              {showArchived ? "Hide" : "Show"} archived ({archivedCount})
            </Button>
          )}
        </div>

        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                {canWriteRoster && <TableHead className="w-[50px]"></TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedTeams.map((team) => (
                <TableRow key={team.id} className={!team.active ? "opacity-60" : ""}>
                  <TableCell>{team.number || 'Not assigned'}</TableCell>
                  <TableCell>
                    <Link href={`/teams/${team.id}`} className="hover:underline text-foreground">
                      {team.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant={team.active ? "default" : "secondary"}>
                      {team.active ? "Active" : "Archived"}
                    </Badge>
                  </TableCell>
                  {canWriteRoster && <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="size-8 p-0"
                          aria-label={`Actions for ${team.name}`}
                        >
                          <MoreHorizontal className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setArchiveTeam(team)}>
                          {team.active ? (
                            <>
                              <Archive className="mr-2 size-4" />
                              Archive
                            </>
                          ) : (
                            <>
                              <ArchiveRestore className="mr-2 size-4" />
                              Restore
                            </>
                          )}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onClick={() => setDeleteTeam(team)}
                        >
                          <Trash2 className="mr-2 size-4" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {canWriteRoster && <TeamForm
          open={showForm}
          onClose={() => setShowForm(false)}
          leagueId={leagueId}
        />}

        {canWriteRoster && <ReorderTeamsDialog
          open={showReorder}
          onClose={() => setShowReorder(false)}
          teams={activeTeams}
          leagueId={leagueId}
        />}

        {canWriteRoster && <Dialog open={!!archiveTeam} onOpenChange={() => setArchiveTeam(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {archiveTeam?.active ? "Archive" : "Restore"} Team
              </DialogTitle>
              <DialogDescription>
                {archiveTeam?.active
                  ? `Are you sure you want to archive "${archiveTeam?.name}"? Archived teams won't appear in active views.`
                  : `Are you sure you want to restore "${archiveTeam?.name}"? It will appear in active views again.`}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setArchiveTeam(null)} disabled={archiveMutation.isPending}>
                Cancel
              </Button>
              <Button
                onClick={() => archiveTeam && archiveMutation.mutate({ id: archiveTeam.id, active: !archiveTeam.active })}
                disabled={archiveMutation.isPending}
              >
                {archiveMutation.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                {archiveTeam?.active ? "Archive" : "Restore"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>}

        {canWriteRoster && <Dialog open={!!deleteTeam} onOpenChange={() => setDeleteTeam(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete Team</DialogTitle>
              <DialogDescription>
                Are you sure you want to permanently delete "{deleteTeam?.name}"? This will remove the team and all associated bowler assignments. This action cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleteTeam(null)} disabled={deleteMutation.isPending}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => deleteTeam && deleteMutation.mutate(deleteTeam.id)}
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>}
      </div>
      </ErrorBoundary>
    </Layout>
  );
}
