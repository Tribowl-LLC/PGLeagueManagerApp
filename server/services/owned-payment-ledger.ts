import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { canonicalizePaymentOperationInput } from "./payment-operation-idempotency.js";
import {
  accountPaymentOperationSnapshots,
  leagueOccurrences,
  occurrencePaymentResponsibilities,
  paymentAllocationFundingApplications,
  paymentAllocations,
  weeklyPaymentFundingAuthorizationItems,
  paymentDisputes,
  paymentObligations,
  paymentOperations,
  paymentVoids,
  payments,
  refundAllocationAdjustments,
  refundPaymentOperationSnapshots,
  rotatingCreditFundings,
  rotatingOccurrenceAssignments,
  weeklyPaymentAllocationReleases,
  weeklyPaymentFundings,
  weeklyPaymentLedgerAdoptions,
  weeklyPaymentWeekConfirmations,
  type WeeklyPaymentFunding,
  type WeeklyPaymentLedgerAdoption,
} from "@shared/schema";
import type { PaymentOperationTransaction } from "../storage/payment-operations.js";
import { canonicalObligationBalance } from "./refund-allocation-adjustments.js";
import { resolvePaymentObligationOwnersInTransaction } from "./roster-obligation-owners.js";
import { isConfirmedNoRefundCreditOutcome, readRotatingCreditFundingBalancesInTransaction } from "./rotating-credit-applications.js";

export class OwnedPaymentLedgerError extends Error {
  constructor(public readonly code: string) {
    super("Owned payment ledger evidence is unavailable or inconsistent");
    this.name = "OwnedPaymentLedgerError";
  }
}

export interface OwnedAccountBalance {
  bowlerId: number;
  availableCreditMinor: number;
  confirmedOwedMinor: number;
  /** Credit minus confirmed debt. Positive is credit; negative is owed. */
  netBalanceMinor: number;
}

export interface OwnedLedgerScope {
  organizationId: number;
  leagueId: number;
}

export interface ReadOwnedAccountBalancesInput extends OwnedLedgerScope {
  /** Omit to return every owner referenced by the adopted league ledger. */
  bowlerIds?: readonly number[];
}

export interface OwnedConfirmedObligation {
  obligationId: string;
  responsibilityId: string;
  occurrenceId: string;
  occurrenceLocalDate: string;
  dueAt: string;
  teamId: number;
  amountMinor: number;
  paidMinor: number;
  waivedMinor: number;
  outstandingMinor: number;
  payerBowlerId: number | null;
  debtorBowlerId: number;
  targetKind: "bowler_responsibility" | "legacy_team_assignment";
  assignmentId: string | null;
  reviewRequired: boolean;
}

const REVIEW_DISPUTE_STATES = new Set([
  "INQUIRY_EVIDENCE_REQUIRED",
  "INQUIRY_PROCESSING",
  "EVIDENCE_REQUIRED",
  "PROCESSING",
  "LOST",
  "ACCEPTED",
]);

const REFUND_HOLD_STATUSES = [
  "pending",
  "leased",
  "provider_unknown",
  "retry_scheduled",
  "action_required",
  "reconciliation_required",
] as const;

export async function readOwnedLedgerAdoptionInTransaction(
  tx: PaymentOperationTransaction,
  scope: OwnedLedgerScope,
): Promise<WeeklyPaymentLedgerAdoption | null> {
  const rows = await tx.select().from(weeklyPaymentLedgerAdoptions).where(and(
    eq(weeklyPaymentLedgerAdoptions.organizationId, scope.organizationId),
    eq(weeklyPaymentLedgerAdoptions.leagueId, scope.leagueId),
  )).orderBy(asc(weeklyPaymentLedgerAdoptions.createdAt), asc(weeklyPaymentLedgerAdoptions.id)).limit(2);
  if (rows.length > 1) throw new OwnedPaymentLedgerError("LEDGER_ADOPTION_DUPLICATE");
  return rows[0] ?? null;
}

/** A cutoff only confirms canonical periods explicitly included by adoption.
 * The adopting operation keeps the current billable occurrence out of the
 * cutoff unless an existing confirmation already proves it was saved. */
export function isOccurrenceConfirmedInOwnedLedger(
  adoption: Pick<WeeklyPaymentLedgerAdoption, "adoptedThroughLocalDate"> | null,
  occurrenceLocalDate: string,
  explicitConfirmationExists: boolean,
): boolean {
  if (explicitConfirmationExists) return true;
  if (!adoption || !/^\d{4}-\d{2}-\d{2}$/.test(occurrenceLocalDate)) return false;
  return occurrenceLocalDate <= adoption.adoptedThroughLocalDate;
}

export async function readConfirmedOwnedObligationsInTransaction(
  tx: PaymentOperationTransaction,
  scope: OwnedLedgerScope & { bowlerIds?: readonly number[] },
): Promise<OwnedConfirmedObligation[]> {
  const adoption = await readOwnedLedgerAdoptionInTransaction(tx, scope);
  const [obligations, confirmations] = await Promise.all([
    tx.select({
      obligation: paymentObligations,
      occurrenceLocalDate: leagueOccurrences.authoritativeLocalDate,
      occurrenceStartAt: leagueOccurrences.startAt,
      responsibility: occurrencePaymentResponsibilities,
    }).from(paymentObligations)
      .innerJoin(leagueOccurrences, and(
        eq(leagueOccurrences.id, paymentObligations.occurrenceId),
        eq(leagueOccurrences.organizationId, scope.organizationId),
        eq(leagueOccurrences.leagueId, scope.leagueId),
      ))
      .innerJoin(occurrencePaymentResponsibilities, and(
        eq(occurrencePaymentResponsibilities.id, paymentObligations.responsibilityId),
        eq(occurrencePaymentResponsibilities.organizationId, scope.organizationId),
        eq(occurrencePaymentResponsibilities.leagueId, scope.leagueId),
      ))
      .where(and(
        eq(paymentObligations.organizationId, scope.organizationId),
        eq(paymentObligations.leagueId, scope.leagueId),
        ne(paymentObligations.state, "voided"),
      )).orderBy(asc(paymentObligations.dueAt), asc(leagueOccurrences.authoritativeLocalDate), asc(paymentObligations.id)),
    tx.select({ occurrenceId: weeklyPaymentWeekConfirmations.occurrenceId })
      .from(weeklyPaymentWeekConfirmations)
      .where(and(
        eq(weeklyPaymentWeekConfirmations.organizationId, scope.organizationId),
        eq(weeklyPaymentWeekConfirmations.leagueId, scope.leagueId),
      )),
  ]);
  const confirmedOccurrenceIds = new Set(confirmations.map((row) => row.occurrenceId));
  const confirmed = obligations.filter(({ occurrenceLocalDate, obligation }) => occurrenceLocalDate !== null
    && isOccurrenceConfirmedInOwnedLedger(adoption, occurrenceLocalDate, confirmedOccurrenceIds.has(obligation.occurrenceId)));
  if (confirmed.length === 0) return [];

  const selectedBowlerIds = scope.bowlerIds === undefined ? undefined : [...new Set(scope.bowlerIds)];
  const owners = await resolvePaymentObligationOwnersInTransaction(tx, {
    organizationId: scope.organizationId,
    leagueId: scope.leagueId,
    obligations: confirmed.map(({ obligation }) => obligation),
  });
  const assignmentRows = await tx.select().from(rotatingOccurrenceAssignments).where(and(
    eq(rotatingOccurrenceAssignments.organizationId, scope.organizationId),
    eq(rotatingOccurrenceAssignments.leagueId, scope.leagueId),
    inArray(rotatingOccurrenceAssignments.occurrenceId, [...new Set(confirmed.map(({ obligation }) => obligation.occurrenceId))]),
  )).orderBy(asc(rotatingOccurrenceAssignments.occurrenceId), asc(rotatingOccurrenceAssignments.teamId), asc(rotatingOccurrenceAssignments.slotIndex), desc(rotatingOccurrenceAssignments.version));
  const latestAssignmentBySlot = new Map<string, typeof assignmentRows[number]>();
  for (const assignment of assignmentRows) {
    const key = `${assignment.occurrenceId}:${assignment.teamId}:${assignment.slotIndex}`;
    if (!latestAssignmentBySlot.has(key)) latestAssignmentBySlot.set(key, assignment);
  }

  const obligationIds = confirmed.map(({ obligation }) => obligation.id);
  const allocations = await tx.select({
    allocation: paymentAllocations,
  }).from(paymentAllocations).where(and(
    eq(paymentAllocations.organizationId, scope.organizationId),
    eq(paymentAllocations.leagueId, scope.leagueId),
    eq(paymentAllocations.state, "active"),
    inArray(paymentAllocations.obligationId, obligationIds),
  ));
  const allocationIds = allocations.map(({ allocation }) => allocation.id);
  const adjustments = allocationIds.length === 0 ? [] : await tx.select().from(refundAllocationAdjustments).where(and(
    eq(refundAllocationAdjustments.organizationId, scope.organizationId),
    eq(refundAllocationAdjustments.leagueId, scope.leagueId),
    inArray(refundAllocationAdjustments.sourceAllocationId, allocationIds),
  ));
  const adjustmentsByAllocation = new Map<string, typeof adjustments>();
  for (const adjustment of adjustments) adjustmentsByAllocation.set(adjustment.sourceAllocationId, [...(adjustmentsByAllocation.get(adjustment.sourceAllocationId) ?? []), adjustment]);
  const allocationsByObligation = new Map<string, typeof allocations>();
  for (const row of allocations) allocationsByObligation.set(row.allocation.obligationId, [...(allocationsByObligation.get(row.allocation.obligationId) ?? []), row]);

  const paymentIds = [...new Set(allocations.map(({ allocation }) => allocation.paymentId))];
  const sourcePayments = paymentIds.length === 0 ? [] : await tx.select({
    id: payments.id,
    status: payments.status,
    paymentOperationId: payments.paymentOperationId,
    disputeId: payments.disputeId,
    disputedAt: payments.disputedAt,
  }).from(payments).where(and(
    eq(payments.organizationId, scope.organizationId),
    eq(payments.leagueId, scope.leagueId),
    inArray(payments.id, paymentIds),
  ));
  const paymentById = new Map(sourcePayments.map((payment) => [payment.id, payment]));
  const operationIds = [...new Set(sourcePayments.flatMap((payment) => payment.paymentOperationId === null ? [] : [payment.paymentOperationId]))];
  const [disputes, operationRows, unresolvedRefundRows] = await Promise.all([
    operationIds.length === 0 ? Promise.resolve([]) : tx.select({ operationId: paymentDisputes.paymentOperationId, state: paymentDisputes.state }).from(paymentDisputes).where(and(
      eq(paymentDisputes.organizationId, scope.organizationId),
      inArray(paymentDisputes.paymentOperationId, operationIds),
    )),
    operationIds.length === 0 ? Promise.resolve([]) : tx.select({ id: paymentOperations.id, status: paymentOperations.status }).from(paymentOperations).where(and(
      eq(paymentOperations.organizationId, scope.organizationId),
      eq(paymentOperations.leagueId, scope.leagueId),
      inArray(paymentOperations.id, operationIds),
    )),
    paymentIds.length === 0 ? Promise.resolve([]) : tx.select({ paymentId: refundPaymentOperationSnapshots.paymentId }).from(refundPaymentOperationSnapshots)
      .innerJoin(paymentOperations, and(
        eq(paymentOperations.id, refundPaymentOperationSnapshots.operationId),
        eq(paymentOperations.organizationId, scope.organizationId),
        eq(paymentOperations.leagueId, scope.leagueId),
      )).where(and(
        eq(refundPaymentOperationSnapshots.leagueId, scope.leagueId),
        inArray(refundPaymentOperationSnapshots.paymentId, paymentIds),
        inArray(paymentOperations.status, REFUND_HOLD_STATUSES),
      )),
  ]);
  const disputedOperationIds = new Set(disputes.filter((row) => REVIEW_DISPUTE_STATES.has(row.state)).map((row) => row.operationId));
  const operationById = new Map(operationRows.map((row) => [row.id, row]));
  const heldPaymentIds = new Set(unresolvedRefundRows.map((row) => row.paymentId));
  const confirmedRows: OwnedConfirmedObligation[] = [];
  for (const { obligation, occurrenceLocalDate, responsibility } of confirmed) {
    if (occurrenceLocalDate === null) continue;
    const owner = owners.get(obligation.id);
    if (!owner) throw new OwnedPaymentLedgerError("OBLIGATION_OWNER_MISSING");
    let creditedOwnerBowlerId: number;
    let targetKind: OwnedConfirmedObligation["targetKind"];
    let assignmentId: string | null = null;
    if (owner.kind === "bowler") {
      creditedOwnerBowlerId = owner.bowlerId;
      targetKind = "bowler_responsibility";
      if (obligation.payerBowlerId === null || obligation.payerBowlerId !== owner.bowlerId) continue;
    } else {
      const slotIndex = responsibility.slotIndex;
      if (slotIndex === null) continue;
      const assignment = latestAssignmentBySlot.get(`${obligation.occurrenceId}:${responsibility.teamId}:${slotIndex}`);
      if (!assignment || assignment.responsibilityId !== responsibility.id || assignment.actualBowlerId === null || owner.teamId !== responsibility.teamId) continue;
      creditedOwnerBowlerId = assignment.actualBowlerId;
      assignmentId = assignment.id;
      targetKind = "legacy_team_assignment";
    }
    if (selectedBowlerIds && !selectedBowlerIds.includes(creditedOwnerBowlerId)) continue;
    const linkedAllocations = allocationsByObligation.get(obligation.id) ?? [];
    const balance = canonicalObligationBalance({
      amountMinor: obligation.amountMinor,
      state: obligation.state,
      grossAllocatedMinor: linkedAllocations.reduce((sum, { allocation }) => sum + allocation.amountMinor, 0),
      adjustments: linkedAllocations.flatMap(({ allocation }) => (adjustmentsByAllocation.get(allocation.id) ?? []).map(({ amountMinor, disposition }) => ({ amountMinor, disposition }))),
    });
    if (balance.outstandingMinor <= 0) continue;
    const reviewRequired = linkedAllocations.some(({ allocation }) => {
      if (allocation.reviewRequired) return true;
      const payment = paymentById.get(allocation.paymentId);
      if (!payment || payment.status !== "paid" || payment.disputeId !== null || payment.disputedAt !== null) return true;
      if (payment.paymentOperationId && disputedOperationIds.has(payment.paymentOperationId)) return true;
      if (payment.paymentOperationId && operationById.get(payment.paymentOperationId)?.status !== "succeeded") return true;
      return heldPaymentIds.has(allocation.paymentId);
    });
    confirmedRows.push({
      obligationId: obligation.id,
      responsibilityId: responsibility.id,
      occurrenceId: obligation.occurrenceId,
      occurrenceLocalDate,
      dueAt: obligation.dueAt,
      teamId: responsibility.teamId,
      amountMinor: obligation.amountMinor,
      paidMinor: balance.effectiveAllocatedMinor,
      waivedMinor: balance.waivedMinor,
      outstandingMinor: balance.outstandingMinor,
      payerBowlerId: obligation.payerBowlerId,
      debtorBowlerId: creditedOwnerBowlerId,
      targetKind,
      assignmentId,
      reviewRequired,
    });
  }
  return confirmedRows;
}

async function readGenericFundingAvailabilityInTransaction(
  tx: PaymentOperationTransaction,
  scope: OwnedLedgerScope & { bowlerIds: readonly number[] },
): Promise<Map<number, number>> {
  if (scope.bowlerIds.length === 0) return new Map();
  const rows = await tx.select({ funding: weeklyPaymentFundings, payment: payments, operation: paymentOperations }).from(weeklyPaymentFundings)
    .innerJoin(payments, and(
      eq(payments.id, weeklyPaymentFundings.paymentId),
      eq(payments.organizationId, scope.organizationId),
      eq(payments.leagueId, scope.leagueId),
    ))
    .leftJoin(paymentOperations, and(
      eq(paymentOperations.id, payments.paymentOperationId),
      eq(paymentOperations.organizationId, scope.organizationId),
      eq(paymentOperations.leagueId, scope.leagueId),
    ))
    .where(and(
      eq(weeklyPaymentFundings.organizationId, scope.organizationId),
      eq(weeklyPaymentFundings.leagueId, scope.leagueId),
      inArray(weeklyPaymentFundings.creditedBowlerId, [...new Set(scope.bowlerIds)]),
    )).orderBy(asc(weeklyPaymentFundings.createdAt), asc(weeklyPaymentFundings.id));
  if (rows.length === 0) return new Map();
  const fundingIds = rows.map(({ funding }) => funding.id);
  const paymentIds = [...new Set(rows.map(({ funding }) => funding.paymentId))];
  const [applications, allPaymentAllocations, voids, refunds, disputes] = await Promise.all([
    tx.select({ application: paymentAllocationFundingApplications, allocation: paymentAllocations }).from(paymentAllocationFundingApplications)
      .innerJoin(paymentAllocations, and(
        eq(paymentAllocations.id, paymentAllocationFundingApplications.allocationId),
        eq(paymentAllocations.organizationId, scope.organizationId),
        eq(paymentAllocations.leagueId, scope.leagueId),
      )).where(and(
        eq(paymentAllocationFundingApplications.organizationId, scope.organizationId),
        eq(paymentAllocationFundingApplications.leagueId, scope.leagueId),
        inArray(paymentAllocationFundingApplications.genericFundingId, fundingIds),
      )),
    tx.select({ id: paymentAllocations.id, paymentId: paymentAllocations.paymentId }).from(paymentAllocations).where(and(
      eq(paymentAllocations.organizationId, scope.organizationId),
      eq(paymentAllocations.leagueId, scope.leagueId),
      inArray(paymentAllocations.paymentId, paymentIds),
    )),
    tx.select({ paymentId: paymentVoids.paymentId }).from(paymentVoids).where(and(
      eq(paymentVoids.organizationId, scope.organizationId),
      eq(paymentVoids.leagueId, scope.leagueId),
      inArray(paymentVoids.paymentId, paymentIds),
    )),
    tx.select({ snapshot: refundPaymentOperationSnapshots, operation: paymentOperations }).from(refundPaymentOperationSnapshots)
      .innerJoin(paymentOperations, and(
        eq(paymentOperations.id, refundPaymentOperationSnapshots.operationId),
        eq(paymentOperations.organizationId, scope.organizationId),
        eq(paymentOperations.leagueId, scope.leagueId),
      )).where(and(
        eq(refundPaymentOperationSnapshots.leagueId, scope.leagueId),
        inArray(refundPaymentOperationSnapshots.paymentId, paymentIds),
      )),
    tx.select({ operationId: paymentDisputes.paymentOperationId, state: paymentDisputes.state }).from(paymentDisputes).where(and(
      eq(paymentDisputes.organizationId, scope.organizationId),
      inArray(paymentDisputes.paymentOperationId, [...new Set(rows.flatMap(({ payment }) => payment.paymentOperationId === null ? [] : [payment.paymentOperationId]))]),
    )),
  ]);
  const appByFunding = new Map<string, typeof applications>();
  for (const row of applications) {
    if (row.application.genericFundingId) appByFunding.set(row.application.genericFundingId, [...(appByFunding.get(row.application.genericFundingId) ?? []), row]);
  }
  const representedAllocationIds = new Set(applications.map(({ allocation }) => allocation.id));
  const allAllocationsByPayment = new Map<number, string[]>();
  for (const allocation of allPaymentAllocations) allAllocationsByPayment.set(allocation.paymentId, [...(allAllocationsByPayment.get(allocation.paymentId) ?? []), allocation.id]);
  const voidPaymentIds = new Set(voids.map(({ paymentId }) => paymentId));
  const disputeOperationIds = new Set(disputes.filter((row) => REVIEW_DISPUTE_STATES.has(row.state)).map((row) => row.operationId));
  const refundsByPayment = new Map<number, typeof refunds>();
  for (const row of refunds) refundsByPayment.set(row.snapshot.paymentId, [...(refundsByPayment.get(row.snapshot.paymentId) ?? []), row]);
  const result = new Map<number, number>();
  for (const { funding, payment, operation } of rows) {
    const linkedApps = appByFunding.get(funding.id) ?? [];
    const activeApplications = linkedApps.filter(({ allocation }) => allocation.state === "active");
    const untrackedAllocations = (allAllocationsByPayment.get(payment.id) ?? []).some((allocationId) => !representedAllocationIds.has(allocationId));
    const invalidPayment = payment.status !== "paid"
      || voidPaymentIds.has(payment.id)
      || payment.disputeId !== null
      || payment.disputedAt !== null
      || (payment.paymentOperationId !== null && (operation?.status !== "succeeded" || operation.providerObjectId === null || disputeOperationIds.has(operation.id)));
    const unresolvedRefund = (refundsByPayment.get(payment.id) ?? []).some(({ operation: refundOperation }) => REFUND_HOLD_STATUSES.includes(refundOperation.status as (typeof REFUND_HOLD_STATUSES)[number]));
    const completedOrAmbiguousRefund = (refundsByPayment.get(payment.id) ?? []).some(({ operation: refundOperation }) => refundOperation.status === "succeeded"
      || (refundOperation.status !== "failed_terminal" && !isConfirmedNoRefundCreditOutcome(refundOperation)));
    const paymentTypeValid = operation === null
      ? payment.type === "cash" || payment.type === "check"
      : payment.type !== "cash" && payment.type !== "check";
    const reviewRequired = invalidPayment || !paymentTypeValid || untrackedAllocations || activeApplications.some(({ allocation }) => allocation.reviewRequired) || unresolvedRefund;
    const appliedMinor = activeApplications.reduce((sum, { allocation }) => sum + allocation.amountMinor, 0);
    const rawAvailable = funding.amountMinor - appliedMinor;
    if (rawAvailable < 0 || completedOrAmbiguousRefund && rawAvailable > 0) continue;
    const available = reviewRequired ? 0 : rawAvailable;
    result.set(funding.creditedBowlerId, (result.get(funding.creditedBowlerId) ?? 0) + available);
  }
  return result;
}

export async function readOwnedAccountBalancesInTransaction(
  tx: PaymentOperationTransaction,
  scope: ReadOwnedAccountBalancesInput,
): Promise<Map<number, OwnedAccountBalance>> {
  const selectedIds = scope.bowlerIds === undefined ? undefined : [...new Set(scope.bowlerIds)];
  const [ownedDebt, fundingRows, rotatingFundingRows] = await Promise.all([
    readConfirmedOwnedObligationsInTransaction(tx, { organizationId: scope.organizationId, leagueId: scope.leagueId, ...(selectedIds ? { bowlerIds: selectedIds } : {}) }),
    tx.select({ id: weeklyPaymentFundings.creditedBowlerId }).from(weeklyPaymentFundings).where(and(
      eq(weeklyPaymentFundings.organizationId, scope.organizationId),
      eq(weeklyPaymentFundings.leagueId, scope.leagueId),
      ...(selectedIds ? [inArray(weeklyPaymentFundings.creditedBowlerId, selectedIds)] : []),
    )),
    tx.select({ id: rotatingCreditFundings.bowlerId }).from(rotatingCreditFundings).where(and(
      eq(rotatingCreditFundings.organizationId, scope.organizationId),
      eq(rotatingCreditFundings.leagueId, scope.leagueId),
      ...(selectedIds ? [inArray(rotatingCreditFundings.bowlerId, selectedIds)] : []),
    )),
  ]);
  const ownerIds = selectedIds ?? [...new Set([
    ...ownedDebt.map((row) => row.debtorBowlerId),
    ...fundingRows.map((row) => row.id),
    ...rotatingFundingRows.map((row) => row.id),
  ])];
  if (ownerIds.length === 0) return new Map();
  const [genericAvailable, rotatingLots] = await Promise.all([
    readGenericFundingAvailabilityInTransaction(tx, { organizationId: scope.organizationId, leagueId: scope.leagueId, bowlerIds: ownerIds }),
    readRotatingCreditFundingBalancesInTransaction(tx, { organizationId: scope.organizationId, leagueId: scope.leagueId, bowlerIds: ownerIds }),
  ]);
  const availableByBowler = new Map(genericAvailable);
  for (const lot of rotatingLots) {
    if (!lot.reviewRequired && lot.availableMinor > 0) availableByBowler.set(lot.bowlerId, (availableByBowler.get(lot.bowlerId) ?? 0) + lot.availableMinor);
  }
  const owedByBowler = new Map<number, number>();
  for (const obligation of ownedDebt) owedByBowler.set(obligation.debtorBowlerId, (owedByBowler.get(obligation.debtorBowlerId) ?? 0) + obligation.outstandingMinor);
  return new Map(ownerIds.map((bowlerId) => {
    const availableCreditMinor = availableByBowler.get(bowlerId) ?? 0;
    const confirmedOwedMinor = owedByBowler.get(bowlerId) ?? 0;
    return [bowlerId, { bowlerId, availableCreditMinor, confirmedOwedMinor, netBalanceMinor: availableCreditMinor - confirmedOwedMinor }];
  }));
}

/** Record one immutable recipient portion of an already-persisted real tender.
 * Rotating-credit tenders are deliberately excluded: their existing funding
 * row remains the sole account source. */
export async function recordOwnedFundingInTransaction(
  tx: PaymentOperationTransaction,
  input: Omit<typeof weeklyPaymentFundings.$inferInsert, "id" | "createdAt" | "provenanceFingerprint"> & {
    authorizationItems?: ReadonlyArray<{ allocationIndex: number; amountMinor: number; snapshotFingerprint: string }>;
    now?: string;
  },
): Promise<WeeklyPaymentFunding> {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0 || input.currency !== "USD") throw new OwnedPaymentLedgerError("FUNDING_AMOUNT_INVALID");
  const [payment] = await tx.select().from(payments).where(and(
    eq(payments.id, input.paymentId),
    eq(payments.organizationId, input.organizationId),
    eq(payments.leagueId, input.leagueId),
  )).limit(1).for("update");
  if (!payment || payment.status !== "paid" || payment.currency !== input.currency) throw new OwnedPaymentLedgerError("FUNDING_PAYMENT_INVALID");
  const [rotatingSource] = await tx.select({ id: rotatingCreditFundings.id }).from(rotatingCreditFundings).where(and(
    eq(rotatingCreditFundings.organizationId, input.organizationId),
    eq(rotatingCreditFundings.leagueId, input.leagueId),
    eq(rotatingCreditFundings.paymentId, input.paymentId),
  )).limit(1);
  if (rotatingSource) throw new OwnedPaymentLedgerError("ROTATING_TENDER_ALREADY_OWNED");
  if (input.source === "provider" && input.authorizationKind === "provider_snapshot") {
    if (!input.authorizationOperationId || payment.paymentOperationId !== input.authorizationOperationId || input.authorizationItemCount !== 0) {
      throw new OwnedPaymentLedgerError("PROVIDER_FUNDING_AUTH_INVALID");
    }
    const [stored] = await tx.select().from(accountPaymentOperationSnapshots).where(and(
      eq(accountPaymentOperationSnapshots.operationId, input.authorizationOperationId),
      eq(accountPaymentOperationSnapshots.organizationId, input.organizationId),
      eq(accountPaymentOperationSnapshots.leagueId, input.leagueId),
    )).limit(1);
    if (!stored || stored.snapshotFingerprint !== input.authorizationFingerprint || stored.amountMinor !== payment.amount
      || !stored.fundingPortions.some((portion) => portion.creditedBowlerId === input.creditedBowlerId
        && portion.portionIndex === input.portionIndex && portion.amountMinor === input.amountMinor)) {
      throw new OwnedPaymentLedgerError("PROVIDER_RECIPIENT_PROOF_INVALID");
    }
  }
  if (input.authorizationKind === "legacy_provider_snapshot") {
    const itemRows = input.authorizationItems ?? [];
    if (!input.authorizationOperationId || itemRows.length !== input.authorizationItemCount
      || itemRows.reduce((sum, item) => sum + item.amountMinor, 0) !== input.amountMinor) {
      throw new OwnedPaymentLedgerError("LEGACY_PROVIDER_ITEMS_INVALID");
    }
  }
  const { authorizationItems = [], now, ...fundingInput } = input;
  const provenanceFingerprint = `lvweeklyfund:v1:${createHash("sha256").update(canonicalizePaymentOperationInput({
    ...fundingInput,
    authorizationItems,
  })).digest("hex")}`;
  const [funding] = await tx.insert(weeklyPaymentFundings).values({
    ...fundingInput,
    provenanceFingerprint,
    createdAt: now ?? new Date().toISOString(),
  }).returning();
  if (!funding) throw new OwnedPaymentLedgerError("FUNDING_CREATE_FAILED");
  if (authorizationItems.length > 0) {
    await tx.insert(weeklyPaymentFundingAuthorizationItems).values(authorizationItems.map((item) => ({
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      fundingId: funding.id,
      paymentId: input.paymentId,
      creditedBowlerId: input.creditedBowlerId,
      sourceOperationId: input.authorizationOperationId!,
      sourceAllocationIndex: item.allocationIndex,
      authorizedAmountMinor: item.amountMinor,
      sourceSnapshotFingerprint: item.snapshotFingerprint,
    })));
  }
  return funding;
}
