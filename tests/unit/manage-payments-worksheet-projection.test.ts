import { describe, expect, it } from "vitest";
import {
  LEAGUE_OCCURRENCE_SCHEDULE_CONTRACT_VERSION,
  LEAGUE_OCCURRENCE_SCHEDULE_ORDER_VERSION,
  type LeagueOccurrenceScheduleOccurrence,
  type LeagueOccurrenceScheduleReadContract,
} from "@shared/league-occurrence-schedule";
import {
  buildManagePaymentsForecastTargets,
  buildManagePaymentsFinalTwoWeeksCoverageByBowler,
  buildManagePaymentsFinalTwoWeeksPaidByBowler,
  buildManagePaymentsWorksheetSnapshot,
  createManagePaymentsCardReceiptOccurrenceIndex,
  fingerprintManagePaymentsWorksheet,
  getManagePaymentsWeekOptions,
  localDateForInstant,
  mapCardReceiptCollectionOccurrence,
  mapCardReceiptCollectionOccurrenceFromIndex,
  ManagePaymentsWorksheetProjectionError,
  selectManagePaymentsOccurrence,
  type ManagePaymentsProjectionInput,
} from "../../server/services/manage-payments-worksheet-projection.js";
import {
  projectOwnedAccountCoverage,
  type OwnedAccountProjectionRowInput,
} from "../../server/services/owned-account-financial-projection.js";
import type { OwnedConfirmedObligation } from "../../server/services/owned-payment-ledger.js";

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
    finalAccountProjection: {
      rowsByObligationId: new Map(),
      reviewRequiredByObligationId: new Map(),
      forecastCoverageByTargetId: new Map(),
    },
    ...overrides,
  };
}

function withSharedAccountProjection(input: ManagePaymentsProjectionInput): ManagePaymentsProjectionInput {
  const occurrenceById = new Map(input.schedule.occurrences.map((row) => [row.occurrenceId, row]));
  const debts: OwnedConfirmedObligation[] = input.finalObligations.map((row) => {
    const occurrence = occurrenceById.get(row.occurrenceId);
    if (!occurrence) throw new Error("test confirmed debt is missing its schedule occurrence");
    const dueAt = new Date(occurrence.startAt).toISOString();
    return {
      obligationId: row.obligationId,
      responsibilityId: row.responsibilityId,
      occurrenceId: row.occurrenceId,
      occurrenceLocalDate: occurrence.authoritativeLocalDate,
      dueAt,
      pastDueAt: dueAt,
      teamId: row.teamId,
      amountMinor: row.amountMinor,
      paidMinor: row.paidMinor,
      waivedMinor: row.waivedMinor,
      outstandingMinor: row.outstandingMinor,
      payerBowlerId: row.payerBowlerId,
      debtorBowlerId: row.debtorBowlerId,
      targetKind: "bowler_responsibility",
      assignmentId: null,
      reviewRequired: row.reviewRequired,
    };
  });
  const rows: OwnedAccountProjectionRowInput[] = debts.map((debt) => {
    const occurrence = occurrenceById.get(debt.occurrenceId);
    if (!occurrence) throw new Error("test confirmed debt is missing its schedule occurrence");
    const dueAt = new Date(debt.dueAt).toISOString();
    const ownerBowlerId = debt.payerBowlerId ?? debt.debtorBowlerId;
    return {
      obligationId: debt.obligationId,
      occurrenceId: debt.occurrenceId,
      occurrenceLocalDate: debt.occurrenceLocalDate,
      dueAt,
      effectiveCollectionAt: dueAt,
      memberOrdinal: 0,
      billingOrdinal: occurrence.billing?.billingOrdinal ?? occurrence.plannedOrdinal ?? 0,
      owner: { kind: "bowler", bowlerId: ownerBowlerId },
      effectiveDebtorBowlerId: debt.debtorBowlerId,
      forecastEligible: true,
      state: debt.outstandingMinor > 0 ? "open" : "settled",
      outstandingMinor: debt.outstandingMinor,
      reviewRequired: debt.reviewRequired,
    };
  });
  const forecastTargets = buildManagePaymentsForecastTargets(input);
  for (const target of forecastTargets) {
    const occurrence = occurrenceById.get(target.occurrenceId);
    if (!occurrence) throw new Error("test forecast target is missing its schedule occurrence");
    const collectionGroup = occurrence.collectionGroups?.find((group) => group.state === "published");
    const triggerOccurrence = collectionGroup?.role === "paired"
      ? occurrenceById.get(collectionGroup.pairedOccurrenceId)
      : undefined;
    if (collectionGroup?.role === "paired" && !triggerOccurrence) {
      throw new Error("test paired occurrence is missing its canonical trigger");
    }
    rows.push({
      obligationId: target.projectionId,
      occurrenceId: target.occurrenceId,
      occurrenceLocalDate: target.occurrenceLocalDate,
      dueAt: target.dueAt,
      effectiveCollectionAt: triggerOccurrence ? new Date(triggerOccurrence.startAt).toISOString() : target.dueAt,
      memberOrdinal: collectionGroup?.role === "trigger" ? 1 : collectionGroup?.role === "paired" ? 2 : 0,
      billingOrdinal: target.billingOrdinal,
      owner: { kind: "bowler", bowlerId: target.bowlerId },
      effectiveDebtorBowlerId: target.bowlerId,
      forecastEligible: true,
      state: "open",
      outstandingMinor: target.feeMinor,
      reviewRequired: false,
    });
  }
  const confirmedOwedByBowler = new Map<number, number>();
  for (const debt of debts) {
    confirmedOwedByBowler.set(debt.debtorBowlerId, (confirmedOwedByBowler.get(debt.debtorBowlerId) ?? 0) + debt.outstandingMinor);
  }
  const balanceOwners = new Set([...input.balances.keys(), ...confirmedOwedByBowler.keys()]);
  const balances = new Map([...balanceOwners].map((bowlerId) => {
    const availableCreditMinor = input.balances.get(bowlerId)?.availableCreditMinor ?? 0;
    const confirmedOwedMinor = confirmedOwedByBowler.get(bowlerId) ?? 0;
    return [bowlerId, {
      bowlerId,
      availableCreditMinor,
      confirmedOwedMinor,
      netBalanceMinor: availableCreditMinor - confirmedOwedMinor,
    }] as const;
  }));
  const result = projectOwnedAccountCoverage({
    rows,
    confirmedDebts: debts,
    balances,
    amountPaidByBowler: new Map(),
    confirmedOccurrenceIds: input.confirmedOccurrenceIds,
    asOf: input.databaseNow,
  });
  const forecastCoverageByTargetId = new Map(forecastTargets.map((target) => [target.projectionId, {
    obligationIds: [target.projectionId],
    requiredMinor: target.feeMinor,
    paidMinor: 0,
    reviewRequired: false,
  }]));
  return { ...input, finalAccountProjection: { ...result, forecastCoverageByTargetId } };
}

describe("Manage Payments worksheet projection", () => {
  it("labels the week picker from canonical planned ordinals and falls back to date and time", () => {
    const weekOptions = getManagePaymentsWeekOptions(schedule([
      occurrence("canonical-week-7", "2026-09-14", 1, { plannedOrdinal: 7 }),
      occurrence("missing-canonical-week", "2026-09-21", 2, { plannedOrdinal: null }),
    ]));

    expect(weekOptions.map((week) => week.label)).toEqual([
      "Week 7 · Sep 14, 2026",
      "Sep 21, 2026 · 18:30",
    ]);
  });

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

  it("maps indexed card receipt weeks with the same explicit, trigger, date-fallback, and cancellation rules", () => {
    const scheduleData = schedule([
      occurrence("late-first", "2026-10-12", 1),
      occurrence("early-second", "2026-10-05", 2),
      occurrence("cancelled-middle", "2026-10-08", 3, { status: "cancelled" }),
    ]);
    const index = createManagePaymentsCardReceiptOccurrenceIndex(scheduleData);
    const receipts = [
      { explicitCollectionOccurrenceId: "late-first", triggerOccurrenceId: "early-second", collectionLocalDate: "2026-10-06" },
      { explicitCollectionOccurrenceId: null, triggerOccurrenceId: "early-second", collectionLocalDate: "2026-10-06" },
      { explicitCollectionOccurrenceId: "cancelled-middle", triggerOccurrenceId: null, collectionLocalDate: "2026-10-06" },
      { explicitCollectionOccurrenceId: null, triggerOccurrenceId: null, collectionLocalDate: "2026-10-01" },
      { explicitCollectionOccurrenceId: null, triggerOccurrenceId: null, collectionLocalDate: "2026-10-08" },
      { explicitCollectionOccurrenceId: null, triggerOccurrenceId: null, collectionLocalDate: "2026-10-20" },
    ] as const;

    expect(receipts.map((receipt) => mapCardReceiptCollectionOccurrenceFromIndex(receipt, index))).toEqual([
      "late-first",
      "early-second",
      null,
      "early-second",
      "early-second",
      "late-first",
    ]);
    expect(receipts.map((receipt) => mapCardReceiptCollectionOccurrence(receipt, scheduleData))).toEqual(
      receipts.map((receipt) => mapCardReceiptCollectionOccurrenceFromIndex(receipt, index)),
    );
  });

  it("normalizes PostgreSQL canonical start times to the worksheet minute contract", () => {
    const snapshot = buildManagePaymentsWorksheetSnapshot(projectionInput({
      schedule: schedule([
        occurrence("occ-1", "2026-09-14", 1, { authoritativeLocalStartTime: "18:30:00" }),
        occurrence("occ-2", "2026-09-21", 2, { authoritativeLocalStartTime: "18:30:00" }),
        occurrence("occ-3", "2026-09-28", 3, { authoritativeLocalStartTime: "18:30:00" }),
        occurrence("occ-4", "2026-10-05", 4, { authoritativeLocalStartTime: "18:30:00" }),
      ]),
    }));

    expect(snapshot.weekOptions.at(-1)?.localStartTime).toBe("18:30");
    expect(snapshot.selectedOccurrence.localStartTime).toBe("18:30");
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

  it("does not default a current main when a cutoff-confirmed week has no historical liability", () => {
    const snapshot = buildManagePaymentsWorksheetSnapshot(projectionInput({
      confirmedOccurrenceIds: new Set(["occ-4"]),
      explicitConfirmationRevisions: new Map(),
    }));

    expect(snapshot.weekConfirmed).toBe(true);
    expect(snapshot.needsConfirmation).toBe(true);
    expect(snapshot.revision).toBe(0);
    expect(snapshot.teams[0]?.rows[0]).toMatchObject({ responsible: false, feeMinor: 0 });
  });

  it("uses retained historical debtor and obligation amount before the first worksheet save", () => {
    const snapshot = buildManagePaymentsWorksheetSnapshot(projectionInput({
      members: [
        { teamId: 31, bowlerId: 501, displayName: "Avery Lane", order: 0, rosterRole: "main" },
        { teamId: 31, bowlerId: 502, displayName: "Blair Quinn", order: 1, rosterRole: "substitute" },
      ],
      displayNamesByBowler: new Map([[501, "Avery Lane"], [502, "Blair Quinn"]]),
      confirmedOccurrenceIds: new Set(["occ-4"]),
      responsibilitiesByOccurrence: new Map([["occ-4", [{
        responsibilityId: "historical-main-responsibility",
        teamId: 31,
        slotIndex: 0,
        kind: "main",
        payerBowlerId: 501,
        mainBowlerId: 501,
        substituteBowlerId: null,
        lineagePayerBowlerId: null,
        prizePayerBowlerId: null,
        worksheetFeeComponent: null,
        amountMinor: 1_000,
        lineageAmountMinor: null,
        prizeAmountMinor: null,
        version: 1,
      }]]]),
      finalObligations: [{
        obligationId: "historical-owned-obligation",
        responsibilityId: "historical-main-responsibility",
        occurrenceId: "occ-4",
        teamId: 31,
        component: "full",
        payerBowlerId: 501,
        debtorBowlerId: 502,
        amountMinor: 825,
        paidMinor: 0,
        waivedMinor: 0,
        outstandingMinor: 825,
        reviewRequired: false,
      }],
    }));

    expect(snapshot).toMatchObject({ weekConfirmed: true, needsConfirmation: true });
    expect(snapshot.teams[0]?.rows.find((row) => row.bowlerId === 501)).toMatchObject({ responsible: false, feeMinor: 0 });
    expect(snapshot.teams[0]?.rows.find((row) => row.bowlerId === 502)).toMatchObject({ responsible: true, feeComponent: "full", feeMinor: 825 });
  });

  it("uses retained component evidence for both cutoff-confirmed final weeks", () => {
    const historicalMain = (occurrenceId: string) => ({
      responsibilityId: `historical-main-${occurrenceId}`,
      teamId: 31,
      slotIndex: 0,
      kind: "main" as const,
      payerBowlerId: 501,
      mainBowlerId: 501,
      substituteBowlerId: null,
      lineagePayerBowlerId: null,
      prizePayerBowlerId: null,
      worksheetFeeComponent: null,
      amountMinor: 1_000,
      lineageAmountMinor: null,
      prizeAmountMinor: null,
      version: 1,
    });
    const snapshot = buildManagePaymentsWorksheetSnapshot(projectionInput({
      members: [
        { teamId: 31, bowlerId: 501, displayName: "Avery Lane", order: 0, rosterRole: "main" },
        { teamId: 31, bowlerId: 502, displayName: "Blair Quinn", order: 1, rosterRole: "substitute" },
      ],
      displayNamesByBowler: new Map([[501, "Avery Lane"], [502, "Blair Quinn"]]),
      responsibilitiesByOccurrence: new Map([
        ["occ-3", [historicalMain("occ-3")]],
        ["occ-4", [historicalMain("occ-4")]],
      ]),
      confirmedOccurrenceIds: new Set(["occ-3", "occ-4"]),
      balances: new Map([[502, { availableCreditMinor: 0, confirmedOwedMinor: 0, netBalanceMinor: 0 }]]),
      finalObligations: [
        {
          obligationId: "week-3-historical-owner",
          responsibilityId: "historical-main-occ-3",
          occurrenceId: "occ-3",
          teamId: 31,
          component: "full",
          payerBowlerId: 501,
          debtorBowlerId: 502,
          amountMinor: 800,
          paidMinor: 800,
          waivedMinor: 0,
          outstandingMinor: 0,
          reviewRequired: false,
        },
        {
          obligationId: "week-4-historical-owner",
          responsibilityId: "historical-main-occ-4",
          occurrenceId: "occ-4",
          teamId: 31,
          component: "full",
          payerBowlerId: 501,
          debtorBowlerId: 502,
          amountMinor: 900,
          paidMinor: 900,
          waivedMinor: 0,
          outstandingMinor: 0,
          reviewRequired: false,
        },
      ],
    }));

    expect(snapshot.teams[0]?.rows.find((row) => row.bowlerId === 501)).toMatchObject({ responsible: false, finalTwoWeeksPaid: false });
    expect(snapshot.teams[0]?.rows.find((row) => row.bowlerId === 502)).toMatchObject({ responsible: true, feeMinor: 900, finalTwoWeeksPaid: true });
  });

  it("retains an exact zero-price legacy split payer when its confirmed side has no obligation", () => {
    const snapshot = buildManagePaymentsWorksheetSnapshot(projectionInput({
      members: [
        { teamId: 31, bowlerId: 501, displayName: "Avery Lane", order: 0, rosterRole: "main" },
        { teamId: 31, bowlerId: 502, displayName: "Blair Quinn", order: 1, rosterRole: "substitute" },
      ],
      displayNamesByBowler: new Map([[501, "Avery Lane"], [502, "Blair Quinn"]]),
      confirmedOccurrenceIds: new Set(["occ-4"]),
      responsibilitiesByOccurrence: new Map([["occ-4", [{
        responsibilityId: "historical-zero-side-split",
        teamId: 31,
        slotIndex: 0,
        kind: "split",
        payerBowlerId: 501,
        mainBowlerId: 501,
        substituteBowlerId: 502,
        lineagePayerBowlerId: 501,
        prizePayerBowlerId: 502,
        worksheetFeeComponent: null,
        amountMinor: 700,
        lineageAmountMinor: 700,
        prizeAmountMinor: 0,
        version: 1,
      }]]]),
      finalObligations: [{
        obligationId: "historical-lineage-obligation",
        responsibilityId: "historical-zero-side-split",
        occurrenceId: "occ-4",
        teamId: 31,
        component: "lineage",
        payerBowlerId: 501,
        debtorBowlerId: 501,
        amountMinor: 700,
        paidMinor: 0,
        waivedMinor: 0,
        outstandingMinor: 700,
        reviewRequired: false,
      }],
    }));

    expect(snapshot.teams[0]?.rows.find((row) => row.bowlerId === 501)).toMatchObject({ responsible: true, feeComponent: "lineage", feeMinor: 700 });
    expect(snapshot.teams[0]?.rows.find((row) => row.bowlerId === 502)).toMatchObject({ responsible: true, feeComponent: "prize", feeMinor: 0 });
  });

  it("coalesces a same-payer zero-price legacy split before explicit confirmation", () => {
    const snapshot = buildManagePaymentsWorksheetSnapshot(projectionInput({
      confirmedOccurrenceIds: new Set(["occ-4"]),
      responsibilitiesByOccurrence: new Map([["occ-4", [{
        responsibilityId: "both-zero-split",
        teamId: 31,
        slotIndex: 0,
        kind: "split",
        payerBowlerId: 501,
        mainBowlerId: 501,
        substituteBowlerId: null,
        lineagePayerBowlerId: 501,
        prizePayerBowlerId: 501,
        worksheetFeeComponent: null,
        amountMinor: 0,
        lineageAmountMinor: 0,
        prizeAmountMinor: 0,
        version: 1,
      }]]]),
    }));

    expect(snapshot.teams.flatMap((team) => team.rows).filter((row) => row.bowlerId === 501)).toMatchObject([
      { responsible: true, feeComponent: "full", feeMinor: 0 },
    ]);
  });

  it("does not re-project a zero legacy component beside its saved worksheet row", () => {
    const snapshot = buildManagePaymentsWorksheetSnapshot(projectionInput({
      members: [
        { teamId: 31, bowlerId: 501, displayName: "Avery Lane", order: 0, rosterRole: "main" },
        { teamId: 31, bowlerId: 502, displayName: "Blair Quinn", order: 1, rosterRole: "substitute" },
      ],
      displayNamesByBowler: new Map([[501, "Avery Lane"], [502, "Blair Quinn"]]),
      confirmedOccurrenceIds: new Set(["occ-4"]),
      explicitConfirmationRevisions: new Map([["occ-4", 1]]),
      responsibilitiesByOccurrence: new Map([["occ-4", [
        {
          responsibilityId: "retained-positive-split",
          teamId: 31,
          slotIndex: 0,
          kind: "split",
          payerBowlerId: 501,
          mainBowlerId: 501,
          substituteBowlerId: 502,
          lineagePayerBowlerId: 501,
          prizePayerBowlerId: 502,
          worksheetFeeComponent: null,
          amountMinor: 700,
          lineageAmountMinor: 0,
          prizeAmountMinor: 700,
          version: 1,
        },
        {
          responsibilityId: "worksheet-zero-lineage",
          teamId: 31,
          slotIndex: null,
          kind: "worksheet",
          payerBowlerId: 501,
          mainBowlerId: null,
          substituteBowlerId: null,
          lineagePayerBowlerId: null,
          prizePayerBowlerId: null,
          worksheetFeeComponent: "lineage",
          amountMinor: 0,
          lineageAmountMinor: null,
          prizeAmountMinor: null,
          version: 1,
        },
      ]]]),
      finalObligations: [{
        obligationId: "retained-prize-obligation",
        responsibilityId: "retained-positive-split",
        occurrenceId: "occ-4",
        teamId: 31,
        component: "prize",
        payerBowlerId: 502,
        debtorBowlerId: 502,
        amountMinor: 700,
        paidMinor: 0,
        waivedMinor: 0,
        outstandingMinor: 700,
        reviewRequired: false,
      }],
    }));

    const rows = snapshot.teams.flatMap((team) => team.rows);
    expect(rows.filter((row) => row.responsible)).toHaveLength(2);
    expect(rows.find((row) => row.bowlerId === 501)).toMatchObject({ responsible: true, feeComponent: "lineage", feeMinor: 0 });
    expect(rows.find((row) => row.bowlerId === 502)).toMatchObject({ responsible: true, feeComponent: "prize", feeMinor: 700 });
  });

  it("projects confirmed legacy split payers from retained obligation components and amounts", () => {
    const input = projectionInput({
      members: [
        { teamId: 31, bowlerId: 501, displayName: "Avery Lane", order: 0, rosterRole: "main" },
        { teamId: 31, bowlerId: 502, displayName: "Blair Quinn", order: 1, rosterRole: "substitute" },
      ],
      displayNamesByBowler: new Map([[501, "Avery Lane"], [502, "Blair Quinn"]]),
      responsibilitiesByOccurrence: new Map([[
        "occ-4",
        [{
          responsibilityId: "retained-legacy-split",
          teamId: 31,
          slotIndex: 0,
          kind: "split",
          payerBowlerId: 501,
          mainBowlerId: 501,
          substituteBowlerId: 502,
          lineagePayerBowlerId: 501,
          prizePayerBowlerId: 502,
          worksheetFeeComponent: null,
          amountMinor: 1_000,
          lineageAmountMinor: 700,
          prizeAmountMinor: 300,
          version: 1,
        }],
      ]]),
      explicitConfirmationRevisions: new Map([["occ-4", 1]]),
      finalObligations: [
        {
          obligationId: "lineage-obligation",
          responsibilityId: "retained-legacy-split",
          occurrenceId: "occ-4",
          teamId: 31,
          component: "lineage",
          payerBowlerId: 501,
          debtorBowlerId: 501,
          amountMinor: 700,
          paidMinor: 200,
          waivedMinor: 100,
          outstandingMinor: 400,
          reviewRequired: false,
        },
        {
          obligationId: "prize-obligation",
          responsibilityId: "retained-legacy-split",
          occurrenceId: "occ-4",
          teamId: 31,
          component: "prize",
          payerBowlerId: 502,
          debtorBowlerId: 502,
          amountMinor: 300,
          paidMinor: 300,
          waivedMinor: 0,
          outstandingMinor: 0,
          reviewRequired: false,
        },
      ],
    });

    const rows = buildManagePaymentsWorksheetSnapshot(input).teams[0]?.rows ?? [];
    expect(rows.find((row) => row.bowlerId === 501)).toMatchObject({ responsible: true, feeComponent: "lineage", feeMinor: 700 });
    expect(rows.find((row) => row.bowlerId === 502)).toMatchObject({ responsible: true, feeComponent: "prize", feeMinor: 300 });
  });

  it("keeps a same-payer split displayed as its exact positive full amount when one component is zero", () => {
    const input = projectionInput({
      explicitConfirmationRevisions: new Map([["occ-4", 1]]),
      responsibilitiesByOccurrence: new Map([[
        "occ-4",
        [{
          responsibilityId: "zero-side-split",
          teamId: 31,
          slotIndex: 0,
          kind: "split",
          payerBowlerId: 501,
          mainBowlerId: 501,
          substituteBowlerId: 502,
          lineagePayerBowlerId: 501,
          prizePayerBowlerId: 501,
          worksheetFeeComponent: null,
          amountMinor: 300,
          lineageAmountMinor: 0,
          prizeAmountMinor: 300,
          version: 1,
        }],
      ]]),
      finalObligations: [{
        obligationId: "prize-obligation",
        responsibilityId: "zero-side-split",
        occurrenceId: "occ-4",
        teamId: 31,
        component: "prize",
        payerBowlerId: 501,
        debtorBowlerId: 501,
        amountMinor: 300,
        paidMinor: 0,
        waivedMinor: 0,
        outstandingMinor: 300,
        reviewRequired: false,
      }],
    });

    expect(buildManagePaymentsWorksheetSnapshot(input).teams[0]?.rows[0]).toMatchObject({
      responsible: true,
      feeComponent: "full",
      feeMinor: 300,
    });
  });

  it("projects only the retained component after one side of a confirmed same-payer split is retired", () => {
    const input = projectionInput({
      confirmedOccurrenceIds: new Set(["occ-4"]),
      explicitConfirmationRevisions: new Map([["occ-4", 2]]),
      responsibilitiesByOccurrence: new Map([[
        "occ-4",
        [{
          responsibilityId: "partially-retained-split",
          teamId: 31,
          slotIndex: 0,
          kind: "split",
          payerBowlerId: 501,
          mainBowlerId: 501,
          substituteBowlerId: 502,
          lineagePayerBowlerId: 501,
          prizePayerBowlerId: 501,
          worksheetFeeComponent: null,
          amountMinor: 1_000,
          lineageAmountMinor: 700,
          prizeAmountMinor: 300,
          version: 1,
        }],
      ]]),
      finalObligations: [{
        obligationId: "lineage-obligation",
        responsibilityId: "partially-retained-split",
        occurrenceId: "occ-4",
        teamId: 31,
        component: "lineage",
        payerBowlerId: 501,
        debtorBowlerId: 501,
        amountMinor: 700,
        paidMinor: 0,
        waivedMinor: 0,
        outstandingMinor: 700,
        reviewRequired: false,
      }],
    });

    expect(buildManagePaymentsWorksheetSnapshot(input).teams[0]?.rows[0]).toMatchObject({
      responsible: true,
      feeComponent: "lineage",
      feeMinor: 700,
    });
  });

  it("keeps waived legacy obligations visible and does not report waiver-only coverage as Paid", () => {
    const week = occurrence("occ-4", "2026-10-05", 4);
    const input = projectionInput({
      schedule: schedule([occurrence("occ-1", "2026-09-14", 1), occurrence("occ-2", "2026-09-21", 2), occurrence("occ-3", "2026-09-28", 3), week]),
      responsibilitiesByOccurrence: new Map([["occ-4", [{
        responsibilityId: "waived-legacy-responsibility",
        teamId: 31,
        slotIndex: 0,
        kind: "main",
        payerBowlerId: 501,
        mainBowlerId: 501,
        substituteBowlerId: null,
        lineagePayerBowlerId: null,
        prizePayerBowlerId: null,
        worksheetFeeComponent: null,
        amountMinor: 1_000,
        lineageAmountMinor: null,
        prizeAmountMinor: null,
        version: 1,
      }]]]),
      explicitConfirmationRevisions: new Map([["occ-4", 1]]),
      confirmedOccurrenceIds: new Set(["occ-4"]),
      finalObligations: [{
        obligationId: "waived-legacy-obligation",
        responsibilityId: "waived-legacy-responsibility",
        occurrenceId: "occ-4",
        teamId: 31,
        component: "full",
        payerBowlerId: 501,
        debtorBowlerId: 501,
        amountMinor: 1_000,
        paidMinor: 0,
        waivedMinor: 1_000,
        outstandingMinor: 0,
        reviewRequired: false,
      }],
    });

    const row = buildManagePaymentsWorksheetSnapshot(input).teams[0]?.rows[0];
    expect(row).toMatchObject({ responsible: true, feeComponent: "full", feeMinor: 1_000, finalTwoWeeksPaid: false });
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
      obligationId: `obligation:${week.occurrenceId}`,
      responsibilityId: `worksheet:${week.occurrenceId}`,
      occurrenceId: week.occurrenceId,
      teamId: 31,
      component: "full" as const,
      payerBowlerId: 501,
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

  it("doubles display fee terms only for a published canonical trigger occurrence", () => {
    const triggerGroup = {
      groupId: "published-trigger",
      groupOrdinal: 0,
      kind: "double_pay" as const,
      role: "trigger" as const,
      pairedOccurrenceId: "occ-3",
      pairedLocalDate: "2026-09-28",
      state: "published" as const,
      currentRevision: 1,
    };
    const selectedWeeks = [
      occurrence("occ-1", "2026-09-14", 1),
      occurrence("occ-2", "2026-09-21", 2),
      occurrence("occ-3", "2026-09-28", 3),
      occurrence("occ-4", "2026-10-05", 4, { collectionGroups: [triggerGroup] }),
    ];
    const doubled = buildManagePaymentsWorksheetSnapshot(projectionInput({ schedule: schedule(selectedWeeks) }));
    expect(doubled.league.feeTerms).toMatchObject({ fullMinor: 1_000, collectionMultiplier: 2 });
    expect(doubled.teams[0]?.rows[0]).toMatchObject({ feeMinor: 1_000, pairedCollectionFeeMinor: 1_000 });

    const paired = buildManagePaymentsWorksheetSnapshot(projectionInput({
      schedule: schedule(selectedWeeks.map((week) => week.occurrenceId === "occ-4"
        ? { ...week, collectionGroups: [{ ...triggerGroup, role: "paired" as const }] }
        : week)),
    }));
    const revoked = buildManagePaymentsWorksheetSnapshot(projectionInput({
      schedule: schedule(selectedWeeks.map((week) => week.occurrenceId === "occ-4"
        ? { ...week, collectionGroups: [{ ...triggerGroup, state: "revoked" as const }] }
        : week)),
    }));
    const regular = buildManagePaymentsWorksheetSnapshot(projectionInput());
    expect(paired.league.feeTerms.collectionMultiplier).toBe(1);
    expect(revoked.league.feeTerms.collectionMultiplier).toBe(1);
    expect(regular.league.feeTerms.collectionMultiplier).toBe(1);
    expect(paired.teams[0]?.rows[0]?.pairedCollectionFeeMinor).toBe(0);
    expect(revoked.teams[0]?.rows[0]?.pairedCollectionFeeMinor).toBe(0);
    expect(regular.teams[0]?.rows[0]?.pairedCollectionFeeMinor).toBe(0);
  });

  it("adds the actual paired responsibility to the display offset and deduplicates paired targets", () => {
    const triggerGroup = {
      groupId: "published-trigger",
      groupOrdinal: 0,
      kind: "double_pay" as const,
      role: "trigger" as const,
      pairedOccurrenceId: "occ-3",
      pairedLocalDate: "2026-09-28",
      state: "published" as const,
      currentRevision: 1,
    };
    const weeks = [
      occurrence("occ-1", "2026-09-14", 1),
      occurrence("occ-2", "2026-09-21", 2),
      occurrence("occ-3", "2026-09-28", 3),
      occurrence("occ-4", "2026-10-05", 4, {
        collectionGroups: [triggerGroup, { ...triggerGroup, groupId: "duplicate-link" }],
      }),
    ];
    const input = projectionInput({
      league: { id: 7, name: "Monday League", timeZone: "America/Chicago", weeklyFeeMinor: 2_000, lineageFeeMinor: 1_000, prizeFeeMinor: 500 },
      schedule: schedule(weeks),
      selectedOccurrenceId: "occ-4",
      fullFeeMinorByOccurrence: new Map(weeks.map((week) => [week.occurrenceId, 2_000])),
      responsibilitiesByOccurrence: new Map([
        ["occ-3", [{
          responsibilityId: "paired-full",
          teamId: 31,
          slotIndex: 0,
          kind: "main" as const,
          payerBowlerId: 501,
          mainBowlerId: 501,
          substituteBowlerId: null,
          lineagePayerBowlerId: null,
          prizePayerBowlerId: null,
          worksheetFeeComponent: null,
          amountMinor: 2_000,
          lineageAmountMinor: null,
          prizeAmountMinor: null,
          version: 1,
        }]],
        ["occ-4", [{
          responsibilityId: "trigger-lineage",
          teamId: 31,
          slotIndex: null,
          kind: "worksheet" as const,
          payerBowlerId: 501,
          mainBowlerId: null,
          substituteBowlerId: null,
          lineagePayerBowlerId: null,
          prizePayerBowlerId: null,
          worksheetFeeComponent: "lineage" as const,
          amountMinor: 1_000,
          lineageAmountMinor: null,
          prizeAmountMinor: null,
          version: 1,
        }]],
      ]),
      explicitConfirmationRevisions: new Map([["occ-4", 1]]),
      confirmedOccurrenceIds: new Set(["occ-4"]),
    });

    const row = buildManagePaymentsWorksheetSnapshot(input).teams[0]?.rows[0];
    expect(row).toMatchObject({ feeComponent: "lineage", feeMinor: 1_000, pairedCollectionFeeMinor: 2_000 });
  });

  it("uses an actual paired fee that differs from the current base fee and returns zero for no paired liability", () => {
    const triggerGroup = {
      groupId: "published-trigger",
      groupOrdinal: 0,
      kind: "double_pay" as const,
      role: "trigger" as const,
      pairedOccurrenceId: "occ-3",
      pairedLocalDate: "2026-09-28",
      state: "published" as const,
      currentRevision: 1,
    };
    const weeks = [
      occurrence("occ-1", "2026-09-14", 1),
      occurrence("occ-2", "2026-09-21", 2),
      occurrence("occ-3", "2026-09-28", 3),
      occurrence("occ-4", "2026-10-05", 4, { collectionGroups: [triggerGroup] }),
    ];
    const base = projectionInput({
      schedule: schedule(weeks),
      selectedOccurrenceId: "occ-4",
      fullFeeMinorByOccurrence: new Map(weeks.map((week) => [week.occurrenceId, 2_000])),
      responsibilitiesByOccurrence: new Map([
        ["occ-3", [{
          responsibilityId: "paired-full-25",
          teamId: 31,
          slotIndex: 0,
          kind: "main" as const,
          payerBowlerId: 501,
          mainBowlerId: 501,
          substituteBowlerId: null,
          lineagePayerBowlerId: null,
          prizePayerBowlerId: null,
          worksheetFeeComponent: null,
          amountMinor: 2_500,
          lineageAmountMinor: null,
          prizeAmountMinor: null,
          version: 1,
        }]],
        ["occ-4", [{
          responsibilityId: "trigger-full-20",
          teamId: 31,
          slotIndex: null,
          kind: "worksheet" as const,
          payerBowlerId: 501,
          mainBowlerId: null,
          substituteBowlerId: null,
          lineagePayerBowlerId: null,
          prizePayerBowlerId: null,
          worksheetFeeComponent: "full" as const,
          amountMinor: 2_000,
          lineageAmountMinor: null,
          prizeAmountMinor: null,
          version: 1,
        }]],
      ]),
      explicitConfirmationRevisions: new Map([["occ-4", 1]]),
      confirmedOccurrenceIds: new Set(["occ-4"]),
    });
    expect(buildManagePaymentsWorksheetSnapshot(base).teams[0]?.rows[0]).toMatchObject({
      feeMinor: 2_000,
      pairedCollectionFeeMinor: 2_500,
    });

    const noPairedLiability = buildManagePaymentsWorksheetSnapshot({
      ...base,
      responsibilitiesByOccurrence: new Map([
        ["occ-3", [{
          responsibilityId: "paired-vacant-main",
          teamId: 31,
          slotIndex: 0,
          kind: "vacant" as const,
          payerBowlerId: null,
          mainBowlerId: 501,
          substituteBowlerId: null,
          lineagePayerBowlerId: null,
          prizePayerBowlerId: null,
          worksheetFeeComponent: null,
          amountMinor: 0,
          lineageAmountMinor: null,
          prizeAmountMinor: null,
          version: 1,
        }]],
        ["occ-4", (base.responsibilitiesByOccurrence.get("occ-4") ?? []).map((row) => ({
          ...row,
          worksheetFeeComponent: "lineage" as const,
          amountMinor: 1_000,
        }))],
      ]),
    });
    expect(noPairedLiability.teams[0]?.rows[0]).toMatchObject({
      feeMinor: 1_000,
      pairedCollectionFeeMinor: 0,
    });
  });

  it("fails closed when a published paired target is invalid or has duplicate bowler rows", () => {
    const triggerGroup = {
      groupId: "published-trigger",
      groupOrdinal: 0,
      kind: "double_pay" as const,
      role: "trigger" as const,
      pairedOccurrenceId: "occ-3",
      pairedLocalDate: "2026-09-28",
      state: "published" as const,
      currentRevision: 1,
    };
    const weeks = [
      occurrence("occ-1", "2026-09-14", 1),
      occurrence("occ-2", "2026-09-21", 2),
      occurrence("occ-3", "2026-09-28", 3),
      occurrence("occ-4", "2026-10-05", 4, { collectionGroups: [triggerGroup] }),
    ];
    const input = projectionInput({ schedule: schedule(weeks), selectedOccurrenceId: "occ-4" });
    const duplicateResponsibilities = [1, 2].map((index) => ({
      responsibilityId: `duplicate-${index}`,
      teamId: 31,
      slotIndex: index,
      kind: "main" as const,
      payerBowlerId: 501,
      mainBowlerId: 501,
      substituteBowlerId: null,
      lineagePayerBowlerId: null,
      prizePayerBowlerId: null,
      worksheetFeeComponent: null,
      amountMinor: 1_000,
      lineageAmountMinor: null,
      prizeAmountMinor: null,
      version: 1,
    }));

    for (const invalidSchedule of [
      schedule(weeks.filter((week) => week.occurrenceId !== "occ-3")),
      schedule(weeks.map((week) => week.occurrenceId === "occ-3" ? { ...week, status: "cancelled" as const } : week)),
    ]) {
      let error: unknown;
      try {
        buildManagePaymentsWorksheetSnapshot({ ...input, schedule: invalidSchedule });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ManagePaymentsWorksheetProjectionError);
      expect(error).toMatchObject({ code: "invalid_occurrence" });
    }

    let duplicateError: unknown;
    try {
      buildManagePaymentsWorksheetSnapshot({
        ...input,
        responsibilitiesByOccurrence: new Map([["occ-3", duplicateResponsibilities]]),
      });
    } catch (caught) {
      duplicateError = caught;
    }
    expect(duplicateError).toBeInstanceOf(ManagePaymentsWorksheetProjectionError);
    expect(duplicateError).toMatchObject({ code: "duplicate_bowler_row" });
  });

  it("preserves Paid when the bowler has one fully covered applicable final-week target", () => {
    const weeks = [
      occurrence("occ-1", "2026-09-14", 1),
      occurrence("occ-2", "2026-09-21", 2),
      occurrence("occ-3", "2026-09-28", 3),
      occurrence("occ-4", "2026-10-05", 4),
    ];
    const input = projectionInput({
      schedule: schedule(weeks),
      selectedOccurrenceId: "occ-4",
      responsibilitiesByOccurrence: new Map([[
        "occ-3",
        [{
          responsibilityId: "worksheet:occ-3",
          teamId: 31,
          slotIndex: null,
          kind: "worksheet",
          payerBowlerId: 501,
          mainBowlerId: null,
          substituteBowlerId: null,
          lineagePayerBowlerId: null,
          prizePayerBowlerId: null,
          worksheetFeeComponent: "full",
          amountMinor: 1_000,
          lineageAmountMinor: null,
          prizeAmountMinor: null,
          version: 1,
        }],
      ]]),
      explicitConfirmationRevisions: new Map([["occ-3", 1], ["occ-4", 1]]),
      confirmedOccurrenceIds: new Set(["occ-3", "occ-4"]),
      finalObligations: [{
        obligationId: "obligation:occ-3",
        responsibilityId: "worksheet:occ-3",
        occurrenceId: "occ-3",
        teamId: 31,
        component: "full",
        payerBowlerId: 501,
        debtorBowlerId: 501,
        amountMinor: 1_000,
        paidMinor: 1_000,
        waivedMinor: 0,
        outstandingMinor: 0,
        reviewRequired: false,
      }],
    });

    expect(buildManagePaymentsFinalTwoWeeksCoverageByBowler(input).get(501)).toEqual({
      paidCount: 1,
      targetCount: 1,
    });
    expect(buildManagePaymentsWorksheetSnapshot(input).teams[0]?.rows[0]).toMatchObject({
      finalTwoWeeksPaid: true,
      finalTwoWeeksPaidCount: 1,
    });
  });

  it("uses published paired collection order for one shared $90 credit budget", () => {
    const firstPairTrigger = {
      groupId: "double-pay-week-5-31",
      groupOrdinal: 0,
      kind: "double_pay" as const,
      role: "trigger" as const,
      pairedOccurrenceId: "occ-week-31",
      pairedLocalDate: "2027-03-29",
      state: "published" as const,
      currentRevision: 1,
    };
    const firstPairMember = {
      ...firstPairTrigger,
      role: "paired" as const,
      pairedOccurrenceId: "occ-week-5",
      pairedLocalDate: "2026-09-28",
    };
    const secondPairTrigger = {
      groupId: "double-pay-week-6-32",
      groupOrdinal: 1,
      kind: "double_pay" as const,
      role: "trigger" as const,
      pairedOccurrenceId: "occ-week-32",
      pairedLocalDate: "2027-04-05",
      state: "published" as const,
      currentRevision: 1,
    };
    const secondPairMember = {
      ...secondPairTrigger,
      role: "paired" as const,
      pairedOccurrenceId: "occ-week-6",
      pairedLocalDate: "2026-10-05",
    };
    const weeks = [
      occurrence("occ-week-3", "2026-09-14", 3),
      occurrence("occ-week-4", "2026-09-21", 4),
      occurrence("occ-week-5", "2026-09-28", 5, { collectionGroups: [firstPairTrigger] }),
      occurrence("occ-week-6", "2026-10-05", 6, { collectionGroups: [secondPairTrigger] }),
      occurrence("occ-week-31", "2027-03-29", 31, { collectionGroups: [firstPairMember] }),
      occurrence("occ-week-32", "2027-04-05", 32, { collectionGroups: [secondPairMember] }),
    ];
    const input = withSharedAccountProjection(projectionInput({
      schedule: schedule(weeks),
      selectedOccurrenceId: "occ-week-5",
      fullFeeMinorByOccurrence: new Map(weeks.map((week) => [week.occurrenceId, 2_000])),
      balances: new Map([[501, { availableCreditMinor: 9_000, confirmedOwedMinor: 0, netBalanceMinor: 9_000 }]]),
    }));
    const forecastCreditByWeek = new Map(buildManagePaymentsForecastTargets(input).map((target) => [
      target.occurrenceId,
      input.finalAccountProjection.rowsByObligationId.get(target.projectionId)?.projectedCreditMinor ?? 0,
    ]));
    const coverage = buildManagePaymentsFinalTwoWeeksCoverageByBowler(input).get(501);
    const snapshot = buildManagePaymentsWorksheetSnapshot(input);
    const row = snapshot.teams[0]?.rows[0];

    expect(forecastCreditByWeek).toEqual(new Map([
      ["occ-week-3", 2_000],
      ["occ-week-4", 2_000],
      ["occ-week-5", 2_000],
      ["occ-week-6", 1_000],
      ["occ-week-31", 2_000],
      ["occ-week-32", 0],
    ]));
    expect(coverage).toEqual({ paidCount: 1, targetCount: 2 });
    expect(buildManagePaymentsFinalTwoWeeksPaidByBowler(input).get(501)).toBe(false);
    expect(snapshot.selectedOccurrence.occurrenceId).toBe("occ-week-5");
    expect(snapshot.league.feeTerms).toMatchObject({ fullMinor: 2_000, collectionMultiplier: 2 });
    expect(row).toMatchObject({
      feeMinor: 2_000,
      pairedCollectionFeeMinor: 2_000,
      finalTwoWeeksPaid: false,
      finalTwoWeeksPaidCount: 1,
    });
  });

  it("uses available credit only after older confirmed debt and covers only positive forecast targets", () => {
    const input = withSharedAccountProjection(projectionInput({
      confirmedOccurrenceIds: new Set(["occ-1", "occ-2"]),
      balances: new Map([[501, { availableCreditMinor: 2_500, confirmedOwedMinor: 600, netBalanceMinor: 1_900 }]]),
      finalObligations: [{
        obligationId: "older-obligation",
        responsibilityId: "older-responsibility",
        occurrenceId: "occ-2",
        teamId: 31,
        component: "full",
        payerBowlerId: 501,
        debtorBowlerId: 501,
        amountMinor: 600,
        paidMinor: 0,
        waivedMinor: 0,
        outstandingMinor: 600,
        reviewRequired: false,
      }],
    }));
    expect(buildManagePaymentsWorksheetSnapshot(input).teams[0]?.rows[0]?.finalTwoWeeksPaid).toBe(false);
    expect(buildManagePaymentsWorksheetSnapshot(withSharedAccountProjection({
      ...input,
      balances: new Map([[501, { availableCreditMinor: 2_600, confirmedOwedMinor: 600, netBalanceMinor: 2_000 }]]),
      finalAccountProjection: {
        rowsByObligationId: new Map(),
        reviewRequiredByObligationId: new Map(),
        forecastCoverageByTargetId: new Map(),
      },
    })).teams[0]?.rows[0]?.finalTwoWeeksPaid).toBe(true);
    expect(buildManagePaymentsWorksheetSnapshot({
      ...input,
      members: [{ teamId: 31, bowlerId: 502, displayName: "Blair Quinn", order: 0, rosterRole: "substitute" }],
    }).teams[0]?.rows[0]?.finalTwoWeeksPaid).toBe(false);
  });

  it("spends the shared forecast credit on an earlier ordinary week before the final-two column", () => {
    const input = projectionInput({
      fullFeeMinorByOccurrence: new Map([["occ-1", 2_500], ["occ-2", 2_500], ["occ-3", 2_500], ["occ-4", 2_500]]),
      confirmedOccurrenceIds: new Set(["occ-1"]),
      balances: new Map([[501, { availableCreditMinor: 2_500, confirmedOwedMinor: 0, netBalanceMinor: 2_500 }]]),
    });
    const projected = withSharedAccountProjection(input);
    const forecasts = buildManagePaymentsForecastTargets(projected);
    const projectedMinorByOccurrence = new Map(forecasts.map((target) => [
      target.occurrenceId,
      projected.finalAccountProjection.rowsByObligationId.get(target.projectionId)?.projectedCreditMinor ?? 0,
    ]));

    expect(projectedMinorByOccurrence).toEqual(new Map([["occ-2", 2_500], ["occ-3", 0], ["occ-4", 0]]));
    expect(buildManagePaymentsWorksheetSnapshot(projected).teams[0]?.rows[0]?.finalTwoWeeksPaid).toBe(false);
  });

  it("does not mark a materialized zero-demand final forecast paid without money coverage", () => {
    const projected = withSharedAccountProjection(projectionInput());
    const finalOccurrenceIds = new Set(projected.schedule.occurrences.slice(-2).map((row) => row.occurrenceId));
    const coverage = new Map(projected.finalAccountProjection.forecastCoverageByTargetId);
    for (const target of buildManagePaymentsForecastTargets(projected)) {
      if (!finalOccurrenceIds.has(target.occurrenceId)) continue;
      coverage.set(target.projectionId, {
        obligationIds: [target.projectionId],
        requiredMinor: 0,
        paidMinor: 0,
        reviewRequired: false,
      });
    }

    expect(buildManagePaymentsWorksheetSnapshot({
      ...projected,
      finalAccountProjection: { ...projected.finalAccountProjection, forecastCoverageByTargetId: coverage },
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
    const displayFeeTerms = { ...base.feeTerms, collectionMultiplier: 2 };
    expect(fingerprintManagePaymentsWorksheet({ ...base, feeTerms: displayFeeTerms })).toBe(fingerprint);
    expect(fingerprintManagePaymentsWorksheet({
      ...base,
      feeTerms: { ...base.feeTerms, prizeMinor: 400 },
    })).not.toBe(fingerprint);
    expect(fingerprintManagePaymentsWorksheet({ ...base, billingTermRevision: 5 })).not.toBe(fingerprint);
  });
});
