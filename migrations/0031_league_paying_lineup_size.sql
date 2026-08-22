ALTER TABLE "leagues" ADD COLUMN "paying_lineup_size" integer;--> statement-breakpoint
UPDATE "leagues" AS "league"
SET "paying_lineup_size" = "activation"."paying_lineup_size"
FROM "financial_activations" AS "activation"
WHERE "activation"."league_id" = "league"."id"
  AND "activation"."organization_id" = "league"."organization_id"
  AND "activation"."state" = 'active'
  AND "activation"."completeness_marker" = true
  AND "activation"."paying_lineup_size" IN (3, 4)
  AND NOT EXISTS (
    SELECT 1
    FROM "financial_activations" AS "conflict"
    WHERE "conflict"."league_id" = "activation"."league_id"
      AND "conflict"."organization_id" = "activation"."organization_id"
      AND "conflict"."state" = 'active'
      AND "conflict"."completeness_marker" = true
      AND "conflict"."paying_lineup_size" IN (3, 4)
      AND "conflict"."paying_lineup_size" <> "activation"."paying_lineup_size"
  )
  AND "league"."paying_lineup_size" IS NULL;--> statement-breakpoint
ALTER TABLE "leagues" ADD CONSTRAINT "leagues_paying_lineup_size_check" CHECK ("leagues"."paying_lineup_size" IS NULL OR "leagues"."paying_lineup_size" IN (3, 4));
