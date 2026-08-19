import type { ApiResponse } from "@shared/schema";
import { f3PreauthorizationQuoteSchema, f3ReadyPlanSchema, type F3PreauthorizationQuote, type F3QuoteItem, type F3ReadyPlan } from "@shared/f3-autopay-contract";
import { csrfFetch } from "@/lib/queryClient";
import type { QueryClient } from "@tanstack/react-query";

export const f3PrequoteQueryKey = (leagueId: number, organizationId: number, bowlerId: number, coveredBowlerIds: number[]) => ["f3-prequote", leagueId, organizationId, bowlerId, coveredBowlerIds.join(",")];
export const f3ReadyPlanQueryKey = (leagueId: number, organizationId: number, bowlerId: number) => ["f3-ready-plan", leagueId, organizationId, bowlerId];
export function invalidateF3AfterInteractivePayment(queryClient: Pick<QueryClient, "invalidateQueries">, leagueId: number, organizationId?: number | null) {
  void queryClient.invalidateQueries({ queryKey: ["f3-prequote", leagueId] });
  void queryClient.invalidateQueries({ queryKey: ["f3-ready-plan", leagueId] });
  void queryClient.invalidateQueries({ queryKey: ["/api/payments"] });
  if (organizationId !== undefined) void queryClient.invalidateQueries({ queryKey: ["/api/payments", { organizationId, leagueId }] });
}

export async function fetchF3CanonicalQuote(leagueId: number, bowlerId: number, organizationId: number): Promise<F3ReadyPlan> {
  const response = await csrfFetch(`/api/financials/f3/leagues/${leagueId}/quote?bowlerId=${bowlerId}&organizationId=${organizationId}`);
  const body = await response.json() as ApiResponse<unknown>;
  if (!response.ok) { const error = new Error(body.error?.message ?? "Canonical auto-pay is unavailable.") as Error & { code?: string }; error.code = body.error?.code; throw error; }
  if (!body.data) { const error = new Error("Persisted canonical plan evidence is incomplete.") as Error & { code?: string }; error.code = "PLAN_EVIDENCE_INCONSISTENT"; throw error; }
  const parsed = f3ReadyPlanSchema.safeParse(body.data);
  if (!parsed.success) { const error = new Error("Persisted canonical plan evidence is inconsistent.") as Error & { code?: string }; error.code = "PLAN_EVIDENCE_INCONSISTENT"; throw error; }
  return parsed.data;
}

export async function revokeF3CanonicalPlan(input: { leagueId: number; organizationId: number; authorizationId: string }): Promise<void> {
  const response = await csrfFetch(`/api/financials/f3/leagues/${input.leagueId}/authorize/${input.authorizationId}/revoke?organizationId=${input.organizationId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const body = await response.json() as ApiResponse<unknown>;
  if (!response.ok) { const error = new Error(body.error?.message ?? "Automatic payment plan could not be cancelled.") as Error & { code?: string }; error.code = body.error?.code; throw error; }
}

export async function fetchF3PreauthorizationQuote(leagueId: number, bowlerId: number, organizationId: number, coveredBowlerIds: number[]): Promise<F3PreauthorizationQuote> {
  const response = await csrfFetch(`/api/financials/f3/leagues/${leagueId}/prequote?bowlerId=${bowlerId}&organizationId=${organizationId}&coveredBowlerIds=${coveredBowlerIds.join(",")}`);
  const body = await response.json() as ApiResponse<F3PreauthorizationQuote>;
  if (!response.ok) { const error = new Error(body.error?.message ?? "Canonical auto-pay quote is unavailable.") as Error & { code?: string }; error.code = body.error?.code; throw error; }
  const parsed = f3PreauthorizationQuoteSchema.safeParse(body.data);
  if (!parsed.success) { const error = new Error("Canonical preauthorization evidence is inconsistent.") as Error & { code?: string }; error.code = "PREAUTHORIZATION_EVIDENCE_INCONSISTENT"; throw error; }
  return parsed.data;
}

export async function authorizeF3CanonicalPlan(input: {
  leagueId: number;
  organizationId: number;
  payerBowlerId: number;
  policyId: string;
  policyVersion: number;
  authorizationVersion: number;
  coveredBowlerIds: number[];
  acceptedPartnerIds: number[];
  collectionPointOccurrenceIds: string[];
  sourceId: string;
  preauthorizationFingerprint: string;
  authorizedItems: F3QuoteItem[];
  commandKey: string;
}): Promise<unknown> {
  const response = await csrfFetch(`/api/financials/f3/leagues/${input.leagueId}/authorize?organizationId=${input.organizationId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...input, timing: "at_collection_point" }),
  });
  const body = await response.json() as ApiResponse<unknown>;
  if (!response.ok) { const error = new Error(body.error?.message ?? "Canonical auto-pay authorization could not be saved.") as Error & { code?: string }; error.code = body.error?.code; throw error; }
  return body.data;
}
