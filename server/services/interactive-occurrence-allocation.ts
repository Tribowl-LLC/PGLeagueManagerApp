import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  bowlerOccurrenceEligibilities,
  bowlerOccurrenceObligations,
  bowlerOccurrenceTeamAssignments,
  financialActivations,
  financialResponsibilities,
  paymentOccurrenceAllocations,
  paymentOperationOccurrenceSnapshotAllocations,
  paymentOperationOccurrenceSnapshots,
  paymentOperations,
  payments,
} from "@shared/schema";
import type { PaymentOperationTransaction } from "../storage/payment-operations.js";
import { db } from "../db.js";
import { canonicalizePaymentOperationInput } from "./payment-operation-idempotency.js";
import {
  fingerprintPaymentOperationOccurrenceSnapshot,
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

type LockedObligation = InteractiveOccurrenceQuoteRow & { state: string; reviewRequired: boolean };

async function lockCanonicalEvidence(
  tx: PaymentOperationTransaction,
  input: { organizationId: number; leagueId: number; currency: string },
): Promise<{ activationId: string; sourceFingerprint: string; obligations: LockedObligation[] }> {
  const [activation] = await tx.select({
    id: financialActivations.id,
    sourceFingerprint: financialActivations.sourceFingerprint,
    expectedResponsibilityCount: financialActivations.expectedResponsibilityCount,
  }).from(financialActivations).where(and(
    eq(financialActivations.organizationId, input.organizationId),
    eq(financialActivations.leagueId, input.leagueId),
    eq(financialActivations.state, "active"),
    eq(financialActivations.completenessMarker, true),
  )).limit(1).for("update");
  if (!activation) throw new InteractiveOccurrenceAllocationError("CANONICAL_LEGACY_FALLBACK");

  const responsibilities = await tx.select({
    obligationId: financialResponsibilities.obligationId,
    occurrenceId: financialResponsibilities.occurrenceId,
    bowlerId: financialResponsibilities.bowlerId,
    amountMinor: financialResponsibilities.amountMinor,
    currency: financialResponsibilities.currency,
    dueAt: financialResponsibilities.dueAt,
    eligibilityState: bowlerOccurrenceEligibilities.state,
    assignmentState: bowlerOccurrenceTeamAssignments.state,
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
    || responsibilities.some((row) => row.eligibilityState !== "eligible" || row.assignmentState !== "assigned")) {
    throw new InteractiveOccurrenceAllocationError("CANONICAL_EVIDENCE_INCOMPATIBLE");
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
    )).for("share");
  const byObligation = new Map<string, { allocated: number; reserved: number; review: boolean }>();
  for (const row of existing) {
    const prior = byObligation.get(row.obligationId) ?? { allocated: 0, reserved: 0, review: false };
    if (row.paymentStatus === "paid") prior.allocated += row.amountMinor;
    else prior.review = true;
    byObligation.set(row.obligationId, prior);
  }
  for (const row of pending) {
    const prior = byObligation.get(row.obligationId) ?? { allocated: 0, reserved: 0, review: false };
    prior.reserved += row.amountMinor;
    byObligation.set(row.obligationId, prior);
  }
  const responsibilityByObligation = new Map(responsibilities.map((row) => [row.obligationId, row]));
  const rows: LockedObligation[] = [];
  for (const obligation of obligations) {
    const responsibility = responsibilityByObligation.get(obligation.id);
    const prior = byObligation.get(obligation.id) ?? { allocated: 0, reserved: 0, review: false };
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
      currency: obligation.currency,
      dueAt: obligation.dueAt,
      state: obligation.state,
      reviewRequired: prior.review,
    });
  }
  return { activationId: activation.id, sourceFingerprint: activation.sourceFingerprint, obligations: rows };
}

export async function getInteractiveOccurrenceActivation(input: { organizationId: number; leagueId: number }): Promise<boolean> {
  const [row] = await db.select({ id: financialActivations.id }).from(financialActivations).where(and(
    eq(financialActivations.organizationId, input.organizationId),
    eq(financialActivations.leagueId, input.leagueId),
    eq(financialActivations.state, "active"),
    eq(financialActivations.completenessMarker, true),
  )).limit(1);
  return row !== undefined;
}

export async function quoteInteractiveOccurrenceAllocations(input: {
  organizationId: number;
  leagueId: number;
  amountMinor: number;
  currency: string;
  selections?: InteractiveOccurrenceSelection[];
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
}): Promise<InteractiveOccurrenceQuote> {
  const evidence = await lockCanonicalEvidence(tx, input);
  const rows = evidence.obligations.filter((row) => row.state !== "voided" && !row.reviewRequired && row.outstandingMinor > 0);
  const publicRows: InteractiveOccurrenceQuoteRow[] = rows.map(({ reviewRequired: _reviewRequired, ...row }) => row);
  const selections = (input.selections ?? []).map((row) => ({ obligationId: row.obligationId, amountMinor: row.amountMinor }));
  const byId = new Map(publicRows.map((row) => [row.obligationId, row]));
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
  if (selections.length > 0 && total !== input.amountMinor) throw new InteractiveOccurrenceAllocationError("AMOUNT_MISMATCH");
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
    selections,
    fingerprint: fingerprint({ contractVersion: INTERACTIVE_OCCURRENCE_QUOTE_CONTRACT, orderVersion: INTERACTIVE_OCCURRENCE_QUOTE_ORDER, organizationId: input.organizationId, leagueId: input.leagueId, currency: input.currency, amountMinor: input.amountMinor, activationId: evidence.activationId, activationSourceFingerprint: evidence.sourceFingerprint, rows: publicRows, selections }),
  };
  return result;
}

export async function persistInteractiveOccurrenceSnapshot(
  tx: PaymentOperationTransaction,
  operation: { id: string; organizationId: number; amountMinor: number; currency: string; operationType: string },
  input: { leagueId: number; selections: InteractiveOccurrenceSelection[]; quoteFingerprint?: string },
): Promise<void> {
  if (operation.operationType !== "interactive_charge") throw new InteractiveOccurrenceAllocationError("INVALID_OPERATION");
  const quote = await buildQuote(tx, { organizationId: operation.organizationId, leagueId: input.leagueId, amountMinor: operation.amountMinor, currency: operation.currency, selections: input.selections });
  if (input.quoteFingerprint !== undefined && input.quoteFingerprint !== quote.fingerprint) {
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
  await tx.insert(paymentOperationOccurrenceSnapshots).values({ operationId: operation.id, organizationId: operation.organizationId, leagueId: input.leagueId, snapshotFingerprint: fingerprintPaymentOperationOccurrenceSnapshot(semantic), amountMinor: operation.amountMinor, currency: operation.currency, allocationCount: semantic.allocations.length }).onConflictDoNothing();
  await tx.insert(paymentOperationOccurrenceSnapshotAllocations).values(semantic.allocations.map((row) => ({
    ...row,
    operationId: operation.id,
    snapshotVersion: semantic.snapshotVersion,
  }))).onConflictDoNothing();
}
