# GOAT v1 behaviour parity (lane D)

This folder is the written contract GOAT 2 must meet to behave like GOAT v1 for running-message
handling, queues, child threads, restart and the agent thread tools. Each rule cites the v1 code that
implements it, and the scenarios in `crates/goat2-parity` check the same behaviour by running recorded
Codex sessions against v1 now and against GOAT 2 once the host exists. The Claude protocol notes are
research for Part 2.

## Pinned sources

| Root | What | Ref prefix |
|---|---|---|
| goat-si/goat `916b5ccc1b2b6d4ecd991ab1573172bab8fb1cc4` (origin/dev, 2026-11-28) | v1 behaviour reference | none: `apps/server/...:N` |
| claude-agent-sdk-python `6c1b03f` (v0.2.189) | Python Agent SDK | `claude-agent-sdk-python/<path>:N` |
| @anthropic-ai/claude-agent-sdk 0.3.276 (v1 lockfile) | TypeScript Agent SDK | `@anthropic-ai/claude-agent-sdk@0.3.276/<file>:N` |
| goat-si/goat2-design main | Part 1 PRD and decisions | `goat2-design/<path>:N` |
| this branch | GOAT 2 contracts, structure | `goat2/<path>:N` |

v1 is pinned at the commit the Part 1 MCP page already cites, which is newer than the lifted-code pin in
`docs/PROVENANCE.md` (437f5b9d). The checker reads an export made with `git archive 916b5ccc...`; the
export has no `.git`, so its identity rests on how it was made, not on a runtime check.

## Documents

| File | Covers |
|---|---|
| [follow-up-modes.md](follow-up-modes.md) | messages that arrive while a run is active: steer, queue, interrupt, refusal, provider decline |
| [queue.md](queue.md) | queued messages and queue edit / cancel / reorder / promote_to_steer |
| [thread-tools.md](thread-tools.md) | MCP thread.send / wait / watch / unwatch / watch_list / report_result |
| [child-wake.md](child-wake.md) | how a parent is woken by a child's result, question or failure |
| [restart-settlement.md](restart-settlement.md) | what happens to in-flight work across a server restart |
| [claude-stream-json.md](claude-stream-json.md) | Claude CLI stream-json control protocol (Part 2 research) |

## How refs are written and checked

One backticked ref per citation, written as a path from its root, a colon and a line number or range
(comma lists allowed), with the prefixes above. Bare file names and absolute paths are not refs and fail
the check. `goat2-parity check-refs`
(wp2) and the standalone checker used before it fail on a missing file, a line past the end, a path
escaping its root, a malformed ref, a missing root, or a document with no refs. A ref that resolves is
not proof that the code supports the sentence; reviewers check that separately (see each file's ledger
notes in the lane report).

## Trace vocabulary

Scenarios compare these semantic events per thread. Kinds and fields are defined in
`crates/goat2-parity/src/trace.rs` (wp2); the evidence column says what a target must observe before it
may emit the event.

| Kind | Fields | v1 evidence | GOAT 2 evidence |
|---|---|---|---|
| input.accepted | thread, input, from, mode, text? | successful dispatch receipt + message id | log `input.accepted` |
| input.refused | thread, input, code | command / MCP error at the call | `command_result` error or MCP envelope error |
| queue.changed | thread, input, op, text?, position? | run/message queue field changes | log `input.changed` for edited / reordered / promoted / cancelled (`goat2/crates/goat2-contracts/src/log.rs:234-255`); enqueued has no GOAT 2 evidence and stays pending |
| run.started / run.finished | thread, run, inputs / status, cause? | run status transitions | log `run.started` / `run.finished` |
| steer.applied | thread, run, input | provider acceptance of the steer, proven against the decline case | log `input.delivered {as: steer, outcome: accepted}` |
| child.started / child.reported | thread, child, status | subagent / delegated task records | log `child.started` / `child.reported` |
| parent.woken | thread, child, wake, state, run? | wake run created queued / running / delivered as steer / cancelled | started: `run.started` with the child input; steered: `input.delivered`; queued and cancelled pending |
| tool.result | thread, call, path, status, code? | MCP toolkit response | MCP envelope |
| host.restarted | thread | runner rebuilt the server layer | harness marker |

## Where GOAT 2 differs or defers (owner decisions, 2026-11-28)

| Topic | v1 | GOAT 2 Part 1 | Source |
|---|---|---|---|
| Steer declined after admission | same message id re-dispatched (queue_after_active for child results, notifications and tagged declines; start_immediately for an ordinary missed steer), `apps/server/src/orchestration-v2/EffectWorker.ts:310-360` | same as v1 | `goat2-design/prd-src/decisions.md:69` |
| Interrupt while children run | Stop holds the queue, stops wait-mode children, async children continue | same as v1, no demotion | same |
| Restart with a run in flight | run `cancelled` with `server_restart` | `interrupted` (engine accepted or items exist) / `unknown` (nothing seen), never auto-resent | same; deliberate difference |
| Queue edit / cancel / reorder / promote | UI and MCP | UI commands + log `input.changed`; MCP queue.* deferred | owner answer E1 |
| thread.watch / unwatch / watch_list | MCP | deferred | owner answer E1 |
| thread.report_result | MCP | MCP, outcome succeeded / failed / blocked / cancelled + summary -> parent `child.reported` | owner answer E1 |
| Codex turn/steer RPC error | wrapped as ProviderAdapterSteerRunError, not re-queued | pending: outcome fixed by scenario steer_rpc_error_codex | follow-up-modes.md |

## Coverage

M = recorded scenario that must pass on v1; S = source-only, reviewed. Status is "planned" until the v1
runner (wp3) reports it.

| Requirement | Coverage | Status |
|---|---|---|
| follow-up modes | followup_queued_in_order, live_steer_applied, interrupt_ack_then_terminal (M) | planned |
| refusal at admission | steer_refused_at_admission (M) | planned |
| declined / missed steer re-dispatch | steer_missed_becomes_followup (M); tagged decline (S, Cursor-only in v1) | planned |
| Codex turn/steer RPC error | steer_rpc_error_codex (M) | planned |
| Stop with children, no demotion | S | reviewed in wp1 |
| child wake | child_wake_delegated (M) | planned |
| restart settlement | restart_idle_resume, restart_active_run_settles (M) | planned |
| thread.send / wait | thread_tools_send_wait (M) | planned |
| thread.watch | thread_watch_wake (M on v1; GOAT 2 deferred) | planned |
| thread.report_result | thread_report_result (M) | planned |
| queue edit / promote / cancel | queue_edit_then_start, queue_promote_to_steer, queue_cancel_while_active (M) | planned |
| queue reorder | S | reviewed in wp1 |
| Claude stream-json subtypes | claude-stream-json.md (S, Part 2) | reviewed in wp1 |

## Topic index

Each lane topic and each requested Claude subtype, with the section that specifies it. wp1 C checks that
every anchor resolves and that each section carries refs that pass the checker.

| Topic | Section |
|---|---|
| follow-up modes (steer, queue, start, separate turn) | [follow-up-modes.md#rules](follow-up-modes.md#rules) |
| steer refusal at admission (fail closed) | [follow-up-modes.md#r10-policy-refusal-is-not-provider-decline](follow-up-modes.md#r10-policy-refusal-is-not-provider-decline) |
| refusal and decline after admission | [follow-up-modes.md#r11-delivery-refusal-after-admission](follow-up-modes.md#r11-delivery-refusal-after-admission) |
| same-id re-dispatch of a declined steer | [follow-up-modes.md#r12-explicit-provider-decline-queues-a-follow-up](follow-up-modes.md#r12-explicit-provider-decline-queues-a-follow-up) |
| missed delivery (turn already ended) | [follow-up-modes.md#r13-missed-delivery-and-retries-are-separately-classified](follow-up-modes.md#r13-missed-delivery-and-retries-are-separately-classified) |
| interrupt | [follow-up-modes.md#r16-interrupt-acknowledgement-is-not-terminal](follow-up-modes.md#r16-interrupt-acknowledgement-is-not-terminal) |
| Stop with children (no demotion) | [follow-up-modes.md#r17-explicit-stop-and-child-work](follow-up-modes.md#r17-explicit-stop-and-child-work) |
| queue edit / cancel / reorder / promote_to_steer | [queue.md#rules](queue.md#rules) |
| thread.send / wait / watch / unwatch / watch_list / report_result | [thread-tools.md#rules](thread-tools.md#rules) |
| child wake | [child-wake.md#rules](child-wake.md#rules) |
| restart settlement | [restart-settlement.md#rules](restart-settlement.md#rules) |
| Claude initialize | [claude-stream-json.md#initialize](claude-stream-json.md#initialize) |
| Claude interrupt | [claude-stream-json.md#interrupt](claude-stream-json.md#interrupt) |
| Claude can_use_tool | [claude-stream-json.md#can_use_tool](claude-stream-json.md#can_use_tool) |
| Claude hook_callback | [claude-stream-json.md#hook_callback](claude-stream-json.md#hook_callback) |
| Claude mcp_message | [claude-stream-json.md#mcp_message](claude-stream-json.md#mcp_message) |
| Claude set_model | [claude-stream-json.md#set_model](claude-stream-json.md#set_model) |
| Claude set_permission_mode | [claude-stream-json.md#set_permission_mode](claude-stream-json.md#set_permission_mode) |
| Claude task_started | [claude-stream-json.md#task_started](claude-stream-json.md#task_started) |
| Claude task_updated / task_progress | [claude-stream-json.md#task_updated-and-task_progress](claude-stream-json.md#task_updated-and-task_progress) |
| Claude task_notification | [claude-stream-json.md#task_notification](claude-stream-json.md#task_notification) |
| Claude transcript_mirror | [claude-stream-json.md#transcript_mirror](claude-stream-json.md#transcript_mirror) |

