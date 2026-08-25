import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CanonicalPaymentEvidenceTable, dollarsToMinorUnits } from "@/components/canonical-payment-evidence-table";
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
  source: "unlinked_legacy",
  refund: { present: false, amountMinor: 0, providerRefundId: null },
  dispute: { present: true, amountMinor: 0, disputeId: null },
  unresolved: true,
  receipt: { contractVersion: "payment-receipt/1", availability: "unavailable", receiptUrl: null, receiptNumber: null, deliveryEvidence: "delivery_not_recorded", source: "unlinked_legacy" },
  allocations: [{ allocationId: null, obligationId: "ob-1", occurrenceId: "occ-1", bowlerId: 42, amountMinor: 2000, currency: "USD", state: "active" }],
  ...overrides,
});

describe("CanonicalPaymentEvidenceTable", () => {
  it("converts operator dollar input to deterministic minor units", () => {
    expect(dollarsToMinorUnits("20")).toBe(2000);
    expect(dollarsToMinorUnits("20.5")).toBe(2050);
    expect(dollarsToMinorUnits("20.05")).toBe(2005);
    expect(dollarsToMinorUnits("20.005")).toBeNull();
    expect(dollarsToMinorUnits("$20.00")).toBeNull();
    expect(dollarsToMinorUnits("0.00")).toBeNull();
  });

  it("labels roster-driven timing as canonical billing", () => {
    render(<CanonicalPaymentEvidenceTable rows={[row()]} paymentTiming={{ paymentMode: "weekly", upfrontDueAt: null, timezone: "America/Chicago", source: "roster_payment_responsibility" }} />);
    expect(screen.getByTestId("payment-timing")).toHaveTextContent("roster-driven canonical billing");
  });

  it("renders null-payment unresolved evidence and exact allocation details", () => {
    render(<CanonicalPaymentEvidenceTable rows={[row({ collectionEvidence: { d2PlanId: "plan-1", planVersion: 2, collectionPointOccurrenceId: "occ-1", coveredOccurrenceIds: ["occ-1", "occ-2"], timing: "at_collection_point", grouping: "double_pay" } })]} mode="canonical_with_unlinked_history" paymentTiming={{ paymentMode: "upfront", upfrontDueAt: "2038-02-01T00:00:00.000Z", timezone: "America/Los_Angeles", source: "canonical_activation" }} organizationId={11} />);
    expect(screen.getByText(/canonical_with_unlinked_history/)).toBeInTheDocument();
    expect(screen.getByTestId("payment-timing")).toHaveTextContent("Upfront payment");
    expect(screen.getByTestId("payment-timing")).toHaveTextContent("timezone America/Los_Angeles");
    expect(screen.getByText(/double-pay collection/)).toBeInTheDocument();
    expect(screen.getByText(/operation evidence/)).toBeInTheDocument();
    expect(screen.getByText(/\$20\.00 · active · occurrence occ-1/)).toBeInTheDocument();
    expect(screen.getAllByText(/\$20\.00/).length).toBeGreaterThan(0);
    expect(screen.getByText(/dispute\/review evidence/)).toBeInTheDocument();
  });

  it("formats every allocation, preserves evidence labels, and scopes receipt lookup", async () => {
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
    })]} organizationId={11} mode="canonical" />);
    expect(screen.getByText(/\$20\.00 · active/)).toBeInTheDocument();
    expect(screen.getByText(/\$10\.00 · voided/)).toBeInTheDocument();
    expect(screen.getByText(/refunded \$10\.00/)).toBeInTheDocument();
    expect(screen.getByText(/dispute\/review evidence \(transaction\) · OPEN/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Receipt" }));
    await waitFor(() => expect(csrfFetchMock).toHaveBeenCalledWith("/api/payments-provider/payments/12/receipt?organizationId=11"));
  });
});
