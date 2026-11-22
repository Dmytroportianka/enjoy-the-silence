#!/usr/bin/env bash
# Assemble the public seed from PUBLISH_MANIFEST, leak-grep it, smoke it.
# Usage: scripts/publish-public.sh <out-dir>
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:?usage: publish-public.sh <out-dir>}"
mkdir -p "$OUT"
fail=0
while IFS= read -r f; do
  case "$f" in ''|'#'*) continue;; esac
  if [ ! -f "$f" ]; then echo "manifest entry missing file: $f"; fail=1; continue; fi
  mkdir -p "$OUT/$(dirname "$f")"; cp "$f" "$OUT/$f"
done < PUBLISH_MANIFEST
# Two-sided: any tracked seed file not in the manifest fails. Tracked
# files only (git ls-files): runtime data the factory writes into a
# dogfooded checkout (data/plans, data/communication, worktrees) is
# untracked and must not fail the check.
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  SCAN_FILES="$(git ls-files -- dashboard data demo governance incus public src status template scripts server.ts package.json tsconfig.json Dockerfile README.md PUBLISH_MANIFEST template-existing-module.nix bun.lock bunfig.toml .gitignore biome.json PATTERNS.md eslint.config.ts START_WITH_MUSE.md)"
else
  SCAN_FILES="$(find dashboard data demo governance incus public src status template scripts -type f 2>/dev/null; ls server.ts package.json tsconfig.json Dockerfile README.md PUBLISH_MANIFEST template-existing-module.nix bun.lock bunfig.toml .gitignore biome.json PATTERNS.md eslint.config.ts START_WITH_MUSE.md 2>/dev/null)"
fi
while IFS= read -r f; do
  [ -n "$f" ] || continue
  grep -qx "$f" PUBLISH_MANIFEST || { echo "public file not in manifest: $f"; fail=1; }
done <<< "$SCAN_FILES"
[ "$fail" = 0 ] || exit 1
# Leak grep: repo-wide first (every tracked file), then the assembled copy.
# Terms live in .leak-terms (gitignored) so the private names never ship.
# Without that file there is nothing to check; the pipeline below must not
# run in that case (grep would exit 2 and `set -e` would abort the publish).
"$(dirname "$0")/leak-check.sh"
if [ ! -f .leak-terms ]; then
  echo "leak grep (assembled): SKIPPED (no .leak-terms)"
else
  LEAK_PAT="$(grep -vE '^\s*(#|$)' .leak-terms | sed -E 's/[[:space:]]*#.*$//' | tr '\n' '|' | sed 's/|$//')"
  if [ -z "$LEAK_PAT" ]; then
    echo "leak grep (assembled): SKIPPED (no .leak-terms)"
  elif grep -rniE "$LEAK_PAT" "$OUT"; then
    echo "LEAK GREP FAILED"; exit 1
  else
    echo "leak grep (assembled): clean"
  fi
fi
cd "$OUT" && bun install --silent && bun test && bun run typecheck
echo "publish smoke: ok -> $OUT"
