CREATE OR REPLACE FUNCTION f3_json_array_shape(value jsonb, expected text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE element jsonb;
BEGIN
  IF jsonb_typeof(value) <> 'array' OR jsonb_array_length(value) = 0 THEN RETURN false; END IF;
  FOR element IN SELECT item FROM jsonb_array_elements(value) item LOOP
    IF expected = 'number' AND jsonb_typeof(element) IS DISTINCT FROM 'number' THEN RETURN false; END IF;
    IF expected = 'positive-id-array' AND (jsonb_typeof(element) IS DISTINCT FROM 'number' OR (element::text !~ '^[0-9]+$') OR (element::text)::bigint <= 0) THEN RETURN false; END IF;
    IF expected = 'string' AND jsonb_typeof(element) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
    IF expected = 'uuid-array' AND (jsonb_typeof(element) IS DISTINCT FROM 'string' OR (element #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN RETURN false; END IF;
    IF expected = 'occurrence-object' AND (jsonb_typeof(element) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(element)) <> 1 OR NOT (element ? 'occurrenceId') OR jsonb_typeof(element->'occurrenceId') IS DISTINCT FROM 'string' OR (element->>'occurrenceId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN RETURN false; END IF;
    IF expected = 'quote-item' AND (jsonb_typeof(element) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(element)) <> 6 OR NOT (element ? 'obligationId') OR NOT (element ? 'occurrenceId') OR NOT (element ? 'bowlerId') OR NOT (element ? 'collectionPointOccurrenceId') OR NOT (element ? 'amountMinor') OR NOT (element ? 'itemIndex') OR jsonb_typeof(element->'obligationId') IS DISTINCT FROM 'string' OR (element->>'obligationId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR jsonb_typeof(element->'occurrenceId') IS DISTINCT FROM 'string' OR (element->>'occurrenceId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR jsonb_typeof(element->'bowlerId') IS DISTINCT FROM 'number' OR (element->>'bowlerId') !~ '^[0-9]+$' OR (element->>'bowlerId')::bigint <= 0 OR jsonb_typeof(element->'collectionPointOccurrenceId') IS DISTINCT FROM 'string' OR (element->>'collectionPointOccurrenceId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR jsonb_typeof(element->'amountMinor') IS DISTINCT FROM 'number' OR (element->>'amountMinor') !~ '^[0-9]+$' OR (element->>'amountMinor')::bigint <= 0 OR jsonb_typeof(element->'itemIndex') IS DISTINCT FROM 'number' OR (element->>'itemIndex') !~ '^[0-9]+$' OR (element->>'itemIndex')::bigint < 0) THEN RETURN false; END IF;
  END LOOP;
  IF expected = 'quote-item' AND (SELECT count(DISTINCT (item->>'itemIndex')) FROM jsonb_array_elements(value) item) <> jsonb_array_length(value) THEN RETURN false; END IF;
  IF expected = 'quote-item' AND EXISTS (SELECT 1 FROM jsonb_array_elements(value) WITH ORDINALITY AS indexed(item, ordinal) WHERE (indexed.item->>'itemIndex')::bigint <> indexed.ordinal - 1) THEN RETURN false; END IF;
  IF expected = 'positive-id-array' AND (SELECT count(DISTINCT elements.item::text) FROM jsonb_array_elements(value) AS elements(item)) <> jsonb_array_length(value) THEN RETURN false; END IF;
  IF expected = 'uuid-array' AND (SELECT count(DISTINCT elements.item::text) FROM jsonb_array_elements(value) AS elements(item)) <> jsonb_array_length(value) THEN RETURN false; END IF;
  RETURN true;
END;
$$;--> statement-breakpoint
CREATE TABLE "f3_collection_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"activation_id" uuid NOT NULL,
	"activation_revision" integer NOT NULL,
	"activation_source_fingerprint" varchar(128) NOT NULL,
	"policy_version" integer NOT NULL,
	"policy_fingerprint" varchar(80) NOT NULL,
	"command_key" varchar(255) NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"current_revision" integer DEFAULT 1 NOT NULL,
	"collection_points" jsonb NOT NULL,
	"created_by_user_id" integer NOT NULL,
	"approved_by_user_id" integer,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "f3_policies_version_check" CHECK ("f3_collection_policies"."policy_version" > 0 AND "f3_collection_policies"."activation_revision" > 0 AND "f3_collection_policies"."activation_source_fingerprint" ~ '^lvfinancialsource:v1:[0-9a-f]{64}$'),
	CONSTRAINT "f3_policies_fingerprint_check" CHECK ("f3_collection_policies"."policy_fingerprint" ~ '^lvf3policy:v1:[0-9a-f]{64}$' AND length(btrim("f3_collection_policies"."command_key")) > 0),
    CONSTRAINT "f3_policies_state_check" CHECK ("f3_collection_policies"."state" IN ('draft','approved','superseded') AND "f3_collection_policies"."current_revision" > 0 AND f3_json_array_shape("f3_collection_policies"."collection_points", 'occurrence-object') AND (("f3_collection_policies"."state" = 'draft' AND "f3_collection_policies"."approved_by_user_id" IS NULL AND "f3_collection_policies"."approved_at" IS NULL) OR ("f3_collection_policies"."state" IN ('approved','superseded') AND "f3_collection_policies"."approved_by_user_id" IS NOT NULL AND "f3_collection_policies"."approved_at" IS NOT NULL)))
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
	"preauthorization_quote_fingerprint" varchar(80) NOT NULL,
	"authorized_items" jsonb NOT NULL,
	"command_key" varchar(255) NOT NULL,
	"covered_bowler_ids" jsonb NOT NULL,
	"accepted_partner_ids" jsonb NOT NULL,
	"collection_point_occurrence_ids" jsonb NOT NULL,
	"location_id" integer NOT NULL,
	"encrypted_source_id" text NOT NULL,
	"encrypted_customer_id" text,
	"payment_method_fingerprint" varchar(64) NOT NULL,
	"timing" text DEFAULT 'at_collection_point' NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"current_revision" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" integer NOT NULL,
	"authorized_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "f3_auth_fingerprint_check" CHECK ("f3_payer_autopay_authorizations"."authorization_fingerprint" ~ '^lvf3auth:v1:[0-9a-f]{64}$' AND "f3_payer_autopay_authorizations"."preauthorization_quote_fingerprint" ~ '^lvf3quote:v1:[0-9a-f]{64}$' AND f3_json_array_shape("f3_payer_autopay_authorizations"."authorized_items", 'quote-item') AND f3_json_array_shape("f3_payer_autopay_authorizations"."covered_bowler_ids", 'positive-id-array') AND ("f3_payer_autopay_authorizations"."accepted_partner_ids" = '[]'::jsonb OR f3_json_array_shape("f3_payer_autopay_authorizations"."accepted_partner_ids", 'positive-id-array')) AND f3_json_array_shape("f3_payer_autopay_authorizations"."collection_point_occurrence_ids", 'uuid-array') AND "f3_payer_autopay_authorizations"."payment_method_fingerprint" ~ '^[0-9a-f]{64}$' AND "f3_payer_autopay_authorizations"."timing" = 'at_collection_point' AND "f3_payer_autopay_authorizations"."authorization_version" > 0 AND "f3_payer_autopay_authorizations"."policy_version" > 0 AND "f3_payer_autopay_authorizations"."current_revision" > 0 AND length(btrim("f3_payer_autopay_authorizations"."command_key")) > 0),
	CONSTRAINT "f3_auth_state_check" CHECK ("f3_payer_autopay_authorizations"."state" IN ('draft','authorized','revoked','superseded') AND "f3_payer_autopay_authorizations"."current_revision" > 0 AND (("f3_payer_autopay_authorizations"."state" = 'draft' AND "f3_payer_autopay_authorizations"."authorized_at" IS NULL AND "f3_payer_autopay_authorizations"."revoked_at" IS NULL) OR ("f3_payer_autopay_authorizations"."state" IN ('authorized','superseded') AND "f3_payer_autopay_authorizations"."authorized_at" IS NOT NULL AND "f3_payer_autopay_authorizations"."revoked_at" IS NULL) OR ("f3_payer_autopay_authorizations"."state" = 'revoked' AND "f3_payer_autopay_authorizations"."authorized_at" IS NULL AND "f3_payer_autopay_authorizations"."revoked_at" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "f3_payer_authorization_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" integer NOT NULL,
  "league_id" integer NOT NULL,
  "authorization_id" uuid NOT NULL,
  "revision_number" integer NOT NULL,
  "snapshot_schema_version" integer NOT NULL,
  "before_snapshot" jsonb,
  "after_snapshot" jsonb NOT NULL,
  "recorded_by_user_id" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "f3_auth_revisions_shape_check" CHECK ("revision_number" > 0 AND "snapshot_schema_version" > 0 AND (("revision_number" = 1 AND "before_snapshot" IS NULL) OR ("revision_number" > 1 AND "before_snapshot" IS NOT NULL)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "f3_policies_tenant_identity_unique" ON "f3_collection_policies" USING btree ("id","organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "f3_auth_tenant_identity_unique" ON "f3_payer_autopay_authorizations" USING btree ("id","organization_id","league_id");--> statement-breakpoint
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
ALTER TABLE "f3_payer_authorization_revisions" ADD CONSTRAINT "f3_payer_authorization_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "f3_payer_authorization_revisions" ADD CONSTRAINT "f3_payer_authorization_revisions_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "f3_payer_authorization_revisions" ADD CONSTRAINT "f3_auth_revisions_parent_fk" FOREIGN KEY ("authorization_id","organization_id","league_id") REFERENCES "public"."f3_payer_autopay_authorizations"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "f3_policies_version_unique" ON "f3_collection_policies" USING btree ("organization_id","league_id","policy_version");--> statement-breakpoint
CREATE UNIQUE INDEX "f3_policies_fingerprint_unique" ON "f3_collection_policies" USING btree ("organization_id","policy_fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "f3_policies_command_unique" ON "f3_collection_policies" USING btree ("organization_id","league_id","command_key");--> statement-breakpoint
CREATE INDEX "f3_policies_league_state_idx" ON "f3_collection_policies" USING btree ("organization_id","league_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "f3_policy_occurrences_unique" ON "f3_collection_policy_occurrences" USING btree ("policy_id","occurrence_id");--> statement-breakpoint
CREATE UNIQUE INDEX "f3_policy_occurrences_index_unique" ON "f3_collection_policy_occurrences" USING btree ("policy_id","item_index");--> statement-breakpoint
CREATE UNIQUE INDEX "f3_policy_revisions_unique" ON "f3_collection_policy_revisions" USING btree ("organization_id","league_id","policy_id","revision_number");--> statement-breakpoint
CREATE UNIQUE INDEX "f3_auth_version_unique" ON "f3_payer_autopay_authorizations" USING btree ("organization_id","league_id","payer_bowler_id","authorization_version");--> statement-breakpoint
CREATE UNIQUE INDEX "f3_auth_command_unique" ON "f3_payer_autopay_authorizations" USING btree ("organization_id","league_id","command_key");--> statement-breakpoint
CREATE INDEX "f3_auth_active_idx" ON "f3_payer_autopay_authorizations" USING btree ("organization_id","league_id","payer_bowler_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "f3_auth_revisions_unique" ON "f3_payer_authorization_revisions" ("organization_id","league_id","authorization_id","revision_number");--> statement-breakpoint
CREATE OR REPLACE FUNCTION f3_immutable_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'F3 evidence is undeletable'; END IF;
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'f3_collection_policies' AND NOT ((OLD.state = 'draft' AND NEW.state = 'approved') OR (OLD.state = 'approved' AND NEW.state = 'superseded')) THEN
    RAISE EXCEPTION 'F3 policy lifecycle transition is invalid';
  END IF;
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'f3_payer_autopay_authorizations' AND NOT (OLD.state = 'authorized' AND NEW.state = 'superseded') THEN
    RAISE EXCEPTION 'F3 authorization lifecycle transition is invalid';
  END IF;
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME IN ('f3_collection_policies','f3_payer_autopay_authorizations') AND
     (to_jsonb(NEW)->>'current_revision')::integer <> (to_jsonb(OLD)->>'current_revision')::integer + 1 THEN
    RAISE EXCEPTION 'F3 lifecycle changes require the next revision';
  END IF;
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'f3_collection_policies' AND
     (to_jsonb(NEW) - 'state' - 'current_revision' - 'approved_by_user_id' - 'approved_at') IS DISTINCT FROM
     (to_jsonb(OLD) - 'state' - 'current_revision' - 'approved_by_user_id' - 'approved_at') THEN
    RAISE EXCEPTION 'F3 policy evidence is immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'f3_collection_policy_occurrences' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'F3 policy occurrence evidence is immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'f3_payer_autopay_authorizations' AND
     (to_jsonb(NEW) - 'state' - 'current_revision' - 'revoked_at') IS DISTINCT FROM
     (to_jsonb(OLD) - 'state' - 'current_revision' - 'revoked_at') THEN
    RAISE EXCEPTION 'F3 authorization evidence is immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME IN ('f3_collection_policy_revisions','f3_payer_authorization_revisions') AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'F3 revision evidence is immutable';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER f3_collection_policies_immutable BEFORE UPDATE OR DELETE ON "f3_collection_policies" FOR EACH ROW EXECUTE FUNCTION f3_immutable_evidence_guard();--> statement-breakpoint
CREATE TRIGGER f3_policy_occurrences_immutable BEFORE UPDATE OR DELETE ON "f3_collection_policy_occurrences" FOR EACH ROW EXECUTE FUNCTION f3_immutable_evidence_guard();--> statement-breakpoint
CREATE TRIGGER f3_policy_revisions_immutable BEFORE UPDATE OR DELETE ON "f3_collection_policy_revisions" FOR EACH ROW EXECUTE FUNCTION f3_immutable_evidence_guard();
CREATE TRIGGER f3_auth_revisions_immutable BEFORE UPDATE OR DELETE ON "f3_payer_authorization_revisions" FOR EACH ROW EXECUTE FUNCTION f3_immutable_evidence_guard();
CREATE TRIGGER f3_payer_authorizations_immutable BEFORE UPDATE OR DELETE ON "f3_payer_autopay_authorizations" FOR EACH ROW EXECUTE FUNCTION f3_immutable_evidence_guard();--> statement-breakpoint
CREATE TABLE "f3_autopay_plan_provenance" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" integer NOT NULL,
  "league_id" integer NOT NULL,
  "d2_plan_id" uuid NOT NULL,
  "payer_bowler_id" integer NOT NULL,
  "policy_id" uuid NOT NULL,
  "policy_version" integer NOT NULL,
  "authorization_id" uuid NOT NULL,
  "authorization_version" integer NOT NULL,
  "activation_id" uuid NOT NULL,
  "activation_revision" integer NOT NULL,
  "activation_source_fingerprint" varchar(128) NOT NULL,
  "plan_version" integer NOT NULL,
  "plan_fingerprint" varchar(80) NOT NULL,
  "collection_point_occurrence_id" uuid NOT NULL,
  "timing" text DEFAULT 'at_collection_point' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "f3_provenance_identity_check" CHECK ("plan_version" > 0 AND "activation_revision" > 0 AND "policy_version" > 0 AND "authorization_version" > 0 AND "activation_source_fingerprint" ~ '^lvfinancialsource:v1:[0-9a-f]{64}$' AND "plan_fingerprint" ~ '^lvf3plan:v1:[0-9a-f]{64}$' AND "timing" = 'at_collection_point')
);
ALTER TABLE "f3_collection_policy_occurrences" ADD CONSTRAINT "f3_policy_occurrences_pair_fk" FOREIGN KEY ("paired_occurrence_id","organization_id","league_id") REFERENCES "public"."league_occurrences"("id","organization_id","league_id") ON DELETE restrict;
ALTER TABLE "f3_collection_policies" ADD CONSTRAINT "f3_policies_collection_points_shape_check" CHECK (f3_json_array_shape("collection_points", 'occurrence-object'));
ALTER TABLE "f3_payer_autopay_authorizations" ADD CONSTRAINT "f3_auth_json_shape_check" CHECK (f3_json_array_shape("covered_bowler_ids", 'positive-id-array') AND f3_json_array_shape("collection_point_occurrence_ids", 'uuid-array'));
ALTER TABLE "f3_autopay_plan_provenance" ADD CONSTRAINT "f3_provenance_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict;
ALTER TABLE "f3_autopay_plan_provenance" ADD CONSTRAINT "f3_provenance_league_fk" FOREIGN KEY ("league_id","organization_id") REFERENCES "public"."leagues"("id","organization_id") ON DELETE restrict;
ALTER TABLE "f3_autopay_plan_provenance" ADD CONSTRAINT "f3_provenance_d2_plan_fk" FOREIGN KEY ("d2_plan_id","organization_id","league_id") REFERENCES "public"."occurrence_collection_plans"("id","organization_id","league_id") ON DELETE restrict;
ALTER TABLE "f3_autopay_plan_provenance" ADD CONSTRAINT "f3_provenance_payer_fk" FOREIGN KEY ("payer_bowler_id","organization_id") REFERENCES "public"."bowlers"("id","organization_id") ON DELETE restrict;
ALTER TABLE "f3_autopay_plan_provenance" ADD CONSTRAINT "f3_provenance_policy_fk" FOREIGN KEY ("policy_id","organization_id","league_id") REFERENCES "public"."f3_collection_policies"("id","organization_id","league_id") ON DELETE restrict;
ALTER TABLE "f3_autopay_plan_provenance" ADD CONSTRAINT "f3_provenance_auth_fk" FOREIGN KEY ("authorization_id","organization_id","league_id") REFERENCES "public"."f3_payer_autopay_authorizations"("id","organization_id","league_id") ON DELETE restrict;
ALTER TABLE "f3_autopay_plan_provenance" ADD CONSTRAINT "f3_provenance_activation_fk" FOREIGN KEY ("activation_id","organization_id","league_id") REFERENCES "public"."financial_activations"("id","organization_id","league_id") ON DELETE restrict;
ALTER TABLE "f3_autopay_plan_provenance" ADD CONSTRAINT "f3_provenance_point_fk" FOREIGN KEY ("collection_point_occurrence_id","organization_id","league_id") REFERENCES "public"."league_occurrences"("id","organization_id","league_id") ON DELETE restrict;
CREATE UNIQUE INDEX "f3_provenance_d2_plan_unique" ON "f3_autopay_plan_provenance" ("d2_plan_id");
CREATE UNIQUE INDEX "f3_provenance_fingerprint_unique" ON "f3_autopay_plan_provenance" ("organization_id","plan_fingerprint");
CREATE OR REPLACE FUNCTION f3_provenance_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'F3 plan provenance is immutable'; END $$;
CREATE TRIGGER f3_provenance_immutable BEFORE UPDATE OR DELETE ON "f3_autopay_plan_provenance" FOR EACH ROW EXECUTE FUNCTION f3_provenance_immutable_guard();
--> statement-breakpoint
CREATE UNIQUE INDEX "f3_policies_current_approved_unique" ON "f3_collection_policies" USING btree ("organization_id","league_id") WHERE "f3_collection_policies"."state" = 'approved';--> statement-breakpoint
CREATE UNIQUE INDEX "f3_auth_current_authorized_unique" ON "f3_payer_autopay_authorizations" USING btree ("organization_id","league_id","payer_bowler_id") WHERE "f3_payer_autopay_authorizations"."state" = 'authorized';--> statement-breakpoint
CREATE OR REPLACE FUNCTION f3_policy_occurrence_commit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE policy_row record; bad integer; declared_count integer; derived_count integer;
BEGIN
  SELECT * INTO policy_row FROM f3_collection_policies WHERE id = COALESCE(NEW.policy_id, OLD.policy_id) FOR KEY SHARE;
  IF policy_row IS NULL THEN RAISE EXCEPTION 'F3 policy occurrence parent missing'; END IF;
  IF TG_OP = 'INSERT' AND policy_row.state <> 'draft' THEN RAISE EXCEPTION 'F3 policy occurrence rows are immutable after draft'; END IF;
  SELECT count(*) INTO bad FROM f3_collection_policy_occurrences WHERE policy_id = policy_row.id AND length(btrim(group_key)) = 0;
  IF bad > 0 THEN RAISE EXCEPTION 'F3 policy group key is required'; END IF;
  SELECT count(*) INTO bad FROM f3_collection_policy_occurrences WHERE policy_id = policy_row.id AND group_role = 'normal' AND collection_point_occurrence_id <> occurrence_id;
  IF bad > 0 THEN RAISE EXCEPTION 'F3 normal group collection point must equal occurrence'; END IF;
  SELECT count(*) INTO bad FROM (SELECT group_key FROM f3_collection_policy_occurrences WHERE policy_id = policy_row.id GROUP BY group_key HAVING NOT ((count(*) = 1 AND count(*) FILTER (WHERE group_role = 'normal') = 1) OR (count(*) = 2 AND count(*) FILTER (WHERE group_role = 'trigger') = 1 AND count(*) FILTER (WHERE group_role = 'paired') = 1))) groups;
  IF bad > 0 THEN RAISE EXCEPTION 'F3 policy group cardinality invalid'; END IF;
  SELECT count(*) INTO bad FROM f3_collection_policy_occurrences trigger_row WHERE trigger_row.policy_id = policy_row.id AND trigger_row.group_role = 'trigger' AND (trigger_row.collection_point_occurrence_id <> trigger_row.occurrence_id OR trigger_row.paired_occurrence_id IS NULL OR NOT EXISTS (SELECT 1 FROM f3_collection_policy_occurrences paired WHERE paired.policy_id = trigger_row.policy_id AND paired.occurrence_id = trigger_row.paired_occurrence_id AND paired.group_key = trigger_row.group_key AND paired.group_role = 'paired' AND paired.paired_occurrence_id = trigger_row.occurrence_id AND paired.collection_point_occurrence_id = trigger_row.occurrence_id));
  IF bad > 0 THEN RAISE EXCEPTION 'F3 double-pay reciprocal pairing invalid'; END IF;
  SELECT count(*) INTO bad FROM f3_collection_policy_occurrences paired_row WHERE paired_row.policy_id = policy_row.id AND paired_row.group_role = 'paired' AND (paired_row.paired_occurrence_id IS NULL OR NOT EXISTS (SELECT 1 FROM f3_collection_policy_occurrences trigger_row WHERE trigger_row.policy_id = paired_row.policy_id AND trigger_row.occurrence_id = paired_row.paired_occurrence_id AND trigger_row.group_key = paired_row.group_key AND trigger_row.group_role = 'trigger' AND trigger_row.paired_occurrence_id = paired_row.occurrence_id AND paired_row.collection_point_occurrence_id = trigger_row.occurrence_id));
  IF bad > 0 THEN RAISE EXCEPTION 'F3 paired occurrence reciprocal pairing invalid'; END IF;
  SELECT count(*) INTO bad FROM (SELECT item_index, row_number() OVER (ORDER BY item_index) - 1 AS expected_index FROM f3_collection_policy_occurrences WHERE policy_id = policy_row.id) indexed WHERE item_index <> expected_index;
  IF bad > 0 THEN RAISE EXCEPTION 'F3 policy occurrence indices must be contiguous'; END IF;
  SELECT count(*) INTO declared_count FROM jsonb_array_elements(policy_row.collection_points);
  SELECT count(DISTINCT collection_point_occurrence_id) INTO derived_count FROM f3_collection_policy_occurrences WHERE policy_id = policy_row.id AND group_role IN ('normal','trigger');
  IF declared_count <> derived_count OR EXISTS (SELECT 1 FROM jsonb_array_elements(policy_row.collection_points) declared WHERE NOT EXISTS (SELECT 1 FROM f3_collection_policy_occurrences row WHERE row.policy_id = policy_row.id AND row.group_role IN ('normal','trigger') AND row.collection_point_occurrence_id::text = declared->>'occurrenceId')) THEN RAISE EXCEPTION 'F3 policy collection point coverage invalid'; END IF;
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER f3_policy_occurrence_commit_guard AFTER INSERT OR UPDATE OR DELETE ON "f3_collection_policy_occurrences" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION f3_policy_occurrence_commit_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION f3_policy_complete_set_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE child_count integer; declared_count integer; derived_count integer;
BEGIN
  SELECT count(*) INTO child_count FROM f3_collection_policy_occurrences WHERE policy_id = NEW.id AND organization_id = NEW.organization_id AND league_id = NEW.league_id;
  IF child_count = 0 THEN RAISE EXCEPTION 'F3 policy must contain complete occurrence coverage'; END IF;
  SELECT count(*) INTO declared_count FROM jsonb_array_elements(NEW.collection_points);
  SELECT count(DISTINCT collection_point_occurrence_id) INTO derived_count FROM f3_collection_policy_occurrences WHERE policy_id = NEW.id AND group_role IN ('normal','trigger');
  IF declared_count <> derived_count OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.collection_points) declared WHERE NOT EXISTS (SELECT 1 FROM f3_collection_policy_occurrences row WHERE row.policy_id = NEW.id AND row.group_role IN ('normal','trigger') AND row.collection_point_occurrence_id::text = declared->>'occurrenceId')) THEN RAISE EXCEPTION 'F3 policy collection point coverage invalid'; END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER f3_policy_complete_set_commit_guard AFTER INSERT OR UPDATE ON "f3_collection_policies" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION f3_policy_complete_set_guard();--> statement-breakpoint
CREATE OR REPLACE FUNCTION f3_current_revision_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'f3_collection_policies' AND NOT EXISTS (SELECT 1 FROM f3_collection_policy_revisions WHERE policy_id = NEW.id AND organization_id = NEW.organization_id AND league_id = NEW.league_id AND revision_number = NEW.current_revision) THEN RAISE EXCEPTION 'F3 policy current revision evidence missing'; END IF;
  IF TG_TABLE_NAME = 'f3_payer_autopay_authorizations' AND NOT EXISTS (SELECT 1 FROM f3_payer_authorization_revisions WHERE authorization_id = NEW.id AND organization_id = NEW.organization_id AND league_id = NEW.league_id AND revision_number = NEW.current_revision) THEN RAISE EXCEPTION 'F3 authorization current revision evidence missing'; END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER f3_policy_current_revision_commit_guard AFTER INSERT OR UPDATE ON "f3_collection_policies" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION f3_current_revision_evidence_guard();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER f3_auth_current_revision_commit_guard AFTER INSERT OR UPDATE ON "f3_payer_autopay_authorizations" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION f3_current_revision_evidence_guard();
