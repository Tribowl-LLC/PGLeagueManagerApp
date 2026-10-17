import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import PaymentsPage, { invalidateRefundPaymentViews, refundAffectedBowlerIds } from "@/pages/payments-page";
import { queryClient } from "@/lib/queryClient";
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

const voidedCashRow: CanonicalPaymentRow = {
  ...orphanRow,
  paymentId: 73,
  bowlerId: 42,
  amountMinor: 3000,
  currency: "USD",
  status: "review_required",
  paymentType: "cash",
  businessDate: "2034-09-03",
  authoritativeLocalDate: "2034-09-03",
  providerPaymentId: null,
  paymentOperationId: null,
  operationType: null,
  operationStatus: null,
  allocatedMinor: 3000,
  unallocatedMinor: 0,
  reviewRequired: false,
  source: "canonical_allocation",
  unresolved: false,
  refund: { present: false, amountMinor: 0, providerRefundId: null },
  dispute: { present: false, amountMinor: 0, disputeId: null },
  allocations: [{
    allocationId: "voided-cash-allocation",
    obligationId: "voided-cash-obligation",
    occurrenceId: "voided-cash-occurrence",
    occurrenceLocalDate: "2034-09-03",
    bowlerId: 42,
    amountMinor: 3000,
    currency: "USD",
    state: "voided",
  }],
  correctionEvidence: { status: "voided", voidId: "voided-cash-void" },
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
  client.setQueryData(["/api/leagues"], { data: [
    { id: 7, name: "Test League", organizationId: 1, locationId: 2, active: true },
    { id: 8, name: "Archived League", organizationId: 1, locationId: 2, active: false },
  ] });
  client.setQueryData(["/api/payments", "paginated", "with-disputes", 1, 50], { success: true, data: [], pagination: { page: 1, limit: 50, total: 0, totalPages: 1 } });
  client.setQueryData(["/api/bowlers"], { data: [{ id: 42, name: "Review Bowler", organizationId: 1 }] });
  client.setQueryData(["/api/financials/f5/payments", 7, 1, 50, 1, "org_admin"], { data: report(rows) });
  return render(<QueryClientProvider client={client}><PaymentsPage /></QueryClientProvider>);
}

describe("PaymentsPage canonical evidence presentation", () => {
  it("removes the duplicate raw evidence table but keeps orphaned operations visible", async () => {
    renderPage([orphanRow]);

    expect(await screen.findByRole("heading", { name: "Payments needing review" })).toBeInTheDocument();
    expect(screen.getByText("Review Bowler")).toBeInTheDocument();
    expect(screen.getByText("$30.00")).toBeInTheDocument();
    expect(screen.getByTestId("payment-timing-summary")).toHaveTextContent("Weekly payment · timezone America/Detroit · canonical billing");
    expect(screen.queryByText("Financial payment evidence")).not.toBeInTheDocument();
    expect(screen.queryByTestId("canonical-payment-evidence-table")).not.toBeInTheDocument();
  });

  it("does not render a review section when there is no orphaned evidence", async () => {
    renderPage([]);
    expect(await screen.findByRole("heading", { name: "Payments" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Payments needing review" })).not.toBeInTheDocument();
  });

  it("preserves voided status for canonical-only rows and exposes cash deletion", async () => {
    const user = userEvent.setup();
    renderPage([voidedCashRow]);

    await user.click(await screen.findByRole("button", { name: "Void or delete cash payment" }));

    expect(await screen.findByRole("button", { name: "Delete cash payment" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit cash payment" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Void cash payment" })).not.toBeInTheDocument();
  });

  it("lists only active leagues in the financial scope selector", async () => {
    const user = userEvent.setup();
    renderPage([]);

    await user.click(await screen.findByRole("combobox", { name: "Financial league scope" }));

    expect(screen.getByRole("option", { name: "Test League" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Archived League" })).not.toBeInTheDocument();
  });

  it("refreshes affected financial, history, standing, and payment projections after a refund", () => {
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);

    invalidateRefundPaymentViews(7, 42);

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["/api/payments"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["/api/financials/f5/payments"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["manage-payments-snapshot", 7] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["/api/financials/leagues", 7, "interactive-payment-participants/4"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["/api/financials/leagues", 7, "interactive-payment-quote/4"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["/api/financials/leagues", 7, "canonical-due-past-due/2"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["/api/financials/leagues/7/canonical-due-past-due/2"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["/api/financials/leagues/7/standing-autopay/1"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["/api/financials/leagues/7/standing-autopay/1/quote"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["/api/bowlers/42/details"] });
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ predicate: expect.any(Function) }));

    invalidate.mockRestore();
  });

  it("refreshes each recipient projection after a combined-payment refund", () => {
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);

    invalidateRefundPaymentViews(7, 42, [42, 43]);

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["/api/bowlers/42/details"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["/api/bowlers/43/details"] });
    invalidate.mockRestore();
  });

  it("includes allocated debtors and unused-credit owners in refund refreshes", () => {
    const row: CanonicalPaymentRow = {
      ...orphanRow,
      paymentId: 74,
      source: "canonical_allocation",
      unresolved: false,
      fundingPortions: [
        { creditedBowlerId: 42, amountMinor: 1000, availableMinor: 1000, appliedMinor: 0, refundedCreditMinor: 0, totalRefundedMinor: 0, heldCreditMinor: 0, reviewRequired: false },
        { creditedBowlerId: 44, amountMinor: 1000, availableMinor: 0, appliedMinor: 1000, refundedCreditMinor: 0, totalRefundedMinor: 0, heldCreditMinor: 0, reviewRequired: false },
      ],
      allocations: [{
        allocationId: "allocation-74",
        obligationId: "obligation-74",
        occurrenceId: "occurrence-74",
        occurrenceLocalDate: "2034-09-03",
        plannedOrdinal: 1,
        bowlerId: 43,
        amountMinor: 1000,
        currency: "USD",
        state: "active",
      }],
    };

    expect(refundAffectedBowlerIds(row)).toEqual([43, 42, 44]);
    expect(refundAffectedBowlerIds(null)).toEqual([]);
  });
});
