#!/bin/bash
set -e
npm install
npm run db:migrate
# Phase 1 of the per-worker test isolation work (Task #699): rebuild
# the `leaguevault_test_template` database so any schema change pulled
# in by this merge is reflected in the template Phase 2 will clone
# per vitest worker. No-op-ish if the schema-input hash hasn't moved,
# but we run the full build here for safety because the post-pull /
# post-merge hook is the canonical "bring my dev env in sync" step.
npm run db:push:template || true
# Re-seed ~/.ssh/id_ed25519 + known_hosts so `git push` keeps working
# after a task merge (the merged container can land on a fresh box
# where ~/.ssh/ doesn't exist yet). --quiet exits 0 silently if the
# GITHUB_SSH_PRIVATE_KEY secret is not configured, so a missing-key
# setup never breaks post-merge.
bash scripts/setup-ssh.sh --quiet || true

# Snapshot pre-existing typecheck/lint/test failures into .local/known-failures.md
# so the next task can see what was already red on merge. Never block the merge
# itself if the snapshot script blows up.
bash scripts/snapshot-failures.sh --fast || true
