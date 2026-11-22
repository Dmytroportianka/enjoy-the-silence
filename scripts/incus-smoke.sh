#!/usr/bin/env bash
# Incus smoke: prove the wizard's output actually boots and reports.
#   generate (wizard) -> launch (run-incus.sh) -> status page -> /state ok
# Self-cleaning: the container and the temp dir are deleted on ANY exit
# (pass, fail, or interrupt) unless SMOKE_KEEP=1 is set for debugging.
# Requires on the runner: bun, incus (initialised, `images:` remote), curl,
# and network for the image pull + the in-container bun install.
# Usage: scripts/incus-smoke.sh
set -euo pipefail
cd "$(dirname "$0")/.."

command -v incus >/dev/null || { echo "smoke: incus not on PATH"; exit 2; }
command -v bun >/dev/null || { echo "smoke: bun not on PATH"; exit 2; }
command -v curl >/dev/null || { echo "smoke: curl not on PATH"; exit 2; }

NAME="enjoy-the-silence-smoke-$$"
TMPD="$(mktemp -d)"
cleanup() {
  if [ "${SMOKE_KEEP:-}" = "1" ]; then
    echo "smoke: SMOKE_KEEP=1, leaving container $NAME and $TMPD in place"
    return
  fi
  incus delete "$NAME" --force >/dev/null 2>&1 || true
  rm -rf "$TMPD"
  echo "smoke: cleaned up container $NAME and $TMPD"
}
trap cleanup EXIT

echo "smoke: generating wizard output for $NAME"
bun scripts/wizard.ts --target incus --brain muse --hostname "$NAME" --out "$TMPD/env"

echo "smoke: launching via the wizard's run-incus.sh"
(cd "$TMPD/env" && ./run-incus.sh)

echo "smoke: waiting for the container to accept exec"
for _ in $(seq 1 60); do
  incus exec "$NAME" -- true 2>/dev/null && break
  sleep 2
done
incus exec "$NAME" -- true

IP=""
for _ in $(seq 1 30); do
  IP="$(incus list "$NAME" --format csv -c 4 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
  [ -n "$IP" ] && break
  sleep 2
done
[ -n "$IP" ] || { echo "smoke: container never got an IPv4 address"; exit 1; }
echo "smoke: container up at $IP"

if incus exec "$NAME" -- test -e /etc/NIXOS; then
  echo "smoke: NixOS box: installing bun from the nixos channel (sandbox off in-container)"
  incus exec "$NAME" -- bash -c 'nix-env --option sandbox false -iA nixos.bun >/dev/null 2>&1; /root/.nix-profile/bin/bun --version'
  BUN_PATH="/root/.nix-profile/bin/bun"
  EXTRA_ENV=()
else
  echo "smoke: Debian fallback box: installing bun via bun.sh"
  incus exec "$NAME" -- bash -c 'apt-get update -qq && apt-get install -y -qq unzip curl >/dev/null && curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 && "$HOME/.bun/bin/bun" --version'
  BUN_PATH="/root/.bun/bin/bun"
  EXTRA_ENV=(--setenv=STATUS_SYSTEMCTL=/usr/bin/systemctl --setenv=STATUS_JOURNALCTL=/usr/bin/journalctl --setenv=STATUS_PS=/usr/bin/ps --setenv=STATUS_SS=/usr/bin/ss --setenv=STATUS_DF=/usr/bin/df)
fi

# The status app must land at the documented /root/status/server.ts;
# a nested status/status layout is a wizard bug, not something to tolerate.
SERVER="/root/status/server.ts"
if ! incus exec "$NAME" -- test -f "$SERVER"; then
  FOUND="$(incus exec "$NAME" -- bash -c 'find /root/status -name server.ts 2>/dev/null | head -1' || true)"
  echo "smoke: status app not at documented $SERVER (found: ${FOUND:-none})"
  exit 1
fi

echo "smoke: starting the status page on :8123"
incus exec "$NAME" -- systemd-run --unit=agent-factory-status \
  --setenv=STATUS_BIND=0.0.0.0 --setenv=STATUS_PORT=8123 \
  --setenv=FACTORY_DATA=/data \
  "${EXTRA_ENV[@]}" \
  "$BUN_PATH" "$SERVER"

# Host-side check address: direct on Debian; on NixOS the stock image
# firewall drops :8123 (the applied config would open it), so forward a
# host loopback port into the container instead.
CHECK_URL="http://$IP:8123"
if incus exec "$NAME" -- test -e /etc/NIXOS; then
  incus config device add "$NAME" smokeproxy proxy listen=tcp:127.0.0.1:18123 connect=tcp:127.0.0.1:8123
  CHECK_URL="http://127.0.0.1:18123"
fi

echo "smoke: waiting for the metrics page from the host network"
STATE=""
for _ in $(seq 1 30); do
  STATE="$(curl -fsS "$CHECK_URL/state" 2>/dev/null || true)"
  [ -n "$STATE" ] && break
  sleep 2
done
[ -n "$STATE" ] || { echo "smoke: /state never answered on $CHECK_URL"; exit 1; }

curl -fsS "$CHECK_URL/" | grep -q "Factory status" || { echo "smoke: / did not render the status page"; exit 1; }
echo "$STATE" | grep -q '"ok":true' || { echo "smoke: /state not ok: $STATE"; exit 1; }
# Identity comes from reaching this container's endpoint (its incus IP, or
# the proxy device attached to it) — not from the reported hostname, which
# is just "nixos" on the stock image until the generated config is applied.
echo "$STATE" | grep -qE '"hostname":"[^"]+"' || { echo "smoke: /state reports no hostname: $STATE"; exit 1; }
echo "$STATE" | grep -q '0.0.0.0:8123' || { echo "smoke: /state does not list the status port: $STATE"; exit 1; }
echo "$STATE" | grep -q '"failures":\[\]' || { echo "smoke: /state reports failures: $STATE"; exit 1; }

echo "smoke: PASS wizard output boots in incus and the metrics page reports ok ($CHECK_URL)"
