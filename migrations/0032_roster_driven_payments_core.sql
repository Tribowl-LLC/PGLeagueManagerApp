-- PR1 clean-slate roster-driven payments.
-- Historical payments, refunds, disputes, operation ledger, operation snapshots,
-- canonical schedule, and canonical collection groups are retained. The
-- abandoned F1/D2/F3/F4 financial authorities below are removed only after a
-- zero-row evidence gate. There is deliberately no data migration or legacy
-- balance fallback.
DO $$
DECLARE
  abandoned text[] := ARRAY[
    'financial_activation_cancellation_suppressions',
    'financial_responsibilities',
    'financial_activation_revisions',
    'financial_activations',
    'f3_autopay_plan_provenance',
    'f3_payer_authorization_revisions',
    'f3_payer_autopay_authorizations',
    'f3_collection_policy_revisions',
    'f3_collection_policy_occurrences',
    'f3_collection_policies',
    'payment_occurrence_allocation_revisions',
    'payment_occurrence_allocations',
    'payment_operation_occurrence_snapshot_allocations',
    'payment_operation_occurrence_snapshots',
    'occurrence_collection_plan_items',
    'occurrence_collection_plan_revisions',
    'occurrence_collection_plans',
    'bowler_occurrence_obligation_revisions',
    'bowler_occurrence_obligations',
    'bowler_occurrence_eligibility_revisions',
    'bowler_occurrence_eligibilities',
    'bowler_occurrence_team_assignment_revisions',
    'bowler_occurrence_team_assignments',
    'canonical_autopay_execution_snapshots'
  ];
  table_name text;
  row_count bigint;
BEGIN
  FOREACH table_name IN ARRAY abandoned LOOP
    IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
      -- SERIALIZABLE migration gate: block inserts/deletes that could race
      -- the evidence check while this migration drops the authority.
      EXECUTE format('LOCK TABLE public.%I IN SHARE ROW EXCLUSIVE MODE', table_name);
      EXECUTE format('SELECT count(*) FROM public.%I', table_name) INTO row_count;
      IF row_count <> 0 THEN
        RAISE EXCEPTION '0032 refused: abandoned canonical financial evidence table % contains % rows', table_name, row_count;
      END IF;
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint

-- Remove external references before dropping the old authorities. These are
-- the only retained-ledger references to D2/F4 identity.
ALTER TABLE IF EXISTS payment_operations DROP CONSTRAINT IF EXISTS payment_operations_canonical_plan_tenant_fk;
DROP INDEX IF EXISTS payment_operations_canonical_plan_idx;
DROP INDEX IF EXISTS payment_operations_canonical_plan_unique;
DROP INDEX IF EXISTS payment_operations_canonical_target_unique;
CREATE UNIQUE INDEX IF NOT EXISTS payments_id_league_unique ON payments(id, league_id);
CREATE UNIQUE INDEX IF NOT EXISTS payment_operations_id_org_league_unique ON payment_operations(id, organization_id, league_id);
--> statement-breakpoint

-- Roster interactive charges are exact league-scoped operations. The
-- pre-PR1 constraint treated every interactive operation as league-less;
-- retain that shape for refunds while permitting the new canonical league
-- linkage (canonical_plan_id remains reserved for dormant PR2).
ALTER TABLE payment_operations DROP CONSTRAINT IF EXISTS payment_operations_scheduled_cycle_check;
ALTER TABLE payment_operations ADD CONSTRAINT payment_operations_scheduled_cycle_check CHECK (
  (operation_type = 'scheduled_charge' AND payment_schedule_id IS NOT NULL AND billing_cycle_at IS NOT NULL)
  OR (operation_type = 'canonical_autopay_charge' AND payment_schedule_id IS NULL AND billing_cycle_at IS NULL AND league_id IS NOT NULL AND canonical_plan_id IS NOT NULL AND authorizing_user_id IS NOT NULL)
  OR (operation_type IN ('interactive_charge', 'refund') AND payment_schedule_id IS NULL AND billing_cycle_at IS NULL AND canonical_plan_id IS NULL)
);
--> statement-breakpoint

-- Dependency-safe retirement: children/revisions first, then their authority.
-- D2 also installed deferred triggers on the retained scheduled/interactive
-- operation snapshots. Remove those trigger hooks before retiring the shared
-- validation function; otherwise a normal retained webhook update would
-- execute SQL against the dropped occurrence snapshot tables.
DROP TRIGGER IF EXISTS payment_occurrence_scheduled_base_snapshot_consistency ON scheduled_payment_operation_snapshots;
DROP TRIGGER IF EXISTS payment_occurrence_interactive_base_snapshot_consistency ON interactive_payment_operation_snapshots;
DROP TRIGGER IF EXISTS payment_occurrence_snapshots_total ON payment_operation_occurrence_snapshots;
DROP TRIGGER IF EXISTS payment_occurrence_snapshot_allocations_total ON payment_operation_occurrence_snapshot_allocations;
DROP FUNCTION IF EXISTS enforce_payment_occurrence_snapshot_total() CASCADE;
DROP TABLE IF EXISTS canonical_autopay_execution_snapshots;
DROP TABLE IF EXISTS f3_autopay_plan_provenance;
DROP TABLE IF EXISTS f3_payer_authorization_revisions;
DROP TABLE IF EXISTS f3_payer_autopay_authorizations;
DROP TABLE IF EXISTS f3_collection_policy_revisions;
DROP TABLE IF EXISTS f3_collection_policy_occurrences;
DROP TABLE IF EXISTS f3_collection_policies;
DROP TABLE IF EXISTS financial_activation_cancellation_suppressions;
DROP TABLE IF EXISTS financial_responsibilities;
DROP TABLE IF EXISTS financial_activation_revisions;
DROP TABLE IF EXISTS financial_activations;
DROP TABLE IF EXISTS payment_operation_occurrence_snapshot_allocations;
DROP TABLE IF EXISTS payment_operation_occurrence_snapshots;
DROP TABLE IF EXISTS payment_occurrence_allocation_revisions;
DROP TABLE IF EXISTS payment_occurrence_allocations;
DROP TABLE IF EXISTS occurrence_collection_plan_items;
DROP TABLE IF EXISTS occurrence_collection_plan_revisions;
DROP TABLE IF EXISTS occurrence_collection_plans;
DROP TABLE IF EXISTS bowler_occurrence_obligation_revisions;
DROP TABLE IF EXISTS bowler_occurrence_obligations;
DROP TABLE IF EXISTS bowler_occurrence_eligibility_revisions;
DROP TABLE IF EXISTS bowler_occurrence_eligibilities;
DROP TABLE IF EXISTS bowler_occurrence_team_assignment_revisions;
DROP TABLE IF EXISTS bowler_occurrence_team_assignments;
DROP FUNCTION IF EXISTS f3_json_array_shape(jsonb, text);
--> statement-breakpoint

-- The roster is the sole payment responsibility surface. Keep these choices
-- on the league setup row so their first canonical occurrence can lock the
-- effective values without reviving an activation entity.
ALTER TABLE leagues ADD COLUMN IF NOT EXISTS substitute_access text NOT NULL DEFAULT 'team_only';
ALTER TABLE leagues ADD COLUMN IF NOT EXISTS substitute_payment_regime text NOT NULL DEFAULT 'team_choice';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leagues_substitute_access_check') THEN
    ALTER TABLE leagues ADD CONSTRAINT leagues_substitute_access_check CHECK (substitute_access IN ('team_only', 'floating'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leagues_substitute_payment_regime_check') THEN
    ALTER TABLE leagues ADD CONSTRAINT leagues_substitute_payment_regime_check CHECK (substitute_payment_regime IN ('team_choice', 'league_lineage_prize_split'));
  END IF;
END $$;
--> statement-breakpoint

CREATE TABLE team_payment_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  league_id integer NOT NULL,
  team_id integer NOT NULL,
  slot_index integer NOT NULL,
  lineup_size integer NOT NULL,
  occupant text NOT NULL DEFAULT 'unassigned',
  main_bowler_id integer,
  current_revision integer NOT NULL DEFAULT 1,
  recorded_by_user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT team_payment_slots_league_tenant_fk FOREIGN KEY (league_id, organization_id) REFERENCES leagues(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT team_payment_slots_team_fk FOREIGN KEY (team_id, league_id) REFERENCES teams(id, league_id) ON DELETE RESTRICT,
  CONSTRAINT team_payment_slots_bowler_fk FOREIGN KEY (main_bowler_id, organization_id) REFERENCES bowlers(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT team_payment_slots_slot_check CHECK (slot_index >= 0 AND slot_index < lineup_size AND lineup_size IN (3, 4)),
  CONSTRAINT team_payment_slots_occupant_check CHECK (occupant IN ('unassigned', 'main', 'vacant') AND ((occupant = 'main' AND main_bowler_id IS NOT NULL) OR (occupant <> 'main' AND main_bowler_id IS NULL))),
  CONSTRAINT team_payment_slots_revision_check CHECK (current_revision > 0)
);
CREATE UNIQUE INDEX team_payment_slots_tenant_identity_unique ON team_payment_slots(id, organization_id, league_id);
CREATE UNIQUE INDEX team_payment_slots_slot_identity_unique ON team_payment_slots(id, organization_id, league_id, team_id, slot_index);
CREATE UNIQUE INDEX team_payment_slots_team_slot_unique ON team_payment_slots(organization_id, league_id, team_id, slot_index);
CREATE UNIQUE INDEX team_payment_slots_main_bowler_unique ON team_payment_slots(organization_id, league_id, main_bowler_id) WHERE occupant = 'main' AND main_bowler_id IS NOT NULL;
--> statement-breakpoint

CREATE TABLE team_payment_slot_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  league_id integer NOT NULL,
  slot_id uuid NOT NULL,
  revision_number integer NOT NULL,
  before_snapshot jsonb,
  after_snapshot jsonb NOT NULL,
  recorded_by_user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT team_payment_slot_revisions_parent_fk FOREIGN KEY (slot_id, organization_id, league_id) REFERENCES team_payment_slots(id, organization_id, league_id) ON DELETE RESTRICT,
  CONSTRAINT team_payment_slot_revisions_revision_check CHECK (revision_number > 0 AND ((revision_number = 1 AND before_snapshot IS NULL) OR (revision_number > 1 AND before_snapshot IS NOT NULL)) )
);
CREATE UNIQUE INDEX team_payment_slot_revisions_unique ON team_payment_slot_revisions(organization_id, league_id, slot_id, revision_number);
--> statement-breakpoint

CREATE TABLE team_payment_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  league_id integer NOT NULL,
  team_id integer NOT NULL,
  default_policy text NOT NULL DEFAULT 'main_pays_full',
  current_revision integer NOT NULL DEFAULT 1,
  recorded_by_user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT team_payment_policies_league_tenant_fk FOREIGN KEY (league_id, organization_id) REFERENCES leagues(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT team_payment_policies_team_fk FOREIGN KEY (team_id, league_id) REFERENCES teams(id, league_id) ON DELETE RESTRICT,
  CONSTRAINT team_payment_policies_policy_check CHECK (default_policy IN ('main_pays_full', 'sub_pays_full', 'special_split') AND current_revision > 0)
);
CREATE UNIQUE INDEX team_payment_policies_tenant_identity_unique ON team_payment_policies(id, organization_id, league_id);
CREATE UNIQUE INDEX team_payment_policies_team_unique ON team_payment_policies(organization_id, league_id, team_id);
--> statement-breakpoint

CREATE TABLE team_payment_policy_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  league_id integer NOT NULL,
  policy_id uuid NOT NULL,
  revision_number integer NOT NULL,
  before_snapshot jsonb,
  after_snapshot jsonb NOT NULL,
  recorded_by_user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT team_payment_policy_revisions_parent_fk FOREIGN KEY (policy_id, organization_id, league_id) REFERENCES team_payment_policies(id, organization_id, league_id) ON DELETE RESTRICT,
  CONSTRAINT team_payment_policy_revisions_revision_check CHECK (revision_number > 0 AND ((revision_number = 1 AND before_snapshot IS NULL) OR (revision_number > 1 AND before_snapshot IS NOT NULL)) )
);
CREATE UNIQUE INDEX team_payment_policy_revisions_unique ON team_payment_policy_revisions(organization_id, league_id, policy_id, revision_number);
--> statement-breakpoint

CREATE TABLE occurrence_payment_responsibilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  league_id integer NOT NULL,
  occurrence_id uuid NOT NULL,
  team_id integer NOT NULL,
  slot_id uuid NOT NULL,
  slot_index integer NOT NULL,
  position_index integer NOT NULL,
  responsibility_key uuid NOT NULL DEFAULT gen_random_uuid(),
  version integer NOT NULL DEFAULT 1,
  state text NOT NULL DEFAULT 'active',
  responsibility_kind text NOT NULL,
  main_bowler_id integer,
  substitute_bowler_id integer,
  payer_bowler_id integer,
  lineage_payer_bowler_id integer,
  prize_payer_bowler_id integer,
  policy text NOT NULL,
  amount_minor integer NOT NULL,
  lineage_amount_minor integer,
  prize_fund_amount_minor integer,
  currency varchar(3) NOT NULL DEFAULT 'USD',
  due_at timestamptz NOT NULL,
  past_due_at timestamptz NOT NULL,
  assignment_note text,
  recorded_by_user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT occurrence_payment_responsibilities_league_tenant_fk FOREIGN KEY (league_id, organization_id) REFERENCES leagues(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT occurrence_payment_responsibilities_occurrence_fk FOREIGN KEY (occurrence_id, organization_id, league_id) REFERENCES league_occurrences(id, organization_id, league_id) ON DELETE RESTRICT,
  CONSTRAINT occurrence_payment_responsibilities_team_fk FOREIGN KEY (team_id, league_id) REFERENCES teams(id, league_id) ON DELETE RESTRICT,
  CONSTRAINT occurrence_payment_responsibilities_slot_fk FOREIGN KEY (slot_id, organization_id, league_id, team_id, slot_index) REFERENCES team_payment_slots(id, organization_id, league_id, team_id, slot_index) ON DELETE RESTRICT,
  CONSTRAINT occurrence_payment_responsibilities_main_fk FOREIGN KEY (main_bowler_id, organization_id) REFERENCES bowlers(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT occurrence_payment_responsibilities_substitute_fk FOREIGN KEY (substitute_bowler_id, organization_id) REFERENCES bowlers(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT occurrence_payment_responsibilities_payer_fk FOREIGN KEY (payer_bowler_id, organization_id) REFERENCES bowlers(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT occurrence_payment_responsibilities_lineage_payer_fk FOREIGN KEY (lineage_payer_bowler_id, organization_id) REFERENCES bowlers(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT occurrence_payment_responsibilities_prize_payer_fk FOREIGN KEY (prize_payer_bowler_id, organization_id) REFERENCES bowlers(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT occurrence_payment_responsibilities_state_check CHECK (state IN ('active', 'voided') AND version > 0),
  CONSTRAINT occurrence_payment_responsibilities_position_check CHECK (slot_index >= 0 AND position_index >= 0 AND position_index < 4),
  CONSTRAINT occurrence_payment_responsibilities_kind_check CHECK (responsibility_kind IN ('main', 'substitute', 'split', 'vacant') AND ((responsibility_kind = 'vacant' AND main_bowler_id IS NULL AND substitute_bowler_id IS NULL AND payer_bowler_id IS NULL AND amount_minor = 0 AND lineage_amount_minor IS NULL AND prize_fund_amount_minor IS NULL) OR (responsibility_kind = 'main' AND main_bowler_id IS NOT NULL AND substitute_bowler_id IS NULL AND payer_bowler_id = main_bowler_id AND amount_minor > 0) OR (responsibility_kind = 'substitute' AND main_bowler_id IS NOT NULL AND substitute_bowler_id IS NOT NULL AND main_bowler_id <> substitute_bowler_id AND payer_bowler_id IS NOT NULL AND amount_minor > 0) OR (responsibility_kind = 'split' AND main_bowler_id IS NOT NULL AND substitute_bowler_id IS NOT NULL AND main_bowler_id <> substitute_bowler_id AND payer_bowler_id IS NOT NULL AND amount_minor > 0)) AND ((responsibility_kind = 'split' AND lineage_payer_bowler_id IS NOT NULL AND prize_payer_bowler_id IS NOT NULL AND lineage_amount_minor IS NOT NULL AND prize_fund_amount_minor IS NOT NULL AND lineage_amount_minor >= 0 AND prize_fund_amount_minor >= 0 AND lineage_amount_minor + prize_fund_amount_minor = amount_minor AND amount_minor > 0) OR (responsibility_kind <> 'split' AND lineage_payer_bowler_id IS NULL AND prize_payer_bowler_id IS NULL AND lineage_amount_minor IS NULL AND prize_fund_amount_minor IS NULL))),
  CONSTRAINT occurrence_payment_responsibilities_amount_check CHECK (amount_minor >= 0 AND currency = 'USD' AND past_due_at >= due_at)
);
CREATE UNIQUE INDEX occurrence_payment_responsibilities_version_unique ON occurrence_payment_responsibilities(organization_id, league_id, occurrence_id, team_id, slot_index, position_index, version);
CREATE UNIQUE INDEX occurrence_payment_responsibilities_slot_identity_unique ON occurrence_payment_responsibilities(id, organization_id, league_id, team_id, slot_index);
CREATE UNIQUE INDEX occurrence_payment_responsibilities_tenant_identity_unique ON occurrence_payment_responsibilities(id, organization_id, league_id);
CREATE UNIQUE INDEX occurrence_payment_responsibilities_current_unique ON occurrence_payment_responsibilities(organization_id, league_id, occurrence_id, team_id, slot_index, position_index) WHERE state = 'active';
CREATE UNIQUE INDEX occurrence_payment_responsibilities_key_unique ON occurrence_payment_responsibilities(organization_id, responsibility_key, version);
CREATE INDEX occurrence_payment_responsibilities_occurrence_idx ON occurrence_payment_responsibilities(organization_id, league_id, occurrence_id);
CREATE INDEX occurrence_payment_responsibilities_payer_idx ON occurrence_payment_responsibilities(organization_id, league_id, payer_bowler_id);
--> statement-breakpoint

CREATE TABLE payment_obligations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  league_id integer NOT NULL,
  occurrence_id uuid NOT NULL,
  responsibility_id uuid NOT NULL,
  component text NOT NULL DEFAULT 'full',
  payer_bowler_id integer NOT NULL,
  amount_minor integer NOT NULL,
  currency varchar(3) NOT NULL DEFAULT 'USD',
  due_at timestamptz NOT NULL,
  past_due_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'open',
  voided_at timestamptz,
  created_by_user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_obligations_league_tenant_fk FOREIGN KEY (league_id, organization_id) REFERENCES leagues(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT payment_obligations_occurrence_fk FOREIGN KEY (occurrence_id, organization_id, league_id) REFERENCES league_occurrences(id, organization_id, league_id) ON DELETE RESTRICT,
  CONSTRAINT payment_obligations_responsibility_fk FOREIGN KEY (responsibility_id, organization_id, league_id) REFERENCES occurrence_payment_responsibilities(id, organization_id, league_id) ON DELETE RESTRICT,
  CONSTRAINT payment_obligations_payer_fk FOREIGN KEY (payer_bowler_id, organization_id) REFERENCES bowlers(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT payment_obligations_state_check CHECK (state IN ('open', 'partially_settled', 'settled', 'voided') AND component IN ('full', 'lineage', 'prize') AND ((state = 'voided' AND voided_at IS NOT NULL) OR (state <> 'voided' AND voided_at IS NULL))),
  CONSTRAINT payment_obligations_amount_check CHECK (amount_minor > 0 AND currency = 'USD' AND past_due_at >= due_at)
);
CREATE UNIQUE INDEX payment_obligations_tenant_identity_unique ON payment_obligations(id, organization_id, league_id);
CREATE UNIQUE INDEX payment_obligations_responsibility_unique ON payment_obligations(organization_id, league_id, responsibility_id, component);
CREATE INDEX payment_obligations_open_idx ON payment_obligations(organization_id, league_id, state, due_at);
CREATE INDEX payment_obligations_payer_idx ON payment_obligations(organization_id, league_id, payer_bowler_id, state);
--> statement-breakpoint

CREATE TABLE payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  league_id integer NOT NULL,
  payment_id integer NOT NULL,
  obligation_id uuid NOT NULL,
  amount_minor integer NOT NULL,
  currency varchar(3) NOT NULL DEFAULT 'USD',
  state text NOT NULL DEFAULT 'active',
  supersedes_allocation_id uuid,
  correction_reason text,
  review_required boolean NOT NULL DEFAULT false,
  review_reason text,
  recorded_by_user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_allocations_tenant_identity_unique UNIQUE (id, organization_id, league_id),
  CONSTRAINT payment_allocations_league_tenant_fk FOREIGN KEY (league_id, organization_id) REFERENCES leagues(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT payment_allocations_payment_fk FOREIGN KEY (payment_id, league_id) REFERENCES payments(id, league_id) ON DELETE RESTRICT,
  CONSTRAINT payment_allocations_obligation_fk FOREIGN KEY (obligation_id, organization_id, league_id) REFERENCES payment_obligations(id, organization_id, league_id) ON DELETE RESTRICT,
  CONSTRAINT payment_allocations_supersedes_fk FOREIGN KEY (supersedes_allocation_id, organization_id, league_id) REFERENCES payment_allocations(id, organization_id, league_id) ON DELETE RESTRICT,
  CONSTRAINT payment_allocations_amount_check CHECK (amount_minor > 0 AND currency = 'USD'),
  CONSTRAINT payment_allocations_state_check CHECK (state IN ('active', 'voided') AND (state = 'voided' OR supersedes_allocation_id IS NULL OR correction_reason IS NOT NULL))
);
CREATE INDEX payment_allocations_payment_idx ON payment_allocations(organization_id, league_id, payment_id);
CREATE INDEX payment_allocations_obligation_idx ON payment_allocations(organization_id, league_id, obligation_id);
--> statement-breakpoint

CREATE TABLE autopay_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  league_id integer NOT NULL,
  payer_bowler_id integer NOT NULL,
  consent_version integer NOT NULL DEFAULT 1,
  state text NOT NULL DEFAULT 'pending',
  provider_name varchar(32),
  encrypted_source_id text,
  encrypted_customer_id text,
  created_by_user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT autopay_consents_league_tenant_fk FOREIGN KEY (league_id, organization_id) REFERENCES leagues(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT autopay_consents_payer_fk FOREIGN KEY (payer_bowler_id, organization_id) REFERENCES bowlers(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT autopay_consents_state_check CHECK (state IN ('pending', 'active', 'revoked', 'expired') AND consent_version > 0)
);
CREATE UNIQUE INDEX autopay_consents_version_unique ON autopay_consents(organization_id, league_id, payer_bowler_id, consent_version);
CREATE UNIQUE INDEX autopay_consents_active_unique ON autopay_consents(organization_id, league_id, payer_bowler_id) WHERE state = 'active';
--> statement-breakpoint

CREATE TABLE financial_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  league_id integer NOT NULL,
  actor_user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  command_type varchar(96) NOT NULL,
  idempotency_key varchar(255) NOT NULL,
  request_fingerprint varchar(128) NOT NULL,
  state text NOT NULL DEFAULT 'accepted',
  result jsonb,
  error_code varchar(128),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT financial_commands_league_tenant_fk FOREIGN KEY (league_id, organization_id) REFERENCES leagues(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT financial_commands_state_check CHECK (state IN ('accepted', 'rejected', 'applied', 'failed') AND length(btrim(command_type)) > 0 AND length(btrim(idempotency_key)) > 0 AND length(btrim(request_fingerprint)) > 0)
);
CREATE UNIQUE INDEX financial_commands_idempotency_unique ON financial_commands(organization_id, league_id, command_type, idempotency_key);
CREATE INDEX financial_commands_created_idx ON financial_commands(organization_id, league_id, created_at DESC);
--> statement-breakpoint

CREATE TABLE payment_operation_roster_snapshots (
  operation_id uuid PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  league_id integer NOT NULL,
  snapshot_version integer NOT NULL DEFAULT 1,
  amount_minor integer NOT NULL,
  currency varchar(3) NOT NULL DEFAULT 'USD',
  obligations jsonb NOT NULL,
  snapshot_fingerprint varchar(128) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_operation_roster_snapshots_operation_fk FOREIGN KEY (operation_id, organization_id, league_id) REFERENCES payment_operations(id, organization_id, league_id) ON DELETE RESTRICT,
  CONSTRAINT payment_operation_roster_snapshots_league_tenant_fk FOREIGN KEY (league_id, organization_id) REFERENCES leagues(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT payment_operation_roster_snapshots_amount_check CHECK (amount_minor > 0 AND currency = 'USD' AND snapshot_version > 0)
);
CREATE UNIQUE INDEX payment_operation_roster_snapshots_version_unique ON payment_operation_roster_snapshots(operation_id, organization_id, league_id, snapshot_version);
CREATE UNIQUE INDEX payment_operation_roster_snapshots_tenant_identity_unique ON payment_operation_roster_snapshots(operation_id, organization_id, league_id);
--> statement-breakpoint

CREATE TABLE payment_operation_roster_snapshot_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  league_id integer NOT NULL,
  obligation_id uuid NOT NULL,
  allocation_index integer NOT NULL,
  amount_minor integer NOT NULL,
  state text NOT NULL DEFAULT 'reserved',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_operation_roster_snapshot_items_operation_fk FOREIGN KEY (operation_id, organization_id, league_id) REFERENCES payment_operation_roster_snapshots(operation_id, organization_id, league_id) ON DELETE RESTRICT,
  CONSTRAINT payment_operation_roster_snapshot_items_obligation_fk FOREIGN KEY (obligation_id, organization_id, league_id) REFERENCES payment_obligations(id, organization_id, league_id) ON DELETE RESTRICT,
  CONSTRAINT payment_operation_roster_snapshot_items_league_tenant_fk FOREIGN KEY (league_id, organization_id) REFERENCES leagues(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT payment_operation_roster_snapshot_items_amount_check CHECK (amount_minor > 0 AND allocation_index >= 0 AND state IN ('reserved', 'finalized', 'released'))
);
CREATE UNIQUE INDEX payment_operation_roster_snapshot_items_operation_item_unique ON payment_operation_roster_snapshot_items(operation_id, organization_id, league_id, obligation_id);
CREATE UNIQUE INDEX payment_operation_roster_snapshot_items_operation_allocation_index_unique ON payment_operation_roster_snapshot_items(operation_id, organization_id, league_id, allocation_index);
CREATE UNIQUE INDEX payment_operation_roster_snapshot_items_active_obligation_unique ON payment_operation_roster_snapshot_items(organization_id, league_id, obligation_id) WHERE state IN ('reserved', 'finalized');
CREATE INDEX payment_operation_roster_snapshot_items_obligation_idx ON payment_operation_roster_snapshot_items(organization_id, league_id, obligation_id, state);
--> statement-breakpoint

-- Financial evidence is append-only. Corrections are represented by new rows
-- and void state; no route may update or delete these identities.
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
        SELECT COALESCE(SUM(pa.amount_minor), 0) < NEW.amount_minor
          FROM payment_allocations pa
         WHERE pa.organization_id = NEW.organization_id
           AND pa.league_id = NEW.league_id
           AND pa.obligation_id = NEW.id
           AND pa.state = 'active'
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
    AND (
      NEW.state = OLD.state
      OR (OLD.state = 'accepted' AND NEW.state IN ('rejected', 'applied', 'failed'))
    ) THEN
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
    AND (
      NEW.state = OLD.state
      OR (OLD.state = 'pending' AND NEW.state IN ('active', 'revoked', 'expired'))
      OR (OLD.state = 'active' AND NEW.state IN ('revoked', 'expired'))
    ) THEN
    RETURN NEW;
    END IF;
  END IF;
  -- Provider/payment facts remain immutable, while a refund or dispute may
  -- append review metadata to the retained allocation in place.
  IF TG_TABLE_NAME = 'payment_allocations' THEN
    IF OLD.state = 'active' AND NEW.state = 'voided'
    AND NEW.correction_reason IS NOT NULL
    AND ROW(NEW.id, NEW.organization_id, NEW.league_id, NEW.payment_id,
            NEW.obligation_id, NEW.amount_minor, NEW.currency,
            NEW.supersedes_allocation_id, NEW.recorded_by_user_id,
            NEW.created_at)
        IS NOT DISTINCT FROM
        ROW(OLD.id, OLD.organization_id, OLD.league_id, OLD.payment_id,
            OLD.obligation_id, OLD.amount_minor, OLD.currency,
            OLD.supersedes_allocation_id, OLD.recorded_by_user_id,
            OLD.created_at) THEN
    RETURN NEW;
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'payment_allocations' THEN
    IF ROW(NEW.id, NEW.organization_id, NEW.league_id, NEW.payment_id,
            NEW.obligation_id, NEW.amount_minor, NEW.currency, NEW.state,
            NEW.supersedes_allocation_id, NEW.correction_reason,
            NEW.recorded_by_user_id, NEW.created_at)
        IS NOT DISTINCT FROM
        ROW(OLD.id, OLD.organization_id, OLD.league_id, OLD.payment_id,
            OLD.obligation_id, OLD.amount_minor, OLD.currency, OLD.state,
            OLD.supersedes_allocation_id, OLD.correction_reason,
            OLD.recorded_by_user_id, OLD.created_at) THEN
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
CREATE TRIGGER occurrence_payment_responsibilities_append_only BEFORE UPDATE OR DELETE ON occurrence_payment_responsibilities FOR EACH ROW EXECUTE FUNCTION roster_payment_append_only_guard();
CREATE TRIGGER payment_allocations_append_only BEFORE UPDATE OR DELETE ON payment_allocations FOR EACH ROW EXECUTE FUNCTION roster_payment_append_only_guard();
CREATE TRIGGER payment_obligations_append_only BEFORE UPDATE OR DELETE ON payment_obligations FOR EACH ROW EXECUTE FUNCTION roster_payment_append_only_guard();
CREATE TRIGGER team_payment_slot_revisions_append_only BEFORE UPDATE OR DELETE ON team_payment_slot_revisions FOR EACH ROW EXECUTE FUNCTION roster_payment_append_only_guard();
CREATE TRIGGER team_payment_policy_revisions_append_only BEFORE UPDATE OR DELETE ON team_payment_policy_revisions FOR EACH ROW EXECUTE FUNCTION roster_payment_append_only_guard();
CREATE TRIGGER payment_operation_roster_snapshots_append_only BEFORE UPDATE OR DELETE ON payment_operation_roster_snapshots FOR EACH ROW EXECUTE FUNCTION roster_payment_append_only_guard();
CREATE TRIGGER payment_operation_roster_snapshot_items_append_only BEFORE UPDATE OR DELETE ON payment_operation_roster_snapshot_items FOR EACH ROW EXECUTE FUNCTION roster_payment_append_only_guard();
CREATE TRIGGER autopay_consents_append_only BEFORE UPDATE OR DELETE ON autopay_consents FOR EACH ROW EXECUTE FUNCTION roster_payment_append_only_guard();
CREATE TRIGGER financial_commands_append_only BEFORE UPDATE OR DELETE ON financial_commands FOR EACH ROW EXECUTE FUNCTION roster_payment_append_only_guard();

-- Active allocations are additive settlement evidence.  A deferred constraint
-- trigger serializes all writers on the obligation row and checks the sum at
-- commit, so two concurrent partial payments cannot over-allocate an
-- obligation even when both transactions initially observe the same balance.
CREATE OR REPLACE FUNCTION roster_payment_allocation_conservation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  obligation_amount integer;
  active_total integer;
  payment_amount integer;
  payment_active_total integer;
  target_obligation uuid;
BEGIN
  target_obligation := COALESCE(NEW.obligation_id, OLD.obligation_id);
  SELECT amount_minor INTO obligation_amount
    FROM payment_obligations
   WHERE id = target_obligation
     AND organization_id = COALESCE(NEW.organization_id, OLD.organization_id)
     AND league_id = COALESCE(NEW.league_id, OLD.league_id)
   FOR UPDATE;
  IF obligation_amount IS NULL THEN
    RAISE EXCEPTION 'allocation obligation is missing from its tenant scope';
  END IF;
  SELECT COALESCE(SUM(amount_minor), 0) INTO active_total
    FROM payment_allocations
   WHERE obligation_id = target_obligation
     AND organization_id = COALESCE(NEW.organization_id, OLD.organization_id)
     AND league_id = COALESCE(NEW.league_id, OLD.league_id)
     AND state = 'active';
  IF active_total > obligation_amount THEN
    RAISE EXCEPTION 'active allocation total (%) exceeds obligation amount (%)', active_total, obligation_amount;
  END IF;
  SELECT amount INTO payment_amount
    FROM payments
   WHERE id = COALESCE(NEW.payment_id, OLD.payment_id)
     AND league_id = COALESCE(NEW.league_id, OLD.league_id)
   FOR UPDATE;
  IF payment_amount IS NULL THEN
    RAISE EXCEPTION 'allocation payment is missing from its league scope';
  END IF;
  SELECT COALESCE(SUM(amount_minor), 0) INTO payment_active_total
    FROM payment_allocations
   WHERE payment_id = COALESCE(NEW.payment_id, OLD.payment_id)
     AND organization_id = COALESCE(NEW.organization_id, OLD.organization_id)
     AND league_id = COALESCE(NEW.league_id, OLD.league_id)
     AND state = 'active';
  IF payment_active_total > payment_amount THEN
    RAISE EXCEPTION 'active allocation total (%) exceeds provider payment amount (%)', payment_active_total, payment_amount;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
CREATE CONSTRAINT TRIGGER payment_allocations_conservation
AFTER INSERT OR UPDATE ON payment_allocations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION roster_payment_allocation_conservation_guard();

-- The immutable operation snapshot amount is the exact sum of its immutable
-- item amounts. Released items remain evidence and are included in the sum.
CREATE OR REPLACE FUNCTION roster_payment_snapshot_sum_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_operation uuid;
  snapshot_amount integer;
  operation_amount integer;
  item_total integer;
  item_count integer;
BEGIN
  IF TG_TABLE_NAME = 'payment_operation_roster_snapshots' THEN
    target_operation := COALESCE(NEW.operation_id, OLD.operation_id);
  ELSE
    target_operation := COALESCE(NEW.operation_id, OLD.operation_id);
  END IF;
  SELECT amount_minor INTO snapshot_amount
    FROM payment_operation_roster_snapshots
   WHERE operation_id = target_operation
   FOR UPDATE;
  IF snapshot_amount IS NULL THEN
    RAISE EXCEPTION 'roster operation snapshot is missing';
  END IF;
  SELECT amount_minor INTO operation_amount
    FROM payment_operations
   WHERE id = target_operation;
  IF operation_amount IS NULL OR operation_amount <> snapshot_amount THEN
    RAISE EXCEPTION 'roster snapshot amount (%) does not equal operation amount (%)', snapshot_amount, operation_amount;
  END IF;
  SELECT COUNT(*)::integer, COALESCE(SUM(amount_minor), 0)
    INTO item_count, item_total
    FROM payment_operation_roster_snapshot_items
   WHERE operation_id = target_operation;
  IF item_count = 0 OR item_total <> snapshot_amount THEN
    RAISE EXCEPTION 'roster operation snapshot amount (%) does not equal item total (%)', snapshot_amount, item_total;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
CREATE CONSTRAINT TRIGGER payment_operation_roster_snapshot_sum
AFTER INSERT OR UPDATE ON payment_operation_roster_snapshots
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION roster_payment_snapshot_sum_guard();

-- Reservation amounts must fit the obligation's remaining balance. The
-- obligation row is the serialization point shared by quote/manual/provider
-- commands; active reservations are included so a partial allocation cannot
-- be hidden behind a second provider operation.
CREATE OR REPLACE FUNCTION roster_payment_snapshot_item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  obligation_amount integer;
  allocated_total integer;
  reserved_total integer;
  target_obligation uuid;
BEGIN
  target_obligation := COALESCE(NEW.obligation_id, OLD.obligation_id);
  SELECT amount_minor INTO obligation_amount
    FROM payment_obligations
   WHERE id = target_obligation
     AND organization_id = COALESCE(NEW.organization_id, OLD.organization_id)
     AND league_id = COALESCE(NEW.league_id, OLD.league_id)
   FOR UPDATE;
  IF obligation_amount IS NULL THEN
    RAISE EXCEPTION 'roster reservation obligation is missing from its tenant scope';
  END IF;
  IF COALESCE(NEW.amount_minor, OLD.amount_minor) > obligation_amount THEN
    RAISE EXCEPTION 'roster reservation amount exceeds obligation amount';
  END IF;
  SELECT COALESCE(SUM(amount_minor), 0) INTO allocated_total
    FROM payment_allocations
   WHERE obligation_id = target_obligation
     AND organization_id = COALESCE(NEW.organization_id, OLD.organization_id)
     AND league_id = COALESCE(NEW.league_id, OLD.league_id)
     AND state = 'active';
  SELECT COALESCE(SUM(amount_minor), 0) INTO reserved_total
    FROM payment_operation_roster_snapshot_items
   WHERE obligation_id = target_obligation
     AND organization_id = COALESCE(NEW.organization_id, OLD.organization_id)
     AND league_id = COALESCE(NEW.league_id, OLD.league_id)
     AND state = 'reserved';
  IF allocated_total + reserved_total > obligation_amount THEN
    RAISE EXCEPTION 'roster reservations and allocations exceed obligation amount';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
CREATE CONSTRAINT TRIGGER payment_operation_roster_snapshot_item_guard
AFTER INSERT OR UPDATE ON payment_operation_roster_snapshot_items
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION roster_payment_snapshot_item_guard();

-- Obligation and responsibility occurrence identities are a canonical pair;
-- tenant FKs alone do not enforce that they reference the same occurrence.
CREATE OR REPLACE FUNCTION roster_payment_obligation_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  responsibility_occurrence uuid;
BEGIN
  SELECT occurrence_id INTO responsibility_occurrence
    FROM occurrence_payment_responsibilities
   WHERE id = NEW.responsibility_id
     AND organization_id = NEW.organization_id
     AND league_id = NEW.league_id;
  IF responsibility_occurrence IS NULL OR responsibility_occurrence <> NEW.occurrence_id THEN
    RAISE EXCEPTION 'obligation occurrence does not match responsibility occurrence';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_obligation_identity_guard
BEFORE INSERT OR UPDATE ON payment_obligations
FOR EACH ROW EXECUTE FUNCTION roster_payment_obligation_identity_guard();
CREATE CONSTRAINT TRIGGER payment_operation_roster_snapshot_items_sum
AFTER INSERT OR UPDATE ON payment_operation_roster_snapshot_items
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION roster_payment_snapshot_sum_guard();
