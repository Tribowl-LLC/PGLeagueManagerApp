import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Trash2, RotateCcw, Send } from "lucide-react";
import { format } from "date-fns";
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

type PaymentWithDisputes = Payment & { disputes?: PaymentRowDisputeSummary[] };

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
  onDelete: (id: number) => void;
  isRefundPending: boolean;
  isDeletePending: boolean;
  /**
   * Used to resolve each payment's owning location (via leagueId) so
   * the PROVIDER_NOT_CONFIGURED toast raised by the receipt buttons
   * deep-links to that location's settings card.
   */
  leagues?: League[];
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
  onDelete,
  isRefundPending,
  isDeletePending,
  leagues = EMPTY_LEAGUES,
}: Props) {
  const [resendTarget, setResendTarget] = useState<Payment | null>(null);
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
            <TableHead>Week Of</TableHead>
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
              // Resend is offered for any paid card row; the server
              // resolves provider/receipt availability and returns a
              // clean error for non-Square rows.
              const canResend = isAdmin
                && payment.status === 'paid'
                && (payment.type === 'square' || payment.type === 'credit_card');
              const disputes = payment.disputes ?? [];
              const deleteBlockedByDispute = disputes.length > 0;
              const expanded = expandedPaymentIds.has(payment.id);
              return (
                <Fragment key={payment.id}>
                <TableRow>
                  <TableCell>{bowler?.name || "Unknown Bowler"}</TableCell>
                  <TableCell>{format(new Date(payment.weekOf), "MMM d, yyyy")}</TableCell>
                  <TableCell>${(payment.amount / 100).toFixed(2)}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant={
                          payment.status === "paid" ? "default" :
                          payment.status === "pending" ? "secondary" :
                          payment.status === "failed" ? "destructive" :
                          "outline"
                        }
                        className={payment.status === "refunded" ? "border-destructive text-destructive" : ""}
                      >
                        {payment.status}
                      </Badge>
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
                      {(!isCardPaymentType(payment.type) || (isAdmin && !isPaymentManager)) && (
                        <Button
                          size="icon"
                          variant="ghost"
                          title={deleteBlockedByDispute
                            ? "Payment deletion disabled while dispute evidence is retained"
                            : "Delete payment"}
                          aria-label={deleteBlockedByDispute
                            ? "Payment deletion disabled while dispute evidence is retained"
                            : "Delete payment"}
                          onClick={() => {
                            if (!deleteBlockedByDispute) onDelete(payment.id);
                          }}
                          disabled={isDeletePending || deleteBlockedByDispute}
                        >
                          {isDeletePending ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Trash2 className="size-4 text-destructive" />
                          )}
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
    </div>
  );
}
