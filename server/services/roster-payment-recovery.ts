import { and, eq } from "drizzle-orm";
import { db } from "../db.js";
import { getGeneralInteractiveTargetKey } from "../storage/payment-operations.js";
import { paymentOperations, paymentOperationRosterSnapshots, accountPaymentOperationSnapshots } from "@shared/schema";
import { lockLeagueSchedule } from "../storage/league-schedule-lock.js";
import {
  finalizeRosterSnapshotInTransaction,
  isRosterSnapshotFinalizationError,
  RosterSnapshotFinalizationError,
  validateRosterSnapshotForDispatchInTransaction,
} from "./roster-payment-finalizer.js";

export class RosterPaymentRecoveryError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 409) {
    super(message);
    this.name = "RosterPaymentRecoveryError";
  }
}

/**
 * Recover one canonical interactive operation when the original charge
 * response was lost before the client received its durable operation ID.
 * The request key is looked up only inside the authenticated organization,
 * league, and authorizing-user scope. This path never accepts a source token
 * and never dispatches to the provider; it only delegates to the exact
 * operation-id finalizer after the immutable operation has been identified.
 */
export async function recoverRosterPaymentOperationByRequestKey(input: {
  organizationId: number;
  leagueId: number;
  requestKey: string;
  actorUserId: number;
}) {
  // Preparation holds this same league lock until the operation, snapshot,
  // and reservation commit. Looking up the request key inside a transaction
  // after acquiring the lock prevents a transport-loss recovery from seeing
  // a false 404 against preparation's pre-commit MVCC snapshot.
  const operation = await db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    const [candidate] = await tx.select().from(paymentOperations).where(and(
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.leagueId, input.leagueId),
      eq(paymentOperations.operationType, "interactive_charge"),
      eq(paymentOperations.authorizingUserId, input.actorUserId),
      eq(paymentOperations.targetKey, getGeneralInteractiveTargetKey(input.requestKey)),
    )).limit(1).for("share");
    return candidate;
  });
  if (!operation) {
    throw new RosterPaymentRecoveryError("NOT_FOUND", "Payment operation not found", 404);
  }
  // A request-key retry must report an operation that is still owned by the
  // ledger rather than attempting to recover it with a newly tokenized
  // source. There is no provider-free finalization to perform until provider
  // evidence exists. Terminal states are also returned unchanged so the
  // caller can clear or retain its browser intent from the durable state.
  if (operation.status !== "succeeded" && operation.status !== "reconciliation_required") {
    return operation;
  }
  return recoverRosterPaymentOperation({
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    operationId: operation.id,
    actorUserId: input.actorUserId,
  });
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
  now?: Date;
}) {
  const now = (input.now ?? new Date()).toISOString();
  return db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    const [operation] = await tx.select().from(paymentOperations).where(and(
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.leagueId, input.leagueId),
      eq(paymentOperations.id, input.operationId),
      eq(paymentOperations.operationType, "interactive_charge"),
    )).limit(1).for("update");
    if (!operation) {
      const [standing] = await tx.select().from(paymentOperations).where(and(
        eq(paymentOperations.organizationId, input.organizationId),
        eq(paymentOperations.leagueId, input.leagueId),
        eq(paymentOperations.id, input.operationId),
        eq(paymentOperations.operationType, "standing_autopay_charge"),
      )).limit(1).for("update");
      if (standing) {
        // Standing V2/V3 reservations and V5 account funding share provider
        // recovery but retain distinct immutable snapshot families.
        const [standingSnapshot, standingAccountSnapshot] = await Promise.all([
          tx.select({ operationId: paymentOperationRosterSnapshots.operationId }).from(paymentOperationRosterSnapshots).where(and(
          eq(paymentOperationRosterSnapshots.operationId, standing.id),
          eq(paymentOperationRosterSnapshots.organizationId, input.organizationId),
          eq(paymentOperationRosterSnapshots.leagueId, input.leagueId),
          )).limit(1).for("share"),
          tx.select().from(accountPaymentOperationSnapshots).where(and(
            eq(accountPaymentOperationSnapshots.operationId, standing.id),
            eq(accountPaymentOperationSnapshots.organizationId, input.organizationId),
            eq(accountPaymentOperationSnapshots.leagueId, input.leagueId),
          )).limit(1).for("share"),
        ]);
        const isStandingAccountFunding = standingAccountSnapshot.length === 1
          && standingAccountSnapshot[0]?.snapshotKind === "standing_funding";
        if ((standingSnapshot.length > 0 && standingAccountSnapshot.length > 0)
          || (standingSnapshot.length === 0 && !isStandingAccountFunding)) {
          throw new RosterPaymentRecoveryError("NOT_ROSTER_OPERATION", "Only supported roster or account standing operations can use this recovery path", 409);
        }
        const standingProviderObjectId = standing.providerObjectId;
        if (!standingProviderObjectId) throw new RosterPaymentRecoveryError("PROVIDER_EVIDENCE_PENDING", "Provider evidence is not available for recovery", 409);
        if (standing.status !== "succeeded" && standing.status !== "reconciliation_required") throw new RosterPaymentRecoveryError("OPERATION_NOT_RECOVERABLE", "Payment operation is not ready for roster recovery", 409);
        try {
          const finalization = await tx.transaction(async (finalizerTx) => {
            if (isStandingAccountFunding) {
              const dispatchable = await validateRosterSnapshotForDispatchInTransaction(finalizerTx, {
                organizationId: input.organizationId,
                leagueId: input.leagueId,
                operationId: standing.id,
              });
              if (!dispatchable) throw new RosterSnapshotFinalizationError("SNAPSHOT_INVALID", "The standing account funding snapshot is unavailable");
              if (standing.status === "reconciliation_required") {
                const [restored] = await finalizerTx.update(paymentOperations).set({
                  status: "succeeded",
                  nextAttemptAt: null,
                  errorClassification: null,
                  errorCode: null,
                  completedAt: standing.completedAt ?? now,
                  updatedAt: now,
                }).where(and(
                  eq(paymentOperations.organizationId, input.organizationId),
                  eq(paymentOperations.leagueId, input.leagueId),
                  eq(paymentOperations.id, standing.id),
                  eq(paymentOperations.status, "reconciliation_required"),
                  eq(paymentOperations.providerObjectId, standingProviderObjectId),
                )).returning({ id: paymentOperations.id });
                if (!restored) throw new RosterSnapshotFinalizationError("OPERATION_CHANGED", "Payment operation changed during recovery");
              }
            }
            const finalized = await finalizeRosterSnapshotInTransaction(finalizerTx, {
              organizationId: input.organizationId,
              leagueId: input.leagueId,
              operationId: standing.id,
              now,
              actorUserId: isStandingAccountFunding ? input.actorUserId : standing.authorizingUserId ?? input.actorUserId,
            });
            if (finalized.finalized && !isStandingAccountFunding && standing.status === "reconciliation_required") {
              const [restored] = await finalizerTx.update(paymentOperations).set({ status: "succeeded", nextAttemptAt: null, errorClassification: null, errorCode: null, completedAt: standing.completedAt ?? now, updatedAt: now }).where(and(
                eq(paymentOperations.organizationId, input.organizationId),
                eq(paymentOperations.leagueId, input.leagueId),
                eq(paymentOperations.id, standing.id),
                eq(paymentOperations.status, "reconciliation_required"),
                eq(paymentOperations.providerObjectId, standingProviderObjectId),
              )).returning({ id: paymentOperations.id });
              if (!restored) throw new RosterSnapshotFinalizationError("OPERATION_CHANGED", "Payment operation changed during recovery");
            }
            return finalized;
          });
          if (!finalization.finalized) throw new RosterPaymentRecoveryError("ROSTER_FINALIZATION_NOT_CONFIRMED", "Roster payment finalization was not confirmed", 409);
        } catch (error) {
          if (!isRosterSnapshotFinalizationError(error)) throw error;
          const [reconciliationRequired] = await tx.update(paymentOperations).set({ status: "reconciliation_required", nextAttemptAt: null, errorClassification: "internal", errorCode: error.code, updatedAt: now }).where(and(
            eq(paymentOperations.organizationId, input.organizationId),
            eq(paymentOperations.leagueId, input.leagueId),
            eq(paymentOperations.id, standing.id),
          )).returning();
          return reconciliationRequired ?? standing;
        }
        const [recoveredStanding] = await tx.select().from(paymentOperations).where(and(
          eq(paymentOperations.organizationId, input.organizationId),
          eq(paymentOperations.leagueId, input.leagueId),
          eq(paymentOperations.id, standing.id),
        )).limit(1);
        return recoveredStanding ?? standing;
      }
      throw new RosterPaymentRecoveryError("NOT_FOUND", "Payment operation not found", 404);
    }
    const [snapshot, accountSnapshot] = await Promise.all([
      tx.select({ operationId: paymentOperationRosterSnapshots.operationId }).from(paymentOperationRosterSnapshots).where(and(
        eq(paymentOperationRosterSnapshots.operationId, operation.id),
        eq(paymentOperationRosterSnapshots.organizationId, input.organizationId),
        eq(paymentOperationRosterSnapshots.leagueId, input.leagueId),
      )).limit(1).for("share"),
      tx.select({ operationId: accountPaymentOperationSnapshots.operationId }).from(accountPaymentOperationSnapshots).where(and(
        eq(accountPaymentOperationSnapshots.operationId, operation.id),
        eq(accountPaymentOperationSnapshots.organizationId, input.organizationId),
        eq(accountPaymentOperationSnapshots.leagueId, input.leagueId),
      )).limit(1).for("share"),
    ]);
    const isAccountFunding = accountSnapshot.length > 0;
    if (isAccountFunding && snapshot.length > 0) {
      throw new RosterPaymentRecoveryError("SNAPSHOT_INVALID", "Payment operation has conflicting immutable snapshots", 409);
    }
    if (snapshot.length === 0 && !isAccountFunding) {
      throw new RosterPaymentRecoveryError("NOT_ROSTER_OPERATION", "Only roster-backed payment operations can use this recovery path", 409);
    }
    if (!operation.providerObjectId) throw new RosterPaymentRecoveryError("PROVIDER_EVIDENCE_PENDING", "Provider evidence is not available for recovery", 409);
    const providerObjectId = operation.providerObjectId;
    if (operation.status !== "succeeded" && operation.status !== "reconciliation_required") {
      throw new RosterPaymentRecoveryError("OPERATION_NOT_RECOVERABLE", "Payment operation is not ready for roster recovery", 409);
    }
    try {
      const finalization = await tx.transaction(async (finalizerTx) => {
        if (isAccountFunding) {
          const dispatchable = await validateRosterSnapshotForDispatchInTransaction(finalizerTx, {
            organizationId: input.organizationId,
            leagueId: input.leagueId,
            operationId: operation.id,
          });
          if (!dispatchable) throw new RosterSnapshotFinalizationError("SNAPSHOT_INVALID", "The account funding snapshot is unavailable");
          if (operation.status === "reconciliation_required") {
            const [restored] = await finalizerTx.update(paymentOperations).set({
              status: "succeeded",
              nextAttemptAt: null,
              errorClassification: null,
              errorCode: null,
              completedAt: operation.completedAt ?? now,
              updatedAt: now,
            }).where(and(
              eq(paymentOperations.organizationId, input.organizationId),
              eq(paymentOperations.leagueId, input.leagueId),
              eq(paymentOperations.id, operation.id),
              eq(paymentOperations.status, "reconciliation_required"),
              eq(paymentOperations.providerObjectId, providerObjectId),
            )).returning({ id: paymentOperations.id });
            if (!restored) throw new RosterSnapshotFinalizationError("OPERATION_CHANGED", "Payment operation changed during recovery");
          }
        }
        const finalized = await finalizeRosterSnapshotInTransaction(finalizerTx, {
          organizationId: input.organizationId,
          leagueId: input.leagueId,
          operationId: operation.id,
          now,
          actorUserId: isAccountFunding ? input.actorUserId : operation.authorizingUserId ?? input.actorUserId,
        });
        // Retain the historical V2/V3 recovery transition. V4 must transition
        // before funding writes because the owned ledger accepts only succeeded
        // provider operations; both remain inside this finalization savepoint.
        if (finalized.finalized && !isAccountFunding && operation.status === "reconciliation_required") {
          const [restored] = await finalizerTx.update(paymentOperations).set({
            status: "succeeded",
            nextAttemptAt: null,
            errorClassification: null,
            errorCode: null,
            completedAt: operation.completedAt ?? now,
            updatedAt: now,
          }).where(and(
            eq(paymentOperations.organizationId, input.organizationId),
            eq(paymentOperations.leagueId, input.leagueId),
            eq(paymentOperations.id, operation.id),
            eq(paymentOperations.status, "reconciliation_required"),
            eq(paymentOperations.providerObjectId, providerObjectId),
          )).returning({ id: paymentOperations.id });
          if (!restored) throw new RosterSnapshotFinalizationError("OPERATION_CHANGED", "Payment operation changed during recovery");
        }
        return finalized;
      });
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
    const [recovered] = await tx.select().from(paymentOperations).where(and(
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.leagueId, input.leagueId),
      eq(paymentOperations.id, operation.id),
    )).limit(1);
    return recovered ?? operation;
  });
}
