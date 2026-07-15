-- Background retry sweep for failed payment-customer syncs (task #284).
--   `payment_sync_attempts`        — how many times the sweep has tried
--                                    to re-push this bowler since the
--                                    flag was set; reset to 0 on success.
--   `payment_sync_last_attempt_at` — timestamp of the most recent retry
--                                    attempt; combined with
--                                    `payment_sync_attempts` to enforce
--                                    exponential backoff.
-- Both stay NULL/0 for the steady-state "no failure pending" case so
-- behaviour for bowlers that never failed is unchanged.
ALTER TABLE "bowlers"
  ADD COLUMN IF NOT EXISTS "payment_sync_attempts" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "payment_sync_last_attempt_at" timestamp;
