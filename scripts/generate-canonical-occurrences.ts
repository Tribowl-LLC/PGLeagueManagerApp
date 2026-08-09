#!/usr/bin/env tsx

/**
 * Read-only A2 operator. This file intentionally imports neither the
 * application singleton database nor any route/service with startup side
 * effects. It owns one pg.Client, one repeatable-read read-only transaction,
 * and no write/apply mode.
 */
import pg from "pg";
import { pathToFileURL } from "node:url";
import {
  generateCanonicalOccurrences,
  type CanonicalOccurrenceGeneratorInput,
  type CanonicalWeekday,
  type RegularSessionBillingPolicy,
  type BillingOrdinalPolicy,
} from "@shared/canonical-occurrence-generator";
import { type AmbiguousFoldPolicy } from "@shared/canonical-dst-resolver";

const OPERATOR_CONTRACT_VERSION = "canonical-occurrence-readonly-operator/1";

interface OperatorArguments {
  organizationId: number;
  leagueId: number;
  sourceScheduleRevision: number;
  ambiguousFold: AmbiguousFoldPolicy;
  currency: string | null;
  regularSessionBillingPolicy: RegularSessionBillingPolicy | null;
  billingOrdinalPolicy: BillingOrdinalPolicy | null;
}

interface LeagueLocationRow {
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

function usage(): string {
  return [
    "Usage: npx tsx scripts/generate-canonical-occurrences.ts",
    "  --organizationId=<positive integer>",
    "  --leagueId=<positive integer>",
    "  --sourceScheduleRevision=<positive integer>",
    "  [--ambiguousFold=reject|earlier|later]",
    "  [--currency=ABC --regularSessionBillingPolicy=none|eligible_bowlers --billingOrdinalPolicy=planned_slot|dense_billable]",
    "",
    "The three billing flags are explicit semantic inputs. They are not inferred",
    "from legacy payment rows; omitting them fails closed. Output is read-only.",
  ].join("\n");
}

function parsePositiveInteger(value: string | undefined, name: string): number {
  if (!value || !/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive safe integer`);
  return parsed;
}

function readFlag(args: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const index = args.findIndex((arg) => arg === `--${name}` || arg.startsWith(prefix));
  if (index < 0) return undefined;
  const argument = args[index];
  if (argument.startsWith(prefix)) return argument.slice(prefix.length);
  const next = args[index + 1];
  if (!next || next.startsWith("--")) throw new Error(`--${name} requires a value`);
  return next;
}

export function parseCanonicalOccurrenceOperatorArguments(args: readonly string[]): OperatorArguments {
  if (args.includes("--help") || args.includes("-h")) throw new Error(usage());
  const known = new Set([
    "organizationId", "leagueId", "sourceScheduleRevision", "ambiguousFold", "currency",
    "regularSessionBillingPolicy", "billingOrdinalPolicy",
  ]);
  for (const arg of args) {
    if (!arg.startsWith("--")) throw new Error(`unknown argument: ${arg}`);
    const name = arg.slice(2).split("=", 1)[0];
    if (!known.has(name)) throw new Error(`unknown argument: ${arg}`);
  }
  const organizationId = parsePositiveInteger(readFlag(args, "organizationId"), "organizationId");
  const leagueId = parsePositiveInteger(readFlag(args, "leagueId"), "leagueId");
  const sourceScheduleRevision = parsePositiveInteger(readFlag(args, "sourceScheduleRevision"), "sourceScheduleRevision");
  const ambiguousFold = readFlag(args, "ambiguousFold") ?? "reject";
  if (ambiguousFold !== "reject" && ambiguousFold !== "earlier" && ambiguousFold !== "later") throw new Error("ambiguousFold must be reject, earlier, or later");
  const currency = readFlag(args, "currency") ?? null;
  if (currency !== null && !/^[A-Z]{3}$/.test(currency)) throw new Error("currency must be an uppercase three-letter code");
  const regularPolicy = readFlag(args, "regularSessionBillingPolicy") ?? null;
  if (regularPolicy !== null && regularPolicy !== "none" && regularPolicy !== "eligible_bowlers") throw new Error("regularSessionBillingPolicy is not recognized");
  const ordinalPolicy = readFlag(args, "billingOrdinalPolicy") ?? null;
  if (ordinalPolicy !== null && ordinalPolicy !== "planned_slot" && ordinalPolicy !== "dense_billable") throw new Error("billingOrdinalPolicy is not recognized");
  return {
    organizationId,
    leagueId,
    sourceScheduleRevision,
    ambiguousFold,
    currency,
    regularSessionBillingPolicy: regularPolicy,
    billingOrdinalPolicy: ordinalPolicy,
  };
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

function failureResult(args: OperatorArguments, code: string, message: string, legacyCollectionEvidence: Record<string, unknown> | null): Record<string, unknown> {
  return {
    operatorContractVersion: OPERATOR_CONTRACT_VERSION,
    target: { organizationId: args.organizationId, leagueId: args.leagueId },
    legacyCollectionEvidence,
    fatalErrors: [{ code, message }],
    generationResult: null,
  };
}

function createGeneratorInput(row: LeagueLocationRow, args: OperatorArguments): CanonicalOccurrenceGeneratorInput | { failure: string } {
  const missing: string[] = [];
  const locationId = row.location_id;
  const seasonStart = dateOnly(row.season_start);
  const seasonEnd = dateOnly(row.season_end);
  const weekday = row.week_day;
  const competitionStartTime = row.competition_start_time;
  const timezone = row.timezone;
  const plannedSlotCount = row.total_bowling_weeks;
  const defaultWeeklyAmountMinor = row.weekly_fee;
  if (row.organization_id !== args.organizationId) missing.push("organizationId");
  if (locationId === null || row.location_organization_id !== args.organizationId) missing.push("tenant-scoped location");
  if (!seasonStart) missing.push("seasonStart");
  if (!seasonEnd) missing.push("seasonEnd");
  if (!isCanonicalWeekday(weekday)) missing.push("weekday");
  if (!competitionStartTime) missing.push("competitionStartTime");
  if (!timezone) missing.push("timezone");
  if (!Number.isSafeInteger(plannedSlotCount) || (plannedSlotCount ?? 0) <= 0) missing.push("totalBowlingWeeks");
  if (!Number.isSafeInteger(defaultWeeklyAmountMinor) || (defaultWeeklyAmountMinor ?? 0) <= 0) missing.push("defaultWeeklyAmountMinor");
  if (!args.currency) missing.push("explicit currency flag");
  if (!args.regularSessionBillingPolicy) missing.push("explicit regularSessionBillingPolicy flag");
  if (!args.billingOrdinalPolicy) missing.push("explicit billingOrdinalPolicy flag");
  if (missing.length > 0) return { failure: `incomplete authoritative input: ${missing.join(", ")}` };
  if (locationId === null || !seasonStart || !seasonEnd || !isCanonicalWeekday(weekday) || !competitionStartTime || !timezone || plannedSlotCount === null || defaultWeeklyAmountMinor === null || args.currency === null || args.regularSessionBillingPolicy === null || args.billingOrdinalPolicy === null) {
    return { failure: "incomplete authoritative input" };
  }
  const skipDates = row.skip_dates ?? [];
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
    skipExceptions: skipDates.map((localDate, index) => ({
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

function legacyEvidence(row: LeagueLocationRow): Record<string, unknown> {
  return {
    source: "leagues.double_pay_dates",
    doublePayDates: [...(row.double_pay_dates ?? [])].sort(),
    excludedFromGeneratorInput: true,
    excludedFromFingerprintAndBillingCandidates: true,
  };
}

export async function runCanonicalOccurrenceOperator(
  args = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let parsed: OperatorArguments;
  try {
    parsed = parseCanonicalOccurrenceOperatorArguments(args);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    if (message === usage()) {
      process.stdout.write(`${message}\n`);
      return 0;
    }
    process.stderr.write(`[canonical-occurrence-operator] ${message}\n`);
    return 2;
  }
  const connectionString = environment.DATABASE_URL;
  if (!connectionString) {
    process.stderr.write("[canonical-occurrence-operator] DATABASE_URL is required\n");
    return 2;
  }
  const client = new pg.Client({ connectionString, application_name: "leaguevault-canonical-occurrence-readonly" });
  let transactionStarted = false;
  try {
    await client.connect();
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionStarted = true;
    const query = await client.query<LeagueLocationRow>(`
      SELECT
        l.id AS league_id,
        l.organization_id,
        l.location_id,
        loc.organization_id AS location_organization_id,
        l.season_start::text AS season_start,
        l.season_end::text AS season_end,
        l.week_day,
        l.competition_start_time,
        l.timezone,
        l.total_bowling_weeks,
        l.weekly_fee,
        l.skip_dates,
        l.cancelled_dates,
        l.double_pay_dates
      FROM leagues AS l
      JOIN locations AS loc
        ON loc.id = l.location_id
       AND loc.organization_id = l.organization_id
      WHERE l.organization_id = $1
        AND l.id = $2
        AND l.location_id IS NOT NULL
        AND loc.id = l.location_id
        AND loc.organization_id = $1
    `, [parsed.organizationId, parsed.leagueId]);
    const row = query.rows[0];
    if (!row) {
      const result = failureResult(parsed, "tenant_resource_not_found", "league or tenant-scoped location was not found", null);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return 1;
    }
    const evidence = legacyEvidence(row);
    const input = createGeneratorInput(row, parsed);
    if ("failure" in input) {
      const result = failureResult(parsed, "incomplete_authoritative_input", input.failure, evidence);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return 1;
    }
    const generationResult = generateCanonicalOccurrences(input);
    const result = {
      operatorContractVersion: OPERATOR_CONTRACT_VERSION,
      target: { organizationId: parsed.organizationId, leagueId: parsed.leagueId, locationId: input.locationId },
      legacyCollectionEvidence: evidence,
      generationResult,
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return generationResult.fatalErrorCount > 0 ? 1 : 0;
  } catch (caught) {
    void caught;
    process.stderr.write("[canonical-occurrence-operator] failed: read-only canonical generation could not complete\n");
    return 1;
  } finally {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        process.stderr.write("[canonical-occurrence-operator] rollback failed\n");
      }
    }
    await client.end().catch(() => undefined);
  }
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  runCanonicalOccurrenceOperator().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch(() => {
    process.exitCode = 1;
  });
}
