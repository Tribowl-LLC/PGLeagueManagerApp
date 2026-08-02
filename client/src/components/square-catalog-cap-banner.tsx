import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, X } from 'lucide-react';
import type { ApiResponse, User } from '@shared/schema';

interface RecentCatalogCapAlert {
  sentAt: string;
  organizationId: number | null;
  locationId: number;
  reason: 'max_items' | 'max_pages';
  context: string;
}

// Per-admin dismissal key. Including the user id is critical on shared
// browsers (kiosks, family computers): without it, one admin dismissing
// the banner would suppress it for every other admin who logs in on
// the same device. Keyed by the most-recent sentAt so a fresh alert
// re-surfaces after a previous dismissal.
function dismissKey(userId: number): string {
  return `square-catalog-cap-alert-dismissed-at:user:${userId}`;
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
    const days = Math.round(hours / 24);
    if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/**
 * Top-of-dashboard banner that fires when one or more organizations
 * have hit the Square catalog pagination safety cap recently (#644).
 * Only system admins fetch the underlying endpoint; the query is
 * silent on errors so a transient backend hiccup never blocks the
 * dashboard. The banner shows a count plus the most recent affected
 * location so support staff have a starting point for outreach.
 *
 * Dismissal is tracked per-browser via localStorage keyed by the
 * newest alert's sentAt — a fresh cap-hit (different timestamp) will
 * surface the banner again even after a previous one was dismissed.
 */
export function SquareCatalogCapBanner() {
  const { data: userResponse } = useQuery<ApiResponse<User>>({
    queryKey: ['/api/user'],
    staleTime: 1000 * 60 * 5,
  });
  const isSystemAdmin = userResponse?.data?.role === 'system_admin';
  const userId = userResponse?.data?.id ?? null;

  const { data } = useQuery<ApiResponse<{ alerts: RecentCatalogCapAlert[] }>>({
    queryKey: ['/api/payments-provider/catalog/cap-alerts/recent'],
    enabled: isSystemAdmin,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });

  const alerts = data?.data?.alerts ?? [];
  const newest = alerts[0] ?? null;

  if (!isSystemAdmin || !newest || !userId) return null;

  // Remount the body whenever the newest alert OR the signed-in user
  // changes so its dismissal state re-reads from storage on a fresh
  // mount (re-surfaces a fresh cap-hit, and never inherits another
  // admin's dismissal on a shared browser).
  return (
    <SquareCatalogCapBannerBody
      key={`${userId}:${newest.sentAt}`}
      userId={userId}
      newest={newest}
      alerts={alerts}
    />
  );
}

function SquareCatalogCapBannerBody({
  userId,
  newest,
  alerts,
}: {
  userId: number;
  newest: RecentCatalogCapAlert;
  alerts: RecentCatalogCapAlert[];
}) {
  // Initialise dismissal from storage once per mount (parent key forces
  // a fresh mount when the alert or user changes).
  const [dismissed, setDismissed] = useState(() => readDismissed(userId) === newest.sentAt);
  if (dismissed) return null;

  const orgsAffected = new Set(alerts.map((a) => a.organizationId ?? `loc:${a.locationId}`)).size;
  const orgLabel =
    newest.organizationId !== null ? `org #${newest.organizationId}` : `location #${newest.locationId}`;

  return (
    <div
      className="rounded-md border border-amber-500/50 bg-amber-50 p-4 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200 flex items-start gap-3"
      data-testid="banner-square-catalog-cap-alert"
      role="alert"
    >
      <AlertTriangle className="size-5 mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="font-medium">
          Square catalog hit pagination cap: {alerts.length} alert{alerts.length === 1 ? '' : 's'} across{' '}
          {orgsAffected} {orgsAffected === 1 ? 'organization' : 'organizations'}.
        </p>
        <p className="text-xs mt-1 opacity-90">
          Most recent: {orgLabel}, location #{newest.locationId} ({newest.reason.replace('_', ' ')}){' '}
          {formatTimeAgo(newest.sentAt)}. Their admin saw a truncated catalog;
          reach out to prune the catalog or scope by category.
        </p>
      </div>
      <button
        type="button"
        onClick={() => {
          writeDismissed(userId, newest.sentAt);
          setDismissed(true);
        }}
        className="text-amber-700 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100"
        aria-label="Dismiss Square catalog cap alert banner"
        data-testid="button-dismiss-square-catalog-cap-alert"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
