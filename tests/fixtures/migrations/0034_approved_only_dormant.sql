-- An approved but never-applied generation is dormant draft evidence.  It is
-- not an operational canonical set and must be retired rather than refused.
INSERT INTO organizations (id, name, slug)
VALUES (36, '0034 approved-only organization', 'migration0034-approved-only');
INSERT INTO locations (id, name, organization_id)
VALUES (3601, '0034 approved-only lanes', 36);
INSERT INTO users (id, email, password, name, organization_id)
VALUES (3601, '0034-approved-only@example.test', 'fixture-only', '0034 Fixture User', 36);
INSERT INTO leagues (id, name, organization_id, location_id, season_start, season_end, week_day, weekly_fee, timezone)
VALUES (3601, '0034 approved-only league', 36, 3601, '2040-01-01T00:00:00.000Z', '2040-01-31T00:00:00.000Z', 'Monday', 2000, 'UTC');
INSERT INTO league_schedule_commands (
  id, organization_id, league_id, actor_user_id, command_type,
  idempotency_key, request_fingerprint, outcome
) VALUES
  ('36000000-0000-0000-0000-000000000001', 36, 3601, 3601, 'generate', '0034-approved-generate', '0034-approved-generate-fp', 'applied'),
  ('36000000-0000-0000-0000-000000000002', 36, 3601, 3601, 'approve_generation', '0034-approved-approve', '0034-approved-approve-fp', 'applied');
INSERT INTO league_occurrence_generation_runs (
  id, organization_id, league_id, originating_command_id, generator_version,
  input_fingerprint, source_schedule_revision, normalized_input_snapshot,
  range_start_date, range_end_date, candidate_occurrence_count,
  generated_occurrence_count, skipped_date_count, discrepancy_count,
  state, approved_at, approved_by_user_id, approval_command_id
) VALUES (
  '36000000-0000-0000-0000-000000000003', 36, 3601,
  '36000000-0000-0000-0000-000000000001', 'fixture-0034-approved-only',
  '0034-approved-only-input-fp', 1, '{}'::jsonb, '2040-01-01', '2040-01-31',
  1, 0, 1, 0, 'approved', now(), 3601,
  '36000000-0000-0000-0000-000000000002'
);
