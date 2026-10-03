import { createHash } from "node:crypto";

import { canonicalJsonStringify } from "@shared/canonical-json";
import {
  MANAGE_PAYMENTS_CONTRACT_VERSION,
  MANAGE_PAYMENTS_STATE_FINGERPRINT_PREFIX,
  type ManagePaymentFeeComponent,
  type ManagePaymentsCardReceipt,
  type ManagePaymentsManualReceipt,
  type ManagePaymentsSnapshot,
  type ManagePaymentsTeam,
  type ManagePaymentsWeekOption,
} from "@shared/manage-payments-contract";
import type { LeagueOccurrenceScheduleOccurrence, LeagueOccurrenceScheduleReadContract } from "@shared/league-occurrence-schedule";

export type ManagePaymentsWorksheetProjectionErrorCode =
  | "invalid_occurrence"
  | "ambiguous_roster"
  | "missing_historical_team"
  | "duplicate_bowler_row"
  | "incompatible_responsibility";

export class ManagePaymentsWorksheetProjectionError extends Error {
  constructor(public readonly code: ManagePaymentsWorksheetProjectionErrorCode, message: string) {
    super(message);
    this.name = "ManagePaymentsWorksheetProjectionError";
  }
}

export interface ManagePaymentsProjectionLeague {
  id: number;
  name: string;
  timeZone: string;
  weeklyFeeMinor: number;
  lineageFeeMinor: number;
  prizeFeeMinor: number;
}

export interface ManagePaymentsProjectionTeamInfo {
  teamId: number;
  teamName: string;
  displayOrder: number;
  active: boolean;
}

export interface ManagePaymentsProjectionMember {
  teamId: number;
  bowlerId: number;
  displayName: string;
  order: number;
  rosterRole: "main" | "substitute";
}

export interface ManagePaymentsProjectionResponsibility {
  responsibilityId: string;
  teamId: number;
  slotIndex: number | null;
  kind: "worksheet" | "main" | "substitute" | "split" | "rotating" | "vacant";
  payerBowlerId: number | null;
  mainBowlerId: number | null;
  substituteBowlerId: number | null;
  lineagePayerBowlerId: number | null;
  prizePayerBowlerId: number | null;
  worksheetFeeComponent: ManagePaymentFeeComponent | null;
  amountMinor: number;
  lineageAmountMinor: number | null;
  prizeAmountMinor: number | null;
  version: number;
}

export interface ManagePaymentsProjectionRotatingAssignment {
  responsibilityId: string;
  teamId: number;
  bowlerId: number;
}

export interface ManagePaymentsProjectionManualReceipt extends ManagePaymentsManualReceipt {
  bowlerId: number;
  teamId: number;
  occurrenceId: string;
}

export interface ManagePaymentsProjectionCardReceipt extends ManagePaymentsCardReceipt {
  bowlerId: number;
  explicitCollectionOccurrenceId: string | null;
  triggerOccurrenceId: string | null;
  collectionLocalDate: string;
  recordedAt: string;
  receiptNumber: string | null;
}

export interface ManagePaymentsProjectionConfirmation {
  occurrenceId: string;
  revision: number;
}

export interface ManagePaymentsProjectionBalance {
  availableCreditMinor: number;
  confirmedOwedMinor: number;
  netBalanceMinor: number;
}

export interface ManagePaymentsProjectionFinalObligation {
  obligationId: string;
  responsibilityId: string;
  occurrenceId: string;
  teamId: number;
  component: ManagePaymentFeeComponent;
  payerBowlerId: number | null;
  debtorBowlerId: number;
  amountMinor: number;
  paidMinor: number;
  waivedMinor: number;
  outstandingMinor: number;
  reviewRequired: boolean;
}

export interface ManagePaymentsProjectionInput {
  league: ManagePaymentsProjectionLeague;
  schedule: LeagueOccurrenceScheduleReadContract;
  databaseNow: string;
  selectedOccurrenceId?: string;
  teams: readonly ManagePaymentsProjectionTeamInfo[];
  members: readonly ManagePaymentsProjectionMember[];
  mainBowlerIdsByTeam: ReadonlyMap<number, ReadonlySet<number>>;
  mainBowlerIdsBySlot: ReadonlyMap<number, ReadonlyMap<number, number>>;
  displayNamesByBowler: ReadonlyMap<number, string>;
  historicalTeamByBowler: ReadonlyMap<number, number>;
  historicalRoleByBowler: ReadonlyMap<number, "main" | "substitute">;
  fullFeeMinorByOccurrence: ReadonlyMap<string, number>;
  responsibilitiesByOccurrence: ReadonlyMap<string, readonly ManagePaymentsProjectionResponsibility[]>;
  rotatingAssignmentsByResponsibility: ReadonlyMap<string, ManagePaymentsProjectionRotatingAssignment>;
  explicitConfirmationRevisions: ReadonlyMap<string, number>;
  confirmedOccurrenceIds: ReadonlySet<string>;
  manualReceipts: readonly ManagePaymentsProjectionManualReceipt[];
  cardReceipts: readonly ManagePaymentsProjectionCardReceipt[];
  balances: ReadonlyMap<number, ManagePaymentsProjectionBalance>;
  finalObligations: readonly ManagePaymentsProjectionFinalObligation[];
}

interface ProjectedResponsibility {
  teamId: number;
  bowlerId: number;
  feeComponent: ManagePaymentFeeComponent;
  feeMinor: number;
  responsibilityId: string;
  version: number;
}

interface StateFingerprintRow {
  teamId: number;
  bowlerId: number;
  responsible: boolean;
  feeComponent: ManagePaymentFeeComponent;
  feeMinor: number;
  manualReceipts: Array<{
    receiptId: string;
    paymentId: number;
    type: "cash" | "check";
    amountMinor: number;
    businessCollectionLocalDate: string;
    revision: number;
  }>;
}

export interface ManagePaymentsWorksheetFingerprintInput {
  occurrenceId: string;
  occurrenceRevision: number | null;
  billingTermVersion: number;
  billingTermRevision: number;
  feeTerms: {
    fullMinor: number;
    lineageMinor: number;
    prizeMinor: number;
  };
  rows: readonly StateFingerprintRow[];
}

export function canonicalManagePaymentsWorksheetFingerprintPayload(input: ManagePaymentsWorksheetFingerprintInput): {
  contractVersion: number;
  occurrenceId: string;
  occurrenceRevision: number | null;
  billingTermVersion: number;
  billingTermRevision: number;
  feeTerms: ManagePaymentsWorksheetFingerprintInput["feeTerms"];
  rows: StateFingerprintRow[];
} {
  const rows = [...input.rows]
    .map((row) => ({
      ...row,
      manualReceipts: [...row.manualReceipts].sort((left, right) => left.receiptId.localeCompare(right.receiptId)),
    }))
    .sort((left, right) => left.teamId - right.teamId || left.bowlerId - right.bowlerId);
  return {
    contractVersion: MANAGE_PAYMENTS_CONTRACT_VERSION,
    occurrenceId: input.occurrenceId,
    occurrenceRevision: input.occurrenceRevision,
    billingTermVersion: input.billingTermVersion,
    billingTermRevision: input.billingTermRevision,
    feeTerms: input.feeTerms,
    rows,
  };
}

/**
 * Stable editable worksheet state. Keep this payload and canonical serializer
 * shared with the later atomic save service. Balances and card arrivals are
 * intentionally excluded; exact row ownership, fee, and manual receipt
 * evidence are included.
 */
export function fingerprintManagePaymentsWorksheet(input: ManagePaymentsWorksheetFingerprintInput): string {
  const digest = createHash("sha256").update(canonicalJsonStringify(
    canonicalManagePaymentsWorksheetFingerprintPayload(input),
  ), "utf8").digest("hex");
  return `${MANAGE_PAYMENTS_STATE_FINGERPRINT_PREFIX}${digest}`;
}

function isBillableOccurrence(occurrence: LeagueOccurrenceScheduleOccurrence): boolean {
  return (occurrence.lifecycle === "published" || occurrence.lifecycle === "locked")
    && occurrence.status !== "cancelled"
    && occurrence.billing?.obligationPolicy === "eligible_bowlers"
    && occurrence.billing.billingOrdinal !== null;
}

function compareOccurrenceBillingOrder(left: LeagueOccurrenceScheduleOccurrence, right: LeagueOccurrenceScheduleOccurrence): number {
  const ordinal = (left.billing?.billingOrdinal ?? Number.MAX_SAFE_INTEGER)
    - (right.billing?.billingOrdinal ?? Number.MAX_SAFE_INTEGER);
  if (ordinal !== 0) return ordinal;
  return left.authoritativeLocalDate.localeCompare(right.authoritativeLocalDate)
    || (left.authoritativeLocalStartTime ?? "").localeCompare(right.authoritativeLocalStartTime ?? "")
    || left.occurrenceId.localeCompare(right.occurrenceId);
}

function compareOccurrenceCollectionDate(left: LeagueOccurrenceScheduleOccurrence, right: LeagueOccurrenceScheduleOccurrence): number {
  return left.authoritativeLocalDate.localeCompare(right.authoritativeLocalDate)
    || (left.authoritativeLocalStartTime ?? "").localeCompare(right.authoritativeLocalStartTime ?? "")
    || compareOccurrenceBillingOrder(left, right)
    || left.occurrenceId.localeCompare(right.occurrenceId);
}

function occurrenceWeekLabel(occurrence: LeagueOccurrenceScheduleOccurrence): string {
  const [year, month, day] = occurrence.authoritativeLocalDate.split("-").map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1, 12));
  const dateLabel = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
  return `${dateLabel} · ${requiredOccurrenceStartTime(occurrence)}`;
}

function requiredOccurrenceStartTime(occurrence: LeagueOccurrenceScheduleOccurrence): string {
  if (occurrence.authoritativeLocalStartTime === null) {
    throw new ManagePaymentsWorksheetProjectionError("invalid_occurrence", "A billable week is missing its canonical local start time");
  }
  return occurrence.authoritativeLocalStartTime;
}

export function getManagePaymentsWeekOptions(
  schedule: LeagueOccurrenceScheduleReadContract,
): ManagePaymentsWeekOption[] {
  return schedule.occurrences
    .filter(isBillableOccurrence)
    .sort(compareOccurrenceBillingOrder)
    .map((occurrence) => ({
      occurrenceId: occurrence.occurrenceId,
      localDate: occurrence.authoritativeLocalDate,
      localStartTime: requiredOccurrenceStartTime(occurrence),
      timeZone: occurrence.timezone,
      label: occurrenceWeekLabel(occurrence),
    }));
}

export function localDateForInstant(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
  const year = part("year");
  const month = part("month");
  const day = part("day");
  if (!year || !month || !day) {
    throw new ManagePaymentsWorksheetProjectionError("invalid_occurrence", "The league-local date could not be resolved");
  }
  return `${year}-${month}-${day}`;
}

export function selectManagePaymentsOccurrence(
  schedule: LeagueOccurrenceScheduleReadContract,
  timeZone: string,
  databaseNow: string,
  selectedOccurrenceId?: string,
): LeagueOccurrenceScheduleOccurrence {
  const eligible = schedule.occurrences.filter(isBillableOccurrence).sort(compareOccurrenceBillingOrder);
  if (eligible.length === 0) {
    throw new ManagePaymentsWorksheetProjectionError("invalid_occurrence", "This league has no billable published weeks");
  }
  if (selectedOccurrenceId !== undefined) {
    const explicit = eligible.find((occurrence) => occurrence.occurrenceId === selectedOccurrenceId);
    if (!explicit) {
      throw new ManagePaymentsWorksheetProjectionError("invalid_occurrence", "The selected week is not a billable published week in this league");
    }
    return explicit;
  }

  const localToday = localDateForInstant(databaseNow, timeZone);
  const collectionOrder = [...eligible].sort(compareOccurrenceCollectionDate);
  const currentOrPrevious = collectionOrder.filter((occurrence) => occurrence.authoritativeLocalDate <= localToday);
  const selected = currentOrPrevious[currentOrPrevious.length - 1] ?? collectionOrder[0];
  if (!selected) {
    throw new ManagePaymentsWorksheetProjectionError("invalid_occurrence", "This league has no billable published weeks");
  }
  return selected;
}

export function mapCardReceiptCollectionOccurrence(
  receipt: Pick<ManagePaymentsProjectionCardReceipt, "explicitCollectionOccurrenceId" | "triggerOccurrenceId" | "collectionLocalDate">,
  schedule: LeagueOccurrenceScheduleReadContract,
): string | null {
  const billable = schedule.occurrences.filter(isBillableOccurrence);
  if (billable.length === 0) return null;
  if (receipt.explicitCollectionOccurrenceId !== null) {
    return billable.find((occurrence) => occurrence.occurrenceId === receipt.explicitCollectionOccurrenceId)?.occurrenceId ?? null;
  }
  if (receipt.triggerOccurrenceId !== null) {
    return billable.find((occurrence) => occurrence.occurrenceId === receipt.triggerOccurrenceId)?.occurrenceId ?? null;
  }
  const collectionDate = receipt.collectionLocalDate;
  const collectionOrder = [...billable].sort(compareOccurrenceCollectionDate);
  const atOrBefore = collectionOrder.filter((occurrence) => occurrence.authoritativeLocalDate <= collectionDate);
  return atOrBefore[atOrBefore.length - 1]?.occurrenceId ?? collectionOrder[0]?.occurrenceId ?? null;
}

function responsibilityRows(
  responsibility: ManagePaymentsProjectionResponsibility,
  rotatingAssignments: ReadonlyMap<string, ManagePaymentsProjectionRotatingAssignment>,
): ProjectedResponsibility[] {
  if (responsibility.kind === "worksheet") {
    if (responsibility.payerBowlerId === null || responsibility.worksheetFeeComponent === null) {
      throw new ManagePaymentsWorksheetProjectionError("incompatible_responsibility", "A saved worksheet responsibility is missing its payer or fee component");
    }
    return [{
      teamId: responsibility.teamId,
      bowlerId: responsibility.payerBowlerId,
      feeComponent: responsibility.worksheetFeeComponent,
      feeMinor: responsibility.amountMinor,
      responsibilityId: responsibility.responsibilityId,
      version: responsibility.version,
    }];
  }
  if (responsibility.kind === "vacant") return [];
  if (responsibility.kind === "main" || responsibility.kind === "substitute") {
    if (responsibility.payerBowlerId === null) {
      throw new ManagePaymentsWorksheetProjectionError("incompatible_responsibility", "A saved responsibility is missing its payer");
    }
    return [{
      teamId: responsibility.teamId,
      bowlerId: responsibility.payerBowlerId,
      feeComponent: "full",
      feeMinor: responsibility.amountMinor,
      responsibilityId: responsibility.responsibilityId,
      version: responsibility.version,
    }];
  }
  if (responsibility.kind === "split") {
    const lineagePayer = responsibility.lineagePayerBowlerId;
    const prizePayer = responsibility.prizePayerBowlerId;
    const lineageAmount = responsibility.lineageAmountMinor;
    const prizeAmount = responsibility.prizeAmountMinor;
    if (lineagePayer === null || prizePayer === null || lineageAmount === null || prizeAmount === null) {
      throw new ManagePaymentsWorksheetProjectionError("incompatible_responsibility", "A split responsibility is missing its payer or component amount");
    }
    if (lineagePayer === prizePayer) {
      return [{
        teamId: responsibility.teamId,
        bowlerId: lineagePayer,
        feeComponent: "full",
        feeMinor: lineageAmount + prizeAmount,
        responsibilityId: responsibility.responsibilityId,
        version: responsibility.version,
      }];
    }
    return [
      {
        teamId: responsibility.teamId,
        bowlerId: lineagePayer,
        feeComponent: "lineage",
        feeMinor: lineageAmount,
        responsibilityId: responsibility.responsibilityId,
        version: responsibility.version,
      },
      {
        teamId: responsibility.teamId,
        bowlerId: prizePayer,
        feeComponent: "prize",
        feeMinor: prizeAmount,
        responsibilityId: responsibility.responsibilityId,
        version: responsibility.version,
      },
    ];
  }
  const assignment = rotatingAssignments.get(responsibility.responsibilityId);
  if (!assignment) return [];
  return [{
    teamId: assignment.teamId,
    bowlerId: assignment.bowlerId,
    feeComponent: "full",
    feeMinor: responsibility.amountMinor,
    responsibilityId: responsibility.responsibilityId,
    version: responsibility.version,
  }];
}

function confirmedResponsibilityRows(
  occurrenceId: string,
  responsibilities: readonly ManagePaymentsProjectionResponsibility[],
  input: ManagePaymentsProjectionInput,
): ProjectedResponsibility[] {
  const worksheetRows = responsibilities
    .filter((row) => row.kind === "worksheet")
    .flatMap((row) => responsibilityRows(row, input.rotatingAssignmentsByResponsibility));
  const legacyRows = responsibilities.filter((row) => row.kind !== "worksheet");
  const legacyIds = new Set(legacyRows.map((row) => row.responsibilityId));
  const obligationRows = input.finalObligations.filter((row) => row.occurrenceId === occurrenceId
    && legacyIds.has(row.responsibilityId));
  const versionByResponsibility = new Map(legacyRows.map((row) => [row.responsibilityId, row.version]));
  const projected: ProjectedResponsibility[] = [...worksheetRows];
  const rowsByResponsibility = new Map<string, ManagePaymentsProjectionFinalObligation[]>();
  for (const obligation of obligationRows) {
    rowsByResponsibility.set(obligation.responsibilityId, [
      ...(rowsByResponsibility.get(obligation.responsibilityId) ?? []),
      obligation,
    ]);
  }

  for (const responsibility of legacyRows) {
    const obligations = rowsByResponsibility.get(responsibility.responsibilityId) ?? [];
    const componentsByBowler = new Map<number, ManagePaymentsProjectionFinalObligation[]>();
    for (const obligation of obligations) {
      componentsByBowler.set(obligation.debtorBowlerId, [
        ...(componentsByBowler.get(obligation.debtorBowlerId) ?? []),
        obligation,
      ]);
    }
    for (const [bowlerId, components] of componentsByBowler) {
      const lineage = components.filter((row) => row.component === "lineage");
      const prize = components.filter((row) => row.component === "prize");
      const full = components.filter((row) => row.component === "full");
      const samePayerSplit = responsibility.kind === "split"
        && responsibility.lineagePayerBowlerId === bowlerId
        && responsibility.prizePayerBowlerId === bowlerId;
      const allPositiveSplitComponentsRetained = samePayerSplit
        && (responsibility.lineageAmountMinor === 0 || lineage.length > 0)
        && (responsibility.prizeAmountMinor === 0 || prize.length > 0);
      if (allPositiveSplitComponentsRetained && full.length === 0 && (lineage.length > 0 || prize.length > 0)) {
        projected.push({
          teamId: responsibility.teamId,
          bowlerId,
          feeComponent: "full",
          feeMinor: [...lineage, ...prize].reduce((sum, row) => sum + row.amountMinor, 0),
          responsibilityId: responsibility.responsibilityId,
          version: versionByResponsibility.get(responsibility.responsibilityId) ?? 0,
        });
        continue;
      }
      if (full.length > 0) {
        for (const row of full) {
          projected.push({
            teamId: row.teamId,
            bowlerId,
            feeComponent: "full",
            feeMinor: row.amountMinor,
            responsibilityId: row.responsibilityId,
            version: versionByResponsibility.get(row.responsibilityId) ?? 0,
          });
        }
      }
      if (lineage.length > 0 && prize.length > 0) {
        const lineageMinor = lineage.reduce((sum, row) => sum + row.amountMinor, 0);
        const prizeMinor = prize.reduce((sum, row) => sum + row.amountMinor, 0);
        projected.push({
          teamId: responsibility.teamId,
          bowlerId,
          feeComponent: "full",
          feeMinor: lineageMinor + prizeMinor,
          responsibilityId: responsibility.responsibilityId,
          version: versionByResponsibility.get(responsibility.responsibilityId) ?? 0,
        });
      } else {
        for (const row of [...lineage, ...prize]) {
          projected.push({
            teamId: row.teamId,
            bowlerId,
            feeComponent: row.component,
            feeMinor: row.amountMinor,
            responsibilityId: row.responsibilityId,
            version: versionByResponsibility.get(row.responsibilityId) ?? 0,
          });
        }
      }
    }
  }
  return projected;
}

function finalBillableWeeks(schedule: LeagueOccurrenceScheduleReadContract): LeagueOccurrenceScheduleOccurrence[] {
  const billable = schedule.occurrences.filter(isBillableOccurrence).sort(compareOccurrenceBillingOrder);
  return billable.slice(-2);
}

function representedMainBowlerIds(
  responsibilities: readonly ManagePaymentsProjectionResponsibility[],
  mainBowlerIdsBySlot: ReadonlyMap<number, ReadonlyMap<number, number>>,
): Map<number, Set<number>> {
  const represented = new Map<number, Set<number>>();
  for (const row of responsibilities) {
    const mainBowlerId = row.mainBowlerId
      ?? (row.slotIndex === null ? undefined : mainBowlerIdsBySlot.get(row.teamId)?.get(row.slotIndex))
      ?? null;
    if (mainBowlerId !== null) {
      represented.set(row.teamId, new Set([...(represented.get(row.teamId) ?? []), mainBowlerId]));
    }
  }
  return represented;
}

function defaultMainResponsibilities(
  input: ManagePaymentsProjectionInput,
  occurrenceId: string,
  candidateResponsibilities: readonly ManagePaymentsProjectionResponsibility[],
): ProjectedResponsibility[] {
  const represented = representedMainBowlerIds(candidateResponsibilities, input.mainBowlerIdsBySlot);
  return input.members
    .filter((member) => member.rosterRole === "main" && represented.get(member.teamId)?.has(member.bowlerId) !== true)
    .map((member) => ({
      teamId: member.teamId,
      bowlerId: member.bowlerId,
      feeComponent: "full" as const,
      feeMinor: input.fullFeeMinorByOccurrence.get(occurrenceId) ?? 0,
      responsibilityId: `default:${occurrenceId}:${member.bowlerId}`,
      version: 0,
    }));
}

function buildFinalPaidByBowler(input: ManagePaymentsProjectionInput): Map<number, boolean> {
  const finalWeeks = finalBillableWeeks(input.schedule);
  if (finalWeeks.length === 0) return new Map();
  const firstFinalWeek = finalWeeks[0];
  if (!firstFinalWeek) return new Map();
  const scheduleOccurrenceById = new Map(input.schedule.occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]));
  const targetByBowler = new Map<number, Array<{ occurrenceId: string; feeMinor: number; confirmed: boolean }>>();

  for (const occurrence of finalWeeks) {
    const explicitRevision = input.explicitConfirmationRevisions.get(occurrence.occurrenceId);
    const confirmed = input.confirmedOccurrenceIds.has(occurrence.occurrenceId);
    const candidateRows = input.responsibilitiesByOccurrence.get(occurrence.occurrenceId) ?? [];
    const candidateResponsibilities = candidateRows.filter((row) => row.kind !== "worksheet" || explicitRevision !== undefined);
    const savedRows = explicitRevision !== undefined
      ? confirmedResponsibilityRows(occurrence.occurrenceId, candidateResponsibilities, input)
      : candidateResponsibilities.flatMap((row) => responsibilityRows(row, input.rotatingAssignmentsByResponsibility));
    const selected = confirmed
      ? savedRows
      : [...savedRows, ...defaultMainResponsibilities(input, occurrence.occurrenceId, candidateResponsibilities)];

    for (const row of selected) {
      if (row.feeMinor <= 0) continue;
      targetByBowler.set(row.bowlerId, [
        ...(targetByBowler.get(row.bowlerId) ?? []),
        { occurrenceId: occurrence.occurrenceId, feeMinor: row.feeMinor, confirmed },
      ]);
    }
  }

  const output = new Map<number, boolean>();
  const obligationsByOccurrenceAndBowler = new Map<string, ManagePaymentsProjectionFinalObligation[]>();
  for (const obligation of input.finalObligations) {
    obligationsByOccurrenceAndBowler.set(
      `${obligation.occurrenceId}:${obligation.debtorBowlerId}`,
      [...(obligationsByOccurrenceAndBowler.get(`${obligation.occurrenceId}:${obligation.debtorBowlerId}`) ?? []), obligation],
    );
  }

  for (const [bowlerId, targets] of targetByBowler) {
    if (targets.length === 0) {
      output.set(bowlerId, false);
      continue;
    }
    let covered = true;
    const balance = input.balances.get(bowlerId);
    let creditRemaining = balance?.availableCreditMinor ?? 0;
    let detailedConfirmedOwed = 0;
    let olderReviewRequired = false;
    for (const obligation of input.finalObligations) {
      if (obligation.debtorBowlerId !== bowlerId) continue;
      detailedConfirmedOwed += obligation.outstandingMinor;
      const obligationOccurrence = scheduleOccurrenceById.get(obligation.occurrenceId);
      const beforeFinalWeeks = !obligationOccurrence
        || compareOccurrenceBillingOrder(obligationOccurrence, firstFinalWeek) < 0;
      if (beforeFinalWeeks) {
        creditRemaining = Math.max(0, creditRemaining - obligation.outstandingMinor);
        olderReviewRequired ||= obligation.reviewRequired;
      }
    }
    if (olderReviewRequired) creditRemaining = 0;
    if (balance) {
      const unclassifiedOwed = Math.max(0, balance.confirmedOwedMinor - detailedConfirmedOwed);
      creditRemaining = Math.max(0, creditRemaining - unclassifiedOwed);
    }

    const targetByOccurrence = new Map(targets.map((target) => [target.occurrenceId, target]));
    for (const occurrence of finalWeeks) {
      const target = targetByOccurrence.get(occurrence.occurrenceId);
      const obligations = obligationsByOccurrenceAndBowler.get(`${occurrence.occurrenceId}:${bowlerId}`) ?? [];
      const outstanding = obligations.reduce((sum, obligation) => sum + obligation.outstandingMinor, 0);
      if (!target) {
        creditRemaining = Math.max(0, creditRemaining - outstanding);
        if (obligations.some((obligation) => obligation.reviewRequired)) creditRemaining = 0;
        continue;
      }
      if (!target.confirmed) {
        creditRemaining = Math.max(0, creditRemaining - outstanding);
        if (obligations.some((obligation) => obligation.reviewRequired)) creditRemaining = 0;
        if (target.feeMinor > creditRemaining) covered = false;
        creditRemaining = Math.max(0, creditRemaining - target.feeMinor);
        continue;
      }
      const moneyPaid = obligations.reduce((sum, obligation) => sum + obligation.paidMinor, 0);
      const coveredByMoney = moneyPaid >= target.feeMinor
        && obligations.every((obligation) => !obligation.reviewRequired);
      if (!coveredByMoney) covered = false;
      creditRemaining = Math.max(0, creditRemaining - outstanding);
      if (obligations.some((obligation) => obligation.reviewRequired)) creditRemaining = 0;
    }
    output.set(bowlerId, covered);
  }
  return output;
}

export function buildManagePaymentsWorksheetSnapshot(input: ManagePaymentsProjectionInput): ManagePaymentsSnapshot {
  const selectedOccurrence = selectManagePaymentsOccurrence(
    input.schedule,
    input.league.timeZone,
    input.databaseNow,
    input.selectedOccurrenceId,
  );
  const selectedTerm = selectedOccurrence.billing;
  if (!selectedTerm || !isBillableOccurrence(selectedOccurrence)) {
    throw new ManagePaymentsWorksheetProjectionError("invalid_occurrence", "The selected week has no current billable terms");
  }
  const weekOptions = getManagePaymentsWeekOptions(input.schedule);
  const selectedWeekOption = weekOptions.find((option) => option.occurrenceId === selectedOccurrence.occurrenceId);
  if (!selectedWeekOption) {
    throw new ManagePaymentsWorksheetProjectionError("invalid_occurrence", "The selected week is not available");
  }
  const fullFeeMinor = input.fullFeeMinorByOccurrence.get(selectedOccurrence.occurrenceId) ?? 0;
  if (fullFeeMinor <= 0) {
    throw new ManagePaymentsWorksheetProjectionError("invalid_occurrence", "The selected week is missing its canonical full-fee amount");
  }
  const feeTerms = {
    fullMinor: fullFeeMinor,
    lineageMinor: input.league.lineageFeeMinor,
    prizeMinor: input.league.prizeFeeMinor,
  };
  const confirmationRevision = input.explicitConfirmationRevisions.get(selectedOccurrence.occurrenceId);
  const weekConfirmed = input.confirmedOccurrenceIds.has(selectedOccurrence.occurrenceId);
  const isExplicitlyConfirmed = confirmationRevision !== undefined;
  const candidateSavedResponsibilities = input.responsibilitiesByOccurrence.get(selectedOccurrence.occurrenceId) ?? [];
  const sourceResponsibilities = candidateSavedResponsibilities.filter((row) => {
    if (isExplicitlyConfirmed) return true;
    return row.kind !== "worksheet";
  });
  const useSavedResponsibilities = isExplicitlyConfirmed || sourceResponsibilities.length > 0;
  const actualRows = isExplicitlyConfirmed
    ? confirmedResponsibilityRows(selectedOccurrence.occurrenceId, sourceResponsibilities, input)
    : sourceResponsibilities.flatMap((row) => responsibilityRows(row, input.rotatingAssignmentsByResponsibility));
  const defaults = !isExplicitlyConfirmed
    ? defaultMainResponsibilities(input, selectedOccurrence.occurrenceId, sourceResponsibilities)
    : [];
  const exactByBowler = new Map<number, ProjectedResponsibility>();
  for (const row of actualRows) {
    const previous = exactByBowler.get(row.bowlerId);
    if (previous) {
      throw new ManagePaymentsWorksheetProjectionError("duplicate_bowler_row", "A bowler has more than one active responsibility row for this week");
    }
    exactByBowler.set(row.bowlerId, row);
  }

  const teamById = new Map(input.teams.map((team) => [team.teamId, team]));
  const memberByBowler = new Map<number, ManagePaymentsProjectionMember>();
  for (const member of input.members) {
    const existing = memberByBowler.get(member.bowlerId);
    if (existing && existing.teamId !== member.teamId) {
      throw new ManagePaymentsWorksheetProjectionError("ambiguous_roster", "A bowler has active memberships on more than one team in this league");
    }
    if (!existing || member.order < existing.order) memberByBowler.set(member.bowlerId, member);
    if (!teamById.has(member.teamId)) {
      throw new ManagePaymentsWorksheetProjectionError("missing_historical_team", "An active roster membership has no matching league team");
    }
  }

  const rowSeeds = new Map<number, {
    teamId: number;
    displayName: string;
    order: number;
    rosterRole: "main" | "substitute";
    currentMember: boolean;
  }>();
  const manualReceiptTeamByBowler = new Map<number, number>();
  for (const member of input.members) {
    rowSeeds.set(member.bowlerId, {
      teamId: member.teamId,
      displayName: member.displayName,
      order: member.order,
      rosterRole: member.rosterRole,
      currentMember: true,
    });
  }

  for (const row of actualRows) {
    const existingSeed = rowSeeds.get(row.bowlerId);
    const exactMember = input.members.find((member) => member.bowlerId === row.bowlerId && member.teamId === row.teamId);
    const team = teamById.get(row.teamId);
    if (!team) {
      throw new ManagePaymentsWorksheetProjectionError("missing_historical_team", "A saved responsibility references a team that cannot be resolved");
    }
    const mainBowlerId = sourceResponsibilities
      .filter((source) => source.responsibilityId === row.responsibilityId)
      .map((source) => source.mainBowlerId)
      .find((value) => value !== null) ?? null;
    rowSeeds.set(row.bowlerId, {
      teamId: row.teamId,
      displayName: exactMember?.displayName ?? existingSeed?.displayName ?? input.displayNamesByBowler.get(row.bowlerId) ?? "Former bowler",
      order: exactMember?.order ?? existingSeed?.order ?? Number.MAX_SAFE_INTEGER,
      rosterRole: mainBowlerId === row.bowlerId || input.mainBowlerIdsByTeam.get(row.teamId)?.has(row.bowlerId) === true
        ? "main"
        : "substitute",
      currentMember: exactMember !== undefined || existingSeed?.currentMember === true,
    });
  }
  const responsibilityTeamByBowler = new Map<number, number>();
  const responsibilityRoleByBowler = new Map<number, "main" | "substitute">();
  const recordResponsibilityParticipant = (bowlerId: number | null, teamId: number, role: "main" | "substitute") => {
    if (bowlerId === null) return;
    const existingTeamId = responsibilityTeamByBowler.get(bowlerId);
    if (existingTeamId !== undefined && existingTeamId !== teamId) {
      throw new ManagePaymentsWorksheetProjectionError("duplicate_bowler_row", "A bowler is referenced by responsibility evidence on more than one team for this week");
    }
    responsibilityTeamByBowler.set(bowlerId, teamId);
    const existingRole = responsibilityRoleByBowler.get(bowlerId);
    responsibilityRoleByBowler.set(bowlerId, existingRole === "main" || role === "main" ? "main" : "substitute");
  };
  for (const source of sourceResponsibilities) {
    recordResponsibilityParticipant(source.mainBowlerId, source.teamId, "main");
    recordResponsibilityParticipant(source.substituteBowlerId, source.teamId, "substitute");
    for (const bowlerId of [source.payerBowlerId, source.lineagePayerBowlerId, source.prizePayerBowlerId]) {
      recordResponsibilityParticipant(
        bowlerId,
        source.teamId,
        bowlerId !== null && source.mainBowlerId === bowlerId ? "main" : "substitute",
      );
    }
    const rotating = input.rotatingAssignmentsByResponsibility.get(source.responsibilityId);
    if (rotating) recordResponsibilityParticipant(rotating.bowlerId, rotating.teamId, "substitute");
  }
  for (const [bowlerId, teamId] of responsibilityTeamByBowler) {
    if (actualRows.some((row) => row.bowlerId === bowlerId)) continue;
    const team = teamById.get(teamId);
    if (!team) {
      throw new ManagePaymentsWorksheetProjectionError("missing_historical_team", "A saved responsibility references a team that cannot be resolved");
    }
    const current = rowSeeds.get(bowlerId);
    const exactMember = input.members.find((member) => member.bowlerId === bowlerId && member.teamId === teamId);
    rowSeeds.set(bowlerId, {
      teamId,
      displayName: exactMember?.displayName ?? current?.displayName ?? input.displayNamesByBowler.get(bowlerId) ?? "Former bowler",
      order: exactMember?.order ?? current?.order ?? Number.MAX_SAFE_INTEGER,
      rosterRole: responsibilityRoleByBowler.get(bowlerId)
        ?? (input.mainBowlerIdsByTeam.get(teamId)?.has(bowlerId) === true ? "main" : "substitute"),
      currentMember: exactMember !== undefined || current?.currentMember === true,
    });
  }
  for (const receipt of input.manualReceipts) {
    if (receipt.occurrenceId === selectedOccurrence.occurrenceId) {
      const team = teamById.get(receipt.teamId);
      if (!team) {
        throw new ManagePaymentsWorksheetProjectionError("missing_historical_team", "A saved manual receipt references a team that cannot be resolved");
      }
      const existingSeed = rowSeeds.get(receipt.bowlerId);
      const responsibilityTeamId = responsibilityTeamByBowler.get(receipt.bowlerId);
      if (responsibilityTeamId !== undefined) {
        // Selected-week responsibility history wins over receipt allocation history.
        continue;
      }
      const priorReceiptTeam = manualReceiptTeamByBowler.get(receipt.bowlerId);
      if (priorReceiptTeam !== undefined && priorReceiptTeam !== receipt.teamId) {
        throw new ManagePaymentsWorksheetProjectionError("ambiguous_roster", "A bowler's selected-week receipts resolve to different teams");
      }
      manualReceiptTeamByBowler.set(receipt.bowlerId, receipt.teamId);
      if (existingSeed?.teamId === receipt.teamId) continue;
      if (existingSeed && !existingSeed.currentMember) {
        throw new ManagePaymentsWorksheetProjectionError("ambiguous_roster", "A bowler's selected-week responsibility and receipt history resolve to different teams");
      }
      rowSeeds.set(receipt.bowlerId, {
        teamId: receipt.teamId,
        displayName: existingSeed?.displayName ?? input.displayNamesByBowler.get(receipt.bowlerId) ?? "Former bowler",
        order: existingSeed?.order ?? Number.MAX_SAFE_INTEGER,
        rosterRole: input.historicalRoleByBowler.get(receipt.bowlerId)
          ?? (input.mainBowlerIdsByTeam.get(receipt.teamId)?.has(receipt.bowlerId) === true ? "main" : existingSeed?.rosterRole ?? "substitute"),
        currentMember: existingSeed?.currentMember ?? false,
      });
    }
  }
  const selectedCardReceipts = input.cardReceipts.filter((receipt) =>
    mapCardReceiptCollectionOccurrence(receipt, input.schedule) === selectedOccurrence.occurrenceId,
  );
  for (const receipt of selectedCardReceipts) {
    if (rowSeeds.has(receipt.bowlerId)) continue;
    const member = memberByBowler.get(receipt.bowlerId);
    const teamId = input.historicalTeamByBowler.get(receipt.bowlerId) ?? member?.teamId;
    if (teamId === undefined || !teamById.has(teamId)) {
      throw new ManagePaymentsWorksheetProjectionError("missing_historical_team", "A card receipt owner cannot be resolved to a league team");
    }
    rowSeeds.set(receipt.bowlerId, {
      teamId,
      displayName: member?.displayName ?? input.displayNamesByBowler.get(receipt.bowlerId) ?? "Former bowler",
      order: member?.order ?? Number.MAX_SAFE_INTEGER,
      rosterRole: input.historicalRoleByBowler.get(receipt.bowlerId)
        ?? (input.mainBowlerIdsByTeam.get(teamId)?.has(receipt.bowlerId) === true ? "main" : "substitute"),
      currentMember: member !== undefined,
    });
  }

  const finalPaid = buildFinalPaidByBowler(input);
  const teamRows = new Map<number, Array<{ bowlerId: number; order: number; displayName: string; row: ManagePaymentsSnapshot["teams"][number]["rows"][number]; stateRow: StateFingerprintRow }>>();
  for (const [bowlerId, seed] of rowSeeds) {
    const exact = exactByBowler.get(bowlerId);
    const isDefaultMain = defaults.some((row) => row.bowlerId === bowlerId && row.teamId === seed.teamId);
    const responsible = exact?.teamId === seed.teamId
      ? true
      : exact !== undefined
        ? false
        : isDefaultMain
          ? true
          : useSavedResponsibilities
          ? false
          : !isExplicitlyConfirmed && seed.rosterRole === "main";
    const feeComponent = exact?.teamId === seed.teamId ? exact.feeComponent : "full";
    const defaultResponsibility = defaults.find((row) => row.bowlerId === bowlerId && row.teamId === seed.teamId);
    const feeMinor = exact?.teamId === seed.teamId ? exact.feeMinor : defaultResponsibility?.feeMinor ?? (responsible ? fullFeeMinor : 0);
    const manualReceipts: ManagePaymentsManualReceipt[] = input.manualReceipts
      .filter((receipt) => receipt.bowlerId === bowlerId && receipt.teamId === seed.teamId
        && receipt.occurrenceId === selectedOccurrence.occurrenceId)
      .map(({ bowlerId: _bowlerId, teamId: _teamId, ...receipt }) => receipt)
      .sort((left, right) => left.receiptId.localeCompare(right.receiptId));
    const cardReceiptsForBowler: ManagePaymentsCardReceipt[] = selectedCardReceipts
      .filter((receipt) => receipt.bowlerId === bowlerId)
      .map(({ bowlerId: _bowlerId, explicitCollectionOccurrenceId: _explicit, triggerOccurrenceId: _trigger, recordedAt, receiptNumber, ...receipt }) => ({
        ...receipt,
        recordedAt,
        receiptNumber,
      }))
      .sort((left, right) => left.paymentId - right.paymentId);
    const balanceMinor = input.balances.get(bowlerId)?.netBalanceMinor ?? 0;
    const row = {
      bowlerId,
      displayName: seed.displayName,
      rosterRole: seed.rosterRole,
      responsible,
      feeComponent,
      feeMinor,
      balanceMinor,
      manualReceipts,
      cardReceipts: cardReceiptsForBowler,
      finalTwoWeeksPaid: finalPaid.get(bowlerId) ?? false,
    };
    const stateRow: StateFingerprintRow = {
      teamId: seed.teamId,
      bowlerId,
      responsible,
      feeComponent,
      feeMinor,
      manualReceipts: manualReceipts.map((receipt) => ({
        receiptId: receipt.receiptId,
        paymentId: receipt.paymentId,
        type: receipt.type,
        amountMinor: receipt.amountMinor,
        businessCollectionLocalDate: receipt.businessCollectionLocalDate,
        revision: receipt.revision,
      })),
    };
    teamRows.set(seed.teamId, [
      ...(teamRows.get(seed.teamId) ?? []),
      { bowlerId, order: seed.order, displayName: seed.displayName, row, stateRow },
    ]);
  }

  const stateRows: StateFingerprintRow[] = [];
  const teams: ManagePaymentsTeam[] = input.teams
    .filter((team) => team.active || (teamRows.get(team.teamId)?.length ?? 0) > 0)
    .sort((left, right) => left.displayOrder - right.displayOrder || left.teamId - right.teamId)
    .flatMap((team) => {
      const rows = (teamRows.get(team.teamId) ?? [])
        .sort((left, right) => left.order - right.order || left.displayName.localeCompare(right.displayName) || left.bowlerId - right.bowlerId);
      for (const row of rows) stateRows.push(row.stateRow);
      if (rows.length === 0 && !team.active) return [];
      return [{
        teamId: team.teamId,
        teamName: team.teamName,
        rows: rows.map((entry) => entry.row),
      }];
    });
  const revision = confirmationRevision ?? 0;
  const stateFingerprint = fingerprintManagePaymentsWorksheet({
    occurrenceId: selectedOccurrence.occurrenceId,
    occurrenceRevision: selectedOccurrence.currentRevision,
    billingTermVersion: selectedTerm.version,
    billingTermRevision: selectedTerm.currentRevision,
    feeTerms,
    rows: stateRows,
  });
  const snapshot = {
    contractVersion: MANAGE_PAYMENTS_CONTRACT_VERSION,
    league: {
      leagueId: input.league.id,
      name: input.league.name,
      timeZone: input.league.timeZone,
      feeTerms,
    },
    weekOptions,
    selectedOccurrence: {
      occurrenceId: selectedOccurrence.occurrenceId,
      localDate: selectedOccurrence.authoritativeLocalDate,
      localStartTime: requiredOccurrenceStartTime(selectedOccurrence),
      timeZone: selectedOccurrence.timezone,
    },
    weekConfirmed,
    // Adoption can classify an old period as confirmed for debt reads before
    // staff have explicitly saved the complete worksheet responsibility set.
    needsConfirmation: !isExplicitlyConfirmed,
    revision,
    stateFingerprint,
    teams,
  } satisfies ManagePaymentsSnapshot;
  return snapshot;
}
