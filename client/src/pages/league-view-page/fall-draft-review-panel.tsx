import { useState } from "react";
import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest } from "@/lib/queryClient";
import type { ApiResponse } from "@shared/schema";
import type { FallDraftReviewOccurrence } from "@shared/fall-draft-review";
import type { CanonicalDraftMutationResult, CanonicalDraftReview } from "@shared/canonical-draft-review";
import { secureFallDraftIdempotencyKey } from "./fall-draft-secure-id";

interface FallDraftReviewPanelProps {
  basePath: string;
  querySuffix: string;
  enabled: boolean;
  scheduleQueryKey: QueryKey;
}

type EntityAction = "reschedule" | "cancel" | "restore";

interface EntityActionState {
  action: EntityAction;
  occurrence: FallDraftReviewOccurrence;
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

function formatLocalTime(value: string): string {
  const match = /^([01]\d|2[0-3]):([0-5]\d)/.exec(value);
  if (!match) return value;
  const hour = Number(match[1]);
  return `${hour % 12 || 12}:${match[2]} ${hour < 12 ? "AM" : "PM"}`;
}

function actionTitle(action: EntityAction | undefined): string {
  if (action === "reschedule") return "Reschedule league night";
  if (action === "cancel") return "Cancel league night";
  return "Restore league night";
}

function statusBadge(occurrence: FallDraftReviewOccurrence) {
  if (occurrence.status === "cancelled") return <Badge variant="destructive">Cancelled</Badge>;
  if (occurrence.status === "completed") return <Badge variant="secondary">Completed</Badge>;
  if (occurrence.status === "scheduled") return <Badge variant="outline">Scheduled</Badge>;
  return <Badge variant="secondary">Unavailable</Badge>;
}

export function FallDraftReviewPanel({
  basePath,
  querySuffix,
  enabled,
  scheduleQueryKey,
}: FallDraftReviewPanelProps) {
  const queryClient = useQueryClient();
  const requestVersions = {
    reschedule: "canonical-draft-reschedule-request/1",
    cancel: "canonical-draft-cancel-request/1",
    restore: "canonical-draft-restore-request/1",
  } as const;
  const reviewPath = `${basePath}/review${querySuffix}`;
  const queryKey = [reviewPath];
  const [entityAction, setEntityAction] = useState<EntityActionState | null>(null);
  const [entityReason, setEntityReason] = useState("");
  const [localDate, setLocalDate] = useState("");
  const [localTime, setLocalTime] = useState("");
  const [timezone, setTimezone] = useState("");
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const reviewQuery = useQuery<ApiResponse<CanonicalDraftReview>>({
    queryKey,
    queryFn: async () => apiRequest<CanonicalDraftReview>(reviewPath, "GET"),
    enabled,
    retry: false,
  });
  const review = reviewQuery.data?.data;

  const mutation = useMutation({
    mutationFn: async ({ endpoint, body }: { endpoint: string; body: unknown }) =>
      apiRequest<CanonicalDraftMutationResult>(`${basePath}/review/${endpoint}${querySuffix}`, "POST", body),
    onSuccess: async (response) => {
      queryClient.setQueryData(queryKey, { success: true, data: response.data.review });
      await queryClient.invalidateQueries({ queryKey: scheduleQueryKey, exact: true, refetchType: "active" });
      setEntityAction(null);
      setEntityReason("");
      setSuccess(response.data.mode === "idempotent_retry" ? "The previous schedule change was confirmed." : "Schedule updated.");
      setIdentityError(null);
    },
    onError: () => {
      setSuccess(null);
      void queryClient.invalidateQueries({ queryKey, exact: true });
    },
  });

  const freshKey = (): string | null => {
    try {
      setIdentityError(null);
      return secureFallDraftIdempotencyKey();
    } catch (caught) {
      setIdentityError(caught instanceof Error ? caught.message : "Secure confirmation is unavailable");
      return null;
    }
  };

  const beginEntityAction = (action: EntityAction, occurrence: FallDraftReviewOccurrence) => {
    setEntityAction({ action, occurrence });
    setEntityReason("");
    setLocalDate(occurrence.authoritativeLocalDate);
    setLocalTime(occurrence.authoritativeLocalStartTime);
    setTimezone(occurrence.timezone);
    setSuccess(null);
  };

  const submitEntityAction = () => {
    if (!review || !entityAction || entityReason.length === 0 || entityReason.trim() !== entityReason) return;
    const idempotencyKey = freshKey();
    if (!idempotencyKey) return;
    const common = {
      confirmedReviewFingerprint: review.reviewFingerprint,
      reason: entityReason,
      idempotencyKey,
      occurrenceId: entityAction.occurrence.id,
      expectedOccurrenceRevision: entityAction.occurrence.currentRevision,
    };
    if (entityAction.action === "reschedule") {
      mutation.mutate({
        endpoint: "reschedule",
        body: {
          contractVersion: requestVersions.reschedule,
          ...common,
          authoritativeLocalDate: localDate,
          authoritativeLocalStartTime: localTime,
          timezone,
        },
      });
      return;
    }
    mutation.mutate({
      endpoint: entityAction.action,
      body: {
        contractVersion: entityAction.action === "cancel" ? requestVersions.cancel : requestVersions.restore,
        ...common,
      },
    });
  };

  if (!enabled) return null;
  if (reviewQuery.isLoading) {
    return <p className="text-sm" aria-live="polite"><Loader2 className="mr-2 inline size-4 animate-spin" />Loading schedule controls…</p>;
  }
  if (reviewQuery.isError || !review) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="size-4" />
        <AlertTitle>Could not load schedule controls</AlertTitle>
        <AlertDescription>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => reviewQuery.refetch()}>Retry</Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <section className="space-y-4" aria-labelledby="edit-schedule-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 id="edit-schedule-heading" className="text-lg font-semibold">Edit Schedule</h3>
          <p className="text-sm text-muted-foreground">Reschedule or cancel a league night when plans change.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => reviewQuery.refetch()}>
          <RefreshCw className="mr-2 size-4" />Refresh
        </Button>
      </div>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full min-w-[680px] text-left text-sm">
          <caption className="sr-only">League nights and schedule editing controls</caption>
          <thead className="bg-muted/50">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">Date</th>
              <th scope="col" className="px-3 py-2 font-medium">Time</th>
              <th scope="col" className="px-3 py-2 font-medium">Status</th>
              <th scope="col" className="px-3 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {review.occurrences.map((occurrence) => {
              const editable = occurrence.status === "scheduled"
                && ["draft", "published"].includes(occurrence.lifecycle)
                && !occurrence.effectivelyLocked;
              const restorable = review.generationRun.state === "generated"
                && occurrence.lifecycle === "draft"
                && occurrence.status === "cancelled"
                && !occurrence.effectivelyLocked;
              return (
                <tr key={occurrence.id}>
                  <td className="px-3 py-3 font-medium">{formatLocalDate(occurrence.authoritativeLocalDate)}</td>
                  <td className="px-3 py-3">{formatLocalTime(occurrence.authoritativeLocalStartTime)}</td>
                  <td className="px-3 py-3">{statusBadge(occurrence)}</td>
                  <td className="px-3 py-3">
                    <div className="flex flex-wrap gap-2">
                      {occurrence.status === "scheduled" && (
                        <>
                          <Button size="sm" variant="outline" disabled={!editable || mutation.isPending} onClick={() => beginEntityAction("reschedule", occurrence)}>Reschedule</Button>
                          <Button size="sm" variant="destructive" disabled={!editable || mutation.isPending} onClick={() => beginEntityAction("cancel", occurrence)}>Cancel</Button>
                        </>
                      )}
                      {occurrence.status === "cancelled" && restorable && (
                        <Button size="sm" variant="outline" disabled={mutation.isPending} onClick={() => beginEntityAction("restore", occurrence)}>Restore</Button>
                      )}
                      {!editable && !restorable && occurrence.status !== "scheduled" && (
                        <span className="text-xs text-muted-foreground">No changes available</span>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {identityError && <Alert variant="destructive"><AlertCircle className="size-4" /><AlertTitle>Secure confirmation unavailable</AlertTitle><AlertDescription>{identityError}</AlertDescription></Alert>}
      {mutation.isError && <Alert variant="destructive"><AlertCircle className="size-4" /><AlertTitle>Schedule change rejected</AlertTitle><AlertDescription>The schedule change could not be saved. The latest schedule has been reloaded.</AlertDescription></Alert>}
      {success && <Alert><CheckCircle2 className="size-4" /><AlertTitle>{success}</AlertTitle></Alert>}

      <Dialog open={entityAction !== null} onOpenChange={(open) => { if (!open && !mutation.isPending) setEntityAction(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{actionTitle(entityAction?.action)}</DialogTitle>
            <DialogDescription>
              {entityAction ? `${formatLocalDate(entityAction.occurrence.authoritativeLocalDate)} at ${formatLocalTime(entityAction.occurrence.authoritativeLocalStartTime)}` : "Update this league night."}
            </DialogDescription>
          </DialogHeader>
          {entityAction?.action === "reschedule" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div><Label htmlFor="schedule-local-date">New date</Label><Input id="schedule-local-date" type="date" value={localDate} onChange={(event) => setLocalDate(event.target.value)} /></div>
              <div><Label htmlFor="schedule-local-time">New start time</Label><Input id="schedule-local-time" type="time" step="1" value={localTime} onChange={(event) => setLocalTime(event.target.value)} /></div>
            </div>
          )}
          <div>
            <Label htmlFor="schedule-change-reason">Reason for change</Label>
            <Textarea id="schedule-change-reason" value={entityReason} onChange={(event) => setEntityReason(event.target.value)} placeholder="For example: weather cancellation" />
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={mutation.isPending} onClick={() => setEntityAction(null)}>Go back</Button>
            <Button
              variant={entityAction?.action === "cancel" ? "destructive" : "default"}
              disabled={mutation.isPending || entityReason.length === 0 || entityReason.trim() !== entityReason || (entityAction?.action === "reschedule" && (!localDate || !localTime || !timezone))}
              onClick={submitEntityAction}
            >
              {mutation.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
              {entityAction?.action === "cancel" ? "Cancel league night" : entityAction?.action === "restore" ? "Restore league night" : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
