import { Router } from "express";
import { z } from "zod";
import { getCanonicalActivationSource, activateCanonicalFinancials, FinancialActivationError, FinancialReadIncompatibilityError, readCanonicalDuePastDue } from "../services/canonical-due-past-due.js";
import { getPaymentManagerAccessibleLeagueIds, hasAdminAccessToLeague, hasPaymentManagerAccessToLeague, isPaymentManager } from "../utils/access-control.js";
import { sendError, sendSuccess } from "../utils/api.js";
import { storage } from "../storage/index.js";
import { db } from "../db.js";
import { bowlers, bowlerLeagues, teams } from "@shared/schema";
import { and, eq } from "drizzle-orm";
import { financialActivationEnabled } from "../config.js";
import type { FinancialOrganizationDuePastDueContract } from "@shared/financial-contract";

const router = Router();
// F1 activation is deliberately dormant until legacy payment reconciliation and
// the operational rollout gate are separately approved. No production env change
// enables this flag.
const positiveInt = z.number().int().positive();
const responsibilitySchema = z.object({
  occurrenceId: z.string().uuid(),
  teamId: positiveInt,
  slotIndex: z.number().int().min(0).max(3),
  bowlerId: positiveInt,
  role: z.enum(["regular", "substitute"]),
  provenance: z.literal("explicit_admin_selection"),
}).strict();
function queryPositiveInt(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
function rejectUnknownQueryKeys(req: { query: Record<string, unknown> }, allowed: readonly string[]): boolean {
  return Object.keys(req.query).some((key) => !allowed.includes(key));
}
const activationSchema = z.object({
  commandKey: z.string().trim().min(1).max(255),
  sourceFingerprint: z.string().trim().min(1).max(128),
  payingLineupSize: z.union([z.literal(3), z.literal(4)]),
  responsibilities: z.array(responsibilitySchema),
}).strict();

router.get("/due-past-due", async (req, res) => {
  if (rejectUnknownQueryKeys(req, ["organizationId"])) return sendError(res, "Invalid scope", 400, "INVALID_SCOPE");
  const requestedOrganizationId = queryPositiveInt(req.query.organizationId);
  if (requestedOrganizationId === null) return sendError(res, "Invalid scope", 400, "INVALID_SCOPE");
  if (req.user?.role === "system_admin" && (requestedOrganizationId === undefined || !Number.isSafeInteger(requestedOrganizationId) || requestedOrganizationId <= 0)) return sendError(res, "Organization scope is required", 400, "INVALID_SCOPE");
  if (req.user?.role !== "system_admin" && req.user?.role !== "org_admin" && !isPaymentManager(req.user)) return sendError(res, "Not found", 404, "NOT_FOUND");
  if (req.user?.role !== "system_admin" && requestedOrganizationId !== undefined && requestedOrganizationId !== req.user?.organizationId) return sendError(res, "Not found", 404, "NOT_FOUND");
  const organizationId = req.user?.role === "system_admin" ? requestedOrganizationId : req.user?.organizationId;
  if (!organizationId || !Number.isSafeInteger(organizationId) || organizationId <= 0) return sendError(res, "Not found", 404, "NOT_FOUND");
  try {
    const leagues = await storage.getLeagues(organizationId);
    const paymentManagerLeagueIds = isPaymentManager(req.user)
      ? new Set(await getPaymentManagerAccessibleLeagueIds(req))
      : null;
    const reports = await Promise.all(leagues
      .filter((league) => league.organizationId === organizationId)
      .filter((league) => paymentManagerLeagueIds === null || paymentManagerLeagueIds.has(league.id))
      .sort((a, b) => a.id - b.id)
      .map(async (league) => ({ leagueId: league.id, name: league.name, report: await readCanonicalDuePastDue({ organizationId, leagueId: league.id, bowlerId: undefined }) })));
    const response: FinancialOrganizationDuePastDueContract = { contractVersion: "canonical-due-past-due/1", orderVersion: "due-at,bowler,occurrence,obligation/1", organizationId, authoritativeSource: "per-league-snapshots", leagues: reports };
    return sendSuccess(res, response);
  } catch (error) {
    if (error instanceof FinancialReadIncompatibilityError) return sendError(res, "Financial evidence requires review", 409, "FINANCIAL_EVIDENCE_INCOMPATIBLE");
    return sendError(res, "Unable to read financial evidence", 500, "INTERNAL_ERROR");
  }
});

router.get("/leagues/:leagueId/source", async (req, res) => {
  if (rejectUnknownQueryKeys(req, ["organizationId"])) return sendError(res, "Not found", 404, "NOT_FOUND");
  const leagueId = Number(req.params.leagueId);
  if (!Number.isSafeInteger(leagueId) || leagueId <= 0) return sendError(res, "Not found", 404, "NOT_FOUND");
  const requestedOrganizationId = queryPositiveInt(req.query.organizationId);
  if (requestedOrganizationId === null) return sendError(res, "Invalid scope", 400, "INVALID_SCOPE");
  if (req.user?.role === "system_admin" && (requestedOrganizationId === undefined || !Number.isSafeInteger(requestedOrganizationId) || requestedOrganizationId <= 0)) return sendError(res, "Organization scope is required", 400, "INVALID_SCOPE");
  const league = await storage.getLeague(leagueId);
  if (!league || league.organizationId === null || (requestedOrganizationId !== undefined && requestedOrganizationId !== league.organizationId) || !(await hasAdminAccessToLeague(req, leagueId))) return sendError(res, "Not found", 404, "NOT_FOUND");
  const organizationId = league.organizationId;
  if (organizationId === null) return sendError(res, "Not found", 404, "NOT_FOUND");
  let source;
  try { source = await getCanonicalActivationSource({ organizationId, leagueId }); }
  catch { return sendError(res, "Financial source is unavailable", 409, "FINANCIAL_EVIDENCE_INCOMPATIBLE"); }
  const teamRows = await db.select({ id: teams.id, name: teams.name }).from(teams).where(and(eq(teams.leagueId, leagueId), eq(teams.active, true)));
  const teamNames = new Map(teamRows.map((team) => [team.id, team.name]));
  return sendSuccess(res, { contractVersion: "canonical-due-past-due/1", orderVersion: "occurrence-team-slot-bowler/1", activationVersion: 1, organizationId, leagueId, authoritativeSource: "canonical", sourceFingerprint: source.sourceFingerprint, expected: source.expected.map((row) => ({ ...row, teamName: teamNames.get(row.teamId) ?? "Team" })) });
});

router.get("/leagues/:leagueId/roster", async (req, res) => {
  if (rejectUnknownQueryKeys(req, ["organizationId"])) return sendError(res, "Not found", 404, "NOT_FOUND");
  const leagueId = Number(req.params.leagueId);
  if (!Number.isSafeInteger(leagueId) || leagueId <= 0) return sendError(res, "Not found", 404, "NOT_FOUND");
  const requestedOrganizationId = queryPositiveInt(req.query.organizationId);
  if (requestedOrganizationId === null) return sendError(res, "Invalid scope", 400, "INVALID_SCOPE");
  if (req.user?.role === "system_admin" && (requestedOrganizationId === undefined || !Number.isSafeInteger(requestedOrganizationId) || requestedOrganizationId <= 0)) return sendError(res, "Organization scope is required", 400, "INVALID_SCOPE");
  const league = await storage.getLeague(leagueId);
  if (!league || league.organizationId === null || (requestedOrganizationId !== undefined && requestedOrganizationId !== league.organizationId) || !(await hasAdminAccessToLeague(req, leagueId))) return sendError(res, "Not found", 404, "NOT_FOUND");
  const rows = await db.select({ bowlerId: bowlers.id, name: bowlers.name }).from(bowlers)
    .innerJoin(bowlerLeagues, and(eq(bowlerLeagues.bowlerId, bowlers.id), eq(bowlerLeagues.leagueId, leagueId), eq(bowlerLeagues.active, true)))
    .where(and(eq(bowlers.organizationId, league.organizationId), eq(bowlers.active, true)))
    .orderBy(bowlers.name, bowlers.id);
  return sendSuccess(res, rows);
});

router.post("/leagues/:leagueId/activate", async (req, res) => {
  if (rejectUnknownQueryKeys(req, ["organizationId"])) return sendError(res, "Not found", 404, "NOT_FOUND");
  const leagueId = Number(req.params.leagueId);
  if (!Number.isSafeInteger(leagueId) || leagueId <= 0 || !req.user) return sendError(res, "Not found", 404, "NOT_FOUND");
  const requestedOrganizationId = queryPositiveInt(req.query.organizationId);
  if (requestedOrganizationId === null) return sendError(res, "Invalid scope", 400, "INVALID_SCOPE");
  if (req.user.role === "system_admin" && (requestedOrganizationId === undefined || !Number.isSafeInteger(requestedOrganizationId) || requestedOrganizationId <= 0)) return sendError(res, "Organization scope is required", 400, "INVALID_SCOPE");
  const league = await storage.getLeague(leagueId);
  if (!league || league.organizationId === null || (requestedOrganizationId !== undefined && requestedOrganizationId !== league.organizationId) || !(await hasAdminAccessToLeague(req, leagueId))) return sendError(res, "Not found", 404, "NOT_FOUND");
  if (!financialActivationEnabled) return sendError(res, "Activation is unavailable pending financial rollout", 409, "FINANCIAL_ACTIVATION_UNAVAILABLE");
  const parsed = activationSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, "Invalid activation request", 400, "INVALID_REQUEST");
  try {
    const result = await activateCanonicalFinancials({ ...parsed.data, organizationId: league.organizationId, leagueId, actorUserId: req.user.id });
    return sendSuccess(res, result, 201);
  } catch (error) {
    if (error instanceof FinancialActivationError) {
      const status = error.code === "idempotency_conflict" || error.code === "already_activated" || error.code === "stale_source" || error.code === "reconciliation_required" ? 409 : 422;
      return sendError(res, status === 409 ? "Activation conflicts with existing evidence" : "Activation could not be completed", status, status === 409 ? "CONFLICT" : "INVALID_ACTIVATION");
    }
    return sendError(res, "Activation could not be completed", 500, "INTERNAL_ERROR");
  }
});

router.get("/leagues/:leagueId/due-past-due", async (req, res) => {
  if (rejectUnknownQueryKeys(req, ["organizationId", "bowlerId"])) return sendError(res, "Not found", 404, "NOT_FOUND");
  const leagueId = Number(req.params.leagueId);
  if (!Number.isSafeInteger(leagueId) || leagueId <= 0 || !req.user) return sendError(res, "Not found", 404, "NOT_FOUND");
  const requestedOrganizationId = queryPositiveInt(req.query.organizationId);
  if (requestedOrganizationId === null) return sendError(res, "Invalid scope", 400, "INVALID_SCOPE");
  if (req.user.role === "system_admin" && (requestedOrganizationId === undefined || !Number.isSafeInteger(requestedOrganizationId) || requestedOrganizationId <= 0)) return sendError(res, "Organization scope is required", 400, "INVALID_SCOPE");
  const league = await storage.getLeague(leagueId);
  if (!league || league.organizationId === null || (requestedOrganizationId !== undefined && requestedOrganizationId !== league.organizationId)) return sendError(res, "Not found", 404, "NOT_FOUND");
  if (req.user.role !== "system_admin" && req.user.organizationId !== league.organizationId) return sendError(res, "Not found", 404, "NOT_FOUND");
  const isAdmin = await hasAdminAccessToLeague(req, leagueId)
    || await hasPaymentManagerAccessToLeague(req, leagueId);
  if (isPaymentManager(req.user) && !await hasPaymentManagerAccessToLeague(req, leagueId)) {
    return sendError(res, "Not found", 404, "NOT_FOUND");
  }
  const requestedBowler = queryPositiveInt(req.query.bowlerId);
  if (requestedBowler === null) return sendError(res, "Not found", 404, "NOT_FOUND");
  if (requestedBowler !== undefined && (!Number.isSafeInteger(requestedBowler) || requestedBowler <= 0)) return sendError(res, "Not found", 404, "NOT_FOUND");
  if (isPaymentManager(req.user) && requestedBowler !== undefined) {
    const [membership] = await db.select({ bowlerId: bowlerLeagues.bowlerId })
      .from(bowlerLeagues)
      .innerJoin(bowlers, and(eq(bowlers.id, bowlerLeagues.bowlerId), eq(bowlers.organizationId, league.organizationId)))
      .where(and(
        eq(bowlerLeagues.leagueId, leagueId),
        eq(bowlerLeagues.bowlerId, requestedBowler),
        eq(bowlerLeagues.active, true),
        eq(bowlers.active, true),
      ))
      .limit(1);
    if (!membership) return sendError(res, "Not found", 404, "NOT_FOUND");
  }
  if (!isAdmin) {
    if (!req.user.bowlerId || (requestedBowler !== undefined && requestedBowler !== req.user.bowlerId)) return sendError(res, "Not found", 404, "NOT_FOUND");
    const [membership] = await db.select({ bowlerId: bowlerLeagues.bowlerId }).from(bowlerLeagues)
      .innerJoin(bowlers, and(eq(bowlers.id, bowlerLeagues.bowlerId), eq(bowlers.organizationId, league.organizationId)))
      .where(and(eq(bowlerLeagues.leagueId, leagueId), eq(bowlerLeagues.bowlerId, req.user.bowlerId), eq(bowlerLeagues.active, true), eq(bowlers.active, true)))
      .limit(1);
    if (!membership) return sendError(res, "Not found", 404, "NOT_FOUND");
  }
  if (!isAdmin && requestedBowler === undefined) return sendError(res, "Not found", 404, "NOT_FOUND");
  const bowlerId = isAdmin ? requestedBowler : req.user.bowlerId;
  try {
    const result = await readCanonicalDuePastDue({ organizationId: league.organizationId, leagueId, bowlerId: bowlerId ?? undefined });
    return sendSuccess(res, result);
  } catch (error) {
    if (error instanceof FinancialReadIncompatibilityError) return sendError(res, "Financial evidence requires review", 409, "FINANCIAL_EVIDENCE_INCOMPATIBLE");
    return sendError(res, "Unable to read financial evidence", 500, "INTERNAL_ERROR");
  }
});

export default router;
