CREATE TABLE IF NOT EXISTS "admin_password_reset_audits" (
  "id" serial PRIMARY KEY NOT NULL,
  "actor_user_id" integer NOT NULL,
  "target_user_id" integer NOT NULL,
  "organization_id" integer,
  "ip_address" text,
  "user_agent" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "admin_password_reset_audits"
    ADD CONSTRAINT "admin_password_reset_audits_actor_user_id_users_id_fk"
    FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "admin_password_reset_audits"
    ADD CONSTRAINT "admin_password_reset_audits_target_user_id_users_id_fk"
    FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "admin_password_reset_audits"
    ADD CONSTRAINT "admin_password_reset_audits_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id")
    ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_password_reset_audits_created_at_idx"
  ON "admin_password_reset_audits" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_password_reset_audits_target_idx"
  ON "admin_password_reset_audits" USING btree ("target_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_password_reset_audits_actor_idx"
  ON "admin_password_reset_audits" USING btree ("actor_user_id");
