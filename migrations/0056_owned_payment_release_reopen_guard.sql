-- Forward-only extension of the 0051 append-only guard for a full owned-payment release.
CREATE OR REPLACE FUNCTION roster_payment_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_gross_minor bigint;
  current_refunded_minor bigint;
  current_waived_minor bigint;
  current_effective_minor bigint;
  current_outstanding_minor bigint;
BEGIN
  IF current_setting('leaguevault.organization_teardown', true) = 'on' THEN
    RETURN OLD;
  END IF;
  IF TG_TABLE_NAME = 'payment_operation_roster_snapshot_items' THEN
    IF OLD.state = 'reserved' AND NEW.state IN ('finalized', 'released')
    AND ROW(NEW.id, NEW.operation_id, NEW.organization_id, NEW.league_id,
            NEW.obligation_id, NEW.allocation_index, NEW.amount_minor,
            NEW.created_at)
        IS NOT DISTINCT FROM
        ROW(OLD.id, OLD.operation_id, OLD.organization_id, OLD.league_id,
            OLD.obligation_id, OLD.allocation_index, OLD.amount_minor,
            OLD.created_at) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'payment_obligations' THEN
    SELECT
      COALESCE((
        SELECT SUM(pa.amount_minor)
          FROM payment_allocations pa
         WHERE pa.organization_id = NEW.organization_id
           AND pa.league_id = NEW.league_id
           AND pa.obligation_id = NEW.id
           AND pa.state = 'active'
      ), 0),
      COALESCE((
        SELECT SUM(raa.amount_minor)
          FROM refund_allocation_adjustments raa
          JOIN payment_allocations source
            ON source.id = raa.source_allocation_id
           AND source.organization_id = raa.organization_id
           AND source.league_id = raa.league_id
         WHERE raa.organization_id = NEW.organization_id
           AND raa.league_id = NEW.league_id
           AND source.obligation_id = NEW.id
           AND source.state = 'active'
      ), 0),
      COALESCE((
        SELECT SUM(raa.amount_minor)
          FROM refund_allocation_adjustments raa
          JOIN payment_allocations source
            ON source.id = raa.source_allocation_id
           AND source.organization_id = raa.organization_id
           AND source.league_id = raa.league_id
         WHERE raa.organization_id = NEW.organization_id
           AND raa.league_id = NEW.league_id
           AND source.obligation_id = NEW.id
           AND source.state = 'active'
           AND raa.disposition = 'waived'
      ), 0)
      INTO current_gross_minor, current_refunded_minor, current_waived_minor;
    current_effective_minor := GREATEST(0, current_gross_minor - current_refunded_minor);
    current_outstanding_minor := GREATEST(0, NEW.amount_minor - current_effective_minor - current_waived_minor);
    IF ROW(NEW.id, NEW.organization_id, NEW.league_id, NEW.occurrence_id,
            NEW.responsibility_id, NEW.component, NEW.payer_bowler_id,
            NEW.amount_minor, NEW.currency, NEW.due_at, NEW.past_due_at,
            NEW.created_by_user_id, NEW.created_at)
        IS NOT DISTINCT FROM
        ROW(OLD.id, OLD.organization_id, OLD.league_id, OLD.occurrence_id,
            OLD.responsibility_id, OLD.component, OLD.payer_bowler_id,
            OLD.amount_minor, OLD.currency, OLD.due_at, OLD.past_due_at,
            OLD.created_by_user_id, OLD.created_at)
    AND NEW.state IN ('open', 'partially_settled', 'settled', 'voided')
    AND (
      NEW.state = OLD.state
      OR (OLD.state = 'open' AND NEW.state IN ('partially_settled', 'settled', 'voided'))
      OR (OLD.state = 'partially_settled' AND NEW.state IN ('settled', 'voided'))
      OR (OLD.state = 'settled' AND NEW.state IN ('open', 'partially_settled') AND (
        SELECT COALESCE(SUM(pa.amount_minor), 0) - COALESCE((
          SELECT SUM(raa.amount_minor)
            FROM refund_allocation_adjustments raa
            JOIN payment_allocations source
              ON source.id = raa.source_allocation_id
             AND source.organization_id = raa.organization_id
             AND source.league_id = raa.league_id
           WHERE raa.organization_id = NEW.organization_id
             AND raa.league_id = NEW.league_id
             AND source.obligation_id = NEW.id
             AND source.state = 'active'
             AND raa.disposition = 'still_owed'
        ), 0) < NEW.amount_minor
          FROM payment_allocations pa
         WHERE pa.organization_id = NEW.organization_id
           AND pa.league_id = NEW.league_id
           AND pa.obligation_id = NEW.id
           AND pa.state = 'active'
      ))
      OR (OLD.state = 'partially_settled' AND NEW.state = 'open' AND EXISTS (
        SELECT 1
          FROM refund_allocation_adjustments raa
          JOIN payment_allocations source
            ON source.id = raa.source_allocation_id
           AND source.organization_id = raa.organization_id
           AND source.league_id = raa.league_id
         WHERE raa.organization_id = NEW.organization_id
           AND raa.league_id = NEW.league_id
           AND source.obligation_id = NEW.id
           AND source.state = 'active'
           AND raa.disposition IN ('still_owed', 'waived')
      ) AND (
        SELECT COALESCE(SUM(pa.amount_minor), 0) - COALESCE((
          SELECT SUM(raa.amount_minor)
            FROM refund_allocation_adjustments raa
            JOIN payment_allocations source
              ON source.id = raa.source_allocation_id
             AND source.organization_id = raa.organization_id
             AND source.league_id = raa.league_id
           WHERE raa.organization_id = NEW.organization_id
             AND raa.league_id = NEW.league_id
             AND source.obligation_id = NEW.id
             AND source.state = 'active'
             AND raa.disposition = 'still_owed'
        ), 0) < NEW.amount_minor
          FROM payment_allocations pa
         WHERE pa.organization_id = NEW.organization_id
           AND pa.league_id = NEW.league_id
           AND pa.obligation_id = NEW.id
           AND pa.state = 'active'
      ))
      -- A cash correction may temporarily leave a partially settled tail
      -- obligation with no active coverage. Require every part of the
      -- transition to prove the original voided cash tender and its evidence;
      -- manual obligation reopening remains rejected.
      OR (OLD.state = 'partially_settled' AND NEW.state = 'open' AND (
        SELECT COALESCE(SUM(pa.amount_minor), 0) - COALESCE((
          SELECT SUM(raa.amount_minor)
            FROM refund_allocation_adjustments raa
            JOIN payment_allocations source
              ON source.id = raa.source_allocation_id
             AND source.organization_id = raa.organization_id
             AND source.league_id = raa.league_id
           WHERE raa.organization_id = NEW.organization_id
             AND raa.league_id = NEW.league_id
             AND source.obligation_id = NEW.id
             AND source.state = 'active'
             AND raa.disposition = 'still_owed'
        ), 0)
          FROM payment_allocations pa
         WHERE pa.organization_id = NEW.organization_id
           AND pa.league_id = NEW.league_id
           AND pa.obligation_id = NEW.id
           AND pa.state = 'active'
      ) = 0 AND EXISTS (
        SELECT 1
          FROM payment_allocations released
          JOIN payments original
            ON original.id = released.payment_id
           AND original.organization_id = released.organization_id
           AND original.league_id = released.league_id
          JOIN payment_voids evidence
            ON evidence.payment_id = original.id
           AND evidence.organization_id = original.organization_id
           AND evidence.league_id = original.league_id
         WHERE released.organization_id = NEW.organization_id
           AND released.league_id = NEW.league_id
           AND released.obligation_id = NEW.id
           AND released.state = 'voided'
           AND original.type = 'cash'
           AND original.status = 'voided'
           AND original.payment_operation_id IS NULL
           AND original.provider_payment_id IS NULL
      ))
      OR (
        OLD.state IN ('partially_settled', 'settled')
        AND NEW.state IN ('open', 'partially_settled')
        AND current_effective_minor >= 0
        AND current_outstanding_minor > 0
        AND ((NEW.state = 'open' AND current_effective_minor = 0)
          OR (NEW.state = 'partially_settled' AND current_effective_minor > 0))
        AND EXISTS (
          SELECT 1
            FROM payment_allocation_corrections correction
            JOIN payment_allocations source
              ON source.id = correction.source_allocation_id
             AND source.organization_id = correction.organization_id
             AND source.league_id = correction.league_id
            JOIN payment_allocations replacement
              ON replacement.id = correction.replacement_allocation_id
             AND replacement.organization_id = correction.organization_id
             AND replacement.league_id = correction.league_id
            JOIN payments parent
              ON parent.id = correction.payment_id
             AND parent.organization_id = correction.organization_id
             AND parent.league_id = correction.league_id
           WHERE correction.organization_id = NEW.organization_id
             AND correction.league_id = NEW.league_id
             AND correction.source_obligation_id = NEW.id
             AND correction.source_obligation_id = source.obligation_id
             AND source.state = 'voided'
             AND source.allocation_kind = 'ordinary'
             AND replacement.state = 'active'
             AND replacement.allocation_kind = 'ordinary'
             AND replacement.payment_id = parent.id
             AND parent.type = 'square'
             AND parent.status = 'paid'
             AND parent.payment_operation_id IS NOT NULL
             AND parent.provider_payment_id IS NOT NULL
             AND correction.amount_minor = source.amount_minor
             AND correction.amount_minor = replacement.amount_minor
             AND correction.currency = source.currency
             AND correction.currency = replacement.currency
        )
      )
      OR (
        OLD.state IN ('partially_settled', 'settled')
        AND NEW.state IN ('open', 'partially_settled')
        AND current_effective_minor >= 0
        AND current_outstanding_minor > 0
        AND ((NEW.state = 'open' AND current_effective_minor = 0)
          OR (NEW.state = 'partially_settled' AND current_effective_minor > 0))
        AND EXISTS (
          SELECT 1
            FROM rotating_credit_application_reversals reversal
            JOIN rotating_credit_applications application
              ON application.id = reversal.application_id
             AND application.organization_id = reversal.organization_id
             AND application.league_id = reversal.league_id
            JOIN payment_allocations allocation
              ON allocation.id = reversal.allocation_id
             AND allocation.organization_id = reversal.organization_id
             AND allocation.league_id = reversal.league_id
           WHERE reversal.organization_id = NEW.organization_id
             AND reversal.league_id = NEW.league_id
             AND reversal.obligation_id = NEW.id
             AND reversal.transaction_id = pg_current_xact_id()::text
             AND reversal.funding_payment_id = application.payment_id
             AND reversal.bowler_id = application.actual_bowler_id
             AND reversal.assignment_id = application.assignment_id
             AND reversal.amount_minor = application.amount_minor
             AND reversal.amount_minor = allocation.amount_minor
             AND application.obligation_id = NEW.id
             AND application.allocation_id = allocation.id
             AND allocation.payment_id = application.payment_id
             AND allocation.obligation_id = application.obligation_id
             AND allocation.allocation_kind = 'rotating_credit'
             AND allocation.state = 'voided'
        )
      )
      -- Reopening a partially settled obligation after owned payment release is
      -- valid only in the transaction that records a full, matching release and
      -- leaves no active allocations on that obligation.
      OR (OLD.state = 'partially_settled' AND NEW.state = 'open'
        AND current_gross_minor = 0
        AND current_outstanding_minor > 0
        AND EXISTS (
          SELECT 1
            FROM weekly_payment_allocation_releases release
            JOIN payment_allocation_funding_applications application
              ON application.id = release.funding_application_id
             AND application.organization_id = release.organization_id
             AND application.league_id = release.league_id
            JOIN payment_allocations source
              ON source.id = release.source_allocation_id
             AND source.organization_id = release.organization_id
             AND source.league_id = release.league_id
           WHERE release.organization_id = NEW.organization_id
             AND release.league_id = NEW.league_id
             AND release.source_obligation_id = NEW.id
             AND release.transaction_id = pg_current_xact_id()::text
             AND release.reason IN ('ledger_adoption', 'worksheet_correction')
             AND release.payment_id = application.payment_id
             AND release.credited_bowler_id = application.credited_bowler_id
             AND release.funding_application_id = application.id
             AND release.source_allocation_id = application.allocation_id
             AND release.source_obligation_id = application.obligation_id
             AND release.source_allocation_id = source.id
             AND release.source_obligation_id = source.obligation_id
             AND release.payment_id = source.payment_id
             AND release.source_application_amount_minor = application.amount_minor
             AND release.released_amount_minor = application.amount_minor
             AND release.retained_amount_minor = 0
             AND release.replacement_allocation_id IS NULL
             AND release.currency = application.currency
             AND application.currency = source.currency
             AND source.state = 'voided'
        )
      )
    )
    AND ((NEW.state = 'voided' AND NEW.voided_at IS NOT NULL) OR (NEW.state <> 'voided' AND NEW.voided_at IS NULL)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'financial_commands' THEN
    IF ROW(NEW.id, NEW.organization_id, NEW.league_id, NEW.actor_user_id,
            NEW.command_type, NEW.idempotency_key, NEW.request_fingerprint,
            NEW.created_at)
        IS NOT DISTINCT FROM
        ROW(OLD.id, OLD.organization_id, OLD.league_id, OLD.actor_user_id,
            OLD.command_type, OLD.idempotency_key, OLD.request_fingerprint,
            OLD.created_at)
    AND NEW.state IN ('accepted', 'rejected', 'applied', 'failed')
    AND (NEW.state = OLD.state OR (OLD.state = 'accepted' AND NEW.state IN ('rejected', 'applied', 'failed'))) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'autopay_consents' THEN
    IF ROW(NEW.id, NEW.organization_id, NEW.league_id, NEW.payer_bowler_id,
            NEW.consent_version, NEW.provider_name, NEW.encrypted_source_id,
            NEW.encrypted_customer_id, NEW.created_by_user_id, NEW.created_at)
        IS NOT DISTINCT FROM
        ROW(OLD.id, OLD.organization_id, OLD.league_id, OLD.payer_bowler_id,
            OLD.consent_version, OLD.provider_name, OLD.encrypted_source_id,
            OLD.encrypted_customer_id, OLD.created_by_user_id, OLD.created_at)
    AND NEW.state IN ('pending', 'active', 'revoked', 'expired')
    AND (NEW.state = OLD.state OR (OLD.state = 'pending' AND NEW.state IN ('active', 'revoked', 'expired')) OR (OLD.state = 'active' AND NEW.state IN ('revoked', 'expired'))) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'occurrence_payment_responsibilities' THEN
    IF OLD.state = 'active' AND NEW.state = 'voided'
    AND ROW(NEW.id, NEW.organization_id, NEW.league_id, NEW.occurrence_id,
            NEW.team_id, NEW.slot_id, NEW.slot_index, NEW.position_index,
            NEW.responsibility_key, NEW.version, NEW.responsibility_kind,
            NEW.main_bowler_id, NEW.substitute_bowler_id, NEW.payer_bowler_id,
            NEW.lineage_payer_bowler_id, NEW.prize_payer_bowler_id,
            NEW.policy, NEW.amount_minor, NEW.lineage_amount_minor,
            NEW.prize_fund_amount_minor, NEW.currency, NEW.due_at,
            NEW.past_due_at, NEW.assignment_note, NEW.recorded_by_user_id,
            NEW.created_at)
        IS NOT DISTINCT FROM
        ROW(OLD.id, OLD.organization_id, OLD.league_id, OLD.occurrence_id,
            OLD.team_id, OLD.slot_id, OLD.slot_index, OLD.position_index,
            OLD.responsibility_key, OLD.version, OLD.responsibility_kind,
            OLD.main_bowler_id, OLD.substitute_bowler_id, OLD.payer_bowler_id,
            OLD.lineage_payer_bowler_id, OLD.prize_payer_bowler_id,
            OLD.policy, OLD.amount_minor, OLD.lineage_amount_minor,
            OLD.prize_fund_amount_minor, OLD.currency, OLD.due_at,
            OLD.past_due_at, OLD.assignment_note, OLD.recorded_by_user_id,
            OLD.created_at) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'roster payment evidence is append-only';
END;
$$;
--> statement-breakpoint
