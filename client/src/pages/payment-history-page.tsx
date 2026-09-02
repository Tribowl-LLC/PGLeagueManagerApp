import { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Payment, User, ApiResponse, BowlerDetailsResponse } from "@shared/schema";
import type { CanonicalPaymentReport } from "@shared/canonical-payment-report";
import type { CanonicalDuePastDueResponseV2 } from "@shared/roster-payment-contract";
import { PageLoadingState } from "@/components/page-states";
import { useLocation, useSearch } from "wouter";
import { useSelectedLeague } from "@/hooks/use-selected-league";
import { PaymentHistoryContent } from "./payment-history-page/payment-history-content";
import { AuthErrorView } from "./payment-history-page/auth-error-view";
import { NoBowlerView } from "./payment-history-page/no-bowler-view";
import { BowlerErrorView } from "./payment-history-page/bowler-error-view";
import { NoLeaguesView } from "./payment-history-page/no-leagues-view";
import { NoLeagueView } from "./payment-history-page/no-league-view";
import { resolveInteractiveFinancialRead } from "@/lib/financial-read-contract";
import { paymentHistoryFinancialQueryKey } from "@/lib/payment-history-financial-query";

export default function PaymentHistoryPage() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const urlLeagueId = new URLSearchParams(search).get("leagueId");
  const [selectedLeagueId, setSelectedLeagueId] = useSelectedLeague(urlLeagueId ? Number(urlLeagueId) : undefined);
  const [leagueSheetOpen, setLeagueSheetOpen] = useState(false);
  const [canonicalReportPage, setCanonicalReportPage] = useState(1);

  const { data: currentUser, isLoading: loadingUser, error: userError } = useQuery<ApiResponse<User>>({ queryKey: ["/api/user"] });
  const bowlerId = currentUser?.data?.bowlerId;
  const { data: detailsResponse, isLoading: loadingDetails, error: bowlerError } = useQuery<ApiResponse<BowlerDetailsResponse>>({
    queryKey: [`/api/bowlers/${bowlerId}/details`, { includePayments: true }],
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/bowlers/${bowlerId}/details?includePayments=true`, { credentials: "include", headers: { Accept: "application/json" }, signal });
      if (!response.ok) throw new Error((await response.json().catch(() => ({})))?.error?.message || "Failed to fetch bowler details");
      return response.json();
    },
    enabled: !!bowlerId,
  });
  const details = detailsResponse?.data;
  const bowlerLeagues = useMemo(() => details?.bowlerLeagues ?? [], [details?.bowlerLeagues]);
  const hasMultipleLeagues = bowlerLeagues.length > 1;

  useEffect(() => {
    if (!bowlerLeagues.length) return;
    const validIds = bowlerLeagues.map((membership) => membership.leagueId);
    if (selectedLeagueId !== null && !validIds.includes(selectedLeagueId)) setSelectedLeagueId(validIds[0]);
  }, [bowlerLeagues, selectedLeagueId, setSelectedLeagueId]);

  const leagueId = selectedLeagueId ?? bowlerLeagues[0]?.leagueId;
  const leagueMap = useMemo(() => new Map((details?.leagues ?? []).map((league) => [league.id, league])), [details?.leagues]);
  const league = leagueId === undefined ? undefined : leagueMap.get(leagueId);
  const allPayments = details?.payments;
  const hasPayments = Array.isArray(allPayments);
  const { data: paymentsResponse, isLoading: loadingPayments } = useQuery<ApiResponse<Payment[]>>({
    queryKey: ["/api/payments", { bowlerId, leagueId }],
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/payments?bowlerId=${bowlerId}&leagueId=${leagueId}`, { credentials: "include", headers: { Accept: "application/json" }, signal });
      if (!response.ok) throw new Error("Failed to fetch payments");
      return response.json();
    },
    enabled: !!bowlerId && !!leagueId && !!details && !hasPayments,
  });
  const { data: reportResponse, isLoading: loadingReport, error: reportError, refetch: refetchReport } = useQuery<ApiResponse<CanonicalPaymentReport>>({
    queryKey: ["/api/financials/f5/payments", { bowlerId, leagueId, page: canonicalReportPage }],
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/financials/f5/payments?leagueId=${leagueId}&bowlerId=${bowlerId}&page=${canonicalReportPage}&limit=200`, { credentials: "include", headers: { Accept: "application/json" }, signal });
      if (!response.ok) throw new Error("Payment evidence requires review");
      return response.json();
    },
    enabled: !!bowlerId && !!leagueId,
    staleTime: 30_000,
    retry: false,
  });
  const { data: financialResponse, isLoading: loadingFinancial } = useQuery<ApiResponse<CanonicalDuePastDueResponseV2>>({
    queryKey: paymentHistoryFinancialQueryKey(leagueId ?? 0, bowlerId ?? 0),
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/financials/leagues/${leagueId}/canonical-due-past-due/2?bowlerId=${bowlerId}`, { credentials: "include", headers: { Accept: "application/json" }, signal });
      if (!response.ok) throw new Error("Financial evidence is unavailable");
      return response.json();
    },
    enabled: !!bowlerId && !!leagueId,
    staleTime: 30_000,
    retry: false,
  });

  const report = reportResponse?.data;
  const resolved = useMemo(() => resolveInteractiveFinancialRead(financialResponse?.data), [financialResponse?.data]);
  const rows = resolved.status === "canonical" ? resolved.rows : [];
  const financials = {
    weeksPassed: rows.filter((row) => row.classification !== "future").length,
    totalWeeksInSeason: rows.length,
    totalDueToDate: rows.filter((row) => row.classification !== "future").reduce((sum, row) => sum + row.amountMinor, 0),
    totalPaid: rows.reduce((sum, row) => sum + row.allocatedMinor, 0),
    amountPastDue: resolved.amountPastDue,
    fullSeasonAmount: rows.reduce((sum, row) => sum + row.amountMinor, 0),
    remainingBalance: resolved.remainingBalance,
    doublePay: { dates: [], perWeekExtra: 0, totalExtra: 0, pastExtra: 0, isPaid: resolved.remainingBalance <= 0 },
  };

  if (loadingUser || loadingDetails || loadingReport || loadingFinancial || (!hasPayments && loadingPayments)) {
    return <PageLoadingState />;
  }
  if (userError) return <AuthErrorView />;
  if (currentUser?.data && !currentUser.data.bowlerId) return <NoBowlerView userName={currentUser.data.name} isSystemAdmin={currentUser.data.role === "system_admin"} />;
  if (bowlerId && bowlerError) return <BowlerErrorView />;
  const bowlerName = details?.bowler?.name ?? "";
  if (!bowlerLeagues.length) return <NoLeaguesView bowlerName={bowlerName} />;
  if (!league || leagueId === undefined) return <NoLeagueView bowlerName={bowlerName} bowlerId={bowlerId} leagueId={leagueId} />;

  return <PaymentHistoryContent
    bowlerName={bowlerName}
    league={league}
    leagueId={leagueId}
    hasMultipleLeagues={hasMultipleLeagues}
    leagueSheetOpen={leagueSheetOpen}
    onOpenLeagueSheet={() => setLeagueSheetOpen(true)}
    onCloseLeagueSheet={() => setLeagueSheetOpen(false)}
    bowlerLeagues={bowlerLeagues}
    leagueMap={leagueMap}
    onSelectLeague={(nextId) => { setSelectedLeagueId(nextId); setCanonicalReportPage(1); navigate(`/payment-history?leagueId=${nextId}`); }}
    totalWeeksInSeason={financials.totalWeeksInSeason}
    fullSeasonAmount={financials.fullSeasonAmount}
    weeksDueCount={financials.weeksPassed}
    totalSeasonDues={financials.totalDueToDate}
    weeksPaid={league.weeklyFee ? Math.round(financials.totalPaid / league.weeklyFee) : 0}
    totalPaidAmount={financials.totalPaid}
    amountPastDue={financials.amountPastDue}
    remainingBalance={financials.remainingBalance}
    doublePay={financials.doublePay}
    canonicalPaymentLoading={loadingReport}
    canonicalPaymentError={reportError}
    onCanonicalReportRetry={() => { void refetchReport(); }}
    canonicalReportPage={canonicalReportPage}
    canonicalReportTotalPages={report ? Math.max(1, Math.ceil(report.totalTransactions / report.limit)) : undefined}
    onCanonicalReportPageChange={setCanonicalReportPage}
    canonicalRows={report?.rows ?? []}
    canonicalMode={report?.mode}
    canonicalPaymentTiming={report?.paymentTiming}
  />;
}
