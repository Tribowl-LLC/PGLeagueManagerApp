import { Router } from 'express';
import { storage } from '../storage';
import { insertPaymentScheduleSchema, DEFAULT_TIMEZONE } from '@shared/schema';
import { sendSuccess, sendError, handleZodError } from '../utils/api.js';
import { singleRouteParam } from '../utils/route-params';
import { hasAccessToLeague, hasSelfOrAdminAccessToBowler } from '../utils/access-control.js';
import { paymentScheduler } from '../services/payment-scheduler.js';
import { addMonths, setHours, setMinutes, setSeconds, setMilliseconds } from 'date-fns';
import { fromZonedTime } from 'date-fns-tz';
import { adminWriteLimiter } from '../middleware/rate-limit.js';
import { getNextLeagueDateTime } from '../utils/league-datetime.js';
import { getEffectiveBowlingWeeks } from '@shared/schedule-utils';
import { createLogger } from '../logger';
import { isTestKickSuppressed, PAYMENT_SCHEDULER_KICK_HEADER } from '../utils/test-suppression';
import { getAcceptedPartnerBowlerIds } from '../storage/bowler-payment-links';
import {
  AutopaySetupError,
  getWeeklyAutopaySetupQuote,
  setupWeeklyAutopay,
} from '../services/autopay-setup.js';

/**
 * validate `additionalBowlerIds` (combined autopay).
 * - de-duplicates and removes self
 * - rejects ids that aren't accepted-linked partners of the payer in the org
 * - rejects ids whose bowler row is in a different org or org-less
 * Returns sanitized list (may be empty) or an error message.
 */
async function validateAdditionalBowlerIds(
  payerBowlerId: number,
  organizationId: number,
  raw: unknown,
): Promise<{ ok: true; ids: number[] } | { ok: false; message: string }> {
  if (raw === undefined || raw === null) return { ok: true, ids: [] };
  if (!Array.isArray(raw)) return { ok: false, message: 'additionalBowlerIds must be an array' };
  const cleaned = Array.from(
    new Set(
      raw
        .map((v) => Number(v))
        .filter((n) => Number.isInteger(n) && n > 0 && n !== payerBowlerId),
    ),
  );
  if (cleaned.length === 0) return { ok: true, ids: [] };
  const partners = new Set(await getAcceptedPartnerBowlerIds(payerBowlerId, organizationId));
  for (const id of cleaned) {
    if (partners.has(id)) continue;
    return { ok: false, message: `Bowler ${id} is not an accepted payment partner` };
  }
  return { ok: true, ids: cleaned };
}

const log = createLogger("PaymentSchedules");

const router = Router();

async function rejectRosterConfiguredAutopay(res: Parameters<typeof sendError>[0], leagueId: number): Promise<boolean> {
  const league = await storage.getLeague(leagueId);
  if (league?.payingLineupSize !== null && league?.payingLineupSize !== undefined) {
    sendError(res, 'Legacy autopay schedules are retired for roster-configured leagues; pay exact obligations instead', 410, 'ROSTER_AUTOPAY_RETIRED');
    return true;
  }
  return false;
}

router.use((req, res, next) => {
  if ((req.user?.role as string | undefined) === 'payment_manager') {
    return sendError(res, 'Payment managers cannot access autopay schedules', 403, 'FORBIDDEN');
  }
  // Schedules remain an archive only after the roster cutover.  Keeping the
  // route mounted lets old clients receive an explicit, non-retrying response
  // while preventing any new legacy payer authority from being created.
  if (req.method !== 'GET' || req.path.startsWith('/setup-quote')) {
    return sendError(res, 'Legacy autopay schedules are retired; use standing roster consent and exact obligations', 410, 'LEGACY_AUTOPAY_RETIRED');
  }
  next();
});

function handleAutopaySetupError(res: Parameters<typeof sendError>[0], error: unknown) {
  if (error instanceof AutopaySetupError) {
    return sendError(res, error.message, error.statusCode, error.code);
  }
  throw error;
}

router.get('/setup-quote/:bowlerId/:leagueId', async (req, res) => {
  try {
    if (!req.isAuthenticated()) {
      return sendError(res, 'Authentication required', 401, 'AUTH_REQUIRED');
    }
    const bowlerId = Number(singleRouteParam(req.params.bowlerId));
    const leagueId = Number(singleRouteParam(req.params.leagueId));
    if (!Number.isSafeInteger(bowlerId) || bowlerId <= 0 || !Number.isSafeInteger(leagueId) || leagueId <= 0) {
      return sendError(res, 'Invalid bowler or league ID', 400, 'INVALID_ID');
    }
    if (!await hasAccessToLeague(req, leagueId)) {
      return sendError(res, "You don't have access to this league", 403, 'FORBIDDEN');
    }
    if (!await hasSelfOrAdminAccessToBowler(req, bowlerId)) {
      return sendError(res, "You don't have access to this bowler", 403, 'FORBIDDEN');
    }
    if (await rejectRosterConfiguredAutopay(res, leagueId)) return;
    const rawAdditional = typeof req.query.additionalBowlerIds === 'string'
      ? req.query.additionalBowlerIds.split(',').filter(Boolean).map(Number)
      : [];
    if (rawAdditional.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
      return sendError(res, 'Invalid linked bowler IDs', 400, 'INVALID_PARTNER');
    }
    const quote = await getWeeklyAutopaySetupQuote({
      payerBowlerId: bowlerId,
      leagueId,
      additionalBowlerIds: rawAdditional,
    });
    return sendSuccess(res, quote);
  } catch (error) {
    try {
      return handleAutopaySetupError(res, error);
    } catch (unexpected) {
      log.error('Error quoting weekly auto-pay setup:', unexpected);
      return sendError(res, 'Internal server error', 500, 'SERVER_ERROR');
    }
  }
});

router.post('/setup', adminWriteLimiter, async (req, res) => {
  try {
    if (!req.isAuthenticated()) {
      return sendError(res, 'Authentication required', 401, 'AUTH_REQUIRED');
    }
    const bowlerId = Number(req.body.bowlerId);
    const leagueId = Number(req.body.leagueId);
    if (!Number.isSafeInteger(bowlerId) || bowlerId <= 0 || !Number.isSafeInteger(leagueId) || leagueId <= 0) {
      return sendError(res, 'Invalid bowler or league ID', 400, 'INVALID_ID');
    }
    if (!await hasAccessToLeague(req, leagueId)) {
      return sendError(res, "You don't have access to this league", 403, 'FORBIDDEN');
    }
    if (!await hasSelfOrAdminAccessToBowler(req, bowlerId)) {
      return sendError(res, "You don't have access to this bowler", 403, 'FORBIDDEN');
    }
    if (await rejectRosterConfiguredAutopay(res, leagueId)) return;
    if (typeof req.body.sourceId !== 'string' || req.body.sourceId.length === 0) {
      return sendError(res, 'A saved payment card is required', 400, 'INVALID_PAYMENT_SOURCE');
    }
    if (typeof req.body.quoteFingerprint !== 'string') {
      return sendError(res, 'An auto-pay quote is required', 400, 'QUOTE_REQUIRED');
    }
    const additionalBowlerIds = req.body.additionalBowlerIds == null
      ? []
      : req.body.additionalBowlerIds;
    if (!Array.isArray(additionalBowlerIds)) {
      return sendError(res, 'additionalBowlerIds must be an array', 400, 'INVALID_PARTNER');
    }
    const result = await setupWeeklyAutopay({
      payerBowlerId: bowlerId,
      leagueId,
      additionalBowlerIds,
      quoteFingerprint: req.body.quoteFingerprint,
      sourceId: req.body.sourceId,
      buyerEmail: typeof req.body.buyerEmail === 'string' ? req.body.buyerEmail : undefined,
    });
    if (result.schedule && !isTestKickSuppressed(req, PAYMENT_SCHEDULER_KICK_HEADER)) {
      const league = await storage.getLeague(leagueId);
      await paymentScheduler.addSchedule(result.schedule, league?.organizationId ?? undefined);
    }
    return sendSuccess(res, {
      setupRequestId: result.request.id,
      immediateAmountMinor: result.quote.immediateAmountMinor,
      coveredOccurrences: result.quote.coveredOccurrences,
      firstAutomaticAt: result.quote.firstAutomaticAt,
      firstAutomaticAmountMinor: result.quote.firstAutomaticAmountMinor,
      recurringAmountMinor: result.quote.recurringAmountMinor,
      schedule: result.schedule,
    }, 201);
  } catch (error) {
    try {
      return handleAutopaySetupError(res, error);
    } catch (unexpected) {
      log.error('Error setting up weekly auto-pay:', unexpected);
      return sendError(res, 'Internal server error', 500, 'SERVER_ERROR');
    }
  }
});

router.post('/', adminWriteLimiter, async (req, res) => {
  try {
    if (!req.isAuthenticated()) {
      return sendError(res, 'Authentication required', 401, 'AUTH_REQUIRED');
    }

    if (!await hasAccessToLeague(req, req.body.leagueId)) {
      return sendError(res, "You don't have access to this league", 403, 'FORBIDDEN');
    }
    if (await rejectRosterConfiguredAutopay(res, Number(req.body.leagueId))) return;

    // Sensitive write: creating a schedule requires self-access or admin role (task #732).
    if (!await hasSelfOrAdminAccessToBowler(req, req.body.bowlerId)) {
      return sendError(res, "You don't have access to this bowler", 403, 'FORBIDDEN');
    }

    const existing = await storage.getPaymentSchedule(req.body.bowlerId, req.body.leagueId);
    if (existing) {
      return sendError(res, 'An active payment schedule already exists for this bowler and league', 400, 'SCHEDULE_EXISTS');
    }

    const league = await storage.getLeague(req.body.leagueId);
    if (!league) {
      return sendError(res, 'League not found', 404, 'LEAGUE_NOT_FOUND');
    }

    const isUpfrontLeague = league.paymentMode === 'upfront';
    const isUpfrontFrequency = req.body.frequency === 'upfront';

    // Enforce invariants for upfront leagues:
    // - frequency must be 'upfront'
    // - amount must equal the full season amount
    if (isUpfrontLeague) {
      if (!isUpfrontFrequency) {
        return sendError(res, 'Upfront leagues require frequency "upfront"', 400, 'INVALID_FREQUENCY');
      }
      const totalWeeks = league.totalBowlingWeeks != null
        ? getEffectiveBowlingWeeks(league.totalBowlingWeeks, league.cancelledDates ?? [])
        : Math.max(0, Math.round(
            (new Date(league.seasonEnd).getTime() - new Date(league.seasonStart).getTime()) /
            (7 * 24 * 60 * 60 * 1000)
          ));
      const fullSeasonAmount = league.weeklyFee * totalWeeks;
      if (req.body.amount !== fullSeasonAmount) {
        return sendError(res, `Upfront leagues require full season amount (${fullSeasonAmount} cents)`, 400, 'INVALID_AMOUNT');
      }
    } else if (isUpfrontFrequency) {
      return sendError(res, 'Frequency "upfront" is only valid for upfront-mode leagues', 400, 'INVALID_FREQUENCY');
    } else {
      return sendError(
        res,
        'Weekly auto-pay must be created through the server-authoritative setup flow',
        409,
        'AUTOPAY_SETUP_REQUIRED',
      );
    }

    // Upfront schedules charge immediately; all others fire on the next league night.
    const nextPaymentDate = isUpfrontFrequency
      ? new Date()
      : getNextLeagueDateTime(
          new Date(),
          league.weekDay,
          league.competitionStartTime,
          league.timezone ?? DEFAULT_TIMEZONE,
          league.skipDates ?? [],
          league.cancelledDates ?? []
        );

    let cleanedAdditional: number[] = [];
    if (req.body.additionalBowlerIds !== undefined && req.body.additionalBowlerIds !== null) {
      if (!league.organizationId) {
        return sendError(res, 'Combined autopay requires an org-stamped league', 400, 'ORG_REQUIRED');
      }
      const v = await validateAdditionalBowlerIds(
        req.body.bowlerId,
        league.organizationId,
        req.body.additionalBowlerIds,
      );
      if (!v.ok) return sendError(res, v.message, 400, 'INVALID_PARTNER');
      cleanedAdditional = v.ids;
    }

    const validationResult = insertPaymentScheduleSchema.safeParse({
      ...req.body,
      nextPaymentDate,
      additionalBowlerIds: cleanedAdditional.length > 0 ? cleanedAdditional : null,
    });

    if (!validationResult.success) {
      return handleZodError(res, validationResult.error);
    }

    const schedule = await storage.createPaymentSchedule(validationResult.data);

    if (!isTestKickSuppressed(req, PAYMENT_SCHEDULER_KICK_HEADER)) {
      await paymentScheduler.addSchedule(schedule, league.organizationId);
    }

    return sendSuccess(res, schedule, 201);
  } catch (error) {
    log.error('Error creating schedule:', error);
    return sendError(res, 'Internal server error', 500, 'SERVER_ERROR');
  }
});

router.get('/:bowlerId/:leagueId', async (req, res) => {
  try {
    if (!req.isAuthenticated()) {
      return sendError(res, 'Authentication required', 401, 'AUTH_REQUIRED');
    }

    const bowlerId = parseInt(singleRouteParam(req.params.bowlerId), 10);
    const leagueId = parseInt(singleRouteParam(req.params.leagueId), 10);

    if (isNaN(bowlerId) || isNaN(leagueId)) {
      return sendError(res, 'Invalid bowler or league ID', 400, 'INVALID_ID');
    }
    // Sensitive read (autopay schedule): requires self-access or admin role (task #732).
    if (!await hasAccessToLeague(req, leagueId)) {
      return sendError(res, "You don't have access to this league", 403, 'FORBIDDEN');
    }
    if (!await hasSelfOrAdminAccessToBowler(req, bowlerId)) {
      return sendError(res, "You don't have access to this bowler", 403, 'FORBIDDEN');
    }
    if (await rejectRosterConfiguredAutopay(res, leagueId)) return;

    const schedule = await storage.getPaymentSchedule(bowlerId, leagueId);
    if (!schedule) {
      return sendSuccess(res, null);
    }
    const league = await storage.getLeague(leagueId);
    const normalizedNextPaymentDate = schedule.nextPaymentDate.endsWith('Z')
      ? schedule.nextPaymentDate
      : new Date(schedule.nextPaymentDate + 'Z').toISOString();
    return sendSuccess(res, {
      ...schedule,
      nextPaymentDate: normalizedNextPaymentDate,
      leagueTimezone: league?.timezone ?? DEFAULT_TIMEZONE,
    });
  } catch (error) {
    log.error('Error fetching schedule:', error);
    return sendError(res, 'Internal server error', 500, 'SERVER_ERROR');
  }
});

router.delete('/:id', adminWriteLimiter, async (req, res) => {
  try {
    if (!req.isAuthenticated()) {
      return sendError(res, 'Authentication required', 401, 'AUTH_REQUIRED');
    }

    const id = parseInt(singleRouteParam(req.params.id), 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid schedule ID', 400, 'INVALID_ID');
    }

    const schedule = await storage.getPaymentScheduleById(id);
    if (!schedule) {
      return sendError(res, 'Payment schedule not found', 404, 'NOT_FOUND');
    }
    // Sensitive write: requires self-access or admin role (task #732).
    if (!await hasAccessToLeague(req, schedule.leagueId)) {
      return sendError(res, "You don't have access to this league", 403, 'FORBIDDEN');
    }
    if (!await hasSelfOrAdminAccessToBowler(req, schedule.bowlerId)) {
      return sendError(res, "You don't have access to this schedule", 403, 'FORBIDDEN');
    }
    if (await rejectRosterConfiguredAutopay(res, schedule.leagueId)) return;

    await storage.deactivatePaymentSchedule(id, "manual");
    if (!isTestKickSuppressed(req, PAYMENT_SCHEDULER_KICK_HEADER)) {
      await paymentScheduler.removeSchedule(id);
    }

    return sendSuccess(res, { message: 'Payment schedule cancelled' });
  } catch (error) {
    log.error('Error cancelling schedule:', error);
    return sendError(res, 'Internal server error', 500, 'SERVER_ERROR');
  }
});

router.patch('/:id', adminWriteLimiter, async (req, res) => {
  try {
    if (!req.isAuthenticated()) {
      return sendError(res, 'Authentication required', 401, 'AUTH_REQUIRED');
    }

    const id = parseInt(singleRouteParam(req.params.id), 10);
    if (isNaN(id)) {
      return sendError(res, 'Invalid schedule ID', 400, 'INVALID_ID');
    }

    const schedule = await storage.getPaymentScheduleById(id);
    if (!schedule || !schedule.active) {
      return sendError(res, 'Active payment schedule not found', 404, 'NOT_FOUND');
    }
    // Sensitive write: requires self-access or admin role (task #732).
    if (!await hasAccessToLeague(req, schedule.leagueId)) {
      return sendError(res, "You don't have access to this league", 403, 'FORBIDDEN');
    }
    if (!await hasSelfOrAdminAccessToBowler(req, schedule.bowlerId)) {
      return sendError(res, "You don't have access to this schedule", 403, 'FORBIDDEN');
    }
    if (await rejectRosterConfiguredAutopay(res, schedule.leagueId)) return;

    const { frequency } = req.body;
    if (frequency && !['weekly', 'monthly', 'upfront'].includes(frequency)) {
      return sendError(res, 'Frequency must be "weekly", "monthly", or "upfront"', 400, 'VALIDATION_ERROR');
    }

    const updates: Record<string, unknown> = {};

    if (frequency && frequency !== schedule.frequency) {
      const league = await storage.getLeague(schedule.leagueId);
      if (!league) {
        return sendError(res, 'League not found', 404, 'LEAGUE_NOT_FOUND');
      }

      updates.frequency = frequency;

      const weeklyFee = league.weeklyFee || 0;
      updates.amount = frequency === 'monthly' ? weeklyFee * 4 : weeklyFee;

      updates.nextPaymentDate = getNextLeagueDateTime(
        new Date(),
        league.weekDay,
        league.competitionStartTime,
        league.timezone ?? DEFAULT_TIMEZONE,
        league.skipDates ?? [],
        league.cancelledDates ?? []
      );
    }

    if (req.body.additionalBowlerIds !== undefined) {
      const league2 = await storage.getLeague(schedule.leagueId);
      if (!league2?.organizationId) {
        return sendError(res, 'Combined autopay requires an org-stamped league', 400, 'ORG_REQUIRED');
      }
      const v = await validateAdditionalBowlerIds(
        schedule.bowlerId,
        league2.organizationId,
        req.body.additionalBowlerIds,
      );
      if (!v.ok) return sendError(res, v.message, 400, 'INVALID_PARTNER');
      updates.additionalBowlerIds = v.ids.length > 0 ? v.ids : null;
    }

    if (Object.keys(updates).length === 0) {
      return sendSuccess(res, schedule);
    }

    const updated = await storage.updatePaymentScheduleFields(id, updates);
    if (!isTestKickSuppressed(req, PAYMENT_SCHEDULER_KICK_HEADER)) {
      await paymentScheduler.updateSchedule(updated);
    }

    return sendSuccess(res, updated);
  } catch (error) {
    log.error('Error updating schedule:', error);
    return sendError(res, 'Internal server error', 500, 'SERVER_ERROR');
  }
});

export default router;
