import { FC } from "react";
import { ChevronDown } from "lucide-react";
import type { League, BowlerLeague } from "@shared/schema";
import type { CanonicalPaymentRow, CanonicalPaymentTiming } from "@shared/canonical-payment-report";
import { CanonicalPaymentEvidenceTable } from "@/components/canonical-payment-evidence-table";
import { BowlerLayout } from "@/components/bowler-layout";
import { PaymentSummaryCards } from "@/components/payment-summary-cards";
import { ErrorBoundary } from "@/components/error-boundary";
import { LeagueSwitcherSheet } from "@/components/league-switcher-sheet";
import type { DoublePayStatus } from "@/lib/financial-utils";

interface PaymentHistoryContentProps {
  bowlerName: string;
  league: Pick<League, "id" | "name" | "weeklyFee" | "organizationId">;
  leagueId: number;
  hasMultipleLeagues: boolean;
  leagueSheetOpen: boolean;
  onOpenLeagueSheet: () => void;
  onCloseLeagueSheet: () => void;
  bowlerLeagues: BowlerLeague[];
  leagueMap: Map<number, League>;
  onSelectLeague: (leagueId: number) => void;
  totalWeeksInSeason: number;
  fullSeasonAmount: number;
  weeksDueCount: number;
  totalSeasonDues: number;
  weeksPaid: number;
  totalPaidAmount: number;
  amountPastDue: number;
  remainingBalance: number;
  doublePay: DoublePayStatus;
  canonicalPaymentLoading: boolean;
  canonicalPaymentError: Error | null;
  canonicalReportPage?: number;
  canonicalReportTotalPages?: number;
  onCanonicalReportPageChange?: (page: number) => void;
  canonicalRows?: CanonicalPaymentRow[];
  canonicalMode?: string;
  canonicalPaymentTiming?: CanonicalPaymentTiming;
}

export const PaymentHistoryContent: FC<PaymentHistoryContentProps> = ({
  bowlerName, league, leagueId, hasMultipleLeagues, leagueSheetOpen,
  onOpenLeagueSheet, onCloseLeagueSheet, bowlerLeagues, leagueMap,
  onSelectLeague, totalWeeksInSeason, fullSeasonAmount, weeksDueCount,
  totalSeasonDues, weeksPaid, totalPaidAmount, amountPastDue, remainingBalance,
  doublePay, canonicalPaymentLoading, canonicalPaymentError, canonicalReportPage,
  canonicalReportTotalPages, onCanonicalReportPageChange, canonicalRows = [],
  canonicalMode, canonicalPaymentTiming,
}) => {
  const makePaymentHref = `/make-payment?leagueId=${leagueId}`;
  const pastDueHref = `${makePaymentHref}&intent=past-due`;

  return (
    <BowlerLayout bowlerName={bowlerName} leagueName={league.name} currentLeagueId={leagueId}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold mb-1">Payment History</h1>
          {hasMultipleLeagues ? (
            <button type="button" onClick={onOpenLeagueSheet} className="flex items-center gap-1 text-slate-500 hover:text-slate-700 transition-colors mb-4">
              <span>{league.name}</span><ChevronDown className="size-4" />
            </button>
          ) : <p className="text-muted-foreground mb-4">{league.name}</p>}
        </div>

        <ErrorBoundary level="section">
          <PaymentSummaryCards
            totalWeeksInSeason={totalWeeksInSeason}
            fullSeasonAmount={fullSeasonAmount}
            weeklyFee={league.weeklyFee || 0}
            weeksDueCount={weeksDueCount}
            totalSeasonDues={totalSeasonDues}
            weeksPaid={weeksPaid}
            totalPaidAmount={totalPaidAmount}
            amountPastDue={amountPastDue}
            remainingBalance={remainingBalance}
            doublePay={doublePay}
            onPayPastDue={() => undefined}
            onPayRemaining={() => undefined}
            pastDueHref={pastDueHref}
            remainingHref={makePaymentHref}
          />
        </ErrorBoundary>

        <ErrorBoundary level="section">
          {canonicalPaymentLoading ? (
            <div className="text-sm text-muted-foreground">Loading canonical payment evidence…</div>
          ) : canonicalPaymentError ? (
            <div className="text-sm text-destructive">Financial evidence requires review; payment history is unavailable.</div>
          ) : (
            <CanonicalPaymentEvidenceTable rows={canonicalRows} mode={canonicalMode} paymentTiming={canonicalPaymentTiming} organizationId={league.organizationId} title="Payment history" />
          )}
          {!canonicalPaymentLoading && !canonicalPaymentError && canonicalReportPage !== undefined && canonicalReportTotalPages !== undefined && canonicalReportTotalPages > 1 && onCanonicalReportPageChange && (
            <div className="mt-3 flex items-center justify-between text-sm">
              <span>Canonical payment page {canonicalReportPage} of {canonicalReportTotalPages}</span>
              <button type="button" className="underline" disabled={canonicalReportPage >= canonicalReportTotalPages} onClick={() => onCanonicalReportPageChange(canonicalReportPage + 1)}>Next page</button>
            </div>
          )}
        </ErrorBoundary>
      </div>

      <LeagueSwitcherSheet open={leagueSheetOpen} onClose={onCloseLeagueSheet} bowlerLeagues={bowlerLeagues} leagueMap={leagueMap} selectedLeagueId={leagueId} onSelect={onSelectLeague} />
    </BowlerLayout>
  );
};
