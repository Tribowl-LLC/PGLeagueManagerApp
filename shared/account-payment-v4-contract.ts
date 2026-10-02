import { z } from "zod";

export const ACCOUNT_PAYMENT_FUNDING_QUOTE_CONTRACT_V4 = "account-payment-funding-quote/4" as const;
export const ACCOUNT_PAYMENT_FUNDING_CHARGE_CONTRACT_V4 = "account-payment-funding-charge/4" as const;
export const ACCOUNT_PAYMENT_FUNDING_QUOTE_FINGERPRINT_PREFIX_V4 = "lvaccountfundquote:v4:" as const;

const amountMinorSchema = z.number().int().min(0).max(2_147_483_647);
const positiveAmountMinorSchema = z.number().int().positive().max(2_147_483_647);
const payerBowlerIdSchema = z.number().int().positive().max(2_147_483_647);
const idempotencyKeySchema = z.string().trim().min(16).max(109).regex(/^[A-Za-z0-9_-]+$/);
const quoteFingerprintSchema = z.string().regex(/^lvaccountfundquote:v4:[0-9a-f]{64}$/);

/**
 * Each selected recipient gets an immutable portion of the one combined
 * receipt. A preset can target that recipient's confirmed debt or current
 * aggregate forecast target; an explicit amount is the exact new receipt
 * portion and must never be reduced by existing credit.
 */
export const accountPaymentFundingSelectionV4Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("explicit_amount"), amountMinor: positiveAmountMinorSchema }).strict(),
  z.object({ kind: z.literal("confirmed_debt_balance") }).strict(),
  z.object({ kind: z.literal("forecast_collection_target") }).strict(),
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
  forecastCollectionTargetMinor: number;
}): number {
  const confirmedDebtMinor = amountMinorSchema.parse(input.confirmedDebtMinor);
  const availableCreditMinor = amountMinorSchema.parse(input.availableCreditMinor);
  const forecastCollectionTargetMinor = amountMinorSchema.parse(input.forecastCollectionTargetMinor);
  const selection = accountPaymentFundingSelectionV4Schema.parse(input.selection);

  if (selection.kind === "explicit_amount") return selection.amountMinor;
  const targetMinor = selection.kind === "confirmed_debt_balance"
    ? confirmedDebtMinor
    : forecastCollectionTargetMinor;
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
export type AccountPaymentFundingRecipientSelectionV4 = z.infer<typeof accountPaymentFundingQuoteRequestV4Schema>["recipients"][number];
export type AccountPaymentFundingQuoteRecipientResponseV4 = z.infer<typeof accountPaymentFundingQuoteRecipientResponseV4Schema>;
export type AccountPaymentFundingQuoteRequestV4 = z.infer<typeof accountPaymentFundingQuoteRequestV4Schema>;
export type AccountPaymentFundingQuoteResponseV4 = z.infer<typeof accountPaymentFundingQuoteResponseV4Schema>;
export type AccountPaymentFundingChargeRequestV4 = z.infer<typeof accountPaymentFundingChargeRequestV4Schema>;
