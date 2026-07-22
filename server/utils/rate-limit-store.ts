/**
 * Postgres-backed Store for express-rate-limit (task #356).
 *
 * The default MemoryStore keeps counts in process-local memory, so
 * once we run more than one app instance / replica the same client
 * effectively gets `max * replicas` requests per window. Backing the
 * limiter with the existing pg pool keeps the budget consistent
 * across every process pointed at the same database.
 *
 * Schema is declared in `shared/schema/rate-limit-buckets.ts` and the active
 * normalized baseline. One
 * row per (limiter, key) tuple; the per-limiter `prefix` argument is
 * prepended to every stored key so a single table can serve every
 * limiter without bucket collisions.
 *
 * The store also runs a low-frequency in-process GC sweep that
 * deletes rows whose `reset_at` has passed. With `ON CONFLICT … DO
 * UPDATE` semantics in `increment` the table is self-repairing
 * (expired rows get reused as soon as the same key is seen again),
 * so the sweep is purely a size optimisation — losing it would not
 * affect correctness.
 */
import type { Store, IncrementResponse, Options as RateLimitOptions } from 'express-rate-limit';
import type { Pool } from 'pg';
import { pool as defaultPool } from '../db.js';
import { createLogger } from '../logger';
import {
  assertProductionRateLimitStore,
  usesSharedRateLimitStore,
} from './rate-limit-environment';

const log = createLogger('RateLimitStore');

const GC_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const GC_SWEEP_BATCH_LIMIT = 1000;

let sharedSweepTimer: NodeJS.Timeout | null = null;

async function sweepExpiredBuckets(p: Pool): Promise<void> {
  try {
    const result = await p.query(
      `DELETE FROM rate_limit_buckets
       WHERE key IN (
         SELECT key FROM rate_limit_buckets
         WHERE reset_at <= now()
         LIMIT $1
       )`,
      [GC_SWEEP_BATCH_LIMIT],
    );
    if ((result.rowCount ?? 0) > 0) {
      log.debug('Swept expired rate-limit buckets', { count: result.rowCount });
    }
  } catch (err) {
    // Best-effort: a failed sweep doesn't affect correctness, only
    // table size. Log so it shows up in monitoring if it persists.
    log.error('Rate-limit GC sweep failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Process-singleton timer. Re-entered when the first store is
 * constructed; cleared by `shutdown()` (only useful for tests).
 */
function ensureGcTimer(p: Pool): void {
  if (sharedSweepTimer) return;
  sharedSweepTimer = setInterval(() => {
    void sweepExpiredBuckets(p);
  }, GC_SWEEP_INTERVAL_MS);
  // Don't keep the event loop alive just for the sweep — Node
  // should shut down cleanly when nothing else is pending.
  sharedSweepTimer.unref?.();
}

export function stopRateLimitGc(): void {
  if (sharedSweepTimer) {
    clearInterval(sharedSweepTimer);
    sharedSweepTimer = null;
  }
}

export interface PostgresRateLimitStoreOptions {
  /** Unique per-limiter namespace prepended to every key. Required. */
  prefix: string;
  /** Override the default app pool (only useful for tests). */
  pool?: Pool;
}

export class PostgresRateLimitStore implements Store {
  public readonly prefix: string;
  public windowMs!: number;
  private readonly pool: Pool;

  constructor(opts: PostgresRateLimitStoreOptions) {
    if (!opts.prefix || opts.prefix.length === 0) {
      throw new Error('PostgresRateLimitStore: `prefix` is required');
    }
    // The prefix is used both as a literal join (`${prefix}:${key}`)
    // and inside a LIKE pattern in `resetAll()`. A prefix containing
    // `:` would let a sibling limiter accidentally share a namespace,
    // and one containing `%` or `_` (both LIKE wildcards) would let
    // `resetAll()` match unrelated buckets. Restrict to a safe
    // alphanumeric/dash/dot alphabet so we fail fast on any future
    // call site mistake.
    if (!/^[A-Za-z0-9.-]+$/.test(opts.prefix)) {
      throw new Error(
        `PostgresRateLimitStore: invalid prefix ${JSON.stringify(opts.prefix)} — must match /^[A-Za-z0-9.-]+$/`,
      );
    }
    this.prefix = opts.prefix;
    this.pool = opts.pool ?? defaultPool;
  }

  /**
   * express-rate-limit invokes this once at construction time,
   * giving us the windowMs to use when seeding `reset_at`.
   */
  init(options: RateLimitOptions): void {
    this.windowMs = options.windowMs;
    ensureGcTimer(this.pool);
  }

  private fullKey(key: string): string {
    return `${this.prefix}:${key}`;
  }

  async increment(key: string): Promise<IncrementResponse> {
    const fullKey = this.fullKey(key);
    // Atomic upsert: if the existing window has expired, reset count
    // to 1 and start a new window; otherwise increment the existing
    // count and keep the existing reset_at. Done in a single
    // statement so two concurrent requests from different replicas
    // can't race past `max`.
    const sql = `
      INSERT INTO rate_limit_buckets (key, count, reset_at)
      VALUES ($1, 1, now() + ($2 || ' milliseconds')::interval)
      ON CONFLICT (key) DO UPDATE
      SET count = CASE
        WHEN rate_limit_buckets.reset_at <= now() THEN 1
        ELSE rate_limit_buckets.count + 1
      END,
      reset_at = CASE
        WHEN rate_limit_buckets.reset_at <= now()
          THEN now() + ($2 || ' milliseconds')::interval
        ELSE rate_limit_buckets.reset_at
      END
      RETURNING count, reset_at
    `;
    const { rows } = await this.pool.query<{ count: number; reset_at: Date }>(
      sql,
      [fullKey, String(this.windowMs)],
    );
    const row = rows[0]!;
    return {
      totalHits: Number(row.count),
      resetTime: row.reset_at,
    };
  }

  async decrement(key: string): Promise<void> {
    await this.pool.query(
      `UPDATE rate_limit_buckets
       SET count = GREATEST(count - 1, 0)
       WHERE key = $1`,
      [this.fullKey(key)],
    );
  }

  async resetKey(key: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM rate_limit_buckets WHERE key = $1`,
      [this.fullKey(key)],
    );
  }

  /** Drops every bucket for THIS limiter only (prefix-scoped). */
  async resetAll(): Promise<void> {
    await this.pool.query(
      `DELETE FROM rate_limit_buckets WHERE key LIKE $1`,
      [`${this.prefix}:%`],
    );
  }

  async get(key: string): Promise<{ totalHits: number; resetTime: Date } | undefined> {
    const { rows } = await this.pool.query<{ count: number; reset_at: Date }>(
      `SELECT count, reset_at FROM rate_limit_buckets WHERE key = $1`,
      [this.fullKey(key)],
    );
    if (rows.length === 0) return undefined;
    const row = rows[0]!;
    return { totalHits: Number(row.count), resetTime: row.reset_at };
  }
}

/**
 * Convenience factory used from rateLimit({ store: createSharedRateLimitStore('login') })
 * call sites. Keeps the noise at each call site to one line.
 *
 * In non-production environments (NODE_ENV !== 'production') this returns
 * `undefined`, which causes express-rate-limit to fall back to its default
 * per-process MemoryStore. That preserves the historical dev/test behaviour
 * where each test run starts with empty buckets — without that, tests
 * sharing the loopback IP would inherit accumulated hits from prior runs
 * and immediately get 429s. Production deployments (which is the only
 * place multi-replica matters) always get the shared Postgres store.
 *
 * Tests that explicitly want to exercise the Postgres store path can
 * construct `new PostgresRateLimitStore({ prefix })` directly.
 */
export function createSharedRateLimitStore(prefix: string): PostgresRateLimitStore | undefined {
  assertProductionRateLimitStore(process.env);
  if (!usesSharedRateLimitStore(process.env)) {
    return undefined;
  }
  return new PostgresRateLimitStore({ prefix });
}
