import { Button } from '@/components/ui/button';
import { AlertTriangle, CheckCircle2, Copy, Download } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import type { DeletionExecutionSummary } from '@shared/schema';
import { formatDate } from './utils';

/**
 * Build the export filename for a single deletion-request execution
 * summary. The shape is intentionally compliance-friendly:
 *
 *   deletion-request-<requestId>-<executedAtIsoZ>.json
 *
 * Colons in the ISO timestamp are replaced with dashes because
 * Windows file systems reject `:` in filenames, and SAR / GDPR
 * tickets often live in Windows-hosted SharePoint or Outlook
 * attachments. We fall back to "now" if `executedAt` is missing
 * (which can only happen for legacy malformed rows that survived
 * the parser's normalization).
 */
function buildSummaryFilename(requestId: number, executedAt: string | undefined): string {
  const raw = executedAt && executedAt.length > 0 ? executedAt : new Date().toISOString();
  const date = new Date(raw);
  const stamp = (Number.isNaN(date.getTime()) ? new Date() : date)
    .toISOString()
    .replace(/[:.]/g, '-');
  return `deletion-request-${requestId}-${stamp}.json`;
}

export function ExecutionSummaryPanel({
  summary,
  requestId,
}: {
  summary: DeletionExecutionSummary;
  requestId: number;
}) {
  const { toast } = useToast();
  const bowlersDone = summary.bowlers.filter((b) => b.anonymized).length;
  const bowlersFailed = summary.bowlers.filter((b) => !b.anonymized);
  const providersDone = summary.paymentProvider.filter((p) => p.deleted).length;
  const providersFailed = summary.paymentProvider.filter((p) => !p.deleted);

  // Pretty-print so the JSON is grep-able and diffable when an
  // admin pastes it straight into a SAR ticket. Using two-space
  // indent matches the convention used across the codebase's
  // other JSON exports.
  const summaryJson = JSON.stringify(summary, null, 2);

  const handleCopy = async () => {
    // navigator.clipboard is gated on a secure context. In dev
    // over plain HTTP the API is undefined, so guard before calling
    // and surface a clear error toast — failing silently here
    // would leave the admin staring at an unchanged button thinking
    // the copy worked.
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard API unavailable in this browser context');
      }
      await navigator.clipboard.writeText(summaryJson);
      toast({
        title: 'Copied execution summary',
        description: 'The JSON payload has been copied to your clipboard.',
      });
    } catch (err) {
      toast({
        title: 'Copy failed',
        description: err instanceof Error ? err.message : 'Could not copy to clipboard.',
        variant: 'destructive',
      });
    }
  };

  const handleDownload = () => {
    try {
      const blob = new Blob([summaryJson], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = buildSummaryFilename(requestId, summary.executedAt);
      // Some browsers require the anchor to be in the DOM for the
      // synthetic click to be honored, so attach + detach.
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      // Revoke on the next tick: a few browsers fire the actual
      // download asynchronously after click(), and revoking the
      // blob URL synchronously can cancel the download mid-flight.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (err) {
      toast({
        title: 'Download failed',
        description: err instanceof Error ? err.message : 'Could not start the download.',
        variant: 'destructive',
      });
    }
  };

  return (
    <div className="rounded-md border bg-muted/30 p-4 space-y-4 text-sm" data-testid="execution-summary-panel">
      <div className="flex items-center justify-end gap-2 -mb-2">
        <Button
          size="sm"
          variant="outline"
          onClick={handleCopy}
          data-testid={`button-copy-summary-${requestId}`}
        >
          <Copy className="size-3.5 mr-1.5" />
          Copy JSON
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={handleDownload}
          data-testid={`button-download-summary-${requestId}`}
        >
          <Download className="size-3.5 mr-1.5" />
          Download .json
        </Button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
        <div>
          <span className="text-muted-foreground">Executed at: </span>
          <span className="font-medium">{formatDate(summary.executedAt)}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Executed by user ID: </span>
          <span className="font-medium">{summary.executedBy}</span>
        </div>
        <div>
          <span className="text-muted-foreground">User account: </span>
          {summary.user.deleted ? (
            <span className="inline-flex items-center gap-1 text-success-700 dark:text-success-400">
              <CheckCircle2 className="size-3.5" /> deleted (id {summary.user.userId})
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-warning-700 dark:text-warning-400">
              <AlertTriangle className="size-3.5" />
              {summary.user.reason || 'not deleted'}
            </span>
          )}
        </div>
        <div>
          <span className="text-muted-foreground">Pending email-change requests removed: </span>
          <span className="font-medium">{summary.emailChangeRequestsDeleted}</span>
        </div>
        {/*
          Task #349: surface the post-deletion confirmation email
          outcome so the admin history view can distinguish "user
          opted out on the public form" from "we tried but SendGrid
          failed" without consulting the server logs. Older summaries
          (written before this field existed) render as a neutral
          "unknown" pill; the parser leaves the field undefined in
          that case rather than synthesizing a misleading default.
        */}
        <div data-testid={`confirmation-email-status-${requestId}`}>
          <span className="text-muted-foreground">Confirmation email: </span>
          {!summary.confirmationEmail ? (
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <AlertTriangle className="size-3.5" /> not recorded (legacy run)
            </span>
          ) : summary.confirmationEmail.suppressedByUser ? (
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <CheckCircle2 className="size-3.5" /> suppressed by user choice
            </span>
          ) : summary.confirmationEmail.sent ? (
            <span className="inline-flex items-center gap-1 text-success-700 dark:text-success-400">
              <CheckCircle2 className="size-3.5" /> sent
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-destructive">
              <AlertTriangle className="size-3.5" />
              failed to send
              {summary.confirmationEmail.error
                ? ` — ${summary.confirmationEmail.error}`
                : ''}
            </span>
          )}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <h4 className="font-semibold">Bowler records</h4>
          <span className="text-xs text-muted-foreground">
            {bowlersDone} of {summary.bowlers.length} anonymized
          </span>
        </div>
        {summary.bowlers.length === 0 ? (
          <p className="text-xs text-muted-foreground">No bowler records were matched for this email.</p>
        ) : bowlersFailed.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            All matching bowler records were anonymized successfully.
          </p>
        ) : (
          <ul className="space-y-1">
            {bowlersFailed.map((b) => (
              <li
                key={b.bowlerId}
                className="text-xs text-destructive flex items-start gap-2"
                data-testid={`bowler-failed-${b.bowlerId}`}
              >
                <AlertTriangle className="size-3.5 mt-0.5 shrink-0" />
                <span>
                  Bowler #{b.bowlerId}: failed to anonymize
                  {b.reason ? ` — ${b.reason}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <h4 className="font-semibold">Payment-provider customer records</h4>
          <span className="text-xs text-muted-foreground">
            {providersDone} of {summary.paymentProvider.length} deleted
          </span>
        </div>
        {summary.paymentProvider.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No payment-provider customer records were associated with these bowlers.
          </p>
        ) : (
          <ul className="space-y-1">
            {summary.paymentProvider.map((p, i) => (
              <li
                key={`${p.locationId}-${p.customerId}-${i}`}
                className={`text-xs flex items-start gap-2 ${p.deleted ? 'text-muted-foreground' : 'text-destructive'}`}
                data-testid={p.deleted ? `provider-ok-${i}` : `provider-failed-${i}`}
              >
                {p.deleted ? (
                  <CheckCircle2 className="size-3.5 mt-0.5 shrink-0" />
                ) : (
                  <AlertTriangle className="size-3.5 mt-0.5 shrink-0" />
                )}
                <span>
                  <span className="font-mono">{p.providerName}</span> · location {p.locationId} ·
                  customer <span className="font-mono">{p.customerId}</span>
                  {p.deleted ? ' — deleted' : ` — failed${p.error ? `: ${p.error}` : ''}`}
                </span>
              </li>
            ))}
          </ul>
        )}
        {providersFailed.length > 0 && (
          <p className="mt-2 text-xs text-warning-700 dark:text-warning-400">
            Follow up manually with the listed payment processor(s) to confirm the customer
            record is gone.
          </p>
        )}
      </div>
    </div>
  );
}
