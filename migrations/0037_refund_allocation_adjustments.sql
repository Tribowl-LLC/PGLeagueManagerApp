CREATE TABLE "refund_allocation_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"refund_operation_id" uuid NOT NULL,
	"source_allocation_id" uuid NOT NULL,
	"amount_minor" integer NOT NULL,
	"disposition" text NOT NULL,
	"snapshot_fingerprint" varchar(80) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refund_allocation_adjustments_amount_check" CHECK ("refund_allocation_adjustments"."amount_minor" > 0),
	CONSTRAINT "refund_allocation_adjustments_disposition_check" CHECK ("refund_allocation_adjustments"."disposition" IN ('still_owed', 'waived')),
	CONSTRAINT "refund_allocation_adjustments_fingerprint_check" CHECK ("refund_allocation_adjustments"."snapshot_fingerprint" ~ '^lvpayexecrf:v2:[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "refund_payment_operation_snapshots" DROP CONSTRAINT "refund_payment_operation_snapshots_version_check";--> statement-breakpoint
ALTER TABLE "refund_payment_operation_snapshots" DROP CONSTRAINT "refund_payment_operation_snapshots_fingerprint_check";--> statement-breakpoint
ALTER TABLE "refund_payment_operation_snapshots" ALTER COLUMN "snapshot_version" SET DEFAULT 2;--> statement-breakpoint
ALTER TABLE "refund_payment_operation_snapshots" ADD COLUMN "disposition" text;--> statement-breakpoint
ALTER TABLE "refund_payment_operation_snapshots" ADD COLUMN "allocation_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "refund_allocation_adjustments" ADD CONSTRAINT "refund_allocation_adjustments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_allocation_adjustments" ADD CONSTRAINT "refund_allocation_adjustments_league_tenant_fk" FOREIGN KEY ("league_id","organization_id") REFERENCES "public"."leagues"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_allocation_adjustments" ADD CONSTRAINT "refund_allocation_adjustments_operation_fk" FOREIGN KEY ("refund_operation_id","organization_id","league_id") REFERENCES "public"."payment_operations"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_allocation_adjustments" ADD CONSTRAINT "refund_allocation_adjustments_allocation_fk" FOREIGN KEY ("source_allocation_id","organization_id","league_id") REFERENCES "public"."payment_allocations"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "refund_allocation_adjustments_operation_allocation_unique" ON "refund_allocation_adjustments" USING btree ("organization_id","league_id","refund_operation_id","source_allocation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_allocation_adjustments_source_allocation_unique" ON "refund_allocation_adjustments" USING btree ("organization_id","league_id","source_allocation_id");--> statement-breakpoint
ALTER TABLE "refund_payment_operation_snapshots" ADD CONSTRAINT "refund_payment_operation_snapshots_disposition_check" CHECK (("refund_payment_operation_snapshots"."snapshot_version" = 1 AND "refund_payment_operation_snapshots"."disposition" IS NULL) OR ("refund_payment_operation_snapshots"."snapshot_version" = 2 AND "refund_payment_operation_snapshots"."disposition" IS NOT NULL AND "refund_payment_operation_snapshots"."disposition" IN ('still_owed', 'waived')));--> statement-breakpoint
ALTER TABLE "refund_payment_operation_snapshots" ADD CONSTRAINT "refund_payment_operation_snapshots_allocation_snapshot_check" CHECK (jsonb_typeof("refund_payment_operation_snapshots"."allocation_snapshot") = 'array' AND ("refund_payment_operation_snapshots"."snapshot_version" = 1 OR jsonb_array_length("refund_payment_operation_snapshots"."allocation_snapshot") > 0));--> statement-breakpoint
ALTER TABLE "refund_payment_operation_snapshots" ADD CONSTRAINT "refund_payment_operation_snapshots_version_check" CHECK ("refund_payment_operation_snapshots"."snapshot_version" IN (1, 2));--> statement-breakpoint
ALTER TABLE "refund_payment_operation_snapshots" ADD CONSTRAINT "refund_payment_operation_snapshots_fingerprint_check" CHECK (("refund_payment_operation_snapshots"."snapshot_version" = 1 AND "refund_payment_operation_snapshots"."snapshot_fingerprint" ~ '^lvpayexecrf:v1:[0-9a-f]{64}$') OR ("refund_payment_operation_snapshots"."snapshot_version" = 2 AND "refund_payment_operation_snapshots"."snapshot_fingerprint" ~ '^lvpayexecrf:v2:[0-9a-f]{64}$'));--> statement-breakpoint
-- Refund effects are sidecar evidence. Retained allocation rows still
-- conserve each tender exactly, while an affected obligation's effective
-- allocation total excludes the exact refunded source amounts.
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
-- Preserve the existing append-only transition fence while allowing a
-- settled obligation to reopen after a confirmed still-owed refund. A
-- waiver remains capacity already consumed and therefore cannot reopen it.
CREATE OR REPLACE FUNCTION roster_payment_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
$$;--> statement-breakpoint
CREATE FUNCTION refund_allocation_adjustments_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('leaguevault.organization_teardown', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'refund allocation adjustment evidence is append-only';
END;
$$;--> statement-breakpoint
CREATE TRIGGER refund_allocation_adjustments_append_only
BEFORE UPDATE OR DELETE ON refund_allocation_adjustments
FOR EACH ROW EXECUTE FUNCTION refund_allocation_adjustments_append_only_guard();--> statement-breakpoint
-- Snapshot authorization and allocation evidence are immutable once the
-- refund operation has been prepared. Organization teardown is the only
-- controlled cascade that may remove these rows.
CREATE FUNCTION refund_payment_operation_snapshot_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('leaguevault.organization_teardown', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'refund payment operation snapshot evidence is append-only';
END;
$$;--> statement-breakpoint
CREATE TRIGGER refund_payment_operation_snapshot_append_only
BEFORE UPDATE OR DELETE ON refund_payment_operation_snapshots
FOR EACH ROW EXECUTE FUNCTION refund_payment_operation_snapshot_append_only_guard();--> statement-breakpoint
-- An adjustment is valid only after the provider-confirmed refund state and
-- the exact v2 snapshot member are visible in the same transaction. This is
-- deferred because finalization inserts the adjustment before it marks the
-- operation succeeded.
CREATE FUNCTION refund_allocation_adjustment_provenance_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  operation_row record;
  allocation_row record;
  payment_row record;
  snapshot_row record;
BEGIN
  SELECT operation_type, status, provider_object_id
    INTO operation_row
    FROM payment_operations
   WHERE id = NEW.refund_operation_id
     AND organization_id = NEW.organization_id
     AND league_id = NEW.league_id;
  IF operation_row IS NULL
     OR operation_row.operation_type <> 'refund'
     OR operation_row.status <> 'succeeded'
     OR operation_row.provider_object_id IS NULL
  THEN
    RAISE EXCEPTION 'refund adjustment requires a succeeded provider-confirmed refund operation';
  END IF;

  SELECT id, payment_id, obligation_id, amount_minor, currency
    INTO allocation_row
    FROM payment_allocations
   WHERE id = NEW.source_allocation_id
     AND organization_id = NEW.organization_id
     AND league_id = NEW.league_id;
  IF allocation_row IS NULL OR allocation_row.amount_minor <> NEW.amount_minor THEN
    RAISE EXCEPTION 'refund adjustment does not match its source allocation amount';
  END IF;

  SELECT status, square_refund_id
    INTO payment_row
    FROM payments
   WHERE id = allocation_row.payment_id
     AND organization_id = NEW.organization_id
     AND league_id = NEW.league_id;
  IF payment_row IS NULL
     OR payment_row.status <> 'refunded'
     OR payment_row.square_refund_id IS NULL
     OR payment_row.square_refund_id <> operation_row.provider_object_id
  THEN
    RAISE EXCEPTION 'refund adjustment requires the refunded source payment and provider identity';
  END IF;

  SELECT snapshot_version, payment_id, league_id, disposition,
         snapshot_fingerprint, allocation_snapshot
    INTO snapshot_row
    FROM refund_payment_operation_snapshots
   WHERE operation_id = NEW.refund_operation_id;
  IF snapshot_row IS NULL
     OR snapshot_row.snapshot_version <> 2
     OR snapshot_row.payment_id <> allocation_row.payment_id
     OR snapshot_row.league_id <> NEW.league_id
     OR snapshot_row.disposition <> NEW.disposition
     OR snapshot_row.snapshot_fingerprint <> NEW.snapshot_fingerprint
     OR NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements(snapshot_row.allocation_snapshot) member
        WHERE member->>'allocationId' = NEW.source_allocation_id::text
          AND member->>'obligationId' = allocation_row.obligation_id::text
          AND member->>'amountMinor' = allocation_row.amount_minor::text
          AND member->>'currency' = allocation_row.currency
     )
  THEN
    RAISE EXCEPTION 'refund adjustment does not match its immutable v2 refund snapshot';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER refund_allocation_adjustment_provenance
AFTER INSERT ON refund_allocation_adjustments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION refund_allocation_adjustment_provenance_guard();--> statement-breakpoint
