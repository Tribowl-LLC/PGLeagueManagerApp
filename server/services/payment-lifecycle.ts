import { db } from "../db";
import { eq, and } from "drizzle-orm";
import { paymentSchedules, payments, leagues, DEFAULT_TIMEZONE, type PaymentSchedule } from "@shared/schema";
import { providerNameToPaymentType } from "@shared/schema/constants";
import { addWeeks, addMonths, setHours, setMinutes, setSeconds, setMilliseconds } from "date-fns";
import { fromZonedTime, toZonedTime } from "date-fns-tz";
import { logger } from "../logger";
import { getNextLeagueDateTime } from "../utils/league-datetime.js";
import { storage } from "../storage";
import { isDateSkippedOrCancelled } from "@shared/schedule-utils";
import { executeScheduledPayment, computePaymentSplit, type ChargeResult } from "./payment-execution";
import crypto from "crypto";
import { checkPaidInFull } from "./payment-checks";
import { getUserByBowlerId } from "../storage/users";

async function safeResolvePaidByUserId(bowlerId: number): Promise<number | null> {
  try {
    const u = await getUserByBowlerId(bowlerId);
    return u?.id ?? null;
  } catch (err) {
    logger.warn(`[PaymentLifecycle] paidByUserId lookup failed for bowler ${bowlerId}: ${(err as Error).message}`);
    return null;
  }
}
import { arePartners } from "../storage/bowler-payment-links";
import { bowlers } from "@shared/schema";
import { getPaymentProvider, ProviderNotConfiguredError } from "./payment-provider-factory";

interface SchedulerCallbacks {
  schedulePayment: (record: PaymentSchedule) => void;
  cancelJob: (jobId: string) => void;
}

export async function processScheduledPaymentJob(
  scheduleRecord: PaymentSchedule,
  jobId: string,
  callbacks: SchedulerCallbacks
): Promise<void> {
  try {
    const claimed = await db
      .update(paymentSchedules)
      .set({ lastPaymentDate: new Date().toISOString() })
      .where(
        and(
          eq(paymentSchedules.id, scheduleRecord.id),
          eq(paymentSchedules.nextPaymentDate, scheduleRecord.nextPaymentDate),
          eq(paymentSchedules.active, true)
        )
      )
      .returning({ id: paymentSchedules.id });

    if (claimed.length === 0) {
      logger.warn(`[PaymentScheduler] Skipping ${jobId} — already claimed by another process or deactivated`);
      return;
    }

    logger.info(`[PaymentScheduler] Executing scheduled payment for ${jobId}`, {
      amount: scheduleRecord.amount,
      bowlerId: scheduleRecord.bowlerId,
      cardToken: `${scheduleRecord.paymentCardId?.substring(0, 10)}...`,
      executionTime: new Date().toISOString(),
      scheduledTime: scheduleRecord.nextPaymentDate
    });

    const league = await db.select().from(leagues).where(eq(leagues.id, scheduleRecord.leagueId)).then(r => r[0]);
    const leagueTz = league?.timezone ?? DEFAULT_TIMEZONE;
    const nextPaymentDateObj = new Date(scheduleRecord.nextPaymentDate);
    const firingDateLeagueLocal = league
      ? toZonedTime(nextPaymentDateObj, leagueTz)
      : nextPaymentDateObj;

    if (league && isDateSkippedOrCancelled(
      firingDateLeagueLocal,
      league.skipDates ?? [],
      league.cancelledDates ?? []
    )) {
      const nextDate = getNextLeagueDateTime(
        nextPaymentDateObj,
        league.weekDay,
        league.competitionStartTime,
        leagueTz,
        league.skipDates ?? [],
        league.cancelledDates ?? []
      );
      logger.info(`[PaymentScheduler] Skipping charge on skip/cancelled date for ${jobId}, advancing to ${nextDate.toISOString()}`);
      await storage.updatePaymentScheduleFields(scheduleRecord.id, { nextPaymentDate: nextDate.toISOString() });
      callbacks.schedulePayment({ ...scheduleRecord, nextPaymentDate: nextDate.toISOString() });
      return;
    }

    // Combined autopay: validate each partner against the same
    // accepted-link + same-org rules as canUserPayForBowler. Revoked
    // links drop silently; missing rows or thrown errors abort the
    // cycle so an admin sees the failure.
    const orgId = league?.organizationId ?? null;
    const requestedExtras = scheduleRecord.additionalBowlerIds ?? [];
    const validPartnerIds: number[] = [];
    if (requestedExtras.length > 0 && orgId != null) {
      for (const partnerBowlerId of requestedExtras) {
        let stillPartners: boolean;
        let partnerBowlerRow: typeof bowlers.$inferSelect | undefined;
        try {
          stillPartners = await arePartners(scheduleRecord.bowlerId, partnerBowlerId, orgId);
          partnerBowlerRow = await db.select().from(bowlers).where(eq(bowlers.id, partnerBowlerId)).then(r => r[0]);
        } catch (err) {
          logger.error(`[PaymentScheduler] Combined-autopay partner ${partnerBowlerId} for ${jobId} validation threw — ABORTING cycle`, {
            error: err instanceof Error ? { name: err.name, message: err.message } : err,
          });
          await handleFailedPayment(
            scheduleRecord,
            { status: 'error', error: 'Combined-autopay validation failed (transient)' },
            jobId,
          );
          return;
        }
        if (!stillPartners) {
          logger.warn(`[PaymentScheduler] Skipping combined-autopay partner ${partnerBowlerId} for ${jobId} — link no longer accepted`);
          continue;
        }
        if (!partnerBowlerRow || partnerBowlerRow.organizationId !== orgId) {
          logger.error(`[PaymentScheduler] Combined-autopay partner ${partnerBowlerId} for ${jobId} missing or cross-org — ABORTING cycle`);
          await handleFailedPayment(
            scheduleRecord,
            { status: 'error', error: `Combined-autopay partner ${partnerBowlerId} is missing or cross-org` },
            jobId,
          );
          return;
        }
        validPartnerIds.push(partnerBowlerId);
      }
    }

    const paymentResult = await executeScheduledPayment(scheduleRecord, league, jobId, validPartnerIds.length);

    if (paymentResult.status === 'success') {
      await handleSuccessfulPayment(scheduleRecord, league, paymentResult, jobId, callbacks, validPartnerIds);
    } else {
      await handleFailedPayment(scheduleRecord, paymentResult, jobId);
    }
  } catch (error) {
    logger.error(`[PaymentScheduler] Critical error processing payment for ${jobId}`, {
      error: error instanceof Error ? {
        name: error.name, message: error.message, stack: error.stack
      } : error,
      schedule: {
        id: scheduleRecord.id,
        bowlerId: scheduleRecord.bowlerId,
        amount: scheduleRecord.amount,
        cardToken: `${scheduleRecord.paymentCardId?.substring(0, 10)}...`
      },
      executionTime: new Date().toISOString()
    });
  }
}

function computeNextPaymentDate(
  scheduleRecord: PaymentSchedule,
  league: typeof leagues.$inferSelect
): Date {
  const tz = league?.timezone ?? DEFAULT_TIMEZONE;
  const currentPaymentDate = new Date(scheduleRecord.nextPaymentDate);

  if (scheduleRecord.frequency === 'weekly' && league) {
    return getNextLeagueDateTime(
      currentPaymentDate,
      league.weekDay,
      league.competitionStartTime,
      tz,
      league.skipDates ?? [],
      league.cancelledDates ?? []
    );
  }

  if (scheduleRecord.frequency === 'monthly') {
    let nextDate = addMonths(currentPaymentDate, 1);
    if (league?.competitionStartTime) {
      const [h, m] = league.competitionStartTime.split(':').map(Number);
      nextDate = setHours(setMinutes(setSeconds(setMilliseconds(nextDate, 0), 0), m), h);
      nextDate = fromZonedTime(nextDate, tz);
    }
    return nextDate;
  }

  return addWeeks(currentPaymentDate, 1);
}

async function handleSuccessfulPayment(
  scheduleRecord: PaymentSchedule,
  league: typeof leagues.$inferSelect,
  paymentResult: ChargeResult,
  jobId: string,
  callbacks: SchedulerCallbacks,
  validPartnerIds: number[] = [],
) {
  const isUpfrontLeague = league?.paymentMode === 'upfront';
  const nextDate = computeNextPaymentDate(scheduleRecord, league);

  logger.info(`[PaymentScheduler] Updating schedule ${scheduleRecord.id}`, {
    currentPaymentDate: scheduleRecord.nextPaymentDate,
    nextPaymentDate: nextDate,
    updateTime: new Date().toISOString(),
    frequency: scheduleRecord.frequency
  });

  await db.transaction(async (tx) => {
    await tx
      .update(paymentSchedules)
      .set({
        nextPaymentDate: nextDate.toISOString(),
        lastPaymentDate: scheduleRecord.nextPaymentDate,
      })
      .where(eq(paymentSchedules.id, scheduleRecord.id));

    logger.info(`[PaymentScheduler] Creating payment record for ${jobId}`, {
      paymentId: paymentResult.paymentId,
      recordTime: new Date().toISOString()
    });

    // Combined autopay writes N+1 rows sharing one provider charge and
    // groupId; billedAmount is the per-bowler share of the total charge.
    const totalCharged = paymentResult.chargedAmount ?? scheduleRecord.amount;
    const denom = 1 + validPartnerIds.length;
    const billedAmount = denom > 0 ? Math.floor(totalCharged / denom) : totalCharged;
    const { lineageAmount, prizeFundAmount } = computePaymentSplit(billedAmount, league);
    const baseNotes = paymentResult.isDoublePay
      ? 'Double-pay week (2× weekly fee)'
      : undefined;
    const isCombined = validPartnerIds.length > 0;
    const groupId = isCombined ? crypto.randomUUID() : null;
    const paidByUserId = isCombined ? await safeResolvePaidByUserId(scheduleRecord.bowlerId) : null;

    const rows: (typeof payments.$inferInsert)[] = [
      {
        bowlerId: scheduleRecord.bowlerId,
        leagueId: scheduleRecord.leagueId,
        amount: billedAmount,
        lineageAmount,
        prizeFundAmount,
        status: 'paid',
        type: providerNameToPaymentType(paymentResult.providerName || ''),
        weekOf: scheduleRecord.nextPaymentDate,
        providerPaymentId: paymentResult.paymentId,
        receiptUrl: paymentResult.receiptUrl,
        receiptNumber: paymentResult.receiptNumber,
        receiptEmailMissing:
          paymentResult.providerName === 'square'
            ? paymentResult.buyerEmailMissing ?? false
            : false,
        notes: isCombined
          ? (baseNotes ? `${baseNotes} (combined autopay self)` : 'Combined autopay (self)')
          : baseNotes,
        combinedChargeGroupId: groupId,
        paidByUserId,
      },
    ];

    for (const partnerBowlerId of validPartnerIds) {
      rows.push({
        bowlerId: partnerBowlerId,
        leagueId: scheduleRecord.leagueId,
        amount: billedAmount,
        lineageAmount,
        prizeFundAmount,
        status: 'paid',
        type: providerNameToPaymentType(paymentResult.providerName || ''),
        weekOf: scheduleRecord.nextPaymentDate,
        providerPaymentId: paymentResult.paymentId,
        receiptUrl: paymentResult.receiptUrl,
        receiptNumber: paymentResult.receiptNumber,
        receiptEmailMissing:
          paymentResult.providerName === 'square'
            ? paymentResult.buyerEmailMissing ?? false
            : false,
        notes: 'Combined autopay (paid by partner)',
        combinedChargeGroupId: groupId,
        paidByUserId,
      });
    }

    await tx.insert(payments).values(rows);

    logger.info(`[PaymentScheduler] Transaction completed for ${jobId}`, {
      completionTime: new Date().toISOString(),
      nextScheduledDate: nextDate
    });
  }).catch(async (txErr) => {
    // Compensation: the provider already charged base × (1+N) but we
    // couldn't persist the per-bowler rows. Best-effort refund so the
    // cardholder isn't billed for an unrecorded cycle, then rethrow.
    logger.error(`[PaymentScheduler] Combined-autopay row insert failed for ${jobId} — attempting refund`, {
      providerPaymentId: paymentResult.paymentId,
      partnerCount: validPartnerIds.length,
      error: txErr instanceof Error ? { name: txErr.name, message: txErr.message } : txErr,
    });
    if (paymentResult.paymentId && (paymentResult.chargedAmount ?? 0) > 0) {
      try {
        const provider = await getPaymentProvider(league?.locationId ?? null);
        await provider.refundPayment(
          paymentResult.paymentId,
          paymentResult.chargedAmount ?? scheduleRecord.amount,
          'Combined autopay row insert failed — automatic compensation',
        );
        logger.warn(`[PaymentScheduler] Combined-autopay refund issued for ${jobId}`, {
          providerPaymentId: paymentResult.paymentId,
          refundedAmount: paymentResult.chargedAmount ?? scheduleRecord.amount,
        });
      } catch (refundErr) {
        if (refundErr instanceof ProviderNotConfiguredError) {
          logger.error(`[PaymentScheduler] Combined-autopay refund SKIPPED — provider not configured for ${jobId}`, {
            providerPaymentId: paymentResult.paymentId,
          });
        } else {
          logger.error(`[PaymentScheduler] Combined-autopay refund ALSO failed for ${jobId} — manual reconciliation required`, {
            providerPaymentId: paymentResult.paymentId,
            error: refundErr instanceof Error ? { name: refundErr.name, message: refundErr.message } : refundErr,
          });
        }
      }
    }
    throw txErr;
  });

  if (isUpfrontLeague) {
    logger.info(`[PaymentScheduler] Upfront league — deactivating schedule after payment for ${jobId}`, {
      scheduleId: scheduleRecord.id,
      bowlerId: scheduleRecord.bowlerId,
      leagueId: scheduleRecord.leagueId,
    });
    await storage.deactivatePaymentSchedule(scheduleRecord.id, `paid_in_full:scheduled_job=${jobId}`);
    callbacks.cancelJob(jobId);
    return;
  }

  if (league) {
    const paidInFull = await checkPaidInFull(
      scheduleRecord,
      league,
      jobId,
      (id) => callbacks.cancelJob(id)
    );
    if (paidInFull) {
      return;
    }
  }

  logger.info(`[PaymentScheduler] Scheduling next payment for ${jobId}`, {
    nextPaymentDate: nextDate,
    schedulingTime: new Date().toISOString()
  });

  callbacks.schedulePayment({
    ...scheduleRecord,
    nextPaymentDate: nextDate.toISOString(),
  });
}

async function handleFailedPayment(
  scheduleRecord: PaymentSchedule,
  paymentResult: ChargeResult,
  jobId: string
) {
  logger.error(`[PaymentScheduler] Payment failed for ${jobId}`, {
    error: paymentResult.error,
    schedule: {
      id: scheduleRecord.id,
      bowlerId: scheduleRecord.bowlerId,
      amount: scheduleRecord.amount,
      cardToken: `${scheduleRecord.paymentCardId?.substring(0, 10)}...`
    },
    failureTime: new Date().toISOString()
  });

  await db.insert(payments).values({
    bowlerId: scheduleRecord.bowlerId,
    leagueId: scheduleRecord.leagueId,
    amount: scheduleRecord.amount,
    status: 'failed',
    type: providerNameToPaymentType(paymentResult.providerName || ''),
    weekOf: scheduleRecord.nextPaymentDate,
    notes: `Failed payment: ${paymentResult.error}`,
    paidByUserId: null,
  });
}
