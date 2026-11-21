# 090 — Tools per bot (G15)

**Class:** C4 (permissions). **Severity:** P2. **Depends on:** 050.

## Problem

Every bot sees every MCP server and skill on the machine (`docs/user/goat-bot.md:43`). Orca installs apps per bot (`274_orca/src/renderer/src/components/bots/apps/BotAppsCatalog.tsx:57`). Filtering launch arguments alone is not enough: providers also discover configuration themselves (Cursor merges workspace MCP servers at launch, `packages/provider-cursor/src/server/adapter.ts:1408`), and warm, running, remote or delegated sessions keep what they started with.

## Change

1. **Contract**: optional `BotProfile.tools: { mcpServers: "all" | string[]; skills: "all" | string[] }`. Absent means all (today's behavior); an empty list means none. Older writers preserve the field; older servers hide the editor.
2. **Enforcement where work runs**: a per-adapter capability "can enforce an MCP/skill allowlist". The first slice covers the adapters that can (confirmed per adapter in the unit's plan; candidates Codex and Claude). A restricted bot launching on an adapter or remote destination that cannot enforce it is refused visibly ("Scout's tool limits can't be applied on Cursor").
3. **Narrowing reaches running work**: narrowing a bot's tools rotates its warm session and **stops its running workers** with a visible "Stopped: Scout's tools changed" and **Retry**, because a started provider process cannot drop tools it already loaded. Widening applies to new launches only.
4. **Clients**: Edit bot → Tools on web/desktop with switches; read-only on mobile.
5. No credentials are created or moved.

## Tests (failing first)

Dispatcher test: a bot without `deploy` launches a worker on an enforcing adapter whose effective config lacks it, and an actual call to it is denied; the same bot on a non-enforcing adapter is refused; narrowing while a worker runs stops that worker with the visible reason; an empty list denies every tool; absent stays absent on round-trip.

## Acceptance

Bot A with a tool off cannot call it in its session or any worker, including one already running when the change was made; bot B still can; turning it back on restores it on the next launch.

## Verification floor

Focused tests; `vp run check:changed`; independent review. Before merge: a transcript of a denied call, and web/desktop and iOS simulator and Android emulator captures of the Tools editor and its read-only view.
