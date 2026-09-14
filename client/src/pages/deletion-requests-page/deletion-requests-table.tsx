import { Fragment } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { DeletionRequest, DeletionRequestStatus } from '@shared/schema';
import { ExecutionSummaryPanel } from './execution-summary-panel';
import { formatDate, parseExecutionSummary, STATUS_LABELS, type ReviewMode } from './utils';

interface DeletionRequestsTableProps {
  isLoading: boolean;
  statusFilter: DeletionRequestStatus;
  requests: DeletionRequest[];
  expandedRequestIds: Set<number>;
  toggleExpanded: (id: number) => void;
  openReview: (req: DeletionRequest, mode: ReviewMode) => void;
}

export function DeletionRequestsTable({
  isLoading,
  statusFilter,
  requests,
  expandedRequestIds,
  toggleExpanded,
  openReview,
}: DeletionRequestsTableProps) {
  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }
  if (requests.length === 0) {
    return (
      <p className="text-muted-foreground text-center py-8">
        No {statusFilter} deletion requests.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Email</TableHead>
            <TableHead>Submitted</TableHead>
            <TableHead>Reason</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Reviewed</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {requests.map((req) => {
            const meta = STATUS_LABELS[req.status as DeletionRequestStatus] ?? STATUS_LABELS.pending;
            const summary = parseExecutionSummary(req.executionSummary);
            const expanded = expandedRequestIds.has(req.id);
            const providerFailures = summary?.paymentProvider.filter((p) => !p.deleted).length ?? 0;
            return (
              <Fragment key={req.id}>
                  <TableRow data-testid={`deletion-request-row-${req.id}`}>
                    <TableCell weight="medium">{req.email}</TableCell>
                    <TableCell className="whitespace-nowrap">{formatDate(req.createdAt)}</TableCell>
                    <TableCell className="max-w-xs">
                      <span className="line-clamp-2 text-sm text-muted-foreground">
                        {req.reason || '—'}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={meta.variant}>{meta.label}</Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap" size="sm" tone="muted">
                      {req.reviewedAt ? formatDate(req.reviewedAt) : '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex gap-2 justify-end flex-wrap items-center">
                        {req.status === 'pending' ? (
                          <>
                            <Button
                              size="sm"
                              variant="destructive"
                              onClick={() => openReview(req, 'execute')}
                            >
                              Delete account data
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => openReview(req, 'completed')}
                            >
                              Mark completed
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => openReview(req, 'rejected')}
                            >
                              Reject
                            </Button>
                          </>
                        ) : req.adminNote ? (
                          <span className="text-xs text-muted-foreground italic">{req.adminNote}</span>
                        ) : null}
                        {summary && (
                          <Button
                            size="sm"
                            variant="ghost"
                            data-testid={`toggle-summary-${req.id}`}
                            aria-expanded={expanded}
                            aria-label={expanded ? 'Hide execution details' : 'Show execution details'}
                            onClick={() => toggleExpanded(req.id)}
                          >
                            {expanded ? (
                              <ChevronDown className="size-4" />
                            ) : (
                              <ChevronRight className="size-4" />
                            )}
                            <span className="ml-1 text-xs">
                              Execution details
                              {providerFailures > 0 && (
                                <Badge
                                  variant="destructive"
                                  size="compact" className="ml-2"
                                >
                                  {providerFailures} failed
                                </Badge>
                              )}
                            </span>
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                  {expanded && summary && (
                    <TableRow
                      data-testid={`deletion-request-summary-row-${req.id}`}
                      variant="plain" hover="none"
                    >
                      <TableCell colSpan={6} density="compact">
                        <ExecutionSummaryPanel summary={summary} requestId={req.id} />
                      </TableCell>
                    </TableRow>
                  )}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
