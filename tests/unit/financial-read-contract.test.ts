import { describe, expect, it } from "vitest";
import { resolveInteractiveFinancialRead } from "@/lib/financial-read-contract";
import type { FinancialReadContract } from "@shared/financial-contract";

const contractVersion = "canonical-due-past-due/2";
const base = { organizationId: 1, leagueId: 2, orderVersion: "due-at,payer,occurrence,obligation/2", authoritativeSource: "payment_obligations", asOf: "2038-01-01T00:00:00.000Z" };
const resolve = (data: unknown) => resolveInteractiveFinancialRead(data as FinancialReadContract | undefined);

describe("interactive financial read contract", () => {
  it("counts only collectible canonical outstanding rows", () => {
    const result = resolve({
      ...base,
      contractVersion,
      totals: { collectiblePastDueMinor: 300 },
      rows: [
        { id: "00000000-0000-4000-8000-000000000001", occurrenceId: "00000000-0000-4000-8000-000000000011", responsibilityId: "00000000-0000-4000-8000-000000000021", organizationId: 1, leagueId: 2, component: "full", payerBowlerId: 7, amountMinor: 300, allocatedMinor: 0, outstandingMinor: 300, currency: "USD", dueAt: "2038-01-01T00:00:00.000Z", pastDueAt: "2038-01-01T03:00:00.000Z", classification: "past_due", state: "open", reviewRequired: false },
        { id: "00000000-0000-4000-8000-000000000002", occurrenceId: "00000000-0000-4000-8000-000000000012", responsibilityId: "00000000-0000-4000-8000-000000000022", organizationId: 1, leagueId: 2, component: "full", payerBowlerId: 7, amountMinor: 500, allocatedMinor: 0, outstandingMinor: 500, currency: "USD", dueAt: "2038-01-01T00:00:00.000Z", pastDueAt: "2038-01-01T03:00:00.000Z", classification: "review_required", state: "open", reviewRequired: true },
        { id: "00000000-0000-4000-8000-000000000003", occurrenceId: "00000000-0000-4000-8000-000000000013", responsibilityId: "00000000-0000-4000-8000-000000000023", organizationId: 1, leagueId: 2, component: "full", payerBowlerId: 7, amountMinor: 700, allocatedMinor: 700, outstandingMinor: 0, currency: "USD", dueAt: "2038-01-01T00:00:00.000Z", pastDueAt: "2038-01-01T03:00:00.000Z", classification: "settled", state: "settled", reviewRequired: false },
        { id: "00000000-0000-4000-8000-000000000004", occurrenceId: "00000000-0000-4000-8000-000000000014", responsibilityId: "00000000-0000-4000-8000-000000000024", organizationId: 1, leagueId: 2, component: "full", payerBowlerId: 7, amountMinor: 900, allocatedMinor: 0, outstandingMinor: 0, currency: "USD", dueAt: "2038-01-01T00:00:00.000Z", pastDueAt: "2038-01-01T03:00:00.000Z", classification: "voided", state: "voided", reviewRequired: false },
      ],
      amountMinor: 2400, allocatedMinor: 700, outstandingMinor: 1700, settledCount: 1, voidedCount: 1, reviewCount: 1,
    });
    expect(result).toMatchObject({ status: "canonical", amountPastDue: 300, remainingBalance: 300 });
  });

  it("uses the selected owner's account balance and received-money projection", () => {
    const row = {
      id: "00000000-0000-4000-8000-000000000001",
      occurrenceId: "00000000-0000-4000-8000-000000000011",
      responsibilityId: "00000000-0000-4000-8000-000000000021",
      organizationId: 1,
      leagueId: 2,
      teamId: 3,
      component: "full",
      payerBowlerId: 7,
      amountMinor: 300,
      allocatedMinor: 0,
      outstandingMinor: 300,
      currency: "USD",
      dueAt: "2038-01-01T00:00:00.000Z",
      pastDueAt: "2038-01-01T03:00:00.000Z",
      classification: "past_due",
      state: "open",
      reviewRequired: false,
      accountProjection: {
        owner: { kind: "bowler", bowlerId: 7 },
        effectiveDebtorBowlerId: 7,
        confirmationStatus: "confirmed",
        projectedCreditMinor: 300,
      },
    };
    const data = {
      ...base,
      contractVersion,
      totals: { collectiblePastDueMinor: 300 },
      rows: [row],
      accountProjection: {
        contractVersion: "owned-account-projection/1",
        accounts: [{
          bowlerId: 7,
          amountPaidMinor: 300,
          availableCreditMinor: 0,
          confirmedDebtMinor: 300,
          netBalanceMinor: -300,
          confirmedPastDueMinor: 0,
          seasonRemainingMinor: 0,
          reviewRequired: false,
        }],
      },
    };

    expect(resolveInteractiveFinancialRead(data as FinancialReadContract, 7)).toMatchObject({
      status: "canonical",
      amountPastDue: 0,
      remainingBalance: 0,
      ownedAccount: { amountPaidMinor: 300, seasonRemainingMinor: 0 },
    });
    expect(resolveInteractiveFinancialRead(data as FinancialReadContract, 8)).toMatchObject({ status: "unavailable" });
  });

  it("does not expose legacy balance fallback when canonical rows are absent", () => {
    const result = resolve({
      contractVersion: "canonical-due-past-due/1",
      rows: [],
    });
    expect(result).toMatchObject({ status: "unavailable", amountPastDue: 0, remainingBalance: 0 });
  });

  it.each([
    undefined,
    { ...base, contractVersion: "canonical-due-past-due/2", authoritativeSource: "none", rows: [], totals: { collectiblePastDueMinor: 0 } },
    { ...base, contractVersion: "canonical-due-past-due/1", rows: [], totals: { collectiblePastDueMinor: 0 } },
    { contractVersion: "wrong/1", mode: "canonical", totals: { collectiblePastDueMinor: 1 }, rows: [] },
  ])("fails closed for unavailable or incompatible read %#", (data) => {
    expect(resolve(data)).toMatchObject({ status: "unavailable", amountPastDue: 0, remainingBalance: 0 });
  });
});
