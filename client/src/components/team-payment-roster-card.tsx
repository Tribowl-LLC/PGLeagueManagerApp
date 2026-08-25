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
type DueResponse = { rows: Array<{ id: string; occurrenceId: string; payerBowlerId: number; amountMinor: number; dueAt: string; pastDueAt: string }> };

export function TeamPaymentRosterCard({ teamId, leagueId, bowlers, canManage }: { teamId: number; leagueId: number; bowlers: Bowler[]; canManage: boolean }) {
  const { toast } = useToast();
  const rosterQuery = useQuery<{ data: RosterResponse }>({ queryKey: [`/api/financials/leagues/${leagueId}/roster-payment-responsibility/1`] });
  const dueQuery = useQuery<{ data: DueResponse }>({ queryKey: [`/api/financials/leagues/${leagueId}/canonical-due-past-due/2`] });
  const current = rosterQuery.data?.data?.teams.find((team) => team.id === teamId);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [policy, setPolicy] = useState("main_pays_full");
  const [substitutes, setSubstitutes] = useState<Record<number, { occurrenceId: string; bowlerId: number }>>({});
  useEffect(() => {
    if (!current) return;
    setSlots(current.slots.map((slot) => ({ ...slot })));
    setPolicy(current.policy);
  }, [current]);
  const lineupSize = rosterQuery.data?.data?.payingLineupSize ?? 0;
  const normalizedSlots = useMemo(() => Array.from({ length: lineupSize }, (_, index) => slots.find((slot) => slot.slotIndex === index) ?? { slotIndex: index, occupant: "unassigned" as const, mainBowlerId: null }), [lineupSize, slots]);
  const rosterFingerprint = async (): Promise<string> => {
    const payload = JSON.stringify({
      lineupSize,
      policy,
      slots: [...normalizedSlots]
        .sort((left, right) => left.slotIndex - right.slotIndex)
        .map((slot) => ({ slotIndex: slot.slotIndex, occupant: slot.occupant, mainBowlerId: slot.mainBowlerId ?? null })),
    });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
    return `lvroster:v1:${Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("")}`;
  };
  const save = useMutation({
    mutationFn: async () => apiRequest(`/api/financials/leagues/${leagueId}/roster-payment-responsibility/1/teams/${teamId}`, "POST", {
      commandKey: crypto.randomUUID(), requestFingerprint: await rosterFingerprint(), lineupSize, policy, slots: normalizedSlots,
    }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/roster-payment-responsibility/1`] }); toast({ title: "Payment roster saved" }); },
    onError: (error: Error) => toast({ title: "Payment roster could not be saved", description: error.message, variant: "destructive" }),
  });
  const assignSubstitute = useMutation({
    mutationFn: async ({ slotIndex, occurrenceId, bowlerId }: { slotIndex: number; occurrenceId: string; bowlerId: number }) => {
      const slot = normalizedSlots.find((row) => row.slotIndex === slotIndex);
      const occurrence = dueQuery.data?.data?.rows.find((row) => row.occurrenceId === occurrenceId);
      if (!slot || !occurrence) throw new Error("Select a published occurrence and stable slot.");
      const responsibility = { occurrenceId, teamId, slotIndex, positionIndex: slotIndex, kind: "substitute" as const, mainBowlerId: slot.mainBowlerId ?? null, substituteBowlerId: bowlerId, payerBowlerId: policy === "main_pays_full" ? slot.mainBowlerId : bowlerId, policy };
      const canonical = JSON.stringify([responsibility].map((row) => ({ ...row })).sort((left, right) => left.occurrenceId.localeCompare(right.occurrenceId) || left.teamId - right.teamId || left.positionIndex - right.positionIndex));
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
      const requestFingerprint = `lvresponsibility:v1:${Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("")}`;
      return apiRequest(`/api/financials/leagues/${leagueId}/roster-payment-responsibility/1/occurrences`, "POST", {
        commandKey: crypto.randomUUID(),
        requestFingerprint,
        responsibilities: [{ ...responsibility, amountMinor: 0, dueAt: occurrence.dueAt, pastDueAt: occurrence.pastDueAt }],
      });
    },
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/canonical-due-past-due/2`] }); toast({ title: "Substitute assignment saved" }); },
    onError: (error: Error) => toast({ title: "Substitute assignment could not be saved", description: error.message, variant: "destructive" }),
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
          {canManage && <div className="space-y-2 rounded border-t pt-2"><div className="text-xs font-medium">Weekly Substitute</div><select className="w-full rounded border bg-background p-2 text-sm" value={substitutes[slot.slotIndex]?.occurrenceId ?? ""} onChange={(event) => setSubstitutes((rows) => ({ ...rows, [slot.slotIndex]: { occurrenceId: event.target.value, bowlerId: rows[slot.slotIndex]?.bowlerId ?? bowlers[0]?.id ?? 0 } }))}><option value="">Select occurrence</option>{dueQuery.data?.data?.rows.filter((row) => row.payerBowlerId === slot.mainBowlerId || slot.occupant === "vacant").map((row) => <option key={`${slot.slotIndex}:${row.occurrenceId}`} value={row.occurrenceId}>{new Date(row.dueAt).toLocaleDateString()}</option>)}</select><select className="w-full rounded border bg-background p-2 text-sm" value={substitutes[slot.slotIndex]?.bowlerId ?? ""} onChange={(event) => setSubstitutes((rows) => ({ ...rows, [slot.slotIndex]: { occurrenceId: rows[slot.slotIndex]?.occurrenceId ?? "", bowlerId: Number(event.target.value) } }))}><option value="">Select Substitute</option>{bowlers.filter((bowler) => bowler.id !== slot.mainBowlerId).map((bowler) => <option key={bowler.id} value={bowler.id}>{bowler.name}</option>)}</select><Button variant="outline" size="sm" disabled={assignSubstitute.isPending || !substitutes[slot.slotIndex]?.occurrenceId || !substitutes[slot.slotIndex]?.bowlerId} onClick={() => assignSubstitute.mutate({ slotIndex: slot.slotIndex, ...substitutes[slot.slotIndex] })}>{assignSubstitute.isPending ? "Saving…" : "Assign substitute"}</Button></div>}
        </div>)}
      </div>
      <label className="block text-sm">Team payment policy<select disabled={!canManage} className="mt-1 w-full rounded border bg-background p-2" value={policy} onChange={(event) => setPolicy(event.target.value)}><option value="main_pays_full">Main pays full</option><option value="sub_pays_full">Substitute pays full</option><option value="special_split">Substitute lineage / Main prize split</option></select></label>
      {canManage && <Button disabled={save.isPending || lineupSize === 0} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save payment roster"}</Button>}
      <p className="text-sm text-muted-foreground">Open exact obligations: {dueQuery.data?.data?.rows?.length ?? 0}. Weekly substitute assignment is recorded against a published occurrence and never changes scores.</p>
    </CardContent>
  </Card>;
}
