import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ADOPTION_CONFIRMATION,
  BACKUP_ATTESTATION,
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

describe('normalized migration baseline tools', () => {
  it('has one authoritative active baseline with exact checked-in identity', () => {
    const migrations = loadActiveMigrations();
    expect(migrations).toHaveLength(1);
    expect(migrations[0]).toMatchObject({
      idx: 0,
      tag: '0000_normalized_baseline',
      createdAt: 1784104330176,
      hash: '9f4398b0e90bb5a5e33406cc5f35faf73b9c9dcbff3c781bacc892479c31a302',
    });
    expect(ACTIVE_MIGRATIONS_DIRECTORY.endsWith('migrations')).toBe(true);
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

  it('disables production adoption and production-shaped environment identities', () => {
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
    })).toThrow('Only tool-owned local disposable or provider-verified Neon rehearsal');
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
