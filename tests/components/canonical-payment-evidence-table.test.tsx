import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CanonicalPaymentEvidenceTable } from "@/components/canonical-payment-evidence-table";
import { canonicalCreditFundingSource } from "@shared/canonical-payment-report";
import { paymentReceiptContract } from "@shared/payment-receipt";
import type { CanonicalPaymentRow } from "@shared/canonical-payment-report";

const { csrfFetchMock } = vi.hoisted(() => ({ csrfFetchMock: vi.fn() }));
vi.mock("@/lib/queryClient", () => ({ csrfFetch: csrfFetchMock }));

beforeEach(() => {
  csrfFetchMock.mockReset();
  csrfFetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { receiptUrl: "https://receipt.example" } }), { status: 200 }));
});

type PaymentRowFixture = Omit<CanonicalPaymentRow, "receipt"> & {
  receipt: CanonicalPaymentRow["receipt"] & { canOpenReceipt?: boolean };
  paidByName?: string | null;
};

const row = (overrides: Partial<PaymentRowFixture> = {}): PaymentRowFixture => ({
  paymentId: null,
  leagueId: 7,
  bowlerId: 42,
  amountMinor: 2000,
  currency: "USD",
  status: "unresolved",
  paymentType: "square",
  businessDate: "2038-02-03T19:00:00.000Z",
  authoritativeLocalDate: "2038-02-03",
  providerPaymentId: null,
  paymentOperationId: "op-1",
  operationType: "interactive_charge",
  operationStatus: "provider_unknown",
  allocatedMinor: 0,
  unallocatedMinor: 2000,
  reviewRequired: true,
  source: "unresolved_operation",
  refund: { present: false, amountMinor: 0, providerRefundId: null },
  dispute: { present: true, amountMinor: 0, disputeId: null },
  unresolved: true,
  receipt: { contractVersion: "payment-receipt/1", availability: "unavailable", receiptUrl: null, receiptNumber: null, deliveryEvidence: "delivery_not_recorded", source: "unresolved_operation" },
  allocations: [{ allocationId: null, obligationId: "ob-1", occurrenceId: "occ-1", bowlerId: 42, amountMinor: 2000, currency: "USD", state: "active" }],
  ...overrides,
});

describe("CanonicalPaymentEvidenceTable", () => {
  it("keeps applied credit canonical and distinguishes available, held, and fully refunded lots", () => {
    expect(canonicalCreditFundingSource({ amountMinor: 2_000, allocatedMinor: 500, completedRefundMinor: 0, heldRefundMinor: 0 }))
      .toBe("canonical_allocation");
    expect(canonicalCreditFundingSource({ amountMinor: 2_000, allocatedMinor: 0, completedRefundMinor: 500, heldRefundMinor: 0 }))
      .toBe("prepaid_credit");
    expect(canonicalCreditFundingSource({ amountMinor: 2_000, allocatedMinor: 0, completedRefundMinor: 0, heldRefundMinor: 2_000 }))
      .toBe("held_credit");
    expect(canonicalCreditFundingSource({ amountMinor: 2_000, allocatedMinor: 0, completedRefundMinor: 2_000, heldRefundMinor: 0 }))
      .toBe("refunded_credit");
  });

  it("preserves held and completed credit refund sources in receipt evidence", () => {
    const heldReceipt = paymentReceiptContract({ receiptUrl: null, receiptNumber: null, source: "held_credit" });
    const refundedReceipt = paymentReceiptContract({ receiptUrl: "https://receipt.example", receiptNumber: "R-Refunded", source: "refunded_credit" });

    expect(heldReceipt.source).toBe("held_credit");
    expect(refundedReceipt.source).toBe("refunded_credit");
    expect(refundedReceipt.availability).toBe("available");
  });

  it("does not show a payment-timing caption under the history title", () => {
    render(<CanonicalPaymentEvidenceTable rows={[row()]} />);
    expect(screen.queryByTestId("payment-timing")).not.toBeInTheDocument();
    expect(screen.queryByText(/Weekly payment|Upfront payment/)).not.toBeInTheDocument();
  });

  it("renders null-payment evidence in the clean history and opens details", async () => {
    render(<CanonicalPaymentEvidenceTable rows={[row({ collectionEvidence: { d2PlanId: "plan-1", planVersion: 2, collectionPointOccurrenceId: "occ-1", coveredOccurrenceIds: ["occ-1", "occ-2"], timing: "at_collection_point", grouping: "double_pay" } })]} organizationId={11} />);
    expect(screen.getByRole("columnheader", { name: "Date" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Amount" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Payment Method" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Status" })).toBeInTheDocument();
    expect(screen.getByText("02/03/2038")).toBeInTheDocument();
    expect(screen.getAllByText("Square").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "View payment details: Review required" })).toBeInTheDocument();
    expect(screen.queryByText("occ-1")).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "View payment details: Review required" }));
    expect(screen.getByRole("dialog", { name: "Payment Details" })).toBeInTheDocument();
    expect(screen.getByText("Payment type").parentElement).toHaveTextContent("Credit Card");
    expect(screen.getByRole("region", { name: "Collection evidence" })).toHaveTextContent("Double payment");
    expect(screen.getByRole("region", { name: "Collection evidence" })).toHaveTextContent("occ-1");
    expect(screen.getByText(/dispute/i)).toBeInTheDocument();
  });

  it("opens details from a status and scopes receipt lookup", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<CanonicalPaymentEvidenceTable rows={[row({
      paymentId: 12,
      status: "refunded",
      unresolved: false,
      source: "canonical_allocation",
      amountMinor: 3000,
      allocations: [
        { allocationId: "a1", obligationId: "ob-1", occurrenceId: "occ-1", bowlerId: 42, amountMinor: 2000, currency: "USD", state: "active" },
        { allocationId: "a2", obligationId: "ob-2", occurrenceId: "occ-2", bowlerId: 42, amountMinor: 1000, currency: "USD", state: "voided" },
      ],
      refund: { present: true, amountMinor: 1000, providerRefundId: null },
      dispute: { present: true, amountMinor: 0, disputeId: null, scope: "transaction", state: "OPEN", reviewRequired: true },
      receipt: { ...row().receipt, source: "canonical_allocation", availability: "available", receiptUrl: "https://cached", receiptNumber: "R-1" },
    })]} organizationId={11} />);
    expect(screen.getByRole("button", { name: "View payment details: Refunded" })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "View payment details: Refunded" }));
    expect(screen.getByText("$20.00")).toBeInTheDocument();
    expect(screen.getByText("$10.00")).toBeInTheDocument();
    expect(screen.getByText(/Refunded:/)).toBeInTheDocument();
    expect(screen.getByText(/Dispute:/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Receipt" }));
    await waitFor(() => expect(csrfFetchMock).toHaveBeenCalledWith("/api/payments-provider/payments/12/receipt"));
    open.mockRestore();
  });

  it("does not offer a receipt when the ordinary-reader projection marks it unavailable", async () => {
    render(<CanonicalPaymentEvidenceTable rows={[row({
      paymentId: 12,
      status: "confirmed_paid",
      unresolved: false,
      source: "canonical_allocation",
      receipt: { ...row().receipt, source: "canonical_allocation", availability: "unavailable", canOpenReceipt: false },
    })]} />);

    await fireEvent.click(screen.getByRole("button", { name: "View payment details: Confirmed paid" }));
    expect(screen.queryByRole("button", { name: "Receipt" })).not.toBeInTheDocument();
  });

  it("keeps payer receipt lookup available when the URL needs lazy backfill", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<CanonicalPaymentEvidenceTable rows={[row({
      paymentId: 12,
      status: "confirmed_paid",
      unresolved: false,
      source: "canonical_allocation",
      receipt: { ...row().receipt, source: "canonical_allocation", availability: "unavailable", canOpenReceipt: true },
    })]} />);

    await fireEvent.click(screen.getByRole("button", { name: "View payment details: Confirmed paid" }));
    await fireEvent.click(screen.getByRole("button", { name: "Receipt" }));
    await waitFor(() => expect(csrfFetchMock).toHaveBeenCalledWith("/api/payments-provider/payments/12/receipt"));
    open.mockRestore();
  });

  it("keeps review and correction indicators visible when the settlement is paid", () => {
    render(<CanonicalPaymentEvidenceTable rows={[row({
      paymentId: 12,
      status: "confirmed_paid",
      source: "canonical_allocation",
      unresolved: false,
      reviewRequired: true,
      correctionEvidence: { status: "voided", voidId: "void-1" },
    })]} />);

    expect(screen.getByRole("button", { name: "View payment details: Confirmed paid" })).toBeInTheDocument();
    expect(screen.getByText("Review required")).toBeInTheDocument();
    expect(screen.getByText("Voided")).toBeInTheDocument();
  });

  it("shows the server-provided payer name in history", () => {
    render(<CanonicalPaymentEvidenceTable rows={[row({ status: "confirmed_paid", source: "canonical_allocation", unresolved: false, paidByName: "Alex Payer" })]} />);
    expect(screen.getByText("Paid by Alex Payer")).toBeInTheDocument();
  });

  it("marks unused share credit without replacing the paid status, tender, or receipt", async () => {
    render(<CanonicalPaymentEvidenceTable rows={[row({
      paymentId: 52,
      status: "confirmed_paid",
      paymentType: "cash",
      source: "prepaid_credit",
      unresolved: false,
      reviewRequired: false,
      allocatedMinor: 0,
      unallocatedMinor: 2000,
      allocations: [],
      receipt: { ...row().receipt, source: "prepaid_credit", availability: "available", canOpenReceipt: true, receiptUrl: "https://receipt.example", receiptNumber: "R-Share" },
    })]} />);

    expect(screen.getByText("Unused share credit")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View payment details: Confirmed paid" })).toBeInTheDocument();
    expect(screen.getAllByText("Cash").length).toBeGreaterThan(0);

    await fireEvent.click(screen.getByRole("button", { name: "View payment details: Confirmed paid" }));
    expect(screen.getByRole("dialog", { name: "Payment Details" })).toBeInTheDocument();
    expect(screen.getByText("Payment type").parentElement).toHaveTextContent("Cash");
    expect(screen.getByText("Credit application").parentElement).toHaveTextContent("Unused share credit");
    expect(screen.getByRole("button", { name: "Receipt" })).toBeInTheDocument();
  });

  it("marks a fully refunded unallocated share credit without implying it was applied", async () => {
    render(<CanonicalPaymentEvidenceTable rows={[row({
      paymentId: 53,
      status: "confirmed_paid",
      paymentType: "cash",
      source: "refunded_credit",
      unresolved: false,
      reviewRequired: false,
      allocatedMinor: 0,
      unallocatedMinor: 0,
      allocations: [],
      refund: { present: true, amountMinor: 2000, providerRefundId: null },
      creditRefunds: { completedAmountMinor: 2000, heldAmountMinor: 0, reviewRequired: false, providerRefundIds: [] },
      receipt: { ...row().receipt, source: "refunded_credit", availability: "available", canOpenReceipt: true, receiptUrl: "https://receipt.example", receiptNumber: "R-Refunded-Share" },
    })]} />);

    expect(screen.getByText("Refunded share credit")).toBeInTheDocument();
    expect(screen.queryByText("Unused share credit")).not.toBeInTheDocument();
    expect(screen.getAllByText("Cash").length).toBeGreaterThan(0);

    await fireEvent.click(screen.getByRole("button", { name: "View payment details: Confirmed paid" }));
    expect(screen.getByText("Credit application").parentElement).toHaveTextContent("Refunded share credit");
    expect(screen.getByText("This share credit was refunded in full before it was applied to a league date.")).toBeInTheDocument();
    expect(screen.getByText("Refunded: $20.00")).toBeInTheDocument();
    expect(screen.queryByText(/Unallocated:/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Receipt" })).toBeInTheDocument();
  });

  it("marks a fully held credit refund as on hold rather than refunded", async () => {
    render(<CanonicalPaymentEvidenceTable rows={[row({
      paymentId: 54,
      status: "review_required",
      paymentType: "check",
      source: "held_credit",
      unresolved: true,
      reviewRequired: true,
      allocatedMinor: 0,
      unallocatedMinor: 0,
      allocations: [],
      refund: { present: false, amountMinor: 0, providerRefundId: null },
      creditRefunds: { completedAmountMinor: 0, heldAmountMinor: 2000, reviewRequired: true, providerRefundIds: [] },
      receipt: { ...row().receipt, source: "held_credit" },
    })]} />);

    expect(screen.getByText("Share credit refund on hold")).toBeInTheDocument();
    expect(screen.queryByText("Refunded share credit")).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "View payment details: Review required" }));
    expect(screen.getByText("Credit status").parentElement).toHaveTextContent("Refund on hold");
    expect(screen.getByText(/refund is unresolved/)).toBeInTheDocument();
    expect(screen.getByText("Refund on hold: $20.00")).toBeInTheDocument();
    expect(screen.queryByText(/Refunded: \$20\.00/)).not.toBeInTheDocument();
    expect(screen.getAllByText("Check").length).toBeGreaterThan(0);
  });
});
