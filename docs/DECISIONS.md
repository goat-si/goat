# GOAT 2 decisions

Durable decisions only. The live list with open questions is the PRD:
https://goat-si.github.io/goat2-design/prd/decisions.html (source `goat-si/goat2-design/prd-src/decisions.md`).
Newest at the bottom.

## 2026-11-28

- **Color.** One blue dot (`#0169CC`, GOAT's unread colour) plus black counts on the rail. No red,
  green or orange state colours. Mobile Threads tab follows the same rule: Input and Approval labels
  blue, Working, Done and PR badges grey. Exceptions: bot face colours and GOAT context-chip accents
  (they say what kind of content a chip is, not a state). `--color-decide` / `--color-done` in
  DESIGN.md are retired; app code still to change: `apps/web/src/bot-home/BotHome.tsx` needs dot
  `#E5484D`, `ssotParts.tsx` `#1A9E5C` badges.
- **Execution.** The record is structured events: Codex app-server, Claude Agent SDK, ACP for the
  rest. Bots and threads render the same orchestration v2 view. A terminal is a per-pane lens and a
  hand-off ("open this session in the TUI" = `codex resume` / `claude --resume`), never a second
  driver of the same session. CLIs with no protocol get a basic UX from their session log plus hooks,
  marked "basic".
- **CLI runner.** CLIs must be able to run inside herdr-core (`hc`, Apache-2.0): start
  `<agent> acp` (or app-server) in an hc terminal so a person can attach at any time, while the UI
  draws from events. hc only keeps terminals alive and runs them remotely ("Core draws nothing");
  the conversation ledger stays in GOAT.
- **Toolchain.** Same as GOAT: vite-plus (`vp`) + tsc-rs + oxlint, without GOAT's bottlenecks.
  GOAT today carries 48 `goat/*` JS-plugin lint rules, an 819-file code-budget baseline, 559 lint
  backlog entries and a 950+ line `vite.config.ts`. In goat2: save/commit loop runs native oxlint
  rules only; JS-plugin rules stay few and run on changed files; typecheck is per package with
  cache; baselines start at zero and may only shrink; config is split by concern; `check:changed`
  gets a time budget and CI reports when a change exceeds it (number to be set).
- **macOS top bar.** Keep the code value, 52px (`MACOS_WORKSPACE_TOPBAR_HEIGHT`). It does not look
  tall in the real app; Paper boards are what looked large, so Paper follows a capture of the app.
- **Mobile account button.** Top-left account button stays in the same place on every top-level
  tab (Bots, Threads, Inbox, Library). Inside a pushed screen (bot chat, thread, panes) that spot is
  Back.
- **Archive location (open).** After 90 days a thread folder (compressed) moves off the laptop:
  Cloudflare R2, AWS S3, or a "hub machine" (one of your own machines with a big disk). Proposal:
  hub machine by default, R2 as an opt-in.
