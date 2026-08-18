import { FINANCIAL_READ_CONTRACT_VERSION, type FinancialReadContract, type FinancialReadRowContract } from "@shared/financial-contract";

export type FinancialReadRow = FinancialReadRowContract;

export type ResolvedFinancialRead =
  | { status: "legacy_fallback"; amountPastDue: number; remainingBalance: number; rows: FinancialReadRow[] }
  | { status: "canonical"; amountPastDue: number; remainingBalance: number; rows: FinancialReadRow[] }
  | { status: "unavailable"; amountPastDue: 0; remainingBalance: 0; rows: [] };

/**
 * Resolves the only financial sources that may drive an interactive checkout.
 * An absent, malformed, unavailable, or incompatible read is deliberately not
 * allowed to fall through to calculateFinancials: the caller must disable the
 * checkout until a versioned read succeeds.
 */
export function resolveInteractiveFinancialRead(data: FinancialReadContract | undefined): ResolvedFinancialRead {
  if (!data || data.contractVersion !== FINANCIAL_READ_CONTRACT_VERSION) {
    return { status: "unavailable", amountPastDue: 0, remainingBalance: 0, rows: [] };
  }

  if (data.mode === "legacy_fallback") {
    const fallback = data.legacyFallback;
    if (!fallback || !isNonnegativeSafeInteger(fallback.amountPastDueMinor) || !isNonnegativeSafeInteger(fallback.remainingBalanceMinor)) {
      return { status: "unavailable", amountPastDue: 0, remainingBalance: 0, rows: [] };
    }
    return {
      status: "legacy_fallback",
      amountPastDue: fallback.amountPastDueMinor,
      remainingBalance: fallback.remainingBalanceMinor,
      rows: data.rows ?? [],
    };
  }

  if (data.mode !== "canonical" || !data.rows || !data.totals || !isNonnegativeSafeInteger(data.totals.collectiblePastDueMinor)) {
    return { status: "unavailable", amountPastDue: 0, remainingBalance: 0, rows: [] };
  }

  const collectibleRows = data.rows.filter((row) => isNonnegativeSafeInteger(row.outstandingMinor) && row.outstandingMinor > 0
    && row.state !== "voided"
    && row.state !== "settled"
    && !row.reviewRequired
    && !row.incompatibleEvidence);
  return {
    status: "canonical",
    amountPastDue: data.totals.collectiblePastDueMinor,
    remainingBalance: collectibleRows.reduce((sum, row) => sum + row.outstandingMinor, 0),
    rows: data.rows,
  };
}

function isNonnegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
