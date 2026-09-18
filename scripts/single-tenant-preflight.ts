import { pathToFileURL } from "node:url";
import pg from "pg";
import { redactConnectionDetails } from "./lib/db-schema-inventory";

export interface SingleTenantPreflightEnvironment {
  APP_ORGANIZATION_ID?: unknown;
}

export interface SingleTenantPreflightOrganizationRow {
  organizationId: number;
  active: boolean;
  slug: string | null;
  subdomain: string | null;
  users: number;
  bowlers: number;
  leagues: number;
  locations: number;
  pendingJobs: number;
}

export interface SingleTenantPreflightOrganizationInventory {
  id: number;
  active: boolean;
  hostnames: string[];
  counts: {
    users: number;
    bowlers: number;
    leagues: number;
    locations: number;
    pendingJobs: number;
    hostnames: number;
  };
}

/**
 * Counts used to prove that every record the cutover will expose has a
 * resolvable owner. Null system-admin organization IDs are intentionally
 * reported separately: they are the supported Owner exception, not an
 * orphaned business record.
 */
export interface SingleTenantPreflightOwnershipAudit {
  orphanedUsers: number;
  unassignedOwners: number;
  orphanedBowlers: number;
  orphanedLeagues: number;
  orphanedLocations: number;
  orphanedTeams: number;
  orphanedBowlerLeagues: number;
  orphanedPayments: number;
  orphanedPendingJobs: number;
  orphanedApplePayJobs: number;
  mismatchedUserBowlers: number;
  mismatchedUserLocations: number;
  mismatchedLeagueLocations: number;
  mismatchedBowlerPaymentLocations: number;
  mismatchedPaymentLeagues: number;
  mismatchedPaymentBowlers: number;
  mismatchedPendingJobOwners: number;
}

export interface SingleTenantPreflightReport {
  configuredOrganizationId: number;
  activeOrganizationCount: number;
  readiness: {
    ok: boolean;
    blockers: Array<{ code: string; message: string }>;
  };
  organizations: SingleTenantPreflightOrganizationInventory[];
  ownership: SingleTenantPreflightOwnershipAudit;
  totals: {
    users: number;
    bowlers: number;
    leagues: number;
    locations: number;
    pendingJobs: number;
    hostnames: number;
  };
}

function emptyOwnershipAudit(): SingleTenantPreflightOwnershipAudit {
  return {
    orphanedUsers: 0,
    unassignedOwners: 0,
    orphanedBowlers: 0,
    orphanedLeagues: 0,
    orphanedLocations: 0,
    orphanedTeams: 0,
    orphanedBowlerLeagues: 0,
    orphanedPayments: 0,
    orphanedPendingJobs: 0,
    orphanedApplePayJobs: 0,
    mismatchedUserBowlers: 0,
    mismatchedUserLocations: 0,
    mismatchedLeagueLocations: 0,
    mismatchedBowlerPaymentLocations: 0,
    mismatchedPaymentLeagues: 0,
    mismatchedPaymentBowlers: 0,
    mismatchedPendingJobOwners: 0,
  };
}

export type SingleTenantPreflightConfiguration =
  | { ok: true; organizationId: number }
  | { ok: false; code: "configuration_missing" | "configuration_invalid"; reason: string };

/** Normalize a database hostname label before it is printed in an artifact. */
export function normalizeHostLabel(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  return normalized.length > 0 ? normalized : null;
}

function parsePositiveSafeInteger(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function parseSingleTenantPreflightConfiguration(
  environment: SingleTenantPreflightEnvironment,
): SingleTenantPreflightConfiguration {
  if (environment.APP_ORGANIZATION_ID === undefined) {
    return {
      ok: false,
      code: "configuration_missing",
      reason: "APP_ORGANIZATION_ID must be set for the single-tenant preflight.",
    };
  }
  const organizationId = parsePositiveSafeInteger(environment.APP_ORGANIZATION_ID);
  if (organizationId === undefined) {
    return {
      ok: false,
      code: "configuration_invalid",
      reason: "APP_ORGANIZATION_ID must be a positive safe integer.",
    };
  }
  return { ok: true, organizationId };
}

function safeCount(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${label} count returned by PostgreSQL.`);
  }
  return parsed;
}

function inventoryForRow(row: SingleTenantPreflightOrganizationRow): SingleTenantPreflightOrganizationInventory {
  const hostnames = [...new Set([
    normalizeHostLabel(row.slug),
    normalizeHostLabel(row.subdomain),
  ].filter((value): value is string => value !== null))].sort();

  return {
    id: row.organizationId,
    active: row.active,
    hostnames,
    counts: {
      users: row.users,
      bowlers: row.bowlers,
      leagues: row.leagues,
      locations: row.locations,
      pendingJobs: row.pendingJobs,
      hostnames: hostnames.length,
    },
  };
}

/**
 * Build the operator-safe report and singleton readiness result without any
 * database or process-global state. No organization names, addresses, email
 * addresses, credentials, or other raw identity fields are included.
 */
export function buildSingleTenantPreflightReport(
  configuredOrganizationId: number,
  rows: readonly SingleTenantPreflightOrganizationRow[],
  ownership: SingleTenantPreflightOwnershipAudit = emptyOwnershipAudit(),
): SingleTenantPreflightReport {
  const organizations = rows
    .map(inventoryForRow)
    .sort((a, b) => a.id - b.id);
  const activeOrganizations = organizations.filter((organization) => organization.active);
  const configured = organizations.find((organization) => organization.id === configuredOrganizationId);
  const blockers: Array<{ code: string; message: string }> = [];

  if (!configured) {
    blockers.push({
      code: "organization_not_found",
      message: `Configured organization ${configuredOrganizationId} does not exist.`,
    });
  } else if (!configured.active) {
    blockers.push({
      code: "organization_inactive",
      message: `Configured organization ${configuredOrganizationId} is inactive.`,
    });
  }
  if (activeOrganizations.length === 0) {
    blockers.push({
      code: "no_active_organization",
      message: "No active organization exists.",
    });
  } else if (activeOrganizations.length > 1) {
    blockers.push({
      code: "multiple_active_organizations",
      message: `Expected exactly one active organization; found ${activeOrganizations.length}.`,
    });
  } else if (activeOrganizations[0]?.id !== configuredOrganizationId) {
    blockers.push({
      code: "configured_organization_not_active",
      message: `Configured organization ${configuredOrganizationId} is not the only active organization.`,
    });
  }

  const orphanedResourceCounts = [
    ownership.orphanedUsers,
    ownership.orphanedBowlers,
    ownership.orphanedLeagues,
    ownership.orphanedLocations,
    ownership.orphanedTeams,
    ownership.orphanedBowlerLeagues,
    ownership.orphanedPayments,
    ownership.orphanedPendingJobs,
    ownership.orphanedApplePayJobs,
  ];
  if (orphanedResourceCounts.some((count) => count > 0)) {
    blockers.push({
      code: "orphaned_resources",
      message: "One or more business records or pending jobs have no resolvable organization owner.",
    });
  }

  const ownershipMismatchCount = [
    ownership.mismatchedUserBowlers,
    ownership.mismatchedUserLocations,
    ownership.mismatchedLeagueLocations,
    ownership.mismatchedBowlerPaymentLocations,
    ownership.mismatchedPaymentLeagues,
    ownership.mismatchedPaymentBowlers,
    ownership.mismatchedPendingJobOwners,
  ].reduce((total, count) => total + count, 0);
  if (ownershipMismatchCount > 0) {
    blockers.push({
      code: "ownership_mismatch",
      message: "One or more related records have conflicting organization ownership.",
    });
  }

  const totals = organizations.reduce(
    (total, organization) => ({
      users: total.users + organization.counts.users,
      bowlers: total.bowlers + organization.counts.bowlers,
      leagues: total.leagues + organization.counts.leagues,
      locations: total.locations + organization.counts.locations,
      pendingJobs: total.pendingJobs + organization.counts.pendingJobs,
      hostnames: total.hostnames + organization.counts.hostnames,
    }),
    { users: 0, bowlers: 0, leagues: 0, locations: 0, pendingJobs: 0, hostnames: 0 },
  );

  return {
    configuredOrganizationId,
    activeOrganizationCount: activeOrganizations.length,
    readiness: { ok: blockers.length === 0, blockers },
    organizations,
    ownership,
    totals,
  };
}

export interface SingleTenantPreflightInspection {
  organizations: SingleTenantPreflightOrganizationRow[];
  ownership: SingleTenantPreflightOwnershipAudit;
}

export async function inspectSingleTenantPreflight(
  connectionString: string,
  configuredOrganizationId: number,
): Promise<SingleTenantPreflightInspection> {
  const client = new pg.Client({
    connectionString,
    application_name: "leaguevault-single-tenant-preflight",
  });

  try {
    await client.connect();
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const result = await client.query<{
      organization_id: number;
      active: boolean;
      slug: string | null;
      subdomain: string | null;
      users_count: string;
      bowlers_count: string;
      leagues_count: string;
      locations_count: string;
      pending_jobs_count: string;
    }>(`
      SELECT
        o.id AS organization_id,
        o.active,
        o.slug,
        o.subdomain,
        (SELECT count(*)::text FROM users u WHERE u.organization_id = o.id) AS users_count,
        (SELECT count(*)::text FROM bowlers b WHERE b.organization_id = o.id) AS bowlers_count,
        (SELECT count(*)::text FROM leagues l WHERE l.organization_id = o.id) AS leagues_count,
        (SELECT count(*)::text FROM locations loc WHERE loc.organization_id = o.id) AS locations_count,
        (
          (SELECT count(*) FROM account_action_delivery_jobs j
            WHERE j.organization_id = o.id
              AND j.status IN ('pending', 'processing', 'retry_scheduled'))
          + (SELECT count(*) FROM account_guidance_delivery_jobs j
            WHERE j.organization_id = o.id
              AND j.status IN ('pending', 'processing', 'retry_scheduled'))
          + (SELECT count(*) FROM account_ready_delivery_jobs j
            WHERE j.organization_id = o.id
              AND j.status IN ('pending', 'processing', 'retry_scheduled'))
          + (SELECT count(*) FROM payment_operations j
            WHERE j.organization_id = o.id
              AND j.status IN ('pending', 'leased', 'provider_unknown', 'retry_scheduled'))
          + (SELECT count(*) FROM webhook_events j
            WHERE j.organization_id = o.id
              AND j.status IN ('pending', 'processing', 'retry_scheduled'))
          + (SELECT count(*) FROM apple_pay_job_items j
            WHERE j.organization_id = o.id
              AND j.status IN ('pending', 'processing'))
        )::text AS pending_jobs_count
      FROM organizations o
      ORDER BY o.id
    `);

    const ownershipResult = await client.query<{
      orphaned_users: string;
      unassigned_owners: string;
      orphaned_bowlers: string;
      orphaned_leagues: string;
      orphaned_locations: string;
      orphaned_teams: string;
      orphaned_bowler_leagues: string;
      orphaned_payments: string;
      orphaned_pending_jobs: string;
      orphaned_apple_pay_jobs: string;
      mismatched_user_bowlers: string;
      mismatched_user_locations: string;
      mismatched_league_locations: string;
      mismatched_bowler_payment_locations: string;
      mismatched_payment_leagues: string;
      mismatched_payment_bowlers: string;
      mismatched_pending_job_owners: string;
    }>(`
      SELECT
        (SELECT count(*) FROM users u
          WHERE u.organization_id IS NULL AND u.role::text <> 'system_admin')::text AS orphaned_users,
        (SELECT count(*) FROM users u
          WHERE u.organization_id IS NULL AND u.role::text = 'system_admin')::text AS unassigned_owners,
        (SELECT count(*) FROM bowlers b
          WHERE b.organization_id IS NULL)::text AS orphaned_bowlers,
        (SELECT count(*) FROM leagues l
          WHERE l.organization_id IS NULL)::text AS orphaned_leagues,
        (SELECT count(*) FROM locations loc
          WHERE loc.organization_id IS NULL)::text AS orphaned_locations,
        (SELECT count(*) FROM teams t
          LEFT JOIN leagues l ON l.id = t.league_id
          WHERE l.id IS NULL OR l.organization_id IS NULL)::text AS orphaned_teams,
        (SELECT count(*) FROM bowler_leagues bl
          LEFT JOIN bowlers b ON b.id = bl.bowler_id
          LEFT JOIN leagues l ON l.id = bl.league_id
          LEFT JOIN teams t ON t.id = bl.team_id
          WHERE l.id IS NULL
             OR l.organization_id IS NULL
             OR b.id IS NULL
             OR b.organization_id IS NULL
             OR b.organization_id IS DISTINCT FROM l.organization_id
             OR t.id IS NULL
             OR t.league_id IS DISTINCT FROM bl.league_id)::text AS orphaned_bowler_leagues,
        (SELECT count(*) FROM payments p
          LEFT JOIN leagues l ON l.id = p.league_id
          WHERE p.organization_id IS NULL
             OR l.id IS NULL
             OR l.organization_id IS NULL)::text AS orphaned_payments,
        (
          (SELECT count(*) FROM account_action_delivery_jobs j
            WHERE j.organization_id IS NULL
              AND j.status IN ('pending', 'processing', 'retry_scheduled'))
          + (SELECT count(*) FROM account_guidance_delivery_jobs j
            WHERE j.organization_id IS NULL
              AND j.status IN ('pending', 'processing', 'retry_scheduled'))
          + (SELECT count(*) FROM account_ready_delivery_jobs j
            WHERE j.organization_id IS NULL
              AND j.status IN ('pending', 'processing', 'retry_scheduled'))
          + (SELECT count(*) FROM payment_operations j
            WHERE j.organization_id IS NULL
              AND j.status IN ('pending', 'leased', 'provider_unknown', 'retry_scheduled'))
          + (SELECT count(*) FROM webhook_events j
            WHERE j.organization_id IS NULL
              AND j.status IN ('pending', 'processing', 'retry_scheduled'))
          + (SELECT count(*) FROM apple_pay_job_items j
            WHERE j.organization_id IS NULL
              AND j.status IN ('pending', 'processing'))
        )::text AS orphaned_pending_jobs,
        (SELECT count(*) FROM apple_pay_jobs j
          LEFT JOIN users creator ON creator.id = j.created_by
          WHERE j.status IN ('pending', 'running')
            AND (
              j.created_by IS NULL
              OR creator.id IS NULL
              OR (
                creator.organization_id IS DISTINCT FROM $1
                AND NOT (creator.role::text = 'system_admin' AND creator.organization_id IS NULL)
              )
              OR EXISTS (
                SELECT 1
                FROM apple_pay_job_items item
                LEFT JOIN locations item_location ON item_location.id = item.location_id
                WHERE item.job_id = j.id
                  AND (
                    item.organization_id IS DISTINCT FROM $1
                    OR (
                      item.location_id IS NOT NULL
                      AND item_location.organization_id IS DISTINCT FROM $1
                    )
                  )
              )
            ))::text AS orphaned_apple_pay_jobs,
        (SELECT count(*) FROM users u
          LEFT JOIN bowlers b ON b.id = u.bowler_id
          WHERE u.bowler_id IS NOT NULL
            AND (b.id IS NULL OR u.organization_id IS DISTINCT FROM b.organization_id))::text AS mismatched_user_bowlers,
        (SELECT count(*) FROM users u
          LEFT JOIN locations loc ON loc.id = u.location_id
          WHERE u.location_id IS NOT NULL
            AND (loc.id IS NULL OR u.organization_id IS DISTINCT FROM loc.organization_id))::text AS mismatched_user_locations,
        (SELECT count(*) FROM leagues l
          LEFT JOIN locations loc ON loc.id = l.location_id
          WHERE l.location_id IS NOT NULL
            AND (loc.id IS NULL OR l.organization_id IS DISTINCT FROM loc.organization_id))::text AS mismatched_league_locations,
        (SELECT count(*) FROM bowlers b
          LEFT JOIN locations loc ON loc.id = b.payment_provider_location_id
          WHERE b.payment_provider_location_id IS NOT NULL
            AND (loc.id IS NULL OR b.organization_id IS DISTINCT FROM loc.organization_id))::text AS mismatched_bowler_payment_locations,
        (SELECT count(*) FROM payments p
          LEFT JOIN leagues l ON l.id = p.league_id
          WHERE l.id IS NULL OR p.organization_id IS DISTINCT FROM l.organization_id)::text AS mismatched_payment_leagues,
        (SELECT count(*) FROM payments p
          LEFT JOIN bowlers b ON b.id = p.bowler_id
          WHERE b.id IS NULL OR p.organization_id IS DISTINCT FROM b.organization_id)::text AS mismatched_payment_bowlers,
        (
          (SELECT count(*) FROM account_action_delivery_jobs j
            LEFT JOIN users u ON u.id = j.user_id
            WHERE u.id IS NULL OR j.organization_id IS DISTINCT FROM u.organization_id)
          + (SELECT count(*) FROM account_guidance_delivery_jobs j
            LEFT JOIN users u ON u.id = j.user_id
            WHERE (j.user_id IS NOT NULL AND u.id IS NULL)
               OR (u.id IS NOT NULL AND j.organization_id IS DISTINCT FROM u.organization_id))
          + (SELECT count(*) FROM account_ready_delivery_jobs j
            LEFT JOIN users u ON u.id = j.user_id
            WHERE u.id IS NULL OR j.organization_id IS DISTINCT FROM u.organization_id)
          + (SELECT count(*) FROM account_ready_delivery_jobs j
            LEFT JOIN bowlers b ON b.id = j.bowler_id
            WHERE b.id IS NULL OR j.organization_id IS DISTINCT FROM b.organization_id)
          + (SELECT count(*) FROM apple_pay_job_items j
            LEFT JOIN locations loc ON loc.id = j.location_id
            WHERE (j.location_id IS NOT NULL AND loc.id IS NULL)
               OR (j.location_id IS NOT NULL AND j.organization_id IS DISTINCT FROM loc.organization_id))
        )::text AS mismatched_pending_job_owners
    `, [configuredOrganizationId]);
    const [ownershipRow] = ownershipResult.rows;
    await client.query("COMMIT");

    return {
      organizations: result.rows.map((row) => ({
        organizationId: row.organization_id,
        active: row.active,
        slug: row.slug,
        subdomain: row.subdomain,
        users: safeCount(row.users_count, "users"),
        bowlers: safeCount(row.bowlers_count, "bowlers"),
        leagues: safeCount(row.leagues_count, "leagues"),
        locations: safeCount(row.locations_count, "locations"),
        pendingJobs: safeCount(row.pending_jobs_count, "pending jobs"),
      })),
      ownership: {
        orphanedUsers: safeCount(ownershipRow?.orphaned_users ?? "0", "orphaned users"),
        unassignedOwners: safeCount(ownershipRow?.unassigned_owners ?? "0", "unassigned owners"),
        orphanedBowlers: safeCount(ownershipRow?.orphaned_bowlers ?? "0", "orphaned bowlers"),
        orphanedLeagues: safeCount(ownershipRow?.orphaned_leagues ?? "0", "orphaned leagues"),
        orphanedLocations: safeCount(ownershipRow?.orphaned_locations ?? "0", "orphaned locations"),
        orphanedTeams: safeCount(ownershipRow?.orphaned_teams ?? "0", "orphaned teams"),
        orphanedBowlerLeagues: safeCount(ownershipRow?.orphaned_bowler_leagues ?? "0", "orphaned bowler leagues"),
        orphanedPayments: safeCount(ownershipRow?.orphaned_payments ?? "0", "orphaned payments"),
        orphanedPendingJobs: safeCount(ownershipRow?.orphaned_pending_jobs ?? "0", "orphaned pending jobs"),
        orphanedApplePayJobs: safeCount(ownershipRow?.orphaned_apple_pay_jobs ?? "0", "orphaned Apple Pay jobs"),
        mismatchedUserBowlers: safeCount(ownershipRow?.mismatched_user_bowlers ?? "0", "mismatched user bowlers"),
        mismatchedUserLocations: safeCount(ownershipRow?.mismatched_user_locations ?? "0", "mismatched user locations"),
        mismatchedLeagueLocations: safeCount(ownershipRow?.mismatched_league_locations ?? "0", "mismatched league locations"),
        mismatchedBowlerPaymentLocations: safeCount(ownershipRow?.mismatched_bowler_payment_locations ?? "0", "mismatched bowler payment locations"),
        mismatchedPaymentLeagues: safeCount(ownershipRow?.mismatched_payment_leagues ?? "0", "mismatched payment leagues"),
        mismatchedPaymentBowlers: safeCount(ownershipRow?.mismatched_payment_bowlers ?? "0", "mismatched payment bowlers"),
        mismatchedPendingJobOwners: safeCount(ownershipRow?.mismatched_pending_job_owners ?? "0", "mismatched pending job owners"),
      },
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const configuration = parseSingleTenantPreflightConfiguration(process.env);
  if (!configuration.ok) throw new Error(configuration.reason);

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL must be set for the read-only single-tenant preflight.");
  }

  const inspection = await inspectSingleTenantPreflight(connectionString, configuration.organizationId);
  const report = buildSingleTenantPreflightReport(
    configuration.organizationId,
    inspection.organizations,
    inspection.ownership,
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.readiness.ok) {
    process.stderr.write(
      `[single-tenant-preflight] Blocked: ${report.readiness.blockers.map((blocker) => blocker.code).join(", ")}.\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write("[single-tenant-preflight] Ready: exactly one configured active organization found.\n");
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[single-tenant-preflight] Failed: ${redactConnectionDetails(message, process.env.DATABASE_URL)}\n`,
    );
    process.exitCode = 1;
  });
}
