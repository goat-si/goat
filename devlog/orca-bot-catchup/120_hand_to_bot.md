# 120 — Hand a thread to a bot (G18)

**Class:** C3. **Severity:** P2. **Depends on:** 020.

## Problem

A bot follows only work it started. Orca can hand an existing worktree with running agents to a bot, which then owns follow-up (`274_orca/src/main/runtime/rpc/methods/bots-take-over.ts:21`). In GOAT, a person who wants a bot to babysit a PR must re-explain it in chat.

## Change

1. Thread menu (web/desktop/mobile) **Hand to bot…** picks a bot and an optional "done means".
2. Server creates a bot task linked to that thread (the existing launch-link records in `ChannelBotThreads.ts`), so the thread shows in the bot's Home and its PR state, questions and ending flow through the bot. The thread keeps running; nothing restarts.
3. Reverse: **Take back** on the task unlinks it; the thread returns to Threads.

## Tests (failing first)

Server: handing a running thread creates one linked task without starting a turn; Take back removes the link. Browser: the thread moves to the bot's Home and back.

## Acceptance

A running thread handed to Scout appears in Scout's Home with its PR; Scout reports its end; Take back restores it.

## Verification floor

Focused tests; `vp run check:changed`; review lane; M3 real-client pass.
