ALTER TABLE "interactive_payment_operation_snapshots" DROP CONSTRAINT "interactive_payment_snapshots_version_check";--> statement-breakpoint
ALTER TABLE "interactive_payment_operation_snapshots" DROP CONSTRAINT "interactive_payment_snapshots_fingerprint_check";--> statement-breakpoint
ALTER TABLE "interactive_payment_operation_snapshots" ALTER COLUMN "snapshot_version" SET DEFAULT 2;--> statement-breakpoint
ALTER TABLE "interactive_payment_operation_snapshots" ADD COLUMN "source_kind" text;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD COLUMN "card_save_status" text;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD COLUMN "card_save_provider_idempotency_key" varchar(45);--> statement-breakpoint
ALTER TABLE "payment_operations" ADD COLUMN "encrypted_saved_card_id" text;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD COLUMN "card_save_error_code" varchar(128);--> statement-breakpoint
ALTER TABLE "payment_operations" ADD COLUMN "card_save_completed_at" timestamp;--> statement-breakpoint
ALTER TABLE "interactive_payment_operation_snapshots" ADD CONSTRAINT "interactive_payment_snapshots_source_kind_check" CHECK ("interactive_payment_operation_snapshots"."snapshot_version" = 1 OR "interactive_payment_operation_snapshots"."source_kind" IN ('new_card', 'saved_card', 'wallet'));--> statement-breakpoint
ALTER TABLE "interactive_payment_operation_snapshots" ADD CONSTRAINT "interactive_payment_snapshots_version_check" CHECK ("interactive_payment_operation_snapshots"."snapshot_version" IN (1, 2));--> statement-breakpoint
ALTER TABLE "interactive_payment_operation_snapshots" ADD CONSTRAINT "interactive_payment_snapshots_fingerprint_check" CHECK ("interactive_payment_operation_snapshots"."snapshot_fingerprint" ~ '^lvpayexecic:v(1|2):[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_card_save_status_check" CHECK ("payment_operations"."card_save_status" IS NULL OR "payment_operations"."card_save_status" IN ('pending', 'saved', 'failed', 'not_available'));--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_card_save_provider_key_check" CHECK ("payment_operations"."card_save_provider_idempotency_key" IS NULL OR length("payment_operations"."card_save_provider_idempotency_key") BETWEEN 1 AND 45);--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_card_save_state_check" CHECK ((
      "payment_operations"."card_save_status" IS NULL
      AND "payment_operations"."card_save_provider_idempotency_key" IS NULL
      AND "payment_operations"."encrypted_saved_card_id" IS NULL
      AND "payment_operations"."card_save_error_code" IS NULL
      AND "payment_operations"."card_save_completed_at" IS NULL
    ) OR (
      "payment_operations"."card_save_status" = 'pending'
      AND "payment_operations"."card_save_provider_idempotency_key" IS NOT NULL
      AND "payment_operations"."encrypted_saved_card_id" IS NULL
      AND "payment_operations"."card_save_completed_at" IS NULL
    ) OR (
      "payment_operations"."card_save_status" = 'saved'
      AND "payment_operations"."card_save_provider_idempotency_key" IS NOT NULL
      AND "payment_operations"."encrypted_saved_card_id" IS NOT NULL
      AND "payment_operations"."card_save_completed_at" IS NOT NULL
    ) OR (
      "payment_operations"."card_save_status" IN ('failed', 'not_available')
      AND (
        ("payment_operations"."card_save_status" = 'failed' AND "payment_operations"."card_save_provider_idempotency_key" IS NOT NULL)
        OR ("payment_operations"."card_save_status" = 'not_available' AND "payment_operations"."card_save_provider_idempotency_key" IS NULL)
      )
      AND "payment_operations"."encrypted_saved_card_id" IS NULL
      AND "payment_operations"."card_save_completed_at" IS NOT NULL
    ));--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_card_save_error_code_check" CHECK ("payment_operations"."card_save_error_code" IS NULL OR "payment_operations"."card_save_error_code" ~ '^[A-Z0-9][A-Z0-9_.:-]{0,127}$');