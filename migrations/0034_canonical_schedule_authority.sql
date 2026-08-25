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
  "canonical_collection_group_members"
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
    UNION
    SELECT r.organization_id, r.league_id FROM current_runs r
     WHERE (SELECT count(*) FROM league_occurrence_generation_discrepancies d
              WHERE d.organization_id = r.organization_id AND d.league_id = r.league_id
                AND d.generation_run_id = r.id) <> r.discrepancy_count
        OR EXISTS (SELECT 1 FROM league_occurrence_generation_discrepancies d
              WHERE d.organization_id = r.organization_id AND d.league_id = r.league_id
                AND d.generation_run_id = r.id AND d.resolution_state = 'open')
    UNION
    SELECT r.organization_id, r.league_id FROM current_runs r
     WHERE EXISTS (SELECT 1 FROM league_occurrences o
       WHERE o.organization_id = r.organization_id AND o.league_id = r.league_id
         AND o.generation_run_id = r.id
         AND (SELECT count(*) FROM league_occurrence_billing_terms t
               WHERE t.organization_id = o.organization_id AND t.league_id = o.league_id
                 AND t.occurrence_id = o.id AND t.state = 'published') <> 1)
    UNION
    SELECT g.organization_id, g.league_id FROM canonical_collection_groups g
     WHERE g.state NOT IN ('published', 'revoked')
        OR (SELECT count(*) FROM canonical_collection_group_members m
             WHERE m.organization_id = g.organization_id AND m.league_id = g.league_id
               AND m.group_id = g.id) <> 2
        OR EXISTS (SELECT 1 FROM canonical_collection_group_members m
             WHERE m.organization_id = g.organization_id AND m.league_id = g.league_id
               AND m.group_id = g.id
               AND NOT EXISTS (SELECT 1 FROM league_occurrences o
                 WHERE o.organization_id = m.organization_id AND o.league_id = m.league_id
                   AND o.id = m.occurrence_id AND o.lifecycle IN ('published', 'locked')))
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
     AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'retired legacy leagues are permanently inactive and immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER leagues_schedule_authority_immutable
  BEFORE UPDATE ON "leagues"
  FOR EACH ROW EXECUTE FUNCTION enforce_league_schedule_authority_immutability();
