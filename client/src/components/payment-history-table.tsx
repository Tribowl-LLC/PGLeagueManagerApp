import { memo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Trash2, Send } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Link } from "wouter";
import { isCardPaymentType } from "@shared/schema/constants";
import { ResendReceiptDialog } from "@/components/resend-receipt-dialog";
import { ViewReceiptButton } from "@/components/view-receipt-button";
import type { Payment } from "@shared/schema";

// server enriches list responses with `paidByName` when a
// row's `paidByUserId` resolves to a real user (typed as optional on
// SanitizedPayment in server/utils/api.ts). The base Payment type
// doesn't carry it; widen our row reads with this view-only union.
type PaymentRow = Payment & { paidByName?: string | null };

interface BowlerInfo {
  id: number;
  name: string;
  email?: string | null;
}

interface PaymentHistoryTableProps {
  payments: PaymentRow[];
  bowlers: BowlerInfo[];
  bowlerTeamMap?: Map<number, string>;
  onStartEdit: (payment: Payment) => void;
  onDelete: (paymentId: number) => void;
  isDeletePending: boolean;
  isAdmin?: boolean;
  bowlerHrefSuffix?: string;
  /**
   * Owning location for these payments. Forwarded to the receipt
   * buttons / dialog so the PROVIDER_NOT_CONFIGURED toast deep-links
   * to that location's settings card.
   */
  locationId?: number | null;
}

export const PaymentHistoryTable = memo(function PaymentHistoryTable({
  payments,
  bowlers,
  bowlerTeamMap,
  onStartEdit,
  onDelete,
  isDeletePending,
  isAdmin = false,
  bowlerHrefSuffix = "",
  locationId,
}: PaymentHistoryTableProps) {
  const showTeamColumn = !!bowlerTeamMap;
  // admin "Resend receipt" entry-point on the weekly
  // payments admin table. Gated to paid Square/credit_card rows.
  const [resendTarget, setResendTarget] = useState<Payment | null>(null);
  const resendBowler = resendTarget
    ? bowlers.find((b) => b.id === resendTarget.bowlerId)
    : null;

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Bowler</TableHead>
            {showTeamColumn && <TableHead className="hidden md:table-cell">Team</TableHead>}
            <TableHead className="hidden md:table-cell">Payment Type</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead className="w-[100px]">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {payments?.length === 0 ? (
            <TableRow>
              <TableCell colSpan={showTeamColumn ? 5 : 4} className="text-center">
                No payment history
              </TableCell>
            </TableRow>
          ) : (
            payments?.map((payment) => {
              const bowler = bowlers.find(b => b.id === payment.bowlerId);
              const teamName = bowlerTeamMap?.get(payment.bowlerId);

              return (
                <TableRow key={payment.id}>
                  <TableCell>
                    {bowler ? (
                      <Link href={`/bowlers/${bowler.id}${bowlerHrefSuffix}`} className="hover:underline text-foreground">
                        {bowler.name}
                      </Link>
                    ) : 'Unknown Bowler'}
                    {payment.paidByName && payment.paidByUserId !== undefined && (
                      <div
                        className="text-xs text-muted-foreground mt-0.5"
                        data-testid={`text-paid-by-${payment.id}`}
                      >
                        Paid by {payment.paidByName}
                      </div>
                    )}
                  </TableCell>
                  {showTeamColumn && (
                    <TableCell className="hidden md:table-cell text-muted-foreground">{teamName || '—'}</TableCell>
                  )}
                  <TableCell className="hidden md:table-cell">
                    <Badge variant="outline">
                      {payment.type === 'cash' ? 'Cash' :
                        payment.type === 'check' ? `Check #${payment.checkNumber}` :
                        payment.type === 'credit_card' ? 'Credit Card' :
                        payment.type === 'square' ? 'Square' :
                        payment.type}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    ${(payment.amount / 100).toFixed(2)}
                  </TableCell>
                  <TableCell>
                    <ViewReceiptButton payment={payment} locationId={locationId} />
                    {isAdmin
                      && payment.status === 'paid'
                      && (payment.type === 'square' || payment.type === 'credit_card') && (
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
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => onStartEdit(payment)}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="size-4 text-primary">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487zm0 0L19.5 7.125" />
                      </svg>
                    </Button>
                    {(!isCardPaymentType(payment.type) || isAdmin) && (
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => onDelete(payment.id)}
                        disabled={isDeletePending}
                      >
                        {isDeletePending ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Trash2 className="size-4 text-destructive" />
                        )}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
      <ResendReceiptDialog
        payment={resendTarget}
        defaultEmail={resendBowler?.email ?? ""}
        onClose={() => setResendTarget(null)}
        locationId={locationId}
      />
    </div>
  );
});
