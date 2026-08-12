CREATE TABLE "bowler_occurrence_eligibilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"bowler_id" integer NOT NULL,
	"state" text NOT NULL,
	"reason" text NOT NULL,
	"current_revision" integer DEFAULT 1 NOT NULL,
	"recorded_by_user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bowler_eligibilities_state_check" CHECK ("bowler_occurrence_eligibilities"."state" IN ('eligible', 'ineligible')),
	CONSTRAINT "bowler_eligibilities_reason_check" CHECK (length("bowler_occurrence_eligibilities"."reason") > 0 AND btrim("bowler_occurrence_eligibilities"."reason") = "bowler_occurrence_eligibilities"."reason"),
	CONSTRAINT "bowler_eligibilities_revision_check" CHECK ("bowler_occurrence_eligibilities"."current_revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "bowler_occurrence_eligibility_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"eligibility_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"snapshot_schema_version" integer NOT NULL,
	"before_snapshot" jsonb,
	"after_snapshot" jsonb NOT NULL,
	"recorded_by_user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bowler_eligibility_revisions_revision_check" CHECK ("bowler_occurrence_eligibility_revisions"."revision_number" > 0 AND "bowler_occurrence_eligibility_revisions"."snapshot_schema_version" > 0),
	CONSTRAINT "bowler_eligibility_revisions_snapshot_check" CHECK (("bowler_occurrence_eligibility_revisions"."revision_number" = 1 AND "bowler_occurrence_eligibility_revisions"."before_snapshot" IS NULL)
      OR ("bowler_occurrence_eligibility_revisions"."revision_number" > 1 AND "bowler_occurrence_eligibility_revisions"."before_snapshot" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "bowler_occurrence_obligation_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"obligation_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"snapshot_schema_version" integer NOT NULL,
	"before_snapshot" jsonb,
	"after_snapshot" jsonb NOT NULL,
	"recorded_by_user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bowler_obligation_revisions_revision_check" CHECK ("bowler_occurrence_obligation_revisions"."revision_number" > 0 AND "bowler_occurrence_obligation_revisions"."snapshot_schema_version" > 0),
	CONSTRAINT "bowler_obligation_revisions_snapshot_check" CHECK (("bowler_occurrence_obligation_revisions"."revision_number" = 1 AND "bowler_occurrence_obligation_revisions"."before_snapshot" IS NULL)
      OR ("bowler_occurrence_obligation_revisions"."revision_number" > 1 AND "bowler_occurrence_obligation_revisions"."before_snapshot" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "bowler_occurrence_obligations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"bowler_id" integer NOT NULL,
	"purpose" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"billing_term_id" uuid,
	"billing_term_version" integer,
	"current_revision" integer DEFAULT 1 NOT NULL,
	"recorded_by_user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bowler_obligations_amount_check" CHECK ("bowler_occurrence_obligations"."amount_minor" > 0),
	CONSTRAINT "bowler_obligations_currency_check" CHECK ("bowler_occurrence_obligations"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "bowler_obligations_purpose_check" CHECK ("bowler_occurrence_obligations"."purpose" = 'league_weekly_fee'),
	CONSTRAINT "bowler_obligations_state_check" CHECK ("bowler_occurrence_obligations"."state" IN ('open', 'partially_settled', 'settled', 'voided')),
	CONSTRAINT "bowler_obligations_billing_term_check" CHECK (("bowler_occurrence_obligations"."billing_term_id" IS NULL) = ("bowler_occurrence_obligations"."billing_term_version" IS NULL)
      AND ("bowler_occurrence_obligations"."billing_term_version" IS NULL OR "bowler_occurrence_obligations"."billing_term_version" > 0)),
	CONSTRAINT "bowler_obligations_revision_check" CHECK ("bowler_occurrence_obligations"."current_revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "bowler_occurrence_team_assignment_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"assignment_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"snapshot_schema_version" integer NOT NULL,
	"before_snapshot" jsonb,
	"after_snapshot" jsonb NOT NULL,
	"recorded_by_user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bowler_team_assignment_revisions_revision_check" CHECK ("bowler_occurrence_team_assignment_revisions"."revision_number" > 0 AND "bowler_occurrence_team_assignment_revisions"."snapshot_schema_version" > 0),
	CONSTRAINT "bowler_team_assignment_revisions_snapshot_check" CHECK (("bowler_occurrence_team_assignment_revisions"."revision_number" = 1 AND "bowler_occurrence_team_assignment_revisions"."before_snapshot" IS NULL)
      OR ("bowler_occurrence_team_assignment_revisions"."revision_number" > 1 AND "bowler_occurrence_team_assignment_revisions"."before_snapshot" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "bowler_occurrence_team_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"bowler_id" integer NOT NULL,
	"team_id" integer NOT NULL,
	"state" text DEFAULT 'assigned' NOT NULL,
	"reason" text NOT NULL,
	"current_revision" integer DEFAULT 1 NOT NULL,
	"recorded_by_user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bowler_team_assignments_state_check" CHECK ("bowler_occurrence_team_assignments"."state" IN ('assigned', 'released')),
	CONSTRAINT "bowler_team_assignments_reason_check" CHECK (length("bowler_occurrence_team_assignments"."reason") > 0 AND btrim("bowler_occurrence_team_assignments"."reason") = "bowler_occurrence_team_assignments"."reason"),
	CONSTRAINT "bowler_team_assignments_revision_check" CHECK ("bowler_occurrence_team_assignments"."current_revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "occurrence_collection_plan_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"plan_id" uuid NOT NULL,
	"obligation_id" uuid NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"bowler_id" integer NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"item_index" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_plan_items_amount_check" CHECK ("occurrence_collection_plan_items"."amount_minor" > 0 AND "occurrence_collection_plan_items"."item_index" >= 0),
	CONSTRAINT "collection_plan_items_currency_check" CHECK ("occurrence_collection_plan_items"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "occurrence_collection_plan_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"plan_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"snapshot_schema_version" integer NOT NULL,
	"before_snapshot" jsonb,
	"after_snapshot" jsonb NOT NULL,
	"recorded_by_user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_plan_revisions_revision_check" CHECK ("occurrence_collection_plan_revisions"."revision_number" > 0 AND "occurrence_collection_plan_revisions"."snapshot_schema_version" > 0),
	CONSTRAINT "collection_plan_revisions_snapshot_check" CHECK (("occurrence_collection_plan_revisions"."revision_number" = 1 AND "occurrence_collection_plan_revisions"."before_snapshot" IS NULL)
      OR ("occurrence_collection_plan_revisions"."revision_number" > 1 AND "occurrence_collection_plan_revisions"."before_snapshot" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "occurrence_collection_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"plan_key" varchar(128) NOT NULL,
	"trigger_occurrence_id" uuid,
	"collect_at" timestamp with time zone,
	"currency" varchar(3) NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"current_revision" integer DEFAULT 1 NOT NULL,
	"recorded_by_user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_plans_collection_point_check" CHECK (("occurrence_collection_plans"."trigger_occurrence_id" IS NULL) <> ("occurrence_collection_plans"."collect_at" IS NULL)),
	CONSTRAINT "collection_plans_currency_check" CHECK ("occurrence_collection_plans"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "collection_plans_state_check" CHECK ("occurrence_collection_plans"."state" IN ('draft', 'ready', 'fulfilled', 'cancelled', 'superseded')),
	CONSTRAINT "collection_plans_version_check" CHECK ("occurrence_collection_plans"."version" > 0 AND "occurrence_collection_plans"."current_revision" > 0),
	CONSTRAINT "collection_plans_key_check" CHECK (length("occurrence_collection_plans"."plan_key") > 0 AND btrim("occurrence_collection_plans"."plan_key") = "occurrence_collection_plans"."plan_key")
);
--> statement-breakpoint
CREATE TABLE "payment_occurrence_allocation_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"allocation_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"snapshot_schema_version" integer NOT NULL,
	"before_snapshot" jsonb,
	"after_snapshot" jsonb NOT NULL,
	"recorded_by_user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_occurrence_allocation_revisions_revision_check" CHECK ("payment_occurrence_allocation_revisions"."revision_number" > 0 AND "payment_occurrence_allocation_revisions"."snapshot_schema_version" > 0),
	CONSTRAINT "payment_occurrence_allocation_revisions_snapshot_check" CHECK (("payment_occurrence_allocation_revisions"."revision_number" = 1 AND "payment_occurrence_allocation_revisions"."before_snapshot" IS NULL)
      OR ("payment_occurrence_allocation_revisions"."revision_number" > 1 AND "payment_occurrence_allocation_revisions"."before_snapshot" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "payment_occurrence_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"payment_id" integer NOT NULL,
	"obligation_id" uuid NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"bowler_id" integer NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"allocation_key" varchar(128) NOT NULL,
	"current_revision" integer DEFAULT 1 NOT NULL,
	"recorded_by_user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_occurrence_allocations_amount_check" CHECK ("payment_occurrence_allocations"."amount_minor" > 0),
	CONSTRAINT "payment_occurrence_allocations_currency_check" CHECK ("payment_occurrence_allocations"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "payment_occurrence_allocations_state_check" CHECK ("payment_occurrence_allocations"."state" IN ('active', 'voided')),
	CONSTRAINT "payment_occurrence_allocations_key_check" CHECK (length("payment_occurrence_allocations"."allocation_key") > 0 AND btrim("payment_occurrence_allocations"."allocation_key") = "payment_occurrence_allocations"."allocation_key"),
	CONSTRAINT "payment_occurrence_allocations_revision_check" CHECK ("payment_occurrence_allocations"."current_revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "payment_operation_occurrence_snapshot_allocations" (
	"operation_id" uuid NOT NULL,
	"allocation_index" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"snapshot_version" integer NOT NULL,
	"obligation_id" uuid NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"bowler_id" integer NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	CONSTRAINT "payment_occurrence_snapshot_allocations_pk" PRIMARY KEY("operation_id","allocation_index"),
	CONSTRAINT "payment_occurrence_snapshot_allocations_amount_check" CHECK ("payment_operation_occurrence_snapshot_allocations"."allocation_index" >= 0 AND "payment_operation_occurrence_snapshot_allocations"."amount_minor" > 0),
	CONSTRAINT "payment_occurrence_snapshot_allocations_currency_check" CHECK ("payment_operation_occurrence_snapshot_allocations"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "payment_operation_occurrence_snapshots" (
	"operation_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"snapshot_version" integer DEFAULT 1 NOT NULL,
	"snapshot_fingerprint" varchar(80) NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"allocation_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_occurrence_snapshots_version_check" CHECK ("payment_operation_occurrence_snapshots"."snapshot_version" = 1),
	CONSTRAINT "payment_occurrence_snapshots_fingerprint_check" CHECK ("payment_operation_occurrence_snapshots"."snapshot_fingerprint" ~ '^lvpayocc:v1:[0-9a-f]{64}$'),
	CONSTRAINT "payment_occurrence_snapshots_amount_check" CHECK ("payment_operation_occurrence_snapshots"."amount_minor" > 0 AND "payment_operation_occurrence_snapshots"."allocation_count" > 0),
	CONSTRAINT "payment_occurrence_snapshots_currency_check" CHECK ("payment_operation_occurrence_snapshots"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "bowlers_id_organization_unique" ON "bowlers" USING btree ("id","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_terms_obligation_reference_unique" ON "league_occurrence_billing_terms" USING btree ("id","organization_id","league_id","occurrence_id","purpose","version","currency");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_operations_tenant_currency_reference_unique" ON "payment_operations" USING btree ("id","organization_id","currency");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_id_bowler_league_unique" ON "payments" USING btree ("id","bowler_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_id_league_unique" ON "teams" USING btree ("id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bowler_eligibilities_tenant_identity_unique" ON "bowler_occurrence_eligibilities" USING btree ("id","organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bowler_obligations_tenant_identity_unique" ON "bowler_occurrence_obligations" USING btree ("id","organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bowler_obligations_settlement_reference_unique" ON "bowler_occurrence_obligations" USING btree ("id","organization_id","league_id","occurrence_id","bowler_id","currency");--> statement-breakpoint
CREATE UNIQUE INDEX "bowler_team_assignments_tenant_identity_unique" ON "bowler_occurrence_team_assignments" USING btree ("id","organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "collection_plans_tenant_identity_unique" ON "occurrence_collection_plans" USING btree ("id","organization_id","league_id","currency");--> statement-breakpoint
CREATE UNIQUE INDEX "collection_plans_tenant_reference_unique" ON "occurrence_collection_plans" USING btree ("id","organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_occurrence_allocations_tenant_identity_unique" ON "payment_occurrence_allocations" USING btree ("id","organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_occurrence_snapshots_tenant_version_unique" ON "payment_operation_occurrence_snapshots" USING btree ("operation_id","organization_id","league_id","snapshot_version","currency");--> statement-breakpoint
ALTER TABLE "bowler_occurrence_eligibilities" ADD CONSTRAINT "bowler_occurrence_eligibilities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bowler_occurrence_eligibilities" ADD CONSTRAINT "bowler_occurrence_eligibilities_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bowler_occurrence_eligibilities" ADD CONSTRAINT "bowler_eligibilities_occurrence_tenant_fk" FOREIGN KEY ("occurrence_id","organization_id","league_id") REFERENCES "public"."league_occurrences"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bowler_occurrence_eligibilities" ADD CONSTRAINT "bowler_eligibilities_bowler_tenant_fk" FOREIGN KEY ("bowler_id","organization_id") REFERENCES "public"."bowlers"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bowler_occurrence_eligibility_revisions" ADD CONSTRAINT "bowler_occurrence_eligibility_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bowler_occurrence_eligibility_revisions" ADD CONSTRAINT "bowler_occurrence_eligibility_revisions_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bowler_occurrence_eligibility_revisions" ADD CONSTRAINT "bowler_eligibility_revisions_parent_fk" FOREIGN KEY ("eligibility_id","organization_id","league_id") REFERENCES "public"."bowler_occurrence_eligibilities"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bowler_occurrence_obligation_revisions" ADD CONSTRAINT "bowler_occurrence_obligation_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bowler_occurrence_obligation_revisions" ADD CONSTRAINT "bowler_occurrence_obligation_revisions_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bowler_occurrence_obligation_revisions" ADD CONSTRAINT "bowler_obligation_revisions_parent_fk" FOREIGN KEY ("obligation_id","organization_id","league_id") REFERENCES "public"."bowler_occurrence_obligations"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bowler_occurrence_obligations" ADD CONSTRAINT "bowler_occurrence_obligations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bowler_occurrence_obligations" ADD CONSTRAINT "bowler_occurrence_obligations_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bowler_occurrence_obligations" ADD CONSTRAINT "bowler_obligations_occurrence_tenant_fk" FOREIGN KEY ("occurrence_id","organization_id","league_id") REFERENCES "public"."league_occurrences"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bowler_occurrence_obligations" ADD CONSTRAINT "bowler_obligations_bowler_tenant_fk" FOREIGN KEY ("bowler_id","organization_id") REFERENCES "public"."bowlers"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bowler_occurrence_obligations" ADD CONSTRAINT "bowler_obligations_billing_term_tenant_fk" FOREIGN KEY ("billing_term_id","organization_id","league_id","occurrence_id","purpose","billing_term_version","currency") REFERENCES "public"."league_occurrence_billing_terms"("id","organization_id","league_id","occurrence_id","purpose","version","currency") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bowler_occurrence_team_assignment_revisions" ADD CONSTRAINT "bowler_occurrence_team_assignment_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bowler_occurrence_team_assignment_revisions" ADD CONSTRAINT "bowler_occurrence_team_assignment_revisions_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bowler_occurrence_team_assignment_revisions" ADD CONSTRAINT "bowler_team_assignment_revisions_parent_fk" FOREIGN KEY ("assignment_id","organization_id","league_id") REFERENCES "public"."bowler_occurrence_team_assignments"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bowler_occurrence_team_assignments" ADD CONSTRAINT "bowler_occurrence_team_assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bowler_occurrence_team_assignments" ADD CONSTRAINT "bowler_occurrence_team_assignments_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bowler_occurrence_team_assignments" ADD CONSTRAINT "bowler_team_assignments_occurrence_tenant_fk" FOREIGN KEY ("occurrence_id","organization_id","league_id") REFERENCES "public"."league_occurrences"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bowler_occurrence_team_assignments" ADD CONSTRAINT "bowler_team_assignments_bowler_tenant_fk" FOREIGN KEY ("bowler_id","organization_id") REFERENCES "public"."bowlers"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bowler_occurrence_team_assignments" ADD CONSTRAINT "bowler_team_assignments_team_league_fk" FOREIGN KEY ("team_id","league_id") REFERENCES "public"."teams"("id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "occurrence_collection_plan_items" ADD CONSTRAINT "occurrence_collection_plan_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "occurrence_collection_plan_items" ADD CONSTRAINT "collection_plan_items_plan_tenant_fk" FOREIGN KEY ("plan_id","organization_id","league_id","currency") REFERENCES "public"."occurrence_collection_plans"("id","organization_id","league_id","currency") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "occurrence_collection_plan_items" ADD CONSTRAINT "collection_plan_items_obligation_tenant_fk" FOREIGN KEY ("obligation_id","organization_id","league_id","occurrence_id","bowler_id","currency") REFERENCES "public"."bowler_occurrence_obligations"("id","organization_id","league_id","occurrence_id","bowler_id","currency") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "occurrence_collection_plan_revisions" ADD CONSTRAINT "occurrence_collection_plan_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "occurrence_collection_plan_revisions" ADD CONSTRAINT "collection_plan_revisions_parent_fk" FOREIGN KEY ("plan_id","organization_id","league_id") REFERENCES "public"."occurrence_collection_plans"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "occurrence_collection_plans" ADD CONSTRAINT "occurrence_collection_plans_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "occurrence_collection_plans" ADD CONSTRAINT "occurrence_collection_plans_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "occurrence_collection_plans" ADD CONSTRAINT "collection_plans_league_tenant_fk" FOREIGN KEY ("league_id","organization_id") REFERENCES "public"."leagues"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "occurrence_collection_plans" ADD CONSTRAINT "collection_plans_trigger_occurrence_tenant_fk" FOREIGN KEY ("trigger_occurrence_id","organization_id","league_id") REFERENCES "public"."league_occurrences"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_occurrence_allocation_revisions" ADD CONSTRAINT "payment_occurrence_allocation_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_occurrence_allocation_revisions" ADD CONSTRAINT "payment_occurrence_allocation_revisions_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_occurrence_allocation_revisions" ADD CONSTRAINT "payment_occurrence_allocation_revisions_parent_fk" FOREIGN KEY ("allocation_id","organization_id","league_id") REFERENCES "public"."payment_occurrence_allocations"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_occurrence_allocations" ADD CONSTRAINT "payment_occurrence_allocations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_occurrence_allocations" ADD CONSTRAINT "payment_occurrence_allocations_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_occurrence_allocations" ADD CONSTRAINT "payment_occurrence_allocations_payment_fk" FOREIGN KEY ("payment_id","bowler_id","league_id") REFERENCES "public"."payments"("id","bowler_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_occurrence_allocations" ADD CONSTRAINT "payment_occurrence_allocations_obligation_fk" FOREIGN KEY ("obligation_id","organization_id","league_id","occurrence_id","bowler_id","currency") REFERENCES "public"."bowler_occurrence_obligations"("id","organization_id","league_id","occurrence_id","bowler_id","currency") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_operation_occurrence_snapshot_allocations" ADD CONSTRAINT "payment_operation_occurrence_snapshot_allocations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_operation_occurrence_snapshot_allocations" ADD CONSTRAINT "payment_occurrence_snapshot_allocations_snapshot_fk" FOREIGN KEY ("operation_id","organization_id","league_id","snapshot_version","currency") REFERENCES "public"."payment_operation_occurrence_snapshots"("operation_id","organization_id","league_id","snapshot_version","currency") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_operation_occurrence_snapshot_allocations" ADD CONSTRAINT "payment_occurrence_snapshot_allocations_obligation_fk" FOREIGN KEY ("obligation_id","organization_id","league_id","occurrence_id","bowler_id","currency") REFERENCES "public"."bowler_occurrence_obligations"("id","organization_id","league_id","occurrence_id","bowler_id","currency") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_operation_occurrence_snapshots" ADD CONSTRAINT "payment_operation_occurrence_snapshots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_operation_occurrence_snapshots" ADD CONSTRAINT "payment_occurrence_snapshots_operation_fk" FOREIGN KEY ("operation_id","organization_id","currency") REFERENCES "public"."payment_operations"("id","organization_id","currency") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_operation_occurrence_snapshots" ADD CONSTRAINT "payment_occurrence_snapshots_league_fk" FOREIGN KEY ("league_id","organization_id") REFERENCES "public"."leagues"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bowler_eligibilities_logical_unique" ON "bowler_occurrence_eligibilities" USING btree ("organization_id","league_id","occurrence_id","bowler_id");--> statement-breakpoint
CREATE INDEX "bowler_eligibilities_league_state_idx" ON "bowler_occurrence_eligibilities" USING btree ("organization_id","league_id","state");--> statement-breakpoint
CREATE INDEX "bowler_eligibilities_occurrence_idx" ON "bowler_occurrence_eligibilities" USING btree ("organization_id","league_id","occurrence_id");--> statement-breakpoint
CREATE INDEX "bowler_eligibilities_bowler_idx" ON "bowler_occurrence_eligibilities" USING btree ("organization_id","bowler_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bowler_eligibility_revisions_unique" ON "bowler_occurrence_eligibility_revisions" USING btree ("organization_id","league_id","eligibility_id","revision_number");--> statement-breakpoint
CREATE INDEX "bowler_eligibility_revisions_parent_idx" ON "bowler_occurrence_eligibility_revisions" USING btree ("eligibility_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bowler_obligation_revisions_unique" ON "bowler_occurrence_obligation_revisions" USING btree ("organization_id","league_id","obligation_id","revision_number");--> statement-breakpoint
CREATE INDEX "bowler_obligation_revisions_parent_idx" ON "bowler_occurrence_obligation_revisions" USING btree ("obligation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bowler_obligations_logical_current_unique" ON "bowler_occurrence_obligations" USING btree ("organization_id","league_id","occurrence_id","bowler_id","purpose");--> statement-breakpoint
CREATE INDEX "bowler_obligations_league_state_idx" ON "bowler_occurrence_obligations" USING btree ("organization_id","league_id","state");--> statement-breakpoint
CREATE INDEX "bowler_obligations_occurrence_idx" ON "bowler_occurrence_obligations" USING btree ("organization_id","league_id","occurrence_id");--> statement-breakpoint
CREATE INDEX "bowler_obligations_bowler_idx" ON "bowler_occurrence_obligations" USING btree ("organization_id","bowler_id");--> statement-breakpoint
CREATE INDEX "bowler_obligations_billing_term_idx" ON "bowler_occurrence_obligations" USING btree ("billing_term_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bowler_team_assignment_revisions_unique" ON "bowler_occurrence_team_assignment_revisions" USING btree ("organization_id","league_id","assignment_id","revision_number");--> statement-breakpoint
CREATE INDEX "bowler_team_assignment_revisions_parent_idx" ON "bowler_occurrence_team_assignment_revisions" USING btree ("assignment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bowler_team_assignments_logical_unique" ON "bowler_occurrence_team_assignments" USING btree ("organization_id","league_id","occurrence_id","bowler_id");--> statement-breakpoint
CREATE INDEX "bowler_team_assignments_league_state_idx" ON "bowler_occurrence_team_assignments" USING btree ("organization_id","league_id","state");--> statement-breakpoint
CREATE INDEX "bowler_team_assignments_occurrence_idx" ON "bowler_occurrence_team_assignments" USING btree ("organization_id","league_id","occurrence_id");--> statement-breakpoint
CREATE INDEX "bowler_team_assignments_bowler_idx" ON "bowler_occurrence_team_assignments" USING btree ("organization_id","bowler_id");--> statement-breakpoint
CREATE INDEX "bowler_team_assignments_team_idx" ON "bowler_occurrence_team_assignments" USING btree ("league_id","team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "collection_plan_items_index_unique" ON "occurrence_collection_plan_items" USING btree ("plan_id","item_index");--> statement-breakpoint
CREATE UNIQUE INDEX "collection_plan_items_obligation_unique" ON "occurrence_collection_plan_items" USING btree ("plan_id","obligation_id");--> statement-breakpoint
CREATE INDEX "collection_plan_items_plan_idx" ON "occurrence_collection_plan_items" USING btree ("organization_id","league_id","plan_id");--> statement-breakpoint
CREATE INDEX "collection_plan_items_obligation_idx" ON "occurrence_collection_plan_items" USING btree ("obligation_id");--> statement-breakpoint
CREATE INDEX "collection_plan_items_occurrence_idx" ON "occurrence_collection_plan_items" USING btree ("occurrence_id");--> statement-breakpoint
CREATE INDEX "collection_plan_items_bowler_idx" ON "occurrence_collection_plan_items" USING btree ("organization_id","bowler_id");--> statement-breakpoint
CREATE UNIQUE INDEX "collection_plan_revisions_unique" ON "occurrence_collection_plan_revisions" USING btree ("organization_id","league_id","plan_id","revision_number");--> statement-breakpoint
CREATE INDEX "collection_plan_revisions_parent_idx" ON "occurrence_collection_plan_revisions" USING btree ("plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "collection_plans_key_version_unique" ON "occurrence_collection_plans" USING btree ("organization_id","league_id","plan_key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "collection_plans_current_key_unique" ON "occurrence_collection_plans" USING btree ("organization_id","league_id","plan_key") WHERE "occurrence_collection_plans"."state" <> 'superseded';--> statement-breakpoint
CREATE INDEX "collection_plans_league_state_idx" ON "occurrence_collection_plans" USING btree ("organization_id","league_id","state");--> statement-breakpoint
CREATE INDEX "collection_plans_trigger_idx" ON "occurrence_collection_plans" USING btree ("trigger_occurrence_id");--> statement-breakpoint
CREATE INDEX "collection_plans_collect_at_idx" ON "occurrence_collection_plans" USING btree ("organization_id","league_id","collect_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_occurrence_allocation_revisions_unique" ON "payment_occurrence_allocation_revisions" USING btree ("organization_id","league_id","allocation_id","revision_number");--> statement-breakpoint
CREATE INDEX "payment_occurrence_allocation_revisions_parent_idx" ON "payment_occurrence_allocation_revisions" USING btree ("allocation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_occurrence_allocations_logical_unique" ON "payment_occurrence_allocations" USING btree ("payment_id","obligation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_occurrence_allocations_key_unique" ON "payment_occurrence_allocations" USING btree ("organization_id","allocation_key");--> statement-breakpoint
CREATE INDEX "payment_occurrence_allocations_league_state_idx" ON "payment_occurrence_allocations" USING btree ("organization_id","league_id","state");--> statement-breakpoint
CREATE INDEX "payment_occurrence_allocations_payment_idx" ON "payment_occurrence_allocations" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "payment_occurrence_allocations_obligation_idx" ON "payment_occurrence_allocations" USING btree ("obligation_id");--> statement-breakpoint
CREATE INDEX "payment_occurrence_allocations_occurrence_idx" ON "payment_occurrence_allocations" USING btree ("occurrence_id");--> statement-breakpoint
CREATE INDEX "payment_occurrence_allocations_bowler_idx" ON "payment_occurrence_allocations" USING btree ("organization_id","bowler_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_occurrence_snapshot_allocations_obligation_unique" ON "payment_operation_occurrence_snapshot_allocations" USING btree ("operation_id","obligation_id");--> statement-breakpoint
CREATE INDEX "payment_occurrence_snapshot_allocations_occurrence_idx" ON "payment_operation_occurrence_snapshot_allocations" USING btree ("occurrence_id");--> statement-breakpoint
CREATE INDEX "payment_occurrence_snapshot_allocations_bowler_idx" ON "payment_operation_occurrence_snapshot_allocations" USING btree ("organization_id","bowler_id");--> statement-breakpoint
CREATE INDEX "payment_occurrence_snapshot_allocations_obligation_idx" ON "payment_operation_occurrence_snapshot_allocations" USING btree ("obligation_id");--> statement-breakpoint
CREATE INDEX "payment_occurrence_snapshots_league_idx" ON "payment_operation_occurrence_snapshots" USING btree ("organization_id","league_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE FUNCTION enforce_d2_obligation_amount_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
		OR NEW.league_id IS DISTINCT FROM OLD.league_id
		OR NEW.occurrence_id IS DISTINCT FROM OLD.occurrence_id
		OR NEW.bowler_id IS DISTINCT FROM OLD.bowler_id
		OR NEW.purpose IS DISTINCT FROM OLD.purpose
		OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
		OR NEW.currency IS DISTINCT FROM OLD.currency
		OR NEW.billing_term_id IS DISTINCT FROM OLD.billing_term_id
		OR NEW.billing_term_version IS DISTINCT FROM OLD.billing_term_version
	THEN
		RAISE EXCEPTION 'bowler occurrence obligation financial identity is immutable'
			USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER bowler_obligations_financial_identity_immutable
BEFORE UPDATE ON bowler_occurrence_obligations
FOR EACH ROW EXECUTE FUNCTION enforce_d2_obligation_amount_immutable();--> statement-breakpoint
CREATE FUNCTION assert_d2_collection_plan_obligation_amount(
	scope_organization_id integer,
	scope_league_id integer,
	scope_obligation_id uuid,
	candidate_amount integer
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
	obligation_amount integer;
	planned_amount bigint;
BEGIN
	PERFORM pg_advisory_xact_lock(scope_organization_id, scope_league_id);
	SELECT amount_minor
	INTO obligation_amount
	FROM bowler_occurrence_obligations
	WHERE id = scope_obligation_id
	  AND organization_id = scope_organization_id
	  AND league_id = scope_league_id
	FOR UPDATE;

	IF obligation_amount IS NULL THEN
		RAISE EXCEPTION 'collection plan item obligation is missing'
			USING ERRCODE = '23503';
	END IF;

	SELECT COALESCE(SUM(item.amount_minor), 0)
	INTO planned_amount
	FROM occurrence_collection_plan_items item
	INNER JOIN occurrence_collection_plans plan ON plan.id = item.plan_id
	WHERE item.organization_id = scope_organization_id
	  AND item.league_id = scope_league_id
	  AND item.obligation_id = scope_obligation_id
	  AND plan.organization_id = scope_organization_id
	  AND plan.league_id = scope_league_id
	  AND plan.state IN ('ready', 'fulfilled');

	IF candidate_amount > obligation_amount OR planned_amount > obligation_amount THEN
		RAISE EXCEPTION 'collectable plan items exceed their obligation amount'
			USING ERRCODE = '23514';
	END IF;
	RETURN;
END;
$$;--> statement-breakpoint
CREATE FUNCTION enforce_d2_collection_plan_item_amount() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	PERFORM assert_d2_collection_plan_obligation_amount(
		NEW.organization_id,
		NEW.league_id,
		NEW.obligation_id,
		NEW.amount_minor
	);
	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER collection_plan_items_amount_conservation
AFTER INSERT OR UPDATE ON occurrence_collection_plan_items
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION enforce_d2_collection_plan_item_amount();--> statement-breakpoint
CREATE FUNCTION enforce_d2_collection_plan_state_amount() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	item_record record;
BEGIN
	IF NEW.state NOT IN ('ready', 'fulfilled') THEN
		RETURN NULL;
	END IF;

	PERFORM pg_advisory_xact_lock(NEW.organization_id, NEW.league_id);
	FOR item_record IN
		SELECT DISTINCT item.obligation_id
		FROM occurrence_collection_plan_items item
		WHERE item.organization_id = NEW.organization_id
		  AND item.league_id = NEW.league_id
		  AND item.plan_id = NEW.id
	LOOP
		PERFORM assert_d2_collection_plan_obligation_amount(
			NEW.organization_id,
			NEW.league_id,
			item_record.obligation_id,
			0
		);
	END LOOP;
	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER collection_plans_amount_conservation
AFTER INSERT OR UPDATE ON occurrence_collection_plans
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION enforce_d2_collection_plan_state_amount();--> statement-breakpoint
CREATE FUNCTION enforce_d2_payment_allocation_conservation() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	payment_amount integer;
	linked_operation_id uuid;
	operation_currency varchar(3);
	obligation_amount integer;
	allocated_to_payment bigint;
	allocated_to_obligation bigint;
BEGIN
	PERFORM pg_advisory_xact_lock(NEW.organization_id, NEW.league_id);

	SELECT p.amount, p.payment_operation_id
	INTO payment_amount, linked_operation_id
	FROM payments p
	WHERE p.id = NEW.payment_id
	  AND p.bowler_id = NEW.bowler_id
	  AND p.league_id = NEW.league_id
	FOR UPDATE;

	SELECT amount_minor
	INTO obligation_amount
	FROM bowler_occurrence_obligations
	WHERE id = NEW.obligation_id
	  AND organization_id = NEW.organization_id
	  AND league_id = NEW.league_id
	FOR UPDATE;

	IF payment_amount IS NULL OR obligation_amount IS NULL THEN
		RAISE EXCEPTION 'payment occurrence allocation parent is missing'
			USING ERRCODE = '23503';
	END IF;

	IF linked_operation_id IS NOT NULL THEN
		SELECT po.currency
		INTO operation_currency
		FROM payment_operations po
		WHERE po.id = linked_operation_id
		  AND po.organization_id = NEW.organization_id
		FOR SHARE;
		IF operation_currency IS NULL OR operation_currency <> NEW.currency THEN
			RAISE EXCEPTION 'payment occurrence allocation currency conflicts with its operation'
				USING ERRCODE = '23514';
		END IF;
	END IF;

	SELECT COALESCE(SUM(amount_minor), 0)
	INTO allocated_to_payment
	FROM payment_occurrence_allocations
	WHERE payment_id = NEW.payment_id
	  AND state = 'active';

	SELECT COALESCE(SUM(amount_minor), 0)
	INTO allocated_to_obligation
	FROM payment_occurrence_allocations
	WHERE obligation_id = NEW.obligation_id
	  AND state = 'active';

	IF allocated_to_payment > payment_amount THEN
		RAISE EXCEPTION 'payment occurrence allocations exceed the payment amount'
			USING ERRCODE = '23514';
	END IF;
	IF allocated_to_obligation > obligation_amount THEN
		RAISE EXCEPTION 'payment occurrence allocations exceed the obligation amount'
			USING ERRCODE = '23514';
	END IF;
	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payment_occurrence_allocations_conservation
AFTER INSERT OR UPDATE ON payment_occurrence_allocations
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION enforce_d2_payment_allocation_conservation();--> statement-breakpoint
CREATE FUNCTION enforce_payment_occurrence_snapshot_total() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	operation_uuid uuid := COALESCE(NEW.operation_id, OLD.operation_id);
	snapshot_organization_id integer;
	snapshot_league_id integer;
	expected_amount integer;
	expected_count integer;
	operation_amount integer;
	stored_operation_type text;
	base_snapshot_league_id integer;
	actual_amount bigint;
	actual_count integer;
BEGIN
	SELECT organization_id, league_id, amount_minor, allocation_count
	INTO snapshot_organization_id, snapshot_league_id, expected_amount, expected_count
	FROM payment_operation_occurrence_snapshots
	WHERE operation_id = operation_uuid
	FOR UPDATE;

	IF expected_amount IS NULL THEN
		RETURN NULL;
	END IF;

	PERFORM pg_advisory_xact_lock(snapshot_organization_id, snapshot_league_id);
	SELECT po.amount_minor, po.operation_type
	INTO operation_amount, stored_operation_type
	FROM payment_operations po
	WHERE po.id = operation_uuid
	  AND po.organization_id = snapshot_organization_id
	FOR UPDATE;

	IF stored_operation_type NOT IN ('scheduled_charge', 'interactive_charge') THEN
		RAISE EXCEPTION 'occurrence snapshots support only charge operations'
			USING ERRCODE = '23514';
	END IF;

	IF stored_operation_type = 'scheduled_charge' THEN
		SELECT snapshot.league_id
		INTO base_snapshot_league_id
		FROM scheduled_payment_operation_snapshots snapshot
		WHERE snapshot.operation_id = operation_uuid
		FOR SHARE;
	ELSE
		SELECT snapshot.league_id
		INTO base_snapshot_league_id
		FROM interactive_payment_operation_snapshots snapshot
		WHERE snapshot.operation_id = operation_uuid
		FOR SHARE;
	END IF;

	IF base_snapshot_league_id IS NULL THEN
		RAISE EXCEPTION 'payment operation occurrence snapshot requires its matching execution snapshot'
			USING ERRCODE = '23514';
	END IF;
	IF base_snapshot_league_id <> snapshot_league_id THEN
		RAISE EXCEPTION 'payment operation occurrence snapshot league conflicts with its execution snapshot'
			USING ERRCODE = '23514';
	END IF;

	SELECT COALESCE(SUM(amount_minor), 0), COUNT(*)::integer
	INTO actual_amount, actual_count
	FROM payment_operation_occurrence_snapshot_allocations
	WHERE operation_id = operation_uuid;

	IF expected_amount <> operation_amount
		OR actual_amount <> expected_amount
		OR actual_count <> expected_count
	THEN
		RAISE EXCEPTION 'payment operation occurrence snapshot allocation total is inconsistent'
			USING ERRCODE = '23514';
	END IF;
	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payment_occurrence_snapshots_total
AFTER INSERT OR UPDATE OR DELETE ON payment_operation_occurrence_snapshots
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_payment_occurrence_snapshot_total();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payment_occurrence_snapshot_allocations_total
AFTER INSERT OR UPDATE OR DELETE ON payment_operation_occurrence_snapshot_allocations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_payment_occurrence_snapshot_total();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payment_occurrence_scheduled_base_snapshot_consistency
AFTER UPDATE OR DELETE ON scheduled_payment_operation_snapshots
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_payment_occurrence_snapshot_total();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payment_occurrence_interactive_base_snapshot_consistency
AFTER UPDATE OR DELETE ON interactive_payment_operation_snapshots
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_payment_occurrence_snapshot_total();
