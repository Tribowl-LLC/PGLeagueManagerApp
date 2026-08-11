CREATE TABLE "league_occurrence_generation_discrepancy_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"discrepancy_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"snapshot_schema_version" integer NOT NULL,
	"before_snapshot" jsonb NOT NULL,
	"after_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generation_discrepancy_revisions_revision_check" CHECK ("league_occurrence_generation_discrepancy_revisions"."revision_number" > 0 AND "league_occurrence_generation_discrepancy_revisions"."snapshot_schema_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "league_schedule_commands" DROP CONSTRAINT "schedule_commands_type_check";--> statement-breakpoint
ALTER TABLE "league_schedule_commands" DROP CONSTRAINT "schedule_commands_reason_check";--> statement-breakpoint
ALTER TABLE "league_schedule_exceptions" DROP CONSTRAINT "schedule_exceptions_lifecycle_check";--> statement-breakpoint
CREATE UNIQUE INDEX "generation_discrepancies_tenant_identity_unique" ON "league_occurrence_generation_discrepancies" USING btree ("id","organization_id","league_id");--> statement-breakpoint
ALTER TABLE "league_occurrence_generation_discrepancy_revisions" ADD CONSTRAINT "league_occurrence_generation_discrepancy_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrence_generation_discrepancy_revisions" ADD CONSTRAINT "generation_discrepancy_revisions_discrepancy_fk" FOREIGN KEY ("discrepancy_id","organization_id","league_id") REFERENCES "public"."league_occurrence_generation_discrepancies"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrence_generation_discrepancy_revisions" ADD CONSTRAINT "generation_discrepancy_revisions_command_fk" FOREIGN KEY ("command_id","organization_id","league_id") REFERENCES "public"."league_schedule_commands"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "generation_discrepancy_revisions_entity_revision_unique" ON "league_occurrence_generation_discrepancy_revisions" USING btree ("organization_id","league_id","discrepancy_id","revision_number");--> statement-breakpoint
CREATE INDEX "generation_discrepancy_revisions_tenant_created_idx" ON "league_occurrence_generation_discrepancy_revisions" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "league_schedule_commands" ADD CONSTRAINT "schedule_commands_type_check" CHECK ("league_schedule_commands"."command_type" IN ('generate', 'compare', 'approve_generation', 'publish', 'reschedule', 'cancel', 'discard_draft', 'create_exception', 'revoke_exception', 'create_makeup_relationship', 'revoke_makeup_relationship', 'revise_billing_terms', 'repair', 'reject_generation', 'restore_cancelled_draft'));--> statement-breakpoint
ALTER TABLE "league_schedule_commands" ADD CONSTRAINT "schedule_commands_reason_check" CHECK ("league_schedule_commands"."command_type" NOT IN ('cancel', 'reschedule', 'discard_draft', 'revoke_exception', 'revoke_makeup_relationship', 'repair', 'reject_generation', 'restore_cancelled_draft')
      OR ("league_schedule_commands"."reason" IS NOT NULL AND length("league_schedule_commands"."reason") > 0 AND btrim("league_schedule_commands"."reason") = "league_schedule_commands"."reason"));--> statement-breakpoint
ALTER TABLE "league_schedule_exceptions" ADD CONSTRAINT "schedule_exceptions_lifecycle_check" CHECK ((
      "league_schedule_exceptions"."lifecycle" = 'draft'
      AND "league_schedule_exceptions"."published_at" IS NULL AND "league_schedule_exceptions"."published_by_user_id" IS NULL AND "league_schedule_exceptions"."publication_command_id" IS NULL
      AND "league_schedule_exceptions"."revoked_at" IS NULL AND "league_schedule_exceptions"."revoked_by_user_id" IS NULL AND "league_schedule_exceptions"."revocation_command_id" IS NULL
    ) OR (
      "league_schedule_exceptions"."lifecycle" = 'published'
      AND "league_schedule_exceptions"."published_at" IS NOT NULL AND "league_schedule_exceptions"."published_by_user_id" IS NOT NULL AND "league_schedule_exceptions"."publication_command_id" IS NOT NULL
      AND "league_schedule_exceptions"."revoked_at" IS NULL AND "league_schedule_exceptions"."revoked_by_user_id" IS NULL AND "league_schedule_exceptions"."revocation_command_id" IS NULL
    ) OR (
      "league_schedule_exceptions"."lifecycle" = 'revoked'
      AND (("league_schedule_exceptions"."published_at" IS NULL AND "league_schedule_exceptions"."published_by_user_id" IS NULL AND "league_schedule_exceptions"."publication_command_id" IS NULL)
        OR ("league_schedule_exceptions"."published_at" IS NOT NULL AND "league_schedule_exceptions"."published_by_user_id" IS NOT NULL AND "league_schedule_exceptions"."publication_command_id" IS NOT NULL))
      AND "league_schedule_exceptions"."revoked_at" IS NOT NULL AND "league_schedule_exceptions"."revoked_by_user_id" IS NOT NULL AND "league_schedule_exceptions"."revocation_command_id" IS NOT NULL
    ));
