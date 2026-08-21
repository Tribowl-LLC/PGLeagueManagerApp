import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  bowlerOccurrenceEligibilities,
  bowlerOccurrenceEligibilityRevisions,
  bowlerOccurrenceObligationRevisions,
  bowlerOccurrenceObligations,
  bowlerOccurrenceTeamAssignments,
  bowlerOccurrenceTeamAssignmentRevisions,
  bowlers,
  financialActivationRevisions,
  financialActivations,
  financialActivationCancellationSuppressions,
  financialResponsibilities,
  leagueOccurrenceBillingTerms,
  leagueOccurrenceBillingTermRevisions,
  leagueOccurrences,
  leagues,
  bowlerLeagues,
  paymentDisputes,
  paymentOccurrenceAllocations,
  paymentOccurrenceAllocationRevisions,
  payments,
  occurrenceCollectionPlans,
  occurrenceCollectionPlanItems,
  teams,
  users,
  FINANCIAL_ACTIVATION_FINGERPRINT_PREFIX,
  FINANCIAL_SOURCE_FINGERPRINT_PREFIX,
  FINANCIAL_ACTIVATION_VERSION,
  FINANCIAL_READ_CONTRACT_VERSION,
  FINANCIAL_READ_FINGERPRINT_PREFIX,
  type FinancialResponsibilityRole,
} from "@shared/schema";
import { db } from "../db.js";
import { calculateBowlerLegacySummary } from "@shared/financial-utils";
import { loadLeagueOccurrenceScheduleSnapshot, type ScheduleExecutor } from "./league-occurrence-schedule.js";
import { FINANCIAL_ACTIVATION_CANCELLATION_SUPPRESSION_VERSION, FINANCIAL_ACTIVATION_ORDER_VERSION, FINANCIAL_ACTIVATION_POLICY_VERSION, FINANCIAL_ACTIVATION_RESPONSIBILITY_FINGERPRINT_VERSION } from "@shared/schema/financial-activation";
import { FINANCIAL_READ_ORDER_VERSION, type FinancialReadRowContract, type FinancialReadContract } from "@shared/financial-contract";

export const WEEKLY_PAST_DUE_GRACE_MS = 3 * 60 * 60 * 1000;
export const CANONICAL_DUE_PAST_DUE_ORDER_VERSION = FINANCIAL_READ_ORDER_VERSION;

type RevisionEvidence = {
  id: string;
  revisionNumber: number;
  snapshotSchemaVersion: number;
  beforeSnapshot: unknown;
  afterSnapshot: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameInstant(left: unknown, right: unknown): boolean {
  if (typeof left !== "string" || typeof right !== "string") return left === right;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) ? leftMs === rightMs : left === right;
}

function revisionsCoverCurrentState(
  parents: ReadonlyArray<{ id: string; currentRevision: number }>,
  revisions: ReadonlyArray<RevisionEvidence>,
  matchesLatest: (snapshot: Record<string, unknown>, parentId: string) => boolean,
): boolean {
  if (parents.length === 0) return revisions.length === 0;
  const byParent = new Map<string, RevisionEvidence[]>();
  for (const revision of revisions) {
    const list = byParent.get(revision.id) ?? [];
    list.push(revision);
    byParent.set(revision.id, list);
  }
  return parents.every((parent) => {
    const rows = byParent.get(parent.id) ?? [];
    if (rows.length !== parent.currentRevision) return false;
    const numbers = new Set(rows.map((row) => row.revisionNumber));
    for (let revisionNumber = 1; revisionNumber <= parent.currentRevision; revisionNumber += 1) {
      if (!numbers.has(revisionNumber)) return false;
    }
    const latest = rows.find((row) => row.revisionNumber === parent.currentRevision);
    if (!latest || latest.snapshotSchemaVersion !== FINANCIAL_ACTIVATION_VERSION || !isRecord(latest.afterSnapshot)) return false;
    return matchesLatest(latest.afterSnapshot, parent.id);
  });
}

export type DuePastDueClassification = "future" | "due" | "past_due" | "settled" | "voided" | "review_required";

export interface TimingInput {
  paymentMode: "weekly" | "upfront";
  occurrenceStartAt: string | Date;
  activationDueAt?: string | Date | null;
}

export interface TimingResult {
  dueAt: string;
  pastDueAt: string;
}

export function calculateCanonicalTiming(input: TimingInput): TimingResult {
  const due = input.paymentMode === "upfront"
    ? input.activationDueAt
    : input.occurrenceStartAt;
  if (!due) throw new Error("upfront activation due instant is required");
  const dueDate = new Date(due);
  if (!Number.isFinite(dueDate.getTime())) throw new Error("invalid canonical due instant");
  const pastDue = input.paymentMode === "upfront"
    ? dueDate
    : new Date(dueDate.getTime() + WEEKLY_PAST_DUE_GRACE_MS);
  return { dueAt: dueDate.toISOString(), pastDueAt: pastDue.toISOString() };
}

export function classifyCanonicalTiming(
  timing: TimingResult,
  now: Date = new Date(),
): Exclude<DuePastDueClassification, "settled" | "voided" | "review_required"> {
  if (now.getTime() < new Date(timing.dueAt).getTime()) return "future";
  if (now.getTime() < new Date(timing.pastDueAt).getTime()) return "due";
  return "past_due";
}

export interface ResponsibilityInput {
  occurrenceId: string;
  teamId: number;
  slotIndex: number;
  bowlerId: number;
  role: FinancialResponsibilityRole;
  provenance: string;
}

export interface ResponsibilityExpectedRow {
  occurrenceId: string;
  teamId: number;
  billingTermId: string;
  billingTermVersion: number;
  billingTermRevision: number;
  occurrenceRevision: number;
  amountMinor: number;
  currency: string;
  paymentMode: "weekly" | "upfront";
  occurrenceStartAt: string;
  occurrenceKind?: "regular" | "makeup" | "position_round" | "rolloff" | "playoff" | "extension";
  occurrenceStatus?: "scheduled" | "completed" | "cancelled";
  lifecycle?: "published" | "locked";
  obligationPolicy?: "eligible_bowlers";
}

export function validateResponsibilityMatrix(
  expected: ResponsibilityExpectedRow[],
  selected: ResponsibilityInput[],
  payingLineupSize: 3 | 4 = 3,
): string[] {
  const errors: string[] = [];
  const expectedKeys = new Set(expected.map((row) => `${row.occurrenceId}:${row.teamId}`));
  const grouped = new Map<string, ResponsibilityInput[]>();
  for (const row of selected) {
    if (!Number.isInteger(row.slotIndex) || row.slotIndex < 0 || row.slotIndex > 3) errors.push("invalid_slot");
    if (row.provenance !== "explicit_admin_selection") errors.push("invalid_provenance");
    const key = `${row.occurrenceId}:${row.teamId}`;
    const rows = grouped.get(key) ?? [];
    rows.push(row);
    grouped.set(key, rows);
  }
  for (const key of expectedKeys) {
    const rows = grouped.get(key) ?? [];
    if (rows.length !== payingLineupSize) errors.push(`lineup_size:${key}`);
    const slots = rows.map((row) => row.slotIndex).sort((a, b) => a - b);
    if (new Set(slots).size !== slots.length || slots.some((slot, i) => slot !== i)) errors.push(`slots:${key}`);
    if (new Set(rows.map((row) => row.bowlerId)).size !== rows.length) errors.push(`duplicate_bowler:${key}`);
    if (rows.some((row) => row.role !== "regular" && row.role !== "substitute")) errors.push(`role:${key}`);
  }
  for (const key of grouped.keys()) if (!expectedKeys.has(key)) errors.push(`unexpected_lineup:${key}`);
  const occurrenceBowlers = new Set<string>();
  for (const row of selected) {
    const key = `${row.occurrenceId}:${row.bowlerId}`;
    if (occurrenceBowlers.has(key)) errors.push(`duplicate_occurrence_bowler:${key}`);
    occurrenceBowlers.add(key);
  }
  return [...new Set(errors)].sort();
}

function stableCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableCanonicalJson(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableCanonicalJson(record[key])}`).join(",")}}`;
}

function billingTermRevisionMatchesCurrent(
  snapshot: Record<string, unknown>,
  term: {
    billingTermId: string;
    organizationId: number;
    leagueId: number;
    occurrenceId: string;
    purpose: string;
    obligationPolicy: string;
    amountMinor: number;
    currency: string;
    billingOrdinal: number | null;
    billingTermVersion: number;
    state: string;
    billingTermRevision: number;
    lastCommandId: string | null;
  },
): boolean {
  const contractVersion = snapshot.snapshotContractVersion;
  if (contractVersion !== undefined && contractVersion !== "fall-draft-billing-term-revision/1" && contractVersion !== "completed-summer-billing-term-revision/1") return false;
  const expected = {
    id: term.billingTermId,
    organizationId: term.organizationId,
    leagueId: term.leagueId,
    occurrenceId: term.occurrenceId,
    purpose: term.purpose,
    obligationPolicy: term.obligationPolicy,
    defaultAmountMinor: term.amountMinor,
    currency: term.currency,
    billingOrdinal: term.billingOrdinal,
    version: term.billingTermVersion,
    state: term.state,
    currentRevision: term.billingTermRevision,
    lastCommandId: term.lastCommandId,
  } as const;
  const identityFields = Object.keys(expected) as Array<keyof typeof expected>;
  const hasFullIdentity = identityFields.every((field) => Object.prototype.hasOwnProperty.call(snapshot, field));
  return hasFullIdentity && identityFields.every((field) => stableCanonicalJson(snapshot[field]) === stableCanonicalJson(expected[field]));
}

function fingerprint(prefix: string, value: unknown): string {
  const digest = createHash("sha256").update(stableCanonicalJson(value)).digest("hex");
  return `${prefix}${digest}`;
}

function normalizeResponsibilities(rows: ResponsibilityInput[]): ResponsibilityInput[] {
  return [...rows].sort((left, right) =>
    left.occurrenceId.localeCompare(right.occurrenceId)
    || left.teamId - right.teamId
    || left.slotIndex - right.slotIndex
    || left.bowlerId - right.bowlerId,
  ).map((row) => ({
    occurrenceId: row.occurrenceId,
    teamId: row.teamId,
    slotIndex: row.slotIndex,
    bowlerId: row.bowlerId,
    role: row.role,
    provenance: row.provenance.trim(),
  }));
}

function activationRequestFingerprint(input: { organizationId: number; leagueId: number; sourceFingerprint: string; paymentMode: "weekly" | "upfront"; payingLineupSize: 3 | 4; responsibilities: ResponsibilityInput[] }): string {
  return fingerprint(FINANCIAL_ACTIVATION_FINGERPRINT_PREFIX, {
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    activationVersion: FINANCIAL_ACTIVATION_VERSION,
    contractVersion: FINANCIAL_READ_CONTRACT_VERSION,
    policyVersion: FINANCIAL_ACTIVATION_POLICY_VERSION,
    orderVersion: FINANCIAL_ACTIVATION_ORDER_VERSION,
    paymentMode: input.paymentMode,
    payingLineupSize: input.payingLineupSize,
    sourceFingerprint: input.sourceFingerprint,
    responsibilities: normalizeResponsibilities(input.responsibilities),
  });
}

export function canonicalReadFingerprint(rows: Array<Record<string, unknown>>): string {
  return fingerprint(FINANCIAL_READ_FINGERPRINT_PREFIX, rows);
}

export type FinancialReadRow = FinancialReadRowContract;
export type CanonicalDuePastDueRead = FinancialReadContract;

export class FinancialReadIncompatibilityError extends Error {
  constructor() {
    super("canonical financial evidence is incompatible");
    this.name = "FinancialReadIncompatibilityError";
  }
}

export async function readCanonicalDuePastDue(input: {
  organizationId: number;
  leagueId: number;
  bowlerId?: number;
  now?: Date;
}): Promise<CanonicalDuePastDueRead> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    const asOfResult = await tx.execute(sql`SELECT transaction_timestamp()::text AS now`);
    const asOf = (asOfResult.rows[0] as { now?: string } | undefined)?.now ?? now.toISOString();
    const effectiveNow = input.now ?? new Date(asOf);
    const [activation] = await tx.select().from(financialActivations).where(and(
      eq(financialActivations.organizationId, input.organizationId),
      eq(financialActivations.leagueId, input.leagueId),
      eq(financialActivations.state, "active"),
      eq(financialActivations.completenessMarker, true),
    )).limit(1);
    if (!activation) {
      let source;
      try { source = await loadOperationalActivationSource(tx, { organizationId: input.organizationId, leagueId: input.leagueId }); }
      catch { throw new FinancialReadIncompatibilityError(); }
      const partialEvidence = await tx.execute(sql`SELECT EXISTS (
        SELECT 1 FROM bowler_occurrence_eligibilities WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
        UNION ALL SELECT 1 FROM bowler_occurrence_team_assignments WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
        UNION ALL SELECT 1 FROM bowler_occurrence_obligations WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
        UNION ALL SELECT 1 FROM occurrence_collection_plans WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
        UNION ALL SELECT 1 FROM occurrence_collection_plan_items WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
        UNION ALL SELECT 1 FROM payment_occurrence_allocations WHERE organization_id = ${input.organizationId} AND league_id = ${input.leagueId}
      ) AS present`);
      if ((partialEvidence.rows[0] as { present?: boolean } | undefined)?.present) throw new FinancialReadIncompatibilityError();
      const [legacyLeague] = await tx.select().from(leagues).where(and(eq(leagues.id, input.leagueId), eq(leagues.organizationId, input.organizationId))).limit(1);
      if (!legacyLeague) {
        return {
          organizationId: input.organizationId,
          leagueId: input.leagueId,
          contractVersion: FINANCIAL_READ_CONTRACT_VERSION,
          orderVersion: CANONICAL_DUE_PAST_DUE_ORDER_VERSION,
          mode: "unavailable",
          activationId: null,
          authoritativeSource: "none",
          asOf,
          fingerprint: canonicalReadFingerprint([{ organizationId: input.organizationId, leagueId: input.leagueId, mode: "unavailable", contractVersion: FINANCIAL_READ_CONTRACT_VERSION, orderVersion: CANONICAL_DUE_PAST_DUE_ORDER_VERSION }]),
          rows: [],
          unavailableReason: "incomplete_evidence",
          totals: { amountMinor: 0, allocatedMinor: 0, outstandingMinor: 0, collectiblePastDueMinor: 0, reviewCount: 0 },
        };
      }
      const legacyMembers = await tx.select({ bowlerId: bowlerLeagues.bowlerId }).from(bowlerLeagues)
        .innerJoin(bowlers, and(eq(bowlers.id, bowlerLeagues.bowlerId), eq(bowlers.organizationId, input.organizationId), eq(bowlers.active, true)))
        .where(and(eq(bowlerLeagues.leagueId, input.leagueId), eq(bowlerLeagues.active, true), ...(input.bowlerId === undefined ? [] : [eq(bowlerLeagues.bowlerId, input.bowlerId)])));
      const legacyRows = await tx.select({ bowlerId: payments.bowlerId, amount: payments.amount, status: payments.status, weekOf: payments.weekOf })
        .from(payments)
        .innerJoin(bowlers, and(eq(bowlers.id, payments.bowlerId), eq(bowlers.organizationId, input.organizationId), eq(bowlers.active, true)))
        .innerJoin(bowlerLeagues, and(eq(bowlerLeagues.bowlerId, payments.bowlerId), eq(bowlerLeagues.leagueId, input.leagueId), eq(bowlerLeagues.active, true)))
        .where(and(eq(payments.leagueId, input.leagueId), ...(input.bowlerId === undefined ? [] : [eq(payments.bowlerId, input.bowlerId)])));
      const byBowler = new Map<number, { paid: number; weekOf: string }>(legacyMembers.map((row) => [row.bowlerId, { paid: 0, weekOf: "9999-12-31" }]));
      for (const payment of legacyRows) {
        const current = byBowler.get(payment.bowlerId) ?? { paid: 0, weekOf: payment.weekOf };
        if (payment.status === "paid") current.paid += payment.amount;
        if (payment.weekOf < current.weekOf) current.weekOf = payment.weekOf;
        byBowler.set(payment.bowlerId, current);
      }
      const fallbackRows: FinancialReadRow[] = [...byBowler.entries()].map(([bowlerId, value]) => {
        const summary = calculateBowlerLegacySummary(legacyLeague, value.paid, effectiveNow);
        const classification: DuePastDueClassification = summary.amountPastDue > 0 ? "past_due" : "settled";
        return {
          obligationId: null,
          occurrenceId: null,
          bowlerId,
          teamId: null,
          amountMinor: summary.totalDueToDate,
          allocatedMinor: 0,
          outstandingMinor: summary.amountPastDue,
          dueAt: null,
          pastDueAt: null,
          classification,
          state: "legacy" as const,
          evidenceSource: "legacy_fallback" as const,
          reviewRequired: false,
          reviewCategory: null,
          incompatibleEvidence: false,
          legacyWeekOf: value.weekOf === "9999-12-31" ? null : value.weekOf,
          legacyPaidMinor: value.paid,
          legacyDueToDateMinor: summary.totalDueToDate,
        };
      }).sort((left, right) => left.bowlerId - right.bowlerId);
      const totalPaidMinor = [...byBowler.values()].reduce((sum, value) => sum + value.paid, 0);
      const legacyFallback = {
        helperVersion: "shared-financial-utils/1" as const,
        totalPaidMinor,
        amountPastDueMinor: fallbackRows.reduce((sum, row) => sum + row.outstandingMinor, 0),
        totalDueToDateMinor: fallbackRows.reduce((sum, row) => sum + (row.legacyDueToDateMinor ?? 0), 0),
        fullSeasonAmountMinor: [...byBowler.entries()].reduce((sum, [, value]) => sum + calculateBowlerLegacySummary(legacyLeague, value.paid, effectiveNow).fullSeasonAmount, 0),
        remainingBalanceMinor: [...byBowler.entries()].reduce((sum, [, value]) => sum + calculateBowlerLegacySummary(legacyLeague, value.paid, effectiveNow).remainingBalance, 0),
        totalWeeksInSeason: calculateBowlerLegacySummary(legacyLeague, 0, effectiveNow).totalWeeksInSeason,
      };
      const legacyTotals = {
        amountMinor: fallbackRows.reduce((sum, row) => sum + row.amountMinor, 0),
        allocatedMinor: 0,
        outstandingMinor: fallbackRows.reduce((sum, row) => sum + row.outstandingMinor, 0),
        collectiblePastDueMinor: fallbackRows.reduce((sum, row) => sum + row.outstandingMinor, 0),
        reviewCount: 0,
      };
      return {
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        contractVersion: FINANCIAL_READ_CONTRACT_VERSION,
        orderVersion: CANONICAL_DUE_PAST_DUE_ORDER_VERSION,
        mode: "legacy_fallback",
        activationId: null,
        authoritativeSource: "legacy_helper",
          fingerprint: canonicalReadFingerprint([{ organizationId: input.organizationId, leagueId: input.leagueId, mode: "legacy_fallback", contractVersion: FINANCIAL_READ_CONTRACT_VERSION, orderVersion: CANONICAL_DUE_PAST_DUE_ORDER_VERSION, source: source.authoritativeSource, rows: fallbackRows, totals: legacyTotals, legacyFallback }]),
          asOf,
        rows: fallbackRows,
        unavailableReason: "not_activated",
          totals: legacyTotals,
          legacyFallback,
      };
    }
    const evidence = await loadOperationalActivationEvidence(tx, { organizationId: input.organizationId, leagueId: input.leagueId });
    const expected = evidence.expected;
    if (expected.length === 0 || activation.expectedGroupCount !== expected.length
      || activation.expectedResponsibilityCount !== expected.length * activation.payingLineupSize
      || activation.sourceFingerprint !== evidence.sourceFingerprint) {
      throw new FinancialReadIncompatibilityError();
    }
    const activationRevisions = await tx.select({
      id: financialActivationRevisions.activationId,
      revisionNumber: financialActivationRevisions.revisionNumber,
      snapshotSchemaVersion: financialActivationRevisions.snapshotSchemaVersion,
      beforeSnapshot: financialActivationRevisions.beforeSnapshot,
      afterSnapshot: financialActivationRevisions.afterSnapshot,
    }).from(financialActivationRevisions).where(and(
      eq(financialActivationRevisions.organizationId, input.organizationId),
      eq(financialActivationRevisions.leagueId, input.leagueId),
      eq(financialActivationRevisions.activationId, activation.id),
    ));
    if (!revisionsCoverCurrentState(
      [{ id: activation.id, currentRevision: activation.currentRevision }],
      activationRevisions,
      (snapshot) => snapshot.activationVersion === activation.activationVersion
        && snapshot.policyVersion === activation.policyVersion
        && snapshot.orderVersion === activation.orderVersion
        && snapshot.requestFingerprint === activation.requestFingerprint
        && snapshot.sourceFingerprint === activation.sourceFingerprint
        && snapshot.payingLineupSize === activation.payingLineupSize
        && snapshot.expectedGroupCount === activation.expectedGroupCount
        && snapshot.expectedResponsibilityCount === activation.expectedResponsibilityCount,
    )) throw new FinancialReadIncompatibilityError();
    const activationResponsibilities = await tx.select().from(financialResponsibilities).where(and(
      eq(financialResponsibilities.organizationId, input.organizationId),
      eq(financialResponsibilities.leagueId, input.leagueId),
      eq(financialResponsibilities.activationId, activation.id),
    )).orderBy(asc(financialResponsibilities.occurrenceId), asc(financialResponsibilities.teamId), asc(financialResponsibilities.slotIndex), asc(financialResponsibilities.id));
    const groupMap = new Map<string, typeof activationResponsibilities>();
    for (const row of activationResponsibilities) {
      const key = `${row.occurrenceId}:${row.teamId}`;
      groupMap.set(key, [...(groupMap.get(key) ?? []), row]);
    }
    if (activationResponsibilities.length === 0 || activationResponsibilities.length !== activation.expectedResponsibilityCount || new Set(activationResponsibilities.map((row) => row.obligationId)).size !== activationResponsibilities.length || groupMap.size !== activation.expectedGroupCount
      || [...groupMap.values()].some((rows) => {
        const size = rows[0]?.payingLineupSize;
        return size !== activation.payingLineupSize || rows.length !== activation.payingLineupSize || rows.some((row, index) => row.slotIndex !== index);
      })) throw new FinancialReadIncompatibilityError();
    const activationSnapshot = activationRevisions.find((row) => row.revisionNumber === activation.currentRevision);
    const snapshotResponsibilities = isRecord(activationSnapshot?.afterSnapshot) && Array.isArray(activationSnapshot.afterSnapshot.responsibilities)
      ? activationSnapshot.afterSnapshot.responsibilities
      : [];
    const responsibilitySemantics = activationResponsibilities.map((row) => ({ occurrenceId: row.occurrenceId, teamId: row.teamId, slotIndex: row.slotIndex, bowlerId: row.bowlerId, role: row.role, provenance: row.provenance }));
    if (stableCanonicalJson(snapshotResponsibilities) !== stableCanonicalJson(responsibilitySemantics)) throw new FinancialReadIncompatibilityError();
    const linkedEvidence = await tx.select({ eligibilityId: financialResponsibilities.eligibilityId, assignmentId: financialResponsibilities.assignmentId, occurrenceId: financialResponsibilities.occurrenceId, teamId: financialResponsibilities.teamId, bowlerId: financialResponsibilities.bowlerId, provenance: financialResponsibilities.provenance, eligibilityState: bowlerOccurrenceEligibilities.state, eligibilityReason: bowlerOccurrenceEligibilities.reason, eligibilityRevision: bowlerOccurrenceEligibilities.currentRevision, assignmentState: bowlerOccurrenceTeamAssignments.state, assignmentReason: bowlerOccurrenceTeamAssignments.reason, assignmentRevision: bowlerOccurrenceTeamAssignments.currentRevision })
      .from(financialResponsibilities)
      .innerJoin(bowlerOccurrenceEligibilities, and(eq(bowlerOccurrenceEligibilities.id, financialResponsibilities.eligibilityId), eq(bowlerOccurrenceEligibilities.organizationId, financialResponsibilities.organizationId), eq(bowlerOccurrenceEligibilities.leagueId, financialResponsibilities.leagueId), eq(bowlerOccurrenceEligibilities.occurrenceId, financialResponsibilities.occurrenceId), eq(bowlerOccurrenceEligibilities.bowlerId, financialResponsibilities.bowlerId)))
      .innerJoin(bowlerOccurrenceTeamAssignments, and(eq(bowlerOccurrenceTeamAssignments.id, financialResponsibilities.assignmentId), eq(bowlerOccurrenceTeamAssignments.organizationId, financialResponsibilities.organizationId), eq(bowlerOccurrenceTeamAssignments.leagueId, financialResponsibilities.leagueId), eq(bowlerOccurrenceTeamAssignments.occurrenceId, financialResponsibilities.occurrenceId), eq(bowlerOccurrenceTeamAssignments.bowlerId, financialResponsibilities.bowlerId), eq(bowlerOccurrenceTeamAssignments.teamId, financialResponsibilities.teamId)))
      .where(and(eq(financialResponsibilities.organizationId, input.organizationId), eq(financialResponsibilities.leagueId, input.leagueId), eq(financialResponsibilities.activationId, activation.id)));
    if (linkedEvidence.length !== activationResponsibilities.length || linkedEvidence.some((row) => row.eligibilityState !== "eligible" || row.assignmentState !== "assigned" || row.eligibilityReason !== row.provenance || row.assignmentReason !== row.provenance)) throw new FinancialReadIncompatibilityError();
    const eligibilityIds = linkedEvidence.map((row) => row.eligibilityId);
    const assignmentIds = linkedEvidence.map((row) => row.assignmentId);
    const eligibilityRevisions = await tx.select({ id: bowlerOccurrenceEligibilityRevisions.eligibilityId, revisionNumber: bowlerOccurrenceEligibilityRevisions.revisionNumber, snapshotSchemaVersion: bowlerOccurrenceEligibilityRevisions.snapshotSchemaVersion, beforeSnapshot: bowlerOccurrenceEligibilityRevisions.beforeSnapshot, afterSnapshot: bowlerOccurrenceEligibilityRevisions.afterSnapshot })
      .from(bowlerOccurrenceEligibilityRevisions).where(and(eq(bowlerOccurrenceEligibilityRevisions.organizationId, input.organizationId), eq(bowlerOccurrenceEligibilityRevisions.leagueId, input.leagueId), inArray(bowlerOccurrenceEligibilityRevisions.eligibilityId, eligibilityIds)));
    const assignmentRevisions = await tx.select({ id: bowlerOccurrenceTeamAssignmentRevisions.assignmentId, revisionNumber: bowlerOccurrenceTeamAssignmentRevisions.revisionNumber, snapshotSchemaVersion: bowlerOccurrenceTeamAssignmentRevisions.snapshotSchemaVersion, beforeSnapshot: bowlerOccurrenceTeamAssignmentRevisions.beforeSnapshot, afterSnapshot: bowlerOccurrenceTeamAssignmentRevisions.afterSnapshot })
      .from(bowlerOccurrenceTeamAssignmentRevisions).where(and(eq(bowlerOccurrenceTeamAssignmentRevisions.organizationId, input.organizationId), eq(bowlerOccurrenceTeamAssignmentRevisions.leagueId, input.leagueId), inArray(bowlerOccurrenceTeamAssignmentRevisions.assignmentId, assignmentIds)));
    if (!revisionsCoverCurrentState(
      linkedEvidence.map((row) => ({ id: row.eligibilityId, currentRevision: row.eligibilityRevision })),
      eligibilityRevisions,
      (snapshot, parentId) => snapshot.state === "eligible" && snapshot.reason === linkedEvidence.find((row) => row.eligibilityId === parentId)?.provenance,
    ) || !revisionsCoverCurrentState(
      linkedEvidence.map((row) => ({ id: row.assignmentId, currentRevision: row.assignmentRevision })),
      assignmentRevisions,
      (snapshot, parentId) => snapshot.state === "assigned"
        && snapshot.reason === linkedEvidence.find((row) => row.assignmentId === parentId)?.provenance
        && snapshot.teamId === linkedEvidence.find((row) => row.assignmentId === parentId)?.teamId,
    )) throw new FinancialReadIncompatibilityError();
    const activationObligationEvidence = await tx.select({ obligationId: financialResponsibilities.obligationId })
      .from(financialResponsibilities)
      .where(and(
        eq(financialResponsibilities.organizationId, input.organizationId),
        eq(financialResponsibilities.leagueId, input.leagueId),
        eq(financialResponsibilities.activationId, activation.id),
      ));
    const activatedObligationIds = activationObligationEvidence.map((row) => row.obligationId);
    const obligationRows = activatedObligationIds.length === 0 ? [] : await tx.select().from(bowlerOccurrenceObligations).where(and(
      eq(bowlerOccurrenceObligations.organizationId, input.organizationId),
      eq(bowlerOccurrenceObligations.leagueId, input.leagueId),
      inArray(bowlerOccurrenceObligations.id, activatedObligationIds),
      ...(input.bowlerId === undefined ? [] : [eq(bowlerOccurrenceObligations.bowlerId, input.bowlerId)]),
    )).orderBy(asc(bowlerOccurrenceObligations.dueAt), asc(bowlerOccurrenceObligations.bowlerId), asc(bowlerOccurrenceObligations.occurrenceId), asc(bowlerOccurrenceObligations.id));
    const ids = obligationRows.map((row) => row.id);
    const obligationRevisions = ids.length === 0 ? [] : await tx.select({ id: bowlerOccurrenceObligationRevisions.obligationId, revisionNumber: bowlerOccurrenceObligationRevisions.revisionNumber, snapshotSchemaVersion: bowlerOccurrenceObligationRevisions.snapshotSchemaVersion, beforeSnapshot: bowlerOccurrenceObligationRevisions.beforeSnapshot, afterSnapshot: bowlerOccurrenceObligationRevisions.afterSnapshot }).from(bowlerOccurrenceObligationRevisions).where(and(eq(bowlerOccurrenceObligationRevisions.organizationId, input.organizationId), eq(bowlerOccurrenceObligationRevisions.leagueId, input.leagueId), inArray(bowlerOccurrenceObligationRevisions.obligationId, ids)));
    if (!revisionsCoverCurrentState(
      obligationRows,
      obligationRevisions,
      (snapshot, parentId) => {
        const obligation = obligationRows.find((row) => row.id === parentId);
        return obligation !== undefined && snapshot.state === obligation.state && sameInstant(snapshot.dueAt, obligation.dueAt) && sameInstant(snapshot.pastDueAt, obligation.pastDueAt);
      },
    )) throw new FinancialReadIncompatibilityError();
    const cancellationReviewObligationIds = new Set(
      obligationRevisions
        .filter((revision) => revision.revisionNumber === obligationRows.find((obligation) => obligation.id === revision.id)?.currentRevision)
        .filter((revision) => isRecord(revision.afterSnapshot) && revision.afterSnapshot.cancellationReviewRequired === true)
        .map((revision) => revision.id),
    );
    const allAllocations = ids.length === 0 ? [] : await tx.select().from(paymentOccurrenceAllocations).where(and(
      eq(paymentOccurrenceAllocations.organizationId, input.organizationId),
      eq(paymentOccurrenceAllocations.leagueId, input.leagueId),
      inArray(paymentOccurrenceAllocations.obligationId, ids),
    ));
    const allocationRevisions = allAllocations.length === 0 ? [] : await tx.select({ id: paymentOccurrenceAllocationRevisions.allocationId, revisionNumber: paymentOccurrenceAllocationRevisions.revisionNumber, snapshotSchemaVersion: paymentOccurrenceAllocationRevisions.snapshotSchemaVersion, beforeSnapshot: paymentOccurrenceAllocationRevisions.beforeSnapshot, afterSnapshot: paymentOccurrenceAllocationRevisions.afterSnapshot }).from(paymentOccurrenceAllocationRevisions).where(and(eq(paymentOccurrenceAllocationRevisions.organizationId, input.organizationId), eq(paymentOccurrenceAllocationRevisions.leagueId, input.leagueId), inArray(paymentOccurrenceAllocationRevisions.allocationId, allAllocations.map((row) => row.id))));
    if (allAllocations.length > 0 && !revisionsCoverCurrentState(
      allAllocations,
      allocationRevisions,
      (snapshot, parentId) => {
        const allocation = allAllocations.find((row) => row.id === parentId);
        return allocation !== undefined && snapshot.state === allocation.state && snapshot.amountMinor === allocation.amountMinor && snapshot.currency === allocation.currency
          && snapshot.paymentId === allocation.paymentId && snapshot.obligationId === allocation.obligationId && snapshot.occurrenceId === allocation.occurrenceId && snapshot.bowlerId === allocation.bowlerId;
      },
    )) throw new FinancialReadIncompatibilityError();
    const allocations = allAllocations.filter((allocation) => allocation.state === "active");
    const paymentIds = [...new Set(allocations.map((row) => row.paymentId))];
    const paymentRows = paymentIds.length === 0 ? [] : await tx.select().from(payments).where(and(
      eq(payments.leagueId, input.leagueId),
      inArray(payments.id, paymentIds),
    ));
    if (paymentRows.length !== paymentIds.length) throw new FinancialReadIncompatibilityError();
    const paymentById = new Map(paymentRows.map((row) => [row.id, row]));
    const operationIds = [...new Set(paymentRows.map((row) => row.paymentOperationId).filter((id): id is string => id !== null))];
    const disputeRows = operationIds.length === 0 ? [] : await tx.select().from(paymentDisputes).where(and(
      eq(paymentDisputes.organizationId, input.organizationId),
      inArray(paymentDisputes.paymentOperationId, operationIds),
    ));
    const disputedOperations = new Set(disputeRows.map((row) => row.paymentOperationId));
    const allocationsByObligation = new Map<string, typeof allocations>();
    for (const allocation of allocations) {
      const list = allocationsByObligation.get(allocation.obligationId) ?? [];
      list.push(allocation);
      allocationsByObligation.set(allocation.obligationId, list);
    }
    const responsibilityRows = ids.length === 0 ? [] : await tx.select({ obligationId: financialResponsibilities.obligationId, teamId: financialResponsibilities.teamId })
      .from(financialResponsibilities)
      .where(and(
        eq(financialResponsibilities.organizationId, input.organizationId),
        eq(financialResponsibilities.leagueId, input.leagueId),
        eq(financialResponsibilities.activationId, activation.id),
        inArray(financialResponsibilities.obligationId, ids),
      ));
    const teamByObligation = new Map(responsibilityRows.filter((row) => row.teamId !== null).map((row) => [row.obligationId, row.teamId]));
    const rows: FinancialReadRow[] = obligationRows.map((obligation) => {
      const linked = allocationsByObligation.get(obligation.id) ?? [];
      const allocatedMinor = linked.reduce((sum, row) => sum + row.amountMinor, 0);
      const outstandingMinor = obligation.state === "voided" ? 0 : Math.max(0, obligation.amountMinor - allocatedMinor);
      const reviewRequired = cancellationReviewObligationIds.has(obligation.id) || linked.some((allocation) => {
        const payment = paymentById.get(allocation.paymentId);
        return payment?.status === "refunded" || payment?.status === "disputed"
          || payment?.refundedAt !== null && payment?.refundedAt !== undefined
          || payment?.disputedAt !== null && payment?.disputedAt !== undefined
          || (payment?.paymentOperationId !== null && payment?.paymentOperationId !== undefined && disputedOperations.has(payment.paymentOperationId));
      });
      const reviewCategory = linked.some((allocation) => {
        const payment = paymentById.get(allocation.paymentId);
        return payment?.status === "refunded" || (payment?.refundedAt !== null && payment?.refundedAt !== undefined);
      }) ? "refund" as const : linked.some((allocation) => {
        const payment = paymentById.get(allocation.paymentId);
        return payment?.status === "disputed" || payment?.disputedAt !== null && payment?.disputedAt !== undefined || (payment?.paymentOperationId !== null && payment?.paymentOperationId !== undefined && disputedOperations.has(payment.paymentOperationId));
      }) ? "dispute" as const : reviewRequired ? "evidence" as const : null;
      const invalidSettlementPayment = linked.some((allocation) => {
        const payment = paymentById.get(allocation.paymentId);
        return payment !== undefined && payment.status !== "paid" && payment.status !== "refunded" && payment.status !== "disputed";
      });
      const expectedState = obligation.state === "voided" ? "voided" : outstandingMinor === 0 ? "settled" : allocatedMinor > 0 ? "partially_settled" : "open";
      const cancellationVoidedWithActiveAllocation = obligation.state === "voided"
        && allocatedMinor > 0
        && cancellationReviewObligationIds.has(obligation.id);
      const voidedWithActiveAllocation = obligation.state === "voided"
        && allocatedMinor > 0
        && !cancellationVoidedWithActiveAllocation;
      const incompatibleEvidence = expectedState !== obligation.state || voidedWithActiveAllocation || invalidSettlementPayment || !teamByObligation.has(obligation.id);
      const missingTiming = obligation.dueAt === null || obligation.pastDueAt === null;
      const classification: DuePastDueClassification = voidedWithActiveAllocation
        || (obligation.state === "voided" && cancellationReviewObligationIds.has(obligation.id))
        ? "review_required"
        : obligation.state === "voided"
        ? "voided"
        : reviewRequired || incompatibleEvidence || missingTiming
          ? "review_required"
          : outstandingMinor === 0
            ? "settled"
          : classifyCanonicalTiming({ dueAt: obligation.dueAt ?? effectiveNow.toISOString(), pastDueAt: obligation.pastDueAt ?? effectiveNow.toISOString() }, effectiveNow);
      return {
        obligationId: obligation.id,
        occurrenceId: obligation.occurrenceId,
        bowlerId: obligation.bowlerId,
        teamId: teamByObligation.get(obligation.id) ?? null,
        amountMinor: obligation.amountMinor,
        allocatedMinor,
        outstandingMinor,
        dueAt: obligation.dueAt,
        pastDueAt: obligation.pastDueAt,
        classification,
        state: obligation.state,
        evidenceSource: "canonical",
        reviewRequired,
        reviewCategory,
        incompatibleEvidence: incompatibleEvidence || missingTiming,
        legacyWeekOf: null,
        legacyPaidMinor: null,
        legacyDueToDateMinor: null,
      };
    });
    if (rows.some((row) => row.incompatibleEvidence)) throw new FinancialReadIncompatibilityError();
    return {
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      contractVersion: FINANCIAL_READ_CONTRACT_VERSION,
      orderVersion: CANONICAL_DUE_PAST_DUE_ORDER_VERSION,
      mode: "canonical",
      activationId: activation.id,
      authoritativeSource: "canonical",
      unavailableReason: null,
      asOf,
      fingerprint: canonicalReadFingerprint([{ organizationId: input.organizationId, leagueId: input.leagueId, mode: "canonical", contractVersion: FINANCIAL_READ_CONTRACT_VERSION, orderVersion: CANONICAL_DUE_PAST_DUE_ORDER_VERSION, activationId: activation.id, sourceFingerprint: activation.sourceFingerprint, rows: rows.map((row) => ({ ...row })) }]),
      rows,
      totals: { amountMinor: rows.reduce((sum, row) => sum + row.amountMinor, 0), allocatedMinor: rows.reduce((sum, row) => sum + row.allocatedMinor, 0), outstandingMinor: rows.reduce((sum, row) => sum + row.outstandingMinor, 0), collectiblePastDueMinor: rows.filter((row) => row.classification === "past_due").reduce((sum, row) => sum + row.outstandingMinor, 0), reviewCount: rows.filter((row) => row.reviewRequired).length },
    };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

export interface ActivationResult { activationId: string; obligationIds: string[]; requestFingerprint: string; }
export class FinancialActivationError extends Error {
  constructor(public readonly code: "invalid_matrix" | "stale_source" | "idempotency_conflict" | "already_activated" | "reconciliation_required" | "canonical_incomplete", message: string) {
    super(message);
    this.name = "FinancialActivationError";
  }
}

interface OperationalActivationEvidence { expected: ResponsibilityExpectedRow[]; sourceFingerprint: string; authoritativeSource: "canonical" | "legacy" | "legacy_fallback"; sourceSurface?: Record<string, unknown>; }

type CancellationResponsibility = {
  occurrenceId: string;
  teamId: number;
  slotIndex: number;
  bowlerId: number;
  obligationId: string;
  billingTermId: string;
  amountMinor: number;
  currency: string;
  dueAt: string;
  pastDueAt: string;
  role: string;
  provenance: string;
};

function cancellationResponsibilityFingerprint(rows: CancellationResponsibility[]): string {
  const normalized = [...rows].sort((left, right) =>
    left.occurrenceId.localeCompare(right.occurrenceId)
    || left.teamId - right.teamId
    || left.slotIndex - right.slotIndex
    || left.bowlerId - right.bowlerId
    || left.obligationId.localeCompare(right.obligationId),
  );
  return `lvfinancialresponsibility:v1:${createHash("sha256").update(JSON.stringify({ version: FINANCIAL_ACTIVATION_RESPONSIBILITY_FINGERPRINT_VERSION, rows: normalized }), "utf8").digest("hex")}`;
}

function isCancellationSuppressionSnapshot(value: unknown): value is {
  cancellationCommandId: string;
  responsibilityFingerprint: string;
  originalResponsibilityCount: number;
} {
  return isRecord(value)
    && typeof value.cancellationCommandId === "string"
    && typeof value.responsibilityFingerprint === "string"
    && typeof value.originalResponsibilityCount === "number";
}

async function loadOperationalActivationSource(
  tx: ScheduleExecutor,
  input: { organizationId: number; leagueId: number },
) {
  return loadLeagueOccurrenceScheduleSnapshot({ ...input, includeAdministratorEvidence: true }, tx);
}

export async function loadOperationalActivationEvidence(
  tx: ScheduleExecutor,
  input: { organizationId: number; leagueId: number },
): Promise<OperationalActivationEvidence> {
  const [league] = await tx.select({ paymentMode: leagues.paymentMode }).from(leagues).where(and(eq(leagues.id, input.leagueId), eq(leagues.organizationId, input.organizationId))).limit(1);
  if (!league || (league.paymentMode !== "weekly" && league.paymentMode !== "upfront")) throw new FinancialActivationError("canonical_incomplete", "canonical payment mode is unavailable");
  const schedule = await loadOperationalActivationSource(tx, input);
  if (schedule.authoritativeSource !== "canonical" || !schedule.operationalCanonicalStateExists) {
    return { expected: [], authoritativeSource: schedule.authoritativeSource, sourceFingerprint: fingerprint(FINANCIAL_SOURCE_FINGERPRINT_PREFIX, { organizationId: input.organizationId, leagueId: input.leagueId, contractVersion: FINANCIAL_READ_CONTRACT_VERSION, policyVersion: FINANCIAL_ACTIVATION_POLICY_VERSION, orderVersion: FINANCIAL_ACTIVATION_ORDER_VERSION, paymentMode: league.paymentMode, occurrences: [], teams: [] }) };
  }
  const decisionOccurrences = schedule.occurrences.filter((row): row is typeof row & { occurrenceId: string; startAt: string } => typeof row.occurrenceId === "string" && typeof row.startAt === "string" && (row.lifecycle === "published" || row.lifecycle === "locked"));
  const operational = decisionOccurrences.filter((row) => row.status === "scheduled" || row.status === "completed");
  const occurrenceIds = decisionOccurrences.map((row) => row.occurrenceId);
  const terms = await tx.select({
    id: leagueOccurrenceBillingTerms.id,
    organizationId: leagueOccurrenceBillingTerms.organizationId,
    leagueId: leagueOccurrenceBillingTerms.leagueId,
    occurrenceId: leagueOccurrences.id,
    billingTermId: leagueOccurrenceBillingTerms.id,
    billingTermVersion: leagueOccurrenceBillingTerms.version,
    billingTermRevision: leagueOccurrenceBillingTerms.currentRevision,
    amountMinor: leagueOccurrenceBillingTerms.defaultAmountMinor,
    currency: leagueOccurrenceBillingTerms.currency,
    purpose: leagueOccurrenceBillingTerms.purpose,
    obligationPolicy: leagueOccurrenceBillingTerms.obligationPolicy,
    state: leagueOccurrenceBillingTerms.state,
    billingOrdinal: leagueOccurrenceBillingTerms.billingOrdinal,
    lastCommandId: leagueOccurrenceBillingTerms.lastCommandId,
  }).from(leagueOccurrenceBillingTerms).innerJoin(leagueOccurrences, eq(leagueOccurrences.id, leagueOccurrenceBillingTerms.occurrenceId)).where(and(
    eq(leagueOccurrenceBillingTerms.organizationId, input.organizationId),
    eq(leagueOccurrenceBillingTerms.leagueId, input.leagueId),
    eq(leagueOccurrenceBillingTerms.state, "published"),
    eq(leagueOccurrenceBillingTerms.purpose, "league_weekly_fee"),
    inArray(leagueOccurrenceBillingTerms.occurrenceId, occurrenceIds),
  ));
  const teamsRows = await tx.select({ id: teams.id }).from(teams).where(and(eq(teams.leagueId, input.leagueId), eq(teams.active, true))).orderBy(asc(teams.id));
  const termByOccurrence = new Map<string, (typeof terms)[number]>();
  for (const term of terms) {
    if (termByOccurrence.has(term.occurrenceId)) throw new FinancialActivationError("canonical_incomplete", "an operational occurrence has duplicate published billing terms");
    termByOccurrence.set(term.occurrenceId, term);
  }
  const termRevisions = terms.length === 0 ? [] : await tx.select({
    id: leagueOccurrenceBillingTermRevisions.billingTermId,
    revisionNumber: leagueOccurrenceBillingTermRevisions.revisionNumber,
    snapshotSchemaVersion: leagueOccurrenceBillingTermRevisions.snapshotSchemaVersion,
    beforeSnapshot: leagueOccurrenceBillingTermRevisions.beforeSnapshot,
    afterSnapshot: leagueOccurrenceBillingTermRevisions.afterSnapshot,
  }).from(leagueOccurrenceBillingTermRevisions).where(and(
    eq(leagueOccurrenceBillingTermRevisions.organizationId, input.organizationId),
    eq(leagueOccurrenceBillingTermRevisions.leagueId, input.leagueId),
    inArray(leagueOccurrenceBillingTermRevisions.billingTermId, terms.map((term) => term.billingTermId)),
  ));
  if (!revisionsCoverCurrentState(
    terms.map((term) => ({ id: term.billingTermId, currentRevision: term.billingTermRevision })),
    termRevisions,
    (snapshot, parentId) => {
      const term = terms.find((candidate) => candidate.billingTermId === parentId);
      return term !== undefined && billingTermRevisionMatchesCurrent(snapshot, term);
    },
  )) throw new FinancialActivationError("canonical_incomplete", "billing term revision evidence is incomplete");
  for (const occurrence of operational) {
    const term = termByOccurrence.get(occurrence.occurrenceId);
    if (!term || term.purpose !== "league_weekly_fee" || (term.obligationPolicy !== "eligible_bowlers" && term.obligationPolicy !== "none") || (term.obligationPolicy === "eligible_bowlers" && (term.amountMinor <= 0 || term.currency !== "USD" || term.billingOrdinal === null)) || (term.obligationPolicy === "none" && (term.amountMinor !== 0 || term.billingOrdinal !== null))) {
      throw new FinancialActivationError("canonical_incomplete", "an operational occurrence has a missing or invalid published billing term");
    }
  }
  const occurrenceById = new Map(operational.map((row) => [row.occurrenceId, row]));
  const expected = occurrenceIds.flatMap((occurrenceId) => {
    const occurrence = occurrenceById.get(occurrenceId);
    const term = termByOccurrence.get(occurrenceId);
    if (!occurrence || !term || term.obligationPolicy === "none") return [];
    const occurrenceKind: ResponsibilityExpectedRow["occurrenceKind"] = occurrence.kind === "makeup" || occurrence.kind === "position_round" || occurrence.kind === "rolloff" || occurrence.kind === "playoff" || occurrence.kind === "extension" ? occurrence.kind : "regular";
    const occurrenceStatus: ResponsibilityExpectedRow["occurrenceStatus"] = occurrence.status === "completed" ? "completed" : occurrence.status === "cancelled" ? "cancelled" : "scheduled";
    const lifecycle: ResponsibilityExpectedRow["lifecycle"] = occurrence.lifecycle === "locked" ? "locked" : "published";
    return teamsRows.map((team) => ({
      occurrenceId, teamId: team.id, billingTermId: term.billingTermId, billingTermVersion: term.billingTermVersion,
      billingTermRevision: term.billingTermRevision, occurrenceRevision: occurrence.currentRevision ?? 0,
      amountMinor: term.amountMinor, currency: term.currency, paymentMode: league.paymentMode, occurrenceStartAt: occurrence.startAt,
      occurrenceKind, occurrenceStatus, lifecycle, obligationPolicy: "eligible_bowlers" as const,
    }));
  });
  const sourceSurface = {
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    contractVersion: FINANCIAL_READ_CONTRACT_VERSION,
    policyVersion: FINANCIAL_ACTIVATION_POLICY_VERSION,
    orderVersion: FINANCIAL_ACTIVATION_ORDER_VERSION,
    paymentMode: league.paymentMode,
    occurrences: decisionOccurrences.map((row) => ({ occurrenceId: row.occurrenceId, kind: row.kind, status: row.status, lifecycle: row.lifecycle, startAt: row.startAt, revision: row.currentRevision, term: termByOccurrence.get(row.occurrenceId) ?? null, disposition: row.status === "cancelled" ? "cancelled" : (termByOccurrence.get(row.occurrenceId)?.obligationPolicy === "none" ? "none" : "eligible_bowlers") })),
    teams: teamsRows.map((team) => team.id),
  };
  const [activation] = await tx.select().from(financialActivations).where(and(
    eq(financialActivations.organizationId, input.organizationId),
    eq(financialActivations.leagueId, input.leagueId),
    eq(financialActivations.state, "active"),
    eq(financialActivations.completenessMarker, true),
  )).limit(1);
  if (!activation) {
    return { expected, authoritativeSource: "canonical", sourceFingerprint: fingerprint(FINANCIAL_SOURCE_FINGERPRINT_PREFIX, sourceSurface), sourceSurface };
  }

  // F1 revision 1 is immutable. A cancellation is accepted only through an
  // explicit suppression row written by the same audited cancellation
  // transaction; all non-cancelled source fields must remain byte-for-byte
  // equal to the activation snapshot. Unsupported drift remains fail-closed.
  const [activationRevision] = await tx.select({ afterSnapshot: financialActivationRevisions.afterSnapshot, snapshotSchemaVersion: financialActivationRevisions.snapshotSchemaVersion })
    .from(financialActivationRevisions).where(and(
      eq(financialActivationRevisions.organizationId, input.organizationId),
      eq(financialActivationRevisions.leagueId, input.leagueId),
      eq(financialActivationRevisions.activationId, activation.id),
      eq(financialActivationRevisions.revisionNumber, 1),
    )).limit(1);
  if (activation.currentRevision !== 1 || activationRevision?.snapshotSchemaVersion !== FINANCIAL_ACTIVATION_VERSION || !isRecord(activationRevision.afterSnapshot)
    || !isRecord(activationRevision.afterSnapshot.sourceSurface)) {
    throw new FinancialActivationError("canonical_incomplete", "active financial activation has no cancellation-compatible immutable source evidence");
  }
  const originalSourceSurface = activationRevision.afterSnapshot.sourceSurface;
  if (!Array.isArray(originalSourceSurface.occurrences) || !Array.isArray(originalSourceSurface.teams)) {
    throw new FinancialActivationError("canonical_incomplete", "active financial activation source evidence is malformed");
  }
  const currentCancelledIds = new Set(decisionOccurrences.filter((row) => row.status === "cancelled").map((row) => row.occurrenceId));
  const originalOccurrenceIds = new Set(originalSourceSurface.occurrences
    .filter((row): row is Record<string, unknown> => isRecord(row))
    .map((row) => typeof row.occurrenceId === "string" ? row.occurrenceId : null)
    .filter((id): id is string => id !== null));
  const baselineCancelledIds = new Set(originalSourceSurface.occurrences
    .filter((row): row is Record<string, unknown> => isRecord(row) && row.status === "cancelled")
    .map((row) => typeof row.occurrenceId === "string" ? row.occurrenceId : null)
    .filter((id): id is string => id !== null));
  const suppressedOccurrenceIds = [...currentCancelledIds].filter((id) => originalOccurrenceIds.has(id) && !baselineCancelledIds.has(id)).sort();
  if ([...currentCancelledIds].some((id) => !originalOccurrenceIds.has(id))) {
    throw new FinancialActivationError("canonical_incomplete", "active financial activation has an unsupported cancelled occurrence");
  }
  const suppressions = suppressedOccurrenceIds.length === 0 ? [] : await tx.select().from(financialActivationCancellationSuppressions).where(and(
    eq(financialActivationCancellationSuppressions.organizationId, input.organizationId),
    eq(financialActivationCancellationSuppressions.leagueId, input.leagueId),
    eq(financialActivationCancellationSuppressions.activationId, activation.id),
    inArray(financialActivationCancellationSuppressions.occurrenceId, suppressedOccurrenceIds),
  ));
  if (suppressions.length !== suppressedOccurrenceIds.length || suppressions.some((row) => row.suppressionVersion !== FINANCIAL_ACTIVATION_CANCELLATION_SUPPRESSION_VERSION || row.activationRevision !== 1 || row.sourceFingerprint !== activation.sourceFingerprint)) {
    throw new FinancialActivationError("canonical_incomplete", "active financial activation cancellation suppression evidence is incomplete");
  }
  const suppressionByOccurrence = new Map(suppressions.map((row) => [row.occurrenceId, row]));
  const filteredOriginalSurface = {
    ...originalSourceSurface,
    occurrences: originalSourceSurface.occurrences.filter((row) => isRecord(row) && typeof row.occurrenceId === "string" && !suppressedOccurrenceIds.includes(row.occurrenceId)),
  };
  const filteredCurrentSurface = {
    ...sourceSurface,
    occurrences: sourceSurface.occurrences.filter((row) => !suppressedOccurrenceIds.includes(row.occurrenceId)),
  };
  if (stableCanonicalJson(filteredOriginalSurface) !== stableCanonicalJson(filteredCurrentSurface)) {
    throw new FinancialActivationError("canonical_incomplete", "non-cancelled financial activation source evidence changed");
  }
  const activationRows = await tx.select().from(financialResponsibilities).where(and(
    eq(financialResponsibilities.organizationId, input.organizationId),
    eq(financialResponsibilities.leagueId, input.leagueId),
    eq(financialResponsibilities.activationId, activation.id),
  )).orderBy(asc(financialResponsibilities.occurrenceId), asc(financialResponsibilities.teamId), asc(financialResponsibilities.slotIndex), asc(financialResponsibilities.bowlerId), asc(financialResponsibilities.id));
  if (activationRows.length !== activation.expectedResponsibilityCount) {
    throw new FinancialActivationError("canonical_incomplete", "financial activation responsibility evidence is incomplete");
  }
  const snapshotResponsibilities = Array.isArray(activationRevision.afterSnapshot.responsibilities) ? activationRevision.afterSnapshot.responsibilities : [];
  const snapshotResponsibilityJson = stableCanonicalJson(snapshotResponsibilities);
  const currentResponsibilityJson = stableCanonicalJson(activationRows.map((row) => ({ occurrenceId: row.occurrenceId, teamId: row.teamId, slotIndex: row.slotIndex, bowlerId: row.bowlerId, role: row.role, provenance: row.provenance })));
  if (snapshotResponsibilityJson !== currentResponsibilityJson) {
    throw new FinancialActivationError("canonical_incomplete", "financial activation responsibilities changed");
  }
  const canceledRows = activationRows.filter((row) => suppressedOccurrenceIds.includes(row.occurrenceId));
  const canceledObligationIds = canceledRows.map((row) => row.obligationId);
  const canceledObligations = canceledObligationIds.length === 0 ? [] : await tx.select().from(bowlerOccurrenceObligations).where(and(
    eq(bowlerOccurrenceObligations.organizationId, input.organizationId),
    eq(bowlerOccurrenceObligations.leagueId, input.leagueId),
    inArray(bowlerOccurrenceObligations.id, canceledObligationIds),
  ));
  const canceledObligationRevisions = canceledObligationIds.length === 0 ? [] : await tx.select({ id: bowlerOccurrenceObligationRevisions.obligationId, revisionNumber: bowlerOccurrenceObligationRevisions.revisionNumber, afterSnapshot: bowlerOccurrenceObligationRevisions.afterSnapshot }).from(bowlerOccurrenceObligationRevisions).where(and(
    eq(bowlerOccurrenceObligationRevisions.organizationId, input.organizationId),
    eq(bowlerOccurrenceObligationRevisions.leagueId, input.leagueId),
    inArray(bowlerOccurrenceObligationRevisions.obligationId, canceledObligationIds),
  ));
  const canceledAllocations = canceledObligationIds.length === 0 ? [] : await tx.select({ obligationId: paymentOccurrenceAllocations.obligationId, state: paymentOccurrenceAllocations.state }).from(paymentOccurrenceAllocations).where(and(
    eq(paymentOccurrenceAllocations.organizationId, input.organizationId),
    eq(paymentOccurrenceAllocations.leagueId, input.leagueId),
    inArray(paymentOccurrenceAllocations.obligationId, canceledObligationIds),
  ));
  if (canceledObligations.length !== canceledObligationIds.length || canceledObligations.some((obligation) => {
    if (obligation.state !== "voided") return true;
    const latest = canceledObligationRevisions.find((revision) => revision.id === obligation.id && revision.revisionNumber === obligation.currentRevision);
    const suppression = suppressionByOccurrence.get(obligation.occurrenceId);
    const hasActiveAllocation = canceledAllocations.some((allocation) => allocation.obligationId === obligation.id && allocation.state === "active");
    return !latest || !isRecord(latest.afterSnapshot) || latest.afterSnapshot.cancellationCommandId !== suppression?.cancellationCommandId
      || (suppression?.cancellationReviewRequired === true && latest.afterSnapshot.cancellationReviewRequired !== true)
      || (hasActiveAllocation && suppression?.cancellationReviewRequired !== true);
  })) {
    throw new FinancialActivationError("canonical_incomplete", "cancelled activation obligations are not fully voided and audited");
  }
  for (const suppression of suppressions) {
    const rows = canceledRows.filter((row) => row.occurrenceId === suppression.occurrenceId).map((row) => ({
      occurrenceId: row.occurrenceId, teamId: row.teamId, slotIndex: row.slotIndex, bowlerId: row.bowlerId,
      obligationId: row.obligationId, billingTermId: row.billingTermId, amountMinor: row.amountMinor, currency: row.currency,
      dueAt: row.dueAt, pastDueAt: row.pastDueAt, role: row.role, provenance: row.provenance,
    }));
    if (rows.length !== suppression.originalResponsibilityCount || cancellationResponsibilityFingerprint(rows) !== suppression.responsibilityFingerprint || !isCancellationSuppressionSnapshot(suppression.afterSnapshot)) {
      throw new FinancialActivationError("canonical_incomplete", "cancelled activation responsibility suppression evidence is inconsistent");
    }
  }
  const canceledOccurrenceById = new Map(decisionOccurrences.filter((row) => suppressedOccurrenceIds.includes(row.occurrenceId)).map((row) => [row.occurrenceId, row]));
  const canceledExpected = [...new Map(canceledRows.map((row) => [`${row.occurrenceId}:${row.teamId}`, row] as const)).values()].map((row) => {
    const occurrence = canceledOccurrenceById.get(row.occurrenceId);
    const suppression = suppressionByOccurrence.get(row.occurrenceId);
    if (!occurrence || !suppression) throw new FinancialActivationError("canonical_incomplete", "cancelled activation occurrence evidence is missing");
    const originalOccurrences = originalSourceSurface.occurrences as unknown[];
    const sourceOccurrence = originalOccurrences.find((candidate): candidate is Record<string, unknown> => isRecord(candidate) && candidate.occurrenceId === row.occurrenceId);
    const occurrenceKind: ResponsibilityExpectedRow["occurrenceKind"] = sourceOccurrence && (sourceOccurrence.kind === "makeup" || sourceOccurrence.kind === "position_round" || sourceOccurrence.kind === "rolloff" || sourceOccurrence.kind === "playoff" || sourceOccurrence.kind === "extension") ? sourceOccurrence.kind : "regular";
    const occurrenceRevision = occurrence.currentRevision ?? 0;
    if (occurrenceRevision <= 0) throw new FinancialActivationError("canonical_incomplete", "cancelled activation occurrence revision is invalid");
    return {
      occurrenceId: row.occurrenceId, teamId: row.teamId, billingTermId: row.billingTermId, billingTermVersion: row.billingTermVersion,
      billingTermRevision: suppression.originalBillingTermRevision, occurrenceRevision, amountMinor: row.amountMinor,
      currency: row.currency, paymentMode: league.paymentMode, occurrenceStartAt: occurrence.startAt, occurrenceKind,
      occurrenceStatus: "cancelled" as const, lifecycle: occurrence.lifecycle === "locked" ? "locked" as const : "published" as const,
      obligationPolicy: "eligible_bowlers" as const,
    };
  });
  return {
    expected: [...expected, ...canceledExpected].sort((left, right) => left.occurrenceId.localeCompare(right.occurrenceId) || left.teamId - right.teamId),
    authoritativeSource: "canonical",
    sourceFingerprint: activation.sourceFingerprint,
    sourceSurface,
  };
}

export async function activateCanonicalFinancials(input: {
  organizationId: number;
  leagueId: number;
  actorUserId: number;
  commandKey: string;
  sourceFingerprint: string;
  payingLineupSize: 3 | 4;
  responsibilities: ResponsibilityInput[];
}): Promise<ActivationResult> {
  const normalizedResponsibilities = normalizeResponsibilities(input.responsibilities);
  const runActivation = () => db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${input.organizationId}::integer, ${input.leagueId}::integer)`);
    const [actor] = await tx.select({ id: users.id, role: users.role, organizationId: users.organizationId }).from(users).where(eq(users.id, input.actorUserId)).limit(1);
    if (!actor || (actor.role !== "org_admin" && actor.role !== "system_admin") || (actor.role !== "system_admin" && actor.organizationId !== input.organizationId)) throw new FinancialActivationError("canonical_incomplete", "activation authorization is unavailable");
    const [league] = await tx.select({ paymentMode: leagues.paymentMode }).from(leagues).where(and(eq(leagues.id, input.leagueId), eq(leagues.organizationId, input.organizationId))).limit(1);
    if (!league || (league.paymentMode !== "weekly" && league.paymentMode !== "upfront")) throw new FinancialActivationError("canonical_incomplete", "canonical league billing is unavailable");
    const requestFingerprint = activationRequestFingerprint({ organizationId: input.organizationId, leagueId: input.leagueId, sourceFingerprint: input.sourceFingerprint, paymentMode: league.paymentMode, payingLineupSize: input.payingLineupSize, responsibilities: normalizedResponsibilities });
    const existing = await tx.select().from(financialActivations).where(and(eq(financialActivations.organizationId, input.organizationId), eq(financialActivations.commandKey, input.commandKey))).limit(1);
    if (existing[0]) {
      const [revision] = await tx.select().from(financialActivationRevisions).where(and(eq(financialActivationRevisions.organizationId, input.organizationId), eq(financialActivationRevisions.leagueId, input.leagueId), eq(financialActivationRevisions.activationId, existing[0].id), eq(financialActivationRevisions.revisionNumber, 1))).limit(1);
      const snapshot = revision?.afterSnapshot as { requestFingerprint?: string; sourceFingerprint?: string; payingLineupSize?: number; expectedGroupCount?: number; expectedResponsibilityCount?: number; responsibilities?: unknown } | undefined;
      const storedCount = await tx.select({ id: financialResponsibilities.id }).from(financialResponsibilities).where(and(eq(financialResponsibilities.organizationId, input.organizationId), eq(financialResponsibilities.leagueId, input.leagueId), eq(financialResponsibilities.activationId, existing[0].id)));
      const storedResponsibilities = await tx.select({ occurrenceId: financialResponsibilities.occurrenceId, teamId: financialResponsibilities.teamId, slotIndex: financialResponsibilities.slotIndex, bowlerId: financialResponsibilities.bowlerId, role: financialResponsibilities.role, provenance: financialResponsibilities.provenance }).from(financialResponsibilities).where(and(eq(financialResponsibilities.organizationId, input.organizationId), eq(financialResponsibilities.leagueId, input.leagueId), eq(financialResponsibilities.activationId, existing[0].id))).orderBy(asc(financialResponsibilities.occurrenceId), asc(financialResponsibilities.teamId), asc(financialResponsibilities.slotIndex), asc(financialResponsibilities.bowlerId));
      const submittedResponsibilities = normalizedResponsibilities;
      const retryMismatch = existing[0].leagueId !== input.leagueId || existing[0].recordedByUserId !== input.actorUserId || existing[0].requestFingerprint !== requestFingerprint || existing[0].sourceFingerprint !== input.sourceFingerprint || existing[0].activationVersion !== FINANCIAL_ACTIVATION_VERSION || existing[0].policyVersion !== FINANCIAL_ACTIVATION_POLICY_VERSION || existing[0].orderVersion !== FINANCIAL_ACTIVATION_ORDER_VERSION || existing[0].payingLineupSize !== input.payingLineupSize || !revision || snapshot?.requestFingerprint !== requestFingerprint || snapshot?.sourceFingerprint !== input.sourceFingerprint || snapshot?.payingLineupSize !== input.payingLineupSize || snapshot?.expectedGroupCount !== existing[0].expectedGroupCount || snapshot?.expectedResponsibilityCount !== existing[0].expectedResponsibilityCount || stableCanonicalJson(snapshot?.responsibilities) !== stableCanonicalJson(submittedResponsibilities) || stableCanonicalJson(storedResponsibilities) !== stableCanonicalJson(submittedResponsibilities) || storedCount.length !== existing[0].expectedResponsibilityCount;
      if (retryMismatch) throw new FinancialActivationError("idempotency_conflict", "activation command conflicts with a prior command");
      const priorObligations = await tx.select({ id: financialResponsibilities.obligationId })
        .from(financialResponsibilities)
        .where(and(
          eq(financialResponsibilities.organizationId, input.organizationId),
          eq(financialResponsibilities.leagueId, input.leagueId),
          eq(financialResponsibilities.activationId, existing[0].id),
        )).orderBy(asc(financialResponsibilities.obligationId));
      return { activationId: existing[0].id, obligationIds: priorObligations.map((row) => row.id), requestFingerprint };
    }
    const [activeActivation] = await tx.select({ id: financialActivations.id }).from(financialActivations).where(and(
      eq(financialActivations.organizationId, input.organizationId),
      eq(financialActivations.leagueId, input.leagueId),
      eq(financialActivations.state, "active"),
      eq(financialActivations.completenessMarker, true),
    )).limit(1);
    if (activeActivation) throw new FinancialActivationError("already_activated", "canonical financial activation already exists");
    // A first activation must start from a pristine financial boundary. This
    // check intentionally follows exact retry and active-activation handling:
    // the activation's own immutable D2 rows must not make its retry fail.
    const reconciliationEvidence = await tx.execute(sql`SELECT EXISTS (
      SELECT 1 FROM payments p INNER JOIN leagues pl ON pl.id = p.league_id AND pl.organization_id = ${input.organizationId} WHERE p.league_id = ${input.leagueId}
      UNION ALL SELECT 1 FROM payment_schedules ps INNER JOIN leagues psl ON psl.id = ps.league_id AND psl.organization_id = ${input.organizationId} WHERE ps.league_id = ${input.leagueId}
      UNION ALL SELECT 1 FROM payment_occurrence_allocations pa WHERE pa.organization_id = ${input.organizationId} AND pa.league_id = ${input.leagueId}
      UNION ALL SELECT 1 FROM payment_operations po
        LEFT JOIN payment_schedules ps ON ps.id = po.payment_schedule_id
        LEFT JOIN league_occurrences lo ON lo.id = po.trigger_occurrence_id
        WHERE po.organization_id = ${input.organizationId} AND (ps.league_id = ${input.leagueId} OR lo.league_id = ${input.leagueId})
      UNION ALL SELECT 1 FROM scheduled_payment_operation_snapshots sps INNER JOIN payment_operations sops ON sops.id = sps.operation_id AND sops.organization_id = ${input.organizationId} WHERE sps.league_id = ${input.leagueId}
      UNION ALL SELECT 1 FROM interactive_payment_operation_snapshots ips INNER JOIN payment_operations iops ON iops.id = ips.operation_id AND iops.organization_id = ${input.organizationId} WHERE ips.league_id = ${input.leagueId}
      UNION ALL SELECT 1 FROM refund_payment_operation_snapshots rps INNER JOIN payment_operations rops ON rops.id = rps.operation_id AND rops.organization_id = ${input.organizationId} WHERE rps.league_id = ${input.leagueId}
      UNION ALL SELECT 1 FROM payment_operation_occurrence_snapshots pos WHERE pos.organization_id = ${input.organizationId} AND pos.league_id = ${input.leagueId}
      UNION ALL SELECT 1 FROM occurrence_collection_plans cp WHERE cp.organization_id = ${input.organizationId} AND cp.league_id = ${input.leagueId}
      UNION ALL SELECT 1 FROM occurrence_collection_plan_items cpi WHERE cpi.organization_id = ${input.organizationId} AND cpi.league_id = ${input.leagueId}
      UNION ALL SELECT 1 FROM bowler_occurrence_eligibilities e WHERE e.organization_id = ${input.organizationId} AND e.league_id = ${input.leagueId}
      UNION ALL SELECT 1 FROM bowler_occurrence_team_assignments a WHERE a.organization_id = ${input.organizationId} AND a.league_id = ${input.leagueId}
      UNION ALL SELECT 1 FROM bowler_occurrence_obligations o WHERE o.organization_id = ${input.organizationId} AND o.league_id = ${input.leagueId}
    ) AS present`);
    if ((reconciliationEvidence.rows[0] as { present?: boolean } | undefined)?.present) throw new FinancialActivationError("reconciliation_required", "legacy or financial evidence requires reconciliation before activation");
    const evidence = await loadOperationalActivationEvidence(tx, input);
    const expected = evidence.expected;
    if (expected.length === 0) throw new FinancialActivationError("canonical_incomplete", "no published billable canonical occurrences are available");
    if (input.sourceFingerprint !== evidence.sourceFingerprint) throw new FinancialActivationError("stale_source", "canonical billing inputs changed; review the matrix again");
    const matrixErrors = validateResponsibilityMatrix(expected, normalizedResponsibilities, input.payingLineupSize);
    if (matrixErrors.length > 0) throw new FinancialActivationError("invalid_matrix", "responsibility matrix is incomplete");
    const databaseClock = await tx.execute(sql`SELECT transaction_timestamp()::text AS now`);
    const dueInstant = (databaseClock.rows[0] as { now?: string } | undefined)?.now;
    if (!dueInstant) throw new FinancialActivationError("canonical_incomplete", "activation clock evidence unavailable");
    const expectedGroupCount = expected.length;
    const [activation] = await tx.insert(financialActivations).values({ organizationId: input.organizationId, leagueId: input.leagueId, activationVersion: FINANCIAL_ACTIVATION_VERSION, policyVersion: FINANCIAL_ACTIVATION_POLICY_VERSION, orderVersion: FINANCIAL_ACTIVATION_ORDER_VERSION, commandKey: input.commandKey, requestFingerprint, sourceFingerprint: input.sourceFingerprint, paymentMode: league.paymentMode, state: "active", completenessMarker: true, payingLineupSize: input.payingLineupSize, expectedResponsibilityCount: expectedGroupCount * input.payingLineupSize, expectedGroupCount, currentRevision: 1, upfrontDueAt: league.paymentMode === "upfront" ? dueInstant : null, recordedByUserId: input.actorUserId }).returning();
    if (!activation) throw new FinancialActivationError("canonical_incomplete", "activation could not be recorded");
    await tx.insert(financialActivationRevisions).values({ organizationId: input.organizationId, leagueId: input.leagueId, activationId: activation.id, revisionNumber: 1, snapshotSchemaVersion: FINANCIAL_ACTIVATION_VERSION, afterSnapshot: { activationVersion: FINANCIAL_ACTIVATION_VERSION, policyVersion: FINANCIAL_ACTIVATION_POLICY_VERSION, orderVersion: FINANCIAL_ACTIVATION_ORDER_VERSION, requestFingerprint, sourceFingerprint: input.sourceFingerprint, payingLineupSize: input.payingLineupSize, expectedGroupCount, expectedResponsibilityCount: expectedGroupCount * input.payingLineupSize, sourceSurface: evidence.sourceSurface ?? null, responsibilities: normalizedResponsibilities.map(({ occurrenceId, teamId, slotIndex, bowlerId, role, provenance }) => ({ occurrenceId, teamId, slotIndex, bowlerId, role, provenance })) }, recordedByUserId: input.actorUserId });
    const obligationIds: string[] = [];
    for (const selected of normalizedResponsibilities) {
      const term = expected.find((row) => row.occurrenceId === selected.occurrenceId && row.teamId === selected.teamId);
      if (!term) throw new FinancialActivationError("invalid_matrix", "responsibility matrix references an unknown billing term");
      const timing = calculateCanonicalTiming({ paymentMode: league.paymentMode, occurrenceStartAt: term.occurrenceStartAt, activationDueAt: dueInstant });
      const [tenantBowler] = await tx.select({ id: bowlers.id }).from(bowlers)
        .innerJoin(bowlerLeagues, and(eq(bowlerLeagues.bowlerId, bowlers.id), eq(bowlerLeagues.leagueId, input.leagueId), eq(bowlerLeagues.active, true)))
        .where(and(eq(bowlers.id, selected.bowlerId), eq(bowlers.organizationId, input.organizationId), eq(bowlers.active, true))).limit(1);
      if (!tenantBowler) throw new FinancialActivationError("invalid_matrix", "selected bowler is not available in this organization");
      const [eligibility] = await tx.insert(bowlerOccurrenceEligibilities).values({ organizationId: input.organizationId, leagueId: input.leagueId, occurrenceId: selected.occurrenceId, bowlerId: selected.bowlerId, state: "eligible", reason: selected.provenance, currentRevision: 1, recordedByUserId: input.actorUserId }).returning();
      if (!eligibility) throw new FinancialActivationError("canonical_incomplete", "eligibility could not be recorded");
      await tx.insert(bowlerOccurrenceEligibilityRevisions).values({ organizationId: input.organizationId, leagueId: input.leagueId, eligibilityId: eligibility.id, revisionNumber: 1, snapshotSchemaVersion: FINANCIAL_ACTIVATION_VERSION, afterSnapshot: { state: "eligible", reason: selected.provenance }, recordedByUserId: input.actorUserId });
      const [assignment] = await tx.insert(bowlerOccurrenceTeamAssignments).values({ organizationId: input.organizationId, leagueId: input.leagueId, occurrenceId: selected.occurrenceId, bowlerId: selected.bowlerId, teamId: selected.teamId, state: "assigned", reason: selected.provenance, currentRevision: 1, recordedByUserId: input.actorUserId }).returning();
      if (!assignment) throw new FinancialActivationError("canonical_incomplete", "team assignment could not be recorded");
      await tx.insert(bowlerOccurrenceTeamAssignmentRevisions).values({ organizationId: input.organizationId, leagueId: input.leagueId, assignmentId: assignment.id, revisionNumber: 1, snapshotSchemaVersion: FINANCIAL_ACTIVATION_VERSION, afterSnapshot: { state: "assigned", teamId: selected.teamId, reason: selected.provenance }, recordedByUserId: input.actorUserId });
      const [obligation] = await tx.insert(bowlerOccurrenceObligations).values({ organizationId: input.organizationId, leagueId: input.leagueId, occurrenceId: selected.occurrenceId, bowlerId: selected.bowlerId, purpose: "league_weekly_fee", amountMinor: term.amountMinor, currency: term.currency, dueAt: timing.dueAt, pastDueAt: timing.pastDueAt, state: "open", billingTermId: term.billingTermId, billingTermVersion: term.billingTermVersion, currentRevision: 1, recordedByUserId: input.actorUserId }).returning();
      if (!obligation) throw new FinancialActivationError("canonical_incomplete", "obligation could not be recorded");
      obligationIds.push(obligation.id);
      const [responsibility] = await tx.insert(financialResponsibilities).values({ organizationId: input.organizationId, leagueId: input.leagueId, activationId: activation.id, occurrenceId: selected.occurrenceId, teamId: selected.teamId, slotIndex: selected.slotIndex, payingLineupSize: input.payingLineupSize, bowlerId: selected.bowlerId, eligibilityId: eligibility.id, assignmentId: assignment.id, obligationId: obligation.id, amountMinor: term.amountMinor, currency: term.currency, billingTermId: term.billingTermId, purpose: "league_weekly_fee", billingTermVersion: term.billingTermVersion, dueAt: timing.dueAt, pastDueAt: timing.pastDueAt, role: selected.role, provenance: selected.provenance }).returning();
      if (!responsibility) throw new FinancialActivationError("canonical_incomplete", "responsibility could not be recorded");
      await tx.insert(bowlerOccurrenceObligationRevisions).values({ organizationId: input.organizationId, leagueId: input.leagueId, obligationId: obligation.id, revisionNumber: 1, snapshotSchemaVersion: FINANCIAL_ACTIVATION_VERSION, afterSnapshot: { activationId: activation.id, responsibilityId: responsibility.id, state: "open", amountMinor: term.amountMinor, currency: term.currency, billingTermId: term.billingTermId, billingTermVersion: term.billingTermVersion, dueAt: timing.dueAt, pastDueAt: timing.pastDueAt }, recordedByUserId: input.actorUserId });
    }
    // The retry contract returns IDs in this same deterministic order.
    return { activationId: activation.id, obligationIds: [...obligationIds].sort(), requestFingerprint };
  }, { isolationLevel: "serializable" });
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await runActivation();
    } catch (error) {
      const code = error && typeof error === "object"
        ? ("code" in error ? (error as { code?: string }).code : undefined)
          ?? ("cause" in error && error.cause && typeof error.cause === "object" && "code" in error.cause ? (error.cause as { code?: string }).code : undefined)
        : undefined;
      if ((code !== "40001" && code !== "40P01") || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
    }
  }
  throw new FinancialActivationError("canonical_incomplete", "activation serialization did not complete");
}

export async function getCanonicalActivationSource(input: { organizationId: number; leagueId: number }): Promise<{ sourceFingerprint: string; expected: ResponsibilityExpectedRow[] }> {
  return db.transaction(async (tx) => {
    const evidence = await loadOperationalActivationEvidence(tx, input);
    return { sourceFingerprint: evidence.sourceFingerprint, expected: evidence.expected };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
