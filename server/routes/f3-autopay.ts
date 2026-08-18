import { Router } from "express";
import type { Request as ExpressRequest } from "express";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { bowlers, bowlerLeagues, bowlerOccurrenceObligations, financialActivations, occurrenceCollectionPlanItems, occurrenceCollectionPlans, f3AutopayPlanProvenance, f3CollectionPolicies, f3CollectionPolicyOccurrences, f3PayerAuthorizations, paymentOccurrenceAllocations, paymentSchedules, payments, leagues } from "@shared/schema";
import { db } from "../db.js";
import { hasAccessToLeague } from "../utils/access-control.js";
import { sendError, sendSuccess } from "../utils/api.js";
import { deriveF3ReadyPlan, F3ReadinessError } from "../services/f3-canonical-autopay.js";
import { f3AuthorizationInputSchema, f3PolicyInputSchema } from "@shared/f3-autopay-contract";
import { approveF3Policy, authorizeF3Payer, createF3Policy, F3WorkflowError, f3PaymentSourceFingerprint, revokeF3Authorization, validateF3PaymentMethodOwnership } from "../services/f3-workflow.js";
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
  if (!leagueId || !organizationId || !payerBowlerId || !req.user || (req.user.role !== "system_admin" && req.user.bowlerId !== payerBowlerId)) return sendError(res, "Not found", 404, "NOT_FOUND");
  if (!canonicalF3AutopayEnabled) return sendError(res, "Canonical auto-pay is unavailable", 409, "F3_DISABLED");
  try {
    const [league] = await db.select().from(leagues).where(and(eq(leagues.id, leagueId), eq(leagues.organizationId, organizationId))).limit(1);
    const [payer] = await db.select().from(bowlers).where(and(eq(bowlers.id, payerBowlerId), eq(bowlers.organizationId, organizationId))).limit(1);
    if (!league || !payer || !league.locationId) return sendError(res, "Not found", 404, "NOT_FOUND");
    const coveredBowlerIds = Array.isArray(req.body.coveredBowlerIds) ? req.body.coveredBowlerIds.map(Number) : [payerBowlerId];
    const uniqueCovered: number[] = Array.from(new Set<number>(coveredBowlerIds));
    const memberships = await db.select({ bowlerId: bowlerLeagues.bowlerId }).from(bowlerLeagues).where(and(eq(bowlerLeagues.leagueId, leagueId), eq(bowlerLeagues.active, true), inArray(bowlerLeagues.bowlerId, uniqueCovered)));
    if (league.paymentMode !== "weekly") throw new F3WorkflowError("UPFRONT_NOT_SUPPORTED");
    if (memberships.length !== uniqueCovered.length) throw new F3WorkflowError("ACTIVE_MEMBERSHIP_REQUIRED", "Not found", 404);
    const [requestedPolicy] = await db.select({ id: f3CollectionPolicies.id, activationId: f3CollectionPolicies.activationId, activationRevision: f3CollectionPolicies.activationRevision, activationSourceFingerprint: f3CollectionPolicies.activationSourceFingerprint }).from(f3CollectionPolicies).where(and(eq(f3CollectionPolicies.id, req.body.policyId), eq(f3CollectionPolicies.organizationId, organizationId), eq(f3CollectionPolicies.leagueId, leagueId), eq(f3CollectionPolicies.policyVersion, Number(req.body.policyVersion)), eq(f3CollectionPolicies.state, "approved"))).limit(1);
    const [policyActivation] = requestedPolicy ? await db.select({ id: financialActivations.id }).from(financialActivations).where(and(eq(financialActivations.id, requestedPolicy.activationId), eq(financialActivations.organizationId, organizationId), eq(financialActivations.leagueId, leagueId), eq(financialActivations.currentRevision, requestedPolicy.activationRevision), eq(financialActivations.sourceFingerprint, requestedPolicy.activationSourceFingerprint), eq(financialActivations.state, "active"), eq(financialActivations.completenessMarker, true))).limit(1) : [];
    if (!requestedPolicy || !policyActivation) throw new F3WorkflowError("POLICY_NOT_APPROVED");
    const schedules = await db.select({ bowlerId: paymentSchedules.bowlerId, additionalBowlerIds: paymentSchedules.additionalBowlerIds }).from(paymentSchedules).where(and(eq(paymentSchedules.leagueId, leagueId), eq(paymentSchedules.active, true)));
    if (schedules.some((schedule) => uniqueCovered.includes(schedule.bowlerId) || (schedule.additionalBowlerIds ?? []).some((id) => uniqueCovered.includes(id)))) throw new F3WorkflowError("LEGACY_SCHEDULE_CONFLICT");
    const acceptedPartnerIds = await getAcceptedPartnerBowlerIds(payerBowlerId, organizationId);
    const sourceId = typeof req.body.sourceId === "string" ? req.body.sourceId : "";
    const parsed = f3AuthorizationInputSchema.safeParse({ organizationId, leagueId, payerBowlerId, authorizationVersion: Number(req.body.authorizationVersion), policyId: req.body.policyId, policyVersion: Number(req.body.policyVersion), coveredBowlerIds: uniqueCovered, acceptedPartnerIds: acceptedPartnerIds.filter((id) => uniqueCovered.includes(id)), paymentMethodFingerprint: f3PaymentSourceFingerprint(sourceId, league.locationId), locationId: league.locationId, collectionPointOccurrenceIds: req.body.collectionPointOccurrenceIds, timing: "at_collection_point" });
    if (!parsed.success) return sendError(res, "Invalid payer authorization", 400, "INVALID_AUTHORIZATION");
    const owned = await validateF3PaymentMethodOwnership({ league, payer, sourceId });
    return sendSuccess(res, await authorizeF3Payer({ ...parsed.data, sourceId, customerId: owned.customerId, actorUserId: req.user.id, providerValidated: true, payerOwnedPaymentMethod: true, leagueLocationId: league.locationId, commandKey: typeof req.body.commandKey === "string" ? req.body.commandKey : "" }), 201);
  } catch (error) { if (error instanceof F3WorkflowError) return sendError(res, error.message, error.status, error.code); if (error instanceof F3ReadinessError) return sendError(res, error.message, 409, error.code); return sendError(res, "Payer authorization could not be completed", 409, "AUTHORIZATION_UNAVAILABLE"); }
});

router.post("/leagues/:leagueId/authorize/:authorizationId/revoke", async (req, res) => {
  const leagueId = positiveId(req.params.leagueId); const organizationId = scopeOrganization(req, positiveId(req.query.organizationId)); const actorUserId = req.user?.id;
  if (!leagueId || !organizationId || !actorUserId || (req.user?.role !== "org_admin" && req.user?.role !== "system_admin" && !req.user?.bowlerId)) return sendError(res, "Not found", 404, "NOT_FOUND");
  try { return sendSuccess(res, await revokeF3Authorization({ organizationId, leagueId, authorizationId: req.params.authorizationId, actorUserId, actorBowlerId: req.user?.role === "org_admin" || req.user?.role === "system_admin" ? undefined : req.user?.bowlerId ?? undefined })); }
  catch (error) { if (error instanceof F3WorkflowError) return sendError(res, error.message, error.status, error.code); return sendError(res, "Authorization could not be revoked", 409, "REVOCATION_UNAVAILABLE"); }
});

/** Provider-free canonical quote/read. It is deliberately separate from the
 * v1 setup quote and refuses to produce a legacy or inferred answer. */
router.get("/leagues/:leagueId/quote", async (req, res) => {
  const leagueId = Number(req.params.leagueId);
  const payerBowlerId = Number(req.query.bowlerId);
  const organizationId = scopeOrganization(req, positiveId(req.query.organizationId));
  if (!Number.isSafeInteger(leagueId) || leagueId <= 0 || !Number.isSafeInteger(payerBowlerId) || payerBowlerId <= 0 || !organizationId) return sendError(res, "Not found", 404, "NOT_FOUND");
  if (req.user?.role !== "system_admin" && !await hasAccessToLeague(req, leagueId)) return sendError(res, "Not found", 404, "NOT_FOUND");
  try {
    const [league] = await db.select().from(leagues).where(and(eq(leagues.id, leagueId), eq(leagues.organizationId, organizationId))).limit(1);
    if (!league) return sendError(res, "Not found", 404, "NOT_FOUND");
    if (req.user?.role !== "system_admin" && req.user?.bowlerId !== payerBowlerId && req.user?.role !== "org_admin") return sendError(res, "Not found", 404, "NOT_FOUND");
    if (req.user?.bowlerId === payerBowlerId) {
      const [membership] = await db.select({ bowlerId: bowlerLeagues.bowlerId }).from(bowlerLeagues).where(and(eq(bowlerLeagues.bowlerId, payerBowlerId), eq(bowlerLeagues.leagueId, leagueId), eq(bowlerLeagues.active, true))).limit(1);
      if (!membership) return sendError(res, "Not found", 404, "NOT_FOUND");
    }
    const [activation] = await db.select({ id: financialActivations.id, revision: financialActivations.currentRevision, sourceFingerprint: financialActivations.sourceFingerprint, complete: financialActivations.completenessMarker }).from(financialActivations).where(and(eq(financialActivations.organizationId, organizationId), eq(financialActivations.leagueId, leagueId), eq(financialActivations.state, "active"), eq(financialActivations.completenessMarker, true))).limit(1);
    const [policy] = await db.select().from(f3CollectionPolicies).where(and(eq(f3CollectionPolicies.organizationId, organizationId), eq(f3CollectionPolicies.leagueId, leagueId), eq(f3CollectionPolicies.state, "approved"))).orderBy(desc(f3CollectionPolicies.policyVersion)).limit(1);
    if (!policy) return sendError(res, "Canonical collection policy is unavailable", 409, "POLICY_NOT_APPROVED");
    const policyRows = await db.select().from(f3CollectionPolicyOccurrences).where(and(eq(f3CollectionPolicyOccurrences.organizationId, organizationId), eq(f3CollectionPolicyOccurrences.leagueId, leagueId), eq(f3CollectionPolicyOccurrences.policyId, policy.id))).orderBy(asc(f3CollectionPolicyOccurrences.itemIndex));
    const [authorization] = await db.select().from(f3PayerAuthorizations).where(and(eq(f3PayerAuthorizations.organizationId, organizationId), eq(f3PayerAuthorizations.leagueId, leagueId), eq(f3PayerAuthorizations.payerBowlerId, payerBowlerId), eq(f3PayerAuthorizations.state, "authorized"))).orderBy(desc(f3PayerAuthorizations.authorizationVersion)).limit(1);
    if (!authorization) return sendError(res, "Payer authorization is required", 409, "PAYER_AUTHORIZATION_REQUIRED");
    const persisted = await db.select({ planId: f3AutopayPlanProvenance.d2PlanId, planFingerprint: f3AutopayPlanProvenance.planFingerprint }).from(f3AutopayPlanProvenance).innerJoin(occurrenceCollectionPlans, and(eq(occurrenceCollectionPlans.id, f3AutopayPlanProvenance.d2PlanId), eq(occurrenceCollectionPlans.organizationId, organizationId), eq(occurrenceCollectionPlans.leagueId, leagueId), eq(occurrenceCollectionPlans.state, "ready"))).where(and(eq(f3AutopayPlanProvenance.organizationId, organizationId), eq(f3AutopayPlanProvenance.leagueId, leagueId), eq(f3AutopayPlanProvenance.authorizationId, authorization.id)));
    if (persisted.length > 0) {
      const persistedItems = await db.select({ obligationId: occurrenceCollectionPlanItems.obligationId, occurrenceId: occurrenceCollectionPlanItems.occurrenceId, bowlerId: occurrenceCollectionPlanItems.bowlerId, amountMinor: occurrenceCollectionPlanItems.amountMinor, itemIndex: occurrenceCollectionPlanItems.itemIndex, collectionPointOccurrenceId: occurrenceCollectionPlans.triggerOccurrenceId }).from(occurrenceCollectionPlanItems).innerJoin(occurrenceCollectionPlans, and(eq(occurrenceCollectionPlans.id, occurrenceCollectionPlanItems.planId), eq(occurrenceCollectionPlans.organizationId, organizationId), eq(occurrenceCollectionPlans.leagueId, leagueId), eq(occurrenceCollectionPlans.state, "ready"))).where(and(eq(occurrenceCollectionPlanItems.organizationId, organizationId), eq(occurrenceCollectionPlanItems.leagueId, leagueId), inArray(occurrenceCollectionPlanItems.planId, persisted.map((row) => row.planId)))).orderBy(asc(occurrenceCollectionPlanItems.itemIndex));
      return sendSuccess(res, { contractVersion: "canonical-autopay-plan/1", policy: { id: policy.id, version: policy.policyVersion }, authorization: { id: authorization.id, version: authorization.authorizationVersion, coveredBowlerIds: authorization.coveredBowlerIds, collectionPointOccurrenceIds: authorization.collectionPointOccurrenceIds }, items: persistedItems, totalAmountMinor: persistedItems.reduce((total, item) => total + item.amountMinor, 0), fingerprint: persisted[0]?.planFingerprint ?? "" });
    }
    const covered = authorization.coveredBowlerIds.slice();
    const obligations = await db.select().from(bowlerOccurrenceObligations).where(and(eq(bowlerOccurrenceObligations.organizationId, organizationId), eq(bowlerOccurrenceObligations.leagueId, leagueId), inArray(bowlerOccurrenceObligations.bowlerId, covered))).orderBy(asc(bowlerOccurrenceObligations.dueAt), asc(bowlerOccurrenceObligations.bowlerId), asc(bowlerOccurrenceObligations.occurrenceId));
    const allocationRows = await db.select({ obligationId: paymentOccurrenceAllocations.obligationId, amountMinor: paymentOccurrenceAllocations.amountMinor, status: payments.status }).from(paymentOccurrenceAllocations).innerJoin(payments, eq(payments.id, paymentOccurrenceAllocations.paymentId)).where(and(eq(paymentOccurrenceAllocations.organizationId, organizationId), eq(paymentOccurrenceAllocations.leagueId, leagueId), eq(paymentOccurrenceAllocations.state, "active"), inArray(paymentOccurrenceAllocations.obligationId, obligations.map((row) => row.id))));
    const reservations = await db.select({ obligationId: occurrenceCollectionPlanItems.obligationId, amountMinor: occurrenceCollectionPlanItems.amountMinor }).from(occurrenceCollectionPlanItems).innerJoin(occurrenceCollectionPlans, and(eq(occurrenceCollectionPlans.id, occurrenceCollectionPlanItems.planId), eq(occurrenceCollectionPlans.state, "ready"))).where(and(eq(occurrenceCollectionPlanItems.organizationId, organizationId), eq(occurrenceCollectionPlanItems.leagueId, leagueId), inArray(occurrenceCollectionPlanItems.obligationId, obligations.map((row) => row.id))));
    const allocById = new Map<string, number>(); const reservationById = new Map<string, number>(); const reviewIds = new Set<string>();
    for (const row of allocationRows) { if (row.status === "paid") allocById.set(row.obligationId, (allocById.get(row.obligationId) ?? 0) + row.amountMinor); else reviewIds.add(row.obligationId); }
    for (const row of reservations) reservationById.set(row.obligationId, (reservationById.get(row.obligationId) ?? 0) + row.amountMinor);
    const result = deriveF3ReadyPlan({ organizationId, leagueId, paymentMode: league.paymentMode, f3Enabled: canonicalF3AutopayEnabled, activation: activation ?? null, policy: { id: policy.id, version: policy.policyVersion, state: policy.state, activationId: policy.activationId, activationRevision: policy.activationRevision, activationSourceFingerprint: policy.activationSourceFingerprint, collectionPoints: policy.collectionPoints.map((row) => row.occurrenceId), occurrenceCollectionPoints: policyRows.map((row) => ({ occurrenceId: row.occurrenceId, collectionPointOccurrenceId: row.collectionPointOccurrenceId })) }, authorization: { id: authorization.id, version: authorization.authorizationVersion, state: authorization.state, payerBowlerId: authorization.payerBowlerId, policyId: authorization.policyId, policyVersion: authorization.policyVersion, coveredBowlerIds: covered, collectionPointOccurrenceIds: authorization.collectionPointOccurrenceIds }, acceptedPartnerIds: authorization.acceptedPartnerIds, paymentMethodLocationId: authorization.locationId, leagueLocationId: league.locationId, obligations: obligations.map((row) => ({ obligationId: row.id, occurrenceId: row.occurrenceId, bowlerId: row.bowlerId, amountMinor: row.amountMinor, allocatedMinor: allocById.get(row.id) ?? 0, reservedMinor: reservationById.get(row.id) ?? 0, currency: row.currency, state: row.state, reviewRequired: reviewIds.has(row.id), dueAt: row.dueAt })) });
    return sendSuccess(res, {
      ...result,
      policy: { id: policy.id, version: policy.policyVersion },
      authorization: { id: authorization.id, version: authorization.authorizationVersion, coveredBowlerIds: authorization.coveredBowlerIds, collectionPointOccurrenceIds: authorization.collectionPointOccurrenceIds },
    });
  } catch (error) {
    if (error instanceof F3ReadinessError) return sendError(res, "Canonical auto-pay quote is unavailable", 409, error.code);
    return sendError(res, "Canonical auto-pay quote is unavailable", 409, "F3_EVIDENCE_UNAVAILABLE");
  }
});

export default router;
