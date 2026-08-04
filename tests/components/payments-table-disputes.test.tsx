import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PaymentsTable } from "@/components/payments-table";
import { SQUARE_DISPUTES_DASHBOARD_URL } from "@/components/payment-dispute-details";
import type { Payment, PaymentRowDisputeSummary } from "@shared/schema";

const DISPUTE: PaymentRowDisputeSummary = {
  id: "22222222-2222-4222-8222-222222222222",
  providerDisputeId: "safe-test-dispute-reference",
  amountMinor: 5000,
  currency: "USD",
  reason: "NO_KNOWLEDGE",
  state: "ACCEPTED",
  responseDueAt: "2020-01-01T00:00:00.000Z",
  providerUpdatedAt: "2034-03-08T00:05:00.000Z",
  providerVersion: 2,
  sharedTransaction: true,
  history: [
    {
      kind: "DISPUTE_STATE_UPDATED",
      state: "ACCEPTED",
      providerVersion: 2,
      recordedAt: "2034-03-08T00:05:01.000Z",
    },
    {
      kind: "DISPUTE_CREATED",
      state: "EVIDENCE_REQUIRED",
      providerVersion: 1,
      recordedAt: "2034-03-07T00:00:01.000Z",
    },
  ],
};

function payment(id: number, bowlerId: number): Payment & { disputes: PaymentRowDisputeSummary[] } {
  return {
    id,
    bowlerId,
    leagueId: 7,
    amount: 2500,
    lineageAmount: null,
    prizeFundAmount: null,
    weekOf: "2034-03-01T00:00:00.000Z",
    status: "paid",
    type: "cash",
    checkNumber: null,
    providerPaymentId: null,
    idempotencyKey: null,
    squareRefundId: null,
    refundReason: null,
    refundedAt: null,
    disputeId: null,
    disputedAt: null,
    receiptUrl: null,
    receiptNumber: null,
    receiptEmailMissing: false,
    notes: null,
    paidByUserId: null,
    combinedChargeGroupId: "shared-operation",
    paymentOperationId: "11111111-1111-4111-8111-111111111111",
    paymentOperationAllocationIndex: id - 1,
    createdAt: "2034-03-01T00:00:00.000Z",
    disputes: [DISPUTE],
  };
}

describe("PaymentsTable dispute visibility", () => {
  it("shows a shared-transaction dispute on every allocation with expandable sanitized history", async () => {
    const user = userEvent.setup();
    const payments = [payment(1, 10), payment(2, 11)];
    render(
      <PaymentsTable
        payments={payments}
        filteredPayments={payments}
        bowlers={[
          { id: 10, name: "First Bowler" },
          { id: 11, name: "Second Bowler" },
        ] as never}
        isAdmin
        onRefund={() => {}}
        onDelete={() => {}}
        isRefundPending={false}
        isDeletePending={false}
      />,
    );

    expect(screen.getAllByText("Dispute: Dispute accepted")).toHaveLength(2);
    expect(screen.getAllByText("paid")).toHaveLength(2);
    expect(screen.queryByText("Accepted by Square")).not.toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: "Show dispute details" })[0]);
    expect(screen.getByText(/applies to the shared Square transaction/i)).toBeInTheDocument();
    expect(screen.getByText(/not assigned to this bowler alone/i)).toBeInTheDocument();
    expect(screen.getByText("Reference: safe-test-dispute-reference")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open Square Disputes/i }))
      .toHaveAttribute("href", SQUARE_DISPUTES_DASHBOARD_URL);
    expect(screen.getByRole("list", { name: "Sanitized dispute state history" }))
      .toHaveTextContent("Dispute state updated");
    expect(screen.queryByText(/response deadline passed/i)).not.toBeInTheDocument();
  });
});
