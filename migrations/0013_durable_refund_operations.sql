CREATE TABLE "refund_payment_operation_snapshots" (
	"operation_id" uuid PRIMARY KEY NOT NULL,
	"snapshot_version" integer DEFAULT 1 NOT NULL,
	"snapshot_fingerprint" varchar(80) NOT NULL,
	"payment_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"location_id" integer,
	"encrypted_provider_payment_id" text NOT NULL,
	"reason" varchar(192) NOT NULL,
	"requested_reason" varchar(192),
	"requested_by_user_id" integer NOT NULL,
	"requested_by_role" varchar(32) NOT NULL,
	"requested_by_organization_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "refund_payment_operation_snapshots_version_check" CHECK ("refund_payment_operation_snapshots"."snapshot_version" = 1),
	CONSTRAINT "refund_payment_operation_snapshots_fingerprint_check" CHECK ("refund_payment_operation_snapshots"."snapshot_fingerprint" ~ '^lvpayexecrf:v1:[0-9a-f]{64}$'),
	CONSTRAINT "refund_payment_operation_snapshots_actor_check" CHECK ("refund_payment_operation_snapshots"."requested_by_user_id" > 0
      AND "refund_payment_operation_snapshots"."requested_by_role" IN ('org_admin', 'system_admin')
      AND ("refund_payment_operation_snapshots"."requested_by_organization_id" IS NULL OR "refund_payment_operation_snapshots"."requested_by_organization_id" > 0)),
	CONSTRAINT "refund_payment_operation_snapshots_reason_check" CHECK (length("refund_payment_operation_snapshots"."reason") BETWEEN 1 AND 192 AND btrim("refund_payment_operation_snapshots"."reason") = "refund_payment_operation_snapshots"."reason"),
	CONSTRAINT "refund_payment_operation_snapshots_requested_reason_check" CHECK ("refund_payment_operation_snapshots"."requested_reason" IS NULL OR (
      length("refund_payment_operation_snapshots"."requested_reason") BETWEEN 1 AND 192
      AND btrim("refund_payment_operation_snapshots"."requested_reason") = "refund_payment_operation_snapshots"."requested_reason"
    ))
);
--> statement-breakpoint
ALTER TABLE "refund_payment_operation_snapshots" ADD CONSTRAINT "refund_payment_operation_snapshots_operation_id_payment_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."payment_operations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_payment_operation_snapshots" ADD CONSTRAINT "refund_payment_operation_snapshots_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_payment_operation_snapshots" ADD CONSTRAINT "refund_payment_operation_snapshots_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_payment_operation_snapshots" ADD CONSTRAINT "refund_payment_operation_snapshots_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "refund_payment_operation_snapshots_payment_unique" ON "refund_payment_operation_snapshots" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "refund_payment_operation_snapshots_league_idx" ON "refund_payment_operation_snapshots" USING btree ("league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_operations_refund_target_unique" ON "payment_operations" USING btree ("organization_id","target_key") WHERE "payment_operations"."operation_type" = 'refund';