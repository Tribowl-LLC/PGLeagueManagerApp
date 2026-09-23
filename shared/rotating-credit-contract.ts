import { z } from "zod";

export const ROTATING_CREDIT_BALANCE_CONTRACT = "rotating-credit-balance/1" as const;
export const ROTATING_CREDIT_QUOTE_CONTRACT = "rotating-credit-quote/1" as const;
export const ROTATING_CREDIT_OPERATION_CONTRACT = "rotating-credit-operation/1" as const;
export const ROTATING_CREDIT_MANUAL_QUOTE_CONTRACT = "rotating-credit-manual-quote/1" as const;
export const ROTATING_CREDIT_REFUND_QUOTE_CONTRACT = "rotating-credit-refund-quote/1" as const;
export const ROTATING_CREDIT_REFUND_OPERATION_CONTRACT = "rotating-credit-refund-operation/1" as const;

const idempotencyKey = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/);
const quoteFingerprint = z.string().regex(/^lvrotcrquote:v1:[0-9a-f]{64}$/);
const refundQuoteFingerprint = z.string().regex(/^lvrotcrrefundquote:v1:[0-9a-f]{64}$/);
const amountMinor = z.number().int().positive().max(2_147_483_647);

export const rotatingCreditQuoteRequestSchema = z.object({
  shareCount: z.number().int().min(1).max(52),
}).strict();

export const rotatingCreditChargeRequestSchema = z.object({
  shareCount: z.number().int().min(1).max(52),
  sourceId: z.string().trim().min(1).max(2048),
  sourceKind: z.enum(["new_card", "saved_card", "wallet"]),
  idempotencyKey,
  quoteFingerprint,
  buyerEmail: z.string().trim().email().max(255).optional(),
}).strict();

export const rotatingCreditManualQuoteRequestSchema = z.object({
  bowlerId: z.number().int().positive(),
  amountMinor,
}).strict();

export const rotatingCreditManualFundingRequestSchema = z.object({
  bowlerId: z.number().int().positive(),
  amountMinor,
  tenderType: z.enum(["cash", "check"]),
  checkNumber: z.string().trim().min(1).max(64).optional(),
  quoteFingerprint,
  idempotencyKey,
  notes: z.string().trim().max(500).optional(),
}).strict().superRefine((value, context) => {
  if (value.tenderType === "check" && value.checkNumber === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["checkNumber"], message: "checkNumber is required for check tenders" });
  }
  if (value.tenderType === "cash" && value.checkNumber !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["checkNumber"], message: "checkNumber is only valid for check tenders" });
  }
});

export const rotatingCreditRefundQuoteRequestSchema = z.object({
  fundingId: z.string().uuid(),
}).strict();

export const rotatingCreditRefundRequestSchema = z.object({
  fundingId: z.string().uuid(),
  refundKind: z.enum(["provider", "cash", "check"]),
  quoteFingerprint: refundQuoteFingerprint,
  idempotencyKey,
  reason: z.string().trim().min(1).max(500),
  reference: z.string().trim().min(1).max(255).optional(),
}).strict().superRefine((value, context) => {
  if (value.refundKind !== "provider" && value.reference === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reference"], message: "reference is required when staff records a cash or check refund" });
  }
  if (value.refundKind === "provider" && value.reference !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reference"], message: "provider refunds do not accept a manual reference" });
  }
});

export const rotatingCreditRecoverByRequestKeySchema = z.object({ idempotencyKey }).strict();

export type RotatingCreditQuoteRequest = z.infer<typeof rotatingCreditQuoteRequestSchema>;
export type RotatingCreditChargeRequest = z.infer<typeof rotatingCreditChargeRequestSchema>;
export type RotatingCreditManualQuoteRequest = z.infer<typeof rotatingCreditManualQuoteRequestSchema>;
export type RotatingCreditManualFundingRequest = z.infer<typeof rotatingCreditManualFundingRequestSchema>;
export type RotatingCreditRefundQuoteRequest = z.infer<typeof rotatingCreditRefundQuoteRequestSchema>;
export type RotatingCreditRefundRequest = z.infer<typeof rotatingCreditRefundRequestSchema>;

export interface RotatingCreditApplicationWire {
  applicationId: string;
  fundingId: string;
  paymentId: number;
  allocationId: string;
  obligationId: string;
  assignmentId: string;
  occurrenceId: string;
  occurrenceLocalDate: string;
  teamId: number;
  slotIndex: number;
  amountMinor: number;
  appliedAt: string;
  status: "active" | "reversed";
  reversedAt: string | null;
  reversalReason: string | null;
}

export interface RotatingCreditLotWire {
  fundingId: string;
  paymentId: number;
  amountMinor: number;
  availableMinor: number;
  appliedMinor: number;
  refundedMinor: number;
  refundHeldMinor: number;
  reviewHeldMinor: number;
  paymentType: string;
  createdAt: string;
  receiptAvailable: boolean;
  receiptUrl: string | null;
  receiptNumber: string | null;
  receiptEmailMissing: boolean;
}

export interface RotatingCreditBalanceWire {
  contractVersion: typeof ROTATING_CREDIT_BALANCE_CONTRACT;
  organizationId: number;
  leagueId: number;
  bowlerId: number;
  eligibleForCredit: boolean;
  shareAmountMinor: number | null;
  currency: "USD";
  fundedMinor: number;
  availableMinor: number;
  appliedMinor: number;
  refundedMinor: number;
  refundHeldMinor: number;
  reviewHeldMinor: number;
  lots: RotatingCreditLotWire[];
  applications: RotatingCreditApplicationWire[];
}

export interface RotatingCreditAdvisoryApplicationWire {
  obligationId: string;
  occurrenceId: string;
  occurrenceLocalDate: string;
  teamId: number;
  slotIndex: number;
  amountMinor: number;
}

export interface RotatingCreditQuoteWire {
  contractVersion: typeof ROTATING_CREDIT_QUOTE_CONTRACT;
  organizationId: number;
  leagueId: number;
  bowlerId: number;
  currency: "USD";
  shareCount: number;
  shareAmountMinor: number;
  amountMinor: number;
  currentAvailableMinor: number;
  expectedAvailableAfterPurchaseMinor: number;
  advisoryApplications: RotatingCreditAdvisoryApplicationWire[];
  fingerprint: string;
}

export type RotatingCreditManualQuoteWire = {
  contractVersion: typeof ROTATING_CREDIT_MANUAL_QUOTE_CONTRACT;
  organizationId: number;
  leagueId: number;
  bowlerId: number;
  currency: "USD";
  amountMinor: number;
  currentAvailableMinor: number;
  expectedAvailableAfterPurchaseMinor: number;
  advisoryApplications: RotatingCreditAdvisoryApplicationWire[];
  fingerprint: string;
};

export interface RotatingCreditOperationWire {
  contractVersion: typeof ROTATING_CREDIT_OPERATION_CONTRACT;
  operationId: string | null;
  fundingId: string | null;
  status: "pending" | "leased" | "provider_unknown" | "retry_scheduled" | "succeeded" | "action_required" | "reconciliation_required" | "failed_terminal" | "canceled";
  paymentId: number | null;
  providerPaymentId: string | null;
  confirmedNoChargeDecline: boolean;
  fundedMinor: number;
  applications: RotatingCreditApplicationWire[];
  balance: RotatingCreditBalanceWire | null;
}

export function isConfirmedNoChargeDecline(input: {
  status: RotatingCreditOperationWire["status"];
  errorClassification: string | null;
  providerObjectId: string | null;
  paymentId: number | null;
}): boolean {
  return input.status === "action_required"
    && input.errorClassification === "hard_decline"
    && input.providerObjectId === null
    && input.paymentId === null;
}

export interface RotatingCreditRefundQuoteWire {
  contractVersion: typeof ROTATING_CREDIT_REFUND_QUOTE_CONTRACT;
  organizationId: number;
  leagueId: number;
  bowlerId: number;
  fundingId: string;
  paymentId: number;
  currency: "USD";
  amountMinor: number;
  providerRefundAvailable: boolean;
  fingerprint: string;
}

export interface RotatingCreditRefundOperationWire {
  contractVersion: typeof ROTATING_CREDIT_REFUND_OPERATION_CONTRACT;
  refundId: string;
  operationId: string | null;
  status: "pending" | "leased" | "provider_unknown" | "retry_scheduled" | "succeeded" | "action_required" | "reconciliation_required" | "failed_terminal" | "canceled";
  amountMinor: number;
  providerRefundId: string | null;
  balance: RotatingCreditBalanceWire;
}
