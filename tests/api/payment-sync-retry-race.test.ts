/**
 * Multi-process race coverage for `runPaymentSyncRetrySweep` (#362).
 *
 * The unit suite (`tests/unit/payment-sync-retry.test.ts`) mocks the
 * database, so it can prove the sweep's bookkeeping but it can NOT
 * prove that two ticks running against a real Postgres won't double-
 * call the payment provider for the same flagged bowler. Task #321
 * added `FOR UPDATE OF bowlers SKIP LOCKED` to that sweep, and task
 * #361 extracted it into the shared `lockedSweep` helper.
 *
 * Two cases live here, both gated behind RUN_BOOTSTRAP_RACE_TESTS=1:
 *
 *   1. Natural race ("two parallel sweeps"):
 *      Seed one flagged bowler, fire two `runPaymentSyncRetrySweep()`
 *      via `Promise.all`. Loop until we observe the contention shape
 *      (one tick acquired the row, the other reported
 *      `skippedByLock >= 1`) and assert `syncBowlerForUser` was
 *      invoked exactly once for the row.
 *
 *   2. Sentinel-held lock ("SKIP LOCKED returns immediately"):
 *      The natural race above can pass even if `SKIP LOCKED` were
 *      silently replaced with a blocking `FOR UPDATE`, because the
 *      lease update that moves `payment_sync_next_retry_at` forward
 *      would still cause the loser's predicate-drift to report
 *      `skippedByLock = 1` after the lock-wait completes. To
 *      distinguish "skipped immediately" from "waited then drifted",
 *      this case opens a sentinel transaction that holds the row
 *      lock for `SENTINEL_HOLD_MS`, races two sweeps inside that
 *      window, and asserts the parallel sweeps complete in WAY
 *      LESS than `SENTINEL_HOLD_MS`. A regression that drops
 *      `SKIP LOCKED` would block on the sentinel and the wall-
 *      clock assertion would fail loudly.
 *
 * Why opt-in (RUN_BOOTSTRAP_RACE_TESTS=1):
 *   This file mocks `server/storage` and the `syncBowlerForUser`
 *   export of `server/services/payment-customer-sync` at the module
 *   level. Vitest isolates module mocks per test file, but the file
 *   ALSO writes to the shared `bowlers` table during the race
 *   loop. To stay safe alongside the rest of the suite under
 *   `npm test`, we gate it behind the same env flag the bootstrap
 *   race already uses (#319, #360) so it only runs as a serial
 *   step via `bash scripts/test-race.sh`.
 *
 * Why a retry loop on the natural race:
 *   The sweep's critical section (BEGIN, COUNT, SELECT FOR UPDATE
 *   SKIP LOCKED, UPDATE, COMMIT) is entirely DB-internal and very
 *   fast. With perfectly-ordered Promise.all dispatch the contention
 *   window is reliable, but the loser's transaction can occasionally
 *   start AFTER the winner commits — at which point the row no
 *   longer matches the due predicate (the lease update moved
 *   `payment_sync_next_retry_at` into the future) and the
 *   loser sees zero rows with no contention recorded. We retry up to
 *   `MAX_RACE_ATTEMPTS` looking for the contention case and fail
 *   loudly if we never observe it (which would indicate the sweep no
 *   longer takes the row lock at all — exactly the regression this
 *   test is here to catch). The sentinel-lock case below provides the
 *   deterministic counterpart that the natural race can't.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';

const RUN = process.env.RUN_BOOTSTRAP_RACE_TESTS === '1';

// Bowler ids the linked-user storage stub should answer for. Populated
// in beforeAll once the seeded row exists; consulted inside the
// vi.mock factory below via closure (mocks are hoisted but this Set
// is a top-level binding, so the reference resolves at call time).
const linkedBowlerIds = new Set<number>();

const mockSyncBowlerForUser = vi.fn();
const mockGetUserByBowlerId = vi.fn();

// The sweep imports `storage` from '../storage'. Replace just the
// one method the sweep uses; everything else in the storage surface
// stays untouched (this file never exercises another storage call).
vi.mock('../../server/storage', () => ({
  storage: {
    getUserByBowlerId: (...args: unknown[]) => mockGetUserByBowlerId(...args),
  },
}));

// Preserve the rest of payment-customer-sync (PAYMENT_SYNC_MAX_ATTEMPTS,
// the PaymentSyncStatus type, etc.) and override only the network-
// touching helper. The mock returns 'synced' so the winning tick
// records a success; the actual DB row mutation that the real helper
// would do is irrelevant — we re-seed the row each iteration.
vi.mock('../../server/services/payment-customer-sync', async () => {
  const actual = await vi.importActual<typeof import('../../server/services/payment-customer-sync')>(
    '../../server/services/payment-customer-sync',
  );
  return {
    ...actual,
    syncBowlerForUser: (...args: unknown[]) => mockSyncBowlerForUser(...args),
  };
});

// These imports MUST come after the vi.mock calls above. Vitest hoists
// vi.mock to the top of the file at compile time, so the runtime order
// of these statements doesn't matter, but keeping them below the mocks
// makes the dependency direction obvious to a human reader.
import { db } from '../../server/db';
import { bowlers, organizations } from '@shared/schema';
import { runPaymentSyncRetrySweep } from '../../server/services/payment-sync-retry';

const MAX_RACE_ATTEMPTS = 30;

interface SeededBowler {
  id: number;
  organizationId: number;
}

const seededBowlerIds: number[] = [];

async function getOrgAId(): Promise<number> {
  const slug = process.env.TEST_ORG_A_SLUG || 'vitest-org-a';
  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, slug));
  if (!org) {
    throw new Error(
      `Vitest org A ('${slug}') not seeded. Run \`npm run seed\` (or rely on global-setup) before invoking the race suite.`,
    );
  }
  return org.id;
}

async function seedFlaggedBowler(orgId: number): Promise<SeededBowler> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [row] = await db
    .insert(bowlers)
    .values({
      name: `Race Bowler ${suffix}`,
      email: `race-${suffix}@vitest.local`,
      organizationId: orgId,
      // Set a pending-since timestamp far enough in the past that the
      // backoff predicate (`last_attempt + 60s * 2^attempts <= NOW()`)
      // is trivially satisfied even with attempts=0.
      paymentSyncPendingAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      paymentSyncAttempts: 0,
      paymentSyncLastAttemptAt: null,
      paymentSyncNextRetryAt: new Date(Date.now() - 60_000).toISOString(),
    })
    .returning({ id: bowlers.id, organizationId: bowlers.organizationId });
  seededBowlerIds.push(row.id);
  linkedBowlerIds.add(row.id);
  return row;
}

async function resetForNextIteration(bowlerId: number): Promise<void> {
  // Clear the lease state that the previous (winning) sweep tick set,
  // and reset attempts/next-due time so the row is eligible again. The mocked
  // syncBowlerForUser doesn't touch any DB columns itself, so the
  // pending flag is still set from the original insert.
  await db
    .update(bowlers)
    .set({
      paymentSyncAttempts: 0,
      paymentSyncLastAttemptAt: null,
      paymentSyncNextRetryAt: new Date(Date.now() - 60_000).toISOString(),
    })
    .where(eq(bowlers.id, bowlerId));
}

async function deleteSeededBowlers(): Promise<void> {
  if (seededBowlerIds.length === 0) return;
  await db.delete(bowlers).where(inArray(bowlers.id, seededBowlerIds));
  seededBowlerIds.length = 0;
  linkedBowlerIds.clear();
}

describe.skipIf(!RUN)('payment-sync retry sweep — multi-process race coverage', () => {
  let orgAId: number;

  beforeAll(async () => {
    orgAId = await getOrgAId();
  });

  beforeEach(() => {
    mockSyncBowlerForUser.mockReset();
    mockGetUserByBowlerId.mockReset();

    // The storage stub answers ONLY for ids we've explicitly seeded
    // in this file. Anything else (e.g. a stray eligible bowler left
    // over from another test) returns null so the sweep treats it as
    // "no linked user" and skips it without calling the provider.
    mockGetUserByBowlerId.mockImplementation(async (bowlerId: number) => {
      if (!linkedBowlerIds.has(bowlerId)) return null;
      return {
        id: 1_000_000 + bowlerId,
        name: 'Linked Race User',
        email: `linked-${bowlerId}@vitest.local`,
        phone: null,
        locationId: null,
        organizationId: orgAId,
      };
    });

    // The mocked provider call always succeeds. We don't need to
    // exercise the failure paths here — those are covered by the
    // unit suite. What we DO care about is whether it's invoked
    // more than once per row across the parallel ticks.
    mockSyncBowlerForUser.mockResolvedValue('synced');
  });

  afterAll(async () => {
    await deleteSeededBowlers();
  });

  it(
    'two parallel runPaymentSyncRetrySweep() calls: exactly one claims the row, the other reports skippedByLock >= 1',
    async () => {
      const seeded = await seedFlaggedBowler(orgAId);

      let observedRace = false;
      let lastSummaries: Array<Awaited<ReturnType<typeof runPaymentSyncRetrySweep>>> = [];
      let lastSyncCallsForRow = -1;

      for (let attempt = 1; attempt <= MAX_RACE_ATTEMPTS; attempt++) {
        await resetForNextIteration(seeded.id);
        mockSyncBowlerForUser.mockClear();

        const [a, b] = await Promise.all([
          runPaymentSyncRetrySweep(),
          runPaymentSyncRetrySweep(),
        ]);
        lastSummaries = [a, b];

        // Count provider invocations targeting OUR seeded row only —
        // unrelated eligible bowlers (none expected, but defensive)
        // would otherwise inflate the count.
        const callsForRow = mockSyncBowlerForUser.mock.calls.filter(
          ([userArg]) => (userArg as { bowlerId?: number } | undefined)?.bowlerId === seeded.id,
        ).length;
        lastSyncCallsForRow = callsForRow;

        const winners = [a, b].filter((s) => s.retried >= 1);
        const losersWithContention = [a, b].filter((s) => s.skippedByLock >= 1);

        // The desired race outcome: one tick won the lock and
        // retried (callsForRow === 1), the other tick saw the row
        // as locked (skippedByLock >= 1).
        if (
          callsForRow === 1 &&
          winners.length === 1 &&
          losersWithContention.length >= 1
        ) {
          observedRace = true;
          break;
        }

        // Defensive: if both ticks ever managed to retry the same
        // row in the same race, the SKIP LOCKED guard is broken and
        // we should fail immediately instead of looping.
        if (callsForRow > 1) {
          throw new Error(
            `payment-sync retry SKIP LOCKED guard regressed: bowler ${seeded.id} ` +
              `was retried ${callsForRow} times across two parallel sweeps in attempt ${attempt}. ` +
              `summaries=${JSON.stringify(lastSummaries)}`,
          );
        }
      }

      if (!observedRace) {
        throw new Error(
          `Never observed lock contention for bowler ${seeded.id} across ${MAX_RACE_ATTEMPTS} ` +
            `parallel sweep pairs. Last summaries=${JSON.stringify(lastSummaries)}, ` +
            `syncBowlerForUser calls for row=${lastSyncCallsForRow}. ` +
            `This usually means runPaymentSyncRetrySweep no longer wraps its candidate ` +
            `selection in a FOR UPDATE SKIP LOCKED transaction (see task #321 / #361).`,
        );
      }

      // Final sanity assertions on the iteration that observed the race.
      expect(lastSyncCallsForRow).toBe(1);
      const winners = lastSummaries.filter((s) => s.retried >= 1);
      const losersWithContention = lastSummaries.filter((s) => s.skippedByLock >= 1);
      expect(winners).toHaveLength(1);
      expect(losersWithContention.length).toBeGreaterThanOrEqual(1);

      // The winning tick should also be the one whose `succeeded`
      // counter went up (the mocked syncBowlerForUser returns 'synced').
      const winner = winners[0];
      expect(winner.scanned).toBeGreaterThanOrEqual(1);
      expect(winner.retried).toBe(1);
      expect(winner.succeeded).toBe(1);
    },
    // Each iteration is fast (a handful of DB roundtrips), but the
    // worst case across 30 retries warrants a generous ceiling so a
    // slow CI runner doesn't flake on us.
    30_000,
  );

  it(
    'SKIP LOCKED returns immediately when a peer holds the row lock — sweeps do not block',
    async () => {
      // This case exists to catch a regression that the natural-race
      // test above could MISS: if `.for('update', { skipLocked: true })`
      // were silently changed to `.for('update')` (blocking lock), the
      // natural race would still appear to pass because the loser's
      // post-wait predicate-drift would still report `skippedByLock=1`
      // (its count saw the row, then sweep A's lease update moved
      // nextRetryAt forward, so the locked SELECT after the wait
      // returns 0 rows). Wallclock is the only signal that
      // distinguishes "skipped immediately" from "waited then drifted".
      const seeded = await seedFlaggedBowler(orgAId);
      await resetForNextIteration(seeded.id);
      mockSyncBowlerForUser.mockClear();

      const SENTINEL_HOLD_MS = 1500;

      // Explicit lock-ready handshake: the sentinel resolves
      // `lockAcquired` AFTER its `SELECT ... FOR UPDATE` returns,
      // which is the exact moment the row lock is held. We then
      // await that promise before racing the sweeps — eliminating
      // the timing-flake risk of a fixed head-start delay.
      let signalLockAcquired!: () => void;
      const lockAcquired = new Promise<void>((resolve) => {
        signalLockAcquired = resolve;
      });

      // Sentinel transaction: lock the row, signal acquisition,
      // then sleep, then commit. We do NOT await this promise yet —
      // we want it running while we race the sweeps.
      const sentinelPromise = db.transaction(async (tx) => {
        // Use a raw SELECT FOR UPDATE on the seeded row so the lock
        // shape matches what the sweep would acquire. We pin to the
        // single row (no predicate) to avoid racing the sweep's own
        // eligibility filter.
        await tx.execute(sql`SELECT id FROM ${bowlers} WHERE id = ${seeded.id} FOR UPDATE`);
        signalLockAcquired();
        await new Promise<void>((resolve) => setTimeout(resolve, SENTINEL_HOLD_MS));
      });

      // Wait until the sentinel has actually acquired the row lock
      // before kicking off the race. Cap the wait so a sentinel
      // failure surfaces as a clear timeout rather than hanging the
      // suite.
      await Promise.race([
        lockAcquired,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('sentinel never acquired the row lock')), 5000),
        ),
      ]);

      const start = Date.now();
      const [a, b] = await Promise.all([
        runPaymentSyncRetrySweep(),
        runPaymentSyncRetrySweep(),
      ]);
      const elapsed = Date.now() - start;

      // Wait for the sentinel to release before any cleanup runs.
      await sentinelPromise;

      // Both sweeps should have observed the row as locked. Predicate
      // drift can't help anyone here: the sentinel does NOT mutate the
      // row, so the eligibility predicate stays `true` for both
      // sweeps' COUNT *and* their FOR UPDATE SKIP LOCKED select.
      // skippedByLock is therefore exactly 1 for whichever sweep
      // observed the row in its count (often both).
      expect(mockSyncBowlerForUser).not.toHaveBeenCalled();
      expect(a.scanned).toBe(0);
      expect(b.scanned).toBe(0);
      expect(a.retried).toBe(0);
      expect(b.retried).toBe(0);
      expect(a.skippedByLock + b.skippedByLock).toBeGreaterThanOrEqual(1);

      // The headline assertion: SKIP LOCKED returns immediately. If
      // the sweep had blocked on the sentinel (regression to plain
      // FOR UPDATE), elapsed would be >= SENTINEL_HOLD_MS. We allow
      // generous slack (50% of the hold window) so a slow CI runner
      // still has comfortable margin while a real regression — which
      // would push elapsed all the way up to ~1500ms — fails loudly.
      expect(elapsed).toBeLessThan(SENTINEL_HOLD_MS / 2);
    },
    // Sentinel hold + sweep race + cleanup all fit comfortably in
    // ~2 seconds, but match the timeout style of the case above.
    30_000,
  );
});
