#!/usr/bin/env bash
# Runs on EPYC as root (sudo -S, stdin = password only). Creates both goat runner dirs; touches nothing else.
set -euo pipefail
TARBALL=/opt/actions-runner/actions-runner-linux-x64-2.337.0.tar.gz
DEBIAN_FRONTEND=noninteractive apt-get install -y -q libsecret-1-dev >/dev/null
for n in 01 02; do
  d=/opt/actions-runner/goat-epyc-$n
  if [ -e "$d/.runner" ]; then echo "$d already configured; stop"; exit 1; fi
  install -d -o ghrunner -g ghrunner -m 755 "$d"
  install -d -o ghrunner -g ghrunner -m 700 "$d/_home"
  sudo -u ghrunner tar -xzf "$TARBALL" -C "$d"
  printf 'HOME=%s\nLANG=C.UTF-8\n' "$d/_home" > "$d/.env"
  chown ghrunner:ghrunner "$d/.env"
  echo "prepared $d"
done

