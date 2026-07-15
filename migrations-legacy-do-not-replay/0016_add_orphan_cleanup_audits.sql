CREATE TABLE IF NOT EXISTS "orphan_cleanup_audits" (
  "id" serial PRIMARY KEY NOT NULL,
  "admin_user_id" integer NOT NULL,
  "resource_type" text NOT NULL,
  "resource_id" integer NOT NULL,
  "action" text NOT NULL,
  "organization_id" integer,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "orphan_cleanup_audits"
    ADD CONSTRAINT "orphan_cleanup_audits_admin_user_id_users_id_fk"
    FOREIGN KEY ("admin_user_id") REFERENCES "public"."users"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "orphan_cleanup_audits"
    ADD CONSTRAINT "orphan_cleanup_audits_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id")
    ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orphan_cleanup_audits_created_at_idx"
  ON "orphan_cleanup_audits" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orphan_cleanup_audits_resource_idx"
  ON "orphan_cleanup_audits" USING btree ("resource_type","resource_id");
