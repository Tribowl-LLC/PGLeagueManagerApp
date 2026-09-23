import { createHash } from "node:crypto";

export const CANONICAL_PAYMENT_REPORT_CONTRACT = "canonical-payment-report/2" as const;
export const CANONICAL_PAYMENT_REPORT_ORDER = "league,business-date,bowler,occurrence,allocation,payment/2" as const;
export const CANONICAL_PAYMENT_REPORT_FINGERPRINT_PREFIX = "lvpaymentreport:v2:" as const;

export type CanonicalPaymentReportMode = "canonical";

export type CanonicalPaymentEvidenceStatus =
  | "confirmed_paid"
  | "refunded"
  | "disputed"
  | "review_required"
  | "unresolved"
  | "pending"
  | "failed";

export interface CanonicalPaymentReceiptSummary {
  contractVersion: "payment-receipt/1";
  availability: "available" | "unavailable";
  /** Whether this viewer may open or lazily fetch the provider receipt. */
  canOpenReceipt?: boolean;
  receiptUrl: string | null;
  receiptNumber: string | null;
  deliveryEvidence: "delivery_not_recorded";
  source?: "canonical_allocation" | "prepaid_credit" | "held_credit" | "refunded_credit" | "unresolved_operation" | null;
  refund?: CanonicalPaymentRefundEvidence;
  dispute?: CanonicalPaymentDisputeEvidence;
  paymentTiming?: CanonicalPaymentTiming;
  collectionEvidence?: CanonicalCollectionEvidence;
}

export interface CanonicalPaymentTiming {
  paymentMode: "weekly" | "upfront";
  upfrontDueAt: string | null;
  /** Date-only rendering in the league timezone; the instant above remains the audit value. */
  upfrontDueAtLocal?: string | null;
  timezone?: string;
  source: "canonical";
}

export interface CanonicalCollectionEvidence {
  d2PlanId: string;
  planVersion: number;
  collectionPointOccurrenceId: string;
  coveredOccurrenceIds: string[];
  timing: "at_collection_point";
  grouping: "normal" | "double_pay";
}

export interface CanonicalPaymentRefundEvidence {
  present: boolean;
  amountMinor: number;
  providerRefundId: string | null;
}

/** Credit lots can be refunded in multiple sequential partial provider or
 * manual tenders. Keep the aggregate and unresolved hold explicit instead
 * of projecting a misleading single refund ID. */
export interface CanonicalCreditRefundSummary {
  completedAmountMinor: number;
  heldAmountMinor: number;
  reviewRequired: boolean;
  providerRefundIds: string[];
}

export interface CanonicalPaymentDisputeEvidence {
  present: boolean;
  amountMinor: number;
  disputeId: string | null;
  /** Durable disputes are transaction-scoped; child rows carry presence only. */
  scope?: "transaction" | "allocation";
  state?: string | null;
  reviewRequired?: boolean;
}

export interface CanonicalPaymentAllocationRow {
  allocationId: string | null;
  obligationId: string | null;
  occurrenceId: string | null;
  /** League-local calendar date for operator-facing allocation details. */
  occurrenceLocalDate?: string | null;
  /** Stored canonical schedule position; never derive this from dates. */
  plannedOrdinal?: number | null;
  bowlerId: number;
  /** Safe tenant-scoped display name; only payer/admin projections expose it. */
  bowlerName?: string | null;
  amountMinor: number;
  /** Original allocation remains immutable; these fields describe its refund effect. */
  refundedMinor?: number;
  effectiveAmountMinor?: number;
  refundDisposition?: "still_owed" | "waived" | null;
  currency: string;
  state: "active" | "voided" | "reversed" | null;
}

/**
 * Ordinary readers receive this allowlisted projection instead of canonical
 * allocation rows. It intentionally contains no child, occurrence, or
 * bowler identifiers.
 */
export interface CanonicalPaymentAppliedToRow {
  plannedOrdinal: number | null;
  occurrenceLocalDate: string | null;
  amountMinor: number;
  /** Present only when the viewer is the initiating payer. */
  bowlerName?: string | null;
  refundedMinor?: number;
  effectiveAmountMinor?: number;
  refundDisposition?: "still_owed" | "waived" | null;
  currency: string;
  state: "active" | "voided" | "reversed" | null;
}

export interface CanonicalPaymentRow {
  paymentId: number | null;
  leagueId: number;
  bowlerId: number;
  amountMinor: number;
  currency: string;
  status: CanonicalPaymentEvidenceStatus;
  paymentType: "cash" | "check" | "credit_card" | "square";
  businessDate: string;
  authoritativeLocalDate: string;
  providerPaymentId: string | null;
  paymentOperationId: string | null;
  operationType: "interactive_charge" | "refund" | "standing_autopay_charge" | null;
  operationStatus: string | null;
  allocatedMinor: number;
  /** Gross active allocation evidence, retained for tender conservation. */
  grossAllocatedMinor?: number;
  refundedAllocationMinor?: number;
  waivedMinor?: number;
  effectiveAllocatedMinor?: number;
  unallocatedMinor: number;
  reviewRequired: boolean;
  source: "canonical_allocation" | "prepaid_credit" | "held_credit" | "refunded_credit" | "unresolved_operation";
  paymentTiming?: CanonicalPaymentTiming;
  refund: CanonicalPaymentRefundEvidence;
  creditRefunds?: CanonicalCreditRefundSummary;
  dispute: CanonicalPaymentDisputeEvidence;
  unresolved: boolean;
  receipt: CanonicalPaymentReceiptSummary;
  sharedTransaction?: { groupKey: string | null; childCount: number } | null;
  allocations: CanonicalPaymentAllocationRow[];
  /** Safe ordinary-reader summary of the owned canonical applications. */
  appliedTo?: CanonicalPaymentAppliedToRow[];
  correctionEvidence?: { status: "voided"; voidId: string };
  collectionEvidence?: CanonicalCollectionEvidence;
  /** Internal role projection hint; ordinary responses remove it. */
  initiatingPayerBowlerId?: number | null;
  /** Safe display-only actor name; never includes email or provider identity. */
  paidByName?: string | null;
}

/** Selects an F5 source label from the current rotating-credit disposition. */
export function canonicalCreditFundingSource(input: {
  amountMinor: number;
  allocatedMinor: number;
  completedRefundMinor: number;
  heldRefundMinor: number;
}): CanonicalPaymentRow["source"] {
  if (input.allocatedMinor > 0) return "canonical_allocation";
  const remainingMinor = input.amountMinor - input.allocatedMinor - input.completedRefundMinor - input.heldRefundMinor;
  if (remainingMinor > 0) return "prepaid_credit";
  if (input.heldRefundMinor > 0) return "held_credit";
  if (input.completedRefundMinor === input.amountMinor) return "refunded_credit";
  return "canonical_allocation";
}

export interface CanonicalPaymentTransactionGroup {
  groupKey: string;
  paymentOperationId: string | null;
  amountMinor: number;
  currency: string;
  paymentIds: number[];
  dispute?: { present: boolean; amountMinor: number; disputeId: string | null; currency: string; state: string; reviewRequired: boolean; scope: "transaction" };
  rows: CanonicalPaymentRow[];
  collectionEvidence?: CanonicalCollectionEvidence;
}

export interface CanonicalPaymentReportTotals {
  grossConfirmedPaidMinor: number;
  activeAllocatedMinor: number;
  refundedMinor: number;
  disputedReviewRequiredMinor: number;
  reviewRequiredMinor: number;
  unresolvedOperationMinor: number;
  /** Additive refund-effect projections; activeAllocatedMinor remains gross evidence. */
  refundedAllocationMinor?: number;
  waivedMinor?: number;
  effectiveAllocatedMinor?: number;
}

export interface CanonicalPaymentReport {
  contractVersion: typeof CANONICAL_PAYMENT_REPORT_CONTRACT;
  orderVersion: typeof CANONICAL_PAYMENT_REPORT_ORDER;
  organizationId: number;
  leagueId: number;
  mode: CanonicalPaymentReportMode;
  authoritativeSource: "canonical";
  asOf: string;
  fingerprint: string;
  page: number;
  limit: number;
  totalRows: number;
  totalTransactions: number;
  totals: CanonicalPaymentReportTotals;
  rows: CanonicalPaymentRow[];
  transactions: CanonicalPaymentTransactionGroup[];
  paymentTiming: CanonicalPaymentTiming;
}

export function canonicalPaymentReportFingerprint(value: Omit<CanonicalPaymentReport, "fingerprint">): string {
  const { asOf: _generatedAsOf, ...semanticEvidence } = value;
  return `${CANONICAL_PAYMENT_REPORT_FINGERPRINT_PREFIX}${createHash("sha256").update(stableJson(semanticEvidence)).digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}
