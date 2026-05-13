#!/usr/bin/env bash
# hook-a-precheck.sh — Automate PE Methodology Hook A pre-checks
#
# Checks: (1) Dismissal Registry for the given module, (2) matching workflow prompt
# from zjp.json, (3) pre-push review if code changes exist.
#
# Usage:
#   hook-a-precheck.sh <module> <task_description> [--diff <path>]
#
#   module:            TAG, ENR, AGG, SUP, OUT, INF, DASH
#   task_description:  What you're about to work on (quoted string)
#   --diff <path>:     Optional path to diff file or changed directory for pre-push check
#
# Why (INF-HOOK-1): PE Methodology Hook A requires checking Dismissal Registry,
# loading matching workflow prompt, and running pre-push review. A43 audit found
# these steps were skipped (findings 4, 5, 8). Automating them makes compliance
# the default.

set -uo pipefail

MODULES_DIR="/mnt/c/Users/Mahd/Videos/Work/Business/.GenAI_Work/projects/zjp/contracts"
WORKFLOWS_FILE="/mnt/c/Users/Mahd/Videos/Work/Business/genai-dashboard/src/data/workflows/zjp.json"
SCRIPTS_DIR="$(dirname "$0")"

VALID_MODULES="TAG ENR AGG SUP OUT INF DASH"

MODULE="${1:?Usage: hook-a-precheck.sh <module> <task_description> [--diff <path>]}"
TASK_DESC="${2:?Missing task description}"
shift 2

DIFF_PATH=""
if [ "${1:-}" = "--diff" ]; then
  DIFF_PATH="${2:?--diff requires a path}"
fi

# Validate module
if ! echo "$VALID_MODULES" | grep -qw "$MODULE"; then
  echo "ERROR: Invalid module '$MODULE'. Valid: $VALID_MODULES" >&2
  exit 1
fi

echo "=========================================="
echo "  Hook A Pre-Check: $MODULE"
echo "  Task: $TASK_DESC"
echo "=========================================="
echo ""

# === 1. Dismissal Registry Check ===
echo "=== 1. Dismissal Registry ==="

CONTRACT_FILE="$MODULES_DIR/${MODULE}_CONTRACT.md"
if [ ! -f "$CONTRACT_FILE" ]; then
  echo "  No contract file found at $CONTRACT_FILE (DASH has no contract)"
else
  # Extract dismissal registry section (may be last section in file)
  REGISTRY=$(awk '/^## Dismissal Registry/{found=1} found{print}' "$CONTRACT_FILE" | head -50)

  if [ -z "$REGISTRY" ]; then
    echo "  No Dismissal Registry section found in ${MODULE}_CONTRACT.md"
  else
    # Check if task description keywords match any dismissed items
    # Extract table rows (lines starting with |)
    MATCHES=$(echo "$REGISTRY" | grep "^|" | grep -v "^| Task" | grep -v "^|---" || true)

    if [ -n "$MATCHES" ]; then
      echo "  Dismissed items in registry:"
      echo "$MATCHES" | while IFS= read -r line; do
        echo "    $line"
      done
      echo ""
      echo "  → Check if your task matches any dismissed item above."
      echo "    If YES: check the reopen trigger. If trigger fired → proceed. If not → skip."
    else
      echo "  No dismissed items found."
    fi
  fi
fi
echo ""

# === 2. Workflow Match ===
echo "=== 2. Matching Workflow ==="

if [ ! -f "$WORKFLOWS_FILE" ]; then
  echo "  WARN: $WORKFLOWS_FILE not found"
else
  # Convert task description to lowercase for matching
  TASK_LOWER=$(echo "$TASK_DESC" | tr '[:upper:]' '[:lower:]')

  # Map module to workflow keywords
  case "$MODULE" in
    TAG)  KEYWORDS="tag engine tag-engine keyword taxonomy classification" ;;
    ENR)  KEYWORDS="enrich enrich-jobs enrichment tier visa skills degree" ;;
    AGG)  KEYWORDS="aggreg fetch pipeline agg dedup tag-engine tag_stats" ;;
    SUP)  KEYWORDS="supply company fetcher ats expand custom" ;;
    OUT)  KEYWORDS="output readme consumer discord render" ;;
    INF)  KEYWORDS="infrastructure submodule bump workflow alert secret r2 ci" ;;
    DASH) KEYWORDS="dashboard chart tab theme display" ;;
  esac

  # Find matching workflows
  MATCHING=$(python3 -c "
import json, sys

with open('$WORKFLOWS_FILE') as f:
    data = json.load(f)

task = '''$TASK_LOWER'''
keywords = '$KEYWORDS'.split()
results = []

for w in data.get('workflows', []):
    wid = w.get('id', '').lower()
    wname = w.get('name', '').lower()
    prompt = w.get('workflow_prompt', '').lower()

    # Score: task keywords matching workflow id/name
    score = 0
    for kw in keywords:
        if kw in wid or kw in wname:
            score += 2
        if kw in prompt:
            score += 1

    # Also check if task words appear in workflow
    task_words = [tw for tw in task.split() if len(tw) > 3]
    for tw in task_words:
        if tw in wid or tw in wname:
            score += 3
        if tw in prompt:
            score += 1

    if score > 0:
        results.append((score, w.get('id'), w.get('name'), len(w.get('workflow_prompt', ''))))

results.sort(key=lambda x: -x[0])
for score, wid, wname, plen in results[:3]:
    print(f'{wid}|{wname}|{plen}|{score}')
" 2>&1)

  if [ -n "$MATCHING" ]; then
    echo "  Top matching workflows (ranked by relevance):"
    echo "$MATCHING" | while IFS='|' read -r wid wname plen score; do
      echo "    → $wname (id: $wid, ${plen} chars prompt, score: $score)"
    done
    echo ""
    echo "  → Load the top workflow's prompt before starting work."
    echo "    Use: python3 -c \"import json; d=json.load(open('$WORKFLOWS_FILE')); [print(w['workflow_prompt']) for w in d['workflows'] if w['id']=='WORKFLOW_ID']\""
  else
    echo "  No matching workflows found. Proceed with hooks alone."
  fi
fi
echo ""

# === 3. Pre-Push Check (optional) ===
if [ -n "$DIFF_PATH" ]; then
  echo "=== 3. Pre-Push Check ==="
  if [ -f "$SCRIPTS_DIR/pre-push-check.sh" ]; then
    bash "$SCRIPTS_DIR/pre-push-check.sh" "$DIFF_PATH" 2>&1 || true
  else
    echo "  WARN: pre-push-check.sh not found at $SCRIPTS_DIR"
  fi
  echo ""
fi

# === 4. Hook A Template ===
echo "=== 4. Hook A Template (fill in before starting) ==="
echo ""
echo "  User outcome:"
echo "  Evidence currently wrong:"
echo "  Why this change vs alternatives:"
echo "  Thinking frames:"
echo ""
echo "=========================================="
echo "  Pre-check complete. Fill in Hook A above."
echo "=========================================="
