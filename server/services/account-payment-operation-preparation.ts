import type { PaymentOperation } from "@shared/schema";
import { db } from "../db.js";
import { lockLeagueSchedule } from "../storage/league-schedule-lock.js";
import {
  createOrGetGeneralInteractivePaymentOperation,
  persistAccountPaymentOperationSnapshot,
  type PaymentOperationTransaction,
} from "../storage/payment-operations.js";
import type { AccountPaymentOperationSnapshotInput } from "./account-payment-operation-snapshot.js";

export type AccountPaymentOperationPreparationInput = Omit<
  AccountPaymentOperationSnapshotInput,
  "operationId" | "providerIdempotencyKey"
> & {
  requestKey: string;
  now?: Date;
};

/** Prepare one immutable V4 provider operation and its recipient funding
 * partition atomically. No future obligation identity is reserved here. */
export async function prepareAccountPaymentOperation(
  input: AccountPaymentOperationPreparationInput,
  existingTransaction?: PaymentOperationTransaction,
): Promise<PaymentOperation> {
  const run = async (tx: PaymentOperationTransaction) => {
    if (!existingTransaction) await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    const operation = await createOrGetGeneralInteractivePaymentOperation({
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      requestKey: input.requestKey,
      amountMinor: input.amountMinor,
      currency: input.currency,
      providerName: input.providerName,
      authorizingUserId: input.authorizingUserId,
      now: input.now,
    }, tx);
    if (operation.leagueId !== input.leagueId) throw new Error("account funding operation belongs to another league");
    await persistAccountPaymentOperationSnapshot(operation, {
      ...input,
      operationId: operation.id,
      providerIdempotencyKey: operation.providerIdempotencyKey,
    }, tx);
    return operation;
  };
  return existingTransaction ? run(existingTransaction) : db.transaction(run);
}
