import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { canonicalizePaymentOperationInput } from "./payment-operation-idempotency.js";
import {
  REFUND_PAYMENT_SNAPSHOT_ACCOUNT_FUNDING_VERSION,
  accountPaymentOperationSnapshots,
  autopayConsentPartners,
  autopayConsents,
  leagueOccurrences,
  occurrencePaymentResponsibilities,
  paymentAllocationFundingApplications,
  paymentAllocationCorrections,
  paymentAllocations,
  paymentOperationRosterSnapshotItems,
  paymentOperationRosterSnapshots,
  paymentOperationStandingAutopayBindings,
  paymentOperationStandingAutopayParticipants,
  rotatingCreditApplications,
  rotatingCreditPaymentOperationSnapshots,
  weeklyPaymentFundingAuthorizationItems,
  paymentDisputes,
  paymentObligations,
  paymentOperations,
  paymentVoids,
  payments,
  refundAllocationAdjustments,
  refundPaymentOperationSnapshots,
  rotatingCreditFundings,
  rotatingCreditRefunds,
  rotatingOccurrenceAssignments,
  weeklyPaymentAllocationReleases,
  weeklyPaymentLedgerAdoptionAllocationProofs,
  weeklyPaymentFundings,
  weeklyPaymentLedgerAdoptions,
  weeklyPaymentWeekConfirmations,
  type WeeklyPaymentFunding,
  type WeeklyPaymentLedgerAdoption,
} from "@shared/schema";
import type { PaymentOperationTransaction } from "../storage/payment-operations.js";
import { canonicalObligationBalance } from "./refund-allocation-adjustments.js";
import { reconstructRefundPaymentSnapshot } from "./refund-payment-operation-snapshot.js";
import { reconstructInteractivePartnerSnapshot, type InteractivePartnerPaymentSnapshot } from "./interactive-partner-payment-snapshot.js";
import { reconstructRosterOperationSnapshot, type RosterOperationSemanticSnapshot } from "./roster-operation-snapshot.js";
import { resolvePaymentObligationOwnersInTransaction } from "./roster-obligation-owners.js";
import { reconstructAccountStandingFundingSnapshot } from "./account-standing-funding-snapshot.js";
import {
  isConfirmedNoRefundCreditOutcome,
  isRotatingCreditRefundUnresolvedForReversal,
  readRotatingCreditFundingBalancesInTransaction,
} from "./rotating-credit-applications.js";

export class OwnedPaymentLedgerError extends Error {
  constructor(public readonly code: string) {
    super("Owned payment ledger evidence is unavailable or inconsistent");
    this.name = "OwnedPaymentLedgerError";
  }
}

/** SQLSTATE used by the callable PostgreSQL ledger assertion. Provider
 * finalizers must map this failure to reconciliation-required while keeping
 * the captured tender evidence for a safe retry. */
export const OWNED_PAYMENT_LEDGER_INVARIANT_SQLSTATE = "PWL01" as const;
export const OWNED_PAYMENT_TENDER_LEDGER_CONSTRAINT = "owned_payment_tender_ledger_guard" as const;

/** Postgres driver errors are sometimes wrapped by a service boundary; inspect
 * the cause chain but require both the custom SQLSTATE and constraint name. */
export function isOwnedPaymentLedgerInvariantError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== null && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (candidate.code === OWNED_PAYMENT_LEDGER_INVARIANT_SQLSTATE
      && candidate.constraint === OWNED_PAYMENT_TENDER_LEDGER_CONSTRAINT) return true;
    current = candidate.cause;
  }
  return false;
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

export interface AssertOwnedPaymentTenderInput extends OwnedLedgerScope {
  paymentId: number;
}

/** Assert one exact tender after all payment, V4 recipient funding portions,
 * and FIFO allocations have been written. The same SQL validator is also
 * called by deferred database guards; calling it here makes provider capture
 * finalization failures observable inside its recovery savepoint. */
export async function assertOwnedPaymentTenderInTransaction(
  tx: PaymentOperationTransaction,
  scope: AssertOwnedPaymentTenderInput,
): Promise<void> {
  await tx.execute(sql`SELECT assert_owned_payment_tender_ledger(
    ${scope.organizationId}, ${scope.leagueId}, ${scope.paymentId}
  )`);
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
  pastDueAt: string;
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

export interface OwnedPaymentFundingLot {
  sourceKind: "generic" | "rotating";
  fundingId: string;
  paymentId: number;
  bowlerId: number;
  amountMinor: number;
  /** Structurally verified receipt value after completed refunds. This is
   * intentionally independent of availableMinor and reviewRequired so a
   * legitimate held refund/dispute remains recorded as incoming money. */
  receivedMinor: number;
  /** Malformed tender/recipient evidence is distinct from an intentionally
   * voided receipt, which has no incoming value and needs no account hold. */
  receiptEvidenceInvalid: boolean;
  availableMinor: number;
  reviewRequired: boolean;
  createdAt: string;
}

export interface OwnedGenericFundingSourceByPayment {
  fundingId: string;
  paymentId: number;
  creditedBowlerId: number;
  portionIndex: number;
  amountMinor: number;
  availableMinor: number;
  reviewRequired: boolean;
}

export interface ReadCompletedOwnedPaymentRefundEvidenceInput extends OwnedLedgerScope {
  paymentId: number;
  chargeOperationId: string;
  providerPaymentId: string;
  amountMinor: number;
}

export interface CompletedOwnedPaymentRefundEvidence {
  refundOperationId: string;
  providerRefundId: string;
  snapshotFingerprint: string;
  disposition: "still_owed" | "waived";
}

export class OwnedPaymentRefundEvidenceError extends Error {
  constructor() {
    super("Completed owned-payment refund evidence is inconsistent");
    this.name = "OwnedPaymentRefundEvidenceError";
  }
}

export interface OwnedPaymentFifoApplicationPlanRow {
  lot: OwnedPaymentFundingLot;
  obligation: OwnedConfirmedObligation;
  amountMinor: number;
}

export function finalizedLegacyProviderItemsMatchSnapshot(
  snapshotItems: readonly { allocationIndex: number; obligationId: string; amountMinor: number; state: string }[],
  snapshotAllocations: readonly { allocationIndex: number; obligationId: string; amountMinor: number }[],
): boolean {
  if (snapshotItems.length !== snapshotAllocations.length) return false;
  const allocationsByIndex = new Map(snapshotAllocations.map((item) => [item.allocationIndex, item]));
  if (allocationsByIndex.size !== snapshotAllocations.length) return false;
  return snapshotItems.every((item) => {
    const expected = allocationsByIndex.get(item.allocationIndex);
    return item.state === "finalized" && expected?.obligationId === item.obligationId && expected.amountMinor === item.amountMinor;
  });
}

export function legacyProviderRecipientItemsMatchSnapshot(input: {
  snapshotItems: readonly { allocationIndex: number; obligationId: string; amountMinor: number; state: string }[];
  snapshotAllocations: readonly { allocationIndex: number; obligationId: string; bowlerId: number; amountMinor: number }[];
  creditedBowlerId: number;
  authorizationItemCount: number;
  authorizationItems: readonly { allocationIndex: number; amountMinor: number; snapshotFingerprint: string }[];
  snapshotFingerprint: string;
}): boolean {
  if (!finalizedLegacyProviderItemsMatchSnapshot(input.snapshotItems, input.snapshotAllocations)) return false;
  const recipientAllocations = input.snapshotAllocations.filter((item) => item.bowlerId === input.creditedBowlerId)
    .sort((left, right) => left.allocationIndex - right.allocationIndex);
  return recipientAllocations.length === input.authorizationItemCount
    && input.authorizationItems.length === input.authorizationItemCount
    && input.authorizationItems.every((item, index) => item.snapshotFingerprint === input.snapshotFingerprint
      && item.allocationIndex === recipientAllocations[index]?.allocationIndex
      && item.amountMinor === recipientAllocations[index]?.amountMinor);
}

/** Plan one owner's source union against their oldest confirmed debts. Input
 * debt rows may arrive from independent readers; this canonical ordering is
 * the shared rule for provider charges and worksheet receipts. */
export function planOwnedFundingFifo(
  bowlerId: number,
  debts: readonly OwnedConfirmedObligation[],
  lots: readonly OwnedPaymentFundingLot[],
): OwnedPaymentFifoApplicationPlanRow[] {
  const orderedDebts = debts.filter((debt) => debt.debtorBowlerId === bowlerId && debt.outstandingMinor > 0)
    .sort((left, right) => left.occurrenceLocalDate.localeCompare(right.occurrenceLocalDate)
    || Date.parse(left.dueAt) - Date.parse(right.dueAt)
    || left.obligationId.localeCompare(right.obligationId));
  const orderedLots = lots.filter((lot) => lot.bowlerId === bowlerId && lot.availableMinor > 0)
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt)
      || left.sourceKind.localeCompare(right.sourceKind)
      || left.fundingId.localeCompare(right.fundingId));
  const plan: OwnedPaymentFifoApplicationPlanRow[] = [];
  let lotIndex = 0;
  let lotRemaining = orderedLots[0]?.availableMinor ?? 0;
  for (const debt of orderedDebts) {
    if (debt.reviewRequired) break;
    let dueMinor = debt.outstandingMinor;
    while (dueMinor > 0 && lotIndex < orderedLots.length) {
      const lot = orderedLots[lotIndex];
      if (!lot) break;
      if (lotRemaining <= 0) {
        lotIndex += 1;
        lotRemaining = orderedLots[lotIndex]?.availableMinor ?? 0;
        continue;
      }
      const amountMinor = Math.min(dueMinor, lotRemaining);
      plan.push({ lot, obligation: debt, amountMinor });
      dueMinor -= amountMinor;
      lotRemaining -= amountMinor;
    }
  }
  return plan;
}

const REVIEW_DISPUTE_STATES = new Set([
  "INQUIRY_EVIDENCE_REQUIRED",
  "INQUIRY_PROCESSING",
  "EVIDENCE_REQUIRED",
  "PROCESSING",
  "LOST",
  "ACCEPTED",
]);

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
  const confirmed = obligations.filter(({ occurrenceLocalDate, obligation }) => isOccurrenceConfirmedInOwnedLedger(
    adoption,
    occurrenceLocalDate ?? "",
    confirmedOccurrenceIds.has(obligation.occurrenceId),
  ));
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
    providerPaymentId: payments.providerPaymentId,
    amount: payments.amount,
    disputeId: payments.disputeId,
    disputedAt: payments.disputedAt,
  }).from(payments).where(and(
    eq(payments.organizationId, scope.organizationId),
    eq(payments.leagueId, scope.leagueId),
    inArray(payments.id, paymentIds),
  ));
  const paymentById = new Map(sourcePayments.map((payment) => [payment.id, payment]));
  const operationIds = [...new Set(sourcePayments.flatMap((payment) => payment.paymentOperationId === null ? [] : [payment.paymentOperationId]))];
  const [disputes, operationRows, refundEvidenceRows] = await Promise.all([
    operationIds.length === 0 ? Promise.resolve([]) : tx.select({ operationId: paymentDisputes.paymentOperationId, state: paymentDisputes.state }).from(paymentDisputes).where(and(
      eq(paymentDisputes.organizationId, scope.organizationId),
      inArray(paymentDisputes.paymentOperationId, operationIds),
    )),
    operationIds.length === 0 ? Promise.resolve([]) : tx.select({ id: paymentOperations.id, status: paymentOperations.status }).from(paymentOperations).where(and(
      eq(paymentOperations.organizationId, scope.organizationId),
      eq(paymentOperations.leagueId, scope.leagueId),
      inArray(paymentOperations.id, operationIds),
    )),
    paymentIds.length === 0 ? Promise.resolve([]) : tx.select({
      snapshot: refundPaymentOperationSnapshots,
      operation: paymentOperations,
    }).from(refundPaymentOperationSnapshots).innerJoin(paymentOperations, and(
      eq(paymentOperations.id, refundPaymentOperationSnapshots.operationId),
      eq(paymentOperations.organizationId, scope.organizationId),
    )).where(and(
      eq(refundPaymentOperationSnapshots.leagueId, scope.leagueId),
      inArray(refundPaymentOperationSnapshots.paymentId, paymentIds),
    )),
  ]);
  const disputedOperationIds = new Set(disputes.filter((row) => REVIEW_DISPUTE_STATES.has(row.state)).map((row) => row.operationId));
  const operationById = new Map(operationRows.map((row) => [row.id, row]));
  const validRefundPaymentIds = new Set<number>();
  const incompatibleRefundPaymentIds = new Set<number>();
  const refundRowsByPayment = new Map<number, typeof refundEvidenceRows>();
  for (const row of refundEvidenceRows) refundRowsByPayment.set(row.snapshot.paymentId, [
    ...(refundRowsByPayment.get(row.snapshot.paymentId) ?? []), row,
  ]);
  for (const payment of sourcePayments) {
    const hasSucceededRefund = (refundRowsByPayment.get(payment.id) ?? []).some(({ operation: refundOperation }) => refundOperation.status === "succeeded");
    if (payment.status !== "refunded" && !hasSucceededRefund) continue;
    try {
      const proof = await readCompletedOwnedPaymentRefundEvidenceInTransaction(tx, {
        organizationId: scope.organizationId,
        leagueId: scope.leagueId,
        paymentId: payment.id,
        chargeOperationId: payment.paymentOperationId ?? "",
        providerPaymentId: payment.providerPaymentId ?? "",
        amountMinor: payment.amount,
      });
      if (proof) validRefundPaymentIds.add(payment.id);
      else incompatibleRefundPaymentIds.add(payment.id);
    } catch (error) {
      if (!(error instanceof OwnedPaymentRefundEvidenceError)) throw error;
      incompatibleRefundPaymentIds.add(payment.id);
    }
  }
  const heldPaymentIds = new Set(refundEvidenceRows.filter(({ snapshot, operation: refundOperation }) =>
    refundOperation.status === "succeeded"
      ? !validRefundPaymentIds.has(snapshot.paymentId)
      : !isConfirmedNoRefundCreditOutcome(refundOperation)
  ).map(({ snapshot }) => snapshot.paymentId));
  const confirmedRows: OwnedConfirmedObligation[] = [];
  for (const { obligation, occurrenceLocalDate, responsibility } of confirmed) {
    if (occurrenceLocalDate === null) throw new OwnedPaymentLedgerError("CONFIRMED_OCCURRENCE_DATE_MISSING");
    const owner = owners.get(obligation.id);
    if (!owner) throw new OwnedPaymentLedgerError("OBLIGATION_OWNER_MISSING");
    let creditedOwnerBowlerId: number;
    let targetKind: OwnedConfirmedObligation["targetKind"];
    let assignmentId: string | null = null;
    if (owner.kind === "bowler") {
      creditedOwnerBowlerId = owner.bowlerId;
      targetKind = "bowler_responsibility";
      if (obligation.payerBowlerId === null || obligation.payerBowlerId !== owner.bowlerId) {
        throw new OwnedPaymentLedgerError("OBLIGATION_PAYER_OWNER_MISMATCH");
      }
    } else {
      const slotIndex = responsibility.slotIndex;
      if (slotIndex === null) throw new OwnedPaymentLedgerError("TEAM_OBLIGATION_SLOT_MISSING");
      const assignment = latestAssignmentBySlot.get(`${obligation.occurrenceId}:${responsibility.teamId}:${slotIndex}`);
      if (!assignment || assignment.responsibilityId !== responsibility.id || assignment.actualBowlerId === null || owner.teamId !== responsibility.teamId) {
        throw new OwnedPaymentLedgerError("TEAM_OBLIGATION_ASSIGNMENT_INVALID");
      }
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
    const reviewRequired = linkedAllocations.some(({ allocation }) => {
      if (allocation.reviewRequired) return true;
      const payment = paymentById.get(allocation.paymentId);
      const refundedWithProof = payment?.status === "refunded" && validRefundPaymentIds.has(payment.id);
      if (!payment || (payment.status !== "paid" && !refundedWithProof)
        || payment.disputeId !== null || payment.disputedAt !== null
        || incompatibleRefundPaymentIds.has(payment.id)) return true;
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
      pastDueAt: obligation.pastDueAt,
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

export async function readGenericFundingAvailabilityInTransaction(
  tx: PaymentOperationTransaction,
  scope: OwnedLedgerScope & {
    bowlerIds?: readonly number[];
    paymentIds?: readonly number[];
  },
): Promise<OwnedPaymentFundingLot[]> {
  if (scope.bowlerIds?.length === 0 || scope.paymentIds?.length === 0) return [];
  const selectedBowlerIds = scope.bowlerIds === undefined ? undefined : [...new Set(scope.bowlerIds)];
  const selectedPaymentIds = scope.paymentIds === undefined ? undefined : [...new Set(scope.paymentIds)];
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
      ...(selectedBowlerIds ? [inArray(weeklyPaymentFundings.creditedBowlerId, selectedBowlerIds)] : []),
      ...(selectedPaymentIds ? [inArray(weeklyPaymentFundings.paymentId, selectedPaymentIds)] : []),
    )).orderBy(asc(weeklyPaymentFundings.createdAt), asc(weeklyPaymentFundings.id));
  if (rows.length === 0) return [];
  const paymentIds = [...new Set(rows.map(({ funding }) => funding.paymentId))];
  const [allFundings, allPaymentAllocations, voids, refunds, disputes, corrections, releases, rotatingSources] = await Promise.all([
    tx.select().from(weeklyPaymentFundings).where(and(
      eq(weeklyPaymentFundings.organizationId, scope.organizationId),
      eq(weeklyPaymentFundings.leagueId, scope.leagueId),
      inArray(weeklyPaymentFundings.paymentId, paymentIds),
    )),
    tx.select({ allocation: paymentAllocations }).from(paymentAllocations).where(and(
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
      )).where(and(
        eq(refundPaymentOperationSnapshots.leagueId, scope.leagueId),
        inArray(refundPaymentOperationSnapshots.paymentId, paymentIds),
      )),
    tx.select({ operationId: paymentDisputes.paymentOperationId, state: paymentDisputes.state }).from(paymentDisputes).where(and(
      eq(paymentDisputes.organizationId, scope.organizationId),
      inArray(paymentDisputes.paymentOperationId, [...new Set(rows.flatMap(({ payment }) => payment.paymentOperationId === null ? [] : [payment.paymentOperationId]))]),
    )),
    tx.select().from(paymentAllocationCorrections).where(and(
      eq(paymentAllocationCorrections.organizationId, scope.organizationId),
      eq(paymentAllocationCorrections.leagueId, scope.leagueId),
      inArray(paymentAllocationCorrections.paymentId, paymentIds),
    )),
    tx.select().from(weeklyPaymentAllocationReleases).where(and(
      eq(weeklyPaymentAllocationReleases.organizationId, scope.organizationId),
      eq(weeklyPaymentAllocationReleases.leagueId, scope.leagueId),
      inArray(weeklyPaymentAllocationReleases.paymentId, paymentIds),
    )),
    tx.select({ paymentId: rotatingCreditFundings.paymentId }).from(rotatingCreditFundings).where(and(
      eq(rotatingCreditFundings.organizationId, scope.organizationId),
      eq(rotatingCreditFundings.leagueId, scope.leagueId),
      inArray(rotatingCreditFundings.paymentId, paymentIds),
    )),
  ]);
  const fundingIds = allFundings.map(({ id }) => id);
  const applications = await tx.select({ application: paymentAllocationFundingApplications, allocation: paymentAllocations }).from(paymentAllocationFundingApplications)
    .innerJoin(paymentAllocations, and(
      eq(paymentAllocations.id, paymentAllocationFundingApplications.allocationId),
      eq(paymentAllocations.organizationId, scope.organizationId),
      eq(paymentAllocations.leagueId, scope.leagueId),
    )).where(and(
      eq(paymentAllocationFundingApplications.organizationId, scope.organizationId),
      eq(paymentAllocationFundingApplications.leagueId, scope.leagueId),
      inArray(paymentAllocationFundingApplications.genericFundingId, fundingIds),
    ));
  const appByFunding = new Map<string, typeof applications>();
  const appByAllocation = new Map<string, typeof applications>();
  for (const row of applications) {
    if (row.application.genericFundingId) appByFunding.set(row.application.genericFundingId, [...(appByFunding.get(row.application.genericFundingId) ?? []), row]);
    appByAllocation.set(row.allocation.id, [...(appByAllocation.get(row.allocation.id) ?? []), row]);
  }
  const fundingsById = new Map(allFundings.map((funding) => [funding.id, funding]));
  const fundingsByPayment = new Map<number, typeof allFundings>();
  for (const funding of allFundings) fundingsByPayment.set(funding.paymentId, [...(fundingsByPayment.get(funding.paymentId) ?? []), funding]);
  const allAllocationsByPayment = new Map<number, typeof allPaymentAllocations>();
  for (const row of allPaymentAllocations) allAllocationsByPayment.set(row.allocation.paymentId, [...(allAllocationsByPayment.get(row.allocation.paymentId) ?? []), row]);
  const allocationsById = new Map(allPaymentAllocations.map(({ allocation }) => [allocation.id, allocation]));
  const validCorrectionSourceIds = new Set(corrections.filter((correction) => {
    const source = allocationsById.get(correction.sourceAllocationId);
    const replacement = allocationsById.get(correction.replacementAllocationId);
    return source?.paymentId === correction.paymentId && source.obligationId === correction.sourceObligationId
      && source.amountMinor === correction.amountMinor && source.currency === correction.currency && source.state === "voided"
      && replacement?.paymentId === correction.paymentId && replacement.obligationId === correction.targetObligationId
      && replacement.amountMinor === correction.amountMinor && replacement.currency === correction.currency;
  }).map((correction) => correction.sourceAllocationId));
  const appsById = new Map(applications.map(({ application }) => [application.id, application]));
  const validReleaseSourceIds = new Set(releases.filter((release) => {
    const application = appsById.get(release.fundingApplicationId);
    const allocation = allocationsById.get(release.sourceAllocationId);
    return application?.allocationId === release.sourceAllocationId
      && application.paymentId === release.paymentId && application.creditedBowlerId === release.creditedBowlerId
      && application.obligationId === release.sourceObligationId && application.amountMinor === release.sourceApplicationAmountMinor
      && allocation?.paymentId === release.paymentId && allocation.state === "voided"
      && release.retainedAmountMinor === 0 && release.releasedAmountMinor === release.sourceApplicationAmountMinor
      && release.replacementAllocationId === null;
  }).map((release) => release.sourceAllocationId));
  const rotatingPaymentIds = new Set(rotatingSources.map((row) => row.paymentId));
  const voidPaymentIds = new Set(voids.map(({ paymentId }) => paymentId));
  const disputeOperationIds = new Set(disputes.filter((row) => REVIEW_DISPUTE_STATES.has(row.state)).map((row) => row.operationId));
  const refundsByPayment = new Map<number, typeof refunds>();
  for (const row of refunds) refundsByPayment.set(row.snapshot.paymentId, [...(refundsByPayment.get(row.snapshot.paymentId) ?? []), row]);
  const validRefundPaymentIds = new Set<number>();
  const incompatibleRefundPaymentIds = new Set<number>();
  const uniqueSourcePayments = new Map(rows.map(({ payment }) => [payment.id, payment]));
  for (const payment of uniqueSourcePayments.values()) {
    const hasSucceededRefund = (refundsByPayment.get(payment.id) ?? []).some(({ operation: refundOperation }) => refundOperation.status === "succeeded");
    if (payment.status !== "refunded" && !hasSucceededRefund) continue;
    try {
      const proof = await readCompletedOwnedPaymentRefundEvidenceInTransaction(tx, {
        organizationId: scope.organizationId,
        leagueId: scope.leagueId,
        paymentId: payment.id,
        chargeOperationId: payment.paymentOperationId ?? "",
        providerPaymentId: payment.providerPaymentId ?? "",
        amountMinor: payment.amount,
      });
      if (proof) validRefundPaymentIds.add(payment.id);
      else incompatibleRefundPaymentIds.add(payment.id);
    } catch (error) {
      if (!(error instanceof OwnedPaymentRefundEvidenceError)) throw error;
      incompatibleRefundPaymentIds.add(payment.id);
    }
  }
  const result: OwnedPaymentFundingLot[] = [];
  for (const { funding, payment, operation } of rows) {
    const linkedApps = appByFunding.get(funding.id) ?? [];
    const activeApplications = linkedApps.filter(({ allocation }) => allocation.state === "active");
    const paymentFundings = [...(fundingsByPayment.get(payment.id) ?? [])].sort((left, right) => left.portionIndex - right.portionIndex);
    const partitionInvalid = paymentFundings.reduce((sum, row) => sum + row.amountMinor, 0) !== payment.amount
      || paymentFundings.some((row, index) => row.currency !== payment.currency || row.portionIndex !== index)
      || new Set(paymentFundings.map((row) => row.creditedBowlerId)).size !== paymentFundings.length;
    const paymentAllocations = allAllocationsByPayment.get(payment.id) ?? [];
    const untrackedAllocations = paymentAllocations.some(({ allocation }) => {
      const allocationApps = appByAllocation.get(allocation.id) ?? [];
      if (allocationApps.length === 0 && allocation.state === "voided" && validCorrectionSourceIds.has(allocation.id)) return false;
      if (allocationApps.length !== 1) return true;
      const linked = allocationApps[0];
      const source = linked?.application.genericFundingId ? fundingsById.get(linked.application.genericFundingId) : undefined;
      const sourceMismatch = !linked || !source || source.paymentId !== payment.id
        || linked.application.paymentId !== payment.id || linked.application.rotatingFundingId !== null
        || source.creditedBowlerId !== linked.application.creditedBowlerId
        || source.amountMinor !== linked.application.sourceAmountMinor
        || linked.application.amountMinor !== allocation.amountMinor
        || linked.application.obligationId !== allocation.obligationId
        || linked.application.currency !== allocation.currency;
      const voidWithoutLineage = allocation.state === "voided"
        && !validCorrectionSourceIds.has(allocation.id) && !validReleaseSourceIds.has(allocation.id);
      return sourceMismatch || voidWithoutLineage || !["active", "voided"].includes(allocation.state);
    });
    const validCompletedRefund = validRefundPaymentIds.has(payment.id);
    const invalidPayment = (payment.status !== "paid" && !(payment.status === "refunded" && validCompletedRefund))
      || voidPaymentIds.has(payment.id)
      || payment.disputeId !== null
      || payment.disputedAt !== null
      || (payment.paymentOperationId === null
        ? payment.providerPaymentId !== null
        : operation?.status !== "succeeded" || operation.providerObjectId === null
          || payment.providerPaymentId !== operation.providerObjectId || disputeOperationIds.has(operation.id));
    const refundRequiresReview = (refundsByPayment.get(payment.id) ?? []).some(({ operation: refundOperation }) => refundOperation.status === "succeeded"
      ? !validCompletedRefund
      : !isConfirmedNoRefundCreditOutcome(refundOperation))
      || incompatibleRefundPaymentIds.has(payment.id);
    const paymentTypeValid = operation === null
      ? payment.type === "cash" || payment.type === "check"
      : payment.type !== "cash" && payment.type !== "check";
    const explicitlyVoided = voidPaymentIds.has(payment.id);
    const validOriginalTender = payment.amount > 0
      && Number.isSafeInteger(payment.amount)
      && payment.currency === "USD"
      && paymentTypeValid
      && (payment.paymentOperationId === null
        ? payment.providerPaymentId === null
        : operation?.status === "succeeded" && operation.providerObjectId !== null
          && payment.providerPaymentId === operation.providerObjectId)
      && !partitionInvalid;
    const validReceiptStatus = payment.status === "paid" || payment.status === "disputed"
      || (payment.status === "refunded" && validCompletedRefund);
    const receiptEvidenceInvalid = !explicitlyVoided && (!validOriginalTender || !validReceiptStatus);
    const receivedMinor = explicitlyVoided || receiptEvidenceInvalid || rotatingPaymentIds.has(payment.id) || validCompletedRefund
      ? 0
      : funding.amountMinor;
    const appliedMinor = activeApplications.reduce((sum, { allocation }) => sum + allocation.amountMinor, 0);
    const rawAvailable = funding.amountMinor - appliedMinor;
    const reviewRequired = invalidPayment || !paymentTypeValid || partitionInvalid || rotatingPaymentIds.has(payment.id)
      || untrackedAllocations || activeApplications.some(({ allocation }) => allocation.reviewRequired)
      || refundRequiresReview || rawAvailable < 0;
    const available = validCompletedRefund ? 0 : reviewRequired ? 0 : rawAvailable;
    result.push({
      sourceKind: "generic",
      fundingId: funding.id,
      paymentId: funding.paymentId,
      bowlerId: funding.creditedBowlerId,
      amountMinor: funding.amountMinor,
      receivedMinor,
      receiptEvidenceInvalid,
      availableMinor: available,
      reviewRequired,
      createdAt: funding.createdAt,
    });
  }
  return result;
}

/** Return every generic recipient portion for one exact tender, including
 * zero-available or held portions. This uses the same validated accounting
 * path as account reads/FIFO so full-tender refund snapshots cannot omit an
 * unusable portion or calculate a parallel balance. */
export async function readOwnedGenericFundingSourcesByPaymentInTransaction(
  tx: PaymentOperationTransaction,
  scope: OwnedLedgerScope & { paymentId: number },
): Promise<OwnedGenericFundingSourceByPayment[]> {
  const [lots, portions] = await Promise.all([
    readGenericFundingAvailabilityInTransaction(tx, {
      organizationId: scope.organizationId,
      leagueId: scope.leagueId,
      paymentIds: [scope.paymentId],
    }),
    tx.select().from(weeklyPaymentFundings).where(and(
      eq(weeklyPaymentFundings.organizationId, scope.organizationId),
      eq(weeklyPaymentFundings.leagueId, scope.leagueId),
      eq(weeklyPaymentFundings.paymentId, scope.paymentId),
    )).orderBy(asc(weeklyPaymentFundings.portionIndex), asc(weeklyPaymentFundings.id)),
  ]);
  const lotsById = new Map(lots.map((lot) => [lot.fundingId, lot]));
  return portions.map((portion) => {
    const lot = lotsById.get(portion.id);
    const rowIdentityMatches = lot !== undefined
      && lot.paymentId === portion.paymentId
      && lot.bowlerId === portion.creditedBowlerId
      && lot.amountMinor === portion.amountMinor;
    return {
      fundingId: portion.id,
      paymentId: portion.paymentId,
      creditedBowlerId: portion.creditedBowlerId,
      portionIndex: portion.portionIndex,
      amountMinor: portion.amountMinor,
      availableMinor: rowIdentityMatches && lot ? lot.availableMinor : 0,
      reviewRequired: !rowIdentityMatches || (lot?.reviewRequired ?? true),
    };
  });
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
  const [genericLots, rotatingLots] = await Promise.all([
    readGenericFundingAvailabilityInTransaction(tx, { organizationId: scope.organizationId, leagueId: scope.leagueId, bowlerIds: ownerIds }),
    readRotatingCreditFundingBalancesInTransaction(tx, { organizationId: scope.organizationId, leagueId: scope.leagueId, bowlerIds: ownerIds }),
  ]);
  const availableByBowler = new Map<number, number>();
  for (const lot of genericLots) {
    if (lot.availableMinor > 0) availableByBowler.set(lot.bowlerId, (availableByBowler.get(lot.bowlerId) ?? 0) + lot.availableMinor);
  }
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
interface LegacyProviderSnapshotAllocation {
  allocationIndex: number;
  obligationId: string;
  bowlerId: number;
  amountMinor: number;
}

interface LegacyProviderSnapshotEvidence {
  operationId: string;
  fingerprint: string;
  items: Array<{ allocationIndex: number; obligationId: string; amountMinor: number; state: string }>;
  allocations: LegacyProviderSnapshotAllocation[];
}

/** Reconstruct the original, immutable recipient allocations for a legacy
 * provider tender. This reader has no adoption-marker dependency so it can be
 * used by the one-time preflight before any ledger rows exist. */
async function readLegacyProviderSnapshotEvidenceInTransaction(
  tx: PaymentOperationTransaction,
  input: {
    organizationId: number;
    leagueId: number;
    payment: typeof payments.$inferSelect;
  },
): Promise<LegacyProviderSnapshotEvidence> {
  const authorizationOperationId = input.payment.paymentOperationId;
  if (!authorizationOperationId || !input.payment.providerPaymentId
    || input.payment.type === "cash" || input.payment.type === "check") {
    throw new OwnedPaymentLedgerError("LEGACY_PROVIDER_SNAPSHOT_INVALID");
  }
  const [operationRows, snapshotRows] = await Promise.all([
    tx.select().from(paymentOperations).where(and(
      eq(paymentOperations.id, authorizationOperationId),
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.leagueId, input.leagueId),
    )).limit(1),
    tx.select().from(paymentOperationRosterSnapshots).where(and(
      eq(paymentOperationRosterSnapshots.operationId, authorizationOperationId),
      eq(paymentOperationRosterSnapshots.organizationId, input.organizationId),
      eq(paymentOperationRosterSnapshots.leagueId, input.leagueId),
    )).limit(1),
  ]);
  const [operation] = operationRows;
  const [snapshot] = snapshotRows;
  if (!operation || operation.status !== "succeeded" || operation.providerObjectId === null
    || input.payment.providerPaymentId !== operation.providerObjectId
    || operation.amountMinor !== input.payment.amount || operation.currency !== input.payment.currency
    || !snapshot || !["interactive", "standing_autopay"].includes(snapshot.snapshotKind)
    || (snapshot.snapshotKind === "interactive" && operation.operationType !== "interactive_charge")
    || (snapshot.snapshotKind === "standing_autopay" && operation.operationType !== "standing_autopay_charge")
    || snapshot.amountMinor !== input.payment.amount || snapshot.currency !== input.payment.currency
    || (snapshot.snapshotKind === "interactive" && snapshot.payerBowlerId !== input.payment.bowlerId)) {
    throw new OwnedPaymentLedgerError("LEGACY_PROVIDER_SNAPSHOT_INVALID");
  }
  const items = await tx.select({
    allocationIndex: paymentOperationRosterSnapshotItems.allocationIndex,
    obligationId: paymentOperationRosterSnapshotItems.obligationId,
    amountMinor: paymentOperationRosterSnapshotItems.amountMinor,
    state: paymentOperationRosterSnapshotItems.state,
  }).from(paymentOperationRosterSnapshotItems).where(and(
    eq(paymentOperationRosterSnapshotItems.operationId, authorizationOperationId),
    eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId),
    eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId),
  )).orderBy(asc(paymentOperationRosterSnapshotItems.allocationIndex));
  if (items.length === 0 || items.some((item) => item.state !== "finalized")) {
    throw new OwnedPaymentLedgerError("LEGACY_PROVIDER_ITEMS_INVALID");
  }
  type SnapshotAllocation = { allocationIndex?: number; obligationId?: string; bowlerId?: number; payerBowlerId?: number; amountMinor?: number };
  const recordedSnapshotRows = Array.isArray(snapshot.obligations) ? snapshot.obligations as SnapshotAllocation[] : [];
  const allocations: LegacyProviderSnapshotAllocation[] = [];
  if (snapshot.snapshotKind === "interactive" && snapshot.snapshotVersion === 2
    && snapshot.requestKind !== null && snapshot.encryptedSourceId !== null && snapshot.payerBowlerId !== null
    && snapshot.sourceKind !== null && snapshot.quoteFingerprint !== null) {
    try {
      const reconstructed = reconstructRosterOperationSnapshot({
        organizationId: input.organizationId,
        amountMinor: operation.amountMinor,
        currency: operation.currency,
        providerName: operation.providerName,
        providerIdempotencyKey: operation.providerIdempotencyKey,
        stored: {
          snapshotVersion: 2,
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
        },
        allocations: recordedSnapshotRows as RosterOperationSemanticSnapshot["allocations"],
        lineItems: snapshot.lineItems,
      });
      allocations.push(...reconstructed.allocations.map((row) => ({
        allocationIndex: row.allocationIndex,
        obligationId: row.obligationId,
        bowlerId: row.bowlerId,
        amountMinor: row.amountMinor,
      })));
    } catch {
      throw new OwnedPaymentLedgerError("LEGACY_PROVIDER_SNAPSHOT_INVALID");
    }
  } else if (snapshot.snapshotKind === "interactive" && snapshot.snapshotVersion === 3
    && snapshot.requestKind !== null && snapshot.encryptedSourceId !== null && snapshot.payerBowlerId !== null
    && snapshot.sourceKind !== null && snapshot.quoteFingerprint !== null && snapshot.partnerEvidence !== null) {
    try {
      const reconstructed = reconstructInteractivePartnerSnapshot({
        organizationId: input.organizationId,
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
        allocations: recordedSnapshotRows as InteractivePartnerPaymentSnapshot["allocations"],
        lineItems: snapshot.lineItems,
      });
      allocations.push(...reconstructed.allocations.map((row) => ({
        allocationIndex: row.allocationIndex,
        obligationId: row.obligationId,
        bowlerId: row.bowlerId,
        amountMinor: row.amountMinor,
      })));
    } catch {
      throw new OwnedPaymentLedgerError("LEGACY_PROVIDER_SNAPSHOT_INVALID");
    }
  } else if (snapshot.snapshotKind === "standing_autopay" && snapshot.snapshotVersion === 2
    && operation.operationType === "standing_autopay_charge") {
    const [bindingRows, participantRows] = await Promise.all([
      tx.select().from(paymentOperationStandingAutopayBindings).where(and(
        eq(paymentOperationStandingAutopayBindings.operationId, authorizationOperationId),
        eq(paymentOperationStandingAutopayBindings.organizationId, input.organizationId),
        eq(paymentOperationStandingAutopayBindings.leagueId, input.leagueId),
      )).limit(1),
      tx.select().from(paymentOperationStandingAutopayParticipants).where(and(
        eq(paymentOperationStandingAutopayParticipants.operationId, authorizationOperationId),
        eq(paymentOperationStandingAutopayParticipants.organizationId, input.organizationId),
        eq(paymentOperationStandingAutopayParticipants.leagueId, input.leagueId),
      )),
    ]);
    const [binding] = bindingRows;
    const [consent] = binding ? await tx.select({
      id: autopayConsents.id,
      consentVersion: autopayConsents.consentVersion,
      payerBowlerId: autopayConsents.payerBowlerId,
      providerName: autopayConsents.providerName,
      providerLocationId: autopayConsents.providerLocationId,
    }).from(autopayConsents).where(and(
      eq(autopayConsents.id, binding.consentId),
      eq(autopayConsents.organizationId, input.organizationId),
      eq(autopayConsents.leagueId, input.leagueId),
      eq(autopayConsents.consentVersion, binding.consentVersion),
    )).limit(1) : [];
    const consentPartnerRows = binding ? await tx.select({
      partnerBowlerId: autopayConsentPartners.partnerBowlerId,
      paymentLinkId: autopayConsentPartners.paymentLinkId,
      linkFingerprint: autopayConsentPartners.linkFingerprint,
    }).from(autopayConsentPartners).where(and(
      eq(autopayConsentPartners.organizationId, input.organizationId),
      eq(autopayConsentPartners.leagueId, input.leagueId),
      eq(autopayConsentPartners.consentVersion, binding.consentVersion),
      eq(autopayConsentPartners.consentId, binding.consentId),
    )) : [];
    const participantByIndex = new Map(participantRows.map((row) => [row.allocationIndex, row]));
    const consentPartnersByBowler = new Map(consentPartnerRows.map((row) => [row.partnerBowlerId, row]));
    if (!binding || binding.evidenceFingerprint !== snapshot.snapshotFingerprint || participantRows.length !== items.length
      || !consent || consent.id !== binding.consentId || consent.consentVersion !== binding.consentVersion
      || consent.payerBowlerId !== input.payment.bowlerId || (consent.providerName ?? "square") !== operation.providerName
      || (consent.providerLocationId ?? "") !== binding.providerLocationId
      || binding.providerName !== operation.providerName
      || operation.triggerOccurrenceId !== binding.triggerOccurrenceId
      || Date.parse(snapshot.cutoffAt ?? "") !== Date.parse(binding.cutoffAt)
      || snapshot.collectionMode !== binding.collectionMode
      || participantRows.some((row) => row.consentVersion !== binding.consentVersion)) {
      throw new OwnedPaymentLedgerError("LEGACY_PROVIDER_SNAPSHOT_INVALID");
    }
    for (const item of items) {
      const record = recordedSnapshotRows.find((row) => row.allocationIndex === item.allocationIndex);
      const participant = participantByIndex.get(item.allocationIndex);
      if (!record || record.obligationId !== item.obligationId || record.amountMinor !== item.amountMinor
        || !Number.isSafeInteger(record.payerBowlerId) || !participant || participant.obligationId !== item.obligationId
        || participant.bowlerId !== record.payerBowlerId
        || (participant.role === "payer"
          ? participant.bowlerId !== consent.payerBowlerId || participant.paymentLinkId !== null || participant.linkFingerprint !== null
          : participant.role !== "partner"
            || participant.bowlerId === consent.payerBowlerId
            || consentPartnersByBowler.get(participant.bowlerId)?.paymentLinkId !== participant.paymentLinkId
            || consentPartnersByBowler.get(participant.bowlerId)?.linkFingerprint !== participant.linkFingerprint)) {
        throw new OwnedPaymentLedgerError("LEGACY_PROVIDER_SNAPSHOT_INVALID");
      }
      allocations.push({
        allocationIndex: item.allocationIndex,
        obligationId: item.obligationId,
        bowlerId: participant.bowlerId,
        amountMinor: item.amountMinor,
      });
    }
  } else {
    throw new OwnedPaymentLedgerError("LEGACY_PROVIDER_SNAPSHOT_INVALID");
  }
  if (!finalizedLegacyProviderItemsMatchSnapshot(items, allocations)
    || allocations.reduce((sum, row) => sum + row.amountMinor, 0) !== input.payment.amount) {
    throw new OwnedPaymentLedgerError("LEGACY_PROVIDER_ITEMS_INVALID");
  }
  return { operationId: authorizationOperationId, fingerprint: snapshot.snapshotFingerprint, items, allocations };
}

export interface LegacyFundingAuthorizationPortion {
  creditedBowlerId: number;
  portionIndex: number;
  amountMinor: number;
  authorizationKind: "legacy_payment" | "legacy_provider_snapshot";
  authorizationOperationId: string | null;
  authorizationItemCount: number;
  authorizationFingerprint: string;
  authorizationItems: Array<{ allocationIndex: number; amountMinor: number; snapshotFingerprint: string }>;
}

/** Strict read-only source-of-funds proof used by the guarded league-adoption
 * planner. It deliberately has no marker override: ordinary writes continue
 * through the existing validator below and still require a durable marker. */
export async function readLegacyFundingAuthorizationInTransaction(
  tx: PaymentOperationTransaction,
  input: { organizationId: number; leagueId: number; paymentId: number; payment?: typeof payments.$inferSelect },
): Promise<{ payment: typeof payments.$inferSelect; portions: LegacyFundingAuthorizationPortion[] }> {
  const [selectedPayment] = input.payment === undefined ? await tx.select().from(payments).where(and(
    eq(payments.id, input.paymentId),
    eq(payments.organizationId, input.organizationId),
    eq(payments.leagueId, input.leagueId),
  )).limit(1) : [input.payment];
  const payment = selectedPayment;
  if (payment && (payment.id !== input.paymentId || payment.organizationId !== input.organizationId || payment.leagueId !== input.leagueId)) {
    throw new OwnedPaymentLedgerError("LEGACY_PAYMENT_SCOPE_INVALID");
  }
  if (!payment || payment.status !== "paid" || payment.currency !== "USD"
    || !Number.isSafeInteger(payment.amount) || payment.amount <= 0) {
    throw new OwnedPaymentLedgerError(payment?.status === "refunded" ? "LEGACY_REFUNDED_TENDER_UNSUPPORTED" : "LEGACY_PAYMENT_INVALID");
  }
  const [rotatingSource] = await tx.select({ id: rotatingCreditFundings.id }).from(rotatingCreditFundings).where(and(
    eq(rotatingCreditFundings.organizationId, input.organizationId),
    eq(rotatingCreditFundings.leagueId, input.leagueId),
    eq(rotatingCreditFundings.paymentId, input.paymentId),
  )).limit(1);
  if (rotatingSource) throw new OwnedPaymentLedgerError("ROTATING_TENDER_ALREADY_OWNED");
  if (payment.paymentOperationId === null && payment.providerPaymentId === null
    && (payment.type === "cash" || payment.type === "check")) {
    const fingerprint = `lvweeklyadopt:v1:${createHash("sha256").update(canonicalizePaymentOperationInput({
      version: 1,
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      paymentId: payment.id,
      creditedBowlerId: payment.bowlerId,
      amountMinor: payment.amount,
      currency: payment.currency,
      type: payment.type,
      createdAt: payment.createdAt,
    })).digest("hex")}`;
    return {
      payment,
      portions: [{
        creditedBowlerId: payment.bowlerId,
        portionIndex: 0,
        amountMinor: payment.amount,
        authorizationKind: "legacy_payment",
        authorizationOperationId: null,
        authorizationItemCount: 0,
        authorizationFingerprint: fingerprint,
        authorizationItems: [],
      }],
    };
  }
  const evidence = await readLegacyProviderSnapshotEvidenceInTransaction(tx, { ...input, payment });
  const allocationsByOwner = new Map<number, LegacyProviderSnapshotAllocation[]>();
  for (const allocation of evidence.allocations) {
    const owned = allocationsByOwner.get(allocation.bowlerId) ?? [];
    owned.push(allocation);
    allocationsByOwner.set(allocation.bowlerId, owned);
  }
  const ownerRows = [...allocationsByOwner.entries()].sort((left, right) =>
    Math.min(...left[1].map((row) => row.allocationIndex)) - Math.min(...right[1].map((row) => row.allocationIndex)));
  const portions = ownerRows.map(([creditedBowlerId, ownerAllocations], portionIndex): LegacyFundingAuthorizationPortion => ({
    creditedBowlerId,
    portionIndex,
    amountMinor: ownerAllocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0),
    authorizationKind: "legacy_provider_snapshot",
    authorizationOperationId: evidence.operationId,
    authorizationItemCount: ownerAllocations.length,
    authorizationFingerprint: evidence.fingerprint,
    authorizationItems: ownerAllocations.sort((left, right) => left.allocationIndex - right.allocationIndex).map((allocation) => ({
      allocationIndex: allocation.allocationIndex,
      amountMinor: allocation.amountMinor,
      snapshotFingerprint: evidence.fingerprint,
    })),
  }));
  if (portions.length === 0 || portions.reduce((sum, portion) => sum + portion.amountMinor, 0) !== payment.amount) {
    throw new OwnedPaymentLedgerError("LEGACY_PROVIDER_ITEMS_INVALID");
  }
  return { payment, portions };
}

export async function validateOwnedFundingAuthorizationInTransaction(
  tx: PaymentOperationTransaction,
  input: Omit<typeof weeklyPaymentFundings.$inferInsert, "id" | "createdAt" | "provenanceFingerprint"> & {
    authorizationItems?: ReadonlyArray<{ allocationIndex: number; amountMinor: number; snapshotFingerprint: string }>;
    now?: string;
  },
  options: { payment?: typeof payments.$inferSelect; allowRefunded?: boolean } = {},
): Promise<{
  payment: typeof payments.$inferSelect;
  adoptionId: string | null;
  authorizationOperationId: string | null;
  authorizationItems: Array<{ allocationIndex: number; amountMinor: number; snapshotFingerprint: string }>;
}> {

  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0 || input.currency !== "USD") throw new OwnedPaymentLedgerError("FUNDING_AMOUNT_INVALID");
  const adoptionId = input.adoptionId ?? null;
  const authorizationOperationId = input.authorizationOperationId ?? null;
  const [selectedPayment] = options.payment === undefined ? await tx.select().from(payments).where(and(
    eq(payments.id, input.paymentId),
    eq(payments.organizationId, input.organizationId),
    eq(payments.leagueId, input.leagueId),
  )).limit(1) : [options.payment];
  const payment = selectedPayment;
  const permittedStatus = payment?.status === "paid" || (options.allowRefunded === true && payment?.status === "refunded");
  if (!payment || !permittedStatus || payment.currency !== input.currency) throw new OwnedPaymentLedgerError("FUNDING_PAYMENT_INVALID");
  const [rotatingSource] = await tx.select({ id: rotatingCreditFundings.id }).from(rotatingCreditFundings).where(and(
    eq(rotatingCreditFundings.organizationId, input.organizationId),
    eq(rotatingCreditFundings.leagueId, input.leagueId),
    eq(rotatingCreditFundings.paymentId, input.paymentId),
  )).limit(1);
  if (rotatingSource) throw new OwnedPaymentLedgerError("ROTATING_TENDER_ALREADY_OWNED");
  const authorizationItems = [...(input.authorizationItems ?? [])].sort((left, right) => left.allocationIndex - right.allocationIndex);
  if (authorizationItems.some((item, index) => !Number.isSafeInteger(item.allocationIndex) || item.allocationIndex < 0
    || !Number.isSafeInteger(item.amountMinor) || item.amountMinor <= 0 || (index > 0 && authorizationItems[index - 1]?.allocationIndex === item.allocationIndex))) {
    throw new OwnedPaymentLedgerError("FUNDING_AUTH_ITEMS_INVALID");
  }
  if (input.source === "worksheet_manual" && (input.authorizationKind !== "manual_receipt"
    || authorizationOperationId !== null || (input.authorizationItemCount ?? 0) !== 0
    || authorizationItems.length !== 0 || !["cash", "check"].includes(payment.type)
    || payment.bowlerId !== input.creditedBowlerId || payment.amount !== input.amountMinor || input.portionIndex !== 0
    || payment.providerPaymentId !== null || payment.paymentOperationId !== null)) {
    throw new OwnedPaymentLedgerError("MANUAL_FUNDING_AUTH_INVALID");
  }
  if (input.source === "provider" && (input.authorizationKind !== "provider_snapshot"
    || authorizationOperationId === null
    || payment.paymentOperationId !== authorizationOperationId || (input.authorizationItemCount ?? 0) !== 0
    || authorizationItems.length !== 0 || payment.type === "cash" || payment.type === "check")) {
    throw new OwnedPaymentLedgerError("PROVIDER_FUNDING_AUTH_INVALID");
  }
  if (input.source === "legacy_adoption" && !adoptionId) throw new OwnedPaymentLedgerError("LEGACY_ADOPTION_REQUIRED");
  if (input.source !== "legacy_adoption" && adoptionId !== null) throw new OwnedPaymentLedgerError("UNEXPECTED_ADOPTION_ID");
  if (input.authorizationKind === "legacy_payment" && (input.source !== "legacy_adoption"
    || authorizationOperationId !== null || (input.authorizationItemCount ?? 0) !== 0
    || authorizationItems.length !== 0 || payment.paymentOperationId !== null || payment.providerPaymentId !== null
    || payment.bowlerId !== input.creditedBowlerId || payment.amount !== input.amountMinor
    || input.portionIndex !== 0 || !["cash", "check"].includes(payment.type))) {
    throw new OwnedPaymentLedgerError("LEGACY_PAYMENT_AUTH_INVALID");
  }
  if (input.authorizationKind === "legacy_provider_snapshot") {
    if (input.source !== "legacy_adoption" || !authorizationOperationId
      || (input.authorizationItemCount ?? 0) <= 0 || authorizationItems.length !== input.authorizationItemCount
      || payment.paymentOperationId !== authorizationOperationId || payment.type === "cash" || payment.type === "check"
      || authorizationItems.reduce((sum, item) => sum + item.amountMinor, 0) !== input.amountMinor) {
      throw new OwnedPaymentLedgerError("LEGACY_PROVIDER_ITEMS_INVALID");
    }
    const evidence = await readLegacyProviderSnapshotEvidenceInTransaction(tx, { organizationId: input.organizationId, leagueId: input.leagueId, payment });
    if (evidence.operationId !== authorizationOperationId || evidence.fingerprint !== input.authorizationFingerprint
      || !legacyProviderRecipientItemsMatchSnapshot({
        snapshotItems: evidence.items,
        snapshotAllocations: evidence.allocations,
        creditedBowlerId: input.creditedBowlerId,
        authorizationItemCount: input.authorizationItemCount ?? 0,
        authorizationItems,
        snapshotFingerprint: evidence.fingerprint,
      }) || authorizationItems.reduce((sum, item) => sum + item.amountMinor, 0) !== input.amountMinor) {
      throw new OwnedPaymentLedgerError("LEGACY_PROVIDER_ITEMS_INVALID");
    }
  }
  if (input.source === "legacy_adoption") {
    const legacyAdoptionId = adoptionId;
    if (legacyAdoptionId === null) throw new OwnedPaymentLedgerError("LEGACY_ADOPTION_REQUIRED");
    const [adoption] = await tx.select({ id: weeklyPaymentLedgerAdoptions.id }).from(weeklyPaymentLedgerAdoptions).where(and(
      eq(weeklyPaymentLedgerAdoptions.id, legacyAdoptionId),
      eq(weeklyPaymentLedgerAdoptions.organizationId, input.organizationId),
      eq(weeklyPaymentLedgerAdoptions.leagueId, input.leagueId),
    )).limit(1);
    if (!adoption) throw new OwnedPaymentLedgerError("LEGACY_ADOPTION_NOT_FOUND");
  }
  if (input.authorizationKind === "provider_snapshot") {
    if (input.source !== "provider") throw new OwnedPaymentLedgerError("PROVIDER_FUNDING_AUTH_INVALID");
    const authorizationOperationId = input.authorizationOperationId;
    if (!authorizationOperationId) throw new OwnedPaymentLedgerError("PROVIDER_FUNDING_AUTH_INVALID");
    const [operation] = await tx.select().from(paymentOperations).where(and(
      eq(paymentOperations.id, authorizationOperationId),
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.leagueId, input.leagueId),
    )).limit(1);
    const [stored] = await tx.select().from(accountPaymentOperationSnapshots).where(and(
      eq(accountPaymentOperationSnapshots.operationId, authorizationOperationId),
      eq(accountPaymentOperationSnapshots.organizationId, input.organizationId),
      eq(accountPaymentOperationSnapshots.leagueId, input.leagueId),
    )).limit(1);
    const portions = stored?.fundingPortions;
    const portionIndexes = portions?.map((portion) => portion.portionIndex) ?? [];
    const portionOwners = portions?.map((portion) => portion.creditedBowlerId) ?? [];
    if (!operation || operation.status !== "succeeded"
      || operation.providerObjectId === null || payment.providerPaymentId !== operation.providerObjectId
      || operation.amountMinor !== payment.amount || operation.currency !== payment.currency
      || !stored
      || stored.snapshotFingerprint !== input.authorizationFingerprint || stored.amountMinor !== payment.amount
      || stored.currency !== payment.currency
      || !Array.isArray(portions) || portions.length === 0
      || portions.some((portion, index) => !Number.isSafeInteger(portion.portionIndex) || portion.portionIndex !== index
        || !Number.isSafeInteger(portion.creditedBowlerId) || portion.creditedBowlerId <= 0
        || !Number.isSafeInteger(portion.amountMinor) || portion.amountMinor <= 0)
      || new Set(portionOwners).size !== portionOwners.length
      || portionIndexes.length !== portions.length
      || portions.reduce((sum, portion) => sum + portion.amountMinor, 0) !== payment.amount
      || !portions.some((portion) => portion.creditedBowlerId === input.creditedBowlerId
        && portion.portionIndex === input.portionIndex && portion.amountMinor === input.amountMinor)) {
      throw new OwnedPaymentLedgerError("PROVIDER_RECIPIENT_PROOF_INVALID");
    }
    if (stored.snapshotKind === "interactive_funding") {
      if (operation.operationType !== "interactive_charge" || stored.snapshotVersion !== 4
        || stored.payerBowlerId !== payment.bowlerId
        || !/^lvaccountfunding:v4:[0-9a-f]{64}$/.test(stored.snapshotFingerprint)) {
        throw new OwnedPaymentLedgerError("PROVIDER_RECIPIENT_PROOF_INVALID");
      }
    } else if (stored.snapshotKind === "standing_funding") {
      if (operation.operationType !== "standing_autopay_charge" || stored.snapshotVersion !== 5
        || stored.payerBowlerId !== payment.bowlerId
        || !/^lvstandingfunding:v1:[0-9a-f]{64}$/.test(stored.snapshotFingerprint)) {
        throw new OwnedPaymentLedgerError("PROVIDER_RECIPIENT_PROOF_INVALID");
      }
      let snapshot;
      try {
        snapshot = reconstructAccountStandingFundingSnapshot({ operation, stored });
      } catch {
        throw new OwnedPaymentLedgerError("PROVIDER_RECIPIENT_PROOF_INVALID");
      }
      const evidence = snapshot.standingEvidence;

      const [legacySnapshot, rosterItemRows, participantRows, rotatingSnapshot, consentRows, bindingRows, partnerRows] = await Promise.all([
        tx.select({ operationId: paymentOperationRosterSnapshots.operationId }).from(paymentOperationRosterSnapshots).where(and(
          eq(paymentOperationRosterSnapshots.operationId, authorizationOperationId),
          eq(paymentOperationRosterSnapshots.organizationId, input.organizationId),
          eq(paymentOperationRosterSnapshots.leagueId, input.leagueId),
        )).limit(1),
        tx.select({ id: paymentOperationRosterSnapshotItems.id }).from(paymentOperationRosterSnapshotItems).where(and(
          eq(paymentOperationRosterSnapshotItems.operationId, authorizationOperationId),
          eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId),
          eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId),
        )).limit(1),
        tx.select({ operationId: paymentOperationStandingAutopayParticipants.operationId }).from(paymentOperationStandingAutopayParticipants).where(and(
          eq(paymentOperationStandingAutopayParticipants.operationId, authorizationOperationId),
          eq(paymentOperationStandingAutopayParticipants.organizationId, input.organizationId),
          eq(paymentOperationStandingAutopayParticipants.leagueId, input.leagueId),
        )).limit(1),
        tx.select({ operationId: rotatingCreditPaymentOperationSnapshots.operationId }).from(rotatingCreditPaymentOperationSnapshots).where(and(
          eq(rotatingCreditPaymentOperationSnapshots.operationId, authorizationOperationId),
          eq(rotatingCreditPaymentOperationSnapshots.organizationId, input.organizationId),
          eq(rotatingCreditPaymentOperationSnapshots.leagueId, input.leagueId),
        )).limit(1),
        tx.select({
          id: autopayConsents.id,
          consentVersion: autopayConsents.consentVersion,
          payerBowlerId: autopayConsents.payerBowlerId,
          consentFingerprint: autopayConsents.consentFingerprint,
          providerName: autopayConsents.providerName,
          providerLocationId: autopayConsents.providerLocationId,
          encryptedSourceId: autopayConsents.encryptedSourceId,
          encryptedCustomerId: autopayConsents.encryptedCustomerId,
        }).from(autopayConsents).where(and(
          eq(autopayConsents.id, evidence.consentId),
          eq(autopayConsents.organizationId, input.organizationId),
          eq(autopayConsents.leagueId, input.leagueId),
        )).limit(1),
        tx.select().from(paymentOperationStandingAutopayBindings).where(and(
          eq(paymentOperationStandingAutopayBindings.operationId, authorizationOperationId),
          eq(paymentOperationStandingAutopayBindings.organizationId, input.organizationId),
          eq(paymentOperationStandingAutopayBindings.leagueId, input.leagueId),
        )).limit(1),
        tx.select({ partnerBowlerId: autopayConsentPartners.partnerBowlerId, paymentLinkId: autopayConsentPartners.paymentLinkId, linkFingerprint: autopayConsentPartners.linkFingerprint })
          .from(autopayConsentPartners).where(and(
            eq(autopayConsentPartners.consentId, evidence.consentId),
            eq(autopayConsentPartners.consentVersion, evidence.consentVersion),
            eq(autopayConsentPartners.organizationId, input.organizationId),
            eq(autopayConsentPartners.leagueId, input.leagueId),
          )),
      ]);
      const [consent] = consentRows;
      const [binding] = bindingRows;
      const partnersByBowler = new Map(partnerRows.map((row) => [row.partnerBowlerId, row]));
      const partnerEvidence = snapshot.recipientEvidence.filter((row) => row.role === "partner");
      const selfEvidence = snapshot.recipientEvidence.filter((row) => row.role === "self");
      const partnerEvidenceMatches = partnerEvidence.length === partnerRows.length
        && partnerEvidence.every((row) => {
          const accepted = partnersByBowler.get(row.recipientBowlerId);
          return accepted !== undefined && row.paymentLinkId === accepted.paymentLinkId
            && row.linkFingerprint === accepted.linkFingerprint;
        });
      const groupEvidenceMatches = Boolean(binding)
        && binding?.consentId === evidence.consentId
        && binding?.consentVersion === evidence.consentVersion
        && binding?.providerName === snapshot.providerName
        && binding?.providerLocationId === snapshot.providerLocationId
        && binding?.triggerOccurrenceId === evidence.triggerOccurrenceId
        && binding?.pairedOccurrenceId === evidence.pairedOccurrenceId
        && binding?.collectionGroupId === evidence.collectionGroupId
        && binding?.collectionGroupRevision === evidence.collectionGroupRevision
        && binding?.collectionGroupFingerprint === evidence.collectionGroupFingerprint
        && binding?.triggerMemberId === evidence.triggerMemberId
        && binding?.pairedMemberId === evidence.pairedMemberId
        && binding?.collectionMode === evidence.collectionMode
        && Date.parse(binding?.cutoffAt ?? "") === Date.parse(evidence.cutoffAt)
        && binding?.evidenceFingerprint === evidence.bindingEvidenceFingerprint;
      if (legacySnapshot.length > 0 || rosterItemRows.length > 0 || participantRows.length > 0 || rotatingSnapshot.length > 0
        || !consent || consent.id !== evidence.consentId || consent.consentVersion !== evidence.consentVersion
        || consent.payerBowlerId !== snapshot.payerBowlerId || consent.consentFingerprint !== evidence.consentFingerprint
        || consent.providerName !== snapshot.providerName || consent.providerLocationId !== snapshot.providerLocationId
        || !consent.encryptedSourceId?.trim() || !consent.encryptedCustomerId?.trim()
        || !groupEvidenceMatches || !partnerEvidenceMatches || selfEvidence.length !== 1
        || snapshot.recipientEvidence.length !== partnerRows.length + 1
        || operation.triggerOccurrenceId !== evidence.triggerOccurrenceId) {
        throw new OwnedPaymentLedgerError("PROVIDER_RECIPIENT_PROOF_INVALID");
      }
    } else {
      throw new OwnedPaymentLedgerError("PROVIDER_RECIPIENT_PROOF_INVALID");
    }
  }
  return { payment, adoptionId, authorizationOperationId, authorizationItems };
}

export async function validateOwnedFundingPortionsForTenderInTransaction(
  tx: PaymentOperationTransaction,
  input: {
    payment: typeof payments.$inferSelect;
    fundings: readonly typeof weeklyPaymentFundings.$inferSelect[];
    allowRefunded?: boolean;
  },
): Promise<void> {
  const { payment } = input;
  const fundings = [...input.fundings].sort((left, right) => left.portionIndex - right.portionIndex);
  if (fundings.length === 0
    || (payment.status !== "paid" && !(input.allowRefunded === true && payment.status === "refunded"))
    || payment.currency !== "USD"
    || !Number.isSafeInteger(payment.amount) || payment.amount <= 0
    || fundings.reduce((sum, funding) => sum + funding.amountMinor, 0) !== payment.amount
    || new Set(fundings.map((funding) => funding.creditedBowlerId)).size !== fundings.length
    || fundings.some((funding, index) => funding.paymentId !== payment.id
      || funding.organizationId !== payment.organizationId
      || funding.leagueId !== payment.leagueId
      || funding.currency !== payment.currency
      || funding.portionIndex !== index
      || funding.amountMinor <= 0
      || funding.source !== fundings[0]?.source
      || funding.authorizationKind !== fundings[0]?.authorizationKind
      || funding.authorizationOperationId !== fundings[0]?.authorizationOperationId
      || funding.authorizationFingerprint !== fundings[0]?.authorizationFingerprint
      || funding.adoptionId !== fundings[0]?.adoptionId)) {
    throw new OwnedPaymentLedgerError("FUNDING_TENDER_PORTIONS_INVALID");
  }
  const fundingIds = fundings.map((funding) => funding.id);
  const authorizationRows = await tx.select({
    fundingId: weeklyPaymentFundingAuthorizationItems.fundingId,
    allocationIndex: weeklyPaymentFundingAuthorizationItems.sourceAllocationIndex,
    amountMinor: weeklyPaymentFundingAuthorizationItems.authorizedAmountMinor,
    snapshotFingerprint: weeklyPaymentFundingAuthorizationItems.sourceSnapshotFingerprint,
  }).from(weeklyPaymentFundingAuthorizationItems).where(and(
    eq(weeklyPaymentFundingAuthorizationItems.organizationId, payment.organizationId),
    eq(weeklyPaymentFundingAuthorizationItems.leagueId, payment.leagueId),
    inArray(weeklyPaymentFundingAuthorizationItems.fundingId, fundingIds),
  )).orderBy(asc(weeklyPaymentFundingAuthorizationItems.fundingId), asc(weeklyPaymentFundingAuthorizationItems.sourceAllocationIndex));
  const itemsByFunding = new Map<string, typeof authorizationRows>();
  for (const row of authorizationRows) itemsByFunding.set(row.fundingId, [...(itemsByFunding.get(row.fundingId) ?? []), row]);
  for (const funding of fundings) {
    const authorizationItems = (itemsByFunding.get(funding.id) ?? []).map((row) => ({
      allocationIndex: row.allocationIndex,
      amountMinor: row.amountMinor,
      snapshotFingerprint: row.snapshotFingerprint,
    }));
    await validateOwnedFundingAuthorizationInTransaction(tx, {
      organizationId: funding.organizationId,
      leagueId: funding.leagueId,
      paymentId: funding.paymentId,
      creditedBowlerId: funding.creditedBowlerId,
      portionIndex: funding.portionIndex,
      amountMinor: funding.amountMinor,
      currency: funding.currency,
      source: funding.source,
      authorizationKind: funding.authorizationKind,
      authorizationOperationId: funding.authorizationOperationId,
      authorizationItemCount: funding.authorizationItemCount,
      authorizationFingerprint: funding.authorizationFingerprint,
      adoptionId: funding.adoptionId,
      recordedByUserId: funding.recordedByUserId,
      authorizationItems,
    }, { payment, allowRefunded: input.allowRefunded });
  }
}

/** Validate one exact completed owned-account V3 full-tender refund using
 * immutable source and adjustment evidence. This read helper takes no locks
 * and deliberately does not call any balance reader. */
export async function readCompletedOwnedPaymentRefundEvidenceInTransaction(
  tx: PaymentOperationTransaction,
  input: ReadCompletedOwnedPaymentRefundEvidenceInput,
): Promise<CompletedOwnedPaymentRefundEvidence | null> {
  const [payment] = await tx.select().from(payments).where(and(
    eq(payments.id, input.paymentId),
    eq(payments.organizationId, input.organizationId),
    eq(payments.leagueId, input.leagueId),
  )).limit(1);
  if (!payment) return null;

  const refundRows = await tx.select({ snapshot: refundPaymentOperationSnapshots, operation: paymentOperations })
    .from(refundPaymentOperationSnapshots)
    .innerJoin(paymentOperations, and(
      eq(paymentOperations.id, refundPaymentOperationSnapshots.operationId),
      eq(paymentOperations.organizationId, input.organizationId),
    )).where(and(
      eq(refundPaymentOperationSnapshots.paymentId, input.paymentId),
      eq(refundPaymentOperationSnapshots.leagueId, input.leagueId),
    ));
  if (refundRows.length > 1) throw new OwnedPaymentRefundEvidenceError();
  const [refundRow] = refundRows;

  if (!refundRow) {
    if (payment.status === "refunded" || payment.squareRefundId !== null) throw new OwnedPaymentRefundEvidenceError();
    return null;
  }
  const { snapshot: stored, operation } = refundRow;
  if (operation.status !== "succeeded") {
    if (payment.status === "refunded" || payment.squareRefundId !== null) throw new OwnedPaymentRefundEvidenceError();
    return null;
  }
  if (stored.snapshotVersion !== REFUND_PAYMENT_SNAPSHOT_ACCOUNT_FUNDING_VERSION
    || operation.operationType !== "refund"
    || operation.targetKey !== `payment-refund:${input.paymentId}`
    || (operation.leagueId !== null && operation.leagueId !== input.leagueId)
    || operation.amountMinor !== input.amountMinor
    || operation.amountMinor !== payment.amount
    || operation.currency !== "USD"
    || operation.providerName !== "square"
    || operation.providerObjectId === null
    || operation.completedAt === null
    || operation.providerObjectId !== payment.squareRefundId
    || payment.status !== "refunded"
    || payment.paymentOperationId !== input.chargeOperationId
    || payment.providerPaymentId !== input.providerPaymentId
    || payment.providerPaymentId === null
    || payment.type === "cash" || payment.type === "check") {
    throw new OwnedPaymentRefundEvidenceError();
  }

  let snapshot;
  try {
    snapshot = reconstructRefundPaymentSnapshot({
      organizationId: input.organizationId,
      amountMinor: operation.amountMinor,
      currency: operation.currency,
      providerName: operation.providerName,
      stored,
    });
  } catch {
    throw new OwnedPaymentRefundEvidenceError();
  }
  if (snapshot.snapshotVersion !== REFUND_PAYMENT_SNAPSHOT_ACCOUNT_FUNDING_VERSION
    || snapshot.organizationId !== input.organizationId
    || snapshot.leagueId !== input.leagueId
    || snapshot.paymentId !== input.paymentId
    || snapshot.amountMinor !== input.amountMinor
    || snapshot.currency !== "USD"
    || snapshot.providerName !== "square"
    || snapshot.providerPaymentId !== input.providerPaymentId
    || snapshot.providerPaymentId !== payment.providerPaymentId
    || !snapshot.disposition) {
    throw new OwnedPaymentRefundEvidenceError();
  }

  const [fundings, allocations] = await Promise.all([
    tx.select().from(weeklyPaymentFundings).where(and(
      eq(weeklyPaymentFundings.organizationId, input.organizationId),
      eq(weeklyPaymentFundings.leagueId, input.leagueId),
      eq(weeklyPaymentFundings.paymentId, input.paymentId),
    )).orderBy(asc(weeklyPaymentFundings.portionIndex), asc(weeklyPaymentFundings.id)),
    tx.select().from(paymentAllocations).where(and(
      eq(paymentAllocations.organizationId, input.organizationId),
      eq(paymentAllocations.leagueId, input.leagueId),
      eq(paymentAllocations.paymentId, input.paymentId),
    )).orderBy(asc(paymentAllocations.id)),
  ]);
  const fundingSnapshotById = new Map(snapshot.fundingSnapshot.map((row) => [row.fundingId, row]));
  if (fundings.length === 0
    || fundings.length !== snapshot.fundingSnapshot.length
    || fundings.reduce((sum, row) => sum + row.amountMinor, 0) !== input.amountMinor
    || new Set(fundings.map((row) => row.creditedBowlerId)).size !== fundings.length
    || fundings.some((row, index) => {
      const proof = snapshot.fundingSnapshot[index];
      return !proof
        || fundingSnapshotById.get(row.id) !== proof
        || row.portionIndex !== index
        || row.paymentId !== input.paymentId
        || row.creditedBowlerId !== proof.creditedBowlerId
        || row.amountMinor !== proof.fundingAmountMinor
        || row.currency !== proof.currency;
    })) {
    throw new OwnedPaymentRefundEvidenceError();
  }
  try {
    await validateOwnedFundingPortionsForTenderInTransaction(tx, { payment, fundings, allowRefunded: true });
  } catch (error) {
    if (error instanceof OwnedPaymentLedgerError) throw new OwnedPaymentRefundEvidenceError();
    throw error;
  }

  const allAllocationIds = allocations.map((allocation) => allocation.id);
  const [applications, releases, corrections, adjustments] = await Promise.all([
    allAllocationIds.length === 0 ? Promise.resolve([]) : tx.select().from(paymentAllocationFundingApplications).where(and(
      eq(paymentAllocationFundingApplications.organizationId, input.organizationId),
      eq(paymentAllocationFundingApplications.leagueId, input.leagueId),
      inArray(paymentAllocationFundingApplications.allocationId, allAllocationIds),
    )).orderBy(asc(paymentAllocationFundingApplications.createdAt), asc(paymentAllocationFundingApplications.id)),
    allAllocationIds.length === 0 ? Promise.resolve([]) : tx.select().from(weeklyPaymentAllocationReleases).where(and(
      eq(weeklyPaymentAllocationReleases.organizationId, input.organizationId),
      eq(weeklyPaymentAllocationReleases.leagueId, input.leagueId),
      inArray(weeklyPaymentAllocationReleases.sourceAllocationId, allAllocationIds),
    )),
    tx.select().from(paymentAllocationCorrections).where(and(
      eq(paymentAllocationCorrections.organizationId, input.organizationId),
      eq(paymentAllocationCorrections.leagueId, input.leagueId),
      eq(paymentAllocationCorrections.paymentId, input.paymentId),
    )),
    tx.select().from(refundAllocationAdjustments).where(and(
      eq(refundAllocationAdjustments.organizationId, input.organizationId),
      eq(refundAllocationAdjustments.leagueId, input.leagueId),
      eq(refundAllocationAdjustments.refundOperationId, operation.id),
    )),
  ]);

  const allocationById = new Map(allocations.map((row) => [row.id, row]));
  const fundingById = new Map(fundings.map((row) => [row.id, row]));
  const applicationsByAllocation = new Map<string, typeof applications>();
  for (const application of applications) applicationsByAllocation.set(application.allocationId, [
    ...(applicationsByAllocation.get(application.allocationId) ?? []), application,
  ]);
  const releasesByAllocation = new Map<string, typeof releases>();
  for (const release of releases) releasesByAllocation.set(release.sourceAllocationId, [
    ...(releasesByAllocation.get(release.sourceAllocationId) ?? []), release,
  ]);
  const validCorrectionSourceIds = new Set(corrections.filter((correction) => {
    const source = allocationById.get(correction.sourceAllocationId);
    const replacement = allocationById.get(correction.replacementAllocationId);
    return source?.state === "voided"
      && source.paymentId === input.paymentId
      && source.obligationId === correction.sourceObligationId
      && source.amountMinor === correction.amountMinor
      && source.currency === correction.currency
      && replacement?.paymentId === input.paymentId
      && replacement.obligationId === correction.targetObligationId
      && replacement.amountMinor === correction.amountMinor
      && replacement.currency === correction.currency;
  }).map((correction) => correction.sourceAllocationId));
  const validReleaseSourceIds = new Set<string>();
  for (const release of releases) {
    const application = applications.find((row) => row.id === release.fundingApplicationId);
    const allocation = allocationById.get(release.sourceAllocationId);
    if (application?.allocationId === release.sourceAllocationId
      && application.paymentId === release.paymentId
      && application.creditedBowlerId === release.creditedBowlerId
      && application.obligationId === release.sourceObligationId
      && application.amountMinor === release.sourceApplicationAmountMinor
      && allocation?.paymentId === release.paymentId
      && allocation.state === "voided"
      && release.retainedAmountMinor === 0
      && release.releasedAmountMinor === release.sourceApplicationAmountMinor
      && release.replacementAllocationId === null) {
      validReleaseSourceIds.add(release.sourceAllocationId);
    }
  }

  const allocationSnapshotById = new Map(snapshot.allocations.map((row) => [row.allocationId, row]));
  if (allocationSnapshotById.size !== snapshot.allocations.length || allocations.some((allocation) => {
    const expected = allocationSnapshotById.get(allocation.id);
    if (!expected) {
      return allocation.state !== "voided"
        || (!validCorrectionSourceIds.has(allocation.id) && !validReleaseSourceIds.has(allocation.id));
    }
    const linked = applicationsByAllocation.get(allocation.id) ?? [];
    const application = linked[0];
    const funding = application?.genericFundingId ? fundingById.get(application.genericFundingId) : undefined;
    const allocationReleases = releasesByAllocation.get(allocation.id) ?? [];
    return allocation.paymentId !== input.paymentId
      || allocation.obligationId !== expected.obligationId
      || allocation.amountMinor !== expected.amountMinor
      || allocation.currency !== expected.currency
      || allocation.reviewRequired
      || (allocation.state !== "active" && allocation.state !== "voided")
      || linked.length !== 1
      || !application
      || !funding
      || application.genericFundingId === null
      || application.rotatingFundingId !== null
      || application.paymentId !== input.paymentId
      || application.creditedBowlerId !== funding.creditedBowlerId
      || application.sourceAmountMinor !== funding.amountMinor
      || application.amountMinor !== allocation.amountMinor
      || application.obligationId !== allocation.obligationId
      || application.currency !== allocation.currency
      || (allocation.state === "active" && allocationReleases.length !== 0)
      || (allocation.state === "voided" && (allocationReleases.length !== 1 || !validReleaseSourceIds.has(allocation.id)));
  })) {
    throw new OwnedPaymentRefundEvidenceError();
  }
  if (snapshot.allocations.some((expected) => !allocationById.has(expected.allocationId))) {
    throw new OwnedPaymentRefundEvidenceError();
  }

  const allocatedMinorByFundingId = new Map(snapshot.fundingSnapshot.map((funding) => [funding.fundingId, 0]));
  for (const expected of snapshot.allocations) {
    const allocation = allocationById.get(expected.allocationId);
    const linkedApplications = applicationsByAllocation.get(expected.allocationId) ?? [];
    const [application] = linkedApplications;
    if (!allocation || linkedApplications.length !== 1 || !application
      || application.genericFundingId === null || application.rotatingFundingId !== null) {
      throw new OwnedPaymentRefundEvidenceError();
    }
    const funding = fundingById.get(application.genericFundingId);
    const expectedFunding = fundingSnapshotById.get(application.genericFundingId);
    if (!funding || !expectedFunding
      || application.creditedBowlerId !== expectedFunding.creditedBowlerId
      || application.sourceAmountMinor !== expectedFunding.fundingAmountMinor
      || application.amountMinor !== allocation.amountMinor
      || allocation.amountMinor !== expected.amountMinor) {
      throw new OwnedPaymentRefundEvidenceError();
    }
    allocatedMinorByFundingId.set(funding.id, (allocatedMinorByFundingId.get(funding.id) ?? 0) + application.amountMinor);
  }
  if (snapshot.fundingSnapshot.some((funding) =>
    funding.unusedCreditMinor + (allocatedMinorByFundingId.get(funding.fundingId) ?? 0) !== funding.fundingAmountMinor
  )) {
    throw new OwnedPaymentRefundEvidenceError();
  }

  const adjustmentByAllocation = new Map(adjustments.map((row) => [row.sourceAllocationId, row]));
  if (adjustments.length !== snapshot.allocations.length || snapshot.allocations.some((expected) => {
    const adjustment = adjustmentByAllocation.get(expected.allocationId);
    return !adjustment
      || adjustment.refundOperationId !== operation.id
      || adjustment.amountMinor !== expected.amountMinor
      || adjustment.disposition !== snapshot.disposition
      || adjustment.snapshotFingerprint !== stored.snapshotFingerprint;
  })) {
    throw new OwnedPaymentRefundEvidenceError();
  }

  return {
    refundOperationId: operation.id,
    providerRefundId: operation.providerObjectId,
    snapshotFingerprint: stored.snapshotFingerprint,
    disposition: snapshot.disposition,
  };
}

export async function recordOwnedFundingInTransaction(
  tx: PaymentOperationTransaction,
  input: Omit<typeof weeklyPaymentFundings.$inferInsert, "id" | "createdAt" | "provenanceFingerprint"> & {
    authorizationItems?: ReadonlyArray<{ allocationIndex: number; amountMinor: number; snapshotFingerprint: string }>;
    now?: string;
  },
): Promise<WeeklyPaymentFunding> {
  const [lockedPayment] = await tx.select().from(payments).where(and(
    eq(payments.id, input.paymentId),
    eq(payments.organizationId, input.organizationId),
    eq(payments.leagueId, input.leagueId),
  )).limit(1).for("update");
  const { payment, adoptionId, authorizationOperationId, authorizationItems } = await validateOwnedFundingAuthorizationInTransaction(
    tx,
    input,
    { payment: lockedPayment },
  );
  const { authorizationItems: _items, now, ...fundingInput } = input;
  const provenanceFingerprint = `lvweeklyfund:v1:${createHash("sha256").update(canonicalizePaymentOperationInput({
    ...fundingInput,
    adoptionId,
    authorizationOperationId,
    authorizationItems,
  })).digest("hex")}`;
  const [existingFunding] = await tx.select().from(weeklyPaymentFundings).where(and(
    eq(weeklyPaymentFundings.organizationId, input.organizationId),
    eq(weeklyPaymentFundings.leagueId, input.leagueId),
    eq(weeklyPaymentFundings.paymentId, input.paymentId),
    eq(weeklyPaymentFundings.creditedBowlerId, input.creditedBowlerId),
  )).limit(1).for("update");
  if (existingFunding) {
    if (existingFunding.provenanceFingerprint !== provenanceFingerprint) throw new OwnedPaymentLedgerError("FUNDING_IDEMPOTENCY_CONFLICT");
    const existingItems = await tx.select().from(weeklyPaymentFundingAuthorizationItems).where(and(
      eq(weeklyPaymentFundingAuthorizationItems.organizationId, input.organizationId),
      eq(weeklyPaymentFundingAuthorizationItems.leagueId, input.leagueId),
      eq(weeklyPaymentFundingAuthorizationItems.fundingId, existingFunding.id),
    )).orderBy(asc(weeklyPaymentFundingAuthorizationItems.sourceAllocationIndex));
    const expectedItems = authorizationItems.map((item) => ({
      allocationIndex: item.allocationIndex,
      amountMinor: item.amountMinor,
      fingerprint: item.snapshotFingerprint,
    }));
    const foundItems = existingItems.map((item) => ({
      allocationIndex: item.sourceAllocationIndex,
      amountMinor: item.authorizedAmountMinor,
      fingerprint: item.sourceSnapshotFingerprint,
    }));
    if (JSON.stringify(foundItems) !== JSON.stringify(expectedItems)) throw new OwnedPaymentLedgerError("FUNDING_IDEMPOTENCY_CONFLICT");
    return existingFunding;
  }
  const [funding] = await tx.insert(weeklyPaymentFundings).values({
    ...fundingInput,
    provenanceFingerprint,
    createdAt: now ?? new Date().toISOString(),
  }).returning();
  if (!funding) throw new OwnedPaymentLedgerError("FUNDING_CREATE_FAILED");
  if (authorizationItems.length > 0) {
    const sourceOperationId = authorizationOperationId;
    if (!sourceOperationId) throw new OwnedPaymentLedgerError("FUNDING_AUTH_OPERATION_REQUIRED");
    await tx.insert(weeklyPaymentFundingAuthorizationItems).values(authorizationItems.map((item) => ({
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      fundingId: funding.id,
      paymentId: input.paymentId,
      creditedBowlerId: input.creditedBowlerId,
      sourceOperationId,
      sourceAllocationIndex: item.allocationIndex,
      authorizedAmountMinor: item.amountMinor,
      sourceSnapshotFingerprint: item.snapshotFingerprint,
    })));
  }
  return funding;
}

export async function applyOwnedFundingFifoInTransaction(
  tx: PaymentOperationTransaction,
  input: OwnedLedgerScope & { bowlerId: number; actorUserId: number; now?: string },
): Promise<string[]> {
  const adoption = await readOwnedLedgerAdoptionInTransaction(tx, input);
  if (!adoption) throw new OwnedPaymentLedgerError("LEDGER_NOT_ADOPTED");
  const now = input.now ?? new Date().toISOString();
  const [debts, genericLots, rotatingLots] = await Promise.all([
    readConfirmedOwnedObligationsInTransaction(tx, {
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      bowlerIds: [input.bowlerId],
    }),
    readGenericFundingAvailabilityInTransaction(tx, {
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      bowlerIds: [input.bowlerId],
    }),
    readRotatingCreditFundingBalancesInTransaction(tx, {
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      bowlerId: input.bowlerId,
    }),
  ]);
  const lots: OwnedPaymentFundingLot[] = [
    ...genericLots,
    ...rotatingLots.filter((lot) => !lot.reviewRequired).map((lot) => ({
      sourceKind: "rotating" as const,
      fundingId: lot.fundingId,
      paymentId: lot.paymentId,
      bowlerId: lot.bowlerId,
      amountMinor: lot.amountMinor,
      receivedMinor: lot.receivedMinor,
      receiptEvidenceInvalid: lot.receiptEvidenceInvalid,
      availableMinor: lot.availableMinor,
      reviewRequired: false,
      createdAt: lot.createdAt,
    })),
  ];
  const applicationPlan = planOwnedFundingFifo(input.bowlerId, debts, lots);
  const createdIds: string[] = [];
  const appliedByObligation = new Map<string, number>();
  for (const { lot, obligation: debt, amountMinor } of applicationPlan) {
    const allocationKind = lot.sourceKind === "rotating" ? "rotating_credit" as const : "ordinary" as const;
    const [allocation] = await tx.insert(paymentAllocations).values({
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      paymentId: lot.paymentId,
      obligationId: debt.obligationId,
      amountMinor,
      currency: "USD",
      state: "active",
      allocationKind,
      recordedByUserId: input.actorUserId,
      createdAt: now,
    }).returning({ id: paymentAllocations.id });
    if (!allocation) throw new OwnedPaymentLedgerError("ALLOCATION_CREATE_FAILED");
    const [application] = await tx.insert(paymentAllocationFundingApplications).values({
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      allocationId: allocation.id,
      paymentId: lot.paymentId,
      creditedBowlerId: lot.bowlerId,
      genericFundingId: lot.sourceKind === "generic" ? lot.fundingId : null,
      rotatingFundingId: lot.sourceKind === "rotating" ? lot.fundingId : null,
      sourceAmountMinor: lot.amountMinor,
      amountMinor,
      currency: "USD",
      obligationId: debt.obligationId,
      responsibilityId: debt.responsibilityId,
      occurrenceId: debt.occurrenceId,
      teamId: debt.teamId,
      targetKind: debt.targetKind,
      targetPayerBowlerId: debt.targetKind === "bowler_responsibility" ? debt.payerBowlerId : null,
      assignmentId: debt.targetKind === "legacy_team_assignment" ? debt.assignmentId : null,
      appliedByUserId: input.actorUserId,
      createdAt: now,
    }).returning({ id: paymentAllocationFundingApplications.id });
    if (!application) throw new OwnedPaymentLedgerError("FUNDING_APPLICATION_CREATE_FAILED");
    createdIds.push(application.id);
    appliedByObligation.set(debt.obligationId, (appliedByObligation.get(debt.obligationId) ?? 0) + amountMinor);
  }

  for (const debt of debts) {
    const appliedMinor = appliedByObligation.get(debt.obligationId) ?? 0;
    if (appliedMinor === 0) continue;
    const remainingMinor = Math.max(0, debt.outstandingMinor - appliedMinor);
    await tx.update(paymentObligations).set({ state: remainingMinor === 0 ? "settled" : "partially_settled" }).where(and(
      eq(paymentObligations.organizationId, input.organizationId),
      eq(paymentObligations.leagueId, input.leagueId),
      eq(paymentObligations.id, debt.obligationId),
      ne(paymentObligations.state, "voided"),
    ));
  }
  return createdIds;
}

export interface ReleaseOwnedFundingApplicationResult {
  releaseId: string;
  sourceApplicationId: string;
  sourceAllocationId: string;
  replacementAllocationId: string | null;
  releasedAmountMinor: number;
  retainedAmountMinor: number;
  replayed: boolean;
}

export async function releaseOwnedFundingApplicationInTransaction(
  tx: PaymentOperationTransaction,
  input: OwnedLedgerScope & {
    applicationId: string;
    actorUserId: number;
    reason: "worksheet_correction" | "ledger_adoption";
    idempotencyKey: string;
    now?: string;
  },
): Promise<ReleaseOwnedFundingApplicationResult> {
  const [existingRelease] = await tx.select().from(weeklyPaymentAllocationReleases).where(and(
    eq(weeklyPaymentAllocationReleases.organizationId, input.organizationId),
    eq(weeklyPaymentAllocationReleases.leagueId, input.leagueId),
    eq(weeklyPaymentAllocationReleases.idempotencyKey, input.idempotencyKey),
  )).limit(1).for("update");
  if (existingRelease) {
    if (existingRelease.fundingApplicationId !== input.applicationId || existingRelease.reason !== input.reason
      || existingRelease.recordedByUserId !== input.actorUserId
      || existingRelease.retainedAmountMinor !== 0 || existingRelease.replacementAllocationId !== null) {
      throw new OwnedPaymentLedgerError("RELEASE_IDEMPOTENCY_CONFLICT");
    }
    return {
      releaseId: existingRelease.id,
      sourceApplicationId: existingRelease.fundingApplicationId,
      sourceAllocationId: existingRelease.sourceAllocationId,
      replacementAllocationId: existingRelease.replacementAllocationId,
      releasedAmountMinor: existingRelease.releasedAmountMinor,
      retainedAmountMinor: existingRelease.retainedAmountMinor,
      replayed: true,
    };
  }
  const [row] = await tx.select({
    application: paymentAllocationFundingApplications,
    allocation: paymentAllocations,
    obligation: paymentObligations,
    responsibility: occurrencePaymentResponsibilities,
  }).from(paymentAllocationFundingApplications)
    .innerJoin(paymentAllocations, and(
      eq(paymentAllocations.id, paymentAllocationFundingApplications.allocationId),
      eq(paymentAllocations.organizationId, input.organizationId),
      eq(paymentAllocations.leagueId, input.leagueId),
    ))
    .innerJoin(paymentObligations, and(
      eq(paymentObligations.id, paymentAllocationFundingApplications.obligationId),
      eq(paymentObligations.organizationId, input.organizationId),
      eq(paymentObligations.leagueId, input.leagueId),
    ))
    .innerJoin(occurrencePaymentResponsibilities, and(
      eq(occurrencePaymentResponsibilities.id, paymentAllocationFundingApplications.responsibilityId),
      eq(occurrencePaymentResponsibilities.organizationId, input.organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
    )).where(and(
      eq(paymentAllocationFundingApplications.id, input.applicationId),
      eq(paymentAllocationFundingApplications.organizationId, input.organizationId),
      eq(paymentAllocationFundingApplications.leagueId, input.leagueId),
    )).limit(1).for("update", { of: [paymentAllocationFundingApplications, paymentAllocations] });
  if (!row) throw new OwnedPaymentLedgerError("FUNDING_APPLICATION_NOT_FOUND");
  if (row.allocation.state !== "active" || row.allocation.reviewRequired
    || row.application.amountMinor !== row.allocation.amountMinor
    || row.application.amountMinor > row.application.sourceAmountMinor) {
    throw new OwnedPaymentLedgerError("FUNDING_APPLICATION_NOT_RELEASABLE");
  }
  const [payment] = await tx.select().from(payments).where(and(
    eq(payments.id, row.application.paymentId),
    eq(payments.organizationId, input.organizationId),
    eq(payments.leagueId, input.leagueId),
  )).limit(1).for("share");
  if (!payment || payment.disputeId !== null || payment.disputedAt !== null) {
    throw new OwnedPaymentLedgerError("FUNDING_SOURCE_REQUIRES_REVIEW");
  }
  const sourceOperationId = payment.paymentOperationId;
  const [disputeRows, refundRows] = await Promise.all([
    sourceOperationId === null ? Promise.resolve([]) : tx.select({ state: paymentDisputes.state }).from(paymentDisputes).where(and(
      eq(paymentDisputes.organizationId, input.organizationId),
      eq(paymentDisputes.paymentOperationId, sourceOperationId),
    )),
    tx.select({
      status: paymentOperations.status,
      providerObjectId: paymentOperations.providerObjectId,
      errorClassification: paymentOperations.errorClassification,
      errorCode: paymentOperations.errorCode,
    }).from(refundPaymentOperationSnapshots)
      .innerJoin(paymentOperations, and(
      eq(paymentOperations.id, refundPaymentOperationSnapshots.operationId),
      eq(paymentOperations.organizationId, input.organizationId),
      )).where(and(
        eq(refundPaymentOperationSnapshots.paymentId, row.application.paymentId),
        eq(refundPaymentOperationSnapshots.leagueId, input.leagueId),
      )),
  ]);
  let completedOwnedRefund = false;
  for (const refund of refundRows) {
    if (refund.status === "succeeded") {
      const proof = await readCompletedOwnedPaymentRefundEvidenceInTransaction(tx, {
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        paymentId: row.application.paymentId,
        chargeOperationId: payment.paymentOperationId ?? "",
        providerPaymentId: payment.providerPaymentId ?? "",
        amountMinor: payment.amount,
      }).catch((error: unknown) => {
        if (error instanceof OwnedPaymentRefundEvidenceError) return null;
        throw error;
      });
      if (!proof) throw new OwnedPaymentLedgerError("FUNDING_SOURCE_REQUIRES_REVIEW");
      completedOwnedRefund = true;
    } else if (!isConfirmedNoRefundCreditOutcome(refund)) {
      throw new OwnedPaymentLedgerError("FUNDING_SOURCE_REQUIRES_REVIEW");
    }
  }
  if (payment.status === "refunded" && !completedOwnedRefund) {
    const proof = await readCompletedOwnedPaymentRefundEvidenceInTransaction(tx, {
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      paymentId: row.application.paymentId,
      chargeOperationId: payment.paymentOperationId ?? "",
      providerPaymentId: payment.providerPaymentId ?? "",
      amountMinor: payment.amount,
    }).catch((error: unknown) => {
      if (error instanceof OwnedPaymentRefundEvidenceError) return null;
      throw error;
    });
    if (!proof) throw new OwnedPaymentLedgerError("FUNDING_SOURCE_REQUIRES_REVIEW");
    completedOwnedRefund = true;
  }
  if (disputeRows.some((dispute) => REVIEW_DISPUTE_STATES.has(dispute.state))) {
    throw new OwnedPaymentLedgerError("FUNDING_SOURCE_REQUIRES_REVIEW");
  }
  if (row.application.rotatingFundingId !== null) {
    const rotatingRefundRows = await tx.select({
      refundOperationId: rotatingCreditRefunds.refundOperationId,
      status: paymentOperations.status,
      providerObjectId: paymentOperations.providerObjectId,
      errorClassification: paymentOperations.errorClassification,
      errorCode: paymentOperations.errorCode,
    }).from(rotatingCreditRefunds)
      .leftJoin(paymentOperations, and(
        eq(paymentOperations.id, rotatingCreditRefunds.refundOperationId),
        eq(paymentOperations.organizationId, input.organizationId),
        eq(paymentOperations.leagueId, input.leagueId),
      )).where(and(
        eq(rotatingCreditRefunds.organizationId, input.organizationId),
        eq(rotatingCreditRefunds.leagueId, input.leagueId),
        eq(rotatingCreditRefunds.fundingId, row.application.rotatingFundingId),
      ));
    if (rotatingRefundRows.some((refund) => refund.refundOperationId !== null
      && (refund.status === null || isRotatingCreditRefundUnresolvedForReversal({
        status: refund.status,
        providerObjectId: refund.providerObjectId,
        errorClassification: refund.errorClassification,
        errorCode: refund.errorCode,
      })))) {
      throw new OwnedPaymentLedgerError("FUNDING_SOURCE_REQUIRES_REVIEW");
    }
  }
  const retainedAmountMinor = 0;
  const releasedAmountMinor = row.application.amountMinor - retainedAmountMinor;
  const now = input.now ?? new Date().toISOString();
  const replacementAllocationId: string | null = null;
  await tx.update(paymentAllocations).set({ state: "voided" }).where(and(
    eq(paymentAllocations.id, row.allocation.id),
    eq(paymentAllocations.organizationId, input.organizationId),
    eq(paymentAllocations.leagueId, input.leagueId),
    eq(paymentAllocations.state, "active"),
  ));
  const [release] = await tx.insert(weeklyPaymentAllocationReleases).values({
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    fundingApplicationId: row.application.id,
    paymentId: row.application.paymentId,
    creditedBowlerId: row.application.creditedBowlerId,
    sourceAllocationId: row.application.allocationId,
    sourceObligationId: row.application.obligationId,
    sourceApplicationAmountMinor: row.application.amountMinor,
    replacementAllocationId,
    releasedAmountMinor,
    retainedAmountMinor,
    currency: row.application.currency,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
    recordedByUserId: input.actorUserId,
    transactionId: sql`pg_current_xact_id()::text`,
    createdAt: now,
  }).returning({ id: weeklyPaymentAllocationReleases.id });
  if (!release) throw new OwnedPaymentLedgerError("ALLOCATION_RELEASE_CREATE_FAILED");

  const remainingAllocations = await tx.select({ allocation: paymentAllocations }).from(paymentAllocations).where(and(
    eq(paymentAllocations.organizationId, input.organizationId),
    eq(paymentAllocations.leagueId, input.leagueId),
    eq(paymentAllocations.obligationId, row.application.obligationId),
    eq(paymentAllocations.state, "active"),
  ));
  const allocationIds = remainingAllocations.map(({ allocation }) => allocation.id);
  const adjustments = allocationIds.length === 0 ? [] : await tx.select().from(refundAllocationAdjustments).where(and(
    eq(refundAllocationAdjustments.organizationId, input.organizationId),
    eq(refundAllocationAdjustments.leagueId, input.leagueId),
    inArray(refundAllocationAdjustments.sourceAllocationId, allocationIds),
  ));
  const balance = canonicalObligationBalance({
    amountMinor: row.obligation.amountMinor,
    state: row.obligation.state,
    grossAllocatedMinor: remainingAllocations.reduce((sum, { allocation }) => sum + allocation.amountMinor, 0),
    adjustments: adjustments.map(({ amountMinor, disposition }) => ({ amountMinor, disposition })),
  });
  if (row.obligation.state !== "voided") {
    await tx.update(paymentObligations).set({ state: balance.outstandingMinor === 0 ? "settled" : balance.effectiveAllocatedMinor > 0 || balance.waivedMinor > 0 ? "partially_settled" : "open" }).where(and(
      eq(paymentObligations.id, row.obligation.id),
      eq(paymentObligations.organizationId, input.organizationId),
      eq(paymentObligations.leagueId, input.leagueId),
      ne(paymentObligations.state, "voided"),
    ));
  }
  return {
    releaseId: release.id,
    sourceApplicationId: row.application.id,
    sourceAllocationId: row.application.allocationId,
    replacementAllocationId,
    releasedAmountMinor,
    retainedAmountMinor,
    replayed: false,
  };
}
