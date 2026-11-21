# 090 — Tools per bot (G15)

**Class:** C4 (permissions). **Severity:** P2. **Depends on:** 050.

## Problem

Every bot sees every MCP server and skill on the machine (`docs/user/goat-bot.md:43`). Orca installs apps per bot (`274_orca/src/renderer/src/components/bots/apps/BotAppsCatalog.tsx:57`). Filtering launch arguments alone is not enough: providers also discover configuration themselves (Cursor merges workspace MCP servers, `packages/provider-cursor/src/server/adapter.ts:1408`), and warm, remote or delegated sessions keep what they started with.

## Change

1. **Contract**: optional `BotProfile.tools: { mcpServers: "all" | string[]; skills: "all" | string[] }` (absent = all); older writers preserve it.
2. **Enforcement where work runs**: a per-adapter capability "can enforce an MCP/skill allowlist". The first slice covers the adapters that can (to be confirmed per adapter in the unit's P: Codex, Claude); a restricted bot launching on an adapter or remote destination that cannot enforce it is refused visibly ("Scout's tool limits can't be applied on Cursor"). A tools change rotates the bot's warm session and refuses new delegated launches until they pick up the new scope.
3. **Clients**: Edit bot → Tools on web/desktop with switches; read-only on mobile.
4. No credentials are created or moved.

## Tests (failing first)

Dispatcher test: a bot without `deploy` launches a worker on an enforcing adapter whose effective config lacks it, and an actual call to it is denied; the same bot on a non-enforcing adapter is refused; profile round-trip keeps `tools` absent when absent.

## Acceptance

Bot A with a tool off cannot call it in its session or its workers, on every destination it can launch on; bot B still can; turning it back on restores it on the next turn.

## Verification floor

Focused tests; `vp run check:changed`; independent review; before merge, a transcript of a denied call.
