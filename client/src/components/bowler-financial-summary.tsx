import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { League } from "@shared/schema";
import type { BowlerViewFinancials } from "@/lib/financial-utils";

interface Props {
  league: League | undefined;
  financials: BowlerViewFinancials;
  sourceLabel?: string;
}

export function BowlerFinancialSummary({ league, financials, sourceLabel }: Props) {
  const weeklyFee = (league?.weeklyFee || 0) / 100;
  const {
    weeksDue,
    totalSeasonDues,
    totalWeeksInSeason,
    fullSeasonAmount,
    amountPastDue,
    remainingBalance,
    totalPaidAmount,
    reviewRequired,
    reviewCategory,
  } = financials;

  const isUpfront = league?.paymentMode === "upfront";
  const dueToDateDescription = isUpfront
    ? "Full season due in week 1"
    : `${weeksDue} week${weeksDue === 1 ? "" : "s"} at $${weeklyFee.toFixed(2)}`;
  const pastDueDescription = isUpfront
    ? "Unpaid full-season balance"
    : "Unpaid fees for weeks passed";

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
      {reviewRequired && <div className="md:col-span-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">Review required: {reviewCategory ?? "financial evidence"}. This evidence remains visible and is excluded from collectible totals until reviewed.</div>}
      <SummaryCard title="Weekly Fee" description={sourceLabel ? `Server source: ${sourceLabel}` : "Regular payment amount"} value={`$${weeklyFee.toFixed(2)}`} />
      <SummaryCard
        title="Amount Due to Date"
        description={dueToDateDescription}
        value={`$${(totalSeasonDues / 100).toFixed(2)}`}
      />
      <SummaryCard
        title="Amount Paid to Date"
        description="All payments received"
        value={`$${(totalPaidAmount / 100).toFixed(2)}`}
      />
      <SummaryCard
        title="Amount Past Due to Date"
        description={pastDueDescription}
        value={`$${(amountPastDue / 100).toFixed(2)}`}
        valueClass="text-destructive"
      />
      <SummaryCard
        title="Full Season Lineage Amount Due"
        description={`${totalWeeksInSeason} week${totalWeeksInSeason === 1 ? "" : "s"} at $${weeklyFee.toFixed(2)}`}
        value={`$${(fullSeasonAmount / 100).toFixed(2)}`}
        valueClass="text-orange-600"
      />
      <SummaryCard
        title="Full Season Remaining Balance"
        description="Amount left to pay"
        value={`$${(remainingBalance / 100).toFixed(2)}`}
        valueClass="text-orange-600"
      />
    </div>
  );
}

function SummaryCard({
  title,
  description,
  value,
  valueClass = "",
}: {
  title: string;
  description: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <p className={`text-2xl font-bold ${valueClass}`}>{value}</p>
      </CardContent>
    </Card>
  );
}
