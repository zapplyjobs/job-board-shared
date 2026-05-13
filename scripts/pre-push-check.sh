#!/usr/bin/env bash
# pre-push-check.sh — Validate a pending push to job-board-shared
# Usage: bash pre-push-check.sh <path_to_diff_file_or_directory>
#
# Checks the 6-point pre-push review from ZJP CLAUDE.md:
# 0. Push method gate — blocks raw Git Data API for zapplyjobs/* repos
# 1. Encrypted file check — warn if diff touches .gitattributes encrypted files
# 2. Version bump check — flag ENRICHER_VERSION changes (one per session max)
# 3. Unexpected deletion check — flag removed files
# 4. Blast radius preview — list files changed and their consumers
# 5. Diff sanity — show diff stats for review
#
# Exit code: 0 = pass, 1 = hard block (must fix before push).
# Check 0 is a hard block. Checks 1-5 are advisory warnings.

set -euo pipefail

DIFF_SOURCE="${1:-}"
REPO="${2:-zapplyjobs/job-board-shared}"
SHARED_DIR="/mnt/c/Users/Mahd/Videos/Work/Business/Job_Listings/job-board-shared"

if [ -z "$DIFF_SOURCE" ]; then
  echo "Usage: bash pre-push-check.sh <diff_file_or_dir>"
  echo "  Provide a diff file (git diff output) or the changed directory."
  exit 0
fi

echo "=== Pre-Push Check ==="
echo ""

# --- 0. Push method gate (B27 lesson) ---
# Sessions must use push-with-retry.sh for zapplyjobs/* repos.
# Raw `gh api repos/zapplyjobs/.../git/blobs|trees|commits|refs` calls are banned.
# This prevents the 50+ manual API call pattern that burned B27.
if [[ -z "${PUSH_WITH_RETRY_ACTIVE:-}" ]]; then
  echo "  ❌ BLOCKED: Not running through push-with-retry.sh"
  echo "    Raw Git Data API calls to zapplyjobs/* repos are banned."
  echo "    Use: bash projects/zjp/scripts/push-with-retry.sh <repo> <message> <tree_entries>"
  echo "    Or for the full flow: push-file.sh (if available)"
  echo ""
  echo "  To override (emergency only): PUSH_WITH_RETRY_ACTIVE=1 bash pre-push-check.sh ..."
  exit 1
fi
echo "  ✓ Push method: push-with-retry.sh (correct route)"

# --- 1. Encrypted file check ---
# Check if any changed files are in .gitattributes with filter=git-crypt
GITATTRIBUTES="$SHARED_DIR/.gitattributes"
ENCRYPTED_FILES=()
if [ -f "$GITATTRIBUTES" ]; then
  ENCRYPTED_PATTERNS=$(grep 'filter=git-crypt' "$GITATTRIBUTES" | awk '{print $1}' 2>/dev/null || echo "")
  if [ -n "$ENCRYPTED_PATTERNS" ] && [ -f "$DIFF_SOURCE" ]; then
    for pattern in $ENCRYPTED_PATTERNS; do
      if grep -q "$pattern" "$DIFF_SOURCE" 2>/dev/null; then
        ENCRYPTED_FILES+=("$pattern")
      fi
    done
  fi
fi

if [ ${#ENCRYPTED_FILES[@]} -gt 0 ]; then
  echo "  ⚠ ENCRYPTED: Diff touches encrypted file(s): ${ENCRYPTED_FILES[*]}"
  echo "    Action: Do NOT push via Git Data API — use GH Actions workflow instead."
  echo "    See ZJP CLAUDE.md 'Git Data API + Encrypted Files Rule'."
else
  echo "  ✓ Encrypted files: None in diff"
fi

# --- 2. Version bump check ---
VERSION_BUMP=0
if [ -f "$DIFF_SOURCE" ]; then
  VERSION_BUMP=$(grep -c "ENRICHER_VERSION" "$DIFF_SOURCE" 2>/dev/null | tr -d '[:space:]' || echo "0")
  [ -z "$VERSION_BUMP" ] && VERSION_BUMP=0
fi

if [ "$VERSION_BUMP" -gt 0 ] 2>/dev/null; then
  echo "  ⚠ VERSION BUMP: ENRICHER_VERSION changed (${VERSION_BUMP} occurrence(s))"
  echo "    Rule: One version bump per session max. Each triggers 4-6h re-enrichment."
else
  echo "  ✓ Version bump: None"
fi

# --- 3. Unexpected deletion check ---
DELETIONS=()
if [ -f "$DIFF_SOURCE" ]; then
  # Detect files where the +++ line is /dev/null (file fully removed)
  while IFS= read -r line; do
    DELETIONS+=("$line")
  done < <(awk '/^--- a\// {path=$0; sub(/^--- a\//, "", path); next} /^\+\+\+ b\/dev\/null/ && path {print path; path=""}' "$DIFF_SOURCE" 2>/dev/null || true)
fi

TOTAL_DELETED=${#DELETIONS[@]}
if [ "$TOTAL_DELETED" -gt 0 ]; then
  echo "  ⚠ DELETIONS: ${TOTAL_DELETED} file(s) removed"
  for f in "${DELETIONS[@]}"; do
    echo "    - $f"
  done
  echo "    Action: Verify these are intentional, not accidental."
else
  echo "  ✓ Deletions: None"
fi

# --- 4. Blast radius preview ---
CHANGED_FILES=()
if [ -d "$DIFF_SOURCE" ]; then
  # Directory provided — list all files
  while IFS= read -r f; do
    CHANGED_FILES+=("$f")
  done < <(find "$DIFF_SOURCE" -name "*.js" -o -name "*.yml" -o -name "*.json" -o -name "*.md" 2>/dev/null | head -20)
elif [ -f "$DIFF_SOURCE" ]; then
  # Diff file — extract changed file names from +++ lines
  while IFS= read -r f; do
    CHANGED_FILES+=("$f")
  done < <(awk '/^\+\+\+ b\// {sub(/^\+\+\+ b\//, ""); if ($0 !~ /dev\/null/) print}' "$DIFF_SOURCE" 2>/dev/null || true)
fi

echo ""
echo "  Files in diff: ${#CHANGED_FILES[@]}"
for f in "${CHANGED_FILES[@]}"; do
  echo "    - $(basename "$f")"
done

# Key file risk assessment
KEY_FILES=("tag-engine.js" "index.js" "senior-filter.js" "aggregator-consumer.js" "readme-generator.js" "pipeline-alert.js")
RISK_FILES=()
for kf in "${KEY_FILES[@]}"; do
  for cf in "${CHANGED_FILES[@]}"; do
    if [[ "$cf" == *"$kf"* ]]; then
      RISK_FILES+=("$kf")
    fi
  done
done

if [ ${#RISK_FILES[@]} -gt 0 ]; then
  echo ""
  echo "  ⚠ HIGH-RISK FILES: ${RISK_FILES[*]}"
  echo "    These are consumed by multiple downstream systems."
  echo "    Action: Verify blast radius with grep for consumers across all 8 repos."
fi

# --- 5. Summary ---
echo ""
echo "=== Summary ==="
if [ ${#ENCRYPTED_FILES[@]} -gt 0 ] || [ "${VERSION_BUMP:-0}" -gt 0 ] 2>/dev/null || [ "$TOTAL_DELETED" -gt 0 ] || [ ${#RISK_FILES[@]} -gt 0 ]; then
  echo "  Items require attention before push. Review warnings above."
else
  echo "  No issues detected. Safe to proceed with push."
fi
