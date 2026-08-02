ALTER TABLE "bowlers" ADD COLUMN "payment_sync_next_retry_at" timestamp;--> statement-breakpoint
UPDATE "bowlers"
SET "payment_sync_next_retry_at" = COALESCE(
  "payment_sync_last_attempt_at" + (
    interval '60 seconds' * power(2, LEAST("payment_sync_attempts", 16))
  ),
  "payment_sync_pending_at"
)
WHERE "payment_sync_pending_at" IS NOT NULL
  AND "payment_sync_attempts" < 5;--> statement-breakpoint
CREATE INDEX "bowlers_payment_sync_next_retry_idx" ON "bowlers" USING btree ("payment_sync_next_retry_at") WHERE "bowlers"."payment_sync_pending_at" IS NOT NULL AND "bowlers"."payment_sync_next_retry_at" IS NOT NULL;
