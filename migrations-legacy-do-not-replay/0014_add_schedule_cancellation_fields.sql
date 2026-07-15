ALTER TABLE "payment_schedules" ADD COLUMN "cancelled_at" timestamp;
ALTER TABLE "payment_schedules" ADD COLUMN "cancel_reason" text;
