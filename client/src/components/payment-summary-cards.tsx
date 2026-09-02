import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { format, parseISO } from "date-fns";
import { formatCurrency } from "@/lib/utils";
import { CheckCircle2, CircleDollarSign } from "lucide-react";
import { Link } from "wouter";

interface DoublePayInfo {
  dates: string[];
  perWeekExtra: number;
  totalExtra: number;
  pastExtra: number;
  isPaid: boolean;
}

interface PaymentSummaryCardsProps {
  totalWeeksInSeason: number;
  fullSeasonAmount: number;
  weeklyFee: number;
  weeksDueCount: number;
  totalSeasonDues: number;
  weeksPaid: number;
  totalPaidAmount: number;
  amountPastDue: number;
  remainingBalance: number;
  doublePay: DoublePayInfo;
  onPayPastDue: () => void;
  onPayRemaining: () => void;
  pastDueHref?: string;
  remainingHref?: string;
}

export function PaymentSummaryCards({
  totalWeeksInSeason,
  fullSeasonAmount,
  weeklyFee,
  weeksDueCount,
  totalSeasonDues,
  weeksPaid,
  totalPaidAmount,
  amountPastDue,
  remainingBalance,
  doublePay,
  onPayPastDue,
  onPayRemaining,
  pastDueHref,
  remainingHref,
}: PaymentSummaryCardsProps) {
  const isPaidInFull = remainingBalance <= 0 && totalPaidAmount > 0;

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {isPaidInFull && (
        <Card className="md:col-span-3 border-green-500/50 bg-green-500/5">
          <CardContent className="flex items-center justify-center gap-3 py-4">
            <CheckCircle2 className="size-6 text-green-600" />
            <span className="text-lg font-semibold text-green-600">Season Paid in Full</span>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-lg">Full Season Amount Due</CardTitle>
          <CardDescription>
            {totalWeeksInSeason} week{totalWeeksInSeason === 1 ? "" : "s"} at {formatCurrency(weeklyFee)}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-bold">{formatCurrency(fullSeasonAmount)}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-lg">Weekly Fee</CardTitle>
          <CardDescription>Regular payment amount</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-bold">{formatCurrency(weeklyFee)}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-lg">Amount Due to Date</CardTitle>
          <CardDescription>
            {weeksDueCount} week{weeksDueCount === 1 ? "" : "s"} at {formatCurrency(weeklyFee)}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-bold">{formatCurrency(totalSeasonDues)}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-lg">Amount Paid to Date</CardTitle>
          <CardDescription>
            {weeksPaid} week{weeksPaid === 1 ? "" : "s"} at {formatCurrency(weeklyFee)}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-bold">{formatCurrency(totalPaidAmount)}</p>
        </CardContent>
      </Card>

      {pastDueHref ? (
        <Link
          href={pastDueHref}
          aria-label="Amount Past Due to Date — Make a payment"
          onClick={() => amountPastDue > 0 && onPayPastDue()}
          className="block no-underline text-inherit"
        >
          <Card className={amountPastDue > 0 ? "cursor-pointer transition-colors hover:border-destructive/50 hover:bg-destructive/5" : ""}>
            <CardHeader className="pb-2">
              <CardTitle className="text-lg">Amount Past Due to Date</CardTitle>
              <CardDescription>{amountPastDue > 0 ? "Make a payment" : "No amount past due"}</CardDescription>
            </CardHeader>
            <CardContent><p className="text-2xl font-bold text-destructive">{formatCurrency(amountPastDue)}</p></CardContent>
          </Card>
        </Link>
      ) : (
        <Card
          className={amountPastDue > 0 ? "cursor-pointer transition-colors hover:border-destructive/50 hover:bg-destructive/5" : ""}
          onClick={() => amountPastDue > 0 && onPayPastDue()}
        >
          <CardHeader className="pb-2"><CardTitle className="text-lg">Amount Past Due to Date</CardTitle><CardDescription>{amountPastDue > 0 ? "Click to make a payment" : "No amount past due"}</CardDescription></CardHeader>
          <CardContent><p className="text-2xl font-bold text-destructive">{formatCurrency(amountPastDue)}</p></CardContent>
        </Card>
      )}

      {remainingHref ? (
        <Link
          href={remainingHref}
          aria-label="Full Season Remaining Balance — Make a payment"
          onClick={() => remainingBalance > 0 && onPayRemaining()}
          className="block no-underline text-inherit"
        >
          <Card className={remainingBalance > 0 ? "cursor-pointer transition-colors hover:border-primary/50 hover:bg-primary/5" : ""}>
            <CardHeader className="pb-2"><CardTitle className="text-lg">Full Season Remaining Balance</CardTitle><CardDescription>{remainingBalance > 0 ? "Make a one-time payment" : "Fully paid"}</CardDescription></CardHeader>
            <CardContent><p className="text-2xl font-bold">{formatCurrency(remainingBalance)}</p></CardContent>
          </Card>
        </Link>
      ) : (
        <Card
          className={remainingBalance > 0 ? "cursor-pointer transition-colors hover:border-primary/50 hover:bg-primary/5" : ""}
          onClick={() => remainingBalance > 0 && onPayRemaining()}
        >
          <CardHeader className="pb-2"><CardTitle className="text-lg">Full Season Remaining Balance</CardTitle><CardDescription>{remainingBalance > 0 ? "Click to make a one-time payment" : "Fully paid"}</CardDescription></CardHeader>
          <CardContent><p className="text-2xl font-bold">{formatCurrency(remainingBalance)}</p></CardContent>
        </Card>
      )}

      {doublePay.dates.length > 0 && (
        <Card className="border-emerald-500/50 bg-emerald-500/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-lg flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
              <CircleDollarSign className="size-5" />
              Double-Pay Weeks
            </CardTitle>
            <CardDescription>
              {doublePay.dates.length} week{doublePay.dates.length === 1 ? '' : 's'} billed at 2×; last{' '}
              {doublePay.dates.length} regular week{doublePay.dates.length === 1 ? '' : 's'} not charged
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-400">
              {formatCurrency(doublePay.perWeekExtra * 2)}/week
            </p>
            <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
              {doublePay.dates.map((d) => (
                <li key={d} className="flex items-center justify-between">
                  <span>{format(parseISO(d), 'MMM d, yyyy')}</span>
                  <span>{formatCurrency(doublePay.perWeekExtra * 2)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted-foreground">
              Season total unchanged; these dates collect early so the last{' '}
              {doublePay.dates.length} regular bowling week{doublePay.dates.length === 1 ? '' : 's'} bill $0.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
