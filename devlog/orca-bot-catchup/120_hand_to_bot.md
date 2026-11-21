# 120 — A bot follows a thread (G18)

**Class:** C4 (wire contract, authority over another thread). **Severity:** P2. **Depends on:** 020.

## Problem

A bot follows only work it launched; its threads view reads launch records and reconciles results by launcher and generation (`apps/server/src/channels/ChannelBotThreads.ts:198`, `channelLaunchedResults.ts:124`). Orca can hand a running worktree to a bot (`274_orca/src/main/runtime/rpc/methods/bots-take-over.ts:21`). In GOAT, asking a bot to babysit a PR means re-explaining it in chat.

## Change

1. **Follow relationship**: a guarded record keyed by environment and thread linking it to a bot task (with an optional Done means), separate from launch provenance. The thread keeps running and stays visible in Threads; nothing restarts or changes owner.
2. **What the bot gets**: observation of the thread's status, PR and ending, reported in its chat. Answering the thread's questions stays with people unless the person already could through the bot's normal approval path.
3. **Clients**: thread menu **Ask a bot to follow…** (web/desktop/mobile); the bot's Home shows followed threads; **Stop following** removes future observation and routing.
4. Ownership transfer is a separate decision, not in this unit.

## Tests (failing first)

A second handoff of the same thread to the same bot is a no-op; a terminal event racing the handoff is reported once; losing access to the thread ends the follow with a visible note; Stop following leaves the thread untouched.

## Acceptance

A running thread followed by Scout appears in Scout's Home with its PR; Scout reports its end; Stop following removes it from Home only.

## Verification floor

Focused tests; `vp run check:changed`; independent review. Before merge: web/desktop and iOS simulator captures of the thread menu and the followed thread in Home.
