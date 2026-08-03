import { db } from "../db.js";
import { storage } from "../storage/index.js";
import type { PaymentOperationTransaction } from "../storage/payment-operations.js";
import {
  buildSquarePaymentRequestIdentity,
} from "./payment-operation-idempotency.js";
import { INTERACTIVE_PAYMENT_SNAPSHOT_VERSION, type PaymentOperation } from "@shared/schema";
import type { InteractivePaymentSemanticSnapshot } from "./interactive-payment-operation-snapshot.js";

export interface InteractivePaymentAllocationInput {
  allocationIndex: number;
  bowlerId: number;
  amountMinor: number;
  lineageAmountMinor: number | null;
  prizeFundAmountMinor: number | null;
  weekOf: string;
  notes: string | null;
  paidByUserId: number | null;
}

export interface InteractivePaymentOperationPreparationInput {
  organizationId: number;
  requestKey: string;
  amountMinor: number;
  currency: string;
  providerName: string;
  leagueId: number;
  locationId: number | null;
  providerLocationId: string | null;
  payerBowlerId: number;
  requestKind: "direct" | "order";
  sourceId: string;
  customerId: string | null;
  buyerEmail: string | null;
  storeCard: boolean;
  weekOf: string;
  combined: boolean;
  now?: Date;
  allocations: InteractivePaymentAllocationInput[];
  lineItems: Array<{
    lineItemIndex: number;
    catalogObjectId: string;
    quantity: string;
  }>;
}

export function buildInteractivePaymentSnapshot(
  operation: PaymentOperation,
  input: Omit<InteractivePaymentOperationPreparationInput, "organizationId" | "requestKey" | "amountMinor" | "currency" | "providerName" | "now">,
): InteractivePaymentSemanticSnapshot {
  const squareIdentity = buildSquarePaymentRequestIdentity({
    providerIdempotencyKey: operation.providerIdempotencyKey,
    requestKind: input.requestKind,
    providerLocationId: input.providerLocationId,
  });
  return {
    snapshotVersion: INTERACTIVE_PAYMENT_SNAPSHOT_VERSION,
    organizationId: operation.organizationId,
    amountMinor: operation.amountMinor,
    currency: operation.currency,
    providerName: operation.providerName,
    leagueId: input.leagueId,
    locationId: input.locationId,
    providerLocationId: input.providerLocationId,
    payerBowlerId: input.payerBowlerId,
    requestKind: input.requestKind,
    squarePaymentIdempotencyKey: squareIdentity.paymentKey,
    squareOrderIdempotencyKey: squareIdentity.orderKey ?? null,
    sourceId: input.sourceId,
    customerId: input.customerId,
    buyerEmail: input.buyerEmail,
    storeCard: input.storeCard,
    weekOf: input.weekOf,
    combinedChargeGroupId: input.combined ? operation.id : null,
    allocations: input.allocations,
    lineItems: input.lineItems,
  };
}

export async function prepareInteractivePaymentOperation(
  input: InteractivePaymentOperationPreparationInput,
): Promise<PaymentOperation> {
  return db.transaction(async (tx: PaymentOperationTransaction) => {
    const operation = await storage.createOrGetGeneralInteractivePaymentOperation({
      organizationId: input.organizationId,
      requestKey: input.requestKey,
      amountMinor: input.amountMinor,
      currency: input.currency,
      providerName: input.providerName,
      now: input.now,
    }, tx);
    await storage.persistInteractivePaymentOperationSnapshot(
      operation,
      buildInteractivePaymentSnapshot(operation, input),
      tx,
    );
    return operation;
  });
}
