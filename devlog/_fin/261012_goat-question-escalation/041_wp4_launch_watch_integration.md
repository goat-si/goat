# 041 — wp4 plan amendment: integrate with the launch watch (#15) after rebase onto origin/dev 390b9fd42

## What changed upstream

`840e58797` + `08ceb177e` (Refs #15) added a launch watch: for `goat_thread_launch` and `goat_ssh_thread_launch` targets, the launcher's server follows the target's runs (locally through `ThreadManagementService.waitForThread`, remotely through the SSH MCP session's `goat_thread_wait` + `goat_pending_request_list`) and queues one message on the launcher when a run ends, when the thread waits on a question (`questionWake`, `apps/server/src/mcp/launchWatch.ts` ~328), or when the host stays unreachable. Watches persist in `<stateDir>/thread-launch-watches.json`. `HostThreadsMcpService` now depends on `LaunchWatchService`.

This means remote questions of `goat_ssh_thread_launch` targets already reach the origin by pull. Our D9 seam stays valid for push and for delegated children on hosts (#10), but the brief's "remote → origin automatic delivery" is now partly served without #5.

## Problems after the rebase (found at P by main)

1. **Busy loop (blocker).** wp3 made `waitForThread` and remote `goat_thread_wait` return at once while a `user_input` question is pending. The launch watch calls them in a loop (`LaunchWatchService.ts` local step ~285–315, `remoteStep` ~339–375) and returns `pause = 0` once a question was reported, so a reported-but-unanswered question makes the watch spin (remote: an SSH round trip per iteration).
2. **Duplicate notices.** A local `goat_thread_launch` target's `user_input` question produces both our structured escalation (wp2) and the watch's `questionWake`.
3. **Stale remote text.** `questionWake` tells the launcher a remote question "can be answered in that thread from a client connected to <host>"; wp3 made it answerable here.
4. **Post-rebase breakage.** `packages/contracts/src/orchestrationV2.test.ts` lost a closing brace in the conflict merge; `PendingQuestionsMcpService.test.ts` and `OrchestratorMcpToolkit.integration.test.ts` (~4237, ~4560) do not provide `LaunchWatchService` to `HostThreadsMcpService`.

## Decisions

- **W1 (fix 1).** The watch passes the question ids it already reported for the followed run as `ignoreRequestIds` (wp3) to both the local `waitForThread` and the remote `goat_thread_wait`, so a wait releases only on a _new_ question or a terminal run. Locally that is always available. Remotely, send `ignoreRequestIds` only when non-empty and only to a remote whose last wait result carried `pendingRequestIds` (a wp3-capable remote); an older remote never releases early, so it needs none. Keep the existing tick timeout as the upper bound. Test: a reported, unanswered question does not cause a second wait call before the tick (Deferred/TestClock-gated counter), locally and remotely.
- **W2 (fix 2).** `QuestionEscalationService` owns local `user_input` questions of threads whose `launcher` is this watch's launcher in this environment. The watch skips `questionWake` for a local target when the request kind is `user_input` and the target thread's `launcher` is `{ threadId: watch.launcherThreadId, environmentId: null }`, and records the key as reported. Approvals and remote targets keep the watch's wake. Test both.
- **W3 (fix 3).** Remote `user_input` `questionWake` text: "Read it with goat_pending_request_read {host, threadId, requestId} and answer with goat_pending_request_respond (same host, reason required) if you can decide, or forward it to the user." Approvals unchanged.
- **W4 (fix 4).** Repair the brace as a commit titled exactly `fixup! feat: record who launched a thread and who answered its questions` (main autosquashes it); provide a `LaunchWatchService` mock where `HostThreadsMcpService` is built in tests.
- **W5 (040 §2 hardening).** Escalation subscription retry: keep `pending` and the worker scope outside the retried effect so a retry does not interrupt healthy workers; retry with capped exponential backoff without a lifetime cap; cap startup sweep fan-out at 16.
- **W6 (instructions).** One sentence fix: questions from launched threads arrive as notifications here and from hosts (launch watch); answer with `goat_pending_request_respond` (with `host` for remote threads). Keep the paragraph short.

## Execution

- Builder: one gpt-6.1-sol implementation child (sole writer) for W1–W6.
- Then main: docs (internals paragraph, user paragraph, 040 seam note), full-branch cross-family review, autosquash, rebase if dev moved, final gate, push.

## Errata from audit q13-wp4-audit-r1 (binding)

- **W1′.** Build the ignore list from the watch's `reportedQuestions` filtered by the `${runId}/` prefix, and pass it to both `waitForThread` (local) and the remote `goat_thread_wait` args. Remote: always send it when non-empty; if the remote refuses with "goat_thread_wait does not take ignoreRequestIds, so nothing ran" (a strict remote without wp3), retry once without it and remember that remote as incapable for this follower (sticky, in memory); such a remote never releases early, so no loop.
- **W2′.** Questions W2 skips are recorded through `recordQuestion` too. Compute ownership in `localStep` from the shell it already reads (`launcher` is on the shell); also treat legacy app-owned delegated children like `QuestionEscalationService` does (reuse its launcher-of rule or export it) so they are not duplicated. W2 lands together with W5.
- **W3′.** Fill concrete values into the remote text (host, threadId, requestId) like the local branch; keep a generic fallback for `kind === null`.
- **W5′.** Cap both fan-out sites at 16: `sweep` and the startup worker forking. Log every subscription failure; re-run the catch-up sweep after each resubscribe.
- **W6′.** `project/tools.ts` (~127) and `orchestrationInstructions.ts` (~32): `notifyOnCompletion:false` / `goat_thread_unwatch` stop run-end and host-outage reports; questions from threads launched here still arrive. Line 16 gains the host clause.
- **Note for 040 seam.** Remote questions arrive as `background_task` notices from the watch, not `kind: "question"`; clients show no question controls for them yet.
