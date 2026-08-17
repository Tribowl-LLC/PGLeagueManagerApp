import type {
  LeagueOccurrenceFoldResolution,
  LeagueOccurrenceKind,
  LeagueOccurrenceLifecycle,
  LeagueOccurrenceRelationshipKind,
  LeagueOccurrenceStatus,
  LeagueScheduleExceptionKind,
} from "./schema/canonical-occurrences";

export const LEAGUE_OCCURRENCE_SCHEDULE_CONTRACT_VERSION = "league-occurrence-schedule/1" as const;
export const LEAGUE_OCCURRENCE_SCHEDULE_ORDER_VERSION = "league-occurrence-schedule-order/1" as const;

export type LeagueOccurrenceScheduleSource = "canonical" | "legacy_fallback";

export type LeagueOccurrenceEffectiveLockReason =
  | "canonical_lock"
  | "start_elapsed"
  | "linked_activity";

export interface LeagueOccurrenceScheduleRelationship {
  relationshipId: string;
  kind: LeagueOccurrenceRelationshipKind;
  role: "source" | "target";
  relatedOccurrenceId: string;
  currentRevision: number;
}

export interface LeagueOccurrenceScheduleBillingSummary {
  purpose: "league_weekly_fee";
  obligationPolicy: "none" | "eligible_bowlers";
  billingOrdinal: number | null;
  version: number;
  currentRevision: number;
}

export interface LeagueOccurrenceScheduleOccurrence {
  /** Canonical UUID when one exists. Legacy projections deliberately have no fabricated identity. */
  occurrenceId: string | null;
  legacyProjectionKey: string | null;
  identitySource: "canonical_uuid" | "legacy_projection";
  kind: LeagueOccurrenceKind;
  status: Exclude<LeagueOccurrenceStatus, "discarded">;
  lifecycle: LeagueOccurrenceLifecycle | "legacy";
  authoritativeLocalDate: string;
  authoritativeLocalStartTime: string | null;
  timezone: string;
  /** UTC ISO instant for canonical rows; legacy projections do not manufacture one. */
  startAt: string | null;
  selectedUtcOffsetMinutes: number | null;
  foldResolution: LeagueOccurrenceFoldResolution | null;
  resolverVersion: string | null;
  plannedOrdinal: number | null;
  competitionNumber: number | null;
  competitive: boolean;
  countsInStandings: boolean;
  currentRevision: number | null;
  effectivelyLocked: boolean;
  effectiveLockReasons: LeagueOccurrenceEffectiveLockReason[];
  billing: LeagueOccurrenceScheduleBillingSummary | null;
  relationships: LeagueOccurrenceScheduleRelationship[];
}

export interface LeagueOccurrenceScheduleSkippedDate {
  exceptionId: string | null;
  kind: LeagueScheduleExceptionKind;
  localDate: string;
  timezone: string;
  reason: string;
  source: "manual" | "legacy_import" | "generator" | "legacy_array";
  lifecycle: "published" | "legacy";
  durableCanonicalException: boolean;
  currentRevision: number | null;
}

export interface LeagueOccurrenceScheduleAdministratorEvidence {
  hasDraftEvidence: boolean;
  hasRejectedEvidence: boolean;
  hasSupersededEvidence: boolean;
  hasRevokedEvidence: boolean;
  c2ReviewAvailable: boolean;
  reviewContractFamily: "fall" | "canonical" | null;
  fallRecoveryEligible: boolean;
  counts: {
    generationRuns: number;
    draftOccurrences: number;
    discardedOccurrences: number;
    draftExceptions: number;
    revokedExceptions: number;
    draftRelationships: number;
    revokedRelationships: number;
    supersededBillingTerms: number;
  };
}

export interface LeagueOccurrenceScheduleReadContract {
  contractVersion: typeof LEAGUE_OCCURRENCE_SCHEDULE_CONTRACT_VERSION;
  ordering: {
    version: typeof LEAGUE_OCCURRENCE_SCHEDULE_ORDER_VERSION;
    keys: readonly [
      "authoritativeLocalDate",
      "authoritativeLocalStartTime",
      "plannedOrdinal",
      "competitionNumber",
      "kind",
      "stableIdentity",
    ];
  };
  organizationId: number;
  leagueId: number;
  authoritativeSource: LeagueOccurrenceScheduleSource;
  operationalCanonicalStateExists: boolean;
  occurrences: LeagueOccurrenceScheduleOccurrence[];
  skippedDates: LeagueOccurrenceScheduleSkippedDate[];
  administrator: LeagueOccurrenceScheduleAdministratorEvidence | null;
}
