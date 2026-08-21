/**
 * Race-condition + status-code regression tests for the first-admin
 * bootstrap (#256).
 *
 * Pins these invariants:
 *   - Two concurrent POST /api/setup/create-first-admin requests cannot
 *     both succeed (advisory lock + in-txn pre-check).
 *   - POST /create-first-admin and POST /first-system-admin/:id share the
 *     same critical section, so racing them produces exactly one winner.
 *   - Success status codes (201 create, 200 promote) and error mappings
 *     (409 EMAIL_EXISTS, 404 USER_NOT_FOUND) survive refactors.
 *
 * Why opt-in (RUN_BOOTSTRAP_RACE_TESTS=1):
 *   This file briefly DELETEs every system_admin row and re-seeds at
 *   teardown. The standard `npm test` run executes other test files in
 *   parallel workers that depend on the seeded admin (auth.test.ts,
 *   users-delete.test.ts, etc.), and they would flake if this file ran
 *   alongside them. The intended invocation is a dedicated step:
 *
 *     RUN_BOOTSTRAP_RACE_TESTS=1 npx vitest run \
 *       tests/api/setup-admin-bootstrap-race.test.ts
 *
 * Why direct localhost + fresh X-Forwarded-For per request:
 *   `setupAdminLimiter` is 5 req / 15 min / IP. We mirror the strategy
 *   from setup-admin-header.test.ts so each request lands in its own
 *   per-IP bucket.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../server/db';
import { organizations, users } from '@shared/schema';
import { hashPassword } from '../../server/lib/password';
import { seedTestUsers } from '../setup/seed-test-users';
import { BASE_URL as SHARED_BASE_URL } from '../helpers';

// Resolution order:
//   1. `SETUP_ADMIN_TEST_BASE_URL` — explicit override for dedicated runs.
//   2. `TEST_BASE_URL` — set by `tests/setup/per-worker-setup.ts` to point
//      at the per-fork test app spawned on a random port. This is the
//      path that fires under `bash scripts/test-race.sh` because vitest
//      brings the per-worker app up alongside the test process; defaulting
//      to `localhost:5000` instead would post to whatever (if anything)
//      happens to be on :5000, while the in-process `db` import below
//      writes to the per-worker DB — guaranteeing `beforeEach`'s admin
//      reset hits a different database than the app under test and every
//      test after the first one fails with 403 ADMIN_EXISTS.
//   3. `http://localhost:5000` — last-resort local fallback (dev server
//      explicitly started by the developer).
const BASE_URL =
  process.env.SETUP_ADMIN_TEST_BASE_URL ||
  SHARED_BASE_URL;
const SETUP_SECRET = process.env.SETUP_SECRET;
const RUN = process.env.RUN_BOOTSTRAP_RACE_TESTS === '1';

let ipCounter = 0;
function freshIp(): string {
  ipCounter += 1;
  return `198.51.100.${(ipCounter % 250) + 1}`;
}

interface PostResult {
  status: number;
  code?: string;
  data?: { id?: number; email?: string; role?: string };
}

async function postCreate(body: {
  email: string;
  password: string;
  name: string;
  phone?: string;
}, secretOverride?: string): Promise<PostResult> {
  const headers = new Headers();
  headers.set('Content-Type', 'application/json');
  headers.set('X-Forwarded-For', freshIp());
  headers.set('X-Forwarded-Proto', 'https');
  headers.set('X-Setup-Secret', secretOverride ?? SETUP_SECRET!);
  const res = await fetch(`${BASE_URL}/api/setup/create-first-admin`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  let parsed: unknown = null;
  try { parsed = await res.json(); } catch { /* empty */ }
  return {
    status: res.status,
    code: (parsed as { error?: { code?: string } } | null)?.error?.code,
    data: (parsed as { data?: PostResult['data'] } | null)?.data,
  };
}

async function postPromote(userId: number): Promise<PostResult> {
  const headers = new Headers();
  headers.set('Content-Type', 'application/json');
  headers.set('X-Forwarded-For', freshIp());
  headers.set('X-Forwarded-Proto', 'https');
  headers.set('X-Setup-Secret', SETUP_SECRET!);
  const res = await fetch(`${BASE_URL}/api/setup/first-system-admin/${userId}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  });
  let parsed: unknown = null;
  try { parsed = await res.json(); } catch { /* empty */ }
  return {
    status: res.status,
    code: (parsed as { error?: { code?: string } } | null)?.error?.code,
    data: (parsed as { data?: PostResult['data'] } | null)?.data,
  };
}

/**
 * Tracks every user we create or touch during the test so afterEach can
 * scrub them by id, even if the test failed mid-flight. We never delete
 * by email pattern alone — the suite must leave no residue.
 */
const createdUserIds = new Set<number>();

async function clearAllSystemAdmins(): Promise<void> {
  await db.delete(users).where(eq(users.role, 'system_admin'));
}

async function deleteTrackedUsers(): Promise<void> {
  if (createdUserIds.size === 0) return;
  await db.delete(users).where(inArray(users.id, [...createdUserIds]));
  createdUserIds.clear();
}

async function uniqueEmail(prefix: string): Promise<string> {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@vitest.local`;
}

describe.skipIf(!RUN)('first-admin bootstrap — race + status-code coverage', () => {
  // Task #360: when the suite is *explicitly* opted into
  // (RUN_BOOTSTRAP_RACE_TESTS=1) but SETUP_SECRET is missing, the
  // POSTs below will all 401 and every meaningful assertion would
  // be impossible to evaluate. Historically we used `it.skip` here,
  // which made a misconfigured CI step look like "6 skipped — pass"
  // and silently destroyed the safety net this suite is supposed to
  // be. Hard-fail with a clear remediation instead so a missing
  // secret cannot be ignored.
  if (!SETUP_SECRET) {
    it('FAILS LOUDLY: SETUP_SECRET must be set when RUN_BOOTSTRAP_RACE_TESTS=1', () => {
      throw new Error(
        'SETUP_SECRET is required for the bootstrap-race suite. ' +
          'Set it in your CI secrets (and locally export it) before running ' +
          '`bash scripts/test-race.sh` / `RUN_BOOTSTRAP_RACE_TESTS=1 npx vitest run ' +
          'tests/api/setup-admin-bootstrap-race.test.ts`. ' +
          'See tests/README.md → "CI wiring" for the full list of required CI secrets.',
      );
    });
    return;
  }

  let scratchOrgId: number;

  beforeAll(async () => {
    // Establish a clean baseline: no system_admin exists.
    await clearAllSystemAdmins();
    // The schema's `users_role_org_required` CHECK forbids non-admin
    // users with a null organizationId, so promote-target / collision
    // rows need to live in some org. Reuse the seeder's org-A row.
    const [orgA] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, process.env.TEST_ORG_A_SLUG || 'vitest-org-a'));
    if (!orgA) throw new Error('Vitest org A not seeded; run seedTestUsers first.');
    scratchOrgId = orgA.id;
  });

  afterAll(async () => {
    // Restore the seeded admin so subsequent test runs (and dev login)
    // keep working. seedTestUsers is idempotent and re-creates by email.
    await deleteTrackedUsers();
    await clearAllSystemAdmins();
    await seedTestUsers();
  });

  beforeEach(async () => {
    // Each test starts from "no system_admin, no test residue".
    await deleteTrackedUsers();
    await clearAllSystemAdmins();
  });

  afterEach(async () => {
    await deleteTrackedUsers();
    await clearAllSystemAdmins();
  });

  // ---- happy paths ----

  it('returns 201 on a single create-first-admin call', async () => {
    const email = await uniqueEmail('race-create');
    const out = await postCreate({
      email,
      password: 'BootstrapRaceTest!2026',
      name: 'Bootstrap Single',
    });
    expect(out.status).toBe(201);
    expect(out.data?.email).toBe(email);
    expect(out.data?.role).toBe('system_admin');
    if (out.data?.id) createdUserIds.add(out.data.id);
  });

  it('returns 200 on a single promote when the target user exists', async () => {
    const email = await uniqueEmail('race-promote');
    const [target] = await db
      .insert(users)
      .values({
        email,
        password: await hashPassword('BootstrapRaceTest!2026'),
        name: 'Promote Target',
        role: 'user',
        organizationId: scratchOrgId,
      })
      .returning({ id: users.id });
    createdUserIds.add(target.id);

    const out = await postPromote(target.id);
    expect(out.status).toBe(200);
    expect(out.data?.id).toBe(target.id);
    expect(out.data?.role).toBe('system_admin');
  });

  // ---- error mappings ----

  it('returns 409 EMAIL_EXISTS when the create email is already taken', async () => {
    const email = await uniqueEmail('race-dup');
    const [collision] = await db
      .insert(users)
      .values({
        email,
        password: await hashPassword('BootstrapRaceTest!2026'),
        name: 'Existing Email',
        role: 'user',
        organizationId: scratchOrgId,
      })
      .returning({ id: users.id });
    createdUserIds.add(collision.id);

    const out = await postCreate({
      email,
      password: 'BootstrapRaceTest!2026',
      name: 'Bootstrap Dup',
    });
    expect(out.status).toBe(409);
    expect(out.code).toBe('EMAIL_EXISTS');
  });

  it('returns 404 USER_NOT_FOUND when promoting a nonexistent user id', async () => {
    const out = await postPromote(2_147_483_000);
    expect(out.status).toBe(404);
    expect(out.code).toBe('USER_NOT_FOUND');
  });

  // ---- the actual race tests ----

  it('two parallel create-first-admin requests: exactly one wins (201), other is 403 ADMIN_EXISTS', async () => {
    const emailA = await uniqueEmail('race-a');
    const emailB = await uniqueEmail('race-b');
    const [a, b] = await Promise.all([
      postCreate({ email: emailA, password: 'BootstrapRaceTest!2026', name: 'Racer A' }),
      postCreate({ email: emailB, password: 'BootstrapRaceTest!2026', name: 'Racer B' }),
    ]);

    if (a.data?.id) createdUserIds.add(a.data.id);
    if (b.data?.id) createdUserIds.add(b.data.id);

    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses).toEqual([201, 403]);

    const loser = a.status === 403 ? a : b;
    expect(loser.code).toBe('ADMIN_EXISTS');
  });

  it('create-first-admin racing against first-system-admin/:id: exactly one wins', async () => {
    // Seed a promotable user before either request fires.
    const promoteEmail = await uniqueEmail('race-target');
    const [target] = await db
      .insert(users)
      .values({
        email: promoteEmail,
        password: await hashPassword('BootstrapRaceTest!2026'),
        name: 'Promote Race Target',
        role: 'user',
        organizationId: scratchOrgId,
      })
      .returning({ id: users.id });
    createdUserIds.add(target.id);

    const createEmail = await uniqueEmail('race-create-vs-promote');
    const [createOut, promoteOut] = await Promise.all([
      postCreate({ email: createEmail, password: 'BootstrapRaceTest!2026', name: 'Create Racer' }),
      postPromote(target.id),
    ]);

    if (createOut.data?.id) createdUserIds.add(createOut.data.id);

    const successes = [createOut, promoteOut].filter((r) => r.status === 200 || r.status === 201);
    const losers = [createOut, promoteOut].filter((r) => r.status === 403);
    expect(successes).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].code).toBe('ADMIN_EXISTS');

    // Whichever path won, the DB ends with exactly one system_admin.
    const admins = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, 'system_admin'));
    expect(admins).toHaveLength(1);
  });
});
