CREATE TABLE "interactive_payment_operation_allocations" (
	"operation_id" uuid NOT NULL,
	"allocation_index" integer NOT NULL,
	"bowler_id" integer NOT NULL,
	"amount_minor" integer NOT NULL,
	"lineage_amount_minor" integer,
	"prize_fund_amount_minor" integer,
	"week_of" timestamp NOT NULL,
	"notes" text,
	"paid_by_user_id" integer,
	CONSTRAINT "interactive_payment_operation_allocations_pk" PRIMARY KEY("operation_id","allocation_index"),
	CONSTRAINT "interactive_payment_operation_allocations_amount_check" CHECK ("interactive_payment_operation_allocations"."allocation_index" >= 0 AND "interactive_payment_operation_allocations"."amount_minor" > 0
      AND ("interactive_payment_operation_allocations"."lineage_amount_minor" IS NULL OR "interactive_payment_operation_allocations"."lineage_amount_minor" >= 0)
      AND ("interactive_payment_operation_allocations"."prize_fund_amount_minor" IS NULL OR "interactive_payment_operation_allocations"."prize_fund_amount_minor" >= 0))
);
--> statement-breakpoint
CREATE TABLE "interactive_payment_operation_line_items" (
	"operation_id" uuid NOT NULL,
	"line_item_index" integer NOT NULL,
	"catalog_object_id" varchar(255) NOT NULL,
	"quantity" varchar(32) NOT NULL,
	CONSTRAINT "interactive_payment_operation_line_items_pk" PRIMARY KEY("operation_id","line_item_index"),
	CONSTRAINT "interactive_payment_operation_line_items_value_check" CHECK ("interactive_payment_operation_line_items"."line_item_index" >= 0
      AND length("interactive_payment_operation_line_items"."catalog_object_id") > 0
      AND "interactive_payment_operation_line_items"."quantity" ~ '^[1-9][0-9]*$')
);
--> statement-breakpoint
CREATE TABLE "interactive_payment_operation_snapshots" (
	"operation_id" uuid PRIMARY KEY NOT NULL,
	"snapshot_version" integer DEFAULT 1 NOT NULL,
	"snapshot_fingerprint" varchar(80) NOT NULL,
	"league_id" integer NOT NULL,
	"location_id" integer,
	"provider_location_id" varchar(255),
	"payer_bowler_id" integer NOT NULL,
	"request_kind" text NOT NULL,
	"encrypted_source_id" text NOT NULL,
	"encrypted_customer_id" text,
	"encrypted_buyer_email" text,
	"store_card" boolean DEFAULT false NOT NULL,
	"week_of" timestamp NOT NULL,
	"combined_charge_group_id" varchar(128),
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "interactive_payment_snapshots_version_check" CHECK ("interactive_payment_operation_snapshots"."snapshot_version" = 1),
	CONSTRAINT "interactive_payment_snapshots_fingerprint_check" CHECK ("interactive_payment_operation_snapshots"."snapshot_fingerprint" ~ '^lvpayexecic:v1:[0-9a-f]{64}$'),
	CONSTRAINT "interactive_payment_snapshots_request_kind_check" CHECK ("interactive_payment_operation_snapshots"."request_kind" IN ('direct', 'order')),
	CONSTRAINT "interactive_payment_snapshots_group_id_check" CHECK ("interactive_payment_operation_snapshots"."combined_charge_group_id" IS NULL OR length("interactive_payment_operation_snapshots"."combined_charge_group_id") > 0)
);
--> statement-breakpoint
ALTER TABLE "interactive_payment_operation_allocations" ADD CONSTRAINT "interactive_payment_operation_allocations_operation_id_payment_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."payment_operations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_payment_operation_allocations" ADD CONSTRAINT "interactive_payment_operation_allocations_bowler_id_bowlers_id_fk" FOREIGN KEY ("bowler_id") REFERENCES "public"."bowlers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_payment_operation_allocations" ADD CONSTRAINT "interactive_payment_operation_allocations_paid_by_user_id_users_id_fk" FOREIGN KEY ("paid_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_payment_operation_line_items" ADD CONSTRAINT "interactive_payment_operation_line_items_operation_id_payment_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."payment_operations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_payment_operation_snapshots" ADD CONSTRAINT "interactive_payment_operation_snapshots_operation_id_payment_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."payment_operations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_payment_operation_snapshots" ADD CONSTRAINT "interactive_payment_operation_snapshots_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_payment_operation_snapshots" ADD CONSTRAINT "interactive_payment_operation_snapshots_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactive_payment_operation_snapshots" ADD CONSTRAINT "interactive_payment_operation_snapshots_payer_bowler_id_bowlers_id_fk" FOREIGN KEY ("payer_bowler_id") REFERENCES "public"."bowlers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "interactive_payment_operation_allocations_bowler_unique" ON "interactive_payment_operation_allocations" USING btree ("operation_id","bowler_id");--> statement-breakpoint
CREATE INDEX "interactive_payment_snapshots_league_idx" ON "interactive_payment_operation_snapshots" USING btree ("league_id");--> statement-breakpoint
CREATE INDEX "interactive_payment_snapshots_payer_idx" ON "interactive_payment_operation_snapshots" USING btree ("payer_bowler_id");--> statement-breakpoint
CREATE FUNCTION enforce_interactive_payment_allocation_total() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	expected_amount integer;
	actual_amount bigint;
	operation_uuid uuid := COALESCE(NEW.operation_id, OLD.operation_id);
BEGIN
	SELECT po.amount_minor
	INTO expected_amount
	FROM payment_operations po
	INNER JOIN interactive_payment_operation_snapshots snapshot
		ON snapshot.operation_id = po.id
	WHERE po.id = operation_uuid
	  AND po.operation_type = 'interactive_charge'
	  AND po.target_key LIKE 'interactive-charge:%';

	IF expected_amount IS NULL THEN
		RETURN NULL;
	END IF;

	SELECT COALESCE(SUM(amount_minor), 0)
	INTO actual_amount
	FROM interactive_payment_operation_allocations
	WHERE operation_id = operation_uuid;

	IF actual_amount <> expected_amount THEN
		RAISE EXCEPTION 'interactive payment allocation total must equal operation amount for %', operation_uuid
			USING ERRCODE = '23514';
	END IF;
	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER interactive_payment_snapshots_allocation_total
AFTER INSERT OR UPDATE OR DELETE ON interactive_payment_operation_snapshots
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_interactive_payment_allocation_total();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER interactive_payment_allocations_total
AFTER INSERT OR UPDATE OR DELETE ON interactive_payment_operation_allocations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_interactive_payment_allocation_total();
