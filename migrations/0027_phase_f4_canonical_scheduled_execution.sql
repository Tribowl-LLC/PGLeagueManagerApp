CREATE TABLE "canonical_autopay_execution_snapshots" (
	"operation_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"d2_plan_id" uuid NOT NULL,
	"collection_point_occurrence_id" uuid NOT NULL,
	"payer_bowler_id" integer NOT NULL,
	"activation_id" uuid NOT NULL,
	"activation_revision" integer NOT NULL,
	"activation_source_fingerprint" varchar(128) NOT NULL,
	"policy_id" uuid NOT NULL,
	"policy_version" integer NOT NULL,
	"policy_fingerprint" varchar(80) NOT NULL,
	"authorization_id" uuid NOT NULL,
	"authorization_version" integer NOT NULL,
	"authorization_fingerprint" varchar(80) NOT NULL,
	"plan_version" integer NOT NULL,
	"plan_fingerprint" varchar(80) NOT NULL,
	"trigger_occurrence_id" uuid NOT NULL,
	"trigger_start_at" timestamp with time zone NOT NULL,
	"location_id" integer NOT NULL,
	"provider_location_id" varchar(255) NOT NULL,
	"encrypted_source_id" text NOT NULL,
	"encrypted_customer_id" text,
	"amount_minor" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"items" jsonb NOT NULL,
	"snapshot_version" integer DEFAULT 1 NOT NULL,
	"snapshot_fingerprint" varchar(80) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "canonical_autopay_snapshots_fingerprint_check" CHECK ("canonical_autopay_execution_snapshots"."snapshot_fingerprint" ~ '^lvf4exec:v1:[0-9a-f]{64}$' AND "canonical_autopay_execution_snapshots"."plan_fingerprint" ~ '^lvf3plan:v1:[0-9a-f]{64}$' AND "canonical_autopay_execution_snapshots"."policy_fingerprint" ~ '^lvf3policy:v1:[0-9a-f]{64}$' AND "canonical_autopay_execution_snapshots"."authorization_fingerprint" ~ '^lvf3auth:v1:[0-9a-f]{64}$' AND "canonical_autopay_execution_snapshots"."activation_source_fingerprint" ~ '^lvfinancialsource:v1:[0-9a-f]{64}$'),
	CONSTRAINT "canonical_autopay_snapshots_version_check" CHECK ("canonical_autopay_execution_snapshots"."snapshot_version" = 1 AND "canonical_autopay_execution_snapshots"."plan_version" > 0 AND "canonical_autopay_execution_snapshots"."policy_version" > 0 AND "canonical_autopay_execution_snapshots"."authorization_version" > 0 AND "canonical_autopay_execution_snapshots"."activation_revision" > 0),
	CONSTRAINT "canonical_autopay_snapshots_money_check" CHECK ("canonical_autopay_execution_snapshots"."amount_minor" > 0 AND "canonical_autopay_execution_snapshots"."currency" ~ '^[A-Z]{3}$' AND jsonb_typeof("canonical_autopay_execution_snapshots"."items") = 'array' AND jsonb_array_length("canonical_autopay_execution_snapshots"."items") > 0)
);
--> statement-breakpoint
ALTER TABLE "payment_operations" DROP CONSTRAINT "payment_operations_operation_type_check";--> statement-breakpoint
ALTER TABLE "payment_operations" DROP CONSTRAINT "payment_operations_scheduled_cycle_check";--> statement-breakpoint
ALTER TABLE "payment_operations" DROP CONSTRAINT "payment_operations_trigger_occurrence_check";--> statement-breakpoint
ALTER TABLE "payment_operations" ADD COLUMN "league_id" integer;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD COLUMN "canonical_plan_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD COLUMN "dispatch_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "canonical_autopay_execution_snapshots" ADD CONSTRAINT "canonical_autopay_execution_snapshots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_operations_tenant_identity_unique" ON "payment_operations" USING btree ("id","organization_id");--> statement-breakpoint
ALTER TABLE "canonical_autopay_execution_snapshots" ADD CONSTRAINT "canonical_autopay_snapshots_operation_fk" FOREIGN KEY ("operation_id","organization_id") REFERENCES "public"."payment_operations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_autopay_execution_snapshots" ADD CONSTRAINT "canonical_autopay_snapshots_league_fk" FOREIGN KEY ("league_id","organization_id") REFERENCES "public"."leagues"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_autopay_execution_snapshots" ADD CONSTRAINT "canonical_autopay_snapshots_plan_fk" FOREIGN KEY ("d2_plan_id","organization_id","league_id") REFERENCES "public"."occurrence_collection_plans"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "f3_provenance_d2_plan_tenant_unique" ON "f3_autopay_plan_provenance" USING btree ("d2_plan_id","organization_id","league_id");--> statement-breakpoint
ALTER TABLE "canonical_autopay_execution_snapshots" ADD CONSTRAINT "canonical_autopay_snapshots_provenance_fk" FOREIGN KEY ("d2_plan_id","organization_id","league_id") REFERENCES "public"."f3_autopay_plan_provenance"("d2_plan_id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_autopay_execution_snapshots" ADD CONSTRAINT "canonical_autopay_snapshots_activation_fk" FOREIGN KEY ("activation_id","organization_id","league_id") REFERENCES "public"."financial_activations"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_autopay_execution_snapshots" ADD CONSTRAINT "canonical_autopay_snapshots_policy_fk" FOREIGN KEY ("policy_id","organization_id","league_id") REFERENCES "public"."f3_collection_policies"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_autopay_execution_snapshots" ADD CONSTRAINT "canonical_autopay_snapshots_authorization_fk" FOREIGN KEY ("authorization_id","organization_id","league_id") REFERENCES "public"."f3_payer_autopay_authorizations"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_autopay_execution_snapshots" ADD CONSTRAINT "canonical_autopay_snapshots_point_fk" FOREIGN KEY ("collection_point_occurrence_id","organization_id","league_id") REFERENCES "public"."league_occurrences"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_autopay_execution_snapshots" ADD CONSTRAINT "canonical_autopay_snapshots_trigger_fk" FOREIGN KEY ("trigger_occurrence_id","organization_id","league_id") REFERENCES "public"."league_occurrences"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_autopay_execution_snapshots" ADD CONSTRAINT "canonical_autopay_snapshots_location_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_autopay_execution_snapshots" ADD CONSTRAINT "canonical_autopay_snapshots_payer_fk" FOREIGN KEY ("payer_bowler_id","organization_id") REFERENCES "public"."bowlers"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "canonical_autopay_snapshots_authorization_idx" ON "canonical_autopay_execution_snapshots" USING btree ("organization_id","league_id","authorization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_autopay_snapshots_identity_unique" ON "canonical_autopay_execution_snapshots" USING btree ("operation_id","organization_id","league_id","d2_plan_id");--> statement-breakpoint
CREATE INDEX "canonical_autopay_snapshots_plan_idx" ON "canonical_autopay_execution_snapshots" USING btree ("organization_id","league_id","d2_plan_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION canonical_autopay_snapshot_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'F4 execution snapshot is immutable'; END $$;--> statement-breakpoint
CREATE TRIGGER canonical_autopay_snapshot_immutable BEFORE UPDATE OR DELETE ON canonical_autopay_execution_snapshots FOR EACH ROW EXECUTE FUNCTION canonical_autopay_snapshot_immutable_guard();--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_league_tenant_fk" FOREIGN KEY ("league_id","organization_id") REFERENCES "public"."leagues"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_canonical_plan_tenant_fk" FOREIGN KEY ("canonical_plan_id","organization_id","league_id") REFERENCES "public"."occurrence_collection_plans"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_operations_canonical_plan_idx" ON "payment_operations" USING btree ("organization_id","league_id","canonical_plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_operations_canonical_plan_unique" ON "payment_operations" USING btree ("organization_id","league_id","canonical_plan_id") WHERE "payment_operations"."operation_type" = 'canonical_autopay_charge';--> statement-breakpoint
CREATE UNIQUE INDEX "payment_operations_canonical_target_unique" ON "payment_operations" USING btree ("organization_id","target_key") WHERE "payment_operations"."operation_type" = 'canonical_autopay_charge';--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_operation_type_check" CHECK ("payment_operations"."operation_type" IN ('scheduled_charge', 'interactive_charge', 'refund', 'canonical_autopay_charge'));--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_scheduled_cycle_check" CHECK ((
      "payment_operations"."operation_type" = 'scheduled_charge'
      AND "payment_operations"."payment_schedule_id" IS NOT NULL
      AND "payment_operations"."billing_cycle_at" IS NOT NULL
    ) OR (
      "payment_operations"."operation_type" = 'canonical_autopay_charge'
      AND "payment_operations"."payment_schedule_id" IS NULL
      AND "payment_operations"."billing_cycle_at" IS NULL
      AND "payment_operations"."league_id" IS NOT NULL
      AND "payment_operations"."canonical_plan_id" IS NOT NULL
      AND "payment_operations"."authorizing_user_id" IS NOT NULL
    ) OR (
      "payment_operations"."operation_type" IN ('interactive_charge', 'refund')
      AND "payment_operations"."payment_schedule_id" IS NULL
      AND "payment_operations"."billing_cycle_at" IS NULL
      AND "payment_operations"."league_id" IS NULL
      AND "payment_operations"."canonical_plan_id" IS NULL
    ));--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_trigger_occurrence_check" CHECK ((
      "payment_operations"."operation_type" = 'scheduled_charge'
      AND ("payment_operations"."trigger_occurrence_id" IS NULL OR (
        "payment_operations"."payment_schedule_id" IS NOT NULL
        AND "payment_operations"."billing_cycle_at" IS NOT NULL
      ))
    ) OR (
      "payment_operations"."operation_type" = 'canonical_autopay_charge'
      AND "payment_operations"."trigger_occurrence_id" IS NOT NULL
      AND "payment_operations"."canonical_plan_id" IS NOT NULL
      AND "payment_operations"."league_id" IS NOT NULL
    ) OR (
      "payment_operations"."operation_type" IN ('interactive_charge', 'refund')
      AND "payment_operations"."trigger_occurrence_id" IS NULL
    ));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_payment_occurrence_snapshot_total() RETURNS trigger
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
    WHERE operation_id = operation_uuid FOR UPDATE;
  IF expected_amount IS NULL THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock(snapshot_organization_id, snapshot_league_id);
  SELECT po.amount_minor, po.operation_type INTO operation_amount, stored_operation_type
    FROM payment_operations po WHERE po.id = operation_uuid AND po.organization_id = snapshot_organization_id FOR UPDATE;
  IF stored_operation_type NOT IN ('scheduled_charge', 'interactive_charge', 'canonical_autopay_charge') THEN
    RAISE EXCEPTION 'occurrence snapshots support only charge operations' USING ERRCODE = '23514';
  END IF;
  IF stored_operation_type = 'scheduled_charge' THEN
    SELECT snapshot.league_id INTO base_snapshot_league_id FROM scheduled_payment_operation_snapshots snapshot WHERE snapshot.operation_id = operation_uuid FOR SHARE;
  ELSIF stored_operation_type = 'interactive_charge' THEN
    SELECT snapshot.league_id INTO base_snapshot_league_id FROM interactive_payment_operation_snapshots snapshot WHERE snapshot.operation_id = operation_uuid FOR SHARE;
  ELSE
    SELECT snapshot.league_id INTO base_snapshot_league_id FROM canonical_autopay_execution_snapshots snapshot WHERE snapshot.operation_id = operation_uuid FOR SHARE;
  END IF;
  IF base_snapshot_league_id IS NULL THEN RAISE EXCEPTION 'payment operation occurrence snapshot requires its matching execution snapshot' USING ERRCODE = '23514'; END IF;
  IF base_snapshot_league_id <> snapshot_league_id THEN RAISE EXCEPTION 'payment operation occurrence snapshot league conflicts with its execution snapshot' USING ERRCODE = '23514'; END IF;
  SELECT COALESCE(SUM(amount_minor), 0), COUNT(*)::integer INTO actual_amount, actual_count FROM payment_operation_occurrence_snapshot_allocations WHERE operation_id = operation_uuid;
  IF expected_amount <> operation_amount OR actual_amount <> expected_amount OR actual_count <> expected_count THEN RAISE EXCEPTION 'payment operation occurrence snapshot allocation total is inconsistent' USING ERRCODE = '23514'; END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payment_occurrence_canonical_base_snapshot_consistency
AFTER UPDATE OR DELETE ON canonical_autopay_execution_snapshots
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_payment_occurrence_snapshot_total();
