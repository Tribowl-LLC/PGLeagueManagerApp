-- Task #706: Combined partner pay (all modes). A bowler can pay for self
-- + accepted payment-link partners in one card transaction. Each per-bowler
-- payment row writes the same `combined_charge_group_id` so the group is
-- discoverable for receipts, refunds, and admin UI.
ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "combined_charge_group_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_combined_group_idx"
  ON "payments" ("combined_charge_group_id");
