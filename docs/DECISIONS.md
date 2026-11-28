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
- **Bot reply modes (proposal, open).** Two outcomes after the first reply: answer-and-done (the
  first message is the whole answer) and ack-and-report-later (one line naming the first step, work
  continues, the result arrives as a new message). GOAT today splits on "does the turn call a tool"
  (`channelBotSessionBrief.ts:52`, receipt = first assistant message, 20 s / 55 s fallbacks in
  `ChannelSessionFirst.ts`); Grok Bot lets the agent call `SendToUser` when work will take long and
  promotes running tools to the background when a follow-up arrives (`QUEUED_FOLLOW_UP`,
  `WakeParent`). Proposal: read-only lookups that finish within 10 s stay answer-and-done; the ack
  is an explicit `send_to_user(kind: ack | result)` tool; keep GOAT's 20 s / 55 s safety and one
  receipt per input; follow-ups get an immediate reply while running work moves to the background;
  finished background work wakes the bot. Full write-up: PRD page `bot-reply`.
- **No spinner beside a face.** A working bot is shown by its moving face on web, desktop and
  mobile; list/tile/rail faces step about once a second, only the open chat's face animates
  smoothly; spinners stay only where no face is drawn. Evidence: Grok Bot hands-on (codex 049/130
  §5), GOAT `AGENTS.md` no-continuous-repaint rule. MOTION.md rules 8-9.
- **Left rail bots (hard rule).** The leftmost rail shows only the main bot (GOAT) by default.
  Any other bot is added only through the rail's "…" button (placed right above the rail divider)
  and its search popover. Pinning a bot tile or listing it in the sidebar never adds it to the rail.
  This replaces the earlier "collapsed rail shows GOAT then pinned faces".
- **Main bot on the rail.** Clicking it opens the main bot chat and switches the second sidebar to
  the bot sidebar (pinned tiles, Needs you, Bots), from any mode (threads, inbox).
- **Repo and names.** GOAT 2 lives on the `goat2` branch of `goat-si/goat` (no common ancestor with
  `dev`; local only for now). Each feature gets a `goat2_<feature>` branch and a worktree of the same
  name at `~/Developer/goat2_<feature>`, lowercase English snake_case (`goat2/<x>` is impossible
  while a `goat2` branch exists). Package folders stay kebab-case, code and record fields camelCase,
  as in GOAT 1. First worktree: `~/Developer/goat2_thread_store`.
- **Language and runtime.** Part 1 is TypeScript + Node + Effect 4. GOAT 1's bottlenecks were
  structural (full-list reads, whole-message resends, a shared Codex process, no caps), not the
  language. The packaged host runs as Electron 44's Node 24.22 (`ELECTRON_RUN_AS_NODE`, as GOAT 1),
  so host code uses Node 24 APIs only. Rust only for herdr-core and the computer-use helper; a host
  piece moves to Rust only if the stall recorder shows repeated >100 ms stalls from it that
  `worker_threads` does not fix.
- **Part 1 thread structure.** Decided 2026-11-28; see the PRD Part 1 chapter
  (https://goat-si.github.io/goat2-design/prd/part1/): per-thread folder with `goat.jsonl` as the
  only source, card index rebuilt from folders, one Codex process per thread, caps 4 runs / 2 starts
  / 4 children per bot / depth 1, quitting the app ends the work, append-only text streaming.
- **Host is Rust from the start (supersedes the TypeScript + Node entry above).** UI stays
  TypeScript/React. Codex via the official `codex-app-server-protocol` crate, Claude by driving the
  `claude` CLI's stream-json control protocol directly (what the Agent SDK wraps), ACP via Zed's
  `agent-client-protocol` crate, MCP on `rmcp` keeping GOAT 1's agent-surface shape. GOAT v1
  behaviour (thread.send/wait/watch/report_result, queue edit/promote-to-steer, child wakes, follow-up
  modes, restart settlement) is ported with equal behaviour, checked against v1's capability flags
  and recorded-session scenarios. Builds run through GOAT v1 on other hosts, not in Aside.
- **Top bar 40px (supersedes "macOS top bar 52px").** The rail is 44px, so the top bar is 40px on every
  desktop screen. Paper boards updated 2026-11-28 ~21:35 KST and re-exported to `design/paper/part1/`.
- **Thread timeline = GOAT v1's rendering.** Working row ("Working for <timer>"), work-log groups and
  "Worked for {duration}" folds are lifted from v1 `apps/web/src/components/chat/`, not redrawn from Paper.
- **The old prototype UI is obsolete.** The Dev app and the published prototype must show the Paper UI
  (lane F), not the pre-rail prototype.
- **Lift from GOAT v1 first, always from the real code.** Whatever can be carried over from v1 (components,
  types, algorithms, copy, icons, tokens, tests) is carried over; new code only where v1 has nothing usable or a
  GOAT 2 decision differs. Agents must read v1 source (`~/Developer/goat` `origin/dev`), never screenshots or
  memory, and record every lift in `docs/PROVENANCE.md`. Applies to code and to Paper boards.
