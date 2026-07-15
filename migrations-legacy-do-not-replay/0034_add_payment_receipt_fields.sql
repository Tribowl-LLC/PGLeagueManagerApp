-- Task #503: Square auto-emails a hosted receipt whenever CreatePayment is
-- called with a buyerEmailAddress, and refunds inherit the original payment's
-- email. We persist the URL + receipt number Square returns so the UI can
-- render a "View receipt" link without a second API round-trip, and we flag
-- paid Square rows that were created without a buyer email so admins can see
-- which charges silently skipped the receipt step.
ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "receipt_url" text;
--> statement-breakpoint
ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "receipt_number" text;
--> statement-breakpoint
ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "receipt_email_missing" boolean DEFAULT false NOT NULL;
