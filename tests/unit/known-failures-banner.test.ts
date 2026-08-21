/**
 * Meta-test for the local "known failures" snapshot (task #694).
 *
 * `scripts/snapshot-failures.sh` writes `.local/known-failures.md` on demand
 * to record the current typecheck, lint, and test state for local diagnostics.
 *
 * This test asserts that *if* the file exists, it has the expected sections
 * and a recent timestamp — i.e. nobody silently broke the snapshot script and
 * left a year-old banner in place. On first-run / fresh-clone (file absent),
 * the test skips rather than failing.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BANNER_PATH = resolve(process.cwd(), '.local/known-failures.md');
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

describe('known-failures banner', () => {
  if (!existsSync(BANNER_PATH)) {
    it.skip('skipped — .local/known-failures.md not yet generated (first run)', () => {
      // No-op. The file is created by scripts/snapshot-failures.sh after the
      // first manual snapshot run.
    });
    return;
  }

  const contents = readFileSync(BANNER_PATH, 'utf8');

  it('has the expected top-level header', () => {
    expect(contents).toMatch(/^# Known failures \(manual snapshot\)/m);
  });

  it('has Typecheck, Lint, and Tests sections', () => {
    expect(contents).toMatch(/Typecheck.*\b(PASS|FAIL)\b/);
    expect(contents).toMatch(/Lint.*\b(PASS|FAIL)\b/);
    expect(contents).toMatch(/Tests.*\b(PASS|FAIL)\b/);
  });

  it('has a timestamp within the last 24 hours', () => {
    const match = contents.match(/_Generated: ([0-9T:\-Z]+)_/);
    if (!match) {
      throw new Error('banner is missing a `_Generated: <ISO>_` line');
    }
    const generatedAt = new Date(match[1]).getTime();
    expect(Number.isFinite(generatedAt)).toBe(true);
    const ageMs = Date.now() - generatedAt;
    expect(
      ageMs,
      `banner timestamp ${match[1]} is older than 24h — re-run scripts/snapshot-failures.sh`,
    ).toBeLessThan(TWENTY_FOUR_HOURS_MS);
  });
});
