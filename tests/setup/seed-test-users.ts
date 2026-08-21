/**
 * Idempotent seeder for the accounts the test suite depends on.
 *
 * Reuses the same env var / default convention as `tests/helpers.ts` so
 * developers can override credentials without touching this file.
 *
 * Safe to run multiple times: existing users are updated in place
 * (password rehashed, role/orgId enforced) and existing orgs are reused.
 */
import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { db as defaultDb } from '../../server/db';
import * as schema from '@shared/schema';
import { leagues, organizations, users } from '@shared/schema';
import { hashPassword } from '../../server/lib/password';
import {
  assertSafeDatabaseHost,
  hasProductionDeploymentEvidence,
} from '../../server/utils/db-safety';

type AnyDb = NodePgDatabase<typeof schema>;

/**
 * Hard guard: this seeder forcibly resets passwords / roles / org for any
 * user matching the configured test emails. Running it against a production
 * database would silently overwrite real accounts. Refuse unless process
 * metadata is non-production, or the operator explicitly opts in via
 * ALLOW_TEST_SEED=1.
 */
function assertSafeEnvironment(): void {
  const nodeEnv = process.env.NODE_ENV;
  const allowOverride = process.env.ALLOW_TEST_SEED === '1';
  if (allowOverride) return;
  if (hasProductionDeploymentEvidence(process.env)) {
    throw new Error(
      'Refusing to run test-user seeder: production/deployment evidence is present ' +
        `(APP_ENV=${process.env.APP_ENV ?? '<unset>'}, NODE_ENV=${nodeEnv ?? '<unset>'}, ` +
        `APP_DOMAIN=${process.env.APP_DOMAIN ?? '<unset>'}). ` +
        'Set ALLOW_TEST_SEED=1 only if you really intend to write test accounts to this database.',
    );
  }
}

const TEST_ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || 'admin@example.com';
const TEST_ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || 'admin-local-dev';
const TEST_ORG_A_EMAIL = process.env.TEST_ORG_A_EMAIL || 'testadmin@example.com';
const TEST_ORG_B_EMAIL = process.env.TEST_ORG_B_EMAIL || 'testadmin2@example.com';
const TEST_ORG_PASSWORD = process.env.TEST_ORG_PASSWORD || 'org-local-dev';

const TEST_ORG_A_SLUG = process.env.TEST_ORG_A_SLUG || 'vitest-org-a';
const TEST_ORG_B_SLUG = process.env.TEST_ORG_B_SLUG || 'vitest-org-b';

async function ensureOrganization(db: AnyDb, name: string, slug: string): Promise<number> {
  const [existing] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, slug));
  if (existing) return existing.id;

  const [created] = await db
    .insert(organizations)
    .values({ name, slug, active: true })
    .returning({ id: organizations.id });
  return created.id;
}

interface UserSpec {
  email: string;
  password: string;
  name: string;
  role: 'system_admin' | 'org_admin' | 'user';
  organizationId: number | null;
}

/**
 * Ensure each test org has at least one baseline league so tests
 * that need to link a bowler/team to a league (e.g. the
 * `tests/api/bowler-leagues-*.test.ts` suites) have something to
 * attach to on a freshly-provisioned database.
 *
 * Without this, those tests pass on developer machines (where prior
 * runs have left leagues lying around) but fail in CI on a clean DB
 * at the `expect(list.length).toBeGreaterThan(0)` precondition. The
 * fixture is matched by stable (organizationId, name) so re-runs
 * don't accumulate duplicates and the row is reused across the
 * whole suite.
 *
 * Kept minimal: only the columns the schema marks as NOT NULL
 * without a default. Everything else falls back to the schema
 * defaults (active=true, weeklyFee, paymentMode='weekly',
 * seasonNumber=1, empty skip/cancel arrays).
 */
async function ensureBaselineLeague(
  db: AnyDb,
  organizationId: number,
  name: string,
): Promise<void> {
  const [existing] = await db
    .select({ id: leagues.id })
    .from(leagues)
    .where(and(eq(leagues.organizationId, organizationId), eq(leagues.name, name)));
  if (existing) return;

  // Far-future season so anything that filters by "currently active"
  // still picks it up regardless of the wall clock.
  await db.insert(leagues).values({
    name,
    organizationId,
    seasonStart: '2025-01-01',
    seasonEnd: '2099-12-31',
    weekDay: 'Monday',
  });
}

async function ensureUser(db: AnyDb, spec: UserSpec): Promise<void> {
  const hashed = await hashPassword(spec.password);
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, spec.email));

  if (existing) {
    await db
      .update(users)
      .set({
        password: hashed,
        role: spec.role,
        organizationId: spec.organizationId,
        name: spec.name,
        // Task #576: reset the change-password lockout state every
        // time the seeder runs. `tests/api/csrf-coverage.test.ts`
        // intentionally fires a wrong-password attempt against this
        // user to prove the CSRF gate, which bumps
        // `failedPasswordChangeAttempts`. Without this reset, after
        // enough consecutive vitest invocations against the same DB
        // the shared user crosses
        // `PASSWORD_CHANGE_LOCKOUT_THRESHOLD` and the test starts
        // failing with `ACCOUNT_LOCKED` instead of the expected
        // `INVALID_PASSWORD`. Clearing both columns at seed time
        // makes the suite reliable on local re-runs and on CI
        // against a long-lived database.
        failedPasswordChangeAttempts: 0,
        passwordChangeLockedUntil: null,
      })
      .where(eq(users.id, existing.id));
    return;
  }

  await db.insert(users).values({
    email: spec.email,
    password: hashed,
    name: spec.name,
    role: spec.role,
    organizationId: spec.organizationId,
  });
}

export async function seedTestUsers(db: AnyDb = defaultDb): Promise<void> {
  assertSafeEnvironment();
  // Second, INDEPENDENT layer of defense (Task #609). Even if the
  // operator's NODE_ENV is wrong (e.g. development) but their
  // DATABASE_URL still points at the production tenant, this guard
  // refuses to run. See `server/utils/db-safety.ts`.
  assertSafeDatabaseHost('seed-test-users');
  const orgAId = await ensureOrganization(db, 'Vitest Org A', TEST_ORG_A_SLUG);
  const orgBId = await ensureOrganization(db, 'Vitest Org B', TEST_ORG_B_SLUG);

  await ensureUser(db, {
    email: TEST_ADMIN_EMAIL,
    password: TEST_ADMIN_PASSWORD,
    name: 'Vitest System Admin',
    role: 'system_admin',
    organizationId: null,
  });

  await ensureUser(db, {
    email: TEST_ORG_A_EMAIL,
    password: TEST_ORG_PASSWORD,
    name: 'Vitest Org A Admin',
    role: 'org_admin',
    organizationId: orgAId,
  });

  await ensureUser(db, {
    email: TEST_ORG_B_EMAIL,
    password: TEST_ORG_PASSWORD,
    name: 'Vitest Org B Admin',
    role: 'org_admin',
    organizationId: orgBId,
  });

  // Baseline league per test org — see `ensureBaselineLeague` above
  // for why. Names are unique per org so tests that need a stable
  // identifier (or want to ignore the baseline and search for their
  // own) can do either.
  await ensureBaselineLeague(db, orgAId, 'Vitest Org A Baseline League');
  await ensureBaselineLeague(db, orgBId, 'Vitest Org B Baseline League');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seedTestUsers()
    .then(() => {
      console.log('Test users seeded.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Failed to seed test users:', err);
      process.exit(1);
    });
}
