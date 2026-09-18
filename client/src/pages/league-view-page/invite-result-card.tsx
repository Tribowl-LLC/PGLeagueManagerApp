import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Loader2, Mail, RefreshCw } from "lucide-react";

export interface FailedInvitation {
  leagueId?: number;
  bowlerId?: number;
  /** Legacy response compatibility; new ordinary invites never expose this. */
  userId?: number;
  name: string;
}

export interface InviteResult {
  sent: number;
  attempted?: number;
  created?: number;
  emailAccepted?: number;
  deliveryFailed?: number;
  alreadyRegistered: number;
  noEmail: number;
  failedInvitations?: FailedInvitation[];
}

type ResendStatus = "accepted" | "not_sent" | "unknown";

export function InviteResultCard({ inviteResult }: { inviteResult: InviteResult }) {
  const { toast } = useToast();
  const [resendStatus, setResendStatus] = useState<Record<string, ResendStatus>>({});
  const resendMutation = useMutation({
    mutationFn: async (invitation: FailedInvitation) => {
      if (invitation.leagueId && invitation.bowlerId) {
        return apiRequest<{ emailSent?: boolean }>(`/api/leagues/${invitation.leagueId}/send-invite/${invitation.bowlerId}`, "POST");
      }
      if (invitation.userId) {
        return apiRequest<{ emailSent?: boolean }>(`/api/org-admin/users/${invitation.userId}/resend-invite`, "POST");
      }
      throw new Error("Invitation retry target is unavailable.");
    },
    onSuccess: (response, invitation) => {
      const key = `${invitation.leagueId ?? "legacy"}:${invitation.bowlerId ?? invitation.userId ?? "unknown"}`;
      const status: ResendStatus = response?.data?.emailSent === true ? "accepted" : "not_sent";
      setResendStatus((previous) => ({ ...previous, [key]: status }));
      queryClient.invalidateQueries({ queryKey: ["/api/org-admin/users"] });
      toast({
        title: status === "accepted" ? "Invitation email submitted" : "Invitation email not sent",
        description: status === "accepted"
          ? "The invitation email was submitted for this bowler."
          : "The invitation remains active, but no email was sent. You can try again later.",
        variant: status === "accepted" ? "default" : "destructive",
      });
    },
    onError: (error: Error, invitation) => {
      const key = `${invitation.leagueId ?? "legacy"}:${invitation.bowlerId ?? invitation.userId ?? "unknown"}`;
      setResendStatus((previous) => ({ ...previous, [key]: "unknown" }));
      toast({
        title: "Invitation email status unknown",
        description: `${error.message || "We could not confirm the request."} Check the inbox before trying again.`,
        variant: "destructive",
      });
    },
  });

  const created = inviteResult.attempted ?? inviteResult.created ?? inviteResult.sent;
  const emailAccepted = inviteResult.emailAccepted ?? inviteResult.sent;
  const deliveryFailed = inviteResult.deliveryFailed ?? 0;
  const failedInvitations = inviteResult.failedInvitations ?? [];

  return (
    <Card>
      <CardContent padding="topComfortable" spacing="normal">
        <div className="flex items-center gap-2 mb-2">
          <Mail className="size-5 text-primary" />
          <h3 className="font-semibold">Invite Results</h3>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 text-center">
          <div>
            <p className="text-2xl font-bold text-primary">{created}</p>
            <p className="text-sm text-muted-foreground">Invitations attempted</p>
          </div>
          <div>
            <p className="text-2xl font-bold">{emailAccepted}</p>
            <p className="text-sm text-muted-foreground">Batch email submitted</p>
          </div>
          <div>
            <p className="text-2xl font-bold">{deliveryFailed}</p>
            <p className="text-sm text-muted-foreground">Batch email not sent</p>
          </div>
          <div>
            <p className="text-2xl font-bold">{inviteResult.alreadyRegistered}</p>
            <p className="text-sm text-muted-foreground">Already registered</p>
          </div>
          <div>
            <p className="text-2xl font-bold">{inviteResult.noEmail}</p>
            <p className="text-sm text-muted-foreground">No email on file</p>
          </div>
        </div>

        {failedInvitations.length > 0 && (
          <div className="mt-5 space-y-2" data-testid="failed-invitations">
            <p className="text-sm font-medium">Invitations needing email recovery</p>
            {failedInvitations.map((invitation) => {
              const key = `${invitation.leagueId ?? "legacy"}:${invitation.bowlerId ?? invitation.userId ?? "unknown"}`;
              const status = resendStatus[key];
              const isResending = resendMutation.isPending && resendMutation.variables === invitation;
              return (
                <div key={key} className="flex flex-wrap items-center justify-between gap-2 rounded border p-2 text-sm">
                  <span>{invitation.name}</span>
                  {status === "accepted" ? (
                    <span className="text-sm text-muted-foreground">Email submitted</span>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => resendMutation.mutate(invitation)}
                      disabled={resendMutation.isPending}
                      data-testid={`button-resend-invitation-${invitation.bowlerId ?? invitation.userId}`}
                    >
                      {isResending ? <Loader2 className="size-4 mr-1 animate-spin" /> : <RefreshCw className="size-4 mr-1" />}
                      {status === "unknown" ? "Check or retry email" : "Resend email"}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
