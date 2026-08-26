import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, X } from 'lucide-react';
import type { ApiResponse, League, User } from '@shared/schema';

interface RecentLeagueSquareMissingAlert {
  sentAt: string;
  leagueId: number;
  leagueName: string;
  organizationId: number | null;
  missing: Array<{
    kind: 'lineage' | 'prizeFund';
    itemName: string | null;
    variationId: string;
  }>;
}

// Per-admin dismissal keyed by user id (shared-browser safety) and
// the newest alert's sentAt — a fresh audit run produces a new
// timestamp and re-surfaces the banner even after a previous
// dismissal. Same convention as the apple-pay / cap-alert banners
// (#272, #644).
function dismissKey(userId: number): string {
  return `league-square-missing-alert-dismissed-at:user:${userId}`;
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
    /* best effort */
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

interface LeagueSquareMissingBannerProps {
  leagues: League[];
  onEditLeague: (league: League) => void;
}

/**
 * Banner shown above the leagues list when the daily Square-catalog
 * audit (#654) flagged a saved Lineage / Prize Fund variation id as
 * missing from the live catalog (#657). Pairs the email alert with
 * an in-app indicator so admins who don't open the email still see
 * something on the Leagues page where they can fix it.
 *
 * The list is auto-cleared server-side once the league is re-pointed
 * at a live variation id (the saved id no longer matches what was
 * reported missing), so the banner naturally goes away once the
 * admin acts on it.
 */
export function LeagueSquareMissingBanner({ leagues, onEditLeague }: LeagueSquareMissingBannerProps) {
  const { data: userResponse } = useQuery<ApiResponse<User>>({
    queryKey: ['/api/user'],
    staleTime: 1000 * 60 * 5,
  });
  const role = userResponse?.data?.role;
  const userId = userResponse?.data?.id ?? null;
  const isAdmin = role === 'system_admin' || role === 'org_admin';

  const { data } = useQuery<ApiResponse<{ alerts: RecentLeagueSquareMissingAlert[] }>>({
    queryKey: ['/api/leagues/square-missing-alerts/recent'],
    enabled: isAdmin,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });

  const alerts = data?.data?.alerts ?? [];
  // Dedup defensively in case two events for the same league fall
  // inside the window after a throttle reset; keep the newest.
  const byLeague = new Map<number, RecentLeagueSquareMissingAlert>();
  for (const a of alerts) {
    const existing = byLeague.get(a.leagueId);
    if (!existing || new Date(a.sentAt) > new Date(existing.sentAt)) {
      byLeague.set(a.leagueId, a);
    }
  }
  const visibleAlerts = Array.from(byLeague.values()).sort(
    (a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime(),
  ).filter((alert) => {
    const league = leagues.find((candidate) => candidate.id === alert.leagueId);
    return league?.active === true && league.scheduleAuthority === "canonical";
  });
  const newest = visibleAlerts[0] ?? null;

  if (!isAdmin || !userId || visibleAlerts.length === 0 || !newest) return null;

  // Remount the body whenever the newest alert OR the signed-in user
  // changes so its dismissal state re-reads from storage on a fresh
  // mount (re-surfaces a fresh audit run, and never inherits another
  // admin's dismissal on a shared browser).
  return (
    <LeagueSquareMissingBannerBody
      key={`${userId}:${newest.sentAt}`}
      userId={userId}
      newest={newest}
      visibleAlerts={visibleAlerts}
      leagues={leagues}
      onEditLeague={onEditLeague}
    />
  );
}

function LeagueSquareMissingBannerBody({
  userId,
  newest,
  visibleAlerts,
  leagues,
  onEditLeague,
}: {
  userId: number;
  newest: RecentLeagueSquareMissingAlert;
  visibleAlerts: RecentLeagueSquareMissingAlert[];
  leagues: League[];
  onEditLeague: (league: League) => void;
}) {
  // Initialise dismissal from storage once per mount (parent key forces
  // a fresh mount when the alert or user changes).
  const [dismissed, setDismissed] = useState(() => readDismissed(userId) === newest.sentAt);
  if (dismissed) return null;

  return (
    <div
      className="rounded-md border border-amber-500/50 bg-amber-50 p-4 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200 flex items-start gap-3 mb-4"
      data-testid="banner-league-square-missing-alert"
      role="alert"
    >
      <AlertTriangle className="size-5 mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="font-medium">
          {visibleAlerts.length === 1
            ? `1 league has a Square item that is no longer in your catalog.`
            : `${visibleAlerts.length} leagues have Square items that are no longer in your catalog.`}
        </p>
        <p className="text-xs mt-1 opacity-90">
          Most recent: {formatTimeAgo(newest.sentAt)}. Open each league below and re-pick a
          live Lineage or Prize Fund item before bowlers check out.
        </p>
        <ul className="mt-2 space-y-1">
          {visibleAlerts.map((alert) => {
            const league = leagues.find((l) => l.id === alert.leagueId);
            const missingLabels = alert.missing
              .map((m) => (m.kind === 'lineage' ? 'Lineage' : 'Prize Fund'))
              .join(' & ');
            return (
              <li key={alert.leagueId}>
                <button
                  type="button"
                  onClick={() => {
                    if (league?.active === true && league.scheduleAuthority === "canonical") {
                      onEditLeague(league);
                    }
                  }}
                  disabled={league?.active !== true || league.scheduleAuthority !== "canonical"}
                  className="text-left text-sm font-semibold underline underline-offset-2 hover:opacity-80 disabled:no-underline disabled:opacity-60 disabled:cursor-not-allowed"
                  data-testid={`button-fix-league-square-missing-${alert.leagueId}`}
                >
                  {alert.leagueName}
                </button>
                <span className="ml-2 text-xs opacity-90">
                  ({missingLabels} missing)
                </span>
              </li>
            );
          })}
        </ul>
      </div>
      <button
        type="button"
        onClick={() => {
          writeDismissed(userId, newest.sentAt);
          setDismissed(true);
        }}
        className="text-amber-700 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100"
        aria-label="Dismiss league Square-catalog missing alert banner"
        data-testid="button-dismiss-league-square-missing-alert"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
