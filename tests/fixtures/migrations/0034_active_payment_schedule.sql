-- This fixture is applied to a disposable database stopped at migration 0033.
-- Migration 0034 must fail closed rather than silently retiring a league that
-- still has an executable legacy payment schedule.
INSERT INTO organizations (name, slug)
VALUES ('0034 financial refusal organization', 'migration0034-financial-refusal');

INSERT INTO locations (name, organization_id)
SELECT '0034 financial refusal lanes', id
  FROM organizations
 WHERE slug = 'migration0034-financial-refusal';

INSERT INTO bowlers (name, organization_id)
SELECT '0034 financial refusal bowler', id
  FROM organizations
 WHERE slug = 'migration0034-financial-refusal';

INSERT INTO leagues (
  name, organization_id, location_id, season_start, season_end,
  week_day, weekly_fee, timezone
)
SELECT '0034 financial refusal league', o.id, l.id,
       '2040-01-01T00:00:00.000Z', '2040-04-01T00:00:00.000Z',
       'Monday', 2000, 'UTC'
  FROM organizations o
  JOIN locations l ON l.organization_id = o.id
 WHERE o.slug = 'migration0034-financial-refusal';

INSERT INTO payment_schedules (
  bowler_id, league_id, frequency, amount, next_payment_date, payment_card_id, active
)
SELECT b.id, g.id, 'weekly', 2000, '2040-01-08T19:00:00.000Z', 'ccof:0034-financial-refusal', TRUE
  FROM bowlers b
  JOIN organizations o ON o.id = b.organization_id
  JOIN leagues g ON g.organization_id = o.id
 WHERE o.slug = 'migration0034-financial-refusal';

-- Both statuses carry provider/dispatch responsibility and must remain an
-- intentional migration refusal rather than being silently retired.
INSERT INTO payment_operations (
  organization_id, league_id, operation_type, target_key, amount_minor,
  currency, status, provider_name, request_fingerprint, provider_idempotency_key,
  error_classification,
  payment_schedule_id, billing_cycle_at
)
SELECT o.id, g.id, 'scheduled_charge', '0034-financial-provider-unknown', 2000,
       'USD', 'provider_unknown', 'square', 'lvpayreq:v1:0000000000000000000000000000000000000000000000000000000000000000',
       'lv0034-provider-unknown', 'provider_unknown', s.id, '2040-01-08T19:00:00.000Z'
  FROM organizations o
  JOIN leagues g ON g.organization_id = o.id
  JOIN payment_schedules s ON s.league_id = g.id
 WHERE o.slug = 'migration0034-financial-refusal';
INSERT INTO payment_operations (
  organization_id, league_id, operation_type, target_key, amount_minor,
  currency, status, provider_name, request_fingerprint, provider_idempotency_key,
  error_classification,
  payment_schedule_id, billing_cycle_at, next_attempt_at, completed_at
)
SELECT o.id, g.id, 'scheduled_charge', '0034-financial-reconciliation-required', 2000,
       'USD', 'reconciliation_required', 'square', 'lvpayreq:v1:1111111111111111111111111111111111111111111111111111111111111111',
       'lv0034-reconciliation', 'provider_unknown', s.id, '2040-01-15T19:00:00.000Z', NULL, now()
  FROM organizations o
  JOIN leagues g ON g.organization_id = o.id
  JOIN payment_schedules s ON s.league_id = g.id
 WHERE o.slug = 'migration0034-financial-refusal';
