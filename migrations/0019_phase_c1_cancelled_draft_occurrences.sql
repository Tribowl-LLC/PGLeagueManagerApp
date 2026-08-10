ALTER TABLE "league_occurrences" DROP CONSTRAINT "occurrences_lifecycle_status_check";--> statement-breakpoint
ALTER TABLE "league_occurrences" DROP CONSTRAINT "occurrences_metadata_check";--> statement-breakpoint
ALTER TABLE "league_occurrences" ADD CONSTRAINT "occurrences_lifecycle_status_check" CHECK (("league_occurrences"."lifecycle" = 'draft' AND "league_occurrences"."status" IN ('scheduled', 'cancelled', 'discarded'))
      OR ("league_occurrences"."lifecycle" = 'published' AND "league_occurrences"."status" IN ('scheduled', 'cancelled'))
      OR ("league_occurrences"."lifecycle" = 'locked' AND "league_occurrences"."status" IN ('scheduled', 'cancelled', 'completed')));--> statement-breakpoint
ALTER TABLE "league_occurrences" ADD CONSTRAINT "occurrences_metadata_check" CHECK ((
      "league_occurrences"."lifecycle" = 'draft' AND "league_occurrences"."status" = 'scheduled'
      AND "league_occurrences"."published_at" IS NULL AND "league_occurrences"."published_by_user_id" IS NULL AND "league_occurrences"."publication_command_id" IS NULL
      AND "league_occurrences"."locked_at" IS NULL AND "league_occurrences"."locked_by_user_id" IS NULL AND "league_occurrences"."lock_reason" IS NULL AND "league_occurrences"."lock_command_id" IS NULL
      AND "league_occurrences"."cancelled_at" IS NULL AND "league_occurrences"."cancelled_by_user_id" IS NULL AND "league_occurrences"."cancellation_command_id" IS NULL
      AND "league_occurrences"."completed_at" IS NULL AND "league_occurrences"."completed_by_user_id" IS NULL AND "league_occurrences"."completion_command_id" IS NULL
      AND "league_occurrences"."discarded_at" IS NULL AND "league_occurrences"."discarded_by_user_id" IS NULL AND "league_occurrences"."discard_command_id" IS NULL
    ) OR (
      "league_occurrences"."lifecycle" = 'draft' AND "league_occurrences"."status" = 'cancelled'
      AND "league_occurrences"."published_at" IS NULL AND "league_occurrences"."published_by_user_id" IS NULL AND "league_occurrences"."publication_command_id" IS NULL
      AND "league_occurrences"."locked_at" IS NULL AND "league_occurrences"."locked_by_user_id" IS NULL AND "league_occurrences"."lock_reason" IS NULL AND "league_occurrences"."lock_command_id" IS NULL
      AND "league_occurrences"."cancelled_at" IS NOT NULL AND "league_occurrences"."cancelled_by_user_id" IS NOT NULL AND "league_occurrences"."cancellation_command_id" IS NOT NULL
      AND "league_occurrences"."completed_at" IS NULL AND "league_occurrences"."completed_by_user_id" IS NULL AND "league_occurrences"."completion_command_id" IS NULL
      AND "league_occurrences"."discarded_at" IS NULL AND "league_occurrences"."discarded_by_user_id" IS NULL AND "league_occurrences"."discard_command_id" IS NULL
      AND "league_occurrences"."planned_ordinal" IS NOT NULL AND "league_occurrences"."competition_number" IS NULL
      AND NOT "league_occurrences"."competitive" AND NOT "league_occurrences"."counts_in_standings"
    ) OR (
      "league_occurrences"."lifecycle" = 'draft' AND "league_occurrences"."status" = 'discarded'
      AND "league_occurrences"."published_at" IS NULL AND "league_occurrences"."published_by_user_id" IS NULL AND "league_occurrences"."publication_command_id" IS NULL
      AND "league_occurrences"."locked_at" IS NULL AND "league_occurrences"."locked_by_user_id" IS NULL AND "league_occurrences"."lock_reason" IS NULL AND "league_occurrences"."lock_command_id" IS NULL
      AND "league_occurrences"."cancelled_at" IS NULL AND "league_occurrences"."cancelled_by_user_id" IS NULL AND "league_occurrences"."cancellation_command_id" IS NULL
      AND "league_occurrences"."completed_at" IS NULL AND "league_occurrences"."completed_by_user_id" IS NULL AND "league_occurrences"."completion_command_id" IS NULL
      AND "league_occurrences"."discarded_at" IS NOT NULL AND "league_occurrences"."discarded_by_user_id" IS NOT NULL AND "league_occurrences"."discard_command_id" IS NOT NULL
      AND "league_occurrences"."planned_ordinal" IS NULL AND "league_occurrences"."competition_number" IS NULL
    ) OR (
      "league_occurrences"."lifecycle" = 'published'
      AND "league_occurrences"."published_at" IS NOT NULL AND "league_occurrences"."published_by_user_id" IS NOT NULL AND "league_occurrences"."publication_command_id" IS NOT NULL
      AND "league_occurrences"."locked_at" IS NULL AND "league_occurrences"."locked_by_user_id" IS NULL AND "league_occurrences"."lock_reason" IS NULL AND "league_occurrences"."lock_command_id" IS NULL
      AND "league_occurrences"."completed_at" IS NULL AND "league_occurrences"."completed_by_user_id" IS NULL AND "league_occurrences"."completion_command_id" IS NULL
      AND "league_occurrences"."discarded_at" IS NULL AND "league_occurrences"."discarded_by_user_id" IS NULL AND "league_occurrences"."discard_command_id" IS NULL
      AND (("league_occurrences"."status" = 'scheduled' AND "league_occurrences"."cancelled_at" IS NULL AND "league_occurrences"."cancelled_by_user_id" IS NULL AND "league_occurrences"."cancellation_command_id" IS NULL)
        OR ("league_occurrences"."status" = 'cancelled' AND "league_occurrences"."cancelled_at" IS NOT NULL AND "league_occurrences"."cancelled_by_user_id" IS NOT NULL AND "league_occurrences"."cancellation_command_id" IS NOT NULL))
    ) OR (
      "league_occurrences"."lifecycle" = 'locked'
      AND "league_occurrences"."published_at" IS NOT NULL AND "league_occurrences"."published_by_user_id" IS NOT NULL AND "league_occurrences"."publication_command_id" IS NOT NULL
      AND "league_occurrences"."locked_at" IS NOT NULL AND "league_occurrences"."lock_reason" IS NOT NULL AND length("league_occurrences"."lock_reason") > 0 AND "league_occurrences"."lock_command_id" IS NOT NULL
      AND "league_occurrences"."discarded_at" IS NULL AND "league_occurrences"."discarded_by_user_id" IS NULL AND "league_occurrences"."discard_command_id" IS NULL
      AND (("league_occurrences"."status" = 'scheduled' AND "league_occurrences"."cancelled_at" IS NULL AND "league_occurrences"."cancelled_by_user_id" IS NULL AND "league_occurrences"."cancellation_command_id" IS NULL AND "league_occurrences"."completed_at" IS NULL AND "league_occurrences"."completed_by_user_id" IS NULL AND "league_occurrences"."completion_command_id" IS NULL)
        OR ("league_occurrences"."status" = 'cancelled' AND "league_occurrences"."cancelled_at" IS NOT NULL AND "league_occurrences"."cancelled_by_user_id" IS NOT NULL AND "league_occurrences"."cancellation_command_id" IS NOT NULL AND "league_occurrences"."completed_at" IS NULL AND "league_occurrences"."completed_by_user_id" IS NULL AND "league_occurrences"."completion_command_id" IS NULL)
        OR ("league_occurrences"."status" = 'completed' AND "league_occurrences"."cancelled_at" IS NULL AND "league_occurrences"."cancelled_by_user_id" IS NULL AND "league_occurrences"."cancellation_command_id" IS NULL AND "league_occurrences"."completed_at" IS NOT NULL AND "league_occurrences"."completed_by_user_id" IS NOT NULL AND "league_occurrences"."completion_command_id" IS NOT NULL))
    ));