import { z } from "zod";

export const ACCOUNT_PAYMENT_FUNDING_QUOTE_CONTRACT_V4 = "account-payment-funding-quote/4" as const;
export const ACCOUNT_PAYMENT_FUNDING_CHARGE_CONTRACT_V4 = "account-payment-funding-charge/4" as const;
export const ACCOUNT_PAYMENT_PARTICIPANTS_CONTRACT_V4 = "interactive-payment-participants/4" as const;
export const ACCOUNT_PAYMENT_FUNDING_QUOTE_FINGERPRINT_PREFIX_V4 = "lvaccountfundquote:v4:" as const;

const amountMinorSchema = z.number().int().min(0).max(2_147_483_647);
const positiveAmountMinorSchema = z.number().int().positive().max(2_147_483_647);
const payerBowlerIdSchema = z.number().int().positive().max(2_147_483_647);
const idempotencyKeySchema = z.string().trim().min(16).max(109).regex(/^[A-Za-z0-9_-]+$/);
const quoteFingerprintSchema = z.string().regex(/^lvaccountfundquote:v4:[0-9a-f]{64}$/);

const accountPaymentFundingParticipantV4Schema = z.object({
  bowlerId: payerBowlerIdSchema,
  name: z.string().trim().min(1).max(255),
  role: z.enum(["self", "partner"]),
  confirmedDebtMinor: amountMinorSchema,
  availableCreditMinor: amountMinorSchema,
  /** Preset collection targets. Forecast portions remain distinct from debt. */
  forecastTargets: z.object({
    currentCollectionMinor: amountMinorSchema,
    selectedWeeks: z.array(z.object({
      weeks: z.number().int().positive().max(1000),
      amountMinor: amountMinorSchema,
    }).strict()).max(1000),
    fullSeasonMinor: amountMinorSchema,
  }).strict(),
}).strict();

const accountPaymentParticipantsV4Base = z.object({
  contractVersion: z.literal(ACCOUNT_PAYMENT_PARTICIPANTS_CONTRACT_V4),
  organizationId: z.number().int().positive().max(2_147_483_647),
  leagueId: z.number().int().positive().max(2_147_483_647),
  payerBowlerId: payerBowlerIdSchema,
}).strict();

/** Discovery response keeps V3 untouched. Legacy clients continue to use its
 * original participant endpoint and receipt semantics. */
const legacyPaymentParticipantsV4Schema = accountPaymentParticipantsV4Base.extend({
  accountingMode: z.literal("legacy_roster_v3"),
}).strict();

const confirmedAccountPaymentParticipantsV4Schema = accountPaymentParticipantsV4Base.extend({
  accountingMode: z.literal("confirmed_account_v4"),
  paymentMode: z.enum(["weekly", "upfront"]),
  recipients: z.array(accountPaymentFundingParticipantV4Schema).min(1).max(200),
}).strict();

export const accountPaymentParticipantsResponseV4Schema = z.discriminatedUnion("accountingMode", [
  legacyPaymentParticipantsV4Schema,
  confirmedAccountPaymentParticipantsV4Schema,
]).superRefine((response, context) => {
  if (response.accountingMode === "legacy_roster_v3") return;
  const recipientIds = response.recipients.map((recipient) => recipient.bowlerId);
  if (new Set(recipientIds).size !== recipientIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["recipients"], message: "Each funding recipient may appear only once" });
  }
  const selfRecipients = response.recipients.filter((recipient) => recipient.role === "self");
  if (selfRecipients.length > 1 || (selfRecipients.length === 1 && selfRecipients[0]?.bowlerId !== response.payerBowlerId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["recipients"], message: "Self recipient, when present, must identify the payer" });
  }
  for (const [index, recipient] of response.recipients.entries()) {
    if ((recipient.role === "self") !== (recipient.bowlerId === response.payerBowlerId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["recipients", index, "role"], message: "Recipient role does not match the authenticated payer" });
    }
  }
});

/**
 * Each selected recipient gets an immutable portion of the one combined
 * receipt. A preset can target that recipient's confirmed debt or current
 * aggregate forecast target; an explicit amount is the exact new receipt
 * portion and must never be reduced by existing credit.
 */
export const accountPaymentFundingSelectionV4Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("explicit_amount"), amountMinor: positiveAmountMinorSchema }).strict(),
  z.object({ kind: z.literal("confirmed_debt_balance") }).strict(),
  z.object({
    kind: z.literal("forecast_collection_target"),
    scope: z.enum(["current_collection", "selected_weeks", "full_season"]).default("current_collection"),
    weeks: z.number().int().positive().max(1000).optional(),
  }).strict().superRefine((selection, context) => {
    if (selection.scope === "selected_weeks" && selection.weeks === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["weeks"], message: "selected_weeks requires a week count" });
    }
    if (selection.scope !== "selected_weeks" && selection.weeks !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["weeks"], message: "weeks is only valid for selected_weeks" });
    }
  }),
]);

export const accountPaymentFundingQuoteRequestV4Schema = z.object({
  recipients: z.array(z.object({
    bowlerId: payerBowlerIdSchema,
    selection: accountPaymentFundingSelectionV4Schema,
  }).strict()).min(1).max(200).superRefine((recipients, context) => {
    const bowlerIds = recipients.map((recipient) => recipient.bowlerId);
    if (new Set(bowlerIds).size !== bowlerIds.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [], message: "Each funding recipient may appear only once" });
    }
  }),
}).strict();

/**
 * Resolve the amount the provider would charge for this quote. Existing
 * credit reduces only server-selected preset targets. A typed amount remains
 * the gross receipt amount requested by the payer.
 */
export function resolveAccountPaymentFundingChargeAmountV4(input: {
  selection: AccountPaymentFundingSelectionV4;
  confirmedDebtMinor: number;
  availableCreditMinor: number;
  collectionTargetMinor: number;
  forecastCollectionTargetMinor: number;
}): number {
  const confirmedDebtMinor = amountMinorSchema.parse(input.confirmedDebtMinor);
  const availableCreditMinor = amountMinorSchema.parse(input.availableCreditMinor);
  const collectionTargetMinor = amountMinorSchema.parse(input.collectionTargetMinor);
  const forecastCollectionTargetMinor = amountMinorSchema.parse(input.forecastCollectionTargetMinor);
  const selection = accountPaymentFundingSelectionV4Schema.parse(input.selection);

  if (selection.kind === "explicit_amount") return selection.amountMinor;
  const targetMinor = selection.kind === "confirmed_debt_balance"
    ? confirmedDebtMinor
    : collectionTargetMinor;
  return Math.max(0, targetMinor - availableCreditMinor);
}

const accountPaymentFundingQuoteRecipientResponseV4Schema = z.object({
  bowlerId: payerBowlerIdSchema,
  name: z.string().trim().min(1).max(255),
  role: z.enum(["self", "partner"]),
  selection: accountPaymentFundingSelectionV4Schema,
  /** Collectible confirmed debt for this credited recipient only. */
  confirmedDebtMinor: amountMinorSchema,
  /** Available existing credit owned by this credited recipient. */
  availableCreditMinor: amountMinorSchema,
  /** Forecast target for this recipient; it is not confirmed debt. */
  forecastCollectionTargetMinor: amountMinorSchema,
  /** Gross preset target before credit, including confirmed debt where the
   * selected collection mode consumes it. */
  collectionTargetMinor: amountMinorSchema,
  /** Exact portion of the new combined provider charge for this recipient. */
  providerChargeAmountMinor: amountMinorSchema,
}).strict();

export const accountPaymentFundingQuoteResponseV4Schema = z.object({
  contractVersion: z.literal(ACCOUNT_PAYMENT_FUNDING_QUOTE_CONTRACT_V4),
  organizationId: z.number().int().positive().max(2_147_483_647),
  leagueId: z.number().int().positive().max(2_147_483_647),
  payerBowlerId: payerBowlerIdSchema,
  currency: z.literal("USD"),
  recipients: z.array(accountPaymentFundingQuoteRecipientResponseV4Schema).min(1).max(200),
  /** One provider operation captures the sum of the immutable recipient portions. */
  providerChargeAmountMinor: amountMinorSchema,
  quoteFingerprint: quoteFingerprintSchema,
}).strict().superRefine((quote, context) => {
  const recipientIds = quote.recipients.map((recipient) => recipient.bowlerId);
  if (new Set(recipientIds).size !== recipientIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["recipients"], message: "Each funding recipient may appear only once" });
  }
  const selfRecipients = quote.recipients.filter((recipient) => recipient.role === "self");
  if (selfRecipients.length > 1 || (selfRecipients.length === 1 && selfRecipients[0]?.bowlerId !== quote.payerBowlerId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["recipients"], message: "Self evidence, when present, must identify the payer" });
  }
  let expectedAggregateMinor = 0;
  for (const [index, recipient] of quote.recipients.entries()) {
    if ((recipient.role === "self") !== (recipient.bowlerId === quote.payerBowlerId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["recipients", index, "role"], message: "Recipient role does not match the authenticated payer" });
    }
    const expectedPortionMinor = resolveAccountPaymentFundingChargeAmountV4({
      selection: recipient.selection,
      confirmedDebtMinor: recipient.confirmedDebtMinor,
      availableCreditMinor: recipient.availableCreditMinor,
      collectionTargetMinor: recipient.collectionTargetMinor,
      forecastCollectionTargetMinor: recipient.forecastCollectionTargetMinor,
    });
    if (recipient.providerChargeAmountMinor !== expectedPortionMinor) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["recipients", index, "providerChargeAmountMinor"], message: "recipient charge portion does not match the selected funding target" });
    }
    expectedAggregateMinor += expectedPortionMinor;
  }
  if (quote.providerChargeAmountMinor !== expectedAggregateMinor) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["providerChargeAmountMinor"], message: "aggregate charge amount must equal all recipient portions" });
  }
});

export const accountPaymentFundingChargeRequestV4Schema = accountPaymentFundingQuoteRequestV4Schema.extend({
  sourceId: z.string().trim().min(1).max(255),
  sourceKind: z.enum(["new_card", "saved_card", "wallet"]).default("new_card"),
  buyerEmail: z.string().email().max(255).nullable().optional(),
  storeCard: z.boolean().default(false),
  idempotencyKey: idempotencyKeySchema,
  quoteFingerprint: quoteFingerprintSchema,
}).strict().superRefine((value, context) => {
  if (value.sourceKind === "wallet" && value.storeCard) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["storeCard"], message: "wallet sources cannot be vaulted" });
  }
});

export type AccountPaymentFundingSelectionV4 = z.infer<typeof accountPaymentFundingSelectionV4Schema>;

/** States whose provider outcome or canonical finalization can still affect
 * account credit. A hard decline with no captured provider payment is
 * conclusive and must not hold up a later checkout. */
export function isAccountFundingOperationUnresolvedV4(input: {
  status: string;
  errorClassification: string | null;
  providerObjectId: string | null;
  dispatchClaimedAt?: string | null;
  attemptCount?: number;
}): boolean {
  if (["pending", "leased", "retry_scheduled", "provider_unknown", "reconciliation_required"].includes(input.status)) return true;
  if (input.status === "action_required") {
    return input.providerObjectId !== null || input.errorClassification !== "hard_decline";
  }
  if (input.status === "failed_terminal") {
    if (input.providerObjectId !== null) return true;
    if (["hard_decline", "invalid_request", "configuration"].includes(input.errorClassification ?? "")) return false;
    if (input.dispatchClaimedAt != null) return true;
    return input.errorClassification !== "internal";
  }
  if (input.status === "canceled") {
    // A retry/unknown operation may be canceled after a provider attempt.
    // Cancellation erases the prior error classification, so retain a hold
    // whenever the durable attempt or dispatch identity leaves ambiguity.
    return input.providerObjectId !== null || input.dispatchClaimedAt != null || (input.attemptCount ?? 0) > 0;
  }
  return false;
}
export type AccountPaymentFundingParticipantV4 = z.infer<typeof accountPaymentFundingParticipantV4Schema>;
export type AccountPaymentParticipantsResponseV4 = z.infer<typeof accountPaymentParticipantsResponseV4Schema>;
export type AccountPaymentFundingRecipientSelectionV4 = z.infer<typeof accountPaymentFundingQuoteRequestV4Schema>["recipients"][number];
export type AccountPaymentFundingQuoteRecipientResponseV4 = z.infer<typeof accountPaymentFundingQuoteRecipientResponseV4Schema>;
export type AccountPaymentFundingQuoteRequestV4 = z.infer<typeof accountPaymentFundingQuoteRequestV4Schema>;
export type AccountPaymentFundingQuoteResponseV4 = z.infer<typeof accountPaymentFundingQuoteResponseV4Schema>;
export type AccountPaymentFundingChargeRequestV4 = z.infer<typeof accountPaymentFundingChargeRequestV4Schema>;
