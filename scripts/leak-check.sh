#!/usr/bin/env bash
# Repo-wide leak grep: every tracked file must be free of private hosts,
# IPs, names and project identifiers before this tree is mirrored to a
# public remote (the deploy pipeline mirrors the whole repo, squashed).
# Terms live in .leak-terms (gitignored, local-only) so the very names this
# check hides are never committed or shipped. Without that file there is
# nothing to check, so it exits clean.
# Usage: scripts/leak-check.sh
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -f .leak-terms ]; then
  echo "leak-check: no .leak-terms (gitignored) — nothing to check, skipping"
  exit 0
fi
PAT="$(grep -vE '^\s*(#|$)' .leak-terms | sed -E 's/[[:space:]]*#.*$//' | tr '\n' '|' | sed 's/|$//')"
if [ -z "$PAT" ]; then
  echo "leak-check: .leak-terms is empty — skipping"
  exit 0
fi
# git grep scans tracked files only, so untracked runtime data (data/,
# factory-data/, the gitignored .leak-terms itself) is never matched.
# -I skips binaries (dashboard/public icons).
set +e
git grep -n -I -E "$PAT"
rc=$?
set -e
if [ "$rc" -eq 0 ]; then
  echo "LEAK CHECK FAILED: matches above"; exit 1
elif [ "$rc" -eq 1 ]; then
  echo "leak-check: clean"
else
  echo "leak-check: git grep error ($rc)"; exit "$rc"
fi
