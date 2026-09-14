import { db } from "../db.js";
import { storage } from "../storage/index.js";
import { PaymentOperationValidationError, type PaymentOperationTransaction } from "../storage/payment-operations.js";
import {
  buildSquarePaymentRequestIdentity,
} from "./payment-operation-idempotency.js";
import {
  ROSTER_OPERATION_SNAPSHOT_VERSION,
  type RosterOperationSourceKind,
  type PaymentOperation,
} from "@shared/schema";
import type { RosterOperationSemanticSnapshot } from "./roster-operation-snapshot.js";
import { lockLeagueSchedule } from "../storage/league-schedule-lock.js";
import { persistInteractivePartnerOperationSnapshot } from "../storage/payment-operations.js";
import type { InteractivePartnerPaymentSnapshot } from "./interactive-partner-payment-snapshot.js";

export interface InteractivePaymentAllocationInput {
  allocationIndex: number;
  bowlerId: number;
  amountMinor: number;
  notes: string | null;
  paidByUserId: number | null;
  obligationId: string;
  responsibilityId: string;
  responsibilityVersion: number;
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
  sourceKind: RosterOperationSourceKind;
  now?: Date;
  allocations: InteractivePaymentAllocationInput[];
  lineItems: Array<{
    lineItemIndex: number;
    catalogObjectId: string;
    quantity: string;
  }>;
  quoteFingerprint: string;
  transaction?: PaymentOperationTransaction;
}

export function buildInteractivePaymentSnapshot(
  operation: PaymentOperation,
  input: Omit<InteractivePaymentOperationPreparationInput, "organizationId" | "requestKey" | "amountMinor" | "currency" | "providerName" | "now">,
): RosterOperationSemanticSnapshot {
  const squareIdentity = buildSquarePaymentRequestIdentity({
    providerIdempotencyKey: operation.providerIdempotencyKey,
    requestKind: input.requestKind,
    providerLocationId: input.providerLocationId,
  });
  return {
    snapshotVersion: ROSTER_OPERATION_SNAPSHOT_VERSION,
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
    quoteFingerprint: input.quoteFingerprint,
    allocations: input.allocations,
    lineItems: input.lineItems,
  };
}

export async function prepareInteractivePaymentOperation(
  input: InteractivePaymentOperationPreparationInput,
): Promise<PaymentOperation> {
  if (input.providerName === "square" && input.requestKind === "order" && !input.providerLocationId?.trim()) {
    throw new PaymentOperationValidationError("Square provider location is required for occurrence-aware interactive payments");
  }
  const run = async (tx: PaymentOperationTransaction) => {
    if (!input.transaction) await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    const operation = await storage.createOrGetGeneralInteractivePaymentOperation({
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      requestKey: input.requestKey,
      amountMinor: input.amountMinor,
      currency: input.currency,
      providerName: input.providerName,
      authorizingUserId: input.authorizingUserId,
      now: input.now,
    }, tx);
    if (operation.leagueId !== input.leagueId) {
      throw new PaymentOperationValidationError("interactive operation belongs to another league");
    }
    await storage.persistRosterOperationSnapshot(
      operation,
      buildInteractivePaymentSnapshot(operation, input),
      tx,
    );
    return operation;
  };
  return input.transaction ? run(input.transaction) : db.transaction(run);
}

/** v3 partner preparation intentionally has its own writer. This prevents a
 * future change to the v2 codec from silently changing standing or legacy
 * interactive recovery semantics. */
export async function prepareInteractivePartnerPaymentOperation(input: {
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
  sourceId: string;
  customerId: string | null;
  buyerEmail: string | null;
  storeCard: boolean;
  sourceKind: RosterOperationSourceKind;
  allocations: InteractivePaymentAllocationInput[];
  partnerEvidence: InteractivePartnerPaymentSnapshot["partnerEvidence"];
  quoteFingerprint: string;
  now?: Date;
  transaction?: PaymentOperationTransaction;
}): Promise<PaymentOperation> {
  const run = async (tx: PaymentOperationTransaction) => {
    if (!input.transaction) await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    const operation = await storage.createOrGetGeneralInteractivePaymentOperation({
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      requestKey: input.requestKey,
      amountMinor: input.amountMinor,
      currency: input.currency,
      providerName: input.providerName,
      authorizingUserId: input.authorizingUserId,
      now: input.now,
    }, tx);
    if (operation.leagueId !== input.leagueId) throw new PaymentOperationValidationError("interactive operation belongs to another league");
    const snapshot: InteractivePartnerPaymentSnapshot = {
      snapshotVersion: 3,
      organizationId: operation.organizationId,
      amountMinor: operation.amountMinor,
      currency: operation.currency,
      providerName: operation.providerName,
      leagueId: input.leagueId,
      locationId: input.locationId,
      providerLocationId: input.providerLocationId,
      payerBowlerId: input.payerBowlerId,
      requestKind: "direct",
      squarePaymentIdempotencyKey: buildSquarePaymentRequestIdentity({ providerIdempotencyKey: operation.providerIdempotencyKey, requestKind: "direct", providerLocationId: null }).paymentKey,
      squareOrderIdempotencyKey: null,
      sourceId: input.sourceId,
      customerId: input.customerId,
      buyerEmail: input.buyerEmail,
      storeCard: input.storeCard,
      sourceKind: input.sourceKind,
      quoteFingerprint: input.quoteFingerprint,
      allocations: input.allocations,
      lineItems: [],
      partnerEvidence: input.partnerEvidence,
    };
    await persistInteractivePartnerOperationSnapshot(operation, snapshot, tx);
    return operation;
  };
  return input.transaction ? run(input.transaction) : db.transaction(run);
}
