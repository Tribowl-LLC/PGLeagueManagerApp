import { describe, expect, it } from "vitest";
import {
  AutopaySetupPlanningError,
  BILLING_GRACE_PERIOD_MS,
  buildWeeklyBillingOccurrences,
  planWeeklyAutopaySetup,
  type PlannerLeague,
} from "../../server/services/weekly-billing-occurrence-planner";

function league(overrides: Partial<PlannerLeague> = {}): PlannerLeague {
  return {
    id: 41,
    seasonStart: "2026-08-02",
    seasonEnd: "2026-08-30",
    weekDay: "Sunday",
    competitionStartTime: "12:40",
    timezone: "America/New_York",
    weeklyFee: 100,
    totalBowlingWeeks: 5,
    skipDates: [],
    cancelledDates: [],
    doublePayDates: [],
    ...overrides,
  };
}

function paid(amount: number, weekOf = "2026-07-01T00:00:00.000Z") {
  return { amount, status: "paid" as const, weekOf };
}

describe("weekly billing occurrence planner", () => {
  it("charges nothing five minutes before the first start and schedules that occurrence", () => {
    const plan = planWeeklyAutopaySetup({
      league: league(),
      payees: [{ bowlerId: 7, payments: [] }],
      now: new Date("2026-08-02T16:35:00.000Z"),
    });

    expect(plan.immediateAmountMinor).toBe(0);
    expect(plan.allocations).toEqual([]);
    expect(plan.firstAutomaticOccurrence?.occurrenceAt).toBe("2026-08-02T16:40:00.000Z");
    expect(plan.firstAutomaticAmountMinor).toBe(100);
  });

  it("classifies exactly-at-start as due today and advances the cursor one week", () => {
    const plan = planWeeklyAutopaySetup({
      league: league(),
      payees: [{ bowlerId: 7, payments: [] }],
      now: new Date("2026-08-02T16:40:00.000Z"),
    });

    expect(plan.immediateAmountMinor).toBe(100);
    expect(plan.allocations).toMatchObject([{
      occurrenceAt: "2026-08-02T16:40:00.000Z",
      classification: "due_today",
      amountMinor: 100,
    }]);
    expect(plan.firstAutomaticOccurrence?.occurrenceAt).toBe("2026-08-09T16:40:00.000Z");
  });

  it("keeps the current occurrence due-today until one second before grace expires", () => {
    const start = new Date("2026-08-02T16:40:00.000Z");
    const plan = planWeeklyAutopaySetup({
      league: league(),
      payees: [{ bowlerId: 7, payments: [] }],
      now: new Date(start.getTime() + BILLING_GRACE_PERIOD_MS - 1_000),
    });
    expect(plan.allocations[0]?.classification).toBe("due_today");
  });

  it("makes the current occurrence past due exactly at the grace deadline", () => {
    const start = new Date("2026-08-02T16:40:00.000Z");
    const plan = planWeeklyAutopaySetup({
      league: league(),
      payees: [{ bowlerId: 7, payments: [] }],
      now: new Date(start.getTime() + BILLING_GRACE_PERIOD_MS),
    });
    expect(plan.allocations[0]?.classification).toBe("past_due");
  });

  it("settles overdue weeks oldest-first with one allocation per occurrence", () => {
    const plan = planWeeklyAutopaySetup({
      league: league({ seasonStart: "2026-07-12", seasonEnd: "2026-08-09" }),
      payees: [{ bowlerId: 7, payments: [] }],
      now: new Date("2026-08-02T16:35:00.000Z"),
    });
    expect(plan.allocations.map((row) => [row.localDate, row.amountMinor])).toEqual([
      ["2026-07-12", 100],
      ["2026-07-19", 100],
      ["2026-07-26", 100],
    ]);
    expect(plan.firstAutomaticOccurrence?.localDate).toBe("2026-08-02");
  });

  it("uses partial legacy credit oldest-first and charges the exact remainder", () => {
    const plan = planWeeklyAutopaySetup({
      league: league({ seasonStart: "2026-07-12", seasonEnd: "2026-08-09" }),
      payees: [{ bowlerId: 7, payments: [paid(150)] }],
      now: new Date("2026-08-02T16:35:00.000Z"),
    });
    expect(plan.allocations.map((row) => [row.localDate, row.amountMinor])).toEqual([
      ["2026-07-19", 50],
      ["2026-07-26", 100],
    ]);
  });

  it("honors exact occurrence attribution before applying surplus oldest-first", () => {
    const second = buildWeeklyBillingOccurrences(league())[1];
    expect(second).toBeDefined();
    const plan = planWeeklyAutopaySetup({
      league: league(),
      payees: [{ bowlerId: 7, payments: [paid(150, second?.occurrenceAt)] }],
      now: new Date("2026-08-09T16:40:00.000Z"),
    });
    expect(plan.allocations).toMatchObject([{
      localDate: "2026-08-02",
      amountMinor: 50,
      classification: "past_due",
    }]);
  });

  it("treats overpayment as credit without inventing an occurrence", () => {
    const plan = planWeeklyAutopaySetup({
      league: league({ totalBowlingWeeks: 2, seasonEnd: "2026-08-09" }),
      payees: [{ bowlerId: 7, payments: [paid(300)] }],
      now: new Date("2026-08-01T12:00:00.000Z"),
    });
    expect(plan.immediateAmountMinor).toBe(0);
    expect(plan.firstAutomaticOccurrence).toBeNull();
    expect(plan.payees[0]?.unappliedCreditMinor).toBe(100);
  });

  it("excludes skipped/cancelled dates and caps double-pay at the season total", () => {
    const occurrences = buildWeeklyBillingOccurrences(league({
      seasonStart: "2026-08-02",
      seasonEnd: "2026-09-06",
      totalBowlingWeeks: 5,
      skipDates: ["2026-08-09"],
      cancelledDates: ["2026-08-16"],
      doublePayDates: ["2026-08-23"],
    }));
    expect(occurrences.map((row) => [row.localDate, row.amountMinor])).toEqual([
      ["2026-08-02", 100],
      ["2026-08-23", 200],
      ["2026-08-30", 100],
      ["2026-09-06", 0],
    ]);
  });

  it("keeps the league-local start time across the spring DST boundary", () => {
    const occurrences = buildWeeklyBillingOccurrences(league({
      seasonStart: "2026-03-01",
      seasonEnd: "2026-03-15",
      totalBowlingWeeks: 3,
    }));
    expect(occurrences.map((row) => row.occurrenceAt)).toEqual([
      "2026-03-01T17:40:00.000Z",
      "2026-03-08T16:40:00.000Z",
      "2026-03-15T16:40:00.000Z",
    ]);
  });

  it("fails closed when combined payees have different future cursors", () => {
    const first = buildWeeklyBillingOccurrences(league())[0];
    expect(first).toBeDefined();
    expect(() => planWeeklyAutopaySetup({
      league: league(),
      payees: [
        { bowlerId: 7, payments: [] },
        { bowlerId: 8, payments: [paid(100, first?.occurrenceAt)] },
      ],
      now: new Date("2026-08-02T16:35:00.000Z"),
    })).toThrowError(expect.objectContaining<Partial<AutopaySetupPlanningError>>({
      code: "COMBINED_AUTOPAY_CURSOR_MISMATCH",
    }));
  });
});
