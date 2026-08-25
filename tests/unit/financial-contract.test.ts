import { describe, expect, it } from "vitest";
import { FINANCIAL_READ_CONTRACT_VERSION, FINANCIAL_READ_FINGERPRINT_PREFIX, FINANCIAL_READ_ORDER_VERSION, type FinancialReadContract, type FinancialOrganizationDuePastDueContract } from "@shared/financial-contract";

describe("roster due-past-due wire contract", () => {
  it("keeps version and fingerprint domains explicit", () => {
    expect(FINANCIAL_READ_CONTRACT_VERSION).toBe("canonical-due-past-due/2");
    expect(FINANCIAL_READ_ORDER_VERSION).toBe("due-at,payer,occurrence,obligation/2");
    expect(FINANCIAL_READ_FINGERPRINT_PREFIX).toBe("lvfinancialread:v1:");
  });

  it("requires the complete tenant-scoped nullable wire shape", () => {
    const row = { id: "00000000-0000-4000-8000-000000000001", organizationId: 1, leagueId: 2, occurrenceId: "00000000-0000-4000-8000-000000000002", responsibilityId: "00000000-0000-4000-8000-000000000003", teamId: 9, component: "full" as const, payerBowlerId: 7, amountMinor: 3000, currency: "USD" as const, dueAt: "2026-01-01T00:00:00.000Z", pastDueAt: "2026-01-01T03:00:00.000Z", state: "open" as const, allocatedMinor: 0, outstandingMinor: 3000, classification: "past_due" as const, reviewRequired: false };
    const fallback: FinancialReadContract = { organizationId: 1, leagueId: 2, contractVersion: FINANCIAL_READ_CONTRACT_VERSION, orderVersion: FINANCIAL_READ_ORDER_VERSION, authoritativeSource: "payment_obligations", asOf: "2026-01-01T00:00:00.000Z", rows: [row], totals: { amountMinor: 3000, allocatedMinor: 0, outstandingMinor: 3000, collectiblePastDueMinor: 3000, reviewCount: 0, settledCount: 0, voidedCount: 0 } };
    const aggregate: FinancialOrganizationDuePastDueContract = { organizationId: 1, contractVersion: FINANCIAL_READ_CONTRACT_VERSION, orderVersion: FINANCIAL_READ_ORDER_VERSION, authoritativeSource: "payment_obligations", leagues: [{ leagueId: 2, name: "League", report: fallback }] };
    expect(fallback.rows[0].dueAt).toBe("2026-01-01T00:00:00.000Z");
    expect(aggregate.leagues[0]?.report.organizationId).toBe(1);
  });
});
