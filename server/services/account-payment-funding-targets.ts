import { comparePublishedCollectionOrder, type FifoPaymentCandidate } from "./automatic-fifo-allocation.js";

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
