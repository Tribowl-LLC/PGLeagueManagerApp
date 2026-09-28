/* eslint-disable shadcn/no-unknown-classes, shadcn/no-restyle */
import { FC, useMemo, useState } from "react";
import { ErrorBoundary } from "@/components/error-boundary";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, Trash2 } from "lucide-react";
import { PageLoadingState } from "@/components/page-states";
import { Link } from "wouter";
import { BowlerLayout } from "@/components/bowler-layout";
import { LeagueBottomSheet } from "@/components/league-bottom-sheet";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, clearCsrfToken } from "@/lib/queryClient";
import { logger } from "@/lib/logger";
import { ProfileInfoCard, type CurrentUserWithSyncStatus } from "@/components/profile-info-card";
import { ChangePasswordCard } from "@/components/change-password-card";
import { SavedPaymentMethodsCard } from "@/components/saved-payment-methods-card";
import { BowlerPaymentLinksSection } from "@/components/bowler-payment-links-section";
import type { ApiResponse, BowlerDetailsResponse, BowlerLeague, League, Team } from "@shared/schema";
import { filterBowlerLeaguesForActiveLeagues } from "@/lib/bowler-league-utils";
import { useSelectedLeague } from "@/hooks/use-selected-league";
import { getApiRetryDelay, shouldRetryApiQuery } from "@/lib/queryClient";
import "@/components/familiar-bowler-profile.css";

const STALE_TIME = 1000 * 60 * 5;

interface AccountDeletionDialogProps {
  accountEmail: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function AccountDeletionDialog({ accountEmail, open, onOpenChange }: AccountDeletionDialogProps) {
  const { toast } = useToast();
  const [email, setEmail] = useState(accountEmail);
  const [reason, setReason] = useState("");
  const [notifyOnCompletion, setNotifyOnCompletion] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setEmail(accountEmail);
      setReason("");
      setNotifyOnCompletion(true);
      setIsSubmitted(false);
    }
    onOpenChange(nextOpen);
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!email.trim()) {
      toast({
        title: "Email required",
        description: "Please enter the email address associated with your account.",
        variant: "destructive",
      });
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch("/api/account/request-deletion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          reason: reason.trim(),
          notifyOnCompletion,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error?.message || "Failed to submit request");
      }

      setIsSubmitted(true);
    } catch {
      toast({
        title: "Request not submitted",
        description: "We couldn’t send your request. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="familiar-profile-dialog familiar-deletion-dialog" viewport="tall">
        <DialogHeader>
          <DialogTitle>Request account deletion</DialogTitle>
          <DialogDescription>
            Request permanent deletion of your account and associated data.
          </DialogDescription>
        </DialogHeader>
        {isSubmitted ? (
          <div className="familiar-profile-success" role="status">
            <div className="familiar-profile-success-icon" aria-hidden="true">✓</div>
            <h3>Request received.</h3>
            <p>
              If an account exists with the provided email, we will process your request within 30 days.
              {notifyOnCompletion
                ? " After processing, we will request a confirmation email."
                : " We will not request a confirmation email after processing."}
            </p>
            <Button type="button" onClick={() => handleOpenChange(false)}>Done</Button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="familiar-profile-dialog-form">
            <p className="familiar-profile-dialog-note">
              This request is reviewed before account data is deleted. The action cannot be undone.
            </p>
            <div className="space-y-2">
              <Label htmlFor="profile-deletion-email">Account email <span className="text-destructive">Required</span></Label>
              <Input
                id="profile-deletion-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="profile-deletion-reason">Reason <span className="font-normal text-muted-foreground">(optional)</span></Label>
              <Textarea
                id="profile-deletion-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value.slice(0, 2000))}
                maxLength={2000}
                rows={4}
              />
              <p className="text-right text-xs text-muted-foreground">{reason.length}/2000</p>
            </div>
            <label className="familiar-profile-checkbox">
              <Checkbox
                id="profile-deletion-notify"
                checked={notifyOnCompletion}
                onCheckedChange={(checked) => setNotifyOnCompletion(checked === true)}
              />
              <span>Email me a confirmation when my data is deleted</span>
            </label>
            <div className="familiar-profile-data-list">
              <strong>Data included in this request</strong>
              <ul>
                <li>Account and login</li>
                <li>Profile information and avatar</li>
                <li>Payment history and saved cards</li>
                <li>Bowler profile linkage</li>
              </ul>
            </div>
            <Button type="submit" variant="destructive" disabled={isSubmitting} className="w-full">
              {isSubmitting ? <><Loader2 className="size-4 animate-spin" />Submitting…</> : <><Trash2 className="size-4" />Submit deletion request</>}
            </Button>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={isSubmitting} className="w-full">
              Cancel
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

const ProfileSettingsPage: FC = () => {
  const { toast } = useToast();
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [isPasswordDialogOpen, setIsPasswordDialogOpen] = useState(false);
  const [isDeletionDialogOpen, setIsDeletionDialogOpen] = useState(false);
  const [selectedLeagueId, setSelectedLeagueId] = useSelectedLeague();
  const [leagueSheetOpen, setLeagueSheetOpen] = useState(false);

  // The /api/user response augments the bare User row with a derived
  // `paymentSyncStatus` (#363) so ProfileInfoCard can hydrate the
  // self-serve retry button on first paint. Use the augmented type
  // here so the prop-flow stays type-correct end-to-end.
  const { data: userResponse, isLoading: isLoadingUser } = useQuery<ApiResponse<CurrentUserWithSyncStatus>>({
    queryKey: ['/api/user'],
    staleTime: STALE_TIME,
  });
  const currentUser = userResponse?.data;
  const bowlerId = currentUser?.bowlerId;
  const { data: bowlerLeaguesResponse } = useQuery<ApiResponse<BowlerLeague[]>>({
    queryKey: ["/api/bowler-leagues"],
    enabled: !!bowlerId,
    staleTime: STALE_TIME,
    retry: shouldRetryApiQuery,
    retryDelay: getApiRetryDelay,
  });
  const { data: leaguesResponse } = useQuery<ApiResponse<League[]>>({
    queryKey: ["/api/leagues"],
    enabled: !!bowlerId,
    staleTime: STALE_TIME,
    retry: shouldRetryApiQuery,
    retryDelay: getApiRetryDelay,
  });
  const { data: bowlerDetailsResponse } = useQuery<ApiResponse<BowlerDetailsResponse>>({
    queryKey: [`/api/bowlers/${bowlerId}/details`],
    enabled: !!bowlerId,
    staleTime: STALE_TIME,
    retry: shouldRetryApiQuery,
    retryDelay: getApiRetryDelay,
  });

  const leagueMap = useMemo(() => {
    const map = new Map<number, League>();
    for (const league of leaguesResponse?.data ?? []) map.set(league.id, league);
    return map;
  }, [leaguesResponse?.data]);
  const teamMap = useMemo(() => {
    const map = new Map<number, Team>();
    for (const team of bowlerDetailsResponse?.data?.teams ?? []) map.set(team.id, team);
    return map;
  }, [bowlerDetailsResponse?.data?.teams]);
  const activeBowlerLeagues = useMemo(
    () => filterBowlerLeaguesForActiveLeagues(
      (bowlerLeaguesResponse?.data ?? []).filter((entry) => entry.bowlerId === bowlerId),
      leagueMap,
    ),
    [bowlerId, bowlerLeaguesResponse?.data, leagueMap],
  );
  const activeBowlerLeague = useMemo(() => {
    if (activeBowlerLeagues.length === 0) return null;
    if (selectedLeagueId) {
      return activeBowlerLeagues.find((entry) => entry.leagueId === selectedLeagueId) ?? activeBowlerLeagues[0];
    }
    return activeBowlerLeagues[0];
  }, [activeBowlerLeagues, selectedLeagueId]);
  const activeLeague = activeBowlerLeague ? leagueMap.get(activeBowlerLeague.leagueId) : undefined;
  const activeTeam = activeBowlerLeague?.teamId ? teamMap.get(activeBowlerLeague.teamId) : undefined;

  const handleLogout = async () => {
    try {
      setIsLoggingOut(true);
      await apiRequest('/api/auth/logout', 'POST', {});
      clearCsrfToken();
      window.location.href = '/login';
    } catch (error) {
      logger.error('ProfileSettings', 'Logout failed', error);
      toast({ title: "Logout failed", description: "Please try again.", variant: "destructive" });
    } finally {
      setIsLoggingOut(false);
    }
  };

  if (isLoadingUser) {
    return <PageLoadingState message="Loading profile..." />;
  }

  if (!currentUser) {
    return (
      <Card className="mx-auto max-w-md mt-8">
        <CardHeader>
          <CardTitle>Authentication Required</CardTitle>
          <CardDescription>Please log in to view your profile settings</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild className="w-full">
            <Link href="/login">Log In</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <BowlerLayout
      bowlerName={currentUser.name}
      leagueName={activeLeague?.name ?? "No League"}
      currentLeagueId={activeBowlerLeague?.leagueId}
      onOpenLeagueSheet={activeLeague ? () => setLeagueSheetOpen(true) : undefined}
    >
      <ErrorBoundary level="section">
        <div className="familiar-bowler-profile-page">
          <div className="familiar-bowler-page-heading">
            <h1>Your profile</h1>
            <p>Your details and preferences.</p>
          </div>
          <ProfileInfoCard currentUser={currentUser} teamName={activeTeam?.name} />
          <section className="familiar-profile-setting-row familiar-profile-security" data-testid="profile-setting-security">
            <div className="familiar-profile-setting-copy">
              <h2>Account security</h2>
              <p>Manage the password for your signed-in account.</p>
            </div>
            <Button variant="outline" className="familiar-profile-row-action" onClick={() => setIsPasswordDialogOpen(true)}>
              Change password
            </Button>
          </section>
          {bowlerId && <SavedPaymentMethodsCard bowlerId={bowlerId} locationId={currentUser.locationId} triggerOnly />}
          {bowlerId && (
            <BowlerPaymentLinksSection currentBowlerId={bowlerId} alwaysShow triggerOnly />
          )}
          <section className="familiar-profile-setting-row familiar-profile-danger-row" data-testid="profile-setting-deletion">
            <div className="familiar-profile-setting-copy">
              <h2>Account deletion</h2>
              <p>Request permanent deletion of your account and associated data.</p>
            </div>
            <Button variant="outline" className="familiar-profile-row-action familiar-profile-danger-action" onClick={() => setIsDeletionDialogOpen(true)}>
              Request deletion
            </Button>
          </section>
          <div className="familiar-profile-signout">
            <Button variant="outline" onClick={handleLogout} disabled={isLoggingOut} className="w-full">
              {isLoggingOut ? <><Loader2 className="size-4 animate-spin" />Signing out…</> : "Sign out"}
            </Button>
          </div>
        </div>
        <Dialog open={isPasswordDialogOpen} onOpenChange={setIsPasswordDialogOpen}>
          <DialogContent className="familiar-profile-dialog familiar-password-dialog" viewport="dialog">
            <DialogHeader>
              <DialogTitle>Change password</DialogTitle>
              <DialogDescription>Use your current password to set a new sign-in password.</DialogDescription>
            </DialogHeader>
            <ChangePasswordCard alwaysOpen onSuccess={() => setIsPasswordDialogOpen(false)} />
          </DialogContent>
        </Dialog>
        <AccountDeletionDialog
          accountEmail={currentUser.email}
          open={isDeletionDialogOpen}
          onOpenChange={setIsDeletionDialogOpen}
        />
      </ErrorBoundary>
      {activeLeague && (
        <LeagueBottomSheet
          open={leagueSheetOpen}
          onClose={() => setLeagueSheetOpen(false)}
          activeBowlerLeagues={activeBowlerLeagues}
          leagueMap={leagueMap}
          teamMap={teamMap}
          selectedLeagueId={activeBowlerLeague?.leagueId ?? null}
          onSelectLeague={(id) => setSelectedLeagueId(id)}
          viewerRole={currentUser.role}
        />
      )}
    </BowlerLayout>
  );
};

export default ProfileSettingsPage;
