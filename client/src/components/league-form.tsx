import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
import { useToast } from "@/hooks/use-toast";
import { insertLeagueSchema, type InsertLeagueInput, type InsertLeague, type League, type Location, DEFAULT_WEEKLY_FEE_CENTS, DEFAULT_TIMEZONE } from "@shared/schema";
import type { ScheduleWeekType } from "@shared/schedule-utils";
import { calculateSeasonEnd, getAllBowlingDates, getEffectiveBowlingWeeks } from "@shared/schedule-utils";
import { LeagueSchedulePreview } from "@/components/league-schedule-preview";
import { Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Separator } from "@/components/ui/separator";
import { LeagueBasicInfo } from "@/components/league-form-basic-info";
import { LeagueScheduleSection } from "@/components/league-form-schedule";
import { LeagueTimingSection } from "@/components/league-form-timing";
import { LeagueFeeSection } from "@/components/league-form-fees";
import { useLeagueFormData } from "@/hooks/use-league-form-data";

interface LeagueFormProps {
  open: boolean;
  onClose: () => void;
  league?: League;
  systemAdminOrganizationId?: number | null;
}

export function LeagueForm({ open, onClose, league, systemAdminOrganizationId }: LeagueFormProps) {
  const { toast } = useToast();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [bowlingWeeks, setBowlingWeeks] = useState<number>(30);
  const [skipDates, setSkipDates] = useState<string[]>([]);
  const [cancelledDates, setCancelledDates] = useState<string[]>([]);
  const [doublePayDates, setDoublePayDates] = useState<string[]>([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);

  const { data: locationsData } = useQuery<{ success: boolean; data: Location[] }>({
    queryKey: ['/api/locations'],
  });
  const activeLocations = (locationsData?.data || []).filter(l => l.active);

  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const nextYear = new Date();
  nextYear.setFullYear(today.getFullYear() + 1);
  nextYear.setHours(12, 0, 0, 0);

  const form = useForm<InsertLeagueInput, unknown, InsertLeague>({
    resolver: zodResolver(insertLeagueSchema),
    defaultValues: {
      name: "",
      description: "",
      payingLineupSize: undefined,
      substituteAccess: "team_only",
      substitutePaymentRegime: "team_choice",
      active: true,
      allowPublicSignup: false,
      seasonStart: today.toISOString(),
      seasonEnd: nextYear.toISOString(),
      weekDay: "Monday",
      practiceStartTime: "",
      competitionStartTime: "",
      timezone: DEFAULT_TIMEZONE,
      weeklyFee: DEFAULT_WEEKLY_FEE_CENTS,
      lineageFee: null,
      prizeFundFee: null,
      paymentMode: undefined,
      squareLineageItemId: null,
      lineageItemVariationId: null,
      squareLineageItemName: null,
      squarePrizeFundItemId: null,
      prizeFundItemVariationId: null,
      squarePrizeFundItemName: null,
      squareCategoryId: null,
      locationId: null,
      totalBowlingWeeks: 30,
      skipDates: [],
      cancelledDates: [],
      doublePayDates: [],
    },
  });

  const watchedStart = form.watch('seasonStart');
  const watchedWeekDay = form.watch('weekDay');
  const watchedPaymentMode = form.watch('paymentMode');
  const isUpfront = watchedPaymentMode === 'upfront';
  const watchedWeeklyFee = form.watch('weeklyFee');
  const watchedLocationId = form.watch('locationId');

  const computedSeasonEnd = useMemo(() => {
    if (!watchedStart || !watchedWeekDay || bowlingWeeks <= 0) return null;
    return calculateSeasonEnd(watchedStart, watchedWeekDay, bowlingWeeks, skipDates, cancelledDates);
  }, [watchedStart, watchedWeekDay, bowlingWeeks, skipDates, cancelledDates]);

  const effectiveBowlingWeeks = useMemo(
    () => getEffectiveBowlingWeeks(bowlingWeeks, cancelledDates),
    [bowlingWeeks, cancelledDates]
  );

  const scheduleDates = useMemo(() => {
    if (!watchedStart || !watchedWeekDay || bowlingWeeks <= 0) return [];
    return getAllBowlingDates(watchedStart, watchedWeekDay, bowlingWeeks, skipDates, cancelledDates, doublePayDates);
  }, [watchedStart, watchedWeekDay, bowlingWeeks, skipDates, cancelledDates, doublePayDates]);

  // `seasonEnd` is fully derived from the schedule inputs via
  // `computedSeasonEnd` (above) and is applied directly at submit time
  // (`computedSeasonEnd ?? data.seasonEnd` in useLeagueFormData) and
  // displayed via the `computedSeasonEnd` prop on the schedule
  // sections. No effect mirrors it back into the form: the registered
  // `seasonEnd` field only carries the reset baseline, which the schema
  // refinement (`seasonEnd > seasonStart`) always accepts, so validation
  // and submission are unchanged.

  const { mutation, deleteMutation } = useLeagueFormData({
    open,
    league,
    systemAdminOrganizationId,
    form,
    bowlingWeeks,
    setBowlingWeeks,
    skipDates,
    setSkipDates,
    cancelledDates,
    setCancelledDates,
    doublePayDates,
    setDoublePayDates,
    setShowSchedule,
    setShowDeleteConfirm,
    setSelectedCategoryId,
    computedSeasonEnd,
    onClose,
  });

  // Existing-season edits retain the legacy cancellation control. New
  // league creation is deliberately limited to Bowling / No Bowling / the
  // independent double-pay marker.
  const toggleDateType = (isoDate: string, currentType: ScheduleWeekType) => {
    if (currentType === 'normal') {
      setSkipDates(prev => [...prev, isoDate]);
    } else if (currentType === 'skip' && league) {
      setSkipDates(prev => prev.filter(d => d !== isoDate));
      setCancelledDates(prev => [...prev, isoDate]);
    } else if (currentType === 'skip') {
      setSkipDates(prev => prev.filter(d => d !== isoDate));
      if (doublePayDates.length < 2) {
        setDoublePayDates(prev => [...prev, isoDate]);
      }
    } else if (currentType === 'cancelled') {
      setCancelledDates(prev => prev.filter(d => d !== isoDate));
      if (doublePayDates.length < 2) {
        setDoublePayDates(prev => [...prev, isoDate]);
      }
      // else: cap full — week returns to Normal, double-pay step skipped.
    } else {
      setDoublePayDates(prev => prev.filter(d => d !== isoDate));
    }
  };

  const handleLocationChange = (_value: string) => {
    setSelectedCategoryId(null);
    form.setValue('squareCategoryId', null);
    form.setValue('squareLineageItemId', null);
    form.setValue('lineageItemVariationId', null);
    form.setValue('squareLineageItemName', null);
    form.setValue('squarePrizeFundItemId', null);
    form.setValue('prizeFundItemVariationId', null);
    form.setValue('squarePrizeFundItemName', null);
    form.setValue('lineageFee', null);
    form.setValue('prizeFundFee', null);
  };

  const handleSeasonStartChange = () => {
    setSkipDates([]);
    setCancelledDates([]);
    setDoublePayDates([]);
  };

  const handleBowlingWeeksChange = (w: number) => {
    setBowlingWeeks(w);
    setSkipDates([]);
    setCancelledDates([]);
    setDoublePayDates([]);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onClose}>
        <DialogContent className="max-h-[90vh] flex flex-col p-0 gap-0">
          <DialogHeader className="px-6 pt-6 pb-4 shrink-0">
            <DialogTitle>{league ? "Edit League" : "Add New League"}</DialogTitle>
          </DialogHeader>

          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(
                (data) => mutation.mutate(data),
                (errors) => {
                  const messages = Object.entries(errors).flatMap(([field, err]) => {
                    const msg = (err as { message?: string })?.message;
                    const value = msg ? `${field}: ${msg}` : field;
                    return value ? [value] : [];
                  });
                  toast({
                    title: "Please fix the highlighted fields",
                    description: messages.length > 0
                      ? messages.join("; ")
                      : "Some required fields are missing or invalid.",
                    variant: "destructive",
                  });
                }
              )}
              className="flex flex-col min-h-0 flex-1"
            >
              <div className="space-y-4 px-6 pb-4 overflow-y-auto flex-1 min-h-0">
                <LeagueBasicInfo
                  form={form}
                  activeLocations={activeLocations}
                  onLocationChange={handleLocationChange}
                />

                <LeagueScheduleSection
                  form={form}
                  bowlingWeeks={bowlingWeeks}
                  computedSeasonEnd={computedSeasonEnd}
                  onSeasonStartChange={handleSeasonStartChange}
                  onBowlingWeeksChange={handleBowlingWeeksChange}
                />

                <LeagueSchedulePreview
                  scheduleDates={scheduleDates}
                  showSchedule={showSchedule}
                  setShowSchedule={setShowSchedule}
                  bowlingWeeks={bowlingWeeks}
                  skipDates={skipDates}
                  cancelledDates={cancelledDates}
                  doublePayDates={doublePayDates}
                  effectiveBowlingWeeks={effectiveBowlingWeeks}
                  computedSeasonEnd={computedSeasonEnd}
                  toggleDateType={toggleDateType}
                  allowCancelled={Boolean(league)}
                />

                <LeagueTimingSection form={form} />

                <LeagueFeeSection
                  form={form}
                  isUpfront={isUpfront}
                  effectiveBowlingWeeks={effectiveBowlingWeeks}
                  activeLocations={activeLocations}
                  watchedLocationId={watchedLocationId}
                  watchedWeeklyFee={watchedWeeklyFee ?? DEFAULT_WEEKLY_FEE_CENTS}
                  selectedCategoryId={selectedCategoryId}
                  onCategoryChange={setSelectedCategoryId}
                />
              </div>

              <div className="shrink-0 bg-background px-6 pt-4 pb-6 border-t">
                <div className="flex justify-end gap-x-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={onClose}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={mutation.isPending}>
                    {mutation.isPending && (
                      <Loader2 className="mr-2 size-4 animate-spin" />
                    )}
                    {league ? "Update" : "Add"} League
                  </Button>
                </div>

                {league && (
                  <>
                    <Separator className="my-4" />
                    <div className="flex justify-center">
                      <Button
                        type="button"
                        variant="destructive"
                        onClick={() => setShowDeleteConfirm(true)}
                        disabled={deleteMutation.isPending}
                      >
                        {deleteMutation.isPending && (
                          <Loader2 className="mr-2 size-4 animate-spin" />
                        )}
                        Delete League
                      </Button>
                    </div>
                  </>
                )}
              </div>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure you want to delete this league?</AlertDialogTitle>
            <AlertDialogDescription>
              This will delete the league "{league?.name}" and all associated teams.
              Bowlers will be unassigned from their teams, but their records and payment history will be preserved.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setShowDeleteConfirm(false)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setShowDeleteConfirm(false);
                deleteMutation.mutate();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete League
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
