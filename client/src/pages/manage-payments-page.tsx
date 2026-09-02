import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "wouter";
import { AlertCircle, ArrowLeft, CheckCircle2, Loader2 } from "lucide-react";
import { Layout } from "@/components/layout";
import { ErrorBoundary } from "@/components/error-boundary";
import { PageErrorState, PageLoadingState } from "@/components/page-states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { csrfFetch } from "@/lib/queryClient";
import { beginPaymentIntent, clearPaymentIntent } from "@/lib/payment-request-identity";
import { useToast } from "@/hooks/use-toast";
import type { ApiResponse, BowlerLeague, League, Team } from "@shared/schema";
import type { CanonicalDuePastDueResponseV2 } from "@shared/roster-payment-contract";

export type EnrichedMembership = BowlerLeague & {
  bowler: { id: number; name: string; active: boolean; email: string | null } | null;
  team: Pick<Team, "id" | "name" | "number" | "active" | "leagueId" | "displayOrder"> | null;
};

export type RosterResponse = {
  teams: Array<{
    id: number;
    name: string;
    number: number;
    slots: Array<{ slotIndex: number; occupant: "main" | "vacant" | "unassigned"; mainBowlerId: number | null }>;
  }>;
};

type RowResult = "idle" | "pending" | "success" | "failure";

export type PaymentRow = {
  key: string;
  bowlerId: number;
  bowlerName: string;
  teamId: number;
  teamName: string;
  teamNumber: number;
  balanceMinor: number;
  oldestDueAt: string | null;
  reviewRequired: boolean;
};

type RowValues = {
  amount: string;
  type: "cash" | "check";
  checkNumber: string;
  notes: string;
  /** Browser storage scope for this exact row intent. It is deliberately
   * per-row; a batch has no shared retry identity. */
  intentScope: string | null;
  requestKey: string | null;
  fingerprint: string | null;
  retryLocked: boolean;
  result: RowResult;
  error: string | null;
};

const emptyValues = (): RowValues => ({
  amount: "",
  type: "cash",
  checkNumber: "",
  notes: "",
  intentScope: null,
  requestKey: null,
  fingerprint: null,
  retryLocked: false,
  result: "idle",
  error: null,
});

function parseAmountMinor(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(trimmed)) return null;
  const amount = Number(trimmed);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const amountMinor = Math.round(amount * 100);
  return Number.isSafeInteger(amountMinor) && amountMinor > 0 ? amountMinor : null;
}

function errorFromBody(body: { error?: { message?: string }; message?: string; data?: unknown } | null, fallback: string, status?: number): Error {
  return new Error(body?.error?.message || body?.message || `${fallback}${status ? ` (${status})` : ""}`);
}

function isAmbiguousRecordFailure(status: number, code?: string): boolean {
  return status >= 500 || code === "INTERNAL_ERROR";
}

function formatMoney(amountMinor: number): string {
  return `$${(amountMinor / 100).toFixed(2)}`;
}

export function buildPaymentIntentScope(
  leagueId: number,
  bowlerId: number,
  amountMinor: number,
  type: "cash" | "check",
  checkNumber: string,
  notes: string,
): string {
  return JSON.stringify({
    version: 1,
    kind: "manage-manual-payment",
    leagueId,
    bowlerId,
    amountMinor,
    type,
    checkNumber,
    notes,
  });
}

export function formatDueDate(value: string | null, timezone: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: timezone ?? "UTC" }).format(date);
  } catch {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" }).format(date);
  }
}

/** Build the visible operator rows from active league memberships. Canonical
 * due rows supply balance truth; membership/team data supplies only display
 * identity and grouping. Vacant slots have no membership and therefore never
 * become payment rows. */
export function buildManagePaymentRows(
  memberships: EnrichedMembership[],
  due: CanonicalDuePastDueResponseV2 | undefined,
  roster: RosterResponse | undefined,
): PaymentRow[] {
  const balanceByBowler = new Map<number, { balanceMinor: number; oldestDueAt: string | null; reviewRequired: boolean }>();
  for (const row of due?.rows ?? []) {
    if (row.outstandingMinor <= 0 || row.state === "voided") continue;
    const previous = balanceByBowler.get(row.payerBowlerId);
    const currentDue = previous?.oldestDueAt;
    const rowDue = row.dueAt;
    balanceByBowler.set(row.payerBowlerId, {
      balanceMinor: (previous?.balanceMinor ?? 0) + row.outstandingMinor,
      oldestDueAt: !currentDue || rowDue < currentDue ? rowDue : currentDue,
      reviewRequired: (previous?.reviewRequired ?? false) || row.reviewRequired,
    });
  }

  const teamNames = new Map((roster?.teams ?? []).map((team) => [team.id, team]));
  const seenBowlerIds = new Set<number>();
  return memberships
    .filter((membership) => membership.active && membership.bowler?.active && membership.team?.active)
    .filter((membership) => {
      const team = membership.team;
      return !!team && teamNames.size > 0 ? teamNames.has(team.id) : !!team;
    })
    .sort((left, right) => {
      const leftTeam = left.team;
      const rightTeam = right.team;
      if (!leftTeam || !rightTeam) return leftTeam ? -1 : rightTeam ? 1 : 0;
      return (teamNames.get(leftTeam.id)?.number ?? leftTeam.number) - (teamNames.get(rightTeam.id)?.number ?? rightTeam.number)
        || (teamNames.get(leftTeam.id)?.name ?? leftTeam.name).localeCompare(teamNames.get(rightTeam.id)?.name ?? rightTeam.name)
        || left.bowlerId - right.bowlerId
        || left.id - right.id;
    })
    .flatMap((membership) => {
      const bowler = membership.bowler;
      const team = membership.team;
      if (!bowler || !team) return [];
      if (seenBowlerIds.has(bowler.id)) return [];
      seenBowlerIds.add(bowler.id);
      const balance = balanceByBowler.get(bowler.id);
      return [{
        key: String(bowler.id),
        bowlerId: bowler.id,
        bowlerName: bowler.name,
        teamId: team.id,
        teamName: teamNames.get(team.id)?.name ?? team.name,
        teamNumber: teamNames.get(team.id)?.number ?? team.number,
        balanceMinor: balance?.balanceMinor ?? 0,
        oldestDueAt: balance?.oldestDueAt ?? null,
        reviewRequired: balance?.reviewRequired ?? false,
      }];
    })
    .sort((a, b) => a.teamNumber - b.teamNumber || a.teamName.localeCompare(b.teamName) || a.bowlerName.localeCompare(b.bowlerName) || a.bowlerId - b.bowlerId);
}

export default function ManagePaymentsPage() {
  const params = useParams();
  const leagueId = Number(params.leagueId);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const activeSubmissions = useRef(new Set<number>());
  const [rowValues, setRowValues] = useState<Record<string, RowValues>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const leagueQuery = useQuery<ApiResponse<League>>({
    queryKey: [`/api/leagues/${leagueId}`],
    enabled: Number.isSafeInteger(leagueId) && leagueId > 0,
    retry: false,
  });
  const rosterQuery = useQuery<ApiResponse<RosterResponse>>({
    queryKey: [`/api/financials/leagues/${leagueId}/roster-payment-responsibility/1`],
    enabled: Number.isSafeInteger(leagueId) && leagueId > 0,
    retry: false,
  });
  const membershipQuery = useQuery<ApiResponse<EnrichedMembership[]>>({
    queryKey: [`/api/bowler-leagues?leagueId=${leagueId}&enriched=true`],
    enabled: Number.isSafeInteger(leagueId) && leagueId > 0,
    retry: false,
  });
  const dueQuery = useQuery<ApiResponse<CanonicalDuePastDueResponseV2>>({
    queryKey: [`/api/financials/leagues/${leagueId}/canonical-due-past-due/2`],
    enabled: Number.isSafeInteger(leagueId) && leagueId > 0,
    retry: false,
  });

  const rows = useMemo(() => buildManagePaymentRows(
    membershipQuery.data?.data ?? [],
    dueQuery.data?.data,
    rosterQuery.data?.data,
  ), [membershipQuery.data?.data, dueQuery.data?.data, rosterQuery.data?.data]);

  const valuesFor = (key: string): RowValues => rowValues[key] ?? emptyValues();

  const updateRow = (key: string, update: Partial<RowValues>) => {
    setRowValues((current) => ({
      ...current,
      [key]: { ...(current[key] ?? emptyValues()), ...update },
    }));
  };

  const editRow = (key: string, update: Partial<RowValues>) => {
    const current = valuesFor(key);
    // A business or validation edit starts a new exact intent. Remove the
    // old per-row browser key so a later entry with the same values cannot
    // accidentally inherit an abandoned command. A transport-unknown row is
    // intentionally not editable until its exact key has been retried.
    if (!current.retryLocked && current.intentScope) clearPaymentIntent(current.intentScope);
    updateRow(key, { ...update, intentScope: null, requestKey: null, fingerprint: null, retryLocked: false, result: "idle", error: null });
  };

  const submitPayments = async (onlyKeys?: ReadonlySet<string>) => {
    if (isSubmitting) return;
    const candidates = rows.filter((row) => {
      const values = valuesFor(row.key);
      return values.amount.trim()
        && (!onlyKeys || onlyKeys.has(row.key))
        && values.result !== "success"
        && values.result !== "pending"
        && !activeSubmissions.current.has(row.bowlerId);
    });
    if (candidates.length === 0) return;
    setIsSubmitting(true);
    for (const row of candidates) {
      activeSubmissions.current.add(row.bowlerId);
      updateRow(row.key, { result: "pending", error: null });
    }

    type PreparedRow = PaymentRow & { values: RowValues; amountMinor: number; requestKey: string; fingerprint: string | null; intentScope: string };
    const prepared: PreparedRow[] = [];
    for (const row of candidates) {
      const values = valuesFor(row.key);
      const amountMinor = parseAmountMinor(values.amount);
      if (amountMinor === null) {
        if (values.intentScope) clearPaymentIntent(values.intentScope);
        updateRow(row.key, { result: "failure", error: "Enter a valid positive amount in dollars.", intentScope: null, requestKey: null, fingerprint: null, retryLocked: false });
        activeSubmissions.current.delete(row.bowlerId);
        continue;
      }
      if (values.type === "check" && !values.checkNumber.trim()) {
        if (values.intentScope) clearPaymentIntent(values.intentScope);
        updateRow(row.key, { result: "failure", error: "A check number is required for check payments.", intentScope: null, requestKey: null, fingerprint: null, retryLocked: false });
        activeSubmissions.current.delete(row.bowlerId);
        continue;
      }
      const scope = buildPaymentIntentScope(leagueId, row.bowlerId, amountMinor, values.type, values.checkNumber.trim(), values.notes.trim());
      const intentScope = values.intentScope ?? scope;
      const requestKey = values.requestKey ?? beginPaymentIntent(intentScope);
      updateRow(row.key, { intentScope, requestKey });
      prepared.push({ ...row, values, amountMinor, requestKey, fingerprint: values.fingerprint, intentScope });
    }

    const quotedRows = prepared.filter((row) => !row.fingerprint).map((row) => ({ rowKey: row.requestKey, amountMinor: row.amountMinor, payerBowlerId: row.bowlerId }));
    const quoteResults = new Map<string, { fingerprint: string; payerBowlerId: number }>();
    if (quotedRows.length > 0) {
      try {
        const quoteResponse = await csrfFetch(`/api/financials/leagues/${leagueId}/canonical/manual-record-batch/quote/1`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rows: quotedRows }),
        });
        const quoteBody = await quoteResponse.json().catch(() => null) as { data?: { rows?: Array<{ rowKey: string; success: boolean; data?: { fingerprint?: string; payerBowlerId?: number }; error?: { message?: string } }> } } | null;
        if (!quoteResponse.ok) throw errorFromBody(quoteBody, "Payment quotes are unavailable", quoteResponse.status);
        if (!quoteBody?.data?.rows) throw new Error("Payment quotes are unavailable");
        for (const result of quoteBody.data.rows) {
          const row = prepared.find((candidate) => candidate.requestKey === result.rowKey);
          if (!row) continue;
          if (result.success && result.data?.fingerprint && result.data.payerBowlerId) {
            quoteResults.set(result.rowKey, { fingerprint: result.data.fingerprint, payerBowlerId: result.data.payerBowlerId });
            updateRow(row.key, { fingerprint: result.data.fingerprint });
          } else {
            if (row.intentScope) clearPaymentIntent(row.intentScope);
            updateRow(row.key, { result: "failure", error: result.error?.message || "Payment quote is unavailable.", intentScope: null, requestKey: null, fingerprint: null, retryLocked: false });
            activeSubmissions.current.delete(row.bowlerId);
          }
        }
      } catch (error) {
        for (const row of prepared.filter((candidate) => !candidate.fingerprint)) {
          if (row.intentScope) clearPaymentIntent(row.intentScope);
          updateRow(row.key, { result: "failure", error: error instanceof Error ? error.message : "Payment quotes are unavailable.", intentScope: null, requestKey: null, fingerprint: null, retryLocked: false });
          activeSubmissions.current.delete(row.bowlerId);
        }
      }
    }

    const recordableRows = prepared.flatMap((row) => {
      if (!activeSubmissions.current.has(row.bowlerId)) return [];
      const quote = row.fingerprint ? { fingerprint: row.fingerprint, payerBowlerId: row.bowlerId } : quoteResults.get(row.requestKey);
      if (!quote) {
        if (row.intentScope) clearPaymentIntent(row.intentScope);
        updateRow(row.key, { result: "failure", error: "Payment quote is unavailable.", intentScope: null, requestKey: null, fingerprint: null, retryLocked: false });
        activeSubmissions.current.delete(row.bowlerId);
        return [];
      }
      return [{
        row,
        request: {
          rowKey: row.requestKey,
          amountMinor: row.amountMinor,
          payerBowlerId: quote.payerBowlerId,
          type: row.values.type,
          checkNumber: row.values.type === "check" ? row.values.checkNumber.trim() : undefined,
          notes: row.values.notes.trim() || null,
          idempotencyKey: row.requestKey,
          requestFingerprint: quote.fingerprint,
        },
      }];
    });
    let succeededCount = 0;
    if (recordableRows.length > 0) {
      try {
        const response = await csrfFetch(`/api/financials/leagues/${leagueId}/canonical/manual-record-batch/1`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rows: recordableRows.map(({ request }) => request) }),
        });
        const body = await response.json().catch(() => null) as { data?: { rows?: Array<{ rowKey: string; success: boolean; error?: { code?: string; message?: string } }> } } | null;
        if (!response.ok) {
          const responseError = errorFromBody(body, "Payments could not be recorded", response.status);
          const preserveIntent = isAmbiguousRecordFailure(response.status);
          for (const { row } of recordableRows) {
            if (!preserveIntent && row.intentScope) clearPaymentIntent(row.intentScope);
            updateRow(row.key, preserveIntent
              ? { result: "failure", error: responseError.message, retryLocked: true }
              : { result: "failure", error: responseError.message, intentScope: null, requestKey: null, fingerprint: null, retryLocked: false });
            activeSubmissions.current.delete(row.bowlerId);
          }
        } else {
          if (!body?.data?.rows) throw new Error("Payment result is unknown; retry to confirm.");
          const resultByKey = new Map(body.data.rows.map((result) => [result.rowKey, result]));
          for (const { row } of recordableRows) {
            const result = resultByKey.get(row.requestKey);
            if (result?.success) {
              succeededCount += 1;
              if (row.intentScope) clearPaymentIntent(row.intentScope);
              updateRow(row.key, { amount: "", checkNumber: "", notes: "", intentScope: null, requestKey: null, fingerprint: null, retryLocked: false, result: "success", error: null });
            } else {
              const errorCode = result?.error?.code;
              const preserveIntent = isAmbiguousRecordFailure(response.status, errorCode);
              if (!preserveIntent && row.intentScope) clearPaymentIntent(row.intentScope);
              updateRow(row.key, preserveIntent
                ? { result: "failure", error: result?.error?.message || "Payment result is unknown; retry to confirm.", retryLocked: true }
                : { result: "failure", error: result?.error?.message || "Payment could not be recorded.", intentScope: null, requestKey: null, fingerprint: null, retryLocked: false });
            }
            activeSubmissions.current.delete(row.bowlerId);
          }
        }
      } catch (error) {
        for (const { row } of recordableRows) {
          // No per-row result arrived, so the server may have committed some
          // rows before the response was lost. Keep each exact intent and
          // quote locked until an idempotent retry confirms its outcome.
          updateRow(row.key, { result: "failure", error: error instanceof Error ? error.message : "Payment result is unknown; retry to confirm.", retryLocked: true });
          activeSubmissions.current.delete(row.bowlerId);
        }
      }
    }
    if (succeededCount > 0) {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/canonical-due-past-due/2`] }),
        queryClient.invalidateQueries({ queryKey: ["/api/financials/f5/payments"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/payments"] }),
      ]);
      toast({ title: "Payments recorded", description: `${succeededCount} payment${succeededCount === 1 ? "" : "s"} recorded successfully.` });
    }
    setIsSubmitting(false);
  };

  const loading = leagueQuery.isLoading || rosterQuery.isLoading || membershipQuery.isLoading || dueQuery.isLoading;
  const queryError = leagueQuery.error || rosterQuery.error || membershipQuery.error || dueQuery.error;
  if (loading) return <Layout><PageLoadingState /></Layout>;
  if (queryError || !leagueQuery.data?.data || !rosterQuery.data?.data || !membershipQuery.data?.data || !dueQuery.data?.data) {
    return <Layout><PageErrorState message="Payment balances could not be loaded." onRetry={() => { void leagueQuery.refetch(); void rosterQuery.refetch(); void membershipQuery.refetch(); void dueQuery.refetch(); }} /></Layout>;
  }

  const grouped = rows.reduce((groups, row) => {
    const group = groups.get(row.teamId) ?? { name: row.teamName, number: row.teamNumber, rows: [] as PaymentRow[] };
    group.rows.push(row);
    groups.set(row.teamId, group);
    return groups;
  }, new Map<number, { name: string; number: number; rows: PaymentRow[] }>());
  const hasEntries = rows.some((row) => valuesFor(row.key).amount.trim() && valuesFor(row.key).result !== "success");

  return (
    <Layout>
      <ErrorBoundary level="section">
        <div className="space-y-6">
          <Link href={`/leagues/${leagueId}`} className="flex items-center text-muted-foreground hover:text-foreground">
            <ArrowLeft className="mr-2 size-4" />
            Back to {rosterQuery.data.data.teams.length > 0 ? "league" : "League"}
          </Link>
          <div>
            <h1 className="text-2xl font-bold">Manage Payments</h1>
            <p className="mt-1 text-muted-foreground">Record cash or check payments. Amounts are allocated automatically to the oldest eligible obligations.</p>
            <p className="mt-1 text-sm text-muted-foreground">Payments are timestamped when submitted; there is no week selector or backdating.</p>
          </div>

          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Team</TableHead>
                  <TableHead>Bowler</TableHead>
                  <TableHead>Oldest open obligation</TableHead>
                  <TableHead>Remaining balance</TableHead>
                  <TableHead>Amount ($)</TableHead>
                  <TableHead>Payment method</TableHead>
                  <TableHead>Check number</TableHead>
                  <TableHead>Notes</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow><TableCell colSpan={9} className="py-8 text-center text-muted-foreground">No active roster bowlers found.</TableCell></TableRow>
                ) : [...grouped.values()].map((group) => (
                  group.rows.map((row, index) => {
                    const values = valuesFor(row.key);
                    const disabled = row.balanceMinor <= 0 || row.reviewRequired || values.result === "pending" || values.result === "success" || values.retryLocked;
                    return (
                      <TableRow key={row.key} className={disabled && row.balanceMinor <= 0 ? "opacity-60" : undefined}>
                        {index === 0 ? <TableCell rowSpan={group.rows.length} className="align-top font-medium">{group.number} · {group.name}</TableCell> : null}
                        <TableCell className="font-medium">{row.bowlerName}</TableCell>
                        <TableCell>{row.reviewRequired ? "Review required" : formatDueDate(row.oldestDueAt, leagueQuery.data.data.timezone)}</TableCell>
                        <TableCell>{formatMoney(row.balanceMinor)}</TableCell>
                        <TableCell>
                          <label className="sr-only" htmlFor={`payment-amount-${row.key}`}>Amount paid by {row.bowlerName}</label>
                          <Input id={`payment-amount-${row.key}`} aria-label={`Amount paid by ${row.bowlerName}`} type="number" inputMode="decimal" min="0" step="0.01" placeholder="0.00" value={values.amount} disabled={disabled} onChange={(event) => editRow(row.key, { amount: event.target.value })} className="w-28" />
                        </TableCell>
                        <TableCell>
                          <label className="sr-only" htmlFor={`payment-type-${row.key}`}>Payment method for {row.bowlerName}</label>
                          <select id={`payment-type-${row.key}`} aria-label={`Payment method for ${row.bowlerName}`} value={values.type} disabled={disabled} onChange={(event) => editRow(row.key, { type: event.target.value as "cash" | "check" })} className="h-10 rounded-md border border-input bg-background px-2 text-sm">
                            <option value="cash">Cash</option>
                            <option value="check">Check</option>
                          </select>
                        </TableCell>
                        <TableCell>
                          <label className="sr-only" htmlFor={`payment-check-${row.key}`}>Check number for {row.bowlerName}</label>
                          <Input id={`payment-check-${row.key}`} aria-label={`Check number for ${row.bowlerName}`} placeholder={values.type === "check" ? "Required" : "—"} value={values.checkNumber} disabled={disabled || values.type !== "check"} onChange={(event) => editRow(row.key, { checkNumber: event.target.value })} className="w-28" />
                        </TableCell>
                        <TableCell>
                          <label className="sr-only" htmlFor={`payment-notes-${row.key}`}>Notes for {row.bowlerName}</label>
                          <Textarea id={`payment-notes-${row.key}`} aria-label={`Notes for ${row.bowlerName}`} placeholder="Optional" value={values.notes} disabled={disabled} onChange={(event) => editRow(row.key, { notes: event.target.value })} className="min-h-10 w-36" />
                        </TableCell>
                        <TableCell className="min-w-48">
                          {values.result === "pending" && <span className="flex items-center gap-1 text-muted-foreground" role="status"><Loader2 className="size-4 animate-spin" /> Recording…</span>}
                          {values.result === "success" && <span className="flex items-center gap-1 text-green-600" role="status"><CheckCircle2 className="size-4" /> Recorded</span>}
                          {values.result === "failure" && <span className="flex flex-col items-start gap-1 text-destructive" role="alert">
                            <span className="flex items-start gap-1"><AlertCircle className="mt-0.5 size-4 shrink-0" /> <span>{values.error}</span></span>
                            {values.retryLocked && <Button type="button" variant="link" className="h-auto p-0 text-xs" onClick={() => void submitPayments(new Set([row.key]))} disabled={isSubmitting}>Retry exact payment</Button>}
                          </span>}
                          {values.result === "idle" && row.balanceMinor <= 0 && <span className="text-muted-foreground">No balance</span>}
                          {values.result === "idle" && row.balanceMinor > 0 && row.reviewRequired && <span className="text-muted-foreground">Review required</span>}
                        </TableCell>
                      </TableRow>
                    );
                  })
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-end gap-3">
            <Button type="button" onClick={() => void submitPayments()} disabled={isSubmitting || !hasEntries}>
              {isSubmitting && <Loader2 className="mr-2 size-4 animate-spin" />}
              Record Payments
            </Button>
          </div>
        </div>
      </ErrorBoundary>
    </Layout>
  );
}
