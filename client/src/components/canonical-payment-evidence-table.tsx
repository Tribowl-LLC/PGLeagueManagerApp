import { useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { CanonicalPaymentRow, CanonicalPaymentTiming } from "@shared/canonical-payment-report";
import { PaymentDetailsDialog, paymentEvidenceDisplayStatus } from "@/components/payment-details-dialog";

type Props = {
  rows: CanonicalPaymentRow[];
  paymentTiming?: CanonicalPaymentTiming;
  organizationId?: number | null;
  bowlerName?: string;
  title?: string;
};

function formatLocalDate(value: string, timezone = "UTC"): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (match && value.length <= 10) {
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
    return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "UTC" }).format(date);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  try {
    return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: timezone }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "UTC" }).format(date);
  }
}

function paymentTypeLabel(paymentType: CanonicalPaymentRow["paymentType"]): string {
  switch (paymentType) {
    case "cash": return "Cash";
    case "check": return "Check";
    case "credit_card": return "Credit Card";
    case "square": return "Square";
  }
}

function formatCurrency(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amountMinor / 100);
}

function statusVariant(row: CanonicalPaymentRow) {
  const displayStatus = paymentEvidenceDisplayStatus(row);
  if (displayStatus === "Review required") return "destructive" as const;
  switch (row.status) {
    case "confirmed_paid": return "default" as const;
    case "pending": return "secondary" as const;
    case "failed": return "destructive" as const;
    default: return "outline" as const;
  }
}

/**
 * The F5 projection is presented as a compact payment history. Every report
 * row remains visible, including operation evidence without a payment id;
 * selecting its status opens the evidence-only details dialog.
 */
export function CanonicalPaymentEvidenceTable({ rows, paymentTiming, organizationId, bowlerName = "Bowler", title = "Payment history" }: Props) {
  const [detailsTarget, setDetailsTarget] = useState<CanonicalPaymentRow | null>(null);

  return (
    <section aria-label={title} data-testid="canonical-payment-evidence-table" className="space-y-2">
      <div className="text-sm font-medium">{title}</div>
      {paymentTiming && <div className="text-xs text-muted-foreground" data-testid="payment-timing">
        {paymentTiming.paymentMode === "upfront" ? "Upfront payment" : "Weekly payment"}
        {paymentTiming.upfrontDueAt ? ` · due ${formatLocalDate(paymentTiming.upfrontDueAtLocal ?? paymentTiming.upfrontDueAt, paymentTiming.timezone)}` : ""}
        {paymentTiming.timezone ? ` · ${paymentTiming.timezone}` : ""}
      </div>}
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No payments yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead className="hidden md:table-cell">Payment Method</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, index) => {
                const displayStatus = paymentEvidenceDisplayStatus(row);
                const reviewRequired = row.reviewRequired || row.dispute.reviewRequired === true;
                const hasSeparateReviewIndicator = reviewRequired && displayStatus !== "Review required";
                return (
                  <TableRow key={`${row.paymentOperationId ?? row.paymentId ?? "unresolved"}:${row.bowlerId}:${index}`}>
                    <TableCell className="whitespace-nowrap">
                      {formatLocalDate(row.authoritativeLocalDate)}
                      <div className="text-xs text-muted-foreground md:hidden">{paymentTypeLabel(row.paymentType)}</div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-mono">{formatCurrency(row.amountMinor, row.currency)}</TableCell>
                    <TableCell className="hidden whitespace-nowrap md:table-cell">{paymentTypeLabel(row.paymentType)}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          className={cn(badgeVariants({ variant: statusVariant(row) }), "cursor-pointer")}
                          aria-label={`View payment details: ${displayStatus}`}
                          onClick={() => setDetailsTarget(row)}
                        >
                          {displayStatus}
                        </button>
                        {hasSeparateReviewIndicator && <Badge variant="destructive">Review required</Badge>}
                        {row.correctionEvidence?.status === "voided" && <Badge variant="secondary">Voided</Badge>}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      <PaymentDetailsDialog
        key={detailsTarget?.paymentOperationId ?? detailsTarget?.paymentId ?? "closed"}
        payment={null}
        evidence={detailsTarget}
        bowlerName={bowlerName}
        canCorrect={false}
        organizationId={organizationId}
        onClose={() => setDetailsTarget(null)}
      />
    </section>
  );
}
