# Paper and code: working principles

Status: 2026-11-28. Read with [DESIGN.md](DESIGN.md) and [MOTION.md](MOTION.md).

## 1. Who owns what

| Thing | Source of truth | Where |
|---|---|---|
| How a screen looks (layout, type, color, spacing, copy) | **Paper** | [GOAT 봇 워크스페이스 · 봇 홈 — SSOT](https://app.paper.design/file/01M8GDWPDQSBBWW8RMTG12PGCC) |
| How it moves and responds (motion, clicks, dropdowns, folds) | **Code** | `apps/web` (bot home), `docs/motion/playground.html`, `@goat2/bot-face` |
| Live, clickable version for review | **Published site** | https://goat-si.github.io/goat2-design/ (repo `goat-si/goat2-design`, GitHub Pages only) |
| Provider marks (Codex, Claude, Antigravity, Pi, OpenCode, ...) | **GOAT codebase** | `@goat2/provider-icons`, lifted from goat `origin/dev`. Never redraw them |

One artboard is the SSOT. No v1/v2 artboards side by side: change the one board.
Platform boards (section 7) are not versions: each shows the same screen in another shell and is
built from clones of the SSOT board.

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

- **Never use the Paper MCP.** Edit through the in-page API in the open Paper tab: the app's own
  `MCPHandlers` class run against the editor (`dispatchToolCall(agent, tool, args)`, ~1 ms per call,
  same tool names). Recipe: Aside skill `paper-design` → `references/in-page-api.md`.
- It is not a public API: the chunk name changes per Paper deploy and a reload drops it. Re-attach;
  if it still fails, report it instead of switching to the MCP. Edits sync normally.

## 5. Publishing

- Build: `pnpm --filter @goat2/web exec vite build --base=./`, plus `docs/motion/playground.html`
  as `motion/index.html`, into the `goat-si/goat2-design` repo, then push. GitHub Pages serves it.
- GitHub Pages is the only host. A static site this size is far inside its limits, and it ships
  with a push. Cloudflare Pages was tried and dropped on 2026-11-28 as a duplicate; add a host only
  when the site needs server code or access control (then Cloudflare Access or Workers).
- The site is public. Placeholder data only: no real emails, tokens, hostnames you would not show,
  or client names. Accounts use `you@example.com`. `noindex` stays on.

## 6. Checklist before calling a screen done

- [ ] Paper board updated first; one SSOT board, no duplicates
- [ ] Platform boards (section 7) re-synced after an SSOT change
- [ ] `ssotParts.tsx` regenerated from the latest export
- [ ] Side-by-side screenshot at 1440 × 900 matches
- [ ] Every run shows the real provider chip; versions only in Overview → Runtime
- [ ] Motion and interactions work on the published site; the Paper comment links to it
- [ ] Nothing personal on the public site

## 7. Platforms: one content layer, per-platform shell

Status: 2026-11-28. Boards live on the same Paper page as the SSOT.

Rule: the **content layer is shared** on every platform: bot rows, status words and dots,
provider chips, transcript, run folds, evidence card, decision card, composer, tokens and copy.
Only the **shell** changes: window chrome, status and navigation bars, back affordance, where
actions sit. Change the SSOT board first, then re-sync the platform boards (they are built from
`<x-paper-clone>` of SSOT nodes, so re-clone instead of hand-editing).

| Board | Size | Shell |
|---|---|---|
| 봇 홈 — SSOT | 1440 × 900 | Web, no chrome. Roster 288 · chat · overview 340 |
| 봇 홈 — 사이드바 접힘 | 1440 × 900 | Roster folds to a 72px rail: toggle, search, GOAT, bot avatars with the same status dots, new bot, connect, me. Selected bot = filled tile |
| 봇 홈 — macOS | 1440 × 900 | No title bar. Traffic lights sit at the top of the roster, which runs full height. Window radius 12 |
| 봇 홈 — Windows 11 | 1440 × 900 | 40px Mica title bar: app mark + name left, search center (Ctrl+K), caption buttons 46px right. The roster loses its own search |
| 봇 홈 — Linux (GNOME) | 1440 × 900 | Split libadwaita header bar (46px): roster side has new bot / title / menu; content side has search, centered title + subtitle, Share, inspector toggle, round window controls right. It replaces the chat header and the overview fold button |
| 모바일 iOS — 봇 홈 / 봇 대화 | 390 × 844 | Large title "Bots", search + new bot buttons, list grouped Needs you first, tab bar (Bots, Threads, Machines, Me), home indicator. Chat: back chevron with needs-you badge, centered bot + model, (i) opens the overview as a sheet |
| 모바일 Android — 봇 홈 / 봇 대화 | 412 × 915 | M3: top app bar with search + account avatar, filter chips (All / Needs you / Running), extended FAB "New bot", navigation bar with pill indicator, gesture handle. Chat: back arrow, bot + model left, overflow menu opens the overview |

One model picker (2026-11-28): the runtime/model chip lives only in the composer, on every
platform. The bar under the chat header is gone, and headers show the bot's job and machine, not
the model. Versions stay in Overview → Runtime.

Mobile look (2026-11-28): GOAT Liquid Glass, as on goat-site (`src/styles/glass.css`) and the
app's liquid-glass preset. Monochrome; a dot field (`#F3F3F4`, 1px dots every 18px) sits behind
everything; **glass only on floating chrome**: top nav pills, bottom tab / navigation bar,
composer, filter chips. Recipe: white at 62%, `backdrop-filter: blur(12px) saturate(1.14)`,
edge `inset 0 0 0 1px` ink at 7%, lift `0 10px 32px` ink at 8%. Content (rows, bubbles, evidence,
decision card) stays on opaque white cards. Muse: the home starts with a bot strip where the
avatar ring carries state (red = needs you, dashed ink = working, solid ink = idle / GOAT).

Mobile composer: text, one round provider button (the provider's SVG mark only, no model name,
no chevron; tap opens the runtime picker as a sheet) and send. Nothing else.

Mobile decisions: the decision card is the last item in the transcript, above the floating
composer (thumb zone). Two pill buttons only: Merge (filled ink) and Fix first (tint); "Not
now" is the back gesture. iOS splits them 50/50; Android right-aligns them (Fix first, Merge).
The overview panel never shows inline on mobile (iOS: (i) button, Android: overflow menu).

One mobile build: if only one mobile app ships, it uses this shared layout and swaps only the
shell items in the table above at runtime (bars, back, button order). No separate mobile designs.

Desktop width rules (proposed, same content):

| Window width | Layout |
|---|---|
| 1440 and up | Roster + chat + overview |
| 1100 to 1439 | Rail + chat + overview |
| 700 to 1099 | Rail + chat; overview opens as an overlay |
| below 700 | Mobile layout |
