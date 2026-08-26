import { useCallback, useEffect, useMemo, useState } from "react";
import type { PaymentMode } from "@shared/schema";
import { WEEKDAYS } from "@shared/schema";
import type { ScheduleWeekType } from "@shared/schedule-utils";
import {
  calculateSeasonEnd,
  getAllBowlingDates,
  getEffectiveBowlingWeeks,
} from "@shared/schedule-utils";

type WeekDay = (typeof WEEKDAYS)[number];

export interface LeagueScheduleDraftOptions {
  initialSeasonStart?: string;
  initialBowlingWeeks?: number;
  initialWeekDay?: WeekDay;
  initialSkipDates?: string[];
  initialCancelledDates?: string[];
  initialDoublePayDates?: string[];
  initialPaymentMode?: PaymentMode | "";
  /** LeagueForm keeps these fields in RHF; the hook still owns all derived schedule state. */
  controlledSeasonStart?: string | Date;
  controlledWeekDay?: WeekDay;
  controlledPaymentMode?: PaymentMode | "";
}

export function useLeagueScheduleDraft(options: LeagueScheduleDraftOptions = {}) {
  const [ownedSeasonStart, setOwnedSeasonStart] = useState(options.initialSeasonStart ?? "");
  const [bowlingWeeks, setBowlingWeeks] = useState(options.initialBowlingWeeks ?? 30);
  const [ownedWeekDay, setOwnedWeekDay] = useState<WeekDay>(options.initialWeekDay ?? "Monday");
  const [skipDates, setSkipDates] = useState(options.initialSkipDates ?? []);
  const [cancelledDates, setCancelledDates] = useState(options.initialCancelledDates ?? []);
  const [doublePayDates, setDoublePayDates] = useState(options.initialDoublePayDates ?? []);
  const [ownedPaymentMode, setOwnedPaymentMode] = useState<PaymentMode | "">(options.initialPaymentMode ?? "");

  const controlledSeasonStart = options.controlledSeasonStart;
  const seasonStart = controlledSeasonStart instanceof Date
    ? controlledSeasonStart.toISOString()
    : controlledSeasonStart ?? ownedSeasonStart;
  const weekDay = options.controlledWeekDay ?? ownedWeekDay;
  const paymentMode = options.controlledPaymentMode ?? ownedPaymentMode;

  useEffect(() => {
    if (paymentMode === "upfront") setDoublePayDates([]);
  }, [paymentMode]);

  const computedSeasonEnd = useMemo(() => {
    if (!seasonStart || bowlingWeeks <= 0) return null;
    return calculateSeasonEnd(seasonStart, weekDay, bowlingWeeks, skipDates, cancelledDates);
  }, [bowlingWeeks, cancelledDates, seasonStart, skipDates, weekDay]);

  const effectiveBowlingWeeks = useMemo(
    () => getEffectiveBowlingWeeks(bowlingWeeks, cancelledDates),
    [bowlingWeeks, cancelledDates],
  );

  const scheduleDates = useMemo(() => {
    if (!seasonStart || bowlingWeeks <= 0) return [];
    return getAllBowlingDates(seasonStart, weekDay, bowlingWeeks, skipDates, cancelledDates, doublePayDates);
  }, [bowlingWeeks, cancelledDates, doublePayDates, seasonStart, skipDates, weekDay]);

  const clearSchedule = useCallback(() => {
    setSkipDates([]);
    setCancelledDates([]);
    setDoublePayDates([]);
  }, []);

  const toggleDateType = useCallback((isoDate: string, currentType: ScheduleWeekType, allowCancelled = false) => {
    if (currentType === "normal" || currentType === "double-pay") {
      setDoublePayDates((dates) => dates.filter((date) => date !== isoDate));
      setSkipDates((dates) => dates.includes(isoDate) ? dates : [...dates, isoDate]);
      return;
    }
    if (currentType === "skip") {
      setSkipDates((dates) => dates.filter((date) => date !== isoDate));
      if (allowCancelled) setCancelledDates((dates) => dates.includes(isoDate) ? dates : [...dates, isoDate]);
      return;
    }
    if (currentType === "cancelled") {
      setCancelledDates((dates) => dates.filter((date) => date !== isoDate));
    }
  }, []);

  const toggleDoublePayDate = useCallback((isoDate: string) => {
    if (paymentMode === "upfront" || skipDates.includes(isoDate) || cancelledDates.includes(isoDate)) return;
    setDoublePayDates((dates) => dates.includes(isoDate)
      ? dates.filter((date) => date !== isoDate)
      : dates.length < 2 ? [...dates, isoDate] : dates);
  }, [cancelledDates, paymentMode, skipDates]);

  return {
    seasonStart,
    setSeasonStart: setOwnedSeasonStart,
    bowlingWeeks,
    setBowlingWeeks,
    weekDay,
    setWeekDay: setOwnedWeekDay,
    skipDates,
    setSkipDates,
    cancelledDates,
    setCancelledDates,
    doublePayDates,
    setDoublePayDates,
    paymentMode,
    setPaymentMode: setOwnedPaymentMode,
    computedSeasonEnd,
    effectiveBowlingWeeks,
    scheduleDates,
    clearSchedule,
    toggleDateType,
    toggleDoublePayDate,
  };
}
