ALTER TABLE "orphan_cleanup_audits"
  ADD COLUMN IF NOT EXISTS "previous_organization_id" integer;
--> statement-breakpoint
ALTER TABLE "orphan_cleanup_audits"
  ADD COLUMN IF NOT EXISTS "snapshot" jsonb;
--> statement-breakpoint
ALTER TABLE "orphan_cleanup_audits"
  ADD COLUMN IF NOT EXISTS "undone_at" timestamp;
--> statement-breakpoint
ALTER TABLE "orphan_cleanup_audits"
  ADD COLUMN IF NOT EXISTS "undone_by_audit_id" integer;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "orphan_cleanup_audits"
    ADD CONSTRAINT "orphan_cleanup_audits_previous_organization_id_organizations_id_fk"
    FOREIGN KEY ("previous_organization_id") REFERENCES "public"."organizations"("id")
    ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "orphan_cleanup_audits"
    ADD CONSTRAINT "orphan_cleanup_audits_undone_by_audit_id_orphan_cleanup_audits_id_fk"
    FOREIGN KEY ("undone_by_audit_id") REFERENCES "public"."orphan_cleanup_audits"("id")
    ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
