import { useMemo, useState, FC } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Users, Mail, X, Check, Trash2, Loader2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { ApiResponse } from "@shared/schema";
import { BowlerSearchPicker } from "@/components/bowler-search-picker";

interface LinkRow {
  id: number;
  bowlerAId: number;
  bowlerBId: number;
  status: "pending" | "accepted";
  organizationId: number;
  createdByUserId: number | null;
  inviterBowlerId: number | null;
  partnerBowlerId: number;
  partnerName: string;
}

interface LinksResponse {
  links: LinkRow[];
  hasAny: boolean;
}

interface PartnerInviteEmailResult {
  emailSent: boolean;
  reason?: string;
}

function partnerInviteOutcome(result: PartnerInviteEmailResult | undefined, action: "created" | "resent") {
  if (result?.emailSent === true) {
    return action === "created"
      ? "The payment partner invitation was created and the email was submitted."
      : "The pending payment partner email was submitted again.";
  }

  if (result?.reason === "NO_EMAIL_ON_FILE") {
    return "The payment partner invitation is available here, but no email address is on file.";
  }

  return action === "created"
    ? "The payment partner invitation was created, but no email was sent."
    : "The pending payment partner invitation remains active, but no email was sent. You can try again later.";
}

/**
 * – adult-bowler partner linking UI.
 *
 * By default the section is hidden until `hasAny` is true (avoids cluttering
 * the bowler dashboard for users who have never linked anyone). When mounted
 * inside the user-profile-menu "Payment partners" dialog, pass
 * `alwaysShow` so the invite form renders even with zero existing links.
 */
export const BowlerPaymentLinksSection: FC<{
  currentBowlerId: number;
  alwaysShow?: boolean;
}> = ({ currentBowlerId, alwaysShow = false }) => {
  const { toast } = useToast();

  const { data, isLoading } = useQuery<ApiResponse<LinksResponse>>({
    queryKey: ["/api/bowler-links"],
    staleTime: 30_000,
  });
  const payload = data?.data;
  const hasAny = !!payload?.hasAny;

  const inviteMutation = useMutation({
    mutationFn: async (inviteeBowlerId: number) =>
      apiRequest<PartnerInviteEmailResult>("/api/bowler-links/invite", "POST", { inviteeBowlerId }),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ["/api/bowler-links"] });
      const emailSent = response?.data?.emailSent === true;
      toast({
        title: emailSent ? "Payment partner invitation created" : "Payment partner invitation created without email",
        description: partnerInviteOutcome(response?.data, "created"),
        variant: emailSent ? "default" : "destructive",
      });
    },
    onError: (err: Error) =>
      toast({ title: "Invite failed", description: err.message, variant: "destructive" }),
  });

  const resendInvite = useMutation({
    mutationFn: async (linkId: number) =>
      apiRequest<PartnerInviteEmailResult>(`/api/bowler-links/${linkId}/resend-invite`, "POST"),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ["/api/bowler-links"] });
      const emailSent = response?.data?.emailSent === true;
      toast({
        title: emailSent ? "Invitation email submitted" : "Invitation email not sent",
        description: partnerInviteOutcome(response?.data, "resent"),
        variant: emailSent ? "default" : "destructive",
      });
    },
    onError: (err: Error) =>
      toast({ title: "Invitation email failed", description: err.message, variant: "destructive" }),
  });

  const respond = useMutation({
    mutationFn: async ({ id, action }: { id: number; action: "accept" | "decline" }) =>
      apiRequest(`/api/bowler-links/${id}/${action}`, "POST"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/bowler-links"] }),
    onError: (err: Error) =>
      toast({ title: "Action failed", description: err.message, variant: "destructive" }),
  });

  const [partnerToRemove, setPartnerToRemove] = useState<LinkRow | null>(null);

  const unlink = useMutation({
    mutationFn: async (id: number) => apiRequest(`/api/bowler-links/${id}`, "DELETE"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/bowler-links"] }),
    onError: (err: Error) =>
      toast({ title: "Unlink failed", description: err.message, variant: "destructive" }),
    onSettled: () => setPartnerToRemove(null),
  });

  const links = useMemo(() => payload?.links ?? [], [payload?.links]);
  const excludeIds = useMemo(
    () => [currentBowlerId, ...links.map((l) => l.partnerBowlerId)],
    [currentBowlerId, links],
  );

  if (isLoading) return null;
  if (!hasAny && !alwaysShow) return null;

  const accepted = links.filter((l) => l.status === "accepted");
  const pending = links.filter((l) => l.status === "pending");

  return (
    <Card data-testid="card-payment-partners" className="mt-4">
      <CardHeader>
        <CardTitle size="base" iconSpacing>
          <Users className="size-4" /> Payment partners
        </CardTitle>
        <CardDescription>
          Linked bowlers can pay for each other from a saved card.
        </CardDescription>
      </CardHeader>
      <CardContent spacing="normal">
        {accepted.length > 0 && (
          <div className="space-y-2">
            {accepted.map((l) => {
              return (
                <div
                  key={l.id}
                  data-testid={`row-partner-${l.id}`}
                  className="flex items-center justify-between rounded border p-2 text-sm"
                >
                  <span>{l.partnerName}</span>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">Linked</Badge>
                    <span
                      data-testid={`button-unlink-${l.id}`}
                      onClick={() => {
                        if (!(unlink.isPending && partnerToRemove?.id === l.id)) {
                          setPartnerToRemove(l);
                        }
                      }}
                      role="presentation"
                    >
                      <Button
                        size="sm"
                        variant="destructiveGhost"
                        onClick={() => setPartnerToRemove(l)}
                        disabled={unlink.isPending && partnerToRemove?.id === l.id}
                        data-testid={`button-remove-partner-${l.id}`}
                        aria-label={`Remove payment partner ${l.partnerName}`}
                      >
                        <Trash2 className="size-4 mr-1" />
                        Remove
                      </Button>
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {pending.length > 0 && (
          <div className="space-y-2">
            {pending.map((l) => {
              // Invitee = the side that did NOT initiate the invite.
              // inviterBowlerId is resolved server-side from createdByUserId.
              const isOutbound = l.inviterBowlerId === currentBowlerId;
              const isInvitee =
                l.inviterBowlerId !== null && l.inviterBowlerId !== currentBowlerId;
              return (
                <div
                  key={l.id}
                  data-testid={`row-pending-${l.id}`}
                  className="flex items-center justify-between rounded border p-2 text-sm"
                >
                  <span className="flex items-center gap-2">
                    <Mail className="size-4" /> {l.partnerName}
                    <Badge variant="outline">Pending</Badge>
                  </span>
                  <div className="flex items-center gap-1">
                    {isInvitee && (
                      <>
                        <Button
                          size="sm"
                          variant="default"
                          data-testid={`button-accept-${l.id}`}
                          disabled={respond.isPending}
                          onClick={() => respond.mutate({ id: l.id, action: "accept" })}
                        >
                          <Check className="size-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          data-testid={`button-decline-${l.id}`}
                          disabled={respond.isPending}
                          onClick={() => respond.mutate({ id: l.id, action: "decline" })}
                        >
                          <X className="size-4" />
                        </Button>
                      </>
                    )}
                    {!isInvitee && isOutbound && (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          data-testid={`button-resend-invite-${l.id}`}
                          disabled={resendInvite.isPending}
                          onClick={() => resendInvite.mutate(l.id)}
                        >
                          {resendInvite.isPending ? <Loader2 className="size-4 mr-1 animate-spin" /> : <Mail className="size-4 mr-1" />}
                          Resend email
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          data-testid={`button-cancel-${l.id}`}
                          disabled={unlink.isPending}
                          onClick={() => unlink.mutate(l.id)}
                        >
                          <X className="size-4" />
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="space-y-1">
          <BowlerSearchPicker
            onSelect={(b) => inviteMutation.mutate(b.id)}
            excludeIds={excludeIds}
            placeholder="Search bowlers by name…"
            disabled={inviteMutation.isPending}
            testIdPrefix="invite-bowler"
          />
        </div>

        <AlertDialog
          open={partnerToRemove !== null}
          onOpenChange={(open) => {
            if (!open && !unlink.isPending) setPartnerToRemove(null);
          }}
        >
          <AlertDialogContent data-testid="dialog-remove-partner">
            <AlertDialogHeader>
              <AlertDialogTitle>Remove payment partner?</AlertDialogTitle>
              <AlertDialogDescription>
                This will permanently remove your payment partner from your account. You can always add a new payment partner in the future.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel
                data-testid="button-cancel-remove-partner"
                disabled={unlink.isPending}
              >
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                data-testid="button-confirm-remove-partner"
                variant="destructive"
                onClick={(e) => {
                  e.preventDefault();
                  if (partnerToRemove) unlink.mutate(partnerToRemove.id);
                }}
                disabled={unlink.isPending}
              >
                {unlink.isPending ? <Loader2 className="size-4 animate-spin" /> : "Remove Partner"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
};
