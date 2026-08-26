-- 0034: make canonical schedule authority explicit.
-- Existing rows are classified from retained invariant evidence only. IDs,
-- dates, names, and production-specific values are deliberately not used.
-- A partially materialized canonical set stops the migration before any
-- authority or active flag is changed.
LOCK TABLE
  "leagues",
  "league_schedule_commands",
  "league_occurrence_generation_runs",
  "league_schedule_exceptions",
  "league_occurrences",
  "league_occurrence_billing_terms",
  "league_occurrence_relationships",
  "league_occurrence_revisions",
  "league_schedule_exception_revisions",
  "league_occurrence_relationship_revisions",
  "league_occurrence_billing_term_revisions",
  "league_occurrence_generation_discrepancies",
  "canonical_collection_groups",
  "canonical_collection_group_members",
  "payment_schedules",
  "payments",
  "payment_obligations",
  "payment_allocations",
  "autopay_consents",
  "payment_operations",
  "payment_operation_roster_snapshots",
  "payment_operation_roster_snapshot_items"
  IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint

DO $$
DECLARE
  bad_leagues bigint[];
BEGIN
  WITH operational_markers AS (
    SELECT organization_id, league_id FROM league_occurrence_generation_runs
     WHERE state = 'applied'
    UNION SELECT organization_id, league_id FROM league_occurrences
     WHERE lifecycle IN ('published', 'locked')
    UNION SELECT organization_id, league_id FROM league_occurrence_billing_terms
     WHERE state = 'published'
    UNION SELECT organization_id, league_id FROM league_schedule_exceptions
     WHERE lifecycle = 'published'
    UNION SELECT organization_id, league_id FROM league_occurrence_relationships
     WHERE state = 'published'
    UNION SELECT organization_id, league_id FROM canonical_collection_groups
     WHERE state IN ('published', 'revoked')
    UNION SELECT organization_id, league_id FROM league_schedule_commands
     WHERE outcome = 'applied'
       AND command_type IN ('publish', 'reschedule', 'cancel', 'create_exception',
         'revoke_exception', 'create_makeup_relationship', 'revoke_makeup_relationship',
         'revise_billing_terms', 'repair', 'restore_cancelled_draft',
         'publish_collection_group', 'revoke_collection_group',
         'repair_collection_group', 'edit_schedule')
    UNION SELECT organization_id, id AS league_id FROM leagues
     WHERE canonical_schedule_revision > 0
  ), live_runs AS (
    SELECT organization_id, league_id, id, state
      FROM league_occurrence_generation_runs
     WHERE state IN ('approved', 'applied')
  ), current_runs AS (
    SELECT organization_id, league_id, id, candidate_occurrence_count,
           generated_occurrence_count, skipped_date_count, discrepancy_count
      FROM league_occurrence_generation_runs
     WHERE state = 'applied'
  ), invalid AS (
    SELECT e.organization_id, e.league_id
      FROM operational_markers e
     WHERE NOT EXISTS (SELECT 1 FROM current_runs r
        WHERE r.organization_id = e.organization_id AND r.league_id = e.league_id)
    UNION
    SELECT r.organization_id, r.league_id FROM current_runs r
     GROUP BY r.organization_id, r.league_id HAVING count(*) <> 1
    UNION
    SELECT r.organization_id, r.league_id FROM current_runs r
     WHERE r.candidate_occurrence_count < 0 OR r.generated_occurrence_count < 0
        OR r.skipped_date_count < 0
        OR r.candidate_occurrence_count <> r.generated_occurrence_count + r.skipped_date_count
    UNION
    SELECT r.organization_id, r.league_id FROM current_runs r
     WHERE (SELECT count(*) FROM league_occurrences o
              WHERE o.organization_id = r.organization_id AND o.league_id = r.league_id
                AND o.generation_run_id = r.id) <> r.generated_occurrence_count
        OR EXISTS (SELECT 1 FROM league_occurrences o
              WHERE o.organization_id = r.organization_id AND o.league_id = r.league_id
                AND o.generation_run_id = r.id
                AND o.lifecycle NOT IN ('published', 'locked'))
        OR (SELECT count(*) FROM league_schedule_exceptions x
              WHERE x.organization_id = r.organization_id AND x.league_id = r.league_id
                AND x.generation_run_id = r.id) <> r.skipped_date_count
        OR EXISTS (SELECT 1 FROM league_schedule_exceptions x
              WHERE x.organization_id = r.organization_id AND x.league_id = r.league_id
                AND x.generation_run_id = r.id AND x.lifecycle <> 'published')
        OR EXISTS (SELECT 1 FROM league_occurrences o
              WHERE o.organization_id = r.organization_id AND o.league_id = r.league_id
                AND o.lifecycle = 'draft' AND o.status <> 'discarded')
        OR EXISTS (SELECT 1 FROM league_occurrences o
              WHERE o.organization_id = r.organization_id AND o.league_id = r.league_id
                AND o.generation_run_id = r.id AND o.lifecycle IN ('published', 'locked')
                AND (o.published_at IS NULL OR o.published_by_user_id IS NULL OR o.publication_command_id IS NULL))
        OR EXISTS (SELECT 1 FROM league_occurrences o
              WHERE o.organization_id = r.organization_id AND o.league_id = r.league_id
                AND o.generation_run_id = r.id AND o.lifecycle IN ('published', 'locked')
              GROUP BY o.start_at HAVING count(*) > 1)
        OR EXISTS (SELECT 1 FROM league_occurrences o
              WHERE o.organization_id = r.organization_id AND o.league_id = r.league_id
                AND o.generation_run_id = r.id AND o.lifecycle IN ('published', 'locked')
                AND o.competitive AND o.competition_number IS NOT NULL
              GROUP BY o.competition_number HAVING count(*) > 1)
       OR EXISTS (SELECT 1 FROM league_schedule_exceptions x
              WHERE x.organization_id = r.organization_id AND x.league_id = r.league_id
                AND x.generation_run_id = r.id AND x.lifecycle = 'published'
                AND (x.published_at IS NULL OR x.published_by_user_id IS NULL OR x.publication_command_id IS NULL))
        OR EXISTS (SELECT 1 FROM league_schedule_exceptions x
              WHERE x.organization_id = r.organization_id AND x.league_id = r.league_id
                AND x.lifecycle = 'published'
                AND EXISTS (SELECT 1 FROM league_occurrences o
                  WHERE o.organization_id = x.organization_id AND o.league_id = x.league_id
                    AND o.lifecycle IN ('published', 'locked')
                    AND o.authoritative_local_date = x.local_date))
    UNION
    SELECT r.organization_id, r.league_id FROM current_runs r
     WHERE (SELECT count(*) FROM league_occurrence_generation_discrepancies d
              WHERE d.organization_id = r.organization_id AND d.league_id = r.league_id
                AND d.generation_run_id = r.id) <> r.discrepancy_count
    -- The count above deliberately includes retained historical rows. In
    -- particular, resolution_state = 'open' discrepancies are evidence to
    -- preserve, not a migration refusal condition.
    UNION
    SELECT r.organization_id, r.league_id
      FROM league_occurrences o
      JOIN current_runs r ON r.organization_id = o.organization_id AND r.league_id = o.league_id
     WHERE o.lifecycle IN ('published', 'locked')
       AND o.generation_run_id IS DISTINCT FROM r.id
       AND NOT (
         o.generation_run_id IS NULL
         AND o.kind IN ('makeup', 'position_round', 'rolloff', 'playoff', 'extension')
         AND o.last_command_id IS NOT NULL
         AND o.published_at IS NOT NULL
         AND o.published_by_user_id IS NOT NULL
         AND o.publication_command_id IS NOT NULL
         AND (o.kind <> 'makeup' OR EXISTS (
           SELECT 1 FROM league_occurrence_relationships x
            WHERE x.organization_id = o.organization_id AND x.league_id = o.league_id
              AND x.source_occurrence_id = o.id AND x.state = 'published'
         ))
       )
    UNION
    SELECT l.organization_id, l.league_id
      FROM live_runs l
     GROUP BY l.organization_id, l.league_id
    HAVING count(*) <> 1
    UNION
    SELECT l.organization_id, l.league_id
      FROM live_runs l
     WHERE l.state = 'approved'
       AND NOT EXISTS (SELECT 1 FROM current_runs r
         WHERE r.organization_id = l.organization_id AND r.league_id = l.league_id)
    UNION
    SELECT r.organization_id, r.league_id
      FROM league_occurrence_billing_terms t
      JOIN league_occurrences o ON o.id = t.occurrence_id AND o.organization_id = t.organization_id AND o.league_id = t.league_id
      JOIN current_runs r ON r.organization_id = t.organization_id AND r.league_id = t.league_id
     WHERE t.state = 'published' AND o.generation_run_id IS DISTINCT FROM r.id
    UNION
    SELECT r.organization_id, r.league_id
      FROM league_occurrence_relationships x
      JOIN league_occurrences o ON o.id = x.source_occurrence_id AND o.organization_id = x.organization_id AND o.league_id = x.league_id
      JOIN current_runs r ON r.organization_id = x.organization_id AND r.league_id = x.league_id
     WHERE x.state = 'published' AND (o.generation_run_id IS DISTINCT FROM r.id
       OR NOT EXISTS (SELECT 1 FROM league_occurrences target
         WHERE target.id = x.target_occurrence_id AND target.organization_id = x.organization_id
           AND target.league_id = x.league_id AND target.generation_run_id = r.id
           AND target.lifecycle IN ('published', 'locked'))
       OR x.published_at IS NULL OR x.published_by_user_id IS NULL OR x.publication_command_id IS NULL)
    UNION
    SELECT r.organization_id, r.league_id
      FROM league_schedule_exceptions x
      JOIN current_runs r ON r.organization_id = x.organization_id AND r.league_id = x.league_id
     WHERE x.lifecycle = 'published' AND x.generation_run_id IS DISTINCT FROM r.id
       AND NOT (x.generation_run_id IS NULL AND x.last_command_id IS NOT NULL
         AND x.published_at IS NOT NULL AND x.published_by_user_id IS NOT NULL
         AND x.publication_command_id IS NOT NULL)
    UNION
    SELECT r.organization_id, r.league_id FROM current_runs r
     WHERE EXISTS (SELECT 1 FROM league_occurrences o
       WHERE o.organization_id = r.organization_id AND o.league_id = r.league_id
         AND o.generation_run_id = r.id
         AND (SELECT count(*) FROM league_occurrence_billing_terms t
               WHERE t.organization_id = o.organization_id AND t.league_id = o.league_id
                 AND t.occurrence_id = o.id AND t.state = 'published') <> 1)
        OR EXISTS (SELECT 1 FROM league_occurrence_billing_terms t
              JOIN league_occurrences o ON o.id = t.occurrence_id
                AND o.organization_id = t.organization_id AND o.league_id = t.league_id
             WHERE t.organization_id = r.organization_id AND t.league_id = r.league_id
               AND t.state = 'published'
               AND (o.generation_run_id IS DISTINCT FROM r.id
                 OR t.published_at IS NULL OR t.published_by_user_id IS NULL OR t.publication_command_id IS NULL))
    UNION
    SELECT g.organization_id, g.league_id FROM canonical_collection_groups g
     WHERE g.state IN ('published', 'revoked')
       AND (
          NOT EXISTS (SELECT 1 FROM current_runs r
            WHERE r.organization_id = g.organization_id AND r.league_id = g.league_id
              AND r.id = g.generation_run_id)
        OR g.kind <> 'double_pay'
        OR g.trigger_local_date >= g.paired_local_date
        OR g.current_revision < 1 OR g.source_schedule_revision < 1
        OR g.published_at IS NULL OR g.published_by_user_id IS NULL OR g.publication_command_id IS NULL
        OR (g.state = 'revoked' AND (g.revoked_at IS NULL OR g.revoked_by_user_id IS NULL OR g.revocation_command_id IS NULL))
        OR (g.state = 'published' AND (g.revoked_at IS NOT NULL OR g.revoked_by_user_id IS NOT NULL OR g.revocation_command_id IS NOT NULL))
        OR (SELECT count(*) FROM canonical_collection_group_members m
             WHERE m.organization_id = g.organization_id AND m.league_id = g.league_id
               AND m.group_id = g.id) <> 2
        OR (SELECT count(DISTINCT m.occurrence_id) FROM canonical_collection_group_members m
             WHERE m.organization_id = g.organization_id AND m.league_id = g.league_id
               AND m.group_id = g.id) <> 2
        OR (SELECT count(DISTINCT m.billing_term_id) FROM canonical_collection_group_members m
             WHERE m.organization_id = g.organization_id AND m.league_id = g.league_id
               AND m.group_id = g.id) <> 2
        OR EXISTS (SELECT 1 FROM canonical_collection_group_members m
             WHERE m.organization_id = g.organization_id AND m.league_id = g.league_id
               AND m.group_id = g.id
               AND (m.generation_run_id IS DISTINCT FROM g.generation_run_id
                 OR m.amount_minor <= 0 OR m.billing_ordinal <= 0 OR m.currency !~ '^[A-Z]{3}$'
                 OR m.role NOT IN ('trigger', 'paired')
                 OR (m.role = 'trigger' AND m.member_ordinal <> 1)
                 OR (m.role = 'paired' AND m.member_ordinal <> 2)
                 OR (g.state = 'published' AND m.active IS NOT TRUE)
                 OR (g.state = 'revoked' AND m.active IS TRUE)))
           OR EXISTS (SELECT 1 FROM canonical_collection_group_members m
             WHERE m.organization_id = g.organization_id AND m.league_id = g.league_id
               AND m.group_id = g.id
               AND ((m.role = 'trigger' AND m.local_date <> g.trigger_local_date)
                 OR (m.role = 'paired' AND m.local_date <> g.paired_local_date)))
           OR EXISTS (SELECT 1 FROM canonical_collection_group_members m
             WHERE m.organization_id = g.organization_id AND m.league_id = g.league_id
               AND m.group_id = g.id
               AND NOT EXISTS (SELECT 1 FROM league_occurrences o
                 WHERE o.organization_id = m.organization_id AND o.league_id = m.league_id
                   AND o.id = m.occurrence_id AND o.generation_run_id = g.generation_run_id
                   AND o.lifecycle IN ('published', 'locked')
                   AND o.status IN ('scheduled', 'completed')
                   AND o.authoritative_local_date = m.local_date))
           OR EXISTS (SELECT 1 FROM canonical_collection_group_members m
             WHERE m.organization_id = g.organization_id AND m.league_id = g.league_id
               AND m.group_id = g.id
               AND NOT EXISTS (SELECT 1 FROM league_occurrence_billing_terms t
                 WHERE t.organization_id = m.organization_id AND t.league_id = m.league_id
                   AND t.id = m.billing_term_id AND t.occurrence_id = m.occurrence_id
                   AND t.state = 'published' AND t.obligation_policy = 'eligible_bowlers'
                   AND t.billing_ordinal = m.billing_ordinal
                   AND t.default_amount_minor = m.amount_minor AND t.currency = m.currency))
       )
    UNION
    SELECT l.organization_id, l.id
      FROM leagues l
     WHERE NOT EXISTS (SELECT 1 FROM current_runs r
         WHERE r.organization_id = l.organization_id AND r.league_id = l.id)
       AND (
         EXISTS (SELECT 1 FROM payment_schedules s WHERE s.league_id = l.id AND s.active = TRUE)
         OR EXISTS (SELECT 1 FROM autopay_consents c WHERE c.organization_id = l.organization_id AND c.league_id = l.id AND c.state = 'active')
         OR EXISTS (SELECT 1 FROM payment_operations p WHERE p.organization_id = l.organization_id AND p.league_id = l.id
           AND p.status IN ('pending', 'leased', 'provider_unknown', 'retry_scheduled', 'action_required', 'reconciliation_required'))
         OR EXISTS (SELECT 1 FROM payment_operation_roster_snapshot_items i WHERE i.organization_id = l.organization_id AND i.league_id = l.id AND i.state = 'reserved')
       )
  )
  SELECT array_agg(DISTINCT invalid.league_id ORDER BY invalid.league_id) INTO bad_leagues FROM invalid;

  IF bad_leagues IS NOT NULL THEN
    RAISE EXCEPTION '0034 refused: partial or contradictory canonical evidence for league(s) %', bad_leagues;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "leagues" ADD COLUMN "schedule_authority" text DEFAULT 'canonical' NOT NULL;
--> statement-breakpoint

-- Every league with retained canonical evidence passed the complete-set gate;
-- all other rows are legacy projections and remain as immutable archive
-- evidence. No production identifier is used as a classifier.
UPDATE leagues l
   SET schedule_authority = CASE WHEN EXISTS (
     SELECT 1 FROM league_occurrence_generation_runs r
      WHERE r.organization_id = l.organization_id AND r.league_id = l.id
        AND r.state = 'applied'
   ) THEN 'canonical' ELSE 'retired_legacy' END,
       active = CASE WHEN EXISTS (
     SELECT 1 FROM league_occurrence_generation_runs r
      WHERE r.organization_id = l.organization_id AND r.league_id = l.id
        AND r.state = 'applied'
   ) THEN l.active ELSE FALSE END;
--> statement-breakpoint

ALTER TABLE "leagues" ADD CONSTRAINT "leagues_schedule_authority_check"
  CHECK ("leagues"."schedule_authority" IN ('canonical', 'retired_legacy'));
--> statement-breakpoint
ALTER TABLE "leagues" ADD CONSTRAINT "leagues_retired_legacy_inactive_check"
  CHECK (NOT ("leagues"."schedule_authority" = 'retired_legacy' AND "leagues"."active" = TRUE));
--> statement-breakpoint
CREATE INDEX "leagues_schedule_authority_active_idx"
  ON "leagues" USING btree ("organization_id", "schedule_authority", "active", "name");
--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_league_schedule_authority_immutability()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.schedule_authority = 'retired_legacy'
     AND (TG_OP = 'DELETE' OR NEW IS DISTINCT FROM OLD)
     AND current_setting('leaguevault.organization_teardown', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'retired legacy leagues are permanently inactive and immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER leagues_schedule_authority_immutable
  BEFORE UPDATE OR DELETE ON "leagues"
  FOR EACH ROW EXECUTE FUNCTION enforce_league_schedule_authority_immutability();
