# CI Duplication Audit

Audit date: 2026-07-20 (GitHub data observed through 2026-07-21 UTC).

## Decision

LeagueVault cannot use GitHub merge queue on its current plan. The repository
is private, organization-owned, and the GitHub API reports the organization plan
as `team`; GitHub supports merge queues for private organization repositories
only on Enterprise Cloud. The repository's `mergeQueue(branch: "main")` value
is therefore `null`, and no workflow currently receives `merge_group`.

References: [GitHub merge queue availability](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)
and [the `merge_group` Actions event](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#merge_group).

The safe Team-plan design is:

1. Run fast checks and the complete proposed-result suite in parallel on
   `pull_request`. The active ruleset's strict-status policy requires a PR to be
   current with `main`, and Actions checks out GitHub's PR merge ref by default.
2. Merge only after the full suite succeeds.
3. On the push to `main`, run only `Exact main certification`. It proves the
   pushed commit tree equals the merged PR head tree, links to the successful CI
   and Race runs for that head SHA, re-checks exact migration bytes/metadata,
   and performs a production build.

This keeps one complete database-backed test cycle per merge. It does not claim
to provide a merge queue or to separate the fast and complete pre-merge stages;
that separation requires upgrading the private repository to Enterprise Cloud.

## Current GitHub configuration

- Source: private `Tribowl-LLC/PGLeagueManagerApp`, default branch `main`.
- Plan: GitHub Team. Merge queue is unavailable for this private repository and
  is not enabled. Repository auto-merge is disabled.
- Merge methods: squash, rebase, and merge commits are enabled at repository
  level; the active ruleset permits squash and rebase and requires linear
  history.
- Protection: repository ruleset `LeagueVault Ruleset` (active), not legacy
  branch protection. It targets the default branch, has no bypass actors,
  blocks deletion and non-fast-forward pushes, requires pull requests and
  resolved review threads, and uses strict required-status checks.
- Required checks at audit time: `Type check & lint` and `Tests`, both from the
  GitHub Actions app (integration 15368).
- Deployments: no repository workflow triggers a Render deployment, and the
  GitHub Deployments API returned no deployment for inspected main SHA
  `291f17b0`. Render's deployment mode is external dashboard state and could not
  be verified from this repository or the available read-only GitHub API.
- External checks: Semgrep Cloud reported `semgrep-cloud-platform/scan` on the
  inspected PR head. It did not report on the inspected push-to-main commit.
  Its merge-group behavior is untested and immaterial on the current plan.

## Timing baseline

Durations are GitHub job wall times from the five most recent successful PR
runs, except Race (three recent full push runs) and Semgrep Cloud (the latest PR
sample). Medians are rounded to the nearest second.

| Check | Observed median | Observed range | Notes |
|---|---:|---:|---|
| Tests | 7m 31s | 7m 6s–8m 37s | Dominates pre-merge wall time |
| Type check & lint | 1m 33s | 1m 17s–1m 39s | Fast PR feedback and production build |
| Database migrations (PostgreSQL 16) | 1m 13s | 1m 3s–1m 28s | Full replay/adoption/refusal coverage |
| Database migrations (PostgreSQL 17) | 1m 9s | 1m 2s–1m 38s | Full replay/adoption/refusal coverage |
| Race suite (full) | 1m 18s | 1m 14s–1m 23s | Former PR skips took 20–32s |
| Semgrep (PR diff scan) | 2m 12s | 1m 55s–2m 45s | Push full scans took 7m 27s–7m 35s |
| Semgrep Cloud | 2m 10s | one sample | External PR check |
| Gitleaks | 10s | 8s–14s | PR commit range |
| HoundDog | 11s | 10s–13s | Advisory (`continue-on-error`) |

The duplicated push cycle consumed about 20.3 runner-minutes in a representative
successful run: CI jobs 11.5, Race 1.2, Semgrep 7.5, and Gitleaks/HoundDog 0.4.
Exact-main certification is expected to take about 1.5–2 minutes. Making Race
unconditional adds about one runner-minute to PRs that formerly skipped it. Net
savings are approximately 17–18 runner-minutes per merged PR (about 50% of the
previous paired PR-plus-push runner usage), while safe-to-deploy wall time drops
from roughly 15 minutes to roughly 9–10 minutes.

## Event and check matrix

| Workflow/check | `pull_request` | `merge_group` | push to `main` | schedule | manual |
|---|---:|---:|---:|---:|---:|
| Type check & lint | Full | — | — | — | — |
| Tests | Full | — | — | — | — |
| PostgreSQL 16/17 migrations | Full | — | — | — | — |
| Race suite | Full | — | — | — | — |
| Gitleaks | PR commits | — | — | Full history weekly | Full history |
| HoundDog | Advisory scan | — | — | Weekly | Full-tree scan |
| Semgrep | Diff-aware | — | — | Full scan weekly | Full scan |
| Semgrep Cloud | External PR check | Unsupported/unverified | Not observed | Provider-owned | Provider-owned |
| Exact main certification | — | — | Full | — | Current `main` |
| Post-deploy trust-proxy probe | — | — | — | Daily | Live probe |

All PR workflows cancel superseded runs for the same PR. Scheduled/manual
security runs use a unique run-id concurrency key and are not cancelled by PR
updates. Merge-result validation has no `merge_group` concurrency because that
event is unavailable. Exact-main runs share a main-ref group with
`cancel-in-progress: false`, so a later merge cannot cancel an earlier commit's
certification.

## Check placement rationale

- Immediate PR feedback: type checking, lint and policy checks, dependency
  audits, build, Gitleaks, HoundDog, Semgrep, and Semgrep Cloud.
- Proposed result: Tests, PostgreSQL 16 and 17 migration/adoption/refusal
  coverage, and Race suite. On Team these must remain on `pull_request`; strict
  status checks keep the PR current with main.
- Exact final main commit: provenance/tree identity, migration bytes and
  metadata, and production build only.
- Scheduled: full Gitleaks history, full Semgrep scan, HoundDog, and the live
  trust-proxy probe.

No `pull_request_target` event is used. PR jobs receive only read permissions
and use deterministic local-only fallback values when repository secrets are
unavailable to forks or Dependabot.

## Required settings transition

Workflow and ruleset changes are deliberately staged so there is no missing
required-check window:

1. Inspect Render before merging this PR. If it deploys immediately on every
   push to `main`, disable auto-deploy temporarily; the repository cannot add a
   check-dependent gate before the new check exists.
2. Merge the workflow/documentation PR while the existing required checks
   `Type check & lint` and `Tests` are still emitted on PRs. Do not remove or
   rename either context.
3. Verify on that PR that both migration jobs and the now-unconditional Race
   suite succeed. After merge, verify `Exact main certification` succeeds and
   its tree/provenance log points to that PR's successful runs.
4. Add `Database migrations (PostgreSQL 16)`, `Database migrations (PostgreSQL
   17)`, and `Race suite` to the active ruleset's required checks. Keep strict
   status checks, pull-request requirement, linear history, deletion/non-fast-
   forward blocks, and no bypass actors.
5. Open a test PR and verify all five required contexts are emitted and block
   merging when deliberately failing or pending. Verify a superseding commit
   cancels the older PR runs but not the current ones.
6. Configure Render to deploy only the exact main SHA after `Exact main
   certification` succeeds. Until that external gate is confirmed, disable
   deploy-on-push and manually deploy the certified SHA.
7. Keep the existing security scans visible. Gitleaks can be made required after
   a test PR proves fork and Dependabot behavior. Do not require local Semgrep
   while its Dependabot job-level skip can omit the context. HoundDog remains
   advisory because its scanner step currently uses `continue-on-error`.
8. Database adoption or migration operators must independently record the
   green main SHA from `Exact main certification`; never derive the expected
   commit from the database target, deployment, or an unverified branch.

No repository settings were changed by this implementation.

## Enterprise merge-queue migration

If the organization upgrades to Enterprise Cloud, use separate staged PRs:

1. Add `merge_group: { types: [checks_requested] }` to complete-suite workflows
   while retaining current PR triggers. Make merge-group concurrency unique by
   `github.ref` and never cancel in-progress queue validations.
2. Exercise a queue entry and prove all intended contexts report on the
   merge-group SHA. Confirm Semgrep Cloud supports that SHA before requiring it.
3. Add the verified contexts to ruleset requirements, then enable the merge
   queue with squash, one-PR groups initially, non-failing PRs only, and a timeout
   greater than the observed Tests ceiling.
4. Only after a successful queue merge, move Tests, both migration jobs, and
   Race from `pull_request` to `merge_group`; retain fast PR feedback jobs.
5. Keep exact-main certification on push and update its provenance verifier to
   consume recorded merge-group evidence rather than PR-head runs.

Running the full suite on both `pull_request` and `merge_group` is only a
temporary rollout state. It is not the final Enterprise design.

## Rollback

If exact-main certification fails unexpectedly, stop deployment and inspect its
provenance error; do not rerun the full suite against a different SHA. Re-enable
the former push triggers on `ci.yml`, `race-suite.yml`, and required security
workflows before disabling the certificate or changing Render gating. Verify a
green full push run, then remove `Exact main certification` from any external
deployment gate. Required PR checks remain in place throughout this rollback.

If a newly required database or Race context is not emitted, remove only that
new context from the ruleset after confirming `Type check & lint` and `Tests`
remain required and green. Fix the workflow on a PR, verify it reports, and add
the context back. Never remove all required checks as a troubleshooting step.

## Remaining assumptions and risks

- Render dashboard settings were not readable, so deployment gating requires a
  separate authorized configuration step.
- The repository may still permit administrators to change settings, but the
  active ruleset currently lists no bypass actors. Exact-main provenance fails
  closed for a direct push that is not a recorded PR merge.
- The tree-identity proof assumes GitHub's recorded squash/rebase result has the
  same tree as the successfully checked PR head. A mismatch fails certification.
- Semgrep Cloud merge-group support could not be established from official
  provider documentation and must be tested before any future queue rollout.
