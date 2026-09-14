import { Loader2, Pencil, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { languageLabelFor } from "@/lib/preferred-language";
import type { CurrentUserWithSyncStatus } from "./profile-info-card";

interface ProfileInfoViewProps {
  currentUser: CurrentUserWithSyncStatus;
  showRetry: boolean;
  inRetryCooldown: boolean;
  cooldownSecondsLeft: number;
  retryPending: boolean;
  onEdit: () => void;
  onRetry: () => void;
}

export function ProfileInfoView({
  currentUser,
  showRetry,
  inRetryCooldown,
  cooldownSecondsLeft,
  retryPending,
  onEdit,
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
