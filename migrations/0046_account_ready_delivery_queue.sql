CREATE TABLE "account_ready_delivery_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"identity_link_event_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"bowler_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp,
	"lease_owner" text,
	"lease_token" text,
	"lease_expires_at" timestamp,
	"provider_message_id" text,
	"last_error_code" text,
	"expires_at" timestamp NOT NULL,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "account_ready_delivery_jobs_status_check" CHECK ("account_ready_delivery_jobs"."status" IN ('pending', 'processing', 'retry_scheduled', 'succeeded', 'failed', 'suppressed')),
	CONSTRAINT "account_ready_delivery_jobs_attempt_check" CHECK ("account_ready_delivery_jobs"."attempt_count" >= 0 AND "account_ready_delivery_jobs"."attempt_count" <= 4),
	CONSTRAINT "account_ready_delivery_jobs_lifecycle_check" CHECK ((
      "account_ready_delivery_jobs"."status" IN ('pending', 'retry_scheduled')
      AND "account_ready_delivery_jobs"."completed_at" IS NULL
      AND "account_ready_delivery_jobs"."lease_owner" IS NULL
      AND "account_ready_delivery_jobs"."lease_token" IS NULL
      AND "account_ready_delivery_jobs"."lease_expires_at" IS NULL
    ) OR (
      "account_ready_delivery_jobs"."status" = 'processing'
      AND "account_ready_delivery_jobs"."completed_at" IS NULL
      AND "account_ready_delivery_jobs"."lease_owner" IS NOT NULL
      AND "account_ready_delivery_jobs"."lease_token" IS NOT NULL
      AND "account_ready_delivery_jobs"."lease_expires_at" IS NOT NULL
    ) OR (
      "account_ready_delivery_jobs"."status" IN ('succeeded', 'failed', 'suppressed')
      AND "account_ready_delivery_jobs"."completed_at" IS NOT NULL
      AND "account_ready_delivery_jobs"."lease_owner" IS NULL
      AND "account_ready_delivery_jobs"."lease_token" IS NULL
      AND "account_ready_delivery_jobs"."lease_expires_at" IS NULL
    ))
);
--> statement-breakpoint
ALTER TABLE "account_ready_delivery_jobs" ADD CONSTRAINT "account_ready_delivery_jobs_identity_link_event_id_identity_link_events_id_fk" FOREIGN KEY ("identity_link_event_id") REFERENCES "public"."identity_link_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_ready_delivery_jobs" ADD CONSTRAINT "account_ready_delivery_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_ready_delivery_jobs" ADD CONSTRAINT "account_ready_delivery_jobs_bowler_id_bowlers_id_fk" FOREIGN KEY ("bowler_id") REFERENCES "public"."bowlers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_ready_delivery_jobs" ADD CONSTRAINT "account_ready_delivery_jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_ready_delivery_jobs_identity_link_event_unique" ON "account_ready_delivery_jobs" USING btree ("identity_link_event_id");--> statement-breakpoint
CREATE INDEX "account_ready_delivery_jobs_status_due_idx" ON "account_ready_delivery_jobs" USING btree ("status","next_attempt_at","created_at");--> statement-breakpoint
CREATE INDEX "account_ready_delivery_jobs_user_idx" ON "account_ready_delivery_jobs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "account_ready_delivery_jobs_bowler_idx" ON "account_ready_delivery_jobs" USING btree ("bowler_id");