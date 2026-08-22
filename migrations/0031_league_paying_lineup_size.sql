ALTER TABLE "leagues" ADD COLUMN "paying_lineup_size" integer;--> statement-breakpoint
ALTER TABLE "leagues" ADD CONSTRAINT "leagues_paying_lineup_size_check" CHECK ("leagues"."paying_lineup_size" IS NULL OR "leagues"."paying_lineup_size" IN (3, 4));
