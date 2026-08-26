import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronUp, CalendarX, SkipForward, Check, CircleDollarSign } from "lucide-react";
import type { ScheduleWeekType } from "@shared/schedule-utils";

interface ScheduleDate {
  date: Date;
  isoDate: string;
  type: ScheduleWeekType;
  bowlingWeekNumber: number | null;
}

interface LeagueSchedulePreviewProps {
  scheduleDates: ScheduleDate[];
  showSchedule: boolean;
  setShowSchedule: (fn: (prev: boolean) => boolean) => void;
  bowlingWeeks: number;
  skipDates: string[];
  cancelledDates: string[];
  doublePayDates: string[];
  effectiveBowlingWeeks: number;
  computedSeasonEnd: Date | null;
  toggleDateType: (isoDate: string, currentType: ScheduleWeekType) => void;
  toggleDoublePayDate?: (isoDate: string) => void;
  /** Creation and rollover schedules support Bowling/No Bowling only. */
  allowCancelled?: boolean;
  /** Double-pay is a weekly-only policy. */
  allowDoublePay?: boolean;
}

export function LeagueSchedulePreview({
  scheduleDates,
  showSchedule,
  setShowSchedule,
  bowlingWeeks,
  skipDates,
  cancelledDates,
  doublePayDates,
  effectiveBowlingWeeks,
  computedSeasonEnd,
  toggleDateType,
  toggleDoublePayDate,
  allowCancelled = true,
  allowDoublePay = true,
}: LeagueSchedulePreviewProps) {
  if (scheduleDates.length === 0) return null;

  return (
    <div className="space-y-1.5">
      {!showSchedule && (
        <p className="text-xs text-muted-foreground px-1">
          Click weeks to mark No Bowling skips{allowCancelled ? ", cancellations" : ""}, or double-pay.
        </p>
      )}
      <div className="rounded-lg border">
      <button
        type="button"
        className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium"
        onClick={() => setShowSchedule(s => !s)}
        aria-expanded={showSchedule}
        aria-controls="league-schedule-preview"
      >
        <span className="flex flex-col items-start gap-0.5">
          <span>Bowling Schedule (click weeks to customize)</span>
          {bowlingWeeks > 0 && (
            <span className="text-xs text-muted-foreground font-normal">
              {bowlingWeeks} planned week{bowlingWeeks !== 1 ? 's' : ''}
              {skipDates.length > 0 && ` · ${skipDates.length} holiday skip${skipDates.length !== 1 ? 's' : ''}`}
              {allowCancelled && cancelledDates.length > 0 && ` · ${cancelledDates.length} cancellation${cancelledDates.length !== 1 ? 's' : ''}`}
              {doublePayDates.length > 0 && ` · ${doublePayDates.length} double-pay week${doublePayDates.length !== 1 ? 's' : ''}`}
              {computedSeasonEnd && ` · ends ${computedSeasonEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`}
            </span>
          )}
        </span>
        {showSchedule ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
      </button>

      {showSchedule && (
        <div id="league-schedule-preview" className="border-t">
          <div className="px-3 py-2 text-xs text-muted-foreground bg-muted/30">
          Choose Bowling or No Bowling for each date{allowCancelled ? ", or Cancelled for an existing season" : ""}. {allowDoublePay ? "Use the separate 2× Pay toggle for up to two weekly dates." : ""}
          </div>
          <div className="divide-y max-h-72 overflow-y-auto">
            {scheduleDates.map((week) => {
              const isDoublePay = doublePayDates.includes(week.isoDate);
              const baseType = isDoublePay
                ? (skipDates.includes(week.isoDate) ? "skip" : "normal")
                : week.type;
              const weekLabel = week.type === 'skip'
                ? 'Skip'
                : allowCancelled && week.type === 'cancelled'
                ? 'Cancelled'
                : week.type === 'double-pay'
                ? `Week ${week.bowlingWeekNumber} · 2× Pay`
                : `Week ${week.bowlingWeekNumber}`;
                return (
                <div key={week.isoDate} className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted/50 transition-colors">
                <button
                  type="button"
                  onClick={() => toggleDateType(week.isoDate, baseType)}
                  className={`flex min-w-0 flex-1 items-center justify-between text-left ${
                    week.type === 'skip'
                      ? 'bg-yellow-50 dark:bg-yellow-950/20'
                      : allowCancelled && week.type === 'cancelled'
                      ? 'bg-red-50 dark:bg-red-950/20'
                      : week.type === 'double-pay'
                      ? 'bg-emerald-50 dark:bg-emerald-950/20'
                      : ''
                  }`}
                  data-testid={`schedule-week-${week.isoDate}`}
                  aria-pressed={baseType === "skip" || (allowCancelled && baseType === "cancelled")}
                  aria-label={`${week.date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}: ${baseType === "skip" ? "No Bowling" : baseType === "cancelled" ? "Cancelled" : "Bowling"}`}
                >
                  <span className={week.type === 'skip' || (allowCancelled && week.type === 'cancelled') ? 'text-muted-foreground line-through' : ''}>
                    {week.date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                  </span>
                  <Badge
                    variant={week.type === 'normal' ? 'outline' : 'secondary'}
                    className={`ml-2 text-xs shrink-0 ${
                      week.type === 'skip'
                        ? 'border-yellow-400 text-yellow-700 dark:text-yellow-400'
                        : week.type === 'cancelled'
                        ? 'border-red-400 text-red-700 dark:text-red-400'
                        : week.type === 'double-pay'
                        ? 'border-emerald-500 text-emerald-700 dark:text-emerald-400'
                        : ''
                    }`}
                  >
                    {week.type === 'skip' && <SkipForward className="mr-1 size-3" />}
                    {week.type === 'cancelled' && <CalendarX className="mr-1 size-3" />}
                    {week.type === 'double-pay' && <CircleDollarSign className="mr-1 size-3" />}
                    {week.type === 'normal' && <Check className="mr-1 size-3" />}
                    {weekLabel}
                  </Badge>
                </button>
                {allowDoublePay && toggleDoublePayDate && week.type !== "skip" && week.type !== "cancelled" && (
                  <button
                    type="button"
                    className="shrink-0 rounded border px-2 py-1 text-xs hover:bg-muted"
                    onClick={() => toggleDoublePayDate(week.isoDate)}
                    aria-pressed={isDoublePay}
                    aria-label={`${isDoublePay ? "Remove" : "Mark"} double pay for ${week.date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`}
                    data-testid={`schedule-double-pay-${week.isoDate}`}
                  >
                    2× Pay
                  </button>
                )}
                </div>
              );
            })}
          </div>
          <div className="border-t px-3 py-2 text-xs text-muted-foreground bg-muted/30 flex justify-between">
            <span>{effectiveBowlingWeeks} bowling week{effectiveBowlingWeeks !== 1 ? 's' : ''}</span>
            {computedSeasonEnd && (
              <span>Season ends {computedSeasonEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
            )}
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
