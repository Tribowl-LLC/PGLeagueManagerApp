import { and, asc, eq, inArray } from "drizzle-orm";
import {
  occurrencePaymentResponsibilities,
  paymentAllocations,
  paymentObligations,
  paymentOperationRosterSnapshots,
  paymentOperationRosterSnapshotItems,
  paymentOperations,
  payments,
} from "@shared/schema";
import type { PaymentOperationTransaction } from "../storage/payment-operations.js";

/**
 * Expected local evidence failures are durable reconciliation outcomes, not
 * provider failures. The caller must keep the immutable operation/payment
 * evidence and transition the operation to reconciliation_required.
 */
export class RosterSnapshotFinalizationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RosterSnapshotFinalizationError";
  }
}

export function isRosterSnapshotFinalizationError(error: unknown): error is RosterSnapshotFinalizationError {
  return error instanceof RosterSnapshotFinalizationError;
}

type SnapshotRecord = {
  id?: string;
  responsibilityId?: string;
  responsibilityVersion?: number;
  payerBowlerId?: number;
  amountMinor?: number;
  dueAt?: string;
  pastDueAt?: string;
};

/** Validate the same immutable reservation immediately before the provider
 * dispatch cutoff. This closes the roster-edit/cancel race before any money
 * movement can begin. */
export async function validateRosterSnapshotForDispatchInTransaction(
  tx: PaymentOperationTransaction,
  input: { organizationId: number; leagueId: number; operationId: string },
): Promise<boolean> {
  const [snapshot] = await tx.select().from(paymentOperationRosterSnapshots).where(and(
    eq(paymentOperationRosterSnapshots.operationId, input.operationId),
    eq(paymentOperationRosterSnapshots.organizationId, input.organizationId),
    eq(paymentOperationRosterSnapshots.leagueId, input.leagueId),
  )).limit(1).for("share");
  if (!snapshot) return false;
  const items = await tx.select().from(paymentOperationRosterSnapshotItems).where(and(
    eq(paymentOperationRosterSnapshotItems.operationId, input.operationId),
    eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId),
    eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId),
  )).orderBy(asc(paymentOperationRosterSnapshotItems.allocationIndex)).for("share");
  if (items.length === 0 || items.some((item) => item.state !== "reserved")) {
    throw new RosterSnapshotFinalizationError("RESERVATION_NOT_DISPATCHABLE", "The roster reservation is no longer dispatchable");
  }
  const total = items.reduce((sum, item) => sum + item.amountMinor, 0);
  if (total !== snapshot.amountMinor) {
    throw new RosterSnapshotFinalizationError("SNAPSHOT_AMOUNT_MISMATCH", "The roster snapshot amount is inconsistent");
  }
  const records = Array.isArray(snapshot.obligations) ? snapshot.obligations as SnapshotRecord[] : [];
  const responsibilityIds = [...new Set(records.map((record) => record.responsibilityId).filter((id): id is string => typeof id === "string"))];
  const responsibilities = await tx.select({
    id: occurrencePaymentResponsibilities.id,
    version: occurrencePaymentResponsibilities.version,
    state: occurrencePaymentResponsibilities.state,
  }).from(occurrencePaymentResponsibilities).where(and(
    eq(occurrencePaymentResponsibilities.organizationId, input.organizationId),
    eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
    inArray(occurrencePaymentResponsibilities.id, responsibilityIds),
  )).for("share");
  const byId = new Map(responsibilities.map((row) => [row.id, row]));
  const obligations = await tx.select({ id: paymentObligations.id, responsibilityId: paymentObligations.responsibilityId, state: paymentObligations.state })
    .from(paymentObligations).where(and(
      eq(paymentObligations.organizationId, input.organizationId),
      eq(paymentObligations.leagueId, input.leagueId),
      inArray(paymentObligations.id, items.map((item) => item.obligationId)),
    )).for("share");
  if (obligations.length !== items.length) throw new RosterSnapshotFinalizationError("OBLIGATION_MISSING", "The roster reservation references a missing obligation");
  for (const item of items) {
    const record = records.find((candidate) => candidate.id === item.obligationId);
    const responsibility = record?.responsibilityId ? byId.get(record.responsibilityId) : undefined;
    const obligation = obligations.find((candidate) => candidate.id === item.obligationId);
    if (!record || !responsibility || !obligation || responsibility.state !== "active"
      || responsibility.version !== record.responsibilityVersion
      || obligation.responsibilityId !== record.responsibilityId
      || (obligation.state !== "open" && obligation.state !== "partially_settled")) {
      throw new RosterSnapshotFinalizationError("ROSTER_RESERVATION_STALE", "The roster reservation changed before provider dispatch");
    }
  }
  return true;
}

/**
 * Finalize the immutable roster reservation after provider evidence exists.
 * This function intentionally has no provider, singleton DB, or request
 * imports. Executor, webhook, and explicit recovery all call it while
 * holding the operation/league transaction lock.
 */
export async function finalizeRosterSnapshotInTransaction(
  tx: PaymentOperationTransaction,
  input: {
    organizationId: number;
    leagueId: number;
    operationId: string;
    now: string;
    actorUserId?: number | null;
  },
): Promise<{ finalized: boolean; allocationIds: string[] }> {
  const [operation] = await tx.select().from(paymentOperations).where(and(
    eq(paymentOperations.organizationId, input.organizationId),
    eq(paymentOperations.leagueId, input.leagueId),
    eq(paymentOperations.id, input.operationId),
  )).limit(1).for("update");
  if (!operation) throw new RosterSnapshotFinalizationError("OPERATION_NOT_FOUND", "The payment operation is unavailable");

  const [snapshot] = await tx.select().from(paymentOperationRosterSnapshots).where(and(
    eq(paymentOperationRosterSnapshots.operationId, operation.id),
    eq(paymentOperationRosterSnapshots.organizationId, input.organizationId),
    eq(paymentOperationRosterSnapshots.leagueId, input.leagueId),
  )).limit(1).for("update");
  if (!snapshot) {
    // Historical interactive operations have no PR1 roster snapshot and must
    // continue through the retained general ledger finalizer unchanged.
    return { finalized: false, allocationIds: [] };
  }

  const items = await tx.select().from(paymentOperationRosterSnapshotItems).where(and(
    eq(paymentOperationRosterSnapshotItems.operationId, operation.id),
    eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId),
    eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId),
  )).orderBy(asc(paymentOperationRosterSnapshotItems.allocationIndex)).for("update");
  if (items.length === 0) throw new RosterSnapshotFinalizationError("SNAPSHOT_ITEMS_MISSING", "The roster snapshot has no obligation items");

  const itemTotal = items.reduce((sum, item) => sum + item.amountMinor, 0);
  if (itemTotal !== snapshot.amountMinor || itemTotal !== operation.amountMinor) {
    throw new RosterSnapshotFinalizationError("SNAPSHOT_AMOUNT_MISMATCH", "The roster snapshot amount is inconsistent with its operation items");
  }

  const rows = await tx.select().from(payments).where(and(
    eq(payments.leagueId, input.leagueId),
    eq(payments.paymentOperationId, operation.id),
  )).orderBy(asc(payments.paymentOperationAllocationIndex), asc(payments.id)).for("update");
  if (rows.length !== items.length) {
    throw new RosterSnapshotFinalizationError("PAYMENT_EVIDENCE_INCOMPLETE", "Provider payment evidence is incomplete for the roster snapshot");
  }

  const records = Array.isArray(snapshot.obligations)
    ? snapshot.obligations as SnapshotRecord[]
    : [];
  const responsibilityIds = [...new Set(records
    .map((record) => record.responsibilityId)
    .filter((id): id is string => typeof id === "string"))];
  const responsibilities = responsibilityIds.length === 0 ? [] : await tx.select({
    id: occurrencePaymentResponsibilities.id,
    version: occurrencePaymentResponsibilities.version,
    state: occurrencePaymentResponsibilities.state,
  }).from(occurrencePaymentResponsibilities).where(and(
    eq(occurrencePaymentResponsibilities.organizationId, input.organizationId),
    eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
    inArray(occurrencePaymentResponsibilities.id, responsibilityIds),
  )).orderBy(asc(occurrencePaymentResponsibilities.id)).for("update");
  const responsibilityById = new Map(responsibilities.map((row) => [row.id, row]));

  for (const item of items) {
    const record = records.find((candidate) => candidate.id === item.obligationId);
    const responsibility = record?.responsibilityId ? responsibilityById.get(record.responsibilityId) : undefined;
    if (!record || record.responsibilityId === undefined || record.responsibilityVersion === undefined
      || !responsibility || responsibility.state !== "active" || responsibility.version !== record.responsibilityVersion) {
      throw new RosterSnapshotFinalizationError("ROSTER_VERSION_CHANGED", "The roster responsibility changed after provider dispatch");
    }
  }

  const obligations = await tx.select().from(paymentObligations).where(and(
    eq(paymentObligations.organizationId, input.organizationId),
    eq(paymentObligations.leagueId, input.leagueId),
    inArray(paymentObligations.id, items.map((item) => item.obligationId)),
  )).orderBy(asc(paymentObligations.dueAt), asc(paymentObligations.payerBowlerId), asc(paymentObligations.occurrenceId), asc(paymentObligations.id)).for("update");
  if (obligations.length !== items.length || obligations.some((obligation) => obligation.state === "voided")) {
    throw new RosterSnapshotFinalizationError("OBLIGATION_VOIDED", "The provider payment references a voided or missing obligation");
  }

  const actorUserId = input.actorUserId ?? operation.authorizingUserId ?? rows.find((row) => row.paidByUserId !== null)?.paidByUserId ?? null;
  if (actorUserId === null) throw new RosterSnapshotFinalizationError("ACTOR_EVIDENCE_MISSING", "The roster payment has no immutable authorizing actor");

  const created: string[] = [];
  for (const item of items) {
    if (item.state === "released") throw new RosterSnapshotFinalizationError("RESERVATION_RELEASED", "The provider payment reservation was released before completion");
    if (item.state === "finalized") continue;
    const obligation = obligations.find((row) => row.id === item.obligationId);
    const payment = rows.find((row) => row.paymentOperationAllocationIndex === item.allocationIndex);
    if (!obligation || !payment || payment.amount !== item.amountMinor || payment.bowlerId !== obligation.payerBowlerId
      || payment.leagueId !== input.leagueId || payment.providerPaymentId !== operation.providerObjectId) {
      throw new RosterSnapshotFinalizationError("PAYMENT_EVIDENCE_MISMATCH", "Provider payment evidence does not match the immutable roster reservation");
    }

    const existing = await tx.select().from(paymentAllocations).where(and(
      eq(paymentAllocations.organizationId, input.organizationId),
      eq(paymentAllocations.leagueId, input.leagueId),
      eq(paymentAllocations.paymentId, payment.id),
      eq(paymentAllocations.obligationId, obligation.id),
    )).limit(1).for("update");
    if (existing.length > 0) {
      if (existing[0]?.state !== "active" || existing[0]?.amountMinor !== item.amountMinor) {
        throw new RosterSnapshotFinalizationError("ALLOCATION_EVIDENCE_MISMATCH", "Existing allocation evidence does not match the roster reservation");
      }
      await tx.update(paymentOperationRosterSnapshotItems).set({ state: "finalized" }).where(and(
        eq(paymentOperationRosterSnapshotItems.id, item.id),
        eq(paymentOperationRosterSnapshotItems.state, "reserved"),
      ));
      created.push(existing[0].id);
      continue;
    }

    const active = await tx.select({ amountMinor: paymentAllocations.amountMinor }).from(paymentAllocations).where(and(
      eq(paymentAllocations.organizationId, input.organizationId),
      eq(paymentAllocations.leagueId, input.leagueId),
      eq(paymentAllocations.obligationId, obligation.id),
      eq(paymentAllocations.state, "active"),
    )).orderBy(asc(paymentAllocations.id)).for("update");
    const allocatedMinor = active.reduce((sum, row) => sum + row.amountMinor, 0);
    if (allocatedMinor + item.amountMinor > obligation.amountMinor) {
      throw new RosterSnapshotFinalizationError("ALLOCATION_CONSERVATION_FAILED", "The roster payment exceeds the obligation balance");
    }
    const [allocation] = await tx.insert(paymentAllocations).values({
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      paymentId: payment.id,
      obligationId: obligation.id,
      amountMinor: item.amountMinor,
      currency: obligation.currency,
      recordedByUserId: actorUserId,
    }).returning({ id: paymentAllocations.id });
    if (!allocation) throw new RosterSnapshotFinalizationError("ALLOCATION_WRITE_FAILED", "The roster allocation could not be recorded");
    const nextTotal = allocatedMinor + item.amountMinor;
    await tx.update(paymentObligations).set({
      state: nextTotal >= obligation.amountMinor ? "settled" : "partially_settled",
    }).where(and(
      eq(paymentObligations.id, obligation.id),
      eq(paymentObligations.organizationId, input.organizationId),
      eq(paymentObligations.leagueId, input.leagueId),
    ));
    await tx.update(paymentOperationRosterSnapshotItems).set({ state: "finalized" }).where(and(
      eq(paymentOperationRosterSnapshotItems.id, item.id),
      eq(paymentOperationRosterSnapshotItems.state, "reserved"),
    ));
    created.push(allocation.id);
  }
  return { finalized: true, allocationIds: created };
}
