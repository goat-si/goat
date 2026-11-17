APPROVE WITH NITS 73b414ed76a06bef443b840a1b044d1b7730536e

I ran this fresh C4 review read-only on the exact head 73b414ed. `git ls-remote` gave the same head at the start (15:03 UTC) and at the end (15:46 UTC). `dev` stayed at 78387154 and next2 at e04442e66c throughout.

Round 2 closes the previous review's P1 and P2, and the deadlock fix still holds. The earlier reviewer's three P1 probes now pass at this head. The new tests are real: every overtaking call, the ticket join and the overtaken flag, and the moved-worktree check fail at least one PR test when mutated away. I found no P0–P2. The five findings below are all P3: one docs sentence, one semantic edge that follows the ruling, test gaps, one inferred edge, and body nits.

**Findings**

**P3-1. The new docs sentence is false for the default setup script and for Start in a new worktree.**
- **Where:** `docs/user/project-settings.md:347-348`.
- **Trigger:** either of these:
  - A setup script without **Wait for it to finish before the agent starts** (`projectScriptEditor.tsx:524`). That box is off by default, and a restore waits for the script only when it is checked (`restoreThreadWorkspace.ts:139`).
  - Start in a new worktree.
- **Consequence:**
  - For the default async script, a new terminal opens at once while the script is still running. In my probe the open returned `running` while the setup's completion was still held back.
  - For Start in a new worktree, a terminal opened during setup is refused with "Failed to access terminal cwd: <old path>". It does not open when the setup ends. The PR's own test (`setupLockOrder.test.ts:294`) shows this.
  - Agents answer questions about GOAT from this page.
- **Smallest fix:** "When a setup script waits to finish before the agent starts, new terminals in that thread open once it finishes. During **Start in a new worktree**, open them again once the new worktree is ready."
- **Basis:** ran and read.

**P3-2. A reuse-only open swallows a later restart of the same terminal.**
- **Where:** `terminalLeaseOrder.ts:89` marks waiting requests on every successful open, including one that only reuses a running shell (`Manager.ts:2283-2344`). An overtaken restart then just returns the current terminal (`Manager.ts:2944`).
- **Trigger:** two clients, while the folder is held:
  - one opens terminal X while it is running;
  - the other restarts X.
  
  Both wait, and the open reruns first because the lease queue is first in, first out.
- **Consequence:** the restart restarts nothing and returns the old process. I ran it both ways:
  - Folder held: `openPid 9000, restartPid 9000, spawned 1, firstKilled false`.
  - Folder free: `restartPid 9001, spawned 2`.
  
  A single client cannot hit this, because the client runtime sends a thread's terminal actions one at a time. The behaviour follows the ruling's wording ("a successful open including reuse").
- **Smallest fix:** only an open that started or restarted a process marks waiting requests. Alternatively, accept it and say so in the body.
- **Basis:** ran.

**P3-3. Four guards have no test.** None of this blocks the hotfix.
- **M4 (the rerun reuses its first read of the session):** survives 148/148. `Manager.leaseOrder.test.ts:95` ("finds the terminal the holder opened meanwhile") now goes through the overtaken path (`Manager.ts:2356-2366`), so the rerun's re-read is no longer pinned. Only eviction during the wait (`Manager.ts:1514-1519`) still reaches it.
- **M7 and M8 together:** M7 moves `onError(stop)` back outside the lock; M8 removes the `unsubscribe?.()` guard at `Manager.ts:2527`.
  - Each alone survives harmlessly, as the author says.
  - Both together also pass 148/148. The first attempt's listener then stays subscribed and buffers that terminal's output forever (`Manager.ts:2502-2504`).
  - This is invisible through the service API, because that listener never delivers anything.
- **S6 (no `ensuring(leave)`):** passes 148/148. My scratch counter shows one ticket left behind after each interruption: in the lease wait, between attempts, or in a second wait. The ruling allowed a path:line instead of a test for this.
- **The live worktree layer:** `server.ts:514-534`, which treats a deleted thread as gone and returns the worktree path, has no test. Every moved-worktree test uses a stub.
- **Smallest fix:** optionally retitle `:95` to say it covers the overtaken answer.
- **Basis:** ran.

**P3-4. The moved-worktree check also applies to system opens.**
- **Where:** `stillBound` (`Manager.ts:2348-2353`) runs on any rerun of open, restart or attach that names a worktree. That includes the setup runner's own open (`ProjectSetupScriptRunner.ts:487-495`).
- **Trigger:**
  - Pull request worktree setup (`GitManager.ts:2728`, `:2839`) runs before the worktree path is returned, so the thread may not be bound to it yet.
  - The check matters only if that open goes the slow way: another request on the same folder at that moment, which mostly means the reused-worktree path.
- **Consequence:** the setup is refused as "moved" and skipped with only a logged warning (`pullRequestSetup.ts:15-21`). On dev it would wait and run.
  - Launch and the MCP worktree path bind the thread first (`WorktreeMcpService.ts:335`).
  - Restores and Start in a new worktree reenter their held lease on the first attempt, so they never rerun.
- **Smallest fix:** apply the check only to requests that come from a person, or note the limit.
- **Basis:** inferred from reading.

**P3-5. Two body nits.**
- **The agent-restart row:** the body says an overtaken agent restart gets the new conflict at `Manager.ts:3090`.
  - Agent requests register with no terminal id (`Manager.ts:3047`), so only a thread-wide close can overtake them.
  - I ran three cases while an agent restart waited:
    - A person's close: `TerminalSessionLookupError`.
    - A person's restart elsewhere: "Terminal generation has changed." (`AgentTerminalState.ts:246-250`).
    - A thread-wide close: not-found.
  - None started a shell, and the new message never appeared. The outcome is right; the path the body names is not the one taken.
- **The known limit:** the paragraph about judging folders by path string names "Lane N4" but not goat#3690 (ruling 4).
- **Basis:** ran and read.

**What checks out**

- **A. P1 is closed.**
  - *Earlier probes (ran at this head):*
    - Close during the wait: `openSucceeded:false, spawned:0, aliveAfterClose:false`.
    - Thread-wide close with history deletion: `spawned:0, aliveAfterThreadClose:false`.
    - Newer open elsewhere: spawn `["other(newer)"]`, final folder `other(newer)`.
    - The PR's own versions (`Manager.leaseOrder.test.ts:187`, `:207`, `:225`) pass.
  - *Overtaking calls, each pinned by a test (read, then ran by mutation):*
    - `:89` covers open, restart, attach start, agent open and agent restart. Removing it fails `:225`.
    - `Manager.ts:1944` closeSession covers the person close `:2955`, settle (`TerminalSettlement.ts:28`), the idle close `:3020` and the agent close `:3096`. Removing it fails `:187`.
    - `:2959` is the thread-wide close. Removing it fails `:207`.
    - All three run under the thread lock.
    - Dropping the overtaken flag, or never registering the ticket, each fails the three P1 tests.
    - A process exiting by itself and eviction do not overtake.
  - *A system close overtaking a person's request (ran, using the author's harness plus an idle subprocess inspector):*
    - An open or restart of the setup terminal's own id while a sync restore holds the folder gets `TerminalSessionLookupError` after `closeIdle`.
    - An attach of that id gets `closed`, with one spawn in total.
    - That matches serving the request first and the close second.
    - Ordinary restores never produce it: new tabs get fresh ids, and an attach to the running setup terminal needs no lease and finished before the gate opened.
    - A person's new terminal during a sync setup still opens when the setup ends (PR test, passes).
  - *Tickets stay bounded (ran, with a scratch-only counter):*
    - The waiting set is empty after success, after failure, and after interruption in the lease wait, in the rerun, between attempts, and in a second wait.
    - A rerun that goes busy on a second folder releases the first folder before it waits again.
    - The only finalizer is a synchronous `leave` (`terminalLeaseOrder.ts:115-119`, `:151`).
  - *Two requests waiting (ran):*
    - Same id, open then open, open then restart, or restart then open: one spawn, and the second gets the first one's process.
    - Different ids on one thread: both open, in arrival order.
  - *Overtaken attach (ran):*
    - By a newer open elsewhere: the attach shows the newer terminal and gets one output while attached and none after stop. A later 120-column open is not narrowed, so one viewer was kept.
    - By a close: `["closed"]`, no spawn.
    - A disconnecting client still frees everything (PR tests `:117`, `:148`).
- **B. P2 is closed (ran).**
  - The PR test (`setupLockOrder.test.ts:294`) and the three fail-closed cases pass.
  - My probes:
    - A first attempt in a free folder never reads the binding and opens as on dev.
    - Reruns that name no worktree, agent reruns and overtaken reruns never read it either.
    - Restart and attach reruns on a moved thread fail with `TerminalCwdStatError`, start nothing and release their viewer.
  - Mutations:
    - Running the check on first attempts too fails the PR's Start in a new worktree test.
    - Never running it, failing open on a read error, or letting a deleted thread pass each fails a test.
  - Layering (read):
    - Nothing under `terminal/` imports the projection store, and there is no import cycle.
    - The live read goes through the reader pool (`ProjectionStore.ts:7551`).
    - `make` requires the service (`Manager.ts:828`).
    - Without it, `makeWithOptions` skips the check, which fails open. Only the two testkits do that.
  - Agents never reach the check, and every terminal error reaches an agent as the generic text (`AgentTerminalMcpService.ts:23-30`, `:126`).
- **C. The M7 guard is safe.**
  - *Read:* `unsubscribe` belongs to one `streamSession` call (`Manager.ts:2485`), so the guard stops only that stream's own earlier subscription.
  - *Ran:* two waiting attaches, a third viewer, an observer and a resync each heard the first output. After one attach stopped, the other four heard the second: `{a:1,c:2,b:2,o:2,r:2}`.
- **D. The deadlock fix still holds.**
  - *Ran:*
    - M1 (the try waits) fails 32 tests, including all nine round-1 lock-order cases.
    - M3 (a busy attempt keeps the thread lock) fails 28.
    - M2 is caught by the new FIFO test (P3-1 closed), M5 by the reentry test and M6 by the one-viewer test (P3-3 closed).
  - *Read:* under the thread lock the only way to a lease is the try. The new worktree read is a reader-pool SQL read, and no code that opens a SQL transaction calls the terminal manager.
- **E. The two move-outs are verbatim (ran a script diff).**
  - `67cc956df3` differs only in blank lines.
  - `eed1a6d68e` differs only by renaming the constant to `export const layer`. It sits at the same place in the layer list, with the same scope and the same start.
  - Budget entries equal the real line counts: Manager.ts 3122 and server.ts 1316. None was raised, and no new file exceeds 800 lines.
- **F. Existing test files have additions only (ran).** `git diff -w` against dev shows +16/−0, +21/−0 and +26/−0 for the three existing test files. No testkit changed, and the stalled-stream case passes unchanged.
- **G. Repository rules (ran).**
  - Lint on the 13 changed files exits 0. Its two warnings both exist on dev: `workspaceLease.ts:316` (dev `:293`) and `server.ts:637` (dev `:614`). Round 1's comment warning is gone.
  - The format check is clean.
  - apps/server `tsc --noEmit` exits 0 with zero errors.
  - Added production lines have no non-null assertions or `any`, and the new `Effect.fn` is named.
  - The new tests have no sleeps, polling, per-test timeouts or retries, and use `it.live` only with git.
- **I. The N4c follow-up works with this head (read).** A marked restart reenters the held lease through the try (`workspaceLease.ts:209-217`, `:287-291`). It waits only on the thread lock, and its success overtakes a person's waiting request for the setup id, which then gets the restarted terminal.

**Merge state (ran with `merge-tree` in a shared clone)**

- **Against dev:** clean.
- **Against next2, with dev as the base:** two conflicts, and each resolves by keeping both sides.
  - `setupTerminal.test.ts`: each side appends a test at the end.
  - `project-settings.md:347`: next2 appends a sentence about earlier cleanups after "the next turn also runs it."
  - `server.ts` and `code-budgets.json` merge cleanly, and the merged server.ts (1316 lines) equals its budget entry.
- **Against next2, from the real base 3ecea04f:** six files conflict, because next2 carries #3678 as a cherry-pick.

**The author's claims**

- **Confirmed by my runs:**
  - 117/117 in the seven focused files.
  - Every path:line in the body.
  - The budget changes.
  - `startSession` is reached only through the two lease paths (`Manager.ts:2266`, `:2322`, `:2914`).
  - M7 alone is harmless.
- **Resting on the author's report:**
  - The 7-failed/12-passed run against round-1 code. My mutations reproduce each failure class instead.
  - `check:changed` (53 files, 778 tests).
  - The first-round real-client pass.
- **J. CI:** `goat-ci-result` is **success** on 73b414ed in the newest pull-request run (44108888579), the default quick scope. No full run has been made.

The scratch folder `/tmp/t1-review-73b414ed` (1.0 GB) is left in place:

- `head/` is a git archive of the head, byte-identical to it again in apps/server, packages, docs and oxlint-plugin-goat.
- `probes/` holds my probe files, `.review-mutations/` the mutation script, summary and logs, and `repo/` the shared clone.

The coordinator's worktree is untouched: status clean, HEAD ed7b0b15fb9 before and after.

NOT RUN: `check:changed`; the full CI suites (`ci:full`); any real client (web, desktop, mobile); Linux and Windows; a real PTY, shell or provider; the head's tests against round-1 code; the nine cases on dev's code at this head (M1 stands in); the live worktree layer against a real projection store; the pull request setup rerun in P3-4; `goat-rename --check`; tests on the merged next2 tree.

APPROVE WITH NITS 73b414ed76a06bef443b840a1b044d1b7730536e
