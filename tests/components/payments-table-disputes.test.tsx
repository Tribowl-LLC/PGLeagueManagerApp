import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PaymentsTable } from "@/components/payments-table";
import { SQUARE_DISPUTES_DASHBOARD_URL } from "@/components/payment-dispute-details";
import type { Payment, PaymentRowDisputeSummary } from "@shared/schema";
import type { CanonicalPaymentRow } from "@shared/canonical-payment-report";

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
    organizationId: 1,
    bowlerId,
    leagueId: 7,
    amount: 2500,
    currency: "USD",
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
    paymentOperationId: "11111111-1111-4111-8111-111111111111",
    createdAt: "2034-03-01T00:00:00.000Z",
    disputes: [DISPUTE],
  };
}

describe("PaymentsTable dispute visibility", () => {
  it("shows a shared-transaction dispute on every allocation with expandable sanitized history", async () => {
    const user = userEvent.setup();
    const payments = [payment(1, 10)];
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
        isRefundPending={false}
      />,
    );

    expect(screen.getAllByText("Dispute: Dispute accepted")).toHaveLength(1);
    expect(screen.getAllByText("paid")).toHaveLength(1);
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

  it("opens canonical allocation details from the payment status pill", async () => {
    const user = userEvent.setup();
    const payments = [payment(1, 10)];
    const evidence: CanonicalPaymentRow = {
      paymentId: 1, leagueId: 7, bowlerId: 10, amountMinor: 2500, currency: "USD",
      status: "confirmed_paid", paymentType: "cash", businessDate: "2034-03-01",
      authoritativeLocalDate: "2034-03-01", providerPaymentId: null,
      paymentOperationId: null, operationType: null, operationStatus: null,
      allocatedMinor: 2500, unallocatedMinor: 0, reviewRequired: false,
      source: "canonical_allocation", unresolved: false,
      refund: { present: false, amountMinor: 0, providerRefundId: null },
      dispute: { present: false, amountMinor: 0, disputeId: null },
      receipt: { contractVersion: "payment-receipt/1", availability: "unavailable", receiptUrl: null, receiptNumber: null, deliveryEvidence: "delivery_not_recorded" },
      allocations: [{ allocationId: "allocation-1", obligationId: "obligation-1", occurrenceId: "occurrence-1", occurrenceLocalDate: "2034-02-28", bowlerId: 10, amountMinor: 2500, currency: "USD", state: "active" }],
    };
    render(
      <PaymentsTable
        payments={payments}
        filteredPayments={payments}
        bowlers={[{ id: 10, name: "First Bowler" }] as never}
        isAdmin
        onRefund={() => {}}
        isRefundPending={false}
        paymentCanonicalRows={new Map([[1, evidence]])}
      />,
    );

    const trigger = screen.getByRole("button", { name: "View payment details: Confirmed paid" });
    expect(trigger.querySelector("div")).toBeNull();
    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "Payment Details" })).toBeInTheDocument();
    expect(screen.getByText("02/28/2034")).toBeInTheDocument();
  });
});
