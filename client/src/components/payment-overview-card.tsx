import { FC, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Loader2, CreditCard, CircleDollarSign, AlertTriangle, CheckCircle2 } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency } from "@/lib/utils";
import { format, parseISO } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { DEFAULT_TIMEZONE } from "@shared/schema";
import type { League } from "@shared/schema";

interface ScheduleData {
  id: number;
  frequency: string;
  nextPaymentDate: string;
  amount: number;
  active: boolean;
  leagueTimezone?: string;
}

interface FinancialsData {
  fullSeasonAmount: number;
  totalDueToDate: number;
  totalPaid: number;
  amountPastDue: number;
  remainingBalance: number;
  doublePay: {
    dates: string[];
    perWeekExtra: number;
    totalExtra: number;
    pastExtra: number;
    isPaid: boolean;
  };
}

interface PaymentOverviewCardProps {
  league: League;
  weeklyFee: number;
  financials: FinancialsData;
  activeSchedule?: ScheduleData;
  bowlerId: number;
  onSetupPayment: (mode: 'autopay' | 'onetime') => void;
}

export const PaymentOverviewCard: FC<PaymentOverviewCardProps> = ({
  league,
  weeklyFee,
  financials,
  activeSchedule,
  bowlerId,
  onSetupPayment,
}) => {
  const { toast } = useToast();
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);

  const cancelScheduleMutation = useMutation({
    mutationFn: async (scheduleId: number) => {
      return apiRequest(`/api/payment-schedules/${scheduleId}`, 'DELETE');
    },
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: [`/api/payment-schedules/${bowlerId}/${league.id}`] });
      setShowCancelConfirm(false);
      toast({ title: "Auto-pay cancelled", description: "Your automatic payment schedule has been cancelled." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to cancel auto-pay. Please try again.", variant: "destructive" });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Payment Overview</CardTitle>
      </CardHeader>
      <CardContent className="pt-6 space-y-4">
        {league.payingLineupSize != null && <p className="text-sm text-muted-foreground">Payments are selected from exact roster obligations. Automatic collection is unavailable until PR2.</p>}
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

          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Payment Schedule</span>
            <span className="text-sm font-medium">
              {activeSchedule
                ? activeSchedule.frequency === 'upfront'
                  ? `Full season (${formatCurrency(activeSchedule.amount)})`
                  : `Auto-pay: ${formatCurrency(activeSchedule.amount)}/${activeSchedule.frequency === 'weekly' ? 'week' : 'month'}`
                : 'No payment set up'}
            </span>
          </div>

          {activeSchedule && (
            <div className="flex items-center justify-between pl-5">
              <span className="text-xs text-muted-foreground">Next payment</span>
              <span className="text-xs text-muted-foreground">
                {formatInTimeZone(new Date(activeSchedule.nextPaymentDate), activeSchedule.leagueTimezone || DEFAULT_TIMEZONE, 'MMM d, yyyy h:mm a')}
              </span>
            </div>
          )}

          {league.paymentMode !== 'upfront' && financials.doublePay.dates.length > 0 && (
            <div className="rounded-md bg-emerald-500/10 px-3 py-2 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
                  <CircleDollarSign className="size-3.5" />
                  Double-Pay Weeks
                </span>
                <span className="text-sm font-bold text-emerald-700 dark:text-emerald-400">
                  {formatCurrency(financials.doublePay.perWeekExtra * 2)}/week
                </span>
              </div>
              <ul className="text-xs text-muted-foreground pl-5 space-y-0.5">
                {financials.doublePay.dates.map((d) => (
                  <li key={d} className="flex justify-between">
                    <span>{format(parseISO(d), 'MMM d, yyyy')}</span>
                    <span>{formatCurrency(financials.doublePay.perWeekExtra * 2)}</span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground pl-5">
                Last {financials.doublePay.dates.length} regular week
                {financials.doublePay.dates.length === 1 ? '' : 's'} bill $0; season total unchanged.
              </p>
            </div>
          )}
        </div>

        <Separator />

        {league.payingLineupSize == null && activeSchedule && !showCancelConfirm && (
          <Button
            variant="ghost"
            onClick={() => setShowCancelConfirm(true)}
            className="w-full text-destructive hover:text-destructive hover:bg-destructive/10"
          >
            Cancel Auto-Pay
          </Button>
        )}

        {league.payingLineupSize == null && activeSchedule && showCancelConfirm && (
          <div className="space-y-3 rounded-md border border-destructive/30 bg-destructive/5 p-3">
            <p className="text-sm font-medium">Are you sure you want to cancel auto-pay?</p>
            <p className="text-xs text-muted-foreground">You will need to set it up again if you change your mind.</p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setShowCancelConfirm(false)} className="flex-1" size="sm">
                Keep It
              </Button>
              <Button
                variant="destructive"
                onClick={() => cancelScheduleMutation.mutate(activeSchedule.id)}
                disabled={cancelScheduleMutation.isPending}
                className="flex-1"
                size="sm"
              >
                {cancelScheduleMutation.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                Yes, Cancel
              </Button>
            </div>
          </div>
        )}

        {league.payingLineupSize == null && !activeSchedule && financials.remainingBalance > 0 && league.paymentMode === 'upfront' && (
          <div className="space-y-2">
            <Button className="w-full" onClick={() => onSetupPayment('onetime')}>
              {financials.totalPaid > 0 ? 'Pay Remaining Balance' : 'Pay Full Season'} ({formatCurrency(financials.remainingBalance)})
              <CreditCard className="ml-2 size-4" />
            </Button>
          </div>
        )}

        {league.payingLineupSize == null && !activeSchedule && financials.remainingBalance > 0 && league.paymentMode !== 'upfront' && (
          <div className="space-y-2">
            <Button onClick={() => onSetupPayment('autopay')} className="w-full">
              {financials.amountPastDue > 0
                ? `Pay ${formatCurrency(financials.amountPastDue)} & Set Up Auto-Pay`
                : 'Set Up Auto-Pay'}
              <CreditCard className="ml-2 size-4" />
            </Button>
            <Button variant="outline" onClick={() => onSetupPayment('onetime')} className="w-full">
              Make One-Time Payment
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
