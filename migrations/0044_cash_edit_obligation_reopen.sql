-- A cash edit can retire the only active allocation from a partially settled
-- obligation before the replacement tender is inserted. Preserve the
-- append-only evidence fence while allowing that one audited transition.
CREATE OR REPLACE FUNCTION roster_payment_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
