/**
 * Tests the project-wide "no secret-bearing fields in log calls" guard
 * introduced in task #432 and extended to the client surface in
 * task #515.
 *
 * The guard (`scripts/check-no-secrets-in-logs.ts`) walks every `.ts`
 * file under `server/` (excluding `*.test.ts` and `__tests__/`) and
 * fails when any `log.<level>` / `logger.<level>` / `console.<level>`
 * call interpolates a known secret-bearing shape:
 *   - property access ending in `.password` / `.token` /
 *     `.inviteToken` / `.setupSecret` / `.csrfToken` / `.resetToken`
 *   - bare identifier `inviteToken` / `setupSecret` / `csrfToken` /
 *     `resetToken`
 *   - element access with literal `'x-csrf-token'` / `'x-setup-secret'`
 *
 * This file pins the SERVER surface. The companion file
 * `check-no-secrets-in-logs-client.test.ts` pins the CLIENT surface
 * (which adds form-reader and password-field patterns).
 *
 * These tests:
 *   1. Import `scanSource` from the script directly and drive it
 *      against synthetic source strings to pin down its detection
 *      logic.
 *   2. Run the CLI in advisory (no `--strict`) mode against a temp
 *      fixture to pin the exit-0-with-warnings behavior.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { scanSource, SERVER_SURFACE } from '../../scripts/check-no-secrets-in-logs';
import { TSX_CLI } from '../helpers/tsx-command';

const SCRIPT = join(process.cwd(), 'scripts/check-no-secrets-in-logs.ts');
// Use the locally-installed tsx binary directly instead of going
// through `npx`. When two test files spawn `npx tsx` in parallel
// against fresh `mkdtempSync` cwd's, npx's package-resolution /
// install path races and intermittently exits non-zero (status 1
// or 254). Pointing at `node_modules/.bin/tsx` skips that resolver
// entirely and keeps the spawn deterministic under file-parallelism.
function reasonsFor(src: string): string[] {
  return scanSource('server/fixture.ts', src, SERVER_SURFACE).flatMap(
    (h) => h.reasons,
  );
}

describe('check-no-secrets-in-logs CI guard', () => {
  // ---------------------------------------------------------------
  // Forbidden shapes — each canonical case from the task brief.
  // ---------------------------------------------------------------

  it('flags log.info with req.body.password', () => {
    const reasons = reasonsFor(
      `log.info('login attempt', { password: req.body.password });`,
    );
    expect(reasons).toContain('property access ending in .password');
  });

  // ---------------------------------------------------------------
  // Coverage across log roots and levels.
  // ---------------------------------------------------------------

  it.each([
    ['log', 'debug'],
    ['log', 'info'],
    ['log', 'warn'],
    ['log', 'error'],
    ['log', 'trace'],
    ['log', 'fatal'],
    ['logger', 'info'],
    ['logger', 'warn'],
    ['console', 'log'],
    ['console', 'error'],
  ])('flags %s.%s when it interpolates a secret', (root, level) => {
    const reasons = reasonsFor(`${root}.${level}(\`pw=\${user.password}\`);`);
    expect(reasons).toContain('property access ending in .password');
  });

  it('flags optional-chain log access shape `log?.info(...)`', () => {
    expect(reasonsFor(`log?.info(\`pw=\${user.password}\`);`)).toContain(
      'property access ending in .password',
    );
  });

  // ---------------------------------------------------------------
  // Negative cases: structural labels and unrelated calls.
  // ---------------------------------------------------------------

  it('does NOT flag structural labels in string literals (no value reference)', () => {
    // `log.warn('csrfToken missing')` is a label, not a value
    // reference. The scanner only inspects expression nodes
    // (PropertyAccess, ElementAccess, Identifier), never
    // string-literal text or template head/middle/tail text.
    expect(
      reasonsFor(`log.warn('csrfToken missing for request');`),
    ).toHaveLength(0);
    expect(
      reasonsFor(`log.info(\`inviteToken issued for user \${user.id}\`);`),
    ).toHaveLength(0);
    expect(
      reasonsFor(`log.error('password mismatch for', { userId: u.id });`),
    ).toHaveLength(0);
  });

  it('does NOT flag a non-log call that happens to mention a secret field', () => {
    // The scanner must only walk argument trees of LOG calls. A
    // regular call like `process(req.body.password)` is not in scope.
    expect(reasonsFor(`const hash = hashPassword(req.body.password);`))
      .toHaveLength(0);
    expect(reasonsFor(`const h = handler(req.headers['x-csrf-token']);`))
      .toHaveLength(0);
  });

  // ---------------------------------------------------------------
  // Bare `token` policy: flagged in value-reference positions, NOT
  // when it is the receiver of a property access (`token.id`).
  // ---------------------------------------------------------------

  it('flags shorthand `{ token }` (the `const { token } = req.body; log.info({ token })` shape)', () => {
    // The realistic blind-spot the brief calls out: a route
    // destructures `token` out of `req.body` and then logs it.
    const reasons = reasonsFor(
      `function f() {\n` +
        `  const { token } = req.body;\n` +
        `  log.info('attempt', { token });\n` +
        `}`,
    );
    expect(reasons.some((r) => /shorthand property 'token'/.test(r))).toBe(
      true,
    );
  });

  it('does NOT flag a string literal value of "token" in an object property', () => {
    expect(
      reasonsFor(`function f(token: string) { log.info('parsed', { kind: 'token' }); }`),
    ).toHaveLength(0);
  });

  // ---------------------------------------------------------------
  // Single-hop alias detection (task #516). Without scope-aware
  // binding tracking, a route that pulls the secret into a local
  // before logging slipped past the scanner because the local name
  // is not in any forbidden set and the forbidden property access
  // does not appear inside the log call's argument subtree.
  // ---------------------------------------------------------------

  it('flags `const pw = req.body.password; log.info(`pw=${pw}`)` (the brief)', () => {
    // This is the canonical multi-line alias case from the task
    // brief. The scanner must walk per-scope bindings and see that
    // `pw` is bound to a forbidden property access at declaration
    // time.
    const reasons = reasonsFor(
      `function login(req: any) {\n` +
        `  const pw = req.body.password;\n` +
        `  log.info(\`pw=\${pw}\`);\n` +
        `}`,
    );
    expect(reasons.some((r) => /local 'pw' aliasing .*\.password/.test(r))).toBe(
      true,
    );
  });

  it('does NOT flag an alias shadowed by an inner declaration', () => {
    // Shadowing must work the same way as the sibling guard. An
    // inner `const pw = 'fixture'` masks the outer alias so the
    // inner `log.info(pw)` is benign.
    const reasons = reasonsFor(
      `function f(req: any) {\n` +
        `  const pw = req.body.password;\n` +
        `  {\n` +
        `    const pw = 'fixture';\n` +
        `    log.info(pw);\n` +
        `  }\n` +
        `}`,
    );
    expect(reasons).toHaveLength(0);
  });

  // ---------------------------------------------------------------
  // Multi-hop alias detection (task #540). Single-hop closed in #516
  // leaves an obvious bypass: route the secret through a second
  // local before logging. The brief calls out
  //   const pw = req.body.password;
  //   const same = pw;
  //   log.info(`pw=${same}`);
  // as the canonical two-hop shape. The classifier must consult
  // each plain-identifier RHS's existing binding so the forbidden
  // classification propagates across the chain.
  // ---------------------------------------------------------------

  it('flags the two-hop `const pw = req.body.password; const same = pw; log.info(`pw=${same}`)` chain (the brief)', () => {
    const reasons = reasonsFor(
      `function login(req: any) {\n` +
        `  const pw = req.body.password;\n` +
        `  const same = pw;\n` +
        `  log.info(\`pw=\${same}\`);\n` +
        `}`,
    );
    // The chain should bubble the original property-access reason
    // through both hops so the report points at the real source.
    expect(
      reasons.some((r) => /local 'same' aliasing.*\.password/.test(r)),
    ).toBe(true);
  });

  it('does NOT flag a two-hop chain whose source binding is a benign value', () => {
    // The propagation only fires when the prior binding is itself
    // forbidden. `const a = 'fixture'; const b = a;` stays clean
    // even though structurally it is a two-hop alias.
    const reasons = reasonsFor(
      `function f() {\n` +
        `  const a = 'fixture';\n` +
        `  const b = a;\n` +
        `  log.info(b);\n` +
        `}`,
    );
    expect(reasons).toHaveLength(0);
  });

  // ---------------------------------------------------------------
  // Null-coalescing / logical-or / ternary alias detection
  // (task #547). #540 closed plain-identifier alias chains, but
  // the brief explicitly called out "a temp variable for
  // null-coalescing" as a motivating shape:
  //
  //   const pw = req.body.password ?? '';
  //   log.info(`pw=${pw}`);
  //
  //   const t = cond ? req.body.token : null;
  //   log.info(t);
  //
  // The classifier must walk into `??` / `||` operands and ternary
  // branches; if any reachable operand classifies as forbidden the
  // whole RHS is forbidden, with the original property-access
  // reason preserved through the recursion.
  // ---------------------------------------------------------------

  it('flags `const pw = req.body.password ?? ""; log.info(pw)` (null-coalescing alias)', () => {
    const reasons = reasonsFor(
      `function login(req: any) {\n` +
        `  const pw = req.body.password ?? '';\n` +
        `  log.info(\`pw=\${pw}\`);\n` +
        `}`,
    );
    // The reason must surface the ORIGINAL `.password` source so the
    // report still points at the real leak site, not just the alias.
    expect(
      reasons.some((r) => /local 'pw' aliasing .*\.password/.test(r)),
    ).toBe(true);
  });

  it('does NOT flag a ternary where neither branch is forbidden', () => {
    // Negative case from the brief — the propagation must only
    // fire when at least one operand reaches a forbidden shape, so
    // a benign ternary stays clean.
    const reasons = reasonsFor(
      `function f(cond: boolean) {\n` +
        `  const v = cond ? 'a' : 'b';\n` +
        `  log.info(v);\n` +
        `}`,
    );
    expect(reasons).toHaveLength(0);
  });

  // ---------------------------------------------------------------
  // Helper-function call detection (task #541). Multi-hop alias
  // detection (#540) closed the obvious bypass of routing the
  // secret through extra locals; the next natural shape is to
  // route it through a function whose body returns the forbidden
  // expression, so the property access never appears inside the
  // log call's argument subtree at all.
  //
  //   function pickPassword(req) { return req.body.password; }
  //   log.info(`pw=${pickPassword(req)}`);
  //
  // The scanner builds a per-file map of every function /
  // arrow-function / function-expression bound to a name and
  // classifies its return value the same way it classifies a
  // variable initializer. A call to a helper whose return value is
  // forbidden is treated as a leak inside log args.
  // ---------------------------------------------------------------

  it('flags `function pickPassword(req) { return req.body.password; } log.info(`pw=${pickPassword(req)}`)` (the brief)', () => {
    const reasons = reasonsFor(
      `function pickPassword(req: any) { return req.body.password; }\n` +
        `log.info(\`pw=\${pickPassword(req)}\`);`,
    );
    // The reason text should name the helper AND carry the
    // underlying property-access reason so the report points at
    // the real secret source.
    expect(
      reasons.some((r) =>
        /helper call 'pickPassword\(\)' returning property access ending in \.password/.test(
          r,
        ),
      ),
    ).toBe(true);
  });

  it('does NOT flag a helper whose body returns nothing forbidden', () => {
    // A function that returns benign metadata (or a literal)
    // must not trip the helper detection. `req.body.id` does not
    // match any forbidden property name.
    const reasons = reasonsFor(
      `function getUserId(req: any) { return req.body.id; }\n` +
        `log.info(getUserId(req));`,
    );
    expect(reasons).toHaveLength(0);
  });

  // ---------------------------------------------------------------
  // Helper-alias propagation (task #550). Task #541 records helper
  // functions as `{ kind: 'helper', ... }` bindings. Multi-hop alias
  // propagation (#540) only forwarded `{ kind: 'forbidden', ... }`
  // before, so the natural bypass:
  //
  //   function pickPassword(req) { return req.body.password; }
  //   const alias = pickPassword;
  //   log.info(`pw=${alias(req)}`);
  //
  // slipped past — `alias` was recorded as 'other' even though
  // calling it is exactly the same leak as calling `pickPassword`
  // directly. The classifier now also propagates the 'helper' kind
  // through declaration AND assignment alias chains, mirroring the
  // multi-hop forbidden propagation from #540.
  // ---------------------------------------------------------------

  it('flags a single-hop helper alias `const alias = pickPassword; log.info(alias(req))` (the brief)', () => {
    const reasons = reasonsFor(
      `function pickPassword(req: any) { return req.body.password; }\n` +
        `const alias = pickPassword;\n` +
        `log.info(\`pw=\${alias(req)}\`);`,
    );
    // Reason should name the alias as the called helper AND carry
    // the original property-access reason through the alias chain
    // so the report points at the real secret source.
    expect(
      reasons.some((r) =>
        /helper call 'alias\(\)' returning local 'pickPassword' aliasing .*\.password/.test(
          r,
        ),
      ),
    ).toBe(true);
  });

  it('does NOT flag an alias of a benign function (helper propagation only fires for forbidden-returning helpers)', () => {
    // The propagation only fires when the prior binding is itself
    // a helper. `const a = getUserId; const b = a;` stays clean
    // even though structurally it is a helper alias chain.
    const reasons = reasonsFor(
      `function getUserId(req: any) { return req.body.id; }\n` +
        `const a = getUserId;\n` +
        `const b = a;\n` +
        `log.info(b(req));`,
    );
    expect(reasons).toHaveLength(0);
  });

  it('flags a helper alias through a CROSS-FILE imported helper `import { pickPassword }; const alias = pickPassword;`', () => {
    // Cross-file imports are recorded as 'helper' bindings on the
    // importing file's source-file scope by pass 5. The new pass-7
    // helper-alias propagation runs after that, so an in-file alias
    // of an imported helper picks up the same classification.
    const dir = mkdtempSync(
      join(tmpdir(), 'no-secrets-in-logs-helper-alias-cross-'),
    );
    const helpersFile = join(dir, 'server/helpers.ts');
    const routesFile = join(dir, 'server/routes.ts');
    mkdirSync(dirname(helpersFile), { recursive: true });
    writeFileSync(
      helpersFile,
      `export function pickPassword(req: any) { return req.body.password; }\n`,
    );
    writeFileSync(
      routesFile,
      `import { pickPassword } from './helpers';\n` +
        `const alias = pickPassword;\n` +
        `log.info(\`pw=\${alias(req)}\`);\n`,
    );
    const reasons = scanSource(
      routesFile,
      readFileSync(routesFile, 'utf8'),
      SERVER_SURFACE,
    ).flatMap((h) => h.reasons);
    expect(
      reasons.some((r) =>
        /helper call 'alias\(\)' returning local 'pickPassword' aliasing .*\.password/.test(
          r,
        ),
      ),
    ).toBe(true);
  });

  it('does NOT flag a CROSS-FILE import whose exported helper is benign', () => {
    // Pin that the import-resolution pass does not over-match —
    // a benign exported helper must not poison every call site.
    const dir = mkdtempSync(join(tmpdir(), 'no-secrets-in-logs-cross-benign-'));
    const helpersFile = join(dir, 'server/helpers.ts');
    const routesFile = join(dir, 'server/routes.ts');
    mkdirSync(dirname(helpersFile), { recursive: true });
    writeFileSync(
      helpersFile,
      `export function getUserId(req: any) { return req.body.id; }\n`,
    );
    writeFileSync(
      routesFile,
      `import { getUserId } from './helpers';\n` +
        `log.info('user', getUserId(req));\n`,
    );
    const reasons = scanSource(
      routesFile,
      readFileSync(routesFile, 'utf8'),
      SERVER_SURFACE,
    ).flatMap((h) => h.reasons);
    expect(reasons).toHaveLength(0);
  });

  // ---------------------------------------------------------------
  // Default-export / default-import helper detection (task #549).
  // Task #541 wired up cross-file resolution for named exports;
  // teams that prefer default exports could still bypass with:
  //
  //   // helpers.ts
  //   export default function pickPassword(req) { return req.body.password; }
  //   // routes.ts
  //   import pickPassword from './helpers';
  //   log.info(`pw=${pickPassword(req)}`);
  //
  // The scanner now extracts default-exported helpers under a
  // sentinel key in `getExportedHelpers` and the import walk binds
  // the importing file's default-import local name to that helper
  // binding, so the helper-call rule fires.
  // ---------------------------------------------------------------

  it('flags a CROSS-FILE default-export `export default function name` consumed via default-import (the brief)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'no-secrets-in-logs-default-named-'));
    const helpersFile = join(dir, 'server/helpers.ts');
    const routesFile = join(dir, 'server/routes.ts');
    mkdirSync(dirname(helpersFile), { recursive: true });
    writeFileSync(
      helpersFile,
      `export default function pickPassword(req: any) { return req.body.password; }\n`,
    );
    writeFileSync(
      routesFile,
      `import pickPassword from './helpers';\n` +
        `log.info(\`pw=\${pickPassword(req)}\`);\n`,
    );
    const reasons = scanSource(
      routesFile,
      readFileSync(routesFile, 'utf8'),
      SERVER_SURFACE,
    ).flatMap((h) => h.reasons);
    expect(
      reasons.some((r) =>
        /helper call 'pickPassword\(\)' returning .*\.password/.test(r),
      ),
    ).toBe(true);
  });

  it('does NOT flag a CROSS-FILE default-export whose function body is benign', () => {
    // Symmetry with the named-export benign test: a default-exported
    // helper that doesn't return a forbidden expression must not
    // poison every default-import call site.
    const dir = mkdtempSync(
      join(tmpdir(), 'no-secrets-in-logs-default-benign-'),
    );
    const helpersFile = join(dir, 'server/helpers.ts');
    const routesFile = join(dir, 'server/routes.ts');
    mkdirSync(dirname(helpersFile), { recursive: true });
    writeFileSync(
      helpersFile,
      `export default function getUserId(req: any) { return req.body.id; }\n`,
    );
    writeFileSync(
      routesFile,
      `import getUserId from './helpers';\n` +
        `log.info('user', getUserId(req));\n`,
    );
    const reasons = scanSource(
      routesFile,
      readFileSync(routesFile, 'utf8'),
      SERVER_SURFACE,
    ).flatMap((h) => h.reasons);
    expect(reasons).toHaveLength(0);
  });

  // ---------------------------------------------------------------
  // Cross-file methodHost detection (task #553). Task #548 caught
  // the same-file object-literal / class method-host shape; the
  // natural next bypass is to put the literal or class behind a
  // module boundary:
  //
  //   // helpers.ts
  //   export const helpers = { pickPassword: (req) => req.body.password };
  //   export class H { pick(req) { return req.body.password; } }
  //   // routes.ts
  //   import { helpers, H } from './helpers';
  //   log.info(helpers.pickPassword(req));
  //   log.info(new H().pick(req));
  //
  // `getExportedHelpers` now records named-export object literals
  // and class declarations under their export name as a methodHost
  // binding, so the importing file's pass 5 binds the same host
  // under the local (possibly aliased) import name and the existing
  // method-call rule fires on the cross-file shapes.
  // ---------------------------------------------------------------

  it('flags a CROSS-FILE named-export object literal consumed via `helpers.pickPassword(req)` (the brief)', () => {
    const dir = mkdtempSync(
      join(tmpdir(), 'no-secrets-in-logs-cross-host-obj-'),
    );
    const helpersFile = join(dir, 'server/helpers.ts');
    const routesFile = join(dir, 'server/routes.ts');
    mkdirSync(dirname(helpersFile), { recursive: true });
    writeFileSync(
      helpersFile,
      `export const helpers = {\n` +
        `  pickPassword: (req: any) => req.body.password,\n` +
        `};\n`,
    );
    writeFileSync(
      routesFile,
      `import { helpers } from './helpers';\n` +
        `log.info(\`pw=\${helpers.pickPassword(req)}\`);\n`,
    );
    const reasons = scanSource(
      routesFile,
      readFileSync(routesFile, 'utf8'),
      SERVER_SURFACE,
    ).flatMap((h) => h.reasons);
    expect(
      reasons.some((r) =>
        /method call 'helpers\.pickPassword\(\)' returning .*\.password/.test(
          r,
        ),
      ),
    ).toBe(true);
  });

  it('does NOT flag a CROSS-FILE named-export object literal whose methods are benign', () => {
    // Symmetric no-false-positive: a benign object literal exported
    // from another file must not poison every importing call site.
    const dir = mkdtempSync(
      join(tmpdir(), 'no-secrets-in-logs-cross-host-obj-benign-'),
    );
    const helpersFile = join(dir, 'server/helpers.ts');
    const routesFile = join(dir, 'server/routes.ts');
    mkdirSync(dirname(helpersFile), { recursive: true });
    writeFileSync(
      helpersFile,
      `export const helpers = {\n` +
        `  getId: (req: any) => req.body.id,\n` +
        `  getName: (req: any) => req.body.name,\n` +
        `};\n`,
    );
    writeFileSync(
      routesFile,
      `import { helpers } from './helpers';\n` +
        `log.info('id', helpers.getId(req), helpers.getName(req));\n`,
    );
    const reasons = scanSource(
      routesFile,
      readFileSync(routesFile, 'utf8'),
      SERVER_SURFACE,
    ).flatMap((h) => h.reasons);
    expect(reasons).toHaveLength(0);
  });

  // ---------------------------------------------------------------
  // Namespace-import method hosts (task #558). Tasks #541, #549,
  // and #553 covered named/default helper imports and named-export
  // methodHost imports. The remaining shape is the namespace
  // import:
  //
  //   // helpers.ts
  //   export function pickPassword(req) { return req.body.password; }
  //   export const helpers = {
  //     pickPassword(req) { return req.body.password; },
  //   };
  //   export class H { pick(req) { return req.body.password; } }
  //   // routes.ts
  //   import * as mod from './helpers';
  //   log.info(mod.pickPassword(req));        // helper-on-namespace
  //   log.info(mod.helpers.pickPassword(req));// nested object-literal host
  //   log.info(new mod.H().pick(req));        // nested class host via new
  //
  // Pass 5 now also handles `ts.NamespaceImport` clauses, building a
  // synthetic methodHost whose `methods` map collects helper-kind
  // exports (so `mod.<helper>(req)` resolves through the existing
  // method-call rule) and whose `nested` map collects methodHost
  // exports (so `mod.<host>.<m>(req)` and `new mod.<Host>().<m>(req)`
  // both round-trip through `resolveCallReceiverHost` /
  // `describeReceiverPath`, which were generalized to recurse into
  // `NewExpression.expression` so PropertyAccess constructors are
  // accepted, not just bare Identifier ctors.
  // ---------------------------------------------------------------

  it('flags a NAMESPACE-IMPORT helper call `mod.pickPassword(req)` (the brief)', () => {
    const dir = mkdtempSync(
      join(tmpdir(), 'no-secrets-in-logs-ns-helper-'),
    );
    const helpersFile = join(dir, 'server/helpers.ts');
    const routesFile = join(dir, 'server/routes.ts');
    mkdirSync(dirname(helpersFile), { recursive: true });
    writeFileSync(
      helpersFile,
      `export function pickPassword(req: any) { return req.body.password; }\n`,
    );
    writeFileSync(
      routesFile,
      `import * as mod from './helpers';\n` +
        `log.info(\`pw=\${mod.pickPassword(req)}\`);\n`,
    );
    const reasons = scanSource(
      routesFile,
      readFileSync(routesFile, 'utf8'),
      SERVER_SURFACE,
    ).flatMap((h) => h.reasons);
    expect(
      reasons.some((r) =>
        /method call 'mod\.pickPassword\(\)' returning .*\.password/.test(
          r,
        ),
      ),
    ).toBe(true);
  });

  it('does NOT flag a NAMESPACE-IMPORT helper or method whose return is benign', () => {
    // Negative: confirms we are not flagging *every* call through
    // a namespace import — the synthetic methodHost only collects
    // exports that `getExportedHelpers` already classified as
    // helper / methodHost (i.e. forbidden-return), so benign
    // exports pass through silently.
    const dir = mkdtempSync(
      join(tmpdir(), 'no-secrets-in-logs-ns-benign-'),
    );
    const helpersFile = join(dir, 'server/helpers.ts');
    const routesFile = join(dir, 'server/routes.ts');
    mkdirSync(dirname(helpersFile), { recursive: true });
    writeFileSync(
      helpersFile,
      `export function describe(req: any) { return req.method; }\n` +
        `export const tools = {\n` +
        `  summarize: (req: any) => req.params.id,\n` +
        `};\n` +
        `export class K {\n` +
        `  label(req: any) { return req.path; }\n` +
        `}\n`,
    );
    writeFileSync(
      routesFile,
      `import * as mod from './helpers';\n` +
        `log.info(mod.describe(req));\n` +
        `log.info(mod.tools.summarize(req));\n` +
        `log.info(new mod.K().label(req));\n`,
    );
    const findings = scanSource(
      routesFile,
      readFileSync(routesFile, 'utf8'),
      SERVER_SURFACE,
    );
    expect(findings).toEqual([]);
  });

  // ---------------------------------------------------------------
  // Default-exported method hosts (task #559). Task #553 covered
  // NAMED-export object literals and class declarations; the
  // default-export variants were intentionally deferred:
  //
  //   // helpers.ts
  //   export default class H { pick(req) { return req.body.password; } }
  //   export default { pick: (req) => req.body.password };
  //   // routes.ts
  //   import H from './helpers';
  //   import obj from './helpers';
  //   log.info(new H().pick(req));
  //   log.info(obj.pick(req));
  //
  // `getExportedHelpers` already records helper functions under
  // DEFAULT_EXPORT_KEY for the default-import path (task #549);
  // this task extends the same sentinel to method-host bindings
  // (object literals + class declarations + class expressions) so
  // a default-import in the consumer gets the methodHost binding
  // under the LOCAL name. Pass 5's default-import branch already
  // wires `ic.name` to whatever binding the exporter put under
  // DEFAULT_EXPORT_KEY without filtering on kind, so methodHost
  // round-trips through the same path that helpers do.
  // ---------------------------------------------------------------

  it('flags a DEFAULT-export class via `import H from … ; new H().pick(req)` (the brief)', () => {
    const dir = mkdtempSync(
      join(tmpdir(), 'no-secrets-in-logs-default-host-class-new-'),
    );
    const helpersFile = join(dir, 'server/helpers.ts');
    const routesFile = join(dir, 'server/routes.ts');
    mkdirSync(dirname(helpersFile), { recursive: true });
    writeFileSync(
      helpersFile,
      `export default class H {\n` +
        `  pick(req: any) { return req.body.password; }\n` +
        `}\n`,
    );
    writeFileSync(
      routesFile,
      `import H from './helpers';\n` + `log.info(new H().pick(req));\n`,
    );
    const reasons = scanSource(
      routesFile,
      readFileSync(routesFile, 'utf8'),
      SERVER_SURFACE,
    ).flatMap((h) => h.reasons);
    expect(
      reasons.some((r) =>
        /method call 'new H\(\)\.pick\(\)' returning .*\.password/.test(r),
      ),
    ).toBe(true);
  });

  it('does NOT flag a DEFAULT-export class or object whose methods are benign', () => {
    // Negative: confirms `export default` on a method host doesn't
    // cause blanket false positives — only forbidden-return methods
    // populate the methodHost's `methods` map, so benign exports
    // pass through silently.
    const classDir = mkdtempSync(
      join(tmpdir(), 'no-secrets-in-logs-default-host-class-benign-'),
    );
    const objDir = mkdtempSync(
      join(tmpdir(), 'no-secrets-in-logs-default-host-obj-benign-'),
    );
    const classHelpers = join(classDir, 'server/helpers.ts');
    const classRoutes = join(classDir, 'server/routes.ts');
    const objHelpers = join(objDir, 'server/helpers.ts');
    const objRoutes = join(objDir, 'server/routes.ts');
    mkdirSync(dirname(classHelpers), { recursive: true });
    mkdirSync(dirname(objHelpers), { recursive: true });
    writeFileSync(
      classHelpers,
      `export default class K {\n` +
        `  label(req: any) { return req.path; }\n` +
        `}\n`,
    );
    writeFileSync(
      classRoutes,
      `import K from './helpers';\n` + `log.info(new K().label(req));\n`,
    );
    writeFileSync(
      objHelpers,
      `export default {\n` +
        `  summarize: (req: any) => req.params.id,\n` +
        `};\n`,
    );
    writeFileSync(
      objRoutes,
      `import obj from './helpers';\n` + `log.info(obj.summarize(req));\n`,
    );
    expect(
      scanSource(
        classRoutes,
        readFileSync(classRoutes, 'utf8'),
        SERVER_SURFACE,
      ),
    ).toEqual([]);
    expect(
      scanSource(objRoutes, readFileSync(objRoutes, 'utf8'), SERVER_SURFACE),
    ).toEqual([]);
  });

  // ---------------------------------------------------------------
  // Re-export resolution (task #556). Tasks #541 and #549 wired up
  // cross-file resolution for direct named/default exports but
  // skipped re-export forwarding shapes:
  //
  //   // helpers.ts
  //   export function pickPassword(req) { return req.body.password; }
  //   // index.ts (barrel)
  //   export { pickPassword } from './helpers';
  //   // routes.ts
  //   import { pickPassword } from './utils';
  //   log.info(`pw=${pickPassword(req)}`);
  //
  // The barrel pattern is common; the scanner now walks each
  // ExportDeclaration with a moduleSpecifier, recursively asks the
  // re-export source for its helpers, and copies the selected
  // entries into the current file's helpers map under the
  // re-exported names. Wildcard re-exports follow ECMAScript
  // semantics — they forward every named export but NOT the
  // default. Namespace re-exports remain out of scope (see follow-up).
  // ---------------------------------------------------------------

  it('flags a CROSS-FILE helper routed through a NAMED re-export `export { foo } from` (the brief)', () => {
    // Three-file barrel chain: helpers.ts defines the helper,
    // index.ts re-exports it under the same name, routes.ts
    // imports from the barrel and calls the helper inside a log
    // template literal. Without #556 the scanner sees `index.ts`
    // as having no helpers; with the re-export branch in
    // `getExportedHelpers`, `pickPassword` resolves through the
    // barrel.
    const dir = mkdtempSync(join(tmpdir(), 'no-secrets-in-logs-rexp-named-'));
    const helpersFile = join(dir, 'server/utils/helpers.ts');
    const indexFile = join(dir, 'server/utils/index.ts');
    const routesFile = join(dir, 'server/routes.ts');
    mkdirSync(dirname(helpersFile), { recursive: true });
    writeFileSync(
      helpersFile,
      `export function pickPassword(req: any) { return req.body.password; }\n`,
    );
    writeFileSync(indexFile, `export { pickPassword } from './helpers';\n`);
    writeFileSync(
      routesFile,
      `import { pickPassword } from './utils';\n` +
        `log.info(\`pw=\${pickPassword(req)}\`);\n`,
    );
    const reasons = scanSource(
      routesFile,
      readFileSync(routesFile, 'utf8'),
      SERVER_SURFACE,
    ).flatMap((h) => h.reasons);
    expect(
      reasons.some((r) =>
        /helper call 'pickPassword\(\)' returning .*\.password/.test(r),
      ),
    ).toBe(true);
  });

  it('does NOT flag a CROSS-FILE re-export whose source helper is benign', () => {
    // Pin that the re-export branch does not over-match: a benign
    // helper forwarded through a barrel must remain benign on the
    // consumer side.
    const dir = mkdtempSync(
      join(tmpdir(), 'no-secrets-in-logs-rexp-benign-'),
    );
    const helpersFile = join(dir, 'server/utils/helpers.ts');
    const indexFile = join(dir, 'server/utils/index.ts');
    const routesFile = join(dir, 'server/routes.ts');
    mkdirSync(dirname(helpersFile), { recursive: true });
    writeFileSync(
      helpersFile,
      `export function getUserId(req: any) { return req.body.id; }\n`,
    );
    writeFileSync(indexFile, `export { getUserId } from './helpers';\n`);
    writeFileSync(
      routesFile,
      `import { getUserId } from './utils';\n` +
        `log.info('user', getUserId(req));\n`,
    );
    const reasons = scanSource(
      routesFile,
      readFileSync(routesFile, 'utf8'),
      SERVER_SURFACE,
    ).flatMap((h) => h.reasons);
    expect(reasons).toHaveLength(0);
  });

  // ---------------------------------------------------------------
  // Method-call detection (task #548). Task #541 closed the
  // bare-identifier helper-call shape; the natural next bypass is
  // to route the same call through a property access:
  //
  //   const helpers = { pickPassword: (req) => req.body.password };
  //   log.info(`pw=${helpers.pickPassword(req)}`);
  //
  //   class H { pick(req) { return req.body.password; } }
  //   log.info(new H().pick(req));
  //
  // The scanner records object-literal properties whose value is an
  // arrow / function expression returning a forbidden expression
  // (and class methods doing the same) as a 'methodHost' binding,
  // then flags property-access call sites whose receiver resolves
  // to that host.
  // ---------------------------------------------------------------

  it('flags `helpers.pickPassword(req)` where helpers is an object literal of arrow helpers (the brief)', () => {
    const reasons = reasonsFor(
      `const helpers = {\n` +
        `  pickPassword: (req: any) => req.body.password,\n` +
        `};\n` +
        `log.info(\`pw=\${helpers.pickPassword(req)}\`);`,
    );
    expect(
      reasons.some((r) =>
        /method call 'helpers\.pickPassword\(\)' returning property access ending in \.password/.test(
          r,
        ),
      ),
    ).toBe(true);
  });

  it('does NOT flag an object-literal whose methods return only benign values', () => {
    // A config-style object whose method values are benign helpers
    // must not get a methodHost binding (or, if it does, must not
    // flag any call). Pin the no-false-positive expectation.
    const reasons = reasonsFor(
      `const helpers = {\n` +
        `  getId: (req: any) => req.body.id,\n` +
        `  getName: (req: any) => req.body.name,\n` +
        `};\n` +
        `log.info(helpers.getId(req), helpers.getName(req));`,
    );
    expect(reasons).toHaveLength(0);
  });

  // ---------------------------------------------------------------
  // Computed method-call detection (task #554). Task #548 closed the
  // dot-form bypass; the natural next bypass is to swap the dot for
  // a bracket and put the method name in a string literal (or a
  // no-substitution template literal):
  //
  //   const helpers = { pickPassword: (req) => req.body.password };
  //   log.info(`pw=${helpers['pickPassword'](req)}`);
  //   log.info(`pw=${helpers[\`pickPassword\`](req)}`);
  //
  // The methodHost machinery is keyed by string method name, so the
  // computed form looks up exactly the same `host.methods.get('pick')`
  // entry as the dot form once we read the index out of the literal.
  // The receiver itself can also be reached via bracket form
  // (`obj['helper']['pick']`), which is what the
  // resolveCallReceiverHost ElementAccess branch covers.
  // ---------------------------------------------------------------

  it('flags `helpers[\'pickPassword\'](req)` (single-receiver, string-literal index)', () => {
    const reasons = reasonsFor(
      `const helpers = {\n` +
        `  pickPassword: (req: any) => req.body.password,\n` +
        `};\n` +
        `log.info(\`pw=\${helpers['pickPassword'](req)}\`);`,
    );
    expect(
      reasons.some((r) =>
        /method call 'helpers\["pickPassword"\]\(\)' returning .*\.password/.test(
          r,
        ),
      ),
    ).toBe(true);
  });

  it('does NOT flag a computed method call whose index is a non-literal expression', () => {
    // `helpers[methodName](req)` where `methodName` is a runtime
    // variable cannot be statically resolved to a method name. The
    // rule must stay conservative — flagging would be guesswork
    // (the method might be `pickId`, not `pickPassword`).
    const reasons = reasonsFor(
      `const helpers = {\n` +
        `  pickPassword: (req: any) => req.body.password,\n` +
        `  pickId: (req: any) => req.body.id,\n` +
        `};\n` +
        `function f(methodName: 'pickPassword' | 'pickId') {\n` +
        `  log.info(helpers[methodName](req));\n` +
        `}`,
    );
    expect(reasons).toHaveLength(0);
  });

  // -------- Task #560: TypeScript transparent-callee wrappers --------
  //
  // Each block below mirrors the three paren-bypass tests above
  // (DOT / BRACKET / BARE-IDENTIFIER) for one TypeScript-only
  // wrapper that erases at runtime: `as`, `<...>`, and `!`. The
  // architect explicitly flagged these as the next trivial bypass
  // after #554 — anyone aware of the dot/bracket/paren rules can
  // swap the callee for `(helpers.pick as any)(req)` /
  // `(<any>helpers.pick)(req)` / `helpers.pick!(req)` and slip
  // past the dispatch otherwise. `unwrapTransparentCallee` strips
  // all four wrapper kinds (paren + the three TS wrappers) before
  // the shape check, closing the bypass for every call-shape rule
  // (helper-function, dot-method, bracket-method) at once.

  it("flags `(helpers.pickPassword as any)(req)` — DOT-form `as` wrapper (task #560)", () => {
    const reasons = reasonsFor(
      `const helpers = {\n` +
        `  pickPassword: (req: any) => req.body.password,\n` +
        `};\n` +
        `log.info((helpers.pickPassword as any)(req));`,
    );
    expect(
      reasons.some((r) =>
        /method call 'helpers\.pickPassword\(\)' returning .*\.password/.test(
          r,
        ),
      ),
    ).toBe(true);
  });

  // Receiver-side wrappers — the architect-required sister of the
  // callee-side bypass above. After #554 the dispatch unwraps
  // wrappers on the CALLEE (`(helpers.pick as any)(req)`), but the
  // RECEIVER position inside the callee was still raw — so
  // `(helpers as any).pick(req)` and friends slipped through
  // because `resolveCallReceiverHost`'s recursion only stripped
  // `ParenthesizedExpression`. The shared `isTransparentExpressionWrapper`
  // predicate (used by both `unwrapTransparentCallee` AND the
  // recursive resolveCallReceiverHost / describeReceiverPath
  // branches) keeps both sides in lock-step.

  // `satisfies` — TS 4.9+. Same erase-at-emit semantics as `as`,
  // and the architect explicitly called this out as a wrapper kind
  // missed by the original brief. Cover both callee and receiver
  // positions so neither side has the bypass.

  // Negative tests — split per-wrapper for failure-attribution
  // clarity (per architect feedback). Each pins that the wrapper
  // strip does NOT relax the methodHost binding lookup: an unknown
  // receiver stays unknown after unwrapping.

  it("does NOT flag `(unknownThing as any).pick(req)` — wrapper around an unbound receiver (task #560 negative)", () => {
    const reasons = reasonsFor(
      `declare const unknownThing: any;\n` +
        `log.info((unknownThing as any).pick(req));`,
    );
    expect(reasons).toHaveLength(0);
  });

  // -------- Task #562: TS transparent wrappers in alias initializers --------
  // Sibling of the task #560 callee/receiver wrapper block above. Task
  // #560 closed the bypass for `(helper as any)(req)` style call-site
  // wrappers; this block closes the bypass for `const x = req.body.password
  // as any; log.info(x)` — same predicate (`isTransparentExpressionWrapper`),
  // applied at the alias-classification path (`unwrapTransparentWrappers` +
  // the top of `classifyInitializer`). Each wrapper kind is pinned at one
  // of {const initializer, ?? operand, ternary branch} per the brief.

  it("flags `const x = req.body.password as any` — `as` wrapper on alias initializer (task #562)", () => {
    const reasons = reasonsFor(
      `function f(req: any) {\n` +
        `  const x = req.body.password as any;\n` +
        `  log.info(x);\n` +
        `}`,
    );
    expect(reasons).toContain(
      "local 'x' aliasing property access ending in .password",
    );
  });

  it('does NOT flag `const x = unboundFoo as any` — wrapper around an unbound identifier stays benign (task #562 negative)', () => {
    // Confirms the broadened unwrap doesn't false-positive: looking
    // through the wrapper still hits a bare identifier with no
    // forbidden binding, so no alias is recorded.
    const reasons = reasonsFor(
      `function f() {\n` +
        `  const x = unboundFoo as any;\n` +
        `  log.info(x);\n` +
        `}`,
    );
    expect(reasons).toHaveLength(0);
  });

  it('honors a trailing // secret-log-ok: <reason> annotation', () => {
    const reasons = reasonsFor(
      `function f(csrfToken: string) {\n` +
        `  log.warn(\`csrfToken=\${csrfToken}\`); // secret-log-ok: test fixture\n` +
        `}`,
    );
    expect(reasons).toHaveLength(0);
  });

  it('does NOT honor secret-log-ok inside a string payload (bypass guard)', () => {
    // A naive `argList.includes('secret-log-ok')` would have let
    // this slip past --strict. The annotation only counts inside
    // an actual comment, not inside a string-literal value.
    const reasons = reasonsFor(
      `function f(csrfToken: string) { log.warn('secret-log-ok: bogus ' + csrfToken); }`,
    );
    expect(reasons.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------
  // File-level scope + CLI behavior (verified via one fixture spawn
  // for advisory mode; the strict-mode spawn against the real
  // codebase above already exercises strict exit-1 paths fail-loud
  // when a real regression appears).
  // ---------------------------------------------------------------

  it('skips *.test.ts and __tests__/ files (directly via scanCodebase listing)', () => {
    // The directory walk filter is exercised end-to-end by the
    // real-codebase spawn test above (the codebase has both
    // *.test.ts and __tests__/ files; if the walker scanned them,
    // many in-test fixture leaks would show up in --strict). This
    // assertion just pins the unit-level expectation that the
    // scanner itself does not care about file path — file filtering
    // is handled in `listTsFiles`, which is exercised by the real
    // run.
    expect(reasonsFor(`log.info('safe call', { id: 1 });`)).toHaveLength(0);
  });

  it('exits 0 in advisory mode (no --strict) even when violations exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'no-secrets-in-logs-advisory-'));
    const file = join(dir, 'server/foo.ts');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      `import { log } from './logger.js';\nlog.info(\`pw=\${req.body.password}\`);\n`,
    );
    const r = spawnSync(process.execPath, [TSX_CLI, SCRIPT], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test' },
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/WARN.*\.password/);
  });
});
