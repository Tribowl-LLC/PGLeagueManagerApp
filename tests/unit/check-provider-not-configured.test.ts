/**
 * Tests the provider-not-configured toast wiring CI guard
 * introduced in task #624 (`scripts/check-provider-not-configured.ts`).
 *
 * The guard walks every `.ts` / `.tsx` file under `client/src/`
 * (excluding `.test.*` / `.spec.*` and `.d.ts`), finds every
 * direct `providerNotConfiguredToast(...)` call, and asserts:
 *   (a) The call has at least one argument.
 *   (b) That argument is an object literal (not an identifier or
 *       a spread-only expression the guard can't see through).
 *   (c) The literal includes a `provider:` property.
 *   (d) Bonus: `provider:` is not a string literal `'square'` /
 *       `'clover'` (must be derived from
 *       `usePaymentProvider(locationId)`).
 *
 * These tests drive the script against synthetic fixtures via
 * spawnSync to pin its detection logic for each rule and to
 * confirm the ignore-rules (`.test.*`, `.d.ts`, files outside
 * client/src) hold.
 *
 * Mirrors the structure of `tests/unit/check-not-found-code.test.ts`.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { TSX_CLI } from '../helpers/tsx-command';

const SCRIPT = join(process.cwd(), 'scripts/check-provider-not-configured.ts');

function runIn(
  cwd: string,
  args: string[] = [],
): { status: number; stdout: string; stderr: string } {
  // Resolve `tsx` against the real project's node_modules so the
  // synthetic fixtures (which have no node_modules of their own)
  // can still spawn the script.
  const r = spawnSync(process.execPath, [TSX_CLI, SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' },
  });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

function makeFixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'check-provider-not-configured-'));
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return dir;
}

// Tiny stub the synthetic fixtures import. The guard never executes
// the code — it parses syntactically — so the body is irrelevant.
// Kept so each fixture is a real (if tiny) compilable TypeScript
// file that matches the production helper's call shape.
const HELPER_STUB = `
export type PaymentProviderType = 'square' | 'clover';
export interface ProviderNotConfiguredToastOptions {
  navigate?: (path: string) => void;
  locationId?: number | null;
  description?: string;
  provider: PaymentProviderType;
}
export function providerNotConfiguredToast(_o: ProviderNotConfiguredToastOptions): {
  title: string;
  description: string;
  variant: 'destructive';
} {
  return { title: 'x', description: 'y', variant: 'destructive' };
}
`;

describe('check-provider-not-configured (synthetic fixtures)', () => {
  it('passes when every call site passes a literal provider derived from the hook', () => {
    const dir = makeFixture({
      'client/src/lib/provider-not-configured.tsx': HELPER_STUB,
      'client/src/pages/clean.tsx': `import { providerNotConfiguredToast } from '../lib/provider-not-configured';
export function ok(isClover: boolean) {
  providerNotConfiguredToast({ provider: isClover ? 'clover' : 'square' });
}
export function ok2(provider: 'square' | 'clover') {
  providerNotConfiguredToast({ provider });
}
export function ok3(isClover: boolean, locationId: number) {
  providerNotConfiguredToast({ navigate: () => {}, locationId, provider: isClover ? 'clover' : 'square' });
}
`,
    });
    const r = runIn(dir);
    expect({ status: r.status, stdout: r.stdout }).toMatchObject({
      status: 0,
      stdout: expect.stringContaining('[check-provider-not-configured] OK'),
    });
  });

  it('fails when a call site omits the provider field entirely', () => {
    const dir = makeFixture({
      'client/src/lib/provider-not-configured.tsx': HELPER_STUB,
      'client/src/pages/missing.tsx': `import { providerNotConfiguredToast } from '../lib/provider-not-configured';
export function bad() {
  providerNotConfiguredToast({ navigate: () => {}, locationId: 1 });
}
`,
    });
    const r = runIn(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/FAIL/);
    expect(r.stderr).toMatch(/client\/src\/pages\/missing\.tsx:3/);
    expect(r.stderr).toMatch(/missing the .* 'provider' field/);
  });

  it('fails when a call site is invoked with no arguments at all', () => {
    const dir = makeFixture({
      'client/src/lib/provider-not-configured.tsx': HELPER_STUB,
      'client/src/pages/noargs.tsx': `import { providerNotConfiguredToast } from '../lib/provider-not-configured';
// @ts-expect-error — guard fires before TS does
export function bad() { providerNotConfiguredToast(); }
`,
    });
    const r = runIn(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/called with no options/);
  });

  it("fails the bonus check when provider is hardcoded as 'square'", () => {
    const dir = makeFixture({
      'client/src/lib/provider-not-configured.tsx': HELPER_STUB,
      'client/src/pages/hardcoded.tsx': `import { providerNotConfiguredToast } from '../lib/provider-not-configured';
export function bad() {
  providerNotConfiguredToast({ provider: 'square' });
}
`,
    });
    const r = runIn(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/hardcodes provider: 'square'/);
    expect(r.stderr).toMatch(/usePaymentProvider/);
  });

  it("fails the bonus check when provider is hardcoded as 'clover'", () => {
    const dir = makeFixture({
      'client/src/lib/provider-not-configured.tsx': HELPER_STUB,
      'client/src/pages/hardcoded2.tsx': `import { providerNotConfiguredToast } from '../lib/provider-not-configured';
export function bad() {
  providerNotConfiguredToast({ provider: 'clover' });
}
`,
    });
    const r = runIn(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/hardcodes provider: 'clover'/);
  });

  it('fails when the options arg is an identifier the guard cannot inspect', () => {
    const dir = makeFixture({
      'client/src/lib/provider-not-configured.tsx': HELPER_STUB,
      'client/src/pages/ident.tsx': `import { providerNotConfiguredToast, type ProviderNotConfiguredToastOptions } from '../lib/provider-not-configured';
export function bad(opts: ProviderNotConfiguredToastOptions) {
  providerNotConfiguredToast(opts);
}
`,
    });
    const r = runIn(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/options arg is not an object literal/);
    expect(r.stderr).toMatch(/Identifier/);
  });

  it("fails when 'provider' is only carried by a spread the guard can't see through", () => {
    const dir = makeFixture({
      'client/src/lib/provider-not-configured.tsx': HELPER_STUB,
      'client/src/pages/spread.tsx': `import { providerNotConfiguredToast, type ProviderNotConfiguredToastOptions } from '../lib/provider-not-configured';
export function bad(rest: ProviderNotConfiguredToastOptions) {
  providerNotConfiguredToast({ ...rest });
}
`,
    });
    const r = runIn(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/forwards 'provider' through a spread/);
  });

  it('passes the conditional-expression shape (the canonical caller)', () => {
    const dir = makeFixture({
      'client/src/lib/provider-not-configured.tsx': HELPER_STUB,
      'client/src/pages/cond.tsx': `import { providerNotConfiguredToast } from '../lib/provider-not-configured';
export function ok(isClover: boolean) {
  // Mirrors every real call site: a ConditionalExpression sourced
  // from \`const { isClover } = usePaymentProvider(locationId)\`.
  providerNotConfiguredToast({ provider: isClover ? 'clover' : 'square' });
}
`,
    });
    const r = runIn(dir);
    expect({ status: r.status, stdout: r.stdout }).toMatchObject({
      status: 0,
      stdout: expect.stringContaining('[check-provider-not-configured] OK'),
    });
  });

  it('passes the shorthand `{ provider }` shape (already in scope)', () => {
    const dir = makeFixture({
      'client/src/lib/provider-not-configured.tsx': HELPER_STUB,
      'client/src/pages/short.tsx': `import { providerNotConfiguredToast } from '../lib/provider-not-configured';
export function ok(provider: 'square' | 'clover') {
  providerNotConfiguredToast({ provider });
}
`,
    });
    const r = runIn(dir);
    expect({ status: r.status, stdout: r.stdout }).toMatchObject({
      status: 0,
      stdout: expect.stringContaining('[check-provider-not-configured] OK'),
    });
  });

  it('ignores .test.tsx files inside client/src', () => {
    const dir = makeFixture({
      'client/src/lib/provider-not-configured.tsx': HELPER_STUB,
      // Real call site: clean. So the scan root is non-empty.
      'client/src/pages/ok.tsx': `import { providerNotConfiguredToast } from '../lib/provider-not-configured';
export function ok(provider: 'square' | 'clover') { providerNotConfiguredToast({ provider }); }
`,
      // A drift site in a sibling .test.tsx file — should be
      // skipped so test fixtures (which intentionally exercise
      // partial args) don't trip the guard.
      'client/src/pages/legacy.test.tsx': `import { providerNotConfiguredToast } from '../lib/provider-not-configured';
export function bad() { providerNotConfiguredToast({ navigate: () => {} }); }
`,
      'client/src/pages/types.d.ts': `export type Foo = number;`,
    });
    const r = runIn(dir);
    expect({ status: r.status, stdout: r.stdout }).toMatchObject({
      status: 0,
      stdout: expect.stringContaining('[check-provider-not-configured] OK'),
    });
  });

  it('only scans client/src — a drift outside that tree is invisible', () => {
    const dir = makeFixture({
      'client/src/lib/provider-not-configured.tsx': HELPER_STUB,
      'client/src/pages/ok.tsx': `import { providerNotConfiguredToast } from '../lib/provider-not-configured';
export function ok(provider: 'square' | 'clover') { providerNotConfiguredToast({ provider }); }
`,
      // Drift in server/ should be ignored — out of scope (the toast
      // is a client-only helper).
      'server/some-route.ts': `import { providerNotConfiguredToast } from '../client/src/lib/provider-not-configured';
export function bad() { providerNotConfiguredToast({}); }
`,
    });
    const r = runIn(dir);
    expect({ status: r.status, stdout: r.stdout }).toMatchObject({
      status: 0,
      stdout: expect.stringContaining('[check-provider-not-configured] OK'),
    });
  });

  it('fails loud (exit 2) when client/src has no .ts/.tsx files (refuses to silently pass)', () => {
    const dir = makeFixture({
      // No client/src content at all — script should refuse to run
      // rather than silently pretend everything's clean.
      'client/src/.gitkeep': '',
    });
    const r = runIn(dir);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/no \.ts\/\.tsx files found/);
  });

  it('--report mode prints violations but exits 0', () => {
    const dir = makeFixture({
      'client/src/lib/provider-not-configured.tsx': HELPER_STUB,
      'client/src/pages/missing.tsx': `import { providerNotConfiguredToast } from '../lib/provider-not-configured';
export function bad() { providerNotConfiguredToast({ navigate: () => {} }); }
`,
    });
    const r = runIn(dir, ['--report']);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/REPORT/);
    expect(r.stderr).toMatch(/missing the .* 'provider' field/);
  });

  it('handles multiple drift sites in the same file and reports each one', () => {
    const dir = makeFixture({
      'client/src/lib/provider-not-configured.tsx': HELPER_STUB,
      'client/src/pages/many.tsx': `import { providerNotConfiguredToast } from '../lib/provider-not-configured';
export function a() { providerNotConfiguredToast({ navigate: () => {} }); }
export function b() { providerNotConfiguredToast({ provider: 'square' }); }
export function c() { providerNotConfiguredToast({ provider: 'clover' }); }
`,
    });
    const r = runIn(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/3 providerNotConfiguredToast\(\.\.\.\) call site\(s\)/);
    expect(r.stderr).toMatch(/client\/src\/pages\/many\.tsx:2/);
    expect(r.stderr).toMatch(/client\/src\/pages\/many\.tsx:3/);
    expect(r.stderr).toMatch(/client\/src\/pages\/many\.tsx:4/);
  });

  it('treats nested files (e.g. client/src/components/foo/bar.tsx) the same as top-level', () => {
    const dir = makeFixture({
      'client/src/lib/provider-not-configured.tsx': HELPER_STUB,
      'client/src/components/nested/dir/file.tsx': `import { providerNotConfiguredToast } from '../../../lib/provider-not-configured';
export function bad() { providerNotConfiguredToast({ provider: 'square' }); }
`,
    });
    const r = runIn(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/client\/src\/components\/nested\/dir\/file\.tsx:2/);
  });

  it('does not flag the helper file itself (the export is a FunctionDeclaration, not a call)', () => {
    const dir = makeFixture({
      // Just the helper, no call sites elsewhere. The helper file
      // contains the function definition; the guard only fires on
      // CallExpressions, so nothing here should be flagged.
      'client/src/lib/provider-not-configured.tsx': HELPER_STUB,
      // Need at least one other file so the empty-tree sanity bottom
      // doesn't fire.
      'client/src/lib/other.ts': `export const x = 1;`,
    });
    const r = runIn(dir);
    expect({ status: r.status, stdout: r.stdout }).toMatchObject({
      status: 0,
      stdout: expect.stringContaining('[check-provider-not-configured] OK'),
    });
  });
});
