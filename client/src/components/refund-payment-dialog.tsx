import { useState, useEffect } from "react";
import { Loader2, RotateCcw, AlertTriangle } from "lucide-react";
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { isCardPaymentType } from "@shared/schema/constants";
import type { Payment } from "@shared/schema";

function refundProviderHint(payment: Payment): string {
  if (payment.type === "credit_card" || payment.type === "square") return " The refund will be processed through Square.";
  if (isCardPaymentType(payment.type)) return " The refund will be processed through your payment provider.";
  return "";
}

function paymentLabel(payment: Payment): string {
  switch (payment.type) {
    case "credit_card": return "Credit Card";
    case "square": return "Square";
    case "check": return "Check";
    case "cash": return "Cash";
    default: return payment.type;
  }
}

interface Props {
  payment: Payment | null;
  onClose: () => void;
  onConfirm: (id: number, reason: string | undefined, disposition: "still_owed" | "waived") => void;
  isPending: boolean;
}

export function RefundPaymentDialog({ payment, onClose, onConfirm, isPending }: Props) {
  const [reason, setReason] = useState("");
  const [disposition, setDisposition] = useState<"still_owed" | "waived" | null>(null);

  useEffect(() => {
    if (!payment) {
      setReason("");
      setDisposition(null);
    }
  }, [payment]);

  return (
    <Dialog open={payment !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Refund Payment</DialogTitle>
          <DialogDescription>
            {payment && (
              <>
                Refund <strong>${(payment.amount / 100).toFixed(2)}</strong> ({paymentLabel(payment)})?
                {refundProviderHint(payment)}
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        {payment?.receiptEmailMissing && (
          <Alert>
            <AlertTriangle className="size-4" />
            <AlertDescription>
              The original charge was processed without a buyer email, so
              Square will not auto-email a refund receipt either. Use
              <strong> Resend Receipt </strong>
              after the refund to send confirmation manually.
            </AlertDescription>
          </Alert>
        )}
        <div className="py-2">
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">What should happen to the refunded roster amount? <span aria-hidden="true">*</span></legend>
            <label className="flex items-start gap-2 rounded-md border p-3 cursor-pointer">
              <input
                type="radio"
                name="refund-disposition"
                value="still_owed"
                checked={disposition === "still_owed"}
                onChange={() => setDisposition("still_owed")}
                disabled={isPending}
              />
              <span>
                <span className="block text-sm font-medium">Still owed</span>
                <span className="block text-xs text-muted-foreground">The affected payer and weeks require a one-time payment for the full remaining balance before standing autopay resumes.</span>
              </span>
            </label>
            <label className="flex items-start gap-2 rounded-md border p-3 cursor-pointer">
              <input
                type="radio"
                name="refund-disposition"
                value="waived"
                checked={disposition === "waived"}
                onChange={() => setDisposition("waived")}
                disabled={isPending}
              />
              <span>
                <span className="block text-sm font-medium">Waive this amount</span>
                <span className="block text-xs text-muted-foreground">Only the refunded allocation amount is waived. Any other unpaid balance remains due.</span>
              </span>
            </label>
          </fieldset>
          <label htmlFor="refund-reason" className="text-sm font-medium">Reason (optional)</label>
          <Input
            id="refund-reason"
            placeholder="Enter refund reason..."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="mt-1"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            variant="destructive"
            onClick={() => { if (payment && disposition) onConfirm(payment.id, reason || undefined, disposition); }}
            disabled={isPending || disposition === null}
          >
            {isPending ? (
              <Loader2 className="size-4 animate-spin mr-2" />
            ) : (
              <RotateCcw className="size-4 mr-2" />
            )}
            Process Refund
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
