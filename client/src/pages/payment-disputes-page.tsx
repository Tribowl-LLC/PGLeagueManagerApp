import { useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, type InfiniteData } from "@tanstack/react-query";
import { AlertTriangle, Check, Clock3, Eye, ShieldAlert } from "lucide-react";
import { Layout } from "@/components/layout";
import { ErrorBoundary } from "@/components/error-boundary";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type {
  ApiResponse,
  Organization,
  PaymentDisputeState,
  User,
} from "@shared/schema";

type AcknowledgementFields = {
  acknowledgementId: string | null;
  acknowledgedByUserId: number | null;
  acknowledgedByRole: string | null;
  acknowledgedAt: string | null;
};

type DisputeListItem = AcknowledgementFields & {
  id: string;
  locationId: number;
  paymentOperationId: string;
  amountMinor: number;
  currency: string;
  reason: string;
  state: PaymentDisputeState;
  responseDueAt: string | null;
  cardBrand: string | null;
  providerCreatedAt: string;
  providerReportedAt: string | null;
  providerUpdatedAt: string;
  providerVersion: number;
  createdAt: string;
  updatedAt: string;
};

type HistoryItem = AcknowledgementFields & {
  id: string;
  kind: "DISPUTE_CREATED" | "DISPUTE_STATE_UPDATED";
  disputeState: PaymentDisputeState;
  providerVersion: number;
  createdAt: string;
};

type Page<T> = { items: T[]; nextCursor: string | null };

const TERMINAL_STATES = new Set<PaymentDisputeState>([
  "INQUIRY_CLOSED",
  "WON",
  "LOST",
  "ACCEPTED",
]);

const STATE_LABELS: Record<PaymentDisputeState, string> = {
  INQUIRY_EVIDENCE_REQUIRED: "Inquiry evidence required",
  INQUIRY_PROCESSING: "Inquiry processing",
  INQUIRY_CLOSED: "Inquiry closed",
  EVIDENCE_REQUIRED: "Evidence required",
  PROCESSING: "Processing",
  WON: "Won",
  LOST: "Lost",
  ACCEPTED: "Accepted by Square",
};

function formatLabel(value: string): string {
  return value.toLowerCase().split("_").map((part) => (
    part.length > 0 ? `${part[0].toUpperCase()}${part.slice(1)}` : part
  )).join(" ");
}

function formatMoney(amountMinor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency })
      .format(amountMinor / 100);
  } catch {
    return `${currency} ${(amountMinor / 100).toFixed(2)}`;
  }
}

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function Deadline({ dispute }: { dispute: DisputeListItem }) {
  if (TERMINAL_STATES.has(dispute.state) || !dispute.responseDueAt) {
    return <span className="text-muted-foreground">—</span>;
  }
  const deadline = new Date(dispute.responseDueAt);
  const remainingMs = deadline.getTime() - Date.now();
  const isOverdue = remainingMs < 0;
  const isSoon = !isOverdue && remainingMs <= 72 * 60 * 60 * 1000;
  return (
    <div className={isOverdue ? "text-destructive" : isSoon ? "text-amber-700" : ""}>
      <div className="flex items-center gap-1.5 font-medium whitespace-nowrap">
        {(isOverdue || isSoon) && <AlertTriangle className="size-4" aria-hidden="true" />}
        {formatDateTime(dispute.responseDueAt)}
      </div>
      {(isOverdue || isSoon) && (
        <div className="text-xs mt-0.5">{isOverdue ? "Provider deadline passed" : "Provider deadline approaching"}</div>
      )}
    </div>
  );
}

function StateBadge({ state }: { state: PaymentDisputeState }) {
  const terminal = TERMINAL_STATES.has(state);
  const urgent = state === "EVIDENCE_REQUIRED" || state === "INQUIRY_EVIDENCE_REQUIRED";
  return (
    <Badge variant={terminal ? "secondary" : urgent ? "destructive" : "outline"}>
      {STATE_LABELS[state]}
    </Badge>
  );
}

function HistoryDialog({
  dispute,
  organizationId,
  onClose,
}: {
  dispute: DisputeListItem;
  organizationId: number | null;
  onClose: () => void;
}) {
  const suffix = organizationId ? `&organizationId=${organizationId}` : "";
  const historyUrl = `/api/payment-disputes/notifications?limit=100&paymentDisputeId=${dispute.id}${suffix}`;
  const { data, isLoading, isError } = useQuery<ApiResponse<Page<HistoryItem>>>({
    queryKey: [historyUrl],
  });
  const items = data?.data?.items ?? [];
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Dispute state history</DialogTitle>
          <DialogDescription>
            Immutable, sanitized Square webhook records. Acknowledgement records awareness only and does not act on the dispute.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border p-3 text-sm grid gap-2 sm:grid-cols-3">
          <div><span className="text-muted-foreground">Current state</span><div className="mt-1"><StateBadge state={dispute.state} /></div></div>
          <div><span className="text-muted-foreground">Amount</span><div className="font-medium mt-1">{formatMoney(dispute.amountMinor, dispute.currency)}</div></div>
          <div><span className="text-muted-foreground">Provider version</span><div className="font-medium mt-1">{dispute.providerVersion}</div></div>
        </div>
        {isLoading ? (
          <div className="space-y-3"><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /></div>
        ) : isError ? (
          <p className="text-sm text-destructive">Unable to load dispute history.</p>
        ) : items.length === 0 ? (
          <p className="rounded-md border p-4 text-sm text-muted-foreground">
            No immutable notification history is available for this dispute. It may predate notification retention.
          </p>
        ) : (
          <ol className="space-y-3" aria-label="Dispute state history">
            {items.map((item) => (
              <li key={item.id} className="rounded-md border p-4" data-testid={`dispute-history-version-${item.providerVersion}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="font-medium">{item.kind === "DISPUTE_CREATED" ? "Dispute created" : "Dispute state updated"}</div>
                    <div className="text-xs text-muted-foreground mt-1">Version {item.providerVersion} · recorded {formatDateTime(item.createdAt)}</div>
                  </div>
                  <StateBadge state={item.disputeState} />
                </div>
                <div className="text-sm mt-3">
                  {item.acknowledgedAt ? (
                    <span className="inline-flex items-center gap-1.5 text-emerald-700">
                      <Check className="size-4" aria-hidden="true" />
                      Acknowledged {formatDateTime(item.acknowledgedAt)} by {formatLabel(item.acknowledgedByRole ?? "administrator")} #{item.acknowledgedByUserId}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Not acknowledged</span>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function PaymentDisputesPage() {
  const { toast } = useToast();
  const [selectedDispute, setSelectedDispute] = useState<DisputeListItem | null>(null);
  const [selectedOrganizationId, setSelectedOrganizationId] = useState<number | null>(null);
  const { data: userResponse, isLoading: isUserLoading } = useQuery<ApiResponse<User>>({
    queryKey: ["/api/user"],
  });
  const user = userResponse?.data;
  const isSystemAdmin = user?.role === "system_admin";
  const effectiveOrganizationId = isSystemAdmin ? selectedOrganizationId : user?.organizationId ?? null;

  const { data: organizationsResponse } = useQuery<ApiResponse<Organization[]>>({
    queryKey: ["/api/organizations"],
    enabled: isSystemAdmin,
    staleTime: 5 * 60_000,
  });
  const organizations = organizationsResponse?.data ?? [];
  const tenantSuffix = isSystemAdmin && effectiveOrganizationId
    ? `&organizationId=${effectiveOrganizationId}`
    : "";
  const disputesUrl = `/api/payment-disputes?limit=100${tenantSuffix}`;
  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
    isFetching,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery<
    ApiResponse<Page<DisputeListItem>>,
    Error,
    InfiniteData<ApiResponse<Page<DisputeListItem>>, string | null>,
    string[],
    string | null
  >({
    queryKey: [disputesUrl],
    queryFn: async ({ pageParam, signal }): Promise<ApiResponse<Page<DisputeListItem>>> => {
      const cursor = pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : "";
      const response = await fetch(`${disputesUrl}${cursor}`, {
        credentials: "include",
        headers: { Accept: "application/json" },
        signal,
      });
      if (!response.ok) throw new Error(`Unable to load disputes (${response.status})`);
      return response.json();
    },
    initialPageParam: null,
    getNextPageParam: (lastPage) => lastPage.data.nextCursor ?? undefined,
    enabled: Boolean(user) && (!isSystemAdmin || effectiveOrganizationId !== null),
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
  const disputes = data?.pages.flatMap((page) => page.data.items) ?? [];
  const countUrl = `/api/payment-disputes/unacknowledged-count${
    isSystemAdmin && effectiveOrganizationId ? `?organizationId=${effectiveOrganizationId}` : ""
  }`;
  const { data: countResponse } = useQuery<ApiResponse<{ count: number }>>({
    queryKey: [countUrl],
    enabled: Boolean(user) && (!isSystemAdmin || effectiveOrganizationId !== null),
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
  const unacknowledgedCount = countResponse?.data?.count ?? 0;

  const acknowledgement = useMutation({
    mutationFn: (dispute: DisputeListItem) => apiRequest(
      `/api/payment-disputes/${dispute.id}/acknowledgements`,
      "POST",
      {
        providerVersion: dispute.providerVersion,
        ...(isSystemAdmin && effectiveOrganizationId
          ? { organizationId: effectiveOrganizationId }
          : {}),
      },
    ),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [disputesUrl] }),
        queryClient.invalidateQueries({ queryKey: [countUrl] }),
        queryClient.invalidateQueries({ queryKey: ["/api/payment-disputes/unacknowledged-count"] }),
      ]);
      toast({ title: "Dispute acknowledged", description: "This records organizational awareness only. No Square action was taken." });
    },
    onError: (mutationError) => {
      const changed = mutationError instanceof Error && mutationError.message.includes("DISPUTE_VERSION_CHANGED");
      toast({
        title: changed ? "Dispute changed" : "Acknowledgement failed",
        description: changed
          ? "Square reported a newer version. Refresh and review it before acknowledging."
          : "The dispute could not be acknowledged. No Square action was taken.",
        variant: "destructive",
      });
      if (changed) void queryClient.invalidateQueries({ queryKey: [disputesUrl] });
    },
  });

  return (
    <Layout>
      <ErrorBoundary level="section">
        <div className="container py-6">
          <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-4xl font-bold">Payment disputes</h1>
              <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
                Review Square dispute status, provider deadlines, and immutable state history. LeagueVault acknowledgement records organizational awareness only; manage the dispute itself in Square.
              </p>
            </div>
            {effectiveOrganizationId && (
              <Badge variant={unacknowledgedCount > 0 ? "destructive" : "secondary"} className="text-sm px-3 py-1.5">
                {unacknowledgedCount} unacknowledged
              </Badge>
            )}
          </div>

          {isSystemAdmin && (
            <Card className="mb-6">
              <CardHeader><CardTitle className="text-lg">Organization context</CardTitle></CardHeader>
              <CardContent>
                <label htmlFor="dispute-organization" className="block text-sm font-medium mb-2">
                  Select one organization
                </label>
                <select
                  id="dispute-organization"
                  className="h-10 w-full max-w-md rounded-md border border-input bg-background px-3 text-sm"
                  value={selectedOrganizationId ?? ""}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    setSelectedOrganizationId(Number.isInteger(value) && value > 0 ? value : null);
                    setSelectedDispute(null);
                  }}
                >
                  <option value="">Choose an organization</option>
                  {organizations.map((organization) => (
                    <option key={organization.id} value={organization.id}>{organization.name}</option>
                  ))}
                </select>
              </CardContent>
            </Card>
          )}

          {isUserLoading ? (
            <Card><CardContent className="py-12"><Skeleton className="h-12 w-full" /></CardContent></Card>
          ) : !effectiveOrganizationId ? (
            <Card><CardContent className="py-12 text-center text-muted-foreground">Select an organization to view its disputes.</CardContent></Card>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><ShieldAlert className="size-5" /> Dispute operations</CardTitle>
              </CardHeader>
              <CardContent>
                {isError ? (
                  <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
                    <p className="font-medium text-destructive">Unable to load payment disputes.</p>
                    <p className="text-muted-foreground mt-1">{error instanceof Error ? error.message : "Unknown error"}</p>
                    <Button variant="outline" size="sm" className="mt-3" onClick={() => refetch()} disabled={isFetching}>
                      {isFetching ? "Retrying…" : "Retry"}
                    </Button>
                  </div>
                ) : isLoading ? (
                  <div className="space-y-3"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>
                ) : disputes.length === 0 ? (
                  <div className="py-12 text-center">
                    <ShieldAlert className="size-10 mx-auto text-muted-foreground mb-3" />
                    <p className="font-medium">No payment disputes recorded</p>
                    <p className="text-sm text-muted-foreground mt-1">Signed Square dispute events will appear here after durable reconciliation.</p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader><TableRow>
                        <TableHead>State</TableHead><TableHead>Amount</TableHead><TableHead>Reason</TableHead>
                        <TableHead>Provider deadline</TableHead><TableHead>Updated</TableHead>
                        <TableHead>Acknowledgement</TableHead><TableHead className="text-right">Actions</TableHead>
                      </TableRow></TableHeader>
                      <TableBody>
                        {disputes.map((dispute) => (
                          <TableRow key={dispute.id} data-testid={`dispute-row-${dispute.id}`}>
                            <TableCell><StateBadge state={dispute.state} /></TableCell>
                            <TableCell className="font-medium whitespace-nowrap">{formatMoney(dispute.amountMinor, dispute.currency)}</TableCell>
                            <TableCell>{formatLabel(dispute.reason)}</TableCell>
                            <TableCell><Deadline dispute={dispute} /></TableCell>
                            <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{formatDateTime(dispute.providerUpdatedAt)}</TableCell>
                            <TableCell>
                              {dispute.acknowledgedAt ? (
                                <div className="text-sm text-emerald-700">
                                  <div className="inline-flex items-center gap-1 font-medium"><Check className="size-4" /> Acknowledged</div>
                                  <div className="text-xs mt-1">{formatDateTime(dispute.acknowledgedAt)}</div>
                                  <div className="text-xs">{formatLabel(dispute.acknowledgedByRole ?? "administrator")} #{dispute.acknowledgedByUserId}</div>
                                </div>
                              ) : (
                                <div className="inline-flex items-center gap-1.5 text-sm text-amber-700"><Clock3 className="size-4" /> Not acknowledged</div>
                              )}
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="inline-flex flex-col sm:flex-row gap-2 justify-end">
                                <Button variant="outline" size="sm" onClick={() => setSelectedDispute(dispute)}>
                                  <Eye className="size-4 mr-1.5" /> History
                                </Button>
                                {!dispute.acknowledgedAt && (
                                  <Button
                                    size="sm"
                                    onClick={() => acknowledgement.mutate(dispute)}
                                    disabled={acknowledgement.isPending}
                                    data-testid={`button-acknowledge-dispute-${dispute.id}`}
                                  >
                                    Acknowledge v{dispute.providerVersion}
                                  </Button>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    {hasNextPage && (
                      <div className="flex justify-center pt-4">
                        <Button
                          variant="outline"
                          onClick={() => fetchNextPage()}
                          disabled={isFetchingNextPage}
                        >
                          {isFetchingNextPage ? "Loading…" : "Load older disputes"}
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
        {selectedDispute && (
          <HistoryDialog
            dispute={selectedDispute}
            organizationId={isSystemAdmin ? effectiveOrganizationId : null}
            onClose={() => setSelectedDispute(null)}
          />
        )}
      </ErrorBoundary>
    </Layout>
  );
}
