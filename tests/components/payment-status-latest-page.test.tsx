import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Bowler, League } from "@shared/schema";
import { PaymentStatusSection } from "@/components/payment-status-section";

const csrfFetchMock = vi.hoisted(() => vi.fn());
const paymentDetailsDialogMock = vi.hoisted(() => vi.fn(() => null));

vi.mock("@/lib/queryClient", () => ({ csrfFetch: csrfFetchMock }));
vi.mock("@/components/payment-overview-card", () => ({ PaymentOverviewCard: () => <div>Payment overview</div> }));
vi.mock("@/components/payment-details-dialog", async () => {
  const actual = await vi.importActual<typeof import("@/components/payment-details-dialog")>("@/components/payment-details-dialog");
  return { ...actual, PaymentDetailsDialog: paymentDetailsDialogMock };
});

const league: League = {
  id: 17,
  name: "Thursday League",
  description: null,
  active: true,
  seasonStart: "2026-01-01T00:00:00.000Z",
  seasonEnd: "2026-04-01T00:00:00.000Z",
  weekDay: "Thursday",
  weeklyFee: 2_500,
  lineageFee: null,
  prizeFundFee: null,
  practiceStartTime: null,
  competitionStartTime: null,
  squareLineageItemId: null,
  lineageItemVariationId: null,
  squareLineageItemName: null,
  squarePrizeFundItemId: null,
  prizeFundItemVariationId: null,
  squarePrizeFundItemName: null,
  squareCategoryId: null,
  timezone: "America/Detroit",
  paymentMode: "weekly",
  seasonNumber: 1,
  previousSeasonId: null,
  organizationId: 1,
  locationId: null,
  totalBowlingWeeks: 12,
  skipDates: [],
  cancelledDates: [],
  doublePayDates: [],
};
const bowler: Bowler = {
  id: 42,
  name: "Morgan Bowler",
  email: "morgan@example.test",
  phone: null,
  active: true,
  order: 0,
  organizationId: 1,
  paymentCustomerId: null,
  paymentProviderLocationId: null,
  paymentSyncPendingAt: null,
  paymentSyncAttempts: 0,
  paymentSyncLastAttemptAt: null,
  paymentSyncNextRetryAt: null,
};

const paymentRow = (day: number) => ({
  authoritativeLocalDate: `2026-01-${String(day).padStart(2, "0")}`,
  amountMinor: day * 100,
  currency: "USD",
  status: "confirmed_paid",
  unresolved: false,
  appliedTo: [],
  allocations: [],
});

beforeEach(() => {
  paymentDetailsDialogMock.mockClear();
  csrfFetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      success: true,
      data: { rows: [], asOf: "2026-01-25T12:00:00Z", totals: { collectiblePastDueMinor: 0, outstandingMinor: 0 } },
    }),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("dashboard latest payment", () => {
  it("loads the final canonical report page when a bowler has more than 20 payments", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/financials/f5/payments") {
        const page = Number(url.searchParams.get("page"));
        const days = page === 1 ? Array.from({ length: 20 }, (_, index) => index + 1) : [21, 22, 23, 24, 25];
        return { ok: true, json: async () => ({ success: true, data: { totalRows: 25, rows: days.map(paymentRow) } }) };
      }
      if (url.pathname.endsWith("/rotating-credit/1")) {
        return { ok: true, json: async () => ({ success: true, data: { eligibleForCredit: false } }) };
      }
      if (url.pathname.endsWith("/occurrence-schedule")) {
        return { ok: true, json: async () => ({ success: true, data: {} }) };
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}>
      <PaymentStatusSection league={league} bowler={bowler} weeklyFee={2_500} />
    </QueryClientProvider>);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /View latest payment of \$25 on Jan 25, 2026/ })).toBeInTheDocument();
    });
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/api/financials/f5/payments"))
      .map(([input]) => new URL(String(input), "http://localhost").searchParams.get("page"))).toEqual(["1", "2"]);
  });

  it("uses the final row when same-day payments have distinct amounts", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/financials/f5/payments") {
        const sameDay = { authoritativeLocalDate: "2026-01-25", amountMinor: 2_500, currency: "USD", status: "confirmed_paid", unresolved: false, appliedTo: [], allocations: [] };
        return { ok: true, json: async () => ({ success: true, data: { totalRows: 2, rows: [
          { ...sameDay, amountMinor: 1_500 },
          sameDay,
        ] } }) };
      }
      if (url.pathname.endsWith("/rotating-credit/1")) {
        return { ok: true, json: async () => ({ success: true, data: { eligibleForCredit: false } }) };
      }
      if (url.pathname.endsWith("/occurrence-schedule")) {
        return { ok: true, json: async () => ({ success: true, data: {} }) };
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}>
      <PaymentStatusSection league={league} bowler={bowler} weeklyFee={2_500} />
    </QueryClientProvider>);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /View latest payment of \$25 on Jan 25, 2026/ })).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /View latest payment of \$15 on Jan 25, 2026/ })).not.toBeInTheDocument();
  });

  it("opens the latest transaction with the bowler receipt dialog and league context", async () => {
    const latest = {
      authoritativeLocalDate: "2026-01-25",
      amountMinor: 2_500,
      currency: "USD",
      status: "confirmed_paid",
      unresolved: false,
      appliedTo: [],
      allocations: [],
      source: "canonical_allocation",
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/financials/f5/payments") {
        return { ok: true, json: async () => ({ success: true, data: { totalRows: 1, rows: [latest] } }) };
      }
      if (url.pathname.endsWith("/rotating-credit/1")) {
        return { ok: true, json: async () => ({ success: true, data: { eligibleForCredit: false } }) };
      }
      if (url.pathname.endsWith("/occurrence-schedule")) {
        return { ok: true, json: async () => ({ success: true, data: {} }) };
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}>
      <PaymentStatusSection league={league} bowler={bowler} weeklyFee={2_500} />
    </QueryClientProvider>);

    const trigger = await screen.findByRole("button", { name: /View latest payment of \$25 on Jan 25, 2026/ });
    fireEvent.click(trigger);

    await waitFor(() => expect(paymentDetailsDialogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        evidence: latest,
        bowlerName: bowler.name,
        canCorrect: false,
        variant: "bowler",
        leagueName: league.name,
      }),
      undefined,
    ));
  });

  it("uses the bowler exception status for a refunded share credit", async () => {
    const refunded = {
      authoritativeLocalDate: "2026-01-25",
      amountMinor: 2_500,
      currency: "USD",
      status: "confirmed_paid",
      unresolved: false,
      appliedTo: [],
      allocations: [],
      source: "refunded_credit",
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/financials/f5/payments") {
        return { ok: true, json: async () => ({ success: true, data: { totalRows: 1, rows: [refunded] } }) };
      }
      if (url.pathname.endsWith("/rotating-credit/1")) {
        return { ok: true, json: async () => ({ success: true, data: { eligibleForCredit: false } }) };
      }
      if (url.pathname.endsWith("/occurrence-schedule")) {
        return { ok: true, json: async () => ({ success: true, data: {} }) };
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}>
      <PaymentStatusSection league={league} bowler={bowler} weeklyFee={2_500} />
    </QueryClientProvider>);

    await waitFor(() => expect(screen.getByText("Refunded", { exact: true })).toBeInTheDocument());
    expect(screen.queryByText("✓ Paid")).not.toBeInTheDocument();
  });

  it("keeps a confirmed transaction's separate review indicator visible", async () => {
    const reviewRequired = {
      authoritativeLocalDate: "2026-01-25",
      amountMinor: 2_500,
      currency: "USD",
      status: "confirmed_paid",
      unresolved: false,
      appliedTo: [],
      allocations: [],
      source: "canonical_allocation",
      reviewRequired: true,
      dispute: { reviewRequired: false },
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/financials/f5/payments") {
        return { ok: true, json: async () => ({ success: true, data: { totalRows: 1, rows: [reviewRequired] } }) };
      }
      if (url.pathname.endsWith("/rotating-credit/1")) {
        return { ok: true, json: async () => ({ success: true, data: { eligibleForCredit: false } }) };
      }
      if (url.pathname.endsWith("/occurrence-schedule")) {
        return { ok: true, json: async () => ({ success: true, data: {} }) };
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}>
      <PaymentStatusSection league={league} bowler={bowler} weeklyFee={2_500} />
    </QueryClientProvider>);

    await waitFor(() => expect(screen.getByText("Confirmed paid", { exact: true })).toBeInTheDocument());
    expect(screen.getByText("Review required", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("✓ Paid")).not.toBeInTheDocument();
  });

  it("requires review when current outstanding evidence is unresolved", async () => {
    csrfFetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          rows: [{
            id: "obligation-1",
            organizationId: 1,
            leagueId: 17,
            occurrenceId: "occurrence-1",
            responsibilityId: "responsibility-1",
            teamId: 1,
            component: "full",
            payerBowlerId: 42,
            amountMinor: 2_500,
            currency: "USD",
            dueAt: "2026-01-01T00:00:00.000Z",
            pastDueAt: "2026-01-02T00:00:00.000Z",
            state: "open",
            allocatedMinor: 0,
            grossAllocatedMinor: 0,
            refundedMinor: 0,
            waivedMinor: 0,
            stillOwed: true,
            outstandingMinor: 2_500,
            classification: "review_required",
            reviewRequired: true,
          }],
          asOf: "2026-01-25T12:00:00Z",
          totals: { collectiblePastDueMinor: 0, outstandingMinor: 2_500 },
        },
      }),
    });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/financials/f5/payments") {
        return { ok: true, json: async () => ({ success: true, data: { totalRows: 0, rows: [] } }) };
      }
      if (url.pathname.endsWith("/rotating-credit/1")) {
        return { ok: true, json: async () => ({ success: true, data: { eligibleForCredit: false } }) };
      }
      if (url.pathname.endsWith("/occurrence-schedule")) {
        return { ok: true, json: async () => ({ success: true, data: {} }) };
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}>
      <PaymentStatusSection league={league} bowler={bowler} weeklyFee={2_500} />
    </QueryClientProvider>);

    await waitFor(() => {
      expect(screen.getByText("Payment totals require review.")).toBeInTheDocument();
    });
    expect(screen.queryByText("Payment overview")).not.toBeInTheDocument();
  });
});
