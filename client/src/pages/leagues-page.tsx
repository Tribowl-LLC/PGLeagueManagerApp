import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Layout } from "@/components/layout";
import { LeagueForm } from "@/components/league-form";
import { ErrorBoundary } from "@/components/error-boundary";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus } from "lucide-react";
import { LeaguesTableSkeleton, PageErrorState } from "@/components/page-states";
import { LeaguesTable } from "@/components/leagues-table";
import { LeagueSquareMissingBanner } from "@/components/league-square-missing-banner";
import { ConfirmArchiveDialog } from "@/components/confirm-archive-dialog";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import type { ApiResponse, League, Team, Location, User } from "@shared/schema";
import type { LeagueScoresReadContract } from "@shared/canonical-games-scores";
import type { ScoreWithRelations } from "@/lib/types/scores";
import { apiRequest } from "@/lib/queryClient";
import { leagueLatestScoresRequest } from "@/lib/score-requests";
import { useToast } from "@/hooks/use-toast";
import { filterAndSortLeagues, buildLocationMap, countArchivedLeagues } from "@/lib/league-filter-utils";

export default function LeaguesPage() {
  const [showForm, setShowForm] = useState(false);
  const [selectedLeague, setSelectedLeague] = useState<League | undefined>();
  const [showArchived, setShowArchived] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);
  const [archiveConfirmId, setArchiveConfirmId] = useState<number | null>(null);
  const [locationFilter, setLocationFilter] = useState<string>("all");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: leaguesResponse, isLoading: loadingLeagues } = useQuery<{ data: League[] }>({
    queryKey: ["/api/leagues"],
  });

  const { data: currentUserResponse } = useQuery<ApiResponse<User>>({
    queryKey: ["/api/user"],
    staleTime: 5 * 60 * 1000,
  });
  const currentUser = currentUserResponse?.data;

  const { data: locationsResponse } = useQuery<{ data: Location[] }>({
    queryKey: ["/api/locations"],
  });

  const allLocations = locationsResponse?.data || [];
  const leagues = leaguesResponse?.data;

  const { data: teamsResponse, isLoading: loadingTeams } = useQuery<{ data: Team[] }>({
    queryKey: ["/api/teams"],
  });

  const allTeams = teamsResponse?.data || [];

  const firstLeague = leagues?.[0];
  const latestScoresRequest = firstLeague?.organizationId
    ? leagueLatestScoresRequest(firstLeague.id, firstLeague.organizationId)
    : null;

  const {
    data: scoresResponse,
    isLoading: loadingScores,
    error: scoresError,
    refetch: refetchScores,
  } = useQuery<{
    data: LeagueScoresReadContract | ScoreWithRelations[];
  }>({
    queryKey: latestScoresRequest?.queryKey ?? ["/api/scores/latest-scored-session", null, null],
    queryFn: async ({ queryKey }) => {
      const scopedUrl = queryKey[3];
      if (typeof scopedUrl !== "string") throw new Error("No tenant-scoped league selected");
      const response = await fetch(scopedUrl);
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || "Failed to fetch scores");
      }
      return response.json();
    },
    enabled: latestScoresRequest !== null,
  });

  const weeklyScores = Array.isArray(scoresResponse?.data)
    ? scoresResponse.data
    : scoresResponse?.data.scores ?? [];

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => apiRequest(`/api/leagues/${id}`, "DELETE"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/leagues"] });
      toast({ title: "League Deleted", description: "The league and all its data have been permanently deleted." });
      setDeleteConfirmId(null);
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: `Failed to delete league: ${error.message}`, variant: "destructive" });
    },
  });

  const archiveMutation = useMutation({
    mutationFn: async (id: number) => apiRequest(`/api/leagues/${id}/archive`, "PATCH"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/leagues"] });
      toast({ title: "League Archived", description: "The league has been archived and hidden from normal views." });
      setArchiveConfirmId(null);
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: `Failed to archive league: ${error.message}`, variant: "destructive" });
    },
  });

  const restoreMutation = useMutation({
    mutationFn: async (id: number) => apiRequest(`/api/leagues/${id}/restore`, "PATCH"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/leagues"] });
      toast({ title: "League Restored", description: "The league has been restored and is now active again." });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: `Failed to restore league: ${error.message}`, variant: "destructive" });
    },
  });

  const teamCounts = allTeams.reduce((acc, team) => {
    acc[team.leagueId] = (acc[team.leagueId] || 0) + 1;
    return acc;
  }, {} as Record<number, number>);

  if (loadingLeagues || loadingTeams || loadingScores) {
    return (
      <Layout>
        <LeaguesTableSkeleton />
      </Layout>
    );
  }

  const allLeagues = leagues || [];
  const locationMap = buildLocationMap(allLocations);
  const filteredLeagues = filterAndSortLeagues(allLeagues, { showArchived, locationFilter });
  const archivedCount = countArchivedLeagues(allLeagues);
  const deleteTargetName = allLeagues.find(l => l.id === deleteConfirmId)?.name;

  return (
    <Layout>
      <ErrorBoundary level="section">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-2xl font-bold">Leagues</h1>
          <div className="flex gap-2">
            <Button onClick={() => { setSelectedLeague(undefined); setShowForm(true); }}>
              <Plus className="size-4 mr-2" />
              Add League
            </Button>
          </div>
        </div>

        <LeagueSquareMissingBanner
          leagues={allLeagues}
          onEditLeague={(league) => { setSelectedLeague(league); setShowForm(true); }}
        />

        <div className="rounded-md border mb-8">
          <div className="flex items-center justify-between gap-4 p-3 border-b">
            {allLocations.length > 0 && (
              <div className="flex items-center gap-2">
                <Label className="text-sm text-muted-foreground whitespace-nowrap">Location:</Label>
                <Select value={locationFilter} onValueChange={setLocationFilter}>
                  <SelectTrigger className="w-[180px] h-8"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Locations</SelectItem>
                    <SelectItem value="none">No Location</SelectItem>
                    {allLocations.flatMap(loc => loc.active ? [(
                      <SelectItem key={loc.id} value={String(loc.id)}>{loc.name}</SelectItem>
                    )] : [])}
                  </SelectContent>
                </Select>
              </div>
            )}
            {archivedCount > 0 && (
              <div className="flex items-center gap-2 ml-auto">
                <Label htmlFor="show-archived-leagues" className="text-sm text-muted-foreground cursor-pointer">
                  Show archived ({archivedCount})
                </Label>
                <Switch
                  id="show-archived-leagues"
                  checked={showArchived}
                  onCheckedChange={setShowArchived}
                />
              </div>
            )}
          </div>
          <LeaguesTable
            leagues={filteredLeagues}
            teamCounts={teamCounts}
            locationMap={locationMap}
            onEdit={(league) => { setSelectedLeague(league); setShowForm(true); }}
            onArchive={setArchiveConfirmId}
            onRestore={(id) => restoreMutation.mutate(id)}
            onDelete={setDeleteConfirmId}
            isRestorePending={restoreMutation.isPending}
          />
        </div>

        {scoresError ? (
          <section className="mt-8" aria-labelledby="recent-scores-heading">
            <h2 id="recent-scores-heading" className="text-xl font-semibold mb-4">Recent Scores</h2>
            <PageErrorState
              message={`Recent scores could not be loaded safely: ${scoresError.message}`}
              onRetry={() => { void refetchScores(); }}
            />
          </section>
        ) : weeklyScores.length > 0 && (
          <div className="mt-8">
            <h2 className="text-xl font-semibold mb-4">Recent Scores</h2>
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Bowler</TableHead>
                    <TableHead>Team</TableHead>
                    <TableHead>Score</TableHead>
                    <TableHead>Average</TableHead>
                    <TableHead>Handicap</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {weeklyScores.map((score) => (
                    <TableRow key={score.id}>
                      <TableCell>{score.bowler.name}</TableCell>
                      <TableCell>{score.team.name}</TableCell>
                      <TableCell>{score.score}</TableCell>
                      <TableCell>{score.average || "N/A"}</TableCell>
                      <TableCell>{score.handicap}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}

        <LeagueForm
          open={showForm}
          onClose={() => { setShowForm(false); setSelectedLeague(undefined); }}
          league={selectedLeague}
          systemAdminOrganizationId={currentUser?.role === "system_admin" ? currentUser.organizationId : undefined}
        />

        <ConfirmArchiveDialog
          open={!!archiveConfirmId}
          onOpenChange={(open) => { if (!open) setArchiveConfirmId(null); }}
          title="Archive League"
          description="This will hide the league from normal views. The league and all its data (teams, bowlers, scores, payments) will be preserved and can be restored at any time."
          actionLabel="Archive League"
          pendingLabel="Archiving..."
          isPending={archiveMutation.isPending}
          onConfirm={() => archiveConfirmId && archiveMutation.mutate(archiveConfirmId)}
        />

        <ConfirmDeleteDialog
          open={!!deleteConfirmId}
          onOpenChange={(open) => { if (!open) setDeleteConfirmId(null); }}
          title="Permanently Delete League"
          itemLabel="league"
          itemName={deleteTargetName}
          consequencesIntro="Permanently deleting this league will also delete:"
          consequences={[
            "All teams within this league",
            "All bowler-league memberships",
            "All payment records for this league",
            "All game and score history",
            "All payment schedules",
          ]}
          isPending={deleteMutation.isPending}
          onConfirm={() => deleteConfirmId && deleteMutation.mutate(deleteConfirmId)}
        />

      </ErrorBoundary>
    </Layout>
  );
}
