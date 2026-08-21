import type { CanonicalPaymentRow } from "@shared/canonical-payment-report";

type Props = {
  rows: CanonicalPaymentRow[];
  mode?: string;
  title?: string;
};

/**
 * The F5 projection is deliberately rendered as evidence rows.  In
 * particular, a row with no payment id is still a real unresolved/legacy
 * operation participant and must not be converted into a synthetic Payment.
 */
export function CanonicalPaymentEvidenceTable({ rows, mode, title = "Payment evidence" }: Props) {
  return (
    <section aria-label={title} data-testid="canonical-payment-evidence-table" className="space-y-2">
      <div className="text-sm font-medium">{title}{mode ? ` · ${mode}` : ""}</div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No payment evidence for this page.</p>
      ) : (
        <div className="divide-y rounded-md border">
          {rows.map((row, index) => (
            <article key={`${row.paymentOperationId ?? row.paymentId ?? "unresolved"}:${row.bowlerId}:${index}`} className="grid gap-1 px-3 py-2 text-sm md:grid-cols-[1fr_auto_auto] md:items-center">
              <div>
                <div className="font-medium">{row.authoritativeLocalDate} · {row.source}</div>
                <div className="text-muted-foreground">
                  {row.status} · {row.unresolved ? "unresolved" : "settlement evidence"}
                  {row.reviewRequired ? " · review required" : ""}
                </div>
                <div className="text-xs text-muted-foreground">
                  {row.allocations.length > 0
                    ? `${row.allocations.length} allocation${row.allocations.length === 1 ? "" : "s"} · ${row.allocatedMinor} allocated`
                    : "No item allocation recorded"}
                  {row.refund.present ? ` · refunded ${row.refund.amountMinor}` : ""}
                  {row.dispute.present ? " · dispute/review evidence" : ""}
                </div>
              </div>
              <span className="font-mono">{row.amountMinor} {row.currency}</span>
              <span className="text-xs text-muted-foreground">{row.paymentId === null ? "operation evidence" : `payment #${row.paymentId}`}</span>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
