import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { ApiResponse } from "@shared/schema";
import type {
  FallDraftApplyRequest,
  FallDraftApplyResult,
  FallDraftGeneratorSemantics,
  FallDraftPersistedView,
  FallDraftPreview,
} from "@shared/fall-draft-generation";
import { FallDraftReviewPanel } from "./fall-draft-review-panel";
import { secureFallDraftIdempotencyKey } from "./fall-draft-secure-id";

interface FallDraftGenerationCardProps {
  leagueId: number;
  organizationId: number;
  isSystemAdmin: boolean;
}

const previewRequestVersion = "fall-draft-preview-request/1" as const;
const applyRequestVersion = "fall-draft-apply-request/1" as const;

interface FallDraftFormSemantics {
  ambiguousFold: FallDraftGeneratorSemantics["ambiguousFold"];
  currency: string;
  regularSessionBillingPolicy: FallDraftGeneratorSemantics["regularSessionBillingPolicy"] | "";
  billingOrdinalPolicy: FallDraftGeneratorSemantics["billingOrdinalPolicy"] | "";
}

function formatMoney(amountMinor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amountMinor / 100);
  } catch {
    return `${amountMinor} ${currency} minor units`;
  }
}

function shortFingerprint(value: string): string {
  return `${value.slice(0, 12)}…${value.slice(-8)}`;
}

export function FallDraftGenerationCard({ leagueId, organizationId, isSystemAdmin }: FallDraftGenerationCardProps) {
  const [semantics, setSemantics] = useState<FallDraftFormSemantics>({
    ambiguousFold: "reject",
    currency: "",
    regularSessionBillingPolicy: "",
    billingOrdinalPolicy: "",
  });
  const [preview, setPreview] = useState<FallDraftPreview | null>(null);
  const [previewSemantics, setPreviewSemantics] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [lastApplyRequest, setLastApplyRequest] = useState<FallDraftApplyRequest | null>(null);
  const [applied, setApplied] = useState<FallDraftApplyResult | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const previewHeadingRef = useRef<HTMLHeadingElement>(null);
  const querySuffix = isSystemAdmin ? `?organizationId=${organizationId}` : "";
  const basePath = `/api/leagues/${leagueId}/canonical-fall-drafts`;

  const currentSemantics = useMemo(() => JSON.stringify(semantics), [semantics]);
  const selectedSemantics = useMemo<FallDraftGeneratorSemantics | null>(() => {
    if (!/^[A-Z]{3}$/.test(semantics.currency)
      || semantics.regularSessionBillingPolicy === ""
      || semantics.billingOrdinalPolicy === "") return null;
    return {
      ambiguousFold: semantics.ambiguousFold,
      currency: semantics.currency,
      regularSessionBillingPolicy: semantics.regularSessionBillingPolicy,
      billingOrdinalPolicy: semantics.billingOrdinalPolicy,
    };
  }, [semantics]);
  const previewIsStale = preview !== null && previewSemantics !== currentSemantics;

  const persistedQuery = useQuery<ApiResponse<FallDraftPersistedView>>({
    queryKey: [`${basePath}${querySuffix}`],
    queryFn: async () => apiRequest<FallDraftPersistedView>(`${basePath}${querySuffix}`, "GET"),
    retry: false,
  });

  const previewMutation = useMutation({
    mutationFn: async () => {
      if (!selectedSemantics) throw new Error("Select currency, billing policy, and billing ordinal policy before previewing");
      return apiRequest<FallDraftPreview>(`${basePath}/preview${querySuffix}`, "POST", {
        contractVersion: previewRequestVersion,
        ...selectedSemantics,
      });
    },
    onSuccess: (response) => {
      setPreview(response.data);
      setPreviewSemantics(currentSemantics);
      setApplied(null);
      setIdempotencyKey("");
      setLastApplyRequest(null);
      setIdentityError(null);
      requestAnimationFrame(() => previewHeadingRef.current?.focus());
    },
  });

  const applyMutation = useMutation({
    mutationFn: async (request: FallDraftApplyRequest) =>
      apiRequest<FallDraftApplyResult>(`${basePath}/apply${querySuffix}`, "POST", request),
    onSuccess: (response) => {
      setApplied(response.data);
      queryClient.invalidateQueries({ queryKey: [`${basePath}${querySuffix}`] });
    },
  });

  useEffect(() => {
    if (previewIsStale) setApplied(null);
  }, [previewIsStale]);

  const persisted = persistedQuery.data?.data;
  const persistedResult = persisted?.result;
  const canConfirm = !!preview && !!selectedSemantics && !previewIsStale && preview.eligibility.eligibleForApply
    && reason.trim() === reason && reason.length > 0 && !applyMutation.isPending;

  const applyCurrentPreview = () => {
    if (!preview || !selectedSemantics) return;
    let key = idempotencyKey;
    if (!key) {
      try {
        key = secureFallDraftIdempotencyKey();
      } catch (caught) {
        setIdentityError(caught instanceof Error ? caught.message : "Secure identifier generation is unavailable");
        return;
      }
    }
    setIdentityError(null);
    const request: FallDraftApplyRequest = {
      contractVersion: applyRequestVersion,
      ...selectedSemantics,
      confirmedPreviewFingerprint: preview.previewFingerprint,
      reason,
      idempotencyKey: key,
    };
    setIdempotencyKey(key);
    setLastApplyRequest(request);
    applyMutation.mutate(request);
  };

  return (
    <Card data-testid="fall-draft-generation-card">
      <CardHeader>
        <CardTitle as="h2">Fall canonical draft generation</CardTitle>
        <CardDescription>
          Preview the stored league schedule with explicit canonical policies, then create draft-only sessions for later C2 review.
        </CardDescription>
      </CardHeader>
      <CardContent className="mt-5 space-y-5">
        {persistedQuery.isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
            <Loader2 className="size-4 animate-spin" /> Checking for persisted drafts…
          </div>
        )}

        {persistedQuery.isError && (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertTitle>Could not load canonical draft state</AlertTitle>
            <AlertDescription>
              <Button variant="outline" size="sm" className="mt-2" onClick={() => persistedQuery.refetch()}>
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {persisted?.found && persistedResult && (
          <Alert>
            <CheckCircle2 className="size-4" />
            <AlertTitle>Canonical drafts already exist</AlertTitle>
            <AlertDescription>
              <div className="space-y-2">
                <p>
                  {persistedResult.counts.occurrences} occurrence drafts, {persistedResult.counts.billingTerms} billing-policy drafts,
                  and {persistedResult.counts.exceptions} skip exceptions were created at source revision {persistedResult.sourceScheduleRevision}.
                </p>
                <div>
                  Legacy schedule match:{" "}
                  <Badge variant={persisted.currentLegacyScheduleMatchesGenerationInput ? "outline" : "destructive"}>
                    {persisted.currentLegacyScheduleMatchesGenerationInput ? "Current" : "Stale — preview again for review only"}
                  </Badge>
                </div>
                <p className="break-all font-mono text-xs">Input {persistedResult.inputFingerprint}</p>
                <p className="break-all font-mono text-xs">Generation run {persistedResult.durableIds.generationRunId}</p>
              </div>
            </AlertDescription>
          </Alert>
        )}

        {persisted?.found && persisted.transitionedToC2 && !persistedResult && (
          <Alert>
            <CheckCircle2 className="size-4" />
            <AlertTitle>Canonical set is managed by C2</AlertTitle>
            <AlertDescription>
              The exact current editable, published, or rejected state is shown in the audited review below.
              {persisted.generationRunId && <span className="mt-1 block break-all font-mono text-xs">Generation run {persisted.generationRunId}</span>}
            </AlertDescription>
          </Alert>
        )}

        {!persistedQuery.isLoading && !persisted?.found && (
          <p className="text-sm text-muted-foreground">No C1 canonical draft generation exists for this league.</p>
        )}

        <fieldset className="grid gap-4 rounded-md border p-4 sm:grid-cols-2" disabled={previewMutation.isPending || applyMutation.isPending}>
          <legend className="px-1 text-sm font-medium">Explicit generator semantics</legend>
          <div className="space-y-2">
            <Label htmlFor="fall-draft-fold">Ambiguous DST fold policy</Label>
            <Select value={semantics.ambiguousFold} onValueChange={(value: FallDraftGeneratorSemantics["ambiguousFold"]) => setSemantics((current) => ({ ...current, ambiguousFold: value }))}>
              <SelectTrigger id="fall-draft-fold"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="reject">Reject (safe default)</SelectItem>
                <SelectItem value="earlier">Earlier instant</SelectItem>
                <SelectItem value="later">Later instant</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="fall-draft-currency">Currency</Label>
            <Input id="fall-draft-currency" value={semantics.currency} maxLength={3} inputMode="text"
              onChange={(event) => setSemantics((current) => ({ ...current, currency: event.target.value.toUpperCase() }))}
              placeholder="USD" aria-describedby="fall-draft-currency-help" />
            <p id="fall-draft-currency-help" className="text-xs text-muted-foreground">Uppercase three-letter code; never inferred.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="fall-draft-billing-policy">Regular-session billing policy</Label>
            <Select value={semantics.regularSessionBillingPolicy} onValueChange={(value: FallDraftGeneratorSemantics["regularSessionBillingPolicy"]) => setSemantics((current) => ({ ...current, regularSessionBillingPolicy: value }))}>
              <SelectTrigger id="fall-draft-billing-policy"><SelectValue placeholder="Select billing policy" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="eligible_bowlers">Eligible bowlers</SelectItem>
                <SelectItem value="none">None</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="fall-draft-ordinal-policy">Billing ordinal policy</Label>
            <Select value={semantics.billingOrdinalPolicy} onValueChange={(value: FallDraftGeneratorSemantics["billingOrdinalPolicy"]) => setSemantics((current) => ({ ...current, billingOrdinalPolicy: value }))}>
              <SelectTrigger id="fall-draft-ordinal-policy"><SelectValue placeholder="Select ordinal policy" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="planned_slot">Planned slot</SelectItem>
                <SelectItem value="dense_billable">Dense billable</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </fieldset>

        <Button onClick={() => previewMutation.mutate()} disabled={previewMutation.isPending || selectedSemantics === null}>
          {previewMutation.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <RefreshCw className="mr-2 size-4" />}
          Generate zero-write preview
        </Button>

        {previewMutation.isError && (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertTitle>Preview failed</AlertTitle>
            <AlertDescription>{previewMutation.error instanceof Error ? previewMutation.error.message : "Preview could not be generated"}</AlertDescription>
          </Alert>
        )}

        {preview && (
          <section className="space-y-4" aria-labelledby="fall-draft-preview-heading">
            <div>
              <h3 id="fall-draft-preview-heading" ref={previewHeadingRef} tabIndex={-1} className="text-lg font-semibold outline-none">
                Canonical preview
              </h3>
              <p className="text-sm text-muted-foreground">
                Source revision {preview.proposedSourceScheduleRevision.value} is proposed only; it is not reserved.
              </p>
            </div>

            {previewIsStale && (
              <Alert variant="destructive">
                <AlertCircle className="size-4" />
                <AlertTitle>Preview controls changed</AlertTitle>
                <AlertDescription>Generate a new preview before confirming.</AlertDescription>
              </Alert>
            )}

            {!preview.eligibility.eligibleForApply && (
              <Alert variant="destructive">
                <AlertCircle className="size-4" />
                <AlertTitle>Preview cannot be applied</AlertTitle>
                <AlertDescription>{preview.eligibility.blockers.join(", ") || "The preview is not eligible."}</AlertDescription>
              </Alert>
            )}

            <div className="grid gap-2 text-xs sm:grid-cols-2">
              <p className="break-all"><span className="font-medium">Preview:</span> <span className="font-mono">{preview.previewFingerprint}</span></p>
              <p className="break-all"><span className="font-medium">A2 input:</span> <span className="font-mono">{preview.inputFingerprint}</span></p>
              <p className="break-all"><span className="font-medium">Physical schedule:</span> <span className="font-mono">{preview.physicalScheduleFingerprint}</span></p>
              <p><span className="font-medium">Versions:</span> {preview.generatorVersion}; {preview.inputContractVersion}; {preview.previewContractVersion}</p>
            </div>

            <div className="overflow-x-auto rounded-md border">
              <table className="w-full min-w-[900px] text-left text-sm">
                <caption className="sr-only">Canonical Fall occurrence candidates</caption>
                <thead className="bg-muted/50">
                  <tr>
                    {['Date / local time', 'UTC / offset', 'State', 'Numbers', 'Billing policy', 'Amount', 'Generation key'].map((heading) => (
                      <th key={heading} scope="col" className="px-3 py-2 font-medium">{heading}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {preview.occurrenceCandidates.map((occurrence) => {
                    const term = preview.billingTermCandidates.find((candidate) => candidate.occurrenceCandidateReference === occurrence.candidateReference);
                    return (
                      <tr key={occurrence.generationKey}>
                        <td className="px-3 py-2">{occurrence.authoritativeLocalDate}<br />{occurrence.authoritativeLocalStartTime} {occurrence.timezone}</td>
                        <td className="px-3 py-2">{occurrence.startAt}<br />UTC{occurrence.selectedUtcOffsetMinutes >= 0 ? "+" : ""}{occurrence.selectedUtcOffsetMinutes / 60} · {occurrence.foldResolution}</td>
                        <td className="px-3 py-2"><Badge variant={occurrence.status === "cancelled" ? "destructive" : "outline"}>{occurrence.status}</Badge><br />draft lifecycle</td>
                        <td className="px-3 py-2">planned {occurrence.plannedOrdinal}<br />competition {occurrence.competitionNumber ?? "—"}<br />billing {term?.billingOrdinal ?? "—"}</td>
                        <td className="px-3 py-2">{term?.obligationPolicy ?? "—"}<br />policy snapshot only</td>
                        <td className="px-3 py-2">{term ? formatMoney(term.defaultAmountMinor, term.currency) : "—"}</td>
                        <td className="max-w-56 break-all px-3 py-2 font-mono text-xs">{occurrence.generationKey}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {preview.exceptionCandidates.length > 0 && (
              <div>
                <h4 className="font-medium">Skip exceptions</h4>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
                  {preview.exceptionCandidates.map((candidate) => (
                    <li key={candidate.candidateKey}>{candidate.authoritativeLocalDate}: {candidate.reason} (draft; no occurrence)</li>
                  ))}
                </ul>
              </div>
            )}

            {(preview.fatalErrors.length > 0 || preview.discrepancies.length > 0) && (
              <div>
                <h4 className="font-medium">Generator review evidence</h4>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
                  {preview.fatalErrors.map((error) => <li key={`${error.path}:${error.code}`}>Fatal: {error.code} — {error.message}</li>)}
                  {preview.discrepancies.map((item, index) => <li key={`${item.code}:${index}`}>{item.severity}: {item.code}</li>)}
                </ul>
              </div>
            )}

            <div className="rounded-md border border-dashed p-3 text-sm">
              <p className="font-medium">Excluded legacy collection evidence</p>
              <p className="text-muted-foreground">
                Double-pay dates: {preview.legacyCollectionEvidence.doublePayDates.join(", ") || "none"}. These do not affect A2 input, physical-schedule or candidate-set fingerprints, sessions, ordinals, terms, amounts, obligations, or allocations. The complete preview fingerprint includes this displayed evidence, so a change requires a new preview.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="fall-draft-reason">Reason for draft creation</Label>
              <Textarea id="fall-draft-reason" value={reason} onChange={(event) => setReason(event.target.value)}
                placeholder="Explain why this deterministic preview is being created as canonical drafts" disabled={persisted?.found === true} />
            </div>

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button disabled={!canConfirm}>Confirm and create canonical drafts</Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Create this complete draft set?</AlertDialogTitle>
                  <AlertDialogDescription>
                    The server will lock this league, reload the stored schedule, verify preview {shortFingerprint(preview.previewFingerprint)}, and atomically create draft rows only. This does not approve or publish them.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={applyCurrentPreview}>Create drafts</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </section>
        )}

        {applyMutation.isPending && <p className="text-sm" aria-live="polite"><Loader2 className="mr-2 inline size-4 animate-spin" />Creating the complete draft set…</p>}
        {identityError && (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertTitle>Draft creation is unavailable</AlertTitle>
            <AlertDescription>{identityError}</AlertDescription>
          </Alert>
        )}
        {applyMutation.isError && (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertTitle>Draft creation failed</AlertTitle>
            <AlertDescription>
              <p>{applyMutation.error instanceof Error ? applyMutation.error.message : "Drafts could not be created"}</p>
              {lastApplyRequest && <Button variant="outline" size="sm" className="mt-2" onClick={() => applyMutation.mutate(lastApplyRequest)}>Retry exact request</Button>}
            </AlertDescription>
          </Alert>
        )}
        {applied && (
          <Alert>
            <CheckCircle2 className="size-4" />
            <AlertTitle>{applied.mode === "idempotent_retry" ? "Existing draft generation verified" : "Canonical drafts created"}</AlertTitle>
            <AlertDescription>
              {applied.counts.occurrences} occurrences and {applied.counts.billingTerms} separate billing-policy snapshots are draft-only. No approval, publication, relationship, obligation, collection, or payment rows were created.
            </AlertDescription>
          </Alert>
        )}
        <FallDraftReviewPanel basePath={basePath} querySuffix={querySuffix} enabled={persisted?.found === true} />
      </CardContent>
    </Card>
  );
}
