/**
 * Canonical local-wall-clock resolver for canonical league occurrences.
 *
 * The resolver deliberately does not use the host time zone, the host
 * locale, or a library's implicit fold choice. It enumerates possible UTC
 * instants, formats each one back in the requested IANA zone, and accepts
 * only instants whose complete local fields round-trip exactly.
 */

export const AMBIGUOUS_FOLD_POLICIES = ["reject", "earlier", "later"] as const;
export type AmbiguousFoldPolicy = (typeof AMBIGUOUS_FOLD_POLICIES)[number];

export const CANONICAL_DST_RESOLVER_ALGORITHM_VERSION = "canonical-dst-resolver/1";

export type DstFoldResolution = "unambiguous" | "earlier" | "later";

export interface LocalDateTimeResolutionInput {
  localDate: string;
  localTime: string;
  timezone: string;
  ambiguousFold: AmbiguousFoldPolicy;
}

export interface LocalDateTimeResolution {
  startAt: string;
  selectedUtcOffsetMinutes: number;
  foldResolution: DstFoldResolution;
  canonicalTimezone: string;
  resolverVersion: string;
}

export type DstResolutionErrorCode =
  | "invalid_local_date"
  | "invalid_local_time"
  | "invalid_timezone"
  | "nonexistent_local_time"
  | "ambiguous_local_time"
  | "invalid_fold_policy";

export class CanonicalDstResolutionError extends Error {
  readonly code: DstResolutionErrorCode;

  constructor(code: DstResolutionErrorCode, message: string) {
    super(message);
    this.name = "CanonicalDstResolutionError";
    this.code = code;
  }
}

interface LocalFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function runtimeVersionPart(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized || !/^[A-Za-z0-9._-]+$/.test(normalized)) return "unknown";
  return normalized;
}

/** The algorithm plus the runtime data set used to prove a local instant. */
export function canonicalDstResolverVersion(): string {
  const icu = runtimeVersionPart(typeof process === "undefined" ? undefined : process.versions.icu);
  const tzdata = runtimeVersionPart(typeof process === "undefined" ? undefined : process.versions.tz);
  const version = `${CANONICAL_DST_RESOLVER_ALGORITHM_VERSION};icu=${icu};tzdata=${tzdata}`;
  return version.length <= 128 ? version : version.slice(0, 128);
}

/** Return the ICU-canonical spelling of a recognized time-zone name. */
export function canonicalizeTimezone(timezone: string): string {
  if (typeof timezone !== "string" || timezone.trim().length === 0) {
    throw new CanonicalDstResolutionError("invalid_timezone", "timezone must be a nonempty IANA time-zone name");
  }
  const requested = timezone.trim();
  try {
    const resolved = new Intl.DateTimeFormat("en-US", {
      timeZone: requested,
      calendar: "gregory",
      numberingSystem: "latn",
    }).resolvedOptions().timeZone;
    if (!resolved) throw new Error("time zone was not resolved");
    return resolved;
  } catch {
    throw new CanonicalDstResolutionError("invalid_timezone", `unrecognized IANA timezone: ${requested}`);
  }
}

function makeUtcDate(fields: LocalFields): Date {
  const result = new Date(0);
  result.setUTCFullYear(fields.year, fields.month - 1, fields.day);
  result.setUTCHours(fields.hour, fields.minute, fields.second, 0);
  return result;
}

function parseLocalDate(localDate: string): Pick<LocalFields, "year" | "month" | "day"> {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) {
    throw new CanonicalDstResolutionError("invalid_local_date", "localDate must be YYYY-MM-DD");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) {
    throw new CanonicalDstResolutionError("invalid_local_date", `invalid local date: ${localDate}`);
  }
  const candidate = makeUtcDate({ year, month, day, hour: 0, minute: 0, second: 0 });
  if (
    candidate.getUTCFullYear() !== year
    || candidate.getUTCMonth() + 1 !== month
    || candidate.getUTCDate() !== day
  ) {
    throw new CanonicalDstResolutionError("invalid_local_date", `invalid local date: ${localDate}`);
  }
  return { year, month, day };
}

function parseLocalTime(localTime: string): Pick<LocalFields, "hour" | "minute" | "second"> {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(localTime);
  if (!match) {
    throw new CanonicalDstResolutionError("invalid_local_time", "localTime must be HH:MM or HH:MM:SS");
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? "0");
  if (hour > 23 || minute > 59 || second > 59) {
    throw new CanonicalDstResolutionError("invalid_local_time", `invalid local time: ${localTime}`);
  }
  return { hour, minute, second };
}

function formatFields(formatter: Intl.DateTimeFormat, instant: Date): LocalFields {
  const parts = formatter.formatToParts(instant);
  const values = new Map<string, string>();
  for (const part of parts) {
    if (part.type !== "literal") values.set(part.type, part.value);
  }
  const fields = {
    year: Number(values.get("year")),
    month: Number(values.get("month")),
    day: Number(values.get("day")),
    hour: Number(values.get("hour")),
    minute: Number(values.get("minute")),
    second: Number(values.get("second")),
  };
  if (Object.values(fields).some((value) => !Number.isInteger(value))) {
    throw new Error("Intl did not return complete Gregorian local fields");
  }
  return fields;
}

function sameFields(left: LocalFields, right: LocalFields): boolean {
  return left.year === right.year
    && left.month === right.month
    && left.day === right.day
    && left.hour === right.hour
    && left.minute === right.minute
    && left.second === right.second;
}

function normalizeFoldPolicy(value: string): AmbiguousFoldPolicy {
  if (value === "reject" || value === "earlier" || value === "later") return value;
  throw new CanonicalDstResolutionError("invalid_fold_policy", "ambiguousFold must be reject, earlier, or later");
}

/**
 * Resolve one local calendar date and wall-clock time to one proven instant.
 * The offset search is intentionally bounded by A1's supported offset range.
 */
export function resolveCanonicalLocalDateTime(
  input: LocalDateTimeResolutionInput,
): LocalDateTimeResolution {
  const date = parseLocalDate(input.localDate);
  const time = parseLocalTime(input.localTime);
  const canonicalTimezone = canonicalizeTimezone(input.timezone);
  const foldPolicy = normalizeFoldPolicy(input.ambiguousFold);
  const requestedFields: LocalFields = { ...date, ...time };
  const wallClockEpoch = makeUtcDate(requestedFields).getTime();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: canonicalTimezone,
    calendar: "gregory",
    numberingSystem: "latn",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const matches: Array<{ instant: Date; offsetMinutes: number }> = [];
  for (let offsetMinutes = -840; offsetMinutes <= 840; offsetMinutes += 1) {
    const instant = new Date(wallClockEpoch - offsetMinutes * 60_000);
    if (!sameFields(formatFields(formatter, instant), requestedFields)) continue;
    const actualOffset = (wallClockEpoch - instant.getTime()) / 60_000;
    if (!Number.isInteger(actualOffset) || actualOffset < -840 || actualOffset > 840) continue;
    if (!matches.some((match) => match.instant.getTime() === instant.getTime())) {
      matches.push({ instant, offsetMinutes: actualOffset });
    }
  }
  matches.sort((left, right) => left.instant.getTime() - right.instant.getTime());

  if (matches.length === 0) {
    throw new CanonicalDstResolutionError(
      "nonexistent_local_time",
      `${input.localDate}T${input.localTime} does not exist in ${canonicalTimezone}`,
    );
  }
  if (matches.length > 2) {
    throw new CanonicalDstResolutionError(
      "ambiguous_local_time",
      `${input.localDate}T${input.localTime} has more than two valid instants in ${canonicalTimezone}`,
    );
  }
  if (matches.length === 2 && foldPolicy === "reject") {
    throw new CanonicalDstResolutionError(
      "ambiguous_local_time",
      `${input.localDate}T${input.localTime} is ambiguous in ${canonicalTimezone}; choose earlier or later`,
    );
  }

  const selectedIndex = matches.length === 1 || foldPolicy === "earlier" ? 0 : 1;
  const selected = matches[selectedIndex];
  const roundTrip = formatFields(formatter, selected.instant);
  if (!sameFields(roundTrip, requestedFields)) {
    throw new CanonicalDstResolutionError("nonexistent_local_time", "selected local time did not round-trip");
  }
  return {
    startAt: selected.instant.toISOString(),
    selectedUtcOffsetMinutes: selected.offsetMinutes,
    foldResolution: matches.length === 1
      ? "unambiguous"
      : foldPolicy === "earlier" ? "earlier" : "later",
    canonicalTimezone,
    resolverVersion: canonicalDstResolverVersion(),
  };
}
