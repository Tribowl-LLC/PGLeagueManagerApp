import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearch } from 'wouter';
import { Layout } from '@/components/layout';
import { ErrorBoundary } from '@/components/error-boundary';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { ApiResponse, ApplePayJob, ApplePayJobStatus } from '@shared/schema';
import { JobDetailDialog } from './apple-pay-jobs-page/job-detail-dialog';
import { JOB_STATUS_META, formatDate, isActive } from './apple-pay-jobs-page/utils';

export default function ApplePayJobsPage() {
  const [activeJobId, setActiveJobId] = useState<number | null>(null);

  // Optional `?jobs=1,2,3` filter. Used by the dashboard recovery
  // banner (#272) to deep-link admins straight to the jobs that just
  // triggered an alert. Invalid / missing values fall back to "show all".
  const search = useSearch();
  const filteredJobIds = useMemo(() => {
    const params = new URLSearchParams(search);
    const raw = params.get('jobs');
    if (!raw) return null;
    const ids = raw
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    return ids.length > 0 ? new Set(ids) : null;
  }, [search]);

  // Each job is augmented server-side with `recoveredItemCount` so the
  // list view can flag anomalous jobs (#270) without per-row fetches.
  const { data: jobsResponse, isLoading, isError, error, refetch, isFetching } = useQuery<ApiResponse<{ jobs: Array<ApplePayJob & { recoveredItemCount?: number }> }>>({
    queryKey: ['/api/payments-provider/apple-pay/jobs'],
    refetchInterval: (query) => {
      const jobs = query.state.data?.data?.jobs ?? [];
      return jobs.some((j) => isActive(j.status)) ? 5000 : false;
    },
  });

  const allJobs = jobsResponse?.data?.jobs ?? [];
  const jobs = filteredJobIds
    ? allJobs.filter((j) => filteredJobIds.has(j.id))
    : allJobs;

  return (
    <Layout>
      <ErrorBoundary level="section">
        <div className="container py-6">
          <div className="mb-6">
            <h1 className="text-4xl font-bold">Apple Pay Jobs</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Bulk Apple Pay domain registration jobs. The latest 25 jobs are shown.
            </p>
            {filteredJobIds && (
              <div
                className="mt-3 inline-flex items-center gap-2 rounded-md border border-warning-500/40 bg-warning-500/10 px-3 py-1.5 text-xs text-warning-900 dark:text-warning-200"
                data-testid="banner-jobs-filter-active"
              >
                <span>
                  Filtered to {jobs.length} job{jobs.length === 1 ? '' : 's'} from a recovery alert
                </span>
                <a
                  href="/admin/apple-pay-jobs"
                  className="font-semibold underline underline-offset-2 hover:opacity-80"
                  data-testid="link-clear-jobs-filter"
                >
                  Clear filter
                </a>
              </div>
            )}
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Recent jobs ({jobs.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {isError ? (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
                  <p className="text-destructive font-medium">Failed to load jobs.</p>
                  <p className="text-muted-foreground mt-1">
                    {error instanceof Error ? error.message : 'Unknown error'}
                  </p>
                  <Button size="sm" variant="outline" className="mt-3" onClick={() => refetch()} disabled={isFetching}>
                    {isFetching ? 'Retrying…' : 'Retry'}
                  </Button>
                </div>
              ) : isLoading ? (
                <div className="space-y-3">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : jobs.length === 0 ? (
                <p className="text-muted-foreground text-center py-8">
                  No jobs yet. Trigger a bulk Apple Pay registration to see jobs here.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Job</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Total</TableHead>
                        <TableHead className="text-right">Succeeded</TableHead>
                        <TableHead className="text-right">Failed</TableHead>
                        <TableHead className="text-right">Skipped</TableHead>
                        <TableHead>Started</TableHead>
                        <TableHead>Completed</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {jobs.map((job) => {
                        const meta = JOB_STATUS_META[job.status as ApplePayJobStatus] ?? { label: job.status, variant: 'outline' as const };
                        return (
                          <TableRow key={job.id}>
                            <TableCell weight="medium">#{job.id}</TableCell>
                            <TableCell>
                              <div className="flex flex-wrap items-center gap-1">
                                <Badge variant={meta.variant}>{meta.label}</Badge>
                                {(job.recoveredItemCount ?? 0) > 0 && (
                                  <Badge
                                    variant="outline"
                                    tone="warningSubtle"
                                    title={`${job.recoveredItemCount} item${job.recoveredItemCount === 1 ? '' : 's'} were recovered after stalling mid-call`}
                                    data-testid={`badge-lease-anomaly-${job.id}`}
                                  >
                                    Lease anomaly
                                  </Badge>
                                )}
                              </div>
                            </TableCell>
                            <TableCell className="text-right">{job.totalDomains}</TableCell>
                            <TableCell className="text-right" tone="success">{job.succeededCount}</TableCell>
                            <TableCell className="text-right" tone="destructive">{job.failedCount}</TableCell>
                            <TableCell className="text-right">{job.skippedCount}</TableCell>
                            <TableCell className="whitespace-nowrap" size="sm" tone="muted">
                              {formatDate(job.startedAt)}
                            </TableCell>
                            <TableCell className="whitespace-nowrap" size="sm" tone="muted">
                              {formatDate(job.completedAt)}
                            </TableCell>
                            <TableCell className="text-right">
                              <Button size="sm" variant="outline" onClick={() => setActiveJobId(job.id)}>
                                View
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          {activeJobId !== null && (
            <JobDetailDialog jobId={activeJobId} onClose={() => setActiveJobId(null)} />
          )}
        </div>
      </ErrorBoundary>
    </Layout>
  );
}
