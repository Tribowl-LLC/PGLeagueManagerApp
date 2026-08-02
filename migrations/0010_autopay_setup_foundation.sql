CREATE TABLE "autopay_setup_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"payer_bowler_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"workflow_status" text DEFAULT 'pending' NOT NULL,
	"quote_fingerprint" varchar(84) NOT NULL,
	"request_fingerprint" varchar(84) NOT NULL,
	"payment_operation_id" uuid,
	"payment_schedule_id" integer,
	"encrypted_source_id" text NOT NULL,
	"encrypted_customer_id" text,
	"encrypted_buyer_email" text,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"canceled_at" timestamp,
	CONSTRAINT "autopay_setup_requests_workflow_status_check" CHECK ("autopay_setup_requests"."workflow_status" IN ('pending', 'completed', 'canceled')),
	CONSTRAINT "autopay_setup_requests_quote_fingerprint_check" CHECK ("autopay_setup_requests"."quote_fingerprint" ~ '^lvautopayquote:v1:[0-9a-f]{64}$'),
	CONSTRAINT "autopay_setup_requests_request_fingerprint_check" CHECK ("autopay_setup_requests"."request_fingerprint" ~ '^lvautopaysetup:v1:[0-9a-f]{64}$'),
	CONSTRAINT "autopay_setup_requests_snapshot_shape_check" CHECK (jsonb_typeof("autopay_setup_requests"."snapshot") = 'object'
      AND "autopay_setup_requests"."snapshot"->>'snapshotVersion' = '1'
      AND ("autopay_setup_requests"."snapshot"->>'immediateAmountMinor') ~ '^[0-9]+$'
      AND ("autopay_setup_requests"."snapshot"->>'firstAutomaticAmountMinor') ~ '^[0-9]+$'
      AND ("autopay_setup_requests"."snapshot"->>'recurringAmountMinor') ~ '^[1-9][0-9]*$'),
	CONSTRAINT "autopay_setup_requests_immediate_operation_check" CHECK (CASE
      WHEN ("autopay_setup_requests"."snapshot"->>'immediateAmountMinor') ~ '^[0-9]+$'
      THEN (
        (("autopay_setup_requests"."snapshot"->>'immediateAmountMinor')::integer = 0 AND "autopay_setup_requests"."payment_operation_id" IS NULL)
        OR (("autopay_setup_requests"."snapshot"->>'immediateAmountMinor')::integer > 0 AND "autopay_setup_requests"."payment_operation_id" IS NOT NULL)
      )
      ELSE false
    END),
	CONSTRAINT "autopay_setup_requests_workflow_timestamp_check" CHECK ((
      "autopay_setup_requests"."workflow_status" = 'pending'
      AND "autopay_setup_requests"."completed_at" IS NULL
      AND "autopay_setup_requests"."canceled_at" IS NULL
    ) OR (
      "autopay_setup_requests"."workflow_status" = 'completed'
      AND "autopay_setup_requests"."completed_at" IS NOT NULL
      AND "autopay_setup_requests"."canceled_at" IS NULL
    ) OR (
      "autopay_setup_requests"."workflow_status" = 'canceled'
      AND "autopay_setup_requests"."completed_at" IS NULL
      AND "autopay_setup_requests"."canceled_at" IS NOT NULL
      AND "autopay_setup_requests"."payment_schedule_id" IS NULL
    )),
	CONSTRAINT "autopay_setup_requests_completion_schedule_check" CHECK ("autopay_setup_requests"."workflow_status" <> 'completed'
      OR "autopay_setup_requests"."snapshot"->>'firstAutomaticAt' IS NULL
      OR "autopay_setup_requests"."payment_schedule_id" IS NOT NULL),
	CONSTRAINT "autopay_setup_requests_timestamp_order_check" CHECK ("autopay_setup_requests"."updated_at" >= "autopay_setup_requests"."created_at"
      AND ("autopay_setup_requests"."completed_at" IS NULL OR "autopay_setup_requests"."completed_at" >= "autopay_setup_requests"."created_at")
      AND ("autopay_setup_requests"."canceled_at" IS NULL OR "autopay_setup_requests"."canceled_at" >= "autopay_setup_requests"."created_at"))
);
--> statement-breakpoint
ALTER TABLE "autopay_setup_requests" ADD CONSTRAINT "autopay_setup_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autopay_setup_requests" ADD CONSTRAINT "autopay_setup_requests_payer_bowler_id_bowlers_id_fk" FOREIGN KEY ("payer_bowler_id") REFERENCES "public"."bowlers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autopay_setup_requests" ADD CONSTRAINT "autopay_setup_requests_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autopay_setup_requests" ADD CONSTRAINT "autopay_setup_requests_payment_operation_id_payment_operations_id_fk" FOREIGN KEY ("payment_operation_id") REFERENCES "public"."payment_operations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autopay_setup_requests" ADD CONSTRAINT "autopay_setup_requests_payment_schedule_id_payment_schedules_id_fk" FOREIGN KEY ("payment_schedule_id") REFERENCES "public"."payment_schedules"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "autopay_setup_requests_active_unique" ON "autopay_setup_requests" USING btree ("payer_bowler_id","league_id") WHERE "autopay_setup_requests"."workflow_status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "autopay_setup_requests_request_fingerprint_unique" ON "autopay_setup_requests" USING btree ("request_fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "autopay_setup_requests_payment_operation_unique" ON "autopay_setup_requests" USING btree ("payment_operation_id") WHERE "autopay_setup_requests"."payment_operation_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "autopay_setup_requests_tenant_created_idx" ON "autopay_setup_requests" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "payment_operations_interactive_target_unique" ON "payment_operations" USING btree ("organization_id","target_key") WHERE "payment_operations"."operation_type" = 'interactive_charge';--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "payment_schedules"
		WHERE "active" = true
		GROUP BY "bowler_id", "league_id"
		HAVING count(*) > 1
	) THEN
		RAISE EXCEPTION 'cannot enforce one active payment schedule: duplicate active bowler/league schedules exist';
	END IF;
END
$$;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_schedules_active_bowler_league_unique" ON "payment_schedules" USING btree ("bowler_id","league_id") WHERE "payment_schedules"."active" = true;
