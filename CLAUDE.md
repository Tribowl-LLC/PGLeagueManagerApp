@AGENTS.md

## Claude Code

`AGENTS.md` is the single source of durable instructions for this repository;
this file only imports it so Claude Code loads the same rules. Add or change
instructions in `AGENTS.md`, not here.

When Claude Code is the agent:

- Use `claude/<type>-<description>` branch names in place of the `codex/`
  examples.
- The GPT-6 Sol and Luna model assignments describe Codex sessions and do not
  apply.
- The delegation mechanics in `docs/agent-workflow.md` are Codex-specific and
  do not apply: the `collaboration.spawn_agent` calls, the Sol, Luna, and
  Fresh Sol roles, and the requirement to verify those models before
  delegating. Claude Code acts as the single accountable root for its task. It
  plans, owns the one branch and pull request, and reviews the result. Do not
  stop a task because those tools or models are unavailable.
- If Claude Code delegates to its own subagents, the tool-neutral rules in
  that workflow still apply: bounded briefs with explicit owned paths,
  separate worktrees or fully serialized work in a shared one, and delegated
  agents that return commits and evidence without pushing or opening pull
  requests.
- The standing authorization for the root/Sol to merge, migrate, and deploy
  does not extend to Claude Code. Merge, migration, and deployment each need
  an explicit user instruction for the task.

Every other rule in `AGENTS.md` and the documents it references applies as
written.
