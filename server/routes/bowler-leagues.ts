import { Router } from 'express';
import { storage } from '../storage';
import { insertBowlerLeagueSchema, updateBowlerLeagueSchema } from "@shared/schema";
import { z } from "zod";
import { sendSuccess, sendError, handleZodError } from '../utils/api';
import { hasAccessToLeague, hasAccessToTeam, hasAccessToBowler, isOrgOrHigher, isSystemAdmin } from '../utils/access-control.js';
import { createLogger } from '../logger';
import { fireBowlerExternalResync } from '../services/bowler-resync';

const log = createLogger("BowlerLeagues");

const router = Router();

router.get("/", async (req, res) => {
  try {
    const { bowlerId, leagueId, teamId, enriched } = req.query;

    const filters = {
      bowlerId: bowlerId ? parseInt(bowlerId as string) : undefined,
      leagueId: leagueId ? parseInt(leagueId as string) : undefined,
      teamId: teamId ? parseInt(teamId as string) : undefined
    };

    if ((bowlerId && isNaN(filters.bowlerId!)) || 
        (leagueId && isNaN(filters.leagueId!)) || 
        (teamId && isNaN(filters.teamId!))) {
      return sendError(res, "Invalid ID parameters provided", 400);
    }

    if (filters.leagueId && !(await hasAccessToLeague(req, filters.leagueId))) {
      return sendError(res, "You don't have access to this league", 403, 'FORBIDDEN');
    }
    
    if (filters.teamId && !(await hasAccessToTeam(req, filters.teamId))) {
      return sendError(res, "You don't have access to this team", 403, 'FORBIDDEN');
    }
    
    if (filters.bowlerId && !(await hasAccessToBowler(req, filters.bowlerId))) {
      return sendError(res, "You don't have access to this bowler", 403, 'FORBIDDEN');
    }

    let bowlerLeagues = await storage.getBowlerLeagues(filters);

    // When fetching all bowler-leagues with no specific filters, scope to the user's org.
    // This applies to org admins AND system admins that belong to an org.
    // Only a truly unaffiliated system admin (no organizationId) sees all entries.
    if (!filters.bowlerId && !filters.leagueId && !filters.teamId) {
      const scopedOrgId: number | null = req.user?.organizationId ?? null;
      const isUnaffiliatedSystemAdmin = req.user?.role === 'system_admin' && scopedOrgId === null;

      if (isUnaffiliatedSystemAdmin) {
        // no filtering needed
      } else if (scopedOrgId !== null) {
        const orgLeagues = await storage.getLeagues(scopedOrgId);
        const orgLeagueIds = new Set(orgLeagues.map(l => l.id));
        bowlerLeagues = bowlerLeagues.filter(bl => orgLeagueIds.has(bl.leagueId));
      } else {
        bowlerLeagues = [];
      }
    }

    if (enriched === 'true') {
      const uniqueBowlerIds = [...new Set(bowlerLeagues.map(bl => bl.bowlerId))];
      const uniqueTeamIds = [...new Set(bowlerLeagues.map(bl => bl.teamId))];
      const uniqueLeagueIds = [...new Set(bowlerLeagues.map(bl => bl.leagueId))];

      const [bowlers, teams, leagues] = await Promise.all([
        Promise.all(uniqueBowlerIds.map(id => storage.getBowler(id))),
        Promise.all(uniqueTeamIds.map(id => storage.getTeam(id))),
        Promise.all(uniqueLeagueIds.map(id => storage.getLeague(id))),
      ]);

      const bowlerMap = new Map(bowlers.filter(Boolean).map(b => [b!.id, b!]));
      const teamMap = new Map(teams.filter(Boolean).map(t => [t!.id, t!]));
      const leagueMap = new Map(leagues.filter(Boolean).map(l => [l!.id, l!]));

      const enrichedData = bowlerLeagues.map(bl => {
        const bowler = bowlerMap.get(bl.bowlerId);
        const team = teamMap.get(bl.teamId);
        const league = leagueMap.get(bl.leagueId);
        return {
          ...bl,
          bowler: bowler ? { id: bowler.id, name: bowler.name, email: bowler.email, active: bowler.active } : null,
          team: team ? { id: team.id, name: team.name, number: team.number, leagueId: team.leagueId, displayOrder: team.displayOrder, active: team.active } : null,
          league: league ? { id: league.id, name: league.name, description: league.description, active: league.active } : null,
        };
      });

      return sendSuccess(res, enrichedData);
    }

    sendSuccess(res, bowlerLeagues);
  } catch (error) {
    log.error('Error:', error);
    sendError(res, 'Failed to fetch bowler leagues');
  }
});

router.post("/", async (req, res) => {
  try {
    const data = insertBowlerLeagueSchema.parse(req.body);

    if (!(await hasAccessToLeague(req, data.leagueId))) {
      return sendError(res, "You don't have access to this league", 403, 'FORBIDDEN');
    }

    if (!(await hasAccessToTeam(req, data.teamId))) {
      return sendError(res, "You don't have access to this team", 403, 'FORBIDDEN');
    }

    let bootstrapPath = false;
    if (!(await hasAccessToBowler(req, data.bowlerId))) {
      // Bootstrap exception (org-stamp gate).
      //
      // A freshly created bowler that has zero league entries fails the
      // regular access check via the legacy league-scan fallback path
      // (no shared league with the caller), so the public API would
      // otherwise have no way to attach a brand-new bowler to its first
      // league. Production bootstrap paths (bulk import, season clone)
      // call `storage.createBowlerLeague` directly to dodge the same
      // chicken-egg problem.
      //
      // History: pre-#342 this branch was gated by an in-memory
      // creation-time claim token registered at POST /api/bowlers.
      // Tasks #342 / #407 added an authoritative `organizationId`
      // stamp on every bowler row (NOT NULL at the DB layer). Once
      // that stamp existed, `hasAccessToBowler` short-circuits true
      // for any same-org caller before this branch is even entered,
      // and the cross-org caller is now denied below by the strict
      // bowler-stamp / target-league-stamp equality check. Task #474
      // therefore removed the claim-token module entirely (it was
      // unreachable in every legitimate or attack scenario, and its
      // in-memory map could not survive a multi-process deploy).
      // See docs/security/fresh-bowler-claim-removal.md for the full
      // reachability trace.
      //
      // Gates (all must pass):
      //   1. Caller is org_admin or system_admin. Bowler-role users
      //      that passed `hasAccessToTeam` via the league
      //      self-membership shortcut must not be able to claim other
      //      bowlers here.
      //   2. The bowler row exists and its stamped `organizationId`
      //      strictly matches the target league's `organizationId`.
      //      Org-less leagues still deny (per the org-less policy).
      //   3. Caller-org alignment: a non-system-admin caller's own
      //      `organizationId` must equal the bowler's stamp. This
      //      replaces the pre-#474 claim-token check that required
      //      `token.orgId === u.organizationId`. Without it, an org_admin
      //      with a personal `bowlerId` in another org's league could
      //      pass `hasAccessToLeague` / `hasAccessToTeam` via the league
      //      self-membership shortcut (access-control.ts:74-79) into
      //      that other org, then ride gate 2 (bowler.org === league.org
      //      both equal to the OTHER org) to bootstrap-hijack a fresh
      //      bowler in an org they are not an admin of. System admins
      //      are exempt because `hasAccessToBowler` short-circuits TRUE
      //      for them at access-control.ts:150 and they never reach
      //      this branch; the exemption is purely defensive. See
      //      docs/security/fresh-bowler-claim-removal.md.
      //
      // Every failure mode collapses to the same 403 to avoid leaking
      // which gate denied (existence oracle, org-mismatch oracle,
      // etc.).
      if (!isOrgOrHigher(req.user)) {
        return sendError(res, "You don't have access to this bowler", 403, 'FORBIDDEN');
      }
      const bowlerRow = await storage.getBowler(data.bowlerId);
      const targetLeague = await storage.getLeague(data.leagueId);
      if (
        !bowlerRow ||
        !targetLeague ||
        targetLeague.organizationId === null ||
        bowlerRow.organizationId !== targetLeague.organizationId ||
        (!isSystemAdmin(req.user) && req.user?.organizationId !== bowlerRow.organizationId)
      ) {
        return sendError(res, "You don't have access to this bowler", 403, 'FORBIDDEN');
      }
      // OK: org/system admin, bowler stamp matches league org, caller
      // org aligned with bowler stamp (or caller is sysadmin).
      bootstrapPath = true;
    }

    if (bootstrapPath) {
      // Bootstrap path: do the "bowler is free-floating" check and the
      // insert atomically (task #343). Two admins racing to bootstrap
      // the same fresh bowler used to be able to both pass a separate
      // count check and both insert links, producing unintended
      // multi-affiliation in the few-millisecond window before either
      // insert landed. The storage helper wraps both in a transaction
      // with `SELECT ... FOR UPDATE` on the bowler row, so racing
      // bootstrap attempts serialize and only the first observes the
      // bowler as free. Any other request gets null back (mapped to
      // the same 400 the non-atomic check used to return).
      const created = await storage.createBowlerLeagueIfBowlerFree(data);
      if (!created) {
        return sendError(res, "Bowler is already in this league", 400);
      }
      // Push updated league_name/league_season to Square + BowlNow
      // (task #429). Fire-and-forget — never blocks the response.
      fireBowlerExternalResync(created.bowlerId, req.user?.organizationId);
      return sendSuccess(res, created, 201);
    }

    // Non-bootstrap path: caller already has access to this bowler via
    // the normal access-control rules, so additional league memberships
    // are allowed. We still guard against duplicate (bowler, league)
    // pairs — but the historic two-step check (getBowlerLeagues then
    // createBowlerLeague) was a check-then-insert race that double-
    // clicked submits and React Query retries could slip through,
    // landing two rows for the same (bowler, league) pair before either
    // insert committed (task #473). Use the atomic helper that wraps
    // both in one transaction with `SELECT ... FOR UPDATE` on the
    // bowler row, so concurrent attempts serialize and only the first
    // observes the pair as missing.
    const created = await storage.createBowlerLeagueIfNotInLeague(data);
    if (!created) {
      return sendError(res, "Bowler is already in this league", 400);
    }
    // Push updated league_name/league_season to Square + BowlNow
    // (task #429). Fire-and-forget — never blocks the response.
    fireBowlerExternalResync(created.bowlerId, req.user?.organizationId);
    sendSuccess(res, created, 201);
  } catch (error) {
    log.error('Error:', error);
    if (error instanceof z.ZodError) {
      return handleZodError(res, error);
    }
    sendError(res, 'Failed to create bowler league');
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return sendError(res, "Invalid ID provided");
    }

    const bowlerLeague = await storage.getBowlerLeague(id);
    if (!bowlerLeague) {
      return sendError(res, "Bowler league not found", 404, 'NOT_FOUND');
    }

    if (!(await hasAccessToLeague(req, bowlerLeague.leagueId))) {
      return sendError(res, "You don't have access to this league", 403, 'FORBIDDEN');
    }

    if (!(await hasAccessToTeam(req, bowlerLeague.teamId))) {
      return sendError(res, "You don't have access to this team", 403, 'FORBIDDEN');
    }

    if (!(await hasAccessToBowler(req, bowlerLeague.bowlerId))) {
      return sendError(res, "You don't have access to this bowler", 403, 'FORBIDDEN');
    }

    const update = updateBowlerLeagueSchema.parse(req.body);

    if (update.teamId && !(await hasAccessToTeam(req, update.teamId))) {
      return sendError(res, "You don't have access to the target team", 403, 'FORBIDDEN');
    }

    const updated = await storage.updateBowlerLeague(id, update);
    if (!updated) {
      return sendError(res, "Bowler league not found", 404, 'NOT_FOUND');
    }
    // Re-sync attrs even on team moves: cheap idempotent upsert and
    // catches the active=false toggle that DOES change `league_name`
    // (task #429).
    fireBowlerExternalResync(updated.bowlerId, req.user?.organizationId);
    sendSuccess(res, updated);
  } catch (error) {
    log.error('Error:', error);
    if (error instanceof z.ZodError) {
      return handleZodError(res, error);
    }
    sendError(res, 'Failed to update bowler league');
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return sendError(res, "Invalid ID provided", 400);
    }

    const bowlerLeague = await storage.getBowlerLeague(id);
    if (!bowlerLeague) {
      return sendError(res, "Bowler league not found", 404, 'NOT_FOUND');
    }

    if (!(await hasAccessToLeague(req, bowlerLeague.leagueId))) {
      return sendError(res, "You don't have access to this league", 403, 'FORBIDDEN');
    }

    if (!(await hasAccessToTeam(req, bowlerLeague.teamId))) {
      return sendError(res, "You don't have access to this team", 403, 'FORBIDDEN');
    }

    if (!(await hasAccessToBowler(req, bowlerLeague.bowlerId))) {
      return sendError(res, "You don't have access to this bowler", 403, 'FORBIDDEN');
    }

    // Capture the bowler id BEFORE the delete so we still have it
    // for the resync call below. After delete, the row is gone and
    // we'd have to swap it for an extra storage round trip.
    const affectedBowlerId = bowlerLeague.bowlerId;
    const deleted = await storage.deleteBowlerLeague(id);
    if (!deleted) {
      return sendError(res, "Bowler league not found", 404, 'NOT_FOUND');
    }

    // Re-push updated league_name/league_season (the bowler may now
    // be in 0 leagues — we still write "" to clear the value rather
    // than leave stale data on the Square customer record). Task #429.
    fireBowlerExternalResync(affectedBowlerId, req.user?.organizationId);

    sendSuccess(res, { message: "Bowler league deleted successfully" }, 200);
  } catch (error) {
    log.error('Error:', error);
    sendError(res, 'Failed to delete bowler league');
  }
});

router.patch("/:id/order", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { newOrder } = req.body;

    if (isNaN(id)) {
      return sendError(res, "Invalid bowler league ID", 400);
    }

    if (typeof newOrder !== 'number') {
      return sendError(res, "New order must be a number", 400);
    }

    const bowlerLeague = await storage.getBowlerLeague(id);
    if (!bowlerLeague) {
      return sendError(res, "Bowler league not found", 404, 'NOT_FOUND');
    }

    if (!(await hasAccessToLeague(req, bowlerLeague.leagueId))) {
      return sendError(res, "You don't have access to this league", 403, 'FORBIDDEN');
    }

    if (!(await hasAccessToTeam(req, bowlerLeague.teamId))) {
      return sendError(res, "You don't have access to this team", 403, 'FORBIDDEN');
    }

    const updated = await storage.updateBowlerLeagueOrder(id, newOrder);
    sendSuccess(res, updated);
  } catch (error) {
    log.error('Error:', error);
    sendError(res, 'Failed to update bowler league order');
  }
});

export default router;
