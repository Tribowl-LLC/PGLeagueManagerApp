import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  bowlerLeagues, bowlers, bowlerOccurrenceObligations, financialActivations,
  bowlerPaymentLinks,
  financialResponsibilities, f3AutopayPlanProvenance, f3CollectionPolicies,
  f3CollectionPolicyOccurrences, f3CollectionPolicyRevisions, f3PayerAuthorizations,
  f3PayerAuthorizationRevisions,
  leagueOccurrenceBillingTerms, leagueOccurrences, leagues, occurrenceCollectionPlanItems,
  occurrenceCollectionPlans, paymentOccurrenceAllocations, paymentSchedules, payments,
  occurrenceCollectionPlanRevisions,
  paymentOperationOccurrenceSnapshotAllocations, paymentOperations, paymentDisputes,
} from "@shared/schema";
import { db } from "../db.js";
import { encrypt } from "../utils/crypto.js";
import { canonicalizePaymentOperationInput } from "./payment-operation-idempotency.js";
import { canonicalizeF3QuoteItems, f3AggregatePlanFingerprint, f3AuthorizationFingerprint, f3PolicyFingerprint, f3PreauthorizationFingerprint, f3SemanticPlanFingerprint, normalizeF3Policy, validateF3PolicyShape, F3_PREAUTHORIZATION_QUOTE_CONTRACT, type F3AuthorizationInput, type F3PolicyInput, type F3QuoteItem } from "@shared/f3-autopay-contract";
import { getPaymentProvider } from "./payment-provider-factory.js";
import { getProviderCustomerId } from "./payment-utils.js";
import { canonicalF3AutopayEnabled } from "../config.js";
import { loadOperationalActivationEvidence } from "./canonical-due-past-due.js";
type F3DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class F3WorkflowError extends Error { constructor(public readonly code: string, message = "F3 workflow is unavailable", public readonly status = 409) { super(message); this.name = "F3WorkflowError"; } }
const fail = (code: string, message?: string, status = 409): never => { throw new F3WorkflowError(code, message, status); };
const hash = (value: unknown): string => createHash("sha256").update(canonicalizePaymentOperationInput(value)).digest("hex");
export const f3PaymentSourceFingerprint = (sourceId: string, locationId: number): string => hash({ sourceId, locationId });

type F3ActivationEvidenceRow = Pick<typeof financialActivations.$inferSelect, "id" | "currentRevision" | "sourceFingerprint" | "expectedGroupCount" | "expectedResponsibilityCount">;

async function requireLiveF1ActivationEvidence(
  tx: F3DbTransaction,
  input: { organizationId: number; leagueId: number },
  activation: F3ActivationEvidenceRow,
): Promise<void> {
  try {
    const live = await loadOperationalActivationEvidence(tx, input);
    if (live.authoritativeSource !== "canonical"
      || live.sourceFingerprint !== activation.sourceFingerprint
      || live.expected.length !== activation.expectedGroupCount
      || activation.expectedGroupCount <= 0
      || activation.expectedResponsibilityCount <= 0) {
      fail("ACTIVATION_SOURCE_DRIFT");
    }
  } catch (error) {
    if (error instanceof F3WorkflowError) throw error;
    fail("ACTIVATION_SOURCE_DRIFT");
  }
}

/** Stable, non-sensitive policy revision evidence. Every policy revision uses
 * this exact shape so the audit stream always contains the durable lifecycle
 * and the ordered occurrence/pair rows together. */
function f3PolicyRevisionSnapshot(policy: typeof f3CollectionPolicies.$inferSelect | F3PolicyInput, rows: Array<{ occurrenceId: string; groupKey: string; groupRole: string; pairedOccurrenceId: string | null; collectionPointOccurrenceId: string; itemIndex: number }>) {
  return {
    contractVersion: "canonical-collection-policy/1",
    policy: {
      id: "id" in policy ? policy.id : null,
      organizationId: policy.organizationId,
      leagueId: policy.leagueId,
      activationId: policy.activationId,
      activationRevision: policy.activationRevision,
      activationSourceFingerprint: policy.activationSourceFingerprint,
      policyVersion: policy.policyVersion,
      policyFingerprint: "policyFingerprint" in policy ? policy.policyFingerprint : null,
      commandKey: "commandKey" in policy ? policy.commandKey : null,
      state: "state" in policy ? policy.state : "draft",
      currentRevision: "currentRevision" in policy ? policy.currentRevision : 1,
      collectionPoints: [...policy.collectionPoints].map((point) => ({ occurrenceId: typeof point === "string" ? point : point.occurrenceId })),
      approvedByUserId: "approvedByUserId" in policy ? policy.approvedByUserId : null,
      approvedAt: "approvedAt" in policy ? policy.approvedAt : null,
    },
    occurrences: [...rows].sort((a, b) => a.itemIndex - b.itemIndex || a.occurrenceId.localeCompare(b.occurrenceId)).map((row) => ({ occurrenceId: row.occurrenceId, groupKey: row.groupKey, groupRole: row.groupRole, pairedOccurrenceId: row.pairedOccurrenceId, collectionPointOccurrenceId: row.collectionPointOccurrenceId, itemIndex: row.itemIndex })),
  };
}

export async function readF3PolicyCandidates(input: { organizationId: number; leagueId: number }) {
  if (!canonicalF3AutopayEnabled) fail("F3_DISABLED");
  return db.transaction(async (tx) => {
    const [candidateLeague] = await tx.select({ id: leagues.id, paymentMode: leagues.paymentMode, active: leagues.active }).from(leagues).where(and(eq(leagues.id, input.leagueId), eq(leagues.organizationId, input.organizationId))).limit(1);
    if (!candidateLeague) fail("NOT_FOUND", undefined, 404);
    if (!candidateLeague.active) fail("NOT_FOUND", undefined, 404);
    if (candidateLeague.paymentMode !== "weekly") fail("UPFRONT_NOT_SUPPORTED", "Interactive F2 collection is required for upfront leagues");
    const [activation] = await tx.select({ id: financialActivations.id, revision: financialActivations.currentRevision, sourceFingerprint: financialActivations.sourceFingerprint, expectedGroupCount: financialActivations.expectedGroupCount, expectedResponsibilityCount: financialActivations.expectedResponsibilityCount }).from(financialActivations).where(and(eq(financialActivations.organizationId, input.organizationId), eq(financialActivations.leagueId, input.leagueId), eq(financialActivations.state, "active"), eq(financialActivations.completenessMarker, true))).limit(1);
    if (!activation) fail("F1_ACTIVATION_REQUIRED");
    await requireLiveF1ActivationEvidence(tx, input, { id: activation.id, currentRevision: activation.revision, sourceFingerprint: activation.sourceFingerprint, expectedGroupCount: activation.expectedGroupCount, expectedResponsibilityCount: activation.expectedResponsibilityCount });
    const occurrences = await tx.select({ id: leagueOccurrences.id, startAt: leagueOccurrences.startAt, lifecycle: leagueOccurrences.lifecycle, localDate: leagueOccurrences.authoritativeLocalDate, localStartTime: leagueOccurrences.authoritativeLocalStartTime, timezone: leagueOccurrences.timezone, ordinal: leagueOccurrences.plannedOrdinal }).from(leagueOccurrences).innerJoin(leagueOccurrenceBillingTerms, and(eq(leagueOccurrenceBillingTerms.occurrenceId, leagueOccurrences.id), eq(leagueOccurrenceBillingTerms.organizationId, input.organizationId), eq(leagueOccurrenceBillingTerms.leagueId, input.leagueId), eq(leagueOccurrenceBillingTerms.state, "published"), eq(leagueOccurrenceBillingTerms.obligationPolicy, "eligible_bowlers"))).where(and(eq(leagueOccurrences.organizationId, input.organizationId), eq(leagueOccurrences.leagueId, input.leagueId), inArray(leagueOccurrences.lifecycle, ["published", "locked"]))).orderBy(asc(leagueOccurrences.plannedOrdinal), asc(leagueOccurrences.authoritativeLocalDate), asc(leagueOccurrences.id));
    const policySummaries = await tx.select({ id: f3CollectionPolicies.id, policyVersion: f3CollectionPolicies.policyVersion, state: f3CollectionPolicies.state, policyFingerprint: f3CollectionPolicies.policyFingerprint }).from(f3CollectionPolicies).where(and(eq(f3CollectionPolicies.organizationId, input.organizationId), eq(f3CollectionPolicies.leagueId, input.leagueId), sql`${f3CollectionPolicies.state} IN ('approved','draft')`)).orderBy(desc(f3CollectionPolicies.policyVersion), desc(f3CollectionPolicies.currentRevision), asc(f3CollectionPolicies.id));
    const draftSummary = policySummaries.find((policy) => policy.state === "draft") ?? null;
    const draftRows = draftSummary ? await tx.select({ occurrenceId: f3CollectionPolicyOccurrences.occurrenceId, groupKey: f3CollectionPolicyOccurrences.groupKey, groupRole: f3CollectionPolicyOccurrences.groupRole, pairedOccurrenceId: f3CollectionPolicyOccurrences.pairedOccurrenceId, collectionPointOccurrenceId: f3CollectionPolicyOccurrences.collectionPointOccurrenceId, itemIndex: f3CollectionPolicyOccurrences.itemIndex }).from(f3CollectionPolicyOccurrences).where(and(eq(f3CollectionPolicyOccurrences.organizationId, input.organizationId), eq(f3CollectionPolicyOccurrences.leagueId, input.leagueId), eq(f3CollectionPolicyOccurrences.policyId, draftSummary.id))).orderBy(asc(f3CollectionPolicyOccurrences.itemIndex), asc(f3CollectionPolicyOccurrences.occurrenceId)) : [];
    return { activation, collectionPoints: occurrences.map((row) => ({ occurrenceId: row.id })), occurrences, nextPolicyVersion: (policySummaries[0]?.policyVersion ?? 0) + 1, currentPolicy: policySummaries.find((policy) => policy.state === "approved") ?? null, draftPolicy: draftSummary ? { ...draftSummary, collectionPoints: draftRows.filter((row) => row.groupRole === "normal" || row.groupRole === "trigger").map((row) => ({ occurrenceId: row.collectionPointOccurrenceId })), occurrences: draftRows } : null, policySummaries };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

export type F3QuoteEvidenceResponsibility = { occurrenceId: string; bowlerId: number; obligationId: string; amountMinor: number; currency: string };
export type F3QuoteEvidenceObligation = { id: string; occurrenceId: string; bowlerId: number; amountMinor: number; currency: string; state: string; dueAt: string | null };
export type F3QuoteEvidenceAllocation = { obligationId: string; amountMinor: number; status: string; refundedAt?: string | null; disputedAt?: string | null; paymentOperationId?: string | null; disputeEvidence?: boolean };
export type F3QuoteEvidenceReservation = { obligationId: string; amountMinor: number; kind?: "ready_plan" | "pending_f2" };
export type F3QuoteEvidencePolicyRow = { occurrenceId: string; collectionPointOccurrenceId: string };

/** Pure, provider-free quote evidence derivation shared by prequote and the
 * locked authorization path. All callers must supply rows read under their
 * appropriate tenant/league evidence boundary. */
export function buildF3QuoteEvidence(input: {
  policyRows: F3QuoteEvidencePolicyRow[];
  coveredBowlerIds: number[];
  responsibilities: F3QuoteEvidenceResponsibility[];
  obligations: F3QuoteEvidenceObligation[];
  allocations: F3QuoteEvidenceAllocation[];
  reservations: F3QuoteEvidenceReservation[];
  transactionNow: number;
  allowDueItems: boolean;
}): { items: F3QuoteItem[]; catchUpRequired: boolean } {
  const responsibilityByKey = new Map<string, F3QuoteEvidenceResponsibility>();
  for (const row of input.responsibilities) {
    const key = `${row.occurrenceId}:${row.bowlerId}`;
    if (responsibilityByKey.has(key)) fail("OBLIGATION_EVIDENCE_INCONSISTENT");
    responsibilityByKey.set(key, row);
  }
  // The activation snapshot is authoritative for this quote.  A row outside
  // the policy × covered-payer Cartesian product is evidence drift, not an
  // ignorable extra responsibility.  Ignoring it could make a malformed F1
  // snapshot appear complete while reserving only a subset of its debt.
  const expectedResponsibilityKeys = new Set(
    input.policyRows.flatMap((policyRow) => input.coveredBowlerIds.map((bowlerId) => `${policyRow.occurrenceId}:${bowlerId}`)),
  );
  if (responsibilityByKey.size !== expectedResponsibilityKeys.size || [...responsibilityByKey.keys()].some((key) => !expectedResponsibilityKeys.has(key))) {
    fail("OBLIGATION_EVIDENCE_INCONSISTENT");
  }
  const allocated = new Map<string, number>();
  for (const row of input.allocations) {
    if (row.status !== "paid" || row.refundedAt || row.disputedAt || row.disputeEvidence) fail("OBLIGATION_REVIEW_REQUIRED");
    allocated.set(row.obligationId, (allocated.get(row.obligationId) ?? 0) + row.amountMinor);
  }
  const reserved = new Map<string, number>();
  for (const row of input.reservations) {
    if (row.kind === "pending_f2") fail("OBLIGATION_RESERVED_BY_F2_OPERATION");
    reserved.set(row.obligationId, (reserved.get(row.obligationId) ?? 0) + row.amountMinor);
  }
  const items: F3QuoteItem[] = [];
  let catchUpRequired = false;
  for (const policyRow of input.policyRows) for (const bowlerId of input.coveredBowlerIds) {
    const responsibility = responsibilityByKey.get(`${policyRow.occurrenceId}:${bowlerId}`);
    const obligation = input.obligations.find((row) => row.id === responsibility?.obligationId && row.occurrenceId === policyRow.occurrenceId && row.bowlerId === bowlerId);
    if (!responsibility || !obligation) throw new F3WorkflowError("OBLIGATION_EVIDENCE_INCOMPLETE");
    const allocatedMinor = allocated.get(obligation.id) ?? 0;
    if (allocatedMinor < 0 || allocatedMinor > obligation.amountMinor) fail("OBLIGATION_EVIDENCE_INCONSISTENT");
    if (obligation.currency !== "USD" || responsibility.currency !== obligation.currency || responsibility.amountMinor !== obligation.amountMinor || ["settled", "voided"].includes(obligation.state)) fail("OBLIGATION_EVIDENCE_INCOMPLETE");
    const expectedLifecycle = allocatedMinor === 0 ? "open" : "partially_settled";
    if (obligation.state !== expectedLifecycle) fail("OBLIGATION_EVIDENCE_INCONSISTENT");
    if (obligation.dueAt && new Date(obligation.dueAt).getTime() <= input.transactionNow) {
      catchUpRequired = true;
      if (!input.allowDueItems) fail("IMMEDIATE_CATCHUP_REQUIRED");
    }
    const reservedMinor = reserved.get(obligation.id) ?? 0;
    if (reservedMinor < 0 || reservedMinor > obligation.amountMinor - allocatedMinor) fail("OBLIGATION_EVIDENCE_INCONSISTENT");
    const amountMinor = obligation.amountMinor - allocatedMinor - reservedMinor;
    if (amountMinor <= 0) fail("OBLIGATION_ALREADY_RESERVED");
    items.push({ obligationId: obligation.id, occurrenceId: obligation.occurrenceId, bowlerId, collectionPointOccurrenceId: policyRow.collectionPointOccurrenceId, amountMinor, itemIndex: items.length });
  }
  return { items: canonicalizeF3QuoteItems(items, [...new Set(input.policyRows.map((row) => row.collectionPointOccurrenceId))]), catchUpRequired };
}

export async function readF3PreauthorizationQuote(input: { organizationId: number; leagueId: number; payerBowlerId: number; coveredBowlerIds: number[] }) {
  if (!canonicalF3AutopayEnabled) fail("F3_DISABLED");
  const coveredBowlerIds = [...new Set(input.coveredBowlerIds)].sort((a, b) => a - b);
  if (!coveredBowlerIds.includes(input.payerBowlerId)) fail("PAYER_MUST_BE_COVERED", undefined, 403);
  return db.transaction(async (tx) => {
    const [league] = await tx.select().from(leagues).where(and(eq(leagues.id, input.leagueId), eq(leagues.organizationId, input.organizationId))).limit(1);
    if (!league) fail("NOT_FOUND", undefined, 404);
    if (!league.active) fail("NOT_FOUND", undefined, 404);
    if (league.paymentMode !== "weekly") fail("UPFRONT_NOT_SUPPORTED", "Interactive F2 collection is required for upfront leagues");
    const memberships = await tx.select({ bowlerId: bowlerLeagues.bowlerId }).from(bowlerLeagues).innerJoin(bowlers, and(eq(bowlers.id, bowlerLeagues.bowlerId), eq(bowlers.organizationId, input.organizationId), eq(bowlers.active, true))).where(and(eq(bowlerLeagues.leagueId, input.leagueId), eq(bowlerLeagues.active, true), inArray(bowlerLeagues.bowlerId, coveredBowlerIds)));
    if (new Set(memberships.map((row) => row.bowlerId)).size !== coveredBowlerIds.length) fail("ACTIVE_MEMBERSHIP_REQUIRED", "Not found", 404);
    const legacySchedules = await tx.select({ bowlerId: paymentSchedules.bowlerId, additionalBowlerIds: paymentSchedules.additionalBowlerIds }).from(paymentSchedules).where(and(eq(paymentSchedules.leagueId, input.leagueId), eq(paymentSchedules.active, true)));
    if (legacySchedules.some((schedule) => coveredBowlerIds.includes(schedule.bowlerId) || (schedule.additionalBowlerIds ?? []).some((id) => coveredBowlerIds.includes(id)))) fail("LEGACY_SCHEDULE_CONFLICT");
    const links = await tx.select({ a: bowlerPaymentLinks.bowlerAId, b: bowlerPaymentLinks.bowlerBId }).from(bowlerPaymentLinks).where(and(eq(bowlerPaymentLinks.organizationId, input.organizationId), eq(bowlerPaymentLinks.status, "accepted"), or(eq(bowlerPaymentLinks.bowlerAId, input.payerBowlerId), eq(bowlerPaymentLinks.bowlerBId, input.payerBowlerId))));
    const acceptedPartnerIds = links.map((row) => row.a === input.payerBowlerId ? row.b : row.a).filter((id) => coveredBowlerIds.includes(id)).sort((a, b) => a - b);
    if (coveredBowlerIds.some((id) => id !== input.payerBowlerId && !acceptedPartnerIds.includes(id))) fail("PARTNER_NOT_ACCEPTED", undefined, 403);
    const [policy] = await tx.select().from(f3CollectionPolicies).where(and(eq(f3CollectionPolicies.organizationId, input.organizationId), eq(f3CollectionPolicies.leagueId, input.leagueId), eq(f3CollectionPolicies.state, "approved"))).orderBy(desc(f3CollectionPolicies.policyVersion), desc(f3CollectionPolicies.currentRevision), asc(f3CollectionPolicies.id)).limit(1);
    if (!policy) fail("POLICY_NOT_APPROVED");
    const [activation] = await tx.select().from(financialActivations).where(and(eq(financialActivations.id, policy.activationId), eq(financialActivations.organizationId, input.organizationId), eq(financialActivations.leagueId, input.leagueId), eq(financialActivations.currentRevision, policy.activationRevision), eq(financialActivations.sourceFingerprint, policy.activationSourceFingerprint), eq(financialActivations.state, "active"), eq(financialActivations.completenessMarker, true))).limit(1);
    if (!activation) fail("ACTIVATION_DRIFT");
    await requireLiveF1ActivationEvidence(tx, input, activation);
    const policyRows = await tx.select().from(f3CollectionPolicyOccurrences).where(and(eq(f3CollectionPolicyOccurrences.organizationId, input.organizationId), eq(f3CollectionPolicyOccurrences.leagueId, input.leagueId), eq(f3CollectionPolicyOccurrences.policyId, policy.id))).orderBy(asc(f3CollectionPolicyOccurrences.itemIndex), asc(f3CollectionPolicyOccurrences.occurrenceId));
    const nowRows = await tx.execute(sql`select current_timestamp as now`);
    const responsibilities = await tx.select({ occurrenceId: financialResponsibilities.occurrenceId, bowlerId: financialResponsibilities.bowlerId, obligationId: financialResponsibilities.obligationId, amountMinor: financialResponsibilities.amountMinor, currency: financialResponsibilities.currency }).from(financialResponsibilities).where(and(eq(financialResponsibilities.organizationId, input.organizationId), eq(financialResponsibilities.leagueId, input.leagueId), eq(financialResponsibilities.activationId, activation.id), inArray(financialResponsibilities.bowlerId, coveredBowlerIds)));
    const obligationIds = responsibilities.map((row) => row.obligationId);
    const obligations = await tx.select().from(bowlerOccurrenceObligations).where(and(eq(bowlerOccurrenceObligations.organizationId, input.organizationId), eq(bowlerOccurrenceObligations.leagueId, input.leagueId), inArray(bowlerOccurrenceObligations.id, obligationIds)));
    const allocations = obligationIds.length ? await tx.select({ obligationId: paymentOccurrenceAllocations.obligationId, amountMinor: paymentOccurrenceAllocations.amountMinor, status: payments.status, refundedAt: payments.refundedAt, disputedAt: payments.disputedAt, paymentOperationId: payments.paymentOperationId }).from(paymentOccurrenceAllocations).innerJoin(payments, eq(payments.id, paymentOccurrenceAllocations.paymentId)).where(and(eq(paymentOccurrenceAllocations.organizationId, input.organizationId), eq(paymentOccurrenceAllocations.leagueId, input.leagueId), eq(paymentOccurrenceAllocations.state, "active"), inArray(paymentOccurrenceAllocations.obligationId, obligationIds))) : [];
    const allocationOperationIds = allocations.flatMap((row) => row.paymentOperationId ? [row.paymentOperationId] : []);
    const disputeOperationIds = allocationOperationIds.length ? new Set((await tx.select({ operationId: paymentDisputes.paymentOperationId }).from(paymentDisputes).where(and(eq(paymentDisputes.organizationId, input.organizationId), inArray(paymentDisputes.paymentOperationId, allocationOperationIds)))).map((row) => row.operationId)) : new Set<string>();
    const reviewedAllocations = allocations.map((row) => ({ ...row, disputeEvidence: row.paymentOperationId ? disputeOperationIds.has(row.paymentOperationId) : false }));
    const reservations = obligationIds.length ? await tx.select({ obligationId: occurrenceCollectionPlanItems.obligationId, amountMinor: occurrenceCollectionPlanItems.amountMinor }).from(occurrenceCollectionPlanItems).innerJoin(occurrenceCollectionPlans, and(eq(occurrenceCollectionPlans.id, occurrenceCollectionPlanItems.planId), eq(occurrenceCollectionPlans.organizationId, input.organizationId), eq(occurrenceCollectionPlans.leagueId, input.leagueId), eq(occurrenceCollectionPlans.state, "ready"))).where(and(eq(occurrenceCollectionPlanItems.organizationId, input.organizationId), eq(occurrenceCollectionPlanItems.leagueId, input.leagueId), inArray(occurrenceCollectionPlanItems.obligationId, obligationIds))) : [];
    const pendingReservations = obligationIds.length ? await tx.select({ obligationId: paymentOperationOccurrenceSnapshotAllocations.obligationId, amountMinor: paymentOperationOccurrenceSnapshotAllocations.amountMinor }).from(paymentOperationOccurrenceSnapshotAllocations).innerJoin(paymentOperations, eq(paymentOperations.id, paymentOperationOccurrenceSnapshotAllocations.operationId)).where(and(eq(paymentOperationOccurrenceSnapshotAllocations.organizationId, input.organizationId), eq(paymentOperationOccurrenceSnapshotAllocations.leagueId, input.leagueId), inArray(paymentOperationOccurrenceSnapshotAllocations.obligationId, obligationIds), inArray(paymentOperations.status, ["pending", "leased", "provider_unknown", "retry_scheduled", "reconciliation_required"]))) : [];
    reservations.push(...pendingReservations.map((row) => ({ ...row, kind: "pending_f2" as const })));
    const quoteEvidence = buildF3QuoteEvidence({ policyRows, coveredBowlerIds, responsibilities, obligations, allocations: reviewedAllocations, reservations, transactionNow: new Date(String((nowRows.rows[0] as { now: string }).now)).getTime(), allowDueItems: true });
    const collectionPointOccurrenceIds = [...new Set(policyRows.map((row) => row.collectionPointOccurrenceId))];
    const occurrenceLabels = await tx.select({ id: leagueOccurrences.id, localDate: leagueOccurrences.authoritativeLocalDate, localStartTime: leagueOccurrences.authoritativeLocalStartTime, timezone: leagueOccurrences.timezone, ordinal: leagueOccurrences.plannedOrdinal }).from(leagueOccurrences).where(and(eq(leagueOccurrences.organizationId, input.organizationId), eq(leagueOccurrences.leagueId, input.leagueId), inArray(leagueOccurrences.id, [...new Set(policyRows.map((row) => row.occurrenceId))])));
    const labelById = new Map(occurrenceLabels.map((row) => [row.id, row]));
    const nextVersionRows = await tx.execute(sql`select coalesce(max(authorization_version), 0) + 1 as next_version from f3_payer_autopay_authorizations where organization_id = ${input.organizationId} and league_id = ${input.leagueId} and payer_bowler_id = ${input.payerBowlerId}`);
    const nextAuthorizationVersion = Number((nextVersionRows.rows[0] as { next_version: string | number }).next_version);
    const quoteBase = { organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerId: input.payerBowlerId, policyId: policy.id, policyVersion: policy.policyVersion, activationRevision: policy.activationRevision, activationSourceFingerprint: policy.activationSourceFingerprint, coveredBowlerIds, acceptedPartnerIds, collectionPointOccurrenceIds, items: quoteEvidence.items, timing: "at_collection_point" as const, totalAmountMinor: quoteEvidence.items.reduce((total, row) => total + row.amountMinor, 0), nextAuthorizationVersion };
    const groups = policyRows.map((row) => ({ occurrenceId: row.occurrenceId, groupKey: row.groupKey, groupRole: row.groupRole, pairedOccurrenceId: row.pairedOccurrenceId, collectionPointOccurrenceId: row.collectionPointOccurrenceId, ...labelById.get(row.occurrenceId) }));
    return { contractVersion: F3_PREAUTHORIZATION_QUOTE_CONTRACT, organizationId: input.organizationId, leagueId: input.leagueId, policy: { id: policy.id, version: policy.policyVersion, activationRevision: policy.activationRevision, activationSourceFingerprint: policy.activationSourceFingerprint }, authorization: { payerBowlerId: input.payerBowlerId, nextAuthorizationVersion, coveredBowlerIds, acceptedPartnerIds, collectionPointOccurrenceIds }, items: quoteEvidence.items, timing: "at_collection_point" as const, totalAmountMinor: quoteBase.totalAmountMinor, catchUpRequired: quoteEvidence.catchUpRequired, fingerprint: f3PreauthorizationFingerprint(quoteBase), groups };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

/** Read immutable post-authorization D2 evidence in one snapshot. An
 * existing authorization never falls back to live obligation derivation: a
 * missing/non-ready plan is evidence corruption, not a new quote. */
export async function readF3ReadyPlan(input: { organizationId: number; leagueId: number; payerBowlerId: number; authorizationId?: string }) {
  if (!canonicalF3AutopayEnabled) fail("F3_DISABLED");
  return db.transaction(async (tx) => {
    const [league] = await tx.select({ id: leagues.id, locationId: leagues.locationId, active: leagues.active }).from(leagues).where(and(eq(leagues.id, input.leagueId), eq(leagues.organizationId, input.organizationId))).limit(1);
    if (!league) fail("NOT_FOUND", undefined, 404);
    const [policy] = await tx.select().from(f3CollectionPolicies).where(and(eq(f3CollectionPolicies.organizationId, input.organizationId), eq(f3CollectionPolicies.leagueId, input.leagueId), eq(f3CollectionPolicies.state, "approved"))).orderBy(desc(f3CollectionPolicies.policyVersion), desc(f3CollectionPolicies.currentRevision), asc(f3CollectionPolicies.id)).limit(1);
    if (!policy) fail("POLICY_NOT_APPROVED");
    const policyRows = await tx.select().from(f3CollectionPolicyOccurrences).where(and(eq(f3CollectionPolicyOccurrences.organizationId, input.organizationId), eq(f3CollectionPolicyOccurrences.leagueId, input.leagueId), eq(f3CollectionPolicyOccurrences.policyId, policy.id))).orderBy(asc(f3CollectionPolicyOccurrences.itemIndex), asc(f3CollectionPolicyOccurrences.occurrenceId));
    const [authorization] = await tx.select().from(f3PayerAuthorizations).where(and(eq(f3PayerAuthorizations.organizationId, input.organizationId), eq(f3PayerAuthorizations.leagueId, input.leagueId), eq(f3PayerAuthorizations.payerBowlerId, input.payerBowlerId), input.authorizationId ? eq(f3PayerAuthorizations.id, input.authorizationId) : eq(f3PayerAuthorizations.state, "authorized"))).orderBy(desc(f3PayerAuthorizations.authorizationVersion), desc(f3PayerAuthorizations.currentRevision), asc(f3PayerAuthorizations.id)).limit(1);
    if (!authorization) fail("PAYER_AUTHORIZATION_REQUIRED");
    const expectedPoints = policy.collectionPoints.map((row) => row.occurrenceId);
    const persisted = await tx.select({ planId: f3AutopayPlanProvenance.d2PlanId, planFingerprint: f3AutopayPlanProvenance.planFingerprint, point: f3AutopayPlanProvenance.collectionPointOccurrenceId, planVersion: f3AutopayPlanProvenance.planVersion }).from(f3AutopayPlanProvenance).innerJoin(occurrenceCollectionPlans, and(eq(occurrenceCollectionPlans.id, f3AutopayPlanProvenance.d2PlanId), eq(occurrenceCollectionPlans.organizationId, input.organizationId), eq(occurrenceCollectionPlans.leagueId, input.leagueId), eq(occurrenceCollectionPlans.state, "ready"))).where(and(eq(f3AutopayPlanProvenance.organizationId, input.organizationId), eq(f3AutopayPlanProvenance.leagueId, input.leagueId), eq(f3AutopayPlanProvenance.authorizationId, authorization.id))).orderBy(asc(f3AutopayPlanProvenance.collectionPointOccurrenceId), asc(f3AutopayPlanProvenance.d2PlanId));
    if (persisted.length !== expectedPoints.length || new Set(persisted.map((row) => row.point)).size !== persisted.length || expectedPoints.some((point) => !persisted.some((row) => row.point === point))) fail("PLAN_EVIDENCE_INCOMPLETE");
    const persistedItems = await tx.select({ planId: occurrenceCollectionPlanItems.planId, obligationId: occurrenceCollectionPlanItems.obligationId, occurrenceId: occurrenceCollectionPlanItems.occurrenceId, bowlerId: occurrenceCollectionPlanItems.bowlerId, amountMinor: occurrenceCollectionPlanItems.amountMinor, currency: occurrenceCollectionPlanItems.currency, itemIndex: occurrenceCollectionPlanItems.itemIndex, collectionPointOccurrenceId: occurrenceCollectionPlans.triggerOccurrenceId }).from(occurrenceCollectionPlanItems).innerJoin(occurrenceCollectionPlans, and(eq(occurrenceCollectionPlans.id, occurrenceCollectionPlanItems.planId), eq(occurrenceCollectionPlans.organizationId, input.organizationId), eq(occurrenceCollectionPlans.leagueId, input.leagueId), eq(occurrenceCollectionPlans.state, "ready"))).where(and(eq(occurrenceCollectionPlanItems.organizationId, input.organizationId), eq(occurrenceCollectionPlanItems.leagueId, input.leagueId), inArray(occurrenceCollectionPlanItems.planId, persisted.map((row) => row.planId)))).orderBy(asc(occurrenceCollectionPlanItems.itemIndex), asc(occurrenceCollectionPlanItems.obligationId));
    if (persistedItems.some((item) => !item.collectionPointOccurrenceId)) fail("PLAN_EVIDENCE_INCOMPLETE");
    const readableItems = canonicalizeF3QuoteItems(persistedItems.map((item) => ({ obligationId: item.obligationId, occurrenceId: item.occurrenceId, bowlerId: item.bowlerId, amountMinor: item.amountMinor, itemIndex: item.itemIndex, collectionPointOccurrenceId: item.collectionPointOccurrenceId as string })), expectedPoints);
    const authorizedItems = canonicalizeF3QuoteItems(authorization.authorizedItems, expectedPoints);
    if (readableItems.length !== authorizedItems.length || readableItems.some((item, index) => canonicalizePaymentOperationInput(item) !== canonicalizePaymentOperationInput(authorizedItems[index]))) fail("PLAN_EVIDENCE_INCONSISTENT");
    const plans = persisted.map((plan) => {
      const planItems = readableItems.filter((item) => item.collectionPointOccurrenceId === plan.point);
      const expectedFingerprint = f3SemanticPlanFingerprint({ organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerId: authorization.payerBowlerId, policyId: policy.id, policyVersion: policy.policyVersion, authorizationId: authorization.id, authorizationVersion: authorization.authorizationVersion, collectionPointOccurrenceId: plan.point, planVersion: plan.planVersion, items: planItems });
      if (expectedFingerprint !== plan.planFingerprint) fail("PLAN_EVIDENCE_INCONSISTENT");
      return { organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerId: authorization.payerBowlerId, policyId: policy.id, policyVersion: policy.policyVersion, authorizationId: authorization.id, authorizationVersion: authorization.authorizationVersion, collectionPointOccurrenceId: plan.point, planVersion: plan.planVersion, planFingerprint: plan.planFingerprint, items: planItems };
    });
    const aggregateFingerprint = f3AggregatePlanFingerprint({ authorizationId: authorization.id, authorizationVersion: authorization.authorizationVersion, policyId: policy.id, policyVersion: policy.policyVersion, collectionPointOrder: expectedPoints, plans });
    const labels = await tx.select({ id: leagueOccurrences.id, localDate: leagueOccurrences.authoritativeLocalDate, localStartTime: leagueOccurrences.authoritativeLocalStartTime, timezone: leagueOccurrences.timezone, ordinal: leagueOccurrences.plannedOrdinal }).from(leagueOccurrences).where(and(eq(leagueOccurrences.organizationId, input.organizationId), eq(leagueOccurrences.leagueId, input.leagueId), inArray(leagueOccurrences.id, [...new Set(policyRows.map((row) => row.occurrenceId))])));
    const labelById = new Map(labels.map((row) => [row.id, row]));
    const groups = policyRows.map((row) => ({ occurrenceId: row.occurrenceId, groupKey: row.groupKey, groupRole: row.groupRole as "normal" | "trigger" | "paired", pairedOccurrenceId: row.pairedOccurrenceId, collectionPointOccurrenceId: row.collectionPointOccurrenceId, ...labelById.get(row.occurrenceId) }));
    return { contractVersion: "canonical-autopay-plan/1", policy: { id: policy.id, version: policy.policyVersion }, authorization: { id: authorization.id, version: authorization.authorizationVersion, coveredBowlerIds: authorization.coveredBowlerIds, collectionPointOccurrenceIds: authorization.collectionPointOccurrenceIds }, items: readableItems, groups, totalAmountMinor: readableItems.reduce((total, item) => total + item.amountMinor, 0), fingerprint: aggregateFingerprint, aggregateFingerprint };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

function f3AuthorizationSemanticInput(input: F3AuthorizationInput & { authorizationVersion: number; paymentMethodFingerprint: string }) {
  return {
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    payerBowlerId: input.payerBowlerId,
    authorizationVersion: input.authorizationVersion,
    policyId: input.policyId,
    policyVersion: input.policyVersion,
    coveredBowlerIds: input.coveredBowlerIds,
    acceptedPartnerIds: input.acceptedPartnerIds,
    paymentMethodFingerprint: input.paymentMethodFingerprint,
    locationId: input.locationId,
    collectionPointOccurrenceIds: input.collectionPointOccurrenceIds,
    timing: input.timing,
    preauthorizationFingerprint: input.preauthorizationFingerprint,
    authorizedItems: input.authorizedItems,
  } satisfies F3AuthorizationInput;
}

/** Provider-free exact retry lookup. This is intentionally scoped to the
 * caller's organization, league, and payer; a command key reused by another
 * payer is a deterministic semantic conflict, matching the database key. */
export async function readF3AuthorizationReplay(input: F3AuthorizationInput & { commandKey: string }): Promise<{ authorizationId: string; replay: true } | null> {
  if (!canonicalF3AutopayEnabled) fail("F3_DISABLED");
  if (!input.commandKey.trim()) fail("INVALID_COMMAND", undefined, 400);
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(f3PayerAuthorizations).where(and(
      eq(f3PayerAuthorizations.organizationId, input.organizationId),
      eq(f3PayerAuthorizations.leagueId, input.leagueId),
      eq(f3PayerAuthorizations.commandKey, input.commandKey),
    )).limit(1);
    if (!existing) return null;
    if (existing.payerBowlerId !== input.payerBowlerId || (input.authorizationVersion !== undefined && input.authorizationVersion !== existing.authorizationVersion)) fail("IDEMPOTENCY_CONFLICT");
    const replayFingerprint = f3AuthorizationFingerprint(f3AuthorizationSemanticInput({ ...input, authorizationVersion: existing.authorizationVersion, paymentMethodFingerprint: input.paymentMethodFingerprint }));
    if (existing.authorizationFingerprint !== replayFingerprint) fail("IDEMPOTENCY_CONFLICT");
    return { authorizationId: existing.id, replay: true };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

/** Strict ownership check used only by payer authorization. Quote/policy/read
 * paths never call this or any provider. */
export async function validateF3PaymentMethodOwnership(input: { league: Pick<typeof leagues.$inferSelect, "locationId">; payer: Pick<typeof bowlers.$inferSelect, "paymentProviderLocationId" | "paymentCustomerId">; sourceId: string }): Promise<{ customerId: string }> {
  if (!input.league.locationId || input.payer.paymentProviderLocationId !== input.league.locationId) fail("PAYMENT_LOCATION_MISMATCH", undefined, 403);
  const provider = await getPaymentProvider(input.league.locationId);
  if (provider.providerName !== "square" || !provider.validateCardId(input.sourceId)) fail("INVALID_PAYMENT_SOURCE", undefined, 400);
  const customerId = getProviderCustomerId(input.payer, provider);
  if (!customerId) throw new F3WorkflowError("PAYMENT_CUSTOMER_REQUIRED", "Payer payment customer is required", 403);
  const ownershipCheck = typeof provider.hasCardOnFile === "function" ? provider.hasCardOnFile : undefined;
  if (!ownershipCheck) throw new F3WorkflowError("PAYMENT_PROVIDER_UNAVAILABLE", "Payment provider ownership verification is unavailable", 503);
  const hasCardOnFile = ownershipCheck.bind(provider);
  let owns = false;
  try { owns = await hasCardOnFile.call(provider, customerId, input.sourceId); }
  catch { fail("PAYMENT_PROVIDER_UNAVAILABLE", "Payment provider ownership verification is unavailable", 503); }
  if (!owns) fail("CARD_OWNERSHIP_MISMATCH", undefined, 403);
  return { customerId };
}

export async function createF3Policy(input: F3PolicyInput & { actorUserId: number; commandKey: string }) {
  if (!canonicalF3AutopayEnabled) fail("F3_DISABLED");
  let policy: F3PolicyInput;
  try {
    policy = normalizeF3Policy({ organizationId: input.organizationId, leagueId: input.leagueId, activationId: input.activationId, activationRevision: input.activationRevision, activationSourceFingerprint: input.activationSourceFingerprint, policyVersion: input.policyVersion, collectionPoints: input.collectionPoints, occurrences: input.occurrences });
    validateF3PolicyShape(policy);
  } catch {
    fail("INVALID_POLICY", "Invalid collection policy", 400);
  }
  if (!input.commandKey.trim()) fail("INVALID_COMMAND");
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${policy.organizationId}::integer, ${policy.leagueId}::integer)`);
    const [league] = await tx.select().from(leagues).where(and(eq(leagues.id, policy.leagueId), eq(leagues.organizationId, policy.organizationId))).limit(1);
    if (!league || !league.active) fail("NOT_FOUND", undefined, 404);
    if (league.paymentMode !== "weekly") fail("UPFRONT_NOT_SUPPORTED", undefined, 409);
    const [activation] = await tx.select().from(financialActivations).where(and(eq(financialActivations.organizationId, policy.organizationId), eq(financialActivations.leagueId, policy.leagueId), eq(financialActivations.id, policy.activationId), eq(financialActivations.currentRevision, policy.activationRevision), eq(financialActivations.sourceFingerprint, policy.activationSourceFingerprint), eq(financialActivations.state, "active"), eq(financialActivations.completenessMarker, true))).limit(1);
    if (!activation) fail("F1_ACTIVATION_DRIFT");
    await requireLiveF1ActivationEvidence(tx, policy, activation);
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
    const revisionRows = policy.occurrences.map((item, itemIndex) => ({ occurrenceId: item.occurrenceId, groupKey: item.groupKey, groupRole: item.groupRole, pairedOccurrenceId: item.pairedOccurrenceId, collectionPointOccurrenceId: item.collectionPoint.occurrenceId, itemIndex }));
    await tx.insert(f3CollectionPolicyRevisions).values({ organizationId: policy.organizationId, leagueId: policy.leagueId, policyId: row.id, revisionNumber: 1, snapshotSchemaVersion: 1, beforeSnapshot: null, afterSnapshot: f3PolicyRevisionSnapshot(row, revisionRows), recordedByUserId: input.actorUserId });
    return { id: row.id, policyFingerprint, replay: false };
  });
}

export async function approveF3Policy(input: { organizationId: number; leagueId: number; policyId: string; actorUserId: number }) {
  if (!canonicalF3AutopayEnabled) fail("F3_DISABLED");
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${input.organizationId}::integer, ${input.leagueId}::integer)`);
    const [league] = await tx.select({ id: leagues.id, active: leagues.active, paymentMode: leagues.paymentMode }).from(leagues).where(and(eq(leagues.id, input.leagueId), eq(leagues.organizationId, input.organizationId))).limit(1);
    if (!league || !league.active) fail("NOT_FOUND", undefined, 404);
    if (league.paymentMode !== "weekly") fail("UPFRONT_NOT_SUPPORTED", undefined, 409);
    const [policy] = await tx.select().from(f3CollectionPolicies).where(and(eq(f3CollectionPolicies.id, input.policyId), eq(f3CollectionPolicies.organizationId, input.organizationId), eq(f3CollectionPolicies.leagueId, input.leagueId))).limit(1).for("update");
    if (!policy || policy.state !== "draft") fail("POLICY_VERSION_CONFLICT");
    const [activation] = await tx.select({ id: financialActivations.id, revision: financialActivations.currentRevision, source: financialActivations.sourceFingerprint, expectedGroupCount: financialActivations.expectedGroupCount, expectedResponsibilityCount: financialActivations.expectedResponsibilityCount }).from(financialActivations).where(and(eq(financialActivations.id, policy.activationId), eq(financialActivations.organizationId, input.organizationId), eq(financialActivations.leagueId, input.leagueId), eq(financialActivations.state, "active"), eq(financialActivations.completenessMarker, true))).limit(1);
    if (!activation || activation.revision !== policy.activationRevision || activation.source !== policy.activationSourceFingerprint) fail("POLICY_ACTIVATION_DRIFT");
    await requireLiveF1ActivationEvidence(tx, input, { id: activation.id, currentRevision: activation.revision, sourceFingerprint: activation.source, expectedGroupCount: activation.expectedGroupCount, expectedResponsibilityCount: activation.expectedResponsibilityCount });
    const [current] = await tx.select().from(f3CollectionPolicies).where(and(eq(f3CollectionPolicies.organizationId, input.organizationId), eq(f3CollectionPolicies.leagueId, input.leagueId), eq(f3CollectionPolicies.state, "approved"))).limit(1);
    if (current && policy.policyVersion <= current.policyVersion) fail("POLICY_VERSION_CONFLICT");
    if (current && current.id !== policy.id) {
      const [superseded] = await tx.update(f3CollectionPolicies).set({ state: "superseded", currentRevision: current.currentRevision + 1 }).where(and(eq(f3CollectionPolicies.id, current.id), eq(f3CollectionPolicies.currentRevision, current.currentRevision))).returning();
      const currentRows = await tx.select({ occurrenceId: f3CollectionPolicyOccurrences.occurrenceId, groupKey: f3CollectionPolicyOccurrences.groupKey, groupRole: f3CollectionPolicyOccurrences.groupRole, pairedOccurrenceId: f3CollectionPolicyOccurrences.pairedOccurrenceId, collectionPointOccurrenceId: f3CollectionPolicyOccurrences.collectionPointOccurrenceId, itemIndex: f3CollectionPolicyOccurrences.itemIndex }).from(f3CollectionPolicyOccurrences).where(and(eq(f3CollectionPolicyOccurrences.policyId, current.id), eq(f3CollectionPolicyOccurrences.organizationId, current.organizationId), eq(f3CollectionPolicyOccurrences.leagueId, current.leagueId)));
      await tx.insert(f3CollectionPolicyRevisions).values({ organizationId: current.organizationId, leagueId: current.leagueId, policyId: current.id, revisionNumber: superseded.currentRevision, snapshotSchemaVersion: 1, beforeSnapshot: f3PolicyRevisionSnapshot(current, currentRows), afterSnapshot: f3PolicyRevisionSnapshot(superseded, currentRows), recordedByUserId: input.actorUserId });
    }
    const oldAuthorizations = await tx.select().from(f3PayerAuthorizations).where(and(eq(f3PayerAuthorizations.organizationId, input.organizationId), eq(f3PayerAuthorizations.leagueId, input.leagueId), eq(f3PayerAuthorizations.state, "authorized"), current ? eq(f3PayerAuthorizations.policyId, current.id) : sql`false`));
    for (const authorization of oldAuthorizations) await supersedeAuthorizationPlans(tx, authorization);
    const approvedAt = new Date().toISOString();
    const [approved] = await tx.update(f3CollectionPolicies).set({ state: "approved", currentRevision: policy.currentRevision + 1, approvedByUserId: input.actorUserId, approvedAt }).where(and(eq(f3CollectionPolicies.id, policy.id), eq(f3CollectionPolicies.currentRevision, policy.currentRevision))).returning();
    const policyRows = await tx.select({ occurrenceId: f3CollectionPolicyOccurrences.occurrenceId, groupKey: f3CollectionPolicyOccurrences.groupKey, groupRole: f3CollectionPolicyOccurrences.groupRole, pairedOccurrenceId: f3CollectionPolicyOccurrences.pairedOccurrenceId, collectionPointOccurrenceId: f3CollectionPolicyOccurrences.collectionPointOccurrenceId, itemIndex: f3CollectionPolicyOccurrences.itemIndex }).from(f3CollectionPolicyOccurrences).where(and(eq(f3CollectionPolicyOccurrences.policyId, policy.id), eq(f3CollectionPolicyOccurrences.organizationId, policy.organizationId), eq(f3CollectionPolicyOccurrences.leagueId, policy.leagueId)));
    await tx.insert(f3CollectionPolicyRevisions).values({ organizationId: policy.organizationId, leagueId: policy.leagueId, policyId: policy.id, revisionNumber: approved.currentRevision, snapshotSchemaVersion: 1, beforeSnapshot: f3PolicyRevisionSnapshot(policy, policyRows), afterSnapshot: f3PolicyRevisionSnapshot(approved, policyRows), recordedByUserId: input.actorUserId });
    return approved;
  });
}

export async function authorizeF3Payer(input: F3AuthorizationInput & { sourceId: string; customerId: string | null; actorUserId: number; providerValidated: boolean; payerOwnedPaymentMethod: boolean; leagueLocationId: number; commandKey: string }) {
  if (!canonicalF3AutopayEnabled) fail("F3_DISABLED");
  if (!input.providerValidated || !input.payerOwnedPaymentMethod) fail("PAYMENT_METHOD_NOT_OWNED", undefined, 403);
  if (!input.commandKey.trim()) fail("INVALID_COMMAND", undefined, 400);
  if (input.locationId !== input.leagueLocationId) fail("PAYMENT_LOCATION_MISMATCH");
  const paymentMethodFingerprint = f3PaymentSourceFingerprint(input.sourceId, input.locationId);
  const normalizedPayees = [...new Set(input.coveredBowlerIds)].sort((a, b) => a - b);
  if (!normalizedPayees.includes(input.payerBowlerId)) fail("PAYER_MUST_BE_COVERED", undefined, 403);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${input.organizationId}::integer, ${input.leagueId}::integer)`);
    const [league] = await tx.select().from(leagues).where(and(eq(leagues.id, input.leagueId), eq(leagues.organizationId, input.organizationId))).limit(1);
    if (!league || !league.active) fail("NOT_FOUND", undefined, 404);
    if (league.paymentMode !== "weekly") fail("UPFRONT_NOT_SUPPORTED", undefined, 409);
    const [payer] = await tx.select({ paymentProviderLocationId: bowlers.paymentProviderLocationId, paymentCustomerId: bowlers.paymentCustomerId }).from(bowlers).where(and(eq(bowlers.id, input.payerBowlerId), eq(bowlers.organizationId, input.organizationId), eq(bowlers.active, true))).limit(1).for("update");
    if (!payer) fail("NOT_FOUND", undefined, 404);
    if (payer.paymentProviderLocationId !== league.locationId || input.leagueLocationId !== league.locationId) fail("PAYMENT_LOCATION_MISMATCH", undefined, 403);
    if (!input.customerId || !payer.paymentCustomerId || input.customerId !== payer.paymentCustomerId) fail("PAYMENT_CUSTOMER_MISMATCH", undefined, 403);
    const memberships = await tx.select({ id: bowlerLeagues.bowlerId }).from(bowlerLeagues).innerJoin(bowlers, and(eq(bowlers.id, bowlerLeagues.bowlerId), eq(bowlers.organizationId, input.organizationId), eq(bowlers.active, true))).where(and(eq(bowlerLeagues.leagueId, input.leagueId), eq(bowlerLeagues.active, true), inArray(bowlerLeagues.bowlerId, normalizedPayees)));
    if (new Set(memberships.map((row) => row.id)).size !== normalizedPayees.length) fail("ACTIVE_MEMBERSHIP_REQUIRED", undefined, 403);
    const partnerIds = normalizedPayees.filter((id) => id !== input.payerBowlerId);
    const normalizedAcceptedPartnerIds = [...new Set(input.acceptedPartnerIds)].sort((a, b) => a - b);
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
    const [activation] = await tx.select({ id: financialActivations.id, revision: financialActivations.currentRevision, source: financialActivations.sourceFingerprint, expectedGroupCount: financialActivations.expectedGroupCount, expectedResponsibilityCount: financialActivations.expectedResponsibilityCount }).from(financialActivations).where(and(eq(financialActivations.id, policy.activationId), eq(financialActivations.organizationId, input.organizationId), eq(financialActivations.leagueId, input.leagueId), eq(financialActivations.state, "active"), eq(financialActivations.completenessMarker, true))).limit(1);
    if (!activation || activation.revision !== policy.activationRevision || activation.source !== policy.activationSourceFingerprint) fail("ACTIVATION_DRIFT");
    await requireLiveF1ActivationEvidence(tx, input, { id: activation.id, currentRevision: activation.revision, sourceFingerprint: activation.source, expectedGroupCount: activation.expectedGroupCount, expectedResponsibilityCount: activation.expectedResponsibilityCount });
    const authorizationCandidates = await tx.select().from(f3PayerAuthorizations).where(and(eq(f3PayerAuthorizations.organizationId, input.organizationId), eq(f3PayerAuthorizations.leagueId, input.leagueId), eq(f3PayerAuthorizations.commandKey, input.commandKey))).limit(1);
    const existing = authorizationCandidates[0];
    if (existing) {
      if (existing.payerBowlerId !== input.payerBowlerId || (input.authorizationVersion !== undefined && input.authorizationVersion !== existing.authorizationVersion)) fail("IDEMPOTENCY_CONFLICT");
      const replayFingerprint = f3AuthorizationFingerprint(f3AuthorizationSemanticInput({ ...input, authorizationVersion: existing.authorizationVersion, paymentMethodFingerprint }));
      if (existing.authorizationFingerprint !== replayFingerprint) fail("IDEMPOTENCY_CONFLICT");
      return { authorizationId: existing.id, replay: true };
    }
    if (normalizedAcceptedPartnerIds.length !== partnerIds.length || normalizedAcceptedPartnerIds.some((id, index) => id !== partnerIds[index])) fail("PARTNER_AUTHORIZATION_MISMATCH", undefined, 403);
    const versionResult = await tx.execute(sql`select coalesce(max(authorization_version), 0) + 1 as next_version from f3_payer_autopay_authorizations where organization_id = ${input.organizationId} and league_id = ${input.leagueId} and payer_bowler_id = ${input.payerBowlerId}`);
    const nextAuthorizationVersion = Number((versionResult.rows[0] as { next_version: string | number }).next_version);
    if (input.authorizationVersion !== undefined && input.authorizationVersion !== nextAuthorizationVersion) fail("AUTHORIZATION_VERSION_CONFLICT");
    // Recompute the complete quote under the same league lock before creating
    // any F3 row. The browser's item JSON is evidence of consent only.
    const normalizedInput = { ...input, coveredBowlerIds: normalizedPayees, acceptedPartnerIds: normalizedAcceptedPartnerIds };
    const quoteEvidence = await validateF3LockedPreauthorization(tx, { input: normalizedInput, policy, policyRows, activation, coveredBowlerIds: normalizedPayees, nextAuthorizationVersion });
    const fingerprint = f3AuthorizationFingerprint(f3AuthorizationSemanticInput({ ...normalizedInput, authorizationVersion: nextAuthorizationVersion, paymentMethodFingerprint }));
    const priorAuthorizations = await tx.select().from(f3PayerAuthorizations).where(and(eq(f3PayerAuthorizations.organizationId, input.organizationId), eq(f3PayerAuthorizations.leagueId, input.leagueId), eq(f3PayerAuthorizations.payerBowlerId, input.payerBowlerId), eq(f3PayerAuthorizations.state, "authorized"))).for("update");
    for (const authorization of priorAuthorizations) await supersedeAuthorizationPlans(tx, authorization);
    const [auth] = await tx.insert(f3PayerAuthorizations).values({ organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerId: input.payerBowlerId, policyId: policy.id, policyVersion: policy.policyVersion, authorizationVersion: nextAuthorizationVersion, authorizationFingerprint: fingerprint, preauthorizationQuoteFingerprint: quoteEvidence.fingerprint, authorizedItems: canonicalizeF3QuoteItems(quoteEvidence.items, input.collectionPointOccurrenceIds), commandKey: input.commandKey, coveredBowlerIds: normalizedPayees, acceptedPartnerIds: normalizedAcceptedPartnerIds, collectionPointOccurrenceIds: [...input.collectionPointOccurrenceIds].sort(), locationId: input.locationId, encryptedSourceId: encrypt(input.sourceId), encryptedCustomerId: input.customerId ? encrypt(input.customerId) : null, paymentMethodFingerprint, timing: "at_collection_point", state: "authorized", createdByUserId: input.actorUserId, authorizedAt: new Date().toISOString() }).returning();
    await tx.insert(f3PayerAuthorizationRevisions).values({ organizationId: input.organizationId, leagueId: input.leagueId, authorizationId: auth.id, revisionNumber: 1, snapshotSchemaVersion: 1, beforeSnapshot: null, afterSnapshot: auth, recordedByUserId: input.actorUserId });
    const ready = await persistF3D2Plans(tx, { organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerId: input.payerBowlerId, policy, policyRows, auth, activation, quoteItems: quoteEvidence.items, expectedPreauthorizationFingerprint: quoteEvidence.fingerprint });
    return { authorizationId: auth.id, plans: ready, replay: false };
  });
}

async function validateF3LockedPreauthorization(tx: F3DbTransaction, input: { input: F3AuthorizationInput; policy: typeof f3CollectionPolicies.$inferSelect; policyRows: Array<typeof f3CollectionPolicyOccurrences.$inferSelect>; activation: { id: string; revision: number; source: string }; coveredBowlerIds: number[]; nextAuthorizationVersion: number }): Promise<{ items: F3QuoteItem[]; fingerprint: string }> {
  const nowResult = await tx.execute(sql`select current_timestamp as now`);
  const transactionNow = new Date(String((nowResult.rows[0] as { now: string }).now)).getTime();
  const obligations = await tx.select().from(bowlerOccurrenceObligations).where(and(eq(bowlerOccurrenceObligations.organizationId, input.input.organizationId), eq(bowlerOccurrenceObligations.leagueId, input.input.leagueId), inArray(bowlerOccurrenceObligations.bowlerId, input.coveredBowlerIds))).orderBy(asc(bowlerOccurrenceObligations.dueAt), asc(bowlerOccurrenceObligations.bowlerId), asc(bowlerOccurrenceObligations.occurrenceId), asc(bowlerOccurrenceObligations.id)).for("update");
  const responsibilities = await tx.select({ occurrenceId: financialResponsibilities.occurrenceId, bowlerId: financialResponsibilities.bowlerId, obligationId: financialResponsibilities.obligationId, amountMinor: financialResponsibilities.amountMinor, currency: financialResponsibilities.currency }).from(financialResponsibilities).where(and(eq(financialResponsibilities.organizationId, input.input.organizationId), eq(financialResponsibilities.leagueId, input.input.leagueId), eq(financialResponsibilities.activationId, input.activation.id), inArray(financialResponsibilities.bowlerId, input.coveredBowlerIds)));
  const selectedOccurrences = new Set(input.policyRows.map((row) => row.occurrenceId));
  const selectedIds = responsibilities.filter((row) => selectedOccurrences.has(row.occurrenceId)).map((row) => row.obligationId);
  const allocations = selectedIds.length === 0 ? [] : await tx.select({ obligationId: paymentOccurrenceAllocations.obligationId, amountMinor: paymentOccurrenceAllocations.amountMinor, status: payments.status, refundedAt: payments.refundedAt, disputedAt: payments.disputedAt, paymentOperationId: payments.paymentOperationId }).from(paymentOccurrenceAllocations).innerJoin(payments, eq(payments.id, paymentOccurrenceAllocations.paymentId)).where(and(eq(paymentOccurrenceAllocations.organizationId, input.input.organizationId), eq(paymentOccurrenceAllocations.leagueId, input.input.leagueId), eq(paymentOccurrenceAllocations.state, "active"), inArray(paymentOccurrenceAllocations.obligationId, selectedIds)));
  const allocationOperationIds = allocations.flatMap((row) => row.paymentOperationId ? [row.paymentOperationId] : []);
  const disputeOperationIds = allocationOperationIds.length ? new Set((await tx.select({ operationId: paymentDisputes.paymentOperationId }).from(paymentDisputes).where(and(eq(paymentDisputes.organizationId, input.input.organizationId), inArray(paymentDisputes.paymentOperationId, allocationOperationIds)))).map((row) => row.operationId)) : new Set<string>();
  const reviewedAllocations = allocations.map((row) => ({ ...row, disputeEvidence: row.paymentOperationId ? disputeOperationIds.has(row.paymentOperationId) : false }));
  const reservations = selectedIds.length === 0 ? [] : await tx.select({ obligationId: occurrenceCollectionPlanItems.obligationId, amountMinor: occurrenceCollectionPlanItems.amountMinor }).from(occurrenceCollectionPlanItems).innerJoin(occurrenceCollectionPlans, and(eq(occurrenceCollectionPlans.id, occurrenceCollectionPlanItems.planId), eq(occurrenceCollectionPlans.organizationId, input.input.organizationId), eq(occurrenceCollectionPlans.leagueId, input.input.leagueId), eq(occurrenceCollectionPlans.state, "ready"))).where(and(eq(occurrenceCollectionPlanItems.organizationId, input.input.organizationId), eq(occurrenceCollectionPlanItems.leagueId, input.input.leagueId), inArray(occurrenceCollectionPlanItems.obligationId, selectedIds)));
  const pendingReservations = selectedIds.length === 0 ? [] : await tx.select({ obligationId: paymentOperationOccurrenceSnapshotAllocations.obligationId, amountMinor: paymentOperationOccurrenceSnapshotAllocations.amountMinor }).from(paymentOperationOccurrenceSnapshotAllocations).innerJoin(paymentOperations, eq(paymentOperations.id, paymentOperationOccurrenceSnapshotAllocations.operationId)).where(and(eq(paymentOperationOccurrenceSnapshotAllocations.organizationId, input.input.organizationId), eq(paymentOperationOccurrenceSnapshotAllocations.leagueId, input.input.leagueId), inArray(paymentOperationOccurrenceSnapshotAllocations.obligationId, selectedIds), inArray(paymentOperations.status, ["pending", "leased", "provider_unknown", "retry_scheduled", "reconciliation_required"]))).for("share");
  reservations.push(...pendingReservations.map((row) => ({ ...row, kind: "pending_f2" as const })));
  const exact = buildF3QuoteEvidence({ policyRows: input.policyRows, coveredBowlerIds: input.coveredBowlerIds, responsibilities, obligations, allocations: reviewedAllocations, reservations, transactionNow, allowDueItems: false }).items;
  const points = [...new Set(input.policyRows.map((row) => row.collectionPointOccurrenceId))];
  const submitted = canonicalizeF3QuoteItems(input.input.authorizedItems, points);
  if (canonicalizePaymentOperationInput(exact) !== canonicalizePaymentOperationInput(submitted)) fail("PREAUTHORIZATION_ITEMS_STALE");
  const quote = f3PreauthorizationFingerprint({ organizationId: input.input.organizationId, leagueId: input.input.leagueId, payerBowlerId: input.input.payerBowlerId, policyId: input.policy.id, policyVersion: input.policy.policyVersion, activationRevision: input.activation.revision, activationSourceFingerprint: input.activation.source, coveredBowlerIds: input.coveredBowlerIds, acceptedPartnerIds: input.input.acceptedPartnerIds, collectionPointOccurrenceIds: points, items: exact, timing: "at_collection_point", totalAmountMinor: exact.reduce((sum, row) => sum + row.amountMinor, 0), nextAuthorizationVersion: input.nextAuthorizationVersion });
  if (quote !== input.input.preauthorizationFingerprint) fail("PREAUTHORIZATION_QUOTE_STALE");
  return { items: exact, fingerprint: quote };
}

export async function revokeF3Authorization(input: { organizationId: number; leagueId: number; authorizationId: string; actorUserId: number; actorBowlerId?: number }) {
  if (!canonicalF3AutopayEnabled) fail("F3_DISABLED");
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${input.organizationId}::integer, ${input.leagueId}::integer)`);
    const [current] = await tx.select().from(f3PayerAuthorizations).where(and(eq(f3PayerAuthorizations.id, input.authorizationId), eq(f3PayerAuthorizations.organizationId, input.organizationId), eq(f3PayerAuthorizations.leagueId, input.leagueId), eq(f3PayerAuthorizations.state, "authorized"))).limit(1).for("share");
    if (!current) fail("AUTHORIZATION_NOT_FOUND", undefined, 404);
    if (input.actorBowlerId !== undefined && current.payerBowlerId !== input.actorBowlerId) fail("NOT_FOUND", undefined, 404);
    await supersedeAuthorizationPlans(tx, current);
    const [revoked] = await tx.insert(f3PayerAuthorizations).values({ organizationId: current.organizationId, leagueId: current.leagueId, payerBowlerId: current.payerBowlerId, policyId: current.policyId, policyVersion: current.policyVersion, authorizationVersion: current.authorizationVersion + 1, authorizationFingerprint: `lvf3auth:v1:${hash({ supersedes: current.id, state: "revoked", actorUserId: input.actorUserId })}`, preauthorizationQuoteFingerprint: current.preauthorizationQuoteFingerprint, authorizedItems: current.authorizedItems, commandKey: `revoke:${current.id}:${current.authorizationVersion + 1}`, coveredBowlerIds: current.coveredBowlerIds, acceptedPartnerIds: current.acceptedPartnerIds, collectionPointOccurrenceIds: current.collectionPointOccurrenceIds, locationId: current.locationId, encryptedSourceId: current.encryptedSourceId, encryptedCustomerId: current.encryptedCustomerId, paymentMethodFingerprint: current.paymentMethodFingerprint, timing: current.timing, state: "revoked", createdByUserId: input.actorUserId, revokedAt: new Date().toISOString() }).returning();
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
  quoteItems: F3QuoteItem[];
  expectedPreauthorizationFingerprint: string;
}) {
  if (!input.expectedPreauthorizationFingerprint.match(/^lvf3quote:v1:[0-9a-f]{64}$/) || input.expectedPreauthorizationFingerprint !== input.auth.preauthorizationQuoteFingerprint) fail("PREAUTHORIZATION_QUOTE_STALE");
  const plans: unknown[] = [];
  for (const point of new Set(input.policyRows.map((row) => row.collectionPointOccurrenceId))) {
    const items = input.quoteItems.filter((item) => item.collectionPointOccurrenceId === point).map((item, itemIndex) => ({ organizationId: input.organizationId, leagueId: input.leagueId, planId: "", obligationId: item.obligationId, occurrenceId: item.occurrenceId, bowlerId: item.bowlerId, amountMinor: item.amountMinor, currency: "USD", itemIndex }));
    const [plan] = await tx.insert(occurrenceCollectionPlans).values({ organizationId: input.organizationId, leagueId: input.leagueId, planKey: `f3:${input.auth.id}:${point}`, triggerOccurrenceId: point, collectAt: null, currency: "USD", state: "ready", version: 1, currentRevision: 1, recordedByUserId: input.auth.createdByUserId }).returning();
    const persistedItems = items.map((item) => ({ ...item, planId: plan.id }));
    await tx.insert(occurrenceCollectionPlanItems).values(persistedItems);
    await tx.insert(occurrenceCollectionPlanRevisions).values({ organizationId: input.organizationId, leagueId: input.leagueId, planId: plan.id, revisionNumber: 1, snapshotSchemaVersion: 1, beforeSnapshot: null, afterSnapshot: { state: "ready", plan, items: persistedItems }, recordedByUserId: input.auth.createdByUserId });
    const fingerprintItems = persistedItems.map(({ planId: _planId, organizationId: _organizationId, leagueId: _leagueId, currency: _currency, ...item }) => ({ ...item, collectionPointOccurrenceId: point }));
    const planFingerprint = f3SemanticPlanFingerprint({ organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerId: input.payerBowlerId, policyId: input.policy.id, policyVersion: input.policy.policyVersion, authorizationId: input.auth.id, authorizationVersion: input.auth.authorizationVersion, collectionPointOccurrenceId: point, planVersion: 1, items: fingerprintItems });
    await tx.insert(f3AutopayPlanProvenance).values({ organizationId: input.organizationId, leagueId: input.leagueId, d2PlanId: plan.id, payerBowlerId: input.payerBowlerId, policyId: input.policy.id, policyVersion: input.policy.policyVersion, authorizationId: input.auth.id, authorizationVersion: input.auth.authorizationVersion, activationId: input.activation.id, activationRevision: input.activation.revision, activationSourceFingerprint: input.activation.source, planVersion: 1, planFingerprint, collectionPointOccurrenceId: point });
    plans.push(plan);
  }
  return plans;
}

async function supersedeAuthorizationPlans(tx: F3DbTransaction, authorization: typeof f3PayerAuthorizations.$inferSelect) {
  const [supersededAuth] = await tx.update(f3PayerAuthorizations).set({ state: "superseded", currentRevision: authorization.currentRevision + 1 }).where(and(eq(f3PayerAuthorizations.id, authorization.id), eq(f3PayerAuthorizations.organizationId, authorization.organizationId), eq(f3PayerAuthorizations.leagueId, authorization.leagueId), eq(f3PayerAuthorizations.currentRevision, authorization.currentRevision))).returning();
  await tx.insert(f3PayerAuthorizationRevisions).values({ organizationId: authorization.organizationId, leagueId: authorization.leagueId, authorizationId: authorization.id, revisionNumber: supersededAuth.currentRevision, snapshotSchemaVersion: 1, beforeSnapshot: authorization, afterSnapshot: supersededAuth, recordedByUserId: authorization.createdByUserId });
  const provenance = await tx.select({ planId: f3AutopayPlanProvenance.d2PlanId }).from(f3AutopayPlanProvenance).where(and(eq(f3AutopayPlanProvenance.organizationId, authorization.organizationId), eq(f3AutopayPlanProvenance.leagueId, authorization.leagueId), eq(f3AutopayPlanProvenance.authorizationId, authorization.id)));
  for (const row of provenance) {
    const [plan] = await tx.select().from(occurrenceCollectionPlans).where(and(eq(occurrenceCollectionPlans.id, row.planId), eq(occurrenceCollectionPlans.organizationId, authorization.organizationId), eq(occurrenceCollectionPlans.leagueId, authorization.leagueId), eq(occurrenceCollectionPlans.state, "ready"))).limit(1).for("update");
    if (!plan) continue;
    const [supersededPlan] = await tx.update(occurrenceCollectionPlans).set({ state: "superseded", currentRevision: plan.currentRevision + 1, updatedAt: new Date().toISOString() }).where(and(eq(occurrenceCollectionPlans.id, plan.id), eq(occurrenceCollectionPlans.currentRevision, plan.currentRevision))).returning();
    const planItems = await tx.select().from(occurrenceCollectionPlanItems).where(and(eq(occurrenceCollectionPlanItems.planId, plan.id), eq(occurrenceCollectionPlanItems.organizationId, authorization.organizationId), eq(occurrenceCollectionPlanItems.leagueId, authorization.leagueId)));
    await tx.insert(occurrenceCollectionPlanRevisions).values({ organizationId: authorization.organizationId, leagueId: authorization.leagueId, planId: plan.id, revisionNumber: supersededPlan.currentRevision, snapshotSchemaVersion: 1, beforeSnapshot: { state: plan.state, plan, items: planItems }, afterSnapshot: { state: supersededPlan.state, plan: supersededPlan, items: planItems }, recordedByUserId: authorization.createdByUserId });
  }
}
