import { Router } from 'express';
import { storage } from '../storage';
import { insertBowlerSchema, updateBowlerSchema } from "@shared/schema";
import { z } from "zod";
import {
  sendSuccess,
  sendError,
  handleZodError,
  parseOptionalIntParam,
  parseOptionalIntListParam,
  sanitizeBowler,
  sanitizePayments,
} from '../utils/api.js';
import { getPaymentProvider, ProviderNotConfiguredError } from '../services/payment-provider-factory';
import type { PaymentProvider } from '../services/payment-provider';
import { hasAccessToTeam, hasAccessToBowler, hasAccessToBowlers, hasSelfOrAdminAccessToBowler, isOrgOrHigher } from '../utils/access-control.js';
import { canUserPayForBowler } from '../utils/bowler-payment-authz.js';
import { bowlerSearchLimiter } from '../middleware/rate-limit.js';
import { runBowlerPostCreateSync } from '../services/bowler-sync.js';
import { syncBowlerLeagueAttributesToProvider } from '../services/bowler-attributes';
import { createLogger } from '../logger';
import { isDev } from '../config';
// reuse the same payer-name lookup the
// /api/payments report uses so the recipient's bowler-details payment
// list carries identical "Paid by …" attribution. Defined in
// payment-reports.ts (org-scoped, name-only — never email).
import { buildPayerNameMap } from './payments/payment-reports.js';

const log = createLogger("Bowlers");

const router = Router();


router.get("/unlinked", async (req, res) => {
  try {
    // task #421: replace the loose `parseInt + isNaN` pattern with
    // the strict shared helper so partially-numeric input like
    // `?organizationId=1abc` is rejected too (not silently coerced
    // to `1`).
    const rawUnlinkedOrgId = parseOptionalIntParam(req.query.organizationId);
    if (rawUnlinkedOrgId === null) {
      return sendError(res, "Invalid organization ID format", 400);
    }

    let organizationId: number | undefined;
    if (req.user?.role === 'system_admin') {
      // System admins may scope by query param, or see all if omitted
      organizationId = rawUnlinkedOrgId;
    } else if (req.user?.role === 'org_admin') {
      // Org admins are always scoped to their own organization
      if (!req.user?.organizationId) {
        return sendError(res, "No organization context available", 403, 'FORBIDDEN');
      }
      organizationId = req.user.organizationId;
    } else {
      // Regular users must have an org
      if (!req.user?.organizationId) {
        return sendError(res, "No organization context available", 403, 'FORBIDDEN');
      }
      organizationId = req.user.organizationId;
    }
    let scopedBowlers;
    if (req.user?.role === 'system_admin' && !organizationId) {
      scopedBowlers = await storage.getAllBowlersSystemAdmin();
    } else if (organizationId) {
      scopedBowlers = await storage.getBowlers({ organizationId });
    } else {
      return sendSuccess(res, []);
    }

    const linkedBowlerIdsList = await storage.getLinkedBowlerIds();
    const linkedBowlerIds = new Set(linkedBowlerIdsList);

    const unlinkedBowlers = scopedBowlers.filter(
      b => !linkedBowlerIds.has(b.id) && (!b.email || b.email.trim() === '')
    );

    const bowlerIds = unlinkedBowlers.map(b => b.id);
    const bowlerLeagueEntries = bowlerIds.length > 0
      ? await storage.getBowlerLeaguesByBowlerIds(bowlerIds)
      : [];

    const leagueIds = [...new Set(bowlerLeagueEntries.map(bl => bl.leagueId))];
    const teamIds = [...new Set(bowlerLeagueEntries.map(bl => bl.teamId))];

    const [leaguesData, teamsData] = await Promise.all([
      leagueIds.length > 0 ? storage.getLeaguesByIds(leagueIds) : Promise.resolve([]),
      teamIds.length > 0 ? storage.getTeamsByIds(teamIds) : Promise.resolve([]),
    ]);

    const leagueMap = new Map(leaguesData.map(l => [l.id, l]));
    const teamMap = new Map(teamsData.map(t => [t.id, t]));

    const grouped: Record<string, { league: { id: number; name: string }; teams: Record<string, { team: { id: number; name: string; number: number }; bowlers: { id: number; name: string }[] }> }> = {};

    for (const bowler of unlinkedBowlers) {
      const bowlerEntries = bowlerLeagueEntries.filter(bl => bl.bowlerId === bowler.id);
      for (const entry of bowlerEntries) {
        const league = leagueMap.get(entry.leagueId);
        const team = teamMap.get(entry.teamId);
        if (!league || !team) continue;
        if (organizationId && league.organizationId !== organizationId) continue;

        const leagueKey = String(league.id);
        if (!grouped[leagueKey]) {
          grouped[leagueKey] = { league: { id: league.id, name: league.name }, teams: {} };
        }
        const teamKey = String(team.id);
        if (!grouped[leagueKey].teams[teamKey]) {
          grouped[leagueKey].teams[teamKey] = { team: { id: team.id, name: team.name, number: team.number }, bowlers: [] };
        }
        if (!grouped[leagueKey].teams[teamKey].bowlers.some(b => b.id === bowler.id)) {
          grouped[leagueKey].teams[teamKey].bowlers.push({ id: bowler.id, name: bowler.name });
        }
      }
    }

    const result = Object.values(grouped).map(g => ({
      league: g.league,
      teams: Object.values(g.teams),
    }));

    sendSuccess(res, result);
  } catch (error) {
    log.error('Error fetching unlinked bowlers:', error);
    sendError(res, 'Failed to fetch unlinked bowlers');
  }
});

router.get("/", async (req, res) => {
  try {
    // task #421: tighten both filters with the strict shared
    // helpers — previously `parseInt` accepted "42abc" as 42 and the
    // ids-list split would silently drop bad elements as NaN.
    const teamId = parseOptionalIntParam(req.query.teamId);
    if (teamId === null) {
      return sendError(res, "Invalid team ID format", 400);
    }

    const ids = parseOptionalIntListParam(req.query.ids);
    if (ids === null) {
      return sendError(res, "Invalid bowler ID format in list", 400);
    }

    // If teamId is provided, check organization access
    if (teamId && req.user?.role !== 'system_admin') {
      const hasAccess = await hasAccessToTeam(req, teamId);
      if (!hasAccess) {
        return sendError(res, "You don't have access to this team's bowlers", 403, 'FORBIDDEN');
      }
    }

    // If a list of bowler IDs is provided, gate access for the whole list in
    // a single batched call. Use `hasAccessToBowlers` rather than looping
    // `hasAccessToBowler` to avoid N×3 query amplification.
    if (ids && ids.length > 0 && req.user?.role !== 'system_admin') {
      const accessMap = await hasAccessToBowlers(req, ids);
      const denied = ids.filter(id => !accessMap.get(id));
      if (denied.length > 0) {
        return sendError(res, "You don't have access to one or more of the requested bowlers", 403, 'FORBIDDEN');
      }
    }

    // Determine the effective organization context
    const isSystemAdmin = req.user?.role === 'system_admin';
    const rawQueryOrgId = parseOptionalIntParam(req.query.organizationId);
    if (rawQueryOrgId === null) {
      return sendError(res, "Invalid organization ID format", 400);
    }
    const effectiveOrgId: number | null = isSystemAdmin
      ? (rawQueryOrgId ?? req.user?.organizationId ?? null)
      : (req.user?.organizationId ?? null);

    if (!teamId && !isSystemAdmin && effectiveOrgId === null) {
      return sendSuccess(res, []);
    }

    let bowlers;
    if (isSystemAdmin && effectiveOrgId === null) {
      bowlers = await storage.getAllBowlersSystemAdmin();
    } else if (effectiveOrgId !== null) {
      // Task #735: a non-admin "user"-role caller (the only role
      // that can hold a league_secretary grant without already being
      // an admin) must not see every bowler in the org. SQL-scope
      // the result to bowlers rostered into:
      //   - any league the caller is themselves a bowler in
      //     (preserves the long-standing bowler-self UX)
      //   - any league the caller holds an active secretary grant on
      // If the caller has neither, return [] — they have no
      // legitimate roster surface in this org.
      // Admin callers (and a `teamId` filter, which already gates via
      // hasAccessToTeam above) keep the unscoped org-wide query.
      if (req.user && !isSystemAdmin && !isOrgOrHigher(req.user) && !teamId) {
        const grantedLeagueIds = await storage.getSecretaryLeagueIdsForUser(req.user.id);
        const selfLeagueIds: number[] = req.user?.bowlerId
          ? (await storage.getBowlerLeagues({ bowlerId: req.user.bowlerId })).map((bl) => bl.leagueId)
          : [];
        const visibleLeagueIds = [...new Set([...grantedLeagueIds, ...selfLeagueIds])];
        if (visibleLeagueIds.length === 0) {
          return sendSuccess(res, []);
        }
        const blEntries = await Promise.all(
          visibleLeagueIds.map((leagueId) => storage.getBowlerLeagues({ leagueId })),
        );
        const visibleBowlerIds = [
          ...new Set(blEntries.flat().map((bl) => bl.bowlerId)),
        ];
        if (visibleBowlerIds.length === 0) {
          return sendSuccess(res, []);
        }
        const fetched = await storage.getBowlersByIds(visibleBowlerIds);
        // Defence in depth: drop any row whose org stamp doesn't match
        // the caller's org (should be impossible if league.org_id
        // matches, but the trigger only enforces league⇄grant org
        // match, not bowler⇄league).
        bowlers = fetched.filter((b) => b.organizationId === effectiveOrgId);
      } else {
        bowlers = await storage.getBowlers({ teamId, organizationId: effectiveOrgId });
      }
    } else {
      return sendSuccess(res, []);
    }
    
    if (!bowlers || bowlers.length === 0) {
      return sendSuccess(res, []);
    }

    const filteredBowlers = ids 
      ? bowlers.filter(b => ids.includes(b.id))
      : bowlers;

    const linkedBowlerIds = new Set(await storage.getLinkedBowlerIds());

    // task #381: project each bowler through the deny-by-default
    // allowlist before composing the response so a future column
    // (cloverCustomerId today, anything new tomorrow) cannot
    // silently leak via the spread below.
    const bowlersWithAccountStatus = filteredBowlers.map(b => ({
      ...sanitizeBowler(b),
      hasAccount: linkedBowlerIds.has(b.id),
    }));

    sendSuccess(res, bowlersWithAccountStatus);
  } catch (error) {
    log.error('Error fetching bowlers:', error);
    sendError(res, 'Failed to fetch bowlers');
  }
});

/**
 * Task #702: Bowler name-search endpoint used by the partner-link
 * picker (mobile profile + admin direct-link). Returns up to ~10
 * matches scoped to the caller's organization. system_admin may
 * cross-scope via `?organizationId=`.
 */
router.get("/search", bowlerSearchLimiter, async (req, res) => {
  try {
    const user = req.user;
    if (!user) return sendError(res, "Authentication required", 401, "AUTH_REQUIRED");

    const q = typeof req.query.q === "string" ? req.query.q : "";
    if (q.trim().length < 2) {
      return sendSuccess(res, []);
    }

    const isSysAdmin = user.role === "system_admin";
    const rawOrgId = parseOptionalIntParam(req.query.organizationId);
    if (rawOrgId === null) {
      return sendError(res, "Invalid organization ID format", 400);
    }
    const orgId: number | null = isSysAdmin
      ? (rawOrgId ?? user.organizationId ?? null)
      : (user.organizationId ?? null);
    if (!orgId) {
      return sendError(res, "Organization required", 400, "ORG_REQUIRED");
    }

    const excludeIds = parseOptionalIntListParam(req.query.excludeIds) ?? [];
    const results = await storage.searchBowlersByName(q, orgId, 10);
    let filtered = excludeIds.length > 0
      ? results.filter((r) => !excludeIds.includes(r.id))
      : results;

    // Task #735: secretary-scope the search result. A non-admin
    // caller may only see bowlers rostered into a league they have
    // direct visibility into (their own bowler-leagues ∪ their
    // league_secretary grants). Admin callers (org_admin /
    // system_admin) get the org-wide search unchanged. Empty visible
    // set → empty result.
    if (!isSysAdmin && user.role !== 'org_admin' && filtered.length > 0) {
      const grantedLeagueIds = await storage.getSecretaryLeagueIdsForUser(user.id);
      const selfLeagueIds: number[] = user.bowlerId
        ? (await storage.getBowlerLeagues({ bowlerId: user.bowlerId })).map((bl) => bl.leagueId)
        : [];
      const visibleLeagueIds = new Set<number>([...grantedLeagueIds, ...selfLeagueIds]);
      if (visibleLeagueIds.size === 0) {
        filtered = [];
      } else {
        const ids = filtered.map((r) => r.id);
        const blEntries = await storage.getBowlerLeaguesByBowlerIds(ids);
        const leaguesByBowler = new Map<number, Set<number>>();
        for (const bl of blEntries) {
          const s = leaguesByBowler.get(bl.bowlerId) ?? new Set<number>();
          s.add(bl.leagueId);
          leaguesByBowler.set(bl.bowlerId, s);
        }
        filtered = filtered.filter((r) => {
          // The caller can always find themselves in search.
          if (user.bowlerId && r.id === user.bowlerId) return true;
          const ls = leaguesByBowler.get(r.id);
          if (!ls) return false;
          for (const lid of ls) if (visibleLeagueIds.has(lid)) return true;
          return false;
        });
      }
    }
    return sendSuccess(res, filtered);
  } catch (error) {
    log.error('Error searching bowlers:', error);
    sendError(res, 'Failed to search bowlers');
  }
});

router.get("/:id/details", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const bowler = await storage.getBowler(id);

    if (!bowler) {
      return sendError(res, "Bowler not found", 404, 'NOT_FOUND');
    }

    const includePayments = req.query.includePayments === 'true';
    if (includePayments) {
      // Payment data is sensitive: require self-access, admin role, OR
      // partner-pay authorization through an accepted bowler-payment-link
      // in the same org. Partner-pay surfaces in the
      // bowler dashboard need each linked partner's payment history to
      // compute eligibility and combined past-due totals — task #732
      // tightened this to self-or-admin only and accidentally broke
      // that flow. canUserPayForBowler enforces the same org + accepted
      // -link rules used everywhere else partner-pay is gated.
      const selfOrAdmin = await hasSelfOrAdminAccessToBowler(req, id);
      if (!selfOrAdmin) {
        const payAuthz = await canUserPayForBowler(req, id);
        if (!payAuthz.allowed) {
          return sendError(res, "You don't have access to this bowler's payment data", 403, 'FORBIDDEN');
        }
      }
    } else if (req.user?.role !== 'system_admin') {
      const hasAccess = await hasAccessToBowler(req, id);
      if (!hasAccess) {
        return sendError(res, "You don't have access to this bowler", 403, 'FORBIDDEN');
      }
    }

    const [hasAccount, bowlerLeaguesAll] = await Promise.all([
      storage.isBowlerLinked(id),
      storage.getBowlerLeagues({ bowlerId: id }),
    ]);

    // Task #735: secretary-scope the bowler↔league/team membership
    // payload. A non-admin caller (anyone who is NOT system_admin /
    // org_admin) must only see league/team membership for leagues
    // they have direct visibility into:
    //   - leagues they are themselves a bowler in (bowler-self UX), ∪
    //   - leagues they hold an active league_secretary grant on, ∪
    //   - the bowler's own profile (self-access — they always see all
    //     of their own memberships).
    // Admin callers (org_admin / system_admin) keep the full view.
    let bowlerLeagues = bowlerLeaguesAll;
    const callerIsAdmin =
      req.user?.role === 'system_admin' || req.user?.role === 'org_admin';
    const callerIsSelf = req.user?.bowlerId === id;
    if (req.user && !callerIsAdmin && !callerIsSelf) {
      const grantedLeagueIds = await storage.getSecretaryLeagueIdsForUser(req.user.id);
      const selfLeagueIds: number[] = req.user.bowlerId
        ? (await storage.getBowlerLeagues({ bowlerId: req.user.bowlerId })).map((bl) => bl.leagueId)
        : [];
      const visibleLeagueIds = new Set<number>([...grantedLeagueIds, ...selfLeagueIds]);
      bowlerLeagues = bowlerLeaguesAll.filter((bl) => visibleLeagueIds.has(bl.leagueId));
    }

    const leagueIds = [...new Set(bowlerLeagues.map(bl => bl.leagueId))];
    const teamIds = [...new Set(bowlerLeagues.filter(bl => bl.teamId).map(bl => bl.teamId!))];

    const [leagues, teams] = await Promise.all([
      leagueIds.length > 0 ? storage.getLeaguesByIds(leagueIds) : Promise.resolve([]),
      teamIds.length > 0 ? storage.getTeamsByIds(teamIds) : Promise.resolve([]),
    ]);

    const response: Record<string, unknown> = {
      // task #381: project before spreading so cloverCustomerId /
      // paymentProviderLocationId (and any future sensitive column)
      // cannot ride along on the details payload.
      bowler: { ...sanitizeBowler(bowler), hasAccount },
      bowlerLeagues,
      leagues,
      teams,
    };

    if (includePayments && leagueIds.length > 0) {
      // scope the payment lookup to the
      // *bowler's* org, not the requester's. System_admin requesters
      // (and admins viewing a bowler in their own org) need the rows
      // here even when the requester's session has no organizationId
      // (sysadmin) or differs from the bowler's. The hasAccess gate
      // above already enforces that the requester may see this bowler.
      const orgId = bowler.organizationId;
      if (orgId) {
        const payments = await storage.getPayments({ bowlerId: id, organizationId: orgId });
        // Same payer-name enrichment as /api/payments so the recipient's
        // history surfaces render the "Paid by …" badge identically.
        const nameMap = await buildPayerNameMap(payments, orgId);
        response.payments = sanitizePayments(payments, nameMap);
      }
    }

    sendSuccess(res, response);
  } catch (error) {
    log.error('Error fetching bowler details:', error);
    sendError(res, 'Failed to fetch bowler details');
  }
});

router.get("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const bowler = await storage.getBowler(id);
    
    if (!bowler) {
      return sendError(res, "Bowler not found", 404, 'NOT_FOUND');
    }
    
    // Check organization access
    if (req.user?.role !== 'system_admin') {
      const hasAccess = await hasAccessToBowler(req, id);
      if (!hasAccess) {
        return sendError(res, "You don't have access to this bowler", 403, 'FORBIDDEN');
      }
    }

    const hasAccount = await storage.isBowlerLinked(id);

    // task #381: project before spreading (see GET / and
    // GET /:id/details for the deny-by-default rationale).
    sendSuccess(res, { ...sanitizeBowler(bowler), hasAccount });
  } catch (error) {
    log.error('Error fetching bowler:', error);
    sendError(res, 'Failed to fetch bowler');
  }
});

router.post("/", async (req, res) => {
  try {
    const bowler = insertBowlerSchema.parse(req.body);
    
    // If teamId is provided in the request, verify organization access
    if (req.body.teamId && req.user?.role !== 'system_admin') {
      const teamId = parseInt(req.body.teamId);
      
      if (!isNaN(teamId)) {
        const hasAccess = await hasAccessToTeam(req, teamId);
        if (!hasAccess) {
          return sendError(res, "You don't have access to add bowlers to this team", 403, 'FORBIDDEN');
        }
      }
    }

    // Check for existing bowler with same email if provided
    if (bowler.email) {
      const userOrgId: number | undefined = req.user?.organizationId ?? undefined;
      const isOrgUser = req.user?.role !== 'system_admin' && userOrgId !== undefined;
      const [existingBowlers, orgLeagues, bowlerLeaguesList] = await Promise.all([
        isOrgUser ? storage.getBowlers({ organizationId: userOrgId }) : storage.getAllBowlersSystemAdmin(),
        isOrgUser ? storage.getLeagues(userOrgId) : Promise.resolve(null),
        isOrgUser ? storage.getBowlerLeagues() : Promise.resolve(null),
      ]);

      let filteredBowlers = existingBowlers;
      if (isOrgUser && orgLeagues && orgLeagues.length > 0) {
        const leagueIdSet = new Set(orgLeagues.map(l => l.id));
        const organizationBowlerIds = new Set(
          bowlerLeaguesList!
            .filter(bl => leagueIdSet.has(bl.leagueId))
            .map(bl => bl.bowlerId)
        );
        filteredBowlers = existingBowlers.filter(b => organizationBowlerIds.has(b.id));
      }
      
      const existingBowler = filteredBowlers.find(b =>
        b.email && b.email.toLowerCase() === bowler.email!.toLowerCase()
      );

      if (existingBowler) {
        return res.status(200).json({
          success: true,
          duplicate: true,
          existingBowler: {
            id: existingBowler.id,
            name: existingBowler.name,
            email: existingBowler.email,
          },
        });
      }
    }

    // Stamp the owning organization on the new bowler at creation time
    // (task #342, hardened to NOT NULL at the DB layer in #407, audited
    // for completeness in #415). This closes the cross-org hijack
    // window between the bowler insert and its first `bowler_leagues`
    // row: a bowler is now org-bound from the moment it exists, not
    // retroactively inferred from league links.
    //
    // Org id source: caller's session org. System admins MAY override
    // via the `?organizationId` query param; for every other role the
    // session org is the only source. If neither is present we 403
    // here so the user gets a clean error instead of letting the
    // `bowlers.organization_id` NOT NULL DB constraint fire as a 500.
    //
    // Task #422: when the org id comes from an admin-supplied source
    // (today only the `?organizationId` query param), verify the org
    // actually exists before we attempt the insert. Without this, a
    // typo or stale id falls through to the `bowlers.organization_id
    // -> organizations.id` foreign key and surfaces as a generic 500.
    // Session-derived ids (every non-system-admin role) cannot point
    // at a missing org because the user row itself FKs to it, so we
    // only pay for the lookup on the override path.
    //
    // Task #421 / #453: parse the override with `parseOptionalIntParam`
    // (the strict shared parser) instead of the loose `parseInt + isNaN`
    // pattern. The loose pattern silently coerced partially-numeric
    // input like `?organizationId=1abc` to `1`, which — combined with
    // the #422 existence check — would still pass through as a quiet
    // cross-org stamp whenever the coerced id happened to point at a
    // real org. The strict parser returns `null` for any non-digit
    // characters, mapping cleanly to the existing 400 branch.
    // Pinned by tests/api/bowler-creation-org-required.test.ts.
    const callerOrgId: number | undefined = req.user?.organizationId ?? undefined;
    const isSystemAdmin = req.user?.role === 'system_admin';
    let stampOrgId: number | undefined = callerOrgId;
    let adminSuppliedOrgId: number | undefined;
    if (isSystemAdmin) {
      const rawQueryOrgId = parseOptionalIntParam(req.query.organizationId);
      if (rawQueryOrgId === null) {
        return sendError(res, "Invalid organization ID format", 400);
      }
      adminSuppliedOrgId = rawQueryOrgId;
      stampOrgId = rawQueryOrgId ?? callerOrgId;
    }
    if (stampOrgId === undefined) {
      return sendError(res, "Organization context required to create a bowler", 403, 'FORBIDDEN');
    }
    if (adminSuppliedOrgId !== undefined) {
      const targetOrg = await storage.getOrganization(adminSuppliedOrgId);
      if (!targetOrg) {
        return sendError(res, "Organization not found", 404, 'NOT_FOUND');
      }
    }
    const stampedBowler = { ...bowler, organizationId: stampOrgId };

    const created = await storage.createBowler(stampedBowler);
    const orgId: number | undefined = stampOrgId;
    const synced = await runBowlerPostCreateSync(created, orgId);
    // Note: there used to be a `registerBowlerClaim` call here that
    // backed an ephemeral cross-org-hijack defense for the
    // /api/bowler-leagues bootstrap branch. Task #474 removed that
    // module: post-#342/#407 the bowler row carries an authoritative
    // `organizationId` stamp, and the bootstrap branch's
    // `bowler.organizationId === league.organizationId` gate denies
    // cross-org admins before any claim consume could fire. Same-org
    // admins are short-circuited by `hasAccessToBowler` and never
    // enter the bootstrap branch at all. See
    // docs/security/fresh-bowler-claim-removal.md for the full trace.
    sendSuccess(res, sanitizeBowler(synced), 201);
  } catch (error) {
    log.error('Error creating bowler:', error);
    if (error instanceof z.ZodError) {
      return handleZodError(res, error);
    }
    sendError(res, 'Failed to create bowler');
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const update = updateBowlerSchema.parse(req.body);

    const bowler = await storage.getBowler(id);
    if (!bowler) {
      return sendError(res, "Bowler not found", 404, 'NOT_FOUND');
    }
    
    // Sensitive write: requires self-access or admin role (org_admin/system_admin).
    // A plain "user"-role caller in the same org is NOT allowed to modify
    // another bowler's profile (task #732).
    if (!await hasSelfOrAdminAccessToBowler(req, id)) {
      return sendError(res, "You don't have access to update this bowler", 403, 'FORBIDDEN');
    }

    const merged = { ...bowler, ...update };
    let updated = await storage.updateBowler(id, merged);

    if (updated.email) {
      const emailChanged = !bowler.email || bowler.email.toLowerCase() !== updated.email.toLowerCase();

      if (emailChanged) {
        try {
          const matchingUser = await storage.getUserByEmail(updated.email);
          if (matchingUser && !matchingUser.bowlerId) {
            await storage.linkUserToBowler(matchingUser.id, id);
            log.info(`Auto-linked user ${matchingUser.id} to updated bowler ${id}`);
          }
        } catch (linkError) {
          log.error('Error auto-linking user to bowler on update:', linkError);
        }
      }

      const nameChanged = bowler.name !== updated.name;
      const needsSquareSync = !updated.paymentCustomerId || emailChanged || nameChanged;

      if (needsSquareSync) {
        try {
          const patchOrgId = req.user?.organizationId;
          const patchSquareLocation = patchOrgId ? await storage.getFirstSquareConfiguredLocation(patchOrgId) : null;
          if (patchSquareLocation?.id) {
            let providerCustomer = null;
            // Lifted out of the inner try so the post-customer
            // attribute sync (task #429) can reuse this provider.
            let patchProvider: PaymentProvider | null = null;
            try {
              patchProvider = await getPaymentProvider(patchSquareLocation.id);
              providerCustomer = await patchProvider.createOrUpdateCustomer(
                updated.name,
                updated.email,
                updated.phone,
                // Bowler reference for the Square dashboard (#429).
                `bowler:${id}`,
              );
            } catch (e) {
              if (e instanceof ProviderNotConfiguredError) {
                log.warn('Bowler update: provider not configured, skipping customer sync', { locationId: patchSquareLocation.id });
              } else {
                throw e;
              }
            }
            if (providerCustomer && providerCustomer.id !== updated.paymentCustomerId) {
              updated = await storage.updateBowler(id, {
                ...updated,
                paymentCustomerId: providerCustomer.id,
                // Stamp the originating location so account-deletion
                // can target exactly this processor for cleanup. See
                // task #346.
                paymentProviderLocationId: patchSquareLocation.id,
              });
            }
            // Custom-attribute sync (task #429). Non-fatal: failures
            // flag the bowler for the retry sweep but do NOT roll
            // back the successful customer record link above.
            if (providerCustomer && patchProvider) {
              const attrResult = await syncBowlerLeagueAttributesToProvider(
                patchProvider,
                providerCustomer.id,
                id,
              );
              if (!attrResult.ok && updated.paymentSyncPendingAt == null) {
                try {
                  updated = await storage.updateBowler(id, {
                    ...updated,
                    paymentSyncPendingAt: new Date().toISOString(),
                  });
                } catch (markErr) {
                  log.error('Bowler PATCH: failed to flag for attribute-sync retry', markErr);
                }
              }
            }
          } else {
            if (isDev) log.info('No payment-configured location found for org, skipping customer sync on update');
          }
        } catch (syncError) {
          log.error('Payment customer sync error on update:', syncError);
        }
      }
    }

    sendSuccess(res, sanitizeBowler(updated));
  } catch (error) {
    log.error('Error updating bowler:', error);
    if (error instanceof z.ZodError) {
      return handleZodError(res, error);
    }
    sendError(res, 'Failed to update bowler');
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const bowler = await storage.getBowler(id);
    if (!bowler) {
      return sendError(res, "Bowler not found", 404, 'NOT_FOUND');
    }
    
    // Sensitive write: requires self-access or admin role (org_admin/system_admin).
    // A plain "user"-role caller in the same org is NOT allowed to delete
    // another bowler's profile (task #732).
    if (!await hasSelfOrAdminAccessToBowler(req, id)) {
      return sendError(res, "You don't have access to delete this bowler", 403, 'FORBIDDEN');
    }

    await storage.deleteBowler(id);
    sendSuccess(res, null);
  } catch (error) {
    log.error('Error deleting bowler:', error);
    sendError(res, 'Failed to delete bowler', 500);
  }
});

export default router;
