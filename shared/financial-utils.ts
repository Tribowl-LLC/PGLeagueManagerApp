import { isValid } from "date-fns";
import {
  getEffectiveBowlingWeeks,
  getWeeklyBillingOccurrences,
} from "./schedule-utils";

export interface BowlerPastDueLeague {
  seasonStart: string | Date;
  seasonEnd?: string | Date | null;
  weekDay?: string | null;
  weeklyFee: number;
  paymentMode?: string | null;
  totalBowlingWeeks?: number | null;
  skipDates?: string[] | null;
  cancelledDates?: string[] | null;
  doublePayDates?: string[] | null;
  competitionStartTime?: string | null;
  timezone?: string | null;
}

function getSeasonLengthWeeks(league: {
  seasonStart: string | Date;
  seasonEnd: string | Date;
  totalBowlingWeeks?: number | null;
  cancelledDates?: string[] | null;
}): number {
  if (!league.seasonStart || !league.seasonEnd) return 0;
  if (league.totalBowlingWeeks != null) {
    return getEffectiveBowlingWeeks(
      league.totalBowlingWeeks,
      league.cancelledDates ?? [],
    );
  }
  const start = new Date(league.seasonStart);
  const end = new Date(league.seasonEnd);
  if (!isValid(start) || !isValid(end)) return 0;
  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / msPerWeek));
}

/**
 * Source-of-truth past-due calculation shared by the client UI and the
 * server-side autopay-setup guard. Mirrors the per-bowler past-due
 * shown in the bowler payment page.
 *
 * **Double-pay redistribution model**: a league with N double-pay
 * dates bills 2× on each of those dates and bills $0 on the LAST N
 * bowling weeks of the season. The season total stays at
 * `weeklyFee × totalWeeks` regardless of how many double-pay dates
 * are configured — double-pay weeks shift money forward in the
 * schedule, they do not add to the season total.
 *
 * Worked example: 32-week league, $30/week, double-pay on weeks 5 & 6:
 *   - weeks 1–4: $30, week 5: $60, week 6: $60, weeks 7–30: $30,
 *     weeks 31–32: $0. Sum = 30 × $30 + 2 × $30 = $960 = 32 × $30.
 */
export function calculateBowlerPastDue(
  league: BowlerPastDueLeague,
  bowlerPaidAmount: number,
  now: Date = new Date(),
): number {
  const totalWeeks = getSeasonLengthWeeks({
    seasonStart: league.seasonStart,
    seasonEnd: league.seasonEnd ?? league.seasonStart,
    totalBowlingWeeks: league.totalBowlingWeeks,
    cancelledDates: league.cancelledDates,
  });
  const fullSeasonAmount = league.weeklyFee * totalWeeks;

  if (league.paymentMode === "upfront") {
    return Math.max(0, fullSeasonAmount - bowlerPaidAmount);
  }

  if (league.weekDay) {
    const occurrences = getWeeklyBillingOccurrences({
      seasonStart: league.seasonStart,
      seasonEnd: league.seasonEnd ?? league.seasonStart,
      weekDay: league.weekDay,
      competitionStartTime: league.competitionStartTime ?? "12:00",
      timezone: league.timezone,
      weeklyFee: league.weeklyFee,
      totalBowlingWeeks: league.totalBowlingWeeks,
      skipDates: league.skipDates,
      cancelledDates: league.cancelledDates,
      doublePayDates: league.doublePayDates,
    });
    const dueToDate = occurrences
      .filter((occurrence) => new Date(occurrence.graceDeadlineAt).getTime() <= now.getTime())
      .reduce((sum, occurrence) => sum + occurrence.amountMinor, 0);
    return Math.max(0, dueToDate - bowlerPaidAmount);
  }

  const seasonStart = new Date(league.seasonStart);
  if (!isValid(seasonStart)) return 0;
  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  const weeksPassedRaw = Math.max(
    0,
    Math.round((now.getTime() - seasonStart.getTime()) / msPerWeek),
  );
  const dueToDate = Math.min(league.weeklyFee * weeksPassedRaw, fullSeasonAmount);
  return Math.max(0, dueToDate - bowlerPaidAmount);
}

/** Server/client parity summary for legacy compatibility reads. Historical
 * payments are inputs to this helper, never canonical allocation evidence. */
export function calculateBowlerLegacySummary(
  league: BowlerPastDueLeague,
  bowlerPaidAmount: number,
  now: Date = new Date(),
): { totalWeeksInSeason: number; fullSeasonAmount: number; totalDueToDate: number; amountPastDue: number; remainingBalance: number } {
  const totalWeeksInSeason = getSeasonLengthWeeks({ seasonStart: league.seasonStart, seasonEnd: league.seasonEnd ?? league.seasonStart, totalBowlingWeeks: league.totalBowlingWeeks, cancelledDates: league.cancelledDates });
  const fullSeasonAmount = league.weeklyFee * totalWeeksInSeason;
  let totalDueToDate = fullSeasonAmount;
  if (league.paymentMode !== "upfront") {
    if (league.weekDay) {
      totalDueToDate = getWeeklyBillingOccurrences({ seasonStart: league.seasonStart, seasonEnd: league.seasonEnd ?? league.seasonStart, weekDay: league.weekDay, competitionStartTime: league.competitionStartTime ?? "12:00", timezone: league.timezone, weeklyFee: league.weeklyFee, totalBowlingWeeks: league.totalBowlingWeeks, skipDates: league.skipDates, cancelledDates: league.cancelledDates, doublePayDates: league.doublePayDates }).filter((occurrence) => new Date(occurrence.graceDeadlineAt).getTime() <= now.getTime()).reduce((sum, occurrence) => sum + occurrence.amountMinor, 0);
    } else {
      const seasonStart = new Date(league.seasonStart);
      const weeksPassed = isValid(seasonStart) ? Math.min(totalWeeksInSeason, Math.max(0, Math.round((now.getTime() - seasonStart.getTime()) / (7 * 24 * 60 * 60 * 1000)))) : 0;
      totalDueToDate = weeksPassed * league.weeklyFee;
    }
  }
  return { totalWeeksInSeason, fullSeasonAmount, totalDueToDate, amountPastDue: Math.max(0, totalDueToDate - bowlerPaidAmount), remainingBalance: Math.max(0, fullSeasonAmount - bowlerPaidAmount) };
}
