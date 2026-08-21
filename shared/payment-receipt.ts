export const PAYMENT_RECEIPT_CONTRACT = "payment-receipt/1" as const;

export type PaymentReceiptAvailability = "available" | "unavailable";

export interface PaymentReceiptContract {
  contractVersion: typeof PAYMENT_RECEIPT_CONTRACT;
  availability: PaymentReceiptAvailability;
  receiptUrl: string | null;
  receiptNumber: string | null;
  // The database records whether an email was requested/missing, but it does
  // not contain a provider delivery receipt. Never infer that delivery
  // succeeded from a non-null hosted receipt URL.
  deliveryEvidence: "delivery_not_recorded";
}

export function paymentReceiptContract(input: {
  receiptUrl: string | null | undefined;
  receiptNumber: string | null | undefined;
}): PaymentReceiptContract {
  const receiptUrl = input.receiptUrl ?? null;
  return {
    contractVersion: PAYMENT_RECEIPT_CONTRACT,
    availability: receiptUrl ? "available" : "unavailable",
    receiptUrl,
    receiptNumber: input.receiptNumber ?? null,
    deliveryEvidence: "delivery_not_recorded",
  };
}
