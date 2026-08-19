import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import type { SavedCard } from "@shared/schema";
import { authorizeF3CanonicalPlan, fetchF3CanonicalQuote, fetchF3PreauthorizationQuote, f3PrequoteQueryKey, f3ReadyPlanQueryKey, revokeF3CanonicalPlan } from "@/lib/f3-autopay";

interface F3CanonicalAutopaySetupProps {
  leagueId: number; organizationId: number; bowlerId: number; savedCards: SavedCard[];
  acceptedPartners?: Array<{ id: number; name: string }>;
  onCatchUp?: () => void;
}

function errorCode(error: unknown): string | undefined { return (error as { code?: string } | null)?.code; }
function exactPayeeMap(coveredBowlerIds: number[], payees: Array<{ bowlerId: number; name: string }>, itemBowlerIds: number[]): Map<number, string> | null {
  const covered = [...new Set(coveredBowlerIds)].sort((a, b) => a - b);
  const sortedPayees = [...payees].sort((a, b) => a.bowlerId - b.bowlerId);
  if (sortedPayees.length !== covered.length || new Set(sortedPayees.map((payee) => payee.bowlerId)).size !== sortedPayees.length || sortedPayees.some((payee, index) => payee.bowlerId !== covered[index] || !payee.name.trim())) return null;
  const map = new Map(sortedPayees.map((payee) => [payee.bowlerId, payee.name.trim()]));
  return itemBowlerIds.every((bowlerId) => map.has(bowlerId)) ? map : null;
}

/** Payer authorization is an explicit review of server-owned evidence. A
 * ready payer reads persisted D2 evidence first; preauthorization derivation
 * is only entered for the deliberate no-authorization setup state. */
export function F3CanonicalAutopaySetup({ leagueId, organizationId, bowlerId, savedCards, acceptedPartners = [], onCatchUp }: F3CanonicalAutopaySetupProps) {
  const { toast } = useToast(); const queryClient = useQueryClient();
  const [selectedCardId, setSelectedCardId] = useState("");
  const [selectedPartners, setSelectedPartners] = useState<number[]>([]);
  const [commandKey] = useState(() => `f3-authorize-${crypto.randomUUID()}`);
  const covered = [bowlerId, ...selectedPartners];
  const readyKey = f3ReadyPlanQueryKey(leagueId, organizationId, bowlerId);
  const ready = useQuery({ queryKey: readyKey, queryFn: () => fetchF3CanonicalQuote(leagueId, bowlerId, organizationId), retry: false });
  const readyCode = errorCode(ready.error);
  const setupRequired = ready.isError && readyCode === "PAYER_AUTHORIZATION_REQUIRED";
  const prequote = useQuery({ queryKey: f3PrequoteQueryKey(leagueId, organizationId, bowlerId, covered), queryFn: () => fetchF3PreauthorizationQuote(leagueId, bowlerId, organizationId, covered), enabled: setupRequired, retry: false });
  const authorize = useMutation({ mutationFn: async () => {
    if (!prequote.data || !selectedCardId) throw new Error("Select a saved card.");
    return authorizeF3CanonicalPlan({ leagueId, organizationId, payerBowlerId: bowlerId, policyId: prequote.data.policy.id, policyVersion: prequote.data.policy.version, authorizationVersion: prequote.data.authorization.nextAuthorizationVersion, coveredBowlerIds: prequote.data.authorization.coveredBowlerIds, acceptedPartnerIds: prequote.data.authorization.acceptedPartnerIds, collectionPointOccurrenceIds: prequote.data.authorization.collectionPointOccurrenceIds, sourceId: selectedCardId, preauthorizationFingerprint: prequote.data.fingerprint, authorizedItems: prequote.data.items, commandKey });
  }, onSuccess: () => { void queryClient.invalidateQueries({ queryKey: readyKey }); void queryClient.invalidateQueries({ queryKey: ["f3-prequote", leagueId] }); toast({ title: "Automatic payments ready", description: "Your exact quoted obligations are reserved for collection." }); }, onError: (error) => toast({ title: "Automatic payments unavailable", description: `${errorCode(error) ? `${errorCode(error)}: ` : ""}${error instanceof Error ? error.message : "Please use interactive payment."}`, variant: "destructive" }) });
  const revoke = useMutation({ mutationFn: () => { if (!ready.data) throw new Error("Ready plan evidence is unavailable."); return revokeF3CanonicalPlan({ leagueId, organizationId, authorizationId: ready.data.authorization.id }); }, onSuccess: () => { void queryClient.invalidateQueries({ queryKey: readyKey }); void queryClient.invalidateQueries({ queryKey: ["f3-prequote", leagueId] }); toast({ title: "Automatic payments cancelled", description: "The reserved capacity is available for a fresh setup." }); }, onError: (error) => toast({ title: "Automatic payments could not be cancelled", description: `${errorCode(error) ? `${errorCode(error)}: ` : ""}${error instanceof Error ? error.message : "Try again."}`, variant: "destructive" }) });

  if (ready.isLoading) return <div data-testid="f3-canonical-autopay-loading" />;
  if (ready.isError && readyCode === "F3_DISABLED") return null;
  if (ready.isSuccess && ready.data) {
    const data = ready.data;
    const payeeMap = exactPayeeMap(data.authorization.coveredBowlerIds, data.authorization.payees, data.items.map((item) => item.bowlerId));
    if (!payeeMap) return <Card data-testid="f3-canonical-autopay-error"><CardContent className="pt-6"><p role="alert" className="text-sm">PAYEE_EVIDENCE_INCONSISTENT: exact covered payee names are unavailable.</p></CardContent></Card>;
    return <Card data-testid="f3-canonical-autopay-ready"><CardHeader><CardTitle>Canonical automatic payments ready</CardTitle></CardHeader><CardContent className="space-y-3">
      <p className="text-sm">Authorization version {data.authorization.version}; exact reserved total ${(data.totalAmountMinor / 100).toFixed(2)}.</p>
      <div className="space-y-1 text-xs" data-testid="f3-ready-items">{data.items.map((item) => { const group = data.groups.find((candidate) => candidate.occurrenceId === item.occurrenceId); const label = group?.localDate ? `${group.localDate} ${group.localStartTime ?? ""} ${group.timezone ?? ""}` : `ordinal ${group?.ordinal ?? "—"}`; return <div key={`${item.obligationId}-${item.bowlerId}`}>{group?.groupRole === "trigger" ? "Double-pay trigger" : group?.groupRole === "paired" ? "Double-pay paired occurrence" : "Collection occurrence"}: {label} — Payee: {payeeMap.get(item.bowlerId)} — ${(item.amountMinor / 100).toFixed(2)}</div>; })}</div>
      <p className="break-all text-xs">Plan fingerprint: {data.aggregateFingerprint}</p><Button type="button" variant="outline" disabled={revoke.isPending} onClick={() => revoke.mutate()}>{revoke.isPending ? "Cancelling…" : "Cancel automatic plan"}</Button>
    </CardContent></Card>;
  }
  if (!setupRequired) {
    const code = readyCode ?? errorCode(prequote.error); if (code === "F3_DISABLED") return null;
    return <Card data-testid="f3-canonical-autopay-error"><CardContent className="pt-6"><p role="alert" className="text-sm">{code ? `${code}: ` : ""}{ready.error instanceof Error ? ready.error.message : "Canonical automatic-payment evidence is unavailable."}</p></CardContent></Card>;
  }
  if (prequote.isLoading) return <div data-testid="f3-canonical-autopay-loading" />;
  if (prequote.isError) { const code = errorCode(prequote.error); if (code === "F3_DISABLED") return null; return <Card data-testid="f3-canonical-autopay-error"><CardContent className="pt-6"><p role="alert" className="text-sm">{code ? `${code}: ` : ""}{prequote.error instanceof Error ? prequote.error.message : "Canonical automatic payments are unavailable."}</p></CardContent></Card>; }
  if (!prequote.data) return null;
  const data = prequote.data;
  const payeeMap = exactPayeeMap(data.authorization.coveredBowlerIds, data.authorization.payees, data.items.map((item) => item.bowlerId));
  if (!payeeMap) return <Card data-testid="f3-canonical-autopay-error"><CardContent className="pt-6"><p role="alert" className="text-sm">PAYEE_EVIDENCE_INCONSISTENT: exact covered payee names are unavailable.</p></CardContent></Card>;
  return <Card data-testid="f3-canonical-autopay-setup"><CardHeader><CardTitle>Canonical automatic payments</CardTitle></CardHeader><CardContent className="space-y-3">
    <p className="text-sm">Review {data.items.length} exact obligation(s), totaling ${(data.totalAmountMinor / 100).toFixed(2)} at the approved collection points.</p>
    {acceptedPartners.length > 0 && <fieldset><legend className="text-sm font-medium">Accepted partners to cover</legend>{acceptedPartners.map((partner) => <label className="block text-sm" key={partner.id}><input type="checkbox" aria-label={partner.name} checked={selectedPartners.includes(partner.id)} onChange={(event) => setSelectedPartners((ids) => event.target.checked ? [...ids, partner.id] : ids.filter((id) => id !== partner.id))} /> <span className="ml-2">{partner.name}</span></label>)}</fieldset>}
    <label className="block text-sm font-medium">Payment method<select aria-label="Payment method" className="mt-1 block w-full rounded border p-2" value={selectedCardId} onChange={(event) => setSelectedCardId(event.target.value)}><option value="">Select a saved card</option>{savedCards.map((card) => <option key={card.id} value={card.id}>{card.brand} •••• {card.last4}</option>)}</select></label>
    <div className="space-y-1 text-xs" data-testid="f3-quote-items">{data.items.map((item) => { const group = data.groups.find((candidate) => candidate.occurrenceId === item.occurrenceId); const label = group?.localDate ? `${group.localDate} ${group.localStartTime ?? ""} ${group.timezone ?? ""}` : `ordinal ${group?.ordinal ?? "—"}`; return <div key={`${item.obligationId}-${item.bowlerId}`}>{group?.groupRole === "trigger" ? "Double-pay trigger" : group?.groupRole === "paired" ? "Double-pay paired occurrence" : "Collection occurrence"}: {label} — Payee: {payeeMap.get(item.bowlerId)} — ${(item.amountMinor / 100).toFixed(2)}</div>; })}</div>
    {data.catchUpRequired ? <div><p role="alert" className="text-sm text-amber-700">IMMEDIATE_CATCHUP_REQUIRED: complete the interactive F2 payment first. This setup does not charge a provider.</p><Button type="button" variant="outline" onClick={() => onCatchUp ? onCatchUp() : (window.location.hash = "#interactive-occurrence-selector")}>Complete F2 catch-up</Button></div> : <Button type="button" disabled={!selectedCardId || authorize.isPending} onClick={() => authorize.mutate()}>{authorize.isPending ? "Authorizing…" : "Authorize exact plan"}</Button>}
  </CardContent></Card>;
}
