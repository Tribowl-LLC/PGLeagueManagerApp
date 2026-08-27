-- 0035 is a clean-slate contract boundary. Production is expected to have
-- no payment evidence. Do not infer, backfill, or destructively reshape a
-- live ledger: fail before any DDL if the precondition is not true.
DO $$
DECLARE
  required_table text;
BEGIN
  FOREACH required_table IN ARRAY ARRAY[
    'payments', 'payment_allocations', 'payment_operations',
    'payment_operation_roster_snapshots', 'payment_operation_roster_snapshot_items',
    'payment_operation_standing_autopay_bindings',
    'payment_operation_standing_autopay_participants', 'autopay_consents',
    'autopay_consent_partners', 'financial_commands',
    'refund_payment_operation_snapshots', 'payment_disputes',
    'payment_dispute_notifications', 'payment_dispute_replay_audits',
    'webhook_events'
  ] LOOP
    IF to_regclass('public.' || required_table) IS NULL THEN
      RAISE EXCEPTION '0035 refused: expected canonical table % is missing', required_table;
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
LOCK TABLE autopay_consent_partners, autopay_consents,
  financial_commands, payment_allocations, payment_dispute_notifications,
  payment_dispute_replay_audits, payment_disputes,
  payment_operation_roster_snapshot_items, payment_operation_roster_snapshots,
  payment_operation_standing_autopay_bindings,
  payment_operation_standing_autopay_participants, payment_operations, payments,
  refund_payment_operation_snapshots, webhook_events
  IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM payments)
    OR EXISTS (SELECT 1 FROM payment_allocations)
    OR EXISTS (SELECT 1 FROM payment_operations)
    OR EXISTS (SELECT 1 FROM payment_operation_roster_snapshots)
    OR EXISTS (SELECT 1 FROM payment_operation_roster_snapshot_items)
    OR EXISTS (SELECT 1 FROM payment_operation_standing_autopay_bindings)
    OR EXISTS (SELECT 1 FROM payment_operation_standing_autopay_participants)
    OR EXISTS (SELECT 1 FROM autopay_consents)
    OR EXISTS (SELECT 1 FROM autopay_consent_partners)
    OR EXISTS (SELECT 1 FROM financial_commands)
    OR EXISTS (SELECT 1 FROM refund_payment_operation_snapshots)
    OR EXISTS (SELECT 1 FROM payment_disputes)
    OR EXISTS (SELECT 1 FROM payment_dispute_notifications)
    OR EXISTS (SELECT 1 FROM payment_dispute_replay_audits)
    OR EXISTS (SELECT 1 FROM webhook_events WHERE provider_payment_id IS NOT NULL
      OR lower(provider_object_type) ~ '(payment|refund|dispute)'
      OR lower(event_type) ~ '(payment|refund|dispute)')
  THEN
    RAISE EXCEPTION '0035 refused: payment/provider evidence exists; no destructive reshaping or backfill is allowed';
  END IF;
  IF to_regclass('public.payment_voids') IS NOT NULL
    OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'payments' AND column_name IN ('organization_id', 'currency'))
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'payments' AND column_name IN ('lineage_amount', 'prize_fund_amount', 'week_of', 'combined_charge_group_id', 'payment_operation_allocation_index') GROUP BY table_schema, table_name HAVING count(*) = 5)
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'payment_allocations' AND column_name IN ('supersedes_allocation_id', 'correction_reason') GROUP BY table_schema, table_name HAVING count(*) = 2)
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'payment_operation_roster_snapshots' AND column_name = 'combined_charge_group_id')
    OR to_regclass('public.payments_week_of_idx') IS NULL
    OR to_regclass('public.payments_combined_group_idx') IS NULL
    OR to_regclass('public.payments_operation_allocation_unique') IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payments'::regclass AND conname = 'payments_payment_operation_link_check')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payments'::regclass AND conname = 'payments_bowler_id_bowlers_id_fk')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payments'::regclass AND conname = 'payments_league_id_leagues_id_fk')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payment_allocations'::regclass AND conname = 'payment_allocations_state_check')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payment_allocations'::regclass AND conname = 'payment_allocations_payment_fk')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payment_allocations'::regclass AND conname = 'payment_allocations_supersedes_fk')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payment_operation_roster_snapshots'::regclass AND conname = 'payment_operation_roster_snapshots_group_id_check')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.payment_allocations'::regclass AND tgname = 'payment_allocations_append_only')
    OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'roster_payment_append_only_guard')
  THEN
    RAISE EXCEPTION '0035 refused: expected legacy payment schema boundary is missing; no partial reshape is allowed';
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE "payment_voids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"payment_id" integer NOT NULL,
	"reason" text NOT NULL,
	"recorded_by_user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_voids_reason_check" CHECK (length(btrim("payment_voids"."reason")) BETWEEN 1 AND 500)
);
--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_payment_operation_link_check";--> statement-breakpoint
ALTER TABLE "payment_allocations" DROP CONSTRAINT "payment_allocations_state_check";--> statement-breakpoint
ALTER TABLE "payment_operation_roster_snapshots" DROP CONSTRAINT "payment_operation_roster_snapshots_group_id_check";--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_bowler_id_bowlers_id_fk";
--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_league_id_leagues_id_fk";
--> statement-breakpoint
ALTER TABLE "payment_allocations" DROP CONSTRAINT "payment_allocations_supersedes_fk";
--> statement-breakpoint
ALTER TABLE "payment_allocations" DROP CONSTRAINT "payment_allocations_payment_fk";
--> statement-breakpoint
DROP INDEX "payments_week_of_idx";--> statement-breakpoint
DROP INDEX "payments_combined_group_idx";--> statement-breakpoint
DROP INDEX "payments_operation_allocation_unique";--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "organization_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "currency" text DEFAULT 'USD' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_voids" ADD CONSTRAINT "payment_voids_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_voids" ADD CONSTRAINT "payment_voids_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_voids" ADD CONSTRAINT "payment_voids_league_tenant_fk" FOREIGN KEY ("league_id","organization_id") REFERENCES "public"."leagues"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_voids_tenant_identity_unique" ON "payment_voids" USING btree ("id","organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_voids_payment_unique" ON "payment_voids" USING btree ("organization_id","league_id","payment_id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_league_tenant_fk" FOREIGN KEY ("league_id","organization_id") REFERENCES "public"."leagues"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_payment_operation_tenant_fk" FOREIGN KEY ("payment_operation_id","organization_id","league_id") REFERENCES "public"."payment_operations"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_bowler_tenant_fk" FOREIGN KEY ("bowler_id","organization_id") REFERENCES "public"."bowlers"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_tenant_identity_unique" ON "payments" USING btree ("id","organization_id","league_id");--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_fk" FOREIGN KEY ("payment_id","organization_id","league_id") REFERENCES "public"."payments"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_voids" ADD CONSTRAINT "payment_voids_payment_fk" FOREIGN KEY ("payment_id","organization_id","league_id") REFERENCES "public"."payments"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_operation_unique" ON "payments" USING btree ("payment_operation_id") WHERE "payments"."payment_operation_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_allocations_payment_obligation_unique" ON "payment_allocations" USING btree ("organization_id","league_id","payment_id","obligation_id");--> statement-breakpoint
ALTER TABLE "payments" DROP COLUMN "lineage_amount";--> statement-breakpoint
ALTER TABLE "payments" DROP COLUMN "prize_fund_amount";--> statement-breakpoint
ALTER TABLE "payments" DROP COLUMN "week_of";--> statement-breakpoint
ALTER TABLE "payments" DROP COLUMN "combined_charge_group_id";--> statement-breakpoint
ALTER TABLE "payments" DROP COLUMN "payment_operation_allocation_index";--> statement-breakpoint
ALTER TABLE "payment_allocations" DROP COLUMN "supersedes_allocation_id";--> statement-breakpoint
ALTER TABLE "payment_allocations" DROP COLUMN "correction_reason";--> statement-breakpoint
ALTER TABLE "payment_operation_roster_snapshots" DROP COLUMN "combined_charge_group_id";--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_check" CHECK ("payments"."amount" > 0);--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_currency_check" CHECK ("payments"."currency" = 'USD');--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_state_check" CHECK ("payment_allocations"."state" IN ('active', 'voided'));
--> statement-breakpoint
-- A canonical parent is one real tender. At the deferred commit boundary its
-- child allocations must conserve the exact gross amount.
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
  allocation_total integer;
  has_void boolean;
  obligation_row record;
  obligation_total integer;
BEGIN
  -- Trigger records have different shapes on payments, payment_voids, and
  -- payment_allocations. Read the discriminator fields through JSON so this
  -- single deferred function never dereferences a field absent on the firing
  -- table.
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
  SELECT count(*), count(*) FILTER (WHERE state = 'active'),
         count(*) FILTER (WHERE state = 'voided'),
         COALESCE(sum(amount_minor), 0)
    INTO allocation_count, active_count, voided_count, allocation_total
    FROM payment_allocations
   WHERE payment_id = parent_payment_id;
  IF allocation_count = 0 THEN
    RAISE EXCEPTION 'payment % must have at least one allocation', parent_payment_id;
  END IF;
  IF allocation_total <> parent_amount THEN
    RAISE EXCEPTION 'payment allocation total (%) must equal parent payment amount (%)', allocation_total, parent_amount;
  END IF;
  -- Lock every obligation touched by this parent in canonical identity order
  -- and compare against all active allocations, including prior tenders.
  -- This prevents two separate payments from each consuming the same balance
  -- under concurrent finalization.
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
    SELECT COALESCE(SUM(pa.amount_minor), 0)
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
  IF has_void THEN
    IF parent_status <> 'voided' OR active_count <> 0 OR voided_count <> allocation_count THEN
      RAISE EXCEPTION 'voided payment % must have all allocations voided', parent_payment_id;
    END IF;
  ELSIF parent_status = 'voided' OR active_count <> allocation_count THEN
    RAISE EXCEPTION 'active payment % must have all allocations active', parent_payment_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
--> statement-breakpoint
DROP TRIGGER payment_allocations_conservation ON payment_allocations;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payment_allocations_conservation
AFTER INSERT OR UPDATE ON payment_allocations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION roster_payment_allocation_conservation_guard();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payments_allocation_conservation
AFTER INSERT OR UPDATE ON payments
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION roster_payment_allocation_conservation_guard();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER payment_voids_allocation_conservation
AFTER INSERT ON payment_voids
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION roster_payment_allocation_conservation_guard();
--> statement-breakpoint
CREATE FUNCTION payment_voids_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('leaguevault.organization_teardown', true) = 'on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'payment void evidence is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_voids_append_only BEFORE UPDATE OR DELETE ON payment_voids
FOR EACH ROW EXECUTE FUNCTION payment_voids_append_only_guard();
--> statement-breakpoint
-- The pre-0035 append-only trigger function references the allocation
-- correction/supersession columns that were removed above. Preserve that
-- function for the other evidence tables, then bind only the allocation
-- trigger to a shape-aware replacement before any post-migration writes occur.
--> statement-breakpoint
CREATE FUNCTION payment_allocations_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('leaguevault.organization_teardown', true) = 'on' THEN
    RETURN OLD;
  END IF;
  IF OLD.state = 'active' AND NEW.state = 'voided'
    AND ROW(NEW.id, NEW.organization_id, NEW.league_id, NEW.payment_id,
            NEW.obligation_id, NEW.amount_minor, NEW.currency,
            NEW.recorded_by_user_id, NEW.created_at)
        IS NOT DISTINCT FROM
        ROW(OLD.id, OLD.organization_id, OLD.league_id, OLD.payment_id,
            OLD.obligation_id, OLD.amount_minor, OLD.currency,
            OLD.recorded_by_user_id, OLD.created_at) THEN
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.organization_id, NEW.league_id, NEW.payment_id,
         NEW.obligation_id, NEW.amount_minor, NEW.currency, NEW.state,
         NEW.recorded_by_user_id, NEW.created_at)
      IS NOT DISTINCT FROM
      ROW(OLD.id, OLD.organization_id, OLD.league_id, OLD.payment_id,
         OLD.obligation_id, OLD.amount_minor, OLD.currency, OLD.state,
         OLD.recorded_by_user_id, OLD.created_at) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'roster payment evidence is append-only';
END;
$$;
--> statement-breakpoint
DROP TRIGGER payment_allocations_append_only ON payment_allocations;
--> statement-breakpoint
CREATE TRIGGER payment_allocations_append_only BEFORE UPDATE OR DELETE ON payment_allocations FOR EACH ROW EXECUTE FUNCTION payment_allocations_append_only_guard();
