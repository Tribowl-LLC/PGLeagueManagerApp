import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  bowlerLeagues, bowlers, bowlerOccurrenceObligations, financialActivations,
  bowlerPaymentLinks,
  financialResponsibilities, f3AutopayPlanProvenance, f3CollectionPolicies,
  f3CollectionPolicyOccurrences, f3CollectionPolicyRevisions, f3PayerAuthorizations,
  f3PayerAuthorizationRevisions,
  leagueOccurrenceBillingTerms, leagueOccurrences, leagues, occurrenceCollectionPlanItems,
  occurrenceCollectionPlans, paymentOccurrenceAllocations, paymentSchedules, payments,
  occurrenceCollectionPlanRevisions,
} from "@shared/schema";
import { db } from "../db.js";
import { encrypt } from "../utils/crypto.js";
import { canonicalizePaymentOperationInput } from "./payment-operation-idempotency.js";
import { f3AuthorizationFingerprint, f3PolicyFingerprint, normalizeF3Policy, validateF3PolicyShape, type F3AuthorizationInput, type F3PolicyInput } from "@shared/f3-autopay-contract";
import { deriveF3ReadyPlan, F3ReadinessError } from "./f3-canonical-autopay.js";
import { getPaymentProvider } from "./payment-provider-factory.js";
import { getProviderCustomerId } from "./payment-utils.js";
import { canonicalF3AutopayEnabled } from "../config.js";
type F3DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class F3WorkflowError extends Error { constructor(public readonly code: string, message = "F3 workflow is unavailable", public readonly status = 409) { super(message); this.name = "F3WorkflowError"; } }
const fail = (code: string, message?: string, status = 409): never => { throw new F3WorkflowError(code, message, status); };
const hash = (value: unknown): string => createHash("sha256").update(canonicalizePaymentOperationInput(value)).digest("hex");
export const f3PaymentSourceFingerprint = (sourceId: string, locationId: number): string => hash({ sourceId, locationId });

/** Strict ownership check used only by payer authorization. Quote/policy/read
 * paths never call this or any provider. */
export async function validateF3PaymentMethodOwnership(input: { league: typeof leagues.$inferSelect; payer: typeof bowlers.$inferSelect; sourceId: string }): Promise<{ customerId: string }> {
  if (!input.league.locationId || input.payer.paymentProviderLocationId !== input.league.locationId) fail("PAYMENT_LOCATION_MISMATCH", undefined, 403);
  const provider = await getPaymentProvider(input.league.locationId);
  if (provider.providerName !== "square" || !provider.validateCardId(input.sourceId)) fail("INVALID_PAYMENT_SOURCE", undefined, 400);
  const customerId = getProviderCustomerId(input.payer, provider);
  if (!customerId) throw new F3WorkflowError("PAYMENT_CUSTOMER_REQUIRED", "Payer payment customer is required", 403);
  const cards = await provider.listCardsOnFile(customerId);
  if (!cards.some((card) => card.id === input.sourceId)) fail("CARD_OWNERSHIP_MISMATCH", undefined, 403);
  return { customerId };
}

export async function createF3Policy(input: F3PolicyInput & { actorUserId: number; commandKey: string }) {
  if (!canonicalF3AutopayEnabled) fail("F3_DISABLED");
  const policy = normalizeF3Policy({ organizationId: input.organizationId, leagueId: input.leagueId, activationId: input.activationId, activationRevision: input.activationRevision, activationSourceFingerprint: input.activationSourceFingerprint, policyVersion: input.policyVersion, collectionPoints: input.collectionPoints, occurrences: input.occurrences });
  validateF3PolicyShape(policy);
  if (!input.commandKey.trim()) fail("INVALID_COMMAND");
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${policy.organizationId}::integer, ${policy.leagueId}::integer)`);
    const [league] = await tx.select().from(leagues).where(and(eq(leagues.id, policy.leagueId), eq(leagues.organizationId, policy.organizationId))).limit(1);
    if (!league || league.paymentMode !== "weekly") fail(league ? "UPFRONT_NOT_SUPPORTED" : "NOT_FOUND", undefined, league ? 409 : 404);
    const [activation] = await tx.select().from(financialActivations).where(and(eq(financialActivations.organizationId, policy.organizationId), eq(financialActivations.leagueId, policy.leagueId), eq(financialActivations.id, policy.activationId), eq(financialActivations.currentRevision, policy.activationRevision), eq(financialActivations.sourceFingerprint, policy.activationSourceFingerprint), eq(financialActivations.state, "active"), eq(financialActivations.completenessMarker, true))).limit(1);
    if (!activation) fail("F1_ACTIVATION_DRIFT");
    const expected = await tx.select({ id: leagueOccurrences.id, termId: leagueOccurrenceBillingTerms.id, termVersion: leagueOccurrenceBillingTerms.version }).from(leagueOccurrences).innerJoin(leagueOccurrenceBillingTerms, and(eq(leagueOccurrenceBillingTerms.occurrenceId, leagueOccurrences.id), eq(leagueOccurrenceBillingTerms.organizationId, policy.organizationId), eq(leagueOccurrenceBillingTerms.leagueId, policy.leagueId), eq(leagueOccurrenceBillingTerms.obligationPolicy, "eligible_bowlers"), eq(leagueOccurrenceBillingTerms.state, "published"))).where(and(eq(leagueOccurrences.organizationId, policy.organizationId), eq(leagueOccurrences.leagueId, policy.leagueId), inArray(leagueOccurrences.lifecycle, ["published", "locked"])));
    const expectedOccurrences = new Set<string>();
    for (const row of expected) {
      if (expectedOccurrences.has(row.id)) fail("POLICY_BILLING_TERM_CONFLICT");
      expectedOccurrences.add(row.id);
    }
    const expectedSet = expectedOccurrences;
    const suppliedSet = new Set(policy.occurrences.map((row) => row.occurrenceId));
    if (expectedSet.size !== suppliedSet.size || [...expectedSet].some((id) => !suppliedSet.has(id)) || policy.collectionPoints.some((point) => !expectedSet.has(point.occurrenceId))) fail("POLICY_COVERAGE_INCOMPLETE");
    const policyCandidates = await tx.select({ id: f3CollectionPolicies.id, fingerprint: f3CollectionPolicies.policyFingerprint, commandKey: f3CollectionPolicies.commandKey, policyVersion: f3CollectionPolicies.policyVersion }).from(f3CollectionPolicies).where(and(eq(f3CollectionPolicies.organizationId, policy.organizationId), eq(f3CollectionPolicies.leagueId, policy.leagueId), sql`(${f3CollectionPolicies.policyVersion} = ${policy.policyVersion} OR ${f3CollectionPolicies.commandKey} = ${input.commandKey})`));
    const existing = policyCandidates.find((candidate) => candidate.policyVersion === policy.policyVersion || candidate.commandKey === input.commandKey);
    const policyFingerprint = f3PolicyFingerprint(policy);
    if (existing) { if (existing.fingerprint !== policyFingerprint || existing.commandKey !== input.commandKey) fail("IDEMPOTENCY_CONFLICT"); return { id: existing.id, policyFingerprint, replay: true }; }
    const [row] = await tx.insert(f3CollectionPolicies).values({ organizationId: policy.organizationId, leagueId: policy.leagueId, activationId: activation.id, activationRevision: activation.currentRevision, activationSourceFingerprint: activation.sourceFingerprint, policyVersion: policy.policyVersion, policyFingerprint, commandKey: input.commandKey, state: "draft", collectionPoints: policy.collectionPoints, createdByUserId: input.actorUserId }).returning();
    await tx.insert(f3CollectionPolicyOccurrences).values(policy.occurrences.map((item, itemIndex) => ({ organizationId: policy.organizationId, leagueId: policy.leagueId, policyId: row.id, occurrenceId: item.occurrenceId, groupKey: item.groupKey, groupRole: item.groupRole, pairedOccurrenceId: item.pairedOccurrenceId, collectionPointOccurrenceId: item.collectionPoint.occurrenceId, itemIndex })));
    await tx.insert(f3CollectionPolicyRevisions).values({ organizationId: policy.organizationId, leagueId: policy.leagueId, policyId: row.id, revisionNumber: 1, snapshotSchemaVersion: 1, beforeSnapshot: null, afterSnapshot: policy, recordedByUserId: input.actorUserId });
    return { id: row.id, policyFingerprint, replay: false };
  });
}

export async function approveF3Policy(input: { organizationId: number; leagueId: number; policyId: string; actorUserId: number }) {
  if (!canonicalF3AutopayEnabled) fail("F3_DISABLED");
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${input.organizationId}::integer, ${input.leagueId}::integer)`);
    const [policy] = await tx.select().from(f3CollectionPolicies).where(and(eq(f3CollectionPolicies.id, input.policyId), eq(f3CollectionPolicies.organizationId, input.organizationId), eq(f3CollectionPolicies.leagueId, input.leagueId))).limit(1).for("update");
    if (!policy || policy.state !== "draft") fail("POLICY_VERSION_CONFLICT");
    const [activation] = await tx.select({ id: financialActivations.id, revision: financialActivations.currentRevision, source: financialActivations.sourceFingerprint }).from(financialActivations).where(and(eq(financialActivations.id, policy.activationId), eq(financialActivations.organizationId, input.organizationId), eq(financialActivations.leagueId, input.leagueId), eq(financialActivations.state, "active"), eq(financialActivations.completenessMarker, true))).limit(1);
    if (!activation || activation.revision !== policy.activationRevision || activation.source !== policy.activationSourceFingerprint) fail("POLICY_ACTIVATION_DRIFT");
    const [current] = await tx.select().from(f3CollectionPolicies).where(and(eq(f3CollectionPolicies.organizationId, input.organizationId), eq(f3CollectionPolicies.leagueId, input.leagueId), eq(f3CollectionPolicies.state, "approved"))).limit(1);
    if (current && current.id !== policy.id) {
      await tx.update(f3CollectionPolicies).set({ state: "superseded" }).where(eq(f3CollectionPolicies.id, current.id));
      await tx.insert(f3CollectionPolicyRevisions).values({ organizationId: current.organizationId, leagueId: current.leagueId, policyId: current.id, revisionNumber: 2, snapshotSchemaVersion: 1, beforeSnapshot: current, afterSnapshot: { ...current, state: "superseded" }, recordedByUserId: input.actorUserId });
    }
    const oldAuthorizations = await tx.select().from(f3PayerAuthorizations).where(and(eq(f3PayerAuthorizations.organizationId, input.organizationId), eq(f3PayerAuthorizations.leagueId, input.leagueId), eq(f3PayerAuthorizations.state, "authorized"), current ? eq(f3PayerAuthorizations.policyId, current.id) : sql`false`));
    for (const authorization of oldAuthorizations) await supersedeAuthorizationPlans(tx, authorization);
    const approvedAt = new Date().toISOString();
    const [approved] = await tx.update(f3CollectionPolicies).set({ state: "approved", approvedByUserId: input.actorUserId, approvedAt }).where(eq(f3CollectionPolicies.id, policy.id)).returning();
    await tx.insert(f3CollectionPolicyRevisions).values({ organizationId: policy.organizationId, leagueId: policy.leagueId, policyId: policy.id, revisionNumber: 2, snapshotSchemaVersion: 1, beforeSnapshot: policy, afterSnapshot: approved, recordedByUserId: input.actorUserId });
    return approved;
  });
}

export async function authorizeF3Payer(input: F3AuthorizationInput & { sourceId: string; customerId: string | null; actorUserId: number; providerValidated: boolean; payerOwnedPaymentMethod: boolean; leagueLocationId: number; commandKey: string }) {
  if (!canonicalF3AutopayEnabled) fail("F3_DISABLED");
  if (!input.providerValidated || !input.payerOwnedPaymentMethod) fail("PAYMENT_METHOD_NOT_OWNED", undefined, 403);
  if (!input.commandKey.trim()) fail("INVALID_COMMAND", undefined, 400);
  if (input.locationId !== input.leagueLocationId) fail("PAYMENT_LOCATION_MISMATCH");
  const paymentMethodFingerprint = f3PaymentSourceFingerprint(input.sourceId, input.locationId);
  const fingerprint = f3AuthorizationFingerprint({ organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerId: input.payerBowlerId, authorizationVersion: input.authorizationVersion, policyId: input.policyId, policyVersion: input.policyVersion, coveredBowlerIds: input.coveredBowlerIds, acceptedPartnerIds: input.acceptedPartnerIds, paymentMethodFingerprint, locationId: input.locationId, collectionPointOccurrenceIds: input.collectionPointOccurrenceIds, timing: input.timing });
  const normalizedPayees = [...new Set(input.coveredBowlerIds)].sort((a, b) => a - b);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${input.organizationId}::integer, ${input.leagueId}::integer)`);
    const [league] = await tx.select().from(leagues).where(and(eq(leagues.id, input.leagueId), eq(leagues.organizationId, input.organizationId))).limit(1);
    if (!league || league.paymentMode !== "weekly") fail(league ? "UPFRONT_NOT_SUPPORTED" : "NOT_FOUND");
    const memberships = await tx.select({ id: bowlerLeagues.bowlerId }).from(bowlerLeagues).innerJoin(bowlers, and(eq(bowlers.id, bowlerLeagues.bowlerId), eq(bowlers.organizationId, input.organizationId), eq(bowlers.active, true))).where(and(eq(bowlerLeagues.leagueId, input.leagueId), eq(bowlerLeagues.active, true), inArray(bowlerLeagues.bowlerId, normalizedPayees)));
    if (memberships.length !== normalizedPayees.length) fail("ACTIVE_MEMBERSHIP_REQUIRED", undefined, 403);
    const partnerIds = normalizedPayees.filter((id) => id !== input.payerBowlerId);
    if (partnerIds.length > 0) {
      const links = await tx.select({ a: bowlerPaymentLinks.bowlerAId, b: bowlerPaymentLinks.bowlerBId }).from(bowlerPaymentLinks).where(and(eq(bowlerPaymentLinks.organizationId, input.organizationId), eq(bowlerPaymentLinks.status, "accepted"), sql`(${bowlerPaymentLinks.bowlerAId} = ${input.payerBowlerId} OR ${bowlerPaymentLinks.bowlerBId} = ${input.payerBowlerId})`));
      const linked = new Set(links.map((link) => link.a === input.payerBowlerId ? link.b : link.a));
      if (partnerIds.some((id) => !linked.has(id))) fail("PARTNER_NOT_ACCEPTED", undefined, 403);
    }
    const schedules = await tx.select().from(paymentSchedules).where(and(eq(paymentSchedules.leagueId, input.leagueId), eq(paymentSchedules.active, true)));
    if (schedules.some((schedule) => normalizedPayees.includes(schedule.bowlerId) || (schedule.additionalBowlerIds ?? []).some((id) => normalizedPayees.includes(id)))) fail("LEGACY_SCHEDULE_CONFLICT");
    const [policy] = await tx.select().from(f3CollectionPolicies).where(and(eq(f3CollectionPolicies.id, input.policyId), eq(f3CollectionPolicies.organizationId, input.organizationId), eq(f3CollectionPolicies.leagueId, input.leagueId), eq(f3CollectionPolicies.policyVersion, input.policyVersion), eq(f3CollectionPolicies.state, "approved"))).limit(1);
    if (!policy) fail("POLICY_NOT_APPROVED");
    const policyRows = await tx.select().from(f3CollectionPolicyOccurrences).where(and(eq(f3CollectionPolicyOccurrences.policyId, policy.id), eq(f3CollectionPolicyOccurrences.organizationId, input.organizationId), eq(f3CollectionPolicyOccurrences.leagueId, input.leagueId))).orderBy(asc(f3CollectionPolicyOccurrences.itemIndex));
    if (new Set(input.collectionPointOccurrenceIds).size !== input.collectionPointOccurrenceIds.length || input.collectionPointOccurrenceIds.length !== new Set(policyRows.map((r) => r.collectionPointOccurrenceId)).size || input.collectionPointOccurrenceIds.some((id) => !policyRows.some((r) => r.collectionPointOccurrenceId === id))) fail("COLLECTION_POINT_MISMATCH");
    const [activation] = await tx.select({ id: financialActivations.id, revision: financialActivations.currentRevision, source: financialActivations.sourceFingerprint }).from(financialActivations).where(and(eq(financialActivations.id, policy.activationId), eq(financialActivations.organizationId, input.organizationId), eq(financialActivations.leagueId, input.leagueId), eq(financialActivations.state, "active"), eq(financialActivations.completenessMarker, true))).limit(1);
    if (!activation || activation.revision !== policy.activationRevision || activation.source !== policy.activationSourceFingerprint) fail("ACTIVATION_DRIFT");
    const authorizationCandidates = await tx.select().from(f3PayerAuthorizations).where(and(eq(f3PayerAuthorizations.organizationId, input.organizationId), eq(f3PayerAuthorizations.leagueId, input.leagueId), eq(f3PayerAuthorizations.payerBowlerId, input.payerBowlerId), sql`(${f3PayerAuthorizations.authorizationVersion} = ${input.authorizationVersion} OR ${f3PayerAuthorizations.commandKey} = ${input.commandKey})`));
    const existing = authorizationCandidates.find((candidate) => candidate.authorizationVersion === input.authorizationVersion || candidate.commandKey === input.commandKey);
    if (existing) { if (existing.authorizationFingerprint !== fingerprint || existing.commandKey !== input.commandKey) fail("IDEMPOTENCY_CONFLICT"); return { authorizationId: existing.id, replay: true }; }
    const priorAuthorizations = await tx.select().from(f3PayerAuthorizations).where(and(eq(f3PayerAuthorizations.organizationId, input.organizationId), eq(f3PayerAuthorizations.leagueId, input.leagueId), eq(f3PayerAuthorizations.payerBowlerId, input.payerBowlerId), eq(f3PayerAuthorizations.state, "authorized"))).for("update");
    for (const authorization of priorAuthorizations) await supersedeAuthorizationPlans(tx, authorization);
    const [auth] = await tx.insert(f3PayerAuthorizations).values({ organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerId: input.payerBowlerId, policyId: policy.id, policyVersion: policy.policyVersion, authorizationVersion: input.authorizationVersion, authorizationFingerprint: fingerprint, commandKey: input.commandKey, coveredBowlerIds: normalizedPayees, acceptedPartnerIds: input.acceptedPartnerIds, collectionPointOccurrenceIds: [...input.collectionPointOccurrenceIds].sort(), locationId: input.locationId, encryptedSourceId: encrypt(input.sourceId), encryptedCustomerId: input.customerId ? encrypt(input.customerId) : null, paymentMethodFingerprint, timing: "at_collection_point", state: "authorized", createdByUserId: input.actorUserId, authorizedAt: new Date().toISOString() }).returning();
    await tx.insert(f3PayerAuthorizationRevisions).values({ organizationId: input.organizationId, leagueId: input.leagueId, authorizationId: auth.id, revisionNumber: 1, snapshotSchemaVersion: 1, beforeSnapshot: null, afterSnapshot: auth, recordedByUserId: input.actorUserId });
    const ready = await persistF3D2Plans(tx, { organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerId: input.payerBowlerId, policy, policyRows, auth, activation, coveredBowlerIds: normalizedPayees });
    return { authorizationId: auth.id, plans: ready, replay: false };
  });
}

export async function revokeF3Authorization(input: { organizationId: number; leagueId: number; authorizationId: string; actorUserId: number; actorBowlerId?: number }) {
  if (!canonicalF3AutopayEnabled) fail("F3_DISABLED");
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${input.organizationId}::integer, ${input.leagueId}::integer)`);
    const [current] = await tx.select().from(f3PayerAuthorizations).where(and(eq(f3PayerAuthorizations.id, input.authorizationId), eq(f3PayerAuthorizations.organizationId, input.organizationId), eq(f3PayerAuthorizations.leagueId, input.leagueId), eq(f3PayerAuthorizations.state, "authorized"))).limit(1).for("share");
    if (!current) fail("AUTHORIZATION_NOT_FOUND", undefined, 404);
    if (input.actorBowlerId !== undefined && current.payerBowlerId !== input.actorBowlerId) fail("NOT_FOUND", undefined, 404);
    await supersedeAuthorizationPlans(tx, current);
    const [revoked] = await tx.insert(f3PayerAuthorizations).values({ organizationId: current.organizationId, leagueId: current.leagueId, payerBowlerId: current.payerBowlerId, policyId: current.policyId, policyVersion: current.policyVersion, authorizationVersion: current.authorizationVersion + 1, authorizationFingerprint: `lvf3auth:v1:${hash({ supersedes: current.id, state: "revoked", actorUserId: input.actorUserId })}`, commandKey: `revoke:${current.id}:${current.authorizationVersion + 1}`, coveredBowlerIds: current.coveredBowlerIds, acceptedPartnerIds: current.acceptedPartnerIds, collectionPointOccurrenceIds: current.collectionPointOccurrenceIds, locationId: current.locationId, encryptedSourceId: current.encryptedSourceId, encryptedCustomerId: current.encryptedCustomerId, paymentMethodFingerprint: current.paymentMethodFingerprint, timing: current.timing, state: "revoked", createdByUserId: input.actorUserId, revokedAt: new Date().toISOString() }).returning();
    await tx.insert(f3PayerAuthorizationRevisions).values({ organizationId: revoked.organizationId, leagueId: revoked.leagueId, authorizationId: revoked.id, revisionNumber: 1, snapshotSchemaVersion: 1, beforeSnapshot: null, afterSnapshot: revoked, recordedByUserId: input.actorUserId });
    return revoked;
  });
}

async function persistF3D2Plans(tx: F3DbTransaction, input: {
  organizationId: number; leagueId: number; payerBowlerId: number;
  policy: typeof f3CollectionPolicies.$inferSelect;
  policyRows: Array<typeof f3CollectionPolicyOccurrences.$inferSelect>;
  auth: typeof f3PayerAuthorizations.$inferSelect;
  activation: { id: string; revision: number; source: string };
  coveredBowlerIds: number[];
}) {
  const obligations = await tx.select().from(bowlerOccurrenceObligations).where(and(eq(bowlerOccurrenceObligations.organizationId, input.organizationId), eq(bowlerOccurrenceObligations.leagueId, input.leagueId), inArray(bowlerOccurrenceObligations.bowlerId, input.coveredBowlerIds))).for("update");
  const responsibilities = await tx.select({ occurrenceId: financialResponsibilities.occurrenceId, bowlerId: financialResponsibilities.bowlerId, obligationId: financialResponsibilities.obligationId, amountMinor: financialResponsibilities.amountMinor, currency: financialResponsibilities.currency }).from(financialResponsibilities).where(and(eq(financialResponsibilities.organizationId, input.organizationId), eq(financialResponsibilities.leagueId, input.leagueId), eq(financialResponsibilities.activationId, input.activation.id), inArray(financialResponsibilities.bowlerId, input.coveredBowlerIds)));
  const byKey = new Map<string, typeof responsibilities[number]>();
  for (const responsibility of responsibilities) {
    const key = `${responsibility.occurrenceId}:${responsibility.bowlerId}`;
    if (byKey.has(key)) fail("OBLIGATION_EVIDENCE_INCONSISTENT");
    byKey.set(key, responsibility);
  }
  const allocations = await tx.select({ obligationId: paymentOccurrenceAllocations.obligationId, amountMinor: paymentOccurrenceAllocations.amountMinor, status: payments.status }).from(paymentOccurrenceAllocations).innerJoin(payments, eq(payments.id, paymentOccurrenceAllocations.paymentId)).where(and(eq(paymentOccurrenceAllocations.organizationId, input.organizationId), eq(paymentOccurrenceAllocations.leagueId, input.leagueId), eq(paymentOccurrenceAllocations.state, "active")));
  const allocated = new Map<string, number>();
  for (const row of allocations) { if (row.status !== "paid") fail("OBLIGATION_REVIEW_REQUIRED"); allocated.set(row.obligationId, (allocated.get(row.obligationId) ?? 0) + row.amountMinor); }
  const reserved = await tx.select({ obligationId: occurrenceCollectionPlanItems.obligationId, amountMinor: occurrenceCollectionPlanItems.amountMinor }).from(occurrenceCollectionPlanItems).innerJoin(occurrenceCollectionPlans, and(eq(occurrenceCollectionPlans.id, occurrenceCollectionPlanItems.planId), eq(occurrenceCollectionPlans.state, "ready"))).where(and(eq(occurrenceCollectionPlanItems.organizationId, input.organizationId), eq(occurrenceCollectionPlanItems.leagueId, input.leagueId)));
  const reservedBy = new Map<string, number>(); for (const row of reserved) reservedBy.set(row.obligationId, (reservedBy.get(row.obligationId) ?? 0) + row.amountMinor);
  const plans: unknown[] = [];
  for (const point of new Set(input.policyRows.map((row) => row.collectionPointOccurrenceId))) {
    const items = [];
    for (const policyRow of input.policyRows.filter((row) => row.collectionPointOccurrenceId === point)) for (const bowlerId of input.coveredBowlerIds) {
      const responsibility = byKey.get(`${policyRow.occurrenceId}:${bowlerId}`); const obligation = obligations.find((o) => o.id === responsibility?.obligationId && o.occurrenceId === policyRow.occurrenceId && o.bowlerId === bowlerId);
      if (!responsibility || !obligation) throw new F3WorkflowError("OBLIGATION_EVIDENCE_INCOMPLETE");
      if (obligation.currency !== "USD" || responsibility.currency !== obligation.currency || responsibility.amountMinor !== obligation.amountMinor || ["settled", "voided"].includes(obligation.state)) fail("OBLIGATION_EVIDENCE_INCOMPLETE");
      if (obligation.dueAt && new Date(obligation.dueAt).getTime() <= Date.now()) fail("IMMEDIATE_CATCHUP_REQUIRED");
      const amount = obligation.amountMinor - (allocated.get(obligation.id) ?? 0) - (reservedBy.get(obligation.id) ?? 0); if (amount <= 0) fail("OBLIGATION_ALREADY_RESERVED");
      items.push({ organizationId: input.organizationId, leagueId: input.leagueId, planId: "", obligationId: obligation.id, occurrenceId: obligation.occurrenceId, bowlerId, amountMinor: amount, currency: "USD", itemIndex: items.length });
    }
    const [plan] = await tx.insert(occurrenceCollectionPlans).values({ organizationId: input.organizationId, leagueId: input.leagueId, planKey: `f3:${input.auth.id}:${point}`, triggerOccurrenceId: point, collectAt: null, currency: "USD", state: "ready", version: 1, currentRevision: 1, recordedByUserId: input.auth.createdByUserId }).returning();
    const persistedItems = items.map((item) => ({ ...item, planId: plan.id }));
    await tx.insert(occurrenceCollectionPlanItems).values(persistedItems);
    await tx.insert(occurrenceCollectionPlanRevisions).values({ organizationId: input.organizationId, leagueId: input.leagueId, planId: plan.id, revisionNumber: 1, snapshotSchemaVersion: 1, beforeSnapshot: null, afterSnapshot: { state: "ready", plan, items: persistedItems }, recordedByUserId: input.auth.createdByUserId });
    await tx.insert(f3AutopayPlanProvenance).values({ organizationId: input.organizationId, leagueId: input.leagueId, d2PlanId: plan.id, payerBowlerId: input.payerBowlerId, policyId: input.policy.id, policyVersion: input.policy.policyVersion, authorizationId: input.auth.id, authorizationVersion: input.auth.authorizationVersion, activationId: input.activation.id, activationRevision: input.activation.revision, activationSourceFingerprint: input.activation.source, planVersion: 1, planFingerprint: `lvf3plan:v1:${hash({ planId: plan.id, items: persistedItems, point })}`, collectionPointOccurrenceId: point });
    plans.push(plan);
  }
  return plans;
}

async function supersedeAuthorizationPlans(tx: F3DbTransaction, authorization: typeof f3PayerAuthorizations.$inferSelect) {
  await tx.update(f3PayerAuthorizations).set({ state: "superseded" }).where(and(eq(f3PayerAuthorizations.id, authorization.id), eq(f3PayerAuthorizations.organizationId, authorization.organizationId), eq(f3PayerAuthorizations.leagueId, authorization.leagueId)));
  await tx.insert(f3PayerAuthorizationRevisions).values({ organizationId: authorization.organizationId, leagueId: authorization.leagueId, authorizationId: authorization.id, revisionNumber: 2, snapshotSchemaVersion: 1, beforeSnapshot: authorization, afterSnapshot: { ...authorization, state: "superseded" }, recordedByUserId: authorization.createdByUserId });
  const provenance = await tx.select({ planId: f3AutopayPlanProvenance.d2PlanId }).from(f3AutopayPlanProvenance).where(and(eq(f3AutopayPlanProvenance.organizationId, authorization.organizationId), eq(f3AutopayPlanProvenance.leagueId, authorization.leagueId), eq(f3AutopayPlanProvenance.authorizationId, authorization.id)));
  for (const row of provenance) await tx.update(occurrenceCollectionPlans).set({ state: "superseded", updatedAt: new Date().toISOString() }).where(and(eq(occurrenceCollectionPlans.id, row.planId), eq(occurrenceCollectionPlans.organizationId, authorization.organizationId), eq(occurrenceCollectionPlans.leagueId, authorization.leagueId), eq(occurrenceCollectionPlans.state, "ready")));
}
