import { useState } from 'react';
import { Link } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, X } from 'lucide-react';
import type { ApiResponse, User } from '@shared/schema';

interface RecentRecoveryAlert {
  sentAt: string;
  itemCount: number;
  affectedJobIds: number[];
}

// Per-admin dismissal key. Including the user id is critical on shared
// browsers (kiosks, family computers): without it, one admin dismissing
// the banner would suppress it for every other admin who logs in on
// the same device.
function dismissKey(userId: number): string {
  return `apple-pay-recovery-alert-dismissed-at:user:${userId}`;
}

function readDismissed(userId: number | null | undefined): string | null {
  if (!userId) return null;
  try {
    return window.localStorage.getItem(dismissKey(userId));
  } catch {
    return null;
  }
}

function writeDismissed(userId: number, sentAt: string) {
  try {
    window.localStorage.setItem(dismissKey(userId), sentAt);
  } catch {
    // Storage may be unavailable (private mode, quota, etc.) — best effort.
  }
}

function formatTimeAgo(iso: string): string {
  try {
    const ms = Date.now() - new Date(iso).getTime();
    const mins = Math.round(ms / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/**
 * Top-of-dashboard banner that fires when the Apple Pay recovery alerter
 * sent an email within the last 24 hours (#272). Dismissal is tracked
 * per-browser via localStorage keyed by the alert's sentAt — a fresh
 * alert (different timestamp) will surface the banner again even after
 * a previous one was dismissed.
 *
 * Only system admins fetch the underlying endpoint. The query is silent
 * on errors so a transient backend hiccup never blocks the dashboard.
 */
export function ApplePayRecoveryBanner() {
  const { data: userResponse } = useQuery<ApiResponse<User>>({
    queryKey: ['/api/user'],
    staleTime: 1000 * 60 * 5,
  });
  const isSystemAdmin = userResponse?.data?.role === 'system_admin';
  const userId = userResponse?.data?.id ?? null;

  const { data } = useQuery<ApiResponse<{ alert: RecentRecoveryAlert | null }>>({
    queryKey: ['/api/payments-provider/apple-pay/recovery-alerts/recent'],
    enabled: isSystemAdmin,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });

  const alert = data?.data?.alert ?? null;

  if (!isSystemAdmin || !alert || !userId) return null;

  // Remount the body whenever the alert identity OR the signed-in user
  // changes so its dismissal state re-reads from storage on a fresh
  // mount. This keeps a dismissed alert dismissed across navigations,
  // re-surfaces a fresh alert (new sentAt) even after a prior dismissal,
  // and ensures switching accounts on a shared browser never inherits
  // the previous admin's dismissal.
  return <ApplePayRecoveryBannerBody key={`${userId}:${alert.sentAt}`} userId={userId} alert={alert} />;
}

function ApplePayRecoveryBannerBody({ userId, alert }: { userId: number; alert: RecentRecoveryAlert }) {
  // Initialise dismissal from storage once per mount (the parent's key
  // forces a fresh mount when the alert or user changes).
  const [dismissed, setDismissed] = useState(() => readDismissed(userId) === alert.sentAt);
  if (dismissed) return null;

  const jobsParam = alert.affectedJobIds.length > 0 ? `?jobs=${alert.affectedJobIds.join(',')}` : '';
  const jobsLabel = alert.affectedJobIds.length === 1
    ? `job #${alert.affectedJobIds[0]}`
    : `${alert.affectedJobIds.length} jobs`;

  return (
    <div
      className="rounded-md border border-amber-500/50 bg-amber-50 p-4 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200 flex items-start gap-3"
      data-testid="banner-apple-pay-recovery-alert"
      role="alert"
    >
      <AlertTriangle className="size-5 mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="font-medium">
          Apple Pay recovery alert sent {formatTimeAgo(alert.sentAt)}:{' '}
          {alert.itemCount} item{alert.itemCount === 1 ? '' : 's'} recovered across{' '}
          {jobsLabel}.
        </p>
        <p className="text-xs mt-1 opacity-90">
          The boot-time worker revived stalled domain registrations and emailed
          on-call. Click through to investigate while the context is fresh.
        </p>
        <div className="mt-2">
          <Link
            href={`/admin/apple-pay-jobs${jobsParam}`}
            className="inline-flex items-center text-sm font-semibold underline underline-offset-2 hover:opacity-80"
            data-testid="link-apple-pay-recovery-investigate"
          >
            Investigate Apple Pay jobs →
          </Link>
        </div>
      </div>
      <button
        type="button"
        onClick={() => {
          writeDismissed(userId, alert.sentAt);
          setDismissed(true);
        }}
        className="text-amber-700 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100"
        aria-label="Dismiss recovery alert banner"
        data-testid="button-dismiss-apple-pay-recovery-alert"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
