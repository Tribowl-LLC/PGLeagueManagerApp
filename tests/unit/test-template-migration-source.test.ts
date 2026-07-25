import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { computeTemplateHash } from '../../scripts/lib/test-template-provenance';
import { validateTestTemplateDatabaseName } from '../setup/per-worker-lock';

const temporaryRoots: string[] = [];

function write(root: string, path: string, contents = path): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
}

function createHashFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'leaguevault-template-hash-'));
  temporaryRoots.push(root);
  [
    'migrations/0000_normalized_baseline.sql',
    'migrations/meta/_journal.json',
    'migrations/meta/0000_snapshot.json',
    'migrations/migration-checksums.json',
    'migrations/baseline-fingerprint.json',
    'scripts/lib/db-baseline-fingerprint.ts',
    'scripts/lib/db-migration-assets.ts',
    'scripts/lib/db-migration-journal.ts',
    'scripts/lib/db-migration-runner.ts',
    'scripts/lib/db-schema-inventory.ts',
    'scripts/lib/sql-definition-normalization.ts',
    'scripts/lib/test-template-provenance.ts',
    'shared/schema/users.ts',
    'shared/schema.ts',
    'shared/database-invariants.ts',
    'server/db-invariants.ts',
    'tests/setup/seed-test-users.ts',
    'tests/setup/per-worker-lock.ts',
    'scripts/build-test-template.ts',
    'package-lock.json',
  ].forEach((path) => write(root, path));
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('migrated test-template source contract', () => {
  it('hashes every migration, journal, schema, invariant, seed, and tool input', () => {
    const root = createHashFixture();
    const inputs = [
      'migrations/0000_normalized_baseline.sql',
      'migrations/meta/_journal.json',
      'migrations/meta/0000_snapshot.json',
      'migrations/migration-checksums.json',
      'migrations/baseline-fingerprint.json',
      'scripts/lib/db-baseline-fingerprint.ts',
      'scripts/lib/db-migration-assets.ts',
      'scripts/lib/db-migration-journal.ts',
      'scripts/lib/db-migration-runner.ts',
      'scripts/lib/db-schema-inventory.ts',
      'scripts/lib/sql-definition-normalization.ts',
      'scripts/lib/test-template-provenance.ts',
      'shared/schema/users.ts',
      'shared/schema.ts',
      'shared/database-invariants.ts',
      'server/db-invariants.ts',
      'tests/setup/seed-test-users.ts',
      'tests/setup/per-worker-lock.ts',
      'scripts/build-test-template.ts',
      'package-lock.json',
    ];

    for (const path of inputs) {
      const target = join(root, path);
      const original = readFileSync(target, 'utf8');
      const before = computeTemplateHash(root);
      writeFileSync(target, `${original}\nchanged`, 'utf8');
      expect(computeTemplateHash(root), path).not.toBe(before);
      writeFileSync(target, original, 'utf8');
    }
  });

  it('excludes legacy migration SQL from the canonical template hash', () => {
    const root = createHashFixture();
    write(root, 'migrations-legacy-do-not-replay/0000_legacy.sql', 'legacy-one');
    const before = computeTemplateHash(root);
    write(root, 'migrations-legacy-do-not-replay/0000_legacy.sql', 'legacy-two');
    expect(computeTemplateHash(root)).toBe(before);
  });

  it('fails closed when a required migration input is absent', () => {
    const root = createHashFixture();
    rmSync(join(root, 'migrations/migration-checksums.json'));
    expect(() => computeTemplateHash(root)).toThrow(/migration-checksums\.json/);
  });

  it('restricts destructive template recreation to a test-prefixed PostgreSQL identifier', () => {
    expect(validateTestTemplateDatabaseName('leaguevault_test_template_2')).toBe(
      'leaguevault_test_template_2',
    );
    expect(() => validateTestTemplateDatabaseName('postgres')).toThrow('leaguevault_test_');
    expect(() => validateTestTemplateDatabaseName('leaguevault_test_bad"; DROP DATABASE postgres; --'))
      .toThrow('PostgreSQL-safe identifier');
    expect(() => validateTestTemplateDatabaseName(`leaguevault_test_${'a'.repeat(64)}`))
      .toThrow('no longer than 63 bytes');
  });

  it('contains no schema-push fallback and makes migration provenance observable', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'scripts/build-test-template.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/drizzle-kit[\s\S]{0,40}push|runDrizzlePush/);
    expect(source).toContain('runCheckedMigrations(templateUrl)');
    expect(source).toContain('assertCheckedMigrationsCurrent(templateUrl)');
    expect(source).toContain('rmSync(HASH_FILE, { force: true })');
    expect(source).toContain('assertMigratedTemplateReady(templateUrl)');
    expect(source).toContain('[test-template-provenance] source=db:migrate');
  });

  it('pins the local behavioral suite to PostgreSQL 17 and invalidates stale container caches', () => {
    const source = readFileSync(resolve(process.cwd(), 'scripts/test-local.ts'), 'utf8');
    expect(source).toContain("const POSTGRES_IMAGE = 'postgres:17'");
    expect(source).toContain("'{{.Config.Image}}'");
    expect(source).toContain('image !== POSTGRES_IMAGE');
    expect(source).toContain("rmSync('.local/test-template-hash', { force: true })");
  });
});
