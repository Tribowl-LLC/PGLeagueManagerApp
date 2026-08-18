import type { ApiResponse } from "@shared/schema";
import { csrfFetch } from "@/lib/queryClient";

export interface F3QuoteItem {
  obligationId: string;
  occurrenceId: string;
  bowlerId: number;
  collectionPointOccurrenceId: string;
  amountMinor: number;
  itemIndex: number;
}

export interface F3CanonicalQuote {
  contractVersion: string;
  policy: { id: string; version: number };
  authorization: { id: string; version: number; coveredBowlerIds: number[]; collectionPointOccurrenceIds: string[] };
  items: F3QuoteItem[];
  totalAmountMinor: number;
  fingerprint: string;
}

export async function fetchF3CanonicalQuote(leagueId: number, bowlerId: number, organizationId: number): Promise<F3CanonicalQuote> {
  const response = await csrfFetch(`/api/financials/f3/leagues/${leagueId}/quote?bowlerId=${bowlerId}&organizationId=${organizationId}`);
  const body = await response.json() as ApiResponse<F3CanonicalQuote>;
  if (!response.ok || !body.data) throw new Error(body.error?.message ?? "Canonical auto-pay is unavailable.");
  return body.data;
}

export async function authorizeF3CanonicalPlan(input: {
  leagueId: number;
  organizationId: number;
  payerBowlerId: number;
  policyId: string;
  policyVersion: number;
  authorizationVersion: number;
  coveredBowlerIds: number[];
  collectionPointOccurrenceIds: string[];
  sourceId: string;
}): Promise<unknown> {
  const response = await csrfFetch(`/api/financials/f3/leagues/${input.leagueId}/authorize?organizationId=${input.organizationId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...input, timing: "at_collection_point" }),
  });
  const body = await response.json() as ApiResponse<unknown>;
  if (!response.ok) throw new Error(body.error?.message ?? "Canonical auto-pay authorization could not be saved.");
  return body.data;
}
