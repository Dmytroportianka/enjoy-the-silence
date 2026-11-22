#!/usr/bin/env bash
# Mirror-out: breaks the self-storing loop. Pushes every factory repo and a
# /data backup bundle to ONE external destination, so the local Gitea is the
# working origin but never the sole copy. Usage: MIRROR_REMOTE=git@host:owner/repo.git ./scripts/mirror-out.sh [/data]
set -euo pipefail
: "${MIRROR_REMOTE:?set MIRROR_REMOTE to the external mirror}"
DATA_DIR="${1:-/data}"
STAMP="$(date +%Y%m%d-%H%M%S)"
git push --mirror "$MIRROR_REMOTE"
tar -czf "/tmp/agent-factory-data-${STAMP}.tar.gz" -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")"
echo "mirrored git to $MIRROR_REMOTE; data bundle at /tmp/agent-factory-data-${STAMP}.tar.gz (copy it off this machine)"
