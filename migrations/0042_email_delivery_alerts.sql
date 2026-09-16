CREATE TABLE "email_delivery_alerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider_event_id" varchar(100) NOT NULL,
	"provider_message_id" varchar(255),
	"recipient_email" varchar(320) NOT NULL,
	"event_type" text NOT NULL,
	"failure_type" text NOT NULL,
	"reason_code" varchar(64) NOT NULL,
	"bounce_classification" varchar(32),
	"smtp_status" varchar(32),
	"sending_ip" varchar(45),
	"provider_event_at" timestamp NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp,
	"acknowledged_by_user_id" integer,
	CONSTRAINT "email_delivery_alerts_provider_event_id_check" CHECK ("email_delivery_alerts"."provider_event_id" <> ''),
	CONSTRAINT "email_delivery_alerts_recipient_email_check" CHECK ("email_delivery_alerts"."recipient_email" ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'),
	CONSTRAINT "email_delivery_alerts_event_type_check" CHECK ("email_delivery_alerts"."event_type" IN ('bounce', 'dropped')),
	CONSTRAINT "email_delivery_alerts_failure_type_check" CHECK ("email_delivery_alerts"."failure_type" IN ('blocked', 'bounce', 'dropped')),
	CONSTRAINT "email_delivery_alerts_reason_code_check" CHECK ("email_delivery_alerts"."reason_code" IN ('sending_ip_blocklisted', 'recipient_address_invalid', 'mailbox_full', 'policy_rejection', 'temporary_failure', 'provider_dropped', 'unknown_failure')),
	CONSTRAINT "email_delivery_alerts_bounce_classification_check" CHECK ("email_delivery_alerts"."bounce_classification" IS NULL OR "email_delivery_alerts"."bounce_classification" IN ('invalid_address', 'technical', 'content', 'reputation', 'mailbox_unavailable', 'unclassified')),
	CONSTRAINT "email_delivery_alerts_smtp_status_check" CHECK ("email_delivery_alerts"."smtp_status" IS NULL OR "email_delivery_alerts"."smtp_status" ~ '^([2-5][0-9]{2}|[2-5][.][0-9]{1,3}[.][0-9]{1,3})$'),
	CONSTRAINT "email_delivery_alerts_sending_ip_check" CHECK ("email_delivery_alerts"."sending_ip" IS NULL OR length("email_delivery_alerts"."sending_ip") BETWEEN 2 AND 45)
);
--> statement-breakpoint
ALTER TABLE "email_delivery_alerts" ADD CONSTRAINT "email_delivery_alerts_acknowledged_by_user_id_users_id_fk" FOREIGN KEY ("acknowledged_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_delivery_alerts_provider_event_unique" ON "email_delivery_alerts" USING btree ("provider_event_id");--> statement-breakpoint
CREATE INDEX "email_delivery_alerts_received_at_idx" ON "email_delivery_alerts" USING btree ("received_at","id");--> statement-breakpoint
CREATE INDEX "email_delivery_alerts_acknowledgement_idx" ON "email_delivery_alerts" USING btree ("acknowledged_at","received_at","id");