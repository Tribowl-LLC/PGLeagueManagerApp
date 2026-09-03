import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import PaymentsPage from "@/pages/payments-page";
import type { CanonicalPaymentReport, CanonicalPaymentRow } from "@shared/canonical-payment-report";

vi.mock("wouter", async (importOriginal) => {
  const original = await importOriginal<typeof import("wouter")>();
  return { ...original, useLocation: () => ["/payments", vi.fn()] };
});
vi.mock("@/components/layout", () => ({ Layout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

const orphanRow: CanonicalPaymentRow = {
  paymentId: null, leagueId: 7, bowlerId: 42, amountMinor: 3000, currency: "USD",
  status: "unresolved", paymentType: "credit_card", businessDate: "2034-09-03",
  authoritativeLocalDate: "2034-09-03", providerPaymentId: null,
  paymentOperationId: "operation-1", operationType: "interactive_charge", operationStatus: "provider_unknown",
  allocatedMinor: 0, unallocatedMinor: 3000, reviewRequired: true,
  source: "unresolved_operation", unresolved: true,
  refund: { present: false, amountMinor: 0, providerRefundId: null },
  dispute: { present: false, amountMinor: 0, disputeId: null },
  receipt: { contractVersion: "payment-receipt/1", availability: "unavailable", receiptUrl: null, receiptNumber: null, deliveryEvidence: "delivery_not_recorded" },
  allocations: [],
};

function report(rows: CanonicalPaymentRow[]): CanonicalPaymentReport {
  return {
    contractVersion: "canonical-payment-report/2",
    orderVersion: "league,business-date,bowler,occurrence,allocation,payment/2",
    organizationId: 1,
    leagueId: 7,
    mode: "canonical",
    authoritativeSource: "canonical",
    asOf: "2034-09-03T12:00:00.000Z",
    fingerprint: "lvpaymentreport:v2:test",
    page: 1,
    limit: 50,
    totalRows: rows.length,
    totalTransactions: rows.length,
    totals: { grossConfirmedPaidMinor: 0, activeAllocatedMinor: 0, refundedMinor: 0, disputedReviewRequiredMinor: 0, reviewRequiredMinor: 3000, unresolvedOperationMinor: 3000 },
    rows,
    transactions: [],
    paymentTiming: { paymentMode: "weekly", upfrontDueAt: null, timezone: "America/Detroit", source: "canonical" },
  };
}

function renderPage(rows: CanonicalPaymentRow[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, queryFn: async () => ({ data: [] }) } } });
  client.setQueryData(["/api/user"], { success: true, data: { id: 1, role: "org_admin", organizationId: 1 } });
  client.setQueryData(["/api/leagues"], { data: [{ id: 7, name: "Test League", organizationId: 1, locationId: 2 }] });
  client.setQueryData(["/api/payments", "paginated", "with-disputes", 1, 50], { success: true, data: [], pagination: { page: 1, limit: 50, total: 0, totalPages: 1 } });
  client.setQueryData(["/api/financials/f5/payments", 7, 1, 50, 1, "org_admin"], { data: report(rows) });
  return render(<QueryClientProvider client={client}><PaymentsPage /></QueryClientProvider>);
}

describe("PaymentsPage canonical evidence presentation", () => {
  it("removes the duplicate raw evidence table but keeps orphaned operations visible", async () => {
    renderPage([orphanRow]);

    expect(await screen.findByRole("heading", { name: "Payments needing review" })).toBeInTheDocument();
    expect(screen.getByText("$30.00")).toBeInTheDocument();
    expect(screen.queryByText("Financial payment evidence")).not.toBeInTheDocument();
    expect(screen.queryByTestId("canonical-payment-evidence-table")).not.toBeInTheDocument();
  });

  it("does not render a review section when there is no orphaned evidence", async () => {
    renderPage([]);
    expect(await screen.findByRole("heading", { name: "Payments" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Payments needing review" })).not.toBeInTheDocument();
  });
});
