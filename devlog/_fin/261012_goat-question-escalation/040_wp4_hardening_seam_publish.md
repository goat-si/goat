# 040 — wp4: #5 seam, hardening, review, publication

Depends on wp1–wp3 being implemented and individually verified.

## 1. The #5 seam (D9)

Automatic delivery of a remote thread's question to an origin on another machine needs the #5 reverse channel. On 2026-10-12 `origin/goat/remote-report-delegation` does not exist and the sibling worktree holds only research (`devlog/_plan/261012_remote-report-delegation/001_research.md`). This unit therefore ships every piece that does not need the channel and fixes the contract the channel must satisfy.

What this unit ships for remote launches:

- The remote thread records `launcher: { threadId: <origin thread>, environmentId: <origin env>, via: "ssh_thread_launch" }` (wp3 §3).
- The remote's `goat_pending_request_list({ scope: "launched", launcherThreadId, launcherEnvironmentId })` lists that origin's questions on the remote (wp3 §2), so the origin's `scope:"launched"` fan-out finds them.
- `goat_thread_wait({ host, threadId })` returns as soon as the remote run has a pending question, with `pendingRequestIds` (wp3 §4). An origin agent that waits on its remote thread wakes on the question without sleep-polling.
- `goat_pending_request_read/respond({ host, threadId, requestId })` answers it with provenance (wp3 §1).

Contract the #5 channel must provide for automatic question delivery (no code in this unit):

1. **Addressing.** A remote environment delivers to `(launcher.environmentId, launcher.threadId)`. The origin maps its own `environmentId` to itself; it never trusts a host alias sent by the remote.
2. **Payload.** Exactly the contracts schemas wp2 exports (020 errata E2): `OrchestrationV2QuestionEscalation` with `environmentId` set to the asking (remote) environment, and `OrchestrationV2QuestionResolution`. The origin adds `host` only as a routing hint from the connection the event arrived on.
3. **Delivery on the origin.** The origin feeds a received event into `QuestionEscalationService.deliverRemote(event)`, which uses deterministic ids keyed by environment identity, never alias: `question-escalation:<environmentId>:<threadId>:<requestId>` and `question-resolution:<environmentId>:<threadId>:<requestId>`. Same message/notification shape as local delivery, so dedupe and resolution handling are shared. `deliverRemote` is specified here and added by the #5 work, not this unit.
4. **Direction and replay.** Either push (remote → origin over a report-scoped credential, #5's proposal) or pull (origin drains the remote through `callHostTool`). For pull, the remote tool is `goat_question_events({ launcherThreadId, launcherEnvironmentId, afterSequence: number | null, limit? }) → { events: Array<{ sequence, type: "escalated" | "resolved", escalation?, resolution? }>, nextSequence: number, truncated: boolean }`; `sequence` is the remote event-store sequence of the `runtime-request.updated` that produced the event, so events are ordered and at-least-once. The origin persists `nextSequence` per remote `environmentId` and treats delivery as idempotent via the ids in 3. The remote derives events from its projections plus event store, so retention equals the request rows' lifetime; a cursor older than retained history restarts from `null` and the ids dedupe. For push, the same envelope travels one event per request with the same ids. This unit's `scope:"launched"` list is the non-incremental precursor.
5. **Authority.** A delivered event grants nothing. Answers still go through `goat_pending_request_respond({host})`, which the remote re-judges under the caller's runtime ceiling.

Record this section's contract in the #5 unit when that branch appears on origin: rebase onto it, replace the "not in this unit" lines with the real entry point, and delete nothing else.

### Update after rebase onto the launch watch (#15)

Since `840e58797`, the launch watch follows `goat_ssh_thread_launch` targets over the host's MCP session and queues a notice on the launcher when the remote thread waits on a question, so remote questions of SSH-launched threads already reach the origin by pull, and `goat_pending_request_read/respond({ host })` answers them. What still needs #5: push delivery, the structured `question` notification for remote questions (the watch sends `background_task` notices, so clients show no question controls for them), and questions from delegated children on hosts (#10). The contract above remains the target for that work.

### Alignment with the local #5 branch (read 2026-10-12, not on origin)

The local branch `goat/remote-report-delegation` (`12aebd43f`, `fcaeaab73`, `f0b611ded`; unpushed) adds an origin-pull report channel: the origin binds a remote launch with `RemoteReportBindingInput { correlationId, originLabel, originThreadId, readKeyHash }`, the remote agent posts `goat_origin_report` with kind `progress | completed | failed | needs_input` and a prose summary, and the origin drains it with `goat_origin_reports_wait` (`packages/contracts/src/remoteReports.ts` there). When both branches are on dev:

1. Both add origin data to the remote `goat_thread_launch`: this branch sends `launcher { threadId, environmentId }`, #5 sends the report binding. Keep both; `launcher.threadId` should equal the binding's `originThreadId`.
2. A remote `user_input` request is the `needs_input` case. The structured payload is `OrchestrationV2QuestionEscalation`; #5 can carry it as a runtime-observed `needs_input` report (the remote's `QuestionEscalationService` already builds it for local launchers) instead of relying on the agent's prose.
3. On the origin, a drained `needs_input` report with that payload should go through the same deterministic ids keyed by the remote `environmentId` (§1.3) so it does not duplicate the launch watch's question notice for the same request.
4. Answers still go through `goat_pending_request_respond({ host })`; a report grants no authority, which matches #5's own framing.

## 2. Hardening checklist (run in C of wp4)

| Risk                                                      | Check                                                                                                                                                                     | Activation scenario / observable proof                                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Forged human provenance from a WS client                  | `ws.ts` overwrites `respondedBy`                                                                                                                                          | Unit test in wp1 dispatches a client command with `respondedBy: agent` and asserts the persisted request says `user`.     |
| Agent answering an approval                               | `readQuestion` kind filter + service eligibility                                                                                                                          | wp1/wp2 tests: approval request → respond `invalid_request`; no escalation message.                                       |
| Above-ceiling answer                                      | existing `writesThreads` + `DispatchModeLimit`                                                                                                                            | wp1 test: caller `auto`, target `full-access` → `runtime_mode_escalation_denied` with forward-to-human text.              |
| Double answer                                             | asking-thread lock                                                                                                                                                        | wp1 test: user answers then agent → `invalid_request` "already answered by the user at …".                                |
| Lost escalation across restart                            | startup sweep                                                                                                                                                             | wp2 test: request committed with service stopped; start service; one launcher message.                                    |
| Duplicate escalation                                      | deterministic commandId                                                                                                                                                   | wp2 test: replay the same events twice; one message.                                                                      |
| Wait never returns on blocked child                       | wait release                                                                                                                                                              | wp3 tests for `goat_thread_wait` and `delegate_task(mode:"wait")`.                                                        |
| Old remote drops provenance                               | respond result check                                                                                                                                                      | wp3 test: remote result without `respondedBy` → result carries the documented warning.                                    |
| Performance                                               | service reads one thread per event; sweep is bounded                                                                                                                      | Review: no per-event full-table scans, no client wire growth beyond the optional fields.                                  |
| Retry path of the escalation subscription (wp2 review r2) | Keep `pending` and worker scope outside the retried effect; retry forever with capped backoff (or reset the budget after a successful subscribe); cap sweep fan-out (~16) | Deferred-gated test: a stream failure during a held worker does not interrupt it; repeated faults keep the service alive. |

## 3. Documentation (SoT sync)

- `docs/internals/overview.md` (or the section that owns cross-thread delivery, chosen at wp4 P after re-reading): one paragraph — launcher identity is separate from lineage; questions escalate only within one environment until #5; agent answers carry provenance and never carry approval authority. Link `QuestionEscalationService.ts`.
- `docs/user/`: re-read the pending-question guidance; add one sentence only if a user-visible behaviour (answer provenance line) needs explaining.
- Instruction text is updated in wp3; re-read it here for accuracy after integration.

## 4. Review, rebase, verify, publish

1. Cross-family review of the full branch diff (`git diff origin/dev...HEAD`) by an Anthropic-family reviewer through `delegate_task` (role review) with the original brief, 000 decisions and the C evidence. Fold or rebut every blocker; re-review until no open blocker.
2. `git fetch origin && git rebase origin/dev`. If `goat/mcp-routing-strictness` landed (strict unknown-argument rejection, #7), re-run the MCP tests and check that every new argument is declared on its tool schema.
3. Re-run the verifier set below on the rebased head.
4. `git push origin goat/question-escalation` (branch only). No PR, no merge, no issue comment.

## 5. Verifier set (final gate)

```sh
B=/Users/jun/.goat/worktrees/goat/goat-question-escalation/node_modules/.bin   # append-only: its rg shim is Linux-only
$B/vp test run <every test file added or changed in wp1-wp3>
$B/vp lint <every changed .ts/.tsx file>
(cd packages/contracts && $B/tsc --noEmit)
(cd packages/provider-core && $B/tsc --noEmit)
(cd packages/client-runtime && $B/tsc --noEmit)
(cd apps/server && $B/tsc --noEmit)
(cd apps/web && $B/tsc --noEmit)    # only if web files changed
```

Mobile typecheck runs only if mobile files changed; use the package's own `typecheck` script.
