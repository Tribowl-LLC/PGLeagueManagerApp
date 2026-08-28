import { useQuery } from "@tanstack/react-query";
import { AlertCircle, CalendarDays, Loader2, RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { apiRequest } from "@/lib/queryClient";
import type { ApiResponse, User } from "@shared/schema";
import type {
  LeagueOccurrenceScheduleOccurrence,
  LeagueOccurrenceScheduleReadContract,
  LeagueOccurrenceScheduleSkippedDate,
} from "@shared/league-occurrence-schedule";
import { FallDraftReviewPanel } from "./fall-draft-review-panel";
import { formatScheduleLocalDate, formatScheduleLocalTime } from "./schedule-display";

interface LeagueOccurrenceScheduleCardProps {
  leagueId: number;
  organizationId: number;
  viewerRole: User["role"] | undefined;
}

type ScheduleDisplayRow =
  | { type: "occurrence"; date: string; time: string | null; stableKey: string; occurrence: LeagueOccurrenceScheduleOccurrence }
  | { type: "skip"; date: string; time: null; stableKey: string; skippedDate: LeagueOccurrenceScheduleSkippedDate };

function compareRows(left: ScheduleDisplayRow, right: ScheduleDisplayRow): number {
  if (left.date !== right.date) return left.date < right.date ? -1 : 1;
  if ((left.time ?? "") !== (right.time ?? "")) return (left.time ?? "") < (right.time ?? "") ? -1 : 1;
  return left.stableKey < right.stableKey ? -1 : left.stableKey > right.stableKey ? 1 : 0;
}

function occurrenceLabel(occurrence: LeagueOccurrenceScheduleOccurrence): string {
  if (occurrence.kind === "makeup") return "Makeup session";
  if (occurrence.kind === "regular") return "League session";
  return `${occurrence.kind.replaceAll("_", " ")} session`;
}

function statusBadge(status: LeagueOccurrenceScheduleOccurrence["status"]) {
  if (status === "cancelled") return <Badge variant="destructive">Cancelled</Badge>;
  if (status === "completed") return <Badge variant="secondary">Completed</Badge>;
  return <Badge variant="outline">Scheduled</Badge>;
}

function ScheduleOccurrenceRow({ occurrence }: { occurrence: LeagueOccurrenceScheduleOccurrence }) {
  const activeCollectionGroups = (occurrence.collectionGroups ?? []).filter((group) => group.state !== "revoked");
  return (
    <li className="flex flex-col justify-between gap-3 px-4 py-4 sm:flex-row sm:items-start">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className={`font-medium ${occurrence.status === "cancelled" ? "text-muted-foreground line-through" : ""}`}>
            {formatScheduleLocalDate(occurrence.authoritativeLocalDate)}
          </h3>
          {statusBadge(occurrence.status)}
          {occurrence.kind !== "regular" && <Badge variant="secondary">{occurrenceLabel(occurrence)}</Badge>}
          {activeCollectionGroups.map((group) => (
            <Badge key={group.groupId} variant="default">
              {group.role === "trigger" ? "Double-pay week" : "Paired double-pay week"}
            </Badge>
          ))}
        </div>
        <p className="mt-1 text-sm">
          {formatScheduleLocalTime(occurrence.authoritativeLocalStartTime)}
        </p>
        {occurrence.relationships.map((relationship) => (
          <p key={relationship.relationshipId} className="mt-1 text-xs text-muted-foreground">
            {relationship.kind === "makeup_for"
              ? relationship.role === "source" ? "Makes up a cancelled session" : "Has an active makeup session"
              : relationship.kind}
          </p>
        ))}
      </div>
      {(occurrence.competitionNumber ?? occurrence.plannedOrdinal) != null && (
        <p className="shrink-0 text-sm font-medium text-muted-foreground">
          Week {occurrence.competitionNumber ?? occurrence.plannedOrdinal}
        </p>
      )}
    </li>
  );
}

function SkippedDateRow({ skippedDate }: { skippedDate: LeagueOccurrenceScheduleSkippedDate }) {
  return (
    <li className="flex flex-col justify-between gap-3 bg-muted/30 px-4 py-4 sm:flex-row sm:items-start">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-medium text-muted-foreground line-through">{formatScheduleLocalDate(skippedDate.localDate)}</h3>
          <Badge variant="secondary">Skipped</Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">No league session</p>
      </div>
      <p className="text-sm text-muted-foreground">{skippedDate.reason}</p>
    </li>
  );
}

export function LeagueOccurrenceScheduleCard({
  leagueId,
  organizationId,
  viewerRole,
}: LeagueOccurrenceScheduleCardProps) {
  const isSystemAdmin = viewerRole === "system_admin";
  const isAdministrator = viewerRole === "org_admin" || isSystemAdmin;
  const querySuffix = isSystemAdmin ? `?organizationId=${organizationId}` : "";
  const endpoint = `/api/leagues/${leagueId}/occurrence-schedule${querySuffix}`;
  const scheduleQuery = useQuery<ApiResponse<LeagueOccurrenceScheduleReadContract>>({
    queryKey: ["league-occurrence-schedule", endpoint],
    queryFn: () => apiRequest<LeagueOccurrenceScheduleReadContract>(endpoint, "GET"),
    enabled: viewerRole !== undefined,
    retry: false,
  });
  const schedule = scheduleQuery.data?.data;
  const rows: ScheduleDisplayRow[] = schedule ? [
    ...schedule.occurrences.map((occurrence): ScheduleDisplayRow => ({
      type: "occurrence",
      date: occurrence.authoritativeLocalDate,
      time: occurrence.authoritativeLocalStartTime,
      stableKey: occurrence.occurrenceId,
      occurrence,
    })),
    ...schedule.skippedDates.map((skippedDate): ScheduleDisplayRow => ({
      type: "skip",
      date: skippedDate.localDate,
      time: null,
      stableKey: skippedDate.exceptionId ?? `skip:${skippedDate.localDate}`,
      skippedDate,
    })),
  ].sort(compareRows) : [];
  const canonicalAdminPath = `/api/leagues/${leagueId}/canonical-drafts`;

  return (
    <Card data-testid="league-occurrence-schedule-card">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle as="h2" className="flex items-center gap-2"><CalendarDays className="size-5" />Season Schedule</CardTitle>
            <CardDescription>League dates and start times. Skipped and cancelled dates remain visible.</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="mt-5 space-y-5">
        {scheduleQuery.isLoading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
            <Loader2 className="size-4 animate-spin" /> Loading season schedule…
          </p>
        )}

        {scheduleQuery.isError && (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertTitle>Season schedule is unavailable</AlertTitle>
            <AlertDescription>
              The schedule could not be loaded safely. Try again, or contact an administrator if the problem continues.
              <Button variant="outline" size="sm" className="mt-3 block" onClick={() => scheduleQuery.refetch()}>
                <RefreshCw className="mr-2 size-4" />Retry
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {schedule && rows.length === 0 && (
          <div className="rounded-md border border-dashed p-5 text-sm text-muted-foreground" role="status">
            No physical sessions or skipped dates are available for this season.
          </div>
        )}

        {rows.length > 0 && (
          <ol className="divide-y rounded-md border" aria-label="Chronological season schedule">
            {rows.map((row) => row.type === "occurrence"
              ? <ScheduleOccurrenceRow key={row.stableKey} occurrence={row.occurrence} />
              : <SkippedDateRow key={row.stableKey} skippedDate={row.skippedDate} />)}
          </ol>
        )}

        {schedule?.administrator && isAdministrator && (
          <section className="space-y-4 border-t pt-5">
            {schedule.administrator.c2ReviewAvailable && schedule.administrator.reviewContractFamily === "canonical" && (
              <FallDraftReviewPanel
                basePath={canonicalAdminPath}
                querySuffix={querySuffix}
                enabled
                scheduleQueryKey={["league-occurrence-schedule", endpoint]}
              />
            )}
          </section>
        )}
      </CardContent>
    </Card>
  );
}
