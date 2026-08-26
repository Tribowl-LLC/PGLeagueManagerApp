-- A real 0033 -> 0034 success fixture.  The makeup session is outside the
-- applied generation run, but its occurrence, published billing term, and
-- typed makeup relationship all carry publication audit evidence.
INSERT INTO organizations (id, name, slug)
VALUES (34, '0034 audited special organization', 'migration0034-audited-special');
INSERT INTO locations (id, name, organization_id)
VALUES (3401, '0034 audited special lanes', 34);
INSERT INTO users (id, email, password, name, organization_id)
VALUES (3401, '0034-audited-special@example.test', 'fixture-only', '0034 Fixture User', 34);
INSERT INTO leagues (
  id, name, organization_id, location_id, season_start, season_end,
  week_day, weekly_fee, timezone
) VALUES (
  3401, '0034 audited special league', 34, 3401,
  '2040-01-01T00:00:00.000Z', '2040-01-31T00:00:00.000Z',
  'Monday', 2000, 'UTC'
);

INSERT INTO league_schedule_commands (
  id, organization_id, league_id, actor_user_id, command_type,
  idempotency_key, request_fingerprint, outcome
) VALUES
  ('34000000-0000-0000-0000-000000000001', 34, 3401, 3401, 'generate', '0034-special-generate', '0034-special-generate-fp', 'applied'),
  ('34000000-0000-0000-0000-000000000002', 34, 3401, 3401, 'approve_generation', '0034-special-approve', '0034-special-approve-fp', 'applied'),
  ('34000000-0000-0000-0000-000000000003', 34, 3401, 3401, 'publish', '0034-special-publish', '0034-special-publish-fp', 'applied'),
  ('34000000-0000-0000-0000-000000000004', 34, 3401, 3401, 'create_makeup_relationship', '0034-special-relationship', '0034-special-relationship-fp', 'applied');

INSERT INTO league_occurrence_generation_runs (
  id, organization_id, league_id, originating_command_id, generator_version,
  input_fingerprint, source_schedule_revision, normalized_input_snapshot,
  range_start_date, range_end_date, candidate_occurrence_count,
  generated_occurrence_count, skipped_date_count, discrepancy_count,
  state, approved_at, approved_by_user_id, approval_command_id
) VALUES (
  '34000000-0000-0000-0000-000000000005', 34, 3401,
  '34000000-0000-0000-0000-000000000001', 'fixture-0034-special',
  '0034-special-input-fp', 1, '{}'::jsonb, '2040-01-01', '2040-01-31',
  1, 1, 0, 0, 'applied', now(), 3401,
  '34000000-0000-0000-0000-000000000002'
);

INSERT INTO league_occurrences (
  id, organization_id, league_id, location_id, generation_key, generation_run_id,
  kind, status, lifecycle, authoritative_local_date, authoritative_local_start_time,
  timezone, start_at, selected_utc_offset_minutes, fold_resolution, resolver_version,
  planned_ordinal, competition_number, competitive, counts_in_standings,
  last_command_id, published_at, published_by_user_id, publication_command_id
) VALUES
  ('34000000-0000-0000-0000-000000000006', 34, 3401, 3401, '0034-regular-1',
   '34000000-0000-0000-0000-000000000005', 'regular', 'scheduled', 'published',
   '2040-01-08', '19:00:00', 'UTC', '2040-01-08T19:00:00.000Z', 0, 'unambiguous',
   'fixture-0034-special/1', 1, 1, true, true,
   '34000000-0000-0000-0000-000000000003', now(), 3401,
   '34000000-0000-0000-0000-000000000003'),
  ('34000000-0000-0000-0000-000000000007', 34, 3401, 3401, '0034-makeup-1',
   NULL, 'makeup', 'scheduled', 'published', '2040-01-15', '19:00:00', 'UTC',
   '2040-01-15T19:00:00.000Z', 0, 'unambiguous', 'fixture-0034-special/1',
   2, NULL, false, false,
   '34000000-0000-0000-0000-000000000004', now(), 3401,
   '34000000-0000-0000-0000-000000000004');

INSERT INTO league_occurrence_billing_terms (
  organization_id, league_id, occurrence_id, purpose, obligation_policy,
  default_amount_minor, currency, billing_ordinal, version, state, current_revision,
  last_command_id, published_at, published_by_user_id, publication_command_id
) VALUES
  (34, 3401, '34000000-0000-0000-0000-000000000006', 'league_weekly_fee', 'eligible_bowlers',
   2000, 'USD', 1, 1, 'published', 1,
   '34000000-0000-0000-0000-000000000003', now(), 3401,
   '34000000-0000-0000-0000-000000000003'),
  (34, 3401, '34000000-0000-0000-0000-000000000007', 'league_weekly_fee', 'eligible_bowlers',
   2000, 'USD', 2, 1, 'published', 1,
   '34000000-0000-0000-0000-000000000004', now(), 3401,
   '34000000-0000-0000-0000-000000000004');

INSERT INTO league_occurrence_relationships (
  organization_id, league_id, kind, source_occurrence_id, target_occurrence_id,
  state, current_revision, last_command_id, published_at, published_by_user_id,
  publication_command_id
) VALUES (
  34, 3401, 'makeup_for',
  '34000000-0000-0000-0000-000000000007',
  '34000000-0000-0000-0000-000000000006',
  'published', 1, '34000000-0000-0000-0000-000000000004', now(), 3401,
  '34000000-0000-0000-0000-000000000004'
);
