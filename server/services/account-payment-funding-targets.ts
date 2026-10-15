import { comparePublishedCollectionOrder, type FifoPaymentCandidate } from "./automatic-fifo-allocation.js";
import type { OwnedConfirmedObligation } from "./owned-payment-ledger.js";

type ConfirmedPastDueDebt = Pick<OwnedConfirmedObligation,
  "obligationId" | "occurrenceLocalDate" | "dueAt" | "pastDueAt" | "outstandingMinor" | "reviewRequired">;

/** Project overdue confirmed debt after consuming this owner's available
 * credit through the same oldest-debt order used by the owned FIFO writer.
 * A review-held positive debt stops spending; only non-held residual debt
 * whose stored past-due instant has arrived is included in the result. */
export function confirmedPastDueMinor(input: {
  debts: readonly ConfirmedPastDueDebt[];
  availableCreditMinor: number;
  asOf: string;
}): number {
  if (!Number.isSafeInteger(input.availableCreditMinor) || input.availableCreditMinor < 0) {
    throw new Error("account past-due credit must be nonnegative integer cents");
  }
  const asOfMs = Date.parse(input.asOf);
  if (!Number.isFinite(asOfMs)) throw new Error("account past-due timestamp is invalid");
  const seenIds = new Set<string>();
  const parsed = input.debts.map((debt) => {
    if (!debt.obligationId || seenIds.has(debt.obligationId)) throw new Error("confirmed account obligations must be unique");
    seenIds.add(debt.obligationId);
    if (!Number.isSafeInteger(debt.outstandingMinor) || debt.outstandingMinor < 0) {
      throw new Error("confirmed account debt must be nonnegative integer cents");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(debt.occurrenceLocalDate)
      || !Number.isFinite(Date.parse(debt.dueAt)) || !Number.isFinite(Date.parse(debt.pastDueAt))) {
      throw new Error("confirmed account debt dates are invalid");
    }
    return {
      debt,
      dueAtMs: Date.parse(debt.dueAt),
      pastDueAtMs: Date.parse(debt.pastDueAt),
      remainingMinor: debt.outstandingMinor,
    };
  }).sort((left, right) => left.debt.occurrenceLocalDate.localeCompare(right.debt.occurrenceLocalDate)
    || left.dueAtMs - right.dueAtMs
    || left.debt.obligationId.localeCompare(right.debt.obligationId));

  let availableMinor = input.availableCreditMinor;
  let reviewHoldReached = false;
  for (const row of parsed) {
    if (row.remainingMinor <= 0) continue;
    if (row.debt.reviewRequired) {
      reviewHoldReached = true;
      continue;
    }
    if (reviewHoldReached || availableMinor <= 0) continue;
    const appliedMinor = Math.min(availableMinor, row.remainingMinor);
    row.remainingMinor -= appliedMinor;
    availableMinor -= appliedMinor;
  }

  let totalMinor = 0;
  for (const row of parsed) {
    if (row.debt.reviewRequired || row.pastDueAtMs > asOfMs) continue;
    totalMinor += row.remainingMinor;
    if (!Number.isSafeInteger(totalMinor)) throw new Error("account past-due balance exceeds safe integer cents");
  }
  return totalMinor;
}

export type ConfirmedAccountFundingDebt = {
  obligationId: string;
  occurrenceId: string;
  outstandingMinor: number;
  reviewRequired: boolean;
};

export type StandingAccountFundingTarget = {
  confirmedDebtMinor: number;
  olderConfirmedDebtMinor: number;
  creditAppliedToOlderDebtMinor: number;
  olderConfirmedDebtRemainingMinor: number;
  olderDebtReviewRequired: boolean;
  currentDebtReviewRequired: boolean;
  availableCreditMinor: number;
  currentCollectionTargetMinor: number;
  forecastCollectionTargetMinor: number;
  newChargeMinor: number;
};

/** Keep paired collection timing based on its published trigger timestamp. */
export function effectiveCollectionPrefixMinor(candidates: FifoPaymentCandidate[], now: string): number {
  const asOf = new Date(now).getTime();
  if (!Number.isFinite(asOf)) throw new Error("account funding target timestamp is invalid");
  const ordered = [...candidates].sort(comparePublishedCollectionOrder);
  let lastDueIndex = -1;
  ordered.forEach((row, index) => {
    if ((row.outstandingMinor > 0 || row.reservedMinor > 0)
      && new Date(row.effectiveCollectionAt).getTime() <= asOf) lastDueIndex = index;
  });
  if (lastDueIndex < 0) return 0;
  return ordered.slice(0, lastDueIndex + 1).reduce((sum, row) => sum + row.outstandingMinor, 0);
}

/**
 * Project one standing cutoff's authorized collection group and explicitly
 * retained paired-final requirements. Forecasts outside that supplied set
 * are not standing arrears, even when their ordinary date has passed.
 * Existing credit is first consumed by older confirmed debt; any remainder
 * is then available to cover the selected current collection target.
 */
export function projectStandingAccountFundingTarget(input: {
  candidates: FifoPaymentCandidate[];
  confirmedDebts: ConfirmedAccountFundingDebt[];
  availableCreditMinor: number;
  cutoffAt: string;
  collectionRequirementOccurrenceIds: readonly string[];
}): StandingAccountFundingTarget {
  if (!Number.isSafeInteger(input.availableCreditMinor) || input.availableCreditMinor < 0) {
    throw new Error("account funding credit must be nonnegative integer cents");
  }
  const requiredOccurrenceIds = new Set(input.collectionRequirementOccurrenceIds);
  if (requiredOccurrenceIds.size !== input.collectionRequirementOccurrenceIds.length) {
    throw new Error("standing collection requirement occurrences must be unique");
  }
  if (requiredOccurrenceIds.size === 0) throw new Error("standing collection requirements cannot be empty");

  const confirmedIds = new Set<string>();
  let confirmedDebtMinor = 0;
  let olderConfirmedDebtMinor = 0;
  let selectedConfirmedMinor = 0;
  let olderDebtReviewRequired = false;
  let currentDebtReviewRequired = false;
  for (const debt of input.confirmedDebts) {
    if (!Number.isSafeInteger(debt.outstandingMinor) || debt.outstandingMinor < 0) {
      throw new Error("confirmed account debt must be nonnegative integer cents");
    }
    if (confirmedIds.has(debt.obligationId)) throw new Error("confirmed account obligations must be unique");
    confirmedIds.add(debt.obligationId);
    confirmedDebtMinor += debt.outstandingMinor;
    if (requiredOccurrenceIds.has(debt.occurrenceId)) {
      selectedConfirmedMinor += debt.outstandingMinor;
      currentDebtReviewRequired ||= debt.outstandingMinor > 0 && debt.reviewRequired;
    } else {
      olderConfirmedDebtMinor += debt.outstandingMinor;
      olderDebtReviewRequired ||= debt.outstandingMinor > 0 && debt.reviewRequired;
    }
  }

  // Scope before calculating the published effective-collection prefix. This
  // includes a paired final whose published collection time is its trigger,
  // while excluding every unrelated missed ordinary forecast.
  const selectedForecasts = input.candidates.filter((candidate) => !confirmedIds.has(candidate.id)
    && requiredOccurrenceIds.has(candidate.occurrenceId));
  if (selectedForecasts.some((candidate) => candidate.reviewRequired)) {
    throw new Error("standing forecast evidence requires staff review");
  }
  const forecastCollectionTargetMinor = effectiveCollectionPrefixMinor(selectedForecasts, input.cutoffAt);
  const creditAppliedToOlderDebtMinor = Math.min(input.availableCreditMinor, olderConfirmedDebtMinor);
  const olderConfirmedDebtRemainingMinor = olderConfirmedDebtMinor - creditAppliedToOlderDebtMinor;
  const creditForCurrentCollectionMinor = input.availableCreditMinor - creditAppliedToOlderDebtMinor;
  const currentCollectionTargetMinor = selectedConfirmedMinor + forecastCollectionTargetMinor;
  const newChargeMinor = olderDebtReviewRequired || currentDebtReviewRequired || olderConfirmedDebtRemainingMinor > 0
    ? 0
    : Math.max(0, currentCollectionTargetMinor - creditForCurrentCollectionMinor);

  return {
    confirmedDebtMinor,
    olderConfirmedDebtMinor,
    creditAppliedToOlderDebtMinor,
    olderConfirmedDebtRemainingMinor,
    olderDebtReviewRequired,
    currentDebtReviewRequired,
    availableCreditMinor: input.availableCreditMinor,
    currentCollectionTargetMinor,
    forecastCollectionTargetMinor,
    newChargeMinor,
  };
}

export type UpcomingStandingCutoff = {
  cutoffAt: string;
  collectionMode: "weekly" | "double_pay";
  /** The occurrences this cutoff collects, including retained paired finals. */
  requirementOccurrenceIds: readonly string[];
  /** Billing ordinals shown to the bowler, trigger week first. */
  billingOrdinals: number[];
};

export type UpcomingStandingCharge = {
  cutoffAt: string;
  collectionMode: "weekly" | "double_pay";
  amountMinor: number;
  billingOrdinals: number[];
};

export type UpcomingStandingProjection = {
  charges: UpcomingStandingCharge[];
  /** Trigger week of the last leading cutoff already covered by prepayment. */
  paidAheadThroughOrdinal: number | null;
  /** Older confirmed debt that blocks automatic collection until it is paid. */
  overdueMinor: number;
  /** True when review-held evidence prevents any reliable projection. */
  reviewRequired: boolean;
};

/**
 * Display-only forecast of the next standing charges. Each cutoff reuses the
 * single-cutoff target, with credit carried forward as earlier projected
 * cutoffs consume it. Older debt is reported separately as overdue, and the
 * charges show what collection will be once it is cleared. Cutoffs that
 * prepayment fully covers are skipped. A charge never trusts this forecast;
 * each cutoff is still quoted and fenced under the league lock when it runs.
 */
export function projectUpcomingStandingCharges(input: {
  recipients: Array<{ candidates: FifoPaymentCandidate[]; confirmedDebts: ConfirmedAccountFundingDebt[]; availableCreditMinor: number }>;
  cutoffs: UpcomingStandingCutoff[];
  limit: number;
}): UpcomingStandingProjection {
  const charges: UpcomingStandingCharge[] = [];
  let paidAheadThroughOrdinal: number | null = null;
  let overdueMinor = 0;
  const remainingCredit = input.recipients.map((recipient) => recipient.availableCreditMinor);
  for (const [cutoffIndex, cutoff] of input.cutoffs.entries()) {
    if (charges.length >= input.limit) break;
    const requirementIds = new Set(cutoff.requirementOccurrenceIds);
    let amountMinor = 0;
    for (const [recipientIndex, recipient] of input.recipients.entries()) {
      let target: StandingAccountFundingTarget;
      try {
        target = projectStandingAccountFundingTarget({
          candidates: recipient.candidates,
          // Older debt is measured once, at the first cutoff. Later cutoffs
          // only see their own debt so it is not counted twice.
          confirmedDebts: cutoffIndex === 0 ? recipient.confirmedDebts : recipient.confirmedDebts.filter((debt) => requirementIds.has(debt.occurrenceId)),
          availableCreditMinor: remainingCredit[recipientIndex],
          cutoffAt: cutoff.cutoffAt,
          collectionRequirementOccurrenceIds: cutoff.requirementOccurrenceIds,
        });
      } catch {
        return { charges, paidAheadThroughOrdinal, overdueMinor, reviewRequired: true };
      }
      if (target.olderDebtReviewRequired || target.currentDebtReviewRequired) return { charges, paidAheadThroughOrdinal, overdueMinor, reviewRequired: true };
      if (cutoffIndex === 0) overdueMinor += target.olderConfirmedDebtRemainingMinor;
      const creditForCurrentMinor = target.availableCreditMinor - target.creditAppliedToOlderDebtMinor;
      remainingCredit[recipientIndex] = creditForCurrentMinor - Math.min(creditForCurrentMinor, target.currentCollectionTargetMinor);
      amountMinor += Math.max(0, target.currentCollectionTargetMinor - creditForCurrentMinor);
    }
    if (amountMinor > 0) charges.push({ cutoffAt: cutoff.cutoffAt, collectionMode: cutoff.collectionMode, amountMinor, billingOrdinals: cutoff.billingOrdinals });
    else if (charges.length === 0) paidAheadThroughOrdinal = cutoff.billingOrdinals[0] ?? paidAheadThroughOrdinal;
  }
  return { charges, paidAheadThroughOrdinal, overdueMinor, reviewRequired: false };
}
