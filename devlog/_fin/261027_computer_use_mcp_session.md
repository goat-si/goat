# 2026-10-27 session: computer use over MCP and pull request cleanup

**Status: done.** Closed with the session wrap-up pull request.

## What shipped

| PR      | Change                                                                                                                                                   |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1799   | Outside MCP clients are told to send `x-goat-tool-listing: core`; stale agent-surface docs and the audit generator fixed; finished plan units moved here |
| #1798   | macOS helper spawn arguments typed before C-string conversion, with a `swiftc -typecheck` test                                                           |
| #1801   | Screen primitive authority shared with providers and requests (Devin's #1796, moved off its stack)                                                       |
| #1803   | `computer_use.update`: an outside MCP client holding `settings:write` turns computer use on or off                                                       |
| wrap-up | Listing tests that expected `goat_screen_run` without a screen surface fixed; the budget script names input schemas Codex compacts                       |

#1795 and #1796 were closed: their base (#1788) had been squash-merged and a stacked pull request
cannot change its base. #1800 stayed with its owner; its own `build-desktop-artifact` test fails.

## Decisions worth keeping

- `computer_use.update` is client-only so no GOAT thread can widen its own grant. `settings:write`
  is checked before Cua Driver admission and again inside the settings write lock, because
  admission can install the driver and a client revoked meanwhile must not commit. Review found
  that race; `handlers.test.ts` holds it.
- Remote hosts are reached by connecting to their own `/mcp`. Routing the toggle through an
  origin's SSH dispatch was left out: that session's `settings:write` is reserved for fleet sync.
- MCP lazy-load guidelines (Aside memory, 2026-10-23) were checked against the served catalog:
  descriptions stay under 400 characters, two tools are resident, and the order is stable. The one
  gap is Codex compacting input schemas over 5,000 bytes, which only the two launch tools exceed and
  only in the full listing; `context-budget.ts` now names them.
