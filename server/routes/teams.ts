import { Router } from 'express';
import { storage } from '../storage';
import { insertTeamSchema, updateTeamSchema, reorderTeamsSchema, type Team } from "@shared/schema";
import { z } from "zod";
import { sendSuccess, sendError, handleZodError, parseOptionalIntParam, sanitizeBowler } from '../utils/api.js';
import { hasAdminAccessToLeague, isOrgOrHigher } from '../utils/access-control.js';
import { createLogger } from '../logger';

const log = createLogger("Teams");
const router = Router();

router.get("/", async (req, res) => {
  try {
    // task #421: reject malformed `?leagueId` up front instead of
    // forwarding NaN into `storage.getLeague` (which would surface as
    // a confusing 404 in the logs and an empty teams list).
    const leagueId = parseOptionalIntParam(req.query.leagueId);
    if (leagueId === null) {
      return sendError(res, "Invalid league ID format", 400);
    }
    
    // If a league ID is provided, we need to check if the user has access to that league
    let teams: Team[] = [];
    
    if (leagueId) {
      // First, get the league to check its organization
      const league = await storage.getLeague(leagueId);
      
      if (!league) {
        return sendError(res, "League not found", 404, 'NOT_FOUND');
      }
      
      // Org-less resource policy (see server/utils/access-control.ts):
      // deny org-less rows for everyone, including system_admin.
      if (league.organizationId === null) {
        return sendError(res, "You don't have access to this league", 403, 'FORBIDDEN');
      }

      // Team lists require administrative access to the league.
      const userHasAccess = await hasAdminAccessToLeague(req, leagueId);
      if (userHasAccess) {
        teams = await storage.getTeams(leagueId);
      } else {
        return sendError(res, "You don't have access to this league", 403, 'FORBIDDEN');
      }
    } else {
      // If no league ID, scope to the user's org (applies to org admins AND system admins
      // that belong to an org). Only a truly unaffiliated system admin sees all teams.
      const scopedOrgId: number | null = req.user?.organizationId ?? null;

      if (req.user?.role === 'system_admin' && scopedOrgId === null) {
        // Unaffiliated system admin: see all teams whose parent league has
        // an organization. Org-less teams are excluded per the policy in
        // server/utils/access-control.ts and only surface via the
        // /api/system-admin/orphaned-data-counts diagnostic endpoint.
        const allLeagues = await storage.getAllLeaguesSystemAdmin();
        const orgScopedLeagueIds = new Set(
          allLeagues.filter(l => l.organizationId !== null).map(l => l.id),
        );
        const allTeams = await storage.getTeams();
        teams = allTeams.filter(t => orgScopedLeagueIds.has(t.leagueId));
      } else if (scopedOrgId !== null) {
        // Org admins and affiliated system admins see all teams across the org.
        // Plain users cannot use this organization-wide listing surface.
        if (isOrgOrHigher(req.user)) {
          const leagues = await storage.getLeagues(scopedOrgId);
          const teamPromises = leagues.map(league => storage.getTeams(league.id));
          const teamsArrays = await Promise.all(teamPromises);
          teams = teamsArrays.flat();
        } else {
          teams = [];
        }
      } else {
        teams = [];
      }
    }
    
    sendSuccess(res, teams);
  } catch (error) {
    sendError(res, 'Failed to fetch teams');
  }
});

router.patch("/reorder", async (req, res) => {
  try {
    const { teams: teamUpdates } = reorderTeamsSchema.parse(req.body);

    if (teamUpdates.length === 0) {
      return sendSuccess(res, null);
    }

    const uniqueIds = new Set(teamUpdates.map(t => t.id));
    if (uniqueIds.size !== teamUpdates.length) {
      return sendError(res, "Duplicate team IDs in payload", 400, 'VALIDATION_ERROR');
    }

    const teamIds = teamUpdates.map(t => t.id);
    const existingTeams = await storage.getTeamsByIds(teamIds);

    if (existingTeams.length !== teamUpdates.length) {
      return sendError(res, "One or more teams not found", 404, 'NOT_FOUND');
    }

    const leagueIds = new Set(existingTeams.map(t => t.leagueId));
    if (leagueIds.size !== 1) {
      return sendError(res, "All teams must belong to the same league", 400, 'VALIDATION_ERROR');
    }

    const leagueId = [...leagueIds][0];
    const league = await storage.getLeague(leagueId);
    if (!league) {
      return sendError(res, "League not found", 404, 'NOT_FOUND');
    }

    // Org-less resource policy (see server/utils/access-control.ts):
    // deny org-less rows for everyone, including system_admin.
    if (league.organizationId === null) {
      return sendError(res, "You don't have access to this league", 403, 'FORBIDDEN');
    }

    if (!(await hasAdminAccessToLeague(req, leagueId))) {
      return sendError(res, "You don't have access to this league", 403, 'FORBIDDEN');
    }

    await storage.reorderTeams(teamUpdates);
    sendSuccess(res, null);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return handleZodError(res, error);
    }
    sendError(res, 'Failed to reorder teams');
  }
});

router.get("/:id/details", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const team = await storage.getTeam(id);

    if (!team) {
      return sendError(res, "Team not found", 404, 'NOT_FOUND');
    }

    const league = await storage.getLeague(team.leagueId);

    if (!league) {
      return sendError(res, "League not found", 404, 'NOT_FOUND');
    }

    // Org-less resource policy (see server/utils/access-control.ts):
    // deny org-less rows for everyone, including system_admin.
    if (league.organizationId === null) {
      return sendError(res, "You don't have access to this league", 403, 'FORBIDDEN');
    }

    if (!(await hasAdminAccessToLeague(req, team.leagueId))) {
      return sendError(res, "You don't have access to this team", 403, 'FORBIDDEN');
    }

    const bowlerLeagues = await storage.getBowlerLeagues({ teamId: id, leagueId: team.leagueId });

    const bowlerIds = [...new Set(bowlerLeagues.map(bl => bl.bowlerId))];
    const rawBowlers = bowlerIds.length > 0
      ? await storage.getBowlersByIds(bowlerIds)
      : [];

    const linkedStatuses = await Promise.all(
      rawBowlers.map(b => storage.isBowlerLinked(b.id))
    );
    // task #381: project before spreading so paymentProviderLocationId
    // (and any future sensitive column on
    // `bowlers`) cannot ride along on the team-details payload.
    const bowlers = rawBowlers.map((b, i) => ({ ...sanitizeBowler(b), hasAccount: linkedStatuses[i] }));

    sendSuccess(res, { team, league, bowlerLeagues, bowlers });
  } catch (error) {
    sendError(res, 'Failed to fetch team details');
  }
});

router.get("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const team = await storage.getTeam(id);
    
    if (!team) {
      return sendError(res, "Team not found", 404, 'NOT_FOUND');
    }
    
    // Get the team's league to check its organization
    const league = await storage.getLeague(team.leagueId);
    
    if (!league) {
      return sendError(res, "League not found", 404, 'NOT_FOUND');
    }
    
    // Org-less resource policy (see server/utils/access-control.ts):
    // deny org-less rows for everyone, including system_admin.
    if (league.organizationId === null) {
      return sendError(res, "You don't have access to this league", 403, 'FORBIDDEN');
    }

    if (!(await hasAdminAccessToLeague(req, team.leagueId))) {
      return sendError(res, "You don't have access to this team", 403, 'FORBIDDEN');
    }
    
    sendSuccess(res, team);
  } catch (error) {
    sendError(res, 'Failed to fetch team');
  }
});

router.post("/", async (req, res) => {
  try {
    const team = insertTeamSchema.parse(req.body);
    
    // Check if user has access to the league
    const league = await storage.getLeague(team.leagueId);
    
    if (!league) {
      return sendError(res, "League not found", 404, 'NOT_FOUND');
    }
    
    // Org-less resource policy (see server/utils/access-control.ts):
    // deny org-less rows for everyone, including system_admin.
    if (league.organizationId === null) {
      return sendError(res, "You don't have access to this league", 403, 'FORBIDDEN');
    }

    if (!(await hasAdminAccessToLeague(req, team.leagueId))) {
      return sendError(res, "You don't have access to this league", 403, 'FORBIDDEN');
    }
    
    const created = await storage.createTeam(team);
    sendSuccess(res, created, 201);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return handleZodError(res, error);
    }
    sendError(res, 'Failed to create team');
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    
    // Get team to verify organization access
    const team = await storage.getTeam(id);
    
    if (!team) {
      return sendError(res, "Team not found", 404, 'NOT_FOUND');
    }
    
    // Check if user has access to the league
    const league = await storage.getLeague(team.leagueId);
    
    if (!league) {
      return sendError(res, "League not found", 404, 'NOT_FOUND');
    }
    
    // Org-less resource policy (see server/utils/access-control.ts):
    // deny org-less rows for everyone, including system_admin.
    if (league.organizationId === null) {
      return sendError(res, "You don't have access to this league", 403, 'FORBIDDEN');
    }

    if (!(await hasAdminAccessToLeague(req, team.leagueId))) {
      return sendError(res, "You don't have access to this team", 403, 'FORBIDDEN');
    }
    
    const update = updateTeamSchema.parse(req.body);
    const updated = await storage.updateTeam(id, update);

    if ('active' in update) {
      await storage.renumberActiveTeams(team.leagueId);
    }

    sendSuccess(res, updated);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return handleZodError(res, error);
    }
    sendError(res, 'Failed to update team');
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    
    // Get team to verify organization access
    const team = await storage.getTeam(id);
    
    if (!team) {
      return sendError(res, "Team not found", 404, 'NOT_FOUND');
    }
    
    // Check if user has access to the league
    const league = await storage.getLeague(team.leagueId);
    
    if (!league) {
      return sendError(res, "League not found", 404, 'NOT_FOUND');
    }
    
    // Org-less resource policy (see server/utils/access-control.ts):
    // deny org-less rows for everyone, including system_admin.
    if (league.organizationId === null) {
      return sendError(res, "You don't have access to this league", 403, 'FORBIDDEN');
    }

    if (!(await hasAdminAccessToLeague(req, team.leagueId))) {
      return sendError(res, "You don't have access to this team", 403, 'FORBIDDEN');
    }
    
    const leagueId = team.leagueId;
    await storage.deleteTeam(id);
    await storage.renumberActiveTeams(leagueId);
    sendSuccess(res, null);
  } catch (error) {
    log.error('Error deleting team:', error);
    sendError(res, 'Failed to delete team', 500);
  }
});

export default router;
