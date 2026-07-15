ALTER TABLE "admin_email_change_audits"
  ADD COLUMN IF NOT EXISTS "email_change_request_id" integer;
--> statement-breakpoint
ALTER TABLE "admin_email_change_audits"
  ADD COLUMN IF NOT EXISTS "post_confirm_payment_sync_status" text;
--> statement-breakpoint
ALTER TABLE "admin_email_change_audits"
  ADD COLUMN IF NOT EXISTS "post_confirmed_at" timestamp;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "admin_email_change_audits"
    ADD CONSTRAINT "admin_email_change_audits_email_change_request_id_email_change_requests_id_fk"
    FOREIGN KEY ("email_change_request_id") REFERENCES "public"."email_change_requests"("id")
    ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_email_change_audits_request_idx"
  ON "admin_email_change_audits" USING btree ("email_change_request_id");
