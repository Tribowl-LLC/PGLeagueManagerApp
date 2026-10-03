import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { canonicalJsonStringify } from "@shared/canonical-json";
import {
  financialCommands,
  leagueOccurrences,
  leagues,
  occurrencePaymentResponsibilities,
  paymentAllocationFundingApplications,
  paymentAllocations,
  paymentObligations,
  paymentOperationRosterSnapshotItems,
  paymentVoids,
  payments,
  rotatingCreditApplications,
  rotatingCreditFundings,
  rotatingOccurrenceAssignments,
  weeklyPaymentLedgerAdoptions,
  weeklyPaymentWeekConfirmations,
  weeklyPaymentWorksheetReceiptRevisions,
  weeklyPaymentWorksheetReceipts,
} from "@shared/schema";
import {
  managePaymentsSaveRequestSchema,
  managePaymentsSaveResponseSchema,
  type ManagePaymentsChangedRow,
  type ManagePaymentsSaveRequest,
  type ManagePaymentsSaveResponse,
  type ManagePaymentsSnapshot,
} from "@shared/manage-payments-contract";
import { db } from "../db.js";
import { lockLeagueSchedule } from "../storage/league-schedule-lock.js";
import { resolvePaymentObligationOwnersInTransaction, PaymentObligationOwnerError } from "./roster-obligation-owners.js";
import { applyOwnedFundingFifoInTransaction, OwnedPaymentLedgerError, recordOwnedFundingInTransaction, releaseOwnedFundingApplicationInTransaction } from "./owned-payment-ledger.js";
import { reverseRotatingCreditApplicationsForAssignmentChangeInTransaction, RotatingCreditLedgerError } from "./rotating-credit-applications.js";
import { deriveRosterPaymentTimingInTransaction } from "./roster-payment-materializer.js";
import { loadManagePaymentsWorksheetSnapshotInTransaction, ManagePaymentsWorksheetReadError } from "./manage-payments-worksheet-read.js";
import {
  ManagePaymentsReconciliationError,
  reconcileManagePaymentsComponents,
  type ManagePaymentsDesiredComponent,
  type ManagePaymentsExistingEvidence,
} from "./manage-payments-worksheet-reconciliation.js";

const COMMAND_TYPE = "manage_payments.save_week";
const REQUEST_FINGERPRINT_PREFIX = "lvmanagepaymentsrequest:v1:";
const RESPONSIBILITY_SET_FINGERPRINT_PREFIX = "lvmanagepaymentsrows:v1:";

export type ManagePaymentsWorksheetWriteErrorCode =
  | "invalid_request"
  | "state_conflict"
  | "idempotency_conflict"
  | "ledger_not_adopted"
  | "manual_receipt_conflict"
  | "incompatible_evidence"
  | "league_not_found"
  | "internal_error";

export class ManagePaymentsWorksheetWriteError extends Error {
  constructor(public readonly code: ManagePaymentsWorksheetWriteErrorCode, message: string) {
    super(message);
    this.name = "ManagePaymentsWorksheetWriteError";
  }
}

export interface SaveManagePaymentsWorksheetInput {
  organizationId: number;
  leagueId: number;
  actorUserId: number;
  request: ManagePaymentsSaveRequest;
}

function digest(prefix: string, value: unknown): string {
  return `${prefix}${createHash("sha256").update(canonicalJsonStringify(value), "utf8").digest("hex")}`;
}

function canonicalRequest(request: ManagePaymentsSaveRequest): ManagePaymentsSaveRequest {
  return {
    ...request,
    changedRows: [...request.changedRows]
      .map((row) => ({ ...row, manualReceiptEdits: [...row.manualReceiptEdits].sort((a, b) => a.receiptId.localeCompare(b.receiptId)) }))
      .sort((a, b) => a.teamId - b.teamId || a.bowlerId - b.bowlerId),
  };
}

export function managePaymentsSaveRequestFingerprint(request: ManagePaymentsSaveRequest): string {
  const { idempotencyKey: _idempotencyKey, ...payload } = canonicalRequest(request);
  return digest(REQUEST_FINGERPRINT_PREFIX, payload);
}

function responsibilitySetFingerprint(rows: readonly { teamId: number; bowlerId: number; feeComponent: string; feeMinor: number }[]): string {
  return digest(RESPONSIBILITY_SET_FINGERPRINT_PREFIX, [...rows].sort((a, b) => a.teamId - b.teamId || a.bowlerId - b.bowlerId));
}

function replayResponse(result: unknown): ManagePaymentsSaveResponse {
  const parsed = managePaymentsSaveResponseSchema.safeParse(result);
  if (!parsed.success) throw new ManagePaymentsWorksheetWriteError("idempotency_conflict", "The earlier save result is no longer available; reload this week before saving again");
  return { ...parsed.data, replayed: true };
}

function throwWriteError(caught: unknown): never {
  if (caught instanceof ManagePaymentsWorksheetWriteError) throw caught;
  if (caught instanceof ManagePaymentsWorksheetReadError) {
    if (caught.code === "ledger_not_adopted") throw new ManagePaymentsWorksheetWriteError("ledger_not_adopted", "Payment setup is not complete for this league.");
    if (caught.code === "league_not_found") throw new ManagePaymentsWorksheetWriteError("league_not_found", "League was not found in the authorized organization");
    if (caught.code === "invalid_occurrence") throw new ManagePaymentsWorksheetWriteError("state_conflict", "The selected week changed; reload this week before saving");
    throw new ManagePaymentsWorksheetWriteError("incompatible_evidence", "Payment evidence needs review before this week can be saved");
  }
  if (caught instanceof OwnedPaymentLedgerError) throw new ManagePaymentsWorksheetWriteError("incompatible_evidence", "Payment evidence needs review before this week can be saved");
  if (caught instanceof PaymentObligationOwnerError) throw new ManagePaymentsWorksheetWriteError("incompatible_evidence", "Payment owner evidence needs review before this week can be saved");
  if (caught instanceof RotatingCreditLedgerError) throw new ManagePaymentsWorksheetWriteError("incompatible_evidence", "Rotating credit evidence needs review before this week can be saved");
  if (caught instanceof ManagePaymentsReconciliationError) throw new ManagePaymentsWorksheetWriteError("incompatible_evidence", "Responsibility components need review before this week can be saved");
  throw caught;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Responsibility = typeof occurrencePaymentResponsibilities.$inferSelect;
type Obligation = typeof paymentObligations.$inferSelect;
type WorksheetPaymentTiming = Awaited<ReturnType<typeof deriveRosterPaymentTimingInTransaction>>;

function sheetRow(snapshot: ManagePaymentsSnapshot, bowlerId: number) {
  for (const team of snapshot.teams) {
    const row = team.rows.find((candidate) => candidate.bowlerId === bowlerId);
    if (row) return { teamId: team.teamId, row };
  }
  return undefined;
}

function feeForComponent(snapshot: ManagePaymentsSnapshot, component: ManagePaymentsChangedRow["feeComponent"]): number {
  switch (component) {
    case "full": return snapshot.league.feeTerms.fullMinor;
    case "lineage": return snapshot.league.feeTerms.lineageMinor;
    case "prize": return snapshot.league.feeTerms.prizeMinor;
  }
}

function releaseKey(commandKey: string, sourceId: string): string {
  return `mprel_${createHash("sha256").update(`${commandKey}:${sourceId}`).digest("hex")}`;
}

async function lockCommandAndReadReplay(
  tx: Tx,
  input: SaveManagePaymentsWorksheetInput,
  requestFingerprint: string,
): Promise<ManagePaymentsSaveResponse | null> {
  const [existing] = await tx.select().from(financialCommands).where(and(
    eq(financialCommands.organizationId, input.organizationId),
    eq(financialCommands.leagueId, input.leagueId),
    eq(financialCommands.commandType, COMMAND_TYPE),
    eq(financialCommands.idempotencyKey, input.request.idempotencyKey),
  )).limit(1).for("update");
  if (!existing) {
    await tx.insert(financialCommands).values({
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      actorUserId: input.actorUserId,
      commandType: COMMAND_TYPE,
      idempotencyKey: input.request.idempotencyKey,
      requestFingerprint,
      state: "accepted",
    });
    return null;
  }
  if (existing.actorUserId !== input.actorUserId || existing.requestFingerprint !== requestFingerprint) {
    throw new ManagePaymentsWorksheetWriteError("idempotency_conflict", "This save key was already used for a different request");
  }
  if (existing.state === "applied" && existing.result !== null) return replayResponse(existing.result);
  if (existing.state === "failed") throw new ManagePaymentsWorksheetWriteError("idempotency_conflict", "This save previously failed; reload this week before starting a new save");
  throw new ManagePaymentsWorksheetWriteError("idempotency_conflict", "This save is already in progress; reload this week before trying again");
}

async function activeResponsibilitiesForOccurrence(tx: Tx, scope: { organizationId: number; leagueId: number; occurrenceId: string }): Promise<Responsibility[]> {
  return tx.select().from(occurrencePaymentResponsibilities).where(and(
    eq(occurrencePaymentResponsibilities.organizationId, scope.organizationId),
    eq(occurrencePaymentResponsibilities.leagueId, scope.leagueId),
    eq(occurrencePaymentResponsibilities.occurrenceId, scope.occurrenceId),
    eq(occurrencePaymentResponsibilities.state, "active"),
  )).orderBy(asc(occurrencePaymentResponsibilities.id)).for("update");
}

async function retireObligationsInTransaction(
  tx: Tx,
  input: SaveManagePaymentsWorksheetInput,
  obligations: readonly Obligation[],
  now: string,
): Promise<Set<number>> {
  const affectedOwners = new Set<number>();
  if (obligations.length === 0) return affectedOwners;
  const obligationIds = obligations.map((row) => row.id);
  const responsibilityIds = [...new Set(obligations.map((row) => row.responsibilityId))];
  {
    const typedApplications = await tx.select({ application: paymentAllocationFundingApplications })
      .from(paymentAllocationFundingApplications)
      .innerJoin(paymentAllocations, and(
        eq(paymentAllocations.id, paymentAllocationFundingApplications.allocationId),
        eq(paymentAllocations.organizationId, input.organizationId),
        eq(paymentAllocations.leagueId, input.leagueId),
      )).where(and(
        eq(paymentAllocationFundingApplications.organizationId, input.organizationId),
        eq(paymentAllocationFundingApplications.leagueId, input.leagueId),
        inArray(paymentAllocationFundingApplications.obligationId, obligationIds),
        eq(paymentAllocations.state, "active"),
      )).orderBy(asc(paymentAllocationFundingApplications.id)).for("update", { of: [paymentAllocationFundingApplications, paymentAllocations] });
    for (const { application } of typedApplications) {
      affectedOwners.add(application.creditedBowlerId);
      await releaseOwnedFundingApplicationInTransaction(tx, {
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        applicationId: application.id,
        actorUserId: input.actorUserId,
        reason: "worksheet_correction",
        idempotencyKey: releaseKey(input.request.idempotencyKey, application.id),
        now,
      });
    }

    const rotatingRows = await tx.select({
      application: rotatingCreditApplications,
      funding: rotatingCreditFundings,
      allocation: paymentAllocations,
    }).from(rotatingCreditApplications)
      .innerJoin(rotatingCreditFundings, and(
        eq(rotatingCreditFundings.id, rotatingCreditApplications.fundingId),
        eq(rotatingCreditFundings.organizationId, input.organizationId),
        eq(rotatingCreditFundings.leagueId, input.leagueId),
      )).innerJoin(paymentAllocations, and(
        eq(paymentAllocations.id, rotatingCreditApplications.allocationId),
        eq(paymentAllocations.organizationId, input.organizationId),
        eq(paymentAllocations.leagueId, input.leagueId),
      )).where(and(
        eq(rotatingCreditApplications.organizationId, input.organizationId),
        eq(rotatingCreditApplications.leagueId, input.leagueId),
        inArray(rotatingCreditApplications.obligationId, obligationIds),
        eq(paymentAllocations.state, "active"),
      ));
    const assignments = await tx.select().from(rotatingOccurrenceAssignments).where(and(
      eq(rotatingOccurrenceAssignments.organizationId, input.organizationId),
      eq(rotatingOccurrenceAssignments.leagueId, input.leagueId),
      inArray(rotatingOccurrenceAssignments.responsibilityId, responsibilityIds),
    ));
    for (const { funding } of rotatingRows) affectedOwners.add(funding.bowlerId);
    for (const assignment of assignments) {
      if (assignment.actualBowlerId !== null) affectedOwners.add(assignment.actualBowlerId);
      await reverseRotatingCreditApplicationsForAssignmentChangeInTransaction(tx, {
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        assignmentId: assignment.id,
        actorUserId: input.actorUserId,
        reason: "Weekly payment responsibility was changed",
        obligationIds,
        now,
      });
    }

    const remainingAllocations = await tx.select({ id: paymentAllocations.id }).from(paymentAllocations).where(and(
      eq(paymentAllocations.organizationId, input.organizationId),
      eq(paymentAllocations.leagueId, input.leagueId),
      inArray(paymentAllocations.obligationId, obligationIds),
      eq(paymentAllocations.state, "active"),
    ));
    if (remainingAllocations.length > 0) {
      throw new ManagePaymentsWorksheetWriteError("incompatible_evidence", "A responsibility has payment allocations that cannot be safely reassigned");
    }
    await tx.update(paymentObligations).set({ state: "voided", voidedAt: now }).where(and(
      eq(paymentObligations.organizationId, input.organizationId),
      eq(paymentObligations.leagueId, input.leagueId),
      inArray(paymentObligations.id, obligationIds),
      ne(paymentObligations.state, "voided"),
    ));
  }
  return affectedOwners;
}

async function activeComponentEvidence(
  tx: Tx,
  input: SaveManagePaymentsWorksheetInput,
  snapshot: ManagePaymentsSnapshot,
  responsibilities: readonly Responsibility[],
): Promise<{ obligations: Obligation[]; evidence: ManagePaymentsExistingEvidence[]; unassignedForecastObligations: Obligation[] }> {
  if (responsibilities.length === 0) return { obligations: [], evidence: [], unassignedForecastObligations: [] };
  const responsibilityById = new Map(responsibilities.map((row) => [row.id, row]));
  const responsibilityIds = [...responsibilityById.keys()];
  const obligations = await tx.select().from(paymentObligations).where(and(
    eq(paymentObligations.organizationId, input.organizationId),
    eq(paymentObligations.leagueId, input.leagueId),
    inArray(paymentObligations.responsibilityId, responsibilityIds),
    ne(paymentObligations.state, "voided"),
  )).orderBy(asc(paymentObligations.id)).for("update");
  const assignmentRows = await tx.select().from(rotatingOccurrenceAssignments).where(and(
    eq(rotatingOccurrenceAssignments.organizationId, input.organizationId),
    eq(rotatingOccurrenceAssignments.leagueId, input.leagueId),
    inArray(rotatingOccurrenceAssignments.responsibilityId, responsibilityIds),
  )).orderBy(asc(rotatingOccurrenceAssignments.responsibilityId), desc(rotatingOccurrenceAssignments.version));
  const assignmentByResponsibility = new Map<string, typeof assignmentRows[number]>();
  for (const assignment of assignmentRows) {
    if (!assignmentByResponsibility.has(assignment.responsibilityId)) {
      assignmentByResponsibility.set(assignment.responsibilityId, assignment);
    }
  }
  const ownerByObligationId = obligations.length === 0 ? new Map() : await resolvePaymentObligationOwnersInTransaction(tx, {
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    obligations: obligations.map((row) => ({ id: row.id, payerBowlerId: row.payerBowlerId })),
  });
  const obligationsByResponsibility = new Map<string, Obligation[]>();
  for (const obligation of obligations) {
    obligationsByResponsibility.set(obligation.responsibilityId, [
      ...(obligationsByResponsibility.get(obligation.responsibilityId) ?? []),
      obligation,
    ]);
  }
  const evidence: ManagePaymentsExistingEvidence[] = [];
  const unassignedForecastObligations: Obligation[] = [];
  for (const obligation of obligations) {
    const responsibility = responsibilityById.get(obligation.responsibilityId);
    if (!responsibility) throw new ManagePaymentsWorksheetWriteError("incompatible_evidence", "A payment component has no active responsibility");
    const owner = ownerByObligationId.get(obligation.id);
    if (!owner) throw new ManagePaymentsWorksheetWriteError("incompatible_evidence", "A payment component is missing its authoritative owner");
    let bowlerId: number;
    if (owner.kind === "bowler") {
      bowlerId = owner.bowlerId;
    } else {
      const assignment = assignmentByResponsibility.get(obligation.responsibilityId);
      if (assignment && assignment.teamId !== owner.teamId) {
        throw new ManagePaymentsWorksheetWriteError("incompatible_evidence", "A team-owned payment component has no exact assigned bowler");
      }
      if (!assignment || assignment.actualBowlerId === null) {
        if (snapshot.weekConfirmed) {
          throw new ManagePaymentsWorksheetWriteError("incompatible_evidence", "A confirmed team-owned payment component has no exact assigned bowler");
        }
        unassignedForecastObligations.push(obligation);
        continue;
      }
      bowlerId = assignment.actualBowlerId;
    }
    const responsibilityObligations = obligationsByResponsibility.get(responsibility.id) ?? [];
    const canCoalesceSamePayerSplit = responsibility.responsibilityKind === "split"
      && responsibility.lineagePayerBowlerId === bowlerId
      && responsibility.prizePayerBowlerId === bowlerId
      && (responsibility.lineageAmountMinor === 0 || responsibilityObligations.some((row) => row.component === "lineage"))
      && (responsibility.prizeFundAmountMinor === 0 || responsibilityObligations.some((row) => row.component === "prize"));
    if (responsibility.responsibilityKind === "worksheet"
      && (responsibility.payerBowlerId !== bowlerId
        || responsibility.worksheetFeeComponent !== obligation.component
        || responsibility.amountMinor !== obligation.amountMinor)) {
      throw new ManagePaymentsWorksheetWriteError("incompatible_evidence", "A saved worksheet row does not match its exact obligation component");
    }
    evidence.push({
      responsibilityId: obligation.responsibilityId,
      teamId: responsibility.teamId,
      bowlerId,
      component: obligation.component,
      amountMinor: obligation.amountMinor,
      obligationId: obligation.id,
      ...(canCoalesceSamePayerSplit ? { coalescedSplitResponsibility: true } : {}),
    });
  }
  for (const responsibility of responsibilities) {
    if (responsibility.responsibilityKind !== "worksheet" || responsibility.amountMinor !== 0 || responsibility.payerBowlerId === null) continue;
    const hasObligation = obligations.some((row) => row.responsibilityId === responsibility.id);
    if (hasObligation) throw new ManagePaymentsWorksheetWriteError("incompatible_evidence", "A zero-fee worksheet row cannot own a positive obligation");
    const component = responsibility.worksheetFeeComponent;
    if (component === null) throw new ManagePaymentsWorksheetWriteError("incompatible_evidence", "A zero-fee worksheet row is missing its component");
    evidence.push({
      responsibilityId: responsibility.id,
      teamId: responsibility.teamId,
      bowlerId: responsibility.payerBowlerId,
      component,
      amountMinor: 0,
      obligationId: null,
      zeroWorksheet: true,
    });
  }
  return { obligations, evidence, unassignedForecastObligations };
}

async function assertSafeToRetireUnassignedForecasts(
  tx: Tx,
  input: SaveManagePaymentsWorksheetInput,
  obligations: readonly Obligation[],
): Promise<void> {
  if (obligations.length === 0) return;
  if (obligations.some((row) => row.state !== "open" || row.voidedAt !== null)) {
    throw new ManagePaymentsWorksheetWriteError("incompatible_evidence", "An unassigned forecast has non-open financial state and needs review");
  }
  const ids = obligations.map((row) => row.id);
  const allocations = await tx.select({ id: paymentAllocations.id }).from(paymentAllocations).where(and(
    eq(paymentAllocations.organizationId, input.organizationId),
    eq(paymentAllocations.leagueId, input.leagueId),
    inArray(paymentAllocations.obligationId, ids),
  )).limit(1).for("share");
  const reservations = await tx.select({ id: paymentOperationRosterSnapshotItems.id }).from(paymentOperationRosterSnapshotItems).where(and(
    eq(paymentOperationRosterSnapshotItems.organizationId, input.organizationId),
    eq(paymentOperationRosterSnapshotItems.leagueId, input.leagueId),
    inArray(paymentOperationRosterSnapshotItems.obligationId, ids),
    inArray(paymentOperationRosterSnapshotItems.state, ["reserved", "finalized"]),
  )).limit(1).for("share");
  if (allocations.length > 0 || reservations.length > 0) {
    throw new ManagePaymentsWorksheetWriteError("incompatible_evidence", "An unassigned forecast has payment or provider-operation evidence and needs review");
  }
}

async function retireEmptyResponsibilitiesInTransaction(
  tx: Tx,
  input: SaveManagePaymentsWorksheetInput,
  responsibilityIds: ReadonlySet<string>,
  retainedZeroResponsibilityIds: ReadonlySet<string>,
): Promise<void> {
  const candidates = [...responsibilityIds].filter((id) => !retainedZeroResponsibilityIds.has(id));
  if (candidates.length === 0) return;
  const remaining = await tx.select({ responsibilityId: paymentObligations.responsibilityId }).from(paymentObligations).where(and(
    eq(paymentObligations.organizationId, input.organizationId),
    eq(paymentObligations.leagueId, input.leagueId),
    inArray(paymentObligations.responsibilityId, candidates),
    ne(paymentObligations.state, "voided"),
  ));
  const withRemainingComponents = new Set(remaining.map((row) => row.responsibilityId));
  const emptyIds = candidates.filter((id) => !withRemainingComponents.has(id));
  if (emptyIds.length === 0) return;
  await tx.update(occurrencePaymentResponsibilities).set({ state: "voided" }).where(and(
    eq(occurrencePaymentResponsibilities.organizationId, input.organizationId),
    eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
    inArray(occurrencePaymentResponsibilities.id, emptyIds),
    eq(occurrencePaymentResponsibilities.state, "active"),
  ));
}

async function existingWorksheetHistory(tx: Tx, input: SaveManagePaymentsWorksheetInput, occurrenceId: string): Promise<Responsibility[]> {
  return tx.select().from(occurrencePaymentResponsibilities).where(and(
    eq(occurrencePaymentResponsibilities.organizationId, input.organizationId),
    eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
    eq(occurrencePaymentResponsibilities.occurrenceId, occurrenceId),
    eq(occurrencePaymentResponsibilities.responsibilityKind, "worksheet"),
  )).orderBy(asc(occurrencePaymentResponsibilities.version), asc(occurrencePaymentResponsibilities.id));
}

async function createWorksheetResponsibility(
  tx: Tx,
  input: SaveManagePaymentsWorksheetInput,
  snapshot: ManagePaymentsSnapshot,
  desired: { teamId: number; bowlerId: number; responsible: boolean; feeComponent: ManagePaymentsChangedRow["feeComponent"]; feeMinor: number },
  history: readonly Responsibility[],
  timing: WorksheetPaymentTiming,
  now: string,
): Promise<void> {
  if (!desired.responsible) return;
  const prior = history.filter((row) => row.payerBowlerId === desired.bowlerId).sort((a, b) => b.version - a.version)[0];
  const responsibilityKey = prior?.responsibilityKey;
  const version = prior ? prior.version + 1 : 1;
  const [responsibility] = await tx.insert(occurrencePaymentResponsibilities).values({
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    occurrenceId: snapshot.selectedOccurrence.occurrenceId,
    teamId: desired.teamId,
    ...(responsibilityKey ? { responsibilityKey } : {}),
    version,
    state: "active",
    responsibilityKind: "worksheet",
    mainBowlerId: null,
    substituteBowlerId: null,
    payerBowlerId: desired.bowlerId,
    lineagePayerBowlerId: null,
    prizePayerBowlerId: null,
    policy: null,
    worksheetFeeComponent: desired.feeComponent,
    amountMinor: desired.feeMinor,
    lineageAmountMinor: null,
    prizeFundAmountMinor: null,
    currency: "USD",
    dueAt: timing.dueAt,
    pastDueAt: timing.pastDueAt,
    assignmentNote: null,
    recordedByUserId: input.actorUserId,
    createdAt: now,
  }).returning();
  if (!responsibility) throw new ManagePaymentsWorksheetWriteError("incompatible_evidence", "The responsibility could not be saved");
  if (desired.feeMinor === 0) return;
  const [obligation] = await tx.insert(paymentObligations).values({
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    occurrenceId: snapshot.selectedOccurrence.occurrenceId,
    responsibilityId: responsibility.id,
    component: desired.feeComponent,
    payerBowlerId: desired.bowlerId,
    amountMinor: desired.feeMinor,
    currency: "USD",
    dueAt: timing.dueAt,
    pastDueAt: timing.pastDueAt,
    state: "open",
    createdByUserId: input.actorUserId,
    createdAt: now,
  }).returning({ id: paymentObligations.id });
  if (!obligation) throw new ManagePaymentsWorksheetWriteError("incompatible_evidence", "The payment obligation could not be saved");
}

export async function appendWorksheetManualReceiptRevisionInTransaction(
  tx: Tx,
  input: { organizationId: number; leagueId: number; actorUserId: number; receiptId: string; revision: number; paymentId: number | null; amountMinor: number; businessCollectionLocalDate: string; revisionKind: "manual_record" | "manual_edit" | "manual_clear"; now: string },
): Promise<void> {
  await tx.insert(weeklyPaymentWorksheetReceiptRevisions).values({
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    receiptId: input.receiptId,
    receiptRevision: input.revision,
    paymentId: input.paymentId,
    revisionKind: input.revisionKind,
    amountMinor: input.amountMinor,
    businessCollectionLocalDate: input.businessCollectionLocalDate,
    recordedByUserId: input.actorUserId,
    createdAt: input.now,
  });
}

async function voidManualReceiptPayment(
  tx: Tx,
  input: SaveManagePaymentsWorksheetInput,
  row: { id: number; bowlerId: number; amount: number; type: string; checkNumber: string | null; currency: string; status: string; providerPaymentId: string | null; paymentOperationId: string | null; notes: string | null; paidByUserId: number | null },
  receiptId: string,
  now: string,
): Promise<Set<number>> {
  if (row.status !== "paid" || row.currency !== "USD" || row.providerPaymentId !== null || row.paymentOperationId !== null
    || (row.type !== "cash" && row.type !== "check")) {
    throw new ManagePaymentsWorksheetWriteError("manual_receipt_conflict", "This receipt is no longer an editable cash or check payment");
  }
  const fundingApplications = await tx.select({ application: paymentAllocationFundingApplications, allocation: paymentAllocations })
    .from(paymentAllocationFundingApplications)
    .innerJoin(paymentAllocations, and(
      eq(paymentAllocations.id, paymentAllocationFundingApplications.allocationId),
      eq(paymentAllocations.organizationId, input.organizationId),
      eq(paymentAllocations.leagueId, input.leagueId),
    )).where(and(
      eq(paymentAllocationFundingApplications.organizationId, input.organizationId),
      eq(paymentAllocationFundingApplications.leagueId, input.leagueId),
      eq(paymentAllocationFundingApplications.paymentId, row.id),
      eq(paymentAllocations.state, "active"),
    )).orderBy(asc(paymentAllocationFundingApplications.id)).for("update", { of: [paymentAllocationFundingApplications, paymentAllocations] });
  const affectedOwners = new Set<number>();
  for (const { application } of fundingApplications) {
    affectedOwners.add(application.creditedBowlerId);
    await releaseOwnedFundingApplicationInTransaction(tx, {
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      applicationId: application.id,
      actorUserId: input.actorUserId,
      reason: "worksheet_correction",
      idempotencyKey: releaseKey(input.request.idempotencyKey, application.id),
      now,
    });
  }
  const rotatingRows = await tx.select({
    application: rotatingCreditApplications,
    funding: rotatingCreditFundings,
  }).from(rotatingCreditApplications)
    .innerJoin(rotatingCreditFundings, and(
      eq(rotatingCreditFundings.id, rotatingCreditApplications.fundingId),
      eq(rotatingCreditFundings.organizationId, input.organizationId),
      eq(rotatingCreditFundings.leagueId, input.leagueId),
    )).where(and(
      eq(rotatingCreditApplications.organizationId, input.organizationId),
      eq(rotatingCreditApplications.leagueId, input.leagueId),
      eq(rotatingCreditApplications.paymentId, row.id),
    )).orderBy(asc(rotatingCreditApplications.id));
  const assignmentIds = new Set<string>();
  for (const { application, funding } of rotatingRows) {
    affectedOwners.add(funding.bowlerId);
    assignmentIds.add(application.assignmentId);
  }
  for (const assignmentId of assignmentIds) {
    await reverseRotatingCreditApplicationsForAssignmentChangeInTransaction(tx, {
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      assignmentId,
      actorUserId: input.actorUserId,
      reason: "Weekly cash or check receipt was corrected",
      paymentId: row.id,
      now,
    });
  }
  const activeAllocations = await tx.select({ id: paymentAllocations.id }).from(paymentAllocations).where(and(
    eq(paymentAllocations.organizationId, input.organizationId),
    eq(paymentAllocations.leagueId, input.leagueId),
    eq(paymentAllocations.paymentId, row.id),
    eq(paymentAllocations.state, "active"),
  ));
  if (activeAllocations.length > 0) throw new ManagePaymentsWorksheetWriteError("manual_receipt_conflict", "This receipt has allocations that cannot be safely edited");
  await tx.insert(paymentVoids).values({
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    paymentId: row.id,
    reason: `Weekly worksheet correction for receipt ${receiptId}`,
    recordedByUserId: input.actorUserId,
    createdAt: now,
  });
  await tx.update(payments).set({ status: "voided" }).where(and(
    eq(payments.id, row.id),
    eq(payments.organizationId, input.organizationId),
    eq(payments.leagueId, input.leagueId),
    eq(payments.status, "paid"),
  ));
  return affectedOwners;
}

function receiptAuthorizationFingerprint(input: { organizationId: number; leagueId: number; occurrenceId: string; receiptId: string; paymentId: number; bowlerId: number; amountMinor: number; businessDate: string; idempotencyKey: string }): string {
  return `lvweeklyreceipt:v1:${createHash("sha256").update(canonicalJsonStringify(input), "utf8").digest("hex")}`;
}

async function createManualReceiptPayment(
  tx: Tx,
  input: SaveManagePaymentsWorksheetInput,
  values: { receiptId: string; bowlerId: number; amountMinor: number; businessDate: string; existingPayment?: { type: "cash" | "check"; checkNumber: string | null; notes: string | null; paidByUserId: number | null } },
  now: string,
): Promise<number> {
  const receiptType = values.existingPayment?.type ?? "cash";
  const [payment] = await tx.insert(payments).values({
    organizationId: input.organizationId,
    bowlerId: values.bowlerId,
    leagueId: input.leagueId,
    amount: values.amountMinor,
    currency: "USD",
    status: "paid",
    type: receiptType,
    checkNumber: values.existingPayment?.checkNumber ?? null,
    providerPaymentId: null,
    idempotencyKey: null,
    receiptEmailMissing: false,
    notes: values.existingPayment?.notes ?? null,
    paidByUserId: values.existingPayment?.paidByUserId ?? input.actorUserId,
    paymentOperationId: null,
    createdAt: now,
  }).returning({ id: payments.id });
  if (!payment) throw new ManagePaymentsWorksheetWriteError("incompatible_evidence", "The cash or check payment could not be recorded");
  await recordOwnedFundingInTransaction(tx, {
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    creditedBowlerId: values.bowlerId,
    paymentId: payment.id,
    portionIndex: 0,
    amountMinor: values.amountMinor,
    currency: "USD",
    source: "worksheet_manual",
    authorizationKind: "manual_receipt",
    authorizationFingerprint: receiptAuthorizationFingerprint({
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      occurrenceId: input.request.occurrenceId,
      receiptId: values.receiptId,
      paymentId: payment.id,
      bowlerId: values.bowlerId,
      amountMinor: values.amountMinor,
      businessDate: values.businessDate,
      idempotencyKey: input.request.idempotencyKey,
    }),
    authorizationOperationId: null,
    authorizationItemCount: 0,
    adoptionId: null,
    recordedByUserId: input.actorUserId,
    now,
  });
  return payment.id;
}

async function saveManualReceiptEdits(
  tx: Tx,
  input: SaveManagePaymentsWorksheetInput,
  snapshot: ManagePaymentsSnapshot,
  changedRows: readonly ManagePaymentsChangedRow[],
  now: string,
): Promise<Set<number>> {
  const affectedOwners = new Set<number>();
  for (const change of changedRows) {
    const found = sheetRow(snapshot, change.bowlerId);
    if (!found || found.teamId !== change.teamId) throw new ManagePaymentsWorksheetWriteError("state_conflict", "The roster changed; reload this week before saving");
    const row = found.row;
    if (change.manualReceiptEdits.length > 0) {
      for (const edit of change.manualReceiptEdits) {
        const receipt = row.manualReceipts.find((candidate) => candidate.receiptId === edit.receiptId);
        if (!receipt || receipt.revision !== edit.expectedRevision) {
          throw new ManagePaymentsWorksheetWriteError("manual_receipt_conflict", "A receipt changed since this worksheet was loaded; reload this week before saving");
        }
        const [parent] = await tx.select().from(weeklyPaymentWorksheetReceipts).where(and(
          eq(weeklyPaymentWorksheetReceipts.id, receipt.receiptId),
          eq(weeklyPaymentWorksheetReceipts.organizationId, input.organizationId),
          eq(weeklyPaymentWorksheetReceipts.leagueId, input.leagueId),
          eq(weeklyPaymentWorksheetReceipts.occurrenceId, input.request.occurrenceId),
          eq(weeklyPaymentWorksheetReceipts.payerBowlerId, change.bowlerId),
          eq(weeklyPaymentWorksheetReceipts.receiptKind, "manual"),
        )).limit(1).for("update");
        const [latest] = await tx.select().from(weeklyPaymentWorksheetReceiptRevisions).where(and(
          eq(weeklyPaymentWorksheetReceiptRevisions.receiptId, receipt.receiptId),
          eq(weeklyPaymentWorksheetReceiptRevisions.organizationId, input.organizationId),
          eq(weeklyPaymentWorksheetReceiptRevisions.leagueId, input.leagueId),
        )).orderBy(desc(weeklyPaymentWorksheetReceiptRevisions.receiptRevision)).limit(1).for("update");
        if (!parent || !latest || latest.receiptRevision !== edit.expectedRevision || latest.paymentId !== receipt.paymentId
          || latest.amountMinor !== receipt.amountMinor || latest.businessCollectionLocalDate !== receipt.businessCollectionLocalDate) {
          throw new ManagePaymentsWorksheetWriteError("manual_receipt_conflict", "A receipt changed since this worksheet was loaded; reload this week before saving");
        }
        if (edit.amountMinor === receipt.amountMinor) continue;
        const [payment] = await tx.select({
          id: payments.id,
          bowlerId: payments.bowlerId,
          amount: payments.amount,
          type: payments.type,
          checkNumber: payments.checkNumber,
          currency: payments.currency,
          status: payments.status,
          providerPaymentId: payments.providerPaymentId,
          paymentOperationId: payments.paymentOperationId,
          notes: payments.notes,
          paidByUserId: payments.paidByUserId,
        }).from(payments).where(and(
          eq(payments.id, receipt.paymentId),
          eq(payments.organizationId, input.organizationId),
          eq(payments.leagueId, input.leagueId),
        )).limit(1).for("update");
        if (!payment || payment.bowlerId !== change.bowlerId || payment.amount !== receipt.amountMinor
          || (payment.type !== "cash" && payment.type !== "check")) {
          throw new ManagePaymentsWorksheetWriteError("manual_receipt_conflict", "This receipt no longer matches its saved cash or check payment");
        }
        const voidedOwners = await voidManualReceiptPayment(tx, input, payment, receipt.receiptId, now);
        for (const ownerId of voidedOwners) affectedOwners.add(ownerId);
        affectedOwners.add(change.bowlerId);
        if (edit.amountMinor === 0) {
          await appendWorksheetManualReceiptRevisionInTransaction(tx, {
            organizationId: input.organizationId,
            leagueId: input.leagueId,
            actorUserId: input.actorUserId,
            receiptId: receipt.receiptId,
            revision: receipt.revision + 1,
            paymentId: null,
            amountMinor: 0,
            businessCollectionLocalDate: receipt.businessCollectionLocalDate,
            revisionKind: "manual_clear",
            now,
          });
        } else {
          const replacementPaymentId = await createManualReceiptPayment(tx, input, {
            receiptId: receipt.receiptId,
            bowlerId: change.bowlerId,
            amountMinor: edit.amountMinor,
            businessDate: receipt.businessCollectionLocalDate,
            existingPayment: {
              type: payment.type,
              checkNumber: payment.checkNumber,
              notes: payment.notes,
              paidByUserId: payment.paidByUserId,
            },
          }, now);
          await appendWorksheetManualReceiptRevisionInTransaction(tx, {
            organizationId: input.organizationId,
            leagueId: input.leagueId,
            actorUserId: input.actorUserId,
            receiptId: receipt.receiptId,
            revision: receipt.revision + 1,
            paymentId: replacementPaymentId,
            amountMinor: edit.amountMinor,
            businessCollectionLocalDate: receipt.businessCollectionLocalDate,
            revisionKind: "manual_edit",
            now,
          });
        }
      }
    }

    const newAmount = change.newManualReceiptAmountMinor ?? 0;
    if (newAmount > 0) {
      const [receipt] = await tx.insert(weeklyPaymentWorksheetReceipts).values({
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        occurrenceId: input.request.occurrenceId,
        payerBowlerId: change.bowlerId,
        receiptKind: "manual",
        createdAt: now,
      }).returning({ id: weeklyPaymentWorksheetReceipts.id });
      if (!receipt) throw new ManagePaymentsWorksheetWriteError("incompatible_evidence", "The weekly cash receipt could not be created");
      const paymentId = await createManualReceiptPayment(tx, input, {
        receiptId: receipt.id,
        bowlerId: change.bowlerId,
        amountMinor: newAmount,
        businessDate: snapshot.selectedOccurrence.localDate,
      }, now);
      await appendWorksheetManualReceiptRevisionInTransaction(tx, {
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        actorUserId: input.actorUserId,
        receiptId: receipt.id,
        revision: 1,
        paymentId,
        amountMinor: newAmount,
        businessCollectionLocalDate: snapshot.selectedOccurrence.localDate,
        revisionKind: "manual_record",
        now,
      });
      affectedOwners.add(change.bowlerId);
    }
  }
  return affectedOwners;
}

export async function saveManagePaymentsWorksheet(input: SaveManagePaymentsWorksheetInput): Promise<ManagePaymentsSaveResponse> {
  const parsed = managePaymentsSaveRequestSchema.safeParse(input.request);
  if (!parsed.success) throw new ManagePaymentsWorksheetWriteError("invalid_request", "The weekly payment changes are invalid");
  const request = canonicalRequest(parsed.data);
  const normalizedInput = { ...input, request };
  const requestFingerprint = managePaymentsSaveRequestFingerprint(request);
  try {
    return await db.transaction(async (tx) => {
      await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
      const replay = await lockCommandAndReadReplay(tx, normalizedInput, requestFingerprint);
      if (replay) return replay;

      const snapshot = await loadManagePaymentsWorksheetSnapshotInTransaction(tx, {
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        occurrenceId: request.occurrenceId,
      });
      if (snapshot.revision !== request.expectedRevision || snapshot.stateFingerprint !== request.expectedStateFingerprint) {
        throw new ManagePaymentsWorksheetWriteError("state_conflict", "This week changed after it was loaded. Reload this week to review the latest saved version before saving again");
      }
      const [adoption] = await tx.select().from(weeklyPaymentLedgerAdoptions).where(and(
        eq(weeklyPaymentLedgerAdoptions.organizationId, input.organizationId),
        eq(weeklyPaymentLedgerAdoptions.leagueId, input.leagueId),
      )).limit(1).for("share");
      if (!adoption) throw new ManagePaymentsWorksheetWriteError("ledger_not_adopted", "Payment setup is not complete for this league.");

      const weekConfirmations = await tx.select({ id: weeklyPaymentWeekConfirmations.id, revision: weeklyPaymentWeekConfirmations.revision })
        .from(weeklyPaymentWeekConfirmations).where(and(
          eq(weeklyPaymentWeekConfirmations.organizationId, input.organizationId),
          eq(weeklyPaymentWeekConfirmations.leagueId, input.leagueId),
          eq(weeklyPaymentWeekConfirmations.occurrenceId, request.occurrenceId),
        )).orderBy(desc(weeklyPaymentWeekConfirmations.revision)).limit(1).for("update");
      const firstExplicitConfirmation = weekConfirmations.length === 0;
      const activeResponsibilities = await activeResponsibilitiesForOccurrence(tx, {
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        occurrenceId: request.occurrenceId,
      });
      const existingComponents = await activeComponentEvidence(tx, normalizedInput, snapshot, activeResponsibilities);
      const allWorksheetHistory = await existingWorksheetHistory(tx, normalizedInput, request.occurrenceId);

      const desiredRows = new Map<number, { teamId: number; bowlerId: number; responsible: boolean; feeComponent: ManagePaymentsChangedRow["feeComponent"]; feeMinor: number; changed: boolean }>();
      for (const team of snapshot.teams) {
        for (const row of team.rows) {
          desiredRows.set(row.bowlerId, {
            teamId: team.teamId,
            bowlerId: row.bowlerId,
            responsible: row.responsible,
            feeComponent: row.feeComponent,
            feeMinor: row.feeMinor,
            changed: false,
          });
        }
      }
      for (const change of request.changedRows) {
        const found = sheetRow(snapshot, change.bowlerId);
        if (!found || found.teamId !== change.teamId) throw new ManagePaymentsWorksheetWriteError("state_conflict", "The roster changed; reload this week before saving");
        const previous = found.row;
        const feeChanged = change.responsible && (!previous.responsible || change.feeComponent !== previous.feeComponent);
        desiredRows.set(change.bowlerId, {
          teamId: found.teamId,
          bowlerId: change.bowlerId,
          responsible: change.responsible,
          feeComponent: change.feeComponent,
          feeMinor: change.responsible ? (feeChanged ? feeForComponent(snapshot, change.feeComponent) : previous.feeMinor) : 0,
          changed: firstExplicitConfirmation || change.responsible !== previous.responsible || change.feeComponent !== previous.feeComponent,
        });
      }

      const nowResult = await tx.execute<{ databaseNow: string }>(sql`SELECT CURRENT_TIMESTAMP::text AS "databaseNow"`);
      const now = nowResult.rows[0]?.databaseNow;
      if (!now) throw new ManagePaymentsWorksheetWriteError("incompatible_evidence", "Database time is not available for this save");

      const desiredComponents: ManagePaymentsDesiredComponent[] = [...desiredRows.values()].map((row) => ({
        teamId: row.teamId,
        bowlerId: row.bowlerId,
        responsible: row.responsible,
        component: row.feeComponent,
        amountMinor: row.feeMinor,
      }));
      const reconciliation = reconcileManagePaymentsComponents(existingComponents.evidence, desiredComponents);
      await assertSafeToRetireUnassignedForecasts(tx, normalizedInput, existingComponents.unassignedForecastObligations);
      const obligationById = new Map(existingComponents.obligations.map((row) => [row.id, row]));
      const obligationIdsToRetire = new Set([
        ...reconciliation.retireObligationIds,
        ...existingComponents.unassignedForecastObligations.map((row) => row.id),
      ]);
      const obligationsToRetire = [...obligationIdsToRetire].flatMap((id) => {
        const obligation = obligationById.get(id);
        return obligation ? [obligation] : [];
      });
      if (obligationsToRetire.length !== obligationIdsToRetire.size) {
        throw new ManagePaymentsWorksheetWriteError("incompatible_evidence", "A responsibility component changed while this week was being saved");
      }
      const affectedOwners = await retireObligationsInTransaction(tx, normalizedInput, obligationsToRetire, now);
      for (const evidence of existingComponents.evidence) {
        if (evidence.obligationId !== null && obligationIdsToRetire.has(evidence.obligationId)) {
          affectedOwners.add(evidence.bowlerId);
        }
      }

      const responsibilityIdsToReevaluate = new Set<string>();
      if (firstExplicitConfirmation) {
        for (const responsibility of activeResponsibilities) {
          if (responsibility.responsibilityKind !== "vacant") responsibilityIdsToReevaluate.add(responsibility.id);
        }
      }
      for (const obligation of obligationsToRetire) responsibilityIdsToReevaluate.add(obligation.responsibilityId);
      for (const evidence of existingComponents.evidence) {
        if (evidence.zeroWorksheet && !reconciliation.retainedZeroResponsibilityIds.has(evidence.responsibilityId)) {
          responsibilityIdsToReevaluate.add(evidence.responsibilityId);
        }
      }
      await retireEmptyResponsibilitiesInTransaction(
        tx,
        normalizedInput,
        responsibilityIdsToReevaluate,
        reconciliation.retainedZeroResponsibilityIds,
      );

      const toCreate = reconciliation.createWorksheetRows;
      let worksheetTiming: WorksheetPaymentTiming | undefined;
      if (toCreate.length > 0) {
        const [timingSource] = await tx.select({
          occurrenceStartAt: leagueOccurrences.startAt,
          paymentMode: leagues.paymentMode,
        }).from(leagueOccurrences).innerJoin(leagues, and(
          eq(leagues.id, leagueOccurrences.leagueId),
          eq(leagues.organizationId, leagueOccurrences.organizationId),
        )).where(and(
          eq(leagueOccurrences.id, snapshot.selectedOccurrence.occurrenceId),
          eq(leagueOccurrences.organizationId, input.organizationId),
          eq(leagueOccurrences.leagueId, input.leagueId),
        )).limit(1).for("share");
        if (!timingSource) throw new ManagePaymentsWorksheetWriteError("state_conflict", "The selected week changed; reload this week before saving");
        worksheetTiming = await deriveRosterPaymentTimingInTransaction(tx, {
          organizationId: input.organizationId,
          leagueId: input.leagueId,
          paymentMode: timingSource.paymentMode,
          occurrenceStartAt: timingSource.occurrenceStartAt,
        });
      }
      for (const desired of toCreate) {
        if (!worksheetTiming) throw new ManagePaymentsWorksheetWriteError("incompatible_evidence", "Payment timing could not be resolved for the selected week");
        await createWorksheetResponsibility(tx, normalizedInput, snapshot, {
          teamId: desired.teamId,
          bowlerId: desired.bowlerId,
          responsible: desired.responsible,
          feeComponent: desired.component,
          feeMinor: desired.amountMinor,
        }, allWorksheetHistory, worksheetTiming, now);
        affectedOwners.add(desired.bowlerId);
      }
      if (firstExplicitConfirmation) {
        for (const desired of desiredComponents) {
          if (desired.responsible) affectedOwners.add(desired.bowlerId);
        }
        for (const evidence of existingComponents.evidence) {
          if (evidence.obligationId !== null && reconciliation.retainedObligationIds.has(evidence.obligationId)) {
            affectedOwners.add(evidence.bowlerId);
          }
        }
      }

      const manualOwners = await saveManualReceiptEdits(tx, normalizedInput, snapshot, request.changedRows, now);
      for (const bowlerId of manualOwners) affectedOwners.add(bowlerId);
      for (const change of request.changedRows) {
        if (change.manualReceiptEdits.length > 0 || (change.newManualReceiptAmountMinor ?? 0) > 0) affectedOwners.add(change.bowlerId);
      }

      const nextRevision = request.expectedRevision + 1;
      const resultingRows = [...desiredRows.values()].filter((row) => row.responsible)
        .map(({ teamId, bowlerId, feeComponent, feeMinor }) => ({ teamId, bowlerId, feeComponent, feeMinor }));
      const setFingerprint = responsibilitySetFingerprint(resultingRows);
      await tx.insert(weeklyPaymentWeekConfirmations).values({
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        occurrenceId: request.occurrenceId,
        revision: nextRevision,
        stateFingerprint: request.expectedStateFingerprint,
        requestFingerprint,
        responsibilitySetFingerprint: setFingerprint,
        idempotencyKey: request.idempotencyKey,
        requestSnapshot: request,
        recordedByUserId: input.actorUserId,
        createdAt: now,
      });

      for (const bowlerId of [...affectedOwners].sort((a, b) => a - b)) {
        await applyOwnedFundingFifoInTransaction(tx, {
          organizationId: input.organizationId,
          leagueId: input.leagueId,
          bowlerId,
          actorUserId: input.actorUserId,
          now,
        });
      }
      const authoritativeSnapshot = await loadManagePaymentsWorksheetSnapshotInTransaction(tx, {
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        occurrenceId: request.occurrenceId,
      });
      const response = managePaymentsSaveResponseSchema.parse({ snapshot: authoritativeSnapshot, replayed: false });
      await tx.update(financialCommands).set({ state: "applied", result: response }).where(and(
        eq(financialCommands.organizationId, input.organizationId),
        eq(financialCommands.leagueId, input.leagueId),
        eq(financialCommands.commandType, COMMAND_TYPE),
        eq(financialCommands.idempotencyKey, request.idempotencyKey),
      ));
      return response;
    });
  } catch (caught) {
    throwWriteError(caught);
  }
}
