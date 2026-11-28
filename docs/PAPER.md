# Paper and code: working principles

Status: 2026-11-28. Read with [DESIGN.md](DESIGN.md) and [MOTION.md](MOTION.md).

## 1. Who owns what

| Thing | Source of truth | Where |
|---|---|---|
| How a screen looks (layout, type, color, spacing, copy) | **Paper** | [GOAT 봇 워크스페이스 · 봇 홈 — SSOT](https://app.paper.design/file/01M8GDWPDQSBBWW8RMTG12PGCC) |
| How it moves and responds (motion, clicks, dropdowns, folds) | **Code** | `apps/web` (bot home), `docs/motion/playground.html`, `@goat2/bot-face` |
| Live, clickable version for review | **Published site** | https://goat-si.github.io/goat2-design/ (repo `goat-si/goat2-design`; mirror `goat2-design.pages.dev`) |
| Provider marks (Codex, Claude, Antigravity, Pi, OpenCode, ...) | **GOAT codebase** | `@goat2/provider-icons`, lifted from goat `origin/dev`. Never redraw them |

One artboard is the SSOT. No v1/v2 artboards side by side: change the one board.

## 2. What Paper can and cannot do (checked on the file, 2026-11-28)

- **No layer animation.** CSS `animation*` set on a node is accepted and then dropped. Shaders and
  video export exist, but they do not animate our layers.
- **No prototyping.** No click areas, links between frames or present mode.
- **No hyperlinks on the canvas.** `<a href>` keeps the text and underline but loses the URL.
- **Comment links are clickable.** So the live links live in **one comment pinned on the SSOT
  board**, next to the runtime chip. Update that comment when the URLs change; do not add a
  separate "links" board.
- Draw states as frames when a reviewer needs to see them still (dropdown open, the 7 bot moods).
  The moving version is the published site.

## 3. Paper → code, 1:1

1. Change Paper first. Code follows the board, not the other way round.
2. Export the board: Paper `get_jsx` on the SSOT artboard with `includeNodeIds: false`.
3. Generate the static parts: `scripts/paper-to-parts.py <export.jsx> > apps/web/src/bot-home/ssotParts.tsx`.
   That file is generated. Do not edit it by hand. When the board's structure changes, fix the
   line ranges in the script.
4. Interactive pieces (`BotHome.tsx`, `RuntimePicker.tsx`) copy their style values from the same
   export: sizes, colors, radii, fonts. No new values that are not on the board.
5. Visual check at 1440 × 900: Paper screenshot of the artboard next to a browser screenshot of
   `apps/web`. Differences other than placeholder data are bugs.
6. Fonts: `apps/web/index.html` loads Inter and Geist Mono, the same families the board uses.
7. Copy is English by default (DESIGN.md). Korean stays a fallback font only.

## 4. Editing Paper from an agent

- The Paper MCP works but is slow (seconds per call through Paper's server). Read
  `get_guide("paper-mcp-instructions")` once per session.
- Faster path used on 2026-11-28: in the open Paper tab, the app's own `MCPHandlers` class runs the
  same tools on the editor directly (`dispatchToolCall(agent, tool, args)`, about 1 ms per call).
  It is not a public API: the chunk name changes per Paper deploy and a reload drops it, so
  re-attach after a reload and fall back to the MCP when it breaks. Edits still sync normally.
- When searching for MCP tools, raise the result limit. A default search returns 8 tools and
  hides the rest.

## 5. Publishing

- Build: `pnpm --filter @goat2/web exec vite build --base=./`, plus `docs/motion/playground.html`
  as `motion/index.html`, into the `goat-si/goat2-design` repo, then push. GitHub Pages serves it.
- Static hosting has no request or bandwidth limit on GitHub Pages or Cloudflare Pages for this
  size. Only builds and file counts are capped.
- The site is public. Placeholder data only: no real emails, tokens, hostnames you would not show,
  or client names. Accounts use `you@example.com`. `noindex` stays on.

## 6. Checklist before calling a screen done

- [ ] Paper board updated first; one SSOT board, no duplicates
- [ ] `ssotParts.tsx` regenerated from the latest export
- [ ] Side-by-side screenshot at 1440 × 900 matches
- [ ] Every run shows the real provider chip; versions only in Overview → Runtime
- [ ] Motion and interactions work on the published site; the Paper comment links to it
- [ ] Nothing personal on the public site
