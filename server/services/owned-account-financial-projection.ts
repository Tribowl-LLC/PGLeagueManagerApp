import { and, eq, inArray } from "drizzle-orm";
import {
  canonicalCollectionGroupMembers,
  canonicalCollectionGroups,
  leagueOccurrenceBillingTerms,
  leagueOccurrences,
  weeklyPaymentWeekConfirmations,
} from "@shared/schema";
import {
  FINANCIAL_ACCOUNT_PROJECTION_CONTRACT,
  type FinancialObligationOwner,
  type FinancialReadAccountProjection,
  type FinancialReadAccountProjectionRow,
  type FinancialReadRowAccountProjection,
} from "@shared/financial-contract";
import type { PaymentOperationTransaction } from "../storage/payment-operations.js";
import { comparePublishedCollectionOrder, type FifoPaymentCandidate } from "./automatic-fifo-allocation.js";
import { confirmedPastDueMinor } from "./account-payment-funding-targets.js";
import {
  readConfirmedOwnedObligationsInTransaction,
  readGenericFundingAvailabilityInTransaction,
  readOwnedAccountBalancesInTransaction,
  readOwnedLedgerAdoptionInTransaction,
  type OwnedConfirmedObligation,
} from "./owned-payment-ledger.js";
import type { OwnedAccountBalance } from "./owned-payment-ledger.js";
import { readRotatingCreditFundingBalancesInTransaction } from "./rotating-credit-applications.js";

export interface OwnedAccountProjectionRowInput {
  obligationId: string;
  occurrenceId: string;
  occurrenceLocalDate: string;
  dueAt: string;
  effectiveCollectionAt: string;
  memberOrdinal: number;
  billingOrdinal: number;
  owner: FinancialObligationOwner;
  effectiveDebtorBowlerId: number | null;
  forecastEligible: boolean;
  state: "open" | "partially_settled" | "settled" | "voided";
  outstandingMinor: number;
  reviewRequired: boolean;
}

export interface OwnedAccountProjectionInput {
  organizationId: number;
  leagueId: number;
  asOf: string;
  rows: readonly OwnedAccountProjectionRowInput[];
  /** Existing API scope. Only this account may be returned for a bowler read. */
  bowlerId?: number;
}

export interface PublishedCollectionOrderSeed {
  occurrenceId: string;
  dueAt: string;
  billingOrdinal: number;
}

export interface PublishedCollectionOrder {
  effectiveCollectionAt: string;
  memberOrdinal: number;
  billingOrdinal: number;
}

export interface OwnedAccountProjectionResult {
  accountProjection: FinancialReadAccountProjection;
  rowsByObligationId: Map<string, FinancialReadRowAccountProjection>;
  reviewRequiredByObligationId: Map<string, boolean>;
  collectiblePastDueMinor: number;
}

interface MutableAccountProjectionRow {
  bowlerId: number;
  amountPaidMinor: number;
  availableCreditMinor: number;
  confirmedDebtMinor: number;
  netBalanceMinor: number;
  confirmedPastDueMinor: number;
  seasonRemainingMinor: number;
  reviewRequired: boolean;
}

function addMinor(target: Map<number, number>, bowlerId: number, amountMinor: number): void {
  const next = (target.get(bowlerId) ?? 0) + amountMinor;
  if (!Number.isSafeInteger(next) || next < 0) throw new Error("owned account projection exceeds safe integer cents");
  target.set(bowlerId, next);
}

function assertProjectionMinor(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("owned account projection contains invalid cents");
}

function accountBalance(balance: OwnedAccountBalance | undefined, bowlerId: number): OwnedAccountBalance {
  return balance ?? { bowlerId, availableCreditMinor: 0, confirmedOwedMinor: 0, netBalanceMinor: 0 };
}

/** Batch-read published collection-group order for one league snapshot. */
export async function readPublishedCollectionOrderInTransaction(
  tx: PaymentOperationTransaction,
  input: { organizationId: number; leagueId: number; occurrences: readonly PublishedCollectionOrderSeed[] },
): Promise<Map<string, PublishedCollectionOrder>> {
  const occurrenceIds = [...new Set(input.occurrences.map((row) => row.occurrenceId))];
  if (occurrenceIds.length === 0) return new Map();
  const [billingTerms, members] = await Promise.all([
    tx.select({ occurrenceId: leagueOccurrenceBillingTerms.occurrenceId, billingOrdinal: leagueOccurrenceBillingTerms.billingOrdinal })
      .from(leagueOccurrenceBillingTerms).where(and(
        eq(leagueOccurrenceBillingTerms.organizationId, input.organizationId),
        eq(leagueOccurrenceBillingTerms.leagueId, input.leagueId),
        eq(leagueOccurrenceBillingTerms.state, "published"),
        inArray(leagueOccurrenceBillingTerms.occurrenceId, occurrenceIds),
      )),
    tx.select({
      groupId: canonicalCollectionGroupMembers.groupId,
      occurrenceId: canonicalCollectionGroupMembers.occurrenceId,
      role: canonicalCollectionGroupMembers.role,
      memberOrdinal: canonicalCollectionGroupMembers.memberOrdinal,
      billingOrdinal: canonicalCollectionGroupMembers.billingOrdinal,
    }).from(canonicalCollectionGroupMembers).innerJoin(canonicalCollectionGroups, and(
      eq(canonicalCollectionGroups.id, canonicalCollectionGroupMembers.groupId),
      eq(canonicalCollectionGroups.organizationId, input.organizationId),
      eq(canonicalCollectionGroups.leagueId, input.leagueId),
      eq(canonicalCollectionGroups.state, "published"),
    )).where(and(
      eq(canonicalCollectionGroupMembers.organizationId, input.organizationId),
      eq(canonicalCollectionGroupMembers.leagueId, input.leagueId),
      eq(canonicalCollectionGroupMembers.active, true),
      inArray(canonicalCollectionGroupMembers.occurrenceId, occurrenceIds),
    )),
  ]);
  const billingByOccurrence = new Map<string, number>();
  for (const term of billingTerms) {
    if (term.billingOrdinal === null || billingByOccurrence.has(term.occurrenceId)) {
      throw new Error("published billing order evidence is missing or ambiguous");
    }
    billingByOccurrence.set(term.occurrenceId, term.billingOrdinal);
  }
  const seedByOccurrence = new Map(input.occurrences.map((row) => [row.occurrenceId, row]));
  for (const occurrenceId of occurrenceIds) {
    const seed = seedByOccurrence.get(occurrenceId);
    const published = billingByOccurrence.get(occurrenceId);
    if (!seed || published === undefined || seed.billingOrdinal !== published || !Number.isFinite(Date.parse(seed.dueAt))) {
      throw new Error("canonical financial row does not match published billing order");
    }
  }
  const memberByOccurrence = new Map<string, typeof members[number]>();
  for (const member of members) {
    if (memberByOccurrence.has(member.occurrenceId) || member.billingOrdinal !== billingByOccurrence.get(member.occurrenceId)) {
      throw new Error("published collection member order is ambiguous or inconsistent");
    }
    memberByOccurrence.set(member.occurrenceId, member);
  }
  const groupIds = [...new Set(members.map((member) => member.groupId))];
  const triggers = groupIds.length === 0 ? [] : await tx.select({ groupId: canonicalCollectionGroupMembers.groupId, startAt: leagueOccurrences.startAt })
    .from(canonicalCollectionGroupMembers).innerJoin(leagueOccurrences, and(
      eq(leagueOccurrences.id, canonicalCollectionGroupMembers.occurrenceId),
      eq(leagueOccurrences.organizationId, input.organizationId),
      eq(leagueOccurrences.leagueId, input.leagueId),
    )).where(and(
      eq(canonicalCollectionGroupMembers.organizationId, input.organizationId),
      eq(canonicalCollectionGroupMembers.leagueId, input.leagueId),
      eq(canonicalCollectionGroupMembers.role, "trigger"),
      eq(canonicalCollectionGroupMembers.active, true),
      inArray(canonicalCollectionGroupMembers.groupId, groupIds),
    ));
  const triggerAtByGroup = new Map<string, string>();
  for (const trigger of triggers) {
    if (triggerAtByGroup.has(trigger.groupId)) throw new Error("published collection group has multiple trigger occurrences");
    triggerAtByGroup.set(trigger.groupId, new Date(trigger.startAt).toISOString());
  }
  if (groupIds.some((groupId) => !triggerAtByGroup.has(groupId))) {
    throw new Error("published collection group is missing its trigger occurrence");
  }
  return new Map(occurrenceIds.map((occurrenceId) => {
    const seed = seedByOccurrence.get(occurrenceId);
    const billingOrdinal = billingByOccurrence.get(occurrenceId);
    if (!seed || billingOrdinal === undefined) throw new Error("published collection order seed is missing");
    const member = memberByOccurrence.get(occurrenceId);
    const triggerAt = member?.role === "paired" ? triggerAtByGroup.get(member.groupId) : undefined;
    return [occurrenceId, {
      effectiveCollectionAt: triggerAt ?? new Date(seed.dueAt).toISOString(),
      memberOrdinal: member?.memberOrdinal ?? 0,
      billingOrdinal,
    }];
  }));
}

/** Pure account-budget projection shared by due, worksheet, and envelope reads. */
export function projectOwnedAccountCoverage(input: {
  rows: readonly OwnedAccountProjectionRowInput[];
  confirmedDebts: readonly OwnedConfirmedObligation[];
  balances: ReadonlyMap<number, OwnedAccountBalance>;
  amountPaidByBowler: ReadonlyMap<number, number>;
  sourceReviewBowlerIds?: ReadonlySet<number>;
  confirmedOccurrenceIds?: ReadonlySet<string>;
  confirmedThroughLocalDate?: string | null;
  asOf: string;
  bowlerId?: number;
}): OwnedAccountProjectionResult {
  const asOfMs = Date.parse(input.asOf);
  if (!Number.isFinite(asOfMs)) throw new Error("owned account projection timestamp is invalid");
  const rowById = new Map<string, OwnedAccountProjectionRowInput>();
  for (const row of input.rows) {
    if (!row.obligationId || rowById.has(row.obligationId)) throw new Error("owned account projection obligations must be unique");
    assertProjectionMinor(row.outstandingMinor);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.occurrenceLocalDate)
      || !Number.isFinite(Date.parse(row.dueAt))
      || !Number.isFinite(Date.parse(row.effectiveCollectionAt))) {
      throw new Error("owned account projection dates are invalid");
    }
    rowById.set(row.obligationId, row);
  }

  const confirmedDebtById = new Map<string, OwnedConfirmedObligation>();
  const confirmedByOwner = new Map<number, OwnedConfirmedObligation[]>();
  for (const debt of input.confirmedDebts) {
    if (confirmedDebtById.has(debt.obligationId) || !rowById.has(debt.obligationId)) {
      throw new Error("confirmed account debt is missing unique canonical row evidence");
    }
    assertProjectionMinor(debt.outstandingMinor);
    confirmedDebtById.set(debt.obligationId, debt);
    confirmedByOwner.set(debt.debtorBowlerId, [...(confirmedByOwner.get(debt.debtorBowlerId) ?? []), debt]);
  }

  const owners = new Set<number>(input.balances.keys());
  for (const row of input.rows) {
    if (row.effectiveDebtorBowlerId !== null) owners.add(row.effectiveDebtorBowlerId);
  }
  for (const bowlerId of input.amountPaidByBowler.keys()) owners.add(bowlerId);
  for (const bowlerId of input.sourceReviewBowlerIds ?? []) owners.add(bowlerId);
  if (input.bowlerId !== undefined) owners.add(input.bowlerId);

  const availableByOwner = new Map<number, number>();
  const projectedByObligation = new Map<string, number>();
  const reviewHoldOwners = new Set<number>();
  for (const bowlerId of owners) {
    const balance = accountBalance(input.balances.get(bowlerId), bowlerId);
    assertProjectionMinor(balance.availableCreditMinor);
    availableByOwner.set(bowlerId, balance.availableCreditMinor);
  }
  const applyCredit = (bowlerId: number, obligationId: string, outstandingMinor: number, reviewRequired: boolean): void => {
    if (outstandingMinor <= 0) return;
    if (reviewRequired) {
      reviewHoldOwners.add(bowlerId);
      return;
    }
    if (reviewHoldOwners.has(bowlerId)) return;
    const availableMinor = availableByOwner.get(bowlerId) ?? 0;
    const appliedMinor = Math.min(availableMinor, outstandingMinor);
    if (appliedMinor <= 0) return;
    projectedByObligation.set(obligationId, (projectedByObligation.get(obligationId) ?? 0) + appliedMinor);
    availableByOwner.set(bowlerId, availableMinor - appliedMinor);
  };

  const orderedConfirmed = [...input.confirmedDebts].sort((left, right) => (
    left.occurrenceLocalDate.localeCompare(right.occurrenceLocalDate)
    || Date.parse(left.dueAt) - Date.parse(right.dueAt)
    || left.obligationId.localeCompare(right.obligationId)
  ));
  for (const debt of orderedConfirmed) {
    applyCredit(debt.debtorBowlerId, debt.obligationId, debt.outstandingMinor, debt.reviewRequired);
  }

  const forecastRows = input.rows.filter((row) => (
    row.forecastEligible
    &&
    !confirmedDebtById.has(row.obligationId)
    && row.state !== "voided"
    && row.outstandingMinor > 0
    && row.effectiveDebtorBowlerId !== null
  ));
  const forecastCandidates: Array<{ row: OwnedAccountProjectionRowInput; candidate: FifoPaymentCandidate }> = forecastRows.map((row) => ({
    row,
    candidate: {
      id: row.obligationId,
      occurrenceId: row.occurrenceId,
      outstandingMinor: row.outstandingMinor,
      dueAt: row.dueAt,
      effectiveCollectionAt: row.effectiveCollectionAt,
      memberOrdinal: row.memberOrdinal,
      billingOrdinal: row.billingOrdinal,
      reservedMinor: 0,
      reviewRequired: row.reviewRequired,
      pairedCollectionReady: row.effectiveCollectionAt !== row.dueAt,
    },
  })).sort((left, right) => comparePublishedCollectionOrder(left.candidate, right.candidate));
  for (const { row } of forecastCandidates) {
    if (row.effectiveDebtorBowlerId === null) continue;
    applyCredit(row.effectiveDebtorBowlerId, row.obligationId, row.outstandingMinor, row.reviewRequired);
  }

  const confirmedOccurrenceIds = input.confirmedOccurrenceIds ?? new Set<string>();
  const rowsByObligationId = new Map<string, FinancialReadRowAccountProjection>();
  const reviewRequiredByObligationId = new Map<string, boolean>();
  const seasonDemandByOwner = new Map<number, number>();
  const projectedAppliedByOwner = new Map<number, number>();
  const reviewRowsByOwner = new Set<number>();
  for (const row of input.rows) {
    const debt = confirmedDebtById.get(row.obligationId);
    const effectiveDebtorBowlerId = debt?.debtorBowlerId ?? row.effectiveDebtorBowlerId;
    const confirmationStatus = confirmedOccurrenceIds.has(row.occurrenceId)
      || (input.confirmedThroughLocalDate !== null && input.confirmedThroughLocalDate !== undefined
        && row.occurrenceLocalDate <= input.confirmedThroughLocalDate)
      ? "confirmed" as const
      : "forecast" as const;
    const projectedCreditMinor = projectedByObligation.get(row.obligationId) ?? 0;
    rowsByObligationId.set(row.obligationId, {
      owner: row.owner,
      effectiveDebtorBowlerId,
      confirmationStatus,
      projectedCreditMinor,
    });
    reviewRequiredByObligationId.set(row.obligationId, debt?.reviewRequired ?? row.reviewRequired);
    if (effectiveDebtorBowlerId === null || row.state === "voided" || (!row.forecastEligible && !debt)) continue;
    const outstandingMinor = debt?.outstandingMinor ?? row.outstandingMinor;
    addMinor(seasonDemandByOwner, effectiveDebtorBowlerId, outstandingMinor);
    addMinor(projectedAppliedByOwner, effectiveDebtorBowlerId, projectedCreditMinor);
    if (outstandingMinor > 0 && (debt?.reviewRequired ?? row.reviewRequired)) reviewRowsByOwner.add(effectiveDebtorBowlerId);
  }

  const accountRows: FinancialReadAccountProjectionRow[] = [...owners].sort((a, b) => a - b).flatMap((bowlerId) => {
    if (input.bowlerId !== undefined && input.bowlerId !== bowlerId) return [];
    const balance = accountBalance(input.balances.get(bowlerId), bowlerId);
    const ownerDebts = confirmedByOwner.get(bowlerId) ?? [];
    const confirmedOwedMinor = ownerDebts.reduce((sum, debt) => sum + debt.outstandingMinor, 0);
    if (balance.confirmedOwedMinor !== confirmedOwedMinor) {
      throw new Error("owned account balance does not match confirmed obligation evidence");
    }
    const amountPaidMinor = input.amountPaidByBowler.get(bowlerId) ?? 0;
    assertProjectionMinor(amountPaidMinor);
    return [{
      bowlerId,
      amountPaidMinor,
      availableCreditMinor: balance.availableCreditMinor,
      confirmedDebtMinor: balance.confirmedOwedMinor,
      netBalanceMinor: balance.netBalanceMinor,
      confirmedPastDueMinor: confirmedPastDueMinor({ debts: ownerDebts, availableCreditMinor: balance.availableCreditMinor, asOf: input.asOf }),
      seasonRemainingMinor: Math.max(0, (seasonDemandByOwner.get(bowlerId) ?? 0) - (projectedAppliedByOwner.get(bowlerId) ?? 0)),
      reviewRequired: (input.sourceReviewBowlerIds?.has(bowlerId) ?? false) || (reviewRowsByOwner.has(bowlerId)),
    }];
  });
  const collectiblePastDueMinor = accountRows.reduce((sum, row) => sum + row.confirmedPastDueMinor, 0);
  if (!Number.isSafeInteger(collectiblePastDueMinor)) throw new Error("owned account past-due projection exceeds safe integer cents");

  return {
    accountProjection: {
      contractVersion: FINANCIAL_ACCOUNT_PROJECTION_CONTRACT,
      accounts: accountRows,
    },
    rowsByObligationId,
    reviewRequiredByObligationId,
    collectiblePastDueMinor,
  };
}

/** Batch the adopted ledger evidence inside the caller's repeatable-read transaction. */
export async function readOwnedAccountFinancialProjectionInTransaction(
  tx: PaymentOperationTransaction,
  input: OwnedAccountProjectionInput,
): Promise<OwnedAccountProjectionResult | null> {
  const adoption = await readOwnedLedgerAdoptionInTransaction(tx, input);
  if (!adoption) return null;
  // The caller prepares all canonical rows before this read. Read league-wide
  // ledger evidence in bounded batches so the shared account budget is
  // complete; only the response projection is bowler-scoped below.
  const ledgerScope = { organizationId: input.organizationId, leagueId: input.leagueId };
  const [confirmedDebts, balances, genericLots, confirmationRows] = await Promise.all([
    readConfirmedOwnedObligationsInTransaction(tx, ledgerScope),
    readOwnedAccountBalancesInTransaction(tx, ledgerScope),
    readGenericFundingAvailabilityInTransaction(tx, ledgerScope),
    tx.select({ occurrenceId: weeklyPaymentWeekConfirmations.occurrenceId })
      .from(weeklyPaymentWeekConfirmations)
      .where(and(
        eq(weeklyPaymentWeekConfirmations.organizationId, input.organizationId),
        eq(weeklyPaymentWeekConfirmations.leagueId, input.leagueId),
      )),
  ]);
  const accountOwnerIds = [...new Set([
    ...balances.keys(),
    ...input.rows.flatMap((row) => row.effectiveDebtorBowlerId === null ? [] : [row.effectiveDebtorBowlerId]),
  ])];
  const rotatingLots = accountOwnerIds.length === 0 ? [] : await readRotatingCreditFundingBalancesInTransaction(tx, {
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    bowlerIds: accountOwnerIds,
  });
  const amountPaidByBowler = new Map<number, number>();
  const sourceReviewBowlerIds = new Set<number>();
  for (const lot of genericLots) {
    if (lot.receiptEvidenceInvalid || (lot.reviewRequired && lot.receivedMinor > 0)) sourceReviewBowlerIds.add(lot.bowlerId);
    addMinor(amountPaidByBowler, lot.bowlerId, lot.receivedMinor);
  }
  for (const lot of rotatingLots) {
    if (lot.receiptEvidenceInvalid || (lot.reviewRequired && lot.receivedMinor > 0)) sourceReviewBowlerIds.add(lot.bowlerId);
    addMinor(amountPaidByBowler, lot.bowlerId, lot.receivedMinor);
  }

  const confirmedOccurrenceIds = new Set(confirmationRows.map((row) => row.occurrenceId));
  const projected = projectOwnedAccountCoverage({
    rows: input.rows,
    confirmedDebts,
    balances,
    amountPaidByBowler,
    sourceReviewBowlerIds,
    confirmedOccurrenceIds,
    confirmedThroughLocalDate: adoption.adoptedThroughLocalDate,
    asOf: input.asOf,
    bowlerId: input.bowlerId,
  });
  return projected;
}
