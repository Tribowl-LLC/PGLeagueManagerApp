ALTER TABLE "leagues" ADD COLUMN IF NOT EXISTS "total_bowling_weeks" integer;
ALTER TABLE "leagues" ADD COLUMN IF NOT EXISTS "skip_dates" text[] NOT NULL DEFAULT '{}';
ALTER TABLE "leagues" ADD COLUMN IF NOT EXISTS "cancelled_dates" text[] NOT NULL DEFAULT '{}';
