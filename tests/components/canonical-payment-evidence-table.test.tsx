import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CanonicalPaymentEvidenceTable } from "@/components/canonical-payment-evidence-table";
import type { CanonicalPaymentRow } from "@shared/canonical-payment-report";

const { csrfFetchMock } = vi.hoisted(() => ({ csrfFetchMock: vi.fn() }));
vi.mock("@/lib/queryClient", () => ({ csrfFetch: csrfFetchMock }));

beforeEach(() => {
  csrfFetchMock.mockReset();
  csrfFetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { receiptUrl: "https://receipt.example" } }), { status: 200 }));
});

const row = (overrides: Partial<CanonicalPaymentRow> = {}): CanonicalPaymentRow => ({
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
    await waitFor(() => expect(csrfFetchMock).toHaveBeenCalledWith("/api/payments-provider/payments/12/receipt?organizationId=11"));
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
});
