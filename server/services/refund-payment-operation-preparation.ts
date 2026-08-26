import { and, eq } from "drizzle-orm";
import {
  REFUND_PAYMENT_SNAPSHOT_VERSION,
  bowlers,
  leagues,
  locations,
  paymentOperations,
  payments,
  users,
} from "@shared/schema";
import { isCardPaymentType } from "@shared/schema/constants";
import { db } from "../db.js";
import {
  createOrGetRefundPaymentOperation,
  persistRefundPaymentOperationSnapshot,
  REFUND_TARGET_PREFIX,
  type PaymentOperationTransaction,
} from "../storage/payment-operations.js";
import type { RefundPaymentSemanticSnapshot } from "./refund-payment-operation-snapshot.js";

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
  reason?: unknown;
  requestedByUserId: number;
  requestedByRole: "org_admin" | "system_admin";
  requestedByOrganizationId: number | null;
  now?: Date;
}

export async function prepareRefundPaymentOperation(input: PrepareRefundPaymentOperationInput) {
  return db.transaction(async (tx: PaymentOperationTransaction) => {
    const [owned] = await tx.select({ payment: payments, league: leagues })
      .from(payments)
      .innerJoin(leagues, eq(leagues.id, payments.leagueId))
      .where(eq(payments.id, input.paymentId))
      .limit(1)
      .for("update");
    if (!owned) throw new RefundPreparationError("Payment not found", 404, "NOT_FOUND");
    const organizationId = owned.league.organizationId;
    const locationId = owned.league.locationId;
    if (organizationId === null) throw new RefundPreparationError("You don't have access to refund this payment", 403, "FORBIDDEN");
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
    // Refund preparation is a new product mutation.  Once canonical league
    // authority is inactive or retired, reject before creating or replaying
    // any operation; retained provider/webhook evidence has its own durable
    // reconciliation paths and is never a reason to re-enable refunds.
    if (owned.league.active !== true || owned.league.scheduleAuthority !== "canonical") {
      throw new RefundPreparationError("Archived leagues are read-only", 409, "LEAGUE_ARCHIVED_READ_ONLY");
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
    };
    const storedSnapshot = await persistRefundPaymentOperationSnapshot(operation, snapshot, tx);
    return { operation, snapshot: storedSnapshot };
  });
}
