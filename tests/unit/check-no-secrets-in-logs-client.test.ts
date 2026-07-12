/**
 * Tests the CLIENT-surface "no secret-bearing fields in log calls"
 * guard introduced in task #515.
 *
 * Companion to the server-surface test in
 * `tests/unit/check-no-secrets-in-logs.test.ts`. The shared script
 * (`scripts/check-no-secrets-in-logs.ts`) now accepts
 * `--surface=server` (default) and `--surface=client`. The client
 * surface walks `client/src/**` and `shared/**` (both `.ts` and
 * `.tsx`) and adds patterns specific to the React frontend on top of
 * the shared shapes:
 *   - property access ending in `.currentPassword` / `.newPassword`
 *     / `.confirmPassword` (the verbatim react-hook-form field names
 *     used across the change-password / set-password / admin reset
 *     flows)
 *   - bare identifier `currentPassword` / `newPassword` /
 *     `confirmPassword` in any value-reference position
 *   - bare identifier `password` in a value-reference position where
 *     it stands alone (mirroring the server's policy on `token`)
 *   - a CallExpression of `form.getValues('password')` /
 *     `form.watch('newPassword')` / `form.getFieldState('password')`
 *     — the realistic blind-spot for `console.log('attempt',
 *     form.getValues('password'))`
 *
 * Following the same shape as the server-surface test:
 *   1. Drive `scanSource` directly against synthetic source strings
 *      with `CLIENT_SURFACE` to pin down detection logic.
 *   2. Run the CLI in advisory mode against a temp fixture to pin
 *      the exit-0-with-warnings behavior on the client surface.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { scanSource, CLIENT_SURFACE } from '../../scripts/check-no-secrets-in-logs';
import { TSX_CLI } from '../helpers/tsx-command';

const SCRIPT = join(process.cwd(), 'scripts/check-no-secrets-in-logs.ts');
// Use the locally-installed tsx binary directly instead of going
// through `npx`. When two test files spawn `npx tsx` in parallel
// against fresh `mkdtempSync` cwd's, npx's package-resolution /
// install path races and intermittently exits non-zero (status 1
// or 254). Pointing at `node_modules/.bin/tsx` skips that resolver
// entirely and keeps the spawn deterministic under file-parallelism.
function reasonsFor(src: string, file = 'client/src/fixture.ts'): string[] {
  return scanSource(file, src, CLIENT_SURFACE).flatMap((h) => h.reasons);
}

describe('check-no-secrets-in-logs CI guard (client surface)', () => {
  // ---------------------------------------------------------------
  // Shared shapes also flagged by the server surface — verified here
  // to pin that the client config preserves them (catches future
  // regressions where someone trims the client set in isolation).
  // ---------------------------------------------------------------

  it('flags console.log with body.password (shared property-access shape)', () => {
    expect(reasonsFor(`console.log('login', { pw: data.password });`)).toContain(
      'property access ending in .password',
    );
  });

  // ---------------------------------------------------------------
  // Client-only password-field property access. The change-password,
  // set-password, and admin reset-password flows all use these field
  // names verbatim on the react-hook-form controlled object.
  // ---------------------------------------------------------------

  it('flags property access ending in .currentPassword / .newPassword / .confirmPassword', () => {
    expect(
      reasonsFor(`console.log(\`pw=\${data.currentPassword}\`);`),
    ).toContain('property access ending in .currentPassword');
    expect(reasonsFor(`console.log('np', { v: data.newPassword });`)).toContain(
      'property access ending in .newPassword',
    );
    expect(
      reasonsFor(`console.log(\`cp=\${data.confirmPassword}\`);`),
    ).toContain('property access ending in .confirmPassword');
  });

  // ---------------------------------------------------------------
  // Bare `password` policy: same shape as the server's `token`
  // policy — flagged in value-reference positions, not as a
  // property-access receiver. Property-access of `.password` is
  // still caught by the shared rule.
  // ---------------------------------------------------------------

  it('flags shorthand `{ password }` (the realistic destructure-then-log blind spot)', () => {
    const reasons = reasonsFor(
      `function f() {\n` +
        `  const { password } = form.getValues();\n` +
        `  console.log('attempt', { password });\n` +
        `}`,
    );
    expect(reasons.some((r) => /shorthand property 'password'/.test(r))).toBe(
      true,
    );
  });

  it('flags bare `password` interpolated into a template / passed as a direct argument', () => {
    expect(
      reasonsFor(
        `function f(password: string) { console.log(\`pw=\${password}\`); }`,
      ),
    ).toContain("bare identifier 'password'");
    expect(
      reasonsFor(
        `function f(password: string) { console.warn('seen', password); }`,
      ),
    ).toContain("bare identifier 'password'");
  });

  it('does NOT flag bare `password` when it is the receiver of a property access', () => {
    // `password.length` is metadata (length check) — the actual
    // password bytes are not in the log line. The property-access
    // rule still catches `data.password` directly.
    expect(
      reasonsFor(
        `function f(password: string) { console.log('len', { len: password.length }); }`,
      ),
    ).toHaveLength(0);
  });

  // ---------------------------------------------------------------
  // react-hook-form value-reader detection (`form.getValues(...)` /
  // `form.watch(...)` / `form.getFieldState(...)`). This is the
  // brief's headline blind spot.
  // ---------------------------------------------------------------

  it("flags console.log(form.getValues('password'))", () => {
    expect(
      reasonsFor(`console.log('attempt', form.getValues('password'));`),
    ).toContain('form-reader call .getValues("password")');
  });

  it("does NOT flag form.getValues / form.watch on benign field names", () => {
    // `form.getValues('amount')`, `form.watch('type')` etc. are the
    // pattern across the payment forms — they must not trip.
    expect(reasonsFor(`console.log(form.getValues('amount'));`)).toHaveLength(0);
    expect(reasonsFor(`console.log(form.watch('type'));`)).toHaveLength(0);
    expect(
      reasonsFor(`console.log(form.getValues('bowlerId'));`),
    ).toHaveLength(0);
  });

  // ---------------------------------------------------------------
  // .tsx scanning — the client surface walks both .ts and .tsx,
  // and JSX in the source must not break the parse.
  // ---------------------------------------------------------------

  it('parses .tsx source without choking on JSX and still flags inline console leaks', () => {
    const src =
      `function Card({ password }: { password: string }) {\n` +
      `  console.log('mount', { password });\n` +
      `  return <div className="card">hi</div>;\n` +
      `}`;
    const reasons = reasonsFor(src, 'client/src/components/fixture.tsx');
    expect(reasons.some((r) => /shorthand property 'password'/.test(r))).toBe(
      true,
    );
  });

  it('does NOT flag JSX attribute name="password" (string-literal value, not a value reference)', () => {
    // The scanner only inspects expression nodes. A JSX attribute
    // value like `<input type="password" />` or
    // `<input name="newPassword" />` is a string-literal value, never
    // examined.
    const src =
      `function F() {\n` +
      `  console.log('render');\n` +
      `  return <input type="password" name="newPassword" />;\n` +
      `}`;
    expect(reasonsFor(src, 'client/src/components/fixture.tsx')).toHaveLength(0);
  });

  // ---------------------------------------------------------------
  // Negative cases shared with the server surface — pinned here
  // explicitly because the client config is its own object.
  // ---------------------------------------------------------------

  // ---------------------------------------------------------------
  // Helper-function call detection (task #541) on the client
  // surface. Same machinery as the server surface but the
  // forbidden-shape sets are wider — a helper that returns
  // `data.newPassword` or `form.getValues('password')` must be
  // recognized too, since those are the canonical client-only
  // forbidden shapes.
  // ---------------------------------------------------------------

  it('flags a helper that returns .currentPassword (client-only forbidden property)', () => {
    const reasons = reasonsFor(
      `function pickPw(d: any) { return d.currentPassword; }\n` +
        `console.log(\`pw=\${pickPw(data)}\`);`,
    );
    expect(
      reasons.some((r) =>
        /helper call 'pickPw\(\)' returning .*\.currentPassword/.test(r),
      ),
    ).toBe(true);
  });

  it('does NOT flag a helper that returns a benign field', () => {
    expect(
      reasonsFor(
        `function pickAmount(d: any) { return d.amount; }\n` +
          `console.log(pickAmount(data));`,
      ),
    ).toHaveLength(0);
  });

  // ---------------------------------------------------------------
  // Method-call detection (task #548) on the client surface. Same
  // machinery as the server surface but the forbidden-shape sets
  // are wider — a method that returns `data.newPassword` or
  // `form.getValues('password')` must classify the host as forbidden
  // for that method name.
  // ---------------------------------------------------------------

  it('flags a NAMESPACE-IMPORT nested object-literal `mod.helpers.pickPassword(data)` on the client surface (task #558)', () => {
    // Client-surface parity for the server-side namespace-import
    // tests in `check-no-secrets-in-logs.test.ts`. The detection
    // logic is shared, but pinning the client surface here prevents
    // future client-only forbidden-property additions (e.g.
    // `newPassword`) from silently regressing the namespace path.
    const dir = mkdtempSync(
      join(tmpdir(), 'no-secrets-in-logs-client-ns-obj-'),
    );
    const helpersFile = join(dir, 'client/src/helpers.ts');
    const componentFile = join(dir, 'client/src/Component.tsx');
    mkdirSync(dirname(helpersFile), { recursive: true });
    writeFileSync(
      helpersFile,
      `export const helpers = {\n` +
        `  pickPassword: (d: any) => d.newPassword,\n` +
        `};\n`,
    );
    writeFileSync(
      componentFile,
      `import * as mod from './helpers';\n` +
        `function F({ data }: any) {\n` +
        `  console.log('v=', mod.helpers.pickPassword(data));\n` +
        `  return null;\n` +
        `}\n`,
    );
    const reasons = scanSource(
      componentFile,
      readFileSync(componentFile, 'utf8'),
      CLIENT_SURFACE,
    ).flatMap((h) => h.reasons);
    expect(
      reasons.some((r) =>
        /method call 'mod\.helpers\.pickPassword\(\)' returning .*\.newPassword/.test(
          r,
        ),
      ),
    ).toBe(true);
  });

  // ---------------------------------------------------------------
  // Default-exported method hosts on the client (task #559) — parity
  // with the server-surface tests of the same task. The exporter
  // helper map handling is surface-agnostic, but the client surface
  // intentionally exercises a different forbidden source field
  // (`data.newPassword`) so a regression on either surface fails
  // independently of the other.
  // ---------------------------------------------------------------

  it('flags a DEFAULT-export class via `import H from … ; new H().pick(data)` on the client surface (task #559)', () => {
    const dir = mkdtempSync(
      join(tmpdir(), 'no-secrets-in-logs-client-default-host-class-'),
    );
    const helpersFile = join(dir, 'client/src/helpers.ts');
    const componentFile = join(dir, 'client/src/component.ts');
    mkdirSync(dirname(helpersFile), { recursive: true });
    writeFileSync(
      helpersFile,
      `export default class H {\n` +
        `  pick(data: any) { return data.newPassword; }\n` +
        `}\n`,
    );
    writeFileSync(
      componentFile,
      `import H from './helpers';\n` +
        `function f(data: any) { console.log(new H().pick(data)); }\n`,
    );
    const reasons = scanSource(
      componentFile,
      readFileSync(componentFile, 'utf8'),
      CLIENT_SURFACE,
    ).flatMap((h) => h.reasons);
    expect(
      reasons.some((r) =>
        /method call 'new H\(\)\.pick\(\)' returning .*\.newPassword/.test(r),
      ),
    ).toBe(true);
  });

  // ---------------------------------------------------------------
  // Suppression annotation works on the client surface too.
  // ---------------------------------------------------------------

  it('honors a trailing // secret-log-ok: <reason> annotation on the client surface', () => {
    const reasons = reasonsFor(
      `function f(csrfToken: string) {\n` +
        `  console.warn(\`csrfToken=\${csrfToken}\`); // secret-log-ok: client test fixture\n` +
        `}`,
    );
    expect(reasons).toHaveLength(0);
  });

  // ---------------------------------------------------------------
  // CLI behavior: advisory mode against a fixture under client/src.
  // ---------------------------------------------------------------

  it('exits 0 in advisory mode (no --strict) on the client surface even when violations exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'no-secrets-in-logs-client-advisory-'));
    const file = join(dir, 'client/src/foo.tsx');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      `function F({ password }: { password: string }) {\n` +
        `  console.log('hi', { password });\n` +
        `  return <span>x</span>;\n` +
        `}\n`,
    );
    const r = spawnSync(process.execPath, [TSX_CLI, SCRIPT, '--surface=client'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test' },
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/WARN.*shorthand property 'password'/);
  });
});
