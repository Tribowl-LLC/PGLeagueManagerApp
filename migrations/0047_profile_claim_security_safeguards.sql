CREATE TABLE "identity_security_holds" (
	"id" serial PRIMARY KEY NOT NULL,
	"notification_id" integer NOT NULL,
	"report_token_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"bowler_id" integer,
	"organization_id" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"reason" text,
	"resolved_by_user_id" integer,
	"resolution" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "identity_security_holds_status_check" CHECK ("identity_security_holds"."status" IN ('active', 'resolved', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "profile_claim_notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"identity_link_event_id" integer NOT NULL,
	"user_id" integer,
	"bowler_id" integer,
	"organization_id" integer NOT NULL,
	"recipient_email" text NOT NULL,
	"recipient_source" text NOT NULL,
	"recipient_name" text NOT NULL,
	"bowler_name" text NOT NULL,
	"report_token_hash" text NOT NULL,
	"report_token_expires_at" timestamp NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp,
	"lease_owner" text,
	"lease_token" text,
	"lease_expires_at" timestamp,
	"provider_message_id" text,
	"last_error_code" text,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "profile_claim_notifications_status_check" CHECK ("profile_claim_notifications"."status" IN ('pending', 'processing', 'retry_scheduled', 'succeeded', 'failed', 'suppressed')),
	CONSTRAINT "profile_claim_notifications_recipient_source_check" CHECK ("profile_claim_notifications"."recipient_source" IN ('roster', 'account_fallback')),
	CONSTRAINT "profile_claim_notifications_attempt_check" CHECK ("profile_claim_notifications"."attempt_count" >= 0 AND "profile_claim_notifications"."attempt_count" <= 4),
	CONSTRAINT "profile_claim_notifications_lifecycle_check" CHECK ((
      "profile_claim_notifications"."status" IN ('pending', 'retry_scheduled')
      AND "profile_claim_notifications"."completed_at" IS NULL
      AND "profile_claim_notifications"."lease_owner" IS NULL
      AND "profile_claim_notifications"."lease_token" IS NULL
      AND "profile_claim_notifications"."lease_expires_at" IS NULL
    ) OR (
      "profile_claim_notifications"."status" = 'processing'
      AND "profile_claim_notifications"."completed_at" IS NULL
      AND "profile_claim_notifications"."lease_owner" IS NOT NULL
      AND "profile_claim_notifications"."lease_token" IS NOT NULL
      AND "profile_claim_notifications"."lease_expires_at" IS NOT NULL
    ) OR (
      "profile_claim_notifications"."status" IN ('succeeded', 'failed', 'suppressed')
      AND "profile_claim_notifications"."completed_at" IS NOT NULL
      AND "profile_claim_notifications"."lease_owner" IS NULL
      AND "profile_claim_notifications"."lease_token" IS NULL
      AND "profile_claim_notifications"."lease_expires_at" IS NULL
    ))
);
--> statement-breakpoint
CREATE TABLE "profile_claim_report_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"notification_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "identity_security_holds" ADD CONSTRAINT "identity_security_holds_notification_id_profile_claim_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."profile_claim_notifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_security_holds" ADD CONSTRAINT "identity_security_holds_report_token_id_profile_claim_report_tokens_id_fk" FOREIGN KEY ("report_token_id") REFERENCES "public"."profile_claim_report_tokens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_security_holds" ADD CONSTRAINT "identity_security_holds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_security_holds" ADD CONSTRAINT "identity_security_holds_bowler_id_bowlers_id_fk" FOREIGN KEY ("bowler_id") REFERENCES "public"."bowlers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_security_holds" ADD CONSTRAINT "identity_security_holds_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_security_holds" ADD CONSTRAINT "identity_security_holds_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_claim_notifications" ADD CONSTRAINT "profile_claim_notifications_identity_link_event_id_identity_link_events_id_fk" FOREIGN KEY ("identity_link_event_id") REFERENCES "public"."identity_link_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_claim_notifications" ADD CONSTRAINT "profile_claim_notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_claim_notifications" ADD CONSTRAINT "profile_claim_notifications_bowler_id_bowlers_id_fk" FOREIGN KEY ("bowler_id") REFERENCES "public"."bowlers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_claim_notifications" ADD CONSTRAINT "profile_claim_notifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_claim_report_tokens" ADD CONSTRAINT "profile_claim_report_tokens_notification_id_profile_claim_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."profile_claim_notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "identity_security_holds_notification_unique" ON "identity_security_holds" USING btree ("notification_id");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_security_holds_active_user_unique" ON "identity_security_holds" USING btree ("user_id") WHERE "identity_security_holds"."status" = 'active';--> statement-breakpoint
CREATE INDEX "identity_security_holds_status_idx" ON "identity_security_holds" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "identity_security_holds_user_idx" ON "identity_security_holds" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_claim_notifications_event_unique" ON "profile_claim_notifications" USING btree ("identity_link_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_claim_notifications_report_token_hash_unique" ON "profile_claim_notifications" USING btree ("report_token_hash");--> statement-breakpoint
CREATE INDEX "profile_claim_notifications_status_due_idx" ON "profile_claim_notifications" USING btree ("status","next_attempt_at","created_at");--> statement-breakpoint
CREATE INDEX "profile_claim_notifications_user_idx" ON "profile_claim_notifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "profile_claim_notifications_bowler_idx" ON "profile_claim_notifications" USING btree ("bowler_id");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_claim_report_tokens_notification_unique" ON "profile_claim_report_tokens" USING btree ("notification_id");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_claim_report_tokens_hash_unique" ON "profile_claim_report_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "profile_claim_report_tokens_notification_idx" ON "profile_claim_report_tokens" USING btree ("notification_id");
