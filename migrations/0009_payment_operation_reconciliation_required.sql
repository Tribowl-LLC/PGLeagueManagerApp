ALTER TABLE "payment_operations" DROP CONSTRAINT "payment_operations_status_check";--> statement-breakpoint
ALTER TABLE "payment_operations" DROP CONSTRAINT "payment_operations_nonterminal_lease_token_check";--> statement-breakpoint
ALTER TABLE "payment_operations" DROP CONSTRAINT "payment_operations_completion_state_check";--> statement-breakpoint
ALTER TABLE "payment_operations" DROP CONSTRAINT "payment_operations_error_state_check";--> statement-breakpoint
CREATE INDEX "payment_schedules_active_next_payment_idx" ON "payment_schedules" USING btree ("next_payment_date") WHERE "payment_schedules"."active" = true;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_status_check" CHECK ("payment_operations"."status" IN ('pending', 'leased', 'provider_unknown', 'retry_scheduled', 'succeeded', 'action_required', 'reconciliation_required', 'failed_terminal', 'canceled'));--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_nonterminal_lease_token_check" CHECK ("payment_operations"."status" IN ('leased', 'succeeded', 'action_required', 'reconciliation_required', 'failed_terminal', 'canceled') OR "payment_operations"."lease_token" IS NULL);--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_completion_state_check" CHECK (("payment_operations"."status" IN ('succeeded', 'action_required', 'reconciliation_required', 'failed_terminal', 'canceled')) = ("payment_operations"."completed_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_error_state_check" CHECK ((
      "payment_operations"."status" IN ('provider_unknown', 'retry_scheduled', 'action_required', 'reconciliation_required', 'failed_terminal')
      AND "payment_operations"."error_classification" IS NOT NULL
    ) OR (
      "payment_operations"."status" NOT IN ('provider_unknown', 'retry_scheduled', 'action_required', 'reconciliation_required', 'failed_terminal')
      AND "payment_operations"."error_classification" IS NULL
      AND "payment_operations"."error_code" IS NULL
    ));