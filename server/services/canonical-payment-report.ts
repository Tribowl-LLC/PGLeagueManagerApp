import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  bowlerOccurrenceObligationRevisions,
  bowlerOccurrenceObligations,
  bowlers,
  canonicalAutopayExecutionSnapshots,
  financialActivationRevisions,
  leagueOccurrences,
  leagues,
  paymentDisputes,
  paymentOccurrenceAllocationRevisions,
  paymentOccurrenceAllocations,
  paymentOperationOccurrenceSnapshotAllocations,
  paymentOperationOccurrenceSnapshots,
  paymentOperations,
  payments,
  users,
  scheduledPaymentOperationAllocations,
  scheduledPaymentOperationLineItems,
  scheduledPaymentOperationSnapshots,
  interactivePaymentOperationAllocations,
  interactivePaymentOperationLineItems,
  interactivePaymentOperationSnapshots,
  f3AutopayPlanProvenance,
  f3CollectionPolicies,
  f3CollectionPolicyOccurrences,
  f3CollectionPolicyRevisions,
  f3PayerAuthorizations,
  f3PayerAuthorizationRevisions,
  occurrenceCollectionPlans,
  occurrenceCollectionPlanItems,
  occurrenceCollectionPlanRevisions,
  financialResponsibilities,
  bowlerOccurrenceEligibilities,
  bowlerOccurrenceEligibilityRevisions,
  bowlerOccurrenceTeamAssignments,
  bowlerOccurrenceTeamAssignmentRevisions,
  type Payment,
} from "@shared/schema";
import {
  canonicalPaymentReportFingerprint,
  type CanonicalCollectionEvidence,
  type CanonicalPaymentReport,
  type CanonicalPaymentReportMode,
  type CanonicalPaymentRow,
  type CanonicalPaymentTransactionGroup,
} from "@shared/canonical-payment-report";
import { paymentReceiptContract } from "@shared/payment-receipt";
import { validateF4ExecutionSnapshot } from "@shared/f4-canonical-autopay-contract";
import { f3AuthorizationFingerprint, f3PolicyFingerprint, f3SemanticPlanFingerprint } from "@shared/f3-autopay-contract";
import { loadOperationalActivationEvidence } from "./canonical-due-past-due.js";
import { fingerprintPaymentOperationOccurrenceSnapshot, validatePaymentOperationOccurrenceSnapshot } from "../services/payment-operation-occurrence-snapshot.js";
import { reconstructScheduledPaymentSnapshot } from "../services/scheduled-payment-operation-snapshot.js";
import { reconstructInteractivePaymentSnapshot } from "../services/interactive-payment-operation-snapshot.js";

export const F5_PAGE_DEFAULT = 50;
export const F5_PAGE_MAX = 200;

export class CanonicalPaymentReportIncompatibilityError extends Error {
  constructor() {
    super("canonical payment evidence is incompatible");
    this.name = "CanonicalPaymentReportIncompatibilityError";
  }
}

export interface CanonicalPaymentReportInput {
  organizationId: number;
  leagueId: number;
  bowlerId?: number;
  /** Exact parent selector used by the scoped receipt path; global integrity remains tenant-wide. */
  paymentId?: number;
  page?: number;
  limit?: number;
}

type Allocation = typeof paymentOccurrenceAllocations.$inferSelect;
type Operation = typeof paymentOperations.$inferSelect;
type CanonicalSnapshot = typeof canonicalAutopayExecutionSnapshots.$inferSelect;
type ReportDbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function collectionEvidenceForSnapshot(snapshot: CanonicalSnapshot, policyOccurrences: Array<typeof f3CollectionPolicyOccurrences.$inferSelect>): CanonicalCollectionEvidence {
  const items = Array.isArray(snapshot.items) ? snapshot.items as Array<Record<string, unknown>> : [];
  const coveredOccurrenceIds = [...new Set(items.map((item) => String(item.occurrenceId)))];
  const covered = policyOccurrences.filter((row) => coveredOccurrenceIds.includes(row.occurrenceId) && row.collectionPointOccurrenceId === snapshot.collectionPointOccurrenceId);
  const trigger = covered.find((row) => row.groupRole === "trigger");
  const paired = covered.find((row) => row.groupRole === "paired");
  const isDoublePay = covered.length === 2
    && !!trigger && !!paired
    && trigger.groupKey === paired.groupKey
    && trigger.pairedOccurrenceId === paired.occurrenceId
    && paired.pairedOccurrenceId === trigger.occurrenceId;
  const isNormal = covered.length === 1 && covered[0]?.groupRole === "normal" && covered[0].pairedOccurrenceId === null;
  if (!isDoublePay && !isNormal) throw new CanonicalPaymentReportIncompatibilityError();
  return {
    d2PlanId: snapshot.d2PlanId,
    planVersion: snapshot.planVersion,
    collectionPointOccurrenceId: snapshot.collectionPointOccurrenceId,
    coveredOccurrenceIds,
    timing: "at_collection_point",
    grouping: isDoublePay ? "double_pay" : "normal",
  };
}

const unresolvedOperationStatuses = new Set([
  "pending",
  "leased",
  "provider_unknown",
  "retry_scheduled",
  "action_required",
  "reconciliation_required",
]);

function safePage(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function safeLimit(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, F5_PAGE_MAX)
    : F5_PAGE_DEFAULT;
}

function localBusinessDate(value: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return `${byType.get("year") ?? "0000"}-${byType.get("month") ?? "00"}-${byType.get("day") ?? "00"}`;
}

function ids<T extends { id: string }>(rows: T[]): string[] {
  return [...new Set(rows.map((row) => row.id))];
}

function sameEvidenceValue(left: unknown, right: unknown): boolean {
  if (typeof left === "string" && typeof right === "string") {
    const leftTime = Date.parse(left);
    const rightTime = Date.parse(right);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime === rightTime;
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
    return [...keys].every((key) => sameEvidenceValue(leftRecord[key], rightRecord[key]));
  }
  return left === right;
}

function revisionCoverage<T extends { id: string; currentRevision: number }>(
  parents: T[],
  revisions: Array<{ parentId: string; revisionNumber: number }>,
): boolean {
  const byParent = new Map<string, Set<number>>();
  for (const revision of revisions) {
    const set = byParent.get(revision.parentId) ?? new Set<number>();
    set.add(revision.revisionNumber);
    byParent.set(revision.parentId, set);
  }
  return parents.every((parent) => {
    const set = byParent.get(parent.id);
    if (!set || set.size !== parent.currentRevision) return false;
    for (let revision = 1; revision <= parent.currentRevision; revision += 1) {
      if (!set.has(revision)) return false;
    }
    return true;
  });
}

function revisionSemanticsCoverage(
  parents: Array<{ id: string; currentRevision: number; state: string; amountMinor: number; currency: string; [key: string]: unknown }>,
  revisions: Array<{ parentId: string; revisionNumber: number; snapshotSchemaVersion?: number; beforeSnapshot?: unknown; afterSnapshot: unknown }>,
  expected: (parent: { id: string; currentRevision: number; state: string; amountMinor: number; currency: string; [key: string]: unknown }) => Record<string, unknown>,
): boolean {
  const latest = new Map<string, { revisionNumber: number; afterSnapshot: unknown }>();
  const byParent = new Map<string, Array<{ revisionNumber: number; snapshotSchemaVersion?: number; beforeSnapshot?: unknown; afterSnapshot: unknown }>>();
  for (const revision of revisions) {
    byParent.set(revision.parentId, [...(byParent.get(revision.parentId) ?? []), revision]);
    const prior = latest.get(revision.parentId);
    if (!prior || revision.revisionNumber > prior.revisionNumber) latest.set(revision.parentId, revision);
  }
  return parents.every((parent) => {
    const expectedFields = expected(parent);
    const chain = [...(byParent.get(parent.id) ?? [])].sort((left, right) => left.revisionNumber - right.revisionNumber);
    if (chain.length !== parent.currentRevision || chain.some((revision, index) => revision.revisionNumber !== index + 1 || (revision.snapshotSchemaVersion !== undefined && revision.snapshotSchemaVersion !== 1))) return false;
    if (chain[0]?.beforeSnapshot !== undefined && chain[0].beforeSnapshot !== null) return false;
    for (let index = 1; index < chain.length; index += 1) {
      if (chain[index].beforeSnapshot !== undefined) {
        const before = chain[index].beforeSnapshot;
        const prior = chain[index - 1]?.afterSnapshot;
        if (!before || typeof before !== "object" || !prior || typeof prior !== "object"
          || Object.keys(expectedFields).some((key) => !(key in before) || !(key in prior) || !sameEvidenceValue((before as Record<string, unknown>)[key], (prior as Record<string, unknown>)[key]))) return false;
      }
    }
    const revision = latest.get(parent.id);
    if (!revision || revision.revisionNumber !== parent.currentRevision || !revision.afterSnapshot || typeof revision.afterSnapshot !== "object") return false;
    const snapshot = revision.afterSnapshot as Record<string, unknown>;
    if (!("state" in snapshot) || snapshot.state !== parent.state) return false;
    // Every historical after-snapshot must retain the complete versioned
    // semantic shape. Checking only the latest row allowed a missing field
    // or malformed amount on an off-page earlier revision to be hidden by a
    // later valid revision. Values may legitimately change between
    // revisions, but their primitive shape must remain compatible with the
    // approved contract.
    for (const historical of chain) {
      if (!historical.afterSnapshot || typeof historical.afterSnapshot !== "object") return false;
      const historicalSnapshot = historical.afterSnapshot as Record<string, unknown>;
      for (const [key, expectedValue] of Object.entries(expectedFields)) {
        if (!(key in historicalSnapshot)) return false;
        const actualValue = historicalSnapshot[key];
        if (typeof expectedValue === "number" && (typeof actualValue !== "number" || !Number.isSafeInteger(actualValue))) return false;
        if (typeof expectedValue === "string" && typeof actualValue !== "string") return false;
      }
    }
    return Object.entries(expectedFields).every(([key, value]) => key in snapshot && sameEvidenceValue(snapshot[key], value));
  });
}

function completeVersionedRevisionChains<T extends { id: string; currentRevision: number }, R extends { parentId: string; revisionNumber: number; snapshotSchemaVersion: number; beforeSnapshot: unknown; afterSnapshot: unknown }>(parents: T[], revisions: R[], expectedAfterSnapshot?: (parent: T) => unknown): boolean {
  const byParent = new Map<string, R[]>();
  for (const revision of revisions) byParent.set(revision.parentId, [...(byParent.get(revision.parentId) ?? []), revision]);
  return parents.every((parent) => {
    const chain = [...(byParent.get(parent.id) ?? [])].sort((left, right) => left.revisionNumber - right.revisionNumber);
    if (chain.length !== parent.currentRevision || chain.some((row, index) => row.revisionNumber !== index + 1 || row.snapshotSchemaVersion !== 1 || !row.afterSnapshot || typeof row.afterSnapshot !== "object")) return false;
    if (chain[0]?.beforeSnapshot !== null && chain[0]?.beforeSnapshot !== undefined) return false;
    if (!chain.slice(1).every((row, index) => sameEvidenceValue(row.beforeSnapshot, chain[index]?.afterSnapshot))) return false;
    const latest = chain.at(-1)?.afterSnapshot;
    return expectedAfterSnapshot === undefined || sameEvidenceValue(latest, expectedAfterSnapshot(parent));
  });
}

function planRevisionMatchesCurrent(
  snapshot: unknown,
  plan: typeof occurrenceCollectionPlans.$inferSelect,
  items: Array<typeof occurrenceCollectionPlanItems.$inferSelect>,
): boolean {
  if (!snapshot || typeof snapshot !== "object") return false;
  const value = snapshot as { state?: unknown; plan?: unknown; items?: unknown };
  if (value.state !== plan.state || !value.plan || typeof value.plan !== "object" || !Array.isArray(value.items)) return false;
  const persistedPlan = value.plan as Record<string, unknown>;
  const planKeys = ["id", "organizationId", "leagueId", "version", "triggerOccurrenceId", "collectAt", "currency", "state", "currentRevision"] as const;
  for (const key of planKeys) {
    if (!(key in persistedPlan) || !sameEvidenceValue(persistedPlan[key], plan[key])) return false;
  }
  const persistedItems = value.items as Array<Record<string, unknown>>;
  if (persistedItems.length !== items.length) return false;
  const expectedItems = [...items].sort((left, right) => left.itemIndex - right.itemIndex);
  const actualItems = [...persistedItems].sort((left, right) => Number(left.itemIndex) - Number(right.itemIndex));
  return actualItems.every((item, index) => {
    const expected = expectedItems[index];
    if (!expected) return false;
    const itemKeys = ["organizationId", "leagueId", "planId", "obligationId", "occurrenceId", "bowlerId", "amountMinor", "currency", "itemIndex"] as const;
    return itemKeys.every((key) => key in item && sameEvidenceValue(item[key], expected[key]));
  });
}

function planRevisionSnapshotsEquivalent(left: unknown, right: unknown): boolean {
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftValue = left as { state?: unknown; plan?: unknown; items?: unknown };
  const rightValue = right as { state?: unknown; plan?: unknown; items?: unknown };
  if (leftValue.state !== rightValue.state || !leftValue.plan || !rightValue.plan || typeof leftValue.plan !== "object" || typeof rightValue.plan !== "object" || !Array.isArray(leftValue.items) || !Array.isArray(rightValue.items)) return false;
  const leftPlan = leftValue.plan as Record<string, unknown>;
  const rightPlan = rightValue.plan as Record<string, unknown>;
  for (const key of ["id", "organizationId", "leagueId", "version", "triggerOccurrenceId", "collectAt", "currency", "state"]) {
    if (!(key in leftPlan) || !(key in rightPlan) || !sameEvidenceValue(leftPlan[key], rightPlan[key])) return false;
  }
  const semanticKeys = ["organizationId", "leagueId", "planId", "obligationId", "occurrenceId", "bowlerId", "amountMinor", "currency", "itemIndex"] as const;
  const leftItems = [...leftValue.items as Array<Record<string, unknown>>].sort((a, b) => Number(a.itemIndex) - Number(b.itemIndex));
  const rightItems = [...rightValue.items as Array<Record<string, unknown>>].sort((a, b) => Number(a.itemIndex) - Number(b.itemIndex));
  return leftItems.length === rightItems.length && leftItems.every((item, index) => semanticKeys.every((key) => {
    const rightItem = rightItems[index];
    const result = key in item && rightItem !== undefined && key in rightItem && sameEvidenceValue(item[key], rightItem[key]);
    return result;
  }));
}

function completePlanRevisionChains(
  plans: Array<typeof occurrenceCollectionPlans.$inferSelect>,
  revisions: Array<{ parentId: string; revisionNumber: number; snapshotSchemaVersion: number; beforeSnapshot: unknown; afterSnapshot: unknown }>,
  items: Array<typeof occurrenceCollectionPlanItems.$inferSelect>,
): boolean {
  return plans.every((plan) => {
    const chain = revisions.filter((revision) => revision.parentId === plan.id).sort((left, right) => left.revisionNumber - right.revisionNumber);
    if (chain.length !== plan.currentRevision || chain.some((revision, index) => revision.revisionNumber !== index + 1 || revision.snapshotSchemaVersion !== 1 || !revision.afterSnapshot || typeof revision.afterSnapshot !== "object")) return false;
    if (chain[0]?.beforeSnapshot !== null && chain[0]?.beforeSnapshot !== undefined) return false;
    for (let index = 1; index < chain.length; index += 1) {
      if (!planRevisionSnapshotsEquivalent(chain[index - 1]?.afterSnapshot, chain[index]?.beforeSnapshot)) return false;
    }
    const result = planRevisionMatchesCurrent(chain.at(-1)?.afterSnapshot, plan, items.filter((item) => item.planId === plan.id));
    return result;
  });
}

function policyRevisionSnapshotForReport(policy: typeof f3CollectionPolicies.$inferSelect, occurrences: Array<{ occurrenceId: string; groupKey: string; groupRole: string; pairedOccurrenceId: string | null; collectionPointOccurrenceId: string; itemIndex: number }>) {
  return {
    contractVersion: "canonical-collection-policy/1",
    policy: {
      id: policy.id,
      organizationId: policy.organizationId,
      leagueId: policy.leagueId,
      activationId: policy.activationId,
      activationRevision: policy.activationRevision,
      activationSourceFingerprint: policy.activationSourceFingerprint,
      policyVersion: policy.policyVersion,
      policyFingerprint: policy.policyFingerprint,
      commandKey: policy.commandKey,
      state: policy.state,
      currentRevision: policy.currentRevision,
      collectionPoints: policy.collectionPoints.map((point) => ({ occurrenceId: typeof point === "string" ? point : point.occurrenceId })),
      approvedByUserId: policy.approvedByUserId,
      approvedAt: policy.approvedAt,
    },
    occurrences: [...occurrences].sort((left, right) => left.itemIndex - right.itemIndex || left.occurrenceId.localeCompare(right.occurrenceId)).map((row) => ({
      occurrenceId: row.occurrenceId,
      groupKey: row.groupKey,
      groupRole: row.groupRole,
      pairedOccurrenceId: row.pairedOccurrenceId,
      collectionPointOccurrenceId: row.collectionPointOccurrenceId,
      itemIndex: row.itemIndex,
    })),
  };
}

function statusForPayment(payment: Payment, operation: Operation | undefined, disputed: boolean): CanonicalPaymentRow["status"] {
  if (payment.status === "refunded") return "refunded";
  if (payment.status === "disputed" && operation && !disputed) return "review_required";
  if (payment.status === "disputed" || disputed) return "disputed";
  if (operation && unresolvedOperationStatuses.has(operation.status)) return "unresolved";
  if (payment.status === "paid") return "confirmed_paid";
  if (payment.status === "pending") return "pending";
  if (payment.status === "failed") return "failed";
  return "review_required";
}

function groupKey(payment: Payment): { key: string; operationId: string | null; combinedId: string | null } {
  if (payment.paymentOperationId) return { key: `operation:${payment.paymentOperationId}`, operationId: payment.paymentOperationId, combinedId: null };
  if (payment.combinedChargeGroupId) return { key: `combined:${payment.combinedChargeGroupId}`, operationId: null, combinedId: payment.combinedChargeGroupId };
  return { key: `payment:${payment.id}`, operationId: null, combinedId: null };
}

type DurableOperationDispute = { amountMinor: number; disputeId: string; state: string; currency: string };

function buildTransactions(rows: CanonicalPaymentRow[], paymentsById: Map<number, Payment>, operationsById: Map<string, Operation>, disputesByOperation: Map<string, DurableOperationDispute>): CanonicalPaymentTransactionGroup[] {
  const groups = new Map<string, CanonicalPaymentTransactionGroup>();
  for (const row of rows) {
    const payment = row.paymentId === null ? undefined : paymentsById.get(row.paymentId);
    const identity = payment
      ? groupKey(payment)
      : { key: `operation:${row.paymentOperationId ?? row.paymentId ?? row.bowlerId}`, operationId: row.paymentOperationId, combinedId: null };
    const durable = identity.operationId ? disputesByOperation.get(identity.operationId) : undefined;
    const existing = groups.get(identity.key);
    if (existing) {
      if (row.collectionEvidence) {
        if (existing.collectionEvidence && JSON.stringify(existing.collectionEvidence) !== JSON.stringify(row.collectionEvidence)) throw new CanonicalPaymentReportIncompatibilityError();
        existing.collectionEvidence = row.collectionEvidence;
      }
      if (!existing.paymentOperationId) existing.amountMinor += row.amountMinor;
      if (row.paymentId !== null) existing.paymentIds = [...new Set([...existing.paymentIds, row.paymentId])].sort((a, b) => a - b);
      if (!existing.dispute && row.dispute.present) existing.dispute = durable
        ? { present: true, amountMinor: durable.amountMinor, disputeId: durable.disputeId, currency: durable.currency, state: durable.state, reviewRequired: true, scope: "transaction" }
        : { ...row.dispute, currency: row.currency, state: "review_required", reviewRequired: true, scope: "transaction" };
      existing.rows.push(row);
    } else {
      groups.set(identity.key, {
        groupKey: identity.key,
        paymentOperationId: identity.operationId,
        combinedChargeGroupId: identity.combinedId,
        amountMinor: identity.operationId ? (operationsById.get(identity.operationId)?.amountMinor ?? row.amountMinor) : row.amountMinor,
        currency: row.currency,
        paymentIds: row.paymentId === null ? [] : [row.paymentId],
        dispute: row.dispute.present ? (durable
          ? { present: true, amountMinor: durable.amountMinor, disputeId: durable.disputeId, currency: durable.currency, state: durable.state, reviewRequired: true, scope: "transaction" }
          : { ...row.dispute, currency: row.currency, state: "review_required", reviewRequired: true, scope: "transaction" }) : undefined,
        rows: [row],
        ...(row.collectionEvidence ? { collectionEvidence: row.collectionEvidence } : {}),
      });
    }
  }
  return [...groups.values()].sort((left, right) => {
    const leftRow = left.rows[0];
    const rightRow = right.rows[0];
    return leftRow.authoritativeLocalDate.localeCompare(rightRow.authoritativeLocalDate)
      || leftRow.bowlerId - rightRow.bowlerId;
  });
}

async function readCanonicalPaymentReportInTransaction(tx: ReportDbTransaction, input: CanonicalPaymentReportInput): Promise<CanonicalPaymentReport> {
  const page = safePage(input.page);
  const limit = safeLimit(input.limit);
  const asOfResult = await tx.execute(sql`SELECT transaction_timestamp()::text AS now`);
  const asOf = String((asOfResult.rows[0] as { now?: string } | undefined)?.now ?? new Date().toISOString());

    const [league] = await tx.select({ id: leagues.id, organizationId: leagues.organizationId, timezone: leagues.timezone, paymentMode: leagues.paymentMode })
      .from(leagues)
      .where(and(eq(leagues.id, input.leagueId), eq(leagues.organizationId, input.organizationId)))
      .limit(1);
    if (!league) throw new CanonicalPaymentReportIncompatibilityError();

    const [activation] = await tx.execute(sql`
      SELECT id, completeness_marker, current_revision, activation_version, policy_version, order_version,
             request_fingerprint, source_fingerprint, payment_mode, state, paying_lineup_size,
             expected_responsibility_count, expected_group_count, upfront_due_at
      FROM financial_activations
      WHERE organization_id = ${input.organizationId}
        AND league_id = ${input.leagueId}
        AND state = 'active'
      LIMIT 1
    `).then((result) => result.rows as Array<{ id: string; completeness_marker: boolean; current_revision: number; activation_version: number; policy_version: string; order_version: string; request_fingerprint: string; source_fingerprint: string; payment_mode: string; state: string; paying_lineup_size: number; expected_responsibility_count: number; expected_group_count: number; upfront_due_at: string | null }>);

    const [partialEvidence] = await tx.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM bowler_occurrence_obligations WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
        UNION ALL SELECT 1 FROM occurrence_collection_plans WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
        UNION ALL SELECT 1 FROM occurrence_collection_plan_items WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
        UNION ALL SELECT 1 FROM occurrence_collection_plan_revisions WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
        UNION ALL SELECT 1 FROM financial_responsibilities WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
        UNION ALL SELECT 1 FROM financial_activations WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
        UNION ALL SELECT 1 FROM financial_activation_revisions WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
        UNION ALL SELECT 1 FROM bowler_occurrence_eligibilities WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
        UNION ALL SELECT 1 FROM bowler_occurrence_eligibility_revisions WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
        UNION ALL SELECT 1 FROM bowler_occurrence_team_assignments WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
        UNION ALL SELECT 1 FROM bowler_occurrence_team_assignment_revisions WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
        UNION ALL SELECT 1 FROM f3_collection_policies WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
        UNION ALL SELECT 1 FROM f3_collection_policy_occurrences WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
        UNION ALL SELECT 1 FROM f3_collection_policy_revisions WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
        UNION ALL SELECT 1 FROM f3_payer_autopay_authorizations WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
        UNION ALL SELECT 1 FROM f3_payer_authorization_revisions WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
        UNION ALL SELECT 1 FROM f3_autopay_plan_provenance WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
        UNION ALL SELECT 1 FROM payment_operation_occurrence_snapshots WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
        UNION ALL SELECT 1 FROM payment_operation_occurrence_snapshot_allocations WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
        UNION ALL SELECT 1 FROM payment_occurrence_allocations WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
        UNION ALL SELECT 1 FROM payment_occurrence_allocation_revisions WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
        UNION ALL SELECT 1 FROM canonical_autopay_execution_snapshots WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
      ) AS present
    `).then((result) => result.rows as Array<{ present: boolean }>);
    if (!activation && partialEvidence?.present) throw new CanonicalPaymentReportIncompatibilityError();
    if (activation && activation.completeness_marker !== true) throw new CanonicalPaymentReportIncompatibilityError();
    if (activation) {
      try {
        const operationalEvidence = await loadOperationalActivationEvidence(tx, { organizationId: input.organizationId, leagueId: input.leagueId });
        if (operationalEvidence.authoritativeSource !== "canonical" || operationalEvidence.sourceFingerprint !== activation.source_fingerprint) throw new Error("activation source drift");
      } catch {
        throw new CanonicalPaymentReportIncompatibilityError();
      }
      const activationRevisions = await tx.select({
        parentId: financialActivationRevisions.activationId,
        revisionNumber: financialActivationRevisions.revisionNumber,
        snapshotSchemaVersion: financialActivationRevisions.snapshotSchemaVersion,
        beforeSnapshot: financialActivationRevisions.beforeSnapshot,
        afterSnapshot: financialActivationRevisions.afterSnapshot,
      }).from(financialActivationRevisions).where(and(
        eq(financialActivationRevisions.organizationId, input.organizationId),
        eq(financialActivationRevisions.leagueId, input.leagueId),
        eq(financialActivationRevisions.activationId, activation.id),
      ));
      if (activationRevisions.length !== activation.current_revision
        || new Set(activationRevisions.map((row) => row.revisionNumber)).size !== activation.current_revision
        || activationRevisions.some((row) => row.snapshotSchemaVersion !== 1 || (row.revisionNumber === 1 ? row.beforeSnapshot !== null : row.beforeSnapshot === null) || !row.afterSnapshot || typeof row.afterSnapshot !== "object")
        || !Array.from({ length: activation.current_revision }, (_, index) => index + 1)
          .every((revision) => activationRevisions.some((row) => row.revisionNumber === revision))) {
        throw new CanonicalPaymentReportIncompatibilityError();
      }
      const orderedActivationRevisions = [...activationRevisions].sort((left, right) => left.revisionNumber - right.revisionNumber);
      for (let index = 1; index < orderedActivationRevisions.length; index += 1) {
        if (JSON.stringify(orderedActivationRevisions[index]?.beforeSnapshot) !== JSON.stringify(orderedActivationRevisions[index - 1]?.afterSnapshot)) throw new CanonicalPaymentReportIncompatibilityError();
      }
      const activationSnapshot = orderedActivationRevisions.at(-1)?.afterSnapshot as Record<string, unknown> | undefined;
      const activationExpected: Record<string, unknown> = {
        activationVersion: activation.activation_version,
        policyVersion: activation.policy_version,
        orderVersion: activation.order_version,
        requestFingerprint: activation.request_fingerprint,
        sourceFingerprint: activation.source_fingerprint,
        payingLineupSize: activation.paying_lineup_size,
        expectedResponsibilityCount: activation.expected_responsibility_count,
        expectedGroupCount: activation.expected_group_count,
      };
      if (!activationSnapshot || Object.entries(activationExpected).some(([key, value]) => !(key in activationSnapshot) || activationSnapshot[key] !== value)) throw new CanonicalPaymentReportIncompatibilityError();
      const persistedResponsibilities = await tx.select({ occurrenceId: financialResponsibilities.occurrenceId, teamId: financialResponsibilities.teamId, slotIndex: financialResponsibilities.slotIndex, bowlerId: financialResponsibilities.bowlerId, obligationId: financialResponsibilities.obligationId, role: financialResponsibilities.role, provenance: financialResponsibilities.provenance }).from(financialResponsibilities).where(and(eq(financialResponsibilities.organizationId, input.organizationId), eq(financialResponsibilities.leagueId, input.leagueId), eq(financialResponsibilities.activationId, activation.id))).orderBy(asc(financialResponsibilities.occurrenceId), asc(financialResponsibilities.teamId), asc(financialResponsibilities.slotIndex), asc(financialResponsibilities.bowlerId));
      const snapshotResponsibilities = Array.isArray(activationSnapshot.responsibilities) ? [...activationSnapshot.responsibilities as Array<Record<string, unknown>>].sort((left, right) => `${String(left.occurrenceId)}:${String(left.teamId)}:${String(left.slotIndex)}:${String(left.bowlerId)}`.localeCompare(`${String(right.occurrenceId)}:${String(right.teamId)}:${String(right.slotIndex)}:${String(right.bowlerId)}`)) : [];
      const snapshotCarriesObligationIds = snapshotResponsibilities.every((row) => Object.prototype.hasOwnProperty.call(row, "obligationId"));
      const expectedResponsibilities = persistedResponsibilities.map((row) => ({ occurrenceId: row.occurrenceId, teamId: row.teamId, slotIndex: row.slotIndex, bowlerId: row.bowlerId, ...(snapshotCarriesObligationIds ? { obligationId: row.obligationId } : {}), role: row.role, provenance: row.provenance }));
      if (new Set(persistedResponsibilities.map((row) => row.obligationId)).size !== persistedResponsibilities.length
        || snapshotResponsibilities.length !== expectedResponsibilities.length
        || snapshotResponsibilities.some((row, index) => !sameEvidenceValue(row, expectedResponsibilities[index]))) throw new CanonicalPaymentReportIncompatibilityError();
      const eligibilityIds = [...new Set((await tx.select({ id: financialResponsibilities.eligibilityId }).from(financialResponsibilities).where(and(eq(financialResponsibilities.organizationId, input.organizationId), eq(financialResponsibilities.leagueId, input.leagueId), eq(financialResponsibilities.activationId, activation.id)))).map((row) => row.id))];
      const assignmentIds = [...new Set((await tx.select({ id: financialResponsibilities.assignmentId }).from(financialResponsibilities).where(and(eq(financialResponsibilities.organizationId, input.organizationId), eq(financialResponsibilities.leagueId, input.leagueId), eq(financialResponsibilities.activationId, activation.id)))).map((row) => row.id))];
      const eligibilityParents = eligibilityIds.length === 0 ? [] : await tx.select({ id: bowlerOccurrenceEligibilities.id, currentRevision: bowlerOccurrenceEligibilities.currentRevision, state: bowlerOccurrenceEligibilities.state, reason: bowlerOccurrenceEligibilities.reason }).from(bowlerOccurrenceEligibilities).where(and(eq(bowlerOccurrenceEligibilities.organizationId, input.organizationId), eq(bowlerOccurrenceEligibilities.leagueId, input.leagueId), inArray(bowlerOccurrenceEligibilities.id, eligibilityIds)));
      const assignmentParents = assignmentIds.length === 0 ? [] : await tx.select({ id: bowlerOccurrenceTeamAssignments.id, currentRevision: bowlerOccurrenceTeamAssignments.currentRevision, state: bowlerOccurrenceTeamAssignments.state, teamId: bowlerOccurrenceTeamAssignments.teamId, reason: bowlerOccurrenceTeamAssignments.reason }).from(bowlerOccurrenceTeamAssignments).where(and(eq(bowlerOccurrenceTeamAssignments.organizationId, input.organizationId), eq(bowlerOccurrenceTeamAssignments.leagueId, input.leagueId), inArray(bowlerOccurrenceTeamAssignments.id, assignmentIds)));
      const eligibilityRevisions = eligibilityIds.length === 0 ? [] : await tx.select({ parentId: bowlerOccurrenceEligibilityRevisions.eligibilityId, revisionNumber: bowlerOccurrenceEligibilityRevisions.revisionNumber, snapshotSchemaVersion: bowlerOccurrenceEligibilityRevisions.snapshotSchemaVersion, beforeSnapshot: bowlerOccurrenceEligibilityRevisions.beforeSnapshot, afterSnapshot: bowlerOccurrenceEligibilityRevisions.afterSnapshot }).from(bowlerOccurrenceEligibilityRevisions).where(and(eq(bowlerOccurrenceEligibilityRevisions.organizationId, input.organizationId), eq(bowlerOccurrenceEligibilityRevisions.leagueId, input.leagueId), inArray(bowlerOccurrenceEligibilityRevisions.eligibilityId, eligibilityIds)));
      const assignmentRevisions = assignmentIds.length === 0 ? [] : await tx.select({ parentId: bowlerOccurrenceTeamAssignmentRevisions.assignmentId, revisionNumber: bowlerOccurrenceTeamAssignmentRevisions.revisionNumber, snapshotSchemaVersion: bowlerOccurrenceTeamAssignmentRevisions.snapshotSchemaVersion, beforeSnapshot: bowlerOccurrenceTeamAssignmentRevisions.beforeSnapshot, afterSnapshot: bowlerOccurrenceTeamAssignmentRevisions.afterSnapshot }).from(bowlerOccurrenceTeamAssignmentRevisions).where(and(eq(bowlerOccurrenceTeamAssignmentRevisions.organizationId, input.organizationId), eq(bowlerOccurrenceTeamAssignmentRevisions.leagueId, input.leagueId), inArray(bowlerOccurrenceTeamAssignmentRevisions.assignmentId, assignmentIds)));
      if (eligibilityParents.length !== eligibilityIds.length || assignmentParents.length !== assignmentIds.length
        || !completeVersionedRevisionChains(eligibilityParents, eligibilityRevisions, (parent) => ({ state: parent.state, reason: parent.reason }))
        || !completeVersionedRevisionChains(assignmentParents, assignmentRevisions, (parent) => ({ state: parent.state, teamId: parent.teamId, reason: parent.reason }))) throw new CanonicalPaymentReportIncompatibilityError();

      const [activationShape] = await tx.execute(sql`
        SELECT (
          (SELECT COUNT(*) FROM financial_responsibilities WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId} AND activation_id = ${activation.id}) <> ${activation.expected_responsibility_count}
          OR (SELECT COUNT(DISTINCT occurrence_id || ':' || team_id) FROM financial_responsibilities WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId} AND activation_id = ${activation.id}) <> ${activation.expected_group_count}
          OR EXISTS (SELECT 1 FROM financial_responsibilities WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId} AND activation_id = ${activation.id} GROUP BY occurrence_id, team_id HAVING COUNT(*) <> ${activation.paying_lineup_size} OR COUNT(DISTINCT slot_index) <> ${activation.paying_lineup_size} OR MIN(slot_index) <> 0 OR MAX(slot_index) <> ${activation.paying_lineup_size - 1})
          OR EXISTS (SELECT 1 FROM financial_responsibilities r WHERE r.organization_id = ${input.organizationId} AND r.league_id = ${input.leagueId} AND r.activation_id = ${activation.id} AND (r.paying_lineup_size <> ${activation.paying_lineup_size} OR r.slot_index NOT BETWEEN 0 AND ${activation.paying_lineup_size - 1} OR NOT EXISTS (SELECT 1 FROM bowler_occurrence_eligibilities e WHERE e.id = r.eligibility_id AND e.organization_id = r.organization_id AND e.league_id = r.league_id AND e.occurrence_id = r.occurrence_id AND e.bowler_id = r.bowler_id AND e.state = 'eligible' AND e.current_revision > 0) OR NOT EXISTS (SELECT 1 FROM bowler_occurrence_team_assignments a WHERE a.id = r.assignment_id AND a.organization_id = r.organization_id AND a.league_id = r.league_id AND a.occurrence_id = r.occurrence_id AND a.bowler_id = r.bowler_id AND a.team_id = r.team_id AND a.state = 'assigned' AND a.current_revision > 0) OR NOT EXISTS (SELECT 1 FROM bowler_occurrence_obligations o WHERE o.id = r.obligation_id AND o.organization_id = r.organization_id AND o.league_id = r.league_id AND o.occurrence_id = r.occurrence_id AND o.bowler_id = r.bowler_id AND o.amount_minor = r.amount_minor AND o.currency = r.currency AND o.billing_term_id = r.billing_term_id AND o.billing_term_version = r.billing_term_version AND o.due_at = r.due_at AND o.past_due_at = r.past_due_at) OR NOT EXISTS (SELECT 1 FROM bowler_occurrence_obligation_revisions rev WHERE rev.obligation_id = r.obligation_id AND rev.organization_id = r.organization_id AND rev.league_id = r.league_id AND rev.obligation_id = r.obligation_id)))
        ) AS present
      `).then((result) => result.rows as Array<{ present: boolean }>);
      if (activationShape?.present) throw new CanonicalPaymentReportIncompatibilityError();
    }

    // Validate every canonical execution snapshot in the tenant/league before
    // selecting a page. Page boundaries must never hide corrupt F4 evidence.
    const canonicalSnapshotsForReport = activation
      ? await tx.select().from(canonicalAutopayExecutionSnapshots).where(and(
        eq(canonicalAutopayExecutionSnapshots.organizationId, input.organizationId),
        eq(canonicalAutopayExecutionSnapshots.leagueId, input.leagueId),
      ))
      : [];
    const canonicalSnapshotByOperation = new Map(canonicalSnapshotsForReport.map((snapshot) => [snapshot.operationId, snapshot]));
    const canonicalPolicyOccurrencesByPolicy = new Map<string, Array<typeof f3CollectionPolicyOccurrences.$inferSelect>>();
    if (canonicalSnapshotsForReport.length > 0) {
      const snapshotOperations = await tx.select().from(paymentOperations).where(and(
        eq(paymentOperations.organizationId, input.organizationId),
        inArray(paymentOperations.id, canonicalSnapshotsForReport.map((snapshot) => snapshot.operationId)),
      ));
      const operationById = new Map(snapshotOperations.map((operation) => [operation.id, operation]));
      const provenanceRows = await tx.select().from(f3AutopayPlanProvenance).where(and(
        eq(f3AutopayPlanProvenance.organizationId, input.organizationId),
        eq(f3AutopayPlanProvenance.leagueId, input.leagueId),
        inArray(f3AutopayPlanProvenance.d2PlanId, canonicalSnapshotsForReport.map((snapshot) => snapshot.d2PlanId)),
      ));
      const provenanceByPlan = new Map(provenanceRows.map((row) => [row.d2PlanId, row]));
      const policyRows = await tx.select().from(f3CollectionPolicies).where(and(
        eq(f3CollectionPolicies.organizationId, input.organizationId),
        eq(f3CollectionPolicies.leagueId, input.leagueId),
        inArray(f3CollectionPolicies.id, canonicalSnapshotsForReport.map((snapshot) => snapshot.policyId)),
      ));
      const policyById = new Map(policyRows.map((row) => [row.id, row]));
      const authorizationRows = await tx.select().from(f3PayerAuthorizations).where(and(
        eq(f3PayerAuthorizations.organizationId, input.organizationId),
        eq(f3PayerAuthorizations.leagueId, input.leagueId),
        inArray(f3PayerAuthorizations.id, canonicalSnapshotsForReport.map((snapshot) => snapshot.authorizationId)),
      ));
      const authorizationById = new Map(authorizationRows.map((row) => [row.id, row]));
      const planRows = await tx.select().from(occurrenceCollectionPlans).where(and(
        eq(occurrenceCollectionPlans.organizationId, input.organizationId),
        eq(occurrenceCollectionPlans.leagueId, input.leagueId),
        inArray(occurrenceCollectionPlans.id, canonicalSnapshotsForReport.map((snapshot) => snapshot.d2PlanId)),
      ));
      const planById = new Map(planRows.map((row) => [row.id, row]));
      const planItemRows = await tx.select().from(occurrenceCollectionPlanItems).where(and(
        eq(occurrenceCollectionPlanItems.organizationId, input.organizationId),
        eq(occurrenceCollectionPlanItems.leagueId, input.leagueId),
        inArray(occurrenceCollectionPlanItems.planId, canonicalSnapshotsForReport.map((snapshot) => snapshot.d2PlanId)),
      ));
      const policyOccurrenceRows = await tx.select().from(f3CollectionPolicyOccurrences).where(and(
        eq(f3CollectionPolicyOccurrences.organizationId, input.organizationId),
        eq(f3CollectionPolicyOccurrences.leagueId, input.leagueId),
        inArray(f3CollectionPolicyOccurrences.policyId, canonicalSnapshotsForReport.map((snapshot) => snapshot.policyId)),
      ));
      const triggerOccurrenceRows = await tx.select({ id: leagueOccurrences.id, startAt: leagueOccurrences.startAt }).from(leagueOccurrences).where(and(
        eq(leagueOccurrences.organizationId, input.organizationId),
        eq(leagueOccurrences.leagueId, input.leagueId),
        inArray(leagueOccurrences.id, canonicalSnapshotsForReport.map((snapshot) => snapshot.triggerOccurrenceId)),
      ));
      const policyRevisionRows = await tx.select({ parentId: f3CollectionPolicyRevisions.policyId, revisionNumber: f3CollectionPolicyRevisions.revisionNumber, snapshotSchemaVersion: f3CollectionPolicyRevisions.snapshotSchemaVersion, beforeSnapshot: f3CollectionPolicyRevisions.beforeSnapshot, afterSnapshot: f3CollectionPolicyRevisions.afterSnapshot }).from(f3CollectionPolicyRevisions).where(and(eq(f3CollectionPolicyRevisions.organizationId, input.organizationId), eq(f3CollectionPolicyRevisions.leagueId, input.leagueId), inArray(f3CollectionPolicyRevisions.policyId, canonicalSnapshotsForReport.map((snapshot) => snapshot.policyId))));
      const authorizationRevisionRows = await tx.select({ parentId: f3PayerAuthorizationRevisions.authorizationId, revisionNumber: f3PayerAuthorizationRevisions.revisionNumber, snapshotSchemaVersion: f3PayerAuthorizationRevisions.snapshotSchemaVersion, beforeSnapshot: f3PayerAuthorizationRevisions.beforeSnapshot, afterSnapshot: f3PayerAuthorizationRevisions.afterSnapshot }).from(f3PayerAuthorizationRevisions).where(and(eq(f3PayerAuthorizationRevisions.organizationId, input.organizationId), eq(f3PayerAuthorizationRevisions.leagueId, input.leagueId), inArray(f3PayerAuthorizationRevisions.authorizationId, canonicalSnapshotsForReport.map((snapshot) => snapshot.authorizationId))));
      const planRevisionRows = await tx.select({ parentId: occurrenceCollectionPlanRevisions.planId, revisionNumber: occurrenceCollectionPlanRevisions.revisionNumber, snapshotSchemaVersion: occurrenceCollectionPlanRevisions.snapshotSchemaVersion, beforeSnapshot: occurrenceCollectionPlanRevisions.beforeSnapshot, afterSnapshot: occurrenceCollectionPlanRevisions.afterSnapshot }).from(occurrenceCollectionPlanRevisions).where(and(eq(occurrenceCollectionPlanRevisions.organizationId, input.organizationId), eq(occurrenceCollectionPlanRevisions.leagueId, input.leagueId), inArray(occurrenceCollectionPlanRevisions.planId, canonicalSnapshotsForReport.map((snapshot) => snapshot.d2PlanId))));
      if (!completeVersionedRevisionChains(policyRows, policyRevisionRows, (policy) => policyRevisionSnapshotForReport(policy, policyOccurrenceRows.filter((row) => row.policyId === policy.id)))
        || !completeVersionedRevisionChains(authorizationRows, authorizationRevisionRows, (authorization) => authorization)
        || !completePlanRevisionChains(planRows, planRevisionRows, planItemRows)) throw new CanonicalPaymentReportIncompatibilityError();
      for (const row of policyOccurrenceRows) canonicalPolicyOccurrencesByPolicy.set(row.policyId, [...(canonicalPolicyOccurrencesByPolicy.get(row.policyId) ?? []), row]);
      for (const snapshot of canonicalSnapshotsForReport) {
        const operation = operationById.get(snapshot.operationId);
        const provenance = provenanceByPlan.get(snapshot.d2PlanId);
        const plan = planById.get(snapshot.d2PlanId);
        const policy = policyById.get(snapshot.policyId);
        const authorization = authorizationById.get(snapshot.authorizationId);
        const triggerOccurrence = triggerOccurrenceRows.find((row) => row.id === snapshot.triggerOccurrenceId);
        if (!operation || operation.operationType !== "canonical_autopay_charge" || operation.leagueId !== snapshot.leagueId || operation.canonicalPlanId !== snapshot.d2PlanId || operation.triggerOccurrenceId !== snapshot.triggerOccurrenceId || operation.amountMinor !== snapshot.amountMinor || operation.currency !== snapshot.currency || !provenance || !plan
          || !policy || !authorization
          || provenance.planVersion !== snapshot.planVersion || provenance.planFingerprint !== snapshot.planFingerprint || provenance.policyId !== snapshot.policyId || provenance.policyVersion !== snapshot.policyVersion || provenance.authorizationId !== snapshot.authorizationId || provenance.authorizationVersion !== snapshot.authorizationVersion || provenance.collectionPointOccurrenceId !== snapshot.collectionPointOccurrenceId || provenance.activationId !== snapshot.activationId || provenance.activationRevision !== snapshot.activationRevision || provenance.activationSourceFingerprint !== snapshot.activationSourceFingerprint
          || provenance.payerBowlerId !== snapshot.payerBowlerId || provenance.timing !== "at_collection_point"
          || policy.policyVersion !== snapshot.policyVersion || policy.policyFingerprint !== snapshot.policyFingerprint || !policy.collectionPoints.some((point) => point.occurrenceId === snapshot.collectionPointOccurrenceId)
          || authorization.payerBowlerId !== snapshot.payerBowlerId || authorization.policyId !== snapshot.policyId || authorization.policyVersion !== snapshot.policyVersion || authorization.authorizationVersion !== snapshot.authorizationVersion || authorization.authorizationFingerprint !== snapshot.authorizationFingerprint || !authorization.collectionPointOccurrenceIds.includes(snapshot.collectionPointOccurrenceId)
          || plan.version !== snapshot.planVersion || plan.currency !== snapshot.currency || plan.triggerOccurrenceId !== snapshot.triggerOccurrenceId || plan.collectAt !== null
          || !triggerOccurrence || new Date(triggerOccurrence.startAt).toISOString() !== new Date(snapshot.triggerStartAt).toISOString()) throw new CanonicalPaymentReportIncompatibilityError();
        try {
          validateF4ExecutionSnapshot({
            contractVersion: "canonical-autopay-execution/1", snapshotVersion: snapshot.snapshotVersion,
            operationId: snapshot.operationId, organizationId: snapshot.organizationId, leagueId: snapshot.leagueId,
            d2PlanId: snapshot.d2PlanId, collectionPointOccurrenceId: snapshot.collectionPointOccurrenceId,
            triggerOccurrenceId: snapshot.triggerOccurrenceId, triggerStartAt: new Date(snapshot.triggerStartAt).toISOString(),
            payerBowlerId: snapshot.payerBowlerId, locationId: snapshot.locationId, providerLocationId: snapshot.providerLocationId,
            activationId: snapshot.activationId, activationRevision: snapshot.activationRevision, activationSourceFingerprint: snapshot.activationSourceFingerprint,
            policyId: snapshot.policyId, policyVersion: snapshot.policyVersion, policyFingerprint: snapshot.policyFingerprint,
            authorizationId: snapshot.authorizationId, authorizationVersion: snapshot.authorizationVersion, authorizationFingerprint: snapshot.authorizationFingerprint,
            planVersion: snapshot.planVersion, planFingerprint: snapshot.planFingerprint, amountMinor: snapshot.amountMinor, currency: snapshot.currency,
            items: snapshot.items, encryptedSourceId: snapshot.encryptedSourceId, encryptedCustomerId: snapshot.encryptedCustomerId, snapshotFingerprint: snapshot.snapshotFingerprint,
          });
        } catch { throw new CanonicalPaymentReportIncompatibilityError(); }
        const items = Array.isArray(snapshot.items) ? snapshot.items as Array<Record<string, unknown>> : [];
        const planItems = planItemRows.filter((item) => item.planId === snapshot.d2PlanId).sort((left, right) => left.itemIndex - right.itemIndex);
        if (planItems.length !== items.length || planItems.some((item, index) => item.obligationId !== items[index]?.obligationId || item.occurrenceId !== items[index]?.occurrenceId || item.bowlerId !== items[index]?.bowlerId || item.amountMinor !== items[index]?.amountMinor || item.itemIndex !== items[index]?.itemIndex)) throw new CanonicalPaymentReportIncompatibilityError();
        const authorizedItems = Array.isArray(authorization.authorizedItems)
          ? authorization.authorizedItems.filter((item) => item.collectionPointOccurrenceId === snapshot.collectionPointOccurrenceId).sort((left, right) => left.itemIndex - right.itemIndex)
          : [];
        if (authorizedItems.length !== items.length || authorizedItems.some((item, index) => item.obligationId !== items[index]?.obligationId || item.occurrenceId !== items[index]?.occurrenceId || item.bowlerId !== items[index]?.bowlerId || item.amountMinor !== items[index]?.amountMinor || item.collectionPointOccurrenceId !== snapshot.collectionPointOccurrenceId)) throw new CanonicalPaymentReportIncompatibilityError();
        try {
          const expectedPolicyFingerprint = f3PolicyFingerprint({
            organizationId: input.organizationId,
            leagueId: input.leagueId,
            activationId: policy.activationId,
            activationRevision: policy.activationRevision,
            activationSourceFingerprint: policy.activationSourceFingerprint,
            policyVersion: policy.policyVersion,
            collectionPoints: policy.collectionPoints,
            occurrences: (canonicalPolicyOccurrencesByPolicy.get(snapshot.policyId) ?? []).map((row) => ({ occurrenceId: row.occurrenceId, groupKey: row.groupKey, groupRole: row.groupRole as "normal" | "trigger" | "paired", pairedOccurrenceId: row.pairedOccurrenceId, collectionPoint: { occurrenceId: row.collectionPointOccurrenceId } })),
          });
          const expectedPlanFingerprint = f3SemanticPlanFingerprint({ organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerId: provenance.payerBowlerId, policyId: policy.id, policyVersion: policy.policyVersion, authorizationId: authorization.id, authorizationVersion: authorization.authorizationVersion, collectionPointOccurrenceId: snapshot.collectionPointOccurrenceId, planVersion: plan.version, items: planItems.map((item) => ({ obligationId: item.obligationId, occurrenceId: item.occurrenceId, bowlerId: item.bowlerId, collectionPointOccurrenceId: snapshot.collectionPointOccurrenceId, amountMinor: item.amountMinor, itemIndex: item.itemIndex })) });
          const expectedAuthorizationFingerprint = f3AuthorizationFingerprint({ organizationId: input.organizationId, leagueId: input.leagueId, payerBowlerId: authorization.payerBowlerId, authorizationVersion: authorization.authorizationVersion, policyId: authorization.policyId, policyVersion: authorization.policyVersion, coveredBowlerIds: authorization.coveredBowlerIds, acceptedPartnerIds: authorization.acceptedPartnerIds, paymentMethodFingerprint: authorization.paymentMethodFingerprint, locationId: authorization.locationId, collectionPointOccurrenceIds: authorization.collectionPointOccurrenceIds, timing: "at_collection_point", preauthorizationFingerprint: authorization.preauthorizationQuoteFingerprint, authorizedItems: authorization.authorizedItems });
          if (expectedPolicyFingerprint !== policy.policyFingerprint || expectedPlanFingerprint !== snapshot.planFingerprint || expectedAuthorizationFingerprint !== authorization.authorizationFingerprint) throw new Error("F3 fingerprint mismatch");
        } catch { throw new CanonicalPaymentReportIncompatibilityError(); }
        const policyOccurrences = canonicalPolicyOccurrencesByPolicy.get(snapshot.policyId) ?? [];
        const coveredOccurrenceIds = items.map((item) => String(item.occurrenceId));
        if (coveredOccurrenceIds.some((occurrenceId) => !policyOccurrences.some((row) => row.occurrenceId === occurrenceId && row.collectionPointOccurrenceId === snapshot.collectionPointOccurrenceId))) throw new CanonicalPaymentReportIncompatibilityError();
      }
    }

    // Select transaction parents first. The page is bounded at the database
    // boundary; child payments for the selected parents are then loaded in
    // full so operation conservation and combined-charge identity remain
    // exact. Canonical and unlinked parents share one deterministic page so
    // a response never silently contains multiple independent offsets.
    const offset = (page - 1) * limit;
    const [tenantCorruption] = await tx.execute(sql`
      SELECT EXISTS (
        SELECT 1
        FROM payments p
        LEFT JOIN bowlers b ON b.id = p.bowler_id
        WHERE p.league_id = ${input.leagueId}
          AND (b.id IS NULL OR b.organization_id IS DISTINCT FROM ${input.organizationId})
      ) AS present
    `).then((result) => result.rows as Array<{ present: boolean }>);
    if (tenantCorruption?.present) throw new CanonicalPaymentReportIncompatibilityError();
    const bowlerFilter = input.bowlerId === undefined
      ? sql`TRUE`
      : sql`p.bowler_id = ${input.bowlerId}`;
    const exactPaymentFilter = input.paymentId === undefined ? sql`TRUE` : sql`p.id = ${input.paymentId}`;
    const parentQuery = () => tx.execute(sql`
      WITH scoped AS (
        SELECT
          p.id,
          p.payment_operation_id,
          p.combined_charge_group_id,
          p.bowler_id,
          COALESCE(MIN(o.start_at), p.week_of) AS business_at,
          MIN(o.planned_ordinal) AS planned_order
        FROM payments p
        INNER JOIN bowlers b ON b.id = p.bowler_id
        LEFT JOIN payment_occurrence_allocations a
          ON a.payment_id = p.id
         AND a.organization_id = ${input.organizationId}
         AND a.league_id = ${input.leagueId}
         AND a.state = 'active'
        LEFT JOIN league_occurrences o
          ON o.id = a.occurrence_id
         AND o.organization_id = ${input.organizationId}
         AND o.league_id = ${input.leagueId}
        WHERE p.league_id = ${input.leagueId}
          AND b.organization_id = ${input.organizationId}
          AND ${exactPaymentFilter}
          AND (${bowlerFilter} OR EXISTS (
            SELECT 1 FROM payment_occurrence_allocations participant_a
            WHERE participant_a.payment_id = p.id
              AND participant_a.organization_id = ${input.organizationId}
              AND participant_a.league_id = ${input.leagueId}
              AND participant_a.bowler_id = ${input.bowlerId ?? -1}
          ))
        GROUP BY p.id, p.payment_operation_id, p.combined_charge_group_id, p.bowler_id, p.week_of
      ), parents AS (
        SELECT
          CASE
            WHEN payment_operation_id IS NOT NULL THEN 'operation:' || payment_operation_id::text
            WHEN combined_charge_group_id IS NOT NULL THEN 'combined:' || combined_charge_group_id::text
            ELSE 'payment:' || id::text
          END AS parent_key,
          MIN(business_at) AS business_at,
          MIN(bowler_id) AS bowler_id,
          MIN(planned_order) AS planned_order
        FROM scoped
        GROUP BY 1
      ), operation_parents AS (
        SELECT
          'operation:' || op.id::text AS parent_key,
          COALESCE(cs.trigger_start_at, osa.business_at, legacy_osa.business_at, op.created_at) AS business_at,
          COALESCE(cs.payer_bowler_id, osa.bowler_id, legacy_osa.bowler_id, 0) AS bowler_id,
          COALESCE(trigger_occurrence.planned_ordinal, osa.planned_order, 2147483647) AS planned_order
        FROM payment_operations op
        LEFT JOIN canonical_autopay_execution_snapshots cs ON cs.operation_id = op.id
          AND cs.organization_id = ${input.organizationId} AND cs.league_id = ${input.leagueId}
        LEFT JOIN league_occurrences trigger_occurrence ON trigger_occurrence.id = COALESCE(cs.trigger_occurrence_id, op.trigger_occurrence_id)
          AND trigger_occurrence.organization_id = ${input.organizationId} AND trigger_occurrence.league_id = ${input.leagueId}
        LEFT JOIN LATERAL (
          SELECT MIN(o.start_at) AS business_at, MIN(sa.bowler_id) AS bowler_id, MIN(o.planned_ordinal) AS planned_order
          FROM payment_operation_occurrence_snapshot_allocations sa
          LEFT JOIN league_occurrences o ON o.id = sa.occurrence_id
            AND o.organization_id = ${input.organizationId} AND o.league_id = ${input.leagueId}
          WHERE sa.operation_id = op.id AND sa.organization_id = ${input.organizationId} AND sa.league_id = ${input.leagueId}
        ) osa ON TRUE
        LEFT JOIN LATERAL (
          SELECT MIN(legacy_date) AS business_at, MIN(legacy_bowler_id) AS bowler_id
          FROM (
            SELECT s.created_at AS legacy_date, a.bowler_id AS legacy_bowler_id
            FROM scheduled_payment_operation_snapshots s
            INNER JOIN scheduled_payment_operation_allocations a ON a.operation_id = s.operation_id
            WHERE s.operation_id = op.id AND s.league_id = ${input.leagueId}
            UNION ALL
            SELECT i.week_of AS legacy_date, a.bowler_id AS legacy_bowler_id
            FROM interactive_payment_operation_snapshots i
            INNER JOIN interactive_payment_operation_allocations a ON a.operation_id = i.operation_id
            WHERE i.operation_id = op.id AND i.league_id = ${input.leagueId}
          ) legacy_rows
        ) legacy_osa ON TRUE
        WHERE op.organization_id = ${input.organizationId}
          AND (${input.paymentId === undefined ? sql`TRUE` : sql`EXISTS (SELECT 1 FROM payments exact_payment WHERE exact_payment.id = ${input.paymentId} AND exact_payment.payment_operation_id = op.id)`})
          AND (op.league_id = ${input.leagueId} OR EXISTS (SELECT 1 FROM payment_operation_occurrence_snapshots scoped_os WHERE scoped_os.operation_id = op.id AND scoped_os.organization_id = ${input.organizationId} AND scoped_os.league_id = ${input.leagueId}) OR EXISTS (SELECT 1 FROM scheduled_payment_operation_snapshots scoped_ss WHERE scoped_ss.operation_id = op.id AND scoped_ss.league_id = ${input.leagueId}) OR EXISTS (SELECT 1 FROM interactive_payment_operation_snapshots scoped_is WHERE scoped_is.operation_id = op.id AND scoped_is.league_id = ${input.leagueId}))
          AND op.status IN ('pending','leased','provider_unknown','retry_scheduled','action_required','reconciliation_required')
          AND NOT EXISTS (SELECT 1 FROM payments op_payment WHERE op_payment.payment_operation_id = op.id)
          AND (${input.bowlerId === undefined ? sql`TRUE` : sql`EXISTS (SELECT 1 FROM payment_operation_occurrence_snapshot_allocations participant_sa WHERE participant_sa.operation_id = op.id AND participant_sa.organization_id = ${input.organizationId} AND participant_sa.league_id = ${input.leagueId} AND participant_sa.bowler_id = ${input.bowlerId}) OR cs.items @> jsonb_build_array(jsonb_build_object('bowlerId', ${input.bowlerId}::integer)) OR EXISTS (SELECT 1 FROM scheduled_payment_operation_allocations lsa INNER JOIN scheduled_payment_operation_snapshots lss ON lss.operation_id = lsa.operation_id AND lss.league_id = ${input.leagueId} WHERE lsa.operation_id = op.id AND lsa.bowler_id = ${input.bowlerId}) OR EXISTS (SELECT 1 FROM interactive_payment_operation_allocations lia INNER JOIN interactive_payment_operation_snapshots lis ON lis.operation_id = lia.operation_id AND lis.league_id = ${input.leagueId} WHERE lia.operation_id = op.id AND lia.bowler_id = ${input.bowlerId})`})
      )
      SELECT parent_key
      FROM (SELECT * FROM parents UNION ALL SELECT * FROM operation_parents) all_parents
      ORDER BY business_at ASC, bowler_id ASC, planned_order ASC NULLS LAST, parent_key ASC
      LIMIT ${limit} OFFSET ${offset}
    `);
    const parentRows = await parentQuery();
    const parentKeys = parentRows.rows
      .map((row) => String((row as { parent_key: string }).parent_key));
    const scopedBowlerPredicate = input.bowlerId === undefined ? sql`TRUE` : sql`p.bowler_id = ${input.bowlerId} OR EXISTS (
      SELECT 1 FROM users scoped_paid_by
      WHERE scoped_paid_by.id = p.paid_by_user_id
        AND scoped_paid_by.organization_id = ${input.organizationId}
        AND scoped_paid_by.bowler_id = ${input.bowlerId}
    )`;
    const scopedOperationPredicate = input.bowlerId === undefined
      ? sql`TRUE`
      : sql`EXISTS (SELECT 1 FROM payment_operation_occurrence_snapshot_allocations scope_sa WHERE scope_sa.operation_id = dop.id AND scope_sa.organization_id = ${input.organizationId} AND scope_sa.league_id = ${input.leagueId} AND scope_sa.bowler_id = ${input.bowlerId}) OR EXISTS (SELECT 1 FROM canonical_autopay_execution_snapshots scope_cs WHERE scope_cs.operation_id = dop.id AND scope_cs.organization_id = ${input.organizationId} AND scope_cs.league_id = ${input.leagueId} AND scope_cs.items @> jsonb_build_array(jsonb_build_object('bowlerId', ${input.bowlerId}::integer))) OR EXISTS (SELECT 1 FROM scheduled_payment_operation_allocations scope_lsa INNER JOIN scheduled_payment_operation_snapshots scope_lss ON scope_lss.operation_id = scope_lsa.operation_id AND scope_lss.league_id = ${input.leagueId} WHERE scope_lsa.operation_id = dop.id AND scope_lsa.bowler_id = ${input.bowlerId}) OR EXISTS (SELECT 1 FROM interactive_payment_operation_allocations scope_lia INNER JOIN interactive_payment_operation_snapshots scope_lis ON scope_lis.operation_id = scope_lia.operation_id AND scope_lis.league_id = ${input.leagueId} WHERE scope_lia.operation_id = dop.id AND scope_lia.bowler_id = ${input.bowlerId})`;
    // A zero-payment operation is still one transaction parent, but a
    // bowler-scoped report may expose only that participant's immutable
    // snapshot allocation. Never charge the entire combined amount to a
    // partner merely because the operation has no payment row yet.
    const unresolvedAmountExpression = input.bowlerId === undefined
      ? sql`op.amount_minor`
      : sql`CASE WHEN EXISTS (SELECT 1 FROM canonical_autopay_execution_snapshots payer_f4 WHERE payer_f4.operation_id = op.id AND payer_f4.organization_id = ${input.organizationId} AND payer_f4.league_id = ${input.leagueId} AND payer_f4.payer_bowler_id = ${input.bowlerId}) THEN op.amount_minor ELSE COALESCE(
          (SELECT SUM(sa.amount_minor) FROM payment_operation_occurrence_snapshot_allocations sa
            WHERE sa.operation_id = op.id AND sa.organization_id = ${input.organizationId}
              AND sa.league_id = ${input.leagueId} AND sa.bowler_id = ${input.bowlerId}),
          (SELECT SUM((item->>'amountMinor')::integer) FROM canonical_autopay_execution_snapshots f4
            CROSS JOIN LATERAL jsonb_array_elements(f4.items) item
            WHERE f4.operation_id = op.id AND f4.organization_id = ${input.organizationId}
              AND f4.league_id = ${input.leagueId}
              AND (item->>'bowlerId')::integer = ${input.bowlerId}),
          (SELECT SUM(sa.amount_minor) FROM scheduled_payment_operation_allocations sa
            INNER JOIN scheduled_payment_operation_snapshots ss ON ss.operation_id = sa.operation_id
              AND ss.league_id = ${input.leagueId}
            WHERE sa.operation_id = op.id AND sa.bowler_id = ${input.bowlerId}),
          (SELECT SUM(ia.amount_minor) FROM interactive_payment_operation_allocations ia
            INNER JOIN interactive_payment_operation_snapshots isnap ON isnap.operation_id = ia.operation_id
              AND isnap.league_id = ${input.leagueId}
            WHERE ia.operation_id = op.id AND ia.bowler_id = ${input.bowlerId}),
          0) END`;
    const viewerIsCanonicalPayer = input.bowlerId === undefined
      ? sql`TRUE`
      : sql`EXISTS (SELECT 1 FROM users viewer_payer WHERE viewer_payer.id = p.paid_by_user_id AND viewer_payer.organization_id = ${input.organizationId} AND viewer_payer.bowler_id = ${input.bowlerId}) OR EXISTS (SELECT 1 FROM canonical_autopay_execution_snapshots viewer_cs WHERE viewer_cs.operation_id = p.payment_operation_id AND viewer_cs.organization_id = ${input.organizationId} AND viewer_cs.league_id = ${input.leagueId} AND viewer_cs.payer_bowler_id = ${input.bowlerId})`;
    const authorizedPaymentAmount = input.bowlerId === undefined
      ? sql`p.amount`
      : sql`CASE WHEN (${viewerIsCanonicalPayer}) OR (
          p.payment_operation_id IS NULL AND p.bowler_id = ${input.bowlerId}
          AND NOT EXISTS (
            SELECT 1 FROM payment_occurrence_allocations shared_a
            WHERE shared_a.payment_id = p.id
              AND shared_a.organization_id = ${input.organizationId}
              AND shared_a.league_id = ${input.leagueId}
              AND shared_a.state = 'active'
              AND shared_a.bowler_id <> ${input.bowlerId}
          )
        ) THEN p.amount ELSE COALESCE((SELECT SUM(own_a.amount_minor) FROM payment_occurrence_allocations own_a WHERE own_a.payment_id = p.id AND own_a.organization_id = ${input.organizationId} AND own_a.league_id = ${input.leagueId} AND own_a.bowler_id = ${input.bowlerId} AND own_a.state = 'active'), 0) END`;
    const authorizedAllocationPredicate = input.bowlerId === undefined
      ? sql`TRUE`
      : sql`(${viewerIsCanonicalPayer} OR a.bowler_id = ${input.bowlerId})`;
    const aggregateResult = await tx.execute(sql`
      WITH scoped_payments AS (
        SELECT p.*
        FROM payments p
        INNER JOIN bowlers b ON b.id = p.bowler_id AND b.organization_id = ${input.organizationId}
        WHERE p.league_id = ${input.leagueId}
          AND (${scopedBowlerPredicate} OR EXISTS (
            SELECT 1 FROM payment_occurrence_allocations participant_a
            WHERE participant_a.payment_id = p.id
              AND participant_a.organization_id = ${input.organizationId}
              AND participant_a.league_id = ${input.leagueId}
              AND participant_a.bowler_id = ${input.bowlerId ?? -1}
          ))
      ), parent_totals AS (
        SELECT COUNT(DISTINCT parent_key)::integer AS total_transactions
        FROM (
          SELECT CASE
            WHEN payment_operation_id IS NOT NULL THEN 'operation:' || payment_operation_id::text
            WHEN combined_charge_group_id IS NOT NULL THEN 'combined:' || combined_charge_group_id::text
            ELSE 'payment:' || id::text
          END AS parent_key
          FROM scoped_payments
          GROUP BY 1
          UNION ALL
          SELECT 'operation:' || op.id::text AS parent_key
          FROM payment_operations op
          WHERE op.organization_id = ${input.organizationId}
            AND (op.league_id = ${input.leagueId}
              OR EXISTS (SELECT 1 FROM payment_operation_occurrence_snapshots po_scope WHERE po_scope.operation_id = op.id AND po_scope.organization_id = ${input.organizationId} AND po_scope.league_id = ${input.leagueId})
              OR EXISTS (SELECT 1 FROM scheduled_payment_operation_snapshots ps WHERE ps.operation_id = op.id AND ps.league_id = ${input.leagueId})
              OR EXISTS (SELECT 1 FROM interactive_payment_operation_snapshots pi WHERE pi.operation_id = op.id AND pi.league_id = ${input.leagueId}))
            AND op.status IN ('pending','leased','provider_unknown','retry_scheduled','action_required','reconciliation_required')
            AND NOT EXISTS (SELECT 1 FROM payments p2 WHERE p2.payment_operation_id = op.id)
            AND (${input.bowlerId === undefined ? sql`TRUE` : sql`EXISTS (SELECT 1 FROM payment_operation_occurrence_snapshot_allocations sa WHERE sa.operation_id = op.id AND sa.organization_id = ${input.organizationId} AND sa.league_id = ${input.leagueId} AND sa.bowler_id = ${input.bowlerId}) OR EXISTS (SELECT 1 FROM canonical_autopay_execution_snapshots cs WHERE cs.operation_id = op.id AND cs.organization_id = ${input.organizationId} AND cs.league_id = ${input.leagueId} AND cs.items @> jsonb_build_array(jsonb_build_object('bowlerId', ${input.bowlerId}::integer))) OR EXISTS (SELECT 1 FROM scheduled_payment_operation_allocations sa INNER JOIN scheduled_payment_operation_snapshots ss ON ss.operation_id = sa.operation_id AND ss.league_id = ${input.leagueId} WHERE sa.operation_id = op.id AND sa.bowler_id = ${input.bowlerId}) OR EXISTS (SELECT 1 FROM interactive_payment_operation_allocations ia INNER JOIN interactive_payment_operation_snapshots isnap ON isnap.operation_id = ia.operation_id AND isnap.league_id = ${input.leagueId} WHERE ia.operation_id = op.id AND ia.bowler_id = ${input.bowlerId})`})
        ) grouped_parents
      )
      SELECT
        (SELECT COUNT(*)::integer FROM scoped_payments)
          + COALESCE((SELECT COUNT(*) FROM payment_operation_occurrence_snapshot_allocations sa
            INNER JOIN payment_operations sop ON sop.id = sa.operation_id AND sop.organization_id = ${input.organizationId}
            WHERE (sop.league_id = ${input.leagueId} OR EXISTS (SELECT 1 FROM payment_operation_occurrence_snapshots ss_scope WHERE ss_scope.operation_id = sop.id AND ss_scope.organization_id = ${input.organizationId} AND ss_scope.league_id = ${input.leagueId}))
              AND sop.status IN ('pending','leased','provider_unknown','retry_scheduled','action_required','reconciliation_required')
              AND NOT EXISTS (SELECT 1 FROM payments sp WHERE sp.payment_operation_id = sop.id)
              AND (${input.bowlerId === undefined ? sql`TRUE` : sql`sa.bowler_id = ${input.bowlerId}`})), 0)
          + COALESCE((SELECT COUNT(*) FROM (
              SELECT a.bowler_id, a.operation_id FROM scheduled_payment_operation_allocations a INNER JOIN scheduled_payment_operation_snapshots s ON s.operation_id = a.operation_id AND s.league_id = ${input.leagueId}
              INNER JOIN payment_operations lop ON lop.id = a.operation_id AND lop.organization_id = ${input.organizationId}
              WHERE NOT EXISTS (SELECT 1 FROM payments lp WHERE lp.payment_operation_id = a.operation_id)
              UNION ALL
              SELECT a.bowler_id, a.operation_id FROM interactive_payment_operation_allocations a INNER JOIN interactive_payment_operation_snapshots s ON s.operation_id = a.operation_id AND s.league_id = ${input.leagueId}
              INNER JOIN payment_operations lop ON lop.id = a.operation_id AND lop.organization_id = ${input.organizationId}
              WHERE NOT EXISTS (SELECT 1 FROM payments lp WHERE lp.payment_operation_id = a.operation_id)
            ) legacy_participants WHERE (${input.bowlerId === undefined ? sql`TRUE` : sql`legacy_participants.bowler_id = ${input.bowlerId}`})), 0)::integer AS total_rows,
        (SELECT total_transactions FROM parent_totals) AS total_transactions,
        COALESCE((SELECT SUM(${authorizedPaymentAmount}) FROM scoped_payments p WHERE p.status = 'paid' AND ${activation ? sql`EXISTS (SELECT 1 FROM payment_occurrence_allocations ca WHERE ca.payment_id = p.id AND ca.organization_id = ${input.organizationId} AND ca.league_id = ${input.leagueId})` : sql`TRUE`} AND (p.payment_operation_id IS NULL OR NOT EXISTS (SELECT 1 FROM payment_operations op WHERE op.id = p.payment_operation_id AND op.status IN ('pending','leased','provider_unknown','retry_scheduled','action_required','reconciliation_required'))) AND NOT EXISTS (SELECT 1 FROM payment_disputes pd WHERE pd.payment_operation_id = p.payment_operation_id)), 0)::integer AS gross_paid,
        COALESCE((SELECT SUM(a.amount_minor) FROM payment_occurrence_allocations a INNER JOIN scoped_payments p ON p.id = a.payment_id WHERE a.organization_id = ${input.organizationId} AND a.league_id = ${input.leagueId} AND a.state = 'active' AND ${authorizedAllocationPredicate}), 0)::integer AS allocated,
        COALESCE((SELECT SUM(${authorizedPaymentAmount}) FROM scoped_payments p WHERE p.status = 'refunded' AND ${activation ? sql`EXISTS (SELECT 1 FROM payment_occurrence_allocations ca WHERE ca.payment_id = p.id AND ca.organization_id = ${input.organizationId} AND ca.league_id = ${input.leagueId})` : sql`TRUE`} AND (${input.bowlerId === undefined ? sql`TRUE` : sql`EXISTS (SELECT 1 FROM users refund_payer WHERE refund_payer.id = p.paid_by_user_id AND refund_payer.organization_id = ${input.organizationId} AND refund_payer.bowler_id = ${input.bowlerId}) OR EXISTS (SELECT 1 FROM canonical_autopay_execution_snapshots refund_payer_f4 WHERE refund_payer_f4.operation_id = p.payment_operation_id AND refund_payer_f4.organization_id = ${input.organizationId} AND refund_payer_f4.league_id = ${input.leagueId} AND refund_payer_f4.payer_bowler_id = ${input.bowlerId})`}) ), 0)::integer AS refunded,
        COALESCE((SELECT SUM(CASE WHEN ${input.bowlerId === undefined ? sql`TRUE` : sql`EXISTS (SELECT 1 FROM users disputed_payer WHERE disputed_payer.id = p.paid_by_user_id AND disputed_payer.organization_id = ${input.organizationId} AND disputed_payer.bowler_id = ${input.bowlerId})`} THEN p.amount ELSE 0 END) FROM scoped_payments p WHERE p.status = 'disputed' AND p.payment_operation_id IS NULL), 0)::integer
          + COALESCE((SELECT SUM(pd.amount_minor) FROM payment_disputes pd INNER JOIN payment_operations dop ON dop.id = pd.payment_operation_id AND dop.organization_id = ${input.organizationId} AND (dop.league_id = ${input.leagueId} OR EXISTS (SELECT 1 FROM payment_operation_occurrence_snapshots dscope WHERE dscope.operation_id = dop.id AND dscope.organization_id = ${input.organizationId} AND dscope.league_id = ${input.leagueId}) OR EXISTS (SELECT 1 FROM scheduled_payment_operation_snapshots dlegacy WHERE dlegacy.operation_id = dop.id AND dlegacy.league_id = ${input.leagueId}) OR EXISTS (SELECT 1 FROM interactive_payment_operation_snapshots ilegacy WHERE ilegacy.operation_id = dop.id AND ilegacy.league_id = ${input.leagueId})) WHERE pd.organization_id = ${input.organizationId} AND (${scopedOperationPredicate}) AND (${input.bowlerId === undefined ? sql`TRUE` : sql`EXISTS (SELECT 1 FROM users payer_duser INNER JOIN payments payer_dpayment ON payer_dpayment.paid_by_user_id = payer_duser.id AND payer_dpayment.payment_operation_id = dop.id WHERE payer_duser.organization_id = ${input.organizationId} AND payer_duser.bowler_id = ${input.bowlerId}) OR EXISTS (SELECT 1 FROM canonical_autopay_execution_snapshots payer_dscope WHERE payer_dscope.operation_id = dop.id AND payer_dscope.organization_id = ${input.organizationId} AND payer_dscope.league_id = ${input.leagueId} AND payer_dscope.payer_bowler_id = ${input.bowlerId})`})), 0)::integer AS disputed,
        COALESCE((SELECT SUM(${unresolvedAmountExpression}) FROM payment_operations op WHERE op.organization_id = ${input.organizationId} AND (op.league_id = ${input.leagueId} OR EXISTS (SELECT 1 FROM payment_operation_occurrence_snapshots uos WHERE uos.operation_id = op.id AND uos.organization_id = ${input.organizationId} AND uos.league_id = ${input.leagueId}) OR EXISTS (SELECT 1 FROM scheduled_payment_operation_snapshots uss WHERE uss.operation_id = op.id AND uss.league_id = ${input.leagueId}) OR EXISTS (SELECT 1 FROM interactive_payment_operation_snapshots uis WHERE uis.operation_id = op.id AND uis.league_id = ${input.leagueId})) AND op.status IN ('pending','leased','provider_unknown','retry_scheduled','action_required','reconciliation_required') AND NOT EXISTS (SELECT 1 FROM payments unresolved_payment WHERE unresolved_payment.payment_operation_id = op.id) AND (${input.bowlerId === undefined ? sql`TRUE` : sql`EXISTS (SELECT 1 FROM payment_operation_occurrence_snapshot_allocations sb WHERE sb.operation_id = op.id AND sb.organization_id = ${input.organizationId} AND sb.league_id = ${input.leagueId} AND sb.bowler_id = ${input.bowlerId}) OR EXISTS (SELECT 1 FROM canonical_autopay_execution_snapshots usf4 WHERE usf4.operation_id = op.id AND usf4.organization_id = ${input.organizationId} AND usf4.league_id = ${input.leagueId} AND usf4.items @> jsonb_build_array(jsonb_build_object('bowlerId', ${input.bowlerId}::integer))) OR EXISTS (SELECT 1 FROM scheduled_payment_operation_allocations usb INNER JOIN scheduled_payment_operation_snapshots usbs ON usbs.operation_id = usb.operation_id AND usbs.league_id = ${input.leagueId} WHERE usb.operation_id = op.id AND usb.bowler_id = ${input.bowlerId}) OR EXISTS (SELECT 1 FROM interactive_payment_operation_allocations uib INNER JOIN interactive_payment_operation_snapshots uibs ON uibs.operation_id = op.id AND uibs.league_id = ${input.leagueId} WHERE uib.operation_id = op.id AND uib.bowler_id = ${input.bowlerId})` })), 0)::integer AS unresolved,
        COALESCE((SELECT SUM(${authorizedPaymentAmount}) FROM scoped_payments p WHERE p.status = 'paid' AND NOT EXISTS (SELECT 1 FROM payment_occurrence_allocations a WHERE a.payment_id = p.id AND a.organization_id = ${input.organizationId} AND a.league_id = ${input.leagueId})), 0)::integer AS unallocated_legacy,
        COALESCE((SELECT SUM(${authorizedPaymentAmount}) FROM scoped_payments p WHERE (p.status NOT IN ('paid','pending','refunded','disputed') OR (p.status = 'disputed' AND p.payment_operation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM payment_disputes legacy_pd WHERE legacy_pd.payment_operation_id = p.payment_operation_id))) AND NOT EXISTS (SELECT 1 FROM payment_operations rop WHERE rop.id = p.payment_operation_id AND rop.status IN ('action_required','provider_unknown','reconciliation_required'))), 0)::integer AS review_required,
        (SELECT COUNT(*)::integer FROM scoped_payments p WHERE NOT EXISTS (SELECT 1 FROM payment_occurrence_allocations a WHERE a.payment_id = p.id AND a.organization_id = ${input.organizationId} AND a.league_id = ${input.leagueId}))
          + (SELECT COUNT(*)::integer FROM payment_operations lop
             WHERE lop.organization_id = ${input.organizationId} AND (lop.league_id = ${input.leagueId} OR EXISTS (SELECT 1 FROM payment_operation_occurrence_snapshots lscope_o WHERE lscope_o.operation_id = lop.id AND lscope_o.organization_id = ${input.organizationId} AND lscope_o.league_id = ${input.leagueId}) OR EXISTS (SELECT 1 FROM scheduled_payment_operation_snapshots lscope_s WHERE lscope_s.operation_id = lop.id AND lscope_s.league_id = ${input.leagueId}) OR EXISTS (SELECT 1 FROM interactive_payment_operation_snapshots lscope_i WHERE lscope_i.operation_id = lop.id AND lscope_i.league_id = ${input.leagueId}))
               AND lop.operation_type IN ('scheduled_charge','interactive_charge')
               AND lop.status IN ('pending','leased','provider_unknown','retry_scheduled','action_required','reconciliation_required')
               AND NOT EXISTS (SELECT 1 FROM payments lp WHERE lp.payment_operation_id = lop.id)
               AND (EXISTS (SELECT 1 FROM scheduled_payment_operation_snapshots ls WHERE ls.operation_id = lop.id)
                 OR EXISTS (SELECT 1 FROM interactive_payment_operation_snapshots li WHERE li.operation_id = lop.id))) AS unlinked_count
    `);
    const aggregate = aggregateResult.rows[0] as Record<string, unknown> | undefined;
    const aggregateNumber = (key: string): number => Number(aggregate?.[key] ?? 0);
    const [operationIntegrity] = await tx.execute(sql`
      SELECT EXISTS (
        SELECT 1
        FROM payment_operations op
        LEFT JOIN payments p ON p.payment_operation_id = op.id
        WHERE op.organization_id = ${input.organizationId}
          AND (op.league_id = ${input.leagueId} OR EXISTS (SELECT 1 FROM payment_operation_occurrence_snapshots oscope WHERE oscope.operation_id = op.id AND oscope.organization_id = ${input.organizationId} AND oscope.league_id = ${input.leagueId}) OR EXISTS (SELECT 1 FROM scheduled_payment_operation_snapshots legacy_scope WHERE legacy_scope.operation_id = op.id AND legacy_scope.league_id = ${input.leagueId}) OR EXISTS (SELECT 1 FROM interactive_payment_operation_snapshots interactive_scope WHERE interactive_scope.operation_id = op.id AND interactive_scope.league_id = ${input.leagueId}))
          AND EXISTS (SELECT 1 FROM payments linked_p WHERE linked_p.payment_operation_id = op.id)
        GROUP BY op.id, op.amount_minor
        HAVING COALESCE(SUM(p.amount), 0) <> op.amount_minor
      ) AS present
    `).then((result) => result.rows as Array<{ present: boolean }>);
    if (operationIntegrity?.present) throw new CanonicalPaymentReportIncompatibilityError();
    const [globalPaymentIntegrity] = await tx.execute(sql`
      SELECT EXISTS (
        SELECT 1
        FROM payments gp
        LEFT JOIN bowlers gb ON gb.id = gp.bowler_id
        LEFT JOIN payment_occurrence_allocations ga ON ga.payment_id = gp.id
          AND ga.organization_id = ${input.organizationId} AND ga.league_id = ${input.leagueId}
        WHERE gp.league_id = ${input.leagueId}
          AND (gb.id IS NULL OR gb.organization_id <> ${input.organizationId})
        UNION ALL
        SELECT 1
        FROM payments gp
        INNER JOIN bowlers gb ON gb.id = gp.bowler_id AND gb.organization_id = ${input.organizationId}
        INNER JOIN payment_occurrence_allocations ga ON ga.payment_id = gp.id
          AND ga.organization_id = ${input.organizationId} AND ga.league_id = ${input.leagueId}
        WHERE gp.league_id = ${input.leagueId}
        GROUP BY gp.id, gp.amount
        HAVING COALESCE(SUM(ga.amount_minor) FILTER (WHERE ga.state = 'active'), 0) <> gp.amount
      ) AS present
    `).then((result) => result.rows as Array<{ present: boolean }>) as [{ present: boolean } | undefined, ...unknown[]];
    if (globalPaymentIntegrity?.present) throw new CanonicalPaymentReportIncompatibilityError();
    const [globalOperationEvidence] = await tx.execute(sql`
      SELECT EXISTS (
        SELECT 1
        FROM payment_operations op
        LEFT JOIN canonical_autopay_execution_snapshots cs
          ON cs.operation_id = op.id
         AND cs.organization_id = ${input.organizationId}
         AND cs.league_id = ${input.leagueId}
        WHERE op.organization_id = ${input.organizationId}
          AND (op.league_id = ${input.leagueId} OR EXISTS (SELECT 1 FROM payment_operation_occurrence_snapshots canonical_scope WHERE canonical_scope.operation_id = op.id AND canonical_scope.organization_id = ${input.organizationId} AND canonical_scope.league_id = ${input.leagueId}))
          AND op.operation_type = 'canonical_autopay_charge'
          AND (cs.operation_id IS NULL OR cs.amount_minor IS DISTINCT FROM op.amount_minor OR cs.currency IS DISTINCT FROM op.currency OR cs.trigger_occurrence_id IS DISTINCT FROM op.trigger_occurrence_id)
        UNION ALL
        SELECT 1
        FROM payment_operations op
        LEFT JOIN payment_operation_occurrence_snapshots os
          ON os.operation_id = op.id
         AND os.organization_id = ${input.organizationId}
         AND os.league_id = ${input.leagueId}
        WHERE op.organization_id = ${input.organizationId}
          AND (op.league_id = ${input.leagueId} OR EXISTS (SELECT 1 FROM payment_operation_occurrence_snapshots oscope WHERE oscope.operation_id = op.id AND oscope.organization_id = ${input.organizationId} AND oscope.league_id = ${input.leagueId}) OR EXISTS (SELECT 1 FROM scheduled_payment_operation_snapshots legacy_scope WHERE legacy_scope.operation_id = op.id AND legacy_scope.league_id = ${input.leagueId}) OR EXISTS (SELECT 1 FROM interactive_payment_operation_snapshots interactive_scope WHERE interactive_scope.operation_id = op.id AND interactive_scope.league_id = ${input.leagueId}))
          AND op.operation_type IN ('scheduled_charge', 'interactive_charge')
          AND os.operation_id IS NOT NULL
          AND (os.amount_minor IS DISTINCT FROM op.amount_minor OR os.currency IS DISTINCT FROM op.currency)
      ) AS present
    `).then((result) => result.rows as Array<{ present: boolean }>);
    if (globalOperationEvidence?.present) throw new CanonicalPaymentReportIncompatibilityError();
    const [globalRevisionIntegrity] = await tx.execute(sql`
      SELECT EXISTS (
        SELECT 1
        FROM bowler_occurrence_obligations o
        WHERE o.organization_id = ${input.organizationId}
          AND o.league_id = ${input.leagueId}
          AND (SELECT COUNT(*) FROM bowler_occurrence_obligation_revisions r WHERE r.organization_id = o.organization_id AND r.league_id = o.league_id AND r.obligation_id = o.id) <> o.current_revision
        UNION ALL
        SELECT 1
        FROM payment_occurrence_allocations a
          WHERE a.organization_id = ${input.organizationId}
          AND a.league_id = ${input.leagueId}
          AND (SELECT COUNT(*) FROM payment_occurrence_allocation_revisions r WHERE r.organization_id = a.organization_id AND r.league_id = a.league_id AND r.allocation_id = a.id) <> a.current_revision
        UNION ALL
        SELECT 1
        FROM bowler_occurrence_obligation_revisions r
        WHERE r.organization_id = ${input.organizationId} AND r.league_id = ${input.leagueId}
          AND (r.snapshot_schema_version <> 1
            OR (r.revision_number = 1 AND r.before_snapshot IS NOT NULL)
            OR (r.revision_number > 1 AND (r.before_snapshot IS NULL
              OR r.before_snapshot->>'state' IS NULL
              OR r.before_snapshot->>'amountMinor' !~ '^-?[0-9]+$'
              OR NOT (r.before_snapshot ? 'currency')
              OR NOT (r.before_snapshot ? 'billingTermId')
              OR NOT (r.before_snapshot ? 'billingTermVersion')
              OR NOT (r.before_snapshot ? 'dueAt')
              OR NOT (r.before_snapshot ? 'pastDueAt')))
            OR r.after_snapshot->>'state' IS NULL
            OR r.after_snapshot->>'amountMinor' !~ '^-?[0-9]+$'
            OR r.after_snapshot->>'currency' IS NULL
            OR NOT (r.after_snapshot ? 'billingTermId')
            OR NOT (r.after_snapshot ? 'billingTermVersion')
            OR NOT (r.after_snapshot ? 'dueAt')
            OR NOT (r.after_snapshot ? 'pastDueAt')
            OR EXISTS (SELECT 1 FROM bowler_occurrence_obligation_revisions prior WHERE prior.organization_id = r.organization_id AND prior.league_id = r.league_id AND prior.obligation_id = r.obligation_id AND prior.revision_number = r.revision_number - 1 AND (r.before_snapshot->>'state' IS DISTINCT FROM prior.after_snapshot->>'state' OR CASE WHEN r.before_snapshot->>'amountMinor' ~ '^-?[0-9]+$' THEN (r.before_snapshot->>'amountMinor')::integer END IS DISTINCT FROM CASE WHEN prior.after_snapshot->>'amountMinor' ~ '^-?[0-9]+$' THEN (prior.after_snapshot->>'amountMinor')::integer END OR r.before_snapshot->>'currency' IS DISTINCT FROM prior.after_snapshot->>'currency' OR r.before_snapshot->>'billingTermId' IS DISTINCT FROM prior.after_snapshot->>'billingTermId' OR r.before_snapshot->>'billingTermVersion' IS DISTINCT FROM prior.after_snapshot->>'billingTermVersion' OR CASE WHEN r.before_snapshot->>'dueAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T]' THEN (r.before_snapshot->>'dueAt')::timestamptz END IS DISTINCT FROM CASE WHEN prior.after_snapshot->>'dueAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T]' THEN (prior.after_snapshot->>'dueAt')::timestamptz END OR CASE WHEN r.before_snapshot->>'pastDueAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T]' THEN (r.before_snapshot->>'pastDueAt')::timestamptz END IS DISTINCT FROM CASE WHEN prior.after_snapshot->>'pastDueAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T]' THEN (prior.after_snapshot->>'pastDueAt')::timestamptz END)))
        UNION ALL
        SELECT 1
        FROM payment_occurrence_allocation_revisions r
        WHERE r.organization_id = ${input.organizationId} AND r.league_id = ${input.leagueId}
          AND (r.snapshot_schema_version <> 1
            OR (r.revision_number = 1 AND r.before_snapshot IS NOT NULL)
            OR (r.revision_number > 1 AND (r.before_snapshot IS NULL
              OR r.before_snapshot->>'state' IS NULL
              OR r.before_snapshot->>'amountMinor' !~ '^-?[0-9]+$'
              OR NOT (r.before_snapshot ? 'currency')
              OR NOT (r.before_snapshot ? 'paymentId')
              OR NOT (r.before_snapshot ? 'obligationId')
              OR NOT (r.before_snapshot ? 'occurrenceId')
              OR r.before_snapshot->>'bowlerId' !~ '^[0-9]+$'))
            OR r.after_snapshot->>'state' IS NULL
            OR r.after_snapshot->>'amountMinor' !~ '^-?[0-9]+$'
            OR r.after_snapshot->>'currency' IS NULL
            OR r.after_snapshot->>'paymentId' IS NULL
            OR r.after_snapshot->>'obligationId' IS NULL
            OR r.after_snapshot->>'occurrenceId' IS NULL
            OR r.after_snapshot->>'bowlerId' !~ '^[0-9]+$'
            OR EXISTS (SELECT 1 FROM payment_occurrence_allocation_revisions prior WHERE prior.organization_id = r.organization_id AND prior.league_id = r.league_id AND prior.allocation_id = r.allocation_id AND prior.revision_number = r.revision_number - 1 AND (r.before_snapshot->>'state' IS DISTINCT FROM prior.after_snapshot->>'state' OR CASE WHEN r.before_snapshot->>'amountMinor' ~ '^-?[0-9]+$' THEN (r.before_snapshot->>'amountMinor')::integer END IS DISTINCT FROM CASE WHEN prior.after_snapshot->>'amountMinor' ~ '^-?[0-9]+$' THEN (prior.after_snapshot->>'amountMinor')::integer END OR r.before_snapshot->>'currency' IS DISTINCT FROM prior.after_snapshot->>'currency' OR r.before_snapshot->>'paymentId' IS DISTINCT FROM prior.after_snapshot->>'paymentId' OR r.before_snapshot->>'obligationId' IS DISTINCT FROM prior.after_snapshot->>'obligationId' OR r.before_snapshot->>'occurrenceId' IS DISTINCT FROM prior.after_snapshot->>'occurrenceId' OR r.before_snapshot->>'bowlerId' IS DISTINCT FROM prior.after_snapshot->>'bowlerId')))
        UNION ALL
        SELECT 1
        FROM bowler_occurrence_obligations o
        LEFT JOIN bowler_occurrence_obligation_revisions r
          ON r.organization_id = o.organization_id AND r.league_id = o.league_id
         AND r.obligation_id = o.id AND r.revision_number = o.current_revision
        WHERE o.organization_id = ${input.organizationId} AND o.league_id = ${input.leagueId}
          AND (r.id IS NULL OR r.snapshot_schema_version <> 1
            OR r.after_snapshot->>'state' IS DISTINCT FROM o.state
            OR CASE WHEN r.after_snapshot->>'amountMinor' ~ '^-?[0-9]+$' THEN (r.after_snapshot->>'amountMinor')::integer END IS DISTINCT FROM o.amount_minor
            OR r.after_snapshot->>'currency' IS DISTINCT FROM o.currency
            OR r.after_snapshot->>'billingTermId' IS DISTINCT FROM o.billing_term_id::text
            OR CASE WHEN r.after_snapshot->>'billingTermVersion' ~ '^-?[0-9]+$' THEN (r.after_snapshot->>'billingTermVersion')::integer END IS DISTINCT FROM o.billing_term_version
            OR CASE WHEN r.after_snapshot->>'dueAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T]' THEN (r.after_snapshot->>'dueAt')::timestamptz END IS DISTINCT FROM o.due_at
            OR CASE WHEN r.after_snapshot->>'pastDueAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T]' THEN (r.after_snapshot->>'pastDueAt')::timestamptz END IS DISTINCT FROM o.past_due_at)
        UNION ALL
        SELECT 1
        FROM payment_occurrence_allocations a
        LEFT JOIN payment_occurrence_allocation_revisions r
          ON r.organization_id = a.organization_id AND r.league_id = a.league_id
         AND r.allocation_id = a.id AND r.revision_number = a.current_revision
        WHERE a.organization_id = ${input.organizationId} AND a.league_id = ${input.leagueId}
          AND (r.id IS NULL OR r.snapshot_schema_version <> 1
            OR r.after_snapshot->>'state' IS DISTINCT FROM a.state
            OR CASE WHEN r.after_snapshot->>'amountMinor' ~ '^-?[0-9]+$' THEN (r.after_snapshot->>'amountMinor')::integer END IS DISTINCT FROM a.amount_minor
            OR r.after_snapshot->>'currency' IS DISTINCT FROM a.currency
            OR r.after_snapshot->>'paymentId' IS DISTINCT FROM a.payment_id::text
            OR r.after_snapshot->>'obligationId' IS DISTINCT FROM a.obligation_id::text
            OR r.after_snapshot->>'occurrenceId' IS DISTINCT FROM a.occurrence_id::text
            OR CASE WHEN r.after_snapshot->>'bowlerId' ~ '^-?[0-9]+$' THEN (r.after_snapshot->>'bowlerId')::integer END IS DISTINCT FROM a.bowler_id)
      ) AS present
    `).then((result) => result.rows as Array<{ present: boolean }>);
    if (globalRevisionIntegrity?.present) throw new CanonicalPaymentReportIncompatibilityError();
    const parentConditions = parentKeys.map((parentKey) => {
      const [kind, value] = parentKey.split(":", 2);
      if (kind === "operation") return eq(payments.paymentOperationId, value);
      if (kind === "combined") return eq(payments.combinedChargeGroupId, value);
      return eq(payments.id, Number(value));
    });
    const paymentRows = parentConditions.length === 0 ? [] : await tx.select({ payment: payments }).from(payments)
      .innerJoin(bowlers, eq(bowlers.id, payments.bowlerId))
      .where(and(
        eq(payments.leagueId, input.leagueId),
        eq(bowlers.organizationId, input.organizationId),
        or(...parentConditions),
      ))
      .orderBy(asc(payments.weekOf), asc(payments.bowlerId), asc(payments.id))
      .then((rows) => rows.map((row) => row.payment));
    const payerUserIds = [...new Set(paymentRows.map((payment) => payment.paidByUserId).filter((id): id is number => id !== null))];
    const payerUsers = payerUserIds.length === 0 ? [] : await tx.select({ id: users.id, bowlerId: users.bowlerId }).from(users).where(and(
      eq(users.organizationId, input.organizationId),
      inArray(users.id, payerUserIds),
    ));
    const payerBowlerByUser = new Map(payerUsers.filter((user): user is { id: number; bowlerId: number } => user.bowlerId !== null).map((user) => [user.id, user.bowlerId]));
    const paymentsById = new Map(paymentRows.map((payment) => [payment.id, payment]));
    const paymentIds = paymentRows.map((payment) => payment.id);
    const paymentBowlerIds = [...new Set(paymentRows.map((payment) => payment.bowlerId))];
    if (paymentBowlerIds.length > 0) {
      const scopedBowlers = await tx.select({ id: bowlers.id }).from(bowlers).where(and(
        eq(bowlers.organizationId, input.organizationId),
        inArray(bowlers.id, paymentBowlerIds),
      ));
      if (scopedBowlers.length !== paymentBowlerIds.length) throw new CanonicalPaymentReportIncompatibilityError();
    }
    const allocationRows = paymentIds.length === 0 ? [] : await tx.select({ allocation: paymentOccurrenceAllocations }).from(paymentOccurrenceAllocations)
      .innerJoin(leagueOccurrences, and(
        eq(leagueOccurrences.id, paymentOccurrenceAllocations.occurrenceId),
        eq(leagueOccurrences.organizationId, input.organizationId),
        eq(leagueOccurrences.leagueId, input.leagueId),
      )).where(and(
        eq(paymentOccurrenceAllocations.organizationId, input.organizationId),
        eq(paymentOccurrenceAllocations.leagueId, input.leagueId),
        inArray(paymentOccurrenceAllocations.paymentId, paymentIds),
      )).orderBy(asc(leagueOccurrences.plannedOrdinal), asc(paymentOccurrenceAllocations.id));
    const allocations = allocationRows.map((row) => row.allocation);
    const allocationIds = allocations.map((allocation) => allocation.id);
    const obligationIds = ids(allocations.map((allocation) => ({ id: allocation.obligationId })));
    const obligations = obligationIds.length === 0 ? [] : await tx.select().from(bowlerOccurrenceObligations).where(and(
      eq(bowlerOccurrenceObligations.organizationId, input.organizationId),
      eq(bowlerOccurrenceObligations.leagueId, input.leagueId),
      inArray(bowlerOccurrenceObligations.id, obligationIds),
    ));
    if (obligations.length !== obligationIds.length) throw new CanonicalPaymentReportIncompatibilityError();

    const obligationRevisions = obligationIds.length === 0 ? [] : await tx.select({
      parentId: bowlerOccurrenceObligationRevisions.obligationId,
      revisionNumber: bowlerOccurrenceObligationRevisions.revisionNumber,
      snapshotSchemaVersion: bowlerOccurrenceObligationRevisions.snapshotSchemaVersion,
      beforeSnapshot: bowlerOccurrenceObligationRevisions.beforeSnapshot,
      afterSnapshot: bowlerOccurrenceObligationRevisions.afterSnapshot,
    }).from(bowlerOccurrenceObligationRevisions).where(and(
      eq(bowlerOccurrenceObligationRevisions.organizationId, input.organizationId),
      eq(bowlerOccurrenceObligationRevisions.leagueId, input.leagueId),
      inArray(bowlerOccurrenceObligationRevisions.obligationId, obligationIds),
    ));
    if (obligations.length > 0 && (!revisionCoverage(obligations, obligationRevisions) || !revisionSemanticsCoverage(obligations, obligationRevisions, (obligation) => ({
      state: obligation.state,
      amountMinor: obligation.amountMinor,
      currency: obligation.currency,
      billingTermId: obligation.billingTermId,
      billingTermVersion: obligation.billingTermVersion,
      dueAt: obligation.dueAt,
      pastDueAt: obligation.pastDueAt,
    })))) throw new CanonicalPaymentReportIncompatibilityError();

    const allocationRevisions = allocationIds.length === 0 ? [] : await tx.select({
      parentId: paymentOccurrenceAllocationRevisions.allocationId,
      revisionNumber: paymentOccurrenceAllocationRevisions.revisionNumber,
      snapshotSchemaVersion: paymentOccurrenceAllocationRevisions.snapshotSchemaVersion,
      beforeSnapshot: paymentOccurrenceAllocationRevisions.beforeSnapshot,
      afterSnapshot: paymentOccurrenceAllocationRevisions.afterSnapshot,
    }).from(paymentOccurrenceAllocationRevisions).where(and(
      eq(paymentOccurrenceAllocationRevisions.organizationId, input.organizationId),
      eq(paymentOccurrenceAllocationRevisions.leagueId, input.leagueId),
      inArray(paymentOccurrenceAllocationRevisions.allocationId, allocationIds),
    ));
    if (allocations.length > 0 && (!revisionCoverage(allocations, allocationRevisions) || !revisionSemanticsCoverage(allocations, allocationRevisions, (allocation) => ({
      state: allocation.state,
      amountMinor: allocation.amountMinor,
      currency: allocation.currency,
      occurrenceId: allocation.occurrenceId,
      bowlerId: allocation.bowlerId,
      obligationId: allocation.obligationId,
      paymentId: allocation.paymentId,
    })))) throw new CanonicalPaymentReportIncompatibilityError();

    const linkedOperationIds = [...new Set(paymentRows.map((payment) => payment.paymentOperationId).filter((id): id is string => id !== null))];
    const operationIds = linkedOperationIds;
    const operations = await tx.select().from(paymentOperations).where(and(
      eq(paymentOperations.organizationId, input.organizationId),
      inArray(paymentOperations.id, operationIds.length > 0 ? operationIds : ["00000000-0000-0000-0000-000000000000"]),
    ));
    if (operations.length !== operationIds.length) throw new CanonicalPaymentReportIncompatibilityError();
    const linkedLegacyScopeRows = operationIds.length === 0 ? [] : await tx.select({ operationId: interactivePaymentOperationSnapshots.operationId, leagueId: interactivePaymentOperationSnapshots.leagueId }).from(interactivePaymentOperationSnapshots).where(inArray(interactivePaymentOperationSnapshots.operationId, operationIds));
    const linkedScheduledScopeRows = operationIds.length === 0 ? [] : await tx.select({ operationId: scheduledPaymentOperationSnapshots.operationId, leagueId: scheduledPaymentOperationSnapshots.leagueId }).from(scheduledPaymentOperationSnapshots).where(inArray(scheduledPaymentOperationSnapshots.operationId, operationIds));
    const linkedOccurrenceScopeRows = operationIds.length === 0 ? [] : await tx.select({ operationId: paymentOperationOccurrenceSnapshots.operationId, leagueId: paymentOperationOccurrenceSnapshots.leagueId }).from(paymentOperationOccurrenceSnapshots).where(inArray(paymentOperationOccurrenceSnapshots.operationId, operationIds));
    const linkedScopeByOperation = new Map([...linkedLegacyScopeRows, ...linkedScheduledScopeRows, ...linkedOccurrenceScopeRows].map((row) => [row.operationId, row.leagueId]));
    if (operations.some((operation) => operation.leagueId !== input.leagueId && linkedScopeByOperation.get(operation.id) !== input.leagueId)) throw new CanonicalPaymentReportIncompatibilityError();
    const operationsById = new Map(operations.map((operation) => [operation.id, operation]));
    const legacyBusinessDates = new Map<string, string>();
    const legacyLinkedIds = operations.filter((operation) => operation.operationType === "scheduled_charge" || operation.operationType === "interactive_charge").map((operation) => operation.id);
    const linkedScheduledSnapshots = legacyLinkedIds.length === 0 ? [] : await tx.select().from(scheduledPaymentOperationSnapshots).where(inArray(scheduledPaymentOperationSnapshots.operationId, legacyLinkedIds));
    const linkedScheduledAllocations = legacyLinkedIds.length === 0 ? [] : await tx.select().from(scheduledPaymentOperationAllocations).where(inArray(scheduledPaymentOperationAllocations.operationId, legacyLinkedIds)).orderBy(asc(scheduledPaymentOperationAllocations.allocationIndex));
    const linkedScheduledLineItems = legacyLinkedIds.length === 0 ? [] : await tx.select().from(scheduledPaymentOperationLineItems).where(inArray(scheduledPaymentOperationLineItems.operationId, legacyLinkedIds)).orderBy(asc(scheduledPaymentOperationLineItems.lineItemIndex));
    const linkedInteractiveSnapshots = legacyLinkedIds.length === 0 ? [] : await tx.select().from(interactivePaymentOperationSnapshots).where(inArray(interactivePaymentOperationSnapshots.operationId, legacyLinkedIds));
    const linkedInteractiveAllocations = legacyLinkedIds.length === 0 ? [] : await tx.select().from(interactivePaymentOperationAllocations).where(inArray(interactivePaymentOperationAllocations.operationId, legacyLinkedIds)).orderBy(asc(interactivePaymentOperationAllocations.allocationIndex));
    const linkedInteractiveLineItems = legacyLinkedIds.length === 0 ? [] : await tx.select().from(interactivePaymentOperationLineItems).where(inArray(interactivePaymentOperationLineItems.operationId, legacyLinkedIds)).orderBy(asc(interactivePaymentOperationLineItems.lineItemIndex));
    if (paymentRows.some((payment) => payment.paymentOperationId && !allocations.some((allocation) => allocation.paymentId === payment.id))) {
      for (const payment of paymentRows.filter((row) => row.paymentOperationId && !allocations.some((allocation) => allocation.paymentId === row.id))) {
        const operation = payment.paymentOperationId ? operationsById.get(payment.paymentOperationId) : undefined;
        try {
          if (!operation || (operation.operationType !== "scheduled_charge" && operation.operationType !== "interactive_charge")) throw new Error("missing legacy operation");
          if (operation.operationType === "scheduled_charge") {
            const stored = linkedScheduledSnapshots.find((row) => row.operationId === operation.id);
            if (!stored || operation.paymentScheduleId === null || operation.billingCycleAt === null) throw new Error("missing scheduled snapshot");
            const reconstructed = reconstructScheduledPaymentSnapshot({ organizationId: input.organizationId, paymentScheduleId: operation.paymentScheduleId, billingCycleAt: operation.billingCycleAt, amountMinor: operation.amountMinor, currency: operation.currency, providerName: operation.providerName, providerIdempotencyKey: operation.providerIdempotencyKey, stored, allocations: linkedScheduledAllocations.filter((row) => row.operationId === operation.id).map((row) => ({ allocationIndex: row.allocationIndex, bowlerId: row.bowlerId, amountMinor: row.amountMinor, lineageAmountMinor: row.lineageAmountMinor, prizeFundAmountMinor: row.prizeFundAmountMinor, notes: row.notes, paidByUserId: row.paidByUserId })), lineItems: linkedScheduledLineItems.filter((row) => row.operationId === operation.id).map((row) => ({ lineItemIndex: row.lineItemIndex, catalogObjectId: row.catalogObjectId, quantity: row.quantity })) });
            legacyBusinessDates.set(operation.id, reconstructed.billingCycleAt);
          } else {
            const stored = linkedInteractiveSnapshots.find((row) => row.operationId === operation.id);
            if (!stored) throw new Error("missing interactive snapshot");
            const reconstructed = reconstructInteractivePaymentSnapshot({ organizationId: input.organizationId, amountMinor: operation.amountMinor, currency: operation.currency, providerName: operation.providerName, providerIdempotencyKey: operation.providerIdempotencyKey, stored, allocations: linkedInteractiveAllocations.filter((row) => row.operationId === operation.id).map((row) => ({ allocationIndex: row.allocationIndex, bowlerId: row.bowlerId, amountMinor: row.amountMinor, lineageAmountMinor: row.lineageAmountMinor, prizeFundAmountMinor: row.prizeFundAmountMinor, weekOf: new Date(row.weekOf).toISOString(), notes: row.notes, paidByUserId: row.paidByUserId })), lineItems: linkedInteractiveLineItems.filter((row) => row.operationId === operation.id).map((row) => ({ lineItemIndex: row.lineItemIndex, catalogObjectId: row.catalogObjectId, quantity: row.quantity })) });
            legacyBusinessDates.set(operation.id, reconstructed.weekOf);
          }
        } catch {
          throw new CanonicalPaymentReportIncompatibilityError();
        }
      }
    }
    for (const operation of operations) {
      const linkedAmount = paymentRows.filter((payment) => payment.paymentOperationId === operation.id).reduce((sum, payment) => sum + payment.amount, 0);
      if (linkedAmount > 0 && linkedAmount !== operation.amountMinor) throw new CanonicalPaymentReportIncompatibilityError();
    }

    // An uncertain/action-required F4 operation can be durable before its
    // payment rows are inserted. Keep that evidence visible without treating
    // it as paid. Its tenant/league row and immutable snapshots are the only
    // source of identity; no provider lookup or amount inference is allowed.
    const unresolvedOperationIds = parentKeys
      .filter((key) => key.startsWith("operation:"))
      .map((key) => key.slice("operation:".length));
    const unresolvedOperations = unresolvedOperationIds.length === 0 ? [] : await tx.select().from(paymentOperations).where(and(
      eq(paymentOperations.organizationId, input.organizationId),
      inArray(paymentOperations.id, unresolvedOperationIds),
    ));
    const allOperations = [...new Map([...operations, ...unresolvedOperations].map((operation) => [operation.id, operation])).values()];
    const allOperationsById = new Map(allOperations.map((operation) => [operation.id, operation]));
    const allOperationIds = allOperations.map((operation) => operation.id);

    const occurrenceIds = [...new Set(allocations.map((allocation) => allocation.occurrenceId))];
    const occurrences = occurrenceIds.length === 0 ? [] : await tx.select({ id: leagueOccurrences.id, startAt: leagueOccurrences.startAt, plannedOrdinal: leagueOccurrences.plannedOrdinal })
      .from(leagueOccurrences)
      .where(and(
        eq(leagueOccurrences.organizationId, input.organizationId),
        eq(leagueOccurrences.leagueId, input.leagueId),
        inArray(leagueOccurrences.id, occurrenceIds),
      ));
    if (occurrences.length !== occurrenceIds.length) throw new CanonicalPaymentReportIncompatibilityError();
    const occurrenceStartById = new Map(occurrences.map((occurrence) => [occurrence.id, occurrence.startAt]));
    const occurrenceOrdinalById = new Map(occurrences.map((occurrence) => [occurrence.id, occurrence.plannedOrdinal ?? Number.MAX_SAFE_INTEGER]));

    const disputeRows = allOperationIds.length === 0 ? [] : await tx.select({ operationId: paymentDisputes.paymentOperationId, amountMinor: paymentDisputes.amountMinor, currency: paymentDisputes.currency, state: paymentDisputes.state, id: paymentDisputes.id })
      .from(paymentDisputes)
      .where(and(eq(paymentDisputes.organizationId, input.organizationId), inArray(paymentDisputes.paymentOperationId, allOperationIds)));
    const disputesByOperation = new Map<string, DurableOperationDispute>();
    for (const dispute of disputeRows) {
      const operation = allOperationsById.get(dispute.operationId);
      if (!operation || dispute.currency !== operation.currency || dispute.amountMinor <= 0) throw new CanonicalPaymentReportIncompatibilityError();
      const previous = disputesByOperation.get(dispute.operationId);
      if (previous && (previous.state !== dispute.state || previous.currency !== dispute.currency)) throw new CanonicalPaymentReportIncompatibilityError();
      const amountMinor = (previous?.amountMinor ?? 0) + dispute.amountMinor;
      if (amountMinor > operation.amountMinor) throw new CanonicalPaymentReportIncompatibilityError();
      disputesByOperation.set(dispute.operationId, {
        amountMinor,
        disputeId: previous?.disputeId ?? dispute.id,
        state: dispute.state,
        currency: dispute.currency,
      });
    }
    const disputedOperationIds = new Set(disputesByOperation.keys());
    const allocationsByPayment = new Map<number, Allocation[]>();
    for (const allocation of allocations) allocationsByPayment.set(allocation.paymentId, [...(allocationsByPayment.get(allocation.paymentId) ?? []), allocation]);
    for (const payment of paymentRows) {
      const paymentAllocations = allocationsByPayment.get(payment.id) ?? [];
      if (paymentAllocations.length === 0) continue;
      const activeAllocated = paymentAllocations
        .filter((allocation) => allocation.state === "active")
        .reduce((sum, allocation) => sum + allocation.amountMinor, 0);
      if (activeAllocated !== payment.amount) throw new CanonicalPaymentReportIncompatibilityError();
    }

    if (activation) {
      const canonicalOperationIds = allOperations.filter((operation) => operation.operationType === "canonical_autopay_charge").map((operation) => operation.id);
      if (canonicalOperationIds.length > 0) {
        const snapshots = await tx.select().from(canonicalAutopayExecutionSnapshots).where(and(
          eq(canonicalAutopayExecutionSnapshots.organizationId, input.organizationId),
          eq(canonicalAutopayExecutionSnapshots.leagueId, input.leagueId),
          inArray(canonicalAutopayExecutionSnapshots.operationId, canonicalOperationIds),
        ));
        if (snapshots.length !== canonicalOperationIds.length) throw new CanonicalPaymentReportIncompatibilityError();
        for (const snapshot of snapshots) {
          const operation = allOperationsById.get(snapshot.operationId);
          if (!operation
            || operation.operationType !== "canonical_autopay_charge"
            || operation.leagueId !== snapshot.leagueId
            || operation.canonicalPlanId !== snapshot.d2PlanId
            || operation.triggerOccurrenceId !== snapshot.triggerOccurrenceId
            || operation.amountMinor !== snapshot.amountMinor
            || operation.currency !== snapshot.currency
            || snapshot.snapshotVersion !== 1
            || !Array.isArray(snapshot.items)) {
            throw new CanonicalPaymentReportIncompatibilityError();
          }
          try {
            validateF4ExecutionSnapshot({
              contractVersion: "canonical-autopay-execution/1",
              snapshotVersion: snapshot.snapshotVersion,
              operationId: snapshot.operationId,
              organizationId: snapshot.organizationId,
              leagueId: snapshot.leagueId,
              d2PlanId: snapshot.d2PlanId,
              collectionPointOccurrenceId: snapshot.collectionPointOccurrenceId,
              triggerOccurrenceId: snapshot.triggerOccurrenceId,
              triggerStartAt: new Date(snapshot.triggerStartAt).toISOString(),
              payerBowlerId: snapshot.payerBowlerId,
              locationId: snapshot.locationId,
              providerLocationId: snapshot.providerLocationId,
              activationId: snapshot.activationId,
              activationRevision: snapshot.activationRevision,
              activationSourceFingerprint: snapshot.activationSourceFingerprint,
              policyId: snapshot.policyId,
              policyVersion: snapshot.policyVersion,
              policyFingerprint: snapshot.policyFingerprint,
              authorizationId: snapshot.authorizationId,
              authorizationVersion: snapshot.authorizationVersion,
              authorizationFingerprint: snapshot.authorizationFingerprint,
              planVersion: snapshot.planVersion,
              planFingerprint: snapshot.planFingerprint,
              amountMinor: snapshot.amountMinor,
              currency: snapshot.currency,
              items: snapshot.items,
              encryptedSourceId: snapshot.encryptedSourceId,
              encryptedCustomerId: snapshot.encryptedCustomerId,
              snapshotFingerprint: snapshot.snapshotFingerprint,
            });
          } catch {
            throw new CanonicalPaymentReportIncompatibilityError();
          }
        }
      }
      const occurrenceSnapshots = allOperationIds.length === 0 ? [] : await tx.select().from(paymentOperationOccurrenceSnapshots).where(and(
        eq(paymentOperationOccurrenceSnapshots.organizationId, input.organizationId),
        eq(paymentOperationOccurrenceSnapshots.leagueId, input.leagueId),
        inArray(paymentOperationOccurrenceSnapshots.operationId, allOperationIds),
      ));
      const occurrenceSnapshotAllocations = allOperationIds.length === 0 ? [] : await tx.select().from(paymentOperationOccurrenceSnapshotAllocations).where(and(
        eq(paymentOperationOccurrenceSnapshotAllocations.organizationId, input.organizationId),
        eq(paymentOperationOccurrenceSnapshotAllocations.leagueId, input.leagueId),
        inArray(paymentOperationOccurrenceSnapshotAllocations.operationId, allOperationIds),
      ));
      for (const snapshot of occurrenceSnapshots) {
        const snapshotRows = occurrenceSnapshotAllocations.filter((row) => row.operationId === snapshot.operationId);
        const operation = allOperationsById.get(snapshot.operationId);
        if (!operation
          || !["scheduled_charge", "interactive_charge", "canonical_autopay_charge"].includes(operation.operationType)
          || snapshot.snapshotVersion !== 1
          || snapshot.leagueId !== input.leagueId
          || snapshot.currency !== operation.currency
          || snapshot.amountMinor !== operation.amountMinor
          || snapshotRows.length !== snapshot.allocationCount
          || snapshotRows.reduce((sum, row) => sum + row.amountMinor, 0) !== snapshot.amountMinor
          || snapshotRows.some((row) => row.currency !== snapshot.currency || row.leagueId !== snapshot.leagueId)) {
          throw new CanonicalPaymentReportIncompatibilityError();
        }
        try {
          const semantic = validatePaymentOperationOccurrenceSnapshot({
            contractVersion: "payment-operation-occurrence-snapshot/1",
            snapshotVersion: snapshot.snapshotVersion,
            operationId: snapshot.operationId,
            operationType: operation.operationType,
            organizationId: snapshot.organizationId,
            leagueId: snapshot.leagueId,
            amountMinor: snapshot.amountMinor,
            currency: snapshot.currency,
            allocations: snapshotRows
              .sort((a, b) => a.allocationIndex - b.allocationIndex)
              .map((row) => ({ allocationIndex: row.allocationIndex, organizationId: row.organizationId, leagueId: row.leagueId, occurrenceId: row.occurrenceId, bowlerId: row.bowlerId, obligationId: row.obligationId, amountMinor: row.amountMinor, currency: row.currency })),
          });
          if (fingerprintPaymentOperationOccurrenceSnapshot(semantic) !== snapshot.snapshotFingerprint) throw new Error("occurrence fingerprint mismatch");
        } catch {
          throw new CanonicalPaymentReportIncompatibilityError();
        }
      }
    }

    const allocationsByObligation = new Map<string, Allocation[]>();
    for (const allocation of allocations) allocationsByObligation.set(allocation.obligationId, [...(allocationsByObligation.get(allocation.obligationId) ?? []), allocation]);
    for (const obligation of obligations) {
      const allocated = (allocationsByObligation.get(obligation.id) ?? [])
        .filter((allocation) => allocation.state === "active")
        .reduce((sum, allocation) => sum + allocation.amountMinor, 0);
      const expectedState = obligation.state === "voided"
        ? "voided"
        : allocated === 0
          ? "open"
          : allocated === obligation.amountMinor
            ? "settled"
            : allocated < obligation.amountMinor
              ? "partially_settled"
              : "invalid";
      if (expectedState === "invalid" || expectedState !== obligation.state) throw new CanonicalPaymentReportIncompatibilityError();
    }

    const paymentTiming = {
      paymentMode: (activation?.payment_mode ?? league.paymentMode) as "weekly" | "upfront",
      upfrontDueAt: activation?.upfront_due_at ?? null,
      upfrontDueAtLocal: activation?.upfront_due_at ? localBusinessDate(activation.upfront_due_at, league.timezone ?? "UTC") : null,
      timezone: league.timezone ?? "UTC",
      source: activation ? "canonical_activation" as const : "legacy_league" as const,
    };
    const rows: CanonicalPaymentRow[] = paymentRows.map((payment) => {
      const paymentAllocations = allocationsByPayment.get(payment.id) ?? [];
      const operation = payment.paymentOperationId ? operationsById.get(payment.paymentOperationId) : undefined;
      const startTimes = paymentAllocations.map((allocation) => occurrenceStartById.get(allocation.occurrenceId)).filter((value): value is string => !!value).sort();
      const businessDate = startTimes[0] ?? (operation ? legacyBusinessDates.get(operation.id) : undefined) ?? payment.weekOf;
      const refund = { present: payment.status === "refunded" || payment.squareRefundId !== null, amountMinor: payment.status === "refunded" ? payment.amount : 0, providerRefundId: payment.squareRefundId };
      const durableDispute = operation ? disputesByOperation.get(operation.id) : undefined;
      if (payment.status === "disputed" && operation && !durableDispute && paymentAllocations.length > 0) throw new CanonicalPaymentReportIncompatibilityError();
      const activeAllocatedMinor = paymentAllocations.filter((allocation) => allocation.state === "active").reduce((sum, allocation) => sum + allocation.amountMinor, 0);
      const dispute = { present: payment.status === "disputed" || Boolean(durableDispute), amountMinor: durableDispute ? 0 : (payment.status === "disputed" ? Math.min(payment.amount, activeAllocatedMinor || payment.amount) : 0), disputeId: durableDispute?.disputeId ?? payment.disputeId, scope: durableDispute ? "transaction" as const : "legacy_payment_row" as const, state: durableDispute?.state ?? (payment.status === "disputed" ? "review_required" : null), reviewRequired: payment.status === "disputed" || Boolean(durableDispute) };
      const unresolved = !!operation && unresolvedOperationStatuses.has(operation.status);
      const reviewRequired = dispute.present || (payment.status !== "paid" && payment.status !== "pending") || unresolved;
      const status = statusForPayment(payment, operation, disputedOperationIds.has(operation?.id ?? ""));
      const canonicalSnapshot = operation ? canonicalSnapshotByOperation.get(operation.id) : undefined;
      const collectionEvidence = canonicalSnapshot
        ? collectionEvidenceForSnapshot(canonicalSnapshot, canonicalPolicyOccurrencesByPolicy.get(canonicalSnapshot.policyId) ?? [])
        : undefined;
      return {
        paymentId: payment.id,
        leagueId: payment.leagueId,
        bowlerId: payment.bowlerId,
        amountMinor: payment.amount,
        currency: "USD",
        status,
        paymentType: payment.type,
        businessDate,
        authoritativeLocalDate: startTimes[0] ? localBusinessDate(startTimes[0], league.timezone ?? "UTC") : localBusinessDate(payment.weekOf, league.timezone ?? "UTC"),
        providerPaymentId: payment.providerPaymentId,
        paymentOperationId: payment.paymentOperationId,
        operationType: operation?.operationType ?? null,
        operationStatus: operation?.status ?? null,
        allocatedMinor: activeAllocatedMinor,
        unallocatedMinor: Math.max(0, payment.amount - activeAllocatedMinor),
        reviewRequired,
        source: paymentAllocations.length > 0 ? "canonical_allocation" : "unlinked_legacy",
        refund,
        dispute,
        unresolved,
        ...(paymentTiming ? { paymentTiming } : {}),
        receipt: paymentReceiptContract({
          receiptUrl: payment.receiptUrl,
          receiptNumber: payment.receiptNumber,
          organizationId: input.organizationId,
          leagueId: payment.leagueId,
          paymentId: payment.id,
          paymentOperationId: payment.paymentOperationId,
          operationStatus: operation?.status ?? null,
          amountMinor: payment.amount,
          currency: "USD",
          evidenceStatus: status,
          source: paymentAllocations.length > 0 ? "canonical_allocation" : "unlinked_legacy",
          allocations: paymentAllocations.map((allocation) => ({ allocationId: allocation.id, obligationId: allocation.obligationId, occurrenceId: allocation.occurrenceId, bowlerId: allocation.bowlerId, amountMinor: allocation.amountMinor, currency: allocation.currency, state: allocation.state, source: "canonical_allocation" as const })),
          refund,
          dispute,
          unresolved,
          ...(paymentTiming ? { paymentTiming } : {}),
          ...(collectionEvidence ? { collectionEvidence } : {}),
          sharedTransaction: operation ? { groupKey: `operation:${operation.id}`, childCount: paymentRows.filter((row) => row.paymentOperationId === operation.id).length } : null,
        }),
        sharedTransaction: operation ? { groupKey: `operation:${operation.id}`, childCount: paymentRows.filter((row) => row.paymentOperationId === operation.id).length } : null,
        allocations: paymentAllocations.map((allocation) => ({
          allocationId: allocation.id,
          obligationId: allocation.obligationId,
          occurrenceId: allocation.occurrenceId,
          bowlerId: allocation.bowlerId,
          amountMinor: allocation.amountMinor,
          currency: allocation.currency,
          state: allocation.state,
          source: "canonical_allocation",
        })),
        ...(collectionEvidence ? { collectionEvidence } : {}),
        ...((canonicalSnapshot?.payerBowlerId ?? (payment.paidByUserId === null ? null : payerBowlerByUser.get(payment.paidByUserId) ?? null)) !== null
          ? { initiatingPayerBowlerId: canonicalSnapshot?.payerBowlerId ?? payerBowlerByUser.get(payment.paidByUserId as number) ?? null }
          : {}),
      };
    });

    const legacyOperationIds = allOperations
      .filter((operation) => operation.operationType === "scheduled_charge" || operation.operationType === "interactive_charge")
      .map((operation) => operation.id);
    const legacyScheduledSnapshots = legacyOperationIds.length === 0 ? [] : await tx.select().from(scheduledPaymentOperationSnapshots).where(inArray(scheduledPaymentOperationSnapshots.operationId, legacyOperationIds));
    const legacyScheduledAllocations = legacyOperationIds.length === 0 ? [] : await tx.select().from(scheduledPaymentOperationAllocations).where(inArray(scheduledPaymentOperationAllocations.operationId, legacyOperationIds)).orderBy(asc(scheduledPaymentOperationAllocations.allocationIndex));
    const legacyScheduledLineItems = legacyOperationIds.length === 0 ? [] : await tx.select().from(scheduledPaymentOperationLineItems).where(inArray(scheduledPaymentOperationLineItems.operationId, legacyOperationIds)).orderBy(asc(scheduledPaymentOperationLineItems.lineItemIndex));
    const legacyInteractiveSnapshots = legacyOperationIds.length === 0 ? [] : await tx.select().from(interactivePaymentOperationSnapshots).where(inArray(interactivePaymentOperationSnapshots.operationId, legacyOperationIds));
    const legacyInteractiveAllocations = legacyOperationIds.length === 0 ? [] : await tx.select().from(interactivePaymentOperationAllocations).where(inArray(interactivePaymentOperationAllocations.operationId, legacyOperationIds)).orderBy(asc(interactivePaymentOperationAllocations.allocationIndex));
    const legacyInteractiveLineItems = legacyOperationIds.length === 0 ? [] : await tx.select().from(interactivePaymentOperationLineItems).where(inArray(interactivePaymentOperationLineItems.operationId, legacyOperationIds)).orderBy(asc(interactivePaymentOperationLineItems.lineItemIndex));
    const legacyParticipants = new Map<string, { bowlerId: number; amountMinor: number; currency: string; businessDate: string }[]>();
    for (const operation of allOperations) {
      if (!unresolvedOperationStatuses.has(operation.status) || paymentRows.some((payment) => payment.paymentOperationId === operation.id)) continue;
      const snapshot = (await tx.select().from(paymentOperationOccurrenceSnapshots).where(and(
        eq(paymentOperationOccurrenceSnapshots.organizationId, input.organizationId),
        eq(paymentOperationOccurrenceSnapshots.leagueId, input.leagueId),
        eq(paymentOperationOccurrenceSnapshots.operationId, operation.id),
      )).then((found) => found[0]));
      const canonicalSnapshot = operation.operationType === "canonical_autopay_charge"
        ? (await tx.select().from(canonicalAutopayExecutionSnapshots).where(and(
          eq(canonicalAutopayExecutionSnapshots.organizationId, input.organizationId),
          eq(canonicalAutopayExecutionSnapshots.leagueId, input.leagueId),
          eq(canonicalAutopayExecutionSnapshots.operationId, operation.id),
        )).then((found) => found[0]))
        : undefined;
      if (operation.operationType === "canonical_autopay_charge" && !canonicalSnapshot) throw new CanonicalPaymentReportIncompatibilityError();
      const snapshotAllocationRows = snapshot
        ? await tx.select().from(paymentOperationOccurrenceSnapshotAllocations).where(and(
          eq(paymentOperationOccurrenceSnapshotAllocations.organizationId, input.organizationId),
          eq(paymentOperationOccurrenceSnapshotAllocations.leagueId, input.leagueId),
          eq(paymentOperationOccurrenceSnapshotAllocations.operationId, operation.id),
        ))
        : [];
      let legacySnapshotBusinessDate: string | undefined;
      if (!snapshot && operation.operationType !== "canonical_autopay_charge") {
        try {
          if (operation.operationType === "scheduled_charge") {
            const stored = legacyScheduledSnapshots.find((row) => row.operationId === operation.id);
            if (!stored || operation.paymentScheduleId === null || operation.billingCycleAt === null) throw new Error("missing scheduled evidence");
            const allocationRows = legacyScheduledAllocations.filter((row) => row.operationId === operation.id).map((row) => ({ allocationIndex: row.allocationIndex, bowlerId: row.bowlerId, amountMinor: row.amountMinor, lineageAmountMinor: row.lineageAmountMinor, prizeFundAmountMinor: row.prizeFundAmountMinor, notes: row.notes, paidByUserId: row.paidByUserId }));
            const lineItemRows = legacyScheduledLineItems.filter((row) => row.operationId === operation.id).map((row) => ({ lineItemIndex: row.lineItemIndex, catalogObjectId: row.catalogObjectId, quantity: row.quantity }));
            const reconstructed = reconstructScheduledPaymentSnapshot({ organizationId: input.organizationId, paymentScheduleId: operation.paymentScheduleId, billingCycleAt: operation.billingCycleAt, amountMinor: operation.amountMinor, currency: operation.currency, providerName: operation.providerName, providerIdempotencyKey: operation.providerIdempotencyKey, stored, allocations: allocationRows, lineItems: lineItemRows });
            legacyParticipants.set(operation.id, reconstructed.allocations.map((row) => ({ bowlerId: row.bowlerId, amountMinor: row.amountMinor, currency: reconstructed.currency, businessDate: reconstructed.billingCycleAt })));
            legacySnapshotBusinessDate = reconstructed.billingCycleAt;
          } else {
            const stored = legacyInteractiveSnapshots.find((row) => row.operationId === operation.id);
            if (!stored) throw new Error("missing interactive evidence");
            const allocationRows = legacyInteractiveAllocations.filter((row) => row.operationId === operation.id).map((row) => ({ allocationIndex: row.allocationIndex, bowlerId: row.bowlerId, amountMinor: row.amountMinor, lineageAmountMinor: row.lineageAmountMinor, prizeFundAmountMinor: row.prizeFundAmountMinor, weekOf: new Date(row.weekOf).toISOString(), notes: row.notes, paidByUserId: row.paidByUserId }));
            const lineItemRows = legacyInteractiveLineItems.filter((row) => row.operationId === operation.id).map((row) => ({ lineItemIndex: row.lineItemIndex, catalogObjectId: row.catalogObjectId, quantity: row.quantity }));
            const reconstructed = reconstructInteractivePaymentSnapshot({ organizationId: input.organizationId, amountMinor: operation.amountMinor, currency: operation.currency, providerName: operation.providerName, providerIdempotencyKey: operation.providerIdempotencyKey, stored, allocations: allocationRows, lineItems: lineItemRows });
            legacyParticipants.set(operation.id, reconstructed.allocations.map((row) => ({ bowlerId: row.bowlerId, amountMinor: row.amountMinor, currency: reconstructed.currency, businessDate: reconstructed.weekOf })));
            legacySnapshotBusinessDate = reconstructed.weekOf;
          }
        } catch {
          throw new CanonicalPaymentReportIncompatibilityError();
        }
      }
      if (!snapshot && operation.operationType === "canonical_autopay_charge") throw new CanonicalPaymentReportIncompatibilityError();
      const businessDate = canonicalSnapshot?.triggerStartAt ?? legacySnapshotBusinessDate ?? snapshot?.createdAt ?? operation.createdAt;
      const participantRows = canonicalSnapshot?.items && Array.isArray(canonicalSnapshot.items)
        ? canonicalSnapshot.items.map((item) => ({
          allocationId: null,
          obligationId: item.obligationId ?? null,
          occurrenceId: item.occurrenceId,
          bowlerId: item.bowlerId,
          amountMinor: item.amountMinor,
          currency: item.currency ?? operation.currency,
          state: "active" as const,
          source: "canonical_allocation" as const,
        }))
        : snapshotAllocationRows.map((item) => ({
          allocationId: null,
          obligationId: item.obligationId,
          occurrenceId: item.occurrenceId,
          bowlerId: item.bowlerId,
          amountMinor: item.amountMinor,
          currency: item.currency,
          state: "active" as const,
          source: "canonical_allocation" as const,
        }));
      const legacyRows = legacyParticipants.get(operation.id);
      const effectiveParticipantRows = participantRows.length > 0 ? participantRows : (legacyRows ?? []).map((item) => ({ allocationId: null, obligationId: null, occurrenceId: null, bowlerId: item.bowlerId, amountMinor: item.amountMinor, currency: item.currency, state: "active" as const, source: "unlinked_legacy" as const }));
      if (effectiveParticipantRows.length === 0) throw new CanonicalPaymentReportIncompatibilityError();
      const participantAmount = effectiveParticipantRows.reduce((sum, item) => sum + item.amountMinor, 0);
      if (participantAmount !== operation.amountMinor) throw new CanonicalPaymentReportIncompatibilityError();
      const unresolvedDispute = disputesByOperation.get(operation.id);
      const syntheticDispute = unresolvedDispute
        ? { present: true, amountMinor: 0, disputeId: null, scope: "transaction" as const, state: unresolvedDispute.state, reviewRequired: true }
        : { present: false, amountMinor: 0, disputeId: null, scope: "transaction" as const, state: null, reviewRequired: false };
      const unresolvedCollectionEvidence = canonicalSnapshot
        ? collectionEvidenceForSnapshot(canonicalSnapshot, canonicalPolicyOccurrencesByPolicy.get(canonicalSnapshot.policyId) ?? [])
        : undefined;
      for (const participant of effectiveParticipantRows) rows.push({
        paymentId: null,
        leagueId: input.leagueId,
        bowlerId: participant.bowlerId,
        amountMinor: participant.amountMinor,
        currency: operation.currency,
        status: "unresolved",
        paymentType: "square",
        businessDate,
        authoritativeLocalDate: localBusinessDate(businessDate, league.timezone ?? "UTC"),
        providerPaymentId: operation.providerObjectId,
        paymentOperationId: operation.id,
        operationType: operation.operationType,
        operationStatus: operation.status,
        allocatedMinor: 0,
        unallocatedMinor: participant.amountMinor,
        reviewRequired: true,
        source: participant.source === "unlinked_legacy" ? "unlinked_legacy" : "unresolved_operation",
        refund: { present: false, amountMinor: 0, providerRefundId: null },
        dispute: syntheticDispute,
        unresolved: true,
        receipt: paymentReceiptContract({ receiptUrl: null, receiptNumber: null, organizationId: input.organizationId, leagueId: input.leagueId, paymentId: null, paymentOperationId: operation.id, operationStatus: operation.status, amountMinor: participant.amountMinor, currency: operation.currency, evidenceStatus: "unresolved", source: participant.source === "unlinked_legacy" ? "unlinked_legacy" : "unresolved_operation", allocations: [participant], dispute: syntheticDispute, unresolved: true, paymentTiming, ...(unresolvedCollectionEvidence ? { collectionEvidence: unresolvedCollectionEvidence } : {}) }),
        allocations: [participant],
        ...(unresolvedCollectionEvidence ? { collectionEvidence: unresolvedCollectionEvidence } : {}),
        sharedTransaction: { groupKey: `operation:${operation.id}`, childCount: effectiveParticipantRows.length },
        ...(canonicalSnapshot ? { initiatingPayerBowlerId: canonicalSnapshot.payerBowlerId } : {}),
      });
    }

    const canonicalRows = activation ? rows.filter((row) => row.source !== "unlinked_legacy") : [];
    const unlinkedHistory = rows.filter((row) => row.source === "unlinked_legacy");
    const mode: CanonicalPaymentReportMode = activation
      ? (aggregateNumber("unlinked_count") > 0 ? "canonical_with_unlinked_history" : "canonical")
      : "legacy_fallback";
    const reportRows = activation ? canonicalRows : rows;
    const visibleRows = input.bowlerId === undefined
      ? reportRows
      : reportRows.filter((row) => row.bowlerId === input.bowlerId || row.allocations.some((allocation) => allocation.bowlerId === input.bowlerId));
    const visibleUnlinkedHistory = input.bowlerId === undefined
      ? unlinkedHistory
      : unlinkedHistory.filter((row) => row.bowlerId === input.bowlerId);
    const totals = {
      grossConfirmedPaidMinor: aggregateNumber("gross_paid"),
      activeAllocatedMinor: aggregateNumber("allocated"),
      refundedMinor: aggregateNumber("refunded"),
      disputedReviewRequiredMinor: aggregateNumber("disputed"),
      reviewRequiredMinor: aggregateNumber("review_required"),
      unresolvedOperationMinor: aggregateNumber("unresolved"),
      unallocatedLegacyMinor: aggregateNumber("unallocated_legacy"),
    };
    const rowOccurrenceOrder = (row: CanonicalPaymentRow): number => Math.min(...row.allocations.map((allocation) => occurrenceOrdinalById.get(allocation.occurrenceId ?? "") ?? Number.MAX_SAFE_INTEGER));
    const rowAllocationOrder = (row: CanonicalPaymentRow): string => row.allocations.map((allocation, index) => `${index}:${allocation.obligationId ?? ""}:${allocation.amountMinor}:${allocation.state ?? ""}`).join("|");
    const sortedRows = [...visibleRows].sort((left, right) => left.authoritativeLocalDate.localeCompare(right.authoritativeLocalDate) || left.bowlerId - right.bowlerId || rowOccurrenceOrder(left) - rowOccurrenceOrder(right) || rowAllocationOrder(left).localeCompare(rowAllocationOrder(right)) || String(left.paymentOperationId ?? left.paymentId).localeCompare(String(right.paymentOperationId ?? right.paymentId)));
    const allTransactions = buildTransactions(sortedRows, paymentsById, allOperationsById, disputesByOperation);
    const pagedTransactions = allTransactions;
    const pagedRows = pagedTransactions.flatMap((transaction) => transaction.rows);
    const pagedUnlinkedHistory = visibleUnlinkedHistory;
    const withoutFingerprint = {
      contractVersion: "canonical-payment-report/1" as const,
      orderVersion: "league,business-date,bowler,occurrence,allocation,payment/1" as const,
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      mode,
      authoritativeSource: activation ? "canonical" as const : "legacy_helper" as const,
      asOf,
      page,
      limit,
      totalRows: aggregateNumber("total_rows"),
      totalTransactions: aggregateNumber("total_transactions"),
      totals,
      paymentTiming,
      rows: pagedRows,
      transactions: pagedTransactions,
      unlinkedHistory: pagedUnlinkedHistory,
    };
  return { ...withoutFingerprint, fingerprint: canonicalPaymentReportFingerprint(withoutFingerprint) };
}

export async function readCanonicalPaymentReport(input: CanonicalPaymentReportInput): Promise<CanonicalPaymentReport> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    return readCanonicalPaymentReportInTransaction(tx, input);
  });
}

export async function readPaymentReceiptProjection(input: { organizationId: number; paymentId: number }): Promise<{
  payment: Payment;
  report: CanonicalPaymentReport;
  row: CanonicalPaymentRow;
}> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    const [payment] = await tx.select({ payment: payments }).from(payments).innerJoin(leagues, and(eq(leagues.id, payments.leagueId), eq(leagues.organizationId, input.organizationId))).where(eq(payments.id, input.paymentId)).limit(1).then((rows) => rows.map((row) => row.payment));
    if (!payment) throw new CanonicalPaymentReportIncompatibilityError();
    // The exact parent selector is already restricted to this payment's
    // operation. Load the bounded parent page so every child of a combined
    // transaction is available for privacy/conservation projection; unrelated
    // zero-payment operation parents are excluded by the paymentId predicate.
    const report = await readCanonicalPaymentReportInTransaction(tx, { organizationId: input.organizationId, leagueId: payment.leagueId, paymentId: payment.id, page: 1, limit: F5_PAGE_MAX });
    const row = [...report.rows, ...report.unlinkedHistory].find((candidate) => candidate.paymentId === payment.id);
    if (!row) throw new CanonicalPaymentReportIncompatibilityError();
    return { payment, report, row };
  });
}
