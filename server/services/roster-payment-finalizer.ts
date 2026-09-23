import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  occurrencePaymentResponsibilities,
  paymentAllocations,
  refundAllocationAdjustments,
  paymentObligations,
  paymentOperationRosterSnapshots,
  paymentOperationRosterSnapshotItems,
  paymentOperations,
  payments,
  rotatingCreditFundings,
  rotatingCreditPaymentOperationSnapshots,
  rotatingCreditApplications,
} from "@shared/schema";
import type { PaymentOperationTransaction } from "../storage/payment-operations.js";
import { canonicalObligationBalance } from "./refund-allocation-adjustments.js";
import { reconstructInteractivePartnerSnapshot, type InteractivePartnerPaymentSnapshot } from "./interactive-partner-payment-snapshot.js";
import { reconstructRotatingCreditOperationSnapshot } from "./rotating-credit-operation-snapshot.js";
import { applyRotatingCreditToConfirmedObligationsInTransaction, RotatingCreditLedgerError } from "./rotating-credit-applications.js";
import { createHash } from "node:crypto";
import { canonicalizePaymentOperationInput } from "./payment-operation-idempotency.js";

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
  obligationId?: string;
  responsibilityId?: string;
  responsibilityVersion?: number;
  payerBowlerId?: number;
  amountMinor?: number;
  dueAt?: string;
  pastDueAt?: string;
};

function snapshotRecordObligationId(record: SnapshotRecord | InteractivePartnerPaymentSnapshot["allocations"][number]): string | undefined {
  return "id" in record ? record.id ?? record.obligationId : record.obligationId;
}

/** v3 stores the selected-recipient/link evidence beside the allocation
 * records. Every dispatch/finalization path must validate that immutable
 * evidence and its fingerprint before interpreting those records; this
 * deliberately does not re-read live partner links. */
function validateInteractivePartnerSnapshot(
  operation: { id: string; organizationId: number; amountMinor: number; currency: string; providerName: string; providerIdempotencyKey: string },
  snapshot: typeof paymentOperationRosterSnapshots.$inferSelect,
): InteractivePartnerPaymentSnapshot | undefined {
  if (snapshot.snapshotVersion !== 3) return undefined;
  if (snapshot.requestKind === null || snapshot.sourceKind === null || snapshot.encryptedSourceId === null || snapshot.payerBowlerId === null || snapshot.quoteFingerprint === null || !Array.isArray(snapshot.partnerEvidence)) {
    throw new RosterSnapshotFinalizationError("SNAPSHOT_INVALID", "The interactive partner snapshot is incomplete");
  }
  try {
    return reconstructInteractivePartnerSnapshot({
      organizationId: operation.organizationId,
      amountMinor: operation.amountMinor,
      currency: operation.currency,
      providerName: operation.providerName,
      providerIdempotencyKey: operation.providerIdempotencyKey,
      stored: {
        snapshotVersion: 3,
        snapshotFingerprint: snapshot.snapshotFingerprint,
        leagueId: snapshot.leagueId,
        locationId: snapshot.locationId,
        providerLocationId: snapshot.providerLocationId,
        payerBowlerId: snapshot.payerBowlerId,
        requestKind: snapshot.requestKind,
        encryptedSourceId: snapshot.encryptedSourceId,
        encryptedCustomerId: snapshot.encryptedCustomerId,
        encryptedBuyerEmail: snapshot.encryptedBuyerEmail,
        storeCard: snapshot.storeCard,
        sourceKind: snapshot.sourceKind,
        quoteFingerprint: snapshot.quoteFingerprint,
        partnerEvidence: snapshot.partnerEvidence,
      },
      allocations: (Array.isArray(snapshot.obligations) ? snapshot.obligations : []) as InteractivePartnerPaymentSnapshot["allocations"],
      lineItems: snapshot.lineItems,
    });
  } catch (error) {
    if (error instanceof RosterSnapshotFinalizationError) throw error;
    throw new RosterSnapshotFinalizationError("SNAPSHOT_INVALID", "The interactive partner snapshot failed immutable validation");
  }
}

/** Validate the same immutable reservation immediately before the provider
 * dispatch cutoff. This closes the roster-edit/cancel race before any money
 * movement can begin. */
export async function validateRosterSnapshotForDispatchInTransaction(
  tx: PaymentOperationTransaction,
  input: { organizationId: number; leagueId: number; operationId: string },
): Promise<boolean> {
  const [creditSnapshot] = await tx.select().from(rotatingCreditPaymentOperationSnapshots).where(and(
    eq(rotatingCreditPaymentOperationSnapshots.operationId, input.operationId),
    eq(rotatingCreditPaymentOperationSnapshots.organizationId, input.organizationId),
    eq(rotatingCreditPaymentOperationSnapshots.leagueId, input.leagueId),
  )).limit(1).for("share");
  if (creditSnapshot) {
    const [creditOperation] = await tx.select().from(paymentOperations).where(and(
      eq(paymentOperations.id, input.operationId),
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.leagueId, input.leagueId),
    )).limit(1).for("share");
    const [rosterSnapshot] = await tx.select({ operationId: paymentOperationRosterSnapshots.operationId })
      .from(paymentOperationRosterSnapshots).where(and(
        eq(paymentOperationRosterSnapshots.operationId, input.operationId),
        eq(paymentOperationRosterSnapshots.organizationId, input.organizationId),
        eq(paymentOperationRosterSnapshots.leagueId, input.leagueId),
      )).limit(1).for("share");
    if (!creditOperation || rosterSnapshot) throw new RosterSnapshotFinalizationError("SNAPSHOT_INVALID", "The rotating credit operation snapshot is inconsistent");
    try {
      const snapshot = reconstructRotatingCreditOperationSnapshot({
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        providerName: creditOperation.providerName,
        providerIdempotencyKey: creditOperation.providerIdempotencyKey,
        stored: creditSnapshot,
      });
      if (creditOperation.operationType !== "interactive_charge"
        || creditOperation.amountMinor !== snapshot.amountMinor
        || creditOperation.currency !== snapshot.currency
        || creditOperation.authorizingUserId === null) {
        throw new Error("rotating credit operation identity mismatch");
      }
    } catch {
      throw new RosterSnapshotFinalizationError("SNAPSHOT_INVALID", "The rotating credit operation snapshot failed immutable validation");
    }
    return true;
  }
  const [snapshot] = await tx.select().from(paymentOperationRosterSnapshots).where(and(
    eq(paymentOperationRosterSnapshots.operationId, input.operationId),
    eq(paymentOperationRosterSnapshots.organizationId, input.organizationId),
    eq(paymentOperationRosterSnapshots.leagueId, input.leagueId),
  )).limit(1).for("share");
  if (!snapshot) return false;
  const [operation] = await tx.select().from(paymentOperations).where(and(
    eq(paymentOperations.id, input.operationId),
    eq(paymentOperations.organizationId, input.organizationId),
    eq(paymentOperations.leagueId, input.leagueId),
  )).limit(1).for("share");
  if (!operation) throw new RosterSnapshotFinalizationError("OPERATION_NOT_FOUND", "The payment operation is unavailable");
  const validatedPartnerSnapshot = validateInteractivePartnerSnapshot(operation, snapshot);
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
  const records = validatedPartnerSnapshot?.allocations ?? (Array.isArray(snapshot.obligations) ? snapshot.obligations as SnapshotRecord[] : []);
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
    const record = records.find((candidate) => snapshotRecordObligationId(candidate) === item.obligationId);
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

  const [creditSnapshot] = await tx.select().from(rotatingCreditPaymentOperationSnapshots).where(and(
    eq(rotatingCreditPaymentOperationSnapshots.operationId, operation.id),
    eq(rotatingCreditPaymentOperationSnapshots.organizationId, input.organizationId),
    eq(rotatingCreditPaymentOperationSnapshots.leagueId, input.leagueId),
  )).limit(1).for("update");
  if (creditSnapshot) {
    const [rosterSnapshot] = await tx.select({ operationId: paymentOperationRosterSnapshots.operationId }).from(paymentOperationRosterSnapshots).where(and(
      eq(paymentOperationRosterSnapshots.operationId, operation.id),
      eq(paymentOperationRosterSnapshots.organizationId, input.organizationId),
      eq(paymentOperationRosterSnapshots.leagueId, input.leagueId),
    )).limit(1).for("share");
    if (rosterSnapshot || operation.operationType !== "interactive_charge" || operation.amountMinor !== creditSnapshot.amountMinor
      || operation.currency !== creditSnapshot.currency || operation.providerObjectId === null
      || (operation.status !== "succeeded" && operation.status !== "reconciliation_required")) {
      throw new RosterSnapshotFinalizationError("SNAPSHOT_INVALID", "The rotating credit provider evidence is incomplete");
    }
    let snapshot;
    try {
      snapshot = reconstructRotatingCreditOperationSnapshot({
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        providerName: operation.providerName,
        providerIdempotencyKey: operation.providerIdempotencyKey,
        stored: creditSnapshot,
      });
    } catch {
      throw new RosterSnapshotFinalizationError("SNAPSHOT_INVALID", "The rotating credit operation snapshot failed immutable validation");
    }
    const rows = await tx.select().from(payments).where(and(
      eq(payments.organizationId, input.organizationId),
      eq(payments.leagueId, input.leagueId),
      eq(payments.paymentOperationId, operation.id),
    )).orderBy(asc(payments.id)).for("update");
    if (rows.length > 1) {
      throw new RosterSnapshotFinalizationError("PAYMENT_EVIDENCE_INCOMPLETE", "Provider payment evidence is incomplete for rotating credit");
    }
    let providerPayment = rows[0];
    if (!providerPayment) {
      const authorizingUserId = input.actorUserId ?? operation.authorizingUserId;
      if (authorizingUserId === null || authorizingUserId === undefined) {
        throw new RosterSnapshotFinalizationError("ACTOR_EVIDENCE_MISSING", "The rotating credit purchase has no immutable authorizing actor");
      }
      const [recoveredPayment] = await tx.insert(payments).values({
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        bowlerId: snapshot.bowlerId,
        amount: snapshot.amountMinor,
        currency: "USD",
        status: "paid",
        type: "square",
        providerPaymentId: operation.providerObjectId,
        idempotencyKey: `rotating-credit-operation:${operation.id}`,
        paidByUserId: authorizingUserId,
        paymentOperationId: operation.id,
        notes: "Rotating share credit top-up",
        receiptEmailMissing: snapshot.buyerEmail === null,
        createdAt: input.now,
      }).returning();
      providerPayment = recoveredPayment;
    }
    if (!providerPayment || providerPayment.amount !== operation.amountMinor || providerPayment.bowlerId !== snapshot.bowlerId
      || providerPayment.providerPaymentId !== operation.providerObjectId || providerPayment.type !== "square" || providerPayment.status !== "paid") {
      throw new RosterSnapshotFinalizationError("PAYMENT_EVIDENCE_INCOMPLETE", "Provider payment evidence is incomplete for rotating credit");
    }
    const actorUserId = input.actorUserId ?? operation.authorizingUserId ?? providerPayment.paidByUserId ?? null;
    if (actorUserId === null) throw new RosterSnapshotFinalizationError("ACTOR_EVIDENCE_MISSING", "The rotating credit purchase has no immutable authorizing actor");
    const [existingFunding] = await tx.select().from(rotatingCreditFundings).where(and(
      eq(rotatingCreditFundings.organizationId, input.organizationId),
      eq(rotatingCreditFundings.leagueId, input.leagueId),
      eq(rotatingCreditFundings.paymentId, providerPayment.id),
    )).limit(1).for("update");
    if (existingFunding) {
      if (existingFunding.bowlerId !== snapshot.bowlerId || existingFunding.amountMinor !== snapshot.amountMinor
        || existingFunding.idempotencyKey !== snapshot.idempotencyKey || existingFunding.fundingKind !== "provider") {
        throw new RosterSnapshotFinalizationError("FUNDING_EVIDENCE_MISMATCH", "Existing rotating credit funding does not match the provider operation");
      }
      const allocations = await tx.select({ allocationId: rotatingCreditApplications.allocationId }).from(rotatingCreditApplications).where(and(
        eq(rotatingCreditApplications.organizationId, input.organizationId),
        eq(rotatingCreditApplications.leagueId, input.leagueId),
        eq(rotatingCreditApplications.fundingId, existingFunding.id),
      ));
      return { finalized: true, allocationIds: allocations.map((row) => row.allocationId) };
    }
    const requestFingerprint = `lvrotcrreq:v1:${createHash("sha256").update(canonicalizePaymentOperationInput({
      contract: "rotating-credit-funding-request/1",
      operationId: operation.id,
      snapshotFingerprint: creditSnapshot.snapshotFingerprint,
      idempotencyKey: snapshot.idempotencyKey,
    })).digest("hex")}`;
    const [funding] = await tx.insert(rotatingCreditFundings).values({
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      bowlerId: snapshot.bowlerId,
      paymentId: providerPayment.id,
      amountMinor: snapshot.amountMinor,
      currency: "USD",
      fundingKind: "provider",
      idempotencyKey: snapshot.idempotencyKey,
      requestFingerprint,
      quoteFingerprint: snapshot.quoteFingerprint,
      actorUserId,
      createdAt: input.now,
    }).returning({ id: rotatingCreditFundings.id });
    if (!funding) throw new RosterSnapshotFinalizationError("FUNDING_CREATE_FAILED", "Rotating credit funding was not recorded");
    let newApplicationIds: string[];
    try {
      newApplicationIds = await applyRotatingCreditToConfirmedObligationsInTransaction(tx, {
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        bowlerId: snapshot.bowlerId,
        actorUserId,
        now: input.now,
      });
    } catch (error) {
      if (error instanceof RotatingCreditLedgerError) throw new RosterSnapshotFinalizationError(error.code, "Rotating credit applications could not be finalized");
      throw error;
    }
    if (newApplicationIds.length === 0) return { finalized: true, allocationIds: [] };
    const allocations = await tx.select({ allocationId: rotatingCreditApplications.allocationId }).from(rotatingCreditApplications).where(and(
      eq(rotatingCreditApplications.organizationId, input.organizationId),
      eq(rotatingCreditApplications.leagueId, input.leagueId),
      inArray(rotatingCreditApplications.id, newApplicationIds),
    ));
    return { finalized: true, allocationIds: allocations.map((row) => row.allocationId) };
  }

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
  const validatedPartnerSnapshot = validateInteractivePartnerSnapshot(operation, snapshot);

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
    eq(payments.organizationId, input.organizationId),
    eq(payments.leagueId, input.leagueId),
    eq(payments.paymentOperationId, operation.id),
  )).orderBy(asc(payments.id)).for("update");
  if (rows.length !== 1 || rows[0]?.amount !== operation.amountMinor || rows[0]?.organizationId !== input.organizationId) {
    throw new RosterSnapshotFinalizationError("PAYMENT_EVIDENCE_INCOMPLETE", "Provider payment evidence is incomplete for the roster snapshot");
  }

  const records = validatedPartnerSnapshot?.allocations ?? (Array.isArray(snapshot.obligations)
    ? snapshot.obligations as SnapshotRecord[]
    : []);
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
    const record = records.find((candidate) => snapshotRecordObligationId(candidate) === item.obligationId);
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
    const payment = rows[0];
    if (!obligation || !payment || payment.amount !== operation.amountMinor
      || (snapshot.snapshotKind === "interactive" && payment.bowlerId !== snapshot.payerBowlerId)
      || payment.organizationId !== input.organizationId
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

    const active = await tx.select({ id: paymentAllocations.id, amountMinor: paymentAllocations.amountMinor }).from(paymentAllocations).where(and(
      eq(paymentAllocations.organizationId, input.organizationId),
      eq(paymentAllocations.leagueId, input.leagueId),
      eq(paymentAllocations.obligationId, obligation.id),
      eq(paymentAllocations.state, "active"),
    )).orderBy(asc(paymentAllocations.id)).for("update");
    const adjustments = active.length === 0 ? [] : await tx.select({ sourceAllocationId: refundAllocationAdjustments.sourceAllocationId, amountMinor: refundAllocationAdjustments.amountMinor, disposition: refundAllocationAdjustments.disposition }).from(refundAllocationAdjustments).where(and(
      eq(refundAllocationAdjustments.organizationId, input.organizationId),
      eq(refundAllocationAdjustments.leagueId, input.leagueId),
      inArray(refundAllocationAdjustments.sourceAllocationId, active.map((row) => row.id)),
    ));
    const balance = canonicalObligationBalance({
      amountMinor: obligation.amountMinor,
      state: obligation.state,
      grossAllocatedMinor: active.reduce((sum, row) => sum + row.amountMinor, 0),
      adjustments,
    });
    // A refunded source allocation reopens only its explicit disposition:
    // still-owed refunds create capacity for a one-time replacement tender,
    // while a waiver already consumes that portion of the obligation.
    if (item.amountMinor > balance.outstandingMinor) {
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
    const nextBalance = canonicalObligationBalance({
      amountMinor: obligation.amountMinor,
      state: obligation.state,
      grossAllocatedMinor: balance.grossAllocatedMinor + item.amountMinor,
      adjustments,
    });
    await tx.update(paymentObligations).set({
      state: nextBalance.outstandingMinor === 0 ? "settled" : "partially_settled",
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
  const [activeTotals] = await tx.select({ amountMinor: sql<number>`COALESCE(SUM(${paymentAllocations.amountMinor}), 0)` })
    .from(paymentAllocations)
    .where(and(
      eq(paymentAllocations.organizationId, input.organizationId),
      eq(paymentAllocations.leagueId, input.leagueId),
      eq(paymentAllocations.paymentId, rows[0]?.id ?? 0),
      eq(paymentAllocations.state, "active"),
    ));
  if (Number(activeTotals?.amountMinor ?? 0) !== rows[0]?.amount) {
    throw new RosterSnapshotFinalizationError("PAYMENT_ALLOCATION_TOTAL_MISMATCH", "Active payment allocations must equal the tender total");
  }
  return { finalized: true, allocationIds: created };
}
