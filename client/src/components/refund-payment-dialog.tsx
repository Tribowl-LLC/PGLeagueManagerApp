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
type RefundRecipientSummary = {
  bowlerId: number;
  name: string;
  amountMinor: number;
  coveredWeeks: string[];
  currency: string;
  effect: "unused_credit" | "allocation";
};
type RefundSummary = { recipients: RefundRecipientSummary[]; hasSpentAllocation: boolean };

function formatLocalDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[2]}/${match[3]}/${match[1]}` : value;
}

function allocationLabel(allocation: RefundAllocation): string {
  if (allocation.plannedOrdinal !== null && allocation.plannedOrdinal !== undefined) return `Week ${allocation.plannedOrdinal}`;
  return allocation.occurrenceLocalDate ? formatLocalDate(allocation.occurrenceLocalDate) : "Covered week";
}

function buildRefundSummary(payment: Payment | null, refundEvidence: CanonicalPaymentRow | null | undefined): RefundSummary | null {
  if (!payment || !refundEvidence
    || refundEvidence.paymentId !== payment.id
    || refundEvidence.leagueId !== payment.leagueId
    || refundEvidence.bowlerId !== payment.bowlerId) return null;

  const portions = refundEvidence.fundingPortions;
  if (portions !== undefined) {
    // Admin-only owned source evidence is required to identify unused credit
    // owners. Keep it exact and fail closed instead of falling back to the
    // initiating payer when a source partition is malformed or incomplete.
    const fundingIds = new Set<string>();
    const ownerPortionIndexes = new Set<string>();
    const uniquePortionIdentities = portions.every((portion) => {
      if (typeof portion.fundingId !== "string" || portion.fundingId.length === 0
        || !Number.isSafeInteger(portion.creditedBowlerId) || (portion.creditedBowlerId ?? 0) <= 0
        || !Number.isSafeInteger(portion.portionIndex) || (portion.portionIndex ?? -1) < 0) return false;
      const ownerPortionKey = `${portion.creditedBowlerId}:${portion.portionIndex}`;
      if (fundingIds.has(portion.fundingId) || ownerPortionIndexes.has(ownerPortionKey)) return false;
      fundingIds.add(portion.fundingId);
      ownerPortionIndexes.add(ownerPortionKey);
      return true;
    });
    const validOwnedSource = isCardPaymentType(payment.type)
      && payment.status === "paid"
      && payment.refundedAt === null
      && payment.squareRefundId === null
      && payment.refundReason === null
      && payment.disputeId === null
      && payment.disputedAt === null
      && refundEvidence.status === "confirmed_paid"
      && (refundEvidence.source === "prepaid_credit" || refundEvidence.source === "canonical_allocation")
      && (refundEvidence.allocatedMinor === 0
        ? refundEvidence.source === "prepaid_credit"
        : refundEvidence.source === "canonical_allocation")
      && Number.isSafeInteger(refundEvidence.amountMinor)
      && refundEvidence.amountMinor === payment.amount
      && Number.isSafeInteger(refundEvidence.allocatedMinor)
      && refundEvidence.allocatedMinor >= 0
      && Number.isSafeInteger(refundEvidence.unallocatedMinor)
      && refundEvidence.unallocatedMinor >= 0
      && !refundEvidence.unresolved
      && !refundEvidence.reviewRequired
      && !refundEvidence.refund.present
      && refundEvidence.refund.amountMinor === 0
      && refundEvidence.refund.providerRefundId === null
      && (!refundEvidence.creditRefunds || (refundEvidence.creditRefunds.completedAmountMinor === 0
        && refundEvidence.creditRefunds.heldAmountMinor === 0
        && !refundEvidence.creditRefunds.reviewRequired
        && refundEvidence.creditRefunds.providerRefundIds.length === 0))
      && !refundEvidence.dispute.present
      && refundEvidence.dispute.amountMinor === 0
      && refundEvidence.dispute.disputeId === null
      && !refundEvidence.dispute.reviewRequired
      && portions.length > 0
      && uniquePortionIdentities
      && portions.every((portion) => Number.isSafeInteger(portion.amountMinor)
        && portion.amountMinor > 0
        && typeof portion.fundingId === "string"
        && portion.fundingId.length > 0
        && Number.isSafeInteger(portion.portionIndex)
        && (portion.portionIndex ?? -1) >= 0
        && Number.isSafeInteger(portion.creditedBowlerId)
        && (portion.creditedBowlerId ?? 0) > 0
        && Boolean(portion.creditedBowlerName?.trim())
        && Number.isSafeInteger(portion.availableMinor)
        && Number.isSafeInteger(portion.appliedMinor)
        && Number.isSafeInteger(portion.refundedCreditMinor)
        && Number.isSafeInteger(portion.totalRefundedMinor)
        && Number.isSafeInteger(portion.heldCreditMinor)
        && portion.availableMinor >= 0
        && portion.appliedMinor >= 0
        && portion.refundedCreditMinor === 0
        && portion.totalRefundedMinor === 0
        && portion.heldCreditMinor === 0
        && portion.availableMinor + portion.appliedMinor === portion.amountMinor
        && !portion.reviewRequired)
      && portions.reduce((sum, portion) => sum + portion.amountMinor, 0) === refundEvidence.amountMinor
      && portions.reduce((sum, portion) => sum + portion.availableMinor, 0) === refundEvidence.unallocatedMinor
      && portions.reduce((sum, portion) => sum + portion.appliedMinor, 0) === refundEvidence.allocatedMinor;

    if (!validOwnedSource) return null;
    const allocations = refundEvidence.allocations.filter((allocation) => allocation.state === "active") as RefundAllocation[];
    if (allocations.some((allocation) => !Number.isSafeInteger(allocation.bowlerId)
      || allocation.bowlerId <= 0
      || !Number.isSafeInteger(allocation.amountMinor)
      || allocation.amountMinor <= 0
      || !allocation.bowlerName?.trim())
      || allocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0) !== refundEvidence.allocatedMinor) return null;

    const summaries: RefundRecipientSummary[] = [];
    const spentByDebtor = new Map<number, RefundRecipientSummary>();
    for (const allocation of allocations) {
      const existing = spentByDebtor.get(allocation.bowlerId);
      const week = allocationLabel(allocation);
      if (existing) {
        existing.amountMinor += allocation.amountMinor;
        if (!existing.coveredWeeks.includes(week)) existing.coveredWeeks.push(week);
      } else {
        spentByDebtor.set(allocation.bowlerId, {
          bowlerId: allocation.bowlerId,
          name: allocation.bowlerName?.trim() ?? "",
          amountMinor: allocation.amountMinor,
          coveredWeeks: [week],
          currency: allocation.currency,
          effect: "allocation",
        });
      }
    }
    summaries.push(...spentByDebtor.values());
    const unusedByOwner = new Map<number, RefundRecipientSummary>();
    for (const portion of portions) {
      if (portion.availableMinor === 0) continue;
      const bowlerId = portion.creditedBowlerId as number;
      const existing = unusedByOwner.get(bowlerId);
      if (existing) existing.amountMinor += portion.availableMinor;
      else unusedByOwner.set(bowlerId, {
        bowlerId,
        name: portion.creditedBowlerName?.trim() ?? "",
        amountMinor: portion.availableMinor,
        coveredWeeks: [],
        currency: refundEvidence.currency,
        effect: "unused_credit",
      });
    }
    summaries.push(...unusedByOwner.values());
    return { recipients: summaries, hasSpentAllocation: spentByDebtor.size > 0 };
  }

  if (refundEvidence.allocations.length === 0) return null;
  const allocations = refundEvidence.allocations as RefundAllocation[];
  // Preserve the established allocation-only path for older receipts.
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
        effect: "allocation",
      });
    }
  }
  return { recipients: [...summaries.values()], hasSpentAllocation: true };
}

export function RefundPaymentDialog({ payment, refundEvidence, onClose, onConfirm, isPending }: Props) {
  const [reason, setReason] = useState("");
  const [disposition, setDisposition] = useState<"still_owed" | "waived" | null>(null);
  const refundSummary = buildRefundSummary(payment, refundEvidence);
  const allocationEvidenceUnavailable = payment !== null && refundSummary === null;
  const showDebtDisposition = refundSummary === null || refundSummary.hasSpentAllocation;

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
        ) : payment && refundSummary ? (
          <section className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3" aria-label="Whole payment refund allocation">
            <p className="text-sm font-medium">This refunds the entire payment for everyone listed below.</p>
            <div className="divide-y rounded-md border bg-background">
              {refundSummary.recipients.map((recipient) => (
                <div key={`${recipient.effect}-${recipient.bowlerId}`} className="px-3 py-2 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium">{recipient.name}</span>
                    <span className="font-medium">{(recipient.amountMinor / 100).toLocaleString("en-US", { style: "currency", currency: recipient.currency })}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {recipient.effect === "unused_credit" ? "Unused credit returned" : "Applied to roster amount"}
                    {recipient.coveredWeeks.length > 0 ? ` · ${recipient.coveredWeeks.join(" · ")}` : ""}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}
        <div className="py-2">
          {showDebtDisposition && <fieldset className="space-y-2">
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
          </fieldset>}
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
            onClick={() => {
              if (payment && refundSummary && (!refundSummary.hasSpentAllocation || disposition !== null)) {
                onConfirm(payment.id, reason || undefined, disposition ?? "still_owed");
              }
            }}
            disabled={isPending || allocationEvidenceUnavailable || (refundSummary?.hasSpentAllocation === true && disposition === null)}
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
