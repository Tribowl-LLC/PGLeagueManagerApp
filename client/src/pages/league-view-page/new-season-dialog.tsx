import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, RefreshCw } from "lucide-react";
import type { League } from "@shared/schema";
import { WEEKDAYS } from "@shared/schema";
import type { ScheduleWeekType } from "@shared/schedule-utils";
import {
  calculateSeasonEnd,
  getAllBowlingDates,
  getEffectiveBowlingWeeks,
  toIsoDateStr,
} from "@shared/schedule-utils";
import { getSeasonLabel } from "@shared/season-utils";
import { LeagueSchedulePreview } from "@/components/league-schedule-preview";

export type NewSeasonFormValues = {
  seasonStart: string;
  totalBowlingWeeks: number;
  weekDay: (typeof WEEKDAYS)[number];
  skipDates: string[];
  cancelledDates: string[];
  doublePayDates: string[];
};

export function NewSeasonDialog({
  league,
  showNewSeason,
  setShowNewSeason,
  onCreate,
  isPending,
}: {
  league: League;
  showNewSeason: boolean;
  setShowNewSeason: (v: boolean) => void;
  onCreate: (values: NewSeasonFormValues) => void;
  isPending: boolean;
}) {
  const [seasonStart, setSeasonStart] = useState("");
  const [bowlingWeeks, setBowlingWeeks] = useState(league.totalBowlingWeeks ?? 30);
  const [weekDay, setWeekDay] = useState<(typeof WEEKDAYS)[number]>(league.weekDay);
  const [skipDates, setSkipDates] = useState<string[]>([]);
  const [cancelledDates, setCancelledDates] = useState<string[]>([]);
  const [doublePayDates, setDoublePayDates] = useState<string[]>([]);
  const [showSchedule, setShowSchedule] = useState(false);

  const resetForm = useCallback(() => {
    setSeasonStart("");
    setBowlingWeeks(league.totalBowlingWeeks ?? 30);
    setWeekDay(league.weekDay);
    setSkipDates([]);
    setCancelledDates([]);
    setDoublePayDates([]);
    setShowSchedule(false);
  }, [league.totalBowlingWeeks, league.weekDay]);

  useEffect(() => {
    if (showNewSeason) resetForm();
  }, [resetForm, showNewSeason]);

  const clearSchedule = () => {
    setSkipDates([]);
    setCancelledDates([]);
    setDoublePayDates([]);
    setShowSchedule(false);
  };

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
    return getAllBowlingDates(
      seasonStart,
      weekDay,
      bowlingWeeks,
      skipDates,
      cancelledDates,
      doublePayDates,
    );
  }, [bowlingWeeks, cancelledDates, doublePayDates, seasonStart, skipDates, weekDay]);

  const toggleDateType = (isoDate: string, currentType: ScheduleWeekType) => {
    if (currentType === "normal") {
      setSkipDates((prev) => [...prev, isoDate]);
    } else if (currentType === "skip") {
      setSkipDates((prev) => prev.filter((date) => date !== isoDate));
      setCancelledDates((prev) => [...prev, isoDate]);
    } else if (currentType === "cancelled") {
      setCancelledDates((prev) => prev.filter((date) => date !== isoDate));
      if (doublePayDates.length < 2) {
        setDoublePayDates((prev) => [...prev, isoDate]);
      }
    } else {
      setDoublePayDates((prev) => prev.filter((date) => date !== isoDate));
    }
  };

  const closeDialog = () => {
    setShowNewSeason(false);
    resetForm();
  };

  const handleCreate = () => {
    if (!seasonStart || bowlingWeeks <= 0 || !computedSeasonEnd) return;
    onCreate({
      seasonStart,
      totalBowlingWeeks: bowlingWeeks,
      weekDay,
      skipDates,
      cancelledDates,
      doublePayDates,
    });
  };

  return (
    <Dialog
      open={showNewSeason}
      onOpenChange={(open) => {
        if (!open) closeDialog();
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Start New Season</DialogTitle>
          <DialogDescription>
            Create a new season of <strong>{league.name}</strong> with the same teams and bowlers. The current season will be archived and remain accessible in the season history.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="new-season-start" className="text-sm font-medium">
                New Season Start Date
              </label>
              <Input
                id="new-season-start"
                type="date"
                value={seasonStart}
                onChange={(event) => {
                  setSeasonStart(event.target.value);
                  clearSchedule();
                }}
                className="mt-1"
              />
            </div>
            <div>
              <label htmlFor="new-season-end" className="text-sm font-medium">
                New Season End Date
              </label>
              <Input
                id="new-season-end"
                type="date"
                value={computedSeasonEnd ? toIsoDateStr(computedSeasonEnd) : ""}
                readOnly
                aria-describedby="new-season-end-help"
                className="mt-1 bg-muted/50"
              />
              <p id="new-season-end-help" className="mt-1 text-xs text-muted-foreground">
                Auto-calculated from the bowling weeks and schedule.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="new-season-weeks" className="text-sm font-medium">
                Bowling Weeks
              </label>
              <Input
                id="new-season-weeks"
                type="number"
                min={1}
                max={52}
                value={bowlingWeeks || ""}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  setBowlingWeeks(Number.isFinite(value) ? Math.min(52, Math.max(0, value)) : 0);
                  clearSchedule();
                }}
                className="mt-1"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Planned bowling weeks before cancellations.
              </p>
            </div>
            <div>
              <label htmlFor="new-season-week-day" className="text-sm font-medium">
                Bowling Day
              </label>
              <Select
                value={weekDay}
                onValueChange={(value) => {
                  setWeekDay(value as (typeof WEEKDAYS)[number]);
                  clearSchedule();
                }}
              >
                <SelectTrigger id="new-season-week-day" className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WEEKDAYS.map((day) => (
                    <SelectItem key={day} value={day}>
                      {day}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <LeagueSchedulePreview
            scheduleDates={scheduleDates}
            showSchedule={showSchedule}
            setShowSchedule={(update) => setShowSchedule(update)}
            bowlingWeeks={bowlingWeeks}
            skipDates={skipDates}
            cancelledDates={cancelledDates}
            doublePayDates={doublePayDates}
            effectiveBowlingWeeks={effectiveBowlingWeeks}
            computedSeasonEnd={computedSeasonEnd}
            toggleDateType={toggleDateType}
          />

          {seasonStart && computedSeasonEnd && (
            <p className="text-sm text-muted-foreground">
              This will create the <strong>{getSeasonLabel(seasonStart, computedSeasonEnd)}</strong>
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={closeDialog}>
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={!seasonStart || bowlingWeeks <= 0 || !computedSeasonEnd || isPending}
          >
            {isPending ? (
              <Loader2 className="mr-2 size-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 size-4" />
            )}
            Create New Season
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
