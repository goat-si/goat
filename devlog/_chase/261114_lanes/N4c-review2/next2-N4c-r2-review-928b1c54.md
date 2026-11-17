APPROVE WITH NITS 928b1c54854c3cef75853c7823eb8deaa068c271

The round 1 blocker is fixed. Every setup-shell case now passes twice on this busy Mac, and the earlier-run case depends on the new restart rule rather than on `ps` or `closeIdle`. The banner refresh is now proven at the hook, and the test fails first on both earlier versions. I found one new P3: the known limit the author kept for item 3 is wider than "setup runs twice". A probe shows that a sync restore can fail and remove the folder it just restored. Nothing is P2 or above.

The head was 928b1c5485 by `git ls-remote` at the start (01:53 KST) and at the end (02:11 KST). During the review, `origin/chase/t3-261114-next2` moved from d12958d037 to 23d3a4696e.

**Findings**

**P3: an earlier setup run that has not typed yet can close the restored shell, so a sync restore fails and removes the folder again**

- **Where:**
  - `ProjectSetupScriptRunner.ts:349-356`: the readiness reset carries the earlier run into the restored shell.
  - `ProjectSetupScriptRunner.ts:586-611`: each run types from its own forked writer once its own readiness fires.
  - `ProjectSetupScriptRunner.ts:613-619`: an exit 0 calls `closeIdle` on the setup terminal.
  - `restoreThreadWorkspace.ts:152-160` and `:187`: no exit code becomes `setup-failed`, and the folder is discarded unless the restore was resumed.
- **Trigger:** all of these hold together:
  - The setup script is sync (`async: false`).
  - An earlier run on the setup terminal has not typed its command yet. This is the author's named trigger: an unanswered rc-file prompt.
  - The folder goes away, and a restore restarts the terminal.

  The earlier run becomes ready first and types. Its command exits 0, and its `closeIdle` finds the shell idle, because the restore's own run has not typed yet. In a real shell, the earlier command has to finish before the restore's run writes. That is the usual case for shells with no line-editor signal, such as bash 3.2 or 4.x and dash. There, each run waits for its own 3-second quiet window, and the earlier command's output keeps resetting the restore run's window. With zsh, fish or bash 5.1+, both runs see the same prompt and type back to back, which gives the stated double run instead.
- **Consequence:** the restore the person asked for fails with "Setup script … exited with no exit code". For a restore that was not resumed, the folder it just recreated is removed again. A retry works, because the earlier run has ended by then. In the double-run case, the earlier run's `onOutputLine` also receives the restore run's lines, including its sentinel line, so they show up in the launch log and tail. The output filter only skips the run's own sentinel (`:258-275`).
- **Smallest fix:** the narrower rule from item 3. A fresh-shell run supersedes earlier runs of the same terminal that have not typed yet:
  - The runner bumps a counter for the terminal before it restarts it.
  - A writer whose counter is stale abandons its run: it settles null and writes nothing.
  - A person's restart bumps nothing, so `ProjectSetupScriptRunner.test.ts:204` keeps passing.

  The other option is to widen the stated limit so it names this outcome.
- **Basis:** RAN scratch probe B (`probes/ThreadWorkspaceService.n4cProbe.final.test.ts`) at the head and again with the parent's runner. The fake shell kept the first PTY busy and never showed it a prompt. Both runs gave the same result:
  - Events were `["silent 0","prompt 1","command 1"]`: only the earlier run's command was typed.
  - The earlier run settled 0, and `closedIdle` was `["setup-setup"]`.
  - Both PTYs were killed.
  - The restore failed with `setup-failed: Setup script "Setup" exited with no exit code.`, and the folder was gone.

  The fake shell runs commands instantly, so the timing in real shells is INFERRED from the readiness code. The behaviour comes from the restart added in 300b9f3f09, not from the round 2 commits.

**What checks out**

1. **P2-1 is closed.**
   - RAN the setup-shell test twice on this Mac, which has 2,887 processes and a `ps` output of 599,844 bytes (above the 524,288 cap). Both runs passed 7 of 7, in 12.8 s and 8.6 s.
   - The fixture stubs the process table (`setupShell.test.ts:117-118`), so no case depends on `ps`.
   - No case depends on wall-clock time: the test waits on Deferred gates, and `it.live` is used only because git runs.
   - The earlier-run case does not rely on the new shell's `closeIdle`. Its restore is async, so nobody runs the new run's completion, and it asserts that the new shell stays alive (`:357`). Its null comes from the restart rule at `:301-305`, and 2d shows that.
2. **Restart handling (item 2).**
   - **(a)** An earlier run that has not typed is not ended by the restart. Its readiness resets (`:352-356`), it types into the new shell, and it settles with that command's own exit code, which was 0 in probe B. If that shell exits or closes first, it settles null. It does not hang. `ThreadLaunchService.ts:819-842` then shows the stage as done or failed by that exit code.
     - There is one negligible window: `written` is set only after `write` returns (`:594-600`). A restart that lands between those two steps would leave the run waiting for a sentinel that went into the killed shell. The restart needs the thread lock that the write just released, so this is unlikely. INFERRED.
   - **(b)** The fresh run never sees its own restart. `publishEvent` calls listeners synchronously inside the restart (`Manager.ts:962-968`, `:1868-1876`), and the runner subscribes only after `restart` returns (`:489-530`). RAN: the four sync cases and the resume case pass with exit 0 from the fresh run.
     - A person's restart during a sync restore waits for the folder lease the restore holds (`terminalWorkspaceRpc.ts:34-35`, `ThreadWorkspaceService.ts:196`, `:395`).
     - If it was already waiting before the runner's restart, it is overtaken and returns the current terminal without restarting again. RAN: lock probe, pid 9000, one spawn.
     - During an async restore, a person's restart can land mid-run:
       - If the fresh run had typed, it settles null and nothing reads that.
       - If it had not, it carries on into the person's new shell, which is the reason the reset exists. That is reasonable.
   - **(c)** What each consumer shows when a restart ends an observed run. READ.
     - **Person's restart:**

       | Consumer | What it shows now |
       | --- | --- |
       | Tracked async launch | The setup stage is "failed", "exited with no exit code" (`ThreadLaunchService.ts:820-842`), then the launch finishes (`:874-875`). Before, the stage kept running and collected the new shell's output. |
       | Sync launch | Fails at once with "Setup script exited with no exit code". |
       | Observed check | Completes with exit code null instead of waiting for its timeout (`ObservedCheckService.ts:217-235`). |
       | Settlement | Ignored (`ThreadSettlementService.ts:792-801`). |

     - **Agent:** cannot restart setup, check or settle terminals. Only the opener may mutate a terminal (`AgentTerminalState.ts:252-262`), and the runner opens these with no owner.
     - **#3682 reruns:** a busy attempt starts nothing, and an overtaken rerun restarts nothing (`terminalLeaseOrder.ts:76-99`, `Manager.ts:2355-2364`). So each restart publishes one `restarted`.
       - An open that relaunches because the launch context changed publishes `started` (`Manager.ts:2294-2335`), and the completion watcher still ignores that. This existed before the lane.
   - **(d)** RAN with 29d6c145fd's runner swapped in. The earlier-run case times out: 20 s under `--testTimeout=20000`, where the author saw 120 s at the default. The other six cases pass. Probe A shows why:
     - At the parent, the earlier run does not settle within 5 s, and its lines include the new shell's output and the restore run's sentinel line `__GOAT_SETUP_DONE___<tok>:0`.
     - At the head, it settles null, gets no lines, and the new shell stays open.
3. **Item 3.**
   - `ProjectSetupScriptRunner.test.ts:204-215` does need the write: after the `restarted` event it takes a write from the queue (`:213`). Resetting the busy flag alone would leave it hanging.
   - A narrower rule was possible without touching that test, and probe B shows it is worth doing (see the P3).
   - `closeIdle` re-checks for a child process and an unchanged activity mark before it closes (`Manager.ts:3005-3019`). The POSIX wrapper runs the command in a subshell (`ProjectSetupScriptRunner.ts:214`). So a shell in the middle of a command is not closed.
   - The close that can happen is the one before the restore's run types, and a working `ps` would not prevent it either.
   - The empty process table does not hide a tested path. No case models a busy shell, and the stub makes the "new shell not killed" assertion stricter.
4. **Item 4 is unchanged.** RAN: `restoreThreadWorkspace.ts` has no diff between 4fa20e693f and 928b1c5485, and every restore still passes `freshShell: true` (`:148-149`).
5. **Banner refresh (item 5).**
   - `skipFirst` is optional and defaults to false (`useWorkspaceMutationRefresh.ts:15-18`, `:25-27`). `ChatView.tsx:1702` and `FileBrowserPanel.tsx:499` don't pass it, so they behave as before.
   - **Requests:** both hook instances read one family atom (`client-runtime/src/state/runtime.ts:588`). A refresh of an observed atom interrupts the running fetch and rebuilds right away (`AtomRegistry.js:260-266`, `:673-695`), and `runFork` starts evaluating synchronously (`internal/effect.js:2536-2538`). So one item change starts two fetches in one commit, and the second interrupts the first after the first reached its first async step. I did not trace it to the socket write. INFERRED: the server sees the first request and then its interrupt, which costs one extra status read per item change while the banner shows. That is acceptable.
   - There is no refresh loop, and nothing runs while the worktree is healthy (`useThreadWorkspaceStatus.ts:36-46`). One nit: the baseline is not reset when the worktree turns healthy. If it goes missing again in the same mount after items were added, it refreshes once.
   - **Test:**
     - RAN at the head: 1 passed.
     - RAN failing first: with 4fa20e693f's hook it fails at `:47` ("expected 1 times, got 2"), and with d12958d037's hook at `:54` ("expected 2 times, got 1").
     - It follows the repository's browser-test rules: `await using render`, `expect.element`, a fresh element on every rerender, `vi.hoisted` state reset by `setup()`, no lifecycle hooks and no frame waits.
     - The direct imports of the mocked modules pull in no Shiki or diff workers. I read direct imports only.
   - **Effect budget:** `useWorkspaceMutationRefresh.ts` has one effect against its budget of 1 (`scripts/effect-budget.json:507`). `useThreadWorkspaceStatus.ts` has none, and the diff adds no effect.
6. **Restart size (item 6): the author's deviation is right.** READ.
   - `TerminalRestartInput` requires `cols` and `rows` (`packages/contracts/src/terminal.ts:170-179`), and the in-process restart takes that same type (`Manager.ts:256-258`, `:2839-2845`). The `input.cols ?? session.cols` at `:2903` is a fallback that can never run: there is no internal type with an optional size, and the service has no way to read a live session's size.
   - After the restart spawns the shell at 120x30, the runner's open applies the attached viewers' size before the command is typed (`Manager.ts:2209`, `:1069-1077`, `:2339-2342`). Only the new shell's startup prints at 120 columns, and with no viewer attached the size stays 120x30, the same as a first open. Round 1's statement holds, and this is not a finding.
7. **Item 7.**
   - RAN the named test set: 31 files, 303 tests passed in 58 s.
   - RAN: the merge commit's tree equals `git merge-tree`'s (2eb06e8331), with parents 4fa20e693f and d12958d037.
   - The restart runs in the marked restore fiber, so it re-enters the held lease on its first try (`workspaceLease.ts:205-217`, `:283-292`, keyed by canonical path) and never waits.
   - RAN a lock-order probe with a gate before the runner's restart:
     - The restore succeeded with one spawn.
     - A person's open, restart or attach of the setup terminal that was already waiting was overtaken and got the restarted shell's snapshot (pid 9000, running).
     - A person's request on another terminal is already covered by the existing lock-order test, which passed: it reruns after the restore and starts in the restored folder.
   - The moved-worktree check applies only to reruns (`Manager.ts:2347-2353`). The runner's restart is a first attempt, and its path is the thread's own worktree, which `refuseMovedWorktree` accepts anyway (`TerminalThreadWorktree.ts:64-65`). N4c's restart needs no exemption today, and Start in a new worktree does not pass `freshShell` (`ThreadWorkspaceService.ts:292-299`).
8. **Repository rules (item 8).**
   - RAN `git diff`: six files changed. Both test files are new, and `ProjectSetupScriptRunner.test.ts` is untouched. `useThreadWorkspaceStatus.test.ts` has no net change against d12958d037: 4fa20e693f added a helper test and 46103ce2c9 removed it.
   - The new tests use no sleeps, polling, per-test timeouts or retries.
   - The diff adds no non-null assertions and no `any` casts, and every new comment is four lines or fewer.
   - None of the six files is listed in `code-budgets.json`, and all are under 800 lines; the largest has 638.
   - `tsc --noEmit` for apps/server exited 0 with no errors. I ran it twice because my wrapper lost the first exit code; both logs have zero errors.

**Outside this lane (not findings against N4c)**

- **#3682:** a person's open or restart of the setup terminal that waited through a restore fails with "Unknown terminal … setup-setup" if the setup exits 0 and `closeIdle` removes the session before the overtaken rerun reads it (`Manager.ts:2355-2364`).
  - RAN with an empty process table, and the pre-lane runner gives the same result; there, attach also gets `closed`.
  - With N4c, attach gets the snapshot instead, because the session exists earlier.
- **This Mac:** in production `closeIdle` never closes anything here, because `ps` output (599,844 bytes) is above the cap.

**Merge state** (RAN `git merge-tree`)

- **`origin/chase/t3-261114-next2`:** it was d12958d037 at the start, which the branch contains. At the end it was 23d3a4696e, the sf1b head. 928b1c5485 merges into that cleanly (tree 9b25f5cce8), with no file changed on both sides.
- **`origin/chase/t3-261114-next2-sf1b-followups` (23d3a4696e):** clean, as above.
- **`origin/chase/t3-261114-next2-n14-web` (2a94ed4deb):** conflicts in `useComposerSend.ts` and `oxlint-plugin-goat/code-budgets.json`. The same two conflicts appear when merging d12958d037 alone into n14, so they come from the integration head. N4c's files don't overlap n14's.

**The author's claims**

- **Confirmed by my runs:**
  - The `processTable` stub is in place, and all 7 cases pass twice on this busy Mac.
  - The earlier-run case fails first, by timing out, with the parent's runner.
  - The earlier run settles null on `restarted` once its command was written, and it ignores the new shell's output.
  - The reason for keeping the readiness reset holds.
  - The browser test passes and fails first on both earlier hooks.
  - Both hook instances share one atom and make two refresh calls.
  - The restart contract requires cols and rows.
  - The merge is clean, and its tree is `merge-tree`'s.
  - The named set runs 31 files and 303 tests.
- **Qualified:** "at most one request in flight" is true on the client, but the server probably sees two requests (INFERRED). The item 3 limit understates the risk (the P3).
- **Resting on the author:** `check:changed` exited 0 with 2,619 tests.
- **CI:** run 44130588315 (`workflow_dispatch`, lane quick) completed with success on 928b1c5485. `goat-check`, `goat-typecheck` and `goat-ci-result` passed, and no test shard ran. READ via `gh`.

**Housekeeping:** the scratch folder is `/tmp/n4c-review-928b1c54`.

- `tree/` is a `git archive` of the head, with node_modules APFS-cloned from `/tmp/coord-devmerge-ab33cd88`. The lockfile blob is 6d068a2943 at both commits and in the source install.
- Every file I swapped is back and byte-identical to the head (checked with `cmp`).
- `probes/` holds the two probe test files (moved out of the tree), their JSONL reports and logs, and the `tsc` logs.
- In the shared repository I ran only reads plus `git merge-tree --write-tree`, which adds tree objects but no refs. The coordinator's worktree is clean.

NOT RUN: the banner in a real client, mobile, Linux or Windows, a real PTY or shell (fake PTY only, so the P3's real-shell timing is inferred), `check:changed`, the full server suite, apps/web typecheck, and a resolved merge with n14.

APPROVE WITH NITS 928b1c54854c3cef75853c7823eb8deaa068c271
