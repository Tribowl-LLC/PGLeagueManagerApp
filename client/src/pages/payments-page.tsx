import { useState, useMemo, useCallback } from "react";
import { useQuery, useMutation, useQueries } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Layout } from "@/components/layout";
import { PaymentForm } from "@/components/payment-form";
import { ErrorBoundary } from "@/components/error-boundary";
import { Input } from "@/components/ui/input";
import { Loader2, Plus, Search } from "lucide-react";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PaymentsTable } from "@/components/payments-table";
import { RefundPaymentDialog } from "@/components/refund-payment-dialog";
import { PaginationControls } from "@/components/pagination-controls";
import type { CanonicalPaymentReport } from "@shared/canonical-payment-report";

const PAGE_SIZE_OPTIONS = [25, 50, 100];
const DEFAULT_PAGE_SIZE = 50;

interface PaginatedPaymentsResponse {
  success: boolean;
  data: Array<Payment & { disputes: PaymentRowDisputeSummary[] }>;
  pagination: PaginationMeta;
}

export default function PaymentsPage() {
  const [showForm, setShowForm] = useState(false);
  const [paymentToDelete, setPaymentToDelete] = useState<number | null>(null);
  const [paymentToRefund, setPaymentToRefund] = useState<Payment | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
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

  const deletePaymentMutation = useMutation({
    mutationFn: async (id: number) => {
      const response = await apiRequest(`/api/payments/${id}`, "DELETE");
      if (!response.success) {
        throw new Error(`Failed to delete payment: ${response.error?.message || "Unknown error"}`);
      }
      return id;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/payments"] });
      toast({ title: "Success", description: "Payment has been deleted." });
      setPaymentToDelete(null);
    },
    onError: (error: Error) => {
      toast({ title: "Error deleting payment", description: error.message, variant: "destructive" });
    },
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
  const pagination = paymentsResponse?.pagination;
  const bowlers = useMemo(() => bowlersResponse?.data || [], [bowlersResponse?.data]);
  const leagues = leaguesResponse?.data || [];
  const financialReports = useQueries({
    queries: leagues.map((league) => ({
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
      for (const row of report?.unlinkedHistory ?? []) if (row.paymentId !== null) map.set(row.paymentId, row.authoritativeLocalDate);
    }
    return map;
  })();
  const paymentEvidenceStatuses = (() => {
    const map = new Map<number, CanonicalPaymentReport["rows"][number]["status"]>();
    for (const report of financialReportData) {
      for (const row of report?.rows ?? []) if (row.paymentId !== null) map.set(row.paymentId, row.status);
      for (const row of report?.unlinkedHistory ?? []) if (row.paymentId !== null) map.set(row.paymentId, row.status);
    }
    return map;
  })();
  const paymentCanonicalRows = (() => {
    const map = new Map<number, CanonicalPaymentReport["rows"][number]>();
    for (const report of financialReportData) {
      for (const row of [...(report?.rows ?? []), ...(report?.unlinkedHistory ?? [])]) {
        if (row.paymentId !== null) map.set(row.paymentId, row);
      }
    }
    return map;
  })();
  const defaultLeagueId = leagues.length > 0 ? leagues[0].id : undefined;

  const projectedPayments = useMemo(() => payments.filter((payment) => paymentBusinessDates.has(payment.id)), [payments, paymentBusinessDates]);
  const filteredPayments = useMemo(() => {
    const source = projectedPayments;
    if (!searchQuery.trim()) return source;
    const searchLower = searchQuery.toLowerCase();
    return source.filter((payment) => {
      const bowler = bowlers.find((b) => b.id === payment.bowlerId);
      return bowler?.name?.toLowerCase().includes(searchLower);
    });
  }, [projectedPayments, bowlers, searchQuery]);

  const handlePageChange = useCallback((newPage: number) => {
    setPage(newPage);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const handlePageSizeChange = useCallback((newSize: number) => {
    setPageSize(newSize);
    setPage(1);
  }, []);

  if ((loadingPayments || loadingBowlers) && !payments.length) {
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
            <Button onClick={() => setShowForm(true)}>
              <Plus className="size-4 mr-2" />
              Record Payment
            </Button>
          </div>

          <div className="flex items-center gap-x-2 mb-6">
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

          <PaymentsTable
            payments={payments}
            filteredPayments={filteredPayments}
            bowlers={bowlers}
            isAdmin={isAdmin}
            isPaymentManager={isPaymentManager}
            onRefund={setPaymentToRefund}
            onDelete={setPaymentToDelete}
            isRefundPending={refundPaymentMutation.isPending}
            isDeletePending={deletePaymentMutation.isPending}
            leagues={leagues}
            paymentBusinessDates={paymentBusinessDates}
            paymentEvidenceStatuses={paymentEvidenceStatuses}
            paymentCanonicalRows={paymentCanonicalRows}
          />

          {pagination && (
            <PaginationControls
              page={page}
              pageSize={pageSize}
              total={pagination.total}
              totalPages={pagination.totalPages}
              pageSizeOptions={PAGE_SIZE_OPTIONS}
              itemLabel="payments"
              onPageChange={handlePageChange}
              onPageSizeChange={handlePageSizeChange}
            />
          )}

          <PaymentForm
            open={showForm}
            onClose={() => setShowForm(false)}
            bowlers={bowlers}
            leagueId={defaultLeagueId}
            paymentManager={isPaymentManager}
          />

          <Dialog open={paymentToDelete !== null} onOpenChange={(open) => { if (!open) setPaymentToDelete(null); }}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delete Payment</DialogTitle>
                <DialogDescription>
                  Are you sure you want to delete this payment? This action cannot be undone.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setPaymentToDelete(null)}>Cancel</Button>
                <Button
                  variant="destructive"
                  onClick={() => paymentToDelete && deletePaymentMutation.mutate(paymentToDelete)}
                  disabled={deletePaymentMutation.isPending}
                >
                  {deletePaymentMutation.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : "Delete"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

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
