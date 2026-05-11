#!/usr/bin/env bash
# push-with-retry.sh — Git Data API push with automatic retry on non-fast-forward
#
# Wraps the blob → tree → commit → ref-update sequence.
# On non-fast-forward failure, re-fetches HEAD and retries up to N times.
#
# Usage:
#   push-with-retry.sh <repo> <commit_message> <tree_entries_json>
#
#   repo:             "zapplyjobs/REPO-NAME"
#   commit_message:   Quoted string
#   tree_entries_json: JSON array of tree entries, e.g.:
#     '[{"path":"file.txt","mode":"100644","type":"blob","sha":"abc123"}]'
#
# Exit codes:
#   0 — Push succeeded
#   1 — Invalid arguments
#   2 — Non-retryable failure or all retries exhausted
#
# Why (INF-RACE-1): The existing guard_pipeline_race.py hook BLOCKS all ref updates
# when any pipeline run is in_progress. With 15-min cadence, that's almost always.
# A43 was blocked 6 times. This script takes the opposite approach: attempt the push,
# and retry on the actual failure mode (non-fast-forward) instead of pre-blocking.

set -euo pipefail

# Signal to pre-push-check.sh that this is an authorized push route.
# Raw Git Data API calls outside this script are blocked by pre-push-check.sh.
export PUSH_WITH_RETRY_ACTIVE=1

MAX_RETRIES=${PUSH_RETRY_COUNT:-3}
RETRY_DELAY=${PUSH_RETRY_DELAY:-30}

REPO="${1:?Usage: push-with-retry.sh <repo> <commit_message> <tree_entries_json>}"
COMMIT_MSG="${2:?Missing commit message}"
TREE_ENTRIES="${3:?Missing tree entries JSON}"

if [[ "$REPO" != zapplyjobs/* ]]; then
  echo "ERROR: Repo must be in zapplyjobs/ org format (got: $REPO)" >&2
  exit 1
fi

# Validate tree_entries is valid JSON
if ! python3 -c "import json,sys; json.loads(sys.stdin.read())" <<< "$TREE_ENTRIES" 2>/dev/null; then
  echo "ERROR: tree_entries_json is not valid JSON" >&2
  exit 1
fi

# Run pre-push validation (encrypted files, version bumps, deletions, blast radius)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/pre-push-check.sh" ]; then
  echo "=== Pre-Push Validation ==="
  PUSH_WITH_RETRY_ACTIVE=1 bash "$SCRIPT_DIR/pre-push-check.sh" "$TREE_ENTRIES" "$REPO" || {
    echo "BLOCKED: Pre-push check failed. Fix issues above before pushing." >&2
    exit 1
  }
  echo ""
fi

# Syntax validation for JS and YAML files in the tree
# Origin: E9 (7 broken runs from literal newline in pipeline-alert.js), E45 (broken YAML)
SYNTAX_ERRORS=0
VALIDATE_TMPDIR=$(mktemp -d)
trap 'rm -rf "$VALIDATE_TMPDIR"' EXIT

while IFS= read -r entry; do
  fpath=$(echo "$entry" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['path'])" 2>/dev/null)
  sha=$(echo "$entry" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['sha'])" 2>/dev/null)
  fname=$(basename "$fpath")

  if [[ "$fpath" == *.js ]]; then
    gh api "repos/$REPO/git/blobs/$sha" --jq '.content' 2>/dev/null | base64 -d > "$VALIDATE_TMPDIR/$fname" 2>/dev/null || continue
    if ! node -c "$VALIDATE_TMPDIR/$fname" 2>/dev/null; then
      echo "  ❌ SYNTAX ERROR: $fpath (JS)" >&2
      node -c "$VALIDATE_TMPDIR/$fname" 2>&1 | head -3 | sed 's/^/     /' >&2
      SYNTAX_ERRORS=$((SYNTAX_ERRORS + 1))
    else
      echo "  ✓ Syntax OK: $fpath (JS)"
    fi
  elif [[ "$fpath" == *.yml || "$fpath" == *.yaml ]]; then
    gh api "repos/$REPO/git/blobs/$sha" --jq '.content' 2>/dev/null | base64 -d > "$VALIDATE_TMPDIR/$fname" 2>/dev/null || continue
    if ! python3 -c "import yaml; yaml.safe_load(open('$VALIDATE_TMPDIR/$fname'))" 2>/dev/null; then
      echo "  ❌ SYNTAX ERROR: $fpath (YAML)" >&2
      python3 -c "import yaml; yaml.safe_load(open('$VALIDATE_TMPDIR/$fname'))" 2>&1 | head -3 | sed 's/^/     /' >&2
      SYNTAX_ERRORS=$((SYNTAX_ERRORS + 1))
    else
      echo "  ✓ Syntax OK: $fpath (YAML)"
    fi
  fi
done < <(python3 -c "import json,sys; [print(json.dumps(e)) for e in json.loads(sys.stdin.read())]" <<< "$TREE_ENTRIES")

if [ "$SYNTAX_ERRORS" -gt 0 ]; then
  echo "BLOCKED: $SYNTAX_ERRORS syntax error(s) found. Fix before pushing." >&2
  exit 1
fi

push_attempt() {
  local attempt=$1

  echo "=== Push attempt $attempt/$MAX_RETRIES for $REPO ==="

  # 1. Fetch fresh HEAD (never cached — pipeline commits every 15 min)
  local head_sha
  head_sha=$(gh api "repos/$REPO/git/ref/heads/main" --jq '.object.sha' 2>&1) || {
    echo "ERROR: Failed to fetch HEAD — $head_sha" >&2
    return 2  # non-retryable: auth/network issue won't fix itself with retry
  }
  echo "  HEAD: ${head_sha:0:7}"

  # 2. Get base tree from current HEAD
  local base_tree
  base_tree=$(gh api "repos/$REPO/git/commits/$head_sha" --jq '.tree.sha' 2>&1) || {
    echo "ERROR: Failed to fetch tree — $base_tree" >&2
    return 2
  }

  # 3. Create tree with new entries
  local tree_payload
  tree_payload=$(python3 -c "
import json, sys
entries = json.loads('''$TREE_ENTRIES''')
print(json.dumps({'base_tree': '$base_tree', 'tree': entries}))
")

  local new_tree
  new_tree=$(gh api "repos/$REPO/git/trees" --method POST --input - <<< "$tree_payload" --jq '.sha' 2>&1) || {
    echo "ERROR: Failed to create tree — $new_tree" >&2
    return 2  # non-retryable: bad tree entries won't fix themselves
  }
  echo "  Tree: ${new_tree:0:7}"

  # 3b. Validate new tree completeness (prevents A44/D22 incomplete-tree pattern)
  local tree_file_count
  tree_file_count=$(gh api "repos/$REPO/git/trees/$new_tree?recursive=1" --jq '.tree | length' 2>/dev/null || echo "0")
  if [ "$tree_file_count" -lt 5 ]; then
    echo "BLOCKED: New tree has only $tree_file_count files (minimum 5). Aborting before commit." >&2
    echo "  This typically indicates an incomplete tree from a malformed Git Data API operation." >&2
    return 2  # non-retryable: bad tree won't fix itself
  fi

  # 4. Create commit on top of current HEAD
  local commit_payload
  commit_payload=$(python3 -c "
import json
print(json.dumps({
    'message': '''$COMMIT_MSG''',
    'tree': '$new_tree',
    'parents': ['$head_sha']
}))
")

  local commit_sha
  commit_sha=$(gh api "repos/$REPO/git/commits" --method POST --input - <<< "$commit_payload" --jq '.sha' 2>&1) || {
    echo "ERROR: Failed to create commit — $commit_sha" >&2
    return 2
  }
  echo "  Commit: ${commit_sha:0:7}"

  # 5. Update ref (this is the step that fails on non-fast-forward)
  local ref_result
  ref_result=$(gh api "repos/$REPO/git/refs/heads/main" --method PATCH \
    --input - <<< "{\"sha\":\"$commit_sha\",\"force\":false}" 2>&1)
  local ref_exit=$?

  if [ $ref_exit -eq 0 ]; then
    echo "SUCCESS: Pushed ${commit_sha:0:7} to $REPO"
    echo "  Commit: $commit_sha"
    return 0
  fi

  # Check if failure is non-fast-forward (the retryable case)
  if echo "$ref_result" | grep -qi "non-fast-forward\|not a valid parent\|update is not a fast"; then
    echo "  RETRYABLE: Non-fast-forward (HEAD moved since fetch)"
    return 1  # retryable
  fi

  # Non-retryable error (auth, permissions, etc.)
  echo "ERROR: Non-retryable ref update failure:" >&2
  echo "  $ref_result" >&2
  return 2
}

# Main retry loop — only retries on return code 1 (non-fast-forward)
for ((i=1; i<=MAX_RETRIES; i++)); do
  push_attempt "$i"
  rc=$?

  if [ $rc -eq 0 ]; then
    exit 0
  fi

  if [ $rc -eq 2 ]; then
    # Non-retryable — exit immediately
    exit 2
  fi

  # rc=1 (retryable) — sleep and retry
  if [ $i -lt $MAX_RETRIES ]; then
    echo "  Waiting ${RETRY_DELAY}s before retry..."
    sleep "$RETRY_DELAY"
  fi
done

echo "ERROR: All $MAX_RETRIES retries exhausted for $REPO" >&2
echo "  The pipeline may be actively pushing. Wait 2-3 minutes and retry manually." >&2
exit 2
