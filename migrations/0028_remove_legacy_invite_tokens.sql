DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "users"
		WHERE "invite_token" IS NOT NULL OR "invite_token_expiry" IS NOT NULL
	) THEN
		RAISE EXCEPTION 'legacy invitation cleanup incomplete: users.invite_token markers remain';
	END IF;
END $$;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "invite_token";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "invite_token_expiry";
