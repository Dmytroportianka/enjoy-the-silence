#!/usr/bin/env bash
# Copy this factory's code gates into an existing repo, so the crew's
# stations verify it with the project's own gate instead of "no command".
# Detection is fluid: the script looks at what the repo already is.
# Never overwrites by default; pass --force to replace existing files.
set -euo pipefail

target="${1:-}"
force="${2:-}"
if [ -z "$target" ]; then
  echo "usage: scripts/project-gates.sh <repo> [--force]" >&2
  exit 2
fi
if [ ! -d "$target" ]; then
  echo "not a directory: $target" >&2
  exit 2
fi

here="$(cd "$(dirname "$0")/.." && pwd)"

# JavaScript: biome config is meaningful; adapt the runner to the lockfile.
is_js=0
pm="npm"
if [ -f "$target/package.json" ]; then
  is_js=1
  case "$(ls "$target")" in
    *bun.lock*|*bun.lockb*) pm="bun" ;;
    *pnpm-lock.yaml*) pm="pnpm" ;;
    *yarn.lock*) pm="yarn" ;;
  esac
fi

if [ "$is_js" = 1 ]; then
  for f in biome.json bunfig.toml PATTERNS.md; do
    if [ -e "$target/$f" ] && [ "$force" != "--force" ]; then
      echo "skip (exists): $f"
      continue
    fi
    cp "$here/$f" "$target/$f"
    echo "wrote: $f"
  done
  cat <<EOF

Add these scripts to $target/package.json (merge, do not overwrite) so the
repo states its own gate:
  "fix": "biome check --write .",
  "check": "biome check . && eslint .",
  "coverage": "bun test --coverage --coverage-reporter=text --coverage-reporter=lcov",
  "verify": "bun install --frozen-lockfile && bun run typecheck && bun run coverage && bun run check"

A station then verifies this repo with \`$pm run verify\` automatically.
Add devDependencies if missing: @biomejs/biome, typescript, eslint.
EOF
elif [ -f "$target/Cargo.toml" ]; then
  echo "Rust checkout: the canonical gate is \`cargo test\`; the factory uses it automatically."
  echo "Add \`cargo clippy -- -D warnings\` to CI for the lint half of the gate."
elif [ -f "$target/go.mod" ]; then
  echo "Go checkout: the canonical gate is \`go test ./...\`; the factory uses it automatically."
  echo "Add \`go vet ./...\` to CI for the lint half of the gate."
elif [ -f "$target/pyproject.toml" ] || [ -f "$target/requirements.txt" ]; then
  echo "Python checkout: the factory runs \`pytest\` when pytest is a dependency,"
  echo "otherwise \`python -m unittest discover\`. Add ruff/mypy in CI for the lint half."
else
  echo "Unrecognized stack in $target: no gate copied." >&2
  echo "The builder will propose a VERIFY command; the owner confirms it." >&2
  exit 0
fi

cat <<'EOF'

Suppression policy (enforced by the review station, not by this script):
every disabled lint, skipped test or type opt-out a diff ADDS must carry a
reason. scripts/suppressions.ts scans for the unexplained ones so no
reviewer has to hunt for them.
EOF
