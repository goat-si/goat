BLOCK 4fa20e693f8637394c5606938a8de1195bb22a26

The production fix does what the coordinator asked. The blocker is the new earlier-run test. On this Mac it times out at the exact head. When it passes elsewhere, it passes because the new run closes the idle shell, not because the earlier run sees its old shell end.

The head was 4fa20e693f8637394c5606938a8de1195bb22a26 by `git ls-remote` at the start (01:06 KST) and the end (01:23 KST). The integration branch moved from ce893ca4ea to 3a254fa1a5 during the review.

**Findings**

**P2: the earlier-run test depends on the host's process list and does not pass at the head on this machine**

- **Where:** `apps/server/src/orchestration-v2/goat/ThreadWorkspaceService.setupShell.test.ts:112-116` builds the fixture without `processTable`. The case is at `:327-351`, it hangs at `:346`, and the comment at `:327` is wrong.
- **Trigger:** without `processTable`, `closeIdle` falls back to running `ps -eo pid=,ppid=,comm=`, which is capped at 524,288 bytes (`apps/server/src/terminal/Manager.ts:772-785`). Here that output is 586,510 bytes from 2,840 processes, so the inspection fails and `closeIdle` only logs (`Manager.ts:3104-3106`, `:3134-3141`).
  - The earlier run's watcher settles only on `exited` or `closed` (`ProjectSetupScriptRunner.ts:297-299`).
  - A restart publishes `restarted`, and `stopProcess` publishes nothing (`Manager.ts:1790-1827`, `:3039`).
  - So `exitCode === null` arrives only from the `closed` event that the new run's `closeIdle` produces.
- **Consequence:** the test hangs for 120 s at the head on maintainer Macs with many processes. `vp test run` and `check:changed` fail there. CI never ran it either: the server shards in run 44115010294 were cancelled.
- **Smallest fix:** add `processTable: Effect.succeed([])` to `makeWithOptions` in the fixture. I ran this in scratch: 7 of 7 pass in 8.7 s. Also fix the comment at `:327`. Optionally make the watcher settle on `restarted` (see the first P3), so this assertion stops depending on `closeIdle`.
- **Basis:** RAN at the head, 6 passed and the earlier-run case timed out at 120 s, with the log line "failed to snapshot processes… stdoutTruncated: true". RAN the same file with the one-line injection: 7/7 pass. RAN the `ps` byte count.

**P3: an earlier run's watcher cannot tell that the restart killed its shell**

- **Where:** `apps/server/src/project/ProjectSetupScriptRunner.ts:274-301`; `apps/server/src/orchestration-v2/ThreadLaunchService.ts:819-842` and `:874`.
- **Trigger:** a setup run with a consumer still waits when a restore restarts the terminal. Only the tracked thread launch with an async setup still running is such a consumer.
- **Consequence:**
  - The earlier run passes the new shell's output to its `onOutputLine`, including the new sentinel line. Those lines land in the launch log and the tail.
  - It settles with `null` only when the new shell closes or exits. For an async restore nobody runs `closeIdle`, so it waits until a person closes the tab.
  - The launch then records "Setup script exited with no exit code" and marks the setup stage failed.
  - The pattern already existed for an open whose launch context changed. This change adds a second way to reach it.
- **Smallest fix:** settle `null` on `restarted` at `:297`. The fresh run subscribes after its own restart, and an open publishes only `started`, so the run never settles itself.
- **Basis:** READ.

**P3: an earlier run that has not written its command yet types it into the new shell**

- **Where:** `ProjectSetupScriptRunner.ts:340-354` and `:573-596`.
- **Trigger:** the earlier run's readiness watcher is still waiting, for example on an unanswered rc-file prompt, when the restore restarts the terminal.
- **Consequence:** the watcher resets on `restarted` and turns ready on the new prompt. Its forked writer then writes the earlier command too, so setup runs twice in the restored folder. If that run exits 0, its `closeIdle` re-checks that the shell is idle before closing it (`Manager.ts:3113-3127`). This is unlikely.
- **Smallest fix:** treat `restarted` as `exited` in the readiness watcher, or accept and document it.
- **Basis:** READ and INFERRED.

**P3: a resumed restore restarts a shell in a healthy folder**

- **Where:** `apps/server/src/orchestration-v2/goat/restoreThreadWorkspace.ts:141-150`; `Manager.ts:3022` and `:3027`.
- **Trigger:** the marker is present and the folder is intact. That happens after an interrupted restore, or a lenient or failed-discard attempt, when a person ran their own command in the setup tab (for example `pnpm dev`). Then a turn starts or the person clicks "Run setup now".
- **Consequence:** their command is killed and the tab's history is wiped. Before the fix, the setup line was typed into their running program instead, which was also broken. On the turn-start path this happens without the person asking. This is unlikely, and the banner does say setup reruns before the next turn.
- **Smallest fix:** accept it and document it. Telling apart a shell in a healthy folder from one in a gone folder would need more machinery than it is worth here.
- **Basis:** READ.

**P3: the web refresh has no behaviour proof and makes one extra request**

- **Where:** `apps/web/src/components/chat/useThreadWorkspaceStatus.ts:36-42` and `useThreadWorkspaceStatus.test.ts`.
- **Trigger:** the status first comes back missing.
- **Consequence:**
  - The new `handledTokenRef` starts empty, so the status is fetched again right away.
  - The hook is mounted twice per thread view (`ChatView.tsx:1680`, `GitActionsControl.tsx:775`), so each item change asks for a refresh twice. I did not verify that both instances share one status atom.
  - The test only checks the key helper's value, and the author did not capture the banner in a real client. Nothing shows the banner going away.
- **Smallest fix:** a browser test that changes the shell's `itemCount` and expects the banner to disappear, or a real-client capture. Optionally skip the first token.
- **Basis:** READ.

**P3 nits**

- `ProjectSetupScriptRunner.ts:501` ("Subscribe before opening…") and `:321-322` are no longer true for a fresh shell.
- `FRESH_SHELL_COLS`/`ROWS` at `:166-167` duplicate `DEFAULT_OPEN_COLS`/`ROWS` (`Manager.ts:154-155`). The restart resizes a live terminal to 120×30 until the following open applies the attached viewers' size.
- Already true before this change: an async restore never consumes its completion, so its watcher stays subscribed for good.

**What checks out**

- **a, met.** The restart runs inline in the marked restore fiber (`ProjectSetupScriptRunner.ts:477-497` inside `reuseHeldWorkspaceLease`, `restoreThreadWorkspace.ts:140-151`), using restart rather than close plus open. A first restore spawns once: restart creates and spawns (`Manager.ts:2968-3008`, `:3028`), and the open after it reuses the session because cwd, worktree path and env are equal (`Manager.ts:2441-2446`). RAN: the one-shell case passes at the head and at the parent.
- **b, met.** One call site covers recreate from branch, restore from snapshot and resume (`restoreThreadWorkspace.ts:141-150`).
  - Correction to the brief: an async setup clears the marker when `runForThread` returns, which is after open but before the command is written (`:179-185` against `ProjectSetupScriptRunner.ts:573-596`).
  - A sync setup holds the lease through completion. So a resume can only meet a leftover run from an interrupted or failed attempt, and killing it to start over is intended. READ.
- **c, partly.**
  - The earlier run cannot clear the new marker: only the restore's own fiber clears it (`:179-185`), and the lease prevents overlap.
  - It cannot `closeIdle` the new shell: its tap needs its own sentinel with exit 0 (`:598-604`), apart from the double-write case.
  - The restore and `ThreadWorkspaceService` never hold another run's completion.
  - Every subscriber is accounted for in the P3s above. The test pins one idle close and the cleared marker; its `null` is P2.
- **d.** The old shell's "exited" never reaches the new watchers:
  - `stopProcess` detaches its listeners and clears pending events before the kill, and publishes no event (`Manager.ts:482-487`, `:1803-1819`).
  - Late events from the old process are dropped by the pid checks (`:494`, `:1678`).
  - The only leftover risk is a drain already holding one old output chunk (`:1757-1768`), which is negligible.
  - Missing `restarted` does no harm (`:329-344`). A missed prompt falls back to the 3 s quiet timer. An rc-file prompt shows up as busy through the activity poll, which runs after the watchers subscribe.
  - This is no worse than a first open apart from a window of a few synchronous steps. INFERRED.
- **e.** RAN: it fails first at the parent. With the two production files swapped back in, 5 cases fail with "expected 1 to equal 2", the one-shell case passes, and the earlier-run case times out at 120 s (with `processTable` injected, so the timeout comes from the parent's defect, not the host). There are no sleeps, per-test timeouts or retries, and `it.live` is used because git runs. Passing at the head is not met here (P2).
- **f, confirmed.** Nothing under `apps/server/src/terminal` or `apps/server/src/workspace` changes. `terminalLeaseOrder.ts` does not exist at this head.
- **g.** No other caller passes `freshShell`:

  | Caller | What it passes |
  | --- | --- |
  | Thread launch (`ThreadLaunchService.ts:784`) | `observeCompletion` when tracked |
  | Fork (`ThreadForkWorkspace.ts:464`) | defaults |
  | Worktree MCP (`WorktreeMcpService.ts:355`) | defaults |
  | Pull request setup (`pullRequestSetup.ts:13`) | defaults |
  | Settlement | `trigger: "settle"`, separate terminal id |
  | Observed checks | `trigger: "check"`, separate terminal id |
  | Start in a new worktree (`ThreadWorkspaceService.ts:293`) | a new path, so the cwd change relaunches the shell |

  "Run setup now" already takes a fresh shell. It sends `mode: "restore"` (`ThreadWorkspaceBanner.tsx:92-117`); `present()` is false while the marker exists (`ThreadWorkspaceService.ts:136-144`), so it runs a resumed restore.
- **h.** Only the resume path can kill a person's command in a healthy folder (P3).
- **i.**
  - At most one refresh is in flight, because a refresh restarts the atom's read. Once the status is healthy, nothing refreshes. There is no loop.
  - A streaming turn costs zero requests per item: the quiet shell keeps `itemCount` while a run is active (`packages/client-runtime/src/state/threadShell.ts:115-142` and `:298-311`).
  - The notice is a turn item on the latest run, so `itemCount` increases (`TimelineRecords.ts`). INFERRED, not run in a client.
  - The file adds no direct effect, so the effect budget is unchanged.
- **j.** On #3682 the restart goes through `withThreadLockAndLease` and `tryTerminalLease` (`terminalLeaseOrder.ts:76-99`, `Manager.ts:2931-2950` on that branch). The marked fiber re-enters the held lease through `enterHeld`, and it never waits on a lease while holding the thread lock.
  - At e04442e66c, the restart adds a second thread-lock-then-lease acquisition, the same lock order #3682 fixes.
  - The new tests never create contention, so they do not depend on the lock order. READ and INFERRED.
- **k, confirmed.** Effect naming, comment caps, no new non-null assertions or `any` casts, and file budgets are all fine. Both test files are new and no existing test changed. CI `goat-check` and `goat-typecheck` are green on the exact head (READ through `gh`).

**Merge state** (`git merge-tree`, run)

- Against the integration branch at ce893ca4ea and at its new head 3a254fa1a5, and against the sf1 (410daab8e6), n12b (2c0e5563f3) and n14 (2a94ed4deb) branches: clean, with no files changed on both sides.
- Against the #3682 hotfix (52f3f8c6bf): N4c adds one trivial conflict, its `freshShell` lines in `restoreThreadWorkspace.ts`. That sits on top of conflicts that e04442e66c already has with the hotfix.

**The author's claims**

Confirmed by my runs:

- There are seven cases.
- At the parent, five fail with "expected 1 to equal 2", the one-shell case passes, and the earlier-run case times out at 120 s.
- The web test passes at the head.
- CI run 44115010294 finished "cancelled". `goat-check` and `goat-typecheck` passed, but the server shards were cancelled, so CI has not run the new test.

Contradicted: "all pass at the head" does not hold on this Mac (P2).

Resting on the author's report: `check:changed` exited 0 with 2,506 tests, and the original defect reproduced in a real client.

Housekeeping: the scratch folder is `/tmp/n4c-review-4fa20e69`. Its `tree/` holds the head plus my variant test, `ThreadWorkspaceService.setupShellScratchIdle.test.ts`, with node_modules APFS-cloned from bd1af2b5260ef634 (lockfile matched). The folder also has the merge-tree outputs, the CI log and the hotfix's `Manager.ts`. I ran one `git fetch -q origin refs/heads/chase/t3-261114-next2` in the shared repo. It wrote FETCH_HEAD and perhaps the remote-tracking ref; it changed no branch and no worktree files.

NOT RUN: web or mobile client capture of the banner, Linux or Windows locally, a real PTY or shell (fake PTY only), the merged tree with #3682, a local tsc, `check:changed`, the full server suite.

BLOCK 4fa20e693f8637394c5606938a8de1195bb22a26
