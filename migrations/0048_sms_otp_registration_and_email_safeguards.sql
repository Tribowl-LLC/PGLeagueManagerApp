CREATE TABLE "user_verification_provenance" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"email" text NOT NULL,
	"email_status" text DEFAULT 'unknown' NOT NULL,
	"email_verified_at" timestamp,
	"email_verification_source" text,
	"phone" text,
	"phone_verified_at" timestamp,
	"phone_verification_source" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_verification_provenance_email_status_check" CHECK ("user_verification_provenance"."email_status" IN ('unknown', 'verified'))
);
--> statement-breakpoint
CREATE TABLE "registration_verification_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"existing_user_id" integer,
	"session_binding_hash" text NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"provider_verification_sid" text,
	"operation_lease_token" text,
	"operation_lease_expires_at" timestamp,
	"operation_version" integer DEFAULT 0 NOT NULL,
	"last_sent_at" timestamp,
	"send_count" integer DEFAULT 0 NOT NULL,
	"verification_attempt_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"verified_at" timestamp,
	"setup_expires_at" timestamp,
	"consumed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "registration_verification_challenges_status_check" CHECK ("registration_verification_challenges"."status" IN ('pending', 'verified', 'consumed', 'expired', 'replaced', 'cancelled', 'failed')),
	CONSTRAINT "registration_verification_challenges_setup_expiry_check" CHECK ("registration_verification_challenges"."status" <> 'verified' OR "registration_verification_challenges"."setup_expires_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "email_change_requests" ADD COLUMN "old_email" text;--> statement-breakpoint
ALTER TABLE "email_change_requests" ADD COLUMN "old_email_token_hash" text;--> statement-breakpoint
ALTER TABLE "email_change_requests" ADD COLUMN "old_email_token_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "email_change_requests" ADD COLUMN "old_email_approved_at" timestamp;--> statement-breakpoint
ALTER TABLE "email_change_requests" ADD COLUMN "new_email_confirmed_at" timestamp;--> statement-breakpoint
ALTER TABLE "email_change_requests" ADD COLUMN "reauthenticated_at" timestamp;--> statement-breakpoint
ALTER TABLE "email_change_requests" ADD COLUMN "credential_generation" integer;--> statement-breakpoint
ALTER TABLE "email_change_requests" ADD COLUMN "flow_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_verification_provenance" ADD CONSTRAINT "user_verification_provenance_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_verification_provenance" ADD CONSTRAINT "user_verification_provenance_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_verification_challenges" ADD CONSTRAINT "registration_verification_challenges_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_verification_challenges" ADD CONSTRAINT "registration_verification_challenges_existing_user_id_users_id_fk" FOREIGN KEY ("existing_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_verification_provenance_user_unique" ON "user_verification_provenance" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_verification_provenance_org_email_idx" ON "user_verification_provenance" USING btree ("organization_id","email");--> statement-breakpoint
CREATE INDEX "registration_verification_challenges_session_idx" ON "registration_verification_challenges" USING btree ("session_binding_hash","created_at");--> statement-breakpoint
CREATE INDEX "registration_verification_challenges_phone_created_idx" ON "registration_verification_challenges" USING btree ("phone","created_at");--> statement-breakpoint
CREATE INDEX "registration_verification_challenges_org_status_idx" ON "registration_verification_challenges" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX "registration_verification_challenges_existing_user_idx" ON "registration_verification_challenges" USING btree ("existing_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "registration_verification_challenges_provider_sid_unique" ON "registration_verification_challenges" USING btree ("provider_verification_sid") WHERE "registration_verification_challenges"."provider_verification_sid" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "email_change_requests_old_token_idx" ON "email_change_requests" USING btree ("old_email_token_hash");--> statement-breakpoint
ALTER TABLE "email_change_requests" ADD CONSTRAINT "email_change_requests_old_email_token_hash_unique" UNIQUE("old_email_token_hash");--> statement-breakpoint
ALTER TABLE "email_change_requests" ADD CONSTRAINT "email_change_requests_flow_version_check" CHECK ("email_change_requests"."flow_version" IN (1, 2));
--> statement-breakpoint
ALTER TABLE "admin_email_change_audits" ADD COLUMN "reason" text;
--> statement-breakpoint
ALTER TABLE "admin_email_change_audits" ADD COLUMN "old_mailbox_waived" boolean DEFAULT false NOT NULL;
