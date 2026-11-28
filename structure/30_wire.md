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
| **commands (send input, start thread, stop, resolve request)** | **missing — see 90_gaps** |

| Host → client | |
|---|---|
| `cards_reset {reason, epoch}`, `card_changed`, `card_removed`, `cards_caught_up` | |
| `thread_reset {reason, epoch}`, `thread_event {line}`, `thread_caught_up`, `page` | |
| `text_append {itemId, offset (UTF-16), text}` | live text only, never stored |
| `error` | |

Reset reasons: `epoch_changed | invalid_cursor | thread_missing | too_far_behind` (128 events / 1 MiB).

## Agent → host: MCP — PRD `part1/mcp.md`
HTTP on 127.0.0.1, `rmcp`, GOAT v1 agent-surface shape: listing shows `goat_describe` + `goat_call`;
result `ok | error | needs_human`. Token per (thread, process generation); caller = the thread's
active run at call time. 10 paths: `surface.describe`, `surface.call`, `thread.start|send|read|list|wait|stop`,
`user.send`, `request.ask`.

## Host → engine
| Engine | Protocol | Where |
|---|---|---|
| Codex | app-server JSON-RPC over stdio, pinned schema `crates/goat2-engine-codex/schema/codex-0.167.0/` | B |
| Claude (Part 2) | `claude` CLI stream-json control protocol (spec in `docs/parity/`) | D → later |
| ACP (Part 2) | Zed `agent-client-protocol` crate | later |

Steer/turn result from a driver: `Accepted | Declined | RefusedUnowned | Unknown` → `input.delivered`.
