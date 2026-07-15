import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkMigrationBytes } from '../../scripts/check-migration-bytes';
import { loadActiveMigrations } from '../../scripts/lib/db-migration-assets';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'leaguevault-migration-bytes-'));
  temporaryDirectories.push(directory);
  return directory;
}

function copyActiveMigrations(): string {
  const directory = join(temporaryDirectory(), 'migrations');
  cpSync(resolve('migrations'), directory, { recursive: true });
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe('deterministic migration SQL bytes', () => {
  it('keeps the approved active baseline as exact LF UTF-8 bytes', () => {
    const path = resolve('migrations', '0000_normalized_baseline.sql');
    const bytes = readFileSync(path);
    expect(bytes.includes(0x0d)).toBe(false);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      '9f4398b0e90bb5a5e33406cc5f35faf73b9c9dcbff3c781bacc892479c31a302',
    );
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes)).not.toThrow();
  });

  it('pins LF checkout attributes for active and fixture SQL without changing legacy SQL', () => {
    const attributes = readFileSync(resolve('.gitattributes'), 'utf8').split(/\r?\n/);
    expect(attributes).toContain('migrations/*.sql text eol=lf');
    expect(attributes).toContain('tests/fixtures/migrations/*.sql text eol=lf');
    expect(attributes.some((line) => line.includes('migrations-legacy-do-not-replay'))).toBe(false);
  });

  it('refuses CRLF-converted active migration content', () => {
    const directory = copyActiveMigrations();
    const path = join(directory, '0000_normalized_baseline.sql');
    const lf = readFileSync(path, 'utf8');
    writeFileSync(path, lf.replace(/\n/g, '\r\n'), 'utf8');
    expect(() => loadActiveMigrations(directory)).toThrow('exact LF line endings');
  });

  it('refuses invalid UTF-8 migration bytes before hashing or execution', () => {
    const directory = copyActiveMigrations();
    const path = join(directory, '0000_normalized_baseline.sql');
    writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from([0xff])]));
    expect(() => loadActiveMigrations(directory)).toThrow('valid UTF-8 bytes');
  });

  it('checks active and fixture SQL in the current checkout', () => {
    expect(() => checkMigrationBytes()).not.toThrow();
  });
});
