import type { CanonicalDuePastDueResponseV2, CanonicalDuePastDueRowV2 } from "@shared/roster-payment-contract";
import type { FinancialReadContract } from "@shared/financial-contract";
import type { FinancialReadAccountProjectionRow } from "@shared/financial-contract";

export type FinancialReadRow = {
  obligationId: string | null;
  occurrenceId: string | null;
  bowlerId: number;
  teamId: number | null;
  amountMinor: number;
  allocatedMinor: number;
  grossAllocatedMinor: number;
  refundedMinor: number;
  waivedMinor: number;
  stillOwed: boolean;
  outstandingMinor: number;
  dueAt: string | null;
  pastDueAt: string | null;
  classification: "future" | "due" | "past_due" | "settled" | "voided" | "review_required";
  state: "open" | "partially_settled" | "settled" | "voided";
  evidenceSource: "canonical";
  reviewRequired: boolean;
  reviewCategory: "refund" | "dispute" | "evidence" | null;
  incompatibleEvidence: boolean;
  accountProjection?: CanonicalDuePastDueRowV2["accountProjection"];
};

export type ResolvedFinancialRead =
  | { status: "canonical"; amountPastDue: number; remainingBalance: number; rows: FinancialReadRow[]; ownedAccount?: FinancialReadAccountProjectionRow }
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
    grossAllocatedMinor: row.grossAllocatedMinor ?? row.allocatedMinor,
    refundedMinor: row.refundedMinor ?? 0,
    waivedMinor: row.waivedMinor ?? 0,
    stillOwed: row.stillOwed ?? false,
    outstandingMinor: row.outstandingMinor,
    dueAt: row.dueAt,
    pastDueAt: row.pastDueAt,
    classification: row.classification,
    state: row.state,
    evidenceSource: "canonical",
    reviewRequired: row.reviewRequired,
    reviewCategory: null,
    incompatibleEvidence: false,
    accountProjection: row.accountProjection,
  };
}

export function resolveInteractiveFinancialRead(
  data: CanonicalDuePastDueResponseV2 | FinancialReadContract | undefined,
  bowlerId?: number | null,
): ResolvedFinancialRead {
  if (!data || data.contractVersion !== "canonical-due-past-due/2" || data.authoritativeSource !== "payment_obligations" || !Array.isArray(data.rows) || !data.totals) {
    return { status: "unavailable", amountPastDue: 0, remainingBalance: 0, rows: [] };
  }
  const v2Data: CanonicalDuePastDueResponseV2 = data;
  if (!isSafeMinor(v2Data.totals.collectiblePastDueMinor)) {
    return { status: "unavailable", amountPastDue: 0, remainingBalance: 0, rows: [] };
  }
  let ownedAccount: FinancialReadAccountProjectionRow | undefined;
  if (v2Data.accountProjection !== undefined) {
    const accounts = v2Data.accountProjection.accounts;
    if (v2Data.accountProjection.contractVersion !== "owned-account-projection/1" || !Array.isArray(accounts)) {
      return { status: "unavailable", amountPastDue: 0, remainingBalance: 0, rows: [] };
    }
    const selectedBowlerId = typeof bowlerId === "number" && Number.isSafeInteger(bowlerId) && bowlerId > 0
      ? bowlerId
      : accounts.length === 1 ? accounts[0]?.bowlerId : undefined;
    ownedAccount = selectedBowlerId === undefined ? undefined : accounts.find((account) => account.bowlerId === selectedBowlerId);
    if (!ownedAccount || !isSafeMinor(ownedAccount.amountPaidMinor) || !isSafeMinor(ownedAccount.availableCreditMinor)
      || !isSafeMinor(ownedAccount.confirmedDebtMinor) || !Number.isSafeInteger(ownedAccount.netBalanceMinor)
      || !isSafeMinor(ownedAccount.confirmedPastDueMinor) || !isSafeMinor(ownedAccount.seasonRemainingMinor)
      || typeof ownedAccount.reviewRequired !== "boolean") {
      return { status: "unavailable", amountPastDue: 0, remainingBalance: 0, rows: [] };
    }
    if (v2Data.rows.some((row) => {
      const projection = row.accountProjection;
      return !projection || !isSafeMinor(projection.projectedCreditMinor)
        || (projection.confirmationStatus !== "confirmed" && projection.confirmationStatus !== "forecast")
        || (projection.effectiveDebtorBowlerId !== null
          && (!Number.isSafeInteger(projection.effectiveDebtorBowlerId) || projection.effectiveDebtorBowlerId <= 0));
    })) {
      return { status: "unavailable", amountPastDue: 0, remainingBalance: 0, rows: [] };
    }
  }
  const rows = v2Data.rows.map(toFinancialRow);
  const collectibleRows = rows.filter((row) => isSafeMinor(row.outstandingMinor) && row.outstandingMinor > 0
    && row.state !== "voided"
    && row.state !== "settled"
    && !row.reviewRequired
    && !row.incompatibleEvidence);
  return {
    status: "canonical",
    amountPastDue: ownedAccount?.confirmedPastDueMinor ?? v2Data.totals.collectiblePastDueMinor,
    remainingBalance: ownedAccount?.seasonRemainingMinor ?? collectibleRows.reduce((sum, row) => sum + row.outstandingMinor, 0),
    rows,
    ...(ownedAccount ? { ownedAccount } : {}),
  };
}
