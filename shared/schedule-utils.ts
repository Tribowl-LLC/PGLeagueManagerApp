import { addWeeks, differenceInCalendarWeeks } from "date-fns";
import { fromZonedTime } from "date-fns-tz";
import { DEFAULT_TIMEZONE } from "./schema/constants";

const WEEKDAY_MAP: Record<string, number> = {
  Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3,
  Thursday: 4, Friday: 5, Saturday: 6,
};

export function toIsoDateStr(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function toLocalMidnight(date: string | Date): Date {
  if (typeof date === "string") {
    const datePart = date.replace(" ", "T").split("T")[0];
    const [year, month, day] = datePart.split("-").map(Number);
    return new Date(year, month - 1, day, 12, 0, 0, 0);
  }
  const d = new Date(date);
  d.setHours(12, 0, 0, 0);
  return d;
}

export type ScheduleWeekType = "normal" | "skip" | "cancelled" | "double-pay";

export type ScheduleWeek = {
  date: Date;
  isoDate: string;
  type: ScheduleWeekType;
  bowlingWeekNumber: number | null;
};

export const WEEKLY_BILLING_GRACE_PERIOD_MS = 3 * 60 * 60 * 1000;

export interface WeeklyBillingOccurrenceInput {
  seasonStart: string | Date;
  seasonEnd: string | Date;
  weekDay: string;
  competitionStartTime?: string | null;
  timezone?: string | null;
  weeklyFee: number;
  totalBowlingWeeks?: number | null;
  skipDates?: string[] | null;
  cancelledDates?: string[] | null;
  doublePayDates?: string[] | null;
}

export interface WeeklyBillingOccurrence {
  occurrenceAt: string;
  graceDeadlineAt: string;
  localDate: string;
  bowlingWeekNumber: number;
  amountMinor: number;
  isDoublePay: boolean;
}

export function getEffectiveBowlingWeeks(
  totalBowlingWeeks: number,
  cancelledDates: string[]
): number {
  return Math.max(0, totalBowlingWeeks - (cancelledDates?.length ?? 0));
}

function findFirstBowlingDay(seasonStart: string | Date, weekDay: string): Date {
  const targetDay = WEEKDAY_MAP[weekDay];
  let start = toLocalMidnight(seasonStart);

  if (targetDay === undefined) return start;

  const startDay = start.getDay();
  const daysToAdd = (targetDay - startDay + 7) % 7;
  if (daysToAdd > 0) {
    start = new Date(start.getTime() + daysToAdd * 24 * 60 * 60 * 1000);
  }
  return start;
}

export function calculateSeasonEnd(
  seasonStart: string | Date,
  weekDay: string,
  totalBowlingWeeks: number,
  skipDates: string[],
  cancelledDates: string[]
): Date {
  if (totalBowlingWeeks <= 0) return toLocalMidnight(seasonStart);

  const skipSet = new Set((skipDates ?? []).map((d) => d.slice(0, 10)));
  const cancelSet = new Set((cancelledDates ?? []).map((d) => d.slice(0, 10)));
  const allExcluded = new Set([...skipSet, ...cancelSet]);

  const effectiveWeeks = getEffectiveBowlingWeeks(totalBowlingWeeks, cancelledDates ?? []);
  if (effectiveWeeks <= 0) {
    return findFirstBowlingDay(seasonStart, weekDay);
  }

  let current = findFirstBowlingDay(seasonStart, weekDay);
  let found = 0;
  let lastBowlingDate = new Date(current);
  const maxIter = totalBowlingWeeks + allExcluded.size + 60;

  for (let i = 0; i < maxIter; i++) {
    const dateStr = toIsoDateStr(current);
    if (!allExcluded.has(dateStr)) {
      found++;
      lastBowlingDate = new Date(current);
      if (found >= effectiveWeeks) break;
    }
    current = addWeeks(current, 1);
  }

  return lastBowlingDate;
}

export function getAllBowlingDates(
  seasonStart: string | Date,
  weekDay: string,
  totalBowlingWeeks: number,
  skipDates: string[],
  cancelledDates: string[],
  doublePayDates: string[] = []
): ScheduleWeek[] {
  const skipSet = new Set((skipDates ?? []).map((d) => d.slice(0, 10)));
  const cancelSet = new Set((cancelledDates ?? []).map((d) => d.slice(0, 10)));
  const doublePaySet = new Set((doublePayDates ?? []).map((d) => d.slice(0, 10)));

  // Key semantics:
  //   • Skip  → holiday; season EXTENDS (skip does NOT consume a planned slot)
  //   • Cancelled → no makeup; season SHORTENS (cancelled DOES consume a planned slot)
  //
  // Therefore the planned calendar window contains exactly:
  //   totalBowlingWeeks non-skip dates (normal + cancelled),
  //   plus any additional skip weeks inserted inside that window.
  //
  // Every cancelled date IS inside the window and must always appear in the
  // list so admins can toggle it back to Normal or Skip at any time.

  const result: ScheduleWeek[] = [];
  let current = findFirstBowlingDay(seasonStart, weekDay);
  let bowlingWeekNumber = 0;
  // slots = normal + cancelled rows emitted (skips don't count toward the window)
  let slotsConsumed = 0;
  const maxIter = totalBowlingWeeks + skipSet.size + cancelSet.size + 60;

  for (let i = 0; i < maxIter; i++) {
    const dateStr = toIsoDateStr(current);
    const isSkip = skipSet.has(dateStr);
    const isCancelled = cancelSet.has(dateStr);
    const isDoublePay = !isSkip && !isCancelled && doublePaySet.has(dateStr);
    const type: ScheduleWeek["type"] = isSkip
      ? "skip"
      : isCancelled
      ? "cancelled"
      : isDoublePay
      ? "double-pay"
      : "normal";

    // Both normal and double-pay dates count as bowling weeks (they
    // each consume one slot and get a week number); skip/cancelled
    // dates do not get a number.
    const weekNum = !isSkip && !isCancelled ? ++bowlingWeekNumber : null;

    // Both normal and cancelled rows consume a planned slot
    if (!isSkip) slotsConsumed++;

    result.push({ date: new Date(current), isoDate: dateStr, type, bowlingWeekNumber: weekNum });

    // Stop once all planned slots are consumed
    if (slotsConsumed >= totalBowlingWeeks) break;

    current = addWeeks(current, 1);
  }

  return result;
}

function billingDateOnly(value: string | Date): string {
  if (typeof value === "string") {
    const match = value.match(/^\d{4}-\d{2}-\d{2}/);
    if (match) return match[0];
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("league season dates are invalid");
  }
  return parsed.toISOString().slice(0, 10);
}

function billingStartTime(value: string | null | undefined): string {
  const match = value?.match(/^([01]\d|2[0-3]):([0-5]\d)/);
  if (!match) throw new Error("league competition start time is not configured");
  return `${match[1]}:${match[2]}`;
}

/**
 * Authoritative weekly money-occurrence model for future payment paths.
 * League dates/times are converted to exact UTC instants, including DST.
 * This additive helper is deliberately dormant until a payment path opts in.
 */
export function getWeeklyBillingOccurrences(
  input: WeeklyBillingOccurrenceInput,
): WeeklyBillingOccurrence[] {
  if (!Number.isSafeInteger(input.weeklyFee) || input.weeklyFee <= 0 || !input.weekDay) {
    throw new Error("league weekly billing configuration is incomplete");
  }
  const timezone = input.timezone ?? DEFAULT_TIMEZONE;
  const competitionStartTime = billingStartTime(input.competitionStartTime);
  const seasonStart = billingDateOnly(input.seasonStart);
  const seasonEnd = billingDateOnly(input.seasonEnd);
  const fallbackWeeks = Math.max(
    1,
    differenceInCalendarWeeks(
      new Date(`${seasonEnd}T12:00:00Z`),
      new Date(`${seasonStart}T12:00:00Z`),
      { weekStartsOn: 0 },
    ) + 1,
  );
  const totalBowlingWeeks = input.totalBowlingWeeks ?? fallbackWeeks;
  const generated = getAllBowlingDates(
    seasonStart,
    input.weekDay,
    totalBowlingWeeks,
    input.skipDates ?? [],
    input.cancelledDates ?? [],
    input.doublePayDates ?? [],
  ).filter((week) => (
    week.bowlingWeekNumber !== null
    && week.isoDate >= seasonStart
    && week.isoDate <= seasonEnd
  ));
  const fullSeasonAmountMinor = input.weeklyFee * generated.length;
  let amountAssignedMinor = 0;
  return generated.map((week) => {
    const requestedAmount = week.type === "double-pay" ? input.weeklyFee * 2 : input.weeklyFee;
    const amountMinor = Math.max(
      0,
      Math.min(requestedAmount, fullSeasonAmountMinor - amountAssignedMinor),
    );
    amountAssignedMinor += amountMinor;
    const occurrenceAt = fromZonedTime(
      `${week.isoDate}T${competitionStartTime}:00`,
      timezone,
    );
    if (!Number.isFinite(occurrenceAt.getTime())) {
      throw new Error("league billing occurrence could not be converted to UTC");
    }
    return {
      occurrenceAt: occurrenceAt.toISOString(),
      graceDeadlineAt: new Date(
        occurrenceAt.getTime() + WEEKLY_BILLING_GRACE_PERIOD_MS,
      ).toISOString(),
      localDate: week.isoDate,
      bowlingWeekNumber: week.bowlingWeekNumber as number,
      amountMinor,
      isDoublePay: week.type === "double-pay",
    };
  });
}

export function getBowlingWeekNumber(
  date: Date,
  seasonStart: string | Date,
  weekDay: string,
  skipDates: string[],
  cancelledDates: string[]
): number {
  const skipSet = new Set((skipDates ?? []).map((d) => d.slice(0, 10)));
  const cancelSet = new Set((cancelledDates ?? []).map((d) => d.slice(0, 10)));
  const allExcluded = new Set([...skipSet, ...cancelSet]);

  const targetStr = toIsoDateStr(date);
  let current = findFirstBowlingDay(seasonStart, weekDay);
  let weekNum = 0;
  const maxIter = 200;

  for (let i = 0; i < maxIter; i++) {
    const dateStr = toIsoDateStr(current);
    if (!allExcluded.has(dateStr)) {
      weekNum++;
    }
    if (dateStr === targetStr) return weekNum;
    current = addWeeks(current, 1);
  }

  return weekNum;
}

export function countBowlingWeeksPassed(
  seasonStart: string | Date,
  weekDay: string,
  skipDates: string[],
  cancelledDates: string[]
): number {
  const skipSet = new Set((skipDates ?? []).map((d) => d.slice(0, 10)));
  const cancelSet = new Set((cancelledDates ?? []).map((d) => d.slice(0, 10)));
  const allExcluded = new Set([...skipSet, ...cancelSet]);

  const today = toLocalMidnight(new Date());
  const todayStr = toIsoDateStr(today);
  let current = findFirstBowlingDay(seasonStart, weekDay);
  let weekNum = 0;
  const maxIter = 200;

  for (let i = 0; i < maxIter; i++) {
    const dateStr = toIsoDateStr(current);
    if (dateStr > todayStr) break;
    if (!allExcluded.has(dateStr)) {
      weekNum++;
    }
    current = addWeeks(current, 1);
  }

  return weekNum;
}

export function getBowlingDateByWeekNumber(
  seasonStart: string | Date,
  weekDay: string,
  weekNumber: number,
  skipDates: string[],
  cancelledDates: string[]
): Date | null {
  if (weekNumber <= 0) return null;

  const skipSet = new Set((skipDates ?? []).map((d) => d.slice(0, 10)));
  const cancelSet = new Set((cancelledDates ?? []).map((d) => d.slice(0, 10)));
  const allExcluded = new Set([...skipSet, ...cancelSet]);

  let current = findFirstBowlingDay(seasonStart, weekDay);
  let weekNum = 0;
  const maxIter = weekNumber + allExcluded.size + 60;

  for (let i = 0; i < maxIter; i++) {
    const dateStr = toIsoDateStr(current);
    if (!allExcluded.has(dateStr)) {
      weekNum++;
      if (weekNum >= weekNumber) return new Date(current);
    }
    current = addWeeks(current, 1);
  }

  return null;
}

export function isDateSkippedOrCancelled(
  date: Date,
  skipDates: string[],
  cancelledDates: string[]
): boolean {
  const dateStr = toIsoDateStr(date);
  return (
    (skipDates ?? []).some((d) => d.slice(0, 10) === dateStr) ||
    (cancelledDates ?? []).some((d) => d.slice(0, 10) === dateStr)
  );
}
