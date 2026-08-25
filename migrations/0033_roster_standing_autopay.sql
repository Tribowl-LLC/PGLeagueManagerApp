-- PR2 is a clean activation boundary.  Quiesce all legacy writers while the
-- preflight runs, then fail atomically if any consent or live legacy charge
-- would need an inferred backfill.  Archived schedules and terminal ledger
-- evidence remain readable.
LOCK TABLE "autopay_consents", "payment_schedules", "payment_operations" IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "autopay_consents") THEN
    RAISE EXCEPTION '0033 requires an empty autopay_consents table; no consent backfill is permitted';
  END IF;
  IF EXISTS (SELECT 1 FROM "payment_schedules" WHERE "active" = true) THEN
    RAISE EXCEPTION '0033 requires all legacy payment schedules to be inactive';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "payment_operations"
    WHERE "operation_type" IN ('scheduled_charge', 'canonical_autopay_charge')
      AND "status" NOT IN ('succeeded', 'action_required', 'reconciliation_required', 'failed_terminal', 'canceled')
  ) THEN
    RAISE EXCEPTION '0033 requires all legacy automatic-payment operations to be terminal';
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE "autopay_consent_partners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"consent_id" uuid NOT NULL,
	"consent_version" integer NOT NULL,
	"partner_bowler_id" integer NOT NULL,
	"payment_link_id" integer NOT NULL,
	"link_fingerprint" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "autopay_consent_partners_version_check" CHECK ("autopay_consent_partners"."consent_version" > 0 AND "autopay_consent_partners"."link_fingerprint" ~ '^lvpartnerlink:v1:[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "payment_operation_standing_autopay_bindings" (
	"operation_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"consent_id" uuid NOT NULL,
	"consent_version" integer NOT NULL,
	"provider_name" varchar(32) NOT NULL,
	"provider_location_id" varchar(255) NOT NULL,
	"trigger_occurrence_id" uuid NOT NULL,
	"paired_occurrence_id" uuid,
	"collection_group_id" uuid,
	"collection_group_revision" integer,
	"collection_group_fingerprint" varchar(128),
	"trigger_member_id" uuid,
	"paired_member_id" uuid,
	"cutoff_at" timestamp with time zone NOT NULL,
	"collection_mode" text NOT NULL,
	"evidence_fingerprint" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_operation_standing_autopay_bindings_version_check" CHECK ("payment_operation_standing_autopay_bindings"."consent_version" > 0 AND "payment_operation_standing_autopay_bindings"."evidence_fingerprint" ~ '^lvstandingcutoff:v1:[0-9a-f]{64}$' AND "payment_operation_standing_autopay_bindings"."provider_name" ~ '^[a-z0-9][a-z0-9_-]{0,31}$' AND length(btrim("payment_operation_standing_autopay_bindings"."provider_location_id")) > 0 AND (("payment_operation_standing_autopay_bindings"."collection_group_id" IS NULL AND "payment_operation_standing_autopay_bindings"."collection_group_revision" IS NULL AND "payment_operation_standing_autopay_bindings"."collection_group_fingerprint" IS NULL AND "payment_operation_standing_autopay_bindings"."paired_occurrence_id" IS NULL AND "payment_operation_standing_autopay_bindings"."trigger_member_id" IS NULL AND "payment_operation_standing_autopay_bindings"."paired_member_id" IS NULL) OR ("payment_operation_standing_autopay_bindings"."collection_group_id" IS NOT NULL AND "payment_operation_standing_autopay_bindings"."collection_group_revision" IS NOT NULL AND "payment_operation_standing_autopay_bindings"."collection_group_revision" > 0 AND "payment_operation_standing_autopay_bindings"."collection_group_fingerprint" ~ '^lvcollectiongroup:v1:[0-9a-f]{64}$' AND "payment_operation_standing_autopay_bindings"."paired_occurrence_id" IS NOT NULL AND "payment_operation_standing_autopay_bindings"."trigger_member_id" IS NOT NULL AND "payment_operation_standing_autopay_bindings"."paired_member_id" IS NOT NULL)) ),
	CONSTRAINT "payment_operation_standing_autopay_bindings_collection_mode_check" CHECK ("payment_operation_standing_autopay_bindings"."collection_mode" IN ('weekly', 'double_pay'))
);
--> statement-breakpoint
CREATE TABLE "payment_operation_standing_autopay_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_id" uuid NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"allocation_index" integer NOT NULL,
	"obligation_id" uuid NOT NULL,
	"bowler_id" integer NOT NULL,
	"role" text NOT NULL,
	"payment_link_id" integer,
	"link_fingerprint" varchar(128),
	"consent_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_operation_standing_autopay_participants_role_check" CHECK (("payment_operation_standing_autopay_participants"."role" = 'payer' AND "payment_operation_standing_autopay_participants"."payment_link_id" IS NULL AND "payment_operation_standing_autopay_participants"."link_fingerprint" IS NULL) OR ("payment_operation_standing_autopay_participants"."role" = 'partner' AND "payment_operation_standing_autopay_participants"."payment_link_id" IS NOT NULL AND "payment_operation_standing_autopay_participants"."link_fingerprint" ~ '^lvpartnerlink:v1:[0-9a-f]{64}$')),
	CONSTRAINT "payment_operation_standing_autopay_participants_version_check" CHECK ("payment_operation_standing_autopay_participants"."consent_version" > 0 AND "payment_operation_standing_autopay_participants"."allocation_index" >= 0)
);
--> statement-breakpoint
ALTER TABLE "payment_operations" DROP CONSTRAINT "payment_operations_operation_type_check";--> statement-breakpoint
ALTER TABLE "payment_operations" DROP CONSTRAINT "payment_operations_dispatch_claim_state_check";--> statement-breakpoint
ALTER TABLE "payment_operations" DROP CONSTRAINT "payment_operations_scheduled_cycle_check";--> statement-breakpoint
ALTER TABLE "payment_operations" DROP CONSTRAINT "payment_operations_trigger_occurrence_check";--> statement-breakpoint
ALTER TABLE "autopay_consents" DROP CONSTRAINT "autopay_consents_state_check";--> statement-breakpoint
ALTER TABLE "payment_operation_roster_snapshots" DROP CONSTRAINT "payment_operation_roster_snapshots_amount_check";--> statement-breakpoint
ALTER TABLE "autopay_consents" ADD COLUMN "payment_mode" text DEFAULT 'weekly' NOT NULL;--> statement-breakpoint
ALTER TABLE "autopay_consents" ADD COLUMN "consent_fingerprint" varchar(128) DEFAULT 'lvstandingconsent:v1:0000000000000000000000000000000000000000000000000000000000000000' NOT NULL;--> statement-breakpoint
ALTER TABLE "autopay_consents" ALTER COLUMN "consent_fingerprint" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "autopay_consents" ADD COLUMN "provider_location_id" varchar(255);--> statement-breakpoint
ALTER TABLE "autopay_consents" ADD COLUMN "activated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_operation_roster_snapshots" ADD COLUMN "snapshot_kind" text DEFAULT 'interactive' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_operation_roster_snapshots" ADD COLUMN "collection_mode" text;--> statement-breakpoint
ALTER TABLE "payment_operation_roster_snapshots" ADD COLUMN "cutoff_at" timestamp with time zone;--> statement-breakpoint
-- Composite foreign keys below require their parent identity indexes to
-- exist before the constraints are installed.  IF NOT EXISTS also makes the
-- payment_operations parity index safe when a deployed 0032 already has it.
CREATE UNIQUE INDEX IF NOT EXISTS "autopay_consent_partners_identity_unique" ON "autopay_consent_partners" USING btree ("id","organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "autopay_consent_partners_partner_unique" ON "autopay_consent_partners" USING btree ("organization_id","league_id","consent_id","consent_version","partner_bowler_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_operation_standing_autopay_bindings_identity_unique" ON "payment_operation_standing_autopay_bindings" USING btree ("operation_id","organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_operation_standing_autopay_participants_identity_unique" ON "payment_operation_standing_autopay_participants" USING btree ("id","organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_operation_standing_autopay_participants_allocation_unique" ON "payment_operation_standing_autopay_participants" USING btree ("operation_id","organization_id","league_id","allocation_index");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_operations_standing_autopay_target_unique" ON "payment_operations" USING btree ("organization_id","target_key") WHERE "payment_operations"."operation_type" = 'standing_autopay_charge';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_operations_id_org_league_unique" ON "payment_operations" USING btree ("id","organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bowler_payment_links_id_organization_unique" ON "bowler_payment_links" USING btree ("id","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "autopay_consents_identity_unique" ON "autopay_consents" USING btree ("id","organization_id","league_id","payer_bowler_id","consent_version");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "autopay_consents_tenant_identity_unique" ON "autopay_consents" USING btree ("id","organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "autopay_consents_fingerprint_unique" ON "autopay_consents" USING btree ("organization_id","league_id","payer_bowler_id","consent_fingerprint");--> statement-breakpoint
DROP INDEX IF EXISTS "bowler_payment_links_pair_unique_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "bowler_payment_links_pair_unique_idx" ON "bowler_payment_links" USING btree ("bowler_a_id","bowler_b_id") WHERE "status" <> 'retired';--> statement-breakpoint
ALTER TABLE "autopay_consent_partners" ADD CONSTRAINT "autopay_consent_partners_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autopay_consent_partners" ADD CONSTRAINT "autopay_consent_partners_league_tenant_fk" FOREIGN KEY ("league_id","organization_id") REFERENCES "public"."leagues"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autopay_consent_partners" ADD CONSTRAINT "autopay_consent_partners_consent_fk" FOREIGN KEY ("consent_id","organization_id","league_id") REFERENCES "public"."autopay_consents"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autopay_consent_partners" ADD CONSTRAINT "autopay_consent_partners_bowler_fk" FOREIGN KEY ("partner_bowler_id","organization_id") REFERENCES "public"."bowlers"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autopay_consent_partners" ADD CONSTRAINT "autopay_consent_partners_link_fk" FOREIGN KEY ("payment_link_id","organization_id") REFERENCES "public"."bowler_payment_links"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_operation_standing_autopay_bindings" ADD CONSTRAINT "payment_operation_standing_autopay_bindings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_operation_standing_autopay_bindings" ADD CONSTRAINT "payment_operation_standing_autopay_bindings_operation_fk" FOREIGN KEY ("operation_id","organization_id","league_id") REFERENCES "public"."payment_operations"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_operation_standing_autopay_bindings" ADD CONSTRAINT "payment_operation_standing_autopay_bindings_consent_fk" FOREIGN KEY ("consent_id","organization_id","league_id") REFERENCES "public"."autopay_consents"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_operation_standing_autopay_bindings" ADD CONSTRAINT "payment_operation_standing_autopay_bindings_trigger_occurrence_fk" FOREIGN KEY ("trigger_occurrence_id","organization_id","league_id") REFERENCES "public"."league_occurrences"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_operation_standing_autopay_bindings" ADD CONSTRAINT "payment_operation_standing_autopay_bindings_paired_occurrence_fk" FOREIGN KEY ("paired_occurrence_id","organization_id","league_id") REFERENCES "public"."league_occurrences"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_operation_standing_autopay_bindings" ADD CONSTRAINT "payment_operation_standing_autopay_bindings_group_fk" FOREIGN KEY ("collection_group_id","organization_id","league_id") REFERENCES "public"."canonical_collection_groups"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_operation_standing_autopay_bindings" ADD CONSTRAINT "payment_operation_standing_autopay_bindings_trigger_member_fk" FOREIGN KEY ("trigger_member_id","organization_id","league_id") REFERENCES "public"."canonical_collection_group_members"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_operation_standing_autopay_bindings" ADD CONSTRAINT "payment_operation_standing_autopay_bindings_paired_member_fk" FOREIGN KEY ("paired_member_id","organization_id","league_id") REFERENCES "public"."canonical_collection_group_members"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_operation_standing_autopay_participants" ADD CONSTRAINT "payment_operation_standing_autopay_participants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_operation_standing_autopay_participants" ADD CONSTRAINT "payment_operation_standing_autopay_participants_operation_fk" FOREIGN KEY ("operation_id","organization_id","league_id") REFERENCES "public"."payment_operation_standing_autopay_bindings"("operation_id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_operation_standing_autopay_participants" ADD CONSTRAINT "payment_operation_standing_autopay_participants_bowler_fk" FOREIGN KEY ("bowler_id","organization_id") REFERENCES "public"."bowlers"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_operation_standing_autopay_participants" ADD CONSTRAINT "payment_operation_standing_autopay_participants_link_fk" FOREIGN KEY ("payment_link_id","organization_id") REFERENCES "public"."bowler_payment_links"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_operation_standing_autopay_participants" ADD CONSTRAINT "payment_operation_standing_autopay_participants_obligation_fk" FOREIGN KEY ("obligation_id","organization_id","league_id") REFERENCES "public"."payment_obligations"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "autopay_consent_partners_identity_unique" ON "autopay_consent_partners" USING btree ("id","organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "autopay_consent_partners_partner_unique" ON "autopay_consent_partners" USING btree ("organization_id","league_id","consent_id","consent_version","partner_bowler_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_operation_standing_autopay_bindings_identity_unique" ON "payment_operation_standing_autopay_bindings" USING btree ("operation_id","organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_operation_standing_autopay_participants_identity_unique" ON "payment_operation_standing_autopay_participants" USING btree ("id","organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_operation_standing_autopay_participants_allocation_unique" ON "payment_operation_standing_autopay_participants" USING btree ("operation_id","organization_id","league_id","allocation_index");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_operations_standing_autopay_target_unique" ON "payment_operations" USING btree ("organization_id","target_key") WHERE "payment_operations"."operation_type" = 'standing_autopay_charge';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_operations_id_org_league_unique" ON "payment_operations" USING btree ("id","organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bowler_payment_links_id_organization_unique" ON "bowler_payment_links" USING btree ("id","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "autopay_consents_identity_unique" ON "autopay_consents" USING btree ("id","organization_id","league_id","payer_bowler_id","consent_version");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "autopay_consents_fingerprint_unique" ON "autopay_consents" USING btree ("organization_id","league_id","payer_bowler_id","consent_fingerprint");--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_operation_type_check" CHECK ("payment_operations"."operation_type" IN ('scheduled_charge', 'interactive_charge', 'refund', 'canonical_autopay_charge', 'standing_autopay_charge'));--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_dispatch_claim_state_check" CHECK ((
      ("payment_operations"."operation_type" IN ('canonical_autopay_charge', 'standing_autopay_charge', 'scheduled_charge', 'interactive_charge')
        AND (
          ("payment_operations"."status" IN ('pending', 'retry_scheduled') AND "payment_operations"."dispatch_claimed_at" IS NULL)
          OR "payment_operations"."status" IN ('leased', 'provider_unknown', 'reconciliation_required', 'succeeded', 'action_required', 'failed_terminal', 'canceled')
        ))
      OR ("payment_operations"."operation_type" NOT IN ('canonical_autopay_charge', 'standing_autopay_charge', 'scheduled_charge', 'interactive_charge') AND "payment_operations"."dispatch_claimed_at" IS NULL)
    ));--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_scheduled_cycle_check" CHECK ((
      "payment_operations"."operation_type" = 'scheduled_charge'
      AND "payment_operations"."payment_schedule_id" IS NOT NULL
      AND "payment_operations"."billing_cycle_at" IS NOT NULL
    ) OR (
      "payment_operations"."operation_type" = 'standing_autopay_charge'
      AND "payment_operations"."payment_schedule_id" IS NULL
      AND "payment_operations"."billing_cycle_at" IS NULL
      AND "payment_operations"."league_id" IS NOT NULL
      AND "payment_operations"."canonical_plan_id" IS NULL
      AND "payment_operations"."authorizing_user_id" IS NOT NULL
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
      AND "payment_operations"."canonical_plan_id" IS NULL
    ));--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_trigger_occurrence_check" CHECK ((
      "payment_operations"."operation_type" = 'scheduled_charge'
      AND ("payment_operations"."trigger_occurrence_id" IS NULL OR (
        "payment_operations"."payment_schedule_id" IS NOT NULL AND "payment_operations"."billing_cycle_at" IS NOT NULL
      ))
    ) OR (
      "payment_operations"."operation_type" = 'standing_autopay_charge'
      AND "payment_operations"."trigger_occurrence_id" IS NOT NULL
      AND "payment_operations"."league_id" IS NOT NULL
    ) OR (
      "payment_operations"."operation_type" = 'canonical_autopay_charge'
      AND "payment_operations"."trigger_occurrence_id" IS NOT NULL
      AND "payment_operations"."canonical_plan_id" IS NOT NULL
      AND "payment_operations"."league_id" IS NOT NULL
    ) OR (
      "payment_operations"."operation_type" IN ('interactive_charge', 'refund')
      AND "payment_operations"."trigger_occurrence_id" IS NULL
    ));--> statement-breakpoint
ALTER TABLE "autopay_consents" ADD CONSTRAINT "autopay_consents_state_shape_check" CHECK ((
    ("autopay_consents"."state" = 'pending' AND "autopay_consents"."revoked_at" IS NULL)
    OR ("autopay_consents"."state" = 'active' AND "autopay_consents"."provider_name" IS NOT NULL AND "autopay_consents"."provider_location_id" IS NOT NULL AND "autopay_consents"."encrypted_source_id" IS NOT NULL AND "autopay_consents"."encrypted_customer_id" IS NOT NULL AND "autopay_consents"."revoked_at" IS NULL)
    OR ("autopay_consents"."state" IN ('revoked', 'expired') AND "autopay_consents"."provider_name" IS NOT NULL AND "autopay_consents"."provider_location_id" IS NOT NULL AND "autopay_consents"."encrypted_source_id" IS NOT NULL AND "autopay_consents"."encrypted_customer_id" IS NOT NULL AND "autopay_consents"."revoked_at" IS NOT NULL)
  ));--> statement-breakpoint
ALTER TABLE "autopay_consents" ADD CONSTRAINT "autopay_consents_provider_name_check" CHECK ("autopay_consents"."provider_name" IS NULL OR "autopay_consents"."provider_name" ~ '^[a-z0-9][a-z0-9_-]{0,31}$');--> statement-breakpoint
ALTER TABLE "autopay_consents" ADD CONSTRAINT "autopay_consents_provider_location_check" CHECK ("autopay_consents"."provider_location_id" IS NULL OR length(btrim("autopay_consents"."provider_location_id")) > 0);--> statement-breakpoint
ALTER TABLE "autopay_consents" ADD CONSTRAINT "autopay_consents_state_check" CHECK ("autopay_consents"."state" IN ('pending', 'active', 'revoked', 'expired') AND "autopay_consents"."payment_mode" IN ('weekly') AND "autopay_consents"."consent_version" > 0 AND "autopay_consents"."consent_fingerprint" ~ '^lvstandingconsent:v1:[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "payment_operation_roster_snapshots" ADD CONSTRAINT "payment_operation_roster_snapshots_amount_check" CHECK ("payment_operation_roster_snapshots"."amount_minor" > 0 AND "payment_operation_roster_snapshots"."currency" = 'USD' AND "payment_operation_roster_snapshots"."snapshot_version" > 0 AND "payment_operation_roster_snapshots"."snapshot_kind" IN ('interactive', 'standing_autopay') AND (("payment_operation_roster_snapshots"."snapshot_kind" = 'interactive' AND "payment_operation_roster_snapshots"."collection_mode" IS NULL AND "payment_operation_roster_snapshots"."cutoff_at" IS NULL) OR ("payment_operation_roster_snapshots"."snapshot_kind" = 'standing_autopay' AND "payment_operation_roster_snapshots"."collection_mode" IN ('weekly', 'double_pay') AND "payment_operation_roster_snapshots"."cutoff_at" IS NOT NULL)));
--> statement-breakpoint
-- PR2 evidence is append-only.  The existing 0032 guard protects the
-- original consent columns, so this second trigger includes the standing
-- payment mode/fingerprint/location fields introduced here as well.
CREATE OR REPLACE FUNCTION roster_standing_consent_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('leaguevault.organization_teardown', true) = 'on' THEN RETURN OLD; END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'standing consent evidence is append-only'; END IF;
  IF ROW(NEW.id, NEW.organization_id, NEW.league_id, NEW.payer_bowler_id,
          NEW.consent_version, NEW.payment_mode, NEW.consent_fingerprint,
          NEW.provider_name, NEW.provider_location_id, NEW.encrypted_source_id,
          NEW.encrypted_customer_id, NEW.created_by_user_id, NEW.activated_at, NEW.created_at)
      IS DISTINCT FROM
     ROW(OLD.id, OLD.organization_id, OLD.league_id, OLD.payer_bowler_id,
          OLD.consent_version, OLD.payment_mode, OLD.consent_fingerprint,
          OLD.provider_name, OLD.provider_location_id, OLD.encrypted_source_id,
          OLD.encrypted_customer_id, OLD.created_by_user_id, OLD.activated_at, OLD.created_at)
  THEN RAISE EXCEPTION 'standing consent identity is immutable'; END IF;
  IF NOT (
    NEW.state = OLD.state
    OR (OLD.state = 'pending' AND NEW.state IN ('active', 'revoked', 'expired'))
    OR (OLD.state = 'active' AND NEW.state IN ('revoked', 'expired'))
  ) THEN RAISE EXCEPTION 'invalid standing consent state transition'; END IF;
  IF NEW.state IN ('revoked', 'expired') AND NEW.revoked_at IS NULL THEN RAISE EXCEPTION 'revoked standing consent requires revoked_at'; END IF;
  IF NEW.state IN ('pending', 'active') AND NEW.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'active standing consent cannot have revoked_at'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER autopay_consents_standing_immutable BEFORE UPDATE OR DELETE ON autopay_consents FOR EACH ROW EXECUTE FUNCTION roster_standing_consent_immutable_guard();
--> statement-breakpoint
CREATE TRIGGER autopay_consent_partners_append_only BEFORE UPDATE OR DELETE ON autopay_consent_partners FOR EACH ROW EXECUTE FUNCTION roster_payment_append_only_guard();
--> statement-breakpoint
CREATE TRIGGER payment_operation_standing_autopay_bindings_append_only BEFORE UPDATE OR DELETE ON payment_operation_standing_autopay_bindings FOR EACH ROW EXECUTE FUNCTION roster_payment_append_only_guard();
--> statement-breakpoint
CREATE TRIGGER payment_operation_standing_autopay_participants_append_only BEFORE UPDATE OR DELETE ON payment_operation_standing_autopay_participants FOR EACH ROW EXECUTE FUNCTION roster_payment_append_only_guard();
--> statement-breakpoint
-- A consent-partner row is immutable evidence, not a free-form same-tenant
-- bowler/link join. Validate the accepted link and the exact opposite endpoint
-- of the consent payer at the deferred boundary so direct SQL cannot
-- manufacture a participant for an unrelated bowler.
CREATE OR REPLACE FUNCTION roster_standing_consent_partner_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  consent record;
  link record;
BEGIN
  SELECT c.payer_bowler_id, c.consent_version, c.state
    INTO consent
    FROM autopay_consents c
   WHERE c.id = NEW.consent_id
     AND c.organization_id = NEW.organization_id
     AND c.league_id = NEW.league_id;
  IF consent.payer_bowler_id IS NULL OR consent.consent_version <> NEW.consent_version OR consent.state <> 'active' THEN
    RAISE EXCEPTION 'standing consent partner consent binding mismatch';
  END IF;
  SELECT l.status, l.bowler_a_id, l.bowler_b_id
    INTO link
    FROM bowler_payment_links l
   WHERE l.id = NEW.payment_link_id
     AND l.organization_id = NEW.organization_id;
  IF link.status IS NULL OR link.status <> 'accepted' THEN
    RAISE EXCEPTION 'standing consent partner link is not accepted';
  END IF;
  IF consent.payer_bowler_id = link.bowler_a_id THEN
    IF NEW.partner_bowler_id <> link.bowler_b_id THEN RAISE EXCEPTION 'standing consent partner is not the link opposite endpoint'; END IF;
  ELSIF consent.payer_bowler_id = link.bowler_b_id THEN
    IF NEW.partner_bowler_id <> link.bowler_a_id THEN RAISE EXCEPTION 'standing consent partner is not the link opposite endpoint'; END IF;
  ELSE
    RAISE EXCEPTION 'standing consent payer is not a link endpoint';
  END IF;
  IF NEW.link_fingerprint !~ '^lvpartnerlink:v1:[0-9a-f]{64}$' THEN RAISE EXCEPTION 'standing consent partner fingerprint is invalid'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER autopay_consent_partner_evidence
AFTER INSERT ON autopay_consent_partners
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION roster_standing_consent_partner_evidence_guard();
--> statement-breakpoint
-- Deferring the sum check on item writes closes the hole where a direct item
-- insert could change a snapshot total after the parent snapshot trigger ran.
CREATE CONSTRAINT TRIGGER payment_operation_roster_snapshot_item_sum
AFTER INSERT OR UPDATE ON payment_operation_roster_snapshot_items
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION roster_payment_snapshot_sum_guard();
--> statement-breakpoint
-- Standing bindings are the durable authority for a cutoff.  Keep the
-- trigger/group/member identity in relational evidence and validate it at
-- commit so operation, binding, and published collection rows cannot drift.
CREATE OR REPLACE FUNCTION roster_standing_binding_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  op record;
  consent record;
  trigger_member_count integer;
  paired_member_count integer;
BEGIN
  SELECT po.operation_type, po.trigger_occurrence_id, po.organization_id, po.league_id
    INTO op FROM payment_operations po
   WHERE po.id = NEW.operation_id AND po.organization_id = NEW.organization_id AND po.league_id = NEW.league_id;
  IF op.operation_type IS DISTINCT FROM 'standing_autopay_charge' OR op.trigger_occurrence_id IS DISTINCT FROM NEW.trigger_occurrence_id THEN
    RAISE EXCEPTION 'standing binding operation trigger identity mismatch';
  END IF;
  SELECT c.consent_version, c.payer_bowler_id, c.state, c.payment_mode
    INTO consent FROM autopay_consents c
   WHERE c.id = NEW.consent_id AND c.organization_id = NEW.organization_id AND c.league_id = NEW.league_id;
  IF consent.consent_version IS NULL OR consent.consent_version <> NEW.consent_version OR consent.payment_mode <> 'weekly' THEN
    RAISE EXCEPTION 'standing binding consent identity mismatch';
  END IF;
  IF NEW.collection_mode = 'weekly' THEN
    IF NEW.collection_group_id IS NOT NULL OR NEW.collection_group_revision IS NOT NULL OR NEW.collection_group_fingerprint IS NOT NULL OR NEW.paired_occurrence_id IS NOT NULL OR NEW.trigger_member_id IS NOT NULL OR NEW.paired_member_id IS NOT NULL THEN
      RAISE EXCEPTION 'weekly standing binding cannot contain paired group evidence';
    END IF;
  ELSE
    SELECT count(*) FILTER (WHERE role = 'trigger'), count(*) FILTER (WHERE role = 'paired')
      INTO trigger_member_count, paired_member_count
      FROM canonical_collection_group_members
     WHERE id IN (NEW.trigger_member_id, NEW.paired_member_id)
       AND organization_id = NEW.organization_id AND league_id = NEW.league_id
       AND group_id = NEW.collection_group_id AND active = true;
    IF NEW.collection_group_id IS NULL OR NEW.collection_group_revision IS NULL OR NEW.collection_group_fingerprint IS NULL OR NEW.paired_occurrence_id IS NULL OR NEW.trigger_member_id IS NULL OR NEW.paired_member_id IS NULL OR trigger_member_count <> 1 OR paired_member_count <> 1 THEN
      RAISE EXCEPTION 'double-pay standing binding requires exact trigger and paired member evidence';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM canonical_collection_groups g WHERE g.id = NEW.collection_group_id AND g.organization_id = NEW.organization_id AND g.league_id = NEW.league_id AND g.state = 'published' AND g.current_revision = NEW.collection_group_revision AND g.fingerprint = NEW.collection_group_fingerprint) THEN
      RAISE EXCEPTION 'standing binding collection group revision is not published';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM canonical_collection_group_members m WHERE m.id = NEW.trigger_member_id AND m.occurrence_id = NEW.trigger_occurrence_id AND m.role = 'trigger' AND m.active = true) OR NOT EXISTS (SELECT 1 FROM canonical_collection_group_members m WHERE m.id = NEW.paired_member_id AND m.occurrence_id = NEW.paired_occurrence_id AND m.role = 'paired' AND m.active = true) THEN
      RAISE EXCEPTION 'standing binding member occurrence identity mismatch';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM league_occurrences o WHERE o.id = NEW.trigger_occurrence_id AND o.organization_id = NEW.organization_id AND o.league_id = NEW.league_id AND o.start_at = NEW.cutoff_at) THEN
    RAISE EXCEPTION 'standing binding cutoff does not match trigger occurrence';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payment_operation_standing_autopay_binding_evidence
AFTER INSERT OR UPDATE ON payment_operation_standing_autopay_bindings
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION roster_standing_binding_evidence_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION roster_standing_participant_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  binding record;
  consent record;
  item record;
  partner record;
BEGIN
  SELECT b.consent_id, b.consent_version INTO binding
    FROM payment_operation_standing_autopay_bindings b
   WHERE b.operation_id = NEW.operation_id AND b.organization_id = NEW.organization_id AND b.league_id = NEW.league_id;
  IF binding.consent_id IS NULL OR binding.consent_version <> NEW.consent_version THEN RAISE EXCEPTION 'standing participant consent version mismatch'; END IF;
  SELECT i.obligation_id INTO item FROM payment_operation_roster_snapshot_items i
   WHERE i.operation_id = NEW.operation_id AND i.organization_id = NEW.organization_id AND i.league_id = NEW.league_id AND i.allocation_index = NEW.allocation_index;
  IF item.obligation_id IS NULL OR item.obligation_id <> NEW.obligation_id THEN RAISE EXCEPTION 'standing participant snapshot item mismatch'; END IF;
  SELECT c.payer_bowler_id, c.state, c.consent_version INTO consent FROM autopay_consents c WHERE c.id = binding.consent_id AND c.organization_id = NEW.organization_id AND c.league_id = NEW.league_id;
  IF consent.payer_bowler_id IS NULL OR consent.state NOT IN ('active', 'revoked', 'expired') OR consent.consent_version <> NEW.consent_version THEN RAISE EXCEPTION 'standing participant consent evidence unavailable'; END IF;
  IF NEW.role = 'payer' THEN
    IF NEW.bowler_id <> consent.payer_bowler_id OR NEW.payment_link_id IS NOT NULL OR NEW.link_fingerprint IS NOT NULL THEN RAISE EXCEPTION 'standing payer participant identity mismatch'; END IF;
  ELSE
    SELECT cp.link_fingerprint, l.status, l.bowler_a_id, l.bowler_b_id INTO partner FROM autopay_consent_partners cp INNER JOIN bowler_payment_links l ON l.id = cp.payment_link_id AND l.organization_id = cp.organization_id
     WHERE cp.consent_id = binding.consent_id AND cp.consent_version = binding.consent_version AND cp.organization_id = NEW.organization_id AND cp.league_id = NEW.league_id AND cp.partner_bowler_id = NEW.bowler_id AND cp.payment_link_id = NEW.payment_link_id;
    IF partner.link_fingerprint IS NULL OR partner.status <> 'accepted' OR partner.link_fingerprint <> NEW.link_fingerprint OR consent.payer_bowler_id NOT IN (partner.bowler_a_id, partner.bowler_b_id) THEN RAISE EXCEPTION 'standing partner participant authorization mismatch'; END IF;
    IF (consent.payer_bowler_id = partner.bowler_a_id AND NEW.bowler_id <> partner.bowler_b_id) OR (consent.payer_bowler_id = partner.bowler_b_id AND NEW.bowler_id <> partner.bowler_a_id) OR consent.payer_bowler_id = NEW.bowler_id THEN RAISE EXCEPTION 'standing partner participant must be the exact opposite link endpoint'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payment_operation_standing_autopay_participant_evidence
AFTER INSERT OR UPDATE ON payment_operation_standing_autopay_participants
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION roster_standing_participant_evidence_guard();
