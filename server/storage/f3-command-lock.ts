import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "../db.js";

/** Dedicated namespace for F3 command serialization. This is intentionally
 * separate from the two-int organization/league schedule lock namespace. */
export function f3AuthorizationCommandLockKey(organizationId: number, leagueId: number, commandKey: string): string {
  if (!Number.isSafeInteger(organizationId) || organizationId <= 0) throw new Error("organizationId must be positive");
  if (!Number.isSafeInteger(leagueId) || leagueId <= 0) throw new Error("leagueId must be positive");
  if (!commandKey.trim()) throw new Error("commandKey must be non-empty");
  if (commandKey.length > 255) throw new Error("commandKey exceeds 255 characters");
  const digest = createHash("sha256")
    .update(`leaguevault:f3-command:v1\0${organizationId}\0${leagueId}\0${commandKey}`)
    .digest();
  return BigInt.asIntN(64, digest.readBigInt64BE(0)).toString();
}

export interface F3AuthorizationCommandLock {
  client: PoolClient;
  key: string;
  release: () => Promise<void>;
}

/** Session-scoped locking keeps the provider call outside all DB
 * transactions while serializing replay/provider/authorization on one
 * tenant-league-command key. A disconnected session releases the lock. */
export async function acquireF3AuthorizationCommandLock(
  organizationId: number,
  leagueId: number,
  commandKey: string,
): Promise<F3AuthorizationCommandLock> {
  const key = f3AuthorizationCommandLockKey(organizationId, leagueId, commandKey);
  const client = await pool.connect();
  let released = false;
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [key]);
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
        const result = await client.query<{ unlocked: boolean }>("SELECT pg_advisory_unlock($1::bigint) AS unlocked", [key]);
        if (result.rows[0]?.unlocked !== true) throw new Error("F3 command session lock was not held");
        client.release();
      } catch (error) {
        client.release(true);
        throw error;
      }
    },
  };
}
