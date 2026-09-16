# Agent handoff

Keep this file concise. Luna is the single writer. Store verbose raw logs
separately. Never include secrets, tokens, credentials, or personal
information. `.local/` is local evidence; paths are not portable by default.
Preserve local paths and add shared references when portable artifacts exist.

## Identity and target

- Task slug:
- Task ID / agent ID:
- Objective and acceptance criteria:
- Worktree (absolute path):
- Target branch:
- Requested role / model / reasoning effort:
- Actual runtime-reported role / model / reasoning effort (or launcher verification):
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
- Release authority: Astra

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
- User merge/deploy authorization scope and source: `not granted` | `<exact scope and message/source>`

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

## Completion

- Completion metrics (when available):
- Cost metrics (when available; never estimate as fact):
- Review readiness (does not grant merge/deploy authorization):
- Branch and PR status:
- Database, deployment, security, tenant, payment, or provider implications:
