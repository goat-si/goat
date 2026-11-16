# Lane N6: orchestrator, retry 2 (next PR, cycle 261114)

Branch `chase/t3-261114-n6-orchestrator`, head `5c92dee0bcefdbb6ea29702c0d86f2497d163e11`. The lane started from origin/dev `330c1837f6`. On the coordinator's instruction it then merged the integration branch `chase/t3-261114-next` at `b2fb30748a` (N1, N16, N11, N11b, N2, N5 and the N5 follow-up), and last origin/dev `97c0dd32c4`. Host: pen-macbookair.

## Rows

| Row | Upstream | Outcome | GOAT commit |
| --- | --- | --- | --- |
| move-out | - | verbatim move-out of Orchestrator.ts: dispatchCreatedThreadRecord and dispatchSecretRequestRecord (288 lines) moved to goat/ThreadRecordDispatches.ts | `e725221f0b` |
| C9 L69 | `86c379d07a` | adapt: delivery-time drop of a stale question wake, and a closed question's inbox item reads withdrawn | `0a694a82ac` |
| C9 ruling A1 | - | test: a completed task's open question keeps its wake, and answering it continues the child | `2038c54027` |
| C7 L59 | `94f54a5710` | adapt: a provider change that would end a running turn is refused | `31dc89a44f` |
| C13 L138 | `8d236998d0` (rest) | adapt: a runtime mode change wakes the queue as an automatic start | `ceeac8f448` |
| L94 | `daed1dd327` | take, adapted to GOAT names: a follow-up delegated task waits for the subagents its child starts | `4bed19149c` |
| L95 | `d70bfe6e97` | adapt (ruling a950ff93, PRECHECK; C4): a send to a thread whose missing worktree GOAT cannot restore fails before it is stored | `0a98d70e69` |
| L96 | `78b654f998` | adapt: Stop clears a finished child's row held by a stale native subagent | `4bf43f8ae1` |
| goat#3523 | - | GOAT: moving a thread to another worktree is refused while it would end the running turn | `c691726123` |
| goat#3523 condition | - | clients cannot send the worktree rebind check that lets a rebind pass a running turn (ruling 40507ed6) | `a827168d30` |
| knip | - | the two refusal texts are module-private | `5c92dee0bc` |
| budget | - | Orchestrator.ts entry lowered from 13908 to its real length: 13626 on the lane, 13630 on the tree merged with the integration branch (N5 added 4) | `311b91d165`, `c331539877` |

## Decisions

### C9 (coordinator ruling, quoted verbatim)

"Coordinator decision, 2026-11-16, lane N6, decision:e5e621e8-ed24-4cfc-aafc-a3072255add0 (ruling C9, a coordinator row): A1, close on cancelled and interrupted only. C9 A was chosen so that "no item is left behind that the user cannot answer". In GOAT a question of a child whose task ended COMPLETED or FAILED can still be answered: task.read lists it in pendingRequestIds and the answer continues the child (OrchestratorMcpService.ts:1617-1650; tested at OrchestratorMcpService.test.ts:3339). So that question is not such an item, its inbox item and its wake stay, and no existing dev expectation changes. For cancelled and interrupted tasks GOAT already dismisses the question and the wake is cancelled. Upstream's delivery-time drop is ported as the child describes (a queued question wake whose request is no longer pending is cancelled before it starts or accepted without starting; an answer to a closed question is refused), with upstream's tests. Record in next-N6.md, in plain words: GOAT differs from upstream 86c379d07a for completed and failed tasks, why, and what a parent agent and a person see in each of the four terminal statuses (the wake, the inbox item, task.read, what answering does). Add one test that pins the completed case end to end if none does: the wake for a completed task's pending question is still delivered and answering it continues the child."

#### How GOAT differs from upstream 86c379d07a

Upstream drops the parent's question wake when the child's task ends in any of four terminal statuses, because there a finished task can no longer use an answer. In GOAT a task that ends completed or failed with a question still open can use one: answering sends the answer to the child as a message, which starts a follow-up run there. So GOAT keeps that question, its inbox item and its wake, and closes a question only when its task ends cancelled or interrupted, as dev already did.

What a parent agent and a person see, for a child question still open when the task ends:

| Task ends | The parent's wake | The inbox item | task.read | Answering |
| --- | --- | --- | --- | --- |
| completed | stays; it starts once the parent is free | stays open | lists the question in pendingRequestIds | accepted; the child starts a follow-up run with the answer |
| failed | stays; it starts once the parent is free | stays open | lists the question in pendingRequestIds | accepted; the child starts a follow-up run with the answer |
| cancelled | cancelled, if it had not started; a started one gets a notice that the question was closed | closed: it leaves the open list, and decision.get reads it as withdrawn | does not list it | refused: "This question was closed when its thread stopped or settled at <time>, so it can no longer be answered." |
| interrupted | as cancelled | as cancelled | as cancelled | as cancelled |

The completed row is pinned end to end by QuestionEscalationService.staleWake.test.ts "a completed task's pending question keeps its inbox item and wake, and answering it continues the child" (`2038c54027`); the test fails if completed tasks also close their questions (the wake then reads cancelled). The refusal row is pinned by "a queued wake for a question closed while nobody listened is dropped, and the question refuses an answer" (`0a694a82ac`).

### Left-out hunk of 86c379d07a (coordinator ruling, quoted verbatim)

"## Left-out hunk of 86c379d07a (2026-11-16)
The intake-time drop stays left out, as a recorded left-out hunk, and the existing test "a blocked launcher..." in QuestionEscalationService.test.ts keeps its expectation. The record must say, in plain words, which case upstream's intake-time drop covers that the ported delivery-time drop does not (what exists for how long: a queued wake that is never started, an inbox item, a notification), and why that is acceptable under decision A1; if that case leaves a user or a parent agent with something they cannot act on, stop and ask instead."

#### What the intake-time drop would cover

Upstream also drops a wake when it arrives for a question that has already closed. In GOAT that happens only in a short race: QuestionEscalationService checks that the question is open, and the question closes before its wake is dispatched. What exists then, and for how long:

- If the parent is busy, a queued wake exists. The service re-reads the question right after dispatching and cancels the wake in the same pass (QuestionEscalationService.ts, `resolve`), so it lasts milliseconds. If the server stops in between, the wake waits in the queue until the next start, and the ported delivery-time drop cancels it before it can start. The wake is never started.
- If the parent is idle, the wake starts a turn at once. The parent agent then reads a question that is already closed. Its wake text tells it to read the question first and not to answer one that is resolved; `pending_request.read` shows the result; an answer is refused with the recorded outcome; and the service queues the parent a notice that the question no longer needs an answer. The cost is one short turn.
- No inbox item exists for the person: the inbox lists only open questions, and this one closed before the wake. The thread shows the closed question as it does today.

This is acceptable under A1 because nothing is left that a person or the parent agent cannot act on: the person has no open item, and the parent agent gets a closed question it can read, a refusal that says why, and a notice. A1 does not change this case, because the race concerns questions that closed, not tasks that ended.

### C7 (ruling A: refuse only while a turn runs)

A thread.model-selection.set or provider.switch that would release a live provider session is refused while the thread has an active run (preparing, starting, running or waiting). A change applied on the next turn, or one with no live session to release, proceeds, so queued deliveries keep picking up a selection set while they waited: runtimeLayer.test.ts "delivers a queued monitor update ..." (dev :6688) and "starts a queued delegated completion on a selection set ..." (dev :6801) are unchanged and pass.

Refusal surfaces. The text is: "This thread has a turn running, and this provider change would end it. Wait for the turn to finish, or press Stop, then try again."

- Agent: an MCP call that changes the thread's model or provider (ThreadLifecycleService.ts:140, through threadAccess.ts dispatchFailure) fails with code orchestration_error and that text.
- Client: the web and mobile model and provider pickers dispatch through client-runtime commands.ts:633 (updateThread with modelSelection); the command fails and the client shows the cause (UserFacingErrors replaces the generic dispatch prefix with it).

Left out: upstream's OrchestratorProviderSelectionBusyError tag and its threadAccess.ts and ThreadMessageIntake.ts cases. GOAT's adjacent background-work refusal uses OrchestratorDispatchError with a cause, and a new tag would change the error union on the wire. Upstream's 8-case test is carried in a new Orchestrator.activeTurnRefusals.test.ts, because control-reads is at its budget.

### C13 (ruling A)

After thread.runtime-mode.set commits, the orchestrator wakes the thread's queue as an automatic start. Upstream gates this on its runtime-mode ceiling, which GOAT does not have, so GOAT wakes on every mode change. Test: a third case added to UsageLimitQueue.test.ts's existing limited-queue test, "... until the mode changes after the reset": a mode change before the reset leaves the usage-limited queue held, and one after the reset starts it. No existing case or expectation changed.

### L94, L96

L94 carries upstream's test in a new DelegatedCompletionDelivery.followupSubagents.test.ts, since the main file has no room in its budget. subagentHoldsCompletion moves into provider-core's subagentProjection.ts as upstream has it. L96's loop moved verbatim out of settleBackgroundWork into goat/NativeSubagentTrees.ts. The helper lives there and not in goat/StoppedEarlierTurn.ts, which handles a different case (a provider turn still marked running at a new start). Upstream's test is carried in a new ThreadStop.staleNativeSubagent.test.ts, because ThreadStop.test.ts is at its budget.

### goat#3523 (coordinator ruling, quoted verbatim)

"Coordinator decision, 2026-11-16, lane N6, decision:40507ed6-d2c9-4ebd-b3de-e26ae1527d7b (goat#3523, a follow-on row the coordinator added): EXEMPT-CAS, with one condition. A thread.metadata.update that changes worktreePath while the thread has an active run is refused, except for the server's own rebinds (worktree.handoff, ThreadLaunchService, ThreadWorkspaceService workspace-fresh), which keep working. Condition: the exemption must not rest on a field any client may send. Either show with path:line that expectedWorktreePath cannot arrive through a client RPC, the hub proxy, or an MCP thread metadata tool (the public intake drops or rejects it, the way it refuses a client-sent continuation and a fork workspace at ThreadMessageIntake.ts), and add that refusal if it is missing; or key the exemption on the server-internal origin of the command. Tests: a client-shaped update that carries expectedWorktreePath during a run is refused; the mobile Git sheet's update and an MCP thread metadata update during a run are refused; worktree.handoff during a turn still rebinds and queues its continuation; an update that changes other metadata but not worktreePath during a run is still accepted; an update outside a run is accepted. C4 (a refusal clients did not get before): what the mobile Git sheet and an older web client show when refused (the error text), and what an agent's tool result says. The record names every caller that changes worktreePath and which side of the rule it is on."

How the condition is met. The exemption keys on two fields, and neither can come from outside the server:

- The public command intake (client RPC through apps/server/src/ws.ts:1856 into ThreadMessageIntake.dispatchCommand) refuses a client-sent `continuation` (ThreadMessageIntake.ts:152) and, since `a827168d30`, a client-sent `expectedWorktreePath` (ThreadMessageIntake.ts:160). No client sends either field today (`rg expectedWorktreePath` and `rg continuation` in apps/web, apps/mobile and packages/client-runtime find no metadata update that does).
- The hub proxy does not admit thread.metadata.update at all (packages/contracts/src/hubProxy.ts, HUB_PROXY_COMMAND_TYPES), and a hub-proxied command runs through the same intake on the node.
- The MCP thread metadata tool cannot change worktreePath: its four actions are rename, regenerate_title, link_pull_request and unlink_pull_request (apps/server/src/mcp/ThreadMetadataMcpService.ts:69-108).

Every caller that changes worktreePath, and its side of the rule:

| Caller | Fields | During an active run with a live session |
| --- | --- | --- |
| Web branch picker (apps/web/src/components/BranchToolbarBranchSelector.tsx:187), through client-runtime updateThread (packages/client-runtime/src/operations/commands.ts:617) | worktreePath | not refused in practice: the picker detaches the sessions first and then updates, as on dev, so no live session is left to release and the turn ends by that detach. The web guard isWorktreeChangeBlocked is lane N13b's port and is not in this head (corrected after review N6-P3-1). |
| Mobile Git sheet (apps/mobile/src/state/use-selected-thread-git-actions.ts:327), same command | branch, worktreePath | refused |
| Any client that sends the update while a session is live (an older web build, a script through the client RPC) | worktreePath | refused |
| worktree.handoff (apps/server/src/mcp/WorktreeMcpService.ts:299) | worktreePath, expectedWorktreePath: null, optional continuation | proceeds: the agent's own move |
| ThreadLaunchService workspace binding (ThreadLaunchService.ts:665) | branch, worktreePath | proceeds: it binds the worktree its preparing run waits for, and no provider session is live yet |
| ThreadLaunchService branch renames (ThreadLaunchService.ts:706, :737) | expectedWorktreePath | proceeds |
| ThreadLaunchService cancel-workspace (ThreadLaunchService.ts:933) | worktreePath: null | proceeds: a cancelled launch has no live session |
| ThreadWorkspaceService workspace-fresh (goat/ThreadWorkspaceService.ts:270) | expectedWorktreePath | proceeds |
| ThreadLifecycleService.updateMetadata (ThreadLifecycleService.ts:112) | worktreePath | has no caller in the server today; it would be refused |

A thread.metadata.update that changes worktreePath is refused while the thread has an active run (the web's deriveCanInterruptRunningThread rule) and the change would release a live provider session. The text is: "This thread has a turn running, and moving it to another worktree would end it. Wait for the turn to finish, or press Stop, then try again."

- Mobile: the Git sheet's worktree change (apps/mobile/src/state/use-selected-thread-git-actions.ts:327) fails and shows that cause.
- Agent: no agent path reaches this refusal today. The MCP thread metadata tool cannot send worktreePath, and worktree.handoff is exempt (corrected after review N6-P3-1). An agent that did reach it would get code orchestration_error with that text.
- A client that sends the update while a session is live gets the same refusal. The current web does not, because its branch picker detaches first (table above).
- Left behind on a refusal (review N6-P2-1): the phone's Git sheet creates the worktree and its branch before it binds the thread. When the bind is refused during a running turn, the new folder and branch stay on disk, nothing removes them, and a retry with the same branch name will probably fail. The mobile follow-on is goat#3557.

Difference from the ruling's wording (review N6-P3-6): the rule also requires that the change would release a live provider session. A worktree change during a preparing run, or before the session is live, goes through as on dev. It is also narrower than the web's rule in goat#3523, which blocks a thread queued with a run attached. This narrowing is what keeps ThreadLaunchService's bind of the worktree its preparing run waits for working (ThreadLaunchService.ts:665).

The server's own rebinds proceed, with no existing test changed. A launch binding the worktree its preparing run waits for releases no session (ThreadLaunchService.test.ts "launches a worktree request for Scratch ..." held this). A rebind with expectedWorktreePath (launch branch renames, workspace-fresh) or with a queued continuation (worktree.handoff; SelectionRestart.integration.test.ts "a workspace handoff ... completes its run and starts the queued continuation" held this) is the server's or the agent's own move. These exemptions are with the coordinator as decision 40507ed6.

C4 text for goat#3523 and C7 (Orchestrator.activeTurnRefusals.test.ts asserts each case):

- The mobile Git sheet and any client refused this way show the OrchestrationV2DispatchCommandError message, which the server sets to the refusal text (ws.ts:1873, userFacingDispatchErrorMessage): "This thread has a turn running, and moving it to another worktree would end it. Wait for the turn to finish, or press Stop, then try again." Older clients already render that message field, and an older server never sends this refusal: the move goes through and ends the turn, as before. On the phone the refusal is shown as a Git action failure, and the worktree the Git sheet created stays behind (goat#3557).
- An agent's tool result: `{ code: "orchestration_error", message: <the same text> }` (threadAccess.ts dispatchFailure).
- A client that sends expectedWorktreePath gets "A worktree rebind is checked by the server, not sent by clients."

The five tests in Orchestrator.activeTurnRefusals.test.ts and ThreadMessageIntake.test.ts:

1. A client-shaped update carrying expectedWorktreePath is refused at the intake whether or not a run is active: ThreadMessageIntake.test.ts "refuses a client-sent metadata update that carries expectedWorktreePath". On the code before `a827168d30` the command reached dispatch (`expected [ { …(5) } ] to deeply equal []`).
2. The mobile Git sheet's update during a running turn is refused: "during a running turn: the mobile Git sheet's worktree change". The MCP thread metadata tool cannot send a worktree change (above), so its test is the accepted rename, case 4.
3. worktree.handoff during a turn rebinds and queues its continuation: "a worktree handoff that queues the agent's continuation proceeds during its turn". SelectionRestart.integration.test.ts "a workspace handoff on Codex/Claude/Pi completes its run and starts the queued continuation" is unchanged and passes.
4. A change to other metadata during a run is accepted: "during a running turn: a rename, as the MCP thread metadata tool sends".
5. An update outside a run is accepted: "a worktree change ending the turn is refused: the same change after the turn completed".

### L95 (coordinator ruling, quoted verbatim)

"Coordinator decision, 2026-11-16, lane N6, decision:a950ff93-8ee1-413b-9f2e-83c26fde8b5a (row L95, upstream d70bfe6e97, a backlog row: "adapt it onto GOAT's restore with the MCP failure shape and negative tests"): PRECHECK. Before dispatch, a send to a thread whose missing worktree GOAT cannot restore (the folder is outside GOAT's worktrees folder, the branch is null, or the project is gone: the cases prepareTurnWorkspace skips today) fails with thread_not_sendable and a message that says why and what to do; nothing is stored and no run is created. A missing worktree GOAT can restore is accepted as today and restored at turn start under the workspace lease, with the preparing-run progress; a Git or setup failure there still shows as a failed turn. Upstream's synchronous restore inside send is not taken: GOAT's restore applies the cleanup snapshot and re-runs the project setup script, which can take minutes, and a send must not block on it. Conditions (C4): the precheck is cheap and does no Git work (existence and the three conditions only), and runs for every send path (client RPC, MCP thread.send and task follow-ups, scheduled tasks, channels, the hub proxy), or the record says which path is left out and why; older client: it shows the error text; older server: it never sends this failure and the turn fails as before; the MCP failure text is tested; negative cases: a restorable missing worktree is accepted and restored at turn start, and a present worktree is untouched; a race (the folder disappears between the precheck and turn start) falls back to today's failed turn. The record states the GOAT difference from upstream d70bfe6e97 and this reason."

GOAT differs from upstream d70bfe6e97: upstream recreates a missing worktree synchronously inside send and fails the send if that fails. GOAT checks only whether it could restore at all, and leaves the restore to turn start, because its restore applies the cleanup snapshot and re-runs the project setup script, which can take minutes, and a send must not block on it.

The check (goat/WorktreeSendCheck.ts, wired in goat/WorktreeSendCheckLive.ts) reads whether the folder exists, GOAT's worktrees folder setting and the project row. It runs no Git and no setup; WorktreeSendCheck.test.ts gives it only those three reads, and a present folder costs one existence read.

Send paths, as refined by review N6-P3-3. The check is for a sender who can act on the failure. It runs when the caller asks for it through ThreadManagementService.dispatch's options argument, which is not part of the command, so no client can set or strip it.

- Checked: a person's send through the public intake (client RPC and the hub proxy: ThreadMessageIntake.dispatchCommand); an agent's send through the MCP send tools (thread.send and task follow-ups via sendToThread at OrchestratorMcpService.ts, and the attachment send via ThreadMessageIntake.sendToThread). The CLI's thread send calls the MCP goat_thread_send tool (apps/server/src/cli/thread.ts:716), so it is checked too.
- Not checked, as on dev: every server-originated send (launch-watch and handoff wakes through threadWake.ts, decision routing, scheduled tasks, channels, continuations, and automation that dispatches straight to the orchestrator). Such a message is stored, and its turn fails at turn start where a person sees it. Before this refinement, those callers took the refusal as temporary and retried it with only a log line, and nothing showed in the thread.
- Also not checked: MCP thread creation with a prompt (OrchestratorMcpService.ts, the create-threads path). Its new thread takes its parent's worktree, which the parent's own turn is using at that moment.
- Cloud threads are skipped (review N6-P3-2): turn start prepares no local workspace for an instance that runs in the cloud, so the check asks the adapter registry with the same isCloudExecution test as ProviderTurnStartService.

Tests (ThreadManagementService.worktreeSend.test.ts and goat/WorktreeSendCheck.test.ts): a launch-watch wake and a routed decision to a thread whose worktree cannot be restored are each stored once (on the code before 89f7f6dd83 both were refused with ThreadManagementWorktreeUnrestorableError); a person's send through the intake and an agent's send through the MCP path are still refused; a cloud thread's missing worktree is not refused (before c34865fec7 it was).

C4 cases:

- MCP: `thread_not_sendable` with "The worktree of thread <id> at <path> is missing, and GOAT can't recreate it: <why>. <what to do> The message was not sent." The three whys and what to do are tested in WorktreeSendCheck.test.ts; the code and the full text are tested in ThreadManagementService.worktreeSend.test.ts.
- Older client: it shows the same text as the dispatch error message (userFacingDispatchErrorMessage, tested).
- Older server: it never sends this failure; the message is stored and its turn fails as before.
- Negative cases: a present worktree is untouched (one existence read, no refusal); a restorable missing worktree passes and is restored at turn start (restoreThreadWorkspace.test.ts "brings back the snapshot's changes, reruns setup and records the restore"); a live steer is not refused; a send the check passes is dispatched as before.
- Race: when the folder disappears between the check and turn start, the check has already passed. Turn start then restores it, or fails the turn as today.

Fail-first for L95: on the ThreadManagementService.ts before `0a98d70e69`, ThreadManagementService.worktreeSend.test.ts fails with `× a send to a thread whose missing worktree GOAT cannot restore is refused before it is stored`: the dispatch went through and returned `{"sequence":1,"storedEvents":[]}`.

## Fail-first output (code before each fix)

- C9: `AssertionError: expected 'queued' to equal 'cancelled'` (stale wake test); `AssertionError: expected 'answered' to be 'withdrawn'` (DecisionInboxClosedQuestion.test.ts).
- C9 A1 test: passes on dev (it pins dev's behaviour). Mutated to close completed tasks' questions, it fails with `expected 'cancelled' to equal 'starting'`.
- C7: 4 of 8 cases failed with `AssertionError: expected false to be truthy` (the refusal was missing in the active instance and restart cases); the other 4 passed.
- C13: `× holds a limited provider's queue ... until the mode changes after the reset` with `AssertionError: expected 'queued' to equal 'starting'`.
- L94: `the follow-up closed while the child's own subagent was still running: expected 'Child task completed without an assis…' to equal null`.
- L96: `expected { row: 'running', native: 'running', nativeRoot: 'running', nested: 'running', nestedRoot: 'running' } to deeply equal { row: 'completed', native: 'interrupted', … }`.
- goat#3523: `× a worktree change ending the turn is refused: a person's change during a running turn` with `AssertionError: expected false to be truthy`.

## C4

L95 is C4 (see its cases above). It adds ThreadManagementWorktreeUnrestorableError, a server-side tag that leaves the server only as an MCP failure (thread_not_sendable) or a dispatch error message. goat#3523 is C4 as a refusal clients did not get before (cases above). C7 and goat#3523 refuse through the existing OrchestratorDispatchError with a cause. No contract field or stored format changes.

## Gate

On pen-macbookair, the tree `fad0991978` (lane + integration `b2fb30748a` + origin/dev `97c0dd32c4`): `node scripts/goat-rename.ts --check` 0; `set -o pipefail; vp run check:changed` exit 1. Passed: format, graphql (2), lint, agent context budget, agent surface audit, knip 1/2, typecheck (39 packages). Failed:

- knip 2/2: the two refusal texts in goat/ActiveTurnRefusals.ts were unused exports. Fixed in `5c92dee0bc`; `vp run knip:check:exports` exits 0 afterwards.
- Tests (1113 files): 10 files failed, 1099 passed, 4 skipped.
  - SshWorkspaceSync.test.ts (44 tests), packages/ssh runtimeFactsScripts.test.ts and tunnel.client-session.test.ts fail identically on origin/dev `4191dbf39f`: the same 46 failures when those files are run alone ("Remote host is missing node on PATH", and stage 'remote_init' instead of 'push'). This host's shell and Git shim, goat#3479.
  - packages/ssh launchListenerScripts.test.ts (status '1' instead of '2' at a 1063 ms clock) and six web browser files hit timeouts during the 79-minute run: ChatView.modelPick, ChatView.fork, ChatView.handoffCompaction, ChatView.logic, Sidebar.shortcuts and UsageProviderSettings, with "Test timed out in 15000ms" and locator.click timeouts. All pass when rerun alone on the lane head. The lane changes no web or ssh code.

Focused runs on the lane, beyond the gate: the eight suites around provider switching (84 tests); the ten suites that dispatch thread.runtime-mode.set (335 tests); L94's ten related files (191 tests); L96's eleven related files (332 tests); and goat#3523's 43 worktree and metadata files plus runtimeLayer.test.ts (1000 tests; the three handoff cases that first failed now pass).

## Surfaces

- Server and agent: the refusals of C7 and goat#3523 are named above, with tests. The decision inbox's `status` for a closed user_input question is now withdrawn (agents reading decision.get or decision.list). A person's Cancel on a provider approval still reads answered (N6-P3-5, 1f2bd0b8ff).
- Web and mobile: no rendered change. The clients list only open inbox items, and no client code reads `withdrawn` (`rg withdrawn apps/web/src apps/mobile/src` finds none). Under A1 a closed question is closed exactly as on dev (cancelled and interrupted tasks), and the child thread shows it as a cancelled question item, as before. No captures were taken; see NOT RUN.
- Docs: no user guide describes these refusals or the inbox status; none changed. Agent-visible text: the two refusal messages are runtime errors, not tool descriptions or instructions, so agent-surface-audit.md and the context budget are unchanged.

## Known limits

- L95 refuses only sends GOAT cannot restore at all; a Git or setup failure during restore at turn start still shows as a failed turn (ruling a950ff93).
- Server-originated sends do not run the L95 check (N6-P3-3): they are stored and their turn fails visibly, as on dev.
- A refused "Create worktree" from the phone's Git sheet leaves the new worktree and branch behind (N6-P2-1); mobile follow-on goat#3557.
- thread.runtime-mode.set can still end a running turn on providers without an in-session mode switch (N6-P3-7, outside this lane); goat#3558.
- The intake-time drop of 86c379d07a is left out (ruling above).

## NOT RUN

- A real-client pass on web and mobile for C9. There is no rendered change to capture: clients list only open inbox items, and under A1 closing is dev's behaviour. No captures are in /tmp for this lane.
- A real-client pass for the C7, goat#3523 and L95 refusals on web and mobile. Their text reaching clients is asserted through userFacingDispatchErrorMessage, the function ws.ts uses.
- runtimeLayer.test.ts is beside a changed file, so check:changed ran it; it was not run separately after the last integration merge.
- An older-client and older-server run against a real older build: the C4 cases are argued from the wire (the existing message field, no new contract field) and covered by tests on this build only.

## Review follow-up (2026-11-16)

5c92dee0bc was merged into the integration branch at e1c031a498. The fresh C4 review of 5c92dee0bc gave APPROVE WITH NITS (one P2 with no code change, seven P3). The follow-up head is e74a5be3894b88a720081589cb5bf2398a947c03. It merges the integration branch at 44d7d60d20 (with N7 part 1) and contains it.

| Item | Commit | What |
| --- | --- | --- |
| N6-P3-3 | 89f7f6dd83 | only a person's or an agent's send is refused for a worktree GOAT cannot restore; server-originated sends are stored as on dev |
| N6-P3-2 | c34865fec7 | the precheck leaves cloud threads alone |
| N6-P3-5 | 1f2bd0b8ff | withdrawn applies to closed user_input questions only; a Cancel on an approval stays answered (before: withdrawn) |
| budget | 5dbdce50ad | verbatim move of the task-wait status helpers (25 lines) out of OrchestratorMcpService.ts into mcp/taskWaitState.ts, so N6-P3-3's one added line fits the integration branch's 3957 entry; the entry is lowered to the real 3930. This move came after the line it makes room for, because that commit predates the merge that brought the lower entry. |
| N6-P3-4 | e74a5be389 | the A1 test runs for failed tasks too; made to close failed tasks' questions, it fails ("expected 'resolved' to equal 'pending'") |

N6-P3-4, two record sentences:

- Upstream's own C9 test ("drops a stale question wake (missed terminal event: %s)" in its Orchestrator.control-reads.test.ts) is not carried. It needs upstream's DelegatedTaskQuestionReactor, which GOAT does not have, and it asserts the drop for a completed task, which A1 rejects. The GOAT test "a queued wake for a question closed while nobody listened is dropped, and the question refuses an answer" covers the delivery-time drop instead.
- The clause "or accepted without starting" in ruling e5e621e8 describes upstream's message.dispatch intake hunk. The second ruling (Left-out hunk of 86c379d07a) leaves that hunk out, so in GOAT a stale wake is only cancelled before it starts.

Issues filed: goat#3557 (N6-P2-1, mobile: check the run state before creating the worktree, or remove it when the bind is refused) and goat#3558 (N6-P3-7: thread.runtime-mode.set can end a running turn).

Owed to #3519's integrated pass (real clients):

- mobile Git sheet "Create worktree" during a running turn: the toast text, and the folder and branch left behind (goat#3557);
- a send to a thread whose worktree cannot be restored, from the web composer and the mobile composer: the error text shows, and the draft is kept;
- a web provider switch mid-turn: the toast, and the picker's state afterwards.

Follow-up checks on pen-macbookair, focused only (no heavy job there before #3519's full matrix). Fresh runs on the follow-up tree:

- the worktree send, intake, wake, decision routing, launch watch, handoff wake and attachment suites: 10 files, 193 tests;
- WorktreeSendCheck, worktreeSend, receiptStore and ThreadMessageIntake: 23 tests;
- the DecisionInbox suites: 61 tests;
- the OrchestratorMcpService suites on the tree merged with 44d7d60d20: 159 tests;
- QuestionEscalationService.staleWake: 3 tests;
- typecheck of apps/server, and lint on every changed file.

The full goat-ci run on #3519 is what verifies the lane.

NOT RUN (follow-up): check:changed, the full runtimeLayer.test.ts, web and mobile real-client passes, and the Effect 4.1 adaptation (the integration branch is frozen until N3 lands; this lane merges the new head and adapts then).
