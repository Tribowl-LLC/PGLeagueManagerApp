import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { csrfFetch, queryClient } from "@/lib/queryClient";
import type { CanonicalPaymentRow } from "@shared/canonical-payment-report";
import type { Payment } from "@shared/schema";

type Props = {
  payment: Payment | null;
  evidence: CanonicalPaymentRow | null;
  bowlerName: string;
  canCorrect: boolean;
  onClose: () => void;
};

export function formatPaymentEvidenceStatus(status: CanonicalPaymentRow["status"]): string {
  switch (status) {
    case "confirmed_paid": return "Confirmed paid";
    case "review_required": return "Review required";
    default: return status.charAt(0).toUpperCase() + status.slice(1);
  }
}

export function paymentEvidenceDisplayStatus(evidence: CanonicalPaymentRow): string {
  return evidence.unresolved || evidence.source === "unresolved_operation"
    ? "Review required"
    : formatPaymentEvidenceStatus(evidence.status);
}

function formatCurrency(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amountMinor / 100);
}

function formatLocalDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[2]}/${match[3]}/${match[1]}` : value;
}

function paymentTypeLabel(payment: Payment): string {
  switch (payment.type) {
    case "cash": return "Cash";
    case "check": return payment.checkNumber ? `Check #${payment.checkNumber}` : "Check";
    case "credit_card": return "Credit Card";
    case "square": return "Square";
    default: return "Other Payment";
  }
}

async function correctionFingerprint(payload: { paymentId: number; correctionMode: "void_only"; reason: string }) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(payload)));
  return `lvcorrection:v3:${Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export function PaymentDetailsDialog({ payment, evidence, bowlerName, canCorrect, onClose }: Props) {
  const [editingCorrection, setEditingCorrection] = useState(false);
  const [reason, setReason] = useState("");
  const [correctionBusy, setCorrectionBusy] = useState(false);
  const [correctionError, setCorrectionError] = useState<string | null>(null);

  if (!payment || !evidence) return null;

  const canVoid = canCorrect
    && evidence.paymentId !== null
    && (evidence.paymentType === "cash" || evidence.paymentType === "check")
    && evidence.allocations.some((allocation) => allocation.state === "active");
  const displayStatus = paymentEvidenceDisplayStatus(evidence);

  const submitCorrection = async () => {
    const trimmedReason = reason.trim();
    if (!trimmedReason || evidence.paymentId === null) return;
    setCorrectionBusy(true);
    setCorrectionError(null);
    try {
      const fingerprintPayload = {
        paymentId: evidence.paymentId,
        correctionMode: "void_only" as const,
        reason: trimmedReason,
      };
      const idempotencyKey = crypto.randomUUID();
      const response = await csrfFetch(`/api/financials/leagues/${evidence.leagueId}/canonical/corrections/1`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({
          ...fingerprintPayload,
          idempotencyKey,
          requestFingerprint: await correctionFingerprint(fingerprintPayload),
        }),
      });
      if (!response.ok) throw new Error("Payment correction could not be recorded");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/payments"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/financials/f5/payments"] }),
      ]);
      onClose();
    } catch {
      setCorrectionError("Payment correction could not be recorded");
    } finally {
      setCorrectionBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !correctionBusy) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Payment Details</DialogTitle>
          <DialogDescription>
            Canonical settlement and allocation details for {bowlerName}.
          </DialogDescription>
        </DialogHeader>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <div><dt className="text-muted-foreground">Collected</dt><dd>{formatLocalDate(evidence.authoritativeLocalDate)}</dd></div>
          <div><dt className="text-muted-foreground">Amount</dt><dd>{formatCurrency(evidence.amountMinor, evidence.currency)}</dd></div>
          <div><dt className="text-muted-foreground">Payment type</dt><dd>{paymentTypeLabel(payment)}</dd></div>
          <div><dt className="text-muted-foreground">Settlement</dt><dd><Badge variant="outline">{displayStatus}</Badge></dd></div>
        </dl>

        <section className="space-y-2" aria-labelledby="payment-allocation-heading">
          <h3 id="payment-allocation-heading" className="font-medium">Applied to</h3>
          {evidence.allocations.length === 0 ? (
            <p className="text-sm text-muted-foreground">No canonical allocation is recorded.</p>
          ) : (
            <div className="divide-y rounded-md border">
              {evidence.allocations.map((allocation, index) => (
                <div key={allocation.allocationId ?? `${allocation.occurrenceId ?? "allocation"}-${index}`} className="flex items-center justify-between gap-4 px-3 py-2 text-sm">
                  <div>
                    <div>{allocation.occurrenceLocalDate ? formatLocalDate(allocation.occurrenceLocalDate) : "Canonical occurrence"}</div>
                    {allocation.state && allocation.state !== "active" && <div className="text-xs capitalize text-muted-foreground">{allocation.state}</div>}
                  </div>
                  <span className="font-medium">{formatCurrency(allocation.amountMinor, allocation.currency)}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        {(evidence.unallocatedMinor > 0 || evidence.refund.present || evidence.dispute.present || evidence.reviewRequired) && (
          <section className="space-y-1 rounded-md border bg-muted/30 p-3 text-sm" aria-label="Additional settlement evidence">
            {evidence.unallocatedMinor > 0 && <p>Unallocated: {formatCurrency(evidence.unallocatedMinor, evidence.currency)}</p>}
            {evidence.refund.present && <p>Refunded: {formatCurrency(evidence.refund.amountMinor, evidence.currency)}</p>}
            {evidence.dispute.present && <p>Dispute: {evidence.dispute.state ?? "Review required"}{evidence.dispute.amountMinor > 0 ? ` · ${formatCurrency(evidence.dispute.amountMinor, evidence.currency)}` : ""}</p>}
            {evidence.reviewRequired && <p className="font-medium text-destructive">This payment requires review.</p>}
          </section>
        )}

        {canVoid && (
          <section className="space-y-2 border-t pt-4" aria-label="Payment correction">
            {editingCorrection ? (
              <>
                <label className="grid gap-1 text-sm">
                  Correction reason
                  <input className="rounded-md border bg-background px-3 py-2" value={reason} onChange={(event) => setReason(event.target.value)} disabled={correctionBusy} />
                </label>
                {correctionError && <p role="alert" className="text-sm text-destructive">{correctionError}</p>}
                <div className="flex gap-2">
                  <Button variant="destructive" size="sm" disabled={correctionBusy || !reason.trim()} onClick={() => void submitCorrection()}>{correctionBusy ? "Voiding…" : "Void payment"}</Button>
                  <Button variant="outline" size="sm" disabled={correctionBusy} onClick={() => { setEditingCorrection(false); setReason(""); setCorrectionError(null); }}>Cancel</Button>
                </div>
              </>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setEditingCorrection(true)}>Void cash/check payment</Button>
            )}
          </section>
        )}

        <DialogFooter>
          <Button variant="outline" disabled={correctionBusy} onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
