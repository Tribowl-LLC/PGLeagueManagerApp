-- PostgreSQL fixture for migration 0034: open historical-payment
-- discrepancies are retained evidence, not an incomplete canonical set.
-- This is applied to a disposable database stopped at migration 0033, then
-- migration 0034 is replayed against the real canonical tables.
INSERT INTO organizations (id, name, slug)
VALUES (3, 'Fixture Organization', 'fixture-0034-org');
INSERT INTO users (id, email, password, name, organization_id)
VALUES (3, 'fixture-0034@example.test', 'fixture-only', '0034 Fixture User', 3);
INSERT INTO leagues (id, name, season_start, season_end, week_day, organization_id)
VALUES (7, 'Fixture Historical League', '2025-01-01', '2025-12-31', 'Wednesday', 3);
INSERT INTO league_schedule_commands (
  id, organization_id, league_id, actor_user_id, command_type,
  idempotency_key, request_fingerprint, outcome
) VALUES
  ('00000000-0000-0000-0000-000000000034', 3, 7, 3, 'generate', 'fixture-0034-generate', 'fixture-0034-generate-fingerprint', 'applied'),
  ('00000000-0000-0000-0000-000000000035', 3, 7, 3, 'approve_generation', 'fixture-0034-approve', 'fixture-0034-approve-fingerprint', 'applied');
INSERT INTO league_occurrence_generation_runs (
  id, organization_id, league_id, originating_command_id, generator_version,
  input_fingerprint, source_schedule_revision, normalized_input_snapshot,
  range_start_date, range_end_date, candidate_occurrence_count,
  generated_occurrence_count, skipped_date_count, discrepancy_count,
  state, approved_at, approved_by_user_id, approval_command_id
) VALUES (
  '00000000-0000-0000-0000-000000000036', 3, 7,
  '00000000-0000-0000-0000-000000000034', 'fixture-0034',
  'fixture-0034-fingerprint', 1, '{}'::jsonb, '2025-01-01', '2025-12-31',
  0, 0, 0, 34, 'applied', now(), 3,
  '00000000-0000-0000-0000-000000000035'
);
INSERT INTO league_occurrence_generation_discrepancies (
  organization_id, league_id, generation_run_id, severity, code, details,
  resolution_state
)
SELECT 3, 7, '00000000-0000-0000-0000-000000000036', 'warning',
  'ambiguous_historical_payment', '{}'::jsonb, 'open'
FROM generate_series(1, 34);

DO $$
DECLARE
  expected integer;
  retained integer;
BEGIN
  SELECT discrepancy_count INTO expected FROM league_occurrence_generation_runs
   WHERE organization_id = 3 AND league_id = 7 AND state = 'applied';
  SELECT count(*) INTO retained FROM league_occurrence_generation_discrepancies
   WHERE generation_run_id = '00000000-0000-0000-0000-000000000036'
     AND resolution_state = 'open';
  IF expected <> retained THEN
    RAISE EXCEPTION 'historical discrepancy count parity was not preserved';
  END IF;
END $$;
