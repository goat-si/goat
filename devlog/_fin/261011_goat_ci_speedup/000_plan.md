# 000 goat CI speedup: plan

goat-ci takes 14-23 minutes per run. The EPYC runner is idle while one test file,
`packages/ssh/src/tunnel.test.ts` (325 cases, 1221 s on CI, 643 s locally), runs in a single
vitest worker, and two runners serve four matrix jobs so runs queue. This unit splits the file so
vitest runs it in parallel, removes the deterministic real waits that tests do not need, and adds
goat runners on EPYC. Developers get faster feedback; production behavior and assertions do not change.

## Loop spec

- Archetype: satisfy-spec, multi-cycle (wp0 docs-first, then wp1-wp3).
- Trigger: user request "이거 전부해봐" for the three fixes, with unlimited gpt-6-sol subagents.
- Goal: goat-test job well under the current ~22 min; queue wait removed.
- Non-goals: changing assertions, deleting/skipping tests, production timing defaults, other repos'
  runners, upstream workflows, merging to dev/main, force push, repo-wide local checks.
- Verifier: see each decade doc. Shared: `vp test run --config ../../vite.config.ts --dir . --reporter=json`
  in packages/ssh (reads every `src/*.test.ts`; exit code and JSON counts), name-inventory diff
  against /tmp/goat-ci/baseline-names.txt (325 names, captured from the unmodified file, exit 0),
  `vp run --filter @t3tools/ssh typecheck`, targeted `vp lint` on changed files, knip for the package.
- Stop condition: all criteria c-1..c-6 met, or NEEDS_HUMAN recorded for push/sudo.
- Memory artifact: this directory (uncommitted, excluded in .git/info/exclude); evidence in /tmp/goat-ci.
- Terminal outcomes: DONE; NEEDS_HUMAN (push approval or EPYC sudo missing, decisions `push`,
  `epyc-sudo` in goalplan); UNSAFE if any assertion would weaken.
- Escalation: push/merge/sudo require the user. Resource bounds: none stated; host limits apply.
  Update 2026-10-11: the user authorized push, runner provisioning with sudo, and dev integration at the
  agent's judgment; the user also forbade running tests on this Mac (verification moves to EPYC CI).
  Recording this unit under devlog/_plan follows the fork's convention (origin/dev 24d4ee846), a
  task-specific override of AGENTS.md's default against committing plans.

## Evidence

- CI per-test durations: /tmp/goat-ci/ci-test-durations.tsv (from run 38134302415, job goat-test).
- Local baseline: /tmp/tunnel-prof-base.json, 325 passed, 10:43 wall, macOS 12 cores, Node 26.5.
- Split map: /tmp/goat-ci/split-map.md. Wait analysis: /tmp/goat-ci/wait-analysis.md.
- Architect proposal: /tmp/goat-ci/architect-proposal.md.

## Architect consultation

Architect handle 01a12acf-82d8-76b1-9bab-63adc05a9c02 (Plato, gpt-6-sol), proposal D1-D8.

| ID                                      | Disposition                        | Reason                                                                                                                                                                    |
| --------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1 three private `*.fixture.ts` modules | Accept                             | Precedent `packages/provider-opencode/src/server/probeResponses.fixture.ts`; same dir keeps `./tunnel.ts` URL.                                                            |
| D2 ten files, ~160 s lane ceiling       | Accept                             | Protocol block is 1034 s; ten lanes give a ~157 s critical lane.                                                                                                          |
| D3 VITEST_MAX_WORKERS=6 for ssh         | Amend: no cap                      | Six workers over ten files means two rounds (~300 s). EPYC has 192 threads; default is availableParallelism-1. Measure first; add a cap only if load evidence demands it. |
| D4 batch nativeScripts in the byte test | Accept                             | Test-only; 16 Node spawns become 1.                                                                                                                                       |
| D5 optional builder poll arg            | Amend: test-only PATH `sleep` shim | No production surface. `runShell` already sets PATH (tunnel.test.ts:1602); `sleep` is an external command in sh/dash/bash. Same observation-count semantics.              |
| D6 defer other timeouts until measured  | Accept                             | wp2 measures stop/PID-exit loops in the critical lanes first.                                                                                                             |
| D7 keep 4-job matrix                    | Accept                             | No workflow change unless measurement shows web dominates.                                                                                                                |
| D8 isolation and load gates             | Accept                             | Each test keeps its scoped temp home; verify residue and flakes.                                                                                                          |

Reflection (same architect): round 1 MISALIGNED with 4 corrections (exports, D6 timing via
exitCode, D8 load/residue/flake gates, shim call-count proof), all folded. Round 2 MISALIGNED on
one item (trace PS4 spawning `date` inside 0.1 s loops); folded (constant PS4, untraced timing).
No remaining material gap. Full text: /tmp/goat-ci/architect-reflection.md.

## Work-phase map (dependency order)

| wp  | Doc                          | Builds on           | Closes with                                                |
| --- | ---------------------------- | ------------------- | ---------------------------------------------------------- |
| wp1 | 010_phase1_test_split.md     | baseline inventory  | identical 325-name inventory, all pass, parallel wall time |
| wp2 | 020_phase2_wait_reduction.md | split files         | same inventory, reduced durations, stop-loop measurement   |
| wp3 | 030_phase3_epyc_runners.md   | branch with wp1+wp2 | runners online, CI timings (or NEEDS_HUMAN)                |

Source-of-truth sync: no architecture doc covers test layout; AGENTS.md says not to add internal
docs for this. Nothing to patch; recorded here.
