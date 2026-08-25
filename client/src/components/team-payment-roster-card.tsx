import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Bowler } from "@shared/schema";

type Slot = { slotIndex: number; occupant: "main" | "vacant" | "unassigned"; mainBowlerId?: number | null };
type RosterResponse = { contractVersion: string; payingLineupSize: number | null; ready: boolean; substituteAccess: string; substitutePaymentRegime: string; teams: Array<{ id: number; slots: Slot[]; policy: string }> };
type DueResponse = { rows: Array<{ id: string; occurrenceId: string; payerBowlerId: number; amountMinor: number }> };

export function TeamPaymentRosterCard({ teamId, leagueId, bowlers, canManage }: { teamId: number; leagueId: number; bowlers: Bowler[]; canManage: boolean }) {
  const { toast } = useToast();
  const rosterQuery = useQuery<{ data: RosterResponse }>({ queryKey: [`/api/financials/leagues/${leagueId}/roster-payment-responsibility/1`] });
  const dueQuery = useQuery<{ data: DueResponse }>({ queryKey: [`/api/financials/leagues/${leagueId}/canonical-due-past-due/2`] });
  const current = rosterQuery.data?.data?.teams.find((team) => team.id === teamId);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [policy, setPolicy] = useState("main_pays_full");
  useEffect(() => {
    if (!current) return;
    setSlots(current.slots.map((slot) => ({ ...slot })));
    setPolicy(current.policy);
  }, [current]);
  const lineupSize = rosterQuery.data?.data?.payingLineupSize ?? 0;
  const normalizedSlots = useMemo(() => Array.from({ length: lineupSize }, (_, index) => slots.find((slot) => slot.slotIndex === index) ?? { slotIndex: index, occupant: "unassigned" as const, mainBowlerId: null }), [lineupSize, slots]);
  const save = useMutation({
    mutationFn: () => apiRequest(`/api/financials/leagues/${leagueId}/roster-payment-responsibility/1/teams/${teamId}`, "POST", {
      commandKey: crypto.randomUUID(), requestFingerprint: crypto.randomUUID(), lineupSize, policy, slots: normalizedSlots,
    }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/roster-payment-responsibility/1`] }); toast({ title: "Payment roster saved" }); },
    onError: (error: Error) => toast({ title: "Payment roster could not be saved", description: error.message, variant: "destructive" }),
  });
  if (rosterQuery.isLoading) return <Card><CardContent className="pt-6 text-sm text-muted-foreground">Loading payment roster…</CardContent></Card>;
  if (rosterQuery.error || !current) return <Card><CardContent className="pt-6 text-sm text-muted-foreground">Payment roster is unavailable until the league has a configured lineup.</CardContent></Card>;
  return <Card className="mt-6">
    <CardHeader>
      <div className="flex items-center justify-between gap-3"><CardTitle>Payment responsibility roster</CardTitle><Badge variant={normalizedSlots.every((slot) => slot.occupant !== "unassigned") ? "default" : "secondary"}>{normalizedSlots.every((slot) => slot.occupant !== "unassigned") ? "Ready" : "Incomplete"}</Badge></div>
      <CardDescription>Main/Substitute payment controls. VACANT never creates an obligation. Substitute access: {rosterQuery.data?.data?.substituteAccess}; regime: {rosterQuery.data?.data?.substitutePaymentRegime}.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {normalizedSlots.map((slot) => <div key={slot.slotIndex} className="rounded border p-3 space-y-2">
          <div className="font-medium">Position {slot.slotIndex + 1}</div>
          <select disabled={!canManage} className="w-full rounded border bg-background p-2" value={slot.occupant} onChange={(event) => setSlots((rows) => rows.map((row) => row.slotIndex === slot.slotIndex ? { ...row, occupant: event.target.value as Slot["occupant"], mainBowlerId: event.target.value === "main" ? row.mainBowlerId ?? bowlers[0]?.id ?? null : null } : row))}>
            <option value="unassigned">Unassigned</option><option value="main">Main</option><option value="vacant">VACANT</option>
          </select>
          {slot.occupant === "main" && <select disabled={!canManage} className="w-full rounded border bg-background p-2" value={slot.mainBowlerId ?? ""} onChange={(event) => setSlots((rows) => rows.map((row) => row.slotIndex === slot.slotIndex ? { ...row, mainBowlerId: Number(event.target.value) } : row))}>
            <option value="">Select Main</option>{bowlers.map((bowler) => <option key={bowler.id} value={bowler.id}>{bowler.name}</option>)}
          </select>}
        </div>)}
      </div>
      <label className="block text-sm">Team payment policy<select disabled={!canManage} className="mt-1 w-full rounded border bg-background p-2" value={policy} onChange={(event) => setPolicy(event.target.value)}><option value="main_pays_full">Main pays full</option><option value="sub_pays_full">Substitute pays full</option><option value="special_split">Substitute lineage / Main prize split</option></select></label>
      {canManage && <Button disabled={save.isPending || lineupSize === 0} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save payment roster"}</Button>}
      <p className="text-sm text-muted-foreground">Open exact obligations: {dueQuery.data?.data?.rows?.length ?? 0}. Weekly substitute assignment is recorded against a published occurrence and never changes scores.</p>
    </CardContent>
  </Card>;
}
