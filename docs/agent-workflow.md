# Agent Workflow

This is the default workflow for multi-step implementation in this repository.
It keeps one accountable architect and gives bounded coding work durable,
reviewable handoffs. Handle simple questions and tiny documentation tasks
directly; do not add delegation ceremony where it has no value.

## Roles and authority

| Role | Default responsibility |
| --- | --- |
| Sol (root) | Uses `gpt-6-sol` at `max` reasoning with the preferred fast tier for architecture, task scope, review, release authority, and user communications. Creates the initial plan, decomposes and coordinates bounded tasks, handles escalations, and makes the final integration decision. |
| Luna | Uses `gpt-6-luna` at `max` reasoning with the preferred fast tier as the bounded coding executor. Owns assigned edits, checks, fixes, CI work, and updates to the task handoff. |
| Fresh Sol | Uses `gpt-6-sol` at `max` reasoning with the preferred fast tier for short-context bounded blocker resolution or internal final review. It must inspect the relevant diff, code, and tests rather than relying on a summary. |

Sol remains accountable while Luna executes bounded assignments. Sol owns task
decomposition, coordination, architecture, review, and integration; Luna owns
only its assigned scope. Sol may relay short milestones and must not claim work
continues autonomously after the session ends. Sol stays lightweight and does
not repeatedly read raw logs or redo assigned work. A reviewer does not become
a second writer: use read-only review unless an explicit unblocker brief grants
file ownership, and pause the overlapping writer while that unblocker edits.

The default release lifecycle is the single numbered procedure in
[`docs/production-runbook.md`](production-runbook.md#default-release-lifecycle).
It applies to every PR-required change. The active user's standing
authorization permits the accountable root/Sol to merge after review and
final-head checks. Code-only releases may merge with Render Auto-Deploy On or
Off. With Auto-Deploy On, rollout may start before Exact main certification;
after certification, verify the running service is the exact certified SHA and
passes health checks. If certification fails after an automatic rollout starts
or completes, treat it as a live-release incident. With Auto-Deploy Off, wait
for certification, then manually deploy and verify the exact certified SHA.
For a required migration or data backfill, verify Auto-Deploy Off before merge,
keep it Off through certification and the guarded operation, then manually
deploy and verify the exact certified SHA before restoring the prior enabled
mode after a safe SHA check. A task-specific hold, draft, no-deploy instruction,
or explicit approval rule overrides that default. PR-ready status alone never
authorizes release actions; Sol owns merge, migration, and deployment decisions.

After successful deployment verification, follow step 8 of the
[default release lifecycle](production-runbook.md#default-release-lifecycle)
for the fast-forward-only local `main` update and safe old-worktree cleanup.
That procedure runs only during the active session and skips or reports dirty,
active, protected, uncertain, or otherwise ineligible worktrees.

These are desired model, reasoning, and tier assignments. This Markdown cannot
select or change the running root model, reasoning effort, or service tier,
enforce a watchdog, or run after the session ends. The launcher/runtime must
select the actual values and provide collaboration tools, capacity, and a live
process for these defaults to operate. Verify actual values when reported. The
exposed `collaboration.spawn_agent` schema can vary by runtime. Inspect it for
each call and use only accepted fields. Some runtimes expose `model` and
`reasoning_effort`; others may require launcher configuration. Request the
preferred fast tier through the launcher when supported and report it as
unverified when the runtime provides no evidence. Do not imply a tier guarantee
from this document alone.

## 1. Sol makes the initial plan

Sol uses the `gpt-6-sol` / `max` default and preferred fast tier to define the
work, then delegates bounded concrete coding tasks to GPT-6 Luna agents. Sol
retains coordination and integration. Use parallel agents only for independent
tasks with disjoint write ownership and a separate task handoff for each.

Before delegation, Sol records a concise plan with:

- desired outcomes and acceptance criteria;
- constraints, invariants, and out-of-scope work;
- affected systems and risk areas;
- exact file or directory ownership for each agent;
- validation commands and expected evidence;
- material risks and who has release authority.

Inspect the active worktree, branch, and status first. Start from the latest
`origin/main` on a clean short-lived branch for new work. Preserve existing
user changes. Fetch is read-only and may inspect freshness or CI. Do not
unexpectedly switch branches, reset, rewind, or rebase during an active task;
a deliberate reviewed base update follows repository policy and updates the
handoff. A resume first verifies the current branch, `HEAD`, status, diff, and
handoff state.

Sol owns the single PR integration branch and PR. For parallel tasks, give each
Luna a separate temporary local worktree and task branch based on that
integration branch, plus a distinct handoff. Each agent reports its commit and
evidence; Sol cherry-picks selected changes into the PR branch, resolves
conflicts, and owns the final integrated checks and PR. Delegated agents do not
push or open separate PRs. If separate worktrees are unavailable, serialize all
edits, Git/index operations, builds, tests, and validation in the shared
worktree. Do not run these activities concurrently even when agents own
disjoint source paths; the worktree still shares its index and generated
outputs.

## 2. Sol delegates bounded Luna tasks

Give each Luna agent a self-contained brief: objective, acceptance criteria,
constraints, owned paths, validation, escalation rules, and absolute worktree
and handoff paths. Use a safe task slug of lowercase letters, digits, and
underscores only (for example, `payment_retry_audit`). Sol sequences dependent
work and coordinates integration. At startup, inspect the exposed
`collaboration.spawn_agent` schema and use only its accepted fields and enum
values. A role label in the prompt cannot select a model, reasoning effort, or
service tier. The minimal call below uses only base fields. Before invoking it,
verify that the actual assignment is GPT-6 Luna at max reasoning: inspect the
schema and add supported overrides, or configure and verify the role through the
launcher. Do not invoke it with an unverified or inherited model assignment.

```js
const request = {
  task_name: "luna_<task_slug>",
  fork_turns: "none",
  message: `Role: GPT-6 Luna bounded coding executor at max reasoning; request the preferred fast tier through the launcher when supported. Do not bootstrap another coordinator.
Objective: <outcome and acceptance criteria>
Worktree: /absolute/path/to/worktree
Handoff: /absolute/path/to/worktree/.local/agent-tasks/<task-slug>/handoff.md
Owned paths: <files or directories>
Constraints: <invariants and out-of-scope paths>
Validation: <commands and required evidence>
PR: Sol owns the single PR and ensures it is ready for review. After pushing,
verify it is not a draft and mark it ready if needed. Delegated agents return
commits and evidence. Follow the standing release policy and runbook gates for
merge/migration/deploy.
Escalate: <triggers and how to pause safely>`
};
// After inspecting the schema, uncomment only the supported overrides:
// request.model = "gpt-6-luna";
// request.reasoning_effort = "max";
// Request the preferred fast tier through the launcher when supported; do not
// pass a tier field unless the inspected schema accepts it.
await collaboration.spawn_agent(request);
```

If the inspected schema exposes `model` and `reasoning_effort`, add them before
the call (for example,
`request.model = "gpt-6-luna"` and
`request.reasoning_effort = "max"`). Request the preferred fast tier through
the launcher when it supports that choice; do not assume every schema has a
tier argument. Record requested and actual model, reasoning, and tier values
reported by the runtime, or the launcher's verification when available. If
overrides are not accepted, the launcher must preconfigure and verify the
role's model and reasoning effort before startup; do not pass unknown
arguments. If the requested model or effort is unavailable, report that
limitation and stop the delegation decision. If the preferred fast tier cannot
be selected or verified, record that limitation without claiming the tier is
guaranteed. Do not silently substitute a model, inherit Sol for Luna (or Luna
for Sol), or assign Sol's decomposition and coordination duties to a bounded
coding executor.

Every bounded child startup must detect its assigned role (Luna executor, Sol
blocker resolver, Sol final reviewer, or another explicitly named role) and
execute only that brief. It must not recursively bootstrap a coordinator,
interpret default instructions as a request to spawn one, or silently change
models. Sol owns any additional decomposition and launches independent tasks
with separate, disjoint assignments. Respect the actual available depth and
slots: never hardcode a slot count such as four. Reserve capacity for a blocker
and final reviewer, or queue independent work. If a requested model or tool is
unavailable, report that limitation instead of silently substituting another.

## 3. Luna executes and records portable state

For each delegated task, create one durable handoff at
`.local/agent-tasks/<task-slug>/handoff.md`, using
[`docs/templates/agent-handoff.md`](templates/agent-handoff.md). The assigned
Luna executor is the single writer for that task's handoff. Give parallel tasks
distinct task slugs and handoffs; Sol tracks their status and coordinates the
combined result. Keep handoffs short; put verbose raw command logs in separate
local files. Neither handoffs nor logs may contain secrets or personal
information. The `.local/` state is local evidence and is not portable unless
copied into an approved artifact.

Record the task and agent IDs, requested role/model/effort, actual
runtime-reported role/model/effort (or launcher verification), and the
runtime schema/capabilities checked. Also record the target branch, base
commit, current `HEAD`, exact reviewed commit, exact test/check commit, changed
paths, test/check commands and results, artifact paths, decisions, authority,
risks, and the next step. Preserve local evidence paths and add
shared/portable artifact references when available. A review or check must
have a fresh evidence producer tied to the exact tree under review: capture
branch, `HEAD`, status, and relevant untracked paths/content before reporting
results. Prefer a clean committed checkpoint with exact base/head SHAs and
commands such as `git diff --check <base SHA> <head SHA>` and
`git diff <base SHA> <head SHA> -- <owned paths>`. Check that relevant
untracked source is not omitted. If a check ran before a commit, record
clean/dirty status plus status/diff evidence; a SHA alone does not identify a
dirty tested worktree. Never commit unrelated user changes. Update state at
meaningful boundaries: plan accepted, edit complete, check result, escalation,
and handoff. After a context reset, verify git state against the handoff before
resuming; do not trust stale prose alone.

Each Luna executor owns its bounded assignment: make the assigned edits, run
applicable checks, fix task-related failures, run CI or report its result, and
keep its handoff current. Sol retains task coordination, architecture, review,
and integration. Validation follows the focused policy in
[`AGENTS.md`](../AGENTS.md#verification): use the smallest explicit Vitest
project and file, with a prepared disposable migrated test environment for
database-backed tests. Do not run an unfiltered local suite or approximate it
with project batches by default; only run a full local suite when the user
explicitly requests or authorizes it for the task, and GitHub remains the full
test gate. For documentation-only work,
record diff, link, and consistency review and mark application checks
inapplicable. Record commands as run, not applicable, blocked, or failed, and
never describe a focused pass as a full-suite pass. Changes outside owned paths,
architecture changes, or release choices return to Sol. Sol does not edit an
agent-owned path while its writer is active unless ownership is explicitly
reassigned; independent work may continue with disjoint ownership.

## 4. Escalate bounded exceptions

Escalate for a fresh bounded Sol task when any of these occurs:

- two unsuccessful fixes for the same issue;
- repeated tool failure;
- 15 minutes without concrete progress, excluding a genuinely running test or
  build;
- a new material architecture or risk change;
- a new or unplanned tenant isolation, authentication, authorization, payments,
  migration, retry, or webhook decision. Details already covered by Sol's
  approved plan stay with the assigned owner.

There is no continuous model-polling watcher. Luna writes the blocker and safe
next step to its handoff, then pauses the affected task. Sol decides whether a
fresh bounded Sol resolver is needed and launches it with explicit paths and
acceptance criteria. The resolver is read-only unless its brief explicitly
assigns a disjoint unblocker file set; pause the affected Luna task if ownership
overlaps.

Use the schema-checked portable call from section 2 for a resolver as well;
set `model: "gpt-6-sol"` and `reasoning_effort: "max"` only when the
exposed schema accepts them. Request the preferred fast tier through the
launcher when supported, and verify the actual or launcher-configured values
when evidence is available. For a dirty worktree blocker, pass an existing
generated diff artifact
under the ignored `.local/agent-tasks/<slug>/` directory, plus references to
the list or content of relevant untracked source files, excluding secrets. Do
not invent artifact paths or snapshots. The reviewer verifies the supplied
snapshot against the current tree, and Luna pauses relevant edits while the
snapshot is consumed.

The portable example below uses only base fields. Before invoking it, verify
that the actual assignment is GPT-6 Sol at max reasoning: inspect the schema
and add supported overrides, or configure and verify the role through the
launcher. Do not invoke it with an unverified or inherited model assignment.
Request the preferred fast tier through the launcher when supported.

```js
const request = {
  task_name: "sol_review_<task_slug>",
  fork_turns: "none",
  message: `Role: GPT-6 Sol reviewer/resolver at max reasoning; request the preferred fast tier through the launcher when supported. Read-only; no recursive coordinator startup.
Worktree: /absolute/path/to/worktree
Base commit / head commit: <base SHA> / <head SHA>
Dirty diff evidence if applicable: <existing absolute artifact path>
Relevant untracked source references if applicable: <reviewed paths/content references>
Question/review goal: <bounded blocker or internal diff+code+tests review>
Evidence: findings with severity, file/line, commands, commit IDs, and dirty-diff state.
PR: Sol owns the single PR and ensures it is ready for review. After pushing,
verify it is not a draft and mark it ready if needed. Follow the standing
release policy and runbook gates for
merge/migration/deploy.`
};
// After inspecting the schema, uncomment only the supported overrides:
// request.model = "gpt-6-sol";
// request.reasoning_effort = "max";
await collaboration.spawn_agent(request);
```

## 5. Internal Sol review

After all delegated Luna tasks report completion, Sol integrates their results
and directs one fresh Sol final reviewer. Sol launches the reviewer using the
schema-checked portable call from section 2, adding
`model: "gpt-6-sol"` and `reasoning_effort: "max"` only when those fields
are exposed and accepted. Request the preferred fast tier through the
launcher when supported and report it as unverified when no runtime evidence
is available. The reviewer independently inspects the exact
base/head diff, relevant code, and tests, and reports findings by severity with
fresh evidence. The brief names the exact base/head SHAs, clean/dirty status,
and commands used to capture and check the diff, such as
`git diff --check <base SHA> <head SHA>` and
`git diff <base SHA> <head SHA> -- <owned paths>`. It must not review the
summary alone and is read-only by default. Prefer a clean committed
checkpoint; for a dirty review, supply the existing ignored artifact and
relevant untracked source references described in section 4.

This is an internal architecture review. It is separate from, and never
substitutes for, the one independent GitHub review required for each PR in the
default release lifecycle.

Sol assigns accepted findings to the Luna owner for the affected scope, or
resolves cross-scope and architecture findings directly. The assigned owner
runs focused follow-up checks and records evidence in its handoff. Run a new
internal review only when a fix introduces substantial new risk. Do not create
automatic endless re-reviews. The reviewer returns commit IDs and evidence;
Sol decides whether the integrated result is ready for the GitHub
review/release lifecycle.

## Completion and pull requests

The completion report states changed files, validation results, skipped or
blocked checks, database and deployment implications, security or provider
implications, manual verification, remaining risks, and branch/PR status. It
must identify each local check that ran or was inapplicable and must not claim
the complete suite passed unless that full suite actually ran successfully.
Include completion and cost metrics when the harness provides them; never
invent costs or claim unavailable telemetry.

Create pull requests ready for review unless the user explicitly requests a
draft. After pushing, verify the PR is not a draft and mark it ready when
needed. Ready-for-review status does not authorize merging. Follow the one
GitHub review and final-head check gates in the
[default release lifecycle](production-runbook.md#default-release-lifecycle).
The standing user authorization described there covers routine merge,
guarded-migration, and exact-certified-commit deployment actions once those
gates pass, followed by the safe step 8 cleanup procedure after deployment
verification. Later task-specific holds, drafts, no-deploy instructions, or
explicit approval requirements take precedence.

## Compact handoff brief

Use this checklist in every delegated brief and adapt the role and labels to the task:

```text
Role: GPT-6 Luna bounded coding executor; no recursive coordinator startup.
Objective / acceptance: ...
Worktree / task slug / handoff: /abs/... / ... / /abs/.../handoff.md
Target branch / base commit: ... / ...
Owned paths / forbidden paths: ... / ...
Affected systems / constraints / risks: ...
Validation and evidence: ...
Release authority: Sol; escalation triggers: ...
PR: ready for review; after push verify not draft; follow the one-review and
final-head check gates in the production runbook; PR-ready alone does not
authorize merge/migration/deploy.
Completion: return IDs, SHAs, tests, artifacts, decisions, and next step; Luna updates its handoff and Sol coordinates integration.
```

For background on repository instructions and subagents, see the official
[AGENTS.md guidance](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
and [subagents guidance](https://learn.chatgpt.com/docs/agent-configuration/subagents).
