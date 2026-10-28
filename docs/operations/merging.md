# Merging pull requests

This is the merge policy for goat-si/goat. A pull request lands when its own head is green.
Rebasing every pull request onto the latest `dev` throws away green CI and starts another run each
time `dev` moves, so it is not part of merging.

## When to rebase

Do not rebase or update the branch just because `dev` moved. Rebase only when GitHub reports the
pull request as `CONFLICTING`, or when its CI can pass only with a fix that exists only on `dev`.

## Merging one pull request

Squash-merge as soon as `goat-ci-result` is `SUCCESS` on the exact head commit:

```sh
node scripts/merge-pr.ts <pr>
```

The script reads `goat-ci-result` from the newest pull request run on the head and from the newest
manual `lane=all` run, if any, and runs `gh pr merge <pr> --admin --squash --match-head-commit
<head-sha>` only when both finished and succeeded, rechecking the runs just before it merges. A
failed full run blocks until a later full run passes; ignored-event runs and partial manual lanes do
not count. `--admin` skips branch protection, so a bare `gh pr merge` lands a head whose CI failed
or is still running:
#2046 broke typecheck on `dev` that way. `--match-head-commit` makes the merge fail if someone
pushed after the check was read. `mergeStateStatus` `CLEAN` or `UNSTABLE` (behind `dev`) is fine.
Read `goat-ci-result` only; it is the one check that covers every selected task
([CI](../../structure/ci.md#when-goat-ci-runs)).

A pull request's run is quick by default: check, typecheck and the tests beside its changes. Add
the `ci:full` label, or run `gh workflow run goat-ci.yml --ref <branch>`, before merging a change
whose risk reaches past the files it touches, such as a shared contract, a dependency bump or a
workflow change. The full pass on `dev` below catches the rest.

A failure that also happens identically on `dev` does not block the merge. Once the run has
finished, `node scripts/merge-pr.ts <pr> --known-failure "<reason and dev run link>"` comments the
reason on the pull request and merges. Re-run jobs that failed from a flake or a cancellation
(`gh run rerun <run-id> --failed`) instead of rebasing.

Upstream chase merges are the exception. They land with a merge commit or a fast-forward so the
merge base with upstream moves forward ([chase rules](../../devlog/_chase/README.md)).

## Stacks

1. Retarget the next pull request first with `gh pr edit <next> --base dev`, then merge the bottom
   one into `dev` without `--delete-branch`. Deleting a base branch closes the pull requests
   stacked on it instead of retargeting them, and a closed pull request cannot be retargeted
   (#899). Delete the branch once nothing is based on it.
2. If the next head already has a successful `goat-ci-result`, merge it without rebasing.
3. Stacked pull requests often show no result, because goat-ci never ran fully on that head.
   Retargeting onto `dev` starts the pull request run that `scripts/merge-pr.ts` requires; re-run
   its failed jobs instead of rebasing. A manual run of the branch adds evidence but cannot replace
   that run.

## Merging many

Work through every green pull request one after another. Merges into `dev` start no CI on their
own, so after about every five merges run a full pass on `dev` (`gh workflow run goat-ci.yml --ref
dev`, which defaults to `lane=all`). Stop merging only if `dev` goes red, and resume once it is
green again.
