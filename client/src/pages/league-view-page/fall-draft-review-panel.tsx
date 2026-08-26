import { useMemo, useState } from "react";
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

// Keep the browser bundle type-only with respect to the server-side SHA-256 contract module.
interface FallDraftReviewPanelProps {
  basePath: string;
  querySuffix: string;
  enabled: boolean;
  scheduleQueryKey: QueryKey;
}

type DraftReview = CanonicalDraftReview;
type DraftMutationResult = CanonicalDraftMutationResult;

type EntityAction = "reschedule" | "cancel" | "restore";

interface EntityActionState {
  action: EntityAction;
  occurrence: FallDraftReviewOccurrence;
}

function formatMoney(amountMinor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amountMinor / 100);
  } catch {
    return `${amountMinor} ${currency} minor units`;
  }
}

function stateBadge(review: DraftReview) {
  if (review.generationRun.state === "rejected") return <Badge variant="destructive">Rejected</Badge>;
  if (review.generationRun.state === "applied") return <Badge variant="outline">Published</Badge>;
  return <Badge variant="outline">Editable draft</Badge>;
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

  const reviewQuery = useQuery<ApiResponse<DraftReview>>({
    queryKey,
    queryFn: async () => apiRequest<DraftReview>(reviewPath, "GET"),
    enabled,
    retry: false,
  });
  const review = reviewQuery.data?.data;

  const mutation = useMutation({
    mutationFn: async ({ endpoint, body }: { endpoint: string; body: unknown }) =>
      apiRequest<DraftMutationResult>(`${basePath}/review/${endpoint}${querySuffix}`, "POST", body),
    onSuccess: async (response) => {
      queryClient.setQueryData(queryKey, { success: true, data: response.data.review });
      await queryClient.invalidateQueries({ queryKey: scheduleQueryKey, exact: true, refetchType: "active" });
      setEntityAction(null);
      setEntityReason("");
      setSuccess(response.data.mode === "idempotent_retry" ? "The original committed result was verified." : "The canonical schedule change was committed.");
      setIdentityError(null);
    },
    onError: () => {
      setSuccess(null);
      void queryClient.invalidateQueries({ queryKey, exact: true });
    },
  });

  const termByOccurrence = useMemo(
    () => new Map(review?.billingTerms.map((term) => [term.occurrenceId, term]) ?? []),
    [review],
  );

  const freshKey = (): string | null => {
    try {
      setIdentityError(null);
      return secureFallDraftIdempotencyKey();
    } catch (caught) {
      setIdentityError(caught instanceof Error ? caught.message : "Secure identifier generation is unavailable");
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
  if (reviewQuery.isLoading) return <p className="text-sm" aria-live="polite"><Loader2 className="mr-2 inline size-4 animate-spin" />Loading exact canonical schedule state…</p>;
  if (reviewQuery.isError || !review) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="size-4" />
        <AlertTitle>Could not load canonical schedule state</AlertTitle>
        <AlertDescription><Button variant="outline" size="sm" className="mt-2" onClick={() => reviewQuery.refetch()}>Retry</Button></AlertDescription>
      </Alert>
    );
  }

  return (
    <section className="space-y-5 border-t pt-5" aria-labelledby="canonical-schedule-administration-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 id="canonical-schedule-administration-heading" className="text-lg font-semibold">Canonical schedule administration</h3>
          <p className="text-sm text-muted-foreground">Exact persisted state; use these controls for necessary mid-season schedule changes.</p>
        </div>
        <div className="flex items-center gap-2">{stateBadge(review)}<Button variant="outline" size="sm" onClick={() => reviewQuery.refetch()}><RefreshCw className="mr-2 size-4" />Refresh</Button></div>
      </div>

      <div className="grid gap-2 text-xs sm:grid-cols-2">
        <p className="break-all"><span className="font-medium">Review fingerprint:</span> <span className="font-mono">{review.reviewFingerprint}</span></p>
        <p><span className="font-medium">Generation state:</span> {review.generationRun.state}; source revision {review.generationRun.sourceScheduleRevision}</p>
        <p className="break-all"><span className="font-medium">Generation input:</span> <span className="font-mono">{review.generation.inputFingerprint}</span></p>
        <p><span className="font-medium">League payment timing:</span> {review.generation.paymentMode === "upfront" ? "Full season upfront" : "Weekly"}</p>
        <p><span className="font-medium">Versions:</span> {review.reviewContractVersion}; {review.generation.generatorVersion}; {review.generation.dstResolverVersion}</p>
      </div>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full min-w-[1180px] text-left text-sm">
          <caption className="sr-only">Persisted canonical occurrences and mid-season schedule controls</caption>
          <thead className="bg-muted/50"><tr>{["UUID / revision", "Local / UTC / DST", "Lifecycle", "Numbers", "Billing policy / amount", "Exception evidence", "Actions"].map((heading) => <th key={heading} scope="col" className="px-3 py-2 font-medium">{heading}</th>)}</tr></thead>
          <tbody className="divide-y">
            {review.occurrences.map((occurrence) => {
              const term = termByOccurrence.get(occurrence.id);
              const exception = review.scheduleExceptions.find((row) => row.localDate === occurrence.authoritativeLocalDate && row.lifecycle !== "revoked");
              const editable = occurrence.status === "scheduled" && ["draft", "published"].includes(occurrence.lifecycle) && !occurrence.effectivelyLocked;
              const restorable = review.generationRun.state === "generated" && occurrence.lifecycle === "draft" && occurrence.status === "cancelled" && !occurrence.effectivelyLocked;
              return (
                <tr key={occurrence.id}>
                  <td className="max-w-52 break-all px-3 py-2 font-mono text-xs">{occurrence.id}<br />rev {occurrence.currentRevision}<br />key {occurrence.generationKey}</td>
                  <td className="px-3 py-2">{occurrence.authoritativeLocalDate} {occurrence.authoritativeLocalStartTime}<br />{occurrence.timezone}<br />{occurrence.startAt}<br />offset {occurrence.selectedUtcOffsetMinutes}; {occurrence.foldResolution}</td>
                  <td className="px-3 py-2">{occurrence.lifecycle} / {occurrence.status}<br />{occurrence.effectivelyLocked ? <Badge variant="destructive">Effectively locked</Badge> : <Badge variant="outline">Future</Badge>}</td>
                  <td className="px-3 py-2">planned {occurrence.plannedOrdinal ?? "—"}<br />competition {occurrence.competitionNumber ?? "—"}<br />billing {term?.billingOrdinal ?? "—"}<br />{occurrence.countsInStandings ? "standings" : "non-standings"}</td>
                  <td className="px-3 py-2">{term?.obligationPolicy ?? "—"}<br />{term ? formatMoney(term.defaultAmountMinor, term.currency) : "—"}<br />term rev {term?.currentRevision ?? "—"}</td>
                  <td className="px-3 py-2">{exception ? `${exception.kind}: ${exception.reason}` : "none"}</td>
                  <td className="px-3 py-2"><div className="flex flex-col gap-2">
                    <Button size="sm" variant="outline" disabled={!editable || mutation.isPending} onClick={() => beginEntityAction("reschedule", occurrence)}>Reschedule</Button>
                    <Button size="sm" variant="destructive" disabled={!editable || mutation.isPending} onClick={() => beginEntityAction("cancel", occurrence)}>Cancel occurrence</Button>
                    <Button size="sm" variant="outline" disabled={!restorable || mutation.isPending} onClick={() => beginEntityAction("restore", occurrence)}>Restore draft</Button>
                  </div></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {review.scheduleExceptions.length > 0 && <div><h4 className="font-medium">Schedule exceptions and revisions</h4><ul className="mt-1 list-disc pl-5 text-sm">{review.scheduleExceptions.map((row) => <li key={row.id}><span className="font-mono">{row.id}</span>: {row.localDate}, {row.kind}, {row.lifecycle}, revision {row.currentRevision} — {row.reason}</li>)}</ul></div>}

      {identityError && <Alert variant="destructive"><AlertCircle className="size-4" /><AlertTitle>Secure confirmation unavailable</AlertTitle><AlertDescription>{identityError}</AlertDescription></Alert>}
      {mutation.isError && <Alert variant="destructive"><AlertCircle className="size-4" /><AlertTitle>Schedule change rejected</AlertTitle><AlertDescription>{mutation.error instanceof Error ? mutation.error.message : "The server rejected this canonical schedule change."} The schedule is being refreshed before another confirmation.</AlertDescription></Alert>}
      {success && <Alert><CheckCircle2 className="size-4" /><AlertTitle>Audited state refreshed</AlertTitle><AlertDescription>{success}</AlertDescription></Alert>}

      <Dialog open={entityAction !== null} onOpenChange={(open) => { if (!open && !mutation.isPending) setEntityAction(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{entityAction?.action === "reschedule" ? "Reschedule occurrence" : entityAction?.action === "cancel" ? "Cancel occurrence" : "Restore cancelled draft"}</DialogTitle><DialogDescription>Confirm occurrence {entityAction?.occurrence.id} at expected revision {entityAction?.occurrence.currentRevision}. The current review fingerprint is sent with this request and stale state fails closed.</DialogDescription></DialogHeader>
          {entityAction?.action === "reschedule" && <div className="grid gap-3 sm:grid-cols-2"><div><Label htmlFor="fall-c2-local-date">Local date</Label><Input id="fall-c2-local-date" type="date" value={localDate} onChange={(event) => setLocalDate(event.target.value)} /></div><div><Label htmlFor="fall-c2-local-time">Local time</Label><Input id="fall-c2-local-time" type="time" step="1" value={localTime} onChange={(event) => setLocalTime(event.target.value)} /></div><div><Label htmlFor="fall-c2-timezone">IANA timezone</Label><Input id="fall-c2-timezone" value={timezone} onChange={(event) => setTimezone(event.target.value)} /></div></div>}
          <div><Label htmlFor="fall-c2-entity-reason">Reason</Label><Textarea id="fall-c2-entity-reason" value={entityReason} onChange={(event) => setEntityReason(event.target.value)} placeholder="Required trimmed audit reason" /></div>
          <DialogFooter><Button variant="outline" disabled={mutation.isPending} onClick={() => setEntityAction(null)}>Keep reviewing</Button><Button variant={entityAction?.action === "cancel" ? "destructive" : "default"} disabled={mutation.isPending || entityReason.length === 0 || entityReason.trim() !== entityReason || (entityAction?.action === "reschedule" && (!localDate || !localTime || !timezone))} onClick={submitEntityAction}>{mutation.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}Confirm {entityAction?.action}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
