import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
  canonicalCorrectionRequestSchema,
  canonicalManualRecordBatchQuoteRequestSchema,
  canonicalManualRecordBatchRequestSchema,
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
import {
  recoverRosterPaymentOperation,
  recoverRosterPaymentOperationByRequestKey,
  RosterPaymentRecoveryError,
} from "../services/roster-payment-recovery.js";

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

async function paymentScope(req: Request, leagueId: number, payerBowlerId: number | undefined) {
  const league = await authorizedLeague(req, leagueId);
  if (!league || league.organizationId === null) return null;
  const privileged = await hasAdminAccessToLeague(req, leagueId) || await hasPaymentManagerAccessToLeague(req, leagueId) || req.user?.role === "system_admin";
  if (!privileged) {
    if (payerBowlerId === undefined || payerBowlerId !== req.user?.bowlerId) return null;
    const allowed = await canUserPayForBowler(req, payerBowlerId);
    if (!allowed.allowed) return null;
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
  if (error instanceof RosterPaymentRecoveryError) {
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
  for (const key of ["contractVersion", "automaticContractVersion", "organizationId", "leagueId", "teamId", "ready", "commandKey", "requestFingerprint", "mode", "restoredObligationId", "payerBowlerId", "amountMinor", "currency", "fingerprint"]) {
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
  const wirePayment = (payment: unknown): WireObject | null => {
    const row = wireObject(payment);
    return row ? { id: row.id, bowlerId: row.bowlerId, leagueId: row.leagueId, amount: row.amount, currency: row.currency ?? "USD", createdAt: row.createdAt, status: row.status, type: row.type, checkNumber: row.checkNumber ?? null, notes: row.notes ?? null } : null;
  };
  if (source.payment !== undefined) base.payment = wirePayment(source.payment);
  if (Array.isArray(source.records)) base.records = source.records.map((record) => {
    const row = wireObject(record) ?? {};
    return { payment: wirePayment(row.payment) };
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
  const voidEvidence = wireObject(source.voidEvidence);
  if (voidEvidence) {
    base.voidEvidence = {
      id: voidEvidence.id,
      paymentId: voidEvidence.paymentId,
      reason: voidEvidence.reason,
      recordedAt: voidEvidence.recordedAt,
    };
  }
  const correctionEvidence = wireObject(source.correctionEvidence);
  if (correctionEvidence) {
    base.correctionEvidence = { status: correctionEvidence.status, voidId: correctionEvidence.voidId };
  }
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
  const privileged = await hasAdminAccessToLeague(req, leagueId) || await hasPaymentManagerAccessToLeague(req, leagueId) || req.user.role === "system_admin";
  const payerBowlerId = privileged ? parsed.data.payerBowlerId : req.user.bowlerId ?? undefined;
  if (payerBowlerId === undefined) return sendError(res, "A payer bowler is required", 400, "INVALID_REQUEST");
  try { league = await paymentScope(req, leagueId, payerBowlerId); } catch (error) { return handleError(res, error); }
  if (!league || league.organizationId === null) return sendError(res, "Not found", 404, "NOT_FOUND");
  try {
    return sendSuccess(res, rosterWireResult(await quoteInteractiveObligations({
      organizationId: league.organizationId,
      leagueId,
      amountMinor: parsed.data.amountMinor,
      payerBowlerId,
    })));
  } catch (error) { return handleError(res, error); }
});

router.post("/leagues/:leagueId/interactive-obligation-charge/2", paymentWriteLimiter, async (req, res) => {
  const leagueId = leagueIdParam(String(req.params.leagueId));
  if (!leagueId || !req.user) return sendError(res, "Not found", 404, "NOT_FOUND");
  const parsed = interactiveObligationChargeRequestV2Schema.safeParse(req.body);
  if (!parsed.success) return sendError(res, "Invalid obligation charge request", 400, "INVALID_REQUEST");
  // Payment managers are location-scoped cash/check operators. The UI hides
  // card and wallet tabs for this role, but the server must enforce the same
  // boundary because clients are not trusted authorization controls.
  if (req.user.role === "payment_manager") return sendError(res, "Not found", 404, "NOT_FOUND");
  let league;
  const privileged = await hasAdminAccessToLeague(req, leagueId) || await hasPaymentManagerAccessToLeague(req, leagueId) || req.user.role === "system_admin";
  const payerBowlerId = privileged ? parsed.data.payerBowlerId : req.user.bowlerId ?? undefined;
  if (payerBowlerId === undefined) return sendError(res, "A payer bowler is required", 400, "INVALID_REQUEST");
  try { league = await paymentScope(req, leagueId, payerBowlerId); } catch (error) { return handleError(res, error); }
  if (!league || league.organizationId === null) return sendError(res, "Not found", 404, "NOT_FOUND");
  try {
    const result = await chargeInteractiveObligations({ organizationId: league.organizationId, leagueId, actorUserId: req.user.id, payerBowlerId, request: parsed.data });
    return sendSuccess(res, rosterWireResult(result), result.status === "succeeded" ? 201 : 202);
  } catch (error) { return handleError(res, error); }
});

router.post("/leagues/:leagueId/interactive-obligation-charge/2/recover-by-request-key", adminWriteLimiter, async (req, res) => {
  const leagueId = leagueIdParam(String(req.params.leagueId));
  const parsed = z.object({
    requestKey: z.string().trim().min(16).max(109).regex(/^[A-Za-z0-9_-]+$/),
  }).strict().safeParse(req.body);
  if (!leagueId || !parsed.success || !req.user) return sendError(res, "Not found", 404, "NOT_FOUND");
  const league = await authorizedLeague(req, leagueId);
  if (!league || league.organizationId === null) return sendError(res, "Not found", 404, "NOT_FOUND");
  try {
    const result = await recoverRosterPaymentOperationByRequestKey({
      organizationId: league.organizationId,
      leagueId,
      requestKey: parsed.data.requestKey,
      actorUserId: req.user.id,
    });
    return sendSuccess(res, rosterWireResult({ contractVersion: "interactive-obligation-recovery/1", operationId: result.id, status: result.status }));
  } catch (error) { return handleError(res, error); }
});

router.post("/leagues/:leagueId/interactive-obligation-charge/2/operations/:operationId/recover", adminWriteLimiter, async (req, res) => {
  const leagueId = leagueIdParam(String(req.params.leagueId));
  const operationId = z.string().uuid().safeParse(req.params.operationId);
  if (!leagueId || !operationId.success || !req.user) return sendError(res, "Not found", 404, "NOT_FOUND");
  const league = await authorizedLeague(req, leagueId);
  if (!league || league.organizationId === null) return sendError(res, "Not found", 404, "NOT_FOUND");
  const privileged = await hasAdminAccessToLeague(req, leagueId) || await hasPaymentManagerAccessToLeague(req, leagueId) || req.user.role === "system_admin";
  if (!privileged) {
    const operation = await storage.getPaymentOperationForOrganization(league.organizationId, operationId.data);
    // A bowler may recover only the operation they authorized. Do not expose
    // whether another payer's operation exists in this league.
    if (!operation || operation.leagueId !== leagueId || operation.authorizingUserId !== req.user.id) return sendError(res, "Not found", 404, "NOT_FOUND");
  }
  try {
    const result = await recoverRosterPaymentOperation({ organizationId: league.organizationId, leagueId, operationId: operationId.data, actorUserId: req.user.id });
    return sendSuccess(res, rosterWireResult({ contractVersion: "interactive-obligation-recovery/1", operationId: result.id, status: result.status }));
  } catch (error) { return handleError(res, error); }
});

router.post("/leagues/:leagueId/standing-autopay/1/operations/:operationId/recover", adminWriteLimiter, async (req, res) => {
  const leagueId = leagueIdParam(String(req.params.leagueId));
  const operationId = z.string().uuid().safeParse(req.params.operationId);
  if (!leagueId || !operationId.success || !req.user) return sendError(res, "Not found", 404, "NOT_FOUND");
  const league = await authorizedLeague(req, leagueId);
  if (!league || league.organizationId === null) return sendError(res, "Not found", 404, "NOT_FOUND");
  const privileged = await hasAdminAccessToLeague(req, leagueId) || await hasPaymentManagerAccessToLeague(req, leagueId) || req.user.role === "system_admin";
  if (!privileged) {
    const operation = await storage.getPaymentOperationForOrganization(league.organizationId, operationId.data);
    if (!operation || operation.leagueId !== leagueId || operation.operationType !== "standing_autopay_charge" || operation.authorizingUserId !== req.user.id) return sendError(res, "Not found", 404, "NOT_FOUND");
  }
  try {
    const result = await recoverRosterPaymentOperation({ organizationId: league.organizationId, leagueId, operationId: operationId.data, actorUserId: req.user.id });
    return sendSuccess(res, rosterWireResult({ contractVersion: "standing-autopay-operation/1", operationId: result.id, status: result.status }));
  } catch (error) { return handleError(res, error); }
});

router.post("/leagues/:leagueId/canonical/manual-record/1", adminWriteLimiter, async (req, res) => {
  const leagueId = leagueIdParam(String(req.params.leagueId));
  if (!leagueId || !req.user) return sendError(res, "Not found", 404, "NOT_FOUND");
  const league = await authorizedLeague(req, leagueId, true);
  if (!league || league.organizationId === null) return sendError(res, "Not found", 404, "NOT_FOUND");
  const parsed = canonicalManualRecordRequestSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, "Invalid manual payment request", 400, "INVALID_REQUEST");
  try { return sendSuccess(res, rosterWireResult(await recordCanonicalManualPayment({ organizationId: league.organizationId, leagueId, actorUserId: req.user.id, request: parsed.data })), 201); } catch (error) { return handleError(res, error); }
});

/**
 * Management-only batch quote/record surfaces. A league night may contain
 * more rows than the interactive payment limiter permits, so one bounded
 * request handles the batch while each row still gets an independent,
 * server-authoritative FIFO quote and canonical manual-record transaction.
 */
router.post("/leagues/:leagueId/canonical/manual-record-batch/quote/1", adminWriteLimiter, async (req, res) => {
  const leagueId = leagueIdParam(String(req.params.leagueId));
  if (!leagueId || !req.user) return sendError(res, "Not found", 404, "NOT_FOUND");
  const league = await authorizedLeague(req, leagueId, true);
  if (!league || league.organizationId === null) return sendError(res, "Not found", 404, "NOT_FOUND");
  const parsed = canonicalManualRecordBatchQuoteRequestSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, "Invalid manual payment batch", 400, "INVALID_REQUEST");
  const rows = [];
  for (const row of parsed.data.rows) {
    try {
      const quote = await quoteInteractiveObligations({
        organizationId: league.organizationId,
        leagueId,
        amountMinor: row.amountMinor,
        payerBowlerId: row.payerBowlerId,
      });
      rows.push({ rowKey: row.rowKey, success: true as const, data: rosterWireResult(quote) });
    } catch (error) {
      if (error instanceof RosterPaymentError) rows.push({ rowKey: row.rowKey, success: false as const, error: { code: error.code, message: error.message } });
      else rows.push({ rowKey: row.rowKey, success: false as const, error: { code: "INTERNAL_ERROR", message: "Unable to quote this payment" } });
    }
  }
  return sendSuccess(res, { contractVersion: "canonical-manual-record-batch-quote/1" as const, leagueId, rows });
});

router.post("/leagues/:leagueId/canonical/manual-record-batch/1", adminWriteLimiter, async (req, res) => {
  const leagueId = leagueIdParam(String(req.params.leagueId));
  if (!leagueId || !req.user) return sendError(res, "Not found", 404, "NOT_FOUND");
  const league = await authorizedLeague(req, leagueId, true);
  if (!league || league.organizationId === null) return sendError(res, "Not found", 404, "NOT_FOUND");
  const parsed = canonicalManualRecordBatchRequestSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, "Invalid manual payment batch", 400, "INVALID_REQUEST");
  const rows = [];
  for (const row of parsed.data.rows) {
    try {
      const result = await recordCanonicalManualPayment({
        organizationId: league.organizationId,
        leagueId,
        actorUserId: req.user.id,
        request: row,
      });
      rows.push({ rowKey: row.rowKey, success: true as const, data: rosterWireResult(result) });
    } catch (error) {
      if (error instanceof RosterPaymentReplay) {
        rows.push({ rowKey: row.rowKey, success: true as const, replay: true as const, data: rosterWireResult(error.result) });
      } else if (error instanceof RosterPaymentError) {
        rows.push({ rowKey: row.rowKey, success: false as const, error: { code: error.code, message: error.message } });
      } else {
        rows.push({ rowKey: row.rowKey, success: false as const, error: { code: "INTERNAL_ERROR", message: "Unable to record this payment" } });
      }
    }
  }
  return sendSuccess(res, { contractVersion: "canonical-manual-record-batch/1" as const, leagueId, rows });
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
