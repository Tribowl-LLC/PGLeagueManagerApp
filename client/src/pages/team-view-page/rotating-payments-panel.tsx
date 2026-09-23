import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CalendarDays, CircleDollarSign, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { fingerprintCanonicalRequest } from "@/lib/rotating-payment-fingerprint";
import { nearestCanonicalOccurrence } from "@/lib/rotating-payment-date";
import { apiRequest } from "@/lib/queryClient";
import type { TeamBowlerEntry } from "@/lib/bowler-league-utils";
import { formatCurrency } from "@/lib/utils";
import type { BowlerWithAccount, League } from "@shared/schema";
import {
  serializeCanonicalRotatingRosterFingerprint,
  serializeRotatingOccurrenceAssignmentFingerprint,
  type RosterPaymentResponsibilityReadContractV2,
  type RosterPaymentResponsibilityRequestV2,
  type RotatingOccurrenceAssignmentInput,
} from "@shared/roster-payment-contract";
import type { FinancialReadContractV3 } from "@shared/financial-contract";
import type {
  RotatingCreditBalanceWire,
  RotatingCreditManualFundingRequest,
  RotatingCreditManualQuoteWire,
  RotatingCreditOperationWire,
  RotatingCreditRefundOperationWire,
  RotatingCreditRefundQuoteWire,
  RotatingCreditRefundRequest,
} from "@shared/rotating-credit-contract";

type ApiResponse<T> = { success: boolean; data: T; error?: { message: string; code?: string } };
type RotationTeam = RosterPaymentResponsibilityReadContractV2["teams"][number];
type RotationSlot = RosterPaymentResponsibilityReadContractV2["teams"][number]["slots"][number];
type SlotDraft = Pick<RotationSlot, "slotIndex" | "occupant" | "mainBowlerId">;
type RotatingCreditRefundFields = Omit<RotatingCreditRefundRequest, "idempotencyKey">;
type RotatingCreditManualFundingFields = Omit<RotatingCreditManualFundingRequest, "idempotencyKey">;
type RotatingCreditAdminTeamMembersWire = {
  members: Array<{ bowlerId: number; name: string; activeRotationMember: boolean }>;
};
type RefundCommand = {
  identity: string;
  bowlerId: number;
  amountMinor: number;
  request: RotatingCreditRefundFields;
  idempotencyKey: string;
};
type ManualFundingCommand = {
  identity: string;
  request: RotatingCreditManualFundingFields;
  idempotencyKey: string;
};

interface RotatingPaymentsPanelProps {
  leagueId: number;
  teamId: number;
  league: League | undefined;
  teamBowlers: TeamBowlerEntry<BowlerWithAccount>[];
  canManage: boolean;
  roster: RosterPaymentResponsibilityReadContractV2 | undefined;
  rosterLoading: boolean;
  rosterError: unknown;
  onReloadRoster: () => Promise<unknown>;
}

const money = (amountMinor: number) => formatCurrency(amountMinor);

function isActiveMember(entry: TeamBowlerEntry<BowlerWithAccount>): boolean {
  return entry.bowler.active && entry.bowlerLeague.active;
}

function apiMessage(error: unknown, fallback: string): string {
  if (typeof error === "string") return error;
  return error instanceof Error ? error.message : fallback;
}

function responseError(response: { error?: { message: string; code?: string } }, fallback: string): Error {
  const error = new Error(response.error?.message ?? fallback);
  if (response.error?.code) Object.assign(error, { code: response.error.code });
  return error;
}

function isDefinitiveRefundRejection(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error) || typeof error.code !== "string") return false;
  return new Set([
    "CREDIT_LOT_NOT_FOUND",
    "CREDIT_BALANCE_EVIDENCE_MISSING",
    "CREDIT_LOT_REQUIRES_REVIEW",
    "NO_UNUSED_CREDIT",
    "STALE_REFUND_QUOTE",
    "CREDIT_FUNDING_REQUIRES_REVIEW",
    "PROVIDER_REFUND_UNAVAILABLE",
    "REFUND_REFERENCE_REQUIRED",
  ]).has(error.code);
}

function isDefinitiveManualFundingRejection(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error) || typeof error.code !== "string") return false;
  return new Set([
    "INVALID_REQUEST",
    "NOT_FOUND",
    "RESOURCE_NOT_FOUND",
    "ROTATING_CREDIT_NOT_ELIGIBLE",
    "ROTATING_CREDIT_AMOUNT_INVALID",
    "STALE_QUOTE",
  ]).has(error.code);
}

function isRevisionConflict(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ASSIGNMENT_REVISION_MISMATCH";
}

function getSlotKey(occurrenceId: string, slotIndex: number): string {
  return `${occurrenceId}:${slotIndex}`;
}

function parseMoneyToMinor(value: string): number | null {
  const trimmed = value.trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) return null;
  const whole = BigInt(match[1]);
  const fractional = BigInt((match[2] ?? "").padEnd(2, "0") || "0");
  const amount = whole * 100n + fractional;
  return amount > 0n && amount <= 2_147_483_647n ? Number(amount) : null;
}

function refundStatusMessage(status: RotatingCreditRefundOperationWire["status"]): string {
  switch (status) {
    case "succeeded": return "The refund was recorded successfully.";
    case "pending": return "The refund is pending. Available credit may remain held until its status is confirmed.";
    case "leased": return "The refund is being processed. Available credit may remain held until processing finishes.";
    case "provider_unknown": return "The provider status is unknown. Retry this same request to check its status before starting another refund.";
    case "retry_scheduled": return "The provider retry is scheduled. The server is holding the credit while it finishes.";
    case "action_required": return "This refund needs staff attention. Review the payment record before issuing another refund.";
    case "reconciliation_required": return "This refund needs reconciliation. Resolve its status before issuing another refund.";
    case "failed_terminal": return "The provider refund failed. Refresh the balance before requesting another quote.";
    case "canceled": return "The refund was canceled. Refresh the balance before requesting another quote.";
  }
}

function canRetryRefund(status: RotatingCreditRefundOperationWire["status"]): boolean {
  return status === "pending" || status === "leased" || status === "provider_unknown" || status === "retry_scheduled";
}

function hasUnresolvedRefund(status: RotatingCreditRefundOperationWire["status"]): boolean {
  return canRetryRefund(status) || status === "action_required" || status === "reconciliation_required";
}

function creditPaymentTypeLabel(paymentType: string): string {
  if (paymentType === "cash") return "cash";
  if (paymentType === "check") return "check";
  return "provider payment";
}

export function RotatingPaymentsPanel({
  leagueId,
  teamId,
  league,
  teamBowlers,
  canManage,
  roster,
  rosterLoading,
  rosterError,
  onReloadRoster,
}: RotatingPaymentsPanelProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const team = roster?.teams.find((row) => row.id === teamId);
  const lineupSize = roster?.payingLineupSize ?? null;
  const [slotDraft, setSlotDraft] = useState<SlotDraft[] | null>(null);
  const [eligibleDraft, setEligibleDraft] = useState<number[] | null>(null);
  const [optInRequested, setOptInRequested] = useState(false);
  const [selectedOccurrenceId, setSelectedOccurrenceId] = useState("");
  const [assignmentDraft, setAssignmentDraft] = useState<Record<string, string>>({});
  const [correctionReasons, setCorrectionReasons] = useState<Record<string, string>>({});
  const [manualBowlerId, setManualBowlerId] = useState("");
  const [manualAmount, setManualAmount] = useState("");
  const [manualTender, setManualTender] = useState<"cash" | "check">("cash");
  const [manualCheckNumber, setManualCheckNumber] = useState("");
  const [manualNotes, setManualNotes] = useState("");
  const [manualResult, setManualResult] = useState<RotatingCreditOperationWire | null>(null);
  const manualCommandRef = useRef<ManualFundingCommand | null>(null);
  const [refundBowlerId, setRefundBowlerId] = useState("");
  const [refundFundingId, setRefundFundingId] = useState("");
  const [refundKind, setRefundKind] = useState<"provider" | "cash" | "check">("cash");
  const [refundReason, setRefundReason] = useState("");
  const [refundReference, setRefundReference] = useState("");
  const [refundResult, setRefundResult] = useState<RotatingCreditRefundOperationWire | null>(null);
  const refundCommandRef = useRef<RefundCommand | null>(null);

  useEffect(() => {
    setSlotDraft(null);
    setEligibleDraft(null);
  }, [teamId, roster?.teams]);

  useEffect(() => {
    const occurrences = roster?.occurrences ?? [];
    if (occurrences.some((occurrence) => occurrence.id === selectedOccurrenceId)) return;
    const nearest = nearestCanonicalOccurrence(occurrences, league?.timezone ?? "UTC");
    setSelectedOccurrenceId(nearest?.id ?? "");
  }, [roster?.occurrences, selectedOccurrenceId, league?.timezone]);

  const normalizedSlots = useMemo(() => {
    if (lineupSize === null) return [];
    const configured = slotDraft ?? team?.slots.map(({ slotIndex, occupant, mainBowlerId }) => ({ slotIndex, occupant, mainBowlerId })) ?? [];
    return Array.from({ length: lineupSize }, (_, slotIndex) => configured.find((slot) => slot.slotIndex === slotIndex) ?? {
      slotIndex,
      occupant: "unassigned" as const,
      mainBowlerId: null,
    });
  }, [lineupSize, slotDraft, team?.slots]);
  const eligibleIds = eligibleDraft ?? team?.eligibleRotatingBowlerIds ?? [];
  const rotationEnabled = normalizedSlots.some((slot) => slot.occupant === "rotating");
  const optInVisible = rotationEnabled || optInRequested;
  const activeMembers = teamBowlers.filter(isActiveMember);
  const memberById = useMemo(() => new Map(teamBowlers.map(({ bowler }) => [bowler.id, bowler])), [teamBowlers]);
  const teamBowlerIds = new Set(teamBowlers.map(({ bowler }) => bowler.id));
  const fixedMainIds = new Set(normalizedSlots.flatMap((slot) => slot.occupant === "main" && slot.mainBowlerId !== null ? [slot.mainBowlerId] : []));
  const staleEligibleIds = eligibleIds.filter((bowlerId) => !teamBowlerIds.has(bowlerId) || !memberById.get(bowlerId)?.active || fixedMainIds.has(bowlerId));
  const hasDuplicateMains = normalizedSlots
    .filter((slot) => slot.occupant === "main" && slot.mainBowlerId !== null)
    .some((slot, index, mains) => mains.findIndex((other) => other.mainBowlerId === slot.mainBowlerId) !== index);
  const hasUnselectedMain = normalizedSlots.some((slot) => slot.occupant === "main" && slot.mainBowlerId === null);
  const rotatingSlotIndexes = normalizedSlots.filter((slot) => slot.occupant === "rotating").map((slot) => slot.slotIndex);
  const draftEligibleIds = new Set(eligibleIds);

  const balanceQuery = useQuery<ApiResponse<FinancialReadContractV3>>({
    queryKey: [`/api/financials/leagues/${leagueId}/canonical-due-past-due/3`],
    enabled: canManage && rotationEnabled,
    retry: false,
  });
  const adminTeamMembersPath = `/api/financials/leagues/${leagueId}/rotating-credit/admin/teams/${teamId}/members/1`;
  const adminTeamMembersQuery = useQuery<ApiResponse<RotatingCreditAdminTeamMembersWire>>({
    queryKey: [adminTeamMembersPath],
    enabled: canManage,
    retry: false,
  });
  const refundBowlerIdValue = refundBowlerId ? Number(refundBowlerId) : null;
  const refundBalancePath = refundBowlerIdValue === null
    ? null
    : `/api/financials/leagues/${leagueId}/rotating-credit/admin/${refundBowlerIdValue}/1`;
  const refundBalanceQuery = useQuery<ApiResponse<RotatingCreditBalanceWire>>({
    queryKey: [refundBalancePath ?? `/api/financials/leagues/${leagueId}/rotating-credit/admin/0/1`],
    enabled: canManage && refundBalancePath !== null,
    retry: false,
  });
  const refundBalance = refundBalanceQuery.data?.success ? refundBalanceQuery.data.data : null;
  const refundMembers = adminTeamMembersQuery.data?.success ? adminTeamMembersQuery.data.data.members : [];
  const refundLots = refundBalance?.lots ?? [];
  const selectedRefundLot = refundLots.find((lot) => lot.fundingId === refundFundingId);
  const teamRows = useMemo(() => balanceQuery.data?.data?.rows.filter((row) => row.owner.kind === "team" && row.owner.teamId === teamId) ?? [], [balanceQuery.data?.data?.rows, teamId]);
  const remainderByOccurrence = useMemo(() => {
    const byOccurrence = new Map<string, { localDate: string; outstandingMinor: number; reviewRequired: boolean; rows: typeof teamRows }>();
    for (const row of teamRows) {
      const current = byOccurrence.get(row.occurrenceId) ?? {
        localDate: row.occurrenceLocalDate,
        outstandingMinor: 0,
        reviewRequired: false,
        rows: [],
      };
      current.outstandingMinor += row.outstandingMinor;
      current.reviewRequired ||= row.reviewRequired;
      current.rows.push(row);
      byOccurrence.set(row.occurrenceId, current);
    }
    return byOccurrence;
  }, [teamRows]);

  const saveRoster = useMutation({
    mutationFn: async () => {
      if (lineupSize === null || !team) throw new Error("The league paying lineup size is not configured yet.");
      const request: Omit<RosterPaymentResponsibilityRequestV2, "commandKey" | "requestFingerprint"> = {
        lineupSize,
        policy: team.policy,
        slots: normalizedSlots.map((slot) => ({
          slotIndex: slot.slotIndex,
          occupant: slot.occupant,
          mainBowlerId: slot.occupant === "main" ? slot.mainBowlerId : null,
        })),
        eligibleRotatingBowlerIds: [...eligibleIds].sort((left, right) => left - right),
      };
      const requestFingerprint = await fingerprintCanonicalRequest(
        "lvroster:v2",
        serializeCanonicalRotatingRosterFingerprint(request),
      );
      const response = await apiRequest(`/api/financials/leagues/${leagueId}/roster-payment-responsibility/2/teams/${teamId}`, "POST", {
        commandKey: crypto.randomUUID(),
        requestFingerprint,
        ...request,
      });
      if (!response.success) throw new Error(response.error?.message ?? "The team rotation settings could not be saved.");
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/roster-payment-responsibility/2`] }),
        queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/roster-payment-responsibility/1`] }),
        queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/canonical-due-past-due/3`] }),
      ]);
      setSlotDraft(null);
      setEligibleDraft(null);
      setOptInRequested(false);
      toast({ title: "Rotating payment settings saved" });
    },
    onError: (error: Error) => toast({ title: "Rotating payment settings could not be saved", description: error.message, variant: "destructive" }),
  });

  const selectedOccurrence = roster?.occurrences.find((occurrence) => occurrence.id === selectedOccurrenceId);
  const currentAssignments = useMemo(() => roster?.rotationAssignments.filter((assignment) => assignment.teamId === teamId && assignment.occurrenceId === selectedOccurrenceId) ?? [], [roster?.rotationAssignments, teamId, selectedOccurrenceId]);
  const assignmentBySlot = useMemo(() => new Map(currentAssignments.map((assignment) => [assignment.slotIndex, assignment])), [currentAssignments]);
  const pendingAssignments = useMemo(() => normalizedSlots
    .filter((slot) => slot.occupant === "rotating")
    .flatMap((slot) => {
      if (!selectedOccurrenceId) return [];
      const current = assignmentBySlot.get(slot.slotIndex);
      const key = getSlotKey(selectedOccurrenceId, slot.slotIndex);
      const draftValue = assignmentDraft[key] ?? (current?.actualBowlerId == null ? "" : String(current.actualBowlerId));
      const nextBowlerId = draftValue === "" ? null : Number(draftValue);
      if (nextBowlerId === (current?.actualBowlerId ?? null)) return [];
      const correctionReason = correctionReasons[key]?.trim();
      return [{
        occurrenceId: selectedOccurrenceId,
        teamId,
        slotIndex: slot.slotIndex,
        expectedRevision: current?.revision ?? null,
        actualBowlerId: nextBowlerId,
        ...(correctionReason ? { correctionReason } : {}),
      } satisfies RotatingOccurrenceAssignmentInput];
    }), [normalizedSlots, selectedOccurrenceId, assignmentBySlot, assignmentDraft, correctionReasons, teamId]);
  const duplicateDraftBowler = useMemo(() => {
    const ids = normalizedSlots.filter((slot) => slot.occupant === "rotating").flatMap((slot) => {
      const current = assignmentBySlot.get(slot.slotIndex);
      const value = assignmentDraft[getSlotKey(selectedOccurrenceId, slot.slotIndex)] ?? (current?.actualBowlerId == null ? "" : String(current.actualBowlerId));
      return value ? [Number(value)] : [];
    });
    return new Set(ids).size !== ids.length;
  }, [normalizedSlots, assignmentBySlot, assignmentDraft, selectedOccurrenceId]);
  const hasMissingCorrectionReason = pendingAssignments.some((assignment) => assignment.expectedRevision !== null && !assignment.correctionReason);

  const saveAssignments = useMutation({
    mutationFn: async () => {
      if (pendingAssignments.length === 0) throw new Error("There are no lineup changes to save.");
      if (duplicateDraftBowler) throw new Error("A bowler can be confirmed in only one rotating position for this date.");
      if (hasMissingCorrectionReason) throw new Error("Add a reason for changing a previously confirmed lineup.");
      const requestFingerprint = await fingerprintCanonicalRequest(
        "lvrotationassignment:v1",
        serializeRotatingOccurrenceAssignmentFingerprint(pendingAssignments),
      );
      const response = await apiRequest(`/api/financials/leagues/${leagueId}/roster-payment-responsibility/2/rotating-assignments`, "POST", {
        commandKey: crypto.randomUUID(),
        requestFingerprint,
        assignments: pendingAssignments,
      });
      if (!response.success) {
        const error = new Error(response.error?.message ?? "The lineup could not be confirmed.");
        if (response.error?.code) Object.assign(error, { code: response.error.code });
        throw error;
      }
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/roster-payment-responsibility/2`] }),
        queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/canonical-due-past-due/3`] }),
      ]);
      setAssignmentDraft({});
      setCorrectionReasons({});
      toast({ title: "Lineup confirmation saved", description: "Payment status updates separately from who is confirmed to bowl." });
    },
    onError: (error: Error) => toast({ title: "Lineup confirmation could not be saved", description: error.message, variant: "destructive" }),
  });

  const toggleRotation = (enabled: boolean) => {
    if (enabled) {
      setOptInRequested(true);
      return;
    }
    setSlotDraft(normalizedSlots.map((slot) => slot.occupant === "rotating" ? { ...slot, occupant: "unassigned", mainBowlerId: null } : slot));
    setEligibleDraft([]);
    setOptInRequested(false);
  };

  const updateSlot = (slotIndex: number, patch: Partial<SlotDraft>) => {
    const nextSlots = normalizedSlots.map((slot) => slot.slotIndex === slotIndex ? { ...slot, ...patch } : slot);
    setSlotDraft(nextSlots);
    if (!nextSlots.some((slot) => slot.occupant === "rotating")) setEligibleDraft([]);
  };

  const toggleEligible = (bowlerId: number, checked: boolean) => {
    const next = new Set(eligibleIds);
    if (checked) next.add(bowlerId);
    else next.delete(bowlerId);
    setEligibleDraft([...next].sort((left, right) => left - right));
  };

  const savedMainIds = new Set(team?.slots.flatMap((slot) => slot.occupant === "main" && slot.mainBowlerId !== null ? [slot.mainBowlerId] : []) ?? []);
  const savedEligibleMembers = teamBowlers.filter(({ bowler, bowlerLeague }) => bowler.active && bowlerLeague.active
    && team?.eligibleRotatingBowlerIds.includes(bowler.id) === true && !savedMainIds.has(bowler.id));
  const manualAmountMinor = parseMoneyToMinor(manualAmount);
  const manualBowlerIdValue = manualBowlerId ? Number(manualBowlerId) : null;
  const manualQuoteMutation = useMutation({
    mutationFn: async ({ bowlerId, amountMinor }: { bowlerId: number; amountMinor: number }) => {
      const response = await apiRequest<RotatingCreditManualQuoteWire>(`/api/financials/leagues/${leagueId}/rotating-credit/manual/quote/1`, "POST", { bowlerId, amountMinor });
      if (!response.success) throw new Error(response.error?.message ?? "Staff payment quote could not be confirmed.");
      return response.data;
    },
    onSuccess: () => setManualResult(null),
  });
  const manualQuote = manualQuoteMutation.data;
  const manualRecordMutation = useMutation<RotatingCreditOperationWire, Error, RotatingCreditManualFundingRequest>({
    mutationFn: async (input) => {
      const response = await apiRequest<RotatingCreditOperationWire>(`/api/financials/leagues/${leagueId}/rotating-credit/manual/1`, "POST", input);
      if (!response.success) throw responseError(response, "Manual rotating payment could not be recorded.");
      return response.data;
    },
    onSuccess: async (result, variables) => {
      setManualResult(result);
      manualCommandRef.current = null;
      const appliedMinor = result.applications.reduce((total, application) => (
        application.status === "active" ? total + application.amountMinor : total
      ), 0);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/rotating-credit/admin/${variables.bowlerId}/1`] }),
        queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/rotating-credit/admin/teams/${teamId}/members/1`] }),
        queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/canonical-due-past-due/3`] }),
        queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/roster-payment-responsibility/2`] }),
      ]);
      toast({
        title: "Rotating payment recorded",
        description: appliedMinor > 0
          ? `${money(result.fundedMinor)} received as credit; ${money(appliedMinor)} applied to confirmed dates.`
          : `${money(result.fundedMinor)} received as credit; no confirmed dates needed credit, so it remains available.`,
      });
    },
    onError: async (error, variables) => {
      const definitiveRejection = isDefinitiveManualFundingRejection(error);
      if (definitiveRejection) {
        manualCommandRef.current = null;
        manualQuoteMutation.reset();
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/rotating-credit/admin/${variables.bowlerId}/1`] }),
        queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/rotating-credit/admin/teams/${teamId}/members/1`] }),
        queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/canonical-due-past-due/3`] }),
        queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/roster-payment-responsibility/2`] }),
      ]);
      toast({
        title: definitiveRejection ? "Manual rotating payment was not recorded" : "Manual rotating payment status could not be confirmed",
        description: definitiveRejection
          ? `${error.message} Refresh the quote before recording another payment.`
          : "Do not record the same tender again or change its details. Retry this same request to check its status; LeagueVault will reuse the same idempotency key.",
        variant: "destructive",
      });
    },
  });
  const currentManualCommand = manualCommandRef.current;
  const manualPostAmbiguous = manualRecordMutation.error !== null && currentManualCommand !== null;
  const manualFormLocked = manualRecordMutation.isPending || manualPostAmbiguous;
  const manualCanRetry = manualPostAmbiguous && !manualRecordMutation.isPending;

  const refundQuoteMutation = useMutation<RotatingCreditRefundQuoteWire, Error, { bowlerId: number; fundingId: string }>({
    mutationFn: async ({ bowlerId, fundingId }) => {
      const response = await apiRequest<RotatingCreditRefundQuoteWire>(
        `/api/financials/leagues/${leagueId}/rotating-credit/refund/quote/1`,
        "POST",
        { fundingId },
      );
      if (!response.success) throw new Error(response.error?.message ?? "Refund quote could not be confirmed.");
      if (response.data.bowlerId !== bowlerId || response.data.leagueId !== leagueId || response.data.fundingId !== fundingId) {
        throw new Error("The server quote does not match the selected member and credit lot. Refresh the balance and try again.");
      }
      return response.data;
    },
  });
  const refundQuote = refundQuoteMutation.data;
  const refundQuoteMatchesSelection = refundQuote !== undefined
    && refundBowlerIdValue !== null
    && refundQuote.bowlerId === refundBowlerIdValue
    && refundQuote.fundingId === refundFundingId;
  const refundQuoteIsCurrent = refundQuoteMatchesSelection
    && selectedRefundLot !== undefined
    && refundQuote.amountMinor === selectedRefundLot.availableMinor;
  const refundRecordMutation = useMutation<RotatingCreditRefundOperationWire, Error, { bowlerId: number; request: RotatingCreditRefundFields; idempotencyKey: string }>({
    mutationFn: async ({ request, idempotencyKey }) => {
      const body: RotatingCreditRefundRequest = { ...request, idempotencyKey };
      const response = await apiRequest<RotatingCreditRefundOperationWire>(
        `/api/financials/leagues/${leagueId}/rotating-credit/refund/1`,
        "POST",
        body,
      );
      if (!response.success) throw responseError(response, "Credit refund could not be recorded.");
      return response.data;
    },
    onSuccess: async (result, variables) => {
      setRefundResult(result);
      if (result.status === "succeeded" || result.status === "failed_terminal" || result.status === "canceled") {
        refundCommandRef.current = null;
        refundQuoteMutation.reset();
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/rotating-credit/admin/${variables.bowlerId}/1`] }),
        queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/canonical-due-past-due/3`] }),
        queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/roster-payment-responsibility/2`] }),
      ]);
      toast({
        title: result.status === "succeeded" ? "Unused credit refund recorded" : "Refund status needs follow-up",
        description: result.status === "succeeded"
          ? `${money(result.amountMinor)} refunded. Current available credit: ${money(result.balance.availableMinor)}.`
          : refundStatusMessage(result.status),
      });
    },
    onError: async (error, variables) => {
      const definitiveRejection = isDefinitiveRefundRejection(error)
        && (refundResult === null || !hasUnresolvedRefund(refundResult.status));
      if (definitiveRejection) {
        refundCommandRef.current = null;
        refundQuoteMutation.reset();
        setRefundResult(null);
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/rotating-credit/admin/${variables.bowlerId}/1`] }),
        queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/canonical-due-past-due/3`] }),
        queryClient.invalidateQueries({ queryKey: [`/api/financials/leagues/${leagueId}/roster-payment-responsibility/2`] }),
      ]);
      toast({
        title: "Credit refund status could not be confirmed",
        description: definitiveRejection
          ? `${error.message} Refresh the balance and get a new quote before starting another refund.`
          : "Do not issue another refund. Retry the same request to check its status; LeagueVault will reuse the same idempotency key.",
        variant: "destructive",
      });
    },
  });
  const currentRefundCommand = refundCommandRef.current;
  const refundCommandMatchesSelection = currentRefundCommand?.bowlerId === refundBowlerIdValue
    && currentRefundCommand?.request.fundingId === refundFundingId;
  const refundPostAmbiguous = refundRecordMutation.error !== null && refundCommandMatchesSelection;
  const refundCanRetry = refundCommandMatchesSelection
    && (refundPostAmbiguous || refundResult !== null && canRetryRefund(refundResult.status));
  const refundFormLocked = refundRecordMutation.isPending
    || refundPostAmbiguous
    || refundResult !== null && hasUnresolvedRefund(refundResult.status);
  const refundBlocksNewRequest = refundFormLocked;

  const changeRefundBowler = (bowlerId: string) => {
    if (refundFormLocked || bowlerId === refundBowlerId) return;
    setRefundBowlerId(bowlerId);
    setRefundFundingId("");
    setRefundKind("cash");
    setRefundReason("");
    setRefundReference("");
    setRefundResult(null);
    refundQuoteMutation.reset();
    refundRecordMutation.reset();
    refundCommandRef.current = null;
  };
  const changeRefundFunding = (fundingId: string) => {
    if (refundFormLocked || fundingId === refundFundingId) return;
    setRefundFundingId(fundingId);
    setRefundKind("cash");
    setRefundReason("");
    setRefundReference("");
    setRefundResult(null);
    refundQuoteMutation.reset();
    refundRecordMutation.reset();
    refundCommandRef.current = null;
  };
  const requestRefundQuote = () => {
    if (refundBowlerIdValue === null || !selectedRefundLot || selectedRefundLot.availableMinor <= 0 || refundBlocksNewRequest) return;
    setRefundKind("cash");
    setRefundResult(null);
    refundRecordMutation.reset();
    refundQuoteMutation.mutate({ bowlerId: refundBowlerIdValue, fundingId: selectedRefundLot.fundingId });
  };
  const refundRequestBase = (): RotatingCreditRefundFields | null => {
    const reason = refundReason.trim();
    const reference = refundReference.trim();
    if (refundBlocksNewRequest || !refundQuoteIsCurrent || !refundQuote || !reason || reason.length > 500) return null;
    if (refundKind === "provider" && !refundQuote.providerRefundAvailable) return null;
    if (refundKind !== "provider" && (!reference || reference.length > 255)) return null;
    return {
      fundingId: refundQuote.fundingId,
      refundKind,
      quoteFingerprint: refundQuote.fingerprint,
      reason,
      ...(refundKind === "provider" ? {} : { reference }),
    };
  };
  const recordRefund = () => {
    if (refundBowlerIdValue === null) return;
    const request = refundRequestBase();
    const amountMinor = refundQuote?.amountMinor;
    if (!request || amountMinor === undefined) return;
    const identity = JSON.stringify(request);
    const existing = refundCommandRef.current;
    const command = existing?.identity === identity && existing.bowlerId === refundBowlerIdValue
      ? existing
      : {
        identity,
        bowlerId: refundBowlerIdValue,
        amountMinor,
        request,
        idempotencyKey: crypto.randomUUID(),
      };
    refundCommandRef.current = command;
    refundRecordMutation.mutate({ bowlerId: command.bowlerId, request: command.request, idempotencyKey: command.idempotencyKey });
  };
  const retryRefund = () => {
    const command = refundCommandRef.current;
    if (!command || !refundCanRetry || refundRecordMutation.isPending) return;
    refundRecordMutation.mutate({ bowlerId: command.bowlerId, request: command.request, idempotencyKey: command.idempotencyKey });
  };
  const changeRefundKind = (nextKind: "provider" | "cash" | "check") => {
    if (refundFormLocked || nextKind === refundKind) return;
    setRefundKind(nextKind);
    setRefundResult(null);
    refundRecordMutation.reset();
    refundCommandRef.current = null;
  };
  const changeRefundReason = (reason: string) => {
    if (refundFormLocked) return;
    setRefundReason(reason);
    setRefundResult(null);
    refundRecordMutation.reset();
    refundCommandRef.current = null;
  };
  const changeRefundReference = (reference: string) => {
    if (refundFormLocked) return;
    setRefundReference(reference);
    setRefundResult(null);
    refundRecordMutation.reset();
    refundCommandRef.current = null;
  };

  const requestManualQuote = () => {
    if (manualFormLocked || !manualBowlerIdValue || manualAmountMinor === null) return;
    setManualResult(null);
    manualRecordMutation.reset();
    manualQuoteMutation.mutate({ bowlerId: manualBowlerIdValue, amountMinor: manualAmountMinor });
  };
  const recordManualPayment = () => {
    if (manualFormLocked || manualRecordMutation.isPending) return;
    if (!manualQuote || manualBowlerIdValue === null || manualAmountMinor === null || manualQuote.bowlerId !== manualBowlerIdValue || manualQuote.amountMinor !== manualAmountMinor) return;
    if (manualTender === "check" && !manualCheckNumber.trim()) return;
    const inputBase = {
      bowlerId: manualBowlerIdValue,
      amountMinor: manualQuote.amountMinor,
      tenderType: manualTender,
      ...(manualTender === "check" ? { checkNumber: manualCheckNumber.trim() } : {}),
      quoteFingerprint: manualQuote.fingerprint,
      ...(manualNotes.trim() ? { notes: manualNotes.trim() } : {}),
    } as const;
    const identity = JSON.stringify(inputBase);
    const command = manualCommandRef.current?.identity === identity
      ? manualCommandRef.current
      : { identity, request: inputBase, idempotencyKey: crypto.randomUUID() };
    manualCommandRef.current = command;
    manualRecordMutation.mutate({ ...command.request, idempotencyKey: command.idempotencyKey });
  };
  const retryManualPayment = () => {
    const command = manualCommandRef.current;
    if (!command || !manualCanRetry || manualRecordMutation.isPending) return;
    manualRecordMutation.mutate({ ...command.request, idempotencyKey: command.idempotencyKey });
  };

  const changeManualTarget = (bowlerId: string) => {
    if (manualFormLocked) return;
    setManualBowlerId(bowlerId);
    setManualResult(null);
    manualQuoteMutation.reset();
    manualRecordMutation.reset();
    manualCommandRef.current = null;
  };
  const changeManualAmount = (amount: string) => {
    if (manualFormLocked) return;
    setManualAmount(amount);
    setManualResult(null);
    manualQuoteMutation.reset();
    manualRecordMutation.reset();
    manualCommandRef.current = null;
  };
  const changeManualTender = (tender: "cash" | "check") => {
    if (manualFormLocked || tender === manualTender) return;
    setManualTender(tender);
    setManualResult(null);
    manualRecordMutation.reset();
    manualCommandRef.current = null;
  };
  const changeManualCheckNumber = (checkNumber: string) => {
    if (manualFormLocked) return;
    setManualCheckNumber(checkNumber);
    setManualResult(null);
    manualRecordMutation.reset();
    manualCommandRef.current = null;
  };
  const changeManualNotes = (notes: string) => {
    if (manualFormLocked) return;
    setManualNotes(notes);
    setManualResult(null);
    manualRecordMutation.reset();
    manualCommandRef.current = null;
  };

  if (!canManage) return null;

  if (rosterLoading) {
    return <div className="mt-5"><Card aria-busy="true"><CardContent><p className="py-6 text-sm text-muted-foreground">Loading rotating payment settings…</p></CardContent></Card></div>;
  }
  if (rosterError || !roster || !team) {
    return <div className="mt-5"><Card><CardContent><div className="flex flex-col items-start gap-3 py-5 sm:flex-row sm:items-center sm:justify-between">
      <div role="alert" className="flex items-start gap-2 text-sm"><AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" /><span>{apiMessage(rosterError, "Rotating payment settings could not be loaded.")}</span></div>
      <Button variant="outline" size="sm" onClick={onReloadRoster}>Retry</Button>
    </div></CardContent></Card></div>;
  }

  const rotationAlreadyEnabled = team.slots.some((slot) => slot.occupant === "rotating");
  const rosterChanged = JSON.stringify(normalizedSlots.map((slot) => ({ ...slot, mainBowlerId: slot.occupant === "main" ? slot.mainBowlerId : null }))) !== JSON.stringify(team.slots.map(({ slotIndex, occupant, mainBowlerId }) => ({ slotIndex, occupant, mainBowlerId: occupant === "main" ? mainBowlerId : null })));
  const eligibilityChanged = JSON.stringify([...eligibleIds].sort((left, right) => left - right)) !== JSON.stringify([...team.eligibleRotatingBowlerIds].sort((left, right) => left - right));
  const configInvalid = lineupSize === null
    || !team.slots.length && lineupSize > 0 && normalizedSlots.length !== lineupSize
    || hasDuplicateMains
    || hasUnselectedMain
    || (optInVisible && !rotationEnabled)
    || staleEligibleIds.length > 0
    || (rotationEnabled && eligibleIds.filter((bowlerId) => activeMembers.some(({ bowler }) => bowler.id === bowlerId)).length === 0);

  return <section className="mt-5 space-y-4" aria-label="Rotating team payments">
    <Card>
      <CardHeader spacing="tight">
        <CardTitle><span className="flex items-center gap-2"><RotateCcw className="size-5" />Rotating team payments</span></CardTitle>
        <CardDescription>Choose who pays each position and confirm a bowler for each canonical league date. Confirming a lineup does not require prepaid credit.</CardDescription>
      </CardHeader>
      <CardContent><div className="space-y-5">
        {lineupSize === null ? <div role="status" className="rounded-md border border-warning-500/40 bg-warning-500/5 p-3 text-sm">Set the league paying lineup size before configuring team payment positions.</div> : <>
          <div className="flex flex-col justify-between gap-3 rounded-md border p-4 sm:flex-row sm:items-center">
            <div className="space-y-1">
              <p className="font-medium">Enable rotating payments for this team</p>
              <p className="text-sm text-muted-foreground">Fixed Main positions keep their existing payment and autopay behavior.</p>
            </div>
            <label className="flex items-center gap-3 text-sm font-medium">
              <span>{optInVisible ? "Enabled" : "Off"}</span>
              <input
                type="checkbox"
                role="switch"
                aria-label="Enable rotating payments for this team"
                checked={optInVisible}
                disabled={saveRoster.isPending || normalizedSlots.length === 0}
                onChange={(event) => toggleRotation(event.currentTarget.checked)}
                className="size-5 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              />
            </label>
          </div>

          <div className="space-y-3">
            <h3 className="font-medium">Paying positions</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              {normalizedSlots.map((slot) => <div key={slot.slotIndex} className="space-y-3 rounded-md border p-3">
                <label className="block text-sm font-medium" htmlFor={`rotation-position-${teamId}-${slot.slotIndex}`}>Position {slot.slotIndex + 1}</label>
                <select
                  id={`rotation-position-${teamId}-${slot.slotIndex}`}
                  aria-label={`Paying role for position ${slot.slotIndex + 1}`}
                  value={slot.occupant}
                  onChange={(event) => updateSlot(slot.slotIndex, {
                    occupant: event.currentTarget.value as SlotDraft["occupant"],
                    mainBowlerId: event.currentTarget.value === "main" ? slot.mainBowlerId : null,
                  })}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="main">Fixed Main payer</option>
                  <option value="rotating">Rotating payer</option>
                  <option value="vacant">Vacant</option>
                  <option value="unassigned">Unassigned</option>
                </select>
                {slot.occupant === "main" && <select
                  aria-label={`Main bowler for position ${slot.slotIndex + 1}`}
                  value={slot.mainBowlerId ?? ""}
                  onChange={(event) => updateSlot(slot.slotIndex, { mainBowlerId: event.currentTarget.value ? Number(event.currentTarget.value) : null })}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="">Choose Main payer</option>
                  {activeMembers.map(({ bowler }) => <option key={bowler.id} value={bowler.id}>{bowler.name}</option>)}
                </select>}
                <Badge variant={slot.occupant === "rotating" ? "default" : slot.occupant === "main" ? "secondary" : "outline"}>
                  {slot.occupant === "rotating" ? "Rotating share payer" : slot.occupant === "main" ? "Fixed Main · autopay unchanged" : slot.occupant === "vacant" ? "Vacant" : "Unassigned"}
                </Badge>
              </div>)}
            </div>
            {hasDuplicateMains && <p role="alert" className="text-sm text-destructive">Each active bowler can occupy only one fixed Main position.</p>}
            {hasUnselectedMain && <p role="alert" className="text-sm text-destructive">Choose an active bowler for every position marked Fixed Main.</p>}
          </div>

          {optInVisible && <div className="space-y-3 rounded-md border p-4">
            <div>
              <h3 className="font-medium">Eligible rotating members</h3>
              <p className="text-sm text-muted-foreground">Only active members of this team can be confirmed in rotating positions.</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {activeMembers.filter(({ bowler }) => !fixedMainIds.has(bowler.id)).map(({ bowler }) => <label key={bowler.id} className="flex min-h-11 items-center gap-3 rounded-md border px-3 py-2 text-sm">
                <Checkbox checked={draftEligibleIds.has(bowler.id)} onCheckedChange={(checked) => toggleEligible(bowler.id, checked === true)} aria-label={`Eligible rotating member ${bowler.name}`} />
                <span>{bowler.name}</span>
              </label>)}
              {staleEligibleIds.map((bowlerId) => <label key={`stale-${bowlerId}`} className="flex min-h-11 items-center gap-3 rounded-md border border-destructive/40 px-3 py-2 text-sm">
                <Checkbox checked onCheckedChange={(checked) => { if (checked !== true) toggleEligible(bowlerId, false); }} aria-label={`Remove unavailable rotating member ${memberById.get(bowlerId)?.name ?? `Bowler ${bowlerId}`}`} />
                <span>{memberById.get(bowlerId)?.name ?? `Bowler ${bowlerId}`} · {fixedMainIds.has(bowlerId) ? "currently assigned to a fixed Main position" : "no longer active on this team"}</span>
              </label>)}
              {activeMembers.length === 0 && <p className="text-sm text-muted-foreground">No active team members are available for the rotating pool.</p>}
            </div>
            {rotatingSlotIndexes.length > 0 && <p className="text-xs text-muted-foreground">{rotatingSlotIndexes.length} rotating position{rotatingSlotIndexes.length === 1 ? "" : "s"} · {draftEligibleIds.size} eligible member{draftEligibleIds.size === 1 ? "" : "s"}</p>}
          </div>}

          <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">Each fixed Main remains on its current fixed payment path. Rotation settings only affect positions marked rotating.</p>
            <Button
              disabled={saveRoster.isPending || configInvalid || (!rosterChanged && !eligibilityChanged)}
              onClick={() => saveRoster.mutate()}
            >{saveRoster.isPending ? "Saving…" : "Save team payment roles"}</Button>
          </div>
          {staleEligibleIds.length > 0 && <p role="alert" className="text-sm text-destructive">Remove inactive, unavailable, or fixed Main bowlers from the rotating pool before saving. Change a Main position to rotating first if that bowler should be eligible.</p>}
          {rotationEnabled && eligibleIds.filter((bowlerId) => activeMembers.some(({ bowler }) => bowler.id === bowlerId)).length === 0 && <p role="alert" className="text-sm text-destructive">Select at least one active team member for the rotating pool.</p>}
          {optInVisible && !rotationEnabled && <p role="status" className="rounded-md border border-warning-500/40 bg-warning-500/5 p-3 text-sm">Choose a paying position and change its role to “Rotating payer” to finish opting in. No fixed Main payer has been changed yet.</p>}
          {rotationAlreadyEnabled && !rotationEnabled && <p className="text-sm text-muted-foreground">Turning off rotation will change positions {team.slots.filter((slot) => slot.occupant === "rotating").map((slot) => slot.slotIndex + 1).join(", ")} to Unassigned in the saved configuration.</p>}
        </>}
      </div></CardContent>
    </Card>

    {rotationAlreadyEnabled && <>
      <Card>
        <CardHeader spacing="tight">
          <CardTitle><span className="flex items-center gap-2"><CalendarDays className="size-5" />Confirm who will bowl</span></CardTitle>
          <CardDescription>Choose a published canonical date, then confirm the bowler for each rotating position. A confirmation can remain unpaid until a later share purchase or staff payment.</CardDescription>
        </CardHeader>
        <CardContent><div className="space-y-4">
          <label className="block max-w-sm space-y-2 text-sm font-medium" htmlFor={`rotation-occurrence-${teamId}`}>League date
            <select
              id={`rotation-occurrence-${teamId}`}
              value={selectedOccurrenceId}
              onChange={(event) => setSelectedOccurrenceId(event.currentTarget.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 font-normal"
            >
              {(roster.occurrences ?? []).map((occurrence) => <option key={occurrence.id} value={occurrence.id}>{occurrence.occurrenceLocalDate} · {occurrence.status === "completed" ? "Completed" : "Scheduled"}</option>)}
            </select>
          </label>
          {selectedOccurrence ? <>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full min-w-180 text-left text-sm">
                <thead className="border-b bg-muted/50"><tr><th className="px-3 py-2 font-medium">Position</th><th className="px-3 py-2 font-medium">Confirmed bowler</th><th className="px-3 py-2 font-medium">Payment status</th><th className="px-3 py-2 font-medium">Correction reason</th></tr></thead>
                <tbody>
                  {normalizedSlots.filter((slot) => slot.occupant === "rotating").map((slot) => {
                    const current = assignmentBySlot.get(slot.slotIndex);
                    const key = getSlotKey(selectedOccurrence.id, slot.slotIndex);
                    const value = assignmentDraft[key] ?? (current?.actualBowlerId == null ? "" : String(current.actualBowlerId));
                    const savedBowlerId = current?.actualBowlerId ?? null;
                    const savedBowlerIsNoLongerSelectable = savedBowlerId !== null
                      && (!eligibleIds.includes(savedBowlerId)
                        || fixedMainIds.has(savedBowlerId)
                        || !activeMembers.some(({ bowler }) => bowler.id === savedBowlerId));
                    const alreadySelectedElsewhere = new Set(normalizedSlots.filter((other) => other.occupant === "rotating" && other.slotIndex !== slot.slotIndex).flatMap((other) => {
                      const otherCurrent = assignmentBySlot.get(other.slotIndex);
                      const otherValue = assignmentDraft[getSlotKey(selectedOccurrence.id, other.slotIndex)] ?? (otherCurrent?.actualBowlerId == null ? "" : String(otherCurrent.actualBowlerId));
                      return otherValue ? [Number(otherValue)] : [];
                    }));
                    const bowlerId = value ? Number(value) : null;
                    const memberRows = bowlerId === null ? [] : teamRows.filter((row) => row.occurrenceId === selectedOccurrence.id && row.actualBowlerId === bowlerId);
                    const memberOutstanding = memberRows.reduce((total, row) => total + row.outstandingMinor, 0);
                    const memberNeedsReview = memberRows.some((row) => row.reviewRequired);
                    const memberPaymentStatus = bowlerId === null
                      ? "No bowler confirmed"
                      : memberRows.length === 0
                        ? "Payment status not yet available"
                        : memberNeedsReview
                          ? "Review required"
                          : memberOutstanding > 0
                            ? `Unpaid · ${money(memberOutstanding)} remaining`
                            : memberRows.some((row) => row.state === "settled")
                              ? "Paid/credited"
                              : "No current collectible balance";
                    return <tr key={slot.slotIndex} className="border-b last:border-b-0">
                      <th scope="row" className="px-3 py-3 font-medium">Position {slot.slotIndex + 1}</th>
                      <td className="px-3 py-3">
                        <select
                          aria-label={`Confirmed bowler for rotating position ${slot.slotIndex + 1}`}
                          value={value}
                          onChange={(event) => {
                            const actualBowlerId = event.currentTarget.value;
                            setAssignmentDraft((draft) => ({ ...draft, [key]: actualBowlerId }));
                          }}
                          className="min-h-10 w-full rounded-md border border-input bg-background px-3 py-2"
                        >
                          <option value="">No bowler confirmed</option>
                          {savedBowlerId !== null && savedBowlerIsNoLongerSelectable && <option value={savedBowlerId} disabled>
                            {memberById.get(savedBowlerId)?.name ?? `Former rotating member · Bowler #${savedBowlerId}`} · no longer eligible
                          </option>}
                          {activeMembers.filter(({ bowler }) => eligibleIds.includes(bowler.id) && !fixedMainIds.has(bowler.id) && (!alreadySelectedElsewhere.has(bowler.id) || bowler.id === current?.actualBowlerId)).map(({ bowler }) => <option key={bowler.id} value={bowler.id}>{bowler.name}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-3"><Badge variant={memberOutstanding > 0 ? "secondary" : memberRows.some((row) => row.state === "settled") ? "default" : "outline"}>{memberPaymentStatus}</Badge></td>
                      <td className="px-3 py-3">{current?.revision != null && value !== String(current.actualBowlerId ?? "") && <Textarea
                        aria-label={`Correction reason for position ${slot.slotIndex + 1}`}
                        value={correctionReasons[key] ?? ""}
                        onChange={(event) => {
                          const reason = event.currentTarget.value;
                          setCorrectionReasons((reasons) => ({ ...reasons, [key]: reason }));
                        }}
                        placeholder="Required when changing a saved confirmation"
                        rows={2}
                        maxLength={500}
                        className="min-w-48"
                      />}</td>
                    </tr>;
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-sm text-muted-foreground">“Confirmed to bowl” is roster information. “Paid/credited” is the separate payment record for that date. The server applies credit after a payment succeeds.</p>
            {duplicateDraftBowler && <p role="alert" className="text-sm text-destructive">A bowler can be confirmed in only one rotating position for this date.</p>}
            {saveAssignments.error && <div role="alert" className="flex flex-col gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-2"><AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" /><span>{isRevisionConflict(saveAssignments.error) ? "The lineup changed since it was loaded. Refresh and review before saving." : apiMessage(saveAssignments.error, "The lineup could not be confirmed.")}</span></div>
          {isRevisionConflict(saveAssignments.error) && <Button variant="outline" size="sm" onClick={async () => { await onReloadRoster(); setAssignmentDraft({}); setCorrectionReasons({}); saveAssignments.reset(); }}>Reload lineup</Button>}
            </div>}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">{pendingAssignments.length ? `${pendingAssignments.length} lineup change${pendingAssignments.length === 1 ? "" : "s"} ready to save.` : "No unsaved lineup changes."}</p>
              <Button disabled={saveAssignments.isPending || pendingAssignments.length === 0 || duplicateDraftBowler || hasMissingCorrectionReason} onClick={() => saveAssignments.mutate()}>
                {saveAssignments.isPending ? "Saving confirmation…" : "Confirm lineup"}
              </Button>
            </div>
          </> : <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">No published canonical league dates are available yet.</p>}
        </div></CardContent>
      </Card>

      <Card>
        <CardHeader spacing="tight">
          <CardTitle><span className="flex items-center gap-2"><CircleDollarSign className="size-5" />Team date balance</span></CardTitle>
          <CardDescription>Current remainder by canonical local date. This balance is separate from who has been confirmed to bowl.</CardDescription>
        </CardHeader>
        <CardContent><div>
          {balanceQuery.isLoading ? <p className="text-sm text-muted-foreground" aria-busy="true">Loading team date balances…</p>
              : balanceQuery.error || balanceQuery.data?.success === false ? <div role="alert" className="flex flex-col gap-3 text-sm sm:flex-row sm:items-center sm:justify-between"><span>{apiMessage(balanceQuery.error, balanceQuery.data?.error?.message ?? "Team date balances could not be loaded.")}</span><Button variant="outline" size="sm" onClick={() => void balanceQuery.refetch()}>Retry</Button></div>
              : remainderByOccurrence.size === 0 ? <p className="text-sm text-muted-foreground">No team-owned rotating obligations are recorded for this team yet.</p>
                : <div className="overflow-x-auto rounded-md border"><table className="w-full min-w-130 text-left text-sm"><thead className="border-b bg-muted/50"><tr><th className="px-3 py-2 font-medium">League date</th><th className="px-3 py-2 font-medium">Balance status</th><th className="px-3 py-2 text-right font-medium">Remaining</th></tr></thead><tbody>
                  {[...remainderByOccurrence.entries()].sort((left, right) => left[1].localDate.localeCompare(right[1].localDate)).map(([occurrenceId, balance]) => <tr key={occurrenceId} className="border-b last:border-b-0"><th scope="row" className="px-3 py-3 font-medium">{balance.localDate}</th><td className="px-3 py-3"><Badge variant={balance.reviewRequired ? "destructive" : balance.outstandingMinor > 0 ? "secondary" : "default"}>{balance.reviewRequired ? "Review required" : balance.outstandingMinor > 0 ? "Unpaid" : balance.rows.some((row) => row.state === "settled") ? "Paid/credited" : "No current collectible balance"}</Badge></td><td className="px-3 py-3 text-right tabular-nums">{money(balance.outstandingMinor)}</td></tr>)}
                </tbody></table></div>}
        </div></CardContent>
      </Card>

      <Card>
        <CardHeader spacing="tight">
          <CardTitle>Record cash or check for a rotating member</CardTitle>
          <CardDescription>Staff records are limited to active members in this team’s saved rotating pool. Review the server quote before recording the tender.</CardDescription>
        </CardHeader>
        <CardContent><div className="space-y-4">
          {savedEligibleMembers.length === 0 ? <p className="text-sm text-muted-foreground">Save an active rotating member pool before recording staff payments.</p> : <>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-2 text-sm font-medium" htmlFor={`manual-rotating-bowler-${teamId}`}>Rotating member
                <select id={`manual-rotating-bowler-${teamId}`} value={manualBowlerId} disabled={manualFormLocked} onChange={(event) => changeManualTarget(event.currentTarget.value)} className="w-full rounded-md border border-input bg-background px-3 py-2 font-normal">
                  <option value="">Choose a member</option>
                  {savedEligibleMembers.map(({ bowler }) => <option key={bowler.id} value={bowler.id}>{bowler.name}</option>)}
                </select>
              </label>
              <label className="space-y-2 text-sm font-medium" htmlFor={`manual-rotating-amount-${teamId}`}>Amount received
                <Input id={`manual-rotating-amount-${teamId}`} inputMode="decimal" autoComplete="off" placeholder="0.00" value={manualAmount} disabled={manualFormLocked} onChange={(event) => changeManualAmount(event.currentTarget.value)} aria-describedby={`manual-rotating-amount-help-${teamId}`} />
                <span id={`manual-rotating-amount-help-${teamId}`} className="block text-xs font-normal text-muted-foreground">Enter dollars and cents. The server confirms the exact amount.</span>
              </label>
              <label className="space-y-2 text-sm font-medium" htmlFor={`manual-rotating-tender-${teamId}`}>Tender
                <select id={`manual-rotating-tender-${teamId}`} value={manualTender} disabled={manualFormLocked} onChange={(event) => changeManualTender(event.currentTarget.value as "cash" | "check")} className="w-full rounded-md border border-input bg-background px-3 py-2 font-normal">
                  <option value="cash">Cash</option>
                  <option value="check">Check</option>
                </select>
              </label>
              {manualTender === "check" && <label className="space-y-2 text-sm font-medium" htmlFor={`manual-rotating-check-${teamId}`}>Check number <span className="text-destructive">*</span>
                <Input id={`manual-rotating-check-${teamId}`} autoComplete="off" maxLength={64} required value={manualCheckNumber} disabled={manualFormLocked} onChange={(event) => changeManualCheckNumber(event.currentTarget.value)} />
              </label>}
              <label className="space-y-2 text-sm font-medium sm:col-span-2" htmlFor={`manual-rotating-notes-${teamId}`}>Notes <span className="font-normal text-muted-foreground">(optional)</span>
                <Textarea id={`manual-rotating-notes-${teamId}`} rows={2} maxLength={500} value={manualNotes} disabled={manualFormLocked} onChange={(event) => changeManualNotes(event.currentTarget.value)} />
              </label>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <Button variant="outline" disabled={!manualBowlerIdValue || manualAmountMinor === null || manualQuoteMutation.isPending || manualFormLocked} onClick={requestManualQuote}>
                {manualQuoteMutation.isPending ? "Getting server quote…" : "Get staff payment quote"}
              </Button>
              {manualAmountMinor === null && manualAmount.trim() !== "" && <p role="alert" className="text-sm text-destructive">Enter a positive amount with no more than two decimal places.</p>}
            </div>
            {manualQuoteMutation.error && <p role="alert" className="text-sm text-destructive">{apiMessage(manualQuoteMutation.error, "Staff payment quote could not be confirmed.")}</p>}
            {manualQuote && manualQuote.bowlerId === manualBowlerIdValue && manualQuote.amountMinor === manualAmountMinor && <div className="space-y-3 rounded-md border bg-muted/30 p-4" aria-live="polite">
              <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="font-medium">Server-confirmed amount</p><p className="text-xs text-muted-foreground">For {memberById.get(manualQuote.bowlerId)?.name ?? "the selected rotating member"}</p></div><p className="text-lg font-semibold tabular-nums">{money(manualQuote.amountMinor)}</p></div>
              <p className="text-xs text-muted-foreground">Expected available credit after record: {money(manualQuote.expectedAvailableAfterPurchaseMinor)}. The date preview is advisory and is not reserved; actual applications are shown after the record succeeds.</p>
              {manualQuote.advisoryApplications.length > 0 ? <ul className="space-y-1 text-sm">{manualQuote.advisoryApplications.map((application) => <li key={`${application.obligationId}-${application.teamId}`} className="flex flex-wrap justify-between gap-x-4"><span>{application.occurrenceLocalDate} · Position {application.slotIndex + 1}</span><span className="tabular-nums">{money(application.amountMinor)}</span></li>)}</ul> : <p className="text-sm text-muted-foreground">No confirmed date currently needs this payment. The full tender amount will remain the member’s personal credit until an eligible date is confirmed.</p>}
              {manualTender === "check" && !manualCheckNumber.trim() && <p role="alert" className="text-sm text-destructive">Enter the check number before recording this payment.</p>}
              <Button disabled={manualFormLocked || manualResult?.status === "succeeded" || (manualTender === "check" && !manualCheckNumber.trim())} onClick={recordManualPayment}>
                {manualRecordMutation.isPending ? "Recording payment…" : `Record ${manualTender} · ${money(manualQuote.amountMinor)}`}
              </Button>
            </div>}
            {manualPostAmbiguous && currentManualCommand && <div role="alert" className="space-y-3 rounded-md border border-destructive/40 p-4 text-sm">
              <p>{apiMessage(manualRecordMutation.error, "The server did not confirm whether this payment was recorded.")} Do not record the same tender again or change its details. Retry the same request to check its status; its idempotency key will be reused.</p>
              <Button variant="outline" disabled={manualRecordMutation.isPending} onClick={retryManualPayment}>
                {manualRecordMutation.isPending ? "Checking payment status…" : `Check or retry same payment · ${money(currentManualCommand.request.amountMinor)}`}
              </Button>
            </div>}
            {manualRecordMutation.error && !manualPostAmbiguous && <p role="alert" className="text-sm text-destructive">{apiMessage(manualRecordMutation.error, "Manual rotating payment could not be recorded. Refresh the quote before recording another payment.")}</p>}
            {manualResult?.status === "succeeded" && <div role="status" className="space-y-3 rounded-md border border-success-500/40 bg-success-500/5 p-4">
              <div><p className="font-medium">Payment recorded · {money(manualResult.fundedMinor)} received</p><p className="text-sm text-muted-foreground">Current available credit: {money(manualResult.balance?.availableMinor ?? 0)}.</p></div>
              {manualResult.applications.length > 0 ? <div><p className="text-sm font-medium">Dates actually paid/credited</p><ul className="mt-2 space-y-1 text-sm">{manualResult.applications.map((application) => <li key={application.applicationId} className="flex flex-wrap justify-between gap-x-4"><span>{application.occurrenceLocalDate} · Position {application.slotIndex + 1}{application.status === "reversed" ? " · reversed" : ""}</span><span className="tabular-nums">{money(application.amountMinor)}</span></li>)}</ul></div> : <p className="text-sm text-muted-foreground">No confirmed date received credit yet; the unused amount remains in the member’s personal available credit.</p>}
            </div>}
          </>}
        </div></CardContent>
      </Card>
    </>}

    <Card>
      <CardHeader spacing="tight">
        <CardTitle>Refund unused rotating credit</CardTitle>
        <CardDescription>Refund only the unused amount from one credit lot. Provider refunds return funds to the original payment method when available. Cash or check refunds must already have been issued outside LeagueVault and need a reference.</CardDescription>
      </CardHeader>
      <CardContent><div className="space-y-4">
        {adminTeamMembersQuery.isLoading ? <p className="text-sm text-muted-foreground" aria-busy="true">Loading team credit members…</p>
          : adminTeamMembersQuery.error || adminTeamMembersQuery.data?.success === false
            ? <div role="alert" className="flex flex-col gap-3 text-sm sm:flex-row sm:items-center sm:justify-between"><span>{apiMessage(adminTeamMembersQuery.error, adminTeamMembersQuery.data?.error?.message ?? "Team credit members could not be loaded.")}</span><Button variant="outline" size="sm" onClick={() => void adminTeamMembersQuery.refetch()}>Retry</Button></div>
            : refundMembers.length === 0 ? <p className="text-sm text-muted-foreground">No current or former rotating-pool members with funded credit are recorded for this team.</p>
              : <>
                <label className="block max-w-xl space-y-2 text-sm font-medium" htmlFor={`rotating-refund-member-${teamId}`}>Member with rotating credit
                  <select
                    id={`rotating-refund-member-${teamId}`}
                    value={refundBowlerId}
                    disabled={refundFormLocked}
                    onChange={(event) => changeRefundBowler(event.currentTarget.value)}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 font-normal"
                  >
                    <option value="">Choose a member</option>
                    {refundMembers.map((member) => <option key={member.bowlerId} value={member.bowlerId}>
                      {member.name} · {member.activeRotationMember ? "current rotating member" : "former rotating member"}
                    </option>)}
                  </select>
                </label>

                {refundBowlerIdValue !== null && <>
                  {refundBalanceQuery.isLoading ? <p className="text-sm text-muted-foreground" aria-busy="true">Loading this member’s credit balance…</p>
                    : refundBalanceQuery.error || refundBalanceQuery.data?.success === false
                      ? <div role="alert" className="flex flex-col gap-3 text-sm sm:flex-row sm:items-center sm:justify-between"><span>{apiMessage(refundBalanceQuery.error, refundBalanceQuery.data?.error?.message ?? "This member’s credit balance could not be loaded.")}</span><Button variant="outline" size="sm" onClick={() => void refundBalanceQuery.refetch()}>Retry</Button></div>
                      : refundBalance && refundLots.length === 0 ? <p className="text-sm text-muted-foreground">No rotating credit funding lots are available for this member.</p>
                        : refundBalance && <div className="space-y-4">
                          <p className="text-sm text-muted-foreground">Available credit: <span className="font-medium tabular-nums text-foreground">{money(refundBalance.availableMinor)}</span> · Refunds held: <span className="tabular-nums">{money(refundBalance.refundHeldMinor)}</span> · Under review: <span className="tabular-nums">{money(refundBalance.reviewHeldMinor)}</span></p>
                          <div className="max-w-xl space-y-2">
                            <label className="block text-sm font-medium" htmlFor={`rotating-refund-lot-${teamId}`}>Credit lot</label>
                            <select
                              id={`rotating-refund-lot-${teamId}`}
                              value={refundFundingId}
                              disabled={refundFormLocked || refundBalanceQuery.isFetching}
                              onChange={(event) => changeRefundFunding(event.currentTarget.value)}
                              aria-describedby={`rotating-refund-lot-help-${teamId}`}
                              className="w-full rounded-md border border-input bg-background px-3 py-2 font-normal"
                            >
                              <option value="">Choose an available lot</option>
                              {refundLots.map((lot, index) => <option key={lot.fundingId} value={lot.fundingId} disabled={lot.availableMinor <= 0}>
                                Credit lot {index + 1} · {money(lot.availableMinor)} available · {creditPaymentTypeLabel(lot.paymentType)}
                                {lot.refundHeldMinor > 0 ? ` · ${money(lot.refundHeldMinor)} held for refund` : ""}
                                {lot.reviewHeldMinor > 0 ? ` · ${money(lot.reviewHeldMinor)} under review` : ""}
                              </option>)}
                            </select>
                            <p id={`rotating-refund-lot-help-${teamId}`} className="text-xs text-muted-foreground">Lots without available credit cannot be selected. Refund holds and review holds remain visible for each lot.</p>
                          </div>

                          {selectedRefundLot && <p className="text-sm" aria-live="polite">
                            Selected lot · {money(selectedRefundLot.availableMinor)} available · {money(selectedRefundLot.refundHeldMinor)} held for refund · {money(selectedRefundLot.reviewHeldMinor)} under review
                          </p>}

                          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                            <Button
                              variant="outline"
                              disabled={!selectedRefundLot || selectedRefundLot.availableMinor <= 0 || refundBalanceQuery.isFetching || refundQuoteMutation.isPending || refundFormLocked}
                              onClick={requestRefundQuote}
                            >{refundQuoteMutation.isPending ? "Getting server quote…" : "Get refund quote"}</Button>
                            {refundQuoteMutation.error && <p role="alert" className="text-sm text-destructive">{apiMessage(refundQuoteMutation.error, "Refund quote could not be confirmed.")}</p>}
                          </div>

                          {refundQuoteMatchesSelection && refundQuote && <div className="space-y-4 rounded-md border bg-muted/30 p-4" aria-live="polite">
                            <div className="flex flex-wrap items-center justify-between gap-3">
                              <div><p className="font-medium">Server-confirmed refund amount</p><p className="text-xs text-muted-foreground">This quote covers only the selected credit lot.</p></div>
                              <p className="text-lg font-semibold tabular-nums">{money(refundQuote.amountMinor)}</p>
                            </div>
                            {!refundQuoteIsCurrent ? <p role="alert" className="text-sm text-destructive">The available balance changed after this quote. Refresh or get a new quote before starting a refund.</p> : <>
                              <label className="block max-w-xl space-y-2 text-sm font-medium" htmlFor={`rotating-refund-kind-${teamId}`}>Refund method
                                <select
                                  id={`rotating-refund-kind-${teamId}`}
                                  value={refundKind}
                                  disabled={refundFormLocked}
                                  onChange={(event) => changeRefundKind(event.currentTarget.value as "provider" | "cash" | "check")}
                                  className="w-full rounded-md border border-input bg-background px-3 py-2 font-normal"
                                >
                                  {refundQuote.providerRefundAvailable && <option value="provider">Return to original provider payment</option>}
                                  <option value="cash">Cash already issued</option>
                                  <option value="check">Check already issued</option>
                                </select>
                              </label>
                              {refundKind !== "provider" && <p className="text-sm text-muted-foreground">Issue the cash or check refund outside LeagueVault first, then record the issued amount here.</p>}
                              <div className="space-y-2">
                                <label className="block text-sm font-medium" htmlFor={`rotating-refund-reason-${teamId}`}>Reason <span aria-hidden="true" className="text-destructive">*</span></label>
                                <Textarea
                                  id={`rotating-refund-reason-${teamId}`}
                                  rows={3}
                                  maxLength={500}
                                  required
                                  disabled={refundFormLocked}
                                  value={refundReason}
                                  onChange={(event) => changeRefundReason(event.currentTarget.value)}
                                  aria-describedby={`rotating-refund-reason-help-${teamId}`}
                                />
                                <p id={`rotating-refund-reason-help-${teamId}`} className="text-xs text-muted-foreground">Required for the refund record. Do not include payment credentials.</p>
                              </div>
                              {refundKind !== "provider" && <div className="max-w-xl space-y-2">
                                <label className="block text-sm font-medium" htmlFor={`rotating-refund-reference-${teamId}`}>Refund reference <span aria-hidden="true" className="text-destructive">*</span></label>
                                <Input
                                  id={`rotating-refund-reference-${teamId}`}
                                  autoComplete="off"
                                  maxLength={255}
                                  required
                                  disabled={refundFormLocked}
                                  value={refundReference}
                                  onChange={(event) => changeRefundReference(event.currentTarget.value)}
                                  aria-describedby={`rotating-refund-reference-help-${teamId}`}
                                />
                                <p id={`rotating-refund-reference-help-${teamId}`} className="text-xs text-muted-foreground">Enter the cash receipt, check number, or other issuance reference.</p>
                              </div>}
                              <Button
                                disabled={refundFormLocked || refundRecordMutation.isPending || refundRequestBase() === null}
                                onClick={recordRefund}
                              >
                                {refundRecordMutation.isPending
                                  ? "Recording refund…"
                                  : refundKind === "provider"
                                    ? `Confirm provider refund · ${money(refundQuote.amountMinor)}`
                                    : `Record issued ${refundKind} refund · ${money(refundQuote.amountMinor)}`}
                              </Button>
                            </>}
                          </div>}
                          {refundPostAmbiguous && refundResult === null && <div role="alert" className="space-y-3 rounded-md border border-destructive/40 p-4 text-sm">
                            <p>{apiMessage(refundRecordMutation.error, "The server did not confirm whether this refund was recorded.")} Do not start another refund. Retry the same request to check its status; its idempotency key will be reused.</p>
                            <Button variant="outline" disabled={refundRecordMutation.isPending} onClick={retryRefund}>
                              {refundRecordMutation.isPending ? "Checking refund status…" : `Check or retry same refund · ${money(currentRefundCommand?.amountMinor ?? 0)}`}
                            </Button>
                          </div>}
                          {refundRecordMutation.error && !refundPostAmbiguous && <p role="alert" className="text-sm text-destructive">{apiMessage(refundRecordMutation.error, "Credit refund could not be recorded. Refresh the balance and get a new quote before starting another refund.")}</p>}
                          {refundResult && <div role={refundResult.status === "action_required" || refundResult.status === "reconciliation_required" || refundResult.status === "failed_terminal" ? "alert" : "status"} className="space-y-3 rounded-md border p-4" aria-live="polite">
                            <div className="flex flex-wrap items-center justify-between gap-3"><p className="font-medium">Refund status · {refundResult.status.replaceAll("_", " ")}</p><p className="font-semibold tabular-nums">{money(refundResult.amountMinor)}</p></div>
                            <p className="text-sm text-muted-foreground">{refundStatusMessage(refundResult.status)}</p>
                            <p className="text-sm">Current available credit: <span className="font-medium tabular-nums">{money(refundResult.balance.availableMinor)}</span> · Refunds held: <span className="tabular-nums">{money(refundResult.balance.refundHeldMinor)}</span> · Under review: <span className="tabular-nums">{money(refundResult.balance.reviewHeldMinor)}</span></p>
                            {refundCanRetry && <Button variant="outline" disabled={refundRecordMutation.isPending} onClick={retryRefund}>
                              {refundRecordMutation.isPending ? "Checking refund status…" : `Check or retry same refund · ${money(refundResult.amountMinor)}`}
                            </Button>}
                            {hasUnresolvedRefund(refundResult.status) && !refundCanRetry && <p className="text-sm font-medium text-warning-700">Do not issue another refund for this request until its status is resolved.</p>}
                          </div>}
                        </div>}
                </>}
        </>}
      </div></CardContent>
    </Card>
  </section>;
}
