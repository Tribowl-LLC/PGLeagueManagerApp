CREATE TABLE "payment_dispute_acknowledgements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"payment_dispute_id" uuid NOT NULL,
	"provider_version" integer NOT NULL,
	"actor_user_id" integer NOT NULL,
	"actor_role" varchar(32) NOT NULL,
	"acknowledged_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "payment_dispute_acknowledgements_version_check" CHECK ("payment_dispute_acknowledgements"."provider_version" > 0),
	CONSTRAINT "payment_dispute_acknowledgements_actor_role_check" CHECK ("payment_dispute_acknowledgements"."actor_role" IN ('org_admin', 'system_admin'))
);
--> statement-breakpoint
ALTER TABLE "payment_dispute_acknowledgements" ADD CONSTRAINT "payment_dispute_acknowledgements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_dispute_acknowledgements" ADD CONSTRAINT "payment_dispute_acknowledgements_payment_dispute_id_payment_disputes_id_fk" FOREIGN KEY ("payment_dispute_id") REFERENCES "public"."payment_disputes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_dispute_acknowledgements" ADD CONSTRAINT "payment_dispute_acknowledgements_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_dispute_acknowledgements_dispute_version_unique" ON "payment_dispute_acknowledgements" USING btree ("payment_dispute_id","provider_version");--> statement-breakpoint
CREATE INDEX "payment_dispute_acknowledgements_tenant_acknowledged_idx" ON "payment_dispute_acknowledgements" USING btree ("organization_id","acknowledged_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payment_dispute_acknowledgements_actor_acknowledged_idx" ON "payment_dispute_acknowledgements" USING btree ("actor_user_id","acknowledged_at" DESC NULLS LAST);