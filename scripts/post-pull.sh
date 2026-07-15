#!/bin/bash
#
# scripts/post-pull.sh
#
# Reset the Replit environment cleanly after pulling external changes
# from GitHub (e.g. edits made by OpenAI Codex, a teammate, or any
# other off-Replit tool). Run this once after every `git pull` so the
# dev container's npm dependencies, dev database schema, and SSH key
# match the new commit.
#
# This is the same set of steps `scripts/post-merge.sh` runs after a
# Replit task agent merge — exposed under a different name because
# `post-merge.sh` is reserved for the platform's automatic post-merge
# hook and re-running it manually would be confusing.
#
# Usage:
#   bash scripts/post-pull.sh                # normal dev use
#   bash scripts/post-pull.sh --allow-prod   # opt-in escape hatch (see below)
#
# Idempotent: every step is a no-op if there's nothing to do, so it's
# safe to run even when the pull only touched code (no deps / schema
# changes). Exits non-zero on the first hard failure (npm install or
# checked-in migrations). Refuses to run when REPLIT_DEPLOYMENT=1 or
# NODE_ENV=production unless --allow-prod is passed, because step 2 applies
# reviewed schema changes to whatever DATABASE_URL points at.

set -e

# --- Production-DB safety rail ---------------------------------------
# `db:migrate` in step 2 applies the reviewed forward-only active migration
# history to whatever `DATABASE_URL` points at. This
# script is only intended for the Replit dev environment. Refuse to
# run if anything looks like a production deployment context unless
# the operator explicitly opts in with --allow-prod (escape hatch
# for genuine recovery scenarios).
ALLOW_PROD=0
[ "${1:-}" = "--allow-prod" ] && ALLOW_PROD=1
if [ "$ALLOW_PROD" = "0" ]; then
  if [ "${REPLIT_DEPLOYMENT:-0}" = "1" ] || [ "${NODE_ENV:-}" = "production" ]; then
    echo "ERROR: post-pull.sh refuses to run in a production-looking context." >&2
    echo "       (REPLIT_DEPLOYMENT=${REPLIT_DEPLOYMENT:-} NODE_ENV=${NODE_ENV:-})" >&2
    echo "       This script runs 'db:migrate' and must not target production." >&2
    echo "       If you really mean to do this, re-run with: bash scripts/post-pull.sh --allow-prod" >&2
    exit 2
  fi
fi

echo ""
echo "=========================================="
echo "  Post-pull reset — syncing dev env"
echo "=========================================="
echo ""

echo "[1/3] npm install — syncing dependencies from package.json…"
npm install
echo "      done."
echo ""

echo "[2/3] npm run db:migrate — applying checked-in migrations to dev DB…"
npm run db:migrate
echo "      done."
echo ""

echo "[2b/3] npm run test:template:build — rebuilding the migrated test template DB…"
# Phase 1 of per-worker test isolation (Task #699). Keeps the
# `leaguevault_test_template` DB in sync with the active migration history
# so Phase 2's per-worker `CREATE DATABASE … TEMPLATE …` clones
# inherit the latest invariants + seeded users. Non-fatal so a
# template-build hiccup doesn't block the rest of the post-pull
# reset (the next task that runs the suite will rebuild on demand).
npm run test:template:build || echo "      WARNING: template build failed; will rebuild on next test run."
echo "      done."
echo ""

echo "[3/3] setup-ssh — re-seeding GitHub SSH key (so 'git push' keeps working)…"
# Distinguish three outcomes from setup-ssh.sh --quiet:
#   exit 0 => either the key was re-seeded OR the
#             GITHUB_SSH_PRIVATE_KEY secret isn't configured (the
#             --quiet flag treats missing-secret as a silent no-op).
#             Either way the reset is healthy.
#   exit !=0 => something genuinely went wrong while writing the key
#               (corrupt PEM, permission failure, etc.). We don't
#               fail the whole reset for it — npm and db are already
#               synced — but we DO warn loudly so the operator knows
#               git push may not work until they fix it manually.
SSH_RC=0
bash scripts/setup-ssh.sh --quiet || SSH_RC=$?
if [ "$SSH_RC" = "0" ]; then
  echo "      done."
else
  echo "      WARNING: setup-ssh.sh failed (exit $SSH_RC). 'git push' over SSH" >&2
  echo "      may not work until you re-run 'bash scripts/setup-ssh.sh'" >&2
  echo "      interactively to see the underlying error." >&2
fi
echo ""

echo "=========================================="
echo "  Reset complete."
echo "=========================================="
echo ""
# Env-aware reminder. Only the *beta* Repl needs the APP_ENV / sandbox
# nag — dev runs locally without the BETA banner, and prod sets
# APP_ENV implicitly via REPLIT_DEPLOYMENT. Surfacing this on the
# wrong Repl just adds noise, so we gate the reminder on the value
# the operator actually has set right now (Task #652).
if [ "${APP_ENV:-}" = "beta" ]; then
  echo "Beta-Repl-specific reminders (APP_ENV=beta detected):"
  echo "  • Confirm payment Secrets are still SANDBOX (no SQUARE_PROD_TOKEN /"
  echo "    SQUARE_PRODUCTION_*, no sk_live_/pk_live_ keys). The server"
  echo "    refuses to start when APP_ENV=beta and a live credential is"
  echo "    present — see docs/replit-handoff.md."
  echo "  • If the pulled commit added new secrets, mirror them from prod"
  echo "    using SANDBOX values, never the live ones."
  echo ""
fi
echo "What this did NOT do (handle manually if needed):"
echo "  • Add new secrets / env vars — check the pulled commit message"
echo "    for any new secrets the code now requires, then add them in"
echo "    the Replit Secrets pane."
echo "  • Restart the 'Start application' workflow — Replit usually"
echo "    auto-restarts it, but if the app looks stale, restart it"
echo "    from the Workflows pane."
echo "  • Run the validation suite — to check the pulled changes don't"
echo "    break anything, run any of: typecheck, lint, build, test,"
echo "    csrf-coverage, org-isolation, wire-sanitization, not-found-code"
echo "    from the Workflows pane (or 'npm run check && npm test')."
echo ""
