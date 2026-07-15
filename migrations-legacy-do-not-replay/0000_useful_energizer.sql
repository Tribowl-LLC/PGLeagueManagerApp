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
	"active" boolean DEFAULT true NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"square_customer_id" text,
	"qubica_id" text,
	CONSTRAINT "bowlers_qubica_id_unique" UNIQUE("qubica_id")
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
	"season_start" timestamp NOT NULL,
	"season_end" timestamp NOT NULL,
	"week_day" text NOT NULL,
	"weekly_fee" integer DEFAULT 2000 NOT NULL,
	"practice_start_time" text,
	"competition_start_time" text,
	"qubica_id" text,
	CONSTRAINT "leagues_qubica_id_unique" UNIQUE("qubica_id")
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
	"square_card_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"bowler_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"amount" integer NOT NULL,
	"week_of" timestamp NOT NULL,
	"status" text DEFAULT 'paid' NOT NULL,
	"type" text NOT NULL,
	"check_number" text,
	"square_payment_id" text,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
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
CREATE TABLE "series" (
	"id" serial PRIMARY KEY NOT NULL,
	"league_id" integer NOT NULL,
	"week_number" integer NOT NULL,
	"series_date" timestamp NOT NULL,
	"is_complete" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"number" integer NOT NULL,
	"league_id" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password" text NOT NULL,
	"bowler_id" integer,
	"name" text NOT NULL,
	"phone" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "weekly_stats" (
	"id" serial PRIMARY KEY NOT NULL,
	"series_id" integer NOT NULL,
	"bowler_league_id" integer NOT NULL,
	"average" integer NOT NULL,
	"handicap" integer NOT NULL,
	"games_played" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bowler_leagues" ADD CONSTRAINT "bowler_leagues_bowler_id_bowlers_id_fk" FOREIGN KEY ("bowler_id") REFERENCES "public"."bowlers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bowler_leagues" ADD CONSTRAINT "bowler_leagues_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bowler_leagues" ADD CONSTRAINT "bowler_leagues_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_schedules" ADD CONSTRAINT "payment_schedules_bowler_id_bowlers_id_fk" FOREIGN KEY ("bowler_id") REFERENCES "public"."bowlers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_schedules" ADD CONSTRAINT "payment_schedules_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_bowler_id_bowlers_id_fk" FOREIGN KEY ("bowler_id") REFERENCES "public"."bowlers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_bowler_id_bowlers_id_fk" FOREIGN KEY ("bowler_id") REFERENCES "public"."bowlers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series" ADD CONSTRAINT "series_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_bowler_id_bowlers_id_fk" FOREIGN KEY ("bowler_id") REFERENCES "public"."bowlers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_stats" ADD CONSTRAINT "weekly_stats_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_stats" ADD CONSTRAINT "weekly_stats_bowler_league_id_bowler_leagues_id_fk" FOREIGN KEY ("bowler_league_id") REFERENCES "public"."bowler_leagues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bowler_leagues_bowler_id_index" ON "bowler_leagues" USING btree ("bowler_id");--> statement-breakpoint
CREATE INDEX "bowler_leagues_league_id_index" ON "bowler_leagues" USING btree ("league_id");--> statement-breakpoint
CREATE INDEX "bowler_leagues_team_id_index" ON "bowler_leagues" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "bowler_leagues_team_id_league_id_order_index" ON "bowler_leagues" USING btree ("team_id","league_id","order");--> statement-breakpoint
CREATE INDEX "bowler_leagues_active_unique_idx" ON "bowler_leagues" USING btree ("bowler_id","league_id","team_id","active");--> statement-breakpoint
CREATE INDEX "league_game_idx" ON "games" USING btree ("league_id","week_number","game_number");--> statement-breakpoint
CREATE INDEX "game_date_idx" ON "games" USING btree ("date");--> statement-breakpoint
CREATE INDEX "leagues_active_name_idx" ON "leagues" USING btree ("active","name");--> statement-breakpoint
CREATE INDEX "leagues_season_idx" ON "leagues" USING btree ("season_start","season_end");--> statement-breakpoint
CREATE INDEX "bowler_schedule_idx" ON "payment_schedules" USING btree ("bowler_id","league_id");--> statement-breakpoint
CREATE INDEX "next_payment_idx" ON "payment_schedules" USING btree ("next_payment_date");--> statement-breakpoint
CREATE INDEX "active_schedule_idx" ON "payment_schedules" USING btree ("active");--> statement-breakpoint
CREATE INDEX "game_score_idx" ON "scores" USING btree ("game_id","team_id","position");--> statement-breakpoint
CREATE INDEX "bowler_score_idx" ON "scores" USING btree ("bowler_id");--> statement-breakpoint
CREATE INDEX "lane_number_idx" ON "scores" USING btree ("lane_number");--> statement-breakpoint
CREATE INDEX "league_series_idx" ON "series" USING btree ("league_id","week_number");--> statement-breakpoint
CREATE INDEX "teams_league_number_idx" ON "teams" USING btree ("league_id","number");--> statement-breakpoint
CREATE INDEX "series_stats_idx" ON "weekly_stats" USING btree ("series_id");--> statement-breakpoint
CREATE INDEX "bowler_stats_idx" ON "weekly_stats" USING btree ("bowler_league_id");