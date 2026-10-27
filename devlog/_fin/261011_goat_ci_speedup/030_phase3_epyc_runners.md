# 030 wp3: EPYC goat runners and CI proof

## Stale check at wp3 P (2026-10-11 13:05 UTC)

Decisions `push` and `epyc-sudo` answered by the user ("do everything yourself; add many runners,
the workstation has headroom"). Deviation, recorded: during wp2 C, at user direction, the staged script
(sha256 b2dd7522...) ran once with `sudo -S` (password on ssh stdin only) for goat-epyc-03..08. All eight
units are active; GitHub lists goat-epyc-01..08 online with labels self-hosted,Linux,X64,goat,epyc; the token
file was removed by the EXIT trap; goat-epyc-05 `.env` = `HOME=/opt/actions-runner/goat-epyc-05/_home`,
dirs owned by ghrunner (755, _home 700). First CI proof: run 38141072402 (workflow_dispatch at 55822a8f2):
all 4 jobs started within 41 s on 4 runners, run 6m10s, goat-test 5m35s, ssh 160 s (17 files, 383 tests).
EPYC 1-min load during it peaked at 35.36 at 22:01:30 KST (/tmp/goat-ci/epyc-load.txt, 192 threads); per-process FD counts were not readable
as neuralarcade (not measured).

origin/dev moved to 24d4ee846 (adds devlog/_plan/* only; no overlap with packages/ssh or tsconfig.base.json).
The fork records planning units under devlog/_plan (commit 24d4ee846) and already holds the original runner
procedure (devlog/_fin/261011_wp6-epyc-ci/handoff), so no docs/operations page is added.

## Remaining wp3 work (B)

1. `git rebase origin/dev` on codex/ci-speedup (expected conflict-free; verify with `git diff 24d4ee846..HEAD --stat`
   touching only packages/ssh/src/tunnel*.ts and tsconfig.base.json plus the record below).
2. MODIFY `devlog/_fin/261011_goat_ci_speedup/{000,001,010,020,030}*.md` (origin/dev 24d4ee846 already tracks an
   earlier snapshot committed by the user) to the current text, and NEW `evidence/` with exactly this allowlist:
   add-goat-runners.sh, inventory.mjs, check.sh, ci-verify.sh, ci-test-durations.tsv, split-map.md,
   wait-analysis.md, architect-proposal.md, architect-reflection.md, audit-r1.md, review-wp1.md, review-wp2.md,
   epyc-load.txt, d6-protocol-{stop,acquisition,manager}.calls. Before commit: credential-shape scan
   (`rg -l` for token/key formats such as `gh[pousr]_[A-Za-z0-9]{20,}`, `AAAA[0-9A-Za-z+/]{20,}`, long hex/base64 runs)
   over the staged files; inspect `git diff --cached --name-only`. Commit: `docs(devlog): record goat CI speedup unit`.
3. Force-with-lease push of the rebased branch (agent-owned; rewritten by rebase), `gh workflow run goat-ci.yml --ref codex/ci-speedup`.
   After it completes, resolve the goat-test numeric job ID from the jobs API and run
   `gh run rerun <run-id> --job <job-id>` once (D8 flake observation).
4. Gate: `/tmp/goat-ci/ci-verify.sh <run-id> 1` and `/tmp/goat-ci/ci-verify.sh <run-id> 2`. The script now requires the
   given `run_attempt` (explicit if/exit, not an AND-list under set -e), reads that attempt's goat-test job log, and fails
   on any EADDRINUSE line. Verified: 38141072402 attempt 1 -> exit 0; attempt 2 -> exit 1 at the attempt check;
   38134302415 (other SHA) -> exit 1. Credential scan runs on staged blobs (`git grep --cached`). Then, immediately after `git fetch`, fast-forward `dev`
   (`git push origin codex/ci-speedup:dev`, no force) only if origin/dev still equals the rebase base.

## Runner provisioning (needs sudo; decision `epyc-sudo`)

Host: neuralarcade@192.168.0.8 via `ssh -J dlt-studio` from juns-macbook-pro. Existing pattern
(observed): /opt/actions-runner/goat-epyc-0{1,2}, owner ghrunner, unit
`actions.runner.goat-si-goat.<name>.service` (User=ghrunner, runsvc.sh), `.env` =
`HOME=/opt/actions-runner/<name>/_home\nLANG=C.UTF-8\n`, labels self-hosted,Linux,X64,goat,epyc.
Workflow asserts `$HOME = /opt/actions-runner/$RUNNER_NAME/_home` (goat-ci.yml Toolchain step).

NEW (outside repo) `~neuralarcade/goat-runner-setup/add-goat-runners.sh` (staged, sha256
b2dd7522...4d0cb7, source /tmp/goat-ci/epyc/add-goat-runners.sh). States per runner, checked before
any token is required: active -> skip; configured (`.runner` exists) but unit missing -> `svc.sh install`
then enable/start; unit installed but inactive -> `systemctl enable --now`; unconfigured -> extract
tarball (unless already extracted), `config.sh --unattended --labels goat,epyc --work _work --replace`,
then the above. `.env` is rewritten each time. The token file is deleted by an EXIT trap on
success or failure; a rerun with every runner already configured needs no token.

Token handoff (agent, right before the user's command; token never in argv or chat):

```sh
gh api -X POST repos/goat-si/goat/actions/runners/registration-token --jq .token \
  | ssh juns-macbook-pro "ssh -J dlt-studio neuralarcade@192.168.0.8 'umask 077; cat > ~/goat-runner-setup/token'"
```

Then the user runs (sudo prompts on the tty):

```sh
ssh -t juns-macbook-pro "ssh -t -J dlt-studio neuralarcade@192.168.0.8 'sudo bash ~/goat-runner-setup/add-goat-runners.sh goat-epyc-03 goat-epyc-04 goat-epyc-05 goat-epyc-06'"
```

Verify: `gh api repos/goat-si/goat/actions/runners` lists the new names online with labels goat,epyc;
`systemctl is-active` per unit.

## CI proof (decision `push`)

With approval: `git push -u origin codex/ci-speedup`, then `gh workflow run goat-ci.yml --ref codex/ci-speedup`,
then job timings via `gh api repos/goat-si/goat/actions/runs/<id>/jobs` (created/started/completed,
runner_name) and Test-step duration. Compare against run 38134302415 (goat-test 22.6 min, Test step 21.5 min).
During the goat-test job, sample on EPYC once a minute (read-only, as neuralarcade): count of
ghrunner processes, `ls /proc/<worker pid>/fd | wc -l` for vitest workers, load average, and the
vitest worker count (number of node processes whose parent is the vitest main process). Record in
/tmp/goat-ci/epyc-load.txt. Check the log for port-bind errors (`EADDRINUSE`) and rerun the job once
(`gh run rerun --job`) to observe flake behavior; both runs' pass counts go in the D summary.
Without approval: NEEDS_HUMAN; local timings stand as evidence.
