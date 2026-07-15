-- Persist a summary of the most recent alert payload per alerter kind so
-- the in-app admin banner can describe what triggered the email without
-- having to re-derive it from logs (#272).
ALTER TABLE "alerter_state"
  ADD COLUMN IF NOT EXISTS "last_summary" jsonb;
