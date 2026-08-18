import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatInTimeZone } from "date-fns-tz";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { csrfFetch } from "@/lib/queryClient";

type Selection = { obligationId: string; amountMinor: number };
type QuoteRow = { obligationId: string; bowlerId: number; amountMinor: number; outstandingMinor: number; dueAt: string | null };
type Quote = { rows: QuoteRow[]; fingerprint: string };
export type InteractiveOccurrenceReadiness = 'loading' | 'ready' | 'empty' | 'error' | 'legacy' | 'disabled';

const MAX_SAFE_MINOR_UNITS = Number.MAX_SAFE_INTEGER;

/** Parse a user-entered dollar amount into exact positive minor units. */
export function parseCurrencyToMinorUnits(value: string): number | null {
  const trimmed = value.trim();
  const match = /^(\d+)(?:\.(\d{0,2}))?$/.exec(trimmed);
  if (!match) return null;
  try {
    const minor = BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0");
    if (minor <= 0n || minor > BigInt(MAX_SAFE_MINOR_UNITS)) return null;
    return Number(minor);
  } catch {
    return null;
  }
}

export function formatMinorUnitsAsDollars(amountMinor: number): string {
  const safeAmount = Number.isSafeInteger(amountMinor) && amountMinor >= 0 ? amountMinor : 0;
  return `${Math.floor(safeAmount / 100).toLocaleString("en-US")}.${String(safeAmount % 100).padStart(2, "0")}`;
}

export function formatOccurrenceDueDate(value: string, timezone: string): string {
  return formatInTimeZone(new Date(value), timezone, "MMM d, yyyy");
}

export function InteractiveOccurrenceSelector({
  leagueId,
  organizationId,
  amountMinor,
  bowlerIds,
  timezone,
  enabled,
  onChange,
  onReadinessChange,
}: {
  leagueId: number;
  organizationId?: number;
  amountMinor: number;
  bowlerIds: number[];
  timezone: string;
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
        headers: { "Content-Type": "application/json" },
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
            <span className="flex-1">Bowler {row.bowlerId} · {row.dueAt ? formatOccurrenceDueDate(row.dueAt, timezone) : "No due date"} · outstanding ${formatMinorUnitsAsDollars(row.outstandingMinor)}</span>
            {selected > 0 && <input aria-label={`Amount for obligation ${row.obligationId}`} className="w-24 rounded border px-2 py-1" type="text" inputMode="decimal" maxLength={24} value={formatMinorUnitsAsDollars(selected)} onChange={(event) => setSelections((current) => {
              const parsed = parseCurrencyToMinorUnits(event.target.value);
              if (parsed === null) return current;
              return { ...current, [row.obligationId]: Math.min(parsed, row.outstandingMinor, amountMinor) };
            })} />}
          </label>
        );
      })}
      <p className={selectedTotal === amountMinor ? "text-sm text-muted-foreground" : "text-sm text-destructive"} data-testid="occurrence-quote-total">Selected ${formatMinorUnitsAsDollars(selectedTotal)} of ${formatMinorUnitsAsDollars(amountMinor)}</p>
    </section>
  );
}
