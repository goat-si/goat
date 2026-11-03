# 008 — Revision R3: fold of audit round 3 (FAIL; 3 resolved at plan level, 6 partial, 1 open, 2 new P1)

Overrides 006/007 where they conflict.

## S. Serialized survivor state machine (R3 #1, #8)
CodexSurvivors keeps, per instance, one Semaphore(1) that serializes attach, adopt, release, sweep and terminate. Per survivor state:
pending -> adopting -> adopted | pending -> stopping -> stopped | stopping -> stop_failed.
- release keeps the survivor in "stopping" until T is observed terminal (snapshot or turn/completed); only then "stopped".
- stop_failed (control connection or interrupt failed, or no terminal status within the bound): survivor stays, the process is NOT
  terminated, the continuation run fails with "Codex turn from before the restart could not be stopped"; the next server start
  re-derives and retries.
- Process termination requires: no survivor in pending/adopting/stopping/stop_failed AND no attached session.
Tests: failed release while another thread on the same instance adopts (adoption unaffected, process kept); release success then last
survivor settles with no session -> terminate.

## I. Identity, including unidentified survivors (R3 #2, #11)
Derivation through continuation ancestry: for a pending continuation effect with sourceRunId S, walk S, then
S.restartContinuationOfRunId (contracts orchestrationV2.ts:740; walk as RestartContinuation.ts:235-236 does), collecting the latest
provider turn with a Codex nativeTurnRef on the same provider thread. A continuation that crashed after dispatch but before its adopted
provider turn persisted (registerRootTurn emits at CodexAdapterV2.ts:2568) has no provider turn, so the walk reaches its source and finds
the same T. Result per survivor: identified(T) | unidentified (no ref found or two candidates disagree).
- identified: gate G (007) applies.
- unidentified: at continuation, read the native thread: no active turn -> proven nothing running -> existing continuation; active
  turn -> STOP path on that turn, then existing continuation. Never adopt.
- Sweep of an instance is skipped when derivation failed for any of its threads (ambiguous ownership) — the process is kept and
  re-evaluated at the next start.
Tests: crash before adopted provider turn persisted (second start adopts T again via ancestry); unidentified + active -> interrupt.

## R. Lost callbacks of every kind (R3 #4)
Codex re-sends all pending server requests for a thread to the connection that resumes it (codex-rs
app-server/src/request_processors/thread_lifecycle.rs:964 -> outgoing_message.rs:463-481). Gate addition: from reattach until
adoption commits, the adapter records every server request (any method: approvals, requestUserInput, item/tool/call dynamic tools,
MCP elicitation, auth refresh) whose threadId is the survivor's native thread or one of its descendants; any such request or
non-empty activeFlags -> STOP path, and each recorded request is answered with a JSON-RPC error ("GOAT restarted; this request
was cancelled") so Codex does not wait on it. Requests arriving after commit are handled by the normal adapter handlers.
Test: a replayed approval request on resume -> answered with an error, turn interrupted, no adoption; same for a dynamic tool call.

## N. Native subagents (R3 new P1 #2)
Gate rejects adoption if T's snapshot contains collabAgentToolCall (any tool) or subAgentActivity items
(app-server-protocol v2/item.rs:460; adapter handles both, CodexAdapterV2.ts:5375-5390), or thread/loaded/list reports any loaded
thread whose parent is the survivor's native thread. Any decode failure of the snapshot -> STOP. Tests: each representation, and a child
thread active at reconnect.

## O. Completion overtaking replay (R3 new P1 #1)
Context gains `reconciling: true` and `deferredCompletion?: TurnCompletedPayload` at registration. The turn/completed handler, when
context.reconciling, stores the payload and returns without terminalizing (short permit section, no RPC). Live item notifications
during reconciliation are emitted normally and added to seenNativeItemIds. After the snapshot replay of unseen items, a short permit
section sets reconciling=false and takes deferredCompletion; then (no permit held) the completion function runs with deferredCompletion
?? the snapshot's terminal status (if T finished) — exactly once. Test: completion arrives before the thread/read response while an item
exists only in the snapshot -> the item is emitted, then the run completes once.

## Q. Shutdown budget (R3 #5)
Prerequisite: thread 3's merged shutdown contract (PR #2418 and the stop-intent PR). This PR rebases on it and adds to the shutdown path
only: stop-intent resolve (one file read), retention marks (record writes), non-waiting group signals. wp4 runtime proof measures
shutdown wall time with retained instances on the dev server and records it in the PR. Unit test: shutdown with retained and unretained
detached instances completes without advancing the TestClock.

## U. Linux unit membership (R3 #6)
Before a unit-wide signal: the recorded pid's /proc/<pid>/cgroup must name the recorded unit AND its argv must contain the socket path.
Units are spawn-unique (goat-codex-<uuid8>.scope, agentScope.ts:400). Any unreadable /proc field or mismatch -> unverifiable/mismatch
rules (no signal). Linux runtime NOT RUN on this host; decision logic unit-tested with a fake process table.

