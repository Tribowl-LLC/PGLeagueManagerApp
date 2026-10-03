import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Check } from "lucide-react";
import {
  Dialog,
  DialogContent,
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
  organizationId?: number | null;
  startInEdit?: boolean;
  variant?: "admin" | "bowler";
  leagueName?: string;
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

export function paymentEvidenceBowlerDisplayStatus(evidence: CanonicalPaymentRow): string {
  const displayStatus = paymentEvidenceDisplayStatus(evidence);
  return evidence.source === "refunded_credit" && displayStatus === "Confirmed paid"
    ? "Refunded"
    : displayStatus;
}

function formatCurrency(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amountMinor / 100);
}

function formatBowlerCurrency(amountMinor: number, currency: string): string {
  const hasCents = Number.isSafeInteger(amountMinor) && Math.abs(amountMinor) % 100 !== 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(amountMinor / 100);
}

function formatLocalDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[2]}/${match[3]}/${match[1]}` : value;
}

function formatBowlerLocalDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(date);
}

function allocationLabel(allocation: CanonicalPaymentRow["allocations"][number] | NonNullable<CanonicalPaymentRow["appliedTo"]>[number]): string {
  if (allocation.plannedOrdinal !== null && allocation.plannedOrdinal !== undefined) return `Week ${allocation.plannedOrdinal}`;
  return allocation.occurrenceLocalDate ? formatLocalDate(allocation.occurrenceLocalDate) : "Applied week";
}

function bowlerAllocationPeriodLabel(allocation: CanonicalPaymentRow["allocations"][number] | NonNullable<CanonicalPaymentRow["appliedTo"]>[number]): string {
  if (Number.isSafeInteger(allocation.plannedOrdinal) && (allocation.plannedOrdinal as number) > 0) return `Week ${allocation.plannedOrdinal}`;
  if (allocation.occurrenceLocalDate) return formatLocalDate(allocation.occurrenceLocalDate);
  return "Period unavailable";
}

function paymentTypeLabel(paymentType: CanonicalPaymentRow["paymentType"], checkNumber?: string | null): string {
  switch (paymentType) {
    case "cash": return "Cash";
    case "check": return checkNumber ? `Check #${checkNumber}` : "Check";
    case "credit_card": return "Credit Card";
    case "square": return "Credit Card";
    default: return "Other Payment";
  }
}

async function correctionFingerprint(payload: Record<string, unknown>) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(payload)));
  return `lvcorrection:v3:${Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

async function cashEditFingerprint(payload: Record<string, unknown>) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(payload)));
  return `lvcashedit:v1:${Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

async function cashDeleteFingerprint(payload: Record<string, unknown>) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(payload)));
  return `lvcashdelete:v1:${Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function parseAmountMinor(value: string): number | null {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim())) return null;
  const [whole, fraction = ""] = value.trim().split(".");
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

function invalidateCashEditViews(leagueId: number, bowlerId: number): Promise<unknown[]> {
  const requests = [
    queryClient.invalidateQueries({ queryKey: ["/api/payments"] }),
    queryClient.invalidateQueries({ queryKey: ["/api/financials/f5/payments"] }),
    queryClient.invalidateQueries({ queryKey: ["manage-payments-snapshot", leagueId] }),
    queryClient.invalidateQueries({ queryKey: ["/api/financials/leagues", leagueId, "interactive-payment-participants/4"] }),
    queryClient.invalidateQueries({ queryKey: ["/api/financials/leagues", leagueId, "interactive-payment-quote/4"] }),
    queryClient.invalidateQueries({ queryKey: ["/api/financials/leagues", leagueId, "canonical-due-past-due/2"] }),
    queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/canonical-due-past-due/2`] }),
    queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/standing-autopay/1`] }),
    queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/standing-autopay/1/quote`] }),
    queryClient.invalidateQueries({ queryKey: ["/api/financials/leagues", leagueId, "canonical-due-past-due/2", bowlerId] }),
    queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/canonical-due-past-due/2`, bowlerId] }),
    queryClient.invalidateQueries({ queryKey: [`/api/bowlers/${bowlerId}/details`] }),
    queryClient.invalidateQueries({
      predicate: ({ queryKey }) => typeof queryKey[0] === "string" && queryKey[0].startsWith("/api/financials/due-past-due"),
    }),
  ];
  return Promise.all(requests);
}

export function PaymentDetailsDialog({ payment, evidence, canCorrect, organizationId, startInEdit = false, variant = "admin", leagueName, onClose }: Props) {
  const [editingCorrection, setEditingCorrection] = useState(false);
  const [editingMode, setEditingMode] = useState<"void_only" | "edit_cash" | null>(null);
  const [reason, setReason] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const [editPaymentDate, setEditPaymentDate] = useState("");
  const [editRequestKey, setEditRequestKey] = useState<string | null>(null);
  const [correctionBusy, setCorrectionBusy] = useState(false);
  const [correctionError, setCorrectionError] = useState<string | null>(null);
  const [deletingCash, setDeletingCash] = useState(false);
  const [deleteReason, setDeleteReason] = useState("");
  const [deleteRequestKey, setDeleteRequestKey] = useState<string | null>(null);
  const [deleteSubmissionStarted, setDeleteSubmissionStarted] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [receiptLoading, setReceiptLoading] = useState(false);
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const initialEditStarted = useRef(false);

  const isRotatingCreditFunding = evidence?.creditRefunds !== undefined
    || evidence?.source === "prepaid_credit"
    || evidence?.source === "held_credit"
    || evidence?.source === "refunded_credit";
  const concreteManualTenderEvidence = Boolean(
    canCorrect
      && payment
      && payment.id > 0
      && evidence
      && evidence.paymentId === payment.id
      && evidence.leagueId === payment.leagueId
      && evidence.bowlerId === payment.bowlerId
      && (payment.type === "cash" || payment.type === "check")
      && evidence.paymentType === payment.type
      && !isRotatingCreditFunding
      && evidence.source === "canonical_allocation"
      && !evidence.unresolved
      && !evidence.reviewRequired
      && evidence.providerPaymentId === null
      && evidence.paymentOperationId === null
      && evidence.operationType === null
      && evidence.operationStatus === null
      && !evidence.refund.present
      && evidence.refund.amountMinor === 0
      && evidence.refund.providerRefundId === null
      && (!evidence.creditRefunds || (evidence.creditRefunds.completedAmountMinor === 0
        && evidence.creditRefunds.heldAmountMinor === 0
        && !evidence.creditRefunds.reviewRequired
        && evidence.creditRefunds.providerRefundIds.length === 0))
      && !evidence.dispute.present
      && evidence.dispute.amountMinor === 0
      && evidence.dispute.disputeId === null
      && !evidence.dispute.reviewRequired
      && payment.providerPaymentId === null
      // The payment list sanitizer omits this internal operation ID. Canonical evidence must still prove it is null.
      && payment.paymentOperationId == null
      && payment.refundedAt === null
      && payment.squareRefundId === null
      && payment.refundReason === null
      && payment.disputeId === null
      && payment.disputedAt === null
      && evidence.allocations.length > 0,
  );
  const concreteManualCashEvidence = concreteManualTenderEvidence
    && payment?.type === "cash"
    && evidence?.paymentType === "cash";
  const cashFundingIds = new Set<string>();
  const cashOwnerPortionIndexes = new Set<string>();
  const cashFundingPortionIdentitiesAreUnique = evidence?.fundingPortions?.every((portion) => {
    if (typeof portion.fundingId !== "string" || portion.fundingId.length === 0
      || !Number.isSafeInteger(portion.creditedBowlerId) || (portion.creditedBowlerId ?? 0) <= 0
      || !Number.isSafeInteger(portion.portionIndex) || (portion.portionIndex ?? -1) < 0) return false;
    const ownerPortionKey = `${portion.creditedBowlerId}:${portion.portionIndex}`;
    if (cashFundingIds.has(portion.fundingId) || cashOwnerPortionIndexes.has(ownerPortionKey)) return false;
    cashFundingIds.add(portion.fundingId);
    cashOwnerPortionIndexes.add(ownerPortionKey);
    return true;
  }) === true;
  const ownedUnusedManualCashEditEvidence = Boolean(
    canCorrect
      && payment
      && payment.id > 0
      && evidence
      && evidence.paymentId === payment.id
      && evidence.leagueId === payment.leagueId
      && evidence.bowlerId === payment.bowlerId
      && payment.type === "cash"
      && evidence.paymentType === "cash"
      && evidence.status === "confirmed_paid"
      && payment.status === "paid"
      && evidence.source === "prepaid_credit"
      && evidence.fundingPortions !== undefined
      && evidence.fundingPortions.length > 0
      && cashFundingPortionIdentitiesAreUnique
      && evidence.fundingPortions.every((portion) => Number.isSafeInteger(portion.amountMinor)
        && portion.amountMinor > 0
        && typeof portion.fundingId === "string"
        && portion.fundingId.length > 0
        && Number.isSafeInteger(portion.portionIndex)
        && (portion.portionIndex ?? -1) >= 0
        && Number.isSafeInteger(portion.creditedBowlerId)
        && (portion.creditedBowlerId ?? 0) > 0
        && Number.isSafeInteger(portion.availableMinor)
        && portion.availableMinor === portion.amountMinor
        && portion.appliedMinor === 0
        && portion.refundedCreditMinor === 0
        && portion.totalRefundedMinor === 0
        && portion.heldCreditMinor === 0
        && !portion.reviewRequired)
      && evidence.fundingPortions.reduce((sum, portion) => sum + portion.amountMinor, 0) === evidence.amountMinor
      && evidence.amountMinor === payment.amount
      && evidence.allocatedMinor === 0
      && evidence.unallocatedMinor === payment.amount
      && evidence.allocations.length === 0
      && (evidence.appliedTo?.length ?? 0) === 0
      && !evidence.unresolved
      && !evidence.reviewRequired
      && evidence.providerPaymentId === null
      && evidence.paymentOperationId === null
      && evidence.operationType === null
      && evidence.operationStatus === null
      && !evidence.refund.present
      && !evidence.dispute.present
      && payment.providerPaymentId === null
      // The payment list sanitizer omits this internal operation ID. Canonical evidence must still prove it is null.
      && payment.paymentOperationId == null
      && payment.refundedAt === null
      && payment.squareRefundId === null
      && payment.refundReason === null
      && payment.disputeId === null
      && payment.disputedAt === null,
  );
  const canEditCash = Boolean(
    (concreteManualCashEvidence
      && payment?.status === "paid"
      && evidence?.status === "confirmed_paid"
      && evidence?.allocations.every((allocation) => allocation.state === "active"))
      || ownedUnusedManualCashEditEvidence,
  );

  useEffect(() => {
    if (!startInEdit) {
      initialEditStarted.current = false;
      return;
    }
    if (initialEditStarted.current || !canEditCash || !evidence || evidence.paymentId === null || editingMode !== null) return;
    initialEditStarted.current = true;
    setEditingMode("edit_cash");
    setEditingCorrection(true);
    setEditAmount((evidence.amountMinor / 100).toFixed(2));
    setEditPaymentDate(evidence.authoritativeLocalDate);
    setEditRequestKey(crypto.randomUUID());
  }, [canEditCash, editingMode, evidence, startInEdit]);

  if (!evidence) return null;

  const canVoid = Boolean(concreteManualTenderEvidence
    && payment?.status === "paid"
    && evidence?.status === "confirmed_paid"
    && evidence?.allocations.every((allocation) => allocation.state === "active"));
  const canDeleteCash = Boolean(concreteManualCashEvidence && payment && evidence && (
    (payment.status === "paid"
      && evidence.status === "confirmed_paid"
      && evidence.correctionEvidence === undefined
      && evidence.allocations.every((allocation) => allocation.state === "active"))
    || (payment.status === "voided"
      && evidence.correctionEvidence?.status === "voided"
      && evidence.allocations.every((allocation) => allocation.state === "voided"))
  ));
  const displayStatus = paymentEvidenceDisplayStatus(evidence);
  const unusedShareCredit = evidence.source === "prepaid_credit";
  const heldShareCredit = evidence.source === "held_credit";
  const refundedShareCredit = evidence.source === "refunded_credit";
  // The server marks ordinary-reader partner rows with canOpenReceipt=false.
  // Do not infer permission from cached URL availability: payer/admin rows may
  // legitimately lazy-backfill a receipt when the URL is not cached yet.
  const canOpenReceipt = evidence.paymentId !== null
    && ["confirmed_paid", "refunded", "disputed"].includes(evidence.status)
    && evidence.receipt.canOpenReceipt !== false;
  const appliedAllocations = evidence.allocations.length > 0
    ? evidence.allocations
    : (evidence.appliedTo ?? []);
  const hasRecipientNames = appliedAllocations.some((allocation) => Boolean(allocation.bowlerName?.trim()));
  const showAdditionalSettlementEvidence = (evidence.unallocatedMinor > 0 && !unusedShareCredit)
    || evidence.refund.present
    || (evidence.waivedMinor ?? 0) > 0
    || evidence.dispute.present
    || evidence.reviewRequired
    || evidence.dispute.reviewRequired === true
    || Boolean(evidence.correctionEvidence);
  const bowlerDisplayStatus = paymentEvidenceBowlerDisplayStatus(evidence);
  const bowlerConfirmed = bowlerDisplayStatus === "Confirmed paid"
    && !evidence.reviewRequired
    && evidence.dispute.reviewRequired !== true;
  const bowlerHeroStatus = bowlerConfirmed
    ? "Payment confirmed"
    : (evidence.reviewRequired || evidence.dispute.reviewRequired === true ? "Review required" : bowlerDisplayStatus);
  const showBowlerAppliedSection = evidence.hasMultipleRecipients === true;

  const openReceipt = async () => {
    if (evidence.paymentId === null) return;
    setReceiptLoading(true);
    setReceiptError(null);
    try {
      const response = await csrfFetch(`/api/payments-provider/payments/${evidence.paymentId}/receipt`);
      const body = await response.json() as { data?: { receiptUrl?: string | null }; error?: { message?: string } };
      if (!response.ok || !body.data?.receiptUrl) throw new Error(body.error?.message || "Receipt is unavailable");
      window.open(body.data.receiptUrl, "_blank", "noopener,noreferrer");
    } catch (error) {
      setReceiptError(error instanceof Error ? error.message : "Receipt is unavailable");
    } finally {
      setReceiptLoading(false);
    }
  };

  const beginCashEdit = () => {
    if (!canEditCash || !evidence) return;
    setEditingMode("edit_cash");
    setEditingCorrection(true);
    setReason("");
    setEditAmount((evidence.amountMinor / 100).toFixed(2));
    setEditPaymentDate(evidence.authoritativeLocalDate);
    setEditRequestKey(crypto.randomUUID());
    setCorrectionError(null);
  };

  const beginCashDelete = () => {
    if (!canDeleteCash) return;
    setDeletingCash(true);
    setDeleteReason("");
    setDeleteRequestKey(crypto.randomUUID());
    setDeleteSubmissionStarted(false);
    setDeleteError(null);
  };

  const cancelCashDelete = () => {
    if (deleteBusy) return;
    setDeletingCash(false);
    setDeleteReason("");
    setDeleteRequestKey(null);
    setDeleteSubmissionStarted(false);
    setDeleteError(null);
  };

  const submitCashDelete = async () => {
    const trimmedReason = deleteReason.trim();
    if (!canDeleteCash || !evidence || evidence.paymentId === null || !deleteRequestKey || !trimmedReason) return;
    const fingerprintPayload = { paymentId: evidence.paymentId, reason: trimmedReason };
    setDeleteSubmissionStarted(true);
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const response = await csrfFetch(`/api/financials/leagues/${evidence.leagueId}/canonical/cash-payment-deletions/1`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": deleteRequestKey },
        body: JSON.stringify({
          ...fingerprintPayload,
          idempotencyKey: deleteRequestKey,
          requestFingerprint: await cashDeleteFingerprint(fingerprintPayload),
        }),
      });
      const body = await response.json().catch(() => ({})) as { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message || "Cash payment could not be permanently deleted");
      await invalidateCashEditViews(evidence.leagueId, evidence.bowlerId);
      onClose();
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Cash payment could not be permanently deleted");
    } finally {
      setDeleteBusy(false);
    }
  };

  const submitCorrection = async () => {
    if (editingMode === "edit_cash") {
      if (evidence.paymentId === null || !editRequestKey) return;
      const amountMinor = parseAmountMinor(editAmount);
      if (amountMinor === null || !/^\d{4}-\d{2}-\d{2}$/.test(editPaymentDate)) {
        setCorrectionError("Enter a valid amount with up to two decimal places and a payment date.");
        return;
      }
      const trimmedReason = `Cash payment edited from $${(evidence.amountMinor / 100).toFixed(2)} on ${evidence.authoritativeLocalDate}`;
      setCorrectionBusy(true);
      setCorrectionError(null);
      try {
        const fingerprintPayload = {
          paymentId: evidence.paymentId,
          correctionMode: "edit_cash" as const,
          amountMinor,
          paymentDate: editPaymentDate,
          reason: trimmedReason,
        };
        const response = await csrfFetch(`/api/financials/leagues/${evidence.leagueId}/canonical/corrections/1`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": editRequestKey },
          body: JSON.stringify({
            ...fingerprintPayload,
            idempotencyKey: editRequestKey,
            requestFingerprint: await cashEditFingerprint(fingerprintPayload),
          }),
        });
        const body = await response.json().catch(() => ({})) as { error?: { message?: string } };
        if (!response.ok) throw new Error(body.error?.message || "Cash payment could not be edited");
        await invalidateCashEditViews(evidence.leagueId, evidence.bowlerId);
        onClose();
      } catch (error) {
        setCorrectionError(error instanceof Error ? error.message : "Cash payment could not be edited");
      } finally {
        setCorrectionBusy(false);
      }
      return;
    }

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
      await invalidateCashEditViews(evidence.leagueId, evidence.bowlerId);
      onClose();
    } catch (error) {
      setCorrectionError(error instanceof Error ? error.message : "Payment correction could not be recorded");
    } finally {
      setCorrectionBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !correctionBusy && !deleteBusy) onClose(); }}>
      <DialogContent aria-describedby={undefined} viewport="dialog" className="overflow-y-auto sm:max-w-lg" variant={variant === "bowler" ? "bowlerReceipt" : undefined}>
        {variant === "bowler" ? (
          <>
            <DialogHeader data-payment-details-part="header">
              <DialogTitle>Payment details</DialogTitle>
            </DialogHeader>

            <div data-payment-details-part="hero" data-payment-details-status={bowlerConfirmed ? "confirmed" : "exception"} aria-label={`${bowlerHeroStatus}, ${formatBowlerCurrency(evidence.amountMinor, evidence.currency)}`}>
              {bowlerConfirmed && <span data-payment-details-part="hero-icon" aria-hidden="true"><Check size={24} /></span>}
              <strong>{formatBowlerCurrency(evidence.amountMinor, evidence.currency)}</strong>
              <span>{bowlerHeroStatus}</span>
              {unusedShareCredit && <small>Unused share credit</small>}
              {heldShareCredit && <small>Share credit refund on hold</small>}
              {refundedShareCredit && <small>Refunded share credit</small>}
            </div>

            <dl data-payment-details-part="details">
              {leagueName && <div><dt>League</dt><dd>{leagueName}</dd></div>}
              <div><dt>Date</dt><dd>{formatBowlerLocalDate(evidence.authoritativeLocalDate)}</dd></div>
              {evidence.paidByName && <div><dt>Paid by</dt><dd>{evidence.paidByName}</dd></div>}
              <div><dt>Method</dt><dd>{paymentTypeLabel(evidence.paymentType, payment?.checkNumber)}</dd></div>
            </dl>

            {showBowlerAppliedSection && <section data-payment-details-part="applied" aria-labelledby="bowler-payment-applied-heading">
              <h3 id="bowler-payment-applied-heading">Applied to each bowler</h3>
              {appliedAllocations.length === 0 ? (
                <p className="text-sm text-muted-foreground">{unusedShareCredit
                  ? "No confirmed league date has received credit from this amount."
                  : heldShareCredit
                    ? "A share credit refund is unresolved. The remaining credit stays held until its outcome is confirmed."
                    : refundedShareCredit
                      ? "This share credit was refunded in full before it was applied to a league date."
                      : "No canonical allocation is recorded."}</p>
              ) : (
                <div data-payment-details-part="applied-list">
                  {appliedAllocations.map((allocation, index) => (
                    <div key={`${allocation.plannedOrdinal ?? "un-numbered"}-${allocation.occurrenceLocalDate ?? "undated"}-${index}`}>
                      <span>
                        {allocation.bowlerName && <strong>{allocation.bowlerName}</strong>}
                        <span>{bowlerAllocationPeriodLabel(allocation)}</span>
                        {allocation.plannedOrdinal !== null && allocation.plannedOrdinal !== undefined && allocation.occurrenceLocalDate && <small>{formatBowlerLocalDate(allocation.occurrenceLocalDate)}</small>}
                        {allocation.state !== "active" && <small>{allocation.state ?? "unresolved"}</small>}
                        {(allocation.refundedMinor ?? 0) > 0 && <small>Refunded: {formatCurrency(allocation.refundedMinor ?? 0, allocation.currency)}</small>}
                        {allocation.refundDisposition && <small>Refund disposition: {allocation.refundDisposition.replaceAll("_", " ")}</small>}
                      </span>
                      <strong>{formatBowlerCurrency(allocation.amountMinor, allocation.currency)}</strong>
                    </div>
                  ))}
                </div>
              )}
            </section>}

            {showAdditionalSettlementEvidence && (
              <section data-payment-details-part="evidence" aria-label="Additional settlement evidence">
                {evidence.unallocatedMinor > 0 && !unusedShareCredit && !refundedShareCredit && <p>Unallocated: {formatCurrency(evidence.unallocatedMinor, evidence.currency)}</p>}
                {evidence.refund.present && <p>Refunded: {formatCurrency(evidence.refund.amountMinor, evidence.currency)}</p>}
                {(evidence.creditRefunds?.heldAmountMinor ?? 0) > 0 && <p>Refund on hold: {formatCurrency(evidence.creditRefunds?.heldAmountMinor ?? 0, evidence.currency)}</p>}
                {(evidence.waivedMinor ?? 0) > 0 && <p>Waived roster amount: {formatCurrency(evidence.waivedMinor ?? 0, evidence.currency)} (not counted as paid)</p>}
                {evidence.dispute.present && <p>Dispute: {evidence.dispute.state ?? "Review required"}{evidence.dispute.amountMinor > 0 ? ` · ${formatCurrency(evidence.dispute.amountMinor, evidence.currency)}` : ""}</p>}
                {(evidence.reviewRequired || evidence.dispute.reviewRequired === true) && <p className="font-medium text-destructive">This payment requires review.</p>}
                {evidence.correctionEvidence?.status === "voided" && <p>Correction: Payment voided.</p>}
              </section>
            )}

            {evidence.collectionEvidence && (
              <section data-payment-details-part="evidence" aria-label="Collection evidence">
                <h3>Collection evidence</h3>
                <p>{evidence.collectionEvidence.grouping === "double_pay" ? "Double payment" : "Regular collection"} at the collection point.</p>
                <p>Timing: {evidence.collectionEvidence.timing.replaceAll("_", " ")}</p>
              </section>
            )}

            {(evidence.operationType || evidence.operationStatus) && (
              <section data-payment-details-part="evidence" aria-label="Payment operation evidence">
                <h3>Payment operation</h3>
                {evidence.operationType && <p>Type: {evidence.operationType.replaceAll("_", " ")}</p>}
                {evidence.operationStatus && <p>Outcome: {evidence.operationStatus.replaceAll("_", " ")}</p>}
              </section>
            )}

            {receiptError && <p role="alert" className="text-sm text-destructive">{receiptError}</p>}

            {canOpenReceipt && <DialogFooter data-payment-details-part="footer">
              <Button disabled={receiptLoading} onClick={() => void openReceipt()}>{receiptLoading ? "Loading receipt…" : "Receipt"}</Button>
            </DialogFooter>}
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Payment Details</DialogTitle>
            </DialogHeader>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <div><dt className="text-muted-foreground">Collected</dt><dd>{formatLocalDate(evidence.authoritativeLocalDate)}</dd></div>
          <div><dt className="text-muted-foreground">{hasRecipientNames ? "Payment total" : "Paid for"}</dt><dd>{formatCurrency(evidence.amountMinor, evidence.currency)}</dd></div>
          <div><dt className="text-muted-foreground">Payment type</dt><dd>{paymentTypeLabel(evidence.paymentType, payment?.checkNumber)}</dd></div>
          {unusedShareCredit && <div><dt className="text-muted-foreground">Credit application</dt><dd>Unused share credit</dd></div>}
          {heldShareCredit && <div><dt className="text-muted-foreground">Credit status</dt><dd>Refund on hold</dd></div>}
          {refundedShareCredit && <div><dt className="text-muted-foreground">Credit application</dt><dd>Refunded share credit</dd></div>}
          {evidence.paidByName && <div><dt className="text-muted-foreground">Paid by</dt><dd>{evidence.paidByName}</dd></div>}
          <div>
            <dt className="text-muted-foreground">Settlement</dt>
            <dd className="flex flex-wrap gap-1">
              <Badge variant="outline">{displayStatus}</Badge>
              {evidence.correctionEvidence?.status === "voided" && <Badge variant="secondary">Voided</Badge>}
            </dd>
          </div>
        </dl>

        <section className="space-y-2" aria-labelledby="payment-allocation-heading">
          <h3 id="payment-allocation-heading" className="font-medium">{hasRecipientNames ? "Payment breakdown" : "Paid for"}</h3>
          {appliedAllocations.length === 0 ? (
            <p className="text-sm text-muted-foreground">{unusedShareCredit
              ? "No confirmed league date has received credit from this amount."
              : heldShareCredit
                ? "A share credit refund is unresolved. The remaining credit stays held until its outcome is confirmed."
                : refundedShareCredit
                  ? "This share credit was refunded in full before it was applied to a league date."
                  : "No canonical allocation is recorded."}</p>
          ) : (
            <div className="divide-y rounded-md border">
              {appliedAllocations.map((allocation, index) => (
                <div key={`${allocation.plannedOrdinal ?? "un-numbered"}-${allocation.occurrenceLocalDate ?? "undated"}-${index}`} className="flex items-center justify-between gap-4 px-3 py-2 text-sm">
                  <div>
                    {allocation.bowlerName && <div className="font-medium">{allocation.bowlerName}</div>}
                    <div>{allocationLabel(allocation)}</div>
                    {allocation.plannedOrdinal !== null && allocation.plannedOrdinal !== undefined && allocation.occurrenceLocalDate && <div className="text-xs text-muted-foreground">{formatLocalDate(allocation.occurrenceLocalDate)}</div>}
                    {allocation.state !== "active" && <div className="text-xs capitalize text-muted-foreground">{allocation.state ?? "unresolved"}</div>}
                    {(allocation.refundedMinor ?? 0) > 0 && <div className="text-xs text-muted-foreground">Refunded: {formatCurrency(allocation.refundedMinor ?? 0, allocation.currency)}</div>}
                    {allocation.effectiveAmountMinor !== undefined && <div className="text-xs text-muted-foreground">Effective: {formatCurrency(allocation.effectiveAmountMinor, allocation.currency)}</div>}
                    {allocation.refundDisposition && <div className="text-xs capitalize text-muted-foreground">Refund disposition: {allocation.refundDisposition.replaceAll("_", " ")}</div>}
                  </div>
                  <span className="font-medium">{formatCurrency(allocation.amountMinor, allocation.currency)}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        {showAdditionalSettlementEvidence && (
          <section className="space-y-1 rounded-md border bg-muted/30 p-3 text-sm" aria-label="Additional settlement evidence">
            {evidence.unallocatedMinor > 0 && !unusedShareCredit && !refundedShareCredit && <p>Unallocated: {formatCurrency(evidence.unallocatedMinor, evidence.currency)}</p>}
            {evidence.refund.present && <p>Refunded: {formatCurrency(evidence.refund.amountMinor, evidence.currency)}</p>}
            {(evidence.creditRefunds?.heldAmountMinor ?? 0) > 0 && <p>Refund on hold: {formatCurrency(evidence.creditRefunds?.heldAmountMinor ?? 0, evidence.currency)}</p>}
            {(evidence.waivedMinor ?? 0) > 0 && <p>Waived roster amount: {formatCurrency(evidence.waivedMinor ?? 0, evidence.currency)} (not counted as paid)</p>}
            {evidence.dispute.present && <p>Dispute: {evidence.dispute.state ?? "Review required"}{evidence.dispute.amountMinor > 0 ? ` · ${formatCurrency(evidence.dispute.amountMinor, evidence.currency)}` : ""}</p>}
            {(evidence.reviewRequired || evidence.dispute.reviewRequired === true) && <p className="font-medium text-destructive">This payment requires review.</p>}
            {evidence.correctionEvidence?.status === "voided" && <p>Correction: Payment voided.</p>}
          </section>
        )}

        {evidence.collectionEvidence && (
          <section className="space-y-1 rounded-md border p-3 text-sm" aria-label="Collection evidence">
            <h3 className="font-medium">Collection evidence</h3>
            <p>{evidence.collectionEvidence.grouping === "double_pay" ? "Double payment" : "Regular collection"} at the collection point.</p>
            <p className="text-muted-foreground">Timing: {evidence.collectionEvidence.timing.replaceAll("_", " ")}</p>
            <p className="break-all text-muted-foreground">Collection point: {evidence.collectionEvidence.collectionPointOccurrenceId}</p>
            <p className="break-all text-muted-foreground">Covered occurrences: {evidence.collectionEvidence.coveredOccurrenceIds.join(", ")}</p>
          </section>
        )}

        {(evidence.operationType || evidence.operationStatus) && (
          <section className="space-y-1 rounded-md border p-3 text-sm" aria-label="Payment operation evidence">
            <h3 className="font-medium">Payment operation</h3>
            {evidence.operationType && <p>Type: {evidence.operationType.replaceAll("_", " ")}</p>}
            {evidence.operationStatus && <p className="text-muted-foreground">Outcome: {evidence.operationStatus.replaceAll("_", " ")}</p>}
          </section>
        )}

        {(canEditCash || canVoid || canDeleteCash) && (
          <section className="space-y-2 border-t pt-4" aria-label="Payment correction">
            {editingCorrection && editingMode === "edit_cash" ? (
              <>
                <p className="text-sm text-muted-foreground">The edited payment will keep the payment details and use the new amount and date. The original payment is retained internally as voided evidence. Changing the amount reapplies it to the oldest eligible balances; changing only the date keeps its current allocations.</p>
                <label className="grid gap-1 text-sm">
                  Amount
                  <input aria-label="Payment amount" inputMode="decimal" className="rounded-md border bg-background px-3 py-2" value={editAmount} onChange={(event) => setEditAmount(event.target.value)} disabled={correctionBusy} />
                </label>
                <label className="grid gap-1 text-sm">
                  Payment date
                  <input aria-label="Payment date" type="date" className="rounded-md border bg-background px-3 py-2" value={editPaymentDate} onChange={(event) => setEditPaymentDate(event.target.value)} disabled={correctionBusy} />
                </label>
                {correctionError && <p role="alert" className="text-sm text-destructive">{correctionError}</p>}
                <div className="flex gap-2">
                  <Button variant="default" size="sm" disabled={correctionBusy || parseAmountMinor(editAmount) === null || !editPaymentDate} onClick={() => void submitCorrection()}>{correctionBusy ? "Saving…" : "Save payment edit"}</Button>
                  <Button variant="outline" size="sm" disabled={correctionBusy} onClick={() => { setEditingCorrection(false); setEditingMode(null); setEditRequestKey(null); setCorrectionError(null); }}>Cancel</Button>
                </div>
              </>
            ) : deletingCash ? (
              <div className="space-y-2" aria-label="Permanent cash payment deletion">
                <p className="text-sm font-medium text-destructive">Permanently delete this cash payment?</p>
                <p className="text-sm text-muted-foreground">This removes the payment, its allocations, and any void record. Affected balances will be recalculated. This action cannot be undone.</p>
                <label className="grid gap-1 text-sm">
                  Reason for permanent deletion
                  <input aria-label="Reason for permanent deletion" maxLength={500} required className="rounded-md border bg-background px-3 py-2" value={deleteReason} onChange={(event) => setDeleteReason(event.target.value)} disabled={deleteBusy || deleteSubmissionStarted} />
                </label>
                {deleteError && <p role="alert" className="text-sm text-destructive">{deleteError}</p>}
                <div className="flex flex-wrap gap-2">
                  <Button variant="destructive" size="sm" disabled={deleteBusy || !deleteReason.trim()} onClick={() => void submitCashDelete()}>{deleteBusy ? "Deleting…" : "Permanently delete cash payment"}</Button>
                  <Button variant="outline" size="sm" disabled={deleteBusy} onClick={cancelCashDelete}>Cancel</Button>
                </div>
              </div>
            ) : editingCorrection ? (
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
              <div className="flex flex-wrap gap-2">
                {canEditCash && <Button variant="outline" size="sm" onClick={beginCashEdit}>Edit cash payment</Button>}
                {canVoid && <Button variant="outline" size="sm" onClick={() => { setEditingMode("void_only"); setEditingCorrection(true); }}>{payment?.type === "check" ? "Void check payment" : "Void cash payment"}</Button>}
                {canDeleteCash && <Button variant="destructive" size="sm" onClick={beginCashDelete}>Delete cash payment</Button>}
              </div>
            )}
          </section>
        )}

        {receiptError && <p role="alert" className="text-sm text-destructive">{receiptError}</p>}

        {canOpenReceipt && <DialogFooter>
          <Button variant="outline" disabled={receiptLoading} onClick={() => void openReceipt()}>{receiptLoading ? "Loading receipt…" : "Receipt"}</Button>
        </DialogFooter>}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
