import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { csrfFetch } from "@/lib/queryClient";

type Candidate = { id: string; startAt: string; lifecycle: string; localDate: string | null; localStartTime: string | null; timezone: string | null; ordinal: number | null };
type PolicySummary = { id: string; policyVersion: number; state: string; policyFingerprint: string };
type CandidateResponse = { activation: { id: string; revision: number; sourceFingerprint: string }; occurrences: Candidate[]; nextPolicyVersion: number; currentPolicy: PolicySummary | null; draftPolicy: (PolicySummary & { collectionPoints: { occurrenceId: string }[]; occurrences: Array<{ occurrenceId: string; groupKey: string; groupRole: "normal" | "trigger" | "paired"; pairedOccurrenceId: string | null; collectionPointOccurrenceId: string; itemIndex: number }> }) | null; policySummaries?: PolicySummary[] };
type PolicyRow = { occurrenceId: string; groupKey: string; groupRole: "normal" | "trigger" | "paired"; pairedOccurrenceId: string | null; collectionPoint: { occurrenceId: string } };
type Pair = { trigger: string; paired: string };

/** Dates and ordinals are display evidence only; every double-pay pair is an
 * explicit, disjoint trigger/paired selection. */
export function F3PolicyReview({ leagueId, organizationId }: { leagueId: number; organizationId: number }) {
  const queryClient = useQueryClient();
  const [pairs, setPairs] = useState<Pair[]>([]);
  const [trigger, setTrigger] = useState("");
  const [paired, setPaired] = useState("");
  const [created, setCreated] = useState<{ id: string; fingerprint?: string; policyVersion: number; state: string; rows: PolicyRow[] } | null>(null);
  const [commandKey] = useState(() => `f3-policy-${crypto.randomUUID()}`);
  const candidates = useQuery({ queryKey: ["f3-policy-candidates", organizationId, leagueId], queryFn: async () => {
    const response = await csrfFetch(`/api/financials/f3/leagues/${leagueId}/policy/candidates?organizationId=${organizationId}`);
    const body = await response.json();
    if (!response.ok) { const error = new Error(body.error?.message ?? "Unavailable") as Error & { code?: string }; error.code = body.error?.code; throw error; }
    return body.data as CandidateResponse;
  }, retry: false });
  const rows = useMemo(() => candidates.data?.occurrences ?? [], [candidates.data?.occurrences]);
  useEffect(() => {
    const draft = candidates.data?.draftPolicy;
    if (!draft || created) return;
    setCreated({ id: draft.id, fingerprint: draft.policyFingerprint, policyVersion: draft.policyVersion, state: draft.state, rows: draft.occurrences.map((row) => ({ occurrenceId: row.occurrenceId, groupKey: row.groupKey, groupRole: row.groupRole, pairedOccurrenceId: row.pairedOccurrenceId, collectionPoint: { occurrenceId: row.collectionPointOccurrenceId } })) });
  }, [candidates.data?.draftPolicy, created]);
  const used = useMemo(() => new Set(pairs.flatMap((pair) => [pair.trigger, pair.paired])), [pairs]);
  const policyRows = useMemo<PolicyRow[]>(() => rows.map((row) => {
    const pair = pairs.find((candidate) => candidate.trigger === row.id || candidate.paired === row.id);
    if (!pair) return { occurrenceId: row.id, groupKey: `normal-${row.id}`, groupRole: "normal", pairedOccurrenceId: null, collectionPoint: { occurrenceId: row.id } };
    return pair.trigger === row.id
      ? { occurrenceId: row.id, groupKey: `double-${pair.trigger}`, groupRole: "trigger", pairedOccurrenceId: pair.paired, collectionPoint: { occurrenceId: pair.trigger } }
      : { occurrenceId: row.id, groupKey: `double-${pair.trigger}`, groupRole: "paired", pairedOccurrenceId: pair.trigger, collectionPoint: { occurrenceId: pair.trigger } };
  }), [pairs, rows]);
  const create = useMutation({ mutationFn: async () => {
    if (!candidates.data) throw new Error("Policy evidence unavailable");
    const bodyRows = policyRows;
    const response = await csrfFetch(`/api/financials/f3/leagues/${leagueId}/policy?organizationId=${organizationId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ activationId: candidates.data.activation.id, activationRevision: candidates.data.activation.revision, activationSourceFingerprint: candidates.data.activation.sourceFingerprint, policyVersion: candidates.data.nextPolicyVersion, collectionPoints: bodyRows.filter((row) => row.groupRole !== "paired").map((row) => ({ occurrenceId: row.collectionPoint.occurrenceId })), occurrences: bodyRows, commandKey }) });
    const result = await response.json();
    if (!response.ok) { const error = new Error(result.error?.message ?? "Policy draft could not be created") as Error & { code?: string }; error.code = result.error?.code; throw error; }
    return { ...result.data, rows: bodyRows };
  }, onSuccess: (body: { id?: string; policyFingerprint?: string; rows: PolicyRow[] }) => { setCreated(body.id ? { id: body.id, fingerprint: body.policyFingerprint, policyVersion: candidates.data?.nextPolicyVersion ?? 0, state: "draft", rows: body.rows } : null); void queryClient.invalidateQueries({ queryKey: ["f3-policy-candidates", organizationId, leagueId] }); } });
  const approve = useMutation({ mutationFn: async () => {
    if (!created?.id) throw new Error("Create a draft first");
    const response = await csrfFetch(`/api/financials/f3/leagues/${leagueId}/policy/${created.id}/approve?organizationId=${organizationId}`, { method: "POST" });
    const body = await response.json();
    if (!response.ok) { const error = new Error(body.error?.message ?? "Policy approval failed") as Error & { code?: string }; error.code = body.error?.code; throw error; }
    return body.data;
  }, onSuccess: () => { setCreated((current) => current ? { ...current, state: "approved" } : current); void queryClient.invalidateQueries({ queryKey: ["f3-policy-candidates", organizationId, leagueId] }); } });
  if (candidates.isLoading) return null;
  if (candidates.isError) { const error = candidates.error as Error & { code?: string }; if (error.code === "F3_DISABLED") return null; return <Card data-testid="f3-policy-review-error"><CardContent><p role="alert">Collection policy review is unavailable: {error.message}</p></CardContent></Card>; }
  if (!candidates.data) return null;
  const addPair = () => { if (trigger && paired && trigger !== paired && !used.has(trigger) && !used.has(paired)) { setPairs((current) => [...current, { trigger, paired }]); setTrigger(""); setPaired(""); } };
  const available = rows.filter((row) => !used.has(row.id));
  return <Card data-testid="f3-policy-review"><CardHeader><CardTitle>Canonical collection policy</CardTitle></CardHeader><CardContent className="space-y-3">
    <p className="text-sm">Review {rows.length} real weekly occurrences. Local date/time and ordinal are display evidence only. Current policy: {candidates.data.currentPolicy?.state ?? "none"}; draft: {candidates.data.draftPolicy?.state ?? "none"}; next version {candidates.data.nextPolicyVersion}.</p>
    <div className="space-y-1 text-xs">{rows.map((row) => <div key={row.id}>{row.ordinal ?? "—"}. {row.localDate ?? row.startAt} {row.localStartTime ?? ""} {row.timezone ?? "UTC"} — {row.id}</div>)}</div>
    <div className="rounded border p-2 text-sm"><div className="font-medium">Add explicit double-pay pair</div><select aria-label="Double-pay trigger" value={trigger} onChange={(event) => setTrigger(event.target.value)}><option value="">Trigger occurrence</option>{available.map((row) => <option key={row.id} value={row.id}>{row.id}</option>)}</select><select aria-label="Exact paired occurrence" value={paired} onChange={(event) => setPaired(event.target.value)}><option value="">Exact second occurrence</option>{available.filter((row) => row.id !== trigger).map((row) => <option key={row.id} value={row.id}>{row.id}</option>)}</select><Button type="button" variant="outline" onClick={addPair}>Add pair</Button></div>
    {pairs.map((pair) => <div key={pair.trigger} className="text-xs">Double-pay: trigger {pair.trigger}; paired {pair.paired} <Button type="button" variant="ghost" onClick={() => setPairs((current) => current.filter((candidate) => candidate.trigger !== pair.trigger))}>Remove</Button></div>)}
    <p className="text-xs">Preview: {policyRows.filter((row) => row.groupRole === "normal").length} normal row(s), {pairs.length} explicit double-pay group(s); collection points are normals plus triggers only.</p><Button type="button" disabled={create.isPending || rows.length === 0} onClick={() => create.mutate()}>Create draft policy</Button>
    {created && <div className="rounded border p-2 text-xs"><div>Draft {created.id}; version {created.policyVersion}; state {created.state}</div><div>Fingerprint {created.fingerprint ?? "returned after review"}</div><div>Collection points: {created.rows.filter((row) => row.groupRole !== "paired").map((row) => row.collectionPoint.occurrenceId).join(", ")}</div><div>Normal occurrences: {created.rows.filter((row) => row.groupRole === "normal").map((row) => row.occurrenceId).join(", ") || "none"}</div>{created.rows.filter((row) => row.groupRole === "trigger").map((row) => <div key={row.occurrenceId}>Double-pay pair: {row.occurrenceId} + {row.pairedOccurrenceId}</div>)}{created.state === "approved" ? <p role="status">Approved immutable policy</p> : <Button type="button" variant="outline" disabled={approve.isPending} onClick={() => { if (window.confirm("Approve this exact immutable collection policy?")) approve.mutate(); }}>Approve reviewed policy</Button>}</div>}
    {create.error && <p role="alert">{create.error.message}</p>}{approve.error && <p role="alert">{approve.error.message}</p>}
  </CardContent></Card>;
}
