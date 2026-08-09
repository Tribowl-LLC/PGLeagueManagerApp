import {
  type AmbiguousFoldPolicy,
  canonicalDstResolverVersion,
  canonicalizeTimezone,
  resolveCanonicalLocalDateTime,
} from "./canonical-dst-resolver";

export const CANONICAL_OCCURRENCE_GENERATOR_VERSION = "canonical-occurrence-generator/1";
export const CANONICAL_OCCURRENCE_INPUT_CONTRACT_VERSION = "canonical-occurrence-input/1";
export const CANONICAL_OCCURRENCE_RESULT_CONTRACT_VERSION = "canonical-occurrence-generation-result/1";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export type CanonicalWeekday = (typeof WEEKDAYS)[number];
export type RegularSessionBillingPolicy = "none" | "eligible_bowlers";
export type BillingOrdinalPolicy = "planned_slot" | "dense_billable";

export interface CanonicalSkipExceptionInput {
  kind: "skip";
  localDate: string;
  reason: string;
  source: "manual" | "legacy_import" | "generator";
  lifecycleIntent: "draft" | "published";
  generationRunAssociationIntent: "associate" | "do_not_associate";
  candidateReference: string;
}

export interface CanonicalSpecialSessionBehavior {
  mode: "regular_only";
  version: "1";
}

export interface CanonicalOccurrenceGeneratorInput {
  organizationId: number;
  leagueId: number;
  locationId: number;
  sourceScheduleRevision: number;
  seasonStart: string;
  seasonEnd: string;
  weekday: CanonicalWeekday;
  localCompetitionStartTime: string;
  timezone: string;
  plannedSlotCount: number;
  skipExceptions: readonly CanonicalSkipExceptionInput[];
  cancelledDates: readonly string[];
  ambiguousFold: AmbiguousFoldPolicy;
  defaultWeeklyAmountMinor: number;
  currency: string;
  regularSessionBillingPolicy: RegularSessionBillingPolicy;
  billingOrdinalPolicy: BillingOrdinalPolicy;
  specialSessionBehavior: CanonicalSpecialSessionBehavior;
}

export interface CanonicalNormalizedSkipException extends CanonicalSkipExceptionInput {
  localDate: string;
  candidateReference: string;
}

export interface CanonicalNormalizedInput {
  contractVersion: typeof CANONICAL_OCCURRENCE_INPUT_CONTRACT_VERSION;
  organizationId: number;
  leagueId: number;
  locationId: number;
  sourceScheduleRevision: number;
  seasonStart: string;
  seasonEnd: string;
  weekday: CanonicalWeekday | string;
  localCompetitionStartTime: string;
  timezone: string;
  plannedSlotCount: number;
  skipExceptions: CanonicalNormalizedSkipException[];
  cancelledDates: string[];
  ambiguousFold: AmbiguousFoldPolicy | string;
  defaultWeeklyAmountMinor: number;
  currency: string;
  regularSessionBillingPolicy: RegularSessionBillingPolicy | string;
  billingOrdinalPolicy: BillingOrdinalPolicy | string;
  specialSessionBehavior: CanonicalSpecialSessionBehavior | { mode: string; version: string };
}

export interface CanonicalGenerationError {
  code: string;
  message: string;
  path: string;
  inputIndex: number | null;
}

export interface CanonicalGenerationDiscrepancy {
  severity: "info" | "warning" | "error";
  code: "outside_season_occurrence" | "total_week_mismatch" | "exception_collision";
  details: Record<string, string | number>;
}

export interface CanonicalOccurrenceCandidate {
  candidateReference: string;
  generationKey: string;
  kind: "regular";
  status: "scheduled" | "cancelled";
  authoritativeLocalDate: string;
  authoritativeLocalStartTime: string;
  timezone: string;
  startAt: string;
  selectedUtcOffsetMinutes: number;
  foldResolution: "unambiguous" | "earlier" | "later";
  resolverVersion: string;
  plannedOrdinal: number;
  competitionNumber: number | null;
  competitive: boolean;
  countsInStandings: boolean;
  makeupFor: null;
}

export interface CanonicalExceptionCandidate {
  candidateReference: string;
  candidateKey: string;
  kind: "skip";
  authoritativeLocalDate: string;
  timezone: string;
  reason: string;
  source: "manual" | "legacy_import" | "generator";
  lifecycleIntent: "draft" | "published";
  generationRunAssociationIntent: "associate" | "do_not_associate";
}

export interface CanonicalBillingTermCandidate {
  candidateReference: string;
  occurrenceCandidateReference: string;
  purpose: "league_weekly_fee";
  obligationPolicy: RegularSessionBillingPolicy;
  defaultAmountMinor: number;
  currency: string;
  billingOrdinal: number | null;
  version: 1;
}

export interface CanonicalGenerationCounts {
  generatedOccurrenceCount: number;
  skippedDateCount: number;
  candidateOccurrenceCount: number;
  fatalErrorCount: number;
  discrepancyCount: number;
  issueCount: number;
}

export interface CanonicalGenerationResult {
  resultContractVersion: typeof CANONICAL_OCCURRENCE_RESULT_CONTRACT_VERSION;
  generatorVersion: typeof CANONICAL_OCCURRENCE_GENERATOR_VERSION;
  resolverVersion: string;
  normalizedInput: CanonicalNormalizedInput;
  inputFingerprint: string;
  generationRange: {
    startDate: string | null;
    endDate: string | null;
    expectedSeasonEndDate: string;
    examinedCalendarDateCount: number;
  };
  occurrenceCandidates: CanonicalOccurrenceCandidate[];
  exceptionCandidates: CanonicalExceptionCandidate[];
  billingTermCandidates: CanonicalBillingTermCandidate[];
  fatalErrors: CanonicalGenerationError[];
  discrepancies: CanonicalGenerationDiscrepancy[];
  counts: CanonicalGenerationCounts;
  generatedOccurrenceCount: number;
  skippedDateCount: number;
  candidateOccurrenceCount: number;
  fatalErrorCount: number;
  discrepancyCount: number;
  issueCount: number;
}

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sunday: 0,
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
};

function error(
  code: string,
  message: string,
  path: string,
  inputIndex: number | null = null,
): CanonicalGenerationError {
  return { code, message, path, inputIndex };
}

function compareErrors(left: CanonicalGenerationError, right: CanonicalGenerationError): number {
  return compareStrings(left.path, right.path)
    || (left.inputIndex ?? -1) - (right.inputIndex ?? -1)
    || compareStrings(left.code, right.code)
    || compareStrings(left.message, right.message);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function dateToString(date: CalendarDate): string {
  return `${pad(date.year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}`;
}

function makeUtcDate(date: CalendarDate): Date {
  const result = new Date(0);
  result.setUTCFullYear(date.year, date.month - 1, date.day);
  result.setUTCHours(12, 0, 0, 0);
  return result;
}

function parseDate(value: unknown): CalendarDate | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const candidate = makeUtcDate({ year, month, day });
  if (
    year < 1
    || month < 1
    || month > 12
    || day < 1
    || candidate.getUTCFullYear() !== year
    || candidate.getUTCMonth() + 1 !== month
    || candidate.getUTCDate() !== day
  ) return null;
  return { year, month, day };
}

function addWeeks(date: CalendarDate, weeks: number): CalendarDate {
  const result = makeUtcDate(date);
  result.setUTCDate(result.getUTCDate() + weeks * 7);
  return { year: result.getUTCFullYear(), month: result.getUTCMonth() + 1, day: result.getUTCDate() };
}

function dayOfWeek(date: CalendarDate): number {
  return makeUtcDate(date).getUTCDay();
}

function normalizeTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? "0");
  if (hour > 23 || minute > 59 || second > 59) return null;
  return `${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}`;
}

function canonicalObject(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON cannot contain a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalObject).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort(compareStrings).map((key) => `${JSON.stringify(key)}:${canonicalObject(record[key])}`).join(",")}}`;
  }
  throw new Error("canonical JSON cannot contain undefined or a function");
}

/* A small dependency-free SHA-256 implementation keeps the pure contract
 * usable by both Node and browser-side contract tests. */
function sha256Hex(value: string): string {
  const input = new TextEncoder().encode(value);
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const bitLength = input.length * 8;
  const paddedLength = ((input.length + 9 + 63) >> 6) << 6;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(input);
  bytes[input.length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const schedule = new Uint32Array(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) schedule[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const s0 = (schedule[index - 15] >>> 7 | schedule[index - 15] << 25)
        ^ (schedule[index - 15] >>> 18 | schedule[index - 15] << 14)
        ^ (schedule[index - 15] >>> 3);
      const s1 = (schedule[index - 2] >>> 17 | schedule[index - 2] << 15)
        ^ (schedule[index - 2] >>> 19 | schedule[index - 2] << 13)
        ^ (schedule[index - 2] >>> 10);
      schedule[index] = (schedule[index - 16] + s0 + schedule[index - 7] + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let index = 0; index < 64; index += 1) {
      const s1 = (e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choose + constants[index] + schedule[index]) >>> 0;
      const s0 = (a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((part) => part.toString(16).padStart(8, "0")).join("");
}

export function canonicalizeGenerationInput(input: CanonicalOccurrenceGeneratorInput): {
  normalizedInput: CanonicalNormalizedInput;
  fatalErrors: CanonicalGenerationError[];
} {
  const fatalErrors: CanonicalGenerationError[] = [];
  const seasonStart = parseDate(input.seasonStart);
  const seasonEnd = parseDate(input.seasonEnd);
  if (!seasonStart) fatalErrors.push(error("invalid_season_start", "seasonStart must be a valid YYYY-MM-DD calendar date", "seasonStart"));
  if (!seasonEnd) fatalErrors.push(error("invalid_season_end", "seasonEnd must be a valid YYYY-MM-DD calendar date", "seasonEnd"));
  if (seasonStart && seasonEnd && dateToString(seasonEnd) < dateToString(seasonStart)) {
    fatalErrors.push(error("invalid_season_range", "seasonEnd must not precede seasonStart", "seasonEnd"));
  }
  for (const [path, value] of [
    ["organizationId", input.organizationId],
    ["leagueId", input.leagueId],
    ["locationId", input.locationId],
    ["sourceScheduleRevision", input.sourceScheduleRevision],
    ["plannedSlotCount", input.plannedSlotCount],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) fatalErrors.push(error("invalid_positive_integer", `${path} must be a positive safe integer`, path));
  }
  if (!Number.isSafeInteger(input.defaultWeeklyAmountMinor) || input.defaultWeeklyAmountMinor <= 0 || input.defaultWeeklyAmountMinor > 2_147_483_647) {
    fatalErrors.push(error("invalid_billing_amount", "defaultWeeklyAmountMinor must be a positive PostgreSQL-safe integer", "defaultWeeklyAmountMinor"));
  }
  if (!WEEKDAYS.includes(input.weekday)) fatalErrors.push(error("invalid_weekday", "weekday is not recognized", "weekday"));
  const localCompetitionStartTime = normalizeTime(input.localCompetitionStartTime);
  if (!localCompetitionStartTime) fatalErrors.push(error("invalid_competition_start_time", "localCompetitionStartTime must be HH:MM or HH:MM:SS", "localCompetitionStartTime"));
  const currency = typeof input.currency === "string" ? input.currency.trim() : "";
  if (!/^[A-Z]{3}$/.test(currency)) fatalErrors.push(error("invalid_currency", "currency must be an uppercase three-letter code", "currency"));
  if (input.ambiguousFold !== "reject" && input.ambiguousFold !== "earlier" && input.ambiguousFold !== "later") {
    fatalErrors.push(error("invalid_fold_policy", "ambiguousFold must be reject, earlier, or later", "ambiguousFold"));
  }
  if (input.regularSessionBillingPolicy !== "none" && input.regularSessionBillingPolicy !== "eligible_bowlers") {
    fatalErrors.push(error("invalid_billing_policy", "regularSessionBillingPolicy is not recognized", "regularSessionBillingPolicy"));
  }
  if (input.billingOrdinalPolicy !== "planned_slot" && input.billingOrdinalPolicy !== "dense_billable") {
    fatalErrors.push(error("invalid_billing_ordinal_policy", "billingOrdinalPolicy is not recognized", "billingOrdinalPolicy"));
  }
  if (input.specialSessionBehavior?.mode !== "regular_only" || input.specialSessionBehavior?.version !== "1") {
    fatalErrors.push(error("invalid_special_session_behavior", "A2 generator version 1 explicitly supports regular sessions only", "specialSessionBehavior"));
  }

  let timezone = typeof input.timezone === "string" ? input.timezone.trim() : "";
  if (timezone) {
    try {
      timezone = canonicalizeTimezone(timezone);
    } catch {
      fatalErrors.push(error("invalid_timezone", "timezone is not a recognized IANA zone or supported alias", "timezone"));
    }
  } else {
    fatalErrors.push(error("invalid_timezone", "timezone must be a recognized IANA zone", "timezone"));
  }

  const rawExceptions = Array.isArray(input.skipExceptions) ? input.skipExceptions : [];
  const skipExceptions: CanonicalNormalizedSkipException[] = rawExceptions.map((candidate, index) => {
    return {
      kind: "skip",
      localDate: typeof candidate?.localDate === "string" ? candidate.localDate : "",
      reason: typeof candidate?.reason === "string" ? candidate.reason.trim() : "",
      source: candidate?.source ?? "generator",
      lifecycleIntent: candidate?.lifecycleIntent ?? "draft",
      generationRunAssociationIntent: candidate?.generationRunAssociationIntent ?? "associate",
      candidateReference: typeof candidate?.candidateReference === "string" ? candidate.candidateReference.trim() : `skip-input-${index + 1}`,
    };
  });
  for (const [index, candidate] of rawExceptions.entries()) {
    if (!parseDate(candidate?.localDate)) fatalErrors.push(error("invalid_skip_date", "skip exception localDate must be YYYY-MM-DD", `skipExceptions[${index}].localDate`, index));
    if (!candidate?.reason || candidate.reason.trim() !== candidate.reason) fatalErrors.push(error("invalid_skip_reason", "skip exception reason must be nonempty and trimmed", `skipExceptions[${index}].reason`, index));
    if (!candidate?.candidateReference || candidate.candidateReference.trim() !== candidate.candidateReference) fatalErrors.push(error("invalid_skip_reference", "skip exception candidateReference must be nonempty and trimmed", `skipExceptions[${index}].candidateReference`, index));
    if (candidate?.kind !== "skip") fatalErrors.push(error("invalid_skip_kind", "skip exception kind must be skip", `skipExceptions[${index}].kind`, index));
    if (!["manual", "legacy_import", "generator"].includes(candidate?.source)) fatalErrors.push(error("invalid_skip_source", "skip exception source is not recognized", `skipExceptions[${index}].source`, index));
    if (!["draft", "published"].includes(candidate?.lifecycleIntent)) fatalErrors.push(error("invalid_skip_lifecycle", "skip exception lifecycleIntent is not recognized", `skipExceptions[${index}].lifecycleIntent`, index));
    if (!["associate", "do_not_associate"].includes(candidate?.generationRunAssociationIntent)) fatalErrors.push(error("invalid_skip_run_intent", "skip exception generationRunAssociationIntent is not recognized", `skipExceptions[${index}].generationRunAssociationIntent`, index));
  }
  skipExceptions.sort((left, right) => compareStrings(left.localDate, right.localDate) || compareStrings(left.candidateReference, right.candidateReference));

  const cancelledDates = Array.isArray(input.cancelledDates)
    ? input.cancelledDates.map((value) => typeof value === "string" ? value.trim() : "").sort(compareStrings)
    : [];
  for (const [index, date] of cancelledDates.entries()) {
    if (!parseDate(date)) fatalErrors.push(error("invalid_cancelled_date", "cancelledDates values must be YYYY-MM-DD", `cancelledDates[${index}]`, index));
  }
  const seenSkipDates = new Map<string, number>();
  for (const [index, candidate] of skipExceptions.entries()) {
    if (seenSkipDates.has(candidate.localDate)) fatalErrors.push(error("duplicate_skip_date", "duplicate skip dates are fatal and retain duplicate evidence", "skipExceptions", index));
    seenSkipDates.set(candidate.localDate, index);
  }
  const seenCancelledDates = new Set<string>();
  for (const [index, date] of cancelledDates.entries()) {
    if (seenCancelledDates.has(date)) fatalErrors.push(error("duplicate_cancelled_date", "duplicate cancelled dates are fatal and retain duplicate evidence", "cancelledDates", index));
    seenCancelledDates.add(date);
    if (seenSkipDates.has(date)) fatalErrors.push(error("skip_cancelled_collision", "a date cannot be both skipped and cancelled", "cancelledDates", index));
  }

  const normalizedInput: CanonicalNormalizedInput = {
    contractVersion: CANONICAL_OCCURRENCE_INPUT_CONTRACT_VERSION,
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    locationId: input.locationId,
    sourceScheduleRevision: input.sourceScheduleRevision,
    seasonStart: seasonStart ? dateToString(seasonStart) : String(input.seasonStart ?? ""),
    seasonEnd: seasonEnd ? dateToString(seasonEnd) : String(input.seasonEnd ?? ""),
    weekday: input.weekday,
    localCompetitionStartTime: localCompetitionStartTime ?? String(input.localCompetitionStartTime ?? ""),
    timezone,
    plannedSlotCount: input.plannedSlotCount,
    skipExceptions,
    cancelledDates,
    ambiguousFold: input.ambiguousFold,
    defaultWeeklyAmountMinor: input.defaultWeeklyAmountMinor,
    currency,
    regularSessionBillingPolicy: input.regularSessionBillingPolicy,
    billingOrdinalPolicy: input.billingOrdinalPolicy,
    specialSessionBehavior: input.specialSessionBehavior ?? { mode: "missing", version: "missing" },
  };
  fatalErrors.sort(compareErrors);
  return { normalizedInput, fatalErrors };
}

export function canonicalGenerationInputFingerprint(normalizedInput: CanonicalNormalizedInput): string {
  return sha256Hex(canonicalObject(normalizedInput));
}

function emptyResult(
  normalizedInput: CanonicalNormalizedInput,
  inputFingerprint: string,
  fatalErrors: CanonicalGenerationError[],
): CanonicalGenerationResult {
  const counts = {
    generatedOccurrenceCount: 0,
    skippedDateCount: 0,
    candidateOccurrenceCount: 0,
    fatalErrorCount: fatalErrors.length,
    discrepancyCount: 0,
    issueCount: fatalErrors.length,
  } satisfies CanonicalGenerationCounts;
  return {
    resultContractVersion: CANONICAL_OCCURRENCE_RESULT_CONTRACT_VERSION,
    generatorVersion: CANONICAL_OCCURRENCE_GENERATOR_VERSION,
    resolverVersion: canonicalDstResolverVersion(),
    normalizedInput,
    inputFingerprint,
    generationRange: {
      startDate: null,
      endDate: null,
      expectedSeasonEndDate: normalizedInput.seasonEnd,
      examinedCalendarDateCount: 0,
    },
    occurrenceCandidates: [],
    exceptionCandidates: [],
    billingTermCandidates: [],
    fatalErrors,
    discrepancies: [],
    counts,
    ...counts,
  };
}

export function generateCanonicalOccurrences(input: CanonicalOccurrenceGeneratorInput): CanonicalGenerationResult {
  const { normalizedInput, fatalErrors } = canonicalizeGenerationInput(input);
  const inputFingerprint = canonicalGenerationInputFingerprint(normalizedInput);
  if (fatalErrors.length > 0) return emptyResult(normalizedInput, inputFingerprint, fatalErrors);

  const firstDate = parseDate(normalizedInput.seasonStart);
  const expectedEnd = parseDate(normalizedInput.seasonEnd);
  if (!firstDate || !expectedEnd) return emptyResult(normalizedInput, inputFingerprint, [error("invalid_generation_boundary", "generation boundary could not be parsed", "generationRange")]);
  const targetWeekday = WEEKDAY_INDEX[normalizedInput.weekday];
  let current = firstDate;
  const daysToTarget = (targetWeekday - dayOfWeek(current) + 7) % 7;
  const adjusted = makeUtcDate(firstDate);
  adjusted.setUTCDate(adjusted.getUTCDate() + daysToTarget);
  current = { year: adjusted.getUTCFullYear(), month: adjusted.getUTCMonth() + 1, day: adjusted.getUTCDate() };
  const normalizedFirstDate = parseDate(dateToString(current));
  if (!normalizedFirstDate) return emptyResult(normalizedInput, inputFingerprint, [error("invalid_generation_boundary", "first schedule date could not be calculated", "seasonStart")]);
  current = normalizedFirstDate;

  const skipByDate = new Map(normalizedInput.skipExceptions.map((candidate) => [candidate.localDate, candidate]));
  const cancellationSet = new Set(normalizedInput.cancelledDates);
  const generatedDates = new Set<string>();
  const occurrenceCandidates: CanonicalOccurrenceCandidate[] = [];
  const exceptionCandidates: CanonicalExceptionCandidate[] = [];
  const billingTermCandidates: CanonicalBillingTermCandidate[] = [];
  const discrepancies: CanonicalGenerationDiscrepancy[] = [];
  const generationErrors: CanonicalGenerationError[] = [];
  let examinedCalendarDateCount = 0;
  let plannedOrdinal = 0;
  let competitionCounter = 0;
  let denseBillingOrdinal = 0;
  const maxIterations = normalizedInput.plannedSlotCount + normalizedInput.skipExceptions.length + 370;

  while (plannedOrdinal < normalizedInput.plannedSlotCount && examinedCalendarDateCount < maxIterations) {
    const localDate = dateToString(current);
    examinedCalendarDateCount += 1;
    const skip = skipByDate.get(localDate);
    if (skip) {
      exceptionCandidates.push({
        candidateReference: skip.candidateReference,
        candidateKey: `skip:v1:${normalizedInput.leagueId}:${inputFingerprint}:${localDate}:${skip.candidateReference}`,
        kind: "skip",
        authoritativeLocalDate: localDate,
        timezone: normalizedInput.timezone,
        reason: skip.reason,
        source: skip.source,
        lifecycleIntent: skip.lifecycleIntent,
        generationRunAssociationIntent: skip.generationRunAssociationIntent,
      });
    } else {
      plannedOrdinal += 1;
      competitionCounter += 1;
      generatedDates.add(localDate);
      const cancelled = cancellationSet.has(localDate);
      let resolution;
      try {
        resolution = resolveCanonicalLocalDateTime({
          localDate,
          localTime: normalizedInput.localCompetitionStartTime,
          timezone: normalizedInput.timezone,
          ambiguousFold: normalizedInput.ambiguousFold as AmbiguousFoldPolicy,
        });
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        generationErrors.push(error("invalid_dst_input", message, `occurrences[${plannedOrdinal}]`, plannedOrdinal - 1));
        break;
      }
      const candidateReference = `occurrence:${normalizedInput.leagueId}:${inputFingerprint}:${localDate}:${plannedOrdinal}`;
      const generationKey = `occurrence:v1:${normalizedInput.leagueId}:${inputFingerprint}:${localDate}:${plannedOrdinal}`;
      const occurrence: CanonicalOccurrenceCandidate = {
        candidateReference,
        generationKey,
        kind: "regular",
        status: cancelled ? "cancelled" : "scheduled",
        authoritativeLocalDate: localDate,
        authoritativeLocalStartTime: normalizedInput.localCompetitionStartTime,
        timezone: resolution.canonicalTimezone,
        startAt: resolution.startAt,
        selectedUtcOffsetMinutes: resolution.selectedUtcOffsetMinutes,
        foldResolution: resolution.foldResolution,
        resolverVersion: resolution.resolverVersion,
        plannedOrdinal,
        competitionNumber: cancelled ? null : competitionCounter,
        competitive: !cancelled,
        countsInStandings: !cancelled,
        makeupFor: null,
      };
      occurrenceCandidates.push(occurrence);
      const billable = !cancelled && normalizedInput.regularSessionBillingPolicy === "eligible_bowlers";
      if (normalizedInput.billingOrdinalPolicy === "planned_slot") denseBillingOrdinal = plannedOrdinal;
      else if (billable) denseBillingOrdinal += 1;
      billingTermCandidates.push({
        candidateReference: `billing:${candidateReference}`,
        occurrenceCandidateReference: candidateReference,
        purpose: "league_weekly_fee",
        obligationPolicy: billable ? "eligible_bowlers" : "none",
        defaultAmountMinor: billable ? normalizedInput.defaultWeeklyAmountMinor : 0,
        currency: normalizedInput.currency,
        billingOrdinal: billable ? denseBillingOrdinal : null,
        version: 1,
      });
    }
    current = addWeeks(current, 1);
  }

  if (plannedOrdinal < normalizedInput.plannedSlotCount && generationErrors.length === 0) {
    generationErrors.push(error("generation_did_not_terminate", "planned-slot termination could not be reached within the bounded calendar search", "plannedSlotCount"));
  }
  for (const candidate of normalizedInput.skipExceptions) {
    const date = parseDate(candidate.localDate);
    if (!date || dayOfWeek(date) !== targetWeekday || dateToString(date) < dateToString(firstDate)) {
      generationErrors.push(error("skip_not_on_schedule", "skip exception must be on or after the first configured weekday and match weekday", "skipExceptions", null));
    } else if (!exceptionCandidates.some((emitted) => emitted.authoritativeLocalDate === candidate.localDate)) {
      generationErrors.push(error("skip_not_examined", "skip exception was not reached by planned-slot generation", "skipExceptions", null));
    }
  }
  for (const date of normalizedInput.cancelledDates) {
    if (!generatedDates.has(date)) generationErrors.push(error("cancelled_date_not_generated", "cancelled date was not a generated planned slot", "cancelledDates", null));
  }

  const finalDate = occurrenceCandidates.at(-1)?.authoritativeLocalDate ?? exceptionCandidates.at(-1)?.authoritativeLocalDate ?? null;
  if (finalDate && finalDate !== normalizedInput.seasonEnd) {
    discrepancies.push({
      severity: "warning",
      code: "total_week_mismatch",
      details: { expectedSeasonEnd: normalizedInput.seasonEnd, generatedFinalDate: finalDate },
    });
  }
  if (occurrenceCandidates.some((candidate) => candidate.authoritativeLocalDate > normalizedInput.seasonEnd)) {
    discrepancies.push({
      severity: "warning",
      code: "outside_season_occurrence",
      details: { expectedSeasonEnd: normalizedInput.seasonEnd, generatedFinalDate: finalDate ?? "" },
    });
  }
  const generationKeys = new Set<string>();
  for (const candidate of occurrenceCandidates) {
    if (generationKeys.has(candidate.generationKey)) generationErrors.push(error("generation_key_collision", "generationKey is not unique within the result", "occurrenceCandidates", null));
    generationKeys.add(candidate.generationKey);
  }
  generationErrors.sort(compareErrors);
  const discrepancyCount = discrepancies.length;
  if (generationErrors.length > 0) return emptyResult(normalizedInput, inputFingerprint, generationErrors);
  const counts = {
    generatedOccurrenceCount: occurrenceCandidates.length,
    skippedDateCount: exceptionCandidates.length,
    candidateOccurrenceCount: occurrenceCandidates.length + exceptionCandidates.length,
    fatalErrorCount: 0,
    discrepancyCount,
    issueCount: discrepancyCount,
  } satisfies CanonicalGenerationCounts;
  return {
    resultContractVersion: CANONICAL_OCCURRENCE_RESULT_CONTRACT_VERSION,
    generatorVersion: CANONICAL_OCCURRENCE_GENERATOR_VERSION,
    resolverVersion: occurrenceCandidates[0]?.resolverVersion ?? canonicalDstResolverVersion(),
    normalizedInput,
    inputFingerprint,
    generationRange: {
      startDate: dateToString(firstDate),
      endDate: finalDate,
      expectedSeasonEndDate: normalizedInput.seasonEnd,
      examinedCalendarDateCount,
    },
    occurrenceCandidates,
    exceptionCandidates,
    billingTermCandidates,
    fatalErrors: [],
    discrepancies,
    counts,
    ...counts,
  };
}
