import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PaymentDetailsDialog } from "@/components/payment-details-dialog";
import type { CanonicalPaymentRow } from "@shared/canonical-payment-report";
import type { Payment } from "@shared/schema";

const mocks = vi.hoisted(() => ({ csrfFetch: vi.fn(), invalidateQueries: vi.fn() }));
vi.mock("@/lib/queryClient", () => ({
  csrfFetch: mocks.csrfFetch,
  queryClient: { invalidateQueries: mocks.invalidateQueries },
}));
vi.mock("../../server/storage", () => ({ storage: { getLeague: vi.fn() } }));
vi.mock("../../server/storage/index.js", () => ({ storage: { getLeague: vi.fn() } }));
vi.mock("../../server/db.js", () => ({ db: {} }));
vi.mock("../../server/services/roster-payment-archive-report.js", () => ({
  readCanonicalPaymentReport: vi.fn(),
  CanonicalPaymentReportIncompatibilityError: class extends Error {},
}));
vi.mock("../../server/utils/access-control.js", () => ({
  hasAdminAccessToLeague: vi.fn(),
  hasPaymentManagerAccessToLeague: vi.fn(),
  isPaymentManager: vi.fn(),
}));

const { redactCanonicalPaymentRow } = await import("../../server/routes/financials-f5.js");

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

type NamedPaymentEvidence = CanonicalPaymentRow & {
  paidByName?: string | null;
  allocations: Array<CanonicalPaymentRow["allocations"][number] & { bowlerName?: string | null }>;
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
    expect(screen.queryByText(/Canonical settlement and allocation details/)).not.toBeInTheDocument();
  });

  it("labels a payer tender and renders the server-provided recipient breakdown", () => {
    const payerEvidence: NamedPaymentEvidence = {
      ...evidence,
      paidByName: "Alex Payer",
      allocations: [
        { ...evidence.allocations[0], bowlerName: "Alex Payer", plannedOrdinal: 1 },
        { ...evidence.allocations[1], bowlerName: "Partner Bowler", plannedOrdinal: 2 },
      ],
    };

    render(<PaymentDetailsDialog payment={payment} evidence={payerEvidence} bowlerName="Alex Payer" canCorrect={false} onClose={() => {}} />);

    expect(screen.getByText("Payment total")).toBeInTheDocument();
    expect(screen.getByText("Paid by").parentElement).toHaveTextContent("Alex Payer");
    expect(screen.getByText("Payment breakdown")).toBeInTheDocument();
    expect(screen.getByText("Partner Bowler")).toBeInTheDocument();
    expect(screen.getByText("Week 2")).toBeInTheDocument();
    expect(screen.getByText("$20.00")).toBeInTheDocument();
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

  it("edits cash amount and date with one retry-stable command", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<PaymentDetailsDialog payment={payment} evidence={evidence} bowlerName="Test Bowler" canCorrect startInEdit onClose={onClose} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Save payment edit" })).toBeInTheDocument());
    const amount = screen.getByRole("textbox", { name: "Payment amount" });
    await user.clear(amount);
    await user.type(amount, "60.00");
    fireEvent.change(screen.getByLabelText("Payment date"), { target: { value: "2034-09-17" } });
    await user.click(screen.getByRole("button", { name: "Save payment edit" }));

    await waitFor(() => expect(mocks.csrfFetch).toHaveBeenCalledTimes(1));
    const firstRequest = mocks.csrfFetch.mock.calls[0]?.[1] as RequestInit;
    const firstBody = JSON.parse(String(firstRequest.body)) as Record<string, unknown>;
    expect(firstBody).toMatchObject({ correctionMode: "edit_cash", amountMinor: 6000, paymentDate: "2034-09-17" });
    expect(firstBody.idempotencyKey).toEqual(firstRequest.headers && (firstRequest.headers as Record<string, string>)["Idempotency-Key"]);
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["/api/bowlers/42/details"] });
    expect(onClose).toHaveBeenCalled();
  });

  it("does not reopen the initial edit form after cancel", async () => {
    const user = userEvent.setup();
    render(<PaymentDetailsDialog payment={payment} evidence={evidence} bowlerName="Test Bowler" canCorrect startInEdit onClose={() => {}} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Save payment edit" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("button", { name: "Save payment edit" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit cash payment" })).toBeInTheDocument();
  });

  it("does not offer corrections without permission", () => {
    render(<PaymentDetailsDialog payment={payment} evidence={evidence} bowlerName="Test Bowler" canCorrect={false} onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "Void cash/check payment" })).not.toBeInTheDocument();
  });

  it("renders evidence-only details without manufacturing a payment", () => {
    render(<PaymentDetailsDialog
      payment={null}
      evidence={{ ...evidence, paymentId: null, paymentType: "check", waivedMinor: 500, allocations: [], operationType: "interactive_charge", operationStatus: "provider_unknown" }}
      bowlerName="Test Bowler"
      canCorrect
      onClose={() => {}}
    />);

    expect(screen.getByRole("dialog", { name: "Payment Details" })).toBeInTheDocument();
    expect(screen.getByText("Payment type").parentElement).toHaveTextContent("Check");
    expect(screen.getByText(/Waived roster amount: \$5\.00/)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Payment operation evidence" })).toHaveTextContent("provider unknown");
    expect(screen.queryByRole("button", { name: "Void cash/check payment" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Receipt" })).not.toBeInTheDocument();
  });

  it("renders the ordinary-reader applied-to projection with stored week labels", () => {
    render(<PaymentDetailsDialog
      payment={null}
      evidence={{ ...evidence, paymentId: null, allocations: [], appliedTo: [
        { plannedOrdinal: 1, occurrenceLocalDate: "2034-09-03", amountMinor: 3000, refundedMinor: 0, effectiveAmountMinor: 3000, refundDisposition: null, currency: "USD", state: "active" },
        { plannedOrdinal: 2, occurrenceLocalDate: "2034-09-10", amountMinor: 2000, refundedMinor: 2000, effectiveAmountMinor: 0, refundDisposition: "still_owed", currency: "USD", state: "voided" },
      ] }}
      bowlerName="Test Bowler"
      canCorrect={false}
      onClose={() => {}}
    />);

    expect(screen.getByText("Week 1")).toBeInTheDocument();
    expect(screen.getByText("Week 2")).toBeInTheDocument();
    expect(screen.getByText("09/03/2034")).toBeInTheDocument();
    expect(screen.getByText("Refunded: $20.00")).toBeInTheDocument();
    expect(screen.queryByText("No canonical allocation is recorded.")).not.toBeInTheDocument();
    expect(screen.queryByText("allocation-1")).not.toBeInTheDocument();
  });

  it("renders the exact ordinary API redaction without exposing child identities", () => {
    const redacted = redactCanonicalPaymentRow({
      ...evidence,
      initiatingPayerBowlerId: 42,
      status: "pending",
      source: "unresolved_operation",
      unresolved: true,
      reviewRequired: true,
      allocations: [
        { allocationId: "allocation-secret", obligationId: "obligation-secret", occurrenceId: "occurrence-secret", plannedOrdinal: 3, occurrenceLocalDate: "2034-09-17", bowlerId: 42, amountMinor: 3000, currency: "USD", state: null },
        { allocationId: "allocation-other", obligationId: "obligation-other", occurrenceId: "occurrence-other", plannedOrdinal: 4, occurrenceLocalDate: "2034-09-24", bowlerId: 43, amountMinor: 2000, currency: "USD", state: null },
        { allocationId: "allocation-special", obligationId: "obligation-special", occurrenceId: "occurrence-special", plannedOrdinal: null, occurrenceLocalDate: "2034-10-01", bowlerId: 43, amountMinor: 1000, currency: "USD", state: null },
      ],
    }, 42);

    expect(redacted.allocations).toEqual([]);
    expect(redacted.appliedTo).toEqual([
      expect.objectContaining({ plannedOrdinal: 3, occurrenceLocalDate: "2034-09-17", amountMinor: 3000, state: null }),
      expect.objectContaining({ plannedOrdinal: 4, occurrenceLocalDate: "2034-09-24", amountMinor: 2000, state: null }),
      expect.objectContaining({ plannedOrdinal: null, occurrenceLocalDate: "2034-10-01", amountMinor: 1000, state: null }),
    ]);
    expect(redacted.appliedTo?.[0]).not.toHaveProperty("allocationId");
    render(<PaymentDetailsDialog payment={null} evidence={redacted} bowlerName="Test Bowler" canCorrect={false} onClose={() => {}} />);
    expect(screen.getByText("Week 3")).toBeInTheDocument();
    expect(screen.getByText("Week 4")).toBeInTheDocument();
    expect(screen.getByText("10/01/2034")).toBeInTheDocument();
    expect(screen.getAllByText("unresolved").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Effective:/)).not.toBeInTheDocument();
    expect(screen.queryByText("No canonical allocation is recorded.")).not.toBeInTheDocument();
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

  it("labels provider card evidence as Credit Card", () => {
    render(<PaymentDetailsDialog payment={{ ...payment, type: "square" }} evidence={{ ...evidence, paymentType: "square" }} bowlerName="Test Bowler" canCorrect={false} onClose={() => {}} />);
    expect(screen.getByText("Credit Card")).toBeInTheDocument();
    expect(screen.queryByText("Square")).not.toBeInTheDocument();
  });

  it("opens canonical receipts through the organization-scoped endpoint", async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    mocks.csrfFetch.mockResolvedValueOnce(new Response(JSON.stringify({ data: { receiptUrl: "https://receipt.example.test" } }), { status: 200 }));
    render(<PaymentDetailsDialog payment={payment} evidence={{ ...evidence, status: "refunded" }} bowlerName="Test Bowler" canCorrect={false} organizationId={11} onClose={() => {}} />);

    const receiptButton = screen.getByRole("button", { name: "Receipt" });
    expect(receiptButton.parentElement?.querySelectorAll("button")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Receipt" }));
    await waitFor(() => expect(mocks.csrfFetch).toHaveBeenCalledWith("/api/payments-provider/payments/12/receipt"));
    expect(open).toHaveBeenCalledWith("https://receipt.example.test", "_blank", "noopener,noreferrer");
    open.mockRestore();
  });

  it("hides receipts when the evidence projection disallows opening them", () => {
    render(<PaymentDetailsDialog
      payment={payment}
      evidence={{ ...evidence, receipt: { ...evidence.receipt, canOpenReceipt: false } }}
      bowlerName="Test Bowler"
      canCorrect={false}
      onClose={() => {}}
    />);

    expect(screen.queryByRole("button", { name: "Receipt" })).not.toBeInTheDocument();
  });

  it("keeps payer receipt lookup available for lazy backfill", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    mocks.csrfFetch.mockResolvedValueOnce(new Response(JSON.stringify({ data: { receiptUrl: "https://receipt.example.test" } }), { status: 200 }));
    render(<PaymentDetailsDialog
      payment={payment}
      evidence={{ ...evidence, receipt: { ...evidence.receipt, availability: "unavailable", canOpenReceipt: true } }}
      bowlerName="Test Bowler"
      canCorrect={false}
      onClose={() => {}}
    />);

    await userEvent.setup().click(screen.getByRole("button", { name: "Receipt" }));
    await waitFor(() => expect(mocks.csrfFetch).toHaveBeenCalledWith("/api/payments-provider/payments/12/receipt"));
    expect(open).toHaveBeenCalledWith("https://receipt.example.test", "_blank", "noopener,noreferrer");
    open.mockRestore();
  });
});
