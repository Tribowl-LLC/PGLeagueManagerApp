# Agent Workflow

This is the default workflow for multi-step implementation in this repository.
It keeps one accountable architect while giving routine execution a durable,
reviewable loop. Handle simple questions and tiny documentation tasks directly;
do not add delegation ceremony where it has no value.

## Roles and authority

| Role | Default responsibility |
| --- | --- |
| Astra (root) | Uses `gpt-6-astra` at `medium` reasoning for architecture, task scope, release authority, and user communications. Creates the initial plan, starts the execution loop, handles escalations, and makes the final integration decision. |
| Luna | Long-running routine executor. Owns assigned edits, checks, fixes, CI work, and updates to the task handoff. |
| Fresh Astra | Short-context bounded blocker resolver or internal final reviewer. It must inspect the relevant diff, code, and tests rather than relying on a summary. |

The root remains accountable even while Luna executes. Root may relay short
milestones and must not claim work continues autonomously after the session
ends. Root stays lightweight and does not repeatedly read raw logs or redo
Luna's assigned work. A reviewer does not become a second writer: use read-only
review unless an explicit unblocker brief grants file ownership, and pause the
overlapping writer while that unblocker edits.

The default release lifecycle is the single numbered procedure in
[`docs/production-runbook.md`](production-runbook.md#default-release-lifecycle).
It applies to every PR-required change. The active user's standing
authorization permits the accountable root/Astra to merge after review and
final-head checks, run the guarded Neon migration when needed after exact-main
certification, and deploy the exact certified `main` commit after the
preceding migration gate. A task-specific hold, draft, no-deploy instruction,
or explicit approval rule overrides that default. PR-ready status alone never
authorizes release actions; the root owns merge, migration, and deployment
decisions.

This Markdown documents intended behavior; it cannot select or change the
running root model, enforce a watchdog, or run after the session ends. The
launcher/runtime must provide model selection, collaboration tools, capacity,
and a live process for these defaults to operate. Report unavailable support;
do not imply a guarantee from this document alone.

## 1. Astra makes the initial plan

Astra uses the `gpt-6-astra` / `medium` default for this plan, then delegates
the routine coordination and execution loop to one long-running Luna agent.

Before delegation, Astra records a concise plan with:

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

## 2. Astra starts one Luna execution loop

Give Luna a self-contained brief: objective, acceptance criteria, constraints,
owned paths, validation, escalation rules, and absolute worktree and handoff
paths. Use a safe task slug of lowercase letters, digits, and underscores only
(for example, `payment_retry_audit`). At startup, inspect the exposed
`collaboration.spawn_agent` schema and use only its accepted fields and enum
values. A role label in the prompt cannot select a model or reasoning effort.
Use the minimal call below only after the launcher has verified the requested
model and effort. Where supported, add the explicit overrides described below
to `request` before invoking the tool:

```js
const request = {
  task_name: "luna_<task_slug>",
  fork_turns: "none",
  message: `Role: Luna routine executor; do not bootstrap another coordinator.
Objective: <outcome and acceptance criteria>
Worktree: /absolute/path/to/worktree
Handoff: /absolute/path/to/worktree/.local/agent-tasks/<task-slug>/handoff.md
Owned paths: <files or directories>
Constraints: <invariants and out-of-scope paths>
Validation: <commands and required evidence>
PR: ready for review; after pushing verify it is not a draft; follow the
standing release policy and runbook gates for merge/migration/deploy.
Escalate: <triggers and how to pause safely>`
};
await collaboration.spawn_agent(request);
```

If the inspected schema explicitly exposes `model` and
`reasoning_effort`, set them before the call (for example,
`request.model = "gpt-5.6-luna"` and
`request.reasoning_effort = "xhigh"`). Record the requested
values and the actual values reported by the runtime, or the launcher's
verification when the runtime does not report them. If overrides are not
accepted, the launcher must preconfigure and verify the role's model and
reasoning effort before startup; do not pass unknown arguments. If the
requested model or effort is unavailable, report that limitation and stop the
delegation decision. Do not silently substitute a model, inherit Astra for
Luna (or Luna for Astra), or delegate the full routine loop to the wrong model.

Every bounded child startup must detect its assigned role (Luna executor, Astra
blocker resolver, Astra final reviewer, or another explicitly named role) and
execute only that brief. It must not recursively bootstrap a coordinator,
interpret default instructions as a request to spawn one, or silently change
models. Respect the actual available depth and slots: never hardcode a slot
count such as four. Reserve capacity for a blocker and final reviewer, or
queue independent work. If Luna cannot spawn nested work, Astra launches only
the specifically requested bounded Astra task. If a requested model or tool is
unavailable, report that limitation instead of silently substituting another.

## 3. Luna executes and records portable state

Create one durable handoff at
`.local/agent-tasks/<task-slug>/handoff.md`, using
[`docs/templates/agent-handoff.md`](templates/agent-handoff.md). Luna is the
single writer for that handoff. Keep it short; put verbose raw command logs in
separate local files. Neither handoff nor logs may contain secrets or personal
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

Luna owns the routine loop: make the assigned edits, run applicable checks,
fix task-related failures, run CI or report its result, and keep the handoff
current. Changes outside owned paths, architecture changes, or release choices
return to Astra. The root does not duplicate edits while Luna is the active
writer.

## 4. Escalate bounded exceptions

Escalate for a fresh bounded Astra task when any of these occurs:

- two unsuccessful fixes for the same issue;
- repeated tool failure;
- 15 minutes without concrete progress, excluding a genuinely running test or
  build;
- a new material architecture or risk change;
- a new or unplanned tenant isolation, authentication, authorization, payments,
  migration, retry, or webhook decision. Details already covered by Astra's
  approved plan stay with the assigned owner.

There is no continuous model-polling watcher. Luna writes the blocker and safe
next step to the handoff, then pauses the affected work. If child spawning is
supported and authorized, Luna may launch the fresh Astra resolver; otherwise
root launches it as a bounded fallback, with explicit paths and acceptance
criteria. The resolver is read-only unless its brief explicitly assigns a
disjoint unblocker file set; pause Luna if ownership overlaps.

Use the schema-checked portable call from section 2 for a resolver as well;
set `model: "gpt-6-astra"` and `reasoning_effort: "medium"` only when the
exposed schema accepts them, and verify the actual or launcher-configured
values. For a dirty worktree blocker, pass an existing generated diff artifact
under the ignored `.local/agent-tasks/<slug>/` directory, plus references to
the list or content of relevant untracked source files, excluding secrets. Do
not invent artifact paths or snapshots. The reviewer verifies the supplied
snapshot against the current tree, and Luna pauses relevant edits while the
snapshot is consumed.

The minimal example below also requires verified Astra/medium launcher
selection; otherwise add supported overrides before invoking it.

```js
await collaboration.spawn_agent({ task_name: "astra_review_<task_slug>", fork_turns: "none",
  message: `Role: Astra reviewer/resolver; read-only; no recursive coordinator startup.
Worktree: /absolute/path/to/worktree
Base commit / head commit: <base SHA> / <head SHA>
Dirty diff evidence if applicable: <existing absolute artifact path>
Relevant untracked source references if applicable: <reviewed paths/content references>
Question/review goal: <bounded blocker or internal diff+code+tests review>
Evidence: findings with severity, file/line, commands, commit IDs, and dirty-diff state.
PR: ready for review; after push verify not draft; follow the standing release
policy and runbook gates for merge/migration/deploy.` });
```

## 5. Internal Astra review

After Luna reports completion, Astra directs one fresh Astra final reviewer;
Luna may launch it when child spawning is supported, otherwise root launches
it. Use the schema-checked portable call from section 2, adding
`model: "gpt-6-astra"` and `reasoning_effort: "medium"` only when those fields
are exposed and accepted. The reviewer independently inspects the exact
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

Luna fixes accepted findings, then runs focused follow-up checks for the
affected scope. Run a new internal review only when the fix introduces
substantial new risk. Do not create automatic endless re-reviews. The reviewer
returns commit IDs and evidence; Luna records them in the handoff. Astra
decides whether the result is ready for the GitHub review/release lifecycle.

## Completion and pull requests

The completion report states changed files, validation results, skipped or
blocked checks, database and deployment implications, security or provider
implications, manual verification, remaining risks, and branch/PR status.
Include completion and cost metrics when the harness provides them; never
invent costs or claim unavailable telemetry.

Create pull requests ready for review unless the user explicitly requests a
draft. After pushing, verify the PR is not a draft and mark it ready when
needed. Ready-for-review status does not authorize merging. Follow the one
GitHub review and final-head check gates in the
[default release lifecycle](production-runbook.md#default-release-lifecycle).
The standing user authorization described there covers routine merge,
guarded-migration, and exact-certified-commit deployment actions once those
gates pass. Later task-specific holds, drafts, no-deploy instructions, or
explicit approval requirements take precedence.

## Compact handoff brief

Use this checklist in every delegated brief and adapt the role and labels to the task:

```text
Role: Luna routine executor; no recursive coordinator startup.
Objective / acceptance: ...
Worktree / task slug / handoff: /abs/... / ... / /abs/.../handoff.md
Target branch / base commit: ... / ...
Owned paths / forbidden paths: ... / ...
Affected systems / constraints / risks: ...
Validation and evidence: ...
Release authority: Astra; escalation triggers: ...
PR: ready for review; after push verify not draft; follow the one-review and
final-head check gates in the production runbook; PR-ready alone does not
authorize merge/migration/deploy.
Completion: return IDs, SHAs, tests, artifacts, decisions, and next step; Luna updates handoff.
```

For background on repository instructions and subagents, see the official
[AGENTS.md guidance](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
and [subagents guidance](https://learn.chatgpt.com/docs/agent-configuration/subagents).
