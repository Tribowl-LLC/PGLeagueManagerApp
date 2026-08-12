import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ADOPTION_CONFIRMATION,
  BACKUP_ATTESTATION,
  PRODUCTION_ENVIRONMENT_CLASS,
  PRODUCTION_JOURNAL_RELATION,
  parseAdoptionEnvironment,
  validateAdoptionRequest,
  type AdoptionRequest,
} from '../../scripts/lib/db-baseline-adoption';
import {
  APPLICATION_TABLE_NAMES,
  loadApprovedBaselineFingerprint,
} from '../../scripts/lib/db-baseline-fingerprint';
import {
  ACTIVE_MIGRATIONS_DIRECTORY,
  LEGACY_MIGRATIONS_DIRECTORY,
  baselineMigration,
  loadActiveMigrations,
} from '../../scripts/lib/db-migration-assets';
import {
  assertJournalPrefix,
  classifyBaselineJournal,
  type JournalEntryRow,
} from '../../scripts/lib/db-migration-journal';
import {
  createGenerateInvocation,
  parseReviewedMigrationArgs,
  parseReviewedMigrationName,
} from '../../scripts/db-generate';
import { REVIEWED_DRIZZLE_CONFIG_PATH } from '../../scripts/lib/drizzle-cli-environment';

const SOURCE_COMMIT = '0123456789abcdef0123456789abcdef01234567';

function completeEnvironment(): NodeJS.ProcessEnv {
  const baseline = baselineMigration();
  return {
    NODE_ENV: 'test',
    DB_ADOPTION_EXPECTED_DATABASE: 'leaguevault_disposable',
    DB_ADOPTION_EXPECTED_ROLE: 'postgres',
    DB_ADOPTION_EXPECTED_HOST_FINGERPRINT: `sha256:${'a'.repeat(64)}`,
    DB_ADOPTION_ENVIRONMENT_CLASS: 'local-disposable',
    DB_ADOPTION_ENVIRONMENT_ID: 'local-disposable-baseline-test',
    DB_ADOPTION_EXPECTED_ENVIRONMENT_ID: 'local-disposable-baseline-test',
    DB_ADOPTION_BACKUP_ATTESTATION: BACKUP_ATTESTATION,
    DB_ADOPTION_CONFIRM: ADOPTION_CONFIRMATION,
    DB_ADOPTION_EXPECTED_COMMIT: SOURCE_COMMIT,
    DB_ADOPTION_EXPECTED_BASELINE_TAG: baseline.tag,
    DB_ADOPTION_EXPECTED_BASELINE_HASH: baseline.hash,
    DB_ADOPTION_EXPECTED_BASELINE_CREATED_AT: String(baseline.createdAt),
    LV_DISPOSABLE_DB_CONTAINER_ID: 'a'.repeat(64),
    LV_DISPOSABLE_DB_RUN_ID: 'baseline-unit-run',
    LV_DISPOSABLE_DB_PURPOSE: 'baseline-adoption',
    LV_DISPOSABLE_DB_DATABASE: 'leaguevault_disposable',
  };
}

function completeRequest(): AdoptionRequest {
  return parseAdoptionEnvironment(completeEnvironment());
}

function completeNeonEnvironment(): NodeJS.ProcessEnv {
  return {
    ...completeEnvironment(),
    DB_ADOPTION_ENVIRONMENT_CLASS: 'neon-rehearsal',
    DB_ADOPTION_ENVIRONMENT_ID: 'neon-disposable-rehearsal',
    DB_ADOPTION_EXPECTED_ENVIRONMENT_ID: 'neon-disposable-rehearsal',
    NEON_API_KEY: 'unit-test-api-key',
    DB_ADOPTION_NEON_EXPECTED_PROJECT_ID: 'project-rehearsal',
    DB_ADOPTION_NEON_EXPECTED_TARGET_BRANCH_ID: 'br-disposable-rehearsal',
    DB_ADOPTION_NEON_EXPECTED_PRODUCTION_BRANCH_ID: 'br-production-source',
    DB_ADOPTION_NEON_EXPECTED_ENDPOINT_ID: 'ep-disposable-rehearsal',
  };
}

function completeProductionEnvironment(): NodeJS.ProcessEnv {
  const projectId = 'project-production';
  const branchId = 'br-production-primary';
  const endpointId = 'ep-production-primary';
  return {
    ...completeEnvironment(),
    APP_ENV: 'prod',
    NODE_ENV: 'production',
    APP_DOMAIN: 'leaguevault.app',
    DB_ADOPTION_ENVIRONMENT_CLASS: PRODUCTION_ENVIRONMENT_CLASS,
    DB_ADOPTION_ENVIRONMENT_ID: [
      PRODUCTION_ENVIRONMENT_CLASS,
      projectId,
      branchId,
      endpointId,
    ].join(':'),
    DB_ADOPTION_EXPECTED_ENVIRONMENT_ID: [
      PRODUCTION_ENVIRONMENT_CLASS,
      projectId,
      branchId,
      endpointId,
    ].join(':'),
    NEON_API_KEY: 'unit-test-production-api-key',
    DB_ADOPTION_NEON_EXPECTED_PROJECT_ID: projectId,
    DB_ADOPTION_NEON_EXPECTED_TARGET_BRANCH_ID: branchId,
    DB_ADOPTION_NEON_EXPECTED_PRODUCTION_BRANCH_ID: branchId,
    DB_ADOPTION_NEON_EXPECTED_ENDPOINT_ID: endpointId,
    DB_ADOPTION_EXPECTED_SCHEMA_FINGERPRINT: loadApprovedBaselineFingerprint().digest,
    DB_ADOPTION_EXPECTED_JOURNAL_RELATION: PRODUCTION_JOURNAL_RELATION,
    DB_ADOPTION_APPROVAL_TOKEN: 'a'.repeat(43),
  };
}

describe('normalized migration baseline tools', () => {
  it('keeps the exact baseline first and all forward migrations ordered', () => {
    const migrations = loadActiveMigrations();
    expect(migrations).toHaveLength(23);
    expect(migrations[0]).toMatchObject({
      idx: 0,
      tag: '0000_normalized_baseline',
      createdAt: 1784104330176,
      hash: '9f4398b0e90bb5a5e33406cc5f35faf73b9c9dcbff3c781bacc892479c31a302',
    });
    expect(migrations[1]).toMatchObject({
      idx: 1,
      tag: '0001_organization_hostname_namespace_guard',
      createdAt: 1784694843315,
      hash: '8902cc5fee270a2841e87570e8bb7d811b79608393ae44f17aef6b9c78219652',
    });
    expect(migrations[2]).toMatchObject({
      idx: 2,
      tag: '0002_remove_legacy_crm_columns',
      createdAt: 1784702857273,
      hash: '2691703a0012e2e7caebd417e6956d33bfd0dd373e212fb472d0822924dde15d',
    });
    expect(migrations[2]?.sql.match(/DROP COLUMN/g)).toHaveLength(5);
    expect(migrations[3]).toMatchObject({
      idx: 3,
      tag: '0003_remove_clover_integration',
      createdAt: 1784730543756,
      hash: '6cf2092637094bafdf8062a17d6b439a97f48c3bbb2945b91dd247bba33cc4fe',
    });
    expect(migrations[3]?.sql.match(/DROP COLUMN/g)).toHaveLength(4);
    expect(migrations[4]).toMatchObject({
      idx: 4,
      tag: '0004_remove_league_secretaries',
      createdAt: 1784736825589,
      hash: '1516fb7b4c419e90e3df340d33ef90dfdba668a07296aa9c3a26b96640ee277e',
    });
    expect(migrations[4]?.sql).toContain('DROP TABLE "league_secretaries"');
    expect(migrations[4]?.sql).toContain('DROP TABLE "league_secretary_audits"');
    expect(migrations[5]).toMatchObject({
      idx: 5,
      tag: '0005_remove_embeddable_registration',
      createdAt: 1784743908431,
      hash: '1612874cc86ac939949b9b92722eb548a9ed9ee43208c1644d96cffd64aa3ac0',
    });
    expect(migrations[5]?.sql).toContain('DROP TABLE "league_registration_questions"');
    expect(migrations[5]?.sql).toContain('DROP TABLE "league_registrations"');
    expect(migrations[5]?.sql.match(/DROP COLUMN/g)).toHaveLength(3);
    expect(migrations[6]).toMatchObject({
      idx: 6,
      tag: '0006_payment_sync_next_due',
      createdAt: 1785630087761,
      hash: 'e3aa1bdce9fbdacbbb2eb49c4ffe2bb1bfd3ff9a51a9d031d962a8c0d488b4e7',
    });
    expect(migrations[6]?.sql).toContain('ADD COLUMN "payment_sync_next_retry_at"');
    expect(migrations[6]?.sql).toContain('CREATE INDEX "bowlers_payment_sync_next_retry_idx"');
    expect(migrations[7]).toMatchObject({
      idx: 7,
      tag: '0007_payment_operation_ledger',
      createdAt: 1785638674949,
      hash: 'cea7a75a4dbe731941eab342466d83722a54fb451f8a1aa755e411614b09e39e',
    });
    expect(migrations[7]?.sql).toContain('CREATE TABLE "payment_operations"');
    expect(migrations[7]?.sql).toContain('payment_operations_recurring_cycle_unique');
    expect(migrations[7]?.sql).toContain('payment_operations_provider_idempotency_key_unique');
    expect(migrations[7]?.sql).not.toMatch(/(?:^|\n)\s*(?:DROP|UPDATE|DELETE|INSERT)\b/);
    expect(migrations[8]).toMatchObject({
      idx: 8,
      tag: '0008_scheduled_payment_operation_execution',
      createdAt: 1785649485058,
      hash: 'fbc70da0fa40b9f8fa66f9c26aa7c9c437628b364524957c01810f8283387a45',
    });
    expect(migrations[8]?.sql).toContain('CREATE TABLE "scheduled_payment_operation_snapshots"');
    expect(migrations[8]?.sql).toContain('CREATE TABLE "scheduled_payment_operation_allocations"');
    expect(migrations[8]?.sql).toContain('CREATE TABLE "scheduled_payment_operation_line_items"');
    expect(migrations[8]?.sql).toContain('scheduled_payment_operation_snapshots_league_id_leagues_id_fk');
    expect(migrations[8]?.sql).toContain('payments_operation_allocation_unique');
    expect(migrations[8]?.sql).not.toMatch(/(?:^|\n)\s*(?:DROP|UPDATE|DELETE|INSERT)\b/);
    expect(migrations[9]).toMatchObject({
      idx: 9,
      tag: '0009_payment_operation_reconciliation_required',
      createdAt: 1785680310111,
      hash: '74bf179555ff73656760c205375bc15ba1075691e49c6cfd6169de42f4372157',
    });
    expect(migrations[9]?.sql).toContain("'reconciliation_required'");
    expect(migrations[9]?.sql).toContain('payment_schedules_active_next_payment_idx');
    expect(migrations[9]?.sql).not.toMatch(/(?:^|\n)\s*(?:UPDATE|DELETE|INSERT)\b/);
    expect(migrations[10]).toMatchObject({
      idx: 10,
      tag: '0010_autopay_setup_foundation',
      createdAt: 1785695299184,
      hash: 'ed9956a9d32d3d2cf0f5e2d0f584cf24397514d27f234b274b34624c74710c61',
    });
    expect(migrations[10]?.sql).toContain('CREATE TABLE "autopay_setup_requests"');
    expect(migrations[10]?.sql).toContain('payment_operations_interactive_target_unique');
    expect(migrations[10]?.sql).toContain('payment_schedules_active_bowler_league_unique');
    expect(migrations[10]?.sql).not.toMatch(/(?:^|\n)\s*(?:DROP|UPDATE|DELETE|INSERT)\b/);
    expect(migrations[11]).toMatchObject({
      idx: 11,
      tag: '0011_interactive_payment_operation_foundation',
      createdAt: 1785707848197,
      hash: '57f5e65bb0a88423d0ac9e8c516d4ee9e346b1216a0212905df21feb6b9203ae',
    });
    expect(migrations[11]?.sql).toContain('CREATE TABLE "interactive_payment_operation_snapshots"');
    expect(migrations[11]?.sql).toContain('CREATE TABLE "interactive_payment_operation_allocations"');
    expect(migrations[11]?.sql).toContain('CREATE TABLE "interactive_payment_operation_line_items"');
    expect(migrations[11]?.sql).toContain('interactive_payment_allocations_total');
    expect(migrations[11]?.sql).not.toMatch(/(?:^|\n)\s*(?:DROP|UPDATE|DELETE|INSERT)\b/);
    expect(migrations[12]).toMatchObject({
      idx: 12,
      tag: '0012_interactive_card_vault_before_charge',
      createdAt: 1785720810804,
    });
    expect(migrations[12]?.sql).toContain('ADD COLUMN "source_kind"');
    expect(migrations[12]?.sql).toContain('ADD COLUMN "encrypted_saved_card_id"');
    expect(migrations[12]?.sql).not.toMatch(/(?:^|\n)\s*(?:UPDATE|DELETE|INSERT)\b/);
    expect(migrations[13]).toMatchObject({
      idx: 13,
      tag: '0013_durable_refund_operations',
      createdAt: 1785727730717,
      hash: '1f84d902f0ef0c8051bce55c5bb99817c691ec81504b52aafda2fc6aa6159c72',
    });
    expect(migrations[13]?.sql).toContain('CREATE TABLE "refund_payment_operation_snapshots"');
    expect(migrations[13]?.sql).toContain('payment_operations_refund_target_unique');
    expect(migrations[13]?.sql).not.toMatch(/(?:^|\n)\s*(?:DROP|UPDATE|DELETE|INSERT)\b/);
    expect(migrations[14]).toMatchObject({
      idx: 14,
      tag: '0014_square_webhook_inbox',
      createdAt: 1785761770500,
      hash: 'd5ae353d76e329c985710f34998130e1deb842f7269a9812c936e54fa364c2fd',
    });
    expect(migrations[14]?.sql).toContain('CREATE TABLE "webhook_events"');
    expect(migrations[14]?.sql).toContain('webhook_events_provider_event_unique');
    expect(migrations[14]?.sql).not.toMatch(/(?:^|\n)\s*(?:DROP|UPDATE|DELETE|INSERT)\b/);
    expect(migrations[15]).toMatchObject({
      idx: 15,
      tag: '0015_square_webhook_object_freshness',
      createdAt: 1785786401297,
      hash: '97b535f271c856e26d6d431327af35b13ee6e8cdf5ad27c5a3921e434430f406',
    });
    expect(migrations[15]?.sql).toContain('CREATE INDEX "webhook_events_object_freshness_idx"');
    expect(migrations[15]?.sql).not.toMatch(/(?:^|\n)\s*(?:DROP|ALTER|UPDATE|DELETE|INSERT)\b/);
    expect(migrations[16]).toMatchObject({
      idx: 16,
      tag: '0016_payment_dispute_ledger',
      createdAt: 1785798985587,
      hash: 'b8e5f1c6ddea5f02eaa89a3c54d959f3addb802c4e01d81790e73f185c66f12f',
    });
    expect(migrations[16]?.sql).toContain('CREATE TABLE "payment_disputes"');
    expect(migrations[16]?.sql).toContain('payment_disputes_provider_dispute_unique');
    expect(migrations[16]?.sql).not.toMatch(/(?:^|\n)\s*(?:DROP|UPDATE|DELETE|INSERT)\b/);
    expect(migrations[17]).toMatchObject({
      idx: 17,
      tag: '0017_phase4b2_dispute_operations',
      createdAt: 1785808671598,
      hash: 'f95f4cefe1a14b2752b7896f753f85f5090f39883cec053a582ce114f0d52328',
    });
    expect(migrations[17]?.sql).toContain('CREATE TABLE "payment_dispute_notifications"');
    expect(migrations[17]?.sql).toContain('CREATE TABLE "payment_dispute_replay_audits"');
    expect(migrations[17]?.sql).toContain('webhook_events_tenant_status_type_received_idx');
    expect(migrations[17]?.sql).not.toMatch(/(?:^|\n)\s*(?:DROP|UPDATE|DELETE|INSERT)\b/);
    expect(migrations[18]).toMatchObject({
      idx: 18,
      tag: '0018_canonical_league_occurrence_foundation',
      hash: 'f1d25208ccde355ae8ba194410254bfa5e2c86bd2916d04966fce150c36b77c5',
    });
    for (const table of [
      'league_schedule_commands',
      'league_occurrence_generation_runs',
      'league_schedule_exceptions',
      'league_occurrences',
      'league_occurrence_billing_terms',
      'league_occurrence_relationships',
      'league_occurrence_revisions',
      'league_schedule_exception_revisions',
      'league_occurrence_relationship_revisions',
      'league_occurrence_billing_term_revisions',
      'league_occurrence_generation_discrepancies',
    ]) {
      expect(migrations[18]?.sql).toContain(`CREATE TABLE "${table}"`);
    }
    expect(migrations[18]?.sql).toContain('leagues_id_organization_unique');
    expect(migrations[18]?.sql).toContain('locations_id_organization_unique');
    expect(migrations[18]?.sql).toContain('"organization_id","league_id","generation_key"');
    expect(migrations[18]?.sql).toContain('"organization_id","league_id","start_at"');
    expect(migrations[18]?.sql).toContain('occurrences_published_competition_unique');
    expect(migrations[18]?.sql).toContain('billing_terms_last_command_fk');
    expect(migrations[18]?.sql).toContain('relationships_last_command_fk');
    expect(migrations[18]?.sql).toContain('generation_runs_approval_metadata_check');
    expect(migrations[18]?.sql).not.toMatch(/(?:^|\n)\s*(?:DROP|RENAME|UPDATE|DELETE|INSERT)\b/);
    expect(migrations[19]).toMatchObject({
      idx: 19,
      tag: '0019_phase_c1_cancelled_draft_occurrences',
      createdAt: 1786399141328,
      hash: '827dca651d26e840922a2cfefd6aff27d21b83a9e657a6fb6c16bbb2f228ffc9',
    });
    expect(migrations[19]?.sql).toContain("'draft' AND \"league_occurrences\".\"status\" = 'cancelled'");
    expect(migrations[19]?.sql).toContain('"league_occurrences"."cancellation_command_id" IS NOT NULL');
    expect(migrations[19]?.sql).not.toMatch(/(?:^|\n)\s*(?:UPDATE|DELETE|INSERT)\b/);
    expect(migrations[20]).toMatchObject({
      idx: 20,
      tag: '0020_phase_c2_fall_draft_review',
      createdAt: 1786404198272,
      hash: 'd52c091899a9ccb7dc25d640bd0274dd26754dc541ca994bcabf021b876d3f62',
    });
    expect(migrations[20]?.sql).toContain('CREATE TABLE "league_occurrence_generation_discrepancy_revisions"');
    expect(migrations[20]?.sql).toContain("'reject_generation'");
    expect(migrations[20]?.sql).toContain("'restore_cancelled_draft'");
    expect(migrations[20]?.sql).toContain('generation_discrepancy_revisions_discrepancy_fk');
    expect(migrations[20]?.sql).not.toMatch(/(?:^|\n)\s*(?:UPDATE|DELETE|INSERT)\b/);
    expect(migrations[21]).toMatchObject({
      idx: 21,
      tag: '0021_authoritative_league_payment_mode',
      createdAt: 1786427220667,
      hash: '878c2d349630f42051eff6b35a5d030f0c662acc7f51237bfd0e52046ac58598',
    });
    expect(migrations[21]?.sql).toContain('ADD CONSTRAINT "leagues_payment_mode_check"');
    expect(migrations[21]?.sql).toContain("IN ('weekly', 'upfront')");
    expect(migrations[21]?.sql).not.toMatch(/(?:^|\n)\s*(?:UPDATE|DELETE|INSERT)\b/);
    expect(migrations[22]).toMatchObject({
      idx: 22,
      tag: '0022_phase_d1_occurrence_compatibility',
      createdAt: 1786505453799,
      hash: '39e4d64004aed5bd05cc9fdf0ecf45412be47f55c99f4c141aa99e3d9c75a997',
    });
    expect(migrations[22]?.sql).toContain('ADD COLUMN "occurrence_id" uuid');
    expect(migrations[22]?.sql).toContain('ADD COLUMN "next_occurrence_id" uuid');
    expect(migrations[22]?.sql).toContain('ADD COLUMN "trigger_occurrence_id" uuid');
    expect(migrations[22]?.sql).toContain('payment_operations_trigger_occurrence_check');
    expect(migrations[22]?.sql).not.toMatch(/(?:^|\n)\s*(?:DROP|UPDATE|DELETE|INSERT)\b/);
    expect(ACTIVE_MIGRATIONS_DIRECTORY.endsWith('migrations')).toBe(true);
  });

  it('orders two-digit migration journal ids numerically', () => {
    const source = readFileSync(
      resolve('scripts', 'lib', 'db-migration-journal.ts'),
      'utf8',
    );
    expect(source).toContain('ORDER BY journal.id');
    expect(source).not.toMatch(/ORDER BY id\b/);
  });

  it('pins the complete application structure without physical column order or provider objects', () => {
    const fingerprint = loadApprovedBaselineFingerprint();
    expect(fingerprint.formatVersion).toBe(2);
    expect(fingerprint.digest).toBe('1c3c518e09d155bc3d447399c6c7a41ee4433423ed445b5f4a7554ed7607772a');
    expect(fingerprint.counts).toEqual({
      tables: 29,
      columns: 307,
      sequences: 26,
      constraints: 95,
      indexes: 104,
      types: 1,
      functions: 3,
      triggers: 3,
      policies: 0,
    });
    expect(fingerprint.structure.tables.map((table) => table.name)).toEqual(APPLICATION_TABLE_NAMES);
    expect(fingerprint.structure.tables.every((table) => !table.rowSecurity && !table.forceRowSecurity)).toBe(true);
    expect(fingerprint.structure.sequences.every((sequence) => sequence.persistence === 'permanent')).toBe(true);
    expect(fingerprint.structure.columns.every((column) => !('ordinal' in column))).toBe(true);
    expect(fingerprint.structure.types.map((type) => `${type.schema}.${type.name}`)).toEqual(['public.user_role']);
    expect(fingerprint.structure.functions).toHaveLength(3);
    expect(fingerprint.structure.triggers).toHaveLength(3);
  });

  it('keeps the persistent ordering proof outside the active migration history', () => {
    const metadata = JSON.parse(readFileSync(
      resolve('tests', 'fixtures', 'migrations', 'ordering-proof.json'),
      'utf8',
    )) as { tag: string; createdAt: number };
    expect(metadata.tag).toBe('0001_ordering_proof');
    expect(metadata.createdAt).toBeGreaterThan(baselineMigration().createdAt);
    expect(loadActiveMigrations().some((migration) => migration.tag === metadata.tag)).toBe(false);
  });

  it('refuses to load the legacy evidence tree as active migration history', () => {
    expect(() => loadActiveMigrations(LEGACY_MIGRATIONS_DIRECTORY)).toThrow(
      'legacy history is evidence only',
    );
    expect(() => loadActiveMigrations(resolve(LEGACY_MIGRATIONS_DIRECTORY, 'meta'))).toThrow(
      'legacy history is evidence only',
    );
  });

  it('allows only one safe name through the active migration generator wrapper', () => {
    expect(parseReviewedMigrationName(['--name', 'add_payment_index'])).toBe('add_payment_index');
    expect(() => parseReviewedMigrationName(['--name=add-payment-index'])).toThrow(
      /lowercase letters, digits, or underscores/,
    );
    expect(() => parseReviewedMigrationName([
      '--name',
      'unsafe',
      '--out',
      'migrations-legacy-do-not-replay',
    ])).toThrow('output overrides are refused');
    expect(() => parseReviewedMigrationName(['--name', '../legacy'])).toThrow(
      'output overrides are refused',
    );
    expect(() => parseReviewedMigrationName(['--config', 'alternate.ts', '--name', 'unsafe'])).toThrow(
      'config, schema, dialect, and output overrides are refused',
    );

    const invocation = createGenerateInvocation(['--name', 'safe_change'], {
      DATABASE_URL: 'postgresql://production.example/durable',
      TEST_CONFIG_PATH_PREFIX: 'C:\\unreviewed-config',
      DOTENV_CONFIG_PATH: 'C:\\unreviewed.env',
      DOTENV_CONFIG_OVERRIDE: '1',
      NODE_OPTIONS: '--require C:\\unreviewed-preload.cjs',
    });
    expect(invocation.args).toEqual(expect.arrayContaining([
      'generate',
      '--config',
      REVIEWED_DRIZZLE_CONFIG_PATH,
      '--name',
      'safe_change',
    ]));
    expect(invocation.environment.DATABASE_URL).toBeUndefined();
    expect(invocation.environment.TEST_CONFIG_PATH_PREFIX).toBe('');
    expect(invocation.environment.DOTENV_CONFIG_OVERRIDE).toBe('');
    expect(invocation.environment.DOTENV_CONFIG_PATH).not.toBe('C:\\unreviewed.env');
    expect(invocation.environment.NODE_OPTIONS).toBeUndefined();

    expect(parseReviewedMigrationArgs(['--custom', '--name', 'hostname_guard'])).toEqual({
      name: 'hostname_guard',
      custom: true,
    });
    expect(createGenerateInvocation(['--name', 'hostname_guard', '--custom'], {}).args)
      .toContain('--custom');
    expect(() => parseReviewedMigrationArgs([
      '--custom',
      '--custom',
      '--name',
      'hostname_guard',
    ])).toThrow('--custom at most once');
  });

  it('requires exact one-based journal ids as well as migration identity', () => {
    const baseline = baselineMigration();
    const wrongId = [{
      id: '99',
      hash: baseline.hash,
      created_at: String(baseline.createdAt),
    }] as JournalEntryRow[];
    expect(() => assertJournalPrefix(wrongId, [baseline])).toThrow('row 1');
    expect(() => classifyBaselineJournal(wrongId, baseline)).toThrow('conflicting');
  });

  it('requires every independently supplied adoption expectation', () => {
    const environment = completeEnvironment();
    delete environment.DB_ADOPTION_EXPECTED_ROLE;
    expect(() => parseAdoptionEnvironment(environment)).toThrow('DB_ADOPTION_EXPECTED_ROLE');
  });

  it('keeps production indicators and identities out of nonproduction adoption', () => {
    expect(() => parseAdoptionEnvironment({
      ...completeEnvironment(),
      APP_ENV: 'prod',
    })).toThrow('Production baseline adoption is disabled');
    expect(() => parseAdoptionEnvironment({
      ...completeEnvironment(),
      DB_ADOPTION_ENVIRONMENT_ID: 'leaguevault-production-live',
      DB_ADOPTION_EXPECTED_ENVIRONMENT_ID: 'leaguevault-production-live',
    })).toThrow('production-shaped');
    expect(() => parseAdoptionEnvironment({
      ...completeEnvironment(),
      DB_ADOPTION_EXPECTED_ENVIRONMENT_ID: 'different-disposable-identity',
    })).toThrow('mismatched');
    expect(() => parseAdoptionEnvironment({
      ...completeEnvironment(),
      RENDER: 'true',
    })).toThrow('Production baseline adoption is disabled');
  });

  it('parses production preflight without execution authorization and binds provider identity', () => {
    const environment = completeProductionEnvironment();
    delete environment.DB_ADOPTION_CONFIRM;
    delete environment.DB_ADOPTION_APPROVAL_TOKEN;
    const request = parseAdoptionEnvironment(environment, 'preflight');
    expect(request.environmentClass).toBe(PRODUCTION_ENVIRONMENT_CLASS);
    if (request.environmentClass !== PRODUCTION_ENVIRONMENT_CLASS) throw new Error('unexpected request class');
    expect(request.confirmation).toBe('');
    expect(request.approvalToken).toBe('');
    expect(request.neonExpectation.targetBranchId).toBe(request.neonExpectation.productionBranchId);
    expect(request.expectedJournalRelation).toBe(PRODUCTION_JOURNAL_RELATION);
    expect(request.expectedSchemaFingerprint).toBe(loadApprovedBaselineFingerprint().digest);
    expect(() => validateAdoptionRequest(
      request,
      { commit: SOURCE_COMMIT, clean: true },
      undefined,
      'preflight',
    )).not.toThrow();
  });

  it('separates production preflight from execution authorization', () => {
    const execution = completeProductionEnvironment();
    expect(parseAdoptionEnvironment(execution).environmentClass).toBe(PRODUCTION_ENVIRONMENT_CLASS);

    const missingToken = { ...execution };
    delete missingToken.DB_ADOPTION_APPROVAL_TOKEN;
    expect(() => parseAdoptionEnvironment(missingToken)).toThrow('ephemeral');

    const preflightWithConfirmation = { ...execution };
    delete preflightWithConfirmation.DB_ADOPTION_APPROVAL_TOKEN;
    expect(() => parseAdoptionEnvironment(preflightWithConfirmation, 'preflight')).toThrow(
      'confirmation and the ephemeral approval token to be absent',
    );

    const preflightWithToken = { ...execution };
    delete preflightWithToken.DB_ADOPTION_CONFIRM;
    expect(() => parseAdoptionEnvironment(preflightWithToken, 'preflight')).toThrow(
      'confirmation and the ephemeral approval token to be absent',
    );
  });

  it('refuses incomplete or self-inconsistent production identity', () => {
    expect(() => parseAdoptionEnvironment({
      ...completeProductionEnvironment(),
      DB_ADOPTION_NEON_EXPECTED_TARGET_BRANCH_ID: 'br-child',
    })).toThrow('environment identity');
    expect(() => parseAdoptionEnvironment({
      ...completeProductionEnvironment(),
      DB_ADOPTION_EXPECTED_SCHEMA_FINGERPRINT: 'f'.repeat(64),
    })).toThrow('schema fingerprint');
    expect(() => parseAdoptionEnvironment({
      ...completeProductionEnvironment(),
      DB_ADOPTION_EXPECTED_JOURNAL_RELATION: 'public.__drizzle_migrations',
    })).toThrow('DB_ADOPTION_EXPECTED_JOURNAL_RELATION');
    expect(() => parseAdoptionEnvironment({
      ...completeProductionEnvironment(),
      RENDER_SERVICE_ID: 'srv-production',
    })).toThrow('operator-only');
  });

  it('keeps the preflight entrypoint separate from the registration entrypoint', () => {
    const source = readFileSync(resolve('scripts/db-adopt-baseline-preflight.ts'), 'utf8');
    expect(source).toContain('preflightProductionDatabaseBaseline');
    expect(source).not.toContain('adoptExistingDatabaseBaseline');
    expect(source).not.toContain('DB_ADOPTION_CONFIRM=');
  });

  it('allows only the exact Neon rehearsal class in addition to local Docker', () => {
    const request = parseAdoptionEnvironment(completeNeonEnvironment());
    expect(request.environmentClass).toBe('neon-rehearsal');
    if (request.environmentClass !== 'neon-rehearsal') throw new Error('unexpected request class');
    expect(request.neonExpectation).toMatchObject({
      projectId: 'project-rehearsal',
      targetBranchId: 'br-disposable-rehearsal',
      productionBranchId: 'br-production-source',
      endpointId: 'ep-disposable-rehearsal',
    });
    expect(request.neonExpectation).not.toHaveProperty('apiKey');
    expect(() => parseAdoptionEnvironment({
      ...completeEnvironment(),
      DB_ADOPTION_ENVIRONMENT_CLASS: 'ci',
    })).toThrow('Only tool-owned local disposable or provider-verified Neon adoption');
  });

  it('refuses Neon self-attestation without provider proof and keeps production impossible', () => {
    const withoutProviderProof = completeNeonEnvironment();
    delete withoutProviderProof.NEON_API_KEY;
    expect(() => parseAdoptionEnvironment(withoutProviderProof)).toThrow('NEON_API_KEY');

    expect(() => parseAdoptionEnvironment({
      ...completeNeonEnvironment(),
      APP_ENV: 'prod',
    })).toThrow('Production baseline adoption is disabled');
    expect(() => parseAdoptionEnvironment({
      ...completeNeonEnvironment(),
      NODE_ENV: 'production',
    })).toThrow('Production baseline adoption is disabled');
    expect(() => parseAdoptionEnvironment({
      ...completeNeonEnvironment(),
      RENDER_SERVICE_ID: 'production-service',
    })).toThrow('Production baseline adoption is disabled');

    const adoptionSource = readFileSync(resolve('scripts/lib/db-baseline-adoption.ts'), 'utf8');
    expect(adoptionSource).not.toContain('runtime.verifyNeonRehearsal');
    expect(adoptionSource).not.toContain('verifyNeonRehearsal?:');
  });

  it('requires confirmation, backup attestation, a clean exact commit, and exact baseline identity', () => {
    const request = completeRequest();
    const source = { commit: SOURCE_COMMIT, clean: true };
    expect(() => validateAdoptionRequest({ ...request, confirmation: '' }, source)).toThrow('confirmation');
    expect(() => validateAdoptionRequest({ ...request, backupAttestation: '' }, source)).toThrow('attestation');
    expect(() => validateAdoptionRequest(request, { ...source, clean: false })).toThrow('clean source worktree');
    expect(() => validateAdoptionRequest(request, { ...source, commit: 'f'.repeat(40) })).toThrow('checked-out commit');
    expect(() => validateAdoptionRequest({ ...request, expectedBaselineHash: 'f'.repeat(64) }, source)).toThrow('baseline identity');
    expect(() => validateAdoptionRequest({ ...request, expectedBaselineCreatedAt: request.expectedBaselineCreatedAt + 1 }, source)).toThrow('baseline identity');
  });
});
