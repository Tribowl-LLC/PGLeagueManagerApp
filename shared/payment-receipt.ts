export const PAYMENT_RECEIPT_CONTRACT = "payment-receipt/1" as const;

export type PaymentReceiptAvailability = "available" | "unavailable";
export type PaymentReceiptSource = "canonical_allocation" | "unlinked_legacy" | "unresolved_operation";
export type PaymentReceiptEvidenceStatus = "confirmed_paid" | "refunded" | "disputed" | "review_required" | "unresolved" | "pending" | "failed";

export interface PaymentReceiptAllocation {
  allocationId: string | null;
  obligationId: string | null;
  occurrenceId: string | null;
  bowlerId: number;
  amountMinor: number;
  currency: string;
  state: "active" | "voided" | "reversed" | null;
  source: PaymentReceiptSource;
}

export interface PaymentReceiptContract {
  contractVersion: typeof PAYMENT_RECEIPT_CONTRACT;
  availability: PaymentReceiptAvailability;
  receiptUrl: string | null;
  receiptNumber: string | null;
  // The database records whether an email was requested/missing, but it does
  // not contain a provider delivery receipt. Never infer that delivery
  // succeeded from a non-null hosted receipt URL.
  deliveryEvidence: "delivery_not_recorded";
  organizationId: number | null;
  leagueId: number | null;
  paymentId: number | null;
  paymentOperationId: string | null;
  operationStatus: string | null;
  amountMinor: number | null;
  currency: string | null;
  evidenceStatus: PaymentReceiptEvidenceStatus | null;
  source: PaymentReceiptSource | null;
  allocations: PaymentReceiptAllocation[];
  refund: { present: boolean; amountMinor: number; providerRefundId: string | null };
  dispute: { present: boolean; amountMinor: number; disputeId: string | null; scope?: "transaction" | "allocation" | "legacy_payment_row"; state?: string | null; reviewRequired?: boolean };
  unresolved: boolean;
  sharedTransaction: { groupKey: string | null; childCount: number } | null;
  canResend: boolean;
}

export function paymentReceiptContract(input: {
  receiptUrl: string | null | undefined;
  receiptNumber: string | null | undefined;
  organizationId?: number | null;
  leagueId?: number | null;
  paymentId?: number | null;
  paymentOperationId?: string | null;
  operationStatus?: string | null;
  amountMinor?: number | null;
  currency?: string | null;
  evidenceStatus?: PaymentReceiptEvidenceStatus | null;
  source?: PaymentReceiptSource | null;
  allocations?: PaymentReceiptAllocation[];
  refund?: PaymentReceiptContract["refund"];
  dispute?: PaymentReceiptContract["dispute"];
  unresolved?: boolean;
  sharedTransaction?: PaymentReceiptContract["sharedTransaction"];
  canResend?: boolean;
}): PaymentReceiptContract {
  const receiptUrl = input.receiptUrl ?? null;
  return {
    contractVersion: PAYMENT_RECEIPT_CONTRACT,
    availability: receiptUrl ? "available" : "unavailable",
    receiptUrl,
    receiptNumber: input.receiptNumber ?? null,
    deliveryEvidence: "delivery_not_recorded",
    organizationId: input.organizationId ?? null,
    leagueId: input.leagueId ?? null,
    paymentId: input.paymentId ?? null,
    paymentOperationId: input.paymentOperationId ?? null,
    operationStatus: input.operationStatus ?? null,
    amountMinor: input.amountMinor ?? null,
    currency: input.currency ?? null,
    evidenceStatus: input.evidenceStatus ?? null,
    source: input.source ?? null,
    allocations: input.allocations ?? [],
    refund: input.refund ?? { present: false, amountMinor: 0, providerRefundId: null },
    dispute: input.dispute ?? { present: false, amountMinor: 0, disputeId: null },
    unresolved: input.unresolved ?? false,
    sharedTransaction: input.sharedTransaction ?? null,
    canResend: input.canResend ?? Boolean(receiptUrl),
  };
}
