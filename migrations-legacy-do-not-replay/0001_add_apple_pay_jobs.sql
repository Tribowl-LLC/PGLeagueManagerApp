CREATE TABLE "apple_pay_job_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" integer NOT NULL,
	"organization_id" integer,
	"location_id" integer,
	"domain" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"message" text,
	"processed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "apple_pay_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"total_domains" integer DEFAULT 0 NOT NULL,
	"succeeded_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"created_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "apple_pay_job_items" ADD CONSTRAINT "apple_pay_job_items_job_id_apple_pay_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."apple_pay_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apple_pay_job_items" ADD CONSTRAINT "apple_pay_job_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apple_pay_job_items" ADD CONSTRAINT "apple_pay_job_items_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apple_pay_jobs" ADD CONSTRAINT "apple_pay_jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "apple_pay_job_items_job_id_idx" ON "apple_pay_job_items" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "apple_pay_job_items_job_status_idx" ON "apple_pay_job_items" USING btree ("job_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "apple_pay_job_items_unique_idx" ON "apple_pay_job_items" USING btree ("job_id",COALESCE("organization_id", 0),COALESCE("location_id", 0),"domain");--> statement-breakpoint
CREATE INDEX "apple_pay_jobs_status_idx" ON "apple_pay_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "apple_pay_jobs_created_at_idx" ON "apple_pay_jobs" USING btree ("created_at");