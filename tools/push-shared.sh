#!/usr/bin/env bash
# push-shared.sh — Abstraction for pushing changes to job-board-shared
# Eliminates direct Claude↔git interaction for the submodule source repo.
#
# Usage:
#   ./tools/push-shared.sh "commit message" [files...]
#   ./tools/push-shared.sh "fix: normalize employment types" lib/aggregator/processors/validator.js
#
# If no files specified, stages all tracked changes (git add -u).
# Handles: staging, committing, fetch+rebase, push, conflict detection.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
COMMIT_MSG="${1:?Usage: push-shared.sh \"commit message\" [files...]}"
shift

cd "$REPO_DIR"

# Verify we're in the right repo
if [ ! -f "index.js" ] || [ ! -d "lib/aggregator" ]; then
  echo "ERROR: Not in job-board-shared repo (expected at $REPO_DIR)" >&2
  exit 1
fi

# Verify clean state or specified files
if [ $# -eq 0 ]; then
  # No files specified — stage all tracked changes
  CHANGED=$(git diff --name-only)
  if [ -z "$CHANGED" ]; then
    echo "ERROR: No tracked changes to commit" >&2
    exit 1
  fi
  echo "Staging all tracked changes: $CHANGED"
  git add -u
else
  # Stage specified files
  for f in "$@"; do
    if [ ! -f "$f" ]; then
      echo "ERROR: File not found: $f" >&2
      exit 1
    fi
    git add "$f"
  done
fi

# Commit
git commit -m "$COMMIT_MSG"
echo "Committed: $COMMIT_MSG"

# Fetch remote
echo "Fetching origin..."
git fetch origin main

# Check if remote has new commits
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [ "$LOCAL" = "$REMOTE" ]; then
  echo "Already up-to-date. Pushing..."
  git push origin main
  echo "SUCCESS: Pushed $LOCAL"
  exit 0
fi

# Rebase on conflict
echo "Remote has new commits. Rebasing..."
if git rebase origin/main; then
  echo "Rebase successful. Pushing..."
  git push origin main
  NEW_SHA=$(git rev-parse --short HEAD)
  echo "SUCCESS: Pushed $NEW_SHA (rebased on $(git rev-parse --short origin/main))"
else
  echo "CONFLICT: Rebase failed. Changes are preserved in your commit." >&2
  echo "To resolve: fix conflicts, git rebase --continue, git push origin main" >&2
  echo "To abort: git rebase --abort" >&2
  exit 1
fi
