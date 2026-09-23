import { render } from "takumi-pdf";
import type { FinancialReadContract, FinancialReadContractV3, FinancialReadRowContract, FinancialReadRowContractV3 } from "../../shared/financial-contract.js";
import type {
  LeagueOccurrenceScheduleOccurrence,
  LeagueOccurrenceScheduleReadContract,
} from "../../shared/league-occurrence-schedule.js";
import { DEFAULT_TIMEZONE } from "../../shared/schema/constants.js";
import type { League } from "../../shared/schema/leagues.js";
import { storage } from "../storage/index.js";
import { loadLeagueOccurrenceSchedule } from "./league-occurrence-schedule.js";
import { readCanonicalDuePastDueV3, readRosterPaymentResponsibility, readRosterPaymentResponsibilityV2 } from "./roster-payment-core.js";

type RosterPaymentResponsibilityRead = Awaited<ReturnType<typeof readRosterPaymentResponsibility>> | Awaited<ReturnType<typeof readRosterPaymentResponsibilityV2>>;
type FinancialReportRead = FinancialReadContract | FinancialReadContractV3;
type FinancialReportRow = FinancialReadRowContract | FinancialReadRowContractV3;

export class TeamEnvelopeReportError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "TeamEnvelopeReportError";
  }
}

export interface TeamEnvelopeReportRow {
  bowlerId: number | null;
  bowlerName: string;
  ownerKind?: "bowler" | "team";
  slotIndex?: number;
  weeklyDueMinor: number;
  ytdDueMinor: number;
  ytdPaidMinor: number;
  remainingCreditMinor: number;
  pastDueMinor: number;
  dueTodayMinor: number;
  finalWeekPaid: boolean;
}

export interface TeamEnvelopeReportTeam {
  teamId: number;
  teamName: string;
  teamNumber: number;
  showFinalWeekPaid: boolean;
  rows: TeamEnvelopeReportRow[];
}

export interface TeamEnvelopeReport {
  contractVersion: "team-envelope-report/1";
  organizationId: number;
  leagueId: number;
  leagueName: string;
  timezone: string;
  generatedAt: string;
  reportLocalDate: string;
  weekLabel: string;
  occurrenceId: string;
  occurrenceLocalDate: string;
  finalOccurrenceId: string;
  finalOccurrenceLocalDate: string;
  finalWeekFeesDueLocalDate: string | null;
  teams: TeamEnvelopeReportTeam[];
}

interface TeamEnvelopeReportInput {
  league: Pick<League, "id" | "name" | "organizationId" | "timezone">;
  schedule: LeagueOccurrenceScheduleReadContract;
  roster: RosterPaymentResponsibilityRead;
  financial: FinancialReportRead;
}

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
});

function localDateForInstant(instant: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  const year = value("year");
  const month = value("month");
  const day = value("day");
  if (!year || !month || !day) {
    throw new TeamEnvelopeReportError("REPORT_DATE_INVALID", "Unable to resolve the report date", 503);
  }
  return `${year}-${month}-${day}`;
}

function billedOccurrences(schedule: LeagueOccurrenceScheduleReadContract): LeagueOccurrenceScheduleOccurrence[] {
  return schedule.occurrences.filter((occurrence) => occurrence.billing?.obligationPolicy === "eligible_bowlers");
}

interface FinalDoublePayEvidence {
  triggerOccurrenceId: string;
  triggerLocalDate: string;
}

function finalDoublePayEvidence(
  schedule: LeagueOccurrenceScheduleReadContract,
  finalOccurrence: LeagueOccurrenceScheduleOccurrence,
): FinalDoublePayEvidence | null {
  const triggerCandidates = schedule.occurrences.flatMap((occurrence) => (
    (occurrence.collectionGroups ?? [])
      .filter((group) => (
        group.kind === "double_pay"
        && group.role === "trigger"
        && group.state === "published"
        && group.pairedOccurrenceId === finalOccurrence.occurrenceId
      ))
      .map((group) => ({ occurrence, group }))
  ));
  const pairedCandidates = (finalOccurrence.collectionGroups ?? [])
    .filter((group) => (
      group.kind === "double_pay"
      && group.role === "paired"
      && group.state === "published"
    ));
  if (triggerCandidates.length > 1 || pairedCandidates.length > 1) {
    throw new TeamEnvelopeReportError(
      "FINAL_WEEK_DOUBLE_PAY_INVALID",
      "Canonical schedule evidence contains multiple double-pay weeks for the final bowling week",
      503,
    );
  }
  const triggerCandidate = triggerCandidates[0];
  const pairedCandidate = pairedCandidates[0];
  let evidence: FinalDoublePayEvidence | null = triggerCandidate
    ? {
      triggerOccurrenceId: triggerCandidate.occurrence.occurrenceId,
      triggerLocalDate: triggerCandidate.occurrence.authoritativeLocalDate,
    }
    : null;
  if (triggerCandidate && triggerCandidate.group.pairedLocalDate !== finalOccurrence.authoritativeLocalDate) {
    throw new TeamEnvelopeReportError(
      "FINAL_WEEK_DOUBLE_PAY_INVALID",
      "Canonical final-week double-pay evidence has an inconsistent paired date",
      503,
    );
  }
  if (pairedCandidate) {
    const triggerOccurrence = schedule.occurrences.find((occurrence) => occurrence.occurrenceId === pairedCandidate.pairedOccurrenceId);
    if (!triggerOccurrence || pairedCandidate.pairedLocalDate !== triggerOccurrence.authoritativeLocalDate) {
      throw new TeamEnvelopeReportError(
        "FINAL_WEEK_DOUBLE_PAY_INVALID",
        "Canonical final-week double-pay evidence has an inconsistent paired date",
        503,
      );
    }
    if (evidence && evidence.triggerOccurrenceId !== triggerOccurrence.occurrenceId) {
      throw new TeamEnvelopeReportError(
        "FINAL_WEEK_DOUBLE_PAY_INVALID",
        "Canonical schedule evidence contains inconsistent double-pay pairing for the final bowling week",
        503,
      );
    }
    evidence = {
      triggerOccurrenceId: triggerOccurrence.occurrenceId,
      triggerLocalDate: triggerOccurrence.authoritativeLocalDate,
    };
  }
  return evidence;
}

function publishedPairedOccurrenceIds(schedule: LeagueOccurrenceScheduleReadContract): Set<string> {
  const pairedOccurrenceIds = new Set<string>();
  for (const occurrence of schedule.occurrences) {
    for (const group of occurrence.collectionGroups ?? []) {
      if (group.kind !== "double_pay" || group.state !== "published") continue;
      if (group.role === "trigger") pairedOccurrenceIds.add(group.pairedOccurrenceId);
      if (group.role === "paired") pairedOccurrenceIds.add(occurrence.occurrenceId);
    }
  }
  return pairedOccurrenceIds;
}

function effectiveAmountMinor(row: FinancialReportRow): number {
  return row.state === "voided" ? 0 : Math.max(0, row.amountMinor - row.waivedMinor);
}

function effectiveBowlerOwnerId(row: FinancialReportRow): number | null {
  if ("owner" in row) return row.owner.kind === "bowler" ? row.owner.bowlerId : null;
  return row.payerBowlerId;
}

function teamOwnedSlotRows(rows: FinancialReportRow[], teamId: number, slotIndex: number): FinancialReadRowContractV3[] {
  return rows.filter((row): row is FinancialReadRowContractV3 => (
    "owner" in row
    && row.owner.kind === "team"
    && row.owner.teamId === teamId
    && row.slotIndex === slotIndex
  ));
}

function envelopeAmounts(
  obligations: FinancialReportRow[],
  occurrencePosition: ReadonlyMap<string, number>,
  selectedOccurrenceId: string,
  selectedPosition: number,
  futurePairedOccurrenceIds: ReadonlySet<string>,
): Pick<TeamEnvelopeReportRow, "weeklyDueMinor" | "ytdDueMinor" | "ytdPaidMinor" | "remainingCreditMinor" | "pastDueMinor" | "dueTodayMinor"> {
  // Canonical occurrence order is authoritative here. Due timestamps can be
  // shared by upfront obligations and do not express the league's week order.
  const selectedRows = obligations.filter((row) => row.occurrenceId === selectedOccurrenceId);
  const priorRows = obligations.filter((row) => {
    const position = occurrencePosition.get(row.occurrenceId);
    return position !== undefined && position < selectedPosition;
  });
  const weeklyDueMinor = selectedRows.reduce((sum, row) => sum + effectiveAmountMinor(row), 0);
  const ytdDueMinor = priorRows.reduce((sum, row) => sum + effectiveAmountMinor(row), 0);
  const ytdPaidMinor = obligations.reduce((sum, row) => sum + Math.max(0, row.allocatedMinor), 0);
  // Allocations applied to a future published paired week stay earmarked for
  // that week. Current and past paired weeks are available in the balance.
  const futurePairedReservedMinor = obligations
    .filter((row) => futurePairedOccurrenceIds.has(row.occurrenceId))
    .reduce((sum, row) => sum + Math.max(0, row.allocatedMinor), 0);
  const remainingCreditMinor = Math.max(0, ytdPaidMinor - futurePairedReservedMinor - ytdDueMinor);
  const pastDueMinor = priorRows.reduce((sum, row) => sum + Math.max(0, row.outstandingMinor), 0);
  const dueTodayMinor = pastDueMinor + selectedRows.reduce((sum, row) => sum + Math.max(0, row.outstandingMinor), 0);
  return {
    weeklyDueMinor,
    ytdDueMinor,
    ytdPaidMinor,
    remainingCreditMinor,
    pastDueMinor,
    dueTodayMinor,
  };
}

export function buildTeamEnvelopeReport(input: TeamEnvelopeReportInput): TeamEnvelopeReport {
  const { league, schedule, roster, financial } = input;
  if (league.organizationId === null
    || schedule.organizationId !== league.organizationId
    || roster.organizationId !== league.organizationId
    || financial.organizationId !== league.organizationId
    || schedule.leagueId !== league.id
    || roster.leagueId !== league.id
    || financial.leagueId !== league.id) {
    throw new TeamEnvelopeReportError("REPORT_SCOPE_INVALID", "The report evidence does not share one authorized league scope", 503);
  }
  if (!roster.ready) {
    throw new TeamEnvelopeReportError(
      "ROSTER_INCOMPLETE",
      "Complete every active team's paying lineup before creating envelope slips",
      409,
    );
  }

  const occurrences = billedOccurrences(schedule);
  if (occurrences.length === 0) {
    throw new TeamEnvelopeReportError("BILLING_SCHEDULE_EMPTY", "The league has no billable bowling weeks", 409);
  }

  const timezone = league.timezone ?? DEFAULT_TIMEZONE;
  const reportLocalDate = localDateForInstant(financial.asOf, timezone);
  const selectedOccurrence = occurrences.find((occurrence) => occurrence.authoritativeLocalDate >= reportLocalDate)
    ?? occurrences[occurrences.length - 1];
  const finalOccurrence = occurrences[occurrences.length - 1];
  const finalDoublePay = finalDoublePayEvidence(schedule, finalOccurrence);
  const finalWeekFeesDueLocalDate = finalDoublePay?.triggerLocalDate ?? null;
  const occurrencePosition = new Map(occurrences.map((occurrence, index) => [occurrence.occurrenceId, index]));
  const selectedPosition = occurrencePosition.get(selectedOccurrence.occurrenceId);
  if (selectedPosition === undefined || occurrencePosition.get(finalOccurrence.occurrenceId) === undefined) {
    throw new TeamEnvelopeReportError("REPORT_DATE_INVALID", "The selected bowling week has invalid canonical order evidence", 503);
  }
  const futurePairedOccurrenceIds = new Set(
    [...publishedPairedOccurrenceIds(schedule)].filter((occurrenceId) => {
      const position = occurrencePosition.get(occurrenceId);
      return position !== undefined && position > selectedPosition;
    }),
  );

  const bowlerNames = new Map(roster.substituteBowlerOptions.map((bowler) => [bowler.id, bowler.name]));
  const mainBowlerIds = new Set(
    roster.teams.flatMap((team) => team.slots.flatMap((slot) => slot.occupant === "main" && slot.mainBowlerId !== null ? [slot.mainBowlerId] : [])),
  );
  const currentRotatingSlots = roster.teams.flatMap((team) => (
    "eligibleRotatingBowlerIds" in team
      ? team.slots.filter((slot) => slot.occupant === "rotating").map((slot) => ({ teamId: team.id, slotIndex: slot.slotIndex }))
      : []
  ));
  if (financial.rows.some((row) => {
    if (!row.reviewRequired) return false;
    const ownerBowlerId = effectiveBowlerOwnerId(row);
    if (ownerBowlerId !== null && mainBowlerIds.has(ownerBowlerId)) return true;
    if (!("owner" in row) || row.owner.kind !== "team") return false;
    const ownerTeamId = row.owner.teamId;
    return currentRotatingSlots.some((slot) => slot.teamId === ownerTeamId && slot.slotIndex === row.slotIndex);
  })) {
    throw new TeamEnvelopeReportError(
      "FINANCIAL_REVIEW_REQUIRED",
      "Resolve payment or refund review items for the active lineup before creating envelope slips",
      409,
    );
  }

  const teams = roster.teams.map<TeamEnvelopeReportTeam>((team) => {
    const rows = team.slots.flatMap<TeamEnvelopeReportRow>((slot) => {
      if (slot.occupant === "main" && slot.mainBowlerId !== null) {
        const bowlerName = bowlerNames.get(slot.mainBowlerId);
        if (!bowlerName) {
          throw new TeamEnvelopeReportError("ROSTER_IDENTITY_MISSING", "An active lineup member is missing a bowler identity", 503);
        }
        const obligations = financial.rows.filter((row) => effectiveBowlerOwnerId(row) === slot.mainBowlerId && row.state !== "voided");
        const finalRows = obligations.filter((row) => row.occurrenceId === finalOccurrence.occurrenceId);
        const amounts = envelopeAmounts(
          obligations,
          occurrencePosition,
          selectedOccurrence.occurrenceId,
          selectedPosition,
          futurePairedOccurrenceIds,
        );
        return [{
          bowlerId: slot.mainBowlerId,
          bowlerName,
          ...amounts,
          finalWeekPaid: finalRows.every((row) => row.outstandingMinor === 0),
        }];
      }
      if (slot.occupant === "rotating") {
        const obligations = teamOwnedSlotRows(financial.rows, team.id, slot.slotIndex).filter((row) => row.state !== "voided");
        const selectedRows = obligations.filter((row) => row.occurrenceId === selectedOccurrence.occurrenceId);
        const finalRows = obligations.filter((row) => row.occurrenceId === finalOccurrence.occurrenceId);
        const amounts = envelopeAmounts(
          obligations,
          occurrencePosition,
          selectedOccurrence.occurrenceId,
          selectedPosition,
          futurePairedOccurrenceIds,
        );
        const actualBowlerId = selectedRows.find((row) => row.actualBowlerId !== null)?.actualBowlerId ?? null;
        const actualBowlerName = actualBowlerId === null ? null : bowlerNames.get(actualBowlerId);
        if (actualBowlerId !== null && !actualBowlerName) {
          throw new TeamEnvelopeReportError("ROSTER_IDENTITY_MISSING", "A confirmed rotating participant is missing a bowler identity", 503);
        }
        return [{
          bowlerId: null,
          bowlerName: actualBowlerName ? `Rotating slot ${slot.slotIndex + 1} · ${actualBowlerName}` : `Rotating slot ${slot.slotIndex + 1}`,
          ownerKind: "team",
          slotIndex: slot.slotIndex,
          ...amounts,
          finalWeekPaid: finalRows.length > 0 && finalRows.every((row) => row.outstandingMinor === 0),
        }];
      }
      return [];
    });
    return {
      teamId: team.id,
      teamName: team.name,
      teamNumber: team.number,
      showFinalWeekPaid: rows.some((row) => !row.finalWeekPaid),
      rows,
    };
  });
  if (teams.some((team) => team.showFinalWeekPaid) && finalWeekFeesDueLocalDate === null) {
    throw new TeamEnvelopeReportError(
      "FINAL_WEEK_DOUBLE_PAY_MISSING",
      "Configure a published double-pay week paired with the final bowling week before creating envelope slips",
      409,
    );
  }

  const weekNumber = selectedOccurrence.billing?.billingOrdinal
    ?? selectedOccurrence.plannedOrdinal
    ?? occurrences.indexOf(selectedOccurrence) + 1;
  return {
    contractVersion: "team-envelope-report/1",
    organizationId: league.organizationId,
    leagueId: league.id,
    leagueName: league.name,
    timezone,
    generatedAt: financial.asOf,
    reportLocalDate,
    weekLabel: String(weekNumber),
    occurrenceId: selectedOccurrence.occurrenceId,
    occurrenceLocalDate: selectedOccurrence.authoritativeLocalDate,
    finalOccurrenceId: finalOccurrence.occurrenceId,
    finalOccurrenceLocalDate: finalOccurrence.authoritativeLocalDate,
    finalWeekFeesDueLocalDate,
    teams,
  };
}

export async function readTeamEnvelopeReport(input: { organizationId: number; leagueId: number }): Promise<TeamEnvelopeReport> {
  const league = await storage.getLeague(input.leagueId);
  if (!league || league.organizationId !== input.organizationId) {
    throw new TeamEnvelopeReportError("NOT_FOUND", "League not found", 404);
  }
  const [schedule, roster, financial] = await Promise.all([
    loadLeagueOccurrenceSchedule({ ...input, includeAdministratorEvidence: false }),
    readRosterPaymentResponsibilityV2(input),
    readCanonicalDuePastDueV3(input),
  ]);
  return buildTeamEnvelopeReport({ league, schedule, roster, financial });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function displayDate(localDate: string): string {
  const [year, month, day] = localDate.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month - 1, day)));
}

function money(amountMinor: number): string {
  return currencyFormatter.format(amountMinor / 100);
}

function pdfCreationDate(instant: string): string {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) {
    throw new TeamEnvelopeReportError("REPORT_DATE_INVALID", "Unable to resolve the report date", 503);
  }
  return date.toISOString().slice(0, 19);
}

function teamPage(report: TeamEnvelopeReport, team: TeamEnvelopeReportTeam, index: number): string {
  const body = team.rows.length > 0
    ? team.rows.map((row) => `<tr>
        <td class="bowler">${escapeHtml(row.bowlerName)}</td>
        <td>${money(row.ytdDueMinor)}</td>
        <td>${money(row.ytdPaidMinor)}</td>
        <td>${money(row.remainingCreditMinor)}</td>
        <td>${money(row.weeklyDueMinor)}</td>
        <td>${money(row.pastDueMinor)}</td>
        <td class="due">${money(row.dueTodayMinor)}</td>
        <td class="paid-today"><span class="write-line">&nbsp;</span></td>
      </tr>`).join("")
    : `<tr><td class="empty" colspan="8">No assigned bowlers</td></tr>`;
  const finalNote = team.showFinalWeekPaid && report.finalWeekFeesDueLocalDate
    ? `<p class="note">Final Week&#39;s Fees due by ${escapeHtml(displayDate(report.finalWeekFeesDueLocalDate))}</p>`
    : "";
  return `<section class="page"${index > 0 ? " style=\"break-before: page;\"" : ""}>
    <article class="slip">
      <header>
        <div>
          <h1>Team ${team.teamNumber} - ${escapeHtml(team.teamName)}</h1>
          <p>${escapeHtml(report.leagueName)}</p>
        </div>
        <div class="week">
          <strong>Fees Due Week ${escapeHtml(report.weekLabel)}</strong>
          <span>${escapeHtml(displayDate(report.occurrenceLocalDate))}</span>
        </div>
      </header>
      <table>
        <thead><tr>
          <th class="bowler"></th>
          <th><span class="heading-label">YTD Due</span></th>
          <th><span class="heading-label">YTD Paid</span></th>
          <th><span class="heading-label">Remaining Credit</span></th>
          <th><span class="heading-label">Weekly Due</span></th>
          <th><span class="heading-label">Past Due</span></th>
          <th><span class="heading-label">Due Today</span></th>
          <th><span class="heading-label">Paid Today</span></th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
      ${finalNote}
    </article>
  </section>`;
}

const pdfCss = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; color: #111827; font-family: sans-serif; }
  .page { width: 816px; }
  .slip { padding: 36px 38px 0; }
  header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 22px; }
  h1 { margin: 0 0 5px; font-size: 23px; line-height: 1.2; }
  header p { margin: 0; font-size: 13px; color: #4b5563; }
  .week { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; font-size: 13px; }
  .week strong { font-size: 16px; }
  .week span { color: #4b5563; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { border: 0; text-align: center; vertical-align: middle; }
  th { padding: 0 5px 7px; font-size: 11px; line-height: 1.15; font-weight: 700; }
  td { padding: 4px 5px; font-size: 13px; }
  .heading-label { display: block; min-height: 31px; padding: 0 2px 5px; border-bottom: 2px solid #000; }
  th.bowler { width: 22%; }
  .bowler { text-align: left; }
  td.bowler { font-weight: 400; }
  .due { font-weight: 400; }
  .write-line { display: block; width: 82%; height: 15px; margin: 0 auto; border-bottom: 1px solid #000; }
  .empty { height: 52px; color: #4b5563; font-style: italic; }
  .note { margin: 12px 0 0; font-size: 10px; color: #4b5563; }
`;

export async function renderTeamEnvelopePdf(report: TeamEnvelopeReport): Promise<Uint8Array> {
  if (report.teams.length === 0) {
    throw new TeamEnvelopeReportError("ACTIVE_TEAMS_EMPTY", "The league has no active teams to print", 409);
  }
  const html = `<main>${report.teams.map((team, index) => teamPage(report, team, index)).join("")}</main>`;
  return render(html, {
    size: "letter",
    margin: 0,
    css: pdfCss,
    lang: "en-US",
    tagged: true,
    metadata: {
      title: `${report.leagueName} team envelope slips - week ${report.weekLabel}`,
      description: "Weekly team payment envelope slips generated by LeagueVault",
      creator: "LeagueVault",
      creationDate: pdfCreationDate(report.generatedAt),
    },
  });
}

export function teamEnvelopeFilename(report: TeamEnvelopeReport): string {
  const league = report.leagueName
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || `league-${report.leagueId}`;
  return `${league}-week-${report.weekLabel}-team-envelope-slips.pdf`;
}
