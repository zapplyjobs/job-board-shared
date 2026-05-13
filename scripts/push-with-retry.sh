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

  # 2b. Preprocess nested paths — Git Data API replaces entire subtrees when
  # given a nested path (e.g., scripts/foo.sh) against base_tree.
  # Fix: for each entry with / in path, fetch the current subtree, merge the
  # entry in, construct a new subtree, and emit a tree-type entry instead.
  # Origin: A45 (99 files lost), C48 (99 files lost), E58 (1 file lost).
  local processed_entries
  processed_entries=$(python3 -c "
import json, subprocess, sys

entries = json.loads('''$TREE_ENTRIES''')
repo = '$REPO'
base_tree = '$base_tree'
result_entries = []

# Group nested entries by parent directory
subtree_updates = {}  # dirname -> [entries]
flat_entries = []

for e in entries:
    if '/' in e.get('path', ''):
        dirname = e['path'].rsplit('/', 1)[0]
        basename = e['path'].rsplit('/', 1)[1]
        if dirname not in subtree_updates:
            subtree_updates[dirname] = []
        # Store with basename only for subtree construction
        sub_entry = dict(e)
        sub_entry['path'] = basename
        subtree_updates[dirname].append(sub_entry)
    else:
        flat_entries.append(e)

# For each directory with updates, fetch current subtree and merge
for dirname, new_entries in subtree_updates.items():
    # Find the subtree SHA in base tree
    try:
        tree_result = subprocess.run(
            ['gh', 'api', f'repos/{repo}/git/trees/{base_tree}?recursive=1',
             '--jq', f'[.tree[] | select(.path == \"{dirname}\") | .sha][0]'],
            capture_output=True, text=True, timeout=30
        )
        subtree_sha = tree_result.stdout.strip().strip('\"')
        if not subtree_sha or len(subtree_sha) < 10:
            # Subdir doesn't exist yet — just pass through, base_tree will create it
            for ne in new_entries:
                ne['path'] = f'{dirname}/{ne[\"path\"]}'
                flat_entries.append(ne)
            continue

        # Get current subtree entries
        sub_result = subprocess.run(
            ['gh', 'api', f'repos/{repo}/git/trees/{subtree_sha}'],
            capture_output=True, text=True, timeout=30
        )
        current_entries = json.loads(sub_result.stdout)['tree']

        # Build merged subtree: start with current, update/add new entries
        merged = {}
        for ce in current_entries:
            merged[ce['path']] = {'path': ce['path'], 'mode': ce['mode'],
                                  'type': ce['type'], 'sha': ce['sha']}
        for ne in new_entries:
            merged[ne['path']] = {'path': ne['path'], 'mode': ne.get('mode', '100644'),
                                  'type': ne.get('type', 'blob'), 'sha': ne['sha']}

        # Create new subtree
        merged_list = list(merged.values())
        create_result = subprocess.run(
            ['gh', 'api', f'repos/{repo}/git/trees', '--method', 'POST', '--input', '-'],
            input=json.dumps({'tree': merged_list}),
            capture_output=True, text=True, timeout=30
        )
        new_subtree_sha = json.loads(create_result.stdout)['sha']
        new_count = len(merged_list)

        print(f'  Subtree fix: {dirname}/ reconstructed with {new_count} files', file=sys.stderr)

        # Emit tree-type entry for the directory
        flat_entries.append({
            'path': dirname,
            'mode': '040000',
            'type': 'tree',
            'sha': new_subtree_sha
        })
    except Exception as ex:
        print(f'  WARNING: subtree fix failed for {dirname}: {ex}', file=sys.stderr)
        # Fall through — the ratio check will catch any file loss
        for ne in new_entries:
            ne['path'] = f'{dirname}/{ne[\"path\"]}'
            flat_entries.append(ne)

print(json.dumps(flat_entries))
" 2>&1)
  # Extract just the JSON line (stderr has log messages)
  processed_entries=$(echo "$processed_entries" | grep -v "^  " || echo "$processed_entries")

  # 3. Create tree with processed entries
  local tree_payload
  tree_payload=$(python3 -c "
import json, sys
entries = json.loads('''$processed_entries''')
print(json.dumps({'base_tree': '$base_tree', 'tree': entries}))
")

  local new_tree
  new_tree=$(gh api "repos/$REPO/git/trees" --method POST --input - <<< "$tree_payload" --jq '.sha' 2>&1) || {
    echo "ERROR: Failed to create tree — $new_tree" >&2
    return 2  # non-retryable: bad tree entries won't fix themselves
  }
  echo "  Tree: ${new_tree:0:7}"

  # 3b. Validate new tree completeness (prevents A44/C48 incomplete-tree pattern)
  # Ratio-based: new tree must be ≥80% of base tree file count.
  # A45 incident: 39/139 files (28%) — absolute threshold of 5 missed it.
  local tree_file_count base_file_count
  tree_file_count=$(gh api "repos/$REPO/git/trees/$new_tree?recursive=1" --jq '.tree | length' 2>/dev/null || echo "0")
  base_file_count=$(gh api "repos/$REPO/git/trees/$base_tree?recursive=1" --jq '.tree | length' 2>/dev/null || echo "0")
  if [ "$base_file_count" -gt 0 ]; then
    local ratio
    ratio=$((tree_file_count * 100 / base_file_count))
    if [ "$ratio" -lt 80 ]; then
      echo "BLOCKED: New tree has $tree_file_count/$base_file_count files (${ratio}%). Minimum 80%." >&2
      echo "  This typically indicates an incomplete tree from a malformed Git Data API operation." >&2
      return 2  # non-retryable: bad tree won't fix itself
    fi
  elif [ "$tree_file_count" -lt 5 ]; then
    # Fallback for edge case where base tree query fails
    echo "BLOCKED: New tree has only $tree_file_count files (minimum 5). Aborting before commit." >&2
    return 2
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
