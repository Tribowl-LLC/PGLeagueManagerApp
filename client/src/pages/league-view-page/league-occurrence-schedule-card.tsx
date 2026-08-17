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
import { FallCanonicalRecoveryPanel } from "./fall-draft-generation-card";
import { FallDraftReviewPanel } from "./fall-draft-review-panel";

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

function formatLocalDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatLocalTime(value: string | null): string {
  if (!value) return "Start time not configured";
  const match = /^([01]\d|2[0-3]):([0-5]\d)/.exec(value);
  if (!match) return value;
  const hour = Number(match[1]);
  return `${hour % 12 || 12}:${match[2]} ${hour < 12 ? "AM" : "PM"}`;
}

function formatOffset(value: number): string {
  const sign = value >= 0 ? "+" : "−";
  const absolute = Math.abs(value);
  return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
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

function ScheduleOccurrenceRow({ occurrence, isAdministrator }: {
  occurrence: LeagueOccurrenceScheduleOccurrence;
  isAdministrator: boolean;
}) {
  return (
    <li className="grid gap-3 px-4 py-4 md:grid-cols-[minmax(190px,1.25fr)_minmax(170px,1fr)_minmax(220px,1.25fr)]">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className={`font-medium ${occurrence.status === "cancelled" ? "text-muted-foreground line-through" : ""}`}>
            {formatLocalDate(occurrence.authoritativeLocalDate)}
          </h3>
          {statusBadge(occurrence.status)}
          {occurrence.kind !== "regular" && <Badge variant="secondary">{occurrenceLabel(occurrence)}</Badge>}
        </div>
        <p className="mt-1 text-sm">
          {formatLocalTime(occurrence.authoritativeLocalStartTime)} <span className="text-muted-foreground">({occurrence.timezone})</span>
        </p>
        {occurrence.relationships.map((relationship) => (
          <p key={relationship.relationshipId} className="mt-1 text-xs text-muted-foreground">
            {relationship.kind === "makeup_for"
              ? relationship.role === "source" ? "Makes up a cancelled session" : "Has an active makeup session"
              : relationship.kind}
          </p>
        ))}
      </div>

      <dl className="grid grid-cols-3 gap-2 text-sm">
        <div><dt className="text-xs text-muted-foreground">Planned</dt><dd>{occurrence.plannedOrdinal ?? "—"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Competition</dt><dd>{occurrence.competitionNumber ?? "—"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Billing</dt><dd>{occurrence.billing?.billingOrdinal ?? "—"}</dd></div>
      </dl>

      <div className="text-xs text-muted-foreground">
        {occurrence.occurrenceId ? (
          <p className="break-all"><span className="font-medium text-foreground">Occurrence UUID:</span> <span className="font-mono">{occurrence.occurrenceId}</span></p>
        ) : (
          <p>No canonical occurrence identity is assigned in legacy fallback.</p>
        )}
        {isAdministrator && occurrence.occurrenceId && (
          <div className="mt-1 space-y-1">
            <p>{occurrence.lifecycle} lifecycle · revision {occurrence.currentRevision}</p>
            <p>{occurrence.effectivelyLocked ? "Effectively locked" : "Not effectively locked"}</p>
            {occurrence.selectedUtcOffsetMinutes !== null && (
              <p>{formatOffset(occurrence.selectedUtcOffsetMinutes)} · fold {occurrence.foldResolution} · {occurrence.resolverVersion}</p>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

function SkippedDateRow({ skippedDate, isAdministrator }: {
  skippedDate: LeagueOccurrenceScheduleSkippedDate;
  isAdministrator: boolean;
}) {
  return (
    <li className="grid gap-3 bg-muted/30 px-4 py-4 md:grid-cols-[minmax(190px,1.25fr)_minmax(170px,1fr)_minmax(220px,1.25fr)]">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-medium text-muted-foreground line-through">{formatLocalDate(skippedDate.localDate)}</h3>
          <Badge variant="secondary">Skipped</Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">No physical occurrence · {skippedDate.timezone}</p>
      </div>
      <p className="text-sm">{skippedDate.reason}</p>
      <div className="text-xs text-muted-foreground">
        <p>{skippedDate.durableCanonicalException ? "Published canonical exception" : "Legacy skip-date fallback"}</p>
        {isAdministrator && skippedDate.exceptionId && (
          <p className="mt-1 break-all font-mono">{skippedDate.exceptionId} · revision {skippedDate.currentRevision}</p>
        )}
      </div>
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
      stableKey: occurrence.occurrenceId ?? occurrence.legacyProjectionKey ?? "",
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
  const fallAdminPath = `/api/leagues/${leagueId}/canonical-fall-drafts`;
  const canonicalAdminPath = `/api/leagues/${leagueId}/canonical-drafts`;

  return (
    <Card data-testid="league-occurrence-schedule-card">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle as="h2" className="flex items-center gap-2"><CalendarDays className="size-5" />Season schedule</CardTitle>
            <CardDescription>Physical sessions in league-local calendar time. Planned, competition, and billing numbers remain distinct.</CardDescription>
          </div>
          {schedule && (
            <Badge variant={schedule.authoritativeSource === "canonical" ? "default" : "secondary"}>
              {schedule.authoritativeSource === "canonical" ? "Canonical schedule" : "Legacy fallback"}
            </Badge>
          )}
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
              The server could not provide a safe schedule projection. Canonical incompatibilities never fall back to legacy dates.
              <Button variant="outline" size="sm" className="mt-3 block" onClick={() => scheduleQuery.refetch()}>
                <RefreshCw className="mr-2 size-4" />Retry
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {schedule?.authoritativeSource === "legacy_fallback" && (
          <Alert>
            <AlertCircle className="size-4" />
            <AlertTitle>Legacy schedule fallback</AlertTitle>
            <AlertDescription>
              No operational published or locked canonical set exists. These dates remain usable, but they do not have durable occurrence UUIDs.
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
              ? <ScheduleOccurrenceRow key={row.stableKey} occurrence={row.occurrence} isAdministrator={isAdministrator} />
              : <SkippedDateRow key={row.stableKey} skippedDate={row.skippedDate} isAdministrator={isAdministrator} />)}
          </ol>
        )}

        {schedule?.administrator && (
          <section className="space-y-4 border-t pt-5" aria-labelledby="schedule-administration-heading">
            <div>
              <h3 id="schedule-administration-heading" className="text-lg font-semibold">Schedule administration</h3>
              <p className="text-sm text-muted-foreground">
                Canonical lifecycle evidence is read-only here; C2 controls continue to use their audited confirmations.
              </p>
            </div>
            {(schedule.administrator.hasDraftEvidence
              || schedule.administrator.hasRejectedEvidence
              || schedule.administrator.hasSupersededEvidence
              || schedule.administrator.hasRevokedEvidence) && (
              <div className="flex flex-wrap gap-2" aria-label="Canonical administrator evidence">
                {schedule.administrator.hasDraftEvidence && <Badge variant="outline">Draft evidence</Badge>}
                {schedule.administrator.hasRejectedEvidence && <Badge variant="destructive">Rejected evidence</Badge>}
                {schedule.administrator.hasSupersededEvidence && <Badge variant="secondary">Superseded evidence</Badge>}
                {schedule.administrator.hasRevokedEvidence && <Badge variant="secondary">Revoked evidence</Badge>}
              </div>
            )}
            {schedule.administrator.fallRecoveryEligible && (
              <FallCanonicalRecoveryPanel leagueId={leagueId} organizationId={organizationId} isSystemAdmin={isSystemAdmin} />
            )}
            {schedule.administrator.c2ReviewAvailable && (
              <FallDraftReviewPanel
                basePath={schedule.administrator.reviewContractFamily === "canonical" ? canonicalAdminPath : fallAdminPath}
                querySuffix={querySuffix}
                enabled
                contractFamily={schedule.administrator.reviewContractFamily ?? "fall"}
                scheduleQueryKey={["league-occurrence-schedule", endpoint]}
              />
            )}
          </section>
        )}
      </CardContent>
    </Card>
  );
}
