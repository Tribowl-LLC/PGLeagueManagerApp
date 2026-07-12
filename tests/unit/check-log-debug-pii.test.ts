/**
 * Tests the `log.debug` PII-leak guard introduced in task #389
 * and upgraded to AST-based detection in task #405.
 *
 * The guard (`scripts/check-log-debug-pii.ts`) walks every `.ts`
 * file under `server/` (excluding `*.test.ts` and `__tests__/`),
 * extracts each `log.debug(...)` / `logger.debug(...)` call
 * expression, and fails when its argument list contains forbidden
 * identifiers (`email`, `password`, `token`, `phone`, `address`,
 * `secret`) without routing the value through a `mask*` helper or
 * carrying an inline `pii-lint-ok: …` annotation.
 *
 * These tests drive the script against synthetic fixtures via
 * spawnSync. One representative positive + negative test is kept
 * per detection bucket; the "real codebase" sanity test was
 * dropped in task #684 (covered by the `log-debug-pii` workflow).
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { TSX_CLI } from '../helpers/tsx-command';

const SCRIPT = join(process.cwd(), 'scripts/check-log-debug-pii.ts');

function runIn(
  cwd: string,
  args: string[] = [],
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [TSX_CLI, SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    // The fixture `cwd` (a tmpdir) has no local `node_modules`, so a bare
    // `npx tsx` there tries to *install* tsx and fails in clean CI. Putting
    // the repo's `node_modules/.bin` on PATH makes npx run the already-
    // installed tsx binary directly instead of reaching for the network.
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PATH: `${join(process.cwd(), 'node_modules/.bin')}${delimiter}${process.env.PATH ?? ''}`,
    },
  });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

function makeFixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'log-debug-pii-'));
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return dir;
}

describe('check-log-debug-pii CI guard', () => {
  // ---------------------------------------------------------------
  // Per-token detection (POSITIVE, parameterized over all forbidden
  // tokens). One assertion per token covers the per-bucket positive
  // case so we don't need a dedicated test per keyword.
  // ---------------------------------------------------------------
  it.each([
    ['email', 'log.debug(`hi ${user.email}`);'],
    ['password', 'log.debug(`pw=${plaintextPassword}`);'],
    ['token', 'log.debug(`token=${resetToken}`);'],
    ['phone', 'log.debug(`phone=${user.phone}`);'],
    ['address', 'log.debug(`addr=${user.address}`);'],
    ['secret', 'log.debug(`shared secret: ${s}`);'],
  ])('flags %s in a log.debug payload', (kw, callExpr) => {
    const dir = makeFixture({
      'server/foo.ts': `import { log } from './logger.js';\nfunction f() {\n  ${callExpr}\n}\n`,
    });
    const r = runIn(dir, ['--strict']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(new RegExp(`contains.*${kw}`));
  });

  // Mask exemption — NEGATIVE: a real `mask*(...)` call exempts the
  // value subtree from leak detection.
  it('exempts a call that routes the value through a mask* helper', () => {
    const dir = makeFixture({
      'server/foo.ts': `import { log } from './logger.js';
import { maskEmail } from './pii.js';
log.debug(\`user email: \${maskEmail(u.email)}\`);
`,
    });
    const r = runIn(dir, ['--strict']);
    expect(r.status, r.stderr || r.stdout).toBe(0);
  });

  // Mask look-alike — POSITIVE: only `mask` followed by an uppercase
  // letter exempts; `unmaskedEmail` does NOT.
  it('does NOT exempt look-alike helpers like unmaskedEmail()', () => {
    const dir = makeFixture({
      'server/foo.ts': `import { log } from './logger.js';
log.debug(\`user email: \${unmaskedEmail(u.email)}\`);
`,
    });
    const r = runIn(dir, ['--strict']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/contains.*email/);
  });

  // Multi-line + template literals — POSITIVE: the AST scanner must
  // walk multi-line calls and template-literal interpolations.
  it('handles multi-line log.debug calls with template-literal interpolation', () => {
    const dir = makeFixture({
      'server/foo.ts': `import { log } from './logger.js';
log.debug(
  \`Multi-line debug:
   userEmail=\${user.email}
   userId=\${user.id}\`,
  { extra: { phone: user.phone } },
);
`,
    });
    const r = runIn(dir, ['--strict']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/email/);
    expect(r.stderr).toMatch(/phone/);
  });

  // Out-of-scope levels — NEGATIVE: only debug calls are scanned.
  it('does not flag log.info or log.warn (out of scope)', () => {
    const dir = makeFixture({
      'server/foo.ts': `import { log } from './logger.js';
log.info(\`user email \${u.email}\`);
log.warn(\`user phone \${u.phone}\`);
`,
    });
    const r = runIn(dir, ['--strict']);
    expect(r.status, r.stderr || r.stdout).toBe(0);
  });

  // Test-file skipping — NEGATIVE: `*.test.ts` and `__tests__/` are
  // excluded from the scan.
  it('skips *.test.ts files', () => {
    const dir = makeFixture({
      'server/foo.test.ts': `import { log } from './logger.js';
log.debug(\`test only \${user.email}\`);
`,
    });
    const r = runIn(dir, ['--strict']);
    expect(r.status, r.stderr || r.stdout).toBe(0);
  });

  // Advisory mode — NEGATIVE: without `--strict` the script emits
  // WARN lines but exits 0.
  it('exits 0 in advisory mode (no --strict) even when violations exist', () => {
    const dir = makeFixture({
      'server/foo.ts': `import { log } from './logger.js';
log.debug(\`email=\${u.email}\`);
`,
    });
    const r = runIn(dir);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/WARN.*email/);
  });

  // pii-lint-ok bypass — POSITIVE: a `pii-lint-ok` substring inside a
  // string payload (not a real comment) must NOT suppress.
  it('does NOT honor pii-lint-ok when it appears inside a string payload', () => {
    const dir = makeFixture({
      'server/foo.ts': `import { log } from './logger.js';
log.debug('pii-lint-ok email=' + user.email);
`,
    });
    const r = runIn(dir, ['--strict']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/email/);
  });

  // Auditability — POSITIVE: `pii-lint-ok` without a non-empty reason
  // must NOT suppress.
  it('rejects an empty pii-lint-ok annotation with no reason', () => {
    const dir = makeFixture({
      'server/foo.ts': `import { log } from './logger.js';
log.debug(\`pw=\${user.password}\`); // pii-lint-ok:
log.debug(\`pw=\${user.password}\`); // pii-lint-ok
`,
    });
    const r = runIn(dir, ['--strict']);
    expect(r.status).toBe(1);
    const fails = r.stderr.match(/FAIL:.*password/g) ?? [];
    expect(fails.length).toBe(2);
  });

  // Unicode escape decoding — POSITIVE: `user.\u0065mail` is still
  // `user.email` after decoding, so the leak must still be caught.
  it('decodes \\uXXXX escapes so a code identifier like user.\\u0065mail still flags', () => {
    const dir = makeFixture({
      'server/foo.ts':
        "import { log } from './logger.js';\n" +
        'log.debug(`leaked=${user.\\u0065mail}`);\n',
    });
    const r = runIn(dir, ['--strict']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/email/);
  });

  // Optional-chaining call shape — POSITIVE: `log?.debug(...)` is
  // still a debug call.
  it('matches optional-chaining call shape `log?.debug(...)`', () => {
    const dir = makeFixture({
      'server/foo.ts': `import { log } from './logger.js';
log?.debug(\`leaked=\${user.email}\`);
`,
    });
    const r = runIn(dir, ['--strict']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/email/);
  });

  // Comment skipping — NEGATIVE: a `log.debug(...)` example inside
  // a comment is documentation, not a real call site.
  it('does not match log.debug inside a comment or block string', () => {
    const dir = makeFixture({
      'server/foo.ts': `import { log } from './logger.js';
/**
 * Example: log.debug(\`email=\${u.email}\`); // never do this
 */
// also ok: log.debug('password=' + p);
log.debug(\`bowler=\${bowlerId}\`);
`,
    });
    const r = runIn(dir, ['--strict']);
    expect(r.status, r.stderr || r.stdout).toBe(0);
  });

  // Per-argument mask exemption — POSITIVE: a `mask*` call only
  // exempts its own subtree, not sibling arguments.
  it('per-argument: a mask* call on one argument does NOT exempt sibling arguments', () => {
    const dir = makeFixture({
      'server/foo.ts': `import { log } from './logger.js';
import { maskEmail } from './pii.js';
log.debug(\`for \${maskEmail(user.email)}\`, { phone: u.phone });
`,
    });
    const r = runIn(dir, ['--strict']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/contains phone/);
    expect(r.stderr).not.toMatch(/contains email/);
  });

  // Aliased debug call — POSITIVE: a debug alias bound via
  // `const d = log.debug` is still a debug call.
  it('detects aliased debug calls reached through `const d = log.debug`', () => {
    const dir = makeFixture({
      'server/foo.ts': `import { log } from './logger.js';
const d = log.debug;
d(\`leaked=\${user.email}\`);
`,
    });
    const r = runIn(dir, ['--strict']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/email/);
  });

  // Alias misclassification guard — NEGATIVE: a bare `debug` bound to
  // an unrelated function must NOT become a false positive.
  it('does NOT misclassify an unrelated identifier as a debug alias', () => {
    const dir = makeFixture({
      'server/foo.ts': `import { log } from './logger.js';
const debug = (msg: string) => msg;
debug(\`leaked email=\${user.email}\`);
log.debug('safe', { id: 1 });
`,
    });
    const r = runIn(dir, ['--strict']);
    expect(r.status, r.stderr || r.stdout).toBe(0);
  });

  // Scope-aware alias resolution — NEGATIVE: an inner shadowing
  // binding hides the outer alias, so only the genuine outer-alias
  // call is flagged.
  it('alias resolution is scope-aware: an inner shadowing binding hides the outer alias', () => {
    const dir = makeFixture({
      'server/foo.ts': `import { log } from './logger.js';
const d = log.debug;
function leaky() {
  d(\`leaked email=\${user.email}\`);
}
function shadowedParam(d: (m: string) => void) {
  d(\`unrelated email=\${user.email}\`);
}
function shadowedConst() {
  const d = (m: string) => m;
  d(\`unrelated email=\${user.email}\`);
}
`,
    });
    const r = runIn(dir, ['--strict']);
    expect(r.status).toBe(1);
    const fails = r.stderr.match(/FAIL:.*email/g) ?? [];
    expect(fails.length).toBe(1);
    expect(r.stderr).toMatch(/foo\.ts:4/);
    expect(r.stderr).not.toMatch(/foo\.ts:7/);
    expect(r.stderr).not.toMatch(/foo\.ts:11/);
  });
});
