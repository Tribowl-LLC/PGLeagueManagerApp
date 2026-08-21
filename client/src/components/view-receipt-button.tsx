import { useState } from "react";
import { useLocation } from "wouter";
import { Loader2, Receipt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { csrfFetch, queryClient } from "@/lib/queryClient";
import {
  PROVIDER_NOT_CONFIGURED,
  providerNotConfiguredToast,
} from "@/lib/provider-not-configured";
import type { Payment } from "@shared/schema";

interface Props {
  payment: Payment;
  variant?: "icon" | "link";
  /** Owning location used to deep-link the PROVIDER_NOT_CONFIGURED toast. */
  locationId?: number | null;
}

/**
 * Opens the Square hosted receipt for a paid card payment. If
 * `payment.receiptUrl` is cached we open it directly; otherwise
 * we GET /payments/:id/receipt which lazy-backfills via the
 * provider and caches the URL on the row. Renders nothing for
 * rows without a receipt or backfill source.
 */
export function ViewReceiptButton({ payment, variant = "icon", locationId }: Props) {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [isFetching, setIsFetching] = useState(false);
  // The hook caches per-locationId so a 50-row table
  // with one league only fetches the config once. (Task #599.)

  // Show the button for any paid card row that either has a cached
  // receipt URL or a provider payment id we can fetch by. Provider
  // resolution happens server-side in the lazy-backfill endpoint;
  // legacy non-Square rows simply 404 cleanly and surface a toast.
  const isCardPaid =
    payment.status === "paid" &&
    (payment.type === "square" || payment.type === "credit_card");
  const hasReceipt = !!payment.receiptUrl;
  const canBackfill = !!payment.providerPaymentId;

  if (!isCardPaid || (!hasReceipt && !canBackfill)) {
    return variant === "link" ? <span className="text-muted-foreground">-</span> : null;
  }

  const fetchAndOpen = async () => {
    try {
      setIsFetching(true);
      const response = await csrfFetch(
        `/api/payments-provider/payments/${payment.id}/receipt`,
      );
      const data = await response.json();
      if (!response.ok) {
        const code = data?.error?.code;
        if (code === PROVIDER_NOT_CONFIGURED) {
          toast(
            providerNotConfiguredToast({
              navigate,
              locationId: locationId ?? null,
            }),
          );
          return;
        }
        const msg =
          code === "RECEIPT_UNAVAILABLE"
            ? "No receipt is available for this payment yet. The provider may not have generated one."
            : data?.error?.message || "Could not fetch receipt.";
        toast({ title: "Receipt unavailable", description: msg, variant: "destructive" });
        return;
      }
      const url: string | undefined = data?.data?.receiptUrl;
      if (!url) {
        toast({
          title: "Receipt unavailable",
          description: "No receipt URL was returned.",
          variant: "destructive",
        });
        return;
      }
      // Refresh payment lists so the cached URL shows up next render.
      queryClient.invalidateQueries({ queryKey: ["/api/payments"] });
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (error) {
      toast({
        title: "Receipt unavailable",
        description: error instanceof Error ? error.message : "Could not fetch receipt.",
        variant: "destructive",
      });
    } finally {
      setIsFetching(false);
    }
  };

  // Always use the scoped receipt endpoint, even when a URL is cached on the
  // compatibility payment row.  Opening the raw cached URL would bypass the
  // F5 payer/partner/admin privacy decision.
  const onClick = fetchAndOpen;
  const title = hasReceipt ? "View receipt" : "Look up receipt";

  if (variant === "link") {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={isFetching}
        className="inline-flex items-center gap-1 text-sm text-primary hover:underline disabled:opacity-50"
        title={title}
      >
        {isFetching ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Receipt className="size-4" />
        )}
        {hasReceipt ? "View" : "Look up"}
      </button>
    );
  }

  return (
    <Button
      size="icon"
      variant="ghost"
      onClick={onClick}
      disabled={isFetching}
      title={title}
    >
      {isFetching ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <Receipt className="size-4 text-primary" />
      )}
    </Button>
  );
}
