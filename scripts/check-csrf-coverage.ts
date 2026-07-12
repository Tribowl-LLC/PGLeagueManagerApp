/**
 * CSRF coverage guard (task #308, extended in tasks #338, #397, #446).
 *
 * Today CSRF protection is wired by a single global mount in
 * `server/index.ts`:
 *
 *   app.use('/api', csrfProtection)
 *
 * plus the EXEMPT_PATHS list in `server/middleware/csrf.ts`. Every
 * state-changing request to `/api/**` that isn't on EXEMPT_PATHS goes
 * through CSRF. A future contributor could add a new state-changing
 * route either:
 *
 *   1. DIRECTLY on `app` outside the `/api` prefix (e.g.
 *      `app.post('/foo', ...)` in any server-side file), or
 *
 *   2. INDIRECTLY by mounting a sub-router at a non-`/api` prefix
 *      (e.g. `app.use('/foo', myRouter)` where `myRouter` has
 *      `router.post('/bar', ...)` — effective path `/foo/bar`).
 *
 * Both patterns silently bypass the global mount. This script walks
 * every `.ts` file under `server/` (excluding `__tests__` and
 * `*.test.ts`) and:
 *
 *   a) Flags any `app.<method>('<path>', ...)` whose path doesn't
 *      start with `/api/` (case 1 above).
 *
 *   b) Tracks every `app.use('<prefix>', ..., <importedRouter>)`
 *      mount and the `router.<method>('<subpath>', ...)` calls in
 *      the imported router file, then flags any effective path
 *      (`<prefix>` + `<subpath>`) that doesn't start with `/api/`
 *      (case 2 above).
 *
 * The `EXPLICIT_NON_API_ALLOWLIST` below is the exhaustive set of
 * non-`/api` state-changing routes that have been audited and judged
 * safe (currently empty — see `docs/security/csrf-coverage.md`). To
 * add to it, document the rationale alongside the entry.
 *
 * Nested router composition (task #397, refined in #446): the guard
 * ALSO follows `<parentRouter>.use('<sub>', <childRouter>)` calls.
 * The child router inherits the parent's effective prefix(es), joined
 * with `<sub>`. Propagation is fixed-point so multi-level chains
 * (grandparent → parent → child) and fan-out (the same child mounted
 * under several parents) are handled — this closes the gap where a
 * parent router that has no direct routes of its own (only
 * `router.use(...)` composition) and is accidentally mounted at a
 * non-`/api` prefix would otherwise slip through, because there'd be
 * no parent-level direct route to trip case 1 or case 2 above.
 *
 * To do the propagation precisely, routes and mount prefixes are
 * tracked per `(file, routerVarName)` pair rather than per file. That
 * lets the script distinguish a parent Router var's routes from a
 * child Router var's routes when both are declared in the same source
 * file, so same-file composition propagates correctly without
 * conflating the two routers' route sets (#446). For cross-file
 * mounts, a default import resolves to its source file's
 * `export default <name>` Router var; if no explicit name is exported
 * (rare in this codebase — the convention is `export default router`),
 * the prefix is conservatively attributed to every local Router var
 * in the imported file, which preserves the prior file-as-router
 * behavior for that edge case.
 *
 * Parser contract / unsupported forms:
 *   - State-changing verbs covered: POST, PUT, PATCH, DELETE, and
 *     `.all()`. The Express `.all()` form registers a single handler
 *     for EVERY HTTP method (including the four explicit verbs above),
 *     so it's a state-changing mount and is flagged the same way.
 *     Plain `.get()` is intentionally not covered (GETs aren't
 *     state-changing for CSRF purposes).
 *   - `.use('<path>', <inlineHandler>)` is also covered (#471). The
 *     `app.use(string, handler)` / `router.use(string, handler)` form
 *     installs a handler for EVERY HTTP method on the path prefix —
 *     structurally identical to `.all()` — so an inline arrow/function
 *     literal or an identifier that doesn't resolve to a Router (i.e.
 *     a handler import or middleware function rather than a sub-router)
 *     is treated as a state-changing mount and flagged when its
 *     effective path falls outside `/api/`. Cross-file mounts where
 *     the imported identifier IS a Router still flow through the
 *     existing router-mount handling unchanged.
 *   - `app.use(router)` and `parent.use(child)` (no string prefix)
 *     are not modelled — the parser requires a string-literal prefix
 *     as the first argument. Mount-at-root composition is rare in
 *     practice and would require a separate parsing pass.
 *   - Cross-file composition (`parent.use('<sub>', importedChild)`)
 *     resolves the child via its source file's `export default <name>`
 *     declaration. The captured `<name>` is admitted as a Router var
 *     for the purposes of route/mount attribution only when there is
 *     evidence it's a Router (either a literal `Router()` declaration
 *     in that file, or any `<name>.<routeMethod|use>(...)` call on it).
 *     This catches factory-style routers
 *     (`const r = createRouter(); r.post(...); export default r;`) but
 *     deliberately rejects plain handler exports
 *     (`function h(req,res){...}; export default h;`) so that an
 *     `app.use('<prefix>', h)` mount falls into the new handler-mount
 *     branch instead of being silently treated as a router with no
 *     routes (#471). Files that default-export an inline expression
 *     (`export default Router()` or `export default createRouter()`)
 *     instead of a named var are still not resolved — the parser needs
 *     an identifier to bind the mount to.
 *   - Computed mount paths (`app.use(`/foo/${var}`, ...)`) are not
 *     modelled — the parser only matches plain string literals.
 *
 * Exits 0 if clean, 1 if any unallowlisted bypass is found.
 *
 * Run with: `npm run check:csrf` or `tsx scripts/check-csrf-coverage.ts`.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';

const SERVER_DIR = resolve(process.cwd(), 'server');

/**
 * Exhaustive list of non-`/api` state-changing effective paths that
 * have been security-audited and judged safe. Add an entry only with
 * a code comment justifying why CSRF is not required (e.g. an out-of-
 * band auth factor like `x-setup-secret`, a single-use signed token
 * in the body, or a handler that doesn't actually mutate state for
 * the methods CSRF protects).
 */
const EXPLICIT_NON_API_ALLOWLIST: readonly string[] = [
  // `app.use('/uploads/avatars', express.static(...))` in `server/index.ts`.
  // `express.static` is a read-only file server: it only responds to
  // GET/HEAD requests and falls through to the next handler for
  // POST/PUT/PATCH/DELETE, so it cannot be tricked into mutating
  // server state via a CSRF-able method. The new `.use(string, handler)`
  // coverage added in #471 surfaces this mount as a state-changing
  // handler shape, so it has to be allowlisted here.
  '/uploads/avatars',
  // `app.use("/{*splat}", ...)` in `server/vite.ts` — the dev SPA catchall and
  // the prod static-fallback. Both handlers respond with HTML for
  // unknown paths and don't mutate any server state. `server/vite.ts`
  // is part of the platform-managed Vite setup that may not be
  // modified, so the path is allowlisted here rather than rewritten.
  '/{*splat}',
];

// `app.<method>('<path>', ...)` — direct routes on the Express app.
// `all` is included in the alternation because `app.all(path, handler)`
// registers the handler for EVERY HTTP method (including POST/PUT/PATCH/
// DELETE), so an `.all()` mount outside `/api/` would silently bypass
// CSRF just like an explicit verb would.
// Groups: 1=method, 2=quote, 3=path.
const APP_ROUTE_RE =
  /\bapp\s*\.\s*(all|post|put|patch|delete)\s*\(\s*(['"`])([^'"`]+)\2/g;

// Match the OPEN of any `<callerId>.use(` call (both `app.use(` and
// `<routerVar>.use(` are unified through one scanner). The actual
// argument list — prefix string + rest-args — is then extracted via
// balanced-paren walking (`findBalancedClose`) rather than a flat
// `[^)]+` regex, because rest-args legitimately include nested
// expressions and inline arrow/function literals like
// `(req, res) => res.sendStatus(200)` whose inner `)` would
// otherwise truncate the capture mid-arg. The earlier regex-only
// version of this scan missed `app.use('<path>', (req,res) => ...)`
// for exactly that reason — that's the bypass hole #471 closes.
// Group 1 = callerId.
const USE_CALL_OPEN_RE = /\b([A-Za-z_$][\w$]*)\s*\.\s*use\s*\(/g;

// Inside the rest-args of a `.use(prefix, ...)` call, the leading
// shape of an inline arrow/function literal. We strip string literals
// before applying this so that a `=>` or `function` token inside a
// quoted string can't false-positive as a handler. The detection is
// "anywhere in rest-args" rather than "as the last argument" because
// a handler is a handler whether it's the only argument
// (`use('/x', () => ...)`) or follows middlewares
// (`use('/x', requireAuth, () => ...)`).
const INLINE_ARROW_RE = /=>/;
const INLINE_FUNCTION_RE = /\bfunction\s*\*?\s*[A-Za-z_$\w]*\s*\(/;

// `<id>.<method>('<subpath>', ...)` — any router method call. We skip
// `id === 'app'` because direct app routes are handled separately.
// `all` is included for the same reason as in APP_ROUTE_RE: a
// `router.all('<subpath>', handler)` mount registers the handler for
// every HTTP method, so it's state-changing and must be flagged when
// its effective path falls outside `/api/`.
// Groups: 1=id, 2=method, 3=quote, 4=subpath.
const ROUTER_ROUTE_RE =
  /\b([A-Za-z_$][\w$]*)\s*\.\s*(all|post|put|patch|delete)\s*\(\s*(['"`])([^'"`]+)\3/g;

// Default imports: `import name from 'spec'`.
const IMPORT_DEFAULT_RE = /import\s+([A-Za-z_$][\w$]*)\s+from\s+(['"])([^'"]+)\2/g;

// Local Router definitions: `const <name> = Router()` or
// `const <name> = express.Router()`. Tolerates an optional TS type
// annotation between the name and `=`.
const LOCAL_ROUTER_RE =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:express\s*\.\s*)?Router\s*\(/g;

// `export default <name>;` — used to map a default-imported router
// (in some other file) back to the specific Router var declared in
// THIS file. Only matters when `<name>` resolves to a local Router
// var (the call site filters non-Router defaults out).
const EXPORT_DEFAULT_RE = /\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*;?/g;

const IDENT_RE = /\b([A-Za-z_$][\w$]*)\b/g;

interface Violation {
  method: string;
  path: string;
  source: string;
  detail?: string;
}

// A `RouterKey` identifies a specific Router var inside a specific
// file. NUL is used as the separator so a literal occurrence in a
// path (vanishingly unlikely, but defensively impossible) cannot
// collide with the file/var boundary.
type RouterKey = string;
const KEY_SEP = '\u0000';

function makeKey(file: string, varName: string): RouterKey {
  return file + KEY_SEP + varName;
}

function unpackKey(key: RouterKey): { file: string; varName: string } {
  const idx = key.indexOf(KEY_SEP);
  return { file: key.slice(0, idx), varName: key.slice(idx + 1) };
}

function walkTs(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === '__tests__') continue;
      out.push(...walkTs(full));
    } else if (
      st.isFile() &&
      name.endsWith('.ts') &&
      !name.endsWith('.d.ts') &&
      !name.endsWith('.test.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function resolveImport(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  // Tolerate `.js` extensions (common ESM-style relative imports).
  const base = resolve(dirname(fromFile), spec.replace(/\.js$/, ''));
  for (const candidate of [base + '.ts', join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function joinPaths(prefix: string, subpath: string): string {
  const cleanSub = subpath.startsWith('/') ? subpath : '/' + subpath;
  if (cleanSub === '/') return prefix;
  return prefix + cleanSub;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Walk forward from `openIdx` (which must point at '(') until the
// matching ')' at depth 0. Tracks string literals so a paren inside a
// quoted string doesn't perturb the depth counter. Returns -1 if no
// match is found before EOF (truncated/malformed source).
function findBalancedClose(src: string, openIdx: number): number {
  if (src[openIdx] !== '(') return -1;
  let depth = 0;
  let inStr: string | null = null;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (inStr !== null) {
      if (c === '\\') {
        // Skip the next character (escape sequence). Template strings
        // can have `${...}` interpolations whose inner parens we'd
        // miss this way, but the prefix arg of a `.use(...)` call is a
        // string literal we already handle separately, and rest-args
        // realistically don't embed paren-bearing template literals.
        i++;
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inStr = c;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Strip single, double, and template string literals from a source
// fragment (best-effort). We use this before the inline-handler check
// and the identifier extraction so that string contents don't
// accidentally look like JS identifiers (`'uploads'` → `uploads`) or
// arrow functions (`'=>...'` → `=>`).
function stripStrings(s: string): string {
  return s
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

// Does `restArgs` contain an inline arrow or function literal? This is
// the "inline handler" half of the new `.use(string, handler)`
// coverage (#471). Strings are stripped first so a `=>` or `function`
// token inside a string can't false-positive.
function hasInlineHandler(restArgs: string): boolean {
  const stripped = stripStrings(restArgs);
  return INLINE_ARROW_RE.test(stripped) || INLINE_FUNCTION_RE.test(stripped);
}

function main(): void {
  const files = walkTs(SERVER_DIR);

  // Cache stripped sources so the two passes don't re-read+re-strip
  // every file. The script is fast either way; this just keeps the
  // intent (one parse per file) explicit.
  const srcByFile = new Map<string, string>();
  for (const file of files) {
    srcByFile.set(file, stripComments(readFileSync(file, 'utf8')));
  }

  // ------------------------------------------------------------------
  // Pass 1: per-file discovery.
  //
  // We need to know two things up front before we can attribute mount
  // prefixes to specific Router vars:
  //   - Which identifiers in each file are local `Router()` vars.
  //   - Which (if any) of those vars is the file's `export default`.
  //
  // Pass 2 then uses this to resolve cross-file `app.use('/foo',
  // importedRouter)` mounts down to the actual Router var declared
  // inside the imported file, instead of attributing the prefix to
  // the file as a whole.
  // ------------------------------------------------------------------
  const fileToLocalRouterVars = new Map<string, Set<string>>();
  const fileToDefaultExportVar = new Map<string, string>();
  for (const file of files) {
    const src = srcByFile.get(file);
    if (src === undefined) continue; // populated in lockstep with `files`; defensive
    const vars = new Set<string>();
    for (const m of src.matchAll(LOCAL_ROUTER_RE)) vars.add(m[1]);
    // Last `export default <name>` wins (a file shouldn't have more
    // than one, but matchAll gives a deterministic outcome either
    // way). The captured name is admitted as a Router var only when
    // there's evidence it's a Router — either the name was already
    // matched by `LOCAL_ROUTER_RE` (a literal `Router()` declaration)
    // OR it appears in the source as the receiver of a router-shaped
    // method call (`<name>.<get|post|...|use>(...)`). The second clause
    // catches factory patterns
    // (`const r = createRouter(); r.post(...); export default r;`)
    // where `r` isn't matched by `LOCAL_ROUTER_RE` but is still the
    // file's effective Router.
    //
    // The "evidence" guard exists because `.use(string, handler)`
    // coverage (#471) added a new branch that treats an `app.use(
    // '<prefix>', importedThing)` mount as a state-changing handler
    // mount when `importedThing` does NOT resolve to a Router.
    // Without the guard, ANY default-exported identifier (including a
    // plain handler function — `function h(req,res){...} export
    // default h;`) would silently be admitted as a Router var, the
    // resolver would treat the mount as a router mount with no routes
    // (silent), and the new handler-mount branch would never fire —
    // re-introducing exactly the bypass shape this task closes.
    let lastDefault: string | undefined;
    for (const m of src.matchAll(EXPORT_DEFAULT_RE)) {
      lastDefault = m[1];
    }
    if (lastDefault !== undefined) {
      const usageRe = new RegExp(
        `\\b${escapeRegExp(lastDefault)}\\s*\\.\\s*(?:get|post|put|patch|delete|all|use)\\s*\\(`,
      );
      if (vars.has(lastDefault) || usageRe.test(src)) {
        vars.add(lastDefault);
        fileToDefaultExportVar.set(file, lastDefault);
      }
    }
    fileToLocalRouterVars.set(file, vars);
  }

  // Resolve a file that is being default-imported elsewhere down to
  // the set of `RouterKey`s the import targets.
  //   - Preferred path: the file has an explicit `export default <name>`
  //     where `<name>` is a local Router var. Returns one key.
  //   - Fallback: no recognised default-export name. Conservatively
  //     return every local Router var in the file. With the prevailing
  //     "one Router per file" convention this is identical to the
  //     preferred path; if the convention is broken in some future file
  //     it over-attributes (might surface a spurious extra effective
  //     path) rather than under-attributing (silently missing a
  //     bypass), which is the right side to err on for a CSRF guard.
  function resolveDefaultImportTargets(importedFile: string): RouterKey[] {
    const explicit = fileToDefaultExportVar.get(importedFile);
    if (explicit !== undefined) return [makeKey(importedFile, explicit)];
    const vars = fileToLocalRouterVars.get(importedFile);
    if (!vars || vars.size === 0) return [];
    return Array.from(vars, (v) => makeKey(importedFile, v));
  }

  // ------------------------------------------------------------------
  // Pass 2: collect mount prefixes, composition edges, and routes,
  // all keyed per (file, routerVarName) pair.
  // ------------------------------------------------------------------

  // RouterKey -> set of mount prefixes seen for that specific Router
  // var (from `app.use(...)` sites in pass 2 plus anything propagated
  // through composition edges in the propagation loop below).
  const varToMountPrefixes = new Map<RouterKey, Set<string>>();

  // RouterKey -> direct routes registered on THAT EXACT Router var
  // (not on the file as a whole — this is the per-var precision that
  // makes same-file composition work without conflating the parent's
  // and child's route sets, #446).
  const routerRoutesByVar = new Map<RouterKey, { method: string; subpath: string }[]>();

  // Composition edges discovered from `<parent>.use('<sub>', <child>)`
  // calls. Each edge says: "the child Router var inherits the parent
  // Router var's effective prefixes, each joined with `<sub>`."
  // Cross-file (child is a default-imported router) and same-file
  // (child is another local Router var in the same file) are both
  // modelled. Propagation runs to a fixed point AFTER all `app.use`
  // mounts have been recorded so the direction of resolution
  // (root mount → leaf router) is correct regardless of source-file
  // iteration order.
  interface CompositionEdge {
    parentKey: RouterKey;
    sub: string;
    childKey: RouterKey;
    sourceFile: string; // file the edge was declared in (for diagnostics)
  }
  const compositionEdges: CompositionEdge[] = [];

  const directAppRoutes: Violation[] = [];

  function addPrefix(key: RouterKey, prefix: string): void {
    let s = varToMountPrefixes.get(key);
    if (!s) {
      s = new Set();
      varToMountPrefixes.set(key, s);
    }
    s.add(prefix);
  }

  for (const file of files) {
    const src = srcByFile.get(file);
    const localRouterVars = fileToLocalRouterVars.get(file);
    if (src === undefined || localRouterVars === undefined) continue; // populated above; defensive

    // Build local default-import map: localName -> resolved file path.
    const importMap = new Map<string, string>();
    for (const m of src.matchAll(IMPORT_DEFAULT_RE)) {
      const localName = m[1];
      const spec = m[3];
      const resolved = resolveImport(file, spec);
      if (resolved) importMap.set(localName, resolved);
    }

    // Unified scan over every `<callerId>.use(...)` call. For each
    // call we extract `(prefix, restArgs)` via balanced-paren walking
    // and classify the call into one of:
    //
    //   - ROUTER MOUNT (cross-file): rest-args resolve to a default-
    //     imported file with a recognised default Router export.
    //     Records a mount prefix on that Router var.
    //   - ROUTER MOUNT (same-file): rest-args resolve to a local
    //     Router var in this file. Records a mount prefix on that var
    //     (when the caller is `app`) or a composition edge from the
    //     caller's Router var to it (when the caller is itself a
    //     local Router var).
    //   - HANDLER MOUNT: rest-args contain an inline arrow/function
    //     literal, OR the last identifier in rest-args is something
    //     other than a Router (an imported handler/middleware, or
    //     unresolved). This is the new branch added in #471 — Express
    //     installs the handler for EVERY HTTP method on the path
    //     prefix, structurally identical to `.all()`, so it has to be
    //     flagged as state-changing. The mount is recorded as a
    //     synthetic `USE` route on either `directAppRoutes` (when
    //     `callerId === 'app'`) or the parent Router var's route
    //     list (when the caller is a local Router var). The standard
    //     effective-path computation then picks it up exactly like
    //     a `.post()`/`.all()` mount.
    //
    // Calls where the caller is neither `app` nor a known local
    // Router var are skipped — same as before, we have no resolvable
    // mount chain for them.
    type Resolution =
      | { kind: 'router-import'; importedFile: string }
      | { kind: 'router-local'; varName: string }
      | { kind: 'handler' }
      | { kind: 'none' };

    for (const callMatch of src.matchAll(USE_CALL_OPEN_RE)) {
      const callerId = callMatch[1];
      const openIdx = callMatch.index + callMatch[0].length - 1;
      const closeIdx = findBalancedClose(src, openIdx);
      if (closeIdx < 0) continue;
      const argsText = src.slice(openIdx + 1, closeIdx);

      // Parser contract: first arg must be a string-literal prefix.
      // Calls without one (`app.use(middleware)`, `app.use(express
      // .static(...))`) are out of scope, same as before #471.
      const prefixMatch = /^\s*(['"`])([^'"`]+)\1\s*,\s*/.exec(argsText);
      if (!prefixMatch) continue;
      const prefix = prefixMatch[2];
      const restArgs = argsText.slice(prefixMatch[0].length);

      let resolution: Resolution;
      if (hasInlineHandler(restArgs)) {
        resolution = { kind: 'handler' };
      } else {
        const restNoStrings = stripStrings(restArgs);
        const idents = [...restNoStrings.matchAll(IDENT_RE)].map((x) => x[1]);
        let resolved: Resolution | null = null;
        for (let i = idents.length - 1; i >= 0; i--) {
          const id = idents[i];
          // Skip the caller itself in case it shows up in rest-args.
          if (id === callerId) continue;
          const importedFile = importMap.get(id);
          if (importedFile) {
            const targets = resolveDefaultImportTargets(importedFile);
            // If the import resolves to a recognised Router file
            // (per the Pass-1 evidence guard), it's a router mount.
            // Otherwise it's a handler/middleware import — handler
            // mount.
            resolved =
              targets.length > 0
                ? { kind: 'router-import', importedFile }
                : { kind: 'handler' };
            break;
          }
          if (localRouterVars.has(id)) {
            resolved = { kind: 'router-local', varName: id };
            break;
          }
        }
        // If the loop walked every identifier without matching, fall
        // back: any idents at all → treat as a handler mount (some
        // unresolved expression that nonetheless registers a request
        // handler — e.g. `app.use('/x', someUnknownThing)`); empty
        // rest-args → leave the call untracked.
        resolution =
          resolved ?? (idents.length > 0 ? { kind: 'handler' } : { kind: 'none' });
      }

      if (callerId === 'app') {
        if (resolution.kind === 'router-import') {
          for (const targetKey of resolveDefaultImportTargets(resolution.importedFile)) {
            addPrefix(targetKey, prefix);
          }
        } else if (resolution.kind === 'router-local') {
          addPrefix(makeKey(file, resolution.varName), prefix);
        } else if (resolution.kind === 'handler') {
          directAppRoutes.push({
            method: 'USE',
            path: prefix,
            source: file,
            detail: 'inline handler / non-router mount',
          });
        }
      } else if (localRouterVars.has(callerId)) {
        const parentKey = makeKey(file, callerId);
        if (resolution.kind === 'router-import') {
          for (const childKey of resolveDefaultImportTargets(resolution.importedFile)) {
            compositionEdges.push({ parentKey, sub: prefix, childKey, sourceFile: file });
          }
        } else if (resolution.kind === 'router-local') {
          const childKey = makeKey(file, resolution.varName);
          compositionEdges.push({ parentKey, sub: prefix, childKey, sourceFile: file });
        } else if (resolution.kind === 'handler') {
          let routes = routerRoutesByVar.get(parentKey);
          if (!routes) {
            routes = [];
            routerRoutesByVar.set(parentKey, routes);
          }
          routes.push({ method: 'USE', subpath: prefix });
        }
      }
      // else: caller is neither `app` nor a known local Router var —
      // unmodelled, skip.
    }

    // Direct app.<method>('<path>', ...) routes anywhere in server/.
    for (const m of src.matchAll(APP_ROUTE_RE)) {
      directAppRoutes.push({
        method: m[1].toUpperCase(),
        path: m[3],
        source: file,
      });
    }

    // <id>.<method>('<subpath>', ...) — router routes, attributed to
    // the EXACT (file, id) pair they were called on. Skip `app`
    // (handled above) and any `<id>` that isn't a recognised local
    // Router var in this file: such a call has no resolvable mount
    // chain in this guard's model (the id might be an imported router
    // mutated cross-file, a non-Router object that happens to have a
    // `.post` method, etc.), so attributing routes to it would be
    // noise rather than coverage.
    for (const m of src.matchAll(ROUTER_ROUTE_RE)) {
      const id = m[1];
      if (id === 'app') continue;
      if (!localRouterVars.has(id)) continue;
      const key = makeKey(file, id);
      let routes = routerRoutesByVar.get(key);
      if (!routes) {
        routes = [];
        routerRoutesByVar.set(key, routes);
      }
      routes.push({ method: m[2].toUpperCase(), subpath: m[4] });
    }
  }

  // Propagate parent → child prefixes through composition edges to a
  // fixed point. Each iteration walks every edge once; we stop when no
  // child set grows. Termination is guaranteed because every iteration
  // either adds at least one new (childKey, prefix) pair or halts,
  // and the universe of such pairs is finite. Cycles (which shouldn't
  // happen in real router graphs anyway) terminate harmlessly for the
  // same reason.
  //
  // The iteration cap is a defensive belt-and-braces against a future
  // bug in the propagation rule that would otherwise spin forever; in
  // a well-formed graph the inner loop terminates in 1 pass per chain
  // depth, so 64 is well above any plausible nesting in this codebase.
  const PROPAGATION_CAP = 64;
  let propagationExhausted = false;
  for (let pass = 0; pass < PROPAGATION_CAP; pass++) {
    let changed = false;
    for (const edge of compositionEdges) {
      const parentPrefixes = varToMountPrefixes.get(edge.parentKey);
      if (!parentPrefixes || parentPrefixes.size === 0) continue;
      // Snapshot before iterating. A self-edge (parentKey === childKey)
      // would otherwise grow the Set during iteration. The check below
      // would still terminate via PROPAGATION_CAP, but the snapshot
      // makes the iteration itself well-defined regardless.
      const parentSnapshot = Array.from(parentPrefixes);
      let childSet = varToMountPrefixes.get(edge.childKey);
      if (!childSet) {
        childSet = new Set();
        varToMountPrefixes.set(edge.childKey, childSet);
      }
      for (const pp of parentSnapshot) {
        const combined = joinPaths(pp, edge.sub);
        if (!childSet.has(combined)) {
          childSet.add(combined);
          changed = true;
        }
      }
    }
    if (!changed) break;
    if (pass === PROPAGATION_CAP - 1) propagationExhausted = true;
  }
  // If propagation was still adding entries at the cap, the router
  // graph almost certainly contains a cycle (or the chain is deeper
  // than the cap). Either way the prefix set we computed is
  // INCOMPLETE — there could be effective paths we never visited,
  // any of which might be a non-/api bypass. Fail loudly rather than
  // silently under-report.
  if (propagationExhausted) {
    console.error(
      `[check-csrf-coverage] FAIL — composition-edge propagation did not converge in ${PROPAGATION_CAP} passes. The router-composition graph likely contains a cycle, or the chain is deeper than the cap. Effective-path computation is INCOMPLETE; results below may be missing bypasses. Investigate scripts/check-csrf-coverage.ts and the router import graph.`,
    );
    process.exit(1);
  }

  const violations: Violation[] = [];

  // Case 1: direct app.<method> routes outside /api.
  for (const r of directAppRoutes) {
    if (r.path.startsWith('/api/') || r.path === '/api') continue;
    if (EXPLICIT_NON_API_ALLOWLIST.includes(r.path)) continue;
    violations.push(r);
  }

  // Case 2: router.<method> routes whose effective mount path is
  // outside /api. A Router var with no recorded mount is silently
  // skipped — either it's mounted via a pattern we don't parse, or
  // it isn't wired up yet (no live exposure to flag).
  for (const [key, routes] of routerRoutesByVar) {
    const prefixes = varToMountPrefixes.get(key);
    if (!prefixes || prefixes.size === 0) continue;
    const { file } = unpackKey(key);
    for (const r of routes) {
      for (const prefix of prefixes) {
        const effective = joinPaths(prefix, r.subpath);
        if (effective.startsWith('/api/') || effective === '/api') continue;
        if (EXPLICIT_NON_API_ALLOWLIST.includes(effective)) continue;
        violations.push({
          method: r.method,
          path: effective,
          source: file,
          detail: `mounted at '${prefix}' + '${r.subpath}'`,
        });
      }
    }
  }

  if (violations.length === 0) {
    console.log(
      '[check-csrf-coverage] OK — no state-changing routes outside /api detected anywhere in server/.',
    );
    return;
  }

  console.error(
    '[check-csrf-coverage] FAIL — state-changing routes outside /api detected:',
  );
  for (const v of violations) {
    const rel = relative(process.cwd(), v.source);
    const tail = v.detail ? `  [${v.detail}]` : '';
    console.error(`  - ${v.method} ${v.path}  (in ${rel})${tail}`);
  }
  console.error(
    "\nThe global CSRF mount is `app.use('/api', csrfProtection)` — routes\n" +
      'outside /api silently bypass it. Either move the route under /api,\n' +
      'or (only with security-team sign-off) add it to\n' +
      'EXPLICIT_NON_API_ALLOWLIST in scripts/check-csrf-coverage.ts with\n' +
      'an inline justification. See docs/security/csrf-coverage.md.',
  );
  process.exit(1);
}

main();
