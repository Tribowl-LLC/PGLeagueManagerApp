import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Layout } from '@/components/layout';
import { ErrorBoundary } from '@/components/error-boundary';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle } from 'lucide-react';
import type { ApiResponse, AdminEmailChangeAudit, PaymentSyncStatus } from '@shared/schema';
import { parsePaymentSyncStatus } from '@shared/schema';

interface AdminEmailChangeAuditRow extends AdminEmailChangeAudit {
  actorName: string | null;
  targetName: string | null;
}

// Render the post-confirm payment-sync status (task #487):
//   - null   → target user hasn't clicked the confirmation link yet
//              (or the row predates this column). Render an unobtrusive
//              "Awaiting confirmation" stub so admins can tell the
//              difference between "still pending" and "confirmed clean".
//   - pending_retry → the actionable case. Bright destructive badge
//              with an icon so it cannot be missed when scanning the
//              table; sub-line carries the confirmed-at timestamp so
//              the admin knows when the failure happened.
//   - synced / skipped / not_applicable → render quietly so the
//              "needs retry" rows visually pop. We still show *which*
//              terminal state it landed in (not just a checkmark) for
//              triage clarity.
function PostConfirmCell({
  rawStatus,
  confirmedAt,
}: {
  rawStatus: string | null;
  confirmedAt: string | null;
}) {
  if (rawStatus === null) {
    return (
      <span className="text-xs text-muted-foreground" data-testid="post-confirm-pending">
        Awaiting confirmation
      </span>
    );
  }
  // `parsePaymentSyncStatus` collapses an unknown future status to
  // `not_applicable` so the UI stays silent rather than rendering a
  // confusing label — same defensive pattern the profile card uses.
  const status: PaymentSyncStatus = parsePaymentSyncStatus(rawStatus);
  const when = confirmedAt ? formatTimestamp(confirmedAt) : null;

  if (status === 'pending_retry') {
    return (
      <div className="flex flex-col gap-1" data-testid="post-confirm-pending-retry">
        <Badge variant="destructive" spacing="compact" className="w-fit">
          <AlertTriangle className="size-3" aria-hidden />
          Needs manual retry
        </Badge>
        {when && (
          <span className="text-xs text-muted-foreground">
            Confirmed {when}
          </span>
        )}
      </div>
    );
  }

  const labelByStatus: Record<Exclude<PaymentSyncStatus, 'pending_retry'>, string> = {
    synced: 'Synced',
    skipped: 'Skipped (no provider)',
    not_applicable: 'Not applicable',
  };
  return (
    <div className="flex flex-col gap-0.5" data-testid={`post-confirm-${status}`}>
      <span className="text-xs">
        {labelByStatus[status]}
      </span>
      {when && (
        <span className="text-xs text-muted-foreground">
          {when}
        </span>
      )}
    </div>
  );
}

interface AuditListResponse {
  rows: AdminEmailChangeAuditRow[];
  total: number;
  limit: number;
  offset: number;
}

const PAGE_SIZE = 50;

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

export default function AdminEmailChangeAuditsPage() {
  // Filter input is kept separate from the applied filter so a stray
  // keystroke doesn't trigger a refetch on every character.
  const [targetInput, setTargetInput] = useState('');
  const [appliedTargetUserId, setAppliedTargetUserId] = useState<number | null>(null);
  const [page, setPage] = useState(0);

  const queryKey = useMemo(
    () => ['/api/system-admin/admin-email-change-audits', { targetUserId: appliedTargetUserId, page }] as const,
    [appliedTargetUserId, page],
  );

  const { data, isLoading, isFetching, isError, error, refetch } = useQuery<ApiResponse<AuditListResponse>>({
    queryKey,
    queryFn: async () => {
      const queryParams = new URLSearchParams();
      queryParams.set('limit', String(PAGE_SIZE));
      queryParams.set('offset', String(page * PAGE_SIZE));
      if (appliedTargetUserId !== null) {
        queryParams.set('targetUserId', String(appliedTargetUserId));
      }
      const res = await fetch(
        `/api/system-admin/admin-email-change-audits?${queryParams.toString()}`,
        { credentials: 'include' },
      );
      if (!res.ok) {
        throw new Error(`Failed to load audits (${res.status})`);
      }
      return res.json();
    },
  });

  const rows = data?.data?.rows ?? [];
  const total = data?.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function applyFilter(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = targetInput.trim();
    if (trimmed === '') {
      setAppliedTargetUserId(null);
    } else {
      const parsed = parseInt(trimmed, 10);
      setAppliedTargetUserId(Number.isFinite(parsed) && parsed > 0 ? parsed : null);
    }
    setPage(0);
  }

  function clearFilter() {
    setTargetInput('');
    setAppliedTargetUserId(null);
    setPage(0);
  }

  return (
    <Layout>
      <ErrorBoundary level="page">
        <div className="space-y-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Admin email-change history
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Read-only history of email-change requests system admins initiated on
              behalf of other users. Both old and new addresses are stored masked.
            </p>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Filter</CardTitle>
            </CardHeader>
            <CardContent>
              <form
                className="flex flex-col sm:flex-row sm:items-end gap-3"
                onSubmit={applyFilter}
              >
                <div className="flex-1 max-w-xs">
                  <Label htmlFor="target-user-id">Target user ID</Label>
                  <Input
                    id="target-user-id"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    placeholder="e.g. 42"
                    value={targetInput}
                    onChange={(e) => setTargetInput(e.target.value)}
                    data-testid="input-target-user-id"
                  />
                </div>
                <div className="flex gap-2">
                  <Button type="submit" data-testid="button-apply-filter">
                    Apply
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={clearFilter}
                    disabled={appliedTargetUserId === null && targetInput === ''}
                    data-testid="button-clear-filter"
                  >
                    Clear
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>
                Recent admin-initiated email changes
                {appliedTargetUserId !== null && (
                  <span className="text-sm font-normal text-muted-foreground ml-2">
                    (filtered to user #{appliedTargetUserId})
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-10" />
                  ))}
                </div>
              ) : isError ? (
                <div
                  className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm"
                  data-testid="audit-list-error"
                >
                  <p className="font-medium text-destructive">
                    Failed to load admin email-change history
                  </p>
                  <p className="text-muted-foreground mt-1">
                    {error instanceof Error ? error.message : 'Unexpected error fetching audits.'}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={() => refetch()}
                    data-testid="button-retry-fetch"
                  >
                    Retry
                  </Button>
                </div>
              ) : rows.length === 0 ? (
                <p className="text-sm text-muted-foreground py-6 text-center">
                  No admin-initiated email changes found
                  {appliedTargetUserId !== null ? ' for this user.' : '.'}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>When</TableHead>
                        <TableHead>Target user</TableHead>
                        <TableHead>Old email (masked)</TableHead>
                        <TableHead>New email (masked)</TableHead>
                        <TableHead>Initiated by</TableHead>
                        <TableHead>Post-confirm sync</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((row) => (
                        <TableRow key={row.id} data-testid={`row-audit-${row.id}`}>
                          <TableCell className="whitespace-nowrap">
                            {formatTimestamp(row.createdAt)}
                          </TableCell>
                          <TableCell>
                            <div className="font-medium">
                              {row.targetName ?? '—'}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              #{row.targetUserId}
                            </div>
                          </TableCell>
                          <TableCell font="mono" size="xs">
                            {row.oldEmailMasked}
                          </TableCell>
                          <TableCell font="mono" size="xs">
                            {row.newEmailMasked}
                          </TableCell>
                          <TableCell>
                            <div className="font-medium">
                              {row.actorName ?? '—'}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              #{row.actorUserId}
                            </div>
                          </TableCell>
                          <TableCell>
                            <PostConfirmCell
                              rawStatus={row.postConfirmPaymentSyncStatus}
                              confirmedAt={row.postConfirmedAt}
                            />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              {total > PAGE_SIZE && (
                <div className="flex items-center justify-between mt-4 pt-4 border-t">
                  <div className="text-sm text-muted-foreground">
                    Page {page + 1} of {totalPages} · {total} total
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage((p) => Math.max(0, p - 1))}
                      disabled={page === 0 || isFetching}
                      data-testid="button-prev-page"
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                      disabled={page >= totalPages - 1 || isFetching}
                      data-testid="button-next-page"
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </ErrorBoundary>
    </Layout>
  );
}
