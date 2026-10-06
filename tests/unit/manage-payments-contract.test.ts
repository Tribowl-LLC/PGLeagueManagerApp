import { describe, expect, it } from "vitest";
import {
  MANAGE_PAYMENTS_CONTRACT_VERSION,
  MANAGE_PAYMENTS_CHANGED_ROWS_MAX,
  managePaymentsApiPaths,
  managePaymentsReceivedDateSchema,
  managePaymentsSaveRequestSchema,
  managePaymentsSeasonSnapshotSchema,
  managePaymentsSnapshotSchema,
  rehydrateManagePaymentsSeasonWeekSnapshot,
} from "../../shared/manage-payments-contract";

const fingerprint = `lvmanagepayments:v1:${"a".repeat(64)}`;
const occurrenceId = "a0f10c5e-3455-44f1-b45e-2cad38da3184";
const receiptId = "3a59cbbe-27f1-4bc2-8993-b8572779f4e9";
const secondReceiptId = "ae8ef8d8-feb8-45f4-8a69-6a4fd084f89d";

const snapshot = {
  contractVersion: MANAGE_PAYMENTS_CONTRACT_VERSION,
  league: {
    leagueId: 9,
    name: "Monday League",
    timeZone: "America/Chicago",
    feeTerms: { fullMinor: 2500, lineageMinor: 1900, prizeMinor: 600 },
  },
  weekOptions: [{
    occurrenceId,
    localDate: "2026-09-14",
    localStartTime: "18:30",
    timeZone: "America/Chicago",
    label: "Sep 14",
  }],
  selectedOccurrence: {
    occurrenceId,
    localDate: "2026-09-14",
    localStartTime: "18:30",
    timeZone: "America/Chicago",
  },
  weekConfirmed: false,
  needsConfirmation: true,
  revision: 0,
  stateFingerprint: fingerprint,
  teams: [{
    teamId: 4,
    teamName: "Pins",
    rows: [{
      bowlerId: 13,
      displayName: "Ada Bowler",
      rosterRole: "main",
      responsible: true,
      feeComponent: "full",
      feeMinor: 2500,
      balanceMinor: -2500,
      cardReceipts: [],
      manualReceipts: [{
        receiptId,
        revision: 1,
        paymentId: 51,
        type: "check",
        amountMinor: 1000,
        businessCollectionLocalDate: "2026-09-14",
      }, {
        receiptId: secondReceiptId,
        revision: 1,
        paymentId: 52,
        type: "cash",
        amountMinor: 500,
        businessCollectionLocalDate: "2026-09-14",
      }],
      finalTwoWeeksPaid: false,
    }],
  }],
};

describe("Manage Payments contract", () => {
  it("validates a versioned snapshot with exact receipt identities and signed account balances", () => {
    const parsed = managePaymentsSnapshotSchema.parse(snapshot);
    expect(parsed.contractVersion).toBe(1);
    expect(parsed.teams[0]?.rows[0]?.balanceMinor).toBe(-2500);
    expect(parsed.teams[0]?.rows[0]?.manualReceipts[0]).toMatchObject({
      receiptId,
      paymentId: 51,
      type: "check",
    });
    expect(parsed.teams[0]?.rows[0]?.manualReceipts).toHaveLength(2);
  });

  it("accepts optional display-only collection and final-week metadata within its bounds", () => {
    const parsed = managePaymentsSnapshotSchema.parse({
      ...snapshot,
      league: {
        ...snapshot.league,
        feeTerms: { ...snapshot.league.feeTerms, collectionMultiplier: 2 },
      },
      teams: snapshot.teams.map((team) => ({
        ...team,
        rows: team.rows.map((row) => ({
          ...row,
          finalTwoWeeksPaidCount: 1,
          pairedCollectionFeeMinor: 3_000_000_000,
        })),
      })),
    });

    expect(parsed.league.feeTerms.collectionMultiplier).toBe(2);
    expect(parsed.teams[0]?.rows[0]?.finalTwoWeeksPaidCount).toBe(1);
    expect(parsed.teams[0]?.rows[0]?.pairedCollectionFeeMinor).toBe(3_000_000_000);
    expect(managePaymentsSnapshotSchema.safeParse({
      ...parsed,
      league: { ...parsed.league, feeTerms: { ...parsed.league.feeTerms, collectionMultiplier: 3 } },
    }).success).toBe(false);
    expect(managePaymentsSnapshotSchema.safeParse({
      ...parsed,
      teams: parsed.teams.map((team) => ({
        ...team,
        rows: team.rows.map((row) => ({ ...row, finalTwoWeeksPaidCount: 3 })),
      })),
    }).success).toBe(false);
    expect(managePaymentsSnapshotSchema.safeParse({
      ...parsed,
      teams: parsed.teams.map((team) => ({
        ...team,
        rows: team.rows.map((row) => ({ ...row, pairedCollectionFeeMinor: -1 })),
      })),
    }).success).toBe(false);
    expect(managePaymentsSnapshotSchema.safeParse({
      ...parsed,
      teams: parsed.teams.map((team) => ({
        ...team,
        rows: team.rows.map((row) => ({ ...row, pairedCollectionFeeMinor: Number.MAX_SAFE_INTEGER + 1 })),
      })),
    }).success).toBe(false);
  });

  it("uses the same versioned endpoint for GET and POST", () => {
    expect(managePaymentsApiPaths.leagueSnapshot(9)).toBe("/api/financials/leagues/9/manage-payments/1");
    expect(managePaymentsApiPaths.leagueSeasonSnapshot(9)).toBe("/api/financials/leagues/9/manage-payments/1/season");
    expect(managePaymentsApiPaths.saveWeek(9)).toBe(managePaymentsApiPaths.leagueSnapshot(9));
  });

  it("validates a deduplicated season response and rehydrates ready weeks to the unchanged snapshot contract", () => {
    const season = managePaymentsSeasonSnapshotSchema.parse({
      contractVersion: MANAGE_PAYMENTS_CONTRACT_VERSION,
      league: {
        leagueId: snapshot.league.leagueId,
        name: snapshot.league.name,
        timeZone: snapshot.league.timeZone,
      },
      weekOptions: snapshot.weekOptions,
      defaultOccurrenceId: occurrenceId,
      snapshotsByOccurrence: {
        [occurrenceId]: {
          status: "ready",
          feeTerms: snapshot.league.feeTerms,
          weekConfirmed: snapshot.weekConfirmed,
          needsConfirmation: snapshot.needsConfirmation,
          revision: snapshot.revision,
          stateFingerprint: snapshot.stateFingerprint,
          teams: snapshot.teams,
        },
      },
    });

    expect(rehydrateManagePaymentsSeasonWeekSnapshot(season, occurrenceId)).toEqual({ status: "ready", snapshot });
    expect(rehydrateManagePaymentsSeasonWeekSnapshot(season, "forged-week")).toMatchObject({
      status: "unavailable",
      code: "invalid_occurrence",
    });
  });

  it("keeps occurrence-local unavailability explicit and rejects incomplete or invalid ready rows", () => {
    const base = {
      contractVersion: MANAGE_PAYMENTS_CONTRACT_VERSION,
      league: {
        leagueId: snapshot.league.leagueId,
        name: snapshot.league.name,
        timeZone: snapshot.league.timeZone,
      },
      weekOptions: snapshot.weekOptions,
      defaultOccurrenceId: occurrenceId,
    };
    const unavailable = managePaymentsSeasonSnapshotSchema.parse({
      ...base,
      snapshotsByOccurrence: {
        [occurrenceId]: {
          status: "unavailable",
          code: "ambiguous_receipt_history",
          message: "Receipt allocation history for this week needs review.",
        },
      },
    });
    expect(rehydrateManagePaymentsSeasonWeekSnapshot(unavailable, occurrenceId)).toMatchObject({
      status: "unavailable",
      code: "ambiguous_receipt_history",
    });

    expect(managePaymentsSeasonSnapshotSchema.safeParse({ ...base, snapshotsByOccurrence: {} }).success).toBe(false);
    expect(managePaymentsSeasonSnapshotSchema.safeParse({
      ...base,
      snapshotsByOccurrence: {
        [occurrenceId]: {
          status: "ready",
          feeTerms: snapshot.league.feeTerms,
          weekConfirmed: snapshot.weekConfirmed,
          needsConfirmation: snapshot.needsConfirmation,
          revision: snapshot.revision,
          stateFingerprint: snapshot.stateFingerprint,
          teams: [snapshot.teams[0], { teamId: 5, teamName: "Splitters", rows: [snapshot.teams[0].rows[0]] }],
        },
      },
    }).success).toBe(false);
    expect(managePaymentsSeasonSnapshotSchema.safeParse({
      ...base,
      defaultOccurrenceId: "b8cc77db-79b5-4515-95c6-5482c56c3835",
      snapshotsByOccurrence: {
        [occurrenceId]: {
          status: "ready",
          feeTerms: snapshot.league.feeTerms,
          weekConfirmed: snapshot.weekConfirmed,
          needsConfirmation: snapshot.needsConfirmation,
          revision: snapshot.revision,
          stateFingerprint: snapshot.stateFingerprint,
          teams: snapshot.teams,
        },
      },
    }).success).toBe(false);
    expect(managePaymentsSeasonSnapshotSchema.safeParse({
      ...base,
      snapshotsByOccurrence: {
        [occurrenceId]: { status: "unavailable", code: "invalid_occurrence", message: "Unavailable." },
        ["b8cc77db-79b5-4515-95c6-5482c56c3835"]: { status: "unavailable", code: "invalid_occurrence", message: "Unavailable." },
      },
    }).success).toBe(false);
    expect(managePaymentsSeasonSnapshotSchema.safeParse({
      ...base,
      weekOptions: [...snapshot.weekOptions, ...snapshot.weekOptions],
      snapshotsByOccurrence: {
        [occurrenceId]: { status: "unavailable", code: "invalid_occurrence", message: "Unavailable." },
      },
    }).success).toBe(false);
  });

  it("accepts an empty save to confirm unconfirmed defaults and exact zero-clear edits", () => {
    const common = {
      occurrenceId,
      expectedRevision: 0,
      expectedStateFingerprint: fingerprint,
      idempotencyKey: "manage-payments-save-0001",
    };
    expect(managePaymentsSaveRequestSchema.parse({ ...common, changedRows: [] }).changedRows).toEqual([]);
    expect(managePaymentsSaveRequestSchema.parse({
      ...common,
      changedRows: [{
        teamId: 4,
        bowlerId: 13,
        responsible: true,
        feeComponent: "full",
        manualReceiptEdits: [{ receiptId, expectedRevision: 1, amountMinor: 0 }],
      }],
    }).changedRows[0]?.manualReceiptEdits[0]?.amountMinor).toBe(0);
  });

  it("accepts only real ISO calendar dates for an optional received date", () => {
    const common = {
      occurrenceId,
      expectedRevision: 0,
      expectedStateFingerprint: fingerprint,
      idempotencyKey: "manage-payments-save-received-date",
      changedRows: [],
    };

    expect(managePaymentsReceivedDateSchema.parse("2024-02-29")).toBe("2024-02-29");
    expect(managePaymentsSaveRequestSchema.parse(common).receivedDate).toBeUndefined();
    expect(managePaymentsSaveRequestSchema.parse({ ...common, receivedDate: "2024-02-29" }).receivedDate).toBe("2024-02-29");
    for (const invalidDate of ["2025-02-29", "2026-04-31", "2026-13-01", "2026-2-01"]) {
      expect(managePaymentsSaveRequestSchema.safeParse({ ...common, receivedDate: invalidDate }).success).toBe(false);
    }
  });

  it("rejects client-selected balances, amounts, or any other unknown financial field", () => {
    const base = {
      occurrenceId,
      expectedRevision: 0,
      expectedStateFingerprint: fingerprint,
      idempotencyKey: "manage-payments-save-0002",
      changedRows: [],
    };
    expect(managePaymentsSaveRequestSchema.safeParse({ ...base, organizationId: 9 }).success).toBe(false);
    expect(managePaymentsSaveRequestSchema.safeParse({
      ...base,
      changedRows: [{
        teamId: 4,
        bowlerId: 13,
        responsible: true,
        feeComponent: "full",
        feeMinor: 999,
        manualReceiptEdits: [],
      }],
    }).success).toBe(false);
  });

  it("does not permit the same exact manual receipt to be edited under two row owners", () => {
    const request = {
      occurrenceId,
      expectedRevision: 1,
      expectedStateFingerprint: fingerprint,
      idempotencyKey: "manage-payments-save-0042",
      changedRows: [
        {
          teamId: 4,
          bowlerId: 13,
          responsible: true,
          feeComponent: "full",
          manualReceiptEdits: [{ receiptId, expectedRevision: 1, amountMinor: 1250 }],
        },
        {
          teamId: 4,
          bowlerId: 14,
          responsible: false,
          feeComponent: "full",
          manualReceiptEdits: [{ receiptId, expectedRevision: 1, amountMinor: 0 }],
        },
      ],
    };
    expect(managePaymentsSaveRequestSchema.safeParse(request).success).toBe(false);
  });

  it("rejects duplicate payer rows and bounds request size", () => {
    const duplicatePayerSnapshot = {
      ...snapshot,
      teams: [
        snapshot.teams[0],
        { teamId: 5, teamName: "Splitters", rows: [snapshot.teams[0].rows[0]] },
      ],
    };
    expect(managePaymentsSnapshotSchema.safeParse(duplicatePayerSnapshot).success).toBe(false);

    const common = {
      occurrenceId,
      expectedRevision: 0,
      expectedStateFingerprint: fingerprint,
      idempotencyKey: "manage-payments-save-0003",
    };
    const changedRows = Array.from({ length: MANAGE_PAYMENTS_CHANGED_ROWS_MAX + 1 }, (_, index) => ({
      teamId: 4,
      bowlerId: index + 1,
      responsible: false,
      feeComponent: "full" as const,
      manualReceiptEdits: [],
    }));
    expect(managePaymentsSaveRequestSchema.safeParse({ ...common, changedRows }).success).toBe(false);
  });
});
