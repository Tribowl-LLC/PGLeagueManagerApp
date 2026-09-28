/* eslint-disable shadcn/no-restyle, shadcn/no-unknown-classes */
import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { League, SavedCard } from "@shared/schema";
import type { StandingAutopayConsentWire, StandingAutopayQuoteWire } from "@shared/standing-autopay-contract";
import { apiRequest, csrfFetch, queryClient } from "@/lib/queryClient";
import { tokenizeCard } from "@/lib/square";
import type { SquareCard } from "@/hooks/use-square-payment";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency } from "@/lib/utils";
import { ChevronRight, CreditCard } from "lucide-react";

type QuoteResponse = { data: StandingAutopayQuoteWire };
type EditorMode = "one-time" | "autopay" | null;
type Props = {
  league: Pick<League, "id" | "locationId" | "organizationId" | "name" | "paymentMode" | "payingLineupSize" | "timezone"> & Partial<Pick<League, "totalBowlingWeeks" | "doublePayDates">>;
  bowlerId: number;
  savedCards: SavedCard[];
  bowlerHasEmail: boolean;
  card: SquareCard | null;
  isInitialized: boolean;
  cardEditorMode: EditorMode;
  initializeCard: (element: HTMLDivElement) => Promise<void>;
  cleanupCard: () => void;
  onCardEditorModeChange: (mode: EditorMode) => void;
  dueNowMinor?: number;
  catchUpWeeks?: number;
  dueNowDataAvailable?: boolean;
  combinedCheckoutActive?: boolean;
  onPayDueNow?: () => void;
  partnerAutopayNote?: string;
};

function commandKey(prefix: string): string { return `${prefix}-${crypto.randomUUID().replace(/-/g, "")}`; }

function doublePayScheduleCopy(doublePayDates: string[] | null | undefined): string {
  if (!doublePayDates || doublePayDates.length === 0) return "None scheduled";
  return doublePayDates.join(", ");
}

export function formatNextPaymentDate(value: string, timezone: string | null | undefined): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unavailable";
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeZone: timezone ?? "UTC" }).format(date);
  } catch {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeZone: "UTC" }).format(date);
  }
}

function formatNextPaymentShortDate(value: string, timezone: string | null | undefined): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unavailable";
  try {
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: timezone ?? "UTC" }).format(date);
  } catch {
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" }).format(date);
  }
}

function formatStandingAutopayAmount(amountMinor: number): string {
  return formatCurrency(amountMinor).replace(/\.00$/, "");
}

function formatStandingAutopayBrand(value: string): string {
  const brands: Record<string, string> = {
    AMERICAN_EXPRESS: "American Express",
    DISCOVER: "Discover",
    JCB: "JCB",
    MASTERCARD: "Mastercard",
    UNIONPAY: "UnionPay",
    VISA: "Visa",
  };
  return brands[value.trim().toUpperCase()] ?? value;
}

export function StandingAutopayCard({ league, bowlerId, savedCards, bowlerHasEmail, card, isInitialized, cardEditorMode, initializeCard, cleanupCard, onCardEditorModeChange, dueNowMinor = 0, dueNowDataAvailable = true, combinedCheckoutActive = false, onPayDueNow, partnerAutopayNote }: Props) {
  const { toast } = useToast();
  const [selectedCard, setSelectedCard] = useState(savedCards[0]?.id ?? "");
  const [replaceMode, setReplaceMode] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [consentGiven, setConsentGiven] = useState(false);
  const [isSavingAndEnabling, setIsSavingAndEnabling] = useState(false);
  const [revokeDialogOpen, setRevokeDialogOpen] = useState(false);
  const consentCommandKeyRef = useRef(commandKey("standing-consent"));
  const revokeCommandKeyRef = useRef(commandKey("standing-revoke"));
  const suppressConsentErrorToastRef = useRef(false);
  const enabled = league.payingLineupSize !== null;
  const statusQuery = useQuery<{ data: StandingAutopayConsentWire }>({ queryKey: [`/api/financials/leagues/${league.id}/standing-autopay/1`], enabled, retry: false });
  const consent = statusQuery.data?.data;
  const active = consent?.state === "active";
  const statusLoading = !statusQuery.error && (statusQuery.isLoading || statusQuery.isFetching || !statusQuery.isFetched);
  const statusUnavailable = Boolean(statusQuery.error) || (statusQuery.isFetched && !consent);
  const statusReady = !statusLoading && !statusUnavailable;
  const dueNowRequired = statusReady && !active && dueNowDataAvailable && dueNowMinor > 0;
  const setupDataUnavailable = statusReady && !active && !dueNowDataAvailable;
  const paymentAttention = consent?.paymentAttention ?? null;
  const quoteQuery = useQuery<QuoteResponse>({
    queryKey: [`/api/financials/leagues/${league.id}/standing-autopay/1/quote`],
    enabled: enabled && active && paymentAttention === null,
    retry: false,
  });

  useEffect(() => {
    if (selectedCard === "" && savedCards[0]) setSelectedCard(savedCards[0].id);
    if (selectedCard && !savedCards.some((savedCard) => savedCard.id === selectedCard) && savedCards[0]) setSelectedCard(savedCards[0].id);
  }, [savedCards, selectedCard]);

  const activate = useMutation({
    mutationFn: (sourceId: string) => apiRequest(`/api/financials/leagues/${league.id}/standing-autopay/1/consent`, "POST", { commandKey: consentCommandKeyRef.current, sourceId, partnerBowlerIds: [] }),
    onSuccess: () => {
      consentCommandKeyRef.current = commandKey("standing-consent");
      setReplaceMode(false);
      void queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${league.id}/standing-autopay/1`] });
      void queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${league.id}/standing-autopay/1/quote`] });
      toast({ title: active ? "Automatic payment method updated" : "Automatic weekly payments enabled" });
    },
    onError: (error: Error & { status?: number }) => {
      // Network/5xx responses may leave the command outcome unresolved, so
      // the same key is deliberately retained for a safe retry. Known
      // validation/auth outcomes can start a new command.
      if (typeof error.status === "number" && error.status < 500) consentCommandKeyRef.current = commandKey("standing-consent");
      if (!suppressConsentErrorToastRef.current) toast({ title: "Automatic payments unavailable", description: error.message, variant: "destructive" });
    },
  });
  const revoke = useMutation({
    mutationFn: () => apiRequest(`/api/financials/leagues/${league.id}/standing-autopay/1/revoke`, "POST", { commandKey: revokeCommandKeyRef.current }),
    onSuccess: () => { revokeCommandKeyRef.current = commandKey("standing-revoke"); void queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${league.id}/standing-autopay/1`] }); toast({ title: "Automatic weekly payments revoked" }); },
    onError: (error: Error & { status?: number }) => { if (typeof error.status === "number" && error.status < 500) revokeCommandKeyRef.current = commandKey("standing-revoke"); toast({ title: "Could not revoke automatic payments", description: error.message, variant: "destructive" }); },
  });

  const saveAndEnable = async () => {
    if (!bowlerHasEmail || isSavingAndEnabling || activate.isPending) return;
    if (!card || !isInitialized) { toast({ title: "Card details required", description: "Enter your card details before continuing.", variant: "destructive" }); return; }
    let savedCardId: string | null = null;
    setIsSavingAndEnabling(true);
    try {
      const sourceId = await tokenizeCard(card);
      const response = await csrfFetch(`/api/payments-provider/cards/${bowlerId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceId, leagueId: league.id }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.data?.savedCardId) throw new Error(body.error?.message || "Unable to save this card.");
      savedCardId = String(body.data.savedCardId);
      setSelectedCard(savedCardId);
      await queryClient.invalidateQueries({ queryKey: [`/api/payments-provider/cards/${bowlerId}`] });
      cleanupCard();
      onCardEditorModeChange(null);
      suppressConsentErrorToastRef.current = true;
      try {
        await activate.mutateAsync(savedCardId);
      } finally {
        suppressConsentErrorToastRef.current = false;
      }
    } catch (error) {
      toast({ title: savedCardId ? (active ? "Card saved; payment method not replaced" : "Card saved; automatic payments still need setup") : "Automatic payments unavailable", description: error instanceof Error ? error.message : "Unable to save this card.", variant: "destructive" });
      void queryClient.invalidateQueries({ queryKey: [`/api/payments-provider/cards/${bowlerId}`] });
    } finally {
      setIsSavingAndEnabling(false);
    }
  };

  if (!enabled) return <Card data-testid="standing-autopay-card"><CardHeader><CardTitle>Automatic payments</CardTitle></CardHeader><CardContent><p className="text-sm text-muted-foreground">Automatic weekly payments are not available for this league.</p></CardContent></Card>;
  if (league.paymentMode === "upfront") return <Card data-testid="standing-autopay-card"><CardHeader><CardTitle>Automatic payments</CardTitle></CardHeader><CardContent><p className="text-sm text-muted-foreground">Standing automatic payments are weekly only. Use the exact balance checkout for this upfront league.</p></CardContent></Card>;

  const addingCard = cardEditorMode === "autopay";
  const setupPending = isSavingAndEnabling || activate.isPending;
  const quote = quoteQuery.data?.data;
  const quoteHasUpcomingPayment = Boolean(quote?.cutoffAt)
    && Number.isFinite(new Date(quote?.cutoffAt ?? "").getTime())
    && typeof quote?.amountMinor === "number"
    && quote.amountMinor > 0;
  const nextPayment = quoteQuery.isLoading
    ? "Checking…"
    : quoteQuery.isError
      ? "Unavailable"
      : quoteHasUpcomingPayment && quote?.cutoffAt
        ? `${formatStandingAutopayAmount(quote.amountMinor)} · ${formatNextPaymentShortDate(quote.cutoffAt, league.timezone)}`
        : "No upcoming payment";
  const quoteError = quoteQuery.error instanceof Error
    ? quoteQuery.error.message.replace(/^\d{3}:\s*/, "")
      : "The next automatic payment is unavailable.";
  const editorOpen = active ? replaceMode : setupOpen;
  const consentCopy = "I agree to automatic weekly payments and understand that double-pay weeks may be charged twice to cover the final weeks of the season.";
  return <>
  <Card data-testid="standing-autopay-card" className="familiar-standing-autopay-card">
    <CardHeader><CardTitle className="flex items-center justify-between">Automatic payments {active ? <Badge className="familiar-autopay-enabled-badge">Enabled</Badge> : <Badge variant="secondary">Off</Badge>}</CardTitle></CardHeader>
    <CardContent spacing="tight">
      {!bowlerHasEmail && <p className="rounded-md border border-warning-300 bg-warning-50 p-3 text-sm text-warning-900">Add an email address to your <Link href="/profile" className="font-semibold underline">Profile</Link> before enabling automatic payments. A temporary receipt email cannot be used.</p>}
      {statusLoading && <div role="status" aria-live="polite" className="rounded-md border border-muted-foreground/30 bg-muted/30 p-3 text-sm text-muted-foreground">Checking automatic-payment status…</div>}
      {statusUnavailable && <div role="alert" className="flex flex-col gap-3 rounded-md border border-warning-300 bg-warning-50 p-3 text-sm text-warning-900"><p>Automatic-payment status could not be confirmed. Refresh before continuing.</p><Button type="button" variant="outline" size="sm" onClick={() => void statusQuery.refetch()} disabled={statusQuery.isFetching}>{statusQuery.isFetching ? "Refreshing…" : "Refresh status"}</Button></div>}
      {setupDataUnavailable && <div role="alert" className="rounded-md border border-warning-300 bg-warning-50 p-3 text-sm text-warning-900">Current payment obligations are unavailable. Refresh the payment page before enabling automatic payments.</div>}
      {statusReady && !setupDataUnavailable && dueNowRequired && !combinedCheckoutActive && !setupOpen && <div className="familiar-autopay-intro"><Button type="button" variant="outline" disabled={!bowlerHasEmail} onClick={() => setSetupOpen(true)}>Set up automatic payments<ChevronRight className="size-4" aria-hidden="true" /></Button>{partnerAutopayNote && <p className="familiar-autopay-partner-note">{partnerAutopayNote}</p>}</div>}
      {statusLoading || statusUnavailable || setupDataUnavailable ? null : active && !replaceMode && !addingCard ? <>
        {paymentAttention === "scheduled_payment_declined" ? <div role="alert" className="space-y-2 rounded-md border border-warning-300 bg-warning-50 p-3 text-sm text-warning-900"><p>Your scheduled automatic payment was declined. Use the One-Time Payment section below to settle this balance before automatic payments can resume.</p></div> : <div className="familiar-autopay-next" aria-label="Next automatic payment">
          <span className="familiar-autopay-next-label">Next automatic payment</span>
          {quoteHasUpcomingPayment && quote?.cutoffAt ? <strong><span className="familiar-autopay-amount">{formatStandingAutopayAmount(quote.amountMinor)}</span><span className="familiar-autopay-date">· {formatNextPaymentShortDate(quote.cutoffAt, league.timezone)}</span></strong> : <strong>{nextPayment}</strong>}
          {quoteQuery.isError && <p role="alert" className="text-sm text-destructive">{quoteError}</p>}
          {quoteHasUpcomingPayment && quote?.collectionMode && <p>{quote.collectionMode === "double_pay" ? "Double-pay week" : "Weekly automatic payment"}</p>}
        </div>}
        {consent?.paymentMethod && <p className="familiar-autopay-method"><CreditCard className="size-4" aria-hidden="true" /><span>{formatStandingAutopayBrand(consent.paymentMethod.brand)} ending in {consent.paymentMethod.last4}</span></p>}
        <div className="familiar-autopay-actions"><Button type="button" variant="ghost" disabled={!bowlerHasEmail} onClick={() => setReplaceMode(true)}>Change card</Button><Button type="button" variant="ghost" disabled={revoke.isPending} onClick={() => setRevokeDialogOpen(true)}>Turn off</Button></div>
      </> : combinedCheckoutActive ? <div role="status">Complete checkout above to enable automatic payments.</div> : editorOpen ? <>
        {!active && <div className="familiar-autopay-review" aria-label="Automatic payment schedule review">
          <p className="familiar-autopay-review-title">Review your automatic payment schedule</p>
          <p className="familiar-autopay-review-copy">Double-pay weeks cover the final weeks of the season. Review this schedule before enabling anything.</p>
          {partnerAutopayNote && <p className="familiar-autopay-partner-note">{partnerAutopayNote}</p>}
          {dueNowRequired && <p className="familiar-autopay-review-copy">Pay {formatCurrency(dueNowMinor)} due now and enable automatic payments in one checkout.</p>}
          <dl><div><dt>Payment</dt><dd>One unpaid weekly fee</dd></div><div><dt>Double-pay weeks</dt><dd>{doublePayScheduleCopy(league.doublePayDates)}</dd></div></dl>
          {dueNowRequired && onPayDueNow && <Button type="button" disabled={!bowlerHasEmail || setupPending || !consentGiven} onClick={() => { if (consentGiven) onPayDueNow(); }}>{setupPending ? "Preparing checkout…" : "Pay due now and enable automatic payments"}</Button>}
          <label className="familiar-autopay-consent"><input type="checkbox" checked={consentGiven} onChange={(event) => setConsentGiven(event.target.checked)} disabled={!bowlerHasEmail || setupPending} /><span>{consentCopy}</span></label>
        </div>}
        {!dueNowRequired && savedCards.length > 0 && !addingCard && <label className="block text-sm">Saved card<select className="mt-1 w-full rounded border bg-background p-2" value={selectedCard} onChange={(event) => setSelectedCard(event.target.value)} disabled={!bowlerHasEmail}><option value="">Select a card</option>{savedCards.map((saved) => <option key={saved.id} value={saved.id}>{saved.brand} ending {saved.last4}</option>)}</select></label>}
        {!dueNowRequired && !addingCard && savedCards.length === 0 && <Button type="button" variant="outline" disabled={!bowlerHasEmail} onClick={() => { cleanupCard(); onCardEditorModeChange("autopay"); }}>Add new card</Button>}
        {!dueNowRequired && (addingCard || savedCards.length === 0) ? <div className="space-y-3"><p className="text-sm font-medium">{savedCards.length ? "Add a new card" : "Add a card for automatic payments"}</p><div ref={(element) => { if (element && cardEditorMode === "autopay") void initializeCard(element); }} className={cardEditorMode === "autopay" ? "min-h-20 rounded-md border p-3" : "min-h-20 rounded-md border p-3 hidden"} /><div className="flex flex-wrap gap-2"><Button type="button" disabled={!bowlerHasEmail || !isInitialized || setupPending || (!active && !consentGiven)} onClick={() => void saveAndEnable()}>{setupPending ? (active ? "Saving and replacing…" : "Saving card and enabling…") : (active ? "Save card and replace payment method" : "Save card and enable automatic payments")}</Button>{addingCard && <Button type="button" variant="ghost" disabled={setupPending} onClick={() => { cleanupCard(); onCardEditorModeChange(null); }}>Cancel</Button>}</div></div> : null}
        {!dueNowRequired && !addingCard && savedCards.length > 0 && <div className="flex flex-wrap gap-2"><Button type="button" disabled={!bowlerHasEmail || !selectedCard || setupPending || (!active && !consentGiven)} onClick={() => activate.mutate(selectedCard)}>{active ? "Replace payment method" : "Enable automatic payments"}</Button>{active && <Button type="button" variant="ghost" disabled={setupPending} onClick={() => setReplaceMode(false)}>Cancel</Button>}<Button type="button" variant="outline" disabled={!bowlerHasEmail || setupPending} onClick={() => { cleanupCard(); onCardEditorModeChange("autopay"); setReplaceMode(true); }}>Add new card</Button></div>}
      </> : !active && !dueNowRequired ? <div className="familiar-autopay-intro"><Button type="button" variant="outline" disabled={!bowlerHasEmail} onClick={() => setSetupOpen(true)}>Set up automatic payments<ChevronRight className="size-4" aria-hidden="true" /></Button>{partnerAutopayNote && <p className="familiar-autopay-partner-note">{partnerAutopayNote}</p>}</div> : null}
    </CardContent>
  </Card>
  <Dialog open={revokeDialogOpen} onOpenChange={(open) => { if (!revoke.isPending) setRevokeDialogOpen(open); }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Turn off automatic payments?</DialogTitle>
        <DialogDescription>You’ll make future payments yourself for {league.name}.</DialogDescription>
      </DialogHeader>
      <p className="text-sm text-muted-foreground">Your past payments stay in History. Turning this off does not pay or remove any outstanding balance.</p>
      <DialogFooter className="familiar-autopay-dialog-actions">
        <Button type="button" variant="outline" disabled={revoke.isPending} onClick={() => setRevokeDialogOpen(false)}>Keep automatic payments</Button>
        <Button type="button" disabled={revoke.isPending} onClick={() => { setRevokeDialogOpen(false); revoke.mutate(); }}>{revoke.isPending ? "Turning off…" : "Turn off automatic payments"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
  </>;
}
