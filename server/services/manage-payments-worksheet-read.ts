import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  bowlerLeagues,
  bowlers,
  leagueOccurrenceBillingTerms,
  leagues,
  occurrencePaymentResponsibilities,
  paymentAllocationFundingApplications,
  paymentAllocations,
  paymentObligations,
  paymentOperations,
  payments,
  rotatingCreditFundings,
  rotatingOccurrenceAssignments,
  teamPaymentSlots,
  teams as teamsTable,
  weeklyPaymentFundings,
  weeklyPaymentWeekConfirmations,
  weeklyPaymentWorksheetReceiptRevisions,
  weeklyPaymentWorksheetReceipts,
} from "@shared/schema";
import {
  MANAGE_PAYMENTS_CONTRACT_VERSION,
  managePaymentsSeasonSnapshotSchema,
  type ManagePaymentsSeasonSnapshot,
  type ManagePaymentsSeasonWeekErrorCode,
  type ManagePaymentsSeasonWeekSnapshotEntry,
  type ManagePaymentsSnapshot,
} from "@shared/manage-payments-contract";
import { db } from "../db.js";
import { LeagueOccurrenceScheduleError, loadLeagueOccurrenceScheduleSnapshot } from "./league-occurrence-schedule.js";
import {
  isOccurrenceConfirmedInOwnedLedger,
  OwnedPaymentLedgerError,
  readConfirmedOwnedObligationsInTransaction,
  readOwnedAccountBalancesInTransaction,
  readOwnedLedgerAdoptionInTransaction,
  readOwnedPaymentLedgerReadSnapshotInTransaction,
  type OwnedPaymentLedgerReadSnapshot,
} from "./owned-payment-ledger.js";
import { readCanonicalDuePastDueV3InTransaction } from "./roster-payment-core.js";
import {
  buildManagePaymentsForecastTargets,
  buildManagePaymentsFinalTwoWeeksPaidByBowler,
  buildManagePaymentsWorksheetSnapshot,
  getManagePaymentsWeekOptions,
  localDateForInstant,
  ManagePaymentsWorksheetProjectionError,
  selectManagePaymentsOccurrence,
  type ManagePaymentsProjectionBalance,
  type ManagePaymentsProjectionCardReceipt,
  type ManagePaymentsProjectionFinalObligation,
  type ManagePaymentsProjectionLeague,
  type ManagePaymentsProjectionManualReceipt,
  type ManagePaymentsProjectionMember,
  type ManagePaymentsProjectionResponsibility,
  type ManagePaymentsProjectionRotatingAssignment,
  type ManagePaymentsProjectionTeamInfo,
  type ManagePaymentsProjectionInput,
} from "./manage-payments-worksheet-projection.js";

export type ManagePaymentsWorksheetReadErrorCode =
  | "league_not_found"
  | "ledger_not_adopted"
  | "invalid_occurrence"
  | "incompatible_canonical_state"
  | "ambiguous_receipt_history";

export class ManagePaymentsWorksheetReadError extends Error {
  constructor(public readonly code: ManagePaymentsWorksheetReadErrorCode, message: string) {
    super(message);
    this.name = "ManagePaymentsWorksheetReadError";
  }
}

export interface ReadManagePaymentsWorksheetInput {
  organizationId: number;
  leagueId: number;
  occurrenceId?: string;
  signal?: AbortSignal;
}

interface ManagePaymentsSeasonLocalError {
  code: ManagePaymentsSeasonWeekErrorCode;
  message: string;
}

interface ManagePaymentsWorksheetProjectionContext {
  selectedOccurrenceId: string;
  seasonBase: Pick<ManagePaymentsSeasonSnapshot, "league" | "weekOptions" | "defaultOccurrenceId">;
  projectionInput: Omit<ManagePaymentsProjectionInput, "selectedOccurrenceId" | "manualReceipts" | "finalAccountProjection" | "finalTwoWeeksPaidByBowler">;
  manualReceiptsByOccurrence: ReadonlyMap<string, readonly ManagePaymentsProjectionManualReceipt[]>;
  localErrorsByOccurrence: ReadonlyMap<string, ManagePaymentsSeasonLocalError>;
  finalAccountProjection: ManagePaymentsProjectionInput["finalAccountProjection"];
  finalTwoWeeksPaidByBowler: ReadonlyMap<number, boolean>;
}

class ManagePaymentsWorksheetReadAborted extends Error {
  constructor() {
    super("Manage Payments worksheet read was abandoned");
    this.name = "ManagePaymentsWorksheetReadAborted";
  }
}

export function isManagePaymentsWorksheetReadAborted(error: unknown): boolean {
  return error instanceof ManagePaymentsWorksheetReadAborted;
}

function checkpointWorksheetRead(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ManagePaymentsWorksheetReadAborted();
}

async function readWorksheetStage<T>(signal: AbortSignal | undefined, read: () => Promise<T>): Promise<T> {
  checkpointWorksheetRead(signal);
  const result = await read();
  checkpointWorksheetRead(signal);
  return result;
}

function idsOrEmpty(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function addTeamEvidence(
  teamsByBowler: Map<number, Set<number>>,
  bowlerId: number | null,
  teamId: number,
): void {
  if (bowlerId === null) return;
  const teamIds = teamsByBowler.get(bowlerId);
  if (teamIds) teamIds.add(teamId);
  else teamsByBowler.set(bowlerId, new Set([teamId]));
}

function addRoleEvidence(
  rolesByBowler: Map<number, "main" | "substitute">,
  bowlerId: number | null,
  role: "main" | "substitute",
): void {
  if (bowlerId === null) return;
  const prior = rolesByBowler.get(bowlerId);
  rolesByBowler.set(bowlerId, prior === "main" || role === "main" ? "main" : "substitute");
}

function latestByReceipt<T extends { receiptId: string; receiptRevision: number }>(rows: readonly T[]): Map<string, T> {
  const latest = new Map<string, T>();
  for (const row of rows) {
    if (!latest.has(row.receiptId)) latest.set(row.receiptId, row);
  }
  return latest;
}

function currentReceiptTeam(
  bowlerId: number,
  selectedWeekResponsibilityTeam: ReadonlyMap<number, number>,
  receiptHistoryTeam: ReadonlyMap<number, number>,
  currentTeam: ReadonlyMap<number, number>,
  uniqueHistoricalTeam: ReadonlyMap<number, number>,
): number | null {
  return selectedWeekResponsibilityTeam.get(bowlerId)
    ?? receiptHistoryTeam.get(bowlerId)
    ?? currentTeam.get(bowlerId)
    ?? uniqueHistoricalTeam.get(bowlerId)
    ?? null;
}

export interface ManagePaymentsManualReceiptHistoryEvidence {
  occurrenceId: string;
  paymentId: number;
  bowlerId: number | null;
  teamId: number;
}

export function indexManagePaymentsManualReceiptHistoryTeams(
  parents: readonly { id: string; occurrenceId: string; payerBowlerId: number }[],
  paymentIdByReceipt: ReadonlyMap<string, number | null>,
  evidence: readonly ManagePaymentsManualReceiptHistoryEvidence[],
): {
  teamByOccurrence: ReadonlyMap<string, ReadonlyMap<number, number>>;
  ambiguousOccurrenceIds: ReadonlySet<string>;
} {
  const receiptOwnerPaymentKeys = new Set<string>();
  for (const parent of parents) {
    const paymentId = paymentIdByReceipt.get(parent.id);
    if (paymentId === undefined || paymentId === null) continue;
    receiptOwnerPaymentKeys.add(JSON.stringify([parent.occurrenceId, parent.payerBowlerId, paymentId]));
  }

  const teamsByOccurrence = new Map<string, Map<number, Set<number>>>();
  for (const row of evidence) {
    if (row.bowlerId === null || !receiptOwnerPaymentKeys.has(JSON.stringify([
      row.occurrenceId,
      row.bowlerId,
      row.paymentId,
    ]))) continue;
    const teamsByBowler = teamsByOccurrence.get(row.occurrenceId) ?? new Map<number, Set<number>>();
    teamsByOccurrence.set(row.occurrenceId, teamsByBowler);
    const teamIds = teamsByBowler.get(row.bowlerId) ?? new Set<number>();
    teamIds.add(row.teamId);
    teamsByBowler.set(row.bowlerId, teamIds);
  }

  const teamByOccurrence = new Map<string, ReadonlyMap<number, number>>();
  const ambiguousOccurrenceIds = new Set<string>();
  for (const [occurrenceId, teamsByBowler] of teamsByOccurrence) {
    const resolved = new Map<number, number>();
    for (const [bowlerId, teamIds] of teamsByBowler) {
      if (teamIds.size > 1) {
        ambiguousOccurrenceIds.add(occurrenceId);
        continue;
      }
      const [teamId] = teamIds;
      if (teamId !== undefined) resolved.set(bowlerId, teamId);
    }
    teamByOccurrence.set(occurrenceId, resolved);
  }
  return { teamByOccurrence, ambiguousOccurrenceIds };
}

function isCardPaymentType(value: string): value is "credit_card" | "square" {
  return value === "credit_card" || value === "square";
}

function requireCardPaymentType(value: string): "credit_card" | "square" {
  if (!isCardPaymentType(value)) {
    throw new ManagePaymentsWorksheetReadError("incompatible_canonical_state", "A card funding source is linked to a non-card payment");
  }
  return value;
}

async function loadManagePaymentsWorksheetProjectionContextInTransaction(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: ReadManagePaymentsWorksheetInput,
  receiptScope: "selected" | "season",
): Promise<ManagePaymentsWorksheetProjectionContext> {
  const [league] = await readWorksheetStage(input.signal, () => tx.select({
    id: leagues.id,
    organizationId: leagues.organizationId,
    name: leagues.name,
    timezone: leagues.timezone,
    weeklyFee: leagues.weeklyFee,
    lineageFee: leagues.lineageFee,
    prizeFundFee: leagues.prizeFundFee,
  }).from(leagues).where(and(
    eq(leagues.id, input.leagueId),
    eq(leagues.organizationId, input.organizationId),
  )).limit(1));
  if (!league || league.organizationId !== input.organizationId) {
    throw new ManagePaymentsWorksheetReadError("league_not_found", "League was not found in the authorized organization");
  }

  const adoption = await readWorksheetStage(input.signal, () => readOwnedLedgerAdoptionInTransaction(tx, {
    organizationId: input.organizationId,
    leagueId: input.leagueId,
  }));
  if (!adoption) {
    throw new ManagePaymentsWorksheetReadError("ledger_not_adopted", "Payment setup is not complete for this league.");
  }

  const nowResult = await readWorksheetStage(input.signal, () => tx.execute<{ databaseNow: string }>(sql`SELECT CURRENT_TIMESTAMP::text AS "databaseNow"`));
  const databaseNow = nowResult.rows[0]?.databaseNow;
  if (!databaseNow) {
    throw new ManagePaymentsWorksheetReadError("incompatible_canonical_state", "Database time is not available for canonical week selection");
  }
  const schedule = await readWorksheetStage(input.signal, () => loadLeagueOccurrenceScheduleSnapshot({
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    includeAdministratorEvidence: false,
  }, tx));
  const timeZone = league.timezone ?? schedule.occurrences[0]?.timezone;
  if (!timeZone) {
    throw new ManagePaymentsWorksheetReadError("incompatible_canonical_state", "League time zone is not available in canonical schedule data");
  }
  const selectedOccurrence = selectManagePaymentsOccurrence(
    schedule,
    timeZone,
    databaseNow,
    input.occurrenceId,
  );
  const weekOptions = getManagePaymentsWeekOptions(schedule);
  const billableOccurrences = schedule.occurrences.filter((occurrence) =>
    (occurrence.lifecycle === "published" || occurrence.lifecycle === "locked")
      && occurrence.status !== "cancelled"
      && occurrence.billing?.obligationPolicy === "eligible_bowlers"
      && occurrence.billing.billingOrdinal !== null,
  );
  const occurrenceIds = idsOrEmpty(billableOccurrences.map((occurrence) => occurrence.occurrenceId));
  const termRows = occurrenceIds.length === 0 ? [] : await readWorksheetStage(input.signal, () => tx.select().from(leagueOccurrenceBillingTerms).where(and(
      eq(leagueOccurrenceBillingTerms.organizationId, input.organizationId),
      eq(leagueOccurrenceBillingTerms.leagueId, input.leagueId),
      eq(leagueOccurrenceBillingTerms.purpose, "league_weekly_fee"),
      eq(leagueOccurrenceBillingTerms.state, "published"),
      inArray(leagueOccurrenceBillingTerms.occurrenceId, occurrenceIds),
    )));
  const teamRows = await readWorksheetStage(input.signal, () => tx.select({ teamId: teamsTable.id, teamName: teamsTable.name, displayOrder: teamsTable.displayOrder, active: teamsTable.active })
    .from(teamsTable).where(eq(teamsTable.leagueId, input.leagueId)).orderBy(asc(teamsTable.displayOrder), asc(teamsTable.id)));
  const memberRows = await readWorksheetStage(input.signal, () => tx.select({
      teamId: bowlerLeagues.teamId,
      bowlerId: bowlers.id,
      displayName: bowlers.name,
      order: bowlerLeagues.order,
    }).from(bowlerLeagues)
      .innerJoin(bowlers, eq(bowlers.id, bowlerLeagues.bowlerId))
      .innerJoin(teamsTable, and(eq(teamsTable.id, bowlerLeagues.teamId), eq(teamsTable.leagueId, bowlerLeagues.leagueId)))
      .where(and(
        eq(bowlerLeagues.leagueId, input.leagueId),
        eq(bowlerLeagues.active, true),
        eq(bowlers.organizationId, input.organizationId),
        eq(bowlers.active, true),
      )).orderBy(asc(bowlerLeagues.order), asc(bowlers.name), asc(bowlers.id)));
  const slotRows = await readWorksheetStage(input.signal, () => tx.select({ teamId: teamPaymentSlots.teamId, slotIndex: teamPaymentSlots.slotIndex, bowlerId: teamPaymentSlots.mainBowlerId })
      .from(teamPaymentSlots).where(and(
        eq(teamPaymentSlots.organizationId, input.organizationId),
        eq(teamPaymentSlots.leagueId, input.leagueId),
        eq(teamPaymentSlots.occupant, "main"),
      )));
  const responsibilityRows = occurrenceIds.length === 0 ? [] : await readWorksheetStage(input.signal, () => tx.select().from(occurrencePaymentResponsibilities).where(and(
      eq(occurrencePaymentResponsibilities.organizationId, input.organizationId),
      eq(occurrencePaymentResponsibilities.leagueId, input.leagueId),
      eq(occurrencePaymentResponsibilities.state, "active"),
      inArray(occurrencePaymentResponsibilities.occurrenceId, occurrenceIds),
    )).orderBy(
      asc(occurrencePaymentResponsibilities.occurrenceId),
      asc(occurrencePaymentResponsibilities.teamId),
      asc(occurrencePaymentResponsibilities.slotIndex),
      asc(occurrencePaymentResponsibilities.positionIndex),
      desc(occurrencePaymentResponsibilities.version),
    ));

  const assignmentRows = occurrenceIds.length === 0 ? [] : await readWorksheetStage(input.signal, () => tx.select().from(rotatingOccurrenceAssignments).where(and(
      eq(rotatingOccurrenceAssignments.organizationId, input.organizationId),
      eq(rotatingOccurrenceAssignments.leagueId, input.leagueId),
      inArray(rotatingOccurrenceAssignments.occurrenceId, occurrenceIds),
    )).orderBy(
      asc(rotatingOccurrenceAssignments.occurrenceId),
      asc(rotatingOccurrenceAssignments.teamId),
      asc(rotatingOccurrenceAssignments.slotIndex),
      desc(rotatingOccurrenceAssignments.version),
    ));
  const confirmationRows = occurrenceIds.length === 0 ? [] : await readWorksheetStage(input.signal, () => tx.select().from(weeklyPaymentWeekConfirmations).where(and(
      eq(weeklyPaymentWeekConfirmations.organizationId, input.organizationId),
      eq(weeklyPaymentWeekConfirmations.leagueId, input.leagueId),
      inArray(weeklyPaymentWeekConfirmations.occurrenceId, occurrenceIds),
    )).orderBy(asc(weeklyPaymentWeekConfirmations.occurrenceId), desc(weeklyPaymentWeekConfirmations.revision)));

  const fullFeeMinorByOccurrence = new Map<string, number>();
  const termByOccurrenceRevision = new Map<string, (typeof termRows)[number]>();
  for (const term of termRows) {
    const key = JSON.stringify([term.occurrenceId, term.version, term.currentRevision]);
    if (!termByOccurrenceRevision.has(key)) termByOccurrenceRevision.set(key, term);
  }
  for (const occurrence of billableOccurrences) {
    const term = termByOccurrenceRevision.get(JSON.stringify([
      occurrence.occurrenceId,
      occurrence.billing?.version,
      occurrence.billing?.currentRevision,
    ]));
    if (term) fullFeeMinorByOccurrence.set(occurrence.occurrenceId, term.defaultAmountMinor);
  }

  const responsibilitiesByOccurrence = new Map<string, ManagePaymentsProjectionResponsibility[]>();
  for (const row of responsibilityRows) {
    responsibilitiesByOccurrence.set(row.occurrenceId, [
      ...(responsibilitiesByOccurrence.get(row.occurrenceId) ?? []),
      {
        responsibilityId: row.id,
        teamId: row.teamId,
        slotIndex: row.slotIndex,
        kind: row.responsibilityKind,
        payerBowlerId: row.payerBowlerId,
        mainBowlerId: row.mainBowlerId,
        substituteBowlerId: row.substituteBowlerId,
        lineagePayerBowlerId: row.lineagePayerBowlerId,
        prizePayerBowlerId: row.prizePayerBowlerId,
        worksheetFeeComponent: row.worksheetFeeComponent,
        amountMinor: row.amountMinor,
        lineageAmountMinor: row.lineageAmountMinor,
        prizeAmountMinor: row.prizeFundAmountMinor,
        version: row.version,
      },
    ]);
  }

  const rotatingAssignmentsByResponsibility = new Map<string, ManagePaymentsProjectionRotatingAssignment>();
  const seenAssignmentIds = new Set<string>();
  for (const assignment of assignmentRows) {
    if (seenAssignmentIds.has(assignment.responsibilityId)) continue;
    seenAssignmentIds.add(assignment.responsibilityId);
    if (assignment.actualBowlerId !== null) {
      rotatingAssignmentsByResponsibility.set(assignment.responsibilityId, {
        responsibilityId: assignment.responsibilityId,
        teamId: assignment.teamId,
        bowlerId: assignment.actualBowlerId,
      });
    }
  }

  const explicitConfirmationRevisions = new Map<string, number>();
  for (const confirmation of confirmationRows) {
    if (!explicitConfirmationRevisions.has(confirmation.occurrenceId)) {
      explicitConfirmationRevisions.set(confirmation.occurrenceId, confirmation.revision);
    }
  }
  const confirmedOccurrenceIds = new Set<string>();
  for (const occurrence of billableOccurrences) {
    if (isOccurrenceConfirmedInOwnedLedger(
      adoption,
      occurrence.authoritativeLocalDate,
      explicitConfirmationRevisions.has(occurrence.occurrenceId),
    )) confirmedOccurrenceIds.add(occurrence.occurrenceId);
  }

  const teams: ManagePaymentsProjectionTeamInfo[] = teamRows.map((row) => ({
    teamId: row.teamId,
    teamName: row.teamName,
    displayOrder: row.displayOrder,
    active: row.active,
  }));
  const mainBowlerPairs = new Set(slotRows.flatMap((slot) => slot.bowlerId === null ? [] : [`${slot.teamId}:${slot.bowlerId}`]));
  const members: ManagePaymentsProjectionMember[] = memberRows.map((row) => ({
    teamId: row.teamId,
    bowlerId: row.bowlerId,
    displayName: row.displayName,
    order: row.order,
    rosterRole: mainBowlerPairs.has(`${row.teamId}:${row.bowlerId}`) ? "main" : "substitute",
  }));
  const mainBowlerIdsByTeam = new Map<number, Set<number>>();
  const mainBowlerIdsBySlot = new Map<number, Map<number, number>>();
  for (const row of slotRows) {
    if (row.bowlerId === null) continue;
    const teamBowlers = mainBowlerIdsByTeam.get(row.teamId);
    if (teamBowlers) teamBowlers.add(row.bowlerId);
    else mainBowlerIdsByTeam.set(row.teamId, new Set([row.bowlerId]));
    const slotsByTeam = mainBowlerIdsBySlot.get(row.teamId);
    if (slotsByTeam) slotsByTeam.set(row.slotIndex, row.bowlerId);
    else mainBowlerIdsBySlot.set(row.teamId, new Map([[row.slotIndex, row.bowlerId]]));
  }

  const currentTeamByBowler = new Map<number, number>();
  for (const member of members) {
    if (!currentTeamByBowler.has(member.bowlerId)) currentTeamByBowler.set(member.bowlerId, member.teamId);
    else if (currentTeamByBowler.get(member.bowlerId) !== member.teamId) currentTeamByBowler.delete(member.bowlerId);
  }

  const receiptOccurrenceIds = receiptScope === "season"
    ? occurrenceIds
    : [selectedOccurrence.occurrenceId];
  const manualReceiptParents = receiptOccurrenceIds.length === 0 ? [] : await readWorksheetStage(input.signal, () => tx.select().from(weeklyPaymentWorksheetReceipts).where(and(
      eq(weeklyPaymentWorksheetReceipts.organizationId, input.organizationId),
      eq(weeklyPaymentWorksheetReceipts.leagueId, input.leagueId),
      inArray(weeklyPaymentWorksheetReceipts.occurrenceId, receiptOccurrenceIds),
      eq(weeklyPaymentWorksheetReceipts.receiptKind, "manual"),
    )).orderBy(asc(weeklyPaymentWorksheetReceipts.id)));
  const cardReceiptParents = await readWorksheetStage(input.signal, () => tx.select().from(weeklyPaymentWorksheetReceipts).where(and(
      eq(weeklyPaymentWorksheetReceipts.organizationId, input.organizationId),
      eq(weeklyPaymentWorksheetReceipts.leagueId, input.leagueId),
      eq(weeklyPaymentWorksheetReceipts.receiptKind, "card"),
    )));
  const fundingRows = await readWorksheetStage(input.signal, () => tx.select({ funding: weeklyPaymentFundings, payment: payments, triggerOccurrenceId: paymentOperations.triggerOccurrenceId })
      .from(weeklyPaymentFundings)
      .innerJoin(payments, and(
        eq(payments.id, weeklyPaymentFundings.paymentId),
        eq(payments.organizationId, weeklyPaymentFundings.organizationId),
        eq(payments.leagueId, weeklyPaymentFundings.leagueId),
      ))
      .leftJoin(paymentOperations, and(
        eq(paymentOperations.id, payments.paymentOperationId),
        eq(paymentOperations.organizationId, input.organizationId),
        eq(paymentOperations.leagueId, input.leagueId),
      ))
      .where(and(
        eq(weeklyPaymentFundings.organizationId, input.organizationId),
        eq(weeklyPaymentFundings.leagueId, input.leagueId),
        eq(payments.status, "paid"),
        inArray(payments.type, ["credit_card", "square"]),
      )));
  const rotatingFundingRows = await readWorksheetStage(input.signal, () => tx.select({ funding: rotatingCreditFundings, payment: payments, triggerOccurrenceId: paymentOperations.triggerOccurrenceId })
      .from(rotatingCreditFundings)
      .innerJoin(payments, and(
        eq(payments.id, rotatingCreditFundings.paymentId),
        eq(payments.organizationId, rotatingCreditFundings.organizationId),
        eq(payments.leagueId, rotatingCreditFundings.leagueId),
      ))
      .leftJoin(paymentOperations, and(
        eq(paymentOperations.id, payments.paymentOperationId),
        eq(paymentOperations.organizationId, input.organizationId),
        eq(paymentOperations.leagueId, input.leagueId),
      ))
      .where(and(
        eq(rotatingCreditFundings.organizationId, input.organizationId),
        eq(rotatingCreditFundings.leagueId, input.leagueId),
        eq(payments.status, "paid"),
        inArray(payments.type, ["credit_card", "square"]),
      )));

  const latestReceiptRevisions = manualReceiptParents.length === 0 ? [] : await readWorksheetStage(input.signal, () => tx.select()
    .from(weeklyPaymentWorksheetReceiptRevisions).where(and(
      eq(weeklyPaymentWorksheetReceiptRevisions.organizationId, input.organizationId),
      eq(weeklyPaymentWorksheetReceiptRevisions.leagueId, input.leagueId),
      inArray(weeklyPaymentWorksheetReceiptRevisions.receiptId, manualReceiptParents.map((row) => row.id)),
    )).orderBy(asc(weeklyPaymentWorksheetReceiptRevisions.receiptId), desc(weeklyPaymentWorksheetReceiptRevisions.receiptRevision)));
  const latestRevisionByReceipt = latestByReceipt(latestReceiptRevisions);
  const latestManualPaymentIds = [...new Set([...latestRevisionByReceipt.values()]
    .flatMap((row) => row.paymentId === null ? [] : [row.paymentId]))];
  const manualPayments = latestManualPaymentIds.length === 0 ? [] : await readWorksheetStage(input.signal, () => tx.select({
    id: payments.id,
    type: payments.type,
    status: payments.status,
  }).from(payments).where(and(
    eq(payments.organizationId, input.organizationId),
    eq(payments.leagueId, input.leagueId),
    inArray(payments.id, latestManualPaymentIds),
  )));
  const manualPaymentById = new Map(manualPayments.map((row) => [row.id, row]));

  const localErrorsByOccurrence = new Map<string, ManagePaymentsSeasonLocalError>();
  const setLocalError = (occurrenceId: string, error: ManagePaymentsSeasonLocalError) => {
    if (!localErrorsByOccurrence.has(occurrenceId)) localErrorsByOccurrence.set(occurrenceId, error);
  };
  const selectedResponsibilityTeamsByOccurrence = new Map<string, Map<number, number>>();
  for (const occurrenceId of receiptOccurrenceIds) {
    const selectedResponsibilityTeams = new Map<number, number>();
    const selectedResponsibilities = responsibilitiesByOccurrence.get(occurrenceId) ?? [];
    for (const row of selectedResponsibilities) {
      for (const bowlerId of [row.mainBowlerId, row.substituteBowlerId, row.payerBowlerId, row.lineagePayerBowlerId, row.prizePayerBowlerId]) {
        if (bowlerId !== null) selectedResponsibilityTeams.set(bowlerId, row.teamId);
      }
      const rotating = rotatingAssignmentsByResponsibility.get(row.responsibilityId);
      if (rotating) selectedResponsibilityTeams.set(rotating.bowlerId, rotating.teamId);
    }
    selectedResponsibilityTeamsByOccurrence.set(occurrenceId, selectedResponsibilityTeams);
  }

  let fundingApplications: ManagePaymentsManualReceiptHistoryEvidence[] = [];
  let obligationAllocations: ManagePaymentsManualReceiptHistoryEvidence[] = [];
  if (latestManualPaymentIds.length > 0) {
    fundingApplications = await readWorksheetStage(input.signal, () => tx.select({ paymentId: paymentAllocationFundingApplications.paymentId, bowlerId: paymentAllocationFundingApplications.creditedBowlerId, teamId: paymentAllocationFundingApplications.teamId, occurrenceId: paymentAllocationFundingApplications.occurrenceId })
        .from(paymentAllocationFundingApplications).where(and(
          eq(paymentAllocationFundingApplications.organizationId, input.organizationId),
          eq(paymentAllocationFundingApplications.leagueId, input.leagueId),
          inArray(paymentAllocationFundingApplications.paymentId, latestManualPaymentIds),
        )));
    obligationAllocations = await readWorksheetStage(input.signal, () => tx.select({ paymentId: paymentAllocations.paymentId, bowlerId: paymentObligations.payerBowlerId, teamId: occurrencePaymentResponsibilities.teamId, occurrenceId: paymentObligations.occurrenceId })
        .from(paymentAllocations)
        .innerJoin(paymentObligations, and(
          eq(paymentObligations.id, paymentAllocations.obligationId),
          eq(paymentObligations.organizationId, paymentAllocations.organizationId),
          eq(paymentObligations.leagueId, paymentAllocations.leagueId),
        ))
        .innerJoin(occurrencePaymentResponsibilities, and(
          eq(occurrencePaymentResponsibilities.id, paymentObligations.responsibilityId),
          eq(occurrencePaymentResponsibilities.organizationId, paymentObligations.organizationId),
          eq(occurrencePaymentResponsibilities.leagueId, paymentObligations.leagueId),
        )).where(and(
          eq(paymentAllocations.organizationId, input.organizationId),
          eq(paymentAllocations.leagueId, input.leagueId),
          inArray(paymentAllocations.paymentId, latestManualPaymentIds),
        )));
  }
  const paymentIdByReceipt = new Map([...latestRevisionByReceipt].map(([receiptId, revision]) => [receiptId, revision.paymentId]));
  const manualHistoryIndex = indexManagePaymentsManualReceiptHistoryTeams(
    manualReceiptParents,
    paymentIdByReceipt,
    [...fundingApplications, ...obligationAllocations],
  );
  const manualHistoryTeamByBowlerByOccurrence = manualHistoryIndex.teamByOccurrence;
  for (const occurrenceId of manualHistoryIndex.ambiguousOccurrenceIds) {
    setLocalError(occurrenceId, {
      code: "ambiguous_receipt_history",
      message: "Receipt allocation history for this week needs review.",
    });
  }

  const receiptOwnerHistoricalTeams = new Map<number, Set<number>>();
  for (const rows of responsibilitiesByOccurrence.values()) {
    for (const row of rows) {
      for (const bowlerId of [row.mainBowlerId, row.substituteBowlerId, row.payerBowlerId, row.lineagePayerBowlerId, row.prizePayerBowlerId]) {
        addTeamEvidence(receiptOwnerHistoricalTeams, bowlerId, row.teamId);
      }
      const rotating = rotatingAssignmentsByResponsibility.get(row.responsibilityId);
      if (rotating) addTeamEvidence(receiptOwnerHistoricalTeams, rotating.bowlerId, rotating.teamId);
    }
  }
  const uniqueHistoricalTeamByBowler = new Map<number, number>();
  for (const [bowlerId, teamIds] of receiptOwnerHistoricalTeams) {
    if (teamIds.size !== 1) continue;
    const teamId = [...teamIds][0];
    if (teamId !== undefined) uniqueHistoricalTeamByBowler.set(bowlerId, teamId);
  }

  const manualReceiptsByOccurrence = new Map<string, ManagePaymentsProjectionManualReceipt[]>();
  const leagueTeamIds = new Set(teamRows.map((team) => team.teamId));
  for (const parent of manualReceiptParents) {
    const revision = latestRevisionByReceipt.get(parent.id);
    if (!revision || revision.paymentId === null || revision.amountMinor <= 0) continue;
    const payment = manualPaymentById.get(revision.paymentId);
    if (!payment || payment.status !== "paid" || (payment.type !== "cash" && payment.type !== "check")) continue;
    const selectedResponsibilityTeams = selectedResponsibilityTeamsByOccurrence.get(parent.occurrenceId) ?? new Map();
    const manualHistoryTeamByBowler = manualHistoryTeamByBowlerByOccurrence.get(parent.occurrenceId) ?? new Map();
    const teamId = currentReceiptTeam(
      parent.payerBowlerId,
      selectedResponsibilityTeams,
      manualHistoryTeamByBowler,
      currentTeamByBowler,
      uniqueHistoricalTeamByBowler,
    );
    if (teamId === null || !leagueTeamIds.has(teamId)) {
      setLocalError(parent.occurrenceId, {
        code: "receipt_owner_unresolved",
        message: "A receipt owner cannot be placed on a team for this week.",
      });
      continue;
    }
    const weekReceipts = manualReceiptsByOccurrence.get(parent.occurrenceId) ?? [];
    weekReceipts.push({
      receiptId: parent.id,
      revision: revision.receiptRevision,
      paymentId: revision.paymentId,
      type: payment.type,
      amountMinor: revision.amountMinor,
      businessCollectionLocalDate: revision.businessCollectionLocalDate,
      bowlerId: parent.payerBowlerId,
      teamId,
      occurrenceId: parent.occurrenceId,
    });
    manualReceiptsByOccurrence.set(parent.occurrenceId, weekReceipts);
  }

  const manualReceipts = [...manualReceiptsByOccurrence.values()].flat();
  if (receiptScope === "selected") {
    const selectedLocalError = localErrorsByOccurrence.get(selectedOccurrence.occurrenceId);
    if (selectedLocalError) throwSelectedWeekReadError(selectedLocalError);
  }
  const cardReceiptParentsById = new Map(cardReceiptParents.map((row) => [row.id, row]));
  const cardReceiptRevisions = cardReceiptParents.length === 0 ? [] : await readWorksheetStage(input.signal, () => tx.select()
    .from(weeklyPaymentWorksheetReceiptRevisions).where(and(
      eq(weeklyPaymentWorksheetReceiptRevisions.organizationId, input.organizationId),
      eq(weeklyPaymentWorksheetReceiptRevisions.leagueId, input.leagueId),
      inArray(weeklyPaymentWorksheetReceiptRevisions.receiptId, cardReceiptParents.map((row) => row.id)),
    )).orderBy(asc(weeklyPaymentWorksheetReceiptRevisions.receiptId), desc(weeklyPaymentWorksheetReceiptRevisions.receiptRevision)));
  const explicitOccurrenceByPayment = new Map<number, string>();
  const conflictedCardPaymentIds = new Set<number>();
  const cardAssociationConflict = (occurrenceId: string) => {
    if (!weekOptions.some((option) => option.occurrenceId === occurrenceId)) return;
    setLocalError(occurrenceId, {
      code: "receipt_association_conflict",
      message: "A card receipt is linked to more than one collection week.",
    });
  };
  for (const revision of latestByReceipt(cardReceiptRevisions).values()) {
    const parent = cardReceiptParentsById.get(revision.receiptId);
    if (!parent || revision.revisionKind !== "card_association" || revision.paymentId === null) continue;
    if (conflictedCardPaymentIds.has(revision.paymentId)) {
      cardAssociationConflict(parent.occurrenceId);
      continue;
    }
    const previous = explicitOccurrenceByPayment.get(revision.paymentId);
    if (previous && previous !== parent.occurrenceId) {
      if (receiptScope === "selected") {
        throw new ManagePaymentsWorksheetReadError("incompatible_canonical_state", "A card receipt is associated with multiple collection weeks");
      }
      cardAssociationConflict(previous);
      cardAssociationConflict(parent.occurrenceId);
      explicitOccurrenceByPayment.delete(revision.paymentId);
      conflictedCardPaymentIds.add(revision.paymentId);
      continue;
    }
    explicitOccurrenceByPayment.set(revision.paymentId, parent.occurrenceId);
  }

  const rotatingOwnerPairs = new Set(rotatingFundingRows.map(({ funding }) => `${funding.paymentId}:${funding.bowlerId}`));
  const cardFundingEvidence = [
    ...fundingRows
      .filter(({ funding }) => !rotatingOwnerPairs.has(`${funding.paymentId}:${funding.creditedBowlerId}`))
      .map(({ funding, payment, triggerOccurrenceId }) => ({
        paymentId: payment.id,
        bowlerId: funding.creditedBowlerId,
        amountMinor: funding.amountMinor,
        type: payment.type,
        createdAt: payment.createdAt,
        receiptNumber: payment.receiptNumber,
        triggerOccurrenceId,
      })),
    ...rotatingFundingRows.map(({ funding, payment, triggerOccurrenceId }) => ({
      paymentId: payment.id,
      bowlerId: funding.bowlerId,
      amountMinor: funding.amountMinor,
      type: payment.type,
      createdAt: payment.createdAt,
      receiptNumber: payment.receiptNumber,
      triggerOccurrenceId,
    })),
  ];
  const cardReceipts: ManagePaymentsProjectionCardReceipt[] = cardFundingEvidence
    .filter((row) => !conflictedCardPaymentIds.has(row.paymentId))
    .map((row) => {
      const recordedAt = new Date(row.createdAt).toISOString();
      return {
        paymentId: row.paymentId,
        type: requireCardPaymentType(row.type),
        amountMinor: row.amountMinor,
        collectionLocalDate: localDateForInstant(recordedAt, timeZone),
        recordedAt,
        receiptNumber: row.receiptNumber,
        bowlerId: row.bowlerId,
        explicitCollectionOccurrenceId: explicitOccurrenceByPayment.get(row.paymentId) ?? null,
        triggerOccurrenceId: row.triggerOccurrenceId,
      };
    });

  const displayIds = new Set<number>([
    ...members.map((row) => row.bowlerId),
    ...responsibilityRows.flatMap((row) => [row.mainBowlerId, row.substituteBowlerId, row.payerBowlerId, row.lineagePayerBowlerId, row.prizePayerBowlerId].filter((id): id is number => id !== null)),
    ...manualReceipts.map((row) => row.bowlerId),
    ...cardReceipts.map((row) => row.bowlerId),
  ]);
  const displayRows = displayIds.size === 0 ? [] : await readWorksheetStage(input.signal, () => tx.select({ id: bowlers.id, name: bowlers.name })
    .from(bowlers).where(and(
      eq(bowlers.organizationId, input.organizationId),
      inArray(bowlers.id, [...displayIds]),
    )));
  const displayNamesByBowler = new Map(displayRows.map((row) => [row.id, row.name]));

  const responsibilityTeamsByBowler = new Map<number, Set<number>>();
  const historicalRoleByBowler = new Map<number, "main" | "substitute">();
  for (const [occurrenceId, rows] of responsibilitiesByOccurrence) {
    for (const row of rows) {
      addTeamEvidence(responsibilityTeamsByBowler, row.mainBowlerId, row.teamId);
      addTeamEvidence(responsibilityTeamsByBowler, row.substituteBowlerId, row.teamId);
      addTeamEvidence(responsibilityTeamsByBowler, row.payerBowlerId, row.teamId);
      addTeamEvidence(responsibilityTeamsByBowler, row.lineagePayerBowlerId, row.teamId);
      addTeamEvidence(responsibilityTeamsByBowler, row.prizePayerBowlerId, row.teamId);
      addRoleEvidence(historicalRoleByBowler, row.mainBowlerId, "main");
      addRoleEvidence(historicalRoleByBowler, row.substituteBowlerId, "substitute");
      for (const payer of [row.payerBowlerId, row.lineagePayerBowlerId, row.prizePayerBowlerId]) {
        addRoleEvidence(historicalRoleByBowler, payer, payer !== null && payer === row.mainBowlerId ? "main" : "substitute");
      }
      const rotating = rotatingAssignmentsByResponsibility.get(row.responsibilityId);
      if (rotating) {
        addTeamEvidence(responsibilityTeamsByBowler, rotating.bowlerId, rotating.teamId);
        addRoleEvidence(historicalRoleByBowler, rotating.bowlerId, "substitute");
      }
    }
  }
  const historicalTeamByBowler = new Map<number, number>();
  for (const [bowlerId, teamIds] of responsibilityTeamsByBowler) {
    if (teamIds.size === 1) {
      const teamId = [...teamIds][0];
      if (teamId !== undefined) historicalTeamByBowler.set(bowlerId, teamId);
    }
  }

  const ledgerReadSnapshot: OwnedPaymentLedgerReadSnapshot = await readWorksheetStage(input.signal, () => readOwnedPaymentLedgerReadSnapshotInTransaction(tx, {
    organizationId: input.organizationId,
    leagueId: input.leagueId,
  }, adoption, () => checkpointWorksheetRead(input.signal)));
  const balancesRead = await readWorksheetStage(input.signal, () => readOwnedAccountBalancesInTransaction(tx, {
    organizationId: input.organizationId,
    leagueId: input.leagueId,
  }, ledgerReadSnapshot));
  const finalObligationsRead = await readWorksheetStage(input.signal, () => readConfirmedOwnedObligationsInTransaction(tx, {
    organizationId: input.organizationId,
    leagueId: input.leagueId,
  }, ledgerReadSnapshot));
  const finalObligationIds = finalObligationsRead.map((row) => row.obligationId);
  const finalObligationComponents = finalObligationIds.length === 0 ? [] : await readWorksheetStage(input.signal, () => tx.select({
    obligationId: paymentObligations.id,
    responsibilityId: paymentObligations.responsibilityId,
    component: paymentObligations.component,
    payerBowlerId: paymentObligations.payerBowlerId,
  }).from(paymentObligations).where(and(
    eq(paymentObligations.organizationId, input.organizationId),
    eq(paymentObligations.leagueId, input.leagueId),
    inArray(paymentObligations.id, finalObligationIds),
    ne(paymentObligations.state, "voided"),
  )));
  const finalObligationComponentById = new Map(finalObligationComponents.map((row) => [row.obligationId, row]));
  const balances = new Map<number, ManagePaymentsProjectionBalance>([...balancesRead].map(([bowlerId, balance]) => [bowlerId, {
    availableCreditMinor: balance.availableCreditMinor,
    confirmedOwedMinor: balance.confirmedOwedMinor,
    netBalanceMinor: balance.netBalanceMinor,
  }]));
  const finalObligations: ManagePaymentsProjectionFinalObligation[] = finalObligationsRead.flatMap((row) => {
    const component = finalObligationComponentById.get(row.obligationId);
    if (!component || component.responsibilityId !== row.responsibilityId) {
      throw new ManagePaymentsWorksheetReadError("incompatible_canonical_state", "A confirmed payment obligation is missing its exact fee component");
    }
    return [{
      obligationId: row.obligationId,
      responsibilityId: row.responsibilityId,
      occurrenceId: row.occurrenceId,
      teamId: row.teamId,
      component: component.component,
      payerBowlerId: component.payerBowlerId,
      debtorBowlerId: row.debtorBowlerId,
      amountMinor: row.amountMinor,
      paidMinor: row.paidMinor,
      waivedMinor: row.waivedMinor,
      outstandingMinor: row.outstandingMinor,
      reviewRequired: row.reviewRequired,
    }];
  });

  const projectionLeague: ManagePaymentsProjectionLeague = {
    id: league.id,
    name: league.name,
    timeZone,
    weeklyFeeMinor: league.weeklyFee,
    lineageFeeMinor: league.lineageFee ?? 0,
    prizeFeeMinor: league.prizeFundFee ?? 0,
  };
  const worksheetProjectionInput = {
    league: projectionLeague,
    schedule,
    databaseNow,
    teams,
    members,
    mainBowlerIdsByTeam,
    mainBowlerIdsBySlot,
    displayNamesByBowler,
    historicalTeamByBowler,
    historicalRoleByBowler,
    fullFeeMinorByOccurrence,
    responsibilitiesByOccurrence,
    rotatingAssignmentsByResponsibility,
    explicitConfirmationRevisions,
    confirmedOccurrenceIds,
    cardReceipts,
    balances,
    finalObligations,
  };
  checkpointWorksheetRead(input.signal);
  const forecastTargets = buildManagePaymentsForecastTargets({
    ...worksheetProjectionInput,
    selectedOccurrenceId: input.occurrenceId,
    manualReceipts,
  });
  const finalProjectionRead = await readWorksheetStage(input.signal, () => readCanonicalDuePastDueV3InTransaction(tx, {
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    forecastTargets,
    ledgerReadSnapshot,
    checkpoint: () => checkpointWorksheetRead(input.signal),
  }));
  if (!finalProjectionRead.accountProjectionResult) {
    throw new ManagePaymentsWorksheetReadError("incompatible_canonical_state", "Owned account adoption evidence changed during the worksheet read");
  }
  const finalAccountProjection = {
    rowsByObligationId: finalProjectionRead.accountProjectionResult.rowsByObligationId,
    reviewRequiredByObligationId: finalProjectionRead.accountProjectionResult.reviewRequiredByObligationId,
    forecastCoverageByTargetId: finalProjectionRead.forecastCoverageByTargetId,
  };
  const finalTwoWeeksPaidByBowler = buildManagePaymentsFinalTwoWeeksPaidByBowler({
    ...worksheetProjectionInput,
    selectedOccurrenceId: input.occurrenceId,
    manualReceipts,
    finalAccountProjection,
  });

  checkpointWorksheetRead(input.signal);
  return {
    selectedOccurrenceId: selectedOccurrence.occurrenceId,
    seasonBase: {
      league: { leagueId: league.id, name: league.name, timeZone },
      weekOptions,
      defaultOccurrenceId: selectedOccurrence.occurrenceId,
    },
    projectionInput: worksheetProjectionInput,
    manualReceiptsByOccurrence,
    localErrorsByOccurrence,
    finalAccountProjection,
    finalTwoWeeksPaidByBowler,
  };
}

function projectOccurrenceSnapshot(
  context: ManagePaymentsWorksheetProjectionContext,
  occurrenceId: string,
): ManagePaymentsSnapshot {
  return buildManagePaymentsWorksheetSnapshot({
    ...context.projectionInput,
    selectedOccurrenceId: occurrenceId,
    manualReceipts: context.manualReceiptsByOccurrence.get(occurrenceId) ?? [],
    finalAccountProjection: context.finalAccountProjection,
    finalTwoWeeksPaidByBowler: context.finalTwoWeeksPaidByBowler,
  });
}

function unavailableWeekEntry(
  code: ManagePaymentsSeasonWeekErrorCode,
  message?: string,
): ManagePaymentsSeasonWeekSnapshotEntry {
  const safeMessages: Record<ManagePaymentsSeasonWeekErrorCode, string> = {
    ambiguous_receipt_history: "Receipt allocation history for this week needs review.",
    receipt_association_conflict: "A card receipt is linked to more than one collection week.",
    receipt_owner_unresolved: "A receipt owner cannot be placed on a team for this week.",
    ambiguous_roster: "Roster evidence for this week needs review.",
    missing_historical_team: "A team referenced by this week is unavailable.",
    duplicate_bowler_row: "Responsibility evidence for this week has conflicting bowler rows.",
    incompatible_responsibility: "Responsibility evidence for this week needs review.",
    invalid_occurrence: "This week cannot be projected from canonical records.",
  };
  return { status: "unavailable", code, message: message ?? safeMessages[code] };
}

function seasonWeekEntryFromSnapshot(snapshot: ManagePaymentsSnapshot): ManagePaymentsSeasonWeekSnapshotEntry {
  return {
    status: "ready",
    feeTerms: snapshot.league.feeTerms,
    weekConfirmed: snapshot.weekConfirmed,
    needsConfirmation: snapshot.needsConfirmation,
    revision: snapshot.revision,
    stateFingerprint: snapshot.stateFingerprint,
    teams: snapshot.teams,
  };
}

function throwSelectedWeekReadError(error: ManagePaymentsSeasonLocalError): never {
  if (error.code === "ambiguous_receipt_history") {
    throw new ManagePaymentsWorksheetReadError(
      "ambiguous_receipt_history",
      "A manual receipt's selected-week allocation history resolves to multiple teams",
    );
  }
  if (error.code === "receipt_owner_unresolved") {
    throw new ManagePaymentsWorksheetReadError(
      "incompatible_canonical_state",
      "A manual receipt owner cannot be placed on a league team",
    );
  }
  if (error.code === "receipt_association_conflict") {
    throw new ManagePaymentsWorksheetReadError(
      "incompatible_canonical_state",
      "A card receipt is associated with multiple collection weeks",
    );
  }
  throw new ManagePaymentsWorksheetReadError(
    "incompatible_canonical_state",
    "The weekly payment evidence does not identify one safe worksheet row per bowler",
  );
}

export async function loadManagePaymentsWorksheetSnapshotInTransaction(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: ReadManagePaymentsWorksheetInput,
): Promise<ManagePaymentsSnapshot> {
  const context = await loadManagePaymentsWorksheetProjectionContextInTransaction(tx, input, "selected");
  const localError = context.localErrorsByOccurrence.get(context.selectedOccurrenceId);
  if (localError) throwSelectedWeekReadError(localError);
  return projectOccurrenceSnapshot(context, context.selectedOccurrenceId);
}

export async function loadManagePaymentsSeasonSnapshotInTransaction(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: ReadManagePaymentsWorksheetInput,
): Promise<ManagePaymentsSeasonSnapshot> {
  const context = await loadManagePaymentsWorksheetProjectionContextInTransaction(tx, input, "season");
  const snapshotsByOccurrence: Record<string, ManagePaymentsSeasonWeekSnapshotEntry> = {};
  for (const week of context.seasonBase.weekOptions) {
    checkpointWorksheetRead(input.signal);
    const localError = context.localErrorsByOccurrence.get(week.occurrenceId);
    if (localError) {
      snapshotsByOccurrence[week.occurrenceId] = unavailableWeekEntry(localError.code, localError.message);
      continue;
    }
    try {
      snapshotsByOccurrence[week.occurrenceId] = seasonWeekEntryFromSnapshot(projectOccurrenceSnapshot(context, week.occurrenceId));
    } catch (caught) {
      if (!(caught instanceof ManagePaymentsWorksheetProjectionError)) throw caught;
      snapshotsByOccurrence[week.occurrenceId] = unavailableWeekEntry(caught.code);
    }
    checkpointWorksheetRead(input.signal);
  }
  return managePaymentsSeasonSnapshotSchema.parse({
    contractVersion: MANAGE_PAYMENTS_CONTRACT_VERSION,
    ...context.seasonBase,
    snapshotsByOccurrence,
  });
}

export async function readManagePaymentsWorksheetSnapshot(
  input: ReadManagePaymentsWorksheetInput,
): Promise<ManagePaymentsSnapshot> {
  try {
    return await db.transaction((tx) => loadManagePaymentsWorksheetSnapshotInTransaction(tx, input), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
  } catch (caught) {
    if (caught instanceof ManagePaymentsWorksheetReadError) throw caught;
    if (caught instanceof ManagePaymentsWorksheetProjectionError) {
      if (caught.code === "invalid_occurrence") {
      throw new ManagePaymentsWorksheetReadError("invalid_occurrence", "The requested week could not be projected from canonical league records");
      }
      throw new ManagePaymentsWorksheetReadError("incompatible_canonical_state", "The weekly payment evidence does not identify one safe worksheet row per bowler");
    }
    if (caught instanceof LeagueOccurrenceScheduleError) {
      throw new ManagePaymentsWorksheetReadError(
        caught.code === "league_not_found" ? "league_not_found" : "incompatible_canonical_state",
        "The canonical league schedule is unavailable for the weekly worksheet",
      );
    }
    if (caught instanceof OwnedPaymentLedgerError) {
      throw new ManagePaymentsWorksheetReadError("incompatible_canonical_state", "Owned payment evidence requires review before the worksheet can be read");
    }
    throw caught;
  }
}

export async function readManagePaymentsSeasonSnapshot(
  input: ReadManagePaymentsWorksheetInput,
): Promise<ManagePaymentsSeasonSnapshot> {
  try {
    return await db.transaction((tx) => loadManagePaymentsSeasonSnapshotInTransaction(tx, input), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
  } catch (caught) {
    if (caught instanceof ManagePaymentsWorksheetReadError) throw caught;
    if (caught instanceof ManagePaymentsWorksheetProjectionError) {
      if (caught.code === "invalid_occurrence") {
        throw new ManagePaymentsWorksheetReadError("invalid_occurrence", "The requested weeks could not be projected from canonical league records");
      }
      throw new ManagePaymentsWorksheetReadError("incompatible_canonical_state", "The weekly payment evidence does not identify one safe worksheet row per bowler");
    }
    if (caught instanceof LeagueOccurrenceScheduleError) {
      throw new ManagePaymentsWorksheetReadError(
        caught.code === "league_not_found" ? "league_not_found" : "incompatible_canonical_state",
        "The canonical league schedule is unavailable for the weekly worksheet",
      );
    }
    if (caught instanceof OwnedPaymentLedgerError) {
      throw new ManagePaymentsWorksheetReadError("incompatible_canonical_state", "Owned payment evidence requires review before the worksheet can be read");
    }
    throw caught;
  }
}
