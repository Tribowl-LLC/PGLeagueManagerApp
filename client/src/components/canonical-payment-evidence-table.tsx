import { useState } from "react";
import type { CanonicalPaymentRow, CanonicalPaymentTiming } from "@shared/canonical-payment-report";
import { csrfFetch } from "@/lib/queryClient";

type Props = {
  rows: CanonicalPaymentRow[];
  mode?: string;
  paymentTiming?: CanonicalPaymentTiming;
  organizationId?: number | null;
  title?: string;
  canCorrect?: boolean;
};

/** Convert the operator-facing dollar amount to exact USD minor units. */
export function dollarsToMinorUnits(value: string): number | null {
  const normalized = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(normalized)) return null;
  const [wholeText, fractionText = ""] = normalized.split(".");
  const whole = Number(wholeText);
  const minor = whole * 100 + Number(fractionText.padEnd(2, "0"));
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}

/**
 * The F5 projection is deliberately rendered as evidence rows.  In
 * particular, a row with no payment id is still a real unresolved/legacy
 * operation participant and must not be converted into a synthetic Payment.
 */
export function CanonicalPaymentEvidenceTable({ rows, mode, paymentTiming, organizationId, title = "Payment evidence", canCorrect = false }: Props) {
  const [receiptLoading, setReceiptLoading] = useState<number | null>(null);
  const [editingPaymentId, setEditingPaymentId] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [correctionBusy, setCorrectionBusy] = useState(false);
  const [correctionError, setCorrectionError] = useState<string | null>(null);
  const openReceipt = async (paymentId: number) => {
    setReceiptLoading(paymentId);
    try {
      const scope = organizationId !== null && organizationId !== undefined ? `?organizationId=${encodeURIComponent(organizationId)}` : "";
      const response = await csrfFetch(`/api/payments-provider/payments/${paymentId}/receipt${scope}`);
      const body = await response.json() as { data?: { receiptUrl?: string | null } };
      if (response.ok && body.data?.receiptUrl) window.open(body.data.receiptUrl, "_blank", "noopener,noreferrer");
    } finally {
      setReceiptLoading(null);
    }
  };
  const correctionFingerprint = async (payload: {
    paymentId: number;
    reason: string;
  }) => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(payload)));
    return `lvcorrection:v2:${Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("")}`;
  };
  const submitCorrection = async (row: CanonicalPaymentRow) => {
    const trimmedReason = reason.trim();
    if (!trimmedReason || row.paymentId === null) return;
    setCorrectionError(null);
    setCorrectionBusy(true);
    try {
      const payload = {
        paymentId: row.paymentId,
        correctionMode: "void_only" as const,
        reason: trimmedReason,
      } as const;
      const idempotencyKey = crypto.randomUUID();
      const fingerprintPayload = {
        paymentId: row.paymentId,
        reason: trimmedReason,
      };
      const response = await csrfFetch(`/api/financials/leagues/${row.leagueId}/canonical/corrections/1`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ ...payload, idempotencyKey, requestFingerprint: await correctionFingerprint(fingerprintPayload) }),
      });
      if (!response.ok) throw new Error("Payment correction could not be recorded");
      setEditingPaymentId(null);
      setReason("");
      window.location.reload();
    } catch {
      setCorrectionError("Payment correction could not be recorded");
    } finally {
      setCorrectionBusy(false);
    }
  };
  return (
    <section aria-label={title} data-testid="canonical-payment-evidence-table" className="space-y-2">
      <div className="text-sm font-medium">{title}{mode ? ` · ${mode}` : ""}</div>
      {paymentTiming && <div className="text-xs text-muted-foreground" data-testid="payment-timing">
        {paymentTiming.paymentMode === "upfront" ? "Upfront payment" : "Weekly payment"}
        {paymentTiming.upfrontDueAt ? ` · due ${paymentTiming.upfrontDueAtLocal ?? paymentTiming.upfrontDueAt}` : ""}
        {` · timezone ${paymentTiming.timezone ?? "UTC"}`}
        {` · ${paymentTiming.source === "canonical" ? "canonical billing" : "canonical billing"}`}
      </div>}
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No payment evidence for this page.</p>
      ) : (
        <div className="divide-y rounded-md border">
          {rows.map((row, index) => {
            const paymentId = row.paymentId;
            return (
            <article key={`${row.paymentOperationId ?? row.paymentId ?? "unresolved"}:${row.bowlerId}:${index}`} className="grid gap-1 px-3 py-2 text-sm md:grid-cols-[1fr_auto_auto] md:items-center">
              <div>
                <div className="font-medium">{row.authoritativeLocalDate} · {row.source}</div>
                <div className="text-muted-foreground">
                  {row.status} · {row.unresolved ? "unresolved" : "settlement evidence"}
                  {row.reviewRequired ? " · review required" : ""}
                </div>
                <div className="text-xs text-muted-foreground">
                  {row.allocations.length > 0
                    ? row.allocations.map((allocation) => `${new Intl.NumberFormat("en-US", { style: "currency", currency: allocation.currency }).format(allocation.amountMinor / 100)} · ${allocation.state ?? "unresolved"} · occurrence ${allocation.occurrenceId ?? "unlinked"} · obligation ${allocation.obligationId ?? "unlinked"}`).join("; ")
                    : "No item allocation recorded"}
                  {row.collectionEvidence ? ` · ${row.collectionEvidence.grouping === "double_pay" ? "double-pay" : "normal"} collection · ${row.collectionEvidence.timing.replaceAll("_", " ")} · collection point ${row.collectionEvidence.collectionPointOccurrenceId} · ${row.collectionEvidence.coveredOccurrenceIds.length} covered occurrence${row.collectionEvidence.coveredOccurrenceIds.length === 1 ? "" : "s"}` : ""}
                  {row.refund.present ? ` · refunded $${(row.refund.amountMinor / 100).toFixed(2)}` : ""}
                  {row.dispute.present ? ` · dispute/review evidence${row.dispute.scope === "transaction" ? " (transaction)" : ""}${row.dispute.state ? ` · ${row.dispute.state}` : ""}${row.dispute.amountMinor > 0 ? ` · $${(row.dispute.amountMinor / 100).toFixed(2)}` : ""}` : ""}
                </div>
              </div>
              <span className="font-mono">{new Intl.NumberFormat("en-US", { style: "currency", currency: row.currency }).format(row.amountMinor / 100)}</span>
              <span className="text-xs text-muted-foreground">{row.paymentId === null ? "operation evidence" : `payment #${row.paymentId}`}</span>
              {paymentId !== null && ["confirmed_paid", "refunded", "disputed"].includes(row.status) && <button type="button" className="text-xs underline" disabled={receiptLoading === paymentId} onClick={() => void openReceipt(paymentId)}>{receiptLoading === paymentId ? "Loading receipt…" : "Receipt"}</button>}
              {canCorrect && row.paymentId !== null && ["cash", "check"].includes(row.paymentType) && row.allocations.some((allocation) => allocation.state === "active") && (
                <div className="col-span-full rounded border bg-muted/30 p-2 text-xs">
                  {editingPaymentId === row.paymentId ? <div className="grid gap-2 md:grid-cols-2">
                    <input aria-label="Correction reason" className="rounded border bg-background p-1" placeholder="Reason" value={reason} onChange={(event) => setReason(event.target.value)} />
                    {correctionError && <p role="alert" className="text-destructive">{correctionError}</p>}
                    <div className="flex gap-2"><button type="button" className="underline" disabled={correctionBusy} onClick={() => void submitCorrection(row)}>Void payment</button><button type="button" className="underline" onClick={() => setEditingPaymentId(null)}>Cancel</button></div>
                  </div> : <button type="button" className="underline" onClick={() => setEditingPaymentId(row.paymentId)}>Void cash/check payment</button>}
                </div>
              )}
            </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
