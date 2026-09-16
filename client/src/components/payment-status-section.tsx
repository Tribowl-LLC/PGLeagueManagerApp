import { FC } from "react";
import { useQuery } from "@tanstack/react-query";
import { csrfFetch } from "@/lib/queryClient";
import { PaymentOverviewCard } from "@/components/payment-overview-card";
import type { ApiResponse, League, Bowler } from "@shared/schema";
import type { CanonicalDuePastDueResponseV2 } from "@shared/roster-payment-contract";
import { deriveBowlerFinancials } from "@/lib/financial-utils";

interface PaymentStatusSectionProps {
  league: League;
  bowler: Bowler;
  weeklyFee: number;
}

/**
 * Dashboard read-only payment summary. Checkout and automatic-payment
 * consent live on the payment-history page; this component reads the same
 * canonical due contract and has no legacy schedule fallback.
 */
export const PaymentStatusSection: FC<PaymentStatusSectionProps> = ({ league, bowler, weeklyFee }) => {
  const { data, isLoading, error } = useQuery<ApiResponse<CanonicalDuePastDueResponseV2>>({
    queryKey: [`/api/financials/leagues/${league.id}/canonical-due-past-due/2`, bowler.id],
    queryFn: async () => {
      const response = await csrfFetch(`/api/financials/leagues/${league.id}/canonical-due-past-due/2?bowlerId=${bowler.id}`);
      if (!response.ok) throw new Error("Canonical payment evidence is unavailable");
      return response.json();
    },
    enabled: true,
    retry: false,
    staleTime: 30_000,
  });

  const report = data?.data;
  const summary = deriveBowlerFinancials(
    report?.rows ?? [],
    report?.asOf ?? "",
    report?.totals.collectiblePastDueMinor ?? 0,
  );
  const financials = {
    fullSeasonAmount: summary.fullSeasonAmount,
    totalDueToDate: summary.totalSeasonDues,
    totalPaid: summary.totalPaidAmount,
    amountPastDue: summary.amountPastDue,
    // Keep the dashboard's existing authoritative balance projection. The
    // profile/history surfaces expose review evidence separately before using
    // their collectible balance policy.
    remainingBalance: report?.totals.outstandingMinor ?? 0,
    waivedAmount: summary.waivedAmount,
  };

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading canonical payment evidence…</p>;
  if (error) return <p className="text-sm text-destructive">Canonical payment evidence requires review.</p>;

  return <PaymentOverviewCard weeklyFee={weeklyFee} leagueId={league.id} paymentMode={league.paymentMode} financials={financials} />;
};
