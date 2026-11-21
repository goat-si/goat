# 090 — Tools per bot (G15)

**Class:** C4 (permissions). **Severity:** P2. **Depends on:** 050.

## Problem

Every bot sees every MCP server and skill on the machine (`docs/user/goat-bot.md:43`). Orca installs apps per bot (`274_orca/src/renderer/src/components/bots/apps/BotAppsCatalog.tsx:57`). A reviewer bot should not have the deploy tool.

## Change

1. **Contract**: `BotProfile` gains optional `tools: { mcpServers: "all" | string[]; skills: "all" | string[] }` (absent = all, today's behavior).
2. **Server**: the bot session and its workers' launch (`ChannelDispatcher.ts`, `channelWorkerBrief.ts`) pass only the allowed MCP servers and skills to the provider session; a refused tool name is reported in the bot's status note.
3. **Web/desktop**: **Edit bot → Tools** lists the machine's MCP servers and skills with switches; **All tools** is the default.
4. **Mobile**: read-only list in the profile sheet.
5. Credentials are not created or moved: this scopes tools the machine already has.

## Security note

Narrowing only: a bot can never get a tool the machine lacks. Workers inherit the bot's scope; a person's own threads are unaffected.

## Tests (failing first)

- Dispatcher test: a bot limited to `github` launches a worker whose MCP config lacks `deploy`.
- Profile round-trip: absent `tools` stays absent.

## Acceptance

Bot A with a tool turned off cannot call it, in its session or its workers; bot B still can; turning it back on restores it on the next turn.

## Verification floor

Focused tests; `vp run check:changed`; independent review lane.
