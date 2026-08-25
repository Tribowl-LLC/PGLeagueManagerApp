import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
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
import { Switch } from "@/components/ui/switch";
import type { ApiResponse, League, PaymentMode } from "@shared/schema";
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
import { apiRequest } from "@/lib/queryClient";
import {
  LEAGUE_ROLLOVER_SOURCE_CONTRACT_VERSION,
  type LeagueRolloverSourceConfirmation,
  type LeagueRolloverSourceContract,
} from "@shared/league-setup-integration";

export type NewSeasonFormValues = {
  name?: string;
  description?: string | null;
  payingLineupSize?: 3 | 4;
  locationId?: number | null;
  timezone?: string;
  practiceStartTime?: string | null;
  competitionStartTime?: string | null;
  weeklyFee?: number;
  lineageFee?: number | null;
  prizeFundFee?: number | null;
  seasonStart: string;
  totalBowlingWeeks: number;
  weekDay: (typeof WEEKDAYS)[number];
  skipDates: string[];
  cancelledDates: string[];
  doublePayDates: string[];
  allowPublicSignup: boolean;
  paymentMode: PaymentMode;
  sourceConfirmation: LeagueRolloverSourceConfirmation;
};

export function NewSeasonDialog({
  league,
  showNewSeason,
  setShowNewSeason,
  onCreate,
  isPending,
  isSystemAdmin = false,
}: {
  league: League;
  showNewSeason: boolean;
  setShowNewSeason: (v: boolean) => void;
  onCreate: (values: NewSeasonFormValues) => void;
  isPending: boolean;
  isSystemAdmin?: boolean;
}) {
  const [seasonStart, setSeasonStart] = useState("");
  const [name, setName] = useState(league.name);
  const [description, setDescription] = useState(league.description ?? "");
  const [payingLineupSize, setPayingLineupSize] = useState<3 | 4>((league.payingLineupSize === 3 ? 3 : 4));
  const [locationId, setLocationId] = useState<number | "">(league.locationId ?? "");
  const [timezone, setTimezone] = useState(league.timezone ?? "");
  const [practiceStartTime, setPracticeStartTime] = useState(league.practiceStartTime ?? "");
  const [competitionStartTime, setCompetitionStartTime] = useState(league.competitionStartTime ?? "");
  const [weeklyFee, setWeeklyFee] = useState(league.weeklyFee);
  const [lineageFee, setLineageFee] = useState<number | null>(league.lineageFee ?? null);
  const [prizeFundFee, setPrizeFundFee] = useState<number | null>(league.prizeFundFee ?? null);
  const [bowlingWeeks, setBowlingWeeks] = useState(league.totalBowlingWeeks ?? 30);
  const [weekDay, setWeekDay] = useState<(typeof WEEKDAYS)[number]>(league.weekDay);
  const [skipDates, setSkipDates] = useState<string[]>([]);
  const [cancelledDates, setCancelledDates] = useState<string[]>([]);
  const [doublePayDates, setDoublePayDates] = useState<string[]>([]);
  const [allowPublicSignup, setAllowPublicSignup] = useState(league.allowPublicSignup ?? false);
  const [paymentMode, setPaymentMode] = useState<PaymentMode | "">("");
  const [showSchedule, setShowSchedule] = useState(false);
  const sourceQuerySuffix = isSystemAdmin ? `?organizationId=${league.organizationId}` : "";
  const sourceConfirmationQuery = useQuery<ApiResponse<LeagueRolloverSourceContract>>({
    queryKey: ["league-rollover-source", league.id, sourceQuerySuffix],
    queryFn: () => apiRequest<LeagueRolloverSourceContract>(
      `/api/leagues/${league.id}/new-season/source-confirmation${sourceQuerySuffix}`,
      "GET",
    ),
    enabled: showNewSeason,
    retry: false,
  });
  const carriedSource = sourceConfirmationQuery.data?.data;

  useEffect(() => {
    const carried = carriedSource?.carriedConfiguration;
    if (!carried) return;
    setName(carried.name);
    setDescription(carried.description ?? "");
    setPayingLineupSize(carried.payingLineupSize);
    setLocationId(carried.locationId);
    setTimezone(carried.timezone);
    setPracticeStartTime(carried.practiceStartTime ?? "");
    setCompetitionStartTime(carried.competitionStartTime);
    setWeeklyFee(carried.weeklyFee);
    setLineageFee(carried.lineageFee);
    setPrizeFundFee(carried.prizeFundFee);
  }, [carriedSource]);

  const resetForm = useCallback(() => {
    setSeasonStart("");
    setName(league.name);
    setDescription(league.description ?? "");
    setPayingLineupSize(league.payingLineupSize === 3 ? 3 : 4);
    setLocationId(league.locationId ?? "");
    setTimezone(league.timezone ?? "");
    setPracticeStartTime(league.practiceStartTime ?? "");
    setCompetitionStartTime(league.competitionStartTime ?? "");
    setWeeklyFee(league.weeklyFee);
    setLineageFee(league.lineageFee ?? null);
    setPrizeFundFee(league.prizeFundFee ?? null);
    setBowlingWeeks(league.totalBowlingWeeks ?? 30);
    setWeekDay(league.weekDay);
    setSkipDates([]);
    setCancelledDates([]);
    setDoublePayDates([]);
    setAllowPublicSignup(league.allowPublicSignup ?? false);
    setPaymentMode("");
    setShowSchedule(false);
  }, [league.allowPublicSignup, league.competitionStartTime, league.description, league.lineageFee, league.locationId, league.name, league.payingLineupSize, league.practiceStartTime, league.prizeFundFee, league.timezone, league.totalBowlingWeeks, league.weekDay, league.weeklyFee]);

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
    if (!seasonStart || bowlingWeeks <= 0 || !computedSeasonEnd || paymentMode === "" || !carriedSource) return;
    const carried = carriedSource.carriedConfiguration;
    const editableOverrides: Pick<NewSeasonFormValues, "name" | "description" | "payingLineupSize" | "locationId" | "timezone" | "practiceStartTime" | "competitionStartTime" | "weeklyFee" | "lineageFee" | "prizeFundFee"> = {};
    if (name.trim() !== carried.name) editableOverrides.name = name.trim();
    if ((description.trim() || null) !== carried.description) editableOverrides.description = description.trim() || null;
    if (payingLineupSize !== carried.payingLineupSize) editableOverrides.payingLineupSize = payingLineupSize;
    if (locationId !== carried.locationId) editableOverrides.locationId = locationId === "" ? null : locationId;
    if (timezone !== carried.timezone) editableOverrides.timezone = timezone;
    if ((practiceStartTime || null) !== carried.practiceStartTime) editableOverrides.practiceStartTime = practiceStartTime || null;
    if ((competitionStartTime || null) !== carried.competitionStartTime) editableOverrides.competitionStartTime = competitionStartTime || null;
    if (weeklyFee !== carried.weeklyFee) editableOverrides.weeklyFee = weeklyFee;
    if (lineageFee !== carried.lineageFee) editableOverrides.lineageFee = lineageFee;
    if (prizeFundFee !== carried.prizeFundFee) editableOverrides.prizeFundFee = prizeFundFee;
    onCreate({
      ...editableOverrides,
      seasonStart,
      totalBowlingWeeks: bowlingWeeks,
      weekDay,
      skipDates,
      cancelledDates,
      doublePayDates,
      allowPublicSignup,
      paymentMode,
      sourceConfirmation: {
        contractVersion: LEAGUE_ROLLOVER_SOURCE_CONTRACT_VERSION,
        fingerprint: carriedSource.fingerprint,
        confirmed: true,
      },
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

          <div className="flex items-center justify-between rounded-lg border p-3">
            <div className="space-y-0.5">
              <label htmlFor="new-season-public-signup" className="text-sm font-medium">
                Allow Public Sign-up
              </label>
              <p className="text-xs text-muted-foreground">
                List this new season on the public sign-up page.
              </p>
            </div>
            <Switch
              id="new-season-public-signup"
              checked={allowPublicSignup}
              onCheckedChange={setAllowPublicSignup}
              aria-label="Allow Public Sign-up"
            />
          </div>

          <div>
            <label htmlFor="new-season-payment-mode" className="text-sm font-medium">
              League Payment Timing
            </label>
            <Select value={paymentMode} onValueChange={(value) => setPaymentMode(value as PaymentMode)}>
              <SelectTrigger id="new-season-payment-mode" className="mt-1">
                <SelectValue placeholder="Select weekly or prepaid" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="weekly">Weekly: bowlers pay each week</SelectItem>
                <SelectItem value="upfront">Full Season Upfront: full amount due at start</SelectItem>
              </SelectContent>
            </Select>
            <p className="mt-1 text-xs text-muted-foreground">
              This authoritative setting can differ from the previous season.
            </p>
          </div>

          <section className="space-y-3 rounded-lg border p-4" aria-labelledby="carried-configuration-heading">
            <div>
              <h3 id="carried-configuration-heading" className="font-medium">Prefilled league configuration</h3>
              <p className="text-xs text-muted-foreground">
                These values are carried forward as editable rollover defaults. Payment provider catalog identities are never copied.
              </p>
            </div>
            {sourceConfirmationQuery.isLoading && <p className="text-sm text-muted-foreground">Loading carried configuration…</p>}
            {sourceConfirmationQuery.isError && (
              <p className="text-sm text-destructive" role="alert">Carried configuration could not be verified. Close and retry the rollover.</p>
            )}
            {carriedSource && (
              <div className="space-y-3">
                <div>
                  <label htmlFor="new-season-name" className="text-sm font-medium">League name</label>
                  <Input id="new-season-name" value={name} onChange={(event) => setName(event.target.value)} className="mt-1" />
                </div>
                <div>
                  <label htmlFor="new-season-description" className="text-sm font-medium">Description</label>
                  <Input id="new-season-description" value={description} onChange={(event) => setDescription(event.target.value)} className="mt-1" />
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="new-season-lineup" className="text-sm font-medium">League lineup size</label>
                    <Select value={String(payingLineupSize)} onValueChange={(value) => setPayingLineupSize(Number(value) as 3 | 4)}>
                      <SelectTrigger id="new-season-lineup" className="mt-1"><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="3">Three Bowlers</SelectItem><SelectItem value="4">Four Bowlers</SelectItem></SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label htmlFor="new-season-location" className="text-sm font-medium">Location ID</label>
                    <Input id="new-season-location" type="number" min={1} value={locationId} onChange={(event) => setLocationId(event.target.value === "" ? "" : Number(event.target.value))} className="mt-1" />
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="new-season-timezone" className="text-sm font-medium">Timezone</label>
                    <Input id="new-season-timezone" value={timezone} onChange={(event) => setTimezone(event.target.value)} className="mt-1" />
                  </div>
                  <div>
                    <label htmlFor="new-season-practice" className="text-sm font-medium">Practice time</label>
                    <Input id="new-season-practice" type="time" value={practiceStartTime} onChange={(event) => setPracticeStartTime(event.target.value)} className="mt-1" />
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="new-season-competition" className="text-sm font-medium">Competition time</label>
                    <Input id="new-season-competition" type="time" value={competitionStartTime} onChange={(event) => setCompetitionStartTime(event.target.value)} className="mt-1" />
                  </div>
                  <div>
                    <label htmlFor="new-season-weekly-fee" className="text-sm font-medium">Weekly fee (cents)</label>
                    <Input id="new-season-weekly-fee" type="number" min={1} value={weeklyFee} onChange={(event) => setWeeklyFee(Number(event.target.value))} className="mt-1" />
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="new-season-lineage-fee" className="text-sm font-medium">Lineage fee (cents)</label>
                    <Input id="new-season-lineage-fee" type="number" min={0} value={lineageFee ?? ""} onChange={(event) => setLineageFee(event.target.value === "" ? null : Number(event.target.value))} className="mt-1" />
                  </div>
                  <div>
                    <label htmlFor="new-season-prize-fee" className="text-sm font-medium">Prize fund fee (cents)</label>
                    <Input id="new-season-prize-fee" type="number" min={0} value={prizeFundFee ?? ""} onChange={(event) => setPrizeFundFee(event.target.value === "" ? null : Number(event.target.value))} className="mt-1" />
                  </div>
                </div>
              </div>
            )}
          </section>

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
            allowCancelled={false}
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
            disabled={!seasonStart || bowlingWeeks <= 0 || !computedSeasonEnd || paymentMode === ""
              || !carriedSource || sourceConfirmationQuery.isLoading
              || sourceConfirmationQuery.isError || isPending}
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
