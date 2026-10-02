import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
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
import type { ManagePaymentsSnapshot } from "@shared/manage-payments-contract";
import { db } from "../db.js";
import { LeagueOccurrenceScheduleError, loadLeagueOccurrenceScheduleSnapshot } from "./league-occurrence-schedule.js";
import {
  isOccurrenceConfirmedInOwnedLedger,
  OwnedPaymentLedgerError,
  readConfirmedOwnedObligationsInTransaction,
  readOwnedAccountBalancesInTransaction,
  readOwnedLedgerAdoptionInTransaction,
} from "./owned-payment-ledger.js";
import {
  buildManagePaymentsWorksheetSnapshot,
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
  teamsByBowler.set(bowlerId, new Set([...(teamsByBowler.get(bowlerId) ?? []), teamId]));
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
): number | null {
  return selectedWeekResponsibilityTeam.get(bowlerId)
    ?? receiptHistoryTeam.get(bowlerId)
    ?? currentTeam.get(bowlerId)
    ?? null;
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

export async function loadManagePaymentsWorksheetSnapshotInTransaction(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: ReadManagePaymentsWorksheetInput,
): Promise<ManagePaymentsSnapshot> {
  const [league] = await tx.select({
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
  )).limit(1);
  if (!league || league.organizationId !== input.organizationId) {
    throw new ManagePaymentsWorksheetReadError("league_not_found", "League was not found in the authorized organization");
  }

  const adoption = await readOwnedLedgerAdoptionInTransaction(tx, {
    organizationId: input.organizationId,
    leagueId: input.leagueId,
  });
  if (!adoption) {
    throw new ManagePaymentsWorksheetReadError("ledger_not_adopted", "This league's owned payment ledger must be adopted before the worksheet is available");
  }

  const nowResult = await tx.execute<{ databaseNow: string }>(sql`SELECT CURRENT_TIMESTAMP::text AS "databaseNow"`);
  const databaseNow = nowResult.rows[0]?.databaseNow;
  if (!databaseNow) {
    throw new ManagePaymentsWorksheetReadError("incompatible_canonical_state", "Database time is not available for canonical week selection");
  }
  const schedule = await loadLeagueOccurrenceScheduleSnapshot({
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    includeAdministratorEvidence: false,
  }, tx);
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
  const billableOccurrences = schedule.occurrences.filter((occurrence) =>
    (occurrence.lifecycle === "published" || occurrence.lifecycle === "locked")
      && occurrence.status !== "cancelled"
      && occurrence.billing?.obligationPolicy === "eligible_bowlers"
      && occurrence.billing.billingOrdinal !== null,
  );
  const occurrenceIds = idsOrEmpty(billableOccurrences.map((occurrence) => occurrence.occurrenceId));
  const termRows = occurrenceIds.length === 0 ? [] : await tx.select().from(leagueOccurrenceBillingTerms).where(and(
      eq(leagueOccurrenceBillingTerms.organizationId, input.organizationId),
      eq(leagueOccurrenceBillingTerms.leagueId, input.leagueId),
      eq(leagueOccurrenceBillingTerms.purpose, "league_weekly_fee"),
      eq(leagueOccurrenceBillingTerms.state, "published"),
      inArray(leagueOccurrenceBillingTerms.occurrenceId, occurrenceIds),
    ));
  const teamRows = await tx.select({ teamId: teamsTable.id, teamName: teamsTable.name, displayOrder: teamsTable.displayOrder, active: teamsTable.active })
    .from(teamsTable).where(eq(teamsTable.leagueId, input.leagueId)).orderBy(asc(teamsTable.displayOrder), asc(teamsTable.id));
  const memberRows = await tx.select({
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
      )).orderBy(asc(bowlerLeagues.order), asc(bowlers.name), asc(bowlers.id));
  const slotRows = await tx.select({ teamId: teamPaymentSlots.teamId, slotIndex: teamPaymentSlots.slotIndex, bowlerId: teamPaymentSlots.mainBowlerId })
      .from(teamPaymentSlots).where(and(
        eq(teamPaymentSlots.organizationId, input.organizationId),
        eq(teamPaymentSlots.leagueId, input.leagueId),
        eq(teamPaymentSlots.occupant, "main"),
      ));
  const responsibilityRows = occurrenceIds.length === 0 ? [] : await tx.select().from(occurrencePaymentResponsibilities).where(and(
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
    );

  const assignmentRows = occurrenceIds.length === 0 ? [] : await tx.select().from(rotatingOccurrenceAssignments).where(and(
      eq(rotatingOccurrenceAssignments.organizationId, input.organizationId),
      eq(rotatingOccurrenceAssignments.leagueId, input.leagueId),
      inArray(rotatingOccurrenceAssignments.occurrenceId, occurrenceIds),
    )).orderBy(
      asc(rotatingOccurrenceAssignments.occurrenceId),
      asc(rotatingOccurrenceAssignments.teamId),
      asc(rotatingOccurrenceAssignments.slotIndex),
      desc(rotatingOccurrenceAssignments.version),
    );
  const confirmationRows = occurrenceIds.length === 0 ? [] : await tx.select().from(weeklyPaymentWeekConfirmations).where(and(
      eq(weeklyPaymentWeekConfirmations.organizationId, input.organizationId),
      eq(weeklyPaymentWeekConfirmations.leagueId, input.leagueId),
      inArray(weeklyPaymentWeekConfirmations.occurrenceId, occurrenceIds),
    )).orderBy(asc(weeklyPaymentWeekConfirmations.occurrenceId), desc(weeklyPaymentWeekConfirmations.revision));

  const fullFeeMinorByOccurrence = new Map<string, number>();
  for (const occurrence of billableOccurrences) {
    const term = termRows.find((row) => row.occurrenceId === occurrence.occurrenceId
      && row.version === occurrence.billing?.version
      && row.currentRevision === occurrence.billing?.currentRevision);
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
  const members: ManagePaymentsProjectionMember[] = memberRows.map((row) => ({
    teamId: row.teamId,
    bowlerId: row.bowlerId,
    displayName: row.displayName,
    order: row.order,
    rosterRole: slotRows.some((slot) => slot.teamId === row.teamId && slot.bowlerId === row.bowlerId) ? "main" : "substitute",
  }));
  const mainBowlerIdsByTeam = new Map<number, Set<number>>();
  const mainBowlerIdsBySlot = new Map<number, Map<number, number>>();
  for (const row of slotRows) {
    if (row.bowlerId === null) continue;
    mainBowlerIdsByTeam.set(row.teamId, new Set([...(mainBowlerIdsByTeam.get(row.teamId) ?? []), row.bowlerId]));
    mainBowlerIdsBySlot.set(row.teamId, new Map([...(mainBowlerIdsBySlot.get(row.teamId) ?? []), [row.slotIndex, row.bowlerId]]));
  }

  const currentTeamByBowler = new Map<number, number>();
  for (const member of members) {
    if (!currentTeamByBowler.has(member.bowlerId)) currentTeamByBowler.set(member.bowlerId, member.teamId);
    else if (currentTeamByBowler.get(member.bowlerId) !== member.teamId) currentTeamByBowler.delete(member.bowlerId);
  }

  const selectedReceiptParents = await tx.select().from(weeklyPaymentWorksheetReceipts).where(and(
      eq(weeklyPaymentWorksheetReceipts.organizationId, input.organizationId),
      eq(weeklyPaymentWorksheetReceipts.leagueId, input.leagueId),
      eq(weeklyPaymentWorksheetReceipts.occurrenceId, selectedOccurrence.occurrenceId),
      eq(weeklyPaymentWorksheetReceipts.receiptKind, "manual"),
    )).orderBy(asc(weeklyPaymentWorksheetReceipts.id));
  const cardReceiptParents = await tx.select().from(weeklyPaymentWorksheetReceipts).where(and(
      eq(weeklyPaymentWorksheetReceipts.organizationId, input.organizationId),
      eq(weeklyPaymentWorksheetReceipts.leagueId, input.leagueId),
      eq(weeklyPaymentWorksheetReceipts.receiptKind, "card"),
    ));
  const fundingRows = await tx.select({ funding: weeklyPaymentFundings, payment: payments, triggerOccurrenceId: paymentOperations.triggerOccurrenceId })
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
      ));
  const rotatingFundingRows = await tx.select({ funding: rotatingCreditFundings, payment: payments, triggerOccurrenceId: paymentOperations.triggerOccurrenceId })
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
      ));

  const latestReceiptRevisions = selectedReceiptParents.length === 0 ? [] : await tx.select()
    .from(weeklyPaymentWorksheetReceiptRevisions).where(and(
      eq(weeklyPaymentWorksheetReceiptRevisions.organizationId, input.organizationId),
      eq(weeklyPaymentWorksheetReceiptRevisions.leagueId, input.leagueId),
      inArray(weeklyPaymentWorksheetReceiptRevisions.receiptId, selectedReceiptParents.map((row) => row.id)),
    )).orderBy(asc(weeklyPaymentWorksheetReceiptRevisions.receiptId), desc(weeklyPaymentWorksheetReceiptRevisions.receiptRevision));
  const latestRevisionByReceipt = latestByReceipt(latestReceiptRevisions);
  const latestManualPaymentIds = [...new Set([...latestRevisionByReceipt.values()]
    .flatMap((row) => row.paymentId === null ? [] : [row.paymentId]))];
  const manualPayments = latestManualPaymentIds.length === 0 ? [] : await tx.select({
    id: payments.id,
    type: payments.type,
    status: payments.status,
  }).from(payments).where(and(
    eq(payments.organizationId, input.organizationId),
    eq(payments.leagueId, input.leagueId),
    inArray(payments.id, latestManualPaymentIds),
  ));
  const manualPaymentById = new Map(manualPayments.map((row) => [row.id, row]));

  const selectedResponsibilityTeams = new Map<number, number>();
  const selectedResponsibilities = responsibilitiesByOccurrence.get(selectedOccurrence.occurrenceId) ?? [];
  for (const row of selectedResponsibilities) {
    for (const bowlerId of [row.mainBowlerId, row.substituteBowlerId, row.payerBowlerId, row.lineagePayerBowlerId, row.prizePayerBowlerId]) {
      if (bowlerId !== null) selectedResponsibilityTeams.set(bowlerId, row.teamId);
    }
    const rotating = rotatingAssignmentsByResponsibility.get(row.responsibilityId);
    if (rotating) selectedResponsibilityTeams.set(rotating.bowlerId, rotating.teamId);
  }

  const selectedManualParentsById = new Map(selectedReceiptParents.map((row) => [row.id, row]));
  const manualHistoryTeamByBowler = new Map<number, number>();
  if (latestManualPaymentIds.length > 0) {
    const fundingApplications = await tx.select({ paymentId: paymentAllocationFundingApplications.paymentId, bowlerId: paymentAllocationFundingApplications.creditedBowlerId, teamId: paymentAllocationFundingApplications.teamId, occurrenceId: paymentAllocationFundingApplications.occurrenceId })
        .from(paymentAllocationFundingApplications).where(and(
          eq(paymentAllocationFundingApplications.organizationId, input.organizationId),
          eq(paymentAllocationFundingApplications.leagueId, input.leagueId),
          inArray(paymentAllocationFundingApplications.paymentId, latestManualPaymentIds),
        ));
    const obligationAllocations = await tx.select({ paymentId: paymentAllocations.paymentId, bowlerId: paymentObligations.payerBowlerId, teamId: occurrencePaymentResponsibilities.teamId, occurrenceId: paymentObligations.occurrenceId })
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
        ));
    const historyTeamsByReceiptOwner = new Map<number, Set<number>>();
    for (const evidence of [...fundingApplications, ...obligationAllocations]) {
      if (evidence.bowlerId === null) continue;
      const selectedParent = [...selectedManualParentsById.values()].find((parent) => parent.payerBowlerId === evidence.bowlerId
        && latestRevisionByReceipt.get(parent.id)?.paymentId === evidence.paymentId);
      if (!selectedParent || evidence.occurrenceId !== selectedOccurrence.occurrenceId) continue;
      historyTeamsByReceiptOwner.set(evidence.bowlerId, new Set([...(historyTeamsByReceiptOwner.get(evidence.bowlerId) ?? []), evidence.teamId]));
    }
    for (const [bowlerId, teamIds] of historyTeamsByReceiptOwner) {
      if (teamIds.size > 1) {
        throw new ManagePaymentsWorksheetReadError("ambiguous_receipt_history", "A manual receipt's selected-week allocation history resolves to multiple teams");
      }
      const teamId = [...teamIds][0];
      if (teamId !== undefined) manualHistoryTeamByBowler.set(bowlerId, teamId);
    }
  }

  const manualReceipts: ManagePaymentsProjectionManualReceipt[] = [];
  for (const parent of selectedReceiptParents) {
    const revision = latestRevisionByReceipt.get(parent.id);
    if (!revision || revision.paymentId === null || revision.amountMinor <= 0) continue;
    const payment = manualPaymentById.get(revision.paymentId);
    if (!payment || payment.status !== "paid" || (payment.type !== "cash" && payment.type !== "check")) continue;
    const teamId = currentReceiptTeam(
      parent.payerBowlerId,
      selectedResponsibilityTeams,
      manualHistoryTeamByBowler,
      currentTeamByBowler,
    );
    if (teamId === null || !teamRows.some((team) => team.teamId === teamId)) {
      throw new ManagePaymentsWorksheetReadError("incompatible_canonical_state", "A manual receipt owner cannot be placed on a league team");
    }
    manualReceipts.push({
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
  }

  const cardReceiptParentsById = new Map(cardReceiptParents.map((row) => [row.id, row]));
  const cardReceiptRevisions = cardReceiptParents.length === 0 ? [] : await tx.select()
    .from(weeklyPaymentWorksheetReceiptRevisions).where(and(
      eq(weeklyPaymentWorksheetReceiptRevisions.organizationId, input.organizationId),
      eq(weeklyPaymentWorksheetReceiptRevisions.leagueId, input.leagueId),
      inArray(weeklyPaymentWorksheetReceiptRevisions.receiptId, cardReceiptParents.map((row) => row.id)),
    )).orderBy(asc(weeklyPaymentWorksheetReceiptRevisions.receiptId), desc(weeklyPaymentWorksheetReceiptRevisions.receiptRevision));
  const explicitOccurrenceByPayment = new Map<number, string>();
  for (const revision of latestByReceipt(cardReceiptRevisions).values()) {
    const parent = cardReceiptParentsById.get(revision.receiptId);
    if (!parent || revision.revisionKind !== "card_association" || revision.paymentId === null) continue;
    const previous = explicitOccurrenceByPayment.get(revision.paymentId);
    if (previous && previous !== parent.occurrenceId) {
      throw new ManagePaymentsWorksheetReadError("incompatible_canonical_state", "A card receipt is associated with multiple collection weeks");
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
  const cardReceipts: ManagePaymentsProjectionCardReceipt[] = cardFundingEvidence.map((row) => {
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
  const displayRows = displayIds.size === 0 ? [] : await tx.select({ id: bowlers.id, name: bowlers.name })
    .from(bowlers).where(and(
      eq(bowlers.organizationId, input.organizationId),
      inArray(bowlers.id, [...displayIds]),
    ));
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

  const balancesRead = await readOwnedAccountBalancesInTransaction(tx, { organizationId: input.organizationId, leagueId: input.leagueId });
  const finalObligationsRead = await readConfirmedOwnedObligationsInTransaction(tx, { organizationId: input.organizationId, leagueId: input.leagueId });
  const balances = new Map<number, ManagePaymentsProjectionBalance>([...balancesRead].map(([bowlerId, balance]) => [bowlerId, {
    availableCreditMinor: balance.availableCreditMinor,
    confirmedOwedMinor: balance.confirmedOwedMinor,
    netBalanceMinor: balance.netBalanceMinor,
  }]));
  const finalObligations: ManagePaymentsProjectionFinalObligation[] = finalObligationsRead.map((row) => ({
    occurrenceId: row.occurrenceId,
    debtorBowlerId: row.debtorBowlerId,
    amountMinor: row.amountMinor,
    paidMinor: row.paidMinor,
    waivedMinor: row.waivedMinor,
    outstandingMinor: row.outstandingMinor,
    reviewRequired: row.reviewRequired,
  }));

  const projectionLeague: ManagePaymentsProjectionLeague = {
    id: league.id,
    name: league.name,
    timeZone,
    weeklyFeeMinor: league.weeklyFee,
    lineageFeeMinor: league.lineageFee ?? 0,
    prizeFeeMinor: league.prizeFundFee ?? 0,
  };
  return buildManagePaymentsWorksheetSnapshot({
    league: projectionLeague,
    schedule,
    databaseNow,
    selectedOccurrenceId: input.occurrenceId,
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
    manualReceipts,
    cardReceipts,
    balances,
    finalObligations,
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
