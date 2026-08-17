CREATE TABLE "financial_activation_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"activation_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"snapshot_schema_version" integer NOT NULL,
	"before_snapshot" jsonb,
	"after_snapshot" jsonb NOT NULL,
	"recorded_by_user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "financial_activation_revisions_revision_check" CHECK ("financial_activation_revisions"."revision_number" > 0 AND "financial_activation_revisions"."snapshot_schema_version" > 0),
	CONSTRAINT "financial_activation_revisions_snapshot_check" CHECK (("financial_activation_revisions"."revision_number" = 1 AND "financial_activation_revisions"."before_snapshot" IS NULL) OR ("financial_activation_revisions"."revision_number" > 1 AND "financial_activation_revisions"."before_snapshot" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "financial_activations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"activation_version" integer DEFAULT 1 NOT NULL,
	"policy_version" varchar(64) DEFAULT 'eligible-bowlers/1' NOT NULL,
	"order_version" varchar(64) DEFAULT 'occurrence-team-slot-bowler/1' NOT NULL,
	"command_key" varchar(255) NOT NULL,
	"request_fingerprint" varchar(128) NOT NULL,
	"source_fingerprint" varchar(128) NOT NULL,
	"payment_mode" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"completeness_marker" boolean DEFAULT false NOT NULL,
	"paying_lineup_size" integer DEFAULT 0 NOT NULL,
	"expected_responsibility_count" integer DEFAULT 0 NOT NULL,
	"expected_group_count" integer DEFAULT 0 NOT NULL,
	"current_revision" integer DEFAULT 1 NOT NULL,
	"upfront_due_at" timestamp with time zone,
	"recorded_by_user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "financial_activations_version_check" CHECK ("financial_activations"."activation_version" = 1 AND "financial_activations"."current_revision" = 1 AND "financial_activations"."paying_lineup_size" IN (3, 4) AND "financial_activations"."expected_group_count" > 0 AND "financial_activations"."expected_responsibility_count" = "financial_activations"."expected_group_count" * "financial_activations"."paying_lineup_size"),
	CONSTRAINT "financial_activations_policy_check" CHECK ("financial_activations"."policy_version" = 'eligible-bowlers/1' AND "financial_activations"."order_version" = 'occurrence-team-slot-bowler/1'),
	CONSTRAINT "financial_activations_key_check" CHECK (length(btrim("financial_activations"."command_key")) > 0 AND "financial_activations"."request_fingerprint" ~ '^lvfinancialactivation:v1:[0-9a-f]{64}$' AND "financial_activations"."source_fingerprint" ~ '^lvfinancialsource:v1:[0-9a-f]{64}$'),
	CONSTRAINT "financial_activations_payment_mode_check" CHECK ("financial_activations"."payment_mode" IN ('weekly', 'upfront')),
	CONSTRAINT "financial_activations_state_check" CHECK ("financial_activations"."state" = 'active'),
	CONSTRAINT "financial_activations_completeness_check" CHECK ("financial_activations"."state" <> 'active' OR "financial_activations"."completeness_marker" = true),
	CONSTRAINT "financial_activations_upfront_due_check" CHECK ("financial_activations"."payment_mode" <> 'upfront' OR "financial_activations"."upfront_due_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "financial_responsibilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"activation_id" uuid NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"team_id" integer NOT NULL,
	"slot_index" integer NOT NULL,
	"paying_lineup_size" integer NOT NULL,
	"bowler_id" integer NOT NULL,
	"obligation_id" uuid NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"billing_term_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"billing_term_version" integer NOT NULL,
	"eligibility_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"past_due_at" timestamp with time zone NOT NULL,
	"role" text NOT NULL,
	"provenance" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "financial_responsibilities_slot_check" CHECK ("financial_responsibilities"."slot_index" BETWEEN 0 AND 3),
	CONSTRAINT "financial_responsibilities_lineup_size_check" CHECK ("financial_responsibilities"."paying_lineup_size" IN (3, 4)),
	CONSTRAINT "financial_responsibilities_role_check" CHECK ("financial_responsibilities"."role" IN ('regular', 'substitute')),
	CONSTRAINT "financial_responsibilities_provenance_check" CHECK ("financial_responsibilities"."provenance" = 'explicit_admin_selection'),
	CONSTRAINT "financial_responsibilities_amount_check" CHECK ("financial_responsibilities"."amount_minor" > 0 AND "financial_responsibilities"."currency" = 'USD' AND "financial_responsibilities"."billing_term_version" > 0 AND "financial_responsibilities"."purpose" = 'league_weekly_fee'),
	CONSTRAINT "financial_responsibilities_timing_check" CHECK ("financial_responsibilities"."past_due_at" >= "financial_responsibilities"."due_at")
);
--> statement-breakpoint
ALTER TABLE "bowler_occurrence_obligations" ADD COLUMN "due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bowler_occurrence_obligations" ADD COLUMN "past_due_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "financial_activations_tenant_identity_unique" ON "financial_activations" USING btree ("id","organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bowler_eligibilities_exact_responsibility_unique" ON "bowler_occurrence_eligibilities" USING btree ("id","organization_id","league_id","occurrence_id","bowler_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bowler_obligations_exact_financial_reference_unique" ON "bowler_occurrence_obligations" USING btree ("id","organization_id","league_id","occurrence_id","bowler_id","purpose","amount_minor","currency","billing_term_id","billing_term_version","due_at","past_due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bowler_team_assignments_exact_responsibility_unique" ON "bowler_occurrence_team_assignments" USING btree ("id","organization_id","league_id","occurrence_id","bowler_id","team_id");--> statement-breakpoint
ALTER TABLE "financial_activation_revisions" ADD CONSTRAINT "financial_activation_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_activation_revisions" ADD CONSTRAINT "financial_activation_revisions_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_activation_revisions" ADD CONSTRAINT "financial_activation_revisions_parent_fk" FOREIGN KEY ("activation_id","organization_id","league_id") REFERENCES "public"."financial_activations"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_activations" ADD CONSTRAINT "financial_activations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_activations" ADD CONSTRAINT "financial_activations_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_activations" ADD CONSTRAINT "financial_activations_league_tenant_fk" FOREIGN KEY ("league_id","organization_id") REFERENCES "public"."leagues"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_responsibilities" ADD CONSTRAINT "financial_responsibilities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_responsibilities" ADD CONSTRAINT "financial_responsibilities_activation_fk" FOREIGN KEY ("activation_id","organization_id","league_id") REFERENCES "public"."financial_activations"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_responsibilities" ADD CONSTRAINT "financial_responsibilities_occurrence_fk" FOREIGN KEY ("occurrence_id","organization_id","league_id") REFERENCES "public"."league_occurrences"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_responsibilities" ADD CONSTRAINT "financial_responsibilities_team_fk" FOREIGN KEY ("team_id","league_id") REFERENCES "public"."teams"("id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_responsibilities" ADD CONSTRAINT "financial_responsibilities_bowler_fk" FOREIGN KEY ("bowler_id","organization_id") REFERENCES "public"."bowlers"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_responsibilities" ADD CONSTRAINT "financial_responsibilities_eligibility_fk" FOREIGN KEY ("eligibility_id","organization_id","league_id","occurrence_id","bowler_id") REFERENCES "public"."bowler_occurrence_eligibilities"("id","organization_id","league_id","occurrence_id","bowler_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_responsibilities" ADD CONSTRAINT "financial_responsibilities_assignment_fk" FOREIGN KEY ("assignment_id","organization_id","league_id","occurrence_id","bowler_id","team_id") REFERENCES "public"."bowler_occurrence_team_assignments"("id","organization_id","league_id","occurrence_id","bowler_id","team_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_responsibilities" ADD CONSTRAINT "financial_responsibilities_obligation_fk" FOREIGN KEY ("obligation_id","organization_id","league_id","occurrence_id","bowler_id","purpose","amount_minor","currency","billing_term_id","billing_term_version","due_at","past_due_at") REFERENCES "public"."bowler_occurrence_obligations"("id","organization_id","league_id","occurrence_id","bowler_id","purpose","amount_minor","currency","billing_term_id","billing_term_version","due_at","past_due_at") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_responsibilities" ADD CONSTRAINT "financial_responsibilities_billing_term_fk" FOREIGN KEY ("billing_term_id","organization_id","league_id","occurrence_id","purpose","billing_term_version","currency") REFERENCES "public"."league_occurrence_billing_terms"("id","organization_id","league_id","occurrence_id","purpose","version","currency") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "financial_activation_revisions_unique" ON "financial_activation_revisions" USING btree ("organization_id","league_id","activation_id","revision_number");--> statement-breakpoint
CREATE UNIQUE INDEX "financial_activations_command_unique" ON "financial_activations" USING btree ("organization_id","command_key");--> statement-breakpoint
CREATE UNIQUE INDEX "financial_activations_active_league_unique" ON "financial_activations" USING btree ("organization_id","league_id") WHERE "financial_activations"."state" = 'active' AND "financial_activations"."completeness_marker" = true;--> statement-breakpoint
CREATE INDEX "financial_activations_tenant_created_idx" ON "financial_activations" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "financial_responsibilities_slot_unique" ON "financial_responsibilities" USING btree ("organization_id","league_id","activation_id","occurrence_id","team_id","slot_index");--> statement-breakpoint
CREATE UNIQUE INDEX "financial_responsibilities_bowler_unique" ON "financial_responsibilities" USING btree ("organization_id","league_id","activation_id","occurrence_id","team_id","bowler_id");--> statement-breakpoint
CREATE INDEX "financial_responsibilities_occurrence_idx" ON "financial_responsibilities" USING btree ("organization_id","league_id","occurrence_id");--> statement-breakpoint
ALTER TABLE "bowler_occurrence_obligations" ADD CONSTRAINT "bowler_obligations_timing_check" CHECK (("bowler_occurrence_obligations"."due_at" IS NULL AND "bowler_occurrence_obligations"."past_due_at" IS NULL) OR ("bowler_occurrence_obligations"."due_at" IS NOT NULL AND "bowler_occurrence_obligations"."past_due_at" IS NOT NULL AND "bowler_occurrence_obligations"."past_due_at" >= "bowler_occurrence_obligations"."due_at"));
--> statement-breakpoint
CREATE FUNCTION enforce_financial_activation_completeness() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE activation_key uuid; expected_rows integer; expected_groups integer; lineup_size integer; actual_rows integer; actual_groups integer; invalid_groups integer; revision_rows integer;
BEGIN
  IF TG_TABLE_NAME = 'financial_activations' THEN
    IF TG_OP = 'DELETE' THEN activation_key := OLD.id; ELSE activation_key := NEW.id; END IF;
  ELSIF TG_TABLE_NAME = 'financial_activation_revisions' THEN
    IF TG_OP = 'DELETE' THEN activation_key := OLD.activation_id; ELSE activation_key := NEW.activation_id; END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN activation_key := OLD.activation_id; ELSE activation_key := NEW.activation_id; END IF;
  END IF;
  SELECT expected_responsibility_count, expected_group_count, paying_lineup_size INTO expected_rows, expected_groups, lineup_size FROM financial_activations WHERE id = activation_key AND state = 'active' AND completeness_marker = true;
  IF NOT FOUND THEN IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
  SELECT count(*)::integer, count(DISTINCT (occurrence_id, team_id))::integer INTO actual_rows, actual_groups FROM financial_responsibilities WHERE activation_id = activation_key;
  IF actual_rows <> expected_rows OR actual_groups <> expected_groups THEN RAISE EXCEPTION 'financial activation evidence is incomplete'; END IF;
  SELECT count(*)::integer INTO revision_rows FROM financial_activation_revisions WHERE activation_id = activation_key AND organization_id = (SELECT organization_id FROM financial_activations WHERE id = activation_key) AND league_id = (SELECT league_id FROM financial_activations WHERE id = activation_key);
  IF revision_rows <> 1 THEN RAISE EXCEPTION 'financial activation revision evidence is incomplete'; END IF;
  SELECT count(*)::integer INTO invalid_groups FROM (SELECT occurrence_id, team_id, paying_lineup_size, count(*) AS row_count, min(slot_index) AS first_slot, max(slot_index) AS last_slot FROM financial_responsibilities WHERE activation_id = activation_key GROUP BY occurrence_id, team_id, paying_lineup_size) groups WHERE paying_lineup_size <> lineup_size OR row_count <> lineup_size OR first_slot <> 0 OR last_slot <> lineup_size - 1;
  IF invalid_groups <> 0 THEN RAISE EXCEPTION 'financial activation lineup evidence is incomplete'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE CONSTRAINT TRIGGER financial_activation_completeness_guard AFTER INSERT OR UPDATE ON financial_activations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_financial_activation_completeness();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER financial_activation_revision_completeness_guard AFTER INSERT OR UPDATE OR DELETE ON financial_activation_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_financial_activation_completeness();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER financial_responsibility_completeness_guard AFTER INSERT OR UPDATE OR DELETE ON financial_responsibilities DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_financial_activation_completeness();--> statement-breakpoint
CREATE FUNCTION prevent_financial_activation_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'financial activation evidence is immutable';
END $$;
CREATE TRIGGER financial_activations_immutable BEFORE UPDATE OR DELETE ON financial_activations FOR EACH ROW EXECUTE FUNCTION prevent_financial_activation_evidence_mutation();--> statement-breakpoint
CREATE TRIGGER financial_activation_revisions_immutable BEFORE UPDATE OR DELETE ON financial_activation_revisions FOR EACH ROW EXECUTE FUNCTION prevent_financial_activation_evidence_mutation();--> statement-breakpoint
CREATE TRIGGER financial_responsibilities_immutable BEFORE UPDATE OR DELETE ON financial_responsibilities FOR EACH ROW EXECUTE FUNCTION prevent_financial_activation_evidence_mutation();
