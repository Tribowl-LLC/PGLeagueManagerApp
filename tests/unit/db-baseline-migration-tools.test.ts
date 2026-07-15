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
  baselineMigration,
  loadActiveMigrations,
} from '../../scripts/lib/db-migration-assets';

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
  };
}

function completeRequest(): AdoptionRequest {
  return parseAdoptionEnvironment(completeEnvironment());
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
    expect(fingerprint.digest).toBe('f66a78e566b5338a7e356d3ce7a7b8cd2fe1c68a51a351556bb83b60ac42fa36');
    expect(fingerprint.counts).toEqual({
      tables: 29,
      columns: 307,
      constraints: 95,
      indexes: 104,
      types: 1,
      functions: 3,
      triggers: 3,
      policies: 0,
    });
    expect(fingerprint.structure.tables.map((table) => table.name)).toEqual(APPLICATION_TABLE_NAMES);
    expect(fingerprint.structure.tables.every((table) => !table.rowSecurity && !table.forceRowSecurity)).toBe(true);
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

  it('requires a distinct source identity only for Neon rehearsal adoption', () => {
    const rehearsal: NodeJS.ProcessEnv = {
      ...completeEnvironment(),
      DB_ADOPTION_ENVIRONMENT_CLASS: 'neon-rehearsal',
    };
    expect(() => parseAdoptionEnvironment(rehearsal)).toThrow('DB_ADOPTION_SOURCE_ENVIRONMENT_ID');
    expect(() => parseAdoptionEnvironment({
      ...rehearsal,
      DB_ADOPTION_SOURCE_ENVIRONMENT_ID: rehearsal.DB_ADOPTION_ENVIRONMENT_ID,
    })).toThrow('distinct');
    expect(parseAdoptionEnvironment({
      ...rehearsal,
      DB_ADOPTION_SOURCE_ENVIRONMENT_ID: 'neon-source-production-branch-id',
    }).sourceEnvironmentId).toBe('neon-source-production-branch-id');
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
