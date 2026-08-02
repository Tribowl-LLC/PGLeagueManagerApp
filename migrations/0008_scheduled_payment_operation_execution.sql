CREATE TABLE "scheduled_payment_operation_allocations" (
	"operation_id" uuid NOT NULL,
	"allocation_index" integer NOT NULL,
	"bowler_id" integer NOT NULL,
	"amount_minor" integer NOT NULL,
	"lineage_amount_minor" integer,
	"prize_fund_amount_minor" integer,
	"notes" text,
	"paid_by_user_id" integer,
	CONSTRAINT "scheduled_payment_operation_allocations_pk" PRIMARY KEY("operation_id","allocation_index"),
	CONSTRAINT "scheduled_payment_operation_allocations_amount_check" CHECK ("scheduled_payment_operation_allocations"."allocation_index" >= 0 AND "scheduled_payment_operation_allocations"."amount_minor" > 0
      AND ("scheduled_payment_operation_allocations"."lineage_amount_minor" IS NULL OR "scheduled_payment_operation_allocations"."lineage_amount_minor" >= 0)
      AND ("scheduled_payment_operation_allocations"."prize_fund_amount_minor" IS NULL OR "scheduled_payment_operation_allocations"."prize_fund_amount_minor" >= 0))
);
--> statement-breakpoint
CREATE TABLE "scheduled_payment_operation_line_items" (
	"operation_id" uuid NOT NULL,
	"line_item_index" integer NOT NULL,
	"catalog_object_id" varchar(255) NOT NULL,
	"quantity" varchar(32) NOT NULL,
	CONSTRAINT "scheduled_payment_operation_line_items_pk" PRIMARY KEY("operation_id","line_item_index"),
	CONSTRAINT "scheduled_payment_operation_line_items_value_check" CHECK ("scheduled_payment_operation_line_items"."line_item_index" >= 0
      AND length("scheduled_payment_operation_line_items"."catalog_object_id") > 0
      AND "scheduled_payment_operation_line_items"."quantity" ~ '^[1-9][0-9]*$')
);
--> statement-breakpoint
CREATE TABLE "scheduled_payment_operation_snapshots" (
	"operation_id" uuid PRIMARY KEY NOT NULL,
	"snapshot_version" integer DEFAULT 1 NOT NULL,
	"snapshot_fingerprint" varchar(80) NOT NULL,
	"league_id" integer NOT NULL,
	"location_id" integer,
	"provider_location_id" varchar(255),
	"request_kind" text NOT NULL,
	"encrypted_source_id" text NOT NULL,
	"encrypted_customer_id" text,
	"encrypted_buyer_email" text,
	"is_double_pay" boolean DEFAULT false NOT NULL,
	"deactivate_schedule_on_preparation" boolean DEFAULT false NOT NULL,
	"paid_in_full_threshold_amount_minor" integer,
	"season_start_at" timestamp,
	"season_end_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_payment_snapshots_version_check" CHECK ("scheduled_payment_operation_snapshots"."snapshot_version" = 1),
	CONSTRAINT "scheduled_payment_snapshots_fingerprint_check" CHECK ("scheduled_payment_operation_snapshots"."snapshot_fingerprint" ~ '^lvpayexec:v1:[0-9a-f]{64}$'),
	CONSTRAINT "scheduled_payment_snapshots_request_kind_check" CHECK ("scheduled_payment_operation_snapshots"."request_kind" IN ('direct', 'order')),
	CONSTRAINT "scheduled_payment_snapshots_paid_in_full_check" CHECK ("scheduled_payment_operation_snapshots"."paid_in_full_threshold_amount_minor" IS NULL OR "scheduled_payment_operation_snapshots"."paid_in_full_threshold_amount_minor" > 0),
	CONSTRAINT "scheduled_payment_snapshots_season_range_check" CHECK (("scheduled_payment_operation_snapshots"."season_start_at" IS NULL AND "scheduled_payment_operation_snapshots"."season_end_at" IS NULL)
      OR ("scheduled_payment_operation_snapshots"."season_start_at" IS NOT NULL AND "scheduled_payment_operation_snapshots"."season_end_at" IS NOT NULL AND "scheduled_payment_operation_snapshots"."season_end_at" > "scheduled_payment_operation_snapshots"."season_start_at"))
);
--> statement-breakpoint
ALTER TABLE "payment_operations" ADD COLUMN "provider_order_id" varchar(255);--> statement-breakpoint
ALTER TABLE "payment_operations" ADD COLUMN "lease_recovery_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD COLUMN "last_lease_recovered_at" timestamp;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "payment_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "payment_operation_allocation_index" integer;--> statement-breakpoint
ALTER TABLE "scheduled_payment_operation_allocations" ADD CONSTRAINT "scheduled_payment_operation_allocations_operation_id_payment_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."payment_operations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_payment_operation_allocations" ADD CONSTRAINT "scheduled_payment_operation_allocations_bowler_id_bowlers_id_fk" FOREIGN KEY ("bowler_id") REFERENCES "public"."bowlers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_payment_operation_allocations" ADD CONSTRAINT "scheduled_payment_operation_allocations_paid_by_user_id_users_id_fk" FOREIGN KEY ("paid_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_payment_operation_line_items" ADD CONSTRAINT "scheduled_payment_operation_line_items_operation_id_payment_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."payment_operations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_payment_operation_snapshots" ADD CONSTRAINT "scheduled_payment_operation_snapshots_operation_id_payment_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."payment_operations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_payment_operation_snapshots" ADD CONSTRAINT "scheduled_payment_operation_snapshots_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_payment_operation_snapshots" ADD CONSTRAINT "scheduled_payment_operation_snapshots_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_payment_operation_allocations_bowler_unique" ON "scheduled_payment_operation_allocations" USING btree ("operation_id","bowler_id");--> statement-breakpoint
CREATE INDEX "scheduled_payment_snapshots_location_idx" ON "scheduled_payment_operation_snapshots" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "scheduled_payment_snapshots_league_idx" ON "scheduled_payment_operation_snapshots" USING btree ("league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_operation_allocation_unique" ON "payments" USING btree ("payment_operation_id","payment_operation_allocation_index") WHERE "payments"."payment_operation_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_lease_recovery_count_check" CHECK ("payment_operations"."lease_recovery_count" >= 0);--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_payment_operation_link_check" CHECK (("payments"."payment_operation_id" IS NULL) = ("payments"."payment_operation_allocation_index" IS NULL));