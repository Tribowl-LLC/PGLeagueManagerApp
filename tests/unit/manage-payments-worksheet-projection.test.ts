import { describe, expect, it } from "vitest";
import {
  LEAGUE_OCCURRENCE_SCHEDULE_CONTRACT_VERSION,
  LEAGUE_OCCURRENCE_SCHEDULE_ORDER_VERSION,
  type LeagueOccurrenceScheduleOccurrence,
  type LeagueOccurrenceScheduleReadContract,
} from "@shared/league-occurrence-schedule";
import {
  buildManagePaymentsWorksheetSnapshot,
  fingerprintManagePaymentsWorksheet,
  localDateForInstant,
  mapCardReceiptCollectionOccurrence,
  selectManagePaymentsOccurrence,
  type ManagePaymentsProjectionInput,
} from "../../server/services/manage-payments-worksheet-projection.js";

function occurrence(
  id: string,
  localDate: string,
  billingOrdinal: number,
  extras: Partial<LeagueOccurrenceScheduleOccurrence> = {},
): LeagueOccurrenceScheduleOccurrence {
  return {
    occurrenceId: id,
    identitySource: "canonical_uuid",
    kind: "regular",
    status: "scheduled",
    lifecycle: "published",
    authoritativeLocalDate: localDate,
    authoritativeLocalStartTime: "18:30",
    timezone: "America/Chicago",
    startAt: `${localDate}T23:30:00.000Z`,
    selectedUtcOffsetMinutes: -300,
    foldResolution: null,
    resolverVersion: "test",
    plannedOrdinal: billingOrdinal,
    competitionNumber: billingOrdinal,
    competitive: true,
    countsInStandings: true,
    currentRevision: 1,
    effectivelyLocked: false,
    effectiveLockReasons: [],
    billing: {
      purpose: "league_weekly_fee",
      obligationPolicy: "eligible_bowlers",
      billingOrdinal,
      version: 1,
      currentRevision: 1,
    },
    relationships: [],
    ...extras,
  };
}

function schedule(occurrences: LeagueOccurrenceScheduleOccurrence[]): LeagueOccurrenceScheduleReadContract {
  return {
    contractVersion: LEAGUE_OCCURRENCE_SCHEDULE_CONTRACT_VERSION,
    ordering: {
      version: LEAGUE_OCCURRENCE_SCHEDULE_ORDER_VERSION,
      keys: ["authoritativeLocalDate", "authoritativeLocalStartTime", "plannedOrdinal", "competitionNumber", "kind", "stableIdentity"],
    },
    organizationId: 12,
    leagueId: 7,
    authoritativeSource: "canonical",
    occurrences,
    skippedDates: [],
    administrator: null,
  };
}

function projectionInput(overrides: Partial<ManagePaymentsProjectionInput> = {}): ManagePaymentsProjectionInput {
  const weeks = [
    occurrence("occ-1", "2026-09-14", 1),
    occurrence("occ-2", "2026-09-21", 2),
    occurrence("occ-3", "2026-09-28", 3),
    occurrence("occ-4", "2026-10-05", 4),
  ];
  return {
    league: { id: 7, name: "Monday League", timeZone: "America/Chicago", weeklyFeeMinor: 1_000, lineageFeeMinor: 700, prizeFeeMinor: 300 },
    schedule: schedule(weeks),
    databaseNow: "2026-10-05T18:00:00.000Z",
    selectedOccurrenceId: "occ-4",
    teams: [{ teamId: 31, teamName: "Monday Night", displayOrder: 0, active: true }],
    members: [{ teamId: 31, bowlerId: 501, displayName: "Avery Lane", order: 0, rosterRole: "main" }],
    mainBowlerIdsByTeam: new Map([[31, new Set([501])]]),
    mainBowlerIdsBySlot: new Map([[31, new Map([[0, 501]])]]),
    displayNamesByBowler: new Map([[501, "Avery Lane"]]),
    historicalTeamByBowler: new Map(),
    historicalRoleByBowler: new Map(),
    fullFeeMinorByOccurrence: new Map(weeks.map((week) => [week.occurrenceId, 1_000])),
    responsibilitiesByOccurrence: new Map(),
    rotatingAssignmentsByResponsibility: new Map(),
    explicitConfirmationRevisions: new Map(),
    confirmedOccurrenceIds: new Set(),
    manualReceipts: [],
    cardReceipts: [],
    balances: new Map(),
    finalObligations: [],
    ...overrides,
  };
}

describe("Manage Payments worksheet projection", () => {
  it("selects the latest actual local collection date even when billing order differs", () => {
    const scheduleData = schedule([
      occurrence("later-date-first-ordinal", "2026-10-12", 1),
      occurrence("earlier-date-second-ordinal", "2026-10-05", 2),
    ]);

    expect(selectManagePaymentsOccurrence(scheduleData, "America/Chicago", "2026-10-06T15:00:00.000Z").occurrenceId)
      .toBe("earlier-date-second-ordinal");
    expect(mapCardReceiptCollectionOccurrence({
      explicitCollectionOccurrenceId: null,
      triggerOccurrenceId: null,
      collectionLocalDate: "2026-10-06",
    }, scheduleData)).toBe("earlier-date-second-ordinal");
    expect(mapCardReceiptCollectionOccurrence({
      explicitCollectionOccurrenceId: "revoked-or-nonbillable",
      triggerOccurrenceId: null,
      collectionLocalDate: "2026-10-06",
    }, scheduleData)).toBeNull();
    expect(() => selectManagePaymentsOccurrence(
      scheduleData,
      "America/Chicago",
      "2026-10-06T15:00:00.000Z",
      "forged-but-well-formed-uuid",
    )).toThrow();
  });

  it("uses league-local dates across the fall daylight-saving transition", () => {
    expect(localDateForInstant("2026-11-01T06:30:00.000Z", "America/Chicago")).toBe("2026-11-01");
  });

  it("keeps a represented main unchecked when a substitute is the saved payer", () => {
    const input = projectionInput({
      members: [{ teamId: 31, bowlerId: 502, displayName: "Blair Quinn", order: 1, rosterRole: "substitute" }],
      displayNamesByBowler: new Map([[501, "Avery Lane"], [502, "Blair Quinn"]]),
      responsibilitiesByOccurrence: new Map([["occ-4", [{
        responsibilityId: "responsibility-substitute",
        teamId: 31,
        slotIndex: 0,
        kind: "substitute",
        payerBowlerId: 502,
        mainBowlerId: 501,
        substituteBowlerId: 502,
        lineagePayerBowlerId: null,
        prizePayerBowlerId: null,
        worksheetFeeComponent: null,
        amountMinor: 1_000,
        lineageAmountMinor: null,
        prizeAmountMinor: null,
        version: 1,
      }]]]),
    });

    const snapshot = buildManagePaymentsWorksheetSnapshot(input);
    const rows = snapshot.teams[0]?.rows ?? [];
    expect(rows.find((row) => row.bowlerId === 501)).toMatchObject({ responsible: false, feeMinor: 0 });
    expect(rows.find((row) => row.bowlerId === 502)).toMatchObject({ responsible: true, feeMinor: 1_000 });
    expect(snapshot.needsConfirmation).toBe(true);
  });

  it("does not default the main for a represented rotating slot", () => {
    const input = projectionInput({
      members: [
        { teamId: 31, bowlerId: 501, displayName: "Avery Lane", order: 0, rosterRole: "main" },
        { teamId: 31, bowlerId: 502, displayName: "Blair Quinn", order: 1, rosterRole: "substitute" },
      ],
      displayNamesByBowler: new Map([[501, "Avery Lane"], [502, "Blair Quinn"]]),
      responsibilitiesByOccurrence: new Map([["occ-4", [{
        responsibilityId: "responsibility-rotating",
        teamId: 31,
        slotIndex: 0,
        kind: "rotating",
        payerBowlerId: null,
        mainBowlerId: null,
        substituteBowlerId: null,
        lineagePayerBowlerId: null,
        prizePayerBowlerId: null,
        worksheetFeeComponent: null,
        amountMinor: 1_000,
        lineageAmountMinor: null,
        prizeAmountMinor: null,
        version: 1,
      }]]]),
      rotatingAssignmentsByResponsibility: new Map([["responsibility-rotating", {
        responsibilityId: "responsibility-rotating",
        teamId: 31,
        bowlerId: 502,
      }]]),
    });

    const rows = buildManagePaymentsWorksheetSnapshot(input).teams[0]?.rows ?? [];
    expect(rows.find((row) => row.bowlerId === 501)).toMatchObject({ responsible: false, feeMinor: 0 });
    expect(rows.find((row) => row.bowlerId === 502)).toMatchObject({ responsible: true, feeMinor: 1_000 });
  });

  it("keeps multiple exact cash/check receipts and distinct card funding portions visible", () => {
    const secondReceiptId = "b6c7b9ad-883c-4478-8f30-75d2206e9c0c";
    const input = projectionInput({
      members: [
        { teamId: 31, bowlerId: 501, displayName: "Avery Lane", order: 0, rosterRole: "main" },
        { teamId: 31, bowlerId: 502, displayName: "Blair Quinn", order: 1, rosterRole: "substitute" },
      ],
      displayNamesByBowler: new Map([[501, "Avery Lane"], [502, "Blair Quinn"]]),
      manualReceipts: [
        {
          receiptId: "ef7244cb-1d34-44b0-a668-11dbdd1a2de1",
          revision: 1,
          paymentId: 91,
          type: "cash",
          amountMinor: 700,
          businessCollectionLocalDate: "2026-10-05",
          bowlerId: 501,
          teamId: 31,
          occurrenceId: "occ-4",
        },
        {
          receiptId: secondReceiptId,
          revision: 3,
          paymentId: 92,
          type: "check",
          amountMinor: 300,
          businessCollectionLocalDate: "2026-10-05",
          bowlerId: 501,
          teamId: 31,
          occurrenceId: "occ-4",
        },
      ],
      cardReceipts: [
        {
          paymentId: 93,
          bowlerId: 501,
          type: "square",
          amountMinor: 1_200,
          explicitCollectionOccurrenceId: "occ-4",
          triggerOccurrenceId: null,
          collectionLocalDate: "2026-10-05",
          recordedAt: "2026-10-06T00:30:00.000Z",
          receiptNumber: "R-93",
        },
        {
          paymentId: 93,
          bowlerId: 502,
          type: "square",
          amountMinor: 800,
          explicitCollectionOccurrenceId: "occ-4",
          triggerOccurrenceId: null,
          collectionLocalDate: "2026-10-05",
          recordedAt: "2026-10-06T00:30:00.000Z",
          receiptNumber: "R-93",
        },
      ],
    });

    const snapshot = buildManagePaymentsWorksheetSnapshot(input);
    expect(snapshot.teams[0]?.rows.find((row) => row.bowlerId === 501)?.manualReceipts.map((receipt) => receipt.receiptId))
      .toEqual([secondReceiptId, "ef7244cb-1d34-44b0-a668-11dbdd1a2de1"]);
    expect(snapshot.teams[0]?.rows.find((row) => row.bowlerId === 501)?.cardReceipts.map((receipt) => receipt.amountMinor)).toEqual([1_200]);
    expect(snapshot.teams[0]?.rows.find((row) => row.bowlerId === 502)?.cardReceipts.map((receipt) => receipt.amountMinor)).toEqual([800]);
  });

  it("uses responsibility then receipt history to place an inactive-week bowler before current membership", () => {
    const input = projectionInput({
      teams: [
        { teamId: 31, teamName: "Former team", displayOrder: 0, active: false },
        { teamId: 32, teamName: "Current team", displayOrder: 1, active: true },
      ],
      members: [{ teamId: 32, bowlerId: 501, displayName: "Avery Lane", order: 0, rosterRole: "substitute" }],
      manualReceipts: [{
        receiptId: "2b3e71df-4f3b-49b1-9fe0-339c0194048c",
        revision: 2,
        paymentId: 91,
        type: "cash",
        amountMinor: 700,
        businessCollectionLocalDate: "2026-10-05",
        bowlerId: 501,
        teamId: 31,
        occurrenceId: "occ-4",
      }],
    });

    const snapshot = buildManagePaymentsWorksheetSnapshot(input);
    expect(snapshot.teams.find((team) => team.teamId === 31)?.rows[0]).toMatchObject({
      bowlerId: 501,
      displayName: "Avery Lane",
      manualReceipts: [{ paymentId: 91, amountMinor: 700 }],
    });
    expect(snapshot.teams.find((team) => team.teamId === 32)?.rows).toHaveLength(0);
  });

  it("uses final billable weeks in billing order and requires money coverage, not waivers", () => {
    const weeks = [
      occurrence("occ-1", "2026-09-14", 1),
      occurrence("occ-2", "2026-09-21", 2),
      occurrence("occ-3", "2026-09-28", 3, {
        collectionGroups: [{ groupId: "double-trigger", groupOrdinal: 0, kind: "double_pay", role: "trigger", pairedOccurrenceId: "occ-4", pairedLocalDate: "2026-10-05", state: "published", currentRevision: 1 }],
      }),
      occurrence("occ-4", "2026-10-05", 4, {
        collectionGroups: [{ groupId: "double-paired", groupOrdinal: 0, kind: "double_pay", role: "paired", pairedOccurrenceId: "occ-3", pairedLocalDate: "2026-09-28", state: "published", currentRevision: 1 }],
      }),
    ];
    const responsibilities = new Map(weeks.slice(2).map((week) => [week.occurrenceId, [{
      responsibilityId: `worksheet:${week.occurrenceId}`,
      teamId: 31,
      slotIndex: null,
      kind: "worksheet" as const,
      payerBowlerId: 501,
      mainBowlerId: null,
      substituteBowlerId: null,
      lineagePayerBowlerId: null,
      prizePayerBowlerId: null,
      worksheetFeeComponent: "full" as const,
      amountMinor: 1_000,
      lineageAmountMinor: null,
      prizeAmountMinor: null,
      version: 1,
    }]]));
    const obligations = weeks.slice(2).map((week) => ({
      occurrenceId: week.occurrenceId,
      debtorBowlerId: 501,
      amountMinor: 1_000,
      paidMinor: 1_000,
      waivedMinor: 0,
      outstandingMinor: 0,
      reviewRequired: false,
    }));
    const input = projectionInput({
      schedule: schedule(weeks),
      responsibilitiesByOccurrence: responsibilities,
      explicitConfirmationRevisions: new Map([["occ-3", 1], ["occ-4", 1]]),
      confirmedOccurrenceIds: new Set(["occ-3", "occ-4"]),
      finalObligations: obligations,
    });

    expect(buildManagePaymentsWorksheetSnapshot(input).teams[0]?.rows[0]?.finalTwoWeeksPaid).toBe(true);
    const waiverOnly = obligations.map((row) => ({ ...row, paidMinor: 0, waivedMinor: 1_000 }));
    expect(buildManagePaymentsWorksheetSnapshot({ ...input, finalObligations: waiverOnly }).teams[0]?.rows[0]?.finalTwoWeeksPaid).toBe(false);
  });

  it("uses available credit only after older confirmed debt and covers only positive forecast targets", () => {
    const input = projectionInput({
      balances: new Map([[501, { availableCreditMinor: 2_500, confirmedOwedMinor: 600, netBalanceMinor: 1_900 }]]),
      finalObligations: [{
        occurrenceId: "occ-2",
        debtorBowlerId: 501,
        amountMinor: 600,
        paidMinor: 0,
        waivedMinor: 0,
        outstandingMinor: 600,
        reviewRequired: false,
      }],
    });
    expect(buildManagePaymentsWorksheetSnapshot(input).teams[0]?.rows[0]?.finalTwoWeeksPaid).toBe(false);
    expect(buildManagePaymentsWorksheetSnapshot({
      ...input,
      balances: new Map([[501, { availableCreditMinor: 2_600, confirmedOwedMinor: 600, netBalanceMinor: 2_000 }]]),
    }).teams[0]?.rows[0]?.finalTwoWeeksPaid).toBe(true);
    expect(buildManagePaymentsWorksheetSnapshot({
      ...input,
      members: [{ teamId: 31, bowlerId: 502, displayName: "Blair Quinn", order: 0, rosterRole: "substitute" }],
    }).teams[0]?.rows[0]?.finalTwoWeeksPaid).toBe(false);
  });

  it("fingerprints fee choices and pricing revisions while leaving balance/card evidence out", () => {
    const base = {
      occurrenceId: "occ-4",
      occurrenceRevision: 2,
      billingTermVersion: 3,
      billingTermRevision: 4,
      feeTerms: { fullMinor: 1_000, lineageMinor: 700, prizeMinor: 300 },
      rows: [{
        teamId: 31,
        bowlerId: 501,
        responsible: true,
        feeComponent: "prize" as const,
        feeMinor: 300,
        manualReceipts: [],
      }],
    };
    const fingerprint = fingerprintManagePaymentsWorksheet(base);
    expect(fingerprintManagePaymentsWorksheet({ ...base })).toBe(fingerprint);
    expect(fingerprintManagePaymentsWorksheet({
      ...base,
      feeTerms: { ...base.feeTerms, prizeMinor: 400 },
    })).not.toBe(fingerprint);
    expect(fingerprintManagePaymentsWorksheet({ ...base, billingTermRevision: 5 })).not.toBe(fingerprint);
  });
});
