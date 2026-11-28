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
3. Generate the static parts: `scripts/paper-parts.py design/paper/part1 > apps/web/src/paper/parts.tsx` (the generator and its part list, PARTS, are one file).
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
- [ ] `apps/web/src/paper/parts.tsx` regenerated from the latest export (`scripts/paper-parts.py`)
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

Chat shows chat and decisions only (2026-11-28): no run folds, worker-thread rows, evidence
cards or sub-runs in the transcript, on any platform. Threads open in the right panel only. State
board: `봇 홈 — 스레드 열림 (state)` (Overview replaced by the open thread). On mobile the thread
opens from (i) / overflow as a sheet.

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

Pinned bots (2026-11-28, from Grok Bot's "Pinned Bots", seen in 0.75.5 and 1.3.0): desktop shows
pinned bots as face tiles under the search field (77x80, three per row) and drops them from the
flat Bots list; dragging a row onto the tiles pins it, dragging a tile back or Unpin removes it,
tiles reorder by drag. Empty state appears only while dragging: "Drag here to pin". The collapsed
rail shows only the main bot by default; other bots are added from the rail's "…" (right above the
divider) through search, never by pinning. Clicking the main bot opens its chat and switches the
second sidebar to the bot sidebar.

Mobile bot home (2026-11-28, Ovis mobile + Muse + Grok Bot): top row is account (left) and + new
bot (right), round glass buttons. Below, pinned bots as big faces, three per row (GOAT carries a
star badge), then the flat list (Needs you, Bots). The bottom is Muse's launch-version floating
card, always fixed and never a drop target: a composer row ("Message GOAT", + on the left, round
provider button on the right) over an icon-only tab bar: Bots, Threads, Inbox, Library (selected
tab = grey pill, Inbox unread = blue dot). Threads live in the Threads tab. Pinning on mobile:
long-press a row to lift it; the pinned area tints grey and shows a dashed "Drop to pin" slot;
release there to pin. Long-press without dragging opens Pin / Unpin. Faces reorder by drag.
Mobile lazy load: draw cached pinned bots, list and last previews at once; sync in the background
with a small "Updating" in the header and grey bars for previews not yet received; a bot chat
loads one recent page and older pages on scroll up; the thread list loads when the Threads tab
opens and a thread's body loads when it opens; sent messages show at once, results arrive later.
Boards: "봇 홈 — 봇 고정 (드래그해서 핀)", "모바일 iOS — 봇 고정 (꾹 눌러 위로)", "모바일 iOS — 콜드 스타트 (lazy load)".

Mobile multiplexer (2026-11-28, from Ovis `devswha/ovis` DESIGN.md, Shell and Tab strip
sections): up to 768pt wide a split shows one pane at a time, full size and borderless, like a
zoomed pane; no cards, no inner frames. Header is one glass line (Ovis `--header-h` 52): back,
the pane title with a chevron (tap opens the pane overview, X2), a lens button (chat <-> terminal, outlined 44), and More. Swipe left/right moves
between panes; a small dot row above the composer shows position. Chat lens keeps the floating
composer only (the Muse tab card hides inside a thread). Terminal lens swaps the composer for the
48pt key bar (esc tab ctrl arrows / | ~). From 769pt the split draws again: panes side by side,
a 1px rule inside an 8pt drag band, each pane with a 30pt bar; focus = 2px blue top edge; the
composer sits under the focused pane only.
Foldables: iPhone Duo outer 466x678pt (5.4", 1398x2034px @3x) is one pane with controls on the
side, per Apple's HIG "Designing for iPhone Duo" (tab bars and toolbars move to the side, by the
corner camera); inner 890x626pt (2670x1878px) is two panes side by side with the side controls
kept; when half folded the hinge is the pane boundary (ReservedRegion), never through a pane.
Galaxy Z Fold8 cover ~475x751dp is the phone layout; inner ~933x704dp (4:3) uses a navigation
rail and 1+2 panes (chat left, two terminals stacked right). dp values assume the 420dpi bucket.
State, drafts and the open pane survive fold/unfold; layout only reflows. Boards on the
"모바일 (봇 · 스레드 · 칸)" page: M1, M2, M4 to M7.

Mobile pane switching (2026-11-28, page "모바일 (봇 · 스레드 · 칸)", boards D0, X1 to X5). One pane
order everywhere (the pane list order). Five ways: (1) swipe left/right moves the whole pane,
header and bottom included, 1:1 with the finger, settling in 240ms (velocity over 0.3 commits);
only the status bar and the dot row stay put. (2) Title tap or pinch opens the overview: two
columns of live pane previews (171x250, kind glyph, title, machine, state), current pane ringed in
ink, tap to open, drag to reorder, swipe up to close, floating "New pane"; the current pane
shrinks into its tile in 260ms. (3) A pane that needs you raises a glass banner under the header
(blue dot, pane title, the question, Open); Open jumps there without stopping the pane you were in.
(4) The overview title ▾ switches workspace (menu of workspaces with pane count and state, New
workspace). (5) Fold/unfold keeps the focused pane on the left and adds the next pane on the
right; folding back keeps only the focused pane; drafts, scroll and terminal links survive.
Reduced motion: every transition is a 120ms crossfade. Dials: variance 3, motion 4, density D5.

Mobile flow (2026-11-28, page "모바일 (봇 · 스레드 · 칸)", N0 map, rows A/B). Top level is the
Muse card's four tabs; inside a tab screens push from the right and the left 20pt edge swipe is
Back. Threads tab = GOAT mobile ThreadListV2 as shipped (apps/mobile/src/features/threads/
thread-list-v2-items.tsx, -row-meta.tsx, -shelf-header.tsx): Priority (n) with ⋯ (Mark all as
read, Clear read threads), Working (n), Settled (n) collapsed; card row px-20 py-10: 15pt project
favicon, 16pt medium title (2 lines), right status label + glyph (Working 3m / Waiting / Approval /
Input / Done, GOAT colours) or time; second line inset 23: branch glyph, folder · via launcher,
PR badge (lucide git-pull-request-*, mono #, GOAT PR accent), machine symbol + name, provider mark
14 at 60% (real Codex / Claude SVG from components/ProviderIcon.tsx). Swipe left = Settle / Snooze;
long press = GOAT row menu (Settle, Snooze, Pin, Arrange, Rename, Mark as unread, Archive,
Delete) plus our "Open beside". Thread screen (ThreadDetail): glass header with title, machine
glyph · folder · machine, lens and ⋯; feed with GOAT context chips (composerChipPresentation
accents: terminal/PR #009f6e, image #d55665, file #0090cd, skill box #b261be, review #8a70dd,
element #b87501) and PendingUserInputCard; ThreadComposer = chips row, +, text, provider mark,
mic, send. The Muse card hides inside bot chat, thread and panes. Opening a second thread with
"Open beside" turns the thread into panes (M1, X1 to X5). Icons are lucide 0.564 (GOAT web) for
SF Symbol equivalents.

Mobile memory (2026-11-28, boards C1 to C3): Library tab has Files | Memory. Memory is the same
file viewer as desktop: open-folder path + Change, folders pushed one level at a time, MEMORY.md /
USER.md / TAXONOMY.md; a file shows rendered Markdown with "4 minutes ago" and a black Edit; edit is
Cancel / Save with a "changed on another machine · Load theirs" notice. No Notes feature, no bot
note list, no Ask to change / forget buttons (bot notes are memory/bots/<botId>/MEMORY.md).

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
