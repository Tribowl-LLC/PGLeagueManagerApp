import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PaymentOverviewCard } from "@/components/payment-overview-card";

describe("PaymentOverviewCard", () => {
  it("shows the payment data without explanatory copy", () => {
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

    expect(screen.getByRole("heading", { name: "Payment Overview" })).toBeInTheDocument();
    expect(screen.getByText("Weekly Fee")).toBeInTheDocument();
    expect(screen.getByText("$30.00/week")).toBeInTheDocument();
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

    const bodyText = document.body.textContent ?? "";
    const rowLabels = [
      "Full Season Total Due",
      "Amount Due to Date",
      "Amount Paid to Date",
      "Full Season Remaining Balance",
    ];
    expect(rowLabels.every((label) => bodyText.includes(label))).toBe(true);
    expect(rowLabels.slice(1).every((label, index) => bodyText.indexOf(label) > bodyText.indexOf(rowLabels[index]))).toBe(true);
    expect(screen.queryByText("Weekly Fee")).not.toBeInTheDocument();
    expect(screen.queryByText("Past Due")).not.toBeInTheDocument();
    expect(screen.queryByText("Season Paid in Full")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Make A Payment" })).toHaveAttribute("href", "/make-payment?leagueId=17");
  });

  it("links the dedicated payment flow from the bottom of the card", () => {
    render(<PaymentOverviewCard
      weeklyFee={3_000}
      paymentMode="weekly"
      leagueId={17}
      financials={{ fullSeasonAmount: 90_000, totalDueToDate: 90_000, totalPaid: 90_000, amountPastDue: 0, remainingBalance: 0 }}
    />);
    expect(screen.getByRole("link", { name: "Make A Payment" })).toHaveAttribute("href", "/make-payment?leagueId=17");
  });
});
