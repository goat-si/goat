# 2026-10-27: computer use over MCP

Decisions from the session that merged #1799, #1798, #1801 and #1803. The pull requests record
the changes; this keeps the reasons that span them.

- `computer_use.update` is client-only so no GOAT thread can widen its own grant. `settings:write`
  is checked before Cua Driver admission and again inside the settings write lock, because
  admission can install the driver and a client revoked meanwhile must not commit. Review found
  that race; `apps/server/src/mcp/toolkits/computerUse/handlers.test.ts` holds it.
- Remote hosts are reached by connecting to their own `/mcp`. Routing the toggle through an
  origin's SSH dispatch was left out: that session's `settings:write` is reserved for fleet sync.
- Devin's #1795/#1796 stack could not leave its squash-merged base (#1788), so its commits landed
  as #1798 and #1801 and the stack was closed.
- MCP lazy-load guidance (Aside memory, 2026-10-23) was checked against the served catalog:
  descriptions stay under 400 characters, two tools are resident, and the order is stable. The one
  gap is Codex compacting input schemas over 5,000 bytes, which only the two launch tools exceed
  and only in the full listing; `scripts/agent-surface/context-budget.ts` names them.
