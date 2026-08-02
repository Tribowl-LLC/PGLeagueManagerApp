import { startOfToday, isValid } from "date-fns";
import type { League, Payment } from "@shared/schema";
import {
  getEffectiveBowlingWeeks,
  countBowlingWeeksPassed,
  getWeeklyBillingOccurrences,
} from "@shared/schedule-utils";

/**
 * Task #646 — replaces the old `FinalTwoWeeksStatus` shape. The
 * admin picks 0–2 individual ISO dates ("double-pay weeks") that
 * bill 2× the weekly fee on those dates.
 *
 * **Redistribution model**: double-pay weeks shift money forward in
 * the season — they do NOT add to the season total. A 32-week league
 * with 2 double-pay weeks still totals `weeklyFee × 32`; the last 2
 * regular bowling weeks are not billed (their dollars were collected
 * earlier on the doubled weeks).
 */
export interface DoublePayStatus {
  /** ISO yyyy-mm-dd dates flagged as 2× pay weeks (0–2 entries). */
  dates: string[];
  /** Extra owed on each double-pay date above the regular weekly fee (= weeklyFee). */
  perWeekExtra: number;
  /**
   * Sum of the per-double-pay-date extras (= dates.length × weeklyFee).
   * NOTE: this does NOT add to `fullSeasonAmount` — it represents the
   * dollars that have been shifted forward from the last N regular
   * bowling weeks.
   */
  totalExtra: number;
  /** Extras already due as of today (= weeklyFee × dates already on/before today). */
  pastExtra: number;
  /** True when the cumulative paid amount covers the full season. */
  isPaid: boolean;
}

export interface FinancialCalculation {
  weeksPassed: number;
  totalWeeksInSeason: number;
  totalDueToDate: number;
  totalPaid: number;
  amountPastDue: number;
  fullSeasonAmount: number;
  remainingBalance: number;
  doublePay: DoublePayStatus;
}

type LeagueWithSchedule = {
  seasonStart: string | Date;
  seasonEnd: string | Date;
  weekDay?: string;
  totalBowlingWeeks?: number | null;
  skipDates?: string[] | null;
  cancelledDates?: string[] | null;
};

export function getSeasonLengthWeeks(league: LeagueWithSchedule | null | undefined): number {
  if (!league?.seasonStart || !league?.seasonEnd) return 0;
  if (league.totalBowlingWeeks != null) {
    return getEffectiveBowlingWeeks(
      league.totalBowlingWeeks,
      league.cancelledDates ?? []
    );
  }
  const start = new Date(league.seasonStart);
  const end = new Date(league.seasonEnd);
  if (!isValid(start) || !isValid(end)) return 0;
  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / msPerWeek));
}

export function getWeeksPassedInSeason(league: LeagueWithSchedule | null | undefined): number {
  if (!league?.seasonStart || !league?.seasonEnd) return 0;
  const maxWeeks = getSeasonLengthWeeks(league);
  if (league.totalBowlingWeeks != null && league.weekDay) {
    const passed = countBowlingWeeksPassed(
      league.seasonStart,
      league.weekDay,
      league.skipDates ?? [],
      league.cancelledDates ?? []
    );
    return Math.min(passed, maxWeeks);
  }
  const seasonStart = new Date(league.seasonStart);
  const seasonEnd = new Date(league.seasonEnd);
  if (!isValid(seasonStart) || !isValid(seasonEnd)) return 0;
  const today = startOfToday();
  const effectiveDate = today < seasonStart ? seasonStart : today > seasonEnd ? seasonEnd : today;
  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  return Math.max(0, Math.round((effectiveDate.getTime() - seasonStart.getTime()) / msPerWeek));
}

export function getTotalPaidAmount(payments: Payment[]): number {
  return payments
    .filter(p => p.status === 'paid')
    .reduce((sum, p) => sum + p.amount, 0);
}

function emptyDoublePay(weeklyFee = 0): DoublePayStatus {
  return {
    dates: [],
    perWeekExtra: weeklyFee,
    totalExtra: 0,
    pastExtra: 0,
    isPaid: false,
  };
}

export function calculateFinancials(league: League | null | undefined, payments: Payment[]): FinancialCalculation {
  const totalPaid = getTotalPaidAmount(payments);

  if (!league?.seasonStart || !league?.seasonEnd || !league?.weeklyFee) {
    return {
      weeksPassed: 0,
      totalWeeksInSeason: 0,
      totalDueToDate: 0,
      totalPaid,
      amountPastDue: 0,
      fullSeasonAmount: 0,
      remainingBalance: 0,
      doublePay: emptyDoublePay(),
    };
  }

  const weeksPassed = getWeeksPassedInSeason(league);
  const totalWeeksInSeason = getSeasonLengthWeeks(league);

  const doublePayDates = (league.doublePayDates ?? [])
    .map(d => d.slice(0, 10))
    .filter(Boolean);
  const perWeekExtra = league.weeklyFee;
  const totalExtra = doublePayDates.length * perWeekExtra;

  // Redistribution model: fullSeasonAmount stays at weeklyFee × totalWeeks
  // regardless of double-pay count. The doubled charges shift dollars from
  // the last N regular weeks forward to the double-pay dates; they do not
  // add to the season total.
  const fullSeasonAmount = league.weeklyFee * totalWeeksInSeason;
  const remainingBalance = Math.max(0, fullSeasonAmount - totalPaid);

  const isUpfront = league.paymentMode === 'upfront';

  if (isUpfront) {
    // Upfront leagues: the full season is due immediately and the
    // unpaid remainder is past-due. This matches calculateBowlerView-
    // Financials and the shared calculateBowlerPastDue helper exactly
    // (Task #726 parity). A pre-season "not yet past-due" gate would
    // need to land in all three helpers together — adding it here
    // alone would silently desync the bowler page from the past-due
    // report and the autopay-setup guard.
    const amountPastDue = Math.max(0, fullSeasonAmount - totalPaid);
    return {
      weeksPassed,
      totalWeeksInSeason,
      totalDueToDate: fullSeasonAmount,
      totalPaid,
      amountPastDue,
      fullSeasonAmount,
      remainingBalance,
      doublePay: {
        dates: doublePayDates,
        perWeekExtra,
        totalExtra,
        pastExtra: totalExtra,
        isPaid: totalPaid >= fullSeasonAmount,
      },
    };
  }

  const now = new Date();
  const occurrences = getWeeklyBillingOccurrences({
    seasonStart: league.seasonStart,
    seasonEnd: league.seasonEnd,
    weekDay: league.weekDay ?? "",
    competitionStartTime: league.competitionStartTime ?? "12:00",
    timezone: league.timezone,
    weeklyFee: league.weeklyFee,
    totalBowlingWeeks: league.totalBowlingWeeks,
    skipDates: league.skipDates,
    cancelledDates: league.cancelledDates,
    doublePayDates: league.doublePayDates,
  });
  const dueOccurrences = occurrences.filter(
    (occurrence) => new Date(occurrence.graceDeadlineAt).getTime() <= now.getTime(),
  );
  const pastExtra = dueOccurrences.filter((occurrence) => occurrence.isDoublePay)
    .length * perWeekExtra;
  const totalDueToDate = Math.min(
    dueOccurrences.reduce((sum, occurrence) => sum + occurrence.amountMinor, 0),
    fullSeasonAmount,
  );
  const amountPastDue = Math.max(0, totalDueToDate - totalPaid);

  return {
    weeksPassed,
    totalWeeksInSeason,
    totalDueToDate,
    totalPaid,
    amountPastDue,
    fullSeasonAmount,
    remainingBalance,
    doublePay: {
      dates: doublePayDates,
      perWeekExtra,
      totalExtra,
      pastExtra,
      isPaid: totalPaid >= fullSeasonAmount,
    },
  };
}

export { calculateBowlerPastDue } from "@shared/financial-utils";

export function getPaymentSummary(payments: Payment[]) {
  const paidPayments = payments.filter((p) => p.status === "paid");
  const unpaidPayments = payments.filter((p) => p.status !== "paid");
  return {
    paidPayments,
    totalPaidAmount: paidPayments.reduce((sum, p) => sum + p.amount, 0),
    unpaidPayments,
    totalUnpaidAmount: unpaidPayments.reduce((sum, p) => sum + p.amount, 0),
  };
}
export interface BowlerViewFinancials {
  weeksDue: number;
  totalSeasonDues: number;
  totalWeeksInSeason: number;
  fullSeasonAmount: number;
  amountPastDue: number;
  remainingBalance: number;
  totalPaidAmount: number;
  totalUnpaidAmount: number;
}

export function calculateBowlerViewFinancials(
  league: League | null | undefined,
  payments: Payment[]
): BowlerViewFinancials {
  const { totalPaidAmount, totalUnpaidAmount } = getPaymentSummary(payments);
  const financials = calculateFinancials(league, payments);

  return {
    weeksDue: financials.weeksPassed,
    totalSeasonDues: financials.totalDueToDate,
    totalWeeksInSeason: financials.totalWeeksInSeason,
    fullSeasonAmount: financials.fullSeasonAmount,
    amountPastDue: financials.amountPastDue,
    remainingBalance: financials.remainingBalance,
    totalPaidAmount,
    totalUnpaidAmount,
  };
}
