import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Link } from "wouter";
import { CheckCircle2, Pencil, Trash2 } from "lucide-react";
import type { Bowler, League, BowlerWithAccount } from "@shared/schema";
import type { TeamBowlerEntry } from "@/lib/bowler-league-utils";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface TeamViewBowlersTableProps {
  teamBowlers: TeamBowlerEntry<BowlerWithAccount>[];
  league: League | undefined;
  teamId: number;
  leagueId: number;
  canManage: boolean;
  onEditBowler?: (bowler: Bowler) => void;
  onRemoveBowler?: (target: { bowlerId: number; name: string }) => void;
}

type Slot = { id?: string; slotIndex: number; occupant: "main" | "vacant" | "unassigned"; mainBowlerId?: number | null };
type Occurrence = { id: string; startAt: string; status: "scheduled" | "completed" };
type RosterResponse = {
  payingLineupSize: number | null;
  ready: boolean;
  substituteAccess: "team_only" | "floating";
  substituteBowlerOptions: Array<{ id: number; name: string; teamId: number | null }>;
  occurrences: Occurrence[];
  teams: Array<{ id: number; slots: Slot[]; policy: "main_pays_full" | "sub_pays_full" | "special_split" }>;
};

function rosterFingerprint(lineupSize: number, policy: string, slots: Slot[]): Promise<string> {
  const canonical = JSON.stringify({
    lineupSize,
    policy,
    slots: [...slots].sort((left, right) => left.slotIndex - right.slotIndex)
      .map((slot) => ({ slotIndex: slot.slotIndex, occupant: slot.occupant, mainBowlerId: slot.mainBowlerId ?? null })),
  });
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)).then((digest) =>
    `lvroster:v1:${Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("")}`,
  );
}

export function TeamViewBowlersTable({ teamBowlers, league, teamId, leagueId, canManage, onEditBowler, onRemoveBowler }: TeamViewBowlersTableProps) {
  const { toast } = useToast();
  const rosterQuery = useQuery<{ data: RosterResponse }>({ queryKey: [`/api/financials/leagues/${leagueId}/roster-payment-responsibility/1`], enabled: canManage });
  const current = rosterQuery.data?.data?.teams.find((team) => team.id === teamId);
  const lineupSize = rosterQuery.data?.data?.payingLineupSize ?? league?.payingLineupSize ?? 0;
  const [slots, setSlots] = useState<Slot[]>([]);
  const [policy, setPolicy] = useState<"main_pays_full" | "sub_pays_full" | "special_split">("main_pays_full");
  const [substitutes, setSubstitutes] = useState<Record<number, { occurrenceId: string; bowlerId: number }>>({});
  useEffect(() => {
    if (!current) return;
    setSlots(current.slots.map((slot) => ({ ...slot })));
    setPolicy(current.policy);
  }, [current]);
  const normalizedSlots = useMemo(() => Array.from({ length: lineupSize }, (_, slotIndex) => slots.find((slot) => slot.slotIndex === slotIndex) ?? { slotIndex, occupant: "unassigned" as const, mainBowlerId: null }), [lineupSize, slots]);

  const save = useMutation({
    mutationFn: async () => apiRequest(`/api/financials/leagues/${leagueId}/roster-payment-responsibility/1/teams/${teamId}`, "POST", {
      commandKey: crypto.randomUUID(), requestFingerprint: await rosterFingerprint(lineupSize, policy, normalizedSlots), lineupSize, policy, slots: normalizedSlots,
    }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/roster-payment-responsibility/1`] }); toast({ title: "Team roster saved" }); },
    onError: (error: Error) => toast({ title: "Team roster could not be saved", description: error.message, variant: "destructive" }),
  });

  const assignSubstitute = useMutation({
    mutationFn: async ({ slotIndex, occurrenceId, bowlerId }: { slotIndex: number; occurrenceId: string; bowlerId: number }) => {
      const slot = normalizedSlots.find((row) => row.slotIndex === slotIndex);
      const occurrence = rosterQuery.data?.data?.occurrences.find((row) => row.id === occurrenceId);
      if (!slot || !occurrence) throw new Error("Select a published occurrence and stable slot.");
      const responsibility = { occurrenceId, teamId, slotIndex, positionIndex: slotIndex, kind: "substitute" as const, mainBowlerId: slot.mainBowlerId ?? null, substituteBowlerId: bowlerId, payerBowlerId: policy === "main_pays_full" ? slot.mainBowlerId ?? null : bowlerId, policy: slot.occupant === "vacant" ? "sub_pays_full" as const : policy };
      const canonical = JSON.stringify([responsibility].sort((left, right) => left.occurrenceId.localeCompare(right.occurrenceId) || left.teamId - right.teamId || left.positionIndex - right.positionIndex));
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
      const requestFingerprint = `lvresponsibility:v1:${Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("")}`;
      return apiRequest(`/api/financials/leagues/${leagueId}/roster-payment-responsibility/1/occurrences`, "POST", { commandKey: crypto.randomUUID(), requestFingerprint, responsibilities: [{ ...responsibility, amountMinor: 0, dueAt: occurrence.startAt, pastDueAt: new Date(new Date(occurrence.startAt).getTime() + 3 * 60 * 60 * 1000).toISOString() }] });
    },
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/canonical-due-past-due/2`] }); void queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/roster-payment-responsibility/1`] }); toast({ title: "Substitute assignment saved" }); },
    onError: (error: Error) => toast({ title: "Substitute assignment could not be saved", description: error.message, variant: "destructive" }),
  });

  const memberById = new Map(teamBowlers.map(({ bowler }) => [bowler.id, bowler]));
  const mainIds = new Set(normalizedSlots.flatMap((slot) => slot.mainBowlerId ? [slot.mainBowlerId] : []));
  const substituteOptions = rosterQuery.data?.data?.substituteAccess === "floating"
    ? rosterQuery.data.data.substituteBowlerOptions
    : teamBowlers.map(({ bowler }) => ({ id: bowler.id, name: bowler.name, teamId: teamId }));
  const occurrenceLabel = (startAt: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: league?.timezone ?? "UTC" }).format(new Date(startAt));
  const updateSlot = (slotIndex: number, value: Partial<Slot>) => setSlots((rows) => rows.map((row) => row.slotIndex === slotIndex ? { ...row, ...value } : row));

  return <div className="rounded-md border"><Table><TableHeader><TableRow><TableHead>Position</TableHead><TableHead>Name</TableHead><TableHead>Payer role</TableHead><TableHead>Weekly Fee</TableHead><TableHead>Status</TableHead><TableHead>Actions</TableHead></TableRow></TableHeader><TableBody>
    {normalizedSlots.map((slot) => {
      const main = slot.mainBowlerId ? memberById.get(slot.mainBowlerId) : undefined;
      const selection = substitutes[slot.slotIndex];
      return <TableRow key={`payment-slot-${slot.slotIndex}`}>
        <TableCell className="font-medium">{slot.slotIndex + 1}</TableCell>
        <TableCell>{main ? <Link href={`/bowlers/${main.id}?from=team&fromTeamId=${teamId}`} className="hover:underline">{main.name}</Link> : slot.occupant === "vacant" ? <span className="text-muted-foreground">VACANT</span> : <span className="text-muted-foreground">Unassigned</span>}</TableCell>
        <TableCell><div className="space-y-2"><select aria-label={`Payer role position ${slot.slotIndex + 1}`} disabled={!canManage} className="w-full rounded border bg-background p-2" value={slot.occupant} onChange={(event) => updateSlot(slot.slotIndex, { occupant: event.target.value as Slot["occupant"], mainBowlerId: event.target.value === "main" ? slot.mainBowlerId ?? teamBowlers[0]?.bowler.id ?? null : null })}><option value="unassigned">Unassigned</option><option value="main">Main</option><option value="vacant">VACANT</option></select>{slot.occupant === "main" && <select aria-label={`Main bowler position ${slot.slotIndex + 1}`} disabled={!canManage} className="w-full rounded border bg-background p-2 text-sm" value={slot.mainBowlerId ?? ""} onChange={(event) => updateSlot(slot.slotIndex, { mainBowlerId: Number(event.target.value) })}><option value="">Select Main</option>{teamBowlers.map(({ bowler }) => <option key={bowler.id} value={bowler.id}>{bowler.name}</option>)}</select>}{canManage && <div className="space-y-1 border-t pt-2"><span className="text-xs text-muted-foreground">Substitute for occurrence</span><select aria-label={`Substitute occurrence position ${slot.slotIndex + 1}`} className="w-full rounded border bg-background p-1 text-sm" value={selection?.occurrenceId ?? ""} onChange={(event) => setSubstitutes((rows) => ({ ...rows, [slot.slotIndex]: { occurrenceId: event.target.value, bowlerId: rows[slot.slotIndex]?.bowlerId ?? substituteOptions.find((bowler) => bowler.id !== slot.mainBowlerId)?.id ?? 0 } }))}><option value="">Select occurrence</option>{rosterQuery.data?.data?.occurrences.map((occurrence) => <option key={occurrence.id} value={occurrence.id}>{occurrenceLabel(occurrence.startAt)}</option>)}</select><select aria-label={`Substitute bowler position ${slot.slotIndex + 1}`} className="w-full rounded border bg-background p-1 text-sm" value={selection?.bowlerId ?? ""} onChange={(event) => setSubstitutes((rows) => ({ ...rows, [slot.slotIndex]: { occurrenceId: rows[slot.slotIndex]?.occurrenceId ?? "", bowlerId: Number(event.target.value) } }))}><option value="">Select Substitute</option>{substituteOptions.filter((bowler) => bowler.id !== slot.mainBowlerId).map((bowler) => <option key={bowler.id} value={bowler.id}>{bowler.name}</option>)}</select><Button variant="outline" size="sm" disabled={assignSubstitute.isPending || !selection?.occurrenceId || !selection?.bowlerId} onClick={() => selection && assignSubstitute.mutate({ slotIndex: slot.slotIndex, ...selection })}>Assign Substitute</Button></div>}</div></TableCell>
        <TableCell>${((league?.weeklyFee || 0) / 100).toFixed(2)}</TableCell><TableCell><Badge variant={slot.occupant === "unassigned" ? "secondary" : "default"}>{slot.occupant === "unassigned" ? "Incomplete" : slot.occupant === "vacant" ? "No obligation" : "Active payer"}</Badge></TableCell><TableCell>{main && <div className="flex items-center gap-2">{onEditBowler && <Button variant="outline" size="sm" onClick={() => onEditBowler(main)}><Pencil className="size-4 mr-2" />Edit</Button>}{onRemoveBowler && <Button variant="ghost" size="sm" onClick={() => onRemoveBowler({ bowlerId: main.id, name: main.name })}><Trash2 className="size-4" /></Button>}</div>}</TableCell>
      </TableRow>;
    })}
    {teamBowlers.filter(({ bowler }) => !mainIds.has(bowler.id)).map(({ bowler, bowlerLeague }) => <TableRow key={`member-${bowlerLeague.id}`}><TableCell className="text-muted-foreground">—</TableCell><TableCell><div className="flex items-center gap-1.5"><CheckCircle2 className={`size-4 ${bowler.hasAccount ? "text-green-500" : "text-muted-foreground/40"}`} /><Link href={`/bowlers/${bowler.id}?from=team&fromTeamId=${teamId}`} className="hover:underline">{bowler.name}</Link></div></TableCell><TableCell><Badge variant="outline">Substitute</Badge></TableCell><TableCell>${((league?.weeklyFee || 0) / 100).toFixed(2)}</TableCell><TableCell><Badge variant={bowlerLeague.active ? "default" : "secondary"}>{bowlerLeague.active ? "Active" : "Inactive"}</Badge></TableCell><TableCell><div className="flex items-center gap-2">{onEditBowler && <Button variant="outline" size="sm" onClick={() => onEditBowler(bowler)}><Pencil className="size-4 mr-2" />Edit</Button>}{onRemoveBowler && <Button variant="ghost" size="sm" onClick={() => onRemoveBowler({ bowlerId: bowler.id, name: bowler.name })}><Trash2 className="size-4" /></Button>}</div></TableCell></TableRow>)}
    {canManage && lineupSize > 0 && <TableRow><TableCell colSpan={6}><div className="flex flex-wrap items-center gap-3"><label className="text-sm">Team policy <select aria-label="Team payment policy" className="ml-2 rounded border bg-background p-2" value={policy} onChange={(event) => setPolicy(event.target.value as typeof policy)}><option value="main_pays_full">Main pays full</option><option value="sub_pays_full">Substitute pays full</option><option value="special_split">Substitute lineage / Main prize split</option></select></label><Badge variant={normalizedSlots.every((slot) => slot.occupant !== "unassigned") ? "default" : "secondary"}>{normalizedSlots.every((slot) => slot.occupant !== "unassigned") ? "Ready" : "Incomplete"}</Badge><Button disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save roster"}</Button></div></TableCell></TableRow>}
  </TableBody></Table></div>;
}
