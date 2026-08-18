import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { csrfFetch } from "@/lib/queryClient";

type Selection = { obligationId: string; amountMinor: number };
type QuoteRow = { obligationId: string; bowlerId: number; amountMinor: number; outstandingMinor: number; dueAt: string | null };
type Quote = { rows: QuoteRow[]; fingerprint: string };
export type InteractiveOccurrenceReadiness = 'loading' | 'ready' | 'empty' | 'error' | 'legacy' | 'disabled';

export function InteractiveOccurrenceSelector({
  leagueId,
  organizationId,
  amountMinor,
  bowlerIds,
  enabled,
  onChange,
  onReadinessChange,
}: {
  leagueId: number;
  organizationId?: number;
  amountMinor: number;
  bowlerIds: number[];
  enabled: boolean;
  onChange: (selections: Selection[], fingerprint?: string) => void;
  onReadinessChange?: (readiness: InteractiveOccurrenceReadiness) => void;
}) {
  const [selections, setSelections] = useState<Record<string, number>>({});
  const payees = useMemo(() => [...new Set(bowlerIds)].sort((a, b) => a - b), [bowlerIds]);
  const query = useQuery<Quote | null>({
    queryKey: ["/api/payments-provider/payments/quote", organizationId, leagueId, amountMinor, payees],
    enabled: enabled && amountMinor > 0 && payees.length > 0,
    staleTime: 0,
    retry: false,
    queryFn: async () => {
      const response = await csrfFetch("/api/payments-provider/payments/quote", {
        method: "POST",
        body: JSON.stringify({ leagueId, ...(organizationId ? { organizationId } : {}), amountMinor, payees: payees.map((bowlerId) => ({ bowlerId })) }),
      });
      const body = await response.json() as { error?: { code?: string; message?: string } } & Partial<Quote>;
      if (!response.ok && body.error?.code === "OCCURRENCE_ALLOCATION_UNAVAILABLE") return null;
      if (!response.ok || !body.rows || !body.fingerprint) throw new Error(body.error?.message || "Unable to load payment obligations.");
      return body as Quote;
    },
  });

  useEffect(() => {
    const valid = new Set((query.data?.rows ?? []).map((row) => row.obligationId));
    setSelections((current) => Object.fromEntries(Object.entries(current).filter(([id]) => valid.has(id))));
  }, [query.data]);

  useEffect(() => {
    const next = Object.entries(selections).map(([obligationId, value]) => ({ obligationId, amountMinor: value }));
    onChange(next, query.data?.fingerprint);
  }, [onChange, query.data?.fingerprint, selections]);

  const selectedTotal = Object.values(selections).reduce((sum, value) => sum + value, 0);
  const readiness: InteractiveOccurrenceReadiness = !enabled || amountMinor <= 0 || payees.length === 0
    ? 'disabled'
    : query.isLoading || query.fetchStatus === 'fetching'
      ? 'loading'
      : query.error
        ? 'error'
        : !query.data
          ? 'legacy'
          : selectedTotal === amountMinor && selections && Object.keys(selections).length > 0
            ? 'ready'
            : 'empty';

  useEffect(() => {
    onReadinessChange?.(readiness);
  }, [onReadinessChange, readiness]);

  if (!enabled || (!query.data && !query.isLoading && !query.error)) return null;
  if (query.isLoading) return <p className="text-sm text-muted-foreground" data-testid="occurrence-quote-loading">Loading current obligations…</p>;
  if (query.error) return <Alert variant="destructive"><AlertDescription>Current obligations could not be loaded. Refresh before paying.</AlertDescription></Alert>;
  if (!query.data) return null;

  return (
    <section aria-label="Payment obligations" className="space-y-3 rounded-md border p-4" data-testid="interactive-occurrence-selector">
      <div>
        <h3 className="font-medium">Choose what this payment covers</h3>
        <p className="text-sm text-muted-foreground">Select specific obligations. Partial amounts and future prepayments are allowed.</p>
      </div>
      {query.data.rows.map((row) => {
        const selected = selections[row.obligationId] ?? 0;
        return (
          <label key={row.obligationId} className="flex items-center gap-3 text-sm">
            <input type="checkbox" checked={selected > 0} onChange={(event) => setSelections((current) => ({ ...current, ...(event.target.checked ? { [row.obligationId]: Math.min(row.outstandingMinor, amountMinor) } : (() => { const next = { ...current }; delete next[row.obligationId]; return next; })()) }))} />
            <span className="flex-1">Bowler {row.bowlerId} · {row.dueAt ? new Date(row.dueAt).toLocaleDateString() : "No due date"} · outstanding ${(row.outstandingMinor / 100).toFixed(2)}</span>
            {selected > 0 && <input aria-label={`Amount for obligation ${row.obligationId}`} className="w-24 rounded border px-2 py-1" type="number" min={1} max={row.outstandingMinor} value={selected} onChange={(event) => setSelections((current) => ({ ...current, [row.obligationId]: Math.min(row.outstandingMinor, Math.max(1, Number(event.target.value) || 1)) }))} />}
          </label>
        );
      })}
      <p className={selectedTotal === amountMinor ? "text-sm text-muted-foreground" : "text-sm text-destructive"} data-testid="occurrence-quote-total">Selected ${(selectedTotal / 100).toFixed(2)} of ${(amountMinor / 100).toFixed(2)}</p>
    </section>
  );
}
