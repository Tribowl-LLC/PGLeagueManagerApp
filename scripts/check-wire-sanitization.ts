/**
 * Raw-row wire-sanitization guard (task #382, deny-list extended in
 * task #501, Location/Bowler coverage added in task #505, Payment
 * coverage added in task #536).
 *
 * `server/utils/api.ts` exposes five allowlist-projection helpers —
 * `sanitizeUser`, `sanitizeOrg`, `sanitizeLocation`,
 * `sanitizeBowler`, and `sanitizePayment` (plus their `…s` array
 * variants) — that are the ONLY supported way to ship a `User`,
 * `Organization`, `Location`, `Bowler`, or `Payment` row to the
 * wire. Anything not on the allowlist is dropped at the boundary so
 * a future column (`apiKey`, `clientSecret`, `webhookKey`, OAuth
 * tokens in `integrations`, the `squareCredentials` blob on locations,
 * a future `processorWebhookSecret` /
 * `merchantApiKey` / `customerCardToken` on payments, etc.) cannot
 * leak just because nobody noticed.
 *
 * The protection is only as strong as the discipline at every call
 * site. A new route that does `sendSuccess(res, user)` (instead of
 * `sendSuccess(res, sanitizeUser(user))`) — or `res.json({ user })`
 * straight from `storage.getUser(...)` — silently re-introduces the
 * leak risk that #327 (allowlist projection) and the user-org
 * sanitize tests close.
 *
 * This script enumerates every state-returning call site under
 * `server/` and uses the real TypeScript type checker to fail when:
 *
 *   - A `sendSuccess(res, X)` or `sendPaginatedSuccess(res, X, ...)`
 *     call receives a value structurally assignable to the canonical
 *     `User`, `Organization`, `Location`, `Bowler`, or `Payment` row
 *     type — directly OR as a property, spread, or array element of
 *     an inline object/array literal.
 *
 *   - A `res.json(X)` or `res.status(...).json(X)` call receives the
 *     same shape. The receiver is detected structurally (the chain
 *     bottoms out at an identifier named `res`) so both forms are
 *     covered without per-call type plumbing.
 *
 *   - (#501) An inline object literal at any of those call sites
 *     contains a property whose NAME matches a known-sensitive
 *     User / Organization column (`password`, `inviteToken`,
 *     `inviteTokenExpiry`, `failedPasswordChangeAttempts`,
 *     `passwordChangeLockedUntil`, `integrations`) OR whose
 *     INITIALIZER reads such a column off another value (e.g.
 *     `{ id: u.id, password: u.password }` or
 *     `{ slug: org.slug, integrations: org.integrations }`). These
 *     hand-rolled projections are NOT structurally assignable to
 *     the full `User` / `Organization` row (they're missing required
 *     columns), so the structural check above is silent on them.
 *     The deny-list is sourced from the canonical
 *     `SENSITIVE_USER_FIELDS` / `SENSITIVE_ORG_FIELDS` constants in
 *     `server/utils/api.ts` (the inverse of the SAFE_*_FIELDS
 *     allowlists, with a co-located compile-time exhaustiveness
 *     check) so adding a new sensitive column updates the deny-list
 *     scanner here automatically.
 *
 * Why structural assignability and not name-matching: `User` is
 * `typeof users.$inferSelect`, which TypeScript resolves to an
 * anonymous object type at use sites — the `User` type-alias name is
 * erased and `type.aliasSymbol` is `undefined` at the call site. So
 * we resolve the canonical
 * `User`/`Organization`/`Location`/`Bowler`/`Payment` types ONCE
 * at the top of the program (via `getDeclaredTypeOfSymbol`) and use
 * `checker.isTypeAssignableTo` to ask "does this value satisfy the
 * full row shape?". A `SanitizedUser` (`Pick<User, …>` with no
 * `password`, `inviteToken`, `failedPasswordChangeAttempts`, etc.)
 * is NOT assignable to `User` and so does NOT trigger the guard.
 * The same is true for `SanitizedLocation`, `SanitizedBowler`, and
 * `SanitizedPayment` — they drop the
 * `squareCredentials` and `paymentProviderLocationId` columns
 * respectively (and, for `SanitizedPayment`, whatever future
 * sensitive payment column gets added without being added to the
 * payment safe-list), so the canonical
 * `{ ...sanitizeBowler(b), hasAccount: … }` spread used in
 * `server/routes/bowlers.ts` and `server/routes/teams.ts` produces
 * a `SanitizedBowler & { hasAccount: boolean }` type that is NOT
 * assignable to `Bowler` (missing required columns) and stays
 * green. The same goes for hand-rolled projections like
 * `{ id: u.id, email: u.email }` — they're missing required fields
 * of `User` so they're not assignable to `User`.
 *
 * Concretely, the canonical wraps stay green:
 *
 *   sendSuccess(res, sanitizeUser(user))
 *   sendSuccess(res, users.map(sanitizeUser))
 *   sendSuccess(res, { user: sanitizeUser(u), emailSent })
 *   sendSuccess(res, { id: user.id, email: user.email })
 *
 * and the leak-shaped forms are flagged:
 *
 *   sendSuccess(res, user)                            // User
 *   sendSuccess(res, users)                           // User[]
 *   sendSuccess(res, { ...user, paymentSyncStatus })  // spread of User
 *   sendSuccess(res, { user })                        // shorthand of User
 *   res.json(organization)                            // raw Organization
 *
 * Recursion contract / parser limitations:
 *   - The AST walk descends through inline `ObjectLiteralExpression`,
 *     `ArrayLiteralExpression`, `ParenthesizedExpression`, and
 *     `ConditionalExpression` (both branches). For everything else
 *     (identifier, call, property access, etc.) the value's static
 *     type is checked directly.
 *   - The type walk descends through unions (so `User | undefined`
 *     from `storage.getUser(...)` is caught), numeric-index types
 *     (so `User[]` is caught), string-index types (so
 *     `Record<string, User>` and other dictionary shapes whose only
 *     access path is the string index signature are caught — task
 *     #532), AND properties of object/intersection types — so a
 *     helper whose return type embeds a row, like
 *     `function buildAccountResponse(u: User): { user: User }`, is
 *     flagged when its result is handed to a response helper. The
 *     descent is bounded by a per-walk visited set keyed on type
 *     identity and a depth cap so cyclic schema references like
 *     `Organization.users: User[]` / `User.organization: Organization`
 *     terminate. Function/constructor types (whose properties are
 *     `Function.prototype` methods, not data) are skipped to avoid
 *     walking into the standard library.
 *   - `User` / `Organization` / `Location` / `Bowler` / `Payment`
 *     are identified by their declaration site: a type alias named
 *     `User` declared in `shared/schema/users.ts`, `Organization` in
 *     `shared/schema/organizations.ts`, `Location` in
 *     `shared/schema/locations.ts`, `Bowler` in
 *     `shared/schema/bowlers.ts`, and `Payment` in
 *     `shared/schema/payments.ts`. Re-exports through
 *     `shared/schema/index.ts` resolve to the same canonical
 *     declarations, so import path doesn't matter.
 *
 * The guard runs over the same TypeScript program `npm run check`
 * uses, so it sees exactly the inferred types the type checker sees.
 *
 * Exits 0 when clean, 1 on any unallowlisted leak. Pass `--report`
 * to print the table without exiting non-zero (useful locally when
 * paying down debt before raising the gate).
 *
 * Run with: `npm run check:wire-sanitization` or
 * `tsx scripts/check-wire-sanitization.ts`.
 */
import * as ts from 'typescript';
import { resolve, relative } from 'node:path';

const ROOT = process.cwd();
const TSCONFIG_PATH = resolve(ROOT, 'tsconfig.json');
const REPORT_ONLY = process.argv.includes('--report');

interface Violation {
  file: string;
  line: number;
  column: number;
  helper: string;
  typeName: string;
  snippet: string;
}

function loadProgram(): ts.Program {
  const cfg = ts.readConfigFile(TSCONFIG_PATH, ts.sys.readFile);
  if (cfg.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(cfg.error.messageText, '\n'),
    );
  }
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, ROOT);
  // `noEmit` is set in tsconfig.json — the program is read-only.
  return ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
  });
}

interface CanonicalTypes {
  user: ts.Type;
  organization: ts.Type;
  location: ts.Type;
  bowler: ts.Type;
  payment: ts.Type;
}

/**
 * Declaration-site lookup table: each canonical row type is
 * identified by the BASENAME of its declaring file plus the type-
 * alias name. Adding a new sanitized row type means appending one
 * entry here and one field to `CanonicalTypes` above — the rest of
 * the script (resolution, leak walk, error message) reads off these
 * tables.
 */
const CANONICAL_TYPE_SOURCES: ReadonlyArray<{
  key: keyof CanonicalTypes;
  fileSuffix: string;
  aliasName: string;
}> = [
  { key: 'user', fileSuffix: '/shared/schema/users.ts', aliasName: 'User' },
  { key: 'organization', fileSuffix: '/shared/schema/organizations.ts', aliasName: 'Organization' },
  { key: 'location', fileSuffix: '/shared/schema/locations.ts', aliasName: 'Location' },
  { key: 'bowler', fileSuffix: '/shared/schema/bowlers.ts', aliasName: 'Bowler' },
  { key: 'payment', fileSuffix: '/shared/schema/payments.ts', aliasName: 'Payment' },
];

/**
 * Symbols of the canonical `Sanitized*` type aliases declared in
 * `server/utils/api.ts`. Used by `findLeakInType` to exempt values
 * whose type aliases back to one of these projections — needed for
 * the `Payment` row specifically.
 *
 * Background: every other row type (`User`, `Organization`,
 * `Location`, `Bowler`) has at least one column that is intentionally
 * NOT on the SAFE_*_FIELDS allowlist (`password`, `integrations`,
 * `squareCredentials`, `paymentProviderLocationId`). That makes
 * the corresponding `Sanitized*` `Pick<…>` type a STRICT subset of
 * the row, so `isTypeAssignableTo(SanitizedUser, User)` returns
 * `false` (missing required columns) and the canonical wraps stay
 * green via pure structure.
 *
 * `Payment` is the exception today: SAFE_PAYMENT_FIELDS lists every
 * current `payments` column (the only sensitive-looking one —
 * `idempotencyKey` — is operational and
 * intentionally on the allowlist; see the comment in
 * `server/utils/api.ts`). So `SanitizedPayment ≡ Payment`
 * structurally, and the assignability check below would falsely
 * flag every `sanitizePayment(...)` / `sanitizePayments(...)`
 * call site. The deny-by-default value is still real — the moment
 * a future column (`processorWebhookSecret`, `merchantApiKey`,
 * `customerCardToken`, …) lands without being added to
 * SAFE_PAYMENT_FIELDS, `SanitizedPayment` will diverge from
 * `Payment` and the structural check will start working unaided.
 *
 * Until then, this exemption table closes the gap: any value whose
 * type's `aliasSymbol` is one of the resolved `Sanitized*` aliases
 * is treated as already-sanitized and skipped. Recursion preserves
 * the property — `SanitizedPayment[]` descends to its element type,
 * which still carries the `aliasSymbol`. Inline shapes that
 * intersect a sanitized type with extra fields (e.g.
 * `{ ...sanitizePayment(p), foo }`) lose the alias; those would
 * still flag, but no real call site uses that pattern for Payment
 * today and the test fixtures use a strict-subset `SanitizedPayment`
 * so the structural pass exercises the same code path as the other
 * row types.
 */
interface CanonicalSanitizedSymbols {
  user: ts.Symbol | null;
  organization: ts.Symbol | null;
  location: ts.Symbol | null;
  bowler: ts.Symbol | null;
  payment: ts.Symbol | null;
}

const CANONICAL_SANITIZED_ALIAS_NAMES = new Set<string>([
  'SanitizedUser',
  'SanitizedOrganization',
  'SanitizedOrg',
  'SanitizedLocation',
  'SanitizedBowler',
  'SanitizedPayment',
]);

function resolveSanitizedSymbols(
  program: ts.Program,
  checker: ts.TypeChecker,
): CanonicalSanitizedSymbols {
  const out: CanonicalSanitizedSymbols = {
    user: null,
    organization: null,
    location: null,
    bowler: null,
    payment: null,
  };
  for (const sf of program.getSourceFiles()) {
    const fn = sf.fileName.replace(/\\/g, '/');
    if (!fn.endsWith('/server/utils/api.ts')) continue;

    sf.forEachChild((n) => {
      if (!ts.isTypeAliasDeclaration(n)) return;
      if (!CANONICAL_SANITIZED_ALIAS_NAMES.has(n.name.text)) return;
      const sym = checker.getSymbolAtLocation(n.name);
      if (!sym) return;
      switch (n.name.text) {
        case 'SanitizedUser': out.user = sym; break;
        case 'SanitizedOrganization':
        case 'SanitizedOrg': out.organization = sym; break;
        case 'SanitizedLocation': out.location = sym; break;
        case 'SanitizedBowler': out.bowler = sym; break;
        case 'SanitizedPayment': out.payment = sym; break;
      }
    });
  }
  return out;
}

interface SensitiveFieldLists {
  /** Sensitive User columns — every property/initializer name on
   * this list at a response-helper call site is a leak (#501). */
  user: Set<string>;
  /** Sensitive Organization columns — same contract. */
  organization: Set<string>;
  /** Union of both, used as the actual matching set since name
   * collisions across the two tables would still be a leak. */
  combined: Set<string>;
}

/**
 * Locate the `User`, `Organization`, `Location`, `Bowler`, and
 * `Payment` type aliases at their declaration sites under
 * `shared/schema/` and resolve each to its declared type. The declared type is what
 * `isTypeAssignableTo` compares against — and because Drizzle's
 * `$inferSelect` produces an anonymous object type, asking the
 * checker for the alias's `getDeclaredTypeOfSymbol` is what gives us
 * the canonical row shape we need to compare every call-site value
 * against.
 *
 * Driven by `CANONICAL_TYPE_SOURCES` so adding a new sanitized row
 * type doesn't require editing the resolver itself — append an entry
 * there and the loop here picks it up.
 */
function resolveCanonicalTypes(
  program: ts.Program,
  checker: ts.TypeChecker,
): CanonicalTypes | null {
  const found: Partial<Record<keyof CanonicalTypes, ts.Type>> = {};

  for (const sf of program.getSourceFiles()) {
    const fn = sf.fileName.replace(/\\/g, '/');
    const matches = CANONICAL_TYPE_SOURCES.filter((s) =>
      fn.endsWith(s.fileSuffix),
    );
    if (matches.length === 0) continue;

    sf.forEachChild((n) => {
      if (!ts.isTypeAliasDeclaration(n)) return;
      const sym = checker.getSymbolAtLocation(n.name);
      if (!sym) return;
      for (const m of matches) {
        if (n.name.text === m.aliasName) {
          found[m.key] = checker.getDeclaredTypeOfSymbol(sym);
        }
      }
    });
  }

  for (const s of CANONICAL_TYPE_SOURCES) {
    if (!found[s.key]) return null;
  }
  return found as CanonicalTypes;
}

/**
 * Locate `SENSITIVE_USER_FIELDS` and `SENSITIVE_ORG_FIELDS` in
 * `server/utils/api.ts` and extract their array-of-string-literal
 * initializers. The deny-list lives next to the SAFE_*_FIELDS
 * allowlists in the same file (with a co-located compile-time
 * exhaustiveness check) so adding a new sensitive column updates
 * both halves at once.
 *
 * We parse the AST rather than `import()`-ing the module so the
 * script stays a static analysis pass — `server/utils/api.ts`
 * pulls in `express` and the shared schema, and importing it would
 * load half the runtime just to read two constants. The synthetic
 * fixtures in `tests/unit/check-wire-sanitization.test.ts` write
 * the same two `as const` arrays into their stub api.ts, so the
 * test paths and the real code path walk the same shape.
 */
function resolveSensitiveFieldLists(
  program: ts.Program,
): SensitiveFieldLists | null {
  let user: Set<string> | undefined;
  let organization: Set<string> | undefined;

  for (const sf of program.getSourceFiles()) {
    const fn = sf.fileName.replace(/\\/g, '/');
    if (!fn.endsWith('/server/utils/api.ts')) continue;

    sf.forEachChild((n) => {
      if (!ts.isVariableStatement(n)) return;
      for (const decl of n.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const name = decl.name.text;
        const wantUser = name === 'SENSITIVE_USER_FIELDS';
        const wantOrg = name === 'SENSITIVE_ORG_FIELDS';
        if (!wantUser && !wantOrg) continue;

        // The canonical shape is `[...] as const`. Strip the outer
        // `as const` (if present) to get at the array literal.
        let init = decl.initializer;
        if (init && ts.isAsExpression(init)) {
          init = init.expression;
        }
        if (!init || !ts.isArrayLiteralExpression(init)) continue;

        const fields = new Set<string>();
        for (const el of init.elements) {
          if (ts.isStringLiteral(el) || ts.isNoSubstitutionTemplateLiteral(el)) {
            fields.add(el.text);
          }
        }
        if (wantUser) user = fields;
        else organization = fields;
      }
    });
  }

  if (!user || !organization) return null;
  const combined = new Set<string>([...user, ...organization]);
  return { user, organization, combined };
}

/**
 * Walk a value type and return the name of the first leak it
 * contains, or null. Descends through:
 *   - union members (so `User | undefined` is caught),
 *   - numeric-index types (so `User[]` is caught),
 *   - string-index types (so `Record<string, User>` and other
 *     dictionary shapes whose only access path is the string index
 *     signature are caught — task #532), and
 *   - properties of object / intersection types (so a helper whose
 *     return type embeds a row, e.g. `function f(): { user: User }`,
 *     is caught when its result is handed to a response helper).
 *
 * The structural assignability check at the top of the walk handles
 * the direct cases (raw `User`, intersection `User & { extra }`,
 * etc.). Recursion is bounded by a per-walk `visited` set keyed on
 * type identity AND a hard depth cap, so cyclic schema references
 * — e.g. `Organization.users: User[]` referring back to `User` which
 * has `organization: Organization` — terminate.
 *
 * Function / constructor types are skipped during the property
 * descent because their `getProperties()` returns
 * `Function.prototype` methods (`call`, `apply`, …) rather than
 * data fields, and recursing into those would balloon the search
 * with no signal.
 */
const MAX_TYPE_WALK_DEPTH = 8;

function findLeakInType(
  type: ts.Type,
  canon: CanonicalTypes,
  sanitized: CanonicalSanitizedSymbols,
  checker: ts.TypeChecker,
  visited: Set<ts.Type> = new Set<ts.Type>(),
  depth = 0,
): string | null {
  if (depth > MAX_TYPE_WALK_DEPTH) return null;
  if (visited.has(type)) return null;
  visited.add(type);

  // Skip non-actionable bottoms — `any` would assignable-to anything,
  // which would generate noise. `unknown`/`never` aren't structural
  // matches in either direction.
  const flags = type.flags;
  if (
    flags & ts.TypeFlags.Any ||
    flags & ts.TypeFlags.Unknown ||
    flags & ts.TypeFlags.Never ||
    flags & ts.TypeFlags.Void ||
    flags & ts.TypeFlags.Null ||
    flags & ts.TypeFlags.Undefined
  ) {
    return null;
  }

  // Exempt values whose type aliases back to one of the canonical
  // `Sanitized*` projections in `server/utils/api.ts`. See the
  // doc-comment on `CanonicalSanitizedSymbols` above — this is the
  // mechanism that lets the structural pass tell raw `Payment`
  // apart from `SanitizedPayment` even when SAFE_PAYMENT_FIELDS
  // covers every current Payment column (the
  // `sanitizePayment(...)` / `sanitizePayments(...)` returns then
  // carry an `aliasSymbol` of `SanitizedPayment` which the row
  // assignability check would otherwise flag as a Payment leak).
  // Cheap no-op for the other rows (their structural subset
  // relation already keeps them clear) so we apply it uniformly.
  if (type.aliasSymbol) {
    if (
      type.aliasSymbol === sanitized.user ||
      type.aliasSymbol === sanitized.organization ||
      type.aliasSymbol === sanitized.location ||
      type.aliasSymbol === sanitized.bowler ||
      type.aliasSymbol === sanitized.payment
    ) {
      return null;
    }
  }

  if (checker.isTypeAssignableTo(type, canon.user)) return 'User';
  if (checker.isTypeAssignableTo(type, canon.organization)) return 'Organization';
  if (checker.isTypeAssignableTo(type, canon.location)) return 'Location';
  if (checker.isTypeAssignableTo(type, canon.bowler)) return 'Bowler';
  if (checker.isTypeAssignableTo(type, canon.payment)) return 'Payment';

  if (type.isUnion()) {
    for (const sub of type.types) {
      const v = findLeakInType(sub, canon, sanitized, checker, visited, depth + 1);
      if (v) return v;
    }
    return null;
  }

  // Arrays / readonly arrays / tuples — descend through the element
  // type so `User[]` (the most common batch-list shape) is caught.
  const numIdx = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  if (numIdx) {
    const v = findLeakInType(numIdx, canon, sanitized, checker, visited, depth + 1);
    if (v) return `${v}[]`;
  }

  // Record / dictionary shapes — descend through the string-index
  // value type so `Record<string, User>` (or anything with only a
  // string index signature like `{ [orgSlug: string]: Organization }`)
  // is caught. The bare object has no enumerable named properties,
  // so the property descent below does NOT see this — without this
  // step a future `buildUserDirectory(): Record<string, User>` would
  // sneak past the guard the same way `User[]` would have before
  // the numeric-index descent above was added.
  //
  // Bound by the same visited-set + depth cap that protects the
  // numeric-index and property descents, so a recursive Record type
  // (e.g. `type Tree = Record<string, Tree>`) terminates instead of
  // looping. Task #532.
  const strIdx = checker.getIndexTypeOfType(type, ts.IndexKind.String);
  if (strIdx) {
    const v = findLeakInType(strIdx, canon, sanitized, checker, visited, depth + 1);
    if (v) return v;
  }

  // Walk properties of object / intersection types so a value typed
  // as `{ user: User }` returned from a helper doesn't slip past by
  // hiding the User behind a wrapper. Skip callable/constructable
  // types (their "properties" are Function.prototype methods, not
  // data); the visited-set + depth cap above keep cyclic schemas
  // from blowing up.
  const isObjectLike =
    Boolean(flags & ts.TypeFlags.Object) || type.isIntersection();
  if (isObjectLike) {
    if (
      type.getCallSignatures().length === 0 &&
      type.getConstructSignatures().length === 0
    ) {
      for (const prop of type.getProperties()) {
        const decl = prop.valueDeclaration ?? prop.declarations?.[0];
        if (!decl) continue;
        const propType = checker.getTypeOfSymbolAtLocation(prop, decl);
        const v = findLeakInType(propType, canon, sanitized, checker, visited, depth + 1);
        if (v) return v;
      }
    }
  }

  return null;
}

interface Reporter {
  (node: ts.Node, typeName: string): void;
}

/**
 * Strip transparent value-preserving wrappers from an expression
 * before pattern-matching its shape. `(u.password)`,
 * `u.password as string`, `u.password!`, and
 * `u.password satisfies string` all read the same column at the
 * same source location, so the deny-list scanner has to see through
 * them — otherwise an author can defeat the check by adding a cast.
 *
 * Does NOT descend through call expressions, conditionals, or
 * binary operators — those are deliberately left to the caller's
 * own recursion contract (e.g. conditional branches are walked
 * separately by `checkSensitiveLiteralProps`).
 */
function unwrap(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (true) {
    if (ts.isParenthesizedExpression(cur)) { cur = cur.expression; continue; }
    if (ts.isAsExpression(cur)) { cur = cur.expression; continue; }
    if (ts.isTypeAssertionExpression(cur)) { cur = cur.expression; continue; }
    if (ts.isSatisfiesExpression(cur)) { cur = cur.expression; continue; }
    if (ts.isNonNullExpression(cur)) { cur = cur.expression; continue; }
    return cur;
  }
}

/**
 * Read the property name of a literal-key property assignment as a
 * plain string. Numeric and dynamic-computed keys (other than a
 * computed string literal) return null — those can't shadow a
 * column name in a way the deny-list cares about.
 */
function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const inner = unwrap(name.expression);
    if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return inner.text;
  }
  return null;
}

/**
 * If `expr` reads a known-sensitive column off some other value
 * (e.g. `u.password`, `org.integrations`, `u['password']`), return
 * the column name. Otherwise null. The check is purely name-based —
 * we don't try to prove the receiver is actually a User/Organization,
 * because the deny-list is short and intentional and the sensitive
 * names ('password', 'inviteToken', …) don't have legitimate
 * non-column uses inside response payloads.
 */
function readSensitiveAccess(
  expr: ts.Expression,
  sensitive: Set<string>,
): string | null {
  const inner = unwrap(expr);
  if (ts.isPropertyAccessExpression(inner) && sensitive.has(inner.name.text)) {
    return inner.name.text;
  }
  if (ts.isElementAccessExpression(inner)) {
    const arg = unwrap(inner.argumentExpression);
    if ((ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) && sensitive.has(arg.text)) {
      return arg.text;
    }
  }
  return null;
}

/**
 * The deny-list pass (#501): walk an inline value expression and
 * report any property whose NAME matches a sensitive column or
 * whose INITIALIZER directly reads a sensitive column off another
 * value. Recurses through inline literals (object, array,
 * conditional, parens / casts) so a nested wrapper like
 * `{ data: { id: u.id, password: u.password } }` is still pinpointed
 * at the inner `password` property — but stops at calls, identifiers,
 * binary expressions, and other opaque shapes (those are the
 * structural-assignability pass's job).
 *
 * Independent of the assignability walk so the two reporters can
 * fire on the same call site without confusing each other's
 * provenance. Both walks are bounded by the AST itself (no cycles
 * possible at the value level).
 */
function checkSensitiveLiteralProps(
  expr: ts.Expression,
  sensitive: Set<string>,
  report: Reporter,
): void {
  const inner = unwrap(expr);

  if (ts.isObjectLiteralExpression(inner)) {
    for (const prop of inner.properties) {
      if (ts.isPropertyAssignment(prop)) {
        const nm = propertyNameText(prop.name);
        if (nm && sensitive.has(nm)) {
          report(prop, `sensitive:${nm}`);
        }
        const initRead = readSensitiveAccess(prop.initializer, sensitive);
        if (initRead && initRead !== nm) {
          // Avoid double-reporting the canonical
          // `password: u.password` shape (the property NAME match
          // already fired above) — only flag when the initializer
          // smuggles a sensitive read past a safe-looking property
          // name (e.g. `token: u.password`).
          report(prop, `sensitive:${initRead}`);
        }
        // Recurse so nested literals are also walked.
        checkSensitiveLiteralProps(prop.initializer, sensitive, report);
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        if (sensitive.has(prop.name.text)) {
          report(prop, `sensitive:${prop.name.text}`);
        }
      } else if (ts.isSpreadAssignment(prop)) {
        // `{ ...someObj }` — name-matching doesn't apply directly,
        // but the spread source might itself be an inline literal
        // we want to descend into.
        checkSensitiveLiteralProps(prop.expression, sensitive, report);
      }
      // Method/get/set declarations on an object literal can't
      // express a sensitive value as data — skip.
    }
    return;
  }

  if (ts.isArrayLiteralExpression(inner)) {
    for (const el of inner.elements) {
      if (ts.isSpreadElement(el)) {
        checkSensitiveLiteralProps(el.expression, sensitive, report);
      } else {
        checkSensitiveLiteralProps(el, sensitive, report);
      }
    }
    return;
  }

  if (ts.isConditionalExpression(inner)) {
    checkSensitiveLiteralProps(inner.whenTrue, sensitive, report);
    checkSensitiveLiteralProps(inner.whenFalse, sensitive, report);
    return;
  }
  // Anything else is opaque to the deny-list pass — the structural
  // assignability walk handles those.
}

/**
 * Walk a value expression. Inline object/array/conditional literals
 * are descended structurally so the guard can pinpoint the offending
 * property (e.g. `{ user }` reports the shorthand, not the whole
 * object literal). For anything else we just type-check the value.
 */
function walkExpression(
  expr: ts.Expression,
  checker: ts.TypeChecker,
  canon: CanonicalTypes,
  sanitized: CanonicalSanitizedSymbols,
  report: Reporter,
): void {
  if (ts.isParenthesizedExpression(expr)) {
    walkExpression(expr.expression, checker, canon, sanitized, report);
    return;
  }
  if (ts.isObjectLiteralExpression(expr)) {
    for (const prop of expr.properties) {
      if (ts.isPropertyAssignment(prop)) {
        walkExpression(prop.initializer, checker, canon, sanitized, report);
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        const t = checker.getTypeAtLocation(prop.name);
        const found = findLeakInType(t, canon, sanitized, checker);
        if (found) report(prop, found);
      } else if (ts.isSpreadAssignment(prop)) {
        const t = checker.getTypeAtLocation(prop.expression);
        const found = findLeakInType(t, canon, sanitized, checker);
        if (found) report(prop, found);
      }
      // Method/Get/Set declarations on an object literal can't
      // express a User/Organization value as data, so ignore them.
    }
    return;
  }
  if (ts.isArrayLiteralExpression(expr)) {
    for (const el of expr.elements) {
      if (ts.isSpreadElement(el)) {
        const t = checker.getTypeAtLocation(el.expression);
        const found = findLeakInType(t, canon, sanitized, checker);
        if (found) report(el, found);
      } else {
        walkExpression(el, checker, canon, sanitized, report);
      }
    }
    return;
  }
  if (ts.isConditionalExpression(expr)) {
    walkExpression(expr.whenTrue, checker, canon, sanitized, report);
    walkExpression(expr.whenFalse, checker, canon, sanitized, report);
    return;
  }
  // Default: get the static type and check.
  const t = checker.getTypeAtLocation(expr);
  const found = findLeakInType(t, canon, sanitized, checker);
  if (found) report(expr, found);
}

interface HelperHit {
  helper: string;
  dataArg: ts.Expression;
}

function isResponseHelperCall(call: ts.CallExpression): HelperHit | null {
  // sendSuccess(res, data, status?)
  // sendPaginatedSuccess(res, data, pagination, status?)
  if (ts.isIdentifier(call.expression)) {
    const name = call.expression.text;
    if (
      (name === 'sendSuccess' || name === 'sendPaginatedSuccess') &&
      call.arguments.length >= 2
    ) {
      return { helper: name, dataArg: call.arguments[1] };
    }
  }
  // res.json(data)  /  res.status(...).json(data)  /  any chain
  // bottoming out at an identifier named `res`.
  if (
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === 'json' &&
    call.arguments.length >= 1 &&
    receiverIsRes(call.expression.expression)
  ) {
    return { helper: 'res.json', dataArg: call.arguments[0] };
  }
  return null;
}

function receiverIsRes(expr: ts.Expression): boolean {
  if (ts.isIdentifier(expr)) return expr.text === 'res';
  if (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression)
  ) {
    return receiverIsRes(expr.expression.expression);
  }
  if (ts.isPropertyAccessExpression(expr)) {
    return receiverIsRes(expr.expression);
  }
  if (ts.isParenthesizedExpression(expr)) {
    return receiverIsRes(expr.expression);
  }
  return false;
}

function shouldScan(fileName: string): boolean {
  const f = fileName.replace(/\\/g, '/');
  if (!f.includes('/server/')) return false;
  if (f.includes('/node_modules/')) return false;
  if (f.includes('/__tests__/')) return false;
  if (f.endsWith('.test.ts') || f.endsWith('.spec.ts')) return false;
  // The sanitize* helpers and `sendSuccess` itself live here; the
  // file's own bodies don't ship raw User/Org and scanning would
  // create false positives on the helper signatures.
  if (f.endsWith('/server/utils/api.ts')) return false;
  return true;
}

function snippetAt(sf: ts.SourceFile, node: ts.Node): string {
  const text = sf.getFullText();
  const start = node.getStart(sf);
  const end = node.getEnd();
  const slice = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return slice.length > 100 ? `${slice.slice(0, 97)}...` : slice;
}

function main(): void {
  const program = loadProgram();
  const checker = program.getTypeChecker();

  const canon = resolveCanonicalTypes(program, checker);
  if (!canon) {
    // Sanity bottom: if we can't find the canonical types the script
    // would silently pass — fail loud instead.
    console.error(
      '[check-wire-sanitization] FAIL — could not resolve User / Organization / Location / Bowler / Payment type aliases from shared/schema/{users,organizations,locations,bowlers,payments}.ts. ' +
        'Refusing to run rather than silently passing.',
    );
    process.exit(2);
  }

  // Best-effort: resolves to all-null on a setup that doesn't expose
  // the canonical Sanitized* aliases (in which case the alias-symbol
  // exemption is a no-op and the structural pass behaves exactly as
  // before — only the Payment row is currently affected by the
  // exemption, see CanonicalSanitizedSymbols above).
  const sanitized = resolveSanitizedSymbols(program, checker);

  const sensitive = resolveSensitiveFieldLists(program);
  if (!sensitive) {
    // Same loud-fail as for the canonical types: missing the deny-
    // list constants would silently disable the #501 half of the
    // guard.
    console.error(
      '[check-wire-sanitization] FAIL — could not resolve SENSITIVE_USER_FIELDS / SENSITIVE_ORG_FIELDS from server/utils/api.ts. ' +
        'Both must be `as const` arrays of string literals. Refusing to run rather than silently passing.',
    );
    process.exit(2);
  }

  const violations: Violation[] = [];

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    if (!shouldScan(sf.fileName)) continue;

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const m = isResponseHelperCall(node);
        if (m) {
          const record = (badNode: ts.Node, typeName: string) => {
            const { line, character } = sf.getLineAndCharacterOfPosition(
              badNode.getStart(sf),
            );
            violations.push({
              file: relative(ROOT, sf.fileName),
              line: line + 1,
              column: character + 1,
              helper: m.helper,
              typeName,
              snippet: snippetAt(sf, badNode),
            });
          };
          // Pass 1 (#382): structural assignability — catches raw
          // rows, spreads, shorthands, and helpers whose return type
          // embeds a User/Organization.
          walkExpression(m.dataArg, checker, canon, sanitized, record);
          // Pass 2 (#501): name-based deny-list — catches hand-rolled
          // projections that pick a SUBSET including a sensitive
          // column (e.g. `{ id: u.id, password: u.password }`).
          // Independent from the structural pass; both can fire on
          // the same call site without collision.
          checkSensitiveLiteralProps(m.dataArg, sensitive.combined, record);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  if (violations.length === 0) {
    console.log(
      '[check-wire-sanitization] OK — no raw User/Organization/Location/Bowler/Payment values or sensitive field leaks reach a response helper.',
    );
    return;
  }

  console.error(
    `\n[check-wire-sanitization] ${REPORT_ONLY ? 'REPORT' : 'FAIL'} — ${violations.length} call site(s) leak User/Organization/Location/Bowler/Payment data to the wire (raw rows or deny-listed sensitive fields):\n`,
  );
  for (const v of violations) {
    console.error(
      `  ${v.file}:${v.line}:${v.column}  ${v.helper}() <- ${v.typeName}`,
    );
    console.error(`      · ${v.snippet}`);
  }
  console.error(
    '\nFor `<- <TypeName>` violations: wrap the value in the matching\n' +
      'sanitize helper (sanitizeUser / sanitizeOrg / sanitizeLocation /\n' +
      'sanitizeBowler / sanitizePayment, or the `…s` array variants) from\n' +
      'server/utils/api.ts before handing it to the response helper.\n' +
      'For `<- sensitive:<field>` violations: drop the sensitive field from the\n' +
      'projection or rebuild the payload via sanitizeUser / sanitizeOrg.\n' +
      'See docs/lint.md for the contract.',
  );

  if (!REPORT_ONLY) process.exit(1);
}

main();
