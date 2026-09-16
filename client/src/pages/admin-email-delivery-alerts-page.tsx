import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Check, Info, MailX, RefreshCw } from 'lucide-react';
import { Layout } from '@/components/layout';
import { ErrorBoundary } from '@/components/error-boundary';
import { PageErrorState } from '@/components/page-states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { apiRequest, throwIfResNotOk } from '@/lib/queryClient';
import { getApiErrorStatus } from '@/lib/api-error';
import type { ApiResponse } from '@shared/schema';
import {
  EMAIL_DELIVERY_ALERT_REASON_LABELS,
  type EmailDeliveryAlertDto,
  type EmailDeliveryAlertsResponse,
} from '@shared/email-delivery-alerts';

const ALERTS_PATH = '/api/system-admin/email-delivery-alerts';
const ALERTS_COUNT_QUERY_KEY = ['/api/system-admin/email-delivery-alerts/pending-count'] as const;
const ALERTS_LIST_QUERY_KEY = [ALERTS_PATH] as const;

type AlertView = 'pending' | 'history';

function isAlertView(value: string): value is AlertView {
  return value === 'pending' || value === 'history';
}

const EVENT_TYPE_LABELS: Record<string, string> = {
  bounce: 'Bounce',
  dropped: 'Dropped',
};

const FAILURE_TYPE_LABELS: Record<string, string> = {
  blocked: 'Blocked',
  bounce: 'Bounce',
  dropped: 'Dropped',
};

const BOUNCE_CLASSIFICATION_LABELS: Record<string, string> = {
  invalid_address: 'Invalid address',
  technical: 'Technical',
  content: 'Content',
  reputation: 'Reputation',
  mailbox_unavailable: 'Mailbox unavailable',
  frequency_volume: 'Frequency/volume',
  unclassified: 'Unclassified',
};

const REASON_LABELS = new Map<string, string>(Object.entries(EMAIL_DELIVERY_ALERT_REASON_LABELS));

function getBrowserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

const BROWSER_TIME_ZONE = getBrowserTimeZone();

/** Format an API timestamp in the browser's IANA time zone with a safe UTC fallback. */
export function formatAlertTimestamp(value: string | null | undefined, timeZone = BROWSER_TIME_ZONE): string {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Unknown time';

  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone,
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC',
    }).format(date);
  }
}

function displayValue(value: string | null | undefined): string {
  return value && value.trim() ? value : '—';
}

function reasonLabel(reasonCode: string): string {
  return REASON_LABELS.get(reasonCode) ?? 'Unclassified delivery failure';
}

function eventTypeLabel(eventType: string): string {
  return EVENT_TYPE_LABELS[eventType] ?? 'Delivery failure';
}

function failureTypeLabel(failureType: string): string {
  return FAILURE_TYPE_LABELS[failureType] ?? 'Delivery failure';
}

function bounceClassificationLabel(classification: string): string {
  return BOUNCE_CLASSIFICATION_LABELS[classification] ?? 'Unclassified';
}

function AlertListSkeleton() {
  return (
    <div className="space-y-3" data-testid="delivery-alerts-loading">
      {Array.from({ length: 4 }).map((_, index) => (
        <Skeleton key={index} className="h-16 w-full" />
      ))}
    </div>
  );
}

function AlertRow({
  alert,
  view,
  isAcknowledging,
  onAcknowledge,
}: {
  alert: EmailDeliveryAlertDto;
  view: AlertView;
  isAcknowledging: boolean;
  onAcknowledge: (id: number) => void;
}) {
  const providerEventDate = alert.providerEventAt;
  const receivedDate = alert.receivedAt;
  const acknowledgedDate = alert.acknowledgedAt;

  return (
    <TableRow data-testid={`delivery-alert-row-${alert.id}`}>
      <TableCell className="align-top whitespace-nowrap">
        <time dateTime={providerEventDate} title={`${BROWSER_TIME_ZONE} time`}>
          {formatAlertTimestamp(providerEventDate)}
        </time>
        <div className="mt-1 text-xs text-muted-foreground">
          Received {formatAlertTimestamp(receivedDate)}
        </div>
      </TableCell>
      <TableCell className="align-top">
        <div className="max-w-56 break-all font-medium">{alert.recipientEmail}</div>
        <div className="mt-1 text-xs text-muted-foreground">
          {eventTypeLabel(alert.eventType)}
        </div>
      </TableCell>
      <TableCell className="align-top">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="destructive" spacing="compact">
            {failureTypeLabel(alert.failureType)}
          </Badge>
          <span className="text-sm">{reasonLabel(alert.reasonCode)}</span>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {alert.bounceClassification ? (
            <span>Classification: {bounceClassificationLabel(alert.bounceClassification)}</span>
          ) : null}
          {alert.smtpStatus ? <span>SMTP {displayValue(alert.smtpStatus)}</span> : null}
        </div>
      </TableCell>
      <TableCell className="align-top" font="mono" size="xs">
        {displayValue(alert.sendingIp)}
      </TableCell>
      <TableCell className="align-top text-right">
        {view === 'pending' ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onAcknowledge(alert.id)}
            disabled={isAcknowledging}
            data-testid={`button-acknowledge-delivery-alert-${alert.id}`}
            aria-label={`Acknowledge delivery alert for ${alert.recipientEmail}`}
          >
            <Check className="size-4" aria-hidden="true" />
            {isAcknowledging ? 'Acknowledging…' : 'Acknowledge'}
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">
            Acknowledged {formatAlertTimestamp(acknowledgedDate)}
          </span>
        )}
      </TableCell>
    </TableRow>
  );
}

export default function AdminEmailDeliveryAlertsPage() {
  const [view, setView] = useState<AlertView>('pending');
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const acknowledged = view === 'history';

  const queryKey = useMemo(
    () => [ALERTS_PATH, acknowledged] as const,
    [acknowledged],
  );

  const {
    data: alertsResponse,
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
  } = useQuery<ApiResponse<EmailDeliveryAlertsResponse>>({
    queryKey,
    queryFn: async ({ signal }) => {
      const url = acknowledged ? `${ALERTS_PATH}?acknowledged=true` : ALERTS_PATH;
      const response = await fetch(url, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
        signal,
      });
      await throwIfResNotOk(response);
      return response.json();
    },
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

  const acknowledgeMutation = useMutation({
    mutationFn: async (id: number) => apiRequest(`${ALERTS_PATH}/${id}/acknowledge`, 'POST'),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ALERTS_LIST_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ALERTS_COUNT_QUERY_KEY }),
      ]);
      toast({
        title: 'Alert acknowledged',
        description: 'The delivery failure remains available in history for review.',
      });
    },
    onError: () => {
      toast({
        title: 'Alert could not be acknowledged',
        description: 'Refresh the page and try again.',
        variant: 'destructive',
      });
    },
  });

  const payload = alertsResponse?.data;
  const alerts = payload?.alerts ?? [];
  const pendingCount = payload?.unacknowledgedCount ?? 0;

  // Keep the Super Admin sidebar badge in step with the page's active
  // foreground polling without adding a second interval in Layout.
  useEffect(() => {
    if (payload?.unacknowledgedCount === undefined) return;
    queryClient.setQueryData<ApiResponse<{ count: number }>>(ALERTS_COUNT_QUERY_KEY, {
      success: true,
      data: { count: payload.unacknowledgedCount },
    });
  }, [payload?.unacknowledgedCount, queryClient]);

  const handleRefresh = () => {
    void Promise.all([
      refetch(),
      queryClient.invalidateQueries({ queryKey: ALERTS_COUNT_QUERY_KEY }),
    ]);
  };

  const handleAcknowledge = (id: number) => {
    acknowledgeMutation.mutate(id);
  };

  if (isError) {
    const status = getApiErrorStatus(error);
    return (
      <Layout>
        <PageErrorState
          message={status === 403
            ? 'Your current account does not have access to delivery alerts.'
            : status === 401
              ? 'Please sign in again to view delivery alerts.'
              : "We couldn't load delivery alerts. Please try again."}
          onRetry={status === 401 || status === 403 ? undefined : handleRefresh}
        />
      </Layout>
    );
  }

  return (
    <Layout>
      <ErrorBoundary level="section">
        <div className="min-w-0 w-full space-y-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">SendGrid delivery alerts</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Review failed email deliveries and record when an operational alert has been seen.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Times are shown in your browser time zone ({BROWSER_TIME_ZONE}).
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={handleRefresh}
              disabled={isFetching}
              data-testid="button-refresh-delivery-alerts"
            >
              <RefreshCw className={isFetching ? 'size-4 animate-spin' : 'size-4'} aria-hidden="true" />
              {isFetching ? 'Refreshing…' : 'Refresh'}
            </Button>
          </div>

          {payload?.webhookConfigured === false ? (
            <Alert data-testid="delivery-alerts-webhook-not-configured">
              <MailX className="size-4" aria-hidden="true" />
              <AlertTitle>SendGrid delivery alerts are not connected</AlertTitle>
              <AlertDescription>
                <p>
                  New SendGrid delivery failures cannot reach this page until the delivery alert connection is configured.
                </p>
                <p className="mt-2">
                  Follow the SendGrid delivery alert setup guide before testing the connection.
                </p>
              </AlertDescription>
            </Alert>
          ) : null}

          <Card className="min-w-0">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <CardHeader>
                <CardTitle size="lg">Delivery failure queue</CardTitle>
              </CardHeader>
              <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="delivery-alerts-pending-summary">
                <Info className="size-4" aria-hidden="true" />
                <span>{pendingCount} pending alert{pendingCount === 1 ? '' : 's'}</span>
              </div>
            </div>
            <CardContent className="min-w-0">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <Tabs value={view} onValueChange={(nextView) => {
                  if (isAlertView(nextView)) setView(nextView);
                }}>
                  <TabsList aria-label="Delivery alert view">
                    <TabsTrigger value="pending" data-testid="tab-delivery-alerts-pending">
                      Pending
                      {pendingCount > 0 ? (
                        <span className="ml-2 rounded-full bg-destructive px-1.5 py-0.5 text-xs text-destructive-foreground">
                          {pendingCount > 99 ? '99+' : pendingCount}
                        </span>
                      ) : null}
                    </TabsTrigger>
                    <TabsTrigger value="history" data-testid="tab-delivery-alerts-history">
                      History
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
                <span className="text-xs text-muted-foreground">
                  {view === 'pending' ? 'Latest 50 unacknowledged failures' : 'Latest 50 acknowledged failures'}
                </span>
              </div>

              {isLoading ? (
                <AlertListSkeleton />
              ) : alerts.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-md border border-dashed px-6 py-10 text-center" data-testid="delivery-alerts-empty">
                  <AlertCircle className="size-8 text-muted-foreground" aria-hidden="true" />
                  <p className="mt-3 text-sm font-medium">
                    {view === 'pending' ? 'No pending delivery failures' : 'No acknowledged delivery failures'}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {view === 'pending'
                      ? 'New validated SendGrid failures will appear here when the webhook is connected.'
                      : 'Acknowledged failures will remain available here for operational history.'}
                  </p>
                </div>
              ) : (
                <div className="min-w-0 overflow-x-auto">
                  <Table className="min-w-200">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Provider event</TableHead>
                        <TableHead>Recipient</TableHead>
                        <TableHead>Failure explanation</TableHead>
                        <TableHead>Sending IP</TableHead>
                        <TableHead className="text-right">Action</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {alerts.map((alert) => (
                        <AlertRow
                          key={alert.id}
                          alert={alert}
                          view={view}
                          isAcknowledging={acknowledgeMutation.isPending && acknowledgeMutation.variables === alert.id}
                          onAcknowledge={handleAcknowledge}
                        />
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          <p className="text-xs text-muted-foreground">
            Acknowledging an alert records operational review. It does not resend the message or change delivery status; every new provider failure creates a new alert.
          </p>
        </div>
      </ErrorBoundary>
    </Layout>
  );
}
