DROP TABLE "league_registration_questions" CASCADE;--> statement-breakpoint
DROP TABLE "league_registrations" CASCADE;--> statement-breakpoint
ALTER TABLE "leagues" DROP COLUMN "roster_cap";--> statement-breakpoint
ALTER TABLE "leagues" DROP COLUMN "embed_registration_fee";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN "allowed_embed_domains";