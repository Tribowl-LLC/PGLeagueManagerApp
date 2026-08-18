import { Router } from "express";
import { and, asc, eq, inArray } from "drizzle-orm";
import { bowlers, bowlerOccurrenceObligations, financialActivations, f3AutopayPlanItems, f3AutopayPlans, f3CollectionPolicies, f3CollectionPolicyOccurrences, f3PayerAuthorizations, paymentOccurrenceAllocations, payments, leagues } from "@shared/schema";
import { db } from "../db.js";
import { canonicalF3AutopayEnabled } from "../config.js";
import { hasAccessToLeague } from "../utils/access-control.js";
import { sendError, sendSuccess } from "../utils/api.js";
import { deriveF3ReadyPlan, F3ReadinessError } from "../services/f3-canonical-autopay.js";

const router = Router();

/** Provider-free canonical quote/read. It is deliberately separate from the
 * v1 setup quote and refuses to produce a legacy or inferred answer. */
router.get("/leagues/:leagueId/quote", async (req, res) => {
  const leagueId = Number(req.params.leagueId);
  const payerBowlerId = Number(req.query.bowlerId);
  if (!Number.isSafeInteger(leagueId) || leagueId <= 0 || !Number.isSafeInteger(payerBowlerId) || payerBowlerId <= 0) return sendError(res, "Not found", 404, "NOT_FOUND");
  if (!await hasAccessToLeague(req, leagueId)) return sendError(res, "Not found", 404, "NOT_FOUND");
  try {
    const [league] = await db.select().from(leagues).where(eq(leagues.id, leagueId)).limit(1);
    if (!league?.organizationId) return sendError(res, "Not found", 404, "NOT_FOUND");
    if (req.user?.role !== "system_admin" && req.user?.bowlerId !== payerBowlerId && req.user?.role !== "org_admin") return sendError(res, "Not found", 404, "NOT_FOUND");
    const organizationId = league.organizationId;
    const [activation] = await db.select({ id: financialActivations.id, revision: financialActivations.currentRevision, sourceFingerprint: financialActivations.sourceFingerprint, complete: financialActivations.completenessMarker }).from(financialActivations).where(and(eq(financialActivations.organizationId, organizationId), eq(financialActivations.leagueId, leagueId), eq(financialActivations.state, "active"), eq(financialActivations.completenessMarker, true))).limit(1);
    const [policy] = await db.select().from(f3CollectionPolicies).where(and(eq(f3CollectionPolicies.organizationId, organizationId), eq(f3CollectionPolicies.leagueId, leagueId), eq(f3CollectionPolicies.state, "approved"))).orderBy(asc(f3CollectionPolicies.policyVersion)).limit(1);
    if (!policy) return sendError(res, "Canonical collection policy is unavailable", 409, "POLICY_NOT_APPROVED");
    const policyRows = await db.select().from(f3CollectionPolicyOccurrences).where(and(eq(f3CollectionPolicyOccurrences.organizationId, organizationId), eq(f3CollectionPolicyOccurrences.leagueId, leagueId), eq(f3CollectionPolicyOccurrences.policyId, policy.id))).orderBy(asc(f3CollectionPolicyOccurrences.itemIndex));
    const [authorization] = await db.select().from(f3PayerAuthorizations).where(and(eq(f3PayerAuthorizations.organizationId, organizationId), eq(f3PayerAuthorizations.leagueId, leagueId), eq(f3PayerAuthorizations.payerBowlerId, payerBowlerId), eq(f3PayerAuthorizations.state, "authorized"))).orderBy(asc(f3PayerAuthorizations.authorizationVersion)).limit(1);
    if (!authorization) return sendError(res, "Payer authorization is required", 409, "PAYER_AUTHORIZATION_REQUIRED");
    const covered = authorization.coveredBowlerIds.slice();
    const obligations = await db.select().from(bowlerOccurrenceObligations).where(and(eq(bowlerOccurrenceObligations.organizationId, organizationId), eq(bowlerOccurrenceObligations.leagueId, leagueId), inArray(bowlerOccurrenceObligations.bowlerId, covered))).orderBy(asc(bowlerOccurrenceObligations.dueAt), asc(bowlerOccurrenceObligations.bowlerId), asc(bowlerOccurrenceObligations.occurrenceId));
    const allocationRows = await db.select({ obligationId: paymentOccurrenceAllocations.obligationId, amountMinor: paymentOccurrenceAllocations.amountMinor, status: payments.status }).from(paymentOccurrenceAllocations).innerJoin(payments, eq(payments.id, paymentOccurrenceAllocations.paymentId)).where(and(eq(paymentOccurrenceAllocations.organizationId, organizationId), eq(paymentOccurrenceAllocations.leagueId, leagueId), eq(paymentOccurrenceAllocations.state, "active"), inArray(paymentOccurrenceAllocations.obligationId, obligations.map((row) => row.id))));
    const reservations = await db.select({ obligationId: f3AutopayPlanItems.obligationId, amountMinor: f3AutopayPlanItems.amountMinor }).from(f3AutopayPlanItems).innerJoin(f3AutopayPlans, and(eq(f3AutopayPlans.id, f3AutopayPlanItems.planId), eq(f3AutopayPlans.state, "ready"))).where(and(eq(f3AutopayPlanItems.organizationId, organizationId), eq(f3AutopayPlanItems.leagueId, leagueId), inArray(f3AutopayPlanItems.obligationId, obligations.map((row) => row.id))));
    const allocById = new Map<string, number>(); const reservationById = new Map<string, number>(); const reviewIds = new Set<string>();
    for (const row of allocationRows) { if (row.status === "paid") allocById.set(row.obligationId, (allocById.get(row.obligationId) ?? 0) + row.amountMinor); else reviewIds.add(row.obligationId); }
    for (const row of reservations) reservationById.set(row.obligationId, (reservationById.get(row.obligationId) ?? 0) + row.amountMinor);
    const result = deriveF3ReadyPlan({ organizationId, leagueId, paymentMode: league.paymentMode, f3Enabled: canonicalF3AutopayEnabled, activation: activation ?? null, policy: { id: policy.id, version: policy.policyVersion, state: policy.state, activationId: policy.activationId, activationRevision: policy.activationRevision, activationSourceFingerprint: policy.activationSourceFingerprint, collectionPoints: policy.collectionPoints.map((row) => row.occurrenceId), occurrenceCollectionPoints: policyRows.map((row) => ({ occurrenceId: row.occurrenceId, collectionPointOccurrenceId: row.collectionPointOccurrenceId })) }, authorization: { id: authorization.id, version: authorization.authorizationVersion, state: authorization.state, payerBowlerId: authorization.payerBowlerId, policyId: authorization.policyId, policyVersion: authorization.policyVersion, coveredBowlerIds: covered, collectionPointOccurrenceIds: authorization.collectionPointOccurrenceIds }, acceptedPartnerIds: authorization.acceptedPartnerIds, payerOwnedPaymentMethod: true, paymentMethodLocationId: authorization.locationId, leagueLocationId: league.locationId, obligations: obligations.map((row) => ({ obligationId: row.id, occurrenceId: row.occurrenceId, bowlerId: row.bowlerId, amountMinor: row.amountMinor, allocatedMinor: allocById.get(row.id) ?? 0, reservedMinor: reservationById.get(row.id) ?? 0, currency: row.currency, state: row.state, reviewRequired: reviewIds.has(row.id) })) });
    return sendSuccess(res, result);
  } catch (error) {
    if (error instanceof F3ReadinessError) return sendError(res, "Canonical auto-pay quote is unavailable", 409, error.code);
    return sendError(res, "Canonical auto-pay quote is unavailable", 409, "F3_EVIDENCE_UNAVAILABLE");
  }
});

export default router;
