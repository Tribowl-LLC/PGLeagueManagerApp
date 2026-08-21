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
  scheduledPaymentOperationAllocations,
  scheduledPaymentOperationLineItems,
  scheduledPaymentOperationSnapshots,
  interactivePaymentOperationAllocations,
  interactivePaymentOperationLineItems,
  interactivePaymentOperationSnapshots,
  type Payment,
} from "@shared/schema";
import {
  canonicalPaymentReportFingerprint,
  type CanonicalPaymentReport,
  type CanonicalPaymentReportMode,
  type CanonicalPaymentRow,
  type CanonicalPaymentTransactionGroup,
} from "@shared/canonical-payment-report";
import { paymentReceiptContract } from "@shared/payment-receipt";
import { validateF4ExecutionSnapshot } from "@shared/f4-canonical-autopay-contract";
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
  page?: number;
  limit?: number;
}

type Allocation = typeof paymentOccurrenceAllocations.$inferSelect;
type Operation = typeof paymentOperations.$inferSelect;

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
          || Object.keys(expectedFields).some((key) => !(key in before) || !(key in prior) || JSON.stringify((before as Record<string, unknown>)[key]) !== JSON.stringify((prior as Record<string, unknown>)[key]))) return false;
      }
    }
    const revision = latest.get(parent.id);
    if (!revision || revision.revisionNumber !== parent.currentRevision || !revision.afterSnapshot || typeof revision.afterSnapshot !== "object") return false;
    const snapshot = revision.afterSnapshot as Record<string, unknown>;
    if (!("state" in snapshot) || snapshot.state !== parent.state) return false;
    return Object.entries(expectedFields).every(([key, value]) => key in snapshot && JSON.stringify(snapshot[key]) === JSON.stringify(value));
  });
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
      if (!existing.paymentOperationId) existing.amountMinor += row.amountMinor;
      if (row.paymentId !== null) existing.paymentIds = [...new Set([...existing.paymentIds, row.paymentId])].sort((a, b) => a - b);
      if (!existing.dispute && row.dispute.present) existing.dispute = durable
        ? { present: true, amountMinor: durable.amountMinor, disputeId: durable.disputeId, currency: durable.currency, state: durable.state, reviewRequired: true }
        : { ...row.dispute, currency: row.currency, state: "review_required", reviewRequired: true };
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
          ? { present: true, amountMinor: durable.amountMinor, disputeId: durable.disputeId, currency: durable.currency, state: durable.state, reviewRequired: true }
          : { ...row.dispute, currency: row.currency, state: "review_required", reviewRequired: true }) : undefined,
        rows: [row],
      });
    }
  }
  return [...groups.values()].sort((left, right) => {
    const leftRow = left.rows[0];
    const rightRow = right.rows[0];
    return leftRow.authoritativeLocalDate.localeCompare(rightRow.authoritativeLocalDate)
      || leftRow.bowlerId - rightRow.bowlerId
      || left.groupKey.localeCompare(right.groupKey);
  });
}

export async function readCanonicalPaymentReport(input: CanonicalPaymentReportInput): Promise<CanonicalPaymentReport> {
  const page = safePage(input.page);
  const limit = safeLimit(input.limit);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    const asOfResult = await tx.execute(sql`SELECT transaction_timestamp()::text AS now`);
    const asOf = String((asOfResult.rows[0] as { now?: string } | undefined)?.now ?? new Date().toISOString());

    const [league] = await tx.select({ id: leagues.id, organizationId: leagues.organizationId, timezone: leagues.timezone })
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
        UNION ALL SELECT 1 FROM payment_occurrence_allocations WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
      ) AS present
    `).then((result) => result.rows as Array<{ present: boolean }>);
    if (!activation && partialEvidence?.present) throw new CanonicalPaymentReportIncompatibilityError();
    if (activation && activation.completeness_marker !== true) throw new CanonicalPaymentReportIncompatibilityError();
    if (activation) {
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
    const parentQuery = () => tx.execute(sql`
      WITH scoped AS (
        SELECT
          p.id,
          p.payment_operation_id,
          p.combined_charge_group_id,
          p.bowler_id,
          COALESCE(MIN(o.start_at), p.week_of) AS business_at
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
          MIN(bowler_id) AS bowler_id
        FROM scoped
        GROUP BY 1
      ), operation_parents AS (
        SELECT
          'operation:' || op.id::text AS parent_key,
          COALESCE(cs.trigger_start_at, osa.business_at, legacy_osa.business_at, op.created_at) AS business_at,
          COALESCE(cs.payer_bowler_id, osa.bowler_id, legacy_osa.bowler_id, 0) AS bowler_id
        FROM payment_operations op
        LEFT JOIN canonical_autopay_execution_snapshots cs ON cs.operation_id = op.id
          AND cs.organization_id = ${input.organizationId} AND cs.league_id = ${input.leagueId}
        LEFT JOIN LATERAL (
          SELECT MIN(o.start_at) AS business_at, MIN(sa.bowler_id) AS bowler_id
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
          AND (op.league_id = ${input.leagueId} OR EXISTS (SELECT 1 FROM scheduled_payment_operation_snapshots scoped_ss WHERE scoped_ss.operation_id = op.id AND scoped_ss.league_id = ${input.leagueId}) OR EXISTS (SELECT 1 FROM interactive_payment_operation_snapshots scoped_is WHERE scoped_is.operation_id = op.id AND scoped_is.league_id = ${input.leagueId}))
          AND op.status IN ('pending','leased','provider_unknown','retry_scheduled','action_required','reconciliation_required')
          AND NOT EXISTS (SELECT 1 FROM payments op_payment WHERE op_payment.payment_operation_id = op.id)
          AND (${input.bowlerId === undefined ? sql`TRUE` : sql`EXISTS (SELECT 1 FROM payment_operation_occurrence_snapshot_allocations participant_sa WHERE participant_sa.operation_id = op.id AND participant_sa.organization_id = ${input.organizationId} AND participant_sa.league_id = ${input.leagueId} AND participant_sa.bowler_id = ${input.bowlerId}) OR cs.items @> jsonb_build_array(jsonb_build_object('bowlerId', ${input.bowlerId})) OR EXISTS (SELECT 1 FROM scheduled_payment_operation_allocations lsa INNER JOIN scheduled_payment_operation_snapshots lss ON lss.operation_id = lsa.operation_id AND lss.league_id = ${input.leagueId} WHERE lsa.operation_id = op.id AND lsa.bowler_id = ${input.bowlerId}) OR EXISTS (SELECT 1 FROM interactive_payment_operation_allocations lia INNER JOIN interactive_payment_operation_snapshots lis ON lis.operation_id = lia.operation_id AND lis.league_id = ${input.leagueId} WHERE lia.operation_id = op.id AND lia.bowler_id = ${input.bowlerId})`})
      )
      SELECT parent_key
      FROM (SELECT * FROM parents UNION ALL SELECT * FROM operation_parents) all_parents
      ORDER BY business_at ASC, bowler_id ASC, parent_key ASC
      LIMIT ${limit} OFFSET ${offset}
    `);
    const parentRows = await parentQuery();
    const parentKeys = parentRows.rows
      .map((row) => String((row as { parent_key: string }).parent_key));
    const scopedBowlerPredicate = input.bowlerId === undefined ? sql`TRUE` : sql`p.bowler_id = ${input.bowlerId}`;
    const scopedOperationPredicate = input.bowlerId === undefined
      ? sql`TRUE`
      : sql`EXISTS (SELECT 1 FROM payment_operation_occurrence_snapshot_allocations scope_sa WHERE scope_sa.operation_id = dop.id AND scope_sa.organization_id = ${input.organizationId} AND scope_sa.league_id = ${input.leagueId} AND scope_sa.bowler_id = ${input.bowlerId}) OR EXISTS (SELECT 1 FROM canonical_autopay_execution_snapshots scope_cs WHERE scope_cs.operation_id = dop.id AND scope_cs.organization_id = ${input.organizationId} AND scope_cs.league_id = ${input.leagueId} AND scope_cs.items @> jsonb_build_array(jsonb_build_object('bowlerId', ${input.bowlerId}))) OR EXISTS (SELECT 1 FROM scheduled_payment_operation_allocations scope_lsa INNER JOIN scheduled_payment_operation_snapshots scope_lss ON scope_lss.operation_id = scope_lsa.operation_id AND scope_lss.league_id = ${input.leagueId} WHERE scope_lsa.operation_id = dop.id AND scope_lsa.bowler_id = ${input.bowlerId}) OR EXISTS (SELECT 1 FROM interactive_payment_operation_allocations scope_lia INNER JOIN interactive_payment_operation_snapshots scope_lis ON scope_lis.operation_id = scope_lia.operation_id AND scope_lis.league_id = ${input.leagueId} WHERE scope_lia.operation_id = dop.id AND scope_lia.bowler_id = ${input.bowlerId})`;
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
        SELECT COUNT(*)::integer AS total_transactions
        FROM (
          SELECT CASE
            WHEN payment_operation_id IS NOT NULL THEN 'operation:' || payment_operation_id::text
            WHEN combined_charge_group_id IS NOT NULL THEN 'combined:' || combined_charge_group_id::text
            ELSE 'payment:' || id::text
          END AS parent_key
          FROM scoped_payments
          GROUP BY 1
        ) grouped_parents
      )
      SELECT
        (SELECT COUNT(*)::integer FROM scoped_payments)
          + COALESCE((SELECT COUNT(*) FROM payment_operation_occurrence_snapshot_allocations sa
            INNER JOIN payment_operations sop ON sop.id = sa.operation_id AND sop.organization_id = ${input.organizationId} AND sop.league_id = ${input.leagueId}
            WHERE sop.status IN ('pending','leased','provider_unknown','retry_scheduled','action_required','reconciliation_required')
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
        (SELECT total_transactions FROM parent_totals)
          + (SELECT COUNT(*) FROM payment_operations op WHERE op.organization_id = ${input.organizationId} AND op.league_id = ${input.leagueId} AND op.status IN ('pending','leased','provider_unknown','retry_scheduled','action_required','reconciliation_required') AND NOT EXISTS (SELECT 1 FROM payments p2 WHERE p2.payment_operation_id = op.id) AND (${input.bowlerId === undefined ? sql`TRUE` : sql`EXISTS (SELECT 1 FROM payment_operation_occurrence_snapshot_allocations scope_sa WHERE scope_sa.operation_id = op.id AND scope_sa.organization_id = ${input.organizationId} AND scope_sa.league_id = ${input.leagueId} AND scope_sa.bowler_id = ${input.bowlerId}) OR EXISTS (SELECT 1 FROM canonical_autopay_execution_snapshots scope_cs WHERE scope_cs.operation_id = op.id AND scope_cs.organization_id = ${input.organizationId} AND scope_cs.league_id = ${input.leagueId} AND scope_cs.items @> jsonb_build_array(jsonb_build_object('bowlerId', ${input.bowlerId})))`}))
          + (SELECT COUNT(*) FROM payment_operations lop WHERE lop.organization_id = ${input.organizationId} AND (lop.league_id = ${input.leagueId} OR EXISTS (SELECT 1 FROM scheduled_payment_operation_snapshots lsx WHERE lsx.operation_id = lop.id AND lsx.league_id = ${input.leagueId}) OR EXISTS (SELECT 1 FROM interactive_payment_operation_snapshots lix WHERE lix.operation_id = lop.id AND lix.league_id = ${input.leagueId})) AND lop.operation_type IN ('scheduled_charge','interactive_charge') AND lop.status IN ('pending','leased','provider_unknown','retry_scheduled','action_required','reconciliation_required') AND NOT EXISTS (SELECT 1 FROM payments p2 WHERE p2.payment_operation_id = lop.id) AND ((${input.bowlerId === undefined ? sql`TRUE` : sql`EXISTS (SELECT 1 FROM scheduled_payment_operation_allocations lpa INNER JOIN scheduled_payment_operation_snapshots lps ON lps.operation_id = lpa.operation_id AND lps.league_id = ${input.leagueId} WHERE lpa.operation_id = lop.id AND lpa.bowler_id = ${input.bowlerId}) OR EXISTS (SELECT 1 FROM interactive_payment_operation_allocations lpa INNER JOIN interactive_payment_operation_snapshots lps ON lps.operation_id = lpa.operation_id AND lps.league_id = ${input.leagueId} WHERE lpa.operation_id = lop.id AND lpa.bowler_id = ${input.bowlerId})`}) ))::integer AS total_transactions,
        COALESCE((SELECT SUM(p.amount) FROM scoped_payments p WHERE p.status = 'paid' AND ${activation ? sql`EXISTS (SELECT 1 FROM payment_occurrence_allocations ca WHERE ca.payment_id = p.id AND ca.organization_id = ${input.organizationId} AND ca.league_id = ${input.leagueId})` : sql`TRUE`} AND (p.payment_operation_id IS NULL OR NOT EXISTS (SELECT 1 FROM payment_operations op WHERE op.id = p.payment_operation_id AND op.status IN ('pending','leased','provider_unknown','retry_scheduled','action_required','reconciliation_required'))) AND NOT EXISTS (SELECT 1 FROM payment_disputes pd WHERE pd.payment_operation_id = p.payment_operation_id)), 0)::integer AS gross_paid,
        COALESCE((SELECT SUM(a.amount_minor) FROM payment_occurrence_allocations a INNER JOIN scoped_payments p ON p.id = a.payment_id WHERE a.organization_id = ${input.organizationId} AND a.league_id = ${input.leagueId} AND a.state = 'active'), 0)::integer AS allocated,
        COALESCE((SELECT SUM(p.amount) FROM scoped_payments p WHERE p.status = 'refunded' AND ${activation ? sql`EXISTS (SELECT 1 FROM payment_occurrence_allocations ca WHERE ca.payment_id = p.id AND ca.organization_id = ${input.organizationId} AND ca.league_id = ${input.leagueId})` : sql`TRUE`}), 0)::integer AS refunded,
        COALESCE((SELECT SUM(amount) FROM scoped_payments WHERE status = 'disputed' AND payment_operation_id IS NULL), 0)::integer
          + COALESCE((SELECT SUM(pd.amount_minor) FROM payment_disputes pd INNER JOIN payment_operations dop ON dop.id = pd.payment_operation_id AND dop.organization_id = ${input.organizationId} AND dop.league_id = ${input.leagueId} WHERE pd.organization_id = ${input.organizationId} AND (${scopedOperationPredicate})), 0)::integer AS disputed,
        COALESCE((SELECT SUM(op.amount_minor) FROM payment_operations op WHERE op.organization_id = ${input.organizationId} AND (op.league_id = ${input.leagueId} OR EXISTS (SELECT 1 FROM scheduled_payment_operation_snapshots uss WHERE uss.operation_id = op.id AND uss.league_id = ${input.leagueId}) OR EXISTS (SELECT 1 FROM interactive_payment_operation_snapshots uis WHERE uis.operation_id = op.id AND uis.league_id = ${input.leagueId})) AND op.status IN ('pending','leased','provider_unknown','retry_scheduled','action_required','reconciliation_required') AND (${input.bowlerId === undefined ? sql`TRUE` : sql`EXISTS (SELECT 1 FROM payment_operation_occurrence_snapshot_allocations sb WHERE sb.operation_id = op.id AND sb.organization_id = ${input.organizationId} AND sb.league_id = ${input.leagueId} AND sb.bowler_id = ${input.bowlerId}) OR EXISTS (SELECT 1 FROM scheduled_payment_operation_allocations usb INNER JOIN scheduled_payment_operation_snapshots usbs ON usbs.operation_id = usb.operation_id AND usbs.league_id = ${input.leagueId} WHERE usb.operation_id = op.id AND usb.bowler_id = ${input.bowlerId}) OR EXISTS (SELECT 1 FROM interactive_payment_operation_allocations uib INNER JOIN interactive_payment_operation_snapshots uibs ON uibs.operation_id = uib.operation_id AND uibs.league_id = ${input.leagueId} WHERE uib.operation_id = op.id AND uib.bowler_id = ${input.bowlerId})`})), 0)::integer AS unresolved,
        COALESCE((SELECT SUM(p.amount) FROM scoped_payments p WHERE p.status = 'paid' AND NOT EXISTS (SELECT 1 FROM payment_occurrence_allocations a WHERE a.payment_id = p.id AND a.organization_id = ${input.organizationId} AND a.league_id = ${input.leagueId})), 0)::integer AS unallocated_legacy,
        COALESCE((SELECT SUM(p.amount) FROM scoped_payments p WHERE (p.status NOT IN ('paid','pending','refunded','disputed') OR (p.status = 'disputed' AND p.payment_operation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM payment_disputes legacy_pd WHERE legacy_pd.payment_operation_id = p.payment_operation_id))) AND NOT EXISTS (SELECT 1 FROM payment_operations rop WHERE rop.id = p.payment_operation_id AND rop.status IN ('action_required','provider_unknown','reconciliation_required'))), 0)::integer AS review_required,
        (SELECT COUNT(*)::integer FROM scoped_payments p WHERE NOT EXISTS (SELECT 1 FROM payment_occurrence_allocations a WHERE a.payment_id = p.id AND a.organization_id = ${input.organizationId} AND a.league_id = ${input.leagueId}))
          + (SELECT COUNT(*)::integer FROM payment_operations lop
             WHERE lop.organization_id = ${input.organizationId} AND (lop.league_id = ${input.leagueId} OR EXISTS (SELECT 1 FROM scheduled_payment_operation_snapshots lscope_s WHERE lscope_s.operation_id = lop.id AND lscope_s.league_id = ${input.leagueId}) OR EXISTS (SELECT 1 FROM interactive_payment_operation_snapshots lscope_i WHERE lscope_i.operation_id = lop.id AND lscope_i.league_id = ${input.leagueId}))
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
          AND op.league_id = ${input.leagueId}
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
         AND cs.organization_id = op.organization_id
         AND cs.league_id = op.league_id
        WHERE op.organization_id = ${input.organizationId}
          AND op.league_id = ${input.leagueId}
          AND op.operation_type = 'canonical_autopay_charge'
          AND (cs.operation_id IS NULL OR cs.amount_minor IS DISTINCT FROM op.amount_minor OR cs.currency IS DISTINCT FROM op.currency OR cs.trigger_occurrence_id IS DISTINCT FROM op.trigger_occurrence_id)
        UNION ALL
        SELECT 1
        FROM payment_operations op
        LEFT JOIN payment_operation_occurrence_snapshots os
          ON os.operation_id = op.id
         AND os.organization_id = op.organization_id
         AND os.league_id = op.league_id
        WHERE op.organization_id = ${input.organizationId}
          AND op.league_id = ${input.leagueId}
          AND op.operation_type IN ('scheduled_charge', 'interactive_charge')
          AND os.operation_id IS NOT NULL
          AND (os.amount_minor IS DISTINCT FROM op.amount_minor OR os.currency IS DISTINCT FROM op.currency)
      ) AS present
    `).then((result) => result.rows as Array<{ present: boolean }>);
    if (globalOperationEvidence?.present) throw new CanonicalPaymentReportIncompatibilityError();
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
    const allocations = paymentIds.length === 0 ? [] : await tx.select().from(paymentOccurrenceAllocations).where(and(
      eq(paymentOccurrenceAllocations.organizationId, input.organizationId),
      eq(paymentOccurrenceAllocations.leagueId, input.leagueId),
      inArray(paymentOccurrenceAllocations.paymentId, paymentIds),
    )).orderBy(asc(paymentOccurrenceAllocations.occurrenceId), asc(paymentOccurrenceAllocations.bowlerId), asc(paymentOccurrenceAllocations.id));
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
    const linkedScopeByOperation = new Map([...linkedLegacyScopeRows, ...linkedScheduledScopeRows].map((row) => [row.operationId, row.leagueId]));
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
    const occurrences = occurrenceIds.length === 0 ? [] : await tx.select({ id: leagueOccurrences.id, startAt: leagueOccurrences.startAt })
      .from(leagueOccurrences)
      .where(and(
        eq(leagueOccurrences.organizationId, input.organizationId),
        eq(leagueOccurrences.leagueId, input.leagueId),
        inArray(leagueOccurrences.id, occurrenceIds),
      ));
    if (occurrences.length !== occurrenceIds.length) throw new CanonicalPaymentReportIncompatibilityError();
    const occurrenceStartById = new Map(occurrences.map((occurrence) => [occurrence.id, occurrence.startAt]));

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

    const rows: CanonicalPaymentRow[] = paymentRows.map((payment) => {
      const paymentAllocations = allocationsByPayment.get(payment.id) ?? [];
      const operation = payment.paymentOperationId ? operationsById.get(payment.paymentOperationId) : undefined;
      const startTimes = paymentAllocations.map((allocation) => occurrenceStartById.get(allocation.occurrenceId)).filter((value): value is string => !!value).sort();
      const businessDate = startTimes[0] ?? (operation ? legacyBusinessDates.get(operation.id) : undefined) ?? payment.weekOf;
      const refund = { present: payment.status === "refunded" || payment.squareRefundId !== null, amountMinor: payment.status === "refunded" ? payment.amount : 0, providerRefundId: payment.squareRefundId };
      const durableDispute = operation ? disputesByOperation.get(operation.id) : undefined;
      if (payment.status === "disputed" && operation && !durableDispute && paymentAllocations.length > 0) throw new CanonicalPaymentReportIncompatibilityError();
      const activeAllocatedMinor = paymentAllocations.filter((allocation) => allocation.state === "active").reduce((sum, allocation) => sum + allocation.amountMinor, 0);
      const dispute = { present: payment.status === "disputed" || Boolean(durableDispute), amountMinor: durableDispute ? 0 : (payment.status === "disputed" ? Math.min(payment.amount, activeAllocatedMinor || payment.amount) : 0), disputeId: durableDispute?.disputeId ?? payment.disputeId };
      const unresolved = !!operation && unresolvedOperationStatuses.has(operation.status);
      const reviewRequired = dispute.present || (payment.status !== "paid" && payment.status !== "pending") || unresolved;
      const status = statusForPayment(payment, operation, disputedOperationIds.has(operation?.id ?? ""));
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
          sharedTransaction: operation ? { groupKey: `operation:${operation.id}`, childCount: paymentRows.filter((row) => row.paymentOperationId === operation.id).length } : null,
        }),
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
        dispute: { present: false, amountMinor: 0, disputeId: null },
        unresolved: true,
        receipt: paymentReceiptContract({ receiptUrl: null, receiptNumber: null, organizationId: input.organizationId, leagueId: input.leagueId, paymentId: null, paymentOperationId: operation.id, operationStatus: operation.status, amountMinor: participant.amountMinor, currency: operation.currency, evidenceStatus: "unresolved", source: participant.source === "unlinked_legacy" ? "unlinked_legacy" : "unresolved_operation", allocations: [participant], unresolved: true }),
        allocations: [participant],
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
    const sortedRows = [...visibleRows].sort((left, right) => left.authoritativeLocalDate.localeCompare(right.authoritativeLocalDate) || left.bowlerId - right.bowlerId || String(left.paymentOperationId ?? left.paymentId).localeCompare(String(right.paymentOperationId ?? right.paymentId)));
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
      rows: pagedRows,
      transactions: pagedTransactions,
      unlinkedHistory: pagedUnlinkedHistory,
    };
    return { ...withoutFingerprint, fingerprint: canonicalPaymentReportFingerprint(withoutFingerprint) };
  });
}
