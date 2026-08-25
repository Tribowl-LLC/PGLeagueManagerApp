import { db } from "../db.js";
import { storage } from "../storage/index.js";
import { PaymentOperationValidationError, type PaymentOperationTransaction } from "../storage/payment-operations.js";
import { fingerprintInteractiveOccurrenceIntent } from "./payment-operation-idempotency.js";
import {
  buildSquarePaymentRequestIdentity,
} from "./payment-operation-idempotency.js";
import {
  INTERACTIVE_PAYMENT_SNAPSHOT_VERSION,
  type InteractivePaymentSourceKind,
  type PaymentOperation,
} from "@shared/schema";
import type { InteractivePaymentSemanticSnapshot } from "./interactive-payment-operation-snapshot.js";
import { persistInteractiveOccurrenceSnapshot, type InteractiveOccurrenceSelection } from "./interactive-occurrence-allocation.js";
import { lockLeagueSchedule } from "../storage/league-schedule-lock.js";
import { paymentOperations } from "@shared/schema";
import { and, eq, isNull } from "drizzle-orm";

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
  authorizingUserId: number;
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
  sourceKind: InteractivePaymentSourceKind;
  weekOf: string;
  combined: boolean;
  now?: Date;
  allocations: InteractivePaymentAllocationInput[];
  lineItems: Array<{
    lineItemIndex: number;
    catalogObjectId: string;
    quantity: string;
  }>;
  occurrenceSelections?: InteractiveOccurrenceSelection[];
  occurrenceQuoteFingerprint?: string;
  transaction?: PaymentOperationTransaction;
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
    sourceKind: input.sourceKind,
    weekOf: input.weekOf,
    combinedChargeGroupId: input.combined ? operation.id : null,
    allocations: input.allocations,
    lineItems: input.lineItems,
  };
}

export async function prepareInteractivePaymentOperation(
  input: InteractivePaymentOperationPreparationInput,
): Promise<PaymentOperation> {
  if (input.occurrenceSelections !== undefined) {
    throw new PaymentOperationValidationError("occurrence-aware legacy payment selections are retired; use exact roster obligations");
  }
  if (input.occurrenceSelections !== undefined
    && input.providerName === "square"
    && !input.providerLocationId?.trim()) {
    throw new PaymentOperationValidationError("Square provider location is required for occurrence-aware interactive payments");
  }
  const run = async (tx: PaymentOperationTransaction) => {
    if (!input.transaction) await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    const operation = await storage.createOrGetGeneralInteractivePaymentOperation({
      organizationId: input.organizationId,
      requestKey: input.requestKey,
      amountMinor: input.amountMinor,
      currency: input.currency,
      providerName: input.providerName,
      authorizingUserId: input.authorizingUserId,
      immutableSemanticFingerprint: input.occurrenceSelections === undefined || !input.occurrenceQuoteFingerprint
        ? undefined
        : fingerprintInteractiveOccurrenceIntent({ selections: input.occurrenceSelections, quoteFingerprint: input.occurrenceQuoteFingerprint }),
      now: input.now,
    }, tx);
    if (operation.leagueId !== null && operation.leagueId !== input.leagueId) {
      throw new PaymentOperationValidationError("interactive operation belongs to another league");
    }
    let linkedOperation = operation;
    if (operation.leagueId === null) {
      const [updatedOperation] = await tx.update(paymentOperations).set({ leagueId: input.leagueId }).where(and(
        eq(paymentOperations.id, operation.id),
        eq(paymentOperations.organizationId, input.organizationId),
        isNull(paymentOperations.leagueId),
      )).returning();
      if (!updatedOperation) throw new PaymentOperationValidationError("interactive operation could not be linked to its league");
      linkedOperation = updatedOperation;
    }
    await storage.persistInteractivePaymentOperationSnapshot(
      linkedOperation,
      buildInteractivePaymentSnapshot(linkedOperation, input),
      tx,
    );
    if (input.occurrenceSelections !== undefined) {
      await persistInteractiveOccurrenceSnapshot(tx, operation, {
        leagueId: input.leagueId,
        selections: input.occurrenceSelections,
        quoteFingerprint: input.occurrenceQuoteFingerprint ?? "",
        baseAllocations: input.allocations.map((allocation) => ({
          bowlerId: allocation.bowlerId,
          amountMinor: allocation.amountMinor,
        })),
      });
    }
    return linkedOperation;
  };
  return input.transaction ? run(input.transaction) : db.transaction(run);
}
