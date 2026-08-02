import { createHash } from "node:crypto";
import { DEFAULT_TIMEZONE, type League, type Payment } from "@shared/schema";
import {
  getWeeklyBillingOccurrences,
  WEEKLY_BILLING_GRACE_PERIOD_MS,
  type WeeklyBillingOccurrence as SharedWeeklyBillingOccurrence,
} from "@shared/schedule-utils";

export const BILLING_GRACE_PERIOD_MS = WEEKLY_BILLING_GRACE_PERIOD_MS;
export const AUTOPAY_QUOTE_FINGERPRINT_PREFIX = "lvautopayquote:v1:" as const;

export type BillingOccurrenceState = "past_due" | "due_today" | "future";
export type WeeklyBillingOccurrence = SharedWeeklyBillingOccurrence;

export interface AutopaySetupPayeeInput {
  bowlerId: number;
  payments: Array<Pick<Payment, "amount" | "status" | "weekOf">>;
}

export interface AutopaySetupAllocationPlan {
  bowlerId: number;
  occurrenceAt: string;
  graceDeadlineAt: string;
  localDate: string;
  bowlingWeekNumber: number;
  classification: Exclude<BillingOccurrenceState, "future">;
  amountMinor: number;
  isDoublePay: boolean;
}

export interface AutopaySetupPayeePlan {
  bowlerId: number;
  immediateAmountMinor: number;
  allocations: AutopaySetupAllocationPlan[];
  unappliedCreditMinor: number;
}

export interface AutopaySetupPlan {
  quoteFingerprint: string;
  generatedAt: string;
  immediateAmountMinor: number;
  payees: AutopaySetupPayeePlan[];
  allocations: AutopaySetupAllocationPlan[];
  firstAutomaticOccurrence: WeeklyBillingOccurrence | null;
  firstAutomaticAmountMinor: number;
  recurringAmountMinor: number;
  timezone: string;
  competitionStartTime: string;
}

export class AutopaySetupPlanningError extends Error {
  constructor(
    public readonly code:
      | "INVALID_LEAGUE_SCHEDULE"
      | "PARTIAL_FUTURE_OCCURRENCE"
      | "COMBINED_AUTOPAY_CURSOR_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "AutopaySetupPlanningError";
  }
}

export type PlannerLeague = Pick<
  League,
  | "id"
  | "seasonStart"
  | "seasonEnd"
  | "weekDay"
  | "competitionStartTime"
  | "timezone"
  | "weeklyFee"
  | "totalBowlingWeeks"
  | "skipDates"
  | "cancelledDates"
  | "doublePayDates"
>;

function normalizedCompetitionStartTime(value: string | null): string {
  const match = value?.match(/^([01]\d|2[0-3]):([0-5]\d)/);
  if (!match) {
    throw new AutopaySetupPlanningError(
      "INVALID_LEAGUE_SCHEDULE",
      "League competition start time is not configured.",
    );
  }
  return `${match[1]}:${match[2]}`;
}

function storedTimestampToIso(value: string): string | null {
  const includesZone = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(value);
  const parsed = new Date(includesZone ? value : `${value.replace(" ", "T")}Z`);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function occurrenceState(occurrence: WeeklyBillingOccurrence, now: Date): BillingOccurrenceState {
  const nowMs = now.getTime();
  if (nowMs < new Date(occurrence.occurrenceAt).getTime()) return "future";
  return nowMs < new Date(occurrence.graceDeadlineAt).getTime()
    ? "due_today"
    : "past_due";
}

function canonicalQuote(plan: Omit<AutopaySetupPlan, "quoteFingerprint" | "generatedAt">): string {
  return JSON.stringify({
    immediateAmountMinor: plan.immediateAmountMinor,
    payees: plan.payees.map((payee) => ({
      bowlerId: payee.bowlerId,
      immediateAmountMinor: payee.immediateAmountMinor,
      unappliedCreditMinor: payee.unappliedCreditMinor,
      allocations: payee.allocations.map((allocation) => ({
        bowlerId: allocation.bowlerId,
        occurrenceAt: allocation.occurrenceAt,
        amountMinor: allocation.amountMinor,
        classification: allocation.classification,
      })),
    })),
    firstAutomaticOccurrence: plan.firstAutomaticOccurrence === null
      ? null
      : {
        occurrenceAt: plan.firstAutomaticOccurrence.occurrenceAt,
        amountMinor: plan.firstAutomaticOccurrence.amountMinor,
      },
    firstAutomaticAmountMinor: plan.firstAutomaticAmountMinor,
    recurringAmountMinor: plan.recurringAmountMinor,
    timezone: plan.timezone,
    competitionStartTime: plan.competitionStartTime,
  });
}

export function buildWeeklyBillingOccurrences(league: PlannerLeague): WeeklyBillingOccurrence[] {
  try {
    return getWeeklyBillingOccurrences(league);
  } catch {
    throw new AutopaySetupPlanningError(
      "INVALID_LEAGUE_SCHEDULE",
      "League weekly billing configuration is incomplete.",
    );
  }
}

interface OutstandingOccurrence {
  occurrence: WeeklyBillingOccurrence;
  outstandingMinor: number;
}

function allocateExistingPayments(
  occurrences: WeeklyBillingOccurrence[],
  paymentRows: AutopaySetupPayeeInput["payments"],
): { outstanding: OutstandingOccurrence[]; unappliedCreditMinor: number } {
  const outstanding = occurrences.map((occurrence) => ({
    occurrence,
    outstandingMinor: occurrence.amountMinor,
  }));
  const exactIndex = new Map(
    outstanding.map((row, index) => [row.occurrence.occurrenceAt, index]),
  );
  let legacyCreditMinor = 0;

  for (const payment of paymentRows) {
    if (payment.status !== "paid" || !Number.isSafeInteger(payment.amount) || payment.amount <= 0) continue;
    const paymentAt = storedTimestampToIso(payment.weekOf);
    const index = paymentAt === null ? undefined : exactIndex.get(paymentAt);
    if (index === undefined) {
      legacyCreditMinor += payment.amount;
      continue;
    }
    const row = outstanding[index];
    if (!row) continue;
    const applied = Math.min(row.outstandingMinor, payment.amount);
    row.outstandingMinor -= applied;
    legacyCreditMinor += payment.amount - applied;
  }

  for (const row of outstanding) {
    if (legacyCreditMinor <= 0) break;
    const applied = Math.min(row.outstandingMinor, legacyCreditMinor);
    row.outstandingMinor -= applied;
    legacyCreditMinor -= applied;
  }
  return { outstanding, unappliedCreditMinor: legacyCreditMinor };
}

export function planWeeklyAutopaySetup(input: {
  league: PlannerLeague;
  payees: AutopaySetupPayeeInput[];
  now?: Date;
}): AutopaySetupPlan {
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime()) || input.payees.length === 0) {
    throw new AutopaySetupPlanningError("INVALID_LEAGUE_SCHEDULE", "Auto-pay setup input is invalid.");
  }
  const occurrences = buildWeeklyBillingOccurrences(input.league);
  const billableOccurrences = occurrences.filter((occurrence) => occurrence.amountMinor > 0);
  const payeeIds = input.payees.map((payee) => payee.bowlerId);
  if (new Set(payeeIds).size !== payeeIds.length) {
    throw new AutopaySetupPlanningError("INVALID_LEAGUE_SCHEDULE", "Auto-pay payees must be unique.");
  }

  const payeeStates = input.payees.map((payee) => ({
    bowlerId: payee.bowlerId,
    ...allocateExistingPayments(billableOccurrences, payee.payments),
  }));
  const payees: AutopaySetupPayeePlan[] = payeeStates.map((payee) => {
    const allocations = payee.outstanding.flatMap(({ occurrence, outstandingMinor }) => {
      if (outstandingMinor <= 0) return [];
      const classification = occurrenceState(occurrence, now);
      if (classification === "future") return [];
      return [{
        bowlerId: payee.bowlerId,
        occurrenceAt: occurrence.occurrenceAt,
        graceDeadlineAt: occurrence.graceDeadlineAt,
        localDate: occurrence.localDate,
        bowlingWeekNumber: occurrence.bowlingWeekNumber,
        classification,
        amountMinor: outstandingMinor,
        isDoublePay: occurrence.isDoublePay,
      }];
    });
    return {
      bowlerId: payee.bowlerId,
      immediateAmountMinor: allocations.reduce((sum, row) => sum + row.amountMinor, 0),
      allocations,
      unappliedCreditMinor: payee.unappliedCreditMinor,
    };
  });

  const nextByPayee = payeeStates.map((payee) => {
    const next = payee.outstanding.find(({ occurrence, outstandingMinor }) => (
      outstandingMinor > 0 && occurrenceState(occurrence, now) === "future"
    ));
    if (!next) return null;
    if (next.outstandingMinor !== next.occurrence.amountMinor) {
      throw new AutopaySetupPlanningError(
        "PARTIAL_FUTURE_OCCURRENCE",
        "A future bowling occurrence is partially paid and cannot be enrolled in automatic billing safely.",
      );
    }
    return next;
  });
  const cursorValues = new Set(nextByPayee.map((row) => row?.occurrence.occurrenceAt ?? null));
  if (cursorValues.size > 1) {
    throw new AutopaySetupPlanningError(
      "COMBINED_AUTOPAY_CURSOR_MISMATCH",
      "The selected bowlers do not share the same next unpaid bowling occurrence.",
    );
  }
  const firstAutomaticOccurrence = nextByPayee[0]?.occurrence ?? null;
  const firstAutomaticAmountMinor = nextByPayee.reduce(
    (sum, row) => sum + (row?.outstandingMinor ?? 0),
    0,
  );
  const allocations = payees.flatMap((payee) => payee.allocations)
    .sort((left, right) => (
      left.occurrenceAt.localeCompare(right.occurrenceAt)
      || left.bowlerId - right.bowlerId
    ));
  const timezone = input.league.timezone ?? DEFAULT_TIMEZONE;
  const competitionStartTime = normalizedCompetitionStartTime(input.league.competitionStartTime);
  const withoutFingerprint = {
    immediateAmountMinor: allocations.reduce((sum, row) => sum + row.amountMinor, 0),
    payees,
    allocations,
    firstAutomaticOccurrence,
    firstAutomaticAmountMinor,
    recurringAmountMinor: input.league.weeklyFee * input.payees.length,
    timezone,
    competitionStartTime,
  };
  const digest = createHash("sha256")
    .update(canonicalQuote(withoutFingerprint))
    .digest("hex");
  return {
    ...withoutFingerprint,
    quoteFingerprint: `${AUTOPAY_QUOTE_FINGERPRINT_PREFIX}${digest}`,
    generatedAt: now.toISOString(),
  };
}

export function findWeeklyBillingOccurrence(
  league: PlannerLeague,
  occurrenceAt: string | Date,
): WeeklyBillingOccurrence | undefined {
  const target = occurrenceAt instanceof Date ? occurrenceAt.toISOString() : storedTimestampToIso(occurrenceAt);
  if (target === null) return undefined;
  return buildWeeklyBillingOccurrences(league).find((occurrence) => occurrence.occurrenceAt === target);
}
