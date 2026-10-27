#!/usr/bin/env bash
# Adds goat-si/goat self-hosted runners on EPYC, mirroring goat-epyc-01/02:
# user ghrunner, /opt/actions-runner/<name>, per-runner HOME in .env, labels goat,epyc, systemd service.
# Usage: sudo bash add-goat-runners.sh goat-epyc-03 goat-epyc-04 ...
# A registration token is needed only for runners that are not configured yet; it is read from
# $TOKEN_FILE (default ~neuralarcade/goat-runner-setup/token) and deleted on exit, success or not.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
[ "$#" -ge 1 ] || { echo "usage: sudo bash $0 <runner-name>..." >&2; exit 2; }

ROOT=/opt/actions-runner
TARBALL="$ROOT/actions-runner-linux-x64-2.337.0.tar.gz"
REPO_URL=https://github.com/goat-si/goat
TOKEN_FILE="${TOKEN_FILE:-/home/neuralarcade/goat-runner-setup/token}"
trap 'rm -f "$TOKEN_FILE"' EXIT

for name in "$@"; do
  case "$name" in goat-epyc-[0-9][0-9]) ;; *) echo "refusing unexpected name: $name" >&2; exit 2 ;; esac
done

unit_of() { printf 'actions.runner.goat-si-goat.%s.service' "$1"; }

# Decide what each runner needs before asking for a token.
need_config=()
for name in "$@"; do
  if systemctl is-active --quiet "$(unit_of "$name")"; then
    echo "$name: already active"
  elif [ ! -f "$ROOT/$name/.runner" ]; then
    need_config+=("$name")
  fi
done

TOKEN=""
if [ "${#need_config[@]}" -gt 0 ]; then
  test -f "$TARBALL" || { echo "missing $TARBALL" >&2; exit 1; }
  test -s "$TOKEN_FILE" || { echo "missing token file $TOKEN_FILE (needed for: ${need_config[*]})" >&2; exit 1; }
  TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"
fi

for name in "$@"; do
  dir="$ROOT/$name"
  unit="$(unit_of "$name")"
  systemctl is-active --quiet "$unit" && continue
  if [ ! -f "$dir/.runner" ]; then
    install -d -o ghrunner -g ghrunner -m 755 "$dir"
    [ -x "$dir/config.sh" ] || sudo -u ghrunner tar -xzf "$TARBALL" -C "$dir"
    install -d -o ghrunner -g ghrunner -m 700 "$dir/_home"
    (cd "$dir" && sudo -u ghrunner env HOME="$dir/_home" ./config.sh --unattended \
      --url "$REPO_URL" --token "$TOKEN" --name "$name" --labels goat,epyc --work _work --replace)
  fi
  install -d -o ghrunner -g ghrunner -m 700 "$dir/_home"
  printf 'HOME=%s/_home\nLANG=C.UTF-8\n' "$dir" > "$dir/.env"
  chown ghrunner:ghrunner "$dir/.env"
  if [ ! -f "/etc/systemd/system/$unit" ]; then
    (cd "$dir" && ./svc.sh install ghrunner)
  fi
  systemctl daemon-reload
  systemctl enable --now "$unit"
  systemctl is-active --quiet "$unit" && echo "$name: active"
done

systemctl list-units --type=service --no-pager 'actions.runner.goat-si-goat.*'

