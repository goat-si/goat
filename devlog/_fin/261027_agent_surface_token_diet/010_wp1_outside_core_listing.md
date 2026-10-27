# wp1: outside clients ask for the core listing

## Change

MODIFY [skills/goat-mcp/SKILL.md](../../../skills/goat-mcp/SKILL.md), step 3:

- Intro paragraph: each entry also sends `x-goat-tool-listing: core`, so the client lists only
  `goat_describe` and `goat_call` and reaches every other tool through them; tools stay callable by
  name; leave the header out to list every tool.
- Claude Code: `claude mcp add --transport http goat <url> --header "x-goat-tool-listing: core"`;
  add-json `headers` gains `"x-goat-tool-listing":"core"`.
- Codex CLI: `config.toml` gains `http_headers = { "x-goat-tool-listing" = "core" }`; say that
  `codex mcp add --url` has no header flag, so add the line after `codex mcp add`.
- Cursor, VS Code, OpenCode `headers`: add the key. OpenCode OAuth note: keep `headers` with only
  the listing header when signing in.
- Gemini CLI: second `--header 'x-goat-tool-listing: core'`.
- mcp-remote args: `"--header", "x-goat-tool-listing:core"`.
- "Any other HTTP client": send the header on every request for the small listing.
- ChatGPT and hosted APIs cannot set it; no change.

REGENERATE `apps/server/src/cli/mcpClientSkill.ts` with
`node apps/server/scripts/sync-mcp-client-skill.ts` after `vp fmt`.

MODIFY [docs/user/outside-agents.md](../../../docs/user/outside-agents.md): the OAuth commands and
token table carry the header the same way, with one sentence on what it does.

Left as is: the **Settings → Connections → Copy MCP URL** toast suggests a bare
`claude mcp add` (`ConnectionEnvironmentsSection.tsx`). Claude Code already defers MCP tools
through its own tool search, so that path loses little, and changing it would make this a UI
change. The guide it points to carries the header.

## Proof

- `vp test run apps/server/src/cli/mcpClientSkill.test.ts apps/server/src/mcp/toolListing.test.ts`
  (bundled copy equals the skill; header behavior).
- `node scripts/agent-surface/context-budget.ts` reports the outside core client at 2,226 B
  against 210,728 B without the header.
- Behavior: no server code changes; the header only filters `tools/list`
  ([toolListing.ts](../../../apps/server/src/mcp/toolListing.ts)), calls never read it.
