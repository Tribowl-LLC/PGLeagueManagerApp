ALTER TABLE "leagues" ADD COLUMN IF NOT EXISTS "double_pay_dates" text[] NOT NULL DEFAULT '{}';
