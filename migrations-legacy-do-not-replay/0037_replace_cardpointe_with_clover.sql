-- Task #573: Fully remove CardPointe (Fiserv) from LeagueVault and
-- replace it with Clover Ecommerce as the second payment provider
-- alongside Square.
--
-- Nothing was ever processed through CardPointe in production — the
-- shared.PAYMENT_PROVIDERS enum has already been swapped to
-- ('square', 'clover') in shared/schema/locations.ts. This migration:
--   1) Adds the new Clover columns explicitly so any environment that
--      runs migrations (rather than `db:push`) lands on a complete
--      schema.
--   2) Drops the now-unused CardPointe DB columns entirely.
ALTER TABLE "locations"
  ADD COLUMN IF NOT EXISTS "clover_credentials" jsonb;
--> statement-breakpoint
ALTER TABLE "bowlers"
  ADD COLUMN IF NOT EXISTS "clover_customer_id" text;
--> statement-breakpoint
ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "clover_charge_id" text;
--> statement-breakpoint
ALTER TABLE "locations"
  DROP COLUMN IF EXISTS "cardpointe_credentials";
--> statement-breakpoint
ALTER TABLE "bowlers"
  DROP COLUMN IF EXISTS "cardpointe_profile_id";
--> statement-breakpoint
ALTER TABLE "payments"
  DROP COLUMN IF EXISTS "cardpointe_retref";
--> statement-breakpoint
ALTER TABLE "payments"
  DROP COLUMN IF EXISTS "cardpointe_authcode";
