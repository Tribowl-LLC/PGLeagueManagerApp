import { describe, expect, it, vi } from "vitest";
import type { FinancialReadRowContract } from "../../shared/financial-contract";
import type { LeagueOccurrenceScheduleOccurrence } from "../../shared/league-occurrence-schedule";

vi.mock("../../server/storage/index.js", () => ({ storage: {} }));
vi.mock("../../server/services/league-occurrence-schedule.js", () => ({ loadLeagueOccurrenceSchedule: vi.fn() }));
vi.mock("../../server/services/roster-payment-core.js", () => ({
  readCanonicalDuePastDue: vi.fn(),
  readRosterPaymentResponsibility: vi.fn(),
}));

import {
  buildTeamEnvelopeReport,
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
): FinancialReadRowContract {
  const outstandingMinor = 2_000 - allocatedMinor;
  return {
    id: `obligation-${bowlerId}-${occurrenceId}`,
    organizationId: 11,
    leagueId: 7,
    occurrenceId,
    responsibilityId: `responsibility-${bowlerId}-${occurrenceId}`,
    teamId,
    component: "full",
    payerBowlerId: bowlerId,
    amountMinor: 2_000,
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

describe("team envelope report", () => {
  it("uses the selected week's fees, prior YTD due, all effective payments, and due-through-today balance", () => {
    const report = buildTeamEnvelopeReport(reportInput());

    expect(report.weekLabel).toBe("2");
    expect(report.occurrenceLocalDate).toBe("2026-09-16");
    expect(report.finalWeekFeesDueLocalDate).toBe("2026-09-16");
    expect(report.teams[0]).toMatchObject({ teamNumber: 1, showFinalWeekPaid: true });
    expect(report.teams[0].rows[0]).toMatchObject({
      bowlerName: "Jillian Example",
      weeklyBowlingFeesMinor: 2_000,
      ytdDueMinor: 2_000,
      ytdPaidMinor: 0,
      dueTodayMinor: 4_000,
      finalWeekPaid: false,
    });
    expect(report.teams[0].rows[1]).toMatchObject({
      ytdDueMinor: 2_000,
      ytdPaidMinor: 6_000,
      dueTodayMinor: 0,
      finalWeekPaid: true,
    });
    expect(report.teams[1]).toMatchObject({ teamNumber: 2, showFinalWeekPaid: false });
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
