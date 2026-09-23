import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  financialCommands,
  paymentAllocationCorrections,
  paymentAllocations,
  paymentDisputes,
  paymentObligations,
  paymentOperationRosterSnapshotItems,
  paymentOperationRosterSnapshots,
  paymentOperations,
  paymentVoids,
  payments,
  refundAllocationAdjustments,
  rotatingCreditFundings,
} from "@shared/schema";
import { db } from "../db.js";
import { lockLeagueSchedule } from "../storage/league-schedule-lock.js";
import type { PaymentOperationTransaction } from "../storage/payment-operations.js";
import { canonicalObligationBalance } from "./refund-allocation-adjustments.js";

const COMMAND_TYPE = "roster_payment.correct_historical_square_allocation_v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface HistoricalSquareAllocationTarget {
  obligationId: string;
  amountMinor: number;
}

export interface HistoricalSquareAllocationCorrectionRequest {
  paymentId: number;
  expectedOldAllocationFingerprint: string;
  expectedTargetAllocationFingerprint: string;
  targetAllocations: readonly HistoricalSquareAllocationTarget[];
  reason: string;
  idempotencyKey: string;
  requestFingerprint: string;
}

/** The private maintenance plan supplies this map at execution time. */
export interface HistoricalSquarePaymentAllowlist {
  organizationId?: number;
  leagueId?: number;
  paymentAmountsMinor: Readonly<Record<string, number>>;
}

export interface HistoricalSquareAllocationFingerprintRow {
  allocationId?: string | null;
  obligationId: string;
  amountMinor: number;
  state?: "active" | "voided" | null;
  allocationKind?: "ordinary" | "rotating_credit" | null;
}

export interface HistoricalSquareCorrectionSourceRow {
  id: string;
  obligationId: string;
  amountMinor: number;
}

export interface HistoricalSquareCorrectionPlan {
  retainedSources: HistoricalSquareCorrectionSourceRow[];
  changedSources: HistoricalSquareCorrectionSourceRow[];
  replacementTargets: HistoricalSquareAllocationTarget[];
  pairs: Array<{
    source: HistoricalSquareCorrectionSourceRow;
    target: HistoricalSquareAllocationTarget;
  }>;
}

/**
 * Derive the bounded moved subset from a complete reviewed target. Matching
 * obligation/amount rows remain active; only changed rows need correction
 * evidence. Pairing is deterministic and amount preserving for the private
 * same-parent repair plan.
 */
export function deriveHistoricalSquareCorrectionPlan(
  sources: readonly HistoricalSquareCorrectionSourceRow[],
  targets: readonly HistoricalSquareAllocationTarget[],
): HistoricalSquareCorrectionPlan {
  const sourceByObligationId = new Map(sources.map((row) => [row.obligationId, row]));
  const targetByObligationId = new Map(targets.map((row) => [row.obligationId, row]));
  const retainedSources = sources.filter((source) => targetByObligationId.get(source.obligationId)?.amountMinor === source.amountMinor);
  const changedSources = sources.filter((source) => !retainedSources.includes(source));
  const replacementTargets = targets.filter((target) => sourceByObligationId.get(target.obligationId)?.amountMinor !== target.amountMinor);
  const sortedSources = [...changedSources].sort((left, right) => left.amountMinor - right.amountMinor || left.obligationId.localeCompare(right.obligationId));
  const sortedTargets = [...replacementTargets].sort((left, right) => left.amountMinor - right.amountMinor || left.obligationId.localeCompare(right.obligationId));
  const pairs: HistoricalSquareCorrectionPlan["pairs"] = [];
  for (const [index, source] of sortedSources.entries()) {
    const target = sortedTargets[index];
    if (target) pairs.push({ source, target });
  }
  return {
    retainedSources,
    changedSources,
    replacementTargets,
    pairs,
  };
}

export class HistoricalSquareAllocationCorrectionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409,
  ) {
    super(message);
    this.name = "HistoricalSquareAllocationCorrectionError";
  }
}

export class HistoricalSquareAllocationCorrectionReplay extends HistoricalSquareAllocationCorrectionError {
  constructor(public readonly result: unknown) {
    super("IDEMPOTENCY_REPLAY", "The historical Square correction was already applied", 200);
    this.name = "HistoricalSquareAllocationCorrectionReplay";
  }
}

function stableFingerprint(prefix: string, value: unknown): string {
  return `${prefix}:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export function historicalSquareAllocationFingerprint(rows: readonly HistoricalSquareAllocationFingerprintRow[]): string {
  return stableFingerprint("lvsquarealloc:v1", [...rows]
    .map((row) => ({
      allocationId: row.allocationId ?? null,
      obligationId: row.obligationId,
      amountMinor: row.amountMinor,
      state: row.state ?? null,
      allocationKind: row.allocationKind ?? null,
    }))
    .sort((left, right) => (left.allocationId ?? "").localeCompare(right.allocationId ?? "")
      || left.obligationId.localeCompare(right.obligationId)
      || left.amountMinor - right.amountMinor));
}

export function historicalSquareAllocationCorrectionFingerprint(input: {
  organizationId: number;
  leagueId: number;
  request: Omit<HistoricalSquareAllocationCorrectionRequest, "requestFingerprint">;
}): string {
  return stableFingerprint("lvsquarecorr:v1", {
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    paymentId: input.request.paymentId,
    expectedOldAllocationFingerprint: input.request.expectedOldAllocationFingerprint,
    expectedTargetAllocationFingerprint: input.request.expectedTargetAllocationFingerprint,
    targetAllocations: [...input.request.targetAllocations]
      .map((row) => ({ obligationId: row.obligationId, amountMinor: row.amountMinor }))
      .sort((left, right) => left.obligationId.localeCompare(right.obligationId) || left.amountMinor - right.amountMinor),
    reason: input.request.reason,
    idempotencyKey: input.request.idempotencyKey,
  });
}

type HistoricalSquareCorrectionResult = {
  contractVersion: "historical-square-allocation-correction/1";
  organizationId: number;
  leagueId: number;
  paymentId: number;
  paymentOperationId: string;
  providerPaymentId: string;
  amountMinor: number;
  providerMutation: "none";
  sourceAllocations: Array<{
    allocationId: string;
    obligationId: string;
    amountMinor: number;
    state: "voided";
  }>;
  replacementAllocations: Array<{
    allocationId: string;
    obligationId: string;
    amountMinor: number;
    state: "active";
  }>;
  corrections: Array<{
    id: string;
    sourceAllocationId: string;
    replacementAllocationId: string;
    sourceObligationId: string;
    targetObligationId: string;
    amountMinor: number;
  }>;
};

async function beginCommand(
  tx: PaymentOperationTransaction,
  input: {
    organizationId: number;
    leagueId: number;
    actorUserId: number;
    idempotencyKey: string;
    requestFingerprint: string;
  },
): Promise<unknown | undefined> {
  const [existing] = await tx.select().from(financialCommands).where(and(
    eq(financialCommands.organizationId, input.organizationId),
    eq(financialCommands.leagueId, input.leagueId),
    eq(financialCommands.commandType, COMMAND_TYPE),
    eq(financialCommands.idempotencyKey, input.idempotencyKey),
  )).limit(1).for("update");
  if (existing) {
    if (existing.actorUserId !== input.actorUserId || existing.requestFingerprint !== input.requestFingerprint) {
      throw new HistoricalSquareAllocationCorrectionError("IDEMPOTENCY_CONFLICT", "The idempotency key is bound to different correction evidence");
    }
    if (existing.state === "applied" && existing.result !== null) return existing.result;
    if (existing.state === "failed") {
      throw new HistoricalSquareAllocationCorrectionError(existing.errorCode ?? "COMMAND_FAILED", "The correction command previously failed");
    }
    return undefined;
  }
  await tx.insert(financialCommands).values({
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    actorUserId: input.actorUserId,
    commandType: COMMAND_TYPE,
    idempotencyKey: input.idempotencyKey,
    requestFingerprint: input.requestFingerprint,
    state: "accepted",
  });
  return undefined;
}

export async function correctHistoricalSquarePaymentAllocation(input: {
  organizationId: number;
  leagueId: number;
  actorUserId: number;
  allowlist: HistoricalSquarePaymentAllowlist;
  request: HistoricalSquareAllocationCorrectionRequest;
}): Promise<HistoricalSquareCorrectionResult> {
  return db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    const request = input.request;
    const targetAllocations = Array.isArray(request.targetAllocations)
      ? [...request.targetAllocations].sort((left, right) => left.obligationId.localeCompare(right.obligationId) || left.amountMinor - right.amountMinor)
      : [];
    const fingerprintRequest: Omit<HistoricalSquareAllocationCorrectionRequest, "requestFingerprint"> = {
      paymentId: request.paymentId,
      expectedOldAllocationFingerprint: request.expectedOldAllocationFingerprint,
      expectedTargetAllocationFingerprint: request.expectedTargetAllocationFingerprint,
      targetAllocations,
      reason: request.reason,
      idempotencyKey: request.idempotencyKey,
    };
    if (!Number.isSafeInteger(request.paymentId)
      || request.paymentId <= 0
      || !Number.isSafeInteger(input.organizationId)
      || input.organizationId <= 0
      || !Number.isSafeInteger(input.leagueId)
      || input.leagueId <= 0
      || targetAllocations.length === 0
      || targetAllocations.length > 64
      || targetAllocations.some((row) => !UUID_PATTERN.test(row.obligationId) || !Number.isSafeInteger(row.amountMinor) || row.amountMinor <= 0)
      || new Set(targetAllocations.map((row) => row.obligationId)).size !== targetAllocations.length
      || typeof request.reason !== "string"
      || request.reason.trim().length === 0
      || request.reason.length > 500
      || typeof request.idempotencyKey !== "string"
      || request.idempotencyKey.trim().length < 16
      || request.idempotencyKey.length > 255
      || request.requestFingerprint !== historicalSquareAllocationCorrectionFingerprint({
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        request: fingerprintRequest,
      })) {
      throw new HistoricalSquareAllocationCorrectionError("INVALID_REQUEST", "The historical Square correction request is invalid", 422);
    }
    const allowlistedAmount = input.allowlist.paymentAmountsMinor[String(request.paymentId)];
    if ((input.allowlist.organizationId !== undefined && input.allowlist.organizationId !== input.organizationId)
      || (input.allowlist.leagueId !== undefined && input.allowlist.leagueId !== input.leagueId)
      || !Number.isSafeInteger(allowlistedAmount)
      || allowlistedAmount <= 0) {
      throw new HistoricalSquareAllocationCorrectionError("PAYMENT_NOT_ALLOWLISTED", "This payment is not authorized for historical correction");
    }
    const targetFingerprint = historicalSquareAllocationFingerprint(targetAllocations.map((row) => ({
      obligationId: row.obligationId,
      amountMinor: row.amountMinor,
      state: "active" as const,
      allocationKind: "ordinary" as const,
    })));
    if (request.expectedTargetAllocationFingerprint !== targetFingerprint) {
      throw new HistoricalSquareAllocationCorrectionError("TARGET_FINGERPRINT_MISMATCH", "The reviewed target allocation evidence is stale");
    }
    const replay = await beginCommand(tx, {
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      actorUserId: input.actorUserId,
      idempotencyKey: request.idempotencyKey,
      requestFingerprint: request.requestFingerprint,
    });
    if (replay !== undefined) return replay as HistoricalSquareCorrectionResult;

    const [payment] = await tx.select().from(payments).where(and(
      eq(payments.id, request.paymentId),
      eq(payments.organizationId, input.organizationId),
      eq(payments.leagueId, input.leagueId),
    )).limit(1).for("update");
    if (!payment) throw new HistoricalSquareAllocationCorrectionError("NOT_FOUND", "Payment not found", 404);
    if (payment.amount !== allowlistedAmount) throw new HistoricalSquareAllocationCorrectionError("PAYMENT_AMOUNT_MISMATCH", "The payment amount does not match the private correction plan");
    if (payment.type !== "square"
      || payment.status !== "paid"
      || payment.paymentOperationId === null
      || payment.providerPaymentId === null
      || payment.refundedAt !== null
      || payment.squareRefundId !== null
      || payment.disputeId !== null
      || payment.disputedAt !== null) {
      throw new HistoricalSquareAllocationCorrectionError("PROVIDER_PAYMENT_UNAVAILABLE", "Only an unreversed Square charge can be corrected");
    }

    const [creditFunding] = await tx.select({ id: rotatingCreditFundings.id }).from(rotatingCreditFundings).where(and(
      eq(rotatingCreditFundings.organizationId, input.organizationId),
      eq(rotatingCreditFundings.leagueId, input.leagueId),
      eq(rotatingCreditFundings.paymentId, payment.id),
    )).limit(1).for("update");
    if (creditFunding) throw new HistoricalSquareAllocationCorrectionError("ROTATING_CREDIT_UNAVAILABLE", "Credit funding tenders cannot be historically reallocated");

    const [voidEvidence] = await tx.select({ id: paymentVoids.id }).from(paymentVoids).where(and(
      eq(paymentVoids.organizationId, input.organizationId),
      eq(paymentVoids.leagueId, input.leagueId),
      eq(paymentVoids.paymentId, payment.id),
    )).limit(1).for("update");
    if (voidEvidence) throw new HistoricalSquareAllocationCorrectionError("PAYMENT_ALREADY_VOIDED", "The payment already has void evidence");
    const [existingCorrection] = await tx.select({ id: paymentAllocationCorrections.id }).from(paymentAllocationCorrections).where(and(
      eq(paymentAllocationCorrections.organizationId, input.organizationId),
      eq(paymentAllocationCorrections.leagueId, input.leagueId),
      eq(paymentAllocationCorrections.paymentId, payment.id),
    )).limit(1).for("update");
    if (existingCorrection) throw new HistoricalSquareAllocationCorrectionError("PAYMENT_ALREADY_CORRECTED", "The payment already has historical allocation correction evidence");

    const [operation] = await tx.select().from(paymentOperations).where(and(
      eq(paymentOperations.id, payment.paymentOperationId),
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.leagueId, input.leagueId),
    )).limit(1).for("share");
    if (!operation
      || operation.providerName !== "square"
      || operation.status !== "succeeded"
      || (operation.operationType !== "interactive_charge" && operation.operationType !== "standing_autopay_charge")
      || operation.amountMinor !== payment.amount
      || operation.currency !== payment.currency
      || operation.providerObjectId !== payment.providerPaymentId) {
      throw new HistoricalSquareAllocationCorrectionError("OPERATION_EVIDENCE_INVALID", "The provider operation evidence does not match the payment");
    }

    const allocations = await tx.select().from(paymentAllocations).where(and(
      eq(paymentAllocations.organizationId, input.organizationId),
      eq(paymentAllocations.leagueId, input.leagueId),
      eq(paymentAllocations.paymentId, payment.id),
    )).orderBy(asc(paymentAllocations.id)).for("update");
    if (allocations.length === 0
      || allocations.some((row) => row.state !== "active" || row.allocationKind !== "ordinary" || row.reviewRequired)
      || allocations.reduce((sum, row) => sum + row.amountMinor, 0) !== payment.amount) {
      throw new HistoricalSquareAllocationCorrectionError("ALLOCATION_EVIDENCE_INVALID", "The source allocation evidence is not repairable");
    }
    const sourceFingerprint = historicalSquareAllocationFingerprint(allocations.map((row) => ({
      allocationId: row.id,
      obligationId: row.obligationId,
      amountMinor: row.amountMinor,
      state: row.state,
      allocationKind: row.allocationKind,
    })));
    if (request.expectedOldAllocationFingerprint !== sourceFingerprint) {
      throw new HistoricalSquareAllocationCorrectionError("SOURCE_FINGERPRINT_MISMATCH", "The source allocation evidence is stale");
    }
    if (targetAllocations.length !== allocations.length
      || targetAllocations.reduce((sum, row) => sum + row.amountMinor, 0) !== payment.amount) {
      throw new HistoricalSquareAllocationCorrectionError("ALLOCATION_TOTAL_MISMATCH", "The replacement allocation map must conserve the payment amount");
    }

    const [snapshot] = await tx.select().from(paymentOperationRosterSnapshots).where(and(
      eq(paymentOperationRosterSnapshots.operationId, operation.id),
      eq(paymentOperationRosterSnapshots.organizationId, input.organizationId),
      eq(paymentOperationRosterSnapshots.leagueId, input.leagueId),
    )).limit(1).for("share");
    const snapshotItems = await tx.select().from(paymentOperationRosterSnapshotItems).where(and(
      eq(paymentOperationRosterSnapshotItems.operationId, operation.id),
      eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId),
      eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId),
    )).orderBy(asc(paymentOperationRosterSnapshotItems.allocationIndex)).for("share");
    if (!snapshot || snapshotItems.length !== allocations.length || snapshotItems.some((item) => item.state !== "finalized")) {
      throw new HistoricalSquareAllocationCorrectionError("SNAPSHOT_EVIDENCE_INVALID", "The provider roster snapshot is not finalized for correction");
    }
    const snapshotRemaining = snapshotItems.map((item) => ({ obligationId: item.obligationId, amountMinor: item.amountMinor }));
    for (const allocation of allocations) {
      const index = snapshotRemaining.findIndex((row) => row.obligationId === allocation.obligationId && row.amountMinor === allocation.amountMinor);
      if (index < 0) throw new HistoricalSquareAllocationCorrectionError("SNAPSHOT_EVIDENCE_INVALID", "The source allocation does not match its provider snapshot");
      snapshotRemaining.splice(index, 1);
    }
    if (snapshotRemaining.length > 0) throw new HistoricalSquareAllocationCorrectionError("SNAPSHOT_EVIDENCE_INVALID", "The source allocation does not match its provider snapshot");

    const targetIds = targetAllocations.map((row) => row.obligationId);
    // The reviewed target is the complete desired allocation set. Preserve an
    // unchanged source row in place and create correction evidence only for
    // the moved subset. A changed amount on the same obligation is rejected:
    // the private repair plan requires disjoint source and target obligations.
    const correctionPlan = deriveHistoricalSquareCorrectionPlan(allocations, targetAllocations);
    const { changedSources, replacementTargets } = correctionPlan;
    if (changedSources.length === 0) {
      throw new HistoricalSquareAllocationCorrectionError("NOOP_CORRECTION", "The reviewed target does not change the source allocation set");
    }
    if (changedSources.length !== replacementTargets.length
      || changedSources.some((source) => replacementTargets.some((target) => target.obligationId === source.obligationId))) {
      throw new HistoricalSquareAllocationCorrectionError("TARGET_OVERLAPS_SOURCE", "Changed source and replacement obligations must be disjoint and balanced");
    }
    const pairs = correctionPlan.pairs;
    if (pairs.some((pair) => pair.source.amountMinor !== pair.target.amountMinor)) {
      throw new HistoricalSquareAllocationCorrectionError("ALLOCATION_TOTAL_MISMATCH", "Each moved source must have an equal amount replacement");
    }
    const changedSourceObligationIds = new Set(changedSources.map((row) => row.obligationId));
    const replacementTargetIds = replacementTargets.map((row) => row.obligationId);
    const obligations = await tx.select().from(paymentObligations).where(and(
      eq(paymentObligations.organizationId, input.organizationId),
      eq(paymentObligations.leagueId, input.leagueId),
      inArray(paymentObligations.id, targetIds),
    )).orderBy(asc(paymentObligations.id)).for("update");
    const obligationById = new Map(obligations.map((row) => [row.id, row]));
    if (obligations.length !== targetIds.length || targetAllocations.some((target) => {
      const obligation = obligationById.get(target.obligationId);
      return !obligation
        || obligation.state === "voided"
        || obligation.currency !== payment.currency
        || obligation.payerBowlerId !== payment.bowlerId;
    })) {
      throw new HistoricalSquareAllocationCorrectionError("TARGET_OBLIGATION_UNAVAILABLE", "Replacement obligations must belong to the payment payer and remain collectible");
    }
    const targetActive = await tx.select({
      obligationId: paymentAllocations.obligationId,
      paymentId: paymentAllocations.paymentId,
      amountMinor: paymentAllocations.amountMinor,
    }).from(paymentAllocations).where(and(
      eq(paymentAllocations.organizationId, input.organizationId),
      eq(paymentAllocations.leagueId, input.leagueId),
      eq(paymentAllocations.state, "active"),
      inArray(paymentAllocations.obligationId, targetIds),
    )).for("share");
    const existingTargetTotals = new Map<string, number>();
    for (const row of targetActive) existingTargetTotals.set(row.obligationId, (existingTargetTotals.get(row.obligationId) ?? 0) + row.amountMinor);
    if (targetActive.some((row) => row.paymentId === payment.id && replacementTargetIds.includes(row.obligationId))) {
      throw new HistoricalSquareAllocationCorrectionError("TARGET_ALREADY_ALLOCATED", "A replacement obligation already has an allocation from this payment");
    }
    if (replacementTargets.some((target) => (existingTargetTotals.get(target.obligationId) ?? 0) + target.amountMinor > (obligationById.get(target.obligationId)?.amountMinor ?? 0))) {
      throw new HistoricalSquareAllocationCorrectionError("TARGET_OVERALLOCATED", "The replacement allocation would exceed an obligation balance");
    }
    const reservations = await tx.select({ id: paymentOperationRosterSnapshotItems.id }).from(paymentOperationRosterSnapshotItems).where(and(
      eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId),
      eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId),
      eq(paymentOperationRosterSnapshotItems.state, "reserved"),
      inArray(paymentOperationRosterSnapshotItems.obligationId, [...changedSourceObligationIds, ...replacementTargetIds]),
    )).limit(1).for("update");
    if (reservations.length > 0) throw new HistoricalSquareAllocationCorrectionError("OBLIGATION_RESERVED", "A provider operation currently reserves a correction obligation");

    const [refundAdjustment] = await tx.select({ id: refundAllocationAdjustments.id }).from(refundAllocationAdjustments).where(and(
      eq(refundAllocationAdjustments.organizationId, input.organizationId),
      eq(refundAllocationAdjustments.leagueId, input.leagueId),
      inArray(refundAllocationAdjustments.sourceAllocationId, allocations.map((row) => row.id)),
    )).limit(1).for("share");
    if (refundAdjustment) throw new HistoricalSquareAllocationCorrectionError("REFUND_EVIDENCE_PRESENT", "The payment has refund allocation evidence");
    const [dispute] = await tx.select({ id: paymentDisputes.id }).from(paymentDisputes).where(and(
      eq(paymentDisputes.organizationId, input.organizationId),
      eq(paymentDisputes.paymentOperationId, operation.id),
    )).limit(1).for("share");
    if (dispute) throw new HistoricalSquareAllocationCorrectionError("DISPUTE_EVIDENCE_PRESENT", "The payment operation has dispute evidence");
    const [refundOperation] = await tx.select({ id: paymentOperations.id }).from(paymentOperations).where(and(
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.leagueId, input.leagueId),
      eq(paymentOperations.operationType, "refund"),
      eq(paymentOperations.targetKey, `payment-refund:${payment.id}`),
    )).limit(1).for("share");
    if (refundOperation) throw new HistoricalSquareAllocationCorrectionError("REFUND_OPERATION_PRESENT", "The payment already has refund operation evidence");

    const createdReplacements = [];
    for (const pair of pairs) {
      const [replacement] = await tx.insert(paymentAllocations).values({
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        paymentId: payment.id,
        obligationId: pair.target.obligationId,
        amountMinor: pair.target.amountMinor,
        currency: payment.currency,
        allocationKind: "ordinary",
        recordedByUserId: input.actorUserId,
      }).returning();
      if (!replacement) throw new HistoricalSquareAllocationCorrectionError("ALLOCATION_WRITE_FAILED", "The replacement allocation could not be recorded", 503);
      createdReplacements.push(replacement);
    }
    await tx.update(paymentAllocations).set({ state: "voided" }).where(and(
      eq(paymentAllocations.organizationId, input.organizationId),
      eq(paymentAllocations.leagueId, input.leagueId),
      inArray(paymentAllocations.id, changedSources.map((row) => row.id)),
      eq(paymentAllocations.state, "active"),
    ));
    const createdCorrections = [];
    for (const [index, pair] of pairs.entries()) {
      const replacement = createdReplacements[index];
      if (!replacement) throw new HistoricalSquareAllocationCorrectionError("CORRECTION_WRITE_FAILED", "The replacement allocation evidence could not be linked", 503);
      const [correction] = await tx.insert(paymentAllocationCorrections).values({
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        paymentId: payment.id,
        sourceAllocationId: pair.source.id,
        replacementAllocationId: replacement.id,
        sourceObligationId: pair.source.obligationId,
        targetObligationId: pair.target.obligationId,
        amountMinor: pair.source.amountMinor,
        currency: payment.currency,
        reason: request.reason,
        recordedByUserId: input.actorUserId,
      }).returning();
      if (!correction) throw new HistoricalSquareAllocationCorrectionError("CORRECTION_WRITE_FAILED", "The correction evidence could not be recorded", 503);
      createdCorrections.push(correction);
    }

    const touchedObligationIds = [...new Set([...changedSourceObligationIds, ...replacementTargetIds])];
    const touchedObligations = await tx.select().from(paymentObligations).where(and(
      eq(paymentObligations.organizationId, input.organizationId),
      eq(paymentObligations.leagueId, input.leagueId),
      inArray(paymentObligations.id, touchedObligationIds),
    )).orderBy(asc(paymentObligations.id)).for("update");
    for (const obligation of touchedObligations) {
      const active = await tx.select({ id: paymentAllocations.id, amountMinor: paymentAllocations.amountMinor }).from(paymentAllocations).where(and(
        eq(paymentAllocations.organizationId, input.organizationId),
        eq(paymentAllocations.leagueId, input.leagueId),
        eq(paymentAllocations.obligationId, obligation.id),
        eq(paymentAllocations.state, "active"),
      ));
      const adjustments = active.length === 0 ? [] : await tx.select({
        sourceAllocationId: refundAllocationAdjustments.sourceAllocationId,
        amountMinor: refundAllocationAdjustments.amountMinor,
        disposition: refundAllocationAdjustments.disposition,
      }).from(refundAllocationAdjustments).where(and(
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
      await tx.update(paymentObligations).set({
        state: balance.outstandingMinor === 0 ? "settled" : balance.effectiveAllocatedMinor > 0 ? "partially_settled" : "open",
        voidedAt: null,
      }).where(and(
        eq(paymentObligations.organizationId, input.organizationId),
        eq(paymentObligations.leagueId, input.leagueId),
        eq(paymentObligations.id, obligation.id),
      ));
    }

    const result: HistoricalSquareCorrectionResult = {
      contractVersion: "historical-square-allocation-correction/1",
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      paymentId: payment.id,
      paymentOperationId: operation.id,
      providerPaymentId: payment.providerPaymentId,
      amountMinor: payment.amount,
      providerMutation: "none",
      sourceAllocations: changedSources.map((row) => ({ allocationId: row.id, obligationId: row.obligationId, amountMinor: row.amountMinor, state: "voided" as const })),
      replacementAllocations: createdReplacements.map((row) => ({ allocationId: row.id, obligationId: row.obligationId, amountMinor: row.amountMinor, state: "active" as const })),
      corrections: createdCorrections.map((row) => ({ id: row.id, sourceAllocationId: row.sourceAllocationId, replacementAllocationId: row.replacementAllocationId, sourceObligationId: row.sourceObligationId, targetObligationId: row.targetObligationId, amountMinor: row.amountMinor })),
    };
    await tx.update(financialCommands).set({ state: "applied", result }).where(and(
      eq(financialCommands.organizationId, input.organizationId),
      eq(financialCommands.leagueId, input.leagueId),
      eq(financialCommands.commandType, COMMAND_TYPE),
      eq(financialCommands.idempotencyKey, request.idempotencyKey),
    ));
    return result;
  });
}
