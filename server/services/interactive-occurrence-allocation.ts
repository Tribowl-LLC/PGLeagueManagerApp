import { eq } from "drizzle-orm";
import { normalizeInteractiveOccurrenceSelections } from "./payment-operation-idempotency.js";
import type { PaymentOperationTransaction } from "../storage/payment-operations.js";
import { db } from "../db.js";
import { leagues, type PaymentOperation } from "@shared/schema";

/** PR1 exact-obligation boundary. The former F2/D2 occurrence supplement is
 * retired with migration 0032; these pure exports remain for compatibility
 * with request validation, while every database operation fails closed. */
export const INTERACTIVE_OCCURRENCE_QUOTE_CONTRACT = "interactive-obligation-quote/1" as const;
export const INTERACTIVE_OCCURRENCE_QUOTE_ORDER = "due-at,bowler,occurrence,obligation/1" as const;
export type InteractiveOccurrenceSelection = { obligationId: string; amountMinor: number };
export type InteractiveOccurrenceQuoteRow = {
  obligationId: string; occurrenceId: string; bowlerId: number; amountMinor: number;
  allocatedMinor: number; outstandingMinor: number; currency: string; dueAt: string | null;
  disposition?: "available" | "reserved_by_ready_autopay_plan";
};
export type InteractiveOccurrenceQuote = {
  contractVersion: typeof INTERACTIVE_OCCURRENCE_QUOTE_CONTRACT;
  orderVersion: typeof INTERACTIVE_OCCURRENCE_QUOTE_ORDER;
  organizationId: number; leagueId: number; currency: string; amountMinor: number;
  activationId: string; activationSourceFingerprint: string; rows: InteractiveOccurrenceQuoteRow[];
  reservedByReadyAutopayPlan?: Array<{ obligationId: string; amountMinor: number; disposition: "reserved_by_ready_autopay_plan" }>;
  selections: InteractiveOccurrenceSelection[]; fingerprint: string;
};

export class InteractiveOccurrenceAllocationError extends Error {
  constructor(public readonly code: string, message = "Exact roster obligations are required") {
    super(message);
    this.name = "InteractiveOccurrenceAllocationError";
  }
}

export function validateInteractiveOccurrenceBaseAllocations(
  occurrenceAllocations: Array<{ bowlerId: number; amountMinor: number }>,
  baseAllocations: Array<{ bowlerId: number; amountMinor: number }>,
): void {
  const totals = (rows: Array<{ bowlerId: number; amountMinor: number }>) => {
    const result = new Map<number, number>();
    for (const row of rows) result.set(row.bowlerId, (result.get(row.bowlerId) ?? 0) + row.amountMinor);
    return result;
  };
  const selected = totals(occurrenceAllocations);
  const base = totals(baseAllocations);
  if (selected.size !== base.size || [...base].some(([bowlerId, amountMinor]) => selected.get(bowlerId) !== amountMinor)) {
    throw new InteractiveOccurrenceAllocationError("BASE_ALLOCATION_MISMATCH");
  }
}

export function validateInteractiveOccurrenceSelections(
  rows: Array<{ obligationId: string; outstandingMinor: number }>,
  selections: InteractiveOccurrenceSelection[],
  amountMinor: number,
): void {
  const byId = new Map(rows.map((row) => [row.obligationId, row]));
  const seen = new Set<string>();
  let total = 0;
  for (const selection of selections) {
    const row = byId.get(selection.obligationId);
    if (!row || seen.has(selection.obligationId) || !Number.isSafeInteger(selection.amountMinor) || selection.amountMinor <= 0 || selection.amountMinor > row.outstandingMinor) {
      throw new InteractiveOccurrenceAllocationError("INVALID_SELECTION");
    }
    seen.add(selection.obligationId);
    total += selection.amountMinor;
  }
  if (selections.length > 0 && total !== amountMinor) throw new InteractiveOccurrenceAllocationError("AMOUNT_MISMATCH");
}

export function hasReadyAutopayReservationConflict(
  rows: Array<{ obligationId: string; outstandingMinor: number; f3ReservedMinor: number }>,
  selections: InteractiveOccurrenceSelection[],
): boolean {
  const byId = new Map(rows.map((row) => [row.obligationId, row]));
  return selections.some((selection) => {
    const row = byId.get(selection.obligationId);
    return row !== undefined && row.f3ReservedMinor > 0 && selection.amountMinor > row.outstandingMinor;
  });
}

export { normalizeInteractiveOccurrenceSelections };

function retired(): never {
  throw new InteractiveOccurrenceAllocationError("PR1_EXACT_OBLIGATIONS_ONLY", "Occurrence allocation supplements are retired; select exact roster obligations");
}

export async function getInteractiveOccurrenceActivation(_input: { organizationId: number; leagueId: number }): Promise<boolean> {
  const [league] = await db.select({ payingLineupSize: leagues.payingLineupSize }).from(leagues).where(eq(leagues.id, _input.leagueId)).limit(1);
  return league?.payingLineupSize != null;
}

export async function quoteInteractiveOccurrenceAllocations(_input: {
  organizationId: number; leagueId: number; amountMinor: number; currency: string;
  selections?: InteractiveOccurrenceSelection[]; allowedBowlerIds?: number[]; excludeOperationId?: string;
}): Promise<InteractiveOccurrenceQuote> {
  return retired();
}

export async function persistInteractiveOccurrenceSnapshot(
  _tx: PaymentOperationTransaction,
  _operation: PaymentOperation,
  _input: { leagueId?: number; selections: InteractiveOccurrenceSelection[]; quoteFingerprint: string; baseAllocations?: Array<{ bowlerId: number; amountMinor: number }> },
): Promise<void> {
  return retired();
}

export async function validateInteractiveOccurrenceReplay(_input: {
  operationId: string; organizationId: number; leagueId: number; amountMinor: number;
  currency: string; selections?: InteractiveOccurrenceSelection[];
}): Promise<void> {
  return retired();
}
