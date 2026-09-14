import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useSearch } from "wouter";
import type { ApiResponse, BowlerDetailsResponse, SavedCard, User } from "@shared/schema";
import { BowlerLayout } from "@/components/bowler-layout";
import { LeagueSwitcherSheet } from "@/components/league-switcher-sheet";
import { BowlerOneTimePaymentCard, type PaymentBreakdownRow, type PaymentRecipientRow } from "@/components/bowler-one-time-payment-card";
import { StandingAutopayCard } from "@/components/standing-autopay-card";
import { PageErrorState, PageLoadingState } from "@/components/page-states";
import { ErrorBoundary } from "@/components/error-boundary";
import { useSelectedLeague } from "@/hooks/use-selected-league";
import { useSquarePayment } from "@/hooks/use-square-payment";
import { usePaymentProvider } from "@/hooks/use-payment-provider";
import { useWalletPayments } from "@/hooks/use-wallet-payments";
import { useSavedCardDefault } from "@/hooks/use-saved-card-default";
import { csrfFetch, queryClient } from "@/lib/queryClient";
import { tokenizeCard } from "@/lib/square";
import { formatCurrency } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { logger } from "@/lib/logger";
import { isHandledPaymentError, sanitizePaymentErrorMessage } from "@/lib/payment-user-error";
import { isProviderNotConfiguredError, providerNotConfiguredToast, makeApiError } from "@/lib/provider-not-configured";
import { assertRosterPaymentSucceeded, clearPaymentIntent, interactivePaymentIntentScope, isTerminalRosterPaymentFailure, paymentRequestHeaders, paymentRequestWithRecovery, prepareRosterPaymentIntent } from "@/lib/payment-request-identity";
import { paymentHistoryFinancialQueryKey, invalidatePaymentHistoryFinancials } from "@/lib/payment-history-financial-query";
import {
  buildInteractivePaymentRecipients,
  clampInteractivePaymentWeeks,
  initialInteractivePaymentWeeks,
  isInteractivePaymentQuoteCurrent,
  isInteractiveParticipantSelectedByDefault,
  participantAmountForSelection,
  type InteractivePaymentMode,
  type InteractivePaymentParticipant,
  type InteractivePaymentParticipantsResponse,
  type InteractivePaymentQuote,
} from "@/lib/interactive-payment-v3";

type EditorMode = "one-time" | "autopay" | null;

/** Keep the in-memory wallet identity in step with the durable intent. */
export function clearWalletRequestKeyForTerminalStatus(
  status: unknown,
  requestKeyRef: { current: string | null },
): void {
  if (isTerminalRosterPaymentFailure(status)) requestKeyRef.current = null;
}

export function clampPaymentWeekCount(value: number, maximum: number): number {
  if (maximum <= 0) return 1;
  return Math.min(Math.max(1, value), maximum);
}

export function shouldReinitializeOneTimeCardEditor(cardMode: "new" | "saved", savedCardCount: number): boolean {
  return cardMode === "new" && savedCardCount === 0;
}

export function resetPaymentSelectionForLeagueChange(): { weekCount: number; intentApplied: boolean } {
  return { weekCount: 1, intentApplied: false };
}

export function resolveSavedCardReadState(
  isEnabled: boolean,
  hasResponse: boolean,
  isLoading: boolean,
  hasError: boolean,
): "idle" | "loading" | "ready" | "unavailable" {
  if (!isEnabled) return "idle";
  if (hasResponse) return "ready";
  if (isLoading || !hasError) return "loading";
  return "unavailable";
}

export function hasPositivePaymentEvidence(rows: Array<{
  allocatedMinor: number;
  outstandingMinor: number;
  state: string;
  reviewRequired: boolean;
}>): boolean {
  const hasConfirmedAllocation = rows.some((row) =>
    row.allocatedMinor > 0 && row.state !== "voided" && !row.reviewRequired,
  );
  const hasUnresolvedReview = rows.some((row) =>
    row.state !== "voided" && row.reviewRequired,
  );
  return hasConfirmedAllocation && !hasUnresolvedReview;
}

export function MakePaymentReadError({ message, onRetry, leagueId }: { message: string; onRetry: () => void; leagueId?: number }) {
  const historyHref = leagueId ? `/payment-history?leagueId=${leagueId}` : "/payment-history";
  return (
    <BowlerLayout bowlerName="" leagueName="Payment information unavailable" currentLeagueId={leagueId}>
      <div className="space-y-4">
        <PageErrorState message={message} onRetry={onRetry} />
        <p className="text-sm text-muted-foreground">
          You can try loading the payment data again or <Link href={historyHref} className="underline">view payment history</Link>.
        </p>
      </div>
    </BowlerLayout>
  );
}

export function invalidatePaymentViews(leagueId: number, bowlerId: number, affectedBowlerIds: readonly number[] = [bowlerId]): void {
  const affectedIds = [...new Set([bowlerId, ...affectedBowlerIds])].filter((id) => Number.isSafeInteger(id) && id > 0);
  for (const affectedId of affectedIds) {
    void queryClient.invalidateQueries({ queryKey: paymentHistoryFinancialQueryKey(leagueId, affectedId) });
    void queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/canonical-due-past-due/2`, affectedId] });
    void queryClient.invalidateQueries({ queryKey: ["/api/payments", { bowlerId: affectedId, leagueId }] });
    void queryClient.invalidateQueries({ queryKey: ["/api/payments", affectedId] });
    void queryClient.invalidateQueries({ queryKey: [`/api/bowlers/${affectedId}/details`] });
  }
  void queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/standing-autopay/1`] });
  void queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/standing-autopay/1/quote`] });
  void queryClient.invalidateQueries({ queryKey: ["/api/financials/leagues", leagueId, "interactive-payment-participants/3"] });
  void queryClient.invalidateQueries({ queryKey: ["/api/financials/leagues", leagueId, "interactive-payment-quote/3"] });
  void queryClient.invalidateQueries({ queryKey: ["/api/financials/f5/payments"] });
  void queryClient.invalidateQueries({ queryKey: [`/api/payments-provider/cards/${bowlerId}`] });
}

export default function MakePaymentPage() {
  const { toast } = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const [, navigate] = useLocation();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const urlLeagueId = params.get("leagueId");
  const intent = params.get("intent");
  const [selectedLeagueId, setSelectedLeagueId] = useSelectedLeague(urlLeagueId ? Number(urlLeagueId) : undefined);
  const [leagueSheetOpen, setLeagueSheetOpen] = useState(false);
  const [cardMode, setCardMode] = useState<"new" | "saved">("new");
  const [selectedSavedCardId, setSelectedSavedCardId] = useState("");
  const [storeCard, setStoreCard] = useState(false);
  const [receiptEmail, setReceiptEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isWalletProcessing, setIsWalletProcessing] = useState(false);
  const [walletRecoveryReady, setWalletRecoveryReady] = useState(false);
  const [recoveryRetry, setRecoveryRetry] = useState(0);
  const [cardEditorMode, setCardEditorMode] = useState<EditorMode>(null);
  const [oneTimeCardEditorKey, setOneTimeCardEditorKey] = useState(0);
  const walletRequestKeyRef = useRef<string | null>(null);
  const recoveryNoticeRef = useRef<string | null>(null);
  const intentAppliedRef = useRef(false);
  const [selectedRecipients, setSelectedRecipients] = useState<Record<number, boolean>>({});
  const [recipientWeeks, setRecipientWeeks] = useState<Record<number, number>>({});
  const [selectionStale, setSelectionStale] = useState(false);

  const { data: currentUser, isLoading: loadingUser, error: userError } = useQuery<ApiResponse<User>>({ queryKey: ["/api/user"] });
  const bowlerId = currentUser?.data?.bowlerId;
  const { data: detailsResponse, isLoading: loadingDetails, error: detailsError, refetch: refetchDetails } = useQuery<ApiResponse<BowlerDetailsResponse>>({
    queryKey: [`/api/bowlers/${bowlerId}/details`, { includePayments: true }],
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/bowlers/${bowlerId}/details?includePayments=true`, { credentials: "include", headers: { Accept: "application/json" }, signal });
      if (!response.ok) throw new Error((await response.json().catch(() => ({})))?.error?.message || "Failed to fetch bowler details");
      return response.json();
    },
    enabled: !!bowlerId,
  });
  const details = detailsResponse?.data;
  const bowlerLeagues = useMemo(() => details?.bowlerLeagues ?? [], [details?.bowlerLeagues]);
  useEffect(() => {
    if (!bowlerLeagues.length) return;
    const validIds = bowlerLeagues.map((membership) => membership.leagueId);
    if (selectedLeagueId !== null && !validIds.includes(selectedLeagueId)) setSelectedLeagueId(validIds[0]);
  }, [bowlerLeagues, selectedLeagueId, setSelectedLeagueId]);
  const leagueId = selectedLeagueId ?? bowlerLeagues[0]?.leagueId;
  const leagueMap = useMemo(() => new Map((details?.leagues ?? []).map((league) => [league.id, league])), [details?.leagues]);
  const league = leagueId === undefined ? undefined : leagueMap.get(leagueId);
  const hasMultipleLeagues = bowlerLeagues.length > 1;

  const {
    data: participantsResponse,
    isLoading: loadingParticipants,
    error: participantsError,
    refetch: refetchParticipants,
  } = useQuery<ApiResponse<InteractivePaymentParticipantsResponse>>({
    queryKey: ["/api/financials/leagues", leagueId ?? 0, "interactive-payment-participants/3"],
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/financials/leagues/${leagueId}/interactive-payment-participants/3`, {
        credentials: "include",
        headers: { Accept: "application/json" },
        signal,
      });
      const body = await response.json().catch(() => ({})) as ApiResponse<InteractivePaymentParticipantsResponse>;
      if (!response.ok) throw new Error(body.error?.message || "Payment recipients are unavailable");
      return body;
    },
    enabled: !!bowlerId && !!leagueId,
    staleTime: 30_000,
    retry: false,
  });
  const participants = useMemo(() => participantsResponse?.data?.participants ?? [], [participantsResponse?.data?.participants]);
  const paymentMode: InteractivePaymentMode = participantsResponse?.data?.paymentMode ?? league?.paymentMode ?? "weekly";

  const savedCardsQueryEnabled = !!bowlerId && !!leagueId;
  const {
    data: savedCardsResponse,
    isLoading: loadingSavedCards,
    error: savedCardsError,
    refetch: refetchSavedCards,
  } = useQuery<ApiResponse<SavedCard[]>>({
    queryKey: [`/api/payments-provider/cards/${bowlerId}`, leagueId],
    queryFn: async () => {
      const response = await csrfFetch(`/api/payments-provider/cards/${bowlerId}?leagueId=${leagueId}`);
      if (!response.ok) throw new Error("Failed to fetch saved cards");
      return response.json();
    },
    enabled: savedCardsQueryEnabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const savedCards = savedCardsResponse?.data ?? [];
  const savedCardReadState = resolveSavedCardReadState(
    savedCardsQueryEnabled,
    savedCardsResponse !== undefined,
    loadingSavedCards,
    savedCardsError !== null,
  );
  useSavedCardDefault({ firstSavedCardId: savedCards[0]?.id ?? null, setCardMode, setSelectedSavedCardId, dependencyKey: String(leagueId ?? "") });
  const selfParticipant = participants.find((participant) => participant.role === "self");
  const fullBalanceOnly = paymentMode === "upfront";
  const effectiveSelectedRecipients = useMemo(() => {
    const next = { ...selectedRecipients };
    for (const participant of participants) {
      if (!(participant.bowlerId in next)) next[participant.bowlerId] = isInteractiveParticipantSelectedByDefault(participant);
    }
    return next;
  }, [participants, selectedRecipients]);
  const selectedRecipientRows = useMemo<PaymentRecipientRow[]>(() => participants.map((participant) => {
    const maximumWeeks = participant.weeklyOptions.at(-1)?.weeks ?? 0;
    const weeks = fullBalanceOnly
      ? initialInteractivePaymentWeeks(participant, paymentMode)
      : Math.max(1, Math.trunc(recipientWeeks[participant.bowlerId] ?? 1));
    return {
      bowlerId: participant.bowlerId,
      name: participant.name,
      role: participant.role,
      remainingMinor: participant.remainingMinor,
      pastDueMinor: participant.pastDueMinor,
      weeks,
      maximumWeekCount: Math.max(1, maximumWeeks),
      amountMinor: participantAmountForSelection(participant, weeks, paymentMode),
      selected: effectiveSelectedRecipients[participant.bowlerId] === true,
      eligible: participant.eligible && participant.remainingMinor > 0,
      reason: participant.reason,
    };
  }), [participants, fullBalanceOnly, paymentMode, recipientWeeks, effectiveSelectedRecipients]);
  const recipientSelections = useMemo(() => selectionStale ? [] : buildInteractivePaymentRecipients(participants, effectiveSelectedRecipients, recipientWeeks, paymentMode), [participants, effectiveSelectedRecipients, recipientWeeks, paymentMode, selectionStale]);
  const recipientSelectionKey = useMemo(() => JSON.stringify(recipientSelections), [recipientSelections]);
  const {
    data: quoteResponse,
    isLoading: loadingQuote,
    isFetching: fetchingQuote,
    error: quoteError,
  } = useQuery<ApiResponse<InteractivePaymentQuote>>({
    queryKey: ["/api/financials/leagues", leagueId ?? 0, "interactive-payment-quote/3", recipientSelectionKey, recipientSelections],
    queryFn: async ({ signal }) => {
      const response = await csrfFetch(`/api/financials/leagues/${leagueId}/interactive-payment-quote/3`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipients: recipientSelections }),
        signal,
      });
      const body = await response.json().catch(() => ({})) as ApiResponse<InteractivePaymentQuote>;
      if (!response.ok) throw new Error(body.error?.message || "Payment quote is unavailable");
      return body;
    },
    enabled: !!bowlerId && !!leagueId && participantsResponse?.data !== undefined && recipientSelections.length > 0,
    staleTime: 0,
    retry: false,
  });
  const quote = quoteResponse?.data;
  const paymentAmountMinor = quote?.amountMinor ?? 0;
  const hasPositivePaymentAmount = paymentAmountMinor > 0;
  const bowlerEmail = details?.bowler?.email ?? "";
  const paymentActorUserId = currentUser?.data?.id;
  const paymentOrganizationId = league?.organizationId;
  const paymentIntentScope = typeof bowlerId === "number" && typeof leagueId === "number" && typeof paymentOrganizationId === "number" && Number.isSafeInteger(paymentOrganizationId) && typeof paymentActorUserId === "number" && Number.isSafeInteger(paymentActorUserId)
    ? interactivePaymentIntentScope({ actorUserId: paymentActorUserId, organizationId: paymentOrganizationId, leagueId, bowlerId })
    : null;
  const affectedBowlerIds = useMemo(() => recipientSelections.map((recipient) => recipient.bowlerId), [recipientSelections]);
  const affectedBowlerIdsRef = useRef<number[]>(affectedBowlerIds);
  affectedBowlerIdsRef.current = affectedBowlerIds;
  const recipientSelectionKeyRef = useRef(recipientSelectionKey);
  recipientSelectionKeyRef.current = recipientSelectionKey;
  const displayedQuoteRef = useRef<{ fingerprint: string; amountMinor: number; selectionKey: string } | null>(null);
  displayedQuoteRef.current = quote ? { fingerprint: quote.fingerprint, amountMinor: quote.amountMinor, selectionKey: recipientSelectionKey } : null;
  // A wallet sheet can remain open while participants or the quote refetch.
  // Freeze the exact consented quote at the click that opened the sheet; a
  // mutable "currently displayed" quote is not an acceptable authorization
  // for the token returned later by the native wallet UI.
  const walletStartQuoteRef = useRef<{ fingerprint: string; amountMinor: number; selectionKey: string } | null>(null);
  const selectedRecipientsRef = useRef(effectiveSelectedRecipients);
  selectedRecipientsRef.current = effectiveSelectedRecipients;
  const recipientWeeksRef = useRef(recipientWeeks);
  recipientWeeksRef.current = recipientWeeks;
  const participantSnapshotRef = useRef<InteractivePaymentParticipant[] | null>(null);
  // A successful payment is expected to change the participant balances on
  // the next authoritative refetch. Keep that expected transition from being
  // mistaken for an external stale-basket change.
  const participantRefreshBaselineRef = useRef<InteractivePaymentParticipant[] | null>(null);
  const [isRecoveryBlocked, setIsRecoveryBlocked] = useState(false);
  const { supportsWallets } = usePaymentProvider(league?.locationId ?? null);

  useEffect(() => {
    if (participants.length === 0) return;
    const expectedRefreshBaseline = participantRefreshBaselineRef.current;
    const isExpectedPaymentRefresh = expectedRefreshBaseline !== null;
    if (isExpectedPaymentRefresh) {
      // The query may rerender with the same participant data before the
      // post-payment response arrives. Keep the marker until that data
      // actually changes, then accept that expected balance transition.
      if (JSON.stringify(expectedRefreshBaseline) !== JSON.stringify(participants)) {
        participantRefreshBaselineRef.current = null;
      }
      participantSnapshotRef.current = participants;
    } else {
      const previousParticipants = participantSnapshotRef.current;
      if (previousParticipants && Object.values(selectedRecipientsRef.current).some(Boolean)) {
        const previousById = new Map(previousParticipants.map((participant) => [participant.bowlerId, participant]));
        const currentById = new Map(participants.map((participant) => [participant.bowlerId, participant]));
        const stale = Object.entries(selectedRecipientsRef.current).some(([id, isSelected]) => {
          if (!isSelected) return false;
          const bowlerId = Number(id);
          const previous = previousById.get(bowlerId);
          const current = currentById.get(bowlerId);
          if (!previous || !current || !current.eligible || current.remainingMinor <= 0) return true;
          const selectedWeeks = recipientWeeksRef.current[bowlerId] ?? 1;
          const maximumWeeks = current.weeklyOptions.at(-1)?.weeks ?? 0;
          return selectedWeeks > maximumWeeks
            || previous.role !== current.role
            || previous.remainingMinor !== current.remainingMinor
            || previous.pastDueMinor !== current.pastDueMinor
            || JSON.stringify(previous.weeklyOptions) !== JSON.stringify(current.weeklyOptions);
        });
        participantSnapshotRef.current = participants;
        if (stale) {
          setSelectionStale(true);
          return;
        }
      } else {
        participantSnapshotRef.current = participants;
      }
    }
    if (selectionStale) return;
    setSelectedRecipients((current) => {
      const next: Record<number, boolean> = {};
      for (const participant of participants) {
        next[participant.bowlerId] = participant.eligible && participant.remainingMinor > 0
          ? current[participant.bowlerId] ?? isInteractiveParticipantSelectedByDefault(participant)
          : false;
      }
      const currentKeys = Object.keys(current);
      const nextKeys = Object.keys(next);
      return currentKeys.length === nextKeys.length && nextKeys.every((key) => current[Number(key)] === next[Number(key)]) ? current : next;
    });
    setRecipientWeeks((current) => {
      const next: Record<number, number> = {};
      for (const participant of participants) {
        next[participant.bowlerId] = paymentMode === "upfront"
          ? initialInteractivePaymentWeeks(participant, paymentMode)
          : clampInteractivePaymentWeeks(participant, current[participant.bowlerId] ?? 1);
      }
      const currentKeys = Object.keys(current);
      const nextKeys = Object.keys(next);
      return currentKeys.length === nextKeys.length && nextKeys.every((key) => current[Number(key)] === next[Number(key)]) ? current : next;
    });
  }, [participants, paymentMode, selectionStale]);

  useEffect(() => {
    participantSnapshotRef.current = null;
    setSelectionStale(false);
    setSelectedRecipients({});
    setRecipientWeeks({});
  }, [leagueId]);

  useEffect(() => {
    const selfPastDue = selfParticipant?.pastDueMinor ?? 0;
    const selfOptions = selfParticipant?.weeklyOptions ?? [];
    if (intent !== "past-due" || intentAppliedRef.current || selfPastDue <= 0 || selfOptions.length === 0) return;
    const suggested = selfOptions.find((option) => option.amountMinor >= selfPastDue);
    const suggestedWeeks = suggested?.weeks ?? selfOptions.at(-1)?.weeks ?? 1;
    if (selfParticipant) {
      setSelectedRecipients((current) => ({ ...current, [selfParticipant.bowlerId]: true }));
      setRecipientWeeks((current) => ({ ...current, [selfParticipant.bowlerId]: suggestedWeeks }));
    }
    intentAppliedRef.current = true;
  }, [intent, selfParticipant]);
  useEffect(() => {
    if (savedCardReadState !== "ready") return;
    setCardEditorMode(savedCards.length === 0 ? "one-time" : null);
  }, [savedCardReadState, savedCards.length]);
  // Wallet tokenization must remain inside the browser's user gesture. This
  // single scoped probe owns recovery state and persists the identity before
  // Square's button is enabled, so the click callback never awaits recovery.
  useEffect(() => {
    const recoveryLeagueId = leagueId;
    const recoveryBowlerId = bowlerId;
    const walletShouldPrepare = supportsWallets && typeof recoveryLeagueId === "number" && typeof recoveryBowlerId === "number" && hasPositivePaymentAmount;
    if (!paymentIntentScope || typeof recoveryLeagueId !== "number" || typeof recoveryBowlerId !== "number") {
      walletRequestKeyRef.current = null;
      setWalletRecoveryReady(false);
      setIsRecoveryBlocked(false);
      return;
    }
    let cancelled = false;
    setWalletRecoveryReady(false);
    setIsRecoveryBlocked(false);
    void prepareRosterPaymentIntent(paymentIntentScope, recoveryLeagueId, { createIfMissing: walletShouldPrepare })
      .then(async (prepared) => {
        if (cancelled) return;
        if (prepared.outcome === "none") {
          walletRequestKeyRef.current = null;
        } else if (prepared.outcome === "new") {
          walletRequestKeyRef.current = prepared.requestKey;
          if (walletShouldPrepare) {
            recoveryNoticeRef.current = null;
            setWalletRecoveryReady(true);
          }
        } else if (prepared.outcome === "succeeded") {
          setIsRecoveryBlocked(true);
          const noticeKey = `${paymentIntentScope}:${prepared.requestKey}`;
          if (recoveryNoticeRef.current !== noticeKey) {
            recoveryNoticeRef.current = noticeKey;
            toastRef.current({ title: "Payment already confirmed", description: "Your previous payment was confirmed. Refreshing the payment balance." });
          }
          const affectedIds = [...new Set([recoveryBowlerId, ...affectedBowlerIdsRef.current])];
          await Promise.all(affectedIds.map((affectedId) => invalidatePaymentHistoryFinancials(queryClient, recoveryLeagueId, affectedId)));
          if (cancelled) return;
          invalidatePaymentViews(recoveryLeagueId, recoveryBowlerId, affectedIds);
          setSelectionStale(false);
          setSelectedRecipients({});
          setRecipientWeeks({});
          clearPaymentIntent(prepared.scope ?? paymentIntentScope, prepared.requestKey);
          walletRequestKeyRef.current = null;
          setIsRecoveryBlocked(false);
        } else if (prepared.outcome === "terminal_failure") {
          clearPaymentIntent(prepared.scope ?? paymentIntentScope, prepared.requestKey);
          if (walletShouldPrepare) {
            const retry = await prepareRosterPaymentIntent(paymentIntentScope, recoveryLeagueId);
            if (!cancelled && retry.outcome === "new") {
              walletRequestKeyRef.current = retry.requestKey;
              recoveryNoticeRef.current = null;
              setWalletRecoveryReady(true);
            }
          }
        } else if (prepared.outcome === "unresolved") {
          walletRequestKeyRef.current = prepared.requestKey;
          setIsRecoveryBlocked(true);
        }
      })
      .catch(() => {
        if (!cancelled) setIsRecoveryBlocked(true);
      });
    return () => { cancelled = true; };
  }, [supportsWallets, paymentIntentScope, leagueId, bowlerId, hasPositivePaymentAmount, recoveryRetry]);

  const { card, isInitialized, initializeCard, cleanupCard } = useSquarePayment({
    locationId: league?.locationId,
    onError: (error) => toast({ title: "Payment Setup Error", description: error, variant: "destructive" }),
  });
  const resetWalletRecovery = useCallback(() => {
    walletRequestKeyRef.current = null;
    setWalletRecoveryReady(false);
    setRecoveryRetry((value) => value + 1);
  }, []);
  const previousLeagueIdRef = useRef<number | undefined>(leagueId);
  useEffect(() => {
    if (previousLeagueIdRef.current !== undefined && previousLeagueIdRef.current !== leagueId) {
      cleanupCard();
      walletRequestKeyRef.current = null;
      intentAppliedRef.current = false;
      setCardEditorMode(savedCards.length === 0 ? "one-time" : null);
    }
    previousLeagueIdRef.current = leagueId;
  }, [leagueId, savedCards.length, cleanupCard]);
  const selectEditorMode = useCallback((mode: EditorMode) => {
    if (mode !== cardEditorMode) cleanupCard();
    setCardEditorMode(mode);
  }, [cardEditorMode, cleanupCard]);

  const handleRecipientToggle = useCallback((recipientBowlerId: number, selected: boolean) => {
    setSelectedRecipients((current) => ({ ...current, [recipientBowlerId]: selected }));
  }, []);

  const handleRecipientWeeksChange = useCallback((recipientBowlerId: number, weeks: number) => {
    const participant = participants.find((candidate) => candidate.bowlerId === recipientBowlerId);
    if (!participant || fullBalanceOnly) return;
    const nextWeeks = clampInteractivePaymentWeeks(participant, weeks);
    setRecipientWeeks((current) => ({ ...current, [recipientBowlerId]: nextWeeks }));
  }, [participants, fullBalanceOnly]);

  const resetRecipientSelection = useCallback((expectBalanceRefresh = false) => {
    const nextSelected: Record<number, boolean> = {};
    const nextWeeks: Record<number, number> = {};
    for (const participant of participants) {
      nextSelected[participant.bowlerId] = isInteractiveParticipantSelectedByDefault(participant);
      nextWeeks[participant.bowlerId] = initialInteractivePaymentWeeks(participant, paymentMode);
    }
    participantSnapshotRef.current = null;
    participantRefreshBaselineRef.current = expectBalanceRefresh ? participants : null;
    setSelectionStale(false);
    setSelectedRecipients(nextSelected);
    setRecipientWeeks(nextWeeks);
  }, [participants, paymentMode]);

  const handleWalletPayment = useCallback(async (token: string, walletType: "apple_pay" | "google_pay") => {
    if (!bowlerId || !leagueId || !league || paymentAmountMinor <= 0 || recipientSelections.length === 0) return;
    const walletStartQuote = walletStartQuoteRef.current;
    walletStartQuoteRef.current = null;
    if (!walletStartQuote) {
      toast({ title: "Payment unavailable", description: "Wallet payment choices changed. Review the payment and try again.", variant: "destructive" });
      return;
    }
    const submittedSelectionKey = walletStartQuote.selectionKey;
    if (!bowlerEmail && !receiptEmail.trim()) { toast({ title: "Email required", description: "Enter an email for the receipt before paying with a wallet.", variant: "destructive" }); return; }
    const overrideEmail = !bowlerEmail && receiptEmail.trim() ? receiptEmail.trim() : undefined;
    try {
      setIsWalletProcessing(true);
      const quoteResponse = await csrfFetch(`/api/financials/leagues/${league.id}/interactive-payment-quote/3`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ recipients: recipientSelections }) });
      const quoteBody = await quoteResponse.json().catch(() => ({}));
      if (!quoteResponse.ok || !quoteBody.data?.fingerprint) throw new Error(quoteBody.error?.message || "Payment allocation is unavailable.");
      const quotedAmountMinor = quoteBody.data.amountMinor;
      if (!Number.isSafeInteger(quotedAmountMinor) || quotedAmountMinor <= 0) throw new Error("Payment allocation is unavailable.");
      if (submittedSelectionKey !== recipientSelectionKeyRef.current || !isInteractivePaymentQuoteCurrent(walletStartQuote, quoteBody.data, submittedSelectionKey)) throw new Error("Payment quote changed. Review the recipients and try again.");
      if (!paymentIntentScope) throw new Error("Payment identity is unavailable. Refresh and try again.");
      const scope = paymentIntentScope;
      const requestKey = walletRequestKeyRef.current;
      if (!requestKey) throw new Error("Payment identity is unavailable. Retry payment recovery before trying again.");
      walletRequestKeyRef.current = requestKey;
      const response = await paymentRequestWithRecovery(requestKey, () => csrfFetch(`/api/financials/leagues/${league.id}/interactive-payment-charge/3`, { method: "POST", headers: { ...paymentRequestHeaders(requestKey), "Content-Type": "application/json" }, body: JSON.stringify({ recipients: recipientSelections, sourceId: token, sourceKind: "wallet", buyerEmail: (overrideEmail ?? bowlerEmail) || null, storeCard: false, idempotencyKey: requestKey, requestFingerprint: quoteBody.data.fingerprint }) }), league.id);
      const body = await response.json().catch(() => ({}));
      const status = body.data?.status ?? body.status;
      clearWalletRequestKeyForTerminalStatus(status, walletRequestKeyRef);
      if (!response.ok) {
        resetWalletRecovery();
        throw makeApiError(body, response.status, "Wallet payment failed.");
      }
      resetWalletRecovery();
      assertRosterPaymentSucceeded(status);
      clearPaymentIntent(scope);
      const affectedIds = [...new Set([bowlerId, ...recipientSelections.map((recipient) => recipient.bowlerId)])];
      resetRecipientSelection(true);
      cleanupCard();
      setCardEditorMode(null);
      toast({ title: "Payment Successful", description: `${walletType === "apple_pay" ? "Apple Pay" : "Google Pay"} payment completed.` });
      await Promise.all(affectedIds.map((affectedId) => invalidatePaymentHistoryFinancials(queryClient, leagueId, affectedId)));
      invalidatePaymentViews(leagueId, bowlerId, affectedIds);
    } catch (error) {
      if (isHandledPaymentError(error)) {
        logger.debug("Wallet Payment", "Payment requires customer action");
      } else {
        logger.error("Wallet Payment", "Payment failed", error);
      }
      toast(isProviderNotConfiguredError(error) ? providerNotConfiguredToast({ navigate, locationId: league.locationId }) : { title: "Payment Failed", description: sanitizePaymentErrorMessage(error, "Unable to process payment."), variant: "destructive" });
    }
    finally { setIsWalletProcessing(false); }
  }, [bowlerId, leagueId, league, paymentAmountMinor, bowlerEmail, receiptEmail, toast, navigate, cleanupCard, paymentIntentScope, resetWalletRecovery, recipientSelections, resetRecipientSelection]);
  const beginWalletPayment = useCallback(() => {
    const displayedQuote = displayedQuoteRef.current;
    if (!walletRecoveryReady || selectionStale || recipientSelections.length === 0 || !displayedQuote || displayedQuote.selectionKey !== recipientSelectionKeyRef.current) {
      walletStartQuoteRef.current = null;
      return false;
    }
    walletStartQuoteRef.current = { ...displayedQuote };
    return true;
  }, [walletRecoveryReady, selectionStale, recipientSelections.length]);
  // Keep the SDK instance mounted while quote data is refreshing. A native
  // wallet sheet can outlive the render that opened it; tearing down the SDK
  // on a transient loading flag would invalidate that in-flight tokenization.
  // beginWalletPayment and handleWalletPayment still reject stale selections
  // and amounts before any charge request is sent.
  const wallet = useWalletPayments({ locationId: league?.locationId, amountCents: paymentAmountMinor, enabled: savedCardReadState === "ready" && !!league?.locationId && paymentAmountMinor > 0 && supportsWallets && walletRecoveryReady && !selectionStale && recipientSelections.length > 0, onPaymentStarted: beginWalletPayment, onTokenReceived: handleWalletPayment, onError: (error) => toast({ title: "Wallet Payment Error", description: error, variant: "destructive" }) });
  const cleanupWallet = wallet.cleanup;
  useEffect(() => () => cleanupWallet(), [cleanupWallet]);

  const submitOneTimePayment = async () => {
    if (!bowlerId || !leagueId || !league || recipientSelections.length === 0 || quoteError || selectionStale) { toast({ title: "Payment unavailable", description: "Select at least one payable recipient and wait for an exact payment quote.", variant: "destructive" }); return; }
    if (isWalletProcessing || wallet.isProcessing) return;
    // Capture this before any awaited recovery/quote work. If a background
    // refetch replaces the displayed quote while submit is in flight, the
    // fresh quote must still match the quote the user actually accepted.
    const acceptedQuote = displayedQuoteRef.current;
    const submittedSelectionKey = recipientSelectionKeyRef.current;
    if (!acceptedQuote || acceptedQuote.selectionKey !== submittedSelectionKey) {
      toast({ title: "Payment unavailable", description: "Payment quote changed. Review the recipients and try again.", variant: "destructive" });
      return;
    }
    try {
      setIsSubmitting(true);
      if (!paymentIntentScope) throw new Error("Payment identity is unavailable. Refresh and try again.");
      const preparedIntent = await prepareRosterPaymentIntent(paymentIntentScope, league.id);
      if (preparedIntent.outcome === "succeeded") {
        setIsRecoveryBlocked(true);
        toast({ title: "Payment already confirmed", description: "Your previous payment was confirmed. Refreshing the payment balance." });
        const affectedIds = [...new Set([bowlerId, ...affectedBowlerIdsRef.current])];
        await Promise.all(affectedIds.map((affectedId) => invalidatePaymentHistoryFinancials(queryClient, leagueId, affectedId)));
        invalidatePaymentViews(leagueId, bowlerId, affectedIds);
        resetRecipientSelection(true);
        clearPaymentIntent(preparedIntent.scope ?? paymentIntentScope, preparedIntent.requestKey);
        setIsRecoveryBlocked(false);
        return;
      }
      if (preparedIntent.outcome === "terminal_failure") {
        clearPaymentIntent(preparedIntent.scope ?? paymentIntentScope, preparedIntent.requestKey);
        throw new Error("Your previous payment was not completed. Try again.");
      }
      if (preparedIntent.outcome === "unresolved") {
        assertRosterPaymentSucceeded(preparedIntent.status);
        throw new Error("Your payment is not confirmed yet. Use payment recovery before trying again.");
      }
      if (!bowlerEmail && !receiptEmail.trim()) throw new Error("Email required. Enter an email for the receipt before paying.");
      if (cardMode === "new" && (!card || !isInitialized)) throw new Error("Card details required. Enter your card details before paying.");
      if (cardMode === "saved" && !selectedSavedCardId) throw new Error("Card required. Select a saved card before paying.");
      const requestKey = preparedIntent.requestKey;
      const latestQuoteResponse = await csrfFetch(`/api/financials/leagues/${league.id}/interactive-payment-quote/3`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ recipients: recipientSelections }) });
      const quoteBody = await latestQuoteResponse.json().catch(() => ({})) as ApiResponse<InteractivePaymentQuote>;
      if (!latestQuoteResponse.ok || !quoteBody?.data?.fingerprint || !Number.isSafeInteger(quoteBody.data.amountMinor) || quoteBody.data.amountMinor <= 0) throw new Error(quoteBody.error?.message || "Exact payment obligations are unavailable.");
      if (submittedSelectionKey !== recipientSelectionKeyRef.current || !isInteractivePaymentQuoteCurrent(acceptedQuote, quoteBody.data, submittedSelectionKey)) {
        throw new Error("Payment quote changed. Review the recipients and try again.");
      }
      const cardToTokenize = card;
      if (cardMode === "new" && !cardToTokenize) throw new Error("A payment source is required.");
      const sourceId = cardMode === "saved" ? selectedSavedCardId : await tokenizeCard(cardToTokenize);
      if (submittedSelectionKey !== recipientSelectionKeyRef.current || !isInteractivePaymentQuoteCurrent(acceptedQuote, displayedQuoteRef.current, submittedSelectionKey)) throw new Error("Payment quote changed. Review the recipients and try again.");
      const response = await paymentRequestWithRecovery(requestKey, () => csrfFetch(`/api/financials/leagues/${league.id}/interactive-payment-charge/3`, { method: "POST", headers: { ...paymentRequestHeaders(requestKey), "Content-Type": "application/json" }, body: JSON.stringify({ recipients: recipientSelections, sourceId, sourceKind: cardMode === "saved" ? "saved_card" : "new_card", buyerEmail: bowlerEmail || receiptEmail.trim() || null, storeCard: cardMode === "new" ? storeCard : false, idempotencyKey: requestKey, requestFingerprint: quoteBody.data.fingerprint }) }), league.id);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw makeApiError(body, response.status, "Payment failed");
      assertRosterPaymentSucceeded(body.data?.status ?? body.status);
      clearPaymentIntent(paymentIntentScope);
      const affectedIds = [...new Set([bowlerId, ...recipientSelections.map((recipient) => recipient.bowlerId)])];
      resetRecipientSelection(true);
      cleanupCard();
      const reinitializeOneTimeEditor = shouldReinitializeOneTimeCardEditor(cardMode, savedCards.length);
      setCardEditorMode(reinitializeOneTimeEditor ? "one-time" : null);
      if (reinitializeOneTimeEditor) setOneTimeCardEditorKey((key) => key + 1);
      toast({ title: "Payment Successful", description: `${formatCurrency(paymentAmountMinor)} has been paid.` });
      await Promise.all(affectedIds.map((affectedId) => invalidatePaymentHistoryFinancials(queryClient, leagueId, affectedId)));
      invalidatePaymentViews(leagueId, bowlerId, affectedIds);
      if (storeCard && cardMode === "new") void queryClient.invalidateQueries({ queryKey: [`/api/payments-provider/cards/${bowlerId}`] });
    } catch (error) {
      if (isHandledPaymentError(error)) {
        logger.debug("Payment", "Payment requires customer action");
      } else {
        logger.error("Payment", "Payment failed", error);
      }
      toast(isProviderNotConfiguredError(error) ? providerNotConfiguredToast({ navigate, locationId: league.locationId }) : { title: "Payment Failed", description: sanitizePaymentErrorMessage(error, "Unable to process payment. Please try again."), variant: "destructive" });
    }
    finally { setIsSubmitting(false); }
  };

  if (loadingUser || loadingDetails || loadingParticipants || savedCardReadState === "loading") return <PageLoadingState />;
  if (userError) return <PageLoadingState message="Authentication required" />;
  if (currentUser?.data && !currentUser.data.bowlerId) return <PageLoadingState message="A bowler profile is required to make a payment" />;
  if (detailsError) return <MakePaymentReadError message="Payment profile data could not be loaded. Try again." onRetry={() => { void refetchDetails(); }} leagueId={selectedLeagueId ?? undefined} />;
  if (participantsError) return <MakePaymentReadError message="Payment recipient data could not be loaded. Try again." onRetry={() => { void refetchParticipants(); }} leagueId={selectedLeagueId ?? undefined} />;
  if (savedCardReadState === "unavailable") return <MakePaymentReadError message="Saved payment methods could not be loaded. Try again." onRetry={() => { void refetchSavedCards(); }} leagueId={selectedLeagueId ?? undefined} />;
  if (!league || leagueId === undefined || !bowlerId) return <MakePaymentReadError message="Payment information is unavailable. Try again or view payment history." onRetry={() => { void refetchDetails(); void refetchParticipants(); }} leagueId={selectedLeagueId ?? undefined} />;

  const hasEligibleParticipant = participants.some((participant) => participant.eligible && participant.remainingMinor > 0);
  const isPaidInFull = selfParticipant !== undefined && !hasEligibleParticipant && selfParticipant.remainingMinor <= 0;
  const breakdownRows: PaymentBreakdownRow[] = quote?.recipients?.map((row) => ({
    bowlerId: row.bowlerId,
    name: row.name,
    role: row.role,
    amountMinor: row.subtotalMinor,
    coveredWeeks: row.coveredWeeks,
    allocations: row.allocations.map((allocation) => ({
      obligationId: allocation.obligationId,
      amountMinor: allocation.amountMinor,
      occurrenceLocalDate: allocation.occurrenceLocalDate,
      plannedOrdinal: allocation.plannedOrdinal,
      label: allocation.label,
    })),
  })) ?? [];
  return <BowlerLayout bowlerName={details?.bowler?.name ?? ""} leagueName={league.name} currentLeagueId={leagueId}>
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold mb-1">Make a Payment</h1>
        {hasMultipleLeagues ? <button type="button" onClick={() => setLeagueSheetOpen(true)} className="flex items-center gap-1 text-slate-500 hover:text-slate-700 transition-colors">{league.name}<span aria-hidden="true">⌄</span></button> : <p className="text-muted-foreground">{league.name}</p>}
      </div>
      <ErrorBoundary level="section">
        {isRecoveryBlocked ? <div role="status" className="rounded-lg border border-amber-500/50 bg-amber-500/5 p-6 text-center"><h2 className="text-lg font-semibold">Payment confirmation in progress</h2><p className="mt-1 text-sm text-muted-foreground">Your previous payment is still being confirmed. Check its status before trying another card.</p><button type="button" className="mt-3 text-sm underline" onClick={() => setRecoveryRetry((value) => value + 1)}>Check payment status again</button></div> : isPaidInFull ? <div className="rounded-lg border border-green-500/50 bg-green-500/5 p-6 text-center"><h2 className="text-lg font-semibold text-green-700">Season Paid in Full</h2><p className="mt-1 text-sm text-muted-foreground">There is no remaining one-time balance.</p></div> : <BowlerOneTimePaymentCard
          key={oneTimeCardEditorKey}
          paymentAmountMinor={paymentAmountMinor}
          fullBalanceOnly={fullBalanceOnly}
          savedCards={savedCards}
          cardMode={cardMode}
          setCardMode={setCardMode}
          selectedSavedCardId={selectedSavedCardId}
          setSelectedSavedCardId={setSelectedSavedCardId}
          storeCard={storeCard}
          setStoreCard={setStoreCard}
          isInitialized={isInitialized && cardEditorMode === "one-time"}
          isSubmitting={isSubmitting}
          onSubmit={() => void submitOneTimePayment()}
          initializeCard={initializeCard}
          cleanupCard={cleanupCard}
          onCardEditorModeChange={selectEditorMode}
          cardEditorMode={cardEditorMode}
          applePayAvailable={wallet.applePayAvailable}
          googlePayAvailable={wallet.googlePayAvailable}
          applePayTokenizeOnly={wallet.applePayTokenizeOnly}
          googlePayTokenizeOnly={wallet.googlePayTokenizeOnly}
          applePayRef={wallet.applePayRef}
          googlePayRef={wallet.googlePayRef}
          onApplePayClick={wallet.handleApplePayClick}
          onGooglePayClick={wallet.handleGooglePayClick}
          isWalletProcessing={wallet.isProcessing || isWalletProcessing}
          bowlerHasEmail={!!bowlerEmail}
          receiptEmail={receiptEmail}
          onReceiptEmailChange={setReceiptEmail}
          recipientRows={selectedRecipientRows}
          breakdownRows={breakdownRows}
          quoteLoading={loadingQuote || fetchingQuote}
          quoteError={quoteError && !selectionStale ? "Payment quote is unavailable. Refresh and try again." : null}
          selectionStale={selectionStale}
          onRecipientToggle={handleRecipientToggle}
          onRecipientWeeksChange={handleRecipientWeeksChange}
          onResetRecipientSelection={resetRecipientSelection}
        />}
      </ErrorBoundary>
      {paymentMode !== "upfront" && <ErrorBoundary level="section"><StandingAutopayCard league={league} bowlerId={bowlerId} savedCards={savedCards} bowlerHasEmail={!!bowlerEmail} card={card} isInitialized={isInitialized && cardEditorMode === "autopay"} cardEditorMode={cardEditorMode} initializeCard={initializeCard} cleanupCard={cleanupCard} onCardEditorModeChange={selectEditorMode} /></ErrorBoundary>}
    </div>
    <LeagueSwitcherSheet open={leagueSheetOpen} onClose={() => setLeagueSheetOpen(false)} bowlerLeagues={bowlerLeagues} leagueMap={leagueMap} selectedLeagueId={leagueId} onSelect={(nextId) => { setSelectedLeagueId(nextId); intentAppliedRef.current = false; navigate(`/make-payment?leagueId=${nextId}`); }} />
  </BowlerLayout>;
}
