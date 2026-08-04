CREATE TABLE "payment_dispute_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"location_id" integer NOT NULL,
	"payment_dispute_id" uuid NOT NULL,
	"webhook_event_id" uuid NOT NULL,
	"kind" varchar(48) NOT NULL,
	"dispute_state" varchar(64) NOT NULL,
	"provider_version" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "payment_dispute_notifications_kind_check" CHECK ("payment_dispute_notifications"."kind" IN ('DISPUTE_CREATED', 'DISPUTE_STATE_UPDATED')),
	CONSTRAINT "payment_dispute_notifications_state_check" CHECK ("payment_dispute_notifications"."dispute_state" IN ('INQUIRY_EVIDENCE_REQUIRED', 'INQUIRY_PROCESSING', 'INQUIRY_CLOSED', 'EVIDENCE_REQUIRED', 'PROCESSING', 'WON', 'LOST', 'ACCEPTED')),
	CONSTRAINT "payment_dispute_notifications_version_check" CHECK ("payment_dispute_notifications"."provider_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "payment_dispute_replay_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"webhook_event_id" uuid NOT NULL,
	"actor_user_id" integer NOT NULL,
	"actor_role" varchar(32) NOT NULL,
	"initial_status" varchar(32) NOT NULL,
	"result_status" varchar(32) NOT NULL,
	"result_code" varchar(96),
	"business_state_changed" boolean NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "payment_dispute_replay_audits_actor_role_check" CHECK ("payment_dispute_replay_audits"."actor_role" IN ('org_admin', 'system_admin')),
	CONSTRAINT "payment_dispute_replay_audits_initial_status_check" CHECK ("payment_dispute_replay_audits"."initial_status" IN ('pending', 'processing', 'retry_scheduled', 'processed', 'ignored', 'failed')),
	CONSTRAINT "payment_dispute_replay_audits_result_status_check" CHECK ("payment_dispute_replay_audits"."result_status" IN ('pending', 'processing', 'retry_scheduled', 'processed', 'ignored', 'failed')),
	CONSTRAINT "payment_dispute_replay_audits_result_code_check" CHECK ("payment_dispute_replay_audits"."result_code" IS NULL OR "payment_dispute_replay_audits"."result_code" ~ '^[A-Z][A-Z0-9_]{0,95}$')
);
--> statement-breakpoint
ALTER TABLE "payment_dispute_notifications" ADD CONSTRAINT "payment_dispute_notifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_dispute_notifications" ADD CONSTRAINT "payment_dispute_notifications_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_dispute_notifications" ADD CONSTRAINT "payment_dispute_notifications_payment_dispute_id_payment_disputes_id_fk" FOREIGN KEY ("payment_dispute_id") REFERENCES "public"."payment_disputes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_dispute_notifications" ADD CONSTRAINT "payment_dispute_notifications_webhook_event_id_webhook_events_id_fk" FOREIGN KEY ("webhook_event_id") REFERENCES "public"."webhook_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_dispute_replay_audits" ADD CONSTRAINT "payment_dispute_replay_audits_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_dispute_replay_audits" ADD CONSTRAINT "payment_dispute_replay_audits_webhook_event_id_webhook_events_id_fk" FOREIGN KEY ("webhook_event_id") REFERENCES "public"."webhook_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_dispute_replay_audits" ADD CONSTRAINT "payment_dispute_replay_audits_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_dispute_notifications_dispute_version_unique" ON "payment_dispute_notifications" USING btree ("payment_dispute_id","provider_version");--> statement-breakpoint
CREATE INDEX "payment_dispute_notifications_tenant_created_idx" ON "payment_dispute_notifications" USING btree ("organization_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payment_dispute_notifications_location_created_idx" ON "payment_dispute_notifications" USING btree ("location_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payment_dispute_replay_audits_tenant_created_idx" ON "payment_dispute_replay_audits" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payment_dispute_replay_audits_event_created_idx" ON "payment_dispute_replay_audits" USING btree ("webhook_event_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payment_dispute_replay_audits_actor_created_idx" ON "payment_dispute_replay_audits" USING btree ("actor_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "webhook_events_tenant_status_type_received_idx" ON "webhook_events" USING btree ("organization_id","status","event_type","received_at" DESC NULLS LAST,"id" DESC NULLS LAST);