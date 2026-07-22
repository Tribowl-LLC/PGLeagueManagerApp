# Lint

This project uses ESLint to catch silent type-escape hatches. The
configuration lives in `eslint.config.js` (flat config, ESLint 9).

Five rules carry the contract — together they cover the ladder of
ways code can hide an unsafe type from the checker without leaving an
obvious `any` for a reviewer to spot:

- `@typescript-eslint/no-explicit-any` (#299) — fails on any new `any`
  annotation or `as any` cast.
- `@typescript-eslint/ban-ts-comment` (#328) — fails on any
  `@ts-ignore` or `@ts-nocheck` directive. `@ts-expect-error` is
  allowed only when followed by a description of at least 10 chars.
- `@typescript-eslint/no-non-null-assertion` (#371) — fails on any
  `value!` non-null assertion. The bang operator launders a
  `T | null | undefined` into `T` with no runtime check, so it has
  the same risk profile as `as any` for the nullability dimension.
- `@typescript-eslint/consistent-type-assertions` (#371) — fails on
  object-literal `as` casts in declaration position
  (`const x = { ... } as Foo`). Such casts silently accept extra or
  missing properties that an annotation (`const x: Foo = { ... }`)
  would catch. The call-site form `fn({ ... } as Opts)` is allowed
  via `objectLiteralTypeAssertions: 'allow-as-parameter'` because it
  is the standard pattern for inline option bags.
- `@typescript-eslint/no-unnecessary-type-assertion` (#371) — fails
  on `as` casts the type checker proves are no-ops. These usually
  mean the author was working around a stale type; keeping them
  hides future regressions when the underlying type changes.

In addition, an inline `no-restricted-syntax` matcher (also #371)
fails on the **double cast** `expr as unknown as Foo` — the canonical
way to defeat structural-compatibility errors after
`consistent-type-assertions` blocks the simpler form. The matcher
selects on the AST shape `TSAsExpression(TSAsExpression(_, unknown), Foo)`,
so it fires regardless of formatting or intervening parentheses.

The matching `noImplicitAny` half is enforced by `tsconfig.json`
(`"strict": true`), so a missing parameter or return annotation that
the checker cannot infer also fails `npm run check`.

`no-unnecessary-type-assertion` needs the type checker, so the TS/TSX
block in `eslint.config.js` enables typescript-eslint's modern
`projectService` parser option. `scripts/*.ts` files are not part of
`tsconfig.json`'s include set; they fall back to a default inferred
program via `allowDefaultProject`.

## Running

```bash
npm run lint
# or, equivalently:
npx eslint .
```

Exit code is non-zero on any new violation.

## CI integration

Lint is **enforced** in CI. The `check-and-lint` job in
`.github/workflows/ci.yml` runs `npm run check` followed by
`npm run lint` on every pull request to `main` (and on every push
to `main`); the build fails on a non-zero exit code from either
step.

The vitest suite (which includes the eslint-suppressions ratchet's
self-test in `tests/unit/check-eslint-baseline.test.ts`) runs in the
sibling `Tests` job in the same workflow. See `docs/ci.md` for the
full CI layout (which suite runs in which job, required secrets,
where to add a new check).

Concretely, lint will fail the build on any net-new violation of:

- a new `as any` cast or `: any` annotation, **or**
- a new `@ts-ignore`, `@ts-nocheck`, or undescribed `@ts-expect-error`
  directive, **or**
- a new `value!` non-null assertion, **or**
- a new object-literal-as-Foo cast in declaration position, **or**
- a new `as unknown as Foo` double cast, **or**
- a new redundant `as` cast that the checker proves is a no-op,

anywhere under `server/`, `shared/`, `client/src/`, `tests/`, or
`scripts/`.

## Wire-sanitization guard (raw User / Organization / Location / Bowler / Payment rows)

`server/utils/api.ts` exposes five allowlist-projection helpers —
`sanitizeUser`, `sanitizeOrg`, `sanitizeLocation`, `sanitizeBowler`,
and `sanitizePayment` — that are the only supported way to ship a
`User`, `Organization`, `Location`, `Bowler`, or `Payment` row to
the wire. Anything not on the allowlist (e.g. `password`,
`inviteToken`, `failedPasswordChangeAttempts`, the OAuth tokens in
`Organization.integrations`, the `squareCredentials` /
`squareCredentials` blobs on locations and payment customer identifiers
on bowlers, or any future sensitive column on `payments`) is
dropped at the boundary so a future column cannot leak just because
nobody noticed.

The protection is only as strong as the discipline at every call
site. A new route that does

```ts
sendSuccess(res, user)            // raw User row
res.json({ data: organization })  // raw Organization row
sendSuccess(res, { ...user, paymentSyncStatus })   // spread of raw User
sendSuccess(res, { recentPayments: payments })     // raw Payment[] under a wrapper key
```

silently re-introduces the leak risk that #327 (allowlist projection)
closes. Sister of the existing CSRF / org-isolation guards,
`scripts/check-wire-sanitization.ts` is a CI step that fails when a
response helper receives a value structurally assignable to the
canonical `User`, `Organization`, `Location`, `Bowler`, or `Payment`
row type.

It is type-driven, not name-driven: the script loads the same
TypeScript program `npm run check` uses, resolves the canonical
`User` / `Organization` / `Location` / `Bowler` / `Payment` types
from their declaration sites under `shared/schema/`, then asks the
type checker `isTypeAssignableTo` for every `sendSuccess`,
`sendPaginatedSuccess`, `res.json`, or `res.status(...).json` call
site under `server/`. A `Sanitized*` (`Pick<…>` projection that
drops sensitive columns) is NOT assignable to the full row, so
the canonical wraps stay green:

```ts
sendSuccess(res, sanitizeUser(user))                          // OK
sendSuccess(res, users.map(sanitizeUser))                     // OK
sendSuccess(res, { user: sanitizeUser(u), emailSent })        // OK
sendSuccess(res, { id: user.id, email: user.email })          // OK (manual projection)
```

Coverage (structural pass — task #382):

- Detects raw row leaks at the value (`sendSuccess(res, user)`),
  inside an inline object literal as a property (`{ user }` /
  `{ data: user }`), spread (`{ ...user, extra }`), or array
  element. Inline conditionals (`cond ? user : null`) are descended
  on both branches.
- Detects array-of-row leaks (`User[]` / `Organization[]`) via the
  numeric-index type so `sendSuccess(res, users)` is caught even
  though the array itself isn't assignable to `User`.
- Detects dictionary-shaped leaks (`Record<string, User>`,
  `{ [slug: string]: Organization }`, etc.) via the string-index
  type, so a future `buildUserDirectory()`-style helper that
  returns a map of raw rows can't sneak past the guard the same
  way `User[]` would have before the numeric-index descent. The
  bare Record has no enumerable named properties, so the
  property-walk below would otherwise miss it (task #532).
- Walks `User | undefined` (the typical `storage.getUser(...)`
  return shape) by descending union members.
- Walks properties of object / intersection types, so a helper
  whose return type embeds a row — e.g.
  `function buildAccountResponse(u: User): { user: User; emailSent: boolean }`
  — is flagged when its result is handed to `sendSuccess` /
  `res.json` straight, even though the wrapper itself isn't
  assignable to `User`. Recursion is bounded by a per-walk
  visited-set on type identity and a depth cap, so cyclic schema
  references like `Organization.users: User[]` referring back to
  `User.organization: Organization` terminate. Function /
  constructor types are skipped during property descent (their
  properties are `Function.prototype` methods, not data).
- Recognises the canonical helper signatures (`sendSuccess`,
  `sendPaginatedSuccess`) by identifier name and `res.json` /
  `res.status(...).json` chains by detecting that the receiver
  bottoms out at an identifier named `res`.

Coverage (deny-list pass — task #501):

The structural pass above only fires when the value is structurally
assignable to the FULL `User` / `Organization` row. A hand-rolled
projection that picks a subset of columns — including a sensitive
one — is NOT assignable to the full row (it's missing the other
required fields) and so silently passes. The deny-list pass closes
that gap by name-matching against a co-located deny-list:

```ts
sendSuccess(res, { id: u.id, password: u.password })          // FAIL — sensitive:password
sendSuccess(res, { slug: org.slug, integrations: org.integrations })  // FAIL — sensitive:integrations
sendSuccess(res, { id: u.id, token: u.password })             // FAIL — sensitive:password (initializer)
sendSuccess(res, { password })                                // FAIL — shorthand name match
res.json({ data: { id: u.id, password: u.password } })        // FAIL — nested literal walked
```

Deny-list contract:

- The sensitive column names live in `SENSITIVE_USER_FIELDS` and
  `SENSITIVE_ORG_FIELDS` in `server/utils/api.ts`, side-by-side
  with the matching `SAFE_USER_FIELDS` / `SAFE_ORG_FIELDS`
  allowlists. Two compile-time assertions in the same file pin
  the invariant that the two lists are a partition of the row's
  columns — `SAFE ∪ SENSITIVE = keyof User` (exhaustiveness, every
  column lands somewhere) AND `SAFE ∩ SENSITIVE = ∅` (disjointness,
  no column lands in both). The same pair holds for
  `Organization`. Adding a new column without classifying it, or
  accidentally classifying an existing column as both safe and
  sensitive, fails `npm run check` with a pointer to the offending
  field. The deny half cannot go stale and cannot contradict the
  allowlist.
- The script reads the two `as const` arrays directly out of
  `server/utils/api.ts` via the AST (no module import — see the
  comment in `scripts/check-wire-sanitization.ts`) so the wire
  guard tracks edits to the constants without a separate update.
- A property is flagged when EITHER its NAME is on the deny-list
  (handles `{ password: someValue }` and the shorthand
  `{ password }` form) OR its INITIALIZER reads a sensitive
  column off another value (handles `{ token: u.password }` and
  the element-access form `{ x: u['password'] }`). Value-preserving
  wrappers — parentheses, `as Foo`, `value!`, `value satisfies Foo`
  — are unwrapped before matching so a noop cast can't defeat the
  scan.
- Recursion: descends through nested object/array/conditional
  literals so `{ data: { password: u.password } }` is pinpointed
  at the inner `password` property, not the wrapper. Stops at
  call expressions, identifiers, and other opaque shapes — the
  structural pass handles those.
- The canonical wraps (`sanitizeUser(u)`, `users.map(sanitizeUser)`,
  `{ id: u.id, email: u.email }`) stay green: `sanitize*` returns
  values whose property names are all on the safe list, and a
  manual safe-fields-only projection has no deny-list names to
  match.

Not covered (deliberate parser limits):

- `.test.ts` / `.spec.ts` files and `server/utils/api.ts` itself
  (where the helpers live) are skipped.

### Conventions that keep the guard effective

The detection above is identifier-driven: it recognises the
canonical helpers by the names `sendSuccess` /
`sendPaginatedSuccess` and the Express chain by the receiver
identifier `res`. Aliasing the helpers (e.g.
`const send = sendSuccess; send(res, user)`) or renaming the
response object (e.g. `(response) => response.json(user)`) will
silently bypass the guard. To keep coverage tight, route handlers
should:

- Always call the canonical helpers under their published names
  (`sendSuccess`, `sendPaginatedSuccess`) imported from
  `server/utils/api.ts`. Don't re-export them under a new name.
- Always name the Express response parameter `res` (the codebase
  convention everywhere already).

Run with:

```bash
tsx scripts/check-wire-sanitization.ts             # strict (CI mode)
tsx scripts/check-wire-sanitization.ts --report    # print the table without exiting non-zero
```

The guard's own behavior is pinned by fixtures in
`tests/unit/check-wire-sanitization.test.ts` (run as part of the
vitest suite). Wired into CI as the `Wire sanitization (raw
User/Organization/Location/Bowler/Payment)` step in
`.github/workflows/ci.yml`'s `check-and-lint` job, alongside the
CSRF and org-isolation coverage steps.

## Existing-debt baseline

`eslint-suppressions.json` records pre-existing violations of the
escape-hatch rules so the suite can fail on net-new occurrences
without rewriting hundreds of sites at once. The baseline is
**count-based per file + rule**, not exact line-pair locks — ESLint
allows up to that many violations of *that specific rule* in each
listed file, and any net-new violation fails the lint step.

As of task #371 the baseline contains:

| Rule                                                | Baseline |
|-----------------------------------------------------|---------:|
| `@typescript-eslint/no-explicit-any`                |        0 |
| `@typescript-eslint/ban-ts-comment`                 |        0 |
| `@typescript-eslint/no-non-null-assertion`          |      232 |
| `@typescript-eslint/no-unnecessary-type-assertion`  |       89 |
| `@typescript-eslint/consistent-type-assertions`     |        4 |
| `no-restricted-syntax` (the `as unknown as` matcher)|      125 |

(Tasks #329 and #384 paid `no-explicit-any` down from 161 to 0.)

Practical implication: replacing one `!` with another in the same
file won't fail lint (count is unchanged), but adding a NEW `!` —
or a NEW `as unknown as`, object-literal cast, etc. — anywhere will.

To pay down baseline debt, fix the underlying violation and refresh
the file:

```bash
npx eslint . --suppress-all
git diff eslint-suppressions.json   # counts should only shrink
```

Then **lower the matching ceiling** in
`scripts/check-eslint-baseline.ts` (see below) so the next PR can't
silently regrow it.

Never run `--suppress-all` to mask a *new* violation — fix the type,
remove the directive, or replace the cast with a type guard / Zod
schema instead.

## Suppression-count ratchet

`scripts/check-eslint-baseline.ts` is a CI guard that compares the
live suppression counts against a per-rule ceiling and a global
total ceiling. Run advisory or strict:

```bash
tsx scripts/check-eslint-baseline.ts            # report + RATCHET hints
tsx scripts/check-eslint-baseline.ts --strict   # exit 1 on any breach
```

The strict mode is exercised by
`tests/unit/check-eslint-baseline.test.ts` so a PR that adds a new
suppression and regenerates the baseline (instead of fixing the
underlying issue) fails CI even if `npm run lint` itself stays green.

When the live count drops below a ceiling — typically because debt
was paid down — the script prints a `RATCHET:` line telling the next
contributor exactly which constant to lower in
`scripts/check-eslint-baseline.ts`. Lowering the ceiling in the same
PR locks in the win.
