import { FC } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import type { League } from "@shared/schema";

interface FinancialsData {
  fullSeasonAmount: number;
  totalDueToDate: number;
  totalPaid: number;
  amountPastDue: number;
  remainingBalance: number;
}

interface PaymentOverviewCardProps {
  league: League;
  weeklyFee: number;
  financials: FinancialsData;
}

/** Read-only canonical payment summary for the bowler dashboard. */
export const PaymentOverviewCard: FC<PaymentOverviewCardProps> = ({ league, weeklyFee, financials }) => (
  <Card>
    <CardHeader>
      <CardTitle>Payment Overview</CardTitle>
    </CardHeader>
    <CardContent className="pt-6 space-y-4">
      <p className="text-sm text-muted-foreground">
        {league.name} payments are based on exact canonical roster obligations. Make a payment or manage automatic payments from Payment History.
      </p>
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Full Season Total Due</span>
          <span className="text-sm font-medium">{formatCurrency(financials.fullSeasonAmount)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Weekly Fee</span>
          <span className="text-sm font-medium">{formatCurrency(weeklyFee)}/week</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Amount Due to Date</span>
          <span className="text-sm font-medium">{formatCurrency(financials.totalDueToDate)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Amount Paid to Date</span>
          <span className="text-sm font-medium">{formatCurrency(financials.totalPaid)}</span>
        </div>
        {financials.amountPastDue > 0 && (
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
        {financials.remainingBalance <= 0 && financials.totalPaid > 0 && (
          <div className="flex items-center justify-center gap-2 rounded-md bg-green-500/10 p-3">
            <CheckCircle2 className="size-5 text-green-600" />
            <span className="text-sm font-semibold text-green-600">Season Paid in Full</span>
          </div>
        )}
      </div>
    </CardContent>
  </Card>
);
