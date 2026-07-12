/**
 * Build the per-worker test template database (Task #699 / Phase 1)
 * with optional Neon-branches backend (Task #723).
 *
 * Two modes:
 *
 *   1. **Neon Branches API** — when `NEON_API_KEY` and
 *      `NEON_PROJECT_ID` are set:
 *        a. Look up the persistent template branch by name (default
 *           `LeagueVault_Test_Template`); recreate it from the
 *           production branch if a previous run left children behind.
 *        b. Patch out any `expires_at` so the branch can be a parent.
 *        c. Run drizzle-kit push, installDbInvariants, seedTestUsers
 *           against the branch's connection URL.
 *
 *   2. **Legacy** — drops + recreates `leaguevault_test_template` on
 *      the same Postgres server pointed at by `DATABASE_URL`, then
 *      runs the same drizzle-kit push / invariants / seed sequence.
 *
 * In both modes the schema-input hash is written to
 * `.local/test-template-hash` so `ensure-test-template.ts` can decide
 * whether to rebuild on subsequent runs.
 *
 * Safe to run repeatedly. The drop/branch-replace refuses to run
 * against a host the dev-DB allow-list rejects (same
 * `assertSafeDatabaseHost` rail every other destructive script uses).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { assertSafeDatabaseHost } from '../server/utils/db-safety';
import { createDbClient } from '../server/db';
import { installDbInvariants } from '../server/db-invariants';
import { seedTestUsers } from '../tests/setup/seed-test-users';
import {
  createBranchWithEndpoint,
  deleteBranch,
  ensureBranchPersistent,
  findBranchByName,
  getNeonConfig,
  listBranches,
  resolveTemplateParentBranch,
  resolveBranchUrl,
  TEMPLATE_BRANCH_NAME,
  type NeonConfig,
} from '../tests/setup/neon-branches';

const TEMPLATE_DB_NAME = process.env.TEST_TEMPLATE_DB_NAME ?? 'leaguevault_test_template';
const HASH_FILE = '.local/test-template-hash';

function originalDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL must be set to build the test template database.');
  }
  return url;
}

function templateDatabaseUrl(): string {
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

async function recreateNeonTemplateBranch(cfg: NeonConfig): Promise<string> {
  const tStart = Date.now();
  // 1) Resolve template parent branch (defaults to `main`; falls back
  //    to `production` with a deprecation warning if `main` doesn't
  //    exist and no env override is set). See `resolveTemplateParentBranch`
  //    in `tests/setup/neon-branches.ts` for full resolution rules.
  const prod = await resolveTemplateParentBranch(cfg);

  // 2) If a template branch already exists, delete its children
  //    first (`test_worker_*` branches from a crashed prior run that
  //    bypassed cleanup-test-dbs), then delete the template itself.
  const existingTemplate = await findBranchByName(cfg, TEMPLATE_BRANCH_NAME);
  if (existingTemplate) {
    const all = await listBranches(cfg);
    const children = all.filter((b) => b.parent_id === existingTemplate.id);
    if (children.length > 0) {
      console.log(
        `[build-test-template] deleting ${children.length} child branch(es) before template recreate`,
      );
      await Promise.all(
        children.map((c) =>
          deleteBranch(cfg, c.id).catch((err) => {
            console.warn(
              `[build-test-template] failed to delete child ${c.name}:`,
              err instanceof Error ? err.message : String(err),
            );
          }),
        ),
      );
    }
    console.log(
      `[build-test-template] deleting existing template branch "${TEMPLATE_BRANCH_NAME}" (${existingTemplate.id})`,
    );
    await deleteBranch(cfg, existingTemplate.id);
  }

  // 3) Create a fresh template branch from production with a
  //    read_write endpoint so we can connect to apply schema/seed.
  console.log(
    `[build-test-template] creating template branch "${TEMPLATE_BRANCH_NAME}" from parent "${prod.name}" (${prod.id})`,
  );
  const created = await createBranchWithEndpoint(cfg, prod.id, TEMPLATE_BRANCH_NAME);

  // 4) Clear any default TTL so child worker branches can later
  //    parent off this one. Neon refuses BRANCHING_IS_NOT_ALLOWED
  //    on parents with `expires_at` set.
  await ensureBranchPersistent(cfg, created.branchId);

  console.log(
    `[lv-perf] build-test-template recreate-template branchId=${created.branchId}` +
      ` total=${Date.now() - tStart}ms`,
  );
  return created.url;
}

function runDrizzlePush(targetUrl: string): void {
  const env = { ...process.env, DATABASE_URL: targetUrl };
  const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const result = spawnSync(npxCommand, ['drizzle-kit', 'push', '--force'], {
    stdio: 'inherit',
    env,
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`drizzle-kit push failed with exit code ${result.status ?? 'unknown'}`);
  }
}

/**
 * Hash of the inputs that determine whether the template is stale.
 * Bumped whenever `shared/schema/**`, `server/db-invariants.ts`, or
 * `tests/setup/seed-test-users.ts` change.
 */
export function computeTemplateHash(): string {
  const hasher = createHash('sha256');
  const inputs: Array<{ root: string; recursive: boolean }> = [
    { root: 'shared/schema', recursive: true },
    { root: 'server/db-invariants.ts', recursive: false },
    { root: 'tests/setup/seed-test-users.ts', recursive: false },
  ];

  const files: string[] = [];
  for (const { root, recursive } of inputs) {
    let s;
    try {
      s = statSync(root);
    } catch {
      continue;
    }
    if (s.isFile()) {
      files.push(root);
    } else if (s.isDirectory() && recursive) {
      collect(root, files);
    }
  }
  files.sort();
  for (const f of files) {
    hasher.update(relative(process.cwd(), f));
    hasher.update('\0');
    hasher.update(readFileSync(f));
    hasher.update('\0');
  }
  return hasher.digest('hex');
}

function collect(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) collect(p, out);
    else if (entry.isFile()) out.push(p);
  }
}

function writeHash(hash: string): void {
  mkdirSync(dirname(HASH_FILE), { recursive: true });
  writeFileSync(HASH_FILE, `${hash}\n`, 'utf8');
}

export async function buildTestTemplate(): Promise<void> {
  // Independent host-allow-list guard: refuse to wipe a database
  // unless the operator's DATABASE_URL is on the dev allow-list.
  // (Asserted on the original DATABASE_URL, before any branch-URL
  // swap — the original is the dev host registered in the allow-list.)
  assertSafeDatabaseHost('build-test-template');

  const cfg = getNeonConfig();
  let templateUrl: string;
  if (cfg) {
    console.log(`[build-test-template] mode=neon-branches; recreating template branch…`);
    templateUrl = await recreateNeonTemplateBranch(cfg);
  } else {
    console.log(
      `[build-test-template] mode=legacy; dropping + recreating "${TEMPLATE_DB_NAME}"…`,
    );
    await recreateLegacyTemplateDb();
    templateUrl = templateDatabaseUrl();
  }

  console.log(`[build-test-template] running drizzle-kit push --force against template…`);
  runDrizzlePush(templateUrl);

  const client = createDbClient(templateUrl);
  try {
    console.log(`[build-test-template] installing DB invariants…`);
    await installDbInvariants(client.db);
    console.log(`[build-test-template] seeding test users…`);
    await seedTestUsers(client.db);
  } finally {
    await client.close();
  }

  const hash = computeTemplateHash();
  writeHash(hash);
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
