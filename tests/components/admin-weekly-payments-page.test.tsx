import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManagePaymentsSeasonSnapshot, ManagePaymentsSnapshot } from "@shared/manage-payments-contract";
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

function makeSeasonSnapshot(
  snapshots: ReadonlyMap<string, ManagePaymentsSnapshot>,
  defaultOccurrenceId: string,
  unavailableOccurrences: ReadonlySet<string> = new Set(),
  removedOccurrences: ReadonlySet<string> = new Set(),
): ManagePaymentsSeasonSnapshot {
  const firstSnapshot = snapshots.values().next().value;
  if (!firstSnapshot) throw new Error("A season fixture needs at least one week snapshot.");

  const weekOptions = firstSnapshot.weekOptions.filter((week) => !removedOccurrences.has(week.occurrenceId));
  const snapshotsByOccurrence = Object.fromEntries(weekOptions.map((week) => {
    const snapshot = snapshots.get(week.occurrenceId);
    if (!snapshot || unavailableOccurrences.has(week.occurrenceId)) {
      return [week.occurrenceId, {
        status: "unavailable",
        code: "ambiguous_receipt_history",
        message: "This week’s saved payment history needs review before it can be loaded.",
      }];
    }
    return [week.occurrenceId, {
      status: "ready",
      feeTerms: snapshot.league.feeTerms,
      weekConfirmed: snapshot.weekConfirmed,
      needsConfirmation: snapshot.needsConfirmation,
      revision: snapshot.revision,
      stateFingerprint: snapshot.stateFingerprint,
      teams: snapshot.teams,
    }];
  }));

  return {
    contractVersion: 1,
    league: {
      leagueId: firstSnapshot.league.leagueId,
      name: firstSnapshot.league.name,
      timeZone: firstSnapshot.league.timeZone,
    },
    weekOptions,
    defaultOccurrenceId,
    snapshotsByOccurrence,
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
  failFirstSeason?: number;
  includeSecondLeague?: boolean;
  strictMode?: boolean;
  unavailableOccurrences?: ReadonlySet<string>;
  changeSiblingFinancialMetadataOnSave?: boolean;
  delaySeason?: (
    leagueId: number,
    signal: AbortSignal | undefined,
    requestNumber: number,
  ) => Promise<Response> | undefined;
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
  const seasons = new Map<number, ManagePaymentsSeasonSnapshot>([
    [7, makeSeasonSnapshot(snapshots, firstOccurrenceId, options.unavailableOccurrences)],
    ...(options.includeSecondLeague ? [[8, makeSeasonSnapshot(alternateSnapshots, alternateFirstOccurrenceId)] as [number, ManagePaymentsSeasonSnapshot]] : []),
  ]);
  const posts: Array<{ url: string; body: string; parsed: Record<string, unknown> }> = [];
  let failedPosts = 0;
  let failedSeasons = 0;
  const seasonGetCounts = new Map<number, number>();
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
    if (url.pathname === "/api/csrf-token") {
      return jsonResponse({ success: true, data: { token: "test-csrf-token" } });
    }
    const seasonPath = url.pathname.match(/^\/api\/financials\/leagues\/(\d+)\/manage-payments\/1\/season$/);
    if (seasonPath && (init?.method ?? "GET") === "GET") {
      const leagueId = Number(seasonPath[1]);
      const requestNumber = (seasonGetCounts.get(leagueId) ?? 0) + 1;
      seasonGetCounts.set(leagueId, requestNumber);
      const delayedResponse = options.delaySeason?.(leagueId, init?.signal ?? undefined, requestNumber);
      if (delayedResponse) return delayedResponse;
      if (failedSeasons < (options.failFirstSeason ?? 0)) {
        failedSeasons += 1;
        return jsonResponse({ error: { message: "Temporary season failure" } }, 503);
      }
      const season = seasons.get(leagueId);
      if (!season) return jsonResponse({ error: { message: "Unknown league" } }, 404);
      return jsonResponse({ success: true, data: season });
    }
    const snapshotPath = url.pathname.match(/^\/api\/financials\/leagues\/(\d+)\/manage-payments\/1$/);
    if (snapshotPath && (init?.method ?? "GET") === "GET") {
      const leagueId = Number(snapshotPath[1]);
      const requestedOccurrenceId = url.searchParams.get("occurrenceId");
      const delayedResponse = options.delaySnapshot?.(leagueId, requestedOccurrenceId, init?.signal ?? undefined);
      if (delayedResponse) return delayedResponse;
      const snapshot = requestedOccurrenceId === null
        ? undefined
        : snapshotsByLeague.get(leagueId)?.get(requestedOccurrenceId);
      if (!snapshot) return jsonResponse({ error: { message: "Unknown week" } }, 404);
      return jsonResponse({ success: true, data: snapshot });
    }
    if (snapshotPath && init?.method === "POST") {
      const leagueId = Number(snapshotPath[1]);
      const body = String(init.body ?? "{}");
      const parsed = JSON.parse(body) as Record<string, unknown>;
      posts.push({ url: url.pathname, body, parsed });
      const occurrenceId = String(parsed.occurrenceId);
      const leagueSnapshots = snapshotsByLeague.get(leagueId);
      const current = leagueSnapshots?.get(occurrenceId);
      if (!current) return jsonResponse({ error: { message: "Unknown week" } }, 404);
      if (failedPosts < (options.failFirstPost ?? 0)) {
        failedPosts += 1;
        return jsonResponse({ error: { code: "TEMPORARY_FAILURE", message: "Internal detail hidden" } }, 503);
      }
      if (options.failFirstPost === -1 && failedPosts === 0) {
        failedPosts += 1;
        leagueSnapshots?.set(occurrenceId, {
          ...current,
          revision: current.revision + 1,
          stateFingerprint: `lvmanagepayments:v1:${(current.revision + 1).toString(16).padStart(64, "0")}`,
          teams: current.teams.map((team) => ({
            ...team,
            rows: team.rows.map((row) => row.bowlerId === 502 ? { ...row, balanceMinor: 1_000 } : row),
          })),
        });
        const currentSeason = seasons.get(leagueId);
        if (currentSeason && leagueSnapshots) {
          seasons.set(leagueId, makeSeasonSnapshot(leagueSnapshots, currentSeason.defaultOccurrenceId));
        }
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
      leagueSnapshots?.set(occurrenceId, updated);
      if (options.changeSiblingFinancialMetadataOnSave && leagueSnapshots) {
        for (const [siblingOccurrenceId, sibling] of leagueSnapshots) {
          if (siblingOccurrenceId === occurrenceId) continue;
          leagueSnapshots.set(siblingOccurrenceId, {
            ...sibling,
            stateFingerprint: `lvmanagepayments:v1:${(sibling.revision + 100).toString(16).padStart(64, "0")}`,
            teams: sibling.teams.map((team) => ({
              ...team,
              rows: team.rows.map((row) => row.bowlerId === 501
                ? { ...row, balanceMinor: -500, finalTwoWeeksPaid: true }
                : row),
            })),
          });
        }
      }
      const currentSeason = seasons.get(leagueId);
      if (currentSeason && leagueSnapshots) {
        seasons.set(leagueId, makeSeasonSnapshot(leagueSnapshots, currentSeason.defaultOccurrenceId));
      }
      return jsonResponse({ success: true, data: { snapshot: updated, replayed: false } });
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  clearCsrfToken();

  const page = (
    <QueryClientProvider client={client}>
      <AdminWeeklyPaymentsPage />
    </QueryClientProvider>
  );
  const view = render(options.strictMode ? <StrictMode>{page}</StrictMode> : page);
  return { ...view, client, fetchMock, posts, snapshots, alternateSnapshots, seasons, seasonGetCounts };
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
  focusManager.setFocused(undefined);
  vi.unstubAllGlobals();
  clearCsrfToken();
});

describe("AdminWeeklyPaymentsPage", () => {
  it("loads one selected-league bundle on a StrictMode mount", async () => {
    const { fetchMock } = setupPage({ strictMode: true });

    expect(await screen.findByRole("textbox", { name: "Amount received from Blair Quinn" })).toBeVisible();
    await waitFor(() => {
      const seasonGets = fetchMock.mock.calls.filter(([input, init]) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
        return url.pathname.endsWith("/manage-payments/1/season") && (init?.method ?? "GET") === "GET";
      });
      const completedSeasonGets = seasonGets.filter(([, init]) => !(init?.signal as AbortSignal | undefined)?.aborted);
      expect(completedSeasonGets).toHaveLength(1);
    });
    expect(fetchMock.mock.calls.filter(([input, init]) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
      return url.pathname.endsWith("/manage-payments/1") && (init?.method ?? "GET") === "GET";
    })).toHaveLength(0);
  });

  it("uses canonical week options and preserves unsaved entries while navigating cached weeks", async () => {
    const user = userEvent.setup();
    const { fetchMock } = setupPage();

    const weekSelect = await screen.findByRole("combobox", { name: "Collection week" });
    await waitFor(() => expect(weekSelect).toHaveTextContent("Mon Sep 28, 2026"));
    expect(screen.getByRole("heading", { name: "Weekly payments" })).toBeVisible();

    const receivedInput = screen.getByRole("textbox", { name: "Amount received from Blair Quinn" });
    await user.type(receivedInput, ".50");
    await user.click(screen.getByRole("button", { name: "Next week" }));
    await waitFor(() => expect(weekSelect).toHaveTextContent("Mon Oct 5, 2026"));
    expect(screen.getByRole("textbox", { name: "Amount received from Blair Quinn" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Next week" }));
    await waitFor(() => expect(weekSelect).toHaveTextContent("Mon Oct 12, 2026"));
    expect(screen.getByRole("textbox", { name: "Amount received from Drew Shaw" })).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Amount received from Avery Lane" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Previous week" }));
    await user.click(screen.getByRole("button", { name: "Previous week" }));
    await waitFor(() => expect(weekSelect).toHaveTextContent("Mon Sep 28, 2026"));
    expect(screen.getByRole("textbox", { name: "Amount received from Blair Quinn" })).toHaveValue(".50");

    const seasonGets = fetchMock.mock.calls.filter(([input, init]) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
      return url.pathname.endsWith("/manage-payments/1/season") && (init?.method ?? "GET") === "GET";
    });
    const individualWeekGets = fetchMock.mock.calls.filter(([input, init]) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
      return url.pathname.endsWith("/manage-payments/1") && (init?.method ?? "GET") === "GET";
    });
    expect(seasonGets).toHaveLength(1);
    expect(individualWeekGets).toHaveLength(0);
  });

  it("recovers from the initial season request failure without occurrence fetches", async () => {
    const user = userEvent.setup();
    const { fetchMock } = setupPage({ failFirstSeason: 1 });

    expect(await screen.findByText("Weekly payments are temporarily unavailable. Try again shortly.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Collection week" })).toHaveTextContent("Mon Sep 28, 2026"));

    const seasonGets = fetchMock.mock.calls.filter(([input, init]) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
      return url.pathname.endsWith("/manage-payments/1/season") && (init?.method ?? "GET") === "GET";
    });
    const individualWeekGets = fetchMock.mock.calls.filter(([input, init]) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
      return url.pathname.endsWith("/manage-payments/1") && (init?.method ?? "GET") === "GET";
    });
    expect(seasonGets).toHaveLength(2);
    expect(individualWeekGets).toHaveLength(0);
  });

  it("keeps an unavailable week isolated and allows choosing another week", async () => {
    const user = userEvent.setup();
    const { fetchMock } = setupPage({ unavailableOccurrences: new Set([secondOccurrenceId]) });

    await screen.findByRole("textbox", { name: "Amount received from Blair Quinn" });
    const weekSelect = screen.getByRole("combobox", { name: "Collection week" });
    await user.click(screen.getByRole("button", { name: "Next week" }));
    await waitFor(() => expect(weekSelect).toHaveTextContent("Mon Oct 5, 2026"));
    expect(await screen.findByText("This week’s saved payment history needs review before it can be loaded.")).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next week" }));
    await waitFor(() => expect(weekSelect).toHaveTextContent("Mon Oct 12, 2026"));
    expect(await screen.findByRole("textbox", { name: "Amount received from Drew Shaw" })).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Amount received from Avery Lane" })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([input, init]) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
      return (url.pathname.endsWith("/manage-payments/1/season") || url.pathname.endsWith("/manage-payments/1"))
        && (init?.method ?? "GET") === "GET";
    })).toHaveLength(1);
  });

  it("pins the initial server week while its draft is dirty and the default changes", async () => {
    const user = userEvent.setup();
    const { client, snapshots, seasons, seasonGetCounts } = setupPage();

    await screen.findByRole("textbox", { name: "Amount received from Blair Quinn" });
    const weekSelect = screen.getByRole("combobox", { name: "Collection week" });
    await user.type(screen.getByRole("textbox", { name: "Amount received from Blair Quinn" }), "5.50");

    seasons.set(7, makeSeasonSnapshot(snapshots, secondOccurrenceId));
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await waitFor(() => expect(seasonGetCounts.get(7)).toBe(2));
    await waitFor(() => expect(client.getQueryState(["manage-payments-snapshot", 7])?.fetchStatus).toBe("idle"));

    expect(weekSelect).toHaveTextContent("Mon Sep 28, 2026");
    expect(screen.getByRole("textbox", { name: "Amount received from Blair Quinn" })).toHaveValue("5.50");
  });

  it("pins a clean fallback after its prior week disappears before a later dirty refresh", async () => {
    const user = userEvent.setup();
    const { client, snapshots, seasons, seasonGetCounts } = setupPage();

    await screen.findByRole("textbox", { name: "Amount received from Blair Quinn" });
    const weekSelect = screen.getByRole("combobox", { name: "Collection week" });
    seasons.set(7, makeSeasonSnapshot(
      snapshots,
      secondOccurrenceId,
      new Set(),
      new Set([firstOccurrenceId]),
    ));
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await waitFor(() => expect(seasonGetCounts.get(7)).toBe(2));
    await waitFor(() => expect(client.getQueryState(["manage-payments-snapshot", 7])?.fetchStatus).toBe("idle"));
    expect(weekSelect).toHaveTextContent("Mon Oct 5, 2026");

    const amountInput = screen.getByRole("textbox", { name: "Amount received from Blair Quinn" });
    await user.type(amountInput, "3.75");
    seasons.set(7, makeSeasonSnapshot(
      snapshots,
      thirdOccurrenceId,
      new Set(),
      new Set([firstOccurrenceId]),
    ));
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await waitFor(() => expect(seasonGetCounts.get(7)).toBe(3));
    await waitFor(() => expect(client.getQueryState(["manage-payments-snapshot", 7])?.fetchStatus).toBe("idle"));

    expect(weekSelect).toHaveTextContent("Mon Oct 5, 2026");
    expect(amountInput).toHaveValue("3.75");
  });

  it("keeps a removed dirty week in the picker as a read-only draft", async () => {
    const user = userEvent.setup();
    const { client, fetchMock, snapshots, seasons, seasonGetCounts } = setupPage();

    await screen.findByRole("textbox", { name: "Amount received from Blair Quinn" });
    const weekSelect = screen.getByRole("combobox", { name: "Collection week" });
    await user.type(screen.getByRole("textbox", { name: "Amount received from Blair Quinn" }), "6.25");

    seasons.set(7, makeSeasonSnapshot(
      snapshots,
      secondOccurrenceId,
      new Set(),
      new Set([firstOccurrenceId]),
    ));
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await waitFor(() => expect(seasonGetCounts.get(7)).toBe(2));
    await waitFor(() => expect(client.getQueryState(["manage-payments-snapshot", 7])?.fetchStatus).toBe("idle"));

    expect(weekSelect).toHaveTextContent("Mon Sep 28, 2026");
    expect(await screen.findByText("The selected week is unavailable.")).toBeVisible();
    const amountInput = screen.getByRole("textbox", { name: "Amount received from Blair Quinn" });
    expect(amountInput).toHaveValue("6.25");
    expect(amountInput).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Responsible this week for Blair Quinn" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save week" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Next week" }));
    await waitFor(() => expect(weekSelect).toHaveTextContent("Mon Oct 5, 2026"));
    await user.click(screen.getByRole("button", { name: "Previous week" }));
    await waitFor(() => expect(weekSelect).toHaveTextContent("Mon Sep 28, 2026"));
    expect(screen.getByRole("textbox", { name: "Amount received from Blair Quinn" })).toHaveValue("6.25");
    expect(fetchMock.mock.calls.filter(([input, init]) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
      return (url.pathname.endsWith("/manage-payments/1/season") || url.pathname.endsWith("/manage-payments/1"))
        && (init?.method ?? "GET") === "GET";
    })).toHaveLength(2);
  });

  it("cancels a late league bundle response and keeps each league’s options isolated", async () => {
    const user = userEvent.setup();
    const delayedFirstLeague = createDeferred<Response>();
    let firstLeagueSignal: AbortSignal | undefined;
    const { seasons } = setupPage({
      includeSecondLeague: true,
      delaySeason: (leagueId, signal, requestNumber) => {
        if (leagueId !== 7 || requestNumber !== 1) return undefined;
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

    const mondaySeason = seasons.get(7);
    if (!mondaySeason) throw new Error("The Monday league season fixture is missing.");
    delayedFirstLeague.resolve(jsonResponse({ success: true, data: mondaySeason }));
    await waitFor(() => expect(weekSelect).toHaveTextContent("Thu Oct 1, 2026"));

    await user.click(weekSelect);
    expect(await screen.findByRole("option", { name: "Thu Oct 1, 2026" })).toBeVisible();
    expect(screen.queryByRole("option", { name: "Mon Sep 28, 2026" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("combobox", { name: "League" }));
    await user.click(await screen.findByRole("option", { name: "Monday Night League" }));
    await waitFor(() => expect(weekSelect).toHaveTextContent("Mon Sep 28, 2026"));
    await user.click(weekSelect);
    expect(await screen.findByRole("option", { name: "Mon Sep 28, 2026" })).toBeVisible();
    expect(screen.queryByRole("option", { name: "Thu Oct 1, 2026" })).not.toBeInTheDocument();
  });

  it("renders cached league data immediately while refreshing that league in the background", async () => {
    const user = userEvent.setup();
    const delayedRefresh = createDeferred<Response>();
    let refreshSignal: AbortSignal | undefined;
    const { seasons } = setupPage({
      includeSecondLeague: true,
      delaySeason: (leagueId, signal, requestNumber) => {
        if (leagueId !== 7 || requestNumber !== 2) return undefined;
        refreshSignal = signal;
        return delayedRefresh.promise;
      },
    });

    await screen.findByRole("textbox", { name: "Amount received from Blair Quinn" });
    const weekSelect = screen.getByRole("combobox", { name: "Collection week" });
    await user.click(screen.getByRole("combobox", { name: "League" }));
    await user.click(await screen.findByRole("option", { name: "Thursday Night League" }));
    await waitFor(() => expect(weekSelect).toHaveTextContent("Thu Oct 1, 2026"));
    await user.click(screen.getByRole("combobox", { name: "League" }));
    await user.click(await screen.findByRole("option", { name: "Monday Night League" }));

    await waitFor(() => expect(refreshSignal).toBeDefined());
    expect(weekSelect).toHaveTextContent("Mon Sep 28, 2026");
    expect(screen.getByRole("textbox", { name: "Amount received from Blair Quinn" })).toBeVisible();

    const refreshedSeason = seasons.get(7);
    if (!refreshedSeason) throw new Error("The Monday league season fixture is missing.");
    delayedRefresh.resolve(jsonResponse({ success: true, data: refreshedSeason }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Amount received from Blair Quinn" })).toBeVisible());
    expect(refreshSignal?.aborted).toBe(false);
  });

  it("refreshes on window focus while retaining a dirty week’s original revision and drafts", async () => {
    const user = userEvent.setup();
    const { client, snapshots, seasons, seasonGetCounts, posts } = setupPage({ failFirstPost: -1 });

    await screen.findByRole("textbox", { name: "Amount received from Blair Quinn" });
    const amountInput = screen.getByRole("textbox", { name: "Amount received from Blair Quinn" });
    await user.type(amountInput, "5.50");

    const current = snapshots.get(firstOccurrenceId);
    if (!current) throw new Error("The first week fixture is missing.");
    const externallyUpdated = {
      ...current,
      revision: 22,
      stateFingerprint: `lvmanagepayments:v1:${(22).toString(16).padStart(64, "0")}`,
      teams: current.teams.map((team) => ({
        ...team,
        rows: team.rows.map((row) => row.bowlerId === 502
          ? { ...row, balanceMinor: 1_000 }
          : row.bowlerId === 501
            ? {
              ...row,
              cardReceipts: [...row.cardReceipts, {
                paymentId: 8_104,
                type: "credit_card" as const,
                amountMinor: 1_000,
                collectionLocalDate: current.selectedOccurrence.localDate,
                recordedAt: "2026-10-03T12:00:00.000Z",
                receiptNumber: "CARD-8104",
              }],
            }
            : row),
      })),
    } satisfies ManagePaymentsSnapshot;
    snapshots.set(firstOccurrenceId, externallyUpdated);
    const season = seasons.get(7);
    if (!season) throw new Error("The league season fixture is missing.");
    seasons.set(7, makeSeasonSnapshot(snapshots, season.defaultOccurrenceId));

    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await waitFor(() => expect(seasonGetCounts.get(7)).toBe(2));
    await waitFor(() => expect(client.getQueryState(["manage-payments-snapshot", 7])?.fetchStatus).toBe("idle"));
    expect(amountInput).toHaveValue("5.50");
    expect(screen.queryByText("$10.00 credit")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save week" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This week changed on the server");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.parsed.expectedRevision).toBe(14);
    expect(posts[0]?.parsed.expectedStateFingerprint).toBe(current.stateFingerprint);
    expect(screen.getByRole("textbox", { name: "Amount received from Blair Quinn" })).toHaveValue("5.50");
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
    const delayedRefresh = createDeferred<Response>();
    const { posts, client, fetchMock, seasonGetCounts } = setupPage({
      delaySeason: (leagueId, _signal, requestNumber) => leagueId === 7 && requestNumber === 2
        ? delayedRefresh.promise
        : undefined,
    });

    await screen.findByRole("textbox", { name: "Amount received from Blair Quinn" });
    await user.click(screen.getByRole("checkbox", { name: "Responsible this week for Blair Quinn" }));
    await user.type(screen.getByRole("textbox", { name: "Amount received from Blair Quinn" }), "12.34");
    await user.click(screen.getByRole("button", { name: "Save week" }));

    await screen.findByRole("button", { name: /Edit recorded cash payment/ });
    await waitFor(() => expect(seasonGetCounts.get(7)).toBe(2));
    expect(client.getQueryData<ManagePaymentsSeasonSnapshot>([
      "manage-payments-snapshot",
      7,
    ])?.snapshotsByOccurrence[firstOccurrenceId]).toMatchObject({ status: "ready", revision: 15 });
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
    expect(fetchMock.mock.calls.filter(([input, init]) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
      return url.pathname.endsWith("/manage-payments/1") && (init?.method ?? "GET") === "GET";
    })).toHaveLength(0);

    const refreshedData = client.getQueryData<ManagePaymentsSeasonSnapshot>(["manage-payments-snapshot", 7]);
    delayedRefresh.resolve(jsonResponse({ success: true, data: refreshedData }));
    await waitFor(() => expect(client.getQueryState(["manage-payments-snapshot", 7])?.fetchStatus).toBe("idle"));
    expect(screen.queryByText(/latest server snapshot could not be refreshed/)).not.toBeInTheDocument();
  });

  it("keeps a successful save after its background season refresh fails", async () => {
    const user = userEvent.setup();
    const failedRefresh = createDeferred<Response>();
    const { posts, seasonGetCounts } = setupPage({
      delaySeason: (leagueId, _signal, requestNumber) => leagueId === 7 && requestNumber === 2
        ? failedRefresh.promise
        : undefined,
    });

    await screen.findByRole("textbox", { name: "Amount received from Blair Quinn" });
    await user.click(screen.getByRole("checkbox", { name: "Responsible this week for Blair Quinn" }));
    await user.type(screen.getByRole("textbox", { name: "Amount received from Blair Quinn" }), "12.34");
    await user.click(screen.getByRole("button", { name: "Save week" }));

    expect(await screen.findByText("Recorded · $12.34")).toBeVisible();
    await waitFor(() => expect(seasonGetCounts.get(7)).toBe(2));
    expect(posts).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Save week" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next week" })).toBeEnabled();

    failedRefresh.resolve(jsonResponse({ error: { message: "Temporary season failure" } }, 503));
    expect(await screen.findByText("The latest server snapshot could not be refreshed. Your current edits remain based on the version shown.")).toBeVisible();
    expect(screen.getByText("Recorded · $12.34")).toBeVisible();
    expect(screen.queryByText(/Week wasn’t saved/)).not.toBeInTheDocument();
    expect(posts).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Next week" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Collection week" })).toHaveTextContent("Mon Oct 5, 2026"));
    expect(screen.getByRole("textbox", { name: "Amount received from Blair Quinn" })).toBeVisible();
    expect(posts).toHaveLength(1);
  });

  it("rebases a dirty sibling week after save when only server-derived financial metadata changes", async () => {
    const user = userEvent.setup();
    const delayedRefresh = createDeferred<Response>();
    const { posts, seasons, seasonGetCounts, client } = setupPage({
      changeSiblingFinancialMetadataOnSave: true,
      delaySeason: (leagueId, _signal, requestNumber) => leagueId === 7 && requestNumber === 2
        ? delayedRefresh.promise
        : undefined,
    });

    await screen.findByRole("textbox", { name: "Amount received from Blair Quinn" });
    await user.click(screen.getByRole("button", { name: "Next week" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Collection week" })).toHaveTextContent("Mon Oct 5, 2026"));
    await user.click(screen.getByRole("checkbox", { name: "Responsible this week for Blair Quinn" }));
    await user.type(screen.getByRole("textbox", { name: "Amount received from Blair Quinn" }), "4.25");

    await user.click(screen.getByRole("button", { name: "Previous week" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Collection week" })).toHaveTextContent("Mon Sep 28, 2026"));
    await user.click(screen.getByRole("checkbox", { name: "Responsible this week for Blair Quinn" }));
    await user.type(screen.getByRole("textbox", { name: "Amount received from Blair Quinn" }), "2.00");
    await user.click(screen.getByRole("button", { name: "Save week" }));
    await screen.findByText("Recorded · $2.00");
    await waitFor(() => expect(seasonGetCounts.get(7)).toBe(2));

    await user.click(screen.getByRole("button", { name: "Next week" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Collection week" })).toHaveTextContent("Mon Oct 5, 2026"));
    const amountInput = screen.getByRole("textbox", { name: "Amount received from Blair Quinn" });
    expect(amountInput).toHaveValue("4.25");

    const refreshedSeason = seasons.get(7);
    if (!refreshedSeason) throw new Error("The refreshed season fixture is missing.");
    const refreshedWeek = refreshedSeason.snapshotsByOccurrence[secondOccurrenceId];
    if (refreshedWeek?.status !== "ready") throw new Error("The refreshed week fixture is unavailable.");
    delayedRefresh.resolve(jsonResponse({ success: true, data: refreshedSeason }));
    await waitFor(() => expect(client.getQueryState(["manage-payments-snapshot", 7])?.fetchStatus).toBe("idle"));
    expect(amountInput).toHaveValue("4.25");

    await user.click(screen.getByRole("button", { name: "Save week" }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]?.parsed).toEqual(expect.objectContaining({
      occurrenceId: secondOccurrenceId,
      expectedRevision: refreshedWeek.revision,
      expectedStateFingerprint: refreshedWeek.stateFingerprint,
    }));
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
    const { posts, fetchMock, seasonGetCounts, client } = setupPage({ failFirstPost: -1 });

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
    await waitFor(() => expect(seasonGetCounts.get(7)).toBe(2));
    await waitFor(() => expect(client.getQueryState(["manage-payments-snapshot", 7])?.fetchStatus).toBe("idle"));
    expect(screen.getByRole("textbox", { name: "Amount received from Blair Quinn" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "Save week" })).toBeDisabled();
    expect(fetchMock.mock.calls.filter(([input, init]) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
      return url.pathname === "/api/financials/leagues/7/manage-payments/1" && (init?.method ?? "GET") === "GET";
    })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Next week" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Collection week" })).toHaveTextContent("Mon Oct 5, 2026"));
    expect(screen.getByRole("textbox", { name: "Amount received from Blair Quinn" })).toHaveValue("4.00");
    expect(posts).toHaveLength(1);
  });

  it("blocks edits and stale conflict recovery while a dirty week is unavailable", async () => {
    const user = userEvent.setup();
    const { client, fetchMock, posts, snapshots, seasons, seasonGetCounts } = setupPage({ failFirstPost: -1 });

    await screen.findByRole("textbox", { name: "Amount received from Blair Quinn" });
    await user.type(screen.getByRole("textbox", { name: "Amount received from Blair Quinn" }), "7.50");
    await user.click(screen.getByRole("button", { name: "Save week" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This week changed on the server");
    expect(screen.getByRole("button", { name: "Reload this week" })).toBeEnabled();

    seasons.set(7, makeSeasonSnapshot(snapshots, firstOccurrenceId, new Set([firstOccurrenceId])));
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await waitFor(() => expect(seasonGetCounts.get(7)).toBe(2));
    await waitFor(() => expect(client.getQueryState(["manage-payments-snapshot", 7])?.fetchStatus).toBe("idle"));

    expect(await screen.findByText("This week’s saved payment history needs review before it can be loaded.")).toBeVisible();
    const amountInput = screen.getByRole("textbox", { name: "Amount received from Blair Quinn" });
    expect(amountInput).toHaveValue("7.50");
    expect(amountInput).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Responsible this week for Blair Quinn" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save week" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reload this week" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Save week" }));
    await user.click(screen.getByRole("button", { name: "Reload this week" }));
    expect(posts).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([input, init]) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
      return url.pathname === "/api/financials/leagues/7/manage-payments/1" && (init?.method ?? "GET") === "GET";
    })).toHaveLength(0);

    seasons.set(7, makeSeasonSnapshot(snapshots, firstOccurrenceId));
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(seasonGetCounts.get(7)).toBe(3));
    await waitFor(() => expect(client.getQueryState(["manage-payments-snapshot", 7])?.fetchStatus).toBe("idle"));

    expect(amountInput).toBeEnabled();
    expect(amountInput).toHaveValue("7.50");
    expect(screen.getByRole("button", { name: "Save week" })).toBeEnabled();
    expect(posts).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([input, init]) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
      return url.pathname === "/api/financials/leagues/7/manage-payments/1" && (init?.method ?? "GET") === "GET";
    })).toHaveLength(0);
  });
});
