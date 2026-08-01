/**
 * Multi-instance behaviour test for PostgresRateLimitStore (task #356).
 *
 * The whole point of moving rate-limit state into Postgres is so that
 * a quota set on one app process is observed by every other process
 * pointed at the same database. The original MemoryStore couldn't do
 * that, so a multi-replica deployment effectively gave every client
 * `max * replicas` requests per window.
 *
 * Each test case stands up TWO independent `PostgresRateLimitStore`
 * instances against the SAME pool — that's the closest single-process
 * approximation of "two app replicas pointing at the same db". A
 * shared store is correct iff hits made on instance A are immediately
 * visible to instance B and vice versa.
 *
 * We also cover the per-prefix isolation (so e.g. the `login` limiter
 * doesn't share a key namespace with the `change-password` limiter)
 * and the `resetKey` / `resetAll` paths used elsewhere in the app.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { PostgresRateLimitStore, stopRateLimitGc } from '../../server/utils/rate-limit-store';
import { pool } from '../../server/db';

const WINDOW_MS = 5_000;

function makeStore(prefix: string): PostgresRateLimitStore {
  const store = new PostgresRateLimitStore({ prefix });
  // express-rate-limit normally calls init() with the parsed options.
  store.init({ windowMs: WINDOW_MS } as never);
  return store;
}

describe('PostgresRateLimitStore (task #356)', () => {
  let prefix: string;

  beforeAll(() => {
    // Each test run gets its own prefix so it can't be polluted by
    // previous runs. UUID keeps the namespace globally unique.
    prefix = `test-${randomUUID()}`;
  });

  afterEach(async () => {
    // Clean up rows for this run's prefix only — leaves any other
    // limiter buckets untouched.
    await pool.query('DELETE FROM rate_limit_buckets WHERE key LIKE $1', [`${prefix}%:%`]);
  });

  afterAll(() => {
    // Reset the opportunistic GC cooldown for any later test file.
    stopRateLimitGc();
  });

  it('shares hit counts between two store instances on the same pool', async () => {
    // Simulates two app replicas: each constructs its own store
    // against the same database.
    const replicaA = makeStore(`${prefix}-share`);
    const replicaB = makeStore(`${prefix}-share`);

    const a1 = await replicaA.increment('user:42');
    expect(a1.totalHits).toBe(1);

    const b1 = await replicaB.increment('user:42');
    // If state were per-process this would be 1; with the shared
    // store replica B sees replica A's hit and returns 2.
    expect(b1.totalHits).toBe(2);

    const a2 = await replicaA.increment('user:42');
    expect(a2.totalHits).toBe(3);
  });

  it('isolates keys between different limiter prefixes', async () => {
    const loginStore = makeStore(`${prefix}-login`);
    const changePwStore = makeStore(`${prefix}-change-password`);

    await loginStore.increment('shared-key');
    await loginStore.increment('shared-key');
    const changePwFirstHit = await changePwStore.increment('shared-key');

    // change-password limiter shouldn't see login's hits even though
    // the inner key is identical.
    expect(changePwFirstHit.totalHits).toBe(1);
  });

  it('returns the same resetTime for hits within the same window', async () => {
    const store = makeStore(`${prefix}-window`);

    const first = await store.increment('user:1');
    const second = await store.increment('user:1');

    expect(second.totalHits).toBe(2);
    expect(second.resetTime?.getTime()).toBe(first.resetTime?.getTime());
  });

  it('resetKey clears the bucket for one key only', async () => {
    const store = makeStore(`${prefix}-reset`);

    await store.increment('keep');
    await store.increment('clear');
    await store.increment('clear');

    await store.resetKey('clear');

    const keepHit = await store.increment('keep');
    const clearHit = await store.increment('clear');

    // 'keep' continues incrementing from its prior value (1 -> 2).
    expect(keepHit.totalHits).toBe(2);
    // 'clear' restarts from zero (-> 1).
    expect(clearHit.totalHits).toBe(1);
  });

  it('decrement reduces the count without going below zero', async () => {
    const store = makeStore(`${prefix}-dec`);

    await store.increment('user:1');
    await store.increment('user:1');
    await store.decrement('user:1');
    const after = await store.get('user:1');
    expect(after?.totalHits).toBe(1);

    await store.decrement('user:1');
    await store.decrement('user:1');
    const floor = await store.get('user:1');
    expect(floor?.totalHits).toBe(0);
  });

  it('rejects prefixes containing LIKE wildcards or the separator', () => {
    // These would compromise namespace isolation: ':' would let a
    // limiter share keys with siblings; '%' / '_' would make
    // resetAll() match unrelated buckets.
    expect(() => new PostgresRateLimitStore({ prefix: 'has:colon' })).toThrow(/invalid prefix/);
    expect(() => new PostgresRateLimitStore({ prefix: 'has%pct' })).toThrow(/invalid prefix/);
    expect(() => new PostgresRateLimitStore({ prefix: 'has_underscore' })).toThrow(/invalid prefix/);
    expect(() => new PostgresRateLimitStore({ prefix: '' })).toThrow(/required/);
  });

  it('resetAll only clears keys for this prefix', async () => {
    const storeA = makeStore(`${prefix}-A`);
    const storeB = makeStore(`${prefix}-B`);

    await storeA.increment('k1');
    await storeA.increment('k2');
    await storeB.increment('k1');

    await storeA.resetAll();

    expect(await storeA.get('k1')).toBeUndefined();
    expect(await storeA.get('k2')).toBeUndefined();
    // B's key should still be there.
    const bAfter = await storeB.get('k1');
    expect(bAfter?.totalHits).toBe(1);
  });
});
