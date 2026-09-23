import { and, asc, eq, inArray, sum } from "drizzle-orm";
import {
  paymentAllocations,
  paymentDisputes,
  refundAllocationAdjustments,
  paymentObligations,
  paymentOperations,
  payments,
  rotatingCreditApplicationReversals,
  rotatingCreditApplications,
  rotatingCreditFundings,
  rotatingCreditRefunds,
} from "@shared/schema";
import type { PaymentOperationTransaction } from "../storage/payment-operations.js";
import { canonicalObligationBalance } from "./refund-allocation-adjustments.js";
import { readConfirmedRotatingObligationsForCredit } from "./rotating-team-payments.js";
import { isCardPaymentType } from "@shared/schema/constants";

export class RotatingCreditLedgerError extends Error {
  constructor(public readonly code: string) {
    super("Rotating credit ledger evidence is unavailable or inconsistent");
    this.name = "RotatingCreditLedgerError";
  }
}

export interface RotatingCreditFundingBalance {
  fundingId: string;
  paymentId: number;
  bowlerId: number;
  amountMinor: number;
  appliedMinor: number;
  refundedMinor: number;
  refundHeldMinor: number;
  availableMinor: number;
  reviewHeldMinor: number;
  reviewRequired: boolean;
  createdAt: string;
}

const HELD_REFUND_STATUSES = new Set([
  "pending",
  "leased",
  "provider_unknown",
  "retry_scheduled",
  "action_required",
  "reconciliation_required",
]);

export function isRotatingCreditRefundHeldStatus(status: string): boolean {
  return HELD_REFUND_STATUSES.has(status);
}

export function isConfirmedSquareCreditRefundFailure(input: {
  status: string;
  providerObjectId: string | null;
  errorClassification: string | null;
  errorCode: string | null;
}): boolean {
  return input.status === "failed_terminal"
    && input.providerObjectId !== null
    && input.errorClassification === "invalid_request"
    && (input.errorCode === "REFUND_REJECTED" || input.errorCode === "REFUND_FAILED");
}

export function isSquareCreditRefundDeclined(input: {
  status: string;
  providerObjectId: string | null;
  errorClassification: string | null;
  errorCode: string | null;
}): boolean {
  return input.status === "action_required"
    && input.providerObjectId === null
    && input.errorClassification === "hard_decline"
    && input.errorCode === "REFUND_DECLINED";
}

export function isProviderRefundRetryBlocked(input: {
  status: string;
  providerObjectId: string | null;
  errorClassification: string | null;
  errorCode: string | null;
}): boolean {
  return isConfirmedSquareCreditRefundFailure(input) || isSquareCreditRefundDeclined(input);
}

export function isRotatingCreditProviderRefundAvailable(input: {
  fundingKind: string;
  fundingAmountMinor: number;
  fundingCurrency: string;
  paymentStatus: string;
  paymentAmountMinor: number;
  paymentCurrency: string;
  paymentType: string;
  paymentOperationId: string | null;
  providerPaymentId: string | null;
  locationId: number | null;
  operation: null | {
    id: string;
    organizationId: number;
    leagueId: number | null;
    operationType: string;
    status: string;
    providerName: string;
    providerObjectId: string | null;
    amountMinor: number;
    currency: string;
  };
  priorProviderRefundOperations: Array<{
    status: string;
    providerObjectId: string | null;
    errorClassification: string | null;
    errorCode: string | null;
  }>;
  organizationId: number;
  leagueId: number;
}): boolean {
  const operation = input.operation;
  if (input.fundingKind !== "provider"
    || input.fundingCurrency !== "USD"
    || input.paymentStatus !== "paid"
    || input.paymentAmountMinor !== input.fundingAmountMinor
    || input.paymentCurrency !== input.fundingCurrency
    || !isCardPaymentType(input.paymentType)
    || input.paymentOperationId === null
    || !input.providerPaymentId
    || input.locationId === null
    || !operation
    || operation.id !== input.paymentOperationId
    || operation.organizationId !== input.organizationId
    || operation.leagueId !== input.leagueId
    || operation.operationType !== "interactive_charge"
    || operation.status !== "succeeded"
    || operation.providerName !== "square"
    || operation.providerObjectId !== input.providerPaymentId
    || operation.amountMinor !== input.fundingAmountMinor
    || operation.currency !== input.fundingCurrency) return false;
  return !input.priorProviderRefundOperations.some(isProviderRefundRetryBlocked);
}

export function isConfirmedNoRefundCreditOutcome(input: {
  status: string;
  providerObjectId: string | null;
  errorClassification: string | null;
  errorCode: string | null;
}): boolean {
  return (input.status === "failed_terminal" && (
    input.providerObjectId === null || isConfirmedSquareCreditRefundFailure(input)
  )) || isSquareCreditRefundDeclined(input)
    || (input.status === "canceled" && input.providerObjectId === null);
}

export function spendableRotatingCreditObligationPrefix<T extends {
  reviewRequired: boolean;
  outstandingMinor: number;
}>(obligations: readonly T[]): T[] {
  const reviewBoundary = obligations.findIndex((obligation) => obligation.reviewRequired && obligation.outstandingMinor > 0);
  return obligations.slice(0, reviewBoundary < 0 ? obligations.length : reviewBoundary);
}

const REVIEW_DISPUTE_STATES = new Set([
  "INQUIRY_EVIDENCE_REQUIRED",
  "INQUIRY_PROCESSING",
  "EVIDENCE_REQUIRED",
  "PROCESSING",
  "LOST",
  "ACCEPTED",
]);

/**
 * Derive every personal lot's spendable amount from immutable funding,
 * active application, reversal and refund evidence. No balance is stored.
 */
export async function readRotatingCreditFundingBalancesInTransaction(
  tx: PaymentOperationTransaction,
  input: { organizationId: number; leagueId: number; bowlerId: number },
): Promise<RotatingCreditFundingBalance[]> {
  const fundings = await tx.select({
    funding: rotatingCreditFundings,
    payment: payments,
    operation: paymentOperations,
  }).from(rotatingCreditFundings)
    .innerJoin(payments, and(
      eq(payments.id, rotatingCreditFundings.paymentId),
      eq(payments.organizationId, input.organizationId),
      eq(payments.leagueId, input.leagueId),
    ))
    .leftJoin(paymentOperations, eq(paymentOperations.id, payments.paymentOperationId))
    .where(and(
      eq(rotatingCreditFundings.organizationId, input.organizationId),
      eq(rotatingCreditFundings.leagueId, input.leagueId),
      eq(rotatingCreditFundings.bowlerId, input.bowlerId),
    ))
    .orderBy(asc(rotatingCreditFundings.createdAt), asc(rotatingCreditFundings.id));
  if (fundings.length === 0) return [];

  const fundingIds = fundings.map(({ funding }) => funding.id);
  const apps = await tx.select({
    application: rotatingCreditApplications,
    allocation: paymentAllocations,
    reversal: rotatingCreditApplicationReversals,
  }).from(rotatingCreditApplications)
    .innerJoin(paymentAllocations, and(
      eq(paymentAllocations.id, rotatingCreditApplications.allocationId),
      eq(paymentAllocations.organizationId, input.organizationId),
      eq(paymentAllocations.leagueId, input.leagueId),
    ))
    .leftJoin(rotatingCreditApplicationReversals, and(
      eq(rotatingCreditApplicationReversals.applicationId, rotatingCreditApplications.id),
      eq(rotatingCreditApplicationReversals.organizationId, input.organizationId),
      eq(rotatingCreditApplicationReversals.leagueId, input.leagueId),
    ))
    .where(and(
      eq(rotatingCreditApplications.organizationId, input.organizationId),
      eq(rotatingCreditApplications.leagueId, input.leagueId),
      inArray(rotatingCreditApplications.fundingId, fundingIds),
    ));
  const allTenderAllocations = await tx.select({ allocation: paymentAllocations, funding: rotatingCreditFundings })
    .from(paymentAllocations).innerJoin(rotatingCreditFundings, and(
      eq(rotatingCreditFundings.paymentId, paymentAllocations.paymentId),
      eq(rotatingCreditFundings.organizationId, paymentAllocations.organizationId),
      eq(rotatingCreditFundings.leagueId, paymentAllocations.leagueId),
    )).where(and(
      eq(paymentAllocations.organizationId, input.organizationId),
      eq(paymentAllocations.leagueId, input.leagueId),
      inArray(rotatingCreditFundings.id, fundingIds),
    ));
  const refundRows = await tx.select({ refund: rotatingCreditRefunds, operation: paymentOperations }).from(rotatingCreditRefunds)
    .leftJoin(paymentOperations, eq(paymentOperations.id, rotatingCreditRefunds.refundOperationId))
    .where(and(
      eq(rotatingCreditRefunds.organizationId, input.organizationId),
      eq(rotatingCreditRefunds.leagueId, input.leagueId),
      inArray(rotatingCreditRefunds.fundingId, fundingIds),
    ));

  const paymentOperationIds = fundings
    .map(({ operation }) => operation?.id)
    .filter((id): id is string => id !== undefined && id !== null);
  const disputes = paymentOperationIds.length === 0 ? [] : await tx.select({
    operationId: paymentDisputes.paymentOperationId,
    state: paymentDisputes.state,
  }).from(paymentDisputes).where(and(
    eq(paymentDisputes.organizationId, input.organizationId),
    inArray(paymentDisputes.paymentOperationId, paymentOperationIds),
  ));
  const disputedOperations = new Set(disputes.filter((row) => REVIEW_DISPUTE_STATES.has(row.state)).map((row) => row.operationId));
  const applicationAllocationIds = new Set(apps.map(({ application }) => application.allocationId));
  const untrackedCreditPayments = new Set(allTenderAllocations.filter(({ allocation }) => !applicationAllocationIds.has(allocation.id)).map(({ funding }) => funding.id));

  return fundings.map(({ funding, payment, operation }) => {
    let reviewRequired = false;
    let appliedMinor = 0;
    for (const row of apps.filter(({ application }) => application.fundingId === funding.id)) {
      const matches = row.application.paymentId === funding.paymentId
        && row.application.actualBowlerId === funding.bowlerId
        && row.application.amountMinor === row.allocation.amountMinor
        && row.application.obligationId === row.allocation.obligationId
        && row.application.allocationId === row.allocation.id;
      if (!matches
        || row.allocation.reviewRequired
        || (row.allocation.state === "active") !== (row.reversal === null)) {
        reviewRequired = true;
      }
      if (row.reversal === null && row.allocation.state === "active") appliedMinor += row.allocation.amountMinor;
    }

    let refundedMinor = 0;
    let refundHeldMinor = 0;
    for (const row of refundRows.filter(({ refund }) => refund.fundingId === funding.id)) {
      if (row.refund.refundKind === "provider") {
        const op = row.operation;
        if (!op || op.operationType !== "refund" || op.organizationId !== input.organizationId || op.leagueId !== input.leagueId
          || op.amountMinor !== row.refund.amountMinor || op.currency !== "USD") {
          reviewRequired = true;
          continue;
        }
        if (op.status === "succeeded" && op.providerObjectId !== null) refundedMinor += row.refund.amountMinor;
        else if (isConfirmedNoRefundCreditOutcome(op)) {
          // A terminal failure without a provider ID cannot represent an
          // issued refund. With an ID, release only for Square's explicit
          // REJECTED/FAILED states. Square's issuer-declined REFUND_DECLINED
          // response is also definitive when it produced no refund ID.
          // Retain ambiguous provider identities for review.
        } else if (HELD_REFUND_STATUSES.has(op.status)) refundHeldMinor += row.refund.amountMinor;
        else {
          reviewRequired = true;
        }
      } else if (row.refund.issuedAt !== null && row.refund.reference?.trim()) {
        refundedMinor += row.refund.amountMinor;
      } else {
        reviewRequired = true;
      }
    }

    const providerEvidenceValid = payment.type === "cash" || payment.type === "check"
      ? operation === null && payment.providerPaymentId === null
      : operation?.status === "succeeded" && operation.providerObjectId !== null;
    if (payment.bowlerId !== funding.bowlerId || payment.amount !== funding.amountMinor || payment.currency !== funding.currency
      || untrackedCreditPayments.has(funding.id) || !providerEvidenceValid || payment.status !== "paid" || payment.disputeId !== null || payment.disputedAt !== null
      || (operation !== null && disputedOperations.has(operation.id))) reviewRequired = true;

    const remainder = funding.amountMinor - appliedMinor - refundedMinor - refundHeldMinor;
    if (remainder < 0 || appliedMinor < 0 || refundedMinor < 0 || refundHeldMinor < 0) reviewRequired = true;
    const safeRemainder = Math.max(0, remainder);
    return {
      fundingId: funding.id,
      paymentId: funding.paymentId,
      bowlerId: funding.bowlerId,
      amountMinor: funding.amountMinor,
      appliedMinor,
      refundedMinor,
      refundHeldMinor,
      availableMinor: reviewRequired ? 0 : safeRemainder,
      reviewHeldMinor: reviewRequired ? safeRemainder : 0,
      reviewRequired,
      createdAt: funding.createdAt,
    };
  });
}

/** Apply spendable lot value to the caller's already-confirmed dates, in the
 * candidate reader's canonical billing order. The caller holds the league
 * schedule lock, so assignment and obligation state cannot race this sweep. */
export async function applyRotatingCreditToConfirmedObligationsInTransaction(
  tx: PaymentOperationTransaction,
  input: {
    organizationId: number;
    leagueId: number;
    bowlerId: number;
    actorUserId: number;
    now?: string;
  },
): Promise<string[]> {
  const now = input.now ?? new Date().toISOString();
  const obligations = await readConfirmedRotatingObligationsForCredit(tx, {
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    bowlerId: input.bowlerId,
  });
  const lots = await readRotatingCreditFundingBalancesInTransaction(tx, input);
  const available = lots.filter((lot) => !lot.reviewRequired && lot.availableMinor > 0);
  let lotIndex = 0;
  let lotRemaining = available[0]?.availableMinor ?? 0;
  const createdApplicationIds: string[] = [];
  const appliedByObligation = new Map<string, number>();

  for (const obligation of spendableRotatingCreditObligationPrefix(obligations)) {
    if (obligation.actualBowlerId !== input.bowlerId
      || obligation.owner.kind !== "team" || obligation.outstandingMinor <= 0) continue;
    let due = obligation.outstandingMinor;
    while (due > 0 && lotIndex < available.length) {
      const lot = available[lotIndex];
      if (!lot) break;
      if (lotRemaining <= 0) {
        lotIndex += 1;
        lotRemaining = available[lotIndex]?.availableMinor ?? 0;
        continue;
      }
      const amountMinor = Math.min(due, lotRemaining);
      const [allocation] = await tx.insert(paymentAllocations).values({
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        paymentId: lot.paymentId,
        obligationId: obligation.obligationId,
        amountMinor,
        currency: "USD",
        state: "active",
        allocationKind: "rotating_credit",
        recordedByUserId: input.actorUserId,
        createdAt: now,
      }).returning({ id: paymentAllocations.id });
      if (!allocation) throw new RotatingCreditLedgerError("CREDIT_ALLOCATION_CREATE_FAILED");
      const [application] = await tx.insert(rotatingCreditApplications).values({
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        fundingId: lot.fundingId,
        paymentId: lot.paymentId,
        allocationId: allocation.id,
        obligationId: obligation.obligationId,
        assignmentId: obligation.assignmentId,
        responsibilityId: obligation.responsibilityId,
        actualBowlerId: input.bowlerId,
        teamId: obligation.teamId,
        slotIndex: obligation.slotIndex,
        occurrenceId: obligation.occurrenceId,
        occurrenceLocalDate: obligation.occurrenceLocalDate,
        occurrenceStartAt: obligation.occurrenceStartAt,
        amountMinor,
        currency: "USD",
        appliedAt: now,
        appliedByUserId: input.actorUserId,
      }).returning({ id: rotatingCreditApplications.id });
      if (!application) throw new RotatingCreditLedgerError("CREDIT_APPLICATION_CREATE_FAILED");
      createdApplicationIds.push(application.id);
      due -= amountMinor;
      lotRemaining -= amountMinor;
      appliedByObligation.set(obligation.obligationId, (appliedByObligation.get(obligation.obligationId) ?? 0) + amountMinor);
    }
  }
  for (const obligation of obligations) {
    const appliedToObligation = appliedByObligation.get(obligation.obligationId) ?? 0;
    if (appliedToObligation > 0) {
      const afterOutstanding = Math.max(0, obligation.outstandingMinor - appliedToObligation);
      await tx.update(paymentObligations).set({ state: afterOutstanding === 0 ? "settled" : "partially_settled" }).where(and(
        eq(paymentObligations.organizationId, input.organizationId),
        eq(paymentObligations.leagueId, input.leagueId),
        eq(paymentObligations.id, obligation.obligationId),
        inArray(paymentObligations.state, ["open", "partially_settled", "settled"]),
      ));
    }
  }
  return createdApplicationIds;
}

/** Reverse only credit-backed allocations attached to the assignment being
 * corrected. Original allocation/application/tender rows remain auditable. */
export async function reverseRotatingCreditApplicationsForAssignmentChangeInTransaction(
  tx: PaymentOperationTransaction,
  input: { organizationId: number; leagueId: number; assignmentId: string; actorUserId: number; reason: string; now?: string },
): Promise<string[]> {
  const reason = input.reason.trim();
  if (reason.length === 0 || reason.length > 500) throw new RotatingCreditLedgerError("REVERSAL_REASON_INVALID");
  const now = input.now ?? new Date().toISOString();
  const rows = await tx.select({
    application: rotatingCreditApplications,
    allocation: paymentAllocations,
    funding: rotatingCreditFundings,
    payment: payments,
    operation: paymentOperations,
    reversal: rotatingCreditApplicationReversals,
  }).from(rotatingCreditApplications)
    .innerJoin(paymentAllocations, and(
      eq(paymentAllocations.id, rotatingCreditApplications.allocationId),
      eq(paymentAllocations.organizationId, input.organizationId),
      eq(paymentAllocations.leagueId, input.leagueId),
    ))
    .innerJoin(rotatingCreditFundings, and(
      eq(rotatingCreditFundings.id, rotatingCreditApplications.fundingId),
      eq(rotatingCreditFundings.organizationId, input.organizationId),
      eq(rotatingCreditFundings.leagueId, input.leagueId),
    ))
    .innerJoin(payments, and(
      eq(payments.id, rotatingCreditApplications.paymentId),
      eq(payments.organizationId, input.organizationId),
      eq(payments.leagueId, input.leagueId),
    ))
    .leftJoin(paymentOperations, eq(paymentOperations.id, payments.paymentOperationId))
    .leftJoin(rotatingCreditApplicationReversals, and(
      eq(rotatingCreditApplicationReversals.applicationId, rotatingCreditApplications.id),
      eq(rotatingCreditApplicationReversals.organizationId, input.organizationId),
      eq(rotatingCreditApplicationReversals.leagueId, input.leagueId),
    ))
    .where(and(
      eq(rotatingCreditApplications.organizationId, input.organizationId),
      eq(rotatingCreditApplications.leagueId, input.leagueId),
      eq(rotatingCreditApplications.assignmentId, input.assignmentId),
    )).orderBy(asc(rotatingCreditApplications.appliedAt), asc(rotatingCreditApplications.id))
    // paymentOperations and reversals are LEFT JOINed; lock only the required
    // application/allocation rows so PostgreSQL never tries to lock a nullable
    // side of the join.
    .for("update", { of: [rotatingCreditApplications, paymentAllocations] });

  const fundingIds = [...new Set(rows.map((row) => row.funding.id))];
  const refunds = fundingIds.length === 0 ? [] : await tx.select({ refund: rotatingCreditRefunds, operation: paymentOperations }).from(rotatingCreditRefunds)
    .leftJoin(paymentOperations, eq(paymentOperations.id, rotatingCreditRefunds.refundOperationId))
    .where(and(
      eq(rotatingCreditRefunds.organizationId, input.organizationId),
      eq(rotatingCreditRefunds.leagueId, input.leagueId),
      inArray(rotatingCreditRefunds.fundingId, fundingIds),
    ));
  const unresolvedFundingIds = new Set(refunds.filter((row) => row.operation !== null && HELD_REFUND_STATUSES.has(row.operation.status)).map((row) => row.refund.fundingId));
  const operationIds = [...new Set(rows.map((row) => row.operation?.id).filter((id): id is string => id !== undefined && id !== null))];
  const disputes = operationIds.length === 0 ? [] : await tx.select({ operationId: paymentDisputes.paymentOperationId, state: paymentDisputes.state })
    .from(paymentDisputes).where(and(
      eq(paymentDisputes.organizationId, input.organizationId),
      inArray(paymentDisputes.paymentOperationId, operationIds),
    ));
  const disputedOperations = new Set(disputes.filter((row) => REVIEW_DISPUTE_STATES.has(row.state)).map((row) => row.operationId));
  const reversedObligationIds = new Set<string>();

  for (const row of rows) {
    if (row.reversal !== null) continue;
    if (row.allocation.state !== "active"
      || row.allocation.paymentId !== row.application.paymentId
      || row.allocation.obligationId !== row.application.obligationId
      || row.allocation.amountMinor !== row.application.amountMinor
      || row.funding.paymentId !== row.application.paymentId
      || row.funding.bowlerId !== row.application.actualBowlerId) {
      throw new RotatingCreditLedgerError("APPLICATION_ALLOCATION_MISMATCH");
    }
    if (row.payment.status !== "paid" || row.payment.disputeId !== null || row.payment.disputedAt !== null
      || (row.operation !== null && row.operation.status !== "succeeded")
      || (row.operation !== null && disputedOperations.has(row.operation.id))
      || unresolvedFundingIds.has(row.funding.id)) {
      throw new RotatingCreditLedgerError("APPLICATION_SOURCE_UNRESOLVED");
    }
    const [updated] = await tx.update(paymentAllocations).set({ state: "voided" }).where(and(
      eq(paymentAllocations.organizationId, input.organizationId),
      eq(paymentAllocations.leagueId, input.leagueId),
      eq(paymentAllocations.id, row.allocation.id),
      eq(paymentAllocations.state, "active"),
    )).returning({ id: paymentAllocations.id });
    if (!updated) throw new RotatingCreditLedgerError("APPLICATION_ALLOCATION_CHANGED");
    await tx.insert(rotatingCreditApplicationReversals).values({
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      applicationId: row.application.id,
      fundingPaymentId: row.application.paymentId,
      allocationId: row.allocation.id,
      obligationId: row.application.obligationId,
      assignmentId: input.assignmentId,
      bowlerId: row.application.actualBowlerId,
      amountMinor: row.application.amountMinor,
      actorUserId: input.actorUserId,
      reason,
      createdAt: now,
    });
    reversedObligationIds.add(row.application.obligationId);
  }
  for (const obligationId of reversedObligationIds) {
    const [obligation] = await tx.select({ amountMinor: paymentObligations.amountMinor, state: paymentObligations.state })
      .from(paymentObligations).where(and(
        eq(paymentObligations.organizationId, input.organizationId),
        eq(paymentObligations.leagueId, input.leagueId),
        eq(paymentObligations.id, obligationId),
      )).limit(1).for("update");
    if (!obligation) throw new RotatingCreditLedgerError("REVERSAL_OBLIGATION_MISSING");
    const [allocated] = await tx.select({ total: sum(paymentAllocations.amountMinor) }).from(paymentAllocations).where(and(
      eq(paymentAllocations.organizationId, input.organizationId),
      eq(paymentAllocations.leagueId, input.leagueId),
      eq(paymentAllocations.obligationId, obligationId),
      eq(paymentAllocations.state, "active"),
    ));
    const obligationAllocationRows = await tx.select({ id: paymentAllocations.id }).from(paymentAllocations).where(and(
      eq(paymentAllocations.organizationId, input.organizationId),
      eq(paymentAllocations.leagueId, input.leagueId),
      eq(paymentAllocations.obligationId, obligationId),
    ));
    const adjustments = obligationAllocationRows.length === 0 ? [] : await tx.select({
      amountMinor: refundAllocationAdjustments.amountMinor,
      disposition: refundAllocationAdjustments.disposition,
    }).from(refundAllocationAdjustments).where(and(
      eq(refundAllocationAdjustments.organizationId, input.organizationId),
      eq(refundAllocationAdjustments.leagueId, input.leagueId),
      inArray(refundAllocationAdjustments.sourceAllocationId, obligationAllocationRows.map((row) => row.id)),
    ));
    const balance = canonicalObligationBalance({
      amountMinor: obligation.amountMinor,
      state: obligation.state,
      grossAllocatedMinor: Number(allocated?.total ?? 0),
      adjustments,
    });
    await tx.update(paymentObligations).set({ state: balance.outstandingMinor === 0 ? "settled" : balance.effectiveAllocatedMinor > 0 ? "partially_settled" : "open" })
      .where(and(
        eq(paymentObligations.organizationId, input.organizationId),
        eq(paymentObligations.leagueId, input.leagueId),
        eq(paymentObligations.id, obligationId),
        inArray(paymentObligations.state, ["open", "partially_settled", "settled"]),
      ));
  }
  return [...reversedObligationIds];
}
