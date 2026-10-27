#!/usr/bin/env bash
# Runs as ghrunner after sudo consumed the password line; the next stdin line is the registration token.
set -euo pipefail
set +x
name=$1
case "$name" in goat-epyc-01|goat-epyc-02) ;; *) echo "bad runner name"; exit 2 ;; esac
cd "/opt/actions-runner/$name"
IFS= read -r ACTIONS_RUNNER_INPUT_TOKEN
export ACTIONS_RUNNER_INPUT_TOKEN
rc=0
./config.sh --unattended --url https://github.com/goat-si/goat --name "$name" --labels goat,epyc --work _work || rc=$?
unset ACTIONS_RUNNER_INPUT_TOKEN
exit "$rc"

