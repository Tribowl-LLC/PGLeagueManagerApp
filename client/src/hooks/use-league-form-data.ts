import { useEffect, useRef, useState } from "react";
import { UseFormReturn } from "react-hook-form";
import { useMutation } from "@tanstack/react-query";
import { differenceInWeeks } from "date-fns";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { DEFAULT_WEEKLY_FEE_CENTS, DEFAULT_TIMEZONE } from "@shared/schema";
import type { InsertLeagueInput, InsertLeague, League, PaymentMode } from "@shared/schema";

interface UseLeagueFormDataOptions {
  open: boolean;
  league?: League;
  form: UseFormReturn<InsertLeagueInput, unknown, InsertLeague>;
  bowlingWeeks: number;
  setBowlingWeeks: (w: number) => void;
  skipDates: string[];
  setSkipDates: (dates: string[]) => void;
  cancelledDates: string[];
  setCancelledDates: (dates: string[]) => void;
  doublePayDates: string[];
  setDoublePayDates: (dates: string[]) => void;
  setShowSchedule: (v: boolean) => void;
  setShowDeleteConfirm: (v: boolean) => void;
  setSelectedCategoryId: (id: string | null) => void;
  computedSeasonEnd: Date | null;
  onClose: () => void;
}

export function useLeagueFormData({
  open,
  league,
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
}: UseLeagueFormDataOptions) {
  const { toast } = useToast();
  const isResettingForm = useRef(false);

  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const nextYear = new Date();
  nextYear.setFullYear(today.getFullYear() + 1);
  nextYear.setHours(12, 0, 0, 0);

  const watchedStart = form.watch('seasonStart');

  useEffect(() => {
    if (isResettingForm.current) return;
    if (watchedStart) {
      const date = new Date(watchedStart);
      if (!isNaN(date.getTime())) {
        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        form.setValue('weekDay', dayNames[date.getDay()] as "Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday" | "Saturday" | "Sunday");
      }
    }
  }, [watchedStart]);

  useEffect(() => {
    if (open && league) {
      const startDate = new Date(league.seasonStart);
      startDate.setHours(12, 0, 0, 0);
      const endDate = new Date(league.seasonEnd);
      endDate.setHours(12, 0, 0, 0);

      const initialWeeks = league.totalBowlingWeeks
        ?? Math.max(1, differenceInWeeks(endDate, startDate));
      setBowlingWeeks(initialWeeks);
      setSkipDates(league.skipDates ?? []);
      setCancelledDates(league.cancelledDates ?? []);
      setDoublePayDates(league.doublePayDates ?? []);
      setShowSchedule(false);
      setSelectedCategoryId(league.squareCategoryId || null);

      isResettingForm.current = true;
      form.reset({
        name: league.name,
        description: league.description || "",
        active: league.active,
        allowPublicSignup: league.allowPublicSignup ?? false,
        seasonStart: startDate.toISOString(),
        seasonEnd: endDate.toISOString(),
        weekDay: league.weekDay || "Monday",
        practiceStartTime: league.practiceStartTime || "",
        competitionStartTime: league.competitionStartTime || "",
        timezone: league.timezone || DEFAULT_TIMEZONE,
        weeklyFee: league.weeklyFee || DEFAULT_WEEKLY_FEE_CENTS,
        lineageFee: league.lineageFee ?? null,
        prizeFundFee: league.prizeFundFee ?? null,
        paymentMode: (league.paymentMode as PaymentMode) || "weekly",
        squareLineageItemId: league.squareLineageItemId || null,
        lineageItemVariationId: league.lineageItemVariationId || null,
        squareLineageItemName: league.squareLineageItemName || null,
        squarePrizeFundItemId: league.squarePrizeFundItemId || null,
        prizeFundItemVariationId: league.prizeFundItemVariationId || null,
        squarePrizeFundItemName: league.squarePrizeFundItemName || null,
        squareCategoryId: league.squareCategoryId || null,
        locationId: league.locationId || null,
        totalBowlingWeeks: initialWeeks,
        skipDates: league.skipDates ?? [],
        cancelledDates: league.cancelledDates ?? [],
        doublePayDates: league.doublePayDates ?? [],
      });
      setTimeout(() => { isResettingForm.current = false; }, 0);
    } else if (!open) {
      isResettingForm.current = true;
      form.reset({
        name: "",
        description: "",
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
        paymentMode: "weekly",
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
      });
      setTimeout(() => { isResettingForm.current = false; }, 0);
      setBowlingWeeks(30);
      setSkipDates([]);
      setCancelledDates([]);
      setDoublePayDates([]);
      setShowSchedule(false);
      setShowDeleteConfirm(false);
      setSelectedCategoryId(null);
    }
  }, [open, league, form]);

  const mutation = useMutation({
    mutationFn: async (data: InsertLeague) => {
      const derivedEnd = computedSeasonEnd ?? data.seasonEnd;
      return apiRequest(
        league ? `/api/leagues/${league.id}` : "/api/leagues",
        league ? "PATCH" : "POST",
        {
          ...data,
          seasonStart: data.seasonStart,
          seasonEnd: derivedEnd instanceof Date ? derivedEnd.toISOString() : derivedEnd,
          totalBowlingWeeks: bowlingWeeks,
          skipDates,
          cancelledDates,
          doublePayDates,
        }
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/leagues"] });
      toast({
        title: league ? "League updated" : "League created",
        description: league
          ? "League has been updated successfully."
          : "League has been created successfully.",
      });
      onClose();
      form.reset();
    },
    onError: (error: Error) => {
      toast({
        title: league ? "Error updating league" : "Error creating league",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (!league) return;
      return apiRequest(`/api/leagues/${league.id}`, "DELETE");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/leagues"] });
      toast({
        title: "League deleted",
        description: "The league has been removed from the system.",
      });
      onClose();
    },
    onError: (error: Error) => {
      toast({
        title: "Error deleting league",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  return { mutation, deleteMutation };
}
