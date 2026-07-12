#!/usr/bin/env tsx
/**
 * Not-found error-code drift guard (task #552).
 *
 * Task #542 manually unified three admin route files on `'NOT_FOUND'`
 * after a sweep of mixed `'NotFound'` / `'not_found'` / `'NOT_FOUND'`
 * casings. Nothing in CI prevented a future contributor from
 * re-introducing the drift — copy-paste an old call site or add a
 * new route file with a fresh casing convention and the unification
 * is undone silently.
 *
 * This guard walks every `.ts` file under `server/routes/`, finds
 * every `sendError(...)` call whose status arg is the literal `404`,
 * and asserts the code (4th) arg is one of the allow-listed values.
 *
 * Allow-list (canonical + intentionally-narrowed alternatives):
 *   - 'NOT_FOUND'           — canonical
 *   - 'USER_NOT_FOUND'      — narrows to the user resource
 *   - 'LEAGUE_NOT_FOUND'    — narrows to the league resource
 *   - 'RECEIPT_UNAVAILABLE' — narrows to "underlying record found
 *                              but no receipt is generated"
 *
 * Detection rules per `sendError(res, msg, 404, code, ...)` call:
 *   (a) 4th arg missing entirely → ALWAYS a violation. Without it,
 *       `sendError` falls back to its default `'ServerError'` code,
 *       which is the worst possible answer for a 404.
 *   (b) 4th arg is a string literal (single, double, or template
 *       with no substitutions) NOT in the allow-list → violation.
 *   (c) 4th arg is something else (identifier, expression, etc.) →
 *       fail-closed violation, with a message naming the SyntaxKind
 *       and asking the contributor to either inline a literal or
 *       extend the guard's allow-list logic. No real route uses
 *       this shape today; if a constant-of-codes pattern is
 *       introduced, the guard's resolution layer should grow to
 *       cover it before the violation is downgraded to a pass.
 *
 * Usage:
 *   tsx scripts/check-not-found-code.ts            # CI mode (exit 1 on violations)
 *   tsx scripts/check-not-found-code.ts --report   # print without failing
 *
 * Sister of `scripts/check-wire-sanitization.ts` /
 * `scripts/check-no-secrets-in-logs.ts`. The script's behavior is
 * pinned by `tests/unit/check-not-found-code.test.ts`, which runs
 * the real binary against the real codebase plus synthetic fixtures.
 */
import ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const SCAN_ROOT = join(ROOT, 'server/routes');
const REPORT_ONLY = process.argv.includes('--report');

const ALLOWED_CODES = new Set<string>([
  'NOT_FOUND',
  'USER_NOT_FOUND',
  'LEAGUE_NOT_FOUND',
  'RECEIPT_UNAVAILABLE',
]);

interface Violation {
  file: string;
  line: number;
  column: number;
  reason: string;
  snippet: string;
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    // The loop guard above guarantees cur is defined; this check
    // satisfies the no-non-null-assertion lint without changing
    // runtime behavior.
    if (cur === undefined) continue;
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(cur, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        stack.push(full);
      } else if (
        st.isFile() &&
        full.endsWith('.ts') &&
        !full.endsWith('.d.ts') &&
        !full.endsWith('.test.ts')
      ) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

function readStringLiteral(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
}

function snippetAt(sf: ts.SourceFile, node: ts.Node): string {
  const text = sf.text;
  const start = node.getStart(sf);
  const end = node.getEnd();
  const slice = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return slice.length > 120 ? `${slice.slice(0, 117)}...` : slice;
}

function scanFile(filePath: string, violations: Violation[]): void {
  const text = readFileSync(filePath, 'utf8');
  const sf = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'sendError'
    ) {
      const args = node.arguments;
      // sendError(res, message, status, code, details?). We need
      // status (args[2]) to be the literal `404`; otherwise this
      // call isn't in scope.
      const statusArg = args[2];
      if (
        statusArg &&
        ts.isNumericLiteral(statusArg) &&
        statusArg.text === '404'
      ) {
        const codeArg = args[3];
        const relFile = relative(ROOT, filePath).replaceAll('\\', '/');
        const { line, character } = sf.getLineAndCharacterOfPosition(
          node.getStart(sf),
        );
        const push = (reason: string): void => {
          violations.push({
            file: relFile,
            line: line + 1,
            column: character + 1,
            reason,
            snippet: snippetAt(sf, node),
          });
        };
        if (!codeArg) {
          push(
            "missing code argument — defaults to 'ServerError' which is wrong for a 404. " +
              "Pass 'NOT_FOUND' (or an allow-listed alternative) explicitly.",
          );
        } else {
          const lit = readStringLiteral(codeArg);
          if (lit === null) {
            // Non-literal code (identifier / expression / etc.).
            // No real call sites use this shape today; flag if one
            // ever appears so the contract gets revisited.
            push(
              `code argument is not a string literal (got ${ts.SyntaxKind[codeArg.kind]}). ` +
                "If this is a constant, inline 'NOT_FOUND' here or extend the guard's allow-list logic.",
            );
          } else if (!ALLOWED_CODES.has(lit)) {
            push(
              `code '${lit}' is not in the allow-list ` +
                `{${[...ALLOWED_CODES].map((c) => `'${c}'`).join(', ')}}. ` +
                "Use 'NOT_FOUND' (or the matching domain-narrowed alternative).",
            );
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

function main(): void {
  let files: string[];
  try {
    files = listTsFiles(SCAN_ROOT);
  } catch (err) {
    console.error(
      `[check-not-found-code] FAIL — could not enumerate ${relative(ROOT, SCAN_ROOT)}: ${
        (err as Error).message
      }`,
    );
    process.exit(2);
  }
  if (files.length === 0) {
    // Sanity bottom: if the scan root is empty, the guard would
    // silently pass. Fail loud so a misplaced refactor doesn't
    // disable the check.
    console.error(
      `[check-not-found-code] FAIL — no .ts files found under ${relative(ROOT, SCAN_ROOT)}. ` +
        'Refusing to run rather than silently passing.',
    );
    process.exit(2);
  }

  const violations: Violation[] = [];
  for (const f of files) scanFile(f, violations);

  if (violations.length === 0) {
    console.log(
      `[check-not-found-code] OK — scanned ${files.length} file(s) under ${relative(ROOT, SCAN_ROOT)}. ` +
        `Every 404 sendError uses an allow-listed code.`,
    );
    return;
  }

  console.error(
    `\n[check-not-found-code] ${REPORT_ONLY ? 'REPORT' : 'FAIL'} — ${violations.length} 404 sendError site(s) use a non-allow-listed code:\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}:${v.column}`);
    console.error(`      · ${v.reason}`);
    console.error(`      · ${v.snippet}`);
  }
  console.error(
    "\nFix: replace the code with 'NOT_FOUND' (or 'USER_NOT_FOUND' / 'LEAGUE_NOT_FOUND' / 'RECEIPT_UNAVAILABLE' if the route intentionally narrows). " +
      'See the canonical-code comment in server/utils/api.ts.',
  );

  if (!REPORT_ONLY) process.exit(1);
}

main();
