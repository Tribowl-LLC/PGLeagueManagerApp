/* eslint-disable shadcn/no-unknown-classes */
import { FC } from "react";
import type { League, BowlerLeague, Team } from "@shared/schema";
import type { CanonicalPaymentRow } from "@shared/canonical-payment-report";
import { CanonicalPaymentEvidenceTable } from "@/components/canonical-payment-evidence-table";
import { BowlerLayout } from "@/components/bowler-layout";
import { PaymentSummaryCards } from "@/components/payment-summary-cards";
import { ErrorBoundary } from "@/components/error-boundary";
import { PageErrorState } from "@/components/page-states";
import { LeagueBottomSheet } from "@/components/league-bottom-sheet";
import type { DoublePayStatus } from "@/lib/financial-utils";
import type { RotatingCreditDisplayState } from "@/components/payment-status-section";

const EMPTY_TEAM_MAP = new Map<number, Team>();

interface PaymentHistoryContentProps {
  bowlerName: string;
  viewerRole?: string;
  league: Pick<League, "id" | "name" | "weeklyFee" | "organizationId">;
  teamName?: string | null;
  leagueStartTime?: string | null;
  leagueId: number;
  hasMultipleLeagues: boolean;
  leagueSheetOpen: boolean;
  onOpenLeagueSheet: () => void;
  onCloseLeagueSheet: () => void;
  bowlerLeagues: BowlerLeague[];
  leagueMap: Map<number, League>;
  teamMap?: Map<number, Team>;
  onSelectLeague: (leagueId: number) => void;
  totalWeeksInSeason: number;
  fullSeasonAmount: number;
  weeksDueCount: number;
  totalSeasonDues: number;
  weeksPaid: number | null;
  totalPaidAmount: number;
  waivedAmount?: number;
  amountPastDue: number;
  remainingBalance: number;
  doublePay: DoublePayStatus;
  canonicalPaymentLoading: boolean;
  canonicalPaymentError: Error | null;
  onCanonicalReportRetry?: () => void;
  canonicalReportPage?: number;
  canonicalReportTotalPages?: number;
  onCanonicalReportPageChange?: (page: number) => void;
  canonicalRows?: CanonicalPaymentRow[];
  canonicalReportTotalTransactions?: number;
  rotatingCreditState?: RotatingCreditDisplayState;
  isRotating?: boolean;
}

export const PaymentHistoryContent: FC<PaymentHistoryContentProps> = ({
  bowlerName, viewerRole, league, teamName, leagueStartTime, leagueId, hasMultipleLeagues, leagueSheetOpen,
  onOpenLeagueSheet, onCloseLeagueSheet, bowlerLeagues, leagueMap,
  teamMap, onSelectLeague, totalWeeksInSeason, fullSeasonAmount, weeksDueCount,
  totalSeasonDues, weeksPaid, totalPaidAmount, amountPastDue, remainingBalance,
  waivedAmount,
  doublePay, canonicalPaymentLoading, canonicalPaymentError, canonicalReportPage,
  onCanonicalReportRetry, canonicalReportTotalPages, onCanonicalReportPageChange, canonicalRows = [], canonicalReportTotalTransactions,
  rotatingCreditState = "standard", isRotating = false,
}) => {
  const makePaymentHref = `/make-payment?leagueId=${leagueId}`;
  const pastDueHref = `${makePaymentHref}&intent=past-due`;

  return (
    <BowlerLayout
      bowlerName={bowlerName}
      leagueName={league.name}
      teamName={teamName}
      leagueStartTime={leagueStartTime}
      currentLeagueId={leagueId}
      onOpenLeagueSheet={onOpenLeagueSheet}
      mobileLeagueSwitchEnabled={hasMultipleLeagues}
    >
      <div className="familiar-payment-history-content space-y-6">
        <header className="familiar-bowler-page-heading">
          <h1>Payment history</h1>
          <p>Every payment, all in one place.</p>
        </header>

        <div className="familiar-payment-history-summary">
          <ErrorBoundary level="section">
            {rotatingCreditState === "loading" ? (
              <p className="text-sm text-muted-foreground">Loading payment summary…</p>
            ) : rotatingCreditState === "error" ? (
              <p className="text-sm text-destructive">Payment summary requires review.</p>
            ) : (
              <PaymentSummaryCards
                totalWeeksInSeason={totalWeeksInSeason}
                fullSeasonAmount={fullSeasonAmount}
                weeklyFee={league.weeklyFee || 0}
                weeksDueCount={weeksDueCount}
                totalSeasonDues={totalSeasonDues}
                weeksPaid={weeksPaid}
                totalPaidAmount={totalPaidAmount}
                waivedAmount={waivedAmount}
                amountPastDue={amountPastDue}
                remainingBalance={remainingBalance}
                doublePay={doublePay}
                isRotating={isRotating}
                onPayPastDue={() => undefined}
                onPayRemaining={() => undefined}
                pastDueHref={amountPastDue > 0 ? pastDueHref : undefined}
                remainingHref={remainingBalance > 0 ? makePaymentHref : undefined}
              />
            )}
          </ErrorBoundary>
        </div>

        <div className="familiar-payment-history-transactions">
          <ErrorBoundary level="section">
            {canonicalPaymentLoading ? (
              <div className="text-sm text-muted-foreground">Loading payment history…</div>
            ) : canonicalPaymentError ? (
              <PageErrorState message="Payment history is unavailable; please try again." onRetry={onCanonicalReportRetry} />
            ) : (
              <CanonicalPaymentEvidenceTable rows={canonicalRows} organizationId={league.organizationId} bowlerName={bowlerName} title="Transactions" totalTransactions={canonicalReportTotalTransactions} variant="bowler" leagueName={league.name} totalWeeksInSeason={totalWeeksInSeason} />
            )}
            {!canonicalPaymentLoading && !canonicalPaymentError && canonicalReportPage !== undefined && canonicalReportTotalPages !== undefined && canonicalReportTotalPages > 1 && onCanonicalReportPageChange && (
              <div className="mt-3 flex items-center justify-between text-sm">
                <button type="button" className="underline disabled:opacity-50" disabled={canonicalReportPage <= 1} onClick={() => onCanonicalReportPageChange(Math.max(1, canonicalReportPage - 1))}>Previous</button>
                <span>Page {canonicalReportPage} of {canonicalReportTotalPages}</span>
                <button type="button" className="underline disabled:opacity-50" disabled={canonicalReportPage >= canonicalReportTotalPages} onClick={() => onCanonicalReportPageChange(canonicalReportPage + 1)}>Next</button>
              </div>
            )}
          </ErrorBoundary>
        </div>
      </div>

      <LeagueBottomSheet
        open={leagueSheetOpen}
        onClose={onCloseLeagueSheet}
        activeBowlerLeagues={bowlerLeagues}
        leagueMap={leagueMap}
        teamMap={teamMap ?? EMPTY_TEAM_MAP}
        selectedLeagueId={leagueId}
        onSelectLeague={onSelectLeague}
        viewerRole={viewerRole}
      />
    </BowlerLayout>
  );
};
