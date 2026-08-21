import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CanonicalPaymentEvidenceTable } from "@/components/canonical-payment-evidence-table";
import type { CanonicalPaymentRow } from "@shared/canonical-payment-report";

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
  it("renders null-payment unresolved evidence and exact allocation details", () => {
    render(<CanonicalPaymentEvidenceTable rows={[row()]} mode="canonical_with_unlinked_history" />);
    expect(screen.getByText(/canonical_with_unlinked_history/)).toBeInTheDocument();
    expect(screen.getByText(/operation evidence/)).toBeInTheDocument();
    expect(screen.getByText(/occurrence occ-1/)).toBeInTheDocument();
    expect(screen.getByText(/\$20\.00 USD/)).toBeInTheDocument();
    expect(screen.getByText(/dispute\/review evidence/)).toBeInTheDocument();
  });
});
