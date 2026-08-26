import { Router, Request } from 'express';
import { randomBytes } from 'crypto';
import { storage } from '../storage';
import {
  insertLeagueSchema,
  updateLeagueSchema,
  DEFAULT_TIMEZONE,
  WEEKDAYS,
  PAYMENT_MODES,
  dateSchema,
  nameSchema,
  positiveIntSchema,
  timeSchema,
} from "@shared/schema";
import { validateDoublePayDates } from "@shared/schema/leagues";
import { z } from "zod";
import { sendSuccess, sendError, handleZodError, parseOptionalIntParam } from '../utils/api';
import { singleRouteParam } from '../utils/route-params';
import { requireOrganizationAccess, hasAccessToLeague, hasAdminAccessToLeague, isOrgOrHigher, isPaymentManager } from '../utils/access-control';
import { getOrganizationFilter, filterByOrganization } from '../middleware/organization';
import { hashPassword } from '../auth';
import { sendInviteEmail } from '../services/email';
import { linkUserToBowler } from '../services/identity-link.js';
import { paymentScheduler } from '../services/payment-scheduler.js';
import { isTestKickSuppressed, PAYMENT_SCHEDULER_KICK_HEADER } from '../utils/test-suppression';
import { getNextLeagueDateTime } from '../utils/league-datetime.js';
import { cacheInvalidate } from '../utils/cache.js';
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
import {
  LeagueCanonicalScheduleLockedError,
  LeagueOccurrenceEvidenceExistsError,
  LeaguePaymentModeLockedError,
  LeagueSubstituteConfigurationLockedError,
} from '../storage/leagues';
import {
  leagueSetupIntegrationIntentSchema,
  leagueRolloverSourceConfirmationSchema,
} from '@shared/league-setup-integration';
import {
  createLeagueWithCanonicalSetup,
  createNewSeasonWithCanonicalSetup,
  loadLeagueRolloverSource,
  LeagueSetupIntegrationError,
} from '../services/league-setup-integration.js';
import { FallDraftGenerationError } from '../services/fall-draft-generation.js';
import { CanonicalLeagueScheduleEditError, editCanonicalLeagueSchedule, readCanonicalLeagueScheduleRevision } from '../services/canonical-league-schedule-edit.js';
import { hasCompleteOperationalLeagueSchedule } from '../services/league-occurrence-schedule.js';

const log = createLogger("Leagues");

const router = Router();

const newSeasonRequestSchema = z.object({
  seasonStart: dateSchema,
  totalBowlingWeeks: z.number().int().positive().max(52),
  weekDay: z.enum(WEEKDAYS),
  skipDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  cancelledDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  doublePayDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(2, "At most 2 double-pay weeks allowed"),
  allowPublicSignup: z.boolean(),
  paymentMode: z.enum(PAYMENT_MODES),
  setupIntegration: leagueSetupIntegrationIntentSchema,
  sourceConfirmation: leagueRolloverSourceConfirmationSchema,
}).strict();

const directLeagueSetupTargetSchema = z.object({
  name: nameSchema,
  description: z.string().nullable().optional(),
  payingLineupSize: z.union([z.literal(3), z.literal(4)]),
  active: z.boolean(),
  organizationId: z.number().int().positive().optional(),
  locationId: z.number().int().positive().nullable().optional(),
  seasonStart: dateSchema,
  totalBowlingWeeks: z.number().int().positive().max(52),
  weekDay: z.enum(WEEKDAYS),
  skipDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  cancelledDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  doublePayDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(2, "At most 2 double-pay weeks allowed"),
  allowPublicSignup: z.boolean(),
  paymentMode: z.enum(PAYMENT_MODES),
  weeklyFee: positiveIntSchema.optional(),
  lineageFee: z.number().int().min(0).nullable().optional(),
  prizeFundFee: z.number().int().min(0).nullable().optional(),
  practiceStartTime: timeSchema.optional(),
  competitionStartTime: timeSchema.optional(),
  timezone: z.string().optional(),
  squareLineageItemId: z.string().nullable().optional(),
  lineageItemVariationId: z.string().nullable().optional(),
  squareLineageItemName: z.string().nullable().optional(),
  squarePrizeFundItemId: z.string().nullable().optional(),
  prizeFundItemVariationId: z.string().nullable().optional(),
  squarePrizeFundItemName: z.string().nullable().optional(),
  squareCategoryId: z.string().nullable().optional(),
  setupIntegration: leagueSetupIntegrationIntentSchema,
}).strict();

function sendLeagueSetupError(res: Parameters<typeof sendError>[0], error: unknown): void {
  if (error instanceof z.ZodError) return handleZodError(res, error);
  if (error instanceof FallDraftGenerationError) {
    const mapping: Partial<Record<typeof error.code, { status: number; apiCode: string }>> = {
      unauthorized_actor: { status: 403, apiCode: 'FORBIDDEN' },
      league_not_found: { status: 404, apiCode: 'NOT_FOUND' },
      invalid_location: { status: 404, apiCode: 'NOT_FOUND' },
      ineligible_league: { status: 422, apiCode: 'FALL_DRAFT_INELIGIBLE' },
      incomplete_authoritative_input: { status: 422, apiCode: 'FALL_DRAFT_INCOMPLETE_INPUT' },
      generator_fatal_error: { status: 422, apiCode: 'FALL_DRAFT_GENERATOR_ERROR' },
      unsupported_discrepancy: { status: 409, apiCode: 'FALL_DRAFT_UNSUPPORTED_DISCREPANCY' },
      not_wholly_future: { status: 409, apiCode: 'FALL_DRAFT_NOT_FUTURE' },
      idempotency_conflict: { status: 409, apiCode: 'IDEMPOTENCY_CONFLICT' },
      canonical_collision: { status: 409, apiCode: 'FALL_DRAFT_COLLISION' },
      incompatible_canonical_state: { status: 409, apiCode: 'FALL_DRAFT_INCOMPATIBLE_STATE' },
    };
    const selected = mapping[error.code] ?? { status: 500, apiCode: 'LEAGUE_SETUP_FAILED' };
    return sendError(res, error.message, selected.status, selected.apiCode);
  }
  if (!(error instanceof LeagueSetupIntegrationError)) {
    log.error('League setup error:', error);
    return sendError(res, 'League setup failed. No league or canonical schedule was created.', 500, 'LEAGUE_SETUP_FAILED');
  }
  const mapping: Record<LeagueSetupIntegrationError['code'], { status: number; apiCode: string }> = {
    invalid_scope: { status: 400, apiCode: 'INVALID_REQUEST' },
    unauthorized_actor: { status: 403, apiCode: 'FORBIDDEN' },
    organization_not_found: { status: 404, apiCode: 'NOT_FOUND' },
    location_not_found: { status: 404, apiCode: 'NOT_FOUND' },
    source_league_not_found: { status: 404, apiCode: 'NOT_FOUND' },
    stale_source_league: { status: 409, apiCode: 'STALE_SOURCE_LEAGUE' },
    successor_exists: { status: 409, apiCode: 'SUCCESSOR_SEASON_EXISTS' },
    idempotency_conflict: { status: 409, apiCode: 'IDEMPOTENCY_CONFLICT' },
    validation_error: { status: 400, apiCode: 'VALIDATION_ERROR' },
    transaction_failure: { status: 500, apiCode: 'LEAGUE_SETUP_FAILED' },
  };
  const selected = mapping[error.code];
  sendError(res, error.message, selected.status, selected.apiCode);
}

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

    // Payment managers see only configured leagues at their assigned
    // location. Their account is intentionally not linked to a bowler.
    if (isPaymentManager(req.user)) {
      leagues = leagues.filter((league) =>
        league.organizationId !== null
        && league.locationId !== null
        && league.organizationId === req.user?.organizationId
        && league.locationId === req.user?.locationId,
      );
    // Plain users only see leagues where they are rostered as a bowler;
    // organization membership alone does not grant league visibility.
    } else if (!isSystemAdmin && !isOrgAdmin && req.user) {
      const visibleLeagueIds = new Set<number>();
      if (req.user.bowlerId) {
        const bowlerLeagueRows = await storage.getBowlerLeagues({ bowlerId: req.user.bowlerId });
        for (const r of bowlerLeagueRows) visibleLeagueIds.add(r.leagueId);
      }
      leagues = leagues.filter((l) => visibleLeagueIds.has(l.id));
    }

    if (locationId) {
      leagues = leagues.filter(l => l.locationId === locationId);
    }

    // A league is product-visible only after its automatic canonical setup
    // transaction has published a complete operational occurrence set.
    leagues = (await Promise.all(leagues.map(async (league) => {
      if (league.organizationId === null) return null;
      return await hasCompleteOperationalLeagueSchedule({
        organizationId: league.organizationId,
        leagueId: league.id,
      }) ? league : null;
    }))).filter((league): league is NonNullable<typeof league> => league !== null);

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
    const id = parseInt(singleRouteParam(req.params.id));
    const league = await storage.getLeague(id);
    
    if (!league) {
      return sendError(res, "League not found", 404, 'NOT_FOUND');
    }
    
    // A plain `user`-role caller does not get
    // org-wide league visibility purely from org membership.
    if (!(await hasAccessToLeague(req, id))) {
      return sendError(res, "You don't have access to this league", 403, 'FORBIDDEN');
    }

    if (league.organizationId === null
      || !(await hasCompleteOperationalLeagueSchedule({
        organizationId: league.organizationId,
        leagueId: league.id,
      }))) {
      return sendError(res, "This league does not have a complete canonical schedule", 409, "CANONICAL_SCHEDULE_REQUIRED");
    }

    const canonicalScheduleRevision = league.organizationId === null
      ? null
      : await readCanonicalLeagueScheduleRevision({ organizationId: league.organizationId, leagueId: league.id });
    if (canonicalScheduleRevision !== null) res.setHeader("ETag", `\"${canonicalScheduleRevision}\"`);
    sendSuccess(res, canonicalScheduleRevision === null ? league : { ...league, canonicalScheduleRevision });
  } catch (error) {
    sendError(res, 'Failed to fetch league');
  }
});

router.post("/", async (req: Request, res) => {
  try {
    if (!req.user || !isOrgOrHigher(req.user)) {
      return sendError(res, "You don't have access to create leagues", 403, 'FORBIDDEN');
    }
    const forbiddenSetupFields = [
      'actorUserId', 'generatorInput', 'occurrenceCandidates', 'confirmedPreviewFingerprint',
      'sourceScheduleRevision', 'currency', 'ambiguousFold', 'regularSessionBillingPolicy',
      'billingOrdinalPolicy', 'commandAttribution', 'reason',
    ];
    if (forbiddenSetupFields.some((field) => Object.prototype.hasOwnProperty.call(req.body ?? {}, field))) {
      return sendError(res, 'League setup contains server-owned canonical generation fields', 400, 'VALIDATION_ERROR');
    }
    // Canonical setup derives seasonEnd from the schedule inputs. The client
    // never supplies an independent end date that could diverge from it.
    let derivedSeasonEnd: Date | undefined;
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
    const effectiveOrgId: number | null = req.user?.role === 'system_admin'
      ? bodyOrg
      : filterOrg ?? req.user?.organizationId ?? null;

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

    if (!req.user) return sendError(res, 'Authentication is required', 403, 'FORBIDDEN');
    if (req.user.role !== 'system_admin' && bodyOrg !== null) {
      return sendError(res, 'Organization scope is server-owned for organization administrators', 400, 'VALIDATION_ERROR');
    }
    const organization = await storage.getOrganization(effectiveOrgId);
    if (!organization) return sendError(res, 'Organization not found', 404, 'NOT_FOUND');
    if (typeof req.body?.locationId === 'number') {
      const location = await storage.getLocation(req.body.locationId);
      if (!location || location.organizationId !== effectiveOrgId) {
        return sendError(res, 'Location not found for this organization', 404, 'NOT_FOUND');
      }
    }

    if (Object.prototype.hasOwnProperty.call(req.body ?? {}, "seasonEnd")) {
      return sendError(res, 'seasonEnd is derived by canonical setup', 400, 'VALIDATION_ERROR');
    }
    const parsedSetup = directLeagueSetupTargetSchema.parse(req.body);
    const setup = parsedSetup.setupIntegration;
    const parsedLeague = insertLeagueSchema.parse({
      ...req.body,
      organizationId: effectiveOrgId,
      seasonStart: new Date(req.body.seasonStart),
      seasonEnd: derivedSeasonEnd
    });
    const created = await createLeagueWithCanonicalSetup({
      scope: { organizationId: effectiveOrgId, actorUserId: req.user.id },
      league: parsedLeague,
      setup,
    });
    sendSuccess(res, created, created.setupIntegration.mode === 'idempotent_retry' ? 200 : 201);
  } catch (error) {
    sendLeagueSetupError(res, error);
  }
});

router.patch("/:id", async (req: Request, res) => {
  try {
    const id = parseInt(singleRouteParam(req.params.id));
    
    // Get the league to verify organization access
    const league = await storage.getLeague(id);
    
    if (!league) {
      return sendError(res, "League not found", 404, 'NOT_FOUND');
    }
    
    // PATCH /api/leagues/:id is limited to organization and system administrators.
    const isAdminCaller =
      isOrgOrHigher(req.user) && requireOrganizationAccess(req, league.organizationId, 'league', id);
    if (!isAdminCaller) {
      return sendError(res, "You don't have access to this league", 403, 'FORBIDDEN');
    }
    
    // Non-admin users cannot change the organization of a league
    if (req.user?.role !== 'system_admin' && req.body.organizationId !== undefined
      && req.body.organizationId !== league.organizationId) {
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
    const canonicalScheduleValidationChanged = [
      "doublePayDates", "skipDates", "cancelledDates", "seasonStart", "seasonEnd", "weekDay",
    ].some((field) => Object.prototype.hasOwnProperty.call(req.body ?? {}, field));
    if (canonicalScheduleValidationChanged) {
      const result = validateDoublePayDates({
        doublePayDates: update.doublePayDates ?? league.doublePayDates ?? [],
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

    // Canonical leagues revise schedule and collection-group evidence in the
    // same tenant transaction.
    const canonicalDoublePayDates = update.doublePayDates;
    const canonicalScheduleFieldChanged = [
      "doublePayDates", "skipDates", "cancelledDates", "seasonStart", "seasonEnd",
      "weekDay", "competitionStartTime", "timezone", "totalBowlingWeeks",
    ].some((field) => Object.prototype.hasOwnProperty.call(req.body ?? {}, field));
    // Metadata does not alter the physical schedule. Only fields that alter
    // canonical schedule evidence require a complete operational set.
    const canonicalScheduleMutationChanged = canonicalScheduleFieldChanged;
    const hasCanonicalScheduleEvidence = canonicalScheduleMutationChanged && league.organizationId !== null
      ? await hasCompleteOperationalLeagueSchedule({ organizationId: league.organizationId, leagueId: id })
      : false;
    if (canonicalScheduleMutationChanged && !hasCanonicalScheduleEvidence) {
      return sendError(res, "A complete canonical schedule is required before editing this league", 409, "CANONICAL_SCHEDULE_REQUIRED");
    }
    let updated = league;
    let canonicalScheduleResponse: { state: "published"; collectionGroups: unknown[] } | undefined;
    if (hasCanonicalScheduleEvidence
      && canonicalScheduleMutationChanged) {
      for (const field of ["organizationId", "locationId", "weeklyFee", "paymentMode"] as const) {
        if (Object.prototype.hasOwnProperty.call(req.body ?? {}, field)
          && (update[field] as unknown) !== (league[field] as unknown)) {
          return sendError(res, `${field} cannot be changed on an authoritative canonical league`, 409, "CANONICAL_SCHEDULE_LOCKED_FIELD");
        }
      }
      const rawRevision = req.body.scheduleRevision ?? req.get("if-match")?.replace(/^W\//, "").replace(/^"|"$/g, "");
      const expectedScheduleRevision = typeof rawRevision === "string" ? Number(rawRevision) : rawRevision;
      const idempotencyKey = typeof req.body.idempotencyKey === "string" ? req.body.idempotencyKey : req.get("idempotency-key");
      if (!Number.isSafeInteger(expectedScheduleRevision) || !idempotencyKey) {
        return sendError(res, "Canonical schedule revision and Idempotency-Key are required", 428, "CANONICAL_SCHEDULE_PRECONDITION_REQUIRED");
      }
      const organizationId = league.organizationId;
      const actorUserId = req.user?.id;
      if (organizationId === null || actorUserId === undefined) {
        return sendError(res, "Canonical schedule tenant context is required", 403, "FORBIDDEN");
      }
      // The existing builder always submits its display-only derived
      // seasonEnd.  A cancellation/skip changes that preview date, but it is
      // not an audited physical regeneration and must not become a scalar
      // canonical edit.  Preserve the durable canonical end when the
      // submitted value is exactly this derived preview; a genuinely
      // different scalar still reaches the fail-closed editor below.
      const derivedBuilderSeasonEnd = mergedTotalBowlingWeeks != null && mergedWeekDay
        ? calculateSeasonEnd(new Date(mergedSeasonStart), mergedWeekDay, Number(mergedTotalBowlingWeeks), mergedSkipDates, mergedCancelledDates)
        : null;
      const seasonEndIsBuilderDerived = update.seasonEnd !== undefined && derivedBuilderSeasonEnd !== null
        && new Date(update.seasonEnd).toISOString().slice(0, 10) === derivedBuilderSeasonEnd.toISOString().slice(0, 10);
      const edited = await editCanonicalLeagueSchedule({
        organizationId,
        leagueId: id,
        actorUserId,
        expectedScheduleRevision,
        idempotencyKey,
        reason: typeof req.body.reason === "string" ? req.body.reason : "Administrator schedule builder edit",
        doublePayDates: canonicalDoublePayDates ?? league.doublePayDates,
        skipDates: update.skipDates ?? league.skipDates,
        cancelledDates: update.cancelledDates ?? league.cancelledDates,
        seasonStart: update.seasonStart === undefined ? undefined : new Date(update.seasonStart).toISOString(),
        seasonEnd: seasonEndIsBuilderDerived ? undefined : (update.seasonEnd === undefined ? undefined : new Date(update.seasonEnd).toISOString()),
        weekDay: update.weekDay,
        competitionStartTime: update.competitionStartTime,
        timezone: update.timezone,
        totalBowlingWeeks: update.totalBowlingWeeks,
        metadata: {
          ...(update.name === undefined ? {} : { name: update.name }),
          ...(update.description === undefined ? {} : { description: update.description }),
          ...(update.payingLineupSize === undefined ? {} : { payingLineupSize: update.payingLineupSize }),
          ...(update.active === undefined ? {} : { active: update.active }),
          ...(update.allowPublicSignup === undefined ? {} : { allowPublicSignup: update.allowPublicSignup }),
          ...(update.practiceStartTime === undefined ? {} : { practiceStartTime: update.practiceStartTime }),
          ...(update.lineageFee === undefined ? {} : { lineageFee: update.lineageFee }),
          ...(update.prizeFundFee === undefined ? {} : { prizeFundFee: update.prizeFundFee }),
          ...(update.squareLineageItemId === undefined ? {} : { squareLineageItemId: update.squareLineageItemId }),
          ...(update.lineageItemVariationId === undefined ? {} : { lineageItemVariationId: update.lineageItemVariationId }),
          ...(update.squareLineageItemName === undefined ? {} : { squareLineageItemName: update.squareLineageItemName }),
          ...(update.squarePrizeFundItemId === undefined ? {} : { squarePrizeFundItemId: update.squarePrizeFundItemId }),
          ...(update.prizeFundItemVariationId === undefined ? {} : { prizeFundItemVariationId: update.prizeFundItemVariationId }),
          ...(update.squarePrizeFundItemName === undefined ? {} : { squarePrizeFundItemName: update.squarePrizeFundItemName }),
          ...(update.squareCategoryId === undefined ? {} : { squareCategoryId: update.squareCategoryId }),
        },
      });
      updated = edited.league;
      cacheInvalidate('leagues:');
      canonicalScheduleResponse = { state: "published", collectionGroups: edited.collectionGroups };
    }

    if (!canonicalScheduleResponse) updated = await storage.updateLeague(id, update);

    // Task #429: a name change moves the bowler between Smart Lists
    // (the `league_name` Square attribute string changes); a season-
    // date change reshuffles the `league_season` label; flipping
    // `active=false` removes the league from both attribute strings.
    // Any of these warrants a league-wide bowler resync.
    const nameChanged = update.name !== undefined && update.name !== league.name;
    const seasonStartChanged =
      update.seasonStart !== undefined &&
      new Date(update.seasonStart).getTime() !== new Date(league.seasonStart).getTime();
    const seasonEndChanged = !canonicalScheduleResponse &&
      update.seasonEnd !== undefined &&
      new Date(update.seasonEnd).getTime() !== new Date(league.seasonEnd).getTime();
    const activeChanged = update.active !== undefined && update.active !== league.active;
    if (nameChanged || seasonStartChanged || seasonEndChanged || activeChanged) {
      fireLeagueBowlersExternalResync(id, req.user?.organizationId);
    }

    // Canonical roster obligations carry their split amounts as immutable
    // responsibility evidence. The historical payment projection backfill is
    // only valid before roster cutover and must never rewrite canonical rows.
    const feesChanged = update.lineageFee !== undefined || update.prizeFundFee !== undefined;
    if (feesChanged && updated.payingLineupSize == null) {
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

    if (canonicalScheduleResponse) {
      res.setHeader("ETag", `\"${updated.canonicalScheduleRevision}\"`);
      return sendSuccess(res, { ...updated, canonicalSchedule: canonicalScheduleResponse });
    }
    sendSuccess(res, updated);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return handleZodError(res, error);
    }
    if (error instanceof LeaguePaymentModeLockedError) {
      return sendError(
        res,
        'League payment timing cannot be changed after canonical schedule generation has started.',
        409,
        'LEAGUE_PAYMENT_MODE_LOCKED',
      );
    }
    if (error instanceof LeagueCanonicalScheduleLockedError) {
      return sendError(
        res,
        'Canonical schedule inputs cannot be changed after canonical schedule generation has started.',
        409,
        'LEAGUE_CANONICAL_SCHEDULE_LOCKED',
      );
    }
    if (error instanceof LeagueSubstituteConfigurationLockedError) {
      return sendError(
        res,
        'Substitute access and payment regime cannot change after the first canonical responsibility.',
        409,
        'LEAGUE_SUBSTITUTE_CONFIGURATION_LOCKED',
      );
    }
    if (error instanceof CanonicalLeagueScheduleEditError) {
      if (error.code === "stale_revision") return sendError(res, error.message, 409, "CANONICAL_SCHEDULE_STALE_REVISION");
      if (error.code === "financial_conflict") return sendError(res, error.message, 409, "CANONICAL_SCHEDULE_FINANCIAL_CONFLICT");
      if (error.code === "unsupported_edit") return sendError(res, error.message, 409, "CANONICAL_SCHEDULE_UNSUPPORTED_EDIT");
      return sendError(res, error.message, 400, "CANONICAL_SCHEDULE_EDIT_INVALID");
    }
    sendError(res, 'Failed to update league');
  }
});

// Archive a league
router.patch("/:id/archive", async (req: Request, res) => {
  try {
    const id = parseInt(singleRouteParam(req.params.id));
    const league = await storage.getLeague(id);
    if (!league) {
      return sendError(res, "League not found", 404, 'NOT_FOUND');
    }
    // Archive is a destructive administrator action.
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
    const id = parseInt(singleRouteParam(req.params.id));
    const league = await storage.getLeague(id);
    if (!league) {
      return sendError(res, "League not found", 404, 'NOT_FOUND');
    }
    // Restore mirrors archive — admin only.
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
    const id = parseInt(singleRouteParam(req.params.id));
    
    // Get the league to verify organization access
    const league = await storage.getLeague(id);
    
    if (!league) {
      return sendError(res, "League not found", 404, 'NOT_FOUND');
    }
    
    // Only org_admin/system_admin may delete a league.
    if (!isOrgOrHigher(req.user) || !requireOrganizationAccess(req, league.organizationId, 'league', id)) {
      return sendError(res, "You don't have access to this league", 403, 'FORBIDDEN');
    }
    
    // Storage owns the transaction, evidence check, and shared schedule lock.
    // It returns the pre-delete active roster so this post-commit-only
    // external resync never has to query rows that the transaction removed.
    const affectedBowlerIds = await storage.deleteLeague(id, league.organizationId);

    // Bowlers are now in zero leagues from this org's perspective
    // (assuming this was their only league). Push empty/updated
    // attribute strings so Smart Lists drop them (task #429).
    fireBowlersExternalResync(affectedBowlerIds, req.user?.organizationId);

    sendSuccess(res, null);
  } catch (error) {
    if (error instanceof LeagueOccurrenceEvidenceExistsError) {
      return sendError(
        res,
        'This league has retained canonical occurrence evidence. Archive the league instead of deleting it.',
        409,
        'LEAGUE_OCCURRENCE_EVIDENCE_EXISTS',
      );
    }
    log.error('Error deleting league:', error);
    sendError(res, 'Failed to delete league', 500);
  }
});

router.post("/:id/send-invites", async (req: Request, res) => {
  try {
    const leagueId = parseInt(singleRouteParam(req.params.id));
    const league = await storage.getLeague(leagueId);

    if (!league) {
      return sendError(res, "League not found", 404, 'NOT_FOUND');
    }

    // Sending invitations is an administrator action.
    if (!(await hasAdminAccessToLeague(req, leagueId))) {
      return sendError(res, "You don't have access to this league", 403, 'FORBIDDEN');
    }

    const bowlerLeagueEntries = await storage.getBowlerLeagues({ leagueId });

    let sent = 0;
    let alreadyRegistered = 0;
    let noEmail = 0;
    let deliveryFailed = 0;

    for (const bl of bowlerLeagueEntries) {
      const bowler = await storage.getBowler(bl.bowlerId);
      if (!bowler) continue;

      const email = bowler.email?.trim().toLowerCase() ?? '';
      if (!email) {
        noEmail++;
        continue;
      }

      const existingUser = await storage.getUserByEmail(email);
      if (existingUser) {
        alreadyRegistered++;
        continue;
      }

      const leagueOrganizationId = league.organizationId;
      if (!leagueOrganizationId) {
        return sendError(res, 'League organization context is required for invitations', 409, 'ORG_REQUIRED');
      }

      const placeholderPassword = await hashPassword(randomBytes(32).toString('hex'));
      const organization = await storage.getOrganization(leagueOrganizationId);
      const created = await db.transaction(async (tx) => {
        const newUser = await storage.createUser({
          email,
          password: placeholderPassword,
          name: bowler.name,
          role: 'user',
          organizationId: leagueOrganizationId,
          locationId: null,
        }, tx);
        const invitation = await storage.issueAccountAction({
          userId: newUser.id,
          action: 'account_invite',
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          organizationId: leagueOrganizationId,
          createdByUserId: req.user?.id ?? null,
        }, tx);
        await linkUserToBowler({
          organizationId: leagueOrganizationId,
          userId: newUser.id,
          bowlerId: bowler.id,
          actorUserId: req.user?.id ?? null,
          source: 'league-bulk-invite',
          reason: 'league-roster-invitation',
          eventType: 'admin_assignment',
        }, tx);
        return { newUser, invitation };
      });
      // The identity service defers cache invalidation for injected
      // executors so the enclosing compound transaction can decide when the
      // write is committed. At this point the user/link/event transaction has
      // committed successfully.
      cacheInvalidate(`user:${created.newUser.id}`);

      const firstName = bowler.name.split(' ')[0];
      let emailSent = false;
      try {
        emailSent = await sendInviteEmail(
          email,
          firstName,
          created.invitation.token,
          organization?.name,
          organization?.id,
          organization?.slug,
        );
      } catch {
        emailSent = false;
      }
      await storage.updateAccountActionDeliveryStatus(
        created.invitation.request.id,
        emailSent ? 'sent' : 'failed',
      );
      if (!emailSent) deliveryFailed++;

      sent++;
    }

    sendSuccess(res, { sent, alreadyRegistered, noEmail, deliveryFailed });
  } catch (error) {
    sendError(res, 'Failed to send invites');
  }
});

router.get("/:id/new-season/source-confirmation", async (req: Request, res) => {
  try {
    const rawId = singleRouteParam(req.params.id);
    const id = /^\d+$/.test(rawId) ? Number(rawId) : NaN;
    if (!Number.isSafeInteger(id) || id <= 0) {
      return sendError(res, "Invalid league ID", 400, "INVALID_ID");
    }
    if (!req.user || (req.user.role !== 'system_admin' && req.user.role !== 'org_admin')) {
      return sendError(res, "Only admins can start a new season", 403, "FORBIDDEN");
    }
    const explicitSystemOrganization = typeof req.query.organizationId === 'string'
      && /^\d+$/.test(req.query.organizationId)
      ? Number(req.query.organizationId)
      : null;
    if (req.user.role === 'system_admin' && (!explicitSystemOrganization || !Number.isSafeInteger(explicitSystemOrganization))) {
      return sendError(res, 'System administrators must select one organization with ?organizationId=<id>', 400, 'INVALID_REQUEST');
    }
    const organizationId = req.user.role === 'system_admin'
      ? explicitSystemOrganization
      : getOrganizationFilter(req) ?? req.user.organizationId;
    if (!organizationId) return sendError(res, 'A valid organization scope is required', 400, 'INVALID_REQUEST');
    sendSuccess(res, await loadLeagueRolloverSource({
      scope: { organizationId, actorUserId: req.user.id },
      sourceLeagueId: id,
    }));
  } catch (error) {
    sendLeagueSetupError(res, error);
  }
});

router.post("/:id/new-season", async (req: Request, res) => {
  try {
    const rawId = singleRouteParam(req.params.id);
    const id = /^\d+$/.test(rawId) ? Number(rawId) : NaN;
    if (!Number.isSafeInteger(id) || id <= 0) {
      return sendError(res, "Invalid league ID", 400, "INVALID_ID");
    }

    if (req.user?.role !== 'system_admin' && req.user?.role !== 'org_admin') {
      return sendError(res, "Only admins can start a new season", 403, "FORBIDDEN");
    }

    const parsedRequest = newSeasonRequestSchema.safeParse(req.body);
    if (!parsedRequest.success) {
      return handleZodError(res, parsedRequest.error);
    }

    if (!req.user) return sendError(res, 'Authentication is required', 403, 'FORBIDDEN');
    const explicitSystemOrganization = typeof req.query.organizationId === 'string'
      && /^\d+$/.test(req.query.organizationId)
      ? Number(req.query.organizationId)
      : null;
    if (req.user.role === 'system_admin' && (!explicitSystemOrganization || !Number.isSafeInteger(explicitSystemOrganization))) {
      return sendError(res, 'System administrators must select one organization with ?organizationId=<id>', 400, 'INVALID_REQUEST');
    }
    const organizationId = req.user.role === 'system_admin'
      ? explicitSystemOrganization
      : getOrganizationFilter(req) ?? req.user.organizationId;
    if (!organizationId) return sendError(res, 'A valid organization scope is required', 400, 'INVALID_REQUEST');
    const { setupIntegration, ...requestValues } = parsedRequest.data;
    const sourceConfirmation = "sourceConfirmation" in requestValues
      ? requestValues.sourceConfirmation
      : undefined;
    const values = "sourceConfirmation" in requestValues
      ? (({ sourceConfirmation: _confirmed, ...targetValues }) => targetValues)(requestValues)
      : requestValues;
    const created = await createNewSeasonWithCanonicalSetup({
      scope: { organizationId, actorUserId: req.user.id },
      sourceLeagueId: id,
      values,
      setup: setupIntegration,
      sourceConfirmation,
    });

    // The source league is now inactive AND the bowlers are in the
    // freshly-cloned new league — both their `league_name` (likely
    // unchanged) and `league_season` (definitely changed) attribute
    // values need to be pushed out. Resync each bowler once. Task #429.
    if (created.result.setupIntegration.writesPerformed) {
      fireBowlersExternalResync(created.affectedBowlerIds, organizationId);
    }

    sendSuccess(res, created.result, created.result.setupIntegration.mode === 'idempotent_retry' ? 200 : 201);
  } catch (error) {
    sendLeagueSetupError(res, error);
  }
});

router.get("/:id/season-history", async (req: Request, res) => {
  try {
    const id = parseInt(singleRouteParam(req.params.id));
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
      if (isPaymentManager(req.user)) {
        allLeagues = allLeagues.filter((candidate) =>
          candidate.locationId !== null
          && candidate.locationId === req.user?.locationId,
        );
      }
    } else if (req.user?.role === 'system_admin') {
      allLeagues = await storage.getAllLeaguesSystemAdmin();
    } else {
      allLeagues = [league];
    }
    const seasons: typeof league[] = [];

    let current: typeof league | undefined = league;
    while (current) {
      const previousSeasonId: number | null = current.previousSeasonId;
      if (!previousSeasonId) break;
      current = allLeagues.find(l => l.id === previousSeasonId);
      if (current) seasons.unshift(current);
    }

    seasons.push(league);

    const nextSeason = allLeagues.find(l => l.previousSeasonId === league.id);
    if (nextSeason) {
      let next: typeof nextSeason | undefined = nextSeason;
      while (next) {
        const nextSeasonId: number = next.id;
        seasons.push(next);
        next = allLeagues.find(l => l.previousSeasonId === nextSeasonId);
      }
    }

    sendSuccess(res, seasons);
  } catch (error) {
    sendError(res, 'Failed to fetch season history');
  }
});

export default router;
