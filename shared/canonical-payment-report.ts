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
  refund: CanonicalPaymentRefundEvidence;
  dispute: CanonicalPaymentDisputeEvidence;
  unresolved: boolean;
  receipt: CanonicalPaymentReceiptSummary;
  allocations: CanonicalPaymentAllocationRow[];
}

export interface CanonicalPaymentTransactionGroup {
  groupKey: string;
  paymentOperationId: string | null;
  combinedChargeGroupId: string | null;
  amountMinor: number;
  currency: string;
  paymentIds: number[];
  dispute?: { present: boolean; amountMinor: number; disputeId: string | null; currency: string; state: string; reviewRequired: boolean };
  rows: CanonicalPaymentRow[];
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
