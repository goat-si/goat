# EPYC v2 operator handoff

Run these commands in Bash on the operator Mac. Supply the sudo password interactively; keep it in `PW` only for this session. Do not enable shell tracing. `/tmp/goat-wp6` must exist on EPYC before copying the scripts.

```bash
set +x
set -euo pipefail
handoff=/Users/jun/Developer/new/700_projects/goat/devlog/_fin/261011_wp6-epyc-ci/handoff
ssh epyc 'mkdir -p /tmp/goat-wp6'
scp "$handoff/epyc-prepare.v2.sh" "$handoff/epyc-register.v2.sh" epyc:/tmp/goat-wp6/
read -r -s -p 'EPYC sudo password: ' PW
printf '\n'
printf '%s\n' "$PW" | ssh epyc 'sudo -S -k -p "" bash /tmp/goat-wp6/epyc-prepare.v2.sh'
```

Immediately before **each** registration, `ssh epyc 'sudo -n true'` must fail because sudo requires a password. Stop if it succeeds, or if the failure is an SSH/connection error. Each iteration fetches a fresh registration token; neither password nor token goes in a file or command argument.

```bash
for name in goat-epyc-01 goat-epyc-02; do
  if ssh epyc 'sudo -n true'; then
    printf 'Refusing registration: sudo -n true must fail\n' >&2
    exit 1
  else
    rc=$?
    if [ "$rc" -ne 1 ]; then
      printf 'Refusing registration: unexpected sudo/SSH failure\n' >&2
      exit 1
    fi
  fi
  { printf '%s\n' "$PW"; gh api -X POST repos/goat-si/goat/actions/runners/registration-token --jq .token; } |
    ssh epyc "sudo -S -k -p \"\" -u ghrunner bash /tmp/goat-wp6/epyc-register.v2.sh $name"
done
unset PW
```

Preparation refuses existing target directories and installs the audited package list. Registration refuses an existing `.runner`, validates the token, and prints `OK`/`MISSING` toolchain results using the runner's isolated HOME. A missing tool returns nonzero after registration; it does not undo registration. Service install/start and GitHub rollout gates remain separate parent-owned steps.
