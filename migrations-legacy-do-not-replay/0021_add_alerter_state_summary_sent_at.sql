-- The Apple Pay recovery banner (#272) must only surface alerts that
-- actually went out. `last_sent_at` is advanced inside
-- `tryClaimAlerterSlot` before the email send result is known, so a
-- send failure would otherwise leave a stale-looking "recent alert"
-- visible to admins. Track the timestamp of the *successful* send
-- separately, written atomically with `last_summary`.
ALTER TABLE "alerter_state"
  ADD COLUMN IF NOT EXISTS "last_summary_sent_at" timestamp;
