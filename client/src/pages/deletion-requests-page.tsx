import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { Layout } from '@/components/layout';
import { ErrorBoundary } from '@/components/error-boundary';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import type {
  ApiResponse,
  DeletionRequest,
  DeletionRequestStatus,
  DeletionExecutionSummary,
} from '@shared/schema';
import { DeletionRequestsTable } from './deletion-requests-page/deletion-requests-table';
import { DeletionReviewDialog } from './deletion-requests-page/review-dialog';
import {
  parseExecutionSummary,
  STATUS_LABELS,
  type ReviewMode,
} from './deletion-requests-page/utils';

export default function DeletionRequestsPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<DeletionRequestStatus>('pending');
  const [activeRequest, setActiveRequest] = useState<DeletionRequest | null>(null);
  const [reviewMode, setReviewMode] = useState<ReviewMode>('completed');
  const [adminNote, setAdminNote] = useState('');
  const [executeConfirmText, setExecuteConfirmText] = useState('');
  const [expandedRequestIds, setExpandedRequestIds] = useState<Set<number>>(new Set());
  // Sweep-mode filter for the Completed tab: when on, only requests
  // whose execution summary records at least one undeleted
  // payment-provider customer remain visible. The filter itself is
  // only meaningful for completed rows (pending/rejected rows have
  // no execution summary), so it is hidden on the other tabs.
  const [providerFailuresOnly, setProviderFailuresOnly] = useState(false);

  const toggleExpanded = (id: number) => {
    setExpandedRequestIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const { data: requestsResponse, isLoading } = useQuery<ApiResponse<DeletionRequest[]>>({
    queryKey: ['/api/system-admin/deletion-requests', statusFilter],
    queryFn: async () => {
      const r = await fetch(`/api/system-admin/deletion-requests?status=${statusFilter}`, {
        credentials: 'include',
      });
      if (!r.ok) throw new Error('Failed to fetch deletion requests');
      return r.json();
    },
  });

  const allRequests = requestsResponse?.data ?? [];
  const requests =
    statusFilter === 'completed' && providerFailuresOnly
      ? allRequests.filter((req) => {
          const summary = parseExecutionSummary(req.executionSummary);
          return !!summary?.paymentProvider.some((p) => !p.deleted);
        })
      : allRequests;

  const reviewMutation = useMutation({
    mutationFn: async (vars: { id: number; status: ReviewMode; adminNote: string | null }) => {
      return apiRequest(`/api/system-admin/deletion-requests/${vars.id}`, 'PATCH', {
        status: vars.status,
        adminNote: vars.adminNote,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/system-admin/deletion-requests'] });
      queryClient.invalidateQueries({ queryKey: ['/api/system-admin/deletion-requests/pending-count'] });
      setActiveRequest(null);
      setAdminNote('');
      toast({ title: 'Request updated', description: 'The deletion request has been updated.' });
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to update request', description: error.message, variant: 'destructive' });
    },
  });

  const executeMutation = useMutation({
    mutationFn: async (vars: { id: number; adminNote: string | null }) => {
      return apiRequest(`/api/system-admin/deletion-requests/${vars.id}/execute`, 'POST', {
        confirm: 'DELETE',
        adminNote: vars.adminNote,
      }) as Promise<ApiResponse<{ request: DeletionRequest; summary: DeletionExecutionSummary }>>;
    },
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ['/api/system-admin/deletion-requests'] });
      queryClient.invalidateQueries({ queryKey: ['/api/system-admin/deletion-requests/pending-count'] });
      setActiveRequest(null);
      setAdminNote('');
      setExecuteConfirmText('');
      const summary = response?.data?.summary;
      const bowlersDone = summary?.bowlers.filter((b) => b.anonymized).length ?? 0;
      const providersDone = summary?.paymentProvider.filter((p) => p.deleted).length ?? 0;
      const userDone = summary?.user.deleted ? 'user account removed' : 'no user account found';
      toast({
        title: 'Account data deleted',
        description: `${bowlersDone} bowler record(s) anonymized, ${providersDone} payment-provider customer(s) removed, ${userDone}.`,
      });
    },
    onError: (error: Error) => {
      toast({ title: 'Deletion failed', description: error.message, variant: 'destructive' });
    },
  });

  const openReview = (req: DeletionRequest, mode: ReviewMode) => {
    setActiveRequest(req);
    setReviewMode(mode);
    setAdminNote(req.adminNote ?? '');
    setExecuteConfirmText('');
  };

  const closeReviewDialog = () => {
    setActiveRequest(null);
    setAdminNote('');
    setExecuteConfirmText('');
  };

  const handleExecute = () => {
    if (!activeRequest) return;
    executeMutation.mutate({
      id: activeRequest.id,
      adminNote: adminNote.trim() ? adminNote.trim() : null,
    });
  };

  const handleReview = () => {
    if (!activeRequest) return;
    reviewMutation.mutate({
      id: activeRequest.id,
      status: reviewMode,
      adminNote: adminNote.trim() ? adminNote.trim() : null,
    });
  };

  return (
    <Layout>
      <ErrorBoundary level="section">
        <div className="container py-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-4xl font-bold">Deletion Requests</h1>
              <p className="text-sm text-muted-foreground mt-1">
                Account deletion requests submitted from the public delete-account page.
              </p>
            </div>
          </div>

          <div className="flex items-center justify-between mb-4 gap-4 flex-wrap">
            <Tabs
              value={statusFilter}
              onValueChange={(v) => setStatusFilter(v as DeletionRequestStatus)}
            >
              <TabsList>
                <TabsTrigger value="pending">Pending</TabsTrigger>
                <TabsTrigger value="completed">Completed</TabsTrigger>
                <TabsTrigger value="rejected">Rejected</TabsTrigger>
              </TabsList>
            </Tabs>
            {statusFilter === 'completed' && (
              <div className="flex items-center gap-2">
                <Switch
                  id="filter-provider-failures"
                  checked={providerFailuresOnly}
                  onCheckedChange={setProviderFailuresOnly}
                  data-testid="switch-provider-failures-only"
                />
                <Label
                  htmlFor="filter-provider-failures"
                  className="text-sm font-normal cursor-pointer"
                >
                  Only with provider failures
                </Label>
              </div>
            )}
          </div>

          <Card>
            <CardHeader>
              <CardTitle data-testid="text-requests-count">
                {STATUS_LABELS[statusFilter].label} requests
                {statusFilter === 'completed' && providerFailuresOnly
                  ? ` with provider failures (${requests.length} of ${allRequests.length})`
                  : ` (${requests.length})`}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <DeletionRequestsTable
                isLoading={isLoading}
                statusFilter={statusFilter}
                requests={requests}
                expandedRequestIds={expandedRequestIds}
                toggleExpanded={toggleExpanded}
                openReview={openReview}
              />
            </CardContent>
          </Card>

          <DeletionReviewDialog
            activeRequest={activeRequest}
            reviewMode={reviewMode}
            adminNote={adminNote}
            setAdminNote={setAdminNote}
            executeConfirmText={executeConfirmText}
            setExecuteConfirmText={setExecuteConfirmText}
            isExecutePending={executeMutation.isPending}
            isReviewPending={reviewMutation.isPending}
            onClose={closeReviewDialog}
            onExecute={handleExecute}
            onReview={handleReview}
          />
        </div>
      </ErrorBoundary>
    </Layout>
  );
}
