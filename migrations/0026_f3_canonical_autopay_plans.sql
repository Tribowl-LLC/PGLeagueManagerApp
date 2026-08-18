CREATE TABLE "f3_canonical_autopay_plan_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"plan_id" uuid NOT NULL,
	"obligation_id" uuid NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"bowler_id" integer NOT NULL,
	"collection_point_occurrence_id" uuid NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"item_index" integer NOT NULL,
	CONSTRAINT "f3_plan_items_amount_check" CHECK ("f3_canonical_autopay_plan_items"."amount_minor" > 0 AND "f3_canonical_autopay_plan_items"."item_index" >= 0 AND "f3_canonical_autopay_plan_items"."currency" = 'USD')
);
--> statement-breakpoint
CREATE TABLE "f3_canonical_autopay_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"payer_bowler_id" integer NOT NULL,
	"policy_id" uuid NOT NULL,
	"policy_version" integer NOT NULL,
	"authorization_id" uuid NOT NULL,
	"authorization_version" integer NOT NULL,
	"plan_version" integer NOT NULL,
	"activation_id" uuid NOT NULL,
	"activation_source_fingerprint" varchar(128) NOT NULL,
	"plan_fingerprint" varchar(80) NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"collection_points" jsonb NOT NULL,
	"total_amount_minor" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "f3_plans_fingerprint_check" CHECK ("f3_canonical_autopay_plans"."plan_fingerprint" ~ '^lvf3plan:v1:[0-9a-f]{64}$' AND "f3_canonical_autopay_plans"."total_amount_minor" > 0 AND "f3_canonical_autopay_plans"."currency" = 'USD' AND "f3_canonical_autopay_plans"."plan_version" > 0),
	CONSTRAINT "f3_plans_state_check" CHECK ("f3_canonical_autopay_plans"."state" IN ('draft','ready','fulfilled','cancelled','superseded','review_required') AND (("f3_canonical_autopay_plans"."state" = 'ready' AND "f3_canonical_autopay_plans"."ready_at" IS NOT NULL) OR "f3_canonical_autopay_plans"."state" <> 'ready'))
);
--> statement-breakpoint
CREATE TABLE "f3_collection_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"activation_id" uuid NOT NULL,
	"activation_revision" integer NOT NULL,
	"activation_source_fingerprint" varchar(128) NOT NULL,
	"policy_version" integer NOT NULL,
	"policy_fingerprint" varchar(80) NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"collection_points" jsonb NOT NULL,
	"created_by_user_id" integer NOT NULL,
	"approved_by_user_id" integer,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "f3_policies_version_check" CHECK ("f3_collection_policies"."policy_version" > 0 AND "f3_collection_policies"."activation_revision" > 0 AND "f3_collection_policies"."activation_source_fingerprint" ~ '^lvfinancialsource:v1:[0-9a-f]{64}$'),
	CONSTRAINT "f3_policies_fingerprint_check" CHECK ("f3_collection_policies"."policy_fingerprint" ~ '^lvf3policy:v1:[0-9a-f]{64}$'),
	CONSTRAINT "f3_policies_state_check" CHECK ("f3_collection_policies"."state" IN ('draft','approved','superseded') AND ("f3_collection_policies"."state" <> 'approved' OR ("f3_collection_policies"."approved_by_user_id" IS NOT NULL AND "f3_collection_policies"."approved_at" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "f3_collection_policy_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"policy_id" uuid NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"group_key" varchar(128) NOT NULL,
	"group_role" text NOT NULL,
	"paired_occurrence_id" uuid,
	"collection_point_occurrence_id" uuid NOT NULL,
	"item_index" integer NOT NULL,
	CONSTRAINT "f3_policy_occurrences_group_check" CHECK ("f3_collection_policy_occurrences"."group_role" IN ('normal','trigger','paired') AND "f3_collection_policy_occurrences"."item_index" >= 0 AND (("f3_collection_policy_occurrences"."group_role" = 'normal' AND "f3_collection_policy_occurrences"."paired_occurrence_id" IS NULL) OR ("f3_collection_policy_occurrences"."group_role" <> 'normal' AND "f3_collection_policy_occurrences"."paired_occurrence_id" IS NOT NULL AND "f3_collection_policy_occurrences"."paired_occurrence_id" <> "f3_collection_policy_occurrences"."occurrence_id")))
);
--> statement-breakpoint
CREATE TABLE "f3_collection_policy_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"policy_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"snapshot_schema_version" integer NOT NULL,
	"before_snapshot" jsonb,
	"after_snapshot" jsonb NOT NULL,
	"recorded_by_user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "f3_policy_revisions_shape_check" CHECK ("f3_collection_policy_revisions"."revision_number" > 0 AND "f3_collection_policy_revisions"."snapshot_schema_version" > 0 AND (("f3_collection_policy_revisions"."revision_number" = 1 AND "f3_collection_policy_revisions"."before_snapshot" IS NULL) OR ("f3_collection_policy_revisions"."revision_number" > 1 AND "f3_collection_policy_revisions"."before_snapshot" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "f3_payer_autopay_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"payer_bowler_id" integer NOT NULL,
	"policy_id" uuid NOT NULL,
	"policy_version" integer NOT NULL,
	"authorization_version" integer NOT NULL,
	"authorization_fingerprint" varchar(80) NOT NULL,
	"covered_bowler_ids" jsonb NOT NULL,
	"accepted_partner_ids" jsonb NOT NULL,
	"collection_point_occurrence_ids" jsonb NOT NULL,
	"location_id" integer NOT NULL,
	"encrypted_source_id" text NOT NULL,
	"encrypted_customer_id" text,
	"payment_method_fingerprint" varchar(64) NOT NULL,
	"timing" text DEFAULT 'at_collection_point' NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"created_by_user_id" integer NOT NULL,
	"authorized_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "f3_auth_fingerprint_check" CHECK ("f3_payer_autopay_authorizations"."authorization_fingerprint" ~ '^lvf3auth:v1:[0-9a-f]{64}$' AND "f3_payer_autopay_authorizations"."payment_method_fingerprint" ~ '^[0-9a-f]{64}$' AND "f3_payer_autopay_authorizations"."timing" = 'at_collection_point' AND "f3_payer_autopay_authorizations"."authorization_version" > 0 AND "f3_payer_autopay_authorizations"."policy_version" > 0),
	CONSTRAINT "f3_auth_state_check" CHECK ("f3_payer_autopay_authorizations"."state" IN ('draft','authorized','revoked','superseded') AND (("f3_payer_autopay_authorizations"."state" = 'authorized' AND "f3_payer_autopay_authorizations"."authorized_at" IS NOT NULL AND "f3_payer_autopay_authorizations"."revoked_at" IS NULL) OR ("f3_payer_autopay_authorizations"."state" <> 'authorized')))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "f3_policies_tenant_identity_unique" ON "f3_collection_policies" USING btree ("id","organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "f3_auth_tenant_identity_unique" ON "f3_payer_autopay_authorizations" USING btree ("id","organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "f3_plans_tenant_identity_unique" ON "f3_canonical_autopay_plans" USING btree ("id","organization_id","league_id");--> statement-breakpoint
ALTER TABLE "f3_canonical_autopay_plan_items" ADD CONSTRAINT "f3_canonical_autopay_plan_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "f3_canonical_autopay_plan_items" ADD CONSTRAINT "f3_plan_items_plan_fk" FOREIGN KEY ("plan_id","organization_id","league_id") REFERENCES "public"."f3_canonical_autopay_plans"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "f3_canonical_autopay_plan_items" ADD CONSTRAINT "f3_plan_items_obligation_fk" FOREIGN KEY ("obligation_id","organization_id","league_id","occurrence_id","bowler_id","currency") REFERENCES "public"."bowler_occurrence_obligations"("id","organization_id","league_id","occurrence_id","bowler_id","currency") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "f3_canonical_autopay_plan_items" ADD CONSTRAINT "f3_plan_items_occurrence_fk" FOREIGN KEY ("occurrence_id","organization_id","league_id") REFERENCES "public"."league_occurrences"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "f3_canonical_autopay_plan_items" ADD CONSTRAINT "f3_plan_items_point_fk" FOREIGN KEY ("collection_point_occurrence_id","organization_id","league_id") REFERENCES "public"."league_occurrences"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "f3_canonical_autopay_plan_items" ADD CONSTRAINT "f3_plan_items_bowler_fk" FOREIGN KEY ("bowler_id","organization_id") REFERENCES "public"."bowlers"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "f3_canonical_autopay_plans" ADD CONSTRAINT "f3_canonical_autopay_plans_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "f3_canonical_autopay_plans" ADD CONSTRAINT "f3_plans_league_tenant_fk" FOREIGN KEY ("league_id","organization_id") REFERENCES "public"."leagues"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "f3_canonical_autopay_plans" ADD CONSTRAINT "f3_plans_payer_fk" FOREIGN KEY ("payer_bowler_id","organization_id") REFERENCES "public"."bowlers"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "f3_canonical_autopay_plans" ADD CONSTRAINT "f3_plans_policy_fk" FOREIGN KEY ("policy_id","organization_id","league_id") REFERENCES "public"."f3_collection_policies"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "f3_canonical_autopay_plans" ADD CONSTRAINT "f3_plans_auth_fk" FOREIGN KEY ("authorization_id","organization_id","league_id") REFERENCES "public"."f3_payer_autopay_authorizations"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "f3_canonical_autopay_plans" ADD CONSTRAINT "f3_plans_activation_fk" FOREIGN KEY ("activation_id","organization_id","league_id") REFERENCES "public"."financial_activations"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "f3_collection_policies" ADD CONSTRAINT "f3_collection_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "f3_collection_policies" ADD CONSTRAINT "f3_collection_policies_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "f3_collection_policies" ADD CONSTRAINT "f3_collection_policies_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "f3_collection_policies" ADD CONSTRAINT "f3_policies_league_tenant_fk" FOREIGN KEY ("league_id","organization_id") REFERENCES "public"."leagues"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "f3_collection_policies" ADD CONSTRAINT "f3_policies_activation_fk" FOREIGN KEY ("activation_id","organization_id","league_id") REFERENCES "public"."financial_activations"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "f3_collection_policy_occurrences" ADD CONSTRAINT "f3_collection_policy_occurrences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "f3_collection_policy_occurrences" ADD CONSTRAINT "f3_policy_occurrences_policy_fk" FOREIGN KEY ("policy_id","organization_id","league_id") REFERENCES "public"."f3_collection_policies"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "f3_collection_policy_occurrences" ADD CONSTRAINT "f3_policy_occurrences_occurrence_fk" FOREIGN KEY ("occurrence_id","organization_id","league_id") REFERENCES "public"."league_occurrences"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "f3_collection_policy_occurrences" ADD CONSTRAINT "f3_policy_occurrences_point_fk" FOREIGN KEY ("collection_point_occurrence_id","organization_id","league_id") REFERENCES "public"."league_occurrences"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "f3_collection_policy_revisions" ADD CONSTRAINT "f3_collection_policy_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "f3_collection_policy_revisions" ADD CONSTRAINT "f3_collection_policy_revisions_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "f3_collection_policy_revisions" ADD CONSTRAINT "f3_policy_revisions_parent_fk" FOREIGN KEY ("policy_id","organization_id","league_id") REFERENCES "public"."f3_collection_policies"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "f3_payer_autopay_authorizations" ADD CONSTRAINT "f3_payer_autopay_authorizations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "f3_payer_autopay_authorizations" ADD CONSTRAINT "f3_payer_autopay_authorizations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "f3_payer_autopay_authorizations" ADD CONSTRAINT "f3_auth_league_tenant_fk" FOREIGN KEY ("league_id","organization_id") REFERENCES "public"."leagues"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "f3_payer_autopay_authorizations" ADD CONSTRAINT "f3_auth_payer_fk" FOREIGN KEY ("payer_bowler_id","organization_id") REFERENCES "public"."bowlers"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "f3_payer_autopay_authorizations" ADD CONSTRAINT "f3_auth_location_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "f3_payer_autopay_authorizations" ADD CONSTRAINT "f3_auth_policy_fk" FOREIGN KEY ("policy_id","organization_id","league_id") REFERENCES "public"."f3_collection_policies"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "f3_plan_items_obligation_unique" ON "f3_canonical_autopay_plan_items" USING btree ("plan_id","obligation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "f3_plan_items_index_unique" ON "f3_canonical_autopay_plan_items" USING btree ("plan_id","item_index");--> statement-breakpoint
CREATE UNIQUE INDEX "f3_plans_version_unique" ON "f3_canonical_autopay_plans" USING btree ("organization_id","league_id","payer_bowler_id","plan_version");--> statement-breakpoint
CREATE INDEX "f3_plans_state_idx" ON "f3_canonical_autopay_plans" USING btree ("organization_id","league_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "f3_policies_version_unique" ON "f3_collection_policies" USING btree ("organization_id","league_id","policy_version");--> statement-breakpoint
CREATE UNIQUE INDEX "f3_policies_fingerprint_unique" ON "f3_collection_policies" USING btree ("organization_id","policy_fingerprint");--> statement-breakpoint
CREATE INDEX "f3_policies_league_state_idx" ON "f3_collection_policies" USING btree ("organization_id","league_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "f3_policy_occurrences_unique" ON "f3_collection_policy_occurrences" USING btree ("policy_id","occurrence_id");--> statement-breakpoint
CREATE UNIQUE INDEX "f3_policy_occurrences_index_unique" ON "f3_collection_policy_occurrences" USING btree ("policy_id","item_index");--> statement-breakpoint
CREATE UNIQUE INDEX "f3_policy_revisions_unique" ON "f3_collection_policy_revisions" USING btree ("organization_id","league_id","policy_id","revision_number");--> statement-breakpoint
CREATE UNIQUE INDEX "f3_auth_version_unique" ON "f3_payer_autopay_authorizations" USING btree ("organization_id","league_id","payer_bowler_id","authorization_version");--> statement-breakpoint
CREATE INDEX "f3_auth_active_idx" ON "f3_payer_autopay_authorizations" USING btree ("organization_id","league_id","payer_bowler_id","state");--> statement-breakpoint
CREATE OR REPLACE FUNCTION f3_immutable_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Full tenant teardown is the reviewed retention exception; row-level
  -- deletion is therefore left to the restrictive tenant-scoped teardown
  -- transaction rather than blocking that existing path.
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF TG_TABLE_NAME = 'f3_collection_policies' AND (NEW.organization_id,NEW.league_id,NEW.activation_id,NEW.activation_revision,NEW.activation_source_fingerprint,NEW.policy_version,NEW.policy_fingerprint,NEW.collection_points,NEW.created_by_user_id) IS DISTINCT FROM (OLD.organization_id,OLD.league_id,OLD.activation_id,OLD.activation_revision,OLD.activation_source_fingerprint,OLD.policy_version,OLD.policy_fingerprint,OLD.collection_points,OLD.created_by_user_id) THEN RAISE EXCEPTION 'F3 policy evidence is immutable'; END IF;
  IF TG_TABLE_NAME = 'f3_collection_policy_occurrences' AND (NEW.organization_id,NEW.league_id,NEW.policy_id,NEW.occurrence_id,NEW.group_key,NEW.group_role,NEW.paired_occurrence_id,NEW.collection_point_occurrence_id,NEW.item_index) IS DISTINCT FROM (OLD.organization_id,OLD.league_id,OLD.policy_id,OLD.occurrence_id,OLD.group_key,OLD.group_role,OLD.paired_occurrence_id,OLD.collection_point_occurrence_id,OLD.item_index) THEN RAISE EXCEPTION 'F3 policy occurrence evidence is immutable'; END IF;
  IF TG_TABLE_NAME = 'f3_collection_policy_revisions' AND OLD IS DISTINCT FROM NEW THEN RAISE EXCEPTION 'F3 policy revision evidence is immutable'; END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER f3_collection_policies_immutable BEFORE UPDATE OR DELETE ON "f3_collection_policies" FOR EACH ROW EXECUTE FUNCTION f3_immutable_evidence_guard();--> statement-breakpoint
CREATE TRIGGER f3_policy_occurrences_immutable BEFORE UPDATE OR DELETE ON "f3_collection_policy_occurrences" FOR EACH ROW EXECUTE FUNCTION f3_immutable_evidence_guard();--> statement-breakpoint
CREATE TRIGGER f3_policy_revisions_immutable BEFORE UPDATE OR DELETE ON "f3_collection_policy_revisions" FOR EACH ROW EXECUTE FUNCTION f3_immutable_evidence_guard();
