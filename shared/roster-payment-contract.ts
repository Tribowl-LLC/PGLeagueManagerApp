import { z } from "zod";
import { WEEKLY_BILLING_GRACE_PERIOD_MS } from "./schedule-utils";

export const ROSTER_PAYMENT_RESPONSIBILITY_CONTRACT = "roster-payment-responsibility/1" as const;
export const CANONICAL_DUE_PAST_DUE_CONTRACT_V2 = "canonical-due-past-due/2" as const;
export const INTERACTIVE_OBLIGATION_QUOTE_CONTRACT_V2 = "interactive-obligation-quote/2" as const;
export const AUTOMATIC_FIFO_PAYMENT_CONTRACT_V1 = "automatic-fifo-payment/1" as const;

/** Centralized weekly obligation timing; safe for DB-free contract tests. */
export function calculateRosterPaymentTiming(dueAt: string | Date): { dueAt: string; pastDueAt: string } {
  const due = new Date(dueAt);
  if (!Number.isFinite(due.getTime())) throw new Error("The occurrence start time is invalid");
  return {
    dueAt: due.toISOString(),
    pastDueAt: new Date(due.getTime() + WEEKLY_BILLING_GRACE_PERIOD_MS).toISOString(),
  };
}

export const rosterSlotInputSchema = z.object({
  slotIndex: z.number().int().min(0).max(3),
  occupant: z.enum(["main", "vacant", "unassigned"]),
  mainBowlerId: z.number().int().positive().nullable().optional(),
}).strict();

export const rosterPaymentResponsibilityRequestSchema = z.object({
  commandKey: z.string().trim().min(1).max(255),
  requestFingerprint: z.string().trim().min(1).max(128),
  lineupSize: z.union([z.literal(3), z.literal(4)]),
  policy: z.enum(["main_pays_full", "sub_pays_full", "special_split"]).optional(),
  slots: z.array(rosterSlotInputSchema).min(1),
}).strict();

export const occurrenceResponsibilityInputSchema = z.object({
  occurrenceId: z.string().uuid(),
  teamId: z.number().int().positive(),
  slotIndex: z.number().int().min(0).max(3),
  positionIndex: z.number().int().min(0).max(3),
  kind: z.enum(["main", "substitute", "split", "vacant"]),
  mainBowlerId: z.number().int().positive().nullable().optional(),
  substituteBowlerId: z.number().int().positive().nullable().optional(),
  payerBowlerId: z.number().int().positive().nullable().optional(),
  policy: z.enum(["main_pays_full", "sub_pays_full", "special_split"]),
  amountMinor: z.number().int().nonnegative(),
  lineageAmountMinor: z.number().int().nonnegative().nullable().optional(),
  prizeFundAmountMinor: z.number().int().nonnegative().nullable().optional(),
  dueAt: z.string().datetime({ offset: true }),
  pastDueAt: z.string().datetime({ offset: true }),
  assignmentNote: z.string().max(500).nullable().optional(),
}).strict().superRefine((value, ctx) => {
  if (new Date(value.pastDueAt).getTime() < new Date(value.dueAt).getTime()) {
    ctx.addIssue({ code: "custom", path: ["pastDueAt"], message: "pastDueAt must be on or after dueAt" });
  }
});

/** The browser supplies only the authorized payer and tender amount. FIFO
 * obligation identities are server-derived and are never an interactive
 * selector or client authority. */
export const automaticFifoPaymentQuoteRequestSchema = z.object({
  amountMinor: z.number().int().positive(),
  payerBowlerId: z.number().int().positive().optional(),
}).strict();

export const interactiveObligationQuoteRequestV2Schema = automaticFifoPaymentQuoteRequestSchema;

export const automaticFifoPaymentChargeRequestSchema = z.object({
  amountMinor: z.number().int().positive(),
  payerBowlerId: z.number().int().positive().optional(),
  sourceId: z.string().trim().min(1).max(255),
  sourceKind: z.enum(["new_card", "saved_card", "wallet"]).default("new_card"),
  buyerEmail: z.string().email().nullable().optional(),
  storeCard: z.boolean().optional().default(false),
  idempotencyKey: z.string().trim().min(1).max(255),
  requestFingerprint: z.string().trim().min(1).max(128),
}).strict();

export const interactiveObligationChargeRequestV2Schema = automaticFifoPaymentChargeRequestSchema;

export const canonicalManualRecordRequestSchema = z.object({
  amountMinor: z.number().int().positive(),
  payerBowlerId: z.number().int().positive(),
  type: z.enum(["cash", "check"]),
  checkNumber: z.string().trim().min(1).max(128).optional(),
  idempotencyKey: z.string().trim().min(1).max(255),
  requestFingerprint: z.string().trim().min(1).max(128),
  notes: z.string().max(1000).nullable().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.type === "check" && !value.checkNumber) ctx.addIssue({ code: "custom", path: ["checkNumber"], message: "checkNumber is required for check entries" });
});

const manualBatchRowKeySchema = z.string().trim().min(16).max(109).regex(/^[A-Za-z0-9_-]+$/);
const canonicalManualRecordBatchRowSchema = canonicalManualRecordRequestSchema.extend({ rowKey: manualBatchRowKeySchema }).superRefine((value, ctx) => {
  if (value.type === "cash" && value.checkNumber !== undefined) {
    ctx.addIssue({ code: "custom", path: ["checkNumber"], message: "checkNumber is only valid for check entries" });
  }
});

/** Bounded management-batch contracts keep league-night entry to one quote
 * request regardless of roster size. FIFO identities remain server-derived. */
export const canonicalManualRecordBatchQuoteRequestSchema = z.object({
  rows: z.array(z.object({
    rowKey: manualBatchRowKeySchema,
    amountMinor: z.number().int().positive(),
    payerBowlerId: z.number().int().positive(),
  }).strict()).min(1).max(200),
}).strict().superRefine((value, ctx) => {
  const payerIds = value.rows.map((row) => row.payerBowlerId);
  if (new Set(payerIds).size !== payerIds.length) ctx.addIssue({ code: "custom", path: ["rows"], message: "Each payer may appear only once per payment batch" });
  const rowKeys = value.rows.map((row) => row.rowKey);
  if (new Set(rowKeys).size !== rowKeys.length) ctx.addIssue({ code: "custom", path: ["rows"], message: "Each payment row requires a distinct row key" });
});

export const canonicalManualRecordBatchRequestSchema = z.object({
  rows: z.array(canonicalManualRecordBatchRowSchema).min(1).max(200),
}).strict().superRefine((value, ctx) => {
  const keys = value.rows.map((row) => row.idempotencyKey);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", path: ["rows"], message: "Each payment row requires a distinct idempotency key" });
  const payerIds = value.rows.map((row) => row.payerBowlerId);
  if (new Set(payerIds).size !== payerIds.length) ctx.addIssue({ code: "custom", path: ["rows"], message: "Each payer may appear only once per payment batch" });
  for (const [index, row] of value.rows.entries()) {
    if (row.rowKey !== row.idempotencyKey) ctx.addIssue({ code: "custom", path: ["rows", index, "rowKey"], message: "rowKey must match idempotencyKey" });
  }
});

export const canonicalCorrectionRequestSchema = z.object({
  paymentId: z.number().int().positive(),
  correctionMode: z.literal("void_only").default("void_only"),
  reason: z.string().trim().min(1).max(500),
  idempotencyKey: z.string().trim().min(1).max(255),
  requestFingerprint: z.string().trim().min(1).max(128),
}).strict();

export type RosterPaymentResponsibilityRequest = z.infer<typeof rosterPaymentResponsibilityRequestSchema>;
export type OccurrenceResponsibilityInput = z.infer<typeof occurrenceResponsibilityInputSchema>;
export type InteractiveObligationQuoteRequestV2 = z.infer<typeof interactiveObligationQuoteRequestV2Schema>;
export type InteractiveObligationChargeRequestV2 = z.infer<typeof interactiveObligationChargeRequestV2Schema>;
export type AutomaticFifoPaymentQuoteRequest = z.infer<typeof automaticFifoPaymentQuoteRequestSchema>;
export type AutomaticFifoPaymentChargeRequest = z.infer<typeof automaticFifoPaymentChargeRequestSchema>;

export type CanonicalDuePastDueRowV2 = {
  id: string;
  organizationId: number;
  leagueId: number;
  occurrenceId: string;
  responsibilityId: string;
  teamId: number;
  component: "full" | "lineage" | "prize";
  payerBowlerId: number;
  amountMinor: number;
  currency: "USD";
  dueAt: string;
  pastDueAt: string;
  state: "open" | "partially_settled" | "settled" | "voided";
  allocatedMinor: number;
  outstandingMinor: number;
  classification: "future" | "due" | "past_due" | "settled" | "voided" | "review_required";
  reviewRequired: boolean;
};

export type CanonicalDuePastDueResponseV2 = {
  contractVersion: typeof CANONICAL_DUE_PAST_DUE_CONTRACT_V2;
  orderVersion: "due-at,payer,occurrence,obligation/2";
  organizationId: number;
  leagueId: number;
  authoritativeSource: "payment_obligations";
  asOf: string;
  rows: CanonicalDuePastDueRowV2[];
  totals: {
    amountMinor: number;
    allocatedMinor: number;
    outstandingMinor: number;
    collectiblePastDueMinor: number;
    reviewCount: number;
    settledCount: number;
    voidedCount: number;
  };
};
export type CanonicalManualRecordRequest = z.infer<typeof canonicalManualRecordRequestSchema>;
export type CanonicalManualRecordBatchQuoteRequest = z.infer<typeof canonicalManualRecordBatchQuoteRequestSchema>;
export type CanonicalManualRecordBatchRequest = z.infer<typeof canonicalManualRecordBatchRequestSchema>;
export type CanonicalCorrectionRequest = z.infer<typeof canonicalCorrectionRequestSchema>;
