# 020 — wp2: measurement, PR, merge

## Measurement (same Mac, same moment; before = current dev, which never samples)

1. Process count: `ps -axo pid= | wc -l`.
2. ps cost: 20 runs of `/usr/bin/time -l ps -axo pid=,ppid=,pgid=,rss=,stat= >/dev/null`; report median wall, user+sys CPU,
   max RSS.
3. Parse + group cost: a bench script outside the worktree (/tmp/amg-bench.ts) imports `parseProcessTable` and the tree
   functions, feeds the real ps output plus a synthetic 100-agent forest (100 roots under a fake server pid, 10
   descendants each, two in a reparented group), runs 200 ticks, reports median and p95 ms (event-loop blocking time).
4. Per-day cost at 30 s: 2,880 ticks × (ps CPU + parse CPU). Idle server (no agents): 0 ps by construction (test 5).

## PR

- Title: `feat(server): macOS stops an agent that grows past its memory limit`; body: problem, behavior, default and
  rationale, measurements, tests, NOT RUN; ends with model and harness. Screenshots of the Settings row (before/after) via
  `node scripts/pr-assets.ts upload` for the screenshot gate.
- `goat_pull_request_link`, push, `goat_pull_request_watch`.
- Merge gate: exact-head `goat-ci-result` SUCCESS, fresh terra review PASS, `node scripts/merge-pr.ts <pr>`.
- origin.report: PR URL, merge SHA, before/after measurements, NOT RUN.

