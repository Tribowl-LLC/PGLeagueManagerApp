import { and, eq, inArray } from "drizzle-orm";
import { accountPaymentOperationSnapshots } from "@shared/schema/account-payment-operations";
import { isAccountFundingOperationUnresolvedV4 } from "@shared/account-payment-v4-contract";
import { paymentOperations } from "@shared/schema";
import {
  getAccountPaymentOperationSnapshotInTransaction,
  type PaymentOperationTransaction,
} from "../storage/payment-operations.js";

const ACCOUNT_FUNDING_UNRESOLVED_STATUSES = [
  "pending",
  "leased",
  "retry_scheduled",
  "provider_unknown",
  "reconciliation_required",
  "action_required",
  "failed_terminal",
  "canceled",
] as const;

/**
 * Detect an earlier provider tender that may still fund one of the selected
 * owners. Callers must hold the league schedule lock and must check durable
 * request-key replay before calling this helper. It intentionally creates no
 * obligation reservation and is suitable for interactive and future standing
 * preparation paths.
 */
export async function hasUnresolvedAccountFundingOverlapInTransaction(
  tx: PaymentOperationTransaction,
  input: {
    organizationId: number;
    leagueId: number;
    creditedBowlerIds: readonly number[];
    excludeOperationId?: string;
  },
): Promise<boolean> {
  const selectedOwners = new Set(input.creditedBowlerIds);
  if (selectedOwners.size === 0) return false;
  const operations = await tx.select({ operation: paymentOperations }).from(paymentOperations)
    .innerJoin(accountPaymentOperationSnapshots, and(
      eq(accountPaymentOperationSnapshots.operationId, paymentOperations.id),
      eq(accountPaymentOperationSnapshots.organizationId, paymentOperations.organizationId),
      eq(accountPaymentOperationSnapshots.leagueId, paymentOperations.leagueId),
    )).where(and(
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.leagueId, input.leagueId),
      eq(paymentOperations.operationType, "interactive_charge"),
      inArray(paymentOperations.status, [...ACCOUNT_FUNDING_UNRESOLVED_STATUSES]),
    ));

  for (const { operation } of operations) {
    if (operation.id === input.excludeOperationId || !isAccountFundingOperationUnresolvedV4({
      status: operation.status,
      errorClassification: operation.errorClassification,
      providerObjectId: operation.providerObjectId,
      dispatchClaimedAt: operation.dispatchClaimedAt,
      attemptCount: operation.attemptCount,
    })) continue;
    try {
      const snapshot = await getAccountPaymentOperationSnapshotInTransaction(tx, operation);
      // A malformed immutable record cannot safely prove that a recipient is
      // disjoint from the new charge, so fail closed without exposing details.
      if (!snapshot) return true;
      if (snapshot.fundingPortions.some((portion) => portion.amountMinor > 0 && selectedOwners.has(portion.creditedBowlerId))) {
        return true;
      }
    } catch {
      return true;
    }
  }
  return false;
}
