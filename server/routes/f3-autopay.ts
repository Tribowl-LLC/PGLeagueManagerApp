import { Router } from "express";
import type { Request as ExpressRequest } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { bowlers, bowlerLeagues, financialActivations, f3CollectionPolicies, paymentSchedules, leagues } from "@shared/schema";
import { db } from "../db.js";
import { hasAccessToLeague } from "../utils/access-control.js";
import { sendError, sendSuccess } from "../utils/api.js";
import { f3AuthorizationInputSchema, f3PolicyInputSchema } from "@shared/f3-autopay-contract";
import { approveF3Policy, authorizeF3Payer, createF3Policy, F3WorkflowError, f3PaymentSourceFingerprint, readF3AuthorizationReplay, readF3PolicyCandidates, readF3PreauthorizationQuote, readF3ReadyPlan, revokeF3Authorization, validateF3PaymentMethodOwnership } from "../services/f3-workflow.js";
import { getAcceptedPartnerBowlerIds } from "../storage/bowler-payment-links.js";
import { canonicalF3AutopayEnabled } from "../config.js";

const router = Router();

function positiveId(value: unknown): number | undefined { const parsed = typeof value === "string" ? Number(value) : value; return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined; }
function scopeOrganization(req: ExpressRequest, requested: number | undefined): number | undefined {
  if (req.user?.role === "system_admin") return requested;
  return req.user?.organizationId && (!requested || requested === req.user.organizationId) ? req.user.organizationId : undefined;
}

router.post("/leagues/:leagueId/policy", async (req, res) => {
  const leagueId = positiveId(req.params.leagueId); const organizationId = scopeOrganization(req, positiveId(req.query.organizationId));
  const actorUserId = req.user?.id;
  if (!leagueId || !organizationId || !actorUserId || (req.user?.role !== "org_admin" && req.user?.role !== "system_admin")) return sendError(res, "Not found", 404, "NOT_FOUND");
  if (!canonicalF3AutopayEnabled) return sendError(res, "Canonical auto-pay is unavailable", 409, "F3_DISABLED");
  const policyBody = { ...(req.body ?? {}) };
  delete policyBody.commandKey;
  const parsed = f3PolicyInputSchema.safeParse({ ...policyBody, organizationId, leagueId });
  if (!parsed.success) return sendError(res, "Invalid collection policy", 400, "INVALID_POLICY");
  try { return sendSuccess(res, await createF3Policy({ ...parsed.data, actorUserId, commandKey: typeof req.body.commandKey === "string" ? req.body.commandKey : "" }), 201); }
  catch (error) { if (error instanceof F3WorkflowError) return sendError(res, error.message, error.status, error.code); return sendError(res, "Policy could not be created", 500, "INTERNAL_ERROR"); }
});

/** Candidate evidence for the administrator review surface. It exposes real
 * activation/occurrence UUIDs only; no date/order heuristic is authoritative. */
router.get("/leagues/:leagueId/policy/candidates", async (req, res) => {
  const leagueId = positiveId(req.params.leagueId); const organizationId = scopeOrganization(req, positiveId(req.query.organizationId));
  if (!leagueId || !organizationId || (req.user?.role !== "org_admin" && req.user?.role !== "system_admin")) return sendError(res, "Not found", 404, "NOT_FOUND");
  if (!canonicalF3AutopayEnabled) return sendError(res, "Canonical auto-pay is unavailable", 409, "F3_DISABLED");
  try { return sendSuccess(res, await readF3PolicyCandidates({ organizationId, leagueId })); }
  catch (error) { if (error instanceof F3WorkflowError) return sendError(res, error.message, error.status, error.code); return sendError(res, "Policy candidates are unavailable", 409, "F3_EVIDENCE_UNAVAILABLE"); }
});

router.post("/leagues/:leagueId/policy/:policyId/approve", async (req, res) => {
  const leagueId = positiveId(req.params.leagueId); const organizationId = scopeOrganization(req, positiveId(req.query.organizationId));
  const actorUserId = req.user?.id;
  if (!leagueId || !organizationId || !actorUserId || (req.user?.role !== "org_admin" && req.user?.role !== "system_admin")) return sendError(res, "Not found", 404, "NOT_FOUND");
  if (!canonicalF3AutopayEnabled) return sendError(res, "Canonical auto-pay is unavailable", 409, "F3_DISABLED");
  try { return sendSuccess(res, await approveF3Policy({ organizationId, leagueId, policyId: req.params.policyId, actorUserId })); }
  catch (error) { if (error instanceof F3WorkflowError) return sendError(res, error.message, error.status, error.code); return sendError(res, "Policy could not be approved", 500, "INTERNAL_ERROR"); }
});

router.post("/leagues/:leagueId/authorize", async (req, res) => {
  const leagueId = positiveId(req.params.leagueId); const organizationId = scopeOrganization(req, positiveId(req.query.organizationId));
  const payerBowlerId = positiveId(req.body?.payerBowlerId);
  if (!leagueId || !organizationId || !payerBowlerId || !req.user || req.user.bowlerId !== payerBowlerId) return sendError(res, "Not found", 404, "NOT_FOUND");
  if (!canonicalF3AutopayEnabled) return sendError(res, "Canonical auto-pay is unavailable", 409, "F3_DISABLED");
  try {
    const [league] = await db.select().from(leagues).where(and(eq(leagues.id, leagueId), eq(leagues.organizationId, organizationId))).limit(1);
    const [payer] = await db.select().from(bowlers).where(and(eq(bowlers.id, payerBowlerId), eq(bowlers.organizationId, organizationId), eq(bowlers.active, true))).limit(1);
    if (!league || !league.active || !payer || !league.locationId) return sendError(res, "Not found", 404, "NOT_FOUND");
    const coveredBowlerIds = Array.isArray(req.body.coveredBowlerIds) ? req.body.coveredBowlerIds.map(Number) : [payerBowlerId];
    const uniqueCovered: number[] = Array.from(new Set<number>(coveredBowlerIds));
    const memberships = await db.select({ bowlerId: bowlerLeagues.bowlerId }).from(bowlerLeagues).innerJoin(bowlers, and(eq(bowlers.id, bowlerLeagues.bowlerId), eq(bowlers.organizationId, organizationId), eq(bowlers.active, true))).where(and(eq(bowlerLeagues.leagueId, leagueId), eq(bowlerLeagues.active, true), inArray(bowlerLeagues.bowlerId, uniqueCovered)));
    if (league.paymentMode !== "weekly") throw new F3WorkflowError("UPFRONT_NOT_SUPPORTED");
    if (new Set(memberships.map((row) => row.bowlerId)).size !== uniqueCovered.length) throw new F3WorkflowError("ACTIVE_MEMBERSHIP_REQUIRED", "Not found", 404);
    const [requestedPolicy] = await db.select({ id: f3CollectionPolicies.id, activationId: f3CollectionPolicies.activationId, activationRevision: f3CollectionPolicies.activationRevision, activationSourceFingerprint: f3CollectionPolicies.activationSourceFingerprint }).from(f3CollectionPolicies).where(and(eq(f3CollectionPolicies.id, req.body.policyId), eq(f3CollectionPolicies.organizationId, organizationId), eq(f3CollectionPolicies.leagueId, leagueId), eq(f3CollectionPolicies.policyVersion, Number(req.body.policyVersion)), eq(f3CollectionPolicies.state, "approved"))).limit(1);
    const [policyActivation] = requestedPolicy ? await db.select({ id: financialActivations.id }).from(financialActivations).where(and(eq(financialActivations.id, requestedPolicy.activationId), eq(financialActivations.organizationId, organizationId), eq(financialActivations.leagueId, leagueId), eq(financialActivations.currentRevision, requestedPolicy.activationRevision), eq(financialActivations.sourceFingerprint, requestedPolicy.activationSourceFingerprint), eq(financialActivations.state, "active"), eq(financialActivations.completenessMarker, true))).limit(1) : [];
    if (!requestedPolicy || !policyActivation) throw new F3WorkflowError("POLICY_NOT_APPROVED");
    const schedules = await db.select({ bowlerId: paymentSchedules.bowlerId, additionalBowlerIds: paymentSchedules.additionalBowlerIds }).from(paymentSchedules).where(and(eq(paymentSchedules.leagueId, leagueId), eq(paymentSchedules.active, true)));
    if (schedules.some((schedule) => uniqueCovered.includes(schedule.bowlerId) || (schedule.additionalBowlerIds ?? []).some((id) => uniqueCovered.includes(id)))) throw new F3WorkflowError("LEGACY_SCHEDULE_CONFLICT");
    const acceptedPartnerIds = await getAcceptedPartnerBowlerIds(payerBowlerId, organizationId);
    if (uniqueCovered.some((id) => id !== payerBowlerId && !acceptedPartnerIds.includes(id))) throw new F3WorkflowError("PARTNER_NOT_ACCEPTED", "Not found", 403);
    const sourceId = typeof req.body.sourceId === "string" ? req.body.sourceId : "";
    const expectedVersion = req.body.authorizationVersion === undefined ? undefined : Number(req.body.authorizationVersion);
    const parsed = f3AuthorizationInputSchema.safeParse({ organizationId, leagueId, payerBowlerId, authorizationVersion: expectedVersion, policyId: req.body.policyId, policyVersion: Number(req.body.policyVersion), coveredBowlerIds: uniqueCovered, acceptedPartnerIds: acceptedPartnerIds.filter((id) => uniqueCovered.includes(id)), paymentMethodFingerprint: f3PaymentSourceFingerprint(sourceId, league.locationId), locationId: league.locationId, collectionPointOccurrenceIds: req.body.collectionPointOccurrenceIds, timing: "at_collection_point", preauthorizationFingerprint: req.body.preauthorizationFingerprint, authorizedItems: req.body.authorizedItems });
    if (!parsed.success) return sendError(res, "Invalid payer authorization", 400, "INVALID_AUTHORIZATION");
    const commandKey = typeof req.body.commandKey === "string" ? req.body.commandKey : "";
    const replay = await readF3AuthorizationReplay({ ...parsed.data, commandKey });
    if (replay) return sendSuccess(res, replay);
    const owned = await validateF3PaymentMethodOwnership({ league, payer, sourceId });
    return sendSuccess(res, await authorizeF3Payer({ ...parsed.data, sourceId, customerId: owned.customerId, actorUserId: req.user.id, providerValidated: true, payerOwnedPaymentMethod: true, leagueLocationId: league.locationId, commandKey }), 201);
  } catch (error) { if (error instanceof F3WorkflowError) return sendError(res, error.message, error.status, error.code); return sendError(res, "Payer authorization could not be completed", 409, "AUTHORIZATION_UNAVAILABLE"); }
});

/** First-time setup quote. This is intentionally provider-free: the payer
 * authorizes the exact server-derived rows and only the subsequent command
 * performs strict card ownership verification. */
router.get("/leagues/:leagueId/prequote", async (req, res) => {
  const leagueId = positiveId(req.params.leagueId); const organizationId = scopeOrganization(req, positiveId(req.query.organizationId));
  const payerBowlerId = positiveId(req.query.bowlerId); const coveredRaw = typeof req.query.coveredBowlerIds === "string" ? req.query.coveredBowlerIds.split(",").map(Number) : [payerBowlerId ?? 0];
  const coveredBowlerIds = [...new Set(coveredRaw.filter((id) => Number.isSafeInteger(id) && id > 0))].sort((a, b) => a - b);
  if (!leagueId || !organizationId || !payerBowlerId || req.user?.bowlerId !== payerBowlerId || !coveredBowlerIds.includes(payerBowlerId)) return sendError(res, "Not found", 404, "NOT_FOUND");
  if (!canonicalF3AutopayEnabled) return sendError(res, "Canonical auto-pay is unavailable", 409, "F3_DISABLED");
  try { return sendSuccess(res, await readF3PreauthorizationQuote({ organizationId, leagueId, payerBowlerId, coveredBowlerIds })); }
  catch (error) { if (error instanceof F3WorkflowError) return sendError(res, error.message, error.status, error.code); return sendError(res, "Canonical preauthorization quote is unavailable", 409, "F3_EVIDENCE_UNAVAILABLE"); }
});

router.post("/leagues/:leagueId/authorize/:authorizationId/revoke", async (req, res) => {
  const leagueId = positiveId(req.params.leagueId); const organizationId = scopeOrganization(req, positiveId(req.query.organizationId)); const actorUserId = req.user?.id;
  if (!leagueId || !organizationId || !actorUserId || (req.user?.role !== "org_admin" && req.user?.role !== "system_admin" && !req.user?.bowlerId)) return sendError(res, "Not found", 404, "NOT_FOUND");
  try { return sendSuccess(res, await revokeF3Authorization({ organizationId, leagueId, authorizationId: req.params.authorizationId, actorUserId, actorBowlerId: req.user?.role === "org_admin" || req.user?.role === "system_admin" ? undefined : req.user?.bowlerId ?? undefined })); }
  catch (error) { if (error instanceof F3WorkflowError) return sendError(res, error.message, error.status, error.code); return sendError(res, "Authorization could not be revoked", 409, "REVOCATION_UNAVAILABLE"); }
});

/** Provider-free canonical persisted-plan read. The service owns one
 * repeatable-read snapshot and fails closed when ready D2 evidence is absent. */
router.get("/leagues/:leagueId/quote", async (req, res) => {
  const leagueId = positiveId(req.params.leagueId);
  const payerBowlerId = positiveId(req.query.bowlerId);
  const organizationId = scopeOrganization(req, positiveId(req.query.organizationId));
  if (!leagueId || !payerBowlerId || !organizationId) return sendError(res, "Not found", 404, "NOT_FOUND");
  if (!canonicalF3AutopayEnabled) return sendError(res, "Canonical auto-pay is unavailable", 409, "F3_DISABLED");
  if (req.user?.role !== "system_admin" && !await hasAccessToLeague(req, leagueId)) return sendError(res, "Not found", 404, "NOT_FOUND");
  if (req.user?.role !== "system_admin" && req.user?.role !== "org_admin" && req.user?.bowlerId !== payerBowlerId) return sendError(res, "Not found", 404, "NOT_FOUND");
  try { return sendSuccess(res, await readF3ReadyPlan({ organizationId, leagueId, payerBowlerId })); }
  catch (error) { if (error instanceof F3WorkflowError) return sendError(res, error.message, error.status, error.code); return sendError(res, "Canonical auto-pay quote is unavailable", 409, "F3_EVIDENCE_UNAVAILABLE"); }
});

/** The canonical /quote route above is the only persisted-plan read path. */

export default router;
