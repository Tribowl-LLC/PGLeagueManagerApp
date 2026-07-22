/**
 * ESLint suppression baseline guard (task #385, extended in #371).
 *
 * Tasks #329 and #384 drove the count of `@typescript-eslint/no-explicit-any`
 * suppressions in `eslint-suppressions.json` from 161 down to zero.
 * Task #371 then enabled four more escape-hatch rules
 * (`no-non-null-assertion`, `consistent-type-assertions`,
 * `no-unnecessary-type-assertion`, and a `no-restricted-syntax`
 * matcher for `as unknown as Foo` double casts) and seeded each with
 * a baseline. Without a forcing function, the next PR can silently
 * grow any of those counts again by adding new violations and
 * regenerating the baseline.
 *
 * This script reads `eslint-suppressions.json` and compares the live
 * counts against the ceilings declared below. By default it prints a
 * report and exits 0 (advisory). Pass `--strict` to exit 1 when any
 * ceiling is breached — that is how the vitest forcing function in
 * `tests/unit/check-eslint-baseline.test.ts` enforces the ratchet in
 * CI (we cannot add an `npm run check:eslint-baseline` script because
 * `package.json` is locked in this environment).
 *
 * Ratcheting the ceiling
 * ----------------------
 * When the live count drops below a ceiling, this script (in any mode)
 * emits a "RATCHET" suggestion line so the next contributor remembers
 * to lower the ceiling in the same PR. The ceiling lives at the top of
 * this file as a single literal block so reviewers see the change in
 * the diff.
 *
 * Run with:
 *   tsx scripts/check-eslint-baseline.ts            # advisory
 *   tsx scripts/check-eslint-baseline.ts --strict   # CI gate
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Map of `eslint-suppressions.json` rule name → maximum allowed count
// across the whole codebase. To add a new ratcheted rule, add it here
// (and only here) — the script will start enforcing it on the next run.
//
// Lower these as the live count drops; never raise them without an
// explicit, reviewed reason in the same PR.
const RULE_CEILINGS: Record<string, number> = {
  // Paid down to zero in task #384. Stays at 0 — any new `any` should
  // be typed instead of suppressed.
  '@typescript-eslint/no-explicit-any': 0,
  // Seeded by task #371 at the live count when the rule was turned
  // on. Ratchet down as `value!` sites are replaced with explicit
  // null/undefined handling.
  // Raised in the CI green-up pass: a stack of merged tasks (admin
  // email-change audit UI + tests, system-admin trust-proxy probe
  // tests, expanded sanitize/payment/charges receipt tests) all
  // landed `value!` patterns in test fixtures and mock builders
  // without ratcheting. The source-side `!`s in
  // `scripts/verify-trust-proxy-deploy.ts` were typed away in the
  // same pass; the remaining sites are test-only.
  // Ratcheted 256 → 255 in task #646 after deleting the dead
  // `checkAndChargeFinalTwoWeeks` helper from
  // `server/services/payment-checks.ts`, which carried one
  // suppression for this rule.
  // Ratcheted 244 → 220 in task #683 after the orphaned-data merge
  // converted ~24 `value!` patterns into explicit `if (!x) throw`
  // guards as part of the suppression-prune pass.
  // Ratcheted 220 → 218 alongside the query-staleness fix: the standard
  // `eslint --prune-suppressions` pass cleared two now-stale `value!`
  // suppressions in client/src/lib/utils (lane-pairing, score-organization).
  // Ratcheted 218 -> 187 after removing all remaining assertions from
  // server/routes/organization-admin.ts.
  '@typescript-eslint/no-non-null-assertion': 187,
  // Seeded by task #371. Ratchet down as redundant casts are removed.
  // Raised in the CI green-up pass for the same merged tasks above —
  // mock-construction casts in test files. The source-side
  // unnecessary cast in `server/routes/system-admin.ts` was removed
  // by widening `verifyTrustProxy`'s parameter to `Application`.
  // Ratcheted 92 → 91 in task #572 to match the live count after the
  // same CI green-up pass paid down one cast without lowering this
  // ceiling at the time.
  // Ratcheted 89 → 88 in task #646 after deleting the dead
  // `checkAndChargeFinalTwoWeeks` helper, which carried one
  // suppression for this rule.
  // Ratcheted 88 → 85 in task #683 after the suppression-prune pass
  // following the orphaned-data merge.
  // Ratcheted 85 → 84 in task #695's rebase resolution to match the
  // live count in eslint-suppressions.json after the suppression-prune
  // pass that landed alongside the test-only inline disables for the
  // new `no-unscoped-table-query-in-test-assertion` and
  // `no-spawn-tsx-in-test` rules.
  // Ratcheted 84 → 80 alongside the query-staleness fix: the prune pass
  // cleared four stale casts in client/src/components/ui/chart.tsx.
  '@typescript-eslint/no-unnecessary-type-assertion': 80,
  // Seeded by task #371. Currently only the object-literal-as-Foo
  // form (`{ ... } as Foo`) trips this; ratchet down by removing
  // those casts.
  '@typescript-eslint/consistent-type-assertions': 4,
  // The `as unknown as Foo` double-cast matcher — see eslint.config.js.
  // Seeded by task #371; ratchet down as those launderings are
  // replaced with type guards or Zod schemas.
  // Raised in the CI green-up pass: the same merged tasks above
  // landed `as unknown as Foo` patterns in test mocks (notably
  // `tests/api/system-admin-trust-proxy-status.test.ts`,
  // `tests/api/admin-email-change-audits*.test.ts`, the
  // sanitize/charges/payment receipt tests and other component /
  // post-confirm component tests). The source-side double cast in
  // `client/src/lib/square.ts` was removed by typing `responseData`
  // as `Partial<PaymentResult>`, and the one in
  // `server/routes/system-admin.ts` was removed by widening
  // `verifyTrustProxy`'s parameter type.
  // Ratcheted 159 → 154 in task #572 to match the live count after the
  // same CI green-up pass paid down five double-casts without lowering
  // this ceiling at the time. Ratcheted 154 → 153 in task #610 after the
  // PROVIDER_NOT_CONFIGURED test refactor in
  // tests/unit/use-bowler-payment-submit.test.ts collapsed six inline
  // `as unknown as` casts into three typed factory helpers (makeLeague,
  // makeBowler, makeCard).
  // Ratcheted 153 → 150 in task #683 after replacing the
  // `as unknown as` double-cast in the streamlined Square-422 unit
  // test with `Object.assign`-based narrowing and pruning two stale
  // suppressions in deleted/merged orphan-data tests.
  // Reset 150 → 153 in task #681's rebase: same situation as
  // no-unnecessary-type-assertion above — task #683's ratchet did not
  // actually update eslint-suppressions.json, so the pre-existing
  // baseline already failed the check.
  'no-restricted-syntax': 153,
  // Seeded when eslint-plugin-react-hooks + @tanstack/eslint-plugin-query
  // were wired into the lint gate. The clean rules (rules-of-hooks and the
  // 0-violation query rules) carry no suppressions; these three had
  // pre-existing violations that were baselined rather than risk-edited
  // (exhaustive-deps fixes can change effect/refetch behavior). Net-new
  // violations now fail lint. Ratchet down as each site is fixed
  // deliberately.
  'react-hooks/exhaustive-deps': 14,
  // Paid down 7 → 0: all seven missing-queryKey-dep sites were fixed.
  // Six were false positives where the URL/params derived only from
  // values already in the key — the derivation was inlined into the
  // queryFn so the (already-covered) dependency is visible to the rule.
  // One — leagues-page scores history — was a genuine staleness bug:
  // `currentWeek` (date-derived via getWeeksPassedInSeason) was used in
  // the fetch URL but missing from the key, so it is now in the key.
  // Stays at 0 — net-new violations fail `npm run lint` directly.
  '@tanstack/query/exhaustive-deps': 0,
  '@tanstack/query/no-unstable-deps': 5,
};

// Ceiling for the sum of all suppression counts across every rule.
// Catches "I added a different lint suppression instead" workarounds.
// Originally 472 (task #371: 232 non-null + 125 double-cast + 89
// unnecessary + 4 obj-literal + 22 pre-existing `no-undef` in
// client/public/sw.js). Raised in the CI green-up pass to absorb the
// per-rule increases above (test-only debt from a stack of merged
// tasks); see each per-rule comment for the breakdown. Ratcheted
// 533 → 527 in task #572 alongside the no-non-null-assertion drop
// from 38 → 35 in tests/unit/apple-pay-jobs.test.ts and the
// matching downward ratchets on no-unnecessary-type-assertion
// (92 → 91) and no-restricted-syntax (159 → 154).
// Ratcheted 524 → 522 in task #646 alongside the per-rule drops on
// `no-non-null-assertion` (256 → 255) and `no-unnecessary-type-assertion`
// (89 → 88) — both came from the dead `checkAndChargeFinalTwoWeeks`
// helper that was removed when the "Final 2 Weeks Due By" feature
// retired.
// Ratcheted 511 → 481 in task #683 alongside the per-rule drops on
// `no-non-null-assertion` (244 → 220), `no-unnecessary-type-assertion`
// (88 → 85), and `no-restricted-syntax` (153 → 150) — all from the
// suppression-prune pass that followed the orphaned-data test merge
// and the Square-422 mocked-unit replacement.
// Ratcheted 484 → 483 in task #695's rebase resolution alongside the
// per-rule drop on `no-unnecessary-type-assertion` (85 → 84). True
// live baseline: 220 nna + 84 nuta + 4 cta + 153 nrs + 22 pre-existing
// `no-undef` = 483.
// Raised 483 → 509 when eslint-plugin-react-hooks +
// @tanstack/eslint-plugin-query were wired into the lint gate: +14
// react-hooks/exhaustive-deps, +7 @tanstack/query/exhaustive-deps, +5
// @tanstack/query/no-unstable-deps — all pre-existing violations
// baselined rather than risk-edited. See BASELINE_BUMP_REASON.md.
// Ratcheted 509 → 496 after fixing all 7 @tanstack/query/exhaustive-deps
// sites (-7) and a prune-suppressions pass that cleared 6 pre-existing
// stale suppressions (-2 no-non-null-assertion, -4
// no-unnecessary-type-assertion).
// Ratcheted 496 -> 465 after removing the 31 stale organization-admin
// non-null-assertion suppressions.
const TOTAL_CEILING = 465;

const STRICT = process.argv.includes('--strict');
const SUPPRESSIONS_PATH = resolve(process.cwd(), 'eslint-suppressions.json');
const BUMP_REASON_PATH = resolve(process.cwd(), 'BASELINE_BUMP_REASON.md');

// Pseudo-rule key under which the aggregate `TOTAL_CEILING` is tracked
// in `BASELINE_BUMP_REASON.md`. Treated like any other rule by the
// ledger gate.
const TOTAL_KEY = 'TOTAL';

interface LedgerEntry {
  rule: string;
  oldCeiling: number;
  newCeiling: number;
  reason: string;
  ref: string;
}

// Parse `BASELINE_BUMP_REASON.md` and return the most recent recorded
// ceiling per rule. Each row in the markdown table is:
//   | rule | old ceiling | new ceiling | delta | reason | commit/task ref |
// The function tolerates surrounding prose, the header row, and the
// `| --- | --- | ... |` divider.
function loadLedger(path: string): Map<string, LedgerEntry> {
  const latest = new Map<string, LedgerEntry>();
  if (!existsSync(path)) return latest;
  const text = readFileSync(path, 'utf8');
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('|') || !line.endsWith('|')) continue;
    const cells = line
      .slice(1, -1)
      .split('|')
      .map((c) => c.trim());
    if (cells.length < 6) continue;
    const [rule, oldStr, newStr, , reason, ref] = cells;
    if (!rule) continue;
    if (rule === 'rule') continue; // header
    if (/^[-:\s]+$/.test(rule)) continue; // divider
    const oldN = Number(oldStr);
    const newN = Number(newStr);
    if (!Number.isFinite(newN) || !Number.isInteger(newN) || newN < 0) {
      continue;
    }
    latest.set(rule, {
      rule,
      oldCeiling: Number.isFinite(oldN) ? oldN : 0,
      newCeiling: newN,
      reason,
      ref,
    });
  }
  return latest;
}

interface SuppressionsFile {
  [filePath: string]: {
    [rule: string]: { count: number };
  };
}

function loadCounts(path: string): {
  byRule: Map<string, number>;
  total: number;
} {
  if (!existsSync(path)) {
    return { byRule: new Map(), total: 0 };
  }
  const raw = readFileSync(path, 'utf8');
  let json: SuppressionsFile;
  try {
    json = JSON.parse(raw) as SuppressionsFile;
  } catch (err) {
    throw new Error(
      `Failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const byRule = new Map<string, number>();
  let total = 0;
  for (const [filePath, fileEntry] of Object.entries(json)) {
    if (!fileEntry || typeof fileEntry !== 'object') continue;
    for (const [rule, info] of Object.entries(fileEntry)) {
      const rawCount = (info as { count?: unknown } | null)?.count;
      // Reject anything that isn't a finite, non-negative integer.
      // Without this, a corrupted entry like `{"count": "5"}` or
      // `{"count": NaN}` would silently coerce to 0 / NaN and let
      // suppression growth slip past both ceiling checks.
      if (
        typeof rawCount !== 'number' ||
        !Number.isFinite(rawCount) ||
        !Number.isInteger(rawCount) ||
        rawCount < 0
      ) {
        throw new Error(
          `Invalid count in ${path} at ${filePath} → ${rule}: ${JSON.stringify(rawCount)} (expected non-negative integer)`,
        );
      }
      byRule.set(rule, (byRule.get(rule) ?? 0) + rawCount);
      total += rawCount;
    }
  }
  return { byRule, total };
}

function main(): number {
  const { byRule, total } = loadCounts(SUPPRESSIONS_PATH);
  const ledger = loadLedger(BUMP_REASON_PATH);

  const breaches: string[] = [];
  const ratchets: string[] = [];
  const bumpFailures: string[] = [];

  function checkBump(rule: string, ceiling: number): void {
    const entry = ledger.get(rule);
    const recorded = entry?.newCeiling ?? 0;
    if (ceiling > recorded) {
      const delta = ceiling - recorded;
      bumpFailures.push(
        `${rule}: ceiling raised to ${ceiling} but BASELINE_BUMP_REASON.md ` +
          `records ${recorded}. Add a row in the same commit, e.g.:\n` +
          `    | ${rule} | ${recorded} | ${ceiling} | +${delta} | <one-line reason> | <#task or commit sha> |`,
      );
    }
  }

  for (const [rule, ceiling] of Object.entries(RULE_CEILINGS)) {
    const live = byRule.get(rule) ?? 0;
    if (live > ceiling) {
      breaches.push(
        `${rule}: ${live} suppressions (ceiling ${ceiling}). ` +
          `Remove the new suppression(s) instead of regenerating the baseline.`,
      );
    } else if (live < ceiling) {
      ratchets.push(
        `${rule}: ${live} suppressions (ceiling ${ceiling}). ` +
          `Lower RULE_CEILINGS['${rule}'] in scripts/check-eslint-baseline.ts to ${live}.`,
      );
    }
    checkBump(rule, ceiling);
  }

  if (total > TOTAL_CEILING) {
    breaches.push(
      `total suppressions: ${total} (ceiling ${TOTAL_CEILING}). ` +
        `Remove the new suppression(s) instead of regenerating the baseline.`,
    );
  } else if (total < TOTAL_CEILING) {
    ratchets.push(
      `total suppressions: ${total} (ceiling ${TOTAL_CEILING}). ` +
        `Lower TOTAL_CEILING in scripts/check-eslint-baseline.ts to ${total}.`,
    );
  }
  checkBump(TOTAL_KEY, TOTAL_CEILING);

  // Always print a summary so reviewers and CI logs have context.
  process.stdout.write(
    `eslint suppression baseline: scanned ${byRule.size} rule(s), ${total} total suppression(s)\n`,
  );
  for (const [rule, ceiling] of Object.entries(RULE_CEILINGS)) {
    process.stdout.write(
      `  ${rule}: ${byRule.get(rule) ?? 0} / ${ceiling}\n`,
    );
  }
  process.stdout.write(`  total: ${total} / ${TOTAL_CEILING}\n`);

  for (const r of ratchets) {
    process.stdout.write(`RATCHET: ${r}\n`);
  }

  const banner = STRICT ? 'FAIL' : 'WARN';
  if (breaches.length > 0) {
    for (const b of breaches) {
      process.stderr.write(`${banner}: ${b}\n`);
    }
  }
  if (bumpFailures.length > 0) {
    for (const b of bumpFailures) {
      process.stderr.write(`${banner}: ${b}\n`);
    }
    process.stderr.write(
      `\nA ceiling in scripts/check-eslint-baseline.ts was raised above ` +
        `the value most recently recorded in BASELINE_BUMP_REASON.md. Add a ` +
        `row to that ledger in the same commit (see the file's "How to bump ` +
        `a ceiling" section) and re-run this script.\n`,
    );
  }

  if (breaches.length > 0 || bumpFailures.length > 0) {
    if (breaches.length > 0) {
      process.stderr.write(
        `\nThe ESLint suppression baseline grew. Either remove the new ` +
          `suppression(s) by typing the offending code, or — with reviewer ` +
          `sign-off — raise the ceiling in scripts/check-eslint-baseline.ts ` +
          `AND log the bump in BASELINE_BUMP_REASON.md.\n`,
      );
    }
    if (STRICT) return 1;
  } else {
    process.stdout.write('OK: no ceilings exceeded\n');
  }
  return 0;
}

const code = main();
process.exit(code);
