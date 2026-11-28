# 60 Planned surfaces (UI shell now, backend later)

Rule (owner, 2026-11-28): every surface the Paper boards show is built in the UI now. If its backend is
not in Part 1, or its exact behaviour is not decided, the UI ships a **shell**: real layout from the
board, controls disabled, a small `Planned` tag (tooltip: one line on what it will do + "not built yet"),
no fake data pretending to work. One shared component (`apps/web/src/planned/Planned.tsx`) and one
registry (`apps/web/src/planned/registry.ts`, ids below) so a shell is found and removed in one place.

States: `live` = backed by the host in Part 1 · `planned` = decided, built later · `undecided` = exact
behaviour still open (shell only, no behaviour guessed).

| id | Surface (board) | State | Backend / decision |
|---|---|---|---|
| `bot-chat` | Bot chat, composer, send-first (2R-1, 12P-1) | live | host + Codex |
| `queued-inputs` | Queued messages banner above the composer (1MFK-1) | live | `edit_queued`, `cancel_queued`, `reorder_queued`, `promote_to_steer`, `resume_queue` (pending lane C) |
| `worker-threads` | Right panel → Threads, open thread view (25D-0, C2Y-0) | live | host `thread.start` / child wake |
| `thread-list` | Thread mode first entry, cached rows (LXD-0) | live | `subscribe_cards` |
| `rail-add-bot` | Rail "…" → search, add bot to rail (1KL4-1) | live (local) | rail list in `ui-state.json`; cross-device sync planned |
| `pinned-bots` | Pinned tiles, drag to pin/reorder (1FKW-0) | live (local) | same; sync planned |
| `new-bot` | New bot face picker (2PU-1) | live if lane C/E add a create-bot command, else planned | gap #1 in 90_gaps |
| `runtime-picker-codex` | Runtime picker: Codex models | live | new threads via `start_thread`; existing threads via `change_thread` (pending lane C) |
| `runtime-picker-other` | Runtime picker: Claude, ACP agents, others | planned | Part 2 drivers |
| `inbox` | Rail Inbox and its views (I1–I4) | planned | request feed format undecided |
| `multiplexer` | Thread mode 2×2 / 1+2 panes (T2, T3) | planned | roadmap 5 |
| `library-memory` | Library → Memory file viewer (MEM1–3) | undecided | forget policy and size cap open |
| `machines` | Machine picker / remote machines | planned | roadmap R; relay design separate |
| `archive-tiers` | Archive / restore from remote | undecided | archive location open |
| `decision-cards` | Bot decision card (Merge / Fix first / Not now) | live | RequestKind `decision` with options, `resolve_request {optionId}` (v1 decision parity; pending lane C) |
| `bot-reply-modes` | Ack-then-report vs answer-and-done (`send_to_user`) | undecided | PRD bot-reply proposal |
| `search` | Search across threads | planned | index is derived, not in Part 1 |
| `settings-accounts` | Accounts, providers, sign-in | planned | |
| `terminal-lens` | Pane terminal lens / open in TUI | planned | herdr-core |
| `mobile` | Mobile app | planned | not in desktop Part 1 |
| `activity` | Rail pulse / activity view | planned | |
| `usage` | Rail usage chart | planned | |
| `pull-requests` | Rail git / PR view | planned | |
| `routines` | Rail calendar, Overview Routines rows/toggles | planned | |
| `notifications` | Title-bar bell + count | planned | |
| `share` | Title-bar share | planned | |
| `attachments` | Composer + (files, images) | planned | host turns >64 KB text into blobs already |
| `voice` | Composer mic | planned | |
| `thread-filters` | Thread list filter, new folder | planned | |
| `bot-settings` | Overview edit pencil | planned | |

When a surface goes live: flip its row here (owner), remove its registry entry, delete the shell.

Board mapping (lane F): Library tab → `library-memory`; split/grid icon → `multiplexer`; chat/terminal lens → `terminal-lens`; Machines rows + asleep card → `machines`; search field and rail search → `search`; settings gear → `settings-accounts`.
