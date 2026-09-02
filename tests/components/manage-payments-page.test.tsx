import type { PropsWithChildren } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Route, Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalDuePastDueResponseV2 } from "@shared/roster-payment-contract";
import ManagePaymentsPage, { buildManagePaymentRows, buildPaymentIntentScope, formatDueDate, type EnrichedMembership, type RosterResponse } from "@/pages/manage-payments-page";

const csrfFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/queryClient", () => ({ csrfFetch: csrfFetchMock }));
vi.mock("@/components/layout", () => ({ Layout: ({ children }: PropsWithChildren) => <>{children}</> }));
vi.mock("@/components/error-boundary", () => ({ ErrorBoundary: ({ children }: PropsWithChildren) => <>{children}</> }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const roster: RosterResponse = {
  teams: [
    { id: 10, name: "Lucky Strikes", number: 1, slots: [{ slotIndex: 0, occupant: "main", mainBowlerId: 1 }] },
    { id: 20, name: "Split Happens", number: 2, slots: [{ slotIndex: 0, occupant: "vacant", mainBowlerId: null }] },
  ],
};

function membership(id: number, bowlerId: number, name: string, teamId: number, active = true): EnrichedMembership {
  return {
    id,
    bowlerId,
    leagueId: 7,
    teamId,
    active,
    order: 0,
    joinedAt: "2030-01-01T00:00:00.000Z",
    bowler: { id: bowlerId, name, active, email: null },
    team: { id: teamId, name: teamId === 10 ? "Lucky Strikes" : "Split Happens", number: teamId === 10 ? 1 : 2, active: true, leagueId: 7, displayOrder: 0 },
  };
}

function dueRow(payerBowlerId: number, outstandingMinor: number, dueAt = "2030-01-01T00:00:00.000Z"): CanonicalDuePastDueResponseV2["rows"][number] {
  return {
    id: `obligation-${payerBowlerId}`,
    organizationId: 1,
    leagueId: 7,
    occurrenceId: `00000000-0000-4000-8000-${String(payerBowlerId).padStart(12, "0")}`,
    responsibilityId: `00000000-0000-4000-8000-${String(payerBowlerId + 10).padStart(12, "0")}`,
    teamId: payerBowlerId === 1 ? 10 : 20,
    component: "full",
    payerBowlerId,
    amountMinor: outstandingMinor,
    currency: "USD",
    dueAt,
    pastDueAt: dueAt,
    state: outstandingMinor > 0 ? "open" : "settled",
    allocatedMinor: 0,
    outstandingMinor,
    classification: "past_due",
    reviewRequired: false,
  };
}

function dueResponse(rows: CanonicalDuePastDueResponseV2["rows"]): CanonicalDuePastDueResponseV2 {
  const outstandingMinor = rows.reduce((sum, row) => sum + row.outstandingMinor, 0);
  return {
    contractVersion: "canonical-due-past-due/2",
    orderVersion: "due-at,payer,occurrence,obligation/2",
    organizationId: 1,
    leagueId: 7,
    authoritativeSource: "payment_obligations",
    asOf: "2030-01-01T00:00:00.000Z",
    rows,
    totals: { amountMinor: outstandingMinor, allocatedMinor: 0, outstandingMinor, collectiblePastDueMinor: outstandingMinor, reviewCount: 0, settledCount: 0, voidedCount: 0 },
  };
}

function seedManagePage(client: QueryClient, memberships: EnrichedMembership[], due: CanonicalDuePastDueResponseV2): void {
  client.setQueryData(["/api/leagues/7"], { success: true, data: { id: 7, name: "Tuesday League", timezone: "America/New_York" } });
  client.setQueryData(["/api/financials/leagues/7/roster-payment-responsibility/1"], { success: true, data: roster });
  client.setQueryData(["/api/bowler-leagues?leagueId=7&enriched=true"], { success: true, data: memberships });
  client.setQueryData(["/api/financials/leagues/7/canonical-due-past-due/2"], { success: true, data: due });
}

function createManageQueryClient(): QueryClient {
  const client = new QueryClient({ defaultOptions: {
    queries: {
      retry: false,
      staleTime: Infinity,
      queryFn: ({ queryKey }) => Promise.resolve(client.getQueryData(queryKey) ?? {}),
    },
  } });
  return client;
}

function renderManagePage(client: QueryClient): void {
  const { hook } = memoryLocation({ path: "/leagues/7/payments/manage" });
  render(<QueryClientProvider client={client}><Router hook={hook}><Route path="/leagues/:leagueId/payments/manage" component={ManagePaymentsPage} /></Router></QueryClientProvider>);
}

describe("ManagePaymentsPage", () => {
  beforeEach(() => {
    csrfFetchMock.mockReset();
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("formats the oldest obligation in the league timezone across a UTC date boundary", () => {
    expect(formatDueDate("2030-01-01T04:30:00.000Z", "America/New_York")).toMatch(/Dec 31, 2029/);
    expect(formatDueDate("2030-01-01T04:30:00.000Z", "Pacific/Kiritimati")).toMatch(/Jan 1, 2030/);
  });

  it("encodes check numbers and notes without delimiter collisions in payment intent scopes", () => {
    const firstScope = buildPaymentIntentScope(7, 1, 2_000, "check", "a:b", "c");
    const secondScope = buildPaymentIntentScope(7, 1, 2_000, "check", "a", "b:c");

    expect(firstScope).not.toBe(secondScope);
  });

  it("groups active real bowlers, omits inactive/VACANT members, deduplicates payers, and disables zero balances", () => {
    const due: CanonicalDuePastDueResponseV2 = {
      contractVersion: "canonical-due-past-due/2",
      orderVersion: "due-at,payer,occurrence,obligation/2",
      organizationId: 1,
      leagueId: 7,
      authoritativeSource: "payment_obligations",
      asOf: "2030-01-01T00:00:00.000Z",
      rows: [dueRow(1, 2_000)],
      totals: { amountMinor: 2_000, allocatedMinor: 0, outstandingMinor: 2_000, collectiblePastDueMinor: 2_000, reviewCount: 0, settledCount: 0, voidedCount: 0 },
    };
    const rows = buildManagePaymentRows([
      membership(1, 1, "Alex Bowler", 10),
      membership(2, 1, "Alex Bowler", 20),
      membership(3, 2, "No Balance", 10),
      membership(4, 3, "Inactive Bowler", 10, false),
    ], due, roster);

    expect(rows.map((row) => [row.bowlerId, row.teamId])).toEqual([[1, 10], [2, 10]]);
    expect(rows[0]?.balanceMinor).toBe(2_000);
    expect(rows[1]?.balanceMinor).toBe(0);
  });

  it("renders blank cash/check controls and disables a row with no eligible balance", () => {
    const client = createManageQueryClient();
    seedManagePage(client, [membership(1, 1, "Alex Bowler", 10), membership(2, 2, "No Balance", 10)], dueResponse([dueRow(1, 2_000)]));
    renderManagePage(client);

    expect(screen.getByRole("heading", { name: "Manage Payments" })).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "Amount paid by Alex Bowler" })).toHaveValue(null);
    expect(screen.getByRole("combobox", { name: "Payment method for Alex Bowler" })).toHaveValue("cash");
    expect(screen.getByRole("spinbutton", { name: "Amount paid by No Balance" })).toBeDisabled();
    expect(screen.getByText("No balance")).toBeInTheDocument();
    expect(screen.queryByLabelText(/week/i)).not.toBeInTheDocument();
  });

  it("submits populated rows in one batch and preserves each independent result", async () => {
    const client = createManageQueryClient();
    seedManagePage(client, [membership(1, 1, "Alex Bowler", 10), membership(2, 2, "Casey Bowler", 10)], dueResponse([dueRow(1, 2_000), dueRow(2, 2_000)]));
    let recordKeys: string[] = [];
    csrfFetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body)) as { rows: Array<{ rowKey: string; payerBowlerId: number }> };
      if (url.includes("/quote/")) {
        return new Response(JSON.stringify({ data: { rows: body.rows.map((row) => ({ rowKey: row.rowKey, success: true, data: { fingerprint: `fingerprint-${row.payerBowlerId}`, payerBowlerId: row.payerBowlerId } })) } }), { status: 200 });
      }
      recordKeys = body.rows.map((row) => row.rowKey);
      return new Response(JSON.stringify({ data: { rows: [
        { rowKey: recordKeys[0], success: true },
        { rowKey: recordKeys[1], success: false, error: { code: "EXCESS_PAYMENT", message: "The payment amount exceeds the remaining eligible balance" } },
      ] } }), { status: 200 });
    });
    renderManagePage(client);

    fireEvent.change(screen.getByRole("spinbutton", { name: "Amount paid by Alex Bowler" }), { target: { value: "20" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Amount paid by Casey Bowler" }), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Record Payments" }));

    await waitFor(() => expect(screen.getByText("Recorded")).toBeInTheDocument());
    expect(csrfFetchMock).toHaveBeenCalledTimes(2);
    expect(csrfFetchMock.mock.calls[0]?.[0]).toContain("/canonical/manual-record-batch/quote/1");
    expect(csrfFetchMock.mock.calls[1]?.[0]).toContain("/canonical/manual-record-batch/1");
    const recordBody = JSON.parse(String(csrfFetchMock.mock.calls[1]?.[1]?.body)) as { rows: Array<{ payerBowlerId: number; amountMinor: number; type: string }> };
    expect(recordBody.rows.map(({ payerBowlerId, amountMinor, type }) => ({ payerBowlerId, amountMinor, type }))).toEqual([
      { payerBowlerId: 1, amountMinor: 2_000, type: "cash" },
      { payerBowlerId: 2, amountMinor: 2_000, type: "cash" },
    ]);
    expect(screen.getByRole("spinbutton", { name: "Amount paid by Alex Bowler" })).toHaveValue(null);
    expect(screen.getByRole("spinbutton", { name: "Amount paid by Alex Bowler" })).toBeDisabled();
    expect(screen.getByRole("spinbutton", { name: "Amount paid by Casey Bowler" })).toHaveValue(20);
    expect(screen.getByText("The payment amount exceeds the remaining eligible balance")).toBeInTheDocument();
  });

  it("preserves the actionable server message when payment quotes return a non-2xx response", async () => {
    const client = createManageQueryClient();
    seedManagePage(client, [membership(1, 1, "Alex Bowler", 10)], dueResponse([dueRow(1, 2_000)]));
    csrfFetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/quote/")) {
        return new Response(JSON.stringify({ error: { message: "The quote service rejected this request" } }), { status: 422 });
      }
      throw new Error("record should not be called after quote failure");
    });
    renderManagePage(client);

    fireEvent.change(screen.getByRole("spinbutton", { name: "Amount paid by Alex Bowler" }), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Record Payments" }));

    await waitFor(() => expect(screen.getByText("The quote service rejected this request")).toBeInTheDocument());
    expect(csrfFetchMock).toHaveBeenCalledTimes(1);
  });

  it("locks a transport-unknown result to its exact key and retries without quoting a new intent", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, queryFn: async () => ({}) } } });
    seedManagePage(client, [membership(1, 1, "Alex Bowler", 10)], dueResponse([dueRow(1, 2_000)]));
    let recordAttempts = 0;
    csrfFetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body)) as { rows: Array<{ rowKey: string; payerBowlerId: number }> };
      if (url.includes("/quote/")) {
        return new Response(JSON.stringify({ data: { rows: [{ rowKey: body.rows[0]?.rowKey, success: true, data: { fingerprint: "transport-fingerprint", payerBowlerId: 1 } }] } }), { status: 200 });
      }
      recordAttempts += 1;
      if (recordAttempts === 1) throw new Error("The connection closed before confirmation");
      return new Response(JSON.stringify({ data: { rows: [{ rowKey: body.rows[0]?.rowKey, success: true }] } }), { status: 200 });
    });
    renderManagePage(client);

    fireEvent.change(screen.getByRole("spinbutton", { name: "Amount paid by Alex Bowler" }), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Record Payments" }));
    await waitFor(() => expect(screen.getByText("Retry exact payment")).toBeInTheDocument());
    expect(screen.getByRole("spinbutton", { name: "Amount paid by Alex Bowler" })).toBeDisabled();
    expect(screen.getByText("The connection closed before confirmation")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry exact payment" }));
    await waitFor(() => expect(csrfFetchMock).toHaveBeenCalledTimes(3));
    expect(csrfFetchMock).toHaveBeenCalledTimes(3);
    expect(String(csrfFetchMock.mock.calls[1]?.[0])).toContain("/canonical/manual-record-batch/1");
    expect(String(csrfFetchMock.mock.calls[2]?.[0])).toContain("/canonical/manual-record-batch/1");
    const firstRecordBody = JSON.parse(String(csrfFetchMock.mock.calls[1]?.[1]?.body)) as { rows: Array<{ rowKey: string }> };
    const retryRecordBody = JSON.parse(String(csrfFetchMock.mock.calls[2]?.[1]?.body)) as { rows: Array<{ rowKey: string }> };
    expect(retryRecordBody.rows[0]?.rowKey).toBe(firstRecordBody.rows[0]?.rowKey);
  });

  it.each([500, 504])("locks an HTTP %s record response to its exact key and retries without quoting a new intent", async (status) => {
    const client = createManageQueryClient();
    seedManagePage(client, [membership(1, 1, "Alex Bowler", 10)], dueResponse([dueRow(1, 2_000)]));
    let recordAttempts = 0;
    csrfFetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body)) as { rows: Array<{ rowKey: string; payerBowlerId: number }> };
      if (url.includes("/quote/")) {
        return new Response(JSON.stringify({ data: { rows: [{ rowKey: body.rows[0]?.rowKey, success: true, data: { fingerprint: "server-failure-fingerprint", payerBowlerId: 1 } }] } }), { status: 200 });
      }
      recordAttempts += 1;
      if (recordAttempts === 1) {
        return new Response(JSON.stringify({ error: { message: `Server failed with ${status}` } }), { status });
      }
      return new Response(JSON.stringify({ data: { rows: [{ rowKey: body.rows[0]?.rowKey, success: true }] } }), { status: 200 });
    });
    renderManagePage(client);

    fireEvent.change(screen.getByRole("spinbutton", { name: "Amount paid by Alex Bowler" }), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Record Payments" }));
    await waitFor(() => expect(screen.getByText(`Server failed with ${status}`)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Retry exact payment" })).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "Amount paid by Alex Bowler" })).toHaveValue(20);
    expect(screen.getByRole("spinbutton", { name: "Amount paid by Alex Bowler" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Retry exact payment" }));
    await waitFor(() => expect(csrfFetchMock).toHaveBeenCalledTimes(3));
    expect(csrfFetchMock).toHaveBeenCalledTimes(3);
    expect(String(csrfFetchMock.mock.calls[0]?.[0])).toContain("/canonical/manual-record-batch/quote/1");
    expect(String(csrfFetchMock.mock.calls[1]?.[0])).toContain("/canonical/manual-record-batch/1");
    expect(String(csrfFetchMock.mock.calls[2]?.[0])).toContain("/canonical/manual-record-batch/1");
    const firstRecordBody = JSON.parse(String(csrfFetchMock.mock.calls[1]?.[1]?.body)) as { rows: Array<{ rowKey: string }> };
    const retryRecordBody = JSON.parse(String(csrfFetchMock.mock.calls[2]?.[1]?.body)) as { rows: Array<{ rowKey: string }> };
    expect(retryRecordBody.rows[0]?.rowKey).toBe(firstRecordBody.rows[0]?.rowKey);
    await waitFor(() => expect(screen.getByRole("spinbutton", { name: "Amount paid by Alex Bowler" })).toHaveValue(null));
  });

  it("locks a 200 INTERNAL_ERROR row to its exact key and retries without quoting a new intent", async () => {
    const client = createManageQueryClient();
    seedManagePage(client, [membership(1, 1, "Alex Bowler", 10)], dueResponse([dueRow(1, 2_000)]));
    let recordAttempts = 0;
    csrfFetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body)) as { rows: Array<{ rowKey: string; payerBowlerId: number }> };
      if (url.includes("/quote/")) {
        return new Response(JSON.stringify({ data: { rows: [{ rowKey: body.rows[0]?.rowKey, success: true, data: { fingerprint: "internal-error-fingerprint", payerBowlerId: 1 } }] } }), { status: 200 });
      }
      recordAttempts += 1;
      if (recordAttempts === 1) {
        return new Response(JSON.stringify({ data: { rows: [{ rowKey: body.rows[0]?.rowKey, success: false, error: { code: "INTERNAL_ERROR", message: "The server could not confirm the payment" } }] } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { rows: [{ rowKey: body.rows[0]?.rowKey, success: true }] } }), { status: 200 });
    });
    renderManagePage(client);

    fireEvent.change(screen.getByRole("spinbutton", { name: "Amount paid by Alex Bowler" }), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Record Payments" }));
    await waitFor(() => expect(screen.getByText("The server could not confirm the payment")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Retry exact payment" })).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "Amount paid by Alex Bowler" })).toHaveValue(20);
    expect(screen.getByRole("spinbutton", { name: "Amount paid by Alex Bowler" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Retry exact payment" }));
    await waitFor(() => expect(csrfFetchMock).toHaveBeenCalledTimes(3));
    expect(csrfFetchMock).toHaveBeenCalledTimes(3);
    expect(String(csrfFetchMock.mock.calls[0]?.[0])).toContain("/canonical/manual-record-batch/quote/1");
    expect(String(csrfFetchMock.mock.calls[1]?.[0])).toContain("/canonical/manual-record-batch/1");
    expect(String(csrfFetchMock.mock.calls[2]?.[0])).toContain("/canonical/manual-record-batch/1");
    const firstRecordBody = JSON.parse(String(csrfFetchMock.mock.calls[1]?.[1]?.body)) as { rows: Array<{ rowKey: string }> };
    const retryRecordBody = JSON.parse(String(csrfFetchMock.mock.calls[2]?.[1]?.body)) as { rows: Array<{ rowKey: string }> };
    expect(retryRecordBody.rows[0]?.rowKey).toBe(firstRecordBody.rows[0]?.rowKey);
    await waitFor(() => expect(screen.getByRole("spinbutton", { name: "Amount paid by Alex Bowler" })).toHaveValue(null));
  });
});
