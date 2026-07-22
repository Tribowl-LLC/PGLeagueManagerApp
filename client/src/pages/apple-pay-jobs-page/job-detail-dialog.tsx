import { useMutation, useQuery } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import {
  isProviderNotConfiguredError,
  providerNotConfiguredToast,
} from '@/lib/provider-not-configured';
import { applePayJobKeys } from '@/lib/query-keys';
import { apiRequest, queryClient } from '@/lib/queryClient';
import type { ApiResponse, ApplePayJobStatus } from '@shared/schema';
import { CountTile } from './count-tile';
import { JobItemsTable } from './job-items-table';
import {
  JOB_STATUS_META,
  formatDate,
  invalidateJobQueries,
  isActive,
  isRetryable,
  isTerminal,
  type JobDetailResponse,
} from './utils';

export function JobDetailDialog({ jobId, onClose }: { jobId: number; onClose: () => void }) {
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<ApiResponse<JobDetailResponse>>({
    queryKey: ['/api/payments-provider/apple-pay/jobs', jobId],
    queryFn: async () => {
      const r = await fetch(`/api/payments-provider/apple-pay/jobs/${jobId}`, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (!r.ok) throw new Error('Failed to fetch job');
      return r.json();
    },
    refetchInterval: (query) => {
      const status = query.state.data?.data?.job?.status;
      return status && isActive(status) ? 3000 : false;
    },
  });

  const detail = data?.data;
  const job = detail?.job;
  const counts = detail?.counts;
  const items = detail?.items ?? [];
  const recoveredItemCount = detail?.recoveredItemCount ?? 0;

  // Centralised PROVIDER_NOT_CONFIGURED handling for the three
  // Apple-Pay job mutations (#391). The job itself spans multiple
  // locations, but if every item in the job is bound to the same
  // location we can deep-link the actionable toast to that one
  // location's settings entry. Otherwise we fall back to the
  // generic /integrations route.
  const jobLocationId = (() => {
    if (items.length === 0) return null;
    const first = items[0]?.locationId ?? null;
    if (first == null) return null;
    return items.every((it) => it.locationId === first) ? first : null;
  })();

  // Resolve the job's owning location for provider configuration errors.
  // When a job spans multiple locations `jobLocationId` is null and the
  // toast falls back to the bare /integrations link,
  // which is the only signal we can give without picking a winner.
  const handleMutationError = (titleFallback: string) => (err: unknown) => {
    if (isProviderNotConfiguredError(err)) {
      toast(providerNotConfiguredToast({ navigate, locationId: jobLocationId }));
      return;
    }
    toast({
      title: titleFallback,
      description: err instanceof Error ? err.message : 'Unknown error',
      variant: 'destructive',
    });
  };

  const handleMutationResp = (
    resp: { success: boolean; error?: { message?: string; code?: string } },
    titleFallback: string,
  ): boolean => {
    if (resp.success) return true;
    if (resp.error?.code === 'PROVIDER_NOT_CONFIGURED') {
      toast(providerNotConfiguredToast({ navigate, locationId: jobLocationId }));
    } else {
      toast({ title: titleFallback, description: resp.error?.message ?? 'Unknown error', variant: 'destructive' });
    }
    return false;
  };

  // NOTE (react-doctor audit): react-doctor flags the mutations below as
  // "missing query invalidation" because it can't follow the helper call.
  // False positive — every onSuccess invalidates via invalidateJobQueries(jobId)
  // (which refreshes the job list + this job's detail cache). Audited; do not
  // "fix" by inlining queryClient.invalidateQueries here.
  const cancelMutation = useMutation({
    mutationFn: async () => apiRequest(`/api/payments-provider/apple-pay/jobs/${jobId}/cancel`, 'POST'),
    onSuccess: (resp) => {
      if (handleMutationResp(resp, 'Could not cancel')) {
        toast({ title: 'Job canceled', description: `Job #${jobId} has been canceled.` });
        invalidateJobQueries(jobId);
      }
    },
    onError: handleMutationError('Could not cancel'),
  });

  const retryMutation = useMutation({
    mutationFn: async () => apiRequest<{ resetCount: number }>(`/api/payments-provider/apple-pay/jobs/${jobId}/retry`, 'POST'),
    onSuccess: (resp) => {
      if (handleMutationResp(resp, 'Could not retry')) {
        toast({
          title: 'Job retry queued',
          description: `Re-queued ${resp.data?.resetCount ?? 0} failed item(s).`,
        });
        invalidateJobQueries(jobId);
      }
    },
    onError: handleMutationError('Could not retry'),
  });

  const itemRetryMutation = useMutation({
    mutationFn: async (itemId: number) =>
      apiRequest(`/api/payments-provider/apple-pay/jobs/${jobId}/items/${itemId}/retry`, 'POST'),
    onSuccess: (resp) => {
      if (handleMutationResp(resp, 'Could not retry item')) {
        toast({ title: 'Item retry queued' });
        invalidateJobQueries(jobId);
      }
    },
    onError: handleMutationError('Could not retry item'),
  });

  // Hard-delete a terminal job + its items (FK ON DELETE CASCADE removes
  // the items). Backend pins this to terminal jobs only — active jobs
  // must be canceled first or the worker would race the delete.
  const deleteMutation = useMutation({
    mutationFn: async () => apiRequest(`/api/payments-provider/apple-pay/jobs/${jobId}`, 'DELETE'),
    onSuccess: (resp) => {
      if (handleMutationResp(resp, 'Could not delete')) {
        toast({ title: 'Job deleted', description: `Job #${jobId} has been deleted.` });
        invalidateJobQueries(jobId);
        // Drop the now-stale per-job detail cache so a re-open of the same
        // id (very unlikely after delete, but possible if the user navigates
        // back via a deep link) refetches and lands on the 404 path.
        queryClient.removeQueries({ queryKey: applePayJobKeys.detail(jobId) });
        onClose();
      }
    },
    onError: handleMutationError('Could not delete'),
  });

  const canCancel = job ? isActive(job.status) : false;
  const canRetry = job ? isRetryable(job.status) : false;
  const canDelete = job ? isTerminal(job.status) : false;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Job #{jobId}</DialogTitle>
          <DialogDescription>
            {job ? (
              <>Started {formatDate(job.startedAt)} • Completed {formatDate(job.completedAt)}</>
            ) : (
              'Loading job details…'
            )}
          </DialogDescription>
        </DialogHeader>

        {isError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
            <p className="text-destructive font-medium">Failed to load job details.</p>
            <p className="text-muted-foreground mt-1">
              {error instanceof Error ? error.message : 'Unknown error'}
            </p>
            <Button size="sm" variant="outline" className="mt-3" onClick={() => refetch()} disabled={isFetching}>
              {isFetching ? 'Retrying…' : 'Retry'}
            </Button>
          </div>
        ) : isLoading || !job || !counts ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={JOB_STATUS_META[job.status as ApplePayJobStatus]?.variant ?? 'outline'}>
                {JOB_STATUS_META[job.status as ApplePayJobStatus]?.label ?? job.status}
              </Badge>
              {isActive(job.status) && (
                <span className="text-xs text-muted-foreground">Refreshing every 3s…</span>
              )}
              <div className="ml-auto flex flex-wrap gap-2">
                {canCancel && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      if (window.confirm(`Cancel job #${jobId}? In-flight item registrations will finish; the worker will stop picking up new ones within a few seconds.`)) {
                        cancelMutation.mutate();
                      }
                    }}
                    disabled={cancelMutation.isPending}
                    data-testid="button-cancel-job"
                  >
                    {cancelMutation.isPending ? 'Canceling…' : 'Cancel job'}
                  </Button>
                )}
                {canRetry && counts.failed > 0 && (
                  <Button
                    size="sm"
                    variant="default"
                    onClick={() => retryMutation.mutate()}
                    disabled={retryMutation.isPending}
                    data-testid="button-retry-job"
                  >
                    {retryMutation.isPending ? 'Retrying…' : `Retry ${counts.failed} failed item${counts.failed === 1 ? '' : 's'}`}
                  </Button>
                )}
                {canDelete && (
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => {
                      if (
                        window.confirm(
                          `Delete job #${jobId}? This permanently removes the job and its ${items.length} item${items.length === 1 ? '' : 's'}. This cannot be undone.`,
                        )
                      ) {
                        deleteMutation.mutate();
                      }
                    }}
                    disabled={deleteMutation.isPending}
                    data-testid="button-delete-job"
                  >
                    {deleteMutation.isPending ? 'Deleting…' : 'Delete job'}
                  </Button>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <CountTile label="Total" value={counts.total} />
              <CountTile label="Succeeded" value={counts.succeeded} tone="success" />
              <CountTile label="Failed" value={counts.failed} tone="danger" />
              <CountTile label="Skipped" value={counts.skipped} />
              <CountTile label="Pending" value={counts.pending} />
            </div>

            {job.errorMessage && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                {job.errorMessage}
              </div>
            )}

            {recoveredItemCount > 0 && (
              <div
                className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200"
                data-testid="banner-recovered-items"
              >
                <p className="font-medium">Anomaly: {recoveredItemCount} item{recoveredItemCount === 1 ? '' : 's'} recovered after stalling mid-call</p>
                <p className="text-xs mt-1 opacity-80">
                  Their pre-call lease expired before the worker wrote a result, so recovery re-queued them.
                  This usually means the previous worker crashed or the provider call hung. Look for "Revived stalled items" warnings in the server logs.
                </p>
              </div>
            )}

            <JobItemsTable items={items} canRetry={canRetry} itemRetryMutation={itemRetryMutation} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
