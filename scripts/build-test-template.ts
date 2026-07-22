/**
 * Build the canonical local per-worker test template database.
 *
 * The canonical template is always created as an empty database, initialized
 * from the checked-in forward-only migration history, verified as a migration
 * no-op, brought to startup-invariant parity, and finally seeded. Neon branch
 * construction is deliberately refused here: a branch inherits its parent's
 * populated schema, so it cannot prove a from-zero baseline replay.
 *
 * The schema-input hash is written to
 * `.local/test-template-hash` so `ensure-test-template.ts` can decide
 * whether to rebuild on subsequent runs.
 *
 * Safe to run repeatedly. Template recreation refuses ambiguous connection
 * targets and hosts the dev-DB allow-list rejects (the same
 * `assertSafeDatabaseHost` rail every other destructive script uses).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { assertSafeDatabaseHost } from '../server/utils/db-safety';
import { createDbClient } from '../server/db';
import { installDbInvariants } from '../server/db-invariants';
import { seedTestUsers } from '../tests/setup/seed-test-users';
import { getNeonConfig, resolveBranchUrl } from '../tests/setup/neon-branches';
import { TEMPLATE_DB_NAME } from '../tests/setup/per-worker-lock';
import {
  assertApprovedBaselineFingerprint,
  createBaselineFingerprint,
} from './lib/db-baseline-fingerprint';
import { loadActiveMigrations } from './lib/db-migration-assets';
import {
  assertCheckedMigrationsCurrent,
  runCheckedMigrations,
} from './lib/db-migration-runner';
import { collectDatabaseInventory } from './lib/db-schema-inventory';
import { computeTemplateHash } from './lib/test-template-provenance';

export { computeTemplateHash } from './lib/test-template-provenance';

const HASH_FILE = '.local/test-template-hash';

function originalDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL must be set to build the test template database.');
  }
  return url;
}

export function templateDatabaseUrl(): string {
  const u = new URL(originalDatabaseUrl());
  u.pathname = `/${TEMPLATE_DB_NAME}`;
  return u.toString();
}

function adminDatabaseUrl(): string {
  // Connect to the Postgres-default `postgres` admin DB to issue
  // DROP/CREATE DATABASE statements (you can't drop the DB you're
  // currently connected to).
  const u = new URL(originalDatabaseUrl());
  u.pathname = '/postgres';
  return u.toString();
}

async function recreateLegacyTemplateDb(): Promise<void> {
  const adminPool = new pg.Pool({ connectionString: adminDatabaseUrl(), max: 2 });
  try {
    // Forcibly disconnect any lingering sessions, then drop + create.
    // `WITH (FORCE)` is supported on PG 13+; Neon is on 16/17.
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [TEMPLATE_DB_NAME],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS "${TEMPLATE_DB_NAME}" WITH (FORCE)`);
    await adminPool.query(`CREATE DATABASE "${TEMPLATE_DB_NAME}"`);
  } finally {
    await adminPool.end();
  }
}

function assertLocalTemplateTarget(): void {
  const hostname = new URL(originalDatabaseUrl()).hostname.toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname)) {
    throw new Error(
      'Canonical migrated test-template construction requires an owned loopback PostgreSQL target.',
    );
  }
}

function writeHash(hash: string): void {
  mkdirSync(dirname(HASH_FILE), { recursive: true });
  writeFileSync(HASH_FILE, `${hash}\n`, 'utf8');
}

export async function assertMigratedTemplateReady(templateUrl: string): Promise<void> {
  await assertCheckedMigrationsCurrent(templateUrl);
  if (loadActiveMigrations().length === 1) {
    const fingerprint = createBaselineFingerprint(await collectDatabaseInventory(templateUrl));
    assertApprovedBaselineFingerprint(fingerprint);
    return;
  }
  const client = new pg.Client({ connectionString: templateUrl });
  try {
    await client.connect();
    const result = await client.query<{ ready: boolean }>(`
      SELECT
        to_regprocedure('public.organization_hostname_namespace_guard_fn()') IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM pg_catalog.pg_trigger t
          JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
          WHERE c.oid = 'public.organizations'::regclass
            AND t.tgname = 'organization_hostname_namespace_guard'
            AND NOT t.tgisinternal
        ) AS ready
    `);
    if (result.rows[0]?.ready !== true) {
      throw new Error('Current organization hostname namespace invariant is absent.');
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function buildTestTemplate(): Promise<void> {
  // Independent exact-target and host-allow-list guard: refuse query or
  // ambient target overrides, then refuse to wipe a database unless the
  // operator's DATABASE_URL is on the dev allow-list.
  // (Asserted on the original DATABASE_URL, before any branch-URL
  // swap — the original is the dev host registered in the allow-list.)
  assertSafeDatabaseHost('build-test-template');

  if (getNeonConfig()) {
    throw new Error(
      'Refusing to construct the canonical test template from a Neon branch: ' +
      'branches inherit their parent schema and cannot prove a from-zero migration replay. ' +
      'Use an owned local PostgreSQL target for migrated-template construction.',
    );
  }
  assertLocalTemplateTarget();

  // A failed rebuild must never leave a same-code cache token that would let
  // the next run accept a partially initialized template.
  rmSync(HASH_FILE, { force: true });

  console.log(
    `[build-test-template] mode=local-empty; dropping + recreating "${TEMPLATE_DB_NAME}"…`,
  );
  await recreateLegacyTemplateDb();
  const templateUrl = templateDatabaseUrl();

  const expectedTags = loadActiveMigrations().map((migration) => migration.tag);
  console.log('[build-test-template] applying checked-in migrations to empty template…');
  const firstRun = await runCheckedMigrations(templateUrl);
  if (
    firstRun.noOp ||
    JSON.stringify(firstRun.pending) !== JSON.stringify(expectedTags) ||
    JSON.stringify(firstRun.applied) !== JSON.stringify(expectedTags)
  ) {
    throw new Error('Canonical test-template initialization did not apply the complete active history.');
  }
  await assertMigratedTemplateReady(templateUrl);

  const secondRun = await runCheckedMigrations(templateUrl);
  if (!secondRun.noOp || secondRun.pending.length !== 0 || secondRun.applied.length !== 0) {
    throw new Error('Canonical test-template migration rerun was not an exact no-op.');
  }
  await assertCheckedMigrationsCurrent(templateUrl);

  const client = createDbClient(templateUrl);
  try {
    console.log(`[build-test-template] installing DB invariants…`);
    await installDbInvariants(client.db);
    console.log(`[build-test-template] seeding test users…`);
    await seedTestUsers(client.db);
  } finally {
    await client.close();
  }

  await assertMigratedTemplateReady(templateUrl);

  const hash = computeTemplateHash();
  writeHash(hash);
  console.log(
    `[test-template-provenance] source=db:migrate applied=${expectedTags.join(',')}` +
      ' rerun=no-op journal=exact current-invariants=exact seed=complete',
  );
  console.log(`[build-test-template] done. hash=${hash.slice(0, 12)}…`);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  buildTestTemplate().catch((err) => {
    console.error('[build-test-template] failed:', err);
    process.exit(1);
  });
}

// Re-export for tests/scripts that import the legacy resolveBranchUrl
// to inspect the persistent template branch.
export { resolveBranchUrl };
