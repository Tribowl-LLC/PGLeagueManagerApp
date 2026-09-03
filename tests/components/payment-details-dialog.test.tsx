import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PaymentDetailsDialog } from "@/components/payment-details-dialog";
import type { CanonicalPaymentRow } from "@shared/canonical-payment-report";
import type { Payment } from "@shared/schema";

const mocks = vi.hoisted(() => ({ csrfFetch: vi.fn(), invalidateQueries: vi.fn() }));
vi.mock("@/lib/queryClient", () => ({
  csrfFetch: mocks.csrfFetch,
  queryClient: { invalidateQueries: mocks.invalidateQueries },
}));

const payment: Payment = {
  id: 12,
  organizationId: 1,
  bowlerId: 42,
  leagueId: 7,
  amount: 5000,
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
  paymentOperationId: null,
  createdAt: "2034-09-10T00:00:00.000Z",
};

const evidence: CanonicalPaymentRow = {
  paymentId: 12,
  leagueId: 7,
  bowlerId: 42,
  amountMinor: 5000,
  currency: "USD",
  status: "confirmed_paid",
  paymentType: "cash",
  businessDate: "2034-09-10",
  authoritativeLocalDate: "2034-09-10",
  providerPaymentId: null,
  paymentOperationId: null,
  operationType: null,
  operationStatus: null,
  allocatedMinor: 5000,
  unallocatedMinor: 0,
  reviewRequired: false,
  source: "canonical_allocation",
  refund: { present: false, amountMinor: 0, providerRefundId: null },
  dispute: { present: false, amountMinor: 0, disputeId: null },
  unresolved: false,
  receipt: { contractVersion: "payment-receipt/1", availability: "unavailable", receiptUrl: null, receiptNumber: null, deliveryEvidence: "delivery_not_recorded" },
  allocations: [
    { allocationId: "allocation-1", obligationId: "obligation-1", occurrenceId: "occurrence-1", occurrenceLocalDate: "2034-09-03", bowlerId: 42, amountMinor: 3000, currency: "USD", state: "active" },
    { allocationId: "allocation-2", obligationId: "obligation-2", occurrenceId: "occurrence-2", occurrenceLocalDate: "2034-09-10", bowlerId: 42, amountMinor: 2000, currency: "USD", state: "active" },
  ],
};

beforeEach(() => {
  mocks.csrfFetch.mockReset();
  mocks.csrfFetch.mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }));
  mocks.invalidateQueries.mockReset();
  mocks.invalidateQueries.mockResolvedValue(undefined);
});

describe("PaymentDetailsDialog", () => {
  it("shows friendly canonical allocation dates without internal identifiers", () => {
    render(<PaymentDetailsDialog payment={payment} evidence={evidence} bowlerName="Test Bowler" canCorrect onClose={() => {}} />);

    expect(screen.getByRole("dialog", { name: "Payment Details" })).toBeInTheDocument();
    expect(screen.getByText("Confirmed paid")).toBeInTheDocument();
    expect(screen.getByText("09/03/2034")).toBeInTheDocument();
    expect(screen.getAllByText("09/10/2034").length).toBeGreaterThan(0);
    expect(screen.getByText("$30.00")).toBeInTheDocument();
    expect(screen.getByText("$20.00")).toBeInTheDocument();
    expect(screen.queryByText("occurrence-1")).not.toBeInTheDocument();
    expect(screen.queryByText("obligation-1")).not.toBeInTheDocument();
  });

  it("preserves the authorized cash correction flow and refreshes both projections", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<PaymentDetailsDialog payment={payment} evidence={evidence} bowlerName="Test Bowler" canCorrect onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "Void cash/check payment" }));
    await user.type(screen.getByRole("textbox", { name: "Correction reason" }), "Entered for the wrong bowler");
    await user.click(screen.getByRole("button", { name: "Void payment" }));

    await waitFor(() => expect(mocks.csrfFetch).toHaveBeenCalledTimes(1));
    expect(mocks.csrfFetch.mock.calls[0]?.[0]).toBe("/api/financials/leagues/7/canonical/corrections/1");
    expect(mocks.csrfFetch.mock.calls[0]?.[1]).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json" } });
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["/api/payments"] });
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["/api/financials/f5/payments"] });
    expect(onClose).toHaveBeenCalled();
  });

  it("does not offer corrections without permission", () => {
    render(<PaymentDetailsDialog payment={payment} evidence={evidence} bowlerName="Test Bowler" canCorrect={false} onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "Void cash/check payment" })).not.toBeInTheDocument();
  });

  it("fails closed when a paid row has unresolved canonical evidence", () => {
    render(<PaymentDetailsDialog payment={payment} evidence={{ ...evidence, source: "unresolved_operation", unresolved: true, reviewRequired: true }} bowlerName="Test Bowler" canCorrect={false} onClose={() => {}} />);
    expect(screen.getAllByText("Review required").length).toBeGreaterThan(0);
    expect(screen.queryByText("Confirmed paid")).not.toBeInTheDocument();
  });

  it("does not offer manual correction for provider payments", () => {
    render(<PaymentDetailsDialog payment={{ ...payment, type: "credit_card" }} evidence={{ ...evidence, paymentType: "credit_card" }} bowlerName="Test Bowler" canCorrect onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "Void cash/check payment" })).not.toBeInTheDocument();
  });
});
