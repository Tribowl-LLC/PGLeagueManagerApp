import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { Loader2, Send } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { csrfFetch } from "@/lib/queryClient";
import {
  isProviderNotConfiguredError,
  providerNotConfiguredToast,
  makeApiError,
} from "@/lib/provider-not-configured";
import type { Payment } from "@shared/schema";

interface Props {
  payment: Payment | null;
  defaultEmail?: string;
  onClose: () => void;
  /** Owning location used to deep-link the PROVIDER_NOT_CONFIGURED toast. */
  locationId?: number | null;
}

export function ResendReceiptDialog({ payment, defaultEmail, onClose, locationId }: Props) {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [email, setEmail] = useState(defaultEmail ?? "");
  const [isPending, setIsPending] = useState(false);
  useEffect(() => {
    if (payment) {
      setEmail(defaultEmail ?? "");
    }
  }, [payment, defaultEmail]);

  const handleSubmit = async () => {
    if (!payment) return;
    const trimmed = email.trim();
    if (trimmed && !trimmed.includes("@")) {
      toast({
        title: "Invalid email",
        description: "Enter a valid email address or leave blank to use the bowler's email on file.",
        variant: "destructive",
      });
      return;
    }

    try {
      setIsPending(true);
      const response = await csrfFetch(
        `/api/payments-provider/payments/${payment.id}/resend-receipt`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(trimmed ? { email: trimmed } : {}),
        },
      );
      const data = await response.json();
      if (!response.ok) {
        throw makeApiError(data, response.status, "Failed to resend receipt");
      }
      toast({
        title: "Receipt sent",
        description: trimmed
          ? `Receipt emailed to ${trimmed}.`
          : "Receipt emailed to the bowler's address on file.",
      });
      onClose();
    } catch (error) {
      if (isProviderNotConfiguredError(error)) {
        toast(
          providerNotConfiguredToast({
            navigate,
            locationId: locationId ?? null,
          }),
        );
      } else {
        toast({
          title: "Error",
          description: error instanceof Error ? error.message : "Failed to resend receipt",
          variant: "destructive",
        });
      }
    } finally {
      setIsPending(false);
    }
  };

  return (
    <Dialog open={payment !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Resend Receipt</DialogTitle>
          <DialogDescription>
            Email the Square receipt link for this payment to a recipient.
            Useful when the bowler had no email on file at checkout or the
            original receipt didn't reach them.
          </DialogDescription>
        </DialogHeader>
        <div className="py-2 space-y-2">
          <Label htmlFor="resend-receipt-email">Email address (optional)</Label>
          <Input
            id="resend-receipt-email"
            type="email"
            placeholder="Leave blank to use the bowler's email on file"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
          />
          <p className="text-xs text-muted-foreground">
            Leave blank to send to the bowler's email on file, or enter a different address.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isPending}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={isPending}>
            {isPending ? (
              <Loader2 className="size-4 animate-spin mr-2" />
            ) : (
              <Send className="size-4 mr-2" />
            )}
            Send Receipt
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
