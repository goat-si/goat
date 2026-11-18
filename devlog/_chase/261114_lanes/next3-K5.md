# next3 K5 Claude adapter (lane record)

Lane branch: chase/t3-261114-next3-k5-claude-adapter, cut from origin/chase/t3-261114-next3 at a608046c519b9377be3f03a5cdd6b376dd1b5c3f (git rev-parse HEAD on the lane worktree). Thread host: cpa-macbookair (= pen-macbookair, one machine). Rows: aab388ddb1, d6e5f2e06f, 86e2cb21c9, fdd54b942d, e4025c8528 (PID reuse tested); 5984bbb36e as one decision. Class: C4 lane. State: PLAN ONLY, no code commit, nothing pushed to a code branch.

## Coordinator rulings for this lane

> Coordinator to lane coordinator (2026-11-17 21:16:52 UTC), ITEM 5, RULED (relayed verbatim):
> Consistent with what I read in host.status (cpa-macbookair and pen-macbookair report 10 cores and the same sample time; macbookpro2 and pen-macbookpro2 likewise), so I take them as one machine each. The standing rule applies as on any machine: at most two threads, one heavy job at a time.
> - On the Air, K2 codes first (K8 needs that Mac for the desktop shell and stays behind K2).
> - K5 takes the next free code slot after K2's. If a Mac other than the Air is free at that moment (pen-macmini while K4 has not started coding, pen-macbookpro2 after K7, pen-mac-studio after K10), relaunch K5 there from its plan and branch and tell me the host. If none is free, K5 codes on the Air beside K2 under the machine's heavy-job token: installs, check:changed and test runs never overlap, and a lane that waits for the token says so in its report.
> - N10 follows on whichever machine K5 used. Until its slot K5 writes only its plan.
> - Count the Air and the MacBook Pro once each in any later placement you send me.
>
> For K5: nothing changes in your plan phase. Quote this in next3-K5.md. Push your branch's commits only after your code slot is given; if I relaunch you on another Mac, that thread starts from your plan and your pushed branch, so keep the plan complete in the record.

Earlier ruling that binds d6e5f2e06f (cycle 261114, L01 retry, devlog/_chase/261114_lanes/L01-retry.md:72-76 on origin/dev): "Ruling (coordinator): option C, no new persisted outbox effect type; the port lands in a later round." This plan follows it (row 4).

## Ancestry check (#3519 = 3ecea04f19, #3660 = 42bf8633ce on origin/dev)

Commands: `git log origin/dev --grep=<sha>`; `git log -1 --format=%B 42bf8633ce` and `3ecea04f19` grepped for each sha; rg on the base for each row's distinctive symbols.

| row | on dev? | evidence |
| --- | --- | --- |
| aab388ddb1 send_to_user | no | no `send_to_user`, `sentMessage` or `SEND_TO_USER` in apps/ or packages/ (rg); neither PR body names it. |
| d6e5f2e06f live effort | no | no `applyModelSelection` in apps/server/src/orchestration-v2/*.ts or in ProviderAdapterV2SessionRuntime (packages/provider-core/src/server/ProviderAdapter.ts); the live apply exists only inside openQuery (ClaudeAdapterV2.ts:9240-9266). Deferred in #3397/#3173 under ruling C (L01-retry.md:64, :72). |
| 86e2cb21c9 boot timeout | no | no `CLAUDE_BOOT_TIMEOUT` or `initializationResult` in apps/server/src (rg 0); ClaudeAgentSdkQueryRunner.ts:151-158 has the phase-less ClaudeMcpRegistrationTimeoutError. |
| fdd54b942d stray jobs | no | no `lstart`, `trackDescendants` or `claudeDescendants` in the Claude runner; ClaudeAgentSdkQueryRunner.ts:595 spawns the group with no tracker. |
| e4025c8528 survivors | no | apps/server/src/process/providerProcesses.ts absent; agentScope.ts:162-169 stops leftovers lazily inside the cached systemd probe; ClaudeProcessSpawn.ts:8-13 has no fd-4 gate. |
| 5984bbb36e steer selection | half | the orchestrator and outbox half is on dev since #3397 (02511156b0): the steer effect has `modelSelection: Schema.optional(ModelSelection)` (EffectOutboxRequest.ts:53), Orchestrator.ts:4603 sets it when `steerCarriesSelection`, runtimeLayer.test.ts:1099 expects it. Missing: ProviderTurnControlService passing it to the adapter, `ProviderAdapterV2SteerInput.modelSelection`, and the Claude adapter applying it live. |

Nothing is ticked as covered; 5984bbb36e shrinks to its adapter half.

## Budget facts on the base

wc -l equals the code-budgets.json entry for: ClaudeAdapterV2.ts 10933, ClaudeAdapterV2.test.ts 16500, Orchestrator.ts 13528, ProjectionStore.ts 8823, McpHttpServer.ts 1125, MessagesTimeline.logic.ts 2504, MessagesTimeline.tsx 1596, session-logic.ts 1038, mobile threadActivity.ts 2171, ThreadFeed.tsx 3344. No entry, under the 1000 cap: ClaudeAgentSdkQueryRunner.ts 996, EffectWorker.ts 998, ClaudeAgentSdkQueryRunner.test.ts 685, ClaudeAutomaticDelivery.integration.test.ts 783, ClaudeProcessSpawn.ts 76, agentScope.ts 437, agentScope.test.ts 442. Each is re-measured with countLines before its commit; no entry is raised.

## Rows

### 1. 86e2cb21c9 Claude boot gets its own 5 minute deadline (C4: error text, CLI wire)

What changes: before `setMcpServers` the runner awaits the SDK's `queryRuntime.initializationResult()` (the CLI's answer to the SDK's initialize control request) with a 5 minute deadline; `ClaudeMcpRegistrationTimeoutError` gains `phase: "initialize" | "setMcpServers"`, and the initialize phase reads "Claude timed out while starting up. Retry the turn; if it keeps failing, check Claude and the server logs." Today boot is unbounded and the 90 s registration deadline covers boot plus registration, so a slow boot on a loaded host fails as "timed out while registering its MCP tools".
Files: ClaudeAgentSdkQueryRunner.ts (GOAT's runner lives here; upstream's is in ClaudeAdapterV2.ts), ClaudeAgentSdkQueryRunner.test.ts.
Wire with the CLI: no new message; the SDK already sends initialize, we only await its answer. SDK 0.3.321 has `Query.initializationResult(): Promise<SDKControlInitializeResponse>` (sdk.d.ts:3095). Stored state: none (the failure text is stored as any provider failure message is today).
Older CLI (negative case): a CLI that never answers initialize now fails after 5 minutes with the start-up message. A CLI that exits during boot rejects initializationResult; upstream swallows that (`.catch(() => undefined)`) and setMcpServers then fails, so the exit is reported by the process-exit path as today. GOAT test (new): "a CLI that exits during boot reports its exit, not a start-up timeout".
Retry: the runner retries a resumed open once when the cause is the timeout error (ClaudeAgentSdkQueryRunner.ts:874-880); with the phase this retry also covers a boot timeout. Kept as upstream; see Risks.
Tests (fail first): upstream's "opens after a slow CLI boot" (TestClock 120 s; fails today because the 90 s registration timer fires first) and "times out a CLI that never boots" (5 min, the message above; fails today: no such message), plus the GOAT exit-during-boot case.
Rule 3 (R1, asked before the commit): the six existing SDK mocks in ClaudeAgentSdkQueryRunner.test.ts (objects at :254, :328, :378, :417, :452, :482) gain one line each, `initializationResult: async () => ({}),`, as upstream adds to its five. No expectation changes; without it those fakes lack the method and the await throws.
Budget: the runner gains ~25 lines on 996. Move-out first (M1): `ClaudeCodeRootRefusalError`, `ClaudeMcpRegistrationTimeoutError`, `ClaudeBackgroundWorkBlocksQueryReplacementError` and their constants (ClaudeAgentSdkQueryRunner.ts:51-53, :142-167) verbatim to a new GOAT-owned `ClaudeQueryRunnerErrors.ts`, re-exported for existing consumers (rg first). Rows 1-3 add ~45 runner lines; row 2's bulk goes in its own module.
Surfaces: provider adapter only; web, desktop and mobile show the new text in the turn's failure row as they show any provider failure. No contract, settings or agent surface.
Size: S.

### 2. fdd54b942d stop jobs a Claude CLI moved out of its process group (C4: kills processes)

What changes: when no systemd agent scope holds the CLI (every macOS host, Linux without user systemd: `unit === undefined`, ClaudeAgentSdkQueryRunner.ts:580-582), the runner records the CLI's process tree every second with `ps -A -o pid=,ppid=,pgid=,lstart=`, refreshes once more before `close`, and after the CLI exits SIGKILLs every recorded descendant that is still the same process (pid AND start time), its whole group when it leads one. Today a job that called setsid/setpgrp escapes the group kill (ClaudeProcessSpawn.ts:48-52) and lives on under launchd.
Files: a new GOAT-owned `ClaudeDescendants.ts` (table parser, tree walk, tracker; upstream's code with names adapted), ClaudeAgentSdkQueryRunner.ts (~15 lines: tracker start in the spawn callback, refresh before close), ClaudeProcessSpawn.ts (the return type keeps `pid`), ClaudeAgentSdkQueryRunner.test.ts.
Wire and storage: none. One in-memory map per CLI, gone with it, bounded by that CLI's descendants.
What a person sees: a server or watcher an agent detached with setsid in a Claude session on a Mac stops when the session closes or the CLI exits, as it already does on Linux under systemd. No client change.
Negative cases (tests): a pid reused after the CLI exited is never signalled (unit test of the tracker over a fake table where the pid returns with another start time); the CLI's own pid is never a root after exit (same unit test); `ps` failing or exiting non-zero gives an empty table and kills nothing (unit); the agent-scope path starts no tracker (unit through the spawn callback, or path:line).
Tests (fail first): upstream's two real-process cases (skipIf win32; perl setpgrp and a fifo; it.effect for close, it.live for the CLI exiting on its own). Both fail today: the leftover keeps the fifo open.
Cost: one `ps -A` per live Claude session per second where no systemd scope exists. Measured here: 473 processes, `/usr/bin/time -p ps -A -o pid=,ppid=,pgid=,lstart=` real 0.00 user 0.00 sys 0.00, four runs.
Size: S-M.

### 3. e4025c8528 a restarted Linux server reaps the Claude CLIs its dead predecessor left (C4: kills PIDs recorded in a file; stored state)

What changes (Linux only; other platforms get `{ hasOtherLiveOwner: false }` and no register):
- New `apps/server/src/process/providerProcesses.ts` (service `goat/process/ProviderProcesses`). At layer build it writes an owner record `<stateDir>/provider-processes/<uuid>.json` (`{version: 1, instanceId, hostname, stateDir, owner: {pid, startTime}, processes: []}`, startTime = boot_id plus the /proc start time, written to `.pending` then renamed), then reads every record with this hostname and stateDir: a live owner's record is left alone (and sets `hasOtherLiveOwner` unless it is this server); for a dead owner each recorded process that still matches pid and start time gets SIGKILL, waited up to 100 x 10 ms; the record is removed unless a process survived (then a warning, and the record stays for the next start).
- `register(pid)` writes one record per Claude CLI before the CLI may run: ClaudeProcessSpawn.ts gains a fifth pipe (fd 4) the watch script reads before `exec` (`read -r _ <&4 || exit 1`), so a CLI that runs is always recorded; the record goes on exit.
- agentScope.ts: `stopLeftoverAgents` is skipped when `hasOtherLiveOwner`; the systemd probe, and with it the leftover stop, runs at layer acquisition instead of at the first launch (a startup barrier).
Stored data: a new directory under the server's stateDir. Older server after newer: never reads it; the files stay (one owner record plus one per CLI that was live, a few hundred bytes each) and nothing misreads them. Newer after older: no records, only today's slice stop. Newer after a crashed newer: reaps. Two servers on one stateDir: neither stops the other's slice or processes, where today the second server's first launch stops the shared slice. Dev servers use their worktree's own stateDir and never see the live install's records.
Negative cases (the verdict's PID reuse condition): upstream's Linux test covers a live owner's provider (kept), a provider pid reused by another process (start time differs: kept), a reused owner pid (start time differs: its orphan reaped), an unrecorded process (kept), a dead owner's orphan (reaped). GOAT adds: a partial or undecodable record (`.pending`, bad JSON, unknown version) signals nothing; a record from another hostname or stateDir signals nothing; an unkillable survivor keeps its record and startup completes (needs the controller injectable; otherwise path:line and the record says so); `register` refusing a pid whose parent is not this server kills the child and fails the spawn (unit).
Tests (fail first): providerProcesses.test.ts (new; runIf linux; it.live with real children, signalling only PIDs captured at spawn); ClaudeAgentSdkQueryRunner.test.ts "records the CLI before it runs and forgets it once it exits" (fails today: no gate, so the CLI runs before any record); agentScope.test.ts "leaves the slice to another live server sharing this home" (fails today: a stop is issued).
GOAT check before code: ProviderRuntimeRecoveryService does not depend on AgentScope (rg finds no AgentScope there; server.ts:1295 provides AgentScopeLive.layer). Upstream says the barrier must run before recovery; I confirm GOAT's layer order and either cite the path:line that orders them or add the dependency with a test.
Rule 3 (R2, asked before the commit): agentScope.test.ts `withFakeSystemd` (:54) gains two options (`leftovers`, `liveOwner`) and one provide line; the test at :336 "stops agents a killed server left before the first launch" becomes "stops agents a killed server left before startup completes": the leftover unit is set through the option before `make`, and the one stop is asserted before the first `wrap`. The old expectation was right for the old behaviour; it changes because the stop moves to startup. The slice, TimeoutStopSec, terminal-slice and one-stop assertions stay. The exact before and after go with the request.
Budget: agentScope.ts +~10, agentScope.test.ts +~20, ClaudeProcessSpawn.ts +~20, runner +~3; no entries.
Where proof runs: the reaping test needs Linux (/proc, boot_id); NOT RUN on this Mac; it runs in the coordinator's goat-ci run on the READY head.
Size: M.

### 4. d6e5f2e06f an effort change applies to the running Claude turn (C4; under ruling C)

Upstream: a new persisted outbox effect `provider-session.apply-model-selection` emitted by the Orchestrator on `thread.model-selection.set` during a running turn, run by `ProviderTurnControlService.applyModelSelection` into a new optional `ProviderAdapterV2SessionRuntime.applyModelSelection`; the Claude adapter calls `setModel` (only when the model changed) and `applyFlagSettings` on the live query.
Ruling C forbids the persisted type. Prior art: upstream uses the outbox (durable, process-bound, cancelled on process loss). GOAT already reacts in-process after commit for best-effort work (apps/server/src/handoffs/HandoffWakeReactor.ts consumes `streamDomainEvents`), and its ACP flavors apply a selection only when a session is configured (packages/provider-acp/src/server/adapter.ts:6343). A lost live effort change costs nothing durable: the next turn applies the selection (ClaudeAdapterV2.ts:9240-9266).
GOAT design (proposed, D1): a GOAT-owned `orchestration-v2/goat/LiveModelSelection.ts` reactor consumes `thread.model-selection-updated` domain events one at a time (bounded), reads `getRunningTurnContext(threadId)`, and when a turn is running in that provider session calls the session's `applyModelSelection` (upstream's optional adapter method). Nothing persisted; Orchestrator.ts untouched (pure, at its entry); ProviderTurnControlService's shape unchanged, so EffectWorker.test.ts:107 and ProviderRuntimeRecoveryStreaming.test.ts:133 stay as they are (no rule 3).
Claude adapter: upstream's `applySelectionLive` helper (the openQuery block at ClaudeAdapterV2.ts:9255-9266 moves into it, keeping GOAT's `reportedModel = undefined` line) and `applyModelSelection` with upstream's guards: no live query, stopping, another native thread, same identity, a model change, or a change that needs a new process (`canApplyClaudeSelectionLive`) do nothing; a failure logs a warning and clears the live identity so the next turn applies it.
Older peers: no wire or stored change. An older client already sends `thread.model-selection.set` mid-turn (ActiveTurnRefusals.ts:61 refuses only a change that releases the live session); the change now reaches the running turn. Older server after this one: nothing left behind.
Older Claude CLI (negative case): GOAT already sends `applyFlagSettings` on the turn-start path, so a rejection behaves as there: warning, identity cleared, next turn re-applies; the running turn is not interrupted (test with a query fake whose applyFlagSettings fails and whose interrupt dies).
Other negative cases (tests): a model change waits for the next turn; a change that needs a new process (thinking toggled, effort cleared) waits; no running turn applies nothing; a `thread.model-selection-updated` written from the provider's own report (ProviderEventIngestor.ts:436) is not echoed back; a stopping query applies nothing.
Tests (fail first): upstream's "applies an effort change to the running Claude query without waiting for a turn" (orchestrator, effect worker and reactor; `flagSettings` gets `{ effortLevel: "medium", fastMode: null, ultracode: null }`; fails today with `[]`) in a new `ClaudeLiveEffort.integration.test.ts`, plus the negatives.
Budget: move-out first (M2): `canApplyClaudeSelectionLive` and `claudeLiveSelectionFlagSettings` (ClaudeAdapterV2.ts:524-543) verbatim to a new GOAT-owned `ClaudeLiveSelection.ts`; the helper lives there; the adapter nets about zero.
Surfaces: a person changing effort mid-turn on web, desktop or mobile sees it take effect in the running Claude turn; an agent changing a thread's selection through MCP gets the same (the reactor sits after every entry point). Other providers do not implement the method in this lane: their change waits for the next turn, as today.
Size: M.

### 5. aab388ddb1 Claude can show the user mid-turn text in full (C4: new MCP tool; web, mobile)

Upstream: a `send_to_user` MCP tool (handler echoes `{sentMessage, message: "Shown to the user. Don't repeat it."}`; read-only; `anthropic/alwaysLoad`), a Claude system-prompt section telling Claude to use it, a projection predicate that keeps its items inline, `sentMessageFromToolItem` in shared toolOutput, web and mobile rows that render the message as the agent's own words, a "Sent a message" summary, context-budget bumps and an eval file. Reason: Claude 5.1+ returns text written before a tool call only as a summary.
GOAT shape (needs D3): a registry entry in packages/contracts/src/agentSurface/entries (path `message.send`, MCP name `goat_message_send` by the naming rule), a toolkit in apps/server/src/mcp/toolkits/message, `claudeGoatToolDecision` (goatMcpToolNames.ts:130) allowing it without a prompt in Plan mode and read-only sandboxes, the instruction in GOAT's Claude system append, `sentMessageFromToolItem` resolving direct and `goat_call` calls through `resolveGoatMcpItemCall` (toolOutput.ts:292), the ProjectionStore inline predicate (ProjectionStore.ts:1091), web (session-logic.ts, MessagesTimeline.logic.ts, MessagesTimeline.tsx, TimelineAssistantRows.tsx) and mobile (threadActivity.ts, ThreadFeed.tsx), goatToolSummary.ts and goatMcpToolPresentation.ts.
Older peers: an older client against a newer server shows the call as an ordinary GOAT tool row and does not show the message as a reply. A newer client against an older server: no tool, nothing to render. Stored data: ordinary dynamic_tool rows, no migration; old rows never match.
Negative cases (tests): blank or over 4,000 UTF-16 units is not rendered (as upstream); a failed call renders nothing; a `goat_call` to another path whose output carries `sentMessage` is not rendered (impersonation, GOAT addition); an outside MCP client is refused (`actsAsCaller`, like background.wait).
Budget: seven files at their entries need verbatim move-outs first. Captures: web and mobile before/after are P1 rows (Replay cannot drive the Claude adapter, N9a's record).
Rule 3 likely (R3, only if listed core): toolListing.test.ts "keeps the core listing a thread's model sees within its byte budget" and agent context budget figures.
Size: L on its own.

### 5984bbb36e (D2)

The adapter half only: `ProviderAdapterV2SteerInput.modelSelection?` (provider-core, in-process), ProviderTurnControlService.ts passing the steer effect's existing `modelSelection` into `steerTurn`, and the Claude steer path applying a live-capable selection with `applySelectionLive` before it offers the steer, with the prompt-effort prefix from that selection. Nothing persisted changes (EffectOutboxRequest.ts:53 is on dev; an older server decodes it already). About +25 adapter lines after M2; tests in a new file; SteeringCompletion's harness is not extended (upstream adds `steeredSelections`), so no rule 3.

## Order and size

M1 (runner errors move-out), 86e2cb21c9 (after R1), fdd54b942d, e4025c8528 (after R2), M2 (ClaudeLiveSelection move-out), d6e5f2e06f, 5984bbb36e if ruled in, aab388ddb1 if it stays (its move-outs first). One commit per row plus move-outs. Without aab388ddb1: M (about 600 lines with tests). With it: L.

## Decisions for the coordinator

D1, d6e5f2e06f under ruling C. Upstream's persisted effect is out. I propose an in-process reactor on `thread.model-selection-updated` that calls a new optional session method, with nothing persisted and Orchestrator.ts untouched. If the server dies between the commit and the reactor's call, the change applies at the next turn, which is what ruling C accepts. The other way inside C, calling the method from ThreadLifecycleService after its dispatch, misses selection changes from other paths (client RPC straight to the orchestrator, scheduled tasks). I ask you to confirm the reactor as option C.

D2, 5984bbb36e. Its persisted half is on dev since #3397, so porting it adds no stored or wire change: an in-process steer-input field and the Claude adapter applying the selection before it offers the steer. It needs D1's helper. I recommend porting it in K5 right after d6e5f2e06f, tests in a new file, no change to SteeringCompletion's harness (no rule 3). Cost: one more control round trip to the CLI on a steer that changes the selection.

D3, aab388ddb1's scope. It is an agent-surface, web and mobile change with seven budget move-outs and two P1 captures, larger than the other four rows together, and only its prompt line touches the Claude adapter. I propose moving it out of K5 into its own follow-up lane, or into K10 with a mobile half. If it stays, three answers are needed: (a) name and path, `message.send` / `goat_message_send` by GOAT's naming rule or upstream's `send_to_user`; (b) listing: core (loaded up front for every harness; spends core-listing bytes, may need R3) or Claude-only through the instruction plus `goat_call`; (c) no permission prompt in Plan mode and read-only sandboxes, as upstream's read-only list and N9a's background wait.

D4, e4025c8528's startup barrier. Moving the leftover slice stop from the first launch to server startup changes a merged dev test's expectation (R2) and adds one systemd probe to every Linux server start. I recommend accepting it as upstream has it: it closes the window in which recovery can continue a run whose old CLI is still alive.

## Rule 3 requests I expect (each sent with the exact before and after; held until answered)

- R1 (86e2cb21c9): ClaudeAgentSdkQueryRunner.test.ts :254, :328, :378, :417, :452, :482, one added mock line each.
- R2 (e4025c8528): agentScope.test.ts :54 helper options and provide line; :336 retitled, its stop asserted at startup.
- R3 (aab388ddb1, only if it stays and is listed core): toolListing.test.ts byte budget, agent context budget figures.

## Tests and gates

Focused: ClaudeAgentSdkQueryRunner.test.ts, ClaudeDescendants.test.ts (new), providerProcesses.test.ts (new; Linux only), agentScope.test.ts, ClaudeLiveEffort.integration.test.ts (new), ClaudeSteerSelection.test.ts (new), ClaudeAdapterV2.test.ts, ClaudeAutomaticDelivery.integration.test.ts, the Claude replay fixtures, goatMcpToolNames.test.ts. Gate: `vp run check:changed origin/chase/t3-261114-next3` plus the focused files, under the Air's heavy-job token; never repo-wide; no goat-ci dispatch (the coordinator runs lane=quick on READY). The integration head is merged once just before READY; both shas and git's report go here.

## Risks

- 86e2cb21c9: a resumed open can wait 10 minutes (boot timeout plus one retry) before reporting the start-up timeout.
- fdd54b942d: a job an agent detached on purpose to outlive the session now stops on macOS when the session closes (Linux with systemd already does). One `ps -A` per live session per second.
- e4025c8528: the read-to-signal race upstream names (Node has no pidfd_send_signal) stays; a wrong kill needs a pid reused with the same start tick and boot. A Linux host without /proc/sys/kernel/random/boot_id would fail layer construction (upstream reads it unguarded); I check GOAT's Linux targets and say so.
- d6e5f2e06f: the reactor is one more consumer of the domain event stream; its queue is bounded and a slow CLI control call must not hold other threads' events (one fiber per thread, or a deadline on the call; settled in code and review).

## NOT RUN I expect

- providerProcesses.test.ts and any /proc-based case: Linux only; NOT RUN on this Mac; covered by the coordinator's goat-ci run on the READY head.
- Real Claude turns: none planned. Live effort, steer selection and stray-job reaping are proven by the adapter harness and real fake-CLI processes; Replay cannot drive the Claude adapter (N9a's record). If aab388ddb1 stays, whether Claude actually calls the tool needs one paid turn on the cheapest Claude model in a scratch-folder project, proposed for P1.
- Web and mobile captures for aab388ddb1: P1 rows.


## Lane moved to pen-mac-studio (2026-11-17)

The code phase runs on pen-mac-studio in thread mcp:fea82f75-6e68-4a1d-a10a-1072718f1972 (goat-thread://v1/mcp:fea82f75-6e68-4a1d-a10a-1072718f1972), replacing the plan thread mcp:0c406d59-647b-4710-992d-73fb48694f72 on cpa-macbookair, whose branch was never pushed and has no commits. Branch chase/t3-261114-next3-k5-claude-adapter, cut from origin/chase/t3-261114-next3 at c995c5427accaaa92dadac50ec756c35f4b92034 (git rev-parse HEAD; git merge --ff-only origin/chase/t3-261114-next3: "Already up to date"). pen-mac-studio is shared with K10: one heavy job at a time between the two lanes.

## Coordinator ruling of 2026-11-17 21:38:37 UTC, run 1817 (sections I, III, IV, V and K5, verbatim)

> I. #3696 MERGED; INTEGRATION HEAD c995c5427a
> - The fresh C4 review of #3696 at b7672aa5f8 was APPROVE WITH NITS (six P3, no P0 to P2; report /Users/jun/handoff-in/chase/pr3696-T1b-review-b7672aa5.md). MERGED BY ME 21:29:00 UTC, dev = 8c59f73519663bdb1fff3346d1caedf06083ddf7 (goat-ci-result success on the head, run 44173778052). goat#3694 closed with it.
> - chase/t3-261114-next3 fast-forwarded to dev 8c59f73519 (this is the one dev merge), then K10's shared pre-commit 2bc2e7761b merged by me after a line-by-line read (useComposerSend.ts:301-407 at a608046c51 equals useComposerSend.ssh.ts:54-160 byte for byte; the builder, the wrapper and the two call sites read). chase/t3-261114-next3 = c995c5427accaaa92dadac50ec756c35f4b92034 (parents 8c59f73519 and 2bc2e7761b; plain push). One wording nit for K10's own lane, no new commit on the pre-commit: the new file's doc comment says "rebuilt each render as before" while it is built per call.
> - Every lane with no code commit runs git merge --ff-only origin/chase/t3-261114-next3 before its first commit and reports the sha. K2, which is coding, keeps its plan: one merge of the integration head after K7 lands, and it does not write into useComposerSend.ts before that merge.
>
> III. SHARED AT-ENTRY FILES (your list of 22:0x)
> The pre-commit branch stays the tool for one case only: two lanes need the SAME block moved, or a lane needs room in a file before the lane that frees it lands. For the rest, a claims table:
> 1. On card 10.028 keep one table "at-entry move-outs": file, lane, the block as path:line range at c995c5427a, the new module, lines freed. A lane writes its row BEFORE it cuts the block. You refuse a row that overlaps another lane's range and bring an overlap you cannot settle to me.
> 2. Every lane nets zero or less in each at-entry file by its own commits (its move-out frees at least what its rows add). No lane leaves a file longer than its entry at the cut.
> 3. code-budgets.json conflicts at a lane's merge of the integration head are settled by countLines of the merged file, never by a number above the entry at 8c59f73519.
> 4. Same-basename entries in your list are settled by the records: K7 means packages/client-runtime/src/state/server.ts (and apps/server/src/server.ts only for rows 10 and 11, which leave K7, see VI) and apps/server/src/terminal/Manager.ts.
> 5. Order of landing for the meeting points: K7 first in packages/contracts and packages/client-runtime (as ruled); K1's Orchestrator.ts, orchestrationV2.ts and orchestratorMcp.ts move-outs are K1's own blocks (dispatchPullRequestWatchSync, the watch.sync struct, OrchestratorMcpThreadPullRequest) and K7 and K10 claim other blocks; MessagesTimeline.tsx, MessagesTimeline.logic.ts, ThreadFeed.tsx, thread-work-log.tsx and ThreadDetailScreen.tsx: K10 before M3's O22 (M3 D3); apps/mobile/src/features/pull-requests/: K2 before M3 (M3 D7).
>
> IV. RULE 3, ONE STANDING AUTHORISATION
> Rule 3 stays: no existing test expectation changes without my word. To stop one round trip per line, my word is given in advance for the MIRRORED case only, when all three hold: (1) the upstream commit being ported changes the same assertion in upstream's own copy of that test in the same way; (2) the lane quotes both hunks, upstream's and GOAT's, before and after, in its record BEFORE the commit; (3) the commit changes no other existing expectation. The fresh review checks every one; one it cannot match to upstream's hunk is a P2. Everything else still comes to me with exact before and after: GOAT-own tests with no upstream counterpart, deleted or retitled tests, moved harnesses, and anything a lane is unsure of.
>
> V. CAPS, PLACEMENT, T1c
> - Coding lanes at once: seven, K4 included (K2, K7, K1, K10, M3, K4, and K5). Fresh reviews at once: two, unchanged. No further lane starts without a plan ruled by me.
> - K5 starts now only on a Mac that host.status placement shows with at most one lane and no warning or critical pressure; the Air is not doubled up (it went critical under one lane in next). Otherwise K5 takes the slot of the first lane that reaches READY. Tell me the host.
> - T1c, [the T1c paragraph is T1's; omitted here as not K5's].
>
> K5 (Claude adapter): plan ACCEPTED; start per V. READ BY ME: next3-K5.md whole; L01-retry.md:60-78. NOT READ: the upstream commits, the SDK types.
> - D1: CONFIRMED as option C. The in-process reactor in orchestration-v2/goat/LiveModelSelection.ts on thread.model-selection-updated, nothing persisted, Orchestrator.ts untouched. Conditions: a bounded queue; one thread's slow control call never holds another thread's events (per-thread serialisation and a deadline on the call); errors are caught inside the reactor; the provider's own report is not echoed; the record says for each other adapter "not supported here, applies at the next turn".
> - D2: port 5984bbb36e's adapter half in K5 after d6e5f2e06f.
> - D3: aab388ddb1 LEAVES K5 and becomes its own lane (K12), started after K10 and M3 have landed their MessagesTimeline and ThreadFeed work, with a C4 plan to me first. My answers for that plan: listed for Claude only, through Claude's system text and goat_call, not in the core listing every harness loads; no permission prompt in Plan mode or read-only sandboxes; the impersonation negative stays; the name is proposed in that plan and must not read like thread.send, which sends to an agent's thread.
> - D4: accepted, the startup barrier as upstream. Conditions: a host without /proc/sys/kernel/random/boot_id does not fail layer construction: it logs once and skips reaping; the startup probe has a deadline and never holds the server's start; the reaper never signals pid 1, its own pid or an ancestor; a dead owner's record with no survivor is removed, so the directory does not grow.
> - fdd54b942d, one change to the plan: ONE process-table sampler per server shared by every live Claude session without a systemd scope, not one ps per session per second. It runs only while such a session lives, and the refresh before close stays per session. Measure it at about 3,000 processes (this Mac printed 621 KiB from 2,935 processes in the #3696 review, where a 512 KiB cap and a 1 s budget made ps fail): record the CPU per sample; above about 50 ms per sample lengthen the interval, and say the number. The parser takes a table of that size whole; a truncated or failed table kills nothing and logs once. The PR body's Limits say that a job an agent detached to outlive its session now stops on macOS when the session closes, as it does on Linux under systemd.
> - R1: AUTHORISED: the six mocks in ClaudeAgentSdkQueryRunner.test.ts (:254, :328, :378, :417, :452, :482) gain initializationResult: async () => ({}), no expectation change. R2 comes with its exact before and after.
>
> LANE COORDINATOR, FOR K5: quote your section (and I, III, IV, V) in next3-K5.md. Order from your plan without aab388ddb1: M1, 86e2cb21c9, fdd54b942d (ONE shared sampler, measured at about 3,000 processes), e4025c8528, M2, d6e5f2e06f (option C as confirmed), then 5984bbb36e's adapter half. Write your row in the "at-entry move-outs" table on card 10.028 BEFORE you cut any block of an at-entry file (send it to me through goat_origin_report needs_input if you cannot push the card). R2 comes to the coordinator through me with its exact before and after. First report: HEAD's sha (c995c5427a) and that you have read the plan; then code.

Effect on the rows above: aab388ddb1 (row 5) and R3 leave this lane (K12). Order: M1, 86e2cb21c9, fdd54b942d, e4025c8528, M2, d6e5f2e06f, 5984bbb36e adapter half.

## Code log


### Rule 3 widenings (coordinator, relayed verbatim)

> B. IV IS WIDENED, for every lane (relay it). The standing authorisation also covers, under the same three conditions (upstream's own copy changes the same way; both hunks quoted in the record before the commit; nothing else existing changes): (i) fixture, mock and helper lines in a test file or testkit, where upstream changes its own copy of that fixture or helper the same way; (ii) an existing case whose title and body become upstream's verbatim text of that same case. Still to me, with exact before and after: a deleted test or test file, a moved harness, a test with no upstream counterpart, and any case where GOAT's result differs from upstream's text by more than names. The review matches each one to upstream's hunk; a mismatch is a P2.
>
> Quote it in next3-K5.md. R2 (agentScope.test.ts) still comes to the coordinator through me unless upstream's own copy of that test changes the same way and you quote both hunks.

(2026-11-17 21:43:15 UTC)

> IV gains one more mirrored-free case, for every lane (relay it): (iii) a test file that moves with the module it tests, where the commit is a rename and the only changed lines are import paths to the moved module, with TEST_TITLES updated in the same commit when the file is listed there. Titles, bodies, setup and expectations byte for byte; the review checks the rename with git show -M, and anything more is a P2. A harness moved out of a test file into a testkit still comes to me.

(2026-11-17 21:52:47 UTC)

Integration head noted: chase/t3-261114-next3 = 259883c788bb32d5601023932e07f879bde9af60 after T1c (21:49:21 UTC); draft PR #3700. This lane merges it once before READY.

### M1 (384fbfd46e994b0d1f35997db3c30b2b3c208d8a)

Verbatim move: ClaudeAgentSdkQueryRunner.ts lines 52-53 (CLAUDE_ROOT_REFUSAL), 130-167 (the four error classes), 211-212 (their Schema.is guards), 220-244 (queryRunnerError, CLAUDE_PROCESS_EXIT_ERROR_CLASSES, claudeProcessExitFailure) at c995c5427a to the new ClaudeQueryRunnerErrors.ts. Only changes: `export` added to the five names that were module-private, and a two-line import header. The runner re-exports the four names ClaudeAdapterV2.ts imports from it (ClaudeAdapterV2.ts:297-323 unchanged). The timeout constant stayed in the runner (the plan said :51-53; it is runner configuration, not error text). Runner 996 -> 930 (wc -l). Lines removed and not re-added: none; the four blank separator lines are re-created in the new file. Checks: server tsc exit 0; ClaudeAgentSdkQueryRunner.test.ts 13/13.

### 86e2cb21c9 (67c1d0a4d585211a9097b324cee2a57b91fc23a8)

Fail first (upstream's cases added, fix absent): "opens after a slow CLI boot" Expected "Success" Received "Failure"; "times out a CLI that never boots" Received "Claude timed out while registering its MCP tools…". After the fix 16/16. GOAT case "a CLI that exits during boot reports its exit, not a start-up timeout" (real fake CLI, exit 3; asserts claudeProcessExitFailure code process_exited_nonzero). R1 as authorised: initializationResult added to the six mocks, no expectation changed. providerRefusalCases.testkit.ts keeps its own local ClaudeMcpRegistrationTimeoutError class (tag-only), untouched.

### fdd54b942d (e1457e545b695673a158d2b9cd60ebe255cbe745)

Shared sampler as ruled: ClaudeDescendants.ts makeClaudeDescendantSampler, built once in layerQueryRunner (the runner service is provided once per server in ProviderOrchestrationAdapterInfrastructure.ts:133). One ps table per 1 s tick feeds every tracked CLI; the poll fiber starts with the first unscoped CLI and is interrupted when the last one stops. Per-session refresh before close kept. A failed, timed-out or over-8-MiB table (ProcessRunner outputMode error) is Option.none: nothing killed, one warning per server. Kill guard: pid > 1, not this server or its ancestors (walk of ppid from process.pid in the same table). The agent-scope path starts no tracker: ClaudeAgentSdkQueryRunner.ts `if (unit === undefined && child.pid !== undefined)` in the spawn callback.
Measurement (pen-mac-studio, 2,400 sleep children added, 3,059 rows, 20 samples): 143,773 bytes per table; ps CPU 26 ms avg / 30 ms max; ps wall 36 / 40 ms; parse 1.5 / 4.0 ms. About 28 ms per sample, under 50 ms: interval stays 1 second.
Fail first: upstream's two real-process cases hung before the wiring (timeout 75 exit 124; the detached job held the fifo). Three leftover sleep 600 processes from those killed runs were stopped by PID after lsof showed each writing to its own fixture fifo; their three /private/tmp/goat-test-* folders remain (the shell refused rm -rf). After: 18/18 runner, 5/5 ClaudeDescendants.test.ts, 26/26 with ClaudeProcessExit and ClaudeStopTeardown. Mutations: per-CLI polling fails "samples one process table per interval however many CLIs it tracks"; no server guard fails "never signals a reused pid, the CLI's old pid or this server".

### e4025c8528, R2 under the widened IV (i) and (ii), quoted before the commit

GOAT's case "stops agents a killed server left before the first launch" equals upstream's pre-image byte for byte except the slice name (upstream app-t3code-agents.slice, GOAT app-goat-agents.slice). GOAT's helper differs from upstream's only by an extra ServerSettings provide that the hunk does not touch. The commit changes no other existing expectation: before the test change, exactly this case failed (Expected [["--user","stop",…]] Received []) and the other 14 passed.

Upstream's hunk (git show e4025c8528 -- apps/server/src/process/agentScope.test.ts):

```diff
diff --git a/apps/server/src/process/agentScope.test.ts b/apps/server/src/process/agentScope.test.ts
index 0095146a30..a44ff15359 100644
--- a/apps/server/src/process/agentScope.test.ts
+++ b/apps/server/src/process/agentScope.test.ts
@@ -16,6 +16,7 @@ import { ChildProcess, ChildProcessSpawner } from "effect/process";
 import * as ServerConfig from "../config.ts";
 import { makeCodexAppServerSpawnCommand } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
 import * as ProcessRunner from "../processRunner.ts";
+import * as ProviderProcesses from "./providerProcesses.ts";
 import { classifyScope, make, ownedAgentSlice, type ScopeState } from "./agentScope.ts";
 
 const running: ScopeState = {
@@ -55,7 +56,14 @@ const withFakeSystemd = <A, E>(
   {
     oomPolicy = true,
     stopFails = false,
-  }: { readonly oomPolicy?: boolean; readonly stopFails?: boolean } = {},
+    leftovers = false,
+    liveOwner = false,
+  }: {
+    readonly oomPolicy?: boolean;
+    readonly stopFails?: boolean;
+    readonly leftovers?: boolean;
+    readonly liveOwner?: boolean;
+  } = {},
 ) =>
   Effect.gen(function* () {
     const bin = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-agent-scope-"));
@@ -102,7 +110,12 @@ const withFakeSystemd = <A, E>(
         }),
     });
     const fileSystem = yield* FileSystem.FileSystem;
+    const { stateDir } = yield* ServerConfig.ServerConfig;
+    if (leftovers) {
+      units.set(ownedAgentSlice(stateDir), { activeState: "active", result: "success" });
+    }
     const scope = yield* make.pipe(
+      Effect.provideService(ProviderProcesses.ProviderProcesses, { hasOtherLiveOwner: liveOwner }),
       Effect.provideService(ProcessRunner.ProcessRunner, runner),
       Effect.provideService(HostProcess.Platform, "linux"),
       Effect.provideService(HostProcess.Environment, { PATH: bin, XDG_RUNTIME_DIR: "/run/user/1" }),
@@ -114,7 +127,6 @@ const withFakeSystemd = <A, E>(
           fileSystem.writeFileString(path.replace("/sys/fs/cgroup", cgroupRoot), data, options),
       }),
     );
-    const { stateDir } = yield* ServerConfig.ServerConfig;
     return yield* body({ scope, units, calls, stateDir, cgroupRoot }).pipe(
       Effect.ensuring(Effect.sync(() => NodeFS.rmSync(bin, { recursive: true, force: true }))),
     );
@@ -308,27 +320,34 @@ describe("AgentScope service", () => {
     ),
   );
 
-  it.effect("stops agents a killed server left before the first launch", () =>
-    withFakeSystemd(({ scope, units, calls, stateDir }) =>
-      Effect.gen(function* () {
-        units.set(ownedAgentSlice(stateDir), { activeState: "active", result: "success" });
-        const agent = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
-        const stops = calls.filter(([, verb]) => verb === "stop");
-        expect(stops).toEqual([["--user", "stop", ownedAgentSlice(stateDir)]]);
-        expect(sliceOf(agent)).toBe(ownedAgentSlice(stateDir));
-        expect(agent.args).toContain("--property=TimeoutStopSec=10s");
-        const terminal = yield* scope.wrap({
-          command: "agent",
-          args: [],
-          name: "terminal",
-          survivesRestart: true,
-        });
-        expect(sliceOf(terminal)).toBe("app-t3code-agents.slice");
-        expect(calls.filter(([, verb]) => verb === "stop")).toHaveLength(1);
-      }),
+  it.effect("stops agents a killed server left before startup completes", () =>
+    withFakeSystemd(
+      ({ scope, calls, stateDir }) =>
+        Effect.gen(function* () {
+          expect(stopsOf(calls)).toEqual([["--user", "stop", ownedAgentSlice(stateDir)]]);
+          const agent = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
+          expect(sliceOf(agent)).toBe(ownedAgentSlice(stateDir));
+          expect(agent.args).toContain("--property=TimeoutStopSec=10s");
+          const terminal = yield* scope.wrap({
+            command: "agent",
+            args: [],
+            name: "terminal",
+            survivesRestart: true,
+          });
+          expect(sliceOf(terminal)).toBe("app-t3code-agents.slice");
+          expect(stopsOf(calls)).toHaveLength(1);
+        }),
+      { leftovers: true },
     ),
   );
 
+  it.effect("leaves the slice to another live server sharing this home", () =>
+    withFakeSystemd(({ calls }) => Effect.sync(() => expect(stopsOf(calls)).toEqual([])), {
+      leftovers: true,
+      liveOwner: true,
+    }),
+  );
+
   it.effect("stops leftover processes only in an active agent scope", () =>
     withFakeSystemd(({ scope, units, calls, cgroupRoot }) =>
       Effect.gen(function* () {
```

GOAT's hunk (git diff of apps/server/src/process/agentScope.test.ts on the lane, before commit):

```diff
diff --git a/apps/server/src/process/agentScope.test.ts b/apps/server/src/process/agentScope.test.ts
index 0f653f4524..6d43a3f48f 100644
--- a/apps/server/src/process/agentScope.test.ts
+++ b/apps/server/src/process/agentScope.test.ts
@@ -18,6 +18,7 @@ import * as ServerSettings from "../serverSettings.ts";
 import { DEFAULT_SERVER_SETTINGS } from "@goat/contracts";
 import { makeCodexAppServerSpawnCommand } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
 import * as ProcessRunner from "../processRunner.ts";
+import * as ProviderProcesses from "./providerProcesses.ts";
 import {
   AGENTS_TASKS_MAX_PERCENT,
   classifyScope,
@@ -63,7 +64,14 @@ const withFakeSystemd = <A, E>(
   {
     oomPolicy = true,
     stopFails = false,
-  }: { readonly oomPolicy?: boolean; readonly stopFails?: boolean } = {},
+    leftovers = false,
+    liveOwner = false,
+  }: {
+    readonly oomPolicy?: boolean;
+    readonly stopFails?: boolean;
+    readonly leftovers?: boolean;
+    readonly liveOwner?: boolean;
+  } = {},
 ) =>
   Effect.gen(function* () {
     const bin = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-agent-scope-"));
@@ -110,12 +118,17 @@ const withFakeSystemd = <A, E>(
         }),
     });
     const fileSystem = yield* FileSystem.FileSystem;
+    const { stateDir } = yield* ServerConfig.ServerConfig;
+    if (leftovers) {
+      units.set(ownedAgentSlice(stateDir), { activeState: "active", result: "success" });
+    }
     const scope = yield* make.pipe(
       Effect.provide(
         Layer.mock(ServerSettings.ServerSettingsService)({
           getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
         }),
       ),
+      Effect.provideService(ProviderProcesses.ProviderProcesses, { hasOtherLiveOwner: liveOwner }),
       Effect.provideService(ProcessRunner.ProcessRunner, runner),
       Effect.provideService(HostProcess.Platform, "linux"),
       Effect.provideService(HostProcess.Environment, { PATH: bin, XDG_RUNTIME_DIR: "/run/user/1" }),
@@ -127,7 +140,6 @@ const withFakeSystemd = <A, E>(
           fileSystem.writeFileString(path.replace("/sys/fs/cgroup", cgroupRoot), data, options),
       }),
     );
-    const { stateDir } = yield* ServerConfig.ServerConfig;
     return yield* body({ scope, units, calls, stateDir, cgroupRoot }).pipe(
       Effect.ensuring(Effect.sync(() => NodeFS.rmSync(bin, { recursive: true, force: true }))),
     );
@@ -333,27 +345,34 @@ describe("AgentScope service", () => {
     ),
   );
 
-  it.effect("stops agents a killed server left before the first launch", () =>
-    withFakeSystemd(({ scope, units, calls, stateDir }) =>
-      Effect.gen(function* () {
-        units.set(ownedAgentSlice(stateDir), { activeState: "active", result: "success" });
-        const agent = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
-        const stops = calls.filter(([, verb]) => verb === "stop");
-        expect(stops).toEqual([["--user", "stop", ownedAgentSlice(stateDir)]]);
-        expect(sliceOf(agent)).toBe(ownedAgentSlice(stateDir));
-        expect(agent.args).toContain("--property=TimeoutStopSec=10s");
-        const terminal = yield* scope.wrap({
-          command: "agent",
-          args: [],
-          name: "terminal",
-          survivesRestart: true,
-        });
-        expect(sliceOf(terminal)).toBe("app-goat-agents.slice");
-        expect(calls.filter(([, verb]) => verb === "stop")).toHaveLength(1);
-      }),
+  it.effect("stops agents a killed server left before startup completes", () =>
+    withFakeSystemd(
+      ({ scope, calls, stateDir }) =>
+        Effect.gen(function* () {
+          expect(stopsOf(calls)).toEqual([["--user", "stop", ownedAgentSlice(stateDir)]]);
+          const agent = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
+          expect(sliceOf(agent)).toBe(ownedAgentSlice(stateDir));
+          expect(agent.args).toContain("--property=TimeoutStopSec=10s");
+          const terminal = yield* scope.wrap({
+            command: "agent",
+            args: [],
+            name: "terminal",
+            survivesRestart: true,
+          });
+          expect(sliceOf(terminal)).toBe("app-goat-agents.slice");
+          expect(stopsOf(calls)).toHaveLength(1);
+        }),
+      { leftovers: true },
     ),
   );
 
+  it.effect("leaves the slice to another live server sharing this home", () =>
+    withFakeSystemd(({ calls }) => Effect.sync(() => expect(stopsOf(calls)).toEqual([])), {
+      leftovers: true,
+      liveOwner: true,
+    }),
+  );
+
   it.effect("stops leftover processes only in an active agent scope", () =>
     withFakeSystemd(({ scope, units, calls, cgroupRoot }) =>
       Effect.gen(function* () {
```


### Further coordinator rulings (relayed verbatim)

> 3. CLAIMS: K4's ProviderTurnStartService.ts :189-217 as a wrapper plus a call line is accepted on the pre-commit's terms: the moved expression byte for byte inside the new function, every added line (signature, parameters, return, call) listed in the commit message and the record, no behaviour change; the review reads it. Any other claim that is not a top-level declaration follows the same terms without asking.

(2026-11-17 21:59:20 UTC)

> IV gains (iv), for every lane (relay it): where GOAT's test file is byte for byte upstream's parent of the commit being ported (git diff <sha>^ on that file empty), the file may become upstream's file at that commit, whole, deletions and retitles included; the record gives both empty diffs (before against <sha>^, after against <sha>). If GOAT's file differs from upstream's parent in any line, deletions and retitles still come to me.
>
> Quote it in next3-K5.md. (It may cover R2 if agentScope.test.ts is byte for byte upstream's parent of the commit you port; check with git diff <sha>^.)

(2026-11-17 22:00:50 UTC.) Not used: GOAT's agentScope.test.ts differs from e4025c8528^ (ServerSettings provide, slice names, AGENTS_TASKS_MAX_PERCENT import), so R2 rests on (i) and (ii) as quoted above.

> IV gains (v), mock scaffolding: a line added to a test's mocks so that existing cases keep loading or rendering after the lane's row adds a component, hook or import. Covered: one export added to an existing vi.mock factory, or one vi.mock of a module the lane's own row introduced. Conditions: the stub is inert (renders its children, returns undefined, or does nothing); no existing title, body, setup value or expectation changes; the line is quoted in the record before the commit; the file stays within its entry; and what the stub hides is tested in a case of its own or named in the lane's P1 rows. Still to me: a mock that returns data existing assertions read, a changed existing mock line, a stub of a module the lane did not add, and anything a lane is unsure of. The review checks each; a miss is a P2.
>
> IV gains (vi), a describe moved whole: a whole top-level describe block of an at-entry test file moved byte for byte into a sibling test file, in a commit that does nothing else, on K7's conditions a to d above (empty diff of the two ranges in the record; helpers copied byte for byte and listed, none moved or shared; the same case titles and the same total count before and after; the entry lowered; the card row before the cut; TEST_TITLES updated in the same commit when the file is listed). Still to me: a harness or helper moved or shared into a testkit, a describe split in two, a nested block, and a move that needs any line of a case to change.

(2026-11-17 22:16:44 UTC.) Neither (v) nor (vi) was used: no existing mock or describe moved. The new ClaudeSteerSelection.test.ts carries its own copy of the effect/Queue capture mock that ClaudeWakeDispatch.test.ts and ClaudeAdapterV2.test.ts already use (new file, no existing line changed).

### e4025c8528 (f91c53bfe3b07e28b2f144835f9be9d4ad394bf8)

providerProcesses.ts as upstream with D4: no boot_id, unreadable own identity, or an unwritable state directory logs once and returns the default (no reaping, no register; the spawn gate is still opened). The startup barrier: agentScope.ts forks the cached systemd probe in the layer scope and awaits it for at most STARTUP_PROBE_DEADLINE = 10 seconds, logging and continuing after that; the probe keeps running and wrap still awaits it. The reaper skips pid 1 (schema minimum 2), this server and its ancestors (ppid walk from process.pid through /proc). A dead owner's record with no survivor is removed; so is a dead owner's never-renamed .json.pending (its CLI was still gated on fd 4 and exited when the server's pipe closed). Layer order: server.ts:1273 provides AgentScopeLive (and with it ProviderProcesses) to everything above it, layerRuntimeServices and recovery included, so the reap and the leftover stop finish before recovery is built. guardChild already routes errors on every stdio stream, the fd-4 gate included, so upstream's gate.on("error") is not added.
Fail first: upstream's "records the CLI before it runs and forgets it once it exits" with ClaudeProcessSpawn.ts at HEAD: Expected "0 0" Received "67723 " (the CLI ran with no record). agentScope.test.ts before its test change: only "stops agents a killed server left before the first launch" failed (Expected [["--user","stop",…]] Received []), 14 passed. Mutation: without the live-owner guard "leaves the slice to another live server sharing this home" fails. After: 44 passed, 2 skipped (the two Linux providerProcesses cases) across the runner, descendants, agentScope, providerProcesses, ClaudeProcessExit and ClaudeStopTeardown files.

### M2 (301ff1933fbd4eb70ea1b1cceb23ec8374110ff0)

Card row first (records 306c3a02cf). Verbatim move of ClaudeAdapterV2.ts:524-543 at c995c5427a to ClaudeLiveSelection.ts; export added to both functions. Adapter lines removed and not re-added: the blank separator :544; "type EffortLevel," (import list, now only the new module uses it, re-imported there); "type ClaudeFlagSettings," (runner import list, same reason; lint caught it). Added: a four-line import of the two names. 10933 -> 10914.

### d6e5f2e06f (276261bd66a1e31e4a7480745fb743263f981842), option C as confirmed

LiveModelSelection.ts (orchestration-v2/goat), started from runtimeLayer.ts layerProduction with the memoized orchestrator and session manager layers; Orchestrator.ts, EffectOutbox and ProviderTurnControlService's shape untouched. Conditions: bounded (latest selection per thread, at most 256 threads draining; a full table drops and logs once); per-thread serialisation (one drain fiber per thread, forked in the reactor's scope; the stream handler never waits on a call); 10 second deadline on each call; failures and defects caught and logged inside; events with rawEventId (ProviderEventIngestor.ts:436 writes them with the raw event's id) are not applied. Claude: applyModelSelection through ClaudeLiveSelection.applyClaudeSelectionToRunningQuery (upstream's guards and applySelectionLive helper; openQuery calls the helper, GOAT's reportedModel reset kept in it).
Other adapters, each: not supported here, applies at the next turn. Codex, Cursor (CLI and SDK), Grok, OpenCode, Antigravity, Pi, Muse Code, fx, ACP agents, and the cloud providers (Claude Cloud, Cursor Cloud, Devin Cloud) leave applyModelSelection unset; the reactor finds no method and does nothing; their next turn starts with the thread's selection as today.
Fail first: ClaudeLiveEffort.integration.test.ts with the reactor wired and no adapter method hung on the applied Deferred (timeout 50, exit 124). After: 1 passed. LiveModelSelection.test.ts 3 passed; mutations: echo (no rawEventId filter) fails the first case; no deadline and no defect catch each hang the third (timeout 20, exit 124). Run: 508 passed across ClaudeLiveEffort, LiveModelSelection, ClaudeLiveSelection, ClaudeAdapterV2, runtimeLayer and ClaudeAutomaticDelivery test files. Adapter 10914 -> 10904.

### 5984bbb36e adapter half (d7feb27f021d9cc264af82e0d301bbc8ad8be387)

ProviderAdapterV2SteerInput.modelSelection (upstream's); ProviderTurnControlService.steer takes modelSelection?: ModelSelection | undefined and passes it to steerTurn; EffectWorker forwards effect.request.modelSelection in one line (998 -> 999, cap 1000). Claude: claudeSteerSelection (upstream's guard) decides; the selection is applied after the background moves and before the turn-ended check, with its prompt-effort prefix. SteeringCompletion's harness is not extended.
Fail first: ClaudeSteerSelection.test.ts against the adapter at HEAD: "applies a model change sent with a steer to the running turn" expected [] to deeply equal [Array(2)]; "fails a model-changing steer when the turn ends during the selection change" expected 'Success' to equal 'Failure'. After: 2 passed. End to end: "applies a model change sent with a steer through the effect worker" (ClaudeLiveEffort.integration.test.ts) hangs with the EffectWorker line reverted (timeout 30, exit 124) and passes with it. Run: 562 passed across ClaudeSteerSelection, ClaudeLiveEffort, ClaudeAdapterV2, ClaudeLiveSelection, EffectWorker, ProviderTurnControlService, SteeringCompletion, runtimeLayer and ClaudeWakeDispatch test files. Adapter 10904 -> 10916: 17 below its entry at the cut (10933); the lane nets -17 in this at-entry file.

### Integration head merge (once, before READY)

Lane head before: d7feb27f021d9cc264af82e0d301bbc8ad8be387. Integration head: 259883c788bb32d5601023932e07f879bde9af60. git merge --no-edit origin/chase/t3-261114-next3: "Auto-merging oxlint-plugin-goat/code-budgets.json. Merge made by the 'ort' strategy." (3 files: ThreadWorkspaceService.setupLockOrder.test.ts +3, Manager.leaseOrder.test.ts +115, code-budgets.json 1 line; no conflict). Merge commit 9ea1bd0d421c9d544b6a601bdeb80c969d381118.
Then 18c6644ea83ed79bb24536d3960270035d9f1a97: four lane exports made module-private after knip flagged them in check:changed.


> FOR EVERY LANE (relay it): before a push, every changed test file runs whole, with no -t filter; and for a row that changes when or whether something wakes, notifies or holds a thread, the test files of that subsystem run whole as well. A -t run is for iteration and is named as such in the record.

(2026-11-17 22:45:36 UTC.) Whole runs of every changed test file: ClaudeAgentSdkQueryRunner.test.ts (19/19 after e4025c8528, and inside the 44-run), ClaudeDescendants.test.ts, agentScope.test.ts (16/16), providerProcesses.test.ts (1 passed, 2 Linux skipped), LiveModelSelection.test.ts, ClaudeLiveSelection.test.ts, ClaudeLiveEffort.integration.test.ts (2/2), ClaudeSteerSelection.test.ts (2/2), each also inside check:changed's 305 files. The -t runs (process-group cases, "records the CLI", the two steer cases singly, the steer case against reverted EffectWorker) were iteration and fail-first runs only. No K5 row changes when or whether a thread wakes, is notified or is held. Push order: the lane branch was pushed at 18c6644ea8 while check:changed's test step was still running; that run then passed on the same head (below), and nothing was pushed after it.

### Lane gate at 18c6644ea83ed79bb24536d3960270035d9f1a97 (on origin)

vp run check:changed origin/chase/t3-261114-next3 (22 files since 259883c788bb): format, lint (two pre-existing no-low-value-comments warnings at ClaudeAdapterV2.ts:749 and :756, not lane lines), knip 1/2 and 2/2, graphql, agent surface audit, agent context budget, typecheck (17 packages): pass. test (305 files): pass, 1349.7 s, Test Files 305 passed, Tests 3898 passed | 4 skipped. The first check:changed run (knip failure) was followed by a second; an overlapping leftover of the first (PID 29605 with its vitest 30041/30105, cwd this worktree) was stopped by PID.
Budgets at the head: ClaudeAdapterV2.ts 10916 (entry 10916, dev 10933); ClaudeAgentSdkQueryRunner.ts 979, EffectWorker.ts 999, agentScope.ts 457, ClaudeProcessSpawn.ts 96 (no entries, under 1000).

NOT RUN: providerProcesses.test.ts's two Linux cases and every /proc path (reaping, register identity, ancestor guard): Linux only, they run in the coordinator's goat-ci on this head. Real Claude turns: none; live effort, steer selection and stray-job reaping are shown with the adapter harness and real fake-CLI processes. P1: no client-visible change in K5, so no capture row. Linux e4025c8528 behaviour on a host with user systemd (the startup barrier against a real systemctl): goat-ci's Linux job runs agentScope.test.ts with a fake systemd only.
Cleanup: no build outputs created. Three fixture folders under /private/tmp/goat-test-* from the killed process-group runs remain (the shell refused rm -rf); a few KB each.


## Review round prep (coordinator run 1836): answers to (a)-(g)

Coordinator, run 1836, for K5 (relayed verbatim, my part): "K5 at 18c6644ea83ed79bb24536d3960270035d9f1a97: RECEIVED … THE ONE FRESH C4 REVIEW STARTED: task goat-next3-K5-review-18c6644e … My open questions in it, so K5 can think but NOT push: (a) ClaudeDescendants' tracked map only grows (observe adds, nothing removes before stop), so a session that lives for days grows it and every sample walks it; (b) providerProcesses.make runs readdirSync and rmSync unguarded after the guards, so a throw there fails the layer, against D4's "never fatal"; (c) the reaper signals the recorded pid only while the record stores pgid; (d) which entry points besides the server build ProviderProcesses.layer (a short-lived command would count as "another live owner"); (e) register's ppid check under every Linux launch form; (f) what the adapter's live identity says after the reactor's 10 s deadline interrupts a control call, and whether the reactor's call and a steer's apply can interleave on one query; (g) shared daemons a session starts (adb, Gradle, kache, an ssh ControlMaster) under the accepted macOS limit. … BOTH HEADS STAY PUT while the reviews read: no push to either lane branch, no merge of the integration head, until I send the review's result. … K5's three leftover /private/tmp/goat-test-* fixture folders on pen-mac-studio: leave them … EVERY LANE: a typecheck or test claim names the package as vp resolves it (apps/server is "goat"), and a filter that matches nothing is not a pass."

The lane head stays 18c6644ea8; nothing pushed or merged. The fixes below are local and uncommitted in the lane worktree, ready for a fix round.

(a) Confirmed. ClaudeDescendants.ts track(): observe only added to tracked, so a long session kept every descendant it ever saw and fed all of them back as roots. Prepared: each observe first drops identities missing from the whole table it got (a failed read never observes, so a bad table removes nothing), and every remaining entry is a root. This changes no kill decision: stop kills only identities present in its final table, and a dropped identity (pid plus start time) cannot reappear. Memory and walk cost now follow the live descendants. No test reads the map's size (internal); the five sampler tests pass.

(b) Confirmed. readdirSync, the per-record rmSync and the owner record's finalizer could throw after the guards. Prepared: a readdir failure reads no records; every rm and the finalizer run through Effect.try and are ignored. register's own write still throws on purpose: that fails one launch (the gated child is killed), not startup. Not unit-tested: making readdir fail after mkdir succeeded needs a permission trick that root CI ignores; the guards are visible at providerProcesses.ts in the diff.

(c) Confirmed (upstream does the same). Prepared: when the record's pgid equals its pid and the identity still matches, the reaper SIGKILLs the group (signalProcessGroup), else the pid. A live leader's group id cannot be reused, and the CLI was spawned detached as its own leader, so the group is that CLI plus the MCP servers that stayed in it, which the dead server's watcher would have killed. New Linux case "takes the process group of a recorded CLI that still leads it" (a detached sh leading a group with a sleep child; after the reap the child is gone). NOT RUN here (Linux only).

(d) Only the server. rg finds AgentScopeLive.layer only at server.ts:1273 (provideMerge, which brings ProviderProcesses.layer), and layerMakeServer/runServer only at cli/server.ts:116 (goat's server start, also the desktop's backend). No short-lived command builds it, so none can count as another live owner.

(e) register runs synchronously in spawnClaudeProcessGroup right after NodeChildProcess.spawn("/bin/sh", …) returns, while that sh is still blocked on read <&4 before any exec. /proc/<pid>/stat then names the spawning process as ppid, which is process.pid in every Linux form: a plain binary, a script entry (same spawn path), the systemd-run scope wrapper (that wrapper is what sh execs after the gate), the desktop backend (the server is its own Node process) and worker threads (same pid). If the identity cannot be read, register throws and the child is killed: the launch fails rather than running unrecorded. Only the provider status probe uses its own spawn (ClaudeProvider.ts:270, spawnClaudeProbeThroughEnv); it is short-lived and not recorded, as before.

(f) Before the prepared fix: tapError does not run on interruption, so after the reactor's 10 s deadline the adapter kept the old identity while the CLI might still apply the new flags. A later return to the old selection would then be skipped as already applied. And the reactor's apply, a steer's apply and a turn start's apply could interleave on one query. Prepared: (1) Effect.onError (any failure exit, interruption included) clears the identity, so the next turn re-sends; (2) one Semaphore per query (WeakMap keyed by the session's query object in ClaudeLiveSelection.ts) around every live apply, with the reactor's guard re-checked under the lock. Tests (ClaudeLiveSelection.test.ts): "an interrupted live change leaves the identity unknown so the next turn sends it" fails with tapError back; "a reactor change and a steer's change on one process run one after the other" fails with the lock removed (the steer finished while the reactor's call was blocked).

(g) A daemon a session starts with setsid or a double fork (adb server, Gradle daemon, kache, an ssh ControlMaster from ControlPersist) is a CLI descendant when sampled, so on macOS it now stops when the session closes or the CLI exits. That is what Linux under the systemd agent scope already does: stopping the scope takes every process in the cgroup. Another session sharing that adb server or ControlMaster loses it, and the next use starts a new one (adb start-server, a fresh ssh master, a new Gradle daemon). Masters from the user's own shells are not descendants and are untouched. I do not propose a name-based exclusion list: it would infer ownership from executable names, which the lane avoids elsewhere. If wanted, it is a decision for you: one allowlist of executables never stopped, on both platforms. Accepted limit, as upstream: a job that daemonizes and whose CLI exits within the same 1 s sample is missed (the close path refreshes first, so a closed session does not miss it).

Prepared-fix checks (local, uncommitted): typecheck of package goat (apps/server) exit 0; whole runs of ClaudeLiveSelection, ClaudeDescendants, providerProcesses, agentScope, ClaudeSteerSelection, ClaudeLiveEffort, LiveModelSelection and ClaudeAgentSdkQueryRunner test files: 8 files, 52 passed, 3 skipped (the three Linux providerProcesses cases).


## Coordinator 23:40 UTC, section II for K5 (verbatim)

> II. K5 (head stays 18c6644ea8; prepared fixes for (a), (b), (c), (f))
> 1. Good: preparing while the review reads is what I want. The fixes stay LOCAL (commits allowed, no push) until the review reports. Then ONE fix round carries them together with the reviewer's findings, one fix per commit, each with its failing test first as you describe.
> 2. After the push of that round: goat-ci lane=quick AND lane=server on the new head (the new Linux case of (c) must RUN there, as the two existing ones), and a fresh review of the fix delta 18c6644ea8..<new head> only. That review takes the next free slot ahead of any lane's first review that has not started. K5 merges after it, still first.
> 3. For the fix-delta brief, K5 states in its record, by path:line: (c) the group is signalled only after the recorded leader's pid AND start time still match at signal time, and never for pgid 0, 1 or the server's own group; (a) a row is dropped only on a COMPLETE table (not on a failed, timed out or truncated one); (f) the lock is released when the reactor's 10 s deadline interrupts the holder, and the steer path cannot wait behind it longer than that deadline.
> 4. (g) RULED: no name-based exclusion list. A list of daemon names is fragile, differs from Linux under the systemd scope and from upstream, and each of adb, Gradle, kache and an ssh ControlMaster starts again on next use. Conditions: one sentence in #3700's Limits and one in docs/user where closing a session is described, in the product's voice (closing a Claude session stops the background helpers that session started; they start again when next needed). I reopen this only if the review's 1(e) names a helper whose stop loses data rather than costing a cold start.
> 5. (d) and (e) noted; the reviewer checks them (2(e), 2(f)).

### Local fix commits (not pushed; lane head on origin stays 18c6644ea8)

- e813c9f320 (a) the descendant sampler keeps only live jobs
- 50269b590f (b) provider process records never fail server startup
- 53de7f798f (c) reaping a recorded CLI takes the group it still leads (+ Linux case)
- aa30e28658 (f) a live selection change is serialized and safe to interrupt (+ three cases)
- 65ddf6b326 (g) docs/user/providers-claude.md: one sentence

Checks at 65ddf6b326: typecheck of package goat (apps/server) exit 0; whole runs of ClaudeLiveSelection, ClaudeDescendants, providerProcesses, agentScope, ClaudeAgentSdkQueryRunner, ClaudeSteerSelection, ClaudeLiveEffort and LiveModelSelection test files: 8 files, 53 passed, 3 skipped (Linux).

### Item 3 statements, by path:line at 65ddf6b326

(c) apps/server/src/process/providerProcesses.ts:151 skips a survivor that is protected (this server or an ancestor) or whose pid and start time do not match; inside the same synchronous call, :156 reads the identity again (\`if (!matches(survivor)) return;\`) right before the signal, and :157 signals the group only when \`survivor.pgid === survivor.pid && survivor.pgid > 1 && survivor.pgid !== owner.pgid\` (owner is this server's own identity, :87, so its pgid is the server's group); otherwise :159 signals the pid alone. pgid 0 and 1 fail \`> 1\`; the record schema also refuses pid below 2, and signalProcessGroup itself throws for pid <= 1 (packages/provider-core/src/server/processGroup.ts). The read-to-signal race inside that call stays, as named in the comment (no pidfd_send_signal in Node).

(a) apps/server/src/orchestration-v2/Adapters/ClaudeDescendants.ts:145 drops a tracked identity only inside observe, and observe runs only on Option.some: the shared sample (:134) and the per-session refresh (:160) map over the table Option, and stop observes inside Option.map too. readClaudeProcessTable (:41-55) returns Option.some only when ps exited 0 and the output was not truncated (:50); a 5 s timeout (:45) and output past 8 MiB (:46, ProcessRunner's default outputMode "error" raises ProcessOutputLimitError) fail the run, and :54 turns every failure into Option.none. So a failed, timed out or truncated table drops nothing.

(f) apps/server/src/orchestration-v2/Adapters/ClaudeLiveSelection.ts:75 and :110 take the per-query permit with Semaphore.withPermits, which releases it when the holder ends, interruption included; :61 (Effect.onError) clears the identity on that interruption. The reactor wraps its whole apply (lock wait and control call) in Effect.timeout(CALL_DEADLINE) (apps/server/src/orchestration-v2/goat/LiveModelSelection.ts:17 and :37), so a reactor holding the permit is interrupted no later than 10 s after its apply began, and the permit is released then: a steer waits behind the reactor at most that deadline. Test: "an interrupted change frees the process for the next one" (ClaudeLiveSelection.test.ts: the reactor's call never answers, TestClock passes 10 s, the waiting steer then runs and re-sends the model because the identity was cleared). Limit stated plainly: a steer behind another steer's apply waits for that apply's CLI answer, which has no deadline of its own (as a steer's own control calls had none before the lock); a turn start's apply runs before its turn is active, so a steer for that turn cannot be queued behind it.

### (g) sentences

docs/user/providers-claude.md (no existing passage described closing a session; the sentence goes under the guide's opening, where Claude sessions are introduced; on Windows the CLI is not tracked as a process group, so the sentence names macOS and Linux):
"On macOS and Linux, closing a Claude session stops the background helpers that session started, such as a dev server or a build daemon; they start again when next needed."

Proposed for #3700's Limits (the coordinator owns that body):
"On macOS, closing a Claude session now also stops background helpers the session started outside its process group (a dev server, a Gradle or adb daemon, an ssh ControlMaster), as Linux under the systemd agent scope already does; each starts again on next use."


## Review of 18c6644ea8: BLOCK on one P2; fix round

Review report: devlog/_chase/261114_lanes/K5-review/next3-K5-review-18c6644e.md (records 35a737b2dce), read whole.

### Coordinator, 2026-11-17 23:50:37 UTC, section I (verbatim)

> I. K5: REVIEW REPORTED, BLOCK on one P2. THE FIX ROUND STARTS NOW: PUSH WHEN DONE.
> The fresh review of 18c6644ea8 is saved whole at /Users/jun/handoff-in/chase/next3-K5-review-18c6644e.md (19,663 bytes; scratch /tmp/k5-review-18c6644e). Its verdict: the kill guards, the reaper's trust rules, the launch gate, the startup order, the reactor's conditions, the boot deadline, both verbatim moves and rule 3 hold; both goat-ci runs are green on the head (quick 44198291794; server 44198312834 completed SUCCESS, and I read in its log "src/process/providerProcesses.test.ts (3 tests)" passing in shard 3 of 4, so the two Linux cases ran). All nine findings accepted by me:
> - P2-1 (blocks): the tracked map never forgets (12.8 ms per sample and 17.9 MB at about 110,000 rows for one CLI). Your local e813c9f320 is the fix. ADD the reviewer's case: a job is seen, is absent from one whole table, then the same pid and start time return under ppid 1, and stop does not kill it.
> - P3-2: your aa30e28658 (onError, one lock per query). P3-3: your 50269b590f.
> - P3-4: the reaper's wait gets a total bound: signal every survivor first, then wait once, about 1 second in all. A case with two survivors that do not die.
> - P3-6: fork the poll loop in the layer's scope; and let concurrent refresh and stop calls share one in-flight table read IF that is small (about 20 lines); otherwise a Limits sentence and an issue draft for the mass-close ps burst.
> - P3-7: a case that the 257th thread's change is dropped and logged, and warnedFull resets once the table drains.
> - P3-1: the fd 4 gate has no test that fails without it. Add one only if it needs no real-time wait (goat/no-real-time-wait-in-tests stands; no sleep, no slow register). If you find no such form, write it as a Limit with the reviewer's mutation named. Do not weaken the lint rule.
> - P3-5 and P3-8: no code. Limits sentences for #3700: records of another hostname, state folder or version are never removed; a Claude start can show "working" for up to 13 minutes before the start-up message (two attempts of 5 minutes boot plus 90 seconds), upstream the same.
> - 2(c), your 53de7f798f (the recorded leader's group): the reviewer calls it optional and upstream signals the pid only. KEEP it, as a recorded fork delta, with the guards you list (pgid <= 1 refused, the server's own group refused, the leader's identity read again inside the signal call); the fix-delta review reads it first.
> - (g) FINAL: no exclusion list. The reviewer's reading adds one fact the sentence must carry: when a session closes, a build in ANOTHER session that was using a shared helper it started (a Gradle daemon, adb, a compiler cache) fails and has to be run again; the helper starts again on next use. Put that in 65ddf6b326's docs sentence and in the Limits sentence, in the product's voice.
> - Your stated limit (a steer queued behind another steer's apply has no deadline of its own) goes to the fix-delta reviewer as an open question; say in the record how long the holder can hold the lock at most.
> Process: one commit per finding on top of 18c6644ea8, the gate per push as before, then PUSH and report the new head with the list of commits. I then dispatch goat-ci lane=quick and lane=server on it and start a fresh review of the fix delta only. K5 has pen-mac-studio's heavy-job token first.

### Fix commits on top of 18c6644ea8 (the earlier local ones were rebased locally, never pushed: new shas, same trees except where a finding added to them)

| finding | commit | proof |
| --- | --- | --- |
| P2-1 | c059fbf2bf | the reviewer's case "forgets a job a whole table no longer lists" failed before the fix (killed [200]); 6/6 after |
| P3-3 | 68d66c46ed | guards only; the failing states (EMFILE, unreadable directory) cannot be made under root CI |
| 2(c), kept as fork delta | 5dbed6c30a | Linux case "takes the process group of a recorded CLI that still leads it" (runs in goat-ci server) |
| P3-2 (+3(c)) | e8c5f125d7 | three cases; tapError back and lock removed each fail one |
| (g) | f932dfe7a3 | docs sentence (below) |
| P3-4 | a76eabc9ea | "unkillable survivors of two dead servers delay startup once, not once each": against the per-record wait it did not finish in its TestClock second (timeout 25, exit 124) |
| P3-6 (first half) | b7fcac1b3e | "stops sampling when its layer closes": without the finalizer 10 more reads after close |
| P3-7 | 50e90aaac3 | "drops a change past 256 draining threads, warning once each time the table fills": without the reset the second fill logged nothing; 5 consecutive passing runs |

P3-6 second half NOT taken: a stop must read a table taken after its CLI exited, and an in-flight read shared with a refresh may predate that exit, so sharing reads would trade the burst for a stale-table kill decision. Limits sentence and issue draft below.

P3-1: no gate test without a real-time wait. A test tells a gated launch from an ungated one only if the ungated CLI runs before register returns, which needs register slower than the CLI's exec (a real wait, refused by goat/no-real-time-wait-in-tests) or a race. Written as a Limit; the reviewer's mutation (delete "read -r _ <&4 || exit 1" at ClaudeProcessSpawn.ts:10; ClaudeAgentSdkQueryRunner.test.ts stays 19/19) is named there.

Lock hold time, for the fix-delta reviewer (open question): a holder holds the per-query permit for one live change, setModel when needed plus applyFlagSettings, until both answer or fail. The reactor holder is interrupted at most 10 s after its apply began (LiveModelSelection.ts CALL_DEADLINE, which also covers its wait for the permit), and the permit is released then. A steer holder or a turn start holder has no deadline of its own: it holds until the CLI answers those control requests or the query fails or closes (the SDK has no control-request deadline, ClaudeAgentSdkQueryRunner.ts's own comment). So a steer queued behind another steer waits as long as the CLI takes to answer the first; before the lock both steers waited on the same CLI anyway, since control requests travel over one ordered channel (review 3(c)).

### Limits sentences for #3700 (the coordinator owns that body)

- (g) On macOS, and on Linux without a systemd user manager, closing a Claude session now also stops background helpers the session started outside its process group, such as a dev server, a Gradle or adb daemon, or a compiler cache, as Linux under the systemd agent scope already does; a build in another session that was using one of those helpers fails and has to be run again, and the helper starts again on next use.
- P3-5: Provider process records written under another hostname or state folder, or by a newer version, are never removed; each unclean exit of such a server leaves a few hundred bytes that every start reads.
- P3-8: A Claude start that never finishes booting can show "working" for up to 13 minutes before the start-up message (two attempts of 5 minutes boot plus 90 seconds MCP registration), as upstream.
- P3-6: When many Claude sessions close at once on macOS, and on Linux without a systemd user manager, each starts its own ps for the refresh before close and another after the CLI exits (about 30 to 50 ms CPU each at 3,000 processes); they are not shared.
- P3-1: The launch gate that keeps a Claude CLI from running before its record exists (ClaudeProcessSpawn.ts fd 4) has no test that fails without it; deleting the gate line leaves the tests green, because register runs synchronously right after spawn.
- Fork delta: reaping a dead server's Claude CLI kills its process group when the CLI still leads the group it was recorded with (upstream kills the pid only).

### Issue draft (P3-6 second half), not filed

Title: Claude descendant sampler: a mass close starts two ps per session
Body: On a host without a systemd agent scope (every Mac), closing a Claude session runs one ps -A table read for the refresh before close and one after the CLI exits (ClaudeDescendants.ts track: refresh and stop). Closing N sessions at once starts about 2N ps processes, each about 30 to 50 ms of CPU at 3,000 processes, with no cap. Sharing an in-flight read between concurrent calls is not enough: a stop must use a table taken after its own CLI exited. A fix would queue stops behind one read that starts after the latest exit, or batch stops arriving within a few milliseconds. Found in the K5 review of next3 (P3-6).


### Gate runs of the fix round

First check:changed on 005431f909 (local, never pushed): format, lint, knip, graphql, agent surface audit, agent context budget, typecheck (17 packages) pass; test (305 files) FAIL: 1 failed, 3904 passed, 5 skipped. The failure was this lane's own case "stops a job the CLI started in its own process group when the CLI exits" (it.live, timed out at 120 s). Cause: the P3-6 finalizer. The case provided the runner layer around the open only, so the layer closed when the open returned and the finalizer stopped the poll before the fake CLI's detached job existed. Fix, folded into the P3-6 commit: the layer is provided around the whole case (body and expectation unchanged; a deviation from upstream fdd54b942d's text of that case, which is this lane's port and not a dev test, so rule 3 does not apply). ClaudeAgentSdkQueryRunner.test.ts whole: 19/19. No leftover process (ps for sleep 600/3 empty after the timeout).
Process slip: I started that first gate in the same command as the ps check that showed another worktree's five-file vitest (chase-t3-261114-next3-n-*) running, relying on K5's precedence. The lane coordinator's later rule puts the ps check in its own step and waits; every later heavy job here followed it.

### Second gate and push

check:changed origin/chase/t3-261114-next3 on 50e90aaac349a2fe5f23124b3429327060d3b9d7 (ps checked first in its own step: no other worktree's job): format, lint, graphql, agent context budget, agent surface audit, knip 1/2 and 2/2, typecheck (17 packages) pass; test (305 files) pass, 1144.1 s, Test Files 305 passed, Tests 3905 passed | 5 skipped. Pushed plain: 18c6644ea8..50e90aaac3 (git ls-remote shows 50e90aaac3). K5's heavy-job token is released with this push.

The lane test change, before and after (ClaudeAgentSdkQueryRunner.test.ts, case "stops a job the CLI started in its own process group when the CLI exits"):
before:
      yield* openFakeCli(cli).pipe(Effect.provide(realQueryRunner));
      yield* Effect.promise(() => leftoverStopped);
    }),
after:
      // The runner layer owns the poll, so it stays open until the CLI has exited, as in the server.
      yield* openFakeCli(cli);
      yield* Effect.promise(() => leftoverStopped);
    }).pipe(Effect.provide(realQueryRunner)),

### Standing rule 3 extension (beside IV), coordinator 2026-11-18 00:35:17 UTC, verbatim

> "Standing rule from now, so this needs no round trip again: a type-only import added to an existing test file, and a layer provided to an existing case because the code under test gained a dependency, need no word from me when the commit changes no title, body, setup value or expectation of that case; the lane quotes the before and after in its record and the fresh review lists them. A provide that replaces or fakes a service the case's assertions read still comes to me."

Existing dev test files this fix round touched: none (ClaudeAgentSdkQueryRunner.test.ts's changed case, ClaudeDescendants.test.ts, providerProcesses.test.ts, ClaudeLiveSelection.test.ts and LiveModelSelection.test.ts are all this lane's additions, absent from dev).

NOT RUN (fix round): providerProcesses.test.ts's three Linux cases, the new group case included (goat-ci lane=server on 50e90aaac3); the P3-3 failure states; a real Claude turn; the startup barrier against a real systemd user manager.


### READY rule, coordinator 2026-11-18 00:45:31 UTC (relayed 01:15 UTC), verbatim

> "From now on for every lane: READY means the gate exited 0 on the pushed head, or the report names each failure with the same failure shown at the integration head."

K5 against it: the pushed head 50e90aaac349a2fe5f23124b3429327060d3b9d7 (git ls-remote) is the head the second gate ran on; no commit landed after it. That run's summary lists every step as pass (format, lint, knip 1/2 and 2/2, graphql, agent surface audit, agent context budget, typecheck 17 packages, test 305 files: 3905 passed | 5 skipped). The script's exit code itself was not captured (the shell session that held the echo had ended); check-changed.ts exits nonzero only when a step fails, and none did.


### Rule IV (coordinator 01:14:39 UTC, verbatim)

> IV. STANDING RULE, every lane, from now: before READY, every apps/server test file the lane added or changed is run once from apps/server with GOAT_TEST_TMP_GUARD=fail (CI sets it, check:changed does not), and the READY report says so. The ps check in its own step first, as before.

K5 at 50e90aaac349a2fe5f23124b3429327060d3b9d7 (unchanged; the fix-delta review reads this head). ps checked in its own step first: N10's vitest was running, I waited, the second ps showed none. Then from apps/server, GOAT_TEST_TMP_GUARD=fail vp test run with the eight apps/server test files the lane added or changed (git diff --name-only 259883c788...HEAD): ClaudeAgentSdkQueryRunner, ClaudeDescendants, ClaudeLiveSelection, ClaudeSteerSelection, ClaudeLiveEffort.integration, LiveModelSelection, agentScope, providerProcesses. Exit 0: Test Files 8 passed, Tests 57 passed | 3 skipped (the three Linux providerProcesses cases).

Time note: the lane coordinator's "01:15 UTC" on the READY rule relay above was written without a clock (lane coordinator, 01:17 UTC); the real send time is in the thread log. The content stands. No git stash was used in this lane; git stash list holds no entry naming K5 or its branch.


### Rule 3, value imports (coordinator 01:17:54 UTC, section II, verbatim)

> II. RULE 3, standing rule extended (beside the 00:35:17 rule), every lane: a VALUE import added to an existing import line of an existing test file needs no word from me when only appended cases or appended helpers use the new names and no existing title, body, setup value or expectation changes. The lane quotes the line before and after in its record; the fresh review lists it. An import that changes what an existing case runs against (a different module, a fake in place of a real service) still comes to me.

K5's imports in test files that exist on dev (git diff 8c59f73519 HEAD):
- apps/server/src/process/agentScope.test.ts: new line `import * as ProviderProcesses from "./providerProcesses.ts";`. Upstream e4025c8528 adds the same line in its own copy; covered by R2 (IV (i)), both hunks quoted above.
- apps/server/src/orchestration-v2/Adapters/ClaudeAgentSdkQueryRunner.test.ts: a NEW import line (not a name appended to an existing line), added in 67c1d0a4d5 (86e2cb21c9):
  before (lines 34-35): `import { spawnClaudeProcessGroup } from "./ClaudeProcessSpawn.ts";` then a blank line
  after (lines 34-36): `import { spawnClaudeProcessGroup } from "./ClaudeProcessSpawn.ts";` / `import { claudeProcessExitFailure } from "./ClaudeQueryRunnerErrors.ts";` / blank line
  The name is used once, at line 717, inside the appended GOAT case "a CLI that exits during boot reports its exit, not a start-up timeout"; no existing case runs against it. Asked of the coordinator because the rule names an existing import line, and this one is new.


### Coordinator 01:20:03 UTC on the new import line (verbatim, the part for K5)

> RULE 3, the 01:17 rule II covers a NEW import statement on the same terms as a name added to an existing line: only appended cases or appended helpers use what it imports, it imports a real module (no fake, no mock, no replacement of something an existing case reads), the import has no effect at load time that an existing case could see (no vi.mock beside it, no module that registers or patches something when loaded), and no existing title, body, setup value or expectation changes. The lane quotes the added statements in its record; the fresh review lists them. Whether the name sits on an existing line or a new one makes no difference, so K5 does NOT move its import.
> CONFIRMED under it, on your account and the lanes' records (NOT READ by me; …): … K5's claudeProcessExitFailure in ClaudeAgentSdkQueryRunner.test.ts. Both heads stay put.

Load-time check: ClaudeQueryRunnerErrors.ts imports only effect/Cause and effect/Schema and declares classes, guards and two functions; nothing registers or patches on load, and no vi.mock was added beside the import (the file's one vi.mock, of @anthropic-ai/claude-agent-sdk, is on dev). The import stays as is.


### Integration head moved to c31dfe1c41 (K10 merged, lane coordinator 01:42:48 UTC)

Not merged into the lane (no ruling asks for it). Read-only check: git merge-tree --write-tree 50e90aaac3 c31dfe1c41 exits 0, tree 2b733e4d53, no conflict; the only file both sides change is oxlint-plugin-goat/code-budgets.json (different entries, auto-merged). CI read by the coordinator on 50e90aaac3: quick 44210428100 SUCCESS, server 44210433010 in progress at 01:40 UTC.


## Merged; K5 nits follow-up

Coordinator 2026-11-18 01:50 UTC, section I, verbatim:

> I. K5: MERGED BY ME
> The fix-delta review reported APPROVE WITH NITS at 50e90aaac349a2fe5f23124b3429327060d3b9d7, no P0 to P2, three P3 (saved whole: /Users/jun/handoff-in/chase/next3-K5-fix-review-50e90aaa.md, 11,853 bytes; three decisions recorded as accepted, and the nine outcomes of the first review). Its runs: the new case fails against the pre-fix file; the probe is 0.69 ms a sample and 0.1 MB after about 110,000 jobs (12.82 ms and 17.9 MB before); the group kill signals nothing the dead server did not start; each mutation fails its case; five files pass under GOAT_TEST_TMP_GUARD=fail.
> READ BY ME: the report whole; goat-ci quick 44210428100 and server 44210433010 both SUCCESS on 50e90aaac3 (goat-ci-result success, no failed job; read 01:48 UTC); ClaudeAgentSdkQueryRunner.test.ts against 259883c788: 181 added, 0 removed, the one import statement (used at :717, an appended case), the six initializationResult mock lines of R1 exactly, the rest appended cases. NOT RUN by me: any test.
> MERGED at 2026-11-18 01:49 UTC: merge commit ac238fcce3 (parents c31dfe1c41 and 50e90aaac3; tree 2b733e4d53 = git merge-tree, the same tree the K10 reviewer computed; no conflict), plain push. #3700's body updated. The merged tree has had no CI yet: #3700's pull request run on ac238fcce3 is its first, and I read it at my next wake.
> RULED, K5's three P3 as ONE small follow-up (K5 lane, branch chase/t3-261114-next3-k5-nits cut from ac238fcce3, a commit per item, no fresh review: I read it and the final integration review covers it):
>  - P3-1: the one case the report gives (refresh with A and B, a refresh whose read fails, stop with B reparented: killed equals [200]); the commit message shows it failing under "a failed read is an empty table".
>  - P3-2: the Linux case's cleanup uses signalProcessGroup(leader.pid ?? 0, "SIGKILL") (it refuses pids of 1 or less), as ClaudeAgentSdkQueryRunner.test.ts:772 does. As written, a failed spawn would signal the test runner's own group.
>  - P3-3: the existing warning (providerProcesses.ts:77-79) with its cause before the empty list at :134-136, and for the failed removals at :155 and :186.
>  - On the records branch now, no code: the P3-6 and (g) Limits sentences say "on macOS, and on Linux without a systemd user manager".
>  Then READY with the gate on the pushed head and every changed apps/server test file once under GOAT_TEST_TMP_GUARD=fail; quick and server by me (a Linux-only case changes). It holds no other lane.

Done first, records only: the (g) and P3-6 Limits sentences above now say "on macOS, and on Linux without a systemd user manager". The fix-delta report file is not on pen-mac-studio and not on the records branch; the nits are worked from the ruling's wording.

### K5 nits round (holds pen-mac-studio's heavy-job token from 2026-11-18 ~02:00 UTC, token rule item 4)

Branch chase/t3-261114-next3-k5-nits from ac238fcce375e08d3c73c5cb5ce4de2c36c85055, local commits:
- c2160a792d P3-1 test: "a failed read between samples keeps what the last whole table showed" (killed [200]); under "a failed read is an empty table" it fails: expected [] to deeply equal [ 200 ].
- 6832638a8d P3-2 test: the Linux group case's cleanup uses signalProcessGroup(leader.pid ?? 0, "SIGKILL").
- 170f10c7fc P3-3: the "will not be reaped" warning with its cause for an unlistable records folder and for each failed record removal.
The gate waits for SF3's check:changed that was already running when the round reached its gate (ps at the gate); SF3 and N10 start nothing new until K5's gate ends.

