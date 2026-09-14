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
import type { CanonicalPaymentRow } from "@shared/canonical-payment-report";

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
  /** Admin-only, server-authorized allocation evidence for the whole tender. */
  refundEvidence?: CanonicalPaymentRow | null;
  onClose: () => void;
  onConfirm: (id: number, reason: string | undefined, disposition: "still_owed" | "waived") => void;
  isPending: boolean;
}

type RefundAllocation = CanonicalPaymentRow["allocations"][number] & { bowlerName?: string | null };
type RefundRecipientSummary = { bowlerId: number; name: string; amountMinor: number; coveredWeeks: string[]; currency: string };

function formatLocalDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[2]}/${match[3]}/${match[1]}` : value;
}

function allocationLabel(allocation: RefundAllocation): string {
  if (allocation.plannedOrdinal !== null && allocation.plannedOrdinal !== undefined) return `Week ${allocation.plannedOrdinal}`;
  return allocation.occurrenceLocalDate ? formatLocalDate(allocation.occurrenceLocalDate) : "Covered week";
}

function buildRecipientSummaries(refundEvidence: CanonicalPaymentRow | null | undefined): RefundRecipientSummary[] | null {
  if (!refundEvidence || refundEvidence.allocations.length === 0) return null;
  const allocations = refundEvidence.allocations as RefundAllocation[];
  // A refund must not silently present the payer as the only affected person.
  // Admin evidence must identify every positive allocation before we enable
  // the whole-payment action.
  if (allocations.some((allocation) => allocation.amountMinor <= 0 || !allocation.bowlerName?.trim())) return null;
  const summaries = new Map<number, RefundRecipientSummary>();
  for (const allocation of allocations) {
    const existing = summaries.get(allocation.bowlerId);
    const week = allocationLabel(allocation);
    if (existing) {
      existing.amountMinor += allocation.amountMinor;
      if (!existing.coveredWeeks.includes(week)) existing.coveredWeeks.push(week);
    } else {
      summaries.set(allocation.bowlerId, {
        bowlerId: allocation.bowlerId,
        name: allocation.bowlerName?.trim() ?? "",
        amountMinor: allocation.amountMinor,
        coveredWeeks: [week],
        currency: allocation.currency,
      });
    }
  }
  return [...summaries.values()];
}

export function RefundPaymentDialog({ payment, refundEvidence, onClose, onConfirm, isPending }: Props) {
  const [reason, setReason] = useState("");
  const [disposition, setDisposition] = useState<"still_owed" | "waived" | null>(null);
  const recipientSummaries = buildRecipientSummaries(refundEvidence);
  const allocationEvidenceUnavailable = payment !== null && recipientSummaries === null;

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
        {payment && allocationEvidenceUnavailable ? (
          <Alert variant="destructive" data-testid="refund-allocation-evidence-error">
            <AlertTriangle className="size-4" />
            <AlertDescription>
              Recipient allocation evidence is unavailable. Reload the payment list before refunding this payment; no recipient balance will be guessed.
            </AlertDescription>
          </Alert>
        ) : payment && recipientSummaries ? (
          <section className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3" aria-label="Whole payment refund allocation">
            <p className="text-sm font-medium">This refunds the entire payment for everyone listed below.</p>
            <div className="divide-y rounded-md border bg-background">
              {recipientSummaries.map((recipient) => (
                <div key={recipient.bowlerId} className="px-3 py-2 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium">{recipient.name}</span>
                    <span className="font-medium">{(recipient.amountMinor / 100).toLocaleString("en-US", { style: "currency", currency: recipient.currency })}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">{recipient.coveredWeeks.join(" · ")}</div>
                </div>
              ))}
            </div>
          </section>
        ) : null}
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
                <span className="block text-xs text-muted-foreground">The affected recipients and weeks require a one-time payment for the full remaining balance before standing autopay resumes.</span>
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
                <span className="block text-xs text-muted-foreground">Only the refunded allocation amounts are waived. Any other unpaid balance remains due.</span>
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
            disabled={isPending || disposition === null || allocationEvidenceUnavailable}
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
