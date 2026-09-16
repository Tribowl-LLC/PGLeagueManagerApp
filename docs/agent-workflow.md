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
| Fresh Astra | Short-context bounded blocker resolver or independent final reviewer. It must inspect the relevant diff, code, and tests rather than relying on a summary. |

The root remains accountable even while Luna executes. Root may relay short
milestones and must not claim work continues autonomously after the session
ends. Root stays lightweight and does not repeatedly read raw logs or redo
Luna's assigned work. A reviewer does not become a second writer: use read-only
review unless an explicit unblocker brief grants file ownership, and pause the
overlapping writer while that unblocker edits.

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
(for example, `payment_retry_audit`). Use the current collaboration tool shape;
adapt the task name and paths to the harness:

```js
await collaboration.spawn_agent({
  task_name: "luna_<task_slug>",
  model: "gpt-5.6-luna",
  reasoning_effort: "xhigh",
  fork_turns: "none",
  message: `Role: Luna routine executor; do not bootstrap another coordinator.
Objective: <outcome and acceptance criteria>
Worktree: /absolute/path/to/worktree
Handoff: /absolute/path/to/worktree/.local/agent-tasks/<task-slug>/handoff.md
Owned paths: <files or directories>
Constraints: <invariants and out-of-scope paths>
Validation: <commands and required evidence>
PR: ready for review; after pushing verify it is not a draft; no merge/deploy
without explicit user authorization.
Escalate: <triggers and how to pause safely>`
});
```

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

Record the task and agent IDs, target branch, base commit, current `HEAD`,
reviewed commit, test commit, changed paths, test/check commands and results,
artifact paths, decisions, authority, risks, and the next step. Preserve local
evidence paths and add shared/portable artifact references when available. If a
check ran before a commit, record clean/dirty status plus status/diff evidence;
a SHA alone does not identify a dirty tested worktree. Update state at
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
root launches it as a bounded fallback. Use `model: "gpt-6-astra"`,
`reasoning_effort: "medium"`, and `fork_turns: "none"`, with explicit paths and
acceptance criteria. The resolver is read-only unless its brief explicitly
assigns a disjoint unblocker file set; pause Luna if ownership overlaps.

```js
await collaboration.spawn_agent({ task_name: "astra_review_<task_slug>", model: "gpt-6-astra", reasoning_effort: "medium", fork_turns: "none",
  message: `Role: Astra reviewer/resolver; read-only; no recursive coordinator startup.
Worktree: /absolute/path/to/worktree
Base commit / head commit: <base SHA> / <head SHA>
Dirty diff evidence if applicable: <absolute artifact path>
Question/review goal: <bounded blocker or independent diff+code+tests review>
Evidence: findings with severity, file/line, commands, commit IDs, and dirty-diff state.
PR: ready for review; after push verify not draft; no merge/deploy without user authorization.` });
```

## 5. Independent final review

After Luna reports completion, Astra directs one fresh Astra final reviewer;
Luna may launch it when child spawning is supported, otherwise root launches
it. Use `model: "gpt-6-astra"`, `reasoning_effort: "medium"`, and
`fork_turns: "none"`. The reviewer independently inspects the diff, relevant
code, and tests, and reports findings by severity with evidence. It must not
review the summary alone and is read-only by default.

Luna fixes accepted findings, then runs focused follow-up checks for the
affected scope. Run a new full review only when the fix introduces substantial
new risk. Do not create automatic endless re-reviews. The reviewer returns
commit IDs and evidence; Luna records them in the handoff. Astra decides
whether the result is ready for release; reviewer readiness is not user merge
or deploy authorization.

## Completion and pull requests

The completion report states changed files, validation results, skipped or
blocked checks, database and deployment implications, security or provider
implications, manual verification, remaining risks, and branch/PR status.
Include completion and cost metrics when the harness provides them; never
invent costs or claim unavailable telemetry.

Create pull requests ready for review unless the user explicitly requests a
draft. After pushing, verify the PR is not a draft and mark it ready when
needed. Ready-for-review status does not authorize merging. Merge or deploy
requires explicit task-scoped authorization; unrelated earlier authorization
does not carry over.

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
PR: ready for review; after push verify not draft; merge/deploy needs explicit user authorization.
Completion: return IDs, SHAs, tests, artifacts, decisions, and next step; Luna updates handoff.
```

For background on repository instructions and subagents, see the official
[AGENTS.md guidance](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
and [subagents guidance](https://learn.chatgpt.com/docs/agent-configuration/subagents).
