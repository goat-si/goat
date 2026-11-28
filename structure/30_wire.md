# 30 Wire

## Host ↔ UI — `crates/goat2-contracts/src/subscribe.rs`
WebSocket on 127.0.0.1 with a token. JSON frames, `type` tag, camelCase fields.

| Client → host | |
|---|---|
| `subscribe_cards {subId, after?: CardCursor}` | card list, rail counts, inbox |
| `subscribe_thread {subId, threadId, after?: ThreadCursor}` | replay → `thread_caught_up` → live |
| `read_page {reqId, threadId, before, limit}` | scroll up |
| `resync_item {subId, itemId}` | offset mismatch on streamed text |
| `unsubscribe`, `pong` | |
| `send_input {threadId, text, mode, attachments?}` | command |
| `start_thread {kind, title?, botId?, parent?, modelSelection, cwd?, text?, mode?: async\|wait}` | command |
| `stop_thread`, `resume_queue {threadId}` | command (next user send also releases a hold) |
| `resolve_request {threadId, requestId, outcome, text?, answers?}` | command; unknown runs: kind `resend`, outcome `resend\|dropped` |
| `archive_thread`, `rename_thread`, `create_bot {name, purpose, face, modelSelection}` | command |
| `edit_queued`, `cancel_queued`, `reorder_queued {threadId, inputIds}`, `promote_to_steer` | command, only while the input is queued → `input.changed` (v1 queue parity) |
| `change_thread {threadId, modelSelection?, runtimeMode?, followUpMode?}` | command → `thread.changed`, from the next run |
| request kind `decision` | `request.opened` with options `{id, label, consequence?}`; answered by `resolve_request {optionId}`; silence never approves |
| every command: `reqId` + `clientRequestId` | host dedupes: same id + same args → first `command_result` again, no new line; same id + other args → `idempotency_conflict`; a deduplicated reply carries the current frame's `reqId` with the first result; `input.accepted` stores the id so it survives restarts |

| Host → client | |
|---|---|
| `cards_reset {reason, epoch}`, `card_changed`, `card_removed`, `cards_caught_up` | |
| `thread_reset {reason, epoch}`, `thread_event {line}`, `thread_caught_up`, `page` | |
| `text_append {itemId, offset (UTF-16), text}` | live text only, never stored |
| `command_result {reqId, ok, value?, error?}` | the one reply to every command; `error` is v1 `AgentSurfaceError` shape (code `not_found|conflict|permission_denied|failed_precondition|resource_exhausted|internal`, `reason` = domain code like `thread_not_found`, `idempotency_conflict`, `child_budget`) |
| `bot_changed {bot: BotProfile}`, `bot_removed` | on the cards stream |
| `error` | |

Reset reasons: `epoch_changed | invalid_cursor | thread_missing | too_far_behind` (128 events / 1 MiB).

## Agent → host: MCP — PRD `part1/mcp.md`
HTTP on 127.0.0.1, `rmcp`, GOAT v1 agent-surface shape: listing shows `goat_describe` + `goat_call`;
result `ok | error | needs_human`. Token per (thread, process generation); caller = the thread's
active run at call time. 11 paths: `surface.describe`, `surface.call`, `thread.start|send|read|list|wait|stop`,
`thread.report_result` (worker → parent `child.reported`, v1), `user.send`, `request.ask` (with options = decision). Deferred: `thread.watch`, agent `queue.*`. `thread.start` takes `mode: async|wait` (default async, v1 semantics: Stop stops wait-mode children only).

## Host → engine
| Engine | Protocol | Where |
|---|---|---|
| Codex | app-server JSON-RPC over stdio, pinned schema `crates/goat2-engine-codex/schema/codex-0.167.0/` | B |
| Claude (Part 2) | `claude` CLI stream-json control protocol (spec in `docs/parity/`) | D → later |
| ACP (Part 2) | Zed `agent-client-protocol` crate | later |

Steer/turn result from a driver: `Accepted | Declined | RefusedUnowned | Unknown` → `input.delivered` outcome `accepted | declined | refused | unknown` (`refused` fails closed: the input leaves the queue).

Cards stream after a deletion: a reconnecting `subscribe_cards` whose cursor predates any card deletion gets `cards_reset` (no tombstones in Part 1).

## UI outbox (send-first)
Renderer keeps an outbox keyed by `clientRequestId` (persisted): shows at once, sent once when the socket is up.
No `command_result` before a drop → "Not confirmed" with Resend / Delete; never auto-resend.
