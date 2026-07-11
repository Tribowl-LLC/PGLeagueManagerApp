import { Router, Request } from 'express';
import { randomBytes } from 'crypto';
import { storage } from '../storage';
import { insertLeagueSchema, updateLeagueSchema, DEFAULT_TIMEZONE, WEEKDAYS, dateSchema } from "@shared/schema";
import { validateDoublePayDates } from "@shared/schema/leagues";
import { z } from "zod";
import { sendSuccess, sendError, handleZodError, parseOptionalIntParam } from '../utils/api';
import { requireOrganizationAccess, hasAccessToLeague, hasAdminAccessToLeague, isOrgOrHigher } from '../utils/access-control';
import { getOrganizationFilter, filterByOrganization } from '../middleware/organization';
import { hashPassword } from '../auth';
import { sendInviteEmail } from '../services/email';
import { paymentScheduler } from '../services/payment-scheduler.js';
import { isTestKickSuppressed, PAYMENT_SCHEDULER_KICK_HEADER } from '../utils/test-suppression';
import { getNextLeagueDateTime } from '../utils/league-datetime.js';
import { calculateSeasonEnd } from '@shared/schedule-utils';
import { db } from '../db.js';
import { payments as paymentsTable } from '@shared/schema';
import { eq, isNull, and } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { createLogger } from '../logger';
import {
  fireBowlerExternalResync,
  fireLeagueBowlersExternalResync,
  fireBowlersExternalResync,
} from '../services/bowler-resync';

const log = createLogger("Leagues");

const router = Router();

const newSeasonRequestSchema = z.object({
  seasonStart: dateSchema,
  // Retained for older clients that still submit an explicit end date.
  seasonEnd: dateSchema.optional(),
  totalBowlingWeeks: z.number().int().positive().max(52).optional(),
  weekDay: z.enum(WEEKDAYS).optional(),
  skipDates: z.array(z.string()).default([]),
  cancelledDates: z.array(z.string()).default([]),
  doublePayDates: z.array(z.string()).max(2, "At most 2 double-pay weeks allowed").default([]),
});

// Apply organization filtering to all league routes
router.use(filterByOrganization);

router.get("/", async (req: Request, res) => {
  try {
    // task #421: validate the optional `?locationId` filter BEFORE
    // any storage lookup. Two reasons:
    //   1. Don't burn a DB round trip on a request we're going to
    //      400 anyway.
    //   2. The previous `parseInt(String(req.query.locationId))`
    //      silently accepted partially-numeric input like
    //      `?locationId=42abc` as `42` and returned filtered
    //      results for the wrong location.
    // The `if (locationId)` truthy check below preserves the prior
    // semantics for `?locationId=0` (treated as "no filter" — 0 is
    // not a valid location id), so this is a malformed-input-only
    // tightening with no behaviour change for valid callers.
    const locationId = parseOptionalIntParam(req.query.locationId);
    if (locationId === null) {
      return sendError(res, "Invalid location ID format", 400);
    }

    const organizationId = getOrganizationFilter(req);
    const isSystemAdmin = req.user?.role === 'system_admin';
    const isOrgAdmin = req.user?.role === 'org_admin';

    let leagues: Awaited<ReturnType<typeof storage.getLeagues>>;
    if (organizationId !== null) {
      leagues = await storage.getLeagues(organizationId);
    } else if (isSystemAdmin) {
      leagues = await storage.getAllLeaguesSystemAdmin();
    } else {
      return sendSuccess(res, []);
    }

    // Task #735: plain `user`-role callers must NOT see every league in
    // the org by virtue of org membership alone — that would make a
    // league_secretary grant a no-op for visibility. Scope the visible
    // set to (a) leagues the caller is rostered into as a bowler, plus
    // (b) leagues they were granted a secretary role on.
    if (!isSystemAdmin && !isOrgAdmin && req.user) {
      const visibleLeagueIds = new Set<number>();
      if (req.user.bowlerId) {
        const bowlerLeagueRows = await storage.getBowlerLeagues({ bowlerId: req.user.bowlerId });
        for (const r of bowlerLeagueRows) visibleLeagueIds.add(r.leagueId);
      }
      const grantedLeagueIds = await storage.getSecretaryLeagueIdsForUser(req.user.id);
      for (const id of grantedLeagueIds) visibleLeagueIds.add(id);
      leagues = leagues.filter((l) => visibleLeagueIds.has(l.id));
    }

    if (locationId) {
      leagues = leagues.filter(l => l.locationId === locationId);
    }

    sendSuccess(res, leagues);
  } catch (error) {
    sendError(res, 'Failed to fetch leagues');
  }
});

/**
 * Task #657: feed for the leagues-page banner that surfaces leagues
 * whose last Square-catalog audit (#654) flagged a saved Lineage /
 * Prize Fund variation id as missing from the live catalog. The
 * banner pairs the email alert with an in-app indicator so admins
 * who don't read the email still see something on the Leagues page.
 *
 * Auto-clear semantics: an alert row is suppressed from the response
 * when the league's currently-saved variation id no longer matches
 * what was reported missing — i.e. the admin re-pointed the league
 * at a different (presumably live) item. We do this in the route
 * rather than mutating `alerter_state` so the underlying row keeps
 * its rate-limit slot intact for the throttle window.
 *
 * Tenant scoping mirrors the rest of this router via
 * `filterByOrganization`: org-admins see only their own org's
 * leagues; system-admins see every alerted league. We additionally
 * intersect against `getLeague` (org-admin) /
 * `getAllLeaguesSystemAdmin` (system-admin) so a league deleted
 * after the alert fired never surfaces.
 *
 * Mounted before `/:id` so the literal path segment isn't captured
 * by the `:id` parameter.
 */
const RECENT_LEAGUE_SQUARE_MISSING_WINDOW_MS = 24 * 60 * 60 * 1000;
router.get("/square-missing-alerts/recent", async (req: Request, res) => {
  try {
    const organizationId = getOrganizationFilter(req);
    const isSystemAdmin = req.user?.role === 'system_admin';
    if (organizationId === null && !isSystemAdmin) {
      return sendSuccess(res, { alerts: [] });
    }

    const visibleLeagues = organizationId !== null
      ? await storage.getLeagues(organizationId)
      : await storage.getAllLeaguesSystemAdmin();
    const leagueById = new Map(visibleLeagues.map((l) => [l.id, l] as const));

    const events = await storage.listRecentAlerterEventsByPrefix(
      'league_square_missing:',
      RECENT_LEAGUE_SQUARE_MISSING_WINDOW_MS,
    );

    type AlertItem = {
      sentAt: string;
      leagueId: number;
      leagueName: string;
      organizationId: number | null;
      missing: Array<{ kind: 'lineage' | 'prizeFund'; itemName: string | null; variationId: string }>;
    };

    const alerts: AlertItem[] = [];
    for (const e of events) {
      // Defensive: only surface rows whose summary matches the
      // expected league-missing shape so an apple-pay / cap-alert
      // row that happened to share the prefix can never leak in.
      const s = e.summary as Partial<import('@shared/schema').LeagueSquareMissingAlerterSummary> | null;
      if (!s || typeof s.leagueId !== 'number' || !Array.isArray(s.missing)) continue;

      const league = leagueById.get(s.leagueId);
      if (!league) continue; // deleted, archived out of view, or another tenant.

      // Auto-clear: only include the variations that the league
      // *still* points at. If admin re-picked a live item, the
      // saved variation id no longer matches and the entry drops
      // out — when nothing remains, suppress the whole alert.
      const stillMissing: AlertItem['missing'] = [];
      for (const m of s.missing) {
        if (!m || typeof m.variationId !== 'string') continue;
        if (m.kind === 'lineage' && league.lineageItemVariationId === m.variationId) {
          stillMissing.push({ kind: 'lineage', itemName: m.itemName ?? null, variationId: m.variationId });
        } else if (m.kind === 'prizeFund' && league.prizeFundItemVariationId === m.variationId) {
          stillMissing.push({ kind: 'prizeFund', itemName: m.itemName ?? null, variationId: m.variationId });
        }
      }
      if (stillMissing.length === 0) continue;

      alerts.push({
        sentAt: e.lastSentAt.toISOString(),
        leagueId: league.id,
        leagueName: league.name,
        organizationId: league.organizationId ?? null,
        missing: stillMissing,
      });
    }

    sendSuccess(res, { alerts });
  } catch (error) {
    log.error('League Square-missing recent alerts error:', error);
    sendError(res, 'Failed to load recent league Square-missing alerts', 500);
  }
});

router.get("/:id", async (req: Request, res) => {
  try {
    const id = parseInt(req.params.id);
    const league = await storage.getLeague(id);
    
    if (!league) {
      return sendError(res, "League not found", 404, 'NOT_FOUND');
    }
    
    // Task #735: hasAccessToLeague honors secretary grants AND has been
    // tightened so that a plain `user`-role caller no longer gets
    // org-wide league visibility purely from org membership.
    if (!(await hasAccessToLeague(req, id))) {
      return sendError(res, "You don't have access to this league", 403, 'FORBIDDEN');
    }

    sendSuccess(res, league);
  } catch (error) {
    sendError(res, 'Failed to fetch league');
  }
});

router.post("/", async (req: Request, res) => {
  try {
    // Derive seasonEnd server-side when totalBowlingWeeks is provided
    let derivedSeasonEnd = req.body.seasonEnd ? new Date(req.body.seasonEnd) : undefined;
    if (
      req.body.totalBowlingWeeks != null &&
      req.body.seasonStart &&
      req.body.weekDay
    ) {
      derivedSeasonEnd = calculateSeasonEnd(
        new Date(req.body.seasonStart),
        req.body.weekDay,
        Number(req.body.totalBowlingWeeks),
        req.body.skipDates ?? [],
        req.body.cancelledDates ?? []
      );
    }

    // Determine the effective organizationId BEFORE parsing — the insert
    // schema now requires a non-null org, so server-side fallbacks must be
    // applied to the payload first or normal org_admin form submissions
    // (which don't include an organizationId field) would fail validation.
    const filterOrg = getOrganizationFilter(req);
    const bodyOrg = typeof req.body?.organizationId === 'number' ? req.body.organizationId : null;
    let effectiveOrgId: number | null = bodyOrg ?? filterOrg ?? req.user?.organizationId ?? null;

    if (effectiveOrgId == null) {
      // Every league must belong to an organization. system_admin used to
      // be able to create a "globally accessible" (org-less) league via
      // globalAccess: true; that path created rows that are unreachable
      // under the deny-on-null access policy and is no longer permitted.
      if (req.user?.role === 'system_admin') {
        return sendError(
          res,
          'An organizationId is required. System admins must specify the target organization when creating a league.',
          400,
          'ORG_REQUIRED'
        );
      }
      return sendError(
        res,
        'You must belong to an organization to create a league.',
        403,
        'ORG_REQUIRED'
      );
    }

    // Task #454: existence pre-check for the admin-supplied
    // organizationId. A system_admin may pass any number; a caller's
    // session orgId is also re-verified here defensively (cheap and
    // catches the rare case of a stale session pointing at an org that
    // was archived/deleted between login and this request). Without
    // this, a typoed/stale id falls through to the
    // `leagues.organization_id -> organizations.id` foreign key and
    // surfaces as a generic 500. Mirrors the #422 reference fix in
    // server/routes/bowlers.ts.
    const orgRow = await storage.getOrganization(effectiveOrgId);
    if (!orgRow) {
      return sendError(res, 'Organization not found', 404, 'NOT_FOUND');
    }

    // Task #454: same existence guard for the optional admin-supplied
    // locationId. The schema accepts a number-or-null, so a typoed id
    // is the only failure mode that bypasses the column nullability.
    const bodyLocationId = req.body?.locationId;
    if (typeof bodyLocationId === 'number') {
      const locationRow = await storage.getLocation(bodyLocationId);
      if (!locationRow || locationRow.organizationId !== effectiveOrgId) {
        // Conflate "missing" and "wrong-org" into the same 404 — the
        // caller has no business stamping a league with a location
        // belonging to a different tenant either way.
        return sendError(res, 'Location not found for this organization', 404, 'NOT_FOUND');
      }
    }

    const league = insertLeagueSchema.parse({
      ...req.body,
      organizationId: effectiveOrgId,
      seasonStart: new Date(req.body.seasonStart),
      seasonEnd: derivedSeasonEnd ?? new Date(req.body.seasonEnd)
    });

    const created = await storage.createLeague(league);
    sendSuccess(res, created, 201);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return handleZodError(res, error);
    }
    sendError(res, 'Failed to create league');
  }
});

router.patch("/:id", async (req: Request, res) => {
  try {
    const id = parseInt(req.params.id);
    
    // Get the league to verify organization access
    const league = await storage.getLeague(id);
    
    if (!league) {
      return sendError(res, "League not found", 404, 'NOT_FOUND');
    }
    
    // Task #735: PATCH /api/leagues/:id is allowed for org_admin /
    // system_admin in the same org, OR for a league_secretary on this
    // league, BUT secretaries may only mutate a narrow allowlist of
    // fields. Forbidden for secretaries: organizationId, locationId,
    // active (archive control), and every payment-provider /
    // catalog-mapping field (square*, lineageItemVariationId,
    // prizeFundItemVariationId). Any payload containing a forbidden
    // key is rejected outright with 403 — we do NOT silently drop
    // forbidden fields, so a buggy client can't think the change took.
    const isAdminCaller =
      isOrgOrHigher(req.user) && requireOrganizationAccess(req, league.organizationId, 'league', id);
    let isSecretaryCaller = false;
    if (!isAdminCaller) {
      isSecretaryCaller = await hasAdminAccessToLeague(req, id);
      if (!isSecretaryCaller) {
        return sendError(res, "You don't have access to this league", 403, 'FORBIDDEN');
      }
      const SECRETARY_FORBIDDEN_FIELDS = new Set([
        'organizationId',
        'locationId',
        'active',
        'squareLineageItemId',
        'lineageItemVariationId',
        'squareLineageItemName',
        'squarePrizeFundItemId',
        'prizeFundItemVariationId',
        'squarePrizeFundItemName',
        'squareCategoryId',
      ]);
      const offending = Object.keys(req.body ?? {}).filter((k) => SECRETARY_FORBIDDEN_FIELDS.has(k));
      if (offending.length > 0) {
        return sendError(
          res,
          `League secretaries may not modify: ${offending.join(', ')}`,
          403,
          'SECRETARY_FORBIDDEN_FIELD',
        );
      }
    }
    
    // Non-admin users cannot change the organization of a league
    if (req.user?.role !== 'system_admin' && req.body.organizationId !== undefined) {
      return sendError(res, "You don't have permission to change the organization of this league", 403, 'FORBIDDEN');
    }

    // Task #454: when a system_admin re-stamps the league's owning org,
    // verify the new org actually exists. Without this, a typoed id
    // falls through to the `leagues.organization_id -> organizations.id`
    // FK and surfaces as a generic 500. The non-sysadmin branch above
    // has already 403'd if the org id is changed at all.
    const newOrgId =
      req.user?.role === 'system_admin' && typeof req.body.organizationId === 'number'
        ? req.body.organizationId
        : null;
    if (newOrgId !== null) {
      const orgRow = await storage.getOrganization(newOrgId);
      if (!orgRow) {
        return sendError(res, 'Organization not found', 404, 'NOT_FOUND');
      }
    }
    const effectiveOrgIdForLocation = newOrgId ?? league.organizationId;

    // Task #454: existence + same-tenant guard for an updated locationId.
    // We treat "missing" and "belongs to another org" the same way as
    // the POST handler — locations are tenant-scoped, so a stamp
    // crossing the boundary is meaningless and should not 500.
    if (req.body.locationId !== undefined && req.body.locationId !== null) {
      const newLocationId = req.body.locationId;
      if (typeof newLocationId === 'number') {
        const locationRow = await storage.getLocation(newLocationId);
        if (
          !locationRow ||
          (effectiveOrgIdForLocation !== null && locationRow.organizationId !== effectiveOrgIdForLocation)
        ) {
          return sendError(res, 'Location not found for this organization', 404, 'NOT_FOUND');
        }
      }
    }
    
    // Merge incoming fields with existing league data for derivation
    const mergedWeekDay = req.body.weekDay ?? league.weekDay;
    const mergedSeasonStart = req.body.seasonStart ?? league.seasonStart;
    const mergedTotalBowlingWeeks = req.body.totalBowlingWeeks !== undefined
      ? req.body.totalBowlingWeeks
      : league.totalBowlingWeeks;
    const mergedSkipDates = req.body.skipDates ?? league.skipDates ?? [];
    const mergedCancelledDates = req.body.cancelledDates ?? league.cancelledDates ?? [];

    // Derive seasonEnd server-side when totalBowlingWeeks is available
    let derivedSeasonEnd = req.body.seasonEnd ? new Date(req.body.seasonEnd) : undefined;
    if (mergedTotalBowlingWeeks != null && mergedSeasonStart && mergedWeekDay) {
      derivedSeasonEnd = calculateSeasonEnd(
        new Date(mergedSeasonStart),
        mergedWeekDay,
        Number(mergedTotalBowlingWeeks),
        mergedSkipDates,
        mergedCancelledDates
      );
    }

    const update = updateLeagueSchema.parse({
      ...req.body,
      seasonStart: req.body.seasonStart ? new Date(req.body.seasonStart) : undefined,
      seasonEnd: derivedSeasonEnd ?? (req.body.seasonEnd ? new Date(req.body.seasonEnd) : undefined)
    });

    // Task #646: a partial PATCH that only changes `doublePayDates`
    // bypasses the schema-level weekday/season-window/overlap checks
    // (the schema bails out when those context fields aren't in the
    // payload). Re-run the validator here against the merged
    // persisted-league + patch-body view so a `doublePayDates`-only
    // PATCH still gets fully checked.
    if (update.doublePayDates !== undefined) {
      const result = validateDoublePayDates({
        doublePayDates: update.doublePayDates,
        skipDates: update.skipDates ?? league.skipDates ?? [],
        cancelledDates: update.cancelledDates ?? league.cancelledDates ?? [],
        weekDay: update.weekDay ?? league.weekDay,
        seasonStart: update.seasonStart ?? league.seasonStart,
        seasonEnd: update.seasonEnd ?? league.seasonEnd,
      });
      if (!result.ok) {
        return sendError(res, result.message, 400, 'BAD_REQUEST');
      }
    }

    const updated = await storage.updateLeague(id, update);

    // Task #429: a name change moves the bowler between Smart Lists
    // (the `league_name` Square attribute string changes); a season-
    // date change reshuffles the `league_season` label; flipping
    // `active=false` removes the league from both attribute strings.
    // Any of these warrants a league-wide bowler resync.
    const nameChanged = update.name !== undefined && update.name !== league.name;
    const seasonStartChanged =
      update.seasonStart !== undefined &&
      new Date(update.seasonStart).getTime() !== new Date(league.seasonStart).getTime();
    const seasonEndChanged =
      update.seasonEnd !== undefined &&
      new Date(update.seasonEnd).getTime() !== new Date(league.seasonEnd).getTime();
    const activeChanged = update.active !== undefined && update.active !== league.active;
    if (nameChanged || seasonStartChanged || seasonEndChanged || activeChanged) {
      fireLeagueBowlersExternalResync(id, req.user?.organizationId);
    }

    const feesChanged = update.lineageFee !== undefined || update.prizeFundFee !== undefined;
    if (feesChanged) {
      try {
        const lineageFee = updated.lineageFee;
        const prizeFundFee = updated.prizeFundFee;
        const weeklyFee = updated.weeklyFee;
        const bothSet = lineageFee != null && prizeFundFee != null;
        const sumMatchesWeekly = bothSet && (lineageFee + prizeFundFee === weeklyFee);

        if (bothSet && sumMatchesWeekly && weeklyFee > 0) {
          await db.execute(sql`
            UPDATE payments
            SET
              lineage_amount = ROUND(amount::numeric * ${lineageFee} / ${weeklyFee})::integer,
              prize_fund_amount = ROUND(amount::numeric * ${prizeFundFee} / ${weeklyFee})::integer
            WHERE league_id = ${id}
              AND status = 'paid'
          `);
          log.info(`Backfilled payment splits for league ${id}: lineageFee=${lineageFee}, prizeFundFee=${prizeFundFee}`);
        } else {
          await db.execute(sql`
            UPDATE payments
            SET lineage_amount = NULL, prize_fund_amount = NULL
            WHERE league_id = ${id}
          `);
          log.info(`Cleared payment splits for league ${id} (fees not fully configured)`);
        }
      } catch (backfillErr) {
        log.error('Error backfilling payment splits:', backfillErr);
      }
    }

    const timezoneChanged = update.timezone && update.timezone !== league.timezone;
    if (timezoneChanged) {
      const activeSchedules = await storage.getActiveSchedulesByLeague(id);
      const tz = updated.timezone ?? DEFAULT_TIMEZONE;

      for (const sched of activeSchedules) {
        const nextDate = getNextLeagueDateTime(
          new Date(),
          updated.weekDay,
          updated.competitionStartTime,
          tz,
          updated.skipDates ?? [],
          updated.cancelledDates ?? []
        );

        await storage.updatePaymentScheduleFields(sched.id, { nextPaymentDate: nextDate.toISOString() });
        if (!isTestKickSuppressed(req, PAYMENT_SCHEDULER_KICK_HEADER)) {
          await paymentScheduler.removeSchedule(sched.id);
          const updatedSched = await storage.getPaymentScheduleById(sched.id);
          if (updatedSched && updatedSched.active) {
            await paymentScheduler.addSchedule(updatedSched, updated.organizationId);
          }
        }
      }
    }

    sendSuccess(res, updated);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return handleZodError(res, error);
    }
    sendError(res, 'Failed to update league');
  }
});

// Archive a league
router.patch("/:id/archive", async (req: Request, res) => {
  try {
    const id = parseInt(req.params.id);
    const league = await storage.getLeague(id);
    if (!league) {
      return sendError(res, "League not found", 404, 'NOT_FOUND');
    }
    // Task #735: archive is a destructive admin action — secretaries
    // do not get to take a league down.
    if (!isOrgOrHigher(req.user) || !requireOrganizationAccess(req, league.organizationId, 'league', id)) {
      return sendError(res, "You don't have access to this league", 403, 'FORBIDDEN');
    }
    const archived = await storage.archiveLeague(id);
    // Archiving drops this league from every member's `league_name`
    // and `league_season` strings — push the new values out (task #429).
    fireLeagueBowlersExternalResync(id, req.user?.organizationId);
    sendSuccess(res, archived);
  } catch (error) {
    sendError(res, 'Failed to archive league');
  }
});

// Restore an archived league
router.patch("/:id/restore", async (req: Request, res) => {
  try {
    const id = parseInt(req.params.id);
    const league = await storage.getLeague(id);
    if (!league) {
      return sendError(res, "League not found", 404, 'NOT_FOUND');
    }
    // Task #735: restore mirrors archive — admin only.
    if (!isOrgOrHigher(req.user) || !requireOrganizationAccess(req, league.organizationId, 'league', id)) {
      return sendError(res, "You don't have access to this league", 403, 'FORBIDDEN');
    }
    const restored = await storage.restoreLeague(id);
    // Restore puts this league back into every member's attribute
    // strings — push the new values out (task #429).
    fireLeagueBowlersExternalResync(id, req.user?.organizationId);
    sendSuccess(res, restored);
  } catch (error) {
    sendError(res, 'Failed to restore league');
  }
});

router.delete("/:id", async (req: Request, res) => {
  try {
    const id = parseInt(req.params.id);
    
    // Get the league to verify organization access
    const league = await storage.getLeague(id);
    
    if (!league) {
      return sendError(res, "League not found", 404, 'NOT_FOUND');
    }
    
    // Task #735: league deletion is explicitly OUT of the secretary
    // contract — only org_admin/system_admin may delete a league.
    if (!isOrgOrHigher(req.user) || !requireOrganizationAccess(req, league.organizationId, 'league', id)) {
      return sendError(res, "You don't have access to this league", 403, 'FORBIDDEN');
    }
    
    // Capture the bowler ids in this league BEFORE the destructive
    // writes so the post-delete resync (task #429) can still find
    // them. Doing it after delete would observe an empty roster.
    const preDeleteBowlerLeagues = await storage.getBowlerLeagues({ leagueId: id });
    const affectedBowlerIds = Array.from(
      new Set(preDeleteBowlerLeagues.map((bl) => bl.bowlerId)),
    );

    const teams = await storage.getTeams(id);

    for (const team of teams) {
      const teamBowlers = await storage.getBowlers({ teamId: team.id, organizationId: league.organizationId! });
      for (const bowler of teamBowlers) {
        await storage.updateBowler(bowler.id, { active: false, order: 0 });
      }
      await storage.deleteTeam(team.id);
    }

    await storage.deleteLeague(id);

    // Bowlers are now in zero leagues from this org's perspective
    // (assuming this was their only league). Push empty/updated
    // attribute strings so Smart Lists drop them (task #429).
    fireBowlersExternalResync(affectedBowlerIds, req.user?.organizationId);

    sendSuccess(res, null);
  } catch (error) {
    log.error('Error deleting league:', error);
    sendError(res, 'Failed to delete league', 500);
  }
});

router.post("/:id/send-invites", async (req: Request, res) => {
  try {
    const leagueId = parseInt(req.params.id);
    const league = await storage.getLeague(leagueId);

    if (!league) {
      return sendError(res, "League not found", 404, 'NOT_FOUND');
    }

    // Task #735: send-invites is a league-admin action a secretary
    // legitimately needs to perform for their league.
    if (!(await hasAdminAccessToLeague(req, leagueId))) {
      return sendError(res, "You don't have access to this league", 403, 'FORBIDDEN');
    }

    const bowlerLeagueEntries = await storage.getBowlerLeagues({ leagueId });

    let sent = 0;
    let alreadyRegistered = 0;
    let noEmail = 0;

    for (const bl of bowlerLeagueEntries) {
      const bowler = await storage.getBowler(bl.bowlerId);
      if (!bowler) continue;

      if (!bowler.email) {
        noEmail++;
        continue;
      }

      const existingUser = await storage.getUserByEmail(bowler.email);
      if (existingUser) {
        alreadyRegistered++;
        continue;
      }

      const placeholderPassword = await hashPassword(randomBytes(32).toString('hex'));
      const inviteToken = randomBytes(32).toString('hex');
      const inviteTokenExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      const newUser = await storage.createUser({
        email: bowler.email,
        password: placeholderPassword,
        name: bowler.name,
        role: 'user',
        organizationId: league.organizationId || null,
      });

      await storage.setUserInviteToken(newUser.id, inviteToken, inviteTokenExpiry);
      await storage.linkUserToBowler(newUser.id, bowler.id);

      const organization = league.organizationId
        ? await storage.getOrganization(league.organizationId)
        : null;

      const firstName = bowler.name.split(' ')[0];
      await sendInviteEmail(bowler.email, firstName, inviteToken, organization?.name, organization?.id, organization?.slug);

      sent++;
    }

    sendSuccess(res, { sent, alreadyRegistered, noEmail });
  } catch (error) {
    sendError(res, 'Failed to send invites');
  }
});

router.post("/:id/new-season", async (req: Request, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return sendError(res, "Invalid league ID", 400, "INVALID_ID");
    }

    if (req.user?.role !== 'system_admin' && req.user?.role !== 'org_admin') {
      return sendError(res, "Only admins can start a new season", 403, "FORBIDDEN");
    }

    const sourceLeague = await storage.getLeague(id);
    if (!sourceLeague) {
      return sendError(res, "League not found", 404, "NOT_FOUND");
    }

    // Authz: cloning a league counts as a write against the source league's
    // organization. Without this check an org_admin could create a new
    // season on any league by ID, regardless of which org owns it.
    if (!requireOrganizationAccess(req, sourceLeague.organizationId, 'league', id)) {
      return sendError(res, "You don't have access to this league", 403, 'FORBIDDEN');
    }

    const parsedRequest = newSeasonRequestSchema.safeParse(req.body);
    if (!parsedRequest.success) {
      return handleZodError(res, parsedRequest.error);
    }

    const {
      seasonStart,
      seasonEnd,
      totalBowlingWeeks,
      weekDay,
      skipDates,
      cancelledDates,
      doublePayDates,
    } = parsedRequest.data;
    const newSeasonWeekDay = weekDay ?? sourceLeague.weekDay;
    const newSeasonWeeks = totalBowlingWeeks ?? sourceLeague.totalBowlingWeeks;
    const newSeasonStart = new Date(seasonStart);
    let newSeasonEnd: Date | null;
    if (totalBowlingWeeks != null || !seasonEnd) {
      newSeasonEnd = newSeasonWeeks != null
        ? calculateSeasonEnd(seasonStart, newSeasonWeekDay, newSeasonWeeks, skipDates, cancelledDates)
        : null;
    } else {
      newSeasonEnd = new Date(seasonEnd);
    }

    if (!newSeasonEnd || newSeasonEnd <= newSeasonStart) {
      return sendError(res, "Season end date must be after start date", 400, "VALIDATION_ERROR");
    }

    const doublePayValidation = validateDoublePayDates({
      doublePayDates,
      skipDates,
      cancelledDates,
      weekDay: newSeasonWeekDay,
      seasonStart,
      seasonEnd: newSeasonEnd.toISOString(),
    });
    if (!doublePayValidation.ok) {
      return sendError(res, doublePayValidation.message, 400, "VALIDATION_ERROR");
    }

    const newLeague = await storage.createLeague({
      name: sourceLeague.name,
      description: sourceLeague.description,
      active: true,
      allowPublicSignup: sourceLeague.allowPublicSignup ?? false,
      seasonStart: newSeasonStart.toISOString(),
      seasonEnd: newSeasonEnd.toISOString(),
      weekDay: newSeasonWeekDay,
      weeklyFee: sourceLeague.weeklyFee,
      lineageFee: sourceLeague.lineageFee ?? undefined,
      prizeFundFee: sourceLeague.prizeFundFee ?? undefined,
      practiceStartTime: sourceLeague.practiceStartTime ?? undefined,
      competitionStartTime: sourceLeague.competitionStartTime ?? undefined,
      timezone: sourceLeague.timezone ?? DEFAULT_TIMEZONE,
      squareLineageItemId: sourceLeague.squareLineageItemId,
      lineageItemVariationId: sourceLeague.lineageItemVariationId,
      squareLineageItemName: sourceLeague.squareLineageItemName,
      squarePrizeFundItemId: sourceLeague.squarePrizeFundItemId,
      prizeFundItemVariationId: sourceLeague.prizeFundItemVariationId,
      squarePrizeFundItemName: sourceLeague.squarePrizeFundItemName,
      squareCategoryId: sourceLeague.squareCategoryId ?? undefined,
      paymentMode: sourceLeague.paymentMode ?? "weekly",
      organizationId: sourceLeague.organizationId,
      locationId: sourceLeague.locationId,
      seasonNumber: (sourceLeague.seasonNumber || 1) + 1,
      previousSeasonId: sourceLeague.id,
      totalBowlingWeeks: newSeasonWeeks,
      skipDates,
      cancelledDates,
      // Double-pay weeks are season-specific. The form sends the new
      // season's explicit selections; they are never copied implicitly.
      doublePayDates,
    });

    const sourceTeams = await storage.getTeams(sourceLeague.id);
    const teamIdMap = new Map<number, number>();

    for (const team of sourceTeams) {
      const newTeam = await storage.createTeam({
        name: team.name,
        number: team.number,
        leagueId: newLeague.id,
        active: team.active,
      });
      teamIdMap.set(team.id, newTeam.id);
    }

    const sourceBowlerLeagues = await storage.getBowlerLeagues({ leagueId: sourceLeague.id });

    for (const bl of sourceBowlerLeagues) {
      const newTeamId = teamIdMap.get(bl.teamId);
      if (newTeamId) {
        await storage.createBowlerLeague({
          bowlerId: bl.bowlerId,
          leagueId: newLeague.id,
          teamId: newTeamId,
          active: bl.active,
          order: bl.order,
        });
      }
    }

    await storage.updateLeague(sourceLeague.id, { active: false });

    // The source league is now inactive AND the bowlers are in the
    // freshly-cloned new league — both their `league_name` (likely
    // unchanged) and `league_season` (definitely changed) attribute
    // values need to be pushed out. Resync each bowler once. Task #429.
    const uniqueBowlerIds = Array.from(
      new Set(sourceBowlerLeagues.map((bl) => bl.bowlerId)),
    );
    fireBowlersExternalResync(uniqueBowlerIds, req.user?.organizationId);

    sendSuccess(res, newLeague, 201);
  } catch (error) {
    log.error('New season error:', error);
    sendError(res, 'Failed to create new season');
  }
});

router.get("/:id/season-history", async (req: Request, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return sendError(res, "Invalid league ID", 400, "INVALID_ID");
    }

    const league = await storage.getLeague(id);
    if (!league) {
      return sendError(res, "League not found", 404, "NOT_FOUND");
    }

    // Cross-org leak guard (task #399): the rest of this handler walks
    // the entire season chain via `storage.getLeagues(league.organizationId)`,
    // which would happily return another org's full season history when
    // the caller passes a foreign league id. Gate on league access first
    // (system admins bypass, matching the rest of this file).
    if (req.user?.role !== 'system_admin') {
      const allowed = await hasAccessToLeague(req, id);
      if (!allowed) {
        return sendError(res, "You don't have access to this league", 403, "FORBIDDEN");
      }
    }

    let allLeagues;
    if (league.organizationId) {
      allLeagues = await storage.getLeagues(league.organizationId);
    } else if (req.user?.role === 'system_admin') {
      allLeagues = await storage.getAllLeaguesSystemAdmin();
    } else {
      allLeagues = [league];
    }
    const seasons: typeof league[] = [];

    let current: typeof league | undefined = league;
    while (current?.previousSeasonId) {
      current = allLeagues.find(l => l.id === current!.previousSeasonId);
      if (current) seasons.unshift(current);
    }

    seasons.push(league);

    const nextSeason = allLeagues.find(l => l.previousSeasonId === league.id);
    if (nextSeason) {
      let next: typeof nextSeason | undefined = nextSeason;
      while (next) {
        seasons.push(next);
        next = allLeagues.find(l => l.previousSeasonId === next!.id);
      }
    }

    sendSuccess(res, seasons);
  } catch (error) {
    sendError(res, 'Failed to fetch season history');
  }
});

export default router;
