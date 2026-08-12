ALTER TABLE "games" ADD COLUMN "occurrence_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD COLUMN "trigger_occurrence_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_schedules" ADD COLUMN "next_occurrence_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "occurrences_league_reference_unique" ON "league_occurrences" USING btree ("id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "occurrences_tenant_reference_unique" ON "league_occurrences" USING btree ("id","organization_id");--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_occurrence_league_fk" FOREIGN KEY ("occurrence_id","league_id") REFERENCES "public"."league_occurrences"("id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_trigger_occurrence_tenant_fk" FOREIGN KEY ("trigger_occurrence_id","organization_id") REFERENCES "public"."league_occurrences"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_schedules" ADD CONSTRAINT "payment_schedules_next_occurrence_league_fk" FOREIGN KEY ("next_occurrence_id","league_id") REFERENCES "public"."league_occurrences"("id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "games_occurrence_idx" ON "games" USING btree ("occurrence_id");--> statement-breakpoint
CREATE INDEX "payment_operations_trigger_occurrence_idx" ON "payment_operations" USING btree ("trigger_occurrence_id");--> statement-breakpoint
CREATE INDEX "payment_schedules_next_occurrence_idx" ON "payment_schedules" USING btree ("next_occurrence_id");--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_trigger_occurrence_check" CHECK ("payment_operations"."trigger_occurrence_id" IS NULL OR (
      "payment_operations"."operation_type" = 'scheduled_charge'
      AND "payment_operations"."payment_schedule_id" IS NOT NULL
      AND "payment_operations"."billing_cycle_at" IS NOT NULL
    ));
