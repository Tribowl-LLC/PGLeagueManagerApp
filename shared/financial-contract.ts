/** Public F1 wire contract. Persistence and server error classes stay server-side. */
export const FINANCIAL_READ_CONTRACT_VERSION = "canonical-due-past-due/1" as const;
export const FINANCIAL_READ_ORDER_VERSION = "due-at,bowler,occurrence,obligation/1" as const;
export const FINANCIAL_READ_FINGERPRINT_PREFIX = "lvfinancialread:v1:" as const;
export const FINANCIAL_SOURCE_FINGERPRINT_PREFIX = "lvfinancialsource:v1:" as const;
export const FINANCIAL_ACTIVATION_FINGERPRINT_PREFIX = "lvfinancialactivation:v1:" as const;

export type FinancialReadMode = "canonical" | "legacy_fallback" | "unavailable";
export type FinancialReadClassification = "future" | "due" | "past_due" | "settled" | "voided" | "review_required";
export type FinancialEvidenceSource = "canonical" | "legacy_fallback";
export type FinancialObligationState = "open" | "partially_settled" | "settled" | "voided" | "legacy";
export type FinancialReviewCategory = "refund" | "dispute" | "evidence" | null;
export interface FinancialReadRowContract {
  obligationId: string | null;
  occurrenceId: string | null;
  bowlerId: number;
  teamId: number | null;
  amountMinor: number;
  allocatedMinor: number;
  outstandingMinor: number;
  dueAt: string | null;
  pastDueAt: string | null;
  classification: FinancialReadClassification;
  state: FinancialObligationState;
  evidenceSource: FinancialEvidenceSource;
  reviewRequired: boolean;
  reviewCategory: FinancialReviewCategory;
  incompatibleEvidence: boolean;
  legacyWeekOf: string | null;
  legacyPaidMinor: number | null;
  legacyDueToDateMinor: number | null;
}
export interface FinancialReadTotals {
  amountMinor: number;
  allocatedMinor: number;
  outstandingMinor: number;
  collectiblePastDueMinor: number;
  reviewCount: number;
}
interface FinancialReadBase {
  organizationId: number;
  leagueId: number;
  contractVersion: typeof FINANCIAL_READ_CONTRACT_VERSION;
  orderVersion: typeof FINANCIAL_READ_ORDER_VERSION;
  fingerprint: string;
  rows: FinancialReadRowContract[];
  asOf: string;
  totals: FinancialReadTotals;
  unavailableReason: "not_activated" | "incomplete_evidence" | null;
}
export type FinancialReadContract =
  | (FinancialReadBase & { mode: "canonical"; activationId: string; authoritativeSource: "canonical"; unavailableReason: null; legacyFallback?: never })
  | (FinancialReadBase & { mode: "legacy_fallback"; activationId: null; authoritativeSource: "legacy_helper"; unavailableReason: "not_activated"; legacyFallback: FinancialLegacyFallbackSummary })
  | (FinancialReadBase & { mode: "unavailable"; activationId: null; authoritativeSource: "none"; unavailableReason: "not_activated" | "incomplete_evidence"; legacyFallback?: never });
export interface FinancialReadUnavailableContract extends FinancialReadBase {
  mode: "unavailable";
  activationId: null;
  authoritativeSource: "none";
  unavailableReason: "not_activated" | "incomplete_evidence";
}
export interface FinancialLegacyFallbackSummary {
  helperVersion: "shared-financial-utils/1";
  totalPaidMinor: number;
  amountPastDueMinor: number;
  totalDueToDateMinor: number;
  fullSeasonAmountMinor: number;
  remainingBalanceMinor: number;
  totalWeeksInSeason: number;
}
export interface FinancialOrganizationLeagueReport {
  leagueId: number;
  name: string;
  report: FinancialReadContract;
}
export interface FinancialOrganizationDuePastDueContract {
  contractVersion: typeof FINANCIAL_READ_CONTRACT_VERSION;
  orderVersion: typeof FINANCIAL_READ_ORDER_VERSION;
  organizationId: number;
  authoritativeSource: "per-league-snapshots";
  leagues: FinancialOrganizationLeagueReport[];
}
export interface FinancialActivationSourceRow {
  occurrenceId: string;
  teamId: number;
  teamName: string | null;
  occurrenceKind: "regular" | "makeup" | "position_round" | "rolloff" | "playoff" | "extension";
  occurrenceStatus: "scheduled" | "completed" | "cancelled";
  lifecycle: "published" | "locked";
  occurrenceRevision: number;
  billingTermId: string;
  billingTermVersion: number;
  billingTermRevision: number;
  obligationPolicy: "eligible_bowlers";
  amountMinor: number;
  currency: "USD";
  paymentMode: "weekly" | "upfront";
  occurrenceStartAt: string;
}
export interface FinancialActivationSourceContract {
  contractVersion: typeof FINANCIAL_READ_CONTRACT_VERSION;
  orderVersion: "occurrence-team-slot-bowler/1";
  organizationId: number;
  leagueId: number;
  authoritativeSource: "canonical";
  activationVersion: 1;
  sourceFingerprint: string;
  expected: FinancialActivationSourceRow[];
}
export type FinancialActivationRole = "regular" | "substitute";
export interface FinancialActivationSelection {
  occurrenceId: string;
  teamId: number;
  slotIndex: number;
  bowlerId: number;
  role: FinancialActivationRole;
  provenance: "explicit_admin_selection";
}
export interface FinancialActivationRequestContract {
  commandKey: string;
  sourceFingerprint: string;
  payingLineupSize: 3 | 4;
  responsibilities: FinancialActivationSelection[];
}
export interface FinancialActivationResultContract {
  activationId: string;
  obligationIds: string[];
  requestFingerprint: string;
}
