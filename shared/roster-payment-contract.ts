import { z } from "zod";
import { WEEKLY_BILLING_GRACE_PERIOD_MS } from "./schedule-utils";

export const ROSTER_PAYMENT_RESPONSIBILITY_CONTRACT = "roster-payment-responsibility/1" as const;
export const ROSTER_PAYMENT_RESPONSIBILITY_CONTRACT_V2 = "roster-payment-responsibility/2" as const;
export const CANONICAL_DUE_PAST_DUE_CONTRACT_V2 = "canonical-due-past-due/2" as const;
export const CANONICAL_DUE_PAST_DUE_CONTRACT_V3 = "canonical-due-past-due/3" as const;
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

export const rosterSlotInputV2Schema = z.object({
  slotIndex: z.number().int().min(0).max(3),
  occupant: z.enum(["main", "vacant", "unassigned", "rotating"]),
  mainBowlerId: z.number().int().positive().nullable().optional(),
}).strict().superRefine((slot, context) => {
  if (slot.occupant === "main" && slot.mainBowlerId == null) {
    context.addIssue({ code: "custom", path: ["mainBowlerId"], message: "A Main slot requires a bowler" });
  }
  if (slot.occupant !== "main" && slot.mainBowlerId != null) {
    context.addIssue({ code: "custom", path: ["mainBowlerId"], message: "Only a Main slot may contain a Main bowler identity" });
  }
});

export const rosterPaymentResponsibilityRequestV2Schema = z.object({
  commandKey: z.string().trim().min(1).max(255),
  requestFingerprint: z.string().trim().min(1).max(128),
  lineupSize: z.union([z.literal(3), z.literal(4)]),
  policy: z.enum(["main_pays_full", "sub_pays_full", "special_split"]).optional(),
  slots: z.array(rosterSlotInputV2Schema).min(1),
  eligibleRotatingBowlerIds: z.array(z.number().int().positive()).max(100),
}).strict().superRefine((request, context) => {
  const slotIndexes = request.slots.map((slot) => slot.slotIndex);
  if (new Set(slotIndexes).size !== slotIndexes.length) {
    context.addIssue({ code: "custom", path: ["slots"], message: "Each lineup slot may appear once" });
  }
  const mainBowlerIds = request.slots.flatMap((slot) => slot.occupant === "main" && slot.mainBowlerId != null ? [slot.mainBowlerId] : []);
  if (new Set(mainBowlerIds).size !== mainBowlerIds.length) {
    context.addIssue({ code: "custom", path: ["slots"], message: "A bowler may occupy only one Main slot" });
  }
  if (new Set(request.eligibleRotatingBowlerIds).size !== request.eligibleRotatingBowlerIds.length) {
    context.addIssue({ code: "custom", path: ["eligibleRotatingBowlerIds"], message: "Each eligible bowler may appear once" });
  }
  if (!request.slots.some((slot) => slot.occupant === "rotating") && request.eligibleRotatingBowlerIds.length > 0) {
    context.addIssue({ code: "custom", path: ["eligibleRotatingBowlerIds"], message: "A rotation pool requires at least one rotating slot" });
  }
});

export const rotatingOccurrenceAssignmentInputSchema = z.object({
  occurrenceId: z.string().uuid(),
  teamId: z.number().int().positive(),
  slotIndex: z.number().int().min(0).max(3),
  expectedRevision: z.number().int().positive().nullable(),
  actualBowlerId: z.number().int().positive().nullable(),
  correctionReason: z.string().trim().min(1).max(500).optional(),
}).strict().superRefine((assignment, context) => {
  if (assignment.expectedRevision === null && assignment.actualBowlerId === null) {
    context.addIssue({ code: "custom", path: ["actualBowlerId"], message: "A new assignment must identify the rotating bowler" });
  }
});

export const rotatingOccurrenceAssignmentRequestSchema = z.object({
  commandKey: z.string().trim().min(1).max(255),
  requestFingerprint: z.string().trim().min(1).max(128),
  assignments: z.array(rotatingOccurrenceAssignmentInputSchema).min(1).max(200),
}).strict().superRefine((request, context) => {
  const keys = request.assignments.map((row) => `${row.occurrenceId}:${row.teamId}:${row.slotIndex}`);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: "custom", path: ["assignments"], message: "Each occurrence slot may appear once" });
  }
});

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
  correctionMode: z.enum(["void_only", "edit_cash"]).default("void_only"),
  reason: z.string().trim().min(1).max(500),
  idempotencyKey: z.string().trim().min(1).max(255),
  requestFingerprint: z.string().trim().min(1).max(128),
  amountMinor: z.number().int().positive().optional(),
  paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "paymentDate must be YYYY-MM-DD").optional(),
}).strict().superRefine((value, context) => {
  if (value.correctionMode === "edit_cash") {
    if (value.amountMinor === undefined) context.addIssue({ code: "custom", path: ["amountMinor"], message: "amountMinor is required for cash edits" });
    if (value.paymentDate === undefined) context.addIssue({ code: "custom", path: ["paymentDate"], message: "paymentDate is required for cash edits" });
  } else if (value.amountMinor !== undefined || value.paymentDate !== undefined) {
    context.addIssue({ code: "custom", path: ["correctionMode"], message: "amountMinor and paymentDate require correctionMode=edit_cash" });
  }
  if (value.paymentDate !== undefined) {
    const [year, month, day] = value.paymentDate.split("-").map(Number);
    const parsed = new Date(0);
    parsed.setUTCFullYear(year, month - 1, day);
    parsed.setUTCHours(0, 0, 0, 0);
    if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) {
      context.addIssue({ code: "custom", path: ["paymentDate"], message: "paymentDate must be a real calendar date" });
    }
  }
});

export type RosterPaymentResponsibilityRequest = z.infer<typeof rosterPaymentResponsibilityRequestSchema>;
export type RosterPaymentResponsibilityRequestV2 = z.infer<typeof rosterPaymentResponsibilityRequestV2Schema>;
export type RotatingOccurrenceAssignmentInput = z.infer<typeof rotatingOccurrenceAssignmentInputSchema>;
export type RotatingOccurrenceAssignmentRequest = z.infer<typeof rotatingOccurrenceAssignmentRequestSchema>;
export type OccurrenceResponsibilityInput = z.infer<typeof occurrenceResponsibilityInputSchema>;
export type InteractiveObligationQuoteRequestV2 = z.infer<typeof interactiveObligationQuoteRequestV2Schema>;
export type InteractiveObligationChargeRequestV2 = z.infer<typeof interactiveObligationChargeRequestV2Schema>;
export type AutomaticFifoPaymentQuoteRequest = z.infer<typeof automaticFifoPaymentQuoteRequestSchema>;
export type AutomaticFifoPaymentChargeRequest = z.infer<typeof automaticFifoPaymentChargeRequestSchema>;

export interface RosterPaymentResponsibilityReadContractV2 {
  contractVersion: typeof ROSTER_PAYMENT_RESPONSIBILITY_CONTRACT_V2;
  organizationId: number;
  leagueId: number;
  payingLineupSize: 3 | 4 | null;
  weeklyFee: number;
  lineageFee: number | null;
  prizeFundFee: number | null;
  substituteAccess: "team_only" | "floating";
  substitutePaymentRegime: "team_choice" | "league_lineage_prize_split";
  ready: boolean;
  incompleteTeamIds: number[];
  occurrences: Array<{
    id: string;
    startAt: string;
    occurrenceLocalDate: string;
    plannedOrdinal: number;
    billingOrdinal: number | null;
    status: "scheduled" | "completed";
  }>;
  teams: Array<{
    id: number;
    name: string;
    number: number;
    policy: "main_pays_full" | "sub_pays_full" | "special_split";
    eligibleRotatingBowlerIds: number[];
    slots: Array<{
      teamId: number;
      slotIndex: number;
      occupant: "main" | "vacant" | "unassigned" | "rotating";
      mainBowlerId: number | null;
      currentRevision: number;
    }>;
  }>;
  rotationAssignments: Array<{
    occurrenceId: string;
    teamId: number;
    slotIndex: number;
    responsibilityId: string | null;
    obligationIds: string[];
    assignmentId: string | null;
    actualBowlerId: number | null;
    revision: number | null;
    assignedAt: string | null;
    recordedByUserId: number | null;
  }>;
  occurrenceResponsibilities: Array<{
    occurrenceId: string;
    teamId: number;
    slotIndex: number;
    positionIndex: number;
    responsibilityKind: "main" | "substitute" | "split" | "vacant" | "rotating";
    mainBowlerId: number | null;
    substituteBowlerId: number | null;
    payerBowlerId: number | null;
    policy: "main_pays_full" | "sub_pays_full" | "special_split";
    amountMinor: number;
    lineageAmountMinor: number | null;
    prizeFundAmountMinor: number | null;
  }>;
  substituteBowlerOptions: Array<{ id: number; name: string; teamId: number | null }>;
}

export type CanonicalRotatingRosterFingerprintInput = Pick<RosterPaymentResponsibilityRequestV2,
  "lineupSize" | "policy" | "slots" | "eligibleRotatingBowlerIds"
>;

export function serializeCanonicalRotatingRosterFingerprint(request: CanonicalRotatingRosterFingerprintInput): string {
  return JSON.stringify({
    lineupSize: request.lineupSize,
    policy: request.policy ?? "main_pays_full",
    slots: [...request.slots]
      .sort((a, b) => a.slotIndex - b.slotIndex)
      .map((slot) => ({ slotIndex: slot.slotIndex, occupant: slot.occupant, mainBowlerId: slot.mainBowlerId ?? null })),
    eligibleRotatingBowlerIds: [...request.eligibleRotatingBowlerIds].sort((a, b) => a - b),
  });
}

export function serializeRotatingOccurrenceAssignmentFingerprint(assignments: RotatingOccurrenceAssignmentInput[]): string {
  return JSON.stringify([...assignments]
    .sort((a, b) => a.occurrenceId.localeCompare(b.occurrenceId) || a.teamId - b.teamId || a.slotIndex - b.slotIndex)
    .map((assignment) => ({
      occurrenceId: assignment.occurrenceId,
      teamId: assignment.teamId,
      slotIndex: assignment.slotIndex,
      expectedRevision: assignment.expectedRevision,
      actualBowlerId: assignment.actualBowlerId,
      correctionReason: assignment.correctionReason ?? null,
    })));
}

export type CanonicalResponsibilityFingerprintInput = Pick<OccurrenceResponsibilityInput,
  "occurrenceId" | "teamId" | "slotIndex" | "positionIndex" | "kind"
  | "mainBowlerId" | "substituteBowlerId" | "payerBowlerId" | "policy"
>;

/**
 * Serialize the exact responsibility identity used by the versioned request
 * fingerprint. Keep this projection free of amount and timing fields because
 * those values are server-authoritative when the responsibility is recorded.
 */
export function serializeCanonicalResponsibilityFingerprint(rows: CanonicalResponsibilityFingerprintInput[]): string {
  return JSON.stringify([...rows]
    .sort((a, b) => a.occurrenceId.localeCompare(b.occurrenceId) || a.teamId - b.teamId || a.positionIndex - b.positionIndex)
    .map((row) => ({
      occurrenceId: row.occurrenceId,
      teamId: row.teamId,
      slotIndex: row.slotIndex,
      positionIndex: row.positionIndex,
      kind: row.kind,
      mainBowlerId: row.mainBowlerId ?? null,
      substituteBowlerId: row.substituteBowlerId ?? null,
      payerBowlerId: row.payerBowlerId ?? null,
      policy: row.policy,
    })));
}

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
  grossAllocatedMinor: number;
  refundedMinor: number;
  waivedMinor: number;
  stillOwed: boolean;
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
