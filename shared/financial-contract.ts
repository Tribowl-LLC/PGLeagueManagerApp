/** Public roster obligation read. Persistence and server error classes stay server-side. */
export const FINANCIAL_READ_CONTRACT_VERSION = "canonical-due-past-due/2" as const;
export const FINANCIAL_READ_ORDER_VERSION = "due-at,payer,occurrence,obligation/2" as const;
export const FINANCIAL_READ_FINGERPRINT_PREFIX = "lvfinancialread:v1:" as const;
export const FINANCIAL_READ_CONTRACT_VERSION_V3 = "canonical-due-past-due/3" as const;
export const FINANCIAL_READ_ORDER_VERSION_V3 = "due-at,owner,occurrence,obligation/3" as const;
export const FINANCIAL_ACCOUNT_PROJECTION_CONTRACT = "owned-account-projection/1" as const;

export type FinancialReadMode = "canonical";
export type FinancialReadClassification = "future" | "due" | "past_due" | "settled" | "voided" | "review_required";
export type FinancialEvidenceSource = "canonical";
export type FinancialObligationState = "open" | "partially_settled" | "settled" | "voided";
export type FinancialReviewCategory = "refund" | "dispute" | "evidence" | null;
export interface FinancialReadRowContract {
  id: string;
  organizationId: number;
  leagueId: number;
  occurrenceId: string;
  responsibilityId: string;
  teamId: number;
  component: "full" | "lineage" | "prize";
  payerBowlerId: number;
  amountMinor: number;
  currency: "USD";
  dueAt: string;
  pastDueAt: string;
  state: "open" | "partially_settled" | "settled" | "voided";
  allocatedMinor: number;
  /** Historical active allocation total, including refunded tenders. */
  grossAllocatedMinor: number;
  refundedMinor: number;
  waivedMinor: number;
  stillOwed: boolean;
  outstandingMinor: number;
  classification: FinancialReadClassification;
  reviewRequired: boolean;
  accountProjection?: FinancialReadRowAccountProjection;
}

export type FinancialObligationOwner =
  | { kind: "bowler"; bowlerId: number }
  | { kind: "team"; teamId: number };

/** Additive evidence present only after a league adopts owned-account accounting. */
export interface FinancialReadAccountProjectionRow {
  bowlerId: number;
  /** Verified incoming owned receipts, net of completed refunds. */
  amountPaidMinor: number;
  availableCreditMinor: number;
  confirmedDebtMinor: number;
  /** Actual account balance: available owned credit minus confirmed debt. */
  netBalanceMinor: number;
  confirmedPastDueMinor: number;
  /** Active confirmed debt and forecasts after safe projected credit coverage. */
  seasonRemainingMinor: number;
  reviewRequired: boolean;
}

export interface FinancialReadAccountProjection {
  contractVersion: typeof FINANCIAL_ACCOUNT_PROJECTION_CONTRACT;
  accounts: FinancialReadAccountProjectionRow[];
}

/** Projected coverage stays separate from actual payment allocations. */
export interface FinancialReadRowAccountProjection {
  /** Canonical obligation owner; this can be a team even when a bowler is the current debtor. */
  owner: FinancialObligationOwner;
  effectiveDebtorBowlerId: number | null;
  confirmationStatus: "confirmed" | "forecast";
  projectedCreditMinor: number;
}

/** Owner-aware due row used by rotating teams. The historic tender payer is
 * retained separately and may be null on a newly-created team obligation. */
export interface FinancialReadRowContractV3 extends Omit<FinancialReadRowContract, "payerBowlerId"> {
  payerBowlerId: number | null;
  owner: FinancialObligationOwner;
  slotIndex: number | null;
  responsibilityKind: "main" | "substitute" | "split" | "vacant" | "rotating" | "worksheet";
  actualBowlerId: number | null;
  occurrenceLocalDate: string;
  plannedOrdinal: number;
  billingOrdinal: number;
}
export interface FinancialReadTotals {
  amountMinor: number;
  allocatedMinor: number;
  outstandingMinor: number;
  collectiblePastDueMinor: number;
  reviewCount: number;
  settledCount: number;
  voidedCount: number;
}
interface FinancialReadBase {
  organizationId: number;
  leagueId: number;
  contractVersion: typeof FINANCIAL_READ_CONTRACT_VERSION;
  orderVersion: typeof FINANCIAL_READ_ORDER_VERSION;
  rows: FinancialReadRowContract[];
  accountProjection?: FinancialReadAccountProjection;
  asOf: string;
  totals: FinancialReadTotals;
}
export type FinancialReadContract = FinancialReadBase & {
  authoritativeSource: "payment_obligations";
  mode?: never;
};
export type FinancialReadContractV3 = Omit<FinancialReadBase, "contractVersion" | "orderVersion" | "rows"> & {
  contractVersion: typeof FINANCIAL_READ_CONTRACT_VERSION_V3;
  orderVersion: typeof FINANCIAL_READ_ORDER_VERSION_V3;
  rows: FinancialReadRowContractV3[];
  accountProjection?: FinancialReadAccountProjection;
  authoritativeSource: "payment_obligations";
  mode?: never;
};
export interface FinancialOrganizationLeagueReport {
  leagueId: number;
  name: string;
  report: FinancialReadContract;
}
export interface FinancialOrganizationDuePastDueContract {
  contractVersion: typeof FINANCIAL_READ_CONTRACT_VERSION;
  orderVersion: typeof FINANCIAL_READ_ORDER_VERSION;
  organizationId: number;
  authoritativeSource: "payment_obligations";
  leagues: FinancialOrganizationLeagueReport[];
}
