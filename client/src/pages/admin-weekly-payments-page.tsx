import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { nanoid } from "nanoid";
import type { League } from "@shared/schema";
import {
  managePaymentsApiPaths,
  managePaymentsSaveResponseSchema,
  managePaymentsSnapshotSchema,
  type ManagePaymentsSaveRequest,
  type ManagePaymentsSnapshot,
} from "@shared/manage-payments-contract";
import { AdminWeeklyPaymentsSaveError, AdminWeeklyPaymentsWorksheet, type AdminWeeklyPaymentsWorksheetDraftState, type AdminWeeklyPaymentsSaveInput, type AdminWeeklyPaymentsBowlerRow } from "@/components/admin-weekly-payments-worksheet";
import { AdminWeeklyPaymentsAccountDialog } from "@/components/admin-weekly-payments-account-dialog";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { PageErrorState, PageLoadingState } from "@/components/page-states";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { throwIfResNotOk, csrfFetch } from "@/lib/queryClient";
import { getApiErrorCode, getApiErrorStatus } from "@/lib/api-error";

const LEAGUES_QUERY_KEY = ["/api/leagues"] as const;
const EMPTY_DRAFTS: AdminWeeklyPaymentsWorksheetDraftState = {
  responsibilityDrafts: {},
  newReceiptDrafts: {},
  manualReceiptDrafts: {},
};

interface ApiEnvelope<T> {
  success: boolean;
  data: T;
}

interface SelectionDraftCacheEntry {
  drafts: AdminWeeklyPaymentsWorksheetDraftState;
  snapshot: ManagePaymentsSnapshot | null;
  dirty: boolean;
}

type SelectionDraftCache = Readonly<Record<string, SelectionDraftCacheEntry>>;

interface SelectedBowlerAccount {
  leagueId: number;
  bowlerId: number;
  bowlerName: string;
}

function accountTeamNames(
  teams: ManagePaymentsSnapshot["teams"],
): Readonly<Record<number, string>> {
  return teams.reduce<Record<number, string>>((names, team) => {
    names[team.teamId] = team.teamName;
    return names;
  }, {});
}

function managePaymentsSnapshotQueryKey(leagueId: number, occurrenceId: string | null) {
  return ["manage-payments-snapshot", leagueId, occurrenceId] as const;
}

function selectionCacheKey(leagueId: number, occurrenceId: string) {
  return `${leagueId}:${occurrenceId}`;
}

function userSaveError(error: unknown): string {
  const status = getApiErrorStatus(error);
  const code = getApiErrorCode(error);

  if (status === 409 || code === "MANAGE_PAYMENTS_STALE_SNAPSHOT") {
    return "This week changed on the server, so the save was not applied. Your entries remain on screen. Reload this week to use the latest saved version; reloading clears this week’s unsaved edits.";
  }
  if (status === 403) {
    return "You no longer have access to manage payments for this league. Your edits are still here.";
  }
  if (status === 404) {
    return "This week is no longer available. Choose a current week and review your edits before saving.";
  }
  if (status === 422) {
    return "The server could not apply one or more changes. Your edits are still here; review the selected week and try again.";
  }
  if (status === 429) {
    return "The server is receiving too many requests. Your edits are still here; wait a moment and try again.";
  }
  if (status !== undefined && status >= 500) {
    return "The payment service is temporarily unavailable. Your edits are still here; try again shortly.";
  }
  return "Week wasn’t saved. Your edits are still here. Check your connection and try again.";
}

async function fetchSnapshot(
  leagueId: number,
  occurrenceId: string | null,
  signal: AbortSignal,
): Promise<ManagePaymentsSnapshot> {
  const basePath = managePaymentsApiPaths.leagueSnapshot(leagueId);
  const url = occurrenceId
    ? `${basePath}?occurrenceId=${encodeURIComponent(occurrenceId)}`
    : basePath;
  const response = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json" },
    signal,
  });
  await throwIfResNotOk(response);
  const envelope = await response.json() as ApiEnvelope<unknown>;
  return managePaymentsSnapshotSchema.parse(envelope.data);
}

function safeReadError(error: unknown): string {
  const status = getApiErrorStatus(error);
  if (status === 403) return "You don’t have access to this league’s weekly payments.";
  if (status === 404) return "The selected week could not be found. Choose another week.";
  if (status !== undefined && status >= 500) return "Weekly payments are temporarily unavailable. Try again shortly.";
  return "Unable to load weekly payments. Check your connection and try again.";
}

function invalidatePaymentViews(
  queryClient: ReturnType<typeof useQueryClient>,
  leagueId: number,
  changedRows: AdminWeeklyPaymentsSaveInput["changedRows"],
) {
  void queryClient.invalidateQueries({ queryKey: ["/api/payments"] });
  void queryClient.invalidateQueries({ queryKey: ["/api/financials/f5/payments"] });
  void queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/canonical-due-past-due/2`] });
  void queryClient.invalidateQueries({ queryKey: ["/api/financials/leagues", leagueId, "canonical-due-past-due/2"] });
  void queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/canonical-due-past-due/3`] });
  void queryClient.invalidateQueries({ queryKey: ["/api/financials/leagues", leagueId, "canonical-due-past-due/3"] });
  void queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/roster-payment-responsibility/1`] });
  void queryClient.invalidateQueries({ queryKey: ["/api/financials/due-past-due"] });
  void queryClient.invalidateQueries({ queryKey: ["/api/bowlers"] });
  for (const row of changedRows) {
    void queryClient.invalidateQueries({ queryKey: [`/api/bowlers/${row.bowlerId}/details`] });
    void queryClient.invalidateQueries({
      queryKey: [`/api/financials/leagues/${leagueId}/canonical-due-past-due/2`, row.bowlerId],
    });
    void queryClient.invalidateQueries({
      queryKey: [`/api/financials/leagues/${leagueId}/canonical-due-past-due/3`, row.bowlerId],
    });
  }
}

export default function AdminWeeklyPaymentsPage() {
  const queryClient = useQueryClient();
  const [selectedLeagueId, setSelectedLeagueId] = useState<number | null>(null);
  const [selectedOccurrenceByLeague, setSelectedOccurrenceByLeague] = useState<Readonly<Record<number, string>>>({});
  const [selectedBowlerAccount, setSelectedBowlerAccount] = useState<SelectedBowlerAccount | null>(null);
  const [selectionDrafts, setSelectionDrafts] = useState<SelectionDraftCache>({});
  const [saving, setSaving] = useState(false);
  const [reloadState, setReloadState] = useState<{ selectionKey: string; status: "loading" | "error" } | null>(null);
  const [worksheetGeneration, setWorksheetGeneration] = useState(0);
  const [retryRequest, setRetryRequest] = useState<{ signature: string; request: ManagePaymentsSaveRequest } | null>(null);

  const { data: leaguesResponse, isLoading: leaguesLoading, error: leaguesError, refetch: refetchLeagues } = useQuery<{ data: League[] }>({
    queryKey: LEAGUES_QUERY_KEY,
  });
  const leagues = useMemo(
    () => (leaguesResponse?.data ?? []).filter((league) => league.active),
    [leaguesResponse?.data],
  );

  useEffect(() => {
    if (leaguesLoading) return;
    if (selectedLeagueId !== null && leagues.some((league) => league.id === selectedLeagueId)) return;
    setSelectedLeagueId(leagues[0]?.id ?? null);
  }, [leagues, leaguesLoading, selectedLeagueId]);

  const requestedOccurrenceId = selectedLeagueId === null
    ? null
    : selectedOccurrenceByLeague[selectedLeagueId] ?? null;
  const snapshotQuery = useQuery<ManagePaymentsSnapshot>({
    queryKey: managePaymentsSnapshotQueryKey(selectedLeagueId ?? 0, requestedOccurrenceId),
    queryFn: ({ signal }) => {
      if (selectedLeagueId === null) throw new Error("Choose a league to load weekly payments.");
      return fetchSnapshot(selectedLeagueId, requestedOccurrenceId, signal);
    },
    enabled: selectedLeagueId !== null,
    staleTime: 0,
    retry: false,
  });

  useEffect(() => {
    const snapshot = snapshotQuery.data;
    if (!snapshot || selectedLeagueId === null || requestedOccurrenceId !== null) return;
    const occurrenceId = snapshot.selectedOccurrence.occurrenceId;
    queryClient.setQueryData(managePaymentsSnapshotQueryKey(selectedLeagueId, occurrenceId), snapshot);
    setSelectedOccurrenceByLeague((current) => current[selectedLeagueId]
      ? current
      : { ...current, [selectedLeagueId]: occurrenceId });
  }, [queryClient, requestedOccurrenceId, selectedLeagueId, snapshotQuery.data]);

  const querySnapshot = snapshotQuery.data;
  const resolvedOccurrenceId = requestedOccurrenceId ?? querySnapshot?.selectedOccurrence.occurrenceId ?? null;
  const activeSelectionKey = selectedLeagueId !== null && resolvedOccurrenceId !== null
    ? selectionCacheKey(selectedLeagueId, resolvedOccurrenceId)
    : null;
  const activeReloadState = activeSelectionKey && reloadState?.selectionKey === activeSelectionKey
    ? reloadState
    : null;
  const activeCacheEntry = activeSelectionKey ? selectionDrafts[activeSelectionKey] : undefined;
  const currentQueryMatchesSelection = querySnapshot !== undefined
    && (resolvedOccurrenceId === null || querySnapshot.selectedOccurrence.occurrenceId === resolvedOccurrenceId);
  const latestSnapshot = currentQueryMatchesSelection ? querySnapshot : undefined;
  const snapshot = activeCacheEntry?.dirty && activeCacheEntry.snapshot
    ? activeCacheEntry.snapshot
    : latestSnapshot ?? null;
  const visibleAccount = selectedBowlerAccount?.leagueId === snapshot?.league.leagueId
    ? selectedBowlerAccount
    : null;

  const leaguesErrorMessage = leaguesError ? safeReadError(leaguesError) : null;
  const weekOptions = snapshot?.weekOptions ?? latestSnapshot?.weekOptions ?? [];
  const selectedWeekIndex = weekOptions.findIndex((week) => week.occurrenceId === resolvedOccurrenceId);

  const handleDraftStateChange = useCallback((drafts: AdminWeeklyPaymentsWorksheetDraftState) => {
    if (!activeSelectionKey) return;
    setSelectionDrafts((current) => {
      const previous = current[activeSelectionKey];
      return {
        ...current,
        [activeSelectionKey]: {
          drafts,
          snapshot: previous?.snapshot ?? (previous?.dirty ? snapshot : null),
          dirty: previous?.dirty ?? false,
        },
      };
    });
  }, [activeSelectionKey, snapshot]);

  const handleDirtyChange = useCallback((dirty: boolean) => {
    if (!activeSelectionKey) return;
    setSelectionDrafts((current) => {
      const previous = current[activeSelectionKey];
      return {
        ...current,
        [activeSelectionKey]: {
          drafts: previous?.drafts ?? EMPTY_DRAFTS,
          snapshot: dirty ? previous?.snapshot ?? snapshot : null,
          dirty,
        },
      };
    });
  }, [activeSelectionKey, snapshot]);

  const reloadCurrentWeek = useCallback(async () => {
    if (selectedLeagueId === null || resolvedOccurrenceId === null || activeSelectionKey === null) {
      throw new Error("Select a week before reloading.");
    }

    const leagueId = selectedLeagueId;
    const occurrenceId = resolvedOccurrenceId;
    const key = activeSelectionKey;
    const queryKey = managePaymentsSnapshotQueryKey(leagueId, occurrenceId);
    setReloadState({ selectionKey: key, status: "loading" });
    setWorksheetGeneration((current) => current + 1);
    setSelectionDrafts((current) => {
      const updated = { ...current };
      delete updated[key];
      return updated;
    });
    setRetryRequest(null);

    try {
      await queryClient.cancelQueries({ queryKey, exact: true });
      const authoritativeSnapshot = await queryClient.fetchQuery({
        queryKey,
        queryFn: ({ signal }) => fetchSnapshot(leagueId, occurrenceId, signal),
        staleTime: 0,
        retry: false,
      });
      queryClient.setQueryData(queryKey, authoritativeSnapshot);
      setReloadState(null);
    } catch (error) {
      setReloadState({ selectionKey: key, status: "error" });
      throw error;
    }
  }, [activeSelectionKey, queryClient, resolvedOccurrenceId, selectedLeagueId]);

  const handleSave = useCallback(async (input: AdminWeeklyPaymentsSaveInput) => {
    if (selectedLeagueId === null || !activeSelectionKey || !snapshot) {
      throw new AdminWeeklyPaymentsSaveError("Choose a league and week before saving.");
    }
    if (
      snapshot.selectedOccurrence.occurrenceId !== input.occurrenceId
      || snapshot.revision !== input.expectedRevision
      || snapshot.stateFingerprint !== input.expectedStateFingerprint
    ) {
      throw new AdminWeeklyPaymentsSaveError(
        "This worksheet is based on an older server snapshot. Your entries are still here; load the latest week before saving.",
      );
    }

    const requestCore = {
      occurrenceId: input.occurrenceId,
      expectedRevision: input.expectedRevision,
      expectedStateFingerprint: input.expectedStateFingerprint,
      changedRows: input.changedRows.map((row) => ({
        ...row,
        manualReceiptEdits: row.manualReceiptEdits.map((edit) => ({ ...edit })),
      })),
    };
    const signature = `${selectedLeagueId}:${JSON.stringify(requestCore)}`;
    const request: ManagePaymentsSaveRequest = retryRequest?.signature === signature
      ? retryRequest.request
      : { ...requestCore, idempotencyKey: nanoid() };
    if (retryRequest?.signature !== signature) setRetryRequest({ signature, request });

    setSaving(true);
    try {
      const response = await csrfFetch(managePaymentsApiPaths.saveWeek(selectedLeagueId), {
        method: "POST",
        credentials: "include",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
      });
      await throwIfResNotOk(response);
      const envelope = await response.json() as ApiEnvelope<unknown>;
      const result = managePaymentsSaveResponseSchema.parse(envelope.data);
      const authoritativeSnapshot = result.snapshot;
      if (authoritativeSnapshot.selectedOccurrence.occurrenceId !== input.occurrenceId) {
        throw new AdminWeeklyPaymentsSaveError(
          "The server returned a different week than the one you edited. Your entries are still here; reload the selected week before saving again.",
        );
      }

      queryClient.setQueryData(
        managePaymentsSnapshotQueryKey(selectedLeagueId, input.occurrenceId),
        authoritativeSnapshot,
      );
      setSelectionDrafts((current) => ({
        ...current,
        [activeSelectionKey]: {
          drafts: EMPTY_DRAFTS,
          snapshot: authoritativeSnapshot,
          dirty: false,
        },
      }));
      setRetryRequest(null);
      invalidatePaymentViews(queryClient, selectedLeagueId, input.changedRows);
    } catch (error) {
      if (error instanceof AdminWeeklyPaymentsSaveError) throw error;
      const conflict = getApiErrorStatus(error) === 409
        || getApiErrorCode(error) === "MANAGE_PAYMENTS_STALE_SNAPSHOT";
      throw new AdminWeeklyPaymentsSaveError(
        userSaveError(error),
        conflict ? { label: "Reload this week", run: reloadCurrentWeek } : undefined,
      );
    } finally {
      setSaving(false);
    }
  }, [activeSelectionKey, queryClient, reloadCurrentWeek, retryRequest, selectedLeagueId, snapshot]);

  function chooseLeague(value: string) {
    const leagueId = Number(value);
    if (!Number.isSafeInteger(leagueId) || !leagues.some((league) => league.id === leagueId)) return;
    if (leagueId !== selectedLeagueId) setSelectedBowlerAccount(null);
    setSelectedLeagueId(leagueId);
  }

  function chooseOccurrence(occurrenceId: string) {
    if (selectedLeagueId === null || !weekOptions.some((week) => week.occurrenceId === occurrenceId)) return;
    setSelectedOccurrenceByLeague((current) => ({ ...current, [selectedLeagueId]: occurrenceId }));
  }

  function moveWeek(direction: -1 | 1) {
    const nextWeek = weekOptions[selectedWeekIndex + direction];
    if (nextWeek) chooseOccurrence(nextWeek.occurrenceId);
  }

  return (
    <Layout appearance="weekly-payments">
      <div data-awpw="page">
        <header data-awpw="page-heading">
          <h1>Weekly payments</h1>
          <p>Set responsibility and enter receipts, then save once.</p>
        </header>

        {leaguesLoading ? (
          <PageLoadingState message="Loading leagues…" fullPage={false} />
        ) : leaguesErrorMessage ? (
          <PageErrorState message={leaguesErrorMessage} onRetry={() => { void refetchLeagues(); }} />
        ) : leagues.length === 0 ? (
          <div className="rounded-md border bg-card px-4 py-6 text-sm text-muted-foreground">
            There are no active leagues available for payment management.
          </div>
        ) : (
          <>
            <div data-awpw="toolbar">
              <div data-awpw="league-picker">
                <Label className="sr-only" htmlFor="manage-payments-league">League</Label>
                <Select value={selectedLeagueId === null ? "" : String(selectedLeagueId)} onValueChange={chooseLeague}>
                  <SelectTrigger appearance="managePayments" id="manage-payments-league" aria-label="League">
                    <SelectValue placeholder="Select a league" />
                  </SelectTrigger>
                  <SelectContent>
                    {leagues.map((league) => (
                      <SelectItem key={league.id} value={String(league.id)}>{league.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div data-awpw="week-picker">
                <Label className="sr-only" htmlFor="manage-payments-week">Collection week</Label>
                <div data-awpw="week-controls">
                  <Button
                    type="button"
                    variant="paymentsSecondary"
                    size="paymentsIcon"
                    aria-label="Previous week"
                    disabled={selectedWeekIndex <= 0 || saving || activeReloadState?.status === "loading"}
                    onClick={() => moveWeek(-1)}
                  >
                    <ChevronLeft aria-hidden="true" className="size-4" />
                  </Button>
                  <Select
                    value={resolvedOccurrenceId ?? ""}
                    onValueChange={chooseOccurrence}
                    disabled={weekOptions.length === 0 || saving || activeReloadState?.status === "loading"}
                  >
                    <SelectTrigger appearance="managePayments" id="manage-payments-week" aria-label="Collection week" className="min-w-0 flex-1">
                      <SelectValue placeholder="Choose a collection week" />
                    </SelectTrigger>
                    <SelectContent>
                      {weekOptions.map((week) => (
                        <SelectItem key={week.occurrenceId} value={week.occurrenceId}>{week.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="paymentsSecondary"
                    size="paymentsIcon"
                    aria-label="Next week"
                    disabled={selectedWeekIndex < 0 || selectedWeekIndex >= weekOptions.length - 1 || saving || activeReloadState?.status === "loading"}
                    onClick={() => moveWeek(1)}
                  >
                    <ChevronRight aria-hidden="true" className="size-4" />
                  </Button>
                </div>
              </div>
            </div>

            {activeReloadState?.status === "loading" ? (
              <PageLoadingState message="Loading the latest saved week…" fullPage={false} />
            ) : activeReloadState?.status === "error" ? (
              <PageErrorState
                message="The latest saved week could not be loaded. This week’s unsaved edits were cleared as requested. Retry to load the current version."
                onRetry={() => { void reloadCurrentWeek(); }}
              />
            ) : snapshotQuery.isLoading && !snapshot ? (
              <PageLoadingState message="Loading the selected week…" fullPage={false} />
            ) : snapshotQuery.error && !snapshot ? (
              <PageErrorState message={safeReadError(snapshotQuery.error)} onRetry={() => { void snapshotQuery.refetch(); }} />
            ) : snapshot ? (
              <>
                {snapshotQuery.error && (
                  <PageErrorState message="The latest server snapshot could not be refreshed. Your current edits remain based on the version shown." onRetry={() => { void snapshotQuery.refetch(); }} />
                )}
                <AdminWeeklyPaymentsWorksheet
                  key={`${activeSelectionKey ?? `${selectedLeagueId}:${snapshot.selectedOccurrence.occurrenceId}`}:${worksheetGeneration}`}
                  leagueId={snapshot.league.leagueId}
                  occurrenceId={snapshot.selectedOccurrence.occurrenceId}
                  expectedRevision={snapshot.revision}
                  expectedStateFingerprint={snapshot.stateFingerprint}
                  weekConfirmed={snapshot.weekConfirmed}
                  needsConfirmation={snapshot.needsConfirmation}
                  feeOptions={[
                    { feeComponent: "full", amountMinor: snapshot.league.feeTerms.fullMinor },
                    { feeComponent: "lineage", amountMinor: snapshot.league.feeTerms.lineageMinor },
                    { feeComponent: "prize", amountMinor: snapshot.league.feeTerms.prizeMinor },
                  ]}
                  teams={snapshot.teams}
                  initialDrafts={activeCacheEntry?.drafts ?? EMPTY_DRAFTS}
                  onSave={handleSave}
                  onDirtyChange={handleDirtyChange}
                  onDraftStateChange={handleDraftStateChange}
                  onBowlerAccount={(row: AdminWeeklyPaymentsBowlerRow) => setSelectedBowlerAccount({
                    leagueId: snapshot.league.leagueId,
                    bowlerId: row.bowlerId,
                    bowlerName: row.displayName,
                  })}
                />
                {visibleAccount && (
                  <AdminWeeklyPaymentsAccountDialog
                    leagueId={visibleAccount.leagueId}
                    bowlerId={visibleAccount.bowlerId}
                    bowlerName={visibleAccount.bowlerName}
                    teamNames={accountTeamNames(snapshot.teams)}
                    open
                    onOpenChange={(open) => {
                      if (!open) setSelectedBowlerAccount(null);
                    }}
                  />
                )}
              </>
            ) : null}
          </>
        )}
      </div>
    </Layout>
  );
}
