import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tanstackQuery from '@tanstack/eslint-plugin-query';
import leaguevault from './tools/eslint-plugin-leaguevault/index.js';
import factoryMustUseSchema from './eslint-rules/factory-must-use-schema.js';

// Lint config for tasks #299, #328, and #371: catch silent type-escape
// hatches.
//
// Five rules carry this config:
//   * `@typescript-eslint/no-explicit-any` (#299) — fails on any new
//     `any` annotation or `as any` cast.
//   * `@typescript-eslint/ban-ts-comment` (#328) — fails on any
//     `@ts-ignore`, `@ts-nocheck`, or undescribed `@ts-expect-error`
//     directive. These silently disable the type checker for a line
//     or whole file and have the same risk profile as `any`.
//     `@ts-expect-error` is allowed only when accompanied by a
//     description of at least 10 chars so the next reader knows why.
//   * `@typescript-eslint/no-non-null-assertion` (#371) — fails on
//     any `value!` non-null assertion. The bang operator launders a
//     `T | undefined | null` into `T` with zero runtime check, so it
//     is functionally equivalent to an `as` cast for the nullability
//     dimension and belongs on the same ladder as `any`.
//   * `@typescript-eslint/consistent-type-assertions` (#371) — bans
//     object-literal `as` casts (`{ foo: 1 } as Foo`), which silently
//     accept extra/missing properties that a real annotation would
//     reject. Combined with `no-restricted-syntax` below, this also
//     blocks the "double cast" `as unknown as Foo` escape hatch
//     people use to defeat structural-compatibility errors.
//   * `@typescript-eslint/no-unnecessary-type-assertion` (#371) —
//     fails on redundant `as` casts that the checker proves are
//     no-ops. These usually mean the author was working around a
//     stale type that has since been fixed; keeping them around
//     hides future regressions when the underlying type narrows
//     differently.
//
// The matching `noImplicitAny` half of the contract is enforced by
// `tsconfig.json` (`"strict": true`).
//
// `no-unnecessary-type-assertion` is type-aware (it asks the checker
// whether an assertion would be a no-op), so the TS/TSX block below
// turns on `parserOptions.projectService` to give typescript-eslint a
// live program. The non-typed JS rules and the other escape-hatch
// rules above do not need the program.
//
// We use ESLint 9's `--suppress-all` baseline
// (`eslint-suppressions.json`) to acknowledge existing debt without
// churning hundreds of sites at once. The baseline is COUNT-based
// per file/rule, not line-pair locked, so any NET-NEW occurrence of
// `any`, a banned directive, a `!` assertion, an object-literal cast,
// an `as unknown as Foo` double cast, or an unnecessary cast fails
// the lint step. See docs/lint.md.
//
// We also opt out of typescript-eslint's recommended set so we don't
// silently turn on a hundred unrelated rules under this task's scope.
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'build/**',
      'node_modules/**',
      'android/**',
      'ios/**',
      'attached_assets/**',
      '**/*.config.{js,ts,mjs,cjs}',
      'drizzle/**',
      '.local/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
        // Enable type-aware linting via the modern Project Service.
        // `no-unnecessary-type-assertion` (#371) needs the checker to
        // decide whether an `as` is a no-op; the other escape-hatch
        // rules in this block don't need it but pay no extra cost
        // once the program is loaded.
        //
        // `scripts/**/*` is now part of `tsconfig.json`'s `include`
        // set so the project service can resolve them — without that,
        // tasks #432 and #499 (which started importing
        // `scripts/check-no-secrets-in-logs.ts` and
        // `scripts/verify-trust-proxy-deploy.ts` from test files
        // under `tests/`) caused typescript-eslint to refuse to lint
        // those scripts ("was included by allowDefaultProject but
        // also was found in the project service"). The default
        // project service is now sufficient for every TS file in the
        // repo.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      // Type-escape hatch rules (#299, #328).
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-ignore': true,
          'ts-nocheck': true,
          // `@ts-expect-error` is a defensible escape hatch in tests
          // and the occasional library-shim — but only when the
          // author has documented WHY. The matching `noImplicitAny`
          // half of the contract is enforced by tsconfig `strict`.
          'ts-expect-error': 'allow-with-description',
          'ts-check': false,
          minimumDescriptionLength: 10,
        },
      ],

      // Type-escape hatch rules (#371).
      //
      // `value!` non-null assertions launder a `T | null | undefined`
      // into `T` with no runtime check. Same risk profile as `as` —
      // ban net-new occurrences, baseline existing ones.
      '@typescript-eslint/no-non-null-assertion': 'error',
      // `{ ... } as Foo` silently accepts extra/missing properties
      // that an annotation would catch. Keep `as` as the assertion
      // style (we already use it everywhere) but forbid the object-
      // literal form. `allow-as-parameter` keeps the common
      // `fn({ ... } as Opts)` call-site pattern working without a
      // separate variable; the goal is to stop *declarations* from
      // hiding shape mistakes behind a cast.
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        {
          assertionStyle: 'as',
          objectLiteralTypeAssertions: 'allow-as-parameter',
        },
      ],
      // Type-aware. Catches casts the checker proves are redundant —
      // usually leftovers from a type that has since been fixed.
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      // The "double cast" `expr as unknown as Foo`. There is no
      // dedicated rule for this in typescript-eslint, so we match
      // the AST directly: an outer `as` whose operand is itself an
      // `as` to `unknown`. This is the canonical way people defeat
      // structural-compatibility errors after `consistent-type-
      // assertions` blocks the simpler form, and the whole point of
      // task #371 is to close that rung of the ladder too.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "TSAsExpression[expression.type='TSAsExpression'][expression.typeAnnotation.type='TSUnknownKeyword']",
          message:
            "'as unknown as Foo' double-casts launder an incompatible type past the checker. " +
            'Narrow the value with a type guard, fix the source type, or — if the value really is opaque — ' +
            'parse it through a Zod schema and use the inferred type.',
        },
      ],

      // Mute base rules that are unsafe / noisy on TypeScript code so the
      // lint output is dominated by `no-explicit-any` violations only.
      'no-unused-vars': 'off',
      'no-undef': 'off',
      'no-empty': 'off',
      'no-useless-escape': 'off',
      'no-constant-condition': 'off',
      'no-cond-assign': 'off',
      'no-control-regex': 'off',
      'no-prototype-builtins': 'off',
      'no-case-declarations': 'off',
      'no-async-promise-executor': 'off',
      'no-misleading-character-class': 'off',
      'no-fallthrough': 'off',
      'no-self-assign': 'off',
      'no-redeclare': 'off',
      'no-inner-declarations': 'off',
      'no-irregular-whitespace': 'off',
      'no-useless-catch': 'off',
      'getter-return': 'off',
      'no-empty-pattern': 'off',
    },
  },
  // Local custom rules (#695). These three rules codify recurring
  // test-shape footguns that have each cost multiple tasks to clean
  // up. They are scoped to test files only — production code is
  // intentionally out of scope.
  {
    files: ['tests/**/*.{ts,tsx}'],
    plugins: { leaguevault },
    rules: {
      'leaguevault/no-it-skip-placeholder': 'error',
      'leaguevault/no-unscoped-table-query-in-test-assertion': 'error',
      'leaguevault/no-spawn-tsx-in-test': 'error',
    },
  },
  // Task #693: schema-row test factories must route through
  // `insertXSchema.parse(...)` so a new required schema column fails
  // LOUDLY at runtime instead of rotting silently behind TypeScript's
  // permissive structural type checks. Scoped to test files only —
  // production factories have their own correctness story.
  {
    files: ['tests/**/*.{ts,tsx}'],
    plugins: {
      local: { rules: { 'factory-must-use-schema': factoryMustUseSchema } },
    },
    rules: {
      'local/factory-must-use-schema': 'error',
    },
  },
  // React Hooks + TanStack Query correctness rules, scoped to the
  // frontend (only client code uses React and @tanstack/react-query).
  //
  // These replace ad-hoc "React Doctor" audits with rules that plug into
  // the same lint gate as the rest of the repo: net-new violations fail
  // `npm run lint`, existing debt is acknowledged via
  // `eslint-suppressions.json` (count-based, ratchets down only).
  //
  // `react-hooks/rules-of-hooks` is a hard correctness rule (conditional
  // hook calls break React) and is kept at `error` with zero
  // suppressions. `react-hooks/exhaustive-deps` and the TanStack Query
  // rules catch real staleness/identity bugs (e.g. a mutation that
  // forgets to invalidate, or a query key missing a dependency).
  //
  // We deliberately do NOT enable eslint-plugin-react-hooks v7's broader
  // React-Compiler rule suite (set-state-in-effect, no-deriving-state-in-
  // effects, etc.): those overlap with the React Doctor "State & Effects"
  // category we already triaged by hand and found to be dominated by
  // false positives for this codebase.
  {
    files: ['client/src/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      '@tanstack/query': tanstackQuery,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      '@tanstack/query/exhaustive-deps': 'error',
      '@tanstack/query/no-rest-destructuring': 'error',
      '@tanstack/query/stable-query-client': 'error',
      '@tanstack/query/no-unstable-deps': 'error',
      '@tanstack/query/no-void-query-fn': 'error',
      '@tanstack/query/infinite-query-property-order': 'error',
      '@tanstack/query/mutation-property-order': 'error',
      // `prefer-query-options` is intentionally OFF: it is a pure style
      // preference (wrap query config in the `queryOptions()` helper),
      // not a correctness rule, and flagged 193 existing call sites with
      // no bug-catching value. Enabling it would be linter-chasing.
    },
  },
);
