import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ComponentProps, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminWeeklyPaymentsAccountDialog } from "@/components/admin-weekly-payments-account-dialog";
import type { CanonicalPaymentRow } from "@shared/canonical-payment-report";
import type { FinancialReadAccountProjectionRow, FinancialReadContractV3, FinancialReadRowContractV3 } from "@shared/financial-contract";

const LEAGUE_ID = 7;
const BOWLER_ID = 42;

function makeAccount(overrides: Partial<FinancialReadAccountProjectionRow> = {}): FinancialReadAccountProjectionRow {
  return {
    bowlerId: BOWLER_ID,
    amountPaidMinor: 5_000,
    availableCreditMinor: 750,
    confirmedDebtMinor: 1_250,
    netBalanceMinor: -500,
    confirmedPastDueMinor: 500,
    seasonRemainingMinor: 3_000,
    reviewRequired: false,
    ...overrides,
  };
}

function makeFee(overrides: Partial<FinancialReadRowContractV3> = {}): FinancialReadRowContractV3 {
  return {
    id: "obligation-1",
    organizationId: 1,
    leagueId: LEAGUE_ID,
    occurrenceId: "occurrence-1",
    responsibilityId: "responsibility-1",
    teamId: 31,
    component: "full",
    payerBowlerId: BOWLER_ID,
    owner: { kind: "bowler", bowlerId: BOWLER_ID },
    slotIndex: 0,
    responsibilityKind: "main",
    actualBowlerId: null,
    occurrenceLocalDate: "2034-09-03",
    plannedOrdinal: 1,
    billingOrdinal: 1,
    amountMinor: 2_500,
    currency: "USD",
    dueAt: "2034-09-03T12:00:00.000Z",
    pastDueAt: "2034-09-10T12:00:00.000Z",
    state: "open",
    allocatedMinor: 500,
    grossAllocatedMinor: 500,
    refundedMinor: 0,
    waivedMinor: 0,
    stillOwed: true,
    outstandingMinor: 2_000,
    classification: "due",
    reviewRequired: false,
    accountProjection: {
      owner: { kind: "bowler", bowlerId: BOWLER_ID },
      effectiveDebtorBowlerId: BOWLER_ID,
      confirmationStatus: "confirmed",
      projectedCreditMinor: 2_000,
    },
    ...overrides,
  };
}

function makeFinancialReport(overrides: Partial<FinancialReadContractV3> = {}): FinancialReadContractV3 {
  const rows = overrides.rows ?? [makeFee()];
  return {
    contractVersion: "canonical-due-past-due/3",
    orderVersion: "due-at,owner,occurrence,obligation/3",
    organizationId: 1,
    leagueId: LEAGUE_ID,
    authoritativeSource: "payment_obligations",
    asOf: "2034-09-03T12:00:00.000Z",
    accountProjection: {
      contractVersion: "owned-account-projection/1",
      accounts: [makeAccount()],
    },
    rows,
    totals: {
      amountMinor: 2_500,
      allocatedMinor: 500,
      outstandingMinor: 2_000,
      collectiblePastDueMinor: 500,
      reviewCount: 0,
      settledCount: 0,
      voidedCount: 0,
    },
    ...overrides,
  };
}

function makePaymentRow(overrides: Partial<CanonicalPaymentRow> = {}): CanonicalPaymentRow {
  return {
    paymentId: 91,
    leagueId: LEAGUE_ID,
    bowlerId: 99,
    amountMinor: 60_000,
    currency: "USD",
    status: "confirmed_paid",
    paymentType: "check",
    businessDate: "2034-09-10",
    authoritativeLocalDate: "2034-09-10",
    providerPaymentId: null,
    paymentOperationId: null,
    operationType: null,
    operationStatus: null,
    allocatedMinor: 60_000,
    unallocatedMinor: 0,
    reviewRequired: false,
    source: "canonical_allocation",
    refund: { present: false, amountMinor: 0, providerRefundId: null },
    dispute: { present: false, amountMinor: 0, disputeId: null },
    unresolved: false,
    receipt: {
      contractVersion: "payment-receipt/1",
      availability: "unavailable",
      receiptUrl: null,
      receiptNumber: null,
      deliveryEvidence: "delivery_not_recorded",
    },
    allocations: [],
    fundingPortions: [
      {
        creditedBowlerId: BOWLER_ID,
        amountMinor: 10_000,
        availableMinor: 5_000,
        appliedMinor: 5_000,
        refundedCreditMinor: 0,
        totalRefundedMinor: 0,
        heldCreditMinor: 0,
        reviewRequired: false,
      },
      {
        creditedBowlerId: 43,
        amountMinor: 50_000,
        availableMinor: 0,
        appliedMinor: 50_000,
        refundedCreditMinor: 0,
        totalRefundedMinor: 0,
        heldCreditMinor: 0,
        reviewRequired: false,
      },
    ],
    ...overrides,
  };
}

function paymentReport(rows: CanonicalPaymentRow[], page: number, totalRows: number, totalTransactions: number) {
  return {
    success: true,
    data: {
      contractVersion: "canonical-payment-report/2",
      orderVersion: "league,business-date,bowler,occurrence,allocation,payment/2",
      organizationId: 1,
      leagueId: LEAGUE_ID,
      mode: "canonical",
      authoritativeSource: "canonical",
      asOf: "2034-09-10T12:00:00.000Z",
      fingerprint: "report-fingerprint",
      page,
      limit: 200,
      totalRows,
      totalTransactions,
      totals: {
        grossConfirmedPaidMinor: totalRows * 60_000,
        activeAllocatedMinor: totalRows * 60_000,
        refundedMinor: 0,
        disputedReviewRequiredMinor: 0,
        reviewRequiredMinor: 0,
        unresolvedOperationMinor: 0,
      },
      rows,
      transactions: [],
      paymentTiming: { paymentMode: "weekly", upfrontDueAt: null, timezone: "UTC", source: "canonical" },
    },
  };
}

function financialResponse(report: FinancialReadContractV3) {
  return new Response(JSON.stringify({ success: true, data: report }), { status: 200 });
}

function responseFor(url: string, financial: FinancialReadContractV3, rows: CanonicalPaymentRow[] = []): Response {
  if (url.includes("canonical-due-past-due/3")) return financialResponse(financial);
  const page = Number(new URL(url, "http://localhost").searchParams.get("page") ?? "1");
  return new Response(JSON.stringify(paymentReport(rows, page, rows.length, rows.length)), { status: 200 });
}

function createQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
}

function withClient(client: QueryClient, children: ReactNode) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function renderDialog(
  overrides: Partial<ComponentProps<typeof AdminWeeklyPaymentsAccountDialog>> = {},
  financial = makeFinancialReport(),
  paymentRows: CanonicalPaymentRow[] = [],
) {
  const client = createQueryClient();
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => (
    responseFor(String(input), financial, paymentRows)
  ));
  vi.stubGlobal("fetch", fetchMock);
  const result = render(withClient(client, <AdminWeeklyPaymentsAccountDialog
    leagueId={LEAGUE_ID}
    bowlerId={BOWLER_ID}
    bowlerName="Alex Morgan"
    open
    onOpenChange={vi.fn()}
    {...overrides}
  />));
  return { ...result, client, fetchMock };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AdminWeeklyPaymentsAccountDialog", () => {
  it("does not fetch while closed or when either scope ID is invalid", () => {
    const client = createQueryClient();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const closed = render(withClient(client, <AdminWeeklyPaymentsAccountDialog
      leagueId={LEAGUE_ID}
      bowlerId={BOWLER_ID}
      bowlerName="Alex Morgan"
      open={false}
      onOpenChange={vi.fn()}
    />));
    expect(fetchMock).not.toHaveBeenCalled();
    closed.unmount();

    render(withClient(createQueryClient(), <AdminWeeklyPaymentsAccountDialog
      leagueId={0}
      bowlerId={-1}
      bowlerName="Alex Morgan"
      open
      onOpenChange={vi.fn()}
    />));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Alex Morgan account" })).toBeInTheDocument();
    expect(screen.getAllByText("Unavailable")).toHaveLength(3);
  });

  it("uses bowler-scoped canonical endpoints and renders only the server-owned summary", async () => {
    const { fetchMock } = renderDialog();

    expect(await screen.findByText("$12.50")).toBeVisible();
    expect(screen.getByText("$7.50")).toBeVisible();
    expect(screen.getByText("$30.00")).toBeVisible();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const requestedUrls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(requestedUrls).toContain(`/api/financials/leagues/${LEAGUE_ID}/canonical-due-past-due/3?bowlerId=${BOWLER_ID}`);
    expect(requestedUrls).toContain(`/api/financials/f5/payments?leagueId=${LEAGUE_ID}&bowlerId=${BOWLER_ID}&page=1&limit=200`);
  });

  it("shows only confirmed, nonvoided, non-review fees for the clicked account", async () => {
    const financial = makeFinancialReport({
      rows: [
        makeFee({ id: "confirmed", plannedOrdinal: 2 }),
        makeFee({ id: "forecast", plannedOrdinal: 3, accountProjection: {
          owner: { kind: "bowler", bowlerId: BOWLER_ID },
          effectiveDebtorBowlerId: BOWLER_ID,
          confirmationStatus: "forecast",
          projectedCreditMinor: 2_000,
        } }),
        makeFee({ id: "voided", plannedOrdinal: 4, state: "voided", classification: "voided" }),
        makeFee({ id: "review", plannedOrdinal: 5, reviewRequired: true, classification: "review_required" }),
        makeFee({ id: "other-account", plannedOrdinal: 6, accountProjection: {
          owner: { kind: "bowler", bowlerId: 43 },
          effectiveDebtorBowlerId: 43,
          confirmationStatus: "confirmed",
          projectedCreditMinor: 0,
        } }),
      ],
    });
    renderDialog({ teamNames: { 31: "Gutterballers" } }, financial);

    const feeList = await screen.findByRole("list");
    expect(within(feeList).getByText("Week 2")).toBeInTheDocument();
    expect(within(feeList).getByText("Gutterballers · Weekly fee")).toBeInTheDocument();
    expect(within(feeList).queryByText("Week 3")).not.toBeInTheDocument();
    expect(within(feeList).queryByText("Week 4")).not.toBeInTheDocument();
    expect(within(feeList).queryByText("Week 5")).not.toBeInTheDocument();
    expect(within(feeList).queryByText("Week 6")).not.toBeInTheDocument();
    expect(within(feeList).getByText("$25.00 covered · $0.00 owed")).toBeInTheDocument();
    expect(screen.getByText("1 confirmed fee needs review and is not included.")).toBeInTheDocument();
  });

  it("uses only this bowler's portion of a shared tender in payment history", async () => {
    renderDialog({}, makeFinancialReport(), [makePaymentRow()]);

    const history = await screen.findByRole("region", { name: "Payment transactions" });
    expect(within(history).getByText("$100.00 · Sep 10, 2034")).toBeInTheDocument();
    expect(within(history).getByText("check · $50.00 applied · $50.00 credit")).toBeInTheDocument();
    expect(within(history).queryByText("$600.00 · Sep 10, 2034")).not.toBeInTheDocument();
    expect(within(history).queryByText("$500.00 · Sep 10, 2034")).not.toBeInTheDocument();
  });

  it("loads every history page beyond the first 200 rows", async () => {
    const client = createQueryClient();
    const pageOneRows = Array.from({ length: 200 }, (_, index) => makePaymentRow({
      paymentId: index + 1,
      authoritativeLocalDate: "2035-04-04",
    }));
    const pageTwoRows = [makePaymentRow({ paymentId: 201, authoritativeLocalDate: "2035-04-05" })];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("canonical-due-past-due/3")) return financialResponse(makeFinancialReport());
      const page = Number(new URL(url, "http://localhost").searchParams.get("page") ?? "1");
      const rows = page === 1 ? pageOneRows : pageTwoRows;
      return new Response(JSON.stringify(paymentReport(rows, page, 201, 201)), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(withClient(client, <AdminWeeklyPaymentsAccountDialog
      leagueId={LEAGUE_ID}
      bowlerId={BOWLER_ID}
      bowlerName="Alex Morgan"
      open
      onOpenChange={vi.fn()}
    />));

    expect(await screen.findByText("$100.00 · Apr 5, 2035")).toBeInTheDocument();
    const historyPathCalls = fetchMock.mock.calls.map(([input]) => String(input)).filter((url) => url.includes("/api/financials/f5/payments"));
    expect(historyPathCalls).toHaveLength(2);
    expect(historyPathCalls[1]).toContain("page=2&limit=200");
    expect(screen.getByText("201")).toBeInTheDocument();
  });

  it("shows unavailable balances instead of zeros when the owned projection is absent", async () => {
    const financial = makeFinancialReport({ accountProjection: undefined });
    renderDialog({}, financial);

    expect(await screen.findAllByText("Unavailable")).toHaveLength(3);
    expect(screen.getByText("Confirmed fee details are unavailable for this account.")).toBeInTheDocument();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  });

  it("does not label failed receipts as confirmed", async () => {
    renderDialog({}, makeFinancialReport(), [makePaymentRow({ status: "failed" })]);

    const history = await screen.findByRole("region", { name: "Payment transactions" });
    expect(within(history).getByText("Failed")).toBeInTheDocument();
    expect(within(history).queryByText("Confirmed")).not.toBeInTheDocument();
  });

  it("keeps internal API errors out of the dialog and offers a retry", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: false,
      error: { message: "Sensitive server detail", code: "INVALID_REQUEST" },
    }), { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    render(withClient(createQueryClient(), <AdminWeeklyPaymentsAccountDialog
      leagueId={LEAGUE_ID}
      bowlerId={BOWLER_ID}
      bowlerName="Alex Morgan"
      open
      onOpenChange={vi.fn()}
    />));

    expect(await screen.findByText("Confirmed fee details are unavailable.")).toBeInTheDocument();
    expect(screen.getAllByText("Payment history is unavailable.")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(2);
    expect(screen.queryByText("Sensitive server detail")).not.toBeInTheDocument();
  });

  it("closes on Escape and restores focus to the opener", async () => {
    const user = userEvent.setup();
    const financial = makeFinancialReport();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => responseFor(String(input), financial));
    vi.stubGlobal("fetch", fetchMock);
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open account</button>
          <AdminWeeklyPaymentsAccountDialog
            leagueId={LEAGUE_ID}
            bowlerId={BOWLER_ID}
            bowlerName="Alex Morgan"
            open={open}
            onOpenChange={setOpen}
          />
        </>
      );
    }
    render(withClient(createQueryClient(), <Harness />));
    const opener = screen.getByRole("button", { name: "Open account" });
    await user.click(opener);
    expect(await screen.findByRole("dialog", { name: "Alex Morgan account" })).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });
});
