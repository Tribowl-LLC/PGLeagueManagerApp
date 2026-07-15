-- Task #357: Lock out an account after repeated failed current-password
-- checks on /api/account/change-password.
--
-- Pure additive: two new columns on `users`. No data migration needed.
-- Existing rows get `failed_password_change_attempts = 0` (column has
-- a NOT NULL default of 0) and `password_change_locked_until = NULL`.
-- IF NOT EXISTS makes this idempotent across re-runs and CI bootstraps.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "failed_password_change_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "password_change_locked_until" timestamp;
