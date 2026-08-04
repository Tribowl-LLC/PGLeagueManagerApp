import { AlertTriangle, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { PaymentDisputeState, PaymentRowDisputeSummary } from "@shared/schema";

export const SQUARE_DISPUTES_DASHBOARD_URL = "https://squareup.com/dashboard/sales/disputes";

const TERMINAL_STATES = new Set<PaymentDisputeState>([
  "INQUIRY_CLOSED",
  "WON",
  "LOST",
  "ACCEPTED",
]);

const STATE_LABELS: Record<PaymentDisputeState, string> = {
  INQUIRY_EVIDENCE_REQUIRED: "Inquiry evidence required",
  INQUIRY_PROCESSING: "Inquiry processing",
  INQUIRY_CLOSED: "Inquiry closed",
  EVIDENCE_REQUIRED: "Evidence required",
  PROCESSING: "Processing",
  WON: "Won",
  LOST: "Lost",
  ACCEPTED: "Dispute accepted",
};

function formatLabel(value: string): string {
  return value.toLowerCase().split("_").map((part) => (
    part.length > 0 ? `${part[0].toUpperCase()}${part.slice(1)}` : part
  )).join(" ");
}

function formatMoney(amountMinor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency })
      .format(amountMinor / 100);
  } catch {
    return `${currency} ${(amountMinor / 100).toFixed(2)}`;
  }
}

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

export function PaymentDisputeBadge({ dispute }: { dispute: PaymentRowDisputeSummary }) {
  return (
    <Badge variant={TERMINAL_STATES.has(dispute.state) ? "secondary" : "destructive"}>
      Dispute: {STATE_LABELS[dispute.state]}
    </Badge>
  );
}

function ResponseDeadline({ dispute }: { dispute: PaymentRowDisputeSummary }) {
  if (TERMINAL_STATES.has(dispute.state) || !dispute.responseDueAt) {
    return <span className="text-muted-foreground">—</span>;
  }
  const deadline = new Date(dispute.responseDueAt);
  const remainingMs = deadline.getTime() - Date.now();
  const overdue = remainingMs < 0;
  const soon = !overdue && remainingMs <= 72 * 60 * 60 * 1000;
  return (
    <div className={overdue ? "text-destructive" : soon ? "text-amber-700" : ""}>
      <div className="flex items-center gap-1.5 font-medium">
        {(overdue || soon) && <AlertTriangle className="size-4" aria-hidden="true" />}
        {formatDateTime(dispute.responseDueAt)}
      </div>
      {(overdue || soon) && (
        <div className="mt-0.5 text-xs">
          {overdue ? "Square response deadline passed" : "Square response deadline approaching"}
        </div>
      )}
    </div>
  );
}

export function PaymentDisputeDetails({ dispute }: { dispute: PaymentRowDisputeSummary }) {
  return (
    <section className="rounded-md border border-destructive/30 bg-destructive/5 p-4" data-testid={`payment-dispute-details-${dispute.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">Square dispute</div>
          <div className="mt-1 font-mono text-xs break-all">Reference: {dispute.providerDisputeId}</div>
        </div>
        <a
          className="inline-flex items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline"
          href={SQUARE_DISPUTES_DASHBOARD_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open Square Disputes <ExternalLink className="size-4" aria-hidden="true" />
        </a>
      </div>

      {dispute.sharedTransaction && (
        <div className="mt-4 rounded-md border border-amber-400/60 bg-amber-50 p-3 text-sm text-amber-950">
          This disputed amount applies to the shared Square transaction. It is shown on every linked payment allocation and is not assigned to this bowler alone.
        </div>
      )}

      <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <div><dt className="text-xs text-muted-foreground">Current Square state</dt><dd className="mt-1"><PaymentDisputeBadge dispute={dispute} /></dd></div>
        <div><dt className="text-xs text-muted-foreground">Disputed amount</dt><dd className="mt-1 font-medium">{formatMoney(dispute.amountMinor, dispute.currency)}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Reason</dt><dd className="mt-1 font-medium">{formatLabel(dispute.reason)}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Response deadline</dt><dd className="mt-1"><ResponseDeadline dispute={dispute} /></dd></div>
        <div><dt className="text-xs text-muted-foreground">Last provider update</dt><dd className="mt-1 font-medium">{formatDateTime(dispute.providerUpdatedAt)}</dd></div>
      </dl>

      <div className="mt-5 border-t pt-4">
        <h4 className="text-sm font-semibold">Sanitized state history</h4>
        {dispute.history.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            No immutable notification history is available. This dispute may predate notification retention.
          </p>
        ) : (
          <ol className="mt-2 space-y-2" aria-label="Sanitized dispute state history">
            {dispute.history.map((item) => (
              <li key={`${item.providerVersion}-${item.recordedAt}`} className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-background p-3 text-sm">
                <div>
                  <span className="font-medium">{item.kind === "DISPUTE_CREATED" ? "Dispute created" : "Dispute state updated"}</span>
                  <span className="ml-2 text-muted-foreground">Version {item.providerVersion} · {formatDateTime(item.recordedAt)}</span>
                </div>
                <Badge variant="outline">{STATE_LABELS[item.state]}</Badge>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
