-- The same audited post-set occurrence without its typed relationship must be
-- refused.  The fixture remains schema-valid so the refusal comes from the
-- migration's operational-set gate rather than a fixture constraint.
INSERT INTO organizations (id, name, slug)
VALUES (35, '0034 malformed special organization', 'migration0034-malformed-special');
INSERT INTO locations (id, name, organization_id)
VALUES (3501, '0034 malformed special lanes', 35);
INSERT INTO users (id, email, password, name, organization_id)
VALUES (3501, '0034-malformed-special@example.test', 'fixture-only', '0034 Fixture User', 35);
INSERT INTO leagues (
  id, name, organization_id, location_id, season_start, season_end,
  week_day, weekly_fee, timezone
) VALUES (
  3501, '0034 malformed special league', 35, 3501,
  '2040-01-01T00:00:00.000Z', '2040-01-31T00:00:00.000Z',
  'Monday', 2000, 'UTC'
);
INSERT INTO league_schedule_commands (
  id, organization_id, league_id, actor_user_id, command_type,
  idempotency_key, request_fingerprint, outcome
) VALUES
  ('35000000-0000-0000-0000-000000000001', 35, 3501, 3501, 'generate', '0034-malformed-generate', '0034-malformed-generate-fp', 'applied'),
  ('35000000-0000-0000-0000-000000000002', 35, 3501, 3501, 'approve_generation', '0034-malformed-approve', '0034-malformed-approve-fp', 'applied'),
  ('35000000-0000-0000-0000-000000000003', 35, 3501, 3501, 'publish', '0034-malformed-publish', '0034-malformed-publish-fp', 'applied');
INSERT INTO league_occurrence_generation_runs (
  id, organization_id, league_id, originating_command_id, generator_version,
  input_fingerprint, source_schedule_revision, normalized_input_snapshot,
  range_start_date, range_end_date, candidate_occurrence_count,
  generated_occurrence_count, skipped_date_count, discrepancy_count,
  state, approved_at, approved_by_user_id, approval_command_id
) VALUES (
  '35000000-0000-0000-0000-000000000004', 35, 3501,
  '35000000-0000-0000-0000-000000000001', 'fixture-0034-malformed',
  '0034-malformed-input-fp', 1, '{}'::jsonb, '2040-01-01', '2040-01-31',
  1, 1, 0, 0, 'applied', now(), 3501,
  '35000000-0000-0000-0000-000000000002'
);
INSERT INTO league_occurrences (
  id, organization_id, league_id, location_id, generation_key, generation_run_id,
  kind, status, lifecycle, authoritative_local_date, authoritative_local_start_time,
  timezone, start_at, selected_utc_offset_minutes, fold_resolution, resolver_version,
  planned_ordinal, competition_number, competitive, counts_in_standings,
  last_command_id, published_at, published_by_user_id, publication_command_id
) VALUES
  ('35000000-0000-0000-0000-000000000005', 35, 3501, 3501, '0034-malformed-regular',
   '35000000-0000-0000-0000-000000000004', 'regular', 'scheduled', 'published',
   '2040-01-08', '19:00:00', 'UTC', '2040-01-08T19:00:00.000Z', 0, 'unambiguous',
   'fixture-0034-malformed/1', 1, 1, true, true,
   '35000000-0000-0000-0000-000000000003', now(), 3501,
   '35000000-0000-0000-0000-000000000003'),
  ('35000000-0000-0000-0000-000000000006', 35, 3501, 3501, '0034-malformed-makeup',
   NULL, 'makeup', 'scheduled', 'published', '2040-01-15', '19:00:00', 'UTC',
   '2040-01-15T19:00:00.000Z', 0, 'unambiguous', 'fixture-0034-malformed/1',
   2, NULL, false, false,
   '35000000-0000-0000-0000-000000000003', now(), 3501,
   '35000000-0000-0000-0000-000000000003');
INSERT INTO league_occurrence_billing_terms (
  organization_id, league_id, occurrence_id, purpose, obligation_policy,
  default_amount_minor, currency, billing_ordinal, version, state, current_revision,
  last_command_id, published_at, published_by_user_id, publication_command_id
) VALUES
  (35, 3501, '35000000-0000-0000-0000-000000000005', 'league_weekly_fee', 'eligible_bowlers', 2000, 'USD', 1, 1, 'published', 1, '35000000-0000-0000-0000-000000000003', now(), 3501, '35000000-0000-0000-0000-000000000003'),
  (35, 3501, '35000000-0000-0000-0000-000000000006', 'league_weekly_fee', 'eligible_bowlers', 2000, 'USD', 2, 1, 'published', 1, '35000000-0000-0000-0000-000000000003', now(), 3501, '35000000-0000-0000-0000-000000000003');
