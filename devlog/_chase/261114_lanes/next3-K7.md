# next3 K7: client connection and protocol (plan)

Lane K7, host pen-macbookpro2 (`hostname`: gimbyeongjun-ui-MacBookPro-2). Worktree branch `chase/t3-261114-next3-k7-client-protocol`, HEAD `a608046c519b9377be3f03a5cdd6b376dd1b5c3f` = origin/chase/t3-261114-next3 = origin/dev (`git rev-parse HEAD origin/chase/t3-261114-next3 origin/dev`). Upstream pingdotgg/t3code fetched, upstream/main `51eb2d5437`. PLAN PHASE: no code commit, no code push.

## 1. Ancestry check: no row is on dev

Commands: `git merge-base --is-ancestor <sha> origin/dev` (all eleven: not an ancestor); `git log origin/dev --grep=<sha>` (no hit); the squash bodies of #3519 (`3ecea04f19`, 2015 lines) and #3660 (`42bf8633ce`, 1881 lines) grepped for all eleven shas (no hit); 10.025 lists all eleven as 미룸 (_fin/10/10.025 lines 1127-1176). Then each row's distinctive identifiers were grepped on origin/dev (packages, apps/server/src, apps/web/src, apps/mobile/src):

| row | upstream | identifiers grepped on dev | on dev? |
|---|---|---|---|
| a74ee4cc7c | server updates stop waiting 32 min when the host returns without this update's outcome (#27275) | SERVER_UPDATE_ACCEPTING_READY_TIMEOUT, runStreamInSession: none; state/server.ts:156 matchesServerUpdateResumeEvent has no acceptedAt | no |
| 962eeefa03 | retry messages after socket loss with the same command ID (#24761) | resendAfterSocketLoss, MAX_LOST_TRANSPORT_RESENDS: none. operations/dispatch.ts:9 dispatchMessage is only the 60 s timeout of ced85c64ff (#3233) | no |
| de21fbcff3 | a thread whose subscription dies on a defect resubscribes (#25919) | subscriptionRetryDelay, backOffAfterDefect, httpMisses: none; state/threads.ts:1017 onDefect only sets the error; :974 "missing" parks forever | no |
| 00f617db4e | recover subscriptions that stop on a healthy connection (#24400) | STREAM_FAILURE_RETRY_DELAY, isChunkDecodeDefect: none; rpc/client.ts:521 a transport failure waits for the next session | no |
| 2482b03a01 | threads load while the socket connects, fewer round trips (#35071) | resumeFrom (orchestration), OrchestrationV2ShellResumable, keepIdleConnections, canResumeShellFrom, routeKeepsItsHost: none; ws.ts:454 still SHELL_RESUME_MAX_GAP | no |
| 7c22095fcc | a stalled sign-in token or dead route no longer holds a reconnect 40 s (#34623) | CLERK_TOKEN_READ_TIMEOUT_MS, stillSilent: none; relay/managedRelayState.ts:86 joins any pending read | no |
| 8b2763f638 | each environment sends ~85% less data at launch (#35072) | providerCatalogDigests, providerStatusDeltas, omitProviders, catalogDigest (provider): none | no |
| 3a815e9749 | relative Markdown images in a remote thread no longer show the desktop's file (#35031) | hostOnly in assets/mediaSource/markdownImages: none | no |
| 1c9ea568a1 | report title regeneration outcomes (#31418) | lastTitleRegeneration, ThreadTitleRegenerationOutcome, threadTitleRegeneration.ts: none | no |
| c9f0caca1b | terminal attach with large history 5,555 ms to 751 ms (#33942) | retainedTerminalHistory, maxHistoryBytes: none; terminalOutput.ts:109 still trimBufferToBytes (next-N11 L27 says the same) | no |
| 6641231797 | notify when a delegated agent asks for a secret (#33585) | userOnly (pending request), turnItemCanChangeUserWait, waitsForInput: none | no |

Nothing to tick. Prerequisites found missing on dev (no chase record at all, `git grep` of the sha, PR number and subject over devlog on dev and on the records branch: no hit; both are inside 10.024's range `743bb8cf3d..fa2f4ff2a2`, whose card has no per-commit table):
- `dc3fdc6a3e` perf(mobile): threads open over the socket without an extra HTTP round trip (#33306): introduces socketOnlyOpen/failedSocketOnlyOpen (threads.ts) and rememberCheckedDescriptor (authorization/service.ts, driver.ts). de21fbcff3 edits its branch; 2482b03a01's authorization half is written on it.
- `60514be911` fix(server): phones get the approval push when a subagent waits (#24079): introduces subagentAwaitsApproval. GOAT has its own design instead (apps/server/src/relay/SubagentWaits.ts, packages/shared/src/agentAwareness.ts:48 subagentRequestAwareness), so 6641231797 adapts onto that; no port of 60514be911 is needed.
- `2917f28465` (#28487) was taken in 10.021 #311 as "adapt(부분: on-demand provider catalog 최적화는 미룸)": the deferred part is providerCatalogsOnDemand/catalogsPerCwd (22 added lines across ws.ts, rpc.ts, session.ts, state/server.ts, mobile). 8b2763f638's catalog-digest half is written on it.
- GOAT already has its own provider delta: `providerStatusChanges` (packages/contracts/src/rpc.ts:2224, server.ts:651-690, session.providerStatusChanges.test.ts), which sends only changed providers. 8b2763f638's providerStatusDeltas half duplicates it.

## 2. Rows (order of work)

Every row is C4 by the verdicts (client protocol). For each: what changes, files (GOAT paths), each way, stored data, negative cases, the failing test first.

### 1. 962eeefa03 command-id resend after socket loss (C4 protocol replay), S

What: `dispatchMessage` (operations/dispatch.ts) resends the same `message.dispatch` with the same commandId when the attempt ended by lost transport (interrupt-only cause or RpcClientError), waiting for a replacement session; it gives up when the supervisor reaches available-without-new-session or blocked, and after 2 resends. Upstream main's final shape (`git show upstream/main:packages/client-runtime/src/operations/commands.ts` 296-345) keeps ced85c64ff's 60 s timeout per attempt; GOAT ports that combined shape into dispatch.ts. `StartThreadTurnInput.resendAfterSocketLoss` (default true); mobile outbox (apps/mobile/src/state/threadOutboxDelivery.ts:308, :347) passes false because it owns its retry queue.
Authorization: the resend rides the same `request` path, so the server's RpcAuthorization checks it again on the new session; nothing is cached client-side. An EnvironmentAuthorizationError is a Fail that is not an RpcClientError, so it is never resent.
Each way: newer client, older server: GOAT servers already replay a receipt for the same commandId on the same thread (Orchestrator.ts:12648, :12871, CommandReceiptErrors.ts:36), and this predates the fork, so every server that a GOAT client reaches dedupes; older client, newer server: no change on the wire. Reconnect mid-send: the case itself.
Stored data: none (the receipt store is unchanged).
Negative cases, each a test: (a) server accepted the first frame and the socket dropped before the reply: the resend returns the receipt and the thread holds ONE user message (server-side contract test on the orchestrator: same commandId dispatched twice, one message.created event; if an existing test already proves it I cite it instead of adding one); (b) an authorization failure is not resent; (c) a frame that kills the socket twice stops after 2 resends and fails; (d) supervisor goes blocked: no resend, original failure surfaces; (e) mobile outbox path with resendAfterSocketLoss false fails fast (no wait).
Test first: new `packages/client-runtime/src/operations/dispatch.socketLoss.test.ts` with its own supervisor harness (SubscriptionRef state and session), so commands.test.ts keeps its harness (no rule 3).

### 2. de21fbcff3 thread subscription defect resubscribes (C4 subscription), M

What: threads.ts: a defect (Die) backs off (`subscriptionRetryDelay`, 250 ms doubling, 30 s cap) and resubscribes through a queue; a defect while applying items ends the stream and resubscribes for a fresh snapshot; a missing thread (HTTP 404) keeps retrying with backoff while mounted (it can be "not created yet") instead of parking forever; a delete event still parks. rpc/client.ts exports `subscriptionRetryDelay`. Adapted WITHOUT dc3fdc6a3e: the socket-only branch (failedSocketOnlyOpen) has no counterpart on GOAT and is left out.
Authorization: an authorization failure stays on onExpectedFailure (rpc/client.ts:537 isAuthorizationFailure) and is never retried; only Die causes back off.
Each way: client-only, no wire change. Older server: same subscribe input. Reconnect mid-backoff: the session switchMap interrupts the sleep and resubscribes on the new session (tested).
Stale replay negative: a resubscribe after a defect sends afterSequence from `lastSequence` only when data is held; a defect during apply resubscribes without afterSequence when the apply did not land (fresh snapshot), so stale rows are never resumed past a half-applied batch (tested). Others: a 404 that becomes present on the next retry shows the thread; repeated defects back off to 30 s, not a hot loop (TestClock); retries reset after items apply.
Test first: new `packages/client-runtime/src/state/threads-sync.defect.test.ts`. threads-sync.test.ts is 2099 at its entry 2099 and its `makeHarness` is local to it: a verbatim move-out commit of the harness into `threads-sync.testkit.ts` (imports only, no expectation changes) comes first; I ask rule 3 for that one if the coordinator reads a moved harness as a setup change (decision D5).

### 3. 00f617db4e subscriptions that stop on a healthy connection recover (C4 subscription), S

What: rpc/client.ts subscribeDynamicMapped: a transport failure or a chunk SchemaError defect (only when the caller has no onDefect) resubscribes on the same session after 1 s doubling (retryExpectedFailureAfter when given); searchThreadStream keeps today's "wait for the next session". This is every durable subscription on web and mobile: shell, threads, server config, terminals, memory, hub nodes.
Each way: client-only. Older server: resubscribe uses the same input. Newer server sending a chunk an older schema cannot decode: today the subscription silently ends; after: it resubscribes and gets a snapshot (and hits the same chunk again, backing off to 30 s; logged warning). That is the honest limit; noted.
Negative cases: an interrupted session (switchMap) cancels the retry; an authorization failure is not retried here; a caller with onDefect keeps owning its defects (threads after row 2); a finite search does not restart.
Test first: new `packages/client-runtime/src/rpc/client.streamRecovery.test.ts` and `state/runtime.streamRecovery.test.ts` (client.test.ts 1035 and runtime.test.ts 1276 are at their entries). Existing client.test.ts:460 "reports %s subscription defects and resubscribes on the next session" has onDefect set and should not move; if it does, rule 3.

### 4. a74ee4cc7c accepted server update recovery binds to the accepting process (C4 session-bound authorization), M

What: for boot-service updates (contracts environment.ts:72 has the same methods), the client reads the current process's `ready.at` before the request (5 s cap), sends the request on THAT session (`requestInSession` / new `runStreamInSession`), and ends the 32-min wait as soon as a ready from any other process arrives; validation then reports a missing or foreign outcome. rpc/client.ts exports `currentSession`, `requestInSession`, new `runStreamInSession` (authorization moves inside it, so it is still checked per call).
Each way: older server without updateOutcome: `updateId` undefined, path unchanged; server that never replays ready on subscribe: the 5 s cap leaves no baseline and today's wait applies. Older client: unchanged wire.
Negative cases: a session replaced between the baseline read and the request leaves no baseline (acceptedAt undefined) so a stale ready cannot end the wait; a foreign outcome id fails with ServerUpdateTerminalError; authorization denied on runStreamInSession fails before the stream opens.
Test first: new `packages/client-runtime/src/state/server.updateResume.test.ts` (server.test.ts 1411 at entry). Upstream rewrote the existing "accepted server update recovery" harness; I will not, and ask rule 3 only if an existing expectation breaks.

### 5. 7c22095fcc stalled token read and dead route (C4 authentication), S

What: driver.ts connectOverRoutes stops waiting on routes still silent after their check once another route failed transiently; managedRelayState.ts: a Clerk token read over 4 s is abandoned (left to fill the cache) and the next reader starts a fresh one, 3 attempts then a timeout error. The relay half only runs for GOAT Connect, which is not available yet (driver.ts:106), so it is unit-proven only.
Negative: a timed-out read that later resolves fills the cache without overwriting a newer token from a later generation (tokenProviderGeneration check kept, tested); a token provider swap mid-read is honored; a stale token is not returned past CLERK_TOKEN_EXPIRY_SKEW_MS.
Tests: managedRelayState.test.ts (272 lines, no entry) in place; the driver case in new `connection/supervisor.silentRoute.test.ts` (supervisor.test.ts 3099 at entry).

### 6. 3a815e9749 hostOnly media files (C4 asset wire), S

What: a Markdown image written relative to the workspace resolves to a media-file resource with `hostOnly: true`; the client then never falls back to a same-path file on the local machine (assets.ts:276). Contract: AssetResource media-file `hostOnly: optionalKey(Literal(true))`.
Each way: newer client, older server: the asset request schema on an older server is a Struct without onExcessProperty: error, so the extra key is ignored (I check this decode with a test against dev's decode); older client, newer server: key never sent, today's behavior. Mobile: uses resolveMediaSource from client-runtime (checked at build; if mobile has its own classifier it gets the same flag).
Negative: an absolute path keeps today's local fallback; hostOnly on a missing remote file shows the error, not the desktop's file.
Rule 3: mediaSource.test.ts:137 expectation gains `hostOnly: true` (upstream changed exactly that line). Test first: assets.test.ts (535, no entry) gets the remote-thread case.
Visible: P1 row (web, remote thread with a relative image).

### 7. 6641231797 parent shows "Input needed" when a delegated agent asks for a secret (C4 secret-request wire), M

What: PendingRuntimeRequestSummary `userOnly` (optional boolean) set by GOAT's ProjectionPendingRequest.ts:23 secretRequestAsPendingInput, for `secret_request` AND GOAT's `human_handoff` (only a person answers either); shared agentAwareness: a subagent's user-only wait rolls up to the parent as waiting_for_input (`waitsForInput`), adapted into SubagentWaits.ts and subagentRequestAwareness; ShellStream and AgentAwarenessRelay keep turn-item updates that can start or end a user wait; client threadShell.ts rolls user-only cards up to the parent.
Each way: older client: ignores userOnly, keeps today's (no parent mark for a child question); older server: no userOnly, newer client behaves as today. Stored data: the shell projection is rebuilt from events; a secret card pending before upgrade gets userOnly on its next projection write. I check whether projected shells are persisted and, if so, whether a stale row needs a reprojection; reported before code.
Negative: an ordinary child question stays with the coordinator (no parent mark, tested); a secret card answered clears the parent mark; a coordinating agent cannot see the secret (no wire field carries the value; userOnly is a flag only); archived child gives no mark.
Rule 3: ShellStream.test.ts:50-53 and :304 (subagent turn-item.updated filtering) change with the new keep rule. Tests: threadShell.test.ts (639) in place; relay cases in new `relay/AgentAwarenessRelay.userWait.test.ts` (859 + 154 would pass 1000).

### 8. 1c9ea568a1 title regeneration outcomes (C4 title wire and MCP output), M-L

What: `thread.title-regeneration.completed` command gains optional `outcome` (renamed, unchanged, failed + message); the thread and shell gain `lastTitleRegeneration` (+Json variants); MCP thread detail gains `lastTitleRegeneration`; client-runtime adds `regenerateTitle` (arms with its own commandId, waits on the shell for the outcome or a disconnect) and `environmentConnectionAtom`; web (Sidebar.tsx:2170, :2621, useThreadActionMenu.ts:280, useThreadLifecycle) and mobile (useThreadListActions.ts:556) show the outcome toast.
Each way: older client: optional field ignored, sees the title change as today; older server: no lastTitleRegeneration, regenerateTitle resolves null on the sequence check and the client shows today's behavior (no "unchanged" toast). MCP: optional field, older agents ignore it.
Stored data: lastTitleRegeneration lives in the projected thread (optional, absent in old rows); the event payload gains an optional field. No migration; a stored older event decodes (test).
Negative: an outcome for another requestId is ignored; a disconnect resolves null (no endless spinner); a thread deleted mid-wait resolves null; a failed generation reports its message without leaking provider errors beyond today's text.
Rule 3 expected: mobile useThreadListActions.test.ts (mock return and mutationCases row), ThreadTitleRegenerationService.test.ts (a die case becomes an outcome), threadCommands.test.ts harness. Exact before/after sent when I reach the row.
Visible: P1 row (web toast, mobile alert).

### 9. c9f0caca1b terminal attach sends only retained history (C4 terminal wire), S, split

Client and contract half now: contracts terminal.ts exports `retainedTerminalHistory`, TerminalAttachInput `maxHistoryBytes` (optional Int >= 0); client terminal.ts sends it; terminalOutput.ts uses the shared trim. Older server ignores the key (non-strict Struct; checked); older client sends none and gets full history.
Server half (apps/server/src/terminal/Manager.ts attachOutputStream trims snapshots) WAITS for #3696 on the integration head: #3696 is OPEN (`gh pr view 3696`) and changes Manager.ts and code-budgets.json, and the plan holds terminal/ changes until it lands.
Negative: maxHistoryBytes 0 gives empty history; a cut inside a multibyte char starts at the next boundary; BOM kept (ignoreBOM); resync applies the same bound.
Rule 3: runtime.test.ts:314-340, five `toEqual(input)` expectations gain maxHistoryBytes. Manager.test.ts at entry: server test in new `terminal/Manager.retainedHistory.test.ts`.

### 10. 2482b03a01 prepare-time shell load and resumable HTTP shell (C4 auth and wire snapshot), L: DECISION D1 first

Server: HTTP shell route answers `{resumable:true}` to `resumeFrom` when the socket can replay; shell HTTP snapshot carries `projectIdentities`; subscribe input `knownProjectIdentities`; descriptor capabilities `shellThreadFamilies`/`shellOlderSettled`; keep-alive for idle HTTP connections. Client: shell.ts loads the HTTP snapshot during prepare; authorization/service.ts carries the descriptor read at mint (on dc3fdc6a3e). Each way, if ruled in: newer client vs older server: no capability, so no prepare-time load (today's order); older client vs newer server: no resumeFrom, full snapshot as today. Negative: rows loaded early for another build or other omissions are replaced, never resumed; an HTTP answer never lands on rows the socket moved past (the subscription waits; 3 s cut once held rows can resume); a dropped /api does not hold the connect.

### 11. 8b2763f638 smaller launch config (C4 wire projection), M: DECISION D2 first

Halves: (a) refresh reply `omitProviders` (independent, small); (b) providerStatusDeltas: duplicates GOAT's providerStatusChanges; (c) catalog digests: needs 2917f28465's deferred providerCatalogsOnDemand.

## 3. Exports and shared surfaces changed (K2, K10, M3 build on these)

- packages/client-runtime/src/rpc/client.ts: exports `currentSession`, `requestInSession` (made public), new `runStreamInSession`, new `subscriptionRetryDelay`; behavior of every `subscribeDynamic*` subscriber on transport failure and chunk decode defects (row 3).
- packages/client-runtime/src/operations/dispatch.ts `dispatchMessage(command, resendAfterSocketLoss)`; operations/commands.ts `StartThreadTurnInput.resendAfterSocketLoss`.
- packages/client-runtime/src/state/server.ts `matchesServerUpdateResumeEvent(result, event, acceptedAt?)`, `validateServerUpdateReadyEvent` (foreign outcome); these three plus the nudge move verbatim to a new `state/serverUpdate.ts` (move-out), re-exported from server.ts so importers do not change.
- packages/client-runtime/src/state/threads.ts internal; `markdownImages.ts` MarkdownImageSource WorkspaceFile `relative?`; `mediaSource.ts` resolveMediaSource adds hostOnly; `state/runtime.ts` new `environmentConnectionAtom`; `state/threadCommands.ts` new `regenerateTitle`, `armTitleRegeneration`; new `state/threadTitleRegeneration.ts`; `state/threadShell.ts` roll-up type.
- packages/contracts: assets.ts AssetResource media-file `hostOnly`; terminal.ts `retainedTerminalHistory`, TerminalAttachInput `maxHistoryBytes`; orchestrationV2.ts PendingRuntimeRequestSummary `userOnly`, AppThread/ThreadShell(+Json) `lastTitleRegeneration`, title-regeneration completed `outcome`; threadTitle.ts `ThreadTitleRegenerationStatus`, `ThreadTitleRegenerationOutcome`, `LastThreadTitleRegeneration`; orchestratorMcp.ts thread detail `lastTitleRegeneration`. Rows 10 and 11 add more only if ruled in.
- packages/shared/src/agentAwareness.ts: new `turnItemCanChangeUserWait`, SubagentRequestAwareness `waitsForInput`.

## 4. Budgets (oxlint-plugin-goat/code-budgets.json, countLines = wc -l here, all files end in a newline)

Files at their entry that a row writes into (real length = entry): client-runtime state/server.ts 1776, operations/commands.ts 1202, state/threads.ts 1101, contracts orchestrationV2.ts 4438, orchestratorMcp.ts 1083, apps/web ChatMarkdown.tsx 1679, Sidebar.tsx 3331, apps/server Orchestrator.ts 13528, OrchestratorMcpService.ts 3871, terminal/Manager.ts 3122 (after #3696, at its new entry), plus rows 10-11: ws.ts 3521, server.ts 1316, rpc.ts 2788. Each gets a verbatim move-out commit first (a self-contained block into a new sibling module, re-exported where consumers import it), sized at least the lines the row adds, every removed-and-not-re-added line explained in this record. Planned: serverUpdate.ts out of state/server.ts (~110 lines); a helper group out of threads.ts (>= 55); a command-input group out of commands.ts (>= 5); title schemas live in threadTitle.ts and a block of orchestrationV2.ts moves out (>= 30); one-line or few-line rows (ChatMarkdown +1, orchestratorMcp +1, Orchestrator +9, OrchestratorMcpService +7, Sidebar) each get a small verbatim move-out.
Files without an entry that would pass 1000: AgentAwarenessRelay.test.ts (859+154), authorization/layer.test.ts (965+70), contracts environmentHttp.ts (996+6): new sibling files instead.
Test files at entry (server.test.ts 1411, threads-sync.test.ts 2099, client.test.ts 1035, runtime.test.ts 1276, supervisor.test.ts 3099, Manager.test.ts 2019, ws.test.ts 1331, shell-sync.test.ts 1111, session.test.ts 1013): new sibling test files (D4). Moving or renaming a test file updates scripts/lib/goat-rename TEST_TITLES (rules-meta.ts:264) in the same commit.

## 5. Rule 3 lines I expect to ask for (exact before/after through needs_input when the row is reached, nothing changed before the word)

1. mediaSource.test.ts:137 (row 6): `resource: { _tag: "media-file", threadId, path: "/repo/screens/logo.svg" }` gains `hostOnly: true`.
2. runtime.test.ts:314, :316, :325, :328, :340 (row 9): attach inputs gain `maxHistoryBytes: DEFAULT_MAX_TERMINAL_BUFFER_BYTES`.
3. ShellStream.test.ts:50-53, :304 (row 7): subagent turn-item.updated filtering.
4. Row 8: useThreadListActions.test.ts (mock return, mutationCases row), ThreadTitleRegenerationService.test.ts (die case), threadCommands.test.ts harness.
5. Possibly threads-sync.test.ts harness move (row 2, D5) and any existing expectation rows 1-4 break (named then).

## 6. Order and size

1 962eeefa03 (S), 2 de21fbcff3 (M), 3 00f617db4e (S): the two subscription recoveries and the command-id resend first, as ruled; upstream order in rpc/client.ts is a74 -> de21 -> 00f6, and de21's helper is used by 00f6, so de21 precedes 00f6. Then 4 a74ee4cc7c (M), 5 7c22095fcc (S), 6 3a815e9749 (S), 7 6641231797 (M), 8 1c9ea568a1 (M-L), 9 c9f0caca1b client half (S; server half after #3696), then 10 and 11 per D1/D2. One commit per row plus the move-out commits before it. Lane size L (rows 1-9 about 1,400 changed lines with tests); L+ if D1 and D2 bring in dc3fdc6a3e and the catalog prerequisite.

## 7. Decisions for the coordinator

D1 (2482b03a01 and dc3fdc6a3e). 2482b03a01's client authorization half (authorization/service.ts: descriptor carried with the minted token, `rememberCheckedDescriptor(..., keepsItsHost)`, nearby-address timeouts) is written on dc3fdc6a3e (#33306, threads open over the socket without an HTTP round trip), which is not on dev and has no chase record. Options: (A, my recommendation) add dc3fdc6a3e as a K7 prerequisite row right before 2482b03a01 (9 client-runtime files, +373/-104, no wire change of its own), so both port as upstream wrote them; (B) port only 2482b03a01's server and contract half (resumable HTTP shell, projectIdentities, capabilities, keep-alive) and the client prepare-time shell load, skipping the descriptor carry; (C) defer 2482b03a01 to a later cycle with dc3fdc6a3e. de21fbcff3 does not wait on this: it adapts without the socket-only branch either way.

D2 (8b2763f638). Its providerStatusDeltas half duplicates GOAT's own `providerStatusChanges` (contracts server.ts:651-690, rpc.ts:2224), which already sends only changed providers; its catalog-digest half needs 2917f28465's providerCatalogsOnDemand that 10.021 #311 deferred. Options: (A, recommended) port only the `omitProviders` refresh reply (mobile and web callers that only wait on a refresh) and skip the rest with these reasons; (B) port the deferred providerCatalogsOnDemand first, then catalog digests, skipping deltas; (C) skip the row.

D3 (c9f0caca1b split). Client and contract half now, server half (Manager.ts) after #3696 is merged into the integration head, as one more commit then. Or hold the whole row until then.

D4 (test placement). Most module test files are at their budget entry. I plan new sibling test files (`dispatch.socketLoss.test.ts`, `threads-sync.defect.test.ts`, `client.streamRecovery.test.ts`, `server.updateResume.test.ts`, ...) for the failing-first tests, rather than move-outs from test files, which would move existing tests and touch TEST_TITLES. Please confirm.

D5 (row 2 harness). threads-sync.test.ts's local `makeHarness` is needed by the new defect tests. I propose a verbatim move of it into `threads-sync.testkit.ts`, with threads-sync.test.ts importing it (no setup or expectation changes). Rule 3 allows "an import"; I read the move as within that, and ask you to confirm.

## 8. Risks

- Row 3 changes every durable subscription's failure path; a server that keeps sending a chunk an older client cannot decode makes that client resubscribe with backoff up to 30 s instead of going quiet. Bounded and logged, but visible as reconnect traffic.
- Row 1's double-apply safety rests on the server receipt replay; a server-side test proves it on GOAT before the client resend lands.
- Row 7 on persisted shells: a secret card pending at upgrade may not mark its parent until the card's next update (checked before code).
- K2, K10, M3 merge after K7: rpc/client.ts, threads.ts, commands.ts/dispatch.ts, orchestrationV2.ts and threadCommands.ts are the likely conflict points; the move-outs change line positions in those files.

## 9. NOT RUN expected

- Live GOAT Connect relay (row 5 Clerk half): GOAT Connect is not available; unit tests only.
- Real-client captures (rows 6, 7, 8): P1 rows, no dev server in this lane.
- Older GOAT server binaries: older-server cases are proven by schema decode tests against the older shapes and by optional-field tests, not by running an older release.
- Mobile native run: client-runtime tests cover the mobile paths; the mobile outbox (row 1) gets a unit test, no simulator.
- Row 9 server half until #3696 is on the integration head.



## Coordinator ruling, run 1817 (2026-11-17 21:38:37 UTC): sections I, III, IV, V and K7's, verbatim

I. #3696 MERGED; INTEGRATION HEAD c995c5427a
- The fresh C4 review of #3696 at b7672aa5f8 was APPROVE WITH NITS (six P3, no P0 to P2; report /Users/jun/handoff-in/chase/pr3696-T1b-review-b7672aa5.md). MERGED BY ME 21:29:00 UTC, dev = 8c59f73519663bdb1fff3346d1caedf06083ddf7 (goat-ci-result success on the head, run 44173778052). goat#3694 closed with it.
- chase/t3-261114-next3 fast-forwarded to dev 8c59f73519 (this is the one dev merge), then K10's shared pre-commit 2bc2e7761b merged by me after a line-by-line read (useComposerSend.ts:301-407 at a608046c51 equals useComposerSend.ssh.ts:54-160 byte for byte; the builder, the wrapper and the two call sites read). chase/t3-261114-next3 = c995c5427accaaa92dadac50ec756c35f4b92034 (parents 8c59f73519 and 2bc2e7761b; plain push). One wording nit for K10's own lane, no new commit on the pre-commit: the new file's doc comment says "rebuilt each render as before" while it is built per call.
- Every lane with no code commit runs git merge --ff-only origin/chase/t3-261114-next3 before its first commit and reports the sha. K2, which is coding, keeps its plan: one merge of the integration head after K7 lands, and it does not write into useComposerSend.ts before that merge.

III. SHARED AT-ENTRY FILES (your list of 22:0x)
The pre-commit branch stays the tool for one case only: two lanes need the SAME block moved, or a lane needs room in a file before the lane that frees it lands. For the rest, a claims table:
1. On card 10.028 keep one table "at-entry move-outs": file, lane, the block as path:line range at c995c5427a, the new module, lines freed. A lane writes its row BEFORE it cuts the block. You refuse a row that overlaps another lane's range and bring an overlap you cannot settle to me.
2. Every lane nets zero or less in each at-entry file by its own commits (its move-out frees at least what its rows add). No lane leaves a file longer than its entry at the cut.
3. code-budgets.json conflicts at a lane's merge of the integration head are settled by countLines of the merged file, never by a number above the entry at 8c59f73519.
4. Same-basename entries in your list are settled by the records: K7 means packages/client-runtime/src/state/server.ts (and apps/server/src/server.ts only for rows 10 and 11, which leave K7, see VI) and apps/server/src/terminal/Manager.ts.
5. Order of landing for the meeting points: K7 first in packages/contracts and packages/client-runtime (as ruled); K1's Orchestrator.ts, orchestrationV2.ts and orchestratorMcp.ts move-outs are K1's own blocks (dispatchPullRequestWatchSync, the watch.sync struct, OrchestratorMcpThreadPullRequest) and K7 and K10 claim other blocks; MessagesTimeline.tsx, MessagesTimeline.logic.ts, ThreadFeed.tsx, thread-work-log.tsx and ThreadDetailScreen.tsx: K10 before M3's O22 (M3 D3); apps/mobile/src/features/pull-requests/: K2 before M3 (M3 D7).

IV. RULE 3, ONE STANDING AUTHORISATION
Rule 3 stays: no existing test expectation changes without my word. To stop one round trip per line, my word is given in advance for the MIRRORED case only, when all three hold: (1) the upstream commit being ported changes the same assertion in upstream's own copy of that test in the same way; (2) the lane quotes both hunks, upstream's and GOAT's, before and after, in its record BEFORE the commit; (3) the commit changes no other existing expectation. The fresh review checks every one; one it cannot match to upstream's hunk is a P2. Everything else still comes to me with exact before and after: GOAT-own tests with no upstream counterpart, deleted or retitled tests, moved harnesses, and anything a lane is unsure of.

V. CAPS, PLACEMENT, T1c
- Coding lanes at once: seven, K4 included (K2, K7, K1, K10, M3, K4, and K5). Fresh reviews at once: two, unchanged. No further lane starts without a plan ruled by me.
- K5 starts now only on a Mac that host.status placement shows with at most one lane and no warning or critical pressure; the Air is not doubled up (it went critical under one lane in next). Otherwise K5 takes the slot of the first lane that reaches READY. Tell me the host.
- T1c, a new small branch by T1's thread on pen-macmini: chase/t3-261114-next3-t1c-lease-pins from c995c5427a, tests and one budget entry only, no production line. Content, from the #3696 review: P3-1 an idle subprocessInspector in ThreadWorkspaceService.setupLockOrder.test.ts's makeWithOptions (as Manager.leaseOrder.test.ts has), so the three setup cases stop reading the host's real ps; P3-2 the probe as a case: the holder's open starts a shell while a person's restart waits, the restart returns the setup's pid, nothing is killed, one spawn; P3-3 an overtaken request that would start a fresh shell in a worktree its thread left is refused as moved and spawns nothing; P3-5 a first attempt in a free folder starts and never calls current; P3-4 RULED: the guard at terminalLeaseOrder.ts:75 STAYS. A close is the last word to the request that was waiting; a later open by someone else was a new request and was served; the waiting request is owed only the truth about the terminal now, the terminal if one is there and "Unknown terminal" if not, and it never starts a shell that a person closed and housekeeping then removed. Same answer as dev. Two cases pin it: close then newer open then rerun returns the newer terminal; close, newer open, idle close, rerun answers Unknown terminal and spawns nothing. P3-6: code-budgets.json Manager.ts 3118 becomes 3116; the corrected wording of the exit row (true only for a request nothing overtook), the close row (it also covers GOAT's own closes: a cancelled launch and observed checks) and one Limits sentence (a setup whose thread was rebound while its open waited still runs in the old folder) go into T1c's commit message and its record; I add a comment on #3696 when T1c is in. Each new case must fail under its mutation from the review (the lane runs the mutation and records the result). I read T1c and merge it without a fresh review if it is test-only. T1c lands before K4's goat#3681 and goat#3690 commits; pen-macmini carries T1 and K4 with one heavy job at a time, then T3.

YOUR SECTION:
K7 (client connection and protocol): GO on pen-macbookpro2, rows 1 to 9 in the plan's order. READ BY ME: next3-K7.md whole; Orchestrator.ts:12640-12656 and :12866-12876 (the receipt replay), rpc.ts:2224 and server.ts:689 (providerStatusChanges). NOT READ: the eleven upstream commits.
- D1 (2482b03a01 with dc3fdc6a3e): both leave K7 and become lane K7b, same thread and host, after K7's READY: dc3fdc6a3e as the prerequisite row, then 2482b03a01 as upstream wrote it (option A, in a second lane). K7b sends its own C4 plan first (dc3fdc6a3e's ancestry, each way, the authorization negatives) and gets its own fresh C4 review. Reason: the descriptor carry and the resumable HTTP shell are an authentication and snapshot change that deserves a review of its own, and K2, K10 and M3 wait on K7's exports.
- D2 (8b2763f638): A now, only the omitProviders refresh reply, inside K7. The delta half is skipped as a duplicate of providerStatusChanges, said in the record. The catalog half goes to K7b as option B (providerCatalogsOnDemand, then digests), with one number in its record: the bytes of the launch config before and after on a seeded dev database.
- D3: the whole row is now in K7. #3696 is in the integration head. Client and contract half in its order; the server half as its own commit after it, the trim logic in a new terminal module and a hook in Manager.ts that fits its entry (3116 lines against 3118 until T1c lowers it to 3116: claim your block first).
- D4: accepted, sibling test files.
- D5: accepted as within rule 3: one commit that only moves makeHarness into threads-sync.testkit.ts and adds the import, byte for byte, no setup or expectation change, entry lowered. The review checks the bytes.
- Rule 3 items 1 and 2 (mediaSource.test.ts:137 gains hostOnly: true; runtime.test.ts:314, :316, :325, :328, :340 gain maxHistoryBytes) fall under IV if upstream's hunks match; items 3 to 5 come to me unless they meet IV.
- Conditions: (a) row 1: the server test that the same commandId dispatched twice on one thread leaves one user message lands before the client resend; only message.dispatch is resent; on web the failed-send restore runs only after the resend loop has given up, with a test that a send never ends both sent and restored to the draft. (b) rows 2 and 3: a resubscribe closes the old stream first; a test asserts one live subscription after a recovery; backoff is capped at 30 s and a repeating decode defect logs once per step. (c) row 7: say per client (web, desktop, mobile, the phone push) what a parent shows for a child's secret request and for a human handoff; the persisted-shell answer comes before code as you planned. (d) row 8: lastTitleRegeneration in the MCP thread detail is optional, with a decode test of an older server's payload, because the CLI and fleet health decode those results strictly (K1's finding, cli/thread.ts and fleet/health/Health.ts:44-45). The same holds for any field any lane adds to a strictly decoded MCP result. (e) K7 lands first; say in READY which exports changed against section 3.

## Coordinator, 2026-11-17 21:43:15 UTC, B (IV widened), verbatim

B. IV IS WIDENED, for every lane (relay it). The standing authorisation also covers, under the same three conditions (upstream's own copy changes the same way; both hunks quoted in the record before the commit; nothing else existing changes): (i) fixture, mock and helper lines in a test file or testkit, where upstream changes its own copy of that fixture or helper the same way; (ii) an existing case whose title and body become upstream's verbatim text of that same case. Still to me, with exact before and after: a deleted test or test file, a moved harness, a test with no upstream counterpart, and any case where GOAT's result differs from upstream's text by more than names.

Quote it in next3-K7.md. It does not cover D5's makeHarness move (already ruled separately) or anything listed as "still to me".

## Build log

- Fast-forward: `git merge --ff-only origin/chase/t3-261114-next3` landed HEAD on c995c5427accaaa92dadac50ec756c35f4b92034 (`git rev-parse HEAD`). No package.json or lockfile change between a608046c51 and c995c5427a (`git diff --stat` empty), so no install.
- D5 is moot: at c995c5427a, makeHarness already lives in packages/client-runtime/src/state/threadsSync.testkit.ts (threads-sync.test.ts:51-57 imports it). No move commit; the new defect tests import it from there.
- First commit b708fe59c201973f86bcef5df1c51457d1201237 test(server): a resent message.dispatch with the same command id lands once. New file apps/server/src/orchestration-v2/Orchestrator.messageReceiptReplay.test.ts (condition (a), server half before the client resend). `vp test run` on it: 2 passed (start_immediately, queue_after_active). Mutation: resend with a different commandId and messageId: both cases fail at the replayed assertion (AssertionError). It pins existing server behavior, so it passes on the base by design. `vp fmt` and `vp lint` on the file: clean.

## At-entry move-out claims (rows for card 10.028; sent to the coordinator, not cut until ruled)

| file | lane | block at c995c5427a | new module | lines freed (block) | for row |
|---|---|---|---|---|---|
| packages/client-runtime/src/operations/commands.ts | K7 | 201-256 (ForkThreadFromRunInput through EditQueuedRunInput, interfaces only) | packages/client-runtime/src/operations/commandInputs.ts (re-exported as types from commands.ts) | 56 | 1 |
| packages/client-runtime/src/state/threads.ts | K7 | 66-101 (formatHistoryError, ThreadResumeSnapshot, ThreadResumeCache, matchesThreadSnapshot) | packages/client-runtime/src/state/threadResumeCache.ts | 36 | 2 (recovery logic itself goes in a new state/threadSubscriptionRecovery.ts) |
| packages/client-runtime/src/state/server.ts | K7 | 107-365 (ServerUpdateResumeTimeoutError through resolveServerUpdateProgressResult) | packages/client-runtime/src/state/serverUpdate.ts (re-exported from server.ts) | 259 | 4 |
| apps/web/src/components/ChatMarkdown.tsx | K7 | 259-267 (WINDOWS_DRIVE_PATH_REGEX, normalizeMarkdownLinkHrefKey) | apps/web/src/components/chatMarkdownLinkHref.ts | 9 | 6 |
| packages/contracts/src/orchestrationV2.ts | K7 | 625-655 (OrchestrationV2GoalCommand, parseGoalCommand) | packages/contracts/src/goalCommand.ts (re-exported) | 31 | 7, 8 |
| packages/contracts/src/orchestratorMcp.ts | K7 | 685-696 (comment and clampedPositiveInt) | packages/contracts/src/mcpClampedInt.ts | 12 | 8 |
| apps/server/src/orchestration-v2/Orchestrator.ts | K7 | 401-415 (OrchestratorThreadAboveModeLimitError) | apps/server/src/orchestration-v2/OrchestratorModeLimitError.ts (re-exported) | 15 | 8 |
| apps/server/src/mcp/OrchestratorMcpService.ts | K7 | 515-530 (runtimeModeRank, interactionModeRank) | apps/server/src/mcp/orchestratorMcpModeRank.ts | 16 | 8 |
| apps/server/src/terminal/Manager.ts | K7 | 409-425 (normalizeChildCommandName) | apps/server/src/terminal/childCommandName.ts | 17 | 9 server half |
| apps/server/src/ws.ts | K7 | 556-576 (doc comment and readClientOwners) | apps/server/src/wsClientOwners.ts | 21 | 10 (omitProviders) |
| packages/contracts/src/rpc.ts | K7 | 837-858 (WsPreviewSessionsSubscribeRpc, WsPreviewSessionsControlRpc, WsPreviewSessionsFramesRpc) | packages/contracts/src/rpcPreviewSessions.ts | 22 | 10 (omitProviders) |

Sidebar.tsx (row 8) is planned to net zero or less (upstream's own change nets -10 by moving toast code to a helper); if GOAT's adaptation would grow it, a claim comes first. Net freed per file is the block less the import or re-export lines it costs; each move-out commit reports the real number.



## Coordinator, 2026-11-17 21:52:47 UTC, IV (iii), verbatim

IV gains one more mirrored-free case, for every lane (relay it): (iii) a test file that moves with the module it tests, where the commit is a rename and the only changed lines are import paths to the moved module, with TEST_TITLES updated in the same commit when the file is listed there. Titles, bodies, setup and expectations byte for byte; the review checks the rename with git show -M, and anything more is a P2. A harness moved out of a test file into a testkit still comes to me.

## Lane coordinator, claims ruled (records 80779b9a5e)

All eleven claims accepted. Correction to claim 5: packages/contracts/src/orchestrationV2.ts:624-653 (line 624 "export type OrchestrationV2GoalCommand =" through parseGoalCommand's closing brace at 653), not 625-655.

## Build log, rows 1 and 2

- d9c7ecbbc0 move-out claim 1: commands.ts:201-256 (55 interface lines + the blank at 256) -> operations/commandInputs.ts:11-65, byte-identical (`diff` of the two ranges empty). commands.ts 1202 -> 1168 (block 56; an 11-line type import and an 11-line type re-export added). Entry 1202 -> 1168. Only other change: `export` on `interface CommandMetadata` (line 41) for the new module's type import.
- b4751f97de row 1 (962eeefa03): dispatch.ts resend loop, upstream main's shape with the 60 s per-attempt bound. Adaptation: dispatchMessage(resend, command) takes the flag first so each commands.ts call site changes one line. commands.ts 1168 -> 1170 (the field and its comment); the lane nets -32 in the file against 1202. Tests: dispatch.socketLoss.test.ts (7; the four resend cases failed on the base with a single attempt), useComposerSend.resend.browser.test.tsx (2, condition (a)). Existing suites unchanged and passing: commands.test.ts + commands.performance.test.ts, the mobile outbox (4 files, 81 tests). Typecheck exits 0 for client-runtime, mobile and web.
- 37f08d1690 move-out claim 2: threads.ts:66-100 + blank 101 -> state/threadResumeCache.ts:7-41; the only changed text is `export` on the four declarations. threads.ts 1101 -> 1071 (block 36, 6-line import). Entry 1101 -> 1071.
- Row 2 (de21fbcff3), adapted without dc3fdc6a3e's socket-only branch. The recovery logic lives in a new state/threadSubscriptionRecovery.ts (defect backoff, a 404 retried with backoff while mounted, a defect during apply restarts the follow after backoff, and applied items reset the backoff). threads.ts gets call-site lines only: 1071 -> 1079 (+8; the lane nets -22 against 1101). rpc/client.ts exports subscriptionRetryDelay (upstream's hunk). New tests in state/threads-sync.defect.test.ts, all three failing on the base: upstream's "resubscribes after a snapshot decode defect ends the thread subscription (#23041)" (defect injected by wrapping the session client, because GOAT's harness has no TEST_DEFECT and upstream added it in an earlier commit), upstream's "keeps asking a mounted thread over HTTP after a miss until it exists" (on the base it times out: the thread never asks again), and the condition (b) case "backs off repeated defects up to 30 seconds and keeps one stream open" (nine defects; each resubscribes within a 30 s step and exactly one stream is open after each). Not covered by a direct test: a defect while applying items (the restartAfterDefect path). Upstream has none either, and the harness gives no way to make applyItems die.

### Rule 3, IV(i) mirrored: threadsSync.testkit.ts harness gains httpSnapshots (quoted before the commit)

Upstream's own copy of the same helper (makeHarness in threads-sync.test.ts at de21fbcff3), its hunks:

```diff
@@ -118,6 +118,8 @@ const makeHarness = Effect.fn("TestEnvironmentThreads.makeHarness")(function* (o
     readonly latestLocalTurnOrdinal?: number | null;
   };
   readonly httpSnapshot?: ThreadSnapshotLoadResult;
+  /** Answers per load call; the last one repeats. Overrides `httpSnapshot`. */
+  readonly httpSnapshots?: readonly ThreadSnapshotLoadResult[];
   /** The test sends the completion marker itself instead of the fake server sending it first. */
   readonly completionMarker?: boolean;
   readonly resumeCache?: NonNullable<Parameters<typeof makeEnvironmentThreadState>[1]>;
@@ -193,11 +195,12 @@ const makeHarness = Effect.fn("TestEnvironmentThreads.makeHarness")(function* (o
   );
   const snapshotLoader = ThreadSnapshotLoader.ThreadSnapshotLoader.of({
     load: (_prepared, threadId) =>
-      Ref.update(loaderCalls, (count) => count + 1).pipe(
-        Effect.as(
+      Ref.updateAndGet(loaderCalls, (count) => count + 1).pipe(
+        Effect.map((count) =>
           threadId === THREAD_ID
-            ? (options?.httpSnapshot ??
-                ({ _tag: "unavailable" } satisfies ThreadSnapshotLoadResult))
+            ? (options?.httpSnapshots?.[Math.min(count, options.httpSnapshots.length) - 1] ??
+              options?.httpSnapshot ??
+              ({ _tag: "unavailable" } satisfies ThreadSnapshotLoadResult))
             : ({ _tag: "unavailable" } satisfies ThreadSnapshotLoadResult),
         ),
       ),
```

GOAT's copy (makeHarness in packages/client-runtime/src/state/threadsSync.testkit.ts), the same change:

```diff
@@ -68,6 +68,8 @@ export const makeHarness = Effect.fn("TestEnvironmentThreads.makeHarness")(funct
     readonly latestLocalTurnOrdinal?: number | null;
   };
   readonly httpSnapshot?: ThreadSnapshotLoadResult;
+  /** Answers per load call; the last one repeats. Overrides `httpSnapshot`. */
+  readonly httpSnapshots?: readonly ThreadSnapshotLoadResult[];
   readonly completionMarker?: boolean;
   readonly resumeCache?: NonNullable<Parameters<typeof makeEnvironmentThreadState>[1]>;
   readonly loadCached?: ReturnType<Persistence.EnvironmentCacheStore["Service"]["loadThread"]>;
@@ -129,11 +131,12 @@ export const makeHarness = Effect.fn("TestEnvironmentThreads.makeHarness")(funct
   );
   const snapshotLoader = ThreadSnapshotLoader.ThreadSnapshotLoader.of({
     load: (_prepared, threadId) =>
-      Ref.update(loaderCalls, (count) => count + 1).pipe(
-        Effect.as(
+      Ref.updateAndGet(loaderCalls, (count) => count + 1).pipe(
+        Effect.map((count) =>
           threadId === THREAD_ID
-            ? (options?.httpSnapshot ??
-                ({ _tag: "unavailable" } satisfies ThreadSnapshotLoadResult))
+            ? (options?.httpSnapshots?.[Math.min(count, options.httpSnapshots.length) - 1] ??
+              options?.httpSnapshot ??
+              ({ _tag: "unavailable" } satisfies ThreadSnapshotLoadResult))
             : ({ _tag: "unavailable" } satisfies ThreadSnapshotLoadResult),
         ),
       ),
```

No other existing test, fixture or expectation changes in this commit. Upstream's other test hunk at de21fbcff3 (the comment wording "would resubscribe forever" -> "without backing off" in the config-read case) is not taken: GOAT's copy of that case does not exist.



## Coordinator, 2026-11-17 21:59:20 UTC, item 3 (claims that are not a top-level declaration), verbatim

3. CLAIMS: K4's ProviderTurnStartService.ts :189-217 as a wrapper plus a call line is accepted on the pre-commit's terms: the moved expression byte for byte inside the new function, every added line (signature, parameters, return, call) listed in the commit message and the record, no behaviour change; the review reads it. Any other claim that is not a top-level declaration follows the same terms without asking.

## Coordinator, 2026-11-17 22:00:50 UTC, IV (iv), verbatim

IV gains (iv), for every lane (relay it): where GOAT's test file is byte for byte upstream's parent of the commit being ported (git diff <sha>^ on that file empty), the file may become upstream's file at that commit, whole, deletions and retitles included; the record gives both empty diffs (before against <sha>^, after against <sha>). If GOAT's file differs from upstream's parent in any line, deletions and retitles still come to me.

## Lane coordinator, 22:0x UTC (K10 and ChatMarkdown.tsx), for the claims

K10 changed ChatMarkdown.tsx (findWorkspaceFileMatch :652-674 and nearby, 1679 -> 1657) without touching K7's claimed :259-267, so the claim stands as written at c995c5427a. Once both lanes are in, the budget line is countLines of the merged file. K10 also holds MessagesTimeline.logic.ts :918-951 and contracts settings.ts :145-199.

## Build log, rows 2 and 3 (commits)

- d78a28f0e9 row 2 (de21fbcff3), as described above; the mirrored testkit hunks were quoted in records 727f898ed3 before the commit.
- a37c72ff48 row 3 (00f617db4e): rpc/client.ts resubscribes on the same session after a stream transport failure or a chunk decode defect (no onDefect), at 1 s doubling to 30 s, or the caller's retryExpectedFailureAfter. It logs once per failed stream; the finite thread search keeps waiting for the next session. GOAT addition: an "Unknown request tag: <method>" answer from an older server also keeps waiting (new hubNodes.ts isUnknownRequestTagError). The whole client-runtime suite before the guard turned up the GOAT-only computerUseReadiness.test.ts case "keeps the status query and setting refresh working on older servers without retrying" failing (6 subscriptions instead of 1); with the guard it passes unchanged, and no expectation was touched. New tests: rpc/client.streamRecovery.test.ts (6: upstream's three, all failing on the base; one log per failed stream with at most one stream open; a pending retry does not resubscribe a replaced session; the older-server case, which fails with the guard removed) and state/runtime.streamRecovery.test.ts (upstream's finite-search guard, passing before and after). Upstream's added clock-advance line in an existing client.test.ts case is not taken; the new replaced-session case covers it. Whole client-runtime suite after: 313 files, 4013 tests, exit 0. rpc/client.ts 772 -> 816 (no budget entry, under 1000).



## Row 4 (a74ee4cc7c), in progress, not committed

- ebbba8c7f0 move-out, claim 3: state/server.ts:107-365 -> state/serverUpdate.ts:19-277. The only changed text is the export keyword on SERVER_UPDATE_RESUME_TIMEOUT. server.ts 1776 -> 1527.
- Row 4 working tree (uncommitted): rpc/client.ts exports currentSession, splits requestGuarded into requestInSession (keeps the EnvironmentRpc.request span) and runStreamGuarded into runStreamInSession; serverUpdate.ts gains acceptedAt in matchesServerUpdateResumeEvent, the foreign-outcome check in validateServerUpdateReadyEvent, and readAcceptingReady (the 5 s baseline read, on the session the request rides); server.ts sends the boot-service update on the accepting session (1527 -> 1564, the lane nets -212 against 1776). New state/server.updateResume.test.ts: upstream's four "launcher update resume" cases plus its foreign-rollback check as a case of its own. Three of them fail on the base, and the other two are guards.
- Existing case broken by the change, as upstream's was: server.test.ts "accepted server update recovery" (5 boot-service rows; one times out in the new 5 s baseline read, because its lifecycle mock replays no ready before the request).

### Rule 3, IV(i) mirrored, and (iv)'s precondition holds for this block

GOAT's describe("accepted server update recovery") block is byte for byte upstream's at a74ee4cc7c^ (`diff` of the two 155-line blocks: empty). It becomes upstream's block at a74ee4cc7c, and the two hunks are identical (`cmp` of the two diffs: same). Upstream's own copy:

```diff
@@ -254,22 +258,37 @@ describe("accepted server update recovery", () => {
           capabilities: { serverSelfUpdate: method, serverSelfUpdateProgress: true },
         },
       } as ServerConfig;
+      const ready = (serverVersion: string) =>
+        ({
+          version: 1,
+          sequence: 1,
+          type: "ready",
+          payload: { at: "2026-09-01T00:00:00.000Z", environment: { serverVersion } },
+        }) as Parameters<typeof matchesServerUpdateReadyEvent>[1];
+      let requested = false;
       const client = {
         [WS_METHODS.subscribeServerConfig]: () => Stream.never,
+        // Before the request, a boot-service update reads the accepting server's ready.
         [WS_METHODS.subscribeServerLifecycle]: () =>
-          Stream.fromEffect(Deferred.succeed(observing, undefined)).pipe(
-            Stream.drain,
-            Stream.concat(Stream.fromQueue(readyEvents)),
-            Stream.tap((event) =>
-              event.payload.environment.serverVersion === "0.0.30"
-                ? Deferred.succeed(oldReadyObserved, undefined)
-                : Effect.void,
-            ),
-          ),
+          requested
+            ? Stream.fromEffect(Deferred.succeed(observing, undefined)).pipe(
+                Stream.drain,
+                Stream.concat(Stream.fromQueue(readyEvents)),
+                Stream.tap((event) =>
+                  event.payload.environment.serverVersion === "0.0.30"
+                    ? Deferred.succeed(oldReadyObserved, undefined)
+                    : Effect.void,
+                ),
+              )
+            : Stream.make(ready("0.0.30")).pipe(Stream.concat(Stream.never)),
         [WS_METHODS.serverUpdateServerWithProgress]: () =>
-          (loss === "no_progress"
-            ? Stream.empty
-            : Stream.make({ type: "progress" as const, stage: "downloading" as const })
+          Stream.unwrap(
+            Effect.sync(() => {
+              requested = true;
+              return loss === "no_progress"
+                ? Stream.empty
+                : Stream.make({ type: "progress" as const, stage: "downloading" as const });
+            }),
           ).pipe(
             Stream.concat(
               Stream.fromEffect(
@@ -363,13 +382,6 @@ describe("accepted server update recovery", () => {
         status: "running",
         stage: "resuming",
       });
-      const ready = (serverVersion: string) =>
-        ({
-          version: 1,
-          sequence: 1,
-          type: "ready",
-          payload: { at: "2026-09-01T00:00:00.000Z", environment: { serverVersion } },
-        }) as Parameters<typeof matchesServerUpdateReadyEvent>[1];
       yield* Queue.offer(readyEvents, ready("0.0.30"));
       yield* Deferred.await(oldReadyObserved);
       expect(registry.get(serverUpdateStateAtom(TARGET.environmentId))).toMatchObject({
```

GOAT's copy, the same change:

```diff
@@ -251,22 +251,37 @@ describe("accepted server update recovery", () => {
           capabilities: { serverSelfUpdate: method, serverSelfUpdateProgress: true },
         },
       } as ServerConfig;
+      const ready = (serverVersion: string) =>
+        ({
+          version: 1,
+          sequence: 1,
+          type: "ready",
+          payload: { at: "2026-09-01T00:00:00.000Z", environment: { serverVersion } },
+        }) as Parameters<typeof matchesServerUpdateReadyEvent>[1];
+      let requested = false;
       const client = {
         [WS_METHODS.subscribeServerConfig]: () => Stream.never,
+        // Before the request, a boot-service update reads the accepting server's ready.
         [WS_METHODS.subscribeServerLifecycle]: () =>
-          Stream.fromEffect(Deferred.succeed(observing, undefined)).pipe(
-            Stream.drain,
-            Stream.concat(Stream.fromQueue(readyEvents)),
-            Stream.tap((event) =>
-              event.payload.environment.serverVersion === "0.0.30"
-                ? Deferred.succeed(oldReadyObserved, undefined)
-                : Effect.void,
-            ),
-          ),
+          requested
+            ? Stream.fromEffect(Deferred.succeed(observing, undefined)).pipe(
+                Stream.drain,
+                Stream.concat(Stream.fromQueue(readyEvents)),
+                Stream.tap((event) =>
+                  event.payload.environment.serverVersion === "0.0.30"
+                    ? Deferred.succeed(oldReadyObserved, undefined)
+                    : Effect.void,
+                ),
+              )
+            : Stream.make(ready("0.0.30")).pipe(Stream.concat(Stream.never)),
         [WS_METHODS.serverUpdateServerWithProgress]: () =>
-          (loss === "no_progress"
-            ? Stream.empty
-            : Stream.make({ type: "progress" as const, stage: "downloading" as const })
+          Stream.unwrap(
+            Effect.sync(() => {
+              requested = true;
+              return loss === "no_progress"
+                ? Stream.empty
+                : Stream.make({ type: "progress" as const, stage: "downloading" as const });
+            }),
           ).pipe(
             Stream.concat(
               Stream.fromEffect(
@@ -360,13 +375,6 @@ describe("accepted server update recovery", () => {
         status: "running",
         stage: "resuming",
       });
-      const ready = (serverVersion: string) =>
-        ({
-          version: 1,
-          sequence: 1,
-          type: "ready",
-          payload: { at: "2026-09-01T00:00:00.000Z", environment: { serverVersion } },
-        }) as Parameters<typeof matchesServerUpdateReadyEvent>[1];
       yield* Queue.offer(readyEvents, ready("0.0.30"));
       yield* Deferred.await(oldReadyObserved);
       expect(registry.get(serverUpdateStateAtom(TARGET.environmentId))).toMatchObject({
```

Upstream's other server.test.ts hunks in this commit (import reorder of serverUpdateStateAtom, the foreign-rollback assertions in "server state projection", the new "launcher update resume" describe) are not applied to server.test.ts: the last two live in the new server.updateResume.test.ts as new cases.

### Budget question sent to the coordinator

The mirrored hunk takes server.test.ts from 1411 to 1419, and its entry is 1411. Freeing room means moving existing tests, which is the coordinator's call.



### Budget question, options with corrected ranges at c995c5427a (lane coordinator's correction, checked with `git show c995c5427a:...server.test.ts`)

- A: describe("accepted server update recovery") is server.test.ts:228-382 (155 lines). It does not include :384-434, the top-level makeConfigPersistenceHarness that "server state projection" (:436-1329) uses and that stays. My report's ":228-443, 216 lines" was wrong.
- B: describe("provider setup commands") is server.test.ts:1331-1411 (81 lines). My report's ":1339-1419" was my worktree's numbers with the +8 hunk applied.
- Row 4's uncommitted work is held in a local stash ("k7-row4-wip") on top of ebbba8c7f0, so row 5's commit carries only row 5.



## Coordinator, 2026-11-17 22:16:44 UTC, item 2 (row 4, option A) and IV (v), (vi), verbatim

2. K7, row 4 (a74ee4cc7c): OPTION A.
READ BY ME: server.test.ts at c995c5427a (describes at :105, :228, :436, :1331; makeConfigPersistenceHarness at :384; 1411 lines; entry 1411); upstream's whole server.test.ts diff of a74ee4cc7c; next3-K7.md :332-340 and :478-482 at records f429de5b65. NOT READ: ebbba8c7f0, K7's worktree. NOT RUN: anything.
Why A: claim 3 moved the server update code to serverUpdate.ts, so its tests follow the module, and upstream's hunk then lands beside the launcher cases it belongs with. B would leave the update tests split across two files.
Conditions:
a. One commit that only moves, before the row 4 commit: server.test.ts:228-382 at c995c5427a (155 lines, your range, not 228-443) arrives byte for byte in state/server.updateResume.test.ts; the record gives the empty diff of the two ranges. makeConfigPersistenceHarness (:384-434) stays where it is.
b. The new file takes copies of CONFIG, TARGET and session byte for byte (the launcher cases need them there anyway). No shared testkit and no edit to those declarations in server.test.ts. Imports server.test.ts no longer uses are removed and listed; every line of the new file outside the moved block is listed in the commit message and the record (the 21:59 claims terms).
c. Proof of a move: at the move commit, before row 4, both files pass, the five rows of the describe run in the new file under the same titles, and the total count of the two files equals server.test.ts's count before. The numbers go in the record.
d. The server.test.ts entry is lowered to countLines after the move; the card row (server.test.ts, K7, :228-382 at c995c5427a, the new file, lines freed) is written before the cut.
e. The row 4 commit applies the mirrored hunk in the new file under IV (i); the review matches it to upstream's @@ -254 and @@ -363 hunks.
f. One fork delta line: in GOAT, upstream's server update cases of state/server.test.ts ("accepted server update recovery", "launcher update resume") live in server.updateResume.test.ts beside serverUpdate.ts.
Row 5 in parallel on your condition (none of row 4's files) is fine.

IV gains (v), mock scaffolding: a line added to a test's mocks so that existing cases keep loading or rendering after the lane's row adds a component, hook or import. Covered: one export added to an existing vi.mock factory, or one vi.mock of a module the lane's own row introduced. Conditions: the stub is inert (renders its children, returns undefined, or does nothing); no existing title, body, setup value or expectation changes; the line is quoted in the record before the commit; the file stays within its entry; and what the stub hides is tested in a case of its own or named in the lane's P1 rows. Still to me: a mock that returns data existing assertions read, a changed existing mock line, a stub of a module the lane did not add, and anything a lane is unsure of. The review checks each; a miss is a P2.

IV gains (vi), a describe moved whole: a whole top-level describe block of an at-entry test file moved byte for byte into a sibling test file, in a commit that does nothing else, on K7's conditions a to d above (empty diff of the two ranges in the record; helpers copied byte for byte and listed, none moved or shared; the same case titles and the same total count before and after; the entry lowered; the card row before the cut; TEST_TITLES updated in the same commit when the file is listed). Still to me: a harness or helper moved or shared into a testkit, a describe split in two, a nested block, and a move that needs any line of a case to change.

For K7: the server.test.ts row (:228-382 -> state/server.updateResume.test.ts) is on card 10.028 (records 5035238517), so the move may go ahead.

## Lane coordinator, 22:1x UTC, for the record

Row 5 may go on in parallel if it touches none of row 4's files, with row 4's uncommitted changes kept apart (a local stash or branch).

## Build log, rows 5 and 6

- af3f5f62c1 row 5 (7c22095fcc): driver.ts stops before a still-silent route once a transient failure is in hand; managedRelayState.ts replaces a Clerk token read over 4 s (3 tries, then a timeout error). The message says GOAT Connect: the 3-way apply conflicted only on the product name. Tests: upstream's two Clerk cases in managedRelayState.test.ts (no entry) and its silent-LAN case in the new connection/supervisor.silentRoute.test.ts, which copies the goatConnect vi.mock and the LAN-then-relay entry from supervisor.test.ts. All three timed out on the base (the waits never end). After: managedRelayState, supervisor.silentRoute, supervisor and driver suites, 134 tests. None of row 4's files changed; row 4 was held in stash "k7-row4-wip".
- 0b6c07ee61 move-out, claim 4: ChatMarkdown.tsx:259-267 -> components/chatMarkdownLinkHref.ts:4-12. The only changed text is `export` on normalizeMarkdownLinkHrefKey; the new module imports normalizeMarkdownLinkDestination and rewriteMarkdownFileUriHref. ChatMarkdown.tsx 1679 -> 1671 (block 9, 1-line import). Entry 1679 -> 1671.
- Row 6 (3a815e9749), being committed after this record:
  - Prior check: GOAT already never falls back for a media-file path inside the workspace (state/assets.ts, the mediaFileReference(...).relativePath condition, present since the fork's initial commit; the existing table in assets.test.ts covers "relative Markdown image missing remotely" and "workspace path with dot segments"). Upstream's bug remains on GOAT for a relative image that leaves the workspace ("../shared/report.png" from /repo/app normalizes to /repo/shared/report.png and falls back to the desktop's file). The same holds when ChatMarkdown resolves against imageBaseDir. hostOnly closes both.
  - Contract: AssetResource media-file `hostOnly: optionalKey(Literal(true))`. Set by classifyMarkdownImageSource (relative) through resolveMediaSource, by both web sites in ChatMarkdown.tsx (the image and the audio preview; upstream has the image only), and by mobile's markdownMedia.ts, which builds its own resource (upstream's commit does not touch mobile). The local fallback in state/assets.ts skips a hostOnly resource.
  - Each way, tested in the new packages/contracts/src/assets.hostOnly.test.ts: an older server's media-file request schema (copied from c995c5427a) decodes a newer client's request and drops the flag; a newer server keeps it; an older client's request decodes without it; a non-true hostOnly is rejected. No asset decoder in contracts or the server sets onExcessProperty (`rg -n onExcessProperty`).
  - Tests: the new describe in state/assets.test.ts ("keeps a relative image that leaves the workspace on the thread's environment": the relative case fell back on the base and now stays on the remote; the absolute case still falls back) and a new mobile describe in markdownMedia.test.ts. Runs: client-runtime assets/markdownImages/mediaSource 57; mobile markdownMedia + markdownMediaSource 91; contracts 3. Typecheck exits 0 for contracts, client-runtime, web and mobile. ChatMarkdown.tsx 1671 -> 1675 (the lane nets -4 against 1679).

### Rule 3 for row 6 (quoted before the commit)

1. packages/client-runtime/src/markdownImages.test.ts under IV (iv): GOAT's file is byte for byte upstream's at 3a815e9749^ (`diff <(git show 3a815e9749^:...) <(git show HEAD:...)`, with @t3tools read as @goat: empty) and after the change is upstream's file at 3a815e9749 (same diff: empty). Upstream's one added line: `...(source.startsWith("file:") ? {} : { relative: true }),` in the classifyMarkdownImageSource case.
2. packages/client-runtime/src/mediaSource.test.ts under IV (standing, mirrored assertion). Upstream's own copy:

```diff
@@ -83,7 +83,7 @@ describe("resolveMediaSource", () => {
         },
         srcFragment: "#mark",
         access: "environment",
-        resource: { _tag: "media-file", threadId, path: "/repo/screens/logo.svg" },
+        resource: { _tag: "media-file", threadId, path: "/repo/screens/logo.svg", hostOnly: true },
       });
     });
```

GOAT's copy, the same assertion changed the same way (GOAT's file differs from upstream elsewhere, so this is the single-assertion case, not (iv)):

```diff
@@ -134,7 +134,7 @@ describe("resolveMediaSource", () => {
         },
         srcFragment: "#mark",
         access: "environment",
-        resource: { _tag: "media-file", threadId, path: "/repo/screens/logo.svg" },
+        resource: { _tag: "media-file", threadId, path: "/repo/screens/logo.svg", hostOnly: true },
       });
     });
```

No other existing expectation changes. The mobile and assets.test.ts additions are new cases.



## Row 4 move and commit (option A)

- f057ee1027 move (IV (vi), conditions a-d): server.test.ts:228-382 at c995c5427a -> server.updateResume.test.ts:67-221. `diff <(git show c995c5427a:...server.test.ts | sed -n 228,382p) <(new file from the describe)` is empty. Copies, byte for byte (compared): CONFIG (server.test.ts:69-78 -> 37-46), TARGET (:86-91 -> 48-53), session (:93-103 -> 55-65). Lines outside the block: 1-35 imports, plus blanks at 36, 47, 54 and 66. Imports removed from server.test.ts: ServerSelfUpdateError, AsyncResult, RpcPermissionGuard, serverUpdateStateAtom. Counts: server.test.ts ran 33 before the move; after the move it runs 26 and server.updateResume.test.ts runs 7 (the describe's seven rows, same titles; the five boot-service rows plus respawn and desktop-managed). That is 33, all passing. server.test.ts 1411 -> 1252; entry lowered; not in TEST_TITLES.
- Row 4 commit (being committed after this record): the production files are as described above (rpc/client.ts requestInSession/runStreamInSession; serverUpdate.ts acceptedAt, foreign outcome, readAcceptingReady; server.ts 1527 -> 1564). In server.updateResume.test.ts: (1) the moved describe becomes upstream's block at a74ee4cc7c under IV (i) (its @@ -254 and @@ -363 hunks, quoted above under "Rule 3, IV(i) mirrored" with records 1e3a146585; GOAT's hunk in the new file follows); (2) upstream's describe("launcher update resume") is added verbatim from a74ee4cc7c, apart from two lines GOAT's EnvironmentCacheStore needs in the cache stub (loadShellMeta, saveShellMeta); (3) a GOAT describe "launcher update outcome validation" holds upstream's foreign-rollback check as its own case (upstream put it inside "server state projection" in server.test.ts). Fail-first: with the row 4 production files held aside, the two "fails promptly" cases and the foreign-rollback case fail and the other 9 pass. With them: 38 tests across the two files pass, and the whole client-runtime suite passes (315 files, 4022 tests, exit 0).
- Fork delta line (f): in GOAT, upstream's server update cases of state/server.test.ts ("accepted server update recovery", "launcher update resume") live in server.updateResume.test.ts beside serverUpdate.ts. Taken into devlog/_chase/010_fork_delta.md at READY, or by the coordinator if the fork delta belongs to the integration PR.

GOAT's mirrored hunk in server.updateResume.test.ts (the same change as upstream's @@ -254 and @@ -363 hunks):

```diff
@@ -2,19 +2,25 @@ import {
   EnvironmentId,
   ServerSelfUpdateError,
   type ServerConfig,
+  type ServerLifecycleStreamEvent,
+  type ServerSelfUpdateOutcome,
   WS_METHODS,
 } from "@goat/contracts";
 import { describe, expect, it } from "@effect/vitest";
 import * as Cause from "effect/Cause";
+import * as Clock from "effect/Clock";
 import * as Deferred from "effect/Deferred";
+import type * as Duration from "effect/Duration";
 import * as Effect from "effect/Effect";
 import * as Fiber from "effect/Fiber";
 import * as Layer from "effect/Layer";
 import * as Option from "effect/Option";
 import * as Queue from "effect/Queue";
+import * as Scheduler from "effect/Scheduler";
 import * as Stream from "effect/Stream";
 import * as SubscriptionRef from "effect/SubscriptionRef";
 import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
+import * as TestClock from "effect/testing/TestClock";
 import { RpcClientError } from "effect/rpc";
 import * as Socket from "effect/socket/Socket";
 import {
@@ -32,6 +38,7 @@ import {
   createServerEnvironmentAtoms,
   serverUpdateStateAtom,
   matchesServerUpdateReadyEvent,
+  validateServerUpdateReadyEvent,
 } from "./server.ts";
 
 const CONFIG = {
@@ -90,22 +97,37 @@ describe("accepted server update recovery", () => {
           capabilities: { serverSelfUpdate: method, serverSelfUpdateProgress: true },
         },
       } as ServerConfig;
+      const ready = (serverVersion: string) =>
+        ({
+          version: 1,
+          sequence: 1,
+          type: "ready",
+          payload: { at: "2026-09-01T00:00:00.000Z", environment: { serverVersion } },
+        }) as Parameters<typeof matchesServerUpdateReadyEvent>[1];
+      let requested = false;
       const client = {
         [WS_METHODS.subscribeServerConfig]: () => Stream.never,
+        // Before the request, a boot-service update reads the accepting server's ready.
         [WS_METHODS.subscribeServerLifecycle]: () =>
-          Stream.fromEffect(Deferred.succeed(observing, undefined)).pipe(
-            Stream.drain,
-            Stream.concat(Stream.fromQueue(readyEvents)),
-            Stream.tap((event) =>
-              event.payload.environment.serverVersion === "0.0.30"
-                ? Deferred.succeed(oldReadyObserved, undefined)
-                : Effect.void,
-            ),
-          ),
+          requested
+            ? Stream.fromEffect(Deferred.succeed(observing, undefined)).pipe(
+                Stream.drain,
+                Stream.concat(Stream.fromQueue(readyEvents)),
+                Stream.tap((event) =>
+                  event.payload.environment.serverVersion === "0.0.30"
+                    ? Deferred.succeed(oldReadyObserved, undefined)
+                    : Effect.void,
+                ),
+              )
+            : Stream.make(ready("0.0.30")).pipe(Stream.concat(Stream.never)),
         [WS_METHODS.serverUpdateServerWithProgress]: () =>
-          (loss === "no_progress"
-            ? Stream.empty
-            : Stream.make({ type: "progress" as const, stage: "downloading" as const })
+          Stream.unwrap(
+            Effect.sync(() => {
+              requested = true;
+              return loss === "no_progress"
+                ? Stream.empty
+                : Stream.make({ type: "progress" as const, stage: "downloading" as const });
+            }),
           ).pipe(
             Stream.concat(
               Stream.fromEffect(
```



## Row 7 (6641231797): answers before code (condition (c))

Persisted shells: none store the summary. A thread shell's pendingRuntimeRequest is rebuilt on every read from the stored request payload and the stored secret or handoff card (ProjectionStore.ts:6982-7002 and threadShellProjection.ts:318-349, both through ProjectionPendingRequest.ts:23 secretRequestAsPendingInput). userOnly is set there, so a card pending before the upgrade carries it on the first read after it, with no reprojection or migration. A client that cached a shell from before the upgrade (client-runtime shell cache) shows the old state until its next snapshot, which every reconnect brings.

GOAT's starting point differs from upstream: GOAT's server awareness (packages/shared/src/agentAwareness.ts:37 subagentRequestAwareness) already reports any blocking child request, questions included, as the parent's waiting_for_input, where upstream's only reported approvals. The three gaps upstream fixed are the same on GOAT:
- ShellStream.ts shouldPublishShellApplicationEvent drops every subagent turn-item.updated, so a child's secret or handoff card (a turn item) does not refresh any shell.
- AgentAwarenessRelay.ts:130-131 publishes a turn-item.updated only when it can end background work, so the push does not fire when the card appears.
- client-runtime state/threadShell.ts:84 rolls up only approvals, so no client marks the parent.
GOAT's user-only cards are secret_request and human_handoff; GOAT has no link_request.

What a parent shows, before and after, for a child (subagent) that is live:

| surface | child asks an ordinary question | child shows a secret request | child shows a human handoff |
|---|---|---|---|
| web sidebar row (Sidebar.logic.ts:1446) | nothing (the coordinator answers) | before: nothing; after: Input needed | before: nothing; after: Input needed |
| desktop (wraps web: same row, tray via desktopTray.ts, notification via ThreadNotificationCoordinator) | nothing | before: nothing; after: Input needed, tray count and a background "needs input" announcement | same as secret |
| mobile thread list (threadListV2LaunchFold.ts:135, useThreadListActions.ts:366) | nothing | before: nothing; after: the "input" fold mark | same as secret |
| phone push (AgentAwarenessRelay -> SubagentWaits) | waiting_for_input when blocking (GOAT's existing behavior, unchanged) | before: only after some later publishable event; after: waiting_for_input when the card appears, cleared when it is answered | same as secret |

The child's own row also refreshes live once the turn-item filter keeps these updates. A coordinating agent gets nothing new: userOnly is a flag on the summary, and no wire field carries a secret value.



## Row 7 (6641231797): build notes and rule 3 (quoted before the commit)

- f64a05819a move-out, claim 5 (corrected range): orchestrationV2.ts:624-653 -> contracts/src/goalCommand.ts:1-30, byte for byte, with a one-line re-export at :624. 4438 -> 4409. Entry lowered.
- Row 7 code: PendingRuntimeRequestSummary gains `userOnly` (optional boolean; orchestrationV2.ts 4409 -> 4411, the lane nets -27 against 4438); ProjectionPendingRequest.ts sets it for secret_request and human_handoff; packages/shared/src/agentAwareness.ts gains turnItemCanChangeUserWait (secret_request, human_handoff, user_message); ShellStream.ts keeps subagent turn-item updates that match it; AgentAwarenessRelay.ts publishes them; client-runtime threadShell.ts rolls a user-only child card up to its parents as user_input (approvals still win). GOAT's SubagentWaits needs no change: subagentRequestAwareness already gives waiting_for_input for a blocking child request.
- Tests, all failing on the base: threadShell.test.ts (upstream's "flags the parent while a live subagent waits on a secret card", a new case), apps/server/src/orchestration-v2/ProjectionPendingRequest.test.ts (new: secret card and handoff get userOnly), ShellStream.test.ts (new case "keeps subagent turn-item updates that can start or end a user-only wait": secret_request, human_handoff and user_message kept, assistant_message filtered), apps/server/src/relay/AgentAwarenessRelay.userWait.test.ts (new: the parent is published as waiting_for_input when its subagent's secret card or handoff appears). After: threadShell 15; ShellStream, ProjectionPendingRequest, the three relay files and SubagentWaits 60; shared agentAwareness 29; ProjectionStore, ProjectionSettlement, ThreadSettlementSnooze and OrchestratorMcpService.lazyThreads 87; web ThreadNotificationCoordinator.logic 26. Typecheck exits 0 for contracts, shared, client-runtime, server, web and mobile.
- Not taken from upstream: its link_request item (GOAT has none); its ProjectionStore.test.ts assertions (that file is at its entry; ProjectionPendingRequest.test.ts covers the summary); its delegated cross-environment roll-up types (GOAT's threadShell.ts has no delegated roll-up of that shape); its AgentAwarenessRelay changes to subagentAwaitsApproval/waitsForInput (GOAT's SubagentWaits already reports input waits).

### Rule 3: ShellStream.test.ts under IV (i) (helper) and the standing mirrored case (the idle literal)

Upstream's own copy changes its `stored` helper to carry a payload, and the idle-subagent event literal the same way (plus new assertions in the first case, which GOAT does not take; GOAT's new assertions are a separate new case because its item types differ):

```diff
@@ -38,8 +38,8 @@ const emptyShellSnapshot = {
 } as OrchestrationV2ShellSnapshot;
 
 describe("subagent shell events", () => {
-  const stored = (threadId: string, type: string) =>
-    ({ event: { threadId, type } }) as ApplicationStoredEvent;
+  const stored = (threadId: string, type: string, itemType = "command_execution") =>
+    ({ event: { threadId, type, payload: { type: itemType } } }) as ApplicationStoredEvent;
 
   it("keeps regular threads and subagent state changes while omitting subagent transcript updates", () => {
     const subagents = new Set(["child"]);
@@ -49,6 +49,14 @@ describe("subagent shell events", () => {
     expect(
       shouldPublishShellApplicationEvent(stored("child", "turn-item.updated"), subagents),
     ).toBe(false);
+    for (const itemType of ["secret_request", "link_request", "user_message"]) {
+      expect(
+        shouldPublishShellApplicationEvent(
+          stored("child", "turn-item.updated", itemType),
+          subagents,
+        ),
+      ).toBe(true);
+    }
     expect(shouldPublishShellApplicationEvent(stored("child", "node.updated"), subagents)).toBe(
       false,
     );
@@ -198,7 +206,13 @@ describe("omitIdleSubagentShells", () => {
     expect(omitted.threads.map((thread) => thread.id)).toEqual(["root"]);
     expect(
       shouldPublishShellApplicationEvent(
-        { event: { threadId: "idle", type: "turn-item.updated" } } as ApplicationStoredEvent,
+        {
+          event: {
+            threadId: "idle",
+            type: "turn-item.updated",
+            payload: { type: "command_execution" },
+          },
+        } as ApplicationStoredEvent,
         omitted.subagentThreadIds,
       ),
     ).toBe(false);
```

GOAT's copy: the same helper change (GOAT's helper lines equal upstream's parent, only shifted by three lines), the same payload added to the idle literal (GOAT's surrounding line passes `new Set(omitted.subagentThreadIds)`, unchanged), and the new case:

```diff
@@ -41,8 +41,26 @@ const emptyShellSnapshot = {
 } as OrchestrationV2ShellSnapshot;
 
 describe("subagent shell events", () => {
-  const stored = (threadId: string, type: string) =>
-    ({ event: { threadId, type } }) as ApplicationStoredEvent;
+  const stored = (threadId: string, type: string, itemType = "command_execution") =>
+    ({ event: { threadId, type, payload: { type: itemType } } }) as ApplicationStoredEvent;
+
+  it("keeps subagent turn-item updates that can start or end a user-only wait", () => {
+    const subagents = new Set(["child"]);
+    for (const itemType of ["secret_request", "human_handoff", "user_message"]) {
+      expect(
+        shouldPublishShellApplicationEvent(
+          stored("child", "turn-item.updated", itemType),
+          subagents,
+        ),
+      ).toBe(true);
+    }
+    expect(
+      shouldPublishShellApplicationEvent(
+        stored("child", "turn-item.updated", "assistant_message"),
+        subagents,
+      ),
+    ).toBe(false);
+  });
 
   it("keeps regular threads and subagent state changes while omitting subagent transcript updates", () => {
     const subagents = new Set(["child"]);
@@ -301,7 +319,13 @@ describe("omitIdleSubagentShells", () => {
     expect(omitted.threads.map((thread) => thread.id)).toEqual(["root"]);
     expect(
       shouldPublishShellApplicationEvent(
-        { event: { threadId: "idle", type: "turn-item.updated" } } as ApplicationStoredEvent,
+        {
+          event: {
+            threadId: "idle",
+            type: "turn-item.updated",
+            payload: { type: "command_execution" },
+          },
+        } as ApplicationStoredEvent,
         new Set(omitted.subagentThreadIds),
       ),
     ).toBe(false);
```

No existing title, expectation or other setup changes.



## Coordinator, 2026-11-17 22:32:14 UTC, row 7 points 1-4 (verbatim) and K7's answers

K7 row 7 (6641231797): the statement meets condition (c); K7 goes on. Four points for the row, and two lines on your K10 notes.
READ BY ME: upstream 6641231797's diffs of ShellStream.ts, ShellStream.test.ts, AgentAwarenessRelay.ts, agentAwareness.ts, threadShell.ts, orchestrationV2.ts and ProjectionStore.ts; at 99e11d7480: ProjectionPendingRequest.ts:1-41, shouldPublishShellApplicationEvent in ShellStream.ts (:350), ShellStream.test.ts:40-58 and :296-310, agentAwareness.ts:20-62, AgentAwarenessRelay.ts:110-135, client-runtime state/threadShell.ts:70-98; next3-K7.md :78-82 and :658-680 at records cfea07faa4. NOT READ: ProjectionStore.ts:6982-7002, threadShellProjection.ts:318-349, SubagentWaits.ts, the client rows K7 cites. NOT RUN: anything.
What I can confirm from the code: the summary is built by secretRequestAsPendingInput for secret_request and human_handoff, so userOnly set there needs no migration; GOAT's ShellStream drops every subagent turn-item.updated; the relay publishes a turn-item update only when it can end background work; the client rolls up approvals only.
1. The keep rule names item types, and only the ones that can start or end a user-only wait in GOAT: secret_request and human_handoff. Upstream also keeps user_message because a user message moves past its link card; GOAT has no link card, so user_message is kept only if a message can end a secret or handoff wait in GOAT, and the record says which. Every other subagent turn item stays filtered in ShellStream and in the relay: that filter is what keeps a busy child's transcript off every client's shell stream. One case each pins it with an ordinary item (upstream's ShellStream case uses command_execution).
2. ShellStream.test.ts, my word now so it does not come back: the stored helper gains upstream's payload argument (IV (i)), the :304 literal gains its payload as upstream's does, and the added loop names GOAT's types in place of link_request. No existing expectation changes; if one does, it comes to me.
3. The push: two updates of the same pending card give one push, and the answer clears it; the record says what text the push carries for a child's secret request and for a handoff (the handoff title rides in the summary, bounded at 160, ProjectionPendingRequest.ts:8). The negative "no wire field carries the value" covers the push payload as well.
4. Mixed versions, one sentence in the record: an older client on a newer server receives the kept events only as shell refreshes and shows what it shows today.

K7's answers:
1. user_message is NOT kept. In GOAT a card is pending only by its own status: threadShellProjection.ts:326-334 picks a turn item with status "waiting" (a secret card also needs its run to be live), and ProjectionShellThreadRows.ts:255-276 does the same in SQL. No user message starts or ends that wait. It ends by the card's own turn-item update (kept: secret_request, human_handoff) or by the run leaving the live statuses (run.updated, which the shell stream and the relay already publish). turnItemCanChangeUserWait now names secret_request and human_handoff only. Pinned with ordinary items: ShellStream.test.ts's new case checks that command_execution, user_message and assistant_message stay filtered for a subagent; AgentAwarenessRelay.userWait.test.ts "keeps an ordinary subagent transcript update off the push" checks that a child's command_execution update publishes nothing.
2. As ruled. The new assertions sit in a new case, not as a loop in the existing first case, so no existing case body changes at all; the helper and the idle literal are the only edits to existing lines (quoted above).
3. "pushes a pending secret card once across its updates, without its text, and clears it when answered": two updates of the same pending card give one publication (waiting_for_input); the published state contains neither the card's label nor its reason; once the card is saved and the child's summary clears, a second publication leaves waiting_for_input. The push text for a child's secret request and for a child's handoff is the same: headline "Waiting for input", the parent's thread title, project title and model (agentAwareness.ts projectThreadAwarenessV2). Its detail is set only for waiting_for_approval, from the parent's own handoff title, so neither a child's secret label, reason or value nor a child's handoff title reaches the push.
4. An older client on a newer server receives the kept card updates only as shell refreshes; it does not read userOnly, so it rolls up nothing and shows what it shows today.



## Coordinator, 2026-11-17 22:45:36 UTC, for every lane (verbatim)

FOR EVERY LANE (relay it): before a push, every changed test file runs whole, with no -t filter; and for a row that changes when or whether something wakes, notifies or holds a thread, the test files of that subsystem run whole as well. A -t run is for iteration and is named as such in the record.

K7 under it: from now on every changed test file runs whole before a push, and a -t run is called iteration. Row 8 changes no wake, notify or hold path. Row 7 (8044daa14c, pushed before this rule) changed notifications. Before READY I run row 7's changed test files and the subsystem's test files whole (ShellStream, AgentAwarenessRelay, agentAwareness, the push notification and client-runtime threadShell tests) and record the result here.

## Row 8 (1c9ea568a1): build notes and rule 3 (quoted before the commit)

Move-outs before the row (local, not pushed until the row is in):
- 1213ea8016, claim 6: orchestratorMcp.ts:685-696 at c995c5427a (comment and clampedPositiveInt) to contracts/src/mcpClampedInt.ts; only the export keyword changes. 1083 -> 1072; with the row 1073 (entry at the cut 1083).
- 53162fd791, claim 7: Orchestrator.ts:401-414 plus blank :415 at c995c5427a (OrchestratorThreadAboveModeLimitError) to orchestration-v2/OrchestratorModeLimitError.ts, byte for byte, imported and re-exported. 13528 -> 13516; with the row 13525 (entry at the cut 13528).
- Claim 8 (OrchestratorMcpService.ts:515-530) is NOT used and its local commit was dropped before any push: in GOAT the MCP thread detail mapping lives in apps/server/src/mcp/threadListView.ts (no budget entry), so the row writes no line into OrchestratorMcpService.ts (3871, its entry). The card row can be released.

What the row does: a thread remembers the outcome of its last regeneration that a person asked for (renamed, unchanged, or failed with a short reason). The shell and the MCP thread detail carry it, and clients wait for the outcome of their own request. Web shows "Title kept" or a failure toast with the server's reason, and mobile shows an alert on failure. Before this row a failed or unchanged regeneration looked like success: the spinner stopped and nothing was said.

Files: contracts threadTitle.ts (outcome schemas), orchestrationV2.ts (optional lastTitleRegeneration on AppThread, ThreadShell and their Json forms; optional outcome on thread.title.regeneration.complete), orchestratorMcp.ts (optional lastTitleRegeneration on OrchestratorMcpThreadDetail); server Orchestrator.ts (record the outcome, :3609), ThreadTitleRegenerationService.ts (outcome per path; failure reason = last non-empty line of a TextGenerationError's detail, at most 300 characters; other causes "Title generation failed."), threadShellProjection.ts (upstream's ProjectionStore hunk, which lives here in GOAT), threadListView.ts (upstream's OrchestratorMcpService hunk); client-runtime threadCommands.ts (armTitleRegeneration, regenerateTitle) and new state/threadTitleRegeneration.ts; web new components/threadTitleRegenerationToast.ts, Sidebar.tsx, useThreadActionMenu.ts, chat/useThreadLifecycle.tsx; mobile features/home/useThreadListActions.ts.

Adaptations: upstream's runtime.ts hunk (export environmentConnectionAtom) is not needed, because GOAT already exports environmentConnectionAtoms from state/environmentConnections.ts and threadCommands.ts calls it. Upstream's OrchestrationV2LastTitleRegeneration is local to orchestrationV2.ts; GOAT declares it, with its Json form, in threadTitle.ts so orchestrationV2.ts (at a budget entry) gains one line per field. Upstream's VcsStatusBroadcaster.test.ts hunk is an unrelated fixture fix bundled in the commit and is not ported. Upstream changes the existing case "clears the marker and keeps the title when generation fails" (die -> TextGenerationError, plus an assertion). GOAT leaves that case as it is and covers the outcomes in new cases, so no existing server expectation changes; the existing die case still passes and now records "Title generation failed.".

GOAT-only behaviour to know: an older settled thread that is not in the shell snapshot (GOAT's olderSettled cut) settles the wait at once with no outcome, so it shows what it shows today, no toast. The multi-select regenerate in Sidebar now sends the requests together (upstream's shape) and clears the selection first; before, it went one by one and stopped at the first failure.

C4, each way:
- Older client, newer server: the new fields are optional and an older decoder ignores keys it does not know. The new orchestratorMcp.test.ts case decodes a newer thread read with the previous schema; the shell and app-thread fields are optional in the same way. An older client keeps today's behaviour, with no outcome shown.
- Newer client, older server: no lastTitleRegeneration arrives. The waiter keeps waiting while titleRegeneration still names its request, then settles with null when the marker clears. So the client shows today's behaviour and cannot hang. A server that cannot regenerate is still refused up front by readEnvironmentSupportsTitleRegeneration on web and environmentSupportsTitleRegeneration on mobile.
- Strict MCP consumers (condition (d)): OrchestratorMcpThreadDetail.lastTitleRegeneration is Schema.optional(Schema.NullOr(...)). The new case decodes an older host's read (no field) and a newer one (field present), and the previous schema decodes the newer read. Mutations: with the field required, both the new case and the existing peer-versions case fail ("Missing key"); with the field removed, the new case fails (expected undefined to deeply equal {...}).
- Reconnect during the wait: when the connection's projection phase is disconnected, the wait settles with null and the client shows nothing; the title still updates through the shell later. Test: "settles without an outcome when the environment disconnects while waiting".
- Stored data: the outcome is part of the thread's projected state (JSON), so no migration is needed. An older server that reads it ignores the optional field.
- Negative cases: a superseded request (the shell shows a later or earlier requestId and no marker for this request) resolves with null and is never shown another request's outcome. Test: the second half of "resolves with the outcome recorded for its own request". A first-message title records no outcome (new case). A stale execute records nothing (unchanged path). The failure reason keeps only the last line of the CLI detail, so the conversation text in earlier lines does not reach the shell, as upstream's fixture shows ("Conversation text" is in the detail and is not in the message).

Tests, failing first:
- apps/server ThreadTitleRegenerationService.test.ts, three new cases. With the service and Orchestrator changes set aside, "records the outcome of a regeneration: renamed, failed with its detail, unchanged" and "records a failed outcome when generation outlives its two-minute deadline" fail (AssertionError: Target cannot be null or undefined). "records no outcome for a first-message title" passes there by design. With the change: 10 passed (whole file).
- packages/client-runtime threadCommands.test.ts, upstream's two cases. With threadCommands.ts set aside, both fail (regenerateTitle undefined). Behaviour mutation: the waiter accepts any recorded outcome (last != null), and "resolves with the outcome recorded for its own request" fails (AssertionError). With the change: 27 passed (whole file).
- packages/contracts orchestratorMcp.test.ts, the new decode case (mutations above). 22 passed (whole file).
- apps/mobile useThreadListActions.test.ts, upstream's case. With the hook change set aside it fails (expected true to be false). With the change: 50 passed (whole file).
- apps/web threadTitleRegenerationToast.test.ts, new file with the new module, 3 cases (quiet on rename, unknown and interrupt; the failure reason, single and batch; kept, single and batch). 3 passed.
- Wider server run for shells and thread details (39 files, whole): channelWorkerObservation, ProjectionStore{,.provenance,.shellReads,.notifications}, ThreadStop, UsageLimitRecoveryWorker, RunStartHoldReactor, DelegatedCompletionInterrupt, ProjectionSettlement, WireProjection, ProviderTurnStartService, ThreadTitleRegenerationService, HostThreadsMcpService*, OrchestratorMcpService*: 39 files, 560 passed.
- Typecheck (vp run typecheck) exit 0 for contracts, client-runtime, server, web and mobile; vp lint on the changed files has no error, and the three Orchestrator.ts warnings are on existing lines 4552, 5788 and 5801.

Budgets: Orchestrator.ts 13516 -> 13525 (cut 13528), orchestrationV2.ts 4411 -> 4421 (cut 4438, after f64a05819a's move-out), orchestratorMcp.ts 1072 -> 1073 (cut 1083), Sidebar.tsx 3331 -> 3321 (net -10 by the row itself; no claim needed). The other changed files have no entry and stay under 1000 (orchestratorMcp.test.ts 869, threadCommands.test.ts 673, useThreadListActions.ts 862).

Exports changed (for K2, K10, M3): contracts: new ThreadTitleRegenerationStatus, ThreadTitleRegenerationOutcome, LastThreadTitleRegeneration, OrchestrationV2LastTitleRegeneration, OrchestrationV2LastTitleRegenerationJson (threadTitle.ts); new clampedPositiveInt (mcpClampedInt.ts, moved from a private const); OrchestrationV2AppThread, OrchestrationV2ThreadShell and their Json forms gain optional lastTitleRegeneration; OrchestrationV2Command thread.title.regeneration.complete gains optional outcome; OrchestratorMcpThreadDetail gains optional lastTitleRegeneration. client-runtime: createThreadEnvironmentAtoms' result gains armTitleRegeneration and regenerateTitle (resolves to ThreadTitleRegenerationOutcome | null); new module state/threadTitleRegeneration.ts (waitForTitleRegenerationOutcome, TitleRegenerationRequest, TitleRegenerationSources). Server: OrchestratorThreadAboveModeLimitError now lives in OrchestratorModeLimitError.ts and is re-exported from Orchestrator.ts.

P1 rows (no dev server in this lane): web, a single regenerate from the sidebar menu, the chat header menu and the shortcut showing "Title kept" when the model keeps the title and a failure toast with the reason; a multi-select regenerate showing "Kept n of m titles" or "Failed to regenerate n of m thread titles". Mobile: a failed regenerate shows the "Could not regenerate title" alert with the reason. Desktop wraps web.

### Rule 3, IV (i) mirrored: threadCommands.test.ts harness (quoted before the commit)

Upstream's own copy, 1c9ea568a1 (harness hunks; the added describe is new and needs no word):

```diff
@@ -22,11 +22,16 @@ import * as Layer from "effect/Layer";
 import * as Option from "effect/Option";
 import * as Queue from "effect/Queue";
 import * as Scope from "effect/Scope";
+import * as Stream from "effect/Stream";
 import * as SubscriptionRef from "effect/SubscriptionRef";
 import { Atom, AtomRegistry } from "effect/reactivity";
 
 import * as EnvironmentRegistry from "../connection/registry.ts";
-import { BearerConnectionTarget } from "../connection/model.ts";
+import {
+  AVAILABLE_CONNECTION_STATE,
+  BearerConnectionTarget,
+  type SupervisorConnectionState,
+} from "../connection/model.ts";
 import * as EnvironmentSupervisor from "../connection/supervisor.ts";
 import type { RpcSession } from "../rpc/session.ts";
 import { createThreadEnvironmentAtoms } from "./threadCommands.ts";
@@ -96,12 +101,19 @@ const makeHarness = Effect.fn("TestThreadCommands.makeHarness")(function* (optio
     reply: Deferred.Deferred<{ sequence: number }, Error>;
   }>();
   const reconciled = yield* Queue.unbounded<ThreadId>();
+  const connectionFollowed = yield* Deferred.make<void>();
+  const connection = yield* SubscriptionRef.make<SupervisorConnectionState>({
+    ...AVAILABLE_CONNECTION_STATE,
+    desired: true,
+    phase: "connected",
+  });
   const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
     target: new BearerConnectionTarget({
       environmentId: ENVIRONMENT_ID,
       label: "Test",
       connectionId: "test",
     }),
+    state: connection,
     session: yield* SubscriptionRef.make(
       Option.some({
         client: {
@@ -120,6 +132,12 @@ const makeHarness = Effect.fn("TestThreadCommands.makeHarness")(function* (optio
       Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
         run: (_environmentId, effect) =>
           Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
+        followStream: (_environmentId, stream) =>
+          Stream.provideService(
+            stream,
+            EnvironmentSupervisor.EnvironmentSupervisor,
+            supervisor,
+          ).pipe(Stream.onStart(Deferred.succeed(connectionFollowed, undefined))),
       } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
       Layer.succeed(
         SecureRandom.SecureRandom,
@@ -137,13 +155,24 @@ const makeHarness = Effect.fn("TestThreadCommands.makeHarness")(function* (optio
       ),
     ),
   );
-  const snapshotAtom = Atom.family((_environmentId: EnvironmentId) => Atom.make(SNAPSHOT));
+  const snapshotAtom = Atom.family((_environmentId: EnvironmentId) =>
+    Atom.make<OrchestrationV2ShellSnapshot | null>(SNAPSHOT),
+  );
   const commands = createThreadEnvironmentAtoms(runtime, snapshotAtom);
   const registry = AtomRegistry.make();
   yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
   const visibleAtom = commands.snapshotAtom(ENVIRONMENT_ID);
   registry.mount(visibleAtom);
-  return { registry, commands, snapshotAtom, visibleAtom, requests, reconciled };
+  return {
+    registry,
+    commands,
+    snapshotAtom,
+    visibleAtom,
+    requests,
+    reconciled,
+    connection,
+    connectionFollowed,
+  };
 });
 
 describe("history loading", () => {
```

GOAT's hunks, the same lines. The one difference is names: GOAT's harness never imported BearerConnectionTarget (its target is a plain object), so the model import is one line.

```diff
@@ -22,10 +22,12 @@ import * as Layer from "effect/Layer";
 import * as Option from "effect/Option";
 import * as Queue from "effect/Queue";
 import * as Scope from "effect/Scope";
+import * as Stream from "effect/Stream";
 import * as SubscriptionRef from "effect/SubscriptionRef";
 import { Atom, AtomRegistry } from "effect/reactivity";
 
 import * as EnvironmentRegistry from "../connection/registry.ts";
+import { AVAILABLE_CONNECTION_STATE, type SupervisorConnectionState } from "../connection/model.ts";
 import * as EnvironmentSupervisor from "../connection/supervisor.ts";
 import type { RpcSession } from "../rpc/session.ts";
 import { createThreadEnvironmentAtoms } from "./threadCommands.ts";
@@ -95,8 +97,15 @@ const makeHarness = Effect.fn("TestThreadCommands.makeHarness")(function* (optio
     reply: Deferred.Deferred<{ sequence: number }, Error>;
   }>();
   const reconciled = yield* Queue.unbounded<ThreadId>();
+  const connectionFollowed = yield* Deferred.make<void>();
+  const connection = yield* SubscriptionRef.make<SupervisorConnectionState>({
+    ...AVAILABLE_CONNECTION_STATE,
+    desired: true,
+    phase: "connected",
+  });
   const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
     target: { environmentId: ENVIRONMENT_ID },
+    state: connection,
     session: yield* SubscriptionRef.make(
       Option.some({
         client: {
@@ -115,6 +124,12 @@ const makeHarness = Effect.fn("TestThreadCommands.makeHarness")(function* (optio
       Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
         run: (_environmentId, effect) =>
           Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
+        followStream: (_environmentId, stream) =>
+          Stream.provideService(
+            stream,
+            EnvironmentSupervisor.EnvironmentSupervisor,
+            supervisor,
+          ).pipe(Stream.onStart(Deferred.succeed(connectionFollowed, undefined))),
       } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
       Layer.succeed(
         SecureRandom.SecureRandom,
@@ -132,13 +147,24 @@ const makeHarness = Effect.fn("TestThreadCommands.makeHarness")(function* (optio
       ),
     ),
   );
-  const snapshotAtom = Atom.family((_environmentId: EnvironmentId) => Atom.make(SNAPSHOT));
+  const snapshotAtom = Atom.family((_environmentId: EnvironmentId) =>
+    Atom.make<OrchestrationV2ShellSnapshot | null>(SNAPSHOT),
+  );
   const commands = createThreadEnvironmentAtoms(runtime, snapshotAtom);
   const registry = AtomRegistry.make();
   yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
   const visibleAtom = commands.snapshotAtom(ENVIRONMENT_ID);
   registry.mount(visibleAtom);
-  return { registry, commands, snapshotAtom, visibleAtom, requests, reconciled };
+  return {
+    registry,
+    commands,
+    snapshotAtom,
+    visibleAtom,
+    requests,
+    reconciled,
+    connection,
+    connectionFollowed,
+  };
 });
 
 describe("history loading", () => {
```

### Rule 3, IV and IV (i) mirrored: apps/mobile useThreadListActions.test.ts (quoted before the commit)

The mutationCases row changes the way upstream's does (IV, the same assertion in upstream's own copy). The state field, the mock factory's action list and return line, and the beforeEach reset are fixture and mock lines that upstream changes the same way (IV (i)). The added case is upstream's verbatim and new. GOAT's file differs from upstream's parent elsewhere (holdingRows and other state), so IV (iv) does not apply.

Upstream's hunks, 1c9ea568a1:

```diff
@@ -7,6 +7,7 @@ import {
   ProviderInstanceId,
   RunId,
   ThreadId,
+  type ThreadTitleRegenerationOutcome,
 } from "@t3tools/contracts";
 import * as Cause from "effect/Cause";
 import { AsyncResult } from "effect/reactivity";
@@ -18,6 +19,7 @@ const state = vi.hoisted(() => ({
   dropBusy: false,
   holdingRows: false,
   failedAction: null as string | null,
+  titleOutcome: null as ThreadTitleRegenerationOutcome | null,
   archivedRefreshes: [] as string[],
   scopes: new Map<string, Set<string>>(),
   shells: [] as EnvironmentThreadShell[],
@@ -141,6 +143,7 @@ vi.mock("../../state/threads", () => ({
       "reorderPin",
       "reorderActive",
       "updateMetadata",
+      "regenerateTitle",
     ].map((action) => [
       action,
       async (request: {
@@ -155,7 +158,7 @@ vi.mock("../../state/threads", () => ({
         if (action === state.failedAction)
           return AsyncResult.failure(Cause.fail(new Error("Server rejected action")));
         state.afterRequest?.();
-        return AsyncResult.success(undefined);
+        return AsyncResult.success(action === "regenerateTitle" ? state.titleOutcome : undefined);
       },
     ]),
   ),
@@ -186,12 +189,13 @@ const mutationCases = [
   ["unsnoozeThread", "unsnooze"],
   ["pinThread", "pin"],
   ["unpinThread", "unpin"],
-  ["regenerateThreadTitle", "updateMetadata"],
+  ["regenerateThreadTitle", "regenerateTitle"],
 ] as const;
 
 beforeEach(() => {
   state.connectedEnvironmentIds = [primaryEnvironmentId, otherEnvironmentId];
   state.failedAction = null;
+  state.titleOutcome = null;
   state.archivedRefreshes = [];
   state.pendingOrder = null;
   state.dropBusy = false;
```

GOAT's hunks:

```diff
@@ -7,6 +7,7 @@ import {
   ProviderInstanceId,
   RunId,
   ThreadId,
+  type ThreadTitleRegenerationOutcome,
 } from "@goat/contracts";
 import * as Cause from "effect/Cause";
 import { AsyncResult } from "effect/reactivity";
@@ -17,6 +18,7 @@ const state = vi.hoisted(() => ({
   pendingOrder: null as object | null,
   dropBusy: false,
   failedAction: null as string | null,
+  titleOutcome: null as ThreadTitleRegenerationOutcome | null,
   archivedRefreshes: [] as string[],
   scopes: new Map<string, Set<string>>(),
   shells: [] as EnvironmentThreadShell[],
@@ -143,6 +145,7 @@ vi.mock("../../state/threads", () => ({
       "reorderPin",
       "reorderActive",
       "updateMetadata",
+      "regenerateTitle",
     ].map((action) => [
       action,
       async (request: {
@@ -157,7 +160,7 @@ vi.mock("../../state/threads", () => ({
         if (action === state.failedAction)
           return AsyncResult.failure(Cause.fail(new Error("Server rejected action")));
         state.afterRequest?.();
-        return AsyncResult.success(undefined);
+        return AsyncResult.success(action === "regenerateTitle" ? state.titleOutcome : undefined);
       },
     ]),
   ),
@@ -188,12 +191,13 @@ const mutationCases = [
   ["unsnoozeThread", "unsnooze"],
   ["pinThread", "pin"],
   ["unpinThread", "unpin"],
-  ["regenerateThreadTitle", "updateMetadata"],
+  ["regenerateThreadTitle", "regenerateTitle"],
 ] as const;
 
 beforeEach(() => {
   state.connectedEnvironmentIds = [primaryEnvironmentId, otherEnvironmentId];
   state.failedAction = null;
+  state.titleOutcome = null;
   state.archivedRefreshes = [];
   state.pendingOrder = null;
   state.dropBusy = false;
```

ThreadTitleRegenerationService.test.ts and orchestratorMcp.test.ts: new cases only; no existing line changes beyond the import list (TextGenerationError, Fiber, TestClock in the service test; none in orchestratorMcp.test.ts, which already imports what the case uses).

NOT RUN for row 8: a real client pass (P1 rows above); the web Sidebar and useThreadActionMenu browser suites (they run in check:changed before READY); a mutation that removes the disconnect check (that case would then hang to the project timeout, so I did not run it); a running older GOAT release (older peers are shown by schema decode cases).


## Lane coordinator, row 9 claim ruled (records 20dfa95b595) and the trim adaptation

The runtime.test.ts claim (:896-939 at c995c5427a, describe "executeAtomQuery", to state/runtime.executeAtomQuery.test.ts) was accepted under IV (vi). The trim adaptation was called sound, to be stated here, in the fork delta, and in READY.

## Row 9 (c9f0caca1b): build notes and rule 3 (quoted before the commit)

Prior art for the GOAT part. Upstream's retainedTerminalHistory (contracts/terminal.ts in c9f0caca1b) cuts by bytes only and moves forward to the next code point. GOAT's client trim (terminalOutput.ts trimBufferToBytes at c995c5427a, lines 109-137) also drops the rest of a control sequence that the cut lands in, using contracts' terminalSequenceStateAfter and terminalSequenceEnd. The same parser model restores a history log tail in Manager.history.test.ts ("restores a log tail that starts inside a control sequence without its remainder"). Once the server trims, the client gets only the tail and cannot see where a sequence began. So the shared helper is GOAT's whole function, and a server-side byte cut would bring back the bug GOAT fixed on the client. Fork delta entry `terminal-retained-history` in the server-half commit.

Commits, in order:
1. e0e43c15bf, claim 9 move-out: Manager.ts:409-424 plus blank :425 at c995c5427a (normalizeChildCommandName) to terminal/childCommandName.ts:1-16. The only changed text is `export`; diff of the ranges is empty. Manager.ts 3116 -> 3100 (16 freed). Entry 3118 -> 3100 (3116 after T1c). Manager.test.ts whole: 71 passed. Server typecheck exits 0.
2. 0477e43092, runtime.test.ts move-out (IV (vi)): :896-938 plus blank :939 to state/runtime.executeAtomQuery.test.ts:9-51, and diff of the ranges is empty. The new file's other lines are its imports (1-8: @effect/vitest describe/expect/it; effect Cause, Effect, Latch; effect/reactivity Atom, AtomRegistry; blank; ./runtime.ts executeAtomQuery; blank). No import in runtime.test.ts became unused. Counts: 31 before; after, 29 + 2 = 31 with the same titles ("keeps concurrent query results correlated to their atoms", "settles when its caller aborts a waiting query"). 1276 -> 1232, entry 1232.
3. Client and contract half (next commit): contracts terminal.ts gains retainedTerminalHistory (GOAT's whole trim) and TerminalAttachInput.maxHistoryBytes (optional Int >= 0). client-runtime terminal.ts sends maxHistoryBytes: DEFAULT_MAX_TERMINAL_BUFFER_BYTES on every attach and resubscribe, which is the bound applyTerminalAttachStreamEvent keeps by default; no web or mobile caller passes another bound (rg). terminalOutput.ts drops trimBufferToBytes and calls the shared helper. runtime.test.ts 1232 -> 1234 (entry 1234, cut 1276).
4. Server half: new terminal/retainedAttachHistory.ts (retainedAttachListener: every event with a snapshot carries only retainedTerminalHistory(history, maxHistoryBytes); the input without the field passes the listener through). Manager.ts gets one import and wraps the two listeners in attachOutputStream: 3100 -> 3103 (entry 3103; 3116 after T1c). New test file terminal/Manager.retainedHistory.test.ts (Manager.test.ts is at its entry, per D4). The fork delta entry is in this commit.

C4, each way:
- Older client, newer server: no maxHistoryBytes, so the listener passes through and the full history is sent, as today.
- Newer client, older server: the older TerminalAttachInput is a non-strict Struct and ignores the extra key, so the full history comes and the client trims it as today.
- Reconnect during an attach: every resubscribe (resume: true) sends the same bound (runtime.test.ts's five mirrored expectations), and resync snapshots go through the same wrap (the publishPastOutputBudget step of upstream's test).
- Negative cases: maxHistoryBytes 0 gives an empty history (new case "sends an empty history to a client that retains none"). A cut inside a multibyte character starts at the next code point (upstream's case, 名). A cut inside a control sequence starts after it (new case "starts a bounded snapshot after a control sequence its cut lands in"). A BOM at the cut is kept (terminalSession.test.ts, mirrored). Output events are never trimmed (upstream's case: full and bounded streams pull equal events after "after\n" and after exit). Stored data: none.

Tests, failing first:
- runtime.test.ts "terminal attach resubscribes with resume only after the stream replied" (mirrored) fails without the client change: AssertionError, expected {...(3)} to deeply equal {...(4)}.
- terminalSession.test.ts "preserves a leading BOM in the retained snapshot tail" (mirrored) fails without the contracts helper: TypeError, retainedTerminalHistory is not a function.
- Manager.retainedHistory.test.ts: all 3 fail without the server change ("deeply equal", 'aaaa\u001b]0;title\u0007tail' to be 'tail', 'kept on the server\n' to be ''). Mutation: the contracts helper without its sequence step fails the control-sequence case ('tle\u0007tail' to be 'tail').
- With the change: client-runtime runtime.test.ts, terminalSession.test.ts and terminal.test.ts whole, 53 passed; Manager.retainedHistory.test.ts 3 passed. Typecheck exits 0 for contracts, client-runtime, web and mobile; the server typecheck and Manager suites are rerun at the server commit.
- The new test file copies publishPastOutputBudget byte for byte from Manager.test.ts:66-82 (Manager.grid.test.ts has the same copy) and adds a small emitAndWait helper of its own. No helper is moved or shared.

Exports changed: contracts gains retainedTerminalHistory, and TerminalAttachInput gains optional maxHistoryBytes. client-runtime: none (terminalOutput.ts's trimBufferToBytes was private). Server: new terminal/retainedAttachHistory.ts (retainedAttachListener) and terminal/childCommandName.ts (normalizeChildCommandName, was private).

### Rule 3, IV mirrored: runtime.test.ts (five expectations, an import and const sent) and terminalSession.test.ts (assertions added to the BOM case)

Upstream's hunks, c9f0caca1b:

```diff
diff --git a/packages/client-runtime/src/state/runtime.test.ts b/packages/client-runtime/src/state/runtime.test.ts
index 456d13109e..40188b2f81 100644
--- a/packages/client-runtime/src/state/runtime.test.ts
+++ b/packages/client-runtime/src/state/runtime.test.ts
@@ -1,5 +1,6 @@
 import { describe, expect, it } from "@effect/vitest";
 import {
+  DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
   EnvironmentId,
   type FilesystemBrowseEntry,
   ORCHESTRATION_V2_WS_METHODS,
@@ -552,6 +553,7 @@ describe("environment query lifecycle", () => {
         cwd: "/tmp/project",
         restartIfNotRunning: true,
       };
+      const sent = { ...input, maxHistoryBytes: DEFAULT_MAX_TERMINAL_BUFFER_BYTES };
       const atoms = createTerminalEnvironmentAtoms(harness.runtime);
       const registry = AtomRegistry.make();
       const atom = atoms.attach({ environmentId: QUERY_ENVIRONMENT.environmentId, input });
@@ -571,9 +573,9 @@ describe("environment query lifecycle", () => {
         }),
       );
 
-      expect(yield* Queue.take(inputs)).toEqual(input);
+      expect(yield* Queue.take(inputs)).toEqual(sent);
       yield* SubscriptionRef.set(harness.supervisorSession, Option.some({ ...firstSession }));
-      expect(yield* Queue.take(inputs)).toEqual(input);
+      expect(yield* Queue.take(inputs)).toEqual(sent);
       yield* Queue.offer(events, {
         type: "closed",
         threadId: input.threadId,
@@ -582,10 +584,10 @@ describe("environment query lifecycle", () => {
       yield* Deferred.await(received);
 
       yield* SubscriptionRef.set(harness.supervisorSession, Option.some({ ...firstSession }));
-      expect(yield* Queue.take(inputs)).toEqual({ ...input, resume: true });
+      expect(yield* Queue.take(inputs)).toEqual({ ...sent, resume: true });
       // Catalog replacements rerun the same stream through followStream's switchMap.
       yield* SubscriptionRef.update(harness.streamGeneration, (generation) => generation + 1);
-      expect(yield* Queue.take(inputs)).toEqual({ ...input, resume: true });
+      expect(yield* Queue.take(inputs)).toEqual({ ...sent, resume: true });
 
       unmount();
       registry.dispose();
@@ -597,7 +599,7 @@ describe("environment query lifecycle", () => {
           remountedRegistry.dispose();
         }),
       );
-      expect(yield* Queue.take(inputs)).toEqual(input);
+      expect(yield* Queue.take(inputs)).toEqual(sent);
     }),
   );
 
diff --git a/packages/client-runtime/src/state/terminalSession.test.ts b/packages/client-runtime/src/state/terminalSession.test.ts
index 4eef70e099..468b2ca8fd 100644
--- a/packages/client-runtime/src/state/terminalSession.test.ts
+++ b/packages/client-runtime/src/state/terminalSession.test.ts
@@ -1,6 +1,11 @@
 import { describe, expect, it } from "vite-plus/test";
 
-import { EnvironmentId, TerminalSessionSnapshot, ThreadId } from "@t3tools/contracts";
+import {
+  EnvironmentId,
+  retainedTerminalHistory,
+  TerminalSessionSnapshot,
+  ThreadId,
+} from "@t3tools/contracts";
 
 import {
   applyTerminalAttachStreamEvent,
@@ -119,6 +124,14 @@ describe("terminal session reducers", () => {
 
     expect(terminalOutputText(state.output)).toBe("\uFEFFtail");
     expect(state.output.retainedBytes).toBe(7);
+    const serverTail = retainedTerminalHistory("discard﻿tail", 7);
+    expect(
+      applyTerminalAttachStreamEvent(
+        EMPTY_TERMINAL_BUFFER_STATE,
+        { type: "snapshot", snapshot: { ...BASE_SNAPSHOT, history: serverTail } },
+        7,
+      ),
+    ).toEqual(state);
   });
 
   it("trims whole Unicode code points from a partially retained chunk", () => {
```

GOAT's hunks. They are the same lines; only the package name differs (@goat/contracts). The runtime.test.ts line numbers differ because of 0477e43092's move.

```diff
diff --git a/packages/client-runtime/src/state/runtime.test.ts b/packages/client-runtime/src/state/runtime.test.ts
index 9550e9e0f4..a1d56b277f 100644
--- a/packages/client-runtime/src/state/runtime.test.ts
+++ b/packages/client-runtime/src/state/runtime.test.ts
@@ -1,6 +1,7 @@
 import type { QueryPersistence } from "./queryPersistence.ts";
 import { describe, expect, it, vi } from "@effect/vitest";
 import {
+  DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
   EnvironmentId,
   type PreviewEvent,
   type TerminalAttachInput,
@@ -292,6 +293,7 @@ describe("environment query lifecycle", () => {
         cwd: "/tmp/project",
         restartIfNotRunning: true,
       };
+      const sent = { ...input, maxHistoryBytes: DEFAULT_MAX_TERMINAL_BUFFER_BYTES };
       const atoms = createTerminalEnvironmentAtoms(harness.runtime);
       const registry = AtomRegistry.make();
       const atom = atoms.attach({ environmentId: QUERY_ENVIRONMENT.environmentId, input });
@@ -311,9 +313,9 @@ describe("environment query lifecycle", () => {
         }),
       );
 
-      expect(yield* Queue.take(inputs)).toEqual(input);
+      expect(yield* Queue.take(inputs)).toEqual(sent);
       yield* SubscriptionRef.set(harness.supervisorSession, Option.some({ ...firstSession }));
-      expect(yield* Queue.take(inputs)).toEqual(input);
+      expect(yield* Queue.take(inputs)).toEqual(sent);
       yield* Queue.offer(events, {
         type: "closed",
         threadId: input.threadId,
@@ -322,10 +324,10 @@ describe("environment query lifecycle", () => {
       yield* Deferred.await(received);
 
       yield* SubscriptionRef.set(harness.supervisorSession, Option.some({ ...firstSession }));
-      expect(yield* Queue.take(inputs)).toEqual({ ...input, resume: true });
+      expect(yield* Queue.take(inputs)).toEqual({ ...sent, resume: true });
       // Catalog replacements rerun the same stream through followStream's switchMap.
       yield* SubscriptionRef.update(harness.streamGeneration, (generation) => generation + 1);
-      expect(yield* Queue.take(inputs)).toEqual({ ...input, resume: true });
+      expect(yield* Queue.take(inputs)).toEqual({ ...sent, resume: true });
 
       unmount();
       registry.dispose();
@@ -337,7 +339,7 @@ describe("environment query lifecycle", () => {
           remountedRegistry.dispose();
         }),
       );
-      expect(yield* Queue.take(inputs)).toEqual(input);
+      expect(yield* Queue.take(inputs)).toEqual(sent);
     }),
   );
 
diff --git a/packages/client-runtime/src/state/terminalSession.test.ts b/packages/client-runtime/src/state/terminalSession.test.ts
index a548eec7e6..7ad89d7d85 100644
--- a/packages/client-runtime/src/state/terminalSession.test.ts
+++ b/packages/client-runtime/src/state/terminalSession.test.ts
@@ -1,6 +1,11 @@
 import { describe, expect, it } from "vite-plus/test";
 
-import { EnvironmentId, TerminalSessionSnapshot, ThreadId } from "@goat/contracts";
+import {
+  EnvironmentId,
+  retainedTerminalHistory,
+  TerminalSessionSnapshot,
+  ThreadId,
+} from "@goat/contracts";
 
 import {
   applyTerminalAttachStreamEvent,
@@ -120,6 +125,14 @@ describe("terminal session reducers", () => {
 
     expect(terminalOutputText(state.output)).toBe("\uFEFFtail");
     expect(state.output.retainedBytes).toBe(7);
+    const serverTail = retainedTerminalHistory("discard﻿tail", 7);
+    expect(
+      applyTerminalAttachStreamEvent(
+        EMPTY_TERMINAL_BUFFER_STATE,
+        { type: "snapshot", snapshot: { ...BASE_SNAPSHOT, history: serverTail } },
+        7,
+      ),
+    ).toEqual(state);
   });
 
   it("trims whole Unicode code points from a partially retained chunk", () => {
```

NOT RUN for row 9: a real slow-link attach measurement (upstream's 5,555 ms to 751 ms is not reproduced here); a running older GOAT server; a mobile native run (client-runtime covers the mobile path).


## Coordinator, run 1836, every lane (verbatim)

EVERY LANE: a typecheck or test claim names the package as vp resolves it (apps/server is "goat"), and a filter that matches nothing is not a pass.

K7 under it: every typecheck in this lane ran with no filter, as `vp run typecheck` inside the package directory. vp resolves the packages as @goat/contracts (packages/contracts), @goat/client-runtime (packages/client-runtime), @goat/shared (packages/shared), goat (apps/server), @goat/web (apps/web) and @goat/mobile (apps/mobile). Test claims name their files and the counts that ran, and none of them rests on a filter that matched nothing.

## READY (rows 1-9)

Integration merge, once: `git merge --no-edit origin/chase/t3-261114-next3` with lane head 1e1518f039d61c90a8284434af96abd58aed3a7c and integration head 259883c788bb32d5601023932e07f879bde9af60. git reported "Auto-merging oxlint-plugin-goat/code-budgets.json / CONFLICT (content): Merge conflict in oxlint-plugin-goat/code-budgets.json". The only hunk was apps/server/src/terminal/Manager.ts: ours 3103, base 3118, theirs 3116. It is settled by countLines of the merged file (wc -l 3103). Merge commit 9fb762a2b5f969b2948b3edb22bf12b42a07d3e2, with parents 1e1518f039 and 259883c788.

Lane gate on the merge commit, `vp run check:changed origin/chase/t3-261114-next3`, exit 0: format, lint, knip 1/2 and 2/2, graphql (apps/server), agent surface audit, agent context budget, typecheck (42 packages) and test (478 files, 9646 tests) all pass.

Focused runs after the merge, whole files with no -t: the @goat/web files beside the changed web files (Sidebar.browser, Sidebar.drag.browser, Sidebar.logic.browser, Sidebar.pointer.browser, Sidebar.renderIsolation.browser, Sidebar.shiftGuard.browser, Sidebar.shortcuts.browser, Sidebar.shortcuts.noBrowser.browser, chat/useThreadLifecycle.browser, hooks/useThreadActionMenu), 10 files, 43 passed.

Row 7 reruns under the 22:45 rule, whole files, on 1e1518f039: goat (apps/server) src/relay (AgentAwarenessRelay{,.startup,.subagent,.userWait}, HeldHooksWaker, SubagentWaits), ProjectionPendingRequest.test.ts, ShellStream.test.ts and ProjectionStore.notifications.test.ts: 9 files, 70 passed. @goat/shared agentAwareness.test.ts: 29 passed. @goat/client-runtime state/threadShell.test.ts: 15 passed.

Exports changed, against section 3 (condition (e)). Shipped as planned in section 3: rpc/client.ts currentSession, requestInSession, runStreamInSession and subscriptionRetryDelay (requestGuarded keeps its name and becomes a wrapper); dispatch.ts dispatchMessage's resend flag; commands.ts StartThreadTurnInput.resendAfterSocketLoss; serverUpdate.ts (matchesServerUpdateResumeEvent's acceptedAt and validateServerUpdateReadyEvent's foreign outcome), re-exported from state/server.ts; markdownImages.ts WorkspaceFile relative; contracts assets.ts media-file hostOnly; terminal.ts retainedTerminalHistory and TerminalAttachInput.maxHistoryBytes; orchestrationV2.ts userOnly, lastTitleRegeneration and outcome; threadTitle.ts outcome schemas; orchestratorMcp.ts thread detail lastTitleRegeneration (optional); threadCommands.ts regenerateTitle and armTitleRegeneration; new state/threadTitleRegeneration.ts; shared agentAwareness.ts turnItemCanChangeUserWait.
Different from section 3: (1) state/runtime.ts environmentConnectionAtom is NOT added, because GOAT already exports environmentConnectionAtoms (state/environmentConnections.ts). (2) SubagentRequestAwareness.waitsForInput is NOT added; row 7 carries the user-only wait by PendingRuntimeRequestSummary.userOnly and turnItemCanChangeUserWait, under the coordinator's 22:32 points.
Not in section 3 (new modules from move-outs and adaptations): client-runtime operations/commandInputs.ts (nine input interfaces, re-exported as types from commands.ts; CommandMetadata is now exported), state/threadResumeCache.ts, state/threadSubscriptionRecovery.ts (makeThreadSubscriptionRecovery), serverUpdate.ts readAcceptingReady and SERVER_UPDATE_RESUME_TIMEOUT, and hubNodes.ts isUnknownRequestTagError (row 3, a37c72ff48). contracts: goalCommand.ts (parseGoalCommand and OrchestrationV2GoalCommand, re-exported from orchestrationV2.ts) and mcpClampedInt.ts (clampedPositiveInt). goat (apps/server): OrchestratorModeLimitError.ts (re-exported from Orchestrator.ts), terminal/childCommandName.ts and terminal/retainedAttachHistory.ts.

For the review: row 9's shared retainedTerminalHistory is GOAT's whole client trim, which also drops the rest of a control sequence the cut lands in. Upstream's helper cuts by bytes only. Fork delta `terminal-retained-history`. The case "starts a bounded snapshot after a control sequence its cut lands in" pins it and fails under the mutation that drops the sequence step.

Claims on card 10.028: claims 1-7 and 9, and the runtime.test.ts claim, were cut. Claim 8 was released. Claims 10 and 11 (ws.ts readClientOwners, rpc.ts preview RPCs) go with rows 10 and 11 to K7b and were not cut here.

NOT RUN for the lane: the P1 real-client pass (rows 6, 7 and 8 captures, the web title toasts, the mobile alert); a mobile native run; a running older GOAT release (older peers are shown by schema decode cases and optional-field tests); a live GOAT Connect relay (row 5); a slow-link terminal attach measurement (row 9); goat-ci (the coordinator dispatches lane=quick on this head). K7b (rows 10 and 11, dc3fdc6a3e and 2482b03a01, and 8b2763f638's catalog half) sends its C4 plan after this READY.


## Coordinator, 2026-11-17 23:40 UTC, section I (K7), verbatim

I. K7 (READY at 9fb762a2b5f969b2948b3edb22bf12b42a07d3e2)
READ BY ME: the head on origin (fresh fetch; parents 1e1518f039 and 259883c788); the stat (79 files, +4203/-840, 21 non-merge commits); Manager.ts 3103 = its entry; next3-K7.md section 2, section 3 and the READY section at records 00bb0cf8aa; the source diffs of dispatch.ts, rpc/client.ts, driver.ts, managedRelayState.ts, threads.ts, ThreadTitleRegenerationService.ts, Orchestrator.ts, threadListView.ts, threadCommands.ts, threadShell.ts, ShellStream.ts, AgentAwarenessRelay.ts, agentAwareness.ts, ProjectionPendingRequest.ts, contracts terminal.ts, threadTitle.ts, assets.ts; threadSubscriptionRecovery.ts, threadTitleRegeneration.ts, retainedAttachHistory.ts and the web toast module whole. NOT RUN: any test.
DISPATCHED: goat-ci lane=quick https://github.com/goat-si/goat/actions/runs/44200102994 on the exact head: completed SUCCESS (read 23:40 UTC). Quick only: no Linux-only case in this lane.
RULED:
1. K7 gets TWO fresh C4 reviews, split by rows, because nine C4 rows and 4,200 changed lines are more than one reviewer reads well and K2, K10 and M3 build on it: "conn" (rows 1-5: resend, subscriptions, server update wait, routes and tokens) and "wire" (rows 6-9, budgets, rule 3, the merge commit). Briefs are written: /Users/jun/handoff-in/chase/briefs/next3-K7-conn-9fb762a2.md and next3-K7-wire-9fb762a2.md. The cap stays two: "conn" starts when the first of K5's and K10's reviews reports, "wire" when the second does.
2. The head stays put at 9fb762a2b5 until both reports are in. K7 may write K7b's plan meanwhile (plan only, as ruled).
3. Merge order stays K5, K10, K7. My merge-tree reading: K7 merges clean with K5's head; with K10's head 4fa174d23c it conflicts in devlog/_chase/010_fork_delta.md and oxlint-plugin-goat/code-budgets.json (ChatMarkdown.tsx and orchestrationV2.ts auto-merge). So K7 will need a second integration merge after K10 lands; that is allowed (the "once" was for the READY), and it comes with K7's fix round if there is one. K7 does nothing about it now.
4. Open questions from my reading, already in the briefs, not yet findings. K7 may prepare answers in its record as K5 did, with no push: (a) dispatch.ts: the give-up branch reads supervisor.state's CURRENT value first; if a dying socket fails the request before the supervisor leaves "available", the resend never happens. In which order does the real supervisor fail requests, clear the session and change phase, and does any test drive the real supervisor? (b) the wait for a replacement session has no total bound: a laptop asleep for hours resends on wake; what does the composer show meanwhile and can the person have typed the message again? (c) rpc/client.ts: every durable subscription now retries on the SAME session after a transport failure; what does a subscribe on a dead, not yet replaced session do, and how many warnings per minute? (d) a chunk the client can never decode resubscribes for a full snapshot every 30 s forever: cost and what the screen does. (e) a mounted thread whose id is gone now polls HTTP at up to 30 s for as long as it is mounted. (f) serverUpdate.ts: is ready.at constant for the life of one server process on every GOAT release in the field? If any server stamps it per subscribe, a reconnect to the same updating process ends the wait as "missing outcome". (g) ThreadTitleRegenerationService.failureMessage puts the last line of a provider's TextGenerationError.detail into a stored event, the shell, a toast and the MCP thread detail; the plan said no provider error beyond today's text. What can that line hold? (h) waitForTitleRegenerationOutcome has no deadline of its own; which server paths leave titleRegeneration armed without a completed event? (i) every entry point that regenerates a title (palette, keybinding, header, mobile thread screen, MCP): which report the outcome? (j) upstream's waitsForInput did not ship: does the coordinating agent still learn that its child waits for a person? (k) the attach trim encodes the whole history per snapshot on the server loop; if the server never holds more than 512 KiB it is a no-op that still pays; and is the attach input a key anywhere (T1c's lease pins, an atom family)?

## Answers to I.4 (prepared on 9fb762a2b5, read from source; no code changed, no push to the code branch)

(a) The give-up reads the phase, and only "available" or "blocked" stop the resend (dispatch.ts:56-60). The real supervisor enters "available" only when the person no longer wants the connection (supervisor.ts:1221-1229: `!currentIntent.desired` -> clearLease -> availableState). It enters "blocked" on a ConnectionBlockedError: authorization, configuration (:1301-1316). A dying socket never passes through "available". The run loop sees the lease end, clears it (clearLease, :402-405, also in the run's ensuring at :1163), and moves to "backoff" (:1340-1351), "connecting" (:1325) or "offline" (:1234-1242; network down or suspended). None of those stops the wait, and a new session ends it (:47-55). The RPC client fails the in-flight request first, as an RpcClientError or an interrupt when the session closes (dispatch.ts:42-45); the session clears after; the phase changes last. Since "connected" is not a stop phase either, the order cannot end the wait early. GAP, honest: no test drives the real supervisor. dispatch.socketLoss.test.ts:79 uses `EnvironmentSupervisor.of` with a SubscriptionRef state and session the test drives. Proposal for a fix round: one case on the real supervisor (supervisor.ts make with a fake connection driver whose session dies), checking that the resent dispatch lands on the replacement session.

(b) Yes, there is no total bound by design (upstream main has the same shape). Each attempt is bounded at 60 s, there are at most 2 resends (dispatch.ts:18), and the wait for a replacement ends only on a new session, "available" or "blocked". During the wait, web (desktop is the same; mobile opts out, threadOutboxDelivery.ts:309 and :349 pass resendAfterSocketLoss: false, since its outbox retries) shows the optimistic user bubble in the timeline. The draft was cleared at send (useComposerSend.ts:1256-1267), the composer is free, and the connection banner shows the reconnect. The failed-send restore runs only after the loop gives up (condition (a)'s test useComposerSend.resend.browser.test.tsx). The person can type again, but that is a new message with a new messageId and commandId, so both land if both reach the server. The resend itself is safe against doubling (Orchestrator.messageReceiptReplay.test.ts: the same commandId leaves one message). On a wake hours later, the resend applies the message then if the server never got it. Option for a fix round, if wanted: a total bound (for example, give up and restore the draft after N minutes without a session), which differs from upstream.

(c) A subscribe on a dead, not yet replaced session fails fast with the same transport error and goes round the same-session retry (client.ts row 3 hunk: a warning "Durable RPC subscription stream ended; resubscribing." per failed stream, then a 1 s delay doubling to 30 s). The counter streamFailureRetries lives in the per-session closure, so a replacement session resets it, and switchMap interrupts a pending retry when the session changes (client.streamRecovery.test.ts "a pending retry does not resubscribe a replaced session"). Warnings: at most 6 per durable subscription in the first minute on one dead session (1+2+4+8+16+30 s), then 2 per minute. The window is short in practice, because the supervisor clears the dead lease when its run fiber ends, and the cleared session (Option.none) ends the switchMap's inner stream. For roughly 10 durable subscriptions a client holds per environment, a dead session that lingers a full minute logs about 60 warnings, which is bounded. The finite thread search and a server without the method (isUnknownRequestTagError) keep waiting for the next session instead.

(d) Correct. A chunk the client can never decode is a SchemaError die, and with no onDefect it resubscribes on the same session with backoff to 30 s. The counter is not reset by a first value, so a stream that keeps emitting before the bad chunk still backs off to 30 s and stays there. Cost: one fresh subscribe per 30 s per affected subscription. For the shell that is a snapshot, the 182 KB-class config in K7b's measurement scale for config and the shell snapshot size for the shell, plus one warning per 30 s. Screen: before row 3 the view froze silently on the last good state; now it keeps the last good state, takes every update up to the bad chunk again on each resubscribe, and never shows an error. Threads (onDefect) are row 2: they show "Could not synchronize the thread." and back off the same way. Option for a fix round: after K consecutive decode defects with no good chunk in between, stop and surface an error (for example "This environment sends data this app cannot read; update the app"). That differs from upstream, which retries.

(e) Correct, by upstream's design (de21fbcff3, "keeps asking a mounted thread over HTTP after a miss until it exists"). A 404 marks the thread deleted, so the screen shows the missing-thread state, drops the resume cache, and asks HTTP again after 250 ms doubling to 30 s (threads.ts:948-953, threadSubscriptionRecovery.ts `missed`). That is one small HTTP 404 per 30 s per mounted missing thread, and it stops on unmount. A delete event still parks for good (`parksDeleted`, threads.ts:884), so a thread deleted while watched does not poll. The miss case is a thread not created yet (a draft promotion, a link opened before the create lands) or a URL to a thread that is gone.

(f) Yes, on every GOAT release. ready is published once per process, at the end of startup (serverRuntimeStartup.ts:851-862: `at: DateTime.formatIso(yield* DateTime.now)` inside the startup program). ServerLifecycleEvents keeps the last event per type (serverLifecycleEvents.ts publish), and the subscribeServerLifecycle handler replays that stored stream (ws.ts:3337-3340); it never stamps a new one. `git log -L` on the handler shows only the initial commit (b59034d2b3) and two chase syncs (cef8330992, 02511156b0), none changing that. So a reconnect to the same process reads the same at, and the wait does not end as "missing outcome". Upstream's servers are not GOAT clients' peers here.

(g) It is the last non-empty line of the provider CLI's whole stderr, or stdout when stderr is empty. Codex: CodexTextGeneration.ts:615-624 ("Codex CLI command failed: " + stderr). Claude: ClaudeTextGeneration.ts:384-393 (its error result JSON, or stderr). The SDK providers (Pi, Cursor) build their own short details: "request timed out", "rejected model ...", "is required but not available on PATH". The Codex CLI echoes the prompt it sent on stderr, and the title prompt is the conversation. So if the CLI exits non-zero without an error line after the echo (killed, OOM), the last line is a line of the conversation: the thread's own text, which every reader of the thread already sees. It is capped at 300 characters, and only regenerations a person asked for record it. It can also hold a provider's own error text (status line, request id). I found no path that puts a secret there, but no guard proves it either. This is upstream's behaviour (1c9ea568a1 copies the same line). Options for a fix round, a decision for the coordinator: (A) keep upstream's line; (B) record the line only for GOAT-built details and record "<Provider> could not generate a title." for a CLI's raw stderr or stdout, keeping the raw text in the server log. B differs from upstream.

(h) A regeneration runs as a durable outbox effect (Orchestrator.ts:3719-3725, pendingThreadTitleGenerationEffect). Every way out of execute records a completion: renamed, unchanged, failed, or the 2-minute deadline (OwnedEffectDeadline.generateTitle, ThreadTitleRegenerationService.ts `failed` "took longer than two minutes"), except two:
1. stale: another request re-armed the thread. The client's waiter then sees a different requestId and settles with null (threadTitleRegeneration.ts settledOutcome).
2. interruption: server shutdown or worker restart. The outbox effect stays pending and runs again after restart, and the client's waiter settles with null when its connection reads disconnected.
Left armed with the client still waiting: a connected server whose effect worker has not yet started the effect (a backed-up worker); the 2-minute deadline starts only when execute runs. Other things clear the marker without a completion event: thread deletion (ThreadDeletion.ts:65), fork (ThreadForkService.ts:120, a new thread) and a manual rename (Orchestrator.ts:3389-3391, `title !== undefined` sets null). In each of those, the waiter sees the marker gone without its own outcome and settles with null. An older server never writes lastTitleRegeneration, so the waiter settles with null when the marker clears.

(i)
- Web and desktop:
  - sidebar row menu (Sidebar.tsx:2614)
  - sidebar multi-select (Sidebar.tsx:2170)
  - chat header menu (ChatHeader.tsx:247 -> useThreadActionMenu.ts:276)
  - the keybinding thread.regenerateTitle (useThreadLifecycle.tsx:713)
  All four show the outcome toast. The command palette has no regenerate command (CommandPaletteThreadItems.tsx and the palette files have none).
- Mobile: the thread list menus, in the home list (HomeRouteScreen.tsx:358) and the navigation sidebar (ThreadNavigationSidebar.tsx:629), both through thread-list-v2-items.tsx:736 -> useThreadListActions.regenerateThreadTitle. They alert on failure and say nothing for "unchanged" (upstream's choice). The mobile thread screen has no regenerate entry (no hit in features/threads/ThreadDetail*).
- MCP: goat_thread_metadata with action regenerate_title (ThreadMetadataMcpService.ts:85-90) returns the armed titleRegeneration and does not wait. The outcome is readable afterwards in the thread detail's optional lastTitleRegeneration.

(j) Yes, through GOAT's own fields. For a coordinating agent: the MCP thread list and read count a child's waiting secret_request and human_handoff cards in pendingRequestCount, with foldState "attention" (OrchestratorMcpService.lazyThreads.test.ts:283-305, :473; this predates K7). For the person: upstream's waitsForInput tells the relay "waiting_for_input" from "waiting_for_approval". GOAT's SubagentRequestAwareness already carries that as `phase: "waiting_for_approval" | "waiting_for_input"` (packages/shared/src/agentAwareness.ts:33, :69), so the field would duplicate it. Row 7's per-client table (condition (c)) says what each client shows.

(k) The server keeps up to 8 MiB of history per terminal (BoundedTerminalHistory.ts:7, DEFAULT_HISTORY_BYTE_LIMIT), so the trim to 512 KiB matters: up to about 7.5 MiB less per attach on a busy terminal. The cost is one TextEncoder.encode of the whole history per snapshot (attach and resync, never per output event). For a history at or under 512 KiB it returns the input after that one encode. Option for a fix round, cheap and behaviour-preserving: skip the encode when 3 x history.length <= maxBytes (UTF-8 is at most 3 bytes per UTF-16 unit), and encode only the last maxBytes UTF-16 units when the history is longer (each unit is at least one byte, so the tail holds the cut). The control-sequence scan already starts from the last ESC before the cut (terminalSequenceStateAfter uses lastIndexOf). Keys: nothing keys on maxHistoryBytes. The client adds it inside the subscribe effect, not to the atom family key (state/terminal.ts:72-77; the family keys on the caller's target, runtime.ts:745). The server's viewer retention keys on threadId and terminalId (Manager.ts:2534 toSessionKey), prepareTerminal reads only threadId and cwd (ThreadWorkspaceService.ts:371-384), and T1c's lease order keys on the workspace folder (terminalLeaseOrder.ts).


## Coordinator, 2026-11-17 23:58 UTC, II (K7), verbatim

II. K7: the conn review STARTED at 23:5x UTC on 9fb762a2b5 (task goat-next3-K7-conn-review-9fb762a2, the slot K10's review freed). The wire review starts when K5's review reports. Head stays put.
On K7's prepared answers (records b167790ba4), which the reviewers will check:
- (g) RULED now, for the fix round: B. The stored outcome, the shell, the toast and the MCP thread detail carry only sentences the server wrote: the fixed ones that exist (no project, no messages, over two minutes) and a generic "Title generation failed." for anything that is raw provider or CLI output. The raw text goes to the server log only. Where the server can classify the cause without quoting the text (not signed in, quota), a fixed sentence per class is allowed, each with a case. Record it in the fork delta as a difference from upstream, with the reason: the plan said no provider text beyond today's, and a CLI's last stderr line can be anything.
- (a) accepted as a test gap: one case that drives the REAL supervisor through a dying socket, in the fix round.
- (b), (d), (k): options, not ordered. They wait for the reviewers' reading; no code before the two reports.
- (i): the command palette and the mobile thread screen report nothing: the wire reviewer weighs it; K7 writes which of the two can take the outcome in a few lines.

## Coordinator, 2026-11-17 23:50:37 UTC, II, verbatim

II. Queue and one rule changed.
- K7's wire review STARTED now (task goat-next3-K7-wire-review-9fb762a2), beside the conn review. Both read 9fb762a2b5; K7's head stays put until both report.
- A fix-delta review (small: the delta and its test files only) does not count against the cap of two. So K5's fix-delta review starts as soon as its head and runs are there, and K10's likewise.
- SF3 and N10 may start code now (K5's review has reported), heavy jobs by the machine token, K5's and K10's fix rounds first.

## K7 on II (no code; head stays 9fb762a2b5)

- (g) B is taken for the fix round. Only server-written sentences go into the outcome. Fork delta entry with the reason. Cases for each class the server can name without quoting.
- (a) The fix round adds one case on the real supervisor through a dying socket.
- (b), (d), (k) wait for the two reports.
- (i), which of the two can take the outcome in a few lines. The mobile thread screen can. Its header already has a menu (apps/mobile/src/features/threads/ThreadHeader.tsx:29-61, the history menu), and useThreadListActions.regenerateThreadTitle already reports a failure (the "Could not regenerate title" alert, row 8). One menu item calling it is a few lines, plus a P1 row. The command palette cannot, not in a few lines. It has no per-thread actions at all (CommandPalette.logic.ts lists threads only to open them; settle, archive and rename are not there either). A regenerate entry there is a new "active thread actions" group, not a small addition. The keyboard path is already covered: the keybinding thread.regenerateTitle (useThreadLifecycle.tsx:713) shows the outcome toast. My suggestion for the wire reviewer: the mobile thread header item if the review wants parity, and no palette entry.


## Coordinator, 2026-11-18 00:10:01 UTC, section I (K7), verbatim

I. K7 (chase/t3-261114-next3-k7-client-protocol, head 9fb762a2b5f969b2948b3edb22bf12b42a07d3e2)
Reports saved whole: /Users/jun/handoff-in/chase/next3-K7-conn-review-9fb762a2.md (17,636 bytes) and next3-K7-wire-review-9fb762a2.md (20,960 bytes). Verdicts: conn two P2 and six P3; wire one P2 and four P3; no P0 or P1. Rows 4, 5, 6, 7 and 9, the move-outs, the budgets, rule 3 and the merge commit check out. READ BY ME at the head, after the reports: dispatch.ts:20-65, threads.ts:424-434 and :955-982, contracts threadTitle.ts whole, threadShell.ts:48-76, threadTitleRegeneration.ts:18-34. NOT RUN by me: any test.

RULED, the fix round on top of 9fb762a2b5, one commit per finding, the failing case first for the two conn P2s:
1. conn P2-1 (dispatch.ts:43-61; a reply lost on a healthy socket waits with no end, and Send in that thread is refused meanwhile). Two parts. (i) A third branch in the race: after a grace, if the SAME session is still current and the phase is still "connected", resend on it; it counts against the existing cap of two. The grace is one constant, and the record says why that value (the real supervisor clears a dead session right after the broadcast, so a session that survives the grace is a live one). (ii) A total bound of 10 minutes on the whole wait, one constant; past it the send gives up and the draft is restored with an error that says the message may not have been sent. This is answer (b): the bound is taken; it differs from upstream, so a fork delta line. Cases on TestClock: same session and connected after the grace resends once and one message lands; a session cleared inside the grace does not resend on it; the bound gives up and the existing restore path shows the draft.
2. conn P2-2 (threads.ts:430, :962, :978; after an apply defect the resubscribe carries afterSequence past the batch never applied). Fix as the reviewer says: restartAfterDefect makes the next subscribe leave afterSequence out, so a fresh snapshot replaces the state. Do not move the lastSequence write after the fold instead: that replays the same batch into the same throw. The probe (/tmp/k7conn-review-9fb762a2/notes/probe.threads.test.ts.txt) becomes the case; a real event the fold dies on is better than vi.mock if one exists, else the mock stands as fault injection. Correct the false comment and the plan's "never resumed past a half-applied batch (tested)". Upstream de21fbcff3 has the same gap: a fork delta line.
3. wire P2-1 (failureMessage): B, as ruled at 23:49 UTC, now confirmed by the reviewer. Unchanged: only sentences the server wrote; raw provider or CLI text to the redacted server log only; a case that a CLI failure's detail does not reach the event; fork delta entry.
4. conn P3-1 and P3-2: one case each (mutations M6 and M8 must fail). conn P3-5: the real-supervisor case already ordered.
5. conn P3-3: reset streamFailureRetries once a stream has stayed up 60 s, with a TestClock case; if that cannot be done without a wall-clock read, a Limits sentence instead.
6. conn P3-4: pin the attempt with currentSession() and requestInSession.
7. conn P3-6: the three record corrections. The IDLE_SERVER_UPDATE_STATE export stays; the record names it and the import cycle.
8. wire P3-1: a maximum length of 300 on the COMMAND's message (the public input), not on the stored event or the shell schema, which must keep decoding; one case that a longer message is refused.
9. wire P3-2: settle from the open thread's own subscription (AppThread.lastTitleRegeneration) when the thread is not in the shell snapshot, with a case, if it stays inside threadTitleRegeneration.ts and its caller at about 30 lines; otherwise a Limits sentence and an issue draft. K7 says which in the record before the commit.
10. wire P3-3: intended behavior ruled: a pending userOnly card (secret request, human handoff) of a delegated child marks the parent "Input needed" until it is answered or cancelled, whether or not the child's run is live; the server already decides pending. So the client roll-up skips the live-run test for userOnly cards. Failing case first.
11. wire P3-4: no change; upstream's text stays.
12. Answers closed: (d) a Limits sentence, no code, and an issue draft for an "update this app" message after repeated decode defects; (k) the encode-skip guard is NOT taken (2.79 ms per 8 MiB attach is not worth a second code path); (i) no new entry point in this lane: no mobile thread header item, no palette entry.
13. Budgets: no entry raised; any touched entry equals countLines at the new head.

Then: push the fix head (still on 9fb762a2b5, no integration merge yet) and say READY. I dispatch goat-ci quick and start ONE fresh fix-delta review (it does not count against the cap). The second integration merge comes after K10 has merged: 010_fork_delta.md keeps both sections; code-budgets.json takes countLines of the merged files (the wire reviewer measured ChatMarkdown.tsx 1658, orchestrationV2.ts 4382, orchestratorMcp.ts 1073; count again then). Merge order stays K5, K10, K7. K7b's branches are still cut only after K7 merges. Heavy jobs by the machine token, ps first, in its own step.

Lane coordinator: both review reports are on the records branch at devlog/_chase/261114_lanes/K7-review/ (records 30b080876e5, cmp identical), and the probe at K7-review/probe.threads.test.ts.txt (records 2ce7916ae1d).

## Fix round (on 9fb762a2b5; one commit per finding)

Ruling 9, decided before any commit, as asked: a LIMITS sentence and an issue draft, no code. Settling from the open thread's own subscription needs the thread detail state (state/threads.ts, EnvironmentThreadState per thread) inside the waiter. createThreadEnvironmentAtoms(runtime, snapshotAtom) receives only the shell snapshot atom, so the open thread's state would have to be passed in through createThreadEnvironmentAtoms and its web and mobile callers (apps/web and apps/mobile state/threads). That goes beyond threadTitleRegeneration.ts and its caller at about 30 lines.
- Limits: a regeneration started on a thread that is not in the shell snapshot (archived, an idle subagent, or an older settled thread opened from search or a link) settles with no outcome at once and shows no toast, as today.
- Issue draft: "Title regeneration outcome for threads outside the shell snapshot". Body: the waiter in packages/client-runtime/src/state/threadTitleRegeneration.ts reads only the shell snapshot, and on the main stream archivedThreads is empty, idle subagents are left out and older settled threads are cut (ShellStream.ts:73, :82-101, :537, :564). The chat header offers Regenerate on archived threads (threadActionMenu.logic.ts:249-257). Proposal: when the thread is not in the snapshot, settle from the open thread's own subscription (AppThread.lastTitleRegeneration), which means passing that state into createThreadEnvironmentAtoms. Acceptance: a case for an archived thread showing the failed and kept outcomes.

Ruling 12 (d): LIMITS. A stream chunk this client can never decode resubscribes on the same session with backoff to 30 s, indefinitely. The view keeps the last good state (threads show "Could not synchronize the thread."), each retry costs one fresh subscribe (for the shell, one snapshot), and nothing tells the person to update the app.
- Issue draft: "Tell the person to update the app after repeated decode defects". Body: rpc/client.ts's same-session retry (row 3) treats a SchemaError die as recoverable forever. Proposal: after K consecutive decode defects with no good chunk between them on one subscription, stop resubscribing and surface "This environment sends data this app cannot read. Update the app.", with a way to retry. Acceptance: a TestClock case that K defects stop the retries and show the message, and that a good chunk in between resets the count.

Ruling 7 (conn P3-6), record corrections:
1. ebbba8c7f0 (move-out claim 3) also added `export` to IDLE_SERVER_UPDATE_STATE in client-runtime state/server.ts. That makes an import cycle: serverUpdate.ts:21 imports it from server.ts, while server.ts does `export * from "./serverUpdate.ts"`. It is harmless because the value is read only inside a function, never at module load. The export stays, as ruled. The build log's line "The only changed text is the export keyword on SERVER_UPDATE_RESUME_TIMEOUT" was wrong: it is the export keyword on SERVER_UPDATE_RESUME_TIMEOUT in the moved block plus `export` on IDLE_SERVER_UPDATE_STATE in server.ts.
2. Answer I.4 (b) said the person can type the message again and both would land. On web that was wrong: while a send waits, `sendInFlightRef` stays set (useComposerSend.ts:1524), so every further Send in that thread shows "Still sending your previous message." (chatViewSend.ts:370-378). Since ruling 1 the wait ends: a same-session resend after 5 s, and give-up with the draft restored after 10 minutes.
3. Answer I.4 (c)'s "at most 6 warnings per durable subscription in the first minute" is really about one. The supervisor clears the dead session right after the disconnect broadcast, before the first 1 s retry, and switchMap ends the retry.

Ruling 2's plan correction: the K7 plan's row 2 negative "stale rows are never resumed past a half-applied batch (tested)" was not true at 9fb762a2b5 (there was no such test, and the code resumed past it). It is true from 8a982a107a on, pinned by threads-sync.applyDefect.test.ts. The comment "follow again for a fresh snapshot" in threadSubscriptionRecovery.ts is now true.

Ruling 11 (wire P3-4): no change; upstream's "Title kept" text stays. Ruling 12 (k): the encode-skip guard is not taken. Ruling 12 (i): no new entry point (no mobile thread header item, no palette entry).

Commits (each checked by the commands named in its message):
- 0ccca69102, ruling 1, conn P2-1. dispatch.ts: SAME_SESSION_RESEND_GRACE = 5 s and LOST_MESSAGE_WAIT_BOUND = 10 min.
  - Why 5 s: the real supervisor clears a dead session as soon as the socket's failure reaches pending requests (RpcClient fails pending requests, then session.closed -> clearLease, supervisor.ts:1163, :402-405; the conn report 1(b) traces it), so a session still current and connected after 5 s is a live one whose reply was lost. A longer grace only delays the resend; a shorter one gains nothing measurable.
  - Cases: dispatch.socketLoss.test.ts, 3 new on TestClock. The same-session and bound cases failed first; the cleared-session case is a guard that passes on the base by design.
  - The web restore path shows error.message (useComposerSend.ts:1490-1495), so the person reads "… did not confirm the message within 10 minutes. It may not have been sent." with the draft back.
  - Fork delta message-resend-bound.
- 8a982a107a, ruling 2, conn P2-2. threadSubscriptionRecovery.ts takeFreshSnapshot; threads.ts one line (1079 = its entry). threads-sync.applyDefect.test.ts is the probe as a case: it failed first with "expected 8 to be undefined". Fork delta thread-apply-defect-resume.
- 81b7224a06, ruling 3, wire P2-1. GENERATION_FAILED_MESSAGE; the case asserts no CLI text in the stored projection (failed first). Fork delta title-regeneration-failure-text.
- b41d992232, ruling 4, P3-1: the onDefect case; M6 fails it (8 subscriptions instead of 1).
- d4becc6ae2, ruling 4, P3-2: the backoff reset after applied items; M8 fails it (10 instead of 11).
- ba8dad167f, ruling 4, P3-5: dispatch.realSupervisor.test.ts on EnvironmentSupervisor.make. The supervisorTestSupport harness is unchanged (no rule 3 line); the case provides its own ConnectionDriver over it. Mutation: a give-up on "backoff" fails it.
- 3c5b6775d6, ruling 5, P3-3: the reset after 60 s up, measured on the Effect Clock (TestClock in tests, no wall-clock read). The case failed first (6 instead of 7).
- b43f456995, ruling 6, P3-4: currentSession() plus requestInSession pin each attempt. No new case: the race needed a swap between two reads that pinning removes.
- 6a01de8ebd, ruling 8, wire P3-1: ThreadTitleRegenerationCommandOutcome caps the command message at 300; the stored schemas are unchanged. New threadTitle.test.ts (the 301 case failed first).
- 3f390d3028, ruling 10, wire P3-3: the roll-up counts a userOnly card of a non-native subagent without the live-run test. subagentRequest is unchanged for its other readers. The threadShell.test.ts case failed first.

Rule 3: no existing dev test expectation or setup changed. Cases were added to threadShell.test.ts (dev file, new case only). The other test edits are in files this lane created: dispatch.socketLoss, client.streamRecovery, threads-sync.defect (the lane's own "backs off repeated defects" case extended and retitled), ThreadTitleRegenerationService.test.ts's lane-added outcome case (its expectation changed with ruling 3), plus the new files threads-sync.applyDefect, dispatch.realSupervisor and threadTitle.test.ts.
Budgets (ruling 13): no entry raised. Touched files with an entry: client-runtime state/threads.ts 1079 and contracts orchestrationV2.ts 4421, both equal to their entries; the gate's code-budget lint checks every file.

## Coordinator, 2026-11-18 00:35:17 UTC, standing rule 3 extension (beside IV), verbatim

"Standing rule from now, so this needs no round trip again: a type-only import added to an existing test file, and a layer provided to an existing case because the code under test gained a dependency, need no word from me when the commit changes no title, body, setup value or expectation of that case; the lane quotes the before and after in its record and the fresh review lists them. A provide that replaces or fakes a service the case's assertions read still comes to me."

K7: the fix round used neither (no type-only import or provide was added to an existing dev test case).

## Coordinator, 2026-11-18 00:45:31 UTC, READY rule, verbatim

"From now on for every lane: READY means the gate exited 0 on the pushed head, or the report names each failure with the same failure shown at the integration head."

## Fix round gate

- Gate: `vp run check:changed origin/chase/t3-261114-next3` (integration head 259883c788, unchanged), run on 3f390d30282777a5880ba861f7031c1ae98e8e35. That is the head pushed; no commit landed during the run, and the tree was clean. Exit 0: format, lint, knip 1/2 and 2/2, graphql, agent surface audit, agent context budget and typecheck (42 packages) pass; test (481 files) pass, 9656 tests.
- Whole changed test files, each run alone, with the result in its commit: dispatch.socketLoss 10, dispatch.realSupervisor 1, client.streamRecovery 8, threads-sync.applyDefect 1, threads-sync.defect 3, threads-sync and threads-atoms (with the defect files, 60), ThreadTitleRegenerationService 10, threadTitle 2, threadShell 16.
- Subsystem runs for ruling 10 (it changes who shows "Input needed"): web ThreadNotificationCoordinator logic and badge, 49.
- Head on origin: chase/t3-261114-next3-k7-client-protocol = 3f390d3028, a plain push from 9fb762a2b5 with ten commits. No integration merge yet, as ruled.


## Lane coordinator, about 02:00 UTC: no git stash (rule noted)

K7 used git stash once, before this rule: "k7-row8-wip" on chase/t3-261114-next3-k7-client-protocol, while dropping the unused claim 8 move-out commit. It was popped at once ("Dropped refs/stash@{0}"). `git stash list` on pen-macbookpro2 is now empty (0 entries), so no entry of mine or anyone else's remains. The fail-first runs since then saved diffs to /tmp patch files or file copies and re-applied them; from now on, only that or a scratch branch.


## Coordinator, 2026-11-18 01:14:39 UTC, III (K7 line) and IV, verbatim

III. K7 at 3f390d30282777a5880ba861f7031c1ae98e8e35: READY accepted (gate exit 0 on the pushed head). quick 44213593271 dispatched. Brief next3-K7-fix-3f390d30.md; its first item is whether a resent message can be applied twice by the server. The second integration merge still waits for K10.

IV. STANDING RULE, every lane, from now: before READY, every apps/server test file the lane added or changed is run once from apps/server with GOAT_TEST_TMP_GUARD=fail (CI sets it, check:changed does not), and the READY report says so. The ps check in its own step first, as before.

## K7 under IV (on the pushed head 3f390d3028, run after its READY; the head is unchanged)

ps check first, in its own step: no vitest, tsc, check-changed or build process running; load 2.79. Then, from apps/server: `GOAT_TEST_TMP_GUARD=fail vp test run` on every apps/server test file the lane added or changed (`git diff --name-only --diff-filter=AM c995c5427a...HEAD`): orchestration-v2/Orchestrator.messageReceiptReplay.test.ts, ProjectionPendingRequest.test.ts, ShellStream.test.ts, ThreadTitleRegenerationService.test.ts, relay/AgentAwarenessRelay.userWait.test.ts and terminal/Manager.retainedHistory.test.ts. Exit 0: 6 files, 48 tests passed. The next READY (after the second integration merge) runs it again.


## Time correction (lane coordinator, 01:17 UTC)

The section "Lane coordinator, about 02:00 UTC: no git stash" keeps its content. Its real send time, from the thread log, was between about 00:55 and 01:16 UTC; the coordinator wrote "about 02:00" without reading a clock.


## Coordinator, 2026-11-18 01:17:54 UTC, II and V, verbatim

II. RULE 3, standing rule extended (beside the 00:35:17 rule), every lane: a VALUE import added to an existing import line of an existing test file needs no word from me when only appended cases or appended helpers use the new names and no existing title, body, setup value or expectation changes. The lane quotes the line before and after in its record; the fresh review lists it. An import that changes what an existing case runs against (a different module, a fake in place of a real service) still comes to me.
CONFIRMED under it, READ BY ME (git diff against 259883c788): K4's two lines in ThreadSettlementService.cache-test-cases.ts at 197f92c954 ({ expect, it } gains assert; { DEFAULT_SERVER_SETTINGS } gains ThreadId; 104 lines added, 2 removed, the new names used from line 277 on) and K10's one line in threadLineageLookup.test.ts at c31dfe1c41 (the import gains THREAD_LINK_LOOKUP_CACHE; 178 added, 1 removed).

V. The stash incident: closed, noted. "No git stash in any lane" stands as a rule; a lane that needs to set work aside commits it on its own branch locally.

## K7's import lines in existing dev test files (git diff 259883c788...3f390d3028), quoted under II

Already under IV or the move rulings, so not repeated here: runtime.test.ts (mirrored), terminalSession.test.ts (mirrored), threadCommands.test.ts (mirrored), mobile useThreadListActions.test.ts (mirrored), managedRelayState.test.ts (row 5, `import * as TestClock`, in upstream 7c22095fcc's own hunk), and server.test.ts (row 4's move, the four removed names listed then). orchestratorMcp.test.ts has no import change; its hit is a line inside the new decode case.

1. apps/server/src/orchestration-v2/ThreadTitleRegenerationService.test.ts (row 8, 877920d3c3). Used only by the appended cases from line 562 on; no existing title, body, setup value or expectation changed.
   - Under II, a name added to an existing import line. Before:
     `  RunId,` / `  ThreadId,` / `} from "@goat/contracts";`
     After:
     `  RunId,` / `  TextGenerationError,` / `  ThreadId,` / `} from "@goat/contracts";`
   - Two NEW import statements (not names added to an existing line):
     `import * as Fiber from "effect/Fiber";` (after `import * as Effect from "effect/Effect";`)
     `import * as TestClock from "effect/testing/TestClock";` (after `import * as Option from "effect/Option";`)
2. packages/client-runtime/src/state/assets.test.ts (row 6, 14c30eb96f). One NEW import statement, used only by the appended cases from line 184 on:
   `import { resolveMediaSource } from "../mediaSource.ts";` (after `import * as EnvironmentSupervisor from "../connection/supervisor.ts";`)

The three new import statements import real modules and replace no service any existing case reads. They are analogous to II but are not "added to an existing import line", so they go to the coordinator to confirm (needs_input of 01:2x UTC).


## Coordinator, 2026-11-18 01:20:03 UTC, rule 3 (new import statements under II), verbatim

RULE 3, the 01:17 rule II covers a NEW import statement on the same terms as a name added to an existing line: only appended cases or appended helpers use what it imports, it imports a real module (no fake, no mock, no replacement of something an existing case reads), the import has no effect at load time that an existing case could see (no vi.mock beside it, no module that registers or patches something when loaded), and no existing title, body, setup value or expectation changes. The lane quotes the added statements in its record; the fresh review lists them. Whether the name sits on an existing line or a new one makes no difference, so K5 does NOT move its import.
CONFIRMED under it, on your account and the lanes' records (NOT READ by me; the two running fix-delta reviews check their own delta's test files against 259883c788, and I will read these lines when I make each merge): K7's Fiber and TestClock statements and the TextGenerationError name in ThreadTitleRegenerationService.test.ts, and resolveMediaSource in assets.test.ts; K5's claudeProcessExitFailure in ClaudeAgentSdkQueryRunner.test.ts. Both heads stay put.
One point for K7's record: effect/testing/TestClock in a file whose existing cases run on it.effect changes nothing for them; if any existing case in ThreadTitleRegenerationService.test.ts is it.live, say so in the same section.

K7's answer (read at 3f390d3028): ThreadTitleRegenerationService.test.ts has no it.live case (`rg -c 'it\.live'` finds none). Its existing cases are all it.effect, except one plain synchronous `it(` ("pins the first user message ahead of the retained tail once content stops …"), which uses no clock. Only the appended deadline case reads TestClock. Neither file has a vi.mock (`rg 'vi\.mock'` finds none in ThreadTitleRegenerationService.test.ts or assets.test.ts). effect/Fiber, effect/testing/TestClock and ../mediaSource.ts register or patch nothing when loaded.


## Coordinator, 2026-11-18 02:06 UTC, II (K7 line) and III, verbatim

II. K7: the second integration merge now takes f82d2df4b0 (K10, K5 and M3 in). My merge-tree of f82d2df4b0 and 3f390d3028 conflicts in devlog/_chase/010_fork_delta.md and oxlint-plugin-goat/code-budgets.json only. vp i after the merge. Still local, NO PUSH until its fix-delta review reports.

III. A trap for every lane's shell, found by me twice today: in zsh, "$C:refs/heads/x" applies the :r modifier to $C and mangles the ref. Write "${C}:refs/heads/x" in every push and every REV:path.

(K7 hit the same trap once, on the records push of 22:5x; every push since writes "${c}:refs/...".)

## Second integration merge, PREPARED locally (not pushed)

The merge was prepared three times as the integration head moved, each time on the local branch k7-merge2-prep cut from 3f390d3028. The lane branch stays 3f390d3028, locally and on origin.
- First on c31dfe1c41 (01:4x UTC), then on ac238fcce3 (01:5x), whose gates were stopped by their own sessions (exit 130) when the head moved, and no process was left behind.
- Final on f82d2df4b0 (02:0x): merge commit 3a2cae9983ee159e0dd3ec6bc5d546c7f9c08e06, parents 3f390d3028 and f82d2df4b0. git reported "CONFLICT (content): Merge conflict in devlog/_chase/010_fork_delta.md" and "CONFLICT (content): Merge conflict in oxlint-plugin-goat/code-budgets.json". git's rerere replayed the first resolution, which was then checked:
  - 010_fork_delta.md keeps both sides. K10's thread-link-lookup sits between K7's thread-apply-defect-resume and title-regeneration-failure-text, in slug order. Check: the sorted set of "### " headings of both parents equals the merged file's (diff empty, 50 sections).
  - code-budgets.json: every entry that differs between the two parents (22) equals countLines (wc -l) of the merged file, with 0 mismatches. The conflicted three are counted on this merge: apps/web/src/components/ChatMarkdown.tsx 1658, packages/contracts/src/orchestrationV2.ts 4382, packages/contracts/src/orchestratorMcp.ts 1073. The rest take the side that changed them, for example Manager.ts 3103, Sidebar.tsx 3321, state/server.ts 1564 and threads.ts 1079.
- vp i after the merge (pnpm-lock.yaml changed with M3): exit 0, and the tree stayed clean.
- ps check in its own step (idle), then the gate on 3a2cae9983: `vp run check:changed origin/chase/t3-261114-next3` (f82d2df4b0), exit 0. format, lint, knip 1/2 and 2/2, graphql, agent surface audit, agent context budget and typecheck (42 packages) pass; test (484 files) pass, 9696 tests.
- Rule IV on 3a2cae9983, from apps/server with GOAT_TEST_TMP_GUARD=fail, on the six server test files the lane added or changed: exit 0, 6 files, 48 tests.
- When the fix-delta review reports with no change asked, the lane branch fast-forwards to 3a2cae9983 and is pushed (plain push), unless the integration head has moved again, in which case the merge is redone. If the review asks for changes, they go on 3f390d3028 and the merge is redone after them.



## 2026-11-18 09:29:40 UTC — K7 READY on the second integration merge

- Lane `chase/t3-261114-next3-k7-client-protocol` pushed by plain fast-forward and verified on origin at `5205cbb69eca3a1b34f46bf545e28d100325ca6d`. Parents are `3f390d30282777a5880ba861f7031c1ae98e8e35` and integration `2c0e0002a996ec5d46c708919be5a43f579176fa`. Integration advanced during the first rerun on `3a2cae9983` (stopped through its own session, exit 130). Rebuilt from the published lane tip with `git merge origin/chase/t3-261114-next3`. Resolved `010_fork_delta.md` and `code-budgets.json` by matching the clean tree from merging the previous candidate with the new integration tip. All 50 fork-delta headings and all 21 affected line caps verified. `vp i` exited 0 on Node 26.12.1 after the lockfile change.
- `vp run check:changed origin/chase/t3-261114-next3` exited 0 on the pushed head. 484 files and 9,698 tests passed. Format, lint, both Knip passes, GraphQL, agent-surface audit, context budget and 42-package typecheck passed. The gate skipped its unused-patch check because the lane diff on integration has no dependency-file changes.
- Whole-file `vp test run <files>` runs, with a separate worktree process check before each, all exited 0 with zero failures or skips. From `apps/server`, `GOAT_TEST_TMP_GUARD=fail vp test run <six changed files>` passed 48 tests. The other 25 changed files passed 384 tests. The related notification, thread recovery, Sidebar and lifecycle files passed 214 tests across 21 files. File counts follow below (suffixes omitted).
- Review the ten GOAT-authored fixes and tests in `9fb762a2b5f969b2948b3edb22bf12b42a07d3e2..3f390d30282777a5880ba861f7031c1ae98e8e35` and the conflict resolutions via `git show --remerge-diff 5205cbb69eca3a1b34f46bf545e28d100325ca6d`. Rows 1–9 and their supporting moves are in the already reviewed history through `9fb762a2b5`. The two older review reports are under `K7-review/`.
- P1 rows owed: (6) remote relative Markdown image renders from the thread host and shows a missing image if that host lacks the file, even with a same-path local file; (7) a delegated child's pending secret or handoff marks the parent Input needed in web/desktop, updates mobile and phone push, and clears when answered or cancelled; (8) title regeneration shows the expected web single and bulk toasts and the mobile failure alert. K7b owns the shell and provider-refresh follow-ups, including `omitProviders` as R6.
- NOT RUN: fix-delta review, lane GitHub CI, repo-wide suites, full builds/release smoke, integrated P1 and native-client pass, older GOAT binaries, live GOAT Connect relay, and slow-link terminal attach measurement.

Focused file counts:

- `goat` with tmp guard: Orchestrator.messageReceiptReplay 2, ProjectionPendingRequest 2, ShellStream 27, ThreadTitleRegenerationService 10, AgentAwarenessRelay.userWait 4, Manager.retainedHistory 3.
- `@goat/mobile`: useThreadListActions 50, markdownMedia 88. `@goat/web` changed files: useComposerSend.resend.browser 2, threadTitleRegenerationToast 3.
- `@goat/client-runtime` changed files: supervisor.silentRoute 1, markdownImages 12, mediaSource 17, dispatch.realSupervisor 1, dispatch.socketLoss 10, managedRelayState 8, client.streamRecovery 8, assets 28, runtime.executeAtomQuery 2, runtime.streamRecovery 1, runtime 29, server 26, server.updateResume 12, terminalSession 12, threadCommands 27, threadShell 16, threads-sync.applyDefect 1, threads-sync.defect 3.
- `@goat/contracts`: assets.hostOnly 3, orchestratorMcp 22, threadTitle 2.
- Related: ProjectionStore.notifications 6, AgentAwarenessRelay 23, .startup 1, .subagent 4, HeldHooksWaker 1, SubagentWaits 2, agentAwareness 29, threads-atoms 4, threads-sync 52, ThreadNotificationCoordinator.badge.browser 23 and .logic 26, useThreadLifecycle.browser 9, useThreadActionMenu 7, Sidebar browser suites (base 4, drag 1, logic 5, pointer 3, renderIsolation 1, shiftGuard 11, shortcuts 1, shortcuts.noBrowser 1).


## 2026-11-18 11:13:19 UTC — K7 follow-up review fixes, READY

K7 pushed `a8751d4e4560ff108f09b8c5fba5b853b0d2d340` to `chase/t3-261114-next3-k7-client-protocol` by plain fast-forward from `5205cbb69eca3a1b34f46bf545e28d100325ca6d` and verified the remote SHA. This round contains four GOAT commits and zero merges. Origin integration reached `6def29ca359f546e50dcd731a6364e3f0d575545` during the round. The merge base used by the gate was `2c0e0002a996ec5d46c708919be5a43f579176fa`.

| Finding | GOAT commit | Failing-first evidence |
| --- | --- | --- |
| P2-1 | `60c6fde0e7d0e2899bf70f44e701a1ed017bc0f7` | `threads-sync.applyDefect.test.ts` exited 1 after the second recovery request sent `afterSequence: 8` before a snapshot. It now requests a snapshot again and resumes at 8 after installing it. |
| P2-2 | `a03ef2499be3fa516d593cd43fbaf22ff21dcc9f` | Both new `threadShell.test.ts` cases failed first: the parent reported `user_input` for each approval handoff, and the completed child was missing from detail. Both now show approval in the roll-up and the two detail banner labels, and clear after resolution. The relay already classifies these cards as approval. |
| P3-1 | `2823e0e01a91e333d689dd5cacc83f9f498f16f5` | The new TestClock case in `dispatch.socketLoss.test.ts` failed first because the resend was still running at ten minutes. It now ends at the deadline with the existing ambiguous-delivery error. |
| P3-2 | `a8751d4e4560ff108f09b8c5fba5b853b0d2d340` | `threadTitle.test.ts` exited 1 because the public decoder retained caller-supplied failure text. The final contract cases verify that the legacy payload decodes, extra outcome text is discarded, the internal tag is rejected on the public route, and a stored 400-character outcome remains readable. |

The title completion's public fields match `877920d3c3^` by direct comparison. The internal tag stays on the server command path. Older peers use the same wire shape in both directions. The existing metadata event carries server-generated outcomes, and the guarded title-service, launch and effect-worker tests cover the internal producer and the legacy completion path. No existing dev test title, body, setup or expectation was edited. P2-1 extends K7's earlier regression and P3-2 replaces K7's earlier 300-character public-field case with the restored boundary. Neither change introduces test imports in existing dev files. Code budgets stayed fixed.

### Verification on Node 26.12.1

- `vp run check:changed origin/chase/t3-261114-next3` exited 0 on the clean pushed head. Format, lint, both Knip passes, GraphQL, agent-surface audit, agent context budget and typecheck (42 packages) passed. Vitest passed 484 files and 9,702 tests. The gate skipped its unused-patch check because no dependency files changed.
- From `apps/server`, `GOAT_TEST_TMP_GUARD=fail vp test run` passed the six changed server files plus `ThreadLaunchService.test.ts` and `EffectWorker.test.ts`. Exit 0, eight files, 138 tests. The changed non-server whole-file run exited 0, 25 files, 388 tests. No test skips or failures in either run. Process checks preceded the runs, with one gate at a time in K7's worktree.
- Earlier receipts: the first gate reported TS2345 on the new resend fixture and was stopped through its own terminal session (exit 130). The resend commit now pins the fixture's phase literal. The next gate exited 1 with 483/484 files and 9,701/9,702 tests passing. Its sole failure was the existing effect-worker assertion for an initial title generation completion. The title commit now uses the legacy completion for initial generation and the internal outcome command for explicit regeneration. The guarded effect-worker suite and the final changed-files gate both passed.

NOT RUN: hosted CI, fresh independent review of this delta, repo-wide suites, full builds and release smoke, integrated web/desktop/mobile UI and older-binary passes, live GOAT Connect relay, and the slow-link terminal attach measurement.


## 2026-11-18 11:44:27 UTC — K7 review nits, READY

K7 fast-forward pushed `chase/t3-261114-next3-k7-client-protocol` at `a06cde6d78c7c1efeddf464e34b2352bb86903ab`, two commits directly after `a8751d4e4560ff108f09b8c5fba5b853b0d2d340`. No integration merge was made in the lane.

- P3-1 (`f50c4d9d78685a9ecdac901c8941f5ffe50cb11d`). Both resend deadline calculations in `dispatch.ts` use `Clock.monotonicTimeNanos`. The extended TestClock case rewinds wall time just before reconnect. It exited 1 on the base because the resend stayed pending at ten minutes. The whole `vp test run packages/client-runtime/src/operations/dispatch.socketLoss.test.ts` passed afterward (exit 0, one file, 11 tests).
- P3-2 (`a06cde6d78c7c1efeddf464e34b2352bb86903ab`). The `orchestrationV2.ts` cap dropped from 4,382 to 4,381, verified against `countLines`.
- `vp run check:changed origin/chase/t3-261114-next3` exited 0 on Node 26.12.1. Integration ref `6def29ca359f546e50dcd731a6364e3f0d575545`, merge base `2c0e0002a996ec5d46c708919be5a43f579176fa`. Rename, format, lint, both Knip passes, GraphQL, agent-surface audit, agent context budget, typecheck (42 packages), and Vitest (484 files, 9,702 tests, zero failures or skips) passed. The gate skipped the unused-patch check because no dependency files changed.

NOT RUN: hosted CI, independent review of the nits, repo-wide suites, full builds and release smoke, real-client and older-binary runs.
