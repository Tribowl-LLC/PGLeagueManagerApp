CREATE TABLE "standing_autopay_preparation_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"consent_id" uuid NOT NULL,
	"consent_version" integer NOT NULL,
	"cutoff_at" timestamp with time zone NOT NULL,
	"occurrence_revision" integer NOT NULL,
	"state" text NOT NULL,
	"attempt_count" integer DEFAULT 1 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error_code" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "standing_autopay_preparation_attempts_state_check" CHECK ("standing_autopay_preparation_attempts"."state" IN ('retry_scheduled', 'failed_terminal') AND "standing_autopay_preparation_attempts"."consent_version" > 0 AND "standing_autopay_preparation_attempts"."occurrence_revision" > 0 AND "standing_autopay_preparation_attempts"."attempt_count" > 0 AND length(btrim("standing_autopay_preparation_attempts"."last_error_code")) > 0 AND (("standing_autopay_preparation_attempts"."state" = 'retry_scheduled' AND "standing_autopay_preparation_attempts"."next_attempt_at" IS NOT NULL) OR ("standing_autopay_preparation_attempts"."state" = 'failed_terminal' AND "standing_autopay_preparation_attempts"."next_attempt_at" IS NULL)))
);
--> statement-breakpoint
ALTER TABLE "standing_autopay_preparation_attempts" ADD CONSTRAINT "standing_autopay_preparation_attempts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_autopay_preparation_attempts" ADD CONSTRAINT "standing_autopay_preparation_attempts_league_tenant_fk" FOREIGN KEY ("league_id","organization_id") REFERENCES "public"."leagues"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_autopay_preparation_attempts" ADD CONSTRAINT "standing_autopay_preparation_attempts_consent_fk" FOREIGN KEY ("consent_id","organization_id","league_id") REFERENCES "public"."autopay_consents"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "standing_autopay_preparation_attempts_cutoff_unique" ON "standing_autopay_preparation_attempts" USING btree ("organization_id","league_id","consent_id","consent_version","cutoff_at","occurrence_revision");--> statement-breakpoint
CREATE INDEX "standing_autopay_preparation_attempts_wake_idx" ON "standing_autopay_preparation_attempts" USING btree ("state","next_attempt_at");