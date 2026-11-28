# GOAT 2 Part 1 lanes (Rust host)

Design source of truth (read first): https://goat-si.github.io/goat2-design/prd/part1/
(source `goat-si/goat2-design/prd-src/part1/*.md`, local `~/Developer/goat2-design`).
Pages: `index`, `perf` (GOAT v1 bottlenecks), `cases` (ADE survey), `model`, `storage`, `runtime`,
`mcp`, `plan` (decisions, "host is Rust", "GOAT v1 equal-behaviour port", lane table).

## structure/ (code-structure SSOT)
- `structure/` on `goat2` is the single source of truth for where code lives and how parts talk
  (map, processes, data, wire, deps, lanes, gaps). Read it before adding a crate, module, frame or dependency.
- Code must match it. Do not edit it yourself: propose changes with
  `aside session queue <owner> "[goat2_<lane> thread <id>] structure: <file> - <what/why>"`; the owner updates it.

## PRD repo
- PRD source: `goat-si/goat2-design` (local `~/Developer/goat2-design`, pages in `prd-src/`, Part 1 in
  `prd-src/part1/*.md`, decisions in `prd-src/decisions.md`, roadmap in `prd-src/roadmap.md`).
- When your work shows the PRD is wrong, missing or out of date, **ask the design owner first**
  (`aside session queue abQKPhrntOQV9jG1 "[goat2_<lane> thread <id>] PRD update: <page> - <what and why>"`).
  Only after an OK: edit just those lines, `npm run build` must pass, commit only your files
  (`git add <files>`, never `npm run ship` / `git add -A`, other agents edit the same repo),
  `git pull --rebase origin main`, `git push origin HEAD:main`, then send the commit hash back.

## Fixed decisions (do not reopen; ask if you think one is wrong)
- Host is Rust, UI stays TypeScript/React. Data dir `~/.goat2`.
- Per-thread folder `threads/<id>/{goat.jsonl, card.json, blobs/}`; `goat.jsonl` is the only source,
  card index (`cards.sqlite`) is a rebuildable cache. No "read every thread body" API. No migrations
  of the log (per-line `v`). Cursor `(epoch, seq)`. Append-only text streaming `{itemId, offset, text}`.
- Copy user messages and final assistant text; tools as name/summary/engine locator only; no deltas stored.
- Follow-ups: human/worker threads `steer`, bot threads `followup`, `interrupt` only by explicit button.
  As in v1: a steer refused at admission (or a start onto a native turn GOAT never owned,
  `CodexTurnStartGuard.ts:113-172`) fails closed; a steer the engine declines after admission becomes a
  queued followup with the same message id, child-result wakes too (`EffectWorker.ts:310-360`). No
  interrupt demotion: Stop holds the queue, stops wait-mode children, async children keep running and
  report later as inputs (`ChildNeedsStop.ts:5-50`). Owner decision 2026-11-28, see docs/parity/.
- Caps: 4 concurrent runs, 2 concurrent starts, 4 children per bot, depth 1.
- One Codex app-server process per thread; idle 10 min -> stop. Agent commands under `nice -n 10`.
- Quitting the app ends the work; on next start running runs become `interrupted` / `unknown`
  (`unknown` is never auto-resent). Cloud execution is a separate later design.
- GOAT v1 (`goat-si/goat` dev, `~/Developer/goat`) is the behaviour reference. Port with **equal
  behaviour**: v1 capability flags (`packages/contracts/src/providerCapabilityParts.ts`) and
  thread/queue/child semantics (`thread.send/wait/watch/report_result`, `queue.*`, child wakes).
  Lift once, do not chase v1 or upstream.

## Workspace
- Rust workspace at repo root `Cargo.toml`; crates under `crates/goat2-*`. Only touch your lane's
  crate(s) plus files the lane table lists. Shared types go through `goat2-contracts` (lane C).
- Branch and worktree: `goat2_<lane>` at `~/Developer/goat2_<lane>`, based on `goat2`.
- One shared Rust build cache: **kache** (global `rustc-wrapper = "kache"` in `~/.cargo/config.toml`). Never override
  `RUSTC_WRAPPER`, never re-enable `CARGO_INCREMENTAL`. Other hosts: `cargo install kache --locked && kache init &&
  kache doctor --probe` before building. Report `kache stats` hit rate in PRs.
- Toolchain 1.95 (`rust-toolchain.toml`). `cargo fmt`, `cargo clippy -- -D warnings`, `cargo test -p <crate>`.

## How to work
- Run under the **cxc-loop** skill (`$cxc-loop`), required: `cxc loop init --objective ... --session <threadId>
  --criterion ...` (criteria = your lane's done criteria), phases via `cxc orchestrate <phase>` (PABCD gates),
  tasks via `cxc loop add-work-phase` / `add-task` / `complete-task`, `meet-criterion` with evidence,
  owner questions via `cxc loop ask` plus `aside session queue`.
- Use subagents on `gpt-6.1-terra` (Codex instance) freely for parallel implementation, tests and
  review. Heavy builds/tests may go to other GOAT hosts with `goat_task_create`
  (`target.host`: `linux` 32 cores, `mac-studio`, `lidge`, `desktop-c795oh4` for Windows), which
  clone/fetch `goat-si/goat` branch `goat2_<lane>` themselves.
- Research with Aside before design decisions: `zsh -l -c 'aside exec --json "<question>"'`
  (web + browser). Cite the URLs you used in the PR body.
- Ask the design owner (Aside session `abQKPhrntOQV9jG1`) when a decision is unclear or you want to
  change a fixed decision:
  `zsh -l -c 'aside session queue abQKPhrntOQV9jG1 "[goat2_<lane> thread <threadId>] <question>"'`
  Include your GOAT threadId; the answer comes back as a message in your GOAT thread. Keep working on
  other parts while waiting.

## Delivery (owner rule 2026-11-28: merge locally now, remote CI later)
- Commit on `goat2_<lane>` and push it. When a piece is green locally (`cargo fmt --check`,
  `cargo clippy --workspace -- -D warnings`, `cargo test --workspace`), merge it into `goat2` **locally**:
  ```sh
  until mkdir /tmp/goat2-merge.lock 2>/dev/null; do sleep 5; done   # one merger at a time
  trap 'rmdir /tmp/goat2-merge.lock' EXIT
  cd ~/Developer/goat2 && git pull --rebase origin goat2 || true
  git merge --no-ff goat2_<lane> -m "merge goat2_<lane>: <what>"
  cargo test --workspace            # must stay green after the merge
  git push --force-with-lease origin goat2
  ```
  Then rebase your lane branch on the new `goat2` and keep going. Remote CI and PRs come later; a PR is
  optional. Never touch `dev`. Author `JUN <jun@lidgeai.com>`.

## Lanes
| Lane | Branch / folder | Crates | Done when |
|---|---|---|---|
| C contracts | `goat2_contracts` | `goat2-contracts` | ThreadCard, the 12 log events, TurnItem subset (from v1 `orchestrationV2.ts`), capability flags (from v1 `providerCapabilityParts.ts`), subscribe frames; `ts-rs` TS output + JSON Schema generated into `packages/contracts-rs/`; round-trip tests. **Ship a first cut early** (types only) so A/B can depend on it. |
| A thread_store | `goat2_thread_store` | `goat2-thread-store` | Append, card fold with `appliedSeq`, atomic card.json, cards.sqlite rebuild from folders, `read(after)` / `readPage(before, limit)` / reset reasons, blobs >64 KB, startup with 1,000 threads measured and reported. |
| B engine_codex | `goat2_engine_codex` | `goat2-engine-codex` | Driver on `codex-app-server-protocol`: thread start/resume, turn start/steer/interrupt, item/completed -> log events, approvals, GOAT MCP injection, process group + nice; fake codex replaying recorded sessions; capability flags equal to v1 `CodexCapabilities.ts`. |
| D parity | `goat2_parity` | `goat2-parity`, `docs/parity/` | Written v1 behaviour spec (follow-up modes, steer refusal, child wake, restart settlement, thread.send/wait/watch/report_result, queue edit/promote) with v1 file:line refs; recorded Codex scenarios runnable against v1 and later GOAT 2; Claude stream-json control protocol notes (Agent SDK subtypes) for Part 2. |
| E host | `goat2_host` | `goat2-host` (+ MCP module) | One process tying it together: thread store + Codex driver + per-thread mailbox/lane + caps (4 runs / 2 starts / 4 children / depth 1) + follow-up modes + child wake + restart settlement + MCP (`rmcp`, v1 agent-surface shape, 10 paths in PRD `mcp.md`) + WebSocket API for the UI (`subscribeCards`, `subscribeThread`, commands) on 127.0.0.1 with a token. Stall recorder from day one. |
| F ui | `goat2_ui` | `apps/web`, `packages/*` (TS) | The Paper look, 1:1 from `design/paper/part1/` (boards listed in its README), wired to the host WebSocket API through TS types generated by goat2-contracts. Bot home (rail with main bot + "…", pinned tiles, bot chat, right panel with worker threads), thread view, send-first cold start. Side-by-side screenshot vs the board's `.jpg` at the board size for every screen. |
| G desktop | `goat2_desktop` | `apps/desktop`, `scripts/` | Electron shell that spawns and supervises `goat2-host`, loads the UI, and packages **GOAT 2 (Dev)**: `/Applications/GOAT 2 (Dev).app`, bundle id `si.goat.goat2.dev`, data dir `~/.goat2-dev`, ad-hoc signed is fine. `scripts/build-dev-app.sh` rebuilds and reinstalls from current `goat2`; run it after every merge into `goat2` so the owner can keep using the latest build. |

## Paper is part of Part 1
Part 1 ships the Paper look, not a throwaway test screen. Boards and exports: `design/paper/part1/`.
Code follows the boards 1:1 (`docs/PAPER.md`); interactive pieces copy values from the exports only.
Lanes do not edit Paper: if a board is missing a state you need, ask the owner (`aside session queue`).

## GOAT 2 (Dev) build
- Built and installed by lane G's `scripts/build-dev-app.sh`, run in a GOAT thread (never in Aside bash).
- Separate from GOAT v1 Nightly: own app name, bundle id, data dir `~/.goat2-dev`, host port.
- After each merge into `goat2` that touches host/ui/desktop, the merging lane runs the script (or asks
  lane G) and reports the installed version (`goat2` commit hash shown in the app's About/title).

