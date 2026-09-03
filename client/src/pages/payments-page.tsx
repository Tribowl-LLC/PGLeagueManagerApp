import { useState, useMemo, useCallback, useEffect } from "react";
import { useQuery, useMutation, useQueries } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Layout } from "@/components/layout";
import { ErrorBoundary } from "@/components/error-boundary";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";
import { PageLoadingState } from "@/components/page-states";
import type {
  Payment,
  PaymentRowDisputeSummary,
  Bowler,
  League,
  PaginationMeta,
  ApiResponse,
  User,
} from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  isProviderNotConfiguredError,
  providerNotConfiguredToast,
} from "@/lib/provider-not-configured";
import { sanitizePaymentErrorMessage } from "@/lib/payment-user-error";
import { refundOperationToast } from "@/lib/refund-operation";
import { useToast } from "@/hooks/use-toast";
import { PaymentsTable } from "@/components/payments-table";
import { RefundPaymentDialog } from "@/components/refund-payment-dialog";
import { PaginationControls } from "@/components/pagination-controls";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { CanonicalPaymentReport } from "@shared/canonical-payment-report";

const PAGE_SIZE_OPTIONS = [25, 50, 100];
const DEFAULT_PAGE_SIZE = 50;

interface PaginatedPaymentsResponse {
  success: boolean;
  data: Array<Payment & { disputes: PaymentRowDisputeSummary[] }>;
  pagination: PaginationMeta;
}

export default function PaymentsPage() {
  const [paymentToRefund, setPaymentToRefund] = useState<Payment | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [selectedLeagueId, setSelectedLeagueId] = useState<number | undefined>(() => {
    if (typeof window === "undefined") return undefined;
    const raw = new URLSearchParams(window.location.search).get("leagueId");
    if (!raw || !/^\d+$/.test(raw)) return undefined;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  });
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const { data: userResponse } = useQuery<ApiResponse<User>>({
    queryKey: ["/api/user"],
    staleTime: 1000 * 60 * 5,
  });
  const isAdmin = userResponse?.data?.role === 'system_admin'
    || userResponse?.data?.role === 'org_admin'
    || String(userResponse?.data?.role) === 'payment_manager';
  const isPaymentManager = String(userResponse?.data?.role) === 'payment_manager';
  const includeDisputes = !isPaymentManager;

  const { data: leaguesResponse } = useQuery<{ data: League[] }>({
    queryKey: ["/api/leagues"],
    staleTime: 1000 * 60 * 30,
  });

  const { data: paymentsResponse, isLoading: loadingPayments } = useQuery<PaginatedPaymentsResponse>({
    queryKey: ["/api/payments", "paginated", includeDisputes ? "with-disputes" : "without-disputes", page, pageSize],
    queryFn: async () => {
      const disputeQuery = includeDisputes ? "&includeDisputes=true" : "";
      const res = await fetch(
        `/api/payments?page=${page}&limit=${pageSize}${disputeQuery}`,
        {
        credentials: "include",
        headers: { "Accept": "application/json" },
        },
      );
      if (!res.ok) throw new Error(`${res.status}: ${res.statusText}`);
      return res.json();
    },
    refetchOnWindowFocus: "always",
    staleTime: 1000 * 60,
    enabled: !!userResponse?.data,
  });

  const { data: bowlersResponse, isLoading: loadingBowlers } = useQuery<{ data: Bowler[] }>({
    queryKey: ["/api/bowlers"],
    enabled: !!paymentsResponse?.data?.length,
    staleTime: 1000 * 60 * 5,
  });

  // Derive the active refund target's locationId so we can look up its
  // payment provider ahead of the mutation. The lookup is cached inside
  // `usePaymentProvider` per locationId, so toggling between rows in the
  // refund dialog doesn't refetch on every click.
  const refundLocationId = paymentToRefund
    ? (leaguesResponse?.data ?? []).find((l) => l.id === paymentToRefund.leagueId)?.locationId ?? null
    : null;

  const refundPaymentMutation = useMutation({
    mutationFn: async ({ id, reason }: { id: number; reason?: string }) => {
      const response = await apiRequest(`/api/payments/${id}/refund`, "POST", { reason });
      if (!response.success) {
        throw new Error(response.error?.message || "Failed to process refund");
      }
      return response.data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/payments"] });
      toast(refundOperationToast(data));
      setPaymentToRefund(null);
    },
    onError: (error: Error) => {
      if (isProviderNotConfiguredError(error)) {
        // Surface the actionable "Square isn't connected" message
        // (#391) so admins can jump straight to /integrations
        // instead of seeing a generic "Refund Failed" toast.
        toast(providerNotConfiguredToast({
          navigate,
          locationId: refundLocationId,
        }));
        return;
      }
      // Task #598: surface the typed PaymentProviderError userMessage
      // (e.g. "Your payment was declined. Please try a different card.")
      // straight to the admin instead of the old generic "Failed to
      // process refund" wall. The sanitizer is the same belt-and-braces
      // guard the charge-side toasts use.
      toast({
        title: "Refund Failed",
        description: sanitizePaymentErrorMessage(error, "Failed to process refund"),
        variant: "destructive",
      });
    },
  });

  const payments = useMemo(() => paymentsResponse?.data || [], [paymentsResponse?.data]);
  const bowlers = useMemo(() => bowlersResponse?.data || [], [bowlersResponse?.data]);
  const leagues = useMemo(() => leaguesResponse?.data ?? [], [leaguesResponse?.data]);
  // A league action card carries its league context into the records page.
  // If that league is not present in the server-authorized list (for example,
  // a stale bookmark or a location-scoped payment manager), fall back to the
  // first accessible league rather than rendering an empty financial report.
  // Derive the fallback before building report queries so an inaccessible
  // query parameter cannot produce an empty/unscoped intermediate report.
  const accessibleSelectedLeagueId = selectedLeagueId !== undefined
    && leagues.some((league) => league.id === selectedLeagueId)
    ? selectedLeagueId
    : leagues[0]?.id;
  useEffect(() => {
    if (accessibleSelectedLeagueId !== undefined && accessibleSelectedLeagueId !== selectedLeagueId) {
      setSelectedLeagueId(accessibleSelectedLeagueId);
      setPage(1);
    }
  }, [accessibleSelectedLeagueId, selectedLeagueId]);
  const reportLeagues = accessibleSelectedLeagueId === undefined
    ? []
    : leagues.filter((league) => league.id === accessibleSelectedLeagueId);
  const financialReports = useQueries({
    queries: reportLeagues.map((league) => ({
      queryKey: ["/api/financials/f5/payments", league.id, page, pageSize, userResponse?.data?.organizationId, userResponse?.data?.role],
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        const organizationScope = userResponse?.data?.role === "system_admin" && userResponse.data.organizationId
          ? `&organizationId=${encodeURIComponent(userResponse.data.organizationId)}` : "";
        const response = await fetch(`/api/financials/f5/payments?leagueId=${league.id}&page=${page}&limit=${pageSize}${organizationScope}`, {
          credentials: "include",
          headers: { Accept: "application/json" },
          signal,
        });
        if (!response.ok) throw new Error("Financial evidence requires review");
        return response.json() as Promise<{ data: CanonicalPaymentReport }>;
      },
      enabled: !!userResponse?.data,
      staleTime: 1000 * 60,
      retry: false,
    })),
  });
  const financialReportData = financialReports.map((result) => result.data?.data);
  const financialReportError = financialReports.find((result) => result.error)?.error;
  const missingFinancialReport = leagues.length > 0 && financialReports.some((result) => !result.data);
  const paymentBusinessDates = (() => {
    const map = new Map<number, string>();
    for (const report of financialReportData) {
      for (const row of report?.rows ?? []) if (row.paymentId !== null) map.set(row.paymentId, row.authoritativeLocalDate);
    }
    return map;
  })();
  const paymentCanonicalRows = (() => {
    const map = new Map<number, CanonicalPaymentReport["rows"][number]>();
    for (const report of financialReportData) {
      for (const row of report?.rows ?? []) {
        if (row.paymentId !== null) map.set(row.paymentId, row);
      }
    }
    return map;
  })();
  const defaultLeagueId = reportLeagues.length > 0 ? reportLeagues[0].id : undefined;
  const financialRows = financialReportData.length > 0
    ? financialReportData[0]?.rows ?? []
    : [];
  const orphanedFinancialRows = financialRows.filter((row) => row.paymentId === null);

  // The visible table is projection-owned. Raw payment rows are retained only
  // as optional action metadata; a canonical row is never hidden because the
  // legacy endpoint happened to paginate differently.
  const projectionPayments = useMemo(() => {
    const rawById = new Map(payments.map((payment) => [payment.id, payment]));
    return [...paymentCanonicalRows.values()].map((row) => {
      if (row.paymentId !== null) {
        const existing = rawById.get(row.paymentId);
        if (existing) return existing;
      }
      const synthetic: Payment = {
        id: row.paymentId ?? 0,
        organizationId: userResponse?.data?.organizationId ?? 0,
        bowlerId: row.bowlerId,
        leagueId: row.leagueId,
        amount: row.amountMinor,
        currency: row.currency,
        status: row.status === "confirmed_paid" ? "paid" : row.status === "disputed" || row.status === "failed" || row.status === "pending" || row.status === "refunded" ? row.status : "pending",
        type: row.paymentType,
        providerPaymentId: null,
        receiptUrl: null,
        receiptNumber: null,
        receiptEmailMissing: true,
        squareRefundId: row.refund.providerRefundId,
        disputeId: row.dispute.disputeId,
        checkNumber: null,
        idempotencyKey: null,
        refundReason: null,
        refundedAt: null,
        disputedAt: null,
        notes: null,
        paidByUserId: null,
        paymentOperationId: null,
        createdAt: row.businessDate,
      };
      return synthetic;
    });
  }, [payments, paymentCanonicalRows, userResponse?.data?.organizationId]);
  const filteredPayments = useMemo(() => {
    const source = projectionPayments;
    if (!searchQuery.trim()) return source;
    const searchLower = searchQuery.toLowerCase();
    return source.filter((payment) => {
      const bowler = bowlers.find((b) => b.id === payment.bowlerId);
      return bowler?.name?.toLowerCase().includes(searchLower);
    });
  }, [projectionPayments, bowlers, searchQuery]);

  const handlePageChange = useCallback((newPage: number) => {
    setPage(newPage);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const handlePageSizeChange = useCallback((newSize: number) => {
    setPageSize(newSize);
    setPage(1);
  }, []);

  if ((loadingPayments || loadingBowlers) && !projectionPayments.length) {
    return (
      <Layout>
        <PageLoadingState />
      </Layout>
    );
  }
  if (userResponse?.data?.role === "system_admin" && !userResponse.data.organizationId) {
    return <Layout><p className="p-6 text-destructive">Select an organization before viewing financial payments.</p></Layout>;
  }
  if (financialReportError || missingFinancialReport) {
    return <Layout><p className="p-6 text-destructive">Financial evidence requires review; no payment page is shown.</p></Layout>;
  }

  return (
    <Layout>
      <ErrorBoundary level="section">
        <div className="space-y-6">
          <div className="flex justify-between items-center">
            <h1 className="text-2xl font-bold">Payments</h1>
          </div>

          <div className="flex items-center gap-x-2 mb-6">
            {leagues.length > 0 && (
              <Select value={String(defaultLeagueId ?? "")} onValueChange={(value) => { setSelectedLeagueId(Number(value)); setPage(1); }}>
                <SelectTrigger className="w-56" aria-label="Financial league scope"><SelectValue placeholder="Select league" /></SelectTrigger>
                <SelectContent>{leagues.map((league) => <SelectItem key={league.id} value={String(league.id)}>{league.name}</SelectItem>)}</SelectContent>
              </Select>
            )}
            <div className="relative w-full max-w-sm">
              <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
              <Input
                type="search"
                placeholder="Search by bowler name..."
                className="pl-8"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            {searchQuery && (
              <Button variant="ghost" size="sm" onClick={() => setSearchQuery("")}>Clear</Button>
            )}
          </div>

          {orphanedFinancialRows.length > 0 && (
            <section className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-4" aria-labelledby="payments-needing-review-heading">
              <h2 id="payments-needing-review-heading" className="font-semibold">Payments needing review</h2>
              <p className="text-sm text-muted-foreground">These payment attempts do not yet have a finalized payment record. Review reconciliation before taking further action.</p>
              <div className="divide-y rounded-md border bg-background">
                {orphanedFinancialRows.map((row, index) => {
                  const bowler = bowlers.find((candidate) => candidate.id === row.bowlerId);
                  return (
                    <div key={`${row.paymentOperationId ?? "payment-attempt"}-${index}`} className="grid gap-1 px-3 py-2 text-sm sm:grid-cols-[1fr_auto] sm:items-center">
                      <div>
                        <div className="font-medium">{bowler?.name || "Unknown Bowler"}</div>
                        <div className="text-muted-foreground">{row.authoritativeLocalDate} · {row.status === "pending" ? "Pending confirmation" : "Review required"}</div>
                      </div>
                      <div className="font-medium">{new Intl.NumberFormat("en-US", { style: "currency", currency: row.currency }).format(row.amountMinor / 100)}</div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          <div aria-label="Payment management actions">
          <PaymentsTable
            payments={projectionPayments}
            filteredPayments={filteredPayments}
            bowlers={bowlers}
            isAdmin={isAdmin}
            isPaymentManager={isPaymentManager}
            onRefund={setPaymentToRefund}
            isRefundPending={refundPaymentMutation.isPending}
            leagues={leagues}
            paymentBusinessDates={paymentBusinessDates}
            paymentCanonicalRows={paymentCanonicalRows}
          />
          </div>

          {financialReportData.length > 0 && (
            <PaginationControls
              page={page}
              pageSize={pageSize}
              total={financialReportData.reduce((sum, report) => sum + (report?.totalTransactions ?? 0), 0)}
              totalPages={Math.max(1, Math.ceil(financialReportData.reduce((sum, report) => sum + (report?.totalTransactions ?? 0), 0) / pageSize))}
              pageSizeOptions={PAGE_SIZE_OPTIONS}
              itemLabel="payments"
              onPageChange={handlePageChange}
              onPageSizeChange={handlePageSizeChange}
            />
          )}

          <RefundPaymentDialog
            payment={paymentToRefund}
            onClose={() => setPaymentToRefund(null)}
            onConfirm={(id, reason) => refundPaymentMutation.mutate({ id, reason })}
            isPending={refundPaymentMutation.isPending}
          />
        </div>
      </ErrorBoundary>
    </Layout>
  );
}
