#!/usr/bin/env tsx
/**
 * Provider-not-configured toast wiring guard.
 *
 * Walks `client/src/**\/*.{ts,tsx}` and asserts every direct
 * `providerNotConfiguredToast(...)` call passes an inline options
 * literal with a `provider:` field that is not a hardcoded
 * `'square'` / `'clover'` string literal.
 *
 * Usage:
 *   tsx scripts/check-provider-not-configured.ts            # CI mode (exit 1 on violations)
 *   tsx scripts/check-provider-not-configured.ts --report   # print without failing
 *
 * Pinned by `tests/unit/check-provider-not-configured.test.ts`.
 */
import ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const SCAN_ROOT = join(ROOT, 'client/src');
const REPORT_ONLY = process.argv.includes('--report');

const HELPER_NAME = 'providerNotConfiguredToast';

interface Violation {
  file: string;
  line: number;
  column: number;
  reason: string;
  snippet: string;
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
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
        if (entry === 'node_modules' || entry === '__tests__') continue;
        stack.push(full);
      } else if (st.isFile() && isScannable(full)) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

function isScannable(file: string): boolean {
  if (!file.endsWith('.ts') && !file.endsWith('.tsx')) return false;
  if (file.endsWith('.d.ts')) return false;
  if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) return false;
  if (file.endsWith('.spec.ts') || file.endsWith('.spec.tsx')) return false;
  return true;
}

function snippetAt(sf: ts.SourceFile, node: ts.Node): string {
  const text = sf.text;
  const start = node.getStart(sf);
  const end = node.getEnd();
  const slice = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return slice.length > 160 ? `${slice.slice(0, 157)}...` : slice;
}

function calleeMatchesHelper(node: ts.CallExpression): boolean {
  const expr = node.expression;
  if (ts.isIdentifier(expr) && expr.text === HELPER_NAME) return true;
  if (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.name) &&
    expr.name.text === HELPER_NAME
  ) {
    return true;
  }
  return false;
}

function findProviderProp(
  obj: ts.ObjectLiteralExpression,
):
  | { kind: 'assignment'; node: ts.PropertyAssignment }
  | { kind: 'shorthand'; node: ts.ShorthandPropertyAssignment }
  | { kind: 'spread'; node: ts.SpreadAssignment }
  | null {
  let lastSpread: ts.SpreadAssignment | null = null;
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const name = prop.name;
      if (ts.isIdentifier(name) && name.text === 'provider') {
        return { kind: 'assignment', node: prop };
      }
      if (
        (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) &&
        name.text === 'provider'
      ) {
        return { kind: 'assignment', node: prop };
      }
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      if (prop.name.text === 'provider') {
        return { kind: 'shorthand', node: prop };
      }
    } else if (ts.isSpreadAssignment(prop)) {
      lastSpread = prop;
    }
  }
  if (lastSpread !== null) {
    return { kind: 'spread', node: lastSpread };
  }
  return null;
}

function scanFile(filePath: string, violations: Violation[]): void {
  const text = readFileSync(filePath, 'utf8');
  if (!text.includes(HELPER_NAME)) return;

  const sf = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && calleeMatchesHelper(node)) {
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

      const args = node.arguments;
      if (args.length === 0) {
        push(
          `${HELPER_NAME}() called with no options. Pass an options ` +
            `object that includes a 'provider' field.`,
        );
      } else {
        const arg = args[0];
        if (!ts.isObjectLiteralExpression(arg)) {
          push(
            `${HELPER_NAME}(...) options arg is not an object literal ` +
              `(got ${ts.SyntaxKind[arg.kind]}). Inline the options literal ` +
              `here so the guard can verify the 'provider' field.`,
          );
        } else {
          const found = findProviderProp(arg);
          if (found === null) {
            push(
              `${HELPER_NAME}(...) options literal is missing the ` +
                `required 'provider' field.`,
            );
          } else if (found.kind === 'spread') {
            push(
              `${HELPER_NAME}(...) options literal forwards 'provider' ` +
                `through a spread (${snippetAt(sf, found.node)}); the guard ` +
                `cannot verify it syntactically. Inline 'provider' on the ` +
                `literal instead.`,
            );
          } else if (found.kind === 'assignment') {
            const init = found.node.initializer;
            if (
              (ts.isStringLiteral(init) ||
                ts.isNoSubstitutionTemplateLiteral(init)) &&
              (init.text === 'square' || init.text === 'clover')
            ) {
              push(
                `${HELPER_NAME}(...) hardcodes provider: '${init.text}' as ` +
                  `a string literal. Use a value derived from the ` +
                  `location (e.g. usePaymentProvider(locationId)) instead.`,
              );
            }
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
    files = listSourceFiles(SCAN_ROOT);
  } catch (err) {
    console.error(
      `[check-provider-not-configured] FAIL — could not enumerate ${relative(
        ROOT,
        SCAN_ROOT,
      )}: ${(err as Error).message}`,
    );
    process.exit(2);
  }
  if (files.length === 0) {
    console.error(
      `[check-provider-not-configured] FAIL — no .ts/.tsx files found under ${relative(
        ROOT,
        SCAN_ROOT,
      )}. Refusing to run rather than silently passing.`,
    );
    process.exit(2);
  }

  const violations: Violation[] = [];
  for (const f of files) scanFile(f, violations);

  if (violations.length === 0) {
    console.log(
      `[check-provider-not-configured] OK — scanned ${files.length} file(s) under ${relative(
        ROOT,
        SCAN_ROOT,
      )}. Every ${HELPER_NAME}(...) call site passes a literal provider field.`,
    );
    return;
  }

  console.error(
    `\n[check-provider-not-configured] ${
      REPORT_ONLY ? 'REPORT' : 'FAIL'
    } — ${violations.length} ${HELPER_NAME}(...) call site(s) violate the contract:\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}:${v.column}`);
    console.error(`      · ${v.reason}`);
    console.error(`      · ${v.snippet}`);
  }
  console.error(
    `\nFix: every call site must pass a literal options object with a ` +
      `'provider' field that is not a hardcoded 'square' / 'clover' ` +
      `string literal. See client/src/lib/provider-not-configured.tsx.`,
  );

  if (!REPORT_ONLY) process.exit(1);
}

main();
