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

type Slot = { slotIndex: number; occupant: "main" | "vacant" | "unassigned"; mainBowlerId?: number | null };
type Occurrence = { id: string; startAt: string; status: "scheduled" | "completed" };
type OccurrenceResponsibility = {
  occurrenceId: string;
  teamId: number;
  slotIndex: number;
  positionIndex: number;
  responsibilityKind: "main" | "substitute" | "split" | "vacant";
  mainBowlerId: number | null;
  substituteBowlerId: number | null;
  payerBowlerId: number | null;
  policy: "main_pays_full" | "sub_pays_full" | "special_split";
  amountMinor: number;
  lineageAmountMinor: number | null;
  prizeFundAmountMinor: number | null;
};
type OverrideKind = "main" | "substitute" | "split" | "vacant";
type OverridePolicy = "main_pays_full" | "sub_pays_full" | "special_split";
type RosterResponse = {
  payingLineupSize: number | null;
  ready: boolean;
  lineageFee: number | null;
  prizeFundFee: number | null;
  substituteAccess: "team_only" | "floating";
  substitutePaymentRegime: "team_choice" | "league_lineage_prize_split";
  substituteBowlerOptions: Array<{ id: number; name: string; teamId: number | null }>;
  occurrences: Occurrence[];
  occurrenceResponsibilities: OccurrenceResponsibility[];
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
  const [substitutes, setSubstitutes] = useState<Record<string, { occurrenceId: string; slotIndex: number; kind: OverrideKind; policy: OverridePolicy; bowlerId: number | null }>>({});
  const [selectedOccurrenceId, setSelectedOccurrenceId] = useState("");
  useEffect(() => {
    if (!current) return;
    setSlots(current.slots.map((slot) => ({
      slotIndex: slot.slotIndex,
      occupant: slot.occupant,
      mainBowlerId: slot.mainBowlerId ?? null,
    })));
    setPolicy(current.policy);
    const hydrated: Record<string, { occurrenceId: string; slotIndex: number; kind: OverrideKind; policy: OverridePolicy; bowlerId: number | null }> = {};
    for (const responsibility of rosterQuery.data?.data?.occurrenceResponsibilities ?? []) {
      if (responsibility.teamId !== teamId || responsibility.responsibilityKind === "main") continue;
      hydrated[`${responsibility.occurrenceId}:${responsibility.slotIndex}`] = { occurrenceId: responsibility.occurrenceId, slotIndex: responsibility.slotIndex, kind: responsibility.responsibilityKind, policy: responsibility.policy, bowlerId: responsibility.substituteBowlerId };
    }
    setSubstitutes(hydrated);
  }, [current, rosterQuery.data?.data?.occurrenceResponsibilities, teamId]);
  useEffect(() => {
    const first = rosterQuery.data?.data?.occurrences[0]?.id;
    if (first && !rosterQuery.data?.data?.occurrences.some((occurrence) => occurrence.id === selectedOccurrenceId)) setSelectedOccurrenceId(first);
  }, [rosterQuery.data?.data?.occurrences, selectedOccurrenceId]);
  const normalizedSlots = useMemo(() => Array.from({ length: lineupSize }, (_, slotIndex) => slots.find((slot) => slot.slotIndex === slotIndex) ?? { slotIndex, occupant: "unassigned" as const, mainBowlerId: null }), [lineupSize, slots]);

  const save = useMutation({
    mutationFn: async () => {
      const requestSlots = normalizedSlots.map((slot) => ({
        slotIndex: slot.slotIndex,
        occupant: slot.occupant,
        mainBowlerId: slot.mainBowlerId ?? null,
      }));
      return apiRequest(`/api/financials/leagues/${leagueId}/roster-payment-responsibility/1/teams/${teamId}`, "POST", {
        commandKey: crypto.randomUUID(), requestFingerprint: await rosterFingerprint(lineupSize, policy, requestSlots), lineupSize, policy, slots: requestSlots,
      });
    },
    onSuccess: () => {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/roster-payment-responsibility/1`] }),
        queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/canonical-due-past-due/2`] }),
        queryClient.invalidateQueries({ predicate: ({ queryKey }) => typeof queryKey[0] === "string" && queryKey[0].startsWith("/api/financials/due-past-due") }),
      ]);
      toast({ title: "Team roster saved" });
    },
    onError: (error: Error) => toast({ title: "Team roster could not be saved", description: error.message, variant: "destructive" }),
  });

  const assignSubstitute = useMutation({
    mutationFn: async ({ slotIndex, occurrenceId, kind = "substitute", overridePolicy, bowlerId }: { slotIndex: number; occurrenceId: string; kind?: OverrideKind; overridePolicy?: OverridePolicy; bowlerId: number | null }) => {
      const slot = normalizedSlots.find((row) => row.slotIndex === slotIndex);
      const occurrence = rosterQuery.data?.data?.occurrences.find((row) => row.id === occurrenceId);
      if (!slot || !occurrence) throw new Error("Select a published occurrence and stable slot.");
      const split = kind === "split";
      const main = kind === "main";
      const vacant = kind === "vacant";
      const effectivePolicy = overridePolicy ?? policy;
      const responsibility = { occurrenceId, teamId, slotIndex, positionIndex: slotIndex, kind, mainBowlerId: vacant ? null : slot.mainBowlerId ?? null, substituteBowlerId: vacant || main ? null : bowlerId, payerBowlerId: vacant ? null : main ? slot.mainBowlerId ?? null : split || effectivePolicy !== "main_pays_full" || slot.occupant === "vacant" ? bowlerId : slot.mainBowlerId ?? null, policy: vacant ? "main_pays_full" as const : split ? "special_split" as const : slot.occupant === "vacant" ? "sub_pays_full" as const : effectivePolicy, amountMinor: vacant ? 0 : league?.weeklyFee ?? 0, lineageAmountMinor: split ? rosterQuery.data?.data?.lineageFee ?? null : null, prizeFundAmountMinor: split ? rosterQuery.data?.data?.prizeFundFee ?? null : null };
      const canonical = JSON.stringify([responsibility].sort((left, right) => left.occurrenceId.localeCompare(right.occurrenceId) || left.teamId - right.teamId || left.positionIndex - right.positionIndex));
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
      const requestFingerprint = `lvresponsibility:v1:${Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("")}`;
      return apiRequest(`/api/financials/leagues/${leagueId}/roster-payment-responsibility/1/occurrences`, "POST", { commandKey: crypto.randomUUID(), requestFingerprint, responsibilities: [{ ...responsibility, dueAt: occurrence.startAt, pastDueAt: new Date(new Date(occurrence.startAt).getTime() + 3 * 60 * 60 * 1000).toISOString() }] });
    },
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/canonical-due-past-due/2`] }); void queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/roster-payment-responsibility/1`] }); toast({ title: "Substitute assignment saved" }); },
    onError: (error: Error) => toast({ title: "Substitute assignment could not be saved", description: error.message, variant: "destructive" }),
  });

  const memberById = new Map(teamBowlers.map(({ bowler }) => [bowler.id, bowler]));
  const mainIds = new Set(normalizedSlots.flatMap((slot) => slot.mainBowlerId ? [slot.mainBowlerId] : []));
  const substituteOptions = rosterQuery.data?.data?.substituteAccess === "floating"
    ? rosterQuery.data.data.substituteBowlerOptions.filter((bowler) => memberById.get(bowler.id)?.active !== false)
    : teamBowlers.filter(({ bowler, bowlerLeague }) => bowler.active && bowlerLeague.active).map(({ bowler }) => ({ id: bowler.id, name: bowler.name, teamId: teamId }));
  const savedOccurrenceOverrides = (rosterQuery.data?.data?.occurrenceResponsibilities ?? [])
    .filter((responsibility) => responsibility.teamId === teamId && responsibility.responsibilityKind !== "main");
  const selectedOccurrence = rosterQuery.data?.data?.occurrences.find((occurrence) => occurrence.id === selectedOccurrenceId);
  // Keep the normal roster compact: only the selected occurrence is editable
  // here. Saved non-default rows remain summarized below so an administrator
  // can see that other weeks have contextual overrides without rendering every
  // occurrence × slot combination.
  const selectedOccurrenceRows = selectedOccurrence
    ? normalizedSlots.filter((slot) => slot.occupant !== "unassigned").map((slot) => {
      const persisted = rosterQuery.data?.data?.occurrenceResponsibilities.find((row) => row.teamId === teamId && row.occurrenceId === selectedOccurrence.id && row.slotIndex === slot.slotIndex);
      if (persisted) return persisted;
      return {
        occurrenceId: selectedOccurrence.id,
        teamId,
        slotIndex: slot.slotIndex,
        positionIndex: slot.slotIndex,
        responsibilityKind: slot.occupant === "vacant" ? "vacant" as const : "main" as const,
        mainBowlerId: slot.mainBowlerId ?? null,
        substituteBowlerId: null,
        payerBowlerId: slot.mainBowlerId ?? null,
        policy,
        amountMinor: slot.occupant === "vacant" ? 0 : league?.weeklyFee ?? 0,
        lineageAmountMinor: null,
        prizeFundAmountMinor: null,
      } satisfies OccurrenceResponsibility;
    })
    : [];
  const occurrenceLabel = (startAt: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: league?.timezone ?? "UTC" }).format(new Date(startAt));
  const updateSlot = (slotIndex: number, value: Partial<Slot>) => setSlots((rows) => rows.map((row) => row.slotIndex === slotIndex ? { ...row, ...value } : row));
  const setMemberRole = (bowlerId: number, role: "main" | "substitute") => {
    if (role === "main") {
      const target = normalizedSlots.find((slot) => slot.occupant !== "main");
      if (!target) { toast({ title: "No open paying position", description: "Set an existing Main to VACANT or Substitute first.", variant: "destructive" }); return; }
      setSlots((rows) => rows.map((row) => row.slotIndex === target.slotIndex ? { ...row, occupant: "main", mainBowlerId: bowlerId } : row));
    } else {
      setSlots((rows) => rows.map((row) => row.mainBowlerId === bowlerId ? { ...row, occupant: "vacant", mainBowlerId: null } : row));
    }
  };

  return <div className="space-y-4"><div className="rounded-md border"><Table><TableHeader><TableRow><TableHead>Position</TableHead><TableHead>Name</TableHead><TableHead>Payer role</TableHead><TableHead>Weekly Fee</TableHead><TableHead>Status</TableHead><TableHead>Actions</TableHead></TableRow></TableHeader><TableBody>
    {normalizedSlots.filter((slot) => slot.occupant !== "main").map((slot) => {
      const main = slot.mainBowlerId ? memberById.get(slot.mainBowlerId) : undefined;
      return <TableRow key={`payment-slot-${slot.slotIndex}`}>
        <TableCell className="font-medium">{slot.slotIndex + 1}</TableCell>
        <TableCell>{main ? <Link href={`/bowlers/${main.id}?from=team&fromTeamId=${teamId}`} className="hover:underline">{main.name}</Link> : slot.occupant === "vacant" ? <span className="text-muted-foreground">VACANT</span> : <span className="text-muted-foreground">Unassigned</span>}</TableCell>
        <TableCell><select aria-label={`Payer role position ${slot.slotIndex + 1}`} disabled={!canManage} className="w-full rounded border bg-background p-2" value={slot.occupant} onChange={(event) => updateSlot(slot.slotIndex, { occupant: event.target.value as Slot["occupant"], mainBowlerId: null })}><option value="unassigned">Unassigned</option><option value="vacant">VACANT</option></select></TableCell>
        <TableCell>${((league?.weeklyFee || 0) / 100).toFixed(2)}</TableCell><TableCell><Badge variant={slot.occupant === "unassigned" ? "secondary" : "default"}>{slot.occupant === "unassigned" ? "Incomplete" : slot.occupant === "vacant" ? "VACANT · no obligation" : "Active payer"}</Badge></TableCell><TableCell>{main && <div className="flex items-center gap-2">{onEditBowler && <Button variant="outline" size="sm" onClick={() => onEditBowler(main)}><Pencil className="size-4 mr-2" />Edit</Button>}{onRemoveBowler && <Button variant="ghost" size="sm" onClick={() => onRemoveBowler({ bowlerId: main.id, name: main.name })}><Trash2 className="size-4" /></Button>}</div>}</TableCell>
      </TableRow>;
    })}
    {teamBowlers.map(({ bowler, bowlerLeague }) => { const mainSlot = normalizedSlots.find((slot) => slot.mainBowlerId === bowler.id); const active = bowler.active && bowlerLeague.active; return <TableRow key={`member-${bowlerLeague.id}`}><TableCell className="text-muted-foreground">{mainSlot ? mainSlot.slotIndex + 1 : "—"}</TableCell><TableCell><div className="flex items-center gap-1.5"><CheckCircle2 className={`size-4 ${bowler.hasAccount ? "text-green-500" : "text-muted-foreground/40"}`} /><Link href={`/bowlers/${bowler.id}?from=team&fromTeamId=${teamId}`} className="hover:underline">{bowler.name}</Link></div></TableCell><TableCell><select aria-label={`Payer role ${bowler.name}`} disabled={!canManage || !active} className="rounded border bg-background p-2" value={mainIds.has(bowler.id) ? "main" : "substitute"} onChange={(event) => setMemberRole(bowler.id, event.target.value as "main" | "substitute")}><option value="main">Main</option><option value="substitute">Substitute</option></select></TableCell><TableCell>${((league?.weeklyFee || 0) / 100).toFixed(2)}</TableCell><TableCell><Badge variant={active ? "default" : "secondary"}>{active ? (mainSlot ? "Main" : "Substitute") : "Inactive"}</Badge></TableCell><TableCell><div className="flex items-center gap-2">{onEditBowler && <Button variant="outline" size="sm" onClick={() => onEditBowler(bowler)}><Pencil className="size-4 mr-2" />Edit</Button>}{onRemoveBowler && <Button variant="ghost" size="sm" onClick={() => onRemoveBowler({ bowlerId: bowler.id, name: bowler.name })}><Trash2 className="size-4" /></Button>}</div></TableCell></TableRow>; })}
    {canManage && lineupSize > 0 && <TableRow><TableCell colSpan={6}><div className="flex flex-wrap items-center gap-3"><label className="text-sm">Team policy <select aria-label="Team payment policy" className="ml-2 rounded border bg-background p-2" value={policy} onChange={(event) => setPolicy(event.target.value as typeof policy)}><option value="main_pays_full">Main pays full</option><option value="sub_pays_full">Substitute pays full</option><option value="special_split">Substitute lineage / Main prize split</option></select></label><Badge variant={normalizedSlots.every((slot) => slot.occupant !== "unassigned") ? "default" : "secondary"}>{normalizedSlots.every((slot) => slot.occupant !== "unassigned") ? "Ready" : "Incomplete"}</Badge><Button disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save roster"}</Button></div></TableCell></TableRow>}
  </TableBody></Table></div>{canManage && selectedOccurrence && <div className="rounded-md border p-4">
    <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
      <div><h3 className="font-medium">Payment override for one occurrence</h3><p className="text-sm text-muted-foreground">Roster defaults are automatic. Select a published occurrence to edit only its lineup positions.</p></div>
      <label className="text-sm">Occurrence <select aria-label="Override occurrence" className="ml-2 rounded border bg-background p-2" value={selectedOccurrence.id} onChange={(event) => setSelectedOccurrenceId(event.target.value)}>{(rosterQuery.data?.data?.occurrences ?? []).map((occurrence) => <option key={occurrence.id} value={occurrence.id}>{occurrenceLabel(occurrence.startAt)}</option>)}</select></label>
    </div>
    <div className="mb-3 text-xs text-muted-foreground">Saved non-default overrides: {savedOccurrenceOverrides.length}</div>
    {selectedOccurrenceRows.length > 0 ? <Table><TableHeader><TableRow><TableHead>Position</TableHead><TableHead>Default Main</TableHead><TableHead>Assignment</TableHead><TableHead>Payer/status</TableHead><TableHead /></TableRow></TableHeader><TableBody>{selectedOccurrenceRows.map((responsibility) => {
      const key = `${responsibility.occurrenceId}:${responsibility.slotIndex}`;
      const slot = normalizedSlots.find((row) => row.slotIndex === responsibility.slotIndex);
      const main = slot?.mainBowlerId ? memberById.get(slot.mainBowlerId) : undefined;
      const persisted = substitutes[key];
      const defaultKind: OverrideKind = responsibility.responsibilityKind;
      const kind = persisted?.kind ?? defaultKind;
      const bowlerId = persisted?.bowlerId ?? responsibility.substituteBowlerId;
      const splitAvailable = rosterQuery.data?.data?.substitutePaymentRegime === "league_lineage_prize_split" && rosterQuery.data?.data?.lineageFee != null && rosterQuery.data?.data?.prizeFundFee != null;
      const displayName = bowlerId == null ? "" : substituteOptions.find((option) => option.id === bowlerId)?.name ?? memberById.get(bowlerId)?.name ?? "Assigned";
      const amount = `$${(responsibility.amountMinor / 100).toFixed(2)}`;
      return <TableRow key={key}>
        <TableCell>{responsibility.slotIndex + 1}</TableCell>
        <TableCell>{main?.name ?? "VACANT"}</TableCell>
        <TableCell><select aria-label={`Override kind ${key}`} disabled={!canManage} className="rounded border bg-background p-1" value={kind} onChange={(event) => { const next = event.target.value as OverrideKind; setSubstitutes((rows) => ({ ...rows, [key]: { occurrenceId: responsibility.occurrenceId, slotIndex: responsibility.slotIndex, kind: next, policy: next === "split" ? "special_split" : next === "vacant" || next === "main" ? "main_pays_full" : responsibility.policy, bowlerId: next === "vacant" || next === "main" ? null : bowlerId } })); }}>{slot?.occupant === "main" && <option value="main">Use roster Main</option>}<option value="substitute">Substitute</option>{splitAvailable && slot?.occupant === "main" && <option value="split">Split</option>}{(slot?.occupant === "vacant" || responsibility.responsibilityKind === "vacant") && <option value="vacant">VACANT</option>}</select>{kind !== "vacant" && kind !== "main" && <select aria-label={`Override bowler ${key}`} disabled={!canManage} className="ml-2 rounded border bg-background p-1" value={bowlerId ?? ""} onChange={(event) => { const next = Number(event.target.value); setSubstitutes((rows) => ({ ...rows, [key]: { occurrenceId: responsibility.occurrenceId, slotIndex: responsibility.slotIndex, kind, policy: persisted?.policy ?? responsibility.policy, bowlerId: next } })); }}><option value="">Select bowler</option>{substituteOptions.filter((option) => option.id !== responsibility.mainBowlerId).map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select>}</TableCell>
        <TableCell>{kind === "main" ? "Main · full default" : kind === "vacant" ? "VACANT · no obligation" : bowlerId ? `${displayName} · ${amount}` : "Select a substitute"}</TableCell>
        <TableCell>{canManage && <Button variant="outline" size="sm" disabled={assignSubstitute.isPending || (kind !== "vacant" && kind !== "main" && !bowlerId)} onClick={() => assignSubstitute.mutate({ occurrenceId: responsibility.occurrenceId, slotIndex: responsibility.slotIndex, kind, overridePolicy: persisted?.policy ?? responsibility.policy, bowlerId: kind === "vacant" || kind === "main" ? null : bowlerId })}>Save</Button>}</TableCell>
      </TableRow>;
    })}</TableBody></Table> : <p className="text-sm text-muted-foreground">No paying positions are configured for this team.</p>}
    {savedOccurrenceOverrides.length > 0 && <div className="mt-3 text-xs text-muted-foreground">{savedOccurrenceOverrides.slice(0, 8).map((responsibility) => { const occurrence = rosterQuery.data?.data?.occurrences.find((row) => row.id === responsibility.occurrenceId); return <span className="mr-3 inline-block" key={`${responsibility.occurrenceId}:${responsibility.slotIndex}`}>{occurrence ? occurrenceLabel(occurrence.startAt) : responsibility.occurrenceId} · position {responsibility.slotIndex + 1} · {responsibility.responsibilityKind}</span>; })}{savedOccurrenceOverrides.length > 8 && <span>+{savedOccurrenceOverrides.length - 8} more</span>}</div>}
  </div>}</div>;
}
