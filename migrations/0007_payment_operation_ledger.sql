CREATE TABLE "payment_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"operation_type" text NOT NULL,
	"target_key" varchar(128) NOT NULL,
	"payment_schedule_id" integer,
	"billing_cycle_at" timestamp,
	"amount_minor" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"request_fingerprint" varchar(76) NOT NULL,
	"provider_idempotency_key" varchar(45) NOT NULL,
	"provider_name" varchar(32) NOT NULL,
	"provider_object_id" varchar(255),
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp DEFAULT now(),
	"lease_owner" varchar(128),
	"lease_token" uuid,
	"lease_expires_at" timestamp,
	"error_classification" text,
	"error_code" varchar(128),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	CONSTRAINT "payment_operations_operation_type_check" CHECK ("payment_operations"."operation_type" IN ('scheduled_charge', 'interactive_charge', 'refund')),
	CONSTRAINT "payment_operations_status_check" CHECK ("payment_operations"."status" IN ('pending', 'leased', 'provider_unknown', 'retry_scheduled', 'succeeded', 'action_required', 'failed_terminal', 'canceled')),
	CONSTRAINT "payment_operations_amount_minor_check" CHECK ("payment_operations"."amount_minor" > 0),
	CONSTRAINT "payment_operations_currency_check" CHECK ("payment_operations"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "payment_operations_target_key_check" CHECK (length("payment_operations"."target_key") > 0),
	CONSTRAINT "payment_operations_provider_name_check" CHECK ("payment_operations"."provider_name" ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
	CONSTRAINT "payment_operations_request_fingerprint_check" CHECK ("payment_operations"."request_fingerprint" ~ '^lvpayreq:v1:[0-9a-f]{64}$'),
	CONSTRAINT "payment_operations_provider_key_check" CHECK (length("payment_operations"."provider_idempotency_key") BETWEEN 1 AND 45),
	CONSTRAINT "payment_operations_attempt_count_check" CHECK ("payment_operations"."attempt_count" BETWEEN 0 AND 8),
	CONSTRAINT "payment_operations_scheduled_cycle_check" CHECK ((
      "payment_operations"."operation_type" = 'scheduled_charge'
      AND "payment_operations"."payment_schedule_id" IS NOT NULL
      AND "payment_operations"."billing_cycle_at" IS NOT NULL
    ) OR (
      "payment_operations"."operation_type" <> 'scheduled_charge'
      AND "payment_operations"."billing_cycle_at" IS NULL
    )),
	CONSTRAINT "payment_operations_due_state_check" CHECK (("payment_operations"."status" IN ('pending', 'provider_unknown', 'retry_scheduled')) = ("payment_operations"."next_attempt_at" IS NOT NULL)),
	CONSTRAINT "payment_operations_lease_state_check" CHECK ((
      "payment_operations"."status" = 'leased'
      AND "payment_operations"."lease_owner" IS NOT NULL
      AND "payment_operations"."lease_token" IS NOT NULL
      AND "payment_operations"."lease_expires_at" IS NOT NULL
    ) OR (
      "payment_operations"."status" <> 'leased'
      AND "payment_operations"."lease_owner" IS NULL
      AND "payment_operations"."lease_expires_at" IS NULL
    )),
	CONSTRAINT "payment_operations_nonterminal_lease_token_check" CHECK ("payment_operations"."status" IN ('leased', 'succeeded', 'action_required', 'failed_terminal', 'canceled') OR "payment_operations"."lease_token" IS NULL),
	CONSTRAINT "payment_operations_completion_state_check" CHECK (("payment_operations"."status" IN ('succeeded', 'action_required', 'failed_terminal', 'canceled')) = ("payment_operations"."completed_at" IS NOT NULL)),
	CONSTRAINT "payment_operations_error_state_check" CHECK ((
      "payment_operations"."status" IN ('provider_unknown', 'retry_scheduled', 'action_required', 'failed_terminal')
      AND "payment_operations"."error_classification" IS NOT NULL
    ) OR (
      "payment_operations"."status" NOT IN ('provider_unknown', 'retry_scheduled', 'action_required', 'failed_terminal')
      AND "payment_operations"."error_classification" IS NULL
      AND "payment_operations"."error_code" IS NULL
    )),
	CONSTRAINT "payment_operations_error_classification_check" CHECK ("payment_operations"."error_classification" IS NULL OR "payment_operations"."error_classification" IN ('provider_unknown', 'transient', 'hard_decline', 'configuration', 'invalid_request', 'internal')),
	CONSTRAINT "payment_operations_error_code_check" CHECK ("payment_operations"."error_code" IS NULL OR "payment_operations"."error_code" ~ '^[A-Z0-9][A-Z0-9_.:-]{0,127}$'),
	CONSTRAINT "payment_operations_started_attempt_check" CHECK (("payment_operations"."attempt_count" = 0 AND "payment_operations"."started_at" IS NULL) OR ("payment_operations"."attempt_count" > 0 AND "payment_operations"."started_at" IS NOT NULL)),
	CONSTRAINT "payment_operations_success_provider_object_check" CHECK ("payment_operations"."status" <> 'succeeded' OR "payment_operations"."provider_object_id" IS NOT NULL),
	CONSTRAINT "payment_operations_timestamp_order_check" CHECK ("payment_operations"."updated_at" >= "payment_operations"."created_at"
      AND ("payment_operations"."started_at" IS NULL OR "payment_operations"."started_at" >= "payment_operations"."created_at")
      AND ("payment_operations"."completed_at" IS NULL OR "payment_operations"."started_at" IS NULL OR "payment_operations"."completed_at" >= "payment_operations"."started_at")
      AND ("payment_operations"."lease_expires_at" IS NULL OR "payment_operations"."lease_expires_at" > "payment_operations"."updated_at"))
);
--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_payment_schedule_id_payment_schedules_id_fk" FOREIGN KEY ("payment_schedule_id") REFERENCES "public"."payment_schedules"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_operations_provider_idempotency_key_unique" ON "payment_operations" USING btree ("provider_idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_operations_recurring_cycle_unique" ON "payment_operations" USING btree ("payment_schedule_id","billing_cycle_at") WHERE "payment_operations"."operation_type" = 'scheduled_charge';--> statement-breakpoint
CREATE INDEX "payment_operations_tenant_created_idx" ON "payment_operations" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payment_operations_provider_object_idx" ON "payment_operations" USING btree ("provider_name","provider_object_id") WHERE "payment_operations"."provider_object_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "payment_operations_due_retry_idx" ON "payment_operations" USING btree ("next_attempt_at") WHERE "payment_operations"."status" IN ('pending', 'provider_unknown', 'retry_scheduled');--> statement-breakpoint
CREATE INDEX "payment_operations_expired_lease_idx" ON "payment_operations" USING btree ("lease_expires_at") WHERE "payment_operations"."status" = 'leased';