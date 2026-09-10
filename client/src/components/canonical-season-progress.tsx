import { useQuery } from "@tanstack/react-query";
import { fromZonedTime } from "date-fns-tz";
import { apiRequest } from "@/lib/queryClient";
import {
  LEAGUE_OCCURRENCE_SCHEDULE_CONTRACT_VERSION,
  type LeagueOccurrenceScheduleReadContract,
  type LeagueOccurrenceScheduleOccurrence,
} from "@shared/league-occurrence-schedule";

function sessionCompletionCutoff(row: LeagueOccurrenceScheduleOccurrence): number | null {
  if (!Number.isFinite(Date.parse(row.startAt))) return null;
  if (typeof row.authoritativeLocalDate !== "string" || typeof row.timezone !== "string" || row.timezone.trim() === "") return null;
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(row.authoritativeLocalDate);
  if (!dateMatch || Number(dateMatch[1]) < 1) return null;
  const localDateAtUtc = new Date(`${row.authoritativeLocalDate}T00:00:00Z`);
  if (!Number.isFinite(localDateAtUtc.getTime())
    || localDateAtUtc.toISOString().slice(0, 10) !== row.authoritativeLocalDate) return null;
  try {
    const cutoffAt = fromZonedTime(`${row.authoritativeLocalDate}T23:00:00`, row.timezone).getTime();
    return Number.isFinite(cutoffAt) ? cutoffAt : null;
  } catch {
    return null;
  }
}

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
  const completionCutoffs = sessions.map(sessionCompletionCutoff);
  if (!completionCutoffs.every((cutoff): cutoff is number => cutoff !== null)) {
    return <span>Schedule unavailable</span>;
  }
  // Subscribe to refresh timestamps even when the schedule rows are unchanged.
  const now = Math.max(Date.now(), dataUpdatedAt);
  const completed = completionCutoffs.filter((cutoff) => cutoff <= now).length;
  return <span>{completed} of {sessions.length} weeks completed</span>;
}
