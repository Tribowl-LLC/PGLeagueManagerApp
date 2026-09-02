import { FC } from "react";
import { useQuery } from "@tanstack/react-query";
import { csrfFetch } from "@/lib/queryClient";
import { PaymentOverviewCard } from "@/components/payment-overview-card";
import type { League, Bowler, Payment } from "@shared/schema";

type DueRow = {
  amountMinor: number;
  allocatedMinor: number;
  outstandingMinor: number;
  classification: "future" | "due" | "past_due" | "settled" | "voided" | "review_required";
};

interface CanonicalDueResponse {
  data?: {
    rows: DueRow[];
    totals: {
      amountMinor: number;
      allocatedMinor: number;
      outstandingMinor: number;
      collectiblePastDueMinor: number;
    };
  };
}

interface PaymentStatusSectionProps {
  league: League;
  bowler: Bowler;
  weeklyFee: number;
  totalWeeks: number;
  payments: Payment[];
}

/**
 * Dashboard read-only payment summary. Checkout and automatic-payment
 * consent live on the payment-history page; this component reads the same
 * canonical due contract and has no legacy schedule fallback.
 */
export const PaymentStatusSection: FC<PaymentStatusSectionProps> = ({ league, bowler, weeklyFee }) => {
  const { data, isLoading, error } = useQuery<CanonicalDueResponse>({
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

  const rows = data?.data?.rows ?? [];
  const totals = data?.data?.totals;
  const financials = {
    fullSeasonAmount: totals?.amountMinor ?? 0,
    totalDueToDate: rows.filter((row) => row.classification !== "future").reduce((sum, row) => sum + row.amountMinor, 0),
    totalPaid: totals?.allocatedMinor ?? 0,
    amountPastDue: totals?.collectiblePastDueMinor ?? 0,
    remainingBalance: totals?.outstandingMinor ?? 0,
  };

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading canonical payment evidence…</p>;
  if (error) return <p className="text-sm text-destructive">Canonical payment evidence requires review.</p>;

  return <PaymentOverviewCard weeklyFee={weeklyFee} financials={financials} />;
};
