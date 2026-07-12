/**
 * Trust-proxy coverage guard (task #378).
 *
 * Background. `assertTrustProxyAtBoot(app, ...)` in
 * `server/lib/trust-proxy-check.ts` verifies that the configured
 * `app.set('trust proxy', N)` actually resolves a realistic
 * `X-Forwarded-For` chain to a non-loopback `req.ip`. Per-IP rate
 * limiters (notably `setupAdminLimiter` at 5 req / 15 min) key off
 * `req.ip`, so a misconfigured trust-proxy silently collapses the
 * brute-force ceiling into a 5 req / 15 min cap for the entire
 * internet. The single existing entrypoint `server/index.ts` calls
 * the assertion right after constructing its `express()` instance
 * (line ~34).
 *
 * The risk this guard addresses. If a future contributor adds an
 * alternate entrypoint under `server/` — a worker process that also
 * serves HTTP, a serverless adapter, a separate admin UI app —
 * they'll spin up a new `express()` instance. If they forget the
 * call to `assertTrustProxyAtBoot`, the same silent collapse becomes
 * possible there with zero external signal. This script walks every
 * `.ts` file under `server/` and fails CI if it finds an `express()`
 * invocation in a file whose source does not also call
 * `assertTrustProxyAtBoot(...)`.
 *
 * Parser contract / scope:
 *   - "An `express()` invocation" = a call to whatever local
 *     binding the file gave to the `express` module. The script
 *     parses every `import ... from 'express'` and
 *     `require('express')` form (default, renamed-default,
 *     namespace, default+named) to learn the binding name (which is
 *     usually `express` but could be `ex`, `e`, etc.) and then
 *     flags any `<binding>()` call. This matters because the
 *     security intent is "any new Express app instance must run
 *     the boot guard" — a regex pinned to the literal token
 *     `express()` would silently miss `import ex from 'express';
 *     const app = ex();`. Sub-routers use `Router()` and are
 *     intentionally NOT flagged — only the root app binds the
 *     trust-proxy setting.
 *   - "Calls the assertion" = the same source file contains a call
 *     site `assertTrustProxyAtBoot(`. Same-file is a deliberate
 *     policy choice: the assertion has to fire BEFORE the app
 *     starts handling requests, and keeping the construction and
 *     the guard in the same file makes that easy to read and audit.
 *     A factory-pattern split (construct in file A, call assertion
 *     in file B) would produce a false positive — if that ever
 *     becomes a real need, prefer making the factory call the
 *     assertion itself, or extend this script with an explicit
 *     allowlist of (constructor file, asserter file) pairs.
 *   - Ordering IS enforced (task #497): once a file passes the
 *     "calls the assertion" check above, the script also verifies
 *     that the first `assertTrustProxyAtBoot(` call site appears at
 *     a source position EARLIER than the first `<id>.listen(` call
 *     in the same file. The footgun this closes is a future
 *     entrypoint that legally satisfies the presence check but
 *     calls the assertion after `app.listen(...)` — at that point a
 *     real request can already arrive and key off a misconfigured
 *     `req.ip` before the boot guard ever runs. The check is a
 *     lexical position compare on the comment-stripped source: it
 *     deliberately does NOT chase control flow into function
 *     bodies, so a `startServer()` factory that contains both calls
 *     in textual order (assertion above `listen`) is correctly
 *     accepted regardless of where the factory is invoked. The
 *     mirror false-negative — a factory containing only `.listen(`
 *     called before a top-level assertion — is acknowledged and
 *     left to the same-file-ordering convention this guard
 *     enforces; a full call-graph pass is out of scope.
 *   - Files under `**\/__tests__/**` and any `*.test.ts` are
 *     excluded — synthetic test apps don't need the production
 *     guard.
 *   - Commented-out matches are ignored: line comments (`// ...`)
 *     and block comments (`/* ... *\/`) are stripped before the
 *     parse pass so a doc-comment example never trips the guard.
 *
 * Exits 0 if every `express()` invocation is paired with an
 * `assertTrustProxyAtBoot(` call in the same file; exits 1 with a
 * line-level violation report otherwise.
 *
 * Run with: `tsx scripts/check-trust-proxy-coverage.ts`. Also
 * exercised on every CI run by
 * `tests/unit/check-trust-proxy-coverage.test.ts`.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';

const SERVER_DIR = resolve(process.cwd(), 'server');

interface Violation {
  file: string;
  line: number;
  // 'missing' = file constructs an express() instance but never calls
  // assertTrustProxyAtBoot in the same file.
  // 'late' = file does call the assertion, but the call site is at a
  // later source position than the first `<id>.listen(` in the same
  // file (task #497). `listenLine` is set only for 'late' so the
  // violation report can point the dev at both call sites at once.
  kind: 'missing' | 'late';
  listenLine?: number;
}

// Strip line and block comments so a doc-comment example doesn't
// trip the guard. We do this naively (no string-literal awareness)
// because the guard's targets — `express()` and
// `assertTrustProxyAtBoot(` — never appear inside string literals
// in real source. If someone ever writes a string that contains
// `express()`, the worst case is a false positive that the test
// harness will catch.
function stripComments(src: string): string {
  // Remove block comments first so line-comment markers nested
  // inside them don't create stray fragments.
  const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlocks.replace(/\/\/[^\n]*/g, '');
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      // Skip test fixture trees — the synthetic apps inside don't
      // need (and shouldn't be expected to call) the production
      // boot-time guard.
      if (entry === '__tests__' || entry === 'node_modules') continue;
      walk(full, out);
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (entry.endsWith('.test.ts')) continue;
    if (entry.endsWith('.d.ts')) continue;
    out.push(full);
  }
}

// Discover every local binding the file uses for the `express`
// module. Pinning detection to "the literal token express()" would
// silently miss the realistic alias pattern (`import ex from
// 'express'; const app = ex();`) and reopen the security gap this
// guard exists to close.
//
// Patterns covered (the realistic ones a future contributor might
// reach for; in each case CAPTURE-1 is the binding name):
//   ESM default:            import express from 'express'
//   ESM renamed default:    import ex from 'express'
//   ESM default + named:    import ex, { Router } from 'express'
//   ESM namespace:          import * as ex from 'express'
//   CJS default require:    const ex = require('express')
//   CJS destructured:       const { default: ex } = require('express')
//
// For the namespace form the construction call would look like
// `ex.default()` (or `ex()` under CJS-interop), so we register both
// `ex` and `ex.default` as potential constructor bindings.
function findExpressBindings(src: string): string[] {
  const bindings = new Set<string>();
  // ESM default import (with optional named-import tail).
  for (const m of src.matchAll(
    /import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s+from\s+['"]express['"]/g,
  )) {
    bindings.add(m[1]);
  }
  // ESM namespace import.
  for (const m of src.matchAll(
    /import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"]express['"]/g,
  )) {
    bindings.add(m[1]);
    bindings.add(`${m[1]}.default`);
  }
  // CJS default require: const|let|var X = require('express').
  for (const m of src.matchAll(
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*['"]express['"]\s*\)/g,
  )) {
    bindings.add(m[1]);
  }
  // CJS destructured default require: const { default: X } = require('express').
  for (const m of src.matchAll(
    /(?:const|let|var)\s*\{\s*default\s*:\s*([A-Za-z_$][\w$]*)\s*\}\s*=\s*require\s*\(\s*['"]express['"]\s*\)/g,
  )) {
    bindings.add(m[1]);
  }
  return Array.from(bindings);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findExpressCallLines(src: string): number[] {
  // Find every line that calls one of the file's local express
  // bindings as `<binding>()`. The leading boundary
  // `[^a-zA-Z0-9_$.]` (or start-of-line) keeps us from matching
  // property accesses on unrelated objects (`obj.express()` would
  // match the trailing dot only if the binding is bare `express`,
  // and the boundary class excludes `.`, so it's correctly skipped).
  // Files that don't import express at all yield no bindings and
  // therefore no matches.
  const bindings = findExpressBindings(src);
  if (bindings.length === 0) return [];
  const lines = src.split('\n');
  const matchedLines = new Set<number>();
  for (const binding of bindings) {
    const re = new RegExp(`(^|[^a-zA-Z0-9_$.])${escapeRegex(binding)}\\s*\\(\\s*\\)`);
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) matchedLines.add(i + 1);
    }
  }
  return Array.from(matchedLines).sort((a, b) => a - b);
}

function callsAssertion(src: string): boolean {
  return /\bassertTrustProxyAtBoot\s*\(/.test(src);
}

// Position-check helpers (task #497). The lint additionally rejects
// files where the first `assertTrustProxyAtBoot(` call site appears
// at a later source offset than the first `<id>.listen(` call. The
// pattern is intentionally pinned to `<identifier>.listen(` (e.g.
// `app.listen(`, `server.listen(`, `httpServer.listen(`) rather than
// a bare `\.listen\(`: that boundary keeps the regex from matching
// unrelated `.listen` references in property strings or method-chain
// fragments while still covering every realistic Express/Node
// listen-call shape. Source offsets are compared on the
// comment-stripped string the rest of the script already uses, so
// `// app.listen(...)` examples in doc-comments don't trip the
// position check either.
const ASSERTION_RE = /\bassertTrustProxyAtBoot\s*\(/;
const LISTEN_RE = /\b[A-Za-z_$][\w$]*\.listen\s*\(/;

function firstIndex(src: string, re: RegExp): number {
  const m = re.exec(src);
  return m ? m.index : -1;
}

function lineFromIndex(src: string, idx: number): number {
  // 1-indexed line number for the violation report.
  return src.slice(0, idx).split('\n').length;
}

function main(): void {
  if (!existsSync(SERVER_DIR)) {
    // Synthetic fixtures may omit `server/` entirely — that means
    // there's nothing to check, which is trivially OK.
    console.log('[check-trust-proxy-coverage] OK — no server/ directory');
    process.exit(0);
  }

  const files: string[] = [];
  walk(SERVER_DIR, files);

  const violations: Violation[] = [];

  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    const stripped = stripComments(raw);
    const expressLines = findExpressCallLines(stripped);
    if (expressLines.length === 0) continue;
    // Keep diagnostics stable across Windows and POSIX runners. The
    // path is user-facing output and is also asserted by the CI guard
    // tests, so it should use repository-style separators everywhere.
    const rel = relative(process.cwd(), file).replaceAll('\\', '/');
    if (!callsAssertion(stripped)) {
      for (const line of expressLines) {
        violations.push({ file: rel, line, kind: 'missing' });
      }
      continue;
    }
    // Presence check passed — now enforce ordering (task #497). The
    // assertion has to fire before the app starts handling requests,
    // so its first call site must appear at a source position
    // earlier than the first `<id>.listen(` in the same file.
    // Files with no `.listen(` at all (e.g. an entrypoint that
    // hands `app` off to a different file to bind the port) are
    // accepted: there's no in-file ordering to compare against.
    const listenIdx = firstIndex(stripped, LISTEN_RE);
    if (listenIdx < 0) continue;
    const assertionIdx = firstIndex(stripped, ASSERTION_RE);
    // assertionIdx >= 0 here because callsAssertion(stripped) already
    // matched the same regex shape.
    if (assertionIdx > listenIdx) {
      violations.push({
        file: rel,
        line: lineFromIndex(stripped, assertionIdx),
        kind: 'late',
        listenLine: lineFromIndex(stripped, listenIdx),
      });
    }
  }

  if (violations.length === 0) {
    console.log('[check-trust-proxy-coverage] OK');
    process.exit(0);
  }

  console.error(
    '[check-trust-proxy-coverage] FAIL — the following express() entrypoints under server/ have a misconfigured trust-proxy guard:',
  );
  for (const v of violations) {
    if (v.kind === 'missing') {
      console.error(`  ${v.file}:${v.line}  express() without assertTrustProxyAtBoot in same file`);
    } else {
      console.error(
        `  ${v.file}:${v.line}  assertTrustProxyAtBoot called after listen() at line ${v.listenLine} — assertion must fire before any request can be handled`,
      );
    }
  }
  console.error(
    '\nFix by importing assertTrustProxyAtBoot from server/lib/trust-proxy-check and calling it on the new app right after `app.set("trust proxy", N)`, before any `<app|server>.listen(...)` call in the same file. See the entrypoint registry in that file.',
  );
  process.exit(1);
}

main();
