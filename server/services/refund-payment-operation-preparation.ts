import { and, eq, inArray } from "drizzle-orm";
import {
  REFUND_PAYMENT_SNAPSHOT_VERSION,
  bowlers,
  leagues,
  locations,
  paymentOperations,
  paymentAllocations,
  paymentObligations,
  paymentOperationRosterSnapshotItems,
  payments,
  users,
} from "@shared/schema";
import { isCardPaymentType } from "@shared/schema/constants";
import { db } from "../db.js";
import { lockLeagueSchedule } from "../storage/league-schedule-lock.js";
import {
  createOrGetRefundPaymentOperation,
  persistRefundPaymentOperationSnapshot,
  REFUND_TARGET_PREFIX,
  type PaymentOperationTransaction,
} from "../storage/payment-operations.js";
import type { RefundPaymentSemanticSnapshot } from "./refund-payment-operation-snapshot.js";
import { REFUND_PAYMENT_DISPOSITIONS } from "@shared/schema";

export const DEFAULT_REFUND_REASON = "Refund processed via LeagueVault";

export class RefundPreparationError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "RefundPreparationError";
  }
}

function normalizeReason(value: unknown): { reason: string; requestedReason: string | null } {
  if (value == null || value === "") return { reason: DEFAULT_REFUND_REASON, requestedReason: null };
  if (typeof value !== "string") throw new RefundPreparationError("Refund reason must be text", 400, "VALIDATION_ERROR");
  const reason = value.trim();
  if (!reason) return { reason: DEFAULT_REFUND_REASON, requestedReason: null };
  if (reason.length > 192) throw new RefundPreparationError("Refund reason must be 192 characters or fewer", 400, "VALIDATION_ERROR");
  return { reason, requestedReason: reason };
}

export interface PrepareRefundPaymentOperationInput {
  paymentId: number;
  disposition: unknown;
  reason?: unknown;
  requestedByUserId: number;
  requestedByRole: "org_admin" | "system_admin";
  requestedByOrganizationId: number | null;
  now?: Date;
}

export async function prepareRefundPaymentOperation(input: PrepareRefundPaymentOperationInput) {
  return db.transaction(async (tx: PaymentOperationTransaction) => {
    // Resolve the tenant/league without taking a financial row lock first.
    // The schedule advisory lock is the canonical outer lock for every
    // operation that can change obligation evidence; re-read the payment
    // under that lock before locking allocations or reservations.
    let [owned] = await tx.select({ payment: payments, league: leagues })
      .from(payments)
      .innerJoin(leagues, eq(leagues.id, payments.leagueId))
      .where(eq(payments.id, input.paymentId))
      .limit(1);
    if (!owned) throw new RefundPreparationError("Payment not found", 404, "NOT_FOUND");
    const organizationId = owned.league.organizationId;
    const locationId = owned.league.locationId;
    if (organizationId === null) throw new RefundPreparationError("You don't have access to refund this payment", 403, "FORBIDDEN");
    await lockLeagueSchedule(tx, organizationId, owned.payment.leagueId);
    [owned] = await tx.select({ payment: payments, league: leagues })
      .from(payments)
      .innerJoin(leagues, eq(leagues.id, payments.leagueId))
      .where(and(
        eq(payments.id, input.paymentId),
        eq(payments.organizationId, organizationId),
        eq(leagues.organizationId, organizationId),
      ))
      .limit(1)
      .for("update");
    if (!owned) throw new RefundPreparationError("Payment not found", 404, "NOT_FOUND");
    if (input.requestedByRole === "org_admin" && input.requestedByOrganizationId !== organizationId) {
      throw new RefundPreparationError("You don't have access to refund this payment", 403, "FORBIDDEN");
    }
    const [actor] = await tx.select({
      id: users.id,
      role: users.role,
      organizationId: users.organizationId,
    }).from(users).where(eq(users.id, input.requestedByUserId)).limit(1);
    if (
      !actor
      || actor.role !== input.requestedByRole
      || (actor.role === "org_admin" && actor.organizationId !== organizationId)
    ) {
      throw new RefundPreparationError("You don't have access to refund this payment", 403, "FORBIDDEN");
    }
    const [ownedBowler] = await tx.select({ id: bowlers.id }).from(bowlers).where(and(
      eq(bowlers.id, owned.payment.bowlerId),
      eq(bowlers.organizationId, organizationId),
    )).limit(1);
    if (!ownedBowler) {
      throw new RefundPreparationError("You don't have access to refund this payment", 403, "FORBIDDEN");
    }
    if (locationId !== null) {
      const [ownedLocation] = await tx.select({ id: locations.id }).from(locations).where(and(
        eq(locations.id, locationId),
        eq(locations.organizationId, organizationId),
      )).limit(1);
      if (!ownedLocation) {
        throw new RefundPreparationError("You don't have access to refund this payment", 403, "FORBIDDEN");
      }
    }
    if (!isCardPaymentType(owned.payment.type)) {
      throw new RefundPreparationError("Only card payments can be refunded", 400, "INVALID_TYPE");
    }
    if (!owned.payment.providerPaymentId) {
      throw new RefundPreparationError("Payment has no provider charge to refund", 400, "INVALID_PROVIDER_PAYMENT");
    }
    if (typeof input.disposition !== "string" || !REFUND_PAYMENT_DISPOSITIONS.includes(input.disposition as typeof REFUND_PAYMENT_DISPOSITIONS[number])) {
      throw new RefundPreparationError("Choose whether the refunded amount is still owed or should be waived", 400, "DISPOSITION_REQUIRED");
    }
    const sourceAllocations = await tx.select({
      id: paymentAllocations.id,
      obligationId: paymentAllocations.obligationId,
      amountMinor: paymentAllocations.amountMinor,
      currency: paymentAllocations.currency,
      state: paymentAllocations.state,
      reviewRequired: paymentAllocations.reviewRequired,
    }).from(paymentAllocations).where(and(
      eq(paymentAllocations.organizationId, organizationId),
      eq(paymentAllocations.leagueId, owned.payment.leagueId),
      eq(paymentAllocations.paymentId, input.paymentId),
    )).orderBy(paymentAllocations.id).for("update");
    if (sourceAllocations.some((allocation) => allocation.state !== "active")) {
      throw new RefundPreparationError("This payment has voided allocation evidence and requires reconciliation before refunding", 409, "REFUND_ALLOCATION_STATE_CONFLICT");
    }
    if (sourceAllocations.some((allocation) => allocation.reviewRequired)) {
      throw new RefundPreparationError("This payment has allocation evidence requiring review before refunding", 409, "REFUND_ALLOCATION_REVIEW_REQUIRED");
    }
    if (sourceAllocations.length === 0 || sourceAllocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0) !== owned.payment.amount) {
      throw new RefundPreparationError("This payment's canonical allocation evidence does not match the full refund amount", 409, "REFUND_ALLOCATION_EVIDENCE_MISMATCH");
    }
    const sourceObligationIds = [...new Set(sourceAllocations.map((allocation) => allocation.obligationId))];
    if (sourceObligationIds.length > 0) {
      const sourceObligations = await tx.select({ id: paymentObligations.id, payerBowlerId: paymentObligations.payerBowlerId, occurrenceId: paymentObligations.occurrenceId }).from(paymentObligations).where(and(
        eq(paymentObligations.organizationId, organizationId),
        eq(paymentObligations.leagueId, owned.payment.leagueId),
        inArray(paymentObligations.id, sourceObligationIds),
      ));
      if (sourceObligations.length !== sourceObligationIds.length) {
        throw new RefundPreparationError("This payment's allocation evidence references a missing obligation", 409, "REFUND_ALLOCATION_EVIDENCE_MISMATCH");
      }
      const payerIds = [...new Set(sourceObligations.map((obligation) => obligation.payerBowlerId))];
      const occurrenceIds = [...new Set(sourceObligations.map((obligation) => obligation.occurrenceId))];
      const samePayerWeekObligations = await tx.select({ id: paymentObligations.id, payerBowlerId: paymentObligations.payerBowlerId, occurrenceId: paymentObligations.occurrenceId }).from(paymentObligations).where(and(
        eq(paymentObligations.organizationId, organizationId),
        eq(paymentObligations.leagueId, owned.payment.leagueId),
        inArray(paymentObligations.payerBowlerId, payerIds),
        inArray(paymentObligations.occurrenceId, occurrenceIds),
      ));
      const sourceKeys = new Set(sourceObligations.map((obligation) => `${obligation.payerBowlerId}:${obligation.occurrenceId}`));
      const affectedObligationIds = samePayerWeekObligations
        .filter((obligation) => sourceKeys.has(`${obligation.payerBowlerId}:${obligation.occurrenceId}`))
        .map((obligation) => obligation.id);
      const reservations = await tx.select({ id: paymentOperationRosterSnapshotItems.id }).from(paymentOperationRosterSnapshotItems).where(and(
        eq(paymentOperationRosterSnapshotItems.organizationId, organizationId),
        eq(paymentOperationRosterSnapshotItems.leagueId, owned.payment.leagueId),
        eq(paymentOperationRosterSnapshotItems.state, "reserved"),
        inArray(paymentOperationRosterSnapshotItems.obligationId, affectedObligationIds),
      )).limit(1).for("update");
      if (reservations.length > 0) {
        throw new RefundPreparationError("A payment operation is already collecting an affected obligation; retry the refund after it completes", 409, "REFUND_ALLOCATION_RESERVED");
      }
    }
    const [existing] = await tx.select().from(paymentOperations).where(and(
      eq(paymentOperations.organizationId, organizationId),
      eq(paymentOperations.operationType, "refund"),
      eq(paymentOperations.targetKey, `${REFUND_TARGET_PREFIX}${input.paymentId}`),
    )).limit(1);
    if (!existing) {
      if (owned.payment.status === "refunded") {
        throw new RefundPreparationError("Payment has already been refunded", 400, "ALREADY_REFUNDED");
      }
      if (owned.payment.status !== "paid") {
        throw new RefundPreparationError("Only paid payments can be refunded", 400, "INVALID_STATUS");
      }
    } else if (existing.status === "succeeded" && owned.payment.status !== "refunded") {
      throw new RefundPreparationError("Refund state requires reconciliation", 409, "REFUND_STATE_CONFLICT");
    } else if (existing.status !== "succeeded" && owned.payment.status !== "paid") {
      throw new RefundPreparationError("Refund state requires reconciliation", 409, "REFUND_STATE_CONFLICT");
    }
    if (locationId === null) {
      throw new RefundPreparationError(
        "Assign a location with Square configured before refunding this payment",
        422,
        "PROVIDER_NOT_CONFIGURED",
      );
    }

    const operation = await createOrGetRefundPaymentOperation({
      organizationId,
      leagueId: owned.payment.leagueId,
      paymentId: input.paymentId,
      amountMinor: owned.payment.amount,
      currency: "USD",
      providerName: "square",
      now: input.now,
    }, tx);
    const normalizedReason = normalizeReason(input.reason);
    const snapshot: RefundPaymentSemanticSnapshot = {
      snapshotVersion: REFUND_PAYMENT_SNAPSHOT_VERSION,
      organizationId,
      amountMinor: owned.payment.amount,
      currency: "USD",
      providerName: "square",
      paymentId: input.paymentId,
      leagueId: owned.payment.leagueId,
      locationId,
      providerPaymentId: owned.payment.providerPaymentId,
      reason: normalizedReason.reason,
      requestedReason: normalizedReason.requestedReason,
      requestedByUserId: input.requestedByUserId,
      requestedByRole: input.requestedByRole,
      requestedByOrganizationId: input.requestedByOrganizationId,
      disposition: input.disposition as typeof REFUND_PAYMENT_DISPOSITIONS[number],
      allocations: sourceAllocations.map((allocation) => ({
        allocationId: allocation.id,
        obligationId: allocation.obligationId,
        amountMinor: allocation.amountMinor,
        currency: allocation.currency as "USD",
      })),
    };
    const storedSnapshot = await persistRefundPaymentOperationSnapshot(operation, snapshot, tx);
    return { operation, snapshot: storedSnapshot };
  });
}
