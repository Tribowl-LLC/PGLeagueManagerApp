import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useSearch } from "wouter";
import { Layout } from "@/components/layout";
import { PageLoadingState } from "@/components/page-states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { FinancialActivationSourceContract, FinancialActivationSourceRow } from "@shared/financial-contract";

type RosterRow = { bowlerId: number; name: string };

export default function FinancialActivationPage() {
  const { leagueId: leagueIdParam } = useParams();
  const search = useSearch();
  const organizationId = new URLSearchParams(search).get("organizationId");
  const scopeSuffix = organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : "";
  const leagueId = Number(leagueIdParam);
  const { toast } = useToast();
  const [selected, setSelected] = useState<Record<string, { bowlerId: number; role?: "regular" | "substitute"; provenance: "explicit_admin_selection" }>>({});
  const [submitting, setSubmitting] = useState(false);
  const [commandKey] = useState(() => `financial-activation-${crypto.randomUUID()}`);
  const sourceQuery = useQuery<{ data: FinancialActivationSourceContract }>({
    queryKey: [`/api/financials/leagues/${leagueId}/source${scopeSuffix}`],
    enabled: Number.isSafeInteger(leagueId) && leagueId > 0,
    queryFn: async () => {
      const response = await fetch(`/api/financials/leagues/${leagueId}/source${scopeSuffix}`);
      if (!response.ok) throw new Error("Unable to load canonical billing source");
      return response.json();
    },
  });
  const rosterQuery = useQuery<{ data: RosterRow[] }>({
    queryKey: [`/api/financials/leagues/${leagueId}/roster${scopeSuffix}`],
    enabled: Number.isSafeInteger(leagueId) && leagueId > 0,
    queryFn: async () => {
      const response = await fetch(`/api/financials/leagues/${leagueId}/roster${scopeSuffix}`);
      if (!response.ok) throw new Error("Unable to load scoped tenant candidates");
      return response.json();
    },
  });
  const groups = useMemo(() => {
    const map = new Map<string, FinancialActivationSourceRow[]>();
    for (const row of sourceQuery.data?.data.expected ?? []) {
      const key = `${row.occurrenceId}:${row.teamId}`;
      map.set(key, [...(map.get(key) ?? []), row]);
    }
    return [...map.entries()];
  }, [sourceQuery.data]);
  const update = (key: string, value: Partial<typeof selected[string]>) => setSelected((current) => ({ ...current, [key]: { ...(current[key] ?? { bowlerId: 0, provenance: "explicit_admin_selection" as const }), ...value } }));
  const submit = async () => {
    const source = sourceQuery.data?.data;
    if (!source) return;
    const payingLineupSize = source.payingLineupSize;
    const responsibilities = groups.flatMap(([groupKey, rows]) => Array.from({ length: payingLineupSize }, (_, slotIndex) => {
      const row = rows[0];
      const choice = selected[`${groupKey}:${slotIndex}`];
      return row && choice ? { occurrenceId: row.occurrenceId, teamId: row.teamId, slotIndex, ...choice } : null;
    }).filter((row): row is NonNullable<typeof row> => row !== null && row.bowlerId > 0));
    setSubmitting(true);
    try {
      if (responsibilities.length !== groups.length * payingLineupSize || responsibilities.some((row) => !row.role)) throw new Error("Complete every explicit payer slot and role before activation");
      const occurrenceBowlers = new Set<string>();
      for (const row of responsibilities) { const key = `${row.occurrenceId}:${row.bowlerId}`; if (occurrenceBowlers.has(key)) throw new Error("A bowler may be selected once per occurrence"); occurrenceBowlers.add(key); }
      if (!window.confirm("Activate this exact responsibility matrix? This is irreversible in F1, creates no provider payment, and never links historical payments.")) return;
      await apiRequest(`/api/financials/leagues/${leagueId}/activate${scopeSuffix}`, "POST", { commandKey, sourceFingerprint: source.sourceFingerprint, responsibilities });
      toast({ title: "Canonical financial activation recorded", description: "Due and past-due reports now use the canonical evidence contract." });
    } catch (error) {
      toast({ title: "Activation unavailable", description: error instanceof Error ? error.message : "Review required", variant: "destructive" });
    } finally { setSubmitting(false); }
  };
  if (sourceQuery.isLoading || rosterQuery.isLoading) return <Layout><PageLoadingState /></Layout>;
  if (sourceQuery.error || rosterQuery.error) return <Layout><p className="p-6 text-destructive">Canonical activation source is unavailable. No financial activation was created.</p></Layout>;
  const roster = rosterQuery.data?.data ?? [];
  return <Layout><div className="mx-auto max-w-5xl space-y-6 p-6">
    <div><h1 className="text-2xl font-bold">Review payer responsibility</h1><p className="text-muted-foreground">League setup determines the number of explicit bowler positions required for every published billable occurrence and active team. Nothing is preselected.</p><p className="text-xs text-muted-foreground">System administrators must provide an explicit organization scope in the URL.</p></div>
    {groups.map(([groupKey, rows]) => {
      const lineupSize = sourceQuery.data?.data.payingLineupSize;
      const candidates = roster;
      return <Card key={groupKey}><CardHeader><CardTitle>Occurrence {new Date(rows[0]?.occurrenceStartAt ?? "").toLocaleDateString()} · {rows[0]?.teamName ?? "Team"}</CardTitle><p className="text-sm text-muted-foreground">{rows[0]?.occurrenceKind} · {rows[0]?.occurrenceStatus} · {rows[0]?.paymentMode} · ${((rows[0]?.amountMinor ?? 0) / 100).toFixed(2)} USD · choose exactly {lineupSize} responsible bowlers.</p></CardHeader><CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">League lineup: {lineupSize === 3 ? "Three Bowlers" : "Four Bowlers"}</p>
        {Array.from({ length: 4 }, (_, slotIndex) => { const row = rows[0]; const key = `${groupKey}:${slotIndex}`; const value = selected[key]; const disabled = lineupSize === undefined || slotIndex >= lineupSize; return <div className="grid gap-2 md:grid-cols-4" key={key}>
          <Label className="self-center">Bowler position {slotIndex + 1}</Label>
          <Select disabled={disabled} value={value?.bowlerId ? String(value.bowlerId) : ""} onValueChange={(next) => update(key, { bowlerId: Number(next) })}><SelectTrigger><SelectValue placeholder="Select bowler" /></SelectTrigger><SelectContent>{candidates.map((candidate) => <SelectItem key={candidate.bowlerId} value={String(candidate.bowlerId)}>{candidate.name}</SelectItem>)}</SelectContent></Select>
          <Select disabled={disabled} value={value?.role ?? ""} onValueChange={(next) => update(key, { role: next as "regular" | "substitute" })}><SelectTrigger><SelectValue placeholder="Choose role" /></SelectTrigger><SelectContent><SelectItem value="regular">Regular payer</SelectItem><SelectItem value="substitute">Substitute payer</SelectItem></SelectContent></Select>
          <span className="self-center text-xs text-muted-foreground">Explicit admin selection</span>
        </div>; })}
      </CardContent></Card>;
    })}
    <p className="text-sm text-amber-700">This activation is irreversible in F1 and financially locks the covered schedule evidence. It creates obligations only from the reviewed canonical source; it does not call Square, link historical payments, or start collection.</p><Button disabled={submitting || groups.length === 0 || groups.some(([key]) => Array.from({ length: sourceQuery.data?.data.payingLineupSize ?? 0 }, (_, slot) => !selected[`${key}:${slot}`]?.bowlerId || !selected[`${key}:${slot}`]?.role).some(Boolean))} onClick={submit}>{submitting ? "Activating…" : "Review and activate canonical billing"}</Button>
  </div></Layout>;
}
