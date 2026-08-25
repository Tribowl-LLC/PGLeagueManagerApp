import type { CanonicalDuePastDueResponseV2, CanonicalDuePastDueRowV2 } from "@shared/roster-payment-contract";
import type { FinancialReadContract } from "@shared/financial-contract";

export type FinancialReadRow = {
  obligationId: string | null;
  occurrenceId: string | null;
  bowlerId: number;
  teamId: number | null;
  amountMinor: number;
  allocatedMinor: number;
  outstandingMinor: number;
  dueAt: string | null;
  pastDueAt: string | null;
  classification: "future" | "due" | "past_due" | "settled" | "voided" | "review_required";
  state: "open" | "partially_settled" | "settled" | "voided";
  evidenceSource: "canonical";
  reviewRequired: boolean;
  reviewCategory: "refund" | "dispute" | "evidence" | null;
  incompatibleEvidence: boolean;
};

export type ResolvedFinancialRead =
  | { status: "canonical"; amountPastDue: number; remainingBalance: number; rows: FinancialReadRow[] }
  | { status: "unavailable"; amountPastDue: 0; remainingBalance: 0; rows: [] };

/**
 * Resolves the only financial sources that may drive an interactive checkout.
 * An absent, malformed, unavailable, or incompatible read is deliberately not
 * allowed to fall through to calculateFinancials: the caller must disable the
 * checkout until a versioned read succeeds.
 */
function isSafeMinor(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function toFinancialRow(row: CanonicalDuePastDueRowV2): FinancialReadRow {
  return {
    obligationId: row.id,
    occurrenceId: row.occurrenceId,
    bowlerId: row.payerBowlerId,
    teamId: row.teamId,
    amountMinor: row.amountMinor,
    allocatedMinor: row.allocatedMinor,
    outstandingMinor: row.outstandingMinor,
    dueAt: row.dueAt,
    pastDueAt: row.pastDueAt,
    classification: row.classification,
    state: row.state,
    evidenceSource: "canonical",
    reviewRequired: row.reviewRequired,
    reviewCategory: null,
    incompatibleEvidence: false,
  };
}

export function resolveInteractiveFinancialRead(data: CanonicalDuePastDueResponseV2 | FinancialReadContract | undefined): ResolvedFinancialRead {
  if (!data || data.contractVersion !== "canonical-due-past-due/2" || data.authoritativeSource !== "payment_obligations" || !Array.isArray(data.rows) || !data.totals) {
    return { status: "unavailable", amountPastDue: 0, remainingBalance: 0, rows: [] };
  }
  const v2Data: CanonicalDuePastDueResponseV2 = data;
  if (!isSafeMinor(v2Data.totals.collectiblePastDueMinor)) {
    return { status: "unavailable", amountPastDue: 0, remainingBalance: 0, rows: [] };
  }
  const rows = v2Data.rows.map(toFinancialRow);
  const collectibleRows = rows.filter((row) => isSafeMinor(row.outstandingMinor) && row.outstandingMinor > 0
    && row.state !== "voided"
    && row.state !== "settled"
    && !row.reviewRequired
    && !row.incompatibleEvidence);
  return {
    status: "canonical",
    amountPastDue: v2Data.totals.collectiblePastDueMinor,
    remainingBalance: collectibleRows.reduce((sum, row) => sum + row.outstandingMinor, 0),
    rows,
  };
}
