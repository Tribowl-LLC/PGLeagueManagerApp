import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import type { SavedCard } from "@shared/schema";
import { authorizeF3CanonicalPlan, fetchF3CanonicalQuote } from "@/lib/f3-autopay";

interface F3CanonicalAutopaySetupProps {
  leagueId: number;
  organizationId: number;
  bowlerId: number;
  savedCards: SavedCard[];
}

/** The separately gated canonical setup surface. It only authorizes a plan
 * from the server-owned quote; immediate catch-up stays in the existing F2
 * interactive flow and this component never executes a provider charge. */
export function F3CanonicalAutopaySetup({ leagueId, organizationId, bowlerId, savedCards }: F3CanonicalAutopaySetupProps) {
  const { toast } = useToast();
  const quote = useQuery({
    queryKey: ["/api/financials/f3/quote", leagueId, bowlerId, organizationId],
    queryFn: () => fetchF3CanonicalQuote(leagueId, bowlerId, organizationId),
    retry: false,
  });
  const authorize = async () => {
    if (!quote.data || !savedCards[0]) return;
    try {
      await authorizeF3CanonicalPlan({
        leagueId, organizationId, payerBowlerId: bowlerId,
        policyId: quote.data.policy.id, policyVersion: quote.data.policy.version,
        authorizationVersion: quote.data.authorization.version + 1,
        coveredBowlerIds: quote.data.authorization.coveredBowlerIds,
        collectionPointOccurrenceIds: quote.data.authorization.collectionPointOccurrenceIds,
        sourceId: savedCards[0].id,
      });
      toast({ title: "Automatic payments ready", description: "Your exact quoted obligations are reserved for collection." });
    } catch (error) {
      toast({ title: "Automatic payments unavailable", description: error instanceof Error ? error.message : "Please use the interactive payment flow.", variant: "destructive" });
    }
  };
  if (quote.isLoading) return null;
  if (quote.isError || !quote.data) return null;
  return (
    <Card data-testid="f3-canonical-autopay-setup">
      <CardHeader><CardTitle>Canonical automatic payments</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm">The administrator-approved plan covers {quote.data.items.length} exact obligation(s), totaling ${(quote.data.totalAmountMinor / 100).toFixed(2)}.</p>
        <p className="text-xs text-muted-foreground">Future collection is handled by the approved payment plan. Any immediate catch-up uses interactive payment.</p>
        <Button type="button" disabled={savedCards.length === 0} onClick={authorize}>{savedCards.length === 0 ? "Add a saved card first" : "Authorize exact plan"}</Button>
      </CardContent>
    </Card>
  );
}
