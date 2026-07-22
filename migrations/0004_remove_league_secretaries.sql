DROP TRIGGER IF EXISTS "users_org_change_revoke_secretaries" ON "users";--> statement-breakpoint
DROP FUNCTION IF EXISTS "users_org_change_revoke_secretaries_fn"();--> statement-breakpoint
DROP TABLE "league_secretaries";--> statement-breakpoint
DROP FUNCTION IF EXISTS "league_secretary_org_match_fn"();--> statement-breakpoint
DROP TABLE "league_secretary_audits";
