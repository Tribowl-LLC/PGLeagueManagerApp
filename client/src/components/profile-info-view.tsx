import { Loader2, Pencil, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { languageLabelFor } from "@/lib/preferred-language";
import type { CurrentUserWithSyncStatus, PendingEmailChange } from "./profile-info-card";

interface ProfileInfoViewProps {
  currentUser: CurrentUserWithSyncStatus;
  pendingEmailChange: PendingEmailChange | null;
  showRetry: boolean;
  inRetryCooldown: boolean;
  cooldownSecondsLeft: number;
  retryPending: boolean;
  onEdit: () => void;
  onRetryEmailChange: () => void;
  onRetry: () => void;
}

export function ProfileInfoView({
  currentUser,
  pendingEmailChange,
  showRetry,
  inRetryCooldown,
  cooldownSecondsLeft,
  retryPending,
  onEdit,
  onRetryEmailChange,
  onRetry,
}: ProfileInfoViewProps) {
  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-medium text-muted-foreground">Name</p>
        <p className="text-sm mt-1">{currentUser.name}</p>
      </div>
      <div>
        <p className="text-sm font-medium text-muted-foreground">Email</p>
        <p className="text-sm mt-1">{currentUser.email}</p>
      </div>
      {pendingEmailChange && (
        <div className="rounded-md border border-primary/30 bg-primary/5 p-3 space-y-1" data-testid="email-change-pending">
          <p className="text-sm font-medium">Email change pending</p>
          <p className="text-sm text-muted-foreground">
            Your sign-in email remains {currentUser.email} until {pendingEmailChange.requestedEmail} confirms the change.
          </p>
          {pendingEmailChange.confirmation === "accepted" ? (
            <p className="text-sm text-muted-foreground">The confirmation email was submitted.</p>
          ) : pendingEmailChange.confirmation === "not_sent" ? (
            <p className="text-sm text-destructive">The confirmation email was not sent. Use Retry email change to try the same address again.</p>
          ) : (
            <p className="text-sm text-muted-foreground">We could not confirm the confirmation email request. Check the inbox before trying the same address again.</p>
          )}
          {pendingEmailChange.notification === "accepted" ? (
            <p className="text-xs text-muted-foreground">A security notification to the current address was submitted.</p>
          ) : pendingEmailChange.notification === "not_sent" ? (
            <p className="text-xs text-muted-foreground">A security notification to the current address was not sent.</p>
          ) : (
            <p className="text-xs text-muted-foreground">We could not confirm the security notification to the current address.</p>
          )}
          {pendingEmailChange.confirmation !== "accepted" && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onRetryEmailChange}
              data-testid="button-retry-email-change"
            >
              Retry email change
            </Button>
          )}
        </div>
      )}
      <div>
        <p className="text-sm font-medium text-muted-foreground">Phone</p>
        <p className="text-sm mt-1">{currentUser.phone || "Not provided"}</p>
      </div>
      <div>
        <p className="text-sm font-medium text-muted-foreground">Preferred language</p>
        <p className="text-sm mt-1" data-testid="text-preferred-language">
          {languageLabelFor(currentUser.preferredLanguage)}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={onEdit}>
          <Pencil className="size-4" />
          Edit Profile
        </Button>
        {showRetry && (
          <Button
            variant="outline"
            onClick={onRetry}
            disabled={retryPending || inRetryCooldown}
            data-testid="button-retry-payment-sync"
          >
            {retryPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            Retry payment sync
          </Button>
        )}
      </div>
      {showRetry && inRetryCooldown && (
        <p
          className="text-xs text-muted-foreground"
          data-testid="text-retry-cooldown"
        >
          Try again in {cooldownSecondsLeft}s
        </p>
      )}
      {showRetry && !inRetryCooldown && (
        <p className="text-xs text-muted-foreground">
          Your payment profile is temporarily out of date. We're retrying in the background; use this button to retry now.
        </p>
      )}
    </div>
  );
}
