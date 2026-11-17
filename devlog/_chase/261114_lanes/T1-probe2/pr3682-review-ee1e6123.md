BLOCK ee1e6123ce264c5116464ee060340932ad376b38

The PR head was ee1e6123 at the start and at the end (14:21 UTC), and dev stayed at 78387154. next2 moved twice during the review (349e167a → 7023eb1a → ad363b04); the merge state below covers ad363b04.

The deadlock fix works. On dev's code all nine new lock-order cases hang: one at the framework's own `Test timed out in 120000ms.`, the rest at my 20 s cap. The head passes them, and the earlier reviewer's P1 probe now passes too. I found no remaining path where a holder of a thread's terminal lock waits on a lease.

It blocks because a request that waits gives up its place on the thread lock, and its rerun then repeats the old request over whatever happened in between. I reproduced that three ways. The brief's own rule for the rerun ("one shell at most per terminal id, the right folder, a clean error otherwise") fails for a closed terminal, a deleted thread, and a rebound worktree.

**P1. The rerun repeats a request that lost its place, undoing a close, a thread deletion, or a newer open that ran during the wait**

- **Where:**
  - In terminalLeaseOrder.ts, the busy attempt gives up the thread lock (:76), waits on the lease (:68), and then runs the same `effect` again (:70).
  - Manager.ts:2402: if the session is gone, the rerun clears `closedSessionKeys` and spawns a new shell.
  - Manager.ts:2440-2441: if the session is running in another folder, the rerun stops it and restarts it in the request's folder.
- **Trigger:** an open, restart, or attach takes the slow path because its folder is held. That happens during a restore's setup (minutes), a git checkout or checkpoint rollback (seconds), or when another thread's terminal is opening in the same folder: in my probe, 11 of 12 opens from 12 threads into one free folder went the slow way. While it waits, one of these arrives for the same terminal:
  - a close of that terminal or of the whole thread, such as the thread-deletion cleanup at ResourceCleanupService.ts:70 (`close({ threadId, deleteHistory: true })`);
  - a newer open of the same terminal id.

  These can come from a second client, an agent using the `terminal.open`/`terminal.close` agent surface, or an attach subscription. A single web or mobile client can't cause it by itself, because the client runtime sends a thread's open, restart, clear, and close one at a time (packages/client-runtime/src/state/terminal.ts:55).

- **Consequence:**
  - A shell starts after its terminal was closed or its thread deleted. It has no tab, its history file reappears after the deletion, and it runs until the server restarts.
  - A newer shell in the new folder is killed and replaced by one in the old folder.

  On dev, outside restores, the thread lock kept these requests in arrival order, so both cases came out right. During a restore, dev deadlocks instead.

- **Probes (run, real TerminalManager on the fake PTY):**

  | Case                                        | Head                                                                  | Dev                                                                   |
  | ------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------- |
  | Close sent during the wait                  | `"closedBeforeRelease":true,"spawned":1,"aliveAfterClose":true`       | `"closedBeforeRelease":false,"aliveAfterClose":false,"killed":[true]` |
  | Thread-wide close with history deletion     | `aliveAfterThreadClose: true`                                         | `false`                                                               |
  | Newer open of the same id in another folder | spawn order `[other(newer), held(older)]`, final folder `held(older)` | spawn order `[held, other]`, final folder `other`                     |

- **Smallest fix:** keep a per-terminal lifecycle counter that open, restart, and close (including thread-wide close) increase under the thread lock. The busy attempt reads it, which changes nothing, and carries it in `TerminalLeaseBusy`. If the counter moved by the time the rerun holds the thread lock, the rerun returns the current snapshot (or closed, for an attach) or fails cleanly, instead of spawning or restarting. Add the three probes as tests.
- **Basis:** run (head and dev swap) and read.

**P2. With Start in a new worktree, a terminal opened during setup lands in the old worktree**

- **Where:** Manager.ts:2493-2497. The rerun of `open` uses the folder named in the original request. startFresh rebinds the thread at ThreadWorkspaceService.ts:271, while it still holds both folders (:168, :286).
- **Trigger:** Start in a new worktree on a project with a setup script. While the setup runs, a person opens a terminal in that thread, and the client sends the thread's current folder.
- **Consequence:** after the rebind, the person's shell starts in the old worktree, which still exists, while the thread and its agent work in the new one.
  - Probe (run, using the author's harness with real git, the setup runner, and the manager): the restore succeeds and rebinds the thread to `…/feature-fresh-…`, and the spawn order is `[new (setup), old (person)]`.
  - This is not a regression from dev without a setup script, which always used the request's folder; the brief asks for the new folder.
  - Agents are fine: their authorize recheck (AgentTerminalMcpService.ts:115-128) runs inside the rerun and fails with "The terminal binding or workspace changed during this operation."
- **Smallest fix:** re-resolve the folder in the RPC layer when the request names the thread's previous worktree; on next2, N4's terminalWorkspaceRpc.ts is the natural place. Alternatively, have the rebind fail waiting requests for the old folder cleanly so the client retries in the new one.
- **Basis:** run and read.

**P3**

1. **The FIFO guard is untested.** Removing `users === 1` (workspaceLease.ts:303) still passes every test in the PR. Only my probe catches it: a terminal try right after a release must enter after a waiter already in the queue (head: `["waiter entered","terminal opened"]`). Basis: run.
2. **The attach's `onError(stop)` inside the lock is untested.** Moving it back outside the lock (Manager.ts:2667, mutation M7) passes every test. With that change, a busy attach would leave its first listener subscribed: the rerun overwrites its `unsubscribe`, and the listener buffers that terminal's output forever. Basis: run for the mutation, read for the leak.
3. **`detach ??=` is untested.** Changing it back to `=` (Manager.ts:2700, M6) passes every PR test. My probe shows a leftover second viewer then holds the terminal at 40 columns. Basis: run.
4. **One test doesn't reach the state its name describes.** "an attach left while it waits for the thread after the folder frees gives both back" (Manager.leaseOrder.test.ts:163) is interrupted while the attach is still in the lease queue, the same point as the previous case. With a trace added to the rerun, nothing printed.
   - The behavior itself is right. My probe waits until the rerun holds the lease, which takes one yield, and shows the lease freed, nothing spawned, and the thread lock usable, for both attach and open.
   - Fix: rename the test or make it reach that state.
   - Basis: run.
5. **New lint warning.** workspaceLease.ts:199 now triggers `goat(no-low-value-comments)` because the `reuseHeldWorkspaceLease` comment grew to 5 lines. Dev has only the warning at :293, now :317. Basis: run.
6. **Budget entry not lowered.** code-budgets.json:444 still allows Manager.ts 3217 lines, but the file now has 3212. docs/operations/code-quality.md:95 asks to lower it with `node oxlint-plugin-goat/update-code-budgets.ts`. Basis: read.

**What checks out**

1. **The invariant holds (read).**
   - Under the thread lock (Manager.ts:1159-1162, and AgentTerminalState's lock, which is now `withThreadLockAndLease` at :3149), the only way to a lease is `tryTerminalLease` (terminalLeaseOrder.ts:40-48), used for open (:2489), restart (:3045), agent open (:3153), and agent restart (:3168).
   - Everything else that runs under the lock takes no lease and waits on nothing a lease holder holds. That covers:
     - reading settings in `resolveLaunchInputEnvironment`;
     - stat, history, and PTY work;
     - `mcpSessions.read`;
     - `unregisterTerminal`;
     - event listeners (setup runner :266/:326, storageCleanup.ts:1148, OutputProtocol's synchronous push);
     - the agent `authorize` recheck.
   - `withThreadLock` isn't exported; only TerminalSettlement.ts uses it, for closing.
   - In the other direction, the restore's setup (open, plus a forked write and closeIdle), startFresh, and N4's `prepareTerminal` wait on the thread lock while holding a lease. They always get it, because a holder of that lock gives up instead of waiting on a lease.
   - The rerun never waits on a second lease while holding the first: the outer `settle` releases the first lease before waiting again.
2. **A busy attempt changes nothing (read, then run for interruption).**
   - The open or restart body runs only once the permit is held.
   - The attach's subscription is stopped inside the lock (:2667), and its viewer is kept once on purpose.
   - The agent's `agentBusy` flag is reset by its release.
   - `TerminalLeaseBusy` is removed from every service type (tsc: 0 errors), and no RPC, MCP result, or log line shows it. It can appear as an error on the `terminal.agentMutateLocked` trace span.
3. **The rerun re-reads the terminal's state (run, read).**
   - Someone else opened it meanwhile: it reuses that terminal, with one spawn (PR test; M4 is caught by it).
   - Closed, opened anew elsewhere, or thread deleted: see P1. Worktree rebound: see P2.
   - Storage Cleanup can't remove the folder while a lease on it is held or awaited (workspaceLease.ts:332-339), and an already missing folder fails cleanly at `assertValidCwd` (Manager.ts:1593).
4. **Liveness (run):**
   - The production diff adds no timer; the only timer is the old 150–350 ms foreign-claim sleep (workspaceLease.ts:190-192).
   - Effect's `takePermits` serves waiters in order, while `withPermitsIfAvailable` ignores the queue, so the guard is needed (I read effect 4.1.3 source).
   - 12 opens on one thread in a free folder took the slow path 0 times. 12 threads in one folder took it 11 times, in request order. 12 opens while the folder was held each reran once. Nothing loops.
   - A holder retaking with `withWorkspaceLease` lets the waiting open in first. A holder retaking with `tryWithWorkspaceLease` in the same tick (turn start, Restore, Start in a new worktree) jumped ahead of the waiting open 5 times. That overtaking was already possible before this PR, so the body's "not starved by restores that come and go" holds only for the first kind.
5. **Interruption:**
   - During the try: nothing to undo, since it's synchronous (read).
   - Between attempts: nothing held (read).
   - During the lease wait: PR test (run).
   - During the rerun before the spawn: my probe (run).
   - The attach's `Effect.uninterruptible` (Manager.ts:2528, :2541) now wraps only the try. The only wait reachable inside it is the reentry drain, which can't happen on an unmarked first attempt (read).
6. **The restore side (run):**
   - #3678's four setup cases and the new missing-folder case pass.
   - On next2 (7023eb1a) merged with this PR, N4's `prepareTerminal` holds the lease and its marked setup reenters. Its open runs only after the lease is released, so there's nothing nested.
   - On that merge, 8 files and 65 tests pass, including N4's `ThreadWorkspaceService.terminal.test.ts`.
7. **Cross-server (run and read):**
   - The new registry test checks the primitive: the try returns None while another server holds the folder whole, and a fiber holding its own folder whole fails instead of waiting.
   - The terminal's own wait reaches the foreign-claim wait by composition (terminalLeaseOrder.ts:68 → workspaceLease.ts:172).
   - Reentry takes no claim (:291).
   - It is weaker than a terminal-level test, but enough.
8. **The new tests (run):**
   - They are real: TerminalManager on the fake PTY, plus the real setup runner and git where needed. They assert who spawned, in which folder, the pid, the cleared marker, and that both requests finished. There are no sleeps or retries, and `it.live` is used only with git.
   - 106/106 pass at the head.
   - Mutations:

     | Mutation                       | Caught by                   |
     | ------------------------------ | --------------------------- |
     | M1, the try waits              | all 9 lock-order cases      |
     | M2, no users guard             | nothing in the PR           |
     | M3, busy keeps the thread lock | 8 of the 9                  |
     | M4, rerun without re-reading   | the "opened meanwhile" case |
     | M5, no mark check              | the new opt-in reentry case |
     | M6, viewer retained twice      | nothing in the PR           |
     | M7, stop outside the lock      | nothing                     |

9. **Existing tests (run):** the whitespace-insensitive diff of every existing test file is additions only, and no testkit changed. "resyncs bounded history and follows close/reopen across a stalled stream" passes unchanged.
10. **Repository rules (run, read):**
    - Formatting is clean.
    - tsc for apps/server has 0 errors.
    - There are no new `!` or `any` casts outside tests.
    - The new helpers are combinators, like the `withWorkspaceLease` beside them.
    - No new queue or buffer.
    - No internal doc covers the lock order, so none is made false.
11. **What a person sees:**
    - Web and desktop: no tab, then after 15 s the generic "Some requests are slow" toast naming `terminal.open` (SlowRpcRequestToastCoordinator.tsx; requestLatencyState.ts:7).
    - Because the client runtime sends a thread's terminal actions one at a time, I infer that the same client's close, restart, or new terminal in that thread also waits for the setup. I inferred this; I didn't run it.
    - Mobile: per the author, the attach shows the empty starting state; I didn't run it.
    - One sentence in the user guide's worktree-restore section is warranted: "While a worktree's setup script runs, new terminals in that thread open when it finishes."

**Merge state**

- **Against dev 78387154:** clean.
- **Against next2 ad363b04:** a direct merge from the real base 3ecea04f conflicts in five files, because next2 carries #3678 as a cherry-pick. next2's copies of workspaceLease.ts, its two test files, Manager.ts, and AgentTerminalState.ts are identical to dev's. So with dev as the base, or after merging dev into next2, only ThreadWorkspaceService.setupTerminal.test.ts conflicts: each side added a test at the end, and keeping both resolves it. ThreadWorkspaceService.ts merges automatically. The meanings don't clash.

**The author's claims**

- Confirmed by my runs: the nine timeouts on dev and passes at the head; 106/106 focused tests (105 at 0e76640c61 plus the cross-server case); the opt-in reentry case passing on dev and failing under M5.
- Resting on the author's report, not run by me: `check:changed` exiting 0 with 43 files and 699 tests, and the real-client pass on web.

The scratch folder is `/tmp/t1-review-ee1e6123` (2.6 GB). It is a `git archive` of the head, with `node_modules` borrowed from `chase-t3-261114-next2-n-8691c05d0b29374e`, which has the same lockfile. Inside it:

- `_dev`: dev's three files swapped in.
- `_next2`: next2 7023eb1a merged with the PR.
- `.review-mutations/`: my probes, the mutation script, and the logs.

The PR's nine files in the head copy match ee1e6123 byte for byte.

NOT RUN: `check:changed` and the full CI suites; any real client (web, desktop, mobile); Linux and Windows; a real PTY or shell; a real provider; thread archiving during a wait; interruption during the spawn itself; restart from a client; a cross-server test at the terminal level; the merged tree at next2 ad363b04 itself (run at 7023eb1a; the four lease and terminal files are unchanged since).

BLOCK ee1e6123ce264c5116464ee060340932ad376b38
