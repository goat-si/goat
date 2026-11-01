#!/usr/bin/env bash
# Run as root after sudo consumes the password line. Only prepares the two goat runners.
set -euo pipefail

TARBALL=/opt/actions-runner/actions-runner-linux-x64-2.337.0.tar.gz
preflight_failed=0
if (( EUID != 0 )); then
  printf 'goat prepare: must run as root\n' >&2
  preflight_failed=1
fi
if [[ ! -f "$TARBALL" ]]; then
  printf 'goat prepare: runner tarball missing: %s\n' "$TARBALL" >&2
  preflight_failed=1
fi
if ! id ghrunner >/dev/null 2>&1; then
  printf 'goat prepare: ghrunner user missing\n' >&2
  preflight_failed=1
fi
for n in 01 02; do
  d=/opt/actions-runner/goat-epyc-$n
  if [[ -e "$d" || -L "$d" ]]; then
    printf 'goat prepare: target already exists: %s\n' "$d" >&2
    preflight_failed=1
  fi
done
if ! command -v apt-get >/dev/null 2>&1; then
  printf 'goat prepare: apt-get missing\n' >&2
  preflight_failed=1
fi
if (( preflight_failed != 0 )); then
  exit 1
fi

DEBIAN_FRONTEND=noninteractive apt-get install -y -q \
  build-essential pkg-config libsecret-1-dev curl python3 git ca-certificates
for n in 01 02; do
  d=/opt/actions-runner/goat-epyc-$n
  install -d -o ghrunner -g ghrunner -m 755 "$d"
  install -d -o ghrunner -g ghrunner -m 700 "$d/_home"
  sudo -u ghrunner tar -xzf "$TARBALL" -C "$d"
  printf 'HOME=%s\nLANG=C.UTF-8\n' "$d/_home" > "$d/.env"
  chown ghrunner:ghrunner "$d/.env"
done
for n in 01 02; do
  d=/opt/actions-runner/goat-epyc-$n
  test -d "$d/_home"
  test -f "$d/config.sh"
  test -f "$d/.env"
  printf 'goat prepare: OK %s (_home, config.sh, .env present)\n' "$d"
done
