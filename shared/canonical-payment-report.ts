import { createHash } from "node:crypto";

export const CANONICAL_PAYMENT_REPORT_CONTRACT = "canonical-payment-report/1" as const;
export const CANONICAL_PAYMENT_REPORT_ORDER = "league,business-date,bowler,occurrence,allocation,payment/1" as const;
export const CANONICAL_PAYMENT_REPORT_FINGERPRINT_PREFIX = "lvpaymentreport:v1:" as const;

export type CanonicalPaymentReportMode =
  | "canonical"
  | "canonical_with_unlinked_history"
  | "legacy_fallback";

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
  receiptUrl: string | null;
  receiptNumber: string | null;
  deliveryEvidence: "delivery_not_recorded";
  source?: "canonical_allocation" | "unlinked_legacy" | "unresolved_operation" | null;
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
  source: "canonical_activation" | "legacy_league";
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

export interface CanonicalPaymentDisputeEvidence {
  present: boolean;
  amountMinor: number;
  disputeId: string | null;
  /** Durable disputes are transaction-scoped; child rows carry presence only. */
  scope?: "transaction" | "allocation" | "legacy_payment_row";
  state?: string | null;
  reviewRequired?: boolean;
}

export interface CanonicalPaymentAllocationRow {
  allocationId: string | null;
  obligationId: string | null;
  occurrenceId: string | null;
  bowlerId: number;
  amountMinor: number;
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
  operationType: "scheduled_charge" | "interactive_charge" | "refund" | "canonical_autopay_charge" | null;
  operationStatus: string | null;
  allocatedMinor: number;
  unallocatedMinor: number;
  reviewRequired: boolean;
  source: "canonical_allocation" | "unlinked_legacy" | "unresolved_operation";
  paymentTiming?: CanonicalPaymentTiming;
  refund: CanonicalPaymentRefundEvidence;
  dispute: CanonicalPaymentDisputeEvidence;
  unresolved: boolean;
  receipt: CanonicalPaymentReceiptSummary;
  sharedTransaction?: { groupKey: string | null; childCount: number } | null;
  allocations: CanonicalPaymentAllocationRow[];
  collectionEvidence?: CanonicalCollectionEvidence;
  /** Internal role projection hint; ordinary responses remove it. */
  initiatingPayerBowlerId?: number | null;
}

export interface CanonicalPaymentTransactionGroup {
  groupKey: string;
  paymentOperationId: string | null;
  combinedChargeGroupId: string | null;
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
  unallocatedLegacyMinor: number;
}

export interface CanonicalPaymentReport {
  contractVersion: typeof CANONICAL_PAYMENT_REPORT_CONTRACT;
  orderVersion: typeof CANONICAL_PAYMENT_REPORT_ORDER;
  organizationId: number;
  leagueId: number;
  mode: CanonicalPaymentReportMode;
  authoritativeSource: "canonical" | "legacy_helper";
  asOf: string;
  fingerprint: string;
  page: number;
  limit: number;
  totalRows: number;
  totalTransactions: number;
  totals: CanonicalPaymentReportTotals;
  rows: CanonicalPaymentRow[];
  transactions: CanonicalPaymentTransactionGroup[];
  unlinkedHistory: CanonicalPaymentRow[];
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
