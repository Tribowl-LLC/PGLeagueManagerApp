import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PaymentOverviewCard } from "@/components/payment-overview-card";

describe("PaymentOverviewCard", () => {
  it("shows the payment data without explanatory copy", () => {
    render(<PaymentOverviewCard
      weeklyFee={3_000}
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
});
