import { describe, expect, it } from "vitest";
import {
  projectOwnedAccountCoverage,
  type OwnedAccountProjectionRowInput,
} from "../../server/services/owned-account-financial-projection.js";
import type { OwnedAccountBalance, OwnedConfirmedObligation } from "../../server/services/owned-payment-ledger.js";

const AS_OF = "2026-03-10T12:00:00.000Z";

function row(input: Partial<OwnedAccountProjectionRowInput> & Pick<OwnedAccountProjectionRowInput, "obligationId" | "occurrenceId" | "effectiveDebtorBowlerId" | "outstandingMinor">): OwnedAccountProjectionRowInput {
  const occurrenceLocalDate = input.occurrenceLocalDate ?? "2026-02-01";
  return {
    occurrenceLocalDate,
    dueAt: `${occurrenceLocalDate}T12:00:00.000Z`,
    effectiveCollectionAt: `${occurrenceLocalDate}T12:00:00.000Z`,
    memberOrdinal: 0,
    billingOrdinal: 0,
    owner: input.owner ?? { kind: "bowler", bowlerId: input.effectiveDebtorBowlerId ?? 1 },
    state: "open",
    reviewRequired: false,
    ...input,
    forecastEligible: input.forecastEligible ?? true,
  };
}

function debt(input: Partial<OwnedConfirmedObligation> & Pick<OwnedConfirmedObligation, "obligationId" | "occurrenceId" | "debtorBowlerId" | "outstandingMinor">): OwnedConfirmedObligation {
  const occurrenceLocalDate = input.occurrenceLocalDate ?? "2026-01-01";
  return {
    responsibilityId: `responsibility-${input.obligationId}`,
    occurrenceLocalDate,
    dueAt: `${occurrenceLocalDate}T12:00:00.000Z`,
    pastDueAt: `${occurrenceLocalDate}T13:00:00.000Z`,
    teamId: 10,
    amountMinor: input.outstandingMinor,
    paidMinor: 0,
    waivedMinor: 0,
    payerBowlerId: input.debtorBowlerId,
    targetKind: "bowler_responsibility",
    assignmentId: null,
    reviewRequired: false,
    ...input,
  };
}

function balance(bowlerId: number, availableCreditMinor: number, confirmedOwedMinor = 0): OwnedAccountBalance {
  return { bowlerId, availableCreditMinor, confirmedOwedMinor, netBalanceMinor: availableCreditMinor - confirmedOwedMinor };
}

describe("owned account financial projection", () => {
  it("spends one owner's budget on confirmed FIFO debt before forecast rows", () => {
    const old = row({ obligationId: "old", occurrenceId: "week-old", occurrenceLocalDate: "2026-01-01", effectiveDebtorBowlerId: 7, outstandingMinor: 2_500 });
    const next = row({ obligationId: "next", occurrenceId: "week-next", occurrenceLocalDate: "2026-02-01", effectiveDebtorBowlerId: 7, outstandingMinor: 2_500 });
    const result = projectOwnedAccountCoverage({
      rows: [old, next],
      confirmedDebts: [debt({ obligationId: "old", occurrenceId: "week-old", debtorBowlerId: 7, outstandingMinor: 2_500 })],
      balances: new Map([[7, balance(7, 3_000, 2_500)]]),
      amountPaidByBowler: new Map([[7, 3_000]]),
      asOf: AS_OF,
    });

    expect(result.rowsByObligationId.get("old")?.projectedCreditMinor).toBe(2_500);
    expect(result.rowsByObligationId.get("next")?.projectedCreditMinor).toBe(500);
    expect(result.accountProjection.accounts).toEqual([expect.objectContaining({
      bowlerId: 7,
      amountPaidMinor: 3_000,
      availableCreditMinor: 3_000,
      confirmedDebtMinor: 2_500,
      netBalanceMinor: 500,
      seasonRemainingMinor: 2_000,
    })]);
  });

  it("uses early paired-final collection order once, without also covering a later ordinary week", () => {
    const ordinary = row({
      obligationId: "ordinary",
      occurrenceId: "ordinary-week",
      occurrenceLocalDate: "2026-04-15",
      dueAt: "2026-04-15T12:00:00.000Z",
      effectiveCollectionAt: "2026-04-01T12:00:00.000Z",
      effectiveDebtorBowlerId: 8,
      outstandingMinor: 2_500,
    });
    const finalOne = row({
      obligationId: "final-one",
      occurrenceId: "final-week-one",
      occurrenceLocalDate: "2026-04-01",
      dueAt: "2026-04-01T12:00:00.000Z",
      effectiveCollectionAt: "2026-03-20T12:00:00.000Z",
      billingOrdinal: 0,
      effectiveDebtorBowlerId: 8,
      outstandingMinor: 1_250,
    });
    const finalTwo = row({
      obligationId: "final-two",
      occurrenceId: "final-week-two",
      occurrenceLocalDate: "2026-04-08",
      dueAt: "2026-04-08T12:00:00.000Z",
      effectiveCollectionAt: "2026-03-20T12:00:00.000Z",
      billingOrdinal: 1,
      effectiveDebtorBowlerId: 8,
      outstandingMinor: 1_250,
    });
    const result = projectOwnedAccountCoverage({
      rows: [ordinary, finalTwo, finalOne],
      confirmedDebts: [],
      balances: new Map([[8, balance(8, 2_500)]]),
      amountPaidByBowler: new Map([[8, 2_500]]),
      asOf: AS_OF,
    });

    expect(result.rowsByObligationId.get("final-one")?.projectedCreditMinor).toBe(1_250);
    expect(result.rowsByObligationId.get("final-two")?.projectedCreditMinor).toBe(1_250);
    expect(result.rowsByObligationId.get("ordinary")?.projectedCreditMinor).toBe(0);
    expect(result.accountProjection.accounts[0]?.seasonRemainingMinor).toBe(2_500);
  });

  it("does not pass a positive confirmed review barrier or spend its credit later", () => {
    const reviewed = row({ obligationId: "reviewed", occurrenceId: "review-week", occurrenceLocalDate: "2026-01-01", effectiveDebtorBowlerId: 9, outstandingMinor: 500, reviewRequired: true });
    const laterDebt = row({ obligationId: "later-debt", occurrenceId: "later-week", occurrenceLocalDate: "2026-01-08", effectiveDebtorBowlerId: 9, outstandingMinor: 500 });
    const forecast = row({ obligationId: "forecast", occurrenceId: "forecast-week", occurrenceLocalDate: "2026-02-01", effectiveDebtorBowlerId: 9, outstandingMinor: 500 });
    const result = projectOwnedAccountCoverage({
      rows: [reviewed, laterDebt, forecast],
      confirmedDebts: [
        debt({ obligationId: "reviewed", occurrenceId: "review-week", debtorBowlerId: 9, outstandingMinor: 500, reviewRequired: true }),
        debt({ obligationId: "later-debt", occurrenceId: "later-week", debtorBowlerId: 9, outstandingMinor: 500, occurrenceLocalDate: "2026-01-08" }),
      ],
      balances: new Map([[9, balance(9, 5_000, 1_000)]]),
      amountPaidByBowler: new Map(),
      asOf: AS_OF,
    });

    expect([...result.rowsByObligationId.values()].map((item) => item.projectedCreditMinor)).toEqual([0, 0, 0]);
    expect(result.accountProjection.accounts[0]).toMatchObject({ seasonRemainingMinor: 1_500, reviewRequired: true });
  });

  it("keeps clean credit spendable when a separate receipt is held for review", () => {
    const forecast = row({ obligationId: "forecast-clean", occurrenceId: "future-week", effectiveDebtorBowlerId: 91, outstandingMinor: 10_000 });
    const result = projectOwnedAccountCoverage({
      rows: [forecast],
      confirmedDebts: [],
      balances: new Map([[91, balance(91, 10_000)]]),
      amountPaidByBowler: new Map([[91, 12_500]]),
      sourceReviewBowlerIds: new Set([91]),
      asOf: AS_OF,
    });

    expect(result.rowsByObligationId.get("forecast-clean")?.projectedCreditMinor).toBe(10_000);
    expect(result.accountProjection.accounts[0]).toMatchObject({
      amountPaidMinor: 12_500,
      availableCreditMinor: 10_000,
      seasonRemainingMinor: 0,
      reviewRequired: true,
    });
  });

  it("keeps an overdue but unconfirmed forecast out of confirmed past due", () => {
    const forecast = row({ obligationId: "not-confirmed", occurrenceId: "old-week", occurrenceLocalDate: "2025-08-01", effectiveDebtorBowlerId: 11, outstandingMinor: 1_000 });
    const result = projectOwnedAccountCoverage({
      rows: [forecast],
      confirmedDebts: [],
      balances: new Map([[11, balance(11, 0)]]),
      amountPaidByBowler: new Map(),
      confirmedThroughLocalDate: "2025-07-31",
      asOf: AS_OF,
    });

    expect(result.rowsByObligationId.get("not-confirmed")?.confirmationStatus).toBe("forecast");
    expect(result.accountProjection.accounts[0]?.confirmedPastDueMinor).toBe(0);
  });

  it("returns only the requested owner's account while retaining separate obligation owner and effective debtor evidence", () => {
    const bowlerOwned = row({ obligationId: "self", occurrenceId: "self-week", effectiveDebtorBowlerId: 21, outstandingMinor: 500 });
    const teamOwned = row({
      obligationId: "other-team-row",
      occurrenceId: "other-week",
      effectiveDebtorBowlerId: 22,
      outstandingMinor: 1_000,
      owner: { kind: "team", teamId: 99 },
    });
    const result = projectOwnedAccountCoverage({
      rows: [bowlerOwned, teamOwned],
      confirmedDebts: [debt({ obligationId: "other-team-row", occurrenceId: "other-week", debtorBowlerId: 22, outstandingMinor: 1_000 })],
      balances: new Map([[21, balance(21, 500)], [22, balance(22, 900, 1_000)]]),
      amountPaidByBowler: new Map([[21, 500], [22, 900]]),
      asOf: AS_OF,
      bowlerId: 21,
    });

    expect(result.accountProjection.accounts).toEqual([expect.objectContaining({ bowlerId: 21, amountPaidMinor: 500, availableCreditMinor: 500 })]);
    expect(result.rowsByObligationId.get("other-team-row")).toMatchObject({
      owner: { kind: "team", teamId: 99 },
      effectiveDebtorBowlerId: 22,
    });
    expect(result.collectiblePastDueMinor).toBe(0);
  });

  it("does not project a zero-outstanding waived obligation as paid by credit", () => {
    const waived = row({ obligationId: "waived", occurrenceId: "waived-week", effectiveDebtorBowlerId: 25, outstandingMinor: 0, state: "settled" });
    const result = projectOwnedAccountCoverage({
      rows: [waived],
      confirmedDebts: [],
      balances: new Map([[25, balance(25, 2_000)]]),
      amountPaidByBowler: new Map([[25, 0]]),
      asOf: AS_OF,
    });

    expect(result.rowsByObligationId.get("waived")?.projectedCreditMinor).toBe(0);
    expect(result.accountProjection.accounts[0]?.seasonRemainingMinor).toBe(0);
  });
});
