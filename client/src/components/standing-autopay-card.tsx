import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { League, SavedCard } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";

type Props = { league: League; bowlerId: number; savedCards: SavedCard[] };
type Consent = { state: "none" | "pending" | "active" | "revoked" | "expired"; providerLocationId: string | null; partnerBowlerIds: number[] };
type PartnerLink = { status: string; partnerBowlerId: number; partnerName: string };

function commandKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, "")}`;
}

export function StandingAutopayCard({ league, bowlerId, savedCards }: Props) {
  const { toast } = useToast();
  const [selectedCard, setSelectedCard] = useState(savedCards[0]?.id ?? "");
  const [partnerIds, setPartnerIds] = useState<number[]>([]);
  const [replaceMode, setReplaceMode] = useState(false);
  const enabled = league.payingLineupSize !== null;
  const statusQuery = useQuery<{ data: Consent }>({
    queryKey: [`/api/financials/leagues/${league.id}/standing-autopay/1`],
    enabled,
    retry: false,
  });
  const consent = statusQuery.data?.data;
  const linksQuery = useQuery<{ data?: { links?: PartnerLink[] } }>({
    queryKey: ["/api/bowler-links"],
    enabled: enabled && bowlerId > 0,
    retry: false,
  });
  const partnerOptions = useMemo(
    () => (linksQuery.data?.data?.links ?? []).filter((link) => link.status === "accepted"),
    [linksQuery.data],
  );
  const activate = useMutation({
    mutationFn: () => apiRequest(`/api/financials/leagues/${league.id}/standing-autopay/1/consent`, "POST", {
      commandKey: commandKey("standing-consent"), sourceId: selectedCard, providerName: "square", providerLocationId: String(league.locationId ?? ""), partnerBowlerIds: partnerIds,
    }),
    onSuccess: () => { setReplaceMode(false); void queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${league.id}/standing-autopay/1`] }); toast({ title: "Automatic weekly payments enabled" }); },
    onError: (error: Error) => toast({ title: "Automatic payments unavailable", description: error.message, variant: "destructive" }),
  });
  const revoke = useMutation({
    mutationFn: () => apiRequest(`/api/financials/leagues/${league.id}/standing-autopay/1/revoke`, "POST", { commandKey: commandKey("standing-revoke") }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${league.id}/standing-autopay/1`] }); toast({ title: "Automatic weekly payments revoked" }); },
    onError: (error: Error) => toast({ title: "Could not revoke automatic payments", description: error.message, variant: "destructive" }),
  });

  if (!enabled) return null;
  if (league.paymentMode === "upfront") return <Card><CardHeader><CardTitle>Automatic payments</CardTitle></CardHeader><CardContent><p className="text-sm text-muted-foreground">Standing automatic payments are weekly only. Use the exact balance checkout for this upfront league.</p></CardContent></Card>;
  const active = consent?.state === "active";
  return <Card data-testid="standing-autopay-card"><CardHeader><CardTitle className="flex items-center justify-between">Weekly automatic payments {active ? <Badge>Enabled</Badge> : <Badge variant="secondary">Off</Badge>}</CardTitle></CardHeader><CardContent className="space-y-3">
    <p className="text-sm text-muted-foreground">At each occurrence cutoff, only your exact remaining roster obligations are collected. Manual payment wins first; double-pay groups are collected as their published group.</p>
    {active && !replaceMode ? <><p className="text-sm">Saved payment method and consent version are active. Accepted partners: {consent?.partnerBowlerIds?.length ?? 0}.</p><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={revoke.isPending} onClick={() => revoke.mutate()}>Revoke automatic payments</Button><Button type="button" variant="outline" onClick={() => setReplaceMode(true)}>Replace payment method</Button></div></> : <>
      {savedCards.length === 0 ? <p className="text-sm text-muted-foreground">Save a card before enabling automatic payments.</p> : <><label className="block text-sm">Saved card<select className="mt-1 w-full rounded border bg-background p-2" value={selectedCard} onChange={(event) => setSelectedCard(event.target.value)}><option value="">Select a card</option>{savedCards.map((card) => <option key={card.id} value={card.id}>{card.brand} ending {card.last4}</option>)}</select></label>{partnerOptions.length > 0 && <fieldset className="space-y-1"><legend className="text-sm">Accepted partners (optional)</legend>{partnerOptions.map((partner) => <label className="block text-sm" key={partner.partnerBowlerId}><input type="checkbox" className="mr-2" checked={partnerIds.includes(partner.partnerBowlerId)} onChange={(event) => setPartnerIds((current) => event.target.checked ? [...current, partner.partnerBowlerId].sort((a, b) => a - b) : current.filter((id) => id !== partner.partnerBowlerId))} />{partner.partnerName}</label>)}</fieldset>}<div className="flex flex-wrap gap-2"><Button type="button" disabled={!selectedCard || activate.isPending} onClick={() => activate.mutate()}>{active ? "Replace payment method" : "Enable weekly automatic payments"}</Button>{active && <Button type="button" variant="ghost" onClick={() => setReplaceMode(false)}>Cancel</Button>}</div></>}
    </>}
  </CardContent></Card>;
}
