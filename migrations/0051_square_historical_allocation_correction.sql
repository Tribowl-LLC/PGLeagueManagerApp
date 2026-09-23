CREATE TABLE "payment_allocation_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"payment_id" integer NOT NULL,
	"source_allocation_id" uuid NOT NULL,
	"replacement_allocation_id" uuid NOT NULL,
	"source_obligation_id" uuid NOT NULL,
	"target_obligation_id" uuid NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"reason" text NOT NULL,
	"recorded_by_user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_allocation_corrections_amount_check" CHECK ("payment_allocation_corrections"."amount_minor" > 0 AND "payment_allocation_corrections"."currency" = 'USD'),
	CONSTRAINT "payment_allocation_corrections_reason_check" CHECK (length(btrim("payment_allocation_corrections"."reason")) BETWEEN 1 AND 500),
	CONSTRAINT "payment_allocation_corrections_distinct_obligation_check" CHECK ("payment_allocation_corrections"."source_obligation_id" <> "payment_allocation_corrections"."target_obligation_id")
);
--> statement-breakpoint
ALTER TABLE "payment_allocation_corrections" ADD CONSTRAINT "payment_allocation_corrections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocation_corrections" ADD CONSTRAINT "payment_allocation_corrections_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocation_corrections" ADD CONSTRAINT "payment_allocation_corrections_league_tenant_fk" FOREIGN KEY ("league_id","organization_id") REFERENCES "public"."leagues"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocation_corrections" ADD CONSTRAINT "payment_allocation_corrections_payment_fk" FOREIGN KEY ("payment_id","organization_id","league_id") REFERENCES "public"."payments"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocation_corrections" ADD CONSTRAINT "payment_allocation_corrections_source_allocation_fk" FOREIGN KEY ("source_allocation_id","organization_id","league_id") REFERENCES "public"."payment_allocations"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocation_corrections" ADD CONSTRAINT "payment_allocation_corrections_replacement_allocation_fk" FOREIGN KEY ("replacement_allocation_id","organization_id","league_id") REFERENCES "public"."payment_allocations"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocation_corrections" ADD CONSTRAINT "payment_allocation_corrections_source_obligation_fk" FOREIGN KEY ("source_obligation_id","organization_id","league_id") REFERENCES "public"."payment_obligations"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocation_corrections" ADD CONSTRAINT "payment_allocation_corrections_target_obligation_fk" FOREIGN KEY ("target_obligation_id","organization_id","league_id") REFERENCES "public"."payment_obligations"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_allocation_corrections_tenant_identity_unique" ON "payment_allocation_corrections" USING btree ("id","organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_allocation_corrections_source_unique" ON "payment_allocation_corrections" USING btree ("organization_id","league_id","source_allocation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_allocation_corrections_replacement_unique" ON "payment_allocation_corrections" USING btree ("organization_id","league_id","replacement_allocation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_allocation_corrections_payment_target_unique" ON "payment_allocation_corrections" USING btree ("organization_id","league_id","payment_id","target_obligation_id");--> statement-breakpoint
CREATE INDEX "payment_allocation_corrections_payment_idx" ON "payment_allocation_corrections" USING btree ("organization_id","league_id","payment_id");--> statement-breakpoint
CREATE INDEX "payment_allocation_corrections_source_obligation_idx" ON "payment_allocation_corrections" USING btree ("organization_id","league_id","source_obligation_id");--> statement-breakpoint
CREATE INDEX "payment_allocation_corrections_target_obligation_idx" ON "payment_allocation_corrections" USING btree ("organization_id","league_id","target_obligation_id");
--> statement-breakpoint

-- The correction service reopens only the source obligation proved by the
-- same-parent Square correction. Preserve every existing append-only rule and
-- add that one evidence-backed transition to the guard.
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
            FROM payment_allocation_corrections correction
            JOIN payment_allocations source
              ON source.id = correction.source_allocation_id
             AND source.organization_id = correction.organization_id
             AND source.league_id = correction.league_id
            JOIN payment_allocations replacement
              ON replacement.id = correction.replacement_allocation_id
             AND replacement.organization_id = correction.organization_id
             AND replacement.league_id = correction.league_id
            JOIN payments parent
              ON parent.id = correction.payment_id
             AND parent.organization_id = correction.organization_id
             AND parent.league_id = correction.league_id
           WHERE correction.organization_id = NEW.organization_id
             AND correction.league_id = NEW.league_id
             AND correction.source_obligation_id = NEW.id
             AND correction.source_obligation_id = source.obligation_id
             AND source.state = 'voided'
             AND source.allocation_kind = 'ordinary'
             AND replacement.state = 'active'
             AND replacement.allocation_kind = 'ordinary'
             AND replacement.payment_id = parent.id
             AND parent.type = 'square'
             AND parent.status = 'paid'
             AND parent.payment_operation_id IS NOT NULL
             AND parent.provider_payment_id IS NOT NULL
             AND correction.amount_minor = source.amount_minor
             AND correction.amount_minor = replacement.amount_minor
             AND correction.currency = source.currency
             AND correction.currency = replacement.currency
        )
      )
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

--> statement-breakpoint

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
  active_allocation_total bigint;
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
         COALESCE(sum(amount_minor), 0),
         COALESCE(sum(amount_minor) FILTER (WHERE state = 'active'), 0)
    INTO allocation_count, active_count, voided_count, allocation_total, active_allocation_total
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
    IF has_void THEN
      IF allocation_total <> parent_amount THEN
        RAISE EXCEPTION 'voided payment allocation total (%) must equal parent payment amount (%)', allocation_total, parent_amount;
      END IF;
    ELSIF active_allocation_total <> parent_amount THEN
      RAISE EXCEPTION 'active payment allocation total (%) must equal parent payment amount (%)', active_allocation_total, parent_amount;
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
  ELSIF parent_status = 'voided' THEN
    RAISE EXCEPTION 'voided payment % must have payment void evidence', parent_payment_id;
  ELSIF active_count <> allocation_count THEN
    IF EXISTS (
      SELECT 1
        FROM payment_allocations source
        LEFT JOIN payment_allocation_corrections correction
          ON correction.source_allocation_id = source.id
         AND correction.organization_id = source.organization_id
         AND correction.league_id = source.league_id
         AND correction.payment_id = source.payment_id
        LEFT JOIN payment_allocations replacement
          ON replacement.id = correction.replacement_allocation_id
         AND replacement.organization_id = correction.organization_id
         AND replacement.league_id = correction.league_id
       WHERE source.payment_id = parent_payment_id
         AND source.state = 'voided'
         AND source.allocation_kind = 'ordinary'
         AND (correction.id IS NULL
           OR correction.amount_minor <> source.amount_minor
           OR correction.currency <> source.currency
           OR correction.source_obligation_id <> source.obligation_id
           OR replacement.id IS NULL
           OR replacement.payment_id <> parent_payment_id
           OR replacement.state <> 'active'
           OR replacement.allocation_kind <> 'ordinary'
           OR replacement.amount_minor <> source.amount_minor
           OR replacement.currency <> source.currency)
    ) THEN
      RAISE EXCEPTION 'active payment % has unproved voided allocation evidence', parent_payment_id;
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
--> statement-breakpoint

CREATE FUNCTION payment_allocation_correction_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_row record;
  replacement_row record;
  payment_row record;
BEGIN
  SELECT * INTO source_row FROM payment_allocations WHERE id = NEW.source_allocation_id FOR SHARE;
  SELECT * INTO replacement_row FROM payment_allocations WHERE id = NEW.replacement_allocation_id FOR SHARE;
  SELECT * INTO payment_row FROM payments WHERE id = NEW.payment_id FOR SHARE;
  IF source_row IS NULL OR replacement_row IS NULL OR payment_row IS NULL
    OR source_row.organization_id <> NEW.organization_id OR source_row.league_id <> NEW.league_id
    OR replacement_row.organization_id <> NEW.organization_id OR replacement_row.league_id <> NEW.league_id
    OR payment_row.organization_id <> NEW.organization_id OR payment_row.league_id <> NEW.league_id
    OR source_row.payment_id <> NEW.payment_id OR replacement_row.payment_id <> NEW.payment_id
    OR source_row.state <> 'voided' OR source_row.allocation_kind <> 'ordinary'
    OR replacement_row.state <> 'active' OR replacement_row.allocation_kind <> 'ordinary'
    OR source_row.obligation_id <> NEW.source_obligation_id
    OR replacement_row.obligation_id <> NEW.target_obligation_id
    OR source_row.amount_minor <> NEW.amount_minor OR replacement_row.amount_minor <> NEW.amount_minor
    OR source_row.currency <> NEW.currency OR replacement_row.currency <> NEW.currency
    OR NEW.source_obligation_id = NEW.target_obligation_id
    OR payment_row.type <> 'square' OR payment_row.status <> 'paid'
    OR payment_row.payment_operation_id IS NULL OR payment_row.provider_payment_id IS NULL
  THEN
    RAISE EXCEPTION 'historical Square allocation correction evidence does not match its rows';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE FUNCTION payment_allocation_corrections_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('leaguevault.organization_teardown', true) = 'on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'historical Square allocation correction evidence is append-only';
END;
$$;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER payment_allocation_correction_identity
AFTER INSERT ON payment_allocation_corrections
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION payment_allocation_correction_identity_guard();
--> statement-breakpoint
CREATE TRIGGER payment_allocation_corrections_append_only
BEFORE UPDATE OR DELETE ON payment_allocation_corrections FOR EACH ROW
EXECUTE FUNCTION payment_allocation_corrections_append_only_guard();
