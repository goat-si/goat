# next3-T1c record (T1's thread on pen-macmini)

Branch chase/t3-261114-next3-t1c-lease-pins, cut 21:40:33 UTC from origin/chase/t3-261114-next3 = c995c5427accaaa92dadac50ec756c35f4b92034 (git rev-parse checked). Worktree: T1's existing GOAT-managed worktree /Volumes/CLIsu/goat-worktrees/goat/fix-terminal-lease-befo-82918a781fc35d19. Upstream unset, so a push can only go to the new branch name.

## Orders (verbatim)

Coordinator 2026-11-17 21:38:37 UTC, the parts for T1:

> I. #3696 MERGED; INTEGRATION HEAD c995c5427a
> - The fresh C4 review of #3696 at b7672aa5f8 was APPROVE WITH NITS (six P3, no P0 to P2; report /Users/jun/handoff-in/chase/pr3696-T1b-review-b7672aa5.md). MERGED BY ME 21:29:00 UTC, dev = 8c59f73519663bdb1fff3346d1caedf06083ddf7 (goat-ci-result success on the head, run 44173778052). goat#3694 closed with it.
> - chase/t3-261114-next3 fast-forwarded to dev 8c59f73519 (this is the one dev merge), then K10's shared pre-commit 2bc2e7761b merged by me after a line-by-line read (useComposerSend.ts:301-407 at a608046c51 equals useComposerSend.ssh.ts:54-160 byte for byte; the builder, the wrapper and the two call sites read). chase/t3-261114-next3 = c995c5427accaaa92dadac50ec756c35f4b92034 (parents 8c59f73519 and 2bc2e7761b; plain push). One wording nit for K10's own lane, no new commit on the pre-commit: the new file's doc comment says "rebuilt each render as before" while it is built per call.
> - Every lane with no code commit runs git merge --ff-only origin/chase/t3-261114-next3 before its first commit and reports the sha. K2, which is coding, keeps its plan: one merge of the integration head after K7 lands, and it does not write into useComposerSend.ts before that merge.
>
> IV. RULE 3, ONE STANDING AUTHORISATION
> Rule 3 stays: no existing test expectation changes without my word. To stop one round trip per line, my word is given in advance for the MIRRORED case only, when all three hold: (1) the upstream commit being ported changes the same assertion in upstream's own copy of that test in the same way; (2) the lane quotes both hunks, upstream's and GOAT's, before and after, in its record BEFORE the commit; (3) the commit changes no other existing expectation. The fresh review checks every one; one it cannot match to upstream's hunk is a P2. Everything else still comes to me with exact before and after: GOAT-own tests with no upstream counterpart, deleted or retitled tests, moved harnesses, and anything a lane is unsure of.
>
> V. CAPS, PLACEMENT, T1c
> - T1c, a new small branch by T1's thread on pen-macmini: chase/t3-261114-next3-t1c-lease-pins from c995c5427a, tests and one budget entry only, no production line. Content, from the #3696 review: P3-1 an idle subprocessInspector in ThreadWorkspaceService.setupLockOrder.test.ts's makeWithOptions (as Manager.leaseOrder.test.ts has), so the three setup cases stop reading the host's real ps; P3-2 the probe as a case: the holder's open starts a shell while a person's restart waits, the restart returns the setup's pid, nothing is killed, one spawn; P3-3 an overtaken request that would start a fresh shell in a worktree its thread left is refused as moved and spawns nothing; P3-5 a first attempt in a free folder starts and never calls current; P3-4 RULED: the guard at terminalLeaseOrder.ts:75 STAYS. A close is the last word to the request that was waiting; a later open by someone else was a new request and was served; the waiting request is owed only the truth about the terminal now, the terminal if one is there and "Unknown terminal" if not, and it never starts a shell that a person closed and housekeeping then removed. Same answer as dev. Two cases pin it: close then newer open then rerun returns the newer terminal; close, newer open, idle close, rerun answers Unknown terminal and spawns nothing. P3-6: code-budgets.json Manager.ts 3118 becomes 3116; the corrected wording of the exit row (true only for a request nothing overtook), the close row (it also covers GOAT's own closes: a cancelled launch and observed checks) and one Limits sentence (a setup whose thread was rebound while its open waited still runs in the old folder) go into T1c's commit message and its record; I add a comment on #3696 when T1c is in. Each new case must fail under its mutation from the review (the lane runs the mutation and records the result). I read T1c and merge it without a fresh review if it is test-only. T1c lands before K4's goat#3681 and goat#3690 commits; pen-macmini carries T1 and K4 with one heavy job at a time, then T3.

Coordinator 2026-11-17 21:43:15 UTC, part B:

> B. IV IS WIDENED, for every lane (relay it). The standing authorisation also covers, under the same three conditions (upstream's own copy changes the same way; both hunks quoted in the record before the commit; nothing else existing changes): (i) fixture, mock and helper lines in a test file or testkit, where upstream changes its own copy of that fixture or helper the same way; (ii) an existing case whose title and body become upstream's verbatim text of that same case. Still to me, with exact before and after: a deleted test or test file, a moved harness, a test with no upstream counterpart, and any case where GOAT's result differs from upstream's text by more than names. The review matches each one to upstream's hunk; a mismatch is a P2.
>
> For T1c this changes nothing: T1c adds tests and changes no existing expectation. Quote it in your record.

## Rule 3

No existing expectation, assertion or table row changed. The only existing line touched is the setupLockOrder harness's `makeWithOptions` call. It gains the idle `subprocessInspector` the coordinator ordered by name in V (P3-1), the same shape as `Manager.leaseOrder.test.ts`'s. All 9 cases of that file pass unchanged with it.

## Mutations

The review report (on the coordinator's machine) and its task thread were not readable from this host, so each mutation targets the guard its case pins. Each run touched only the source file named, ran Manager.leaseOrder and setupLockOrder (41 cases), and was restored with git checkout HEAD. Before and after: `shasum` terminalLeaseOrder.ts f8e1e04ba369…, Manager.ts 304136bfa868… (identical).

| Case | Mutation | Result |
|---|---|---|
| P3-2, a restart that waited while the holder started the same terminal | a start no longer overtakes restarts (`(by === "start" \|\| !request.restart)` → `!request.restart`) | that case fails; 1 failed / 40 passed |
| P3-3, an overtaken open that would start anew in a worktree its thread left | the moved check only on plain reruns (`run !== "first"` → `run === "rerun"`) | that case fails; 1 / 40 |
| P3-5, a first open in a free folder starts there | a first attempt reads current (`run === "first" \|\| run === "rerun"` → `run === "rerun"`) | that case and 12 others fail; 13 / 28 |
| P3-4 (i), close then a newer open gives the newer terminal | a close-overtaken rerun ignores the terminal (`if (run === "closed") return gone;`) | that case fails; 1 / 40 |
| P3-4 (ii), close, newer open, idle close gives Unknown terminal | the guard at terminalLeaseOrder.ts:75 removed (`&& request.rerunAs !== "closed"`) | that case fails; 1 / 40 |

## Corrections carried in the commit message

- Exit row: a shell exiting on its own does not overtake. The terminal stays as exited, and the rerun of a request that nothing overtook restarts it.
- Close row: a person's close of the terminal overtakes. So do GOAT's own closes that go through the same close: a cancelled launch and observed checks. The rerun returns the terminal as it is now, or not found ("closed" for an attach).
- Limit: a setup whose thread was rebound while its open waited still runs in the old folder.

## Checks

- typecheck (apps/server): 0 errors.
- Commit 259883c788: fmt and lint clean (pre-commit).
- Focused at 259883c788 (21:45:04 UTC): 6 files, 131 tests passed (Manager.leaseOrder, setupLockOrder, Manager, pullRequestSetup.lockOrder, setupTerminal, setupShell).
- check:changed origin/chase/t3-261114-next3 at 259883c788 (21:45:33–21:46:05 UTC): EXIT 0. goat-rename, format, lint, graphql, agent context budget, agent surface audit and knip passed, typecheck passed for 3 packages, and the tests passed: 2 files, 41 tests.

NOT RUN: goat-ci (not dispatched, per the order); a client pass (test-only change).

## Push

21:46:17 UTC: plain push of the new branch. git ls-remote shows refs/heads/chase/t3-261114-next3-t1c-lease-pins = 259883c788bb32d5601023932e07f879bde9af60, one commit on c995c5427a. No goat-ci dispatch.
