// `BASE_URL` resolves to the per-worker test app URL set by
// `tests/setup/per-worker-setup.ts` (Task #700). Each vitest worker
// spawns its own Express via `server/test-entry.ts` on a kernel-
// assigned loopback port, then exports
// `process.env.TEST_BASE_URL=http://127.0.0.1:<port>`. Direct
// invocations use the local development server fallback.
import { eq, inArray } from 'drizzle-orm';
import { getTestDb } from './setup/test-db';
import {
  organizations,
  users,
  bowlers,
  leagues,
  locations,
  adminEmailChangeAudits,
  adminProfileEditAudits,
  adminPasswordResetAudits,
  adminRoleChangeAudits,
  orphanCleanupAudits,
  applePayJobs,
  deletionRequests,
} from '@shared/schema';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:5000';

// We do NOT cache the Drizzle client at module-load time. helpers.ts
// is imported transitively before `tests/setup/per-worker-setup.ts`
// has rewritten `TEST_DATABASE_URL`, so binding the pool early would
// bind to the wrong DB. Each call site calls `getTestDb()` lazily and
// pg-pool memoises internally on `TEST_DATABASE_URL`.

const TEST_ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || 'admin@example.com';
const TEST_ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || 'admin-local-dev';
const TEST_ORG_A_EMAIL = process.env.TEST_ORG_A_EMAIL || 'testadmin@example.com';
const TEST_ORG_B_EMAIL = process.env.TEST_ORG_B_EMAIL || 'testadmin2@example.com';
const TEST_ORG_PASSWORD = process.env.TEST_ORG_PASSWORD || 'org-local-dev';
const TEST_NEW_ORG_ADMIN_PASSWORD = process.env.TEST_NEW_ORG_ADMIN_PASSWORD || 'new-org-admin-local-dev';

const TEST_ORG_A_SLUG = process.env.TEST_ORG_A_SLUG || 'vitest-org-a';
const TEST_ORG_B_SLUG = process.env.TEST_ORG_B_SLUG || 'vitest-org-b';

/**
 * Slugs that belong to LIVE customer organizations on this dev DB
 * (real tenants with real bowlers and real payments — NOT demo data,
 * not test fixtures). The fixture helpers below
 * MUST refuse any operation against these slugs even if a future
 * test or contributor passes one in by mistake. The cleanup script
 * (`scripts/cleanup-test-organizations.ts`) maintains the same list
 * in `PROTECTED_SLUGS` for the same reason — keep both in sync.
 *
 * Filed under Task #609.
 */
const LIVE_CUSTOMER_ORG_SLUGS = [
  'perfect-game',
  'lets-roll-bowling',
  'sun-valley-lanes-games',
] as const;

interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: { message: string; code?: string };
}

/**
 * Every test request resolves to a loopback `req.ip`, so
 * test files that intentionally burst a per-IP rate limiter
 * (e.g. `payments-provider-guards`) will starve every later test in
 * the same vitest invocation that touches the same limiter.
 *
 * The server-side limiters in `server/middleware/rate-limit.ts` skip
 * enforcement when this header is present with the literal value `1`
 * AND `NODE_ENV !== 'production'`. The header value is intentionally a
 * fixed literal — the security gate is the NODE_ENV check, which
 * production deploys short-circuit on regardless of any header an
 * attacker might send. Using a literal (rather than the
 * `TRUST_PROXY_PROBE_TOKEN` secret used by `verify-trust-proxy-deploy`)
 * means the bypass works in every environment that runs the vitest
 * suite, including GitHub CI.
 */
function withTestBypassHeader(headers: Record<string, string>): Record<string, string> {
  headers['x-test-rate-limit-bypass'] = '1';
  // Stop the dev server's live `applePayWorker` from racing apple-pay
  // job tests that share the same DB. Without this, any test that POSTs
  // to a route which calls `applePayWorker.kick()` (e.g. /retry,
  // /register-all-domains) wakes the worker, which then claims `pending`
  // rows another test file just inserted and flips them to `running`,
  // breaking that file's claim/recovery assertions (#569). The header
  // is only honoured when NODE_ENV !== 'production' (see
  // server/utils/test-suppression.ts), so it can never disable the
  // production worker.
  headers['x-test-suppress-apple-pay-kick'] = '1';
  return headers;
}

export interface AuthSession {
  cookies: string;
  user: {
    id: number;
    email: string;
    name: string;
    role: string;
    organizationId: number | null;
  };
  csrfToken: string;
}

async function extractCookies(response: Response): Promise<string> {
  const setCookie = response.headers.getSetCookie?.() ?? [];
  return setCookie.map(c => c.split(';')[0]).join('; ');
}

async function getCsrfToken(cookies: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/csrf-token`, {
    headers: withTestBypassHeader({ Cookie: cookies }),
  });
  const data: ApiResponse<{ token: string }> = await res.json();
  return data.data?.token ?? '';
}

/**
 * Per-file in-memory cache of `login()` results, keyed by test file + email.
 *
 * The auth round-trip (`POST /api/auth/login` + a follow-up
 * `GET /api/csrf-token` to mint the CSRF pair) is ~150-300ms each. The
 * majority of API tests log in 1-3 immutable fixture users (the seeded
 * system admin, org-A admin, org-B admin) inside `beforeAll` and reuse
 * the resulting session across every `it` in the file. Caching by email
 * collapses every call after the first to a synchronous map lookup,
 * shaving ~10-30s off `npm test` (#688).
 *
 * Lifetime semantics:
 *   - With vitest's default `isolate: true`, each test file gets its own
 *     module instance, so this map is per-file. Cookies are never
 *     shared across files (which is desirable — different files run in
 *     different worker processes).
 *   - The cache stores the in-flight `Promise<AuthSession>` (not the
 *     resolved value) so concurrent first calls dedupe to a single HTTP
 *     round-trip instead of racing.
 *
 * When you MUST bypass the cache (because the suite mutates the auth
 * state of the cached user, or it deliberately wants two distinct
 * sessions for the same email), call `purgeSessionCache(email)` first.
 * Examples in the wild: `change-password.test.ts`,
 * `change-password-lockout.test.ts`, `set-password.test.ts` — all of
 * which rotate the user's password mid-test and need a fresh login
 * afterward.
 */
const loginCache: Map<string, Promise<AuthSession>> = new Map();

function getCallingTestFile(): string {
  const stack = new Error().stack ?? '';
  const match = stack.match(
    /(?:^|\n)\s+at .*?([A-Za-z]:[\\/].*?tests[\\/].+?\.test\.[tj]sx?|\S*tests[\\/].+?\.test\.[tj]sx?)(?::\d+:\d+)?/,
  );
  return match?.[1]?.replaceAll('\\', '/') ?? '<unknown-test-file>';
}

function loginCacheKey(email: string): string {
  return `${getCallingTestFile()}::${email}`;
}

/**
 * Drop the cached `login()` result for `email` so the next `login()`
 * call performs a real HTTP round-trip. Use this AFTER any flow that
 * invalidates the underlying credential or session (password change,
 * password set, account deletion) and BEFORE issuing a second
 * `login()` for the same email when the suite needs two distinct
 * session objects.
 */
export function purgeSessionCache(email: string): void {
  for (const key of loginCache.keys()) {
    if (key.endsWith(`::${email}`)) {
      loginCache.delete(key);
    }
  }
}

export async function login(email: string, password: string): Promise<AuthSession> {
  const key = loginCacheKey(email);
  const cached = loginCache.get(key);
  if (cached !== undefined) return cached;

  const promise = (async (): Promise<AuthSession> => {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: withTestBypassHeader({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ email, password }),
    });

    const cookies = await extractCookies(res);
    const data: ApiResponse = await res.json();

    if (!res.ok || !data.success) {
      throw new Error(`Login failed for ${email}: ${data.error?.message ?? res.statusText}`);
    }

    const csrfToken = await getCsrfToken(cookies);

    return {
      cookies,
      user: data.data as AuthSession['user'],
      csrfToken,
    };
  })();

  // Cache the in-flight promise so concurrent callers dedupe. Drop it
  // on rejection so a transient failure doesn't poison every later
  // call in the file with the original error.
  loginCache.set(key, promise);
  promise.catch(() => {
    if (loginCache.get(key) === promise) {
      loginCache.delete(key);
    }
  });
  return promise;
}

export async function apiGet<T = unknown>(
  path: string,
  session?: AuthSession,
): Promise<{ status: number; data: ApiResponse<T> }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (session) headers['Cookie'] = session.cookies;

  const res = await fetch(`${BASE_URL}${path}`, {
    headers: withTestBypassHeader(headers),
  });
  const data: ApiResponse<T> = await res.json();
  return { status: res.status, data };
}

export async function apiPost<T = unknown>(
  path: string,
  body: unknown,
  session?: AuthSession,
): Promise<{ status: number; data: ApiResponse<T> }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (session) {
    headers['Cookie'] = session.cookies;
    headers['x-csrf-token'] = session.csrfToken;
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: withTestBypassHeader(headers),
    body: JSON.stringify(body),
  });
  const data: ApiResponse<T> = await res.json();
  return { status: res.status, data };
}

export async function apiPatch<T = unknown>(
  path: string,
  body: unknown,
  session?: AuthSession,
): Promise<{ status: number; data: ApiResponse<T> }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (session) {
    headers['Cookie'] = session.cookies;
    headers['x-csrf-token'] = session.csrfToken;
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'PATCH',
    headers: withTestBypassHeader(headers),
    body: JSON.stringify(body),
  });
  const data: ApiResponse<T> = await res.json();
  return { status: res.status, data };
}

export async function apiDelete<T = unknown>(
  path: string,
  session?: AuthSession,
): Promise<{ status: number; data: ApiResponse<T> }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (session) {
    headers['Cookie'] = session.cookies;
    headers['x-csrf-token'] = session.csrfToken;
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'DELETE',
    headers: withTestBypassHeader(headers),
  });
  const data: ApiResponse<T> = await res.json();
  return { status: res.status, data };
}

/**
 * Look up the seeded vitest baseline organizations by slug.
 *
 * Task #607: every test file used to insert its own organization in
 * its `beforeAll`, leaking hundreds of rows into the dev DB over
 * time. The supported pattern now is to attach test users / bowlers
 * to one of the two baselines that `seedTestUsers()` provisions
 * (`vitest-org-a` / `vitest-org-b`). Tests are still responsible for
 * cleaning up the rows they insert (users / bowlers / audits / etc),
 * but the org row itself is permanent.
 *
 * Throws if the baselines are missing — that means the seeder has
 * not run, which is a setup error, not a runtime quirk to swallow.
 */
async function getBaselineOrgIds(): Promise<{ orgAId: number; orgBId: number }> {
  const rows = await getTestDb()
    .select({ id: organizations.id, slug: organizations.slug })
    .from(organizations)
    .where(inArray(organizations.slug, [TEST_ORG_A_SLUG, TEST_ORG_B_SLUG]));
  const a = rows.find((r) => r.slug === TEST_ORG_A_SLUG);
  const b = rows.find((r) => r.slug === TEST_ORG_B_SLUG);
  if (!a || !b) {
    throw new Error(
      `Baseline test orgs missing (looked for ${TEST_ORG_A_SLUG} / ${TEST_ORG_B_SLUG}). ` +
        'Run `npx tsx tests/setup/seed-test-users.ts` to provision them.',
    );
  }
  return { orgAId: a.id, orgBId: b.id };
}

async function getBaselineOrgAId(): Promise<number> {
  const { orgAId } = await getBaselineOrgIds();
  return orgAId;
}

/**
 * Acquire (or recreate) a dedicated, deterministic-slug fixture
 * organization for tests that genuinely need an org distinct from
 * the shared baselines (e.g. last-admin-in-org guards, or the
 * organizations CRUD suite that creates and then deletes its own
 * subject row).
 *
 * The deterministic slug is the key difference from the old per-run
 * pattern: even if a previous run crashed before its afterAll
 * cleanup, the next call here finds the leftover row, tears down
 * its dependents, and re-creates it fresh. The total org-row count
 * across runs stays flat. (Task #607.)
 */
async function acquireFixtureOrg(slug: string, name: string): Promise<number> {
  // Refuse to clobber the LIVE customer slugs (real tenants with
  // real bowlers and real payments). Belt-and-suspenders: even if a
  // future test passes one of these in by mistake, we never write
  // to it.
  if ((LIVE_CUSTOMER_ORG_SLUGS as readonly string[]).includes(slug)) {
    throw new Error(
      `acquireFixtureOrg refuses to operate on "${slug}" — that is a live ` +
        'customer organization on the dev DB, not a test fixture.',
    );
  }
  // Refuse to clobber the seeded vitest baseline slugs — those are
  // owned by the seeder, not by individual fixtures.
  if (slug === TEST_ORG_A_SLUG || slug === TEST_ORG_B_SLUG) {
    throw new Error(`acquireFixtureOrg refuses to overwrite baseline slug "${slug}"`);
  }
  await releaseFixtureOrg(slug);
  const [row] = await getTestDb()
    .insert(organizations)
    .values({ name, slug, active: true })
    .returning({ id: organizations.id });
  return row.id;
}

/**
 * Tear down a fixture org by deterministic slug — including every
 * dependent row that would otherwise block the delete. Safe to call
 * for a slug that has no row (no-op).
 */
async function releaseFixtureOrg(slug: string): Promise<void> {
  if ((LIVE_CUSTOMER_ORG_SLUGS as readonly string[]).includes(slug)) {
    throw new Error(
      `releaseFixtureOrg refuses to delete "${slug}" — that is a live ` +
        'customer organization on the dev DB, not a test fixture.',
    );
  }
  if (slug === TEST_ORG_A_SLUG || slug === TEST_ORG_B_SLUG) {
    throw new Error(`releaseFixtureOrg refuses to delete baseline slug "${slug}"`);
  }
  const [existing] = await getTestDb()
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, slug));
  if (!existing) return;

  const orgId = existing.id;
  const userRows = await getTestDb()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.organizationId, orgId));
  const userIds = userRows.map((r) => r.id);
  const bowlerRows = await getTestDb()
    .select({ id: bowlers.id })
    .from(bowlers)
    .where(eq(bowlers.organizationId, orgId));
  const bowlerIds = bowlerRows.map((r) => r.id);

  await getTestDb().transaction(async (tx) => {
    if (userIds.length > 0) {
      // RESTRICT audit tables that point at users.id — delete by
      // both target and actor.
      await tx
        .delete(adminEmailChangeAudits)
        .where(inArray(adminEmailChangeAudits.targetUserId, userIds));
      await tx
        .delete(adminEmailChangeAudits)
        .where(inArray(adminEmailChangeAudits.actorUserId, userIds));
      await tx
        .delete(adminProfileEditAudits)
        .where(inArray(adminProfileEditAudits.targetUserId, userIds));
      await tx
        .delete(adminProfileEditAudits)
        .where(inArray(adminProfileEditAudits.actorUserId, userIds));
      await tx
        .delete(adminPasswordResetAudits)
        .where(inArray(adminPasswordResetAudits.targetUserId, userIds));
      await tx
        .delete(adminPasswordResetAudits)
        .where(inArray(adminPasswordResetAudits.actorUserId, userIds));
      await tx
        .delete(adminRoleChangeAudits)
        .where(inArray(adminRoleChangeAudits.targetUserId, userIds));
      await tx
        .delete(adminRoleChangeAudits)
        .where(inArray(adminRoleChangeAudits.actorUserId, userIds));
      await tx
        .delete(orphanCleanupAudits)
        .where(inArray(orphanCleanupAudits.adminUserId, userIds));
      // NO ACTION FKs into users — null them out.
      await tx
        .update(applePayJobs)
        .set({ createdBy: null })
        .where(inArray(applePayJobs.createdBy, userIds));
      await tx
        .update(deletionRequests)
        .set({ reviewedBy: null })
        .where(inArray(deletionRequests.reviewedBy, userIds));
    }
    if (bowlerIds.length > 0) {
      await tx
        .update(users)
        .set({ bowlerId: null })
        .where(inArray(users.bowlerId, bowlerIds));
    }
    await tx.delete(leagues).where(eq(leagues.organizationId, orgId));
    await tx.delete(bowlers).where(eq(bowlers.organizationId, orgId));
    await tx.delete(users).where(eq(users.organizationId, orgId));
    await tx.delete(locations).where(eq(locations.organizationId, orgId));
    await tx.delete(organizations).where(eq(organizations.id, orgId));
  });
}

export {
  BASE_URL,
  TEST_ADMIN_EMAIL,
  TEST_ADMIN_PASSWORD,
  TEST_ORG_A_EMAIL,
  TEST_ORG_B_EMAIL,
  TEST_ORG_PASSWORD,
  TEST_NEW_ORG_ADMIN_PASSWORD,
  getBaselineOrgIds,
  getBaselineOrgAId,
  acquireFixtureOrg,
  releaseFixtureOrg,
};
