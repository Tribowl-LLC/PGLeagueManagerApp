/**
 * Tests the not-found error-code drift CI guard introduced in task
 * #552 (`scripts/check-not-found-code.ts`).
 *
 * The guard walks every `.ts` file under `server/routes/`, finds
 * each `sendError(...)` call whose status arg is the literal `404`,
 * and asserts the code (4th) arg is in the allow-list:
 *   { 'NOT_FOUND', 'USER_NOT_FOUND', 'LEAGUE_NOT_FOUND',
 *     'RECEIPT_UNAVAILABLE' }
 * Any drift always fails — the prior `KNOWN_VIOLATIONS` baseline
 * was retired in task #557 once `server/routes/organizations-public.ts`
 * (the last `'NotFound'` site) flipped to the canonical code.
 *
 * These tests:
 *   1. Run the real script against the real codebase. This is the
 *      primary forcing function: a future PR that lands a route
 *      doing `sendError(res, msg, 404, 'NotFound')` (or omits the
 *      code entirely) will fail this test. Wired here (and not via
 *      an `npm run check:not-found-code` shortcut) because
 *      `package.json` is locked in this environment; CI also runs
 *      the script directly via `npx tsx`.
 *   2. Drive the script against synthetic fixtures via spawnSync to
 *      pin its detection logic for: canonical `'NOT_FOUND'`,
 *      allow-listed alternatives, missing-code-arg, drift casings,
 *      non-literal code (warning path), 404 on a non-routes path
 *      (out-of-scope), and non-404 sendError (ignored). Each
 *      fixture builds a self-contained mini-project so the test
 *      doesn't depend on the live codebase.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { TSX_CLI } from '../helpers/tsx-command';

const SCRIPT = join(process.cwd(), 'scripts/check-not-found-code.ts');

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
  const dir = mkdtempSync(join(tmpdir(), 'check-not-found-code-'));
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return dir;
}

// Tiny `sendError` stub the fixtures import. The guard never
// executes the code — it parses syntactically — so the body is
// irrelevant. Kept so each fixture is a real (if tiny) compilable
// TypeScript file matching the production call shape.
const SEND_ERROR_STUB = `
export function sendError(
  _res: unknown,
  _message: string,
  _status: number = 500,
  _code: string = 'ServerError',
  _details?: unknown,
): void {}
`;

describe('check-not-found-code (synthetic fixtures)', () => {
  it("passes when every 404 site uses 'NOT_FOUND' or an allow-listed alternative", () => {
    const dir = makeFixture({
      'server/utils/api.ts': SEND_ERROR_STUB,
      'server/routes/clean.ts': `import { sendError } from '../utils/api';
export function a(res: unknown) { return sendError(res, 'x', 404, 'NOT_FOUND'); }
export function b(res: unknown) { return sendError(res, 'x', 404, 'USER_NOT_FOUND'); }
export function c(res: unknown) { return sendError(res, 'x', 404, 'LEAGUE_NOT_FOUND'); }
export function d(res: unknown) { return sendError(res, 'x', 404, 'RECEIPT_UNAVAILABLE'); }
// Double-quoted variant — the allow-list checks string text not the quote style.
export function e(res: unknown) { return sendError(res, 'x', 404, "NOT_FOUND"); }
`,
    });
    const r = runIn(dir);
    expect({ status: r.status, stdout: r.stdout }).toMatchObject({
      status: 0,
      stdout: expect.stringContaining('[check-not-found-code] OK'),
    });
  });

  it("fails on the canonical drift case: code arg is 'NotFound' (camelCase)", () => {
    const dir = makeFixture({
      'server/utils/api.ts': SEND_ERROR_STUB,
      'server/routes/drift.ts': `import { sendError } from '../utils/api';
export function bad(res: unknown) {
  return sendError(res, 'x', 404, 'NotFound');
}
`,
    });
    const r = runIn(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/FAIL/);
    expect(r.stderr).toMatch(/server\/routes\/drift\.ts:3/);
    expect(r.stderr).toMatch(/'NotFound'/);
    expect(r.stderr).toMatch(/not in the allow-list/);
  });

  it("fails on lowercase 'not_found' drift", () => {
    const dir = makeFixture({
      'server/utils/api.ts': SEND_ERROR_STUB,
      'server/routes/lower.ts': `import { sendError } from '../utils/api';
export function bad(res: unknown) { return sendError(res, 'x', 404, 'not_found'); }
`,
    });
    const r = runIn(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("'not_found'");
  });

  it('fails on a one-off code like FOO_BAR with status 404', () => {
    const dir = makeFixture({
      'server/utils/api.ts': SEND_ERROR_STUB,
      'server/routes/foo.ts': `import { sendError } from '../utils/api';
export function bad(res: unknown) { return sendError(res, 'x', 404, 'FOO_BAR'); }
`,
    });
    const r = runIn(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("'FOO_BAR'");
  });

  it('fails when the code argument is missing (sendError defaults to ServerError)', () => {
    const dir = makeFixture({
      'server/utils/api.ts': SEND_ERROR_STUB,
      'server/routes/missing.ts': `import { sendError } from '../utils/api';
export function bad(res: unknown) {
  return sendError(res, 'x', 404);
}
`,
    });
    const r = runIn(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/missing code argument/);
    expect(r.stderr).toMatch(/server\/routes\/missing\.ts:3/);
  });

  it('flags a non-string-literal code arg with the warning-path message', () => {
    const dir = makeFixture({
      'server/utils/api.ts': SEND_ERROR_STUB,
      'server/routes/expr.ts': `import { sendError } from '../utils/api';
const CODE = 'NOT_FOUND';
export function expr(res: unknown) { return sendError(res, 'x', 404, CODE); }
`,
    });
    const r = runIn(dir);
    expect(r.status).toBe(1);
    // The warning quotes the SyntaxKind name (Identifier) and tells
    // the contributor either to inline the literal or extend the
    // guard's allow-list logic.
    expect(r.stderr).toMatch(/code argument is not a string literal/);
    expect(r.stderr).toMatch(/Identifier/);
  });

  it('ignores sendError calls whose status is not 404', () => {
    const dir = makeFixture({
      'server/utils/api.ts': SEND_ERROR_STUB,
      'server/routes/other.ts': `import { sendError } from '../utils/api';
// 400 with a non-allow-listed code is fine — the guard scopes to 404.
export function a(res: unknown) { return sendError(res, 'x', 400, 'BadRequest'); }
// 500 with no code is fine — the guard never inspects this branch.
export function b(res: unknown) { return sendError(res, 'x', 500); }
`,
    });
    const r = runIn(dir);
    expect({ status: r.status, stdout: r.stdout }).toMatchObject({
      status: 0,
      stdout: expect.stringContaining('[check-not-found-code] OK'),
    });
  });

  it('only scans server/routes — a 404 drift outside that tree is invisible', () => {
    const dir = makeFixture({
      'server/utils/api.ts': SEND_ERROR_STUB,
      // A real route file with a clean 404 so the scan root has at
      // least one file to walk (otherwise the "no .ts files" sanity
      // bottom fires and the script exits 2).
      'server/routes/ok.ts': `import { sendError } from '../utils/api';
export function ok(res: unknown) { return sendError(res, 'x', 404, 'NOT_FOUND'); }
`,
      // Drift in server/middleware/ should be ignored — out of scope
      // for this guard.
      'server/middleware/something.ts': `import { sendError } from '../utils/api';
export function bad(res: unknown) { return sendError(res, 'x', 404, 'NotFound'); }
`,
    });
    const r = runIn(dir);
    expect({ status: r.status, stdout: r.stdout }).toMatchObject({
      status: 0,
      stdout: expect.stringContaining('[check-not-found-code] OK'),
    });
  });

  it('fails loud (exit 2) when server/routes has no .ts files (refuses to silently pass)', () => {
    const dir = makeFixture({
      'server/utils/api.ts': SEND_ERROR_STUB,
      // No server/routes content at all — script should refuse to
      // run rather than silently pretend everything's clean.
      'server/routes/.gitkeep': '',
    });
    const r = runIn(dir);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/no \.ts files found/);
  });

  it('--report mode prints violations but exits 0', () => {
    const dir = makeFixture({
      'server/utils/api.ts': SEND_ERROR_STUB,
      'server/routes/drift.ts': `import { sendError } from '../utils/api';
export function bad(res: unknown) { return sendError(res, 'x', 404, 'NotFound'); }
`,
    });
    const r = runIn(dir, ['--report']);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/REPORT/);
    expect(r.stderr).toMatch(/'NotFound'/);
  });

  it('handles multiple drift sites in the same file and reports each one', () => {
    const dir = makeFixture({
      'server/utils/api.ts': SEND_ERROR_STUB,
      'server/routes/many.ts': `import { sendError } from '../utils/api';
export function a(res: unknown) { return sendError(res, 'x', 404, 'NotFound'); }
export function b(res: unknown) { return sendError(res, 'y', 404, 'OTHER'); }
export function c(res: unknown) { return sendError(res, 'z', 404); }
`,
    });
    const r = runIn(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/3 404 sendError site\(s\)/);
    expect(r.stderr).toMatch(/server\/routes\/many\.ts:2/);
    expect(r.stderr).toMatch(/server\/routes\/many\.ts:3/);
    expect(r.stderr).toMatch(/server\/routes\/many\.ts:4/);
  });

  it('ignores .test.ts and .d.ts files inside server/routes', () => {
    const dir = makeFixture({
      'server/utils/api.ts': SEND_ERROR_STUB,
      'server/routes/ok.ts': `import { sendError } from '../utils/api';
export function ok(res: unknown) { return sendError(res, 'x', 404, 'NOT_FOUND'); }
`,
      // A drift site in a sibling .test.ts file — should be skipped
      // so production guards don't cascade into test fixtures.
      'server/routes/legacy.test.ts': `import { sendError } from '../utils/api';
export function bad(res: unknown) { return sendError(res, 'x', 404, 'NotFound'); }
`,
      'server/routes/types.d.ts': `export type Foo = number;`,
    });
    const r = runIn(dir);
    expect({ status: r.status, stdout: r.stdout }).toMatchObject({
      status: 0,
      stdout: expect.stringContaining('[check-not-found-code] OK'),
    });
  });

  it('treats nested route files (e.g. server/routes/payments/foo.ts) the same as top-level', () => {
    const dir = makeFixture({
      'server/utils/api.ts': SEND_ERROR_STUB,
      'server/routes/nested/dir/file.ts': `import { sendError } from '../../../utils/api';
export function bad(res: unknown) { return sendError(res, 'x', 404, 'NotFound'); }
`,
    });
    const r = runIn(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/server\/routes\/nested\/dir\/file\.ts:2/);
  });
});
