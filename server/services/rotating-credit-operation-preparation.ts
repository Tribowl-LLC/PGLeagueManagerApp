import { createHash } from "node:crypto";
import { db } from "../db.js";
import { PaymentOperationImmutableMismatchError, createOrGetInteractivePaymentOperation, persistRotatingCreditPaymentOperationSnapshot, type PaymentOperationTransaction } from "../storage/payment-operations.js";
import { lockLeagueSchedule } from "../storage/league-schedule-lock.js";
import { canonicalizePaymentOperationInput } from "./payment-operation-idempotency.js";
import type { RotatingCreditOperationSnapshotInput } from "./rotating-credit-operation-snapshot.js";

export function getRotatingCreditOperationTargetKey(input: {
  leagueId: number;
  bowlerId: number;
  idempotencyKey: string;
}): string {
  const digest = createHash("sha256").update(canonicalizePaymentOperationInput({
    contract: "rotating-credit-operation-target/1",
    leagueId: input.leagueId,
    bowlerId: input.bowlerId,
    idempotencyKey: input.idempotencyKey,
  })).digest("hex");
  return `interactive-charge:rotating-credit:${digest}`;
}

export async function prepareRotatingCreditPaymentOperation(
  input: Omit<RotatingCreditOperationSnapshotInput, "snapshotVersion"> & {
    authorizingUserId: number;
    now?: Date;
    transaction?: PaymentOperationTransaction;
  },
) {
  const run = async (tx: PaymentOperationTransaction) => {
    if (!input.transaction) await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    const operation = await createOrGetInteractivePaymentOperation({
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      targetKey: getRotatingCreditOperationTargetKey(input),
      amountMinor: input.amountMinor,
      currency: input.currency,
      providerName: input.providerName,
      authorizingUserId: input.authorizingUserId,
      now: input.now,
    }, tx);
    if (operation.leagueId !== input.leagueId || operation.authorizingUserId !== input.authorizingUserId) {
      throw new PaymentOperationImmutableMismatchError();
    }
    await persistRotatingCreditPaymentOperationSnapshot(operation, {
      snapshotVersion: 1,
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      bowlerId: input.bowlerId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      shareCount: input.shareCount,
      providerName: input.providerName,
      locationId: input.locationId,
      providerLocationId: input.providerLocationId,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      customerId: input.customerId,
      buyerEmail: input.buyerEmail,
      quoteFingerprint: input.quoteFingerprint,
      idempotencyKey: input.idempotencyKey,
    }, tx);
    return operation;
  };
  return input.transaction ? run(input.transaction) : db.transaction(run);
}
