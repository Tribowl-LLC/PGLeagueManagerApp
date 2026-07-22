/**
 * Cross-org isolation coverage guard (task #345).
 *
 * Tasks #341 and #344 closed existing leak gaps in filtered-list and
 * fetch-by-id endpoints. Without a forcing function, the next refactor
 * or new endpoint can silently reintroduce a leak by:
 *
 *   1. Adding a new `router.get('/', ...)` handler that reads
 *      `req.query.<entity>Id` (filtered list).
 *   2. Adding a new `router.get('/:id', ...)` handler that scopes
 *      writes/reads by id (cross-resource fetch).
 *
 * This script enumerates every state-reading GET endpoint under
 * `server/routes/` whose handler reads an id-shaped query param OR
 * whose path contains an `:id` / `:<entity>Id` segment, computes the
 * effective full path (including nested `router.use('<sub>', ...)`
 * mounts), and verifies the path is referenced in
 * `tests/api/organization-isolation.test.ts`.
 *
 * By default the script prints a report and exits 0 (advisory mode
 * — the team can wire it as a non-blocking warn). Pass `--strict` to
 * exit 1 if any candidate endpoint is missing isolation coverage and
 * is not on `EXPLICIT_ALLOWLIST`. The allowlist requires an inline
 * justification (e.g. "endpoint enforces isolation via middleware
 * tested elsewhere").
 *
 * Run with: `npm run check:org-isolation` (advisory) or
 * `tsx scripts/check-org-isolation-coverage.ts --strict` (CI gate).
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';

const ROUTES_DIR = resolve(process.cwd(), 'server/routes');
const ROUTES_INDEX = resolve(process.cwd(), 'server/routes/index.ts');
const TEST_FILE = resolve(
  process.cwd(),
  'tests/api/organization-isolation.test.ts',
);

const STRICT = process.argv.includes('--strict');

/**
 * Effective paths intentionally not covered by the isolation suite,
 * with a one-line justification. Empty by default. Add an entry only
 * when the endpoint enforces isolation via a different forcing
 * function (e.g. middleware whose tests live elsewhere) or is not
 * cross-org-sensitive.
 */
const EXPLICIT_ALLOWLIST: Record<string, string> = {
  // Public branding assets — served unauthenticated so the sign-up page
  // and dynamic browser icons can fetch any org's logo/app-icon by id
  // without a session. There is no cross-org sensitivity by design.
  // NOTE: each entry below is intentionally one line (key + value)
  // because the unit fixture in tests/unit/check-org-isolation-coverage.test.ts
  // ("respects EXPLICIT_ALLOWLIST entries") parses this block line-by-line
  // and asserts every non-comment line carries a string-literal rationale.
  '/api/organizations/:id/logo': 'public branding asset (sign-up page); served unauthenticated by design',
  '/api/organizations/:id/app-icon': 'public branding asset (browser/app icon); served unauthenticated by design',
  // Profile avatar redirect — mounted under requireAuth (so a session
  // is required), but the handler only 302-redirects to a static file
  // under /uploads/avatars/<userId>.<ext>. The response carries no
  // org-scoped payload, so cross-org id traversal yields nothing more
  // than a public image already addressable at /uploads/avatars/...
  '/api/user/avatar/:userId': 'authenticated avatar redirect; response is a 302 to a static image with no org-sensitive payload',
};

const APP_USE_RE = /\bapp\s*\.\s*use\s*\(\s*(['"`])([^'"`]+)\1\s*,\s*([^)]+)\)/g;
const ROUTER_USE_RE =
  /\b([A-Za-z_$][\w$]*)\s*\.\s*use\s*\(\s*(['"`])([^'"`]+)\2\s*,\s*([^)]+)\)/g;
const IMPORT_DEFAULT_RE =
  /import\s+([A-Za-z_$][\w$]*)\s+from\s+(['"])([^'"]+)\2/g;
const LOCAL_ROUTER_RE =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:express\s*\.\s*)?Router\s*\(/g;
const ROUTE_REG_RE =
  /\b([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*(['"`])([^'"`]+)\3/g;
const IDENT_RE = /\b([A-Za-z_$][\w$]*)\b/g;
const REQ_QUERY_ID_RE = /\breq\.query\.([A-Za-z_$][\w$]*[Ii]d)\b/g;

interface Candidate {
  effectivePath: string;
  subpath: string;
  source: string;
  kind: 'fetch-by-id' | 'filtered-list' | 'fetch-and-filter';
  pathParams: string[];
  queryIdParams: string[];
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
  const base = resolve(dirname(fromFile), spec.replace(/\.js$/, ''));
  for (const candidate of [base + '.ts', join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function joinPaths(prefix: string, subpath: string): string {
  if (!subpath || subpath === '/') return prefix;
  const cleanSub = subpath.startsWith('/') ? subpath : '/' + subpath;
  // Trim trailing slash from prefix to avoid `/api/x` + `/y` = `/api/x/y` (good)
  // vs `/api/x/` + `/y` = `/api/x//y` (bad).
  const cleanPrefix = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  return cleanPrefix + cleanSub;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface FileInfo {
  file: string;
  src: string;
  importMap: Map<string, string>;
  localRouterVars: Set<string>;
  // app.use mounts in this file: prefix + identifier
  appUseMounts: { prefix: string; routerFile: string }[];
  // router.use mounts: parentVarName + prefix + childRouterFile
  routerUseMounts: { parentVar: string; subPrefix: string; childFile: string }[];
  // route registrations: { varName, method, subpath, bodySlice }
  routeRegs: {
    varName: string;
    method: string;
    subpath: string;
    body: string;
  }[];
}

function parseFile(file: string): FileInfo {
  const raw = readFileSync(file, 'utf8');
  const src = stripComments(raw);

  const importMap = new Map<string, string>();
  for (const m of src.matchAll(IMPORT_DEFAULT_RE)) {
    const localName = m[1];
    const spec = m[3];
    const resolved = resolveImport(file, spec);
    if (resolved) importMap.set(localName, resolved);
  }

  const localRouterVars = new Set<string>();
  for (const m of src.matchAll(LOCAL_ROUTER_RE)) {
    localRouterVars.add(m[1]);
  }

  function pickRouterFile(restArgs: string): string | null {
    const idents = [...restArgs.matchAll(IDENT_RE)].map((x) => x[1]);
    for (let i = idents.length - 1; i >= 0; i--) {
      const id = idents[i];
      const importedFile = importMap.get(id);
      if (importedFile) return importedFile;
      if (localRouterVars.has(id)) return file;
    }
    return null;
  }

  const appUseMounts: { prefix: string; routerFile: string }[] = [];
  for (const m of src.matchAll(APP_USE_RE)) {
    const routerFile = pickRouterFile(m[3]);
    if (routerFile) appUseMounts.push({ prefix: m[2], routerFile });
  }

  const routerUseMounts: {
    parentVar: string;
    subPrefix: string;
    childFile: string;
  }[] = [];
  for (const m of src.matchAll(ROUTER_USE_RE)) {
    const parentVar = m[1];
    if (parentVar === 'app') continue; // already captured above
    if (!localRouterVars.has(parentVar)) continue; // not a known router
    const subPrefix = m[3];
    const childFile = pickRouterFile(m[4]);
    if (childFile) routerUseMounts.push({ parentVar, subPrefix, childFile });
  }

  // Route registrations + handler-body slices. We compute slices by
  // ordering all router.<method>( positions and slicing the source
  // between consecutive positions. The slice is conservative — it
  // includes everything up to the next handler registration in the
  // same file, which is enough to find req.query.<...>Id reads inside
  // the handler body.
  const positions: {
    index: number;
    varName: string;
    method: string;
    subpath: string;
  }[] = [];
  for (const m of src.matchAll(ROUTE_REG_RE)) {
    positions.push({
      index: m.index ?? 0,
      varName: m[1],
      method: m[2].toLowerCase(),
      subpath: m[4],
    });
  }
  positions.sort((a, b) => a.index - b.index);
  const routeRegs: FileInfo['routeRegs'] = positions.map((p, i) => {
    const end = i + 1 < positions.length ? positions[i + 1].index : src.length;
    return {
      varName: p.varName,
      method: p.method,
      subpath: p.subpath,
      body: src.slice(p.index, end),
    };
  });

  return {
    file,
    src,
    importMap,
    localRouterVars,
    appUseMounts,
    routerUseMounts,
    routeRegs,
  };
}

function buildMountMap(parsed: FileInfo[]): Map<string, Set<string>> {
  // routerFile -> set of effective mount prefixes.
  const mounts = new Map<string, Set<string>>();
  function add(file: string, prefix: string) {
    if (!mounts.has(file)) mounts.set(file, new Set());
    mounts.get(file)!.add(prefix);
  }

  // Seed with app.use mounts (typically only in server/routes/index.ts
  // and server/index.ts).
  for (const f of parsed) {
    for (const mnt of f.appUseMounts) add(mnt.routerFile, mnt.prefix);
  }

  // Iterate router.use composition until fixed-point. Bounded to a
  // small constant (10) to avoid pathological loops.
  for (let i = 0; i < 10; i++) {
    let changed = false;
    for (const f of parsed) {
      const parentPrefixes = mounts.get(f.file);
      if (!parentPrefixes) continue;
      for (const ru of f.routerUseMounts) {
        for (const pp of parentPrefixes) {
          const childPrefix = joinPaths(pp, ru.subPrefix);
          const existing = mounts.get(ru.childFile);
          if (!existing || !existing.has(childPrefix)) {
            add(ru.childFile, childPrefix);
            changed = true;
          }
        }
      }
    }
    if (!changed) break;
  }

  return mounts;
}

function pathParamsOf(subpath: string): string[] {
  return [...subpath.matchAll(/:([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
}

/**
 * Task #345 scopes the lint to id-shaped path params only:
 * `req.params.<entity>Id` for cross-resource fetches. So `:id`,
 * `:bowlerId`, `:userId` count; `:slug`, `:type`, `:weekNumber`,
 * `:eventName` etc do not. Public slug-based lookups and
 * non-id-shaped path segments have different (or absent) cross-org
 * semantics and are out of scope for this guard.
 */
function isIdShapedPathParam(name: string): boolean {
  return name === 'id' || /Id$/.test(name);
}

function findCandidates(parsed: FileInfo[]): Candidate[] {
  const mounts = buildMountMap(parsed);
  const candidates: Candidate[] = [];

  for (const f of parsed) {
    const prefixes = mounts.get(f.file);
    if (!prefixes || prefixes.size === 0) continue;

    for (const reg of f.routeRegs) {
      if (reg.method !== 'get') continue;
      // Only consider routes registered on a known local router var
      // in this file. Skip mismatched vars (e.g. some other object).
      if (!f.localRouterVars.has(reg.varName)) continue;

      const pathParams = pathParamsOf(reg.subpath).filter(isIdShapedPathParam);
      const queryIdParams = [
        ...new Set(
          [...reg.body.matchAll(REQ_QUERY_ID_RE)].map((m) => m[1]),
        ),
      ];

      const hasPathParam = pathParams.length > 0;
      const hasQueryId = queryIdParams.length > 0;
      if (!hasPathParam && !hasQueryId) continue;

      let kind: Candidate['kind'];
      if (hasPathParam && hasQueryId) kind = 'fetch-and-filter';
      else if (hasPathParam) kind = 'fetch-by-id';
      else kind = 'filtered-list';

      for (const prefix of prefixes) {
        candidates.push({
          effectivePath: joinPaths(prefix, reg.subpath),
          subpath: reg.subpath,
          source: f.file,
          kind,
          pathParams,
          queryIdParams,
        });
      }
    }
  }

  // Stable sort for deterministic output.
  candidates.sort((a, b) => a.effectivePath.localeCompare(b.effectivePath));
  return candidates;
}

interface CoverageResult {
  covered: boolean;
  missingReasons: string[];
}

function checkCoverage(testSrc: string, c: Candidate): CoverageResult {
  const reasons: string[] = [];

  if (c.pathParams.length > 0) {
    // Replace each `:param` with a template-literal placeholder
    // pattern (`${...}`) — the isolation test references
    // parameterised paths exclusively via template literals (see
    // existing patterns like `/api/leagues/${orgBLeagueId}` and
    // `/api/payment-schedules/${orgBBowlerId}/${orgBLeagueId}`). A
    // straight substring check would fail on multi-param paths
    // because they'd produce `/${/${`, so we build a regex that
    // accepts any non-`}` content inside each placeholder.
    const pattern = c.effectivePath
      .split(/(:[A-Za-z_$][\w$]*)/g)
      .map((part) =>
        part.startsWith(':') ? '\\$\\{[^}]+\\}' : escapeRegex(part),
      )
      .join('');
    const re = new RegExp(pattern);
    if (!re.test(testSrc)) {
      const display = c.effectivePath.replace(
        /:[A-Za-z_$][\w$]*/g,
        '${...}',
      );
      reasons.push(`no test references ${display}`);
    }
  }

  if (c.queryIdParams.length > 0) {
    // For filtered lists, require the test to mention each id-shaped
    // query param against the same base path. Allow other query
    // params between the `?` and the target param.
    for (const q of c.queryIdParams) {
      const escapedPath = escapeRegex(c.effectivePath);
      const escapedQ = escapeRegex(q);
      const re = new RegExp(`${escapedPath}\\?[^'"\`\\s]*${escapedQ}=`);
      if (!re.test(testSrc)) {
        reasons.push(`no test references ${c.effectivePath}?${q}=...`);
      }
    }
  }

  return { covered: reasons.length === 0, missingReasons: reasons };
}

function suggestionFor(c: Candidate): string {
  if (c.kind === 'fetch-by-id' || c.kind === 'fetch-and-filter') {
    const path = c.effectivePath.replace(
      /:([A-Za-z_$][\w$]*)/g,
      (_m, name: string) => '${orgB' + name[0].toUpperCase() + name.slice(1) + '}',
    );
    return `apiGet('${path}', sessionA) should return 403/404`;
  }
  const q = c.queryIdParams[0];
  return `apiGet('${c.effectivePath}?${q}=\${orgB${q[0].toUpperCase()}${q.slice(1)}}', sessionA) should return [] or 403`;
}

function main(): void {
  if (!existsSync(TEST_FILE)) {
    console.error(
      `[check-org-isolation-coverage] FAIL — isolation test file not found: ${relative(process.cwd(), TEST_FILE)}`,
    );
    process.exit(1);
  }

  if (!existsSync(ROUTES_INDEX)) {
    console.error(
      `[check-org-isolation-coverage] FAIL — routes index not found: ${relative(process.cwd(), ROUTES_INDEX)}`,
    );
    process.exit(1);
  }

  const files = walkTs(ROUTES_DIR);
  // Also parse server/index.ts if it does any app.use mounts, but
  // for org isolation we only care about the routes tree.
  const parsed = files.map(parseFile);
  const candidates = findCandidates(parsed);
  const testSrc = readFileSync(TEST_FILE, 'utf8');

  const missing: { c: Candidate; reasons: string[] }[] = [];
  for (const c of candidates) {
    if (EXPLICIT_ALLOWLIST[c.effectivePath]) continue;
    const r = checkCoverage(testSrc, c);
    if (!r.covered) missing.push({ c, reasons: r.missingReasons });
  }

  console.log(
    `[check-org-isolation-coverage] scanned ${candidates.length} id-bearing GET endpoint(s) under server/routes/.`,
  );

  if (missing.length === 0) {
    console.log(
      '[check-org-isolation-coverage] OK — every id-bearing GET endpoint is referenced in tests/api/organization-isolation.test.ts.',
    );
    return;
  }

  const verb = STRICT ? 'FAIL' : 'WARN';
  console.error(
    `\n[check-org-isolation-coverage] ${verb} — ${missing.length} endpoint(s) appear to lack cross-org coverage:`,
  );
  for (const { c, reasons } of missing) {
    const rel = relative(process.cwd(), c.source);
    console.error(`  - GET ${c.effectivePath}  (${c.kind}, in ${rel})`);
    for (const r of reasons) {
      console.error(`      · ${r}`);
    }
    console.error(`      → suggested: ${suggestionFor(c)}`);
  }
  console.error(
    '\nAdd a cross-org assertion to tests/api/organization-isolation.test.ts,\n' +
      'or (only with security-team sign-off) add the effective path to\n' +
      'EXPLICIT_ALLOWLIST in scripts/check-org-isolation-coverage.ts with\n' +
      'an inline justification.',
  );

  if (STRICT) process.exit(1);
}

main();
