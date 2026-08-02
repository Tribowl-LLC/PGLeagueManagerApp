import { useMutation } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AlertTriangle, Clock, Loader2, RefreshCw } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  PAYMENT_SYNC_MAX_ATTEMPTS,
  parsePaymentSyncStatus,
  type Bowler,
  type PaymentSyncStatus,
} from "@shared/schema";

type Props = {
  bowler: Pick<
    Bowler,
    "id" | "paymentSyncPendingAt" | "paymentSyncAttempts" | "paymentSyncLastAttemptAt" | "paymentSyncNextRetryAt"
  >;
  // When true, render a compact badge-only view suitable for table cells.
  // When false (default), render the badge plus a Retry button — used on
  // detail pages where there is room for the action.
  compact?: boolean;
  // Query keys to invalidate after a successful retry. Callers pass the
  // queries that hold the bowler row so the badge updates without a manual
  // refresh. Defaults to invalidating the bowlers list.
  invalidateOnSuccess?: ReadonlyArray<readonly unknown[]>;
};

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "never";
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return "unknown";
  const diffMs = Date.now() - ts;
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function PaymentSyncRetryStatus({
  bowler,
  compact = false,
  invalidateOnSuccess = [["/api/bowlers"]],
}: Props) {
  const { toast } = useToast();

  const retryMutation = useMutation({
    // The response's `paymentSyncStatus` is treated as `unknown` on
    // purpose: the parser below is the single trust boundary for
    // collapsing it to the canonical `PaymentSyncStatus` union, so
    // an older client + newer server (or a malformed response) can't
    // sneak a string compare past us and fire a misleading toast.
    mutationFn: async (): Promise<{ data?: { paymentSyncStatus?: unknown } }> => {
      const resp = await apiRequest(
        `/api/account/bowlers/${bowler.id}/retry-payment-sync`,
        "POST",
      );
      return resp as { data?: { paymentSyncStatus?: unknown } };
    },
    onSuccess: (resp) => {
      // Route through the shared parser (see shared/schema/bowlers.ts):
      // an unknown / missing value collapses to `not_applicable`, so
      // the success toast only fires on a real `'synced'` confirmation
      // — never on absent data, never on a future status the client
      // doesn't know about yet.
      const status: PaymentSyncStatus = parsePaymentSyncStatus(
        resp?.data?.paymentSyncStatus,
      );
      const ok = status === "synced";
      toast({
        title: ok ? "Payment sync succeeded" : "Payment sync still pending",
        description: ok
          ? "The bowler is back in sync with the payment provider."
          : "The provider call did not succeed; the bowler will keep retrying in the background.",
        variant: ok ? "default" : "destructive",
      });
      for (const key of invalidateOnSuccess) {
        queryClient.invalidateQueries({ queryKey: key as unknown[] });
      }
    },
    onError: (error: Error) => {
      toast({
        title: "Retry failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  if (!bowler.paymentSyncPendingAt) {
    return null;
  }

  const attempts = bowler.paymentSyncAttempts ?? 0;
  const givenUp = attempts >= PAYMENT_SYNC_MAX_ATTEMPTS;
  const automaticRetryPaused = !givenUp && bowler.paymentSyncNextRetryAt == null;
  const lastAttemptLabel = formatRelativeTime(bowler.paymentSyncLastAttemptAt);

  // "Given up" is visually distinct (destructive variant + alert icon) so
  // ops can tell at a glance which bowlers need a manual retry.
  const badge = givenUp ? (
    <Badge variant="destructive" data-testid={`badge-payment-sync-given-up-${bowler.id}`}>
      <AlertTriangle className="size-3 mr-1" />
      Sync given up
    </Badge>
  ) : (
    <Badge variant="secondary" data-testid={`badge-payment-sync-pending-${bowler.id}`}>
      <Clock className="size-3 mr-1" />
      Sync pending
    </Badge>
  );

  const tooltipBody = (
    <div className="text-xs space-y-0.5">
      <div>
        Attempt {Math.min(attempts, PAYMENT_SYNC_MAX_ATTEMPTS)}/
        {PAYMENT_SYNC_MAX_ATTEMPTS}
      </div>
      <div>Last attempt: {lastAttemptLabel}</div>
      {givenUp ? (
        <div className="text-destructive-foreground/90">
          Background sweep stopped. Use Retry to try again manually.
        </div>
      ) : automaticRetryPaused ? (
        <div>Automatic retry paused. Use Retry after fixing provider configuration.</div>
      ) : (
        <div>Background sweep will keep retrying with backoff.</div>
      )}
    </div>
  );

  const wrappedBadge = (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">{badge}</span>
        </TooltipTrigger>
        <TooltipContent>{tooltipBody}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );

  if (compact) {
    return wrappedBadge;
  }

  return (
    <div className="flex items-center gap-2">
      {wrappedBadge}
      <Button
        size="sm"
        variant={givenUp ? "destructive" : "outline"}
        onClick={() => retryMutation.mutate()}
        disabled={retryMutation.isPending}
        data-testid={`button-retry-payment-sync-${bowler.id}`}
      >
        {retryMutation.isPending ? (
          <Loader2 className="size-3 mr-1 animate-spin" />
        ) : (
          <RefreshCw className="size-3 mr-1" />
        )}
        Retry sync
      </Button>
    </div>
  );
}
