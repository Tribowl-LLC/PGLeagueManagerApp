-- Background retry sweep for failed BowlNow contact syncs (task #480).
-- Parallel triple to `payment_sync_*` (added in 0022) but kept SEPARATE
-- on purpose: Square and BowlNow are independent external systems with
-- independent failure modes (different APIs, different rate limits,
-- different outages). A single shared flag would force a Square success
-- to clear a still-failing BowlNow retry (or vice-versa) and would
-- conflate the per-provider attempt counts.
--   `bn_sync_pending_at`        — set by `bowler-resync.ts` when a
--                                 fire-and-forget BowlNow sync attempt
--                                 fails for a transient reason (auth
--                                 blip, rate limit, 5xx, network).
--                                 NULL means no retry needed.
--   `bn_sync_attempts`          — how many times the sweep has tried
--                                 to re-push this bowler since the
--                                 flag was set; reset to 0 on success;
--                                 the sweep stops touching the row
--                                 once it hits BN_SYNC_MAX_ATTEMPTS.
--   `bn_sync_last_attempt_at`   — timestamp of the most recent retry
--                                 attempt; combined with
--                                 `bn_sync_attempts` to enforce
--                                 exponential backoff between ticks.
-- All three stay NULL/0 for the steady-state "no failure pending" case
-- so behaviour for bowlers that never failed is unchanged.
ALTER TABLE "bowlers"
  ADD COLUMN IF NOT EXISTS "bn_sync_pending_at" timestamp,
  ADD COLUMN IF NOT EXISTS "bn_sync_attempts" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "bn_sync_last_attempt_at" timestamp;
