/* eslint-disable shadcn/no-unknown-classes, shadcn/no-restyle */
import { useState } from "react";
import { ArrowUpRight, Check, ChevronRight } from "lucide-react";
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
import type { CanonicalPaymentRow } from "@shared/canonical-payment-report";
import { PaymentDetailsDialog, paymentEvidenceDisplayStatus } from "@/components/payment-details-dialog";

type Props = {
  rows: CanonicalPaymentRow[];
  organizationId?: number | null;
  bowlerName?: string;
  title?: string;
  totalTransactions?: number;
  variant?: "admin" | "bowler";
  leagueName?: string;
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
  const hasCents = Number.isSafeInteger(amountMinor) && Math.abs(amountMinor) % 100 !== 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(amountMinor / 100);
}

type PaymentPeriodReference = {
  plannedOrdinal?: number | null;
  occurrenceLocalDate?: string | null;
};

function firstPaymentPeriod(row: CanonicalPaymentRow): PaymentPeriodReference {
  const references: PaymentPeriodReference[] = row.appliedTo?.length
    ? row.appliedTo
    : row.allocations;
  const ordered = [...references].sort((left, right) => {
    const leftOrdinal = Number.isSafeInteger(left.plannedOrdinal) ? left.plannedOrdinal as number : Number.POSITIVE_INFINITY;
    const rightOrdinal = Number.isSafeInteger(right.plannedOrdinal) ? right.plannedOrdinal as number : Number.POSITIVE_INFINITY;
    return leftOrdinal - rightOrdinal;
  });
  return ordered[0] ?? { plannedOrdinal: null, occurrenceLocalDate: row.authoritativeLocalDate };
}

function formatMobilePaymentDate(value: string | null | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(date);
}

function mobilePaymentPeriodLabel(row: CanonicalPaymentRow): { period: string; date: string | null } {
  const reference = firstPaymentPeriod(row);
  const period = Number.isSafeInteger(reference.plannedOrdinal) && (reference.plannedOrdinal as number) > 0
    ? `Week ${reference.plannedOrdinal} payment`
    : "Payment";
  return { period, date: formatMobilePaymentDate(reference.occurrenceLocalDate) ?? formatMobilePaymentDate(row.authoritativeLocalDate) };
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
export function CanonicalPaymentEvidenceTable({ rows, organizationId, bowlerName = "Bowler", title = "Payment history", totalTransactions, variant = "admin", leagueName }: Props) {
  const [detailsTarget, setDetailsTarget] = useState<CanonicalPaymentRow | null>(null);
  const bowlerPresentation = variant === "bowler";

  return (
    <section aria-label={title} data-testid="canonical-payment-evidence-table" className="familiar-payment-history-section space-y-2">
      <div className="familiar-history-heading">
        <h2>{title}</h2>
        {typeof totalTransactions === "number" && totalTransactions > 0 && <span>{totalTransactions} {totalTransactions === 1 ? "payment" : "payments"}</span>}
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No payments yet.</p>
      ) : bowlerPresentation ? (
          <div className="familiar-payment-history-bowler-list" aria-label="Payment transactions">
            {rows.map((row, index) => {
              const displayStatus = paymentEvidenceDisplayStatus(row);
              const reviewRequired = row.reviewRequired || row.dispute.reviewRequired === true;
              const hasSeparateReviewIndicator = reviewRequired && displayStatus !== "Review required";
              const paymentPeriod = mobilePaymentPeriodLabel(row);
              const creditLabel = row.source === "prepaid_credit"
                ? "Unused share credit"
                : row.source === "held_credit"
                  ? "Share credit refund on hold"
                  : row.source === "refunded_credit"
                    ? "Refunded share credit"
                    : null;
              const statusLabel = displayStatus === "Confirmed paid" && !hasSeparateReviewIndicator
                ? "Paid"
                : displayStatus;
              const accessibleStatus = [displayStatus, creditLabel, hasSeparateReviewIndicator ? "Review required" : null, row.correctionEvidence?.status === "voided" ? "Voided" : null]
                .filter(Boolean)
                .join(", ");
              const accessibleDate = paymentPeriod.date ?? formatLocalDate(row.authoritativeLocalDate);
              const accessibleAmount = formatCurrency(row.amountMinor, row.currency);
              return (
                <button
                  type="button"
                  className="familiar-payment-history-bowler-row"
                  key={`${row.paymentOperationId ?? row.paymentId ?? "unresolved"}:${row.bowlerId}:${index}`}
                  aria-label={`View payment details: ${[paymentPeriod.period, accessibleDate, accessibleAmount, accessibleStatus].join(", ")}`}
                  onClick={() => setDetailsTarget(row)}
                >
                  <span className="familiar-payment-history-bowler-row__icon" aria-hidden="true"><ArrowUpRight size={19} /></span>
                  <span className="familiar-payment-history-bowler-row__info">
                    <strong>{paymentPeriod.period}</strong>
                    {paymentPeriod.date && <span>{paymentPeriod.date}</span>}
                  </span>
                  <span className="familiar-payment-history-bowler-row__value">
                    <strong>{formatCurrency(row.amountMinor, row.currency)}</strong>
                    <span className={cn(
                      "familiar-payment-history-bowler-row__status",
                      displayStatus === "Confirmed paid" && !hasSeparateReviewIndicator && "familiar-payment-history-bowler-row__status--paid",
                      (displayStatus === "Review required" || hasSeparateReviewIndicator) && "familiar-payment-history-bowler-row__status--review",
                    )}>
                      {displayStatus === "Confirmed paid" && !hasSeparateReviewIndicator && <Check aria-hidden="true" size={12} />}
                      {statusLabel}
                    </span>
                    {(creditLabel || hasSeparateReviewIndicator || row.correctionEvidence?.status === "voided") && (
                      <span className="familiar-payment-history-bowler-row__secondary-status">
                        {[creditLabel, hasSeparateReviewIndicator ? "Review required" : null, row.correctionEvidence?.status === "voided" ? "Voided" : null].filter(Boolean).join(" · ")}
                      </span>
                    )}
                  </span>
                  <ChevronRight className="familiar-payment-history-bowler-row__chevron" aria-hidden="true" size={17} />
                </button>
              );
            })}
          </div>
        ) : (
          <div className="familiar-payment-history-table overflow-x-auto rounded-md border">
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
                  const paidByName = row.paidByName;
                  const paymentPeriod = mobilePaymentPeriodLabel(row);
                  return (
                    <TableRow className="familiar-payment-history-table__row" key={`${row.paymentOperationId ?? row.paymentId ?? "unresolved"}:${row.bowlerId}:${index}`}>
                      <TableCell className="whitespace-nowrap">
                        <div className="familiar-payment-history-mobile-main">
                          <span className="familiar-payment-history-mobile-icon" aria-hidden="true"><ArrowUpRight size={17} /></span>
                          <span className="familiar-payment-history-mobile-copy">
                            <strong className="familiar-payment-history-mobile-period">{paymentPeriod.period}</strong>
                            {paymentPeriod.date && <span className="familiar-payment-history-mobile-date">{paymentPeriod.date}</span>}
                          </span>
                        </div>
                        <span className="familiar-payment-history-desktop-date">{formatLocalDate(row.authoritativeLocalDate)}</span>
                        <div className="familiar-payment-history-mobile-method text-xs text-muted-foreground md:hidden">{paymentTypeLabel(row.paymentType)}</div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap" font="mono">
                        {formatCurrency(row.amountMinor, row.currency)}
                        {paidByName && <div className="font-sans text-xs font-normal text-muted-foreground">Paid by {paidByName}</div>}
                      </TableCell>
                      <TableCell className="hidden whitespace-nowrap md:table-cell">{paymentTypeLabel(row.paymentType)}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            className={cn(
                              badgeVariants({ variant: statusVariant(row) }),
                              "cursor-pointer",
                              displayStatus === "Confirmed paid" && "familiar-payment-history-status--paid",
                              displayStatus === "Review required" && "familiar-payment-history-status--review",
                            )}
                            aria-label={`View payment details: ${displayStatus}`}
                            onClick={() => setDetailsTarget(row)}
                          >
                            <span className="familiar-payment-history-status-label">{displayStatus}</span>
                            <ChevronRight className="familiar-payment-history-mobile-chevron" aria-hidden="true" size={17} />
                          </button>
                          {row.source === "prepaid_credit" && <Badge variant="secondary">Unused share credit</Badge>}
                          {row.source === "held_credit" && <Badge variant="secondary">Share credit refund on hold</Badge>}
                          {row.source === "refunded_credit" && <Badge variant="secondary">Refunded share credit</Badge>}
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
        )
      }
      <PaymentDetailsDialog
        key={detailsTarget?.paymentOperationId ?? detailsTarget?.paymentId ?? "closed"}
        payment={null}
        evidence={detailsTarget}
        bowlerName={bowlerName}
        canCorrect={false}
        organizationId={organizationId}
        variant={variant}
        leagueName={leagueName}
        onClose={() => setDetailsTarget(null)}
      />
    </section>
  );
}
