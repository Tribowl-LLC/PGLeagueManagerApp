import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import {
  leagueOccurrences,
  type LeagueOccurrence,
} from "@shared/schema";
import {
  compareCanonicalOccurrenceCompatibility,
  normalizeCompatibilityInstant,
  type OccurrenceCompatibilityInput,
  type OccurrenceCompatibilityResult,
} from "@shared/canonical-occurrence-compatibility";
import { extractStoredDateOnly } from "@shared/completed-summer-comparator";
import type { LeagueScheduleLockExecutor } from "../storage/league-schedule-lock.js";
import { createLogger } from "../logger.js";

const log = createLogger("OccurrenceCompatibility");
const MAX_COMPATIBILITY_CANDIDATES = 3;

type CompatibilityRequest = OccurrenceCompatibilityInput extends infer Input
  ? Input extends OccurrenceCompatibilityInput
    ? Omit<Input,
      "canonicalStatePresent" | "publishedStatePresent" | "referencedOccurrenceInScope" | "candidates">
    : never
  : never;

function candidate(row: LeagueOccurrence) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    leagueId: row.leagueId,
    authoritativeLocalDate: row.authoritativeLocalDate,
    authoritativeLocalStartTime: row.authoritativeLocalStartTime,
    timezone: row.timezone,
    startAt: row.startAt,
    foldResolution: row.foldResolution,
    competitionNumber: row.competitionNumber,
    lifecycle: row.lifecycle,
    status: row.status,
  };
}

async function loadCandidates(
  executor: LeagueScheduleLockExecutor,
  request: CompatibilityRequest,
): Promise<LeagueOccurrence[]> {
  const scope = and(
    eq(leagueOccurrences.organizationId, request.organizationId),
    eq(leagueOccurrences.leagueId, request.leagueId),
  );
  if (request.subject === "game") {
    const localDate = extractStoredDateOnly(request.legacyTimestamp);
    const relevanceOrder = localDate === null
      ? sql`CASE
          WHEN ${leagueOccurrences.lifecycle} IN ('published', 'locked')
            AND ${leagueOccurrences.status} IN ('scheduled', 'completed')
            AND ${leagueOccurrences.competitionNumber} = ${request.legacyCompetitionNumber} THEN 0
          ELSE 1
        END`
      : sql`CASE
          WHEN ${leagueOccurrences.lifecycle} IN ('published', 'locked')
            AND ${leagueOccurrences.status} IN ('scheduled', 'completed')
            AND ${leagueOccurrences.authoritativeLocalDate} = ${localDate}
            AND ${leagueOccurrences.competitionNumber} = ${request.legacyCompetitionNumber} THEN 0
          WHEN ${leagueOccurrences.authoritativeLocalDate} = ${localDate}
            AND ${leagueOccurrences.competitionNumber} = ${request.legacyCompetitionNumber} THEN 1
          WHEN ${leagueOccurrences.lifecycle} IN ('published', 'locked')
            AND ${leagueOccurrences.status} IN ('scheduled', 'completed')
            AND ${leagueOccurrences.authoritativeLocalDate} = ${localDate} THEN 2
          ELSE 3
        END`;
    return executor.select().from(leagueOccurrences).where(and(
      scope,
      or(
        localDate === null ? undefined : eq(leagueOccurrences.authoritativeLocalDate, localDate),
        eq(leagueOccurrences.competitionNumber, request.legacyCompetitionNumber),
      ),
    )).orderBy(relevanceOrder, leagueOccurrences.id).limit(MAX_COMPATIBILITY_CANDIDATES);
  }
  const startAt = normalizeCompatibilityInstant(request.legacyStartAt);
  if (startAt === null) return [];
  const eligibilityOrder = request.subject === "payment_schedule"
    ? sql`CASE
        WHEN ${leagueOccurrences.lifecycle} = 'published'
          AND ${leagueOccurrences.status} = 'scheduled'
          AND ${leagueOccurrences.startAt} > ${request.eligibilityNow} THEN 0
        WHEN ${leagueOccurrences.lifecycle} = 'draft' THEN 1
        ELSE 2
      END`
    : sql`CASE
        WHEN ${leagueOccurrences.lifecycle} IN ('published', 'locked')
          AND ${leagueOccurrences.status} IN ('scheduled', 'completed') THEN 0
        WHEN ${leagueOccurrences.lifecycle} = 'draft' THEN 1
        ELSE 2
      END`;
  return executor.select().from(leagueOccurrences).where(and(
    scope,
    eq(leagueOccurrences.startAt, startAt),
  )).orderBy(eligibilityOrder, leagueOccurrences.id).limit(MAX_COMPATIBILITY_CANDIDATES);
}

/** Load only event-relevant tenant-scoped evidence and invoke the shared pure comparator. */
export async function resolveCanonicalOccurrenceCompatibility(
  executor: LeagueScheduleLockExecutor,
  request: CompatibilityRequest,
): Promise<OccurrenceCompatibilityResult> {
  const [anyCanonical] = await executor.select({ id: leagueOccurrences.id })
    .from(leagueOccurrences)
    .where(and(
      eq(leagueOccurrences.organizationId, request.organizationId),
      eq(leagueOccurrences.leagueId, request.leagueId),
    ))
    .limit(1);
  const [publishedCanonical] = await executor.select({ id: leagueOccurrences.id })
    .from(leagueOccurrences)
    .where(and(
      eq(leagueOccurrences.organizationId, request.organizationId),
      eq(leagueOccurrences.leagueId, request.leagueId),
      inArray(leagueOccurrences.lifecycle, ["published", "locked"]),
      ne(leagueOccurrences.status, "discarded"),
    ))
    .limit(1);
  const referencedOccurrenceInScope = request.existingReferenceId == null
    ? null
    : (await executor.select({ id: leagueOccurrences.id })
      .from(leagueOccurrences)
      .where(and(
        eq(leagueOccurrences.id, request.existingReferenceId),
        eq(leagueOccurrences.organizationId, request.organizationId),
        eq(leagueOccurrences.leagueId, request.leagueId),
      ))
      .limit(1)).length === 1;
  const candidates = await loadCandidates(executor, request);
  return compareCanonicalOccurrenceCompatibility({
    ...request,
    canonicalStatePresent: anyCanonical !== undefined,
    publishedStatePresent: publishedCanonical !== undefined,
    referencedOccurrenceInScope,
    candidates: candidates.map(candidate),
  });
}

export function logOccurrenceCompatibility(
  event: string,
  comparison: OccurrenceCompatibilityResult,
): void {
  const details = {
    event,
    contractVersion: comparison.contractVersion,
    subject: comparison.subject,
    organizationId: comparison.organizationId,
    leagueId: comparison.leagueId,
    classification: comparison.classification,
    reason: comparison.evidence.reason,
    fingerprint: comparison.fingerprint,
  };
  if (comparison.classification === "exact_match"
    || comparison.classification === "canonical_state_absent"
    || comparison.classification === "canonical_not_published") {
    log.info("D1 occurrence compatibility comparison", details);
  } else {
    log.warn("D1 occurrence compatibility mismatch", details);
  }
}

export class OccurrenceCompatibilityConflictError extends Error {
  constructor(readonly comparison: OccurrenceCompatibilityResult) {
    super(`Occurrence compatibility conflict: ${comparison.classification}`);
    this.name = "OccurrenceCompatibilityConflictError";
  }
}

export async function occurrenceCompatibilityTransactionTime(
  executor: LeagueScheduleLockExecutor,
): Promise<string> {
  const result = await executor.execute<{ transaction_time: string }>(sql`
    SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS transaction_time
  `);
  const value = result.rows[0]?.transaction_time;
  if (!value) throw new Error("Database transaction time is unavailable");
  return value;
}

export function assertNoOccurrenceReferenceConflict(comparison: OccurrenceCompatibilityResult): void {
  if (comparison.classification === "cross_tenant_or_cross_league_reference") {
    throw new OccurrenceCompatibilityConflictError(comparison);
  }
}
