import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  LEAGUE_OCCURRENCE_SCHEDULE_CONTRACT_VERSION,
  type LeagueOccurrenceScheduleReadContract,
} from "@shared/league-occurrence-schedule";

export function CanonicalSeasonProgress({ leagueId, organizationId, viewerRole, allowRetry = true }: {
  leagueId: number;
  organizationId: number | null;
  viewerRole: string;
  allowRetry?: boolean;
}) {
  const scoped = viewerRole !== "system_admin" || organizationId !== null;
  const suffix = viewerRole === "system_admin" ? `?organizationId=${organizationId}` : "";
  const endpoint = `/api/leagues/${leagueId}/occurrence-schedule${suffix}`;
  const { data, dataUpdatedAt, isPending, isError, refetch } = useQuery({
    queryKey: ["league-occurrence-schedule", endpoint],
    queryFn: () => apiRequest<LeagueOccurrenceScheduleReadContract>(endpoint, "GET"),
    enabled: scoped,
    retry: false,
    refetchInterval: 60_000,
  });
  if (!scoped) return <span>Schedule unavailable</span>;
  if (isError) return <span>Schedule unavailable{allowRetry && <> <button type="button" onClick={() => void refetch()}>Retry</button></>}</span>;
  if (isPending) return <span>Loading schedule…</span>;
  const schedule = data?.data;
  if (!schedule || schedule.contractVersion !== LEAGUE_OCCURRENCE_SCHEDULE_CONTRACT_VERSION
    || schedule.authoritativeSource !== "canonical") return <span>Schedule unavailable</span>;
  // Count physical sessions, not billing ordinals or calendar weeks. Double-pay
  // groups never add sessions; cancelled sessions do not contribute to progress.
  const sessions = schedule.occurrences.filter((row) => row.status !== "cancelled");
  if (sessions.some((row) => !Number.isFinite(Date.parse(row.startAt)))) return <span>Schedule unavailable</span>;
  // Subscribe to refresh timestamps even when the schedule rows are unchanged.
  const now = Math.max(Date.now(), dataUpdatedAt);
  const started = sessions.filter((row) => Date.parse(row.startAt) <= now).length;
  return <span>{started} of {sessions.length} sessions started</span>;
}
