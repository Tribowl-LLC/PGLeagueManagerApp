CREATE TABLE "payment_disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"location_id" integer NOT NULL,
	"payment_operation_id" uuid NOT NULL,
	"provider" varchar(32) NOT NULL,
	"provider_application_id" varchar(255) NOT NULL,
	"provider_merchant_id" varchar(255) NOT NULL,
	"provider_location_id" varchar(255) NOT NULL,
	"provider_dispute_id" varchar(255) NOT NULL,
	"provider_payment_id" varchar(255) NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"reason" varchar(64) NOT NULL,
	"state" varchar(64) NOT NULL,
	"response_due_at" timestamp,
	"card_brand" varchar(32),
	"brand_dispute_id" varchar(255),
	"provider_created_at" timestamp NOT NULL,
	"provider_reported_at" timestamp,
	"provider_updated_at" timestamp NOT NULL,
	"provider_version" integer NOT NULL,
	"first_webhook_event_id" uuid NOT NULL,
	"last_webhook_event_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "payment_disputes_provider_check" CHECK ("payment_disputes"."provider" = 'square'),
	CONSTRAINT "payment_disputes_amount_check" CHECK ("payment_disputes"."amount_minor" > 0),
	CONSTRAINT "payment_disputes_currency_check" CHECK ("payment_disputes"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "payment_disputes_version_check" CHECK ("payment_disputes"."provider_version" > 0),
	CONSTRAINT "payment_disputes_state_check" CHECK ("payment_disputes"."state" IN ('INQUIRY_EVIDENCE_REQUIRED', 'INQUIRY_PROCESSING', 'INQUIRY_CLOSED', 'EVIDENCE_REQUIRED', 'PROCESSING', 'WON', 'LOST', 'ACCEPTED')),
	CONSTRAINT "payment_disputes_reason_check" CHECK ("payment_disputes"."reason" IN ('AMOUNT_DIFFERS', 'CANCELLED', 'DUPLICATE', 'NO_KNOWLEDGE', 'NOT_AS_DESCRIBED', 'NOT_RECEIVED', 'PAID_BY_OTHER_MEANS', 'CUSTOMER_REQUESTS_CREDIT', 'EMV_LIABILITY_SHIFT'))
);
--> statement-breakpoint
ALTER TABLE "payment_disputes" ADD CONSTRAINT "payment_disputes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_disputes" ADD CONSTRAINT "payment_disputes_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_disputes" ADD CONSTRAINT "payment_disputes_payment_operation_id_payment_operations_id_fk" FOREIGN KEY ("payment_operation_id") REFERENCES "public"."payment_operations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_disputes" ADD CONSTRAINT "payment_disputes_first_webhook_event_id_webhook_events_id_fk" FOREIGN KEY ("first_webhook_event_id") REFERENCES "public"."webhook_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_disputes" ADD CONSTRAINT "payment_disputes_last_webhook_event_id_webhook_events_id_fk" FOREIGN KEY ("last_webhook_event_id") REFERENCES "public"."webhook_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_disputes_provider_dispute_unique" ON "payment_disputes" USING btree ("provider","provider_dispute_id");--> statement-breakpoint
CREATE INDEX "payment_disputes_tenant_updated_idx" ON "payment_disputes" USING btree ("organization_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payment_disputes_tenant_state_due_idx" ON "payment_disputes" USING btree ("organization_id","state","response_due_at");--> statement-breakpoint
CREATE INDEX "payment_disputes_operation_idx" ON "payment_disputes" USING btree ("payment_operation_id");--> statement-breakpoint
CREATE INDEX "payment_disputes_provider_payment_idx" ON "payment_disputes" USING btree ("provider","provider_payment_id");