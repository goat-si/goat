BLOCK 18c6644ea83ed79bb24536d3960270035d9f1a97

I found one P2 and eight P3s. The P2 is the only blocker: each Claude CLI's map of descendants grows without limit. The rest of what I checked holds up: the kill guards, the reaper's trust rules, how the launch gate works, the startup order, the reactor's conditions, the boot deadline, both verbatim moves and rule 3. The P2 fix is a few lines and one test. Both goat-ci runs are green at this head. Once the fix lands, K5 can merge into `chase/t3-261114-next3` when goat-ci is green again on the new head.

**Head and setup.** `git ls-remote` showed the lane at `18c6644ea8` at 23:26 UTC and again at 23:48 UTC. The integration branch was `259883c788` both times. I read the record at `ccacff5d30`; it is byte-identical at the records head `9f18f49be6` (checked with `cmp`) and has 493 lines.

My scratch folder is `/tmp/k5-review-18c6644e`. It holds `./head`, a git archive of the head, and `./notes` with my logs, a probe, mutation output, the CI log and this report as `report.md`. My test results rest on `node_modules` APFS-cloned from `/tmp/pr3696-review-b7672aa5/head`. Its lockfile blob `34dad940…` matches the head.

Row 5 (`send_to_user`) is absent from the diff.

**Findings**

**P2-1. Tracked descendants are never forgotten.**
- **Where:** the map is created at `ClaudeDescendants.ts:138`. Its only write is `:147`, and nothing deletes from it. Every sample walks the whole map at `:141-149`.
- **Trigger:** any Claude session with no systemd scope, which means every macOS host and Linux without a user manager. Every descendant that was alive at any 1-second sample stays in the map until the CLI exits. A CLI lives as long as its thread is active, plus the 30-minute idle timeout (`ProviderSessionManager.ts:110`).
- **Consequence:** memory use and per-second event-loop time in the one server process grow with everything the session has ever run. I RAN a probe using the real sampler with a real 3,033-row process table plus synthetic short-lived children (`notes/probe-descendants.log`). Per sample, for one CLI:

| Rows held | Time per sample | Memory |
|---|---|---|
| none (baseline) | 0.47 ms | n/a |
| about 11,000 | 1.15 ms | not measured |
| about 21,000 | 1.94 ms | not measured |
| about 110,000 | 12.8 ms | 17.9 MB, about 170 bytes per row |

A busy day of builds and test runs plausibly reaches 10⁴ to 10⁵ rows (INFERRED). This breaks the rule in `server-resilience.md:82-87` that every buffer the server holds has a limit.
- **Smallest fix:** in `observe`, after a successful table read, delete tracked entries whose identity is no longer in `running`. Keep the `running.has` check in `stop`. This is safe: an absent identity is already never a root (`:145`) or a kill target (`:172`). It can only come back through a same-second pid reuse, which the kill check could not tell apart anyway. A failed table read never reaches `observe`.
- **Test to add:** a job is seen, disappears from one table, then the same pid and start time return under ppid 1, and `stop` does not kill it.
- **Basis:** READ, plus RAN (the probe).

**P3-1. No test pins the fd-4 launch gate.**
- **Where:** `ClaudeProcessSpawn.ts:10`, and the test "records the CLI before it runs and forgets it once it exits".
- **Trigger:** deleting `read -r _ <&4 || exit 1` leaves `ClaudeAgentSdkQueryRunner.test.ts` at 19/19 (mutation RAN). `register` runs synchronously right after spawn, so it wins the race anyway. The record's fail-first run tested a spawn that never registered at all.
- **Consequence:** the gate could be dropped silently. A crash in that window would then leave a CLI that is never recorded and so never reaped. This fails safe: nothing wrong gets killed.
- **Fix:** make the test's `register` slower than an ungated CLI, for example with a 0.5 s `execFileSync("sleep")` before it writes the record. Check that against the lint rule `goat/no-real-time-wait-in-tests`.

**P3-2. An interrupted live change leaves a stale identity.**
- **Where:** `ClaudeLiveSelection.ts:43-56` (the `tapError` is at `:49`), with the deadline at `LiveModelSelection.ts:37`.
- **Trigger:** the CLI does not answer within 10 seconds after taking part of a change, and the person then switches back to the previous selection while the same query is still running.
- **Consequence:** `tapError` does not run on interrupts, and the identity is only assigned after both calls succeed. The identity stays on the old selection, so the switch back is skipped by both the reactor and the turn-start check. The CLI can keep the half-applied effort while the client shows the old one.
- **Fix:** use `Effect.onError` instead, which runs on failure and on interrupt.
- **Basis:** READ and INFERRED; not reproduced.

**P3-3. The reaper's directory scan is unguarded.**
- **Where:** `providerProcesses.ts:127`, `:140`, `:163`, the loop at `:127-164`, and the finalizer at `:122`.
- **Trigger:** EMFILE or ENFILE, a writable but unreadable directory, a sticky directory holding a record owned by another user, or an immutable file.
- **Consequence:** layer construction fails and the server does not start. Ruling D4 ("never fatal") is not met literally. These states are implausible on a normal host, which is why this is P3.
- **Fix:** wrap `:125-164` so a failure logs once and the layer keeps what it has found, including `register`.
- **Basis:** READ only, since the scan needs `/proc`.

**P3-4. The reaper's wait has no total bound.**
- **Where:** `:144-156`, which waits up to 100 × 10 ms per record, serially.
- **Consequence:** N CLIs that SIGKILL cannot end, for example ones in uninterruptible sleep on a hung mount, delay startup by about N seconds. This happens before the 10-second probe deadline starts.
- **Fix:** signal every survivor first, then wait once for all of them with about 1 second in total.
- **Basis:** READ. Upstream behaves the same.

**P3-5. Records that never match are never removed.**
- **Where:** `:132-133`.
- **Trigger:** the hostname changes (containers get a new one each run by default), the `stateDir` path changes, or a newer version wrote the record.
- **Consequence:** each unclean exit leaves a few hundred bytes behind permanently, and every startup reads them.
- **Fix:** name this in the pull request's Limits, or remove such records after a long age. Liveness cannot be judged across hosts, because a shared NFS home is the reason the hostname is checked at all.
- **Basis:** READ.

**P3-6. The poll fiber is unscoped, and a mass close starts one `ps` per session.**
- **Where:** `ClaudeDescendants.ts:117`, `:153`, `:157`, `:166`.
- **Consequence:** the poll loop can outlive its layer until the last CLI exits. When N sessions close at once, about 2N `ps` processes start, each taking about 30 to 50 ms of CPU at 3,000 processes, with no cap.
- **Fix:** start the loop with `Effect.forkIn(layerScope)`, and let concurrent `refresh` and `stop` calls share one in-flight table read.
- **Basis:** READ.

**P3-7. The reactor's 256-thread limit has no test, and its warning fires only once per server lifetime.**
- **Where:** `LiveModelSelection.ts:62-66`.
- **Fix:** add a test where the 257th change is dropped and logged, and reset `warnedFull` once the table drains.
- **Basis:** READ.

**P3-8. The worst-case wait before the start-up message is 13 minutes, not 10.**
- **Where:** `ClaudeAgentSdkQueryRunner.ts:620-637` (5 minutes of boot plus 90 seconds of MCP registration per attempt) and `:856-863` (one retry).
- **Consequence:** the turn shows as working, with no output, for up to 2 × 6.5 minutes. Before this change the maximum was 2 × 90 seconds.
- **Fix:** say 13 minutes in the pull request's Limits, or retry only the `setMcpServers` phase.
- **Basis:** READ. Upstream behaves the same.

**What checks out**

**1(a) What the sampler can kill.**
- **Reused pids:** a kill needs both the pid and the start time to match at stop (`:169-173`). The case "never signals a reused pid…" catches the mutation that removes that check. A reuse within the same second would need the whole pid space to wrap within that second, which is practically impossible (INFERRED).
- **The CLI's own pid:** `stop` observes with `cliRunning=false` and removes the running observer synchronously (`:162`, `:169`).
- **Failed reads:** a failed, timed-out, over-cap or truncated table becomes `None`, and `None` kills nothing (`:39-55`, `processRunner.ts:231-274`, `:167`). The mutation that treats `None` as an empty table survives the tests, but it changes nothing for kills, because an empty table makes nothing look alive.
- **This server and its ancestors:** the mutation that removes the `protectedPids` check is caught.
- **Membership:** a process joins only through ppid links from this CLI or from a tracked process that is still running (`:141-147`). Sibling sessions, terminals and other servers are children of the server or of launchd.
- **Process groups:** a tracked group leader's group holds only descendants of the CLI (INFERRED from POSIX session rules). The detached `/bin/sh` at `ClaudeProcessSpawn.ts:47` starts a new session for the CLI.

**1(b)** This is P2-1.

**1(c)** `track` and `stop` swap the poll fiber synchronously (`:151-164`). Polling cannot end while a tracker is still live. Two poll fibers overlap only briefly, while the old one is being interrupted.

**1(d)** RAN on this Mac: 142,551 bytes and 3,033 rows, with 0 dropped. The parse took 2.7 ms and `ps` took 52 ms of wall time. The 8 MiB cap is about 59 times that table.

**1(f)** The scope guard is at `ClaudeAgentSdkQueryRunner.ts:559`, with `unit` set at `:536`. On macOS, `wrap` returns no unit (`agentMemoryGuard.ts:341-342`), so tracking runs there. The Windows path (`:566`) is untouched.

**2(b) What the reaper can signal.** It acts only on records with this hostname and `stateDir`, a dead owner, and a survivor whose identity still matches (`:132-145`). Pid 1 is refused (`:17`), and the server and its ancestors are skipped (`:94-98`).
- **Owner pid reused:** the owner's start time no longer matches, so the owner counts as dead and its recorded CLIs are reaped, which is correct.
- **Reboot:** the boot id is part of every start time, so nothing matches and the record is removed without signalling.
- **Unknown version:** ignored and never removed; see P3-5.
- **A live owner's `.pending` file:** left alone, because `:134` runs first.
- **A dead owner's `.pending` file:** removed (`:139-142`). Its CLI was still gated and exits when fd 4 reaches end of file.

**2(c)** Upstream also signals only the pid (`AcpSessionRuntime.ts:312`). When the old server dies, each CLI's watcher kills its whole group on end of file at fd 3 (`ClaudeProcessSpawn.ts:12`). Group members, such as MCP servers, survive only if the watcher also died.

**2(e)** Only `runServer` builds this layer (`server.ts:1273`). It is reached through `cli/server.ts:62` and `:116` for the start, serve and default commands, and through the desktop app's child process running `bin.mjs`. No short-lived command builds it.

**2(f)** `register` reads the gated `/bin/sh`, which is the server's direct child, before anything execs. Its ppid is therefore always the server, and `systemd-run --scope` later execs in place under the same pid. Registration fails only with a `/proc` from another pid namespace, an aborted spawn, or ENOSPC or EDQUOT on the record write. The turn then fails, closed, with no fallback; upstream does the same. Where reaping is off, `register` is undefined and the gate still opens (`:67-68`).

**2(g) The gate.**
- fd 4 is closed before the watcher forks and before the CLI execs (`:10-15`).
- EPIPE on the gate is routed by `guardChild`, which covers `stdio[1..4]` (`errorGuards.ts:25`).
- If the spawn is aborted, the gated `sh` dies inside its read.
- An exception from `forget` is swallowed (`:59-61`).

**2(h) The startup barrier.** `AgentScopeLive` is provided below the runtime services (`server.ts:1256` and `:1273`). Recovery lives in `runtimeLayer.ts:415` and `serverRuntimeStartup.ts:42`, so it is built only after the reap and the probe. If the probe passes its deadline, a run cannot continue without a launch, and every `wrap` waits on the same cached probe. macOS and Windows return before the probe (`agentScope.ts:110-111`).

**2(i)** Server run 44198312834 finished with success at about 23:47 UTC. In shard 3/4 the log line is `✓ src/process/providerProcesses.test.ts (3 tests) 184ms` with no skip count (`notes/ci-server-44198312834.log:7842`). The same file prints `(3 tests | 2 skipped)` on macOS, so both Linux cases **ran and passed**. The quick run 44198291794 also succeeded. I read both Linux cases: they signal only processes they spawned and hold, and they use a temporary `stateDir`.

**3(a) The ruling's conditions for the reactor.**
- **Bounded:** TRUE (`:25-26`, `:62-70`), but untested (P3-7).
- **One thread's slow call never holds another thread's events:** TRUE (`:68-70`); a test pins it.
- **10-second deadline:** TRUE (`:37`); the mutation removing it is caught.
- **Errors and defects caught:** TRUE (`:38-42`); a test pins it.
- **No echo of the provider's own report:** TRUE (`:59`; the ingestor stamps `rawEventId` at `ProviderEventIngestor.ts:352`); the mutation removing the check is caught.
- **Nothing persisted, Orchestrator untouched:** TRUE.

**3(d)** The reactor subscribes to the unbounded domain-event PubSub (`EventSink.ts:848`). Its handler does only synchronous bookkeeping plus a fork, so it should keep up. If the stream fails, it logs and stays dead until restart, the same as `HandoffWakeReactor.ts:403-407`. `forkParked` waits for server activation.

**3(e)** The reactor reaches only the running turn's own session (`:31-35`). The Claude guard requires the same native thread (`ClaudeLiveSelection.ts:71`). Codex has no `applyModelSelection`. ACP's version (`adapter.ts:6302-6345`) is a setup-time flavor hook, not a runtime method, so the reactor never calls it.

**3(f) Steer failures.** If the turn has ended and its completion is already recorded, the steer's text becomes the follow-up turn (`ProviderTurnControlService.ts:510-526`, `EffectWorker.ts:277-300`). Otherwise the steer fails, as it already does when the turn ends during background moves. A rejected `applyFlagSettings` fails that steer, as upstream does, but does not interrupt the turn. On the reactor path it is only logged, and a test pins that.

**4. Boot deadline.**
- The pinned SDK is 0.3.321 (`pnpm-lock.yaml:2876`), and `initializationResult` exists at `sdk.d.ts:3095`.
- A CLI that exits during boot reports its exit, not a timeout (`:621`); a test pins this and I RAN it.
- The retry now also covers a boot timeout; the worst case is P3-8.

**5. Move-outs and budgets.**
- **M1 and M2:** a line comparison (RAN) shows only `export` keywords and import lines differ.
- **Budgets:** counted with `countLines`, `ClaudeAdapterV2.ts` is 10916 lines against its entry of 10916. The runner is 979 and `EffectWorker.ts` is 999.
- **New tests:** no sleeps, polling loops, per-test timeouts, retries or wall-clock deltas. `it.live` appears only in the real-process fixtures, and those signal only processes their own fixtures started.

**6. Test runs.** RAN at the head, one vitest process at a time: 5, 19, 16, 1 (with 2 skipped), 3, 2, 2 and 2 tests passed across the eight files. I ran seven mutations, each restored byte-identical (checked with `cmp`). Every mutation of a kill guard was caught. Two survived: treating a failed read as an empty table, which is harmless, and removing the gate (P3-1). No processes or fixture folders were left behind.

**The open questions**

- **1(b):** Confirmed. Nothing removes a row before `stop`. I measured about 170 bytes per row and 12.8 ms per sample at about 110,000 rows. The fix is to prune rows absent from each successful table; under the buffer rule this is P2.
- **1(e):** The sampler usually catches the adb server, the Gradle daemon, and sccache-style cache servers. Each starts with a single fork while the client waits. I don't know kache's process model. The sampler usually misses daemons that double-fork, such as the ssh ControlPersist master, gpg-agent and the tmux server, and also `setsid cmd &` run from a shell that exits at once. When one of these shared daemons is killed:
  - A Gradle build already using it fails with "Gradle build daemon disappeared unexpectedly".
  - adb clients lose their devices until the next adb call restarts the server.
  - Compiles in flight through the cache server fail.

  Linux under a scope already stops all of these, double-forked ones included (INFERRED, not reproduced). I recommend accepting this, with a sentence in the pull request's Limits and in `docs/user`: shared helpers an agent starts, such as adb, Gradle and compiler caches, stop when that session closes and restart on next use.
- **2(a):** These failures happen only in implausible states, but when they do, the server will not start. P3-3 makes D4 hold literally.
- **2(c):** Upstream also signals only the pid. Signalling the recorded group when the pgid equals the pid would also stop the MCP servers left by a CLI whose watcher died. That is optional.
- **2(e):** Only long-running servers build the layer, so no short-lived command writes records or suppresses the leftover stop.
- **2(f):** `register` always reads the server's direct child. It fails only on a foreign `/proc`, an aborted spawn or a full disk, and then fails closed, as upstream does. Accept it.
- **3(b):** An interrupt does not take the failure path, but it does not mark the change as applied either. The only loss is a switch back to the earlier selection after a half-applied change; P3-2 fixes it.
- **3(c):** There is no lock per session, but control requests travel over one ordered channel. When the reactor refuses a model change, it leaves no state behind, so the steer's later live apply still works. No finding. A `Semaphore(1)` around the apply would make this obviously safe.

**Rule 3**
- **R1:** matches the authorisation exactly: six mocks gained one line each, plus one added import.
- **R2:** matches upstream `e4025c8528`'s hunk line for line, except for the slice name. `stopsOf` already existed (`:175` at the base). No other existing test or testkit line changed.

**Merge state**
- **Against the integration branch:** a fast-forward onto `259883c788`.
- **Against K10 at `4fa174d23c`:** `git merge-tree` is clean (tree `39cac14303`). The only file both sides change is `code-budgets.json`, and they edit different entries; `ClaudeAdapterV2.ts` stays at 10916. K10's diff shares no symbols with K5's.

**The author's claims**
- The `check:changed` result (305 files, 3898 passed) rests on the author's report.
- My mutations confirm the fail-first results for the `rawEventId` filter, the deadline, the live-owner guard and both kill guards.
- The gate's fail-first result does not show that the gate is pinned (P3-1).
- My counts for the eight files match the record.
- The note about pushing while tests were still running rests on the author's report.

NOT RUN: the two Linux `providerProcesses` cases and every `/proc` path on my side (they passed in goat-ci run 44198312834, whose log I read); the reaper's failure states and the message a person sees when `register` throws; real Claude turns; the startup barrier against a real systemd user manager; the daemons in 1(e), where I only reasoned from how they start; `check:changed`, typecheck, lint, `ClaudeAdapterV2.test.ts` and every other suite; a typecheck of the merge with K10.

BLOCK 18c6644ea83ed79bb24536d3960270035d9f1a97
