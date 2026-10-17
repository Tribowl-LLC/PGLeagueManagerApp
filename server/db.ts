import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";
import { env } from "./config";
import { createLogger } from './logger';

const log = createLogger("Database");

/**
 * Per-instance database client (Task #699).
 *
 * Builds a fresh `pg.Pool` + Drizzle wrapper bound to an arbitrary
 * `databaseUrl`, separate from the singleton below. The returned
 * `close()` ends only this pool — it never touches the singleton —
 * so callers (e.g. the per-worker test app spawned via
 * `server/test-entry.ts`) can dispose of their own connection pool
 * without affecting `npm run dev`.
 *
 * No retries, no shutdown registration: the caller owns the lifecycle.
 */
export interface DbClient {
  pool: pg.Pool;
  db: NodePgDatabase<typeof schema>;
  close: () => Promise<void>;
}

export function createDbClient(databaseUrl: string): DbClient {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 50,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  const db = drizzle({ client: pool, schema });
  return {
    pool,
    db,
    close: async () => {
      try {
        await pool.end();
      } catch (err) {
        log.error('Error closing per-instance pg pool:', err);
      }
    },
  };
}

// A new Neon connection costs roughly 100-250ms (TLS plus authentication),
// and one page load fans out into several parallel requests. Keeping a small
// warm floor means a page opened after a quiet half minute reuses connections
// instead of every request opening its own. `allowExitOnIdle` stops that floor
// from holding open a script that imports this pool and never ends it.
export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 50,
  min: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  allowExitOnIdle: true,
});
export const db = drizzle({ client: pool, schema });

let isShuttingDown = false;

pool.on('error', (err, client) => {
  log.error('Unexpected error on idle client', err);
});

pool.on('connect', (client) => {
  log.info('New client connected to pool');
  client.on('error', (err) => {
    log.error('Error on client', err);
  });
});

export async function testConnection(
  retries = 3,
  delay = 1000,
  poolOverride?: pg.Pool,
): Promise<boolean> {
  // Per-instance pool override (Task #699). When createApp is built with
  // a per-instance DbClient, the connection probe must hit THAT pool —
  // otherwise the singleton's pool gets probed instead and the override
  // can silently report healthy against the wrong DB.
  const target = poolOverride ?? pool;
  let client = null;
  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      client = await target.connect();
      await client.query('SELECT 1');
      log.info('Connection test successful');
      return true;
    } catch (error) {
      lastError = error;
      log.error(`Connection attempt ${attempt} failed:`, error);

      if (attempt === retries) {
        throw lastError;
      }

      await new Promise(resolve => setTimeout(resolve, delay * attempt));
    } finally {
      if (client) {
        try {
          client.release();
        } catch (releaseError) {
          log.error('Error releasing test connection:', releaseError);
        }
      }
    }
  }
  return false;
}


async function testCleanup(): Promise<void> {
  log.info('Starting cleanup test...');

  const client = await pool.connect();

  try {
    await client.query('SELECT 1');
    log.info('Test query executed successfully');
  } finally {
    client.release();
    log.info('Client released successfully');
  }

  await cleanup();
  log.info('Cleanup test completed');
}

export async function cleanup(): Promise<void> {
  if (isShuttingDown) {
    log.info('Cleanup already in progress');
    return;
  }

  isShuttingDown = true;
  log.info('Starting pool cleanup...');

  const POOL_CLEANUP_TIMEOUT_MS = 5000;
  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      pool.end().finally(() => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }),
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error('Pool cleanup timeout')),
          POOL_CLEANUP_TIMEOUT_MS,
        );
        // Don't let this safety-net timer keep the Node event loop
        // alive on its own. If pool.end() resolves quickly we want
        // the process to exit immediately, which is critical for the
        // vitest teardown path (#276).
        timeoutHandle.unref?.();
      }),
    ]);

    log.info('Pool cleanup completed');
  } catch (error) {
    log.error('Error during pool cleanup:', error);
  } finally {
    isShuttingDown = false;
  }
}
