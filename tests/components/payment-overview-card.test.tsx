import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PaymentOverviewCard } from "@/components/payment-overview-card";
import { deriveCurrentDuePeriodLabel } from "@/components/payment-status-section";

describe("PaymentOverviewCard", () => {
  it("shows the Familiar payment data without explanatory copy", () => {
    render(<PaymentOverviewCard
      weeklyFee={3_000}
      paymentMode="weekly"
      financials={{
        fullSeasonAmount: 90_000,
        totalDueToDate: 3_000,
        totalPaid: 3_000,
        amountPastDue: 0,
        remainingBalance: 87_000,
      }}
    />);

    expect(screen.getByRole("heading", { name: "Payment overview" })).toBeInTheDocument();
    expect(screen.getByText("Paid")).toBeInTheDocument();
    expect(screen.getByText("Remaining")).toBeInTheDocument();
    expect(screen.getByText("Season")).toBeInTheDocument();
    expect(screen.queryByText(/canonical roster obligations/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Payment History/i)).not.toBeInTheDocument();
  });

  it("uses the full-season financial rows for upfront leagues", () => {
    render(<PaymentOverviewCard
      weeklyFee={3_000}
      paymentMode="upfront"
      leagueId={17}
      financials={{
        fullSeasonAmount: 90_000,
        totalDueToDate: 90_000,
        totalPaid: 30_000,
        amountPastDue: 60_000,
        remainingBalance: 60_000,
      }}
    />);

    expect(screen.getAllByText("$600").length).toBeGreaterThan(0);
    expect(screen.getByText("$900")).toBeInTheDocument();
    expect(screen.queryByText("Weekly Fee")).not.toBeInTheDocument();
    expect(screen.queryByText("Past Due")).not.toBeInTheDocument();
    expect(screen.queryByText("Season Paid in Full")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Pay $600" })).toHaveAttribute("href", "/make-payment?leagueId=17");
  });

  it("links the dedicated payment flow from the bottom of the card", () => {
    render(<PaymentOverviewCard
      weeklyFee={3_000}
      paymentMode="weekly"
      leagueId={17}
      financials={{ fullSeasonAmount: 90_000, totalDueToDate: 90_000, totalPaid: 90_000, amountPastDue: 0, remainingBalance: 0 }}
    />);
    expect(screen.getByRole("link", { name: "Make a payment" })).toHaveAttribute("href", "/make-payment?leagueId=17");
  });

  it("uses current canonical due rows and compact currency for the due-now amount", () => {
    render(<PaymentOverviewCard
      weeklyFee={3_000}
      paymentMode="weekly"
      leagueId={17}
      currentDueMinor={2_500}
      duePeriod="Week 3 · Sep 8"
      financials={{ fullSeasonAmount: 90_000, totalDueToDate: 30_000, totalPaid: 27_500, amountPastDue: 0, remainingBalance: 62_500 }}
    />);

    expect(screen.getByText("$25")).toBeInTheDocument();
    expect(screen.getByText("Due now")).toBeInTheDocument();
    expect(screen.getByText("Week 3 · Sep 8")).toBeInTheDocument();
    expect(screen.queryByText("Payment due")).not.toBeInTheDocument();
    expect(screen.queryByText("$25.00")).not.toBeInTheDocument();
  });

  it("derives the due period from stored schedule evidence and fails closed when it is incomplete", () => {
    const rows = [{ occurrenceId: "occ-3", classification: "due" as const, state: "open" as const, outstandingMinor: 2_500, reviewRequired: false }];
    const occurrences = [{ occurrenceId: "occ-3", status: "scheduled" as const, authoritativeLocalDate: "2026-09-08", plannedOrdinal: 3 }];
    expect(deriveCurrentDuePeriodLabel(rows, occurrences)).toBe("Week 3 · Sep 8");
    expect(deriveCurrentDuePeriodLabel(rows, [{ ...occurrences[0], plannedOrdinal: null }])).toBeNull();
    expect(deriveCurrentDuePeriodLabel(rows, [{ ...occurrences[0], authoritativeLocalDate: "2026-02-30" }])).toBeNull();
  });

  it("limits rotating leagues to paid and past-due totals", () => {
    render(<PaymentOverviewCard
      weeklyFee={3_000}
      paymentMode="weekly"
      isRotating
      financials={{ fullSeasonAmount: 90_000, totalDueToDate: 30_000, totalPaid: 27_500, amountPastDue: 2_500, remainingBalance: 62_500 }}
    />);

    expect(screen.getByText("Paid")).toBeInTheDocument();
    expect(screen.getByText("Past Due", { selector: ".familiar-payment-overview__summary-label" })).toBeInTheDocument();
    expect(screen.queryByText("Remaining")).not.toBeInTheDocument();
    expect(screen.queryByText("Season", { selector: ".familiar-payment-overview__summary-label" })).not.toBeInTheDocument();
  });
});
