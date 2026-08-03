CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(32) NOT NULL,
	"provider_event_id" varchar(255) NOT NULL,
	"event_type" varchar(128) NOT NULL,
	"provider_created_at" timestamp NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"organization_id" integer NOT NULL,
	"location_id" integer NOT NULL,
	"provider_application_id" varchar(255) NOT NULL,
	"provider_merchant_id" varchar(255) NOT NULL,
	"provider_location_id" varchar(255) NOT NULL,
	"provider_object_type" varchar(64) NOT NULL,
	"provider_object_id" varchar(255) NOT NULL,
	"provider_payment_id" varchar(255),
	"provider_object_version" integer,
	"provider_object_updated_at" timestamp,
	"provider_api_version" varchar(10) NOT NULL,
	"payload_schema_version" integer DEFAULT 1 NOT NULL,
	"payload_hash" varchar(64) NOT NULL,
	"encrypted_payload" text NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp,
	"lease_owner" varchar(128),
	"lease_token" uuid,
	"lease_expires_at" timestamp,
	"error_classification" varchar(32),
	"error_code" varchar(96),
	"processed_at" timestamp,
	"completed_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_events_status_check" CHECK ("webhook_events"."status" IN ('pending', 'processing', 'retry_scheduled', 'processed', 'ignored', 'failed')),
	CONSTRAINT "webhook_events_provider_check" CHECK ("webhook_events"."provider" = 'square'),
	CONSTRAINT "webhook_events_payload_version_check" CHECK ("webhook_events"."payload_schema_version" = 1),
	CONSTRAINT "webhook_events_payload_hash_check" CHECK ("webhook_events"."payload_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "webhook_events_attempts_check" CHECK ("webhook_events"."attempt_count" BETWEEN 0 AND 20),
	CONSTRAINT "webhook_events_object_version_check" CHECK ("webhook_events"."provider_object_version" IS NULL OR "webhook_events"."provider_object_version" > 0),
	CONSTRAINT "webhook_events_lease_check" CHECK ((
      "webhook_events"."status" = 'processing'
      AND "webhook_events"."lease_owner" IS NOT NULL
      AND "webhook_events"."lease_token" IS NOT NULL
      AND "webhook_events"."lease_expires_at" IS NOT NULL
      AND "webhook_events"."next_attempt_at" IS NULL
      AND "webhook_events"."completed_at" IS NULL
    ) OR (
      "webhook_events"."status" <> 'processing'
      AND "webhook_events"."lease_owner" IS NULL
      AND "webhook_events"."lease_token" IS NULL
      AND "webhook_events"."lease_expires_at" IS NULL
    )),
	CONSTRAINT "webhook_events_due_check" CHECK ((
      "webhook_events"."status" = 'retry_scheduled'
      AND "webhook_events"."next_attempt_at" IS NOT NULL
      AND "webhook_events"."completed_at" IS NULL
    ) OR (
      "webhook_events"."status" <> 'retry_scheduled'
      AND "webhook_events"."next_attempt_at" IS NULL
    )),
	CONSTRAINT "webhook_events_terminal_check" CHECK ((
      "webhook_events"."status" IN ('processed', 'ignored', 'failed')
      AND "webhook_events"."processed_at" IS NOT NULL
      AND "webhook_events"."completed_at" IS NOT NULL
    ) OR (
      "webhook_events"."status" NOT IN ('processed', 'ignored', 'failed')
      AND "webhook_events"."completed_at" IS NULL
    )),
	CONSTRAINT "webhook_events_error_check" CHECK ((
      "webhook_events"."error_classification" IS NULL
      AND "webhook_events"."error_code" IS NULL
    ) OR (
      "webhook_events"."error_classification" IN ('configuration', 'mapping', 'payload', 'processing')
      AND "webhook_events"."error_code" ~ '^[A-Z][A-Z0-9_]{0,95}$'
    ))
);
--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_provider_event_unique" ON "webhook_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "webhook_events_organization_received_idx" ON "webhook_events" USING btree ("organization_id","received_at");--> statement-breakpoint
CREATE INDEX "webhook_events_location_received_idx" ON "webhook_events" USING btree ("location_id","received_at");