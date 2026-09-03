import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight, RotateCcw, Send } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { isCardPaymentType } from "@shared/schema/constants";
import { ResendReceiptDialog } from "@/components/resend-receipt-dialog";
import { ViewReceiptButton } from "@/components/view-receipt-button";
import {
  PaymentDisputeBadge,
  PaymentDisputeDetails,
} from "@/components/payment-dispute-details";
import type { Payment, PaymentRowDisputeSummary, Bowler, League } from "@shared/schema";
import type { CanonicalPaymentRow } from "@shared/canonical-payment-report";
import { PaymentDetailsDialog, paymentEvidenceDisplayStatus } from "@/components/payment-details-dialog";

type PaymentWithDisputes = Payment & { disputes?: PaymentRowDisputeSummary[] };

function formatAuthoritativeLocalDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[2]}/${match[3]}/${match[1]}` : value;
}

function paymentTypeLabel(payment: Payment): string {
  switch (payment.type) {
    case "cash": return "Cash";
    case "check": return `Check #${payment.checkNumber}`;
    case "credit_card": return "Credit Card";
    case "square": return "Square";
    default: return "Other Payment";
  }
}

interface Props {
  payments: PaymentWithDisputes[];
  filteredPayments: PaymentWithDisputes[];
  bowlers: Bowler[];
  isAdmin: boolean;
  isPaymentManager?: boolean;
  onRefund: (payment: Payment) => void;
  isRefundPending: boolean;
  /**
   * Used to resolve each payment's owning location (via leagueId) so
   * the PROVIDER_NOT_CONFIGURED toast raised by the receipt buttons
   * deep-links to that location's settings card.
   */
  leagues?: League[];
  paymentBusinessDates?: Map<number, string>;
  paymentCanonicalRows?: Map<number, CanonicalPaymentRow>;
}

// Stable default reference so the optional `leagues` prop doesn't create a
// fresh array on every render.
const EMPTY_LEAGUES: League[] = [];

export function PaymentsTable({
  payments,
  filteredPayments,
  bowlers,
  isAdmin,
  isPaymentManager = false,
  onRefund,
  isRefundPending,
  leagues = EMPTY_LEAGUES,
  paymentBusinessDates,
  paymentCanonicalRows,
}: Props) {
  const [resendTarget, setResendTarget] = useState<Payment | null>(null);
  const [detailsTarget, setDetailsTarget] = useState<Payment | null>(null);
  const [expandedPaymentIds, setExpandedPaymentIds] = useState<Set<number>>(new Set());
  const leagueLocationMap = new Map<number, number | null>();
  for (const league of leagues) {
    leagueLocationMap.set(league.id, league.locationId ?? null);
  }
  const resendTargetLocationId = resendTarget
    ? leagueLocationMap.get(resendTarget.leagueId) ?? null
    : null;
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Bowler</TableHead>
            <TableHead>Collected</TableHead>
            <TableHead>Amount</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="hidden md:table-cell">Payment Type</TableHead>
            <TableHead className="w-[140px]">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {payments.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="text-center">No payments found</TableCell>
            </TableRow>
          ) : filteredPayments.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="text-center">No payments match your search</TableCell>
            </TableRow>
          ) : (
            filteredPayments.map((payment) => {
              const bowler = bowlers.find((b) => b.id === payment.bowlerId);
              const canonicalRow = paymentCanonicalRows?.get(payment.id);
              const canonicalStatusLabel = canonicalRow ? paymentEvidenceDisplayStatus(canonicalRow) : null;
              // Resend is offered for any paid card row; the server
              // resolves provider/receipt availability and returns a
              // clean error for non-Square rows.
              const canResend = isAdmin
                && payment.status === 'paid'
                && (payment.type === 'square' || payment.type === 'credit_card');
              const disputes = payment.disputes ?? [];
              const expanded = expandedPaymentIds.has(payment.id);
              return (
                <Fragment key={payment.id}>
                <TableRow>
                  <TableCell>{bowler?.name || "Unknown Bowler"}</TableCell>
                  <TableCell>{formatAuthoritativeLocalDate(paymentCanonicalRows?.get(payment.id)?.authoritativeLocalDate ?? paymentBusinessDates?.get(payment.id) ?? payment.createdAt)}</TableCell>
                  <TableCell>${((paymentCanonicalRows?.get(payment.id)?.amountMinor ?? payment.amount) / 100).toFixed(2)}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-2">
                      {canonicalRow ? (
                        <button
                          type="button"
                          className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                          aria-label={`View payment details: ${canonicalStatusLabel}`}
                          onClick={() => setDetailsTarget(payment)}
                        >
                          <Badge
                            variant={
                              canonicalStatusLabel === "Review required" ? "destructive" :
                              canonicalRow.status === "confirmed_paid" ? "default" :
                              canonicalRow.status === "pending" ? "secondary" :
                              canonicalRow.status === "failed" || canonicalRow.status === "review_required" ? "destructive" :
                              "outline"
                            }
                            className={payment.status === "refunded" ? "border-destructive text-destructive" : "cursor-pointer"}
                          >
                            {canonicalStatusLabel}
                          </Badge>
                        </button>
                      ) : (
                        <Badge variant="outline">{payment.status}</Badge>
                      )}
                      {disputes.map((dispute) => (
                        <PaymentDisputeBadge key={dispute.id} dispute={dispute} />
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <Badge variant="outline">{paymentTypeLabel(payment)}</Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      {disputes.length > 0 && (
                        <Button
                          size="icon"
                          variant="ghost"
                          title={expanded ? "Hide dispute details" : "Show dispute details"}
                          aria-expanded={expanded}
                          aria-label={expanded ? "Hide dispute details" : "Show dispute details"}
                          onClick={() => setExpandedPaymentIds((current) => {
                            const next = new Set(current);
                            if (next.has(payment.id)) next.delete(payment.id);
                            else next.add(payment.id);
                            return next;
                          })}
                        >
                          {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                        </Button>
                      )}
                      <ViewReceiptButton
                        payment={payment}
                        locationId={leagueLocationMap.get(payment.leagueId) ?? null}
                      />
                      {canResend && (
                        <Button
                          size="icon"
                          variant="ghost"
                          title={payment.receiptEmailMissing ? "No receipt sent — resend now" : "Resend receipt"}
                          onClick={() => setResendTarget(payment)}
                          className={payment.receiptEmailMissing ? "text-amber-600" : ""}
                        >
                          <Send className="size-4" />
                        </Button>
                      )}
                      {payment.status === "paid" && isCardPaymentType(payment.type) && isAdmin && !isPaymentManager && (
                        <Button
                          size="icon"
                          variant="ghost"
                          title="Refund payment"
                          onClick={() => onRefund(payment)}
                          disabled={isRefundPending}
                        >
                          <RotateCcw className="size-4 text-destructive" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
                {expanded && (
                  <TableRow>
                    <TableCell colSpan={6} className="bg-muted/20 p-4">
                      <div className="space-y-3">
                        {disputes.map((dispute) => (
                          <PaymentDisputeDetails key={dispute.id} dispute={dispute} />
                        ))}
                      </div>
                    </TableCell>
                  </TableRow>
                )}
                </Fragment>
              );
            })
          )}
        </TableBody>
      </Table>
      <ResendReceiptDialog
        payment={resendTarget}
        defaultEmail={
          resendTarget
            ? bowlers.find((b) => b.id === resendTarget.bowlerId)?.email ?? ""
            : ""
        }
        onClose={() => setResendTarget(null)}
        locationId={resendTargetLocationId}
      />
      <PaymentDetailsDialog
        key={detailsTarget?.id ?? "closed"}
        payment={detailsTarget}
        evidence={detailsTarget ? paymentCanonicalRows?.get(detailsTarget.id) ?? null : null}
        bowlerName={detailsTarget ? bowlers.find((bowler) => bowler.id === detailsTarget.bowlerId)?.name || "Unknown Bowler" : ""}
        canCorrect={isAdmin && !isPaymentManager}
        onClose={() => setDetailsTarget(null)}
      />
    </div>
  );
}
