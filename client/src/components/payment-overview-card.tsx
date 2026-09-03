import { FC } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "wouter";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import type { PaymentMode } from "@shared/schema";

interface FinancialsData {
  fullSeasonAmount: number;
  totalDueToDate: number;
  totalPaid: number;
  amountPastDue: number;
  remainingBalance: number;
}

interface PaymentOverviewCardProps {
  weeklyFee: number;
  financials: FinancialsData;
  leagueId?: number;
  paymentMode: PaymentMode;
}

/** Read-only canonical payment summary for the bowler dashboard. */
export const PaymentOverviewCard: FC<PaymentOverviewCardProps> = ({ weeklyFee, financials, leagueId, paymentMode }) => {
  const isUpfront = paymentMode === "upfront";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Payment Overview</CardTitle>
      </CardHeader>
      <CardContent className="pt-6 space-y-4">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Full Season Total Due</span>
            <span className="text-sm font-medium">{formatCurrency(financials.fullSeasonAmount)}</span>
          </div>
          {!isUpfront && (
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Weekly Fee</span>
              <span className="text-sm font-medium">{formatCurrency(weeklyFee)}/week</span>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Amount Due to Date</span>
            <span className="text-sm font-medium">{formatCurrency(financials.totalDueToDate)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Amount Paid to Date</span>
            <span className="text-sm font-medium">{formatCurrency(financials.totalPaid)}</span>
          </div>
          {!isUpfront && financials.amountPastDue > 0 && (
            <div className="flex items-center justify-between rounded-md bg-destructive/10 px-3 py-2">
              <span className="text-sm font-medium text-destructive flex items-center gap-1.5">
                <AlertTriangle className="size-3.5" />
                Past Due
              </span>
              <span className="text-sm font-bold text-destructive">{formatCurrency(financials.amountPastDue)}</span>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Full Season Remaining Balance</span>
            <span className="text-sm font-medium">{formatCurrency(financials.remainingBalance)}</span>
          </div>
          {!isUpfront && financials.remainingBalance <= 0 && financials.totalPaid > 0 && (
            <div className="flex items-center justify-center gap-2 rounded-md bg-green-500/10 p-3">
              <CheckCircle2 className="size-5 text-green-600" />
              <span className="text-sm font-semibold text-green-600">Season Paid in Full</span>
            </div>
          )}
        </div>
        {leagueId !== undefined && (
          <Link
            href={`/make-payment?leagueId=${leagueId}`}
            className="flex w-full items-center justify-center rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground no-underline transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Make A Payment
          </Link>
        )}
      </CardContent>
    </Card>
  );
};
