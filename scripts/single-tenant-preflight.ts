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

export interface SingleTenantPreflightReport {
  configuredOrganizationId: number;
  activeOrganizationCount: number;
  readiness: {
    ok: boolean;
    blockers: Array<{ code: string; message: string }>;
  };
  organizations: SingleTenantPreflightOrganizationInventory[];
  totals: {
    users: number;
    bowlers: number;
    leagues: number;
    locations: number;
    pendingJobs: number;
    hostnames: number;
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
    totals,
  };
}

export async function inspectSingleTenantPreflight(
  connectionString: string,
): Promise<SingleTenantPreflightOrganizationRow[]> {
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
    await client.query("COMMIT");

    return result.rows.map((row) => ({
      organizationId: row.organization_id,
      active: row.active,
      slug: row.slug,
      subdomain: row.subdomain,
      users: safeCount(row.users_count, "users"),
      bowlers: safeCount(row.bowlers_count, "bowlers"),
      leagues: safeCount(row.leagues_count, "leagues"),
      locations: safeCount(row.locations_count, "locations"),
      pendingJobs: safeCount(row.pending_jobs_count, "pending jobs"),
    }));
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

  const rows = await inspectSingleTenantPreflight(connectionString);
  const report = buildSingleTenantPreflightReport(configuration.organizationId, rows);
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

