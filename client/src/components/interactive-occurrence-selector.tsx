import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatInTimeZone } from "date-fns-tz";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { csrfFetch } from "@/lib/queryClient";

type Selection = { obligationId: string; amountMinor: number };
type QuoteRow = { obligationId: string; bowlerId: number; amountMinor: number; outstandingMinor: number; dueAt: string | null };
type Quote = { rows: QuoteRow[]; fingerprint: string; reservedByReadyAutopayPlan?: Array<{ obligationId: string; amountMinor: number; disposition: "reserved_by_ready_autopay_plan" }> };
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

/** Editable values omit grouping separators accepted nowhere by the parser. */
export function formatMinorUnitsAsEditableDollars(amountMinor: number): string {
  const safeAmount = Number.isSafeInteger(amountMinor) && amountMinor >= 0 ? amountMinor : 0;
  return `${Math.floor(safeAmount / 100)}.${String(safeAmount % 100).padStart(2, "0")}`;
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
  // Keep the editable dollar draft independent from validated minor-unit
  // selections so clear/backspace and other intermediate keystrokes do not
  // get reformatted or emitted as payment allocations.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
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
    setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([id]) => valid.has(id))));
  }, [query.data]);

  useEffect(() => {
    const next = Object.entries(selections)
      .filter(([, value]) => Number.isSafeInteger(value) && value > 0)
      .map(([obligationId, value]) => ({ obligationId, amountMinor: value }));
    onChange(next, query.data?.fingerprint);
  }, [onChange, query.data?.fingerprint, selections]);

  const selectedTotal = Object.values(selections).reduce((sum, value) => sum + value, 0);
  const invalidDraft = (query.data?.rows ?? []).some((row) => {
    if (!Object.prototype.hasOwnProperty.call(drafts, row.obligationId)) return false;
    const parsed = parseCurrencyToMinorUnits(drafts[row.obligationId]);
    return parsed === null || parsed > Math.min(row.outstandingMinor, amountMinor);
  });
  const readiness: InteractiveOccurrenceReadiness = !enabled || amountMinor <= 0 || payees.length === 0
    ? 'disabled'
    : query.isLoading || query.fetchStatus === 'fetching'
      ? 'loading'
      : query.error
        ? 'error'
        : !query.data
          ? 'legacy'
          : invalidDraft
            ? 'empty'
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
  const readyAutopayReservations = query.data.reservedByReadyAutopayPlan ?? [];
  const readyAutopayReservedMinor = readyAutopayReservations.reduce((sum, row) => sum + row.amountMinor, 0);

  return (
    <section id="interactive-occurrence-selector" aria-label="Payment obligations" className="space-y-3 rounded-md border p-4" data-testid="interactive-occurrence-selector">
      <div>
        <h3 className="font-medium">Choose what this payment covers</h3>
        <p className="text-sm text-muted-foreground">Select specific obligations. Partial amounts and future prepayments are allowed.</p>
      </div>
      {readyAutopayReservations.length > 0 && <Alert data-testid="ready-autopay-reservation"><AlertDescription>
        Exact amount{readyAutopayReservations.length === 1 ? "" : "s"} totaling ${formatMinorUnitsAsDollars(readyAutopayReservedMinor)} {readyAutopayReservations.length === 1 ? "is" : "are"} reserved by a ready automatic plan. Manual collection requires cancelling or superseding that plan first.
      </AlertDescription></Alert>}
      {query.data.rows.map((row) => {
        const selected = selections[row.obligationId] ?? 0;
        const active = Object.prototype.hasOwnProperty.call(drafts, row.obligationId);
        const draft = drafts[row.obligationId] ?? formatMinorUnitsAsEditableDollars(selected);
        const maxMinor = Math.min(row.outstandingMinor, amountMinor);
        return (
          <label key={row.obligationId} className="flex items-center gap-3 text-sm">
            <input type="checkbox" checked={active} onChange={(event) => {
              if (event.target.checked) {
                const initial = Math.min(row.outstandingMinor, amountMinor);
                setSelections((current) => ({ ...current, [row.obligationId]: initial }));
                setDrafts((current) => ({ ...current, [row.obligationId]: formatMinorUnitsAsEditableDollars(initial) }));
              } else {
                setSelections((current) => { const next = { ...current }; delete next[row.obligationId]; return next; });
                setDrafts((current) => { const next = { ...current }; delete next[row.obligationId]; return next; });
              }
            }} />
            <span className="flex-1">Bowler {row.bowlerId} · {row.dueAt ? formatOccurrenceDueDate(row.dueAt, timezone) : "No due date"} · outstanding ${formatMinorUnitsAsDollars(row.outstandingMinor)}</span>
            {active && <input aria-label={`Amount for obligation ${row.obligationId}`} className="w-24 rounded border px-2 py-1" type="text" inputMode="decimal" maxLength={24} value={draft} onChange={(event) => {
              const raw = event.target.value;
              setDrafts((current) => ({ ...current, [row.obligationId]: raw }));
              const parsed = parseCurrencyToMinorUnits(raw);
              if (parsed !== null && parsed > 0 && parsed <= maxMinor) {
                setSelections((current) => ({ ...current, [row.obligationId]: parsed }));
              }
            }} onBlur={() => {
              const parsed = parseCurrencyToMinorUnits(drafts[row.obligationId] ?? "");
              const bounded = parsed === null ? selected : Math.min(parsed, maxMinor);
              if (bounded > 0) {
                setSelections((current) => ({ ...current, [row.obligationId]: bounded }));
                setDrafts((current) => ({ ...current, [row.obligationId]: formatMinorUnitsAsEditableDollars(bounded) }));
              } else {
                setSelections((current) => { const next = { ...current }; delete next[row.obligationId]; return next; });
                setDrafts((current) => { const next = { ...current }; delete next[row.obligationId]; return next; });
              }
            }} />}
          </label>
        );
      })}
      <p className={selectedTotal === amountMinor ? "text-sm text-muted-foreground" : "text-sm text-destructive"} data-testid="occurrence-quote-total">Selected ${formatMinorUnitsAsDollars(selectedTotal)} of ${formatMinorUnitsAsDollars(amountMinor)}</p>
    </section>
  );
}
