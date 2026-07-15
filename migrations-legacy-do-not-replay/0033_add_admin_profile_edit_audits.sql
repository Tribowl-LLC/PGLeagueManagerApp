CREATE TABLE IF NOT EXISTS "admin_profile_edit_audits" (
  "id" serial PRIMARY KEY NOT NULL,
  "actor_user_id" integer NOT NULL,
  "target_user_id" integer NOT NULL,
  "field" text NOT NULL,
  "old_value" text,
  "new_value" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "admin_profile_edit_audits_field_check"
    CHECK ("field" IN ('name', 'phone', 'preferred_language'))
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "admin_profile_edit_audits"
    ADD CONSTRAINT "admin_profile_edit_audits_actor_user_id_users_id_fk"
    FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "admin_profile_edit_audits"
    ADD CONSTRAINT "admin_profile_edit_audits_target_user_id_users_id_fk"
    FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_profile_edit_audits_created_at_idx"
  ON "admin_profile_edit_audits" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_profile_edit_audits_target_idx"
  ON "admin_profile_edit_audits" USING btree ("target_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_profile_edit_audits_actor_idx"
  ON "admin_profile_edit_audits" USING btree ("actor_user_id");
