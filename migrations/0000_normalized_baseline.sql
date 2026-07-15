CREATE TYPE "public"."user_role" AS ENUM('system_admin', 'org_admin', 'user');--> statement-breakpoint
CREATE TABLE "admin_email_change_audits" (
	"id" serial PRIMARY KEY NOT NULL,
	"actor_user_id" integer NOT NULL,
	"target_user_id" integer NOT NULL,
	"old_email_masked" text NOT NULL,
	"new_email_masked" text NOT NULL,
	"email_change_request_id" integer,
	"post_confirm_payment_sync_status" text,
	"post_confirmed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_password_reset_audits" (
	"id" serial PRIMARY KEY NOT NULL,
	"actor_user_id" integer NOT NULL,
	"target_user_id" integer NOT NULL,
	"organization_id" integer,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_profile_edit_audits" (
	"id" serial PRIMARY KEY NOT NULL,
	"actor_user_id" integer NOT NULL,
	"target_user_id" integer NOT NULL,
	"field" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "admin_profile_edit_audits_field_check" CHECK ("admin_profile_edit_audits"."field" IN ('name', 'phone', 'preferred_language'))
);
--> statement-breakpoint
CREATE TABLE "admin_role_change_audits" (
	"id" serial PRIMARY KEY NOT NULL,
	"actor_user_id" integer NOT NULL,
	"target_user_id" integer NOT NULL,
	"organization_id" integer,
	"old_role" "user_role" NOT NULL,
	"new_role" "user_role" NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alerter_state" (
	"kind" text PRIMARY KEY NOT NULL,
	"last_sent_at" timestamp NOT NULL,
	"suppressed_count" integer DEFAULT 0 NOT NULL,
	"last_summary" jsonb,
	"last_summary_sent_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "apple_pay_job_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" integer NOT NULL,
	"organization_id" integer,
	"location_id" integer,
	"domain" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"message" text,
	"processed_at" timestamp,
	"claimed_at" timestamp,
	"recovered_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apple_pay_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"total_domains" integer DEFAULT 0 NOT NULL,
	"succeeded_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"created_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "bowler_leagues" (
	"id" serial PRIMARY KEY NOT NULL,
	"bowler_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"team_id" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bowler_payment_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"bowler_a_id" integer NOT NULL,
	"bowler_b_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_by_user_id" integer,
	"invited_at" timestamp DEFAULT now() NOT NULL,
	"responded_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "bowlers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"active" boolean DEFAULT true NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"organization_id" integer NOT NULL,
	"payment_customer_id" text,
	"clover_customer_id" text,
	"payment_provider_location_id" integer,
	"bn_contact_id" text,
	"payment_sync_pending_at" timestamp,
	"payment_sync_attempts" integer DEFAULT 0 NOT NULL,
	"payment_sync_last_attempt_at" timestamp,
	"bn_sync_pending_at" timestamp,
	"bn_sync_attempts" integer DEFAULT 0 NOT NULL,
	"bn_sync_last_attempt_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "deletion_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"reason" text,
	"ip_address" text,
	"user_agent" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"admin_note" text,
	"reviewed_by" integer,
	"reviewed_at" timestamp,
	"execution_summary" text,
	"notify_on_completion" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_change_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"new_email" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"consumed_at" timestamp,
	CONSTRAINT "email_change_requests_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "email_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "email_templates_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "games" (
	"id" serial PRIMARY KEY NOT NULL,
	"league_id" integer NOT NULL,
	"week_number" integer NOT NULL,
	"game_number" integer NOT NULL,
	"date" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "league_registration_questions" (
	"id" serial PRIMARY KEY NOT NULL,
	"league_id" integer NOT NULL,
	"label" text NOT NULL,
	"type" text NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"options" text[] DEFAULT '{}' NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "league_registrations" (
	"id" serial PRIMARY KEY NOT NULL,
	"league_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"bowler_id" integer NOT NULL,
	"payment_id" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"source" text DEFAULT 'embed' NOT NULL,
	"answers" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "league_secretaries" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"granted_by_user_id" integer NOT NULL,
	"granted_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "league_secretary_audits" (
	"id" serial PRIMARY KEY NOT NULL,
	"actor_user_id" integer NOT NULL,
	"target_user_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"action" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leagues" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"active" boolean DEFAULT true NOT NULL,
	"allow_public_signup" boolean DEFAULT false NOT NULL,
	"season_start" timestamp NOT NULL,
	"season_end" timestamp NOT NULL,
	"week_day" text NOT NULL,
	"weekly_fee" integer DEFAULT 2000 NOT NULL,
	"lineage_fee" integer,
	"prize_fund_fee" integer,
	"practice_start_time" text,
	"competition_start_time" text,
	"square_lineage_item_id" text,
	"lineage_item_variation_id" text,
	"square_lineage_item_name" text,
	"square_prize_fund_item_id" text,
	"prize_fund_item_variation_id" text,
	"square_prize_fund_item_name" text,
	"square_category_id" text,
	"timezone" text DEFAULT 'America/Chicago',
	"payment_mode" text DEFAULT 'weekly' NOT NULL,
	"season_number" integer DEFAULT 1 NOT NULL,
	"previous_season_id" integer,
	"organization_id" integer,
	"location_id" integer,
	"total_bowling_weeks" integer,
	"final_two_weeks_due_week" integer,
	"skip_dates" text[] DEFAULT '{}' NOT NULL,
	"cancelled_dates" text[] DEFAULT '{}' NOT NULL,
	"double_pay_dates" text[] DEFAULT '{}' NOT NULL,
	"roster_cap" integer,
	"embed_registration_fee" integer
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"city" text,
	"state" text,
	"zip_code" text,
	"phone" text,
	"active" boolean DEFAULT true NOT NULL,
	"organization_id" integer NOT NULL,
	"square_credentials" jsonb,
	"clover_credentials" jsonb,
	"payment_provider" text DEFAULT 'square'
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"subdomain" text,
	"address" text,
	"city" text,
	"state" text,
	"zip_code" text,
	"phone" text,
	"email" text,
	"logo" text,
	"dark_logo" text,
	"app_icon" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"integrations" jsonb,
	"allowed_embed_domains" text[] DEFAULT '{}' NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "orphan_cleanup_audits" (
	"id" serial PRIMARY KEY NOT NULL,
	"admin_user_id" integer NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" integer NOT NULL,
	"action" text NOT NULL,
	"organization_id" integer,
	"previous_organization_id" integer,
	"snapshot" jsonb,
	"undone_at" timestamp,
	"undone_by_audit_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_schedules" (
	"id" serial PRIMARY KEY NOT NULL,
	"bowler_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"frequency" text NOT NULL,
	"amount" integer NOT NULL,
	"next_payment_date" timestamp NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_payment_date" timestamp,
	"payment_card_id" text NOT NULL,
	"cancelled_at" timestamp,
	"cancel_reason" text,
	"additional_bowler_ids" integer[]
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"bowler_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"amount" integer NOT NULL,
	"lineage_amount" integer,
	"prize_fund_amount" integer,
	"week_of" timestamp NOT NULL,
	"status" text DEFAULT 'paid' NOT NULL,
	"type" text NOT NULL,
	"check_number" text,
	"provider_payment_id" text,
	"clover_charge_id" text,
	"idempotency_key" text,
	"square_refund_id" text,
	"refund_reason" text,
	"refunded_at" timestamp,
	"dispute_id" text,
	"disputed_at" timestamp,
	"receipt_url" text,
	"receipt_number" text,
	"receipt_email_missing" boolean DEFAULT false NOT NULL,
	"notes" text,
	"paid_by_user_id" integer,
	"combined_charge_group_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "payments_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "rate_limit_buckets" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"reset_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scores" (
	"id" serial PRIMARY KEY NOT NULL,
	"game_id" integer NOT NULL,
	"bowler_id" integer NOT NULL,
	"team_id" integer NOT NULL,
	"score" integer NOT NULL,
	"handicap" integer NOT NULL,
	"average" integer NOT NULL,
	"position" integer NOT NULL,
	"is_vacant" boolean DEFAULT false NOT NULL,
	"is_absent" boolean DEFAULT false NOT NULL,
	"is_sub" boolean DEFAULT false NOT NULL,
	"lane_number" integer NOT NULL,
	"frames" text[] DEFAULT '{}' NOT NULL,
	"splits" text[] DEFAULT '{}' NOT NULL,
	"notes" text[] DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"sid" varchar PRIMARY KEY NOT NULL,
	"sess" json NOT NULL,
	"expire" timestamp (6) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"number" integer NOT NULL,
	"league_id" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password" text NOT NULL,
	"bowler_id" integer,
	"name" text NOT NULL,
	"phone" text,
	"avatar" text,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"organization_id" integer,
	"location_id" integer,
	"invite_token" text,
	"invite_token_expiry" timestamp,
	"preferred_language" text,
	"failed_password_change_attempts" integer DEFAULT 0 NOT NULL,
	"password_change_locked_until" timestamp,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "admin_email_change_audits" ADD CONSTRAINT "admin_email_change_audits_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_email_change_audits" ADD CONSTRAINT "admin_email_change_audits_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_email_change_audits" ADD CONSTRAINT "admin_email_change_audits_email_change_request_id_email_change_requests_id_fk" FOREIGN KEY ("email_change_request_id") REFERENCES "public"."email_change_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_password_reset_audits" ADD CONSTRAINT "admin_password_reset_audits_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_password_reset_audits" ADD CONSTRAINT "admin_password_reset_audits_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_password_reset_audits" ADD CONSTRAINT "admin_password_reset_audits_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_profile_edit_audits" ADD CONSTRAINT "admin_profile_edit_audits_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_profile_edit_audits" ADD CONSTRAINT "admin_profile_edit_audits_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_role_change_audits" ADD CONSTRAINT "admin_role_change_audits_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_role_change_audits" ADD CONSTRAINT "admin_role_change_audits_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_role_change_audits" ADD CONSTRAINT "admin_role_change_audits_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apple_pay_job_items" ADD CONSTRAINT "apple_pay_job_items_job_id_apple_pay_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."apple_pay_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apple_pay_job_items" ADD CONSTRAINT "apple_pay_job_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apple_pay_job_items" ADD CONSTRAINT "apple_pay_job_items_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apple_pay_jobs" ADD CONSTRAINT "apple_pay_jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bowler_leagues" ADD CONSTRAINT "bowler_leagues_bowler_id_bowlers_id_fk" FOREIGN KEY ("bowler_id") REFERENCES "public"."bowlers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bowler_leagues" ADD CONSTRAINT "bowler_leagues_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bowler_leagues" ADD CONSTRAINT "bowler_leagues_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bowler_payment_links" ADD CONSTRAINT "bowler_payment_links_bowler_a_id_bowlers_id_fk" FOREIGN KEY ("bowler_a_id") REFERENCES "public"."bowlers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bowler_payment_links" ADD CONSTRAINT "bowler_payment_links_bowler_b_id_bowlers_id_fk" FOREIGN KEY ("bowler_b_id") REFERENCES "public"."bowlers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bowler_payment_links" ADD CONSTRAINT "bowler_payment_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bowler_payment_links" ADD CONSTRAINT "bowler_payment_links_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bowlers" ADD CONSTRAINT "bowlers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bowlers" ADD CONSTRAINT "bowlers_payment_provider_location_id_locations_id_fk" FOREIGN KEY ("payment_provider_location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD CONSTRAINT "deletion_requests_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_change_requests" ADD CONSTRAINT "email_change_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_registration_questions" ADD CONSTRAINT "league_registration_questions_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_registrations" ADD CONSTRAINT "league_registrations_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_registrations" ADD CONSTRAINT "league_registrations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_registrations" ADD CONSTRAINT "league_registrations_bowler_id_bowlers_id_fk" FOREIGN KEY ("bowler_id") REFERENCES "public"."bowlers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_registrations" ADD CONSTRAINT "league_registrations_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_secretaries" ADD CONSTRAINT "league_secretaries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_secretaries" ADD CONSTRAINT "league_secretaries_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_secretaries" ADD CONSTRAINT "league_secretaries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_secretaries" ADD CONSTRAINT "league_secretaries_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_secretary_audits" ADD CONSTRAINT "league_secretary_audits_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_secretary_audits" ADD CONSTRAINT "league_secretary_audits_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_secretary_audits" ADD CONSTRAINT "league_secretary_audits_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_secretary_audits" ADD CONSTRAINT "league_secretary_audits_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leagues" ADD CONSTRAINT "leagues_previous_season_id_leagues_id_fk" FOREIGN KEY ("previous_season_id") REFERENCES "public"."leagues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leagues" ADD CONSTRAINT "leagues_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leagues" ADD CONSTRAINT "leagues_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orphan_cleanup_audits" ADD CONSTRAINT "orphan_cleanup_audits_admin_user_id_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orphan_cleanup_audits" ADD CONSTRAINT "orphan_cleanup_audits_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orphan_cleanup_audits" ADD CONSTRAINT "orphan_cleanup_audits_previous_organization_id_organizations_id_fk" FOREIGN KEY ("previous_organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orphan_cleanup_audits" ADD CONSTRAINT "orphan_cleanup_audits_undone_by_audit_id_orphan_cleanup_audits_id_fk" FOREIGN KEY ("undone_by_audit_id") REFERENCES "public"."orphan_cleanup_audits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_schedules" ADD CONSTRAINT "payment_schedules_bowler_id_bowlers_id_fk" FOREIGN KEY ("bowler_id") REFERENCES "public"."bowlers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_schedules" ADD CONSTRAINT "payment_schedules_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_bowler_id_bowlers_id_fk" FOREIGN KEY ("bowler_id") REFERENCES "public"."bowlers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_paid_by_user_id_users_id_fk" FOREIGN KEY ("paid_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_bowler_id_bowlers_id_fk" FOREIGN KEY ("bowler_id") REFERENCES "public"."bowlers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_bowler_id_bowlers_id_fk" FOREIGN KEY ("bowler_id") REFERENCES "public"."bowlers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_email_change_audits_created_at_idx" ON "admin_email_change_audits" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "admin_email_change_audits_target_idx" ON "admin_email_change_audits" USING btree ("target_user_id");--> statement-breakpoint
CREATE INDEX "admin_email_change_audits_request_idx" ON "admin_email_change_audits" USING btree ("email_change_request_id");--> statement-breakpoint
CREATE INDEX "admin_password_reset_audits_created_at_idx" ON "admin_password_reset_audits" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "admin_password_reset_audits_target_idx" ON "admin_password_reset_audits" USING btree ("target_user_id");--> statement-breakpoint
CREATE INDEX "admin_password_reset_audits_actor_idx" ON "admin_password_reset_audits" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "admin_profile_edit_audits_created_at_idx" ON "admin_profile_edit_audits" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "admin_profile_edit_audits_target_idx" ON "admin_profile_edit_audits" USING btree ("target_user_id");--> statement-breakpoint
CREATE INDEX "admin_profile_edit_audits_actor_idx" ON "admin_profile_edit_audits" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "admin_role_change_audits_created_at_idx" ON "admin_role_change_audits" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "admin_role_change_audits_target_idx" ON "admin_role_change_audits" USING btree ("target_user_id");--> statement-breakpoint
CREATE INDEX "admin_role_change_audits_actor_idx" ON "admin_role_change_audits" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "apple_pay_job_items_job_id_idx" ON "apple_pay_job_items" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "apple_pay_job_items_job_status_idx" ON "apple_pay_job_items" USING btree ("job_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "apple_pay_job_items_unique_idx" ON "apple_pay_job_items" USING btree ("job_id",COALESCE("organization_id", 0),COALESCE("location_id", 0),"domain");--> statement-breakpoint
CREATE INDEX "apple_pay_jobs_status_idx" ON "apple_pay_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "apple_pay_jobs_created_at_idx" ON "apple_pay_jobs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "bowler_leagues_bowler_id_index" ON "bowler_leagues" USING btree ("bowler_id");--> statement-breakpoint
CREATE INDEX "bowler_leagues_league_id_index" ON "bowler_leagues" USING btree ("league_id");--> statement-breakpoint
CREATE INDEX "bowler_leagues_team_id_index" ON "bowler_leagues" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "bowler_leagues_team_id_league_id_order_index" ON "bowler_leagues" USING btree ("team_id","league_id","order");--> statement-breakpoint
CREATE INDEX "bowler_leagues_active_unique_idx" ON "bowler_leagues" USING btree ("bowler_id","league_id","team_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "bowler_payment_links_pair_unique_idx" ON "bowler_payment_links" USING btree ("bowler_a_id","bowler_b_id");--> statement-breakpoint
CREATE INDEX "bowler_payment_links_a_idx" ON "bowler_payment_links" USING btree ("bowler_a_id");--> statement-breakpoint
CREATE INDEX "bowler_payment_links_b_idx" ON "bowler_payment_links" USING btree ("bowler_b_id");--> statement-breakpoint
CREATE INDEX "bowler_payment_links_org_idx" ON "bowler_payment_links" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "deletion_requests_status_idx" ON "deletion_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "deletion_requests_email_idx" ON "deletion_requests" USING btree ("email");--> statement-breakpoint
CREATE INDEX "deletion_requests_created_at_idx" ON "deletion_requests" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "email_change_requests_user_idx" ON "email_change_requests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "league_game_idx" ON "games" USING btree ("league_id","week_number","game_number");--> statement-breakpoint
CREATE INDEX "game_date_idx" ON "games" USING btree ("date");--> statement-breakpoint
CREATE INDEX "league_reg_questions_league_idx" ON "league_registration_questions" USING btree ("league_id");--> statement-breakpoint
CREATE INDEX "league_registrations_league_idx" ON "league_registrations" USING btree ("league_id");--> statement-breakpoint
CREATE INDEX "league_registrations_org_idx" ON "league_registrations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "league_registrations_bowler_idx" ON "league_registrations" USING btree ("bowler_id");--> statement-breakpoint
CREATE INDEX "league_secretaries_user_idx" ON "league_secretaries" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "league_secretaries_league_idx" ON "league_secretaries" USING btree ("league_id");--> statement-breakpoint
CREATE INDEX "league_secretaries_org_idx" ON "league_secretaries" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "league_secretaries_user_league_uniq" ON "league_secretaries" USING btree ("user_id","league_id");--> statement-breakpoint
CREATE INDEX "league_secretary_audits_created_at_idx" ON "league_secretary_audits" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "league_secretary_audits_league_idx" ON "league_secretary_audits" USING btree ("league_id");--> statement-breakpoint
CREATE INDEX "league_secretary_audits_target_idx" ON "league_secretary_audits" USING btree ("target_user_id");--> statement-breakpoint
CREATE INDEX "league_secretary_audits_actor_idx" ON "league_secretary_audits" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "leagues_active_name_idx" ON "leagues" USING btree ("active","name");--> statement-breakpoint
CREATE INDEX "leagues_season_idx" ON "leagues" USING btree ("season_start","season_end");--> statement-breakpoint
CREATE INDEX "leagues_organization_idx" ON "leagues" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "leagues_location_idx" ON "leagues" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "locations_organization_idx" ON "locations" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_slug_idx" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_subdomain_idx" ON "organizations" USING btree ("subdomain") WHERE "organizations"."subdomain" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "orphan_cleanup_audits_created_at_idx" ON "orphan_cleanup_audits" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "orphan_cleanup_audits_resource_idx" ON "orphan_cleanup_audits" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "bowler_schedule_idx" ON "payment_schedules" USING btree ("bowler_id","league_id");--> statement-breakpoint
CREATE INDEX "next_payment_idx" ON "payment_schedules" USING btree ("next_payment_date");--> statement-breakpoint
CREATE INDEX "active_schedule_idx" ON "payment_schedules" USING btree ("active");--> statement-breakpoint
CREATE INDEX "payments_bowler_idx" ON "payments" USING btree ("bowler_id");--> statement-breakpoint
CREATE INDEX "payments_league_idx" ON "payments" USING btree ("league_id");--> statement-breakpoint
CREATE INDEX "payments_week_of_idx" ON "payments" USING btree ("week_of");--> statement-breakpoint
CREATE INDEX "payments_paid_by_user_idx" ON "payments" USING btree ("paid_by_user_id");--> statement-breakpoint
CREATE INDEX "payments_combined_group_idx" ON "payments" USING btree ("combined_charge_group_id");--> statement-breakpoint
CREATE INDEX "rate_limit_buckets_reset_at_idx" ON "rate_limit_buckets" USING btree ("reset_at");--> statement-breakpoint
CREATE INDEX "game_score_idx" ON "scores" USING btree ("game_id","team_id","position");--> statement-breakpoint
CREATE INDEX "bowler_score_idx" ON "scores" USING btree ("bowler_id");--> statement-breakpoint
CREATE INDEX "lane_number_idx" ON "scores" USING btree ("lane_number");--> statement-breakpoint
CREATE INDEX "IDX_session_expire" ON "session" USING btree ("expire");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_league_number_idx" ON "teams" USING btree ("league_id","number");--> statement-breakpoint
CREATE INDEX "users_organization_idx" ON "users" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "users_bowler_idx" ON "users" USING btree ("bowler_id");--> statement-breakpoint
CREATE INDEX "users_location_idx" ON "users" USING btree ("location_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION users_role_org_required_fn()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.role <> 'system_admin' AND NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'users_role_org_required: non-admin users must have organization_id'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION league_secretary_org_match_fn()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  league_org_id integer;
  user_org_id integer;
BEGIN
  SELECT organization_id INTO league_org_id FROM leagues WHERE id = NEW.league_id;
  IF league_org_id IS NULL THEN
    RAISE EXCEPTION 'league_secretary_org_match: league % has no organization_id (org-less rows are not eligible for secretary grants)', NEW.league_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.organization_id <> league_org_id THEN
    RAISE EXCEPTION 'league_secretary_org_match: league_secretaries.organization_id (%) must match league %.organization_id (%)', NEW.organization_id, NEW.league_id, league_org_id
      USING ERRCODE = 'check_violation';
  END IF;
  -- Defence in depth: the granted user must belong to the same
  -- organization as the league. The route layer also enforces this
  -- (USER_NOT_IN_ORG), but a buggy bypass or direct SQL operation
  -- could otherwise grant a cross-tenant user per-league powers.
  SELECT organization_id INTO user_org_id FROM users WHERE id = NEW.user_id;
  IF user_org_id IS NULL THEN
    RAISE EXCEPTION 'league_secretary_org_match: user % has no organization_id (org-less users are not eligible for secretary grants)', NEW.user_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF user_org_id <> league_org_id THEN
    RAISE EXCEPTION 'league_secretary_org_match: user %.organization_id (%) must match league %.organization_id (%)', NEW.user_id, user_org_id, NEW.league_id, league_org_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION users_org_change_revoke_secretaries_fn()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.organization_id IS DISTINCT FROM NEW.organization_id THEN
    DELETE FROM league_secretaries WHERE user_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER users_role_org_required
BEFORE INSERT OR UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION users_role_org_required_fn();--> statement-breakpoint
CREATE TRIGGER league_secretaries_org_match
BEFORE INSERT OR UPDATE ON league_secretaries
FOR EACH ROW
EXECUTE FUNCTION league_secretary_org_match_fn();--> statement-breakpoint
CREATE TRIGGER users_org_change_revoke_secretaries
AFTER UPDATE OF organization_id ON users
FOR EACH ROW
EXECUTE FUNCTION users_org_change_revoke_secretaries_fn();
