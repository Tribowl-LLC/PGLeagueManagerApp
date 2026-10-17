CREATE TABLE "account_payment_operation_snapshots" (
	"operation_id" uuid NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"snapshot_version" integer DEFAULT 4 NOT NULL,
	"snapshot_kind" text DEFAULT 'interactive_funding' NOT NULL,
	"payer_bowler_id" integer NOT NULL,
	"amount_minor" integer NOT NULL,
	"funding_portions" jsonb NOT NULL,
	"recipient_evidence" jsonb NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"provider_name" varchar(32) NOT NULL,
	"location_id" integer,
	"provider_location_id" varchar(255),
	"authorizing_user_id" integer NOT NULL,
	"request_kind" text DEFAULT 'direct' NOT NULL,
	"source_kind" text NOT NULL,
	"encrypted_source_id" text NOT NULL,
	"encrypted_customer_id" text,
	"encrypted_buyer_email" text,
	"store_card" boolean DEFAULT false NOT NULL,
	"quote_fingerprint" varchar(96) NOT NULL,
	"snapshot_fingerprint" varchar(96) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_payment_operation_snapshots_amount_check" CHECK ("account_payment_operation_snapshots"."amount_minor" > 0 AND "account_payment_operation_snapshots"."currency" = 'USD' AND "account_payment_operation_snapshots"."snapshot_version" = 4 AND "account_payment_operation_snapshots"."snapshot_kind" = 'interactive_funding' AND "account_payment_operation_snapshots"."request_kind" = 'direct' AND jsonb_typeof("account_payment_operation_snapshots"."funding_portions") = 'array' AND jsonb_array_length("account_payment_operation_snapshots"."funding_portions") > 0 AND jsonb_typeof("account_payment_operation_snapshots"."recipient_evidence") = 'array' AND jsonb_array_length("account_payment_operation_snapshots"."recipient_evidence") > 0),
	CONSTRAINT "account_payment_operation_snapshots_provenance_check" CHECK ("account_payment_operation_snapshots"."payer_bowler_id" > 0 AND "account_payment_operation_snapshots"."authorizing_user_id" > 0 AND "account_payment_operation_snapshots"."provider_name" ~ '^[a-z0-9][a-z0-9_-]{0,31}$' AND ("account_payment_operation_snapshots"."provider_location_id" IS NULL OR length(btrim("account_payment_operation_snapshots"."provider_location_id")) BETWEEN 1 AND 255)),
	CONSTRAINT "account_payment_operation_snapshots_source_check" CHECK (length(btrim("account_payment_operation_snapshots"."encrypted_source_id")) > 0 AND ("account_payment_operation_snapshots"."source_kind" <> 'wallet' OR "account_payment_operation_snapshots"."store_card" = false)),
	CONSTRAINT "account_payment_operation_snapshots_quote_fingerprint_check" CHECK ("account_payment_operation_snapshots"."quote_fingerprint" ~ '^lvaccountfundquote:v4:[0-9a-f]{64}$'),
	CONSTRAINT "account_payment_operation_snapshots_fingerprint_check" CHECK ("account_payment_operation_snapshots"."snapshot_fingerprint" ~ '^lvaccountfunding:v4:[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "refund_payment_operation_snapshots" DROP CONSTRAINT "refund_payment_operation_snapshots_version_check";--> statement-breakpoint
ALTER TABLE "refund_payment_operation_snapshots" DROP CONSTRAINT "refund_payment_operation_snapshots_fingerprint_check";--> statement-breakpoint
ALTER TABLE "refund_payment_operation_snapshots" DROP CONSTRAINT "refund_payment_operation_snapshots_disposition_check";--> statement-breakpoint
ALTER TABLE "payment_allocation_funding_applications" DROP CONSTRAINT "pay_alloc_fund_apps_assign_fk";
--> statement-breakpoint
ALTER TABLE "refund_payment_operation_snapshots" ADD COLUMN "funding_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "rot_occ_assign_app_identity_uq" ON "rotating_occurrence_assignments" USING btree ("id","organization_id","league_id","occurrence_id","team_id","responsibility_id");--> statement-breakpoint
ALTER TABLE "account_payment_operation_snapshots" ADD CONSTRAINT "account_payment_operation_snapshots_operation_fk" FOREIGN KEY ("operation_id","organization_id","league_id") REFERENCES "public"."payment_operations"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_payment_operation_snapshots" ADD CONSTRAINT "account_payment_operation_snapshots_league_tenant_fk" FOREIGN KEY ("league_id","organization_id") REFERENCES "public"."leagues"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_payment_operation_snapshots" ADD CONSTRAINT "account_payment_operation_snapshots_payer_tenant_fk" FOREIGN KEY ("payer_bowler_id","organization_id") REFERENCES "public"."bowlers"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_payment_operation_snapshots" ADD CONSTRAINT "account_payment_operation_snapshots_location_tenant_fk" FOREIGN KEY ("location_id","organization_id") REFERENCES "public"."locations"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_payment_operation_snapshots" ADD CONSTRAINT "account_payment_operation_snapshots_authorizing_user_fk" FOREIGN KEY ("authorizing_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_payment_operation_snapshots_operation_pk" ON "account_payment_operation_snapshots" USING btree ("operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_payment_operation_snapshots_tenant_identity_unique" ON "account_payment_operation_snapshots" USING btree ("operation_id","organization_id","league_id");--> statement-breakpoint
CREATE INDEX "account_payment_operation_snapshots_league_idx" ON "account_payment_operation_snapshots" USING btree ("organization_id","league_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "payment_allocation_funding_applications" ADD CONSTRAINT "pay_alloc_fund_apps_assign_fk" FOREIGN KEY ("assignment_id","organization_id","league_id","occurrence_id","team_id","responsibility_id") REFERENCES "public"."rotating_occurrence_assignments"("id","organization_id","league_id","occurrence_id","team_id","responsibility_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_payment_operation_snapshots" ADD CONSTRAINT "refund_payment_operation_snapshots_funding_snapshot_check" CHECK (jsonb_typeof("refund_payment_operation_snapshots"."funding_snapshot") = 'array' AND (("refund_payment_operation_snapshots"."snapshot_version" IN (1, 2) AND jsonb_array_length("refund_payment_operation_snapshots"."funding_snapshot") = 0) OR ("refund_payment_operation_snapshots"."snapshot_version" = 3 AND jsonb_array_length("refund_payment_operation_snapshots"."funding_snapshot") > 0)));--> statement-breakpoint
ALTER TABLE "refund_payment_operation_snapshots" ADD CONSTRAINT "refund_payment_operation_snapshots_version_check" CHECK ("refund_payment_operation_snapshots"."snapshot_version" IN (1, 2, 3));--> statement-breakpoint
ALTER TABLE "refund_payment_operation_snapshots" ADD CONSTRAINT "refund_payment_operation_snapshots_fingerprint_check" CHECK (("refund_payment_operation_snapshots"."snapshot_version" = 1 AND "refund_payment_operation_snapshots"."snapshot_fingerprint" ~ '^lvpayexecrf:v1:[0-9a-f]{64}$') OR ("refund_payment_operation_snapshots"."snapshot_version" = 2 AND "refund_payment_operation_snapshots"."snapshot_fingerprint" ~ '^lvpayexecrf:v2:[0-9a-f]{64}$') OR ("refund_payment_operation_snapshots"."snapshot_version" = 3 AND "refund_payment_operation_snapshots"."snapshot_fingerprint" ~ '^lvpayexecrf:v3:[0-9a-f]{64}$'));--> statement-breakpoint
ALTER TABLE "refund_payment_operation_snapshots" ADD CONSTRAINT "refund_payment_operation_snapshots_disposition_check" CHECK (("refund_payment_operation_snapshots"."snapshot_version" = 1 AND "refund_payment_operation_snapshots"."disposition" IS NULL) OR ("refund_payment_operation_snapshots"."snapshot_version" IN (2, 3) AND "refund_payment_operation_snapshots"."disposition" IS NOT NULL AND "refund_payment_operation_snapshots"."disposition" IN ('still_owed', 'waived')));
--> statement-breakpoint

-- The finalizer calls this exact-scope assertion before its recovery savepoint
-- exits. Deferred constraints remain the durable backstop at outer COMMIT.
CREATE OR REPLACE FUNCTION assert_owned_payment_tender_ledger(
  p_organization_id integer,
  p_league_id integer,
  p_payment_id integer
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  payment_row record;
  operation_row record;
  snapshot_row record;
  portion_row record;
  evidence_row record;
  funding_row record;
  portion_count integer;
  funding_count integer;
  portion_total bigint;
  expected_index integer := 0;
  portion_index_value integer;
  portion_owner_value integer;
  portion_amount_value integer;
  recipient_id_value integer;
BEGIN
  SELECT id, organization_id, league_id, bowler_id, amount, currency, type,
         status, provider_payment_id, payment_operation_id
    INTO payment_row
    FROM payments
   WHERE id = p_payment_id
     AND organization_id = p_organization_id
     AND league_id = p_league_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
      MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: tender_identity';
  END IF;
  IF payment_row.status <> 'paid' OR payment_row.amount <= 0
     OR payment_row.currency <> 'USD' OR payment_row.type IN ('cash', 'check')
     OR payment_row.provider_payment_id IS NULL OR payment_row.payment_operation_id IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
      MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: tender_identity';
  END IF;

  SELECT id, operation_type, status, amount_minor, currency, provider_name,
         provider_object_id
    INTO operation_row
    FROM payment_operations
   WHERE id = payment_row.payment_operation_id
     AND organization_id = p_organization_id
     AND league_id = p_league_id
   FOR SHARE;
  IF NOT FOUND OR operation_row.operation_type <> 'interactive_charge'
     OR operation_row.status <> 'succeeded'
     OR operation_row.amount_minor <> payment_row.amount
     OR operation_row.currency <> payment_row.currency
     OR operation_row.provider_name <> 'square'
     OR operation_row.provider_object_id IS NULL
     OR operation_row.provider_object_id <> payment_row.provider_payment_id
  THEN
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
      MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: tender_operation';
  END IF;

  SELECT operation_id, snapshot_version, snapshot_kind, payer_bowler_id,
         amount_minor, currency, funding_portions, recipient_evidence,
         snapshot_fingerprint
    INTO snapshot_row
    FROM account_payment_operation_snapshots
   WHERE operation_id = operation_row.id
     AND organization_id = p_organization_id
     AND league_id = p_league_id
   FOR SHARE;
  IF NOT FOUND OR snapshot_row.snapshot_version <> 4
     OR snapshot_row.snapshot_kind <> 'interactive_funding'
     OR snapshot_row.payer_bowler_id <> payment_row.bowler_id
     OR snapshot_row.amount_minor <> payment_row.amount
     OR snapshot_row.currency <> payment_row.currency
     OR snapshot_row.snapshot_fingerprint !~ '^lvaccountfunding:v4:[0-9a-f]{64}$'
     OR jsonb_typeof(snapshot_row.funding_portions) <> 'array'
     OR jsonb_array_length(snapshot_row.funding_portions) = 0
     OR jsonb_typeof(snapshot_row.recipient_evidence) <> 'array'
  THEN
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
      MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: tender_snapshot';
  END IF;

  SELECT count(*) INTO portion_count
    FROM jsonb_array_elements(snapshot_row.funding_portions) item(value);
  IF EXISTS (
       SELECT 1 FROM jsonb_array_elements(snapshot_row.funding_portions) item(value)
        WHERE jsonb_typeof(item.value) <> 'object'
           OR jsonb_typeof(item.value->'portionIndex') <> 'number'
           OR jsonb_typeof(item.value->'creditedBowlerId') <> 'number'
           OR jsonb_typeof(item.value->'amountMinor') <> 'number'
           OR coalesce(item.value->>'portionIndex', '') !~ '^(0|[1-9][0-9]*)$'
           OR coalesce(item.value->>'creditedBowlerId', '') !~ '^[1-9][0-9]*$'
           OR coalesce(item.value->>'amountMinor', '') !~ '^[1-9][0-9]*$'
     ) OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(snapshot_row.funding_portions) item(value)
        GROUP BY item.value->>'creditedBowlerId' HAVING count(*) <> 1
     ) OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(snapshot_row.recipient_evidence) item(value)
        WHERE jsonb_typeof(item.value) <> 'object'
           OR jsonb_typeof(item.value->'recipientBowlerId') <> 'number'
           OR coalesce(item.value->>'recipientBowlerId', '') !~ '^[1-9][0-9]*$'
           OR coalesce(item.value->>'role', '') NOT IN ('self', 'partner')
           OR (item.value->>'role' = 'self' AND (
             (item.value->>'recipientBowlerId')::numeric <> snapshot_row.payer_bowler_id
             OR nullif(item.value->>'paymentLinkId', 'null') IS NOT NULL
             OR nullif(item.value->>'linkFingerprint', 'null') IS NOT NULL
           ))
           OR (item.value->>'role' = 'partner' AND (
             (item.value->>'recipientBowlerId')::numeric = snapshot_row.payer_bowler_id
             OR coalesce(item.value->>'paymentLinkId', '') !~ '^[1-9][0-9]*$'
             OR coalesce(item.value->>'linkFingerprint', '') !~ '^lvpartnerlink:v1:[0-9a-f]{64}$'
           ))
     ) OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(snapshot_row.recipient_evidence) item(value)
        GROUP BY item.value->>'recipientBowlerId' HAVING count(*) <> 1
     )
  THEN
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
      MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: tender_snapshot_shape';
  END IF;

  FOR portion_row IN
    SELECT item.value FROM jsonb_array_elements(snapshot_row.funding_portions) WITH ORDINALITY item(value, ordinality)
     ORDER BY item.ordinality
  LOOP
    IF (portion_row.value->>'portionIndex')::numeric <> expected_index
       OR (portion_row.value->>'portionIndex')::numeric > 2147483647
       OR (portion_row.value->>'creditedBowlerId')::numeric > 2147483647
       OR (portion_row.value->>'amountMinor')::numeric > 2147483647
    THEN
      RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
        MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: tender_portion_order';
    END IF;
    portion_index_value := (portion_row.value->>'portionIndex')::integer;
    portion_owner_value := (portion_row.value->>'creditedBowlerId')::integer;
    portion_amount_value := (portion_row.value->>'amountMinor')::integer;
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(snapshot_row.recipient_evidence) evidence(value)
       WHERE evidence.value->>'recipientBowlerId' = portion_owner_value::text
         AND ((evidence.value->>'role' = 'self'
               AND portion_owner_value = snapshot_row.payer_bowler_id
               AND nullif(evidence.value->>'paymentLinkId', 'null') IS NULL
               AND nullif(evidence.value->>'linkFingerprint', 'null') IS NULL)
           OR (evidence.value->>'role' = 'partner'
               AND portion_owner_value <> snapshot_row.payer_bowler_id
               AND coalesce(evidence.value->>'paymentLinkId', '') ~ '^[1-9][0-9]*$'
               AND coalesce(evidence.value->>'linkFingerprint', '') ~ '^lvpartnerlink:v1:[0-9a-f]{64}$'))
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
        MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: tender_recipient_evidence';
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
        MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: tender_funding_portion';
    END IF;
    expected_index := expected_index + 1;
  END LOOP;

  SELECT count(*), coalesce(sum(f.amount_minor), 0)
    INTO funding_count, portion_total
    FROM weekly_payment_fundings f
   WHERE f.organization_id = p_organization_id
     AND f.league_id = p_league_id
     AND f.payment_id = p_payment_id;
  IF funding_count <> portion_count OR portion_total <> payment_row.amount
     OR EXISTS (
       SELECT 1 FROM rotating_credit_fundings rf
        WHERE rf.organization_id = p_organization_id
          AND rf.league_id = p_league_id
          AND rf.payment_id = p_payment_id
     )
  THEN
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
      MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: tender_funding_conservation';
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
     WHERE allocation.organization_id = p_organization_id
       AND allocation.league_id = p_league_id
       AND allocation.payment_id = p_payment_id
       AND (allocation.state <> 'active'
         OR allocation.allocation_kind <> 'ordinary'
         OR application.id IS NULL
         OR application.payment_id <> p_payment_id
         OR application.amount_minor <> allocation.amount_minor
         OR application.obligation_id <> allocation.obligation_id
         OR application.currency <> allocation.currency
         OR application.generic_funding_id IS NULL
         OR application.rotating_funding_id IS NOT NULL
         OR funding.id IS NULL
         OR obligation.id IS NULL
         OR responsibility.id IS NULL
         OR application.amount_minor <= 0
         OR (application.target_kind = 'bowler_responsibility'
             AND (application.target_payer_bowler_id IS NULL
               OR application.assignment_id IS NOT NULL
               OR obligation.payer_bowler_id IS DISTINCT FROM application.target_payer_bowler_id
               OR application.credited_bowler_id <> application.target_payer_bowler_id))
         OR (application.target_kind = 'legacy_team_assignment'
             AND (application.target_payer_bowler_id IS NOT NULL
               OR application.assignment_id IS NULL
               OR NOT EXISTS (
                 SELECT 1 FROM rotating_occurrence_assignments assignment
                  WHERE assignment.id = application.assignment_id
                    AND assignment.organization_id = application.organization_id
                    AND assignment.league_id = application.league_id
                    AND assignment.occurrence_id = application.occurrence_id
                    AND assignment.team_id = application.team_id
                    AND assignment.responsibility_id = application.responsibility_id
                    AND assignment.actual_bowler_id = application.credited_bowler_id
               )))
         OR NOT EXISTS (
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
  ) OR EXISTS (
    SELECT 1
      FROM weekly_payment_fundings funding
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
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
      MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: tender_allocation_link';
  END IF;

  -- Reuse the complete typed-application validator here so provider
  -- finalization observes obligation caps and recipient/assignment proof
  -- failures inside its recovery savepoint. The deferred triggers below call
  -- both assertions; this is intentionally non-recursive.
  BEGIN
    PERFORM assert_owned_payment_source_applications(p_organization_id, p_league_id, p_payment_id);
  EXCEPTION WHEN SQLSTATE 'PWL01' THEN
    -- Preserve the invariant signal across this reusable sub-assertion so a
    -- provider finalizer can map the exact callable failure inside its
    -- recovery savepoint. The nested validator only emits PWL01 for owned
    -- ledger evidence; unrelated SQL errors remain unmodified.
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_tender_ledger_guard',
      MESSAGE = SQLERRM;
  END;
END;
$$;--> statement-breakpoint

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
         AND operation.organization_id = snapshot.organization_id
         AND operation.league_id = snapshot.league_id
       WHERE snapshot.organization_id = organization_id_value
         AND snapshot.league_id = league_id_value
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
CREATE OR REPLACE FUNCTION weekly_payment_evidence_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('leaguevault.organization_teardown', true) = 'on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'weekly payment ledger evidence is append-only';
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION worksheet_obligation_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  responsibility_row record;
BEGIN
  SELECT occurrence_id, responsibility_kind, payer_bowler_id,
         worksheet_fee_component, amount_minor, currency
    INTO responsibility_row
    FROM occurrence_payment_responsibilities
   WHERE id = NEW.responsibility_id
     AND organization_id = NEW.organization_id
     AND league_id = NEW.league_id
   FOR SHARE;
  IF NOT FOUND OR responsibility_row.responsibility_kind <> 'worksheet' THEN
    RETURN NEW;
  END IF;
  IF NEW.occurrence_id <> responsibility_row.occurrence_id
     OR NEW.payer_bowler_id IS DISTINCT FROM responsibility_row.payer_bowler_id
     OR NEW.amount_minor <> responsibility_row.amount_minor
     OR NEW.currency <> responsibility_row.currency
     OR NEW.component <> responsibility_row.worksheet_fee_component
     OR NEW.amount_minor <= 0
  THEN
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'worksheet_obligation_identity_guard',
      MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: worksheet_obligation_identity';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER owned_payment_funding_payment_guard
AFTER INSERT OR UPDATE ON payments DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION owned_payment_funding_event_guard();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER owned_payment_funding_source_guard
AFTER INSERT ON weekly_payment_fundings DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION owned_payment_funding_event_guard();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER owned_payment_funding_application_guard
AFTER INSERT ON payment_allocation_funding_applications DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION owned_payment_funding_event_guard();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER owned_payment_funding_release_guard
AFTER INSERT ON weekly_payment_allocation_releases DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION owned_payment_funding_event_guard();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER owned_payment_funding_allocation_guard
AFTER INSERT OR UPDATE ON payment_allocations DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION owned_payment_funding_event_guard();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER worksheet_obligation_identity
AFTER INSERT OR UPDATE ON payment_obligations DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION worksheet_obligation_identity_guard();--> statement-breakpoint

CREATE TRIGGER weekly_payment_fundings_append_only
BEFORE UPDATE OR DELETE ON weekly_payment_fundings FOR EACH ROW
EXECUTE FUNCTION weekly_payment_evidence_append_only_guard();--> statement-breakpoint
CREATE TRIGGER weekly_payment_funding_auth_items_append_only
BEFORE UPDATE OR DELETE ON weekly_payment_funding_authorization_items FOR EACH ROW
EXECUTE FUNCTION weekly_payment_evidence_append_only_guard();--> statement-breakpoint
CREATE TRIGGER payment_allocation_funding_apps_append_only
BEFORE UPDATE OR DELETE ON payment_allocation_funding_applications FOR EACH ROW
EXECUTE FUNCTION weekly_payment_evidence_append_only_guard();--> statement-breakpoint
CREATE TRIGGER weekly_payment_allocation_releases_append_only
BEFORE UPDATE OR DELETE ON weekly_payment_allocation_releases FOR EACH ROW
EXECUTE FUNCTION weekly_payment_evidence_append_only_guard();--> statement-breakpoint
CREATE TRIGGER weekly_payment_ledger_adoptions_append_only
BEFORE UPDATE OR DELETE ON weekly_payment_ledger_adoptions FOR EACH ROW
EXECUTE FUNCTION weekly_payment_evidence_append_only_guard();--> statement-breakpoint
CREATE TRIGGER weekly_payment_adoption_proofs_append_only
BEFORE UPDATE OR DELETE ON weekly_payment_ledger_adoption_allocation_proofs FOR EACH ROW
EXECUTE FUNCTION weekly_payment_evidence_append_only_guard();--> statement-breakpoint
CREATE TRIGGER weekly_payment_adoption_steps_append_only
BEFORE UPDATE OR DELETE ON weekly_payment_ledger_adoption_allocation_proof_steps FOR EACH ROW
EXECUTE FUNCTION weekly_payment_evidence_append_only_guard();--> statement-breakpoint
CREATE TRIGGER weekly_payment_week_confirmations_append_only
BEFORE UPDATE OR DELETE ON weekly_payment_week_confirmations FOR EACH ROW
EXECUTE FUNCTION weekly_payment_evidence_append_only_guard();--> statement-breakpoint
CREATE TRIGGER weekly_payment_worksheet_receipts_append_only
BEFORE UPDATE OR DELETE ON weekly_payment_worksheet_receipts FOR EACH ROW
EXECUTE FUNCTION weekly_payment_evidence_append_only_guard();--> statement-breakpoint
CREATE TRIGGER weekly_payment_receipt_revisions_append_only
BEFORE UPDATE OR DELETE ON weekly_payment_worksheet_receipt_revisions FOR EACH ROW
EXECUTE FUNCTION weekly_payment_evidence_append_only_guard();--> statement-breakpoint
CREATE TRIGGER account_payment_operation_snapshots_append_only
BEFORE UPDATE OR DELETE ON account_payment_operation_snapshots FOR EACH ROW
EXECUTE FUNCTION weekly_payment_evidence_append_only_guard();--> statement-breakpoint

CREATE OR REPLACE FUNCTION owned_payment_tender_ledger_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  payment_id_value integer;
  organization_id_value integer;
  league_id_value integer;
BEGIN
  IF TG_TABLE_NAME = 'payments' THEN
    payment_id_value := NEW.id;
    organization_id_value := NEW.organization_id;
    league_id_value := NEW.league_id;
  ELSE
    payment_id_value := NEW.payment_id;
    organization_id_value := NEW.organization_id;
    league_id_value := NEW.league_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM payments payment
      JOIN account_payment_operation_snapshots snapshot
        ON snapshot.operation_id = payment.payment_operation_id
       AND snapshot.organization_id = payment.organization_id
       AND snapshot.league_id = payment.league_id
     WHERE payment.id = payment_id_value
       AND payment.organization_id = organization_id_value
       AND payment.league_id = league_id_value
       AND snapshot.snapshot_kind = 'interactive_funding'
       AND snapshot.snapshot_version = 4
  ) THEN
    PERFORM assert_owned_payment_tender_ledger(organization_id_value, league_id_value, payment_id_value);
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER owned_payment_tender_ledger_payment_guard
AFTER INSERT ON payments DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION owned_payment_tender_ledger_insert_guard();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER owned_payment_tender_ledger_funding_guard
AFTER INSERT ON weekly_payment_fundings DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION owned_payment_tender_ledger_insert_guard();--> statement-breakpoint

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
  SELECT id, organization_id, league_id, bowler_id, amount, currency, type,
         status, provider_payment_id, payment_operation_id, dispute_id, disputed_at
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

  SELECT count(*), coalesce(sum(f.amount_minor), 0)
    INTO funding_count, funding_total
    FROM weekly_payment_fundings f
   WHERE f.organization_id = p_organization_id
     AND f.league_id = p_league_id
     AND f.payment_id = p_payment_id;
  IF funding_count = 0 THEN RETURN; END IF;
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

  IF payment_row.status NOT IN ('paid', 'voided')
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

--> statement-breakpoint
-- A legacy rotating cash/check source is only voidable as part of the
-- worksheet's append-only manual receipt edit/clear path. The next exact
-- receipt revision carries the replacement identity (or null for clear).
CREATE OR REPLACE FUNCTION rotating_credit_is_audited_manual_correction(p_payment_id integer)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
      FROM payments payment
      JOIN rotating_credit_fundings funding
        ON funding.payment_id = payment.id
       AND funding.organization_id = payment.organization_id
       AND funding.league_id = payment.league_id
      JOIN payment_voids void
        ON void.payment_id = payment.id
       AND void.organization_id = payment.organization_id
       AND void.league_id = payment.league_id
      JOIN weekly_payment_worksheet_receipt_revisions source_revision
        ON source_revision.payment_id = payment.id
       AND source_revision.organization_id = payment.organization_id
       AND source_revision.league_id = payment.league_id
       AND source_revision.amount_minor = payment.amount
       AND source_revision.revision_kind IN ('manual_record', 'manual_edit')
      JOIN weekly_payment_worksheet_receipts receipt
        ON receipt.id = source_revision.receipt_id
       AND receipt.organization_id = source_revision.organization_id
       AND receipt.league_id = source_revision.league_id
       AND receipt.payer_bowler_id = funding.bowler_id
       AND receipt.receipt_kind = 'manual'
      JOIN weekly_payment_worksheet_receipt_revisions correction
        ON correction.receipt_id = source_revision.receipt_id
       AND correction.organization_id = source_revision.organization_id
       AND correction.league_id = source_revision.league_id
       AND correction.receipt_revision = source_revision.receipt_revision + 1
       AND correction.business_collection_local_date = source_revision.business_collection_local_date
       AND (
         (correction.revision_kind = 'manual_clear' AND correction.payment_id IS NULL AND correction.amount_minor = 0)
         OR (correction.revision_kind = 'manual_edit' AND correction.payment_id IS NOT NULL
           AND correction.payment_id <> payment.id AND correction.amount_minor > 0
           AND EXISTS (
             SELECT 1 FROM weekly_payment_fundings replacement_funding
              WHERE replacement_funding.payment_id = correction.payment_id
                AND replacement_funding.organization_id = correction.organization_id
                AND replacement_funding.league_id = correction.league_id
                AND replacement_funding.credited_bowler_id = receipt.payer_bowler_id
                AND replacement_funding.amount_minor = correction.amount_minor
                AND replacement_funding.source = 'worksheet_manual'
                AND replacement_funding.authorization_kind = 'manual_receipt'
           ))
       )
      JOIN weekly_payment_ledger_adoptions adoption
        ON adoption.organization_id = payment.organization_id
       AND adoption.league_id = payment.league_id
     WHERE payment.id = p_payment_id
       AND payment.status = 'voided'
       AND payment.type IN ('cash', 'check')
       AND payment.currency = 'USD'
       AND payment.provider_payment_id IS NULL
       AND payment.payment_operation_id IS NULL
       AND payment.dispute_id IS NULL
       AND payment.disputed_at IS NULL
       AND funding.funding_kind IN ('cash', 'check')
       AND funding.amount_minor = payment.amount
       AND NOT EXISTS (
         SELECT 1 FROM weekly_payment_fundings generic_funding
          WHERE generic_funding.payment_id = payment.id
            AND generic_funding.organization_id = payment.organization_id
            AND generic_funding.league_id = payment.league_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM payment_allocations allocation
          WHERE allocation.payment_id = payment.id
            AND allocation.organization_id = payment.organization_id
            AND allocation.league_id = payment.league_id
            AND allocation.state = 'active'
       )
  );
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION rotating_credit_ledger_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_payment_id integer;
BEGIN
  IF TG_TABLE_NAME IN ('rotating_credit_fundings', 'rotating_credit_applications', 'rotating_credit_refunds',
                       'rotating_credit_refund_operation_snapshots') THEN
    target_payment_id := (to_jsonb(NEW)->>'payment_id')::integer;
  ELSIF TG_TABLE_NAME = 'rotating_credit_application_reversals' THEN
    target_payment_id := (to_jsonb(NEW)->>'funding_payment_id')::integer;
  ELSIF TG_TABLE_NAME = 'payment_operations' THEN
    SELECT payment_id INTO target_payment_id
      FROM rotating_credit_refund_operation_snapshots
     WHERE operation_id = (to_jsonb(NEW)->>'id')::uuid;
  ELSIF TG_TABLE_NAME = 'payment_allocation_funding_applications' THEN
    IF (to_jsonb(NEW)->>'rotating_funding_id') IS NOT NULL THEN
      target_payment_id := (to_jsonb(NEW)->>'payment_id')::integer;
    END IF;
  ELSIF TG_TABLE_NAME = 'weekly_payment_allocation_releases' THEN
    SELECT application.payment_id INTO target_payment_id
      FROM payment_allocation_funding_applications application
     WHERE application.id = (to_jsonb(NEW)->>'funding_application_id')::uuid
       AND application.rotating_funding_id IS NOT NULL;
  END IF;
  IF target_payment_id IS NOT NULL THEN
    PERFORM rotating_credit_assert_ledger(target_payment_id);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION rotating_credit_assignment_ledger_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  payment_row record;
BEGIN
  FOR payment_row IN
    SELECT DISTINCT application.payment_id
      FROM rotating_credit_applications application
     WHERE application.organization_id = NEW.organization_id
       AND application.league_id = NEW.league_id
       AND application.occurrence_id = NEW.occurrence_id
       AND application.team_id = NEW.team_id
       AND application.slot_index = NEW.slot_index
    UNION
    SELECT DISTINCT application.payment_id
      FROM payment_allocation_funding_applications application
      JOIN rotating_occurrence_assignments prior_assignment
        ON prior_assignment.id = application.assignment_id
       AND prior_assignment.organization_id = application.organization_id
       AND prior_assignment.league_id = application.league_id
       AND prior_assignment.occurrence_id = application.occurrence_id
       AND prior_assignment.team_id = application.team_id
       AND prior_assignment.responsibility_id = application.responsibility_id
     WHERE application.rotating_funding_id IS NOT NULL
       AND application.organization_id = NEW.organization_id
       AND application.league_id = NEW.league_id
       AND application.occurrence_id = NEW.occurrence_id
       AND application.team_id = NEW.team_id
       AND prior_assignment.slot_index = NEW.slot_index
  LOOP
    PERFORM rotating_credit_assert_ledger(payment_row.payment_id);
  END LOOP;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER rotating_credit_owned_application_guard
AFTER INSERT ON payment_allocation_funding_applications
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rotating_credit_ledger_event_guard();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER rotating_credit_owned_release_guard
AFTER INSERT ON weekly_payment_allocation_releases
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rotating_credit_ledger_event_guard();--> statement-breakpoint

CREATE OR REPLACE FUNCTION rotating_credit_assert_ledger(p_payment_id integer) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  funding_row record;
  operation_row record;
  operation_snapshot record;
  application_row record;
  typed_application_row record;
  refund_row record;
  manual_receipt_correction boolean := false;
  application_release_count integer;
  obligation_row record;
  owner_row record;
  applied_minor bigint := 0;
  refund_minor bigint := 0;
BEGIN
  SELECT f.id, f.organization_id, f.league_id, f.bowler_id, f.payment_id,
         f.amount_minor, f.currency, f.funding_kind, f.idempotency_key,
         f.quote_fingerprint, f.actor_user_id, p.type AS payment_type, p.status AS payment_status,
         p.amount AS payment_amount, p.currency AS payment_currency,
         p.bowler_id AS payment_bowler_id,
         p.provider_payment_id, p.payment_operation_id, p.dispute_id, p.disputed_at,
         league.location_id AS league_location_id
    INTO funding_row
    FROM rotating_credit_fundings f
    JOIN payments p
      ON p.id = f.payment_id
     AND p.organization_id = f.organization_id
     AND p.league_id = f.league_id
    JOIN leagues league
      ON league.id = f.league_id
     AND league.organization_id = f.organization_id
   WHERE f.payment_id = p_payment_id
   FOR UPDATE OF f, p;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  manual_receipt_correction := rotating_credit_is_audited_manual_correction(p_payment_id);
  IF funding_row.amount_minor <= 0
     OR funding_row.amount_minor <> funding_row.payment_amount
     OR funding_row.bowler_id <> funding_row.payment_bowler_id
     OR funding_row.currency <> 'USD'
     OR funding_row.payment_currency <> funding_row.currency
     OR (funding_row.payment_status <> 'paid' AND NOT (funding_row.payment_status = 'voided' AND manual_receipt_correction))
     OR (funding_row.payment_status = 'paid' AND manual_receipt_correction)
     OR funding_row.dispute_id IS NOT NULL
     OR funding_row.disputed_at IS NOT NULL
     OR (funding_row.funding_kind = 'cash' AND (funding_row.payment_type <> 'cash' OR funding_row.payment_operation_id IS NOT NULL OR funding_row.provider_payment_id IS NOT NULL))
     OR (funding_row.funding_kind = 'check' AND (funding_row.payment_type <> 'check' OR funding_row.payment_operation_id IS NOT NULL OR funding_row.provider_payment_id IS NOT NULL))
     OR (funding_row.funding_kind = 'provider' AND funding_row.payment_type NOT IN ('square', 'credit_card'))
  THEN
    RAISE EXCEPTION 'rotating credit funding does not match its real tender parent';
  END IF;

  IF funding_row.funding_kind = 'provider' THEN
    SELECT operation_type, status, amount_minor, currency, provider_object_id,
           provider_name, authorizing_user_id, target_key
      INTO operation_row
      FROM payment_operations
     WHERE id = funding_row.payment_operation_id
       AND organization_id = funding_row.organization_id
       AND league_id = funding_row.league_id;
    IF NOT FOUND
       OR operation_row.operation_type <> 'interactive_charge'
       OR operation_row.status NOT IN ('succeeded', 'reconciliation_required')
       OR operation_row.amount_minor <> funding_row.amount_minor
       OR operation_row.currency <> funding_row.currency
       OR operation_row.provider_name IS DISTINCT FROM 'square'
       OR operation_row.authorizing_user_id IS DISTINCT FROM funding_row.actor_user_id
       OR operation_row.target_key NOT LIKE 'interactive-charge:rotating-credit:%'
       OR length(operation_row.target_key) <> length('interactive-charge:rotating-credit:') + 64
       OR substring(operation_row.target_key FROM length('interactive-charge:rotating-credit:') + 1) !~ '^[0-9a-f]{64}$'
       OR operation_row.provider_object_id IS NULL
       OR operation_row.provider_object_id <> funding_row.provider_payment_id
    THEN
      RAISE EXCEPTION 'provider credit funding does not match its durable charge operation';
    END IF;
    SELECT bowler_id, amount_minor, currency, quote_fingerprint, idempotency_key,
           location_id, provider_location_id
      INTO operation_snapshot
      FROM rotating_credit_payment_operation_snapshots
     WHERE operation_id = funding_row.payment_operation_id
       AND organization_id = funding_row.organization_id
       AND league_id = funding_row.league_id;
    IF NOT FOUND
       OR operation_snapshot.bowler_id <> funding_row.bowler_id
       OR operation_snapshot.amount_minor <> funding_row.amount_minor
       OR operation_snapshot.currency <> funding_row.currency
       OR operation_snapshot.quote_fingerprint <> funding_row.quote_fingerprint
       OR operation_snapshot.idempotency_key <> funding_row.idempotency_key
       OR operation_snapshot.location_id IS DISTINCT FROM funding_row.league_location_id
       OR operation_snapshot.provider_location_id IS NOT NULL
    THEN
      RAISE EXCEPTION 'provider credit funding does not match its immutable charge snapshot';
    END IF;
    IF EXISTS (
      SELECT 1
        FROM payment_operation_roster_snapshots roster_snapshot
       WHERE roster_snapshot.operation_id = funding_row.payment_operation_id
         AND roster_snapshot.organization_id = funding_row.organization_id
         AND roster_snapshot.league_id = funding_row.league_id
    ) THEN
      RAISE EXCEPTION 'rotating credit funding cannot reuse an ordinary roster charge snapshot';
    END IF;
  ELSIF funding_row.payment_operation_id IS NOT NULL OR funding_row.provider_payment_id IS NOT NULL THEN
    RAISE EXCEPTION 'manual credit funding cannot reference provider payment evidence';
  END IF;

  IF EXISTS (
    SELECT 1 FROM payment_voids payment_void
     WHERE payment_void.payment_id = funding_row.payment_id
       AND payment_void.organization_id = funding_row.organization_id
       AND payment_void.league_id = funding_row.league_id
  ) AND NOT manual_receipt_correction THEN
    RAISE EXCEPTION 'rotating credit funding cannot be voided as an ordinary tender';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM payment_allocations allocation
      LEFT JOIN rotating_credit_applications application
        ON application.allocation_id = allocation.id
       AND application.organization_id = allocation.organization_id
       AND application.league_id = allocation.league_id
      LEFT JOIN payment_allocation_funding_applications owned_application
        ON owned_application.allocation_id = allocation.id
       AND owned_application.organization_id = allocation.organization_id
       AND owned_application.league_id = allocation.league_id
     WHERE allocation.payment_id = funding_row.payment_id
       AND allocation.organization_id = funding_row.organization_id
       AND allocation.league_id = funding_row.league_id
       AND (allocation.allocation_kind <> 'rotating_credit'
         OR (application.id IS NULL AND (
           owned_application.id IS NULL
           OR owned_application.rotating_funding_id IS DISTINCT FROM funding_row.id
           OR owned_application.generic_funding_id IS NOT NULL
         ))
         OR (application.id IS NOT NULL AND owned_application.id IS NOT NULL))
  ) THEN
    RAISE EXCEPTION 'rotating credit allocation must use exactly one matching immutable application';
  END IF;

  FOR application_row IN
    SELECT application.id, application.organization_id, application.league_id,
           application.funding_id, application.payment_id, application.allocation_id,
           application.obligation_id, application.assignment_id, application.responsibility_id,
           application.actual_bowler_id, application.team_id, application.slot_index,
           application.occurrence_id, application.amount_minor, application.currency,
           allocation.allocation_kind,
           allocation.state AS allocation_state, allocation.payment_id AS allocation_payment_id,
           allocation.obligation_id AS allocation_obligation_id,
           allocation.amount_minor AS allocation_amount_minor,
           allocation.currency AS allocation_currency,
           reversal.id AS reversal_id, reversal.funding_payment_id AS reversal_payment_id,
           reversal.allocation_id AS reversal_allocation_id,
           reversal.obligation_id AS reversal_obligation_id,
           reversal.assignment_id AS reversal_assignment_id,
           reversal.bowler_id AS reversal_bowler_id, reversal.amount_minor AS reversal_amount_minor
      FROM rotating_credit_applications application
      JOIN payment_allocations allocation
        ON allocation.id = application.allocation_id
       AND allocation.organization_id = application.organization_id
       AND allocation.league_id = application.league_id
      LEFT JOIN rotating_credit_application_reversals reversal
        ON reversal.application_id = application.id
       AND reversal.organization_id = application.organization_id
       AND reversal.league_id = application.league_id
     WHERE application.funding_id = funding_row.id
       AND application.organization_id = funding_row.organization_id
       AND application.league_id = funding_row.league_id
     ORDER BY application.id
  LOOP
    IF application_row.payment_id <> funding_row.payment_id
       OR application_row.actual_bowler_id <> funding_row.bowler_id
       OR application_row.allocation_kind <> 'rotating_credit'
       OR application_row.allocation_payment_id <> funding_row.payment_id
       OR application_row.allocation_obligation_id <> application_row.obligation_id
       OR application_row.allocation_amount_minor <> application_row.amount_minor
       OR application_row.allocation_currency <> application_row.currency
       OR application_row.currency <> funding_row.currency
    THEN
      RAISE EXCEPTION 'rotating credit application does not match its funding allocation';
    END IF;

    SELECT po.id, po.occurrence_id, po.responsibility_id, responsibility.team_id,
           responsibility.slot_index
      INTO obligation_row
      FROM payment_obligations po
      JOIN occurrence_payment_responsibilities responsibility
        ON responsibility.id = po.responsibility_id
       AND responsibility.organization_id = po.organization_id
       AND responsibility.league_id = po.league_id
     WHERE po.id = application_row.obligation_id
       AND po.organization_id = funding_row.organization_id
       AND po.league_id = funding_row.league_id;
    IF NOT FOUND
       OR obligation_row.occurrence_id <> application_row.occurrence_id
       OR obligation_row.responsibility_id <> application_row.responsibility_id
       OR obligation_row.team_id <> application_row.team_id
       OR obligation_row.slot_index <> application_row.slot_index
    THEN
      RAISE EXCEPTION 'rotating credit application does not match its canonical obligation';
    END IF;

  IF NOT EXISTS (
      SELECT 1 FROM rotating_occurrence_assignments assignment
       WHERE assignment.id = application_row.assignment_id
         AND assignment.organization_id = funding_row.organization_id
         AND assignment.league_id = funding_row.league_id
         AND assignment.occurrence_id = application_row.occurrence_id
         AND assignment.team_id = application_row.team_id
         AND assignment.slot_index = application_row.slot_index
         AND assignment.responsibility_id = application_row.responsibility_id
         AND assignment.actual_bowler_id = application_row.actual_bowler_id
    ) THEN
      RAISE EXCEPTION 'rotating credit application does not match its confirmed assignment';
    END IF;
    IF application_row.reversal_id IS NULL AND NOT EXISTS (
      SELECT 1
        FROM rotating_occurrence_assignments current_assignment
       WHERE current_assignment.id = application_row.assignment_id
         AND current_assignment.organization_id = funding_row.organization_id
         AND current_assignment.league_id = funding_row.league_id
         AND current_assignment.occurrence_id = application_row.occurrence_id
         AND current_assignment.team_id = application_row.team_id
         AND current_assignment.slot_index = application_row.slot_index
         AND current_assignment.responsibility_id = application_row.responsibility_id
         AND current_assignment.actual_bowler_id = application_row.actual_bowler_id
         AND current_assignment.version = (
           SELECT max(latest_assignment.version)
             FROM rotating_occurrence_assignments latest_assignment
            WHERE latest_assignment.organization_id = current_assignment.organization_id
              AND latest_assignment.league_id = current_assignment.league_id
              AND latest_assignment.occurrence_id = current_assignment.occurrence_id
              AND latest_assignment.team_id = current_assignment.team_id
              AND latest_assignment.slot_index = current_assignment.slot_index
         )
    ) THEN
      RAISE EXCEPTION 'active rotating credit application must match the current confirmed assignment';
    END IF;

    SELECT owner_kind, owner_team_id
      INTO owner_row
      FROM payment_obligation_owner_revisions
     WHERE obligation_id = application_row.obligation_id
       AND organization_id = funding_row.organization_id
       AND league_id = funding_row.league_id
     ORDER BY revision_number DESC, id ASC
     LIMIT 1;
    IF NOT FOUND OR owner_row.owner_kind <> 'team' OR owner_row.owner_team_id <> application_row.team_id THEN
      RAISE EXCEPTION 'rotating credit application requires a current team-owned obligation';
    END IF;

    IF application_row.reversal_id IS NULL THEN
      IF application_row.allocation_state <> 'active' THEN
        RAISE EXCEPTION 'unreversed rotating credit application must retain an active allocation';
      END IF;
      applied_minor := applied_minor + application_row.amount_minor;
    ELSIF application_row.allocation_state <> 'voided'
       OR application_row.reversal_payment_id <> funding_row.payment_id
       OR application_row.reversal_allocation_id <> application_row.allocation_id
       OR application_row.reversal_obligation_id <> application_row.obligation_id
       OR application_row.reversal_assignment_id <> application_row.assignment_id
       OR application_row.reversal_bowler_id <> application_row.actual_bowler_id
       OR application_row.reversal_amount_minor <> application_row.amount_minor
    THEN
      RAISE EXCEPTION 'rotating credit reversal must void the exact original application allocation';
    END IF;
  END LOOP;

  FOR typed_application_row IN
    SELECT application.id, application.organization_id, application.league_id,
           application.payment_id, application.credited_bowler_id,
           application.generic_funding_id, application.rotating_funding_id,
           application.source_amount_minor, application.amount_minor,
           application.currency, application.obligation_id,
           application.responsibility_id, application.occurrence_id,
           application.team_id, application.target_kind,
           application.target_payer_bowler_id, application.assignment_id,
           allocation.id AS allocation_id, allocation.state AS allocation_state,
           allocation.allocation_kind, allocation.review_required,
           allocation.payment_id AS allocation_payment_id,
           allocation.obligation_id AS allocation_obligation_id,
           allocation.amount_minor AS allocation_amount_minor,
           allocation.currency AS allocation_currency,
           obligation.payer_bowler_id, obligation.amount_minor AS obligation_amount_minor,
           responsibility.payer_bowler_id AS responsibility_payer_bowler_id,
           responsibility.team_id AS responsibility_team_id,
           owner.owner_kind, owner.owner_bowler_id, owner.owner_team_id,
           assignment.actual_bowler_id AS assignment_actual_bowler_id,
           assignment.version AS assignment_version,
           (SELECT count(*) FROM weekly_payment_allocation_releases release
             WHERE release.funding_application_id = application.id
               AND release.organization_id = application.organization_id
               AND release.league_id = application.league_id) AS release_count,
           EXISTS (
             SELECT 1 FROM weekly_payment_allocation_releases release
              WHERE release.funding_application_id = application.id
                AND release.organization_id = application.organization_id
                AND release.league_id = application.league_id
                AND release.payment_id = application.payment_id
                AND release.credited_bowler_id = application.credited_bowler_id
                AND release.source_allocation_id = allocation.id
                AND release.source_obligation_id = application.obligation_id
                AND release.source_application_amount_minor = application.amount_minor
                AND release.released_amount_minor = application.amount_minor
                AND release.retained_amount_minor = 0
                AND release.replacement_allocation_id IS NULL
                AND release.currency = application.currency
           ) AS valid_release,
           confirmation.id AS confirmed_week_id,
           adoption.id AS adoption_id,
           occurrence.authoritative_local_date,
           assignment.id AS matched_assignment_id
      FROM payment_allocation_funding_applications application
      JOIN payment_allocations allocation
        ON allocation.id = application.allocation_id
       AND allocation.organization_id = application.organization_id
       AND allocation.league_id = application.league_id
      JOIN payment_obligations obligation
        ON obligation.id = application.obligation_id
       AND obligation.organization_id = application.organization_id
       AND obligation.league_id = application.league_id
       AND obligation.responsibility_id = application.responsibility_id
      JOIN occurrence_payment_responsibilities responsibility
        ON responsibility.id = application.responsibility_id
       AND responsibility.organization_id = application.organization_id
       AND responsibility.league_id = application.league_id
       AND responsibility.occurrence_id = application.occurrence_id
       AND responsibility.team_id = application.team_id
      JOIN league_occurrences occurrence
        ON occurrence.id = application.occurrence_id
       AND occurrence.organization_id = application.organization_id
       AND occurrence.league_id = application.league_id
      LEFT JOIN LATERAL (
        SELECT revision.owner_kind, revision.owner_bowler_id, revision.owner_team_id
          FROM payment_obligation_owner_revisions revision
         WHERE revision.obligation_id = application.obligation_id
           AND revision.organization_id = application.organization_id
           AND revision.league_id = application.league_id
         ORDER BY revision.revision_number DESC, revision.id ASC
         LIMIT 1
      ) owner ON true
      LEFT JOIN rotating_occurrence_assignments assignment
        ON assignment.id = application.assignment_id
       AND assignment.organization_id = application.organization_id
       AND assignment.league_id = application.league_id
       AND assignment.occurrence_id = application.occurrence_id
       AND assignment.team_id = application.team_id
       AND assignment.responsibility_id = application.responsibility_id
       AND assignment.actual_bowler_id = funding_row.bowler_id
      LEFT JOIN weekly_payment_week_confirmations confirmation
        ON confirmation.organization_id = application.organization_id
       AND confirmation.league_id = application.league_id
       AND confirmation.occurrence_id = application.occurrence_id
      LEFT JOIN weekly_payment_ledger_adoptions adoption
        ON adoption.organization_id = application.organization_id
       AND adoption.league_id = application.league_id
       AND occurrence.authoritative_local_date <= adoption.adopted_through_local_date
     WHERE application.rotating_funding_id = funding_row.id
       AND application.organization_id = funding_row.organization_id
       AND application.league_id = funding_row.league_id
     ORDER BY application.created_at, application.id
  LOOP
    IF typed_application_row.payment_id <> funding_row.payment_id
       OR typed_application_row.credited_bowler_id <> funding_row.bowler_id
       OR typed_application_row.generic_funding_id IS NOT NULL
       OR typed_application_row.rotating_funding_id <> funding_row.id
       OR typed_application_row.source_amount_minor <> funding_row.amount_minor
       OR typed_application_row.amount_minor <= 0
       OR typed_application_row.amount_minor <> typed_application_row.allocation_amount_minor
       OR typed_application_row.currency <> funding_row.currency
       OR typed_application_row.allocation_currency <> funding_row.currency
       OR typed_application_row.allocation_kind <> 'rotating_credit'
       OR typed_application_row.allocation_payment_id <> funding_row.payment_id
       OR typed_application_row.allocation_obligation_id <> typed_application_row.obligation_id
       OR typed_application_row.review_required
       OR typed_application_row.release_count <> (CASE WHEN typed_application_row.allocation_state = 'active' THEN 0 ELSE 1 END)
       OR (typed_application_row.allocation_state = 'voided' AND NOT typed_application_row.valid_release)
       OR typed_application_row.allocation_state NOT IN ('active', 'voided')
       OR (typed_application_row.target_kind = 'bowler_responsibility' AND (
         typed_application_row.target_payer_bowler_id IS NULL
         OR typed_application_row.assignment_id IS NOT NULL
         OR typed_application_row.responsibility_payer_bowler_id IS DISTINCT FROM typed_application_row.target_payer_bowler_id
         OR typed_application_row.payer_bowler_id IS DISTINCT FROM typed_application_row.target_payer_bowler_id
         OR coalesce(typed_application_row.owner_kind, 'bowler') <> 'bowler'
         OR coalesce(typed_application_row.owner_bowler_id, typed_application_row.payer_bowler_id) <> funding_row.bowler_id
       ))
       OR (typed_application_row.target_kind = 'legacy_team_assignment' AND (
         typed_application_row.target_payer_bowler_id IS NOT NULL
         OR typed_application_row.assignment_id IS NULL
         OR typed_application_row.matched_assignment_id IS NULL
         OR typed_application_row.assignment_actual_bowler_id <> funding_row.bowler_id
         OR coalesce(typed_application_row.owner_kind, '') <> 'team'
         OR typed_application_row.owner_team_id <> typed_application_row.team_id
         OR (typed_application_row.allocation_state = 'active' AND NOT EXISTS (
           SELECT 1 FROM rotating_occurrence_assignments latest
            WHERE latest.id = typed_application_row.assignment_id
              AND latest.version = (
                SELECT max(next_assignment.version)
                  FROM rotating_occurrence_assignments next_assignment
                 WHERE next_assignment.organization_id = latest.organization_id
                   AND next_assignment.league_id = latest.league_id
                   AND next_assignment.occurrence_id = latest.occurrence_id
                   AND next_assignment.team_id = latest.team_id
                   AND next_assignment.slot_index = latest.slot_index
              )
         ))
       ))
       OR typed_application_row.target_kind NOT IN ('bowler_responsibility', 'legacy_team_assignment')
       OR (typed_application_row.confirmed_week_id IS NULL AND (
         typed_application_row.adoption_id IS NULL
       ))
    THEN
      RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_funding_ledger_guard',
        MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: rotating_funding_application_identity';
    END IF;
    IF typed_application_row.allocation_state = 'active' THEN
      IF typed_application_row.release_count <> 0 THEN
        RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_funding_ledger_guard',
          MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: rotating_funding_active_release';
      END IF;
      applied_minor := applied_minor + typed_application_row.amount_minor;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM rotating_credit_refund_operation_snapshots snapshot
     WHERE snapshot.funding_id = funding_row.id
       AND snapshot.organization_id = funding_row.organization_id
       AND snapshot.league_id = funding_row.league_id
       AND NOT EXISTS (
         SELECT 1 FROM rotating_credit_refunds refund
          WHERE refund.refund_operation_id = snapshot.operation_id
            AND refund.funding_id = snapshot.funding_id
            AND refund.organization_id = snapshot.organization_id
            AND refund.league_id = snapshot.league_id
       )
  ) THEN
    RAISE EXCEPTION 'rotating credit refund snapshot is missing its refund ledger entry';
  END IF;

  FOR refund_row IN
    SELECT refund.id, refund.organization_id, refund.league_id, refund.funding_id,
           refund.payment_id, refund.bowler_id, refund.amount_minor, refund.currency,
           refund.refund_kind, refund.refund_operation_id, refund.reference, refund.reason,
           refund.actor_user_id, refund.idempotency_key,
           refund.issued_at, operation.id AS operation_id,
           operation.operation_type, operation.status AS operation_status,
           operation.amount_minor AS operation_amount_minor,
           operation.currency AS operation_currency,
           operation.error_classification,
           operation.error_code,
           operation.authorizing_user_id,
           operation.provider_name,
           operation.target_key,
           operation.provider_object_id,
           snapshot.operation_id AS snapshot_operation_id,
           snapshot.funding_id AS snapshot_funding_id,
           snapshot.payment_id AS snapshot_payment_id,
           snapshot.bowler_id AS snapshot_bowler_id,
           snapshot.amount_minor AS snapshot_amount_minor,
           snapshot.currency AS snapshot_currency,
           snapshot.provider_payment_id AS snapshot_provider_payment_id,
           snapshot.location_id AS snapshot_location_id,
           snapshot.reason AS snapshot_reason
      FROM rotating_credit_refunds refund
      LEFT JOIN payment_operations operation
        ON operation.id = refund.refund_operation_id
       AND operation.organization_id = refund.organization_id
       AND operation.league_id = refund.league_id
      LEFT JOIN rotating_credit_refund_operation_snapshots snapshot
        ON snapshot.operation_id = refund.refund_operation_id
       AND snapshot.organization_id = refund.organization_id
       AND snapshot.league_id = refund.league_id
     WHERE refund.funding_id = funding_row.id
       AND refund.organization_id = funding_row.organization_id
       AND refund.league_id = funding_row.league_id
     ORDER BY refund.id
  LOOP
    IF refund_row.payment_id <> funding_row.payment_id
       OR refund_row.bowler_id <> funding_row.bowler_id
       OR refund_row.amount_minor <= 0
       OR refund_row.currency <> funding_row.currency
    THEN
      RAISE EXCEPTION 'rotating credit refund does not match its funding lot';
    END IF;
    IF refund_row.refund_kind IN ('cash', 'check') THEN
      IF refund_row.refund_operation_id IS NOT NULL
         OR refund_row.issued_at IS NULL
         OR refund_row.reference IS NULL
         OR length(btrim(refund_row.reference)) NOT BETWEEN 1 AND 255
      THEN
        RAISE EXCEPTION 'manual rotating credit refund is missing issuance evidence';
      END IF;
      refund_minor := refund_minor + refund_row.amount_minor;
    ELSE
      IF refund_row.refund_kind <> 'provider'
         OR refund_row.refund_operation_id IS NULL
         OR refund_row.issued_at IS NOT NULL
         OR refund_row.reference IS NOT NULL
         OR refund_row.operation_id IS NULL
         OR refund_row.snapshot_operation_id IS NULL
         OR refund_row.operation_type IS DISTINCT FROM 'refund'
         OR refund_row.authorizing_user_id IS DISTINCT FROM refund_row.actor_user_id
         OR refund_row.provider_name IS DISTINCT FROM 'square'
         OR refund_row.target_key NOT LIKE ('rotating-credit-refund:' || funding_row.id::text || ':%')
         OR length(refund_row.target_key) <> length('rotating-credit-refund:' || funding_row.id::text || ':') + 64
         OR substring(refund_row.target_key FROM length('rotating-credit-refund:' || funding_row.id::text || ':') + 1) !~ '^[0-9a-f]{64}$'
         OR refund_row.operation_amount_minor IS DISTINCT FROM refund_row.amount_minor
         OR refund_row.operation_currency IS DISTINCT FROM refund_row.currency
         OR refund_row.snapshot_funding_id IS DISTINCT FROM funding_row.id
         OR refund_row.snapshot_payment_id IS DISTINCT FROM funding_row.payment_id
         OR refund_row.snapshot_bowler_id IS DISTINCT FROM funding_row.bowler_id
         OR refund_row.snapshot_amount_minor IS DISTINCT FROM refund_row.amount_minor
         OR refund_row.snapshot_currency IS DISTINCT FROM refund_row.currency
         OR refund_row.snapshot_provider_payment_id IS DISTINCT FROM funding_row.provider_payment_id
         OR refund_row.snapshot_location_id IS NULL
         OR refund_row.snapshot_location_id IS DISTINCT FROM funding_row.league_location_id
         OR refund_row.snapshot_reason IS DISTINCT FROM refund_row.reason
      THEN
        RAISE EXCEPTION 'provider rotating credit refund does not match its immutable refund snapshot';
      END IF;
      IF refund_row.operation_status IN ('pending', 'leased', 'provider_unknown', 'retry_scheduled', 'reconciliation_required') THEN
        refund_minor := refund_minor + refund_row.amount_minor;
      ELSIF refund_row.operation_status = 'action_required' THEN
        IF refund_row.provider_object_id IS NOT NULL
           OR refund_row.error_classification IS DISTINCT FROM 'hard_decline'
           OR refund_row.error_code IS DISTINCT FROM 'REFUND_DECLINED' THEN
          -- A new-request hard decline without a Square refund object is a
          -- definitive no-effect outcome. Any weaker or contradictory
          -- action-required evidence remains held for review.
          refund_minor := refund_minor + refund_row.amount_minor;
        END IF;
      ELSIF refund_row.operation_status = 'succeeded' THEN
        IF refund_row.provider_object_id IS NULL THEN
          RAISE EXCEPTION 'completed provider credit refund is missing its provider identity';
        END IF;
        refund_minor := refund_minor + refund_row.amount_minor;
      ELSIF refund_row.operation_status = 'failed_terminal' THEN
        IF refund_row.provider_object_id IS NOT NULL
           AND (
             refund_row.error_classification IS DISTINCT FROM 'invalid_request'
             OR (
               refund_row.error_code IS DISTINCT FROM 'REFUND_REJECTED'
               AND refund_row.error_code IS DISTINCT FROM 'REFUND_FAILED'
             )
           ) THEN
          -- A terminal row with an unidentified provider object is still
          -- retained as a review hold. Square's explicit REJECTED/FAILED
          -- outcomes are certain and mean no refund was issued.
          refund_minor := refund_minor + refund_row.amount_minor;
        END IF;
      ELSIF refund_row.operation_status = 'canceled' THEN
        IF refund_row.provider_object_id IS NOT NULL THEN
          refund_minor := refund_minor + refund_row.amount_minor;
        END IF;
      ELSE
        RAISE EXCEPTION 'provider credit refund has unsupported outcome evidence';
      END IF;
    END IF;
  END LOOP;

  IF manual_receipt_correction AND refund_minor > 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'PWL01', CONSTRAINT = 'owned_payment_funding_release_guard',
      MESSAGE = 'LV_WEEKLY_LEDGER_INVARIANT: rotating_manual_receipt_has_refund';
  END IF;
  IF applied_minor + refund_minor > funding_row.amount_minor THEN
    RAISE EXCEPTION 'rotating credit applications and refunds exceed the original funding amount';
  END IF;
END;
$$;--> statement-breakpoint
-- Preserve the legacy ordinary-tender conservation path unless a payment has
-- explicit owned funding portions; those use the account-source assertion.
CREATE OR REPLACE FUNCTION roster_payment_allocation_conservation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_payment_id integer;
  parent_organization_id integer;
  parent_league_id integer;
  parent_amount integer;
  parent_status text;
  parent_currency text;
  parent_provider_id text;
  parent_operation_id uuid;
  operation_row record;
  allocation_count integer;
  active_count integer;
  voided_count integer;
  allocation_total bigint;
  active_allocation_total bigint;
  has_void boolean;
  has_credit_funding boolean;
  obligation_row record;
  obligation_total bigint;
BEGIN
  IF TG_TABLE_NAME = 'payments' THEN
    parent_payment_id := (to_jsonb(NEW)->>'id')::integer;
  ELSIF TG_TABLE_NAME = 'payment_voids' THEN
    parent_payment_id := (to_jsonb(NEW)->>'payment_id')::integer;
  ELSE
    parent_payment_id := COALESCE((to_jsonb(NEW)->>'payment_id')::integer, (to_jsonb(OLD)->>'payment_id')::integer);
  END IF;
  SELECT organization_id, league_id
    INTO parent_organization_id, parent_league_id
    FROM payments
   WHERE id = parent_payment_id;
  IF parent_organization_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM weekly_payment_fundings funding
     WHERE funding.organization_id = parent_organization_id
       AND funding.league_id = parent_league_id
       AND funding.payment_id = parent_payment_id
  ) THEN
    PERFORM assert_owned_payment_source_applications(parent_organization_id, parent_league_id, parent_payment_id);
    RETURN COALESCE(NEW, OLD);
  END IF;
  SELECT amount, status, currency, provider_payment_id, payment_operation_id
    INTO parent_amount, parent_status, parent_currency, parent_provider_id, parent_operation_id
    FROM payments
   WHERE id = parent_payment_id
   FOR UPDATE;
  IF parent_amount IS NULL THEN
    RAISE EXCEPTION 'allocation payment is missing from its tenant scope';
  END IF;
  IF parent_operation_id IS NOT NULL THEN
    SELECT operation_type, amount_minor, currency, provider_object_id
      INTO operation_row
      FROM payment_operations WHERE id = parent_operation_id FOR SHARE;
    IF operation_row IS NULL
      OR operation_row.operation_type NOT IN ('interactive_charge', 'standing_autopay_charge')
      OR operation_row.amount_minor <> parent_amount
      OR operation_row.currency <> parent_currency
      OR operation_row.provider_object_id IS NULL
      OR operation_row.provider_object_id <> parent_provider_id
    THEN
      RAISE EXCEPTION 'payment operation evidence does not match its tender parent';
    END IF;
  END IF;
  SELECT EXISTS (SELECT 1 FROM payment_voids WHERE payment_id = parent_payment_id)
    INTO has_void;
  SELECT EXISTS (SELECT 1 FROM rotating_credit_fundings WHERE payment_id = parent_payment_id)
    INTO has_credit_funding;
  SELECT count(*), count(*) FILTER (WHERE state = 'active'),
         count(*) FILTER (WHERE state = 'voided'),
         COALESCE(sum(amount_minor), 0),
         COALESCE(sum(amount_minor) FILTER (WHERE state = 'active'), 0)
    INTO allocation_count, active_count, voided_count, allocation_total, active_allocation_total
    FROM payment_allocations
   WHERE payment_id = parent_payment_id;
  IF has_credit_funding THEN
    PERFORM rotating_credit_assert_ledger(parent_payment_id);
    IF (has_void OR parent_status = 'voided')
       AND NOT rotating_credit_is_audited_manual_correction(parent_payment_id) THEN
      RAISE EXCEPTION 'rotating credit funding cannot be voided as an ordinary tender';
    END IF;
  ELSE
    IF EXISTS (
      SELECT 1
        FROM payment_allocations allocation
        LEFT JOIN rotating_credit_applications application
          ON application.allocation_id = allocation.id
         AND application.organization_id = allocation.organization_id
         AND application.league_id = allocation.league_id
       WHERE allocation.payment_id = parent_payment_id
         AND (allocation.allocation_kind <> 'ordinary' OR application.id IS NOT NULL)
    ) THEN
      RAISE EXCEPTION 'ordinary tender allocation cannot claim rotating credit application evidence';
    END IF;
    IF allocation_count = 0 THEN
      RAISE EXCEPTION 'payment % must have at least one allocation', parent_payment_id;
    END IF;
    IF has_void THEN
      IF allocation_total <> parent_amount THEN
        RAISE EXCEPTION 'voided payment allocation total (%) must equal parent payment amount (%)', allocation_total, parent_amount;
      END IF;
    ELSIF active_allocation_total <> parent_amount THEN
      RAISE EXCEPTION 'active payment allocation total (%) must equal parent payment amount (%)', active_allocation_total, parent_amount;
    END IF;
  END IF;
  FOR obligation_row IN
    SELECT po.id, po.organization_id, po.league_id, po.amount_minor
      FROM payment_obligations po
      JOIN payment_allocations touched
        ON touched.obligation_id = po.id
       AND touched.organization_id = po.organization_id
       AND touched.league_id = po.league_id
       AND touched.payment_id = parent_payment_id
     ORDER BY po.organization_id, po.league_id, po.id
       FOR UPDATE
  LOOP
    SELECT COALESCE(SUM(pa.amount_minor), 0) - COALESCE((
      SELECT SUM(raa.amount_minor)
        FROM refund_allocation_adjustments raa
        JOIN payment_allocations source
          ON source.id = raa.source_allocation_id
         AND source.organization_id = raa.organization_id
         AND source.league_id = raa.league_id
       WHERE raa.organization_id = obligation_row.organization_id
         AND raa.league_id = obligation_row.league_id
         AND source.obligation_id = obligation_row.id
         AND source.state = 'active'
         AND raa.disposition = 'still_owed'
    ), 0)
      INTO obligation_total
      FROM payment_allocations pa
     WHERE pa.obligation_id = obligation_row.id
       AND pa.organization_id = obligation_row.organization_id
       AND pa.league_id = obligation_row.league_id
       AND pa.state = 'active';
    IF obligation_total > obligation_row.amount_minor THEN
      RAISE EXCEPTION 'payment allocations exceed an obligation balance';
    END IF;
  END LOOP;
  IF has_credit_funding THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF has_void THEN
    IF parent_status <> 'voided' OR active_count <> 0 OR voided_count <> allocation_count THEN
      RAISE EXCEPTION 'voided payment % must have all allocations voided', parent_payment_id;
    END IF;
  ELSIF parent_status = 'voided' THEN
    RAISE EXCEPTION 'voided payment % must have payment void evidence', parent_payment_id;
  ELSIF active_count <> allocation_count THEN
    IF EXISTS (
      SELECT 1
        FROM payment_allocations source
        LEFT JOIN payment_allocation_corrections correction
          ON correction.source_allocation_id = source.id
         AND correction.organization_id = source.organization_id
         AND correction.league_id = source.league_id
         AND correction.payment_id = source.payment_id
        LEFT JOIN payment_allocations replacement
          ON replacement.id = correction.replacement_allocation_id
         AND replacement.organization_id = correction.organization_id
         AND replacement.league_id = correction.league_id
       WHERE source.payment_id = parent_payment_id
         AND source.state = 'voided'
         AND source.allocation_kind = 'ordinary'
         AND (correction.id IS NULL
           OR correction.amount_minor <> source.amount_minor
           OR correction.currency <> source.currency
           OR correction.source_obligation_id <> source.obligation_id
           OR replacement.id IS NULL
           OR replacement.payment_id <> parent_payment_id
           OR replacement.state <> 'active'
           OR replacement.allocation_kind <> 'ordinary'
           OR replacement.amount_minor <> source.amount_minor
           OR replacement.currency <> source.currency)
    ) THEN
      RAISE EXCEPTION 'active payment % has unproved voided allocation evidence', parent_payment_id;
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
--> statement-breakpoint
