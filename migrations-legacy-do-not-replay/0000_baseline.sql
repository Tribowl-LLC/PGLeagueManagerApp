CREATE TYPE "public"."user_role" AS ENUM('system_admin', 'org_admin', 'user');--> statement-breakpoint
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
CREATE TABLE "bowlers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"active" boolean DEFAULT true NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"payment_customer_id" text,
	"cardpointe_profile_id" text,
	"bn_contact_id" text
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
	"created_at" timestamp DEFAULT now() NOT NULL
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
	"final_two_weeks_due_week" integer DEFAULT 6,
	"payment_mode" text DEFAULT 'weekly' NOT NULL,
	"season_number" integer DEFAULT 1 NOT NULL,
	"previous_season_id" integer,
	"organization_id" integer,
	"location_id" integer,
	"total_bowling_weeks" integer,
	"skip_dates" text[] DEFAULT '{}' NOT NULL,
	"cancelled_dates" text[] DEFAULT '{}' NOT NULL
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
	"cardpointe_credentials" jsonb,
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
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
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
	"cancel_reason" text
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
	"cardpointe_retref" text,
	"cardpointe_authcode" text,
	"idempotency_key" text,
	"square_refund_id" text,
	"refund_reason" text,
	"refunded_at" timestamp,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "payments_idempotency_key_unique" UNIQUE("idempotency_key")
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
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "bowler_leagues" ADD CONSTRAINT "bowler_leagues_bowler_id_bowlers_id_fk" FOREIGN KEY ("bowler_id") REFERENCES "public"."bowlers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bowler_leagues" ADD CONSTRAINT "bowler_leagues_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bowler_leagues" ADD CONSTRAINT "bowler_leagues_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD CONSTRAINT "deletion_requests_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leagues" ADD CONSTRAINT "leagues_previous_season_id_leagues_id_fk" FOREIGN KEY ("previous_season_id") REFERENCES "public"."leagues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leagues" ADD CONSTRAINT "leagues_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leagues" ADD CONSTRAINT "leagues_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_schedules" ADD CONSTRAINT "payment_schedules_bowler_id_bowlers_id_fk" FOREIGN KEY ("bowler_id") REFERENCES "public"."bowlers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_schedules" ADD CONSTRAINT "payment_schedules_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_bowler_id_bowlers_id_fk" FOREIGN KEY ("bowler_id") REFERENCES "public"."bowlers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_bowler_id_bowlers_id_fk" FOREIGN KEY ("bowler_id") REFERENCES "public"."bowlers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_bowler_id_bowlers_id_fk" FOREIGN KEY ("bowler_id") REFERENCES "public"."bowlers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bowler_leagues_bowler_id_index" ON "bowler_leagues" USING btree ("bowler_id");--> statement-breakpoint
CREATE INDEX "bowler_leagues_league_id_index" ON "bowler_leagues" USING btree ("league_id");--> statement-breakpoint
CREATE INDEX "bowler_leagues_team_id_index" ON "bowler_leagues" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "bowler_leagues_team_id_league_id_order_index" ON "bowler_leagues" USING btree ("team_id","league_id","order");--> statement-breakpoint
CREATE INDEX "bowler_leagues_active_unique_idx" ON "bowler_leagues" USING btree ("bowler_id","league_id","team_id","active");--> statement-breakpoint
CREATE INDEX "deletion_requests_status_idx" ON "deletion_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "deletion_requests_email_idx" ON "deletion_requests" USING btree ("email");--> statement-breakpoint
CREATE INDEX "deletion_requests_created_at_idx" ON "deletion_requests" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "league_game_idx" ON "games" USING btree ("league_id","week_number","game_number");--> statement-breakpoint
CREATE INDEX "game_date_idx" ON "games" USING btree ("date");--> statement-breakpoint
CREATE INDEX "leagues_active_name_idx" ON "leagues" USING btree ("active","name");--> statement-breakpoint
CREATE INDEX "leagues_season_idx" ON "leagues" USING btree ("season_start","season_end");--> statement-breakpoint
CREATE INDEX "leagues_organization_idx" ON "leagues" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "leagues_location_idx" ON "leagues" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "locations_organization_idx" ON "locations" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_slug_idx" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_subdomain_idx" ON "organizations" USING btree ("subdomain");--> statement-breakpoint
CREATE INDEX "bowler_schedule_idx" ON "payment_schedules" USING btree ("bowler_id","league_id");--> statement-breakpoint
CREATE INDEX "next_payment_idx" ON "payment_schedules" USING btree ("next_payment_date");--> statement-breakpoint
CREATE INDEX "active_schedule_idx" ON "payment_schedules" USING btree ("active");--> statement-breakpoint
CREATE INDEX "payments_bowler_idx" ON "payments" USING btree ("bowler_id");--> statement-breakpoint
CREATE INDEX "payments_league_idx" ON "payments" USING btree ("league_id");--> statement-breakpoint
CREATE INDEX "payments_week_of_idx" ON "payments" USING btree ("week_of");--> statement-breakpoint
CREATE INDEX "game_score_idx" ON "scores" USING btree ("game_id","team_id","position");--> statement-breakpoint
CREATE INDEX "bowler_score_idx" ON "scores" USING btree ("bowler_id");--> statement-breakpoint
CREATE INDEX "lane_number_idx" ON "scores" USING btree ("lane_number");--> statement-breakpoint
CREATE INDEX "IDX_session_expire" ON "session" USING btree ("expire");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_league_number_idx" ON "teams" USING btree ("league_id","number");--> statement-breakpoint
CREATE INDEX "users_organization_idx" ON "users" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "users_bowler_idx" ON "users" USING btree ("bowler_id");--> statement-breakpoint
CREATE INDEX "users_location_idx" ON "users" USING btree ("location_id");