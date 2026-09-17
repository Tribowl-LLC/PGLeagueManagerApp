CREATE TABLE "account_guidance_delivery_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"recipient_email" text NOT NULL,
	"notice_type" text NOT NULL,
	"organization_id" integer,
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
	CONSTRAINT "account_guidance_delivery_jobs_notice_type_check" CHECK ("account_guidance_delivery_jobs"."notice_type" IN ('account_exists', 'account_missing')),
	CONSTRAINT "account_guidance_delivery_jobs_status_check" CHECK ("account_guidance_delivery_jobs"."status" IN ('pending', 'processing', 'retry_scheduled', 'succeeded', 'failed', 'suppressed')),
	CONSTRAINT "account_guidance_delivery_jobs_attempt_check" CHECK ("account_guidance_delivery_jobs"."attempt_count" >= 0 AND "account_guidance_delivery_jobs"."attempt_count" <= 4),
	CONSTRAINT "account_guidance_delivery_jobs_lifecycle_check" CHECK ((
      "account_guidance_delivery_jobs"."status" IN ('pending', 'retry_scheduled')
      AND "account_guidance_delivery_jobs"."completed_at" IS NULL
      AND "account_guidance_delivery_jobs"."lease_owner" IS NULL
      AND "account_guidance_delivery_jobs"."lease_token" IS NULL
      AND "account_guidance_delivery_jobs"."lease_expires_at" IS NULL
    ) OR (
      "account_guidance_delivery_jobs"."status" = 'processing'
      AND "account_guidance_delivery_jobs"."completed_at" IS NULL
      AND "account_guidance_delivery_jobs"."lease_owner" IS NOT NULL
      AND "account_guidance_delivery_jobs"."lease_token" IS NOT NULL
      AND "account_guidance_delivery_jobs"."lease_expires_at" IS NOT NULL
    ) OR (
      "account_guidance_delivery_jobs"."status" IN ('succeeded', 'failed', 'suppressed')
      AND "account_guidance_delivery_jobs"."completed_at" IS NOT NULL
      AND "account_guidance_delivery_jobs"."lease_owner" IS NULL
      AND "account_guidance_delivery_jobs"."lease_token" IS NULL
      AND "account_guidance_delivery_jobs"."lease_expires_at" IS NULL
    ))
);
--> statement-breakpoint
ALTER TABLE "account_guidance_delivery_jobs" ADD CONSTRAINT "account_guidance_delivery_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_guidance_delivery_jobs" ADD CONSTRAINT "account_guidance_delivery_jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_guidance_delivery_jobs_status_due_idx" ON "account_guidance_delivery_jobs" USING btree ("status","next_attempt_at","created_at");--> statement-breakpoint
CREATE INDEX "account_guidance_delivery_jobs_recipient_idx" ON "account_guidance_delivery_jobs" USING btree ("recipient_email","created_at");--> statement-breakpoint
CREATE INDEX "account_guidance_delivery_jobs_user_idx" ON "account_guidance_delivery_jobs" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_guidance_delivery_jobs_active_recipient_unique" ON "account_guidance_delivery_jobs" USING btree ("recipient_email") WHERE "account_guidance_delivery_jobs"."status" IN ('pending', 'processing', 'retry_scheduled');