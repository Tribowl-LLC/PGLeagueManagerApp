/** Public roster obligation read. Persistence and server error classes stay server-side. */
export const FINANCIAL_READ_CONTRACT_VERSION = "canonical-due-past-due/2" as const;
export const FINANCIAL_READ_ORDER_VERSION = "due-at,payer,occurrence,obligation/2" as const;
export const FINANCIAL_READ_FINGERPRINT_PREFIX = "lvfinancialread:v1:" as const;

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
  outstandingMinor: number;
  classification: FinancialReadClassification;
  reviewRequired: boolean;
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
  asOf: string;
  totals: FinancialReadTotals;
}
export type FinancialReadContract = FinancialReadBase & {
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
