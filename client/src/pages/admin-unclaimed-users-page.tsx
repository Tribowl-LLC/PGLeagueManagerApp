import { FC, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, UserPlus, Link2, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { invalidateUnclaimedUsers } from "@/lib/query-keys";
import { PageLoadingState } from "@/components/page-states";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import type { ApiResponse, League, Team, Bowler } from "@shared/schema";

interface UnlinkedUser {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  organizationId: number | null;
}

type EmailNotification = "accepted" | "not_sent";

interface AccountLinkResponse {
  userId: number;
  bowlerId: number;
  leagueId: number | null;
  teamId: number | null;
  emailNotification?: EmailNotification;
}

/**
 * Task #667: admin surface for triaging self-registered users that
 * couldn't be auto-linked to a bowler. Two flows per user:
 *   1. Create a new bowler (when the user is genuinely new to the league).
 *   2. Link to an existing UNLINKED bowler (when the user already has a
 *      roster row under a different spelling).
 * Both call atomic backend routes that also handle league/team
 * assignment in the same transaction.
 */
const AdminUnclaimedUsersPage: FC = () => {
  const { toast } = useToast();

  const [creating, setCreating] = useState<UnlinkedUser | null>(null);
  const [linking, setLinking] = useState<UnlinkedUser | null>(null);
  const [deleting, setDeleting] = useState<UnlinkedUser | null>(null);

  const { data: usersResp, isLoading } = useQuery<ApiResponse<UnlinkedUser[]>>({
    queryKey: ["/api/admin/unclaimed-users"],
  });
  const users = usersResp?.data ?? [];

  // NOTE (react-doctor audit): react-doctor flags the mutations on this page
  // as missing query invalidation. False positive — invalidation is delegated
  // to the shared invalidateUnclaimedUsers() helper (called here and from the
  // dialog onSuccess callbacks further below). Audited; leave as-is.
  const deleteMutation = useMutation({
    mutationFn: async (userId: number) => {
      return apiRequest(`/api/admin/unclaimed-users/${userId}`, "DELETE");
    },
    onSuccess: () => {
      const name = deleting?.name ?? "user";
      toast({
        title: "User deleted",
        description: `${name} has been permanently removed.`,
      });
      setDeleting(null);
      invalidateUnclaimedUsers();
    },
    onError: (err: Error) => {
      toast({
        title: "Failed to delete user",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  return (
    <Layout>
      <div className="container mx-auto py-6 max-w-5xl">
        <Card>
          <CardHeader>
            <CardTitle>Unclaimed Self-Registered Users</CardTitle>
            <CardDescription>
              Users who signed up but couldn&apos;t be matched to a bowler on
              your roster. Create a bowler for them or link them to an
              existing unlinked bowler. They will be emailed once they&apos;re
              set up.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <PageLoadingState fullPage={false} />
            ) : users.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">
                No unclaimed users right now.
              </p>
            ) : (
              <div className="divide-y">
                {users.map((u) => (
                  <div
                    key={u.id}
                    data-testid={`unclaimed-user-${u.id}`}
                    className="py-3 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{u.name}</div>
                      <div className="text-sm text-muted-foreground truncate">
                        {u.email}
                        {u.phone ? ` · ${u.phone}` : ""}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setLinking(u)}
                        data-testid={`link-existing-${u.id}`}
                      >
                        <Link2 className="size-4 mr-1" />
                        Link Existing
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => setCreating(u)}
                        data-testid={`create-bowler-${u.id}`}
                      >
                        <UserPlus className="size-4 mr-1" />
                        Create Bowler
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setDeleting(u)}
                        data-testid={`delete-unclaimed-user-${u.id}`}
                        aria-label={`Delete ${u.name}`}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {creating && (
        <CreateBowlerDialog
          user={creating}
          onClose={() => setCreating(null)}
          onSuccess={(bowlerName, emailNotification) => {
            toast({
              title: "Bowler created",
              description: `${creating.name} is now linked to ${bowlerName}. ${
                emailNotification === "accepted"
                  ? "Account linked; email submitted."
                  : "Account linked, but notification could not be sent."
              }`,
            });
            setCreating(null);
            invalidateUnclaimedUsers();
          }}
        />
      )}
      {linking && (
        <LinkExistingDialog
          user={linking}
          onClose={() => setLinking(null)}
          onSuccess={(bowlerName, emailNotification) => {
            toast({
              title: "Bowler linked",
              description: `${linking.name} is now linked to ${bowlerName}. ${
                emailNotification === "accepted"
                  ? "Account linked; email submitted."
                  : "Account linked, but notification could not be sent."
              }`,
            });
            setLinking(null);
            invalidateUnclaimedUsers();
          }}
        />
      )}
      <ConfirmDeleteDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !deleteMutation.isPending) setDeleting(null);
        }}
        title="Delete unclaimed user?"
        itemLabel="user"
        itemName={deleting?.name}
        consequencesIntro="This permanently deletes the self-registered account that never matched a bowler on your roster."
        consequences={[
          <>The user&apos;s login (<span className="font-mono">{deleting?.email}</span>) will be removed.</>,
          <>No bowler, league, team, or score data is touched (this account was never linked to a bowler).</>,
          <>If the same person signs up again later they&apos;ll appear here as a fresh unclaimed user.</>,
        ]}
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          if (deleting) deleteMutation.mutate(deleting.id);
        }}
      />
    </Layout>
  );
};

interface DialogProps {
  user: UnlinkedUser;
  onClose: () => void;
  onSuccess: (bowlerName: string, emailNotification: EmailNotification) => void;
}

function CreateBowlerDialog({ user, onClose, onSuccess }: DialogProps) {
  const { toast } = useToast();
  const [leagueId, setLeagueId] = useState<string>("");
  const [teamId, setTeamId] = useState<string>("");

  const { data: leaguesResp } = useQuery<ApiResponse<League[]>>({
    queryKey: ["/api/leagues"],
  });
  const leagues = (leaguesResp?.data ?? []).filter((l) => l.active);

  const { data: teamsResp } = useQuery<ApiResponse<Team[]>>({
    queryKey: ["/api/teams", { leagueId: leagueId ? Number(leagueId) : undefined }],
    queryFn: async () => {
      const url = leagueId ? `/api/teams?leagueId=${leagueId}` : `/api/teams`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to load teams");
      return res.json();
    },
    enabled: leagueId !== "",
  });
  const teams = teamsResp?.data ?? [];

  const mutation = useMutation({
    mutationFn: async () => {
      return apiRequest<AccountLinkResponse>(`/api/admin/unclaimed-users/${user.id}/create-bowler`, "POST", {
        leagueId: Number(leagueId),
        teamId: Number(teamId),
      });
    },
    // No cache invalidation here: this child dialog defers to the parent's
    // `onSuccess`, which calls `invalidateUnclaimedUsers()` after closing.
    onSuccess: (response) => onSuccess(
      user.name,
      response?.data?.emailNotification === "accepted" ? "accepted" : "not_sent",
    ),
    onError: (err: Error) => {
      toast({
        title: "Failed to create bowler",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create bowler for {user.name}</DialogTitle>
          <DialogDescription>
            A new bowler row will be created with this user&apos;s name, email,
            and phone, then assigned to the team you choose.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <label htmlFor="unclaimed-create-league" className="text-sm font-medium">League</label>
            <Select
              value={leagueId}
              onValueChange={(v) => {
                setLeagueId(v);
                setTeamId("");
              }}
            >
              <SelectTrigger id="unclaimed-create-league" data-testid="select-league">
                <SelectValue placeholder="Select a league" />
              </SelectTrigger>
              <SelectContent>
                {leagues.map((l) => (
                  <SelectItem key={l.id} value={String(l.id)}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label htmlFor="unclaimed-create-team" className="text-sm font-medium">Team</label>
            <Select value={teamId} onValueChange={setTeamId} disabled={!leagueId}>
              <SelectTrigger id="unclaimed-create-team" data-testid="select-team">
                <SelectValue placeholder={leagueId ? "Select a team" : "Pick a league first"} />
              </SelectTrigger>
              <SelectContent>
                {teams.map((t) => (
                  <SelectItem key={t.id} value={String(t.id)}>
                    Team {t.number}: {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={!leagueId || !teamId || mutation.isPending}
            data-testid="confirm-create-bowler"
          >
            {mutation.isPending && <Loader2 className="size-4 mr-2 animate-spin" />}
            Create &amp; Link
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LinkExistingDialog({ user, onClose, onSuccess }: DialogProps) {
  const { toast } = useToast();
  const [bowlerId, setBowlerId] = useState<string>("");
  const [leagueId, setLeagueId] = useState<string>("");
  const [teamId, setTeamId] = useState<string>("");

  // Reuse the public unlinked-bowlers grouping endpoint to populate the
  // candidate list — admins can pick any unlinked bowler in the org.
  const { data: unlinkedResp } = useQuery<ApiResponse<Array<{
    league: { id: number; name: string };
    teams: Array<{ team: { id: number; name: string; number: number }; bowlers: Array<{ id: number; name: string }> }>;
  }>>>({
    queryKey: ["/api/bowlers/unlinked"],
  });
  const candidates = useMemo(() => {
    const out: Array<{ id: number; name: string; teamLabel: string }> = [];
    for (const lg of unlinkedResp?.data ?? []) {
      for (const tg of lg.teams) {
        for (const b of tg.bowlers) {
          out.push({
            id: b.id,
            name: b.name,
            teamLabel: `${lg.league.name} · Team ${tg.team.number} ${tg.team.name}`,
          });
        }
      }
    }
    return out;
  }, [unlinkedResp]);

  const { data: leaguesResp } = useQuery<ApiResponse<League[]>>({
    queryKey: ["/api/leagues"],
  });
  const leagues = (leaguesResp?.data ?? []).filter((l) => l.active);

  const { data: teamsResp } = useQuery<ApiResponse<Team[]>>({
    queryKey: ["/api/teams", { leagueId: leagueId ? Number(leagueId) : undefined }],
    queryFn: async () => {
      const url = leagueId ? `/api/teams?leagueId=${leagueId}` : `/api/teams`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to load teams");
      return res.json();
    },
    enabled: leagueId !== "",
  });
  const teams = teamsResp?.data ?? [];

  const mutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, number> = { bowlerId: Number(bowlerId) };
      if (leagueId && teamId) {
        body.leagueId = Number(leagueId);
        body.teamId = Number(teamId);
      }
      return apiRequest<AccountLinkResponse>(`/api/admin/unclaimed-users/${user.id}/link-existing`, "POST", body);
    },
    // No cache invalidation here: this child dialog defers to the parent's
    // `onSuccess`, which calls `invalidateUnclaimedUsers()` after closing.
    onSuccess: (response) => {
      const sel = candidates.find((c) => String(c.id) === bowlerId);
      onSuccess(
        sel?.name ?? user.name,
        response?.data?.emailNotification === "accepted" ? "accepted" : "not_sent",
      );
    },
    onError: (err: Error) => {
      toast({
        title: "Failed to link bowler",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Link {user.name} to existing bowler</DialogTitle>
          <DialogDescription>
            Pick an unlinked bowler in your organization. Optionally also
            assign them to a league/team in the same step.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <label htmlFor="unclaimed-link-bowler" className="text-sm font-medium">Existing bowler</label>
            <Select value={bowlerId} onValueChange={setBowlerId}>
              <SelectTrigger id="unclaimed-link-bowler" data-testid="select-bowler">
                <SelectValue placeholder="Select an unlinked bowler" />
              </SelectTrigger>
              <SelectContent>
                {candidates.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-muted-foreground">
                    No unlinked bowlers available.
                  </div>
                ) : (
                  candidates.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.name}: {c.teamLabel}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label htmlFor="unclaimed-link-league" className="text-sm font-medium">
              Add to league/team (optional)
            </label>
            <Select
              value={leagueId}
              onValueChange={(v) => {
                setLeagueId(v);
                setTeamId("");
              }}
            >
              <SelectTrigger id="unclaimed-link-league">
                <SelectValue placeholder="Select a league" />
              </SelectTrigger>
              <SelectContent>
                {leagues.map((l) => (
                  <SelectItem key={l.id} value={String(l.id)}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={teamId} onValueChange={setTeamId} disabled={!leagueId}>
              <SelectTrigger>
                <SelectValue placeholder={leagueId ? "Select a team" : "Pick a league first"} />
              </SelectTrigger>
              <SelectContent>
                {teams.map((t) => (
                  <SelectItem key={t.id} value={String(t.id)}>
                    Team {t.number}: {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={!bowlerId || mutation.isPending || (leagueId !== "" && teamId === "")}
            data-testid="confirm-link-existing"
          >
            {mutation.isPending && <Loader2 className="size-4 mr-2 animate-spin" />}
            Link Bowler
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default AdminUnclaimedUsersPage;

// Local type alias to keep the page self-contained even if shared types
// move; matches the storage shape returned by /api/bowlers.
export type _UnclaimedUserBowler = Bowler;
