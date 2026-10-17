ALTER TABLE "refund_payment_operation_snapshots" DROP CONSTRAINT "refund_payment_operation_snapshots_allocation_snapshot_check";--> statement-breakpoint
ALTER TABLE "refund_allocation_adjustments" DROP CONSTRAINT "refund_allocation_adjustments_fingerprint_check";--> statement-breakpoint
ALTER TABLE "refund_payment_operation_snapshots" ADD CONSTRAINT "refund_payment_operation_snapshots_allocation_snapshot_check" CHECK (jsonb_typeof("refund_payment_operation_snapshots"."allocation_snapshot") = 'array' AND ("refund_payment_operation_snapshots"."snapshot_version" IN (1, 3) OR jsonb_array_length("refund_payment_operation_snapshots"."allocation_snapshot") > 0));--> statement-breakpoint
ALTER TABLE "refund_allocation_adjustments" ADD CONSTRAINT "refund_allocation_adjustments_fingerprint_check" CHECK ("refund_allocation_adjustments"."snapshot_fingerprint" ~ '^lvpayexecrf:v[23]:[0-9a-f]{64}$');
--> statement-breakpoint
-- Preserve legacy cash/check deletion when there is no owned-funding sidecar.
-- If a sidecar exists, run the frozen strict source validator unchanged.
CREATE OR REPLACE FUNCTION assert_owned_payment_source_applications(
  p_organization_id integer,
  p_league_id integer,
  p_payment_id integer
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  payment_row record;
  funding_row record;
  operation_row record;
  roster_snapshot record;
  funding_count integer;
  funding_total bigint;
  allocation_row record;
  owner_row record;
  current_owner_kind text;
  current_owner_bowler_id integer;
  current_owner_team_id integer;
  has_exact_adoption_proof boolean;
  source_application_total bigint;
  obligation_covered bigint;
  expected_item_count integer;
  evidence_valid boolean;
BEGIN
  SELECT count(*), coalesce(sum(f.amount_minor), 0)
    INTO funding_count, funding_total
    FROM weekly_payment_fundings f
   WHERE f.organization_id = p_organization_id
     AND f.league_id = p_league_id
     AND f.payment_id = p_payment_id;
  IF funding_count = 0 THEN RETURN; END IF;
  SELECT id, organization_id, league_id, bowler_id, amount, currency, type,
         status, provider_payment_id, payment_operation_id, square_refund_id, dispute_id, disputed_at
    INTO payment_row
    FROM payments
   WHERE id = p_payment_id
     AND organization_id = p_organization_id
     AND league_id = p_league_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_funding_ledger_guard',
      MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: funding_payment_missing';
  END IF;

  IF payment_row.amount <= 0 OR payment_row.currency <> 'USD'
     OR funding_total <> payment_row.amount
     OR EXISTS (
       SELECT 1 FROM rotating_credit_fundings rotating
        WHERE rotating.organization_id = p_organization_id
          AND rotating.league_id = p_league_id
          AND rotating.payment_id = p_payment_id
     )
     OR EXISTS (
       SELECT 1 FROM weekly_payment_fundings f
        WHERE f.organization_id = p_organization_id
          AND f.league_id = p_league_id
          AND f.payment_id = p_payment_id
          AND f.currency <> payment_row.currency
     )
  THEN
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_funding_ledger_guard',
      MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: funding_conservation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM weekly_payment_fundings f
     WHERE f.organization_id = p_organization_id
       AND f.league_id = p_league_id
       AND f.payment_id = p_payment_id
     GROUP BY f.payment_id
    HAVING count(DISTINCT f.credited_bowler_id) <> count(*)
       OR count(DISTINCT f.portion_index) <> count(*)
       OR min(f.portion_index) <> 0 OR max(f.portion_index) <> count(*) - 1
       OR count(DISTINCT f.source) <> 1
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_funding_ledger_guard',
      MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: funding_portion_identity';
  END IF;

  IF payment_row.status NOT IN ('paid', 'voided', 'refunded')
     OR (payment_row.status = 'refunded' AND (
       payment_row.square_refund_id IS NULL
       OR payment_row.type IN ('cash', 'check')
       OR NOT EXISTS (
         SELECT 1
           FROM refund_payment_operation_snapshots refund_snapshot
           JOIN payment_operations refund_operation
             ON refund_operation.id = refund_snapshot.operation_id
            AND refund_operation.organization_id = p_organization_id
            AND refund_operation.league_id = p_league_id
          WHERE refund_snapshot.payment_id = p_payment_id
            AND refund_snapshot.league_id = p_league_id
            AND refund_snapshot.snapshot_version = 3
            AND refund_snapshot.snapshot_fingerprint ~ '^lvpayexecrf:v3:[0-9a-f]{64}$'
            AND refund_operation.operation_type = 'refund'
            AND refund_operation.target_key = 'payment-refund:' || p_payment_id::text
            AND refund_operation.status = 'succeeded'
            AND refund_operation.amount_minor = payment_row.amount
            AND refund_operation.currency = payment_row.currency
            AND refund_operation.provider_name = 'square'
            AND refund_operation.provider_object_id = payment_row.square_refund_id
            AND refund_operation.completed_at IS NOT NULL
       )
     ))
     OR (payment_row.status = 'paid' AND EXISTS (
       SELECT 1 FROM payment_voids v
        WHERE v.organization_id = p_organization_id AND v.league_id = p_league_id AND v.payment_id = p_payment_id
     ))
     OR (payment_row.status = 'voided' AND NOT EXISTS (
       SELECT 1 FROM payment_voids v
        WHERE v.organization_id = p_organization_id AND v.league_id = p_league_id AND v.payment_id = p_payment_id
     ))
     OR (payment_row.type IN ('cash', 'check') AND (payment_row.provider_payment_id IS NOT NULL OR payment_row.payment_operation_id IS NOT NULL))
     OR (payment_row.type NOT IN ('cash', 'check') AND (payment_row.provider_payment_id IS NULL OR payment_row.payment_operation_id IS NULL))
  THEN
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_funding_ledger_guard',
      MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: funding_tender_identity';
  END IF;

  FOR funding_row IN
    SELECT * FROM weekly_payment_fundings
     WHERE organization_id = p_organization_id
       AND league_id = p_league_id
       AND payment_id = p_payment_id
     ORDER BY portion_index
     FOR SHARE
  LOOP
    IF funding_row.amount_minor <= 0 OR funding_row.currency <> payment_row.currency THEN
      RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_funding_ledger_guard',
        MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: funding_amount';
    END IF;

    IF funding_row.authorization_kind IN ('manual_receipt', 'legacy_payment') THEN
      IF funding_count <> 1 OR funding_row.portion_index <> 0
         OR funding_row.amount_minor <> payment_row.amount
         OR funding_row.credited_bowler_id <> payment_row.bowler_id
         OR payment_row.type NOT IN ('cash', 'check')
         OR payment_row.provider_payment_id IS NOT NULL OR payment_row.payment_operation_id IS NOT NULL
         OR funding_row.authorization_operation_id IS NOT NULL
         OR funding_row.authorization_item_count <> 0
         OR funding_row.authorization_fingerprint !~ '^lv(?:weeklyreceipt|weeklyadopt):v1:[0-9a-f]{64}$'
         OR (funding_row.authorization_kind = 'manual_receipt'
             AND (funding_row.source <> 'worksheet_manual' OR funding_row.adoption_id IS NOT NULL
               OR NOT EXISTS (
                 SELECT 1
                   FROM weekly_payment_worksheet_receipt_revisions revision
                   JOIN weekly_payment_worksheet_receipts receipt
                     ON receipt.id = revision.receipt_id
                    AND receipt.organization_id = revision.organization_id
                    AND receipt.league_id = revision.league_id
                  WHERE revision.organization_id = p_organization_id
                    AND revision.league_id = p_league_id
                    AND revision.payment_id = p_payment_id
                    AND revision.amount_minor = payment_row.amount
                    AND revision.revision_kind IN ('manual_record', 'manual_edit')
                    AND receipt.payer_bowler_id = funding_row.credited_bowler_id
                    AND receipt.receipt_kind = 'manual'
               )))
         OR (funding_row.authorization_kind = 'legacy_payment'
             AND (funding_row.source <> 'legacy_adoption' OR funding_row.adoption_id IS NULL))
      THEN
        RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_funding_ledger_guard',
          MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: funding_manual_provenance';
      END IF;
    ELSIF funding_row.authorization_kind = 'provider_snapshot' THEN
      IF funding_row.source <> 'provider' OR funding_row.adoption_id IS NOT NULL
         OR funding_row.authorization_operation_id IS DISTINCT FROM payment_row.payment_operation_id
         OR funding_row.authorization_item_count <> 0
         OR EXISTS (
           SELECT 1 FROM account_payment_operation_snapshots snapshot
            WHERE snapshot.operation_id = payment_row.payment_operation_id
              AND snapshot.organization_id = p_organization_id
              AND snapshot.league_id = p_league_id
         ) IS FALSE
      THEN
        RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_funding_ledger_guard',
          MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: funding_provider_provenance';
      END IF;
    ELSIF funding_row.authorization_kind = 'legacy_provider_snapshot' THEN
      IF funding_row.source <> 'legacy_adoption' OR funding_row.adoption_id IS NULL
         OR funding_row.authorization_operation_id IS DISTINCT FROM payment_row.payment_operation_id
         OR funding_row.authorization_item_count <= 0
      THEN
        RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_funding_ledger_guard',
          MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: funding_legacy_provider_provenance';
      END IF;
      SELECT op.id, op.operation_type, op.status, op.amount_minor, op.currency,
             op.provider_name, op.provider_object_id,
             snapshot.snapshot_kind, snapshot.snapshot_version,
             snapshot.amount_minor AS snapshot_amount_minor,
             snapshot.currency AS snapshot_currency,
             snapshot.snapshot_fingerprint, snapshot.obligations
        INTO operation_row
        FROM payment_operations op
        JOIN payment_operation_roster_snapshots snapshot
          ON snapshot.operation_id = op.id
         AND snapshot.organization_id = op.organization_id
         AND snapshot.league_id = op.league_id
       WHERE op.id = funding_row.authorization_operation_id
         AND op.organization_id = p_organization_id
         AND op.league_id = p_league_id;
      IF NOT FOUND OR operation_row.status <> 'succeeded'
         OR operation_row.provider_name <> 'square'
         OR operation_row.provider_object_id IS DISTINCT FROM payment_row.provider_payment_id
         OR operation_row.amount_minor <> payment_row.amount
         OR operation_row.currency <> payment_row.currency
         OR operation_row.snapshot_amount_minor <> payment_row.amount
         OR operation_row.snapshot_currency <> payment_row.currency
         OR operation_row.snapshot_fingerprint <> funding_row.authorization_fingerprint
         OR operation_row.snapshot_kind NOT IN ('interactive', 'standing_autopay')
         OR (operation_row.snapshot_kind = 'interactive' AND operation_row.operation_type <> 'interactive_charge')
         OR (operation_row.snapshot_kind = 'standing_autopay' AND operation_row.operation_type <> 'standing_autopay_charge')
      THEN
        RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_funding_ledger_guard',
          MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: funding_legacy_provider_snapshot';
      END IF;
      SELECT count(*) INTO expected_item_count
        FROM payment_operation_roster_snapshot_items item
       WHERE item.operation_id = funding_row.authorization_operation_id
         AND item.organization_id = p_organization_id
         AND item.league_id = p_league_id
         AND item.state = 'finalized';
      IF expected_item_count = 0 OR expected_item_count <> jsonb_array_length(operation_row.obligations)
         OR EXISTS (
           SELECT 1 FROM payment_operation_roster_snapshot_items item
            WHERE item.operation_id = funding_row.authorization_operation_id
              AND item.organization_id = p_organization_id
              AND item.league_id = p_league_id
              AND item.state <> 'finalized'
         )
         OR EXISTS (
           SELECT 1
             FROM payment_operation_roster_snapshot_items item
            WHERE item.operation_id = funding_row.authorization_operation_id
              AND item.organization_id = p_organization_id
              AND item.league_id = p_league_id
              AND NOT EXISTS (
                SELECT 1 FROM jsonb_array_elements(operation_row.obligations) saved(value)
                 WHERE saved.value->>'allocationIndex' = item.allocation_index::text
                   AND saved.value->>'obligationId' = item.obligation_id::text
                   AND saved.value->>'amountMinor' = item.amount_minor::text
              )
         )
      THEN
        RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_funding_ledger_guard',
          MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: funding_legacy_snapshot_items';
      END IF;
      SELECT count(*), coalesce(sum(auth.authorized_amount_minor), 0),
             bool_and(item.state = 'finalized')
        INTO expected_item_count, source_application_total, evidence_valid
        FROM weekly_payment_funding_authorization_items auth
        LEFT JOIN payment_operation_roster_snapshot_items item
          ON item.operation_id = auth.source_operation_id
         AND item.organization_id = auth.organization_id
         AND item.league_id = auth.league_id
         AND item.allocation_index = auth.source_allocation_index
         AND item.amount_minor = auth.authorized_amount_minor
       WHERE auth.organization_id = p_organization_id
         AND auth.league_id = p_league_id
         AND auth.funding_id = funding_row.id;
      IF expected_item_count <> funding_row.authorization_item_count
         OR source_application_total <> funding_row.amount_minor
         OR evidence_valid IS DISTINCT FROM true
         OR EXISTS (
           SELECT 1 FROM weekly_payment_funding_authorization_items auth
            WHERE auth.organization_id = p_organization_id
              AND auth.league_id = p_league_id
              AND auth.funding_id = funding_row.id
              AND (auth.source_operation_id <> funding_row.authorization_operation_id
                OR auth.source_snapshot_fingerprint <> funding_row.authorization_fingerprint
                OR NOT EXISTS (
                  SELECT 1 FROM jsonb_array_elements(operation_row.obligations) saved(value)
                   WHERE saved.value->>'allocationIndex' = auth.source_allocation_index::text
                     AND saved.value->>'amountMinor' = auth.authorized_amount_minor::text
                     AND (
                       (operation_row.snapshot_kind = 'interactive'
                         AND saved.value->>'bowlerId' = funding_row.credited_bowler_id::text)
                       OR (operation_row.snapshot_kind = 'standing_autopay'
                         AND saved.value->>'payerBowlerId' = funding_row.credited_bowler_id::text
                         AND EXISTS (
                           SELECT 1
                             FROM payment_operation_standing_autopay_bindings binding
                             JOIN payment_operation_standing_autopay_participants participant
                               ON participant.operation_id = binding.operation_id
                              AND participant.organization_id = binding.organization_id
                              AND participant.league_id = binding.league_id
                            WHERE binding.operation_id = funding_row.authorization_operation_id
                              AND binding.organization_id = p_organization_id
                              AND binding.league_id = p_league_id
                              AND binding.evidence_fingerprint = operation_row.snapshot_fingerprint
                              AND participant.allocation_index = auth.source_allocation_index
                              AND participant.obligation_id::text = saved.value->>'obligationId'
                              AND participant.bowler_id = funding_row.credited_bowler_id
                              AND participant.consent_version = binding.consent_version
                         ))
                     )
                ))
         )
      THEN
        RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_funding_ledger_guard',
          MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: funding_legacy_authorization_items';
      END IF;
    ELSE
      RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_funding_ledger_guard',
        MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: funding_authorization_kind';
    END IF;
  END LOOP;

  IF payment_row.status = 'voided' AND EXISTS (
    SELECT 1 FROM payment_allocations allocation
     WHERE allocation.organization_id = p_organization_id
       AND allocation.league_id = p_league_id
       AND allocation.payment_id = p_payment_id
       AND allocation.state <> 'voided'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_funding_ledger_guard',
      MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: funding_void_active_allocation';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM payment_allocations allocation
      LEFT JOIN payment_allocation_funding_applications application
        ON application.allocation_id = allocation.id
       AND application.organization_id = allocation.organization_id
       AND application.league_id = allocation.league_id
      LEFT JOIN weekly_payment_fundings funding
        ON funding.id = application.generic_funding_id
       AND funding.organization_id = application.organization_id
       AND funding.league_id = application.league_id
       AND funding.payment_id = application.payment_id
       AND funding.credited_bowler_id = application.credited_bowler_id
       AND funding.amount_minor = application.source_amount_minor
       AND funding.currency = application.currency
      LEFT JOIN payment_obligations obligation
        ON obligation.id = application.obligation_id
       AND obligation.organization_id = application.organization_id
       AND obligation.league_id = application.league_id
       AND obligation.responsibility_id = application.responsibility_id
       AND obligation.occurrence_id = application.occurrence_id
      LEFT JOIN occurrence_payment_responsibilities responsibility
        ON responsibility.id = application.responsibility_id
       AND responsibility.organization_id = application.organization_id
       AND responsibility.league_id = application.league_id
       AND responsibility.occurrence_id = application.occurrence_id
       AND responsibility.team_id = application.team_id
      LEFT JOIN LATERAL (
        SELECT revision.owner_kind, revision.owner_bowler_id, revision.owner_team_id
          FROM payment_obligation_owner_revisions revision
         WHERE revision.organization_id = application.organization_id
           AND revision.league_id = application.league_id
           AND revision.obligation_id = application.obligation_id
         ORDER BY revision.revision_number DESC, revision.id ASC
         LIMIT 1
      ) current_owner ON true
     WHERE allocation.organization_id = p_organization_id
       AND allocation.league_id = p_league_id
       AND allocation.payment_id = p_payment_id
       AND (
         (allocation.state = 'active' AND (
           application.id IS NULL OR application.payment_id <> p_payment_id
           OR application.amount_minor <> allocation.amount_minor
           OR application.obligation_id <> allocation.obligation_id
           OR application.currency <> allocation.currency
           OR application.generic_funding_id IS NULL OR application.rotating_funding_id IS NOT NULL
           OR funding.id IS NULL OR obligation.id IS NULL OR responsibility.id IS NULL
           OR application.amount_minor <= 0
           OR (application.target_kind = 'bowler_responsibility' AND (
             application.target_payer_bowler_id IS NULL OR application.assignment_id IS NOT NULL
             OR obligation.payer_bowler_id IS DISTINCT FROM application.target_payer_bowler_id
             OR (coalesce(current_owner.owner_kind, 'bowler') <> 'bowler'
               OR coalesce(current_owner.owner_bowler_id, obligation.payer_bowler_id) <> application.credited_bowler_id)
             AND NOT EXISTS (
               SELECT 1 FROM weekly_payment_ledger_adoption_allocation_proofs proof
                WHERE proof.funding_application_id = application.id
                  AND proof.organization_id = application.organization_id
                  AND proof.league_id = application.league_id
                  AND proof.allocation_id = allocation.id
                  AND proof.payment_id = application.payment_id
                  AND proof.credited_bowler_id = application.credited_bowler_id
                  AND proof.obligation_id = application.obligation_id
                  AND proof.amount_minor = application.amount_minor
                  AND proof.obligation_owner_kind = 'bowler'
                  AND proof.obligation_owner_bowler_id = coalesce(current_owner.owner_bowler_id, obligation.payer_bowler_id)
             )
           ))
           OR (application.target_kind = 'legacy_team_assignment' AND (
             application.target_payer_bowler_id IS NOT NULL OR application.assignment_id IS NULL
             OR coalesce(current_owner.owner_kind, '') <> 'team'
             OR current_owner.owner_team_id <> application.team_id
             OR (NOT EXISTS (
               SELECT 1 FROM rotating_occurrence_assignments assignment
                WHERE assignment.id = application.assignment_id
                  AND assignment.organization_id = application.organization_id
                  AND assignment.league_id = application.league_id
                  AND assignment.occurrence_id = application.occurrence_id
                  AND assignment.team_id = application.team_id
                  AND assignment.responsibility_id = application.responsibility_id
                  AND assignment.actual_bowler_id = application.credited_bowler_id
             ) AND NOT EXISTS (
               SELECT 1 FROM weekly_payment_ledger_adoption_allocation_proofs proof
                WHERE proof.funding_application_id = application.id
                  AND proof.organization_id = application.organization_id
                  AND proof.league_id = application.league_id
                  AND proof.allocation_id = allocation.id
                  AND proof.payment_id = application.payment_id
                  AND proof.credited_bowler_id = application.credited_bowler_id
                  AND proof.obligation_id = application.obligation_id
                  AND proof.amount_minor = application.amount_minor
                  AND proof.obligation_owner_kind = 'team'
                  AND proof.obligation_owner_team_id = current_owner.owner_team_id
             ))
           ))
           OR (NOT EXISTS (
             SELECT 1 FROM weekly_payment_week_confirmations confirmation
              WHERE confirmation.organization_id = application.organization_id
                AND confirmation.league_id = application.league_id
                AND confirmation.occurrence_id = application.occurrence_id
           ) AND NOT EXISTS (
             SELECT 1 FROM weekly_payment_ledger_adoptions adoption
               JOIN league_occurrences occurrence
                 ON occurrence.id = application.occurrence_id
                AND occurrence.organization_id = adoption.organization_id
                AND occurrence.league_id = adoption.league_id
              WHERE adoption.organization_id = application.organization_id
                AND adoption.league_id = application.league_id
                AND occurrence.authoritative_local_date <= adoption.adopted_through_local_date
           ))
         ))
         OR (allocation.state = 'voided' AND NOT (
           (application.id IS NOT NULL AND EXISTS (
             SELECT 1 FROM weekly_payment_allocation_releases release
              WHERE release.funding_application_id = application.id
                AND release.organization_id = application.organization_id
                AND release.league_id = application.league_id
                AND release.payment_id = p_payment_id
                AND release.credited_bowler_id = application.credited_bowler_id
                AND release.source_allocation_id = allocation.id
                AND release.source_obligation_id = allocation.obligation_id
                AND release.source_application_amount_minor = application.amount_minor
                AND release.released_amount_minor = application.amount_minor
                AND release.retained_amount_minor = 0
                AND release.replacement_allocation_id IS NULL
           )) OR EXISTS (
             SELECT 1 FROM payment_allocation_corrections correction
              WHERE correction.organization_id = allocation.organization_id
                AND correction.league_id = allocation.league_id
                AND correction.payment_id = allocation.payment_id
                AND correction.source_allocation_id = allocation.id
                AND correction.source_obligation_id = allocation.obligation_id
                AND correction.amount_minor = allocation.amount_minor
                AND correction.currency = allocation.currency
           )
         ))
         OR allocation.state NOT IN ('active', 'voided')
       )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_funding_ledger_guard',
      MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: funding_application_identity';
  END IF;

  IF EXISTS (
    SELECT 1 FROM weekly_payment_fundings funding
     WHERE funding.organization_id = p_organization_id
       AND funding.league_id = p_league_id
       AND funding.payment_id = p_payment_id
       AND (SELECT coalesce(sum(application.amount_minor), 0)
              FROM payment_allocation_funding_applications application
              JOIN payment_allocations allocation
                ON allocation.id = application.allocation_id
               AND allocation.organization_id = application.organization_id
               AND allocation.league_id = application.league_id
             WHERE application.generic_funding_id = funding.id
               AND application.organization_id = funding.organization_id
               AND application.league_id = funding.league_id
               AND allocation.state = 'active') > funding.amount_minor
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_funding_ledger_guard',
      MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: funding_overspend';
  END IF;

  FOR allocation_row IN
    SELECT DISTINCT allocation.obligation_id, allocation.organization_id, allocation.league_id
      FROM payment_allocations allocation
     WHERE allocation.organization_id = p_organization_id
       AND allocation.league_id = p_league_id
       AND allocation.payment_id = p_payment_id
  LOOP
    SELECT amount_minor INTO obligation_covered
      FROM payment_obligations
     WHERE id = allocation_row.obligation_id
       AND organization_id = p_organization_id
       AND league_id = p_league_id;
    SELECT coalesce(sum(allocation.amount_minor), 0) - coalesce((
      SELECT sum(adjustment.amount_minor)
        FROM refund_allocation_adjustments adjustment
        JOIN payment_allocations source
          ON source.id = adjustment.source_allocation_id
         AND source.organization_id = adjustment.organization_id
         AND source.league_id = adjustment.league_id
       WHERE adjustment.organization_id = p_organization_id
         AND adjustment.league_id = p_league_id
         AND source.obligation_id = allocation_row.obligation_id
         AND source.state = 'active'
         AND adjustment.disposition = 'still_owed'
    ), 0)
      INTO source_application_total
      FROM payment_allocations allocation
     WHERE allocation.organization_id = p_organization_id
       AND allocation.league_id = p_league_id
       AND allocation.obligation_id = allocation_row.obligation_id
       AND allocation.state = 'active';
    IF source_application_total > obligation_covered THEN
      RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_funding_ledger_guard',
        MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: obligation_overallocation';
    END IF;
  END LOOP;
END;
$$;--> statement-breakpoint

-- A completed, fully evidenced V3 refund permanently consumes the unused
-- portions of its tender. Permit a later exact allocation release so the
-- responsibility can be corrected without recreating refunded credit. The
-- tender assertion below proves the completed refund and the release lineage;
-- unresolved or ambiguous refunds remain a source hold.
CREATE OR REPLACE FUNCTION owned_payment_funding_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  payment_id_value integer;
  organization_id_value integer;
  league_id_value integer;
  payment_operation_id_value uuid;
BEGIN
  IF TG_TABLE_NAME = 'payments' THEN
    payment_id_value := NEW.id;
  ELSE
    payment_id_value := NEW.payment_id;
  END IF;
  organization_id_value := NEW.organization_id;
  league_id_value := NEW.league_id;
  IF TG_TABLE_NAME IN ('payment_allocation_funding_applications', 'weekly_payment_allocation_releases') THEN
    SELECT payment_operation_id INTO payment_operation_id_value
      FROM payments
     WHERE id = payment_id_value
       AND organization_id = organization_id_value
       AND league_id = league_id_value;
    IF EXISTS (
      SELECT 1 FROM payments payment
       WHERE payment.id = payment_id_value
         AND payment.organization_id = organization_id_value
         AND payment.league_id = league_id_value
         AND (payment.dispute_id IS NOT NULL OR payment.disputed_at IS NOT NULL)
    ) OR EXISTS (
      SELECT 1 FROM payment_disputes dispute
       WHERE dispute.organization_id = organization_id_value
         AND dispute.payment_operation_id = payment_operation_id_value
         AND dispute.state NOT IN ('WON', 'INQUIRY_CLOSED')
    ) OR EXISTS (
      SELECT 1 FROM refund_payment_operation_snapshots snapshot
        JOIN payment_operations operation
          ON operation.id = snapshot.operation_id
         AND operation.organization_id = organization_id_value
         AND operation.league_id = snapshot.league_id
       WHERE snapshot.league_id = league_id_value
         AND snapshot.payment_id = payment_id_value
         AND (
           (
           (operation.status = 'failed_terminal' AND (
             operation.provider_object_id IS NULL
             OR (operation.error_classification = 'invalid_request'
               AND operation.error_code IN ('REFUND_REJECTED', 'REFUND_FAILED'))
           ))
           OR (operation.status = 'action_required'
             AND operation.provider_object_id IS NULL
             AND operation.error_classification = 'hard_decline'
             AND operation.error_code = 'REFUND_DECLINED')
           OR (operation.status = 'canceled' AND operation.provider_object_id IS NULL)
           OR (operation.status = 'succeeded'
             AND snapshot.snapshot_version = 3
             AND operation.operation_type = 'refund'
             AND operation.target_key = 'payment-refund:' || payment_id_value::text
             AND operation.amount_minor > 0
             AND operation.currency = 'USD'
             AND operation.provider_name = 'square'
             AND operation.provider_object_id IS NOT NULL
             AND operation.completed_at IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM payments payment
                WHERE payment.id = payment_id_value
                  AND payment.organization_id = organization_id_value
                  AND payment.league_id = league_id_value
                  AND payment.status = 'refunded'
                  AND payment.square_refund_id = operation.provider_object_id
               )
           )
           ) IS NOT TRUE
         )
    ) OR EXISTS (
      SELECT 1
        FROM payment_allocation_funding_applications application
        JOIN rotating_credit_refunds refund
          ON refund.funding_id = application.rotating_funding_id
         AND refund.organization_id = application.organization_id
         AND refund.league_id = application.league_id
        LEFT JOIN payment_operations operation
          ON operation.id = refund.refund_operation_id
         AND operation.organization_id = refund.organization_id
         AND operation.league_id = refund.league_id
       WHERE application.organization_id = organization_id_value
         AND application.league_id = league_id_value
         AND application.payment_id = payment_id_value
         AND application.rotating_funding_id IS NOT NULL
         AND refund.refund_operation_id IS NOT NULL
         AND (operation.id IS NULL
           OR operation.status IN ('pending', 'leased', 'provider_unknown', 'retry_scheduled', 'reconciliation_required')
           OR (operation.status = 'action_required' AND NOT (
             operation.provider_object_id IS NULL
             AND operation.error_classification = 'hard_decline'
             AND operation.error_code = 'REFUND_DECLINED'
           )))
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'PWL01',
        CONSTRAINT = 'owned_payment_funding_release_guard',
        MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: funding_source_held';
    END IF;
  END IF;
  PERFORM assert_owned_payment_source_applications(organization_id_value, league_id_value, payment_id_value);
  IF EXISTS (
    SELECT 1 FROM weekly_payment_fundings funding
     WHERE funding.organization_id = organization_id_value
       AND funding.league_id = league_id_value
       AND funding.payment_id = payment_id_value
       AND funding.authorization_kind = 'provider_snapshot'
  ) OR EXISTS (
    SELECT 1 FROM refund_payment_operation_snapshots snapshot
      JOIN payment_operations operation
        ON operation.id = snapshot.operation_id
       AND operation.organization_id = organization_id_value
       AND operation.league_id = snapshot.league_id
     WHERE snapshot.league_id = league_id_value
       AND snapshot.payment_id = payment_id_value
       AND snapshot.snapshot_version = 3
       AND operation.operation_type = 'refund'
       AND operation.target_key = 'payment-refund:' || payment_id_value::text
  ) THEN
    PERFORM assert_owned_payment_tender_ledger(organization_id_value, league_id_value, payment_id_value);
  END IF;
  RETURN NEW;
END;
$$;

-- Route refunded tenders through the V3 proof. V1/V2 charge validation remains
-- byte-for-byte intact for paid tenders and legacy refund behavior.
CREATE OR REPLACE FUNCTION assert_owned_payment_tender_ledger(
  p_organization_id integer,
  p_league_id integer,
  p_payment_id integer
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  snapshot_kind_value text;
  snapshot_version_value integer;
  payment_status_value text;
BEGIN
  SELECT status INTO payment_status_value
    FROM payments
   WHERE id = p_payment_id
     AND organization_id = p_organization_id
     AND league_id = p_league_id;
  IF EXISTS (
    SELECT 1 FROM refund_payment_operation_snapshots snapshot
      JOIN payment_operations operation
        ON operation.id = snapshot.operation_id
       AND operation.organization_id = p_organization_id
       AND operation.league_id = p_league_id
     WHERE snapshot.payment_id = p_payment_id
       AND snapshot.league_id = p_league_id
       AND snapshot.snapshot_version = 3
       AND (payment_status_value = 'refunded' OR operation.status = 'succeeded')
  ) THEN
    PERFORM assert_owned_completed_refund_v3(p_organization_id, p_league_id, p_payment_id);
    RETURN;
  END IF;

  SELECT snapshot_kind, snapshot_version
    INTO snapshot_kind_value, snapshot_version_value
    FROM account_payment_operation_snapshots snapshot
    JOIN payments payment
      ON payment.payment_operation_id = snapshot.operation_id
     AND payment.organization_id = snapshot.organization_id
     AND payment.league_id = snapshot.league_id
   WHERE payment.id = p_payment_id
     AND payment.organization_id = p_organization_id
     AND payment.league_id = p_league_id;
  IF snapshot_kind_value = 'standing_funding' AND snapshot_version_value = 5 THEN
    PERFORM assert_owned_standing_payment_tender_ledger(p_organization_id, p_league_id, p_payment_id);
  ELSIF snapshot_kind_value = 'interactive_funding' AND snapshot_version_value = 4 THEN
    PERFORM assert_owned_payment_tender_ledger_v4(p_organization_id, p_league_id, p_payment_id);
  ELSIF snapshot_kind_value IS NULL THEN
    -- Adopted V2/V3/standing tender evidence remains authoritative when a V3
    -- refund is pending or conclusively had no effect. It has no V4 snapshot.
    PERFORM assert_owned_payment_source_applications(p_organization_id, p_league_id, p_payment_id);
  ELSE
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
      MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: tender_snapshot_missing';
  END IF;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION owned_payment_tender_ledger_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  payment_id_value integer;
  organization_id_value integer;
  league_id_value integer;
  has_account_snapshot boolean;
  has_v3_refund boolean;
BEGIN
  IF TG_TABLE_NAME = 'payments' THEN
    payment_id_value := NEW.id;
  ELSE
    payment_id_value := NEW.payment_id;
  END IF;
  organization_id_value := NEW.organization_id;
  league_id_value := NEW.league_id;
  SELECT EXISTS (
    SELECT 1 FROM payments payment
      JOIN account_payment_operation_snapshots snapshot
        ON snapshot.operation_id = payment.payment_operation_id
       AND snapshot.organization_id = payment.organization_id
       AND snapshot.league_id = payment.league_id
     WHERE payment.id = payment_id_value
       AND payment.organization_id = organization_id_value
       AND payment.league_id = league_id_value
  ) INTO has_account_snapshot;
  SELECT EXISTS (
    SELECT 1 FROM refund_payment_operation_snapshots refund_snapshot
      JOIN payment_operations operation
        ON operation.id = refund_snapshot.operation_id
       AND operation.organization_id = organization_id_value
       AND operation.league_id = refund_snapshot.league_id
     WHERE refund_snapshot.payment_id = payment_id_value
       AND refund_snapshot.league_id = league_id_value
       AND refund_snapshot.snapshot_version = 3
       AND (operation.status = 'succeeded' OR EXISTS (
         SELECT 1 FROM payments payment
          WHERE payment.id = payment_id_value
            AND payment.organization_id = organization_id_value
            AND payment.league_id = league_id_value
            AND payment.status = 'refunded'
       ))
  ) INTO has_v3_refund;
  IF has_v3_refund THEN
    PERFORM assert_owned_payment_tender_ledger(organization_id_value, league_id_value, payment_id_value);
  ELSIF has_account_snapshot THEN
    PERFORM assert_owned_payment_tender_ledger(organization_id_value, league_id_value, payment_id_value);
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- V3 adjustments retain the V2 member proof and additionally invoke the
-- whole-tender account proof, including pure-credit refunds with no rows here.
CREATE OR REPLACE FUNCTION refund_allocation_adjustment_provenance_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  operation_row record;
  allocation_row record;
  payment_row record;
  snapshot_row record;
BEGIN
  SELECT operation_type, status, provider_object_id
    INTO operation_row
    FROM payment_operations
   WHERE id = NEW.refund_operation_id
     AND organization_id = NEW.organization_id
     AND league_id = NEW.league_id;
  IF NOT FOUND OR operation_row.operation_type <> 'refund'
     OR operation_row.status <> 'succeeded'
     OR operation_row.provider_object_id IS NULL
  THEN
    RAISE EXCEPTION 'refund adjustment requires a succeeded provider-confirmed refund operation';
  END IF;

  SELECT id, payment_id, obligation_id, amount_minor, currency
    INTO allocation_row
    FROM payment_allocations
   WHERE id = NEW.source_allocation_id
     AND organization_id = NEW.organization_id
     AND league_id = NEW.league_id;
  IF NOT FOUND OR allocation_row.amount_minor <> NEW.amount_minor THEN
    RAISE EXCEPTION 'refund adjustment does not match its source allocation amount';
  END IF;
  SELECT status, square_refund_id
    INTO payment_row
    FROM payments
   WHERE id = allocation_row.payment_id
     AND organization_id = NEW.organization_id
     AND league_id = NEW.league_id;
  IF NOT FOUND OR payment_row.status <> 'refunded'
     OR payment_row.square_refund_id IS NULL
     OR payment_row.square_refund_id <> operation_row.provider_object_id
  THEN
    RAISE EXCEPTION 'refund adjustment requires the refunded source payment and provider identity';
  END IF;
  SELECT snapshot_version, payment_id, league_id, disposition,
         snapshot_fingerprint, allocation_snapshot
    INTO snapshot_row
    FROM refund_payment_operation_snapshots
   WHERE operation_id = NEW.refund_operation_id;
  IF NOT FOUND OR snapshot_row.payment_id <> allocation_row.payment_id
     OR snapshot_row.league_id <> NEW.league_id
     OR snapshot_row.disposition <> NEW.disposition
     OR snapshot_row.snapshot_fingerprint <> NEW.snapshot_fingerprint
     OR NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(snapshot_row.allocation_snapshot) member
        WHERE member->>'allocationId' = NEW.source_allocation_id::text
          AND member->>'obligationId' = allocation_row.obligation_id::text
          AND member->>'amountMinor' = allocation_row.amount_minor::text
          AND member->>'currency' = allocation_row.currency
     )
  THEN
    IF snapshot_row.snapshot_version = 2 THEN
      RAISE EXCEPTION 'refund adjustment does not match its immutable v2 refund snapshot';
    END IF;
    RAISE EXCEPTION 'refund adjustment does not match its immutable refund snapshot';
  END IF;
  IF snapshot_row.snapshot_version = 3 THEN
    PERFORM assert_owned_completed_refund_v3(NEW.organization_id, NEW.league_id, allocation_row.payment_id);
  ELSIF snapshot_row.snapshot_version <> 2 THEN
    RAISE EXCEPTION 'refund adjustment references an unsupported refund snapshot version';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- A V3 refund is a full-tender removal of every owned funding portion. The
-- source amounts remain historical; this assertion proves the immutable
-- refund snapshot, exact receipt adjustments, and every post-refund release.
CREATE OR REPLACE FUNCTION assert_owned_completed_refund_v3(
  p_organization_id integer,
  p_league_id integer,
  p_payment_id integer
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  payment_row record;
  charge_operation record;
  charge_snapshot record;
  refund_operation record;
  refund_snapshot record;
  funding_json record;
  funding_count integer;
  funding_json_count integer;
  funding_total bigint;
  funding_json_total bigint;
  allocation_json_count integer;
  allocation_total bigint;
  unused_total bigint;
  spent_for_funding bigint;
  adjustment_count integer;
  charge_snapshot_found boolean;
  portion_count integer;
  portion_total bigint;
  legacy_funding_count integer;
BEGIN
  SELECT id, organization_id, league_id, bowler_id, amount, currency, type,
         status, provider_payment_id, payment_operation_id, square_refund_id,
         dispute_id, disputed_at
    INTO payment_row
    FROM payments
   WHERE id = p_payment_id
     AND organization_id = p_organization_id
     AND league_id = p_league_id
   FOR SHARE;
  IF NOT FOUND OR payment_row.status <> 'refunded'
     OR payment_row.type IN ('cash', 'check')
     OR payment_row.amount <= 0 OR payment_row.currency <> 'USD'
     OR payment_row.provider_payment_id IS NULL
     OR payment_row.payment_operation_id IS NULL
     OR payment_row.square_refund_id IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
      MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: refund_payment_identity';
  END IF;

  SELECT * INTO refund_snapshot
    FROM refund_payment_operation_snapshots
   WHERE payment_id = p_payment_id
     AND league_id = p_league_id
   FOR SHARE;
  IF NOT FOUND OR refund_snapshot.snapshot_version <> 3
     OR refund_snapshot.snapshot_fingerprint !~ '^lvpayexecrf:v3:[0-9a-f]{64}$'
     OR refund_snapshot.disposition NOT IN ('still_owed', 'waived')
     OR jsonb_typeof(refund_snapshot.funding_snapshot) <> 'array'
     OR jsonb_array_length(refund_snapshot.funding_snapshot) = 0
     OR jsonb_typeof(refund_snapshot.allocation_snapshot) <> 'array'
  THEN
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
      MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: refund_snapshot_shape';
  END IF;

  SELECT * INTO refund_operation
    FROM payment_operations
   WHERE id = refund_snapshot.operation_id
     AND organization_id = p_organization_id
     AND league_id = p_league_id
   FOR SHARE;
  IF NOT FOUND OR refund_operation.operation_type <> 'refund'
     OR refund_operation.target_key <> 'payment-refund:' || p_payment_id::text
     OR refund_operation.status <> 'succeeded'
     OR refund_operation.amount_minor <> payment_row.amount
     OR refund_operation.currency <> payment_row.currency
     OR refund_operation.provider_name <> 'square'
     OR refund_operation.provider_object_id IS NULL
     OR refund_operation.provider_object_id <> payment_row.square_refund_id
     OR refund_operation.completed_at IS NULL
     OR refund_snapshot.operation_id <> refund_operation.id
     OR refund_snapshot.payment_id <> p_payment_id
     OR refund_snapshot.league_id <> p_league_id
  THEN
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
      MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: refund_operation_identity';
  END IF;

  SELECT * INTO charge_operation
    FROM payment_operations
   WHERE id = payment_row.payment_operation_id
     AND organization_id = p_organization_id
     AND league_id = p_league_id
   FOR SHARE;
  IF NOT FOUND OR charge_operation.status <> 'succeeded'
     OR charge_operation.amount_minor <> payment_row.amount
     OR charge_operation.currency <> payment_row.currency
     OR charge_operation.provider_name <> 'square'
     OR charge_operation.provider_object_id IS DISTINCT FROM payment_row.provider_payment_id
  THEN
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
      MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: refund_charge_source';
  END IF;

  SELECT * INTO charge_snapshot
    FROM account_payment_operation_snapshots
   WHERE operation_id = payment_row.payment_operation_id
     AND organization_id = p_organization_id
     AND league_id = p_league_id
   FOR SHARE;
  charge_snapshot_found := FOUND;
  IF charge_snapshot_found THEN
    IF charge_snapshot.amount_minor <> payment_row.amount
       OR charge_snapshot.currency <> payment_row.currency
       OR charge_snapshot.payer_bowler_id <> payment_row.bowler_id
       OR jsonb_typeof(charge_snapshot.funding_portions) <> 'array'
       OR jsonb_array_length(charge_snapshot.funding_portions) = 0
       OR jsonb_typeof(charge_snapshot.recipient_evidence) <> 'array'
       OR NOT (
         (charge_snapshot.snapshot_kind = 'interactive_funding'
           AND charge_snapshot.snapshot_version = 4
           AND charge_snapshot.request_kind = 'direct'
           AND charge_snapshot.snapshot_fingerprint ~ '^lvaccountfunding:v4:[0-9a-f]{64}$'
           AND charge_operation.operation_type = 'interactive_charge')
         OR (charge_snapshot.snapshot_kind = 'standing_funding'
           AND charge_snapshot.snapshot_version = 5
           AND charge_snapshot.request_kind = 'standing'
           AND charge_snapshot.snapshot_fingerprint ~ '^lvstandingfunding:v1:[0-9a-f]{64}$'
           AND charge_operation.operation_type = 'standing_autopay_charge')
       )
    THEN
      RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
        MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: refund_charge_snapshot';
    END IF;

    SELECT count(*), coalesce(sum(funding.amount_minor), 0)
      INTO legacy_funding_count, funding_total
      FROM weekly_payment_fundings funding
     WHERE funding.organization_id = p_organization_id
       AND funding.league_id = p_league_id
       AND funding.payment_id = p_payment_id;
    SELECT count(*), coalesce(sum((portion.value->>'amountMinor')::bigint), 0)
      INTO portion_count, portion_total
      FROM jsonb_array_elements(charge_snapshot.funding_portions) portion(value);
    IF funding_count <> portion_count OR funding_total <> payment_row.amount
       OR portion_total <> payment_row.amount
       OR EXISTS (
         SELECT 1
           FROM jsonb_array_elements(charge_snapshot.funding_portions) WITH ORDINALITY portion(value, ordinal)
          WHERE jsonb_typeof(portion.value) <> 'object'
             OR coalesce(portion.value->>'portionIndex', '') !~ '^(0|[1-9][0-9]*)$'
             OR coalesce(portion.value->>'creditedBowlerId', '') !~ '^[1-9][0-9]*$'
             OR coalesce(portion.value->>'amountMinor', '') !~ '^[1-9][0-9]*$'
             OR (portion.value->>'portionIndex')::numeric <> portion.ordinal - 1
             OR (portion.value->>'amountMinor')::numeric > 2147483647
             OR NOT EXISTS (
               SELECT 1 FROM weekly_payment_fundings funding
                WHERE funding.organization_id = p_organization_id
                  AND funding.league_id = p_league_id
                  AND funding.payment_id = p_payment_id
                  AND funding.source = 'provider'
                  AND funding.authorization_kind = 'provider_snapshot'
                  AND funding.authorization_operation_id = charge_operation.id
                  AND funding.authorization_item_count = 0
                  AND funding.authorization_fingerprint = charge_snapshot.snapshot_fingerprint
                  AND funding.adoption_id IS NULL
                  AND funding.portion_index = (portion.value->>'portionIndex')::integer
                  AND funding.credited_bowler_id = (portion.value->>'creditedBowlerId')::integer
                  AND funding.amount_minor = (portion.value->>'amountMinor')::integer
                  AND funding.currency = payment_row.currency
                  AND EXISTS (
                    SELECT 1 FROM jsonb_array_elements(charge_snapshot.recipient_evidence) evidence(value)
                     WHERE evidence.value->>'recipientBowlerId' = portion.value->>'creditedBowlerId'
                       AND evidence.value->>'role' IN ('self', 'partner')
                  )
             )
       ) OR EXISTS (
         SELECT 1 FROM weekly_payment_fundings funding
          WHERE funding.organization_id = p_organization_id
            AND funding.league_id = p_league_id
            AND funding.payment_id = p_payment_id
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(charge_snapshot.funding_portions) portion(value)
               WHERE portion.value->>'portionIndex' = funding.portion_index::text
                 AND portion.value->>'creditedBowlerId' = funding.credited_bowler_id::text
                 AND portion.value->>'amountMinor' = funding.amount_minor::text
            )
       )
    THEN
      RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
        MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: refund_charge_portions';
    END IF;
  ELSE
    -- Adopted V2/V3 interactive and standing-autopay tenders predate the
    -- account snapshot table. Their immutable roster-snapshot authorization
    -- remains the source of recipient identity; do not fabricate a V4 row.
    SELECT count(*), coalesce(sum(funding.amount_minor), 0)
      INTO funding_count, funding_total
      FROM weekly_payment_fundings funding
     WHERE funding.organization_id = p_organization_id
       AND funding.league_id = p_league_id
       AND funding.payment_id = p_payment_id
       AND funding.source = 'legacy_adoption'
       AND funding.authorization_kind = 'legacy_provider_snapshot'
       AND funding.authorization_operation_id = charge_operation.id
       AND funding.authorization_item_count > 0
       AND funding.adoption_id IS NOT NULL;
    IF legacy_funding_count = 0 OR funding_total <> payment_row.amount
       OR charge_operation.operation_type NOT IN ('interactive_charge', 'standing_autopay_charge')
       OR EXISTS (
         SELECT 1 FROM weekly_payment_fundings funding
          WHERE funding.organization_id = p_organization_id
            AND funding.league_id = p_league_id
            AND funding.payment_id = p_payment_id
            AND (funding.source <> 'legacy_adoption'
              OR funding.authorization_kind <> 'legacy_provider_snapshot'
              OR funding.authorization_operation_id IS DISTINCT FROM charge_operation.id
              OR funding.authorization_item_count <= 0
              OR funding.adoption_id IS NULL)
       )
    THEN
      RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
        MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: refund_legacy_charge_source';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(refund_snapshot.funding_snapshot) item(value)
     WHERE jsonb_typeof(item.value) <> 'object'
        OR coalesce(item.value->>'fundingId', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        OR coalesce(item.value->>'paymentId', '') !~ '^[1-9][0-9]*$'
        OR coalesce(item.value->>'creditedBowlerId', '') !~ '^[1-9][0-9]*$'
        OR coalesce(item.value->>'fundingAmountMinor', '') !~ '^[1-9][0-9]*$'
        OR coalesce(item.value->>'unusedCreditMinor', '') !~ '^(0|[1-9][0-9]*)$'
        OR item.value->>'currency' IS DISTINCT FROM 'USD'
        OR (item.value->>'paymentId')::numeric <> p_payment_id
        OR (item.value->>'fundingAmountMinor')::numeric > 2147483647
        OR (item.value->>'unusedCreditMinor')::numeric > 2147483647
        OR (item.value->>'unusedCreditMinor')::numeric > (item.value->>'fundingAmountMinor')::numeric
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(refund_snapshot.funding_snapshot) item(value)
     GROUP BY item.value->>'fundingId' HAVING count(*) <> 1
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(refund_snapshot.funding_snapshot) item(value)
     GROUP BY item.value->>'creditedBowlerId' HAVING count(*) <> 1
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(refund_snapshot.allocation_snapshot) item(value)
     WHERE jsonb_typeof(item.value) <> 'object'
        OR coalesce(item.value->>'allocationId', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        OR coalesce(item.value->>'obligationId', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        OR coalesce(item.value->>'amountMinor', '') !~ '^[1-9][0-9]*$'
        OR item.value->>'currency' IS DISTINCT FROM 'USD'
        OR (item.value->>'amountMinor')::numeric > 2147483647
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(refund_snapshot.allocation_snapshot) item(value)
     GROUP BY item.value->>'allocationId' HAVING count(*) <> 1
  )
  THEN
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
      MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: refund_snapshot_member_shape';
  END IF;

  SELECT count(*), coalesce(sum(funding.amount_minor), 0)
    INTO funding_count, funding_total
    FROM weekly_payment_fundings funding
   WHERE funding.organization_id = p_organization_id
     AND funding.league_id = p_league_id
     AND funding.payment_id = p_payment_id;
  SELECT count(*), coalesce(sum((item.value->>'fundingAmountMinor')::bigint), 0),
         coalesce(sum((item.value->>'unusedCreditMinor')::bigint), 0)
    INTO funding_json_count, funding_json_total, unused_total
    FROM jsonb_array_elements(refund_snapshot.funding_snapshot) item(value);
  IF funding_count <> funding_json_count
     OR funding_total <> payment_row.amount
     OR funding_json_total <> payment_row.amount
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(refund_snapshot.funding_snapshot) item(value)
        WHERE NOT EXISTS (
          SELECT 1 FROM weekly_payment_fundings funding
           WHERE funding.id = (item.value->>'fundingId')::uuid
             AND funding.organization_id = p_organization_id
             AND funding.league_id = p_league_id
             AND funding.payment_id = p_payment_id
             AND funding.credited_bowler_id = (item.value->>'creditedBowlerId')::integer
             AND funding.amount_minor = (item.value->>'fundingAmountMinor')::integer
             AND funding.currency = item.value->>'currency'
        )
     ) OR EXISTS (
       SELECT 1 FROM weekly_payment_fundings funding
        WHERE funding.organization_id = p_organization_id
          AND funding.league_id = p_league_id
          AND funding.payment_id = p_payment_id
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(refund_snapshot.funding_snapshot) item(value)
             WHERE item.value->>'fundingId' = funding.id::text
          )
     )
  THEN
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
      MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: refund_funding_portions';
  END IF;

  SELECT count(*), coalesce(sum((item.value->>'amountMinor')::bigint), 0)
    INTO allocation_json_count, allocation_total
    FROM jsonb_array_elements(refund_snapshot.allocation_snapshot) item(value);
  IF allocation_total + unused_total <> payment_row.amount
     OR EXISTS (
       SELECT 1 FROM payment_allocations allocation
        WHERE allocation.organization_id = p_organization_id
          AND allocation.league_id = p_league_id
          AND allocation.payment_id = p_payment_id
          AND allocation.state = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(refund_snapshot.allocation_snapshot) item(value)
             WHERE item.value->>'allocationId' = allocation.id::text
          )
     ) OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(refund_snapshot.allocation_snapshot) item(value)
        LEFT JOIN payment_allocations allocation
          ON allocation.id = (item.value->>'allocationId')::uuid
         AND allocation.organization_id = p_organization_id
         AND allocation.league_id = p_league_id
         AND allocation.payment_id = p_payment_id
         AND allocation.obligation_id = (item.value->>'obligationId')::uuid
         AND allocation.amount_minor = (item.value->>'amountMinor')::integer
         AND allocation.currency = item.value->>'currency'
        WHERE allocation.id IS NULL
           OR allocation.state NOT IN ('active', 'voided')
           OR (allocation.state = 'active' AND EXISTS (
             SELECT 1 FROM weekly_payment_allocation_releases release
              WHERE release.organization_id = p_organization_id
                AND release.league_id = p_league_id
                AND release.source_allocation_id = allocation.id
           ))
           OR (allocation.state = 'voided' AND (
             SELECT count(*) FROM weekly_payment_allocation_releases release
             JOIN payment_allocation_funding_applications application
               ON application.id = release.funding_application_id
              AND application.organization_id = release.organization_id
              AND application.league_id = release.league_id
             WHERE release.organization_id = p_organization_id
               AND release.league_id = p_league_id
               AND release.source_allocation_id = allocation.id
               AND release.payment_id = p_payment_id
               AND release.source_obligation_id = allocation.obligation_id
               AND release.source_application_amount_minor = allocation.amount_minor
               AND release.released_amount_minor = allocation.amount_minor
               AND release.retained_amount_minor = 0
               AND release.replacement_allocation_id IS NULL
               AND release.created_at >= refund_operation.completed_at
               AND application.payment_id = p_payment_id
               AND application.allocation_id = allocation.id
               AND application.generic_funding_id IS NOT NULL
               AND application.rotating_funding_id IS NULL
               AND application.obligation_id = allocation.obligation_id
               AND application.amount_minor = allocation.amount_minor
               AND application.currency = allocation.currency
           ) <> 1)
     )
  THEN
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
      MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: refund_allocation_portions';
  END IF;

  FOR funding_json IN
    SELECT item.value FROM jsonb_array_elements(refund_snapshot.funding_snapshot) item(value)
  LOOP
    SELECT coalesce(sum(application.amount_minor), 0)
      INTO spent_for_funding
      FROM jsonb_array_elements(refund_snapshot.allocation_snapshot) item(value)
      JOIN payment_allocation_funding_applications application
        ON application.allocation_id = (item.value->>'allocationId')::uuid
       AND application.organization_id = p_organization_id
       AND application.league_id = p_league_id
     WHERE application.payment_id = p_payment_id
       AND application.generic_funding_id = (funding_json.value->>'fundingId')::uuid
       AND application.credited_bowler_id = (funding_json.value->>'creditedBowlerId')::integer
       AND application.amount_minor = (item.value->>'amountMinor')::integer
       AND application.obligation_id = (item.value->>'obligationId')::uuid;
    IF (funding_json.value->>'unusedCreditMinor')::bigint + spent_for_funding
       <> (funding_json.value->>'fundingAmountMinor')::bigint
    THEN
      RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
        MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: refund_funding_conservation';
    END IF;
  END LOOP;

  SELECT count(*) INTO adjustment_count
    FROM refund_allocation_adjustments adjustment
   WHERE adjustment.organization_id = p_organization_id
     AND adjustment.league_id = p_league_id
     AND adjustment.refund_operation_id = refund_operation.id;
  IF adjustment_count <> allocation_json_count
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(refund_snapshot.allocation_snapshot) item(value)
        WHERE NOT EXISTS (
          SELECT 1 FROM refund_allocation_adjustments adjustment
           WHERE adjustment.organization_id = p_organization_id
             AND adjustment.league_id = p_league_id
             AND adjustment.refund_operation_id = refund_operation.id
             AND adjustment.source_allocation_id = (item.value->>'allocationId')::uuid
             AND adjustment.amount_minor = (item.value->>'amountMinor')::integer
             AND adjustment.disposition = refund_snapshot.disposition
             AND adjustment.snapshot_fingerprint = refund_snapshot.snapshot_fingerprint
        )
     ) OR EXISTS (
       SELECT 1 FROM refund_allocation_adjustments adjustment
        WHERE adjustment.organization_id = p_organization_id
          AND adjustment.league_id = p_league_id
          AND adjustment.refund_operation_id = refund_operation.id
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(refund_snapshot.allocation_snapshot) item(value)
             WHERE item.value->>'allocationId' = adjustment.source_allocation_id::text
          )
     )
  THEN
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
      MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: refund_adjustments';
  END IF;

  BEGIN
    PERFORM assert_owned_payment_source_applications(p_organization_id, p_league_id, p_payment_id);
  EXCEPTION WHEN SQLSTATE 'PWL01' THEN
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
      MESSAGE = SQLERRM;
  END;
END;
$$;--> statement-breakpoint
