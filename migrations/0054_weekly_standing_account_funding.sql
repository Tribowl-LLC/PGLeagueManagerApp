ALTER TABLE "account_payment_operation_snapshots" DROP CONSTRAINT "account_payment_operation_snapshots_amount_check";--> statement-breakpoint
ALTER TABLE "account_payment_operation_snapshots" DROP CONSTRAINT "account_payment_operation_snapshots_source_check";--> statement-breakpoint
ALTER TABLE "account_payment_operation_snapshots" DROP CONSTRAINT "account_payment_operation_snapshots_quote_fingerprint_check";--> statement-breakpoint
ALTER TABLE "account_payment_operation_snapshots" DROP CONSTRAINT "account_payment_operation_snapshots_fingerprint_check";--> statement-breakpoint
ALTER TABLE "weekly_payment_fundings" DROP CONSTRAINT "weekly_payment_fundings_auth_fp_check";--> statement-breakpoint
ALTER TABLE "account_payment_operation_snapshots" ALTER COLUMN "source_kind" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "account_payment_operation_snapshots" ALTER COLUMN "encrypted_source_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "account_payment_operation_snapshots" ALTER COLUMN "quote_fingerprint" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "account_payment_operation_snapshots" ADD COLUMN "standing_evidence" jsonb;--> statement-breakpoint
ALTER TABLE "account_payment_operation_snapshots" ADD CONSTRAINT "account_payment_operation_snapshots_amount_check" CHECK ("account_payment_operation_snapshots"."amount_minor" > 0 AND "account_payment_operation_snapshots"."currency" = 'USD' AND jsonb_typeof("account_payment_operation_snapshots"."funding_portions") = 'array' AND jsonb_array_length("account_payment_operation_snapshots"."funding_portions") > 0 AND jsonb_typeof("account_payment_operation_snapshots"."recipient_evidence") = 'array' AND jsonb_array_length("account_payment_operation_snapshots"."recipient_evidence") > 0 AND (( "account_payment_operation_snapshots"."snapshot_version" = 4 AND "account_payment_operation_snapshots"."snapshot_kind" = 'interactive_funding' AND "account_payment_operation_snapshots"."request_kind" = 'direct' AND "account_payment_operation_snapshots"."standing_evidence" IS NULL ) OR ( "account_payment_operation_snapshots"."snapshot_version" = 5 AND "account_payment_operation_snapshots"."snapshot_kind" = 'standing_funding' AND "account_payment_operation_snapshots"."request_kind" = 'standing' AND "account_payment_operation_snapshots"."standing_evidence" IS NOT NULL AND jsonb_typeof("account_payment_operation_snapshots"."standing_evidence") = 'object' )));--> statement-breakpoint
ALTER TABLE "account_payment_operation_snapshots" ADD CONSTRAINT "account_payment_operation_snapshots_source_check" CHECK ((("account_payment_operation_snapshots"."snapshot_kind" = 'interactive_funding' AND "account_payment_operation_snapshots"."source_kind" IS NOT NULL AND "account_payment_operation_snapshots"."encrypted_source_id" IS NOT NULL AND length(btrim("account_payment_operation_snapshots"."encrypted_source_id")) > 0 AND ("account_payment_operation_snapshots"."source_kind" <> 'wallet' OR "account_payment_operation_snapshots"."store_card" = false)) OR ("account_payment_operation_snapshots"."snapshot_kind" = 'standing_funding' AND "account_payment_operation_snapshots"."source_kind" IS NULL AND "account_payment_operation_snapshots"."encrypted_source_id" IS NULL AND "account_payment_operation_snapshots"."encrypted_customer_id" IS NULL AND "account_payment_operation_snapshots"."encrypted_buyer_email" IS NULL AND "account_payment_operation_snapshots"."store_card" = false)));--> statement-breakpoint
ALTER TABLE "account_payment_operation_snapshots" ADD CONSTRAINT "account_payment_operation_snapshots_quote_fingerprint_check" CHECK (("account_payment_operation_snapshots"."snapshot_kind" = 'interactive_funding' AND "account_payment_operation_snapshots"."quote_fingerprint" IS NOT NULL AND "account_payment_operation_snapshots"."quote_fingerprint" ~ '^lvaccountfundquote:v4:[0-9a-f]{64}$') OR ("account_payment_operation_snapshots"."snapshot_kind" = 'standing_funding' AND "account_payment_operation_snapshots"."quote_fingerprint" IS NULL));--> statement-breakpoint
ALTER TABLE "account_payment_operation_snapshots" ADD CONSTRAINT "account_payment_operation_snapshots_fingerprint_check" CHECK (("account_payment_operation_snapshots"."snapshot_kind" = 'interactive_funding' AND "account_payment_operation_snapshots"."snapshot_fingerprint" ~ '^lvaccountfunding:v4:[0-9a-f]{64}$') OR ("account_payment_operation_snapshots"."snapshot_kind" = 'standing_funding' AND "account_payment_operation_snapshots"."snapshot_fingerprint" ~ '^lvstandingfunding:v1:[0-9a-f]{64}$'));--> statement-breakpoint
ALTER TABLE "weekly_payment_fundings" ADD CONSTRAINT "weekly_payment_fundings_auth_fp_check" CHECK ("weekly_payment_fundings"."authorization_fingerprint" ~ '^lv(?:accountfunding:v4|standingfunding:v1|partnerexec:v3|rosterexec:v1|standingcutoff:v1|weeklyreceipt:v1|weeklyadopt:v1):[0-9a-f]{64}$');
--> statement-breakpoint

-- V5 standing operations use the common owned funding portion proof. The
-- original V4 assertion remains byte-for-byte intact for interactive charges.
ALTER FUNCTION assert_owned_payment_tender_ledger(integer, integer, integer)
  RENAME TO assert_owned_payment_tender_ledger_v4;--> statement-breakpoint

CREATE OR REPLACE FUNCTION assert_owned_standing_payment_tender_ledger(
  p_organization_id integer,
  p_league_id integer,
  p_payment_id integer
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  payment_row record;
  operation_row record;
  snapshot_row record;
  consent_row record;
  binding_row record;
  item_row record;
  funding_row record;
  portion_count integer;
  evidence_count integer;
  evidence_partner_count integer;
  consent_partner_count integer;
  funding_count integer;
  auth_item_count integer;
  portion_total bigint;
  expected_index integer := 0;
  portion_index_value integer;
  portion_owner_value integer;
  portion_amount_value integer;
BEGIN
  SELECT id, organization_id, league_id, bowler_id, amount, currency, type,
         status, provider_payment_id, payment_operation_id
    INTO payment_row
    FROM payments
   WHERE id = p_payment_id
     AND organization_id = p_organization_id
     AND league_id = p_league_id
   FOR SHARE;
  IF NOT FOUND OR payment_row.status <> 'paid' OR payment_row.amount <= 0
     OR payment_row.currency <> 'USD' OR payment_row.type IN ('cash', 'check')
     OR payment_row.provider_payment_id IS NULL OR payment_row.payment_operation_id IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
      MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: standing_tender_identity';
  END IF;

  SELECT id, organization_id, league_id, authorizing_user_id, operation_type,
         trigger_occurrence_id, status, amount_minor, currency, provider_name,
         provider_object_id
    INTO operation_row
    FROM payment_operations
   WHERE id = payment_row.payment_operation_id
     AND organization_id = p_organization_id
     AND league_id = p_league_id
   FOR SHARE;
  IF NOT FOUND OR operation_row.operation_type <> 'standing_autopay_charge'
     OR operation_row.status <> 'succeeded'
     OR operation_row.amount_minor <> payment_row.amount
     OR operation_row.currency <> payment_row.currency
     OR operation_row.authorizing_user_id IS NULL
     OR operation_row.provider_name !~ '^[a-z0-9][a-z0-9_-]{0,31}$'
     OR operation_row.provider_object_id IS NULL
     OR operation_row.provider_object_id <> payment_row.provider_payment_id
  THEN
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
      MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: standing_tender_operation';
  END IF;

  SELECT * INTO snapshot_row
    FROM account_payment_operation_snapshots
   WHERE operation_id = operation_row.id
     AND organization_id = p_organization_id
     AND league_id = p_league_id
   FOR SHARE;
  IF NOT FOUND OR snapshot_row.snapshot_version <> 5
     OR snapshot_row.snapshot_kind <> 'standing_funding'
     OR snapshot_row.request_kind <> 'standing'
     OR snapshot_row.payer_bowler_id <> payment_row.bowler_id
     OR snapshot_row.authorizing_user_id <> operation_row.authorizing_user_id
     OR snapshot_row.amount_minor <> payment_row.amount
     OR snapshot_row.currency <> payment_row.currency
     OR snapshot_row.provider_name <> operation_row.provider_name
     OR snapshot_row.provider_location_id IS NULL
     OR length(btrim(snapshot_row.provider_location_id)) = 0
     OR snapshot_row.source_kind IS NOT NULL
     OR snapshot_row.encrypted_source_id IS NOT NULL
     OR snapshot_row.encrypted_customer_id IS NOT NULL
     OR snapshot_row.encrypted_buyer_email IS NOT NULL
     OR snapshot_row.store_card IS DISTINCT FROM false
     OR snapshot_row.quote_fingerprint IS NOT NULL
     OR snapshot_row.snapshot_fingerprint !~ '^lvstandingfunding:v1:[0-9a-f]{64}$'
     OR jsonb_typeof(snapshot_row.funding_portions) <> 'array'
     OR jsonb_typeof(snapshot_row.recipient_evidence) <> 'array'
     OR jsonb_typeof(snapshot_row.standing_evidence) <> 'object'
  THEN
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
      MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: standing_tender_snapshot';
  END IF;
  IF jsonb_array_length(snapshot_row.funding_portions) = 0
     OR jsonb_array_length(snapshot_row.recipient_evidence) = 0
  THEN
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
      MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: standing_tender_snapshot_shape';
  END IF;

  IF NOT (snapshot_row.standing_evidence ?& ARRAY[
    'consentId', 'consentVersion', 'consentFingerprint', 'bindingEvidenceFingerprint',
    'cutoffAt', 'collectionMode', 'triggerOccurrenceId', 'triggerOccurrenceRevision',
    'pairedOccurrenceId', 'collectionGroupId', 'collectionGroupRevision',
    'collectionGroupFingerprint', 'triggerMemberId', 'pairedMemberId',
    'collectionRequirementOccurrenceIds'
  ]) OR jsonb_typeof(snapshot_row.standing_evidence->'collectionRequirementOccurrenceIds') <> 'array'
  THEN
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
      MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: standing_tender_evidence_shape';
  END IF;
  IF jsonb_array_length(snapshot_row.standing_evidence->'collectionRequirementOccurrenceIds') = 0
     OR jsonb_array_length(snapshot_row.standing_evidence->'collectionRequirementOccurrenceIds') > 1000
  THEN
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
      MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: standing_collection_requirement_count';
  END IF;

  IF coalesce(snapshot_row.standing_evidence->>'consentId', '') !~ '^[0-9a-fA-F-]{36}$'
     OR coalesce(snapshot_row.standing_evidence->>'consentVersion', '') !~ '^[1-9][0-9]{0,9}$'
     OR (CASE WHEN coalesce(snapshot_row.standing_evidence->>'consentVersion', '') ~ '^[1-9][0-9]{0,9}$'
             THEN (snapshot_row.standing_evidence->>'consentVersion')::numeric > 2147483647
             ELSE true END)
     OR coalesce(snapshot_row.standing_evidence->>'consentFingerprint', '') !~ '^lvstandingconsent:v1:[0-9a-f]{64}$'
     OR coalesce(snapshot_row.standing_evidence->>'bindingEvidenceFingerprint', '') !~ '^lvstandingcutoff:v1:[0-9a-f]{64}$'
     OR coalesce(snapshot_row.standing_evidence->>'cutoffAt', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
     OR coalesce(snapshot_row.standing_evidence->>'collectionMode', '') NOT IN ('weekly', 'double_pay')
     OR coalesce(snapshot_row.standing_evidence->>'triggerOccurrenceId', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     OR coalesce(snapshot_row.standing_evidence->>'triggerOccurrenceRevision', '') !~ '^[1-9][0-9]{0,9}$'
     OR (CASE WHEN coalesce(snapshot_row.standing_evidence->>'triggerOccurrenceRevision', '') ~ '^[1-9][0-9]{0,9}$'
             THEN (snapshot_row.standing_evidence->>'triggerOccurrenceRevision')::numeric > 2147483647
             ELSE true END)
     OR NOT pg_input_is_valid(snapshot_row.standing_evidence->>'cutoffAt', 'timestamp with time zone')
     OR operation_row.trigger_occurrence_id::text IS DISTINCT FROM snapshot_row.standing_evidence->>'triggerOccurrenceId'
  THEN
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
      MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: standing_binding_evidence_shape';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(snapshot_row.standing_evidence->'collectionRequirementOccurrenceIds') requirement(value)
     WHERE jsonb_typeof(requirement.value) <> 'string'
        OR coalesce(requirement.value #>> '{}', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(snapshot_row.standing_evidence->'collectionRequirementOccurrenceIds') requirement(value)
     GROUP BY requirement.value HAVING count(*) <> 1
  ) OR NOT (snapshot_row.standing_evidence->'collectionRequirementOccurrenceIds'
       @> jsonb_build_array(snapshot_row.standing_evidence->'triggerOccurrenceId'))
  THEN
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
      MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: standing_collection_requirement_evidence';
  END IF;
  IF snapshot_row.standing_evidence->>'collectionMode' = 'double_pay' THEN
    IF coalesce(snapshot_row.standing_evidence->>'pairedOccurrenceId', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       OR coalesce(snapshot_row.standing_evidence->>'collectionGroupId', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       OR coalesce(snapshot_row.standing_evidence->>'collectionGroupRevision', '') !~ '^[1-9][0-9]{0,9}$'
       OR (CASE WHEN coalesce(snapshot_row.standing_evidence->>'collectionGroupRevision', '') ~ '^[1-9][0-9]{0,9}$'
               THEN (snapshot_row.standing_evidence->>'collectionGroupRevision')::numeric > 2147483647
               ELSE true END)
       OR coalesce(snapshot_row.standing_evidence->>'collectionGroupFingerprint', '') !~ '^lvcollectiongroup:v1:[0-9a-f]{64}$'
       OR coalesce(snapshot_row.standing_evidence->>'triggerMemberId', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       OR coalesce(snapshot_row.standing_evidence->>'pairedMemberId', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       OR NOT (snapshot_row.standing_evidence->'collectionRequirementOccurrenceIds'
           @> jsonb_build_array(snapshot_row.standing_evidence->'pairedOccurrenceId'))
    THEN
      RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
        MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: standing_double_pay_evidence';
    END IF;
  ELSIF snapshot_row.standing_evidence->'pairedOccurrenceId' <> 'null'::jsonb
     OR snapshot_row.standing_evidence->'collectionGroupId' <> 'null'::jsonb
     OR snapshot_row.standing_evidence->'collectionGroupRevision' <> 'null'::jsonb
     OR snapshot_row.standing_evidence->'collectionGroupFingerprint' <> 'null'::jsonb
     OR snapshot_row.standing_evidence->'triggerMemberId' <> 'null'::jsonb
     OR snapshot_row.standing_evidence->'pairedMemberId' <> 'null'::jsonb
  THEN
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
      MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: standing_weekly_evidence';
  END IF;

  SELECT * INTO binding_row
    FROM payment_operation_standing_autopay_bindings
   WHERE operation_id = operation_row.id
     AND organization_id = p_organization_id
     AND league_id = p_league_id
   FOR SHARE;
  IF NOT FOUND
     OR binding_row.consent_id::text IS DISTINCT FROM snapshot_row.standing_evidence->>'consentId'
     OR binding_row.consent_version <> (snapshot_row.standing_evidence->>'consentVersion')::integer
     OR binding_row.provider_name <> snapshot_row.provider_name
     OR binding_row.provider_location_id <> snapshot_row.provider_location_id
     OR binding_row.trigger_occurrence_id::text IS DISTINCT FROM snapshot_row.standing_evidence->>'triggerOccurrenceId'
     OR binding_row.paired_occurrence_id::text IS DISTINCT FROM snapshot_row.standing_evidence->>'pairedOccurrenceId'
     OR binding_row.collection_group_id::text IS DISTINCT FROM snapshot_row.standing_evidence->>'collectionGroupId'
     OR binding_row.collection_group_revision::text IS DISTINCT FROM snapshot_row.standing_evidence->>'collectionGroupRevision'
     OR binding_row.collection_group_fingerprint IS DISTINCT FROM snapshot_row.standing_evidence->>'collectionGroupFingerprint'
     OR binding_row.trigger_member_id::text IS DISTINCT FROM snapshot_row.standing_evidence->>'triggerMemberId'
     OR binding_row.paired_member_id::text IS DISTINCT FROM snapshot_row.standing_evidence->>'pairedMemberId'
     OR binding_row.collection_mode IS DISTINCT FROM snapshot_row.standing_evidence->>'collectionMode'
     OR binding_row.cutoff_at IS DISTINCT FROM (snapshot_row.standing_evidence->>'cutoffAt')::timestamptz
     OR binding_row.evidence_fingerprint IS DISTINCT FROM snapshot_row.standing_evidence->>'bindingEvidenceFingerprint'
  THEN
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
      MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: standing_operation_binding';
  END IF;

  SELECT * INTO consent_row
    FROM autopay_consents
   WHERE id = binding_row.consent_id
     AND organization_id = p_organization_id
     AND league_id = p_league_id
   FOR SHARE;
  IF NOT FOUND OR consent_row.consent_version <> binding_row.consent_version
     OR consent_row.payer_bowler_id <> snapshot_row.payer_bowler_id
     OR consent_row.consent_fingerprint IS DISTINCT FROM snapshot_row.standing_evidence->>'consentFingerprint'
     OR consent_row.provider_name IS DISTINCT FROM snapshot_row.provider_name
     OR consent_row.provider_location_id IS DISTINCT FROM snapshot_row.provider_location_id
     OR consent_row.encrypted_source_id IS NULL OR length(btrim(consent_row.encrypted_source_id)) = 0
     OR consent_row.encrypted_customer_id IS NULL OR length(btrim(consent_row.encrypted_customer_id)) = 0
  THEN
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
      MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: standing_versioned_consent';
  END IF;

  IF EXISTS (
       SELECT 1 FROM jsonb_array_elements(snapshot_row.recipient_evidence) evidence(value)
        WHERE jsonb_typeof(evidence.value) <> 'object'
           OR jsonb_typeof(evidence.value->'recipientBowlerId') <> 'number'
           OR coalesce(evidence.value->>'recipientBowlerId', '') !~ '^[1-9][0-9]{0,9}$'
           OR (CASE WHEN coalesce(evidence.value->>'recipientBowlerId', '') ~ '^[1-9][0-9]{0,9}$'
                   THEN (evidence.value->>'recipientBowlerId')::numeric > 2147483647
                   ELSE true END)
           OR coalesce(evidence.value->>'role', '') NOT IN ('self', 'partner')
           OR jsonb_typeof(evidence.value->'target') <> 'object'
           OR jsonb_typeof(evidence.value->'target'->'newChargeMinor') <> 'number'
           OR coalesce(evidence.value->'target'->>'newChargeMinor', '') !~ '^(0|[1-9][0-9]{0,9})$'
           OR (CASE WHEN coalesce(evidence.value->'target'->>'newChargeMinor', '') ~ '^(0|[1-9][0-9]{0,9})$'
                   THEN (evidence.value->'target'->>'newChargeMinor')::numeric > 2147483647
                   ELSE true END)
           OR (evidence.value->>'role' = 'self' AND (
             (CASE WHEN coalesce(evidence.value->>'recipientBowlerId', '') ~ '^[1-9][0-9]{0,9}$'
                  THEN (evidence.value->>'recipientBowlerId')::numeric <> snapshot_row.payer_bowler_id
                  ELSE true END)
             OR NOT (evidence.value ? 'paymentLinkId') OR evidence.value->'paymentLinkId' <> 'null'::jsonb
             OR NOT (evidence.value ? 'linkFingerprint') OR evidence.value->'linkFingerprint' <> 'null'::jsonb
           ))
           OR (evidence.value->>'role' = 'partner' AND (
             (CASE WHEN coalesce(evidence.value->>'recipientBowlerId', '') ~ '^[1-9][0-9]{0,9}$'
                  THEN (evidence.value->>'recipientBowlerId')::numeric = snapshot_row.payer_bowler_id
                  ELSE true END)
             OR coalesce(evidence.value->>'paymentLinkId', '') !~ '^[1-9][0-9]{0,9}$'
             OR coalesce(evidence.value->>'linkFingerprint', '') !~ '^lvpartnerlink:v1:[0-9a-f]{64}$'
           ))
     ) OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(snapshot_row.recipient_evidence) evidence(value)
        GROUP BY evidence.value->>'recipientBowlerId' HAVING count(*) <> 1
     )
  THEN
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
      MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: standing_recipient_evidence';
  END IF;

  SELECT count(*) INTO evidence_count
    FROM jsonb_array_elements(snapshot_row.recipient_evidence) evidence(value);
  SELECT count(*) INTO evidence_partner_count
    FROM jsonb_array_elements(snapshot_row.recipient_evidence) evidence(value)
   WHERE evidence.value->>'role' = 'partner';
  SELECT count(*) INTO consent_partner_count
    FROM autopay_consent_partners partner
   WHERE partner.organization_id = p_organization_id
     AND partner.league_id = p_league_id
     AND partner.consent_id = binding_row.consent_id
     AND partner.consent_version = binding_row.consent_version;
  IF evidence_count <> consent_partner_count + 1
     OR evidence_partner_count <> consent_partner_count
     OR (SELECT count(*) FROM jsonb_array_elements(snapshot_row.recipient_evidence) evidence(value)
          WHERE evidence.value->>'role' = 'self') <> 1
     OR EXISTS (
       SELECT 1 FROM autopay_consent_partners partner
        WHERE partner.organization_id = p_organization_id
          AND partner.league_id = p_league_id
          AND partner.consent_id = binding_row.consent_id
          AND partner.consent_version = binding_row.consent_version
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(snapshot_row.recipient_evidence) evidence(value)
             WHERE evidence.value->>'role' = 'partner'
               AND evidence.value->>'recipientBowlerId' = partner.partner_bowler_id::text
               AND evidence.value->>'paymentLinkId' = partner.payment_link_id::text
               AND evidence.value->>'linkFingerprint' = partner.link_fingerprint
          )
     )
  THEN
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
      MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: standing_partner_consent_evidence';
  END IF;

  IF EXISTS (
    SELECT 1 FROM account_payment_operation_snapshots snapshot
     WHERE snapshot.operation_id = operation_row.id
       AND snapshot.organization_id = p_organization_id
       AND snapshot.league_id = p_league_id
       AND snapshot.snapshot_kind <> 'standing_funding'
  ) OR EXISTS (
    SELECT 1 FROM payment_operation_roster_snapshots snapshot
     WHERE snapshot.operation_id = operation_row.id
       AND snapshot.organization_id = p_organization_id
       AND snapshot.league_id = p_league_id
  ) OR EXISTS (
    SELECT 1 FROM payment_operation_roster_snapshot_items item
     WHERE item.operation_id = operation_row.id
       AND item.organization_id = p_organization_id
       AND item.league_id = p_league_id
  ) OR EXISTS (
    SELECT 1 FROM payment_operation_standing_autopay_participants participant
     WHERE participant.operation_id = operation_row.id
       AND participant.organization_id = p_organization_id
       AND participant.league_id = p_league_id
  ) OR EXISTS (
    SELECT 1 FROM rotating_credit_payment_operation_snapshots rotating
     WHERE rotating.operation_id = operation_row.id
       AND rotating.organization_id = p_organization_id
       AND rotating.league_id = p_league_id
  ) OR EXISTS (
    SELECT 1 FROM weekly_payment_funding_authorization_items item
     WHERE item.source_operation_id = operation_row.id
       AND item.organization_id = p_organization_id
       AND item.league_id = p_league_id
  )
  THEN
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
      MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: standing_legacy_allocation_evidence';
  END IF;

  SELECT count(*) INTO portion_count
    FROM jsonb_array_elements(snapshot_row.funding_portions) portion(value);
  FOR item_row IN
    SELECT portion.value FROM jsonb_array_elements(snapshot_row.funding_portions) WITH ORDINALITY portion(value, ordinal)
     ORDER BY portion.ordinal
  LOOP
    IF jsonb_typeof(item_row.value) <> 'object'
       OR coalesce(item_row.value->>'portionIndex', '') !~ '^(0|[1-9][0-9]{0,9})$'
       OR coalesce(item_row.value->>'creditedBowlerId', '') !~ '^[1-9][0-9]{0,9}$'
       OR coalesce(item_row.value->>'amountMinor', '') !~ '^[1-9][0-9]{0,9}$'
       OR (CASE WHEN coalesce(item_row.value->>'portionIndex', '') ~ '^(0|[1-9][0-9]{0,9})$'
               THEN (item_row.value->>'portionIndex')::numeric > 2147483647
                    OR (item_row.value->>'portionIndex')::numeric <> expected_index
               ELSE true END)
       OR (CASE WHEN coalesce(item_row.value->>'creditedBowlerId', '') ~ '^[1-9][0-9]{0,9}$'
               THEN (item_row.value->>'creditedBowlerId')::numeric > 2147483647
               ELSE true END)
       OR (CASE WHEN coalesce(item_row.value->>'amountMinor', '') ~ '^[1-9][0-9]{0,9}$'
               THEN (item_row.value->>'amountMinor')::numeric > 2147483647
               ELSE true END)
    THEN
      RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
        MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: standing_portion_shape';
    END IF;
    portion_index_value := (item_row.value->>'portionIndex')::integer;
    portion_owner_value := (item_row.value->>'creditedBowlerId')::integer;
    portion_amount_value := (item_row.value->>'amountMinor')::integer;
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(snapshot_row.recipient_evidence) evidence(value)
       WHERE evidence.value->>'recipientBowlerId' = portion_owner_value::text
         AND (evidence.value->'target'->>'newChargeMinor') = portion_amount_value::text
    )
    THEN
      RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
        MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: standing_portion_evidence';
    END IF;
    SELECT id, source, authorization_kind, authorization_operation_id,
           authorization_item_count, authorization_fingerprint, adoption_id,
           portion_index, credited_bowler_id, amount_minor, currency
      INTO funding_row
      FROM weekly_payment_fundings
     WHERE organization_id = p_organization_id
       AND league_id = p_league_id
       AND payment_id = p_payment_id
       AND portion_index = portion_index_value
     FOR SHARE;
    IF NOT FOUND OR funding_row.source <> 'provider'
       OR funding_row.authorization_kind <> 'provider_snapshot'
       OR funding_row.authorization_operation_id <> operation_row.id
       OR funding_row.authorization_item_count <> 0
       OR funding_row.authorization_fingerprint <> snapshot_row.snapshot_fingerprint
       OR funding_row.adoption_id IS NOT NULL
       OR funding_row.credited_bowler_id <> portion_owner_value
       OR funding_row.amount_minor <> portion_amount_value
       OR funding_row.currency <> payment_row.currency
    THEN
      RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
        MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: standing_funding_portion';
    END IF;
    expected_index := expected_index + 1;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(snapshot_row.recipient_evidence) evidence(value)
     WHERE (evidence.value->'target'->>'newChargeMinor')::numeric > 0
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(snapshot_row.funding_portions) portion(value)
          WHERE portion.value->>'creditedBowlerId' = evidence.value->>'recipientBowlerId'
            AND portion.value->>'amountMinor' = evidence.value->'target'->>'newChargeMinor'
       )
  )
  THEN
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
      MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: standing_unfunded_positive_target';
  END IF;
  SELECT count(*), coalesce(sum(funding.amount_minor), 0)
    INTO funding_count, portion_total
    FROM weekly_payment_fundings funding
   WHERE funding.organization_id = p_organization_id
     AND funding.league_id = p_league_id
     AND funding.payment_id = p_payment_id;
  SELECT count(*) INTO auth_item_count
    FROM weekly_payment_funding_authorization_items authorization_item
   WHERE authorization_item.organization_id = p_organization_id
     AND authorization_item.league_id = p_league_id
     AND authorization_item.source_operation_id = operation_row.id;
  IF funding_count <> portion_count OR portion_total <> payment_row.amount
     OR auth_item_count <> 0
     OR EXISTS (
       SELECT 1 FROM rotating_credit_fundings rotating
        WHERE rotating.organization_id = p_organization_id
          AND rotating.league_id = p_league_id
          AND rotating.payment_id = p_payment_id
     )
  THEN
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
      MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: standing_funding_conservation';
  END IF;

  BEGIN
    PERFORM assert_owned_payment_source_applications(p_organization_id, p_league_id, p_payment_id);
  EXCEPTION WHEN SQLSTATE 'PWL01' THEN
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
      MESSAGE = SQLERRM;
  END;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION assert_owned_payment_tender_ledger(
  p_organization_id integer,
  p_league_id integer,
  p_payment_id integer
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  snapshot_kind_value text;
  snapshot_version_value integer;
BEGIN
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
  ELSE
    PERFORM assert_owned_payment_tender_ledger_v4(p_organization_id, p_league_id, p_payment_id);
  END IF;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION owned_payment_tender_ledger_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  payment_id_value integer;
  organization_id_value integer;
  league_id_value integer;
BEGIN
  IF TG_TABLE_NAME = 'payments' THEN
    payment_id_value := NEW.id;
  ELSE
    payment_id_value := NEW.payment_id;
  END IF;
  organization_id_value := NEW.organization_id;
  league_id_value := NEW.league_id;
  IF EXISTS (
    SELECT 1 FROM payments payment
      JOIN account_payment_operation_snapshots snapshot
        ON snapshot.operation_id = payment.payment_operation_id
       AND snapshot.organization_id = payment.organization_id
       AND snapshot.league_id = payment.league_id
     WHERE payment.id = payment_id_value
       AND payment.organization_id = organization_id_value
       AND payment.league_id = league_id_value
       AND ((snapshot.snapshot_kind = 'interactive_funding' AND snapshot.snapshot_version = 4)
         OR (snapshot.snapshot_kind = 'standing_funding' AND snapshot.snapshot_version = 5))
  ) THEN
    PERFORM assert_owned_payment_tender_ledger(organization_id_value, league_id_value, payment_id_value);
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- The 0053 refund-source fence accidentally referenced a tenant column that
-- refund_payment_operation_snapshots does not have. Recreate its behavior
-- with tenant scope derived from the linked payment operation instead.
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
         AND NOT (
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
  ) THEN
    PERFORM assert_owned_payment_tender_ledger(organization_id_value, league_id_value, payment_id_value);
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
