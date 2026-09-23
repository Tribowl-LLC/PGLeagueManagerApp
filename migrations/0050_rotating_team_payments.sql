CREATE TABLE "payment_obligation_owner_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"obligation_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"owner_kind" text NOT NULL,
	"owner_bowler_id" integer,
	"owner_team_id" integer,
	"reason" text NOT NULL,
	"recorded_by_user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_obligation_owner_revisions_owner_check" CHECK ("payment_obligation_owner_revisions"."revision_number" > 0 AND "payment_obligation_owner_revisions"."owner_kind" IN ('bowler', 'team') AND "payment_obligation_owner_revisions"."reason" IN ('rotating_conversion', 'rotating_materialization') AND (("payment_obligation_owner_revisions"."owner_kind" = 'bowler' AND "payment_obligation_owner_revisions"."owner_bowler_id" IS NOT NULL AND "payment_obligation_owner_revisions"."owner_team_id" IS NULL) OR ("payment_obligation_owner_revisions"."owner_kind" = 'team' AND "payment_obligation_owner_revisions"."owner_bowler_id" IS NULL AND "payment_obligation_owner_revisions"."owner_team_id" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "rotating_occurrence_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"team_id" integer NOT NULL,
	"slot_id" uuid NOT NULL,
	"slot_index" integer NOT NULL,
	"responsibility_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"actual_bowler_id" integer,
	"correction_reason" text,
	"recorded_by_user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rotating_occurrence_assignments_version_check" CHECK ("rotating_occurrence_assignments"."version" > 0 AND ("rotating_occurrence_assignments"."correction_reason" IS NULL OR length(btrim("rotating_occurrence_assignments"."correction_reason")) BETWEEN 1 AND 500))
);
--> statement-breakpoint
CREATE TABLE "team_payment_rotation_member_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"member_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"before_snapshot" jsonb,
	"after_snapshot" jsonb NOT NULL,
	"recorded_by_user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_payment_rotation_member_revisions_revision_check" CHECK ("team_payment_rotation_member_revisions"."revision_number" > 0 AND (("team_payment_rotation_member_revisions"."revision_number" = 1 AND "team_payment_rotation_member_revisions"."before_snapshot" IS NULL) OR ("team_payment_rotation_member_revisions"."revision_number" > 1 AND "team_payment_rotation_member_revisions"."before_snapshot" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "team_payment_rotation_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"team_id" integer NOT NULL,
	"bowler_id" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"current_revision" integer DEFAULT 1 NOT NULL,
	"recorded_by_user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_payment_rotation_members_revision_check" CHECK ("team_payment_rotation_members"."current_revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "rotating_credit_application_reversals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"application_id" uuid NOT NULL,
	"funding_payment_id" integer NOT NULL,
	"allocation_id" uuid NOT NULL,
	"obligation_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"bowler_id" integer NOT NULL,
	"amount_minor" integer NOT NULL,
	"actor_user_id" integer NOT NULL,
	"reason" varchar(500) NOT NULL,
	"transaction_id" text DEFAULT pg_current_xact_id()::text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rotating_credit_application_reversals_amount_check" CHECK ("rotating_credit_application_reversals"."amount_minor" > 0),
	CONSTRAINT "rotating_credit_application_reversals_transaction_id_check" CHECK ("rotating_credit_application_reversals"."transaction_id" ~ '^[0-9]+$'),
	CONSTRAINT "rotating_credit_application_reversals_reason_check" CHECK (length(btrim("rotating_credit_application_reversals"."reason")) BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE TABLE "rotating_credit_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"funding_id" uuid NOT NULL,
	"payment_id" integer NOT NULL,
	"allocation_id" uuid NOT NULL,
	"obligation_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"responsibility_id" uuid NOT NULL,
	"actual_bowler_id" integer NOT NULL,
	"team_id" integer NOT NULL,
	"slot_index" integer NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"occurrence_local_date" date NOT NULL,
	"occurrence_start_at" timestamp with time zone NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_by_user_id" integer NOT NULL,
	CONSTRAINT "rotating_credit_applications_amount_check" CHECK ("rotating_credit_applications"."amount_minor" > 0),
	CONSTRAINT "rotating_credit_applications_currency_check" CHECK ("currency" = 'USD'),
	CONSTRAINT "rotating_credit_applications_slot_check" CHECK ("rotating_credit_applications"."slot_index" >= 0)
);
--> statement-breakpoint
CREATE TABLE "rotating_credit_fundings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"bowler_id" integer NOT NULL,
	"payment_id" integer NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"funding_kind" text NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"request_fingerprint" varchar(96) NOT NULL,
	"quote_fingerprint" varchar(96) NOT NULL,
	"actor_user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rotating_credit_fundings_amount_check" CHECK ("rotating_credit_fundings"."amount_minor" > 0),
	CONSTRAINT "rotating_credit_fundings_currency_check" CHECK ("currency" = 'USD'),
	CONSTRAINT "rotating_credit_fundings_kind_check" CHECK ("rotating_credit_fundings"."funding_kind" IN ('provider', 'cash', 'check')),
	CONSTRAINT "rotating_credit_fundings_idempotency_check" CHECK ("rotating_credit_fundings"."idempotency_key" ~ '^[A-Za-z0-9_-]{16,128}$'),
	CONSTRAINT "rotating_credit_fundings_request_fingerprint_check" CHECK ("rotating_credit_fundings"."request_fingerprint" ~ '^lvrotcrreq:v1:[0-9a-f]{64}$'),
	CONSTRAINT "rotating_credit_fundings_quote_fingerprint_check" CHECK ("rotating_credit_fundings"."quote_fingerprint" ~ '^lvrotcrquote:v1:[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "rotating_credit_payment_operation_snapshots" (
	"operation_id" uuid NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"snapshot_version" integer DEFAULT 1 NOT NULL,
	"bowler_id" integer NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"share_count" integer NOT NULL,
	"location_id" integer,
	"provider_location_id" varchar(255),
	"source_kind" text NOT NULL,
	"encrypted_source_id" text NOT NULL,
	"encrypted_customer_id" text,
	"encrypted_buyer_email" text,
	"quote_fingerprint" varchar(96) NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"snapshot_fingerprint" varchar(96) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rotating_credit_payment_operation_snapshots_amount_check" CHECK ("rotating_credit_payment_operation_snapshots"."amount_minor" > 0 AND "rotating_credit_payment_operation_snapshots"."share_count" > 0),
	CONSTRAINT "rotating_credit_payment_operation_snapshots_currency_check" CHECK ("currency" = 'USD'),
	CONSTRAINT "rotating_credit_payment_operation_snapshots_version_check" CHECK ("rotating_credit_payment_operation_snapshots"."snapshot_version" = 1),
	CONSTRAINT "rotating_credit_payment_operation_snapshots_quote_fingerprint_check" CHECK ("rotating_credit_payment_operation_snapshots"."quote_fingerprint" ~ '^lvrotcrquote:v1:[0-9a-f]{64}$'),
	CONSTRAINT "rotating_credit_payment_operation_snapshots_idempotency_check" CHECK ("rotating_credit_payment_operation_snapshots"."idempotency_key" ~ '^[A-Za-z0-9_-]{16,128}$'),
	CONSTRAINT "rotating_credit_payment_operation_snapshots_fingerprint_check" CHECK ("rotating_credit_payment_operation_snapshots"."snapshot_fingerprint" ~ '^lvrotcrexec:v1:[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "rotating_credit_refund_operation_snapshots" (
	"operation_id" uuid NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"funding_id" uuid NOT NULL,
	"payment_id" integer NOT NULL,
	"bowler_id" integer NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"provider_payment_id" varchar(255) NOT NULL,
	"location_id" integer,
	"reason" varchar(500) NOT NULL,
	"snapshot_fingerprint" varchar(96) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rotating_credit_refund_operation_snapshots_amount_check" CHECK ("rotating_credit_refund_operation_snapshots"."amount_minor" > 0),
	CONSTRAINT "rotating_credit_refund_operation_snapshots_currency_check" CHECK ("currency" = 'USD'),
	CONSTRAINT "rotating_credit_refund_operation_snapshots_fingerprint_check" CHECK ("rotating_credit_refund_operation_snapshots"."snapshot_fingerprint" ~ '^lvrotcrrefundexec:v1:[0-9a-f]{64}$'),
	CONSTRAINT "rotating_credit_refund_operation_snapshots_reason_check" CHECK (length(btrim("rotating_credit_refund_operation_snapshots"."reason")) BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE TABLE "rotating_credit_refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"funding_id" uuid NOT NULL,
	"payment_id" integer NOT NULL,
	"bowler_id" integer NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"refund_kind" text NOT NULL,
	"refund_operation_id" uuid,
	"reference" varchar(255),
	"reason" varchar(500) NOT NULL,
	"actor_user_id" integer NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"request_fingerprint" varchar(96) NOT NULL,
	"issued_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rotating_credit_refunds_amount_check" CHECK ("rotating_credit_refunds"."amount_minor" > 0),
	CONSTRAINT "rotating_credit_refunds_currency_check" CHECK ("currency" = 'USD'),
	CONSTRAINT "rotating_credit_refunds_kind_check" CHECK ((
    ("rotating_credit_refunds"."refund_kind" = 'provider' AND "rotating_credit_refunds"."refund_operation_id" IS NOT NULL AND "rotating_credit_refunds"."reference" IS NULL AND "rotating_credit_refunds"."issued_at" IS NULL)
    OR ("rotating_credit_refunds"."refund_kind" IN ('cash', 'check') AND "rotating_credit_refunds"."refund_operation_id" IS NULL AND "rotating_credit_refunds"."issued_at" IS NOT NULL AND "rotating_credit_refunds"."reference" IS NOT NULL AND length(btrim("rotating_credit_refunds"."reference")) BETWEEN 1 AND 255)
  )),
	CONSTRAINT "rotating_credit_refunds_idempotency_check" CHECK ("rotating_credit_refunds"."idempotency_key" ~ '^[A-Za-z0-9_-]{16,128}$'),
	CONSTRAINT "rotating_credit_refunds_request_fingerprint_check" CHECK ("rotating_credit_refunds"."request_fingerprint" ~ '^lvrotcrrefund:v1:[0-9a-f]{64}$'),
	CONSTRAINT "rotating_credit_refunds_reason_check" CHECK (length(btrim("rotating_credit_refunds"."reason")) BETWEEN 1 AND 500)
);
--> statement-breakpoint
ALTER TABLE "occurrence_payment_responsibilities" DROP CONSTRAINT "occurrence_payment_responsibilities_kind_check";--> statement-breakpoint
ALTER TABLE "team_payment_slots" DROP CONSTRAINT "team_payment_slots_occupant_check";--> statement-breakpoint
DROP INDEX "payment_allocations_payment_obligation_unique";--> statement-breakpoint
ALTER TABLE "payment_obligations" ALTER COLUMN "payer_bowler_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD COLUMN "allocation_kind" text DEFAULT 'ordinary' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_obligation_owner_revisions_unique" ON "payment_obligation_owner_revisions" USING btree ("organization_id","league_id","obligation_id","revision_number");--> statement-breakpoint
CREATE INDEX "payment_obligation_owner_revisions_obligation_current_idx" ON "payment_obligation_owner_revisions" USING btree ("organization_id","league_id","obligation_id","revision_number");--> statement-breakpoint
CREATE UNIQUE INDEX "rotating_occurrence_assignments_identity_unique" ON "rotating_occurrence_assignments" USING btree ("organization_id","league_id","occurrence_id","team_id","slot_index","version");--> statement-breakpoint
CREATE INDEX "rotating_occurrence_assignments_occurrence_team_idx" ON "rotating_occurrence_assignments" USING btree ("organization_id","league_id","occurrence_id","team_id","slot_index","version");--> statement-breakpoint
CREATE UNIQUE INDEX "team_payment_rotation_member_revisions_unique" ON "team_payment_rotation_member_revisions" USING btree ("organization_id","league_id","member_id","revision_number");--> statement-breakpoint
CREATE UNIQUE INDEX "team_payment_rotation_members_tenant_identity_unique" ON "team_payment_rotation_members" USING btree ("id","organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "team_payment_rotation_members_team_bowler_unique" ON "team_payment_rotation_members" USING btree ("organization_id","league_id","team_id","bowler_id");--> statement-breakpoint
CREATE INDEX "team_payment_rotation_members_team_active_idx" ON "team_payment_rotation_members" USING btree ("organization_id","league_id","team_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "rotating_credit_application_reversals_tenant_identity_unique" ON "rotating_credit_application_reversals" USING btree ("id","organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rotating_credit_application_reversals_application_unique" ON "rotating_credit_application_reversals" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "rotating_credit_application_reversals_assignment_idx" ON "rotating_credit_application_reversals" USING btree ("organization_id","league_id","assignment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rotating_credit_applications_allocation_unique" ON "rotating_credit_applications" USING btree ("allocation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rotating_credit_applications_tenant_identity_unique" ON "rotating_credit_applications" USING btree ("id","organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rotating_credit_applications_payment_bowler_identity_unique" ON "rotating_credit_applications" USING btree ("id","organization_id","league_id","payment_id","actual_bowler_id");--> statement-breakpoint
CREATE INDEX "rotating_credit_applications_funding_idx" ON "rotating_credit_applications" USING btree ("organization_id","league_id","funding_id","applied_at");--> statement-breakpoint
CREATE INDEX "rotating_credit_applications_bowler_date_idx" ON "rotating_credit_applications" USING btree ("organization_id","league_id","actual_bowler_id","occurrence_local_date","applied_at");--> statement-breakpoint
CREATE INDEX "rotating_credit_applications_assignment_idx" ON "rotating_credit_applications" USING btree ("organization_id","league_id","assignment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rotating_credit_fundings_payment_unique" ON "rotating_credit_fundings" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rotating_credit_fundings_tenant_identity_unique" ON "rotating_credit_fundings" USING btree ("id","organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rotating_credit_fundings_payment_bowler_identity_unique" ON "rotating_credit_fundings" USING btree ("id","organization_id","league_id","payment_id","bowler_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rotating_credit_fundings_request_identity_unique" ON "rotating_credit_fundings" USING btree ("organization_id","league_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "rotating_credit_fundings_bowler_created_idx" ON "rotating_credit_fundings" USING btree ("organization_id","league_id","bowler_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "rotating_credit_payment_operation_snapshots_operation_pk" ON "rotating_credit_payment_operation_snapshots" USING btree ("operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rotating_credit_refund_operation_snapshots_operation_pk" ON "rotating_credit_refund_operation_snapshots" USING btree ("operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rotating_credit_refunds_request_unique" ON "rotating_credit_refunds" USING btree ("organization_id","league_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "rotating_credit_refunds_tenant_identity_unique" ON "rotating_credit_refunds" USING btree ("id","organization_id","league_id");--> statement-breakpoint
CREATE INDEX "rotating_credit_refunds_funding_idx" ON "rotating_credit_refunds" USING btree ("organization_id","league_id","funding_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "occurrence_payment_responsibilities_occurrence_slot_identity_unique" ON "occurrence_payment_responsibilities" USING btree ("id","organization_id","league_id","occurrence_id","team_id","slot_index");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_allocations_payment_obligation_active_unique" ON "payment_allocations" USING btree ("organization_id","league_id","payment_id","obligation_id") WHERE "payment_allocations"."state" = 'active' AND "payment_allocations"."allocation_kind" = 'ordinary';--> statement-breakpoint
ALTER TABLE "payment_obligation_owner_revisions" ADD CONSTRAINT "payment_obligation_owner_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_obligation_owner_revisions" ADD CONSTRAINT "payment_obligation_owner_revisions_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_obligation_owner_revisions" ADD CONSTRAINT "payment_obligation_owner_revisions_league_tenant_fk" FOREIGN KEY ("league_id","organization_id") REFERENCES "public"."leagues"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_obligation_owner_revisions" ADD CONSTRAINT "payment_obligation_owner_revisions_obligation_fk" FOREIGN KEY ("obligation_id","organization_id","league_id") REFERENCES "public"."payment_obligations"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_obligation_owner_revisions" ADD CONSTRAINT "payment_obligation_owner_revisions_bowler_fk" FOREIGN KEY ("owner_bowler_id","organization_id") REFERENCES "public"."bowlers"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_obligation_owner_revisions" ADD CONSTRAINT "payment_obligation_owner_revisions_team_fk" FOREIGN KEY ("owner_team_id","league_id") REFERENCES "public"."teams"("id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_occurrence_assignments" ADD CONSTRAINT "rotating_occurrence_assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_occurrence_assignments" ADD CONSTRAINT "rotating_occurrence_assignments_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_occurrence_assignments" ADD CONSTRAINT "rotating_occurrence_assignments_league_tenant_fk" FOREIGN KEY ("league_id","organization_id") REFERENCES "public"."leagues"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_occurrence_assignments" ADD CONSTRAINT "rotating_occurrence_assignments_occurrence_fk" FOREIGN KEY ("occurrence_id","organization_id","league_id") REFERENCES "public"."league_occurrences"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_occurrence_assignments" ADD CONSTRAINT "rotating_occurrence_assignments_team_fk" FOREIGN KEY ("team_id","league_id") REFERENCES "public"."teams"("id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_occurrence_assignments" ADD CONSTRAINT "rotating_occurrence_assignments_slot_fk" FOREIGN KEY ("slot_id","organization_id","league_id","team_id","slot_index") REFERENCES "public"."team_payment_slots"("id","organization_id","league_id","team_id","slot_index") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_occurrence_assignments" ADD CONSTRAINT "rotating_occurrence_assignments_responsibility_fk" FOREIGN KEY ("responsibility_id","organization_id","league_id","occurrence_id","team_id","slot_index") REFERENCES "public"."occurrence_payment_responsibilities"("id","organization_id","league_id","occurrence_id","team_id","slot_index") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_occurrence_assignments" ADD CONSTRAINT "rotating_occurrence_assignments_bowler_fk" FOREIGN KEY ("actual_bowler_id","organization_id") REFERENCES "public"."bowlers"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_payment_rotation_member_revisions" ADD CONSTRAINT "team_payment_rotation_member_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_payment_rotation_member_revisions" ADD CONSTRAINT "team_payment_rotation_member_revisions_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_payment_rotation_member_revisions" ADD CONSTRAINT "team_payment_rotation_member_revisions_parent_fk" FOREIGN KEY ("member_id","organization_id","league_id") REFERENCES "public"."team_payment_rotation_members"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_payment_rotation_members" ADD CONSTRAINT "team_payment_rotation_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_payment_rotation_members" ADD CONSTRAINT "team_payment_rotation_members_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_payment_rotation_members" ADD CONSTRAINT "team_payment_rotation_members_league_tenant_fk" FOREIGN KEY ("league_id","organization_id") REFERENCES "public"."leagues"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_payment_rotation_members" ADD CONSTRAINT "team_payment_rotation_members_team_fk" FOREIGN KEY ("team_id","league_id") REFERENCES "public"."teams"("id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_payment_rotation_members" ADD CONSTRAINT "team_payment_rotation_members_bowler_fk" FOREIGN KEY ("bowler_id","organization_id") REFERENCES "public"."bowlers"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_credit_application_reversals" ADD CONSTRAINT "rotating_credit_application_reversals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_credit_application_reversals" ADD CONSTRAINT "rotating_credit_application_reversals_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_credit_application_reversals" ADD CONSTRAINT "rotating_credit_application_reversals_league_tenant_fk" FOREIGN KEY ("league_id","organization_id") REFERENCES "public"."leagues"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_credit_application_reversals" ADD CONSTRAINT "rotating_credit_application_reversals_application_fk" FOREIGN KEY ("application_id","organization_id","league_id") REFERENCES "public"."rotating_credit_applications"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_credit_application_reversals" ADD CONSTRAINT "rotating_credit_application_reversals_application_payment_bowler_fk" FOREIGN KEY ("application_id","organization_id","league_id","funding_payment_id","bowler_id") REFERENCES "public"."rotating_credit_applications"("id","organization_id","league_id","payment_id","actual_bowler_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_credit_application_reversals" ADD CONSTRAINT "rotating_credit_application_reversals_payment_fk" FOREIGN KEY ("funding_payment_id","organization_id","league_id") REFERENCES "public"."payments"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_credit_application_reversals" ADD CONSTRAINT "rotating_credit_application_reversals_allocation_fk" FOREIGN KEY ("allocation_id","organization_id","league_id") REFERENCES "public"."payment_allocations"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_credit_applications" ADD CONSTRAINT "rotating_credit_applications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_credit_applications" ADD CONSTRAINT "rotating_credit_applications_applied_by_user_id_users_id_fk" FOREIGN KEY ("applied_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_credit_applications" ADD CONSTRAINT "rotating_credit_applications_league_tenant_fk" FOREIGN KEY ("league_id","organization_id") REFERENCES "public"."leagues"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_credit_applications" ADD CONSTRAINT "rotating_credit_applications_funding_fk" FOREIGN KEY ("funding_id","organization_id","league_id","payment_id","actual_bowler_id") REFERENCES "public"."rotating_credit_fundings"("id","organization_id","league_id","payment_id","bowler_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_credit_applications" ADD CONSTRAINT "rotating_credit_applications_payment_fk" FOREIGN KEY ("payment_id","organization_id","league_id") REFERENCES "public"."payments"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_credit_applications" ADD CONSTRAINT "rotating_credit_applications_allocation_fk" FOREIGN KEY ("allocation_id","organization_id","league_id") REFERENCES "public"."payment_allocations"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_credit_applications" ADD CONSTRAINT "rotating_credit_applications_obligation_fk" FOREIGN KEY ("obligation_id","organization_id","league_id") REFERENCES "public"."payment_obligations"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_credit_applications" ADD CONSTRAINT "rotating_credit_applications_bowler_tenant_fk" FOREIGN KEY ("actual_bowler_id","organization_id") REFERENCES "public"."bowlers"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_credit_fundings" ADD CONSTRAINT "rotating_credit_fundings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_credit_fundings" ADD CONSTRAINT "rotating_credit_fundings_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_credit_fundings" ADD CONSTRAINT "rotating_credit_fundings_league_tenant_fk" FOREIGN KEY ("league_id","organization_id") REFERENCES "public"."leagues"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_credit_fundings" ADD CONSTRAINT "rotating_credit_fundings_bowler_tenant_fk" FOREIGN KEY ("bowler_id","organization_id") REFERENCES "public"."bowlers"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_credit_fundings" ADD CONSTRAINT "rotating_credit_fundings_payment_tenant_fk" FOREIGN KEY ("payment_id","organization_id","league_id") REFERENCES "public"."payments"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_credit_payment_operation_snapshots" ADD CONSTRAINT "rotating_credit_payment_operation_snapshots_league_tenant_fk" FOREIGN KEY ("league_id","organization_id") REFERENCES "public"."leagues"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_credit_payment_operation_snapshots" ADD CONSTRAINT "rotating_credit_payment_operation_snapshots_operation_fk" FOREIGN KEY ("operation_id","organization_id","league_id") REFERENCES "public"."payment_operations"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_credit_payment_operation_snapshots" ADD CONSTRAINT "rotating_credit_payment_operation_snapshots_bowler_tenant_fk" FOREIGN KEY ("bowler_id","organization_id") REFERENCES "public"."bowlers"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_credit_payment_operation_snapshots" ADD CONSTRAINT "rotating_credit_payment_operation_snapshots_location_tenant_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_credit_refund_operation_snapshots" ADD CONSTRAINT "rotating_credit_refund_operation_snapshots_league_tenant_fk" FOREIGN KEY ("league_id","organization_id") REFERENCES "public"."leagues"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_credit_refund_operation_snapshots" ADD CONSTRAINT "rotating_credit_refund_operation_snapshots_operation_fk" FOREIGN KEY ("operation_id","organization_id","league_id") REFERENCES "public"."payment_operations"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_credit_refund_operation_snapshots" ADD CONSTRAINT "rotating_credit_refund_operation_snapshots_funding_fk" FOREIGN KEY ("funding_id","organization_id","league_id","payment_id","bowler_id") REFERENCES "public"."rotating_credit_fundings"("id","organization_id","league_id","payment_id","bowler_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_credit_refund_operation_snapshots" ADD CONSTRAINT "rotating_credit_refund_operation_snapshots_payment_fk" FOREIGN KEY ("payment_id","organization_id","league_id") REFERENCES "public"."payments"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_credit_refund_operation_snapshots" ADD CONSTRAINT "rotating_credit_refund_operation_snapshots_bowler_tenant_fk" FOREIGN KEY ("bowler_id","organization_id") REFERENCES "public"."bowlers"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_credit_refund_operation_snapshots" ADD CONSTRAINT "rotating_credit_refund_operation_snapshots_location_tenant_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_credit_refunds" ADD CONSTRAINT "rotating_credit_refunds_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_credit_refunds" ADD CONSTRAINT "rotating_credit_refunds_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_credit_refunds" ADD CONSTRAINT "rotating_credit_refunds_league_tenant_fk" FOREIGN KEY ("league_id","organization_id") REFERENCES "public"."leagues"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_credit_refunds" ADD CONSTRAINT "rotating_credit_refunds_funding_fk" FOREIGN KEY ("funding_id","organization_id","league_id","payment_id","bowler_id") REFERENCES "public"."rotating_credit_fundings"("id","organization_id","league_id","payment_id","bowler_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_credit_refunds" ADD CONSTRAINT "rotating_credit_refunds_payment_fk" FOREIGN KEY ("payment_id","organization_id","league_id") REFERENCES "public"."payments"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_credit_refunds" ADD CONSTRAINT "rotating_credit_refunds_bowler_tenant_fk" FOREIGN KEY ("bowler_id","organization_id") REFERENCES "public"."bowlers"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotating_credit_refunds" ADD CONSTRAINT "rotating_credit_refunds_operation_fk" FOREIGN KEY ("refund_operation_id","organization_id","league_id") REFERENCES "public"."payment_operations"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "occurrence_payment_responsibilities" ADD CONSTRAINT "occurrence_payment_responsibilities_kind_check" CHECK ("occurrence_payment_responsibilities"."responsibility_kind" IN ('main', 'substitute', 'split', 'vacant', 'rotating') AND ((
    "occurrence_payment_responsibilities"."responsibility_kind" = 'vacant' AND "occurrence_payment_responsibilities"."main_bowler_id" IS NULL AND "occurrence_payment_responsibilities"."substitute_bowler_id" IS NULL AND "occurrence_payment_responsibilities"."payer_bowler_id" IS NULL AND "occurrence_payment_responsibilities"."amount_minor" = 0 AND "occurrence_payment_responsibilities"."lineage_amount_minor" IS NULL AND "occurrence_payment_responsibilities"."prize_fund_amount_minor" IS NULL
  ) OR (
    "occurrence_payment_responsibilities"."responsibility_kind" = 'main' AND "occurrence_payment_responsibilities"."main_bowler_id" IS NOT NULL AND "occurrence_payment_responsibilities"."substitute_bowler_id" IS NULL AND "occurrence_payment_responsibilities"."payer_bowler_id" IS NOT NULL AND "occurrence_payment_responsibilities"."payer_bowler_id" = "occurrence_payment_responsibilities"."main_bowler_id" AND "occurrence_payment_responsibilities"."amount_minor" > 0
  ) OR (
    "occurrence_payment_responsibilities"."responsibility_kind" = 'substitute' AND "occurrence_payment_responsibilities"."main_bowler_id" IS NOT NULL AND "occurrence_payment_responsibilities"."substitute_bowler_id" IS NOT NULL AND "occurrence_payment_responsibilities"."main_bowler_id" <> "occurrence_payment_responsibilities"."substitute_bowler_id" AND "occurrence_payment_responsibilities"."payer_bowler_id" IS NOT NULL AND "occurrence_payment_responsibilities"."amount_minor" > 0
  ) OR (
    "occurrence_payment_responsibilities"."responsibility_kind" = 'split' AND "occurrence_payment_responsibilities"."main_bowler_id" IS NOT NULL AND "occurrence_payment_responsibilities"."substitute_bowler_id" IS NOT NULL AND "occurrence_payment_responsibilities"."main_bowler_id" <> "occurrence_payment_responsibilities"."substitute_bowler_id" AND "occurrence_payment_responsibilities"."payer_bowler_id" IS NOT NULL AND "occurrence_payment_responsibilities"."amount_minor" > 0
  ) OR (
    "occurrence_payment_responsibilities"."responsibility_kind" = 'rotating' AND "occurrence_payment_responsibilities"."main_bowler_id" IS NULL AND "occurrence_payment_responsibilities"."substitute_bowler_id" IS NULL AND "occurrence_payment_responsibilities"."payer_bowler_id" IS NULL AND "occurrence_payment_responsibilities"."amount_minor" > 0
  )) AND (("occurrence_payment_responsibilities"."responsibility_kind" = 'split' AND "occurrence_payment_responsibilities"."lineage_payer_bowler_id" IS NOT NULL AND "occurrence_payment_responsibilities"."prize_payer_bowler_id" IS NOT NULL AND "occurrence_payment_responsibilities"."lineage_amount_minor" IS NOT NULL AND "occurrence_payment_responsibilities"."prize_fund_amount_minor" IS NOT NULL AND "occurrence_payment_responsibilities"."lineage_amount_minor" >= 0 AND "occurrence_payment_responsibilities"."prize_fund_amount_minor" >= 0 AND "occurrence_payment_responsibilities"."lineage_amount_minor" + "occurrence_payment_responsibilities"."prize_fund_amount_minor" = "occurrence_payment_responsibilities"."amount_minor" AND "occurrence_payment_responsibilities"."amount_minor" > 0) OR ("occurrence_payment_responsibilities"."responsibility_kind" <> 'split' AND "occurrence_payment_responsibilities"."lineage_payer_bowler_id" IS NULL AND "occurrence_payment_responsibilities"."prize_payer_bowler_id" IS NULL AND "occurrence_payment_responsibilities"."lineage_amount_minor" IS NULL AND "occurrence_payment_responsibilities"."prize_fund_amount_minor" IS NULL)));--> statement-breakpoint
ALTER TABLE "team_payment_slots" ADD CONSTRAINT "team_payment_slots_occupant_check" CHECK ("team_payment_slots"."occupant" IN ('unassigned', 'main', 'vacant', 'rotating') AND (("team_payment_slots"."occupant" = 'main' AND "team_payment_slots"."main_bowler_id" IS NOT NULL) OR ("team_payment_slots"."occupant" <> 'main' AND "team_payment_slots"."main_bowler_id" IS NULL)));
--> statement-breakpoint
-- Current ownership is an append-only sidecar to the original payer identity.
-- A payer-less obligation is valid only when the final owner revision names
-- the team of the canonical responsibility. Team ownership may also supersede
-- a historical bowler payer, but it must always name that same team.
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_kind_check" CHECK ("payment_allocations"."allocation_kind" IN ('ordinary', 'rotating_credit'));--> statement-breakpoint
CREATE FUNCTION rotating_payment_obligation_owner_commit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_obligation_id uuid;
  target_organization_id integer;
  target_league_id integer;
  obligation_row record;
  owner_row record;
BEGIN
  target_obligation_id := COALESCE((to_jsonb(NEW)->>'obligation_id')::uuid, (to_jsonb(OLD)->>'obligation_id')::uuid, (to_jsonb(NEW)->>'id')::uuid, (to_jsonb(OLD)->>'id')::uuid);
  target_organization_id := COALESCE((to_jsonb(NEW)->>'organization_id')::integer, (to_jsonb(OLD)->>'organization_id')::integer);
  target_league_id := COALESCE((to_jsonb(NEW)->>'league_id')::integer, (to_jsonb(OLD)->>'league_id')::integer);

  SELECT po.id, po.payer_bowler_id, responsibility.team_id
    INTO obligation_row
    FROM payment_obligations po
    JOIN occurrence_payment_responsibilities responsibility
      ON responsibility.id = po.responsibility_id
     AND responsibility.organization_id = po.organization_id
     AND responsibility.league_id = po.league_id
   WHERE po.id = target_obligation_id
     AND po.organization_id = target_organization_id
     AND po.league_id = target_league_id;
  IF NOT FOUND THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT owner_kind, owner_bowler_id, owner_team_id
    INTO owner_row
    FROM payment_obligation_owner_revisions
   WHERE obligation_id = target_obligation_id
     AND organization_id = target_organization_id
     AND league_id = target_league_id
   ORDER BY revision_number DESC, id ASC
   LIMIT 1;
  IF NOT FOUND THEN
    IF obligation_row.payer_bowler_id IS NULL THEN
      RAISE EXCEPTION 'payer-less obligation requires a current team owner revision';
    END IF;
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF owner_row.owner_kind = 'team' AND owner_row.owner_team_id <> obligation_row.team_id THEN
    RAISE EXCEPTION 'team owner revision does not match its obligation responsibility';
  END IF;
  IF obligation_row.payer_bowler_id IS NULL
     AND (owner_row.owner_kind <> 'team' OR owner_row.owner_team_id IS DISTINCT FROM obligation_row.team_id)
  THEN
    RAISE EXCEPTION 'payer-less obligation must remain owned by its responsibility team';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payment_obligation_owner_commit_guard
AFTER INSERT OR UPDATE ON payment_obligations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION rotating_payment_obligation_owner_commit_guard();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payment_obligation_owner_revision_commit_guard
AFTER INSERT ON payment_obligation_owner_revisions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION rotating_payment_obligation_owner_commit_guard();--> statement-breakpoint

-- Serialize owner revisions on their obligation, require contiguous history,
-- and prohibit rewriting historical ownership evidence.
CREATE FUNCTION rotating_payment_obligation_owner_revision_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expected_revision integer;
BEGIN
  PERFORM 1 FROM payment_obligations
   WHERE id = NEW.obligation_id
     AND organization_id = NEW.organization_id
     AND league_id = NEW.league_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'owner revision obligation is missing from its tenant scope';
  END IF;
  SELECT COALESCE(MAX(revision_number), 0) + 1
    INTO expected_revision
    FROM payment_obligation_owner_revisions
   WHERE obligation_id = NEW.obligation_id
     AND organization_id = NEW.organization_id
     AND league_id = NEW.league_id;
  IF NEW.revision_number <> expected_revision THEN
    RAISE EXCEPTION 'owner revision number must append to the current history';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER payment_obligation_owner_revision_insert_guard
BEFORE INSERT ON payment_obligation_owner_revisions
FOR EACH ROW EXECUTE FUNCTION rotating_payment_obligation_owner_revision_insert_guard();--> statement-breakpoint

-- Credit fundings are prepaid parent tenders. Their child allocations are
-- deliberately partial; only immutable application rows may create those
-- allocations, and reversals must void the exact original allocation once.
CREATE FUNCTION rotating_credit_assert_ledger(p_payment_id integer) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  funding_row record;
  operation_row record;
  operation_snapshot record;
  application_row record;
  refund_row record;
  obligation_row record;
  owner_row record;
  applied_minor bigint := 0;
  refund_minor bigint := 0;
BEGIN
  SELECT f.id, f.organization_id, f.league_id, f.bowler_id, f.payment_id,
         f.amount_minor, f.currency, f.funding_kind, f.idempotency_key,
         f.quote_fingerprint, f.actor_user_id, p.type AS payment_type, p.status AS payment_status,
         p.amount AS payment_amount, p.currency AS payment_currency,
         p.bowler_id AS payment_bowler_id,
         p.provider_payment_id, p.payment_operation_id, p.dispute_id, p.disputed_at,
         league.location_id AS league_location_id
    INTO funding_row
    FROM rotating_credit_fundings f
    JOIN payments p
      ON p.id = f.payment_id
     AND p.organization_id = f.organization_id
     AND p.league_id = f.league_id
    JOIN leagues league
      ON league.id = f.league_id
     AND league.organization_id = f.organization_id
   WHERE f.payment_id = p_payment_id
   FOR UPDATE OF f, p;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF funding_row.amount_minor <= 0
     OR funding_row.amount_minor <> funding_row.payment_amount
     OR funding_row.bowler_id <> funding_row.payment_bowler_id
     OR funding_row.currency <> 'USD'
     OR funding_row.payment_currency <> funding_row.currency
     OR funding_row.payment_status <> 'paid'
     OR funding_row.dispute_id IS NOT NULL
     OR funding_row.disputed_at IS NOT NULL
     OR (funding_row.funding_kind = 'cash' AND (funding_row.payment_type <> 'cash' OR funding_row.payment_operation_id IS NOT NULL OR funding_row.provider_payment_id IS NOT NULL))
     OR (funding_row.funding_kind = 'check' AND (funding_row.payment_type <> 'check' OR funding_row.payment_operation_id IS NOT NULL OR funding_row.provider_payment_id IS NOT NULL))
     OR (funding_row.funding_kind = 'provider' AND funding_row.payment_type NOT IN ('square', 'credit_card'))
  THEN
    RAISE EXCEPTION 'rotating credit funding does not match its real tender parent';
  END IF;

  IF funding_row.funding_kind = 'provider' THEN
    SELECT operation_type, status, amount_minor, currency, provider_object_id,
           provider_name, authorizing_user_id, target_key
      INTO operation_row
      FROM payment_operations
     WHERE id = funding_row.payment_operation_id
       AND organization_id = funding_row.organization_id
       AND league_id = funding_row.league_id;
    IF NOT FOUND
       OR operation_row.operation_type <> 'interactive_charge'
       OR operation_row.status NOT IN ('succeeded', 'reconciliation_required')
       OR operation_row.amount_minor <> funding_row.amount_minor
       OR operation_row.currency <> funding_row.currency
       OR operation_row.provider_name IS DISTINCT FROM 'square'
       OR operation_row.authorizing_user_id IS DISTINCT FROM funding_row.actor_user_id
       OR operation_row.target_key NOT LIKE 'interactive-charge:rotating-credit:%'
       OR length(operation_row.target_key) <> length('interactive-charge:rotating-credit:') + 64
       OR substring(operation_row.target_key FROM length('interactive-charge:rotating-credit:') + 1) !~ '^[0-9a-f]{64}$'
       OR operation_row.provider_object_id IS NULL
       OR operation_row.provider_object_id <> funding_row.provider_payment_id
    THEN
      RAISE EXCEPTION 'provider credit funding does not match its durable charge operation';
    END IF;
    SELECT bowler_id, amount_minor, currency, quote_fingerprint, idempotency_key,
           location_id, provider_location_id
      INTO operation_snapshot
      FROM rotating_credit_payment_operation_snapshots
     WHERE operation_id = funding_row.payment_operation_id
       AND organization_id = funding_row.organization_id
       AND league_id = funding_row.league_id;
    IF NOT FOUND
       OR operation_snapshot.bowler_id <> funding_row.bowler_id
       OR operation_snapshot.amount_minor <> funding_row.amount_minor
       OR operation_snapshot.currency <> funding_row.currency
       OR operation_snapshot.quote_fingerprint <> funding_row.quote_fingerprint
       OR operation_snapshot.idempotency_key <> funding_row.idempotency_key
       OR operation_snapshot.location_id IS DISTINCT FROM funding_row.league_location_id
       OR operation_snapshot.provider_location_id IS NOT NULL
    THEN
      RAISE EXCEPTION 'provider credit funding does not match its immutable charge snapshot';
    END IF;
    IF EXISTS (
      SELECT 1
        FROM payment_operation_roster_snapshots roster_snapshot
       WHERE roster_snapshot.operation_id = funding_row.payment_operation_id
         AND roster_snapshot.organization_id = funding_row.organization_id
         AND roster_snapshot.league_id = funding_row.league_id
    ) THEN
      RAISE EXCEPTION 'rotating credit funding cannot reuse an ordinary roster charge snapshot';
    END IF;
  ELSIF funding_row.payment_operation_id IS NOT NULL OR funding_row.provider_payment_id IS NOT NULL THEN
    RAISE EXCEPTION 'manual credit funding cannot reference provider payment evidence';
  END IF;

  IF EXISTS (
    SELECT 1 FROM payment_voids payment_void
     WHERE payment_void.payment_id = funding_row.payment_id
       AND payment_void.organization_id = funding_row.organization_id
       AND payment_void.league_id = funding_row.league_id
  ) THEN
    RAISE EXCEPTION 'rotating credit funding cannot be voided as an ordinary tender';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM payment_allocations allocation
      LEFT JOIN rotating_credit_applications application
        ON application.allocation_id = allocation.id
       AND application.organization_id = allocation.organization_id
       AND application.league_id = allocation.league_id
     WHERE allocation.payment_id = funding_row.payment_id
       AND allocation.organization_id = funding_row.organization_id
       AND allocation.league_id = funding_row.league_id
       AND (allocation.allocation_kind <> 'rotating_credit' OR application.id IS NULL)
  ) THEN
    RAISE EXCEPTION 'rotating credit allocation must use its discriminator and have one exact immutable application';
  END IF;

  FOR application_row IN
    SELECT application.id, application.organization_id, application.league_id,
           application.funding_id, application.payment_id, application.allocation_id,
           application.obligation_id, application.assignment_id, application.responsibility_id,
           application.actual_bowler_id, application.team_id, application.slot_index,
           application.occurrence_id, application.amount_minor, application.currency,
           allocation.allocation_kind,
           allocation.state AS allocation_state, allocation.payment_id AS allocation_payment_id,
           allocation.obligation_id AS allocation_obligation_id,
           allocation.amount_minor AS allocation_amount_minor,
           allocation.currency AS allocation_currency,
           reversal.id AS reversal_id, reversal.funding_payment_id AS reversal_payment_id,
           reversal.allocation_id AS reversal_allocation_id,
           reversal.obligation_id AS reversal_obligation_id,
           reversal.assignment_id AS reversal_assignment_id,
           reversal.bowler_id AS reversal_bowler_id, reversal.amount_minor AS reversal_amount_minor
      FROM rotating_credit_applications application
      JOIN payment_allocations allocation
        ON allocation.id = application.allocation_id
       AND allocation.organization_id = application.organization_id
       AND allocation.league_id = application.league_id
      LEFT JOIN rotating_credit_application_reversals reversal
        ON reversal.application_id = application.id
       AND reversal.organization_id = application.organization_id
       AND reversal.league_id = application.league_id
     WHERE application.funding_id = funding_row.id
       AND application.organization_id = funding_row.organization_id
       AND application.league_id = funding_row.league_id
     ORDER BY application.id
  LOOP
    IF application_row.payment_id <> funding_row.payment_id
       OR application_row.actual_bowler_id <> funding_row.bowler_id
       OR application_row.allocation_kind <> 'rotating_credit'
       OR application_row.allocation_payment_id <> funding_row.payment_id
       OR application_row.allocation_obligation_id <> application_row.obligation_id
       OR application_row.allocation_amount_minor <> application_row.amount_minor
       OR application_row.allocation_currency <> application_row.currency
       OR application_row.currency <> funding_row.currency
    THEN
      RAISE EXCEPTION 'rotating credit application does not match its funding allocation';
    END IF;

    SELECT po.id, po.occurrence_id, po.responsibility_id, responsibility.team_id,
           responsibility.slot_index
      INTO obligation_row
      FROM payment_obligations po
      JOIN occurrence_payment_responsibilities responsibility
        ON responsibility.id = po.responsibility_id
       AND responsibility.organization_id = po.organization_id
       AND responsibility.league_id = po.league_id
     WHERE po.id = application_row.obligation_id
       AND po.organization_id = funding_row.organization_id
       AND po.league_id = funding_row.league_id;
    IF NOT FOUND
       OR obligation_row.occurrence_id <> application_row.occurrence_id
       OR obligation_row.responsibility_id <> application_row.responsibility_id
       OR obligation_row.team_id <> application_row.team_id
       OR obligation_row.slot_index <> application_row.slot_index
    THEN
      RAISE EXCEPTION 'rotating credit application does not match its canonical obligation';
    END IF;

  IF NOT EXISTS (
      SELECT 1 FROM rotating_occurrence_assignments assignment
       WHERE assignment.id = application_row.assignment_id
         AND assignment.organization_id = funding_row.organization_id
         AND assignment.league_id = funding_row.league_id
         AND assignment.occurrence_id = application_row.occurrence_id
         AND assignment.team_id = application_row.team_id
         AND assignment.slot_index = application_row.slot_index
         AND assignment.responsibility_id = application_row.responsibility_id
         AND assignment.actual_bowler_id = application_row.actual_bowler_id
    ) THEN
      RAISE EXCEPTION 'rotating credit application does not match its confirmed assignment';
    END IF;
    IF application_row.reversal_id IS NULL AND NOT EXISTS (
      SELECT 1
        FROM rotating_occurrence_assignments current_assignment
       WHERE current_assignment.id = application_row.assignment_id
         AND current_assignment.organization_id = funding_row.organization_id
         AND current_assignment.league_id = funding_row.league_id
         AND current_assignment.occurrence_id = application_row.occurrence_id
         AND current_assignment.team_id = application_row.team_id
         AND current_assignment.slot_index = application_row.slot_index
         AND current_assignment.responsibility_id = application_row.responsibility_id
         AND current_assignment.actual_bowler_id = application_row.actual_bowler_id
         AND current_assignment.version = (
           SELECT max(latest_assignment.version)
             FROM rotating_occurrence_assignments latest_assignment
            WHERE latest_assignment.organization_id = current_assignment.organization_id
              AND latest_assignment.league_id = current_assignment.league_id
              AND latest_assignment.occurrence_id = current_assignment.occurrence_id
              AND latest_assignment.team_id = current_assignment.team_id
              AND latest_assignment.slot_index = current_assignment.slot_index
         )
    ) THEN
      RAISE EXCEPTION 'active rotating credit application must match the current confirmed assignment';
    END IF;

    SELECT owner_kind, owner_team_id
      INTO owner_row
      FROM payment_obligation_owner_revisions
     WHERE obligation_id = application_row.obligation_id
       AND organization_id = funding_row.organization_id
       AND league_id = funding_row.league_id
     ORDER BY revision_number DESC, id ASC
     LIMIT 1;
    IF NOT FOUND OR owner_row.owner_kind <> 'team' OR owner_row.owner_team_id <> application_row.team_id THEN
      RAISE EXCEPTION 'rotating credit application requires a current team-owned obligation';
    END IF;

    IF application_row.reversal_id IS NULL THEN
      IF application_row.allocation_state <> 'active' THEN
        RAISE EXCEPTION 'unreversed rotating credit application must retain an active allocation';
      END IF;
      applied_minor := applied_minor + application_row.amount_minor;
    ELSIF application_row.allocation_state <> 'voided'
       OR application_row.reversal_payment_id <> funding_row.payment_id
       OR application_row.reversal_allocation_id <> application_row.allocation_id
       OR application_row.reversal_obligation_id <> application_row.obligation_id
       OR application_row.reversal_assignment_id <> application_row.assignment_id
       OR application_row.reversal_bowler_id <> application_row.actual_bowler_id
       OR application_row.reversal_amount_minor <> application_row.amount_minor
    THEN
      RAISE EXCEPTION 'rotating credit reversal must void the exact original application allocation';
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM rotating_credit_refund_operation_snapshots snapshot
     WHERE snapshot.funding_id = funding_row.id
       AND snapshot.organization_id = funding_row.organization_id
       AND snapshot.league_id = funding_row.league_id
       AND NOT EXISTS (
         SELECT 1 FROM rotating_credit_refunds refund
          WHERE refund.refund_operation_id = snapshot.operation_id
            AND refund.funding_id = snapshot.funding_id
            AND refund.organization_id = snapshot.organization_id
            AND refund.league_id = snapshot.league_id
       )
  ) THEN
    RAISE EXCEPTION 'rotating credit refund snapshot is missing its refund ledger entry';
  END IF;

  FOR refund_row IN
    SELECT refund.id, refund.organization_id, refund.league_id, refund.funding_id,
           refund.payment_id, refund.bowler_id, refund.amount_minor, refund.currency,
           refund.refund_kind, refund.refund_operation_id, refund.reference, refund.reason,
           refund.actor_user_id, refund.idempotency_key,
           refund.issued_at, operation.id AS operation_id,
           operation.operation_type, operation.status AS operation_status,
           operation.amount_minor AS operation_amount_minor,
           operation.currency AS operation_currency,
           operation.error_classification,
           operation.error_code,
           operation.authorizing_user_id,
           operation.provider_name,
           operation.target_key,
           operation.provider_object_id,
           snapshot.operation_id AS snapshot_operation_id,
           snapshot.funding_id AS snapshot_funding_id,
           snapshot.payment_id AS snapshot_payment_id,
           snapshot.bowler_id AS snapshot_bowler_id,
           snapshot.amount_minor AS snapshot_amount_minor,
           snapshot.currency AS snapshot_currency,
           snapshot.provider_payment_id AS snapshot_provider_payment_id,
           snapshot.location_id AS snapshot_location_id,
           snapshot.reason AS snapshot_reason
      FROM rotating_credit_refunds refund
      LEFT JOIN payment_operations operation
        ON operation.id = refund.refund_operation_id
       AND operation.organization_id = refund.organization_id
       AND operation.league_id = refund.league_id
      LEFT JOIN rotating_credit_refund_operation_snapshots snapshot
        ON snapshot.operation_id = refund.refund_operation_id
       AND snapshot.organization_id = refund.organization_id
       AND snapshot.league_id = refund.league_id
     WHERE refund.funding_id = funding_row.id
       AND refund.organization_id = funding_row.organization_id
       AND refund.league_id = funding_row.league_id
     ORDER BY refund.id
  LOOP
    IF refund_row.payment_id <> funding_row.payment_id
       OR refund_row.bowler_id <> funding_row.bowler_id
       OR refund_row.amount_minor <= 0
       OR refund_row.currency <> funding_row.currency
    THEN
      RAISE EXCEPTION 'rotating credit refund does not match its funding lot';
    END IF;
    IF refund_row.refund_kind IN ('cash', 'check') THEN
      IF refund_row.refund_operation_id IS NOT NULL
         OR refund_row.issued_at IS NULL
         OR refund_row.reference IS NULL
         OR length(btrim(refund_row.reference)) NOT BETWEEN 1 AND 255
      THEN
        RAISE EXCEPTION 'manual rotating credit refund is missing issuance evidence';
      END IF;
      refund_minor := refund_minor + refund_row.amount_minor;
    ELSE
      IF refund_row.refund_kind <> 'provider'
         OR refund_row.refund_operation_id IS NULL
         OR refund_row.issued_at IS NOT NULL
         OR refund_row.reference IS NOT NULL
         OR refund_row.operation_id IS NULL
         OR refund_row.snapshot_operation_id IS NULL
         OR refund_row.operation_type IS DISTINCT FROM 'refund'
         OR refund_row.authorizing_user_id IS DISTINCT FROM refund_row.actor_user_id
         OR refund_row.provider_name IS DISTINCT FROM 'square'
         OR refund_row.target_key NOT LIKE ('rotating-credit-refund:' || funding_row.id::text || ':%')
         OR length(refund_row.target_key) <> length('rotating-credit-refund:' || funding_row.id::text || ':') + 64
         OR substring(refund_row.target_key FROM length('rotating-credit-refund:' || funding_row.id::text || ':') + 1) !~ '^[0-9a-f]{64}$'
         OR refund_row.operation_amount_minor IS DISTINCT FROM refund_row.amount_minor
         OR refund_row.operation_currency IS DISTINCT FROM refund_row.currency
         OR refund_row.snapshot_funding_id IS DISTINCT FROM funding_row.id
         OR refund_row.snapshot_payment_id IS DISTINCT FROM funding_row.payment_id
         OR refund_row.snapshot_bowler_id IS DISTINCT FROM funding_row.bowler_id
         OR refund_row.snapshot_amount_minor IS DISTINCT FROM refund_row.amount_minor
         OR refund_row.snapshot_currency IS DISTINCT FROM refund_row.currency
         OR refund_row.snapshot_provider_payment_id IS DISTINCT FROM funding_row.provider_payment_id
         OR refund_row.snapshot_location_id IS NULL
         OR refund_row.snapshot_location_id IS DISTINCT FROM funding_row.league_location_id
         OR refund_row.snapshot_reason IS DISTINCT FROM refund_row.reason
      THEN
        RAISE EXCEPTION 'provider rotating credit refund does not match its immutable refund snapshot';
      END IF;
      IF refund_row.operation_status IN ('pending', 'leased', 'provider_unknown', 'retry_scheduled', 'reconciliation_required') THEN
        refund_minor := refund_minor + refund_row.amount_minor;
      ELSIF refund_row.operation_status = 'action_required' THEN
        IF refund_row.provider_object_id IS NOT NULL
           OR refund_row.error_classification IS DISTINCT FROM 'hard_decline'
           OR refund_row.error_code IS DISTINCT FROM 'REFUND_DECLINED' THEN
          -- A new-request hard decline without a Square refund object is a
          -- definitive no-effect outcome. Any weaker or contradictory
          -- action-required evidence remains held for review.
          refund_minor := refund_minor + refund_row.amount_minor;
        END IF;
      ELSIF refund_row.operation_status = 'succeeded' THEN
        IF refund_row.provider_object_id IS NULL THEN
          RAISE EXCEPTION 'completed provider credit refund is missing its provider identity';
        END IF;
        refund_minor := refund_minor + refund_row.amount_minor;
      ELSIF refund_row.operation_status = 'failed_terminal' THEN
        IF refund_row.provider_object_id IS NOT NULL
           AND (
             refund_row.error_classification IS DISTINCT FROM 'invalid_request'
             OR (
               refund_row.error_code IS DISTINCT FROM 'REFUND_REJECTED'
               AND refund_row.error_code IS DISTINCT FROM 'REFUND_FAILED'
             )
           ) THEN
          -- A terminal row with an unidentified provider object is still
          -- retained as a review hold. Square's explicit REJECTED/FAILED
          -- outcomes are certain and mean no refund was issued.
          refund_minor := refund_minor + refund_row.amount_minor;
        END IF;
      ELSIF refund_row.operation_status = 'canceled' THEN
        IF refund_row.provider_object_id IS NOT NULL THEN
          refund_minor := refund_minor + refund_row.amount_minor;
        END IF;
      ELSE
        RAISE EXCEPTION 'provider credit refund has unsupported outcome evidence';
      END IF;
    END IF;
  END LOOP;

  IF applied_minor + refund_minor > funding_row.amount_minor THEN
    RAISE EXCEPTION 'rotating credit applications and refunds exceed the original funding amount';
  END IF;
END;
$$;--> statement-breakpoint

-- Preserve canonical full-parent conservation for ordinary tenders. A
-- rotating-credit funding parent instead invokes the ledger guard above and
-- permits unallocated prepaid value while forbidding direct/voided children.
CREATE OR REPLACE FUNCTION roster_payment_allocation_conservation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_payment_id integer;
  parent_amount integer;
  parent_status text;
  parent_currency text;
  parent_provider_id text;
  parent_operation_id uuid;
  operation_row record;
  allocation_count integer;
  active_count integer;
  voided_count integer;
  allocation_total bigint;
  has_void boolean;
  has_credit_funding boolean;
  obligation_row record;
  obligation_total bigint;
BEGIN
  IF TG_TABLE_NAME = 'payments' THEN
    parent_payment_id := (to_jsonb(NEW)->>'id')::integer;
  ELSIF TG_TABLE_NAME = 'payment_voids' THEN
    parent_payment_id := (to_jsonb(NEW)->>'payment_id')::integer;
  ELSE
    parent_payment_id := COALESCE((to_jsonb(NEW)->>'payment_id')::integer, (to_jsonb(OLD)->>'payment_id')::integer);
  END IF;
  SELECT amount, status, currency, provider_payment_id, payment_operation_id
    INTO parent_amount, parent_status, parent_currency, parent_provider_id, parent_operation_id
    FROM payments
   WHERE id = parent_payment_id
   FOR UPDATE;
  IF parent_amount IS NULL THEN
    RAISE EXCEPTION 'allocation payment is missing from its tenant scope';
  END IF;
  IF parent_operation_id IS NOT NULL THEN
    SELECT operation_type, amount_minor, currency, provider_object_id
      INTO operation_row
      FROM payment_operations WHERE id = parent_operation_id FOR SHARE;
    IF operation_row IS NULL
      OR operation_row.operation_type NOT IN ('interactive_charge', 'standing_autopay_charge')
      OR operation_row.amount_minor <> parent_amount
      OR operation_row.currency <> parent_currency
      OR operation_row.provider_object_id IS NULL
      OR operation_row.provider_object_id <> parent_provider_id
    THEN
      RAISE EXCEPTION 'payment operation evidence does not match its tender parent';
    END IF;
  END IF;
  SELECT EXISTS (SELECT 1 FROM payment_voids WHERE payment_id = parent_payment_id)
    INTO has_void;
  SELECT EXISTS (SELECT 1 FROM rotating_credit_fundings WHERE payment_id = parent_payment_id)
    INTO has_credit_funding;
  SELECT count(*), count(*) FILTER (WHERE state = 'active'),
         count(*) FILTER (WHERE state = 'voided'),
         COALESCE(sum(amount_minor), 0)
    INTO allocation_count, active_count, voided_count, allocation_total
    FROM payment_allocations
   WHERE payment_id = parent_payment_id;
  IF has_credit_funding THEN
    PERFORM rotating_credit_assert_ledger(parent_payment_id);
    IF has_void OR parent_status = 'voided' THEN
      RAISE EXCEPTION 'rotating credit funding cannot be voided as an ordinary tender';
    END IF;
  ELSE
    IF EXISTS (
      SELECT 1
        FROM payment_allocations allocation
        LEFT JOIN rotating_credit_applications application
          ON application.allocation_id = allocation.id
         AND application.organization_id = allocation.organization_id
         AND application.league_id = allocation.league_id
       WHERE allocation.payment_id = parent_payment_id
         AND (allocation.allocation_kind <> 'ordinary' OR application.id IS NOT NULL)
    ) THEN
      RAISE EXCEPTION 'ordinary tender allocation cannot claim rotating credit application evidence';
    END IF;
    IF allocation_count = 0 THEN
      RAISE EXCEPTION 'payment % must have at least one allocation', parent_payment_id;
    END IF;
    IF allocation_total <> parent_amount THEN
      RAISE EXCEPTION 'payment allocation total (%) must equal parent payment amount (%)', allocation_total, parent_amount;
    END IF;
  END IF;
  FOR obligation_row IN
    SELECT po.id, po.organization_id, po.league_id, po.amount_minor
      FROM payment_obligations po
      JOIN payment_allocations touched
        ON touched.obligation_id = po.id
       AND touched.organization_id = po.organization_id
       AND touched.league_id = po.league_id
       AND touched.payment_id = parent_payment_id
     ORDER BY po.organization_id, po.league_id, po.id
       FOR UPDATE
  LOOP
    SELECT COALESCE(SUM(pa.amount_minor), 0) - COALESCE((
      SELECT SUM(raa.amount_minor)
        FROM refund_allocation_adjustments raa
        JOIN payment_allocations source
          ON source.id = raa.source_allocation_id
         AND source.organization_id = raa.organization_id
         AND source.league_id = raa.league_id
       WHERE raa.organization_id = obligation_row.organization_id
         AND raa.league_id = obligation_row.league_id
         AND source.obligation_id = obligation_row.id
         AND source.state = 'active'
         AND raa.disposition = 'still_owed'
    ), 0)
      INTO obligation_total
      FROM payment_allocations pa
     WHERE pa.obligation_id = obligation_row.id
       AND pa.organization_id = obligation_row.organization_id
       AND pa.league_id = obligation_row.league_id
       AND pa.state = 'active';
    IF obligation_total > obligation_row.amount_minor THEN
      RAISE EXCEPTION 'payment allocations exceed an obligation balance';
    END IF;
  END LOOP;
  IF has_credit_funding THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF has_void THEN
    IF parent_status <> 'voided' OR active_count <> 0 OR voided_count <> allocation_count THEN
      RAISE EXCEPTION 'voided payment % must have all allocations voided', parent_payment_id;
    END IF;
  ELSIF parent_status = 'voided' OR active_count <> allocation_count THEN
    RAISE EXCEPTION 'active payment % must have all allocations active', parent_payment_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;--> statement-breakpoint

CREATE FUNCTION rotating_credit_ledger_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_payment_id integer;
BEGIN
  IF TG_TABLE_NAME = 'rotating_credit_fundings' THEN
    target_payment_id := (to_jsonb(NEW)->>'payment_id')::integer;
  ELSIF TG_TABLE_NAME = 'rotating_credit_applications' THEN
    target_payment_id := (to_jsonb(NEW)->>'payment_id')::integer;
  ELSIF TG_TABLE_NAME = 'rotating_credit_application_reversals' THEN
    target_payment_id := (to_jsonb(NEW)->>'funding_payment_id')::integer;
  ELSIF TG_TABLE_NAME = 'rotating_credit_refunds' THEN
    target_payment_id := (to_jsonb(NEW)->>'payment_id')::integer;
  ELSIF TG_TABLE_NAME = 'rotating_credit_refund_operation_snapshots' THEN
    target_payment_id := (to_jsonb(NEW)->>'payment_id')::integer;
  ELSIF TG_TABLE_NAME = 'payment_operations' THEN
    SELECT payment_id INTO target_payment_id
      FROM rotating_credit_refund_operation_snapshots
     WHERE operation_id = (to_jsonb(NEW)->>'id')::uuid;
  END IF;
  IF target_payment_id IS NOT NULL THEN
    PERFORM rotating_credit_assert_ledger(target_payment_id);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;--> statement-breakpoint
CREATE FUNCTION rotating_credit_assignment_ledger_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  payment_row record;
BEGIN
  FOR payment_row IN
    SELECT DISTINCT application.payment_id
      FROM rotating_credit_applications application
     WHERE application.organization_id = NEW.organization_id
       AND application.league_id = NEW.league_id
       AND application.occurrence_id = NEW.occurrence_id
       AND application.team_id = NEW.team_id
       AND application.slot_index = NEW.slot_index
  LOOP
    PERFORM rotating_credit_assert_ledger(payment_row.payment_id);
  END LOOP;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE FUNCTION rotating_credit_roster_snapshot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_payment_id integer;
BEGIN
  SELECT funding.payment_id INTO target_payment_id
    FROM payments payment
    JOIN rotating_credit_fundings funding
      ON funding.payment_id = payment.id
     AND funding.organization_id = payment.organization_id
     AND funding.league_id = payment.league_id
   WHERE payment.payment_operation_id = NEW.operation_id
     AND payment.organization_id = NEW.organization_id
     AND payment.league_id = NEW.league_id
   LIMIT 1;
  IF target_payment_id IS NOT NULL THEN
    PERFORM rotating_credit_assert_ledger(target_payment_id);
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER rotating_credit_funding_ledger_guard
AFTER INSERT OR UPDATE ON rotating_credit_fundings
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rotating_credit_ledger_event_guard();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER rotating_credit_application_ledger_guard
AFTER INSERT OR UPDATE ON rotating_credit_applications
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rotating_credit_ledger_event_guard();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER rotating_credit_reversal_ledger_guard
AFTER INSERT OR UPDATE ON rotating_credit_application_reversals
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rotating_credit_ledger_event_guard();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER rotating_credit_refund_ledger_guard
AFTER INSERT OR UPDATE ON rotating_credit_refunds
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rotating_credit_ledger_event_guard();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER rotating_credit_refund_snapshot_ledger_guard
AFTER INSERT OR UPDATE ON rotating_credit_refund_operation_snapshots
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rotating_credit_ledger_event_guard();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER rotating_credit_refund_operation_ledger_guard
AFTER UPDATE ON payment_operations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rotating_credit_ledger_event_guard();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER rotating_credit_assignment_ledger_guard
AFTER INSERT ON rotating_occurrence_assignments
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rotating_credit_assignment_ledger_guard();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER rotating_credit_roster_snapshot_guard
AFTER INSERT ON payment_operation_roster_snapshots
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rotating_credit_roster_snapshot_guard();--> statement-breakpoint

CREATE FUNCTION rotating_payment_evidence_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('leaguevault.organization_teardown', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'rotating payment evidence is append-only';
END;
$$;--> statement-breakpoint
CREATE TRIGGER payment_obligation_owner_revisions_append_only
BEFORE UPDATE OR DELETE ON payment_obligation_owner_revisions
FOR EACH ROW EXECUTE FUNCTION rotating_payment_evidence_append_only_guard();--> statement-breakpoint
CREATE TRIGGER rotating_occurrence_assignments_append_only
BEFORE UPDATE OR DELETE ON rotating_occurrence_assignments
FOR EACH ROW EXECUTE FUNCTION rotating_payment_evidence_append_only_guard();--> statement-breakpoint
CREATE TRIGGER team_payment_rotation_member_revisions_append_only
BEFORE UPDATE OR DELETE ON team_payment_rotation_member_revisions
FOR EACH ROW EXECUTE FUNCTION rotating_payment_evidence_append_only_guard();--> statement-breakpoint
CREATE TRIGGER rotating_credit_fundings_append_only
BEFORE UPDATE OR DELETE ON rotating_credit_fundings
FOR EACH ROW EXECUTE FUNCTION rotating_payment_evidence_append_only_guard();--> statement-breakpoint
CREATE TRIGGER rotating_credit_applications_append_only
BEFORE UPDATE OR DELETE ON rotating_credit_applications
FOR EACH ROW EXECUTE FUNCTION rotating_payment_evidence_append_only_guard();--> statement-breakpoint
CREATE TRIGGER rotating_credit_application_reversals_append_only
BEFORE UPDATE OR DELETE ON rotating_credit_application_reversals
FOR EACH ROW EXECUTE FUNCTION rotating_payment_evidence_append_only_guard();--> statement-breakpoint
CREATE TRIGGER rotating_credit_refunds_append_only
BEFORE UPDATE OR DELETE ON rotating_credit_refunds
FOR EACH ROW EXECUTE FUNCTION rotating_payment_evidence_append_only_guard();--> statement-breakpoint
CREATE TRIGGER rotating_credit_payment_operation_snapshots_append_only
BEFORE UPDATE OR DELETE ON rotating_credit_payment_operation_snapshots
FOR EACH ROW EXECUTE FUNCTION rotating_payment_evidence_append_only_guard();--> statement-breakpoint
CREATE TRIGGER rotating_credit_refund_operation_snapshots_append_only
BEFORE UPDATE OR DELETE ON rotating_credit_refund_operation_snapshots
FOR EACH ROW EXECUTE FUNCTION rotating_payment_evidence_append_only_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION roster_payment_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_gross_minor bigint;
  current_refunded_minor bigint;
  current_waived_minor bigint;
  current_effective_minor bigint;
  current_outstanding_minor bigint;
BEGIN
  IF current_setting('leaguevault.organization_teardown', true) = 'on' THEN
    RETURN OLD;
  END IF;
  IF TG_TABLE_NAME = 'payment_operation_roster_snapshot_items' THEN
    IF OLD.state = 'reserved' AND NEW.state IN ('finalized', 'released')
    AND ROW(NEW.id, NEW.operation_id, NEW.organization_id, NEW.league_id,
            NEW.obligation_id, NEW.allocation_index, NEW.amount_minor,
            NEW.created_at)
        IS NOT DISTINCT FROM
        ROW(OLD.id, OLD.operation_id, OLD.organization_id, OLD.league_id,
            OLD.obligation_id, OLD.allocation_index, OLD.amount_minor,
            OLD.created_at) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'payment_obligations' THEN
    SELECT
      COALESCE((
        SELECT SUM(pa.amount_minor)
          FROM payment_allocations pa
         WHERE pa.organization_id = NEW.organization_id
           AND pa.league_id = NEW.league_id
           AND pa.obligation_id = NEW.id
           AND pa.state = 'active'
      ), 0),
      COALESCE((
        SELECT SUM(raa.amount_minor)
          FROM refund_allocation_adjustments raa
          JOIN payment_allocations source
            ON source.id = raa.source_allocation_id
           AND source.organization_id = raa.organization_id
           AND source.league_id = raa.league_id
         WHERE raa.organization_id = NEW.organization_id
           AND raa.league_id = NEW.league_id
           AND source.obligation_id = NEW.id
           AND source.state = 'active'
      ), 0),
      COALESCE((
        SELECT SUM(raa.amount_minor)
          FROM refund_allocation_adjustments raa
          JOIN payment_allocations source
            ON source.id = raa.source_allocation_id
           AND source.organization_id = raa.organization_id
           AND source.league_id = raa.league_id
         WHERE raa.organization_id = NEW.organization_id
           AND raa.league_id = NEW.league_id
           AND source.obligation_id = NEW.id
           AND source.state = 'active'
           AND raa.disposition = 'waived'
      ), 0)
      INTO current_gross_minor, current_refunded_minor, current_waived_minor;
    current_effective_minor := GREATEST(0, current_gross_minor - current_refunded_minor);
    current_outstanding_minor := GREATEST(0, NEW.amount_minor - current_effective_minor - current_waived_minor);
    IF ROW(NEW.id, NEW.organization_id, NEW.league_id, NEW.occurrence_id,
            NEW.responsibility_id, NEW.component, NEW.payer_bowler_id,
            NEW.amount_minor, NEW.currency, NEW.due_at, NEW.past_due_at,
            NEW.created_by_user_id, NEW.created_at)
        IS NOT DISTINCT FROM
        ROW(OLD.id, OLD.organization_id, OLD.league_id, OLD.occurrence_id,
            OLD.responsibility_id, OLD.component, OLD.payer_bowler_id,
            OLD.amount_minor, OLD.currency, OLD.due_at, OLD.past_due_at,
            OLD.created_by_user_id, OLD.created_at)
    AND NEW.state IN ('open', 'partially_settled', 'settled', 'voided')
    AND (
      NEW.state = OLD.state
      OR (OLD.state = 'open' AND NEW.state IN ('partially_settled', 'settled', 'voided'))
      OR (OLD.state = 'partially_settled' AND NEW.state IN ('settled', 'voided'))
      OR (OLD.state = 'settled' AND NEW.state IN ('open', 'partially_settled') AND (
        SELECT COALESCE(SUM(pa.amount_minor), 0) - COALESCE((
          SELECT SUM(raa.amount_minor)
            FROM refund_allocation_adjustments raa
            JOIN payment_allocations source
              ON source.id = raa.source_allocation_id
             AND source.organization_id = raa.organization_id
             AND source.league_id = raa.league_id
           WHERE raa.organization_id = NEW.organization_id
             AND raa.league_id = NEW.league_id
             AND source.obligation_id = NEW.id
             AND source.state = 'active'
             AND raa.disposition = 'still_owed'
        ), 0) < NEW.amount_minor
          FROM payment_allocations pa
         WHERE pa.organization_id = NEW.organization_id
           AND pa.league_id = NEW.league_id
           AND pa.obligation_id = NEW.id
           AND pa.state = 'active'
      ))
      OR (OLD.state = 'partially_settled' AND NEW.state = 'open' AND EXISTS (
        SELECT 1
          FROM refund_allocation_adjustments raa
          JOIN payment_allocations source
            ON source.id = raa.source_allocation_id
           AND source.organization_id = raa.organization_id
           AND source.league_id = raa.league_id
         WHERE raa.organization_id = NEW.organization_id
           AND raa.league_id = NEW.league_id
           AND source.obligation_id = NEW.id
           AND source.state = 'active'
           AND raa.disposition IN ('still_owed', 'waived')
      ) AND (
        SELECT COALESCE(SUM(pa.amount_minor), 0) - COALESCE((
          SELECT SUM(raa.amount_minor)
            FROM refund_allocation_adjustments raa
            JOIN payment_allocations source
              ON source.id = raa.source_allocation_id
             AND source.organization_id = raa.organization_id
             AND source.league_id = raa.league_id
           WHERE raa.organization_id = NEW.organization_id
             AND raa.league_id = NEW.league_id
             AND source.obligation_id = NEW.id
             AND source.state = 'active'
             AND raa.disposition = 'still_owed'
        ), 0) < NEW.amount_minor
          FROM payment_allocations pa
         WHERE pa.organization_id = NEW.organization_id
           AND pa.league_id = NEW.league_id
           AND pa.obligation_id = NEW.id
           AND pa.state = 'active'
      ))
      -- A cash correction may temporarily leave a partially settled tail
      -- obligation with no active coverage. Require every part of the
      -- transition to prove the original voided cash tender and its evidence;
      -- manual obligation reopening remains rejected.
      OR (OLD.state = 'partially_settled' AND NEW.state = 'open' AND (
        SELECT COALESCE(SUM(pa.amount_minor), 0) - COALESCE((
          SELECT SUM(raa.amount_minor)
            FROM refund_allocation_adjustments raa
            JOIN payment_allocations source
              ON source.id = raa.source_allocation_id
             AND source.organization_id = raa.organization_id
             AND source.league_id = raa.league_id
           WHERE raa.organization_id = NEW.organization_id
             AND raa.league_id = NEW.league_id
             AND source.obligation_id = NEW.id
             AND source.state = 'active'
             AND raa.disposition = 'still_owed'
        ), 0)
          FROM payment_allocations pa
         WHERE pa.organization_id = NEW.organization_id
           AND pa.league_id = NEW.league_id
           AND pa.obligation_id = NEW.id
           AND pa.state = 'active'
      ) = 0 AND EXISTS (
        SELECT 1
          FROM payment_allocations released
          JOIN payments original
            ON original.id = released.payment_id
           AND original.organization_id = released.organization_id
           AND original.league_id = released.league_id
          JOIN payment_voids evidence
            ON evidence.payment_id = original.id
           AND evidence.organization_id = original.organization_id
           AND evidence.league_id = original.league_id
         WHERE released.organization_id = NEW.organization_id
           AND released.league_id = NEW.league_id
           AND released.obligation_id = NEW.id
           AND released.state = 'voided'
           AND original.type = 'cash'
           AND original.status = 'voided'
           AND original.payment_operation_id IS NULL
           AND original.provider_payment_id IS NULL
      ))
      OR (
        OLD.state IN ('partially_settled', 'settled')
        AND NEW.state IN ('open', 'partially_settled')
        AND current_effective_minor >= 0
        AND current_outstanding_minor > 0
        AND ((NEW.state = 'open' AND current_effective_minor = 0)
          OR (NEW.state = 'partially_settled' AND current_effective_minor > 0))
        AND EXISTS (
          SELECT 1
            FROM rotating_credit_application_reversals reversal
            JOIN rotating_credit_applications application
              ON application.id = reversal.application_id
             AND application.organization_id = reversal.organization_id
             AND application.league_id = reversal.league_id
            JOIN payment_allocations allocation
              ON allocation.id = reversal.allocation_id
             AND allocation.organization_id = reversal.organization_id
             AND allocation.league_id = reversal.league_id
           WHERE reversal.organization_id = NEW.organization_id
             AND reversal.league_id = NEW.league_id
             AND reversal.obligation_id = NEW.id
             AND reversal.transaction_id = pg_current_xact_id()::text
             AND reversal.funding_payment_id = application.payment_id
             AND reversal.bowler_id = application.actual_bowler_id
             AND reversal.assignment_id = application.assignment_id
             AND reversal.amount_minor = application.amount_minor
             AND reversal.amount_minor = allocation.amount_minor
             AND application.obligation_id = NEW.id
             AND application.allocation_id = allocation.id
             AND allocation.payment_id = application.payment_id
             AND allocation.obligation_id = application.obligation_id
             AND allocation.allocation_kind = 'rotating_credit'
             AND allocation.state = 'voided'
        )
      )
    )
    AND ((NEW.state = 'voided' AND NEW.voided_at IS NOT NULL) OR (NEW.state <> 'voided' AND NEW.voided_at IS NULL)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'financial_commands' THEN
    IF ROW(NEW.id, NEW.organization_id, NEW.league_id, NEW.actor_user_id,
            NEW.command_type, NEW.idempotency_key, NEW.request_fingerprint,
            NEW.created_at)
        IS NOT DISTINCT FROM
        ROW(OLD.id, OLD.organization_id, OLD.league_id, OLD.actor_user_id,
            OLD.command_type, OLD.idempotency_key, OLD.request_fingerprint,
            OLD.created_at)
    AND NEW.state IN ('accepted', 'rejected', 'applied', 'failed')
    AND (NEW.state = OLD.state OR (OLD.state = 'accepted' AND NEW.state IN ('rejected', 'applied', 'failed'))) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'autopay_consents' THEN
    IF ROW(NEW.id, NEW.organization_id, NEW.league_id, NEW.payer_bowler_id,
            NEW.consent_version, NEW.provider_name, NEW.encrypted_source_id,
            NEW.encrypted_customer_id, NEW.created_by_user_id, NEW.created_at)
        IS NOT DISTINCT FROM
        ROW(OLD.id, OLD.organization_id, OLD.league_id, OLD.payer_bowler_id,
            OLD.consent_version, OLD.provider_name, OLD.encrypted_source_id,
            OLD.encrypted_customer_id, OLD.created_by_user_id, OLD.created_at)
    AND NEW.state IN ('pending', 'active', 'revoked', 'expired')
    AND (NEW.state = OLD.state OR (OLD.state = 'pending' AND NEW.state IN ('active', 'revoked', 'expired')) OR (OLD.state = 'active' AND NEW.state IN ('revoked', 'expired'))) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'occurrence_payment_responsibilities' THEN
    IF OLD.state = 'active' AND NEW.state = 'voided'
    AND ROW(NEW.id, NEW.organization_id, NEW.league_id, NEW.occurrence_id,
            NEW.team_id, NEW.slot_id, NEW.slot_index, NEW.position_index,
            NEW.responsibility_key, NEW.version, NEW.responsibility_kind,
            NEW.main_bowler_id, NEW.substitute_bowler_id, NEW.payer_bowler_id,
            NEW.lineage_payer_bowler_id, NEW.prize_payer_bowler_id,
            NEW.policy, NEW.amount_minor, NEW.lineage_amount_minor,
            NEW.prize_fund_amount_minor, NEW.currency, NEW.due_at,
            NEW.past_due_at, NEW.assignment_note, NEW.recorded_by_user_id,
            NEW.created_at)
        IS NOT DISTINCT FROM
        ROW(OLD.id, OLD.organization_id, OLD.league_id, OLD.occurrence_id,
            OLD.team_id, OLD.slot_id, OLD.slot_index, OLD.position_index,
            OLD.responsibility_key, OLD.version, OLD.responsibility_kind,
            OLD.main_bowler_id, OLD.substitute_bowler_id, OLD.payer_bowler_id,
            OLD.lineage_payer_bowler_id, OLD.prize_payer_bowler_id,
            OLD.policy, OLD.amount_minor, OLD.lineage_amount_minor,
            OLD.prize_fund_amount_minor, OLD.currency, OLD.due_at,
            OLD.past_due_at, OLD.assignment_note, OLD.recorded_by_user_id,
            OLD.created_at) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'roster payment evidence is append-only';
END;
$$;
