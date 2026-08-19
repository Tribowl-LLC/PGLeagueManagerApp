import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  bowlerOccurrenceEligibilities,
  bowlerOccurrenceObligations,
  bowlerOccurrenceTeamAssignments,
  financialActivations,
  financialActivationRevisions,
  financialResponsibilities,
  bowlerOccurrenceEligibilityRevisions,
  bowlerOccurrenceTeamAssignmentRevisions,
  paymentOccurrenceAllocations,
  paymentOperationOccurrenceSnapshotAllocations,
  paymentOperationOccurrenceSnapshots,
  paymentOperations,
  payments,
  occurrenceCollectionPlanItems,
  occurrenceCollectionPlans,
} from "@shared/schema";
import type { PaymentOperationTransaction } from "../storage/payment-operations.js";
import { db } from "../db.js";
import { canonicalizePaymentOperationInput, normalizeInteractiveOccurrenceSelections } from "./payment-operation-idempotency.js";
import { loadOperationalActivationEvidence } from "./canonical-due-past-due.js";
import {
  PAYMENT_OPERATION_OCCURRENCE_SNAPSHOT_CONTRACT,
  fingerprintPaymentOperationOccurrenceSnapshot,
  validatePaymentOperationOccurrenceSnapshot,
  type PaymentOperationOccurrenceSnapshotV1,
} from "./payment-operation-occurrence-snapshot.js";

export const INTERACTIVE_OCCURRENCE_QUOTE_CONTRACT = "interactive-obligation-quote/1" as const;
export const INTERACTIVE_OCCURRENCE_QUOTE_ORDER = "due-at,bowler,occurrence,obligation/1" as const;

export type InteractiveOccurrenceSelection = {
  obligationId: string;
  amountMinor: number;
};

export type InteractiveOccurrenceQuoteRow = {
  obligationId: string;
  occurrenceId: string;
  bowlerId: number;
  amountMinor: number;
  allocatedMinor: number;
  outstandingMinor: number;
  currency: string;
  dueAt: string | null;
  disposition?: "available" | "reserved_by_ready_autopay_plan";
};

export type InteractiveOccurrenceQuote = {
  contractVersion: typeof INTERACTIVE_OCCURRENCE_QUOTE_CONTRACT;
  orderVersion: typeof INTERACTIVE_OCCURRENCE_QUOTE_ORDER;
  organizationId: number;
  leagueId: number;
  currency: string;
  amountMinor: number;
  activationId: string;
  activationSourceFingerprint: string;
  rows: InteractiveOccurrenceQuoteRow[];
  reservedByReadyAutopayPlan?: Array<{ obligationId: string; amountMinor: number; disposition: "reserved_by_ready_autopay_plan" }>;
  selections: InteractiveOccurrenceSelection[];
  fingerprint: string;
};

export class InteractiveOccurrenceAllocationError extends Error {
  constructor(public readonly code: string, message = "Interactive payment allocation is unavailable") {
    super(message);
    this.name = "InteractiveOccurrenceAllocationError";
  }
}

function positiveMinor(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function fingerprint(value: unknown): string {
  return `lvpayquote:v1:${createHash("sha256").update(canonicalizePaymentOperationInput(value)).digest("hex")}`;
}

/** Preparation invariant: occurrence evidence and the immutable payment
 * snapshot must describe exactly the same bowler set and per-bowler totals. */
export function validateInteractiveOccurrenceBaseAllocations(
  occurrenceAllocations: Array<{ bowlerId: number; amountMinor: number }>,
  baseAllocations: Array<{ bowlerId: number; amountMinor: number }>,
): void {
  const totals = (rows: Array<{ bowlerId: number; amountMinor: number }>) => {
    const result = new Map<number, number>();
    for (const row of rows) result.set(row.bowlerId, (result.get(row.bowlerId) ?? 0) + row.amountMinor);
    return result;
  };
  const selected = totals(occurrenceAllocations);
  const base = totals(baseAllocations);
  if (selected.size !== base.size || [...base].some(([bowlerId, amountMinor]) => selected.get(bowlerId) !== amountMinor)) {
    throw new InteractiveOccurrenceAllocationError("BASE_ALLOCATION_MISMATCH");
  }
}

export function validateInteractiveOccurrenceSelections(
  rows: Array<{ obligationId: string; outstandingMinor: number }>,
  selections: InteractiveOccurrenceSelection[],
  amountMinor: number,
): void {
  const byId = new Map(rows.map((row) => [row.obligationId, row]));
  const seen = new Set<string>();
  let total = 0;
  for (const selection of selections) {
    const row = byId.get(selection.obligationId);
    if (!row || seen.has(selection.obligationId) || !positiveMinor(selection.amountMinor) || selection.amountMinor > row.outstandingMinor) {
      throw new InteractiveOccurrenceAllocationError("INVALID_SELECTION");
    }
    seen.add(selection.obligationId);
    total += selection.amountMinor;
  }
  if (selections.length > 0 && total !== amountMinor) throw new InteractiveOccurrenceAllocationError("AMOUNT_MISMATCH");
}

/** A ready F3 plan owns only its reserved slice. F2 may still collect an
 * exact positive unreserved remainder, but any attempt to consume the
 * reserved slice (or a larger amount) must stop explicitly. */
export function hasReadyAutopayReservationConflict(
  rows: Array<{ obligationId: string; outstandingMinor: number; f3ReservedMinor: number }>,
  selections: InteractiveOccurrenceSelection[],
): boolean {
  const byId = new Map(rows.map((row) => [row.obligationId, row]));
  return selections.some((selection) => {
    const row = byId.get(selection.obligationId);
    return row !== undefined && row.f3ReservedMinor > 0 && selection.amountMinor > row.outstandingMinor;
  });
}

type LockedObligation = InteractiveOccurrenceQuoteRow & { state: string; reviewRequired: boolean; reservedMinor: number; f3ReservedMinor: number };

async function lockCanonicalEvidence(
  tx: PaymentOperationTransaction,
  input: { organizationId: number; leagueId: number; currency: string },
  excludeOperationId?: string,
): Promise<{ activationId: string; sourceFingerprint: string; obligations: LockedObligation[] }> {
  const [activation] = await tx.select({
    id: financialActivations.id,
    sourceFingerprint: financialActivations.sourceFingerprint,
    expectedGroupCount: financialActivations.expectedGroupCount,
    expectedResponsibilityCount: financialActivations.expectedResponsibilityCount,
    currentRevision: financialActivations.currentRevision,
  }).from(financialActivations).where(and(
    eq(financialActivations.organizationId, input.organizationId),
    eq(financialActivations.leagueId, input.leagueId),
    eq(financialActivations.state, "active"),
    eq(financialActivations.completenessMarker, true),
  )).limit(1).for("update");
  if (!activation) {
    const [activationEvidence] = await tx.select({ id: financialActivations.id }).from(financialActivations).where(and(
      eq(financialActivations.organizationId, input.organizationId),
      eq(financialActivations.leagueId, input.leagueId),
    )).limit(1);
    const [responsibilityEvidence] = await tx.select({ id: financialResponsibilities.id }).from(financialResponsibilities).where(and(
      eq(financialResponsibilities.organizationId, input.organizationId),
      eq(financialResponsibilities.leagueId, input.leagueId),
    )).limit(1);
    const [obligationEvidence] = await tx.select({ id: bowlerOccurrenceObligations.id }).from(bowlerOccurrenceObligations).where(and(
      eq(bowlerOccurrenceObligations.organizationId, input.organizationId),
      eq(bowlerOccurrenceObligations.leagueId, input.leagueId),
    )).limit(1);
    const [eligibilityEvidence] = await tx.select({ id: bowlerOccurrenceEligibilities.id }).from(bowlerOccurrenceEligibilities).where(and(
      eq(bowlerOccurrenceEligibilities.organizationId, input.organizationId),
      eq(bowlerOccurrenceEligibilities.leagueId, input.leagueId),
    )).limit(1);
    const [assignmentEvidence] = await tx.select({ id: bowlerOccurrenceTeamAssignments.id }).from(bowlerOccurrenceTeamAssignments).where(and(
      eq(bowlerOccurrenceTeamAssignments.organizationId, input.organizationId),
      eq(bowlerOccurrenceTeamAssignments.leagueId, input.leagueId),
    )).limit(1);
    if (activationEvidence || responsibilityEvidence || obligationEvidence || eligibilityEvidence || assignmentEvidence) throw new InteractiveOccurrenceAllocationError("CANONICAL_EVIDENCE_INCOMPATIBLE");
    return { activationId: "", sourceFingerprint: "", obligations: [] };
  }
  const [activationRevision] = await tx.select({
    revisionNumber: financialActivationRevisions.revisionNumber,
    snapshotSchemaVersion: financialActivationRevisions.snapshotSchemaVersion,
    afterSnapshot: financialActivationRevisions.afterSnapshot,
  }).from(financialActivationRevisions).where(and(
    eq(financialActivationRevisions.organizationId, input.organizationId),
    eq(financialActivationRevisions.leagueId, input.leagueId),
    eq(financialActivationRevisions.activationId, activation.id),
    eq(financialActivationRevisions.revisionNumber, 1),
  )).limit(1).for("share");
  const activationAfter = activationRevision?.afterSnapshot as { sourceFingerprint?: unknown; expectedResponsibilityCount?: unknown } | undefined;
  if (activationRevision?.snapshotSchemaVersion !== 1 || activation.currentRevision !== 1
    || activationAfter?.sourceFingerprint !== activation.sourceFingerprint
    || activationAfter?.expectedResponsibilityCount !== activation.expectedResponsibilityCount) {
    throw new InteractiveOccurrenceAllocationError("CANONICAL_EVIDENCE_INCOMPATIBLE");
  }
  try {
    const source = await loadOperationalActivationEvidence(tx, input);
    if (source.authoritativeSource !== "canonical" || source.sourceFingerprint !== activation.sourceFingerprint
      || source.expected.length !== activation.expectedGroupCount) {
      throw new InteractiveOccurrenceAllocationError("CANONICAL_EVIDENCE_INCOMPATIBLE");
    }
  } catch (error) {
    if (error instanceof InteractiveOccurrenceAllocationError) throw error;
    throw new InteractiveOccurrenceAllocationError("CANONICAL_EVIDENCE_INCOMPATIBLE");
  }

  const responsibilities = await tx.select({
    eligibilityId: financialResponsibilities.eligibilityId,
    assignmentId: financialResponsibilities.assignmentId,
    provenance: financialResponsibilities.provenance,
    obligationId: financialResponsibilities.obligationId,
    occurrenceId: financialResponsibilities.occurrenceId,
    bowlerId: financialResponsibilities.bowlerId,
    amountMinor: financialResponsibilities.amountMinor,
    currency: financialResponsibilities.currency,
    dueAt: financialResponsibilities.dueAt,
    eligibilityState: bowlerOccurrenceEligibilities.state,
    assignmentState: bowlerOccurrenceTeamAssignments.state,
    eligibilityReason: bowlerOccurrenceEligibilities.reason,
    assignmentReason: bowlerOccurrenceTeamAssignments.reason,
    eligibilityRevision: bowlerOccurrenceEligibilities.currentRevision,
    assignmentRevision: bowlerOccurrenceTeamAssignments.currentRevision,
  }).from(financialResponsibilities)
    .innerJoin(bowlerOccurrenceEligibilities, and(
      eq(bowlerOccurrenceEligibilities.id, financialResponsibilities.eligibilityId),
      eq(bowlerOccurrenceEligibilities.organizationId, input.organizationId),
    ))
    .innerJoin(bowlerOccurrenceTeamAssignments, and(
      eq(bowlerOccurrenceTeamAssignments.id, financialResponsibilities.assignmentId),
      eq(bowlerOccurrenceTeamAssignments.organizationId, input.organizationId),
    ))
    .where(and(
      eq(financialResponsibilities.organizationId, input.organizationId),
      eq(financialResponsibilities.leagueId, input.leagueId),
      eq(financialResponsibilities.activationId, activation.id),
    )).for("share");
  if (responsibilities.length !== activation.expectedResponsibilityCount
    || responsibilities.length === 0
    || responsibilities.some((row) => row.eligibilityState !== "eligible" || row.assignmentState !== "assigned"
      || row.eligibilityReason !== row.provenance || row.assignmentReason !== row.provenance)) {
    throw new InteractiveOccurrenceAllocationError("CANONICAL_EVIDENCE_INCOMPATIBLE");
  }
  const eligibilityRevisions = await tx.select({
    id: bowlerOccurrenceEligibilityRevisions.eligibilityId,
    revisionNumber: bowlerOccurrenceEligibilityRevisions.revisionNumber,
    snapshotSchemaVersion: bowlerOccurrenceEligibilityRevisions.snapshotSchemaVersion,
    afterSnapshot: bowlerOccurrenceEligibilityRevisions.afterSnapshot,
  }).from(bowlerOccurrenceEligibilityRevisions).where(and(
    eq(bowlerOccurrenceEligibilityRevisions.organizationId, input.organizationId),
    eq(bowlerOccurrenceEligibilityRevisions.leagueId, input.leagueId),
    inArray(bowlerOccurrenceEligibilityRevisions.eligibilityId, responsibilities.map((row) => row.eligibilityId)),
  ));
  const assignmentRevisions = await tx.select({
    id: bowlerOccurrenceTeamAssignmentRevisions.assignmentId,
    revisionNumber: bowlerOccurrenceTeamAssignmentRevisions.revisionNumber,
    snapshotSchemaVersion: bowlerOccurrenceTeamAssignmentRevisions.snapshotSchemaVersion,
    afterSnapshot: bowlerOccurrenceTeamAssignmentRevisions.afterSnapshot,
  }).from(bowlerOccurrenceTeamAssignmentRevisions).where(and(
    eq(bowlerOccurrenceTeamAssignmentRevisions.organizationId, input.organizationId),
    eq(bowlerOccurrenceTeamAssignmentRevisions.leagueId, input.leagueId),
    inArray(bowlerOccurrenceTeamAssignmentRevisions.assignmentId, responsibilities.map((row) => row.assignmentId)),
  ));
  for (const row of responsibilities) {
    const eligibility = eligibilityRevisions.find((revision) => revision.id === row.eligibilityId && revision.revisionNumber === row.eligibilityRevision);
    const assignment = assignmentRevisions.find((revision) => revision.id === row.assignmentId && revision.revisionNumber === row.assignmentRevision);
    const eligibilityAfter = eligibility?.afterSnapshot as { state?: unknown; reason?: unknown } | undefined;
    const assignmentAfter = assignment?.afterSnapshot as { state?: unknown; reason?: unknown } | undefined;
    if (eligibility?.snapshotSchemaVersion !== 1 || eligibilityAfter?.state !== "eligible" || eligibilityAfter.reason !== row.provenance
      || assignment?.snapshotSchemaVersion !== 1 || assignmentAfter?.state !== "assigned" || assignmentAfter.reason !== row.provenance) {
      throw new InteractiveOccurrenceAllocationError("CANONICAL_EVIDENCE_INCOMPATIBLE");
    }
  }

  const obligationIds = [...new Set(responsibilities.map((row) => row.obligationId))];
  const obligations = await tx.select().from(bowlerOccurrenceObligations).where(and(
    eq(bowlerOccurrenceObligations.organizationId, input.organizationId),
    eq(bowlerOccurrenceObligations.leagueId, input.leagueId),
    inArray(bowlerOccurrenceObligations.id, obligationIds),
    eq(bowlerOccurrenceObligations.currency, input.currency),
  )).orderBy(asc(bowlerOccurrenceObligations.dueAt), asc(bowlerOccurrenceObligations.bowlerId), asc(bowlerOccurrenceObligations.occurrenceId), asc(bowlerOccurrenceObligations.id)).for("update");
  if (obligations.length !== obligationIds.length) throw new InteractiveOccurrenceAllocationError("CANONICAL_EVIDENCE_INCOMPATIBLE");

  const existing = await tx.select({
    obligationId: paymentOccurrenceAllocations.obligationId,
    amountMinor: paymentOccurrenceAllocations.amountMinor,
    paymentStatus: payments.status,
    paymentOperationId: payments.paymentOperationId,
  }).from(paymentOccurrenceAllocations)
    .innerJoin(payments, eq(payments.id, paymentOccurrenceAllocations.paymentId))
    .where(and(
      eq(paymentOccurrenceAllocations.organizationId, input.organizationId),
      eq(paymentOccurrenceAllocations.leagueId, input.leagueId),
      inArray(paymentOccurrenceAllocations.obligationId, obligationIds),
      eq(paymentOccurrenceAllocations.state, "active"),
    )).for("share");
  const pending = await tx.select({
    obligationId: paymentOperationOccurrenceSnapshotAllocations.obligationId,
    amountMinor: paymentOperationOccurrenceSnapshotAllocations.amountMinor,
  }).from(paymentOperationOccurrenceSnapshotAllocations)
    .innerJoin(paymentOperations, eq(paymentOperations.id, paymentOperationOccurrenceSnapshotAllocations.operationId))
    .where(and(
      eq(paymentOperationOccurrenceSnapshotAllocations.organizationId, input.organizationId),
      eq(paymentOperationOccurrenceSnapshotAllocations.leagueId, input.leagueId),
      inArray(paymentOperationOccurrenceSnapshotAllocations.obligationId, obligationIds),
      inArray(paymentOperations.status, ["pending", "leased", "provider_unknown", "retry_scheduled", "reconciliation_required"]),
      excludeOperationId ? ne(paymentOperationOccurrenceSnapshotAllocations.operationId, excludeOperationId) : undefined,
    )).for("share");
  // Canonical F3 ready plans reserve exact capacity independently of a
  // payment operation. F2 must include those reservations while holding the
  // same obligation locks, so a stale quote cannot bypass a ready plan.
  const f3Reservations = await tx.select({
    obligationId: occurrenceCollectionPlanItems.obligationId,
    amountMinor: occurrenceCollectionPlanItems.amountMinor,
  }).from(occurrenceCollectionPlanItems)
    .innerJoin(occurrenceCollectionPlans, and(
      eq(occurrenceCollectionPlans.id, occurrenceCollectionPlanItems.planId),
      eq(occurrenceCollectionPlans.organizationId, input.organizationId),
      eq(occurrenceCollectionPlans.leagueId, input.leagueId),
      eq(occurrenceCollectionPlans.state, "ready"),
    ))
    .where(and(
      eq(occurrenceCollectionPlanItems.organizationId, input.organizationId),
      eq(occurrenceCollectionPlanItems.leagueId, input.leagueId),
      inArray(occurrenceCollectionPlanItems.obligationId, obligationIds),
    )).for("share");
  const byObligation = new Map<string, { allocated: number; reserved: number; f3Reserved: number; review: boolean }>();
  for (const row of existing) {
    const prior = byObligation.get(row.obligationId) ?? { allocated: 0, reserved: 0, f3Reserved: 0, review: false };
    // An exact replay of a completed operation must see its own settled
    // amount restored while re-validating the immutable supplement. Other
    // operations remain conservation evidence and cannot be excluded.
    if (row.paymentStatus === "paid") {
      if (row.paymentOperationId !== excludeOperationId) prior.allocated += row.amountMinor;
    } else {
      prior.review = true;
    }
    byObligation.set(row.obligationId, prior);
  }
  for (const row of pending) {
    const prior = byObligation.get(row.obligationId) ?? { allocated: 0, reserved: 0, f3Reserved: 0, review: false };
    prior.reserved += row.amountMinor;
    byObligation.set(row.obligationId, prior);
  }
  for (const row of f3Reservations) {
    const prior = byObligation.get(row.obligationId) ?? { allocated: 0, reserved: 0, f3Reserved: 0, review: false };
    prior.f3Reserved += row.amountMinor;
    prior.reserved += row.amountMinor;
    byObligation.set(row.obligationId, prior);
  }
  const responsibilityByObligation = new Map(responsibilities.map((row) => [row.obligationId, row]));
  const rows: LockedObligation[] = [];
  for (const obligation of obligations) {
    const responsibility = responsibilityByObligation.get(obligation.id);
    const prior = byObligation.get(obligation.id) ?? { allocated: 0, reserved: 0, f3Reserved: 0, review: false };
    if (!responsibility || responsibility.amountMinor !== obligation.amountMinor || responsibility.currency !== obligation.currency) {
      throw new InteractiveOccurrenceAllocationError("CANONICAL_EVIDENCE_INCOMPATIBLE");
    }
    rows.push({
      obligationId: obligation.id,
      occurrenceId: obligation.occurrenceId,
      bowlerId: obligation.bowlerId,
      amountMinor: obligation.amountMinor,
      allocatedMinor: prior.allocated,
      outstandingMinor: Math.max(0, obligation.amountMinor - prior.allocated - prior.reserved),
      reservedMinor: prior.reserved,
      f3ReservedMinor: prior.f3Reserved,
      currency: obligation.currency,
      dueAt: obligation.dueAt,
      state: obligation.state,
      reviewRequired: prior.review,
    });
  }
  return { activationId: activation.id, sourceFingerprint: activation.sourceFingerprint, obligations: rows };
}

export async function getInteractiveOccurrenceActivation(input: { organizationId: number; leagueId: number }): Promise<boolean> {
  const [row] = await db.select({ id: financialActivations.id, state: financialActivations.state, completenessMarker: financialActivations.completenessMarker }).from(financialActivations).where(and(
    eq(financialActivations.organizationId, input.organizationId),
    eq(financialActivations.leagueId, input.leagueId),
  )).limit(1);
  if (row && (row.state !== "active" || row.completenessMarker !== true)) {
    throw new InteractiveOccurrenceAllocationError("CANONICAL_EVIDENCE_INCOMPATIBLE");
  }
  if (!row) {
    const evidence = await db.execute(sql`SELECT EXISTS (
      SELECT 1 FROM financial_responsibilities WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
      UNION ALL SELECT 1 FROM bowler_occurrence_eligibilities WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
      UNION ALL SELECT 1 FROM bowler_occurrence_team_assignments WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
      UNION ALL SELECT 1 FROM bowler_occurrence_obligations WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
      UNION ALL SELECT 1 FROM occurrence_collection_plans WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
      UNION ALL SELECT 1 FROM occurrence_collection_plan_items WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
      UNION ALL SELECT 1 FROM occurrence_collection_plan_revisions WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
      UNION ALL SELECT 1 FROM payment_occurrence_allocations WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
      UNION ALL SELECT 1 FROM payment_occurrence_allocation_revisions WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
      UNION ALL SELECT 1 FROM payment_operation_occurrence_snapshots WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
      UNION ALL SELECT 1 FROM payment_operation_occurrence_snapshot_allocations WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
    ) AS present`);
    if ((evidence.rows[0] as { present?: boolean } | undefined)?.present === true) {
      throw new InteractiveOccurrenceAllocationError("CANONICAL_EVIDENCE_INCOMPATIBLE");
    }
  }
  return row !== undefined;
}

export async function quoteInteractiveOccurrenceAllocations(input: {
  organizationId: number;
  leagueId: number;
  amountMinor: number;
  currency: string;
  selections?: InteractiveOccurrenceSelection[];
  allowedBowlerIds?: number[];
  excludeOperationId?: string;
}): Promise<InteractiveOccurrenceQuote> {
  if (!positiveMinor(input.amountMinor)) throw new InteractiveOccurrenceAllocationError("INVALID_AMOUNT");
  return db.transaction(async (tx) => buildQuote(tx, input));
}

async function buildQuote(tx: PaymentOperationTransaction, input: {
  organizationId: number;
  leagueId: number;
  amountMinor: number;
  currency: string;
  selections?: InteractiveOccurrenceSelection[];
  excludeOperationId?: string;
  allowedBowlerIds?: number[];
}): Promise<InteractiveOccurrenceQuote> {
  const evidence = await lockCanonicalEvidence(tx, input, input.excludeOperationId);
  const allowed = input.allowedBowlerIds ? new Set(input.allowedBowlerIds) : undefined;
  const rows = evidence.obligations.filter((row) => row.state !== "voided" && !row.reviewRequired && row.outstandingMinor > 0 && (!allowed || allowed.has(row.bowlerId)));
  const publicRows: InteractiveOccurrenceQuoteRow[] = rows.map(({ reviewRequired: _reviewRequired, reservedMinor: _reservedMinor, f3ReservedMinor: _f3ReservedMinor, ...row }) => ({ ...row, disposition: "available" as const }));
  const reservedByReadyAutopayPlan = evidence.obligations.filter((row) => row.f3ReservedMinor > 0).map((row) => ({ obligationId: row.obligationId, amountMinor: row.f3ReservedMinor, disposition: "reserved_by_ready_autopay_plan" as const }));
  const selections = (input.selections ?? []).map((row) => ({ obligationId: row.obligationId, amountMinor: row.amountMinor }));
  if (hasReadyAutopayReservationConflict(evidence.obligations, selections)) throw new InteractiveOccurrenceAllocationError("OBLIGATION_RESERVED_BY_AUTOPAY");
  validateInteractiveOccurrenceSelections(publicRows, selections, input.amountMinor);
  const result: InteractiveOccurrenceQuote = {
    contractVersion: INTERACTIVE_OCCURRENCE_QUOTE_CONTRACT,
    orderVersion: INTERACTIVE_OCCURRENCE_QUOTE_ORDER,
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    currency: input.currency,
    amountMinor: input.amountMinor,
    activationId: evidence.activationId,
    activationSourceFingerprint: evidence.sourceFingerprint,
    rows: publicRows,
    reservedByReadyAutopayPlan,
    selections,
    // This is the immutable base-evidence fingerprint. Explicit selections
    // are bound separately by the operation supplement and validated against
    // these rows at preparation; excluding them lets the selector obtain a
    // base quote before the user has finished choosing rows.
    fingerprint: fingerprint({ contractVersion: INTERACTIVE_OCCURRENCE_QUOTE_CONTRACT, orderVersion: INTERACTIVE_OCCURRENCE_QUOTE_ORDER, organizationId: input.organizationId, leagueId: input.leagueId, currency: input.currency, amountMinor: input.amountMinor, activationId: evidence.activationId, activationSourceFingerprint: evidence.sourceFingerprint, rows: publicRows }),
  };
  return result;
}

export async function persistInteractiveOccurrenceSnapshot(
  tx: PaymentOperationTransaction,
  operation: { id: string; organizationId: number; amountMinor: number; currency: string; operationType: string; authorizingUserId?: number | null },
  input: { leagueId: number; selections: InteractiveOccurrenceSelection[]; quoteFingerprint?: string; baseAllocations?: Array<{ bowlerId: number; amountMinor: number }> },
): Promise<void> {
  const normalizedSelections = normalizeInteractiveOccurrenceSelections(input.selections);
  if (operation.operationType !== "interactive_charge") throw new InteractiveOccurrenceAllocationError("INVALID_OPERATION");
  const [existingSupplement] = await tx.select().from(paymentOperationOccurrenceSnapshots)
    .where(eq(paymentOperationOccurrenceSnapshots.operationId, operation.id)).limit(1).for("update");
  if (operation.authorizingUserId == null) {
    throw new InteractiveOccurrenceAllocationError("PRE_F2_OPERATION");
  }
  const storedSelections = existingSupplement
    ? await tx.select({ obligationId: paymentOperationOccurrenceSnapshotAllocations.obligationId, amountMinor: paymentOperationOccurrenceSnapshotAllocations.amountMinor })
      .from(paymentOperationOccurrenceSnapshotAllocations)
      .where(eq(paymentOperationOccurrenceSnapshotAllocations.operationId, operation.id))
      .orderBy(asc(paymentOperationOccurrenceSnapshotAllocations.allocationIndex))
    : [];
  if (existingSupplement && (storedSelections.length !== normalizedSelections.length
    || storedSelections.some((row, index) => row.obligationId !== normalizedSelections[index]?.obligationId || row.amountMinor !== normalizedSelections[index]?.amountMinor))) {
    throw new InteractiveOccurrenceAllocationError("IMMUTABLE_SELECTION_MISMATCH");
  }
  const quote = await buildQuote(tx, { organizationId: operation.organizationId, leagueId: input.leagueId, amountMinor: operation.amountMinor, currency: operation.currency, selections: normalizedSelections, excludeOperationId: operation.id, allowedBowlerIds: input.baseAllocations?.map((allocation) => allocation.bowlerId) });
  // Canonical F2 intent is always bound to the quote's immutable base
  // evidence. A missing fingerprint is not a legacy fallback once a
  // supplement is requested; it is an unbound/stale quote.
  if (!input.quoteFingerprint || input.quoteFingerprint !== quote.fingerprint) {
    throw new InteractiveOccurrenceAllocationError("STALE_QUOTE");
  }
  if (quote.selections.length === 0) throw new InteractiveOccurrenceAllocationError("SELECTION_REQUIRED");
  const byId = new Map(quote.rows.map((row) => [row.obligationId, row]));
  const semantic: PaymentOperationOccurrenceSnapshotV1 = {
    contractVersion: "payment-operation-occurrence-snapshot/1",
    snapshotVersion: 1,
    operationId: operation.id,
    operationType: "interactive_charge",
    organizationId: operation.organizationId,
    leagueId: input.leagueId,
    amountMinor: operation.amountMinor,
    currency: operation.currency,
    allocations: quote.selections.map((selection, allocationIndex) => {
      const row = byId.get(selection.obligationId);
      if (!row) throw new InteractiveOccurrenceAllocationError("INVALID_SELECTION");
      return { allocationIndex, organizationId: operation.organizationId, leagueId: input.leagueId, occurrenceId: row.occurrenceId, bowlerId: row.bowlerId, obligationId: row.obligationId, amountMinor: selection.amountMinor, currency: operation.currency };
    }),
  };
  if (input.baseAllocations) {
    validateInteractiveOccurrenceBaseAllocations(semantic.allocations, input.baseAllocations);
  }
  if (existingSupplement) return;
  await tx.insert(paymentOperationOccurrenceSnapshots).values({ operationId: operation.id, organizationId: operation.organizationId, leagueId: input.leagueId, snapshotFingerprint: fingerprintPaymentOperationOccurrenceSnapshot(semantic), amountMinor: operation.amountMinor, currency: operation.currency, allocationCount: semantic.allocations.length }).onConflictDoNothing();
  await tx.insert(paymentOperationOccurrenceSnapshotAllocations).values(semantic.allocations.map((row) => ({
    ...row,
    operationId: operation.id,
    snapshotVersion: semantic.snapshotVersion,
  }))).onConflictDoNothing();
}

/**
 * Validates a completed operation replay against its immutable supplement.
 * This intentionally does not quote live outstanding balances: a later
 * operation may have settled the same obligation while the original logical
 * operation must still reconstruct its already-completed provider result.
 */
export async function validateInteractiveOccurrenceReplay(input: {
  operationId: string;
  organizationId: number;
  leagueId: number;
  amountMinor: number;
  currency: string;
  selections?: InteractiveOccurrenceSelection[];
}): Promise<void> {
  const normalizedSelections = input.selections === undefined
    ? undefined
    : normalizeInteractiveOccurrenceSelections(input.selections);
  await db.transaction(async (tx) => {
    const [supplement] = await tx.select().from(paymentOperationOccurrenceSnapshots)
      .where(and(
        eq(paymentOperationOccurrenceSnapshots.operationId, input.operationId),
        eq(paymentOperationOccurrenceSnapshots.organizationId, input.organizationId),
        eq(paymentOperationOccurrenceSnapshots.leagueId, input.leagueId),
      )).limit(1).for("share");
    if (!supplement) {
      if (input.selections === undefined) return;
      throw new InteractiveOccurrenceAllocationError("PRE_F2_OPERATION");
    }
    if (normalizedSelections === undefined
      || supplement.amountMinor !== input.amountMinor
      || supplement.currency !== input.currency
      || supplement.allocationCount !== normalizedSelections.length) {
      throw new InteractiveOccurrenceAllocationError("IMMUTABLE_SELECTION_MISMATCH");
    }
    const rows = await tx.select().from(paymentOperationOccurrenceSnapshotAllocations)
      .where(and(
        eq(paymentOperationOccurrenceSnapshotAllocations.operationId, input.operationId),
        eq(paymentOperationOccurrenceSnapshotAllocations.organizationId, input.organizationId),
        eq(paymentOperationOccurrenceSnapshotAllocations.leagueId, input.leagueId),
      )).orderBy(asc(paymentOperationOccurrenceSnapshotAllocations.allocationIndex));
    if (rows.length !== supplement.allocationCount || rows.some((row, index) => (
      row.allocationIndex !== index
      || row.obligationId !== normalizedSelections?.[index]?.obligationId
      || row.amountMinor !== normalizedSelections?.[index]?.amountMinor
    ))) {
      throw new InteractiveOccurrenceAllocationError("IMMUTABLE_SELECTION_MISMATCH");
    }
    const semantic = validatePaymentOperationOccurrenceSnapshot({
      contractVersion: PAYMENT_OPERATION_OCCURRENCE_SNAPSHOT_CONTRACT,
      snapshotVersion: supplement.snapshotVersion,
      operationId: input.operationId,
      operationType: "interactive_charge",
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      allocations: rows.map((row) => ({
        allocationIndex: row.allocationIndex,
        organizationId: row.organizationId,
        leagueId: row.leagueId,
        occurrenceId: row.occurrenceId,
        bowlerId: row.bowlerId,
        obligationId: row.obligationId,
        amountMinor: row.amountMinor,
        currency: row.currency,
      })),
    });
    if (fingerprintPaymentOperationOccurrenceSnapshot(semantic) !== supplement.snapshotFingerprint) {
      throw new InteractiveOccurrenceAllocationError("CANONICAL_EVIDENCE_INCOMPATIBLE");
    }
  });
}
