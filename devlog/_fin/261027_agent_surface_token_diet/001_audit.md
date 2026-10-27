# Roadmap audit

An independent sol auditor read 000 to 040 against source on 2026-10-27.

Verdict: NEAR-PASS.

1. Settings → Connections → Copy MCP URL suggests a bare `claude mcp add`
   (`apps/web/src/components/settings/ConnectionEnvironmentsSection.tsx`). Rebutted: Claude Code
   defers MCP tools through its tool search, so this path loses little, and the change would turn
   this into a UI pull request. Recorded in [010](./010_wp1_outside_core_listing.md).
2. wp3 proof did not check relative links. Folded into [030](./030_wp3_devlog_fin.md).

Confirmed without change: the header filters `tools/list` only and calls bypass it
(`apps/server/src/mcp/toolListing.ts`); the outside core listing holds `goat_describe` and
`goat_call` (`toolListing.test.ts`); computer use rules stay resident; outside clients keep the
full listing without the header (D22).

`toolListing.test.ts` fails six cases on this machine at dev `61343d617e` before any change:
it expects `goat_screen_run` in listings that do not carry it here. Recorded as pre-existing.
