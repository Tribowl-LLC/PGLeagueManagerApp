import { leagues, type PaymentSchedule } from "@shared/schema";
import { differenceInWeeks } from "date-fns";
import { logger } from "../logger";
import { storage } from "../storage";
import { getEffectiveBowlingWeeks } from "@shared/schedule-utils";
import { getTotalPaidInSeason } from "./payment-execution";

// Task #646: the legacy `checkAndChargeFinalTwoWeeks` lump-charge
// helper was deleted along with the "Final 2 Weeks Due By" feature.
// New behavior: the autopay scheduler doubles the regular weekly
// charge on each league `doublePayDates` entry (see
// `payment-execution.ts::executeScheduledPayment`). The legacy
// `final_two_weeks_due_week` field is retained in the schema only so
// production data is not dropped; nothing in the payment pipeline reads
// or writes it.

export async function checkPaidInFull(
  scheduleRecord: PaymentSchedule,
  league: typeof leagues.$inferSelect,
  jobId: string,
  cancelJobCallback: (jobId: string) => void
): Promise<boolean> {
  try {
    const seasonStart = new Date(league.seasonStart);
    const seasonEnd = new Date(league.seasonEnd);
    let totalWeeks: number;
    if (league.totalBowlingWeeks != null) {
      totalWeeks = getEffectiveBowlingWeeks(
        league.totalBowlingWeeks,
        league.cancelledDates ?? []
      );
    } else {
      totalWeeks = Math.max(0, differenceInWeeks(seasonEnd, seasonStart));
    }
    // Double-pay redistribution model: a league with N double-pay
    // dates bills 2× on those dates and bills $0 on the last N regular
    // bowling weeks. The season total stays at `weeklyFee × totalWeeks`
    // regardless of double-pay count — double-pay weeks shift dollars
    // forward in the schedule, they do not add to the season total.
    // The natural billing pattern reaches exactly this amount, so the
    // schedule deactivates on the right week.
    const fullSeasonAmount = league.weeklyFee * totalWeeks;

    if (fullSeasonAmount <= 0) return false;

    const totalPaid = await getTotalPaidInSeason(
      scheduleRecord.bowlerId,
      scheduleRecord.leagueId,
      seasonStart,
      seasonEnd
    );

    if (totalPaid >= fullSeasonAmount) {
      logger.info(`[PaymentScheduler] Bowler paid in full, deactivating schedule for ${jobId}`, {
        totalPaid,
        fullSeasonAmount,
        scheduleId: scheduleRecord.id,
        bowlerId: scheduleRecord.bowlerId,
        leagueId: scheduleRecord.leagueId,
      });

      await storage.deactivatePaymentSchedule(scheduleRecord.id, `paid_in_full:scheduled_job=${jobId}`);
      cancelJobCallback(`payment-${scheduleRecord.id}`);
      return true;
    }

    return false;
  } catch (error) {
    logger.error(`[PaymentScheduler] Error checking paid-in-full for ${jobId}`, {
      error: error instanceof Error ? error.message : error,
    });
    return false;
  }
}
