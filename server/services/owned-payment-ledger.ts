import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { canonicalizePaymentOperationInput } from "./payment-operation-idempotency.js";
import {
  accountPaymentOperationSnapshots,
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
  weeklyPaymentLedgerAdoptionAllocationProofs,
  weeklyPaymentFundings,
  weeklyPaymentLedgerAdoptions,
  weeklyPaymentWeekConfirmations,
  type WeeklyPaymentFunding,
  type WeeklyPaymentLedgerAdoption,
} from "@shared/schema";
import type { PaymentOperationTransaction } from "../storage/payment-operations.js";
import { canonicalObligationBalance } from "./refund-allocation-adjustments.js";
import { reconstructInteractivePartnerSnapshot, type InteractivePartnerPaymentSnapshot } from "./interactive-partner-payment-snapshot.js";
import { reconstructRosterOperationSnapshot, type RosterOperationSemanticSnapshot } from "./roster-operation-snapshot.js";
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

export interface OwnedPaymentFundingLot {
  sourceKind: "generic" | "rotating";
  fundingId: string;
  paymentId: number;
  bowlerId: number;
  amountMinor: number;
  availableMinor: number;
  createdAt: string;
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
  const orderedDebts = [...debts].sort((left, right) => Date.parse(left.dueAt) - Date.parse(right.dueAt)
    || left.occurrenceLocalDate.localeCompare(right.occurrenceLocalDate)
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
    if (debt.debtorBowlerId !== bowlerId || debt.outstandingMinor <= 0) continue;
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
): Promise<OwnedPaymentFundingLot[]> {
  if (scope.bowlerIds.length === 0) return [];
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
        eq(paymentOperations.leagueId, scope.leagueId),
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
    const invalidPayment = payment.status !== "paid"
      || voidPaymentIds.has(payment.id)
      || payment.disputeId !== null
      || payment.disputedAt !== null
      || (payment.paymentOperationId === null
        ? payment.providerPaymentId !== null
        : operation?.status !== "succeeded" || operation.providerObjectId === null
          || payment.providerPaymentId !== operation.providerObjectId || disputeOperationIds.has(operation.id));
    const unresolvedRefund = (refundsByPayment.get(payment.id) ?? []).some(({ operation: refundOperation }) => REFUND_HOLD_STATUSES.includes(refundOperation.status as (typeof REFUND_HOLD_STATUSES)[number]));
    const completedOrAmbiguousRefund = (refundsByPayment.get(payment.id) ?? []).some(({ operation: refundOperation }) => refundOperation.status === "succeeded"
      || (refundOperation.status !== "failed_terminal" && !isConfirmedNoRefundCreditOutcome(refundOperation)));
    const paymentTypeValid = operation === null
      ? payment.type === "cash" || payment.type === "check"
      : payment.type !== "cash" && payment.type !== "check";
    const reviewRequired = invalidPayment || !paymentTypeValid || partitionInvalid || rotatingPaymentIds.has(payment.id)
      || untrackedAllocations || activeApplications.some(({ allocation }) => allocation.reviewRequired) || unresolvedRefund;
    const appliedMinor = activeApplications.reduce((sum, { allocation }) => sum + allocation.amountMinor, 0);
    const rawAvailable = funding.amountMinor - appliedMinor;
    if (rawAvailable < 0 || completedOrAmbiguousRefund && rawAvailable > 0) continue;
    const available = reviewRequired ? 0 : rawAvailable;
    result.push({
      sourceKind: "generic",
      fundingId: funding.id,
      paymentId: funding.paymentId,
      bowlerId: funding.creditedBowlerId,
      amountMinor: funding.amountMinor,
      availableMinor: available,
      createdAt: funding.createdAt,
    });
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
export async function recordOwnedFundingInTransaction(
  tx: PaymentOperationTransaction,
  input: Omit<typeof weeklyPaymentFundings.$inferInsert, "id" | "createdAt" | "provenanceFingerprint"> & {
    authorizationItems?: ReadonlyArray<{ allocationIndex: number; amountMinor: number; snapshotFingerprint: string }>;
    now?: string;
  },
): Promise<WeeklyPaymentFunding> {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0 || input.currency !== "USD") throw new OwnedPaymentLedgerError("FUNDING_AMOUNT_INVALID");
  const adoptionId = input.adoptionId ?? null;
  const authorizationOperationId = input.authorizationOperationId ?? null;
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
      || payment.paymentOperationId !== authorizationOperationId || (input.authorizationItemCount ?? 0) <= 0
      || authorizationItems.length !== input.authorizationItemCount || payment.type === "cash" || payment.type === "check"
      || authorizationItems.reduce((sum, item) => sum + item.amountMinor, 0) !== input.amountMinor) {
      throw new OwnedPaymentLedgerError("LEGACY_PROVIDER_ITEMS_INVALID");
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
    const [operationRow] = operationRows;
    const [snapshotRow] = snapshotRows;
    if (!operationRow || operationRow.status !== "succeeded" || operationRow.providerObjectId === null
      || payment.providerPaymentId !== operationRow.providerObjectId
      || !snapshotRow || !["interactive", "standing_autopay"].includes(snapshotRow.snapshotKind)
      || (snapshotRow.snapshotKind === "interactive" && operationRow.operationType !== "interactive_charge")
      || (snapshotRow.snapshotKind === "standing_autopay" && operationRow.operationType !== "standing_autopay_charge")
      || operationRow.amountMinor !== payment.amount || operationRow.currency !== payment.currency
      || snapshotRow.amountMinor !== payment.amount || snapshotRow.currency !== payment.currency
      || snapshotRow.snapshotFingerprint !== input.authorizationFingerprint) {
      throw new OwnedPaymentLedgerError("LEGACY_PROVIDER_SNAPSHOT_INVALID");
    }
    const authorizedItems = await tx.select({
      allocationIndex: paymentOperationRosterSnapshotItems.allocationIndex,
      obligationId: paymentOperationRosterSnapshotItems.obligationId,
      amountMinor: paymentOperationRosterSnapshotItems.amountMinor,
      state: paymentOperationRosterSnapshotItems.state,
    })
      .from(paymentOperationRosterSnapshotItems).where(and(
        eq(paymentOperationRosterSnapshotItems.operationId, authorizationOperationId),
        eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId),
        eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId),
      ));
    if (authorizedItems.some((item) => item.state !== "finalized")) {
      throw new OwnedPaymentLedgerError("LEGACY_PROVIDER_ITEMS_INVALID");
    }
    type SnapshotAllocation = { allocationIndex?: number; obligationId?: string; bowlerId?: number; payerBowlerId?: number; amountMinor?: number };
    const recordedSnapshotRows = Array.isArray(snapshotRow.obligations) ? snapshotRow.obligations as SnapshotAllocation[] : [];
    const ownerAllocations: Array<{ allocationIndex: number; obligationId: string; bowlerId: number; amountMinor: number }> = [];
    if (snapshotRow.snapshotKind === "interactive" && snapshotRow.snapshotVersion === 2
      && snapshotRow.requestKind !== null && snapshotRow.encryptedSourceId !== null && snapshotRow.payerBowlerId !== null
      && snapshotRow.sourceKind !== null && snapshotRow.quoteFingerprint !== null) {
      try {
        const snapshot = reconstructRosterOperationSnapshot({
          organizationId: input.organizationId,
          amountMinor: operationRow.amountMinor,
          currency: operationRow.currency,
          providerName: operationRow.providerName,
          providerIdempotencyKey: operationRow.providerIdempotencyKey,
          stored: {
            snapshotVersion: 2,
            snapshotFingerprint: snapshotRow.snapshotFingerprint,
            leagueId: snapshotRow.leagueId,
            locationId: snapshotRow.locationId,
            providerLocationId: snapshotRow.providerLocationId,
            payerBowlerId: snapshotRow.payerBowlerId,
            requestKind: snapshotRow.requestKind,
            encryptedSourceId: snapshotRow.encryptedSourceId,
            encryptedCustomerId: snapshotRow.encryptedCustomerId,
            encryptedBuyerEmail: snapshotRow.encryptedBuyerEmail,
            storeCard: snapshotRow.storeCard,
            sourceKind: snapshotRow.sourceKind,
            quoteFingerprint: snapshotRow.quoteFingerprint,
          },
          allocations: recordedSnapshotRows as RosterOperationSemanticSnapshot["allocations"],
          lineItems: snapshotRow.lineItems,
        });
        ownerAllocations.push(...snapshot.allocations.map((row) => ({ allocationIndex: row.allocationIndex, obligationId: row.obligationId, bowlerId: row.bowlerId, amountMinor: row.amountMinor })));
      } catch {
        throw new OwnedPaymentLedgerError("LEGACY_PROVIDER_SNAPSHOT_INVALID");
      }
    } else if (snapshotRow.snapshotKind === "interactive" && snapshotRow.snapshotVersion === 3
      && snapshotRow.requestKind !== null && snapshotRow.encryptedSourceId !== null && snapshotRow.payerBowlerId !== null
      && snapshotRow.sourceKind !== null && snapshotRow.quoteFingerprint !== null && snapshotRow.partnerEvidence !== null) {
      try {
        const snapshot = reconstructInteractivePartnerSnapshot({
          organizationId: input.organizationId,
          amountMinor: operationRow.amountMinor,
          currency: operationRow.currency,
          providerName: operationRow.providerName,
          providerIdempotencyKey: operationRow.providerIdempotencyKey,
          stored: {
            snapshotVersion: 3,
            snapshotFingerprint: snapshotRow.snapshotFingerprint,
            leagueId: snapshotRow.leagueId,
            locationId: snapshotRow.locationId,
            providerLocationId: snapshotRow.providerLocationId,
            payerBowlerId: snapshotRow.payerBowlerId,
            requestKind: snapshotRow.requestKind,
            encryptedSourceId: snapshotRow.encryptedSourceId,
            encryptedCustomerId: snapshotRow.encryptedCustomerId,
            encryptedBuyerEmail: snapshotRow.encryptedBuyerEmail,
            storeCard: snapshotRow.storeCard,
            sourceKind: snapshotRow.sourceKind,
            quoteFingerprint: snapshotRow.quoteFingerprint,
            partnerEvidence: snapshotRow.partnerEvidence,
          },
          allocations: recordedSnapshotRows as InteractivePartnerPaymentSnapshot["allocations"],
          lineItems: snapshotRow.lineItems,
        });
        ownerAllocations.push(...snapshot.allocations.map((row) => ({ allocationIndex: row.allocationIndex, obligationId: row.obligationId, bowlerId: row.bowlerId, amountMinor: row.amountMinor })));
      } catch {
        throw new OwnedPaymentLedgerError("LEGACY_PROVIDER_SNAPSHOT_INVALID");
      }
    } else if (snapshotRow.snapshotKind === "standing_autopay" && snapshotRow.snapshotVersion === 2
      && operationRow.operationType === "standing_autopay_charge") {
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
      const participantByIndex = new Map(participantRows.map((row) => [row.allocationIndex, row]));
      if (!binding || binding.evidenceFingerprint !== snapshotRow.snapshotFingerprint || participantRows.length !== authorizedItems.length) {
        throw new OwnedPaymentLedgerError("LEGACY_PROVIDER_SNAPSHOT_INVALID");
      }
      for (const item of authorizedItems) {
        const record = recordedSnapshotRows.find((row) => row.allocationIndex === item.allocationIndex);
        const participant = participantByIndex.get(item.allocationIndex);
        if (!record || record.obligationId !== item.obligationId || record.amountMinor !== item.amountMinor
          || !Number.isSafeInteger(record.payerBowlerId) || !participant || participant.obligationId !== item.obligationId
          || participant.bowlerId !== record.payerBowlerId) throw new OwnedPaymentLedgerError("LEGACY_PROVIDER_SNAPSHOT_INVALID");
        ownerAllocations.push({ allocationIndex: item.allocationIndex, obligationId: item.obligationId, bowlerId: participant.bowlerId, amountMinor: item.amountMinor });
      }
    } else {
      throw new OwnedPaymentLedgerError("LEGACY_PROVIDER_SNAPSHOT_INVALID");
    }
    if (!legacyProviderRecipientItemsMatchSnapshot({
      snapshotItems: authorizedItems,
      snapshotAllocations: ownerAllocations,
      creditedBowlerId: input.creditedBowlerId,
      authorizationItemCount: input.authorizationItemCount ?? 0,
      authorizationItems,
      snapshotFingerprint: snapshotRow.snapshotFingerprint,
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
    if (!operation || operation.operationType !== "interactive_charge" || operation.status !== "succeeded"
      || operation.providerObjectId === null || payment.providerPaymentId !== operation.providerObjectId
      || operation.amountMinor !== payment.amount || operation.currency !== payment.currency
      || !stored || stored.snapshotVersion !== 4 || stored.snapshotKind !== "interactive_funding"
      || stored.snapshotFingerprint !== input.authorizationFingerprint || stored.amountMinor !== payment.amount
      || stored.currency !== payment.currency || stored.payerBowlerId !== payment.bowlerId
      || !/^lvaccountfunding:v4:[0-9a-f]{64}$/.test(stored.snapshotFingerprint)
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
  }
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
      availableMinor: lot.availableMinor,
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
  const [payment] = await tx.select({
    paymentOperationId: payments.paymentOperationId,
    disputeId: payments.disputeId,
    disputedAt: payments.disputedAt,
  }).from(payments).where(and(
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
        eq(paymentOperations.leagueId, input.leagueId),
      )).where(and(
        eq(refundPaymentOperationSnapshots.paymentId, row.application.paymentId),
        eq(refundPaymentOperationSnapshots.leagueId, input.leagueId),
      )),
  ]);
  if (disputeRows.some((dispute) => REVIEW_DISPUTE_STATES.has(dispute.state))
    || refundRows.some((refund) => !isConfirmedNoRefundCreditOutcome(refund))) {
    throw new OwnedPaymentLedgerError("FUNDING_SOURCE_REQUIRES_REVIEW");
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
