#!/usr/bin/env bash
# Run as ghrunner after sudo consumes the password line; read the next line as the token.
set +x
set -euo pipefail

name=${1:-}
case "$name" in
  goat-epyc-01|goat-epyc-02) ;;
  *) printf 'bad runner name\n' >&2; exit 2 ;;
esac
cd "/opt/actions-runner/$name"
if [[ -e .runner || -L .runner ]]; then
  printf 'goat register: runner already configured; refusing\n' >&2
  exit 1
fi

# Remove any inherited export attribute; only config.sh receives the token in its environment.
unset ACTIONS_RUNNER_INPUT_TOKEN
if ! IFS= read -r ACTIONS_RUNNER_INPUT_TOKEN ||
   [[ ! "$ACTIONS_RUNNER_INPUT_TOKEN" =~ ^[A-Za-z0-9]{20,64}$ ]]; then
  unset ACTIONS_RUNNER_INPUT_TOKEN
  printf 'goat register: token line malformed; refusing\n' >&2
  exit 3
fi
rc=0
ACTIONS_RUNNER_INPUT_TOKEN="$ACTIONS_RUNNER_INPUT_TOKEN" ./config.sh \
  --unattended --url https://github.com/goat-si/goat --name "$name" \
  --labels goat,epyc --work _work || rc=$?
unset ACTIONS_RUNNER_INPUT_TOKEN
if (( rc != 0 )); then
  exit "$rc"
fi

# Read the generated HOME entry without executing .env as shell code.
runner_home=
while IFS= read -r line; do
  case "$line" in HOME=*) runner_home=${line#HOME=} ;; esac
done < .env
if [[ "$runner_home" != "/opt/actions-runner/$name/_home" ]]; then
  printf 'goat register: runner HOME missing or unexpected; refusing smoke\n' >&2
  exit 1
fi
export HOME="$runner_home"
export LANG=C.UTF-8
smoke_failed=0
for tool in cc c++ make pkg-config curl python3 node git; do
  if command -v "$tool" >/dev/null 2>&1; then
    printf 'goat smoke: OK %s\n' "$tool"
  else
    printf 'goat smoke: MISSING %s\n' "$tool"
    smoke_failed=1
  fi
done
if command -v pkg-config >/dev/null 2>&1 && pkg-config --exists libsecret-1; then
  printf 'goat smoke: OK libsecret-1\n'
else
  printf 'goat smoke: MISSING libsecret-1\n'
  smoke_failed=1
fi
exit "$smoke_failed"
