ALTER TABLE "locations" ADD COLUMN IF NOT EXISTS "payment_provider" text DEFAULT 'square';
