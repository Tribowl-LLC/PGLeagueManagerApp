import { z } from "zod";

/**
 * Interactive combined payments deliberately live beside the v2 contract.
 * v2 is also used by standing-payment recovery and is therefore not widened
 * or version-bumped by this feature.
 */
export const INTERACTIVE_PAYMENT_PARTICIPANTS_CONTRACT_V3 = "interactive-payment-participants/3" as const;
export const INTERACTIVE_PAYMENT_QUOTE_CONTRACT_V3 = "interactive-payment-quote/3" as const;
export const INTERACTIVE_PAYMENT_CHARGE_CONTRACT_V3 = "interactive-payment-charge/3" as const;

const recipientSelectionSchema = z.object({
  bowlerId: z.number().int().positive(),
  /** Number of oldest payable weekly occurrences to collect. */
  weeks: z.number().int().positive().max(1000),
  /** Upfront leagues require the complete remaining balance for this row. */
  fullBalance: z.boolean().default(false),
}).strict();

const recipientsSchema = z.array(recipientSelectionSchema).min(1).max(200).superRefine((rows, ctx) => {
  const ids = rows.map((row) => row.bowlerId);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [], message: "Each recipient may be selected only once" });
});

export const interactivePaymentParticipantsResponseSchema = z.object({
  contractVersion: z.literal(INTERACTIVE_PAYMENT_PARTICIPANTS_CONTRACT_V3),
  organizationId: z.number().int().positive(),
  leagueId: z.number().int().positive(),
  paymentMode: z.enum(["weekly", "upfront"]),
  participants: z.array(z.object({
    bowlerId: z.number().int().positive(),
    name: z.string().min(1),
    role: z.enum(["self", "partner"]),
    remainingMinor: z.number().int().nonnegative(),
    pastDueMinor: z.number().int().nonnegative(),
    weeklyOptions: z.array(z.object({ weeks: z.number().int().positive(), amountMinor: z.number().int().positive() }).strict()),
    eligible: z.boolean(),
    reason: z.string().nullable(),
  }).strict()),
}).strict();

export const interactivePaymentQuoteRequestV3Schema = z.object({ recipients: recipientsSchema }).strict();

export const interactivePaymentChargeRequestV3Schema = z.object({
  recipients: recipientsSchema,
  sourceId: z.string().trim().min(1).max(255),
  sourceKind: z.enum(["new_card", "saved_card", "wallet"]).default("new_card"),
  buyerEmail: z.string().email().nullable().optional(),
  storeCard: z.boolean().optional().default(false),
  idempotencyKey: z.string().trim().min(16).max(109).regex(/^[A-Za-z0-9_-]+$/),
  requestFingerprint: z.string().trim().min(1).max(128),
}).strict();

export type InteractivePaymentRecipientSelectionV3 = z.infer<typeof recipientSelectionSchema>;
export type InteractivePaymentQuoteRequestV3 = z.infer<typeof interactivePaymentQuoteRequestV3Schema>;
export type InteractivePaymentChargeRequestV3 = z.infer<typeof interactivePaymentChargeRequestV3Schema>;
export type InteractivePaymentParticipantsResponseV3 = z.infer<typeof interactivePaymentParticipantsResponseSchema>;

/**
 * Server-projected allocation evidence for the payer's quote breakdown. The
 * date and ordinal are copied from the canonical occurrence; clients must not
 * infer a week label from dueAt, array position, or the selected week count.
 */
export interface InteractivePaymentQuoteAllocationV3 {
  obligationId: string;
  amountMinor: number;
  occurrenceId: string;
  occurrenceLocalDate: string;
  plannedOrdinal: number | null;
  /** Human-readable label derived by the server from canonical occurrence evidence. */
  label: string;
}

export interface InteractivePaymentQuoteRecipientV3 {
  bowlerId: number;
  name: string;
  role: "self" | "partner";
  weeks: number;
  fullBalance: boolean;
  subtotalMinor: number;
  allocations: InteractivePaymentQuoteAllocationV3[];
  /** Labels for the actual FIFO allocations, including partial spill weeks. */
  coveredWeeks: string[];
}
