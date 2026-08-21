import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ViewReceiptButton } from "@/components/view-receipt-button";
import type { Payment } from "@shared/schema";
import type { CanonicalPaymentRow } from "@shared/canonical-payment-report";

interface Props {
  payments: Payment[];
  /** Owning location used to deep-link the PROVIDER_NOT_CONFIGURED toast. */
  locationId?: number | null;
  paymentBusinessDates?: Map<number, string>;
  paymentEvidenceStatuses?: Map<number, CanonicalPaymentRow["status"]>;
}

function formatAuthoritativeLocalDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[2]}/${match[3]}/${match[1]}` : value;
}

export function BowlerPaymentHistoryTable({ payments, locationId, paymentBusinessDates, paymentEvidenceStatuses }: Props) {
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Amount</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Transaction ID</TableHead>
            <TableHead>Receipt</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {payments.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="text-center">No payment history</TableCell>
            </TableRow>
          ) : (
            payments.map((payment) => (
              <TableRow key={payment.id}>
                <TableCell>{formatAuthoritativeLocalDate(paymentBusinessDates?.get(payment.id) ?? payment.weekOf)}</TableCell>
                <TableCell className="capitalize">{payment.type.replace(/_/g, " ")}</TableCell>
                <TableCell>${(payment.amount / 100).toFixed(2)}</TableCell>
                <TableCell>
                  <Badge variant={payment.status === "paid" ? "default" : "secondary"}>
                    {paymentEvidenceStatuses?.get(payment.id) === "unresolved" ? "Review required" : payment.status}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    {payment.providerPaymentId ? (
                      <>
                        <span className="font-mono text-sm">{payment.providerPaymentId}</span>
                        <a
                          href={`https://squareup.com/dashboard/payments/${payment.providerPaymentId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-muted-foreground hover:text-foreground"
                          title="View in Square Dashboard"
                        >
                          <ExternalLink className="size-4" />
                        </a>
                      </>
                    ) : (
                      <span className="text-muted-foreground">N/A</span>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <ViewReceiptButton
                    payment={payment}
                    variant="link"
                    locationId={locationId}
                  />
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
