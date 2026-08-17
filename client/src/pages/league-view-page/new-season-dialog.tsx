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
import { Checkbox } from "@/components/ui/checkbox";
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
  const [bowlingWeeks, setBowlingWeeks] = useState(league.totalBowlingWeeks ?? 30);
  const [weekDay, setWeekDay] = useState<(typeof WEEKDAYS)[number]>(league.weekDay);
  const [skipDates, setSkipDates] = useState<string[]>([]);
  const [cancelledDates, setCancelledDates] = useState<string[]>([]);
  const [doublePayDates, setDoublePayDates] = useState<string[]>([]);
  const [allowPublicSignup, setAllowPublicSignup] = useState(league.allowPublicSignup ?? false);
  const [paymentMode, setPaymentMode] = useState<PaymentMode | "">("");
  const [showSchedule, setShowSchedule] = useState(false);
  const [carriedConfigurationConfirmed, setCarriedConfigurationConfirmed] = useState(false);
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

  const resetForm = useCallback(() => {
    setSeasonStart("");
    setBowlingWeeks(league.totalBowlingWeeks ?? 30);
    setWeekDay(league.weekDay);
    setSkipDates([]);
    setCancelledDates([]);
    setDoublePayDates([]);
    setAllowPublicSignup(league.allowPublicSignup ?? false);
    setPaymentMode("");
    setShowSchedule(false);
    setCarriedConfigurationConfirmed(false);
  }, [league.allowPublicSignup, league.totalBowlingWeeks, league.weekDay]);

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
    if (!seasonStart || bowlingWeeks <= 0 || !computedSeasonEnd || paymentMode === ""
      || !carriedConfigurationConfirmed || !carriedSource) return;
    onCreate({
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
              <h3 id="carried-configuration-heading" className="font-medium">Confirm carried league configuration</h3>
              <p className="text-xs text-muted-foreground">
                These stable settings are copied from the current season and cannot be edited during rollover.
              </p>
            </div>
            {sourceConfirmationQuery.isLoading && <p className="text-sm text-muted-foreground">Loading carried configuration…</p>}
            {sourceConfirmationQuery.isError && (
              <p className="text-sm text-destructive" role="alert">Carried configuration could not be verified. Close and retry the rollover.</p>
            )}
            {carriedSource && (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                <dt className="font-medium">League</dt><dd>{carriedSource.carriedConfiguration.name}</dd>
                <dt className="font-medium">Description</dt><dd>{carriedSource.carriedConfiguration.description ?? "Not set"}</dd>
                <dt className="font-medium">Location</dt><dd>Location #{carriedSource.carriedConfiguration.locationId}</dd>
                <dt className="font-medium">Timezone</dt><dd>{carriedSource.carriedConfiguration.timezone}</dd>
                <dt className="font-medium">Practice</dt><dd>{carriedSource.carriedConfiguration.practiceStartTime ?? "Not set"}</dd>
                <dt className="font-medium">Competition</dt><dd>{carriedSource.carriedConfiguration.competitionStartTime}</dd>
                <dt className="font-medium">Weekly fee</dt><dd>${(carriedSource.carriedConfiguration.weeklyFee / 100).toFixed(2)}</dd>
                <dt className="font-medium">Lineage fee</dt><dd>{carriedSource.carriedConfiguration.lineageFee == null ? "Not set" : `$${(carriedSource.carriedConfiguration.lineageFee / 100).toFixed(2)}`}</dd>
                <dt className="font-medium">Prize fund fee</dt><dd>{carriedSource.carriedConfiguration.prizeFundFee == null ? "Not set" : `$${(carriedSource.carriedConfiguration.prizeFundFee / 100).toFixed(2)}`}</dd>
              </dl>
            )}
            <div className="flex items-start gap-2">
              <Checkbox
                id="confirm-carried-configuration"
                checked={carriedConfigurationConfirmed}
                onCheckedChange={(checked) => setCarriedConfigurationConfirmed(checked === true)}
                disabled={!carriedSource || sourceConfirmationQuery.isError}
              />
              <label htmlFor="confirm-carried-configuration" className="text-sm">
                I reviewed and confirm this carried configuration. Square catalog identities will be reset for the new season.
              </label>
            </div>
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
              || !carriedConfigurationConfirmed || !carriedSource || sourceConfirmationQuery.isLoading
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
