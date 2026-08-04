CREATE TABLE "league_occurrence_billing_term_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"billing_term_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"snapshot_schema_version" integer NOT NULL,
	"before_snapshot" jsonb,
	"after_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_term_revisions_revision_check" CHECK ("league_occurrence_billing_term_revisions"."revision_number" > 0 AND "league_occurrence_billing_term_revisions"."snapshot_schema_version" > 0),
	CONSTRAINT "billing_term_revisions_snapshot_check" CHECK (("league_occurrence_billing_term_revisions"."revision_number" = 1 AND "league_occurrence_billing_term_revisions"."before_snapshot" IS NULL) OR ("league_occurrence_billing_term_revisions"."revision_number" > 1 AND "league_occurrence_billing_term_revisions"."before_snapshot" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "league_occurrence_billing_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"obligation_policy" text NOT NULL,
	"default_amount_minor" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"billing_ordinal" integer,
	"version" integer NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"published_by_user_id" integer,
	"publication_command_id" uuid,
	"superseded_at" timestamp with time zone,
	"superseded_by_command_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_terms_purpose_check" CHECK ("league_occurrence_billing_terms"."purpose" IN ('league_weekly_fee')),
	CONSTRAINT "billing_terms_policy_check" CHECK ("league_occurrence_billing_terms"."obligation_policy" IN ('none', 'eligible_bowlers')),
	CONSTRAINT "billing_terms_state_check" CHECK ("league_occurrence_billing_terms"."state" IN ('draft', 'published', 'superseded')),
	CONSTRAINT "billing_terms_amount_policy_check" CHECK (("league_occurrence_billing_terms"."obligation_policy" = 'none' AND "league_occurrence_billing_terms"."default_amount_minor" = 0 AND "league_occurrence_billing_terms"."billing_ordinal" IS NULL)
      OR ("league_occurrence_billing_terms"."obligation_policy" = 'eligible_bowlers' AND "league_occurrence_billing_terms"."default_amount_minor" > 0 AND "league_occurrence_billing_terms"."billing_ordinal" > 0)),
	CONSTRAINT "billing_terms_currency_check" CHECK ("league_occurrence_billing_terms"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "billing_terms_version_check" CHECK ("league_occurrence_billing_terms"."version" > 0),
	CONSTRAINT "billing_terms_lifecycle_metadata_check" CHECK ((
      "league_occurrence_billing_terms"."state" = 'draft'
      AND "league_occurrence_billing_terms"."published_at" IS NULL AND "league_occurrence_billing_terms"."published_by_user_id" IS NULL AND "league_occurrence_billing_terms"."publication_command_id" IS NULL
      AND "league_occurrence_billing_terms"."superseded_at" IS NULL AND "league_occurrence_billing_terms"."superseded_by_command_id" IS NULL
    ) OR (
      "league_occurrence_billing_terms"."state" = 'published'
      AND "league_occurrence_billing_terms"."published_at" IS NOT NULL AND "league_occurrence_billing_terms"."published_by_user_id" IS NOT NULL AND "league_occurrence_billing_terms"."publication_command_id" IS NOT NULL
      AND "league_occurrence_billing_terms"."superseded_at" IS NULL AND "league_occurrence_billing_terms"."superseded_by_command_id" IS NULL
    ) OR (
      "league_occurrence_billing_terms"."state" = 'superseded'
      AND "league_occurrence_billing_terms"."superseded_at" IS NOT NULL AND "league_occurrence_billing_terms"."superseded_by_command_id" IS NOT NULL
      AND ("league_occurrence_billing_terms"."published_at" IS NULL AND "league_occurrence_billing_terms"."published_by_user_id" IS NULL AND "league_occurrence_billing_terms"."publication_command_id" IS NULL
        OR "league_occurrence_billing_terms"."published_at" IS NOT NULL AND "league_occurrence_billing_terms"."published_by_user_id" IS NOT NULL AND "league_occurrence_billing_terms"."publication_command_id" IS NOT NULL)
    ))
);
--> statement-breakpoint
CREATE TABLE "league_occurrence_generation_discrepancies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"generation_run_id" uuid NOT NULL,
	"severity" text NOT NULL,
	"code" text NOT NULL,
	"generation_key" varchar(255),
	"details" jsonb NOT NULL,
	"resolution_state" text DEFAULT 'open' NOT NULL,
	"resolution_command_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generation_discrepancies_severity_check" CHECK ("league_occurrence_generation_discrepancies"."severity" IN ('info', 'warning', 'error')),
	CONSTRAINT "generation_discrepancies_code_check" CHECK ("league_occurrence_generation_discrepancies"."code" IN ('ambiguous_historical_payment', 'duplicate_historical_game_key', 'outside_season_occurrence', 'weekday_mismatch', 'exception_collision', 'invalid_dst_input', 'total_week_mismatch')),
	CONSTRAINT "generation_discrepancies_resolution_check" CHECK (("league_occurrence_generation_discrepancies"."resolution_state" = 'open' AND "league_occurrence_generation_discrepancies"."resolution_command_id" IS NULL AND "league_occurrence_generation_discrepancies"."resolved_at" IS NULL)
      OR ("league_occurrence_generation_discrepancies"."resolution_state" IN ('resolved', 'waived') AND "league_occurrence_generation_discrepancies"."resolution_command_id" IS NOT NULL AND "league_occurrence_generation_discrepancies"."resolved_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "league_occurrence_generation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"originating_command_id" uuid NOT NULL,
	"generator_version" varchar(128) NOT NULL,
	"input_fingerprint" varchar(128) NOT NULL,
	"source_schedule_revision" integer NOT NULL,
	"normalized_input_snapshot" jsonb NOT NULL,
	"range_start_date" date NOT NULL,
	"range_end_date" date NOT NULL,
	"candidate_occurrence_count" integer DEFAULT 0 NOT NULL,
	"generated_occurrence_count" integer DEFAULT 0 NOT NULL,
	"skipped_date_count" integer DEFAULT 0 NOT NULL,
	"discrepancy_count" integer DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'generated' NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by_user_id" integer,
	"approval_command_id" uuid,
	"rejected_at" timestamp with time zone,
	"rejected_by_user_id" integer,
	"rejection_reason" text,
	"rejection_command_id" uuid,
	"superseded_at" timestamp with time zone,
	"superseded_by_command_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generation_runs_state_check" CHECK ("league_occurrence_generation_runs"."state" IN ('generated', 'approved', 'applied', 'rejected', 'superseded')),
	CONSTRAINT "generation_runs_revision_check" CHECK ("league_occurrence_generation_runs"."source_schedule_revision" > 0),
	CONSTRAINT "generation_runs_range_check" CHECK ("league_occurrence_generation_runs"."range_end_date" >= "league_occurrence_generation_runs"."range_start_date"),
	CONSTRAINT "generation_runs_counts_check" CHECK ("league_occurrence_generation_runs"."candidate_occurrence_count" >= 0 AND "league_occurrence_generation_runs"."generated_occurrence_count" >= 0
      AND "league_occurrence_generation_runs"."skipped_date_count" >= 0 AND "league_occurrence_generation_runs"."discrepancy_count" >= 0),
	CONSTRAINT "generation_runs_version_check" CHECK (length("league_occurrence_generation_runs"."generator_version") > 0 AND btrim("league_occurrence_generation_runs"."generator_version") = "league_occurrence_generation_runs"."generator_version"
      AND length("league_occurrence_generation_runs"."input_fingerprint") > 0 AND btrim("league_occurrence_generation_runs"."input_fingerprint") = "league_occurrence_generation_runs"."input_fingerprint"),
	CONSTRAINT "generation_runs_metadata_check" CHECK ((
      "league_occurrence_generation_runs"."state" = 'generated'
      AND "league_occurrence_generation_runs"."approved_at" IS NULL AND "league_occurrence_generation_runs"."approved_by_user_id" IS NULL AND "league_occurrence_generation_runs"."approval_command_id" IS NULL
      AND "league_occurrence_generation_runs"."rejected_at" IS NULL AND "league_occurrence_generation_runs"."rejected_by_user_id" IS NULL AND "league_occurrence_generation_runs"."rejection_reason" IS NULL AND "league_occurrence_generation_runs"."rejection_command_id" IS NULL
      AND "league_occurrence_generation_runs"."superseded_at" IS NULL AND "league_occurrence_generation_runs"."superseded_by_command_id" IS NULL
    ) OR (
      "league_occurrence_generation_runs"."state" IN ('approved', 'applied')
      AND "league_occurrence_generation_runs"."approved_at" IS NOT NULL AND "league_occurrence_generation_runs"."approved_by_user_id" IS NOT NULL AND "league_occurrence_generation_runs"."approval_command_id" IS NOT NULL
      AND "league_occurrence_generation_runs"."rejected_at" IS NULL AND "league_occurrence_generation_runs"."rejected_by_user_id" IS NULL AND "league_occurrence_generation_runs"."rejection_reason" IS NULL AND "league_occurrence_generation_runs"."rejection_command_id" IS NULL
      AND "league_occurrence_generation_runs"."superseded_at" IS NULL AND "league_occurrence_generation_runs"."superseded_by_command_id" IS NULL
    ) OR (
      "league_occurrence_generation_runs"."state" = 'rejected'
      AND "league_occurrence_generation_runs"."rejected_at" IS NOT NULL AND "league_occurrence_generation_runs"."rejected_by_user_id" IS NOT NULL
      AND "league_occurrence_generation_runs"."rejection_reason" IS NOT NULL AND length("league_occurrence_generation_runs"."rejection_reason") > 0
      AND "league_occurrence_generation_runs"."rejection_command_id" IS NOT NULL
      AND "league_occurrence_generation_runs"."approved_at" IS NULL AND "league_occurrence_generation_runs"."approved_by_user_id" IS NULL AND "league_occurrence_generation_runs"."approval_command_id" IS NULL
      AND "league_occurrence_generation_runs"."superseded_at" IS NULL AND "league_occurrence_generation_runs"."superseded_by_command_id" IS NULL
    ) OR (
      "league_occurrence_generation_runs"."state" = 'superseded'
      AND "league_occurrence_generation_runs"."superseded_at" IS NOT NULL AND "league_occurrence_generation_runs"."superseded_by_command_id" IS NOT NULL
      AND "league_occurrence_generation_runs"."rejected_at" IS NULL AND "league_occurrence_generation_runs"."rejected_by_user_id" IS NULL AND "league_occurrence_generation_runs"."rejection_reason" IS NULL AND "league_occurrence_generation_runs"."rejection_command_id" IS NULL
    )
    AND ("league_occurrence_generation_runs"."rejected_at" IS NULL OR "league_occurrence_generation_runs"."rejected_by_user_id" IS NOT NULL)
    AND ("league_occurrence_generation_runs"."superseded_at" IS NULL OR "league_occurrence_generation_runs"."superseded_by_command_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "league_occurrence_relationship_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"relationship_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"snapshot_schema_version" integer NOT NULL,
	"before_snapshot" jsonb,
	"after_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relationship_revisions_revision_check" CHECK ("league_occurrence_relationship_revisions"."revision_number" > 0 AND "league_occurrence_relationship_revisions"."snapshot_schema_version" > 0),
	CONSTRAINT "relationship_revisions_snapshot_check" CHECK (("league_occurrence_relationship_revisions"."revision_number" = 1 AND "league_occurrence_relationship_revisions"."before_snapshot" IS NULL) OR ("league_occurrence_relationship_revisions"."revision_number" > 1 AND "league_occurrence_relationship_revisions"."before_snapshot" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "league_occurrence_relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"kind" text NOT NULL,
	"source_occurrence_id" uuid NOT NULL,
	"target_occurrence_id" uuid NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"published_by_user_id" integer,
	"publication_command_id" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" integer,
	"revocation_command_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relationships_kind_check" CHECK ("league_occurrence_relationships"."kind" IN ('makeup_for')),
	CONSTRAINT "relationships_different_occurrences_check" CHECK ("league_occurrence_relationships"."source_occurrence_id" <> "league_occurrence_relationships"."target_occurrence_id"),
	CONSTRAINT "relationships_state_check" CHECK (("league_occurrence_relationships"."state" = 'draft' AND "league_occurrence_relationships"."published_at" IS NULL AND "league_occurrence_relationships"."published_by_user_id" IS NULL AND "league_occurrence_relationships"."publication_command_id" IS NULL AND "league_occurrence_relationships"."revoked_at" IS NULL AND "league_occurrence_relationships"."revoked_by_user_id" IS NULL AND "league_occurrence_relationships"."revocation_command_id" IS NULL)
      OR ("league_occurrence_relationships"."state" = 'published' AND "league_occurrence_relationships"."published_at" IS NOT NULL AND "league_occurrence_relationships"."published_by_user_id" IS NOT NULL AND "league_occurrence_relationships"."publication_command_id" IS NOT NULL AND "league_occurrence_relationships"."revoked_at" IS NULL AND "league_occurrence_relationships"."revoked_by_user_id" IS NULL AND "league_occurrence_relationships"."revocation_command_id" IS NULL)
      OR ("league_occurrence_relationships"."state" = 'revoked' AND "league_occurrence_relationships"."published_at" IS NOT NULL AND "league_occurrence_relationships"."published_by_user_id" IS NOT NULL AND "league_occurrence_relationships"."publication_command_id" IS NOT NULL AND "league_occurrence_relationships"."revoked_at" IS NOT NULL AND "league_occurrence_relationships"."revoked_by_user_id" IS NOT NULL AND "league_occurrence_relationships"."revocation_command_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "league_occurrence_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"snapshot_schema_version" integer NOT NULL,
	"before_snapshot" jsonb,
	"after_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "occurrence_revisions_revision_check" CHECK ("league_occurrence_revisions"."revision_number" > 0 AND "league_occurrence_revisions"."snapshot_schema_version" > 0),
	CONSTRAINT "occurrence_revisions_snapshot_check" CHECK (("league_occurrence_revisions"."revision_number" = 1 AND "league_occurrence_revisions"."before_snapshot" IS NULL) OR ("league_occurrence_revisions"."revision_number" > 1 AND "league_occurrence_revisions"."before_snapshot" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "league_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"location_id" integer NOT NULL,
	"generation_key" varchar(255) NOT NULL,
	"generation_run_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"lifecycle" text DEFAULT 'draft' NOT NULL,
	"authoritative_local_date" date NOT NULL,
	"authoritative_local_start_time" time NOT NULL,
	"timezone" varchar(128) NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"selected_utc_offset_minutes" integer NOT NULL,
	"fold_resolution" text NOT NULL,
	"resolver_version" varchar(128) NOT NULL,
	"planned_ordinal" integer,
	"competition_number" integer,
	"competitive" boolean DEFAULT true NOT NULL,
	"counts_in_standings" boolean DEFAULT true NOT NULL,
	"current_revision" integer DEFAULT 1 NOT NULL,
	"last_command_id" uuid,
	"published_at" timestamp with time zone,
	"published_by_user_id" integer,
	"publication_command_id" uuid,
	"locked_at" timestamp with time zone,
	"locked_by_user_id" integer,
	"lock_reason" text,
	"lock_command_id" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_user_id" integer,
	"cancellation_command_id" uuid,
	"completed_at" timestamp with time zone,
	"completed_by_user_id" integer,
	"completion_command_id" uuid,
	"discarded_at" timestamp with time zone,
	"discarded_by_user_id" integer,
	"discard_command_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "occurrences_kind_check" CHECK ("league_occurrences"."kind" IN ('regular', 'makeup', 'position_round', 'rolloff', 'playoff', 'extension')),
	CONSTRAINT "occurrences_status_check" CHECK ("league_occurrences"."status" IN ('scheduled', 'cancelled', 'completed', 'discarded')),
	CONSTRAINT "occurrences_lifecycle_check" CHECK ("league_occurrences"."lifecycle" IN ('draft', 'published', 'locked')),
	CONSTRAINT "occurrences_fold_check" CHECK ("league_occurrences"."fold_resolution" IN ('unambiguous', 'earlier', 'later')),
	CONSTRAINT "occurrences_offset_check" CHECK ("league_occurrences"."selected_utc_offset_minutes" BETWEEN -840 AND 840),
	CONSTRAINT "occurrences_timezone_check" CHECK (length(btrim("league_occurrences"."timezone")) > 0 AND ("league_occurrences"."timezone" ~ '^[A-Za-z][A-Za-z0-9._+~-]*(/[A-Za-z0-9._+~-]+)+$' OR "league_occurrences"."timezone" IN ('UTC', 'GMT'))),
	CONSTRAINT "occurrences_resolver_check" CHECK (length("league_occurrences"."resolver_version") > 0 AND btrim("league_occurrences"."resolver_version") = "league_occurrences"."resolver_version"),
	CONSTRAINT "occurrences_revision_check" CHECK ("league_occurrences"."current_revision" > 0),
	CONSTRAINT "occurrences_ordinal_check" CHECK (("league_occurrences"."planned_ordinal" IS NULL OR "league_occurrences"."planned_ordinal" > 0)
      AND ("league_occurrences"."competition_number" IS NULL OR "league_occurrences"."competition_number" > 0)
      AND ("league_occurrences"."lifecycle" NOT IN ('published', 'locked') OR "league_occurrences"."planned_ordinal" IS NOT NULL)
      AND ("league_occurrences"."lifecycle" NOT IN ('published', 'locked') OR NOT "league_occurrences"."competitive" OR "league_occurrences"."competition_number" IS NOT NULL)
      AND ("league_occurrences"."lifecycle" IN ('draft') OR "league_occurrences"."competitive" OR "league_occurrences"."competition_number" IS NULL)),
	CONSTRAINT "occurrences_standings_check" CHECK (NOT "league_occurrences"."counts_in_standings" OR "league_occurrences"."competitive"),
	CONSTRAINT "occurrences_lifecycle_status_check" CHECK (("league_occurrences"."lifecycle" = 'draft' AND "league_occurrences"."status" IN ('scheduled', 'discarded'))
      OR ("league_occurrences"."lifecycle" = 'published' AND "league_occurrences"."status" IN ('scheduled', 'cancelled'))
      OR ("league_occurrences"."lifecycle" = 'locked' AND "league_occurrences"."status" IN ('scheduled', 'cancelled', 'completed'))),
	CONSTRAINT "occurrences_metadata_check" CHECK ((
      "league_occurrences"."lifecycle" = 'draft' AND "league_occurrences"."status" = 'scheduled'
      AND "league_occurrences"."published_at" IS NULL AND "league_occurrences"."published_by_user_id" IS NULL AND "league_occurrences"."publication_command_id" IS NULL
      AND "league_occurrences"."locked_at" IS NULL AND "league_occurrences"."locked_by_user_id" IS NULL AND "league_occurrences"."lock_reason" IS NULL AND "league_occurrences"."lock_command_id" IS NULL
      AND "league_occurrences"."cancelled_at" IS NULL AND "league_occurrences"."cancelled_by_user_id" IS NULL AND "league_occurrences"."cancellation_command_id" IS NULL
      AND "league_occurrences"."completed_at" IS NULL AND "league_occurrences"."completed_by_user_id" IS NULL AND "league_occurrences"."completion_command_id" IS NULL
      AND "league_occurrences"."discarded_at" IS NULL AND "league_occurrences"."discarded_by_user_id" IS NULL AND "league_occurrences"."discard_command_id" IS NULL
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
    ))
);
--> statement-breakpoint
CREATE TABLE "league_schedule_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"actor_user_id" integer NOT NULL,
	"command_type" text NOT NULL,
	"reason" text,
	"idempotency_key" varchar(255) NOT NULL,
	"request_fingerprint" varchar(128) NOT NULL,
	"same_day_override" boolean DEFAULT false NOT NULL,
	"outcome" text DEFAULT 'applied' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_commands_type_check" CHECK ("league_schedule_commands"."command_type" IN ('generate', 'compare', 'approve_generation', 'publish', 'reschedule', 'cancel', 'discard_draft', 'create_exception', 'revoke_exception', 'create_makeup_relationship', 'revoke_makeup_relationship', 'revise_billing_terms', 'repair')),
	CONSTRAINT "schedule_commands_outcome_check" CHECK ("league_schedule_commands"."outcome" IN ('applied', 'rejected', 'no_change')),
	CONSTRAINT "schedule_commands_idempotency_key_check" CHECK (length("league_schedule_commands"."idempotency_key") > 0 AND btrim("league_schedule_commands"."idempotency_key") = "league_schedule_commands"."idempotency_key"),
	CONSTRAINT "schedule_commands_fingerprint_check" CHECK (length("league_schedule_commands"."request_fingerprint") > 0 AND btrim("league_schedule_commands"."request_fingerprint") = "league_schedule_commands"."request_fingerprint"),
	CONSTRAINT "schedule_commands_reason_check" CHECK ("league_schedule_commands"."command_type" NOT IN ('cancel', 'reschedule', 'discard_draft', 'revoke_exception', 'revoke_makeup_relationship', 'repair')
      OR ("league_schedule_commands"."reason" IS NOT NULL AND length("league_schedule_commands"."reason") > 0 AND btrim("league_schedule_commands"."reason") = "league_schedule_commands"."reason"))
);
--> statement-breakpoint
CREATE TABLE "league_schedule_exception_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"exception_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"snapshot_schema_version" integer NOT NULL,
	"before_snapshot" jsonb,
	"after_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exception_revisions_revision_check" CHECK ("league_schedule_exception_revisions"."revision_number" > 0 AND "league_schedule_exception_revisions"."snapshot_schema_version" > 0),
	CONSTRAINT "exception_revisions_snapshot_check" CHECK (("league_schedule_exception_revisions"."revision_number" = 1 AND "league_schedule_exception_revisions"."before_snapshot" IS NULL) OR ("league_schedule_exception_revisions"."revision_number" > 1 AND "league_schedule_exception_revisions"."before_snapshot" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "league_schedule_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"kind" text NOT NULL,
	"local_date" date NOT NULL,
	"timezone" varchar(128) NOT NULL,
	"source" text NOT NULL,
	"lifecycle" text DEFAULT 'draft' NOT NULL,
	"reason" text NOT NULL,
	"generation_run_id" uuid,
	"current_revision" integer DEFAULT 1 NOT NULL,
	"last_command_id" uuid,
	"published_at" timestamp with time zone,
	"published_by_user_id" integer,
	"publication_command_id" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" integer,
	"revocation_command_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_exceptions_kind_check" CHECK ("league_schedule_exceptions"."kind" IN ('skip')),
	CONSTRAINT "schedule_exceptions_source_check" CHECK ("league_schedule_exceptions"."source" IN ('manual', 'legacy_import', 'generator')),
	CONSTRAINT "schedule_exceptions_revision_check" CHECK ("league_schedule_exceptions"."current_revision" > 0),
	CONSTRAINT "schedule_exceptions_reason_check" CHECK (length("league_schedule_exceptions"."reason") > 0 AND btrim("league_schedule_exceptions"."reason") = "league_schedule_exceptions"."reason"),
	CONSTRAINT "schedule_exceptions_timezone_check" CHECK (length(btrim("league_schedule_exceptions"."timezone")) > 0 AND ("league_schedule_exceptions"."timezone" ~ '^[A-Za-z][A-Za-z0-9._+~-]*(/[A-Za-z0-9._+~-]+)+$' OR "league_schedule_exceptions"."timezone" IN ('UTC', 'GMT'))),
	CONSTRAINT "schedule_exceptions_lifecycle_check" CHECK ((
      "league_schedule_exceptions"."lifecycle" = 'draft'
      AND "league_schedule_exceptions"."published_at" IS NULL AND "league_schedule_exceptions"."published_by_user_id" IS NULL AND "league_schedule_exceptions"."publication_command_id" IS NULL
      AND "league_schedule_exceptions"."revoked_at" IS NULL AND "league_schedule_exceptions"."revoked_by_user_id" IS NULL AND "league_schedule_exceptions"."revocation_command_id" IS NULL
    ) OR (
      "league_schedule_exceptions"."lifecycle" = 'published'
      AND "league_schedule_exceptions"."published_at" IS NOT NULL AND "league_schedule_exceptions"."published_by_user_id" IS NOT NULL AND "league_schedule_exceptions"."publication_command_id" IS NOT NULL
      AND "league_schedule_exceptions"."revoked_at" IS NULL AND "league_schedule_exceptions"."revoked_by_user_id" IS NULL AND "league_schedule_exceptions"."revocation_command_id" IS NULL
    ) OR (
      "league_schedule_exceptions"."lifecycle" = 'revoked'
      AND "league_schedule_exceptions"."published_at" IS NOT NULL AND "league_schedule_exceptions"."published_by_user_id" IS NOT NULL AND "league_schedule_exceptions"."publication_command_id" IS NOT NULL
      AND "league_schedule_exceptions"."revoked_at" IS NOT NULL AND "league_schedule_exceptions"."revoked_by_user_id" IS NOT NULL AND "league_schedule_exceptions"."revocation_command_id" IS NOT NULL
    ))
);
--> statement-breakpoint
-- Drizzle emits these unique parent keys after foreign keys. They must exist
-- first because PostgreSQL requires a referenced composite key at FK creation.
CREATE UNIQUE INDEX "billing_terms_tenant_identity_unique" ON "league_occurrence_billing_terms" USING btree ("id","organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "generation_runs_tenant_identity_unique" ON "league_occurrence_generation_runs" USING btree ("id","organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "relationships_tenant_identity_unique" ON "league_occurrence_relationships" USING btree ("id","organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "occurrences_tenant_identity_unique" ON "league_occurrences" USING btree ("id","organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_commands_tenant_identity_unique" ON "league_schedule_commands" USING btree ("id","organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_exceptions_tenant_identity_unique" ON "league_schedule_exceptions" USING btree ("id","organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "leagues_id_organization_unique" ON "leagues" USING btree ("id","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "locations_id_organization_unique" ON "locations" USING btree ("id","organization_id");--> statement-breakpoint
ALTER TABLE "league_occurrence_billing_term_revisions" ADD CONSTRAINT "league_occurrence_billing_term_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrence_billing_term_revisions" ADD CONSTRAINT "billing_term_revisions_billing_term_fk" FOREIGN KEY ("billing_term_id","organization_id","league_id") REFERENCES "public"."league_occurrence_billing_terms"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrence_billing_term_revisions" ADD CONSTRAINT "billing_term_revisions_command_fk" FOREIGN KEY ("command_id","organization_id","league_id") REFERENCES "public"."league_schedule_commands"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrence_billing_terms" ADD CONSTRAINT "league_occurrence_billing_terms_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrence_billing_terms" ADD CONSTRAINT "league_occurrence_billing_terms_published_by_user_id_users_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrence_billing_terms" ADD CONSTRAINT "billing_terms_occurrence_tenant_fk" FOREIGN KEY ("occurrence_id","organization_id","league_id") REFERENCES "public"."league_occurrences"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrence_billing_terms" ADD CONSTRAINT "billing_terms_publication_command_fk" FOREIGN KEY ("publication_command_id","organization_id","league_id") REFERENCES "public"."league_schedule_commands"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrence_billing_terms" ADD CONSTRAINT "billing_terms_superseded_command_fk" FOREIGN KEY ("superseded_by_command_id","organization_id","league_id") REFERENCES "public"."league_schedule_commands"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrence_generation_discrepancies" ADD CONSTRAINT "league_occurrence_generation_discrepancies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrence_generation_discrepancies" ADD CONSTRAINT "generation_discrepancies_generation_run_fk" FOREIGN KEY ("generation_run_id","organization_id","league_id") REFERENCES "public"."league_occurrence_generation_runs"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrence_generation_discrepancies" ADD CONSTRAINT "generation_discrepancies_resolution_command_fk" FOREIGN KEY ("resolution_command_id","organization_id","league_id") REFERENCES "public"."league_schedule_commands"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrence_generation_runs" ADD CONSTRAINT "league_occurrence_generation_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrence_generation_runs" ADD CONSTRAINT "league_occurrence_generation_runs_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrence_generation_runs" ADD CONSTRAINT "league_occurrence_generation_runs_rejected_by_user_id_users_id_fk" FOREIGN KEY ("rejected_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrence_generation_runs" ADD CONSTRAINT "generation_runs_league_tenant_fk" FOREIGN KEY ("league_id","organization_id") REFERENCES "public"."leagues"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrence_generation_runs" ADD CONSTRAINT "generation_runs_originating_command_fk" FOREIGN KEY ("originating_command_id","organization_id","league_id") REFERENCES "public"."league_schedule_commands"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrence_generation_runs" ADD CONSTRAINT "generation_runs_approval_command_fk" FOREIGN KEY ("approval_command_id","organization_id","league_id") REFERENCES "public"."league_schedule_commands"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrence_generation_runs" ADD CONSTRAINT "generation_runs_rejection_command_fk" FOREIGN KEY ("rejection_command_id","organization_id","league_id") REFERENCES "public"."league_schedule_commands"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrence_generation_runs" ADD CONSTRAINT "generation_runs_superseded_command_fk" FOREIGN KEY ("superseded_by_command_id","organization_id","league_id") REFERENCES "public"."league_schedule_commands"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrence_relationship_revisions" ADD CONSTRAINT "league_occurrence_relationship_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrence_relationship_revisions" ADD CONSTRAINT "relationship_revisions_relationship_fk" FOREIGN KEY ("relationship_id","organization_id","league_id") REFERENCES "public"."league_occurrence_relationships"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrence_relationship_revisions" ADD CONSTRAINT "relationship_revisions_command_fk" FOREIGN KEY ("command_id","organization_id","league_id") REFERENCES "public"."league_schedule_commands"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrence_relationships" ADD CONSTRAINT "league_occurrence_relationships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrence_relationships" ADD CONSTRAINT "league_occurrence_relationships_published_by_user_id_users_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrence_relationships" ADD CONSTRAINT "league_occurrence_relationships_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrence_relationships" ADD CONSTRAINT "relationships_source_occurrence_fk" FOREIGN KEY ("source_occurrence_id","organization_id","league_id") REFERENCES "public"."league_occurrences"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrence_relationships" ADD CONSTRAINT "relationships_target_occurrence_fk" FOREIGN KEY ("target_occurrence_id","organization_id","league_id") REFERENCES "public"."league_occurrences"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrence_relationships" ADD CONSTRAINT "relationships_publication_command_fk" FOREIGN KEY ("publication_command_id","organization_id","league_id") REFERENCES "public"."league_schedule_commands"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrence_relationships" ADD CONSTRAINT "relationships_revocation_command_fk" FOREIGN KEY ("revocation_command_id","organization_id","league_id") REFERENCES "public"."league_schedule_commands"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrence_revisions" ADD CONSTRAINT "league_occurrence_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrence_revisions" ADD CONSTRAINT "occurrence_revisions_occurrence_fk" FOREIGN KEY ("occurrence_id","organization_id","league_id") REFERENCES "public"."league_occurrences"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrence_revisions" ADD CONSTRAINT "occurrence_revisions_command_fk" FOREIGN KEY ("command_id","organization_id","league_id") REFERENCES "public"."league_schedule_commands"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrences" ADD CONSTRAINT "league_occurrences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrences" ADD CONSTRAINT "league_occurrences_published_by_user_id_users_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrences" ADD CONSTRAINT "league_occurrences_locked_by_user_id_users_id_fk" FOREIGN KEY ("locked_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrences" ADD CONSTRAINT "league_occurrences_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrences" ADD CONSTRAINT "league_occurrences_completed_by_user_id_users_id_fk" FOREIGN KEY ("completed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrences" ADD CONSTRAINT "league_occurrences_discarded_by_user_id_users_id_fk" FOREIGN KEY ("discarded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrences" ADD CONSTRAINT "occurrences_league_tenant_fk" FOREIGN KEY ("league_id","organization_id") REFERENCES "public"."leagues"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrences" ADD CONSTRAINT "occurrences_location_tenant_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrences" ADD CONSTRAINT "occurrences_generation_run_fk" FOREIGN KEY ("generation_run_id","organization_id","league_id") REFERENCES "public"."league_occurrence_generation_runs"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrences" ADD CONSTRAINT "occurrences_last_command_fk" FOREIGN KEY ("last_command_id","organization_id","league_id") REFERENCES "public"."league_schedule_commands"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrences" ADD CONSTRAINT "occurrences_publication_command_fk" FOREIGN KEY ("publication_command_id","organization_id","league_id") REFERENCES "public"."league_schedule_commands"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrences" ADD CONSTRAINT "occurrences_lock_command_fk" FOREIGN KEY ("lock_command_id","organization_id","league_id") REFERENCES "public"."league_schedule_commands"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrences" ADD CONSTRAINT "occurrences_cancellation_command_fk" FOREIGN KEY ("cancellation_command_id","organization_id","league_id") REFERENCES "public"."league_schedule_commands"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrences" ADD CONSTRAINT "occurrences_completion_command_fk" FOREIGN KEY ("completion_command_id","organization_id","league_id") REFERENCES "public"."league_schedule_commands"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_occurrences" ADD CONSTRAINT "occurrences_discard_command_fk" FOREIGN KEY ("discard_command_id","organization_id","league_id") REFERENCES "public"."league_schedule_commands"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_schedule_commands" ADD CONSTRAINT "league_schedule_commands_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_schedule_commands" ADD CONSTRAINT "league_schedule_commands_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_schedule_commands" ADD CONSTRAINT "schedule_commands_league_tenant_fk" FOREIGN KEY ("league_id","organization_id") REFERENCES "public"."leagues"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_schedule_exception_revisions" ADD CONSTRAINT "league_schedule_exception_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_schedule_exception_revisions" ADD CONSTRAINT "exception_revisions_exception_fk" FOREIGN KEY ("exception_id","organization_id","league_id") REFERENCES "public"."league_schedule_exceptions"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_schedule_exception_revisions" ADD CONSTRAINT "exception_revisions_command_fk" FOREIGN KEY ("command_id","organization_id","league_id") REFERENCES "public"."league_schedule_commands"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_schedule_exceptions" ADD CONSTRAINT "league_schedule_exceptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_schedule_exceptions" ADD CONSTRAINT "league_schedule_exceptions_published_by_user_id_users_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_schedule_exceptions" ADD CONSTRAINT "league_schedule_exceptions_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_schedule_exceptions" ADD CONSTRAINT "schedule_exceptions_league_tenant_fk" FOREIGN KEY ("league_id","organization_id") REFERENCES "public"."leagues"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_schedule_exceptions" ADD CONSTRAINT "schedule_exceptions_generation_run_fk" FOREIGN KEY ("generation_run_id","organization_id","league_id") REFERENCES "public"."league_occurrence_generation_runs"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_schedule_exceptions" ADD CONSTRAINT "schedule_exceptions_last_command_fk" FOREIGN KEY ("last_command_id","organization_id","league_id") REFERENCES "public"."league_schedule_commands"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_schedule_exceptions" ADD CONSTRAINT "schedule_exceptions_publication_command_fk" FOREIGN KEY ("publication_command_id","organization_id","league_id") REFERENCES "public"."league_schedule_commands"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_schedule_exceptions" ADD CONSTRAINT "schedule_exceptions_revocation_command_fk" FOREIGN KEY ("revocation_command_id","organization_id","league_id") REFERENCES "public"."league_schedule_commands"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_term_revisions_entity_revision_unique" ON "league_occurrence_billing_term_revisions" USING btree ("organization_id","league_id","billing_term_id","revision_number");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_terms_current_unique" ON "league_occurrence_billing_terms" USING btree ("organization_id","league_id","occurrence_id","purpose") WHERE "league_occurrence_billing_terms"."state" <> 'superseded' AND "league_occurrence_billing_terms"."superseded_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_terms_published_ordinal_unique" ON "league_occurrence_billing_terms" USING btree ("organization_id","league_id","purpose","billing_ordinal") WHERE "league_occurrence_billing_terms"."state" = 'published' AND "league_occurrence_billing_terms"."superseded_at" IS NULL AND "league_occurrence_billing_terms"."billing_ordinal" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "billing_terms_occurrence_idx" ON "league_occurrence_billing_terms" USING btree ("organization_id","league_id","occurrence_id");--> statement-breakpoint
CREATE INDEX "generation_discrepancies_tenant_created_idx" ON "league_occurrence_generation_discrepancies" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "generation_discrepancies_run_idx" ON "league_occurrence_generation_discrepancies" USING btree ("generation_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "generation_runs_revision_unique" ON "league_occurrence_generation_runs" USING btree ("organization_id","league_id","generator_version","input_fingerprint","source_schedule_revision");--> statement-breakpoint
CREATE INDEX "generation_runs_tenant_created_idx" ON "league_occurrence_generation_runs" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "relationship_revisions_entity_revision_unique" ON "league_occurrence_relationship_revisions" USING btree ("organization_id","league_id","relationship_id","revision_number");--> statement-breakpoint
CREATE UNIQUE INDEX "relationships_active_source_unique" ON "league_occurrence_relationships" USING btree ("organization_id","league_id","source_occurrence_id") WHERE "league_occurrence_relationships"."state" <> 'revoked';--> statement-breakpoint
CREATE UNIQUE INDEX "relationships_active_target_unique" ON "league_occurrence_relationships" USING btree ("organization_id","league_id","target_occurrence_id") WHERE "league_occurrence_relationships"."state" <> 'revoked';--> statement-breakpoint
CREATE INDEX "relationships_tenant_created_idx" ON "league_occurrence_relationships" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "occurrence_revisions_entity_revision_unique" ON "league_occurrence_revisions" USING btree ("organization_id","league_id","occurrence_id","revision_number");--> statement-breakpoint
CREATE UNIQUE INDEX "occurrences_generation_key_unique" ON "league_occurrences" USING btree ("generation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "occurrences_active_start_unique" ON "league_occurrences" USING btree ("start_at") WHERE "league_occurrences"."lifecycle" IN ('published', 'locked') AND "league_occurrences"."status" <> 'cancelled';--> statement-breakpoint
CREATE UNIQUE INDEX "occurrences_published_ordinal_unique" ON "league_occurrences" USING btree ("organization_id","league_id","planned_ordinal") WHERE "league_occurrences"."lifecycle" IN ('published', 'locked') AND "league_occurrences"."planned_ordinal" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "occurrences_tenant_date_idx" ON "league_occurrences" USING btree ("organization_id","authoritative_local_date");--> statement-breakpoint
CREATE INDEX "occurrences_generation_run_idx" ON "league_occurrences" USING btree ("generation_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_commands_org_idempotency_unique" ON "league_schedule_commands" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "schedule_commands_tenant_created_idx" ON "league_schedule_commands" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "schedule_commands_league_created_idx" ON "league_schedule_commands" USING btree ("league_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "exception_revisions_entity_revision_unique" ON "league_schedule_exception_revisions" USING btree ("organization_id","league_id","exception_id","revision_number");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_exceptions_active_unique" ON "league_schedule_exceptions" USING btree ("organization_id","league_id","kind","local_date") WHERE "league_schedule_exceptions"."lifecycle" <> 'revoked';--> statement-breakpoint
CREATE INDEX "schedule_exceptions_tenant_date_idx" ON "league_schedule_exceptions" USING btree ("organization_id","local_date");--> statement-breakpoint
