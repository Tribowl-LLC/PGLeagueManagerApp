-- PR3 is a destructive steady-state boundary for payment evidence that was
-- created before the roster contract.  It is intentionally one transaction:
-- no new financial evidence may race the checks or be silently converted.
LOCK TABLE "payment_schedules", "autopay_setup_requests",
  "interactive_payment_operation_allocations",
  "interactive_payment_operation_line_items",
  "interactive_payment_operation_snapshots",
  "scheduled_payment_operation_allocations",
  "scheduled_payment_operation_line_items",
  "scheduled_payment_operation_snapshots",
  "payment_operations", "payment_disputes", "autopay_consents",
  "payment_obligations", "payment_allocations",
  "payments", "refund_payment_operation_snapshots",
  "payment_operation_roster_snapshots",
  "payment_operation_roster_snapshot_items",
  "payment_operation_standing_autopay_bindings",
  "payment_operation_standing_autopay_participants",
  "games", "scores"
  IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "payment_operations"
    WHERE "status" NOT IN ('succeeded', 'action_required', 'failed_terminal', 'canceled')
  ) THEN
    RAISE EXCEPTION '0034 refused: payment operations must be terminal before legacy evidence cleanup';
  END IF;
  IF EXISTS (SELECT 1 FROM "payment_disputes") THEN
    RAISE EXCEPTION '0034 refused: payment disputes require explicit reconciliation before cleanup';
  END IF;
  IF EXISTS (SELECT 1 FROM "autopay_consents")
    OR EXISTS (SELECT 1 FROM "payment_obligations")
    OR EXISTS (SELECT 1 FROM "payment_allocations")
    OR EXISTS (SELECT 1 FROM "payment_operation_roster_snapshots")
    OR EXISTS (SELECT 1 FROM "payment_operation_roster_snapshot_items")
    OR EXISTS (SELECT 1 FROM "payment_operation_standing_autopay_bindings")
    OR EXISTS (SELECT 1 FROM "payment_operation_standing_autopay_participants")
  THEN
    RAISE EXCEPTION '0034 refused: canonical financial or standing evidence is not empty';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "games" g
    WHERE g."occurrence_id" IS NULL
      AND EXISTS (SELECT 1 FROM "scores" s WHERE s."game_id" = g."id")
  ) THEN
    RAISE EXCEPTION '0034 refused: an occurrence-less game has scores';
  END IF;
END $$;
--> statement-breakpoint

-- This release intentionally starts the financial ledger clean.  The user
-- authorized discarding all pre-cutover payment evidence; current league,
-- roster, canonical schedule, card/customer, and webhook-inbox data remain.
-- Delete in dependency order so no payment or provider-ledger row is left
-- pointing at an absent snapshot or operation.
DROP TABLE "autopay_setup_requests";
DROP TABLE "interactive_payment_operation_allocations";
DROP TABLE "interactive_payment_operation_line_items";
DROP TABLE "interactive_payment_operation_snapshots";
DROP TABLE "scheduled_payment_operation_allocations";
DROP TABLE "scheduled_payment_operation_line_items";
DROP TABLE "scheduled_payment_operation_snapshots";
DROP FUNCTION IF EXISTS enforce_d2_obligation_amount_immutable();
DROP FUNCTION IF EXISTS assert_d2_collection_plan_obligation_amount(integer, integer, uuid, integer);
DROP FUNCTION IF EXISTS enforce_d2_collection_plan_item_amount();
DROP FUNCTION IF EXISTS enforce_d2_collection_plan_state_amount();
DROP FUNCTION IF EXISTS enforce_d2_payment_allocation_conservation();
DROP FUNCTION IF EXISTS enforce_financial_activation_completeness();
DROP FUNCTION IF EXISTS prevent_financial_activation_evidence_mutation();
DROP FUNCTION IF EXISTS f3_immutable_evidence_guard();
DROP FUNCTION IF EXISTS f3_provenance_immutable_guard();
DROP FUNCTION IF EXISTS f3_policy_occurrence_commit_guard();
DROP FUNCTION IF EXISTS f3_policy_complete_set_guard();
DROP FUNCTION IF EXISTS f3_current_revision_evidence_guard();
DROP FUNCTION IF EXISTS canonical_autopay_snapshot_immutable_guard();
--> statement-breakpoint
DELETE FROM "refund_payment_operation_snapshots";
DELETE FROM "payments";
DELETE FROM "payment_operations";
--> statement-breakpoint
ALTER TABLE "payment_operations" DROP CONSTRAINT IF EXISTS "payment_operations_payment_schedule_id_payment_schedules_id_fk";
DROP TABLE "payment_schedules";
--> statement-breakpoint

-- Old occurrence-less games carry no score evidence by the guard above and
-- are the only rows eligible for removal before the identity becomes strict.
DELETE FROM "games" WHERE "occurrence_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "payment_operations" DROP CONSTRAINT "payment_operations_scheduled_cycle_check";--> statement-breakpoint
ALTER TABLE "payment_operations" DROP CONSTRAINT "payment_operations_operation_type_check";--> statement-breakpoint
ALTER TABLE "payment_operations" DROP CONSTRAINT "payment_operations_dispatch_claim_state_check";--> statement-breakpoint
ALTER TABLE "payment_operations" DROP CONSTRAINT "payment_operations_trigger_occurrence_check";--> statement-breakpoint
ALTER TABLE "payment_operation_roster_snapshots" DROP CONSTRAINT "payment_operation_roster_snapshots_amount_check";--> statement-breakpoint
DROP INDEX "payment_operations_recurring_cycle_unique";--> statement-breakpoint
ALTER TABLE "games" ALTER COLUMN "occurrence_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_operation_roster_snapshots" ALTER COLUMN "snapshot_version" SET DEFAULT 2;--> statement-breakpoint
ALTER TABLE "payment_operation_roster_snapshots" ADD COLUMN "location_id" integer;--> statement-breakpoint
ALTER TABLE "payment_operation_roster_snapshots" ADD COLUMN "provider_location_id" varchar(255);--> statement-breakpoint
ALTER TABLE "payment_operation_roster_snapshots" ADD COLUMN "payer_bowler_id" integer;--> statement-breakpoint
ALTER TABLE "payment_operation_roster_snapshots" ADD COLUMN "request_kind" text;--> statement-breakpoint
ALTER TABLE "payment_operation_roster_snapshots" ADD COLUMN "encrypted_source_id" text;--> statement-breakpoint
ALTER TABLE "payment_operation_roster_snapshots" ADD COLUMN "encrypted_customer_id" text;--> statement-breakpoint
ALTER TABLE "payment_operation_roster_snapshots" ADD COLUMN "encrypted_buyer_email" text;--> statement-breakpoint
ALTER TABLE "payment_operation_roster_snapshots" ADD COLUMN "store_card" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_operation_roster_snapshots" ADD COLUMN "source_kind" text;--> statement-breakpoint
ALTER TABLE "payment_operation_roster_snapshots" ADD COLUMN "combined_charge_group_id" varchar(128);--> statement-breakpoint
ALTER TABLE "payment_operation_roster_snapshots" ADD COLUMN "quote_fingerprint" varchar(84);--> statement-breakpoint
ALTER TABLE "payment_operation_roster_snapshots" ADD COLUMN "line_items" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_operation_roster_snapshots" ADD CONSTRAINT "payment_operation_roster_snapshots_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_operation_roster_snapshots" ADD CONSTRAINT "payment_operation_roster_snapshots_payer_bowler_id_bowlers_id_fk" FOREIGN KEY ("payer_bowler_id") REFERENCES "public"."bowlers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leagues" DROP COLUMN "final_two_weeks_due_week";--> statement-breakpoint
ALTER TABLE "payment_operations" DROP COLUMN "payment_schedule_id";--> statement-breakpoint
ALTER TABLE "payment_operations" DROP COLUMN "billing_cycle_at";--> statement-breakpoint
ALTER TABLE "payment_operations" DROP COLUMN "canonical_plan_id";--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_operation_scope_check" CHECK ((
      "payment_operations"."operation_type" = 'standing_autopay_charge'
      AND "payment_operations"."league_id" IS NOT NULL
      AND "payment_operations"."authorizing_user_id" IS NOT NULL
    ) OR (
      "payment_operations"."operation_type" = 'interactive_charge'
      AND "payment_operations"."league_id" IS NOT NULL
      AND "payment_operations"."authorizing_user_id" IS NOT NULL
      AND "payment_operations"."trigger_occurrence_id" IS NULL
    ) OR (
      "payment_operations"."operation_type" = 'refund'
      AND "payment_operations"."trigger_occurrence_id" IS NULL
    ));--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_operation_type_check" CHECK ("payment_operations"."operation_type" IN ('interactive_charge', 'refund', 'standing_autopay_charge'));--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_dispatch_claim_state_check" CHECK ((
      ("payment_operations"."operation_type" IN ('standing_autopay_charge', 'interactive_charge')
        AND (
          ("payment_operations"."status" IN ('pending', 'retry_scheduled') AND "payment_operations"."dispatch_claimed_at" IS NULL)
          OR "payment_operations"."status" IN ('leased', 'provider_unknown', 'reconciliation_required', 'succeeded', 'action_required', 'failed_terminal', 'canceled')
        ))
      OR ("payment_operations"."operation_type" NOT IN ('standing_autopay_charge', 'interactive_charge') AND "payment_operations"."dispatch_claimed_at" IS NULL)
    ));--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_trigger_occurrence_check" CHECK ((
      "payment_operations"."operation_type" = 'standing_autopay_charge'
      AND "payment_operations"."trigger_occurrence_id" IS NOT NULL
      AND "payment_operations"."league_id" IS NOT NULL
    ) OR (
      "payment_operations"."operation_type" IN ('interactive_charge', 'refund')
      AND "payment_operations"."trigger_occurrence_id" IS NULL
    ));--> statement-breakpoint
ALTER TABLE "payment_operation_roster_snapshots" ADD CONSTRAINT "payment_operation_roster_snapshots_fingerprint_check" CHECK ("payment_operation_roster_snapshots"."snapshot_fingerprint" ~ '^lv(rosterexec|standingcutoff):v1:[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "payment_operation_roster_snapshots" ADD CONSTRAINT "payment_operation_roster_snapshots_quote_fingerprint_check" CHECK (("payment_operation_roster_snapshots"."quote_fingerprint" IS NULL AND "payment_operation_roster_snapshots"."snapshot_kind" = 'standing_autopay') OR ("payment_operation_roster_snapshots"."quote_fingerprint" ~ '^lvrosterquote:v1:[0-9a-f]{64}$' AND "payment_operation_roster_snapshots"."snapshot_kind" = 'interactive'));--> statement-breakpoint
ALTER TABLE "payment_operation_roster_snapshots" ADD CONSTRAINT "payment_operation_roster_snapshots_request_shape_check" CHECK (("payment_operation_roster_snapshots"."request_kind" = 'direct' AND "payment_operation_roster_snapshots"."line_items" = '[]'::jsonb AND "payment_operation_roster_snapshots"."provider_location_id" IS NULL OR "payment_operation_roster_snapshots"."request_kind" = 'order' AND jsonb_array_length("payment_operation_roster_snapshots"."line_items") BETWEEN 1 AND 25 AND "payment_operation_roster_snapshots"."provider_location_id" IS NOT NULL OR "payment_operation_roster_snapshots"."request_kind" IS NULL AND "payment_operation_roster_snapshots"."line_items" = '[]'::jsonb AND "payment_operation_roster_snapshots"."provider_location_id" IS NULL));--> statement-breakpoint
ALTER TABLE "payment_operation_roster_snapshots" ADD CONSTRAINT "payment_operation_roster_snapshots_group_id_check" CHECK ("payment_operation_roster_snapshots"."combined_charge_group_id" IS NULL OR length("payment_operation_roster_snapshots"."combined_charge_group_id") > 0);--> statement-breakpoint
ALTER TABLE "payment_operation_roster_snapshots" ADD CONSTRAINT "payment_operation_roster_snapshots_amount_check" CHECK ("payment_operation_roster_snapshots"."amount_minor" > 0 AND "payment_operation_roster_snapshots"."currency" = 'USD' AND "payment_operation_roster_snapshots"."snapshot_version" = 2 AND "payment_operation_roster_snapshots"."snapshot_kind" IN ('interactive', 'standing_autopay') AND (("payment_operation_roster_snapshots"."snapshot_kind" = 'interactive' AND "payment_operation_roster_snapshots"."collection_mode" IS NULL AND "payment_operation_roster_snapshots"."cutoff_at" IS NULL AND "payment_operation_roster_snapshots"."request_kind" IN ('direct', 'order') AND "payment_operation_roster_snapshots"."encrypted_source_id" IS NOT NULL AND "payment_operation_roster_snapshots"."payer_bowler_id" IS NOT NULL AND "payment_operation_roster_snapshots"."source_kind" IN ('new_card', 'saved_card', 'wallet') AND "payment_operation_roster_snapshots"."quote_fingerprint" IS NOT NULL) OR ("payment_operation_roster_snapshots"."snapshot_kind" = 'standing_autopay' AND "payment_operation_roster_snapshots"."collection_mode" IN ('weekly', 'double_pay') AND "payment_operation_roster_snapshots"."cutoff_at" IS NOT NULL AND "payment_operation_roster_snapshots"."request_kind" IS NULL AND "payment_operation_roster_snapshots"."encrypted_source_id" IS NULL AND "payment_operation_roster_snapshots"."payer_bowler_id" IS NULL AND "payment_operation_roster_snapshots"."source_kind" IS NULL AND "payment_operation_roster_snapshots"."quote_fingerprint" IS NULL)));
