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
