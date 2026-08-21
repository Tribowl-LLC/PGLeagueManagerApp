import { FC } from "react";
import { CreditCard, Banknote, FileText, Receipt } from "lucide-react";
import { differenceInWeeks } from "date-fns";
import { formatCurrency } from "@/lib/utils";
import { isCardPaymentType } from "@shared/schema/constants";
import { ViewReceiptButton } from "@/components/view-receipt-button";
import type { Payment, League } from "@shared/schema";
import type { CanonicalPaymentRow } from "@shared/canonical-payment-report";

// server-sanitized rows on /api/payments + bowler-details may
// include the optional `paidByName` enrichment when a linked partner
// funded the charge. Widen the prop here so the badge below typechecks
// without forcing a `Payment & {…}` cast at every call site.
type BowlerPayment = Payment & { paidByName?: string | null };

interface BowlerPaymentTableProps {
  payments: BowlerPayment[];
  league: League;
  paymentBusinessDates?: Map<number, string>;
  paymentEvidenceStatuses?: Map<number, CanonicalPaymentRow["status"]>;
}

function getPaymentIcon(type: string) {
  if (isCardPaymentType(type)) return CreditCard;
  switch (type) {
    case 'cash': return Banknote;
    case 'check': return FileText;
    default: return Receipt;
  }
}

function getPaymentMethodLabel(payment: Payment) {
  switch (payment.type) {
    case 'credit_card': return 'Credit Card';
    case 'square': return 'Square';
    case 'cash': return 'Cash';
    case 'check': return `Check #${payment.checkNumber || ''}`;
    default: return 'Other';
  }
}

function getStatusStyle(status: string) {
  switch (status) {
    case 'paid': return 'bg-emerald-50 text-emerald-700';
    case 'pending': return 'bg-blue-50 text-blue-700';
    case 'failed': return 'bg-amber-50 text-amber-700';
    case 'refunded': return 'bg-red-50 text-red-700';
    default: return 'bg-slate-100 text-slate-600';
  }
}

function getStatusLabel(status: string) {
  switch (status) {
    case 'paid': return 'Paid';
    case 'pending': return 'Pending';
    case 'failed': return 'Failed';
    case 'refunded': return 'Refunded';
    default: return status;
  }
}

function formatAuthoritativeLocalDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[2]}/${match[3]}/${match[1]}` : value;
}

export const BowlerPaymentTable: FC<BowlerPaymentTableProps> = ({ payments, league, paymentBusinessDates, paymentEvidenceStatuses }) => {
  return (
    <div>
      <div className="flex items-center justify-between mb-3 px-1">
        <h3 className="text-lg font-semibold text-slate-800">Payment History</h3>
        <span className="text-sm text-slate-500">{payments.length} payment{payments.length !== 1 ? 's' : ''}</span>
      </div>
      <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
        {payments.length === 0 ? (
          <div className="p-8 text-center">
            <Receipt className="size-10 mx-auto mb-3 text-slate-300" />
            <p className="text-slate-500">No payments recorded</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {payments.map((payment) => {
              const Icon = getPaymentIcon(payment.type);
              const businessDate = paymentBusinessDates?.get(payment.id) ?? payment.weekOf;
              const evidenceStatus = paymentEvidenceStatuses?.get(payment.id);
              const weekNumber = evidenceStatus === undefined && league.seasonStart
                ? Math.max(1, differenceInWeeks(new Date(payment.weekOf), new Date(league.seasonStart)) + 1)
                : null;

              return (
                <div key={payment.id} className="p-4 flex items-center justify-between hover:bg-slate-50 transition-colors">
                  <div className="flex items-center gap-4">
                    <div className="size-10 rounded-full bg-slate-100 flex items-center justify-center flex-shrink-0">
                      <Icon className="size-5 text-slate-500" />
                    </div>
                    <div>
                      <div className="font-semibold text-slate-900">{formatCurrency(payment.amount)}</div>
                      <div className="text-sm text-slate-500">
                        {formatAuthoritativeLocalDate(businessDate)}
                        {weekNumber && <> &bull; Week {weekNumber}</>}
                        {' '}&bull; {getPaymentMethodLabel(payment)}
                      </div>
                      {/* when a linked partner paid
                          for this bowler, the server stamps `paidByName` on
                          the wire (sanitized — never an email). Surface it
                          here so the recipient sees who covered the charge. */}
                      {payment.paidByName && (
                        <div
                          className="text-xs text-slate-500 mt-0.5"
                          data-testid={`paid-by-${payment.id}`}
                        >
                          Paid by {payment.paidByName}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {/* View receipt entry-point for paid Square/credit_card rows. */}
                    <ViewReceiptButton
                      payment={payment}
                      variant="link"
                      locationId={league?.locationId ?? null}
                    />
                    <span className={`px-2.5 py-1 rounded-md text-xs font-medium ${getStatusStyle(payment.status)}`}>
                      {evidenceStatus === "confirmed_paid" ? "Paid" : evidenceStatus === "unresolved" ? "Review required" : getStatusLabel(payment.status)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
