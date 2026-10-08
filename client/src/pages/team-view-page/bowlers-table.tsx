import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Link } from "wouter";
import { CheckCircle2, Pencil, Trash2 } from "lucide-react";
import type { Bowler, League, BowlerWithAccount } from "@shared/schema";
import { serializeCanonicalRotatingRosterFingerprint, type RosterPaymentResponsibilityReadContractV2 } from "@shared/roster-payment-contract";
import type { TeamBowlerEntry } from "@/lib/bowler-league-utils";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { fingerprintCanonicalRequest } from "@/lib/rotating-payment-fingerprint";
import { useToast } from "@/hooks/use-toast";

type TeamPolicy = "main_pays_full" | "sub_pays_full" | "special_split";
type SharedSpotTeam = Pick<RosterPaymentResponsibilityReadContractV2["teams"][number], "slots" | "policy" | "eligibleRotatingBowlerIds">;

interface TeamViewBowlersTableProps {
  teamBowlers: TeamBowlerEntry<BowlerWithAccount>[];
  league: League | undefined;
  teamId: number;
  leagueId: number;
  canManage: boolean;
  paymentMode?: "fixed" | "rotating" | "unavailable";
  /** The team's lineup spots when one of them is still a retiring shared (rotating) spot. */
  sharedSpotTeam?: SharedSpotTeam;
  onEditBowler?: (bowler: Bowler) => void;
  onRemoveBowler?: (target: { bowlerId: number; name: string }) => void;
}

type Slot = { slotIndex: number; occupant: "main" | "vacant" | "unassigned" | "rotating"; mainBowlerId?: number | null };
type RosterResponse = {
  payingLineupSize: number | null;
  teams: Array<{ id: number; slots: Slot[]; policy: TeamPolicy }>;
};

function rosterFingerprint(lineupSize: number, policy: string, slots: Slot[]): Promise<string> {
  const canonical = JSON.stringify({
    lineupSize,
    policy,
    slots: [...slots].sort((left, right) => left.slotIndex - right.slotIndex)
      .map((slot) => ({ slotIndex: slot.slotIndex, occupant: slot.occupant, mainBowlerId: slot.mainBowlerId ?? null })),
  });
  return fingerprintCanonicalRequest("lvroster:v1", canonical);
}

export function TeamViewBowlersTable({ teamBowlers, league, teamId, leagueId, canManage, paymentMode = "fixed", sharedSpotTeam, onEditBowler, onRemoveBowler }: TeamViewBowlersTableProps) {
  const { toast } = useToast();
  const hasSharedSpot = paymentMode === "rotating";
  const rosterQuery = useQuery<{ data: RosterResponse }>({ queryKey: [`/api/financials/leagues/${leagueId}/roster-payment-responsibility/1`], enabled: canManage && paymentMode === "fixed" });
  const fixedTeam = rosterQuery.data?.data?.teams.find((team) => team.id === teamId);
  const current = hasSharedSpot ? sharedSpotTeam : fixedTeam;
  const lineupSize = hasSharedSpot
    ? sharedSpotTeam?.slots.length ?? 0
    : rosterQuery.data?.data?.payingLineupSize ?? league?.payingLineupSize ?? 0;
  const [slots, setSlots] = useState<Slot[]>([]);
  useEffect(() => {
    if (!current) return;
    setSlots(current.slots.map((slot) => ({
      slotIndex: slot.slotIndex,
      occupant: slot.occupant,
      mainBowlerId: slot.mainBowlerId ?? null,
    })));
  }, [current]);
  const normalizedSlots = useMemo(() => Array.from({ length: lineupSize }, (_, slotIndex) => slots.find((slot) => slot.slotIndex === slotIndex) ?? { slotIndex, occupant: "unassigned" as const, mainBowlerId: null }), [lineupSize, slots]);

  const save = useMutation({
    mutationFn: async () => {
      const policy = current?.policy ?? "main_pays_full";
      const requestSlots = normalizedSlots.map((slot) => ({
        slotIndex: slot.slotIndex,
        occupant: slot.occupant,
        mainBowlerId: slot.occupant === "main" ? slot.mainBowlerId ?? null : null,
      }));
      if (!hasSharedSpot) {
        return apiRequest(`/api/financials/leagues/${leagueId}/roster-payment-responsibility/1/teams/${teamId}`, "POST", {
          commandKey: crypto.randomUUID(), requestFingerprint: await rosterFingerprint(lineupSize, policy, requestSlots), lineupSize, policy, slots: requestSlots,
        });
      }
      if (lineupSize !== 3 && lineupSize !== 4) throw new Error("The league lineup size is not configured yet.");
      // The shared spot and its members are saved back unchanged; only the
      // regular spots are edited here.
      const request = {
        lineupSize,
        policy,
        slots: requestSlots,
        eligibleRotatingBowlerIds: [...(sharedSpotTeam?.eligibleRotatingBowlerIds ?? [])].sort((left, right) => left - right),
      } as const;
      return apiRequest(`/api/financials/leagues/${leagueId}/roster-payment-responsibility/2/teams/${teamId}`, "POST", {
        commandKey: crypto.randomUUID(),
        requestFingerprint: await fingerprintCanonicalRequest("lvroster:v2", serializeCanonicalRotatingRosterFingerprint(request)),
        ...request,
      });
    },
    onSuccess: () => {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/roster-payment-responsibility/1`] }),
        queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/roster-payment-responsibility/2`] }),
        queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/canonical-due-past-due/2`] }),
        queryClient.invalidateQueries({ queryKey: ["manage-payments-snapshot", leagueId] }),
        queryClient.invalidateQueries({ predicate: ({ queryKey }) => typeof queryKey[0] === "string" && queryKey[0].startsWith("/api/financials/due-past-due") }),
      ]);
      toast({ title: "Team roster saved" });
    },
    onError: (error: Error) => toast({ title: "Team roster could not be saved", description: error.message, variant: "destructive" }),
  });

  const memberById = new Map(teamBowlers.map(({ bowler }) => [bowler.id, bowler]));
  const regularIds = new Set(normalizedSlots.flatMap((slot) => slot.occupant === "main" && slot.mainBowlerId ? [slot.mainBowlerId] : []));
  const updateSlot = (slotIndex: number, value: Partial<Slot>) => setSlots((rows) => rows.map((row) => row.slotIndex === slotIndex ? { ...row, ...value } : row));
  const setMemberRole = (bowlerId: number, role: "regular" | "sub") => {
    if (role === "regular") {
      const target = normalizedSlots.find((slot) => slot.occupant === "vacant" || slot.occupant === "unassigned");
      if (!target) { toast({ title: "No open lineup spot", description: "Change a regular to a sub first.", variant: "destructive" }); return; }
      setSlots((rows) => rows.some((row) => row.slotIndex === target.slotIndex)
        ? rows.map((row) => row.slotIndex === target.slotIndex ? { ...row, occupant: "main", mainBowlerId: bowlerId } : row)
        : [...rows, { slotIndex: target.slotIndex, occupant: "main", mainBowlerId: bowlerId }]);
    } else {
      setSlots((rows) => rows.map((row) => row.mainBowlerId === bowlerId ? { ...row, occupant: "vacant", mainBowlerId: null } : row));
    }
  };

  if (paymentMode === "unavailable") {
    return <div className="mt-4 rounded-md border p-4 text-sm text-muted-foreground" role="status" aria-busy="true">Loading team roster…</div>;
  }

  const memberActions = (bowler: Bowler) => <div className="flex items-center gap-2">
    {onEditBowler && <Button variant="outline" size="sm" aria-label={`Edit ${bowler.name}`} onClick={() => onEditBowler(bowler)}><Pencil className="mr-2 size-4" />Edit</Button>}
    {onRemoveBowler && <Button variant="ghost" size="sm" aria-label={`Remove ${bowler.name}`} onClick={() => onRemoveBowler({ bowlerId: bowler.id, name: bowler.name })}><Trash2 className="size-4" /></Button>}
  </div>;
  const ready = normalizedSlots.every((slot) => slot.occupant !== "unassigned");

  return <div className="rounded-md border">
    <Table>
      <TableHeader><TableRow><TableHead>Lineup spot</TableHead><TableHead>Name</TableHead><TableHead>Role</TableHead><TableHead>Status</TableHead><TableHead>Actions</TableHead></TableRow></TableHeader>
      <TableBody>
        {normalizedSlots.filter((slot) => slot.occupant !== "main").map((slot) => <TableRow key={`lineup-spot-${slot.slotIndex}`}>
          <TableCell weight="medium">{slot.slotIndex + 1}</TableCell>
          <TableCell><span className="text-muted-foreground">{slot.occupant === "rotating" ? "Shared spot" : slot.occupant === "vacant" ? "VACANT" : "Unassigned"}</span></TableCell>
          <TableCell>
            {slot.occupant === "rotating"
              ? <span className="text-sm text-muted-foreground">No regular</span>
              : <select aria-label={`Lineup spot ${slot.slotIndex + 1}`} disabled={!canManage} className="w-full rounded border bg-background p-2" value={slot.occupant} onChange={(event) => updateSlot(slot.slotIndex, { occupant: event.target.value === "vacant" ? "vacant" : "unassigned", mainBowlerId: null })}><option value="unassigned">Unassigned</option><option value="vacant">VACANT</option></select>}
          </TableCell>
          <TableCell><Badge variant={slot.occupant === "unassigned" ? "secondary" : "default"}>{slot.occupant === "rotating" ? "Assigned weekly in Manage Payments" : slot.occupant === "unassigned" ? "Incomplete" : "VACANT"}</Badge></TableCell>
          <TableCell />
        </TableRow>)}
        {teamBowlers.map(({ bowler, bowlerLeague }) => {
          const spot = normalizedSlots.find((slot) => slot.occupant === "main" && slot.mainBowlerId === bowler.id);
          const active = bowler.active && bowlerLeague.active;
          return <TableRow key={`member-${bowlerLeague.id}`}>
            <TableCell tone="muted">{spot ? spot.slotIndex + 1 : "—"}</TableCell>
            <TableCell><div className="flex items-center gap-1.5"><CheckCircle2 className={`size-4 ${bowler.hasAccount ? "text-success-500" : "text-muted-foreground/40"}`} /><Link href={`/bowlers/${bowler.id}?from=team&fromTeamId=${teamId}`} className="hover:underline">{bowler.name}</Link></div></TableCell>
            <TableCell><select aria-label={`Role ${bowler.name}`} disabled={!canManage || !active} className="rounded border bg-background p-2" value={regularIds.has(bowler.id) ? "regular" : "sub"} onChange={(event) => setMemberRole(bowler.id, event.target.value === "regular" ? "regular" : "sub")}><option value="regular">Regular</option><option value="sub">Sub</option></select></TableCell>
            <TableCell><Badge variant={active ? "default" : "secondary"}>{active ? (spot ? "Regular" : "Sub") : "Inactive"}</Badge></TableCell>
            <TableCell>{memberActions(bowler)}</TableCell>
          </TableRow>;
        })}
        {teamBowlers.length === 0 && <TableRow><TableCell colSpan={5}><span className="text-sm text-muted-foreground">No team members are assigned.</span></TableCell></TableRow>}
        {canManage && lineupSize > 0 && <TableRow><TableCell colSpan={5}><div className="flex flex-wrap items-center gap-3"><Badge variant={ready ? "default" : "secondary"}>{ready ? "Ready" : "Incomplete"}</Badge><Button disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save roster"}</Button></div></TableCell></TableRow>}
      </TableBody>
    </Table>
  </div>;
}
