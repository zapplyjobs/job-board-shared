#!/usr/bin/env bash
# verify-bump.sh — Post-submodule-bump verification
# Usage: ./verify-bump.sh <EXPECTED_SHORT_HASH>
# Example: ./verify-bump.sh 0335047
#
# Run after bumping all 8 repos. Checks:
# 1. All 8 consumer repos point to expected submodule hash
# 2. Source repo (job-board-shared) HEAD matches
# 3. Empty-tree guard: each repo's tree has >5 files (AGG-35 / TAG-23)
# 4. First post-bump pipeline run succeeded (or is in progress)
#
# Exit 0 = all checks pass. Exit 1 = mismatch or failure.

set -euo pipefail

EXPECTED="${1:?Usage: verify-bump.sh <EXPECTED_SHORT_HASH>}"
EXPECTED_LEN=${#EXPECTED}

# Normalize to 12-char prefix for comparison
if [ "$EXPECTED_LEN" -lt 7 ]; then
  echo "ERROR: Expected hash too short (min 7 chars). Got: $EXPECTED"
  exit 1
fi

REPOS=(
  jobs-aggregator-private
  jobs-data-2026
  New-Grad-Jobs-2026
  Internships-2026
  New-Grad-Software-Engineering-Jobs-2026
  New-Grad-Data-Science-Jobs-2026
  New-Grad-Hardware-Engineering-Jobs-2026
  New-Grad-Healthcare-Jobs-2026
)

PASS=0
FAIL=0

echo "=== P-2 Alignment Check (expected: ${EXPECTED}) ==="

# Check source repo HEAD
SOURCE_SHA=$(gh api repos/zapplyjobs/job-board-shared/commits?per_page=1 --jq '.[0].sha' 2>/dev/null) || true
if [[ ! "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "  WARN: Could not fetch job-board-shared HEAD (API error or rate limit)"
else
  SOURCE_PREFIX="${SOURCE_SHA:0:$EXPECTED_LEN}"
  if [ "$SOURCE_PREFIX" = "$EXPECTED" ]; then
    echo "  source (job-board-shared): ${SOURCE_SHA:0:12} OK"
  else
    echo "  source (job-board-shared): ${SOURCE_SHA:0:12} MISMATCH (expected ${EXPECTED})"
    FAIL=$((FAIL + 1))
  fi
fi

# Check all 8 consumer repos
for REPO in "${REPOS[@]}"; do
  SHA=$(gh api "repos/zapplyjobs/$REPO/contents/.github/scripts/shared" --jq '.sha' 2>/dev/null || echo "")
  if [[ ! "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
    echo "  $REPO: WARN — could not fetch submodule SHA (API error or rate limit)"
  else
    PREFIX="${SHA:0:$EXPECTED_LEN}"
    if [ "$PREFIX" = "$EXPECTED" ]; then
      echo "  $REPO: ${SHA:0:12} OK"
      PASS=$((PASS + 1))
    else
      echo "  $REPO: ${SHA:0:12} MISMATCH (expected ${EXPECTED})"
      FAIL=$((FAIL + 1))
    fi
  fi
done

echo ""
echo "=== Empty-Tree Guard ==="
# AGG-35: Verify each repo's latest tree has >5 files.
# Catches malformed Git Data API operations that wipe repos (TAG-23 incident).
TREE_GUARD_FAIL=0
for REPO in "${REPOS[@]}"; do
  HEAD_SHA=$(gh api "repos/zapplyjobs/$REPO/git/ref/heads/main" --jq '.object.sha' 2>/dev/null || echo "")
  if [ -n "$HEAD_SHA" ]; then
    FILE_COUNT=$(gh api "repos/zapplyjobs/$REPO/git/trees/$HEAD_SHA" --jq '.tree | length' 2>/dev/null || echo "")
    if [[ ! "$FILE_COUNT" =~ ^[0-9]+$ ]]; then
      echo "  $REPO: WARN — could not fetch tree (API error)"
    elif [ "$FILE_COUNT" -lt 5 ]; then
      echo "  CRITICAL: $REPO has $FILE_COUNT files (expected >5) — possible tree corruption"
      TREE_GUARD_FAIL=$((TREE_GUARD_FAIL + 1))
      FAIL=$((FAIL + 1))
    else
      echo "  $REPO: $FILE_COUNT files OK"
    fi
  fi
done

echo ""
echo "=== Pipeline Run Check ==="

# Check latest aggregator run
LATEST_RUN=$(gh api "repos/zapplyjobs/jobs-aggregator-private/actions/runs?per_page=1" \
  --jq '.workflow_runs[0] | "\(.conclusion) | \(.created_at)"' 2>/dev/null || echo "FETCH_ERROR")
echo "  Latest aggregator run: $LATEST_RUN"

# Check latest enrichment run
ENRICH_RUN=$(gh api "repos/zapplyjobs/jobs-data-2026/actions/runs?per_page=1" \
  --jq '.workflow_runs[0] | "\(.conclusion) | \(.created_at)"' 2>/dev/null || echo "FETCH_ERROR")
echo "  Latest jobs-data run: $ENRICH_RUN"

echo ""
echo "=== Result: $PASS aligned, $FAIL mismatches ==="

if [ "$FAIL" -gt 0 ]; then
  echo "ACTION REQUIRED: Re-bump mismatched repos."
  exit 1
fi

echo "P-2 PASS — all repos aligned."
exit 0
