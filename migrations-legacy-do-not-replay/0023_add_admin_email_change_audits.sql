CREATE TABLE IF NOT EXISTS "admin_email_change_audits" (
  "id" serial PRIMARY KEY NOT NULL,
  "actor_user_id" integer NOT NULL,
  "target_user_id" integer NOT NULL,
  "old_email_masked" text NOT NULL,
  "new_email_masked" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "admin_email_change_audits"
    ADD CONSTRAINT "admin_email_change_audits_actor_user_id_users_id_fk"
    FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "admin_email_change_audits"
    ADD CONSTRAINT "admin_email_change_audits_target_user_id_users_id_fk"
    FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_email_change_audits_created_at_idx"
  ON "admin_email_change_audits" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_email_change_audits_target_idx"
  ON "admin_email_change_audits" USING btree ("target_user_id");
