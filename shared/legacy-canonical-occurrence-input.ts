import {
  type BillingOrdinalPolicy,
  type CanonicalOccurrenceGeneratorInput,
  type CanonicalWeekday,
  type RegularSessionBillingPolicy,
} from "./canonical-occurrence-generator";
import { type AmbiguousFoldPolicy } from "./canonical-dst-resolver";

export interface CanonicalLegacyLeagueRow {
  league_id: number;
  organization_id: number | null;
  location_id: number | null;
  location_organization_id: number | null;
  season_start: string | null;
  season_end: string | null;
  week_day: string | null;
  competition_start_time: string | null;
  timezone: string | null;
  total_bowling_weeks: number | null;
  weekly_fee: number | null;
  skip_dates: string[] | null;
  cancelled_dates: string[] | null;
  double_pay_dates: string[] | null;
}

export interface CanonicalLegacyOperatorSemantics {
  organizationId: number;
  leagueId: number;
  sourceScheduleRevision: number;
  ambiguousFold: AmbiguousFoldPolicy;
  currency: string | null;
  regularSessionBillingPolicy: RegularSessionBillingPolicy | null;
  billingOrdinalPolicy: BillingOrdinalPolicy | null;
}

function dateOnly(value: string | null): string | null {
  return value && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

function isCanonicalWeekday(value: string | null): value is CanonicalWeekday {
  return value === "Sunday"
    || value === "Monday"
    || value === "Tuesday"
    || value === "Wednesday"
    || value === "Thursday"
    || value === "Friday"
    || value === "Saturday";
}

export function createCanonicalGeneratorInputFromLegacyRow(
  row: CanonicalLegacyLeagueRow,
  args: CanonicalLegacyOperatorSemantics,
): CanonicalOccurrenceGeneratorInput | { failure: string } {
  const missing: string[] = [];
  const locationId = row.location_id;
  const seasonStart = dateOnly(row.season_start);
  const seasonEnd = dateOnly(row.season_end);
  const weekday = row.week_day;
  const competitionStartTime = row.competition_start_time;
  const timezone = row.timezone;
  const plannedSlotCount = row.total_bowling_weeks;
  const defaultWeeklyAmountMinor = args.regularSessionBillingPolicy === "none" && row.weekly_fee === null
    ? 0
    : row.weekly_fee;
  if (row.organization_id !== args.organizationId) missing.push("organizationId");
  if (row.league_id !== args.leagueId) missing.push("leagueId");
  if (locationId === null || row.location_organization_id !== args.organizationId) missing.push("tenant-scoped location");
  if (!seasonStart) missing.push("seasonStart");
  if (!seasonEnd) missing.push("seasonEnd");
  if (!isCanonicalWeekday(weekday)) missing.push("weekday");
  if (!competitionStartTime) missing.push("competitionStartTime");
  if (!timezone) missing.push("timezone");
  if (!Number.isSafeInteger(plannedSlotCount) || (plannedSlotCount ?? 0) <= 0) missing.push("totalBowlingWeeks");
  if (args.regularSessionBillingPolicy === "eligible_bowlers"
    && (!Number.isSafeInteger(defaultWeeklyAmountMinor) || (defaultWeeklyAmountMinor ?? 0) <= 0)) {
    missing.push("defaultWeeklyAmountMinor");
  }
  if (args.regularSessionBillingPolicy === "none"
    && defaultWeeklyAmountMinor !== null
    && (!Number.isSafeInteger(defaultWeeklyAmountMinor) || defaultWeeklyAmountMinor < 0)) {
    missing.push("defaultWeeklyAmountMinor");
  }
  if (!args.currency) missing.push("explicit currency flag");
  if (!args.regularSessionBillingPolicy) missing.push("explicit regularSessionBillingPolicy flag");
  if (!args.billingOrdinalPolicy) missing.push("explicit billingOrdinalPolicy flag");
  if (missing.length > 0) return { failure: `incomplete authoritative input: ${missing.join(", ")}` };
  if (locationId === null || !seasonStart || !seasonEnd || !isCanonicalWeekday(weekday) || !competitionStartTime || !timezone || plannedSlotCount === null || defaultWeeklyAmountMinor === null || args.currency === null || args.regularSessionBillingPolicy === null || args.billingOrdinalPolicy === null) {
    return { failure: "incomplete authoritative input" };
  }
  return {
    organizationId: args.organizationId,
    leagueId: args.leagueId,
    locationId,
    sourceScheduleRevision: args.sourceScheduleRevision,
    seasonStart,
    seasonEnd,
    weekday,
    localCompetitionStartTime: competitionStartTime,
    timezone,
    plannedSlotCount,
    skipExceptions: (row.skip_dates ?? []).map((localDate, index) => ({
      kind: "skip" as const,
      localDate,
      reason: "Legacy league skip date explicitly retained for canonical generation",
      source: "legacy_import" as const,
      lifecycleIntent: "draft" as const,
      generationRunAssociationIntent: "associate" as const,
      candidateReference: `legacy-skip-${index + 1}-${localDate}`,
    })),
    cancelledDates: row.cancelled_dates ?? [],
    ambiguousFold: args.ambiguousFold,
    defaultWeeklyAmountMinor,
    currency: args.currency,
    regularSessionBillingPolicy: args.regularSessionBillingPolicy,
    billingOrdinalPolicy: args.billingOrdinalPolicy,
    specialSessionBehavior: { mode: "regular_only", version: "1" },
  };
}

export function buildLegacyDoublePayEvidence(row: CanonicalLegacyLeagueRow): Record<string, unknown> {
  return {
    source: "leagues.double_pay_dates",
    doublePayDates: [...(row.double_pay_dates ?? [])].sort(),
    excludedFromGeneratorInput: true,
    excludedFromFingerprintAndBillingCandidates: true,
  };
}
