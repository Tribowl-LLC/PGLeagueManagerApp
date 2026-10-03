import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManagePaymentsSnapshot } from "@shared/manage-payments-contract";
import AdminWeeklyPaymentsPage from "@/pages/admin-weekly-payments-page";
import { clearCsrfToken } from "@/lib/queryClient";

vi.mock("@/components/layout", () => ({
  Layout: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

vi.mock("@/components/admin-weekly-payments-account-dialog", () => ({
  AdminWeeklyPaymentsAccountDialog: ({
    bowlerName,
    open,
    onOpenChange,
  }: {
    bowlerName: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => open ? (
    <div role="dialog" aria-label={`${bowlerName} account`}>
      <button type="button" onClick={() => onOpenChange(false)}>Close account</button>
    </div>
  ) : null,
}));

const firstOccurrenceId = "b8cc77db-79b5-4515-95c6-5482c56c3835";
const secondOccurrenceId = "451e2b14-2805-4f67-a45d-4b5c0ad8d64e";
const thirdOccurrenceId = "73e134f6-1247-4635-bb94-801fb4532392";
const alternateFirstOccurrenceId = "dcc6092d-7066-40e1-8f21-57d0c9550042";
const alternateSecondOccurrenceId = "e6ed9c6d-9834-455a-9d0a-a5b987e3a650";
const newReceiptId = "06192a58-13e7-4b2b-a196-0a6a8cb0a449";

function makeSnapshot(
  occurrenceId = firstOccurrenceId,
  revision = 14,
  amountReceived: number | null = 0,
): ManagePaymentsSnapshot {
  const isThirdWeek = occurrenceId === thirdOccurrenceId;
  const selectedLocalDate = occurrenceId === firstOccurrenceId
    ? "2026-09-28"
    : occurrenceId === secondOccurrenceId
      ? "2026-10-05"
      : "2026-10-12";
  return {
    contractVersion: 1,
    league: {
      leagueId: 7,
      name: "Monday Night League",
      timeZone: "America/Chicago",
      feeTerms: { fullMinor: 2_500, lineageMinor: 1_000, prizeMinor: 500 },
    },
    weekOptions: [
      {
        occurrenceId: firstOccurrenceId,
        localDate: "2026-09-28",
        localStartTime: "19:00",
        timeZone: "America/Chicago",
        label: "Mon Sep 28, 2026",
      },
      {
        occurrenceId: secondOccurrenceId,
        localDate: "2026-10-05",
        localStartTime: "19:00",
        timeZone: "America/Chicago",
        label: "Mon Oct 5, 2026",
      },
      {
        occurrenceId: thirdOccurrenceId,
        localDate: "2026-10-12",
        localStartTime: "19:00",
        timeZone: "America/Chicago",
        label: "Mon Oct 12, 2026",
      },
    ],
    selectedOccurrence: {
      occurrenceId,
      localDate: selectedLocalDate,
      localStartTime: "19:00",
      timeZone: "America/Chicago",
    },
    weekConfirmed: true,
    needsConfirmation: false,
    revision,
    stateFingerprint: `lvmanagepayments:v1:${revision.toString(16).padStart(64, "0")}`,
    teams: [{
      teamId: 31,
      teamName: "Monday Night Team",
      rows: [
        {
          bowlerId: 501,
          displayName: isThirdWeek ? "Drew Shaw" : "Avery Lane",
          rosterRole: "main",
          responsible: true,
          feeComponent: "full",
          feeMinor: 2_500,
          balanceMinor: -1_250,
          manualReceipts: amountReceived && amountReceived > 0 ? [{
            receiptId: newReceiptId,
            revision: 1,
            paymentId: 8102,
            type: "cash",
            amountMinor: amountReceived,
            businessCollectionLocalDate: selectedLocalDate,
          }] : [],
          cardReceipts: [],
          finalTwoWeeksPaid: false,
        },
        {
          bowlerId: 502,
          displayName: isThirdWeek ? "Parker Dale" : "Blair Quinn",
          rosterRole: "substitute",
          responsible: false,
          feeComponent: "full",
          feeMinor: 0,
          balanceMinor: 500,
          manualReceipts: [],
          cardReceipts: [],
          finalTwoWeeksPaid: false,
        },
        {
          bowlerId: 503,
          displayName: isThirdWeek ? "Remy Stone" : "Casey Reese",
          rosterRole: "main",
          responsible: true,
          feeComponent: "lineage",
          feeMinor: 1_000,
          balanceMinor: 0,
          manualReceipts: [],
          cardReceipts: [{
            paymentId: 8103,
            type: "credit_card",
            amountMinor: 3_000,
            collectionLocalDate: selectedLocalDate,
            recordedAt: "2026-09-28T18:30:00.000Z",
            receiptNumber: "CARD-8103",
          }],
          finalTwoWeeksPaid: true,
        },
      ],
    }],
  };
}

function makeAlternateLeagueSnapshot(occurrenceId = alternateFirstOccurrenceId): ManagePaymentsSnapshot {
  const base = makeSnapshot(firstOccurrenceId, 3);
  const selectedLocalDate = occurrenceId === alternateFirstOccurrenceId ? "2026-10-01" : "2026-10-08";
  return {
    ...base,
    league: { ...base.league, leagueId: 8, name: "Thursday Night League" },
    weekOptions: [
      {
        occurrenceId: alternateFirstOccurrenceId,
        localDate: "2026-10-01",
        localStartTime: "19:00",
        timeZone: "America/Chicago",
        label: "Thu Oct 1, 2026",
      },
      {
        occurrenceId: alternateSecondOccurrenceId,
        localDate: "2026-10-08",
        localStartTime: "19:00",
        timeZone: "America/Chicago",
        label: "Thu Oct 8, 2026",
      },
    ],
    selectedOccurrence: {
      ...base.selectedOccurrence,
      occurrenceId,
      localDate: selectedLocalDate,
    },
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface PageSetupOptions {
  failFirstPost?: number;
  failFirstSnapshot?: number;
  includeSecondLeague?: boolean;
  delaySnapshot?: (
    leagueId: number,
    occurrenceId: string | null,
    signal: AbortSignal | undefined,
  ) => Promise<Response> | undefined;
}

function setupPage(options: PageSetupOptions = {}) {
  const activeLeagueEnvelope = options.includeSecondLeague ? leagueEnvelopeWithSecond : leagueEnvelope;
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        queryFn: async ({ queryKey }) => {
          if (queryKey[0] === "/api/leagues") return activeLeagueEnvelope;
          throw new Error(`Unexpected query ${String(queryKey[0])}`);
        },
      },
    },
  });
  client.setQueryData(["/api/leagues"], activeLeagueEnvelope);

  const snapshots = new Map([
    [firstOccurrenceId, makeSnapshot(firstOccurrenceId)],
    [secondOccurrenceId, makeSnapshot(secondOccurrenceId, 15)],
    [thirdOccurrenceId, makeSnapshot(thirdOccurrenceId, 16)],
  ]);
  const alternateSnapshots = new Map([
    [alternateFirstOccurrenceId, makeAlternateLeagueSnapshot(alternateFirstOccurrenceId)],
    [alternateSecondOccurrenceId, makeAlternateLeagueSnapshot(alternateSecondOccurrenceId)],
  ]);
  const snapshotsByLeague = new Map<number, Map<string, ManagePaymentsSnapshot>>([
    [7, snapshots],
    ...(options.includeSecondLeague ? [[8, alternateSnapshots] as [number, Map<string, ManagePaymentsSnapshot>]] : []),
  ]);
  const defaultOccurrenceByLeague = new Map([
    [7, firstOccurrenceId],
    ...(options.includeSecondLeague ? [[8, alternateFirstOccurrenceId] as [number, string]] : []),
  ]);
  const posts: Array<{ url: string; body: string; parsed: Record<string, unknown> }> = [];
  let failedPosts = 0;
  let failedSnapshots = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
    if (url.pathname === "/api/csrf-token") {
      return jsonResponse({ success: true, data: { token: "test-csrf-token" } });
    }
    const snapshotPath = url.pathname.match(/^\/api\/financials\/leagues\/(\d+)\/manage-payments\/1$/);
    if (snapshotPath && (init?.method ?? "GET") === "GET") {
      const leagueId = Number(snapshotPath[1]);
      const requestedOccurrenceId = url.searchParams.get("occurrenceId");
      const occurrenceId = requestedOccurrenceId ?? defaultOccurrenceByLeague.get(leagueId);
      const delayedResponse = options.delaySnapshot?.(leagueId, requestedOccurrenceId, init?.signal ?? undefined);
      if (delayedResponse) return delayedResponse;
      if (failedSnapshots < (options.failFirstSnapshot ?? 0)) {
        failedSnapshots += 1;
        return jsonResponse({ error: { message: "Temporary snapshot failure" } }, 503);
      }
      const snapshot = occurrenceId === undefined ? undefined : snapshotsByLeague.get(leagueId)?.get(occurrenceId);
      if (!snapshot) return jsonResponse({ error: { message: "Unknown week" } }, 404);
      return jsonResponse({ success: true, data: snapshot });
    }
    if (url.pathname === "/api/financials/leagues/7/manage-payments/1" && init?.method === "POST") {
      const body = String(init.body ?? "{}");
      const parsed = JSON.parse(body) as Record<string, unknown>;
      posts.push({ url: url.pathname, body, parsed });
      const occurrenceId = String(parsed.occurrenceId);
      const current = snapshots.get(occurrenceId);
      if (!current) return jsonResponse({ error: { message: "Unknown week" } }, 404);
      if (failedPosts < (options.failFirstPost ?? 0)) {
        failedPosts += 1;
        return jsonResponse({ error: { code: "TEMPORARY_FAILURE", message: "Internal detail hidden" } }, 503);
      }
      if (options.failFirstPost === -1 && failedPosts === 0) {
        failedPosts += 1;
        snapshots.set(occurrenceId, {
          ...current,
          revision: current.revision + 1,
          stateFingerprint: `lvmanagepayments:v1:${(current.revision + 1).toString(16).padStart(64, "0")}`,
          teams: current.teams.map((team) => ({
            ...team,
            rows: team.rows.map((row) => row.bowlerId === 502 ? { ...row, balanceMinor: 1_000 } : row),
          })),
        });
        return jsonResponse({ error: { code: "MANAGE_PAYMENTS_STALE_SNAPSHOT", message: "Internal conflict detail" } }, 409);
      }
      const changedRows = parsed.changedRows as Array<Record<string, unknown>>;
      const paymentChange = changedRows.find((row) => row.newManualReceiptAmountMinor !== undefined);
      const amount = paymentChange?.newManualReceiptAmountMinor;
      const updated = {
        ...current,
        revision: current.revision + 1,
        stateFingerprint: `lvmanagepayments:v1:${(current.revision + 1).toString(16).padStart(64, "0")}`,
        needsConfirmation: false,
        weekConfirmed: true,
        teams: current.teams.map((team) => ({
          ...team,
          rows: team.rows.map((row) => row.bowlerId === paymentChange?.bowlerId && amount !== undefined
            ? {
              ...row,
              manualReceipts: typeof amount === "number" && amount > 0 ? [{
                receiptId: newReceiptId,
                revision: 1,
                paymentId: 8102,
                type: "cash" as const,
                amountMinor: Number(amount),
                businessCollectionLocalDate: current.selectedOccurrence.localDate,
              }] : [],
            }
            : row),
        })),
      } satisfies ManagePaymentsSnapshot;
      snapshots.set(occurrenceId, updated);
      return jsonResponse({ success: true, data: { snapshot: updated, replayed: false } });
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  clearCsrfToken();

  const view = render(
    <QueryClientProvider client={client}>
      <AdminWeeklyPaymentsPage />
    </QueryClientProvider>,
  );
  return { ...view, client, fetchMock, posts, snapshots };
}

const leagueEnvelope = {
  success: true,
  data: [{ id: 7, name: "Monday Night League", active: true }],
};
const leagueEnvelopeWithSecond = {
  success: true,
  data: [
    ...leagueEnvelope.data,
    { id: 8, name: "Thursday Night League", active: true },
  ],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  clearCsrfToken();
});

describe("AdminWeeklyPaymentsPage", () => {
  it("uses canonical week options and preserves an unsaved entry across week navigation", async () => {
    const user = userEvent.setup();
    const { fetchMock } = setupPage();

    const weekSelect = await screen.findByRole("combobox", { name: "Collection week" });
    await waitFor(() => expect(weekSelect).toHaveTextContent("Mon Sep 28, 2026"));
    expect(screen.getByRole("heading", { name: "Weekly payments" })).toBeVisible();

    const receivedInput = screen.getByRole("textbox", { name: "Amount received from Blair Quinn" });
    await user.type(receivedInput, ".50");
    await user.click(screen.getByRole("button", { name: "Next week" }));
    await waitFor(() => expect(weekSelect).toHaveTextContent("Mon Oct 5, 2026"));
    await user.click(screen.getByRole("button", { name: "Previous week" }));
    await waitFor(() => expect(weekSelect).toHaveTextContent("Mon Sep 28, 2026"));
    expect(screen.getByRole("textbox", { name: "Amount received from Blair Quinn" })).toHaveValue(".50");

    const initialGets = fetchMock.mock.calls.filter(([input, init]) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
      return url.pathname.endsWith("/manage-payments/1") && (init?.method ?? "GET") === "GET" && !url.searchParams.has("occurrenceId");
    });
    expect(initialGets).toHaveLength(1);
    await waitFor(() => {
      const revisitedFirstWeekGets = fetchMock.mock.calls.filter(([input, init]) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
        return url.searchParams.get("occurrenceId") === firstOccurrenceId && (init?.method ?? "GET") === "GET";
      });
      expect(revisitedFirstWeekGets).toHaveLength(1);
    });
  });

  it("recovers from the initial snapshot request failure and seeds without a duplicate request", async () => {
    const user = userEvent.setup();
    const { fetchMock } = setupPage({ failFirstSnapshot: 1 });

    expect(await screen.findByText("Weekly payments are temporarily unavailable. Try again shortly.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Collection week" })).toHaveTextContent("Mon Sep 28, 2026"));

    const defaultGets = fetchMock.mock.calls.filter(([input, init]) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
      return url.pathname.endsWith("/manage-payments/1") && (init?.method ?? "GET") === "GET" && !url.searchParams.has("occurrenceId");
    });
    const normalizedInitialGets = fetchMock.mock.calls.filter(([input, init]) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
      return url.searchParams.get("occurrenceId") === firstOccurrenceId && (init?.method ?? "GET") === "GET";
    });
    expect(defaultGets).toHaveLength(2);
    expect(normalizedInitialGets).toHaveLength(0);
  });

  it("keeps week navigation available while a cold week loads and ignores its cancelled late response", async () => {
    const user = userEvent.setup();
    const delayedSecond = createDeferred<Response>();
    let secondRequestSignal: AbortSignal | undefined;
    const { fetchMock, snapshots } = setupPage({
      delaySnapshot: (leagueId, occurrenceId, signal) => {
        if (leagueId !== 7 || occurrenceId !== secondOccurrenceId) return undefined;
        secondRequestSignal = signal;
        return delayedSecond.promise;
      },
    });

    await screen.findByRole("textbox", { name: "Amount received from Blair Quinn" });
    const weekSelect = screen.getByRole("combobox", { name: "Collection week" });
    await user.click(screen.getByRole("button", { name: "Next week" }));
    await waitFor(() => expect(weekSelect).toHaveTextContent("Mon Oct 5, 2026"));
    expect(screen.getByRole("button", { name: "Next week" })).toBeEnabled();
    expect(screen.queryByRole("textbox", { name: "Amount received from Blair Quinn" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Amount received from Drew Shaw" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next week" }));
    await waitFor(() => expect(weekSelect).toHaveTextContent("Mon Oct 12, 2026"));
    await waitFor(() => expect(secondRequestSignal?.aborted).toBe(true));
    expect(await screen.findByRole("textbox", { name: "Amount received from Drew Shaw" })).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Amount received from Avery Lane" })).not.toBeInTheDocument();

    const secondWeek = snapshots.get(secondOccurrenceId);
    if (!secondWeek) throw new Error("The second week snapshot fixture is missing.");
    delayedSecond.resolve(jsonResponse({ success: true, data: secondWeek }));
    await waitFor(() => expect(weekSelect).toHaveTextContent("Mon Oct 12, 2026"));
    expect(screen.getByRole("textbox", { name: "Amount received from Drew Shaw" })).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Amount received from Avery Lane" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Amount received from Blair Quinn" })).not.toBeInTheDocument();

    const secondWeekGets = fetchMock.mock.calls.filter(([input, init]) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
      return url.searchParams.get("occurrenceId") === secondOccurrenceId && (init?.method ?? "GET") === "GET";
    });
    expect(secondWeekGets).toHaveLength(1);
  });

  it("cancels the pending initial league request and keeps week options scoped to each league", async () => {
    const user = userEvent.setup();
    const delayedFirstLeague = createDeferred<Response>();
    let firstLeagueSignal: AbortSignal | undefined;
    let shouldDelayFirstLeague = true;
    const { snapshots } = setupPage({
      includeSecondLeague: true,
      delaySnapshot: (leagueId, occurrenceId, signal) => {
        if (leagueId !== 7 || occurrenceId !== null || !shouldDelayFirstLeague) return undefined;
        shouldDelayFirstLeague = false;
        firstLeagueSignal = signal;
        return delayedFirstLeague.promise;
      },
    });

    await screen.findByRole("combobox", { name: "League" });
    await waitFor(() => expect(firstLeagueSignal).toBeDefined());
    await user.click(screen.getByRole("combobox", { name: "League" }));
    await user.click(await screen.findByRole("option", { name: "Thursday Night League" }));
    const weekSelect = screen.getByRole("combobox", { name: "Collection week" });
    await waitFor(() => expect(weekSelect).toHaveTextContent("Thu Oct 1, 2026"));
    await waitFor(() => expect(firstLeagueSignal?.aborted).toBe(true));
    expect(screen.getByRole("textbox", { name: "Amount received from Avery Lane" })).toBeVisible();

    const firstWeek = snapshots.get(firstOccurrenceId);
    if (!firstWeek) throw new Error("The first week snapshot fixture is missing.");
    delayedFirstLeague.resolve(jsonResponse({ success: true, data: firstWeek }));
    await waitFor(() => expect(weekSelect).toHaveTextContent("Thu Oct 1, 2026"));

    await user.click(weekSelect);
    expect(await screen.findByRole("option", { name: "Thu Oct 1, 2026" })).toBeVisible();
    expect(screen.queryByRole("option", { name: "Mon Sep 28, 2026" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("combobox", { name: "League" }));
    await user.click(await screen.findByRole("option", { name: "Monday Night League" }));
    await waitFor(() => expect(weekSelect).toHaveTextContent("Mon Sep 28, 2026"));

    await user.click(screen.getByRole("combobox", { name: "League" }));
    await user.click(await screen.findByRole("option", { name: "Thursday Night League" }));
    await waitFor(() => expect(weekSelect).toHaveTextContent("Thu Oct 1, 2026"));
    await user.click(weekSelect);
    expect(await screen.findByRole("option", { name: "Thu Oct 1, 2026" })).toBeVisible();
    expect(screen.queryByRole("option", { name: "Mon Sep 28, 2026" })).not.toBeInTheDocument();
  });

  it("opens and closes the selected bowler account from the worksheet name", async () => {
    const user = userEvent.setup();
    setupPage();

    await user.click(await screen.findByRole("button", { name: "Avery Lane" }));
    expect(await screen.findByRole("dialog", { name: "Avery Lane account" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Close account" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Avery Lane account" })).not.toBeInTheDocument());
  });

  it("submits a responsibility change without cash and renders the authoritative receipt after save", async () => {
    const user = userEvent.setup();
    const { posts, client } = setupPage();

    await screen.findByRole("textbox", { name: "Amount received from Blair Quinn" });
    await user.click(screen.getByRole("checkbox", { name: "Responsible this week for Blair Quinn" }));
    await user.type(screen.getByRole("textbox", { name: "Amount received from Blair Quinn" }), "12.34");
    await user.click(screen.getByRole("button", { name: "Save week" }));

    await screen.findByRole("button", { name: /Edit recorded cash payment/ });
    expect(client.getQueryData<ManagePaymentsSnapshot>([
      "manage-payments-snapshot",
      7,
      firstOccurrenceId,
    ])).toMatchObject({ revision: 15, selectedOccurrence: { occurrenceId: firstOccurrenceId } });
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe("/api/financials/leagues/7/manage-payments/1");
    expect(posts[0]?.parsed).toEqual(expect.objectContaining({
      occurrenceId: firstOccurrenceId,
      expectedRevision: 14,
      changedRows: [expect.objectContaining({
        bowlerId: 502,
        responsible: true,
        newManualReceiptAmountMinor: 1_234,
      })],
    }));
    expect(screen.getByText("Recorded · $12.34")).toBeVisible();
    expect(screen.getByText("$5.00 credit")).toBeVisible();
    expect(screen.getByText("Card · $30.00")).toBeVisible();
    expect(screen.queryByRole("textbox", { name: /Casey Reese/ })).not.toBeInTheDocument();
  });

  it("reuses the exact idempotency key and payload on an exact retry", async () => {
    const user = userEvent.setup();
    const { posts } = setupPage({ failFirstPost: 1 });

    await screen.findByRole("textbox", { name: "Amount received from Blair Quinn" });
    await user.type(screen.getByRole("textbox", { name: "Amount received from Blair Quinn" }), "9.25");
    await user.click(screen.getByRole("button", { name: "Save week" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("temporarily unavailable");
    await user.click(screen.getByRole("button", { name: "Save week" }));

    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[0]?.body).toBe(posts[1]?.body);
    expect((posts[0]?.parsed.idempotencyKey)).toEqual((posts[1]?.parsed.idempotencyKey));
  });

  it("offers explicit week reload after a conflict and clears only that week’s drafts", async () => {
    const user = userEvent.setup();
    const { posts } = setupPage({ failFirstPost: -1 });

    await screen.findByRole("textbox", { name: "Amount received from Blair Quinn" });
    await user.type(screen.getByRole("textbox", { name: "Amount received from Blair Quinn" }), "7.50");
    await user.click(screen.getByRole("button", { name: "Next week" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Collection week" })).toHaveTextContent("Mon Oct 5, 2026"));
    await user.type(screen.getByRole("textbox", { name: "Amount received from Blair Quinn" }), "4.00");
    await user.click(screen.getByRole("button", { name: "Previous week" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Collection week" })).toHaveTextContent("Mon Sep 28, 2026"));
    await user.click(screen.getByRole("button", { name: "Save week" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("This week changed on the server");
    expect(screen.getByRole("alert")).toHaveTextContent("reloading clears this week’s unsaved edits");
    expect(screen.getByRole("textbox", { name: "Amount received from Blair Quinn" })).toHaveValue("7.50");
    await user.click(screen.getByRole("button", { name: "Reload this week" }));

    await waitFor(() => expect(screen.getByText("$10.00 credit")).toBeVisible());
    expect(screen.getByRole("textbox", { name: "Amount received from Blair Quinn" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "Save week" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Next week" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Collection week" })).toHaveTextContent("Mon Oct 5, 2026"));
    expect(screen.getByRole("textbox", { name: "Amount received from Blair Quinn" })).toHaveValue("4.00");
    expect(posts).toHaveLength(1);
  });
});
