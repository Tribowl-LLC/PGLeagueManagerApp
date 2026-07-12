/**
 * Pins the error-log-guard wiring CI check
 * (`scripts/check-error-log-guard-wiring.ts`, task #746).
 *
 * The check asserts every vitest project setup file imports the
 * side-effect guard module `./error-log-guard`, and that the guard +
 * helper pair stays connected. These tests drive the script against
 * synthetic fixture trees (via `LV_GUARD_WIRING_BASE`) to pin each
 * rule, and also run it once against the real repo to confirm the
 * production wiring is currently intact.
 *
 * Mirrors the structure of `tests/unit/check-provider-not-configured.test.ts`.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { TSX_CLI } from '../helpers/tsx-command';

const SCRIPT = join(process.cwd(), 'scripts/check-error-log-guard-wiring.ts');

const SETUP_FILES = [
  'tests/setup/per-worker-setup.ts',
  'tests/setup/per-worker-db-only.ts',
  'tests/setup/component-test-setup.ts',
];

function run(
  base: string | null,
  args: string[] = [],
): { status: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test' };
  if (base !== null) env.LV_GUARD_WIRING_BASE = base;
  else delete env.LV_GUARD_WIRING_BASE;
  const r = spawnSync(process.execPath, [TSX_CLI, SCRIPT, ...args], { cwd: process.cwd(), encoding: 'utf8', env });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

const GOOD_GUARD = `
import { recordInProcessLogLine, takeUnexpectedErrorLines, resetErrorLogState } from '../helpers/expected-error-logs';
export const x = { recordInProcessLogLine, takeUnexpectedErrorLines, resetErrorLogState };
`;

function makeFixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'check-error-log-guard-wiring-'));
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return dir;
}

function wiredTree(extra: Record<string, string> = {}): Record<string, string> {
  const files: Record<string, string> = {
    'tests/setup/error-log-guard.ts': GOOD_GUARD,
    'tests/helpers/expected-error-logs.ts': 'export const ok = 1;',
  };
  for (const f of SETUP_FILES) {
    files[f] = `import './error-log-guard';\nexport const ok = 1;\n`;
  }
  return { ...files, ...extra };
}

describe('check-error-log-guard-wiring (synthetic fixtures)', () => {
  it('passes when every setup file imports the guard and the pair is intact', () => {
    const dir = makeFixture(wiredTree());
    const r = run(dir);
    expect({ status: r.status, stdout: r.stdout }).toMatchObject({
      status: 0,
      stdout: expect.stringContaining('[check-error-log-guard-wiring] OK'),
    });
  });

  it('fails when a setup file does not import the guard', () => {
    const dir = makeFixture(
      wiredTree({
        'tests/setup/per-worker-db-only.ts': `import { cloneTemplateForWorker } from './clone-template';\nawait cloneTemplateForWorker();\n`,
      }),
    );
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/FAIL/);
    expect(r.stderr).toMatch(/per-worker-db-only\.ts/);
    expect(r.stderr).toMatch(/does not import the error-log guard/);
  });

  it('fails when a setup file is missing entirely', () => {
    const files = wiredTree();
    delete files['tests/setup/component-test-setup.ts'];
    const dir = makeFixture(files);
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/component-test-setup\.ts/);
    expect(r.stderr).toMatch(/is missing/);
  });

  it('fails when the guard module is disconnected from the helper plumbing', () => {
    const dir = makeFixture(
      wiredTree({
        'tests/setup/error-log-guard.ts': `export const disconnected = true;\n`,
      }),
    );
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/disconnected from the expectation registry/);
  });

  it('fails when the helper module is missing', () => {
    const files = wiredTree();
    delete files['tests/helpers/expected-error-logs.ts'];
    const dir = makeFixture(files);
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/expected-error-logs\.ts/);
    expect(r.stderr).toMatch(/helper module is missing/);
  });

  it('--report mode prints violations but exits 0', () => {
    const dir = makeFixture(
      wiredTree({
        'tests/setup/per-worker-setup.ts': `export const ok = 1;\n`,
      }),
    );
    const r = run(dir, ['--report']);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/REPORT/);
    expect(r.stderr).toMatch(/per-worker-setup\.ts/);
  });

  it('the real repo wiring is currently intact', () => {
    const r = run(null);
    expect({ status: r.status, stdout: r.stdout }).toMatchObject({
      status: 0,
      stdout: expect.stringContaining('[check-error-log-guard-wiring] OK'),
    });
  });
});
