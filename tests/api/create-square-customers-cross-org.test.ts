/**
 * Task #465 — DB-seeded pin for the cross-org guard added in task #437.
 *
 * Task #437 added two invariants to
 * `server/scripts/create-square-customers.ts`:
 *   1. A pre-flight `assertLocationBelongsToOrg` check that exits 1 if
 *      the supplied `--locationId` does not belong to the supplied
 *      `--organizationId`. Without this, an operator could point the
 *      script at one org's Square access token + another org's bowlers
 *      and silently mis-route every cleanup call those rows make later.
 *   2. A defense-in-depth org filter on the bowler SELECT *and* the
 *      bowler UPDATE, so a future tweak to the loop body can't
 *      accidentally cross the boundary.
 *
 * The existing `tests/unit/create-square-customers-script.test.ts`
 * pins only the argument-parsing surface (missing/non-numeric flags).
 * That covers the early-exit path but never actually proves the DB
 * invariants — the highest-risk part of the fix is exactly that the
 * script will REFUSE to run with mismatched org/location ids and that
 * its UPDATE will not touch other-org rows. Inspection alone is what
 * stands behind that today; this test pins it with a real DB seed.
 *
 * The script's Square SDK client is now built via a thin
 * `buildSquareClient()` factory that honours `SQUARE_CLIENT_IMPL_PATH`
 * when NODE_ENV !== 'production' (smallest possible refactor — see the
 * script for the prod-safety gate). Test 2 below points the script at
 * `tests/fixtures/fake-square-client.ts` so the bowler UPDATE branch
 * runs end-to-end without burning a real Square sandbox round-trip.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../server/db';
import { bowlers, locations } from '@shared/schema';
import { acquireFixtureOrg, releaseFixtureOrg } from '../helpers';
import { TSX_CLI } from '../helpers/tsx-command';

// Task #607: deterministic-slug fixture orgs that are torn down +
// recreated per run. Each org has its own scratch location and the
// single bowler we want the script to (or refuse to) touch — that's
// the smallest possible surface for the cross-org guard test, and it
// keeps the seeded baseline orgs out of the script's SELECT path.
const ORG_A_SLUG = 'vitest-csc-org-a';
const ORG_B_SLUG = 'vitest-csc-org-b';

const SCRIPT = join(process.cwd(), 'server/scripts/create-square-customers.ts');
const FAKE_SQUARE = join(process.cwd(), 'tests/fixtures/fake-square-client.ts');

// Each invocation cold-starts tsx + imports server/db before the guard
// fires (~6s empirically; see existing unit-test rationale). Two
// invocations + the final read-back fits comfortably under a minute.
const SCRIPT_TIMEOUT_MS = 60_000;

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  combined: string;
}

function runScript(env: Record<string, string | undefined>, args: string[]): RunResult {
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') childEnv[k] = v;
  }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) {
      delete childEnv[k];
    } else {
      childEnv[k] = v;
    }
  }
  const r = spawnSync(process.execPath, [TSX_CLI, SCRIPT, ...args], {
    env: childEnv,
    encoding: 'utf-8',
    timeout: SCRIPT_TIMEOUT_MS,
  });
  return {
    status: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    combined: (r.stdout || '') + (r.stderr || ''),
  };
}

interface SeedIds {
  orgAId: number;
  orgBId: number;
  locationAId: number;
  locationBId: number;
  bowlerAId: number;
  bowlerBId: number;
}

// Populated in beforeAll. Reads guard against the unpopulated state via
// `requireSeed()` so the test fails loudly with a clear message instead
// of letting `undefined` flow into a `db.where(eq(..., undefined))`.
let seededIds: SeedIds | null = null;

function requireSeed(): SeedIds {
  if (!seededIds) throw new Error('Test seed not initialised — beforeAll did not run.');
  return seededIds;
}

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

beforeAll(async () => {
  // Two deterministic-slug fixture orgs so the script's org-filtered
  // SELECT only ever sees the one bowler we put in each — no chance
  // of stomping unrelated bowlers from the shared seeded baselines
  // that other suites write to. acquireFixtureOrg tears down any
  // leftover from a prior crashed run, then re-creates the org fresh,
  // so the dev-DB row count stays flat across runs (Task #607).
  const orgAId = await acquireFixtureOrg(ORG_A_SLUG, 'Vitest CSC Org A');
  const orgBId = await acquireFixtureOrg(ORG_B_SLUG, 'Vitest CSC Org B');
  const partial: Partial<SeedIds> = { orgAId, orgBId };

  // Locations are unique-per-run so two parallel processes (or a
  // crashed-then-rerun process where acquireFixtureOrg tore the prior
  // org row down) never collide on the locations.name UNIQUE index.
  const suffix = uniqueSuffix();
  const [locationA] = await db
    .insert(locations)
    .values({
      name: `vitest-csc-loc-a-${suffix}`,
      organizationId: orgAId,
      active: true,
      paymentProvider: 'square',
    })
    .returning({ id: locations.id });
  const [locationB] = await db
    .insert(locations)
    .values({
      name: `vitest-csc-loc-b-${suffix}`,
      organizationId: orgBId,
      active: true,
      paymentProvider: 'square',
    })
    .returning({ id: locations.id });
  partial.locationAId = locationA.id;
  partial.locationBId = locationB.id;

  // Both bowlers start with paymentCustomerId = null so the script's
  // SELECT-where-isNull predicate would consider them eligible. The
  // org filter is what must keep the script from touching the wrong
  // one — that's exactly what we're pinning.
  const [bowlerA] = await db
    .insert(bowlers)
    .values({
      name: 'Vitest CSC Bowler A',
      email: `vitest-csc-a-${suffix}@example.com`,
      organizationId: orgAId,
    })
    .returning({ id: bowlers.id });
  const [bowlerB] = await db
    .insert(bowlers)
    .values({
      name: 'Vitest CSC Bowler B',
      email: `vitest-csc-b-${suffix}@example.com`,
      organizationId: orgBId,
    })
    .returning({ id: bowlers.id });
  partial.bowlerAId = bowlerA.id;
  partial.bowlerBId = bowlerB.id;
  seededIds = partial as SeedIds;
});

afterAll(async () => {
  if (!seededIds) return;
  const { bowlerAId, bowlerBId, locationAId, locationBId } = seededIds;
  await db.delete(bowlers).where(inArray(bowlers.id, [bowlerAId, bowlerBId]));
  await db.delete(locations).where(inArray(locations.id, [locationAId, locationBId]));
  // Drop the fixture org rows themselves so the dev-DB org count
  // stays flat across runs (Task #607). releaseFixtureOrg also clears
  // any other dependents that may have been created mid-test.
  await releaseFixtureOrg(ORG_A_SLUG);
  await releaseFixtureOrg(ORG_B_SLUG);
  seededIds = null;
});

describe('create-square-customers.ts — cross-org guard pinned by DB seed (task #465)', () => {
  it('exits non-zero with the task-#437 message and touches no rows when --locationId belongs to a different org', async () => {
    const ids = requireSeed();
    const r = runScript(
      { SQUARE_ACCESS_TOKEN: 'sandbox-fake-token' },
      [`--organizationId=${ids.orgAId}`, `--locationId=${ids.locationBId}`],
    );

    expect(r.status).toBe(1);
    // The operator-facing error must name the wrong org and reference
    // task #437 so the audit trail is unambiguous in production logs.
    expect(r.combined).toMatch(/belongs to organization/i);
    expect(r.combined).toMatch(/task #437/);

    // Neither bowler can have been touched: the guard fires BEFORE
    // the bowler SELECT, so both rows must still be the pristine
    // unstamped state we seeded.
    const [a] = await db.select().from(bowlers).where(eq(bowlers.id, ids.bowlerAId));
    const [b] = await db.select().from(bowlers).where(eq(bowlers.id, ids.bowlerBId));
    expect(a.paymentCustomerId).toBeNull();
    expect(a.paymentProviderLocationId).toBeNull();
    expect(b.paymentCustomerId).toBeNull();
    expect(b.paymentProviderLocationId).toBeNull();
  }, SCRIPT_TIMEOUT_MS);

  it('with matching --organizationId/--locationId and a stubbed Square client, only the in-org bowler is updated', async () => {
    const ids = requireSeed();
    const r = runScript(
      {
        SQUARE_ACCESS_TOKEN: 'sandbox-fake-token',
        SQUARE_CLIENT_IMPL_PATH: FAKE_SQUARE,
      },
      [`--organizationId=${ids.orgAId}`, `--locationId=${ids.locationAId}`],
    );

    expect(r.status).toBe(0);

    const [a] = await db.select().from(bowlers).where(eq(bowlers.id, ids.bowlerAId));
    const [b] = await db.select().from(bowlers).where(eq(bowlers.id, ids.bowlerBId));

    // The in-org bowler gets the stub's fake customer id and the
    // location stamp the operator declared on the CLI.
    expect(a.paymentCustomerId).toMatch(/^vitest-fake-cust-/);
    expect(a.paymentProviderLocationId).toBe(ids.locationAId);

    // The other-org bowler must remain untouched — the script's
    // SELECT-by-orgId AND the UPDATE's where-by-orgId both have to
    // hold for this to be true. If either invariant ever drifts,
    // this assertion fails.
    expect(b.paymentCustomerId).toBeNull();
    expect(b.paymentProviderLocationId).toBeNull();
  }, SCRIPT_TIMEOUT_MS);
});
