import { useState } from "react";
import type { CanonicalPaymentRow, CanonicalPaymentTiming } from "@shared/canonical-payment-report";
import { csrfFetch } from "@/lib/queryClient";

type Props = {
  rows: CanonicalPaymentRow[];
  mode?: string;
  paymentTiming?: CanonicalPaymentTiming;
  organizationId?: number | null;
  title?: string;
};

/**
 * The F5 projection is deliberately rendered as evidence rows.  In
 * particular, a row with no payment id is still a real unresolved/legacy
 * operation participant and must not be converted into a synthetic Payment.
 */
export function CanonicalPaymentEvidenceTable({ rows, mode, paymentTiming, organizationId, title = "Payment evidence" }: Props) {
  const [receiptLoading, setReceiptLoading] = useState<number | null>(null);
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
  return (
    <section aria-label={title} data-testid="canonical-payment-evidence-table" className="space-y-2">
      <div className="text-sm font-medium">{title}{mode ? ` · ${mode}` : ""}</div>
      {paymentTiming && <div className="text-xs text-muted-foreground" data-testid="payment-timing">
        {paymentTiming.paymentMode === "upfront" ? "Upfront payment" : "Weekly payment"}
        {paymentTiming.upfrontDueAt ? ` · due ${paymentTiming.upfrontDueAtLocal ?? paymentTiming.upfrontDueAt}` : ""}
        {` · ${paymentTiming.source === "canonical_activation" ? "canonical activation" : "legacy league timing"}`}
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
            </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
