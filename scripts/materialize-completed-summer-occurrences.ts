#!/usr/bin/env tsx

/**
 * Dormant B2 operator. It uses one dedicated PostgreSQL client and imports no
 * application database singleton, route, worker, payment, provider, email, or
 * encryption module.
 */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";
import {
  COMPLETED_SUMMER_MATERIALIZATION_CONTRACT_VERSION,
  COMPLETED_SUMMER_MATERIALIZATION_RESULT_VERSION,
  CompletedSummerMaterializationError,
  validateCompletedSummerMaterializationArtifact,
  type CompletedSummerMaterializationApprovalInput,
} from "@shared/completed-summer-materialization";
import { canonicalJsonStringify } from "@shared/completed-summer-comparator";
import {
  buildCompletedSummerMaterializationPlanResult,
  executeCompletedSummerMaterialization,
} from "../server/services/completed-summer-materialization.js";
import { CanonicalOccurrenceTransactionError } from "../server/services/canonical-occurrence-transactions.js";
import { parseCompletedSummerComparatorArguments } from "./compare-completed-summer-occurrences.js";

interface ParsedB2Arguments {
  reportFile: string;
  approval: Omit<CompletedSummerMaterializationApprovalInput, "requestedScope"> & {
    requestedScope: CompletedSummerMaterializationApprovalInput["requestedScope"];
  };
  apply: boolean;
  confirmReportFingerprint: string | null;
  confirmRequestFingerprint: string | null;
}

function usage(): string {
  return [
    "Usage: npx tsx scripts/materialize-completed-summer-occurrences.ts",
    "  --reportFile=<canonical B1 JSON artifact>",
    "  --organizationId=<positive integer>",
    "  --leagueId=<positive integer>",
    "  --seasonYear=<four-digit year>",
    "  --asOfDate=<YYYY-MM-DD>",
    "  --sourceScheduleRevision=<positive integer>",
    "  --ambiguousFold=reject|earlier|later",
    "  --currency=ABC",
    "  --regularSessionBillingPolicy=none|eligible_bowlers",
    "  --billingOrdinalPolicy=planned_slot|dense_billable",
    "  --actorUserId=<positive integer>",
    "  --reason=<nonempty trimmed reason>",
    "  --idempotencyKey=<nonempty trimmed key>",
    "  --reportFingerprint=<lowercase SHA-256>",
    "  --inputFingerprint=<lowercase SHA-256>",
    "  --physicalScheduleFingerprint=<lowercase SHA-256>",
    `  --materializationContract=${COMPLETED_SUMMER_MATERIALIZATION_CONTRACT_VERSION}`,
    "  [--acknowledge=<stable B1 finding reference>] (repeat for each non-info finding)",
    "  [--apply --confirmReportFingerprint=<same report SHA-256>",
    "           --confirmRequestFingerprint=<lvcanoncmd:v1 fingerprint from plan>]",
    "",
    "Without --apply the operator validates current evidence and emits a zero-write plan.",
  ].join("\n");
}

function positiveInteger(value: string | undefined, name: string): number {
  if (!value || !/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive safe integer`);
  return parsed;
}

function required(flags: Map<string, string[]>, name: string): string {
  const values = flags.get(name) ?? [];
  if (values.length !== 1 || !values[0]) throw new Error(`--${name} must be supplied exactly once`);
  return values[0];
}

function readFlags(args: readonly string[]): { values: Map<string, string[]>; apply: boolean } {
  const valueFlags = new Set([
    "reportFile", "organizationId", "leagueId", "seasonYear", "asOfDate", "sourceScheduleRevision",
    "ambiguousFold", "currency", "regularSessionBillingPolicy", "billingOrdinalPolicy", "actorUserId",
    "reason", "idempotencyKey", "reportFingerprint", "inputFingerprint", "physicalScheduleFingerprint",
    "materializationContract", "acknowledge", "confirmReportFingerprint", "confirmRequestFingerprint",
  ]);
  const values = new Map<string, string[]>();
  let apply = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--apply") {
      if (apply) throw new Error("--apply may be supplied only once");
      apply = true;
      continue;
    }
    if (!argument.startsWith("--")) throw new Error(`unknown argument: ${argument}`);
    const equals = argument.indexOf("=");
    const name = argument.slice(2, equals < 0 ? undefined : equals);
    if (!valueFlags.has(name)) throw new Error(`unknown argument: ${argument}`);
    const value = equals >= 0 ? argument.slice(equals + 1) : args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
    if (equals < 0) index += 1;
    const existing = values.get(name) ?? [];
    if (name !== "acknowledge" && existing.length > 0) throw new Error(`--${name} may be supplied only once`);
    existing.push(value);
    values.set(name, existing);
  }
  return { values, apply };
}

export function parseCompletedSummerMaterializationArguments(args: readonly string[]): ParsedB2Arguments {
  if (args.includes("--help") || args.includes("-h")) throw new Error(usage());
  const { values, apply } = readFlags(args);
  const organizationId = positiveInteger(required(values, "organizationId"), "organizationId");
  const leagueId = positiveInteger(required(values, "leagueId"), "leagueId");
  const requestedScope = parseCompletedSummerComparatorArguments([
    `--organizationId=${organizationId}`,
    `--leagueId=${leagueId}`,
    `--seasonYear=${required(values, "seasonYear")}`,
    `--asOfDate=${required(values, "asOfDate")}`,
    `--sourceScheduleRevision=${required(values, "sourceScheduleRevision")}`,
    `--ambiguousFold=${required(values, "ambiguousFold")}`,
    `--currency=${required(values, "currency")}`,
    `--regularSessionBillingPolicy=${required(values, "regularSessionBillingPolicy")}`,
    `--billingOrdinalPolicy=${required(values, "billingOrdinalPolicy")}`,
  ]);
  if (requestedScope.leagueId === null) throw new Error("leagueId is required");
  const materializationContractVersion = required(values, "materializationContract");
  if (materializationContractVersion !== COMPLETED_SUMMER_MATERIALIZATION_CONTRACT_VERSION) {
    throw new Error("unsupported materialization contract version");
  }
  const reason = required(values, "reason");
  if (reason.trim() !== reason || reason.length === 0) throw new Error("reason must be nonempty and trimmed");
  const idempotencyKey = required(values, "idempotencyKey");
  if (idempotencyKey.trim() !== idempotencyKey || idempotencyKey.length > 255) throw new Error("idempotencyKey must be nonempty, trimmed, and at most 255 characters");
  const acknowledgements = values.get("acknowledge") ?? [];
  if (new Set(acknowledgements).size !== acknowledgements.length) throw new Error("--acknowledge values must not be duplicated");
  const confirmReportFingerprint = values.get("confirmReportFingerprint")?.[0] ?? null;
  const confirmRequestFingerprint = values.get("confirmRequestFingerprint")?.[0] ?? null;
  if (!apply && (confirmReportFingerprint !== null || confirmRequestFingerprint !== null)) {
    throw new Error("confirmation flags are valid only with --apply");
  }
  return {
    reportFile: required(values, "reportFile"),
    approval: {
      organizationId,
      leagueId,
      actorUserId: positiveInteger(required(values, "actorUserId"), "actorUserId"),
      reason,
      idempotencyKey,
      reportFingerprint: required(values, "reportFingerprint"),
      inputFingerprint: required(values, "inputFingerprint"),
      physicalScheduleFingerprint: required(values, "physicalScheduleFingerprint"),
      expectedSourceScheduleRevision: requestedScope.sourceScheduleRevision,
      materializationContractVersion: COMPLETED_SUMMER_MATERIALIZATION_CONTRACT_VERSION,
      acknowledgedFindingReferences: acknowledgements,
      requestedScope: { ...requestedScope, leagueId },
    },
    apply,
    confirmReportFingerprint,
    confirmRequestFingerprint,
  };
}

function safeFailure(code: string, message: string): Record<string, unknown> {
  return {
    resultContractVersion: COMPLETED_SUMMER_MATERIALIZATION_RESULT_VERSION,
    ok: false,
    error: { code, message },
  };
}

export async function runCompletedSummerMaterializationOperator(
  args = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let parsed: ParsedB2Arguments;
  try {
    parsed = parseCompletedSummerMaterializationArguments(args);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    if (message === usage()) {
      process.stdout.write(`${message}\n`);
      return 0;
    }
    process.stderr.write(`[completed-summer-materialization] ${message}\n`);
    return 2;
  }
  let reportArtifact: string;
  try {
    reportArtifact = await readFile(parsed.reportFile, "utf8");
  } catch {
    process.stderr.write("[completed-summer-materialization] report artifact could not be read\n");
    process.stdout.write(`${canonicalJsonStringify(safeFailure("report_read_failure", "The approved B1 report artifact could not be read."))}\n`);
    return 1;
  }
  let plan;
  try {
    const semanticArtifact = reportArtifact.endsWith("\r\n")
      ? reportArtifact.slice(0, -2)
      : reportArtifact.endsWith("\n")
        ? reportArtifact.slice(0, -1)
        : reportArtifact;
    plan = validateCompletedSummerMaterializationArtifact({ reportArtifact: semanticArtifact, approval: parsed.approval });
  } catch (caught) {
    const code = caught instanceof CompletedSummerMaterializationError ? caught.code : "invalid_report";
    const message = caught instanceof CompletedSummerMaterializationError ? caught.message : "The approved B1 report could not be validated.";
    process.stderr.write(`[completed-summer-materialization] validation failed: ${code}\n`);
    process.stdout.write(`${canonicalJsonStringify(safeFailure(code, message))}\n`);
    return 1;
  }
  const planResult = buildCompletedSummerMaterializationPlanResult(plan);
  if (parsed.apply) {
    if (parsed.confirmReportFingerprint !== plan.approval.reportFingerprint
      || parsed.confirmRequestFingerprint !== planResult.requestFingerprint) {
      process.stderr.write("[completed-summer-materialization] apply confirmation mismatch\n");
      process.stdout.write(`${canonicalJsonStringify(safeFailure(
        "apply_confirmation_mismatch",
        "Apply requires exact report and request fingerprint confirmations from this plan.",
      ))}\n`);
      return 1;
    }
  }
  const connectionString = environment.DATABASE_URL;
  if (!connectionString) {
    process.stderr.write("[completed-summer-materialization] DATABASE_URL is required\n");
    return 2;
  }
  const client = new pg.Client({ connectionString, application_name: "leaguevault-completed-summer-b2-materialization" });
  let result: unknown;
  let exitCode = 1;
  try {
    await client.connect();
    result = await executeCompletedSummerMaterialization({ client, plan, apply: parsed.apply });
    exitCode = 0;
  } catch (caught) {
    const known = caught instanceof CompletedSummerMaterializationError
      || caught instanceof CanonicalOccurrenceTransactionError;
    const code = known ? caught.code : "materialization_failure";
    const message = known ? caught.message : "The materialization transaction failed; database details are suppressed.";
    result = safeFailure(code, message);
    process.stderr.write(`[completed-summer-materialization] failed: ${code}\n`);
  } finally {
    try {
      await client.end();
    } catch {
      result = safeFailure("client_close_failure", "The dedicated database client could not be confirmed closed.");
      exitCode = 1;
      process.stderr.write("[completed-summer-materialization] client close failed\n");
    }
  }
  process.stdout.write(`${canonicalJsonStringify(result)}\n`);
  return exitCode;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  runCompletedSummerMaterializationOperator().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch(() => {
    process.exitCode = 1;
  });
}
