# GOAT 2 PRD (short)

Status: draft, 2026-11-28. Source of truth for the screen: Paper
[GOAT 봇 워크스페이스 · 봇 홈 — SSOT](https://app.paper.design/file/01M8GDWPDQSBBWW8RMTG12PGCC).
Spec text: goat_initiative [PR #10](https://github.com/goat-si/goat_initiative/pull/10)
(`docs/070_goat_bot_gui.md`, "봇 워크스페이스와 실행 런타임").

## Problem

GOAT works but is heavy (measured 2026-11-28 on one Mac: ~20 processes / ~5 GB RSS, a 39.7 GB DB
with ~8M events and no retention). The weight comes from the server, renderer and DB, not from
Electron. It is also thread-first, while the product direction is bot-first.

## Goals

1. **Bots first.** Roster → conversation → folded worker threads → overview. Threads stay
   reachable (folded row "Open thread", overview "Worker threads"), one level down.
2. **Know what ran.** GOAT will support every agent CLI. Each run is stamped once at start with
   driver, instance, CLI version, model + options, machine, account label, runtime mode and
   workspace (`@goat2/runtime-stamp`). The roster shows only the provider chip (no versions);
   the chat runtime bar shows chip + model; the Overview "Runtime" section shows everything.
3. **Light.** No duplicated transcripts: read the CLI's own session log on demand. DB keeps
   pointers, summaries, evidence and stamps. Engine host is a separate process; heavy features
   start on use and stop when idle.
4. **Official CLIs as engines**, T3-style. Keep the ToS-safe posture (no subscription login inside
   a custom engine).

## Design guidelines and motion

- Paper ↔ code: [PAPER.md](PAPER.md) (Paper owns looks, code owns motion and clicks, the published site is linked from a Paper comment, code matches the board 1:1 through a generated parts file).
- Guidelines: [DESIGN.md](DESIGN.md) (principles, tokens, avatar + provider chip anatomy, folding, copy, checklist).
- Bot motion: [MOTION.md](MOTION.md), states idle / ack / think / work / needs_you / done / error mapped to
  ledger states, with timing; live reference [motion/playground.html](motion/playground.html); code `@goat2/bot-face`.
- Method borrowed from the references: guidelines live in the repo as markdown next to code
  (Hermes `DESIGN.md`, OpenBot `app-guidelines.md`), one motion vocabulary file (OpenBot `lib/motion.ts`),
  and later a guard test that fails when a screen breaks the look (OpenBot `ui-look-guard.test.ts`).

## Non-goals (for now)

- Tauri. Electron stays (browser use needs it; computer use lives in a signed helper).
- A custom agent engine (Pi + code-exec fast path is a later experiment, measured first).
- Team/multi-owner permissions and billing; public bot gallery.

## Open

- Storage table for stamps; native session-log readers per driver.
- Whether to adopt goat's vite-plus / tsc-rs toolchain.
- Mobile layout (runtime bar collapses to one line).
