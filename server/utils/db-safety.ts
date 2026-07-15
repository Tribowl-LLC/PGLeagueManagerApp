/**
 * Hostname-based DB safety guard for destructive scripts.
 *
 * This is a second, INDEPENDENT layer on top of the
 * NODE_ENV / REPLIT_DEPLOYMENT check that
 * `scripts/cleanup-test-organizations.ts` and
 * `tests/setup/seed-test-users.ts` already perform via
 * `isReplitDeploymentValue` and their own `assertSafeEnvironment`
 * helpers. NODE_ENV is a shell variable that is trivially set wrong
 * (e.g. `NODE_ENV=development` in a shell whose `DATABASE_URL`
 * still points at the live tenant). This guard fires off a
 * different, independent signal — the `DATABASE_URL` host itself —
 * so a wrong NODE_ENV alone cannot wipe a live tenant.
 *
 * Mechanism (Task #609 — opt-in / allow-list model):
 *   First, the script refuses ambiguous connection targets. Target-changing
 *   query parameters, fragments, and ambient PostgreSQL target/role
 *   overrides are never accepted, including with DEV_DB_OK=1. The script
 *   then REFUSES to run unless one of the following is true:
 *     1. `DEV_DB_OK=1` is set. This is the explicit operator
 *        acknowledgement: "I have personally verified this
 *        DATABASE_URL points at a development database."
 *     2. The DATABASE_URL host is a loopback address
 *        (`localhost` / `127.0.0.1` / `::1`).
 *     3. The DATABASE_URL host contains a substring listed in the
 *        `DEV_DB_HOST_ALLOWLIST` env var (comma-separated). This is
 *        how a deployment registers its dev DB host once, so routine
 *        operator workflows don't need to set `DEV_DB_OK=1` every
 *        time. For this Replit project, the dev Neon endpoint id
 *        (`ep-dawn-unit-…`) is registered in the `development`
 *        environment via this var.
 *
 * Why opt-in instead of a blocklist of "prod-looking" substrings:
 * Neon endpoint hostnames are opaque (`ep-<adjective>-<noun>-<id>.…`)
 * and do not contain "prod" / "production" / "live" in them, so a
 * blocklist would let the live host slip through. The allow-list
 * model is categorical: any host that is NOT explicitly registered
 * as a dev DB requires the operator to type DEV_DB_OK=1, which makes
 * it impossible to nuke the live tenant by accident even if
 * NODE_ENV, REPLIT_DEPLOYMENT, AND DATABASE_URL all point at prod.
 */

const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '::1', '[::1]'];

const CONNECTION_TARGET_OVERRIDE_QUERY_PARAMETERS = new Set([
  'database',
  'db',
  'dbname',
  'host',
  'hostaddr',
  'options',
  'port',
  'role',
  'service',
  'servicefile',
  'user',
]);

const AMBIENT_TARGET_OVERRIDE_ENVIRONMENT_KEYS = [
  'PGDATABASE',
  'PGHOST',
  'PGHOSTADDR',
  'PGOPTIONS',
  'PGPORT',
  'PGSERVICE',
  'PGSERVICEFILE',
  'PGUSER',
] as const;

function parseAllowlist(raw: string | undefined): readonly string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

export function assertSafeDatabaseHost(scriptName: string): void {
  const url = process.env.DATABASE_URL;
  if (!url) {
    if (process.env.DEV_DB_OK === '1') return;
    throw new Error(
      `Refusing to run ${scriptName}: DATABASE_URL is not set, so the ` +
        'destructive-database guard cannot verify the target host. ' +
        'Set DATABASE_URL (and DEV_DB_OK=1 if you have verified the ' +
        'host is a development database).',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `Refusing to run ${scriptName}: DATABASE_URL could not be parsed ` +
        'as a URL, so the destructive-database guard cannot verify the ' +
        'target host.',
    );
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(
      `Refusing to run ${scriptName}: DATABASE_URL must use the postgres or ` +
        'postgresql scheme.',
    );
  }

  const hasTargetOverride = [...parsed.searchParams.keys()].some((key) =>
    CONNECTION_TARGET_OVERRIDE_QUERY_PARAMETERS.has(key.toLowerCase()),
  );
  if (hasTargetOverride || parsed.hash) {
    throw new Error(
      `Refusing to run ${scriptName}: DATABASE_URL must identify one exact ` +
        'target without target-changing query parameters or a fragment.',
    );
  }

  const ambientOverrides = AMBIENT_TARGET_OVERRIDE_ENVIRONMENT_KEYS.filter(
    (key) => process.env[key]?.trim(),
  );
  if (ambientOverrides.length > 0) {
    throw new Error(
      `Refusing to run ${scriptName}: unset ambient PostgreSQL target/role ` +
        `override variable(s): ${ambientOverrides.join(', ')}.`,
    );
  }

  const host = parsed.hostname.toLowerCase();
  if (!host) {
    throw new Error(
      `Refusing to run ${scriptName}: DATABASE_URL has no hostname, so ` +
        'the destructive-database guard cannot verify the target host.',
    );
  }

  if (!parsed.username || !parsed.pathname || parsed.pathname === '/') {
    throw new Error(
      `Refusing to run ${scriptName}: DATABASE_URL must explicitly identify ` +
        'both the database role and database name.',
    );
  }

  if (process.env.DEV_DB_OK === '1') return;

  if (LOOPBACK_HOSTS.some((h) => host === h || host.startsWith(`${h}:`))) {
    return;
  }

  const allowlist = parseAllowlist(process.env.DEV_DB_HOST_ALLOWLIST);
  if (allowlist.some((needle) => host.includes(needle))) {
    return;
  }

  throw new Error(
    `Refusing to run ${scriptName}: DATABASE_URL host is not on ` +
      'the dev-database allow-list. This script writes destructive changes ' +
      'and could corrupt live customer data if it targets the wrong tenant. ' +
      'Either (a) set DEV_DB_OK=1 to acknowledge that you have personally ' +
      'verified this host is a development database, or (b) add the host ' +
      "(or a unique substring of it) to the comma-separated " +
      'DEV_DB_HOST_ALLOWLIST env var so future runs against this host are ' +
      'recognized automatically.',
  );
}

export const __testing = {
  AMBIENT_TARGET_OVERRIDE_ENVIRONMENT_KEYS,
  CONNECTION_TARGET_OVERRIDE_QUERY_PARAMETERS,
  LOOPBACK_HOSTS,
  parseAllowlist,
};
