/* eslint-disable shadcn/no-unknown-classes, shadcn/no-restyle */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Loader2, CreditCard, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { queryClient, csrfFetch } from "@/lib/queryClient";
import {
  isProviderNotConfiguredError,
  providerNotConfiguredToast,
  makeApiError,
} from "@/lib/provider-not-configured";
import type { SavedCard } from "@shared/schema";

interface SavedPaymentMethodsCardProps {
  bowlerId: number;
  /** Owning location used to deep-link the PROVIDER_NOT_CONFIGURED toast. */
  locationId?: number | null;
  /** Render the Familiar A profile row and open the saved-card view in a dialog. */
  triggerOnly?: boolean;
}

export function SavedPaymentMethodsCard({ bowlerId, locationId, triggerOnly = false }: SavedPaymentMethodsCardProps) {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [cardToDelete, setCardToDelete] = useState<SavedCard | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const { data: savedCardsResponse, isLoading } = useQuery<{ success: boolean; data: SavedCard[] }>({
    queryKey: [`/api/payments-provider/cards/${bowlerId}`],
    queryFn: async () => {
      const res = await csrfFetch(`/api/payments-provider/cards/${bowlerId}`);
      if (!res.ok) throw new Error("Failed to load saved cards");
      return res.json();
    },
    retry: false,
  });
  const savedCards = savedCardsResponse?.data || [];
  const cardSummary = isLoading
    ? "Loading saved cards…"
    : savedCards.length === 0
      ? "No saved cards on file."
      : savedCards.length === 1
        ? "One saved card on file."
        : `${savedCards.length} saved cards on file.`;

  const handleDelete = async (card: SavedCard) => {
    setIsDeleting(true);
    try {
      const res = await csrfFetch(`/api/payments-provider/cards/${bowlerId}/${card.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw makeApiError(data, res.status, "Failed to remove card");
      }
      toast({ title: "Card Removed", description: `Your ${card.brand} card ending in ${card.last4} has been removed.` });
      queryClient.invalidateQueries({ queryKey: [`/api/payments-provider/cards/${bowlerId}`] });
    } catch (err) {
      if (isProviderNotConfiguredError(err)) {
        toast(
          providerNotConfiguredToast({
            navigate,
            locationId: locationId ?? null,
          }),
        );
      } else {
        const message = err instanceof Error ? err.message : "Failed to remove card";
        toast({ title: "Error", description: message, variant: "destructive" });
      }
    } finally {
      setIsDeleting(false);
      setCardToDelete(null);
    }
  };

  const cardContent = isLoading ? (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      Loading saved cards…
    </div>
  ) : savedCards.length === 0 ? (
    <p className="text-sm text-muted-foreground">No saved cards on file. Cards saved during payment will appear here.</p>
  ) : (
    <div className="space-y-3">
      {savedCards.map((card) => (
        <div key={card.id} className="familiar-payment-method-row flex items-center justify-between rounded-lg border p-3">
          <div className="flex items-center gap-3 min-w-0">
            <CreditCard className="size-5 text-muted-foreground shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-medium">{card.brand} ending in {card.last4}</p>
              <p className="text-xs text-muted-foreground">
                Expires {String(card.expMonth).padStart(2, "0")}/{card.expYear}
              </p>
            </div>
          </div>
          <Button
            variant="destructiveGhost"
            size="sm"
            onClick={() => setCardToDelete(card)}
            disabled={isDeleting}
          >
            <Trash2 className="size-4 mr-1" />
            Remove
          </Button>
        </div>
      ))}
    </div>
  );

  return (
    <>
      {triggerOnly ? (
        <section className="familiar-profile-setting-row" data-testid="profile-setting-payment-methods">
          <div className="familiar-profile-setting-copy">
            <h2>Saved payment methods</h2>
            <p>{cardSummary}</p>
          </div>
          <Button variant="outline" className="familiar-profile-row-action" onClick={() => setIsDialogOpen(true)}>
            {savedCards.length > 0 ? "View card" : "View methods"}
          </Button>
        </section>
      ) : (
        <Card>
          <CardHeader padding="standard">
            <CardTitle iconSpacing>
              <CreditCard className="size-5" />
              Saved Payment Methods
            </CardTitle>
            <CardDescription className="mt-1.5">Manage your saved credit cards</CardDescription>
          </CardHeader>
          <CardContent>{cardContent}</CardContent>
        </Card>
      )}

      {triggerOnly && (
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogContent className="familiar-profile-dialog familiar-payment-method-dialog" viewport="dialog">
            <DialogHeader>
              <DialogTitle>Saved payment methods</DialogTitle>
              <DialogDescription>Manage cards saved to your payment profile.</DialogDescription>
            </DialogHeader>
            {cardContent}
            <Button type="button" onClick={() => setIsDialogOpen(false)}>Done</Button>
          </DialogContent>
        </Dialog>
      )}

      <AlertDialog open={!!cardToDelete} onOpenChange={(open) => { if (!open && !isDeleting) setCardToDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove saved card?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove your {cardToDelete?.brand} card ending in {cardToDelete?.last4} from your account. You can always add a new card later during payment.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isDeleting}
              variant="destructive"
              onClick={() => { if (cardToDelete) handleDelete(cardToDelete); }}
            >
              {isDeleting ? (
                <><Loader2 className="size-4 animate-spin mr-2" /> Removing…</>
              ) : "Remove Card"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
