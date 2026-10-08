import { queryOptions, type QueryClient } from "@tanstack/react-query";
import type { ApiResponse, BowlerDetailsResponse, SavedCard } from "@shared/schema";
import type { CanonicalPaymentReport } from "@shared/canonical-payment-report";
import type { CanonicalDuePastDueResponseV2 } from "@shared/roster-payment-contract";
import type { RotatingCreditBalanceWire } from "@shared/rotating-credit-contract";
import type { LeagueOccurrenceScheduleReadContract } from "@shared/league-occurrence-schedule";
import { csrfFetch } from "@/lib/queryClient";
import { accountPaymentParticipantsQueryKey, loadAccountPaymentParticipantsV4 } from "@/lib/account-payment-v4";
import { filterBowlerLeaguesForActiveLeagues } from "@/lib/bowler-league-utils";
import { paymentHistoryFinancialQueryKey } from "@/lib/payment-history-financial-query";

/**
 * Query definitions for the bowler dashboard, Pay, and payment history
 * screens. Each screen and the sign-in preload below read through the same
 * definition, so preloaded data lands under exactly the key the screen uses.
 */

const jsonRead = { credentials: "include", headers: { Accept: "application/json" } } as const;

async function bowlerDetailsError(response: Response): Promise<Error> {
  const body = await response.json().catch(() => ({})) as { error?: { message?: string } };
  return new Error(body.error?.message || "Failed to fetch bowler details");
}

export function bowlerDetailsQueryOptions(bowlerId: number | null | undefined) {
  return queryOptions<ApiResponse<BowlerDetailsResponse>>({
    queryKey: [`/api/bowlers/${bowlerId}/details`],
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/bowlers/${bowlerId}/details`, { ...jsonRead, signal });
      if (!response.ok) throw await bowlerDetailsError(response);
      return response.json();
    },
  });
}

export function bowlerDetailsWithPaymentsQueryOptions(bowlerId: number | null | undefined) {
  return queryOptions<ApiResponse<BowlerDetailsResponse>>({
    queryKey: [`/api/bowlers/${bowlerId}/details`, { includePayments: true }],
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/bowlers/${bowlerId}/details?includePayments=true`, { ...jsonRead, signal });
      if (!response.ok) throw await bowlerDetailsError(response);
      return response.json();
    },
  });
}

export function dashboardDuePastDueQueryOptions(leagueId: number, bowlerId: number) {
  return queryOptions<ApiResponse<CanonicalDuePastDueResponseV2>>({
    queryKey: [`/api/financials/leagues/${leagueId}/canonical-due-past-due/2`, bowlerId],
    queryFn: async () => {
      const response = await csrfFetch(`/api/financials/leagues/${leagueId}/canonical-due-past-due/2?bowlerId=${bowlerId}`);
      if (!response.ok) throw new Error("Canonical payment evidence is unavailable");
      return response.json();
    },
    retry: false,
    staleTime: 30_000,
  });
}

export function paymentHistoryFinancialQueryOptions(leagueId: number, bowlerId: number) {
  return queryOptions<ApiResponse<CanonicalDuePastDueResponseV2>>({
    queryKey: paymentHistoryFinancialQueryKey(leagueId, bowlerId),
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/financials/leagues/${leagueId}/canonical-due-past-due/2?bowlerId=${bowlerId}`, { ...jsonRead, signal });
      if (!response.ok) throw new Error("Financial evidence is unavailable");
      return response.json();
    },
    retry: false,
    staleTime: 30_000,
  });
}

export function dashboardLatestPaymentsQueryOptions(leagueId: number, bowlerId: number) {
  return queryOptions<ApiResponse<CanonicalPaymentReport>>({
    queryKey: [`/api/financials/f5/payments`, { leagueId, bowlerId, view: "dashboard-latest" }],
    queryFn: async ({ signal }) => {
      // The canonical report is ordered oldest first. Its totals cover the
      // full scope, but rows are paginated, so the newest payment is on the
      // final page once a bowler has more than 20 rows.
      const pageSize = 20;
      const readPage = async (page: number): Promise<ApiResponse<CanonicalPaymentReport>> => {
        const response = await fetch(`/api/financials/f5/payments?leagueId=${leagueId}&bowlerId=${bowlerId}&page=${page}&limit=${pageSize}`, { ...jsonRead, signal });
        if (!response.ok) throw new Error("Payment history is unavailable");
        const result = await response.json() as ApiResponse<CanonicalPaymentReport>;
        if (!result.success || !result.data || !Array.isArray(result.data.rows)
          || !Number.isSafeInteger(result.data.totalRows) || result.data.totalRows < 0) {
          throw new Error("Payment history is unavailable");
        }
        return result;
      };
      const firstPage = await readPage(1);
      const lastPage = Math.ceil(firstPage.data.totalRows / pageSize);
      const report = lastPage > 1 ? await readPage(lastPage) : firstPage;
      if (report.data.totalRows > 0 && report.data.rows.length === 0) throw new Error("Payment history is unavailable");
      return report;
    },
    retry: false,
    staleTime: 30_000,
  });
}

export function paymentHistoryReportQueryOptions(leagueId: number | undefined, bowlerId: number | null | undefined, page: number) {
  return queryOptions<ApiResponse<CanonicalPaymentReport>>({
    queryKey: ["/api/financials/f5/payments", { bowlerId, leagueId, page }],
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/financials/f5/payments?leagueId=${leagueId}&bowlerId=${bowlerId}&page=${page}&limit=200`, { ...jsonRead, signal });
      if (!response.ok) throw new Error("Payment evidence requires review");
      return response.json();
    },
    retry: false,
    staleTime: 30_000,
  });
}

export function rotatingCreditQueryOptions(leagueId: number) {
  return queryOptions<ApiResponse<RotatingCreditBalanceWire>>({
    queryKey: [`/api/financials/leagues/${leagueId}/rotating-credit/1`],
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/financials/leagues/${leagueId}/rotating-credit/1`, { ...jsonRead, signal });
      if (!response.ok) throw new Error("Rotating payment eligibility is unavailable");
      return response.json();
    },
    retry: false,
    staleTime: 30_000,
  });
}

export function occurrenceScheduleQueryOptions(leagueId: number) {
  return queryOptions<ApiResponse<LeagueOccurrenceScheduleReadContract>>({
    queryKey: [`/api/leagues/${leagueId}/occurrence-schedule`],
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/leagues/${leagueId}/occurrence-schedule`, { ...jsonRead, signal });
      if (!response.ok) throw new Error("Canonical schedule is unavailable");
      return response.json();
    },
    retry: false,
    staleTime: 60_000,
  });
}

export function savedCardsQueryOptions(bowlerId: number | null | undefined, leagueId: number | undefined) {
  return queryOptions<ApiResponse<SavedCard[]>>({
    queryKey: [`/api/payments-provider/cards/${bowlerId}`, leagueId],
    queryFn: async () => {
      const response = await csrfFetch(`/api/payments-provider/cards/${bowlerId}?leagueId=${leagueId}`);
      if (!response.ok) throw new Error("Failed to fetch saved cards");
      return response.json();
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function accountPaymentParticipantsQueryOptions(leagueId: number, bowlerId: number) {
  return queryOptions({
    queryKey: accountPaymentParticipantsQueryKey(leagueId, bowlerId),
    queryFn: ({ signal }) => loadAccountPaymentParticipantsV4(leagueId, bowlerId, signal),
    staleTime: 30_000,
    retry: false,
  });
}

const SELECTED_LEAGUE_STORAGE_KEY = "bowler_selected_league_id";

/** The league the bowler screens will open on: the remembered choice when it
 * is still one of the bowler's leagues, otherwise their first active one. */
export function resolvePreloadLeagueId(details: BowlerDetailsResponse | undefined): number | undefined {
  const memberships = details?.bowlerLeagues ?? [];
  if (memberships.length === 0) return undefined;
  let stored: number | null = null;
  try {
    const value = localStorage.getItem(SELECTED_LEAGUE_STORAGE_KEY);
    stored = value ? Number(value) : null;
  } catch {
    stored = null;
  }
  if (stored !== null && memberships.some((membership) => membership.leagueId === stored)) return stored;
  const leagueMap = new Map((details?.leagues ?? []).map((league) => [league.id, league]));
  const active = filterBowlerLeaguesForActiveLeagues(memberships.filter((membership) => membership.active), leagueMap);
  return (active[0] ?? memberships[0])?.leagueId;
}

/** Kept a little longer than the default so a first tap a few minutes after
 * sign-in still opens from memory; each screen refreshes anything stale. */
const PRELOAD_GC_TIME = 15 * 60_000;

/**
 * Load the bowler's dashboard, Pay, and payment history data in the
 * background right after sign-in, so the first visit to each screen opens
 * from memory. Runs in stages (dashboard first) so the screen the bowler is
 * already looking at is not competing with the others. Failures are left for
 * the screens themselves to report when visited.
 */
export async function preloadBowlerScreens(client: QueryClient, bowlerId: number): Promise<void> {
  void import("@/pages/make-payment-page").catch(() => undefined);
  void import("@/pages/payment-history-page").catch(() => undefined);

  const detailsOptions = bowlerDetailsQueryOptions(bowlerId);
  await Promise.all([
    client.prefetchQuery({ queryKey: ["/api/bowlers"] }),
    client.prefetchQuery({ queryKey: ["/api/bowler-leagues"] }),
    client.prefetchQuery({ queryKey: ["/api/leagues"] }),
    client.prefetchQuery(detailsOptions),
  ]);
  const leagueId = resolvePreloadLeagueId(client.getQueryData(detailsOptions.queryKey)?.data);
  if (leagueId === undefined) return;

  const dueOptions = dashboardDuePastDueQueryOptions(leagueId, bowlerId);
  await Promise.all([
    client.prefetchQuery(dueOptions),
    client.prefetchQuery(dashboardLatestPaymentsQueryOptions(leagueId, bowlerId)),
    client.prefetchQuery(rotatingCreditQueryOptions(leagueId)),
    client.prefetchQuery(occurrenceScheduleQueryOptions(leagueId)),
  ]);
  // Payment history reads the same balance response under its own key.
  const due = client.getQueryData(dueOptions.queryKey);
  const historyFinancialKey = paymentHistoryFinancialQueryOptions(leagueId, bowlerId).queryKey;
  if (due !== undefined && client.getQueryData(historyFinancialKey) === undefined) {
    client.setQueryData(historyFinancialKey, due);
  }

  await Promise.all([
    client.prefetchQuery({ ...bowlerDetailsWithPaymentsQueryOptions(bowlerId), gcTime: PRELOAD_GC_TIME }),
    client.prefetchQuery({ ...accountPaymentParticipantsQueryOptions(leagueId, bowlerId), gcTime: PRELOAD_GC_TIME }),
    client.prefetchQuery({ ...savedCardsQueryOptions(bowlerId, leagueId), gcTime: PRELOAD_GC_TIME }),
    client.prefetchQuery({ queryKey: [`/api/financials/leagues/${leagueId}/standing-autopay/1`], retry: false, gcTime: PRELOAD_GC_TIME }),
  ]);

  await client.prefetchQuery({ ...paymentHistoryReportQueryOptions(leagueId, bowlerId, 1), gcTime: PRELOAD_GC_TIME });
}
