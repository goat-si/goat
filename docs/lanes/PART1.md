# GOAT 2 Part 1 lanes (Rust host)

Design source of truth (read first): https://goat-si.github.io/goat2-design/prd/part1/
(source `goat-si/goat2-design/prd-src/part1/*.md`, local `~/Developer/goat2-design`).
Pages: `index`, `perf` (GOAT v1 bottlenecks), `cases` (ADE survey), `model`, `storage`, `runtime`,
`mcp`, `plan` (decisions, "host is Rust", "GOAT v1 equal-behaviour port", lane table).

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
- Follow-ups: human/worker threads `steer`, bot threads `followup`, `interrupt` only by explicit button;
  a refused steer fails closed. Interrupt is demoted to followup while children run.
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

## Delivery
- Commit to `goat2_<lane>`, push to origin, open a PR **into `goat2`** with
  `gh pr create -R goat-si/goat --base goat2`. Do not merge, do not touch `dev`, never force-push
  shared branches. PR body: what was built, how it was verified (commands + results), open questions.
- Author is `JUN <jun@lidgeai.com>`.

## Lanes
| Lane | Branch / folder | Crates | Done when |
|---|---|---|---|
| C contracts | `goat2_contracts` | `goat2-contracts` | ThreadCard, the 12 log events, TurnItem subset (from v1 `orchestrationV2.ts`), capability flags (from v1 `providerCapabilityParts.ts`), subscribe frames; `ts-rs` TS output + JSON Schema generated into `packages/contracts-rs/`; round-trip tests. **Ship a first cut early** (types only) so A/B can depend on it. |
| A thread_store | `goat2_thread_store` | `goat2-thread-store` | Append, card fold with `appliedSeq`, atomic card.json, cards.sqlite rebuild from folders, `read(after)` / `readPage(before, limit)` / reset reasons, blobs >64 KB, startup with 1,000 threads measured and reported. |
| B engine_codex | `goat2_engine_codex` | `goat2-engine-codex` | Driver on `codex-app-server-protocol`: thread start/resume, turn start/steer/interrupt, item/completed -> log events, approvals, GOAT MCP injection, process group + nice; fake codex replaying recorded sessions; capability flags equal to v1 `CodexCapabilities.ts`. |
| D parity | `goat2_parity` | `goat2-parity`, `docs/parity/` | Written v1 behaviour spec (follow-up modes, steer refusal, child wake, restart settlement, thread.send/wait/watch/report_result, queue edit/promote) with v1 file:line refs; recorded Codex scenarios runnable against v1 and later GOAT 2; Claude stream-json control protocol notes (Agent SDK subtypes) for Part 2. |
