#!/usr/bin/env tsx

/**
 * B1 read-only comparator. It deliberately imports no application database,
 * route, provider, encryption, or mutation service module.
 */
import pg from "pg";
import { pathToFileURL } from "node:url";
import { generateCanonicalOccurrences } from "@shared/canonical-occurrence-generator";
import {
  buildCompletedSummerComparisonReport,
  canonicalJsonStringify,
  compareCompletedSummerLeague,
  evaluateCompletedSummerSelection,
  extractStoredDateOnly,
  type CompletedSummerComparisonReport,
  type CompletedSummerOperatorInputs,
  type ExistingA1EvidenceCounts,
  type LegacyGameRowEvidence,
  type LegacyPaymentEvidence,
  type PaymentOperationEvidence,
  type ReportFatalError,
} from "@shared/completed-summer-comparator";
import {
  createCanonicalGeneratorInputFromLegacyRow,
  type CanonicalLegacyLeagueRow,
} from "@shared/legacy-canonical-occurrence-input";

interface CompletedSummerLeagueRow extends CanonicalLegacyLeagueRow {
  active: boolean;
  season_number: number;
  previous_season_id: number | null;
  payment_mode: string;
}

interface GameEvidenceRow {
  game_id: number;
  league_id: number;
  week_number: number;
  game_number: number;
  raw_timestamp: string;
  mechanical_date: string;
  score_ids: number[];
}

interface PaymentEvidenceRow {
  payment_id: number;
  league_id: number;
  bowler_id: number;
  bowler_organization_id: number;
  amount_minor: number;
  lineage_amount_minor: number | null;
  prize_fund_amount_minor: number | null;
  status: string;
  payment_type: string;
  week_of_raw: string;
  payment_operation_id: string | null;
  allocation_index: number | null;
  refunded: boolean;
  disputed: boolean;
}

interface OperationEvidenceRow {
  league_id: number;
  operation_id: string;
  operation_type: "scheduled_charge" | "interactive_charge" | "refund";
  status: string;
  amount_minor: number;
  currency: string;
  billing_cycle_at_raw: string | null;
  snapshot_kind: "scheduled" | "interactive" | "refund";
  snapshot_version: number;
  snapshot_location_id: number | null;
  snapshot_week_of_raw: string | null;
  payment_id: number | null;
  allocation_index: number | null;
  allocation_bowler_id: number | null;
  allocation_amount_minor: number | null;
  lineage_amount_minor: number | null;
  prize_fund_amount_minor: number | null;
  week_of_raw: string | null;
  refunded: boolean;
}

interface DisputeEvidenceRow {
  operation_id: string;
  dispute_id: string;
  state: string;
  reason: string;
  amount_minor: number;
  currency: string;
  provider_version: number;
}

interface A1EvidenceRow extends ExistingA1EvidenceCounts {
  league_id: number;
}

interface InvalidEvidenceRow {
  league_id: number;
  invalid_count: number;
}

interface InvalidDisputeEvidenceRow {
  operation_id: string;
  invalid_count: number;
}

function usage(): string {
  return [
    "Usage: npx tsx scripts/compare-completed-summer-occurrences.ts",
    "  --organizationId=<positive integer>",
    "  --seasonYear=<four-digit year>",
    "  --asOfDate=<YYYY-MM-DD>",
    "  [--leagueId=<positive integer>]",
    "  --sourceScheduleRevision=<positive integer>",
    "  [--ambiguousFold=reject|earlier|later]",
    "  --currency=ABC",
    "  --regularSessionBillingPolicy=none|eligible_bowlers",
    "  --billingOrdinalPolicy=planned_slot|dense_billable",
    "",
    "Output is deterministic semantic JSON. The operator is strictly read-only.",
  ].join("\n");
}

function readFlags(args: readonly string[]): Map<string, string> {
  const known = new Set([
    "organizationId", "seasonYear", "asOfDate", "leagueId", "sourceScheduleRevision",
    "ambiguousFold", "currency", "regularSessionBillingPolicy", "billingOrdinalPolicy",
  ]);
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) throw new Error(`unknown argument: ${argument}`);
    const equals = argument.indexOf("=");
    const name = argument.slice(2, equals < 0 ? undefined : equals);
    if (!known.has(name)) throw new Error(`unknown argument: ${argument}`);
    if (result.has(name)) throw new Error(`--${name} may be supplied only once`);
    const value = equals >= 0 ? argument.slice(equals + 1) : args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
    if (equals < 0) index += 1;
    result.set(name, value);
  }
  return result;
}

function positiveInteger(value: string | undefined, name: string): number {
  if (!value || !/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive safe integer`);
  return parsed;
}

function validDateOnly(value: string | undefined, name: string): string {
  const parsed = extractStoredDateOnly(value ?? null);
  if (parsed === null || parsed !== value) throw new Error(`${name} must be a valid YYYY-MM-DD calendar date`);
  return parsed;
}

export function parseCompletedSummerComparatorArguments(args: readonly string[]): CompletedSummerOperatorInputs {
  if (args.includes("--help") || args.includes("-h")) throw new Error(usage());
  const flags = readFlags(args);
  const seasonYearRaw = flags.get("seasonYear");
  if (!seasonYearRaw || !/^\d{4}$/.test(seasonYearRaw)) throw new Error("seasonYear must be a four-digit year");
  const seasonYear = Number(seasonYearRaw);
  if (seasonYear < 1) throw new Error("seasonYear must be a four-digit positive year");
  const ambiguousFold = flags.get("ambiguousFold") ?? "reject";
  if (ambiguousFold !== "reject" && ambiguousFold !== "earlier" && ambiguousFold !== "later") {
    throw new Error("ambiguousFold must be reject, earlier, or later");
  }
  const currency = flags.get("currency");
  if (!currency || !/^[A-Z]{3}$/.test(currency)) throw new Error("currency must be an uppercase three-letter code");
  const billingPolicy = flags.get("regularSessionBillingPolicy");
  if (billingPolicy !== "none" && billingPolicy !== "eligible_bowlers") {
    throw new Error("regularSessionBillingPolicy must be none or eligible_bowlers");
  }
  const ordinalPolicy = flags.get("billingOrdinalPolicy");
  if (ordinalPolicy !== "planned_slot" && ordinalPolicy !== "dense_billable") {
    throw new Error("billingOrdinalPolicy must be planned_slot or dense_billable");
  }
  return {
    organizationId: positiveInteger(flags.get("organizationId"), "organizationId"),
    seasonYear,
    asOfDate: validDateOnly(flags.get("asOfDate"), "asOfDate"),
    leagueId: flags.has("leagueId") ? positiveInteger(flags.get("leagueId"), "leagueId") : null,
    sourceScheduleRevision: positiveInteger(flags.get("sourceScheduleRevision"), "sourceScheduleRevision"),
    ambiguousFold,
    currency,
    regularSessionBillingPolicy: billingPolicy,
    billingOrdinalPolicy: ordinalPolicy,
  };
}

function genericFatalReport(inputs: CompletedSummerOperatorInputs, code: string, message: string): CompletedSummerComparisonReport {
  return buildCompletedSummerComparisonReport({
    normalizedOperatorInputs: inputs,
    inspectedLeagueCount: 0,
    eligibleLeagueCount: 0,
    leagues: [],
    fatalErrors: [{ code, leagueId: inputs.leagueId, message }],
  });
}

function legacyDate(value: string | null): string | null {
  return extractStoredDateOnly(value);
}

function operationEvidence(rows: readonly OperationEvidenceRow[], disputes: readonly DisputeEvidenceRow[]): PaymentOperationEvidence[] {
  const byOperation = new Map<string, OperationEvidenceRow[]>();
  for (const row of rows) {
    const members = byOperation.get(row.operation_id) ?? [];
    members.push(row);
    byOperation.set(row.operation_id, members);
  }
  return [...byOperation.entries()].map(([operationId, members]) => {
    members.sort((left, right) => (left.allocation_index ?? -1) - (right.allocation_index ?? -1));
    const first = members[0];
    const disputeEvidence = disputes.filter((row) => row.operation_id === operationId).map((row) => ({
      disputeId: row.dispute_id,
      state: row.state,
      reason: row.reason,
      amountMinor: row.amount_minor,
      currency: row.currency,
      providerVersion: row.provider_version,
    })).sort((left, right) => left.disputeId < right.disputeId ? -1 : left.disputeId > right.disputeId ? 1 : 0);
    return {
      operationId,
      operationType: first.operation_type,
      status: first.status,
      amountMinor: first.amount_minor,
      currency: first.currency,
      billingCycleAtRaw: first.billing_cycle_at_raw,
      mechanicalBillingCycleDate: legacyDate(first.billing_cycle_at_raw),
      snapshotKind: first.snapshot_kind,
      snapshotVersion: first.snapshot_version,
      snapshotLocationProof: first.snapshot_location_id === null ? "organization_league_only" as const : "tenant_location" as const,
      snapshotWeekOfRaw: first.snapshot_week_of_raw,
      mechanicalSnapshotWeekOfDate: legacyDate(first.snapshot_week_of_raw),
      paymentId: first.payment_id,
      refunded: first.refunded || first.operation_type === "refund",
      disputed: disputeEvidence.length > 0,
      disputeEvidence,
      allocations: members.flatMap((row) => row.allocation_index === null || row.allocation_amount_minor === null ? [] : [{
        allocationIndex: row.allocation_index,
        amountMinor: row.allocation_amount_minor,
        lineageAmountMinor: row.lineage_amount_minor,
        prizeFundAmountMinor: row.prize_fund_amount_minor,
        weekOfRaw: row.week_of_raw,
        mechanicalWeekOfDate: legacyDate(row.week_of_raw),
      }]),
    };
  }).sort((left, right) => left.operationId < right.operationId ? -1 : left.operationId > right.operationId ? 1 : 0);
}

async function loadReport(client: pg.Client, inputs: CompletedSummerOperatorInputs): Promise<CompletedSummerComparisonReport> {
  const leagueQuery = await client.query<CompletedSummerLeagueRow>(`
    SELECT
      l.id AS league_id,
      l.organization_id,
      l.location_id,
      loc.organization_id AS location_organization_id,
      l.active,
      l.season_number,
      l.previous_season_id,
      to_char(l.season_start, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS season_start,
      to_char(l.season_end, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS season_end,
      l.week_day,
      l.competition_start_time,
      l.timezone,
      l.total_bowling_weeks,
      l.weekly_fee,
      l.payment_mode,
      l.skip_dates,
      l.cancelled_dates,
      l.double_pay_dates
    FROM leagues AS l
    LEFT JOIN locations AS loc
      ON loc.id = l.location_id
     AND loc.organization_id = l.organization_id
    WHERE l.organization_id = $1
      AND ($2::integer IS NULL OR l.id = $2)
    ORDER BY l.id ASC
  `, [inputs.organizationId, inputs.leagueId]);

  const fatalErrors: Array<Omit<ReportFatalError, "stableReference" | "severity">> = [];
  if (inputs.leagueId !== null && leagueQuery.rows.length === 0) {
    fatalErrors.push({
      code: "tenant_resource_not_found",
      leagueId: inputs.leagueId,
      message: "The explicitly requested league was not found in the requested organization snapshot.",
    });
  }

  const evaluations = leagueQuery.rows.map((row) => ({
    row,
    selection: evaluateCompletedSummerSelection({
      leagueId: row.league_id,
      organizationId: row.organization_id,
      locationId: row.location_id,
      locationOrganizationId: row.location_organization_id,
      active: row.active,
      seasonStartRaw: row.season_start,
      seasonEndRaw: row.season_end,
    }, inputs),
  }));
  if (inputs.leagueId !== null && evaluations.length === 1 && !evaluations[0].selection.eligible) {
    fatalErrors.push({
      code: "explicit_league_ineligible",
      leagueId: inputs.leagueId,
      message: "The explicitly requested league does not satisfy the tenant-proven Completed-Summer selection contract.",
    });
  }
  for (const evaluation of evaluations) {
    const otherwiseCompletedSummer = evaluation.selection.sameCalendarYear
      && evaluation.selection.summerStartMonth
      && evaluation.selection.requestedSeasonYear
      && evaluation.selection.completedBeforeAsOfDate;
    if (otherwiseCompletedSummer && (evaluation.row.location_id === null || evaluation.row.location_organization_id !== inputs.organizationId)) {
      fatalErrors.push({
        code: "invalid_or_cross_tenant_location",
        leagueId: evaluation.row.league_id,
        message: "A Completed-Summer league does not have a location proven to belong to the requested organization.",
      });
    }
  }

  const selected: Array<{
    row: CompletedSummerLeagueRow;
    selection: ReturnType<typeof evaluateCompletedSummerSelection>;
    generatorInput: Exclude<ReturnType<typeof createCanonicalGeneratorInputFromLegacyRow>, { failure: string }>;
  }> = [];
  for (const evaluation of evaluations.filter((candidate) => candidate.selection.eligible)) {
    const generatorInput = createCanonicalGeneratorInputFromLegacyRow(evaluation.row, {
      ...inputs,
      leagueId: evaluation.row.league_id,
    });
    if ("failure" in generatorInput) {
      fatalErrors.push({
        code: "incomplete_authoritative_input",
        leagueId: evaluation.row.league_id,
        message: generatorInput.failure,
      });
      continue;
    }
    selected.push({ ...evaluation, generatorInput });
  }

  const leagueIds = selected.map((candidate) => candidate.row.league_id);
  if (leagueIds.length === 0) {
    return buildCompletedSummerComparisonReport({
      normalizedOperatorInputs: inputs,
      inspectedLeagueCount: leagueQuery.rows.length,
      eligibleLeagueCount: evaluations.filter((candidate) => candidate.selection.eligible).length,
      leagues: [],
      fatalErrors,
    });
  }

  const [gamesQuery, paymentsQuery, scheduledQuery, interactiveQuery, refundQuery, a1Query, invalidQuery] = await Promise.all([
    client.query<GameEvidenceRow>(`
      SELECT
        g.id AS game_id,
        g.league_id,
        g.week_number,
        g.game_number,
        to_char(g.date, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS raw_timestamp,
        to_char(g.date, 'YYYY-MM-DD') AS mechanical_date,
        COALESCE(
          array_agg(s.id ORDER BY s.id) FILTER (WHERE sb.id IS NOT NULL AND st.id IS NOT NULL),
          ARRAY[]::integer[]
        ) AS score_ids
      FROM games AS g
      JOIN leagues AS l
        ON l.id = g.league_id
       AND l.organization_id = $1
      LEFT JOIN scores AS s ON s.game_id = g.id
      LEFT JOIN bowlers AS sb
        ON sb.id = s.bowler_id
       AND sb.organization_id = $1
      LEFT JOIN teams AS st
        ON st.id = s.team_id
       AND st.league_id = g.league_id
      WHERE g.league_id = ANY($2::integer[])
      GROUP BY g.id, g.league_id, g.week_number, g.game_number, g.date
      ORDER BY g.league_id, g.week_number, g.game_number, g.id
    `, [inputs.organizationId, leagueIds]),
    client.query<PaymentEvidenceRow>(`
      SELECT
        p.id AS payment_id,
        p.league_id,
        p.bowler_id,
        pb.organization_id AS bowler_organization_id,
        p.amount AS amount_minor,
        p.lineage_amount AS lineage_amount_minor,
        p.prize_fund_amount AS prize_fund_amount_minor,
        p.status,
        p.type AS payment_type,
        to_char(p.week_of, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS week_of_raw,
        p.payment_operation_id,
        p.payment_operation_allocation_index AS allocation_index,
        (p.status = 'refunded' OR p.refunded_at IS NOT NULL) AS refunded,
        (p.status = 'disputed' OR p.disputed_at IS NOT NULL) AS disputed
      FROM payments AS p
      JOIN leagues AS l
        ON l.id = p.league_id
       AND l.organization_id = $1
      JOIN bowlers AS pb ON pb.id = p.bowler_id
      WHERE p.league_id = ANY($2::integer[])
      ORDER BY p.league_id, p.id
    `, [inputs.organizationId, leagueIds]),
    client.query<OperationEvidenceRow>(`
      SELECT
        ss.league_id,
        po.id AS operation_id,
        po.operation_type,
        po.status,
        po.amount_minor,
        po.currency,
        to_char(po.billing_cycle_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS billing_cycle_at_raw,
        'scheduled'::text AS snapshot_kind,
        ss.snapshot_version,
        ss.location_id AS snapshot_location_id,
        NULL::text AS snapshot_week_of_raw,
        NULL::integer AS payment_id,
        a.allocation_index,
        a.bowler_id AS allocation_bowler_id,
        a.amount_minor AS allocation_amount_minor,
        a.lineage_amount_minor,
        a.prize_fund_amount_minor,
        to_char(po.billing_cycle_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS week_of_raw,
        EXISTS (
          SELECT 1 FROM payments AS p
          WHERE p.payment_operation_id = po.id AND p.status = 'refunded'
        ) AS refunded
      FROM scheduled_payment_operation_snapshots AS ss
      JOIN payment_operations AS po
        ON po.id = ss.operation_id
       AND po.organization_id = $1
       AND po.operation_type = 'scheduled_charge'
      JOIN payment_schedules AS ps
        ON ps.id = po.payment_schedule_id
       AND ps.league_id = ss.league_id
      JOIN bowlers AS psb
        ON psb.id = ps.bowler_id
       AND psb.organization_id = $1
      JOIN leagues AS l
        ON l.id = ss.league_id
       AND l.organization_id = $1
      LEFT JOIN locations AS loc
        ON loc.id = ss.location_id
       AND loc.organization_id = $1
      LEFT JOIN scheduled_payment_operation_allocations AS a ON a.operation_id = po.id
      WHERE ss.league_id = ANY($2::integer[])
        AND (ss.location_id IS NULL OR loc.id IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1
          FROM scheduled_payment_operation_allocations AS invalid_allocation
          JOIN bowlers AS invalid_bowler ON invalid_bowler.id = invalid_allocation.bowler_id
          WHERE invalid_allocation.operation_id = po.id
            AND invalid_bowler.organization_id IS DISTINCT FROM $1
        )
      ORDER BY ss.league_id, po.id, a.allocation_index
    `, [inputs.organizationId, leagueIds]),
    client.query<OperationEvidenceRow>(`
      SELECT
        ss.league_id,
        po.id AS operation_id,
        po.operation_type,
        po.status,
        po.amount_minor,
        po.currency,
        NULL::text AS billing_cycle_at_raw,
        'interactive'::text AS snapshot_kind,
        ss.snapshot_version,
        ss.location_id AS snapshot_location_id,
        to_char(ss.week_of, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS snapshot_week_of_raw,
        NULL::integer AS payment_id,
        a.allocation_index,
        a.bowler_id AS allocation_bowler_id,
        a.amount_minor AS allocation_amount_minor,
        a.lineage_amount_minor,
        a.prize_fund_amount_minor,
        to_char(a.week_of, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS week_of_raw,
        EXISTS (
          SELECT 1 FROM payments AS p
          WHERE p.payment_operation_id = po.id AND p.status = 'refunded'
        ) AS refunded
      FROM interactive_payment_operation_snapshots AS ss
      JOIN payment_operations AS po
        ON po.id = ss.operation_id
       AND po.organization_id = $1
       AND po.operation_type = 'interactive_charge'
      JOIN leagues AS l
        ON l.id = ss.league_id
       AND l.organization_id = $1
      JOIN bowlers AS payer
        ON payer.id = ss.payer_bowler_id
       AND payer.organization_id = $1
      LEFT JOIN locations AS loc
        ON loc.id = ss.location_id
       AND loc.organization_id = $1
      LEFT JOIN interactive_payment_operation_allocations AS a ON a.operation_id = po.id
      WHERE ss.league_id = ANY($2::integer[])
        AND (ss.location_id IS NULL OR loc.id IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1
          FROM interactive_payment_operation_allocations AS invalid_allocation
          JOIN bowlers AS invalid_bowler ON invalid_bowler.id = invalid_allocation.bowler_id
          WHERE invalid_allocation.operation_id = po.id
            AND invalid_bowler.organization_id IS DISTINCT FROM $1
        )
        AND NOT EXISTS (
          SELECT 1
          FROM interactive_payment_operation_allocations AS invalid_allocation
          WHERE invalid_allocation.operation_id = po.id
            AND invalid_allocation.week_of IS DISTINCT FROM ss.week_of
        )
      ORDER BY ss.league_id, po.id, a.allocation_index
    `, [inputs.organizationId, leagueIds]),
    client.query<OperationEvidenceRow>(`
      SELECT
        ss.league_id,
        po.id AS operation_id,
        po.operation_type,
        po.status,
        po.amount_minor,
        po.currency,
        NULL::text AS billing_cycle_at_raw,
        'refund'::text AS snapshot_kind,
        ss.snapshot_version,
        ss.location_id AS snapshot_location_id,
        NULL::text AS snapshot_week_of_raw,
        ss.payment_id,
        NULL::integer AS allocation_index,
        NULL::integer AS allocation_bowler_id,
        NULL::integer AS allocation_amount_minor,
        NULL::integer AS lineage_amount_minor,
        NULL::integer AS prize_fund_amount_minor,
        to_char(p.week_of, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS week_of_raw,
        true AS refunded
      FROM refund_payment_operation_snapshots AS ss
      JOIN payment_operations AS po
        ON po.id = ss.operation_id
       AND po.organization_id = $1
       AND po.operation_type = 'refund'
      JOIN payments AS p
        ON p.id = ss.payment_id
       AND p.league_id = ss.league_id
      JOIN bowlers AS pb
        ON pb.id = p.bowler_id
       AND pb.organization_id = $1
      JOIN leagues AS l
        ON l.id = ss.league_id
       AND l.organization_id = $1
      JOIN locations AS loc
        ON loc.id = ss.location_id
       AND loc.organization_id = $1
      WHERE ss.league_id = ANY($2::integer[])
      ORDER BY ss.league_id, po.id
    `, [inputs.organizationId, leagueIds]),
    client.query<A1EvidenceRow>(`
      SELECT
        selected.league_id,
        (SELECT count(*)::integer FROM league_schedule_commands AS value WHERE value.organization_id = $1 AND value.league_id = selected.league_id) AS commands,
        (SELECT count(*)::integer FROM league_occurrence_generation_runs AS value WHERE value.organization_id = $1 AND value.league_id = selected.league_id) AS "generationRuns",
        (SELECT count(*)::integer FROM league_schedule_exceptions AS value WHERE value.organization_id = $1 AND value.league_id = selected.league_id) AS exceptions,
        (SELECT count(*)::integer FROM league_occurrences AS value WHERE value.organization_id = $1 AND value.league_id = selected.league_id) AS occurrences,
        (SELECT count(*)::integer FROM league_occurrence_billing_terms AS value WHERE value.organization_id = $1 AND value.league_id = selected.league_id) AS "billingTerms",
        (SELECT count(*)::integer FROM league_occurrence_relationships AS value WHERE value.organization_id = $1 AND value.league_id = selected.league_id) AS relationships,
        (SELECT count(*)::integer FROM league_occurrence_generation_discrepancies AS value WHERE value.organization_id = $1 AND value.league_id = selected.league_id) AS discrepancies
      FROM unnest($2::integer[]) AS selected(league_id)
      ORDER BY selected.league_id
    `, [inputs.organizationId, leagueIds]),
    client.query<InvalidEvidenceRow>(`
      SELECT evidence.league_id, count(*)::integer AS invalid_count
      FROM (
        SELECT ss.league_id
        FROM scheduled_payment_operation_snapshots AS ss
        JOIN payment_operations AS po ON po.id = ss.operation_id
        LEFT JOIN payment_schedules AS ps ON ps.id = po.payment_schedule_id
        LEFT JOIN locations AS loc ON loc.id = ss.location_id
        LEFT JOIN bowlers AS psb ON psb.id = ps.bowler_id
        WHERE ss.league_id = ANY($2::integer[])
          AND (
            po.organization_id <> $1
            OR po.operation_type IS DISTINCT FROM 'scheduled_charge'
            OR ps.league_id IS DISTINCT FROM ss.league_id
            OR psb.organization_id IS DISTINCT FROM $1
            OR (ss.location_id IS NOT NULL AND loc.organization_id IS DISTINCT FROM $1)
            OR EXISTS (
              SELECT 1
              FROM scheduled_payment_operation_allocations AS invalid_allocation
              JOIN bowlers AS invalid_bowler ON invalid_bowler.id = invalid_allocation.bowler_id
              WHERE invalid_allocation.operation_id = po.id
                AND invalid_bowler.organization_id IS DISTINCT FROM $1
            )
          )
        UNION ALL
        SELECT ss.league_id
        FROM interactive_payment_operation_snapshots AS ss
        JOIN payment_operations AS po ON po.id = ss.operation_id
        LEFT JOIN locations AS loc ON loc.id = ss.location_id
        LEFT JOIN bowlers AS payer ON payer.id = ss.payer_bowler_id
        WHERE ss.league_id = ANY($2::integer[])
          AND (
            po.organization_id <> $1
            OR po.operation_type IS DISTINCT FROM 'interactive_charge'
            OR payer.organization_id IS DISTINCT FROM $1
            OR (ss.location_id IS NOT NULL AND loc.organization_id IS DISTINCT FROM $1)
            OR EXISTS (
              SELECT 1
              FROM interactive_payment_operation_allocations AS invalid_allocation
              JOIN bowlers AS invalid_bowler ON invalid_bowler.id = invalid_allocation.bowler_id
              WHERE invalid_allocation.operation_id = po.id
                AND invalid_bowler.organization_id IS DISTINCT FROM $1
            )
            OR EXISTS (
              SELECT 1
              FROM interactive_payment_operation_allocations AS invalid_allocation
              WHERE invalid_allocation.operation_id = po.id
                AND invalid_allocation.week_of IS DISTINCT FROM ss.week_of
            )
          )
        UNION ALL
        SELECT ss.league_id
        FROM refund_payment_operation_snapshots AS ss
        JOIN payment_operations AS po ON po.id = ss.operation_id
        LEFT JOIN payments AS p ON p.id = ss.payment_id
        LEFT JOIN locations AS loc ON loc.id = ss.location_id
        LEFT JOIN bowlers AS pb ON pb.id = p.bowler_id
        WHERE ss.league_id = ANY($2::integer[])
          AND (
            po.organization_id <> $1
            OR po.operation_type IS DISTINCT FROM 'refund'
            OR p.league_id IS DISTINCT FROM ss.league_id
            OR pb.organization_id IS DISTINCT FROM $1
            OR loc.organization_id IS DISTINCT FROM $1
          )
        UNION ALL
        SELECT g.league_id
        FROM scores AS s
        JOIN games AS g ON g.id = s.game_id
        LEFT JOIN bowlers AS sb ON sb.id = s.bowler_id
        LEFT JOIN teams AS st ON st.id = s.team_id
        WHERE g.league_id = ANY($2::integer[])
          AND (
            sb.organization_id IS DISTINCT FROM $1
            OR st.league_id IS DISTINCT FROM g.league_id
          )
        UNION ALL
        SELECT p.league_id
        FROM payments AS p
        LEFT JOIN bowlers AS pb ON pb.id = p.bowler_id
        WHERE p.league_id = ANY($2::integer[])
          AND pb.organization_id IS DISTINCT FROM $1
      ) AS evidence
      GROUP BY evidence.league_id
      ORDER BY evidence.league_id
    `, [inputs.organizationId, leagueIds]),
  ]);

  const allOperationRows = [...scheduledQuery.rows, ...interactiveQuery.rows, ...refundQuery.rows];
  const validOperationIds = [...new Set(allOperationRows.map((row) => row.operation_id))].sort();
  const [disputeRows, invalidDisputeRows] = validOperationIds.length === 0
    ? [[], []] as [DisputeEvidenceRow[], InvalidDisputeEvidenceRow[]]
    : await Promise.all([
      client.query<DisputeEvidenceRow>(`
        SELECT
          d.payment_operation_id AS operation_id,
          d.id AS dispute_id,
          d.state,
          d.reason,
          d.amount_minor,
          d.currency,
          d.provider_version
        FROM payment_disputes AS d
        JOIN payment_operations AS po
          ON po.id = d.payment_operation_id
         AND po.organization_id = $1
         AND d.organization_id = po.organization_id
        JOIN locations AS loc
          ON loc.id = d.location_id
         AND loc.organization_id = $1
        WHERE d.payment_operation_id = ANY($2::uuid[])
        ORDER BY d.payment_operation_id, d.id
      `, [inputs.organizationId, validOperationIds]).then((result) => result.rows),
      client.query<InvalidDisputeEvidenceRow>(`
        SELECT d.payment_operation_id AS operation_id, count(*)::integer AS invalid_count
        FROM payment_disputes AS d
        JOIN payment_operations AS po ON po.id = d.payment_operation_id
        LEFT JOIN locations AS loc ON loc.id = d.location_id
        WHERE d.payment_operation_id = ANY($2::uuid[])
          AND (d.organization_id <> $1 OR po.organization_id <> $1 OR loc.organization_id IS DISTINCT FROM $1)
        GROUP BY d.payment_operation_id
        ORDER BY d.payment_operation_id
      `, [inputs.organizationId, validOperationIds]).then((result) => result.rows),
    ]);

  const operations = operationEvidence(allOperationRows, disputeRows);
  const operationsByLeague = new Map<number, PaymentOperationEvidence[]>();
  for (const row of allOperationRows) {
    if (operationsByLeague.has(row.league_id)) continue;
    const ids = new Set(allOperationRows.filter((candidate) => candidate.league_id === row.league_id).map((candidate) => candidate.operation_id));
    operationsByLeague.set(row.league_id, operations.filter((operation) => ids.has(operation.operationId)));
  }
  const a1ByLeague = new Map(a1Query.rows.map((row) => [row.league_id, row]));
  const invalidByLeague = new Map(invalidQuery.rows.map((row) => [row.league_id, row.invalid_count]));
  const invalidDisputeOperationIds = new Set(invalidDisputeRows.map((row) => row.operation_id));
  for (const operation of allOperationRows) {
    if (!invalidDisputeOperationIds.has(operation.operation_id)) continue;
    invalidByLeague.set(operation.league_id, (invalidByLeague.get(operation.league_id) ?? 0) + 1);
  }
  const leagueReports = selected.map(({ row, selection, generatorInput }) => {
    const leagueOperations = operationsByLeague.get(row.league_id) ?? [];
    const validOperationIds = new Set(leagueOperations.map((operation) => operation.operationId));
    const validAllocationRows = new Map(allOperationRows.flatMap((operation) => operation.league_id === row.league_id
      && validOperationIds.has(operation.operation_id)
      && operation.allocation_index !== null
        ? [[`${operation.operation_id}:${operation.allocation_index}`, operation] as const]
        : []));
    let tenantEvidenceValid = (invalidByLeague.get(row.league_id) ?? 0) === 0;
    const leaguePayments: LegacyPaymentEvidence[] = paymentsQuery.rows
      .filter((payment) => payment.league_id === row.league_id)
      .flatMap((payment) => {
        if (payment.bowler_organization_id !== inputs.organizationId) {
          tenantEvidenceValid = false;
          return [];
        }
        const operationLinkAbsent = payment.payment_operation_id === null && payment.allocation_index === null;
        const allocation = payment.payment_operation_id === null || payment.allocation_index === null
          ? undefined
          : validAllocationRows.get(`${payment.payment_operation_id}:${payment.allocation_index}`);
        const operationLinkValid = operationLinkAbsent || (allocation !== undefined
          && allocation.allocation_bowler_id === payment.bowler_id
          && allocation.allocation_amount_minor === payment.amount_minor
          && allocation.lineage_amount_minor === payment.lineage_amount_minor
          && allocation.prize_fund_amount_minor === payment.prize_fund_amount_minor
          && allocation.week_of_raw === payment.week_of_raw
          && (allocation.snapshot_kind !== "interactive" || allocation.snapshot_week_of_raw === payment.week_of_raw));
        if (!operationLinkValid) tenantEvidenceValid = false;
        return [{
        paymentId: payment.payment_id,
        amountMinor: payment.amount_minor,
        status: payment.status,
        type: payment.payment_type,
        weekOfRaw: payment.week_of_raw,
        mechanicalWeekOfDate: legacyDate(payment.week_of_raw),
        operationId: !operationLinkAbsent && operationLinkValid ? payment.payment_operation_id : null,
        allocationIndex: !operationLinkAbsent && operationLinkValid ? payment.allocation_index : null,
        operationLinkProof: !operationLinkAbsent && operationLinkValid ? "tenant_and_immutable_tuple" as const : null,
        refunded: payment.refunded,
        disputed: payment.disputed,
        }];
      });
    const gameRows: LegacyGameRowEvidence[] = gamesQuery.rows.filter((game) => game.league_id === row.league_id).map((game) => ({
      gameId: game.game_id,
      leagueId: game.league_id,
      weekNumber: game.week_number,
      gameNumber: game.game_number,
      rawTimestamp: game.raw_timestamp,
      mechanicalDate: game.mechanical_date,
      provenStartAt: null,
      scoreIds: game.score_ids,
    }));
    const a1 = a1ByLeague.get(row.league_id);
    const existingA1EvidenceCounts: ExistingA1EvidenceCounts = a1 === undefined ? {
      commands: 0,
      generationRuns: 0,
      exceptions: 0,
      occurrences: 0,
      billingTerms: 0,
      relationships: 0,
      discrepancies: 0,
    } : {
      commands: a1.commands,
      generationRuns: a1.generationRuns,
      exceptions: a1.exceptions,
      occurrences: a1.occurrences,
      billingTerms: a1.billingTerms,
      relationships: a1.relationships,
      discrepancies: a1.discrepancies,
    };
    const seasonStartDate = selection.seasonStartDate;
    const seasonEndDate = selection.seasonEndDate;
    if (row.location_id === null || seasonStartDate === null || seasonEndDate === null) {
      throw new Error("selected league lost required normalized input");
    }
    return compareCompletedSummerLeague({
      identity: { organizationId: inputs.organizationId, leagueId: row.league_id, locationId: row.location_id },
      selectionEvidence: selection,
      legacyScheduleConfiguration: {
        leagueId: row.league_id,
        locationId: row.location_id,
        organizationId: inputs.organizationId,
        active: row.active,
        seasonNumber: row.season_number,
        previousSeasonId: row.previous_season_id,
        seasonStart: { raw: row.season_start as string, dateOnly: seasonStartDate },
        seasonEnd: { raw: row.season_end as string, dateOnly: seasonEndDate },
        weekday: row.week_day as string,
        totalBowlingWeeks: row.total_bowling_weeks as number,
        competitionStartTime: row.competition_start_time as string,
        timezone: row.timezone as string,
        skipDates: row.skip_dates ?? [],
        cancelledDates: row.cancelled_dates ?? [],
        weeklyFeeMinor: row.weekly_fee as number,
        paymentMode: row.payment_mode,
      },
      legacyCollectionEvidence: {
        source: "leagues.double_pay_dates",
        doublePayDates: row.double_pay_dates ?? [],
        excludedFromGeneratorInput: true,
        excludedFromPhysicalComparison: true,
        excludedFromA2InputFingerprint: true,
        excludedFromA2PhysicalScheduleFingerprint: true,
        excludedFromBillingTermAmounts: true,
      },
      generationResult: generateCanonicalOccurrences(generatorInput),
      legacyGameRows: gameRows,
      legacyPayments: leaguePayments,
      paymentOperations: leagueOperations,
      existingA1EvidenceCounts,
      tenantEvidenceValid,
    });
  });
  return buildCompletedSummerComparisonReport({
    normalizedOperatorInputs: inputs,
    inspectedLeagueCount: leagueQuery.rows.length,
    eligibleLeagueCount: evaluations.filter((candidate) => candidate.selection.eligible).length,
    leagues: leagueReports,
    fatalErrors,
  });
}

export async function runCompletedSummerComparator(
  args = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let inputs: CompletedSummerOperatorInputs;
  try {
    inputs = parseCompletedSummerComparatorArguments(args);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    if (message === usage()) {
      process.stdout.write(`${message}\n`);
      return 0;
    }
    process.stderr.write(`[completed-summer-comparator] ${message}\n`);
    return 2;
  }
  const connectionString = environment.DATABASE_URL;
  if (!connectionString) {
    process.stderr.write("[completed-summer-comparator] DATABASE_URL is required\n");
    return 2;
  }
  const client = new pg.Client({ connectionString, application_name: "leaguevault-completed-summer-b1-readonly" });
  let transactionStarted = false;
  let report: CompletedSummerComparisonReport;
  let exitCode = 1;
  try {
    await client.connect();
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionStarted = true;
    report = await loadReport(client, inputs);
    exitCode = report.aggregateCounts.fatalErrorCount > 0 ? 1 : 0;
  } catch {
    report = genericFatalReport(
      inputs,
      "operator_read_failure",
      "The read-only Completed-Summer comparison could not complete; database details are suppressed.",
    );
    process.stderr.write("[completed-summer-comparator] failed: read-only comparison could not complete\n");
  } finally {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        report = genericFatalReport(inputs, "rollback_failure", "The read-only transaction rollback could not be confirmed.");
        exitCode = 1;
        process.stderr.write("[completed-summer-comparator] rollback failed\n");
      }
    }
    await client.end().catch(() => {
      report = genericFatalReport(inputs, "client_close_failure", "The dedicated database client could not be confirmed closed.");
      exitCode = 1;
      process.stderr.write("[completed-summer-comparator] client close failed\n");
    });
  }
  process.stdout.write(`${canonicalJsonStringify(report)}\n`);
  return exitCode;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  runCompletedSummerComparator().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch(() => {
    process.exitCode = 1;
  });
}
