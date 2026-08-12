import { createHash } from "node:crypto";
import { resolveCanonicalLocalDateTime } from "./canonical-dst-resolver";
import { canonicalJsonStringify, extractStoredDateOnly } from "./completed-summer-comparator";

export const OCCURRENCE_COMPATIBILITY_CONTRACT_VERSION = "canonical-occurrence-compatibility/1" as const;
export const OCCURRENCE_COMPATIBILITY_FINGERPRINT_VERSION = "canonical-occurrence-compatibility-fingerprint/1" as const;

export const OCCURRENCE_COMPATIBILITY_CLASSIFICATIONS = [
  "exact_match",
  "canonical_state_absent",
  "canonical_not_published",
  "no_match",
  "ambiguous_match",
  "legacy_number_mismatch",
  "legacy_date_or_start_mismatch",
  "ineligible_occurrence_state",
  "cross_tenant_or_cross_league_reference",
] as const;

export type OccurrenceCompatibilityClassification =
  (typeof OCCURRENCE_COMPATIBILITY_CLASSIFICATIONS)[number];
export type OccurrenceCompatibilitySubject = "game" | "payment_schedule" | "scheduled_operation";

export interface OccurrenceCompatibilityCandidate {
  id: string;
  organizationId: number;
  leagueId: number;
  authoritativeLocalDate: string;
  authoritativeLocalStartTime: string;
  timezone: string;
  startAt: string;
  foldResolution: "unambiguous" | "earlier" | "later";
  competitionNumber: number | null;
  lifecycle: "draft" | "published" | "locked";
  status: "scheduled" | "cancelled" | "completed" | "discarded";
}

interface CompatibilityState {
  canonicalStatePresent: boolean;
  publishedStatePresent: boolean;
  referencedOccurrenceInScope: boolean | null;
}

export type OccurrenceCompatibilityInput = CompatibilityState & {
  organizationId: number;
  leagueId: number;
  existingReferenceId?: string | null;
  candidates: readonly OccurrenceCompatibilityCandidate[];
} & (
  | {
    subject: "game";
    legacyCompetitionNumber: number;
    legacyTimestamp: string;
    duplicateLegacyKey: boolean;
  }
  | {
    subject: "payment_schedule";
    legacyStartAt: string;
    immediateUpfront: boolean;
    eligibilityNow: string;
  }
  | {
    subject: "scheduled_operation";
    legacyStartAt: string;
  }
);

export interface OccurrenceCompatibilityResult {
  contractVersion: typeof OCCURRENCE_COMPATIBILITY_CONTRACT_VERSION;
  fingerprintVersion: typeof OCCURRENCE_COMPATIBILITY_FINGERPRINT_VERSION;
  subject: OccurrenceCompatibilitySubject;
  organizationId: number;
  leagueId: number;
  classification: OccurrenceCompatibilityClassification;
  occurrenceId: string | null;
  legacy: {
    localDate: string | null;
    startAt: string | null;
    competitionNumber: number | null;
    meaningfulSessionTime: boolean;
  };
  evidence: {
    candidateCount: number;
    eligibleCandidateCount: number;
    duplicateLegacyKey: boolean;
    reason: string;
  };
  fingerprint: string;
}

interface ParsedLegacyTimestamp {
  localDate: string | null;
  localTime: string | null;
  explicitStartAt: string | null;
  meaningfulSessionTime: boolean;
}

export function normalizeCompatibilityInstant(value: string): string | null {
  const includesZone = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(value);
  const parsed = new Date(includesZone ? value : `${value.replace(" ", "T")}Z`);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function parseLegacyGameTimestamp(value: string): ParsedLegacyTimestamp {
  const localDate = extractStoredDateOnly(value);
  const timeMatch = /^\d{4}-\d{2}-\d{2}[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?/.exec(value);
  if (!timeMatch) {
    return { localDate, localTime: null, explicitStartAt: null, meaningfulSessionTime: false };
  }
  const localTime = `${timeMatch[1]}:${timeMatch[2]}:${timeMatch[3] ?? "00"}`;
  const meaningfulSessionTime = localTime !== "00:00:00";
  const hasExplicitZone = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(value);
  return {
    localDate,
    localTime,
    explicitStartAt: meaningfulSessionTime && hasExplicitZone ? normalizeCompatibilityInstant(value) : null,
    meaningfulSessionTime,
  };
}

function candidateStartMatchesLegacy(
  candidate: OccurrenceCompatibilityCandidate,
  parsed: ParsedLegacyTimestamp,
): boolean {
  if (!parsed.meaningfulSessionTime) return true;
  const candidateStart = normalizeCompatibilityInstant(candidate.startAt);
  if (candidateStart === null) return false;
  if (parsed.explicitStartAt !== null) return parsed.explicitStartAt === candidateStart;
  if (parsed.localDate === null || parsed.localTime === null) return false;
  try {
    const resolved = resolveCanonicalLocalDateTime({
      localDate: parsed.localDate,
      localTime: parsed.localTime,
      timezone: candidate.timezone,
      ambiguousFold: candidate.foldResolution === "unambiguous" ? "reject" : candidate.foldResolution,
    });
    return resolved.startAt === candidateStart;
  } catch {
    return false;
  }
}

function fingerprint(result: Omit<OccurrenceCompatibilityResult, "fingerprint">): string {
  const { occurrenceId: _randomOccurrenceId, ...semanticResult } = result;
  return createHash("sha256")
    .update(canonicalJsonStringify(semanticResult), "utf8")
    .digest("hex");
}

function result(
  input: OccurrenceCompatibilityInput,
  classification: OccurrenceCompatibilityClassification,
  occurrenceId: string | null,
  legacy: OccurrenceCompatibilityResult["legacy"],
  eligibleCandidateCount: number,
  reason: string,
): OccurrenceCompatibilityResult {
  const withoutFingerprint: Omit<OccurrenceCompatibilityResult, "fingerprint"> = {
    contractVersion: OCCURRENCE_COMPATIBILITY_CONTRACT_VERSION,
    fingerprintVersion: OCCURRENCE_COMPATIBILITY_FINGERPRINT_VERSION,
    subject: input.subject,
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    classification,
    occurrenceId,
    legacy,
    evidence: {
      candidateCount: Math.min(input.candidates.length, 3),
      eligibleCandidateCount: Math.min(eligibleCandidateCount, 3),
      duplicateLegacyKey: input.subject === "game" && input.duplicateLegacyKey,
      reason,
    },
  };
  return { ...withoutFingerprint, fingerprint: fingerprint(withoutFingerprint) };
}

function stateClassification(input: OccurrenceCompatibilityInput): OccurrenceCompatibilityClassification {
  return input.canonicalStatePresent
    ? input.publishedStatePresent ? "no_match" : "canonical_not_published"
    : "canonical_state_absent";
}

function referenceConflicts(input: OccurrenceCompatibilityInput): boolean {
  return input.existingReferenceId != null && input.referencedOccurrenceInScope !== true;
}

/**
 * Pure D1 comparator. Candidate loading is tenant-scoped by the server wrapper;
 * this function performs no proximity, amount, roster, random, locale, or host-
 * timezone inference.
 */
export function compareCanonicalOccurrenceCompatibility(
  input: OccurrenceCompatibilityInput,
): OccurrenceCompatibilityResult {
  if (referenceConflicts(input)) {
    return result(input, "cross_tenant_or_cross_league_reference", null, {
      localDate: null, startAt: null, competitionNumber: null, meaningfulSessionTime: false,
    }, 0, "stored_reference_is_outside_scope");
  }

  if (input.subject === "game") {
    const parsed = parseLegacyGameTimestamp(input.legacyTimestamp);
    const legacy = {
      localDate: parsed.localDate,
      startAt: parsed.explicitStartAt,
      competitionNumber: input.legacyCompetitionNumber,
      meaningfulSessionTime: parsed.meaningfulSessionTime,
    };
    if (input.duplicateLegacyKey) {
      return result(input, "ambiguous_match", null, legacy, 0, "duplicate_legacy_game_key");
    }
    const eligible = input.candidates.filter((candidate) =>
      candidate.organizationId === input.organizationId
      && candidate.leagueId === input.leagueId
      && ["published", "locked"].includes(candidate.lifecycle)
      && ["scheduled", "completed"].includes(candidate.status));
    const dateMatches = eligible.filter((candidate) => candidate.authoritativeLocalDate === parsed.localDate);
    const numberAndDateMatches = dateMatches.filter((candidate) =>
      candidate.competitionNumber === input.legacyCompetitionNumber);
    const exact = numberAndDateMatches.filter((candidate) => candidateStartMatchesLegacy(candidate, parsed));
    if (exact.length > 1) return result(input, "ambiguous_match", null, legacy, exact.length, "multiple_exact_candidates");
    if (exact.length === 1) {
      if (input.existingReferenceId != null && input.existingReferenceId !== exact[0]?.id) {
        return result(input, "cross_tenant_or_cross_league_reference", null, legacy, 1, "immutable_game_reference_conflict");
      }
      return result(input, "exact_match", exact[0]?.id ?? null, legacy, 1, "exact_date_number_and_start");
    }
    const ineligibleExact = input.candidates.filter((candidate) =>
      candidate.authoritativeLocalDate === parsed.localDate
      && candidate.competitionNumber === input.legacyCompetitionNumber
      && candidateStartMatchesLegacy(candidate, parsed));
    if (ineligibleExact.length > 0) {
      return result(input, "ineligible_occurrence_state", null, legacy, 0, "matching_occurrence_is_not_eligible");
    }
    if (numberAndDateMatches.length > 0) {
      return result(input, "legacy_date_or_start_mismatch", null, legacy, 0, "meaningful_start_does_not_match");
    }
    if (dateMatches.length > 0) {
      return result(input, "legacy_number_mismatch", null, legacy, 0, "competition_number_does_not_match");
    }
    if (eligible.some((candidate) => candidate.competitionNumber === input.legacyCompetitionNumber)) {
      return result(input, "legacy_date_or_start_mismatch", null, legacy, 0, "local_date_does_not_match");
    }
    return result(input, stateClassification(input), null, legacy, 0, "no_exact_game_candidate");
  }

  const legacyStartAt = normalizeCompatibilityInstant(input.legacyStartAt);
  const legacy = {
    localDate: null,
    startAt: legacyStartAt,
    competitionNumber: null,
    meaningfulSessionTime: true,
  };
  if (input.subject === "payment_schedule" && input.immediateUpfront) {
    if (input.existingReferenceId != null) {
      return result(input, "cross_tenant_or_cross_league_reference", null, legacy, 0, "upfront_cursor_must_not_have_occurrence");
    }
    return result(input, "no_match", null, legacy, 0, "upfront_immediate_schedule");
  }
  if (legacyStartAt === null) return result(input, "no_match", null, legacy, 0, "invalid_legacy_start");

  const exactStart = input.candidates.filter((candidate) => normalizeCompatibilityInstant(candidate.startAt) === legacyStartAt);
  const eligible = exactStart.filter((candidate) => {
    if (candidate.organizationId !== input.organizationId || candidate.leagueId !== input.leagueId) return false;
    if (input.subject === "payment_schedule") {
      return candidate.lifecycle === "published"
        && candidate.status === "scheduled"
        && Date.parse(candidate.startAt) > Date.parse(input.eligibilityNow);
    }
    return ["published", "locked"].includes(candidate.lifecycle)
      && ["scheduled", "completed"].includes(candidate.status);
  });
  if (eligible.length > 1) return result(input, "ambiguous_match", null, legacy, eligible.length, "multiple_exact_start_candidates");
  if (eligible.length === 1) {
    const occurrenceId = eligible[0]?.id ?? null;
    if (input.subject === "scheduled_operation"
      && input.existingReferenceId != null
      && input.existingReferenceId !== occurrenceId) {
      return result(input, "cross_tenant_or_cross_league_reference", null, legacy, 1, "immutable_operation_reference_conflict");
    }
    return result(input, "exact_match", occurrenceId, legacy, 1, "exact_utc_start");
  }
  if (exactStart.length > 0) {
    const hasDraft = exactStart.some((candidate) => candidate.lifecycle === "draft" && candidate.status !== "discarded");
    return result(
      input,
      hasDraft ? "canonical_not_published" : "ineligible_occurrence_state",
      null,
      legacy,
      0,
      hasDraft ? "matching_occurrence_is_not_published" : "matching_occurrence_is_not_eligible",
    );
  }
  return result(input, stateClassification(input), null, legacy, 0, "no_exact_start_candidate");
}
