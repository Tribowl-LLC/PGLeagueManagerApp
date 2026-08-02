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
): Promise<LegacyScheduledCycleLock | undefined> {
  const key = scheduledPaymentCycleLockKey(paymentScheduleId, billingCycleAt);
  const client = await pool.connect();
  let released = false;
  try {
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
      [key],
    );
    if (result.rows[0]?.acquired !== true) {
      client.release();
      return undefined;
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
