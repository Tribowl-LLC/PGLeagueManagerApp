import type { UseMutationResult } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { ApplePayJobItem, ApplePayJobItemStatus } from '@shared/schema';
import { ITEM_STATUS_META, formatDate } from './utils';

type ItemRetryResponse = {
  success: boolean;
  data: unknown;
  error?: { message: string; code?: string };
};

interface JobItemsTableProps {
  items: ApplePayJobItem[];
  canRetry: boolean;
  itemRetryMutation: UseMutationResult<ItemRetryResponse, unknown, number, unknown>;
}

export function JobItemsTable({ items, canRetry, itemRetryMutation }: JobItemsTableProps) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Domain</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Message</TableHead>
            <TableHead>Processed</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="text-center" tone="muted" density="comfortable">
                No items recorded for this job.
              </TableCell>
            </TableRow>
          ) : (
            items.map((item) => {
              const meta = ITEM_STATUS_META[item.status as ApplePayJobItemStatus] ?? ITEM_STATUS_META.pending;
              // Item retry is only safe when the parent job is terminal —
              // otherwise the worker's preloaded pending queue would skip
              // the reset row. Backend enforces this too.
              const itemRetryable = item.status === 'failed' && canRetry;
              const isThisItemRetrying = itemRetryMutation.isPending && itemRetryMutation.variables === item.id;
              return (
                <TableRow key={item.id}>
                  <TableCell weight="medium">{item.domain}</TableCell>
                  <TableCell>
                    <Badge variant={meta.variant}>{meta.label}</Badge>
                  </TableCell>
                  <TableCell className="max-w-md">
                    <span className="text-sm text-muted-foreground line-clamp-3">
                      {item.message || '—'}
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap" size="sm" tone="muted">
                    {formatDate(item.processedAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    {itemRetryable ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => itemRetryMutation.mutate(item.id)}
                        disabled={itemRetryMutation.isPending}
                        data-testid={`button-retry-item-${item.id}`}
                      >
                        {isThisItemRetrying ? 'Retrying…' : 'Retry'}
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}
