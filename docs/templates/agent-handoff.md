# Agent handoff

Keep this file concise. The agent assigned to this task is its single writer.
Parallel tasks use separate temporary local worktrees, task branches, and
handoffs; if separate worktrees are unavailable, serialize shared-worktree
edits, Git/index operations, builds, tests, and validation. Sol coordinates
their status and integrates selected changes into one PR branch.
Store verbose raw logs separately. Never include secrets, tokens, credentials,
or personal information. `.local/` is local evidence; paths are not portable by
default. Preserve local paths and add shared references when portable artifacts
exist.

## Identity and target

- Task slug:
- Task ID / agent ID:
- Objective and acceptance criteria:
- Worktree (absolute path):
- Target branch:
- Sol-owned PR integration branch / PR:
- Agent task branch (when using a separate worktree):
- Requested role / model / reasoning effort / preferred service tier:
- Actual runtime-reported role / model / reasoning effort / service tier (or
  launcher verification when available):
- Runtime collaboration schema/capabilities checked:
- Base commit:
- Current `HEAD`:
- Worktree state at last check (`clean`/`dirty`, status and diff evidence):
- Last reviewed commit:
- Last test/check commit:

## Ownership and constraints

- Owned paths:
- Forbidden or reserved paths:
- Affected systems:
- Constraints and invariants:
- Release authority: Sol

## Status and next step

- Status: `planned` | `active` | `blocked` | `ready-for-review` | `complete`
- Last meaningful update (UTC):
- Current result:
- Next step:
- Resume check: verify branch, `HEAD`, status, diff, and this handoff after a
  context reset. Fetch is read-only; do not unexpectedly switch branches,
  reset, rewind, or rebase mid-task.

## Decisions and escalation

- Decision / rationale / authority:
- Risks or assumptions:
- Escalation trigger and requested decision:
- Resolver or reviewer result:
- User release authorization scope and source: `standing routine scoped
  merge/migration/deploy authorization from the active user` | `<task-specific
  override or exact source>`

## Evidence

- Changed paths:
- Evidence producer and capture time (UTC):
- Exact reviewed/tested state (base/head SHAs, clean/dirty status):
- Relevant untracked source paths/content references reviewed:
- Commands and results:
- CI run, task IDs, or commit SHAs:
- Local evidence paths:
- Shared/portable artifact references (if any):
- Manual verification:
- Remaining checks or follow-up:

## Release lifecycle evidence

- GitHub review requested: `not yet` | `<timestamp>`
- GitHub review trigger: `automatic on open/ready` | `one explicit request (reason)`
- GitHub review run ID/URL:
- GitHub reviewed SHA:
- GitHub review completion/result: `pending` | `completed — pass/findings` | `blocked/unavailable — blocker`
- GitHub findings and factual disposition (`fix` or explanation if invalid):
- Fix SHA(s):
- Thread replies with specific validation and SHA:
- Resolved threads (addressed findings only):
- Final-head GitHub checks SHA and results:
- Merged certified SHA / Exact main certification evidence:
- Migration/backfill: `N/A — none required` | `<backup, target, fingerprint, guarded migration or backfill, and pending=none evidence>`
- Render service and Auto-Deploy verification before merge: `Off required when
  a migration or backfill is required`; otherwise record the allowed current
  mode and, when temporarily changed, prior setting: `Off` (manual exact-
  certified-SHA deployment after certification), `After CI Checks Pass`, or
  `On Commit`.
- Restored prior enabled Auto-Deploy mode after safe exact-SHA and health verification, when applicable:
- Render deployment: `<known service, exact certified SHA, deploy ID, health/
  org-context/log evidence>`
- Post-deploy tenant-isolation verification (same-org allowed / cross-org denied):
- HoundDog advisory result:

## Completion

- Completion metrics (when available):
- Cost metrics (when available; never estimate as fact):
- Review readiness (internal Sol review and exactly one GitHub review; does not
  grant release authority by itself):
- Branch and PR status:
- Database, deployment, security, tenant, payment, or provider implications:
