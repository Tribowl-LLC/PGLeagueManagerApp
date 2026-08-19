DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "users"
		GROUP BY lower(btrim("email"))
		HAVING count(*) > 1
	) THEN
		RAISE EXCEPTION 'identity-integrity preflight failed: duplicate normalized user emails';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "users"
		WHERE "bowler_id" IS NOT NULL
		GROUP BY "bowler_id"
		HAVING count(*) > 1
	) THEN
		RAISE EXCEPTION 'identity-integrity preflight failed: duplicate user-to-bowler claims';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "users" u
		JOIN "bowlers" b ON b."id" = u."bowler_id"
		WHERE u."organization_id" IS DISTINCT FROM b."organization_id"
	) THEN
		RAISE EXCEPTION 'identity-integrity preflight failed: cross-organization user-to-bowler link';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "users" u
		JOIN "locations" l ON l."id" = u."location_id"
		WHERE u."organization_id" IS DISTINCT FROM l."organization_id"
	) THEN
		RAISE EXCEPTION 'identity-integrity preflight failed: cross-organization user-to-location assignment';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "users"
		WHERE "bowler_id" IS NOT NULL
			AND "role"::text IN ('system_admin', 'org_admin', 'payment_manager')
	) THEN
		RAISE EXCEPTION 'identity-integrity preflight failed: staff account linked to a bowler';
	END IF;
END $$;--> statement-breakpoint
ALTER TYPE "public"."user_role" ADD VALUE 'payment_manager' BEFORE 'user';--> statement-breakpoint
CREATE TABLE "account_action_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"organization_id" integer,
	"created_by_user_id" integer,
	"action" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"delivery_status" text DEFAULT 'not_attempted' NOT NULL,
	"delivery_attempted_at" timestamp,
	"delivered_at" timestamp,
	"consumed_at" timestamp,
	"superseded_at" timestamp,
	"revoked_at" timestamp,
	"expired_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "account_action_requests_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "account_action_requests_action_check" CHECK ("account_action_requests"."action" IN ('account_invite', 'password_reset')),
	CONSTRAINT "account_action_requests_status_check" CHECK ("account_action_requests"."status" IN ('pending', 'consumed', 'superseded', 'revoked', 'expired')),
	CONSTRAINT "account_action_requests_delivery_status_check" CHECK ("account_action_requests"."delivery_status" IN ('not_attempted', 'sent', 'failed')),
	CONSTRAINT "account_action_requests_lifecycle_check" CHECK ((
      "account_action_requests"."status" = 'pending'
      AND "account_action_requests"."consumed_at" IS NULL
      AND "account_action_requests"."superseded_at" IS NULL
      AND "account_action_requests"."revoked_at" IS NULL
      AND "account_action_requests"."expired_at" IS NULL
    ) OR (
      "account_action_requests"."status" = 'consumed'
      AND "account_action_requests"."consumed_at" IS NOT NULL
      AND "account_action_requests"."superseded_at" IS NULL
      AND "account_action_requests"."revoked_at" IS NULL
      AND "account_action_requests"."expired_at" IS NULL
    ) OR (
      "account_action_requests"."status" = 'superseded'
      AND "account_action_requests"."consumed_at" IS NULL
      AND "account_action_requests"."superseded_at" IS NOT NULL
      AND "account_action_requests"."revoked_at" IS NULL
      AND "account_action_requests"."expired_at" IS NULL
    ) OR (
      "account_action_requests"."status" = 'revoked'
      AND "account_action_requests"."consumed_at" IS NULL
      AND "account_action_requests"."superseded_at" IS NULL
      AND "account_action_requests"."revoked_at" IS NOT NULL
      AND "account_action_requests"."expired_at" IS NULL
    ) OR (
      "account_action_requests"."status" = 'expired'
      AND "account_action_requests"."consumed_at" IS NULL
      AND "account_action_requests"."superseded_at" IS NULL
      AND "account_action_requests"."revoked_at" IS NULL
      AND "account_action_requests"."expired_at" IS NOT NULL
    )),
	CONSTRAINT "account_action_requests_delivery_timestamp_check" CHECK ("account_action_requests"."delivery_status" <> 'sent' OR "account_action_requests"."delivered_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "identity_link_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"actor_user_id" integer,
	"subject_user_id" integer NOT NULL,
	"user_id" integer,
	"bowler_id" integer,
	"old_bowler_id" integer,
	"new_bowler_id" integer,
	"event_type" text NOT NULL,
	"old_bowler_snapshot" jsonb,
	"new_bowler_snapshot" jsonb,
	"reason" text,
	"source" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "identity_link_events_event_type_check" CHECK ("identity_link_events"."event_type" IN ('link', 'unlink', 'admin_assignment', 'replacement', 'access_cleanup'))
);
--> statement-breakpoint
ALTER TABLE "account_action_requests" ADD CONSTRAINT "account_action_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_action_requests" ADD CONSTRAINT "account_action_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_action_requests" ADD CONSTRAINT "account_action_requests_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_link_events" ADD CONSTRAINT "identity_link_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_link_events" ADD CONSTRAINT "identity_link_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_link_events" ADD CONSTRAINT "identity_link_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_link_events" ADD CONSTRAINT "identity_link_events_bowler_id_bowlers_id_fk" FOREIGN KEY ("bowler_id") REFERENCES "public"."bowlers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_link_events" ADD CONSTRAINT "identity_link_events_old_bowler_id_bowlers_id_fk" FOREIGN KEY ("old_bowler_id") REFERENCES "public"."bowlers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_link_events" ADD CONSTRAINT "identity_link_events_new_bowler_id_bowlers_id_fk" FOREIGN KEY ("new_bowler_id") REFERENCES "public"."bowlers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_action_requests_user_idx" ON "account_action_requests" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_action_requests_pending_user_action_unique" ON "account_action_requests" USING btree ("user_id","action") WHERE "account_action_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "identity_link_events_org_created_at_idx" ON "identity_link_events" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "identity_link_events_user_idx" ON "identity_link_events" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "identity_link_events_subject_user_idx" ON "identity_link_events" USING btree ("subject_user_id");--> statement-breakpoint
CREATE INDEX "identity_link_events_bowler_idx" ON "identity_link_events" USING btree ("bowler_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_bowler_organization_fk" FOREIGN KEY ("bowler_id","organization_id") REFERENCES "public"."bowlers"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_location_organization_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
UPDATE "users"
SET "email" = lower(btrim("email"))
WHERE "email" <> lower(btrim("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_normalized_unique" ON "users" USING btree (lower(btrim("email")));--> statement-breakpoint
CREATE UNIQUE INDEX "users_bowler_id_unique" ON "users" USING btree ("bowler_id") WHERE "users"."bowler_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_payment_manager_scope_check" CHECK ("users"."role"::text <> 'payment_manager' OR ("users"."organization_id" IS NOT NULL AND "users"."location_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_elevated_role_bowler_check" CHECK ("users"."role"::text NOT IN ('system_admin', 'org_admin', 'payment_manager') OR "users"."bowler_id" IS NULL);
