import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { League, SavedCard } from "@shared/schema";
import { apiRequest, csrfFetch, queryClient } from "@/lib/queryClient";
import { tokenizeCard } from "@/lib/square";
import type { SquareCard } from "@/hooks/use-square-payment";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";

type Consent = { state: "none" | "pending" | "active" | "revoked" | "expired"; partnerBowlerIds: number[] };
type EditorMode = "one-time" | "autopay" | null;
type Props = {
  league: Pick<League, "id" | "locationId" | "organizationId" | "name" | "paymentMode" | "payingLineupSize">;
  bowlerId: number;
  savedCards: SavedCard[];
  bowlerHasEmail: boolean;
  card: SquareCard | null;
  isInitialized: boolean;
  cardEditorMode: EditorMode;
  initializeCard: (element: HTMLDivElement) => Promise<void>;
  cleanupCard: () => void;
  onCardEditorModeChange: (mode: EditorMode) => void;
};

function commandKey(prefix: string): string { return `${prefix}-${crypto.randomUUID().replace(/-/g, "")}`; }

export function StandingAutopayCard({ league, bowlerId, savedCards, bowlerHasEmail, card, isInitialized, cardEditorMode, initializeCard, cleanupCard, onCardEditorModeChange }: Props) {
  const { toast } = useToast();
  const [selectedCard, setSelectedCard] = useState(savedCards[0]?.id ?? "");
  const [replaceMode, setReplaceMode] = useState(false);
  const consentCommandKeyRef = useRef(commandKey("standing-consent"));
  const revokeCommandKeyRef = useRef(commandKey("standing-revoke"));
  const suppressConsentErrorToastRef = useRef(false);
  const enabled = league.payingLineupSize !== null;
  const statusQuery = useQuery<{ data: Consent }>({ queryKey: [`/api/financials/leagues/${league.id}/standing-autopay/1`], enabled, retry: false });
  const consent = statusQuery.data?.data;

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
      toast({ title: "Automatic weekly payments enabled" });
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
    if (!bowlerHasEmail) return;
    if (!card || !isInitialized) { toast({ title: "Card details required", description: "Enter your card details before continuing.", variant: "destructive" }); return; }
    let savedCardId: string | null = null;
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
      toast({ title: savedCardId ? "Card saved; automatic payments still need setup" : "Automatic payments unavailable", description: error instanceof Error ? error.message : "Unable to save this card.", variant: "destructive" });
      void queryClient.invalidateQueries({ queryKey: [`/api/payments-provider/cards/${bowlerId}`] });
    }
  };

  if (!enabled) return <Card data-testid="standing-autopay-card"><CardHeader><CardTitle>Automatic Payments</CardTitle></CardHeader><CardContent><p className="text-sm text-muted-foreground">Automatic weekly payments are not available for this league.</p></CardContent></Card>;
  if (league.paymentMode === "upfront") return <Card data-testid="standing-autopay-card"><CardHeader><CardTitle>Automatic Payments</CardTitle></CardHeader><CardContent><p className="text-sm text-muted-foreground">Standing automatic payments are weekly only. Use the exact balance checkout for this upfront league.</p></CardContent></Card>;

  const active = consent?.state === "active";
  const addingCard = cardEditorMode === "autopay";
  return <Card data-testid="standing-autopay-card">
    <CardHeader><CardTitle className="flex items-center justify-between">Automatic Payments {active ? <Badge>Enabled</Badge> : <Badge variant="secondary">Off</Badge>}</CardTitle></CardHeader>
    <CardContent className="space-y-3">
      <p className="text-sm text-muted-foreground">At each occurrence cutoff, only your exact remaining roster obligations are collected. Manual payment wins first; payments are scoped to this bowler.</p>
      {!bowlerHasEmail && <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">Add an email address to your <Link href="/profile" className="font-semibold underline">Profile</Link> before enabling automatic payments. A temporary receipt email cannot be used.</p>}
      {active && !replaceMode && !addingCard ? <><p className="text-sm">Saved payment method and consent version are active.</p><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={revoke.isPending} onClick={() => revoke.mutate()}>Revoke automatic payments</Button><Button type="button" variant="outline" disabled={!bowlerHasEmail} onClick={() => setReplaceMode(true)}>Replace payment method</Button></div></> : <>
        {savedCards.length > 0 && !addingCard && <label className="block text-sm">Saved card<select className="mt-1 w-full rounded border bg-background p-2" value={selectedCard} onChange={(event) => setSelectedCard(event.target.value)} disabled={!bowlerHasEmail}><option value="">Select a card</option>{savedCards.map((saved) => <option key={saved.id} value={saved.id}>{saved.brand} ending {saved.last4}</option>)}</select></label>}
        {!addingCard && savedCards.length === 0 && <Button type="button" variant="outline" disabled={!bowlerHasEmail} onClick={() => { cleanupCard(); onCardEditorModeChange("autopay"); }}>Add new card</Button>}
        {addingCard || savedCards.length === 0 ? <div className="space-y-3"><p className="text-sm font-medium">{savedCards.length ? "Add a new card" : "Add a card for automatic payments"}</p><div ref={(element) => { if (element && cardEditorMode === "autopay") void initializeCard(element); }} className="min-h-[80px] rounded-md border p-3" style={cardEditorMode === "autopay" ? undefined : { display: "none" }} /><div className="flex flex-wrap gap-2"><Button type="button" disabled={!bowlerHasEmail || !isInitialized || activate.isPending} onClick={() => void saveAndEnable()}>Save card and enable automatic payments</Button>{addingCard && <Button type="button" variant="ghost" onClick={() => { cleanupCard(); onCardEditorModeChange(null); }}>Cancel</Button>}</div></div> : null}
        {!addingCard && savedCards.length > 0 && <div className="flex flex-wrap gap-2"><Button type="button" disabled={!bowlerHasEmail || !selectedCard || activate.isPending} onClick={() => activate.mutate(selectedCard)}>{active ? "Replace payment method" : "Enable automatic payments"}</Button>{active && <Button type="button" variant="ghost" onClick={() => setReplaceMode(false)}>Cancel</Button>}<Button type="button" variant="outline" disabled={!bowlerHasEmail} onClick={() => { cleanupCard(); onCardEditorModeChange("autopay"); setReplaceMode(true); }}>Add new card</Button></div>}
      </>}
    </CardContent>
  </Card>;
}
