ALTER TABLE "leagues" ADD COLUMN IF NOT EXISTS "payment_mode" text NOT NULL DEFAULT 'weekly';
