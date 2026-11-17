#!/usr/bin/env bash
# Runs a command in a network namespace with only loopback, except on a GitHub-hosted runner. The lidge
# runners share a host whose network changes make Chromium fail every pending request with
# net::ERR_NETWORK_CHANGED (#3646); AppArmor there refuses plain unshare and allows bwrap.
# Any other runner needs a working bwrap: the command never falls back to the host network.
# Server tests stay unwrapped: their root-or-self ownership checks see host root as another user here.
set -euo pipefail
if [ "${RUNNER_ENVIRONMENT:-}" = github-hosted ]; then exec "$@"; fi
fail() {
  echo "::error::$1 on ${RUNNER_NAME:-this runner}; these tests need a loopback-only network namespace: install the bubblewrap package and let it create user namespaces (goat#3646)" >&2
  exit 1
}
command -v bwrap >/dev/null || fail "bwrap is missing"
bwrap --unshare-user --unshare-net --dev-bind / / true || fail "bwrap cannot create a user and network namespace"
exec bwrap --unshare-user --unshare-net --unshare-pid --die-with-parent --dev-bind / / --proc /proc "$@"
