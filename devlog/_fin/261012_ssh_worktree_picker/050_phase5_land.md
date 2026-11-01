# 050 Phase 5: land the stack into dev

Depends on: 010-040 open as a chain with goat-ci green on each head and review dispositions recorded.
Base: dev. Authority: the user authorized merging into dev (2026-10-12).

## Chain

| #   | Branch                         | PR base                        | GitHub PR                  |
| --- | ------------------------------ | ------------------------------ | -------------------------- |
| 1   | goat/ws-picker-1-local-default | dev                            | #N1 (recorded when opened) |
| 2   | goat/ws-picker-2-ssh-service   | goat/ws-picker-1-local-default | #N2                        |
| 3   | goat/ws-picker-3-ssh-ui        | goat/ws-picker-2-ssh-service   | #N3                        |
| 4   | goat/ws-picker-4-fetch-back    | goat/ws-picker-3-ssh-ui        | #N4                        |

## CI coverage (what a green goat-ci proves)

goat-ci runs check (vp check), typecheck (vpr typecheck), test (only @t3tools/ssh, @t3tools/web and
scripts/build-desktop-artifact.test.ts, .github/workflows/goat-ci.yml:65-75) and build. Server, contracts and
client-runtime behavior tests are therefore proven by the focused local runs recorded in each phase's Check
evidence, not by goat-ci. A known pre-existing local failure, apps/server/src/vcs/GitVcsDriverCore.test.ts:1968,
is reported as pre-existing and never counted.

## Procedure (DEV-STACK-08 child-first, merge commits)

1. Refresh: `git fetch origin`; for each link confirm `git merge-base --is-ancestor origin/<parent> origin/<child>`
   exits 0. If dev moved, merge `origin/dev` into PR1 and cascade PR1→PR2→PR3→PR4 with merge commits
   (no rebase of pushed heads), push, and wait for goat-ci on every new head.
2. Evidence per PR before its merge: head SHA; goat-ci run on that exact SHA (record event, run id, attempt and,
   for pull_request runs, the tested merge SHA); job conclusions success for goat-check, goat-typecheck, goat-test,
   goat-build. Cancelled or skipped is not a pass. Review disposition for the layer recorded with no open blocker.
3. Merge #N4 into its parent: `gh pr merge <#N4> --merge --match-head-commit <sha4>`. This moves #N3's head.
4. For #N3: re-read its head SHA, confirm ancestry (`git merge-base --is-ancestor <sha4> <new sha3>`), wait for
   goat-ci success on the new SHA (step 2 evidence), then `gh pr merge <#N3> --merge --match-head-commit <new sha3>`.
   Repeat the same refresh-wait-merge for #N2.
5. #N1 now contains every layer: re-read its head, wait for goat-ci success on it, then
   `gh pr merge <#N1> --merge --match-head-commit <sha1>` into dev.
6. Verify: `git fetch origin`; `git merge-base --is-ancestor <final sha of each branch> origin/dev` exits 0 for all
   four; `gh pr view <#N> -R goat-si/goat --json state,mergedAt,mergeCommit` shows MERGED for all four; goat-ci on
   the dev merge commit is not red because of this change (a red job is compared with #N1's final head result
   before any claim).
7. Keep the parent branches until every child is merged; this phase deletes no branches.

## Verifier

- `gh run list -R goat-si/goat --commit <sha> --json databaseId,conclusion,status,event,workflowName,attempt` per head,
  then `gh run view <id> -R goat-si/goat --json jobs` for job-level conclusions.
- `git merge-base --is-ancestor` per link, exit 0.
- `gh pr view <n> -R goat-si/goat --json state,mergedAt,mergeCommit`.

## Risks

- Another lane lands on dev mid-chain: step 1 repeats; conflicts resolved in PR1 and cascaded.
- goat-ci on self-hosted EPYC queues: one observer, minutes-scale polling.
