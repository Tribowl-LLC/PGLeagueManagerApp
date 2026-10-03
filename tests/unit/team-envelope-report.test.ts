import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { FinancialReadAccountProjectionRow, FinancialReadRowContract, FinancialReadRowContractV3 } from "../../shared/financial-contract";
import type { LeagueOccurrenceScheduleOccurrence } from "../../shared/league-occurrence-schedule";

vi.mock("../../server/storage/index.js", () => ({ storage: { getLeague: vi.fn() } }));
vi.mock("../../server/services/league-occurrence-schedule.js", () => ({ loadLeagueOccurrenceSchedule: vi.fn() }));
vi.mock("../../server/db.js", () => ({ db: { select: vi.fn() } }));
vi.mock("../../server/services/roster-payment-core.js", () => ({
  readCanonicalDuePastDue: vi.fn(),
  readCanonicalDuePastDueV3: vi.fn(),
  readRosterPaymentResponsibility: vi.fn(),
  readRosterPaymentResponsibilityV2: vi.fn(),
}));

import { db } from "../../server/db.js";
import { loadLeagueOccurrenceSchedule } from "../../server/services/league-occurrence-schedule.js";
import { readCanonicalDuePastDueV3, readRosterPaymentResponsibilityV2 } from "../../server/services/roster-payment-core.js";
import { storage } from "../../server/storage/index.js";

import {
  buildTeamEnvelopeReport,
  readTeamEnvelopeReport,
  renderTeamEnvelopePdf,
  TeamEnvelopeReportError,
} from "../../server/services/team-envelope-report";

type BuildInput = Parameters<typeof buildTeamEnvelopeReport>[0];

function occurrence(id: string, localDate: string, ordinal: number): LeagueOccurrenceScheduleOccurrence {
  return {
    occurrenceId: id,
    identitySource: "canonical_uuid",
    kind: "regular",
    status: "scheduled",
    lifecycle: "published",
    authoritativeLocalDate: localDate,
    authoritativeLocalStartTime: "18:30:00",
    timezone: "America/New_York",
    startAt: `${localDate}T22:30:00.000Z`,
    selectedUtcOffsetMinutes: -240,
    foldResolution: "unambiguous",
    resolverVersion: "test/1",
    plannedOrdinal: ordinal,
    competitionNumber: ordinal,
    competitive: true,
    countsInStandings: true,
    currentRevision: 1,
    effectivelyLocked: false,
    effectiveLockReasons: [],
    billing: {
      purpose: "league_weekly_fee",
      obligationPolicy: "eligible_bowlers",
      billingOrdinal: ordinal,
      version: 1,
      currentRevision: 1,
    },
    relationships: [],
  };
}

function financialRow(
  bowlerId: number,
  occurrenceId: string,
  dueAt: string,
  allocatedMinor: number,
  teamId: number,
  amountMinor = 2_000,
): FinancialReadRowContract {
  const outstandingMinor = amountMinor - allocatedMinor;
  return {
    id: `obligation-${bowlerId}-${occurrenceId}`,
    organizationId: 11,
    leagueId: 7,
    occurrenceId,
    responsibilityId: `responsibility-${bowlerId}-${occurrenceId}`,
    teamId,
    component: "full",
    payerBowlerId: bowlerId,
    amountMinor,
    currency: "USD",
    dueAt,
    pastDueAt: dueAt,
    state: outstandingMinor === 0 ? "settled" : "open",
    allocatedMinor,
    grossAllocatedMinor: allocatedMinor,
    refundedMinor: 0,
    waivedMinor: 0,
    stillOwed: outstandingMinor > 0,
    outstandingMinor,
    classification: outstandingMinor === 0 ? "settled" : "due",
    reviewRequired: false,
  };
}

function weekThreeFourSeventyDollarInput(): BuildInput {
  const input = reportInput();
  const occurrences = [
    occurrence("week-1", "2026-09-09", 1),
    occurrence("week-2", "2026-09-16", 2),
    occurrence("week-3", "2026-09-23", 3),
    occurrence("week-4", "2026-09-30", 4),
    occurrence("week-5", "2026-10-07", 5),
  ];
  occurrences[3].collectionGroups = [{
    groupId: "double-pay-4",
    groupOrdinal: 1,
    kind: "double_pay",
    role: "trigger",
    pairedOccurrenceId: "week-5",
    pairedLocalDate: "2026-10-07",
    state: "published",
    currentRevision: 1,
  }];
  occurrences[4].collectionGroups = [{
    groupId: "double-pay-4",
    groupOrdinal: 1,
    kind: "double_pay",
    role: "paired",
    pairedOccurrenceId: "week-4",
    pairedLocalDate: "2026-09-30",
    state: "published",
    currentRevision: 1,
  }];
  const dueAt = occurrences.map((item) => `${item.authoritativeLocalDate}T22:30:00.000Z`);
  const allocations = [2_000, 2_000, 2_000, 1_000, 0];
  const rows = occurrences.map((item, index) => financialRow(101, item.occurrenceId, dueAt[index], allocations[index], 10, 2_000));
  input.schedule.occurrences = occurrences;
  input.roster.occurrences = occurrences.map((item) => ({ id: item.occurrenceId, startAt: item.startAt, status: item.status }));
  input.financial.asOf = "2026-09-23T16:00:00.000Z";
  input.financial.rows = rows;
  input.financial.totals = {
    amountMinor: rows.reduce((sum, row) => sum + row.amountMinor, 0),
    allocatedMinor: rows.reduce((sum, row) => sum + row.allocatedMinor, 0),
    outstandingMinor: rows.reduce((sum, row) => sum + row.outstandingMinor, 0),
    collectiblePastDueMinor: 0,
    reviewCount: 0,
    settledCount: rows.filter((row) => row.state === "settled").length,
    voidedCount: 0,
  };
  return input;
}

function futureFinalPartialPaymentInput(): BuildInput {
  const input = reportInput();
  const localDates = ["2026-09-09", "2026-09-16", "2026-09-23", "2026-09-30", "2026-10-07", "2026-10-14"];
  const occurrences = localDates.map((localDate, index) => occurrence(`week-${index + 1}`, localDate, index + 1));
  occurrences[4].collectionGroups = [{
    groupId: "double-pay-5",
    groupOrdinal: 1,
    kind: "double_pay",
    role: "trigger",
    pairedOccurrenceId: "week-6",
    pairedLocalDate: occurrences[5].authoritativeLocalDate,
    state: "published",
    currentRevision: 1,
  }];
  occurrences[5].collectionGroups = [{
    groupId: "double-pay-5",
    groupOrdinal: 1,
    kind: "double_pay",
    role: "paired",
    pairedOccurrenceId: "week-5",
    pairedLocalDate: occurrences[4].authoritativeLocalDate,
    state: "published",
    currentRevision: 1,
  }];
  const dueAt = occurrences.map((item) => `${item.authoritativeLocalDate}T22:30:00.000Z`);
  const allocations = [2_000, 2_000, 2_000, 2_000, 0, 2_000];
  const rows = occurrences.map((item, index) => financialRow(101, item.occurrenceId, dueAt[index], allocations[index], 10, 2_000));
  input.schedule.occurrences = occurrences;
  input.roster.occurrences = occurrences.map((item) => ({ id: item.occurrenceId, startAt: item.startAt, status: item.status }));
  input.financial.asOf = "2026-10-02T16:00:00.000Z";
  input.financial.rows = rows;
  input.financial.totals = {
    amountMinor: rows.reduce((sum, row) => sum + row.amountMinor, 0),
    allocatedMinor: rows.reduce((sum, row) => sum + row.allocatedMinor, 0),
    outstandingMinor: rows.reduce((sum, row) => sum + row.outstandingMinor, 0),
    collectiblePastDueMinor: 0,
    reviewCount: 0,
    settledCount: rows.filter((row) => row.state === "settled").length,
    voidedCount: 0,
  };
  return input;
}

function twoFuturePairedWeeksInput(): BuildInput {
  const input = reportInput();
  const localDates = ["2026-09-09", "2026-09-16", "2026-09-23", "2026-09-30", "2026-10-07", "2026-10-14", "2026-10-21"];
  const occurrences = localDates.map((localDate, index) => occurrence(`week-${index + 1}`, localDate, index + 1));
  const groups = [
    { groupId: "double-pay-4-6", triggerIndex: 3, pairedIndex: 5 },
    { groupId: "double-pay-5-7", triggerIndex: 4, pairedIndex: 6 },
  ];
  for (const group of groups) {
    occurrences[group.triggerIndex].collectionGroups = [{
      groupId: group.groupId,
      groupOrdinal: 1,
      kind: "double_pay",
      role: "trigger",
      pairedOccurrenceId: occurrences[group.pairedIndex].occurrenceId,
      pairedLocalDate: occurrences[group.pairedIndex].authoritativeLocalDate,
      state: "published",
      currentRevision: 1,
    }];
    occurrences[group.pairedIndex].collectionGroups = [{
      groupId: group.groupId,
      groupOrdinal: 1,
      kind: "double_pay",
      role: "paired",
      pairedOccurrenceId: occurrences[group.triggerIndex].occurrenceId,
      pairedLocalDate: occurrences[group.triggerIndex].authoritativeLocalDate,
      state: "published",
      currentRevision: 1,
    }];
  }
  const dueAt = occurrences.map((item) => `${item.authoritativeLocalDate}T22:30:00.000Z`);
  const allocations = [2_000, 2_000, 2_000, 2_000, 0, 2_000, 2_000];
  const rows = occurrences.map((item, index) => financialRow(101, item.occurrenceId, dueAt[index], allocations[index], 10, 2_000));
  input.schedule.occurrences = occurrences;
  input.roster.occurrences = occurrences.map((item) => ({ id: item.occurrenceId, startAt: item.startAt, status: item.status }));
  input.financial.asOf = "2026-10-07T16:00:00.000Z";
  input.financial.rows = rows;
  input.financial.totals = {
    amountMinor: rows.reduce((sum, row) => sum + row.amountMinor, 0),
    allocatedMinor: rows.reduce((sum, row) => sum + row.allocatedMinor, 0),
    outstandingMinor: rows.reduce((sum, row) => sum + row.outstandingMinor, 0),
    collectiblePastDueMinor: 0,
    reviewCount: 0,
    settledCount: rows.filter((row) => row.state === "settled").length,
    voidedCount: 0,
  };
  return input;
}

function reportInput(): BuildInput {
  const occurrences = [
    occurrence("week-1", "2026-09-09", 1),
    occurrence("week-2", "2026-09-16", 2),
    occurrence("week-3", "2026-09-23", 3),
  ];
  occurrences[1].collectionGroups = [{
    groupId: "double-pay-1",
    groupOrdinal: 1,
    kind: "double_pay",
    role: "trigger",
    pairedOccurrenceId: "week-3",
    pairedLocalDate: "2026-09-23",
    state: "published",
    currentRevision: 1,
  }];
  occurrences[2].collectionGroups = [{
    groupId: "double-pay-1",
    groupOrdinal: 1,
    kind: "double_pay",
    role: "paired",
    pairedOccurrenceId: "week-2",
    pairedLocalDate: "2026-09-16",
    state: "published",
    currentRevision: 1,
  }];
  const dueAt = ["2026-09-09T22:30:00.000Z", "2026-09-16T22:30:00.000Z", "2026-09-23T22:30:00.000Z"];
  const rows = [
    ...occurrences.map((item, index) => financialRow(101, item.occurrenceId, dueAt[index], 0, 10)),
    ...occurrences.map((item, index) => financialRow(102, item.occurrenceId, dueAt[index], 2_000, 10)),
    ...occurrences.map((item, index) => financialRow(201, item.occurrenceId, dueAt[index], 2_000, 20)),
  ];
  return {
    league: { id: 7, name: "Wednesday Ladies", organizationId: 11, timezone: "America/New_York" },
    schedule: {
      contractVersion: "league-occurrence-schedule/3",
      ordering: {
        version: "league-occurrence-schedule-order/1",
        keys: ["authoritativeLocalDate", "authoritativeLocalStartTime", "plannedOrdinal", "competitionNumber", "kind", "stableIdentity"],
      },
      organizationId: 11,
      leagueId: 7,
      authoritativeSource: "canonical",
      occurrences,
      skippedDates: [],
      administrator: null,
    },
    roster: {
      contractVersion: "roster-payment-responsibility/1",
      organizationId: 11,
      leagueId: 7,
      payingLineupSize: 2,
      weeklyFee: 2_000,
      lineageFee: null,
      prizeFundFee: null,
      substituteAccess: "team_only",
      substitutePaymentRegime: "team_choice",
      ready: true,
      incompleteTeamIds: [],
      occurrences: occurrences.map((item) => ({ id: item.occurrenceId, startAt: item.startAt, status: item.status })),
      occurrenceResponsibilities: [],
      substituteBowlerOptions: [
        { id: 101, name: "Jillian Example", teamId: 10 },
        { id: 102, name: "Laurie Example", teamId: 10 },
        { id: 201, name: "Morgan Example", teamId: 20 },
      ],
      teams: [
        {
          id: 10,
          name: "Alley Cats",
          number: 1,
          policy: "main_pays_full",
          slots: [
            { teamId: 10, slotIndex: 0, occupant: "main", mainBowlerId: 101 },
            { teamId: 10, slotIndex: 1, occupant: "main", mainBowlerId: 102 },
          ],
        },
        {
          id: 20,
          name: "Pin Pals",
          number: 2,
          policy: "main_pays_full",
          slots: [
            { teamId: 20, slotIndex: 0, occupant: "main", mainBowlerId: 201 },
            { teamId: 20, slotIndex: 1, occupant: "vacant", mainBowlerId: null },
          ],
        },
      ],
    },
    financial: {
      contractVersion: "canonical-due-past-due/2",
      orderVersion: "due-at,payer,occurrence,obligation/2",
      organizationId: 11,
      leagueId: 7,
      authoritativeSource: "payment_obligations",
      asOf: "2026-09-16T16:00:00.000Z",
      rows,
      totals: {
        amountMinor: rows.reduce((sum, row) => sum + row.amountMinor, 0),
        allocatedMinor: rows.reduce((sum, row) => sum + row.allocatedMinor, 0),
        outstandingMinor: rows.reduce((sum, row) => sum + row.outstandingMinor, 0),
        collectiblePastDueMinor: 0,
        reviewCount: 0,
        settledCount: rows.filter((row) => row.state === "settled").length,
        voidedCount: 0,
      },
    },
  };
}

interface AdoptedRowOptions {
  amountMinor: number;
  allocatedMinor?: number;
  outstandingMinor?: number;
  waivedMinor?: number;
  projectedCreditMinor?: number;
  confirmationStatus: "confirmed" | "forecast";
  classification?: FinancialReadRowContract["classification"];
}

function adoptedRow(
  sourceBowlerId: number,
  effectiveDebtorBowlerId: number,
  occurrenceId: string,
  options: AdoptedRowOptions,
): FinancialReadRowContractV3 {
  const input = reportInput();
  const occurrenceIndex = input.schedule.occurrences.findIndex((item) => item.occurrenceId === occurrenceId);
  const week = input.schedule.occurrences[occurrenceIndex];
  if (!week) throw new Error(`missing adopted fixture occurrence ${occurrenceId}`);
  const allocatedMinor = options.allocatedMinor ?? 0;
  const outstandingMinor = options.outstandingMinor ?? options.amountMinor - allocatedMinor;
  const waivedMinor = options.waivedMinor ?? 0;
  const state = outstandingMinor <= 0 ? "settled" : allocatedMinor > 0 ? "partially_settled" : "open";
  const base = financialRow(
    sourceBowlerId,
    occurrenceId,
    `${week.authoritativeLocalDate}T22:30:00.000Z`,
    allocatedMinor,
    10,
    options.amountMinor,
  );
  return {
    ...base,
    state,
    grossAllocatedMinor: allocatedMinor,
    waivedMinor,
    stillOwed: outstandingMinor > 0,
    outstandingMinor,
    classification: options.classification ?? (week.authoritativeLocalDate < "2026-09-16" ? "past_due" : week.authoritativeLocalDate === "2026-09-16" ? "due" : "future"),
    owner: { kind: "bowler", bowlerId: sourceBowlerId },
    slotIndex: null,
    responsibilityKind: "substitute",
    actualBowlerId: null,
    occurrenceLocalDate: week.authoritativeLocalDate,
    plannedOrdinal: week.plannedOrdinal ?? occurrenceIndex + 1,
    billingOrdinal: week.billing?.billingOrdinal ?? week.plannedOrdinal ?? occurrenceIndex + 1,
    accountProjection: {
      owner: { kind: "bowler", bowlerId: sourceBowlerId },
      effectiveDebtorBowlerId,
      confirmationStatus: options.confirmationStatus,
      projectedCreditMinor: options.projectedCreditMinor ?? 0,
    },
  };
}

function adoptedEnvelopeInput(): BuildInput {
  const input = reportInput();
  input.roster.ready = false;
  input.roster.incompleteTeamIds = [10];
  input.roster.teams[0].slots = [
    { teamId: 10, slotIndex: 0, occupant: "unassigned", mainBowlerId: null },
    { teamId: 10, slotIndex: 1, occupant: "vacant", mainBowlerId: null },
  ];
  input.roster.substituteBowlerOptions.push(
    { id: 103, name: "Sam Substitute", teamId: 10 },
    { id: 104, name: "Avery Credit", teamId: 10 },
    { id: 105, name: "Riley Partial Waiver", teamId: 10 },
    { id: 106, name: "Casey Waived Only", teamId: 10 },
    { id: 107, name: "Taylor Rotation", teamId: 20 },
  );
  const rotatingTeam = input.roster.teams.find((team) => team.id === 20);
  if (!rotatingTeam || !rotatingTeam.slots[0]) throw new Error("missing rotating team fixture");
  rotatingTeam.slots[0] = { teamId: 20, slotIndex: 0, occupant: "rotating", mainBowlerId: null };
  Object.assign(rotatingTeam, { eligibleRotatingBowlerIds: [107] });
  const rows = [
    adoptedRow(101, 103, "week-1", {
      amountMinor: 1_000,
      outstandingMinor: 1_000,
      projectedCreditMinor: 1_000,
      confirmationStatus: "confirmed",
      classification: "past_due",
    }),
    adoptedRow(101, 103, "week-2", {
      amountMinor: 2_000,
      projectedCreditMinor: 500,
      confirmationStatus: "forecast",
      classification: "due",
    }),
    adoptedRow(101, 103, "week-3", {
      amountMinor: 2_000,
      confirmationStatus: "forecast",
    }),
    adoptedRow(104, 104, "week-2", {
      amountMinor: 2_000,
      projectedCreditMinor: 2_000,
      confirmationStatus: "forecast",
      classification: "due",
    }),
    adoptedRow(104, 104, "week-3", {
      amountMinor: 2_000,
      projectedCreditMinor: 2_000,
      confirmationStatus: "forecast",
    }),
    adoptedRow(105, 105, "week-3", {
      amountMinor: 2_000,
      allocatedMinor: 1_000,
      outstandingMinor: 0,
      waivedMinor: 1_000,
      confirmationStatus: "confirmed",
    }),
    adoptedRow(106, 106, "week-3", {
      amountMinor: 2_000,
      outstandingMinor: 0,
      waivedMinor: 2_000,
      confirmationStatus: "confirmed",
    }),
  ];
  const rotatingRow = adoptedRow(107, 107, "week-2", {
    amountMinor: 2_000,
    projectedCreditMinor: 1_000,
    confirmationStatus: "forecast",
    classification: "due",
  });
  rows.push({
    ...rotatingRow,
    teamId: 20,
    payerBowlerId: null,
    owner: { kind: "team", teamId: 20 },
    slotIndex: 0,
    responsibilityKind: "rotating",
    actualBowlerId: 107,
    accountProjection: {
      owner: { kind: "team", teamId: 20 },
      effectiveDebtorBowlerId: 107,
      confirmationStatus: "forecast",
      projectedCreditMinor: 1_000,
    },
  });
  const unassignedTeamRow = adoptedRow(108, 108, "week-3", {
    amountMinor: 2_000,
    confirmationStatus: "forecast",
  });
  rows.push({
    ...unassignedTeamRow,
    teamId: 20,
    payerBowlerId: null,
    owner: { kind: "team", teamId: 20 },
    slotIndex: 1,
    responsibilityKind: "rotating",
    actualBowlerId: null,
    accountProjection: {
      owner: { kind: "team", teamId: 20 },
      effectiveDebtorBowlerId: null,
      confirmationStatus: "forecast",
      projectedCreditMinor: 0,
    },
  });
  const account = (bowlerId: number, amountPaidMinor: number, availableCreditMinor: number, confirmedDebtMinor: number, seasonRemainingMinor: number): FinancialReadAccountProjectionRow => ({
    bowlerId,
    amountPaidMinor,
    availableCreditMinor,
    confirmedDebtMinor,
    netBalanceMinor: availableCreditMinor - confirmedDebtMinor,
    confirmedPastDueMinor: 0,
    seasonRemainingMinor,
    reviewRequired: false,
  });
  input.financial = {
    contractVersion: "canonical-due-past-due/3",
    orderVersion: "due-at,owner,occurrence,obligation/3",
    organizationId: 11,
    leagueId: 7,
    authoritativeSource: "payment_obligations",
    asOf: "2026-09-16T16:00:00.000Z",
    rows,
    totals: {
      amountMinor: rows.reduce((sum, row) => sum + row.amountMinor, 0),
      allocatedMinor: rows.reduce((sum, row) => sum + row.allocatedMinor, 0),
      outstandingMinor: rows.reduce((sum, row) => sum + row.outstandingMinor, 0),
      collectiblePastDueMinor: 0,
      reviewCount: 0,
      settledCount: rows.filter((row) => row.state === "settled").length,
      voidedCount: 0,
    },
    accountProjection: {
      contractVersion: "owned-account-projection/1",
      accounts: [
        account(103, 1_500, 1_500, 1_000, 1_500),
        account(104, 5_000, 5_000, 0, 0),
        account(105, 1_000, 0, 0, 0),
        account(106, 0, 0, 0, 0),
        account(107, 1_000, 1_000, 0, 1_000),
      ],
    },
  };
  return input;
}

describe("team envelope report", () => {
  it("resolves a historical account holder name in one organization-scoped batch", async () => {
    const input = adoptedEnvelopeInput();
    input.roster.substituteBowlerOptions = input.roster.substituteBowlerOptions.filter((bowler) => bowler.id !== 103);
    vi.mocked(storage.getLeague).mockResolvedValue(input.league as never);
    vi.mocked(loadLeagueOccurrenceSchedule).mockResolvedValue(input.schedule);
    vi.mocked(readRosterPaymentResponsibilityV2).mockResolvedValue(input.roster as never);
    vi.mocked(readCanonicalDuePastDueV3).mockResolvedValue(input.financial as never);

    const where = vi.fn().mockResolvedValue([{ id: 103, name: "Former Sam" }]);
    const from = vi.fn().mockReturnValue({ where });
    vi.mocked(db.select).mockReturnValue({ from } as never);

    const report = await readTeamEnvelopeReport({ organizationId: 11, leagueId: 7 });

    expect(db.select).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledTimes(1);
    expect(where).toHaveBeenCalledTimes(1);
    const scopedFilter = new PgDialect().sqlToQuery(where.mock.calls[0]?.[0]);
    expect(scopedFilter.sql).toContain('"bowlers"."organization_id"');
    expect(scopedFilter.params).toEqual([11, 103]);
    expect(report.teams.find((team) => team.teamId === 10)?.rows).toContainEqual(expect.objectContaining({
      bowlerId: 103,
      bowlerName: "Former Sam",
    }));
  });

  it("projects owned credit for responsible substitutes without requiring a filled legacy lineup", () => {
    const report = buildTeamEnvelopeReport(adoptedEnvelopeInput());
    const team = report.teams.find((candidate) => candidate.teamId === 10);
    const substitute = team?.rows.find((row) => row.bowlerId === 103);
    const creditHolder = team?.rows.find((row) => row.bowlerId === 104);
    const partialWaiver = team?.rows.find((row) => row.bowlerId === 105);

    expect(report.ownedAccountProjection).toBe(true);
    expect(substitute).toMatchObject({
      bowlerName: "Sam Substitute",
      weeklyDueMinor: 2_000,
      ytdDueMinor: 1_000,
      ytdPaidMinor: 1_500,
      remainingCreditMinor: 500,
      pastDueMinor: 0,
      dueTodayMinor: 1_500,
      finalWeekPaid: false,
    });
    expect(creditHolder).toMatchObject({
      bowlerName: "Avery Credit",
      ytdPaidMinor: 5_000,
      remainingCreditMinor: 5_000,
      weeklyDueMinor: 2_000,
      dueTodayMinor: 0,
      finalWeekPaid: true,
    });
    expect(partialWaiver).toMatchObject({
      bowlerName: "Riley Partial Waiver",
      ytdPaidMinor: 1_000,
      finalWeekPaid: false,
    });
    expect(team?.rows.some((row) => row.bowlerId === 106)).toBe(false);
    expect(team?.showFinalWeekPaid).toBe(true);
    expect(report.teams.find((candidate) => candidate.teamId === 20)?.rows).toMatchObject([{
      bowlerId: 107,
      bowlerName: "Taylor Rotation",
      weeklyDueMinor: 2_000,
      ytdPaidMinor: 1_000,
      remainingCreditMinor: 1_000,
      dueTodayMinor: 1_000,
    }]);
    expect(report.teams.find((candidate) => candidate.teamId === 20)?.rows).toHaveLength(1);
    expect(report.teams.find((candidate) => candidate.teamId === 20)?.rows.every((row) => row.ownerKind !== "team")).toBe(true);
    expect(report.teams.find((candidate) => candidate.teamId === 20)?.rows.some((row) => row.bowlerId === 108)).toBe(false);
  });

  it("uses the selected week's fees, prior YTD due, all effective payments, and due-through-today balance", () => {
    const report = buildTeamEnvelopeReport(reportInput());

    expect(report.weekLabel).toBe("2");
    expect(report.occurrenceLocalDate).toBe("2026-09-16");
    expect(report.finalWeekFeesDueLocalDate).toBe("2026-09-16");
    expect(report.teams[0]).toMatchObject({ teamNumber: 1, showFinalWeekPaid: true });
    expect(report.teams[0].rows[0]).toMatchObject({
      bowlerName: "Jillian Example",
      weeklyDueMinor: 2_000,
      ytdDueMinor: 2_000,
      ytdPaidMinor: 0,
      remainingCreditMinor: 0,
      pastDueMinor: 2_000,
      dueTodayMinor: 4_000,
      finalWeekPaid: false,
    });
    expect(report.teams[0].rows[1]).toMatchObject({
      ytdDueMinor: 2_000,
      ytdPaidMinor: 6_000,
      remainingCreditMinor: 2_000,
      pastDueMinor: 0,
      dueTodayMinor: 0,
      finalWeekPaid: true,
    });
    expect(report.teams[1]).toMatchObject({ teamNumber: 2, showFinalWeekPaid: false });
  });

  it("uses canonical week order for week 3/week 4 $70 payments", () => {
    const input = weekThreeFourSeventyDollarInput();
    const week3 = buildTeamEnvelopeReport(input).teams[0].rows[0];

    expect(week3).toMatchObject({
      weeklyDueMinor: 2_000,
      ytdDueMinor: 4_000,
      ytdPaidMinor: 7_000,
      remainingCreditMinor: 3_000,
      pastDueMinor: 0,
      dueTodayMinor: 0,
    });

    input.financial.asOf = "2026-09-30T16:00:00.000Z";
    const week4 = buildTeamEnvelopeReport(input).teams[0].rows[0];
    expect(week4).toMatchObject({
      weeklyDueMinor: 2_000,
      ytdDueMinor: 6_000,
      ytdPaidMinor: 7_000,
      remainingCreditMinor: 1_000,
      pastDueMinor: 0,
      dueTodayMinor: 1_000,
    });
  });

  it("keeps future obligations out of due today when upfront due timestamps are identical", () => {
    const input = weekThreeFourSeventyDollarInput();
    const sharedDueAt = "2026-09-09T22:30:00.000Z";
    for (const row of input.financial.rows) row.dueAt = sharedDueAt;

    const row = buildTeamEnvelopeReport(input).teams[0].rows[0];
    expect(row).toMatchObject({ ytdDueMinor: 4_000, dueTodayMinor: 0 });
  });

  it("reports prior outstanding obligations separately", () => {
    const input = weekThreeFourSeventyDollarInput();
    const firstWeek = input.financial.rows.find((row) => row.occurrenceId === "week-1");
    if (!firstWeek) throw new Error("missing week 1 fixture");
    firstWeek.allocatedMinor = 0;
    firstWeek.grossAllocatedMinor = 0;
    firstWeek.outstandingMinor = 2_000;
    firstWeek.stillOwed = true;
    firstWeek.state = "open";
    firstWeek.classification = "past_due";

    const row = buildTeamEnvelopeReport(input).teams[0].rows[0];
    expect(row).toMatchObject({ pastDueMinor: 2_000, dueTodayMinor: 2_000 });
  });

  it("preserves the legacy final-week waived-balance result", () => {
    const input = reportInput();
    for (const row of input.financial.rows) {
      row.allocatedMinor = row.amountMinor;
      row.grossAllocatedMinor = row.amountMinor;
      row.outstandingMinor = 0;
      row.stillOwed = false;
      row.state = "settled";
      row.classification = "settled";
    }
    const waivedFinal = input.financial.rows.find((row) => row.payerBowlerId === 102 && row.occurrenceId === "week-3");
    if (!waivedFinal) throw new Error("missing waived final obligation fixture");
    waivedFinal.allocatedMinor = 0;
    waivedFinal.grossAllocatedMinor = 0;
    waivedFinal.waivedMinor = waivedFinal.amountMinor;
    waivedFinal.outstandingMinor = 0;
    waivedFinal.stillOwed = false;
    waivedFinal.state = "settled";
    waivedFinal.classification = "settled";

    const report = buildTeamEnvelopeReport(input);
    const row = report.teams[0].rows[1];

    expect(row).toMatchObject({ bowlerId: 102, finalWeekPaid: true });
    expect(report.teams[0].showFinalWeekPaid).toBe(false);
  });

  it("applies the same envelope amounts to an owner-aware rotating slot", () => {
    const input = weekThreeFourSeventyDollarInput();
    const team = input.roster.teams.find((candidate) => candidate.id === 20);
    if (!team) throw new Error("missing rotating team fixture");
    team.slots[0] = { teamId: 20, slotIndex: 0, occupant: "rotating", mainBowlerId: null };
    Object.assign(team, { eligibleRotatingBowlerIds: [201] });
    const rows: FinancialReadRowContractV3[] = input.financial.rows.map((row, index) => ({
      ...row,
      teamId: 20,
      payerBowlerId: null,
      owner: { kind: "team", teamId: 20 },
      slotIndex: 0,
      responsibilityKind: "rotating",
      actualBowlerId: 201,
      occurrenceLocalDate: input.schedule.occurrences[index].authoritativeLocalDate,
      plannedOrdinal: index + 1,
      billingOrdinal: index + 1,
    }));
    input.financial = {
      ...input.financial,
      contractVersion: "canonical-due-past-due/3",
      orderVersion: "due-at,owner,occurrence,obligation/3",
      rows,
    };

    const row = buildTeamEnvelopeReport(input).teams.find((candidate) => candidate.teamId === 20)?.rows[0];
    expect(row).toMatchObject({
      bowlerName: "Rotating slot 1 · Morgan Example",
      weeklyDueMinor: 2_000,
      ytdDueMinor: 4_000,
      ytdPaidMinor: 7_000,
      remainingCreditMinor: 3_000,
      dueTodayMinor: 0,
    });
  });

  it("keeps a full payment toward a future final week out of remaining credit", () => {
    const input = futureFinalPartialPaymentInput();
    const row = buildTeamEnvelopeReport(input).teams[0].rows[0];

    expect(row).toMatchObject({
      weeklyDueMinor: 2_000,
      ytdDueMinor: 8_000,
      ytdPaidMinor: 10_000,
      remainingCreditMinor: 0,
      pastDueMinor: 0,
      dueTodayMinor: 2_000,
    });
  });

  it("excludes allocations reserved for more than one future paired week", () => {
    const row = buildTeamEnvelopeReport(twoFuturePairedWeeksInput()).teams[0].rows[0];

    expect(row).toMatchObject({
      ytdDueMinor: 8_000,
      ytdPaidMinor: 12_000,
      remainingCreditMinor: 0,
      weeklyDueMinor: 2_000,
      dueTodayMinor: 2_000,
    });
  });

  it("fails closed when an active lineup member has unresolved financial review", () => {
    const input = reportInput();
    input.financial.rows[0].reviewRequired = true;

    expect(() => buildTeamEnvelopeReport(input)).toThrowError(
      expect.objectContaining<Partial<TeamEnvelopeReportError>>({ code: "FINANCIAL_REVIEW_REQUIRED", status: 409 }),
    );
  });

  it("requires a complete active paying lineup", () => {
    const input = reportInput();
    input.roster.ready = false;
    input.roster.incompleteTeamIds = [10];

    expect(() => buildTeamEnvelopeReport(input)).toThrowError(
      expect.objectContaining<Partial<TeamEnvelopeReportError>>({ code: "ROSTER_INCOMPLETE", status: 409 }),
    );
  });

  it("requires a published double-pay week paired with the final week while final fees remain unpaid", () => {
    const input = reportInput();
    for (const item of input.schedule.occurrences) delete item.collectionGroups;

    expect(() => buildTeamEnvelopeReport(input)).toThrowError(
      expect.objectContaining<Partial<TeamEnvelopeReportError>>({ code: "FINAL_WEEK_DOUBLE_PAY_MISSING", status: 409 }),
    );
  });

  it("renders a vector PDF from the report", async () => {
    const bytes = await renderTeamEnvelopePdf(buildTeamEnvelopeReport(reportInput()));

    expect(Buffer.from(bytes.subarray(0, 4)).toString("ascii")).toBe("%PDF");
    expect(bytes.byteLength).toBeGreaterThan(5_000);
  });

  it.each([
    ["2026-09-16 22:15:54.123456+00", "20260916221554"],
    ["2026-09-16 22:15:54.123456+05:30", "20260916164554"],
  ])("normalizes a PostgreSQL timestamp before passing PDF metadata (%s)", async (asOf, expectedCreationDate) => {
    const input = reportInput();
    input.financial.asOf = asOf;

    const bytes = await renderTeamEnvelopePdf(buildTeamEnvelopeReport(input));

    expect(Buffer.from(bytes.subarray(0, 4)).toString("ascii")).toBe("%PDF");
    expect(Buffer.from(bytes).toString("latin1")).toContain(`CreationDate(D:${expectedCreationDate}Z)`);
  });

  it("rejects an invalid PDF metadata timestamp with a report error", async () => {
    const report = buildTeamEnvelopeReport(reportInput());
    report.generatedAt = "not-a-timestamp";

    await expect(renderTeamEnvelopePdf(report)).rejects.toMatchObject({
      code: "REPORT_DATE_INVALID",
      status: 503,
    });
  });
});
