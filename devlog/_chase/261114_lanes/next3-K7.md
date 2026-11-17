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

