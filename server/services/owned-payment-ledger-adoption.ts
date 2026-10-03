import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as LeagueVaultSchema from "@shared/schema";
import { canonicalJsonStringify } from "@shared/canonical-json";
import {
  autopayConsentPartners,
  autopayConsents,
  bowlerPaymentLinks,
  leagues,
  paymentAllocationCorrections,
  paymentAllocationFundingApplications,
  paymentAllocations,
  paymentDisputes,
  paymentObligationOwnerRevisions,
  paymentObligations,
  paymentOperationRosterSnapshotItems,
  paymentOperationRosterSnapshots,
  paymentOperations,
  paymentOperationStandingAutopayBindings,
  paymentOperationStandingAutopayParticipants,
  paymentVoids,
  payments,
  occurrencePaymentResponsibilities,
  refundAllocationAdjustments,
  refundPaymentOperationSnapshots,
  rotatingCreditApplicationReversals,
  rotatingCreditApplications,
  rotatingCreditFundings,
  rotatingCreditRefunds,
  rotatingOccurrenceAssignments,
  weeklyPaymentAllocationReleases,
  weeklyPaymentFundingAuthorizationItems,
  weeklyPaymentFundings,
  weeklyPaymentLedgerAdoptionAllocationProofs,
  weeklyPaymentLedgerAdoptionAllocationProofSteps,
  weeklyPaymentLedgerAdoptions,
  weeklyPaymentWeekConfirmations,
  weeklyPaymentWorksheetReceiptRevisions,
  weeklyPaymentWorksheetReceipts,
  users,
} from "@shared/schema";
import type { PaymentOperationTransaction } from "../storage/payment-operations.js";
import { db } from "../db.js";
import { lockLeagueSchedule } from "../storage/league-schedule-lock.js";
import { loadLeagueOccurrenceScheduleSnapshot } from "./league-occurrence-schedule.js";
import {
  localDateForInstant,
  mapCardReceiptCollectionOccurrence,
} from "./manage-payments-worksheet-projection.js";
import {
  assertOwnedPaymentTenderInTransaction,
  OwnedPaymentLedgerError,
  readGenericFundingAvailabilityInTransaction,
  readLegacyFundingAuthorizationInTransaction,
  readOwnedLedgerAdoptionInTransaction,
  recordOwnedFundingInTransaction,
  releaseOwnedFundingApplicationInTransaction,
  type LegacyFundingAuthorizationPortion,
} from "./owned-payment-ledger.js";
import {
  PaymentObligationOwnerError,
  resolvePaymentObligationOwnersInTransaction,
} from "./roster-obligation-owners.js";
import type { EffectivePaymentObligationOwner } from "./roster-obligation-owners.js";
import {
  isConfirmedNoRefundCreditOutcome,
  isRotatingCreditRefundUnresolvedForReversal,
  readRotatingCreditFundingBalancesInTransaction,
  reverseRotatingCreditApplicationsForAssignmentChangeInTransaction,
} from "./rotating-credit-applications.js";
import {
  appendManualReceiptRevisionInTransaction,
  createManualReceiptHeadInTransaction,
} from "./manual-payment-receipts.js";

export const OWNED_PAYMENT_ADOPTION_PREFLIGHT_PREFIX = "lvweeklyadoptpre:v1:" as const;
export const OWNED_PAYMENT_ADOPTION_RESULT_PREFIX = "lvweeklyadopt:v1:" as const;
type AdoptionPreflightExecutor = NodePgDatabase<typeof LeagueVaultSchema>;
const BILLABLE = (occurrence: { lifecycle: string; status: string; billing: { obligationPolicy: string; billingOrdinal: number | null } | null }) =>
  (occurrence.lifecycle === "published" || occurrence.lifecycle === "locked")
  && occurrence.status !== "cancelled"
  && occurrence.billing?.obligationPolicy === "eligible_bowlers"
  && occurrence.billing.billingOrdinal !== null;

export interface OwnedPaymentAdoptionBlocker {
  code: string;
  count: number;
  entityIds: Array<string | number>;
}

export interface OwnedPaymentAdoptionPlanCounts {
  paidPayments: number;
  genericFundingPortions: number;
  retainedAllocations: number;
  genericAllocationReleases: number;
  rotatingAllocationReleases: number;
  grandfatheredAllocations: number;
  manualReceipts: number;
  preservedVoidedPayments: number;
}

export interface OwnedPaymentAdoptionPreflight {
  organizationId: number;
  leagueId: number;
  timezone: string;
  localToday: string;
  adoptedThroughLocalDate: string;
  ready: boolean;
  sourceFingerprint: string;
  resultFingerprint: string;
  counts: OwnedPaymentAdoptionPlanCounts;
  blockers: OwnedPaymentAdoptionBlocker[];
}

type AdoptionFunding = {
  payment: typeof payments.$inferSelect;
  portion: LegacyFundingAuthorizationPortion;
};

type AdoptionApplication = {
  allocation: typeof paymentAllocations.$inferSelect;
  payment: typeof payments.$inferSelect;
  portion: LegacyFundingAuthorizationPortion;
  originalAllocationId: string;
  authorizedAllocationIndex: number | null;
  correctionPath: Array<typeof paymentAllocationCorrections.$inferSelect>;
  decision: "retain" | "release";
  targetKind: "bowler_responsibility" | "legacy_team_assignment";
  targetPayerBowlerId: number | null;
  assignmentId: string | null;
  obligationOwner: EffectivePaymentObligationOwner;
  debtorBowlerId: number;
  responsibilityId: string;
  occurrenceId: string;
  teamId: number;
};

type RotatingRelease = {
  application: typeof rotatingCreditApplications.$inferSelect;
  assignmentId: string;
};

type AdoptionReceipt = {
  paymentId: number;
  payerBowlerId: number;
  occurrenceId: string;
  businessCollectionLocalDate: string;
  amountMinor: number;
};

export interface OwnedPaymentAdoptionPlan extends OwnedPaymentAdoptionPreflight {
  fundings: AdoptionFunding[];
  applications: AdoptionApplication[];
  rotatingReleases: RotatingRelease[];
  receipts: AdoptionReceipt[];
}

function fingerprint(prefix: string, value: unknown): string {
  return `${prefix}${createHash("sha256").update(canonicalJsonStringify(value), "utf8").digest("hex")}`;
}

function correctionLineageFingerprint(application: AdoptionApplication): string {
  return fingerprint("lvweeklyadoptcorr:v1:", {
    paymentId: application.payment.id,
    originalAllocationId: application.originalAllocationId,
    allocationId: application.allocation.id,
    obligationId: application.allocation.obligationId,
    amountMinor: application.allocation.amountMinor,
    currency: application.allocation.currency,
    correctionPath: application.correctionPath.map((edge) => ({
      correctionId: edge.id,
      paymentId: edge.paymentId,
      sourceAllocationId: edge.sourceAllocationId,
      replacementAllocationId: edge.replacementAllocationId,
      sourceObligationId: edge.sourceObligationId,
      targetObligationId: edge.targetObligationId,
      amountMinor: edge.amountMinor,
      currency: edge.currency,
      reason: edge.reason,
      recordedByUserId: edge.recordedByUserId,
      createdAt: edge.createdAt,
    })),
  });
}

function previousLocalDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("invalid canonical local date");
  const date = new Date(`${value}T12:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error("invalid canonical local date");
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/** The most recent actual billable occurrence is the open/current week. Keep it
 * outside automatic legacy confirmation even when its start date is today. */
export function deriveOwnedPaymentAdoptionCutoff(
  billableLocalDates: readonly string[],
  localToday: string,
): string {
  previousLocalDate(localToday);
  const dates = [...new Set(billableLocalDates)].sort((left, right) => left.localeCompare(right));
  const firstDate = dates[0];
  if (!firstDate) throw new Error("canonical schedule has no billable occurrences");
  const latestActual = dates.filter((date) => date <= localToday).at(-1);
  return previousLocalDate(latestActual ?? firstDate);
}

function compareIds(left: string | number, right: string | number): number {
  return String(left).localeCompare(String(right));
}

function canonicalBlockers(blockers: Map<string, Set<string | number>>): OwnedPaymentAdoptionBlocker[] {
  return [...blockers.entries()].map(([code, ids]) => ({
    code,
    count: ids.size,
    entityIds: [...ids].sort(compareIds),
  })).sort((left, right) => left.code.localeCompare(right.code));
}

function addBlocker(blockers: Map<string, Set<string | number>>, code: string, id: string | number): void {
  const ids = blockers.get(code) ?? new Set<string | number>();
  ids.add(id);
  blockers.set(code, ids);
}

function activeReviewDispute(state: string): boolean {
  return new Set([
    "INQUIRY_EVIDENCE_REQUIRED", "INQUIRY_PROCESSING", "EVIDENCE_REQUIRED", "PROCESSING", "LOST", "ACCEPTED",
  ]).has(state);
}

function isSafeNoCaptureOperation(operation: typeof paymentOperations.$inferSelect): boolean {
  if (operation.providerObjectId !== null) return false;
  if (operation.status === "action_required" || operation.status === "canceled") return true;
  return operation.status === "failed_terminal"
    && (operation.errorClassification === "hard_decline"
      || operation.errorClassification === "invalid_request");
}

function scheduleFingerprint(schedule: Awaited<ReturnType<typeof loadLeagueOccurrenceScheduleSnapshot>>): unknown {
  return {
    version: schedule.contractVersion,
    ordering: schedule.ordering,
    occurrences: schedule.occurrences.map((row) => ({
      id: row.occurrenceId,
      kind: row.kind,
      status: row.status,
      lifecycle: row.lifecycle,
      localDate: row.authoritativeLocalDate,
      localStartTime: row.authoritativeLocalStartTime,
      timezone: row.timezone,
      startAt: row.startAt,
      revision: row.currentRevision,
      lockReasons: row.effectiveLockReasons,
      billing: row.billing,
      relationships: row.relationships,
      collectionGroups: row.collectionGroups,
    })),
    skippedDates: schedule.skippedDates,
  };
}

function allocationTargetKey(occurrenceId: string, teamId: number, slotIndex: number): string {
  return `${occurrenceId}:${teamId}:${slotIndex}`;
}

async function readDatabaseNow(tx: PaymentOperationTransaction): Promise<string> {
  const result = await tx.execute<{ database_now: string }>(sql`
    SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS database_now
  `);
  const value = result.rows[0]?.database_now;
  if (!value) throw new Error("database time is unavailable");
  return value;
}

function activeAssignmentRows(rows: typeof rotatingOccurrenceAssignments.$inferSelect[]) {
  const latest = new Map<string, typeof rotatingOccurrenceAssignments.$inferSelect>();
  for (const row of [...rows].sort((left, right) => left.version - right.version || left.id.localeCompare(right.id))) {
    latest.set(allocationTargetKey(row.occurrenceId, row.teamId, row.slotIndex), row);
  }
  return latest;
}

function resolveAllocationLineage(
  allocation: typeof paymentAllocations.$inferSelect,
  allocationById: Map<string, typeof paymentAllocations.$inferSelect>,
  correctionByReplacement: Map<string, typeof paymentAllocationCorrections.$inferSelect>,
  correctionBySource: Map<string, typeof paymentAllocationCorrections.$inferSelect>,
): { root: typeof paymentAllocations.$inferSelect; path: Array<typeof paymentAllocationCorrections.$inferSelect> } | null {
  const pathBackward: Array<typeof paymentAllocationCorrections.$inferSelect> = [];
  const visited = new Set<string>();
  let current = allocation;
  while (true) {
    if (visited.has(current.id)) return null;
    visited.add(current.id);
    const correction = correctionByReplacement.get(current.id);
    if (!correction) break;
    const source = allocationById.get(correction.sourceAllocationId);
    const replacement = allocationById.get(correction.replacementAllocationId);
    if (!source || !replacement
      || correction.paymentId !== allocation.paymentId
      || source.paymentId !== correction.paymentId || replacement.paymentId !== correction.paymentId
      || correction.sourceObligationId !== source.obligationId || correction.targetObligationId !== replacement.obligationId
      || source.amountMinor !== correction.amountMinor || replacement.amountMinor !== correction.amountMinor
      || source.currency !== correction.currency || replacement.currency !== correction.currency
      || source.state !== "voided"
      || (correctionBySource.has(replacement.id) && replacement.state !== "voided")) return null;
    pathBackward.push(correction);
    current = source;
  }
  if (current.paymentId !== allocation.paymentId) return null;
  return { root: current, path: pathBackward.reverse() };
}

function correctionRowsAreLinear(
  corrections: readonly typeof paymentAllocationCorrections.$inferSelect[],
  allocationById: Map<string, typeof paymentAllocations.$inferSelect>,
  correctionBySource: Map<string, typeof paymentAllocationCorrections.$inferSelect>,
): boolean {
  for (const edge of corrections) {
    const source = allocationById.get(edge.sourceAllocationId);
    const replacement = allocationById.get(edge.replacementAllocationId);
    if (!source || !replacement || source.state !== "voided"
      || source.paymentId !== edge.paymentId || replacement.paymentId !== edge.paymentId
      || source.obligationId !== edge.sourceObligationId || replacement.obligationId !== edge.targetObligationId
      || source.amountMinor !== edge.amountMinor || replacement.amountMinor !== edge.amountMinor
      || source.currency !== edge.currency || replacement.currency !== edge.currency
      || (correctionBySource.has(replacement.id) && replacement.state !== "voided")) return false;
  }
  for (const startId of allocationById.keys()) {
    const visited = new Set<string>();
    let currentId: string | undefined = startId;
    while (currentId !== undefined) {
      if (visited.has(currentId)) return false;
      visited.add(currentId);
      currentId = correctionBySource.get(currentId)?.replacementAllocationId;
    }
  }
  return true;
}

async function buildOwnedPaymentAdoptionPlan(
  tx: PaymentOperationTransaction,
  input: { organizationId: number; leagueId: number },
  options: { cutoffBeforeFirstBillableDate?: boolean } = {},
): Promise<OwnedPaymentAdoptionPlan> {
  if (!Number.isSafeInteger(input.organizationId) || input.organizationId <= 0
    || !Number.isSafeInteger(input.leagueId) || input.leagueId <= 0) throw new Error("invalid organization or league scope");
  const blockers = new Map<string, Set<string | number>>();
  const schedule = await loadLeagueOccurrenceScheduleSnapshot({
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    includeAdministratorEvidence: false,
  }, tx);
  const [league] = await tx.select({ timezone: leagues.timezone }).from(leagues).where(and(
    eq(leagues.id, input.leagueId),
    eq(leagues.organizationId, input.organizationId),
  )).limit(1);
  const timeZone = league?.timezone ?? schedule.occurrences[0]?.timezone ?? null;
  if (!timeZone || schedule.occurrences.some((row) => row.timezone !== timeZone)) throw new Error("canonical league timezone is unavailable or inconsistent");
  const databaseNow = await readDatabaseNow(tx);
  const localToday = localDateForInstant(databaseNow, timeZone);
  const billableOccurrences = schedule.occurrences.filter(BILLABLE);
  const billableLocalDates = billableOccurrences.map((row) => row.authoritativeLocalDate);
  const firstBillableLocalDate = [...billableLocalDates].sort((left, right) => left.localeCompare(right))[0];
  if (!firstBillableLocalDate) throw new Error("canonical schedule has no billable occurrences");
  const adoptedThroughLocalDate = options.cutoffBeforeFirstBillableDate === true
    ? previousLocalDate(firstBillableLocalDate)
    : deriveOwnedPaymentAdoptionCutoff(billableLocalDates, localToday);
  const occurrenceById = new Map(schedule.occurrences.map((row) => [row.occurrenceId, row]));

  const paymentsRows = await tx.select().from(payments).where(and(
    eq(payments.organizationId, input.organizationId),
    eq(payments.leagueId, input.leagueId),
  )).orderBy(asc(payments.id));
  const operations = await tx.select().from(paymentOperations).where(and(
    eq(paymentOperations.organizationId, input.organizationId),
    eq(paymentOperations.leagueId, input.leagueId),
  )).orderBy(asc(paymentOperations.id));
  const operationIds = operations.map((operation) => operation.id);
  const snapshotItems = operationIds.length === 0 ? [] : await tx.select().from(paymentOperationRosterSnapshotItems).where(and(
    eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId),
    eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId),
    inArray(paymentOperationRosterSnapshotItems.operationId, operationIds),
  )).orderBy(asc(paymentOperationRosterSnapshotItems.operationId), asc(paymentOperationRosterSnapshotItems.allocationIndex));
  const [providerSnapshots, standingBindings, standingParticipants] = operationIds.length === 0 ? [[], [], []] : await Promise.all([
    tx.select().from(paymentOperationRosterSnapshots).where(and(
      eq(paymentOperationRosterSnapshots.organizationId, input.organizationId),
      eq(paymentOperationRosterSnapshots.leagueId, input.leagueId),
      inArray(paymentOperationRosterSnapshots.operationId, operationIds),
    )).orderBy(asc(paymentOperationRosterSnapshots.operationId)),
    tx.select().from(paymentOperationStandingAutopayBindings).where(and(
      eq(paymentOperationStandingAutopayBindings.organizationId, input.organizationId),
      eq(paymentOperationStandingAutopayBindings.leagueId, input.leagueId),
      inArray(paymentOperationStandingAutopayBindings.operationId, operationIds),
    )).orderBy(asc(paymentOperationStandingAutopayBindings.operationId)),
    tx.select().from(paymentOperationStandingAutopayParticipants).where(and(
      eq(paymentOperationStandingAutopayParticipants.organizationId, input.organizationId),
      eq(paymentOperationStandingAutopayParticipants.leagueId, input.leagueId),
      inArray(paymentOperationStandingAutopayParticipants.operationId, operationIds),
    )).orderBy(asc(paymentOperationStandingAutopayParticipants.operationId), asc(paymentOperationStandingAutopayParticipants.allocationIndex)),
  ]);
  const consentIds = [...new Set(standingBindings.map((row) => row.consentId))];
  const [standingConsents, standingConsentPartners] = consentIds.length === 0 ? [[], []] : await Promise.all([
    tx.select().from(autopayConsents).where(and(
      eq(autopayConsents.organizationId, input.organizationId),
      eq(autopayConsents.leagueId, input.leagueId),
      inArray(autopayConsents.id, consentIds),
    )).orderBy(asc(autopayConsents.id)),
    tx.select().from(autopayConsentPartners).where(and(
      eq(autopayConsentPartners.organizationId, input.organizationId),
      eq(autopayConsentPartners.leagueId, input.leagueId),
      inArray(autopayConsentPartners.consentId, consentIds),
    )).orderBy(asc(autopayConsentPartners.consentId), asc(autopayConsentPartners.id)),
  ]);
  const standingLinkIds = [...new Set(standingConsentPartners.flatMap((row) => row.paymentLinkId === null ? [] : [row.paymentLinkId]))];
  const standingPaymentLinks = standingLinkIds.length === 0 ? [] : await tx.select().from(bowlerPaymentLinks).where(and(
    eq(bowlerPaymentLinks.organizationId, input.organizationId),
    inArray(bowlerPaymentLinks.id, standingLinkIds),
  )).orderBy(asc(bowlerPaymentLinks.id));
  const reservations = snapshotItems.filter((row) => row.state === "reserved");
  for (const row of reservations) addBlocker(blockers, "ACTIVE_CAPTURE_RESERVATION", row.operationId);

  const disputes = operations.length === 0 ? [] : await tx.select().from(paymentDisputes).where(and(
    eq(paymentDisputes.organizationId, input.organizationId),
    inArray(paymentDisputes.paymentOperationId, operationIds),
  )).orderBy(asc(paymentDisputes.paymentOperationId), asc(paymentDisputes.id));
  const reviewDisputeOperations = new Set(disputes.filter((row) => activeReviewDispute(row.state)).map((row) => row.paymentOperationId));
  for (const row of disputes.filter((item) => activeReviewDispute(item.state))) addBlocker(blockers, "UNRESOLVED_DISPUTE", row.id);

  const refundSnapshots = await tx.select({
    operationId: refundPaymentOperationSnapshots.operationId,
    paymentId: refundPaymentOperationSnapshots.paymentId,
    snapshotVersion: refundPaymentOperationSnapshots.snapshotVersion,
    snapshotFingerprint: refundPaymentOperationSnapshots.snapshotFingerprint,
    operation: {
      id: paymentOperations.id,
      organizationId: paymentOperations.organizationId,
      status: paymentOperations.status,
      providerObjectId: paymentOperations.providerObjectId,
      amountMinor: paymentOperations.amountMinor,
      currency: paymentOperations.currency,
      errorClassification: paymentOperations.errorClassification,
      errorCode: paymentOperations.errorCode,
    },
  }).from(refundPaymentOperationSnapshots).innerJoin(paymentOperations, eq(
    paymentOperations.id,
    refundPaymentOperationSnapshots.operationId,
  )).where(eq(refundPaymentOperationSnapshots.leagueId, input.leagueId))
    .orderBy(asc(refundPaymentOperationSnapshots.operationId));
  const paymentByOperationId = new Map<string, typeof paymentsRows[number]>();
  const paymentsByOperationId = new Map<string, typeof paymentsRows>();
  for (const payment of paymentsRows) {
    if (payment.paymentOperationId !== null) {
      paymentByOperationId.set(payment.paymentOperationId, payment);
      paymentsByOperationId.set(payment.paymentOperationId, [...(paymentsByOperationId.get(payment.paymentOperationId) ?? []), payment]);
    }
  }
  for (const operation of operations) {
    if (operation.operationType === "refund") continue;
    if (operation.status === "succeeded") {
      if (operation.providerObjectId === null) addBlocker(blockers, "SUCCEEDED_OPERATION_IDENTITY_MISSING", operation.id);
      if (!paymentByOperationId.has(operation.id)) addBlocker(blockers, "CAPTURED_PAYMENT_MISSING", operation.id);
      if ((paymentsByOperationId.get(operation.id)?.length ?? 0) > 1) addBlocker(blockers, "CAPTURED_PAYMENT_DUPLICATED", operation.id);
      if (reviewDisputeOperations.has(operation.id)) addBlocker(blockers, "UNRESOLVED_DISPUTE_OPERATION", operation.id);
    } else if (!isSafeNoCaptureOperation(operation)) {
      addBlocker(blockers, "CAPTURE_OUTCOME_UNRESOLVED", operation.id);
    }
  }

  const voidRows = await tx.select().from(paymentVoids).where(and(
    eq(paymentVoids.organizationId, input.organizationId),
    eq(paymentVoids.leagueId, input.leagueId),
  )).orderBy(asc(paymentVoids.paymentId));
  const voidPaymentIds = new Set(voidRows.map((row) => row.paymentId));
  for (const payment of paymentsRows) {
    if (payment.status === "paid" && voidPaymentIds.has(payment.id)) addBlocker(blockers, "PAID_TENDER_HAS_VOID_EVIDENCE", payment.id);
  }
  const allocations = await tx.select().from(paymentAllocations).where(and(
    eq(paymentAllocations.organizationId, input.organizationId),
    eq(paymentAllocations.leagueId, input.leagueId),
  )).orderBy(asc(paymentAllocations.paymentId), asc(paymentAllocations.createdAt), asc(paymentAllocations.id));
  const allocationById = new Map(allocations.map((row) => [row.id, row]));
  const corrections = await tx.select().from(paymentAllocationCorrections).where(and(
    eq(paymentAllocationCorrections.organizationId, input.organizationId),
    eq(paymentAllocationCorrections.leagueId, input.leagueId),
  )).orderBy(asc(paymentAllocationCorrections.createdAt), asc(paymentAllocationCorrections.id));
  const correctionBySource = new Map<string, typeof paymentAllocationCorrections.$inferSelect>();
  const correctionByReplacement = new Map<string, typeof paymentAllocationCorrections.$inferSelect>();
  for (const correction of corrections) {
    if (correctionBySource.has(correction.sourceAllocationId) || correctionByReplacement.has(correction.replacementAllocationId)) {
      addBlocker(blockers, "ALLOCATION_CORRECTION_LINEAGE_AMBIGUOUS", correction.id);
    }
    correctionBySource.set(correction.sourceAllocationId, correction);
    correctionByReplacement.set(correction.replacementAllocationId, correction);
  }
  if (!correctionRowsAreLinear(corrections, allocationById, correctionBySource)) {
    addBlocker(blockers, "ALLOCATION_CORRECTION_LINEAGE_INVALID", input.leagueId);
  }
  const obligations = await tx.select().from(paymentObligations).where(and(
    eq(paymentObligations.organizationId, input.organizationId),
    eq(paymentObligations.leagueId, input.leagueId),
  )).orderBy(asc(paymentObligations.occurrenceId), asc(paymentObligations.id));
  const obligationById = new Map(obligations.map((row) => [row.id, row]));
  const responsibilities = await tx.select().from(occurrencePaymentResponsibilities).where(and(
    eq(occurrencePaymentResponsibilities.organizationId, input.organizationId),
    eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
  )).orderBy(asc(occurrencePaymentResponsibilities.id));
  const responsibilityById = new Map(responsibilities.map((row) => [row.id, row]));
  const ownerRevisions = await tx.select().from(paymentObligationOwnerRevisions).where(and(
    eq(paymentObligationOwnerRevisions.organizationId, input.organizationId),
    eq(paymentObligationOwnerRevisions.leagueId, input.leagueId),
  )).orderBy(asc(paymentObligationOwnerRevisions.obligationId), asc(paymentObligationOwnerRevisions.revisionNumber));
  const assignmentRows = await tx.select().from(rotatingOccurrenceAssignments).where(and(
    eq(rotatingOccurrenceAssignments.organizationId, input.organizationId),
    eq(rotatingOccurrenceAssignments.leagueId, input.leagueId),
  )).orderBy(asc(rotatingOccurrenceAssignments.occurrenceId), asc(rotatingOccurrenceAssignments.teamId), asc(rotatingOccurrenceAssignments.slotIndex), asc(rotatingOccurrenceAssignments.version));
  const latestAssignments = activeAssignmentRows(assignmentRows);
  const confirmations = await tx.select().from(weeklyPaymentWeekConfirmations).where(and(
    eq(weeklyPaymentWeekConfirmations.organizationId, input.organizationId),
    eq(weeklyPaymentWeekConfirmations.leagueId, input.leagueId),
  )).orderBy(asc(weeklyPaymentWeekConfirmations.occurrenceId), asc(weeklyPaymentWeekConfirmations.revision));
  const confirmedOccurrenceIds = new Set(confirmations.map((row) => row.occurrenceId));
  const isConfirmed = (occurrenceId: string): boolean => {
    const occurrence = occurrenceById.get(occurrenceId);
    return occurrence !== undefined && BILLABLE(occurrence)
      && (occurrence.authoritativeLocalDate <= adoptedThroughLocalDate || confirmedOccurrenceIds.has(occurrenceId));
  };

  const refundAdjustments = await tx.select().from(refundAllocationAdjustments).where(and(
    eq(refundAllocationAdjustments.organizationId, input.organizationId),
    eq(refundAllocationAdjustments.leagueId, input.leagueId),
  )).orderBy(asc(refundAllocationAdjustments.sourceAllocationId), asc(refundAllocationAdjustments.id));
  for (const row of refundAdjustments) addBlocker(blockers, "LEGACY_REFUND_ADJUSTMENT_UNSUPPORTED", row.sourceAllocationId);
  const obligationsWithActiveAllocations = new Set(allocations.filter((row) => row.state === "active").map((row) => row.obligationId));

  const targetForObligation = new Map<string, {
    owner: EffectivePaymentObligationOwner;
    targetKind: "bowler_responsibility" | "legacy_team_assignment";
    targetPayerBowlerId: number | null;
    assignmentId: string | null;
    debtorBowlerId: number;
  }>();
  const ownerProofObligations = obligations.filter((obligation) => {
    const occurrence = occurrenceById.get(obligation.occurrenceId);
    return occurrence !== undefined && BILLABLE(occurrence) && obligation.state !== "voided"
      && (isConfirmed(obligation.occurrenceId) || obligationsWithActiveAllocations.has(obligation.id));
  });
  const ownerByObligation = new Map<string, EffectivePaymentObligationOwner>();
  const ownerErrorByObligation = new Map<string, string>();
  if (ownerProofObligations.length > 0) {
    const resolveOwnerBatch = async (batch: typeof ownerProofObligations): Promise<void> => {
      if (batch.length === 0) return;
      try {
        for (const [obligationId, owner] of await resolvePaymentObligationOwnersInTransaction(tx, {
          organizationId: input.organizationId,
          leagueId: input.leagueId,
          obligations: batch,
        })) ownerByObligation.set(obligationId, owner);
      } catch (error) {
        if (!(error instanceof PaymentObligationOwnerError)) throw error;
        if (batch.length === 1) {
          const obligation = batch[0];
          if (!obligation) return;
          ownerErrorByObligation.set(obligation.id, error.code);
          return;
        }
        // Keep exact blockers for malformed histories while the healthy path
        // stays one batch query. Split only a batch that the shared resolver
        // rejected, and do not turn database failures into thousands of reads.
        const midpoint = Math.ceil(batch.length / 2);
        await resolveOwnerBatch(batch.slice(0, midpoint));
        await resolveOwnerBatch(batch.slice(midpoint));
      }
    };
    await resolveOwnerBatch(ownerProofObligations);
  }
  for (const obligation of obligations) {
    const occurrence = occurrenceById.get(obligation.occurrenceId);
    if (!occurrence || !BILLABLE(occurrence) || obligation.state === "voided") continue;
    const requireOwnerProof = isConfirmed(obligation.occurrenceId) || obligationsWithActiveAllocations.has(obligation.id);
    if (!requireOwnerProof) continue;
    const owner = ownerByObligation.get(obligation.id);
    if (!owner) {
      addBlocker(blockers, `OBLIGATION_OWNER_${ownerErrorByObligation.get(obligation.id) ?? "OWNER_UNPROVEN"}`, obligation.id);
      continue;
    }
    const responsibility = responsibilityById.get(obligation.responsibilityId);
    if (!responsibility) {
      addBlocker(blockers, "OBLIGATION_RESPONSIBILITY_MISSING", obligation.id);
      continue;
    }
    if (owner.kind === "bowler") {
      if (obligation.payerBowlerId === null || obligation.payerBowlerId !== owner.bowlerId) {
        addBlocker(blockers, "OBLIGATION_PAYER_OWNER_MISMATCH", obligation.id);
        continue;
      }
      targetForObligation.set(obligation.id, {
        owner,
        targetKind: "bowler_responsibility",
        targetPayerBowlerId: obligation.payerBowlerId,
        assignmentId: null,
        debtorBowlerId: owner.bowlerId,
      });
    } else {
      const slotIndex = responsibility.slotIndex;
      const assignment = slotIndex === null ? undefined : latestAssignments.get(allocationTargetKey(
        obligation.occurrenceId, responsibility.teamId, slotIndex,
      ));
      if (!assignment || assignment.responsibilityId !== responsibility.id || assignment.actualBowlerId === null
        || owner.teamId !== responsibility.teamId) {
        addBlocker(blockers, isConfirmed(obligation.occurrenceId)
          ? "PAST_TEAM_OBLIGATION_UNASSIGNED" : "UNCONFIRMED_ALLOCATION_TARGET_UNPROVEN", obligation.id);
        continue;
      }
      targetForObligation.set(obligation.id, {
        owner,
        targetKind: "legacy_team_assignment",
        targetPayerBowlerId: null,
        assignmentId: assignment.id,
        debtorBowlerId: assignment.actualBowlerId,
      });
    }
  }

  const adoptions = await readOwnedLedgerAdoptionInTransaction(tx, input);
  if (adoptions) addBlocker(blockers, "LEDGER_ALREADY_ADOPTED", adoptions.id);
  const [adoptionRowsExisting, fundingsExisting, authorizationItemsExisting, applicationsExisting,
    proofsExisting, proofStepsExisting, releasesExisting, receiptsExisting, receiptRevisionsExisting] = await Promise.all([
    tx.select().from(weeklyPaymentLedgerAdoptions).where(and(
      eq(weeklyPaymentLedgerAdoptions.organizationId, input.organizationId),
      eq(weeklyPaymentLedgerAdoptions.leagueId, input.leagueId),
    )).orderBy(asc(weeklyPaymentLedgerAdoptions.id)),
    tx.select().from(weeklyPaymentFundings).where(and(
      eq(weeklyPaymentFundings.organizationId, input.organizationId),
      eq(weeklyPaymentFundings.leagueId, input.leagueId),
    )).orderBy(asc(weeklyPaymentFundings.id)),
    tx.select().from(weeklyPaymentFundingAuthorizationItems).where(and(
      eq(weeklyPaymentFundingAuthorizationItems.organizationId, input.organizationId),
      eq(weeklyPaymentFundingAuthorizationItems.leagueId, input.leagueId),
    )).orderBy(asc(weeklyPaymentFundingAuthorizationItems.id)),
    tx.select().from(paymentAllocationFundingApplications).where(and(
      eq(paymentAllocationFundingApplications.organizationId, input.organizationId),
      eq(paymentAllocationFundingApplications.leagueId, input.leagueId),
    )).orderBy(asc(paymentAllocationFundingApplications.id)),
    tx.select().from(weeklyPaymentLedgerAdoptionAllocationProofs).where(and(
      eq(weeklyPaymentLedgerAdoptionAllocationProofs.organizationId, input.organizationId),
      eq(weeklyPaymentLedgerAdoptionAllocationProofs.leagueId, input.leagueId),
    )).orderBy(asc(weeklyPaymentLedgerAdoptionAllocationProofs.id)),
    tx.select().from(weeklyPaymentLedgerAdoptionAllocationProofSteps).where(and(
      eq(weeklyPaymentLedgerAdoptionAllocationProofSteps.organizationId, input.organizationId),
      eq(weeklyPaymentLedgerAdoptionAllocationProofSteps.leagueId, input.leagueId),
    )).orderBy(asc(weeklyPaymentLedgerAdoptionAllocationProofSteps.id)),
    tx.select().from(weeklyPaymentAllocationReleases).where(and(
      eq(weeklyPaymentAllocationReleases.organizationId, input.organizationId),
      eq(weeklyPaymentAllocationReleases.leagueId, input.leagueId),
    )).orderBy(asc(weeklyPaymentAllocationReleases.id)),
    tx.select().from(weeklyPaymentWorksheetReceipts).where(and(
      eq(weeklyPaymentWorksheetReceipts.organizationId, input.organizationId),
      eq(weeklyPaymentWorksheetReceipts.leagueId, input.leagueId),
    )).orderBy(asc(weeklyPaymentWorksheetReceipts.id)),
    tx.select().from(weeklyPaymentWorksheetReceiptRevisions).where(and(
      eq(weeklyPaymentWorksheetReceiptRevisions.organizationId, input.organizationId),
      eq(weeklyPaymentWorksheetReceiptRevisions.leagueId, input.leagueId),
    )).orderBy(asc(weeklyPaymentWorksheetReceiptRevisions.id)),
  ]);
  if (fundingsExisting.length > 0 || authorizationItemsExisting.length > 0 || applicationsExisting.length > 0
    || proofsExisting.length > 0 || proofStepsExisting.length > 0 || releasesExisting.length > 0
    || receiptsExisting.length > 0 || receiptRevisionsExisting.length > 0) {
    addBlocker(blockers, "OWNED_LEDGER_ROWS_PREEXIST", input.leagueId);
  }

  const rotatingRows = await tx.select({
    application: rotatingCreditApplications,
    allocation: paymentAllocations,
    reversal: rotatingCreditApplicationReversals,
  }).from(rotatingCreditApplications)
    .innerJoin(paymentAllocations, and(
      eq(paymentAllocations.id, rotatingCreditApplications.allocationId),
      eq(paymentAllocations.organizationId, input.organizationId),
      eq(paymentAllocations.leagueId, input.leagueId),
    ))
    .leftJoin(rotatingCreditApplicationReversals, and(
      eq(rotatingCreditApplicationReversals.applicationId, rotatingCreditApplications.id),
      eq(rotatingCreditApplicationReversals.organizationId, input.organizationId),
      eq(rotatingCreditApplicationReversals.leagueId, input.leagueId),
    )).where(and(
      eq(rotatingCreditApplications.organizationId, input.organizationId),
      eq(rotatingCreditApplications.leagueId, input.leagueId),
    )).orderBy(asc(rotatingCreditApplications.appliedAt), asc(rotatingCreditApplications.id));
  const rotatingAppByAllocation = new Map(rotatingRows.map((row) => [row.application.allocationId, row]));
  for (const row of rotatingRows) {
    const identityValid = row.application.paymentId === row.allocation.paymentId
      && row.application.obligationId === row.allocation.obligationId
      && row.application.amountMinor === row.allocation.amountMinor;
    if (!identityValid
      || (row.allocation.state === "active" && row.reversal !== null)
      || (row.allocation.state === "voided" && row.reversal === null)
      || !["active", "voided"].includes(row.allocation.state)) {
      addBlocker(blockers, "ROTATING_APPLICATION_INCONSISTENT", row.application.id);
    }
  }
  const rotatingFundings = await tx.select().from(rotatingCreditFundings).where(and(
    eq(rotatingCreditFundings.organizationId, input.organizationId),
    eq(rotatingCreditFundings.leagueId, input.leagueId),
  )).orderBy(asc(rotatingCreditFundings.paymentId));
  const rotatingFundingPaymentIds = new Set(rotatingFundings.map((row) => row.paymentId));
  const rotatingRefundRows = rotatingFundings.length === 0 ? [] : await tx.select({
    refund: rotatingCreditRefunds,
    operation: paymentOperations,
  }).from(rotatingCreditRefunds).leftJoin(paymentOperations, and(
    eq(paymentOperations.id, rotatingCreditRefunds.refundOperationId),
    eq(paymentOperations.organizationId, input.organizationId),
    eq(paymentOperations.leagueId, input.leagueId),
  )).where(and(
    eq(rotatingCreditRefunds.organizationId, input.organizationId),
    eq(rotatingCreditRefunds.leagueId, input.leagueId),
  )).orderBy(asc(rotatingCreditRefunds.createdAt), asc(rotatingCreditRefunds.id));
  for (const row of rotatingRefundRows) {
    const unresolved = row.refund.refundKind === "provider"
      ? row.operation === null || isRotatingCreditRefundUnresolvedForReversal(row.operation)
      : row.refund.issuedAt === null || !row.refund.reference?.trim();
    if (unresolved) addBlocker(blockers, "ROTATING_REFUND_UNRESOLVED", row.refund.id);
  }
  const rotatingRefundOperationIds = new Set(rotatingRefundRows.flatMap(({ refund }) =>
    refund.refundOperationId === null ? [] : [refund.refundOperationId]));
  for (const row of refundSnapshots) {
    if (rotatingFundingPaymentIds.has(row.paymentId) && rotatingRefundOperationIds.has(row.operationId)) continue;
    if (row.operation.organizationId !== input.organizationId) {
      addBlocker(blockers, "REFUND_SNAPSHOT_SCOPE_INVALID", row.paymentId);
    } else if (row.operation.status === "succeeded" && row.operation.providerObjectId !== null) {
      addBlocker(blockers, "LEGACY_COMPLETED_REFUND_UNSUPPORTED", row.paymentId);
    } else if (!isConfirmedNoRefundCreditOutcome(row.operation)) {
      addBlocker(blockers, "UNRESOLVED_REFUND", row.operationId);
    }
  }
  for (const operation of operations) {
    if (operation.operationType !== "refund" || rotatingRefundOperationIds.has(operation.id)) continue;
    if (operation.status === "succeeded" && operation.providerObjectId !== null) {
      addBlocker(blockers, "LEGACY_COMPLETED_REFUND_UNSUPPORTED", refundSnapshots.find((row) => row.operationId === operation.id)?.paymentId ?? operation.id);
    } else if (!isConfirmedNoRefundCreditOutcome(operation)) {
      addBlocker(blockers, "UNRESOLVED_REFUND", operation.id);
    }
  }
  const rotatingBalances = await readRotatingCreditFundingBalancesInTransaction(tx, {
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    bowlerIds: [...new Set(rotatingFundings.map((row) => row.bowlerId))],
  });
  const rotatingBalanceByFundingId = new Map(rotatingBalances.map((row) => [row.fundingId, row]));
  for (const funding of rotatingFundings) {
    const balance = rotatingBalanceByFundingId.get(funding.id);
    if (!balance || balance.reviewRequired) addBlocker(blockers, "ROTATING_SOURCE_INCONSISTENT", funding.id);
  }
  const rotatingFundingById = new Map(rotatingFundings.map((row) => [row.id, row]));
  for (const row of rotatingRows) {
    const funding = rotatingFundingById.get(row.application.fundingId);
    if (!funding || row.application.paymentId !== funding.paymentId
      || row.application.actualBowlerId !== funding.bowlerId
      || row.application.organizationId !== input.organizationId
      || row.application.leagueId !== input.leagueId) {
      addBlocker(blockers, "ROTATING_APPLICATION_INCONSISTENT", row.application.id);
    }
  }

  const fundings: AdoptionFunding[] = [];
  const portionsByPayment = new Map<number, LegacyFundingAuthorizationPortion[]>();
  const paymentById = new Map(paymentsRows.map((payment) => [payment.id, payment]));
  const paidPayments = paymentsRows.filter((payment) => payment.status === "paid");
  const voidPayments = paymentsRows.filter((payment) => payment.status === "voided");
  for (const payment of paymentsRows) {
    if (payment.status === "voided") {
      if (!voidPaymentIds.has(payment.id)) addBlocker(blockers, "VOIDED_TENDER_WITHOUT_AUDIT", payment.id);
      continue;
    }
    if (payment.status === "refunded") {
      addBlocker(blockers, "LEGACY_REFUNDED_TENDER_UNSUPPORTED", payment.id);
      continue;
    }
    if (payment.status !== "paid") {
      if (payment.status === "disputed" || payment.paymentOperationId !== null || payment.providerPaymentId !== null) {
        addBlocker(blockers, "NONPAID_TENDER_WITH_PROVIDER_IDENTITY", payment.id);
      }
      continue;
    }
    if (payment.disputeId !== null || payment.disputedAt !== null) {
      addBlocker(blockers, "PAYMENT_DISPUTE_EVIDENCE", payment.id);
      continue;
    }
    if (payment.squareRefundId !== null || payment.refundedAt !== null) {
      addBlocker(blockers, "LEGACY_COMPLETED_REFUND_UNSUPPORTED", payment.id);
      continue;
    }
    if (rotatingFundingPaymentIds.has(payment.id)) continue;
    try {
      const authorization = await readLegacyFundingAuthorizationInTransaction(tx, {
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        paymentId: payment.id,
        payment,
      });
      portionsByPayment.set(payment.id, authorization.portions);
      fundings.push(...authorization.portions.map((portion) => ({ payment, portion })));
    } catch (error) {
      const code = error instanceof OwnedPaymentLedgerError ? error.code : "LEGACY_AUTHORIZATION_UNPROVEN";
      addBlocker(blockers, code, payment.id);
    }
  }

  const applications: AdoptionApplication[] = [];
  const rotatingReleases: RotatingRelease[] = [];
  const snapshotItemsByOperation = new Map<string, typeof snapshotItems>();
  for (const item of snapshotItems) snapshotItemsByOperation.set(item.operationId, [...(snapshotItemsByOperation.get(item.operationId) ?? []), item]);
  const allActiveAllocationIdsByAuthItem = new Map<string, string[]>();
  const allActivePaymentAllocations = allocations.filter((allocation) => allocation.state === "active");
  for (const allocation of allocations) {
    const payment = paymentById.get(allocation.paymentId);
    if (!payment) {
      addBlocker(blockers, "ALLOCATION_PAYMENT_MISSING", allocation.id);
      continue;
    }
    if (allocation.state !== "active") continue;
    const rotating = rotatingAppByAllocation.get(allocation.id);
    if (rotating) {
      if (rotating.reversal !== null || rotating.allocation.state !== "active"
        || rotating.application.paymentId !== rotating.allocation.paymentId
        || rotating.application.obligationId !== rotating.allocation.obligationId
        || rotating.application.amountMinor !== rotating.allocation.amountMinor) {
        addBlocker(blockers, "ROTATING_APPLICATION_INCONSISTENT", rotating.application.id);
        continue;
      }
      if (!isConfirmed(rotating.application.occurrenceId)) {
        rotatingReleases.push({ application: rotating.application, assignmentId: rotating.application.assignmentId });
      }
      continue;
    }
    if (payment.status !== "paid") {
      addBlocker(blockers, "ACTIVE_ALLOCATION_WITHOUT_PAID_TENDER", allocation.id);
      continue;
    }
    if (allocation.allocationKind !== "ordinary") {
      addBlocker(blockers, "UNOWNED_CREDIT_ALLOCATION_KIND", allocation.id);
      continue;
    }
    const portions = portionsByPayment.get(payment.id);
    if (!portions) continue;
    const lineage = resolveAllocationLineage(allocation, allocationById, correctionByReplacement, correctionBySource);
    if (!lineage) {
      addBlocker(blockers, "ALLOCATION_CORRECTION_LINEAGE_INVALID", allocation.id);
      continue;
    }
    let portion: LegacyFundingAuthorizationPortion | undefined;
    let authorizedAllocationIndex: number | null = null;
    if (payment.paymentOperationId !== null) {
      const snapshotItem = snapshotItemsByOperation.get(payment.paymentOperationId)?.filter((item) =>
        item.obligationId === lineage.root.obligationId && item.amountMinor === lineage.root.amountMinor,
      ) ?? [];
      const matches = snapshotItem.flatMap((item) => portions.filter((candidate) => candidate.authorizationItems.some((auth) =>
        auth.allocationIndex === item.allocationIndex && auth.amountMinor === item.amountMinor,
      )));
      const snapshotItemRow = snapshotItem[0];
      const matchedPortion = matches[0];
      if (snapshotItem.length !== 1 || matches.length !== 1 || !snapshotItemRow || !matchedPortion) {
        addBlocker(blockers, "LEGACY_ALLOCATION_AUTHORIZATION_AMBIGUOUS", allocation.id);
        continue;
      }
      portion = matchedPortion;
      authorizedAllocationIndex = snapshotItemRow.allocationIndex;
      const itemKey = `${payment.paymentOperationId}:${snapshotItemRow.allocationIndex}`;
      allActiveAllocationIdsByAuthItem.set(itemKey, [...(allActiveAllocationIdsByAuthItem.get(itemKey) ?? []), allocation.id]);
    } else {
      portion = portions.find((candidate) => candidate.creditedBowlerId === payment.bowlerId && candidate.authorizationKind === "legacy_payment");
    }
    if (!portion) {
      addBlocker(blockers, "LEGACY_ALLOCATION_SOURCE_OWNER_UNPROVEN", allocation.id);
      continue;
    }
    const obligation = obligationById.get(allocation.obligationId);
    if (!obligation || !occurrenceById.has(obligation.occurrenceId)) {
      addBlocker(blockers, "ALLOCATION_OBLIGATION_MISSING", allocation.id);
      continue;
    }
    const responsibility = responsibilityById.get(obligation.responsibilityId);
    if (!responsibility) {
      addBlocker(blockers, "ALLOCATION_RESPONSIBILITY_MISSING", allocation.id);
      continue;
    }
    const target = targetForObligation.get(allocation.obligationId);
    if (!target) {
      if (isConfirmed(obligation.occurrenceId)) addBlocker(blockers, "ALLOCATION_TARGET_UNPROVEN", allocation.id);
      else addBlocker(blockers, "UNCONFIRMED_ALLOCATION_TARGET_UNPROVEN", allocation.id);
      continue;
    }
    const decision = isConfirmed(obligation.occurrenceId) ? "retain" : "release";
    const crossesOwner = target.debtorBowlerId !== portion.creditedBowlerId;
    const exactProviderItem = portion.authorizationKind === "legacy_provider_snapshot"
      && portion.authorizationOperationId !== null
      && authorizedAllocationIndex !== null
      && lineage.root.amountMinor === allocation.amountMinor
      && portion.authorizationItems.some((item) => item.allocationIndex === authorizedAllocationIndex
        && item.amountMinor === lineage.root.amountMinor
        && item.snapshotFingerprint === portion.authorizationFingerprint);
    if (decision === "retain" && crossesOwner && !exactProviderItem) {
      addBlocker(blockers, "CROSS_OWNER_ALLOCATION_AUTHORIZATION_UNPROVEN", allocation.id);
    }
    applications.push({
      allocation,
      payment,
      portion,
      originalAllocationId: lineage.root.id,
      authorizedAllocationIndex,
      correctionPath: lineage.path,
      decision,
      targetKind: target.targetKind,
      targetPayerBowlerId: target.targetPayerBowlerId,
      assignmentId: target.assignmentId,
      obligationOwner: target.owner,
      debtorBowlerId: target.debtorBowlerId,
      responsibilityId: obligation.responsibilityId,
      occurrenceId: obligation.occurrenceId,
      teamId: responsibility.teamId,
    });
  }
  for (const [itemKey, allocationIds] of allActiveAllocationIdsByAuthItem) {
    if (allocationIds.length !== 1) for (const id of allocationIds) addBlocker(blockers, "LEGACY_ALLOCATION_AUTHORIZATION_AMBIGUOUS", id);
    const item = snapshotItems.find((row) => `${row.operationId}:${row.allocationIndex}` === itemKey);
    if (!item || item.state !== "finalized") for (const id of allocationIds) addBlocker(blockers, "LEGACY_ALLOCATION_AUTHORIZATION_NOT_FINALIZED", id);
  }

  const receipts: AdoptionReceipt[] = [];
  for (const payment of paidPayments) {
    if (payment.type !== "cash" && payment.type !== "check") continue;
    const businessCollectionLocalDate = localDateForInstant(payment.createdAt, timeZone);
    const occurrenceId = mapCardReceiptCollectionOccurrence({
      explicitCollectionOccurrenceId: null,
      triggerOccurrenceId: null,
      collectionLocalDate: businessCollectionLocalDate,
    }, schedule);
    if (!occurrenceId) {
      addBlocker(blockers, "MANUAL_RECEIPT_COLLECTION_PERIOD_UNMAPPABLE", payment.id);
      continue;
    }
    receipts.push({
      paymentId: payment.id,
      payerBowlerId: payment.bowlerId,
      occurrenceId,
      businessCollectionLocalDate,
      amountMinor: payment.amount,
    });
  }

  for (const allocation of allActivePaymentAllocations) {
    const payment = paymentById.get(allocation.paymentId);
    if (payment?.status === "voided") addBlocker(blockers, "VOIDED_TENDER_HAS_ACTIVE_ALLOCATION", allocation.id);
  }
  const sourceFingerprint = fingerprint(OWNED_PAYMENT_ADOPTION_PREFLIGHT_PREFIX, {
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    timeZone,
    localToday,
    adoptedThroughLocalDate,
    canonicalSchedule: scheduleFingerprint(schedule),
    source: {
      payments: paymentsRows,
      paymentVoids: voidRows,
      operations,
      snapshotItems,
      providerSnapshots,
      standingBindings,
      standingParticipants,
      standingConsents,
      standingConsentPartners,
      standingPaymentLinks,
      strictLegacyAuthorizations: fundings.map(({ payment, portion }) => ({
        paymentId: payment.id,
        creditedBowlerId: portion.creditedBowlerId,
        portionIndex: portion.portionIndex,
        amountMinor: portion.amountMinor,
        authorizationKind: portion.authorizationKind,
        authorizationOperationId: portion.authorizationOperationId,
        authorizationItemCount: portion.authorizationItemCount,
        authorizationFingerprint: portion.authorizationFingerprint,
        authorizationItems: portion.authorizationItems,
      })),
      refundSnapshots,
      disputes,
      obligations: obligations.map((row) => ({
        id: row.id, occurrenceId: row.occurrenceId, responsibilityId: row.responsibilityId, component: row.component,
        payerBowlerId: row.payerBowlerId, amountMinor: row.amountMinor, currency: row.currency, dueAt: row.dueAt,
        pastDueAt: row.pastDueAt, state: row.state, voidedAt: row.voidedAt,
      })),
      responsibilities: responsibilities.map((row) => ({
        id: row.id, occurrenceId: row.occurrenceId, teamId: row.teamId, slotIndex: row.slotIndex, version: row.version,
        state: row.state, kind: row.responsibilityKind, payerBowlerId: row.payerBowlerId, amountMinor: row.amountMinor,
        lineagePayerBowlerId: row.lineagePayerBowlerId, prizePayerBowlerId: row.prizePayerBowlerId,
        worksheetFeeComponent: row.worksheetFeeComponent,
      })),
      ownerRevisions: ownerRevisions.map((row) => ({
        id: row.id, obligationId: row.obligationId, revisionNumber: row.revisionNumber, ownerKind: row.ownerKind,
        ownerBowlerId: row.ownerBowlerId, ownerTeamId: row.ownerTeamId, reason: row.reason,
        recordedByUserId: row.recordedByUserId, createdAt: row.createdAt,
      })),
      assignments: assignmentRows.map((row) => ({
        id: row.id, occurrenceId: row.occurrenceId, teamId: row.teamId, slotIndex: row.slotIndex,
        responsibilityId: row.responsibilityId, actualBowlerId: row.actualBowlerId, version: row.version,
      })),
      confirmations: confirmations.map((row) => ({
        id: row.id, occurrenceId: row.occurrenceId, revision: row.revision, stateFingerprint: row.stateFingerprint,
        requestFingerprint: row.requestFingerprint, responsibilitySetFingerprint: row.responsibilitySetFingerprint,
        idempotencyKey: row.idempotencyKey, requestSnapshot: row.requestSnapshot,
        recordedByUserId: row.recordedByUserId, createdAt: row.createdAt,
      })),
      allocations: allocations.map((row) => ({
        id: row.id, paymentId: row.paymentId, obligationId: row.obligationId, amountMinor: row.amountMinor,
        currency: row.currency, state: row.state, allocationKind: row.allocationKind, reviewRequired: row.reviewRequired,
        reviewReason: row.reviewReason,
      })),
      corrections: corrections.map((row) => ({
        id: row.id, paymentId: row.paymentId, sourceAllocationId: row.sourceAllocationId,
        replacementAllocationId: row.replacementAllocationId, sourceObligationId: row.sourceObligationId,
        targetObligationId: row.targetObligationId, amountMinor: row.amountMinor, currency: row.currency,
        reason: row.reason, recordedByUserId: row.recordedByUserId, createdAt: row.createdAt,
      })),
      refundAdjustments: refundAdjustments.map((row) => ({
        id: row.id, refundOperationId: row.refundOperationId, sourceAllocationId: row.sourceAllocationId,
        amountMinor: row.amountMinor, disposition: row.disposition, snapshotFingerprint: row.snapshotFingerprint,
      })),
      rotatingFundings,
      rotatingBalances,
      rotatingApplications: rotatingRows.map((row) => ({
        application: row.application, allocation: row.allocation, reversal: row.reversal,
      })),
      rotatingRefunds: rotatingRefundRows.map((row) => ({
        refund: row.refund,
        operation: row.operation,
      })),
      existingOwnedLedger: {
        adoptions: adoptionRowsExisting,
        fundings: fundingsExisting,
        authorizationItems: authorizationItemsExisting,
        applications: applicationsExisting,
        allocationProofs: proofsExisting,
        allocationProofSteps: proofStepsExisting,
        allocationReleases: releasesExisting,
        receipts: receiptsExisting,
        receiptRevisions: receiptRevisionsExisting,
      },
    },
  });
  const plannedBlockers = canonicalBlockers(blockers);
  const semanticPlan = {
    adoptedThroughLocalDate,
    fundingPortions: fundings.map(({ payment, portion }) => ({
      paymentId: payment.id,
      creditedBowlerId: portion.creditedBowlerId,
      portionIndex: portion.portionIndex,
      amountMinor: portion.amountMinor,
      authorizationKind: portion.authorizationKind,
      authorizationOperationId: portion.authorizationOperationId,
      authorizationItemCount: portion.authorizationItemCount,
      authorizationFingerprint: portion.authorizationFingerprint,
      authorizationItems: portion.authorizationItems,
    })),
    allocationDecisions: applications.map((row) => ({
      paymentId: row.payment.id,
      creditedBowlerId: row.portion.creditedBowlerId,
      amountMinor: row.allocation.amountMinor,
      currency: row.allocation.currency,
      allocationId: row.allocation.id,
      originalAllocationId: row.originalAllocationId,
      authorizedAllocationIndex: row.authorizedAllocationIndex,
      correctionPath: row.correctionPath.map((edge) => edge.id),
      obligationId: row.allocation.obligationId,
      responsibilityId: row.responsibilityId,
      occurrenceId: row.occurrenceId,
      teamId: row.teamId,
      ownerKind: row.obligationOwner.kind,
      ownerId: row.obligationOwner.kind === "bowler" ? row.obligationOwner.bowlerId : row.obligationOwner.teamId,
      debtorBowlerId: row.debtorBowlerId,
      targetKind: row.targetKind,
      targetPayerBowlerId: row.targetPayerBowlerId,
      assignmentId: row.assignmentId,
      decision: row.decision,
    })),
    rotatingReleases: rotatingReleases.map((row) => ({
      applicationId: row.application.id,
      allocationId: row.application.allocationId,
      paymentId: row.application.paymentId,
      obligationId: row.application.obligationId,
      occurrenceId: row.application.occurrenceId,
      creditedBowlerId: row.application.actualBowlerId,
      amountMinor: row.application.amountMinor,
      assignmentId: row.assignmentId,
      decision: "release",
    })),
    manualReceipts: receipts.map((row) => ({ ...row })),
  };
  const resultFingerprint = fingerprint(OWNED_PAYMENT_ADOPTION_RESULT_PREFIX, semanticPlan);
  const retained = applications.filter((row) => row.decision === "retain");
  const grandfathered = retained.filter((row) => row.debtorBowlerId !== row.portion.creditedBowlerId);
  return {
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    timezone: timeZone,
    localToday,
    adoptedThroughLocalDate,
    ready: plannedBlockers.length === 0,
    sourceFingerprint,
    resultFingerprint,
    counts: {
      paidPayments: paidPayments.length,
      genericFundingPortions: fundings.length,
      retainedAllocations: retained.length,
      genericAllocationReleases: applications.filter((row) => row.decision === "release").length,
      rotatingAllocationReleases: rotatingReleases.length,
      grandfatheredAllocations: grandfathered.length,
      manualReceipts: receipts.length,
      preservedVoidedPayments: voidPayments.length,
    },
    blockers: plannedBlockers,
    fundings,
    applications,
    rotatingReleases,
    receipts,
  };
}

/** Read-only repeatable-read adoption plan. The callback never writes and the
 * PostgreSQL transaction is explicitly marked READ ONLY. */
export async function preflightOwnedPaymentLedgerAdoption(
  input: { organizationId: number; leagueId: number },
  executor: AdoptionPreflightExecutor = db,
): Promise<OwnedPaymentAdoptionPreflight> {
  const plan = await executor.transaction(
    (tx) => buildOwnedPaymentAdoptionPlan(tx, input),
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
  const { fundings: _fundings, applications: _applications, rotatingReleases: _rotating, receipts: _receipts, ...summary } = plan;
  return summary;
}

/** Internal apply seam: the caller holds the league schedule lock and invokes
 * this in its write transaction to rederive the exact approved source plan. */
export async function readOwnedPaymentLedgerAdoptionPlanInTransaction(
  tx: PaymentOperationTransaction,
  input: { organizationId: number; leagueId: number },
): Promise<OwnedPaymentAdoptionPlan> {
  await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
  return buildOwnedPaymentAdoptionPlan(tx, input);
}

export class OwnedPaymentLedgerAdoptionError extends Error {
  constructor(public readonly code: string) {
    super("Owned-payment adoption was refused because its reviewed evidence no longer matches");
    this.name = "OwnedPaymentLedgerAdoptionError";
  }
}

export interface ApplyOwnedPaymentLedgerAdoptionInput {
  organizationId: number;
  leagueId: number;
  actorUserId: number;
  expectedSourceFingerprint: string;
  expectedResultFingerprint: string;
}

export interface ApplyOwnedPaymentLedgerAdoptionResult {
  adoptionId: string;
  organizationId: number;
  leagueId: number;
  adoptedThroughLocalDate: string;
  sourceFingerprint: string;
  resultFingerprint: string;
  grandfatheredAllocationCount: number;
  recordedByUserId: number;
  createdAt: string;
  replayed: boolean;
}

function assertApplyScope(input: ApplyOwnedPaymentLedgerAdoptionInput): void {
  if (!Number.isSafeInteger(input.organizationId) || input.organizationId <= 0
    || !Number.isSafeInteger(input.leagueId) || input.leagueId <= 0
    || !Number.isSafeInteger(input.actorUserId) || input.actorUserId <= 0) {
    throw new OwnedPaymentLedgerAdoptionError("INVALID_SCOPE");
  }
  if (!new RegExp(`^${OWNED_PAYMENT_ADOPTION_PREFLIGHT_PREFIX}[0-9a-f]{64}$`).test(input.expectedSourceFingerprint)
    || !new RegExp(`^${OWNED_PAYMENT_ADOPTION_RESULT_PREFIX}[0-9a-f]{64}$`).test(input.expectedResultFingerprint)) {
    throw new OwnedPaymentLedgerAdoptionError("INVALID_EXPECTED_FINGERPRINT");
  }
}

async function assertAdoptionActorInTransaction(
  tx: PaymentOperationTransaction,
  input: Pick<ApplyOwnedPaymentLedgerAdoptionInput, "organizationId" | "actorUserId">,
): Promise<void> {
  const actorQuery = tx.select({ id: users.id, organizationId: users.organizationId, role: users.role })
    .from(users).where(eq(users.id, input.actorUserId));
  const [actor] = await actorQuery.for("update");
  if (!actor || (actor.role !== "system_admin"
    && (actor.role !== "org_admin" || actor.organizationId !== input.organizationId))) {
    throw new OwnedPaymentLedgerAdoptionError("UNAUTHORIZED_ACTOR");
  }
}

/** Initialize a marker only for a newly published league still inside its
 * creating transaction. Existing setup retries must return before this seam. */
export async function initializePristineOwnedPaymentLedgerInTransaction(
  tx: PaymentOperationTransaction,
  input: { organizationId: number; leagueId: number; actorUserId: number },
): Promise<void> {
  if (!Number.isSafeInteger(input.organizationId) || input.organizationId <= 0
    || !Number.isSafeInteger(input.leagueId) || input.leagueId <= 0
    || !Number.isSafeInteger(input.actorUserId) || input.actorUserId <= 0) {
    throw new OwnedPaymentLedgerAdoptionError("INVALID_SCOPE");
  }
  await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
  await assertAdoptionActorInTransaction(tx, input);

  const [paymentsFound, operationsFound, rosterSnapshotsFound, snapshotItemsFound,
    standingBindingsFound, standingParticipantsFound, disputesFound, voidsFound,
    refundSnapshotsFound, obligationsFound, responsibilitiesFound, ownerRevisionsFound,
    assignmentsFound, correctionsFound, allocationsFound, refundAdjustmentsFound,
    confirmationsFound, consentsFound, consentPartnersFound, adoptionRowsFound,
    fundingsFound, authorizationItemsFound, fundingApplicationsFound,
    adoptionProofsFound, adoptionProofStepsFound, releasesFound, receiptHeadsFound,
    receiptRevisionsFound, rotatingFundingsFound, rotatingApplicationsFound,
    rotatingReversalsFound, rotatingRefundsFound] = await Promise.all([
    tx.select({ id: payments.id }).from(payments).where(and(eq(payments.organizationId, input.organizationId), eq(payments.leagueId, input.leagueId))).limit(1),
    tx.select({ id: paymentOperations.id }).from(paymentOperations).where(and(eq(paymentOperations.organizationId, input.organizationId), eq(paymentOperations.leagueId, input.leagueId))).limit(1),
    tx.select({ operationId: paymentOperationRosterSnapshots.operationId }).from(paymentOperationRosterSnapshots).where(and(eq(paymentOperationRosterSnapshots.organizationId, input.organizationId), eq(paymentOperationRosterSnapshots.leagueId, input.leagueId))).limit(1),
    tx.select({ id: paymentOperationRosterSnapshotItems.id }).from(paymentOperationRosterSnapshotItems).where(and(eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId), eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId))).limit(1),
    tx.select({ operationId: paymentOperationStandingAutopayBindings.operationId }).from(paymentOperationStandingAutopayBindings).where(and(eq(paymentOperationStandingAutopayBindings.organizationId, input.organizationId), eq(paymentOperationStandingAutopayBindings.leagueId, input.leagueId))).limit(1),
    tx.select({ operationId: paymentOperationStandingAutopayParticipants.operationId }).from(paymentOperationStandingAutopayParticipants).where(and(eq(paymentOperationStandingAutopayParticipants.organizationId, input.organizationId), eq(paymentOperationStandingAutopayParticipants.leagueId, input.leagueId))).limit(1),
    tx.select({ id: paymentDisputes.id }).from(paymentDisputes).innerJoin(paymentOperations, and(
      eq(paymentOperations.id, paymentDisputes.paymentOperationId),
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.leagueId, input.leagueId),
    )).where(eq(paymentDisputes.organizationId, input.organizationId)).limit(1),
    tx.select({ id: paymentVoids.id }).from(paymentVoids).where(and(eq(paymentVoids.organizationId, input.organizationId), eq(paymentVoids.leagueId, input.leagueId))).limit(1),
    tx.select({ operationId: refundPaymentOperationSnapshots.operationId }).from(refundPaymentOperationSnapshots).innerJoin(paymentOperations, and(
      eq(paymentOperations.id, refundPaymentOperationSnapshots.operationId),
      eq(paymentOperations.organizationId, input.organizationId),
      eq(paymentOperations.leagueId, input.leagueId),
    )).limit(1),
    tx.select({ id: paymentObligations.id }).from(paymentObligations).where(and(eq(paymentObligations.organizationId, input.organizationId), eq(paymentObligations.leagueId, input.leagueId))).limit(1),
    tx.select({ id: occurrencePaymentResponsibilities.id }).from(occurrencePaymentResponsibilities).where(and(eq(occurrencePaymentResponsibilities.organizationId, input.organizationId), eq(occurrencePaymentResponsibilities.leagueId, input.leagueId))).limit(1),
    tx.select({ id: paymentObligationOwnerRevisions.id }).from(paymentObligationOwnerRevisions).where(and(eq(paymentObligationOwnerRevisions.organizationId, input.organizationId), eq(paymentObligationOwnerRevisions.leagueId, input.leagueId))).limit(1),
    tx.select({ id: rotatingOccurrenceAssignments.id }).from(rotatingOccurrenceAssignments).where(and(eq(rotatingOccurrenceAssignments.organizationId, input.organizationId), eq(rotatingOccurrenceAssignments.leagueId, input.leagueId))).limit(1),
    tx.select({ id: paymentAllocationCorrections.id }).from(paymentAllocationCorrections).where(and(eq(paymentAllocationCorrections.organizationId, input.organizationId), eq(paymentAllocationCorrections.leagueId, input.leagueId))).limit(1),
    tx.select({ id: paymentAllocations.id }).from(paymentAllocations).where(and(eq(paymentAllocations.organizationId, input.organizationId), eq(paymentAllocations.leagueId, input.leagueId))).limit(1),
    tx.select({ id: refundAllocationAdjustments.id }).from(refundAllocationAdjustments).where(and(eq(refundAllocationAdjustments.organizationId, input.organizationId), eq(refundAllocationAdjustments.leagueId, input.leagueId))).limit(1),
    tx.select({ id: weeklyPaymentWeekConfirmations.id }).from(weeklyPaymentWeekConfirmations).where(and(eq(weeklyPaymentWeekConfirmations.organizationId, input.organizationId), eq(weeklyPaymentWeekConfirmations.leagueId, input.leagueId))).limit(1),
    tx.select({ id: autopayConsents.id }).from(autopayConsents).where(and(eq(autopayConsents.organizationId, input.organizationId), eq(autopayConsents.leagueId, input.leagueId))).limit(1),
    tx.select({ consentId: autopayConsentPartners.consentId }).from(autopayConsentPartners).where(and(eq(autopayConsentPartners.organizationId, input.organizationId), eq(autopayConsentPartners.leagueId, input.leagueId))).limit(1),
    tx.select({ id: weeklyPaymentLedgerAdoptions.id }).from(weeklyPaymentLedgerAdoptions).where(and(eq(weeklyPaymentLedgerAdoptions.organizationId, input.organizationId), eq(weeklyPaymentLedgerAdoptions.leagueId, input.leagueId))).limit(1),
    tx.select({ id: weeklyPaymentFundings.id }).from(weeklyPaymentFundings).where(and(eq(weeklyPaymentFundings.organizationId, input.organizationId), eq(weeklyPaymentFundings.leagueId, input.leagueId))).limit(1),
    tx.select({ id: weeklyPaymentFundingAuthorizationItems.id }).from(weeklyPaymentFundingAuthorizationItems).where(and(eq(weeklyPaymentFundingAuthorizationItems.organizationId, input.organizationId), eq(weeklyPaymentFundingAuthorizationItems.leagueId, input.leagueId))).limit(1),
    tx.select({ id: paymentAllocationFundingApplications.id }).from(paymentAllocationFundingApplications).where(and(eq(paymentAllocationFundingApplications.organizationId, input.organizationId), eq(paymentAllocationFundingApplications.leagueId, input.leagueId))).limit(1),
    tx.select({ id: weeklyPaymentLedgerAdoptionAllocationProofs.id }).from(weeklyPaymentLedgerAdoptionAllocationProofs).where(and(eq(weeklyPaymentLedgerAdoptionAllocationProofs.organizationId, input.organizationId), eq(weeklyPaymentLedgerAdoptionAllocationProofs.leagueId, input.leagueId))).limit(1),
    tx.select({ id: weeklyPaymentLedgerAdoptionAllocationProofSteps.id }).from(weeklyPaymentLedgerAdoptionAllocationProofSteps).where(and(eq(weeklyPaymentLedgerAdoptionAllocationProofSteps.organizationId, input.organizationId), eq(weeklyPaymentLedgerAdoptionAllocationProofSteps.leagueId, input.leagueId))).limit(1),
    tx.select({ id: weeklyPaymentAllocationReleases.id }).from(weeklyPaymentAllocationReleases).where(and(eq(weeklyPaymentAllocationReleases.organizationId, input.organizationId), eq(weeklyPaymentAllocationReleases.leagueId, input.leagueId))).limit(1),
    tx.select({ id: weeklyPaymentWorksheetReceipts.id }).from(weeklyPaymentWorksheetReceipts).where(and(eq(weeklyPaymentWorksheetReceipts.organizationId, input.organizationId), eq(weeklyPaymentWorksheetReceipts.leagueId, input.leagueId))).limit(1),
    tx.select({ id: weeklyPaymentWorksheetReceiptRevisions.id }).from(weeklyPaymentWorksheetReceiptRevisions).where(and(eq(weeklyPaymentWorksheetReceiptRevisions.organizationId, input.organizationId), eq(weeklyPaymentWorksheetReceiptRevisions.leagueId, input.leagueId))).limit(1),
    tx.select({ id: rotatingCreditFundings.id }).from(rotatingCreditFundings).where(and(eq(rotatingCreditFundings.organizationId, input.organizationId), eq(rotatingCreditFundings.leagueId, input.leagueId))).limit(1),
    tx.select({ id: rotatingCreditApplications.id }).from(rotatingCreditApplications).where(and(eq(rotatingCreditApplications.organizationId, input.organizationId), eq(rotatingCreditApplications.leagueId, input.leagueId))).limit(1),
    tx.select({ id: rotatingCreditApplicationReversals.id }).from(rotatingCreditApplicationReversals).where(and(eq(rotatingCreditApplicationReversals.organizationId, input.organizationId), eq(rotatingCreditApplicationReversals.leagueId, input.leagueId))).limit(1),
    tx.select({ id: rotatingCreditRefunds.id }).from(rotatingCreditRefunds).where(and(eq(rotatingCreditRefunds.organizationId, input.organizationId), eq(rotatingCreditRefunds.leagueId, input.leagueId))).limit(1),
  ]);
  const evidenceSets = [paymentsFound, operationsFound, rosterSnapshotsFound, snapshotItemsFound,
    standingBindingsFound, standingParticipantsFound, disputesFound, voidsFound, refundSnapshotsFound,
    obligationsFound, responsibilitiesFound, ownerRevisionsFound, assignmentsFound, correctionsFound,
    allocationsFound, refundAdjustmentsFound, confirmationsFound, consentsFound, consentPartnersFound,
    adoptionRowsFound, fundingsFound, authorizationItemsFound, fundingApplicationsFound,
    adoptionProofsFound, adoptionProofStepsFound, releasesFound, receiptHeadsFound, receiptRevisionsFound,
    rotatingFundingsFound, rotatingApplicationsFound, rotatingReversalsFound, rotatingRefundsFound];
  if (evidenceSets.some((rows) => rows.length > 0)) {
    throw new OwnedPaymentLedgerAdoptionError("PRISTINE_LEAGUE_PAYMENT_STATE_REQUIRED");
  }

  const scope = { organizationId: input.organizationId, leagueId: input.leagueId };
  const plan = await buildOwnedPaymentAdoptionPlan(tx, scope, { cutoffBeforeFirstBillableDate: true });
  if (!plan.ready || plan.blockers.length > 0 || Object.values(plan.counts).some((count) => count !== 0)
    || plan.fundings.length > 0 || plan.applications.length > 0 || plan.rotatingReleases.length > 0 || plan.receipts.length > 0) {
    throw new OwnedPaymentLedgerAdoptionError("PRISTINE_LEAGUE_PAYMENT_STATE_REQUIRED");
  }
  const now = await readDatabaseNow(tx);
  const [adoption] = await tx.insert(weeklyPaymentLedgerAdoptions).values({
    ...scope,
    adoptedThroughLocalDate: plan.adoptedThroughLocalDate,
    preflightFingerprint: plan.sourceFingerprint,
    resultFingerprint: plan.resultFingerprint,
    grandfatheredAllocationCount: 0,
    recordedByUserId: input.actorUserId,
    createdAt: now,
  }).returning();
  if (!adoption) throw new OwnedPaymentLedgerAdoptionError("PRISTINE_ADOPTION_MARKER_CREATE_FAILED");
  await assertAdoptionOutcomeInTransaction(tx, {
    plan,
    adoption,
    actorUserId: input.actorUserId,
    fundingByOwner: new Map(),
    applicationByAllocationId: new Map(),
    receiptIdByPaymentId: new Map(),
  });
}

function applyResult(
  adoption: NonNullable<Awaited<ReturnType<typeof readOwnedLedgerAdoptionInTransaction>>>,
  replayed: boolean,
): ApplyOwnedPaymentLedgerAdoptionResult {
  return {
    adoptionId: adoption.id,
    organizationId: adoption.organizationId,
    leagueId: adoption.leagueId,
    adoptedThroughLocalDate: adoption.adoptedThroughLocalDate,
    sourceFingerprint: adoption.preflightFingerprint,
    resultFingerprint: adoption.resultFingerprint,
    grandfatheredAllocationCount: adoption.grandfatheredAllocationCount,
    recordedByUserId: adoption.recordedByUserId,
    createdAt: adoption.createdAt,
    replayed,
  };
}

function fundingOwnerKey(paymentId: number, creditedBowlerId: number): string {
  return `${paymentId}:${creditedBowlerId}`;
}

function adoptionReleaseIdempotencyKey(adoptionId: string, applicationId: string): string {
  return `lvadopt_${createHash("sha256").update(`${adoptionId}:${applicationId}`).digest("hex")}`;
}

async function assertAdoptionOutcomeInTransaction(
  tx: PaymentOperationTransaction,
  input: {
    plan: OwnedPaymentAdoptionPlan;
    adoption: NonNullable<Awaited<ReturnType<typeof readOwnedLedgerAdoptionInTransaction>>>;
    actorUserId: number;
    fundingByOwner: Map<string, typeof weeklyPaymentFundings.$inferSelect>;
    applicationByAllocationId: Map<string, string>;
    receiptIdByPaymentId: Map<number, string>;
  },
): Promise<void> {
  const { plan, adoption, actorUserId } = input;
  if (adoption.organizationId !== plan.organizationId || adoption.leagueId !== plan.leagueId
    || adoption.adoptedThroughLocalDate !== plan.adoptedThroughLocalDate
    || adoption.preflightFingerprint !== plan.sourceFingerprint
    || adoption.resultFingerprint !== plan.resultFingerprint
    || adoption.grandfatheredAllocationCount !== plan.counts.grandfatheredAllocations
    || adoption.recordedByUserId !== actorUserId) {
    throw new OwnedPaymentLedgerAdoptionError("ADOPTION_MARKER_VERIFY_FAILED");
  }

  const fundingRows = await tx.select().from(weeklyPaymentFundings).where(and(
    eq(weeklyPaymentFundings.organizationId, plan.organizationId),
    eq(weeklyPaymentFundings.leagueId, plan.leagueId),
    eq(weeklyPaymentFundings.adoptionId, adoption.id),
  )).orderBy(asc(weeklyPaymentFundings.paymentId), asc(weeklyPaymentFundings.portionIndex));
  if (fundingRows.length !== plan.fundings.length) throw new OwnedPaymentLedgerAdoptionError("ADOPTION_FUNDING_VERIFY_FAILED");
  const expectedFundingKeys = new Set<string>();
  for (const expected of plan.fundings) {
    const key = fundingOwnerKey(expected.payment.id, expected.portion.creditedBowlerId);
    expectedFundingKeys.add(key);
    const actual = input.fundingByOwner.get(key);
    if (!actual || actual.source !== "legacy_adoption" || actual.authorizationKind !== expected.portion.authorizationKind
      || actual.paymentId !== expected.payment.id || actual.creditedBowlerId !== expected.portion.creditedBowlerId
      || actual.portionIndex !== expected.portion.portionIndex || actual.amountMinor !== expected.portion.amountMinor
      || actual.currency !== expected.payment.currency || actual.authorizationOperationId !== expected.portion.authorizationOperationId
      || actual.authorizationItemCount !== expected.portion.authorizationItemCount
      || actual.authorizationFingerprint !== expected.portion.authorizationFingerprint
      || actual.adoptionId !== adoption.id || actual.recordedByUserId !== actorUserId) {
      throw new OwnedPaymentLedgerAdoptionError("ADOPTION_FUNDING_VERIFY_FAILED");
    }
  }
  if (fundingRows.some((row) => !expectedFundingKeys.has(fundingOwnerKey(row.paymentId, row.creditedBowlerId)))) {
    throw new OwnedPaymentLedgerAdoptionError("ADOPTION_FUNDING_VERIFY_FAILED");
  }

  const expectedAuthorizationItems = plan.fundings.flatMap(({ payment, portion }) => {
    const funding = input.fundingByOwner.get(fundingOwnerKey(payment.id, portion.creditedBowlerId));
    if (!funding) throw new OwnedPaymentLedgerAdoptionError("ADOPTION_FUNDING_VERIFY_FAILED");
    return portion.authorizationItems.map((item) => ({ fundingId: funding.id, paymentId: payment.id,
      creditedBowlerId: portion.creditedBowlerId, operationId: portion.authorizationOperationId,
      allocationIndex: item.allocationIndex, amountMinor: item.amountMinor, fingerprint: item.snapshotFingerprint }));
  });
  const actualAuthorizationItems = fundingRows.length === 0 ? [] : await tx.select().from(weeklyPaymentFundingAuthorizationItems).where(and(
    eq(weeklyPaymentFundingAuthorizationItems.organizationId, plan.organizationId),
    eq(weeklyPaymentFundingAuthorizationItems.leagueId, plan.leagueId),
    inArray(weeklyPaymentFundingAuthorizationItems.fundingId, fundingRows.map((row) => row.id)),
  )).orderBy(asc(weeklyPaymentFundingAuthorizationItems.fundingId), asc(weeklyPaymentFundingAuthorizationItems.sourceAllocationIndex));
  const expectedAuthorizationItemByKey = new Map(expectedAuthorizationItems.map((row) => [
    `${row.fundingId}:${row.allocationIndex}`, row,
  ]));
  const actualAuthorizationItemByKey = new Map(actualAuthorizationItems.map((row) => [
    `${row.fundingId}:${row.sourceAllocationIndex}`, row,
  ]));
  if (actualAuthorizationItems.length !== expectedAuthorizationItems.length
    || expectedAuthorizationItemByKey.size !== expectedAuthorizationItems.length
    || actualAuthorizationItemByKey.size !== actualAuthorizationItems.length
    || [...expectedAuthorizationItemByKey].some(([key, expected]) => {
      const actual = actualAuthorizationItemByKey.get(key);
      return !actual || actual.fundingId !== expected.fundingId || actual.paymentId !== expected.paymentId
        || actual.creditedBowlerId !== expected.creditedBowlerId || actual.sourceOperationId !== expected.operationId
        || actual.sourceAllocationIndex !== expected.allocationIndex || actual.authorizedAmountMinor !== expected.amountMinor
        || actual.sourceSnapshotFingerprint !== expected.fingerprint;
    })) throw new OwnedPaymentLedgerAdoptionError("ADOPTION_AUTHORIZATION_VERIFY_FAILED");

  const applicationAllocationIds = plan.applications.map((row) => row.allocation.id);
  const storedApplications = applicationAllocationIds.length === 0 ? [] : await tx.select().from(paymentAllocationFundingApplications).where(and(
    eq(paymentAllocationFundingApplications.organizationId, plan.organizationId),
    eq(paymentAllocationFundingApplications.leagueId, plan.leagueId),
    inArray(paymentAllocationFundingApplications.allocationId, applicationAllocationIds),
  )).orderBy(asc(paymentAllocationFundingApplications.allocationId));
  if (storedApplications.length !== plan.applications.length) throw new OwnedPaymentLedgerAdoptionError("ADOPTION_APPLICATION_VERIFY_FAILED");
  const storedApplicationByAllocation = new Map(storedApplications.map((row) => [row.allocationId, row]));
  const expectedReleaseSourceIds: string[] = [];
  const expectedProofApplications: AdoptionApplication[] = [];
  for (const expected of plan.applications) {
    const actual = storedApplicationByAllocation.get(expected.allocation.id);
    const funding = input.fundingByOwner.get(fundingOwnerKey(expected.payment.id, expected.portion.creditedBowlerId));
    if (!actual || !funding || actual.paymentId !== expected.payment.id || actual.creditedBowlerId !== expected.portion.creditedBowlerId
      || actual.genericFundingId !== funding.id || actual.rotatingFundingId !== null
      || actual.sourceAmountMinor !== funding.amountMinor || actual.amountMinor !== expected.allocation.amountMinor
      || actual.currency !== expected.allocation.currency || actual.obligationId !== expected.allocation.obligationId
      || actual.responsibilityId !== expected.responsibilityId || actual.occurrenceId !== expected.occurrenceId
      || actual.teamId !== expected.teamId || actual.targetKind !== expected.targetKind
      || actual.targetPayerBowlerId !== expected.targetPayerBowlerId || actual.assignmentId !== expected.assignmentId
      || actual.appliedByUserId !== actorUserId) {
      throw new OwnedPaymentLedgerAdoptionError("ADOPTION_APPLICATION_VERIFY_FAILED");
    }
    input.applicationByAllocationId.set(expected.allocation.id, actual.id);
    if (expected.decision === "release") expectedReleaseSourceIds.push(expected.allocation.id);
    else if (expected.debtorBowlerId !== expected.portion.creditedBowlerId) expectedProofApplications.push(expected);
  }
  const storedAllocationRows = applicationAllocationIds.length === 0 ? [] : await tx.select().from(paymentAllocations).where(and(
    eq(paymentAllocations.organizationId, plan.organizationId),
    eq(paymentAllocations.leagueId, plan.leagueId),
    inArray(paymentAllocations.id, applicationAllocationIds),
  ));
  const allocationById = new Map(storedAllocationRows.map((row) => [row.id, row]));
  if (storedAllocationRows.length !== applicationAllocationIds.length || plan.applications.some((expected) => {
    const actual = allocationById.get(expected.allocation.id);
    return !actual || actual.state !== (expected.decision === "retain" ? "active" : "voided");
  })) throw new OwnedPaymentLedgerAdoptionError("ADOPTION_ALLOCATION_STATE_VERIFY_FAILED");

  const releases = expectedReleaseSourceIds.length === 0 ? [] : await tx.select().from(weeklyPaymentAllocationReleases).where(and(
    eq(weeklyPaymentAllocationReleases.organizationId, plan.organizationId),
    eq(weeklyPaymentAllocationReleases.leagueId, plan.leagueId),
    inArray(weeklyPaymentAllocationReleases.sourceAllocationId, expectedReleaseSourceIds),
  )).orderBy(asc(weeklyPaymentAllocationReleases.sourceAllocationId));
  if (releases.length !== expectedReleaseSourceIds.length || plan.applications.some((expected) => {
    if (expected.decision !== "release") return false;
    const actual = releases.find((row) => row.sourceAllocationId === expected.allocation.id);
    const applicationId = input.applicationByAllocationId.get(expected.allocation.id);
    return !actual || !applicationId || actual.fundingApplicationId !== applicationId
      || actual.paymentId !== expected.payment.id || actual.creditedBowlerId !== expected.portion.creditedBowlerId
      || actual.sourceObligationId !== expected.allocation.obligationId
      || actual.sourceApplicationAmountMinor !== expected.allocation.amountMinor
      || actual.releasedAmountMinor !== expected.allocation.amountMinor || actual.retainedAmountMinor !== 0
      || actual.replacementAllocationId !== null || actual.reason !== "ledger_adoption"
      || actual.recordedByUserId !== actorUserId || actual.idempotencyKey !== adoptionReleaseIdempotencyKey(adoption.id, applicationId);
  })) throw new OwnedPaymentLedgerAdoptionError("ADOPTION_RELEASE_VERIFY_FAILED");

  const proofs = await tx.select().from(weeklyPaymentLedgerAdoptionAllocationProofs).where(and(
    eq(weeklyPaymentLedgerAdoptionAllocationProofs.organizationId, plan.organizationId),
    eq(weeklyPaymentLedgerAdoptionAllocationProofs.leagueId, plan.leagueId),
    eq(weeklyPaymentLedgerAdoptionAllocationProofs.adoptionId, adoption.id),
  )).orderBy(asc(weeklyPaymentLedgerAdoptionAllocationProofs.allocationId));
  if (proofs.length !== expectedProofApplications.length) throw new OwnedPaymentLedgerAdoptionError("ADOPTION_PROOF_VERIFY_FAILED");
  const proofByAllocationId = new Map(proofs.map((row) => [row.allocationId, row]));
  for (const expected of expectedProofApplications) {
    const actual = proofByAllocationId.get(expected.allocation.id);
    const applicationId = input.applicationByAllocationId.get(expected.allocation.id);
    if (!actual || !applicationId || actual.fundingApplicationId !== applicationId || actual.rotatingApplicationId !== null
      || actual.paymentId !== expected.payment.id || actual.creditedBowlerId !== expected.portion.creditedBowlerId
      || actual.originalAllocationId !== expected.originalAllocationId || actual.obligationId !== expected.allocation.obligationId
      || actual.amountMinor !== expected.allocation.amountMinor || actual.currency !== expected.allocation.currency
      || actual.correctionCount !== expected.correctionPath.length
      || actual.correctionLineageFingerprint !== correctionLineageFingerprint(expected)
      || actual.obligationOwnerKind !== expected.obligationOwner.kind
      || actual.obligationOwnerBowlerId !== (expected.obligationOwner.kind === "bowler" ? expected.obligationOwner.bowlerId : null)
      || actual.obligationOwnerTeamId !== (expected.obligationOwner.kind === "team" ? expected.obligationOwner.teamId : null)) {
      throw new OwnedPaymentLedgerAdoptionError("ADOPTION_PROOF_VERIFY_FAILED");
    }
  }
  const proofIds = proofs.map((row) => row.id);
  const proofSteps = proofIds.length === 0 ? [] : await tx.select().from(weeklyPaymentLedgerAdoptionAllocationProofSteps).where(and(
    eq(weeklyPaymentLedgerAdoptionAllocationProofSteps.organizationId, plan.organizationId),
    eq(weeklyPaymentLedgerAdoptionAllocationProofSteps.leagueId, plan.leagueId),
    inArray(weeklyPaymentLedgerAdoptionAllocationProofSteps.proofId, proofIds),
  )).orderBy(asc(weeklyPaymentLedgerAdoptionAllocationProofSteps.proofId), asc(weeklyPaymentLedgerAdoptionAllocationProofSteps.stepIndex));
  const expectedStepCount = expectedProofApplications.reduce((sum, row) => sum + row.correctionPath.length, 0);
  const expectedProofStepByKey = new Map<string, { proofId: string; stepIndex: number; edge: typeof paymentAllocationCorrections.$inferSelect }>();
  for (const expected of expectedProofApplications) {
    const proof = proofByAllocationId.get(expected.allocation.id);
    if (!proof) throw new OwnedPaymentLedgerAdoptionError("ADOPTION_PROOF_VERIFY_FAILED");
    for (const [stepIndex, edge] of expected.correctionPath.entries()) {
      expectedProofStepByKey.set(`${proof.id}:${stepIndex}`, { proofId: proof.id, stepIndex, edge });
    }
  }
  const actualProofStepByKey = new Map(proofSteps.map((row) => [`${row.proofId}:${row.stepIndex}`, row]));
  if (proofSteps.length !== expectedStepCount || expectedProofStepByKey.size !== expectedStepCount
    || actualProofStepByKey.size !== proofSteps.length) throw new OwnedPaymentLedgerAdoptionError("ADOPTION_PROOF_STEPS_VERIFY_FAILED");
  for (const [key, expected] of expectedProofStepByKey) {
    const actual = actualProofStepByKey.get(key);
    const edge = expected.edge;
    if (!actual || actual.proofId !== expected.proofId || actual.stepIndex !== expected.stepIndex || actual.correctionId !== edge.id
      || actual.paymentId !== edge.paymentId || actual.sourceAllocationId !== edge.sourceAllocationId
      || actual.replacementAllocationId !== edge.replacementAllocationId || actual.amountMinor !== edge.amountMinor
      || actual.currency !== edge.currency) throw new OwnedPaymentLedgerAdoptionError("ADOPTION_PROOF_STEPS_VERIFY_FAILED");
  }

  for (const expected of plan.receipts) {
    const receiptId = input.receiptIdByPaymentId.get(expected.paymentId);
    if (!receiptId) throw new OwnedPaymentLedgerAdoptionError("ADOPTION_RECEIPT_VERIFY_FAILED");
    const [head] = await tx.select().from(weeklyPaymentWorksheetReceipts).where(and(
      eq(weeklyPaymentWorksheetReceipts.id, receiptId),
      eq(weeklyPaymentWorksheetReceipts.organizationId, plan.organizationId),
      eq(weeklyPaymentWorksheetReceipts.leagueId, plan.leagueId),
    )).limit(1);
    const revisions = await tx.select().from(weeklyPaymentWorksheetReceiptRevisions).where(and(
      eq(weeklyPaymentWorksheetReceiptRevisions.receiptId, receiptId),
      eq(weeklyPaymentWorksheetReceiptRevisions.organizationId, plan.organizationId),
      eq(weeklyPaymentWorksheetReceiptRevisions.leagueId, plan.leagueId),
    )).orderBy(asc(weeklyPaymentWorksheetReceiptRevisions.receiptRevision));
    const revision = revisions[0];
    if (!head || head.occurrenceId !== expected.occurrenceId || head.payerBowlerId !== expected.payerBowlerId
      || head.receiptKind !== "manual" || revisions.length !== 1 || !revision || revision.receiptRevision !== 1
      || revision.paymentId !== expected.paymentId || revision.revisionKind !== "manual_record"
      || revision.amountMinor !== expected.amountMinor
      || revision.businessCollectionLocalDate !== expected.businessCollectionLocalDate
      || revision.recordedByUserId !== actorUserId) throw new OwnedPaymentLedgerAdoptionError("ADOPTION_RECEIPT_VERIFY_FAILED");
  }

  const rotatingBalances = await readRotatingCreditFundingBalancesInTransaction(tx, {
    organizationId: plan.organizationId,
    leagueId: plan.leagueId,
    bowlerIds: [...new Set(plan.rotatingReleases.map((row) => row.application.actualBowlerId))],
  });
  if (rotatingBalances.some((row) => row.reviewRequired)) throw new OwnedPaymentLedgerAdoptionError("ADOPTION_ROTATING_VERIFY_FAILED");
  const rotatingReversals = plan.rotatingReleases.length === 0 ? [] : await tx.select().from(rotatingCreditApplicationReversals).where(and(
    eq(rotatingCreditApplicationReversals.organizationId, plan.organizationId),
    eq(rotatingCreditApplicationReversals.leagueId, plan.leagueId),
    inArray(rotatingCreditApplicationReversals.applicationId, plan.rotatingReleases.map((row) => row.application.id)),
  ));
  if (rotatingReversals.length !== plan.rotatingReleases.length || plan.rotatingReleases.some((expected) => {
    const actual = rotatingReversals.find((row) => row.applicationId === expected.application.id);
    return !actual || actual.assignmentId !== expected.assignmentId || actual.fundingPaymentId !== expected.application.paymentId
      || actual.allocationId !== expected.application.allocationId || actual.obligationId !== expected.application.obligationId
      || actual.bowlerId !== expected.application.actualBowlerId || actual.amountMinor !== expected.application.amountMinor
      || actual.actorUserId !== actorUserId;
  })) throw new OwnedPaymentLedgerAdoptionError("ADOPTION_ROTATING_VERIFY_FAILED");

  const genericLots = await readGenericFundingAvailabilityInTransaction(tx, {
    organizationId: plan.organizationId,
    leagueId: plan.leagueId,
    bowlerIds: [...new Set(plan.fundings.map((row) => row.portion.creditedBowlerId))],
  });
  const genericLotById = new Map(genericLots.map((row) => [row.fundingId, row]));
  if (fundingRows.some((row) => {
    const balance = genericLotById.get(row.id);
    return !balance || balance.reviewRequired || balance.paymentId !== row.paymentId
      || balance.bowlerId !== row.creditedBowlerId || balance.amountMinor !== row.amountMinor;
  })) throw new OwnedPaymentLedgerAdoptionError("ADOPTION_GENERIC_BALANCE_VERIFY_FAILED");

  for (const paymentId of new Set(plan.fundings.map((row) => row.payment.id))) {
    await assertOwnedPaymentTenderInTransaction(tx, { organizationId: plan.organizationId, leagueId: plan.leagueId, paymentId });
  }
}

/** Atomically turn one exact ready preflight into the existing owned ledger.
 * The marker is checked before replanning so a matching retry remains stable
 * after ordinary weekly payments mutate account balances. */
export async function applyOwnedPaymentLedgerAdoption(
  input: ApplyOwnedPaymentLedgerAdoptionInput,
  executor: AdoptionPreflightExecutor = db,
): Promise<ApplyOwnedPaymentLedgerAdoptionResult> {
  assertApplyScope(input);
  return executor.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    await assertAdoptionActorInTransaction(tx, input);

    const existing = await readOwnedLedgerAdoptionInTransaction(tx, input);
    if (existing) {
      if (existing.preflightFingerprint !== input.expectedSourceFingerprint
        || existing.resultFingerprint !== input.expectedResultFingerprint) {
        throw new OwnedPaymentLedgerAdoptionError("ADOPTION_REPLAY_MISMATCH");
      }
      return applyResult(existing, true);
    }

    const plan = await buildOwnedPaymentAdoptionPlan(tx, input);
    if (!plan.ready) throw new OwnedPaymentLedgerAdoptionError("ADOPTION_PREFLIGHT_BLOCKED");
    if (plan.sourceFingerprint !== input.expectedSourceFingerprint
      || plan.resultFingerprint !== input.expectedResultFingerprint) {
      throw new OwnedPaymentLedgerAdoptionError("ADOPTION_PREFLIGHT_STALE");
    }
    const now = await readDatabaseNow(tx);
    const [adoption] = await tx.insert(weeklyPaymentLedgerAdoptions).values({
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      adoptedThroughLocalDate: plan.adoptedThroughLocalDate,
      preflightFingerprint: plan.sourceFingerprint,
      resultFingerprint: plan.resultFingerprint,
      grandfatheredAllocationCount: plan.counts.grandfatheredAllocations,
      recordedByUserId: input.actorUserId,
      createdAt: now,
    }).returning();
    if (!adoption) throw new OwnedPaymentLedgerAdoptionError("ADOPTION_MARKER_CREATE_FAILED");

    const fundingByOwner = new Map<string, typeof weeklyPaymentFundings.$inferSelect>();
    for (const { payment, portion } of plan.fundings) {
      const funding = await recordOwnedFundingInTransaction(tx, {
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        creditedBowlerId: portion.creditedBowlerId,
        paymentId: payment.id,
        portionIndex: portion.portionIndex,
        amountMinor: portion.amountMinor,
        currency: payment.currency,
        source: "legacy_adoption",
        authorizationKind: portion.authorizationKind,
        authorizationOperationId: portion.authorizationOperationId,
        authorizationItemCount: portion.authorizationItemCount,
        authorizationFingerprint: portion.authorizationFingerprint,
        adoptionId: adoption.id,
        recordedByUserId: input.actorUserId,
        authorizationItems: portion.authorizationItems,
        now,
      });
      fundingByOwner.set(fundingOwnerKey(payment.id, portion.creditedBowlerId), funding);
    }

    const applicationByAllocationId = new Map<string, string>();
    const expectedProofApplications: Array<{ plan: AdoptionApplication; applicationId: string }> = [];
    for (const row of plan.applications) {
      const funding = fundingByOwner.get(fundingOwnerKey(row.payment.id, row.portion.creditedBowlerId));
      if (!funding) throw new OwnedPaymentLedgerAdoptionError("ADOPTION_FUNDING_MISSING");
      const [application] = await tx.insert(paymentAllocationFundingApplications).values({
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        allocationId: row.allocation.id,
        paymentId: row.payment.id,
        creditedBowlerId: row.portion.creditedBowlerId,
        genericFundingId: funding.id,
        rotatingFundingId: null,
        sourceAmountMinor: funding.amountMinor,
        amountMinor: row.allocation.amountMinor,
        currency: row.allocation.currency,
        obligationId: row.allocation.obligationId,
        responsibilityId: row.responsibilityId,
        occurrenceId: row.occurrenceId,
        teamId: row.teamId,
        targetKind: row.targetKind,
        targetPayerBowlerId: row.targetPayerBowlerId,
        assignmentId: row.assignmentId,
        appliedByUserId: input.actorUserId,
        createdAt: now,
      }).returning({ id: paymentAllocationFundingApplications.id });
      if (!application) throw new OwnedPaymentLedgerAdoptionError("ADOPTION_APPLICATION_CREATE_FAILED");
      applicationByAllocationId.set(row.allocation.id, application.id);
      if (row.decision === "retain" && row.debtorBowlerId !== row.portion.creditedBowlerId) {
        expectedProofApplications.push({ plan: row, applicationId: application.id });
      }
    }

    for (const { plan: row, applicationId } of expectedProofApplications) {
      const [proof] = await tx.insert(weeklyPaymentLedgerAdoptionAllocationProofs).values({
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        adoptionId: adoption.id,
        fundingApplicationId: applicationId,
        rotatingApplicationId: null,
        paymentId: row.payment.id,
        creditedBowlerId: row.portion.creditedBowlerId,
        allocationId: row.allocation.id,
        originalAllocationId: row.originalAllocationId,
        obligationId: row.allocation.obligationId,
        obligationOwnerKind: row.obligationOwner.kind,
        obligationOwnerBowlerId: row.obligationOwner.kind === "bowler" ? row.obligationOwner.bowlerId : null,
        obligationOwnerTeamId: row.obligationOwner.kind === "team" ? row.obligationOwner.teamId : null,
        amountMinor: row.allocation.amountMinor,
        currency: row.allocation.currency,
        correctionCount: row.correctionPath.length,
        correctionLineageFingerprint: correctionLineageFingerprint(row),
        createdAt: now,
      }).returning({ id: weeklyPaymentLedgerAdoptionAllocationProofs.id });
      if (!proof) throw new OwnedPaymentLedgerAdoptionError("ADOPTION_PROOF_CREATE_FAILED");
      if (row.correctionPath.length > 0) {
        await tx.insert(weeklyPaymentLedgerAdoptionAllocationProofSteps).values(row.correctionPath.map((edge, stepIndex) => ({
          organizationId: input.organizationId,
          leagueId: input.leagueId,
          proofId: proof.id,
          stepIndex,
          correctionId: edge.id,
          paymentId: edge.paymentId,
          sourceAllocationId: edge.sourceAllocationId,
          replacementAllocationId: edge.replacementAllocationId,
          amountMinor: edge.amountMinor,
          currency: edge.currency,
          createdAt: now,
        })));
      }
    }

    for (const row of plan.applications.filter((candidate) => candidate.decision === "release")) {
      const applicationId = applicationByAllocationId.get(row.allocation.id);
      if (!applicationId) throw new OwnedPaymentLedgerAdoptionError("ADOPTION_APPLICATION_MISSING");
      await releaseOwnedFundingApplicationInTransaction(tx, {
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        applicationId,
        actorUserId: input.actorUserId,
        reason: "ledger_adoption",
        idempotencyKey: adoptionReleaseIdempotencyKey(adoption.id, applicationId),
        now,
      });
    }

    for (const row of plan.rotatingReleases) {
      await reverseRotatingCreditApplicationsForAssignmentChangeInTransaction(tx, {
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        assignmentId: row.assignmentId,
        obligationIds: [row.application.obligationId],
        paymentId: row.application.paymentId,
        actorUserId: input.actorUserId,
        reason: `Owned payment ledger adoption ${plan.resultFingerprint}`,
        now,
      });
    }

    const receiptIdByPaymentId = new Map<number, string>();
    for (const receipt of plan.receipts) {
      const receiptId = await createManualReceiptHeadInTransaction(tx, {
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        occurrenceId: receipt.occurrenceId,
        bowlerId: receipt.payerBowlerId,
        now,
      });
      receiptIdByPaymentId.set(receipt.paymentId, receiptId);
      await appendManualReceiptRevisionInTransaction(tx, {
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        actorUserId: input.actorUserId,
        receiptId,
        revision: 1,
        paymentId: receipt.paymentId,
        amountMinor: receipt.amountMinor,
        businessCollectionLocalDate: receipt.businessCollectionLocalDate,
        revisionKind: "manual_record",
        now,
      });
    }

    await assertAdoptionOutcomeInTransaction(tx, {
      plan,
      adoption,
      actorUserId: input.actorUserId,
      fundingByOwner,
      applicationByAllocationId,
      receiptIdByPaymentId,
    });
    return applyResult(adoption, false);
  });
}
