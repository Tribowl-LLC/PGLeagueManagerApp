CREATE TABLE "account_action_delivery_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"organization_id" integer,
	"action" text DEFAULT 'password_reset' NOT NULL,
	"credential_generation" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp,
	"lease_owner" text,
	"lease_token" text,
	"lease_expires_at" timestamp,
	"action_request_id" integer,
	"provider_message_id" text,
	"last_error_code" text,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "account_action_delivery_jobs_action_check" CHECK ("account_action_delivery_jobs"."action" = 'password_reset'),
	CONSTRAINT "account_action_delivery_jobs_status_check" CHECK ("account_action_delivery_jobs"."status" IN ('pending', 'processing', 'retry_scheduled', 'succeeded', 'failed', 'suppressed')),
	CONSTRAINT "account_action_delivery_jobs_attempt_check" CHECK ("account_action_delivery_jobs"."attempt_count" >= 0 AND "account_action_delivery_jobs"."attempt_count" <= 4),
	CONSTRAINT "account_action_delivery_jobs_lifecycle_check" CHECK ((
      "account_action_delivery_jobs"."status" IN ('pending', 'retry_scheduled')
      AND "account_action_delivery_jobs"."completed_at" IS NULL
      AND "account_action_delivery_jobs"."lease_owner" IS NULL
      AND "account_action_delivery_jobs"."lease_token" IS NULL
      AND "account_action_delivery_jobs"."lease_expires_at" IS NULL
    ) OR (
      "account_action_delivery_jobs"."status" = 'processing'
      AND "account_action_delivery_jobs"."completed_at" IS NULL
      AND "account_action_delivery_jobs"."lease_owner" IS NOT NULL
      AND "account_action_delivery_jobs"."lease_token" IS NOT NULL
      AND "account_action_delivery_jobs"."lease_expires_at" IS NOT NULL
    ) OR (
      "account_action_delivery_jobs"."status" IN ('succeeded', 'failed', 'suppressed')
      AND "account_action_delivery_jobs"."completed_at" IS NOT NULL
      AND "account_action_delivery_jobs"."lease_owner" IS NULL
      AND "account_action_delivery_jobs"."lease_token" IS NULL
      AND "account_action_delivery_jobs"."lease_expires_at" IS NULL
    ))
);
--> statement-breakpoint
CREATE TABLE "account_email_delivery_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider_event_id" varchar(100) NOT NULL,
	"provider_message_id" varchar(255),
	"account_action_id" integer NOT NULL,
	"account_delivery_job_id" integer NOT NULL,
	"event_type" text NOT NULL,
	"provider_event_at" timestamp NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "account_email_delivery_events_event_type_check" CHECK ("account_email_delivery_events"."event_type" IN ('processed', 'delivered', 'deferred', 'bounce', 'dropped')),
	CONSTRAINT "account_email_delivery_events_provider_event_id_check" CHECK ("account_email_delivery_events"."provider_event_id" <> '')
);
--> statement-breakpoint
DROP INDEX "account_action_requests_pending_user_action_unique";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "credential_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "account_action_requests" ADD COLUMN "delivery_job_id" integer;--> statement-breakpoint
ALTER TABLE "account_action_delivery_jobs" ADD CONSTRAINT "account_action_delivery_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_action_delivery_jobs" ADD CONSTRAINT "account_action_delivery_jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_action_delivery_jobs" ADD CONSTRAINT "account_action_delivery_jobs_action_request_id_account_action_requests_id_fk" FOREIGN KEY ("action_request_id") REFERENCES "public"."account_action_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_email_delivery_events" ADD CONSTRAINT "account_email_delivery_events_account_action_id_account_action_requests_id_fk" FOREIGN KEY ("account_action_id") REFERENCES "public"."account_action_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_email_delivery_events" ADD CONSTRAINT "account_email_delivery_events_account_delivery_job_id_account_action_delivery_jobs_id_fk" FOREIGN KEY ("account_delivery_job_id") REFERENCES "public"."account_action_delivery_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_action_delivery_jobs_status_due_idx" ON "account_action_delivery_jobs" USING btree ("status","next_attempt_at","created_at");--> statement-breakpoint
CREATE INDEX "account_action_delivery_jobs_user_idx" ON "account_action_delivery_jobs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "account_action_delivery_jobs_action_request_idx" ON "account_action_delivery_jobs" USING btree ("action_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_action_delivery_jobs_active_user_action_unique" ON "account_action_delivery_jobs" USING btree ("user_id","action") WHERE "account_action_delivery_jobs"."status" IN ('pending', 'processing', 'retry_scheduled');--> statement-breakpoint
CREATE UNIQUE INDEX "account_email_delivery_events_provider_event_unique" ON "account_email_delivery_events" USING btree ("provider_event_id");--> statement-breakpoint
CREATE INDEX "account_email_delivery_events_action_job_event_idx" ON "account_email_delivery_events" USING btree ("account_action_id","account_delivery_job_id","provider_event_at");--> statement-breakpoint
ALTER TABLE "account_action_requests" ADD CONSTRAINT "account_action_requests_delivery_job_id_account_action_delivery_jobs_id_fk" FOREIGN KEY ("delivery_job_id") REFERENCES "public"."account_action_delivery_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_action_requests_delivery_job_idx" ON "account_action_requests" USING btree ("delivery_job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_action_requests_pending_invitation_unique" ON "account_action_requests" USING btree ("user_id","action") WHERE "account_action_requests"."status" = 'pending' AND "account_action_requests"."action" = 'account_invite';--> statement-breakpoint
CREATE INDEX "account_action_requests_pending_user_action_expiry_idx" ON "account_action_requests" USING btree ("user_id","action","expires_at") WHERE "account_action_requests"."status" = 'pending';--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_credential_generation_nonnegative" CHECK ("users"."credential_generation" >= 0);
--> statement-breakpoint
-- Every credential mutation revokes existing bearer credentials, including
-- updates outside the account routes. Generation is database-owned.
CREATE FUNCTION users_credential_generation_bump()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.credential_generation IS DISTINCT FROM OLD.credential_generation THEN
    RAISE EXCEPTION 'credential generation is database managed' USING ERRCODE = '23514';
  END IF;
  IF NEW.password IS DISTINCT FROM OLD.password
     OR NEW.email IS DISTINCT FROM OLD.email THEN
    NEW.credential_generation := OLD.credential_generation + 1;
    UPDATE account_action_requests
       SET status = 'revoked', revoked_at = now()
     WHERE user_id = NEW.id AND status = 'pending';
    UPDATE email_change_requests
       SET consumed_at = now()
     WHERE user_id = NEW.id AND consumed_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER users_credential_generation_bump
BEFORE UPDATE OF password, email, credential_generation ON users
FOR EACH ROW EXECUTE FUNCTION users_credential_generation_bump();
