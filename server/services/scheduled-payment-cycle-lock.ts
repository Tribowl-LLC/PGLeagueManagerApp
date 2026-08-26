import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "../db.js";

export function normalizeScheduledBillingCycle(value: string | Date): string {
  const parsed = value instanceof Date ? value : new Date(
    /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(value)
      ? value
      : `${value.replace(" ", "T")}Z`,
  );
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("scheduled billing cycle timestamp is invalid");
  }
  return parsed.toISOString();
}

/** Stable signed bigint accepted by PostgreSQL's advisory-lock functions. */
export function scheduledPaymentCycleLockKey(
  paymentScheduleId: number,
  billingCycleAt: string | Date,
): string {
  if (!Number.isSafeInteger(paymentScheduleId) || paymentScheduleId <= 0) {
    throw new Error("paymentScheduleId must be a positive safe integer");
  }
  const digest = createHash("sha256")
    .update(`leaguevault:scheduled-payment-cycle:v1\0${paymentScheduleId}\0${normalizeScheduledBillingCycle(billingCycleAt)}`)
    .digest();
  return BigInt.asIntN(64, digest.readBigInt64BE(0)).toString();
}

export interface LegacyScheduledCycleLock {
  client: PoolClient;
  key: string;
  release: () => Promise<void>;
}

export async function acquireLegacyScheduledCycleLock(
  paymentScheduleId: number,
  billingCycleAt: string | Date,
  waitForLock = false,
): Promise<LegacyScheduledCycleLock | undefined> {
  const key = scheduledPaymentCycleLockKey(paymentScheduleId, billingCycleAt);
  const client = await pool.connect();
  let released = false;
  try {
    if (waitForLock) {
      await client.query("SELECT pg_advisory_lock($1::bigint)", [key]);
    } else {
      const result = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
        [key],
      );
      if (result.rows[0]?.acquired !== true) {
        client.release();
        return undefined;
      }
    }
  } catch (error) {
    client.release(true);
    throw error;
  }
  return {
    client,
    key,
    release: async () => {
      if (released) return;
      released = true;
      try {
        const result = await client.query<{ unlocked: boolean }>(
          "SELECT pg_advisory_unlock($1::bigint) AS unlocked",
          [key],
        );
        if (result.rows[0]?.unlocked !== true) {
          throw new Error("scheduled payment advisory unlock was not confirmed");
        }
        client.release();
      } catch (error) {
        client.release(true);
        throw error;
      }
    },
  };
}

/**
 * Archive/rollover fencing acquires every currently active legacy cycle lock
 * in deterministic key order, then performs its short league transaction.
 * The cycle locks deliberately sit outside the DB transaction so the lock
 * order is cycle lock -> league advisory lock, matching the callback path.
 */
export async function withLegacyScheduledCycleLocksForLeague<T>(
  leagueId: number,
  work: () => Promise<T>,
): Promise<T> {
  const rows = await pool.query<{ id: number; next_payment_date: string }>(
    `SELECT id, next_payment_date
       FROM payment_schedules
      WHERE league_id = $1 AND active = TRUE
      ORDER BY id ASC, next_payment_date ASC`,
    [leagueId],
  );
  const cycles = [...rows.rows].sort((left, right) => {
    const leftKey = scheduledPaymentCycleLockKey(left.id, left.next_payment_date);
    const rightKey = scheduledPaymentCycleLockKey(right.id, right.next_payment_date);
    return leftKey.localeCompare(rightKey) || left.id - right.id;
  });
  const locks: LegacyScheduledCycleLock[] = [];
  try {
    for (const cycle of cycles) {
      const lock = await acquireLegacyScheduledCycleLock(cycle.id, cycle.next_payment_date, true);
      if (!lock) throw new Error("failed to acquire legacy scheduled payment cycle lock");
      locks.push(lock);
    }
    return await work();
  } finally {
    for (const lock of locks.reverse()) await lock.release();
  }
}

export async function withLegacyScheduledCycleLock<T>(
  paymentScheduleId: number,
  billingCycleAt: string | Date,
  work: () => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const lock = await acquireLegacyScheduledCycleLock(paymentScheduleId, billingCycleAt);
  if (!lock) return { acquired: false };
  try {
    return { acquired: true, value: await work() };
  } finally {
    await lock.release();
  }
}
