import { startOfToday, isValid } from "date-fns";
import type { Payment } from "@shared/schema";
import { countBowlingWeeksPassed, getEffectiveBowlingWeeks } from "@shared/schedule-utils";

/** Presentation-only shape retained for the payment-history display. Amounts
 * and due status come from the canonical financial API, not this module. */
export interface DoublePayStatus {
  dates: string[];
  perWeekExtra: number;
  totalExtra: number;
  pastExtra: number;
  isPaid: boolean;
}

type LeagueWithSchedule = {
  seasonStart: string | Date;
  seasonEnd: string | Date;
  weekDay?: string;
  totalBowlingWeeks?: number | null;
  cancelledDates?: string[] | null;
  skipDates?: string[] | null;
};

/** Season progress fallback used by the dashboard progress display. */
export function getSeasonLengthWeeks(league: LeagueWithSchedule | null | undefined): number {
  if (!league?.seasonStart || !league?.seasonEnd) return 0;
  if (league.totalBowlingWeeks != null) {
    return getEffectiveBowlingWeeks(league.totalBowlingWeeks, league.cancelledDates ?? []);
  }
  const start = new Date(league.seasonStart);
  const end = new Date(league.seasonEnd);
  if (!isValid(start) || !isValid(end)) return 0;
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / (7 * 24 * 60 * 60 * 1000)));
}

/** Season progress fallback used by the dashboard progress display. */
export function getWeeksPassedInSeason(league: LeagueWithSchedule | null | undefined): number {
  if (!league?.seasonStart || !league?.seasonEnd) return 0;
  const maxWeeks = getSeasonLengthWeeks(league);
  if (league.totalBowlingWeeks != null && league.weekDay) {
    return Math.min(maxWeeks, countBowlingWeeksPassed(
      league.seasonStart,
      league.weekDay,
      league.skipDates ?? [],
      league.cancelledDates ?? [],
    ));
  }
  const start = new Date(league.seasonStart);
  const end = new Date(league.seasonEnd);
  if (!isValid(start) || !isValid(end)) return 0;
  const today = startOfToday();
  const effective = today < start ? start : today > end ? end : today;
  return Math.max(0, Math.round((effective.getTime() - start.getTime()) / (7 * 24 * 60 * 60 * 1000)));
}

/** Payment-row presentation grouping; it is not a balance calculator. */
export function getPaymentSummary(payments: Payment[]) {
  const paidPayments = payments.filter((payment) => payment.status === "paid");
  const unpaidPayments = payments.filter((payment) => payment.status !== "paid");
  return {
    paidPayments,
    totalPaidAmount: paidPayments.reduce((sum, payment) => sum + payment.amount, 0),
    unpaidPayments,
    totalUnpaidAmount: unpaidPayments.reduce((sum, payment) => sum + payment.amount, 0),
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
  reviewRequired: boolean;
  reviewCategory: "refund" | "dispute" | "evidence" | null;
}
