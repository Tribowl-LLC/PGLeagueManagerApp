import { describe, expect, it } from "vitest";
import { FINANCIAL_ACTIVATION_FINGERPRINT_PREFIX, FINANCIAL_READ_CONTRACT_VERSION, FINANCIAL_READ_FINGERPRINT_PREFIX, FINANCIAL_READ_ORDER_VERSION, FINANCIAL_SOURCE_FINGERPRINT_PREFIX, type FinancialReadContract, type FinancialActivationRequestContract, type FinancialOrganizationDuePastDueContract } from "@shared/financial-contract";

describe("F1 wire contract", () => {
  it("keeps version and fingerprint domains explicit", () => {
    expect(FINANCIAL_READ_CONTRACT_VERSION).toBe("canonical-due-past-due/1");
    expect(FINANCIAL_READ_ORDER_VERSION).toBe("due-at,bowler,occurrence,obligation/1");
    expect(new Set([FINANCIAL_READ_FINGERPRINT_PREFIX, FINANCIAL_SOURCE_FINGERPRINT_PREFIX, FINANCIAL_ACTIVATION_FINGERPRINT_PREFIX]).size).toBe(3);
  });

  it("requires the complete tenant-scoped nullable wire shape", () => {
    const row = { obligationId: null, occurrenceId: null, bowlerId: 7, teamId: null, amountMinor: 3000, allocatedMinor: 0, outstandingMinor: 3000, dueAt: null, pastDueAt: null, classification: "past_due" as const, state: "legacy" as const, evidenceSource: "legacy_fallback" as const, reviewRequired: false, reviewCategory: null, incompatibleEvidence: false, legacyWeekOf: null, legacyPaidMinor: 0, legacyDueToDateMinor: 3000 };
    const fallback: FinancialReadContract = { organizationId: 1, leagueId: 2, contractVersion: FINANCIAL_READ_CONTRACT_VERSION, orderVersion: FINANCIAL_READ_ORDER_VERSION, mode: "legacy_fallback", activationId: null, authoritativeSource: "legacy_helper", unavailableReason: "not_activated", fingerprint: `${FINANCIAL_READ_FINGERPRINT_PREFIX}${"a".repeat(64)}`, asOf: "2026-01-01T00:00:00.000Z", rows: [row], totals: { amountMinor: 3000, allocatedMinor: 0, outstandingMinor: 3000, collectiblePastDueMinor: 3000, reviewCount: 0 }, legacyFallback: { helperVersion: "shared-financial-utils/1", totalPaidMinor: 0, amountPastDueMinor: 3000, totalDueToDateMinor: 3000, fullSeasonAmountMinor: 96000, remainingBalanceMinor: 96000, totalWeeksInSeason: 32 } };
    const request: FinancialActivationRequestContract = { commandKey: "f1-command", sourceFingerprint: `${FINANCIAL_SOURCE_FINGERPRINT_PREFIX}${"b".repeat(64)}`, payingLineupSize: 3, responsibilities: [{ occurrenceId: "00000000-0000-4000-8000-000000000001", teamId: 9, slotIndex: 0, bowlerId: 7, role: "regular", provenance: "explicit_admin_selection" }] };
    const aggregate: FinancialOrganizationDuePastDueContract = { organizationId: 1, contractVersion: FINANCIAL_READ_CONTRACT_VERSION, orderVersion: FINANCIAL_READ_ORDER_VERSION, authoritativeSource: "per-league-snapshots", leagues: [{ leagueId: 2, name: "League", report: fallback }] };
    expect(fallback.rows[0].dueAt).toBeNull();
    expect(request.payingLineupSize).toBe(3);
    expect(aggregate.leagues[0]?.report.organizationId).toBe(1);
  });
});
