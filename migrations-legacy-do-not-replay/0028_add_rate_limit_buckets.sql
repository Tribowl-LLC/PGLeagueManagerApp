-- Task #356: shared store for express-rate-limit so per-route limits
-- can't be bypassed by spreading requests across multiple app
-- replicas / processes.
--
-- One row per (limiter, key) pair. The `key` already encodes the
-- limiter name as a prefix (e.g. "login:ip:1.2.3.4",
-- "change-password:u:42") so a single table is enough — the per-
-- limiter prefix keeps namespaces separate without needing one table
-- per limiter.
--
-- `count` is the number of hits in the current window for this key.
-- `reset_at` is the wall-clock instant at which the count rolls back
-- to zero (computed as `now() + windowMs` on the first hit of a
-- window). Both columns are read+written by the
-- PostgresRateLimitStore in server/utils/rate-limit-store.ts.
--
-- The (key, reset_at) index is used by the periodic GC sweep that
-- evicts expired buckets so the table doesn't grow without bound.

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  key       text PRIMARY KEY,
  count     integer NOT NULL DEFAULT 0,
  reset_at  timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS rate_limit_buckets_reset_at_idx
  ON rate_limit_buckets (reset_at);
