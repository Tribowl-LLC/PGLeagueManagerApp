CREATE TABLE "canonical_collection_group_member_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"member_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"snapshot_schema_version" integer NOT NULL,
	"before_snapshot" jsonb,
	"after_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_group_member_revisions_revision_check" CHECK ("canonical_collection_group_member_revisions"."revision_number" > 0 AND "canonical_collection_group_member_revisions"."snapshot_schema_version" > 0),
	CONSTRAINT "collection_group_member_revisions_snapshot_check" CHECK (("canonical_collection_group_member_revisions"."revision_number" = 1 AND "canonical_collection_group_member_revisions"."before_snapshot" IS NULL) OR ("canonical_collection_group_member_revisions"."revision_number" > 1 AND "canonical_collection_group_member_revisions"."before_snapshot" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "canonical_collection_group_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"group_id" uuid NOT NULL,
	"generation_run_id" uuid NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"billing_term_id" uuid NOT NULL,
	"role" text NOT NULL,
	"member_ordinal" integer NOT NULL,
	"local_date" date NOT NULL,
	"billing_ordinal" integer NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"current_revision" integer DEFAULT 1 NOT NULL,
	"last_command_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_group_members_role_check" CHECK ("canonical_collection_group_members"."role" IN ('trigger', 'paired') AND (("canonical_collection_group_members"."role" = 'trigger' AND "canonical_collection_group_members"."member_ordinal" = 1) OR ("canonical_collection_group_members"."role" = 'paired' AND "canonical_collection_group_members"."member_ordinal" = 2))),
	CONSTRAINT "collection_group_members_amount_check" CHECK ("canonical_collection_group_members"."amount_minor" > 0 AND "canonical_collection_group_members"."billing_ordinal" > 0 AND "canonical_collection_group_members"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "collection_group_members_revision_check" CHECK ("canonical_collection_group_members"."current_revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "canonical_collection_group_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"group_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"snapshot_schema_version" integer NOT NULL,
	"before_snapshot" jsonb,
	"after_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_group_revisions_revision_check" CHECK ("canonical_collection_group_revisions"."revision_number" > 0 AND "canonical_collection_group_revisions"."snapshot_schema_version" > 0),
	CONSTRAINT "collection_group_revisions_snapshot_check" CHECK (("canonical_collection_group_revisions"."revision_number" = 1 AND "canonical_collection_group_revisions"."before_snapshot" IS NULL) OR ("canonical_collection_group_revisions"."revision_number" > 1 AND "canonical_collection_group_revisions"."before_snapshot" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "canonical_collection_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"generation_run_id" uuid NOT NULL,
	"source_schedule_revision" integer NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"group_ordinal" integer NOT NULL,
	"trigger_local_date" date NOT NULL,
	"paired_local_date" date NOT NULL,
	"contract_version" varchar(128) NOT NULL,
	"fingerprint_version" varchar(128) NOT NULL,
	"fingerprint" varchar(128) NOT NULL,
	"current_revision" integer DEFAULT 1 NOT NULL,
	"last_command_id" uuid,
	"published_at" timestamp with time zone,
	"published_by_user_id" integer,
	"publication_command_id" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" integer,
	"revocation_command_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_groups_kind_check" CHECK ("canonical_collection_groups"."kind" IN ('double_pay')),
	CONSTRAINT "collection_groups_state_check" CHECK ("canonical_collection_groups"."state" IN ('draft', 'published', 'revoked')),
	CONSTRAINT "collection_groups_revision_check" CHECK ("canonical_collection_groups"."current_revision" > 0 AND "canonical_collection_groups"."source_schedule_revision" > 0 AND "canonical_collection_groups"."group_ordinal" > 0),
	CONSTRAINT "collection_groups_date_check" CHECK ("canonical_collection_groups"."trigger_local_date" < "canonical_collection_groups"."paired_local_date"),
	CONSTRAINT "collection_groups_version_check" CHECK (length(btrim("canonical_collection_groups"."contract_version")) > 0 AND length(btrim("canonical_collection_groups"."fingerprint_version")) > 0 AND "canonical_collection_groups"."fingerprint" ~ '^lvcollectiongroup:v1:[0-9a-f]{64}$'),
	CONSTRAINT "collection_groups_lifecycle_check" CHECK ((
    "canonical_collection_groups"."state" = 'draft' AND "canonical_collection_groups"."published_at" IS NULL AND "canonical_collection_groups"."published_by_user_id" IS NULL AND "canonical_collection_groups"."publication_command_id" IS NULL AND "canonical_collection_groups"."revoked_at" IS NULL AND "canonical_collection_groups"."revoked_by_user_id" IS NULL AND "canonical_collection_groups"."revocation_command_id" IS NULL
  ) OR (
    "canonical_collection_groups"."state" = 'published' AND "canonical_collection_groups"."published_at" IS NOT NULL AND "canonical_collection_groups"."published_by_user_id" IS NOT NULL AND "canonical_collection_groups"."publication_command_id" IS NOT NULL AND "canonical_collection_groups"."revoked_at" IS NULL AND "canonical_collection_groups"."revoked_by_user_id" IS NULL AND "canonical_collection_groups"."revocation_command_id" IS NULL
  ) OR (
    "canonical_collection_groups"."state" = 'revoked' AND "canonical_collection_groups"."published_at" IS NOT NULL AND "canonical_collection_groups"."published_by_user_id" IS NOT NULL AND "canonical_collection_groups"."publication_command_id" IS NOT NULL AND "canonical_collection_groups"."revoked_at" IS NOT NULL AND "canonical_collection_groups"."revoked_by_user_id" IS NOT NULL AND "canonical_collection_groups"."revocation_command_id" IS NOT NULL
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "collection_group_member_revisions_unique" ON "canonical_collection_group_member_revisions" USING btree ("organization_id","league_id","member_id","revision_number");--> statement-breakpoint
CREATE UNIQUE INDEX "collection_group_members_tenant_identity_unique" ON "canonical_collection_group_members" USING btree ("id","organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "collection_group_members_group_role_unique" ON "canonical_collection_group_members" USING btree ("organization_id","league_id","group_id","role") WHERE "canonical_collection_group_members"."active" = TRUE;--> statement-breakpoint
CREATE UNIQUE INDEX "collection_group_members_group_ordinal_unique" ON "canonical_collection_group_members" USING btree ("organization_id","league_id","group_id","member_ordinal") WHERE "canonical_collection_group_members"."active" = TRUE;--> statement-breakpoint
CREATE UNIQUE INDEX "collection_group_members_occurrence_cross_role_unique" ON "canonical_collection_group_members" USING btree ("organization_id","league_id","occurrence_id") WHERE "canonical_collection_group_members"."active" = TRUE;--> statement-breakpoint
CREATE UNIQUE INDEX "collection_group_members_term_unique" ON "canonical_collection_group_members" USING btree ("organization_id","league_id","billing_term_id") WHERE "canonical_collection_group_members"."active" = TRUE;--> statement-breakpoint
CREATE UNIQUE INDEX "collection_group_revisions_unique" ON "canonical_collection_group_revisions" USING btree ("organization_id","league_id","group_id","revision_number");--> statement-breakpoint
CREATE UNIQUE INDEX "collection_groups_tenant_identity_unique" ON "canonical_collection_groups" USING btree ("id","organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "collection_groups_run_tenant_identity_unique" ON "canonical_collection_groups" USING btree ("id","organization_id","league_id","generation_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "collection_groups_run_ordinal_unique" ON "canonical_collection_groups" USING btree ("organization_id","league_id","generation_run_id","group_ordinal") WHERE "canonical_collection_groups"."state" <> 'revoked';--> statement-breakpoint
CREATE UNIQUE INDEX "collection_groups_fingerprint_unique" ON "canonical_collection_groups" USING btree ("organization_id","league_id","fingerprint") WHERE "canonical_collection_groups"."state" <> 'revoked';--> statement-breakpoint
CREATE UNIQUE INDEX "billing_terms_occurrence_tenant_identity_unique" ON "league_occurrence_billing_terms" USING btree ("id","organization_id","league_id","occurrence_id");--> statement-breakpoint
CREATE UNIQUE INDEX "occurrences_generation_run_tenant_identity_unique" ON "league_occurrences" USING btree ("id","organization_id","league_id","generation_run_id");--> statement-breakpoint
ALTER TABLE "canonical_collection_group_member_revisions" ADD CONSTRAINT "canonical_collection_group_member_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_collection_group_member_revisions" ADD CONSTRAINT "collection_group_member_revisions_member_fk" FOREIGN KEY ("member_id","organization_id","league_id") REFERENCES "public"."canonical_collection_group_members"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_collection_group_member_revisions" ADD CONSTRAINT "collection_group_member_revisions_command_fk" FOREIGN KEY ("command_id","organization_id","league_id") REFERENCES "public"."league_schedule_commands"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_collection_group_members" ADD CONSTRAINT "canonical_collection_group_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_collection_group_members" ADD CONSTRAINT "collection_group_members_league_tenant_fk" FOREIGN KEY ("league_id","organization_id") REFERENCES "public"."leagues"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_collection_group_members" ADD CONSTRAINT "collection_group_members_group_fk" FOREIGN KEY ("group_id","organization_id","league_id","generation_run_id") REFERENCES "public"."canonical_collection_groups"("id","organization_id","league_id","generation_run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_collection_group_members" ADD CONSTRAINT "collection_group_members_occurrence_fk" FOREIGN KEY ("occurrence_id","organization_id","league_id","generation_run_id") REFERENCES "public"."league_occurrences"("id","organization_id","league_id","generation_run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_collection_group_members" ADD CONSTRAINT "collection_group_members_billing_term_fk" FOREIGN KEY ("billing_term_id","organization_id","league_id","occurrence_id") REFERENCES "public"."league_occurrence_billing_terms"("id","organization_id","league_id","occurrence_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_collection_group_members" ADD CONSTRAINT "collection_group_members_last_command_fk" FOREIGN KEY ("last_command_id","organization_id","league_id") REFERENCES "public"."league_schedule_commands"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_collection_group_revisions" ADD CONSTRAINT "canonical_collection_group_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_collection_group_revisions" ADD CONSTRAINT "collection_group_revisions_group_fk" FOREIGN KEY ("group_id","organization_id","league_id") REFERENCES "public"."canonical_collection_groups"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_collection_group_revisions" ADD CONSTRAINT "collection_group_revisions_command_fk" FOREIGN KEY ("command_id","organization_id","league_id") REFERENCES "public"."league_schedule_commands"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_collection_groups" ADD CONSTRAINT "canonical_collection_groups_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_collection_groups" ADD CONSTRAINT "canonical_collection_groups_published_by_user_id_users_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_collection_groups" ADD CONSTRAINT "canonical_collection_groups_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_collection_groups" ADD CONSTRAINT "collection_groups_league_tenant_fk" FOREIGN KEY ("league_id","organization_id") REFERENCES "public"."leagues"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_collection_groups" ADD CONSTRAINT "collection_groups_generation_run_fk" FOREIGN KEY ("generation_run_id","organization_id","league_id") REFERENCES "public"."league_occurrence_generation_runs"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_collection_groups" ADD CONSTRAINT "collection_groups_last_command_fk" FOREIGN KEY ("last_command_id","organization_id","league_id") REFERENCES "public"."league_schedule_commands"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_collection_groups" ADD CONSTRAINT "collection_groups_publication_command_fk" FOREIGN KEY ("publication_command_id","organization_id","league_id") REFERENCES "public"."league_schedule_commands"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_collection_groups" ADD CONSTRAINT "collection_groups_revocation_command_fk" FOREIGN KEY ("revocation_command_id","organization_id","league_id") REFERENCES "public"."league_schedule_commands"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leagues" ADD COLUMN "canonical_schedule_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_operations" DROP CONSTRAINT "payment_operations_dispatch_claim_state_check";--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_dispatch_claim_state_check" CHECK ((
      ("payment_operations"."operation_type" IN ('canonical_autopay_charge', 'scheduled_charge', 'interactive_charge') AND (
        ("payment_operations"."status" IN ('pending', 'retry_scheduled') AND "payment_operations"."dispatch_claimed_at" IS NULL)
        OR "payment_operations"."status" IN ('leased', 'provider_unknown', 'reconciliation_required', 'succeeded', 'action_required', 'failed_terminal', 'canceled')
      ))
      OR ("payment_operations"."operation_type" NOT IN ('canonical_autopay_charge', 'scheduled_charge', 'interactive_charge') AND "payment_operations"."dispatch_claimed_at" IS NULL)
    ));--> statement-breakpoint
ALTER TABLE "league_schedule_commands" DROP CONSTRAINT "schedule_commands_type_check";--> statement-breakpoint
ALTER TABLE "league_schedule_commands" ADD CONSTRAINT "schedule_commands_type_check" CHECK ("league_schedule_commands"."command_type" IN ('generate', 'compare', 'approve_generation', 'publish', 'reschedule', 'cancel', 'discard_draft', 'create_exception', 'revoke_exception', 'create_makeup_relationship', 'revoke_makeup_relationship', 'revise_billing_terms', 'repair', 'reject_generation', 'restore_cancelled_draft', 'publish_collection_group', 'revoke_collection_group', 'repair_collection_group', 'edit_schedule'));
--> statement-breakpoint
CREATE TABLE "financial_activation_cancellation_suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"activation_id" uuid NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"cancellation_command_id" uuid NOT NULL,
	"suppression_version" integer DEFAULT 1 NOT NULL,
	"activation_revision" integer DEFAULT 1 NOT NULL,
	"source_fingerprint" varchar(128) NOT NULL,
	"original_occurrence_revision" integer NOT NULL,
	"original_billing_term_revision" integer NOT NULL,
	"original_responsibility_count" integer NOT NULL,
	"responsibility_fingerprint" varchar(128) NOT NULL,
	"cancellation_review_required" boolean DEFAULT false NOT NULL,
	"revision_number" integer DEFAULT 1 NOT NULL,
	"snapshot_schema_version" integer DEFAULT 1 NOT NULL,
	"before_snapshot" jsonb,
	"after_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "financial_activation_cancellation_suppressions_version_check" CHECK ("financial_activation_cancellation_suppressions"."suppression_version" = 1 AND "financial_activation_cancellation_suppressions"."activation_revision" = 1 AND "financial_activation_cancellation_suppressions"."revision_number" = 1 AND "financial_activation_cancellation_suppressions"."snapshot_schema_version" > 0),
	CONSTRAINT "financial_activation_cancellation_suppressions_source_check" CHECK ("financial_activation_cancellation_suppressions"."source_fingerprint" ~ '^lvfinancialsource:v1:[0-9a-f]{64}$' AND "financial_activation_cancellation_suppressions"."responsibility_fingerprint" ~ '^lvfinancialresponsibility:v1:[0-9a-f]{64}$'),
	CONSTRAINT "financial_activation_cancellation_suppressions_evidence_check" CHECK ("financial_activation_cancellation_suppressions"."original_occurrence_revision" > 0 AND "financial_activation_cancellation_suppressions"."original_billing_term_revision" > 0 AND "financial_activation_cancellation_suppressions"."original_responsibility_count" > 0),
	CONSTRAINT "financial_activation_cancellation_suppressions_snapshot_check" CHECK ("financial_activation_cancellation_suppressions"."before_snapshot" IS NULL AND jsonb_typeof("financial_activation_cancellation_suppressions"."after_snapshot") = 'object')
);
--> statement-breakpoint
ALTER TABLE "financial_activation_cancellation_suppressions" ADD CONSTRAINT "financial_activation_cancellation_suppressions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_activation_cancellation_suppressions" ADD CONSTRAINT "financial_activation_cancellation_suppressions_activation_fk" FOREIGN KEY ("activation_id","organization_id","league_id") REFERENCES "public"."financial_activations"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_activation_cancellation_suppressions" ADD CONSTRAINT "financial_activation_cancellation_suppressions_occurrence_fk" FOREIGN KEY ("occurrence_id","organization_id","league_id") REFERENCES "public"."league_occurrences"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_activation_cancellation_suppressions" ADD CONSTRAINT "financial_activation_cancellation_suppressions_command_fk" FOREIGN KEY ("cancellation_command_id","organization_id","league_id") REFERENCES "public"."league_schedule_commands"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "financial_activation_cancellation_suppressions_tenant_identity_unique" ON "financial_activation_cancellation_suppressions" USING btree ("id","organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "financial_activation_cancellation_suppressions_activation_occurrence_unique" ON "financial_activation_cancellation_suppressions" USING btree ("organization_id","league_id","activation_id","occurrence_id");--> statement-breakpoint
CREATE TRIGGER financial_activation_cancellation_suppressions_immutable BEFORE UPDATE OR DELETE ON financial_activation_cancellation_suppressions FOR EACH ROW EXECUTE FUNCTION prevent_financial_activation_evidence_mutation();
