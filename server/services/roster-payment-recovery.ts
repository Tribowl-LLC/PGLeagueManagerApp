import { and, eq } from "drizzle-orm";
import { db } from "../db.js";
import { paymentOperations, paymentOperationRosterSnapshots } from "@shared/schema";
import { lockLeagueSchedule } from "../storage/league-schedule-lock.js";
import {
  finalizeRosterSnapshotInTransaction,
  isRosterSnapshotFinalizationError,
} from "./roster-payment-finalizer.js";

export class RosterPaymentRecoveryError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 409) {
    super(message);
    this.name = "RosterPaymentRecoveryError";
  }
}

/** Recover roster allocations by durable operation identity. This path does
 * not require the original idempotency/source token and never calls a
 * provider; it only replays immutable provider evidence already in the
 * operation ledger. */
export async function recoverRosterPaymentOperation(input: {
  organizationId: number;
  leagueId: number;
  operationId: string;
  actorUserId: number;
}) {
  return db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    const [operation] = await tx.select().from(paymentOperations).where(and(
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.leagueId, input.leagueId),
      eq(paymentOperations.id, input.operationId),
      eq(paymentOperations.operationType, "interactive_charge"),
    )).limit(1).for("update");
    if (!operation) throw new RosterPaymentRecoveryError("NOT_FOUND", "Payment operation not found", 404);
    const [snapshot] = await tx.select({ operationId: paymentOperationRosterSnapshots.operationId }).from(paymentOperationRosterSnapshots).where(and(
      eq(paymentOperationRosterSnapshots.operationId, operation.id),
      eq(paymentOperationRosterSnapshots.organizationId, input.organizationId),
      eq(paymentOperationRosterSnapshots.leagueId, input.leagueId),
    )).limit(1).for("share");
    if (!snapshot) throw new RosterPaymentRecoveryError("NOT_ROSTER_OPERATION", "Only roster-backed payment operations can use this recovery path", 409);
    if (!operation.providerObjectId) throw new RosterPaymentRecoveryError("PROVIDER_EVIDENCE_PENDING", "Provider evidence is not available for recovery", 409);
    if (operation.status !== "succeeded" && operation.status !== "reconciliation_required") {
      throw new RosterPaymentRecoveryError("OPERATION_NOT_RECOVERABLE", "Payment operation is not ready for roster recovery", 409);
    }
    const now = new Date().toISOString();
    try {
      const finalization = await tx.transaction(async (finalizerTx) => finalizeRosterSnapshotInTransaction(finalizerTx, {
          organizationId: input.organizationId,
          leagueId: input.leagueId,
          operationId: operation.id,
          now,
          actorUserId: operation.authorizingUserId ?? input.actorUserId,
        }));
      if (!finalization.finalized) throw new RosterPaymentRecoveryError("ROSTER_FINALIZATION_NOT_CONFIRMED", "Roster payment finalization was not confirmed", 409);
    } catch (error) {
      if (!isRosterSnapshotFinalizationError(error)) throw error;
      const [reviewed] = await tx.update(paymentOperations).set({
        status: "reconciliation_required",
        nextAttemptAt: null,
        errorClassification: "internal",
        errorCode: error.code,
        updatedAt: now,
      }).where(and(
        eq(paymentOperations.organizationId, input.organizationId),
        eq(paymentOperations.id, operation.id),
      )).returning();
      return reviewed ?? operation;
    }
    if (operation.status === "reconciliation_required") {
      const [settled] = await tx.update(paymentOperations).set({
        status: "succeeded",
        nextAttemptAt: null,
        errorClassification: null,
        errorCode: null,
        completedAt: now,
        updatedAt: now,
      }).where(and(
        eq(paymentOperations.organizationId, input.organizationId),
        eq(paymentOperations.id, operation.id),
        eq(paymentOperations.status, "reconciliation_required"),
      )).returning();
      return settled ?? operation;
    }
    return operation;
  });
}
