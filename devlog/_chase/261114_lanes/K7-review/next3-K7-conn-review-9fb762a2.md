Verdict for rows 1 to 5 at 9fb762a2b5: two P2 findings and six P3s, no P0 or P1. Both P2s are runtime-proven by probes. Rows 4 and 5 hold up. Row 1's resend is live code in production: the brief's worry that the give-up race wins too early does not happen. But nothing ends row 1's wait while the socket stays up, and row 2 can resume a thread past events it never applied.

The head was 9fb762a2b5f969b2948b3edb22bf12b42a07d3e2 on `git ls-remote origin` at the start and at the end. The integration branch was 259883c788 both times, and the records branch was b167790ba4 when I read it. The scratch folder stays at /tmp/k7conn-review-9fb762a2, with the head archive in ./head and logs, probes and diffs in ./notes. Its install is root and per-package node_modules APFS-cloned from /tmp/k5-review-18c6644e/head, plus apps/web/node_modules from /tmp/k10-review-4fa174d2/head; both have the same lockfile blob, 34dad940e8. Nothing was pushed or commented, and the coordinator's worktree HEAD and index are unchanged.

## Findings

**P2-1 (row 1). A message whose reply is lost on a healthy socket waits until the next reconnect, however long that takes.**
- **Where:** packages/client-runtime/src/operations/dispatch.ts:43-61.
- **Trigger:** a frame the client cannot parse. Effect's socket client then fails every pending request with an `RpcClientError` and keeps the socket open (effect 4.1.3 RpcClient.ts:1320-1330). This is the "healthy connection" failure that row 3 exists for. Row 1 counts it as lost transport and waits for a different session or for "available"/"blocked". The session stays the same and the phase stays "connected", so the wait never ends.
- **Consequence:** on web the optimistic bubble stays and the draft is already cleared (useComposerSend.ts:1265). `sendInFlightRef` stays set (useComposerSend.ts:1524), so every further Send in that thread shows "Still sending your previous message." (chatViewSend.ts:370-378). There is no error and no cancel. The only exits are a manual disconnect or a reload; a reload loses the text if the message never landed.
- **Basis:** RAN a probe (notes/probe.dispatch.final.txt). With the session unchanged and "connected", the send is still pending after `TestClock.adjust("6 hours")`, with one attempt sent.
- **Smallest fix:** add a third branch to the race: after a short grace (about 30 s), if the same session is still current and connected, resend on it. The server receipt makes a same-session resend safe. Add the total bound from 1(d), then restore the draft with an error.

**P2-2 (row 2). After a defect while applying events, the thread resubscribes past the batch it never applied.**
- **Where:** threads.ts:430, then :962 and :978 (`canResume` only checks that data is held), and threadSubscriptionRecovery.ts:52-69.
- **Trigger:** the event fold throws inside the state update. `lastSequence` already advanced before the fold (:430), and `restartAfterDefect` reruns the follow with `afterSequence` set to that advanced value. The snapshot path (:545) does the same.
- **Consequence:** the thread shows "live" but silently lacks that batch, for example a run that stays "running" or a missing message, until some later full snapshot. Before this row the same defect froze the thread. The plan's own negative case says "stale rows are never resumed past a half-applied batch (tested)". The build log admits there is no test, and the comment "follow again for a fresh snapshot" is false when data is held. Upstream de21fbcff3 has the same gap, so this is a faithful port of an upstream bug.
- **Basis:** RAN a probe (notes/probe.threads.test.ts.txt) with the reducer mocked to throw on event 8. The resubscribe sent `afterSequence: 8` while the state still held the old title.
- **Smallest fix:** a flag set by `restartAfterDefect` that makes the next subscribe input leave out `afterSequence` (a fresh snapshot). Turn the probe into the test; it shows how to make apply die with `vi.mock` of orchestrationV2Projection.ts.

**P3s**

- **P3-1: one guard is pinned by no case.** No test catches dropping `options?.onDefect === undefined` (rpc/client.ts:553-554); mutation M6 left 123 of 123 passing. Without the guard, a thread decode defect would resubscribe twice (an extra snapshot), though switchMap still keeps one live stream. Fix: one case asserting a single resubscribe after one decode defect on a caller with `onDefect`.
- **P3-2: the backoff reset after applied items is pinned by no case** (threadSubscriptionRecovery.ts:45-47); mutation M8 left 55 of 55 passing. Fix: extend "backs off repeated defects…" so that after items apply, the next defect waits 250 ms again.
- **P3-3: the subscription retry counter never resets within one session** (rpc/client.ts:458). After five stream failures on one long healthy session, every later failure waits 30 s, and the shell shows stale data with no indicator for those 30 s. Fix: reset when a stream has stayed up for, say, 60 s.
- **P3-4: one wasted resend when the session changes before the attempt** (dispatch.ts:39-40). `attemptSession` is read before the attempt, but `request()` reads the session again. If the session is replaced in between, the wait returns at once and spends one of the two resends on the session that just failed. On a flapping link the person sees the draft restored with an error sooner than intended. Fix: pin the attempt with `currentSession()` plus `requestInSession`, both now exported by row 4.
- **P3-5: no case drives the real supervisor for row 1.** dispatch.socketLoss.test.ts:55-93 uses two SubscriptionRefs, and the web test mocks `startThreadTurn`. My reading shows the real order is safe (see 1(b)), so this is coverage only. Fix: one case on the real supervisor with a fake driver whose session dies.
- **P3-6: record corrections.**
  - ebbba8c7f0 also adds `export` to `IDLE_SERVER_UPDATE_STATE` in server.ts. That creates a server.ts ↔ serverUpdate.ts import cycle (serverUpdate.ts:21 imports it; server.ts does `export *`). It is harmless because the value is only read inside a function, but the record says the only change is `SERVER_UPDATE_RESUME_TIMEOUT`.
  - The I.4 answer (b) says the person can type the message again and both would land. On web that is wrong: Send in that thread is refused during the wait.
  - Answer (c)'s "6 warnings per subscription per minute" is really about one, because the supervisor clears the dead session before the first 1 s retry.

## What checks out

**Row 1**
- **1(a), the server dedupe (READ, plus the server test RAN 2 of 2).** Dispatch takes a per-thread lock (Orchestrator.ts:12933-12940), and the receipt is read inside it (:12689-12701). A second frame with the same commandId replays the first receipt, even while the first is still being decided and even from another socket at the same moment. `insertIfAbsent` with a re-read (:12788-12819) backs this up. The same commandId on another thread returns `OrchestratorCommandIdConflictError` (CommandReceiptErrors.ts:36-41, Orchestrator.ts:12645). Receipts are pruned only for imported legacy threads (ProjectionMaintenance.ts:428-453), so a late resend still replays.
- **1(e), what is never resent (READ plus probes RAN).** An authorization error and a server failure that is not an RpcClientError go straight to `return yield* exit` (dispatch.ts:46). The 60 s timeout's `EnvironmentRpcUnavailableError` is not resent: one attempt, per a probe. A caller interrupt during the attempt ends the send with one attempt (probe), so an unmount or stop cannot reach the resend branch.
- **1(f), every caller (READ).** These resend: the web composer send and compact (useComposerSend.ts:1303, :1361), `useThreadLifecycle` (:583), `useComposerResume` (:132), the multi-model send (:165), `useCloudRun` (:72), side chat (:135), and steer/queue through `dispatchMode`. Desktop is the same code. Mobile's outbox passes false (threadOutboxDelivery.ts:309, :349). Mobile's project-thread start (:487) goes through `thread.create`, which is never resent; fork and queued-run start are also never resent. The commandId is allocated once per `startThreadTurn` call (commands.ts:644), so no retry layer above multiplies the two resends; cloud-run and multi-model retries are separate sends a person starts.
- **Tests (RAN).** dispatch.socketLoss.test.ts passes 7 of 7, and the web browser test passes 2 of 2 in chromium.

**Row 3 (READ)**
- 2(a) and the switchMap interruption hold; see the open questions.
- 2(d): only threads.ts:992 passes `onDefect`, and its behavior is unchanged. A cause that mixes an interrupt with the Die fails the "every reason is a Die" check and ends the stream, which is unchanged from before.
- 2(e): `requestGuarded` now reads the session, then opens one "EnvironmentRpc.request" span, so there is still one span per request. The "currentSession" span was already there. The only `runStreamGuarded` caller is vcsAction.ts:487. With no session, a denied caller now sees "unavailable" instead of the authorization error; no UI depends on it.
- Tests (RAN): client.streamRecovery 6, runtime.streamRecovery 1, client.test.ts green.

**Row 2 (READ, probes RAN)**
- 3(b): no flicker; `markSynchronizing` and the miss branch keep "deleted" (threads.ts:863-870, :949). A delete event still parks: after "miss, found, delete", `found` resets misses to zero (:915). "Delete, then remount" polls, which is upstream's design.
- 3(d): each resubscribe offer comes after one backoff. A stale offer causes one extra, interrupted subscribe, never two live streams. A single defect cannot run both `onDefect` and `restartAfterDefect`.
- 3(e): the sleeping miss fiber is inside the switchMap inner, so unmount (atom idle TTL 0, threads.ts:1056) or a session switch interrupts it. No leak.

**Row 4 (READ, tests RAN 12 + 26)**
- 4(b): the baseline is dropped when the session changed after `readAcceptingReady`. Authorization runs inside both `requestInSession` and `runStreamInSession`. A pinned session that has died fails the request at once, and the update is reported as not accepted, which is true.
- 4(c): older servers without `updateId` behave as before (serverUpdate.ts:85). A server that replays no ready costs at most 5 s and then uses today's wait.
- 4(d): a launcher trial publishes `ready` only after the launcher commits (serviceLauncherClient.ts:237-263 runs before serverRuntimeStartup.ts:852), so a slow but successful update cannot be reported as failed. A foreign outcome shows "The service launcher resumed without committing the requested server version."
- 4(e): both move-outs are verbatim by `diff` (RAN): only `export` changed in the moved block, plus the P3-6 cycle, and the importers resolve through `export *` from server.ts.

**Row 5 (READ, tests RAN 1 + 8)**
- The skip applies only once a transient failure is in hand, and the next supervisor attempt re-checks every route. Residual risk (INFERRED): a route that answers only after its check deadline is never tried while another route keeps failing transiently.
- A late Clerk read can overwrite a newer token of the same generation; that is harmless, at worst one earlier refresh. At most three unsettled reads per call.
- The relay half cannot run in production today: GOAT Connect routes are refused as "coming soon" (driver.ts:100-107).

**Mutations (RAN, each restored and confirmed with `cmp`)**

| Mutation | Result | Case that fails |
|---|---|---|
| M1 dispatch.ts: drop the resend cap | caught | "stops resending…" |
| M2 dispatch.ts: drop the `isRpcClientError` condition | caught | three cases |
| M3 dispatch.ts: the state race never gives up | caught | "holds…until disconnect", "gives up…blocked" |
| M4 rpc/client.ts: drop the `searchThreadStream` exclusion | caught | runtime.streamRecovery |
| M5 rpc/client.ts: drop the unknown-request-tag exclusion | caught | client.streamRecovery older-server case, computerUseReadiness |
| M6 rpc/client.ts: drop `options?.onDefect === undefined` | **uncaught** (P3-1) | none |
| M7 threadSubscriptionRecovery.ts: `parksDeleted` always true | caught | "keeps asking…after a miss" |
| M8 threadSubscriptionRecovery.ts: drop the reset in `applied` | **uncaught** (P3-2) | none |
| M9 serverUpdate.ts: drop the `acceptedAt` comparison | caught | both "fails promptly…" cases |

## The open questions

- **1(b):** A dying socket first fails the session's `disconnected` deferred (RpcClient.ts:1369 → session.ts:231) and broadcasts an `RpcClientError` to pending requests (RpcClient.ts:1390). Then `session.closed` (session.ts:483) ends the attempt and `clearLease` sets the session to None (supervisor.ts:1163, :402-405). Last, the phase moves to backoff, connecting or offline (:1340-1351, :1325, :1234-1242). "available" means the person turned the connection off (:1221-1229) and "blocked" comes only from a `ConnectionBlockedError` (:1301-1316), so the give-up branch cannot win on a socket death and the resend is live code. Accept; add the real-supervisor case (P3-5).
- **1(d):** On web the bubble stays, Send in that thread is refused with "Still sending your previous message.", and the only exit is disconnecting the environment, which gives up and restores the draft. Mobile opts out, and upstream has the same unbounded wait. I recommend a total bound of about 10 minutes, after which the draft is restored with an error; P2-1 needs it anyway.
- **2(a):** A subscribe on a dead session fails at once (RpcClient.ts:1411; GOAT never reopens a protocol's socket, protocol.ts:105). The 1 s retry is cut off by switchMap (rpc/client.ts:442) when the supervisor clears the session right after the disconnect hook. A ten-minute outage logs about one warning per durable subscription at the drop (roughly 10 to 15 lines on a web client) and sends zero requests until reconnect. Accept; "a pending retry does not resubscribe a replaced session" pins it.
- **2(b):** The counters reset on every new session or resubscribe because they live inside the switchMap branch (rpc/client.ts:457-458). Only a long healthy session with five or more stream failures pays 30 s, so I file it as P3-3.
- **2(c):** Accept as the honest limit. It is better than before, when the subscription silently died; the cost is one full snapshot and one warning per 30 s per affected subscription, and nothing tells the person to update. P3 suggestion: after several decode defects in a row with no good chunk between them, show an "update this app" message.
- **3(b):** Polling only runs while mounted: one 404 snapshot lookup per 30 s or less per mounted missing thread, with no flicker. Accept.
- **3(c):** An event-fold defect does not loop. It skips the batch silently because `lastSequence` already advanced, which is P2-2. A 30 s loop with full snapshots happens only for a defect in a snapshot applied with no data held, and then "Could not synchronize the thread." stays on screen. A Die plus interrupt ends the fiber (threadSubscriptionRecovery.ts:58-59), which is right for an unmount.
- **4(a):** `ready.at` is stamped once per process (serverRuntimeStartup.ts:852-860), stored, and replayed (serverLifecycleEvents.ts:37-49, ws.ts:3337-3340). That holds at the head, v0.1.10 and v0.1.5, and v0.1.1 also replays the stored snapshot (its ws.ts:3058-3076); `updateOutcome` exists since v0.1.1. A reconnect to the same process does not end the wait. Accept.

## Rule 3

Every changed line in an existing test file or testkit from my commits matches a ruling (RAN `diff`). Nothing is unmatched.
- **threadsSync.testkit.ts (d78a28f0e9):** the 11 lines equal upstream de21fbcff3's makeHarness hunks (`diff` empty) and are quoted in the record.
- **server.test.ts (f057ee1027):** the 155-line describe and the CONFIG, TARGET and session copies compare empty against the new file. The only other changes are four removed import names and one rewritten import line, as the record lists.
- **server.updateResume.test.ts (99e11d7480):** the hunks inside the moved block equal upstream a74ee4cc7c's `@@ -254` and `@@ -363` hunks (`diff` empty). Everything else is imports and appended cases.
- **runtime.test.ts (0477e43092):** 44 lines removed, which is the describe plus one blank, and the new file is identical. Cases: 29 + 2 = 31 at the head.
- **managedRelayState.test.ts (af3f5f62c1):** 37 lines added and none removed, equal to upstream apart from "GOAT Connect".
- **New tests:** no wall-clock reads, per-test timeouts, retries or polling loops. The sleeps in supervisor.silentRoute and server.updateResume are fixtures driven by TestClock. The `yieldNow` lines in managedRelayState.test.ts are from the initial commit.

## The author's claims

- **check:changed** (exit 0, 42 packages, 478 files, 9646 tests): this rests on the report; I did not run it, per the brief.
- **Fail-first results:**
  - Rows 1 and 4: inferred by me from mutations M2, M3 and M9.
  - Row 3: confirmed by M4 and M5.
  - Row 2: the 404 case is confirmed by M7. The claimed stale-replay protection does not exist (P2-2).
  - Row 5: rests on the report.
- **Focused runs (RAN):** all 12 client-runtime files (177 tests), the server receipt test (2) and the web resend test (2) passed.
- **goat-ci quick run 44200102994:** completed SUCCESS on 9fb762a2b5 (goat-check, goat-typecheck and goat-ci-result succeeded; no tests).

NOT RUN: `vp run check:changed`; any repo-wide check; a real-client pass on web, desktop or mobile; a mobile native run; an older GOAT binary; a live GOAT Connect relay; a test on the real supervisor; a measurement of shell or thread snapshot bytes per retry cycle; rows 6 to 9, budgets and the merge commit (the other review half).


