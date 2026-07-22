-- Clover never reached production use. Refuse the retirement if that assumption
-- is false so no customer or payment history can be discarded silently.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "payments" WHERE "type" = 'clover') THEN
    RAISE EXCEPTION 'Clover retirement blocked: payments.type contains clover rows';
  END IF;
  IF EXISTS (SELECT 1 FROM "payments" WHERE "clover_charge_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'Clover retirement blocked: payments.clover_charge_id contains data';
  END IF;
  IF EXISTS (SELECT 1 FROM "bowlers" WHERE "clover_customer_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'Clover retirement blocked: bowlers.clover_customer_id contains data';
  END IF;
  IF EXISTS (SELECT 1 FROM "locations" WHERE "payment_provider" IS DISTINCT FROM 'square') THEN
    RAISE EXCEPTION 'Clover retirement blocked: a location is not configured for Square';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "payment_schedules" ps
    JOIN "leagues" l ON l."id" = ps."league_id"
    JOIN "locations" loc ON loc."id" = l."location_id"
    WHERE ps."active" = true AND loc."payment_provider" = 'clover'
  ) THEN
    RAISE EXCEPTION 'Clover retirement blocked: an active schedule belongs to a Clover location';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "bowlers" DROP COLUMN "clover_customer_id";--> statement-breakpoint
ALTER TABLE "locations" DROP COLUMN "clover_credentials";--> statement-breakpoint
ALTER TABLE "locations" DROP COLUMN "payment_provider";--> statement-breakpoint
ALTER TABLE "payments" DROP COLUMN "clover_charge_id";
