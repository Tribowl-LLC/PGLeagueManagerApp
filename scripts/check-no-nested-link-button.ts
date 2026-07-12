#!/usr/bin/env tsx
/**
 * Nested-link/button drift guard (task #617).
 *
 * Tasks #596 and #601 cleaned up every place where a wouter
 * `<Link>` wrapped a `<button>` / shadcn `<Button>` (and vice
 * versa). That pattern produces invalid HTML (`<a><button></button></a>`
 * or `<button><a></a></button>`), breaks middle-click /
 * cmd-click "open in new tab", and confuses screen readers
 * which announce a button nested inside a link as two
 * overlapping interactive elements.
 *
 * Without a CI guard, the next contributor wrapping "this
 * Button in a Link to make it navigate" silently re-introduces
 * the bug. This script walks every `.tsx` file under
 * `client/src/` and flags two shapes:
 *
 *   (a) A `<Link>` from `wouter` whose direct JSX children
 *       contain a `<button>` or `<Button>` element.
 *   (b) A `<button>` or `<Button>` whose direct JSX children
 *       contain a `<Link>` element (in a file that imports
 *       `Link` from `'wouter'`).
 *   (c) A wouter `<Link>` whose direct JSX children contain
 *       another `<Link>` or a plain `<a>` element (task #656).
 *       Two stacked anchors render `<a><a></a></a>`, which is
 *       just as invalid as `<a><button></button></a>`, breaks
 *       middle/cmd-click on the inner navigation, and confuses
 *       screen readers the same way.
 *
 * Skipped (intentionally good patterns):
 *   - `<Button asChild><Link/></Button>` — the canonical fix.
 *     Radix's `Slot` merges the Button's styling onto the
 *     `<Link>`'s underlying `<a>`, producing a single
 *     interactive element. The guard skips any parent JSX
 *     element that has an `asChild` prop.
 *   - `<Link><Button asChild>…</Button></Link>` — the inner
 *     `<Button asChild>` doesn't render its own `<button>`
 *     either; Slot merges the styling onto the asChild's
 *     own child (e.g. a `<span>`), so the resulting DOM is
 *     just `<a><span class="…">…</span></a>`. The guard
 *     skips any inner `<button>` / `<Button>` that has an
 *     `asChild` prop, including when it's reached through
 *     wrapper divs/spans.
 *   - Files that don't import `Link` from `'wouter'` — a
 *     `<Link>` from another library (e.g. `lucide-react`'s
 *     `Link2` icon, or a project-local `Link` component) is
 *     out of scope for this check.
 *
 * Wrapper handling (task #645): purely presentational JSX
 * wrappers — host `<div>` / `<span>` and fragments
 * (`<>…</>` and `<React.Fragment>`) — are walked through.
 * `<Link><div className="..."><Button/></div></Link>` still
 * compiles down to `<a><button></button></a>`, so the guard
 * descends past those wrappers when hunting for the inner
 * `<button>` / `<Button>` (and vice versa). The walk stops
 * at the first non-wrapper JSX element so unrelated
 * components below are out of scope.
 *
 * Usage:
 *   tsx scripts/check-no-nested-link-button.ts            # CI mode (exit 1 on violations)
 *   tsx scripts/check-no-nested-link-button.ts --report   # print without failing
 *
 * Sister of `scripts/check-not-found-code.ts` /
 * `scripts/check-wire-sanitization.ts`. Pinned by
 * `tests/unit/check-no-nested-link-button.test.ts`, which
 * runs the real binary against the real codebase plus
 * synthetic fixtures.
 */
import ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const SCAN_ROOT = join(ROOT, 'client/src');
const REPORT_ONLY = process.argv.includes('--report');

interface Violation {
  file: string;
  line: number;
  column: number;
  reason: string;
  snippet: string;
}

function listTsxFiles(dir: string): string[] {
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
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
      } else if (
        st.isFile() &&
        full.endsWith('.tsx') &&
        !full.endsWith('.d.ts') &&
        !full.endsWith('.test.tsx')
      ) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

/**
 * Walk an import declaration and report every named import that
 * comes from the given module specifier. We only care whether
 * `Link` is one of them.
 */
function fileImportsLinkFromWouter(sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === 'wouter' &&
      node.importClause &&
      node.importClause.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const spec of node.importClause.namedBindings.elements) {
        // `import { Link }` or `import { Link as L }` — the
        // imported (right-hand) name is `propertyName ?? name`.
        const importedName = (spec.propertyName ?? spec.name).text;
        const localName = spec.name.text;
        if (importedName === 'Link' && localName === 'Link') {
          found = true;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function getJsxTagName(opening: ts.JsxOpeningLikeElement): string | null {
  const name = opening.tagName;
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isPropertyAccessExpression(name)) {
    // Dotted JSX names like `React.Fragment`. Flatten the chain
    // so `<React.Fragment>` reads as the string "React.Fragment".
    const parts: string[] = [];
    let cur: ts.LeftHandSideExpression = name;
    while (ts.isPropertyAccessExpression(cur)) {
      parts.unshift(cur.name.text);
      cur = cur.expression;
    }
    if (ts.isIdentifier(cur)) {
      parts.unshift(cur.text);
      return parts.join('.');
    }
  }
  return null;
}

/**
 * Purely presentational JSX wrappers (task #645). A `<Link>`
 * wrapping a `<div className="…">` wrapping a `<Button>` still
 * compiles to `<a><div><button/></div></a>`, which is just as
 * invalid as the direct `<a><button/></a>`. The guard descends
 * through these wrappers when looking for the next interactive
 * element.
 *
 * Only host wrappers (`div`, `span`) and fragment forms
 * (`React.Fragment` / `Fragment`; bare `<>…</>` is handled by
 * the JsxFragment branch in the walker) count. Custom
 * components are deliberately out of scope — they can render
 * anything, and treating `<MyCard>` as transparent would chase
 * false positives into unrelated subtrees.
 */
const WRAPPER_TAGS = new Set<string>([
  'div',
  'span',
  'Fragment',
  'React.Fragment',
]);

function isWrapperOpening(opening: ts.JsxOpeningLikeElement): boolean {
  const tag = getJsxTagName(opening);
  return tag !== null && WRAPPER_TAGS.has(tag);
}

function jsxHasAsChildProp(opening: ts.JsxOpeningLikeElement): boolean {
  for (const attr of opening.attributes.properties) {
    if (
      ts.isJsxAttribute(attr) &&
      ts.isIdentifier(attr.name) &&
      attr.name.text === 'asChild'
    ) {
      // `asChild` (no initializer) === `asChild={true}`. Either
      // way the slot pattern is in play and the parent isn't
      // really rendering its own `<button>` or `<a>`.
      if (attr.initializer === undefined) return true;
      if (
        ts.isJsxExpression(attr.initializer) &&
        attr.initializer.expression &&
        attr.initializer.expression.kind === ts.SyntaxKind.FalseKeyword
      ) {
        return false;
      }
      return true;
    }
  }
  return false;
}

/**
 * JSX element descendants of a JsxElement that the author is
 * effectively nesting "inside" the parent for DOM purposes.
 * Text and comment children are ignored. JsxExpression
 * children (e.g. `{cond && <X/>}`) are walked: a literal
 * `<Button/>` inside a simple conditional or fragment is still
 * author-visible nesting.
 *
 * Task #645: presentational wrappers (`div`, `span`,
 * fragments, `React.Fragment`) are walked through. The wrapper
 * itself is still emitted (so the caller can see e.g. the
 * `<div>`), but the recursion continues into its children so a
 * `<Button>` buried under one or more styling wrappers is
 * still detected. Recursion stops at the first non-wrapper
 * JsxElement so unrelated component subtrees stay out of
 * scope.
 */
function directChildJsx(parent: ts.JsxElement): ts.JsxOpeningLikeElement[] {
  const out: ts.JsxOpeningLikeElement[] = [];
  collectInteractiveDescendants(parent, out);
  return out;
}

function collectInteractiveDescendants(
  parent: ts.JsxElement | ts.JsxFragment,
  out: ts.JsxOpeningLikeElement[],
): void {
  for (const child of parent.children) {
    if (ts.isJsxElement(child)) {
      out.push(child.openingElement);
      if (isWrapperOpening(child.openingElement)) {
        collectInteractiveDescendants(child, out);
      }
    } else if (ts.isJsxSelfClosingElement(child)) {
      out.push(child);
    } else if (ts.isJsxFragment(child)) {
      // Bare `<>…</>` fragments don't render a DOM node; descend
      // through them as if their children were direct.
      collectInteractiveDescendants(child, out);
    } else if (ts.isJsxExpression(child) && child.expression) {
      collectJsxFromExpression(child.expression, out);
    }
  }
}

function collectJsxFromExpression(
  expr: ts.Expression,
  out: ts.JsxOpeningLikeElement[],
): void {
  if (ts.isJsxElement(expr)) {
    out.push(expr.openingElement);
    if (isWrapperOpening(expr.openingElement)) {
      collectInteractiveDescendants(expr, out);
    }
    return;
  }
  if (ts.isJsxSelfClosingElement(expr)) {
    out.push(expr);
    return;
  }
  if (ts.isJsxFragment(expr)) {
    collectInteractiveDescendants(expr, out);
    return;
  }
  if (ts.isParenthesizedExpression(expr)) {
    collectJsxFromExpression(expr.expression, out);
    return;
  }
  if (ts.isConditionalExpression(expr)) {
    collectJsxFromExpression(expr.whenTrue, out);
    collectJsxFromExpression(expr.whenFalse, out);
    return;
  }
  if (ts.isBinaryExpression(expr)) {
    // `cond && <X/>` and `a || <X/>` — both branches may render
    // the element.
    if (
      expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      expr.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
      collectJsxFromExpression(expr.left, out);
      collectJsxFromExpression(expr.right, out);
    }
  }
}

function snippetAt(sf: ts.SourceFile, node: ts.Node): string {
  const text = sf.text;
  const start = node.getStart(sf);
  const end = node.getEnd();
  const slice = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return slice.length > 160 ? `${slice.slice(0, 157)}...` : slice;
}

const BUTTON_TAGS = new Set<string>(['button', 'Button']);

function scanFile(filePath: string, violations: Violation[]): void {
  const text = readFileSync(filePath, 'utf8');
  const sf = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  );

  const linkIsWouter = fileImportsLinkFromWouter(sf);
  const relFile = relative(ROOT, filePath).replaceAll('\\', '/');

  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node)) {
      const tag = getJsxTagName(node.openingElement);
      if (tag !== null) {
        const parentHasAsChild = jsxHasAsChildProp(node.openingElement);
        const childOpenings = directChildJsx(node);

        // (a) wouter <Link> directly containing a <button> / <Button>.
        if (tag === 'Link' && linkIsWouter && !parentHasAsChild) {
          for (const child of childOpenings) {
            const childTag = getJsxTagName(child);
            if (childTag !== null && BUTTON_TAGS.has(childTag)) {
              // <Button asChild> doesn't render its own
              // <button> — Radix's Slot merges its styling onto
              // the child element (typically the wrapping
              // <Link>'s underlying <a>). Treat it the same as
              // the canonical opt-out and skip.
              if (jsxHasAsChildProp(child)) continue;
              const { line, character } = sf.getLineAndCharacterOfPosition(
                node.getStart(sf),
              );
              violations.push({
                file: relFile,
                line: line + 1,
                column: character + 1,
                reason:
                  `<Link> from 'wouter' directly contains <${childTag}>. ` +
                  'This produces invalid HTML (<a><button></button></a>), ' +
                  'breaks middle/cmd-click "open in new tab", and ' +
                  'confuses screen readers.',
                snippet: snippetAt(sf, node),
              });
              break; // one violation per parent is enough
            }
          }
        }

        // (b) <button> / <Button> directly containing a <Link>.
        if (BUTTON_TAGS.has(tag) && !parentHasAsChild && linkIsWouter) {
          for (const child of childOpenings) {
            const childTag = getJsxTagName(child);
            if (childTag === 'Link') {
              const { line, character } = sf.getLineAndCharacterOfPosition(
                node.getStart(sf),
              );
              violations.push({
                file: relFile,
                line: line + 1,
                column: character + 1,
                reason:
                  `<${tag}> directly contains a wouter <Link>. ` +
                  'This produces invalid HTML (<button><a></a></button>) ' +
                  'and breaks keyboard / screen-reader semantics.',
                snippet: snippetAt(sf, node),
              });
              break;
            }
          }
        }

        // (c) wouter <Link> directly containing another <Link>
        // or a plain <a> (task #656). Both render an inner
        // anchor inside the outer anchor (`<a><a></a></a>`),
        // which is invalid HTML, breaks middle/cmd-click on the
        // inner navigation, and confuses screen readers the same
        // way as the <Link>/<Button> shapes above.
        if (tag === 'Link' && linkIsWouter && !parentHasAsChild) {
          for (const child of childOpenings) {
            const childTag = getJsxTagName(child);
            if (childTag === 'Link' || childTag === 'a') {
              const { line, character } = sf.getLineAndCharacterOfPosition(
                node.getStart(sf),
              );
              violations.push({
                file: relFile,
                line: line + 1,
                column: character + 1,
                reason:
                  `<Link> from 'wouter' directly contains <${childTag}>. ` +
                  'This produces invalid HTML (<a><a></a></a>), ' +
                  'breaks middle/cmd-click "open in new tab" on the inner ' +
                  'navigation, and confuses screen readers. Collapse to a ' +
                  'single <Link> (or move one of the navigations out of ' +
                  'the other).',
                snippet: snippetAt(sf, node),
              });
              break;
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
    files = listTsxFiles(SCAN_ROOT);
  } catch (err) {
    console.error(
      `[check-no-nested-link-button] FAIL — could not enumerate ${relative(
        ROOT,
        SCAN_ROOT,
      )}: ${(err as Error).message}`,
    );
    process.exit(2);
  }
  if (files.length === 0) {
    // Sanity bottom: if the scan root is empty, the guard would
    // silently pass. Fail loud so a misplaced refactor doesn't
    // disable the check.
    console.error(
      `[check-no-nested-link-button] FAIL — no .tsx files found under ${relative(
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
      `[check-no-nested-link-button] OK — scanned ${files.length} .tsx file(s) under ${relative(
        ROOT,
        SCAN_ROOT,
      )}. No nested <Link>/<Button> violations.`,
    );
    return;
  }

  console.error(
    `\n[check-no-nested-link-button] ${REPORT_ONLY ? 'REPORT' : 'FAIL'} — ${violations.length} nested <Link>/<Button> site(s):\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}:${v.column}`);
    console.error(`      · ${v.reason}`);
    console.error(`      · ${v.snippet}`);
  }
  console.error(
    "\nFix: use one of the canonical patterns established in tasks #596 / #601:\n" +
      "  - For navigation styled like a button:  <Button asChild><Link href=\"/x\">Label</Link></Button>\n" +
      '    (see client/src/pages/profile-settings-page.tsx, bowler-dashboard-page.tsx, home-page.tsx)\n' +
      "  - For a plain styled link:               a single <Link> with className styling\n" +
      '    (see NavLeafRow in client/src/components/layout.tsx)\n' +
      '\nNever wrap a <Button> in a <Link> or a <Link> in a <Button> directly — it produces invalid <a><button></a> markup.\n',
  );

  if (!REPORT_ONLY) process.exit(1);
}

main();
