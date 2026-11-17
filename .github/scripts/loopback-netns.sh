#!/usr/bin/env bash
# Runs a command in a network namespace with only loopback on a self-hosted runner. The lidge
# runners share a host whose network changes make Chromium fail every pending request with
# net::ERR_NETWORK_CHANGED (#3646); AppArmor there refuses plain unshare and allows bwrap.
# Without bwrap, or when bwrap is refused, the command fails: it never runs on the host network.
# Server tests stay unwrapped: their root-or-self ownership checks see host root as another user here.
set -euo pipefail
if [ "${RUNNER_ENVIRONMENT:-}" != self-hosted ]; then exec "$@"; fi
if ! command -v bwrap >/dev/null; then
  echo "::error::bwrap is missing on ${RUNNER_NAME:-this runner}; these tests need a loopback-only network namespace there" >&2
  exit 1
fi
exec bwrap --unshare-user --unshare-net --dev-bind / / --proc /proc "$@"
