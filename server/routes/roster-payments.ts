import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
  canonicalCorrectionRequestSchema,
  canonicalManualRecordRequestSchema,
  interactiveObligationChargeRequestV2Schema,
  interactiveObligationQuoteRequestV2Schema,
  rosterPaymentResponsibilityRequestSchema,
  occurrenceResponsibilityInputSchema,
} from "@shared/roster-payment-contract";
import { hasAccessToLeague, hasAdminAccessToLeague, hasPaymentManagerAccessToLeague } from "../utils/access-control.js";
import { canUserPayForBowler } from "../utils/bowler-payment-authz.js";
import { sendError, sendSuccess } from "../utils/api.js";
import { storage } from "../storage/index.js";
import { adminWriteLimiter, paymentWriteLimiter } from "../middleware/rate-limit.js";
import {
  correctCanonicalAllocation,
  chargeInteractiveObligations,
  quoteInteractiveObligations,
  readCanonicalDuePastDue,
  readRosterPaymentResponsibility,
  recordCanonicalManualPayment,
  recordOccurrenceResponsibilities,
  RosterPaymentError,
  RosterPaymentReplay,
  saveTeamRoster,
} from "../services/roster-payment-core.js";

const router = Router();

function leagueIdParam(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function authorizedLeague(req: Request, leagueId: number, management = false, adminOnly = false) {
  const league = await storage.getLeague(leagueId);
  if (!league || league.organizationId === null || req.user?.organizationId !== league.organizationId && req.user?.role !== "system_admin") return null;
  if (management) {
    if (adminOnly ? !(await hasAdminAccessToLeague(req, leagueId)) : !(await hasAdminAccessToLeague(req, leagueId)) && !(await hasPaymentManagerAccessToLeague(req, leagueId))) return null;
  } else if (!(await hasAccessToLeague(req, leagueId))) {
    return null;
  }
  return league;
}

async function paymentScope(req: Request, leagueId: number, obligationIds: string[]) {
  const league = await authorizedLeague(req, leagueId);
  if (!league || league.organizationId === null) return null;
  const privileged = await hasAdminAccessToLeague(req, leagueId) || await hasPaymentManagerAccessToLeague(req, leagueId) || req.user?.role === "system_admin";
  if (!privileged) {
    let quote;
    try {
      quote = await quoteInteractiveObligations({ organizationId: league.organizationId, leagueId, obligationIds, payerBowlerId: req.user?.bowlerId ?? undefined });
    } catch {
      // Obligation existence, ownership, and state are deliberately folded
      // into the same not-found response for an unprivileged caller.
      return null;
    }
    for (const obligation of quote.obligations) {
      const allowed = await canUserPayForBowler(req, obligation.payerBowlerId);
      if (!allowed.allowed) return null;
    }
  }
  return league;
}

function handleError(res: Response, error: unknown): void {
  if (error instanceof RosterPaymentReplay) {
    sendSuccess(res, rosterWireResult(error.result));
    return;
  }
  if (error instanceof RosterPaymentError) {
    sendError(res, error.message, error.status, error.code);
    return;
  }
  sendError(res, "Unable to process roster payment evidence", 500, "INTERNAL_ERROR");
}

/** Explicit wire projection for roster finance commands. Persistence rows may
 * contain provider identifiers, encrypted sources, and audit-only fields;
 * none of those are part of the roster contracts. */
type WireObject = Record<string, unknown>;

function wireObject(value: unknown): WireObject | null {
  return typeof value === "object" && value !== null ? value as WireObject : null;
}

function rosterWireResult(value: unknown): Record<string, unknown> {
  const source = wireObject(value) ?? {};
  const base: Record<string, unknown> = {};
  for (const key of ["contractVersion", "organizationId", "leagueId", "teamId", "ready", "commandKey", "requestFingerprint", "mode", "restoredObligationId"]) {
    if (source[key] !== undefined) base[key] = source[key];
  }
  if (source.operationId !== undefined) {
    base.operationId = source.operationId;
    base.status = source.status;
  }
  if (Array.isArray(source.slots)) base.slots = source.slots.map((slot) => {
    const row = wireObject(slot) ?? {};
    return { id: row.id, teamId: row.teamId, slotIndex: row.slotIndex, occupant: row.occupant, mainBowlerId: row.mainBowlerId ?? null };
  });
  const wireAllocation = (allocation: unknown): WireObject | null => {
    const row = wireObject(allocation);
    return row ? { id: row.id, obligationId: row.obligationId, paymentId: row.paymentId, amountMinor: row.amountMinor, currency: row.currency, state: row.state, reviewRequired: row.reviewRequired === true } : null;
  };
  const wirePayment = (payment: unknown): WireObject | null => {
    const row = wireObject(payment);
    return row ? { id: row.id, bowlerId: row.bowlerId, leagueId: row.leagueId, amount: row.amount, weekOf: row.weekOf, status: row.status, type: row.type, checkNumber: row.checkNumber ?? null, notes: row.notes ?? null } : null;
  };
  if (Array.isArray(source.records)) base.records = source.records.map((record) => {
    const row = wireObject(record) ?? {};
    return { payment: wirePayment(row.payment), allocation: wireAllocation(row.allocation) };
  });
  if (Array.isArray(source.responsibilities)) base.responsibilities = source.responsibilities.map((record) => {
    const row = wireObject(record) ?? {};
    const responsibility = wireObject(row.responsibility);
    return {
      responsibility: responsibility ? {
        id: responsibility.id,
        occurrenceId: responsibility.occurrenceId,
        teamId: responsibility.teamId,
        slotIndex: responsibility.slotIndex,
        positionIndex: responsibility.positionIndex,
        responsibilityKind: responsibility.responsibilityKind,
        mainBowlerId: responsibility.mainBowlerId,
        substituteBowlerId: responsibility.substituteBowlerId,
        payerBowlerId: responsibility.payerBowlerId,
        policy: responsibility.policy,
        amountMinor: responsibility.amountMinor,
        state: responsibility.state,
      } : null,
      obligation: wireObject(row.obligation) ? (() => {
        const obligation = wireObject(row.obligation) as WireObject;
        return { id: obligation.id, amountMinor: obligation.amountMinor, payerBowlerId: obligation.payerBowlerId, state: obligation.state };
      })() : null,
      obligations: Array.isArray(row.obligations) ? row.obligations.map((value) => {
        const obligation = wireObject(value) ?? {};
        return { id: obligation.id, amountMinor: obligation.amountMinor, payerBowlerId: obligation.payerBowlerId, state: obligation.state };
      }) : [],
    };
  });
  if (source.voidedAllocation !== undefined) base.voidedAllocation = wireAllocation(source.voidedAllocation);
  const correctionEvidence = wireObject(source.correctionEvidence);
  if (correctionEvidence) {
    base.correctionEvidence = correctionEvidence.id
      ? wireAllocation(correctionEvidence)
      : {
        status: correctionEvidence.status,
        supersedesAllocationIds: Array.isArray(correctionEvidence.supersedesAllocationIds)
          ? correctionEvidence.supersedesAllocationIds
          : [],
      };
  }
  const replacement = wireObject(source.replacement);
  if (replacement) base.replacement = { payment: wirePayment(replacement.payment), allocation: wireAllocation(replacement.allocation) };
  return base;
}

router.get("/leagues/:leagueId/roster-payment-responsibility/1", async (req, res) => {
  const leagueId = leagueIdParam(req.params.leagueId);
  if (!leagueId || !req.user) return sendError(res, "Not found", 404, "NOT_FOUND");
  const league = await authorizedLeague(req, leagueId);
  if (!league || league.organizationId === null) return sendError(res, "Not found", 404, "NOT_FOUND");
  try {
    const roster = await readRosterPaymentResponsibility({ organizationId: league.organizationId, leagueId });
    const privileged = req.user.role === "system_admin" || await hasAdminAccessToLeague(req, leagueId) || await hasPaymentManagerAccessToLeague(req, leagueId);
    if (privileged) return sendSuccess(res, roster);
    const ownBowlerId = req.user.bowlerId;
    return sendSuccess(res, {
      ...roster,
      teams: roster.teams.map((team) => ({
        ...team,
        slots: team.slots.map((slot) => slot.mainBowlerId === ownBowlerId ? slot : { ...slot, mainBowlerId: null }),
      })),
      occurrenceResponsibilities: roster.occurrenceResponsibilities
        .filter((responsibility) => responsibility.payerBowlerId === ownBowlerId)
        .map((responsibility) => ({ ...responsibility, mainBowlerId: responsibility.mainBowlerId === ownBowlerId ? ownBowlerId : null, substituteBowlerId: responsibility.substituteBowlerId === ownBowlerId ? ownBowlerId : null })),
      substituteBowlerOptions: [],
    });
  } catch (error) { return handleError(res, error); }
});

router.post("/leagues/:leagueId/roster-payment-responsibility/1/teams/:teamId", adminWriteLimiter, async (req, res) => {
  const leagueId = leagueIdParam(String(req.params.leagueId));
  const teamId = leagueIdParam(String(req.params.teamId));
  if (!leagueId || !teamId || !req.user) return sendError(res, "Not found", 404, "NOT_FOUND");
  const league = await authorizedLeague(req, leagueId, true, true);
  if (!league || league.organizationId === null || !req.user) return sendError(res, "Not found", 404, "NOT_FOUND");
  const parsed = rosterPaymentResponsibilityRequestSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, "Invalid roster responsibility request", 400, "INVALID_REQUEST");
  try {
    return sendSuccess(res, rosterWireResult(await saveTeamRoster({ organizationId: league.organizationId, leagueId, teamId, actorUserId: req.user.id, request: parsed.data })), 201);
  } catch (error) { return handleError(res, error); }
});

router.post("/leagues/:leagueId/roster-payment-responsibility/1/occurrences", adminWriteLimiter, async (req, res) => {
  const leagueId = leagueIdParam(String(req.params.leagueId));
  if (!leagueId || !req.user) return sendError(res, "Not found", 404, "NOT_FOUND");
  const league = await authorizedLeague(req, leagueId, true, true);
  if (!league || league.organizationId === null) return sendError(res, "Not found", 404, "NOT_FOUND");
  const bodySchema = z.object({ commandKey: z.string().trim().min(1).max(255), requestFingerprint: z.string().trim().min(1).max(128), responsibilities: z.array(occurrenceResponsibilityInputSchema).min(1) }).strict();
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, "Invalid occurrence responsibility request", 400, "INVALID_REQUEST");
  try { return sendSuccess(res, rosterWireResult(await recordOccurrenceResponsibilities({ ...parsed.data, organizationId: league.organizationId, leagueId, actorUserId: req.user.id })), 201); } catch (error) { return handleError(res, error); }
});

router.get("/leagues/:leagueId/canonical-due-past-due/2", async (req, res) => {
  const leagueId = leagueIdParam(String(req.params.leagueId));
  if (!leagueId || !req.user) return sendError(res, "Not found", 404, "NOT_FOUND");
  const league = await authorizedLeague(req, leagueId);
  if (!league || league.organizationId === null) return sendError(res, "Not found", 404, "NOT_FOUND");
  const privileged = await hasAdminAccessToLeague(req, leagueId) || await hasPaymentManagerAccessToLeague(req, leagueId) || req.user.role === "system_admin";
  const payerBowlerId = req.query.bowlerId === undefined ? (privileged ? undefined : req.user.bowlerId ?? undefined) : Number(req.query.bowlerId);
  if (!privileged && (payerBowlerId === undefined || payerBowlerId !== req.user.bowlerId)) return sendError(res, "Not found", 404, "NOT_FOUND");
  if (payerBowlerId !== undefined && (!Number.isSafeInteger(payerBowlerId) || payerBowlerId <= 0)) return sendError(res, "Invalid bowler", 400, "INVALID_REQUEST");
  try { return sendSuccess(res, await readCanonicalDuePastDue({ organizationId: league.organizationId, leagueId, payerBowlerId })); } catch (error) { return handleError(res, error); }
});

router.post("/leagues/:leagueId/interactive-obligation-quote/2", paymentWriteLimiter, async (req, res) => {
  const leagueId = leagueIdParam(String(req.params.leagueId));
  if (!leagueId || !req.user) return sendError(res, "Not found", 404, "NOT_FOUND");
  const parsed = interactiveObligationQuoteRequestV2Schema.safeParse(req.body);
  if (!parsed.success) return sendError(res, "Invalid obligation quote request", 400, "INVALID_REQUEST");
  let league;
  try { league = await paymentScope(req, leagueId, parsed.data.obligationIds); } catch (error) { return handleError(res, error); }
  if (!league || league.organizationId === null) return sendError(res, "Not found", 404, "NOT_FOUND");
  const privileged = await hasAdminAccessToLeague(req, leagueId) || await hasPaymentManagerAccessToLeague(req, leagueId) || req.user.role === "system_admin";
  try { return sendSuccess(res, await quoteInteractiveObligations({ organizationId: league.organizationId, leagueId, obligationIds: parsed.data.obligationIds, payerBowlerId: privileged ? undefined : req.user.bowlerId ?? undefined })); } catch (error) { return handleError(res, error); }
});

router.post("/leagues/:leagueId/interactive-obligation-charge/2", paymentWriteLimiter, async (req, res) => {
  const leagueId = leagueIdParam(String(req.params.leagueId));
  if (!leagueId || !req.user) return sendError(res, "Not found", 404, "NOT_FOUND");
  const parsed = interactiveObligationChargeRequestV2Schema.safeParse(req.body);
  if (!parsed.success) return sendError(res, "Invalid obligation charge request", 400, "INVALID_REQUEST");
  let league;
  try { league = await paymentScope(req, leagueId, parsed.data.obligationIds); } catch (error) { return handleError(res, error); }
  if (!league || league.organizationId === null) return sendError(res, "Not found", 404, "NOT_FOUND");
  try {
    const privileged = await hasAdminAccessToLeague(req, leagueId) || await hasPaymentManagerAccessToLeague(req, leagueId) || req.user.role === "system_admin";
    const result = await chargeInteractiveObligations({ organizationId: league.organizationId, leagueId, actorUserId: req.user.id, payerBowlerId: privileged ? undefined : req.user.bowlerId ?? undefined, request: parsed.data });
    return sendSuccess(res, rosterWireResult(result), result.status === "succeeded" ? 201 : 202);
  } catch (error) { return handleError(res, error); }
});

router.post("/leagues/:leagueId/canonical/manual-record/1", adminWriteLimiter, async (req, res) => {
  const leagueId = leagueIdParam(String(req.params.leagueId));
  if (!leagueId || !req.user) return sendError(res, "Not found", 404, "NOT_FOUND");
  const league = await authorizedLeague(req, leagueId, true, true);
  if (!league || league.organizationId === null) return sendError(res, "Not found", 404, "NOT_FOUND");
  const parsed = canonicalManualRecordRequestSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, "Invalid manual payment request", 400, "INVALID_REQUEST");
  try { return sendSuccess(res, rosterWireResult(await recordCanonicalManualPayment({ organizationId: league.organizationId, leagueId, actorUserId: req.user.id, request: parsed.data })), 201); } catch (error) { return handleError(res, error); }
});

router.post("/leagues/:leagueId/canonical/corrections/1", adminWriteLimiter, async (req, res) => {
  const leagueId = leagueIdParam(String(req.params.leagueId));
  if (!leagueId || !req.user) return sendError(res, "Not found", 404, "NOT_FOUND");
  const league = await authorizedLeague(req, leagueId, true, true);
  if (!league || league.organizationId === null) return sendError(res, "Not found", 404, "NOT_FOUND");
  const parsed = canonicalCorrectionRequestSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, "Invalid correction request", 400, "INVALID_REQUEST");
  try { return sendSuccess(res, rosterWireResult(await correctCanonicalAllocation({ organizationId: league.organizationId, leagueId, actorUserId: req.user.id, request: parsed.data })), 201); } catch (error) { return handleError(res, error); }
});

export default router;
